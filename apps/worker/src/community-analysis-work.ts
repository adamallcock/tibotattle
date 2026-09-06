import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import {
  validateV1QuotaWorkControl,
  validateV1QuotaWorkPart,
  type V1QuotaWorkControl,
  type V1QuotaWorkComponent,
  validateV1QuotaPageReplay,
  type V1QuotaPageReplay,
} from "./quota-analysis-v1-reader";

/** Private derived work only. These bounds never truncate analytical evidence:
 * a caller must defer/refuse explicitly if it cannot represent a checkpoint. */
export const COMMUNITY_ANALYSIS_PART_BYTES = 128 * 1024;
export const COMMUNITY_ANALYSIS_CONTROL_BYTES = 16 * 1024;
export const COMMUNITY_ANALYSIS_MAX_PARTS = 1024;
export const COMMUNITY_ANALYSIS_PARTS_PER_READ = 8;
export const COMMUNITY_ANALYSIS_MUTATIONS_PER_COMMIT = 32;
export const COMMUNITY_ANALYSIS_BATCH_BYTES = COMMUNITY_ANALYSIS_PART_BYTES * COMMUNITY_ANALYSIS_MUTATIONS_PER_COMMIT;
const COMPONENTS = ["plan-anchors", "plan-runs", "plan-equal-time", "fit-stats", "eligible", "endpoint-runs", "endpoints"] as const;
const HASH = /^[a-f0-9]{64}$/u;
const RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const encoder = new TextEncoder();

export interface CommunityAnalysisWorkIdentity {
  participantId: string;
  inputRevision: number;
  inputFingerprint: string;
  sourceKind: "v1";
  sourceMethodVersion: string;
  fixedNow: string;
  observedAtCutoff: string;
  resetsAtCutoff: string;
  windowMinutes: number;
  maxQuotaRows: number;
}
export interface CommunityAnalysisWorkBudget {
  /** The SAME mutable budget used by all accounts and acquisition queries. */
  remainingQueries: number;
  deadlineMs: number;
  now?: () => number;
  /** Queries held back for caller source-pin/final publication checks. */
  reserveQueries?: number;
}
export interface CommunityAnalysisPartReference {
  component: V1QuotaWorkComponent;
  partKey: number;
  sha256: string;
  bytes: number;
}
export interface CommunityAnalysisWorkHead {
  identity: CommunityAnalysisWorkIdentity;
  runId: string;
  progressRevision: number;
  phase: "plan" | "fitability" | "endpoints" | "complete";
  control: V1QuotaWorkControl;
  manifest: CommunityAnalysisPartReference[];
}
export type CommunityAnalysisWorkPartMutation =
  | { component: V1QuotaWorkComponent; partKey: number; value: unknown }
  | { component: V1QuotaWorkComponent; partKey: number; remove: true };
export type CommunityAnalysisWorkRead =
  | { status: "ready"; head: CommunityAnalysisWorkHead }
  | { status: "absent" | "stale" | "corrupt" | "deferred" };

/** Frame closed normalized components deterministically and return ONLY changed
 * chunks. A phase transition larger than the atomic page bound needs a staging
 * manifest; it is explicitly deferred, never partially committed/promoted. */
export async function prepareCommunityAnalysisWorkDelta(head: CommunityAnalysisWorkHead, components: unknown): Promise<
  | { status: "ready"; parts: CommunityAnalysisWorkPartMutation[] }
  | { status: "deferred"; reason: "checkpoint_staging_required" }> {
  validateHead(head);
  if (!record(components) || !exactKeys(components, COMPONENTS)) invalid();
  const previous = new Map(head.manifest.map(part => [`${part.component}:${part.partKey}`, part]));
  const parts: CommunityAnalysisWorkPartMutation[] = [];
  let totalParts = 0;
  for (const component of COMPONENTS) {
    const entries = components[component];
    if (!Array.isArray(entries) || !validateV1QuotaWorkPart(component, entries)) invalid();
    let chunk: unknown[] = [], bytes = 2, partKey = 0;
    const emit = async (): Promise<boolean> => {
      const json = canonicalJson(chunk), sha256 = await sha256Hex(json);
      const key = `${component}:${partKey}`, prior = previous.get(key);
      if (!prior || prior.sha256 !== sha256 || prior.bytes !== bytes) parts.push({ component, partKey, value: chunk });
      previous.delete(key); partKey += 1; totalParts += 1;
      chunk = []; bytes = 2;
      return parts.length <= COMMUNITY_ANALYSIS_MUTATIONS_PER_COMMIT && totalParts <= COMMUNITY_ANALYSIS_MAX_PARTS;
    };
    for (const entry of entries) {
      const entryBytes = encoder.encode(canonicalJson(entry)).byteLength;
      if (entryBytes + 2 > COMMUNITY_ANALYSIS_PART_BYTES) invalid();
      if (bytes + entryBytes + (chunk.length > 0 ? 1 : 0) > COMMUNITY_ANALYSIS_PART_BYTES && !await emit()) {
        return { status: "deferred", reason: "checkpoint_staging_required" };
      }
      bytes += entryBytes + (chunk.length > 0 ? 1 : 0);
      chunk.push(entry);
    }
    if (chunk.length > 0 && !await emit()) return { status: "deferred", reason: "checkpoint_staging_required" };
  }
  for (const old of previous.values()) {
    parts.push({ component: old.component, partKey: old.partKey, remove: true });
    if (parts.length > COMMUNITY_ANALYSIS_MUTATIONS_PER_COMMIT) return { status: "deferred", reason: "checkpoint_staging_required" };
  }
  return { status: "ready", parts };
}

