import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import {
  MODEL_BLOCK_MAX_CHECKPOINT_BYTES, MODEL_BLOCK_METHOD, MODEL_BLOCK_PREVIEW_DAYS,
  historicalModelBlockRangeEligible, planHistoricalModelBlockRanges,
  validModelBlockCheckpoint, validModelBlockIdentity,
  type ModelBlockCheckpoint, type ModelBlockIdentity,
} from './analytics-model-block-contract';

/** Experimental local persistence only; no production scheduler uses this API. */
export interface ModelBlockStored { revision: number; checkpoint: ModelBlockCheckpoint }
export interface ModelBlockClaim extends ModelBlockStored { token: string }
export interface ModelBlockAdmission { revision: number; todayDay: string }
interface Scope { target: D1Database; identity: ModelBlockIdentity; historicalTodayDay?: string;
  admission?: ModelBlockAdmission }
interface Head extends ModelBlockStored { token: string | null; digest: string }
const PART_BYTES = 128 * 1024, MAX_PARTS = 81;
export const MODEL_BLOCK_MAX_STORED_JOBS = 4;
const HEX = /^[a-f0-9]{64}$/u, CLAIM = /^[a-f0-9-]{36}$/u;
const invalid = () => new TypeError('MODEL_BLOCK_STORE_INVALID');
const corrupt = () => new Error('MODEL_BLOCK_STORE_CORRUPT');
const safe = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const JOB_COLUMNS = ['job_key', 'identity_json', 'source_id', 'source_namespace', 'owner_digest', 'authority_epoch',
  'admission_revision',
  'head_revision', 'state', 'checkpoint_digest', 'checkpoint_bytes', 'part_count', 'claim_token', 'claim_expires_ms', 'updated_ms'];
const POLICY_COLUMNS = ['source_id', 'owner_digest', 'policy_revision', 'source_namespace', 'owner_revision',
  'authority_epoch', 'input_revision', 'method', 'authority_digest', 'today_day', 'range0_from',
  'range0_through', 'range1_from', 'range1_through', 'updated_ms', 'range2_from', 'range2_through',
  'range3_from', 'range3_through'];
const PART_COLUMNS = ['job_key', 'source_id', 'owner_digest', 'revision', 'part_index', 'payload', 'payload_bytes',
  'payload_sha256', 'claim_token', 'saved_ms'];
const TRIGGERS = [
  'analytics_model_blocks_insert', 'analytics_model_blocks_update', 'analytics_model_block_parts_insert',
  'analytics_model_block_parts_immutable', 'analytics_model_block_parts_retained', 'analytics_model_blocks_owner_update',
  'analytics_model_blocks_owner_delete', 'analytics_model_blocks_runtime_update', 'analytics_model_blocks_runtime_delete',
  'analytics_model_blocks_terminal_insert', 'analytics_model_blocks_terminal_update', 'analytics_model_block_contract_v1',
  'analytics_model_block_admission_v2',
  'analytics_model_block_policy_insert', 'analytics_model_block_policy_update',
  'analytics_model_block_policy_owner_update', 'analytics_model_block_policy_owner_delete',
  'analytics_model_block_policy_runtime_update', 'analytics_model_block_policy_runtime_delete',
  'analytics_model_block_policy_terminal_insert', 'analytics_model_block_policy_terminal_update',
  'analytics_model_block_cursor_runtime_update', 'analytics_model_block_cursor_runtime_delete',
  'analytics_model_block_clipped_ranges_v1', 'analytics_model_block_clipped_ranges_update_v1',
];
const TABLES = ['analytics_model_blocks', 'analytics_model_block_parts', 'analytics_model_block_policy',
  'analytics_model_block_retirement_cursors'];
const INDEXES = ['analytics_model_blocks_owner', 'analytics_model_blocks_source_cursor',
  'analytics_model_block_parts_owner'];
const CURSOR_COLUMNS = ['source_id', 'after_rowid', 'revision'];
/** Absence and partial upgrades fail before any payload write. Do not memoize:
 * local migration rehearsal and schema loss must not reuse an earlier proof. */
export async function modelBlockStoreSupported(target: D1Database): Promise<boolean> {
  const names = [...TABLES, ...INDEXES, ...TRIGGERS];
  const result = await target.prepare(`SELECT 'schema' AS kind,type,name FROM sqlite_schema
    WHERE name IN (${names.map(() => '?').join(',')})
    UNION ALL SELECT 'jobs','column',name FROM pragma_table_info('analytics_model_blocks')
    UNION ALL SELECT 'parts','column',name FROM pragma_table_info('analytics_model_block_parts')
    UNION ALL SELECT 'policy','column',name FROM pragma_table_info('analytics_model_block_policy')
    UNION ALL SELECT 'cursor','column',name FROM pragma_table_info('analytics_model_block_retirement_cursors')`).bind(...names)
    .all<{ kind: string; type: string; name: string }>();
  if (!result.success || !Array.isArray(result.results)) throw corrupt();
  const equal = (a: string[], b: readonly string[]) => a.sort().join(',') === [...b].sort().join(',');
  return equal(result.results.filter(row => row.kind === 'schema' && row.type === 'table').map(row => row.name), TABLES)
    && equal(result.results.filter(row => row.kind === 'schema' && row.type === 'index').map(row => row.name), INDEXES)
    && equal(result.results.filter(row => row.kind === 'schema' && row.type === 'trigger').map(row => row.name), TRIGGERS)
    && equal(result.results.filter(row => row.kind === 'jobs').map(row => row.name), JOB_COLUMNS)
    && equal(result.results.filter(row => row.kind === 'parts').map(row => row.name), PART_COLUMNS)
    && equal(result.results.filter(row => row.kind === 'policy').map(row => row.name), POLICY_COLUMNS)
    && equal(result.results.filter(row => row.kind === 'cursor').map(row => row.name), CURSOR_COLUMNS);
}
export async function modelBlockJobKey(identity: ModelBlockIdentity): Promise<string> {
  if (!validModelBlockIdentity(identity)) throw invalid();
  return sha256Hex(canonicalJson(identity));
}
interface PolicyRow {
  policy_revision: number; source_namespace: string; owner_revision: number; authority_epoch: number;
  input_revision: number; method: string; authority_digest: string; today_day: string;
  range0_from: string | null; range0_through: string | null;
  range1_from: string | null; range1_through: string | null;
  range2_from: string | null; range2_through: string | null;
  range3_from: string | null; range3_through: string | null;
}

/** Cross-database boundary: observe target policy, then demand a fresh source
 * proof, then CAS that exact target revision. A later policy change revokes the
 * returned token for every read, claim, ensure and save. */
