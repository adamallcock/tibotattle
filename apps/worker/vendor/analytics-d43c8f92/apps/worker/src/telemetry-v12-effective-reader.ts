import {
  canonicalTelemetryV11Json,
  parseTelemetryV11Record,
  type TelemetryV11Record,
  type TelemetryV12Record,
  type TelemetryV12Stream,
} from "@app-usagemonitor/telemetry-contract";
import { sha256Hex } from "./crypto";
import {
  decodeTelemetryV12Record,
  type TelemetryV12TypedRecordRow,
} from "./telemetry-v12-repository";
import { typedTelemetryIdSql } from "./typed-telemetry-codec";

/**
 * Typed v1.2 analytical source boundary. A domain head is a write cursor,
 * rather than a retention boundary: every activated generation that still
 * passes the retained authorization scope is eligible here.
 */
export type TelemetryV12EffectiveStream = TelemetryV12Stream;

export interface TelemetryV12EffectiveCursor {
  readonly observedAtMs: number;
  readonly occurrenceId: string;
}

export interface TelemetryV12EffectiveRecord {
  readonly stream: TelemetryV12EffectiveStream;
  readonly occurrenceId: string;
  readonly observedAt: string;
  readonly observedAtMs: number;
  readonly sourceRecordJson: string;
  readonly recordJson: string;
  readonly sourceRecordKey: string;
}

export interface TelemetryV12EffectivePage {
  readonly available: boolean;
  readonly records: readonly TelemetryV12EffectiveRecord[];
  readonly next: TelemetryV12EffectiveCursor | null;
}

const TABLES = Object.freeze([
  "telemetry_v12_runtime", "telemetry_v12_device_capabilities",
  "telemetry_v12_day_manifests", "telemetry_v12_chunks", "telemetry_v12_records",
  "telemetry_v12_domain_predecessors", "telemetry_v12_domains",
  "telemetry_v12_domain_days", "telemetry_v12_domain_heads",
]);
const AUTHORIZATION_VIEW = "telemetry_v12_active_authorizations";
const RETAINED_AUTHORIZATION_SCOPE = [
  "SELECT authorization.participant_id,authorization.device_id",
  "  FROM telemetry_v12_active_authorizations authorization",
  "  JOIN storage_v11_owner_links owner_link ON owner_link.participant_id=authorization.participant_id",
  "   AND owner_link.state='active'",
  "UNION",
  "SELECT capability.participant_id,capability.device_id",
  "  FROM telemetry_v12_device_capabilities capability",
  "  JOIN participants participant ON participant.id=capability.participant_id AND participant.state='active'",
  "  JOIN storage_v11_owner_links owner_link ON owner_link.participant_id=capability.participant_id",
  "   AND owner_link.state='active'",
  " WHERE capability.state IN ('accepted','revoked')",
  "   AND capability.telemetry_schema_version='telemetry-contribution-v1.2'",
  "UNION",
  "SELECT authorization.participant_id,authorization.device_credential_id",
  "  FROM accountless_v12_device_authorizations authorization",
  "  JOIN participants participant ON participant.id=authorization.participant_id AND participant.state='active'",
  "  JOIN storage_v11_owner_links owner_link ON owner_link.participant_id=authorization.participant_id",
  "   AND owner_link.state='active'",
  " WHERE (authorization.state='active'",
  "    AND authorization.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  "    OR (authorization.state='revoked' AND authorization.revocation_reason='user_opt_out')",
].join("\n");
const BASE_JOIN = [
  "JOIN (" + RETAINED_AUTHORIZATION_SCOPE + ") authorization",
  "  ON authorization.participant_id=generation.participant_id",
  " AND authorization.device_id=generation.device_id",
].join("\n");
const OCCURRENCE = /^[A-Za-z0-9._:-]{8,128}$/u;
const UUID = /^[0-9a-f-]{36}$/u;
const PARTICIPANT = /^[A-Za-z0-9._:-]{1,256}$/u;
const MIN_MS = -8_640_000_000_000_000;
const MAX_MS = 8_640_000_000_000_000;
const MAX_DAYS = 101;
/**
 * The occurrence expansion path reduces exact repeated revisions before this
 * bound is applied.  This is an aggregate distinct-variant bound, rather than
 * a per-occurrence multiplier: identical rows from later generations share a
 * representative, while a different device, digest, timestamp, or typed
 * extension remains a separate variant and is never silently discarded.
 */