function invalid(): never { throw new Error("community analysis work invalid"); }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER - 1): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function iso(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}
function validateIdentity(value: unknown): asserts value is CommunityAnalysisWorkIdentity {
  if (!record(value) || !exactKeys(value, ["participantId", "inputRevision", "inputFingerprint", "sourceKind", "sourceMethodVersion", "fixedNow", "observedAtCutoff", "resetsAtCutoff", "windowMinutes", "maxQuotaRows"])
    || typeof value.participantId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/u.test(value.participantId)
    || !integer(value.inputRevision) || typeof value.inputFingerprint !== "string" || !HASH.test(value.inputFingerprint) || value.sourceKind !== "v1"
    || typeof value.sourceMethodVersion !== "string" || !/^[a-zA-Z0-9_.:+-]{1,2048}$/u.test(value.sourceMethodVersion)
    || !iso(value.fixedNow) || !iso(value.observedAtCutoff) || !iso(value.resetsAtCutoff)
    || !integer(value.windowMinutes, 1) || !integer(value.maxQuotaRows, 1, 60000)) invalid();
}
function component(value: unknown): value is V1QuotaWorkComponent {
  return typeof value === "string" && COMPONENTS.some(item => item === value);
}
function partOrder(a: Pick<CommunityAnalysisPartReference, "component" | "partKey">,
  b: Pick<CommunityAnalysisPartReference, "component" | "partKey">): number {
  return a.component < b.component ? -1 : a.component > b.component ? 1 : a.partKey - b.partKey;
}
function validateManifest(value: unknown): value is CommunityAnalysisPartReference[] {
  return Array.isArray(value) && value.length <= COMMUNITY_ANALYSIS_MAX_PARTS && value.every((item: unknown, index) => {
    if (!record(item) || !exactKeys(item, ["component", "partKey", "sha256", "bytes"])
      || !component(item.component) || !integer(item.partKey, 0, 1023)
      || typeof item.sha256 !== "string" || !HASH.test(item.sha256)
      || !integer(item.bytes, 1, COMMUNITY_ANALYSIS_PART_BYTES)) return false;
    return index === 0 || partOrder(value[index - 1], { component: item.component, partKey: item.partKey }) < 0;
  });
}
function encodeControl(control: V1QuotaWorkControl): string {
  if (!validateV1QuotaWorkControl(control)) invalid();
  const json = canonicalJson(control);
  if (encoder.encode(json).byteLength > COMMUNITY_ANALYSIS_CONTROL_BYTES) invalid();
  return json;
}
function encodeManifest(manifest: CommunityAnalysisPartReference[]): string {
  if (!validateManifest(manifest)) invalid();
  const json = canonicalJson(manifest);
  if (encoder.encode(json).byteLength > COMMUNITY_ANALYSIS_PART_BYTES) invalid();
  return json;
}
function spend(budget: CommunityAnalysisWorkBudget, count: number): boolean {
  const reserve = budget.reserveQueries ?? 0;
  if (!integer(budget.remainingQueries) || !integer(reserve) || !Number.isFinite(budget.deadlineMs)) invalid();
  if (budget.remainingQueries - reserve < count || (budget.now ?? Date.now)() >= budget.deadlineMs) return false;
  budget.remainingQueries -= count;
  return true;
}
function identityEqual(a: CommunityAnalysisWorkIdentity, b: CommunityAnalysisWorkIdentity): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function headEqual(a: CommunityAnalysisWorkHead, b: CommunityAnalysisWorkHead): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
function phaseValid(phase: CommunityAnalysisWorkHead["phase"], control: V1QuotaWorkControl): boolean {
  return phase === control.phase || (phase === "complete" && control.phase === "endpoints");
}
function validateHead(head: CommunityAnalysisWorkHead): void {
  if (!record(head) || !exactKeys(head, ["identity", "runId", "progressRevision", "phase", "control", "manifest"])) invalid();
  validateIdentity(head.identity);
  encodeControl(head.control); encodeManifest(head.manifest);
  if (typeof head.runId !== "string" || !RUN_ID.test(head.runId) || !integer(head.progressRevision) || !phaseValid(head.phase, head.control)) invalid();
}

const SOURCE_GUARD = `EXISTS (SELECT 1 FROM participants p
  JOIN community_analytical_input_versions v ON v.participant_id = p.id
  WHERE p.id = ? AND p.state = 'active' AND v.revision = ?
    AND NOT EXISTS (SELECT 1 FROM telemetry_v11_domain_heads d WHERE d.participant_id=p.id))`;
const WORK_GUARD = `EXISTS (SELECT 1 FROM community_analysis_work h
  JOIN participants p ON p.id = h.participant_id
  JOIN community_analytical_input_versions v ON v.participant_id = p.id
  WHERE h.participant_id = ? AND h.run_id = ? AND h.progress_revision = ?
    AND h.input_revision = ? AND h.input_fingerprint = ?
    AND h.source_kind = ? AND h.source_method_version = ? AND h.fixed_now = ?
    AND h.observed_at_cutoff = ? AND h.resets_at_cutoff = ? AND h.window_minutes = ? AND h.max_quota_rows = ?
    AND h.state_sha256 = ?
    AND p.state = 'active' AND v.revision = h.input_revision
    AND NOT EXISTS (SELECT 1 FROM telemetry_v11_domain_heads d WHERE d.participant_id=p.id))`;
async function guardValues(head: CommunityAnalysisWorkHead): Promise<unknown[]> {
  const i = head.identity;
  return [i.participantId, head.runId, head.progressRevision, i.inputRevision, i.inputFingerprint,
    i.sourceKind, i.sourceMethodVersion, i.fixedNow, i.observedAtCutoff, i.resetsAtCutoff, i.windowMinutes, i.maxQuotaRows,
    await sha256Hex(canonicalJson(head))];
}

/** Start an empty run. Replacing old work requires its exact run/progress token.
 * The conditional delete and insert are atomic; late workers cannot resurrect
 * an erased participant or steal newer work. The caller has verified its source pin. */
export async function beginCommunityAnalysisWork(db: D1Database, identity: CommunityAnalysisWorkIdentity,
  control: V1QuotaWorkControl, budget: CommunityAnalysisWorkBudget,
  replace?: { runId: string; progressRevision: number }): Promise<CommunityAnalysisWorkRead> {
  validateIdentity(identity);
  const controlJson = encodeControl(control);
  if (control.phase !== "plan" || control.planTime !== null || control.reset !== null || control.cursor.id !== 0
    || control.cursor.observedAt !== identity.observedAtCutoff || control.cursor.resetsAt !== identity.resetsAtCutoff
    || (replace && (!RUN_ID.test(replace.runId) || !integer(replace.progressRevision)))) invalid();
  const runId = crypto.randomUUID();
  const head: CommunityAnalysisWorkHead = { identity: { ...identity }, runId, progressRevision: 0,
    phase: "plan", control, manifest: [] };
  const stateHash = await sha256Hex(canonicalJson(head));
  const statements: D1PreparedStatement[] = [];
  if (replace) statements.push(db.prepare(`DELETE FROM community_analysis_work
    WHERE participant_id = ? AND run_id = ? AND progress_revision = ? AND ${SOURCE_GUARD}
      AND NOT EXISTS (SELECT 1 FROM community_analysis_work_parts WHERE participant_id=community_analysis_work.participant_id)
      AND NOT EXISTS (SELECT 1 FROM community_analysis_work_stage WHERE participant_id=community_analysis_work.participant_id)`)
    .bind(identity.participantId, replace.runId, replace.progressRevision, identity.participantId, identity.inputRevision));
  statements.push(db.prepare(`INSERT INTO community_analysis_work
    (participant_id,run_id,input_revision,input_fingerprint,source_kind,source_method_version,fixed_now,
     observed_at_cutoff,resets_at_cutoff,window_minutes,max_quota_rows,phase,progress_revision,control_json,manifest_json,state_sha256)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,'plan',0,?,'[]',?
    WHERE ${SOURCE_GUARD} AND NOT EXISTS (SELECT 1 FROM community_analysis_work WHERE participant_id = ?)`)
    .bind(identity.participantId, runId, identity.inputRevision, identity.inputFingerprint, identity.sourceKind,
      identity.sourceMethodVersion, identity.fixedNow, identity.observedAtCutoff, identity.resetsAtCutoff,
      identity.windowMinutes, identity.maxQuotaRows, controlJson, stateHash, identity.participantId, identity.inputRevision, identity.participantId));
  if (!spend(budget, statements.length)) return { status: "deferred" };
  const results = await db.batch(statements);
  if (results.at(-1)?.meta.changes !== 1) return { status: "stale" };
  return { status: "ready", head };
}

