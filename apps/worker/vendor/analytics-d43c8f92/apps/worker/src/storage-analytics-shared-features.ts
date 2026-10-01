import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { SHARED_ANALYTICS_FEATURE_MAX_BYTES, SHARED_ANALYTICS_FEATURE_METHOD,
  SharedFeatureRefused, appendSharedAnalyticsFeaturePage, createSharedAnalyticsFeaturePending,
  finishSharedAnalyticsFeatureDay, validSharedAnalyticsFeatureDay, validSharedAnalyticsFeaturePending,
  type SharedAnalyticsFeatureDay, type SharedAnalyticsFeaturePending } from './analytics-shared-features';
import { assertEffectiveHistoryOwner, createEffectiveHistoryDayDependencyReader,
  effectiveHistoryDependency } from './storage-effective-history';
import type { StorageCommunityOwner } from './storage-community-authority';
import { readEffectiveTelemetryOwnerDayPage,
  type EffectiveTelemetryStream } from './telemetry-usage-effective-reader';
import { withStoragePublicationTiming, type StoragePublicationTimingObserver,
  type StoragePublicationTimingPhase } from './storage-analytics-failure';

export type { SharedAnalyticsFeatureDay } from './analytics-shared-features';
export interface SharedAnalyticsFeatureBudget {
  remainingQueries(): number;
  deadlineMs: number;
  now(): number;
  /** Internal, optional publication diagnostics; never part of source policy. */
  statementCount?:()=>number;
  observePhase?:StoragePublicationTimingObserver;
}
export interface SharedAnalyticsFeatureInput {
  source: D1Database; target: D1Database; sourceId: string; sourceNamespace: string;
  owner: StorageCommunityOwner & { ownerDigest: string }; day: string;
  budget: SharedAnalyticsFeatureBudget;
}
export type SharedAnalyticsFeatureResult =
  | { state: 'complete'; value: SharedAnalyticsFeatureDay; dependencyDigest: string; reused: boolean }
  | { state: 'deferred'; reason: string }
  | { state: 'refused'; reason: string };
export type SharedAnalyticsFeatureReadResult = SharedAnalyticsFeatureResult | { state: 'absent' };
export type SharedAnalyticsFeatureWindowResult =
  | { state: 'complete'; values: readonly SharedAnalyticsFeatureDay[];
    dependencyDigests: readonly string[] }
  | { state: 'missing'; day: string }
  | { state: 'deferred'; reason: string }
  | { state: 'refused'; reason: string };

const STREAMS: readonly EffectiveTelemetryStream[] = ['usage','quota','session'];
const MAX_WINDOW_DAYS = 101, MAX_WINDOW_BYTES = 8 * 1024 * 1024;
const MAX_HEADS_PER_DAY = 4, PART_BYTES = 128 * 1024, MAX_PARTS = 33;
const HASH = /^[a-f0-9]{64}$/u;
const sourceIdPattern = /^[A-Za-z0-9._:-]{1,128}$/u;
const encoder = new TextEncoder();
const byteSize = (text: string) => encoder.encode(text).byteLength;
const fail = () => new Error('SHARED_ANALYTICS_FEATURE_UNAVAILABLE');
const dayValid = (day: string) => /^\d{4}-\d{2}-\d{2}$/u.test(day)
  && Number.isFinite(Date.parse(`${day}T00:00:00.000Z`))
  && new Date(`${day}T00:00:00.000Z`).toISOString().slice(0,10) === day;