export const MAX_EFFECTIVE_V12_VARIANT_ROWS = 16_384;
const unavailable = () => new Error("TELEMETRY_V12_EFFECTIVE_UNAVAILABLE");

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw unavailable();
  }
  return value;
}

function day(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)
      || !Number.isFinite(Date.parse(value + "T00:00:00.000Z"))
      || new Date(value + "T00:00:00.000Z").toISOString().slice(0, 10) !== value) {
    throw unavailable();
  }
  return value;
}

function participant(value: unknown): string {
  if (typeof value !== "string" || !PARTICIPANT.test(value)) throw unavailable();
  return value;
}

function occurrence(value: unknown): string {
  if (typeof value !== "string" || !OCCURRENCE.test(value)) throw unavailable();
  return value;
}

function stream(value: unknown): TelemetryV12EffectiveStream {
  if (value !== "usage" && value !== "quota" && value !== "session") throw unavailable();
  return value;
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return Uint8Array.from(value);
  }
  throw unavailable();
}

function hex(value: unknown, expectedLength: number): string {
  const input = bytes(value);
  if (input.length !== expectedLength) throw unavailable();
  return [...input].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function tools(value: unknown, streamName: TelemetryV12EffectiveStream): Record<string, number> | null {
  if (streamName !== "session") return null;
  if (typeof value !== "string") throw unavailable();
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw unavailable();
    const result: Record<string, number> = {};
    for (const [key, count] of Object.entries(parsed)) {
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw unavailable();
      result[key] = count;
    }
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === "TELEMETRY_V12_EFFECTIVE_UNAVAILABLE") throw error;
    throw unavailable();
  }
}

function normalizeV12Record(streamName: TelemetryV12EffectiveStream, value: TelemetryV12Record): string {
  let projected: Record<string, unknown>;
  if (streamName === "usage") {
    const row = value as Extract<TelemetryV12Record, { schemaVersion: "usage-event-v1.2" }>;
    projected = { ...row, schemaVersion: "usage-event-v1.1" };
    delete projected.boundaryFlags;
    delete projected.tieOrder;
    delete projected.cacheWriteTtl;
  } else if (streamName === "quota") {
    projected = { ...(value as Extract<TelemetryV12Record, { schemaVersion: "quota-observation-v1.2" }>),
      schemaVersion: "quota-observation-v1.1" };
  } else {
    projected = { ...(value as Extract<TelemetryV12Record, { schemaVersion: "session-dimension-v1.2" }>),
      schemaVersion: "session-dimension-v1.1" };
  }
  try {
    const parsed = parseTelemetryV11Record(streamName, projected) as TelemetryV11Record;
    return canonicalTelemetryV11Json(parsed);
  } catch {
    throw unavailable();
  }
}

interface TypedStorageRow extends TelemetryV12TypedRecordRow {
  manifest_id: string;
  storage_row_id: number;
  record_index: number;
  tool_json: string | null;
}