async function readHead(db: D1Database, identity: Pick<CommunityAnalysisWorkIdentity, "participantId" | "inputRevision">,
  inspectStale = false): Promise<CommunityAnalysisWorkRead> {
  const row = await db.prepare(`SELECT h.*,p.state AS participant_state,v.revision AS current_input_revision,
    EXISTS(SELECT 1 FROM telemetry_v11_domain_heads d WHERE d.participant_id=p.id) AS successor_active
    FROM community_analysis_work h JOIN participants p ON p.id=h.participant_id
    JOIN community_analytical_input_versions v ON v.participant_id=h.participant_id WHERE h.participant_id=?`)
    .bind(identity.participantId).first<Record<string, unknown>>();
  if (!row) return { status: "absent" };
  if (row.participant_state !== "active" || row.current_input_revision !== identity.inputRevision || (!inspectStale && row.successor_active !== 0)) return { status: "stale" };
  try {
    const storedIdentity = { participantId: row.participant_id, inputRevision: row.input_revision,
      inputFingerprint: row.input_fingerprint, sourceKind: row.source_kind, sourceMethodVersion: row.source_method_version,
      fixedNow: row.fixed_now, observedAtCutoff: row.observed_at_cutoff, resetsAtCutoff: row.resets_at_cutoff,
      windowMinutes: row.window_minutes, maxQuotaRows: row.max_quota_rows };
    // The projection is untrusted until all fields pass the same closed input validator.
    validateIdentity(storedIdentity);
    if (!inspectStale && canonicalJson(identity) !== canonicalJson(storedIdentity)) return { status: "stale" };
    if (typeof row.control_json !== "string" || typeof row.manifest_json !== "string"
      || encoder.encode(row.control_json).byteLength > COMMUNITY_ANALYSIS_CONTROL_BYTES
      || encoder.encode(row.manifest_json).byteLength > COMMUNITY_ANALYSIS_PART_BYTES) return { status: "corrupt" };
    const control: unknown = JSON.parse(row.control_json), manifest: unknown = JSON.parse(row.manifest_json);
    if (!validateV1QuotaWorkControl(control) || !validateManifest(manifest)
      || typeof row.run_id !== "string" || !RUN_ID.test(row.run_id) || !integer(row.progress_revision)
      || !["plan", "fitability", "endpoints", "complete"].includes(String(row.phase))) return { status: "corrupt" };
    const head: CommunityAnalysisWorkHead = { identity: storedIdentity,
      runId: row.run_id, progressRevision: row.progress_revision,
      phase: row.phase as CommunityAnalysisWorkHead["phase"], control, manifest };
    if (!phaseValid(head.phase, control) || typeof row.state_sha256 !== "string"
      || !HASH.test(row.state_sha256) || await sha256Hex(canonicalJson(head)) !== row.state_sha256) return { status: "corrupt" };
    return { status: "ready", head };
  } catch { return { status: "corrupt" }; }
}

/** This does not certify completeness: read every manifest part with the page
 * reader, then have the quota codec validate the reconstructed checkpoint. */
export async function readCommunityAnalysisWork(db: D1Database, identity: CommunityAnalysisWorkIdentity,
  budget: CommunityAnalysisWorkBudget): Promise<CommunityAnalysisWorkRead> {
  validateIdentity(identity);
  if (!spend(budget, 1)) return { status: "deferred" };
  return readHead(db, identity);
}

export async function readCommunityAnalysisWorkParts(db: D1Database, head: CommunityAnalysisWorkHead,
  offset: number, budget: CommunityAnalysisWorkBudget): Promise<
    | { status: "ready"; parts: Array<{ component: V1QuotaWorkComponent; partKey: number; value: unknown }>; nextOffset: number; done: boolean }
    | { status: "stale" | "corrupt" | "deferred" }> {
  validateHead(head);
  if (!integer(offset, 0, head.manifest.length)) invalid();
  if (!spend(budget, 3)) return { status: "deferred" };
  const before = await readHead(db, head.identity);
  if (before.status !== "ready" || !headEqual(before.head, head)) return { status: before.status === "corrupt" ? "corrupt" : "stale" };
  const wanted = head.manifest.slice(offset, offset + COMMUNITY_ANALYSIS_PARTS_PER_READ);
  const result = await readPartRows(db, head, wanted);
  const after = await readHead(db, head.identity);
  if (after.status !== "ready" || !headEqual(after.head, head)) return { status: after.status === "corrupt" ? "corrupt" : "stale" };
  if (result.length !== wanted.length) return { status: "corrupt" };
  const parts: Array<{ component: V1QuotaWorkComponent; partKey: number; value: unknown }> = [];
  for (let index = 0; index < wanted.length; index++) {
    const expected = wanted[index]!, row = result[index]!;
    if (row.component !== expected.component || row.part_key !== expected.partKey || row.payload_sha256 !== expected.sha256
      || row.payload_bytes !== expected.bytes || typeof row.payload_json !== "string"
      || encoder.encode(row.payload_json).byteLength !== expected.bytes || await sha256Hex(row.payload_json) !== expected.sha256) return { status: "corrupt" };
    try {
      const value: unknown = JSON.parse(row.payload_json);
      if (!validateV1QuotaWorkPart(expected.component, value)) return { status: "corrupt" };
      parts.push({ component: expected.component, partKey: expected.partKey, value });
    } catch { return { status: "corrupt" }; }
  }
  const nextOffset = offset + wanted.length;
  return { status: "ready", parts, nextOffset, done: nextOffset === head.manifest.length };
}

/** Changed chunks only, never the whole checkpoint. Every mutation checks the
 * SAME old source/run/progress fence. The head advances LAST in the atomic batch;
 * a failed statement rolls back every part and a stale writer changes nothing. */
export async function commitCommunityAnalysisWorkPage(db: D1Database, head: CommunityAnalysisWorkHead,
  change: { control: V1QuotaWorkControl; phase: CommunityAnalysisWorkHead["phase"]; parts: CommunityAnalysisWorkPartMutation[] },
  budget: CommunityAnalysisWorkBudget): Promise<CommunityAnalysisWorkRead> {
  validateHead(head);
  if (!record(change) || !exactKeys(change, ["control", "phase", "parts"]) || !Array.isArray(change.parts)) invalid();
  const controlJson = encodeControl(change.control);
  const phases = ["plan", "fitability", "endpoints", "complete"];
  if (head.phase === "complete" || !phaseValid(change.phase, change.control)
    || phases.indexOf(change.phase) < phases.indexOf(head.phase) || head.progressRevision >= Number.MAX_SAFE_INTEGER - 1) invalid();
  if (change.parts.length > COMMUNITY_ANALYSIS_MUTATIONS_PER_COMMIT) return { status: "deferred" };
  const manifest = new Map(head.manifest.map(part => [`${part.component}:${part.partKey}`, part]));
  const seen = new Set<string>(), statements: D1PreparedStatement[] = [];
  const guard = `${WORK_GUARD} AND NOT EXISTS (SELECT 1 FROM community_analysis_work_stage WHERE participant_id=?)`;
  const values = [...await guardValues(head), head.identity.participantId];
  for (const part of change.parts) {
    if (!record(part) || !component(part.component) || !integer(part.partKey, 0, 1023)) invalid();
    const key = `${part.component}:${part.partKey}`;
    if (seen.has(key)) invalid();
    seen.add(key);
    if ("remove" in part) {
      if (part.remove !== true || Object.keys(part).length !== 3) invalid();
      manifest.delete(key);
    } else {
      if (Object.keys(part).length !== 3 || !validateV1QuotaWorkPart(part.component, part.value)) invalid();
      const json = canonicalJson(part.value), bytes = encoder.encode(json).byteLength;
      if (bytes > COMMUNITY_ANALYSIS_PART_BYTES) invalid();
      const sha256 = await sha256Hex(json);
      manifest.set(key, { component: part.component, partKey: part.partKey, sha256, bytes });
      statements.push(db.prepare(`INSERT INTO community_analysis_work_parts
        (participant_id,run_id,component,payload_json,payload_sha256,payload_bytes)
        SELECT ?,?,?,?,?,? WHERE ${guard} ON CONFLICT DO NOTHING`)
        .bind(head.identity.participantId, head.runId, part.component, json, sha256, bytes, ...values));
    }
  }
  const nextManifest = [...manifest.values()].sort(partOrder), manifestJson = encodeManifest(nextManifest);
  const live = new Set(nextManifest.map(part => `${part.component}:${part.sha256}`));
  const obsolete = new Map(head.manifest.filter(part => !live.has(`${part.component}:${part.sha256}`))
    .map(part => [`${part.component}:${part.sha256}`, part]));
  for (const part of obsolete.values()) statements.push(db.prepare(`DELETE FROM community_analysis_work_parts
    WHERE participant_id=? AND run_id=? AND component=? AND payload_sha256=? AND ${guard}`)
    .bind(head.identity.participantId, head.runId, part.component, part.sha256, ...values));
  const nextHead: CommunityAnalysisWorkHead = { ...head, progressRevision: head.progressRevision + 1,
    control: change.control, phase: change.phase, manifest: nextManifest };
  const stateHash = await sha256Hex(canonicalJson(nextHead));
  statements.push(db.prepare(`UPDATE community_analysis_work SET phase=?,progress_revision=progress_revision+1,
    control_json=?,manifest_json=?,state_sha256=? WHERE participant_id=? AND ${guard}`)
    .bind(change.phase, controlJson, manifestJson, stateHash, head.identity.participantId, ...values));
  if (!spend(budget, statements.length)) return { status: "deferred" };
  const results = await db.batch(statements);
  if (results.at(-1)?.meta.changes !== 1) return { status: "stale" };
  return { status: "ready", head: nextHead };
}

