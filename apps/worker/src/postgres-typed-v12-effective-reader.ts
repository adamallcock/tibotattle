import {
  canonicalTelemetryV11Json,
  parseTelemetryV11Record,
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION,
  TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
  MAX_TELEMETRY_V12_DAY_CANONICAL_BYTES,
  MAX_TELEMETRY_V12_DAY_CHUNKS,
  MAX_TELEMETRY_V12_CHUNK_RECORDS,
  type TelemetryV11Record,
  type TelemetryV12Record,
  type TelemetryV12Stream,
} from "@app-usagemonitor/telemetry-contract";
import { sha256Hex } from "./crypto";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaConfig,
} from "./postgres-client";
import {
  decodeTelemetryV12Record,
  type TelemetryV12TypedRecordRow,
} from "./telemetry-v12-typed-codec";
import { decodeTypedTelemetryId, encodeTypedTelemetryId } from "./typed-telemetry-codec";

export type PostgresTelemetryV12EffectiveStream = TelemetryV12Stream;

export interface PostgresTelemetryV12EffectiveCursor {
  readonly observedAtMs: number;
  readonly occurrenceId: string;
}

export interface PostgresTelemetryV12EffectiveRecord {
  readonly stream: PostgresTelemetryV12EffectiveStream;
  readonly occurrenceId: string;
  readonly observedAt: string;
  readonly observedAtMs: number;
  readonly sourceRecordJson: string;
  readonly recordJson: string;
  readonly sourceRecordKey: string;
}

export interface PostgresTelemetryV12EffectivePage {
  readonly available: boolean;
  readonly records: readonly PostgresTelemetryV12EffectiveRecord[];
  readonly next: PostgresTelemetryV12EffectiveCursor | null;
}

export interface PostgresTelemetryV12EffectivePageOptions {
  readonly participantId: string;
  readonly day: string;
  readonly stream: PostgresTelemetryV12EffectiveStream;
  readonly after?: PostgresTelemetryV12EffectiveCursor;
  readonly limit?: number;
}

export interface PostgresTelemetryV12EffectiveReaderOptions {
  readonly schema?: PostgresSchemaConfig;
}

export interface PostgresTelemetryV12EffectiveCandidate {
  readonly occurrenceId: string;
  readonly observedAtMs: number;
}

export interface PostgresTelemetryV12EffectiveCandidatePage {
  readonly available: boolean;
  readonly records: readonly PostgresTelemetryV12EffectiveCandidate[];
  readonly next: PostgresTelemetryV12EffectiveCursor | null;
}

export interface PostgresTelemetryV12EffectiveCandidatePageOptions {
  readonly participantId: string;
  readonly day: string;
  readonly stream: PostgresTelemetryV12EffectiveStream;
  readonly after?: PostgresTelemetryV12EffectiveCursor;
  readonly limit?: number;
}

export interface PostgresTelemetryV12EffectiveOccurrencesOptions {
  readonly participantId: string;
  readonly stream: PostgresTelemetryV12EffectiveStream;
  readonly occurrenceIds: readonly string[];
}

export interface PostgresTelemetryV12EffectiveDaysOptions {
  readonly participantId: string;
  readonly fromDay: string;
  readonly throughDay: string;
  readonly stream: PostgresTelemetryV12EffectiveStream;
}

const TABLES = Object.freeze([
  "telemetry_v12_typed_runtime",
  "typed_telemetry_dictionary",
  "telemetry_v12_typed_attributions",
  "telemetry_v12_typed_records",
  "telemetry_v12_typed_usage",
  "telemetry_v12_typed_quota",
  "telemetry_v12_typed_session_tools",
]);
const VIEWS = Object.freeze([
  "telemetry_v12_typed_active_authorizations",
  "telemetry_v12_typed_retained_authorizations",
]);
const BASE_TABLES = Object.freeze([
  "telemetry_v12_day_manifests",
  "telemetry_v12_chunks",
  "telemetry_v12_domains",
  "telemetry_v12_domain_days",
  "telemetry_v12_domain_heads",
]);
const PARTICIPANT = /^[A-Za-z0-9._:-]{1,256}$/u;
const OCCURRENCE = /^[A-Za-z0-9._:-]{8,128}$/u;
const MIN_MS = -8_640_000_000_000_000;
const MAX_MS = 8_640_000_000_000_000;
const MAX_DAYS = 101;
const MAX_OCCURRENCE_IDS = 200;
const MAX_VARIANT_ROWS = 16_384;
const unavailable = () => new Error("TELEMETRY_V12_EFFECTIVE_UNAVAILABLE");

function schemaName(options: PostgresTelemetryV12EffectiveReaderOptions): string {
  const config = createPostgresSchemaConfig(options.schema ?? {});
  return quotePostgresIdentifier(config.primarySchema);
}

function table(schema: string, name: string): string {
  return `${schema}.${quotePostgresIdentifier(name)}`;
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === "string" && /^-?\d+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw unavailable();
  }
  return parsed;
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

function stream(value: unknown): PostgresTelemetryV12EffectiveStream {
  if (value !== "usage" && value !== "quota" && value !== "session") throw unavailable();
  return value;
}

