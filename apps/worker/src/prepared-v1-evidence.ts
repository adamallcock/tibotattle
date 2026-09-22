import { APP_PRICE_REGISTRY_MANIFEST } from "@app-usagemonitor/accounting";
import { MODEL_COMPOSITION_POLICY } from "@app-usagemonitor/quota-analysis";
import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import { D1InvocationBudgetExceededError } from "./d1-invocation-budget";
import { SERVER_PRICING_METHOD_VERSION } from "./server-pricing";
import { loadV1SourcePin, type V1SourceDayDependency, type V1SourcePin } from "./telemetry-v1-source-selection";
import { prepareQuotaPage, prepareUsagePage, type PreparationQuotaRow, type PreparedQuotaRuns } from "./prepared-v1-day";
import type { V1FitSourceRow, V1PlanSourceRow, V1QuotaInvocationBudget, V1QuotaPageReader } from "./quota-analysis-v1-reader";
import type {
  V1PreparedFinishEvidence,
  V1PreparedUsageFragment,
  V1PreparedUsageReader,
  V1PreparedUsageBinsReader,
  WindowedUsageRow,
} from "./quota-analysis-v1";
import type {
  PreparedSourceStore,
  PreparedSourceControl,
  PreparedSourceOutput,
  PreparedSourceOutputKind,
  PreparedSourceStream,
  PreparedSourceWindow,
  StorageSourcePage,
  StorageSourcePin,
  StorageSourceRecord,
  StorageSourceStore,
  StorageJsonValue,
} from "./storage-provider-ports";

export const V1_PREPARED_READER_POLICY = "prepared-source-days-1";
export const V1_PREPARATION_METHOD_VERSION = `prepared-source-day-1:${SERVER_PRICING_METHOD_VERSION}:${APP_PRICE_REGISTRY_MANIFEST.sha256}`;
export const V1_PREPARATION_PAGE_SIZE = 256;
const MAX_PAGES = 64, encoder = new TextEncoder();
export function canPrepareV1Window(pin: V1SourcePin): boolean {
  return "participantId" in pin.scope && pin.inputRevision !== null && pin.winners.length <= 128;
}
const TABLES = ["community_prepared_plan_rows", "community_prepared_fit_rows",
  "community_prepared_usage_rows", "community_prepared_usage_bins"] as const;
const SOURCE_GUARD = `EXISTS (SELECT 1 FROM participants p
  JOIN community_analytical_input_versions v ON v.participant_id=p.id
  WHERE p.id=?1 AND p.state='active' AND v.revision=?2
    AND NOT EXISTS (SELECT 1 FROM telemetry_v11_domain_heads d WHERE d.participant_id=p.id))`;
const HEAD_GUARD = `EXISTS (SELECT 1 FROM community_prepared_source_days h
  WHERE h.participant_id=?1 AND h.source_day=?3 AND h.generation=?4
    AND h.progress_revision=?5 AND h.control_sha256=?6) AND ${SOURCE_GUARD}`;
type Dependency = V1SourceDayDependency & { generation: string };
interface Head {
  participant_id: string; source_day: string; generation: string; source_fingerprint: string;
  method_version: string; device_id: string; phase: "quota" | "usage" | "complete" | "discarding";
  progress_revision: number; cursor_time: string; cursor_id: number; quota_count: number; usage_count: number;
  plan_count: number; fit_count: number; fragment_count: number; control_json: string; control_sha256: string;
}

export type V1PreparedEvidenceUnavailableReason =
  | "invalid_evidence"
  | "source_not_current"
  | "control_invalid"
  | "day_count_mismatch"
  | "correction_unavailable";