export async function prepareModelBlockAdmission(options: { target: D1Database; identity: ModelBlockIdentity;
  todayDay: string; now: number; assertSourceCurrent: () => Promise<void> }): Promise<ModelBlockAdmission | null> {
  const { target, identity, todayDay, now, assertSourceCurrent } = options;
  if (!validModelBlockIdentity(identity) || !safe(now) || typeof assertSourceCurrent !== 'function'
    || new Date(now).toISOString().slice(0, 10) !== todayDay
    || !historicalModelBlockRangeEligible(identity, todayDay)) throw invalid();
  if (!await modelBlockStoreSupported(target)) return null;
  const ranges = planHistoricalModelBlockRanges(todayDay);
  const prior = await target.prepare(`SELECT policy_revision,source_namespace,owner_revision,authority_epoch,
    input_revision,method,authority_digest,today_day,range0_from,range0_through,range1_from,range1_through,
    range2_from,range2_through,range3_from,range3_through
    FROM analytics_model_block_policy WHERE source_id=? AND owner_digest=?`)
    .bind(identity.sourceId, identity.ownerDigest).first<PolicyRow>();
  if (prior && (!safe(prior.policy_revision) || prior.policy_revision < 1
    || prior.method !== MODEL_BLOCK_METHOD || prior.today_day > todayDay
    || prior.owner_revision > identity.ownerRevision || prior.input_revision > identity.inputRevision)) return null;
  await assertSourceCurrent();
  const targetGuard = `EXISTS(SELECT 1 FROM analytics_owner_state o JOIN analytics_runtime_sources r
    ON r.source_id=o.source_id WHERE o.source_id=? AND o.owner_digest=? AND o.state='active'
      AND o.revision=? AND o.authority_epoch=? AND r.source_namespace=? AND r.contract_version=1
      AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
        WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))`;
  const guardBindings = [identity.sourceId, identity.ownerDigest, identity.ownerRevision,
    identity.authorityEpoch, identity.sourceNamespace];
  const rangeBindings = Array.from({ length: MODEL_BLOCK_MAX_STORED_JOBS }, (_, index) =>
    [ranges[index]?.outputFromDay ?? null, ranges[index]?.outputThroughDay ?? null]).flat();
  const same = prior && prior.source_namespace === identity.sourceNamespace
    && prior.owner_revision === identity.ownerRevision && prior.authority_epoch === identity.authorityEpoch
    && prior.input_revision === identity.inputRevision && prior.method === identity.method
    && prior.authority_digest === identity.authorityDigest && prior.today_day === todayDay
    && prior.range0_from === rangeBindings[0] && prior.range0_through === rangeBindings[1]
    && prior.range1_from === rangeBindings[2] && prior.range1_through === rangeBindings[3]
    && prior.range2_from === rangeBindings[4] && prior.range2_through === rangeBindings[5]
    && prior.range3_from === rangeBindings[6] && prior.range3_through === rangeBindings[7];
  if (same) {
    const ready = await target.prepare(`SELECT 1 AS ready WHERE ${targetGuard}
      AND EXISTS(SELECT 1 FROM analytics_model_block_policy p WHERE p.source_id=? AND p.owner_digest=?
        AND p.policy_revision=? AND p.source_namespace=? AND p.owner_revision=?
        AND p.authority_epoch=? AND p.input_revision=? AND p.method=? AND p.authority_digest=?
        AND p.today_day=? AND p.range0_from=? AND p.range0_through=?
        AND p.range1_from IS ? AND p.range1_through IS ?
        AND p.range2_from IS ? AND p.range2_through IS ?
        AND p.range3_from IS ? AND p.range3_through IS ?)`)
      .bind(...guardBindings, identity.sourceId, identity.ownerDigest, prior.policy_revision,
        identity.sourceNamespace, identity.ownerRevision, identity.authorityEpoch,
        identity.inputRevision, identity.method, identity.authorityDigest, todayDay, ...rangeBindings)
      .first<number>('ready');
    return ready === 1 ? { revision: prior.policy_revision, todayDay } : null;
  }
  if (prior) {
    if (prior.policy_revision >= Number.MAX_SAFE_INTEGER) return null;
    const updated = await target.prepare(`UPDATE analytics_model_block_policy AS p SET
      policy_revision=policy_revision+1,source_namespace=?,owner_revision=?,authority_epoch=?,
      input_revision=?,method=?,authority_digest=?,today_day=?,range0_from=?,range0_through=?,
      range1_from=?,range1_through=?,range2_from=?,range2_through=?,range3_from=?,range3_through=?,updated_ms=?
      WHERE p.source_id=? AND p.owner_digest=? AND p.policy_revision=? AND p.today_day<=?
        AND p.updated_ms<=? AND ${targetGuard} RETURNING policy_revision`)
      .bind(identity.sourceNamespace, identity.ownerRevision, identity.authorityEpoch,
        identity.inputRevision, identity.method, identity.authorityDigest, todayDay,
        ...rangeBindings, now, identity.sourceId, identity.ownerDigest, prior.policy_revision,
        todayDay, now, ...guardBindings).all<{ policy_revision: number }>();
    if (!updated.success || !Array.isArray(updated.results) || updated.results.length > 1) throw corrupt();
    return updated.results[0] ? { revision: updated.results[0].policy_revision, todayDay } : null;
  }
  const inserted = await target.prepare(`INSERT INTO analytics_model_block_policy
    (source_id,owner_digest,policy_revision,source_namespace,owner_revision,authority_epoch,input_revision,
      method,authority_digest,today_day,range0_from,range0_through,range1_from,range1_through,
      range2_from,range2_through,range3_from,range3_through,updated_ms)
    SELECT ?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${targetGuard}
      AND NOT EXISTS(SELECT 1 FROM analytics_model_block_policy WHERE source_id=? AND owner_digest=?)
    ON CONFLICT(source_id,owner_digest) DO NOTHING RETURNING policy_revision`)
    .bind(identity.sourceId, identity.ownerDigest, identity.sourceNamespace, identity.ownerRevision,
      identity.authorityEpoch, identity.inputRevision, identity.method, identity.authorityDigest,
      todayDay, ...rangeBindings, now, ...guardBindings, identity.sourceId, identity.ownerDigest)
    .all<{ policy_revision: number }>();
  if (!inserted.success || !Array.isArray(inserted.results) || inserted.results.length > 1) throw corrupt();
  return inserted.results[0] ? { revision: inserted.results[0].policy_revision, todayDay } : null;
}
function policyGuard(alias: string, admission: ModelBlockAdmission | undefined): string {
  if (!admission) return `${alias}.admission_revision IS NULL
    AND NOT EXISTS(SELECT 1 FROM analytics_model_block_policy p
      WHERE p.source_id=${alias}.source_id AND p.owner_digest=${alias}.owner_digest)`;
  if (!safe(admission.revision) || admission.revision < 1
    || !/^\d{4}-\d{2}-\d{2}$/u.test(admission.todayDay)) throw invalid();
  return `EXISTS(SELECT 1 FROM analytics_model_block_policy p
    WHERE p.source_id=${alias}.source_id AND p.owner_digest=${alias}.owner_digest
      AND p.policy_revision=${admission.revision} AND p.today_day='${admission.todayDay}'
      AND p.source_namespace=${alias}.source_namespace
      AND p.owner_revision=json_extract(${alias}.identity_json,'$.ownerRevision')
      AND p.authority_epoch=${alias}.authority_epoch
      AND p.input_revision=json_extract(${alias}.identity_json,'$.inputRevision')
      AND p.method=json_extract(${alias}.identity_json,'$.method')
      AND p.authority_digest=json_extract(${alias}.identity_json,'$.authorityDigest')
      AND ((p.range0_from=json_extract(${alias}.identity_json,'$.outputFromDay')
        AND p.range0_through=json_extract(${alias}.identity_json,'$.outputThroughDay'))
        OR (p.range1_from=json_extract(${alias}.identity_json,'$.outputFromDay')
        AND p.range1_through=json_extract(${alias}.identity_json,'$.outputThroughDay'))
        OR (p.range2_from=json_extract(${alias}.identity_json,'$.outputFromDay')
        AND p.range2_through=json_extract(${alias}.identity_json,'$.outputThroughDay'))
        OR (p.range3_from=json_extract(${alias}.identity_json,'$.outputFromDay')
        AND p.range3_through=json_extract(${alias}.identity_json,'$.outputThroughDay'))))`;
}
function current(alias: string, admission?: ModelBlockAdmission): string {
  return `EXISTS(SELECT 1 FROM analytics_owner_state o JOIN analytics_runtime_sources r ON r.source_id=o.source_id
    WHERE o.source_id=${alias}.source_id AND o.owner_digest=${alias}.owner_digest AND o.state='active'
      AND o.authority_epoch=${alias}.authority_epoch
      AND o.revision=json_extract(${alias}.identity_json,'$.ownerRevision')
      AND r.contract_version=1 AND r.source_namespace=${alias}.source_namespace
      AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest)
      AND ${policyGuard(alias, admission)})`;
}
function historicalAllowed({ identity, historicalTodayDay, admission }: Scope): boolean {
  if (historicalTodayDay === undefined) return admission === undefined;
  return admission?.todayDay === historicalTodayDay
    && historicalModelBlockRangeEligible(identity, historicalTodayDay);
}
interface Row {
  job_key: string; identity_json: string; source_id: string; source_namespace: string; owner_digest: string;
  authority_epoch: number; head_revision: number; state: string; checkpoint_digest: string | null;
  checkpoint_bytes: number; part_count: number; claim_token: string | null; claim_expires_ms: number | null; updated_ms: number;
  part_index: number | null; payload: string | null; payload_bytes: number | null; payload_sha256: string | null;
}
/** One SQL snapshot prevents a concurrent head promotion/deletion from turning
 * a healthy old revision into an apparent missing-parts corruption. */
