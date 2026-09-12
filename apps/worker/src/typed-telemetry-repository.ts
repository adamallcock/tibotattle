import { MAX_TYPED_STORAGE_DATA_STATEMENTS } from "./storage-routing-batch-budget";
import { canonicalTelemetryV11Json, type TelemetryV11Attribution } from "@app-usagemonitor/telemetry-contract";
import { sha256, sha256Hex } from "./crypto";
import {
  decodeTypedTelemetryId,
  encodeTypedTelemetryId,
  encodeTypedTelemetryRecord,
  typedTelemetryCanonicalRecords,
  typedTelemetryDayNumber,
  typedTelemetryDayString,
  TypedTelemetryError,
  type TypedTelemetryFields,
  type TypedTelemetryFormat,
  type TypedTelemetryRecord,
} from "./typed-telemetry-codec";

export const MAX_TYPED_TELEMETRY_BATCH_RECORDS = 200;
export const MAX_TYPED_TELEMETRY_BATCH_STATEMENTS = MAX_TYPED_STORAGE_DATA_STATEMENTS;
export const MAX_TYPED_TELEMETRY_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_BYTES = 100_000;
const ACCOUNT_BASES = ["unavailable", "same_source", "provisional_marker"] as const;
const PLAN_BASES = ["unavailable", "same_source_occurrence", "provisional_marker", "conflicted"] as const;
const STREAMS = ["usage", "quota", "session"] as const;
const encoder = new TextEncoder();

export interface TypedTelemetrySourceRecord {
  /** Immutable original database namespace; never the destination shard name. */
  sourceNamespace: string;
  format: TypedTelemetryFormat;
  sourceRowId: number;
  participantId: string;
  deviceId: string;
  chunkRowId: string;
  manifestId: string | null;
  chunkDay: string;
  /** Preserve the original source column; do not infer it from the timestamp. */
  observedDay: string;
  record: unknown;
}

export interface TypedTelemetryStoredRecord extends Omit<TypedTelemetrySourceRecord, "record"> {
  record: TypedTelemetryRecord;
  canonicalRecord: string;
  legacy: { occurrenceId: string; canonicalRecord: string } | null;
}

export interface PreparedTypedTelemetryInsert {
  statements: D1PreparedStatement[];
  recordCount: number;
  /** Exact SQL and bound-value budget used by this preparation. */
  byteLength: number;
  /** Binds original memberships and exact current canonical records, in input order. */
  batchDigest: string;
}

type Bind = string | number | null | ArrayBuffer;
interface Sql { text: string; values: Bind[] }
const literal = (text: string): Sql => ({ text, values: [] });
const parameter = (value: Bind): Sql => ({ text: "?", values: [value] });
const blob = (value: Uint8Array): ArrayBuffer => Uint8Array.from(value).buffer;
const id = (value: string): ArrayBuffer => blob(encodeTypedTelemetryId(value));
const formatCode = (value: TypedTelemetryFormat): number => value === "v1" ? 10 : value === "v11" ? 11 : fail();
function fail(): never { throw new TypedTelemetryError("TYPED_TELEMETRY_INVALID"); }
function limit(): never { throw new TypedTelemetryError("TYPED_TELEMETRY_LIMIT"); }
function conflict(): never { throw new TypedTelemetryError("TYPED_TELEMETRY_CONFLICT"); }