export class V1PreparedEvidenceUnavailableError extends Error {
  readonly code = "V1_PREPARED_EVIDENCE_UNAVAILABLE";
  readonly reason: V1PreparedEvidenceUnavailableReason;
  constructor(reason: V1PreparedEvidenceUnavailableReason = "invalid_evidence") {
    super("v1 prepared evidence unavailable");
    this.reason = reason === "source_not_current" || reason === "control_invalid" || reason === "day_count_mismatch"
      || reason === "correction_unavailable"
      ? reason : "invalid_evidence";
  }
}
function unavailable(reason: V1PreparedEvidenceUnavailableReason = "invalid_evidence"): never {
  throw new V1PreparedEvidenceUnavailableError(reason);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function safeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function validTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function validateRow(value: unknown, fit: boolean): void {
  if (!record(value) || !exactKeys(value, ["id", "observed_at", "observed_day", "device_id", "provider", "limit_id",
    "plan_type", "plan_variant", ...(fit ? ["occurrence_id", "slot", "used_percent", "window_duration_minutes", "resets_at"] : [])])
    || !safeCount(value.id) || value.id === 0 || !validTime(value.observed_at)
    || value.observed_day !== value.observed_at.slice(0, 10) || typeof value.device_id !== "string") unavailable("control_invalid");
  for (const key of ["provider", "limit_id", "plan_type", "plan_variant"]) {
    if (typeof value[key] !== "string" && (fit || value[key] !== null)) unavailable("control_invalid");
  }
  if (fit && (typeof value.occurrence_id !== "string" || typeof value.slot !== "string"
    || typeof value.used_percent !== "number" || !Number.isFinite(value.used_percent)
    || value.window_duration_minutes !== 10080 || !validTime(value.resets_at))) unavailable("control_invalid");
}
async function runsForHead(head: Head): Promise<PreparedQuotaRuns> {
  if (!safeCount(head.progress_revision) || !safeCount(head.cursor_id) || !validTime(head.cursor_time)
    || ![head.quota_count, head.usage_count, head.plan_count, head.fit_count, head.fragment_count].every(safeCount)
    || encoder.encode(head.control_json).byteLength > 16384 || await sha256Hex(head.control_json) !== head.control_sha256) unavailable("control_invalid");
  const value: unknown = JSON.parse(head.control_json);
  if (!record(value) || !exactKeys(value, ["plan", "fit", "lastTime", "lastSignature", "equalTimeChanged"])
    || value.lastTime !== null && !validTime(value.lastTime)
    || value.lastSignature !== null && typeof value.lastSignature !== "string"
    || typeof value.equalTimeChanged !== "boolean") unavailable("control_invalid");
  for (const key of ["plan", "fit"] as const) {
    const run = value[key];
    if (run === null) continue;
    if (!record(run) || !exactKeys(run, ["first", "last"])) unavailable("control_invalid");
    validateRow(run.first, key === "fit"); validateRow(run.last, key === "fit");
  }
  return value as unknown as PreparedQuotaRuns;
}

async function dependencies(db: D1Database, pin: V1SourcePin): Promise<Dependency[]> {
  if (!("participantId" in pin.scope) || pin.inputRevision === null) unavailable("source_not_current");
  if (!canPrepareV1Window(pin)) unavailable();
  const participantId = pin.scope.participantId;
  let items = pin.dayDependencies;
  if (!items) {
    const loaded = await loadV1SourcePin(db, pin.scope, { includeDayDependencies: true });
    if (loaded.fingerprint !== pin.fingerprint || loaded.inputRevision !== pin.inputRevision) unavailable("source_not_current");
    items = loaded.dayDependencies!;
  }
  if (items.length !== pin.winners.length) unavailable("source_not_current");
  return Promise.all(items.map(async (item, index) => {
    const winner = pin.winners[index];
    if (item.participantId !== participantId || item.day !== winner?.observed_day
      || item.deviceId !== winner.device_id || !/^[0-9a-f]{64}$/u.test(item.fingerprint)) unavailable("source_not_current");
    return { ...item, generation: await sha256Hex(canonicalJson([V1_PREPARATION_METHOD_VERSION, item.fingerprint])) };
  }));
}

/** One exact day-vector lookup, not one readiness round trip per day. */
async function readHeads(db: D1Database, participantId: string, revision: number, days: Dependency[]): Promise<Map<string, Head>> {
  const result = await db.prepare(`SELECT h.*, json_extract(d.value,'$.day') AS requested_day
    FROM json_each(?3) d LEFT JOIN community_prepared_source_days h
      ON h.participant_id=?1 AND h.source_day=json_extract(d.value,'$.day')
    WHERE ${SOURCE_GUARD}`).bind(participantId, revision, JSON.stringify(days.length ? days : [{ day: "" }])).all<Head & { requested_day: string }>();
  if (result.results.length !== Math.max(days.length, 1)) unavailable("source_not_current");
  return new Map(result.results.filter(row => row.generation !== null).map(({ requested_day: _day, ...row }) => [row.source_day, row]));
}

/** Physical LIMIT precedes winner filtering, so losing prefixes advance the
 * durable cursor. The two index seeks execute in one bounded D1 statement. */
export const V1_PREPARATION_SOURCE_PAGE_SQL = `WITH same_time AS MATERIALIZED (
  SELECT r.* FROM telemetry_v1_records r INDEXED BY telemetry_v1_records_participant_stream_observed
  WHERE r.participant_id=?1 AND r.stream=?2 AND r.observed_at=?3 AND r.id>?4 AND r.observed_at<?6
  ORDER BY r.id LIMIT ?5
), later AS MATERIALIZED (
  SELECT r.* FROM telemetry_v1_records r INDEXED BY telemetry_v1_records_participant_stream_observed
  WHERE r.participant_id=?1 AND r.stream=?2 AND r.observed_at>?3 AND r.observed_at<?6
  ORDER BY r.observed_at,r.id LIMIT (SELECT ?5-COUNT(*) FROM same_time)
)
SELECT id,observed_at,observed_day,device_id,provider,limit_id,plan_type,plan_variant,
  occurrence_id,slot,used_percent,window_duration_minutes,resets_at,session_uuid,record_json
FROM same_time UNION ALL
SELECT id,observed_at,observed_day,device_id,provider,limit_id,plan_type,plan_variant,
  occurrence_id,slot,used_percent,window_duration_minutes,resets_at,session_uuid,record_json
FROM later ORDER BY observed_at,id`;

function guardBindings(pin: V1SourcePin, head: Head): (string | number)[] {
  return [head.participant_id, pin.inputRevision!, head.source_day, head.generation,
    head.progress_revision, head.control_sha256];
}
function insertRows(db: D1Database, table: typeof TABLES[number], fields: string[], values: unknown[][],
  bindings: (string | number)[]): D1PreparedStatement {
  return db.prepare(`INSERT INTO ${table}(participant_id,source_day,generation,${fields.join(",")})
    SELECT ?1,?3,?4,${fields.map((_, i) => `json_extract(j.value,'$[${i}]')`).join(",")}
    FROM json_each(?7) j WHERE ${HEAD_GUARD}`)
    .bind(...bindings, JSON.stringify(values));
}

export interface V1PreparationOptions {
  maxPages: number;
  pageSize?: number;
  deadlineMs: number;
  now?: () => number;
  /** Optional phase allocation; the supplied DB still uses the invocation's
   * actual-statement meter, which atomically admits complete write batches. */
  budget?: V1QuotaInvocationBudget;
}

export async function ensurePreparedV1Window(db: D1Database, pin: V1SourcePin, options: V1PreparationOptions): Promise<{
  status: "complete" | "deferred"; pagesRun: number; queriesUsed: number; daysComplete: number; daysTotal: number;
}> {
  const pageSize = options.pageSize ?? V1_PREPARATION_PAGE_SIZE, now = options.now ?? Date.now;
  if (!Number.isInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > MAX_PAGES
    || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > V1_PREPARATION_PAGE_SIZE
    || !Number.isFinite(options.deadlineMs)) throw new TypeError("v1 preparation budget invalid");
  let pagesRun = 0, queriesUsed = 0, daysComplete = 0, daysTotal = pin.winners.length;
  const result = (status: "complete" | "deferred") => ({ status, pagesRun, queriesUsed, daysComplete, daysTotal });
  const spend = (count: number) => {
    if (now() >= options.deadlineMs || options.budget && options.budget.remainingQueries < count) throw new D1InvocationBudgetExceededError();
    if (options.budget) options.budget.remainingQueries -= count;
    queriesUsed += count;
  };
  try {
    if (!pin.dayDependencies) spend(2);
    const days = await dependencies(db, pin); daysTotal = days.length;
    const participantId = "participantId" in pin.scope ? pin.scope.participantId : unavailable();
    spend(1);
    const heads = await readHeads(db, participantId, pin.inputRevision!, days);
    for (const day of days) {
      let head = heads.get(day.day);
      if (head && head.generation === day.generation && head.phase === "complete") { daysComplete += 1; continue; }
      while (head && (head.generation !== day.generation || head.phase === "discarding")) {
        if (pagesRun >= options.maxPages) return result("deferred");
        // All four deletes share the pinned head/source guard. LIMIT bounds
        // every child-table mutation; head removal occurs only when empty.
        const previousBindings = guardBindings(pin, head);
        head = { ...head, phase: "discarding", progress_revision: head.progress_revision + 1 };
        const bindings = guardBindings(pin, head);
        const retiringGuard = `${HEAD_GUARD} AND EXISTS (SELECT 1 FROM community_prepared_source_days h
          WHERE h.participant_id=?1 AND h.source_day=?3 AND h.generation=?4 AND h.phase='discarding')`;
        const batch = [db.prepare(`UPDATE community_prepared_source_days SET phase='discarding',progress_revision=progress_revision+1
          WHERE participant_id=?1 AND source_day=?3 AND generation=?4 AND ${HEAD_GUARD}`).bind(...previousBindings),
          ...TABLES.map(table => db.prepare(`DELETE FROM ${table}
          WHERE participant_id=?1 AND source_day=?3 AND generation=?4 AND id IN
            (SELECT id FROM ${table} WHERE participant_id=?1 AND source_day=?3 AND generation=?4 ORDER BY id LIMIT ?7)
            AND ${retiringGuard}`).bind(...bindings, V1_PREPARATION_PAGE_SIZE))];
        batch.push(db.prepare(`DELETE FROM community_prepared_source_days WHERE participant_id=?1 AND source_day=?3
          AND generation=?4 AND ${retiringGuard} ${TABLES.map(table => `AND NOT EXISTS (SELECT 1 FROM ${table}
            WHERE participant_id=?1 AND source_day=?3 AND generation=?4)`).join(" ")} RETURNING 1 AS applied`).bind(...bindings));
        spend(batch.length);
        const deleted = await db.batch(batch); pagesRun += 1;
        if (deleted.at(-1)!.results.length === 1) head = undefined;
        else if (deleted.slice(1).every(item => item.meta.changes === 0)) return result("deferred");
      }
      if (!head) {
        if (pagesRun >= options.maxPages) return result("deferred");
        const control = canonicalJson({ plan: null, fit: null, lastTime: null, lastSignature: null, equalTimeChanged: false });
        head = { participant_id: participantId, source_day: day.day, generation: day.generation,
          source_fingerprint: day.fingerprint, method_version: V1_PREPARATION_METHOD_VERSION, device_id: day.deviceId,
          phase: "quota", progress_revision: 0, cursor_time: `${day.day}T00:00:00.000Z`, cursor_id: 0,
          quota_count: 0, usage_count: 0, plan_count: 0, fit_count: 0, fragment_count: 0,
          control_json: control, control_sha256: await sha256Hex(control) };
        spend(1);
        const created = await db.prepare(`INSERT INTO community_prepared_source_days
          (participant_id,source_day,generation,source_fingerprint,method_version,device_id,phase,progress_revision,
           cursor_time,cursor_id,quota_count,usage_count,plan_count,fit_count,fragment_count,control_json,control_sha256)
          SELECT ?1,?3,?4,?5,?6,?7,'quota',0,?8,0,0,0,0,0,0,?9,?10 WHERE ${SOURCE_GUARD}
          ON CONFLICT(participant_id,source_day) DO NOTHING RETURNING 1 AS applied`)
          .bind(participantId, pin.inputRevision, day.day, day.generation, day.fingerprint,
            V1_PREPARATION_METHOD_VERSION, day.deviceId, head.cursor_time, control, head.control_sha256).run();
        // RETURNING acknowledges only the guarded head mutation. D1's change
        // count also includes transactional preparation-counter trigger writes.
        if (created.results.length !== 1) return result("deferred");
      }
      while (head.phase !== "complete") {
        if (pagesRun >= options.maxPages) return result("deferred");
        const runs = await runsForHead(head), previous = head;
        const before = new Date(Date.parse(`${day.day}T00:00:00.000Z`) + 86400000).toISOString();
        spend(1);
        const physical = (await db.prepare(V1_PREPARATION_SOURCE_PAGE_SQL)
          .bind(participantId, head.phase, head.cursor_time, head.cursor_id, pageSize, before)
          .all<PreparationQuotaRow & WindowedUsageRow>()).results;
        const selected = physical.filter(row => row.device_id === day.deviceId && row.observed_day === day.day);
        const complete = physical.length < pageSize;
        const outputs: D1PreparedStatement[] = [], bindings = guardBindings(pin, head);
        head = { ...head, progress_revision: head.progress_revision + 1 };
        if (previous.phase === "quota") {
          // Explicit projection prevents raw usage JSON from entering a quota
          // checkpoint through an object spread or future schema addition.
          const quota = selected.map(row => ({ id: row.id, observed_at: row.observed_at, observed_day: row.observed_day,
            device_id: row.device_id, provider: row.provider, limit_id: row.limit_id, plan_type: row.plan_type,
            plan_variant: row.plan_variant, occurrence_id: row.occurrence_id, slot: row.slot,
            used_percent: row.used_percent, window_duration_minutes: row.window_duration_minutes, resets_at: row.resets_at }));
          const { plans, fits } = prepareQuotaPage(quota, runs, complete);
          head.quota_count += selected.length; head.plan_count += plans.length; head.fit_count += fits.length;
          if (plans.length) outputs.push(insertRows(db, TABLES[0], ["id", "observed_at", "device_id", "provider", "limit_id", "plan_type", "plan_variant"],
            plans.map(row => [row.id, row.observed_at, row.device_id, row.provider, row.limit_id, row.plan_type, row.plan_variant]), bindings));
          if (fits.length) outputs.push(insertRows(db, TABLES[1], ["id", "observed_at", "device_id", "provider", "limit_id", "plan_type", "plan_variant",
            "occurrence_id", "slot", "used_percent", "window_duration_minutes", "resets_at"], fits.map(row => [row.id, row.observed_at, row.device_id,
            row.provider, row.limit_id, row.plan_type, row.plan_variant, row.occurrence_id, row.slot, row.used_percent, row.window_duration_minutes, row.resets_at]), bindings));
        } else {
          const { prices, fragments } = prepareUsagePage(selected);
          head.usage_count += selected.length; head.fragment_count += fragments.length;
          if (prices.length) outputs.push(insertRows(db, TABLES[2], ["id", "observed_at", "occurrence_id", "provider", "session_uuid", "cost_nanousd", "pricing_status", "model_id"],
            prices.map(row => [row.id, row.observed_at, row.occurrence_id, row.provider, row.session_uuid,
              row.preparedPrice?.costNanousd ?? null, row.preparedPrice?.pricingStatus ?? null, row.preparedPrice?.modelId ?? null]), bindings));
          if (fragments.length) {
            const payloads = await Promise.all(fragments.map(async fragment => {
              const json = canonicalJson(fragment);
              if (encoder.encode(json).byteLength > 131072) unavailable();
              return [fragment.id, fragment.observed_at, json, await sha256Hex(json)];
            }));
            outputs.push(insertRows(db, TABLES[3], ["id", "observed_at", "payload_json", "payload_sha256"], payloads, bindings));
          }
        }
        if (complete) {
          head.phase = previous.phase === "quota" ? "usage" : "complete";
          head.cursor_time = `${day.day}T00:00:00.000Z`; head.cursor_id = 0;
        } else {
          head.cursor_time = physical.at(-1)!.observed_at; head.cursor_id = physical.at(-1)!.id;
        }
        if (head.phase === "complete" && (head.quota_count !== day.quotaRecordCount || head.usage_count !== day.usageRecordCount)) unavailable("day_count_mismatch");
        head.control_json = canonicalJson(runs); head.control_sha256 = await sha256Hex(head.control_json);
        outputs.push(db.prepare(`UPDATE community_prepared_source_days SET phase=?7,progress_revision=?8,cursor_time=?9,cursor_id=?10,
          quota_count=?11,usage_count=?12,plan_count=?13,fit_count=?14,fragment_count=?15,control_json=?16,control_sha256=?17
          WHERE participant_id=?1 AND source_day=?3 AND generation=?4 AND ${HEAD_GUARD} RETURNING 1 AS applied`)
          .bind(...bindings, head.phase, head.progress_revision, head.cursor_time, head.cursor_id, head.quota_count, head.usage_count,
            head.plan_count, head.fit_count, head.fragment_count, head.control_json, head.control_sha256));
        spend(outputs.length);
        const written = await db.batch(outputs);
        if (written.at(-1)!.results.length !== 1) return result("deferred");
        pagesRun += 1;
      }
      daysComplete += 1;
    }
    return result("complete");
  } catch (error) {
    if (error instanceof D1InvocationBudgetExceededError) return result("deferred");
    throw error;
  }
}

function pageBound(limit: number, maximum: number, observedAt: string, id: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum || typeof observedAt !== "string" || !safeCount(id)) {
    throw new TypeError("prepared source page bound invalid");
  }
}