async function readPartRows(db: D1Database, head: CommunityAnalysisWorkHead,
  wanted: CommunityAnalysisPartReference[]): Promise<Record<string, unknown>[]> {
  if (wanted.length > COMMUNITY_ANALYSIS_PARTS_PER_READ) invalid();
  const values: unknown[] = [];
  for (let ordinal = 0; ordinal < wanted.length; ordinal++) {
    const part = wanted[ordinal]!;
    values.push(ordinal, part.component, part.partKey, part.sha256);
  }
  if (wanted.length === 0) return (await db.prepare("SELECT component FROM community_analysis_work_parts WHERE 0").all<Record<string, unknown>>()).results;
  return (await db.prepare(`WITH wanted(ordinal,component,part_key,sha256) AS (VALUES ${wanted.map(() => "(?,?,?,?)").join(",")})
    SELECT p.component,w.part_key,p.payload_json,p.payload_sha256,p.payload_bytes
    FROM wanted w JOIN community_analysis_work_parts p ON p.participant_id=? AND p.run_id=?
      AND p.component=w.component AND p.payload_sha256=w.sha256 ORDER BY w.ordinal`)
    .bind(...values, head.identity.participantId, head.runId).all<Record<string, unknown>>()).results;
}

type WorkPhase = CommunityAnalysisWorkHead["phase"];
export interface CommunityAnalysisStageTarget {
  phase: WorkPhase;
  control: V1QuotaWorkControl;
  components: unknown;
}
export interface CommunityAnalysisWorkStage {
  stageId: string;
  baseProgressRevision: number;
  revision: number;
  mode: "writing" | "verifying" | "garbage_collecting" | "discarding";
  target: { phase: WorkPhase; control: V1QuotaWorkControl; manifest: CommunityAnalysisPartReference[]; stateSha256: string };
  writeManifest: CommunityAnalysisPartReference[];
  replay: V1QuotaPageReplay | CommunityAnalysisSupersession | null;
  writeOffset: number;
  verifiedOffset: number;
  gcCursor: { component: string; sha256: string };
  discardInputRevision: number | null;
}
interface CommunityAnalysisSupersession {
  version: "community-analysis-supersession-1";
  replacementIdentity: CommunityAnalysisWorkIdentity;
}
export type CommunityAnalysisStageResult =
  | { status: "ready"; stage: CommunityAnalysisWorkStage }
  | { status: "absent" | "stale" | "corrupt" | "deferred" | "replay_unresolved" };

/** Only the current frame's strings are live. Callers may retain metadata or a
 * bounded selected page, never the complete serialized target. */