async function decodedRow(
  streamName: TelemetryV12EffectiveStream,
  row: TypedStorageRow,
): Promise<TelemetryV12EffectiveRecord> {
  if (!UUID.test(row.manifest_id) || !Number.isSafeInteger(row.storage_row_id) || row.storage_row_id<1 || !Number.isSafeInteger(row.record_index)
      || row.record_index < 0 || row.record_index > 199 || row.stream !== streamName) throw unavailable();
  let decoded: ReturnType<typeof decodeTelemetryV12Record>;
  try {
    decoded = decodeTelemetryV12Record(row, tools(row.tool_json, streamName));
  } catch {
    throw unavailable();
  }
  if (hex(row.canonical_digest, 32) !== await sha256Hex(decoded.canonicalRecord)) throw unavailable();
  let sourceRecord: TelemetryV12Record;
  try { sourceRecord = JSON.parse(decoded.canonicalRecord) as TelemetryV12Record; }
  catch { throw unavailable(); }
  const occurrenceId = occurrence(streamName === "usage"
    ? (sourceRecord as Extract<TelemetryV12Record, { schemaVersion: "usage-event-v1.2" }>).eventId
    : streamName === "quota"
      ? (sourceRecord as Extract<TelemetryV12Record, { schemaVersion: "quota-observation-v1.2" }>).observationId
      : (sourceRecord as Extract<TelemetryV12Record, { schemaVersion: "session-dimension-v1.2" }>).sessionUuid);
  const observedAtMs = integer(decoded.observedAtMs, MIN_MS, MAX_MS);
  if (!Number.isSafeInteger(row.observed_day) || Math.floor(observedAtMs / 86_400_000) !== row.observed_day) {
    throw unavailable();
  }
  let observedAt: string;
  try { observedAt = new Date(observedAtMs).toISOString(); }
  catch { throw unavailable(); }
  return Object.freeze({
    stream: streamName, occurrenceId, observedAt, observedAtMs,
    sourceRecordJson: decoded.canonicalRecord,
    recordJson: normalizeV12Record(streamName, sourceRecord),
    sourceRecordKey: "v12:record:" + row.storage_row_id,
  });
}

async function available(db: D1Database): Promise<boolean> {
  try {
    const rows = (await db.prepare(
      "SELECT name FROM sqlite_master WHERE " +
      "(type='table' AND name IN (" + TABLES.map(() => "?").join(",") + ")) " +
      "OR (type='view' AND name=?)",
    ).bind(...TABLES, AUTHORIZATION_VIEW).all<{ name: string }>()).results;
    if (rows.length === 0) return false;
    if (rows.length !== TABLES.length + 1) throw unavailable();
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === "TELEMETRY_V12_EFFECTIVE_UNAVAILABLE") throw error;
    throw unavailable();
  }
}

function normalizeCursor(value: TelemetryV12EffectiveCursor | undefined): Readonly<TelemetryV12EffectiveCursor> {
  if (value === undefined) return Object.freeze({ observedAtMs: MIN_MS, occurrenceId: "" });
  if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "observedAtMs,occurrenceId") {
    throw unavailable();
  }
  return Object.freeze({
    observedAtMs: integer(value.observedAtMs, MIN_MS, MAX_MS),
    occurrenceId: occurrence(value.occurrenceId),
  });
}

const TYPED_COLUMNS = [
  "r.stream, r.occurrence_id, r.observed_at_ms, r.observed_day, r.canonical_digest",
  "provider.value AS provider",
  "u.session_id, model.value AS model, speed.value AS speed_mode",
  "tier.value AS api_service_tier, surface.value AS surface",
  "billing.value AS billing_surface, effort.value AS reasoning_effort",
  "scope.value AS agent_scope, outcome.value AS outcome",
  "u.total_input_context_tokens, u.input_uncached_tokens",
  "u.input_cache_read_tokens, u.input_cache_write_tokens",
  "u.output_text_tokens, u.output_reasoning_tokens, u.output_combined_tokens",
  "u.boundary_flags, u.tie_order",
  "u.cache_write_ttl_five_minute_tokens, u.cache_write_ttl_one_hour_tokens",
  "qplan.value AS plan_type, qvariant.value AS plan_variant",
  "qlimit.value AS limit_id, qslot.value AS slot",
  "q.used_percent, q.window_duration_minutes, q.resets_at_ms",
  "COALESCE(a.account_basis,qa.account_basis) AS account_basis",
  "COALESCE(a.account_track,qa.account_track) AS account_track",
  "COALESCE(a.plan_basis,qa.plan_basis) AS plan_basis",
  "COALESCE(plan.value,qattrplan.value) AS attribution_plan_type",
  "COALESCE(a.plan_era,qa.plan_era) AS plan_era",
  "CASE WHEN r.stream = 'session' THEN COALESCE((SELECT json_group_object(tool.value, session_tool.count) " +
    "FROM telemetry_v12_session_tools session_tool JOIN typed_telemetry_dictionary tool " +
    "ON tool.id=session_tool.tool_class_id WHERE session_tool.record_id=r.id), '{}') " +
    "ELSE NULL END AS tool_json",
].join(",\n       ");