function checkInput(input: SharedAnalyticsFeatureInput): void {
  if (!input || input.source === input.target || !sourceIdPattern.test(input.sourceId)
    || typeof input.sourceNamespace !== 'string' || input.sourceNamespace.length < 1
    || input.sourceNamespace.length > 256 || !HASH.test(input.owner.ownerDigest)
    || !dayValid(input.day) || !input.budget || typeof input.budget.now !== 'function'
    || typeof input.budget.remainingQueries !== 'function'
    || !Number.isFinite(input.budget.deadlineMs)
    || !Number.isFinite(input.budget.now())
    || !Number.isSafeInteger(input.budget.remainingQueries())) throw fail();
}
function available(budget: SharedAnalyticsFeatureBudget, reserve: number): boolean {
  return budget.now() < budget.deadlineMs - 1_500 && budget.remainingQueries() >= reserve;
}
function timed<T>(input:SharedAnalyticsFeatureInput,phase:StoragePublicationTimingPhase,
 work:()=>Promise<T>):Promise<T>{
 let observer:SharedAnalyticsFeatureBudget['observePhase'];
 let statementsUsed:SharedAnalyticsFeatureBudget['statementCount'];
 try{observer=input.budget.observePhase;statementsUsed=input.budget.statementCount;}
 catch{/* an optional diagnostic getter cannot stop source work */}
 return withStoragePublicationTiming(phase,observer,statementsUsed,work);
}
async function supported(target: D1Database): Promise<boolean> {
  try {
    const result = await target.prepare(`SELECT count(*) n FROM sqlite_schema
      WHERE (type='table' AND name IN ('analytics_shared_feature_days','analytics_shared_feature_parts'))
        OR (type='trigger' AND name='analytics_shared_feature_contract_v1')`).first<number>('n');
    return result === 3 && await target.prepare(`SELECT count(*) n FROM sqlite_schema
      WHERE type='table' AND name='analytics_shared_feature_sweep_cursor'`).first<number>('n') === 1;
  } catch { return false; }
}
async function sourceCurrent(input: SharedAnalyticsFeatureInput): Promise<boolean> {
  await assertEffectiveHistoryOwner(input.source, input.owner);
  const row = await input.source.prepare(`SELECT v.revision AS input_revision,o.revision AS owner_revision,
      o.authority_epoch AS authority_epoch
    FROM participants p JOIN storage_v11_owner_links l ON l.participant_id=p.id AND l.state='active'
    JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest AND o.state='active'
    JOIN community_analytical_input_versions v ON v.participant_id=p.id
    WHERE p.id=? AND p.state='active' AND l.owner_digest=?`)
    .bind(input.owner.participantId,input.owner.ownerDigest)
    .first<{input_revision:number;owner_revision:number;authority_epoch:number}>();
  return row?.input_revision === input.owner.inputRevision
    && row.owner_revision === input.owner.ownerRevision
    && row.authority_epoch === input.owner.authorityEpoch;
}
async function targetCurrent(input: SharedAnalyticsFeatureInput): Promise<boolean> {
  const row = await input.target.prepare(`SELECT 1 ready FROM analytics_owner_state o
    JOIN analytics_runtime_sources r ON r.source_id=o.source_id
    WHERE o.source_id=? AND o.owner_digest=? AND o.state='active'
      AND o.revision=? AND o.authority_epoch=?
      AND r.source_namespace=? AND r.contract_version=1
      AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
        WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest)`)
    .bind(input.sourceId,input.owner.ownerDigest,input.owner.ownerRevision,
      input.owner.authorityEpoch,input.sourceNamespace).first<number>('ready');
  return row === 1;
}
async function dependencyDigest(input: SharedAnalyticsFeatureInput): Promise<string> {
  return timed(input,'feature_dependency',async()=>sha256Hex(canonicalJson(await effectiveHistoryDependency(
    input.source,input.owner,input.sourceNamespace,input.day,input.day,{includeSessions:true}))));
}
async function methodDigest(): Promise<string> {
  return sha256Hex(canonicalJson(SHARED_ANALYTICS_FEATURE_METHOD));
}
async function jobKey(input: SharedAnalyticsFeatureInput, method: string, dependency: string): Promise<string> {
  return sha256Hex(canonicalJson([input.sourceId,input.sourceNamespace,input.owner.ownerDigest,
    input.day,method,dependency]));
}
interface Job {
  job_key:string;source_id:string;source_namespace:string;owner_digest:string;day:string;
  method_digest:string;dependency_digest:string;owner_revision:number;authority_epoch:number;
  input_revision:number;head_revision:number;state:'building'|'complete'|'refused';
  payload_digest:string|null;payload_bytes:number;part_count:number;
  claim_token:string|null;claim_expires_ms:number|null;updated_ms:number;
}
interface Part {revision:number;part_index:number;payload:string;payload_bytes:number;payload_digest:string}
type Frame = {kind:'pending';value:SharedAnalyticsFeaturePending}
  | {kind:'complete';value:SharedAnalyticsFeatureDay}
  | {kind:'refused';reason:string};