async function* frameComponents(components: unknown): AsyncGenerator<{ reference: CommunityAnalysisPartReference; json: string }> {
  if (!record(components) || !exactKeys(components, COMPONENTS)) invalid();
  let count = 0;
  for (const component of COMPONENTS) {
    const entries = components[component];
    if (!Array.isArray(entries) || !validateV1QuotaWorkPart(component, entries)) invalid();
    let fragments: string[] = [], bytes = 2, partKey = 0;
    const flush = async () => {
      if (++count > COMMUNITY_ANALYSIS_MAX_PARTS || partKey > 1023) invalid();
      const json = `[${fragments.join(",")}]`;
      const reference = { component, partKey: partKey++, sha256: await sha256Hex(json), bytes };
      fragments = []; bytes = 2;
      return { reference, json };
    };
    for (const entry of entries) {
      const json = canonicalJson(entry), size = encoder.encode(json).byteLength;
      if (size + 2 > COMMUNITY_ANALYSIS_PART_BYTES) invalid();
      if (bytes + size + (fragments.length ? 1 : 0) > COMMUNITY_ANALYSIS_PART_BYTES) yield await flush();
      bytes += size + (fragments.length ? 1 : 0); fragments.push(json);
    }
    if (fragments.length) yield await flush();
  }
}
function digestKey(reference: CommunityAnalysisPartReference): string { return `${reference.component}:${reference.sha256}`; }
function targetHead(head: CommunityAnalysisWorkHead, stage: CommunityAnalysisWorkStage): CommunityAnalysisWorkHead {
  return { ...head, progressRevision: stage.baseProgressRevision + 1,
    phase: stage.target.phase, control: stage.target.control, manifest: stage.target.manifest };
}
function replayMatches(head: CommunityAnalysisWorkHead, target: Pick<CommunityAnalysisStageTarget, "phase" | "control">,
  replay: unknown): replay is V1QuotaPageReplay {
  if (!validateV1QuotaPageReplay(replay)
    || canonicalJson(replay.from) !== canonicalJson({ phase: head.phase, cursor: head.control.cursor })
    || canonicalJson(replay.through) !== canonicalJson({ phase: target.phase, cursor: target.control.cursor })) return false;
  const phases = ["plan", "fitability", "endpoints", "complete"];
  const advance = phases.indexOf(replay.through.phase) - phases.indexOf(replay.from.phase);
  if (advance < 0 || advance > 1) return false;
  if (advance === 1) return true;
  const before = replay.from.cursor, after = replay.through.cursor;
  if (replay.from.phase !== "plan" && before.resetsAt !== after.resetsAt) return before.resetsAt < after.resetsAt;
  return before.observedAt < after.observedAt || (before.observedAt === after.observedAt && before.id < after.id);
}
async function stageHash(head: CommunityAnalysisWorkHead, stage: CommunityAnalysisWorkStage): Promise<string> {
  return sha256Hex(canonicalJson({ identity: head.identity, runId: head.runId, stage }));
}
function supersedes(head: CommunityAnalysisWorkHead, replacement: CommunityAnalysisWorkIdentity): boolean {
  return replacement.participantId === head.identity.participantId
    && replacement.inputRevision === head.identity.inputRevision
    && (["sourceMethodVersion", "observedAtCutoff", "resetsAtCutoff", "windowMinutes", "maxQuotaRows"] as const)
      .some(key => replacement[key] !== head.identity[key]);
}
function supersessionValid(head: CommunityAnalysisWorkHead, value: unknown): value is CommunityAnalysisSupersession {
  if (!record(value) || !exactKeys(value, ["version", "replacementIdentity"])
    || value.version !== "community-analysis-supersession-1") return false;
  validateIdentity(value.replacementIdentity);
  return supersedes(head, value.replacementIdentity);
}
async function validateStage(head: CommunityAnalysisWorkHead, stage: CommunityAnalysisWorkStage): Promise<void> {
  validateHead(head);
  if (!record(stage) || !exactKeys(stage, ["stageId", "baseProgressRevision", "revision", "mode", "target", "writeManifest", "replay", "writeOffset", "verifiedOffset", "gcCursor", "discardInputRevision"])
    || typeof stage.stageId !== "string" || !RUN_ID.test(stage.stageId) || !integer(stage.baseProgressRevision, 0, Number.MAX_SAFE_INTEGER - 2)
    || !integer(stage.revision) || !["writing", "verifying", "garbage_collecting", "discarding"].includes(stage.mode)
    || !record(stage.target) || !exactKeys(stage.target, ["phase", "control", "manifest", "stateSha256"])
    || !record(stage.gcCursor) || !exactKeys(stage.gcCursor, ["component", "sha256"])
    || typeof stage.gcCursor.component !== "string" || typeof stage.gcCursor.sha256 !== "string"
    || (stage.gcCursor.component !== "" && !component(stage.gcCursor.component))
    || (stage.gcCursor.sha256 !== "" && !HASH.test(stage.gcCursor.sha256))
    || (stage.gcCursor.component === "") !== (stage.gcCursor.sha256 === "")) invalid();
  encodeControl(stage.target.control); encodeManifest(stage.target.manifest); encodeManifest(stage.writeManifest);
  if (!phaseValid(stage.target.phase, stage.target.control) || !HASH.test(stage.target.stateSha256)
    || !integer(stage.writeOffset, 0, stage.writeManifest.length) || !integer(stage.verifiedOffset, 0, stage.target.manifest.length)
    || await sha256Hex(canonicalJson(targetHead(head, stage))) !== stage.target.stateSha256) invalid();
  const target = new Set(stage.target.manifest.map(value => canonicalJson(value)));
  const writes = new Set(stage.writeManifest.map(digestKey));
  if (writes.size !== stage.writeManifest.length || stage.writeManifest.some(value => !target.has(canonicalJson(value)))) invalid();
  if (stage.mode === "discarding") {
    if (!integer(stage.discardInputRevision)
      || (stage.discardInputRevision > head.identity.inputRevision ? stage.replay !== null
        : stage.discardInputRevision !== head.identity.inputRevision || !supersessionValid(head, stage.replay))) invalid();
  } else {
    if (stage.discardInputRevision !== null || !validateV1QuotaPageReplay(stage.replay)
      || canonicalJson(stage.replay.through) !== canonicalJson({ phase: stage.target.phase, cursor: stage.target.control.cursor })) invalid();
    if (stage.mode === "garbage_collecting") {
      if (head.progressRevision !== stage.baseProgressRevision + 1 || !headEqual(head, targetHead(head, stage))) invalid();
    } else if (head.progressRevision !== stage.baseProgressRevision || !replayMatches(head, stage.target, stage.replay)) invalid();
    if (stage.mode !== "writing" && stage.writeOffset !== stage.writeManifest.length) invalid();
    if (stage.mode === "writing" && (stage.writeOffset === stage.writeManifest.length || stage.verifiedOffset !== 0)) invalid();
    if (stage.mode !== "garbage_collecting" && stage.gcCursor.component !== "") invalid();
    if (stage.mode === "garbage_collecting" && stage.verifiedOffset !== stage.target.manifest.length) invalid();
  }
}
async function stageGuard(head: CommunityAnalysisWorkHead, stage: CommunityAnalysisWorkStage): Promise<{ sql: string; values: unknown[] }> {
  const current = stage.mode === "discarding"
    ? `EXISTS (SELECT 1 FROM participants p JOIN community_analytical_input_versions v ON v.participant_id=p.id
        JOIN community_analysis_work h ON h.participant_id=p.id WHERE p.id=? AND p.state='active' AND v.revision=?
        AND h.run_id=? AND h.progress_revision=? AND h.state_sha256=?)`
    : WORK_GUARD;
  const currentValues = stage.mode === "discarding"
    ? [head.identity.participantId, stage.discardInputRevision, head.runId, head.progressRevision, await sha256Hex(canonicalJson(head))]
    : await guardValues(head);
  return { sql: `EXISTS (SELECT 1 FROM community_analysis_work_stage s WHERE s.participant_id=? AND s.run_id=?
      AND s.stage_id=? AND s.stage_revision=? AND s.mode=? AND s.state_sha256=?) AND ${current}`,
    values: [head.identity.participantId, head.runId, stage.stageId, stage.revision, stage.mode, await stageHash(head, stage), ...currentValues] };
}
async function stageUpdate(db: D1Database, head: CommunityAnalysisWorkHead, before: CommunityAnalysisWorkStage,
  after: CommunityAnalysisWorkStage, requirePriorChange = false): Promise<D1PreparedStatement> {
  if (!integer(after.revision) || after.revision !== before.revision + 1) invalid();
  const guard = await stageGuard(head, before);
  return db.prepare(`UPDATE community_analysis_work_stage SET stage_revision=?,mode=?,write_offset=?,verified_offset=?,
    gc_component=?,gc_sha256=?,discard_input_revision=?,replay_json=?,state_sha256=? WHERE participant_id=? AND ${guard.sql}${requirePriorChange ? " AND changes()=1" : ""}`)
    .bind(after.revision, after.mode, after.writeOffset, after.verifiedOffset, after.gcCursor.component,
      after.gcCursor.sha256, after.discardInputRevision, canonicalJson(after.replay), await stageHash(head, after),
      head.identity.participantId, ...guard.values);
}
function stageInsert(db: D1Database, head: CommunityAnalysisWorkHead, stage: CommunityAnalysisWorkStage,
  digest: string, guard: { sql: string; values: unknown[] }): D1PreparedStatement {
  return db.prepare(`INSERT INTO community_analysis_work_stage
    (participant_id,run_id,stage_id,base_progress_revision,stage_revision,mode,target_phase,target_control_json,
     target_manifest_json,write_manifest_json,target_state_sha256,replay_json,write_offset,verified_offset,
     gc_component,gc_sha256,discard_input_revision,state_sha256)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard.sql}
      AND NOT EXISTS (SELECT 1 FROM community_analysis_work_stage WHERE participant_id=?)`)
    .bind(head.identity.participantId, head.runId, stage.stageId, stage.baseProgressRevision, stage.revision,
      stage.mode, stage.target.phase, encodeControl(stage.target.control), encodeManifest(stage.target.manifest),
      encodeManifest(stage.writeManifest), stage.target.stateSha256, canonicalJson(stage.replay), stage.writeOffset,
      stage.verifiedOffset, stage.gcCursor.component, stage.gcCursor.sha256, stage.discardInputRevision, digest,
      ...guard.values, head.identity.participantId);
}