function join(values: Sql[], separator: string): Sql {
  return { text: values.map((value) => value.text).join(separator), values: values.flatMap((value) => value.values) };
}
function lookup(table: string, fields: Record<string, Sql>): Sql {
  const conditions = join(Object.entries(fields).map(([key, value]) => ({ text: `${key} IS ${value.text}`, values: value.values })), " AND ");
  return { text: `(SELECT id FROM ${table} WHERE ${conditions.text})`, values: conditions.values };
}
function insert(table: string, fields: Record<string, Sql>, suffix = "ON CONFLICT DO NOTHING"): Sql {
  const values = join(Object.values(fields), ", ");
  return { text: `INSERT INTO ${table} (${Object.keys(fields).join(", ")}) VALUES (${values.text}) ${suffix}`, values: values.values };
}
function dictionary(value: string): Sql { return lookup("typed_telemetry_dictionary", { value: parameter(value) }); }
function namespace(value: string): Sql { return lookup("typed_telemetry_namespaces", { original_id: parameter(id(value)) }); }
function owner(row: TypedTelemetrySourceRecord): Sql {
  return lookup("typed_telemetry_owners", { namespace_id: namespace(row.sourceNamespace), original_id: parameter(id(row.participantId)) });
}
function device(row: TypedTelemetrySourceRecord): Sql {
  return lookup("typed_telemetry_devices", { namespace_id: namespace(row.sourceNamespace), original_id: parameter(id(row.deviceId)) });
}
function manifest(row: TypedTelemetrySourceRecord): Sql {
  return row.manifestId === null ? literal("NULL") : lookup("typed_telemetry_manifests", {
    namespace_id: namespace(row.sourceNamespace), original_id: parameter(id(row.manifestId)),
  });
}
function chunk(row: TypedTelemetrySourceRecord): Sql {
  return lookup("typed_telemetry_chunks", { namespace_id: namespace(row.sourceNamespace),
    format: parameter(formatCode(row.format)), original_id: parameter(id(row.chunkRowId)) });
}
function recordId(row: TypedTelemetrySourceRecord): Sql {
  return lookup("typed_telemetry_records", { namespace_id: namespace(row.sourceNamespace),
    format: parameter(formatCode(row.format)), source_row_id: parameter(row.sourceRowId) });
}
function attributionFields(value: TelemetryV11Attribution, row: TypedTelemetrySourceRecord): Record<string, Sql> {
  return { namespace_id: namespace(row.sourceNamespace), owner_id: owner(row),
    account_basis: parameter(ACCOUNT_BASES.indexOf(value.accountBasis)),
    account_track: parameter(value.accountTrackId === null ? new ArrayBuffer(0) : id(value.accountTrackId)),
    plan_basis: parameter(PLAN_BASES.indexOf(value.planBasis)), plan_type_id: dictionary(value.planType),
    plan_era: parameter(value.planEraId === null ? new ArrayBuffer(0) : id(value.planEraId)) };
}
function attribution(value: TelemetryV11Attribution | null, row: TypedTelemetrySourceRecord): Sql {
  return value === null ? literal("NULL") : lookup("typed_telemetry_attributions", attributionFields(value, row));
}
function quotaDimensions(fields: TypedTelemetryFields, row: TypedTelemetrySourceRecord): Record<string, Sql> {
  if (!fields.quota) fail();
  return { namespace_id: namespace(row.sourceNamespace), owner_id: owner(row),
    plan_type_id: dictionary(fields.quota.planType), plan_variant_id: dictionary(fields.quota.planVariant),
    attribution_id: attribution(fields.attribution, row) };
}

function validateSource(value: TypedTelemetrySourceRecord): { row: TypedTelemetrySourceRecord; fields: TypedTelemetryFields } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  const expected = ["sourceNamespace", "format", "sourceRowId", "participantId", "deviceId", "chunkRowId",
    "manifestId", "chunkDay", "observedDay", "record"].sort();
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
      || !Number.isSafeInteger(value.sourceRowId) || value.sourceRowId < 1
      || (value.format === "v1" ? value.manifestId !== null : value.format !== "v11" || typeof value.manifestId !== "string")) fail();
  for (const identifier of [value.sourceNamespace, value.participantId, value.deviceId, value.chunkRowId]) encodeTypedTelemetryId(identifier);
  if (value.manifestId !== null) encodeTypedTelemetryId(value.manifestId);
  typedTelemetryDayNumber(value.chunkDay);
  typedTelemetryDayNumber(value.observedDay);
  const fields = encodeTypedTelemetryRecord(value.format, value.record);
  const { record, canonicalRecord } = typedTelemetryCanonicalRecords(fields);
  if (encoder.encode(canonicalRecord).byteLength > MAX_RECORD_BYTES) limit();
  return { row: { ...value, record }, fields };
}

/**
 * Prepare one bounded transaction without executing it. The caller may append
 * an ingestion-local journal statement to this SAME db.batch. No analytics,
 * network, authorization, activation or current-head transition occurs here.
 * Inputs represent already-owned source evidence, not an HTTP admission API.
 *
 * Uncertain execution is retried with the same original namespace/format/row
 * keys. Exact replays converge; changed memberships or canonical data abort.
 */