async function load(options: Scope, key: string, staleRead = false): Promise<Head | null> {
  const { target, identity } = options;
  const result = await target.prepare(`SELECT h.*,p.part_index,p.payload,p.payload_bytes,p.payload_sha256
    FROM analytics_model_blocks h LEFT JOIN analytics_model_block_parts p
      ON p.job_key=h.job_key AND p.revision=h.head_revision
    WHERE h.job_key=? AND ${staleRead ? '1=1' : current('h', options.admission)}
    ORDER BY p.part_index LIMIT ?`).bind(key, MAX_PARTS + 1).all<Row>();
  if (!result.success || !Array.isArray(result.results)) throw corrupt();
  const rows = result.results, head = rows[0];
  if (!head) return null;
  if (head.job_key !== key || head.identity_json !== canonicalJson(identity) || head.source_id !== identity.sourceId
    || head.source_namespace !== identity.sourceNamespace || head.owner_digest !== identity.ownerDigest
    || head.authority_epoch !== identity.authorityEpoch || !safe(head.head_revision) || head.head_revision < 1
    || !['pending', 'complete'].includes(head.state) || !safe(head.checkpoint_bytes) || head.checkpoint_bytes < 1
    || head.checkpoint_bytes > MODEL_BLOCK_MAX_CHECKPOINT_BYTES || !safe(head.part_count) || head.part_count < 1
    || head.part_count > MAX_PARTS || rows.length !== head.part_count || !safe(head.updated_ms)
    || typeof head.checkpoint_digest !== 'string' || !HEX.test(head.checkpoint_digest)
    || (head.claim_token === null) !== (head.claim_expires_ms === null)
    || head.claim_token !== null && (!CLAIM.test(head.claim_token) || !safe(head.claim_expires_ms)
      || head.claim_expires_ms <= head.updated_ms || head.state === 'complete')) throw corrupt();
  let bytes = 0;
  for (const [index, row] of rows.entries()) {
    if (row.part_index !== index || typeof row.payload !== 'string' || !safe(row.payload_bytes)
      || row.payload_bytes < 1 || row.payload_bytes > PART_BYTES || typeof row.payload_sha256 !== 'string'
      || !HEX.test(row.payload_sha256) || new TextEncoder().encode(row.payload).byteLength !== row.payload_bytes
      || await sha256Hex(row.payload) !== row.payload_sha256) throw corrupt();
    bytes += row.payload_bytes;
  }
  const json = rows.map(row => row.payload).join('');
  if (bytes !== head.checkpoint_bytes || await sha256Hex(json) !== head.checkpoint_digest) throw corrupt();
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw corrupt(); }
  if (!validModelBlockCheckpoint(value, identity) || canonicalJson(value) !== json
    || (value.phase === 'complete') !== (head.state === 'complete')) throw corrupt();
  return { revision: head.head_revision, checkpoint: value, token: head.claim_token, digest: head.checkpoint_digest };
}
export async function readModelBlockJob(options: Scope): Promise<ModelBlockStored | null> {
  if (!historicalAllowed(options)) return null;
  const key = await modelBlockJobKey(options.identity);
  if (!await modelBlockStoreSupported(options.target)) return null;
  const head = await load(options, key);
  return head ? { revision: head.revision, checkpoint: head.checkpoint } : null;
}
/** Read-only candidate for a new revision of the same exact historical range.
 * The caller must prove every selected dependency against the current source
 * before installing this checkpoint under its new identity. Active leases are
 * left alone, and the ordinary target admission still governs the new job. */