export async function beginCommunityAnalysisStage(db: D1Database, head: CommunityAnalysisWorkHead,
  target: CommunityAnalysisStageTarget, replay: unknown, budget: CommunityAnalysisWorkBudget): Promise<CommunityAnalysisStageResult> {
  validateHead(head); encodeControl(target.control);
  if (head.phase === "complete" || !phaseValid(target.phase, target.control) || !replayMatches(head, target, replay)) return { status: "replay_unresolved" };
  if (!spend(budget, 0) || budget.remainingQueries - (budget.reserveQueries ?? 0) < 1) return { status: "deferred" };
  if (head.progressRevision >= Number.MAX_SAFE_INTEGER - 1) invalid();
  const live = new Set(head.manifest.map(digestKey)), writes = new Set<string>();
  const manifest: CommunityAnalysisPartReference[] = [], writeManifest: CommunityAnalysisPartReference[] = [];
  for await (const frame of frameComponents(target.components)) {
    manifest.push(frame.reference);
    const key = digestKey(frame.reference);
    if (!live.has(key) && !writes.has(key)) { writeManifest.push(frame.reference); writes.add(key); }
    if ((budget.now ?? Date.now)() >= budget.deadlineMs) return { status: "deferred" };
  }
  manifest.sort(partOrder); writeManifest.sort(partOrder); encodeManifest(manifest); encodeManifest(writeManifest);
  const nextHead = { ...head, progressRevision: head.progressRevision + 1, phase: target.phase, control: target.control, manifest };
  const stage: CommunityAnalysisWorkStage = { stageId: crypto.randomUUID(), baseProgressRevision: head.progressRevision,
    revision: 0, mode: writeManifest.length ? "writing" : "verifying",
    target: { phase: target.phase, control: target.control, manifest, stateSha256: await sha256Hex(canonicalJson(nextHead)) },
    writeManifest, replay, writeOffset: 0, verifiedOffset: 0, gcCursor: { component: "", sha256: "" }, discardInputRevision: null };
  await validateStage(head, stage);
  const statement = stageInsert(db, head, stage, await stageHash(head, stage), { sql: WORK_GUARD, values: await guardValues(head) });
  if (!spend(budget, 1)) return { status: "deferred" };
  if ((await statement.run()).meta.changes !== 1) return { status: "stale" };
  return { status: "ready", stage };
}

export async function readCommunityAnalysisStage(db: D1Database, head: CommunityAnalysisWorkHead,
  budget: CommunityAnalysisWorkBudget): Promise<CommunityAnalysisStageResult> {
  validateHead(head);
  if (!spend(budget, 1)) return { status: "deferred" };
  return readStageUncharged(db, head);
}
async function readStageUncharged(db: D1Database, head: CommunityAnalysisWorkHead, inspectRevision?: number): Promise<CommunityAnalysisStageResult> {
  const row = await db.prepare(`SELECT s.*,h.state_sha256 AS head_sha256,p.state AS participant_state,v.revision AS current_revision,
    EXISTS(SELECT 1 FROM telemetry_v11_domain_heads d WHERE d.participant_id=p.id) AS successor_active
    FROM community_analysis_work_stage s JOIN community_analysis_work h ON h.participant_id=s.participant_id AND h.run_id=s.run_id
    JOIN participants p ON p.id=s.participant_id JOIN community_analytical_input_versions v ON v.participant_id=p.id
    WHERE s.participant_id=?`).bind(head.identity.participantId).first<Record<string, unknown>>();
  if (!row) return { status: "absent" };
  if (row.head_sha256 !== await sha256Hex(canonicalJson(head)) || row.participant_state !== "active") return { status: "stale" };
  try {
    const parseBounded = (value: unknown, maximum: number): unknown => {
      if (typeof value !== "string" || encoder.encode(value).byteLength > maximum) invalid();
      return JSON.parse(value);
    };
    const stage = { stageId: row.stage_id, baseProgressRevision: row.base_progress_revision, revision: row.stage_revision,
      mode: row.mode, target: { phase: row.target_phase, control: parseBounded(row.target_control_json, COMMUNITY_ANALYSIS_CONTROL_BYTES),
        manifest: parseBounded(row.target_manifest_json, COMMUNITY_ANALYSIS_PART_BYTES), stateSha256: row.target_state_sha256 },
      writeManifest: parseBounded(row.write_manifest_json, COMMUNITY_ANALYSIS_PART_BYTES), replay: parseBounded(row.replay_json, COMMUNITY_ANALYSIS_CONTROL_BYTES),
      writeOffset: row.write_offset, verifiedOffset: row.verified_offset,
      gcCursor: { component: row.gc_component, sha256: row.gc_sha256 }, discardInputRevision: row.discard_input_revision };
    // All untyped fields are checked by validateStage before this value escapes.
    await validateStage(head, stage as CommunityAnalysisWorkStage);
    const validated = stage as CommunityAnalysisWorkStage;
    if (await stageHash(head, validated) !== row.state_sha256) return { status: "corrupt" };
    if (row.current_revision !== (inspectRevision ?? (validated.mode === "discarding" ? validated.discardInputRevision : head.identity.inputRevision))
      || (inspectRevision === undefined && validated.mode !== "discarding" && row.successor_active !== 0)) return { status: "stale" };
    return { status: "ready", stage: validated };
  } catch { return { status: "corrupt" }; }
}

/** Regenerate the exact single-page target after a restart. All target hashes
 * and the replay stop must match before any next chunk is persisted. */
export async function writeCommunityAnalysisStagePage(db: D1Database, head: CommunityAnalysisWorkHead,
  stage: CommunityAnalysisWorkStage, regenerated: CommunityAnalysisStageTarget, replay: unknown,
  budget: CommunityAnalysisWorkBudget): Promise<CommunityAnalysisStageResult> {
  await validateStage(head, stage);
  if (stage.mode !== "writing") return { status: "stale" };
  if (!replayMatches(head, regenerated, replay) || canonicalJson(replay) !== canonicalJson(stage.replay)
    || regenerated.phase !== stage.target.phase || canonicalJson(regenerated.control) !== canonicalJson(stage.target.control)) return { status: "replay_unresolved" };
  const wanted = stage.writeManifest.slice(stage.writeOffset, stage.writeOffset + COMMUNITY_ANALYSIS_MUTATIONS_PER_COMMIT);
  // Admit the full write page before replay framing, but charge only once when
  // the guarded batch is ready. Expensive framing cannot consume reserved work.
  if (!spend(budget, 0) || budget.remainingQueries - (budget.reserveQueries ?? 0) < wanted.length + 1) return { status: "deferred" };
  const wantedKeys = new Set(wanted.map(digestKey)), captured = new Map<string, { reference: CommunityAnalysisPartReference; json: string }>();
  const manifest: CommunityAnalysisPartReference[] = [];
  let payloadBytes = 0;
  for await (const frame of frameComponents(regenerated.components)) {
    manifest.push(frame.reference);
    const key = digestKey(frame.reference);
    if (wantedKeys.has(key) && !captured.has(key)) {
      payloadBytes += frame.reference.bytes;
      if (payloadBytes > COMMUNITY_ANALYSIS_BATCH_BYTES) invalid();
      captured.set(key, frame);
    }
    if ((budget.now ?? Date.now)() >= budget.deadlineMs) return { status: "deferred" };
  }
  manifest.sort(partOrder);
  if (canonicalJson(manifest) !== canonicalJson(stage.target.manifest) || captured.size !== wanted.length) return { status: "replay_unresolved" };
  const guard = await stageGuard(head, stage), statements: D1PreparedStatement[] = [];
  for (const part of wanted) {
    const frame = captured.get(digestKey(part))!;
    statements.push(db.prepare(`INSERT INTO community_analysis_work_parts
      (participant_id,run_id,component,payload_json,payload_sha256,payload_bytes)
      SELECT ?,?,?,?,?,? WHERE ${guard.sql} ON CONFLICT DO NOTHING`)
      .bind(head.identity.participantId, head.runId, part.component, frame.json, part.sha256, part.bytes, ...guard.values));
  }
  const next: CommunityAnalysisWorkStage = { ...stage, revision: stage.revision + 1, writeOffset: stage.writeOffset + wanted.length,
    mode: stage.writeOffset + wanted.length === stage.writeManifest.length ? "verifying" : "writing" };
  statements.push(await stageUpdate(db, head, stage, next));
  if (!spend(budget, statements.length)) return { status: "deferred" };
  if ((await db.batch(statements)).at(-1)?.meta.changes !== 1) return { status: "stale" };
  return { status: "ready", stage: next };
}