export async function prepareTypedTelemetryInsert(
  db: D1Database, input: readonly TypedTelemetrySourceRecord[],
): Promise<PreparedTypedTelemetryInsert> {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_TYPED_TELEMETRY_BATCH_RECORDS) limit();
  // Complete synchronous validation/snapshot before the first async operation.
  const prepared = input.map(validateSource);
  const sourceKeys = new Set<string>();
  for (const { row } of prepared) {
    const key = canonicalTelemetryV11Json([row.sourceNamespace, row.format, row.sourceRowId]);
    if (sourceKeys.has(key)) conflict();
    sourceKeys.add(key);
  }
  const statements: Sql[] = [];
  const unique = new Set<string>();
  const add = (statement: Sql, deduplicate = false): void => {
    if (statement.values.length > 100) limit();
    if (deduplicate) {
      const key = canonicalTelemetryV11Json([statement.text, statement.values.map((value) =>
        value instanceof ArrayBuffer ? Array.from(new Uint8Array(value)) : value)]);
      if (unique.has(key)) return;
      unique.add(key);
    }
    statements.push(statement);
    if (statements.length > MAX_TYPED_TELEMETRY_BATCH_STATEMENTS) limit();
  };
  const tokens = new Set<string>();
  for (const { fields } of prepared) {
    tokens.add(fields.provider);
    if (fields.attribution) tokens.add(fields.attribution.planType);
    if (fields.usage) {
      const u = fields.usage;
      for (const token of [u.modelId, u.speedMode, u.apiServiceTier, u.surface, u.billingSurface,
        u.reasoningEffort, u.agentScope, u.outcome]) tokens.add(token);
    }
    if (fields.quota) {
      for (const token of [fields.quota.planType, fields.quota.planVariant, fields.quota.limitId, fields.quota.slot]) tokens.add(token);
    }
    for (const tool of Object.keys(fields.tools ?? {})) tokens.add(tool);
  }
  const tokenValues = [...tokens];
  for (let offset = 0; offset < tokenValues.length; offset += 100) {
    const group = tokenValues.slice(offset, offset + 100);
    add({ text: `INSERT INTO typed_telemetry_dictionary (value) VALUES ${group.map(() => "(?)").join(", ")} ON CONFLICT DO NOTHING`, values: group });
  }
  // Parent order matters for immediate foreign keys; a mismatched existing
  // device/manifest/chunk goes through an immutable upsert and cannot be reused.
  for (const { row } of prepared) add(insert("typed_telemetry_namespaces", { original_id: parameter(id(row.sourceNamespace)) }), true);
  for (const { row } of prepared) add(insert("typed_telemetry_owners", {
    namespace_id: namespace(row.sourceNamespace), original_id: parameter(id(row.participantId)),
  }), true);
  for (const { row } of prepared) add(insert("typed_telemetry_devices", {
    namespace_id: namespace(row.sourceNamespace), owner_id: owner(row), original_id: parameter(id(row.deviceId)),
  }, "ON CONFLICT(namespace_id, original_id) DO UPDATE SET owner_id = excluded.owner_id"), true);
  for (const { row } of prepared) {
    if (row.manifestId !== null) add(insert("typed_telemetry_manifests", {
      namespace_id: namespace(row.sourceNamespace), owner_id: owner(row), device_id: device(row),
      original_id: parameter(id(row.manifestId)), chunk_day: parameter(typedTelemetryDayNumber(row.chunkDay)),
    }, "ON CONFLICT(namespace_id, original_id) DO UPDATE SET owner_id = excluded.owner_id, device_id = excluded.device_id, chunk_day = excluded.chunk_day"), true);
  }
  for (const { row, fields } of prepared) add(insert("typed_telemetry_chunks", {
    namespace_id: namespace(row.sourceNamespace), format: parameter(formatCode(row.format)), owner_id: owner(row), device_id: device(row),
    manifest_id: manifest(row), original_id: parameter(id(row.chunkRowId)), stream: parameter(STREAMS.indexOf(fields.stream) + 1),
    chunk_day: parameter(typedTelemetryDayNumber(row.chunkDay)),
  }, "ON CONFLICT(namespace_id, format, original_id) DO UPDATE SET owner_id = excluded.owner_id, device_id = excluded.device_id, manifest_id = excluded.manifest_id, stream = excluded.stream, chunk_day = excluded.chunk_day"), true);
  for (const { row, fields } of prepared) {
    if (fields.usage) add(insert("typed_telemetry_identifiers", {
      namespace_id: namespace(row.sourceNamespace), owner_id: owner(row), value: parameter(blob(fields.usage.sessionId)),
    }), true);
    if (fields.attribution) add(insert("typed_telemetry_attributions", attributionFields(fields.attribution, row)), true);
  }
  for (const { row, fields } of prepared) {
    if (fields.quota) add(insert("typed_telemetry_quota_dimensions", quotaDimensions(fields, row)), true);
  }

  for (const { row, fields } of prepared) {
    const canonical = typedTelemetryCanonicalRecords(fields).canonicalRecord;
    add(insert("typed_telemetry_records", {
      namespace_id: namespace(row.sourceNamespace), format: parameter(formatCode(row.format)), source_row_id: parameter(row.sourceRowId),
      owner_id: owner(row), device_id: device(row), chunk_id: chunk(row), manifest_id: manifest(row),
      stream: parameter(STREAMS.indexOf(fields.stream) + 1), occurrence_id: parameter(blob(fields.occurrenceId)),
      observed_at_ms: parameter(fields.observedAtMs), observed_day: parameter(typedTelemetryDayNumber(row.observedDay)),
      provider_id: dictionary(fields.provider), canonical_digest: parameter(blob(await sha256(canonical))),
    }, "ON CONFLICT(namespace_id, format, source_row_id) DO UPDATE SET owner_id = excluded.owner_id, device_id = excluded.device_id, chunk_id = excluded.chunk_id, manifest_id = excluded.manifest_id, stream = excluded.stream, occurrence_id = excluded.occurrence_id, observed_at_ms = excluded.observed_at_ms, observed_day = excluded.observed_day, provider_id = excluded.provider_id, canonical_digest = excluded.canonical_digest"));
    if (fields.usage) {
      const u = fields.usage;
      add(insert("typed_telemetry_usage", {
        record_id: recordId(row), session_id: lookup("typed_telemetry_identifiers", {
          namespace_id: namespace(row.sourceNamespace), owner_id: owner(row), value: parameter(blob(u.sessionId)),
        }),
        model_id: dictionary(u.modelId), speed_mode_id: dictionary(u.speedMode), api_service_tier_id: dictionary(u.apiServiceTier),
        surface_id: dictionary(u.surface), billing_surface_id: dictionary(u.billingSurface), reasoning_effort_id: dictionary(u.reasoningEffort),
        agent_scope_id: dictionary(u.agentScope), outcome_id: dictionary(u.outcome), attribution_id: attribution(fields.attribution, row),
        total_input_context_tokens: parameter(u.totalInputContextTokens), input_uncached_tokens: parameter(u.components.inputUncachedTokens),
        input_cache_read_tokens: parameter(u.components.inputCacheReadTokens), input_cache_write_tokens: parameter(u.components.inputCacheWriteTokens),
        output_text_tokens: parameter(u.components.outputTextTokens), output_reasoning_tokens: parameter(u.components.outputReasoningTokens),
        output_combined_tokens: parameter(u.components.outputCombinedTokens),
      }));
    } else if (fields.quota) {
      const q = fields.quota;
      add(insert("typed_telemetry_quota", { record_id: recordId(row),
        dimensions_id: lookup("typed_telemetry_quota_dimensions", quotaDimensions(fields, row)),
        limit_id: dictionary(q.limitId), slot_id: dictionary(q.slot), used_percent: parameter(q.usedPercent),
        window_duration_minutes: parameter(q.windowDurationMinutes), resets_at_ms: parameter(q.resetsAtMs) }));
    } else if (fields.tools) {
      const ref = recordId(row);
      const entries = Object.entries(fields.tools);
      add({ text: `WITH target_record AS (SELECT ${ref.text} AS id), tools(tool, count) AS (VALUES ${entries.map(() => "(?, ?)").join(", ")})
        INSERT INTO typed_telemetry_session_tools (record_id, tool_class_id, count)
        SELECT r.id, d.id, t.count FROM target_record r CROSS JOIN tools t JOIN typed_telemetry_dictionary d ON d.value = t.tool
        WHERE true ON CONFLICT DO NOTHING`, values: [...ref.values, ...entries.flatMap(([tool, count]) => [tool, count])] });
    }
  }
  const bytes = statements.reduce((total, statement) => total + encoder.encode(statement.text).byteLength
    + statement.values.reduce<number>((size, value) => size + (typeof value === "string" ? encoder.encode(value).byteLength
      : value instanceof ArrayBuffer ? value.byteLength : 8), 0), 0);
  if (bytes > MAX_TYPED_TELEMETRY_BATCH_BYTES) limit();
  const batchDigest = await sha256Hex(canonicalTelemetryV11Json({ schema: "typed-telemetry-batch-v1", records: prepared.map(({ row }) => row) }));
  return { statements: statements.map((statement) => db.prepare(statement.text).bind(...statement.values)),
    recordCount: prepared.length, byteLength: bytes, batchDigest };
}