const TYPED_JOIN = [
  "JOIN typed_telemetry_dictionary provider ON provider.id=r.provider_id",
  "LEFT JOIN telemetry_v12_usage u ON u.record_id=r.id",
  "LEFT JOIN typed_telemetry_dictionary model ON model.id=u.model_id",
  "LEFT JOIN typed_telemetry_dictionary speed ON speed.id=u.speed_mode_id",
  "LEFT JOIN typed_telemetry_dictionary tier ON tier.id=u.api_service_tier_id",
  "LEFT JOIN typed_telemetry_dictionary surface ON surface.id=u.surface_id",
  "LEFT JOIN typed_telemetry_dictionary billing ON billing.id=u.billing_surface_id",
  "LEFT JOIN typed_telemetry_dictionary effort ON effort.id=u.reasoning_effort_id",
  "LEFT JOIN typed_telemetry_dictionary scope ON scope.id=u.agent_scope_id",
  "LEFT JOIN typed_telemetry_dictionary outcome ON outcome.id=u.outcome_id",
  "LEFT JOIN telemetry_v12_attributions a ON a.id=u.attribution_id",
  "LEFT JOIN typed_telemetry_dictionary plan ON plan.id=a.plan_type_id",
  "LEFT JOIN telemetry_v12_quota q ON q.record_id=r.id",
  "LEFT JOIN typed_telemetry_dictionary qplan ON qplan.id=q.plan_type_id",
  "LEFT JOIN typed_telemetry_dictionary qvariant ON qvariant.id=q.plan_variant_id",
  "LEFT JOIN typed_telemetry_dictionary qlimit ON qlimit.id=q.limit_id",
  "LEFT JOIN typed_telemetry_dictionary qslot ON qslot.id=q.slot_id",
  "LEFT JOIN telemetry_v12_attributions qa ON qa.id=q.attribution_id",
  "LEFT JOIN typed_telemetry_dictionary qattrplan ON qattrplan.id=qa.plan_type_id",
].join("\n       ");

function pageSql(): string {
  const occurrenceText = typedTelemetryIdSql("r.occurrence_id");
  return [
    "WITH selected AS (",
    "  SELECT DISTINCT r.id,r.manifest_id,r.record_index,r.stream,r.occurrence_id,",
    "         r.observed_at_ms,r.observed_day,r.canonical_digest",
    "    FROM telemetry_v12_domains generation",
    "    JOIN telemetry_v12_domain_days domain_day ON domain_day.generation_id=generation.id",
    "      AND domain_day.observed_day=?",
    "    JOIN telemetry_v12_day_manifests manifest ON manifest.id=domain_day.manifest_id",
    "      AND manifest.participant_id=generation.participant_id",
    "      AND manifest.device_id=generation.device_id AND manifest.chunk_day=domain_day.observed_day",
    "      AND manifest.manifest_digest=domain_day.manifest_digest AND manifest.state='ready'",
    "    JOIN telemetry_v12_chunks chunk ON chunk.manifest_id=manifest.id",
    "      AND chunk.participant_id=generation.participant_id AND chunk.device_id=generation.device_id",
    "      AND chunk.chunk_day=manifest.chunk_day AND chunk.stream=?",
    "      AND chunk.record_count=(SELECT count(*) FROM telemetry_v12_records complete WHERE complete.chunk_id=chunk.id)",
    "    JOIN telemetry_v12_records r ON r.chunk_id=chunk.id AND r.manifest_id=manifest.id AND r.stream=?",
    "    " + BASE_JOIN,
    "   WHERE generation.participant_id=?",
    "     AND (r.observed_at_ms>? OR (r.observed_at_ms=? AND " + occurrenceText + ">?))",
    "   ORDER BY r.observed_at_ms," + occurrenceText + ",r.manifest_id,r.record_index LIMIT ?",
    ")",
    "SELECT selected.id AS storage_row_id,r.manifest_id,r.record_index," + TYPED_COLUMNS,
    "  FROM selected JOIN telemetry_v12_records r ON r.id=selected.id",
    "  " + TYPED_JOIN,
    " ORDER BY r.observed_at_ms," + occurrenceText + ",r.manifest_id,r.record_index",
  ].join("\n");
}

