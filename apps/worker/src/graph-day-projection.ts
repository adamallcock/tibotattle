import { MODEL_COMPOSITION_POLICY, QUOTA_CALIBRATION_POLICY } from "@app-usagemonitor/quota-analysis";
import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import {
  GRAPH_DAY_PROJECTION_COMPONENTS,
  GRAPH_DAY_PROJECTION_VERSION,
  GRAPH_DAY_PLAN_ANCHOR_LIMIT,
  GRAPH_DAY_RUN_ENDPOINT_LIMIT,
  GRAPH_DAY_USAGE_CELL_LIMIT,
  GRAPH_DAY_USAGE_COST_CEILING,
  GRAPH_DAY_USAGE_SESSION_LIMIT,
  graphDayFitFragmentOrder,
  graphDayPlanSignature,
  graphDayProjectionComponentEntries,
  graphDayRunKey,
  graphDayUsageCellOrder,
  graphDayProjectionFromComponents,
  graphDayProjectionRecordCount,
  validGraphDayLabel,
  validGraphDayProjection,
  type GraphDayAcquiredRow,
  type GraphDayFitFragment,
  type GraphDayProjection,
  type GraphDayProjectionComponent,
  type GraphDayRunEndpoint,
  type GraphDayUsageCell,
  type GraphDayUsageFragments,
  type GraphDayUsageOpener,
  type GraphDayUsagePlanBasis,
} from "./graph-day-projection-values";
import { v11PreparedDayRow, type V11PlanAnchor } from "./quota-analysis-v11-reader";
import { assertTypedV11GenerationSnapshotLive, createTypedV11QuotaPageReader,
  loadTypedV11GenerationSnapshot, type V11GenerationSnapshot } from "./typed-v11-quota-reader";
import { createV11QuotaAcquisitionIdentity, v11PreparedUsageDayRow } from "./quota-analysis-v11";
import { loadV11SourcePin } from "./telemetry-v11-domain";
import { readTypedV11UsageAnalysisPage, TYPED_V11_ANALYSIS_PAGE_SIZE } from "./typed-v11-analysis-reader";

/** One framed payload row. The SQL CHECK is 256 KiB; the framer stays below it
 * so a page can never be refused only because canonical JSON grew a byte. */
export const GRAPH_DAY_PROJECTION_PART_BYTES = 192 * 1024;
export const GRAPH_DAY_PROJECTION_MAX_PARTS = 4_096;
export const GRAPH_DAY_PROJECTION_LOAD_PARTS = 8, GRAPH_DAY_PROJECTION_MAX_LOAD_PARTS = 32;
export const GRAPH_DAY_PROJECTION_MAX_WRITES = 32;

const HASH = /^[a-f0-9]{64}$/u;
const encoder = new TextEncoder();
const size = (text: string): number => encoder.encode(text).byteLength;
const fail = (): Error => new Error("GRAPH_DAY_PROJECTION_UNAVAILABLE");

/** A day whose own reduction cannot be represented within the acquisition's
 * bounds. Refusals stay explicit: a bounded day is never silently truncated
 * into a projection the fold would then treat as complete evidence. */
export class GraphDayProjectionRefusedError extends Error {
  readonly code = "GRAPH_DAY_PROJECTION_REFUSED";
  constructor(readonly reason: "plan_anchor_limit_exceeded" | "run_endpoint_limit_exceeded"
    | "usage_cost_limit_exceeded" | "usage_cell_limit_exceeded"
    | "usage_session_limit_exceeded" | "usage_row_refused" | "owner_source_unavailable") {
    super("prepared graph day refused");
  }
}

/**
 * The durable identity of one prepared day. The day manifest identity is the
 * owner's per-day input revision: a re-upload that restates one day changes
 * that day's `manifestDigest` and therefore only that day's key, so every other
 * prepared day stays valid. `acquisitionVersion` carries the kernel contract,
 * so a method change misses every key rather than reusing stale rows.
 */
export interface GraphDayProjectionKey {
  sourceId: string;
  sourceLayout: "json-v11" | "typed-v11";
  sourceNamespace: string;
  ownerDigest: string;
  deviceId: string;
  manifestId: string;
  manifestDigest: string;
  day: string;
}
const KEY_FIELDS = ["sourceId", "sourceLayout", "sourceNamespace", "ownerDigest", "deviceId",
  "manifestId", "manifestDigest", "day"] as const;

function checkKey(key: GraphDayProjectionKey): void {
  if (!key || typeof key !== "object" || Object.keys(key).sort().join(",") !== [...KEY_FIELDS].sort().join(",")
    || typeof key.sourceId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(key.sourceId)
    || !HASH.test(key.ownerDigest) || !HASH.test(key.manifestDigest)
    || !["json-v11", "typed-v11"].includes(key.sourceLayout)
    || typeof key.sourceNamespace !== "string" || key.sourceNamespace.length > 256
    || (key.sourceLayout === "json-v11") !== (key.sourceNamespace.length === 0)
    || typeof key.deviceId !== "string" || key.deviceId.length < 1 || key.deviceId.length > 256
    || typeof key.manifestId !== "string" || key.manifestId.length < 1 || key.manifestId.length > 256
    || !validGraphDayLabel(key.day)) throw fail();
}
function bounded(value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw fail();
}

/** The content-addressed row identity. It deliberately covers the acquisition
 * version and the day manifest digest and nothing else: those are the two
 * inputs whose change must invalidate a prepared day. */
export async function graphDayProjectionValueKey(key: GraphDayProjectionKey,
  acquisitionVersion: string = GRAPH_DAY_PROJECTION_VERSION): Promise<string> {
  checkKey(key);
  if (acquisitionVersion !== GRAPH_DAY_PROJECTION_VERSION) throw fail();
  return sha256Hex(canonicalJson({ ...Object.fromEntries(KEY_FIELDS.map((field) => [field, key[field]])),
    acquisitionVersion }));
}

interface FramedPart { component: GraphDayProjectionComponent; entryCount: number; digest: string; payload: string }
interface Frame { parts: FramedPart[]; digest: string; recordCount: number }

async function frame(projection: GraphDayProjection): Promise<Frame> {
  if (!validGraphDayProjection(projection)) throw fail();
  const parts: FramedPart[] = [];
  for (const [component, entries] of graphDayProjectionComponentEntries(projection)) {
    let chunk: unknown[] = [];
    const emit = async (): Promise<void> => {
      const payload = canonicalJson({ component, entries: chunk });
      if (size(payload) > GRAPH_DAY_PROJECTION_PART_BYTES) throw fail();
      parts.push({ component, entryCount: chunk.length, digest: await sha256Hex(payload), payload });
      if (parts.length > GRAPH_DAY_PROJECTION_MAX_PARTS) throw fail();
      chunk = [];
    };
    for (const entry of entries) {
      chunk.push(entry);
      if (size(canonicalJson({ component, entries: chunk })) <= GRAPH_DAY_PROJECTION_PART_BYTES) continue;
      chunk.pop();
      // A single entry larger than one page is a refusal, not a silent split:
      // every component entry is a bounded closed record.
      if (chunk.length === 0) throw fail();
      await emit();
      chunk.push(entry);
    }
    if (chunk.length) await emit();
  }
  // `part_count>=1` needs no fallback: `usageRowsRead` always frames one entry,
  // so an owner-day with nothing else retained still has a part. A synthesized
  // empty part would also claim a record count of one against a framed total of
  // zero, which the completeness trigger refuses.
  if (parts.length === 0) throw fail();
  return { parts, digest: await sha256Hex(canonicalJson(projection)),
    recordCount: graphDayProjectionRecordCount(projection) };
}
// Framing a large day hashes every page. One invocation stages the same
// immutable projection across several bounded writes, so the frame is memoized
// per object; the framer only reads it.
const frames = new WeakMap<object, Frame>();
async function framed(projection: GraphDayProjection): Promise<Frame> {
  const cached = frames.get(projection);
  if (cached) return cached;
  const built = await frame(projection);
  frames.set(projection, built);
  return built;
}