function timePageSql(table: typeof TABLES[number], index: string, columns: string): string {
  const countField = table === TABLES[0] ? "plan_count" : table === TABLES[2] ? "usage_count" : "fragment_count";
  // UTC source days do not overlap. A bounded (<=128) head-count prefix gives
  // later-day candidates. Complete earlier days total <pageSize; the final
  // day contributes at most pageSize IDs. Thus <2*pageSize IDs materialize,
  // even for sparse retired-day gaps, before the final exact allocation.
  return `WITH selected AS MATERIALIZED (
    SELECT json_extract(d.value,'$[0]') AS source_day,json_extract(d.value,'$[1]') AS generation,h.${countField} AS row_count
    FROM json_each(?6) d JOIN community_prepared_source_days h ON h.participant_id=?1
      AND h.source_day=json_extract(d.value,'$[0]') AND h.generation=json_extract(d.value,'$[1]') AND h.phase='complete'
  ), first_day AS MATERIALIZED (
    SELECT r.source_day,r.generation,r.id FROM community_prepared_source_days h
      CROSS JOIN ${table} r INDEXED BY ${index}
    WHERE h.participant_id=?1 AND h.source_day=substr(?2,1,10)
      AND (h.source_day,h.generation) IN (SELECT source_day,generation FROM selected)
      AND r.participant_id=?1 AND r.source_day=h.source_day AND r.generation=h.generation
      AND (r.observed_at,r.id)>(?2,?3) AND r.observed_at<?5
    ORDER BY r.observed_at,r.id LIMIT ?4
  ), future_days AS MATERIALIZED (
    SELECT source_day,generation,COALESCE(SUM(row_count) OVER (ORDER BY source_day
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS preceding_count
    FROM selected WHERE source_day>substr(?2,1,10) AND source_day<substr(?5,1,10)
  ), needed_days AS MATERIALIZED (
    SELECT * FROM future_days WHERE preceding_count<?4-(SELECT COUNT(*) FROM first_day)
  ), later AS MATERIALIZED (
    SELECT d.source_day,d.generation,CAST(c.value AS INTEGER) AS id FROM needed_days d
    CROSS JOIN json_each((SELECT json_group_array(id) FROM (
      SELECT id FROM ${table} INDEXED BY ${index}
      WHERE participant_id=?1 AND source_day=d.source_day AND generation=d.generation
      ORDER BY observed_at,id LIMIT ?4
    ))) c WHERE CAST(c.key AS INTEGER)+d.preceding_count<?4-(SELECT COUNT(*) FROM first_day)
  ), candidates AS MATERIALIZED (SELECT * FROM first_day UNION ALL SELECT * FROM later)
  SELECT ${columns} FROM candidates c JOIN ${table} r ON r.participant_id=?1
    AND r.source_day=c.source_day AND r.generation=c.generation AND r.id=c.id
  ORDER BY r.observed_at,r.id LIMIT ?4`;
}
const PLAN_COLUMNS = "r.id,r.observed_at,r.source_day AS observed_day,r.device_id,r.provider,r.limit_id,r.plan_type,r.plan_variant";
export const V1_PREPARED_PLAN_PAGE_SQL = timePageSql(TABLES[0], "community_prepared_plan_cursor", PLAN_COLUMNS);
export const V1_PREPARED_USAGE_PAGE_SQL = timePageSql(TABLES[2], "community_prepared_usage_cursor",
  "r.id,r.observed_at,r.occurrence_id,r.provider,r.session_uuid,r.cost_nanousd,r.pricing_status,r.model_id");
const BIN_PAGE_SQL = timePageSql(TABLES[3], "community_prepared_bins_cursor", "r.id,r.observed_at,r.payload_json,r.payload_sha256");
// <=128 selected days each contribute <=128 indexed cursor keys. Unlike filtering
// a global reset index, this cannot scan a future-only or obsolete prefix.
// Select the global top128 keys BEFORE fetching their wider evidence records.
export const V1_PREPARED_FIT_PAGE_SQL = `WITH candidates AS MATERIALIZED (
  SELECT json_extract(d.value,'$[0]') AS source_day,json_extract(d.value,'$[1]') AS generation,
    json_extract(c.value,'$[0]') AS id,json_extract(c.value,'$[1]') AS resets_at,json_extract(c.value,'$[2]') AS observed_at
  FROM json_each(?6) d CROSS JOIN json_each((SELECT json_group_array(json_array(id,resets_at,observed_at)) FROM (
    SELECT id,resets_at,observed_at FROM community_prepared_fit_rows INDEXED BY community_prepared_fit_cursor
    WHERE participant_id=?1 AND source_day=json_extract(d.value,'$[0]') AND generation=json_extract(d.value,'$[1]')
      AND (resets_at,observed_at,id)>(?2,?3,?4)
    ORDER BY resets_at,observed_at,id LIMIT ?5
  ))) c
), finalists AS MATERIALIZED (SELECT * FROM candidates ORDER BY resets_at,observed_at,id LIMIT ?5)
SELECT ${PLAN_COLUMNS},r.occurrence_id,r.slot,r.used_percent,r.window_duration_minutes,r.resets_at
FROM finalists c JOIN community_prepared_fit_rows r
  ON r.participant_id=?1 AND r.source_day=c.source_day AND r.generation=c.generation AND r.id=c.id
ORDER BY r.resets_at,r.observed_at,r.id LIMIT ?5`;

function guardedPageSql(sql: string, selectedParameter: number, revisionParameter: number): string {
  return `WITH prepared_page AS MATERIALIZED (${sql}), readiness AS MATERIALIZED (
    SELECT CASE WHEN EXISTS (SELECT 1 FROM participants p JOIN community_analytical_input_versions v ON v.participant_id=p.id
      WHERE p.id=?1 AND p.state='active' AND v.revision=?${revisionParameter}
        AND NOT EXISTS (SELECT 1 FROM telemetry_v11_domain_heads d WHERE d.participant_id=p.id))
      AND NOT EXISTS (SELECT 1 FROM json_each(?${selectedParameter}) d
        LEFT JOIN community_prepared_source_days h ON h.participant_id=?1
          AND h.source_day=json_extract(d.value,'$[0]') AND h.generation=json_extract(d.value,'$[1]')
        WHERE h.generation IS NULL OR h.phase!='complete') THEN 1 ELSE 0 END AS prepared_ready
  ) SELECT g.prepared_ready,p.* FROM readiness g LEFT JOIN prepared_page p ON g.prepared_ready=1
    ORDER BY ${sql === V1_PREPARED_FIT_PAGE_SQL ? "p.resets_at," : ""}p.observed_at,p.id`;
}
async function guardedRows<T extends { id: number }>(statement: D1PreparedStatement): Promise<T[]> {
  const result = await statement.all<T & { prepared_ready: number }>();
  if (!result.results.length || result.results.some(row => row.prepared_ready !== 1)) unavailable();
  return result.results.filter(row => row.id !== null).map(({ prepared_ready: _ready, ...row }) => row as unknown as T);
}

/** Retention/erasure triggers revoke a day immediately; ordinary maintenance
 * drains only explicitly retired derived rows, with no source deletion. */