export async function readRebasableModelBlockCheckpoint(options: { target: D1Database;
  identity: ModelBlockIdentity; now: number }): Promise<ModelBlockCheckpoint | null> {
  const { target, identity, now } = options;
  if (!validModelBlockIdentity(identity) || !safe(now)) throw invalid();
  if (!await modelBlockStoreSupported(target)) return null;
  const rows = await target.prepare(`SELECT job_key,identity_json,claim_token,claim_expires_ms
    FROM analytics_model_blocks WHERE source_id=? AND owner_digest=? AND source_namespace=?
      AND EXISTS(SELECT 1 FROM analytics_owner_state o JOIN analytics_runtime_sources r
        ON r.source_id=o.source_id WHERE o.source_id=? AND o.owner_digest=? AND o.state='active'
          AND o.revision=? AND o.authority_epoch=? AND r.source_namespace=? AND r.contract_version=1
          AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
            WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
    ORDER BY updated_ms DESC LIMIT ?`)
    .bind(identity.sourceId, identity.ownerDigest, identity.sourceNamespace,
      identity.sourceId, identity.ownerDigest, identity.ownerRevision, identity.authorityEpoch,
      identity.sourceNamespace, MODEL_BLOCK_MAX_STORED_JOBS)
    .all<{ job_key: string; identity_json: string; claim_token: string | null; claim_expires_ms: number | null }>();
  if (!rows.success || !Array.isArray(rows.results)) throw corrupt();
  for (const row of rows.results) {
    let prior: unknown;
    try { prior = JSON.parse(row.identity_json); } catch { throw corrupt(); }
    if (!validModelBlockIdentity(prior)) continue; // Unknown later methods are owned by their writer.
    if (prior.sourceId !== identity.sourceId || prior.sourceNamespace !== identity.sourceNamespace
      || prior.ownerDigest !== identity.ownerDigest || prior.method !== identity.method
      || prior.outputFromDay !== identity.outputFromDay || prior.outputThroughDay !== identity.outputThroughDay
      || prior.authorityEpoch !== identity.authorityEpoch || prior.authorityDigest !== identity.authorityDigest
      || prior.ownerRevision > identity.ownerRevision || prior.inputRevision > identity.inputRevision
      || prior.ownerRevision === identity.ownerRevision && prior.inputRevision === identity.inputRevision
      || row.claim_token !== null && row.claim_expires_ms !== null && row.claim_expires_ms > now) continue;
    if (row.job_key !== await modelBlockJobKey(prior)) throw corrupt();
    const head = await load({ target, identity: prior }, row.job_key, true);
    if (head && head.checkpoint.dependencies.length > 0
      && validModelBlockCheckpoint(head.checkpoint, identity)) return head.checkpoint;
  }
  return null;
}
interface Framing { bytes: number; digest: string; parts: { payload: string; bytes: number; digest: string }[] }
async function frame(checkpoint: ModelBlockCheckpoint, identity: ModelBlockIdentity): Promise<Framing> {
  if (!validModelBlockCheckpoint(checkpoint, identity)) throw invalid();
  const json = canonicalJson(checkpoint), bytes = new TextEncoder().encode(json);
  if (bytes.byteLength < 1 || bytes.byteLength > MODEL_BLOCK_MAX_CHECKPOINT_BYTES) throw invalid();
  const parts: Framing['parts'] = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + PART_BYTES, bytes.length);
    // Never split a UTF-8 continuation sequence. JSON string fragments preserve
    // every byte after joining, including non-ASCII model metadata.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    const payload = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(start, end));
    parts.push({ payload, bytes: end - start, digest: await sha256Hex(payload) }); start = end;
  }
  if (parts.length > MAX_PARTS) throw invalid();
  return { bytes: bytes.length, digest: await sha256Hex(bytes), parts };
}
function claimValid(claim: ModelBlockClaim, identity: ModelBlockIdentity): boolean {
  return !!claim && CLAIM.test(claim.token) && safe(claim.revision) && claim.revision > 0
    && claim.revision < Number.MAX_SAFE_INTEGER && validModelBlockCheckpoint(claim.checkpoint, identity);
}
function nextValid(prior: ModelBlockCheckpoint, next: ModelBlockCheckpoint): boolean {
  const edges: Record<ModelBlockCheckpoint['phase'], readonly ModelBlockCheckpoint['phase'][]> = {
    select: ['select', 'acquire', 'emit', 'fallback', 'complete'],
    acquire: ['acquire', 'emit', 'fallback', 'complete'], emit: ['emit', 'fallback', 'complete'],
    fallback: ['fallback', 'complete'], complete: [],
  };
  const dependenciesRetained = prior.phase === 'select'
    ? next.dependencies.length >= prior.dependencies.length
      && prior.dependencies.every((value, index) => canonicalJson(value) === canonicalJson(next.dependencies[index]))
    : canonicalJson(prior.dependencies) === canonicalJson(next.dependencies);
  if (!edges[prior.phase].includes(next.phase) || next.inputIndex < prior.inputIndex
    || !dependenciesRetained
    || next.outputs.length < prior.outputs.length
    || !prior.outputs.every((value, index) => canonicalJson(value) === canonicalJson(next.outputs[index]))) return false;
  if (prior.phase !== 'acquire' || next.phase !== 'acquire' || next.inputIndex !== prior.inputIndex
    || prior.pending === null) return true;
  const before = prior.pending, after = next.pending;
  if (after === null) return false;
  const streams = { quota: 0, usage: 1, store: 2 };
  if (streams[after.stream] < streams[before.stream] || after.quota.quotaRowsRead < before.quota.quotaRowsRead
    || after.usage.projection.usage.rowsRead < before.usage.projection.usage.rowsRead
    || before.usage.lastObservedAtMs !== null && (after.usage.lastObservedAtMs === null
      || after.usage.lastObservedAtMs < before.usage.lastObservedAtMs)) return false;
  // A stream transition resets its page cursor. Within one stream the source
  // order is (observed time, binary occurrence ID), including equal-time ties.
  // Compact summaries may change shape while growing, so compare ordinals and
  // counts rather than requiring an immutable array prefix from the reducer.
  if (before.stream !== after.stream) return true;
  const sameCounts = after.quota.quotaRowsRead === before.quota.quotaRowsRead
    && after.usage.projection.usage.rowsRead === before.usage.projection.usage.rowsRead;
  if (before.after === null) return after.after !== null || sameCounts;
  if (after.after === null) return false;
  return after.after.observedAtMs > before.after.observedAtMs || after.after.observedAtMs === before.after.observedAtMs
    && (after.after.occurrenceId > before.after.occurrenceId || after.after.occurrenceId === before.after.occurrenceId && sameCounts);
}
function saveStatements(options: Scope, key: string, framed: Framing, checkpoint: ModelBlockCheckpoint,
  revision: number, token: string | null, now: number): D1PreparedStatement[] {
  const { target } = options, nextRevision = revision + 1;
  const guard = `h.job_key=? AND h.head_revision=? AND h.claim_token IS ? AND h.state='pending'
    AND h.updated_ms<=? AND (h.head_revision=0 OR h.claim_expires_ms>?) AND ${current('h', options.admission)}`;
  const bindings = [key, revision, token, now, now];
  return [
    ...framed.parts.map((part, index) => target.prepare(`INSERT INTO analytics_model_block_parts
      (job_key,source_id,owner_digest,revision,part_index,payload,payload_bytes,payload_sha256,claim_token,saved_ms)
      SELECT h.job_key,h.source_id,h.owner_digest,?,?,?,?,?,?,? FROM analytics_model_blocks h WHERE ${guard}`)
      .bind(nextRevision, index, part.payload, part.bytes, part.digest, token, now, ...bindings)),
    target.prepare(`UPDATE analytics_model_blocks AS h SET head_revision=?,state=?,checkpoint_digest=?,checkpoint_bytes=?,
      part_count=?,claim_token=NULL,claim_expires_ms=NULL,updated_ms=? WHERE ${guard}`)
      .bind(nextRevision, checkpoint.phase === 'complete' ? 'complete' : 'pending', framed.digest, framed.bytes,
        framed.parts.length, now, ...bindings),
    target.prepare(`DELETE FROM analytics_model_block_parts WHERE job_key=? AND revision!=?
      AND EXISTS(SELECT 1 FROM analytics_model_blocks h WHERE h.job_key=? AND h.head_revision=?
        AND h.checkpoint_digest=? AND ${current('h', options.admission)})`).bind(key, nextRevision, key, nextRevision, framed.digest),
  ];
}
export async function ensureModelBlockJob(options: Scope & { initial: ModelBlockCheckpoint; now: number }): Promise<boolean> {
  const { target, identity, initial, now } = options;
  if (!safe(now)) throw invalid();
  if (!historicalAllowed(options)) return false;
  const key = await modelBlockJobKey(identity), framed = await frame(initial, identity);
  if (!await modelBlockStoreSupported(target)) return false;
  const insert = target.prepare(`INSERT INTO analytics_model_blocks
    (job_key,identity_json,source_id,source_namespace,owner_digest,authority_epoch,admission_revision,updated_ms)
    SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM analytics_owner_state o JOIN analytics_runtime_sources r ON r.source_id=o.source_id
      WHERE o.source_id=? AND o.owner_digest=? AND o.state='active' AND o.authority_epoch=?
        AND o.revision=? AND r.source_namespace=? AND r.contract_version=1
        AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
          WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest))
      AND (SELECT COUNT(*) FROM analytics_model_blocks WHERE source_id=? AND owner_digest=?)<?
      AND ${options.admission ? `EXISTS(SELECT 1 FROM analytics_model_block_policy p
        WHERE p.source_id=? AND p.owner_digest=? AND p.policy_revision=? AND p.today_day=?
        AND p.source_namespace=? AND p.owner_revision=? AND p.authority_epoch=?
        AND p.input_revision=? AND p.method=? AND p.authority_digest=?
        AND ((p.range0_from=? AND p.range0_through=?) OR (p.range1_from=? AND p.range1_through=?)
          OR (p.range2_from=? AND p.range2_through=?) OR (p.range3_from=? AND p.range3_through=?)))`
    : `NOT EXISTS(SELECT 1 FROM analytics_model_block_policy p WHERE p.source_id=? AND p.owner_digest=?)`}
    ON CONFLICT(job_key) DO NOTHING`)
    .bind(key, canonicalJson(identity), identity.sourceId, identity.sourceNamespace, identity.ownerDigest,
      identity.authorityEpoch, options.admission?.revision ?? null,
      now, identity.sourceId, identity.ownerDigest, identity.authorityEpoch, identity.ownerRevision,
      identity.sourceNamespace, identity.sourceId, identity.ownerDigest, MODEL_BLOCK_MAX_STORED_JOBS,
      ...(options.admission ? [identity.sourceId, identity.ownerDigest, options.admission.revision,
        options.admission.todayDay, identity.sourceNamespace, identity.ownerRevision, identity.authorityEpoch,
        identity.inputRevision, identity.method, identity.authorityDigest, identity.outputFromDay,
        identity.outputThroughDay, identity.outputFromDay, identity.outputThroughDay,
        identity.outputFromDay, identity.outputThroughDay, identity.outputFromDay, identity.outputThroughDay]
        : [identity.sourceId, identity.ownerDigest]));
  try { await target.batch([insert, ...saveStatements(options, key, framed, initial, 0, null, now)]); }
  catch (error) { if (await load(options, key)) return true; throw error; }
  return !!await load(options, key);
}
export async function claimModelBlockJob(options: Scope & { now: number; leaseMs?: number }): Promise<ModelBlockClaim | null> {
  const { target, now } = options, leaseMs = options.leaseMs ?? 60_000;
  if (!safe(now) || !safe(leaseMs) || leaseMs < 1 || leaseMs > 300_000 || !safe(now + leaseMs)) throw invalid();
  if (!historicalAllowed(options)) return null;
  const key = await modelBlockJobKey(options.identity);
  if (!await modelBlockStoreSupported(target)) return null;
  // Validate before taking ownership. A corrupt checkpoint must not leave an
  // inaccessible lease behind when decoding fails. The following CAS binds
  // this exact head, so a concurrent promotion cannot return the old payload.
  const prior = await load(options, key);
  if (!prior || prior.checkpoint.phase === 'complete') return null;
  const token = crypto.randomUUID();
  try {
    const result = await target.prepare(`UPDATE analytics_model_blocks AS h SET claim_token=?,claim_expires_ms=?,updated_ms=?
      WHERE h.job_key=? AND h.head_revision=? AND h.checkpoint_digest=? AND h.state='pending' AND h.updated_ms<=?
        AND (h.claim_token IS NULL OR h.claim_expires_ms<=?) AND ${current('h', options.admission)}`)
      .bind(token, now + leaseMs, now, key, prior.revision, prior.digest, now, now).run();
    if (!result.success || ![0, 1].includes(result.meta.changes)) throw corrupt();
    return result.meta.changes === 1 ? { token, revision: prior.revision, checkpoint: prior.checkpoint } : null;
  } catch (error) {
    const head = await load(options, key);
    if (head?.token === token) return { token, revision: head.revision, checkpoint: head.checkpoint };
    throw error;
  }
}
/** A successful response means this exact successor is durable. A lost commit
 * response is reconciled by content+revision; retries cannot append twice. */