function frameScopeCurrent(input:SharedAnalyticsFeatureInput,frame:Frame):boolean {
  return frame.kind==='refused' || frame.value.day===input.day
    && frame.value.ownerDigest===input.owner.ownerDigest;
}
function validFrame(value: unknown): value is Frame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const frame = value as Record<string,unknown>;
  if (frame.kind === 'pending') return Object.keys(frame).sort().join(',') === 'kind,value'
    && validSharedAnalyticsFeaturePending(frame.value);
  if (frame.kind === 'complete') return Object.keys(frame).sort().join(',') === 'kind,value'
    && validSharedAnalyticsFeatureDay(frame.value);
  return frame.kind === 'refused' && Object.keys(frame).sort().join(',') === 'kind,reason'
    && typeof frame.reason === 'string' && /^[a-z_]{1,64}$/u.test(frame.reason);
}
async function loadFrame(job: Job, parts: readonly Part[]): Promise<Frame> {
  if (job.head_revision < 1 || !HASH.test(job.payload_digest ?? '')
    || job.part_count < 1 || job.part_count > MAX_PARTS || parts.length !== job.part_count
    || job.payload_bytes < 1 || job.payload_bytes > SHARED_ANALYTICS_FEATURE_MAX_BYTES) throw fail();
  let joined = '', total = 0;
  for (const [index, part] of parts.entries()) {
    if (part.revision !== job.head_revision || part.part_index !== index
      || part.payload_bytes !== byteSize(part.payload)
      || part.payload_bytes < 1 || part.payload_bytes > PART_BYTES
      || await sha256Hex(part.payload) !== part.payload_digest) throw fail();
    joined += part.payload; total += part.payload_bytes;
  }
  if (total !== job.payload_bytes || await sha256Hex(joined) !== job.payload_digest) throw fail();
  let decoded: unknown;
  try { decoded = JSON.parse(joined); } catch { throw fail(); }
  if (!validFrame(decoded)
    || decoded.kind !== job.state && !(decoded.kind === 'pending' && job.state === 'building')) throw fail();
  return decoded;
}
async function loadOne(target: D1Database, job: Job): Promise<Frame> {
  const parts = (await target.prepare(`SELECT revision,part_index,payload,payload_bytes,payload_digest
    FROM analytics_shared_feature_parts WHERE job_key=? AND revision=?
    ORDER BY part_index LIMIT ?`)
    .bind(job.job_key,job.head_revision,MAX_PARTS+1).all<Part>()).results;
  return loadFrame(job,parts);
}
function splitPayload(payload: string): string[] {
  const chunks: string[] = [];
  let current = '', length = 0;
  for (const codePoint of payload) {
    const size = byteSize(codePoint);
    if (length + size > PART_BYTES) {chunks.push(current);current = '';length = 0;}
    current += codePoint;length += size;
  }
  if (current.length) chunks.push(current);
  if (chunks.length < 1 || chunks.length > MAX_PARTS
    || chunks.some(chunk => byteSize(chunk) < 1 || byteSize(chunk) > PART_BYTES)) throw new SharedFeatureRefused('day_feature_limit');
  return chunks;
}
async function saveFrame(input: SharedAnalyticsFeatureInput, job: Job, claimToken: string,
  frame: Frame): Promise<boolean> {
  if (!validFrame(frame)) throw fail();
  const payload = canonicalJson(frame);
  if (byteSize(payload) > SHARED_ANALYTICS_FEATURE_MAX_BYTES) throw new SharedFeatureRefused('day_feature_limit');
  const parts = splitPayload(payload);
  const payloadDigest = await sha256Hex(payload);
  const partDigests = await Promise.all(parts.map(part=>sha256Hex(part)));
  if (!available(input.budget, parts.length + 60) || !await sourceCurrent(input)
    || await dependencyDigest(input) !== job.dependency_digest
    || !await targetCurrent(input)) return false;
  // Source validation can be slow. Bind the promotion to the current clock,
  // not the clock from before the final dependency proof.
  const now = Math.trunc(input.budget.now());
  if (!available(input.budget, parts.length + 2)
    || job.claim_expires_ms === null || job.claim_expires_ms <= now + 1_500) return false;
  const statements: D1PreparedStatement[] = [];
  for (const [index, part] of parts.entries()) statements.push(input.target.prepare(
    `INSERT INTO analytics_shared_feature_parts
      (job_key,source_id,owner_digest,revision,part_index,payload,payload_bytes,payload_digest,claim_token,saved_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .bind(job.job_key,input.sourceId,input.owner.ownerDigest,job.head_revision+1,index,
      part,byteSize(part),partDigests[index],claimToken,now));
  statements.push(input.target.prepare(`UPDATE analytics_shared_feature_days SET
    head_revision=?,state=?,payload_digest=?,payload_bytes=?,part_count=?,
    claim_token=NULL,claim_expires_ms=NULL,updated_ms=?
    WHERE job_key=? AND head_revision=? AND claim_token=? AND claim_expires_ms>?
      AND owner_revision=? AND input_revision=?`)
    .bind(job.head_revision+1,frame.kind==='pending'?'building':frame.kind,
      payloadDigest,byteSize(payload),parts.length,now,
      job.job_key,job.head_revision,claimToken,now,
      input.owner.ownerRevision,input.owner.inputRevision));
  let results: D1Result[];
  try { results = await input.target.batch(statements); }
  catch { return false; }
  if (results.at(-1)?.meta.changes !== 1) return false;
  // The promoted generation is never deleted. At most one old generation is
  // normally retained; crash leftovers remain bounded by the job's next pass.
  await input.target.prepare(`DELETE FROM analytics_shared_feature_parts
    WHERE job_key=? AND revision<?`).bind(job.job_key,job.head_revision+1).run();
  return true;
}
async function lookup(input: SharedAnalyticsFeatureInput, key: string): Promise<Job|null> {
  return input.target.prepare(`SELECT * FROM analytics_shared_feature_days WHERE job_key=?`)
    .bind(key).first<Job>();
}
function resultFromFrame(frame: Frame, digest: string): SharedAnalyticsFeatureReadResult {
  if (frame.kind === 'complete') return {state:'complete',value:frame.value,
    dependencyDigest:digest,reused:true};
  if (frame.kind === 'refused') return {state:'refused',reason:frame.reason};
  return {state:'absent'};
}
type FeatureDaySnapshot = Exclude<SharedAnalyticsFeatureReadResult,{state:'absent'}>
  | {state:'absent';method:string;digest:string;key:string;dependencyElapsedMs:number};

/** Keep the initial dependency proof private so an advancing cache miss can
 * reuse it. Completed reads and every save still require a fresh final proof. */
async function readFeatureDaySnapshot(input: SharedAnalyticsFeatureInput):
Promise<FeatureDaySnapshot> {
  checkInput(input);
  if (!available(input.budget, 60)) return {state:'deferred',reason:'query_budget'};
  if (!await supported(input.target)) return {state:'refused',reason:'migration_required'};
  if (!await sourceCurrent(input) || !await targetCurrent(input))
    return {state:'deferred',reason:'source_changed'};
  const dependencyStarted = input.budget.now();
  const digest = await dependencyDigest(input);
  const dependencyElapsedMs = Math.max(0,input.budget.now()-dependencyStarted);
  const method = await methodDigest(), key = await jobKey(input,method,digest);
  const job = await lookup(input,key);
  if (!job || job.state === 'building')
    return {state:'absent',method,digest,key,dependencyElapsedMs};
  let frame:Frame;
  try { frame = await loadOne(input.target,job); }
  catch (error) {
    const current=await lookup(input,key);
    if (!current || current.head_revision!==job.head_revision)
      return {state:'deferred',reason:'source_changed'};
    throw error;
  }
  if (!frameScopeCurrent(input,frame)) throw fail();
  const pinned=await lookup(input,key);
  if (!pinned || pinned.head_revision!==job.head_revision
    || pinned.payload_digest!==job.payload_digest)
    return {state:'deferred',reason:'source_changed'};
  if (!await sourceCurrent(input) || await dependencyDigest(input) !== digest
    || !await targetCurrent(input)) return {state:'deferred',reason:'source_changed'};
  const result = resultFromFrame(frame,digest);
  if (result.state === 'absent') throw fail();
  return result;
}
/** Read only. An unchanged historical day may reuse a lower owner input
 * revision, but exact source metadata and target erasure/epoch are re-proved. */
export async function readSharedAnalyticsFeatureDay(input: SharedAnalyticsFeatureInput):
Promise<SharedAnalyticsFeatureReadResult> {
  const snapshot = await readFeatureDaySnapshot(input);
  return snapshot.state === 'absent' ? {state:'absent'} : snapshot;
}
export type SharedAnalyticsFeatureRetirementResult =
  | {state:'complete';scanned:number;headsRemoved:number;partsRemoved:number}
  | {state:'deferred'|'refused';reason:string};

/** Retire at most four obsolete owner/day heads after a fresh exact source
 * proof. The head matching this day's current method and dependency remains. */
export async function retireSharedAnalyticsFeatureDay(input: SharedAnalyticsFeatureInput):
Promise<SharedAnalyticsFeatureRetirementResult> {
  checkInput(input);
  if (!available(input.budget,80)) return {state:'deferred',reason:'query_budget'};
  if (!await supported(input.target)) return {state:'refused',reason:'migration_required'};
  if (!await sourceCurrent(input) || !await targetCurrent(input))
    return {state:'deferred',reason:'source_changed'};
  const method = await methodDigest(), digest = await dependencyDigest(input);
  return retireFeatureDaySnapshot(input,method,digest);
}
async function retireFeatureDaySnapshot(input:SharedAnalyticsFeatureInput,method:string,digest:string):
Promise<SharedAnalyticsFeatureRetirementResult> {
  if (!available(input.budget,60)) return {state:'deferred',reason:'query_budget'};
  if (!await sourceCurrent(input) || !await targetCurrent(input))
    return {state:'deferred',reason:'source_changed'};
  const now = Math.trunc(input.budget.now());
  const obsolete = (await input.target.prepare(`SELECT job_key FROM analytics_shared_feature_days
    WHERE source_id=? AND owner_digest=? AND day=?
      AND (method_digest<>? OR dependency_digest<>?)
      AND (claim_token IS NULL OR claim_expires_ms<=?)
    ORDER BY updated_ms,job_key LIMIT 4`)
    .bind(input.sourceId,input.owner.ownerDigest,input.day,method,digest,now)
    .all<{job_key:string}>()).results;
  if (!obsolete.length) return {state:'complete',scanned:0,headsRemoved:0,partsRemoved:0};
  if (!await sourceCurrent(input) || await dependencyDigest(input) !== digest
    || !await targetCurrent(input)) return {state:'deferred',reason:'source_changed'};
  let headsRemoved=0, partsRemoved=0;
  for (const row of obsolete) {
    if (!available(input.budget,12)) return {state:'deferred',reason:'query_budget'};
    const count = await input.target.prepare(`SELECT count(*) n FROM analytics_shared_feature_parts
      WHERE job_key=?`).bind(row.job_key).first<number>('n');
    const deleted = await input.target.prepare(`DELETE FROM analytics_shared_feature_days
      WHERE job_key=? AND source_id=? AND owner_digest=? AND day=?
        AND (method_digest<>? OR dependency_digest<>?)
        AND (claim_token IS NULL OR claim_expires_ms<=?)`)
      .bind(row.job_key,input.sourceId,input.owner.ownerDigest,input.day,method,digest,now).run();
    if (deleted.meta.changes===1) {headsRemoved++;partsRemoved+=count??0;}
  }
  return {state:'complete',scanned:obsolete.length,headsRemoved,partsRemoved};
}

/** One source-indexed, four-head capacity cleanup page. This uses no owner
 * data or source read and never touches current-method complete heads or a
 * live claim. A cursor advances past protected heads to avoid starvation. */
export async function retireSharedAnalyticsFeaturePage(input:{target:D1Database;sourceId:string;
  budget:SharedAnalyticsFeatureBudget}):Promise<SharedAnalyticsFeatureRetirementResult> {
  if (!sourceIdPattern.test(input.sourceId) || !input.budget
    || !Number.isSafeInteger(input.budget.remainingQueries())
    || !Number.isFinite(input.budget.deadlineMs)) throw fail();
  if (!available(input.budget,40)) return {state:'deferred',reason:'query_budget'};
  if (!await supported(input.target)) return {state:'refused',reason:'migration_required'};
  const live = await input.target.prepare(`SELECT 1 ready FROM analytics_runtime_sources
    WHERE source_id=? AND contract_version=1`).bind(input.sourceId).first<number>('ready');
  if (live!==1) return {state:'deferred',reason:'source_changed'};
  await input.target.prepare(`INSERT INTO analytics_shared_feature_sweep_cursor(source_id)
    VALUES(?) ON CONFLICT(source_id) DO NOTHING`).bind(input.sourceId).run();
  const cursor = await input.target.prepare(`SELECT after_rowid,revision FROM analytics_shared_feature_sweep_cursor
    WHERE source_id=?`).bind(input.sourceId)
    .first<{after_rowid:number;revision:number}>();
  if (!cursor) return {state:'deferred',reason:'source_changed'};
  type SweepHead = Pick<Job,'job_key'|'state'|'method_digest'|'claim_token'|'claim_expires_ms'
    |'head_revision'|'updated_ms'> & {scan_rowid:number};
  const page = async(after:number) => (await input.target.prepare(`SELECT rowid AS scan_rowid,
      job_key,state,method_digest,claim_token,claim_expires_ms,head_revision,updated_ms
    FROM analytics_shared_feature_days WHERE source_id=? AND rowid>?
    ORDER BY rowid LIMIT 4`).bind(input.sourceId,after).all<SweepHead>()).results;
  let heads = await page(cursor.after_rowid);
  if (!heads.length && cursor.after_rowid>0) heads = await page(0);
  const next = heads.at(-1)?.scan_rowid ?? 0;
  await input.target.prepare(`UPDATE analytics_shared_feature_sweep_cursor
    SET after_rowid=?,revision=revision+1 WHERE source_id=? AND revision=?`)
    .bind(next,input.sourceId,cursor.revision).run();
  const method = await methodDigest(), now = Math.trunc(input.budget.now());
  let headsRemoved=0, partsRemoved=0;
  for (const head of heads) {
    if (!available(input.budget,12)) return {state:'deferred',reason:'query_budget'};
    const staleMethod=head.method_digest!==method;
    const abandoned=head.state==='building' && head.updated_ms<now-86_400_000;
    const liveClaim=head.claim_token!==null && head.claim_expires_ms!==null
      && head.claim_expires_ms>now;
    if ((staleMethod||abandoned) && !liveClaim) {
      const count = await input.target.prepare(`SELECT count(*) n FROM analytics_shared_feature_parts
        WHERE job_key=?`).bind(head.job_key).first<number>('n');
      const removed = await input.target.prepare(`DELETE FROM analytics_shared_feature_days
        WHERE job_key=? AND source_id=? AND (method_digest<>? OR state='building'
          AND updated_ms<?) AND (claim_token IS NULL OR claim_expires_ms<=?)`)
        .bind(head.job_key,input.sourceId,method,now-86_400_000,now).run();
      if (removed.meta.changes===1) {headsRemoved++;partsRemoved+=count??0;}
      continue;
    }
    if (!liveClaim && partsRemoved===0) {
      const removed = await input.target.prepare(`DELETE FROM analytics_shared_feature_parts
        WHERE (job_key,revision,part_index) IN (
          SELECT job_key,revision,part_index FROM analytics_shared_feature_parts
          WHERE job_key=? AND revision<>? ORDER BY revision,part_index LIMIT 33)`)
        .bind(head.job_key,head.head_revision).run();
      partsRemoved += removed.meta.changes??0;
    }
  }
  return {state:'complete',scanned:heads.length,headsRemoved,partsRemoved};
}
/** Advances at most four source pages and commits one source-free generation.
 * The ordinary lanes remain the fallback for explicit day capacity refusal. */
export async function advanceSharedAnalyticsFeatureDay(input: SharedAnalyticsFeatureInput):
Promise<SharedAnalyticsFeatureResult> {
  checkInput(input);
  if (!available(input.budget, 100)) return {state:'deferred',reason:'query_budget'};
  const cached = await readFeatureDaySnapshot(input);
  if (cached.state !== 'absent') return cached;
  const {method,digest,key} = cached;
  if (!await sourceCurrent(input) || !await targetCurrent(input))
    return {state:'deferred',reason:'source_changed'};
  let job = await lookup(input,key);
  if (!job) {
    const retirement=await retireFeatureDaySnapshot(input,method,digest);
    if (retirement.state!=='complete') return retirement;
    try { await input.target.prepare(`INSERT INTO analytics_shared_feature_days
      (job_key,source_id,source_namespace,owner_digest,day,method_digest,dependency_digest,
        owner_revision,authority_epoch,input_revision,updated_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_key) DO NOTHING`)
      .bind(key,input.sourceId,input.sourceNamespace,input.owner.ownerDigest,input.day,method,digest,
        input.owner.ownerRevision,input.owner.authorityEpoch,input.owner.inputRevision,
        Math.trunc(input.budget.now())).run(); }
    catch { return {state:'deferred',reason:'capacity_or_authority'}; }
    job = await lookup(input,key);
    if (!job) return {state:'deferred',reason:'claim_busy'};
  }
  if (job.state !== 'building') {
    const frame = await loadOne(input.target,job);
    if (!frameScopeCurrent(input,frame)) throw fail();
    if (!await sourceCurrent(input) || await dependencyDigest(input) !== digest
      || !await targetCurrent(input)) return {state:'deferred',reason:'source_changed'};
    return resultFromFrame(frame,digest) as SharedAnalyticsFeatureResult;
  }
  if (!available(input.budget, 80)) return {state:'deferred',reason:'query_budget'};
  const now = Math.trunc(input.budget.now()), claim = crypto.randomUUID();
  const leaseUntil = now + 60_000;
  let claimed: D1Result;
  try { claimed = await input.target.prepare(`UPDATE analytics_shared_feature_days SET
    claim_token=?,claim_expires_ms=?,owner_revision=?,input_revision=?,updated_ms=?
    WHERE job_key=? AND state='building' AND head_revision=?
      AND (claim_token IS NULL OR claim_expires_ms<=?)`)
    .bind(claim,leaseUntil,input.owner.ownerRevision,input.owner.inputRevision,now,
      key,job.head_revision,now).run(); }
  catch { return {state:'deferred',reason:'source_changed'}; }
  if (claimed.meta.changes !== 1) return {state:'deferred',reason:'claim_busy'};
  job = {...job,claim_token:claim,claim_expires_ms:leaseUntil,owner_revision:input.owner.ownerRevision,
    input_revision:input.owner.inputRevision,updated_ms:now};
  // A prior claimant can leave unpromoted parts after losing its lease. They
  // are never visible through the head, but must not block this generation.
  await input.target.prepare(`DELETE FROM analytics_shared_feature_parts
    WHERE job_key=? AND revision=?`).bind(key,job.head_revision+1).run();
  let pending: SharedAnalyticsFeaturePending;
  if (job.head_revision === 0) pending = createSharedAnalyticsFeaturePending(input.day,input.owner.ownerDigest);
  else {
    const frame = await loadOne(input.target,job);
    if (frame.kind !== 'pending') throw fail();
    if (!frameScopeCurrent(input,frame)) throw fail();
    pending = frame.value;
  }
  // Leave enough time for the measured dependency proof and the next page's
  // observed latency. A saved partial generation makes progress on the next run.
  const saveHeadroomMs = cached.dependencyElapsedMs + 1_500;
  const saveDeadlineMs = Math.min(input.budget.deadlineMs,leaseUntil);
  let sourcePageElapsedMs = 0;
  try {
    for (let pageIndex = 0; pageIndex < 4 && pending.streamIndex < STREAMS.length; pageIndex++) {
      if (!available(input.budget, 90)
        || input.budget.now()+saveHeadroomMs+sourcePageElapsedMs >= saveDeadlineMs) break;
      if (!await sourceCurrent(input)) return {state:'deferred',reason:'source_changed'};
      const stream = STREAMS[pending.streamIndex]!;
      const pageStarted = input.budget.now();
      const page = await timed(input,'feature_source_page',()=>readEffectiveTelemetryOwnerDayPage(input.source, {
        sourceNamespace:input.sourceNamespace,ownerDigest:input.owner.ownerDigest,
        ownerRevision:input.owner.ownerRevision,authorityEpoch:input.owner.authorityEpoch,
        day:input.day,stream,limit:200,...(pending.after?{after:pending.after}:{})}));
      sourcePageElapsedMs = Math.max(sourcePageElapsedMs,input.budget.now()-pageStarted);
      pending = await appendSharedAnalyticsFeaturePage(pending,stream,page.rows,page.next);
    }
    const complete = pending.streamIndex === STREAMS.length;
    const frame: Frame = complete ? {kind:'complete',value:await finishSharedAnalyticsFeatureDay(pending)}
      : {kind:'pending',value:pending};
    if (!await timed(input,'feature_save',()=>saveFrame(input,job,claim,frame)))
      return {state:'deferred',reason:'source_changed_or_budget'};
    return complete ? {state:'complete',value:(frame as {kind:'complete';value:SharedAnalyticsFeatureDay}).value,
      dependencyDigest:digest,reused:false} : {state:'deferred',reason:'incomplete'};
  } catch (error) {
    if (error instanceof SharedFeatureRefused) {
      if (!await timed(input,'feature_save',()=>saveFrame(input,job,claim,{kind:'refused',reason:error.reason})))
        return {state:'deferred',reason:'source_changed_or_budget'};
      return {state:'refused',reason:error.reason};
    }
    throw error;
  }
}

/** One batched source-dependency snapshot, target-head probe, and bounded
 * payload read for a full 101-day scalar/model window. A miss names the first
 * day to prepare; consumers never exhaust the pass scanning ready prefixes. */
export async function readSharedAnalyticsFeatureWindow(input: Omit<SharedAnalyticsFeatureInput,'day'> & {
  days: readonly string[];
}): Promise<SharedAnalyticsFeatureWindowResult> {
  if (!Array.isArray(input.days) || input.days.length < 1 || input.days.length > MAX_WINDOW_DAYS
    || input.days.some((day,index) => !dayValid(day) || index>0 && input.days[index-1]!>=day))
    throw fail();
  checkInput({...input,day:input.days[0]!});
  if (!available(input.budget, input.days.length*2+100)) return {state:'deferred',reason:'query_budget'};
  if (!await supported(input.target)) return {state:'refused',reason:'migration_required'};
  const ordinary = {...input,day:input.days[0]!};
  if (!await sourceCurrent(ordinary) || !await targetCurrent(ordinary))
    return {state:'deferred',reason:'source_changed'};
  const reader = await createEffectiveHistoryDayDependencyReader(input.source,input.owner,
    input.sourceNamespace,input.days,{includeSessions:true,occurrenceLinks:'batched',
      canContinue:()=>available(input.budget,20)});
  if (!reader) return {state:'deferred',reason:'deadline_or_capacity'};
  const digests: string[] = [];
  for (const day of input.days) {
    const digest = await reader.readDigest(day);
    if (!digest) return {state:'deferred',reason:'deadline_or_capacity'};
    digests.push(digest);
  }
  if (!await sourceCurrent(ordinary)) return {state:'deferred',reason:'source_changed'};
  const method = await methodDigest();
  const heads = (await input.target.prepare(`SELECT * FROM analytics_shared_feature_days
    WHERE source_id=? AND source_namespace=? AND owner_digest=? AND method_digest=?
      AND day BETWEEN ? AND ? ORDER BY day,updated_ms DESC LIMIT ?`)
    .bind(input.sourceId,input.sourceNamespace,input.owner.ownerDigest,method,
      input.days[0],input.days.at(-1),input.days.length*MAX_HEADS_PER_DAY+1).all<Job>()).results;
  if (heads.length > input.days.length*MAX_HEADS_PER_DAY)
    return {state:'refused',reason:'retained_head_limit'};
  const selected: Job[] = [];
  let bytes = 0;
  for (const [index,day] of input.days.entries()) {
    const head = heads.find(row => row.day===day && row.dependency_digest===digests[index]);
    if (!head || head.state==='building') return {state:'missing',day};
    if (head.state==='refused') return {state:'refused',reason:'prepared_day_refused'};
    bytes += head.payload_bytes;
    if (bytes>MAX_WINDOW_BYTES) return {state:'refused',reason:'window_byte_limit'};
    selected.push(head);
  }
  if (!available(input.budget, 15)) return {state:'deferred',reason:'query_budget'};
  const keys = selected.map(value => value.job_key);
  const parts = (await input.target.prepare(`SELECT p.job_key,p.revision,p.part_index,p.payload,p.payload_bytes,p.payload_digest
    FROM analytics_shared_feature_parts p
    JOIN analytics_shared_feature_days h ON h.job_key=p.job_key AND h.head_revision=p.revision
    WHERE p.job_key IN(SELECT value FROM json_each(?))
    ORDER BY p.job_key,p.part_index LIMIT ?`)
    .bind(JSON.stringify(keys),selected.reduce((count,job)=>count+job.part_count,0)+1)
    .all<Part&{job_key:string}>()).results;
  const byKey = new Map<string,Part[]>();
  for (const part of parts) {
    const values = byKey.get(part.job_key)??[]; values.push(part);byKey.set(part.job_key,values);
  }
  const values:SharedAnalyticsFeatureDay[] = [];
  for (const job of selected) {
    let frame:Frame;
    try {frame = await loadFrame(job,byKey.get(job.job_key)??[]);}
    catch (error) {
      const current=await lookup({...ordinary,day:job.day},job.job_key);
      if (!current || current.head_revision!==job.head_revision)
        return {state:'deferred',reason:'source_changed'};
      throw error;
    }
    if (frame.kind!=='complete' || frame.value.day!==job.day
      || frame.value.ownerDigest!==input.owner.ownerDigest) throw fail();
    values.push(frame.value);
  }
  const pinned = (await input.target.prepare(`SELECT job_key,head_revision,payload_digest
    FROM analytics_shared_feature_days WHERE job_key IN(SELECT value FROM json_each(?))
    LIMIT ?`).bind(JSON.stringify(keys),keys.length+1)
    .all<Pick<Job,'job_key'|'head_revision'|'payload_digest'>>()).results;
  const currentByKey=new Map(pinned.map(row=>[row.job_key,row]));
  if (pinned.length!==selected.length || selected.some(job=>{
    const current=currentByKey.get(job.job_key);
    return !current || current.head_revision!==job.head_revision
      || current.payload_digest!==job.payload_digest;
  })) return {state:'deferred',reason:'source_changed'};
  if (!await sourceCurrent(ordinary) || !await targetCurrent(ordinary))
    return {state:'deferred',reason:'source_changed'};
  // An upload can change day-local links without changing the owner revision
  // observed above. The first digest snapshot is therefore rechecked before
  // callers may use any of the loaded values.
  if (!available(input.budget,input.days.length+30)) return {state:'deferred',reason:'query_budget'};
  const verify = await createEffectiveHistoryDayDependencyReader(input.source,input.owner,
    input.sourceNamespace,input.days,{includeSessions:true,occurrenceLinks:'batched',
      canContinue:()=>available(input.budget,20)});
  if (!verify) return {state:'deferred',reason:'deadline_or_capacity'};
  for (const [index,day] of input.days.entries()) {
    if (await verify.readDigest(day) !== digests[index])
      return {state:'deferred',reason:'source_changed'};
  }
  if (!await sourceCurrent(ordinary) || !await targetCurrent(ordinary))
    return {state:'deferred',reason:'source_changed'};
  return {state:'complete',values,dependencyDigests:digests};
}