export async function retireV1PreparedEvidence(db: D1Database, options: V1PreparationOptions): Promise<{
  status: "complete" | "deferred"; pagesRun: number; queriesUsed: number;
}> {
  if (!Number.isInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > MAX_PAGES) {
    throw new TypeError("prepared retirement page bound invalid");
  }
  let pagesRun = 0, queriesUsed = 0;
  const now = options.now ?? Date.now;
  const result = (status: "complete" | "deferred") => ({ status, pagesRun, queriesUsed });
  const spend = (count: number) => {
    if (now() >= options.deadlineMs || options.budget && options.budget.remainingQueries < count) throw new D1InvocationBudgetExceededError();
    if (options.budget) options.budget.remainingQueries -= count;
    queriesUsed += count;
  };
  try {
    while (pagesRun < options.maxPages) {
      spend(1);
      const head = await db.prepare(`SELECT participant_id,source_day,generation,progress_revision
        FROM community_prepared_source_days INDEXED BY community_prepared_retirement_cursor
        WHERE phase='discarding' ORDER BY participant_id,source_day LIMIT 1`)
        .first<Pick<Head, "participant_id" | "source_day" | "generation" | "progress_revision">>();
      if (!head) return result("complete");
      const guard = `EXISTS (SELECT 1 FROM community_prepared_source_days h WHERE h.participant_id=?1
        AND h.source_day=?2 AND h.generation=?3 AND h.progress_revision=?4 AND h.phase='discarding')`;
      const values = [head.participant_id, head.source_day, head.generation, head.progress_revision];
      const statements = TABLES.map(table => db.prepare(`DELETE FROM ${table}
        WHERE participant_id=?1 AND source_day=?2 AND generation=?3
          AND id IN (SELECT id FROM ${table} WHERE participant_id=?1 AND source_day=?2 AND generation=?3
            ORDER BY id LIMIT 256) AND ${guard}`).bind(...values));
      statements.push(db.prepare(`DELETE FROM community_prepared_source_days WHERE participant_id=?1 AND source_day=?2
        AND generation=?3 AND ${guard} ${TABLES.map(table => `AND NOT EXISTS (SELECT 1 FROM ${table}
          WHERE participant_id=?1 AND source_day=?2 AND generation=?3)`).join(" ")}`).bind(...values));
      spend(statements.length); await db.batch(statements); pagesRun += 1;
    }
    return result("deferred");
  } catch (error) {
    if (error instanceof D1InvocationBudgetExceededError) return result("deferred");
    throw error;
  }
}

export async function createPreparedV1EvidenceReader(db: D1Database, pin: V1SourcePin): Promise<
  V1PreparedFinishEvidence & { quotaReader: V1QuotaPageReader; replayPolicy: typeof V1_PREPARED_READER_POLICY }
> {
  const days = await dependencies(db, pin);
  const participantId = "participantId" in pin.scope ? pin.scope.participantId : unavailable();
  const heads = await readHeads(db, participantId, pin.inputRevision!, days);
  for (const day of days) {
    const head = heads.get(day.day);
    if (!head || head.generation !== day.generation || head.phase !== "complete"
      || head.device_id !== day.deviceId || head.method_version !== V1_PREPARATION_METHOD_VERSION) unavailable();
    await runsForHead(head);
  }
  const from = "participantId" in pin.scope ? pin.scope.fromDay ?? days[0]?.day : undefined;
  const through = "participantId" in pin.scope ? pin.scope.throughDay : undefined;
  const cutoff = from ? `${from}T00:00:00.000Z` : "";
  const upper = through ? new Date(Date.parse(`${through}T00:00:00.000Z`) + 86400000).toISOString() : "9999-12-31T23:59:59.999Z";
  const selected = JSON.stringify(days.map(day => [day.day, day.generation]));
  return {
    sourceFingerprint: pin.fingerprint, replayPolicy: V1_PREPARED_READER_POLICY,
    quotaReader: {
      pageSize: 128,
      async readPlanPage(cursor, limit) {
        pageBound(limit, 128, cursor.observedAt, cursor.id);
        return guardedRows<V1PlanSourceRow>(db.prepare(guardedPageSql(V1_PREPARED_PLAN_PAGE_SQL, 6, 7))
          .bind(participantId, cursor.observedAt, cursor.id, limit, upper, selected, pin.inputRevision));
      },
      async readFitPage(cursor, limit) {
        pageBound(limit, 128, cursor.observedAt, cursor.id);
        return guardedRows<V1FitSourceRow>(db.prepare(guardedPageSql(V1_PREPARED_FIT_PAGE_SQL, 6, 7))
          .bind(participantId, cursor.resetsAt, cursor.observedAt, cursor.id, limit, selected, pin.inputRevision));
      },
    },
    usageReader: {
      async readPage(time, id, limit, before) {
        pageBound(limit, 5000, time, id);
        if (time < cutoff || before !== undefined && before !== upper) unavailable();
        const rows = await guardedRows<Omit<WindowedUsageRow, "record_json" | "preparedPrice"> & { cost_nanousd: number | null;
            pricing_status: "fully_priced" | "partially_priced" | "unpriced" | null; model_id: string | null }>(
          db.prepare(guardedPageSql(V1_PREPARED_USAGE_PAGE_SQL, 6, 7)).bind(participantId, time, id, limit, upper, selected, pin.inputRevision));
        return rows.map(({ cost_nanousd, pricing_status, model_id, ...row }) => ({ ...row, record_json: "",
          preparedPrice: pricing_status === null ? null : { costNanousd: cost_nanousd!, pricingStatus: pricing_status, modelId: model_id } }));
      },
    },
    usageBins: {
      totalRowCount: [...heads.values()].reduce((sum, head) => sum + head.usage_count, 0),
      fragmentCount: [...heads.values()].reduce((sum, head) => sum + head.fragment_count, 0),
      async readPage(time, id, limit) {
        pageBound(limit, 256, time, id);
        if (time < cutoff) unavailable();
        const rows = await guardedRows<{ id: number; observed_at: string; payload_json: string; payload_sha256: string }>(
          db.prepare(guardedPageSql(BIN_PAGE_SQL, 6, 7)).bind(participantId, time, id, limit, upper, selected, pin.inputRevision));
        return Promise.all(rows.map(async row => {
          if (await sha256Hex(row.payload_json) !== row.payload_sha256) unavailable();
          const fragment = JSON.parse(row.payload_json) as V1PreparedUsageFragment;
          if (!record(fragment) || !exactKeys(fragment, ["id", "observed_at", "provider", "binStartMs", "usageEventCount", "unpricedUsageEventCount", "cells"])
            || fragment.id !== row.id || fragment.observed_at !== row.observed_at || typeof fragment.provider !== "string"
            || fragment.binStartMs !== Date.parse(row.observed_at) || !safeCount(fragment.usageEventCount)
            || !safeCount(fragment.unpricedUsageEventCount) || !Array.isArray(fragment.cells)
            || fragment.cells.length > V1_PREPARATION_PAGE_SIZE) unavailable();
          for (const cell of fragment.cells) {
            if (!record(cell) || !exactKeys(cell, ["model", "costNanousd", "overflowed", "firstObservedAt", "firstOccurrenceId"])
              || typeof cell.model !== "string" || !safeCount(cell.costNanousd) || typeof cell.overflowed !== "boolean"
              || !validTime(cell.firstObservedAt) || typeof cell.firstOccurrenceId !== "string") unavailable();
          }
          return fragment;
        }));
      },
    },
  };
}

/**
 * Adapt the provider-neutral prepared-source page contract to the existing v1
 * quota acquisition reader.  The source generation is a quota-only prepared
 * stream: accepting an untyped mixed stream here would advance the v1 cursor
 * past usage rows and silently lose evidence.  The writer therefore stamps
 * `stream: "quota"` (or omits the legacy marker) and a positive numeric `id`
 * in each bounded payload.
 */
export interface ProviderPreparedV1QuotaSource {
  readonly store: PreparedSourceStore;
  readonly pin: StorageSourcePin;
  readonly generation: string;
  readonly readerPolicy: string;
  readonly stream?: "quota";
  /** Optional ordered multi-day generations. When present, `pin` and
   * `generation` remain the first-day compatibility identity while readers
   * merge the explicitly sealed window. */
  readonly sources?: readonly PreparedSourceWindow[];
}

export interface ProviderV1PreparationOptions {
  readonly source: StorageSourceStore;
  readonly prepared: PreparedSourceStore;
  readonly pin: StorageSourcePin;
  readonly deviceId: string;
  readonly generation: string;
  readonly readerPolicy?: string;
  readonly maxPages: number;
  readonly pageSize?: number;
  readonly deadlineMs: number;
  readonly now?: () => number;
  readonly expectedQuotaRows?: number;
  /** A separate immutable generation carries the existing usage preparation
   * output. It is intentionally separate from the quota reader generation so
   * the v1 acquisition codec cannot advance across usage rows. */
  readonly usageGeneration?: string;
  readonly expectedUsageRows?: number;
}

export interface ProviderV1PreparationResult {
  readonly status: "complete" | "deferred";
  readonly pagesRun: number;
  readonly rowsWritten: number;
  readonly head: Awaited<ReturnType<PreparedSourceStore["begin"]>>;
  readonly usageHead?: Awaited<ReturnType<PreparedSourceStore["begin"]>>;
  readonly usageGeneration: string;
  readonly preparedEvidence?: V1PreparedFinishEvidence;
}

/** A day-specific canonical pin and its independently sealed quota/usage
 * generations. The vector is deliberately explicit: a caller cannot encode
 * stream identity in a generation string or silently skip a day. */
export interface ProviderV1PreparationWindowDay {
  readonly pin: StorageSourcePin;
  readonly deviceId: string;
  readonly generation: string;
  readonly usageGeneration?: string;
  readonly expectedQuotaRows?: number;
  readonly expectedUsageRows?: number;
}

export interface ProviderV1PreparationWindowOptions {
  readonly source: StorageSourceStore;
  readonly prepared: PreparedSourceStore;
  readonly days: readonly ProviderV1PreparationWindowDay[];
  readonly readerPolicy?: string;
  /** One shared budget across all day and stream pages. */
  readonly maxPages: number;
  readonly pageSize?: number;
  readonly deadlineMs: number;
  readonly now?: () => number;
}

export interface ProviderV1PreparationWindowDayResult {
  readonly pin: StorageSourcePin;
  readonly deviceId: string;
  readonly generation: string;
  readonly usageGeneration: string;
  readonly quotaHead: Awaited<ReturnType<PreparedSourceStore["begin"]>>;
  readonly usageHead?: Awaited<ReturnType<PreparedSourceStore["begin"]>>;
}

export interface ProviderV1PreparationWindowResult {
  readonly status: "complete" | "deferred";
  readonly pagesRun: number;
  readonly days: readonly ProviderV1PreparationWindowDayResult[];
  readonly preparedEvidence?: V1PreparedFinishEvidence;
}