export async function verifyCommunityAnalysisStagePage(db: D1Database, head: CommunityAnalysisWorkHead,
  stage: CommunityAnalysisWorkStage, budget: CommunityAnalysisWorkBudget): Promise<CommunityAnalysisStageResult> {
  await validateStage(head, stage);
  if (stage.mode !== "verifying") return { status: "stale" };
  if (!spend(budget, 3)) return { status: "deferred" };
  const before = await readStageUncharged(db, head);
  if (before.status !== "ready" || canonicalJson(before.stage) !== canonicalJson(stage)) return { status: before.status === "corrupt" ? "corrupt" : "stale" };
  const wanted = stage.target.manifest.slice(stage.verifiedOffset, stage.verifiedOffset + COMMUNITY_ANALYSIS_PARTS_PER_READ);
  const rows = await readPartRows(db, head, wanted);
  if (rows.length !== wanted.length) return { status: "corrupt" };
  for (let index = 0; index < wanted.length; index++) {
    const part = wanted[index]!, row = rows[index]!;
    if (row.component !== part.component || row.part_key !== part.partKey || row.payload_sha256 !== part.sha256
      || row.payload_bytes !== part.bytes || typeof row.payload_json !== "string"
      || encoder.encode(row.payload_json).byteLength !== part.bytes || await sha256Hex(row.payload_json) !== part.sha256) return { status: "corrupt" };
    try { if (!validateV1QuotaWorkPart(part.component, JSON.parse(row.payload_json))) return { status: "corrupt" }; }
    catch { return { status: "corrupt" }; }
  }
  const next = { ...stage, revision: stage.revision + 1, verifiedOffset: stage.verifiedOffset + wanted.length };
  if ((await (await stageUpdate(db, head, stage, next)).run()).meta.changes !== 1) return { status: "stale" };
  return { status: "ready", stage: next };
}

export async function promoteCommunityAnalysisStage(db: D1Database, head: CommunityAnalysisWorkHead,
  stage: CommunityAnalysisWorkStage, budget: CommunityAnalysisWorkBudget): Promise<
    | { status: "ready"; head: CommunityAnalysisWorkHead; stage: CommunityAnalysisWorkStage }
    | { status: "stale" | "deferred" }> {
  await validateStage(head, stage);
  if (stage.mode !== "verifying" || stage.writeOffset !== stage.writeManifest.length
    || stage.verifiedOffset !== stage.target.manifest.length) return { status: "deferred" };
  const nextHead = targetHead(head, stage), nextStage: CommunityAnalysisWorkStage = { ...stage,
    mode: "garbage_collecting", revision: stage.revision + 1, gcCursor: { component: "", sha256: "" } };
  const guard = await stageGuard(head, stage);
  const updateHead = db.prepare(`UPDATE community_analysis_work SET phase=?,progress_revision=?,control_json=?,manifest_json=?,state_sha256=?
    WHERE participant_id=? AND ${guard.sql}
      AND NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN community_analysis_work_parts p
        ON p.participant_id=community_analysis_work.participant_id AND p.run_id=community_analysis_work.run_id
        AND p.component=json_extract(j.value,'$.component') AND p.payload_sha256=json_extract(j.value,'$.sha256')
        WHERE p.payload_sha256 IS NULL OR p.payload_bytes != json_extract(j.value,'$.bytes'))`)
    .bind(nextHead.phase, nextHead.progressRevision, encodeControl(nextHead.control), encodeManifest(nextHead.manifest),
      stage.target.stateSha256, head.identity.participantId, ...guard.values, encodeManifest(stage.target.manifest));
  // Stage guard must observe the NEW head after the first statement. Its own CAS
  // token remains the old value until this final statement commits the GC mode.
  const updateStage = await stageUpdate(db, nextHead, stage, nextStage, true);
  if (!spend(budget, 2)) return { status: "deferred" };
  const result = await db.batch([updateHead, updateStage]);
  if (result[0]?.meta.changes !== 1 || result[1]?.meta.changes !== 1) return { status: "stale" };
  return { status: "ready", head: nextHead, stage: nextStage };
}

/** Stale-source cleanup is explicit and bounded. It cannot publish old work.
 * Participant erasure itself remains the existing separately-authorized path. */
export async function beginCommunityAnalysisDiscard(db: D1Database, head: CommunityAnalysisWorkHead,
  currentInputRevision: number, budget: CommunityAnalysisWorkBudget,
  previousStage?: CommunityAnalysisWorkStage): Promise<CommunityAnalysisStageResult> {
  validateHead(head);
  if (!integer(currentInputRevision) || currentInputRevision <= head.identity.inputRevision) invalid();
  return beginDiscard(db, head, currentInputRevision, budget, previousStage, null);
}

/** Explicit policy/window replacement only. A new clock instant or a changed
 * fingerprint alone cannot destroy same-revision progress. The replacement is
 * content-free, bounded, and integrity-bound in the existing replay field. */
export async function beginCommunityAnalysisSupersession(db: D1Database, head: CommunityAnalysisWorkHead,
  replacementIdentity: CommunityAnalysisWorkIdentity, budget: CommunityAnalysisWorkBudget,
  previousStage?: CommunityAnalysisWorkStage): Promise<CommunityAnalysisStageResult> {
  validateHead(head); validateIdentity(replacementIdentity);
  if (!supersedes(head, replacementIdentity)) return { status: "stale" };
  return beginDiscard(db, head, replacementIdentity.inputRevision, budget, previousStage,
    { version: "community-analysis-supersession-1", replacementIdentity: { ...replacementIdentity } });
}

async function beginDiscard(db: D1Database, head: CommunityAnalysisWorkHead,
  currentInputRevision: number, budget: CommunityAnalysisWorkBudget,
  previousStage: CommunityAnalysisWorkStage | undefined, replacement: CommunityAnalysisSupersession | null): Promise<CommunityAnalysisStageResult> {
  if (previousStage) await validateStage(head, previousStage);
  const target = { phase: head.phase, control: head.control, manifest: head.manifest,
    stateSha256: await sha256Hex(canonicalJson({ ...head, progressRevision: head.progressRevision + 1 })) };
  const next: CommunityAnalysisWorkStage = { stageId: previousStage?.stageId ?? crypto.randomUUID(),
    baseProgressRevision: previousStage?.baseProgressRevision ?? head.progressRevision,
    revision: (previousStage?.revision ?? -1) + 1, mode: "discarding", target: previousStage?.target ?? target,
    writeManifest: previousStage?.writeManifest ?? [], replay: replacement, writeOffset: previousStage?.writeOffset ?? 0,
    verifiedOffset: previousStage?.verifiedOffset ?? 0, gcCursor: { component: "", sha256: "" }, discardInputRevision: currentInputRevision };
  await validateStage(head, next);
  const currentGuard = `EXISTS (SELECT 1 FROM participants p JOIN community_analytical_input_versions v ON v.participant_id=p.id
    JOIN community_analysis_work h ON h.participant_id=p.id WHERE p.id=? AND p.state='active' AND v.revision=?
      AND h.run_id=? AND h.progress_revision=? AND h.state_sha256=?
      ${replacement ? "AND NOT EXISTS (SELECT 1 FROM telemetry_v11_domain_heads d WHERE d.participant_id=p.id)" : ""})`;
  const currentValues = [head.identity.participantId, currentInputRevision, head.runId, head.progressRevision, await sha256Hex(canonicalJson(head))];
  let statement: D1PreparedStatement;
  if (previousStage) {
    // The old source may no longer be current: match its stage token and the
    // NEW current revision, not its now-invalid old source guard.
    statement = db.prepare(`UPDATE community_analysis_work_stage SET mode='discarding',stage_revision=?,
      discard_input_revision=?,replay_json=?,gc_component='',gc_sha256='',state_sha256=?
      WHERE participant_id=? AND stage_id=? AND stage_revision=? AND state_sha256=? AND ${currentGuard}`)
      .bind(next.revision, currentInputRevision, canonicalJson(next.replay), await stageHash(head, next), head.identity.participantId,
        previousStage.stageId, previousStage.revision, await stageHash(head, previousStage), ...currentValues);
  } else statement = stageInsert(db, head, next, await stageHash(head, next), { sql: currentGuard, values: currentValues });
  if (!spend(budget, 1)) return { status: "deferred" };
  if ((await statement.run()).meta.changes !== 1) return { status: "stale" };
  return { status: "ready", stage: next };
}