function occurrenceSql(): string {
  return [
    "WITH requested(occurrence_id) AS MATERIALIZED (SELECT value FROM json_each(?)),",
    "eligible AS MATERIALIZED (",
    "  SELECT r.id,r.manifest_id,r.record_index,r.stream,r.occurrence_id,",
    "         r.observed_at_ms,r.observed_day,r.canonical_digest,",
    "         generation.device_id AS source_device_id,",
    "         " + typedTelemetryIdSql("r.occurrence_id") + " AS occurrence_text",
      "    FROM requested wanted",
      "    JOIN telemetry_v12_records r ON " + typedTelemetryIdSql("r.occurrence_id") +
      "=wanted.occurrence_id AND r.stream=?",
    "    JOIN telemetry_v12_chunks chunk ON chunk.id=r.chunk_id AND chunk.manifest_id=r.manifest_id",
    "      AND chunk.stream=?",
    "      AND chunk.record_count=(SELECT count(*) FROM telemetry_v12_records complete WHERE complete.chunk_id=chunk.id)",
    "    JOIN telemetry_v12_day_manifests manifest ON manifest.id=r.manifest_id",
    "      AND manifest.participant_id=chunk.participant_id AND manifest.device_id=chunk.device_id AND manifest.state='ready'",
    "    JOIN telemetry_v12_domain_days domain_day ON domain_day.manifest_id=manifest.id",
    "      AND domain_day.manifest_digest=manifest.manifest_digest",
      "    JOIN telemetry_v12_domains generation ON generation.id=domain_day.generation_id",
      "      AND generation.participant_id=chunk.participant_id AND generation.device_id=chunk.device_id",
      "    " + BASE_JOIN,
      "   WHERE generation.participant_id=?",
    "), grouped AS MATERIALIZED (",
    "  SELECT MIN(id) AS id,source_device_id,occurrence_text,observed_at_ms,canonical_digest",
    "    FROM eligible",
    "   GROUP BY source_device_id,occurrence_text,observed_at_ms,canonical_digest",
    "), selected AS (",
    "  SELECT id FROM grouped",
    "   ORDER BY occurrence_text,observed_at_ms,source_device_id,id LIMIT ?",
    ")",
    "SELECT selected.id AS storage_row_id,r.manifest_id,r.record_index," + TYPED_COLUMNS,
    "  FROM selected JOIN telemetry_v12_records r ON r.id=selected.id",
    "  " + TYPED_JOIN,
    " ORDER BY r.occurrence_id,r.observed_at_ms,r.manifest_id,r.record_index",
  ].join("\n");
}

/** A candidate is one occurrence coordinate, not one physical revision. */
export interface TelemetryV12EffectiveCandidate {
  readonly occurrenceId: string;
  readonly observedAtMs: number;
}

export interface TelemetryV12EffectiveCandidatePage {
  readonly available: boolean;
  readonly records: readonly TelemetryV12EffectiveCandidate[];
  readonly next: TelemetryV12EffectiveCursor | null;
}

function candidateSql(): string {
  const occurrenceText = typedTelemetryIdSql("r.occurrence_id");
  return [
    "WITH grouped AS MATERIALIZED (",
    "  SELECT " + occurrenceText + " AS occurrence_id,MIN(r.observed_at_ms) AS observed_at_ms",
    "    FROM telemetry_v12_domains generation",
    "    JOIN telemetry_v12_domain_days domain_day ON domain_day.generation_id=generation.id",
    "      AND domain_day.observed_day=?",
    "    JOIN telemetry_v12_day_manifests manifest ON manifest.id=domain_day.manifest_id",
    "      AND manifest.participant_id=generation.participant_id",
    "      AND manifest.device_id=generation.device_id AND manifest.chunk_day=domain_day.observed_day",
    "      AND manifest.manifest_digest=domain_day.manifest_digest AND manifest.state='ready'",
    "    JOIN telemetry_v12_chunks chunk ON chunk.manifest_id=manifest.id",
    "      AND chunk.participant_id=generation.participant_id AND chunk.device_id=generation.device_id",
    "      AND chunk.chunk_day=manifest.chunk_day AND chunk.stream=?",
    "      AND chunk.record_count=(SELECT count(*) FROM telemetry_v12_records complete WHERE complete.chunk_id=chunk.id)",
    "    JOIN telemetry_v12_records r ON r.chunk_id=chunk.id AND r.manifest_id=manifest.id AND r.stream=?",
    "    " + BASE_JOIN,
    "   WHERE generation.participant_id=?",
    "   GROUP BY " + occurrenceText,
    "), selected AS (",
    "  SELECT occurrence_id,observed_at_ms FROM grouped",
    "   WHERE observed_at_ms>? OR (observed_at_ms=? AND occurrence_id>?)",
    "   ORDER BY observed_at_ms,occurrence_id LIMIT ?",
    ")",
    "SELECT occurrence_id,observed_at_ms FROM selected",
  ].join("\n");
}

