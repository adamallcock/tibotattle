import { D1InvocationBudgetExceededError, reserveD1FinalQuery } from './d1-invocation-budget';
import { effectiveUsageWindowRepresentable } from './effective-usage-day';
import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { SHARED_ANALYTICS_FEATURE_MAX_BYTES, SHARED_ANALYTICS_FEATURE_METHOD,
  SharedFeatureRefused, appendSharedAnalyticsFeaturePage, createSharedAnalyticsFeaturePending,
  finishSharedAnalyticsFeatureDay, validSharedAnalyticsFeatureDay, validSharedAnalyticsFeaturePending,
  type SharedAnalyticsFeatureDay, type SharedAnalyticsFeaturePending } from './analytics-shared-features';
import { assertEffectiveHistoryOwner, createEffectiveHistoryDayDependencyReader,
  effectiveHistoryDependency } from './storage-effective-history';
import type { StorageCommunityOwner } from './storage-community-authority';
import { readEffectiveTelemetryOwnerDays, readEffectiveTelemetryOwnerDayPage,
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
  /** Complete canonical contribution assembly supplied by the composition
   * root. This reuses the existing bounded B02 claim, parts and promotion.
   * Source/target/dependency proofs still run before and after this producer. */
  canonicalPreparation?:(input:{dependencyDigest:string;pending:SharedAnalyticsFeaturePending})=>Promise<
    {state:'complete';value:SharedAnalyticsFeatureDay}|{state:'deferred';reason:string;pending?:SharedAnalyticsFeaturePending}
    |{state:'refused';reason:string}>;
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
/** Only new leases require the forward release contract. Existing completed
 * generations remain readable under the original feature/source proofs. */
async function releaseSupported(target:D1Database):Promise<boolean> {
  return await target.prepare(`SELECT count(*) n FROM sqlite_schema WHERE type='trigger'
    AND tbl_name='analytics_shared_feature_days'
    AND name IN('analytics_shared_feature_day_update','analytics_shared_feature_release_v1')`).first<number>('n')===2;
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
async function methodDigest(canonical=false): Promise<string> {
  return sha256Hex(canonicalJson(canonical
    ?{...SHARED_ANALYTICS_FEATURE_METHOD,producer:'canonical-shared-feature-day-v1'}
    :SHARED_ANALYTICS_FEATURE_METHOD));
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
    || !await targetCurrent(input) || await dependencyDigest(input) !== job.dependency_digest
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
  const method = await methodDigest(input.canonicalPreparation!==undefined), key = await jobKey(input,method,digest);
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
  const method = await methodDigest(input.canonicalPreparation!==undefined), digest = await dependencyDigest(input);
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
  const methods=await Promise.all([methodDigest(),methodDigest(true)]), now = Math.trunc(input.budget.now());
  let headsRemoved=0, partsRemoved=0;
  for (const head of heads) {
    if (!available(input.budget,12)) return {state:'deferred',reason:'query_budget'};
    const staleMethod=!methods.includes(head.method_digest);
    const abandoned=head.state==='building' && head.updated_ms<now-86_400_000;
    const liveClaim=head.claim_token!==null && head.claim_expires_ms!==null
      && head.claim_expires_ms>now;
    if ((staleMethod||abandoned) && !liveClaim) {
      const count = await input.target.prepare(`SELECT count(*) n FROM analytics_shared_feature_parts
        WHERE job_key=?`).bind(head.job_key).first<number>('n');
      const removed = await input.target.prepare(`DELETE FROM analytics_shared_feature_days
        WHERE job_key=? AND source_id=? AND (method_digest NOT IN(SELECT value FROM json_each(?)) OR state='building'
          AND updated_ms<?) AND (claim_token IS NULL OR claim_expires_ms<=?)`)
        .bind(head.job_key,input.sourceId,JSON.stringify(methods),now-86_400_000,now).run();
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
  if(!await releaseSupported(input.target))return {state:'refused',reason:'migration_required'};
  if(!available(input.budget,80))return {state:'deferred',reason:'query_budget'};
  const now = Math.trunc(input.budget.now()), claim = crypto.randomUUID();
  const reserved=reserveD1FinalQuery([input.source,input.target]);
  if(!reserved)return {state:'refused',reason:'meter_required'};
  const leaseUntil = now + 60_000;
  // Arm cleanup before the claim attempt: its write can commit while its
  // response is lost. The intended exact token/head is sufficient for a CAS.
  const claimedHead=job.head_revision;
  try {
    let claimed: D1Result;
    try { claimed = await input.target.prepare(`UPDATE analytics_shared_feature_days SET
      claim_token=?,claim_expires_ms=?,owner_revision=?,input_revision=?,updated_ms=?
      WHERE job_key=? AND state='building' AND head_revision=?
        AND (claim_token IS NULL OR claim_expires_ms<=?)
        AND EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger'
          AND name='analytics_shared_feature_day_update' AND tbl_name='analytics_shared_feature_days')
        AND EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger'
          AND name='analytics_shared_feature_release_v1' AND tbl_name='analytics_shared_feature_days')`)
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
    if(input.canonicalPreparation) {
      const prior:Frame=job.head_revision===0?{kind:'pending',
        value:createSharedAnalyticsFeaturePending(input.day,input.owner.ownerDigest)}:await loadOne(input.target,job);
      if(prior.kind!=='pending'||!frameScopeCurrent(input,prior))throw fail();
      const prepared=await input.canonicalPreparation({dependencyDigest:digest,pending:prior.value});
      if(prepared.state==='deferred') {
        // Promote the producer's bounded source-free checkpoint and release this
        // claim atomically. Fact acquisition and priced contributions are durable
        // independently, so resuming never has to normalize them again.
        const next:Frame={kind:'pending',value:prepared.pending??prior.value};
        if(!validFrame(next)||!frameScopeCurrent(input,next))throw fail();
        if(!await timed(input,'feature_save',()=>saveFrame(input,job!,claim,next)))
          return {state:'deferred',reason:'source_changed_or_budget'};
        return {state:'deferred',reason:prepared.reason};
      }
      if(prepared.state==='complete'&&(!validSharedAnalyticsFeatureDay(prepared.value)
        ||prepared.value.ownerDigest!==input.owner.ownerDigest||prepared.value.day!==input.day))throw fail();
      const frame:Frame=prepared.state==='complete'?{kind:'complete',value:prepared.value}
        :{kind:'refused',reason:prepared.reason};
      if(!await timed(input,'feature_save',()=>saveFrame(input,job!,claim,frame)))
        return {state:'deferred',reason:'source_changed_or_budget'};
      return prepared.state==='complete'?{state:'complete',value:prepared.value,dependencyDigest:digest,reused:false}:prepared;
    }
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
      if (!await timed(input,'feature_save',()=>saveFrame(input,job!,claim,frame)))
        return {state:'deferred',reason:'source_changed_or_budget'};
      return complete ? {state:'complete',value:(frame as {kind:'complete';value:SharedAnalyticsFeatureDay}).value,
        dependencyDigest:digest,reused:false} : {state:'deferred',reason:'incomplete'};
    } catch (error) {
      if (error instanceof SharedFeatureRefused) {
        if (!await timed(input,'feature_save',()=>saveFrame(input,job!,claim,{kind:'refused',reason:error.reason})))
          return {state:'deferred',reason:'source_changed_or_budget'};
        return {state:'refused',reason:error.reason};
      }
      throw error;
    }
  } finally {
    reserved.unreserve();
    try {
      await input.target.prepare(`UPDATE analytics_shared_feature_days SET claim_token=NULL,claim_expires_ms=NULL
        WHERE job_key=? AND source_id=? AND owner_digest=? AND source_namespace=?
          AND state='building' AND head_revision=? AND claim_token=? AND claim_expires_ms=?
          AND owner_revision=? AND authority_epoch=? AND input_revision=?
          AND EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger'
            AND name='analytics_shared_feature_day_update' AND tbl_name='analytics_shared_feature_days')
          AND EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger'
            AND name='analytics_shared_feature_release_v1' AND tbl_name='analytics_shared_feature_days')`)
        .bind(key,input.sourceId,input.owner.ownerDigest,input.sourceNamespace,claimedHead,claim,leaseUntil,
          input.owner.ownerRevision,input.owner.authorityEpoch,input.owner.inputRevision).run();
    } catch { /* Exact native refusal/lost cleanup response recovers by lease expiry. */ }
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
  const readDigests=async(value:NonNullable<typeof reader>):Promise<readonly string[]|undefined>=>{
    if(value.readDigests)return value.readDigests();
    const values:string[]=[];
    for(const day of input.days){const digest=await value.readDigest(day);if(!digest)return;values.push(digest);}
    return values;
  };
  const digests=await readDigests(reader);
  if(!digests||digests.length!==input.days.length)return {state:'deferred',reason:'deadline_or_capacity'};
  if (!await sourceCurrent(ordinary)) return {state:'deferred',reason:'source_changed'};
  const method = await methodDigest(input.canonicalPreparation!==undefined);
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
  // Maintained batch reads acquire fresh full source/target seals on every
  // readDigests call. Reuse only that sealed reader: the native fallback keeps
  // captured day headers and must still construct a fresh verification reader.
  const verify = reader.readDigests ? reader
    : await createEffectiveHistoryDayDependencyReader(input.source,input.owner,
      input.sourceNamespace,input.days,{includeSessions:true,occurrenceLinks:'batched',
        canContinue:()=>available(input.budget,20)});
  if (!verify) return {state:'deferred',reason:'deadline_or_capacity'};
  const verified=await readDigests(verify);
  if(!verified||verified.length!==digests.length||verified.some((digest,index)=>digest!==digests[index]))
    return {state:'deferred',reason:'source_changed'};
  if (!await sourceCurrent(ordinary) || !await targetCurrent(ordinary))
    return {state:'deferred',reason:'source_changed'};
  return {state:'complete',values,dependencyDigests:digests};
}

// Canonical partition contributions compose into the same bounded day feature
// store above; callers need no parallel feature-cache abstraction.
export { materializeCanonicalFeaturePartition, canonicalFeatureContributionsAvailable,
  CANONICAL_FEATURE_CONTRIBUTION_TABLES, CANONICAL_FEATURE_CONTRIBUTION_TRIGGERS,
  type CanonicalFeaturePartitionInput, type CanonicalFeaturePartitionResult,
  type CanonicalFeaturePartitionMetrics } from './storage-canonical-feature-contributions';

/** A graph-only ephemeral projection window. The bulk reader above retains
 * its original full-bundle cap. A plan never exposes partially validated days
 * and closes when any fresh source, head, authority or resource proof fails. */
export interface SharedAnalyticsFeatureWindowPlan {
  readonly days: readonly string[];
  readonly scalarDays: readonly string[];
  readonly dependencyDigests: readonly string[];
  loadQuota(days: readonly string[]): Promise<readonly SharedAnalyticsFeatureDay['quota'][]>;
  loadModelUsage(days: readonly string[]): Promise<readonly SharedAnalyticsFeatureDay['modelUsage'][]>;
  readonly usageReader: import('./quota-analysis-v11').V11PreparedUsageReader;
  seal(): Promise<{state:'current'}|{state:'deferred';reason:string}>;
  close(): void;
  logicalBytes(): {compactBytes:number;fullDayBytes:number;maximumFullDayBytes:number;
    maximumRetainedBytes:number};
}
export class SharedAnalyticsFeatureWindowDeferredError extends Error {
  constructor(readonly reason:string) {super('SHARED_ANALYTICS_FEATURE_WINDOW_DEFERRED');}
}
export type SharedAnalyticsFeatureWindowPlanResult =
  | {state:'complete';plan:SharedAnalyticsFeatureWindowPlan}
  | Exclude<SharedAnalyticsFeatureWindowResult,{state:'complete'}>;
const WINDOW_PLAN_NATIVE_HEADROOM = 200, WINDOW_PLAN_SEAL_QUERIES = 64;

/** Retain at most8MiB of compact projections/identities and one fully validated
 * <=4MiB day. Initial integrity reads are private until a second fresh whole
 * window seal; an unchanged owner/input row alone never licenses consumption.
 * Each scalar page, including a cached day, recomputes its exact native day
 * dependency before and after use. Full seals precede externally stored work. */
export async function readSharedAnalyticsFeatureWindowPlan(input:Omit<SharedAnalyticsFeatureInput,'day'> & {
  days:readonly string[];fromDay:string;throughDay:string;metric:'fits'|'model';
  /** Scalar resume after a fully decoded exact format6 quota checkpoint. */
  consumer?:'full'|'scalar';
}):Promise<SharedAnalyticsFeatureWindowPlanResult> {
  if(!input||!Array.isArray(input.days)||input.days.length>MAX_WINDOW_DAYS
    ||!dayValid(input.fromDay)||!dayValid(input.throughDay)||input.fromDay>input.throughDay
    ||Date.parse(input.throughDay)-Date.parse(input.fromDay)>100*86_400_000
    ||(input.metric!=='fits'&&input.metric!=='model')
    ||(input.consumer!==undefined&&input.consumer!=='full'&&input.consumer!=='scalar')
    ||(input.consumer==='scalar'&&input.metric!=='fits')
    ||input.days.some((day,index)=>!dayValid(day)||day<input.fromDay||day>input.throughDay
      ||index>0&&input.days[index-1]!>=day))throw fail();
  // Capture identities and callbacks; caller mutation cannot change the proof.
  const days=Object.freeze([...input.days]),scope={...input,owner:{...input.owner},days};
  const scalarOnly=scope.consumer==='scalar';
  const ordinary={...scope,day:days[0]??input.throughDay};
  checkInput(ordinary);
  // Four fixed integrity statements/day plus two bounded seal quanta. Native
  // continuation/save retains its existing200-query admission. This is an
  // admission allowance, not a claim that arbitrary source proofs cost64.
  if(!available(scope.budget,(scalarOnly?0:4*days.length)+2*WINDOW_PLAN_SEAL_QUERIES+16+WINDOW_PLAN_NATIVE_HEADROOM))
    return {state:'refused',reason:'window_plan_admission'};
  let closedReason:string|undefined;
  let selected:Job[]=[],digests:readonly string[]=[];
  let usageDays:readonly string[]|undefined;
  let projections=new Map<string,{quota:SharedAnalyticsFeatureDay['quota'];
    modelUsage:SharedAnalyticsFeatureDay['modelUsage'];scalarRows:number}>();
  let cache:{day:string;value:SharedAnalyticsFeatureDay;bytes:number}|undefined;
  let compactBytes=0,maximumFullDayBytes=0,maximumRetainedBytes=0;
  let tail:Promise<void>=Promise.resolve();
  const close=(reason='window_closed')=>{
    closedReason??=reason;cache=undefined;selected=[];digests=[];usageDays=undefined;projections.clear();compactBytes=0;
  };
  const deferred=(reason:string)=>{close(reason);return {state:'deferred' as const,reason:closedReason!};};
  const availablePlan=(reserve:number)=>!closedReason&&available(scope.budget,reserve);
  const unavailableReason=()=>closedReason??(scope.budget.now()>=scope.budget.deadlineMs-1_500
    ?'deadline_or_capacity':'query_budget');
  const exclusive=<T>(run:()=>Promise<T>):Promise<T>=>{
    const result=tail.then(run).catch(error=>{
      if(error instanceof D1InvocationBudgetExceededError){close('query_budget');
        throw new SharedAnalyticsFeatureWindowDeferredError('query_budget');}
      close();throw error;
    });tail=result.then(()=>undefined,()=>undefined);return result;
  };
  const sourceRowCurrent=async()=>{
    // Exactly the conjunction of sourceCurrent's owner and analytical-input
    // joins, in one fresh statement. This is only an authority/input check;
    // fresh native dependencies below also fence proof/runtime/correction data.
    const row=await scope.source.prepare(`SELECT v.revision input_revision,o.revision owner_revision,
      o.authority_epoch authority_epoch FROM participants p
      JOIN storage_v11_owner_links l ON l.participant_id=p.id AND l.state='active'
      JOIN storage_owner_revisions o ON o.owner_digest=l.owner_digest AND o.state='active'
      JOIN community_analytical_input_versions v ON v.participant_id=p.id
      WHERE p.id=? AND p.state='active' AND l.owner_digest=?`)
      .bind(scope.owner.participantId,scope.owner.ownerDigest)
      .first<{input_revision:number;owner_revision:number;authority_epoch:number}>();
    return row?.input_revision===scope.owner.inputRevision&&row.owner_revision===scope.owner.ownerRevision
      &&row.authority_epoch===scope.owner.authorityEpoch;
  };
  const targetGuard=`EXISTS(SELECT 1 FROM analytics_owner_state o
    JOIN analytics_runtime_sources r ON r.source_id=o.source_id
    WHERE o.source_id=h.source_id AND o.owner_digest=h.owner_digest AND o.state='active'
      AND o.revision=? AND o.authority_epoch=? AND r.source_namespace=? AND r.contract_version=1
      AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
        WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))`;
  const sameHead=(a:Job,b:Job)=>a.job_key===b.job_key&&a.source_id===b.source_id
    &&a.source_namespace===b.source_namespace&&a.owner_digest===b.owner_digest&&a.day===b.day
    &&a.method_digest===b.method_digest&&a.dependency_digest===b.dependency_digest
    &&a.owner_revision===b.owner_revision&&a.authority_epoch===b.authority_epoch
    &&a.input_revision===b.input_revision&&a.head_revision===b.head_revision&&a.state==='complete'&&b.state==='complete'
    &&a.payload_digest===b.payload_digest&&a.payload_bytes===b.payload_bytes&&a.part_count===b.part_count
    &&a.claim_token===b.claim_token&&a.claim_expires_ms===b.claim_expires_ms;
  const headCurrent=async(job:Job)=>{
    const row=await scope.target.prepare(`SELECT h.* FROM analytics_shared_feature_days h
      WHERE h.job_key=? AND ${targetGuard}`).bind(job.job_key,scope.owner.ownerRevision,
      scope.owner.authorityEpoch,scope.sourceNamespace).first<Job>();
    return !!row&&sameHead(job,row);
  };
  const readDigests=async(requested:readonly string[],reserve:number)=>{
    if(requested.length===0)return [];
    // Always construct anew. A native reader captures header maps; its old
    // readDigest is not a fresh source seal even if the owner row is unchanged.
    const reader=await createEffectiveHistoryDayDependencyReader(scope.source,scope.owner,
      scope.sourceNamespace,requested,{includeSessions:true,occurrenceLinks:'batched',
        canContinue:()=>availablePlan(reserve)});
    if(!reader)return undefined;
    if(reader.readDigests)return reader.readDigests();
    const result:string[]=[];
    for(const day of requested){const digest=await reader.readDigest(day);if(!digest)return undefined;result.push(digest);}
    return result;
  };
  const inventoryCurrent=async()=>{
    const inventory={sourceNamespace:scope.sourceNamespace,ownerDigest:scope.owner.ownerDigest,
      ownerRevision:scope.owner.ownerRevision,authorityEpoch:scope.owner.authorityEpoch,
      fromDay:scope.fromDay,throughDay:scope.throughDay};
    const quota=await readEffectiveTelemetryOwnerDays(scope.source,{...inventory,stream:'quota'});
    const usage=await readEffectiveTelemetryOwnerDays(scope.source,{...inventory,stream:'usage'});
    const fresh=[...new Set([...quota,...usage])].sort();
    if(fresh.length!==days.length||fresh.some((day,index)=>day!==days[index]))return false;
    if(usageDays!==undefined&&(usage.length!==usageDays.length||usage.some((day,index)=>day!==usageDays![index])))return false;
    usageDays??=Object.freeze([...usage]);
    return true;
  };
  const method=await methodDigest(scope.canonicalPreparation!==undefined);
  const identityCurrent=async()=>method===await methodDigest(scope.canonicalPreparation!==undefined)
    &&await supported(scope.target)&&await sourceRowCurrent()&&await targetCurrent(ordinary);
  const fullSeal=async(reserve=20):Promise<{state:'current'}|{state:'deferred';reason:string}>=>{
    if(!availablePlan(WINDOW_PLAN_SEAL_QUERIES+reserve))return deferred(unavailableReason());
    if(!await identityCurrent()||!await inventoryCurrent())return deferred('source_changed');
    const fresh=await readDigests(days,reserve);
    if(!fresh||fresh.length!==digests.length||fresh.some((digest,index)=>digest!==digests[index]))
      return deferred(availablePlan(reserve)?'source_changed':unavailableReason());
    const heads=(await scope.target.prepare(`SELECT h.* FROM analytics_shared_feature_days h
      WHERE h.job_key IN(SELECT value FROM json_each(?)) AND ${targetGuard} LIMIT ?`)
      .bind(JSON.stringify(selected.map(job=>job.job_key)),scope.owner.ownerRevision,scope.owner.authorityEpoch,
        scope.sourceNamespace,selected.length+1).all<Job>()).results;
    if(heads.length!==selected.length||selected.some(job=>!heads.some(head=>sameHead(job,head)))
      ||!await identityCurrent())return deferred('source_changed');
    if(!availablePlan(reserve))return deferred(unavailableReason());
    return {state:'current'};
  };
  const integrityDay=async(job:Job,reserve:number):Promise<SharedAnalyticsFeatureDay|undefined>=>{
    cache=undefined; // Evict before any second complete day is read or decoded.
    if(!availablePlan(reserve+4)||method!==await methodDigest(scope.canonicalPreparation!==undefined)
      ||!await sourceRowCurrent())return undefined;
    const parts=(await scope.target.prepare(`SELECT p.revision,p.part_index,p.payload,p.payload_bytes,p.payload_digest
      FROM analytics_shared_feature_parts p JOIN analytics_shared_feature_days h
        ON h.job_key=p.job_key AND h.head_revision=p.revision
      WHERE h.job_key=? AND h.head_revision=? AND h.payload_digest=? AND h.state='complete'
        AND h.source_id=? AND h.source_namespace=? AND h.owner_digest=? AND h.day=?
        AND h.method_digest=? AND h.dependency_digest=? AND ${targetGuard}
      ORDER BY p.part_index LIMIT ?`).bind(job.job_key,job.head_revision,job.payload_digest,
      scope.sourceId,scope.sourceNamespace,scope.owner.ownerDigest,job.day,method,job.dependency_digest,
      scope.owner.ownerRevision,scope.owner.authorityEpoch,scope.sourceNamespace,MAX_PARTS+1).all<Part>()).results;
    if(!await headCurrent(job))return undefined;
    // The selected immutable head is current. Bad/missing parts under that
    // same head retain the original integrity error instead of becoming empty.
    const frame=await loadFrame(job,parts);
    if(frame.kind!=='complete'||frame.value.day!==job.day||frame.value.ownerDigest!==scope.owner.ownerDigest)throw fail();
    if(!await sourceRowCurrent()||method!==await methodDigest(scope.canonicalPreparation!==undefined)
      ||!availablePlan(reserve))return undefined;
    maximumFullDayBytes=Math.max(maximumFullDayBytes,job.payload_bytes);
    maximumRetainedBytes=Math.max(maximumRetainedBytes,compactBytes+job.payload_bytes);
    return frame.value;
  };
  try{
    if(!await supported(scope.target))return {state:'refused',reason:'migration_required'};
    if(!await sourceRowCurrent()||!await targetCurrent(ordinary)||!await inventoryCurrent())return deferred('source_changed');
    const initial=await readDigests(days,WINDOW_PLAN_NATIVE_HEADROOM);
    if(!initial||initial.length!==days.length)return deferred('deadline_or_capacity');
    digests=Object.freeze([...initial]);
    let heads=days.length===0?[]:(await scope.target.prepare(`SELECT * FROM analytics_shared_feature_days
      WHERE source_id=? AND source_namespace=? AND owner_digest=? AND method_digest=?
        AND day BETWEEN ? AND ? ORDER BY day,updated_ms DESC LIMIT ?`)
      .bind(scope.sourceId,scope.sourceNamespace,scope.owner.ownerDigest,method,
        scope.fromDay,scope.throughDay,days.length*MAX_HEADS_PER_DAY+1).all<Job>()).results;
    if(heads.length>days.length*MAX_HEADS_PER_DAY)return {state:'refused',reason:'retained_head_limit'};
    for(const [index,day] of days.entries()){
      const head=heads.find(row=>row.day===day&&row.dependency_digest===digests[index]);
      if(!head||head.state==='building')return {state:'missing',day};
      if(head.state==='refused')return {state:'refused',reason:'prepared_day_refused'};
      selected.push({...head});
    }
    heads=[];
    compactBytes=byteSize(canonicalJson({days,method,selected,digests}))+2;
    if(compactBytes>MAX_WINDOW_BYTES)return {state:'refused',reason:'window_projection_byte_limit'};
    if(!scalarOnly)for(const [index,job] of selected.entries()){
      const reserve=4*(selected.length-index-1)+WINDOW_PLAN_SEAL_QUERIES+WINDOW_PLAN_NATIVE_HEADROOM;
      const value=await integrityDay(job,reserve);
      if(!value)return deferred(availablePlan(reserve)?'source_changed':unavailableReason());
      const projection={quota:value.quota,modelUsage:value.modelUsage,scalarRows:value.scalarUsage.length};
      compactBytes+=byteSize(canonicalJson({day:job.day,...projection}))+1;
      if(compactBytes>MAX_WINDOW_BYTES)return {state:'refused',reason:'window_projection_byte_limit'};
      projections.set(job.day,projection);
    }
    // No value has been offered to a reducer before this fresh full seal.
    const initialSeal=await fullSeal(WINDOW_PLAN_NATIVE_HEADROOM);
    if(initialSeal.state!=='current')return initialSeal;
    if(scope.metric==='model'&&!effectiveUsageWindowRepresentable([...projections.values()].map(value=>value.modelUsage)))
      return {state:'refused',reason:'window_projection_unrepresentable'};
    maximumRetainedBytes=Math.max(maximumRetainedBytes,compactBytes+maximumFullDayBytes);
    // The producer appends exactly one scalar feature per compatible effective
    // usage row, or refuses the entire day. The native inventory is therefore
    // the exact nonempty scalar-day set; no frame or partial count is inferred.
    const scalarDays=Object.freeze(scalarOnly?[...usageDays!]:days.filter(day=>projections.get(day)!.scalarRows>0));
    const requireSeal=async()=>{const seal=await fullSeal();
      if(seal.state!=='current')throw new SharedAnalyticsFeatureWindowDeferredError(seal.reason);};
    const loadProjection=async<T>(requested:readonly string[],select:(value:NonNullable<ReturnType<typeof projections.get>>)=>T):Promise<readonly T[]>=>{
      if(scalarOnly)throw new SharedAnalyticsFeatureWindowDeferredError(deferred('projection_not_available').reason);
      await requireSeal();
      if(!Array.isArray(requested)||requested.some((day,index)=>!projections.has(day)||index>0&&requested[index-1]!>=day))
        throw new SharedAnalyticsFeatureWindowDeferredError(deferred('source_changed').reason);
      return requested.map(day=>select(projections.get(day)!));
    };
    const usageReader:import('./quota-analysis-v11').V11PreparedUsageReader={days:scalarDays,
      readPage:page=>exclusive(async()=>{
        if(!availablePlan(80))return deferred(unavailableReason());
        const index=days.indexOf(page.day),job=selected[index];
        if(!job||!scalarDays.includes(page.day)||!Number.isFinite(Date.parse(page.afterTime))
          ||typeof page.afterOccurrence!=='string'||page.afterOccurrence.length>128)throw fail();
        if(!await identityCurrent()||!await headCurrent(job))return deferred('source_changed');
        const before=await readDigests([page.day],30);
        if(before?.[0]!==digests[index])return deferred('source_changed');
        if(cache?.day!==page.day){const value=await integrityDay(job,30);
          if(!value)return deferred(availablePlan(30)?'source_changed':unavailableReason());
          cache={day:page.day,value,bytes:job.payload_bytes};}
        if(!cache||!availablePlan(30))return deferred(unavailableReason());
        const at=Date.parse(page.afterTime),rows=cache.value.scalarUsage;
        const offset=rows.findIndex(row=>row.observedAtMs>at||row.observedAtMs===at&&row.occurrenceId>page.afterOccurrence);
        const result={state:'ready' as const,rows:offset<0?[]:rows.slice(offset,offset+200),
          complete:offset<0||offset+200>=rows.length};
        const after=await readDigests([page.day],20);
        if(after?.[0]!==digests[index]||!await headCurrent(job)||!await identityCurrent())
          return deferred(availablePlan(20)?'source_changed':unavailableReason());
        if(!availablePlan(20))return deferred(unavailableReason());
        return result;
      })};
    const plan:SharedAnalyticsFeatureWindowPlan={days,scalarDays,dependencyDigests:digests,usageReader,
      loadQuota:requested=>exclusive(()=>loadProjection(requested,value=>value.quota)),
      loadModelUsage:requested=>exclusive(()=>loadProjection(requested,value=>value.modelUsage)),
      seal:()=>exclusive(()=>fullSeal()),close:()=>close(),
      logicalBytes:()=>({compactBytes,fullDayBytes:cache?.bytes??0,maximumFullDayBytes,maximumRetainedBytes})};
    return {state:'complete',plan};
  }catch(error){
    close();
    if(error instanceof D1InvocationBudgetExceededError)return {state:'deferred',reason:'query_budget'};
    throw error;
  }
}
