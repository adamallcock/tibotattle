import type { TelemetryV11Attribution } from "@app-usagemonitor/telemetry-contract";
import { sha256Hex } from "./crypto";
import {
  decodeTypedTelemetryId, encodeTypedTelemetryId, typedTelemetryCanonicalRecords,
  TypedTelemetryError, type TypedTelemetryFields, type TypedTelemetryFormat, type TypedTelemetryRecord,
} from "./typed-telemetry-codec";

/** Raw retained evidence only. These views do not select active domains, grant
 * consent, authenticate a caller, or claim public-source eligibility. A caller
 * needing generation_id must join its separately preserved domain authority;
 * that identity cannot be inferred from an individual raw record/manifest. */
export const TYPED_TELEMETRY_COMPATIBILITY_VIEW = "typed_telemetry_compatibility_records";
export const TYPED_TELEMETRY_SESSION_TOOLS_VIEW = "typed_telemetry_compatibility_session_tools";
export const MAX_TYPED_TELEMETRY_COMPATIBILITY_PAGE = 200;
export const TYPED_TELEMETRY_COMPATIBILITY_COLUMNS = [
  "storage_row_id", "namespace_id", "owner_id", "format_code", "stream_code", "source_namespace", "format",
  "source_row_id", "id", "participant_id", "device_id", "chunk_row_id", "manifest_id", "stream", "schema_version",
  "occurrence_id", "observed_at_ms", "observed_at", "observed_day", "chunk_day", "provider", "model_id", "session_uuid",
  "speed_mode", "api_service_tier", "surface", "billing_surface", "reasoning_effort", "agent_scope", "outcome",
  "total_input_context_tokens", "input_uncached_tokens", "input_cache_read_tokens", "input_cache_write_tokens",
  "output_text_tokens", "output_reasoning_tokens", "output_combined_tokens", "plan_type", "plan_variant", "limit_id", "slot",
  "used_percent", "window_duration_minutes", "resets_at_ms", "resets_at", "attribution_id", "account_basis",
  "account_track_id", "plan_basis", "attribution_plan_type", "plan_era_id", "usage_record_id", "quota_record_id", "canonical_sha256",
  // Internal reversible bytes allow the bounded reader to reject noncanonical
  // tag spellings. They are omitted from the returned compatibility objects.
  "_namespace_blob", "_owner_blob", "_device_blob", "_chunk_blob", "_manifest_blob", "_occurrence_blob",
  "_session_blob", "_account_track_blob", "_plan_era_blob",
] as const;

export interface TypedTelemetryCompatibilityCursor {
  observedAtMs: number;
  format: TypedTelemetryFormat;
  sourceRowId: number;
}
export interface TypedTelemetryCompatibilityOptions {
  sourceNamespace: string;
  participantId: string;
  stream: "usage" | "quota" | "session";
  /** Inclusive start, exclusive end; integer milliseconds avoid ISO-sort drift. */
  fromObservedAtMs?: number;
  beforeObservedAtMs?: number;
  after?: TypedTelemetryCompatibilityCursor;
  limit?: number;
}

export interface TypedTelemetryCompatibilityRecord {
  source_namespace: string;
  format: TypedTelemetryFormat;
  source_row_id: number;
  /** Original namespace + format scoped ID, never the new database rowid. */
  id: number;
  participant_id: string;
  device_id: string;
  chunk_row_id: string;
  manifest_id: string | null;
  stream: "usage" | "quota" | "session";
  schema_version: string;
  occurrence_id: string;
  observed_at_ms: number;
  observed_at: string;
  observed_day: string;
  chunk_day: string;
  provider: string;
  model_id: string | null;
  session_uuid: string | null;
  speed_mode: string | null;
  api_service_tier: string | null;
  surface: string | null;
  billing_surface: string | null;
  reasoning_effort: string | null;
  agent_scope: string | null;
  outcome: string | null;
  total_input_context_tokens: number | null;
  input_uncached_tokens: number | null;
  input_cache_read_tokens: number | null;
  input_cache_write_tokens: number | null;
  output_text_tokens: number | null;
  output_reasoning_tokens: number | null;
  output_combined_tokens: number | null;
  plan_type: string | null;
  plan_variant: string | null;
  limit_id: string | null;
  slot: string | null;
  used_percent: number | null;
  window_duration_minutes: number | null;
  resets_at_ms: number | null;
  resets_at: string | null;
  account_basis: string | null;
  account_track_id: string | null;
  plan_basis: string | null;
  attribution_plan_type: string | null;
  plan_era_id: string | null;
  canonical_sha256: string;
  tool_class_counts: Record<string, number> | null;
  /** Only the maintained ECMAScript codec produces these canonical bytes. */
  record_json: string;
  legacy_occurrence_id: string | null;
  legacy_record_json: string | null;
  record: TypedTelemetryRecord;
}