function storageError(error: unknown): TypedTelemetryError {
  if (error instanceof TypedTelemetryError) return error;
  const message = String(error);
  if (message.includes("typed_telemetry_identity_conflict") || message.includes("typed_telemetry_membership_conflict")
      || message.includes("UNIQUE constraint failed") || message.includes("FOREIGN KEY constraint failed")) {
    return new TypedTelemetryError("TYPED_TELEMETRY_CONFLICT");
  }
  return new TypedTelemetryError("TYPED_TELEMETRY_UNAVAILABLE");
}

export async function persistTypedTelemetryBatch(
  db: D1Database, input: readonly TypedTelemetrySourceRecord[],
): Promise<{ recordCount: number; batchDigest: string }> {
  const prepared = await prepareTypedTelemetryInsert(db, input);
  try {
    const results = await db.batch(prepared.statements);
    if (results.some((result) => !result.success)) throw new TypedTelemetryError("TYPED_TELEMETRY_UNAVAILABLE");
  } catch (error) { throw storageError(error); }
  return { recordCount: prepared.recordCount, batchDigest: prepared.batchDigest };
}

type Stored = Record<string, unknown>;
function text(row: Stored, key: string): string { const value = row[key]; if (typeof value !== "string") fail(); return value; }
function number(row: Stored, key: string): number { const value = row[key]; if (typeof value !== "number" || !Number.isFinite(value)) fail(); return value; }
function nullableNumber(row: Stored, key: string): number | null { return row[key] === null ? null : number(row, key); }
function bytes(row: Stored, key: string): Uint8Array {
  const value = row[key];
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return Uint8Array.from(value as number[]);
  fail();
}
function storedAttribution(row: Stored): TelemetryV11Attribution | null {
  if (row.attribution_id === null) return null;
  const accountBasis = ACCOUNT_BASES[number(row, "account_basis")];
  const planBasis = PLAN_BASES[number(row, "plan_basis")];
  if (!accountBasis || !planBasis) fail();
  const track = bytes(row, "account_track");
  const era = bytes(row, "plan_era");
  return { accountBasis, planBasis, accountTrackId: track.length === 0 ? null : decodeTypedTelemetryId(track),
    planEraId: era.length === 0 ? null : decodeTypedTelemetryId(era),
    planType: text(row, "attribution_plan_type") as TelemetryV11Attribution["planType"] };
}