function providerPreparationQuotaRows(records: readonly StorageSourceRecord[]): PreparationQuotaRow[] {
  return records.map((sourceRecord) => {
    const payload = providerQuotaPayload(sourceRecord.payload, sourceRecord, "provider prepared quota row");
    const observedAt = new Date(sourceRecord.observedAtMs).toISOString();
    if (!validTime(observedAt) || sourceRecord.observedDay !== observedAt.slice(0, 10)) {
      throw new V1PreparedEvidenceUnavailableError("control_invalid");
    }
    return {
      id: payload.id as number,
      observed_at: observedAt,
      observed_day: sourceRecord.observedDay,
      device_id: payload.device_id as string,
      provider: providerNullableString(payload.provider),
      limit_id: providerNullableString(payload.limit_id),
      plan_type: providerNullableString(payload.plan_type),
      plan_variant: providerNullableString(payload.plan_variant),
      occurrence_id: typeof payload.occurrence_id === "string" ? payload.occurrence_id : sourceRecord.occurrenceId,
      slot: providerNullableString(payload.slot),
      used_percent: payload.used_percent === null || payload.used_percent === undefined
        ? null : typeof payload.used_percent === "number" && Number.isFinite(payload.used_percent)
          ? payload.used_percent : (() => { throw new V1PreparedEvidenceUnavailableError("control_invalid"); })(),
      window_duration_minutes: payload.window_duration_minutes === null || payload.window_duration_minutes === undefined
        ? null : typeof payload.window_duration_minutes === "number" && Number.isSafeInteger(payload.window_duration_minutes)
          ? payload.window_duration_minutes
          : (() => { throw new V1PreparedEvidenceUnavailableError("control_invalid"); })(),
      resets_at: payload.resets_at === null || payload.resets_at === undefined
        ? null : validTime(payload.resets_at) ? payload.resets_at
          : (() => { throw new V1PreparedEvidenceUnavailableError("control_invalid"); })(),
    };
  });
}

function providerPreparationUsageRows(records: readonly StorageSourceRecord[]): WindowedUsageRow[] {
  return records.map((sourceRecord) => {
    if (!record(sourceRecord.payload)) throw new V1PreparedEvidenceUnavailableError("control_invalid");
    const payload = sourceRecord.payload as Record<string, unknown>;
    const observedAt = new Date(sourceRecord.observedAtMs).toISOString();
    if (!validTime(observedAt) || sourceRecord.observedDay !== observedAt.slice(0, 10)
        || typeof payload.id !== "number" || !Number.isSafeInteger(payload.id)
        || typeof payload.occurrence_id !== "string" || typeof payload.provider !== "string") {
      throw new V1PreparedEvidenceUnavailableError("control_invalid");
    }
    const recordJson = payload.record_json;
    return {
      id: payload.id,
      occurrence_id: payload.occurrence_id,
      observed_at: observedAt,
      provider: payload.provider,
      session_uuid: payload.session_uuid === null || payload.session_uuid === undefined
        ? null : typeof payload.session_uuid === "string" ? payload.session_uuid
          : (() => { throw new V1PreparedEvidenceUnavailableError("control_invalid"); })(),
      record_json: canonicalJson(recordJson === undefined ? payload : recordJson),
    };
  });
}

function equalSourcePin(left: StorageSourcePin, right: StorageSourcePin): boolean {
  return left.sourceId === right.sourceId
    && left.sourceNamespace === right.sourceNamespace
    && left.ownerDigest === right.ownerDigest
    && left.day === right.day
    && left.inputRevision === right.inputRevision
    && left.ownerRevision === right.ownerRevision
    && left.dependencyDigest === right.dependencyDigest
    && left.method === right.method
    && left.authorityEpoch === right.authorityEpoch
    && left.sourceEpoch === right.sourceEpoch
    && left.sequence === right.sequence;
}

function emptyPreparedQuotaRuns(): PreparedQuotaRuns {
  return { plan: null, fit: null, lastTime: null, lastSignature: null, equalTimeChanged: false };
}

async function runsFromProviderHead(
  head: Awaited<ReturnType<PreparedSourceStore["begin"]>>,
): Promise<PreparedQuotaRuns> {
  if (!head.control) {
    if (head.progressRevision !== 0) unavailable("control_invalid");
    return emptyPreparedQuotaRuns();
  }
  if (await sha256Hex(head.control.json) !== head.control.sha256
      || encoder.encode(head.control.json).byteLength > 16 * 1024) unavailable("control_invalid");
  let value: unknown;
  try { value = JSON.parse(head.control.json); } catch { unavailable("control_invalid"); }
  if (!record(value) || !exactKeys(value, ["plan", "fit", "lastTime", "lastSignature", "equalTimeChanged"])
      || value.lastTime !== null && !validTime(value.lastTime)
      || value.lastSignature !== null && typeof value.lastSignature !== "string"
      || typeof value.equalTimeChanged !== "boolean") unavailable("control_invalid");
  for (const key of ["plan", "fit"] as const) {
    const run = value[key];
    if (run === null) continue;
    if (!record(run) || !exactKeys(run, ["first", "last"])) unavailable("control_invalid");
    validateRow(run.first, key === "fit");
    validateRow(run.last, key === "fit");
  }
  return value as unknown as PreparedQuotaRuns;
}

async function controlFromRuns(runs: PreparedQuotaRuns): Promise<PreparedSourceControl> {
  const json = canonicalJson(runs);
  return Object.freeze({ json, sha256: await sha256Hex(json) });
}

async function outputFromValue(
  stream: PreparedSourceStream,
  kind: PreparedSourceOutputKind,
  key: string,
  index: number,
  payload: StorageJsonValue,
): Promise<PreparedSourceOutput> {
  const payloadJson = canonicalJson(payload);
  return Object.freeze({ stream, kind, key, index, payload, payloadSha256: await sha256Hex(payloadJson) });
}

async function quotaOutputs(
  plans: readonly V1PlanSourceRow[],
  fits: readonly V1FitSourceRow[],
): Promise<PreparedSourceOutput[]> {
  const outputs: PreparedSourceOutput[] = [];
  for (const row of plans) outputs.push(await outputFromValue("quota", "plan", `${row.observed_at}:${numericOutputKey(row.id)}`,
    Date.parse(row.observed_at), row as unknown as StorageJsonValue));
  for (const row of fits) outputs.push(await outputFromValue("quota", "fit", `${row.resets_at}:${row.observed_at}:${numericOutputKey(row.id)}`,
    Date.parse(row.resets_at), row as unknown as StorageJsonValue));
  return outputs;
}

async function usageOutputs(
  prices: readonly WindowedUsageRow[],
  fragments: readonly V1PreparedUsageFragment[],
): Promise<PreparedSourceOutput[]> {
  const outputs: PreparedSourceOutput[] = [];
  for (const row of prices) {
    if (row.preparedPrice === undefined) unavailable("control_invalid");
    outputs.push(await outputFromValue("usage", "usage_price", `${row.observed_at}:${numericOutputKey(row.id)}`, Date.parse(row.observed_at),
      row as unknown as StorageJsonValue));
  }
  for (const fragment of fragments) {
    outputs.push(await outputFromValue("usage", "usage_fragment", `${fragment.observed_at}:${numericOutputKey(fragment.id)}`, fragment.binStartMs,
      fragment as unknown as StorageJsonValue));
  }
  return outputs;
}

function providerPlanOutput(value: StorageJsonValue, fit: boolean): V1PlanSourceRow | V1FitSourceRow {
  if (!record(value)) unavailable("control_invalid");
  const payload = value as Record<string, unknown>;
  if (typeof payload.id !== "number" || !Number.isSafeInteger(payload.id) || payload.id <= 0
      || !validTime(payload.observed_at) || payload.observed_day !== payload.observed_at.slice(0, 10)
      || typeof payload.device_id !== "string") unavailable("control_invalid");
  const row: V1PlanSourceRow = {
    id: payload.id, observed_at: payload.observed_at, observed_day: payload.observed_day,
    device_id: payload.device_id, provider: providerNullableString(payload.provider),
    limit_id: providerNullableString(payload.limit_id), plan_type: providerNullableString(payload.plan_type),
    plan_variant: providerNullableString(payload.plan_variant),
  };
  if (!fit) return row;
  if (typeof payload.occurrence_id !== "string" || typeof payload.slot !== "string"
      || typeof payload.used_percent !== "number" || !Number.isFinite(payload.used_percent)
      || payload.window_duration_minutes !== 10080 || !validTime(payload.resets_at)
      || typeof payload.provider !== "string" || typeof payload.limit_id !== "string"
      || typeof payload.plan_type !== "string" || typeof payload.plan_variant !== "string") unavailable("control_invalid");
  return { ...row, provider: payload.provider, limit_id: payload.limit_id,
    plan_type: payload.plan_type, plan_variant: payload.plan_variant,
    occurrence_id: payload.occurrence_id, slot: payload.slot, used_percent: payload.used_percent,
    window_duration_minutes: 10080, resets_at: payload.resets_at };
}

function providerUsagePriceOutput(value: StorageJsonValue): WindowedUsageRow {
  if (!record(value)) unavailable("control_invalid");
  const payload = value as Record<string, unknown>;
  if (typeof payload.id !== "number" || !Number.isSafeInteger(payload.id) || payload.id <= 0
      || typeof payload.occurrence_id !== "string" || !validTime(payload.observed_at)
      || typeof payload.provider !== "string" || (payload.session_uuid !== null && typeof payload.session_uuid !== "string")
      || typeof payload.record_json !== "string") unavailable("control_invalid");
  const preparedPrice = payload.preparedPrice;
  if (preparedPrice !== null && !record(preparedPrice)) unavailable("control_invalid");
  return {
    id: payload.id, occurrence_id: payload.occurrence_id, observed_at: payload.observed_at,
    provider: payload.provider, session_uuid: payload.session_uuid as string | null,
    record_json: payload.record_json, preparedPrice: preparedPrice as WindowedUsageRow["preparedPrice"],
  };
}