export async function saveModelBlockJob(options: Scope & { claim: ModelBlockClaim; checkpoint: ModelBlockCheckpoint; now: number }): Promise<boolean> {
  const { target, identity, claim, checkpoint, now } = options;
  if (!safe(now) || !claimValid(claim, identity) || !validModelBlockCheckpoint(checkpoint, identity)
    || !nextValid(claim.checkpoint, checkpoint)) throw invalid();
  if (!historicalAllowed(options)) return false;
  const key = await modelBlockJobKey(identity), framed = await frame(checkpoint, identity);
  if (!await modelBlockStoreSupported(target)) return false;
  const matches = (head: Head | null) => !!head && head.revision === claim.revision + 1 && head.digest === framed.digest;
  try { await target.batch(saveStatements(options, key, framed, checkpoint, claim.revision, claim.token, now)); }
  catch (error) { if (matches(await load(options, key))) return true; throw error; }
  return matches(await load(options, key));
}
export async function releaseModelBlockJob(options: Scope & { claim: ModelBlockClaim; now: number }): Promise<boolean> {
  const { target, identity, claim, now } = options;
  if (!safe(now) || !claimValid(claim, identity)) throw invalid();
  const key = await modelBlockJobKey(identity);
  if (!await modelBlockStoreSupported(target)) return false;
  const result = await target.prepare(`UPDATE analytics_model_blocks AS h SET claim_token=NULL,claim_expires_ms=NULL,updated_ms=?
    WHERE h.job_key=? AND h.head_revision=? AND h.claim_token=? AND h.state='pending'
      AND h.updated_ms<=? AND ${current('h', options.admission)}`).bind(now, key, claim.revision, claim.token, now).run();
  if (!result.success) throw corrupt();
  return result.meta.changes === 1;
}