const READ_PAGE_SQL = `SELECT r.*, n.original_id AS source_namespace, o.original_id AS participant_original,
  d.original_id AS device_original, c.original_id AS chunk_original, c.chunk_day,
  m.original_id AS manifest_original, provider.value AS provider,
  u.record_id AS usage_id, sid.value AS session_original, model.value AS model, speed.value AS speed_mode,
  tier.value AS api_service_tier, surface.value AS surface, billing.value AS billing_surface,
  effort.value AS reasoning_effort, scope.value AS agent_scope, outcome.value AS outcome,
  u.total_input_context_tokens, u.input_uncached_tokens, u.input_cache_read_tokens, u.input_cache_write_tokens,
  u.output_text_tokens, u.output_reasoning_tokens, u.output_combined_tokens,
  q.record_id AS quota_id, plan.value AS plan_type, variant.value AS plan_variant,
  lim.value AS limit_value, slot.value AS slot_value, q.used_percent, q.window_duration_minutes, q.resets_at_ms,
  a.id AS attribution_id, a.account_basis, a.account_track, a.plan_basis, a.plan_era, ap.value AS attribution_plan_type
 FROM typed_telemetry_records r
 JOIN typed_telemetry_namespaces n ON n.id = r.namespace_id
 JOIN typed_telemetry_owners o ON o.id = r.owner_id
 JOIN typed_telemetry_devices d ON d.id = r.device_id
 JOIN typed_telemetry_chunks c ON c.id = r.chunk_id
 LEFT JOIN typed_telemetry_manifests m ON m.id = r.manifest_id
 JOIN typed_telemetry_dictionary provider ON provider.id = r.provider_id
 LEFT JOIN typed_telemetry_usage u ON u.record_id = r.id
 LEFT JOIN typed_telemetry_identifiers sid ON sid.id = u.session_id
 LEFT JOIN typed_telemetry_dictionary model ON model.id = u.model_id
 LEFT JOIN typed_telemetry_dictionary speed ON speed.id = u.speed_mode_id
 LEFT JOIN typed_telemetry_dictionary tier ON tier.id = u.api_service_tier_id
 LEFT JOIN typed_telemetry_dictionary surface ON surface.id = u.surface_id
 LEFT JOIN typed_telemetry_dictionary billing ON billing.id = u.billing_surface_id
 LEFT JOIN typed_telemetry_dictionary effort ON effort.id = u.reasoning_effort_id
 LEFT JOIN typed_telemetry_dictionary scope ON scope.id = u.agent_scope_id
 LEFT JOIN typed_telemetry_dictionary outcome ON outcome.id = u.outcome_id
 LEFT JOIN typed_telemetry_quota q ON q.record_id = r.id
 LEFT JOIN typed_telemetry_quota_dimensions qd ON qd.id = q.dimensions_id
 LEFT JOIN typed_telemetry_dictionary plan ON plan.id = qd.plan_type_id
 LEFT JOIN typed_telemetry_dictionary variant ON variant.id = qd.plan_variant_id
 LEFT JOIN typed_telemetry_dictionary lim ON lim.id = q.limit_id
 LEFT JOIN typed_telemetry_dictionary slot ON slot.id = q.slot_id
 LEFT JOIN typed_telemetry_attributions a ON a.id = coalesce(u.attribution_id, qd.attribution_id)
 LEFT JOIN typed_telemetry_dictionary ap ON ap.id = a.plan_type_id
 WHERE r.namespace_id = (SELECT id FROM typed_telemetry_namespaces WHERE original_id = ?)
   AND r.format = ? AND r.source_row_id > ? ORDER BY r.source_row_id LIMIT ?`;