/** Same-source policy supersession inspection, never analytical evidence. */
export async function readCommunityAnalysisWorkForSupersession(db: D1Database,
  replacementIdentity: CommunityAnalysisWorkIdentity, budget: CommunityAnalysisWorkBudget): Promise<
    | { status: "ready"; head: CommunityAnalysisWorkHead; stage: CommunityAnalysisWorkStage | null }
    | { status: "absent" | "stale" | "corrupt" | "deferred" }> {
  validateIdentity(replacementIdentity);
  if (!spend(budget, 2)) return { status: "deferred" };
  const read = await readHead(db, replacementIdentity, true);
  if (read.status !== "ready") return read;
  if (!supersedes(read.head, replacementIdentity)) return { status: "stale" };
  const staged = await readStageUncharged(db, read.head, replacementIdentity.inputRevision);
  if (staged.status === "absent") return { status: "ready", head: read.head, stage: null };
  if (staged.status !== "ready") return { status: staged.status === "corrupt" ? "corrupt" : "stale" };
  return { status: "ready", head: read.head, stage: staged.stage };
}

/** Inspection tokens for bounded stale-source disposal, never resumable
 * analytical evidence. This is how discard itself survives a Worker restart. */
export async function readCommunityAnalysisWorkForDiscard(db: D1Database, participantId: string,
  currentInputRevision: number, budget: CommunityAnalysisWorkBudget): Promise<
    | { status: "ready"; head: CommunityAnalysisWorkHead; stage: CommunityAnalysisWorkStage | null }
    | { status: "absent" | "stale" | "corrupt" | "deferred" }> {
  if (!/^[A-Za-z0-9:_-]{1,128}$/u.test(participantId) || !integer(currentInputRevision)) invalid();
  if (!spend(budget, 2)) return { status: "deferred" };
  const read = await readHead(db, { participantId, inputRevision: currentInputRevision }, true);
  if (read.status !== "ready") return read;
  if (read.head.identity.inputRevision >= currentInputRevision) return { status: "stale" };
  const staged = await readStageUncharged(db, read.head, currentInputRevision);
  if (staged.status === "absent") return { status: "ready", head: read.head, stage: null };
  if (staged.status !== "ready") return { status: staged.status === "corrupt" ? "corrupt" : "stale" };
  return { status: "ready", head: read.head, stage: staged.stage };
}

export async function collectCommunityAnalysisWorkGarbage(db: D1Database, head: CommunityAnalysisWorkHead,
  stage: CommunityAnalysisWorkStage, budget: CommunityAnalysisWorkBudget): Promise<
    | { status: "ready"; stage: CommunityAnalysisWorkStage; done: false }
    | { status: "ready"; done: true; discarded: boolean }
    | { status: "stale" | "deferred" }> {
  await validateStage(head, stage);
  if (stage.mode !== "garbage_collecting" && stage.mode !== "discarding") return { status: "stale" };
  // Reserve the entire possible page before the first read. This also reserves
  // the two final empty-run deletes. It never gives another account new quota.
  if (!spend(budget, COMMUNITY_ANALYSIS_MUTATIONS_PER_COMMIT + 2)) return { status: "deferred" };
  const rows = (await db.prepare(`SELECT component,payload_sha256 FROM community_analysis_work_parts
    WHERE participant_id=? AND run_id=? AND (component>? OR (component=? AND payload_sha256>?))
    ORDER BY component,payload_sha256 LIMIT ?`).bind(head.identity.participantId, head.runId,
      stage.gcCursor.component, stage.gcCursor.component, stage.gcCursor.sha256, COMMUNITY_ANALYSIS_MUTATIONS_PER_COMMIT)
    .all<{ component: V1QuotaWorkComponent; payload_sha256: string }>()).results;
  const guard = await stageGuard(head, stage), statements: D1PreparedStatement[] = [];
  if (!rows.length) {
    statements.push(db.prepare(`DELETE FROM community_analysis_work_stage WHERE participant_id=? AND ${guard.sql}`)
      .bind(head.identity.participantId, ...guard.values));
    if (stage.mode === "discarding") {
      statements.push(db.prepare(`DELETE FROM community_analysis_work WHERE participant_id=? AND run_id=? AND progress_revision=?
        AND changes()=1
        AND NOT EXISTS (SELECT 1 FROM community_analysis_work_parts WHERE participant_id=? AND run_id=?)
        AND NOT EXISTS (SELECT 1 FROM community_analysis_work_stage WHERE participant_id=?)
        AND EXISTS (SELECT 1 FROM participants p JOIN community_analytical_input_versions v ON v.participant_id=p.id
          WHERE p.id=? AND p.state='active' AND v.revision=?)`)
        .bind(head.identity.participantId, head.runId, head.progressRevision, head.identity.participantId, head.runId,
          head.identity.participantId, head.identity.participantId, stage.discardInputRevision));
    }
    const result = await db.batch(statements);
    budget.remainingQueries += COMMUNITY_ANALYSIS_MUTATIONS_PER_COMMIT + 1 - statements.length;
    if (result[0]?.meta.changes !== 1 || (stage.mode === "discarding" && result[1]?.meta.changes !== 1)) return { status: "stale" };
    return { status: "ready", done: true, discarded: stage.mode === "discarding" };
  }
  const referenced = new Set(head.manifest.map(digestKey));
  for (const row of rows) {
    if (stage.mode === "discarding" || !referenced.has(`${row.component}:${row.payload_sha256}`)) {
      statements.push(db.prepare(`DELETE FROM community_analysis_work_parts WHERE participant_id=? AND run_id=?
        AND component=? AND payload_sha256=? AND ${guard.sql}`)
        .bind(head.identity.participantId, head.runId, row.component, row.payload_sha256, ...guard.values));
    }
  }
  const last = rows.at(-1)!;
  const next: CommunityAnalysisWorkStage = { ...stage, revision: stage.revision + 1,
    gcCursor: { component: last.component, sha256: last.payload_sha256 } };
  statements.push(await stageUpdate(db, head, stage, next));
  const results = await db.batch(statements);
  budget.remainingQueries += COMMUNITY_ANALYSIS_MUTATIONS_PER_COMMIT + 1 - statements.length;
  if (results.at(-1)?.meta.changes !== 1) return { status: "stale" };
  return { status: "ready", stage: next, done: false };
}