export interface GraphDayProjectionWriteCursor {
  valueKey: string;
  digest: string;
  present: number[];
}
export type GraphDayProjectionWrite =
  | { status: "stored"; valueKey: string; totalParts: number; recordCount: number }
  | { status: "staging"; valueKey: string; storedParts: number; totalParts: number;
      cursor: GraphDayProjectionWriteCursor };

/**
 * Write one prepared day, in bounded pages. Replay is free: the value key is
 * the day's identity and the values row is immutable, so re-writing the same
 * projection stores nothing new, and a rebuild that produced DIFFERENT bytes
 * under the same identity is a refusal rather than a silent overwrite.
 */
export async function writeGraphDayProjection(input: { target: D1Database; key: GraphDayProjectionKey;
  projection: GraphDayProjection; maxWrites?: number; cursor?: GraphDayProjectionWriteCursor;
}): Promise<GraphDayProjectionWrite> {
  const { target, projection } = input, key = { ...input.key };
  checkKey(key);
  if (projection.day !== key.day) throw fail();
  const max = input.maxWrites ?? GRAPH_DAY_PROJECTION_MAX_WRITES;
  bounded(max, 2, GRAPH_DAY_PROJECTION_MAX_WRITES);
  const valueKey = await graphDayProjectionValueKey(key), f = await framed(projection);
  const present = new Set<number>();
  if (input.cursor) {
    const cursor = input.cursor;
    if (cursor.valueKey !== valueKey || cursor.digest !== f.digest || !Array.isArray(cursor.present)
      || cursor.present.some((index) => !Number.isSafeInteger(index) || index < 0
        || index >= f.parts.length)) throw fail();
    for (const index of cursor.present) present.add(index);
  } else {
    const row = await target.prepare(`SELECT values_digest,part_count,record_count
      FROM analytics_graph_day_values WHERE value_key=?`).bind(valueKey)
      .first<{ values_digest: string; part_count: number; record_count: number }>();
    if (row) {
      if (row.values_digest !== f.digest || row.part_count !== f.parts.length
        || row.record_count !== f.recordCount) throw fail();
      return { status: "stored", valueKey, totalParts: f.parts.length, recordCount: f.recordCount };
    }
    const staged = (await target.prepare(`SELECT part_index,part_digest FROM analytics_graph_day_pages
      WHERE value_key=? ORDER BY part_index LIMIT ?`).bind(valueKey, GRAPH_DAY_PROJECTION_MAX_PARTS + 1)
      .all<{ part_index: number; part_digest: string }>()).results;
    if (staged.length > GRAPH_DAY_PROJECTION_MAX_PARTS) throw fail();
    // A staged page whose digest disagrees with this frame is left to be
    // replaced in place: no values row authorizes it yet, so it is not evidence.
    for (const row of staged) {
      if (f.parts[row.part_index]?.digest === row.part_digest) present.add(row.part_index);
    }
  }
  const missing = f.parts.map((_, index) => index).filter((index) => !present.has(index));
  const page = missing.slice(0, max - 1);
  const statements = page.map((index) => {
    const part = f.parts[index]!;
    return target.prepare(`INSERT INTO analytics_graph_day_pages
      (value_key,part_index,source_id,owner_digest,day,acquisition_version,component,entry_count,part_digest,payload_json)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(value_key,part_index) DO UPDATE SET component=excluded.component,
       entry_count=excluded.entry_count,part_digest=excluded.part_digest,payload_json=excluded.payload_json
       WHERE analytics_graph_day_pages.part_digest IS NOT excluded.part_digest`)
      .bind(valueKey, index, key.sourceId, key.ownerDigest, key.day, GRAPH_DAY_PROJECTION_VERSION,
        part.component, part.entryCount, part.digest, part.payload);
  });
  const complete = page.length === missing.length;
  if (complete) {
    statements.push(target.prepare(`INSERT INTO analytics_graph_day_values
      (value_key,source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,manifest_digest,
       day,acquisition_version,record_count,part_count,values_digest)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(value_key) DO NOTHING`)
      .bind(valueKey, key.sourceId, key.sourceLayout, key.sourceNamespace, key.ownerDigest, key.deviceId,
        key.manifestId, key.manifestDigest, key.day, GRAPH_DAY_PROJECTION_VERSION, f.recordCount,
        f.parts.length, f.digest));
  }
  if (statements.length) await target.batch(statements);
  const stored = complete
    ? await target.prepare("SELECT values_digest FROM analytics_graph_day_values WHERE value_key=?")
      .bind(valueKey).first<string>("values_digest")
    : null;
  if (complete) {
    if (stored !== f.digest) throw fail();
    return { status: "stored", valueKey, totalParts: f.parts.length, recordCount: f.recordCount };
  }
  return { status: "staging", valueKey, storedParts: present.size + page.length,
    totalParts: f.parts.length, cursor: { valueKey, digest: f.digest, present: [...present, ...page] } };
}

export interface GraphDayProjectionLoadCursor {
  valueKey: string;
  digest: string;
  partCount: number;
  recordCount: number;
  components: Partial<Record<GraphDayProjectionComponent, unknown[]>>;
  loaded: number;
}
export type GraphDayProjectionRead =
  | { status: "absent"; valueKey: string }
  | { status: "deferred"; valueKey: string; cursor: GraphDayProjectionLoadCursor }
  | { status: "ready"; valueKey: string; projection: GraphDayProjection; recordCount: number };

/** Read one prepared day, at most `maxParts` payload rows per call. Every page
 * is rehashed and the reassembled artifact must both validate and match the
 * promoted payload digest, so a torn or tampered page can never decode. */