/** Internal migration/consumer read, not an unscoped public data endpoint. */
export async function readTypedTelemetryPage(db: D1Database, options: {
  sourceNamespace: string; format: TypedTelemetryFormat; afterSourceRowId?: number; limit?: number;
}): Promise<{ records: TypedTelemetryStoredRecord[]; nextAfterSourceRowId: number | null }> {
  const count = options.limit ?? 100;
  const after = options.afterSourceRowId ?? 0;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_TYPED_TELEMETRY_BATCH_RECORDS
      || !Number.isSafeInteger(after) || after < 0) limit();
  const namespaceBytes = id(options.sourceNamespace);
  const format = formatCode(options.format);
  try {
    const version = await db.prepare("SELECT version FROM typed_telemetry_schema WHERE id = 1").first<number>("version");
    if (version !== 1) throw new TypedTelemetryError("TYPED_TELEMETRY_UNAVAILABLE");
    const page = await db.prepare(READ_PAGE_SQL).bind(namespaceBytes, format, after, count + 1).all<Stored>();
    const rows = page.results.slice(0, count);
    const tools = new Map<number, [string, number][]>();
    const sessions = rows.filter((row) => row.stream === 3).map((row) => number(row, "id"));
    for (let offset = 0; offset < sessions.length; offset += 90) {
      const group = sessions.slice(offset, offset + 90);
      const entries = await db.prepare(`SELECT t.record_id, d.value, t.count FROM typed_telemetry_session_tools t
        JOIN typed_telemetry_dictionary d ON d.id = t.tool_class_id WHERE t.record_id IN (${group.map(() => "?").join(", ")})
        ORDER BY t.record_id, d.value LIMIT ?`).bind(...group, group.length * 32 + 1).all<Stored>();
      if (entries.results.length > group.length * 32) fail();
      for (const entry of entries.results) {
        const key = number(entry, "record_id");
        const values = tools.get(key) ?? [];
        values.push([text(entry, "value"), number(entry, "count")]); tools.set(key, values);
      }
    }
    const records: TypedTelemetryStoredRecord[] = [];
    for (const row of rows) {
      const stream = STREAMS[number(row, "stream") - 1];
      if (!stream) fail();
      if ((stream === "usage") !== (row.usage_id !== null) || (stream === "quota") !== (row.quota_id !== null)) fail();
      const fields: TypedTelemetryFields = { format: options.format, stream,
        occurrenceId: bytes(row, "occurrence_id"), observedAtMs: number(row, "observed_at_ms"), provider: text(row, "provider"),
        attribution: storedAttribution(row), usage: null, quota: null, tools: null };
      if (stream === "usage") fields.usage = {
        sessionId: bytes(row, "session_original"), modelId: text(row, "model"), speedMode: text(row, "speed_mode"),
        apiServiceTier: text(row, "api_service_tier"), surface: text(row, "surface"), billingSurface: text(row, "billing_surface"),
        reasoningEffort: text(row, "reasoning_effort"), agentScope: text(row, "agent_scope"), outcome: text(row, "outcome"),
        totalInputContextTokens: nullableNumber(row, "total_input_context_tokens"), components: {
          inputUncachedTokens: nullableNumber(row, "input_uncached_tokens"), inputCacheReadTokens: nullableNumber(row, "input_cache_read_tokens"),
          inputCacheWriteTokens: nullableNumber(row, "input_cache_write_tokens"), outputTextTokens: nullableNumber(row, "output_text_tokens"),
          outputReasoningTokens: nullableNumber(row, "output_reasoning_tokens"), outputCombinedTokens: nullableNumber(row, "output_combined_tokens"),
        },
      };
      else if (stream === "quota") fields.quota = {
        planType: text(row, "plan_type"), planVariant: text(row, "plan_variant"), limitId: text(row, "limit_value"), slot: text(row, "slot_value"),
        usedPercent: nullableNumber(row, "used_percent"), windowDurationMinutes: nullableNumber(row, "window_duration_minutes"),
        resetsAtMs: nullableNumber(row, "resets_at_ms"),
      };
      else fields.tools = Object.fromEntries(tools.get(number(row, "id")) ?? []);
      const canonical = typedTelemetryCanonicalRecords(fields);
      const expected = bytes(row, "canonical_digest");
      const actual = await sha256(canonical.canonicalRecord);
      if (expected.length !== actual.length || expected.some((byte, index) => byte !== actual[index])) conflict();
      const result: TypedTelemetryStoredRecord = {
        sourceNamespace: decodeTypedTelemetryId(bytes(row, "source_namespace")), format: options.format,
        sourceRowId: number(row, "source_row_id"), participantId: decodeTypedTelemetryId(bytes(row, "participant_original")),
        deviceId: decodeTypedTelemetryId(bytes(row, "device_original")), chunkRowId: decodeTypedTelemetryId(bytes(row, "chunk_original")),
        manifestId: row.manifest_original === null ? null : decodeTypedTelemetryId(bytes(row, "manifest_original")),
        chunkDay: typedTelemetryDayString(number(row, "chunk_day")), observedDay: typedTelemetryDayString(number(row, "observed_day")), ...canonical,
      };
      const { canonicalRecord: _canonical, legacy: _legacy, ...source } = result;
      validateSource(source);
      records.push(result);
    }
    return { records, nextAfterSourceRowId: page.results.length > count ? records.at(-1)!.sourceRowId : null };
  } catch (error) { throw storageError(error); }
}