/** The materialized page contains at most 201 integer IDs. The owner/time index
 * admits those IDs before any dictionary expansion or compatibility decoding.
 * CROSS JOIN keeps that bounded page outside the per-row primary-key lookup. */
export const TYPED_TELEMETRY_COMPATIBILITY_PAGE_SQL = `WITH page AS MATERIALIZED (
  SELECT r.id FROM typed_telemetry_records r INDEXED BY typed_telemetry_owner_time
  WHERE r.owner_id = (SELECT o.id FROM typed_telemetry_owners o
    WHERE o.namespace_id = (SELECT n.id FROM typed_telemetry_namespaces n WHERE n.original_id = ?)
      AND o.original_id = ?)
    AND r.stream = ? AND r.observed_at_ms >= ? AND r.observed_at_ms < ?
    AND (r.observed_at_ms, r.format, r.source_row_id) > (?, ?, ?)
  ORDER BY r.observed_at_ms, r.format, r.source_row_id LIMIT ?
)
SELECT v.* FROM page CROSS JOIN typed_telemetry_compatibility_records v ON v.storage_row_id = page.id
ORDER BY v.observed_at_ms, v.format_code, v.source_row_id`;

type Row = Record<string, unknown>;
const STREAMS = ["usage", "quota", "session"] as const;
const MIN_INSTANT = -8_640_000_000_000_000;
const MAX_INSTANT = 8_640_000_000_000_000;
const TEXT_FIELDS = ["source_namespace", "participant_id", "device_id", "chunk_row_id", "schema_version", "occurrence_id",
  "observed_at", "observed_day", "chunk_day", "provider", "canonical_sha256"] as const;
const NULLABLE_TEXT_FIELDS = ["manifest_id", "model_id", "session_uuid", "speed_mode", "api_service_tier", "surface",
  "billing_surface", "reasoning_effort", "agent_scope", "outcome", "plan_type", "plan_variant", "limit_id", "slot", "resets_at",
  "account_basis", "account_track_id", "plan_basis", "attribution_plan_type", "plan_era_id"] as const;
const NULLABLE_NUMBER_FIELDS = ["total_input_context_tokens", "input_uncached_tokens", "input_cache_read_tokens",
  "input_cache_write_tokens", "output_text_tokens", "output_reasoning_tokens", "output_combined_tokens", "used_percent",
  "window_duration_minutes", "resets_at_ms"] as const;
function fail(): never { throw new TypedTelemetryError("TYPED_TELEMETRY_INVALID"); }
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail();
  return value;
}
function text(row: Row, key: string): string { if (typeof row[key] !== "string") fail(); return row[key]; }
function nullableText(row: Row, key: string): string | null { return row[key] === null ? null : text(row, key); }
function number(row: Row, key: string): number {
  if (typeof row[key] !== "number" || !Number.isFinite(row[key])) fail(); return row[key];
}
function nullableNumber(row: Row, key: string): number | null { return row[key] === null ? null : number(row, key); }
function bytes(row: Row, key: string): Uint8Array {
  const value = row[key];
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return Uint8Array.from(value as number[]);
  fail();
}
function format(value: unknown): TypedTelemetryFormat { if (value !== "v1" && value !== "v11") fail(); return value; }
function verifiedId(row: Row, raw: string, decoded: string, nullable = false): Uint8Array | null {
  if (nullable && (row[raw] === null || bytes(row, raw).length === 0)) {
    if (row[decoded] !== null) fail(); return null;
  }
  const value = bytes(row, raw);
  if (decodeTypedTelemetryId(value) !== text(row, decoded)) fail();
  return value;
}