/**
 * Enumerate v1.2 occurrence candidates after semantic grouping. The physical
 * page remains available for raw source inspection; this path is used only by
 * mixed-reader candidate discovery so repeated manifests cannot consume its
 * source-row allowance before the occurrence groups are expanded.
 */
export async function readTelemetryV12EffectiveCandidatePage(db: D1Database, options: {
  participantId: string; day: string; stream: TelemetryV12EffectiveStream;
  after?: TelemetryV12EffectiveCursor; limit?: number;
}): Promise<TelemetryV12EffectiveCandidatePage> {
  const requestedDay = day(options.day);
  const streamName = stream(options.stream);
  const participantId = participant(options.participantId);
  const cursor = normalizeCursor(options.after);
  const limit = integer(options.limit ?? 100, 1, 200);
  if (!await available(db)) return Object.freeze({ available: false, records: Object.freeze([]), next: null });
  try {
    const rows = (await db.prepare(candidateSql()).bind(
      requestedDay, streamName, streamName, participantId, cursor.observedAtMs,
      cursor.observedAtMs, cursor.occurrenceId, limit + 1,
    ).all<{ occurrence_id: string; observed_at_ms: number }>()).results;
    const records = rows.slice(0, limit).map((row) => Object.freeze({
      occurrenceId: occurrence(row.occurrence_id),
      observedAtMs: integer(row.observed_at_ms, MIN_MS, MAX_MS),
    }));
    const next = rows.length > limit && records.length > 0
      ? Object.freeze({ observedAtMs: records.at(-1)!.observedAtMs, occurrenceId: records.at(-1)!.occurrenceId })
      : null;
    return Object.freeze({ available: true, records: Object.freeze(records), next });
  } catch (error) {
    if (error instanceof Error && error.message === "TELEMETRY_V12_EFFECTIVE_UNAVAILABLE") throw error;
    throw unavailable();
  }
}

export async function readTelemetryV12EffectivePage(db: D1Database, options: {
  participantId: string; day: string; stream: TelemetryV12EffectiveStream;
  after?: TelemetryV12EffectiveCursor; limit?: number;
}): Promise<TelemetryV12EffectivePage> {
  const requestedDay = day(options.day);
  const streamName = stream(options.stream);
  const participantId = participant(options.participantId);
  const cursor = normalizeCursor(options.after);
  const limit = integer(options.limit ?? 100, 1, 200);
  if (!await available(db)) return Object.freeze({ available: false, records: Object.freeze([]), next: null });
  try {
    const rows = (await db.prepare(pageSql()).bind(
      requestedDay, streamName, streamName, participantId, cursor.observedAtMs,
      cursor.observedAtMs, cursor.occurrenceId, limit + 1,
    ).all<TypedStorageRow>()).results;
    const parsed = await Promise.all(rows.slice(0, limit).map((row) => decodedRow(streamName, row)));
    if (parsed.some((row) => row.observedAt.slice(0, 10) !== requestedDay)) throw unavailable();
    const next = rows.length > limit && parsed.length > 0
      ? Object.freeze({ observedAtMs: parsed.at(-1)!.observedAtMs, occurrenceId: parsed.at(-1)!.occurrenceId })
      : null;
    return Object.freeze({ available: true, records: Object.freeze(parsed), next });
  } catch (error) {
    if (error instanceof Error && error.message === "TELEMETRY_V12_EFFECTIVE_UNAVAILABLE") throw error;
    throw unavailable();
  }
}