function providerUsageFragmentOutput(value: StorageJsonValue): V1PreparedUsageFragment {
  if (!record(value)) unavailable("control_invalid");
  const payload = value as Record<string, unknown>;
  if (typeof payload.id !== "number" || !Number.isSafeInteger(payload.id) || payload.id <= 0
      || !validTime(payload.observed_at) || typeof payload.provider !== "string"
      || typeof payload.binStartMs !== "number" || !Number.isSafeInteger(payload.binStartMs)
      || payload.binStartMs !== Date.parse(payload.observed_at)
      || typeof payload.usageEventCount !== "number" || !safeCount(payload.usageEventCount)
      || typeof payload.unpricedUsageEventCount !== "number" || !safeCount(payload.unpricedUsageEventCount)
      || !Array.isArray(payload.cells)) unavailable("control_invalid");
  const cells = payload.cells.map((cell) => {
    if (!record(cell) || typeof cell.model !== "string" || !safeCount(cell.costNanousd)
        || typeof cell.overflowed !== "boolean" || !validTime(cell.firstObservedAt)
        || typeof cell.firstOccurrenceId !== "string") unavailable("control_invalid");
    return {
      model: cell.model, costNanousd: cell.costNanousd, overflowed: cell.overflowed,
      firstObservedAt: cell.firstObservedAt, firstOccurrenceId: cell.firstOccurrenceId,
    };
  });
  return {
    id: payload.id, observed_at: payload.observed_at, provider: payload.provider,
    binStartMs: payload.binStartMs, usageEventCount: payload.usageEventCount,
    unpricedUsageEventCount: payload.unpricedUsageEventCount, cells,
  };
}

/**
 * Materialize owner-pinned v1 quota and usage generations from the canonical
 * source port. Each physical page is passed through the existing preparation
 * algorithms before its immutable raw records are committed. The derived
 * projection is carried beside the page payload so retries remain idempotent;
 * the quota reader still consumes only the quota generation and the existing
 * acquisition/checkpoint codec remains the downstream calculator.
 */
export async function ensurePreparedV1WindowFromProvider(
  options: ProviderV1PreparationOptions,
): Promise<ProviderV1PreparationResult> {
  const pageSize = options.pageSize ?? V1_PREPARATION_PAGE_SIZE;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > MAX_PAGES
      || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > V1_PREPARATION_PAGE_SIZE
      || !Number.isFinite(options.deadlineMs) || typeof options.deviceId !== "string"
      || options.deviceId.length === 0 || options.generation.length === 0) {
    throw new TypeError("provider v1 preparation budget invalid");
  }
  const readerPolicy = options.readerPolicy ?? V1_PREPARED_READER_POLICY;
  const usageGeneration = options.usageGeneration
    ?? await sha256Hex(canonicalJson(["provider-preparation", options.generation, options.pin.sourceId,
      options.pin.ownerDigest, options.pin.day, "usage"]));
  if (usageGeneration.length === 0 || usageGeneration.length > 256 || usageGeneration === options.generation) {
    throw new TypeError("provider v1 usage generation invalid");
  }
  let pagesRun = 0;
  const deferred = (head: Awaited<ReturnType<PreparedSourceStore["begin"]>>, usageHead?: Awaited<ReturnType<PreparedSourceStore["begin"]>>) =>
    Object.freeze({ status: "deferred" as const, pagesRun, rowsWritten: head.rowsWritten, head, usageHead, usageGeneration });
  let head = await options.prepared.begin({ pin: Object.freeze({ ...options.pin }), generation: options.generation, stream: "quota" });
  while (head.state === "building") {
    if (pagesRun >= options.maxPages || now() >= options.deadlineMs) return deferred(head);
    const page: StorageSourcePage = await options.source.readPage({
      pin: Object.freeze({ ...options.pin }), stream: "quota", deviceId: options.deviceId,
      cursor: head.nextCursor, limit: pageSize,
    });
    if (!equalSourcePin(page.pin, options.pin)) unavailable("source_not_current");
    if (page.status !== "available") {
      if (page.status === "stale" || page.status === "withdrawn") unavailable("source_not_current");
      if (page.status === "correction_unavailable") unavailable("correction_unavailable");
      return deferred(head);
    }
    if (!page.complete && page.rows.length === 0) unavailable("control_invalid");
    const runs = await runsFromProviderHead(head);
    const quotaRows = providerPreparationQuotaRows(page.rows);
    const { plans, fits } = prepareQuotaPage(quotaRows, runs, page.complete);
    const outputs = await quotaOutputs(plans, fits);
    const control = await controlFromRuns(runs);
    const rowDigest = await sha256Hex(canonicalJson(page.rows));
    head = await options.prepared.commitPage({
      pin: Object.freeze({ ...options.pin }), generation: options.generation, stream: "quota",
      expectedProgressRevision: head.progressRevision, nextCursor: page.nextCursor,
      complete: page.complete, rows: Object.freeze(page.rows), rowDigest, control, outputs,
    });
    pagesRun += 1;
  }
  if (head.state !== "ready") return deferred(head);
  if (options.expectedQuotaRows !== undefined && head.rowsWritten !== options.expectedQuotaRows) unavailable("day_count_mismatch");

  // Usage has a separate explicit stream identity, but consumes the same
  // invocation page budget as quota. The empty control is still persisted so
  // a resumed usage generation is distinguishable from a legacy raw head.
  let usageHead = await options.prepared.begin({ pin: Object.freeze({ ...options.pin }), generation: usageGeneration, stream: "usage" });
  const usageControl = await controlFromRuns(emptyPreparedQuotaRuns());
  while (usageHead.state === "building") {
    if (pagesRun >= options.maxPages || now() >= options.deadlineMs) return deferred(head, usageHead);
    const page = await options.source.readPage({
      pin: Object.freeze({ ...options.pin }), stream: "usage", deviceId: options.deviceId,
      cursor: usageHead.nextCursor, limit: pageSize,
    });
    if (!equalSourcePin(page.pin, options.pin)) unavailable("source_not_current");
    if (page.status !== "available") {
      if (page.status === "stale" || page.status === "withdrawn") unavailable("source_not_current");
      if (page.status === "correction_unavailable") unavailable("correction_unavailable");
      return deferred(head, usageHead);
    }
    if (!page.complete && page.rows.length === 0) unavailable("control_invalid");
    const usageRows = providerPreparationUsageRows(page.rows);
    const { prices, fragments } = prepareUsagePage(usageRows);
    const outputs = await usageOutputs(prices, fragments);
    const rowDigest = await sha256Hex(canonicalJson(page.rows));
    usageHead = await options.prepared.commitPage({
      pin: Object.freeze({ ...options.pin }), generation: usageGeneration, stream: "usage",
      expectedProgressRevision: usageHead.progressRevision, nextCursor: page.nextCursor,
      complete: page.complete, rows: Object.freeze(page.rows), rowDigest,
      control: usageControl, outputs,
    });
    pagesRun += 1;
  }
  if (options.expectedUsageRows !== undefined && usageHead.rowsWritten !== options.expectedUsageRows) unavailable("day_count_mismatch");
  const preparedEvidence = await createProviderV1PreparedEvidence({
    store: options.prepared, pin: options.pin, quotaGeneration: options.generation,
    usageGeneration, sourceFingerprint: options.pin.dependencyDigest,
  });
  return Object.freeze({ status: "complete", pagesRun, rowsWritten: head.rowsWritten, head,
    usageHead, usageGeneration, preparedEvidence });
}

/** Prepare a bounded vector of day generations with one invocation budget.
 * Each day still uses the existing quota/usage preparation algorithm and CAS;
 * this coordinator only sequences those real operations and then exposes the
 * merged finisher reader. A deferred day is returned with its durable heads so
 * the next invocation resumes from the same generations. */
export async function ensurePreparedV1WindowFromProviderDays(
  options: ProviderV1PreparationWindowOptions,
): Promise<ProviderV1PreparationWindowResult> {
  const now = options.now ?? Date.now;
  if (options.days.length < 1 || options.days.length > 128
      || !Number.isSafeInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > MAX_PAGES
      || !Number.isSafeInteger(options.pageSize ?? V1_PREPARATION_PAGE_SIZE)
      || (options.pageSize ?? V1_PREPARATION_PAGE_SIZE) < 1
      || (options.pageSize ?? V1_PREPARATION_PAGE_SIZE) > V1_PREPARATION_PAGE_SIZE
      || !Number.isFinite(options.deadlineMs)) throw new TypeError("provider v1 preparation window budget invalid");
  const first = options.days[0]!;
  const seenDays = new Set<string>();
  const seenGenerations = new Set<string>();
  for (const day of options.days) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day.pin.day) || seenDays.has(day.pin.day)
        || seenGenerations.has(day.generation) || !day.generation || day.generation.length > 256
        || day.pin.sourceId !== first.pin.sourceId
        || day.pin.sourceNamespace !== first.pin.sourceNamespace
        || day.pin.ownerDigest !== first.pin.ownerDigest
        || day.pin.inputRevision !== first.pin.inputRevision
        || day.pin.ownerRevision !== first.pin.ownerRevision
        || day.pin.method !== first.pin.method
        || day.pin.authorityEpoch !== first.pin.authorityEpoch
        || day.pin.sourceEpoch !== first.pin.sourceEpoch
        || day.pin.sequence !== first.pin.sequence
        || typeof day.deviceId !== "string" || day.deviceId.length === 0) {
      throw new TypeError("provider v1 preparation window identity invalid");
    }
    seenDays.add(day.pin.day); seenGenerations.add(day.generation);
  }
  for (let index = 1; index < options.days.length; index += 1) {
    if (options.days[index - 1]!.pin.day >= options.days[index]!.pin.day) {
      throw new TypeError("provider v1 preparation window days must be ordered");
    }
  }
  let pagesRun = 0;
  const results: ProviderV1PreparationWindowDayResult[] = [];
  for (const day of options.days) {
    if (pagesRun >= options.maxPages || now() >= options.deadlineMs) {
      return Object.freeze({ status: "deferred", pagesRun, days: Object.freeze(results) });
    }
    const result = await ensurePreparedV1WindowFromProvider({
      source: options.source, prepared: options.prepared, pin: Object.freeze({ ...day.pin }),
      deviceId: day.deviceId, generation: day.generation, readerPolicy: options.readerPolicy,
      maxPages: Math.min(MAX_PAGES, options.maxPages - pagesRun), pageSize: options.pageSize,
      deadlineMs: options.deadlineMs, now,
      expectedQuotaRows: day.expectedQuotaRows, expectedUsageRows: day.expectedUsageRows,
      usageGeneration: day.usageGeneration,
    });
    pagesRun += result.pagesRun;
    results.push(Object.freeze({ pin: day.pin, deviceId: day.deviceId, generation: day.generation,
      usageGeneration: result.usageGeneration, quotaHead: result.head, usageHead: result.usageHead }));
    if (result.status !== "complete") {
      return Object.freeze({ status: "deferred", pagesRun, days: Object.freeze(results) });
    }
  }
  const sourceFingerprint = await sha256Hex(canonicalJson(options.days.map((day) => ({
    sourceId: day.pin.sourceId, sourceNamespace: day.pin.sourceNamespace, ownerDigest: day.pin.ownerDigest,
    day: day.pin.day, inputRevision: day.pin.inputRevision, ownerRevision: day.pin.ownerRevision,
    dependencyDigest: day.pin.dependencyDigest, method: day.pin.method,
    authorityEpoch: day.pin.authorityEpoch, sourceEpoch: day.pin.sourceEpoch, sequence: day.pin.sequence,
  }))));
  const preparedEvidence = await createProviderV1PreparedWindowEvidence({
    store: options.prepared,
    days: results.map((day) => ({ pin: day.pin, quotaGeneration: day.generation, usageGeneration: day.usageGeneration })),
    sourceFingerprint,
    readerPolicy: options.readerPolicy,
  });
  return Object.freeze({ status: "complete", pagesRun, days: Object.freeze(results), preparedEvidence });
}