function normalizeCursor(value: PostgresTelemetryV12EffectiveCursor | undefined): Readonly<PostgresTelemetryV12EffectiveCursor> {
  if (value === undefined) return Object.freeze({ observedAtMs: MIN_MS, occurrenceId: "" });
  if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "observedAtMs,occurrenceId"
      || typeof value.occurrenceId !== "string" || !OCCURRENCE.test(value.occurrenceId)) {
    throw unavailable();
  }
  return Object.freeze({
    observedAtMs: integer(value.observedAtMs, MIN_MS, MAX_MS),
    occurrenceId: value.occurrenceId,
  });
}

function limit(value: unknown): number {
  return integer(value ?? 100, 1, 200);
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return Uint8Array.from(value);
  }
  throw unavailable();
}

function nullableInteger(value: unknown, maximum = 1_000_000_000_000): number | null {
  return value === null || value === undefined ? null : integer(value, 0, maximum);
}

function normalizeV12Record(streamName: PostgresTelemetryV12EffectiveStream, value: TelemetryV12Record): string {
  let projected: Record<string, unknown>;
  if (streamName === "usage") {
    projected = { ...(value as unknown as Record<string, unknown>), schemaVersion: "usage-event-v1.1" };
    delete projected.boundaryFlags;
    delete projected.tieOrder;
    delete projected.cacheWriteTtl;
  } else if (streamName === "quota") {
    projected = { ...(value as unknown as Record<string, unknown>), schemaVersion: "quota-observation-v1.1" };
  } else {
    projected = { ...(value as unknown as Record<string, unknown>), schemaVersion: "session-dimension-v1.1" };
  }
  try {
    const parsed = parseTelemetryV11Record(streamName, projected) as TelemetryV11Record;
    return canonicalTelemetryV11Json(parsed);
  } catch {
    throw unavailable();
  }
}

interface StorageRow extends TelemetryV12TypedRecordRow {
  readonly occurrence_key: string;
  readonly manifest_id: string;
  readonly storage_row_id: string | number;
  readonly record_index: number;
  readonly tool_json: string | null;
}

function tools(value: string | null, streamName: PostgresTelemetryV12EffectiveStream): Record<string, number> | null {
  if (streamName !== "session") return null;
  if (typeof value !== "string") throw unavailable();
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw unavailable();
    const result: Record<string, number> = {};
    for (const [key, count] of Object.entries(parsed)) {
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
        throw unavailable();
      }
      result[key] = count;
    }
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === "TELEMETRY_V12_EFFECTIVE_UNAVAILABLE") throw error;
    throw unavailable();
  }
}

async function decodedRow(
  streamName: PostgresTelemetryV12EffectiveStream,
  row: StorageRow,
): Promise<PostgresTelemetryV12EffectiveRecord> {
  const recordId = integer(row.storage_row_id, 1).toString();
  if (typeof row.manifest_id !== "string" || !/^[0-9a-f-]{36}$/iu.test(row.manifest_id)
      || !Number.isSafeInteger(row.record_index) || row.record_index < 0 || row.record_index > 199
      || row.stream !== streamName) throw unavailable();
  const sourceRow: TelemetryV12TypedRecordRow = {
    ...row,
    occurrence_id: bytes(row.occurrence_id),
    observed_at_ms: integer(row.observed_at_ms, MIN_MS, MAX_MS),
    observed_day: integer(row.observed_day, -100_000, 100_000),
    canonical_digest: bytes(row.canonical_digest),
    session_id: row.session_id == null ? null : bytes(row.session_id),
    total_input_context_tokens: nullableInteger(row.total_input_context_tokens),
    input_uncached_tokens: nullableInteger(row.input_uncached_tokens),
    input_cache_read_tokens: nullableInteger(row.input_cache_read_tokens),
    input_cache_write_tokens: nullableInteger(row.input_cache_write_tokens),
    output_text_tokens: nullableInteger(row.output_text_tokens),
    output_reasoning_tokens: nullableInteger(row.output_reasoning_tokens),
    output_combined_tokens: nullableInteger(row.output_combined_tokens),
    cache_write_ttl_five_minute_tokens: nullableInteger(row.cache_write_ttl_five_minute_tokens),
    cache_write_ttl_one_hour_tokens: nullableInteger(row.cache_write_ttl_one_hour_tokens),
    used_percent: row.used_percent === null ? null : Number(row.used_percent),
    window_duration_minutes: nullableInteger(row.window_duration_minutes, 527_040),
    resets_at_ms: nullableInteger(row.resets_at_ms, MAX_MS),
    account_basis: row.account_basis === null ? null : integer(row.account_basis, 0, 2),
    account_track: row.account_track == null ? null : bytes(row.account_track),
    plan_basis: row.plan_basis === null ? null : integer(row.plan_basis, 0, 3),
    plan_era: row.plan_era == null ? null : bytes(row.plan_era),
  };
  let decoded: ReturnType<typeof decodeTelemetryV12Record>;
  try {
    decoded = decodeTelemetryV12Record(sourceRow, tools(row.tool_json, streamName));
  } catch {
    throw unavailable();
  }
  if (await sha256Hex(decoded.canonicalRecord) !== BufferHex(sourceRow.canonical_digest)) throw unavailable();
  let sourceRecord: TelemetryV12Record;
  try { sourceRecord = JSON.parse(decoded.canonicalRecord) as TelemetryV12Record; }
  catch { throw unavailable(); }
  const occurrenceId = decodeTypedTelemetryId(bytes(row.occurrence_id));
  if (occurrenceId !== row.occurrence_key) throw unavailable();
  const observedAtMs = integer(decoded.observedAtMs, MIN_MS, MAX_MS);
  if (Math.floor(observedAtMs / 86_400_000) !== sourceRow.observed_day) throw unavailable();
  let observedAt: string;
  try { observedAt = new Date(observedAtMs).toISOString(); }
  catch { throw unavailable(); }
  return Object.freeze({
    stream: streamName,
    occurrenceId,
    observedAt,
    observedAtMs,
    sourceRecordJson: decoded.canonicalRecord,
    recordJson: normalizeV12Record(streamName, sourceRecord),
    sourceRecordKey: `v12:record:${recordId}`,
  });
}