function readParameters(options: TypedTelemetryCompatibilityOptions): Array<string | number | ArrayBuffer> {
  const allowed = ["sourceNamespace", "participantId", "stream", "fromObservedAtMs", "beforeObservedAtMs", "after", "limit"];
  if (!options || typeof options !== "object" || Object.keys(options).some((key) => !allowed.includes(key))) fail();
  const stream = STREAMS.indexOf(options.stream);
  if (stream < 0) fail();
  const count = integer(options.limit ?? 100, 1, MAX_TYPED_TELEMETRY_COMPATIBILITY_PAGE);
  const from = integer(options.fromObservedAtMs ?? MIN_INSTANT, MIN_INSTANT, MAX_INSTANT);
  const before = integer(options.beforeObservedAtMs ?? MAX_INSTANT + 1, MIN_INSTANT, MAX_INSTANT + 1);
  if (before <= from) fail();
  let afterTime = MIN_INSTANT, afterFormat = 9, afterId = 0;
  if (options.after !== undefined) {
    if (!options.after || Object.keys(options.after).sort().join() !== "format,observedAtMs,sourceRowId") fail();
    afterTime = integer(options.after.observedAtMs, MIN_INSTANT, MAX_INSTANT);
    afterFormat = format(options.after.format) === "v1" ? 10 : 11;
    afterId = integer(options.after.sourceRowId, 1, Number.MAX_SAFE_INTEGER);
  }
  return [Uint8Array.from(encodeTypedTelemetryId(options.sourceNamespace)).buffer,
    Uint8Array.from(encodeTypedTelemetryId(options.participantId)).buffer, stream + 1, from, before,
    afterTime, afterFormat, afterId, count + 1];
}

/** Internal consumer read, not an HTTP authorization boundary. It preserves all
 * source versions; callers apply their own independently proven authority fence. */
export async function readTypedTelemetryCompatibilityPage(db: D1Database, options: TypedTelemetryCompatibilityOptions): Promise<{
  records: TypedTelemetryCompatibilityRecord[]; next: TypedTelemetryCompatibilityCursor | null;
}> {
  const parameters = readParameters(options);
  try {
    if (await db.prepare("SELECT version FROM typed_telemetry_schema WHERE id = 1").first<number>("version") !== 1) {
      throw new TypedTelemetryError("TYPED_TELEMETRY_UNAVAILABLE");
    }
    const page = (await db.prepare(TYPED_TELEMETRY_COMPATIBILITY_PAGE_SQL).bind(...parameters).all<Row>()).results;
    const count = options.limit ?? 100, rows = page.slice(0, count);
    const records = await decodeRows(db, rows, options);
    const last = records.at(-1);
    return { records, next: page.length > count && last ? {
      observedAtMs: last.observed_at_ms, format: last.format, sourceRowId: last.source_row_id,
    } : null };
  } catch (error) {
    if (error instanceof TypedTelemetryError) throw error;
    throw new TypedTelemetryError("TYPED_TELEMETRY_UNAVAILABLE");
  }
}
/** Shared bounded decoder. Exact source membership is checked before returning
 * any reconstructed canonical/legacy bytes. Callers supply trusted internal
 * IDs selected through their own immutable chunk/domain authority. */