/** More descriptive alias used by composition roots that expose the window
 * as a source-preparation operation. */
export const ensurePreparedV1WindowFromProviderWindow = ensurePreparedV1WindowFromProviderDays;

function providerQuotaPayload(value: unknown, recordValue: StorageSourceRecord, operation: string): Record<string, unknown> {
  if (!record(value) || (value.stream !== undefined && value.stream !== "quota")
      || !safeCount(value.id) || value.id === 0 || String(value.id) !== recordValue.occurrenceId
      || typeof value.device_id !== "string" || value.device_id.length === 0
      || value.device_id.length > 256) throw new V1PreparedEvidenceUnavailableError("control_invalid");
  const observedAt = new Date(recordValue.observedAtMs).toISOString();
  if (!validTime(observedAt) || recordValue.observedDay !== observedAt.slice(0, 10)) {
    throw new V1PreparedEvidenceUnavailableError("control_invalid");
  }
  return value;
}

function providerNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : typeof value === "string" ? value : (() => { throw new V1PreparedEvidenceUnavailableError("control_invalid"); })();
}

function outputCursor(observedAt: string, id: number): { afterIndex: number; afterKey: string } {
  if (!validTime(observedAt) || !Number.isSafeInteger(id) || id < 0) {
    throw new V1PreparedEvidenceUnavailableError("control_invalid");
  }
  return { afterIndex: Date.parse(observedAt), afterKey: `${observedAt}:${numericOutputKey(id)}` };
}

function numericOutputKey(value: number): string {
  return String(value).padStart(16, "0");
}

function fitOutputCursor(cursor: { observedAt: string; resetsAt: string; id: number }): { afterIndex: number; afterKey: string } {
  if (cursor.observedAt !== "" && !validTime(cursor.observedAt)
      || !validTime(cursor.resetsAt) || !Number.isSafeInteger(cursor.id) || cursor.id < 0) {
    throw new V1PreparedEvidenceUnavailableError("control_invalid");
  }
  return { afterIndex: Date.parse(cursor.resetsAt),
    afterKey: cursor.observedAt === "" ? `${cursor.resetsAt}:`
      : `${cursor.resetsAt}:${cursor.observedAt}:${numericOutputKey(cursor.id)}` };
}

function preparedWindowSources(source: ProviderPreparedV1QuotaSource): readonly PreparedSourceWindow[] {
  const sources = source.sources ?? [{ pin: source.pin, generation: source.generation }];
  if (sources.length < 1 || sources.length > 128) unavailable("control_invalid");
  const seen = new Set<string>();
  for (const item of sources) {
    if (!item.generation || item.generation.length > 256
        || item.pin.sourceId !== source.pin.sourceId
        || item.pin.sourceNamespace !== source.pin.sourceNamespace
        || item.pin.ownerDigest !== source.pin.ownerDigest
        || !/^\d{4}-\d{2}-\d{2}$/u.test(item.pin.day)
        || seen.has(`${item.pin.sourceId}\u0000${item.pin.ownerDigest}\u0000${item.pin.day}\u0000${item.generation}`)) {
      unavailable("control_invalid");
    }
    seen.add(`${item.pin.sourceId}\u0000${item.pin.ownerDigest}\u0000${item.pin.day}\u0000${item.generation}`);
  }
  const first = sources[0]!;
  if (first.pin.day !== source.pin.day || first.generation !== source.generation) {
    unavailable("control_invalid");
  }
  return sources;
}

function preparedOutputBefore(left: PreparedSourceOutput, right: PreparedSourceOutput): number {
  return left.index - right.index || left.key.localeCompare(right.key);
}

function preparedOutputAfter(output: PreparedSourceOutput, afterIndex: number, afterKey: string): boolean {
  return output.index > afterIndex || output.index === afterIndex && output.key > afterKey;
}

/** Read one bounded merged page. PostgreSQL supplies the single snapshot
 * window implementation; the fallback remains explicitly capped at twenty
 * 256-row pages per source so a non-batched adapter cannot become an
 * unbounded scan. */
async function preparedOutputWindowPage(
  source: ProviderPreparedV1QuotaSource,
  stream: PreparedSourceStream,
  kind: PreparedSourceOutputKind,
  afterIndex: number,
  afterKey: string,
  limit: number,
): Promise<readonly PreparedSourceOutput[]> {
  const sources = preparedWindowSources(source);
  if (!Number.isSafeInteger(afterIndex) || afterIndex < -1 || afterKey.length > 256
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) unavailable("control_invalid");
  if (source.store.readOutputsWindow) {
    const outputs = await source.store.readOutputsWindow({ sources, stream, kind,
      afterIndex, afterKey, limit });
    if (outputs.length > limit) unavailable("control_invalid");
    return outputs;
  }
  const merged: PreparedSourceOutput[] = [];
  for (const item of sources) {
    let cursorIndex = afterIndex;
    let cursorKey = afterKey;
    const pageLimit = Math.min(256, limit);
    for (let page = 0; page < 20 && merged.length < sources.length * limit; page += 1) {
      const batch = await source.store.readOutputs({ pin: item.pin, generation: item.generation,
        stream, kind, afterIndex: cursorIndex, afterKey: cursorKey, limit: pageLimit });
      if (batch.length > pageLimit) unavailable("control_invalid");
      for (const output of batch) {
        if (output.stream !== stream || output.kind !== kind
            || !preparedOutputAfter(output, afterIndex, afterKey)) unavailable("control_invalid");
        merged.push(output);
      }
      if (batch.length < pageLimit) break;
      const last = batch.at(-1);
      if (!last || !preparedOutputAfter(last, cursorIndex, cursorKey)) unavailable("control_invalid");
      cursorIndex = last.index; cursorKey = last.key;
    }
  }
  merged.sort(preparedOutputBefore);
  return Object.freeze(merged.slice(0, limit));
}

async function countPreparedWindowOutputs(
  source: ProviderPreparedV1QuotaSource,
  stream: PreparedSourceStream,
  kind: PreparedSourceOutputKind,
): Promise<number> {
  const sources = preparedWindowSources(source);
  if (source.store.countOutputsWindow) {
    const count = await source.store.countOutputsWindow({ sources, stream, kind });
    if (!safeCount(count)) unavailable("control_invalid");
    return count;
  }
  let total = 0;
  for (const item of sources) {
    const count = await source.store.countOutputs({ pin: item.pin, generation: item.generation, stream, kind });
    if (!safeCount(count) || total > Number.MAX_SAFE_INTEGER - count) unavailable("control_invalid");
    total += count;
  }
  return total;
}

async function preparedOutputPage(
  source: ProviderPreparedV1QuotaSource,
  kind: "plan" | "fit",
  cursor: { observedAt: string; resetsAt?: string; id: number },
  limit: number,
): Promise<readonly PreparedSourceOutput[]> {
  const position = kind === "fit"
    ? fitOutputCursor({ observedAt: cursor.observedAt, resetsAt: cursor.resetsAt ?? cursor.observedAt, id: cursor.id })
    : outputCursor(cursor.observedAt, cursor.id);
  return preparedOutputWindowPage(source, "quota", kind, position.afterIndex, position.afterKey, limit);
}

/** Provider equivalent of createPreparedV1Evidence. It consumes the durable
 * plan/fit/price/fragment outputs produced by preparation; it never reprices
 * or rereads raw source records. */