export async function readGraphDayProjection(input: { target: D1Database; key: GraphDayProjectionKey;
  cursor?: GraphDayProjectionLoadCursor; maxParts?: number;
}): Promise<GraphDayProjectionRead> {
  const { target } = input, key = { ...input.key };
  checkKey(key);
  const max = input.maxParts ?? GRAPH_DAY_PROJECTION_LOAD_PARTS;
  bounded(max, 1, GRAPH_DAY_PROJECTION_MAX_LOAD_PARTS);
  const valueKey = await graphDayProjectionValueKey(key);
  let cursor = input.cursor;
  if (cursor && cursor.valueKey !== valueKey) throw fail();
  if (!cursor) {
    const row = await target.prepare(`SELECT values_digest,part_count,record_count
      FROM analytics_graph_day_values WHERE value_key=?`).bind(valueKey)
      .first<{ values_digest: string; part_count: number; record_count: number }>();
    if (!row) return { status: "absent", valueKey };
    if (!HASH.test(row.values_digest) || !Number.isSafeInteger(row.part_count) || row.part_count < 1
      || row.part_count > GRAPH_DAY_PROJECTION_MAX_PARTS || !Number.isSafeInteger(row.record_count)
      || row.record_count < 0) throw fail();
    cursor = { valueKey, digest: row.values_digest, partCount: row.part_count,
      recordCount: row.record_count, components: {}, loaded: 0 };
  }
  const rows = (await target.prepare(`SELECT part_index,component,entry_count,part_digest,payload_json
    FROM analytics_graph_day_pages WHERE value_key=? AND part_index>=? ORDER BY part_index LIMIT ?`)
    .bind(valueKey, cursor.loaded, max)
    .all<{ part_index: number; component: string; entry_count: number; part_digest: string; payload_json: string }>()).results;
  for (const row of rows) {
    if (row.part_index !== cursor.loaded || cursor.loaded >= cursor.partCount
      || !GRAPH_DAY_PROJECTION_COMPONENTS.includes(row.component as GraphDayProjectionComponent)
      || await sha256Hex(row.payload_json) !== row.part_digest) throw fail();
    let payload: unknown;
    try { payload = JSON.parse(row.payload_json); } catch { throw fail(); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw fail();
    const part = payload as { component?: unknown; entries?: unknown };
    if (Object.keys(part).sort().join(",") !== "component,entries" || part.component !== row.component
      || !Array.isArray(part.entries) || part.entries.length !== row.entry_count) throw fail();
    const component = row.component as GraphDayProjectionComponent;
    (cursor.components[component] ??= []).push(...part.entries);
    cursor.loaded += 1;
  }
  if (cursor.loaded < cursor.partCount) {
    if (!rows.length) throw fail();
    return { status: "deferred", valueKey, cursor };
  }
  const candidate = graphDayProjectionFromComponents(key.day, cursor.components);
  if (!validGraphDayProjection(candidate)) throw fail();
  if (await sha256Hex(canonicalJson(candidate)) !== cursor.digest
    || graphDayProjectionRecordCount(candidate) !== cursor.recordCount) throw fail();
  return { status: "ready", valueKey, projection: candidate, recordCount: cursor.recordCount };
}

/**
 * One bounded retirement page. Three independent reasons, all keyed to this
 * source only:
 *
 * - a row whose `acquisition_version` is not the current kernel contract;
 * - a row for an owner with a terminal erasure fence;
 * - a row whose day manifest identity no longer matches any delivered day,
 *   which is what a re-upload leaves behind after the new key is prepared.
 *
 * Pages are deleted after the values row that authorized them, so an
 * interrupted retirement resumes from the orphan pages rather than leaving a
 * values row pointing at a partly deleted payload.
 */
export async function retireGraphDayProjectionPage(target: D1Database, sourceId: string,
  options: { limit?: number; acquisitionVersion?: string } = {},
): Promise<{ state: "idle" | "retiring"; values: number; pages: number; refusals: number }> {
  const limit = options.limit ?? 32;
  bounded(limit, 1, 200);
  const version = options.acquisitionVersion ?? GRAPH_DAY_PROJECTION_VERSION;
  if (typeof version !== "string" || version.length < 1 || version.length > 128) throw fail();
  const values = (await target.prepare(`DELETE FROM analytics_graph_day_values WHERE value_key IN (
    SELECT g.value_key FROM analytics_graph_day_values g
    WHERE g.source_id=?1 AND (g.acquisition_version!=?2
      OR EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
        WHERE f.source_id=g.source_id AND f.owner_digest=g.owner_digest)
      OR NOT EXISTS(SELECT 1 FROM analytics_v11_reusable_values v
        WHERE v.source_id=g.source_id AND v.source_layout=g.source_layout
          AND v.source_namespace=g.source_namespace AND v.owner_digest=g.owner_digest
          AND v.device_id=g.device_id AND v.manifest_id=g.manifest_id
          AND v.manifest_digest=g.manifest_digest AND v.day=g.day))
    ORDER BY g.owner_digest,g.day,g.value_key LIMIT ?3) RETURNING value_key`)
    .bind(sourceId, version, limit).all()).results.length;
  const pages = (await target.prepare(`DELETE FROM analytics_graph_day_pages WHERE (value_key,part_index) IN (
    SELECT p.value_key,p.part_index FROM analytics_graph_day_pages p
    WHERE p.source_id=?1 AND NOT EXISTS(SELECT 1 FROM analytics_graph_day_values g WHERE g.value_key=p.value_key)
    ORDER BY p.value_key,p.part_index LIMIT ?2) RETURNING part_index`)
    .bind(sourceId, limit).all()).results.length;
  // A refusal whose delivered day is gone is not evidence of anything; it goes
  // with the rest of that day's derived state.
  const refusals = (await target.prepare(`DELETE FROM analytics_graph_day_refusals
    WHERE (source_id,owner_digest,day,manifest_digest,acquisition_version) IN (
      SELECT r.source_id,r.owner_digest,r.day,r.manifest_digest,r.acquisition_version
      FROM analytics_graph_day_refusals r
      WHERE r.source_id=?1 AND (r.acquisition_version!=?2
        OR NOT EXISTS(SELECT 1 FROM analytics_v11_reusable_values v
          WHERE v.source_id=r.source_id AND v.owner_digest=r.owner_digest AND v.day=r.day
            AND v.manifest_digest=r.manifest_digest))
      ORDER BY r.owner_digest,r.day LIMIT ?3) RETURNING day`)
    .bind(sourceId, version, limit).all()).results.length;
  return { state: values + pages + refusals > 0 ? "retiring" : "idle", values, pages, refusals };
}

interface DayFitStats { values: number[]; minimum: number; maximum: number }
/**
 * Accumulate one displayed value into a day-local fit fragment.
 *
 * This is deliberately NOT `addQuotaFragmentValue`, which caps the retained set
 * at the first `minimumBoundaries` distinct values in ARRIVAL order. Arrival
 * order does not compose: two days that each saw four distinct values would
 * union to a set that depends on which rows happened to be read first. The
 * numerically smallest distinct set does compose — either a day saturates the
 * cap or it holds its whole distinct set — so the union of the days reaches the
 * cap exactly when the pool's true distinct count does and
 * `quotaFragmentEligible` is preserved. The retained array stays bounded by the
 * cap; no day ever holds an unbounded distinct set.
 */
function addGraphDayFitValue(stats: Map<string, DayFitStats>, key: string, usedPercent: number): void {
  const stat = stats.get(key);
  if (stat === undefined) {
    stats.set(key, { values: [usedPercent], minimum: usedPercent, maximum: usedPercent });
    return;
  }
  if (usedPercent < stat.minimum) stat.minimum = usedPercent;
  if (usedPercent > stat.maximum) stat.maximum = usedPercent;
  if (stat.values.includes(usedPercent)) return;
  if (stat.values.length < QUOTA_CALIBRATION_POLICY.minimumBoundaries) {
    stat.values.push(usedPercent);
    stat.values.sort((left, right) => left - right);
    return;
  }
  if (usedPercent >= stat.values[stat.values.length - 1]!) return;
  stat.values[stat.values.length - 1] = usedPercent;
  stat.values.sort((left, right) => left - right);
}

/** One source row, already mapped through the acquisition reader's own row and
 * anchor mappers. The reduction below decides nothing about eligibility: it
 * only splits runs and reduces, so the kernel that accepts a row stays in one
 * place and a prepared day cannot disagree with a direct read about which rows
 * exist. */
export interface GraphDayQuotaInput {
  readonly sourceRowId: number;
  readonly observedAtMs: number;
  /** The plan observation this row contributes, or null when it is not one. A
   * null anchor still breaks preparation runs: retaining a superset is safe. */
  readonly anchor: V11PlanAnchor | null;
  /** The acquirable quota row, with `resets_at` still raw, or null. */
  readonly row: GraphDayAcquiredRow | null;
}

/** Every field a plan anchor carries. Anchors identical in all of them cannot
 * be a run boundary under any grouping, which is what makes dropping an
 * interior one safe without restating the reader's private grouping rules. */
function anchorFields(anchor: V11PlanAnchor): string {
  return canonicalJson([anchor.contextKey, anchor.accountScopeId, anchor.planType,
    anchor.planVariant, anchor.continuityId, anchor.planBasis, anchor.conflicted]);
}
/**
 * One v1.1 usage event, already mapped through the reduction's own per-event
 * work: pricing, attribution parsing and the session key. `sessionDigest` is an
 * OPAQUE digest the caller derives from `[provider, session_uuid]`, so no raw
 * session identifier reaches this store; the reduction only ever compares
 * session keys for equality, never reads them.
 */
export interface GraphDayUsageInput {
  readonly sessionDigest: string | null;
  readonly observedAtMs: number;
  readonly provider: string;
  readonly accountScopeId: string | null;
  readonly planBasis: GraphDayUsagePlanBasis;
  readonly planType: string | null;
  readonly planEraId: string | null;
  /** `priced` contributes its cost to `[bin, model]`; `unpriced` poisons its
   * whole bin and carries no cost; `unmeasurable` is the reduction's own drop
   * (`priceChunkUsageRecord` returned null) which still advances the session
   * carry, so a later event of that session is decided day-locally. */
  readonly kind: "priced" | "unpriced" | "unmeasurable";
  readonly model: string | null;
  readonly costNanousd: number;
}

/**
 * Reduce a day's v1.1 usage events to the MODEL half of the reduction.
 *
 * `accountBreak` is `prior.scope !== scope` over the event's own session, which
 * is day-local for every event except a session's first in the day; those are
 * held individually so the fold decides them once carry-in is known. Everything
 * else is an integer sum over `(bin, attribution, break, model)`. The window
 * era is never assumed: the raw attribution inputs travel with the cell and the
 * fold evaluates the conflict and the seed comparison once per cell.
 */
function reduceGraphDayUsage(day: string, source: GraphDayUsageSource): GraphDayUsageFragments {
  const events = source.events;
  if (!Number.isSafeInteger(source.rowsRead) || source.rowsRead < 0) throw fail();
  const dayStart = Date.parse(`${day}T00:00:00.000Z`);
  const grain = MODEL_COMPOSITION_POLICY.grainMs;
  const sessions = new Map<string, { lastObservedAtMs: number; lastAccountScopeId: string | null }>();
  const cells = new Map<string, GraphDayUsageCell & { costNanousd: number; eventCount: number }>();
  const openers: GraphDayUsageOpener[] = [];
  let previousMs = -Infinity;
  for (const event of events) {
    if (!Number.isSafeInteger(event.observedAtMs) || event.observedAtMs < dayStart
      || event.observedAtMs >= dayStart + 86_400_000 || event.observedAtMs < previousMs
      || !["priced", "unpriced", "unmeasurable"].includes(event.kind)) throw fail();
    previousMs = event.observedAtMs;
    const binStartMs = Math.floor(event.observedAtMs / grain) * grain;
    const prior = event.sessionDigest === null ? undefined : sessions.get(event.sessionDigest);
    const opener = event.sessionDigest !== null && prior === undefined;
    if (event.sessionDigest !== null) {
      if (prior === undefined && sessions.size >= GRAPH_DAY_USAGE_SESSION_LIMIT) {
        throw new GraphDayProjectionRefusedError("usage_session_limit_exceeded");
      }
      sessions.set(event.sessionDigest,
        { lastObservedAtMs: event.observedAtMs, lastAccountScopeId: event.accountScopeId });
    }
    // The reduction drops an unmeasurable record after advancing the carry.
    if (event.kind === "unmeasurable") continue;
    const model = event.kind === "priced" ? event.model : null;
    const costNanousd = model === null ? 0 : event.costNanousd;
    // A cost the reduction itself would refuse on cannot be represented as a
    // day-local sum, so the day is refused rather than folded approximately.
    if (!Number.isSafeInteger(costNanousd) || costNanousd < 0
      || costNanousd > GRAPH_DAY_USAGE_COST_CEILING) {
      throw new GraphDayProjectionRefusedError("usage_cost_limit_exceeded");
    }
    const attribution = { provider: event.provider, accountScopeId: event.accountScopeId,
      planBasis: event.planBasis, planType: event.planType, planEraId: event.planEraId };
    if (opener) {
      openers.push({ sessionDigest: event.sessionDigest!, binStartMs,
        observedAtMs: event.observedAtMs, ...attribution, model, costNanousd });
      continue;
    }
    const accountBreak = prior !== undefined && prior.lastAccountScopeId !== event.accountScopeId;
    const cell: GraphDayUsageCell = { binStartMs, ...attribution, accountBreak, model,
      costNanousd, eventCount: 1 };
    const key = graphDayUsageCellOrder(cell);
    const existing = cells.get(key);
    if (existing === undefined) {
      if (cells.size >= GRAPH_DAY_USAGE_CELL_LIMIT) {
        throw new GraphDayProjectionRefusedError("usage_cell_limit_exceeded");
      }
      cells.set(key, { ...cell });
      continue;
    }
    existing.costNanousd += costNanousd;
    existing.eventCount += 1;
    if (!Number.isSafeInteger(existing.costNanousd)
      || existing.costNanousd > GRAPH_DAY_USAGE_COST_CEILING) {
      throw new GraphDayProjectionRefusedError("usage_cost_limit_exceeded");
    }
  }
  if (openers.length > GRAPH_DAY_USAGE_SESSION_LIMIT) {
    throw new GraphDayProjectionRefusedError("usage_session_limit_exceeded");
  }
  const order = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
  return {
    rowsRead: source.rowsRead,
    cells: [...cells.values()].map((cell) => ({ ...cell }))
      .sort((left, right) => order(graphDayUsageCellOrder(left), graphDayUsageCellOrder(right))),
    openers: [...openers].sort((left, right) => order(left.sessionDigest, right.sessionDigest)),
    sessions: [...sessions].map(([sessionDigest, tail]) => ({ sessionDigest, ...tail }))
      .sort((left, right) => order(left.sessionDigest, right.sessionDigest)),
  };
}

interface DayRunAssignment {
  input: GraphDayQuotaInput;
  signature: string | null;
  runFirstObservedAtMs: number;
  tie: boolean;
}
interface EndpointCandidate extends GraphDayRunEndpoint { stream: string }

/**
 * Reduce one UTC day into its prepared projection.
 *
 * Three rules, each of which the fold depends on:
 *
 * - **Runs.** A day-local run is a maximal consecutive block of one plan
 *   signature, closed at every signature change and at every equal-time
 *   conflict instant — exactly the instants `buildPlanAttributionIndex` can
 *   place an era boundary at. Hulls, fit fragments and run endpoints are all
 *   keyed by the run, not by the signature, so a signature that is interrupted
 *   inside a day and resumes keeps its two eras' evidence separate.
 * - **Endpoints.** A row is dropped only when it is interior to a constant run
 *   under EVERY pooling the window could settle on: the day knows only raw
 *   instants and the fold keys by the settled pool, and neither grouping
 *   refines the other. So a row is kept unless every row of its `(run, slot)`
 *   stream between its own raw-instant neighbours carries its value. Endpoint
 *   spacing is NOT applied: `offer()` is a greedy over the whole window per
 *   key, so the fold applies it to the concatenated days.
 * - **Anchors.** A retained superset, never a reordering. The fold replays
 *   these through the acquisition's own plan collapse, which buffers each
 *   instant's ties and flushes them in its own canonical order, so this must
 *   not collapse a tie away: every anchor at an instant carrying more than one
 *   signature is retained, together with its neighbours. Only an anchor
 *   identical to both neighbours in every field, at an ordinary instant, is
 *   dropped — it cannot be a run boundary, and replaying a superset of run
 *   boundaries through that collapse is idempotent.
 */
export function reduceGraphDayProjection(day: string, rows: readonly GraphDayQuotaInput[],
  usage: GraphDayUsageSource = { events: [], rowsRead: 0 }): GraphDayProjection {
  if (!validGraphDayLabel(day)) throw fail();
  const rowSignatureOf = (row: GraphDayAcquiredRow): string => graphDayPlanSignature({
    contextKey: `${row.provider}|${row.limit_id}`, accountScopeId: row.account_scope_id,
    planType: row.plan_type, planVariant: row.plan_variant, continuityId: row.continuity_id,
    planBasis: row.plan_basis });
  // One pass over the day's instants, assigning every row its run.
  const assigned: DayRunAssignment[] = [];
  let openSignature: string | null = null, openRunFirstMs = 0, lastTimeMs: number | null = null;
  for (let index = 0; index < rows.length;) {
    const instantMs = rows[index]!.observedAtMs;
    if (!Number.isSafeInteger(instantMs) || (lastTimeMs !== null && instantMs < lastTimeMs)) throw fail();
    lastTimeMs = instantMs;
    let end = index;
    while (end < rows.length && rows[end]!.observedAtMs === instantMs) end += 1;
    const group = rows.slice(index, end);
    const signatures = new Set<string>();
    for (const input of group) {
      if (!Number.isSafeInteger(input.sourceRowId) || input.sourceRowId <= 0) throw fail();
      if (input.row && Date.parse(input.row.observed_at) !== instantMs) throw fail();
      const signature = input.anchor ? graphDayPlanSignature(input.anchor)
        : input.row ? rowSignatureOf(input.row) : null;
      if (signature !== null) signatures.add(signature);
    }
    // An instant carrying more than one signature is an indivisible barrier:
    // the index can contradict there, so no run may span it or start before it.
    const tie = signatures.size > 1;
    if (tie) openSignature = null;
    for (const input of group) {
      const signature = input.anchor ? graphDayPlanSignature(input.anchor)
        : input.row ? rowSignatureOf(input.row) : null;
      if (signature === null) {
        assigned.push({ input, signature: null, runFirstObservedAtMs: instantMs, tie });
        continue;
      }
      if (!tie && openSignature !== signature) { openSignature = signature; openRunFirstMs = instantMs; }
      assigned.push({ input, signature,
        runFirstObservedAtMs: tie ? instantMs : openRunFirstMs, tie });
    }
    if (tie) openSignature = null;
    index = end;
  }

  const anchored = assigned.filter((item) => item.input.anchor !== null);
  const fields = anchored.map((item) => anchorFields(item.input.anchor!));
  const retainedAnchors = anchored.filter((item, position) => {
    if (position === 0 || position === anchored.length - 1) return true;
    if (item.tie || anchored[position - 1]!.tie || anchored[position + 1]!.tie) return true;
    return fields[position] !== fields[position - 1] || fields[position] !== fields[position + 1];
  });
  const anchors = retainedAnchors.map((item) => item.input.anchor!);
  if (anchors.length > GRAPH_DAY_PLAN_ANCHOR_LIMIT) {
    throw new GraphDayProjectionRefusedError("plan_anchor_limit_exceeded");
  }
  // An era's lower bound is always a RETAINED anchor instant, and the plan
  // collapse opens a resumed run at the contradicted instant whose anchor the
  // index then discards. So a run that resumes after a conflict begins its era
  // at its LAST retained anchor, and its earlier rows reach no era at all.
  // Splitting the run there as well as at its first retained anchor leaves two
  // units, neither of which spans a retained anchor in its interior — and a
  // unit spanning none is era-uniform. Hulls, fit fragments and endpoints all
  // follow this split, so every run key still reaches an endpoint.
  const lastRetainedAnchor = new Map<string, number>();
  for (const item of retainedAnchors) {
    if (item.signature === null) continue;
    lastRetainedAnchor.set(graphDayRunKey(item.signature, item.runFirstObservedAtMs),
      item.input.observedAtMs);
  }

  const stats = new Map<string, DayFitStats>();
  const candidates: EndpointCandidate[] = [];
  for (const item of assigned) {
    const row = item.input.row;
    if (!row) continue;
    const signature = rowSignatureOf(row);
    // An anchor and its own row always agree on these fields. If a malformed
    // source ever disagreed, the row gets a run of its own rather than joining
    // one whose era was proven from different evidence.
    const openedAtMs = item.signature === signature
      ? item.runFirstObservedAtMs : item.input.observedAtMs;
    const lastAnchorMs = lastRetainedAnchor.get(graphDayRunKey(signature, openedAtMs));
    const runFirstObservedAtMs = lastAnchorMs !== undefined && item.input.observedAtMs >= lastAnchorMs
      ? lastAnchorMs : openedAtMs;
    const runKey = graphDayRunKey(signature, runFirstObservedAtMs);
    const resetsAtMs = Date.parse(row.resets_at);
    if (!Number.isSafeInteger(resetsAtMs)) throw fail();
    // Keyed by the RAW instant: the pool representative is the settled maximum
    // over the whole window and is not day-local.
    addGraphDayFitValue(stats, JSON.stringify([runKey, resetsAtMs]), row.used_percent);
    candidates.push({ signature, runFirstObservedAtMs, slot: row.slot, resetsAtMs,
      sourceRowId: item.input.sourceRowId, observedAtMs: item.input.observedAtMs,
      usedPercent: row.used_percent, row, stream: JSON.stringify([runKey, row.slot]) });
  }

  const streams = new Map<string, EndpointCandidate[]>();
  for (const candidate of candidates) {
    const stream = streams.get(candidate.stream);
    if (stream === undefined) streams.set(candidate.stream, [candidate]); else stream.push(candidate);
  }
  const kept = new Set<EndpointCandidate>();
  for (const stream of streams.values()) {
    // `constantFrom[i]`: the earliest position from which stream[..i] is one
    // constant value. `[before,after]` is constant exactly when it is <= before.
    const constantFrom: number[] = new Array(stream.length);
    for (let index = 0; index < stream.length; index += 1) {
      constantFrom[index] = index > 0 && stream[index]!.usedPercent === stream[index - 1]!.usedPercent
        ? constantFrom[index - 1]! : index;
    }
    const before: number[] = new Array(stream.length), after: number[] = new Array(stream.length);
    const seen = new Map<number, number>();
    for (let index = 0; index < stream.length; index += 1) {
      before[index] = seen.get(stream[index]!.resetsAtMs) ?? -1;
      seen.set(stream[index]!.resetsAtMs, index);
    }
    seen.clear();
    for (let index = stream.length - 1; index >= 0; index -= 1) {
      after[index] = seen.get(stream[index]!.resetsAtMs) ?? -1;
      seen.set(stream[index]!.resetsAtMs, index);
    }
    for (let index = 0; index < stream.length; index += 1) {
      // No raw-instant neighbour on one side: the row bounds its own pooled run
      // under some pooling, so it can never be proven interior.
      if (before[index]! < 0 || after[index]! < 0
        || constantFrom[after[index]!]! > before[index]!) kept.add(stream[index]!);
    }
  }
  const endpoints: GraphDayRunEndpoint[] = candidates.filter((candidate) => kept.has(candidate))
    .map(({ stream, ...endpoint }) => { void stream; return endpoint; });
  if (endpoints.length > GRAPH_DAY_RUN_ENDPOINT_LIMIT) {
    throw new GraphDayProjectionRefusedError("run_endpoint_limit_exceeded");
  }

  const fragments: GraphDayFitFragment[] = [...stats].map(([key, stat]) => {
    const [runKey, resetsAtMs] = JSON.parse(key) as [string, number];
    const [signature, runFirstObservedAtMs] = JSON.parse(runKey) as [string, number];
    return { signature, runFirstObservedAtMs, resetsAtMs, minimum: stat.minimum,
      maximum: stat.maximum, values: [...stat.values] };
  }).sort((left, right) => (graphDayFitFragmentOrder(left) < graphDayFitFragmentOrder(right) ? -1 : 1));
  const projection: GraphDayProjection = {
    version: GRAPH_DAY_PROJECTION_VERSION, day,
    planAnchors: { anchors },
    fitFragments: { fragments },
    runEndpoints: { endpoints },
    usage: reduceGraphDayUsage(day, usage),
  };
  if (!validGraphDayProjection(projection)) throw fail();
  return projection;
}

/**
 * The production build for a WHOLE source, resolving each candidate owner's
 * generation snapshot itself.
 *
 * Analytics never holds a participant identifier, so the owner digest is
 * bridged back through `storage_v11_owner_links` in the source database — the
 * same mapping owner erasure uses — and the pin and snapshot are then the
 * reader's own. Resolution is memoized per pass, so a multi-day owner pays for
 * it once. An owner whose link, pin or snapshot is absent is skipped rather
 * than guessed at: it simply has no prepared day this pass.
 */
export function createGraphDayProjectionSourceBuild(options: {
  source: D1Database; sourceNamespace: string; nowMs?: number; maxQuotaRows?: number;
  now?: () => number;
}): GraphDayProjectionBuild {
  const resolved = new Map<string, GraphDayProjectionBuild | null>();
  const now = options.now ?? Date.now;
  return async (candidate, budget) => {
    checkKey(candidate);
    if (candidate.sourceNamespace !== options.sourceNamespace) throw fail();
    let build = resolved.get(candidate.ownerDigest);
    if (build === undefined) {
      build = null;
      // Resolution is three source statements for a new owner; it comes out of
      // the same pass allowance the pages do, or the graph lane pays for it.
      spend(budget, now);
      const link = await options.source
        .prepare("SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=?")
        .bind(candidate.ownerDigest).first<string>("participant_id");
      if (link) {
        spend(budget, now);
        const pin = await loadV11SourcePin(options.source, link);
        if (pin && pin.source === "v1.1") {
          spend(budget, now);
          const snapshot = await loadTypedV11GenerationSnapshot(options.source,
            { sourceNamespace: options.sourceNamespace, pin });
          // The window is the kernel's own, never a constant restated here: a
          // prepared day must retain exactly the rows the acquisition admits.
          const identity = createV11QuotaAcquisitionIdentity(pin, options.nowMs ?? Date.now(),
            options.maxQuotaRows);
          build = createGraphDayProjectionBuild({ source: options.source,
            sourceNamespace: options.sourceNamespace, snapshot,
            windowMinutes: identity.windowMinutes, ownerDigest: candidate.ownerDigest });
        }
      }
      resolved.set(candidate.ownerDigest, build);
    }
    if (build === null) throw new GraphDayProjectionRefusedError("owner_source_unavailable");
    return build(candidate, budget);
  };
}

/** One candidate day: a delivered v1.1 day with no current prepared row. */
export interface GraphDayProjectionCandidate extends GraphDayProjectionKey {}

/** The day builder. `createGraphDayProjectionBuild` below is the production
 * one; the lane still takes it as a parameter so a test can drive the store
 * without a source database. */
export interface GraphDayProjectionBuildBudget {
  /** The lane's own deadline. The build checks it between source pages. */
  readonly deadlineMs: number;
  /** Source statements this pass may still spend on building. The build
   * decrements it per page, so several days share one pass allowance. */
  remainingQueries: number;
}
export type GraphDayProjectionBuild = (candidate: GraphDayProjectionCandidate,
  budget: GraphDayProjectionBuildBudget) => Promise<GraphDayProjection>;

/** The build ran out of the pass's source allowance or reached its deadline.
 * Distinct from a refusal: the day is not unrepresentable, it simply did not
 * fit this pass, and nothing was written. */
export class GraphDayProjectionDeferredError extends Error {
  readonly code = "GRAPH_DAY_PROJECTION_DEFERRED";
  constructor(readonly reason: "deadline" | "query_budget") { super("prepared graph day deferred"); }
}
function spend(budget: GraphDayProjectionBuildBudget, now: () => number): void {
  if (now() >= budget.deadlineMs) throw new GraphDayProjectionDeferredError("deadline");
  if (budget.remainingQueries < 1) throw new GraphDayProjectionDeferredError("query_budget");
  budget.remainingQueries -= 1;
}

/**
 * The opaque session key the usage half is stored under.
 *
 * A raw `session_uuid` is session content and must never reach a derived
 * artifact, so the store only ever sees this digest; the reduction compares
 * session keys for equality and never reads them. Owner-scoped, following the
 * v1 projection's own `scoped()` derivation, so one uuid under two owners
 * cannot collide inside the store.
 */
export const GRAPH_DAY_SESSION_DIGEST_METHOD = "graph-day-projection-session-v1";
export async function graphDayUsageSessionDigest(input: { ownerDigest: string; provider: string;
  sessionUuid: string }): Promise<string> {
  if (!HASH.test(input.ownerDigest) || typeof input.provider !== "string"
    || typeof input.sessionUuid !== "string" || input.sessionUuid.length === 0) throw fail();
  return sha256Hex(canonicalJson({ method: GRAPH_DAY_SESSION_DIGEST_METHOD, kind: "session",
    ownerDigest: input.ownerDigest, value: [input.provider, input.sessionUuid] }));
}

/** A day's usage events. The production reader below builds these from the
 * kernel's own `v11PreparedUsageDayRow`; the seam stays open so a test can
 * drive the store without a source database. */
export interface GraphDayUsageSource {
  readonly events: readonly GraphDayUsageInput[];
  /** Rows the day's usage read returned, including every row the mapper
   * skipped or refused. See `GraphDayUsageFragments.rowsRead`. */
  readonly rowsRead: number;
}
export type GraphDayUsageDayReader = (input: { candidate: GraphDayProjectionCandidate;
  fromObservedAtMs: number; beforeObservedAtMs: number;
  budget: GraphDayProjectionBuildBudget; now: () => number }) => Promise<GraphDayUsageSource>;

/**
 * The production usage reader: one UTC day of v1.1 usage rows, paged through
 * `readTypedV11UsageAnalysisPage` and mapped by the kernel's own
 * `v11PreparedUsageDayRow`, with `graphDayUsageSessionDigest` as the session
 * hook so no raw `session_uuid` crosses this boundary.
 *
 * A row the mapper refuses refuses the day: the reduction would have refused
 * the whole window on it, and a prepared day that quietly dropped it would be
 * folded as complete evidence.
 */
export function createGraphDayUsageDayReader(options: {
  source: D1Database; sourceNamespace: string; snapshot: V11GenerationSnapshot;
  ownerDigest: string; maxPages?: number;
}): GraphDayUsageDayReader {
  const maxPages = options.maxPages ?? 512;
  bounded(maxPages, 1, 4_096);
  if (!HASH.test(options.ownerDigest)
    || options.snapshot.sourceNamespace !== options.sourceNamespace) throw fail();
  return async ({ candidate, fromObservedAtMs, beforeObservedAtMs, budget, now }) => {
    if (candidate.day < options.snapshot.fromDay || candidate.day > options.snapshot.throughDay) {
      return { events: [], rowsRead: 0 };
    }
    const events: GraphDayUsageInput[] = [];
    let rowsRead = 0;
    const sessions = new Set<string>();
    let afterTime = new Date(fromObservedAtMs).toISOString(), afterOccurrence = "";
    for (let page = 0; page < maxPages; page += 1) {
      spend(budget, now);
      const rows = await readTypedV11UsageAnalysisPage(options.source, {
        sourceNamespace: options.sourceNamespace, snapshot: options.snapshot, day: candidate.day,
        from: new Date(fromObservedAtMs).toISOString(), to: new Date(beforeObservedAtMs).toISOString(),
        afterTime, afterOccurrence, fenceSnapshot: false });
      for (const row of rows) {
        // Counted before the mapper, so a skipped or refused row still counts
        // against the same bound the streaming path metered it against.
        rowsRead += 1;
        const mapped = await v11PreparedUsageDayRow(row, (provider, sessionUuid) =>
          graphDayUsageSessionDigest({ ownerDigest: options.ownerDigest, provider, sessionUuid }),
          sessions, GRAPH_DAY_USAGE_SESSION_LIMIT);
        if (mapped.status === "refused") throw new GraphDayProjectionRefusedError("usage_row_refused");
        if (mapped.status === "row") {
          const prepared = mapped.row;
          events.push({ sessionDigest: prepared.sessionDigest, observedAtMs: prepared.observedAtMs,
            provider: prepared.provider, accountScopeId: prepared.accountScopeId,
            planBasis: prepared.planBasis, planType: prepared.planType, planEraId: prepared.planEraId,
            kind: prepared.model === null ? "unpriced" : "priced",
            model: prepared.model, costNanousd: prepared.costNanousd });
        } else if (mapped.session !== null) {
          // A dropped row still advanced the reduction's session carry, and the
          // mapper reports the instant and scope it advanced it to. Closing the
          // day's carry-out with those is exact; inferring it from the
          // session's previous scope would not be, and an account break that
          // exists only because of a dropped last event would be lost.
          events.push({ sessionDigest: mapped.session.sessionDigest,
            observedAtMs: mapped.session.observedAtMs, provider: row.provider,
            accountScopeId: mapped.session.accountScopeId, planBasis: null, planType: null,
            planEraId: null, kind: "unmeasurable", model: null, costNanousd: 0 });
        }
        afterTime = row.observed_at;
        afterOccurrence = row.occurrence_id;
      }
      if (rows.length < TYPED_V11_ANALYSIS_PAGE_SIZE) {
        spend(budget, now);
        await assertTypedV11GenerationSnapshotLive(options.source, options.snapshot);
        return { events, rowsRead };
      }
    }
    throw new GraphDayProjectionRefusedError("usage_cell_limit_exceeded");
  };
}

/**
 * The production day builder.
 *
 * Quota rows come from `createTypedV11QuotaPageReader` scoped to the UTC day
 * and mapped by the kernel's own `v11PreparedDayRow`, so the artifact and the
 * paged acquisition cannot disagree about which rows exist. The generation
 * snapshot is the graph work selection's own, so the builder prepares exactly
 * the evidence the lane will fold.
 */
export function createGraphDayProjectionBuild(options: {
  source: D1Database; sourceNamespace: string; snapshot: V11GenerationSnapshot;
  windowMinutes: number; ownerDigest: string; maxPages?: number; now?: () => number;
  /** Test seam only: production derives the reader from the kernel mapper. */
  usage?: GraphDayUsageDayReader;
}): GraphDayProjectionBuild {
  const maxPages = options.maxPages ?? 64;
  bounded(maxPages, 1, 1_024);
  if (!Number.isSafeInteger(options.windowMinutes) || options.windowMinutes < 1
    || options.snapshot.sourceNamespace !== options.sourceNamespace) throw fail();
  const usage = options.usage ?? createGraphDayUsageDayReader({ source: options.source,
    sourceNamespace: options.sourceNamespace, snapshot: options.snapshot,
    ownerDigest: options.ownerDigest });
  const now = options.now ?? Date.now;
  return async (candidate, budget) => {
    checkKey(candidate);
    if (candidate.sourceNamespace !== options.sourceNamespace || !Number.isFinite(budget.deadlineMs)
      || !Number.isSafeInteger(budget.remainingQueries)) throw fail();
    const fromObservedAtMs = Date.parse(`${candidate.day}T00:00:00.000Z`);
    const beforeObservedAtMs = fromObservedAtMs + 86_400_000;
    const reader = await createTypedV11QuotaPageReader(options.source, {
      sourceNamespace: options.sourceNamespace, snapshot: options.snapshot,
      fenceSnapshotPages: false, fromObservedAtMs, beforeObservedAtMs });
    const rows: GraphDayQuotaInput[] = [];
    let cursor = { observedAtMs: fromObservedAtMs, sourceRowId: 0 };
    for (let page = 0; page < maxPages; page += 1) {
      spend(budget, now);
      const physical = await reader.readPage(cursor, reader.pageSize);
      for (const row of physical) {
        rows.push(v11PreparedDayRow(row, options.windowMinutes));
        cursor = { observedAtMs: row.observedAtMs, sourceRowId: row.sourceRowId };
      }
      if (physical.length < reader.pageSize) {
        // The snapshot is fenced once per day rather than per page, matching
        // the graph group's own fence, so a retired generation cannot be
        // prepared as if it were live. The fence is a source statement too.
        spend(budget, now);
        await assertTypedV11GenerationSnapshotLive(options.source, options.snapshot);
        return reduceGraphDayProjection(candidate.day, rows,
          await usage({ candidate, fromObservedAtMs, beforeObservedAtMs, budget, now }));
      }
    }
    // A day that needs more pages than the bound is refused, never truncated
    // into an artifact the fold would read as a complete day.
    throw new GraphDayProjectionRefusedError("run_endpoint_limit_exceeded");
  };
}

export interface GraphDayProjectionLaneResult {
  state: "idle" | "progress" | "deferred";
  reason: "complete" | "deadline" | "query_budget" | "day_limit";
  built: number;
  staged: number;
  /** Days this pass could not prepare at all. They are skipped, not retried in
   * this pass, and they never stall the other candidates. */
  refused: number;
  candidates: number;
}

/**
 * One bounded, resumable projection-building page.
 *
 * Resumption is durable without a cursor table: a day that was only partly
 * written has pages but no values row, so the next pass re-frames the same
 * immutable projection and continues from the pages already present. The lane
 * stops on its deadline or its own sub-budget and reports which stopped it; it
 * never partially promotes a day.
 */
export async function advanceGraphDayProjectionLane(options: {
  target: D1Database; sourceId: string; build: GraphDayProjectionBuild;
  deadlineMs: number; remainingQueries: number; maxDays?: number; maxWrites?: number;
  fromDay?: string; now?: () => number;
  /** Source statements this pass may spend BUILDING, separate from the target
   * statements the lane's own meter covers. The build reads the source, which
   * the lane does not wrap, so its cost is bounded here or not at all. */
  sourceQueries?: number;
}): Promise<GraphDayProjectionLaneResult> {
  const { target, sourceId, build } = options;
  const maxDays = options.maxDays ?? 4, maxWrites = options.maxWrites ?? 8;
  bounded(maxDays, 1, 64);
  bounded(maxWrites, 2, GRAPH_DAY_PROJECTION_MAX_WRITES);
  if (typeof build !== "function" || !Number.isFinite(options.deadlineMs)
    || !Number.isSafeInteger(options.remainingQueries) || options.remainingQueries < 0
    || (options.fromDay !== undefined && !validGraphDayLabel(options.fromDay))) throw fail();
  const now = (): number => {
    const value = (options.now ?? Date.now)();
    if (!Number.isFinite(value)) throw fail();
    return value;
  };
  let built = 0, staged = 0, refused = 0;
  // One selection statement plus, per day, a read-back, its write batch and the
  // promotion check. Refuse to open the lane below that.
  if (options.remainingQueries < 4) return { state: "deferred", reason: "query_budget", built, staged, refused, candidates: 0 };
  if (now() >= options.deadlineMs) return { state: "deferred", reason: "deadline", built, staged, refused, candidates: 0 };
  const candidates = (await target.prepare(`SELECT DISTINCT v.source_id,v.source_layout,v.source_namespace,
      v.owner_digest,v.device_id,v.manifest_id,v.manifest_digest,v.day
    FROM analytics_v11_reusable_values v
    JOIN analytics_owner_state o ON o.source_id=v.source_id AND o.owner_digest=v.owner_digest AND o.state='active'
    WHERE v.source_id=?1 AND (?2 IS NULL OR v.day>=?2)
      AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
        WHERE f.source_id=v.source_id AND f.owner_digest=v.owner_digest)
      AND NOT EXISTS(SELECT 1 FROM analytics_graph_day_values g
        WHERE g.source_id=v.source_id AND g.owner_digest=v.owner_digest AND g.day=v.day
          AND g.acquisition_version=?3 AND g.source_layout=v.source_layout
          AND g.source_namespace=v.source_namespace AND g.device_id=v.device_id
          AND g.manifest_id=v.manifest_id AND g.manifest_digest=v.manifest_digest)
      AND NOT EXISTS(SELECT 1 FROM analytics_graph_day_refusals r
        WHERE r.source_id=v.source_id AND r.owner_digest=v.owner_digest AND r.day=v.day
          AND r.manifest_digest=v.manifest_digest AND r.acquisition_version=?3)
    ORDER BY v.day,v.owner_digest,v.device_id LIMIT ?4`)
    .bind(sourceId, options.fromDay ?? null, GRAPH_DAY_PROJECTION_VERSION, maxDays)
    .all<{ source_id: string; source_layout: string; source_namespace: string; owner_digest: string;
      device_id: string; manifest_id: string; manifest_digest: string; day: string }>()).results;
  if (!candidates.length) return { state: "idle", reason: "complete", built, staged, refused, candidates: 0 };
  // One day costs at most a values read, a staged-parts read, one write batch
  // and the promotion check. The lane refuses to OPEN a day it cannot pay for
  // in full, so a pass never ends with a day half written; a day that still
  // needs another batch keeps its pages and no values row, which is exactly
  // what the next pass resumes from.
  // One extra statement per day for the refusal record.
  const perDay = 4 + maxWrites;
  let affordable = options.remainingQueries - 1;
  const sourceBudget: GraphDayProjectionBuildBudget = { deadlineMs: options.deadlineMs,
    remainingQueries: options.sourceQueries ?? 256 };
  for (const row of candidates) {
    if (affordable < perDay) {
      return { state: built + staged ? "progress" : "deferred", reason: "query_budget", built, staged,
        refused, candidates: candidates.length };
    }
    affordable -= perDay;
    if (now() >= options.deadlineMs) {
      return { state: built + staged ? "progress" : "deferred", reason: "deadline", built, staged,
        refused, candidates: candidates.length };
    }
    if (row.source_id !== sourceId) throw fail();
    const candidate: GraphDayProjectionCandidate = { sourceId, sourceLayout: row.source_layout as "typed-v11",
      sourceNamespace: row.source_namespace, ownerDigest: row.owner_digest, deviceId: row.device_id,
      manifestId: row.manifest_id, manifestDigest: row.manifest_digest, day: row.day };
    checkKey(candidate);
    let projection: GraphDayProjection;
    try {
      projection = await build(candidate, sourceBudget);
    } catch (error) {
      // A deferred build wrote nothing, so the pass simply ends here and the
      // next one starts this day again.
      if (error instanceof GraphDayProjectionRefusedError) {
        // Record it before moving on. A refusal that is only skipped is
        // rediscovered every pass, and enough of them at the earliest dates
        // stall the oldest-first selection permanently.
        refused += 1;
        await target.prepare(`INSERT INTO analytics_graph_day_refusals
          (source_id,owner_digest,day,manifest_digest,acquisition_version,reason,refused_ms)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
          .bind(sourceId, candidate.ownerDigest, candidate.day, candidate.manifestDigest,
            GRAPH_DAY_PROJECTION_VERSION, error.reason, Math.max(0, Math.trunc(now()))).run();
        console.log(JSON.stringify({ event: "graph_day_projection_refused", reason: error.reason }));
        continue;
      }
      if (!(error instanceof GraphDayProjectionDeferredError)) throw error;
      return { state: built + staged ? "progress" : "deferred", reason: error.reason, built, staged,
        refused, candidates: candidates.length };
    }
    const result = await writeGraphDayProjection({ target, key: candidate, projection, maxWrites });
    if (result.status === "stored") built += 1; else staged += 1;
  }
  // A pass that only refused still advanced: it recorded refusals the next
  // selection excludes. Reporting idle there would claim the lane is complete.
  return { state: "progress", reason: candidates.length < maxDays ? "complete" : "day_limit",
    built, staged, refused, candidates: candidates.length };
}