export async function readTelemetryV12EffectiveOccurrences(db: D1Database, options: {
  participantId: string; stream: TelemetryV12EffectiveStream; occurrenceIds: readonly string[];
}): Promise<{ available: boolean; records: readonly TelemetryV12EffectiveRecord[] }> {
  const streamName = stream(options.stream);
  const participantId = participant(options.participantId);
  if (!Array.isArray(options.occurrenceIds) || options.occurrenceIds.length > 200
      || options.occurrenceIds.some((value) => !OCCURRENCE.test(value))) throw unavailable();
  if (!options.occurrenceIds.length || !await available(db)) return { available: false, records: Object.freeze([]) };
  try {
    const rows = (await db.prepare(occurrenceSql()).bind(
      JSON.stringify(options.occurrenceIds), streamName, streamName, participantId,
      MAX_EFFECTIVE_V12_VARIANT_ROWS + 1,
    ).all<TypedStorageRow>()).results;
    if (rows.length > MAX_EFFECTIVE_V12_VARIANT_ROWS) throw unavailable();
    return {
      available: true,
      records: Object.freeze(await Promise.all(rows.map((row) => decodedRow(streamName, row)))),
    };
  } catch (error) {
    if (error instanceof Error && error.message === "TELEMETRY_V12_EFFECTIVE_UNAVAILABLE") throw error;
    throw unavailable();
  }
}

export async function readTelemetryV12EffectiveDays(db: D1Database, options: {
  participantId: string; fromDay: string; throughDay: string; stream: TelemetryV12EffectiveStream;
}): Promise<readonly string[]> {
  const participantId = participant(options.participantId);
  const fromDay = day(options.fromDay);
  const throughDay = day(options.throughDay);
  const streamName = stream(options.stream);
  const start = Date.parse(fromDay + "T00:00:00.000Z");
  const end = Date.parse(throughDay + "T00:00:00.000Z");
  if (end < start || (end - start) / 86_400_000 + 1 > MAX_DAYS) throw unavailable();
  if (!await available(db)) return Object.freeze([]);
  try {
    const rows = (await db.prepare([
      "SELECT DISTINCT domain_day.observed_day",
      "  FROM telemetry_v12_domains generation",
      "  JOIN telemetry_v12_domain_days domain_day ON domain_day.generation_id=generation.id",
      "  JOIN telemetry_v12_day_manifests manifest ON manifest.id=domain_day.manifest_id",
      "    AND manifest.participant_id=generation.participant_id AND manifest.device_id=generation.device_id",
      "    AND manifest.chunk_day=domain_day.observed_day AND manifest.manifest_digest=domain_day.manifest_digest",
      "    AND manifest.state='ready'",
      "  JOIN telemetry_v12_chunks chunk ON chunk.manifest_id=manifest.id",
      "    AND chunk.participant_id=generation.participant_id AND chunk.device_id=generation.device_id",
      "    AND chunk.chunk_day=manifest.chunk_day AND chunk.stream=?",
      "    AND chunk.record_count=(SELECT count(*) FROM telemetry_v12_records complete WHERE complete.chunk_id=chunk.id)",
      "  JOIN telemetry_v12_records r ON r.chunk_id=chunk.id AND r.manifest_id=manifest.id AND r.stream=?",
      "  " + BASE_JOIN,
      " WHERE generation.participant_id=? AND domain_day.observed_day>=? AND domain_day.observed_day<=?",
      " ORDER BY domain_day.observed_day LIMIT ?",
    ].join("\n")).bind(
      streamName, streamName, participantId, fromDay, throughDay, MAX_DAYS + 1,
    ).all<{ observed_day: string }>()).results;
    if (rows.length > MAX_DAYS) throw unavailable();
    return Object.freeze(rows.map((row) => day(row.observed_day)));
  } catch (error) {
    if (error instanceof Error && error.message === "TELEMETRY_V12_EFFECTIVE_UNAVAILABLE") throw error;
    throw unavailable();
  }
}