export async function createProviderV1PreparedEvidence(input: {
  readonly store: PreparedSourceStore;
  readonly pin: StorageSourcePin;
  readonly quotaGeneration: string;
  readonly usageGeneration: string;
  readonly sourceFingerprint: string;
  readonly readerPolicy?: string;
}): Promise<V1PreparedFinishEvidence & { quotaReader: V1QuotaPageReader; replayPolicy: typeof V1_PREPARED_READER_POLICY }> {
  const readerPolicy = input.readerPolicy ?? V1_PREPARED_READER_POLICY;
  const quotaSource: ProviderPreparedV1QuotaSource = {
    store: input.store, pin: input.pin, generation: input.quotaGeneration,
    readerPolicy, stream: "quota",
  };
  const quotaHead = await input.store.readHead({ sourceId: input.pin.sourceId, ownerDigest: input.pin.ownerDigest,
    day: input.pin.day, generation: input.quotaGeneration });
  const usageHead = await input.store.readHead({ sourceId: input.pin.sourceId, ownerDigest: input.pin.ownerDigest,
    day: input.pin.day, generation: input.usageGeneration });
  if (!quotaHead || quotaHead.state !== "ready" || !quotaHead.control
      || !usageHead || usageHead.state !== "ready" || !usageHead.control) unavailable("control_invalid");
  const readUsage = async (observedAt: string, id: number, limit: number): Promise<readonly PreparedSourceOutput[]> => {
    const position = outputCursor(observedAt, id);
    return input.store.readOutputs({ pin: input.pin, generation: input.usageGeneration, stream: "usage",
      kind: "usage_price", afterIndex: position.afterIndex, afterKey: position.afterKey, limit });
  };
  const readFragments = async (observedAt: string, id: number, limit: number): Promise<readonly PreparedSourceOutput[]> => {
    const observedAtMs = Date.parse(observedAt);
    const binStartMs = Math.floor(observedAtMs / MODEL_COMPOSITION_POLICY.grainMs) * MODEL_COMPOSITION_POLICY.grainMs;
    const binStart = new Date(binStartMs).toISOString();
    const position = outputCursor(binStart, id);
    return input.store.readOutputs({ pin: input.pin, generation: input.usageGeneration, stream: "usage",
      kind: "usage_fragment", afterIndex: position.afterIndex, afterKey: position.afterKey, limit });
  };
  const fragmentCount = await input.store.countOutputs({ pin: input.pin, generation: input.usageGeneration,
    stream: "usage", kind: "usage_fragment" });
  const usageReader: V1PreparedUsageReader = {
    async readPage(observedAt, id, limit) {
      pageBound(limit, 5000, observedAt, id);
      const outputs = await readUsage(observedAt, id, limit);
      return outputs.map((output) => providerUsagePriceOutput(output.payload));
    },
  };
  const usageBins: V1PreparedUsageBinsReader = {
    totalRowCount: usageHead.rowsWritten,
    fragmentCount,
    async readPage(observedAt, id, limit) {
      pageBound(limit, 256, observedAt, id);
      const outputs = await readFragments(observedAt, id, limit);
      return outputs.map((output) => providerUsageFragmentOutput(output.payload));
    },
  };
  return Object.freeze({
    sourceFingerprint: input.sourceFingerprint,
    replayPolicy: V1_PREPARED_READER_POLICY,
    quotaReader: createProviderV1QuotaReader(quotaSource), usageReader, usageBins,
  });
}

export interface ProviderV1PreparedWindowDay {
  readonly pin: StorageSourcePin;
  readonly quotaGeneration: string;
  readonly usageGeneration: string;
}

/**
 * Merge independently sealed day generations into the existing v1 finisher
 * contract.  The physical output reads remain bounded: PostgreSQL uses one
 * repeatable-read window query and adapters without that operation use the
 * explicit 256-row fallback above.  The domain algorithms therefore retain
 * their established 5,000-row usage request without exposing an unbounded
 * provider page.
 */
export async function createProviderV1PreparedWindowEvidence(input: {
  readonly store: PreparedSourceStore;
  readonly days: readonly ProviderV1PreparedWindowDay[];
  readonly sourceFingerprint: string;
  readonly readerPolicy?: string;
}): Promise<V1PreparedFinishEvidence & { quotaReader: V1QuotaPageReader; replayPolicy: typeof V1_PREPARED_READER_POLICY }> {
  if (input.days.length < 1 || input.days.length > 128
      || !/^[0-9a-f]{64}$/u.test(input.sourceFingerprint)) unavailable("control_invalid");
  const first = input.days[0]!;
  const daySources = input.days.map((day) => Object.freeze({ pin: Object.freeze({ ...day.pin }),
    generation: String(day.quotaGeneration) }));
  const usageSources = input.days.map((day) => Object.freeze({ pin: Object.freeze({ ...day.pin }),
    generation: String(day.usageGeneration) }));
  const quotaSource: ProviderPreparedV1QuotaSource = {
    store: input.store, pin: first.pin, generation: first.quotaGeneration,
    readerPolicy: input.readerPolicy ?? V1_PREPARED_READER_POLICY,
    stream: "quota", sources: daySources,
  };
  const usageSource: ProviderPreparedV1QuotaSource = {
    store: input.store, pin: first.pin, generation: first.usageGeneration,
    readerPolicy: input.readerPolicy ?? V1_PREPARED_READER_POLICY,
    sources: usageSources,
  };
  for (const day of input.days) {
    if (day.pin.sourceId !== first.pin.sourceId || day.pin.sourceNamespace !== first.pin.sourceNamespace
        || day.pin.ownerDigest !== first.pin.ownerDigest || !day.quotaGeneration || !day.usageGeneration) {
      unavailable("control_invalid");
    }
    const quotaHead = await input.store.readHead({ sourceId: day.pin.sourceId, ownerDigest: day.pin.ownerDigest,
      day: day.pin.day, generation: day.quotaGeneration });
    const usageHead = await input.store.readHead({ sourceId: day.pin.sourceId, ownerDigest: day.pin.ownerDigest,
      day: day.pin.day, generation: day.usageGeneration });
    if (!quotaHead || quotaHead.stream !== "quota" || quotaHead.state !== "ready" || !quotaHead.control
        || !usageHead || usageHead.stream !== "usage" || usageHead.state !== "ready" || !usageHead.control) {
      unavailable("control_invalid");
    }
    await runsFromProviderHead(quotaHead);
    await runsFromProviderHead(usageHead);
  }
  const readUsage = async (observedAt: string, id: number, limit: number, observedAtBefore?: string): Promise<readonly PreparedSourceOutput[]> => {
    const position = outputCursor(observedAt, id);
    const outputs = await preparedOutputWindowPage(usageSource, "usage", "usage_price",
      position.afterIndex, position.afterKey, limit);
    if (observedAtBefore !== undefined && !validTime(observedAtBefore)) unavailable("control_invalid");
    const before = observedAtBefore === undefined ? undefined : Date.parse(observedAtBefore);
    return before === undefined ? outputs
      : outputs.filter((output) => {
        const value = providerUsagePriceOutput(output.payload);
        return Date.parse(value.observed_at) < before;
      });
  };
  const readFragments = async (observedAt: string, id: number, limit: number): Promise<readonly PreparedSourceOutput[]> => {
    const observedAtMs = Date.parse(observedAt);
    const binStartMs = Math.floor(observedAtMs / MODEL_COMPOSITION_POLICY.grainMs) * MODEL_COMPOSITION_POLICY.grainMs;
    const position = outputCursor(new Date(binStartMs).toISOString(), id);
    return preparedOutputWindowPage(usageSource, "usage", "usage_fragment",
      position.afterIndex, position.afterKey, limit);
  };
  const fragmentCount = await countPreparedWindowOutputs(usageSource, "usage", "usage_fragment");
  // Heads are read above for validation; re-read their bounded row counters as
  // part of the same explicit day vector rather than inventing a global count.
  let usageRows = 0;
  for (const day of input.days) {
    const head = await input.store.readHead({ sourceId: day.pin.sourceId, ownerDigest: day.pin.ownerDigest,
      day: day.pin.day, generation: day.usageGeneration });
    if (!head) unavailable("control_invalid");
    usageRows += head.rowsWritten;
  }
  const usageReader: V1PreparedUsageReader = {
    async readPage(observedAt, id, limit, observedAtBefore) {
      pageBound(limit, 5000, observedAt, id);
      const outputs = await readUsage(observedAt, id, limit, observedAtBefore);
      return outputs.map((output) => providerUsagePriceOutput(output.payload));
    },
  };
  const usageBins: V1PreparedUsageBinsReader = {
    totalRowCount: usageRows,
    fragmentCount,
    async readPage(observedAt, id, limit) {
      pageBound(limit, 256, observedAt, id);
      const outputs = await readFragments(observedAt, id, limit);
      return outputs.map((output) => providerUsageFragmentOutput(output.payload));
    },
  };
  return Object.freeze({ sourceFingerprint: input.sourceFingerprint,
    replayPolicy: V1_PREPARED_READER_POLICY,
    quotaReader: createProviderV1QuotaReader(quotaSource), usageReader, usageBins });
}

/** Create the bounded quota reader used by the provider-backed analysis runner. */
export function createProviderV1QuotaReader(source: ProviderPreparedV1QuotaSource): V1QuotaPageReader {
  const { store, pin } = source;
  if (!source.generation || !source.readerPolicy) throw new TypeError("provider prepared source identity invalid");
  return {
    pageSize: 128,
    async readPlanPage(cursor, limit) {
      const head = await store.readHead({ sourceId: pin.sourceId, ownerDigest: pin.ownerDigest, day: pin.day, generation: source.generation });
      if (!head || head.stream !== "quota" || head.state !== "ready" || !head.control) {
        throw new V1PreparedEvidenceUnavailableError("invalid_evidence");
      }
      await runsFromProviderHead(head);
      const outputs = await preparedOutputPage(source, "plan", cursor, limit);
      return outputs.map((output) => providerPlanOutput(output.payload, false)) as V1PlanSourceRow[];
    },
    async readFitPage(cursor, limit) {
      const head = await store.readHead({ sourceId: pin.sourceId, ownerDigest: pin.ownerDigest, day: pin.day, generation: source.generation });
      if (!head || head.stream !== "quota" || head.state !== "ready" || !head.control) {
        throw new V1PreparedEvidenceUnavailableError("invalid_evidence");
      }
      await runsFromProviderHead(head);
      const outputs = await preparedOutputPage(source, "fit", cursor, limit);
      return outputs.map((output) => providerPlanOutput(output.payload, true)) as V1FitSourceRow[];
    },
  };
}