async function decodeRows(db: D1Database, rows: Row[], options: {
  sourceNamespace: string; participantId: string; stream?: "usage" | "quota" | "session";
}): Promise<TypedTelemetryCompatibilityRecord[]> {
  const sessions = rows.filter((row) => row.stream === "session").map((row) => integer(row.storage_row_id, 1, Number.MAX_SAFE_INTEGER));
  const tools = new Map<number, Record<string, number>>();
  for (let offset = 0; offset < sessions.length; offset += 90) {
    const group = sessions.slice(offset, offset + 90);
    const result = await db.prepare(`SELECT storage_row_id, tool_class, count FROM typed_telemetry_compatibility_session_tools
      WHERE storage_row_id IN (${group.map(() => "?").join(",")}) ORDER BY storage_row_id, tool_class COLLATE BINARY LIMIT ?`)
      .bind(...group, group.length * 32 + 1).all<Row>();
    if (result.results.length > group.length * 32) fail();
    for (const row of result.results) {
      const key = integer(row.storage_row_id, 1, Number.MAX_SAFE_INTEGER);
      const values = tools.get(key) ?? Object.create(null) as Record<string, number>;
      const tool = text(row, "tool_class");
      if (Object.hasOwn(values, tool)) fail();
      values[tool] = integer(row.count, 0, 1_000_000_000); tools.set(key, values);
    }
  }
  const records: TypedTelemetryCompatibilityRecord[] = [];
  for (const row of rows) {
    const recordFormat = format(row.format);
    const stream = STREAMS[integer(row.stream_code, 1, 3) - 1]!;
    if (row.stream !== stream || row.source_namespace !== options.sourceNamespace || row.participant_id !== options.participantId
        || (options.stream !== undefined && stream !== options.stream) || row.format_code !== (recordFormat === "v1" ? 10 : 11)
        || row.id !== row.source_row_id || (stream === "usage") !== (row.usage_record_id !== null)
        || (stream === "quota") !== (row.quota_record_id !== null)) fail();
    for (const [raw, decoded] of [["_namespace_blob", "source_namespace"], ["_owner_blob", "participant_id"],
      ["_device_blob", "device_id"], ["_chunk_blob", "chunk_row_id"]]) verifiedId(row, raw!, decoded!);
    verifiedId(row, "_manifest_blob", "manifest_id", recordFormat === "v1");
    const fields: TypedTelemetryFields = { format: recordFormat, stream,
      occurrenceId: verifiedId(row, "_occurrence_blob", "occurrence_id")!,
      observedAtMs: integer(row.observed_at_ms, MIN_INSTANT, MAX_INSTANT), provider: text(row, "provider"),
      attribution: null, usage: null, quota: null, tools: null };
    if (new Date(fields.observedAtMs).toISOString() !== row.observed_at) fail();
    if (recordFormat === "v11" && stream !== "session") {
      if (row.attribution_id === null) fail();
      verifiedId(row, "_account_track_blob", "account_track_id", true);
      verifiedId(row, "_plan_era_blob", "plan_era_id", true);
      fields.attribution = { accountBasis: text(row, "account_basis"), accountTrackId: nullableText(row, "account_track_id"),
        planBasis: text(row, "plan_basis"), planType: text(row, "attribution_plan_type"),
        planEraId: nullableText(row, "plan_era_id") } as TelemetryV11Attribution;
    } else if (["attribution_id", "account_basis", "account_track_id", "plan_basis", "attribution_plan_type", "plan_era_id"]
      .some((key) => row[key] !== null)) fail();
    if (stream === "usage") fields.usage = {
      sessionId: verifiedId(row, "_session_blob", "session_uuid")!, modelId: text(row, "model_id"),
      speedMode: text(row, "speed_mode"), apiServiceTier: text(row, "api_service_tier"), surface: text(row, "surface"),
      billingSurface: text(row, "billing_surface"), reasoningEffort: text(row, "reasoning_effort"),
      agentScope: text(row, "agent_scope"), outcome: text(row, "outcome"),
      totalInputContextTokens: nullableNumber(row, "total_input_context_tokens"), components: {
        inputUncachedTokens: nullableNumber(row, "input_uncached_tokens"), inputCacheReadTokens: nullableNumber(row, "input_cache_read_tokens"),
        inputCacheWriteTokens: nullableNumber(row, "input_cache_write_tokens"), outputTextTokens: nullableNumber(row, "output_text_tokens"),
        outputReasoningTokens: nullableNumber(row, "output_reasoning_tokens"), outputCombinedTokens: nullableNumber(row, "output_combined_tokens"),
      },
    };
    else if (stream === "quota") {
      fields.quota = { planType: text(row, "plan_type"), planVariant: text(row, "plan_variant"), limitId: text(row, "limit_id"),
        slot: text(row, "slot"), usedPercent: nullableNumber(row, "used_percent"),
        windowDurationMinutes: nullableNumber(row, "window_duration_minutes"), resetsAtMs: nullableNumber(row, "resets_at_ms") };
      const resets = fields.quota.resetsAtMs;
      if ((resets === null ? null : new Date(resets).toISOString()) !== row.resets_at) fail();
    } else fields.tools = tools.get(number(row, "storage_row_id")) ?? {};
    const canonical = typedTelemetryCanonicalRecords(fields);
    if (await sha256Hex(canonical.canonicalRecord) !== row.canonical_sha256
        || canonical.record.schemaVersion !== row.schema_version) throw new TypedTelemetryError("TYPED_TELEMETRY_CONFLICT");
    const sourceId = integer(row.source_row_id, 1, Number.MAX_SAFE_INTEGER);
    const result = { source_row_id: sourceId, id: sourceId, format: recordFormat, stream, observed_at_ms: fields.observedAtMs,
      tool_class_counts: fields.tools, record_json: canonical.canonicalRecord,
      legacy_occurrence_id: canonical.legacy?.occurrenceId ?? null, legacy_record_json: canonical.legacy?.canonicalRecord ?? null,
      record: canonical.record,
      ...Object.fromEntries(TEXT_FIELDS.map((key) => [key, text(row, key)])),
      ...Object.fromEntries(NULLABLE_TEXT_FIELDS.map((key) => [key, nullableText(row, key)])),
      ...Object.fromEntries(NULLABLE_NUMBER_FIELDS.map((key) => [key, nullableNumber(row, key)])),
    } as TypedTelemetryCompatibilityRecord;
    records.push(result);
  }
  return records;
}