export interface ModelBlockRetirementResult {
  scanned: number;
  deletedJobs: number;
  cascadedParts: number;
  cascadedBytes: number;
  leasedJobs: number;
  nextAfterJobKey: string | null;
}

interface RetirementRow {
  job_key: string; identity_json: string; head_revision: number; checkpoint_digest: string | null;
  checkpoint_bytes: number; part_count: number; claim_token: string | null; claim_expires_ms: number | null;
  updated_ms: number; physical_parts: number; physical_bytes: number;
}

/** One metadata page only. Delete the parent under an exact head/lease CAS;
 * SQLite's FK cascade removes every committed part in the same statement. */
export async function retireModelBlockJobs(options: { target: D1Database; sourceId: string; ownerDigest: string;
  now: number; todayDay: string; currentIdentity: ModelBlockIdentity | null;
  admission?: ModelBlockAdmission; retiredMethods?: readonly string[];
  afterJobKey?: string; limit?: number }): Promise<ModelBlockRetirementResult> {
  const { target, sourceId, ownerDigest, now, todayDay, currentIdentity } = options;
  const limit = options.limit ?? MODEL_BLOCK_MAX_STORED_JOBS;
  if (!safe(now) || typeof sourceId !== 'string' || sourceId.length < 1 || sourceId.length > 256
    || !HEX.test(ownerDigest) || !Number.isSafeInteger(limit) || limit < 1 || limit > 16
    || options.afterJobKey !== undefined && !HEX.test(options.afterJobKey)
    || currentIdentity !== null && (!validModelBlockIdentity(currentIdentity)
      || currentIdentity.sourceId !== sourceId || currentIdentity.ownerDigest !== ownerDigest)
    || options.admission !== undefined && (options.admission.todayDay !== todayDay
      || !safe(options.admission.revision) || options.admission.revision < 1)
    || options.retiredMethods?.some(method => typeof method !== 'string' || method.length < 1 || method.length > 256))
    throw invalid();
  // Also validates the UTC day. The preview includes today, but only completed
  // dates are eligible for existing partial checkpoints.
  planHistoricalModelBlockRanges(todayDay);
  const firstDay = new Date(Date.parse(`${todayDay}T00:00:00.000Z`)
    - (MODEL_BLOCK_PREVIEW_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const empty: ModelBlockRetirementResult = { scanned: 0, deletedJobs: 0,
    cascadedParts: 0, cascadedBytes: 0, leasedJobs: 0, nextAfterJobKey: null };
  if (!await modelBlockStoreSupported(target)) return empty;
  const rows = await target.prepare(`SELECT h.job_key,h.identity_json,h.head_revision,h.checkpoint_digest,
    h.checkpoint_bytes,h.part_count,h.claim_token,h.claim_expires_ms,h.updated_ms,
    (SELECT COUNT(*) FROM analytics_model_block_parts p WHERE p.job_key=h.job_key) AS physical_parts,
    COALESCE((SELECT SUM(p.payload_bytes) FROM analytics_model_block_parts p WHERE p.job_key=h.job_key),0) AS physical_bytes
    FROM analytics_model_blocks h WHERE h.source_id=? AND h.owner_digest=? AND h.job_key>?
    ORDER BY h.job_key LIMIT ?`).bind(sourceId, ownerDigest, options.afterJobKey ?? '', limit)
    .all<RetirementRow>();
  if (!rows.success || !Array.isArray(rows.results)) throw corrupt();
  const result = { ...empty, scanned: rows.results.length,
    nextAfterJobKey: rows.results.length === limit ? rows.results.at(-1)!.job_key : null };
  const retiredMethods = new Set(options.retiredMethods ?? []);
  for (const row of rows.results) {
    let identity: Partial<ModelBlockIdentity>;
    try { identity = JSON.parse(row.identity_json) as Partial<ModelBlockIdentity>; } catch { throw corrupt(); }
    if (typeof identity.method !== 'string') throw corrupt();
    if (identity.method !== MODEL_BLOCK_METHOD && !retiredMethods.has(identity.method)) continue;
    if (identity.method === MODEL_BLOCK_METHOD && (!validModelBlockIdentity(identity)
      || identity.sourceId !== sourceId || identity.ownerDigest !== ownerDigest)) throw corrupt();
    // A newer method is never retired by an older binary unless explicitly
    // listed. An eligible partial old job remains resumable at any age.
    const sameAuthority = currentIdentity !== null && identity.method === currentIdentity.method
      && identity.sourceNamespace === currentIdentity.sourceNamespace
      && identity.ownerRevision === currentIdentity.ownerRevision
      && identity.authorityEpoch === currentIdentity.authorityEpoch
      && identity.inputRevision === currentIdentity.inputRevision
      && identity.authorityDigest === currentIdentity.authorityDigest;
    const eligibleRange = options.admission
      ? historicalModelBlockRangeEligible(identity as ModelBlockIdentity, todayDay)
      : typeof identity.outputFromDay === 'string' && typeof identity.outputThroughDay === 'string'
        && identity.outputFromDay >= firstDay && identity.outputThroughDay < todayDay
        && identity.outputThroughDay >= identity.outputFromDay;
    if (sameAuthority && eligibleRange && !retiredMethods.has(identity.method)) continue;
    if (row.claim_token !== null && row.claim_expires_ms !== null && row.claim_expires_ms > now) {
      result.leasedJobs++; continue;
    }
    if (![row.head_revision, row.checkpoint_bytes, row.part_count, row.updated_ms,
      row.physical_parts, row.physical_bytes].every(safe)) throw corrupt();
    const deleted = await target.prepare(`DELETE FROM analytics_model_blocks AS h
      WHERE h.job_key=? AND h.source_id=? AND h.owner_digest=? AND h.identity_json=?
        AND h.head_revision=? AND h.checkpoint_digest IS ? AND h.checkpoint_bytes=? AND h.part_count=?
        AND h.claim_token IS ? AND h.claim_expires_ms IS ? AND h.updated_ms=?
        AND (h.claim_token IS NULL OR h.claim_expires_ms<=?)
        AND ${options.admission ? `EXISTS(SELECT 1 FROM analytics_model_block_policy p
          WHERE p.source_id=h.source_id AND p.owner_digest=h.owner_digest
            AND p.policy_revision=${options.admission.revision} AND p.today_day='${todayDay}')`
        : `NOT EXISTS(SELECT 1 FROM analytics_model_block_policy p
          WHERE p.source_id=h.source_id AND p.owner_digest=h.owner_digest)`}
        RETURNING job_key`)
      .bind(row.job_key, sourceId, ownerDigest, row.identity_json, row.head_revision, row.checkpoint_digest,
        row.checkpoint_bytes, row.part_count, row.claim_token, row.claim_expires_ms, row.updated_ms, now)
      .all<{ job_key: string }>();
    if (!deleted.success || !Array.isArray(deleted.results) || deleted.results.length > 1
      || deleted.results.some(value => value.job_key !== row.job_key)) throw corrupt();
    if (deleted.results.length === 1) {
      result.deletedJobs++;
      result.cascadedParts += row.physical_parts;
      result.cascadedBytes += row.physical_bytes;
    }
  }
  return result;
}

export interface ModelBlockObsoletePageResult extends ModelBlockRetirementResult {
  policiesAdvanced: number;
}

/** Target-only capacity cleanup. It may narrow an existing policy to ranges
 * that remain eligible today; creating/expanding authority requires the source
 * proof in prepareModelBlockAdmission. No source payload or part body is read. */
export async function retireObsoleteModelBlockPage(options: { target: D1Database; sourceId: string;
  now: number; todayDay: string }): Promise<ModelBlockObsoletePageResult> {
  const { target, sourceId, now, todayDay } = options;
  if (!safe(now) || new Date(now).toISOString().slice(0, 10) !== todayDay
    || typeof sourceId !== 'string' || sourceId.length < 1 || sourceId.length > 256)
    throw invalid();
  const planned = planHistoricalModelBlockRanges(todayDay);
  const empty: ModelBlockObsoletePageResult = { scanned: 0, deletedJobs: 0,
    cascadedParts: 0, cascadedBytes: 0, leasedJobs: 0, nextAfterJobKey: null, policiesAdvanced: 0 };
  if (!await modelBlockStoreSupported(target)) return empty;
  await target.prepare(`INSERT INTO analytics_model_block_retirement_cursors(source_id)
    SELECT ? WHERE EXISTS(SELECT 1 FROM analytics_runtime_sources WHERE source_id=? AND contract_version=1)
    ON CONFLICT(source_id) DO NOTHING`).bind(sourceId, sourceId).run();
  const cursor = await target.prepare(`SELECT after_rowid,revision FROM analytics_model_block_retirement_cursors
    WHERE source_id=?`).bind(sourceId).first<{ after_rowid: number; revision: number }>();
  if (!cursor) return empty;
  if (!safe(cursor.after_rowid) || !safe(cursor.revision) || cursor.revision < 1) throw corrupt();
  // The source-only index stores rowid as its implicit final key. Filtering
  // obsolete rows happens AFTER this physical four-head page is acquired.
  const page = (after: number) => target.prepare(`SELECT h.rowid AS cursor_rowid,h.job_key,h.identity_json,
    h.head_revision,h.checkpoint_digest,h.checkpoint_bytes,h.part_count,h.claim_token,
    h.claim_expires_ms,h.updated_ms,
    (SELECT COUNT(*) FROM analytics_model_block_parts part WHERE part.job_key=h.job_key) AS physical_parts,
    COALESCE((SELECT SUM(part.payload_bytes) FROM analytics_model_block_parts part
      WHERE part.job_key=h.job_key),0) AS physical_bytes
    FROM analytics_model_blocks h INDEXED BY analytics_model_blocks_source_cursor
    WHERE h.source_id=? AND h.rowid>? ORDER BY h.rowid LIMIT ?`)
    .bind(sourceId, after, MODEL_BLOCK_MAX_STORED_JOBS)
    .all<RetirementRow & { cursor_rowid: number }>();
  let pageResult = await page(cursor.after_rowid);
  if (!pageResult.success || !Array.isArray(pageResult.results)) throw corrupt();
  if (pageResult.results.length === 0 && cursor.after_rowid > 0) {
    pageResult = await page(0);
    if (!pageResult.success || !Array.isArray(pageResult.results)) throw corrupt();
  }
  const rows = pageResult.results;
  empty.scanned = rows.length;
  const policyByOwner = new Map<string, number | null>();
  for (const row of rows) {
    let identity: unknown;
    try { identity = JSON.parse(row.identity_json); } catch { throw corrupt(); }
    if (!identity || typeof identity !== 'object') throw corrupt();
    const value = identity as Partial<ModelBlockIdentity>;
    const ownerDigest = value.ownerDigest;
    if (typeof ownerDigest !== 'string' || !HEX.test(ownerDigest) || value.sourceId !== sourceId) throw corrupt();
    if (policyByOwner.has(ownerDigest)) continue;
    const prior = await target.prepare(`SELECT policy_revision,source_namespace,owner_revision,authority_epoch,
      input_revision,method,authority_digest,today_day,range0_from,range0_through,range1_from,
      range1_through,range2_from,range2_through,range3_from,range3_through,updated_ms
      FROM analytics_model_block_policy WHERE source_id=? AND owner_digest=?`)
      .bind(sourceId, ownerDigest).first<PolicyRow & { updated_ms: number }>();
    if (!prior) { policyByOwner.set(ownerDigest, null); continue; }
    if (!safe(prior.policy_revision) || prior.policy_revision < 1 || !safe(prior.updated_ms)) throw corrupt();
    let revision = prior.policy_revision;
    if (prior.today_day < todayDay && prior.method === MODEL_BLOCK_METHOD && prior.updated_ms <= now) {
      const retained = [
        { outputFromDay: prior.range0_from, outputThroughDay: prior.range0_through },
        { outputFromDay: prior.range1_from, outputThroughDay: prior.range1_through },
        { outputFromDay: prior.range2_from, outputThroughDay: prior.range2_through },
        { outputFromDay: prior.range3_from, outputThroughDay: prior.range3_through },
      ].filter((range): range is { outputFromDay: string; outputThroughDay: string } =>
        range.outputFromDay !== null && range.outputThroughDay !== null &&
        planned.some(item => item.outputFromDay === range.outputFromDay
          && item.outputThroughDay === range.outputThroughDay));
      const nextRanges = Array.from({ length: MODEL_BLOCK_MAX_STORED_JOBS }, (_, index) =>
        [retained[index]?.outputFromDay ?? null, retained[index]?.outputThroughDay ?? null]).flat();
      const advanced = await target.prepare(`UPDATE analytics_model_block_policy AS p SET
        policy_revision=policy_revision+1,today_day=?,range0_from=?,range0_through=?,
        range1_from=?,range1_through=?,range2_from=?,range2_through=?,range3_from=?,range3_through=?,updated_ms=?
        WHERE p.source_id=? AND p.owner_digest=? AND p.policy_revision=? AND p.today_day=?
          AND p.updated_ms=? AND p.method=? AND p.source_namespace=? AND p.owner_revision=?
          AND p.authority_epoch=? AND p.input_revision=? AND p.authority_digest=?
          AND p.range0_from IS ? AND p.range0_through IS ? AND p.range1_from IS ? AND p.range1_through IS ?
          AND p.range2_from IS ? AND p.range2_through IS ? AND p.range3_from IS ? AND p.range3_through IS ?
          AND EXISTS(SELECT 1 FROM analytics_owner_state o JOIN analytics_runtime_sources r
            ON r.source_id=o.source_id WHERE o.source_id=p.source_id AND o.owner_digest=p.owner_digest
              AND o.state='active' AND o.revision=p.owner_revision AND o.authority_epoch=p.authority_epoch
              AND r.source_namespace=p.source_namespace AND r.contract_version=1
              AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
                WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest)) RETURNING policy_revision`)
        .bind(todayDay, ...nextRanges, now, sourceId, ownerDigest, prior.policy_revision,
          prior.today_day, prior.updated_ms, prior.method, prior.source_namespace, prior.owner_revision,
          prior.authority_epoch, prior.input_revision, prior.authority_digest,
          prior.range0_from, prior.range0_through, prior.range1_from, prior.range1_through,
          prior.range2_from, prior.range2_through, prior.range3_from, prior.range3_through)
        .all<{ policy_revision: number }>();
      if (!advanced.success || !Array.isArray(advanced.results) || advanced.results.length > 1) throw corrupt();
      if (advanced.results[0]) { revision = advanced.results[0].policy_revision; empty.policiesAdvanced++; }
    }
    policyByOwner.set(ownerDigest, revision);
  }
  // A stale owner revision is monotone on the target. For range cleanup,
  // require a previously source-fenced policy already advanced to today.
  const staleTarget = `(NOT EXISTS(SELECT 1 FROM analytics_owner_state o
      WHERE o.source_id=h.source_id AND o.owner_digest=h.owner_digest)
    OR EXISTS(SELECT 1 FROM analytics_owner_state o WHERE o.source_id=h.source_id
      AND o.owner_digest=h.owner_digest AND (o.state!='active' OR o.authority_epoch!=h.authority_epoch
        OR o.revision>json_extract(h.identity_json,'$.ownerRevision')))
    OR EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=h.source_id
      AND f.owner_digest=h.owner_digest)
    OR NOT EXISTS(SELECT 1 FROM analytics_runtime_sources r WHERE r.source_id=h.source_id
      AND r.contract_version=1 AND r.source_namespace=h.source_namespace))`;
  const expiredRange = `(h.admission_revision IS NOT NULL AND EXISTS(
    SELECT 1 FROM analytics_model_block_policy p WHERE p.source_id=h.source_id
      AND p.owner_digest=h.owner_digest AND p.method='${MODEL_BLOCK_METHOD}'
      AND p.today_day='${todayDay}' AND NOT COALESCE((
        (p.range0_from=json_extract(h.identity_json,'$.outputFromDay')
          AND p.range0_through=json_extract(h.identity_json,'$.outputThroughDay'))
        OR (p.range1_from=json_extract(h.identity_json,'$.outputFromDay')
          AND p.range1_through=json_extract(h.identity_json,'$.outputThroughDay'))
        OR (p.range2_from=json_extract(h.identity_json,'$.outputFromDay')
          AND p.range2_through=json_extract(h.identity_json,'$.outputThroughDay'))
        OR (p.range3_from=json_extract(h.identity_json,'$.outputFromDay')
          AND p.range3_through=json_extract(h.identity_json,'$.outputThroughDay'))),0)))`;
  const obsolete = `(${staleTarget} OR ${expiredRange})`;
  for (const row of rows) {
    let identity: unknown;
    try { identity = JSON.parse(row.identity_json); } catch { throw corrupt(); }
    if (!identity || typeof identity !== 'object'
      || (identity as Partial<ModelBlockIdentity>).method !== MODEL_BLOCK_METHOD) continue;
    if (!validModelBlockIdentity(identity) || identity.sourceId !== sourceId || !safe(row.cursor_rowid)
      || ![row.head_revision, row.checkpoint_bytes, row.part_count, row.updated_ms,
        row.physical_parts, row.physical_bytes].every(safe)) throw corrupt();
    const policyRevision = policyByOwner.get(identity.ownerDigest) ?? null;
    if (row.claim_token !== null && row.claim_expires_ms !== null && row.claim_expires_ms > now) {
      empty.leasedJobs++; continue;
    }
    const policyCAS = policyRevision === null
      ? `NOT EXISTS(SELECT 1 FROM analytics_model_block_policy p WHERE p.source_id=h.source_id
          AND p.owner_digest=h.owner_digest)`
      : `EXISTS(SELECT 1 FROM analytics_model_block_policy p WHERE p.source_id=h.source_id
          AND p.owner_digest=h.owner_digest AND p.policy_revision=${policyRevision})`;
    const deleted = await target.prepare(`DELETE FROM analytics_model_blocks AS h WHERE h.job_key=?
      AND h.source_id=? AND h.owner_digest=? AND h.identity_json=? AND h.head_revision=?
      AND h.checkpoint_digest IS ? AND h.checkpoint_bytes=? AND h.part_count=?
      AND h.claim_token IS ? AND h.claim_expires_ms IS ? AND h.updated_ms=?
      AND (h.claim_token IS NULL OR h.claim_expires_ms<=?) AND ${policyCAS}
      AND json_extract(h.identity_json,'$.method')=? AND ${obsolete} RETURNING job_key`)
      .bind(row.job_key, sourceId, identity.ownerDigest, row.identity_json, row.head_revision,
        row.checkpoint_digest, row.checkpoint_bytes, row.part_count, row.claim_token,
        row.claim_expires_ms, row.updated_ms, now, MODEL_BLOCK_METHOD)
      .all<{ job_key: string }>();
    if (!deleted.success || !Array.isArray(deleted.results) || deleted.results.length > 1
      || deleted.results.some(value => value.job_key !== row.job_key)) throw corrupt();
    if (deleted.results.length === 1) {
      empty.deletedJobs++;
      empty.cascadedParts += row.physical_parts;
      empty.cascadedBytes += row.physical_bytes;
    }
  }
  const nextRowid = rows.length === MODEL_BLOCK_MAX_STORED_JOBS ? rows.at(-1)!.cursor_rowid : 0;
  if (!safe(nextRowid)) throw corrupt();
  const moved = await target.prepare(`UPDATE analytics_model_block_retirement_cursors SET
    after_rowid=?,revision=revision+1 WHERE source_id=? AND revision=? AND after_rowid=?`)
    .bind(nextRowid, sourceId, cursor.revision, cursor.after_rowid).run();
  if (!moved.success || ![0, 1].includes(moved.meta.changes)) throw corrupt();
  return empty;
}