function BufferHex(value: unknown): string {
  return [...bytes(value)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

/** The codec's text of a stored id; refuses an undecodable id or an alternate byte spelling. */
function canonicalOccurrence(value: unknown): string {
  try {
    return decodeTypedTelemetryId(bytes(value));
  } catch {
    throw unavailable();
  }
}

async function assertAvailable(client: PostgresClient, schema: string): Promise<boolean> {
  const result = await client.query<{ name: string }>(
    `SELECT relation.relname AS name
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relname = ANY($2::text[])
        AND relation.relkind IN ('r', 'v')`,
    [schema.replaceAll('"', ""), [...TABLES, ...VIEWS]],
  );
  if (result.rows.length === 0) return false;
  if (result.rows.length !== TABLES.length + VIEWS.length
      || new Set(result.rows.map((row) => row.name)).size !== TABLES.length + VIEWS.length) {
    throw unavailable();
  }
  const base = await client.query<{ name: string }>(
    `SELECT relation.relname AS name
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relname = ANY($2::text[])
        AND relation.relkind = 'r'`,
    [schema.replaceAll('"', ""), [...BASE_TABLES]],
  );
  if (base.rows.length !== BASE_TABLES.length
      || new Set(base.rows.map((row) => row.name)).size !== BASE_TABLES.length) throw unavailable();
  const runtime = await client.query<{
    schema_version: string;
    envelope_schema_version: string;
    field_dictionary_version: string;
    privacy_contract_version: string;
    max_day_chunks: number;
    max_chunk_records: number;
    max_day_bytes: number;
  }>(
    `SELECT schema_version, envelope_schema_version, field_dictionary_version,
            privacy_contract_version, max_day_chunks, max_chunk_records, max_day_bytes
       FROM ${table(schema, "telemetry_v12_typed_runtime")}
      WHERE id = 1`,
  );
  const row = runtime.rows[0];
  if (!row || row.schema_version !== TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION
      || row.envelope_schema_version !== TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION
      || row.field_dictionary_version !== TELEMETRY_V12_FIELD_DICTIONARY_VERSION
      || row.privacy_contract_version !== TELEMETRY_V12_PRIVACY_CONTRACT_VERSION
      || row.max_day_chunks !== MAX_TELEMETRY_V12_DAY_CHUNKS
      || row.max_chunk_records !== MAX_TELEMETRY_V12_CHUNK_RECORDS
      || row.max_day_bytes !== MAX_TELEMETRY_V12_DAY_CANONICAL_BYTES) throw unavailable();
  return true;
}

function typedIdTextSql(column: string): string {
  const encoded = `encode(substring(${column} from 2), 'hex')`;
  const uuid = `substr(${encoded},1,8)||'-'||substr(${encoded},9,4)||'-'||substr(${encoded},13,4)||'-'||substr(${encoded},17,4)||'-'||substr(${encoded},21,12)`;
  const cases = [
    [0, `convert_from(substring(${column} from 2), 'UTF8')`, 2, 257],
    [1, uuid, 17, 17],
    [2, `'participant:'||(${uuid})`, 17, 17],
    [3, `'device:'||(${uuid})`, 17, 17],
    [4, `'v1:'||(${uuid})`, 17, 17],
    [5, `'contribution:'||(${uuid})`, 17, 17],
    [6, encoded, 33, 33],
    [7, `'event:v2:'||(${encoded})`, 33, 33],
    [8, `'quota-occurrence:v1:'||(${encoded})`, 33, 33],
    [9, `'account-track:v2:'||(${encoded})`, 33, 33],
    [10, `'plan-era:v1:'||(${encoded})`, 33, 33],
    [11, `'chunk:'||(${uuid})`, 17, 17],
  ];
  return `(CASE ${cases.map(([tag, text, minimum, maximum]) =>
    `WHEN get_byte(${column},0)=${tag} AND octet_length(${column}) BETWEEN ${minimum} AND ${maximum} THEN ${text}`).join(" ")} ELSE NULL END)`;
}

function recordColumns(schema: string): string {
  return [
  "r.stream, r.occurrence_id, r.observed_at_ms, r.observed_day, r.canonical_digest",
  "provider.value AS provider",
  "u.session_id, model.value AS model, speed.value AS speed_mode",
  "tier.value AS api_service_tier, surface.value AS surface",
  "billing.value AS billing_surface, effort.value AS reasoning_effort",
  "scope.value AS agent_scope, outcome.value AS outcome",
  "u.total_input_context_tokens, u.input_uncached_tokens, u.input_cache_read_tokens",
  "u.input_cache_write_tokens, u.output_text_tokens, u.output_reasoning_tokens, u.output_combined_tokens",
  "u.boundary_flags, u.tie_order, u.cache_write_ttl_five_minute_tokens, u.cache_write_ttl_one_hour_tokens",
  "qplan.value AS plan_type, qvariant.value AS plan_variant, qlimit.value AS limit_id, qslot.value AS slot",
  "q.used_percent, q.window_duration_minutes, q.resets_at_ms",
  "COALESCE(ua.account_basis, qa.account_basis) AS account_basis",
  "COALESCE(ua.account_track, qa.account_track) AS account_track",
  "COALESCE(ua.plan_basis, qa.plan_basis) AS plan_basis",
  "COALESCE(uaplan.value, qaplan.value) AS attribution_plan_type",
  "COALESCE(ua.plan_era, qa.plan_era) AS plan_era",
  `CASE WHEN r.stream = 'session' THEN COALESCE((SELECT jsonb_object_agg(tool.value, session_tool.count)::text FROM ${table(schema, "telemetry_v12_typed_session_tools")} session_tool JOIN ${table(schema, "typed_telemetry_dictionary")} tool ON tool.id=session_tool.tool_class_id WHERE session_tool.record_id=r.id), '{}') ELSE NULL END AS tool_json`,
  ].join(",\n       ");
}

function recordJoins(schema: string): string {
  return [
    `JOIN ${table(schema, "typed_telemetry_dictionary")} provider ON provider.id=r.provider_id`,
    `LEFT JOIN ${table(schema, "telemetry_v12_typed_usage")} u ON u.record_id=r.id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} model ON model.id=u.model_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} speed ON speed.id=u.speed_mode_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} tier ON tier.id=u.api_service_tier_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} surface ON surface.id=u.surface_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} billing ON billing.id=u.billing_surface_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} effort ON effort.id=u.reasoning_effort_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} scope ON scope.id=u.agent_scope_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} outcome ON outcome.id=u.outcome_id`,
    `LEFT JOIN ${table(schema, "telemetry_v12_typed_attributions")} ua ON ua.id=u.attribution_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} uaplan ON uaplan.id=ua.plan_type_id`,
    `LEFT JOIN ${table(schema, "telemetry_v12_typed_quota")} q ON q.record_id=r.id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} qplan ON qplan.id=q.plan_type_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} qvariant ON qvariant.id=q.plan_variant_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} qlimit ON qlimit.id=q.limit_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} qslot ON qslot.id=q.slot_id`,
    `LEFT JOIN ${table(schema, "telemetry_v12_typed_attributions")} qa ON qa.id=q.attribution_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} qaplan ON qaplan.id=qa.plan_type_id`,
  ].join("\n       ");
}

/*
 * Statement shape. Every read below selects the same records: a record of
 * the requested stream in a complete chunk (its record_count equals its
 * stored rows) of a ready manifest of the participant's current-head
 * generation, on a retained authorization. Each statement is shaped so its
 * cost follows the page, the batch or the day window, not the owner.
 *
 * The predicates that do not involve the chunk or the record (generation,
 * head, domain day, manifest, retained authorization) are fenced first as
 * the head manifests in scope: one row per manifest, carrying the
 * participant, device and day every chunk predicate compares with (the
 * manifest join makes them the generation's). A record is selected exactly
 * when its manifest is in scope and its own chunk satisfies the chunk
 * predicates against that manifest, so each read probes the scope's
 * manifests on their (manifest_id, stream, ...) keys and checks chunk
 * completeness only for the chunks it reaches. Without the fence the
 * planner's one-row estimate of the completeness chain led it to join every
 * record of the owner (or of the day, ANDed with a whole-day index scan per
 * chunk) for each page or batch: a read quadratic in owner size.
 *
 * Every statement deduplicates what it selects (DISTINCT, GROUP BY or a
 * min(id) group), so the multiplicity of the joins never reaches a result.
 *
 * Refusals are positional. A page or batch validates the rows it returns and
 * refuses when one cannot be read (an id with no codec text or a
 * noncanonical spelling, a digest mismatch, a malformed record), so a page
 * that ends before such a record succeeds and the page that reaches it
 * refuses. Pages cover a day contiguously and no record can fall between
 * them: an id with no codec text sorts last at its instant and the cursor
 * never excludes it, a candidate page orders an id's raw spelling before its
 * compressed one, and a record page refuses when its next record shares the
 * cursor's instant and id. A complete walk of a day therefore refuses
 * whenever any record in scope is unreadable. (Statements that regrouped or
 * sorted the whole day on every page also refused earlier pages, as a side
 * effect of the cost this shape removes.)
 */

/** The current-head manifests in scope, one row per manifest. */
function headManifestsSql(schema: string, participantParameter: string, dayFilter: string): string {
  return [
    "SELECT DISTINCT manifest.id AS manifest_id,manifest.participant_id,manifest.device_id,manifest.chunk_day",
    `  FROM ${table(schema, "telemetry_v12_domains")} generation`,
    `  JOIN ${table(schema, "telemetry_v12_domain_heads")} active_head`,
    "    ON active_head.participant_id=generation.participant_id AND active_head.generation_id=generation.id",
    `  JOIN ${table(schema, "telemetry_v12_domain_days")} domain_day ON domain_day.generation_id=generation.id${dayFilter}`,
    `  JOIN ${table(schema, "telemetry_v12_day_manifests")} manifest ON manifest.id=domain_day.manifest_id`,
    "    AND manifest.participant_id=generation.participant_id AND manifest.device_id=generation.device_id",
    "    AND manifest.chunk_day=domain_day.observed_day AND manifest.manifest_digest=domain_day.manifest_digest",
    "    AND manifest.state='ready'",
    `  JOIN ${table(schema, "telemetry_v12_typed_retained_authorizations")} retained_auth`,
    "    ON retained_auth.participant_id=generation.participant_id AND retained_auth.device_id=generation.device_id",
    ` WHERE generation.participant_id=${participantParameter}`,
  ].join("\n");
}

/** The chunk predicates of the reads for one record against its scoped manifest. */
function chunkPredicatesSql(schema: string, chunk: string, scope: string, streamParameter: string): string {
  return [
    `${chunk}.manifest_id=${scope}.manifest_id`,
    `${chunk}.participant_id=${scope}.participant_id AND ${chunk}.device_id=${scope}.device_id`,
    `${chunk}.chunk_day=${scope}.chunk_day AND ${chunk}.stream=${streamParameter}`,
    `${chunk}.record_count=(SELECT count(*) FROM ${table(schema, "telemetry_v12_typed_records")} complete WHERE complete.chunk_id=${chunk}.id)`,
  ].join(" AND ");
}

/** True when `record` lies in a complete chunk of the stream in its scoped manifest. */
function completeChunkSql(schema: string, record: string, scope: string, streamParameter: string, chunk: string): string {
  return `EXISTS (SELECT 1 FROM ${table(schema, "telemetry_v12_chunks")} ${chunk}`
    + ` WHERE ${chunk}.id=${record}.chunk_id AND ${chunkPredicatesSql(schema, chunk, scope, streamParameter)})`;
}

/**
 * The same check as a per-record join: `record`'s own chunk (the primary
 * key, so at most one row), fenced by OFFSET 0 so the planner keeps the
 * record scan as the driver and checks only the records it reaches.
 */
function completeChunkJoinSql(schema: string, record: string, scope: string, streamParameter: string, chunk: string): string {
  return `CROSS JOIN LATERAL (SELECT ${chunk}.id FROM ${table(schema, "telemetry_v12_chunks")} ${chunk}`
    + ` WHERE ${chunk}.id=${record}.chunk_id AND ${chunkPredicatesSql(schema, chunk, scope, streamParameter)}`
    + ` OFFSET 0) ${chunk}_complete`;
}

/**
 * $1 day, $2 stream, $3 participant, $4/$5 cursor, $6 limit. The page is the
 * first $6 selected records after the cursor in (observed_at_ms,
 * occurrence, manifest, record_index) order. Each scoped manifest (the day
 * has one per head generation) contributes its own first $6 in that order
 * from its (manifest_id, stream, observed_at_ms) index, so the union holds
 * the overall first $6.
 */
function pageSql(schema: string): string {
  const occurrence = typedIdTextSql("r.occurrence_id");
  return [
    "WITH scope AS MATERIALIZED (",
    headManifestsSql(schema, "$3", " AND domain_day.observed_day=$1::date"),
    "), selected AS (",
    "  SELECT DISTINCT page.id,page.manifest_key,page.manifest_id,page.record_index,page.stream,page.occurrence_id,",
    "         page.occurrence_key,page.observed_at_ms,page.observed_day,page.canonical_digest",
    "    FROM scope CROSS JOIN LATERAL (",
    "      SELECT r.id,r.manifest_id COLLATE \"C\" AS manifest_key,r.manifest_id,r.record_index,r.stream,r.occurrence_id,",
    `             (${occurrence}) COLLATE "C" AS occurrence_key,r.observed_at_ms,r.observed_day,r.canonical_digest`,
    `        FROM ${table(schema, "telemetry_v12_typed_records")} r`,
    `        ${completeChunkJoinSql(schema, "r", "scope", "$2", "chunk")}`,
    "       WHERE r.manifest_id=scope.manifest_id AND r.stream=$2 AND r.observed_at_ms>=$4",
    `         AND (r.observed_at_ms>$4 OR (r.observed_at_ms=$4 AND ((${occurrence}) IS NULL OR (${occurrence} COLLATE "C")>($5::text COLLATE "C"))))`,
    "       ORDER BY r.observed_at_ms,occurrence_key,manifest_key,r.record_index LIMIT $6",
    "    ) page",
    "   ORDER BY page.observed_at_ms,page.occurrence_key,page.manifest_key,page.record_index LIMIT $6",
    ")",
    "SELECT selected.id::text AS storage_row_id,selected.occurrence_key,selected.manifest_id,selected.record_index,",
    `       ${recordColumns(schema)}`,
    `  FROM selected JOIN ${table(schema, "telemetry_v12_typed_records")} r ON r.id=selected.id`,
    `  ${recordJoins(schema)}`,
    ` ORDER BY r.observed_at_ms,selected.occurrence_key COLLATE "C",r.manifest_id COLLATE "C",r.record_index`,
  ].join("\n");
}

/**
 * $1 day, $2 stream, $3 participant, $4/$5 cursor, $6 limit. An occurrence's
 * candidate time is the earliest observed_at_ms among its selected records
 * of the day. A selected record is its occurrence's earliest exactly when
 * no selected record of the same occurrence id is earlier (one probe of the
 * scope on the (manifest_id, stream, occurrence_id) key), and those earliest
 * records after the cursor, in (observed_at_ms, occurrence) order, are the
 * candidates in page order. An occurrence id is unique within a manifest's
 * stream, so each scoped manifest's first $6 such records are distinct
 * candidates and the union holds the overall first $6.
 *
 * The probe compares stored ids, not texts. The codec admits one stored
 * spelling per id, so for admitted data that is grouping by text. A second
 * spelling of one text (only in corrupt storage: a compressed id stored raw)
 * would be a second candidate, so each candidate carries its stored id and
 * the page refuses one that is not the codec's spelling of its text. The
 * stored id is the last ordering key, so at one instant a raw spelling
 * (tag 0) precedes the compressed one and is returned no later than its twin.
 */
function candidateSql(schema: string): string {
  const occurrence = typedIdTextSql("r.occurrence_id");
  return [
    "WITH scope AS MATERIALIZED (",
    headManifestsSql(schema, "$3", " AND domain_day.observed_day=$1::date"),
    "), picked AS MATERIALIZED (",
    "  SELECT DISTINCT candidate.occurrence_key AS occurrence_id,candidate.observed_at_ms,candidate.occurrence_bytes",
    "    FROM scope CROSS JOIN LATERAL (",
    `      SELECT (${occurrence}) COLLATE "C" AS occurrence_key,r.observed_at_ms,r.occurrence_id AS occurrence_bytes`,
    `        FROM ${table(schema, "telemetry_v12_typed_records")} r`,
    `        ${completeChunkJoinSql(schema, "r", "scope", "$2", "chunk")}`,
    "       WHERE r.manifest_id=scope.manifest_id AND r.stream=$2 AND r.observed_at_ms>=$4::bigint",
    `         AND (r.observed_at_ms>$4::bigint OR (r.observed_at_ms=$4::bigint AND ((${occurrence}) IS NULL OR (${occurrence}) COLLATE "C">($5::text COLLATE "C"))))`,
    "         AND NOT EXISTS (",
    `           SELECT 1 FROM scope earlier_scope JOIN ${table(schema, "telemetry_v12_typed_records")} earlier`,
    "             ON earlier.manifest_id=earlier_scope.manifest_id AND earlier.stream=$2",
    "            AND earlier.occurrence_id=r.occurrence_id AND earlier.observed_at_ms<r.observed_at_ms",
    `          WHERE ${completeChunkSql(schema, "earlier", "earlier_scope", "$2", "earlier_chunk")})`,
    "       ORDER BY r.observed_at_ms,occurrence_key,r.occurrence_id LIMIT $6",
    "    ) candidate",
    ")",
    "SELECT occurrence_id,observed_at_ms,occurrence_bytes FROM picked",
    " ORDER BY observed_at_ms,occurrence_id COLLATE \"C\",occurrence_bytes LIMIT $6",
  ].join("\n");
}

/**
 * $1 requested ids (hex JSON array), $2 stream, $3 participant, $4 limit.
 * Each scoped manifest (one per head day) is probed once on its
 * (manifest_id, stream, occurrence_id) key for the batch's ids; OFFSET 0
 * keeps the probe per manifest.
 */
function occurrenceSql(schema: string): string {
  const occurrence = typedIdTextSql("r.occurrence_id");
  return [
    "WITH requested AS MATERIALIZED (",
    "  SELECT DISTINCT decode(value, 'hex') AS occurrence_id",
    "    FROM jsonb_array_elements_text($1::jsonb) AS requested(value)",
    "), scope AS MATERIALIZED (",
    headManifestsSql(schema, "$3", ""),
    "), eligible AS MATERIALIZED (",
    "  SELECT r.id,r.occurrence_id,",
    `         (${occurrence}) COLLATE "C" AS occurrence_key,r.observed_at_ms,r.canonical_digest,`,
    "         scope.device_id AS source_device_id",
    "    FROM scope CROSS JOIN LATERAL (",
    `      SELECT probe.* FROM ${table(schema, "telemetry_v12_typed_records")} probe`,
    "       WHERE probe.manifest_id=scope.manifest_id AND probe.stream=$2",
    "         AND probe.occurrence_id=ANY(ARRAY(SELECT wanted.occurrence_id FROM requested wanted))",
    "      OFFSET 0",
    "    ) r",
    `   WHERE ${completeChunkSql(schema, "r", "scope", "$2", "chunk")}`,
    "), grouped AS MATERIALIZED (",
    "  SELECT min(id) AS id,source_device_id,occurrence_id,occurrence_key,observed_at_ms,canonical_digest",
    "    FROM eligible",
    "   GROUP BY source_device_id,occurrence_id,occurrence_key,observed_at_ms,canonical_digest",
    "), selected AS (",
    "  SELECT id,occurrence_key FROM grouped",
    "   ORDER BY occurrence_key COLLATE \"C\",observed_at_ms,source_device_id COLLATE \"C\",id",
    "   LIMIT $4",
    ")",
    "SELECT selected.id::text AS storage_row_id,selected.occurrence_key,r.manifest_id,r.record_index,",
    `       ${recordColumns(schema)}`,
    `  FROM selected JOIN ${table(schema, "telemetry_v12_typed_records")} r ON r.id=selected.id`,
    `  ${recordJoins(schema)}`,
    " ORDER BY selected.occurrence_key COLLATE \"C\",r.observed_at_ms,r.manifest_id COLLATE \"C\",r.record_index",
  ].join("\n");
}

/**
 * $1 stream, $2 participant, $3/$4 day window, $5 limit. A scoped day is
 * nonempty when one complete chunk of the stream in its manifest holds a
 * record of the stream. The manifest's chunks are reached on manifest_id
 * alone and each chunk's records on chunk_id alone, each fenced by OFFSET 0
 * so no other predicate is pushed into the scan: unfenced, the planner ANDed
 * the probes with index scans of every chunk of the owner and every record
 * of the day. The probe stops at the first such chunk.
 */
function daysSql(schema: string): string {
  return [
    "WITH scope AS MATERIALIZED (",
    headManifestsSql(schema, "$2",
      " AND domain_day.observed_day >= $3::date AND domain_day.observed_day <= $4::date"),
    ")",
    "SELECT DISTINCT to_char(scope.chunk_day, 'YYYY-MM-DD') AS observed_day",
    "  FROM scope",
    " WHERE EXISTS (",
    `   SELECT 1 FROM (SELECT manifest_chunk.* FROM ${table(schema, "telemetry_v12_chunks")} manifest_chunk`,
    "                   WHERE manifest_chunk.manifest_id=scope.manifest_id OFFSET 0) chunk",
    `    WHERE ${chunkPredicatesSql(schema, "chunk", "scope", "$1")}`,
    "      AND EXISTS (",
    `        SELECT 1 FROM (SELECT chunk_record.manifest_id,chunk_record.stream FROM ${table(schema, "telemetry_v12_typed_records")} chunk_record`,
    "                        WHERE chunk_record.chunk_id=chunk.id OFFSET 0) r",
    "         WHERE r.manifest_id=scope.manifest_id AND r.stream=$1))",
    " ORDER BY observed_day LIMIT $5",
  ].join("\n");
}

/** Read one bounded effective-record page from complete, authorized v1.2 domains. */
export async function readPostgresTelemetryV12EffectivePage(
  pool: PostgresPool,
  options: PostgresTelemetryV12EffectivePageOptions,
  readerOptions: PostgresTelemetryV12EffectiveReaderOptions = {},
): Promise<PostgresTelemetryV12EffectivePage> {
  const requestedDay = day(options.day);
  const streamName = stream(options.stream);
  const participantId = participant(options.participantId);
  const cursor = normalizeCursor(options.after);
  const pageLimit = limit(options.limit);
  const schema = schemaName(readerOptions);
  try {
    return await withPostgresRead(pool, async (client) => {
      if (!await assertAvailable(client, schema)) {
        return Object.freeze({ available: false, records: Object.freeze([]), next: null });
      }
      const query = await client.query<StorageRow>(
        pageSql(schema),
        [requestedDay, streamName, participantId, cursor.observedAtMs,
          cursor.occurrenceId, pageLimit + 1],
      );
      const parsed = await Promise.all(query.rows.slice(0, pageLimit).map((row) => decodedRow(streamName, row)));
      if (parsed.some((record) => record.observedAt.slice(0, 10) !== requestedDay)) throw unavailable();
      // The cursor names an instant and an id. A next record with both of the
      // last record's could not be addressed, so refuse rather than skip it.
      const following = query.rows[pageLimit];
      if (following !== undefined && parsed.length > 0
          && integer(following.observed_at_ms, MIN_MS, MAX_MS) === parsed.at(-1)!.observedAtMs
          && following.occurrence_key === parsed.at(-1)!.occurrenceId) throw unavailable();
      const next = query.rows.length > pageLimit && parsed.length > 0
        ? Object.freeze({
          observedAtMs: parsed.at(-1)!.observedAtMs,
          occurrenceId: parsed.at(-1)!.occurrenceId,
        })
        : null;
      return Object.freeze({ available: true, records: Object.freeze(parsed), next });
    }, { operation: "typed_v12.effective_page", statementTimeoutMilliseconds: 10_000, lockTimeoutMilliseconds: 5_000 });
  } catch (error) {
    if (error instanceof Error && error.message === "TELEMETRY_V12_EFFECTIVE_UNAVAILABLE") throw error;
    throw unavailable();
  }
}

/** Read a bounded, occurrence-grouped page from the current authorized v1.2 head. */
export async function readPostgresTelemetryV12EffectiveCandidatePage(
  pool: PostgresPool,
  options: PostgresTelemetryV12EffectiveCandidatePageOptions,
  readerOptions: PostgresTelemetryV12EffectiveReaderOptions = {},
): Promise<PostgresTelemetryV12EffectiveCandidatePage> {
  const requestedDay = day(options.day);
  const streamName = stream(options.stream);
  const participantId = participant(options.participantId);
  const cursor = normalizeCursor(options.after);
  const pageLimit = limit(options.limit);
  const schema = schemaName(readerOptions);
  try {
    return await withPostgresRead(pool, async (client) => {
      if (!await assertAvailable(client, schema)) {
        return Object.freeze({ available: false, records: Object.freeze([]), next: null });
      }
      const query = await client.query<{
        occurrence_id: string | null;
        observed_at_ms: number | string;
        occurrence_bytes: unknown;
      }>(
        candidateSql(schema),
        [requestedDay, streamName, participantId, cursor.observedAtMs,
          cursor.occurrenceId, pageLimit + 1],
      );
      const records = query.rows.slice(0, pageLimit).map((row) => {
        if (typeof row.occurrence_id !== "string" || !OCCURRENCE.test(row.occurrence_id)
            || canonicalOccurrence(row.occurrence_bytes) !== row.occurrence_id) throw unavailable();
        return Object.freeze({
          occurrenceId: row.occurrence_id,
          observedAtMs: integer(row.observed_at_ms, MIN_MS, MAX_MS),
        });
      });
      const next = query.rows.length > pageLimit && records.length > 0
        ? Object.freeze({
          observedAtMs: records.at(-1)!.observedAtMs,
          occurrenceId: records.at(-1)!.occurrenceId,
        })
        : null;
      return Object.freeze({ available: true, records: Object.freeze(records), next });
    }, { operation: "typed_v12.effective_candidates", statementTimeoutMilliseconds: 10_000, lockTimeoutMilliseconds: 5_000 });
  } catch (error) {
    if (error instanceof Error && error.message === "TELEMETRY_V12_EFFECTIVE_UNAVAILABLE") throw error;
    throw unavailable();
  }
}

/** Expand a bounded set of candidate IDs into distinct current-head v1.2 variants. */
export async function readPostgresTelemetryV12EffectiveOccurrences(
  pool: PostgresPool,
  options: PostgresTelemetryV12EffectiveOccurrencesOptions,
  readerOptions: PostgresTelemetryV12EffectiveReaderOptions = {},
): Promise<{ readonly available: boolean; readonly records: readonly PostgresTelemetryV12EffectiveRecord[] }> {
  const streamName = stream(options.stream);
  const participantId = participant(options.participantId);
  if (!Array.isArray(options.occurrenceIds) || options.occurrenceIds.length > MAX_OCCURRENCE_IDS
      || options.occurrenceIds.some((value) => typeof value !== "string" || !OCCURRENCE.test(value))) {
    throw unavailable();
  }
  if (options.occurrenceIds.length === 0) return { available: false, records: Object.freeze([]) };
  const uniqueIds = [...new Set(options.occurrenceIds)];
  let encodedIds: string[];
  try {
    encodedIds = uniqueIds.map((value) => [...encodeTypedTelemetryId(value)]
      .map((item) => item.toString(16).padStart(2, "0")).join(""));
  } catch {
    throw unavailable();
  }
  const schema = schemaName(readerOptions);
  try {
    return await withPostgresRead(pool, async (client) => {
      if (!await assertAvailable(client, schema)) {
        return { available: false, records: Object.freeze([]) };
      }
      const query = await client.query<StorageRow>(
        occurrenceSql(schema),
        [JSON.stringify(encodedIds), streamName, participantId, MAX_VARIANT_ROWS + 1],
      );
      if (query.rows.length > MAX_VARIANT_ROWS) throw unavailable();
      const records = await Promise.all(query.rows.map((row) => decodedRow(streamName, row)));
      if (new Set(records.map((record) => record.sourceRecordKey)).size !== records.length) throw unavailable();
      return { available: true, records: Object.freeze(records) };
    }, { operation: "typed_v12.effective_occurrences", statementTimeoutMilliseconds: 10_000, lockTimeoutMilliseconds: 5_000 });
  } catch (error) {
    if (error instanceof Error && error.message === "TELEMETRY_V12_EFFECTIVE_UNAVAILABLE") throw error;
    throw unavailable();
  }
}

/** Enumerate nonempty active-head evidence days within a bounded UTC interval. */
export async function readPostgresTelemetryV12EffectiveDays(
  pool: PostgresPool,
  options: PostgresTelemetryV12EffectiveDaysOptions,
  readerOptions: PostgresTelemetryV12EffectiveReaderOptions = {},
): Promise<readonly string[]> {
  const participantId = participant(options.participantId);
  const fromDay = day(options.fromDay);
  const throughDay = day(options.throughDay);
  const streamName = stream(options.stream);
  const fromMs = Date.parse(`${fromDay}T00:00:00.000Z`);
  const throughMs = Date.parse(`${throughDay}T00:00:00.000Z`);
  if (throughMs < fromMs || (throughMs - fromMs) / 86_400_000 + 1 > MAX_DAYS) throw unavailable();
  const schema = schemaName(readerOptions);
  try {
    return await withPostgresRead(pool, async (client) => {
      if (!await assertAvailable(client, schema)) return Object.freeze([]);
      const query = await client.query<{ observed_day: string }>(
        daysSql(schema),
        [streamName, participantId, fromDay, throughDay, MAX_DAYS + 1],
      );
      if (query.rows.length > MAX_DAYS) throw unavailable();
      const result = query.rows.map((row) => day(row.observed_day));
      if (new Set(result).size !== result.length) throw unavailable();
      return Object.freeze(result);
    }, { operation: "typed_v12.effective_days", statementTimeoutMilliseconds: 10_000, lockTimeoutMilliseconds: 5_000 });
  } catch (error) {
    if (error instanceof Error && error.message === "TELEMETRY_V12_EFFECTIVE_UNAVAILABLE") throw error;
    throw unavailable();
  }
}