/** Resolve a bounded set of physical typed row IDs after an authority-pinned
 * index lookup. This is an internal storage primitive, never caller auth. IDs
 * are checked individually; missing or foreign rows fail the entire page. */
export async function readTypedTelemetryRowsByStorageIds(db: D1Database, options: {
  sourceNamespace: string; participantId: string; storageRowIds: readonly number[];
}): Promise<TypedTelemetryCompatibilityRecord[]> {
  const { sourceNamespace, participantId } = options;
  encodeTypedTelemetryId(sourceNamespace);
  encodeTypedTelemetryId(participantId);
  if (!Array.isArray(options.storageRowIds) || options.storageRowIds.length > MAX_TYPED_TELEMETRY_COMPATIBILITY_PAGE) fail();
  const ids = options.storageRowIds.map(value => integer(value, 1, Number.MAX_SAFE_INTEGER));
  if (new Set(ids).size !== ids.length) fail();
  if (!ids.length) return [];
  try {
    if (await db.prepare("SELECT version FROM typed_telemetry_schema WHERE id=1").first<number>("version") !== 1) {
      throw new TypedTelemetryError("TYPED_TELEMETRY_UNAVAILABLE");
    }
    const found = new Map<number, Row>();
    for (let offset = 0; offset < ids.length; offset += 90) {
      const group = ids.slice(offset, offset + 90);
      const rows = (await db.prepare(`SELECT * FROM typed_telemetry_compatibility_records
        WHERE storage_row_id IN (${group.map(() => "?").join(",")}) LIMIT ?`)
        .bind(...group, group.length + 1).all<Row>()).results;
      for (const row of rows) {
        const id = integer(row.storage_row_id, 1, Number.MAX_SAFE_INTEGER);
        if (!group.includes(id) || found.has(id)) fail();
        found.set(id, row);
      }
    }
    if (found.size !== ids.length) throw new TypedTelemetryError("TYPED_TELEMETRY_UNAVAILABLE");
    return await decodeRows(db, ids.map(id => found.get(id)!), { sourceNamespace, participantId });
  } catch (error) {
    if (error instanceof TypedTelemetryError) throw error;
    throw new TypedTelemetryError("TYPED_TELEMETRY_UNAVAILABLE");
  }
}

/** Internal usage-only analytical page. SQL has already bounded and pinned its
 * physical rows. Unlike generic/session reads, this performs no additional SQL.
 * The legacy analytical protocol is at most5000 rows; retain all identity and
 * canonical digest checks rather than reconstructing numeric JSON in SQLite. */
export const MAX_TYPED_V1_USAGE_ANALYSIS_BYTES=32*1024*1024;
export async function decodeTypedTelemetryUsageAnalysisRows(db:D1Database,rows:Record<string,unknown>[],options:{sourceNamespace:string;participantId:string;format?:'v1'|'v11'}):Promise<TypedTelemetryCompatibilityRecord[]> {
 const format=options.format??'v1';
 if(!['v1','v11'].includes(format)||!Array.isArray(rows)||rows.length>5000||rows.some(row=>row.stream!=='usage'||row.format!==format))fail();
 let bytes=0;const encoder=new TextEncoder();
 for(const row of rows)for(const value of Object.values(row)){
  bytes+=typeof value==='string'?encoder.encode(value).byteLength:value instanceof ArrayBuffer?value.byteLength:
   Array.isArray(value)?value.length:value instanceof Uint8Array?value.byteLength:8;
  if(bytes>MAX_TYPED_V1_USAGE_ANALYSIS_BYTES)throw new TypedTelemetryError('TYPED_TELEMETRY_LIMIT');
 }
 return decodeRows(db,rows,{...options,stream:'usage'});
}
