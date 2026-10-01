/**
 * PostgreSQL ports of the d43c8f92 Worker's legacy contribution envelopes:
 * telemetry-envelope-v1.0 (handleTelemetryV1Contribution in src/index.ts
 * with the typed storage mode: typed-v1-admission.ts
 * insertTypedTelemetryV1Chunk, telemetry-v1-repository.ts
 * prepareTelemetryV1ChunkWrite and the D1 typed-v1-admission 0001 /
 * ingestion-isolation 0004 triggers) and, further below,
 * telemetry-envelope-v0.1 (handleTelemetryContribution).
 *
 * It runs only after the origin's shared contributions preamble
 * (contribution-envelope-registry.mjs): bearer authentication, the
 * upload-authorization claim, the deletion-tombstone check and the transport
 * floor. Nothing here repeats them. The upload-authorization receipt that the
 * Worker records after every handler is exported as
 * recordPostgresDeviceUploadReceipt for that preamble.
 *
 * Storage is the typed v1 family only, exactly as production's
 * TELEMETRY_STORAGE_MODE=typed deployment: the chunk header goes to
 * telemetry_v1_chunks, every record to typed_telemetry_* (never
 * telemetry_v1_records), and one typed_v1_event_sources receipt plus one
 * exact journal row (storage_journal_append) publishes the chunk.
 *
 * Deliberate v1.0 differences, each a refusal rather than an invented
 * behaviour:
 *   - A correction (chunkRevision = current + 1) supersedes the current
 *     chunk and deletes its typed rows exactly as D1 does, through the
 *     staged legacy_contribution_admission migration's retention
 *     allowance. A usage correction while the imported usage-correction
 *     runtime was active (0034 source_state) is refused with 503
 *     BACKEND_STORAGE_UNAVAILABLE: D1 then also records usage-correction
 *     facts, whose writer is not ported (0034 keeps the PostgreSQL runtime
 *     staged).
 *   - D1's database-size admission probe (typed-storage-capacity.ts) has no
 *     PostgreSQL meaning and is not run.
 *   - D1's JSON-era analytics side effects that 0057 retired on PostgreSQL
 *     are not reproduced; the retained mutation-epoch triggers still run.
 *
 * Every refusal is an ApiError with the Worker's status and code. Provider
 * text, SQL, ids and payload values never leave this module.
 */
import type { TelemetryV11UsageEvent } from "@app-usagemonitor/telemetry-contract";
import { canonicalJson } from "./canonical-json";
import {
  ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION,
  MAX_TELEMETRY_CONTRIBUTIONS_PER_ADMISSION_WINDOW,
  TELEMETRY_CONSENT_VERSION,
  TELEMETRY_CONTRIBUTION_ADMISSION_WINDOW_MILLISECONDS,
} from "./constants";
import { decryptSyntheticEnvelope, sha256, sha256Hex } from "./crypto";
import { ApiError, jsonResponse } from "./errors";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaConfig,
  type PostgresSchemaOptions,
} from "./postgres-client";
import { assertPostgresTelemetryTransportWriteAllowed } from "./postgres-transport-write-authority";
import { verifyPostgresTypedIdentityHeadroom } from "./postgres-typed-live-allocators";
import { priceTelemetryUsageEvent, type ServerPricingResult } from "./server-pricing";
import {
  telemetryContributionAdmissionWindow,
  telemetryEnvelopeDigest,
  type TelemetryContributionAdmission,
} from "./telemetry-repository";
import {
  validateTelemetryContribution,
  validateTelemetryEnvelope,
  type TelemetryContribution,
} from "./telemetry-validation";
import {
  assertTelemetryV1ConsentCurrent,
  MAX_TELEMETRY_V1_CHUNK_CANONICAL_BYTES,
  parseTelemetryV1Chunk,
  TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V1_ENVELOPE_SCHEMA_VERSION,
  TELEMETRY_V1_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V1_PRIVACY_CONTRACT_VERSION,
  validateTelemetryV1Envelope,
  type TelemetryV1Chunk,
  type TelemetryV1Stream,
} from "./telemetry-v1";
import {
  TELEMETRY_V1_LAUNCH_WEEK_CHUNKS_PER_DAY,
  TELEMETRY_V1_LAUNCH_WEEK_MILLISECONDS,
  TELEMETRY_V1_STEADY_STATE_CHUNKS_PER_DAY,
  telemetryV1ChunkAdmissionError,
  type TelemetryV1ChunkAdmission,
  type TelemetryV1ChunkRow,
} from "./telemetry-v1-repository";
import {
  decodeTypedTelemetryId,
  encodeTypedTelemetryId,
  encodeTypedTelemetryRecord,
  typedTelemetryCanonicalRecords,
  typedTelemetryDayNumber,
  type TypedTelemetryFields,
} from "./typed-telemetry-codec";

/** typed_telemetry_* format code of v1.0 rows (D1 formatCode('v1')). */
export const POSTGRES_TYPED_V1_FORMAT = 10;
export const POSTGRES_TELEMETRY_V1_PENDING_OBJECT_KIND = "telemetry_v1";

const STREAMS = ["usage", "quota", "session"] as const;
const MAX_RECORD_BYTES = 100_000;
const DIGEST = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();

/** The slice of a GCS/R2 object store the v1.0 path writes and retires. */
export interface PostgresTelemetryV1ObjectStore {
  put(
    key: string,
    value: string | Uint8Array,
    options: {
      contentType: string;
      customMetadata: Readonly<Record<string, string>>;
    },
  ): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

export interface PostgresTelemetryV1Principal {
  readonly participantId: string;
  readonly deviceId: string;
}

export interface PostgresTelemetryV1ContributionInput {
  readonly pool: PostgresPool;
  readonly schema?: PostgresSchemaOptions;
  readonly objectStore: PostgresTelemetryV1ObjectStore;
  readonly envelopePublicJwk: string;
  readonly envelopePrivateJwk: string;
  /** Production's TELEMETRY_STORAGE_NAMESPACE; must equal the pinned state. */
  readonly sourceNamespace: string;
  /** The exact HTTP body the upload authorization was claimed for. */
  readonly body: Readonly<{ raw: string; value: unknown }>;
  readonly participant: Readonly<{ id: string; consentVersion: string | null }>;
  /** issued_by_device_id of the claimed upload authorization. */
  readonly deviceId: string;
  readonly authorization: Readonly<{ authorizationId: string; authorizationKind: string }>;
  /** Test clock; defaults to Date.now(). */
  readonly nowEpoch?: number;
}

interface AdmissionState {
  readonly namespaceId: string;
  readonly nextSourceRowId: number;
}

interface ChunkRowRecord {
  id: string;
  participant_id: string;
  device_id: string;
  stream: string;
  chunk_day: string;
  chunk_seq: number;
  revision: number;
  chunk_digest: string;
  envelope_digest: string;
  parser_version: string;
  record_count: number;
  accepted_record_count: number;
  r2_key: string;
  device_upload_authorization_id: string;
  superseded_at: string | null;
  quarantine_deleted_at: string | null;
  created_at: string;
}

function unavailable(): ApiError {
  return new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function uploadUnavailable(): ApiError {
  return new ApiError(401, "UPLOAD_AUTH_INVALID");
}

function schemaName(options: PostgresSchemaOptions | undefined): string {
  return quotePostgresIdentifier(createPostgresSchemaConfig(options ?? {}).primarySchema);
}

function table(schema: string, name: string): string {
  return `${schema}.${quotePostgresIdentifier(name)}`;
}

function safeInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^-?[0-9]+$/u.test(value)
    ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw unavailable();
  return parsed;
}

function nullableInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : safeInteger(value, Number.MIN_SAFE_INTEGER);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw unavailable();
  return parsed;
}

function bytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw unavailable();
  return Uint8Array.from(value);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function randomHex(byteLength: number): string {
  const value = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requestEpoch(value: unknown): number {
  const epoch = value === undefined ? Date.now() : value;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0
      || !Number.isFinite(new Date(epoch).getTime())) {
    throw new TypeError("invalid PostgreSQL v1.0 admission time");
  }
  return epoch;
}

/** ApiErrors are the only errors a transaction may surface unchanged. */
function preserveSafeError(error: unknown): Error | null {
  if (error instanceof ApiError) return error;
  if (error !== null && typeof error === "object") {
    const state = Reflect.get(error, "code");
    const constraint = Reflect.get(error, "constraint");
    // D1 maps a typed device/stream/occurrence uniqueness failure to this
    // code (typed-v1-admission.ts: 'typed_telemetry_records.device_id').
    if (state === "23505" && constraint === "typed_telemetry_v1_occurrence") {
      return new ApiError(409, "RECORD_OWNED_BY_OTHER_CHUNK");
    }
    // Any other trigger abort, including the insert-time transport floor
    // (reject_v1_transport_floor, P1007), stays a storage failure: D1's
    // persistTelemetryV1StorageChunk maps an unmapped abort to 503.
  }
  return null;
}

const CHUNK_COLUMNS = `id, participant_id, device_id, stream, chunk_day::text AS chunk_day, chunk_seq, revision,
  chunk_digest, envelope_digest, parser_version, record_count, accepted_record_count, r2_key,
  device_upload_authorization_id,
  to_char(superseded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS superseded_at,
  to_char(quarantine_deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS quarantine_deleted_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at`;

function chunkRow(row: ChunkRowRecord | undefined): TelemetryV1ChunkRow | null {
  if (!row) return null;
  if (!STREAMS.includes(row.stream as TelemetryV1Stream)) throw unavailable();
  return Object.freeze({
    id: row.id,
    participant_id: row.participant_id,
    device_id: row.device_id,
    stream: row.stream as TelemetryV1Stream,
    chunk_day: row.chunk_day,
    chunk_seq: safeInteger(row.chunk_seq),
    revision: safeInteger(row.revision, 1),
    chunk_digest: row.chunk_digest,
    envelope_digest: row.envelope_digest,
    parser_version: row.parser_version,
    record_count: safeInteger(row.record_count, 1, 200),
    accepted_record_count: safeInteger(row.accepted_record_count, 0, 200),
    r2_key: row.r2_key,
    device_upload_authorization_id: row.device_upload_authorization_id,
    superseded_at: row.superseded_at,
    quarantine_deleted_at: row.quarantine_deleted_at,
    created_at: row.created_at,
  });
}

async function chunkByEnvelopeDigest(
  client: PostgresClient, schema: string, participantId: string, envelopeDigest: string,
): Promise<TelemetryV1ChunkRow | null> {
  const result = await client.query<ChunkRowRecord>(
    `SELECT ${CHUNK_COLUMNS} FROM ${table(schema, "telemetry_v1_chunks")}
      WHERE participant_id = $1 AND envelope_digest = $2`,
    [participantId, envelopeDigest],
  );
  return chunkRow(result.rows[0]);
}

async function currentChunk(
  client: PostgresClient, schema: string, principal: PostgresTelemetryV1Principal,
  chunk: Pick<TelemetryV1Chunk, "stream" | "chunkDay" | "chunkSeq">, lock = false,
): Promise<TelemetryV1ChunkRow | null> {
  const result = await client.query<ChunkRowRecord>(
    `SELECT ${CHUNK_COLUMNS} FROM ${table(schema, "telemetry_v1_chunks")}
      WHERE participant_id = $1 AND device_id = $2 AND stream = $3
        AND chunk_day = $4::date AND chunk_seq = $5 AND superseded_at IS NULL
      ${lock ? "FOR UPDATE" : ""}`,
    [principal.participantId, principal.deviceId, chunk.stream, chunk.chunkDay, chunk.chunkSeq],
  );
  return chunkRow(result.rows[0]);
}

/**
 * The typed v1 pin (D1 resolveTelemetryStorageMode(..., 'v1')): the
 * singleton state names the configured namespace, carries runtime contract
 * version 1, and its namespace row stores exactly that original id.
 */
async function readAdmissionState(
  client: PostgresClient, schema: string, sourceNamespace: string, lock: boolean,
): Promise<AdmissionState> {
  const result = await client.query<{
    source_namespace: string; namespace_id: string; runtime_contract_version: number;
    next_source_row_id: string; original_id: Uint8Array;
  }>(
    `SELECT state.source_namespace, state.namespace_id::text AS namespace_id,
            state.runtime_contract_version, state.next_source_row_id::text AS next_source_row_id,
            namespace.original_id
       FROM ${table(schema, "typed_v1_admission_state")} state
       JOIN ${table(schema, "typed_telemetry_namespaces")} namespace ON namespace.id = state.namespace_id
      WHERE state.id = 1
      ${lock ? "FOR UPDATE OF state" : ""}`,
  );
  const row = result.rows[0];
  if (!row || row.runtime_contract_version !== 1 || row.source_namespace !== sourceNamespace
      || !sameBytes(bytes(row.original_id), encodeTypedTelemetryId(sourceNamespace))) {
    throw unavailable();
  }
  return Object.freeze({
    namespaceId: String(safeInteger(row.namespace_id, 1)),
    nextSourceRowId: safeInteger(row.next_source_row_id, 1),
  });
}

/**
 * True when the imported D1 usage-correction runtime was active
 * (telemetry_usage_correction_runtime.source_state, primary 0034). D1 then
 * captures usage-correction facts on a usage correction; with the table
 * absent or staged it captures none, which is the only case ported.
 */
async function usageCorrectionRuntimeActive(client: PostgresClient, schema: string): Promise<boolean> {
  const result = await client.query<{ source_state: string }>(
    `SELECT source_state FROM ${table(schema, "telemetry_usage_correction_runtime")} WHERE id = 1`,
  );
  const state = result.rows[0]?.source_state;
  if (state !== undefined && state !== "staged" && state !== "active") throw unavailable();
  return state === "active";
}

/** Port of telemetryV1DeviceConsentCurrent. */
async function deviceConsentCurrent(
  client: PostgresClient, schema: string, principal: PostgresTelemetryV1Principal, lock = false,
): Promise<boolean> {
  const result = await client.query<{
    telemetry_schema_version: string; field_dictionary_version: string; privacy_contract_version: string;
  }>(
    `SELECT telemetry_schema_version, field_dictionary_version, privacy_contract_version
       FROM ${table(schema, "telemetry_v1_device_consents")}
      WHERE participant_id = $1 AND device_id = $2
      ${lock ? "FOR SHARE" : ""}`,
    [principal.participantId, principal.deviceId],
  );
  const row = result.rows[0];
  return row !== undefined
    && row.telemetry_schema_version === TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION
    && row.field_dictionary_version === TELEMETRY_V1_FIELD_DICTIONARY_VERSION
    && row.privacy_contract_version === TELEMETRY_V1_PRIVACY_CONTRACT_VERSION;
}

function nextUtcMidnight(nowEpoch: number): string {
  const next = new Date(nowEpoch);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

/** Port of telemetryV1ChunkAdmission (telemetry-v1-repository.ts). */
async function chunkAdmission(
  client: PostgresClient, schema: string, principal: PostgresTelemetryV1Principal, nowEpoch: number,
): Promise<TelemetryV1ChunkAdmission> {
  const windowDay = new Date(nowEpoch).toISOString().slice(0, 10);
  const result = await client.query<{ accepted_count: number | null; device_issued_at: string }>(
    `SELECT windows.accepted_count,
            to_char(device.issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS device_issued_at
       FROM ${table(schema, "device_credentials")} device
       LEFT JOIN ${table(schema, "telemetry_v1_chunk_admission_windows")} windows
         ON windows.participant_id = $1 AND windows.device_id = device.id AND windows.window_day = $2::date
      WHERE device.id = $3 AND device.participant_id = $1`,
    [principal.participantId, windowDay, principal.deviceId],
  );
  const row = result.rows[0];
  if (!row) throw uploadUnavailable();
  const issuedEpoch = Date.parse(row.device_issued_at);
  const launchWeek = Number.isFinite(issuedEpoch)
    && nowEpoch - issuedEpoch < TELEMETRY_V1_LAUNCH_WEEK_MILLISECONDS;
  const maximumChunks = launchWeek
    ? TELEMETRY_V1_LAUNCH_WEEK_CHUNKS_PER_DAY
    : TELEMETRY_V1_STEADY_STATE_CHUNKS_PER_DAY;
  const acceptedChunks = Math.max(0, Math.min(TELEMETRY_V1_LAUNCH_WEEK_CHUNKS_PER_DAY,
    Number(row.accepted_count ?? 0)));
  const remainingChunks = Math.max(0, maximumChunks - acceptedChunks);
  return {
    schemaVersion: "telemetry-chunk-admission-v1.0",
    state: remainingChunks > 0 ? "available" : "exhausted",
    windowDay,
    budget: launchWeek ? "launch_week" : "steady_state",
    acceptedChunks,
    remainingChunks,
    maximumChunks,
    retryAt: nextUtcMidnight(nowEpoch),
  };
}

async function acknowledgedThroughDay(
  client: PostgresClient, schema: string, principal: PostgresTelemetryV1Principal,
): Promise<string | null> {
  const result = await client.query<{ through_day: string | null }>(
    `SELECT max(chunk_day)::text AS through_day FROM ${table(schema, "telemetry_v1_chunks")}
      WHERE participant_id = $1 AND device_id = $2 AND superseded_at IS NULL`,
    [principal.participantId, principal.deviceId],
  );
  return result.rows[0]?.through_day ?? null;
}

interface TypedReadbackRow {
  source_row_id: string;
  stream: number;
  occurrence_id: Uint8Array;
  observed_at_ms: string;
  provider: string;
  device_original: Uint8Array;
  chunk_original: Uint8Array;
  session_value: Uint8Array | null;
  model_id: string | null;
  speed_mode: string | null;
  api_service_tier: string | null;
  surface: string | null;
  billing_surface: string | null;
  reasoning_effort: string | null;
  agent_scope: string | null;
  outcome: string | null;
  total_input_context_tokens: string | null;
  input_uncached_tokens: string | null;
  input_cache_read_tokens: string | null;
  input_cache_write_tokens: string | null;
  output_text_tokens: string | null;
  output_reasoning_tokens: string | null;
  output_combined_tokens: string | null;
  plan_type: string | null;
  plan_variant: string | null;
  limit_id: string | null;
  slot: string | null;
  used_percent: number | null;
  window_duration_minutes: number | null;
  resets_at_ms: string | null;
  tools: Record<string, string | number> | null;
  canonical_digest: Uint8Array;
}

/**
 * Rebuild a chunk's admitted records from the typed family in source-row
 * order and return the canonical records. Port of the D1 compatibility
 * decoder (typed-telemetry-compatibility.ts decodeRows) for format 10.
 */
async function readAdmittedRecords(
  client: PostgresClient, schema: string, chunkRowId: string, deviceId: string,
): Promise<unknown[]> {
  const dictionary = table(schema, "typed_telemetry_dictionary");
  const result = await client.query<TypedReadbackRow>(
    `SELECT record.source_row_id::text AS source_row_id, record.stream, record.occurrence_id,
            record.observed_at_ms::text AS observed_at_ms, provider.value AS provider,
            device.original_id AS device_original, chunk.original_id AS chunk_original,
            identifier.value AS session_value, model.value AS model_id, speed.value AS speed_mode,
            tier.value AS api_service_tier, surface.value AS surface, billing.value AS billing_surface,
            effort.value AS reasoning_effort, scope.value AS agent_scope, outcome.value AS outcome,
            usage.total_input_context_tokens::text AS total_input_context_tokens,
            usage.input_uncached_tokens::text AS input_uncached_tokens,
            usage.input_cache_read_tokens::text AS input_cache_read_tokens,
            usage.input_cache_write_tokens::text AS input_cache_write_tokens,
            usage.output_text_tokens::text AS output_text_tokens,
            usage.output_reasoning_tokens::text AS output_reasoning_tokens,
            usage.output_combined_tokens::text AS output_combined_tokens,
            plan_type.value AS plan_type, plan_variant.value AS plan_variant,
            quota_limit.value AS limit_id, quota_slot.value AS slot, quota.used_percent,
            quota.window_duration_minutes, quota.resets_at_ms::text AS resets_at_ms,
            (SELECT jsonb_object_agg(tool.value, session_tool.count)
               FROM ${table(schema, "typed_telemetry_session_tools")} session_tool
               JOIN ${dictionary} tool ON tool.id = session_tool.tool_class_id
              WHERE session_tool.record_id = record.id) AS tools,
            record.canonical_digest
       FROM ${table(schema, "typed_v1_record_admissions")} admission
       JOIN ${table(schema, "typed_telemetry_records")} record ON record.id = admission.typed_record_id
       JOIN ${table(schema, "typed_telemetry_devices")} device ON device.id = record.device_id
       JOIN ${table(schema, "typed_telemetry_chunks")} chunk ON chunk.id = record.chunk_id
       JOIN ${dictionary} provider ON provider.id = record.provider_id
       LEFT JOIN ${table(schema, "typed_telemetry_usage")} usage ON usage.record_id = record.id
       LEFT JOIN ${table(schema, "typed_telemetry_identifiers")} identifier ON identifier.id = usage.session_id
       LEFT JOIN ${dictionary} model ON model.id = usage.model_id
       LEFT JOIN ${dictionary} speed ON speed.id = usage.speed_mode_id
       LEFT JOIN ${dictionary} tier ON tier.id = usage.api_service_tier_id
       LEFT JOIN ${dictionary} surface ON surface.id = usage.surface_id
       LEFT JOIN ${dictionary} billing ON billing.id = usage.billing_surface_id
       LEFT JOIN ${dictionary} effort ON effort.id = usage.reasoning_effort_id
       LEFT JOIN ${dictionary} scope ON scope.id = usage.agent_scope_id
       LEFT JOIN ${dictionary} outcome ON outcome.id = usage.outcome_id
       LEFT JOIN ${table(schema, "typed_telemetry_quota")} quota ON quota.record_id = record.id
       LEFT JOIN ${table(schema, "typed_telemetry_quota_dimensions")} dimensions ON dimensions.id = quota.dimensions_id
       LEFT JOIN ${dictionary} plan_type ON plan_type.id = dimensions.plan_type_id
       LEFT JOIN ${dictionary} plan_variant ON plan_variant.id = dimensions.plan_variant_id
       LEFT JOIN ${dictionary} quota_limit ON quota_limit.id = quota.limit_id
       LEFT JOIN ${dictionary} quota_slot ON quota_slot.id = quota.slot_id
      WHERE admission.chunk_id = $1 AND record.format = ${POSTGRES_TYPED_V1_FORMAT}
      ORDER BY record.source_row_id
      LIMIT 201`,
    [chunkRowId],
  );
  const records: unknown[] = [];
  for (const row of result.rows) {
    const stream = STREAMS[safeInteger(row.stream, 1, 3) - 1]!;
    if (decodeTypedTelemetryId(bytes(row.device_original)) !== deviceId
        || decodeTypedTelemetryId(bytes(row.chunk_original)) !== chunkRowId) {
      throw unavailable();
    }
    const fields: TypedTelemetryFields = {
      format: "v1", stream, occurrenceId: bytes(row.occurrence_id),
      observedAtMs: safeInteger(row.observed_at_ms, -8_640_000_000_000_000), provider: row.provider,
      attribution: null, usage: null, quota: null, tools: null,
    };
    if (stream === "usage") {
      if (row.session_value === null || row.model_id === null || row.speed_mode === null
          || row.api_service_tier === null || row.surface === null || row.billing_surface === null
          || row.reasoning_effort === null || row.agent_scope === null || row.outcome === null) {
        throw unavailable();
      }
      fields.usage = {
        sessionId: bytes(row.session_value), modelId: row.model_id, speedMode: row.speed_mode,
        apiServiceTier: row.api_service_tier, surface: row.surface, billingSurface: row.billing_surface,
        reasoningEffort: row.reasoning_effort, agentScope: row.agent_scope, outcome: row.outcome,
        totalInputContextTokens: nullableInteger(row.total_input_context_tokens),
        components: {
          inputUncachedTokens: nullableInteger(row.input_uncached_tokens),
          inputCacheReadTokens: nullableInteger(row.input_cache_read_tokens),
          inputCacheWriteTokens: nullableInteger(row.input_cache_write_tokens),
          outputTextTokens: nullableInteger(row.output_text_tokens),
          outputReasoningTokens: nullableInteger(row.output_reasoning_tokens),
          outputCombinedTokens: nullableInteger(row.output_combined_tokens),
        } as TelemetryV11UsageEvent["components"],
      };
    } else if (stream === "quota") {
      if (row.plan_type === null || row.plan_variant === null || row.limit_id === null || row.slot === null) {
        throw unavailable();
      }
      fields.quota = {
        planType: row.plan_type, planVariant: row.plan_variant, limitId: row.limit_id, slot: row.slot,
        usedPercent: nullableNumber(row.used_percent),
        windowDurationMinutes: nullableInteger(row.window_duration_minutes),
        resetsAtMs: nullableInteger(row.resets_at_ms),
      };
    } else {
      const tools: Record<string, number> = Object.create(null);
      for (const [tool, count] of Object.entries(row.tools ?? {})) tools[tool] = safeInteger(count, 0, 1_000_000_000);
      fields.tools = tools;
    }
    const canonical = typedTelemetryCanonicalRecords(fields);
    if (!sameBytes(await sha256(canonical.canonicalRecord), bytes(row.canonical_digest))) throw unavailable();
    records.push(JSON.parse(canonical.canonicalRecord));
  }
  return records;
}

/**
 * Port of validateTypedTelemetryV1Receipt: a committed receipt is answered
 * only when its journal event and complete typed record set prove it. A
 * superseded receipt needs a newer published revision of the same slot.
 */
async function validateReceipt(
  client: PostgresClient, schema: string, row: TelemetryV1ChunkRow, deviceId: string,
  sourceNamespace: string,
): Promise<TelemetryV1ChunkRow> {
  if (row.device_id !== deviceId || row.record_count < 1 || row.record_count > 200
      || row.accepted_record_count !== row.record_count) {
    throw unavailable();
  }
  const event = await client.query<{ sequence: string }>(
    `SELECT change.sequence::text AS sequence
       FROM ${table(schema, "typed_v1_event_sources")} source
       JOIN ${table(schema, "storage_source_state")} state ON state.singleton = 1
       JOIN ${table(schema, "storage_ingestion_changes")} change
         ON change.source_id = state.source_id AND change.event_digest = source.event_digest
        AND change.owner_digest = source.owner_digest AND change.content_digest = $3
      WHERE source.chunk_id = $1 AND source.participant_id = $2 AND source.source_namespace = $4`,
    [row.id, row.participant_id, row.chunk_digest, sourceNamespace],
  );
  if (event.rows.length !== 1) throw unavailable();
  if (row.superseded_at !== null) {
    const newer = await client.query<{ found: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM ${table(schema, "telemetry_v1_chunks")} chunk
           JOIN ${table(schema, "typed_v1_event_sources")} source ON source.chunk_id = chunk.id
           JOIN ${table(schema, "storage_source_state")} state ON state.singleton = 1
           JOIN ${table(schema, "storage_ingestion_changes")} change
             ON change.source_id = state.source_id AND change.event_digest = source.event_digest
            AND change.owner_digest = source.owner_digest
          WHERE chunk.participant_id = $1 AND chunk.device_id = $2 AND chunk.stream = $3
            AND chunk.chunk_day = $4::date AND chunk.chunk_seq = $5 AND chunk.revision > $6
            AND chunk.superseded_at IS NULL AND source.source_namespace = $7
            AND change.sequence > $8::bigint) AS found`,
      [row.participant_id, row.device_id, row.stream, row.chunk_day, row.chunk_seq, row.revision,
        sourceNamespace, event.rows[0]!.sequence],
    );
    if (newer.rows[0]?.found !== true) throw unavailable();
    return row;
  }
  const records = await readAdmittedRecords(client, schema, row.id, deviceId);
  if (records.length !== row.record_count || await sha256Hex(canonicalJson(records)) !== row.chunk_digest) {
    throw unavailable();
  }
  return row;
}

/** Port of telemetryV1ChunkReceipt (src/index.ts at d43c8f92). */
async function replayReceipt(
  client: PostgresClient, schema: string, row: TelemetryV1ChunkRow, deviceId: string,
): Promise<Response> {
  return jsonResponse({
    schemaVersion: "telemetry-chunk-receipt-v1.0",
    contributionId: row.id,
    chunkId: `${row.stream}:${row.chunk_day}:${row.chunk_seq}`,
    chunkRevision: row.revision,
    status: row.superseded_at === null ? "accepted" : "superseded",
    replayed: true,
    recordCounts: { declared: row.record_count, accepted: row.accepted_record_count },
    acknowledgedThroughDay: await acknowledgedThroughDay(client, schema, {
      participantId: row.participant_id, deviceId,
    }),
  }, 202, { "idempotency-replayed": "true" });
}

async function validatedReplay(
  pool: PostgresPool, schema: string, row: TelemetryV1ChunkRow, deviceId: string, sourceNamespace: string,
): Promise<Response> {
  return withPostgresRead(pool, async (client) => {
    const retained = await validateReceipt(client, schema, row, deviceId, sourceNamespace);
    return replayReceipt(client, schema, retained, deviceId);
  }, { operation: "telemetry_v1.receipt", preserveSafeError });
}

interface PreparedTypedRecord {
  readonly fields: TypedTelemetryFields;
  readonly canonicalDigest: Uint8Array;
}

async function prepareTypedRecords(chunk: TelemetryV1Chunk): Promise<PreparedTypedRecord[]> {
  const prepared: PreparedTypedRecord[] = [];
  for (const record of chunk.records) {
    const fields = encodeTypedTelemetryRecord("v1", record);
    if (fields.stream !== chunk.stream) throw new ApiError(400, "CHUNK_INVALID");
    const { canonicalRecord } = typedTelemetryCanonicalRecords(fields);
    if (encoder.encode(canonicalRecord).byteLength > MAX_RECORD_BYTES) throw unavailable();
    if (new Date(fields.observedAtMs).toISOString().slice(0, 10) !== chunk.chunkDay) {
      throw new ApiError(400, "CHUNK_INVALID");
    }
    prepared.push({ fields, canonicalDigest: await sha256(canonicalRecord) });
  }
  return prepared;
}

function dictionaryTokens(records: readonly PreparedTypedRecord[]): string[] {
  const tokens = new Set<string>();
  for (const { fields } of records) {
    tokens.add(fields.provider);
    if (fields.usage) {
      const u = fields.usage;
      for (const token of [u.modelId, u.speedMode, u.apiServiceTier, u.surface, u.billingSurface,
        u.reasoningEffort, u.agentScope, u.outcome]) tokens.add(token);
    }
    if (fields.quota) {
      for (const token of [fields.quota.planType, fields.quota.planVariant, fields.quota.limitId, fields.quota.slot]) {
        tokens.add(token);
      }
    }
    for (const tool of Object.keys(fields.tools ?? {})) tokens.add(tool);
  }
  return [...tokens];
}

async function idRow(
  client: PostgresClient, sql: string, values: unknown[],
): Promise<string> {
  const result = await client.query<{ id: string | number }>(sql, values);
  if (result.rows.length !== 1) throw unavailable();
  return String(safeInteger(result.rows[0]!.id, 1));
}

interface PersistInput {
  readonly principal: PostgresTelemetryV1Principal;
  readonly chunk: TelemetryV1Chunk;
  readonly chunkRowId: string;
  readonly r2Key: string;
  /** Legacy envelope digest (telemetryEnvelopeDigest): replay identity. */
  readonly envelopeDigest: string;
  /** SHA-256 of the exact HTTP body the authorization was minted for. */
  readonly authorizationEnvelopeDigest: string;
  readonly authorizationId: string;
  readonly createdAt: string;
  readonly sourceNamespace: string;
  readonly nowEpoch: number;
  readonly schemaConfig: PostgresSchemaConfig;
}

/**
 * The D1 batch as one PostgreSQL transaction, in D1's statement order with
 * D1's triggers as explicit steps. Lock order: participant, device, upload
 * grant, v1.0 consent, typed v1 admission state, current slot, admission
 * window, then (through begin_graph_scope, the chunk triggers and
 * storage_journal_append) mutation_control, owner link and storage source.
 */
async function persistTypedChunk(
  client: PostgresClient, schema: string, input: PersistInput,
): Promise<{ acceptedRecords: number; replay: boolean; supersededRevision: number | null }> {
  const { principal, chunk } = input;
  const nowIso = new Date(input.nowEpoch).toISOString();
  // D1 typed_v1_header_authority: any failure is 'upload unavailable'.
  const participant = await client.query<{ state: string; owner_kind: string }>(
    `SELECT state, owner_kind FROM ${table(schema, "participants")} WHERE id = $1 FOR UPDATE`,
    [principal.participantId],
  );
  if (participant.rows[0]?.state !== "active" || participant.rows[0]?.owner_kind !== "social") {
    throw uploadUnavailable();
  }
  const device = await client.query<{ id: string }>(
    `SELECT id FROM ${table(schema, "device_credentials")}
      WHERE id = $1 AND participant_id = $2 AND state = 'active' AND revoked_at IS NULL
        AND authority_kind = 'social' AND expires_at > $3::timestamptz
      FOR SHARE`,
    [principal.deviceId, principal.participantId, nowIso],
  );
  if (device.rows.length !== 1) throw uploadUnavailable();
  const grant = await client.query<{ id: string }>(
    `SELECT id FROM ${table(schema, "device_upload_authorizations")}
      WHERE id = $1 AND participant_id = $2 AND issued_by_device_id = $3
        AND state = 'consuming' AND envelope_digest = $4
        AND consume_lease_expires_at > $5::timestamptz AND expires_at > $5::timestamptz
      FOR UPDATE`,
    [input.authorizationId, principal.participantId, principal.deviceId,
      input.authorizationEnvelopeDigest, nowIso],
  );
  if (grant.rows.length !== 1) throw uploadUnavailable();
  if (!await deviceConsentCurrent(client, schema, principal, true)) throw uploadUnavailable();

  const state = await readAdmissionState(client, schema, input.sourceNamespace, true);
  if (!Number.isSafeInteger(state.nextSourceRowId + chunk.records.length)) throw unavailable();

  // An exact replay that committed between the caller's lookup and this lock
  // converges on the committed chunk (D1 replay()).
  const prior = await chunkByEnvelopeDigest(client, schema, principal.participantId, input.envelopeDigest);
  if (prior) {
    if (prior.device_id !== principal.deviceId || prior.chunk_digest !== chunk.chunkDigest
        || prior.stream !== chunk.stream || prior.chunk_day !== chunk.chunkDay
        || prior.chunk_seq !== chunk.chunkSeq || prior.revision !== chunk.chunkRevision
        || prior.record_count !== chunk.records.length || prior.superseded_at !== null) {
      throw unavailable();
    }
    await validateReceipt(client, schema, prior, principal.deviceId, input.sourceNamespace);
    return { acceptedRecords: chunk.records.length, replay: true, supersededRevision: null };
  }

  const current = await currentChunk(client, schema, principal, chunk, true);
  if (current) {
    if (current.chunk_digest === chunk.chunkDigest) {
      await validateReceipt(client, schema, current, principal.deviceId, input.sourceNamespace);
      return { acceptedRecords: chunk.records.length, replay: true, supersededRevision: null };
    }
    if (chunk.chunkRevision !== current.revision + 1) throw new ApiError(409, "CHUNK_REVISION_CONFLICT");
    // A usage correction under an active correction runtime also records
    // usage-correction facts on D1 (prepareTelemetryUsageCorrectionForV1Replacement);
    // that writer is not ported and 0034 keeps the PostgreSQL runtime staged.
    if (chunk.stream === "usage" && await usageCorrectionRuntimeActive(client, schema)) throw unavailable();
  } else {
    if (chunk.chunkRevision !== 1) throw new ApiError(409, "CHUNK_REVISION_CONFLICT");
    const slotUsed = await client.query<{ found: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${table(schema, "telemetry_v1_chunks")}
        WHERE participant_id = $1 AND device_id = $2 AND stream = $3 AND chunk_day = $4::date
          AND chunk_seq = $5) AS found`,
      [principal.participantId, principal.deviceId, chunk.stream, chunk.chunkDay, chunk.chunkSeq],
    );
    if (slotUsed.rows[0]?.found !== false) throw new ApiError(409, "CHUNK_REVISION_CONFLICT");
  }

  // D1 baseline chunk-admission trigger pair, on the request day.
  const windowDay = input.createdAt.slice(0, 10);
  const windowRow = await client.query<{ accepted_count: number }>(
    `SELECT accepted_count FROM ${table(schema, "telemetry_v1_chunk_admission_windows")}
      WHERE participant_id = $1 AND device_id = $2 AND window_day = $3::date FOR UPDATE`,
    [principal.participantId, principal.deviceId, windowDay],
  );
  const admission = await chunkAdmission(client, schema, principal, input.nowEpoch);
  if (Number(windowRow.rows[0]?.accepted_count ?? 0) >= admission.maximumChunks) {
    throw new ApiError(429, "CHUNK_ADMISSION_LIMIT_REACHED", { responseHeaders: { "retry-after": "60" } });
  }

  const records = await prepareTypedRecords(chunk);
  // Live allocation through the 0052 identities is safe only while every
  // typed identity is above its imported rows (TL-1); refuse otherwise.
  await verifyPostgresTypedIdentityHeadroom(client, input.schemaConfig);

  // community_graph_update_scope: the PostgreSQL marker the retained
  // mutation-epoch trigger (analytical_mutation, 0010) consumes.
  await client.query(`SELECT ${schema}.begin_graph_scope($1::jsonb)`, [JSON.stringify({
    participantId: principal.participantId,
    deviceId: principal.deviceId,
    chunkId: input.chunkRowId,
    uploadAuthorizationId: input.authorizationId,
    envelopeDigest: input.envelopeDigest,
    createdAt: input.createdAt,
    supersedes: current ? { id: current.id } : null,
    chunk: {
      stream: chunk.stream, chunkDay: chunk.chunkDay, chunkSeq: chunk.chunkSeq,
      chunkRevision: chunk.chunkRevision, chunkDigest: chunk.chunkDigest,
      parserVersion: chunk.parserVersion, records: chunk.records,
    },
  })]);

  if (current) {
    // D1 order: the prior revision leaves the current view, then its typed
    // rows go (the staged migration's retention allowance), then the new
    // revision enters. Header, allocation and event receipt of the prior
    // revision are retained.
    const superseded = await client.query(
      `UPDATE ${table(schema, "telemetry_v1_chunks")} SET superseded_at = $3::timestamptz
        WHERE id = $1 AND participant_id = $2 AND superseded_at IS NULL`,
      [current.id, principal.participantId, input.createdAt],
    );
    if (superseded.rowCount !== 1) throw new ApiError(409, "CHUNK_REVISION_CONFLICT");
    await client.query(
      `DELETE FROM ${table(schema, "typed_telemetry_chunks")}
        WHERE namespace_id = $1 AND format = ${POSTGRES_TYPED_V1_FORMAT}
          AND original_id = (SELECT chunk_original FROM ${table(schema, "typed_v1_chunk_allocations")}
                              WHERE chunk_id = $2)`,
      [state.namespaceId, current.id],
    );
  }
  await client.query(
    `INSERT INTO ${table(schema, "telemetry_v1_chunks")} (
       id, participant_id, device_id, stream, chunk_day, chunk_seq, revision, chunk_digest,
       envelope_digest, parser_version, record_count, accepted_record_count, r2_key,
       device_upload_authorization_id, created_at
     ) VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11, $11, $12, $13, $14::timestamptz)`,
    [input.chunkRowId, principal.participantId, principal.deviceId, chunk.stream, chunk.chunkDay,
      chunk.chunkSeq, chunk.chunkRevision, chunk.chunkDigest, input.envelopeDigest, chunk.parserVersion,
      chunk.records.length, input.r2Key, input.authorizationId, input.createdAt],
  );

  // typed_telemetry_* rows (prepareTypedTelemetryInsert, format 10).
  // D1 inserts the batch's tokens in first-seen order; so does this loop.
  const tokens = dictionaryTokens(records);
  for (const token of tokens) {
    await client.query(
      `INSERT INTO ${table(schema, "typed_telemetry_dictionary")} (value) VALUES ($1) ON CONFLICT (value) DO NOTHING`,
      [token],
    );
  }
  const namespaceId = state.namespaceId;
  const ownerOriginal = encodeTypedTelemetryId(principal.participantId);
  await client.query(
    `INSERT INTO ${table(schema, "typed_telemetry_owners")} (namespace_id, original_id)
     VALUES ($1, $2) ON CONFLICT (namespace_id, original_id) DO NOTHING`,
    [namespaceId, ownerOriginal],
  );
  const ownerId = await idRow(client,
    `SELECT id FROM ${table(schema, "typed_telemetry_owners")} WHERE namespace_id = $1 AND original_id = $2`,
    [namespaceId, ownerOriginal]);
  // D1 typed_v1_owner_memberships(participant_id, typed_owner_id) is
  // PostgreSQL's per-format typed_telemetry_owner_memberships row. Insert it
  // only when absent: its BEFORE INSERT guard (0030) refuses a participant
  // whose owner link is withdrawn, which D1 never checks for an existing
  // mapping, and a BEFORE trigger runs even when ON CONFLICT would skip.
  const readMembership = () => client.query<{ owner_id: string; participant_id: string; source_namespace: string }>(
    `SELECT owner_id::text AS owner_id, participant_id, source_namespace
       FROM ${table(schema, "typed_telemetry_owner_memberships")}
      WHERE source_format = ${POSTGRES_TYPED_V1_FORMAT} AND participant_id = $1`,
    [principal.participantId],
  );
  let membership = await readMembership();
  if (membership.rows.length === 0) {
    await client.query(
      `INSERT INTO ${table(schema, "typed_telemetry_owner_memberships")}
         (namespace_id, source_format, owner_id, participant_id, source_namespace)
       VALUES ($1, ${POSTGRES_TYPED_V1_FORMAT}, $2, $3, $4)`,
      [namespaceId, ownerId, principal.participantId, input.sourceNamespace],
    );
    membership = await readMembership();
  }
  if (membership.rows.length !== 1 || membership.rows[0]!.owner_id !== ownerId
      || membership.rows[0]!.source_namespace !== input.sourceNamespace) {
    throw unavailable();
  }
  const deviceOriginal = encodeTypedTelemetryId(principal.deviceId);
  await client.query(
    `INSERT INTO ${table(schema, "typed_telemetry_devices")} (namespace_id, owner_id, original_id)
     VALUES ($1, $2, $3) ON CONFLICT (namespace_id, original_id) DO NOTHING`,
    [namespaceId, ownerId, deviceOriginal],
  );
  const typedDevice = await client.query<{ id: string; owner_id: string }>(
    `SELECT id::text AS id, owner_id::text AS owner_id FROM ${table(schema, "typed_telemetry_devices")}
      WHERE namespace_id = $1 AND original_id = $2`,
    [namespaceId, deviceOriginal],
  );
  // D1 would rewrite a moved device's owner; an existing device always
  // keeps its participant here, so a mismatch is never a valid upload.
  if (typedDevice.rows.length !== 1 || typedDevice.rows[0]!.owner_id !== ownerId) throw unavailable();
  const deviceId = typedDevice.rows[0]!.id;
  const chunkOriginal = encodeTypedTelemetryId(input.chunkRowId);
  const typedChunkId = await idRow(client,
    `INSERT INTO ${table(schema, "typed_telemetry_chunks")}
       (namespace_id, format, owner_id, device_id, manifest_id, original_id, stream, chunk_day)
     VALUES ($1, ${POSTGRES_TYPED_V1_FORMAT}, $2, $3, NULL, $4, $5, $6) RETURNING id`,
    [namespaceId, ownerId, deviceId, chunkOriginal, STREAMS.indexOf(chunk.stream) + 1,
      typedTelemetryDayNumber(chunk.chunkDay)]);

  const dictionaryId = (value: string) => `(SELECT id FROM ${table(schema, "typed_telemetry_dictionary")} WHERE value = ${value})`;
  const firstSourceRowId = state.nextSourceRowId;
  const recordIds: string[] = [];
  for (const [index, { fields, canonicalDigest }] of records.entries()) {
    let sessionId: string | null = null;
    if (fields.usage) {
      await client.query(
        `INSERT INTO ${table(schema, "typed_telemetry_identifiers")} (namespace_id, owner_id, value)
         VALUES ($1, $2, $3) ON CONFLICT (namespace_id, owner_id, value) DO NOTHING`,
        [namespaceId, ownerId, fields.usage.sessionId],
      );
      sessionId = await idRow(client,
        `SELECT id FROM ${table(schema, "typed_telemetry_identifiers")}
          WHERE namespace_id = $1 AND owner_id = $2 AND value = $3`,
        [namespaceId, ownerId, fields.usage.sessionId]);
    }
    let dimensionsId: string | null = null;
    if (fields.quota) {
      await client.query(
        `INSERT INTO ${table(schema, "typed_telemetry_quota_dimensions")}
           (namespace_id, owner_id, plan_type_id, plan_variant_id, attribution_id)
         VALUES ($1, $2, ${dictionaryId("$3")}, ${dictionaryId("$4")}, NULL)
         ON CONFLICT (namespace_id, owner_id, plan_type_id, plan_variant_id, coalesce(attribution_id, 0)) DO NOTHING`,
        [namespaceId, ownerId, fields.quota.planType, fields.quota.planVariant],
      );
      dimensionsId = await idRow(client,
        `SELECT id FROM ${table(schema, "typed_telemetry_quota_dimensions")}
          WHERE namespace_id = $1 AND owner_id = $2 AND plan_type_id = ${dictionaryId("$3")}
            AND plan_variant_id = ${dictionaryId("$4")} AND attribution_id IS NULL`,
        [namespaceId, ownerId, fields.quota.planType, fields.quota.planVariant]);
    }
    const recordId = await idRow(client,
      `INSERT INTO ${table(schema, "typed_telemetry_records")} (
         namespace_id, format, source_row_id, owner_id, device_id, chunk_id, manifest_id, stream,
         occurrence_id, observed_at_ms, observed_day, provider_id, canonical_digest
       ) VALUES ($1, ${POSTGRES_TYPED_V1_FORMAT}, $2, $3, $4, $5, NULL, $6, $7, $8, $9, ${dictionaryId("$10")}, $11)
       RETURNING id`,
      [namespaceId, firstSourceRowId + index, ownerId, deviceId, typedChunkId,
        STREAMS.indexOf(fields.stream) + 1, fields.occurrenceId, fields.observedAtMs,
        typedTelemetryDayNumber(chunk.chunkDay), fields.provider, canonicalDigest]);
    recordIds.push(recordId);
    if (fields.usage) {
      const u = fields.usage;
      await client.query(
        `INSERT INTO ${table(schema, "typed_telemetry_usage")} (
           record_id, session_id, model_id, speed_mode_id, api_service_tier_id, surface_id,
           billing_surface_id, reasoning_effort_id, agent_scope_id, outcome_id, attribution_id,
           total_input_context_tokens, input_uncached_tokens, input_cache_read_tokens,
           input_cache_write_tokens, output_text_tokens, output_reasoning_tokens, output_combined_tokens
         ) VALUES ($1, $2, ${dictionaryId("$3")}, ${dictionaryId("$4")}, ${dictionaryId("$5")},
           ${dictionaryId("$6")}, ${dictionaryId("$7")}, ${dictionaryId("$8")}, ${dictionaryId("$9")},
           ${dictionaryId("$10")}, NULL, $11, $12, $13, $14, $15, $16, $17)`,
        [recordId, sessionId, u.modelId, u.speedMode, u.apiServiceTier, u.surface, u.billingSurface,
          u.reasoningEffort, u.agentScope, u.outcome, u.totalInputContextTokens,
          u.components.inputUncachedTokens, u.components.inputCacheReadTokens,
          u.components.inputCacheWriteTokens, u.components.outputTextTokens,
          u.components.outputReasoningTokens, u.components.outputCombinedTokens],
      );
    } else if (fields.quota) {
      const q = fields.quota;
      await client.query(
        `INSERT INTO ${table(schema, "typed_telemetry_quota")} (
           record_id, dimensions_id, limit_id, slot_id, used_percent, window_duration_minutes, resets_at_ms
         ) VALUES ($1, $2, ${dictionaryId("$3")}, ${dictionaryId("$4")}, $5, $6, $7)`,
        [recordId, dimensionsId, q.limitId, q.slot, q.usedPercent, q.windowDurationMinutes, q.resetsAtMs],
      );
    } else {
      for (const [tool, count] of Object.entries(fields.tools ?? {})) {
        await client.query(
          `INSERT INTO ${table(schema, "typed_telemetry_session_tools")} (record_id, tool_class_id, count)
           VALUES ($1, ${dictionaryId("$2")}, $3) ON CONFLICT DO NOTHING`,
          [recordId, tool, count],
        );
      }
    }
  }

  // typed_v1_chunk_allocations and D1's typed_v1_allocation_advance.
  await client.query(
    `INSERT INTO ${table(schema, "typed_v1_chunk_allocations")}
       (chunk_id, namespace_id, chunk_original, first_source_row_id, record_count)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.chunkRowId, namespaceId, chunkOriginal, firstSourceRowId, chunk.records.length],
  );
  const advanced = await client.query(
    `UPDATE ${table(schema, "typed_v1_admission_state")}
        SET next_source_row_id = $2
      WHERE id = 1 AND namespace_id = $1 AND next_source_row_id = $3 AND runtime_contract_version = 1`,
    [namespaceId, firstSourceRowId + chunk.records.length, firstSourceRowId],
  );
  if (advanced.rowCount !== 1) throw new ApiError(409, "UPLOAD_IN_PROGRESS");
  for (const recordId of recordIds) {
    await client.query(
      `INSERT INTO ${table(schema, "typed_v1_record_admissions")} (typed_record_id, chunk_id) VALUES ($1, $2)`,
      [recordId, input.chunkRowId],
    );
  }

  // Owner link (D1: INSERT ... ON CONFLICT DO NOTHING with a random digest).
  const ownerDigest = await client.query<{ digest: string }>(
    `SELECT ${schema}.storage_owner_link_ensure($1, 'active') AS digest`,
    [principal.participantId],
  );
  const digest = ownerDigest.rows[0]?.digest;
  if (typeof digest !== "string" || !DIGEST.test(digest)) throw unavailable();
  const eventDigest = randomHex(32);
  await client.query(
    `INSERT INTO ${table(schema, "typed_v1_event_sources")}
       (event_digest, owner_digest, participant_id, chunk_id, source_namespace)
     VALUES ($1, $2, $3, $4, $5)`,
    [eventDigest, digest, principal.participantId, input.chunkRowId, input.sourceNamespace],
  );
  // D1 ingestion-isolation 0004 typed_v1_event_publish classification. The
  // request pin (typed_v1_authority_requests) always exists on this live path.
  const classification = await client.query<{ append: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM ${table(schema, "telemetry_v1_chunks")} c
         JOIN ${table(schema, "participants")} p
           ON p.id = c.participant_id AND p.state = 'active' AND p.owner_kind = 'social'
         JOIN ${table(schema, "storage_v11_owner_links")} link
           ON link.participant_id = c.participant_id AND link.owner_digest = $2 AND link.state = 'active'
         JOIN ${table(schema, "storage_source_state")} source ON source.singleton = 1
         JOIN ${table(schema, "storage_owner_revisions")} owner
           ON owner.source_id = source.source_id AND owner.owner_digest = link.owner_digest
          AND owner.state = 'active'
        WHERE c.id = $1 AND c.revision = 1 AND c.superseded_at IS NULL
          AND c.accepted_record_count = c.record_count AND c.record_count BETWEEN 1 AND 200
          AND NOT EXISTS (SELECT 1 FROM ${table(schema, "telemetry_v11_domain_heads")} head
            WHERE head.participant_id = c.participant_id)
          AND NOT EXISTS (SELECT 1 FROM ${table(schema, "telemetry_contributions")} legacy
            WHERE legacy.participant_id = c.participant_id AND legacy.status = 'accepted')
          AND NOT EXISTS (SELECT 1 FROM ${table(schema, "telemetry_v1_chunks")} older
            WHERE older.participant_id = c.participant_id AND older.device_id = c.device_id
              AND older.stream = c.stream AND older.chunk_day = c.chunk_day
              AND older.chunk_seq = c.chunk_seq AND older.id <> c.id)
     ) AS append`,
    [input.chunkRowId, digest],
  );
  const kind = classification.rows[0]?.append === true ? "source-updated" : "owner-active";
  await client.query(
    `SELECT ${schema}.storage_journal_append($1, $2, $3, $3, $4)`,
    [kind, digest, eventDigest, chunk.chunkDigest],
  );
  const linked = await client.query(
    `UPDATE ${table(schema, "storage_v11_owner_links")}
        SET state = 'active', object_digest = $2, manifest_digest = $3
      WHERE participant_id = $1`,
    [principal.participantId, eventDigest, chunk.chunkDigest],
  );
  if (linked.rowCount !== 1) throw unavailable();

  // D1 baseline consume + admission-window triggers on the chunk insert.
  const consumed = await client.query(
    `UPDATE ${table(schema, "device_upload_authorizations")}
        SET state = 'consumed', consumed_at = $2::timestamptz, consume_lease_expires_at = NULL,
            consumed_contribution_id = $3
      WHERE id = $1 AND state = 'consuming' AND envelope_digest = $4
        AND consume_lease_expires_at > $2::timestamptz AND expires_at > $2::timestamptz`,
    [input.authorizationId, input.createdAt, input.chunkRowId, input.authorizationEnvelopeDigest],
  );
  if (consumed.rowCount !== 1) throw uploadUnavailable();
  await client.query(
    `INSERT INTO ${table(schema, "telemetry_v1_chunk_admission_windows")}
       (participant_id, device_id, window_day, accepted_count, last_accepted_at)
     VALUES ($1, $2, $3::date, 1, $4::timestamptz)
     ON CONFLICT (participant_id, device_id, window_day)
     DO UPDATE SET accepted_count = ${table(schema, "telemetry_v1_chunk_admission_windows")}.accepted_count + 1,
                   last_accepted_at = EXCLUDED.last_accepted_at`,
    [principal.participantId, principal.deviceId, windowDay, input.createdAt],
  );
  return { acceptedRecords: chunk.records.length, replay: false, supersededRevision: current?.revision ?? null };
}

function validPendingObject(
  row: { contribution_id?: unknown; object_key?: unknown; object_kind?: unknown; reconciliation_state?: unknown } | undefined,
  contributionId: string, objectKey: string, state = "registered", kind = POSTGRES_TELEMETRY_V1_PENDING_OBJECT_KIND,
): boolean {
  return row?.contribution_id === contributionId && row.object_key === objectKey
    && row.object_kind === kind && row.reconciliation_state === state;
}

/** pending_objects registration before the PUT (D1 putTrackedQuarantineObject). */
async function registerPendingObject(
  pool: PostgresPool, schema: string, contributionId: string, objectKey: string, nowIso: string,
): Promise<void> {
  return registerPendingObjectOfKind(pool, schema, contributionId, objectKey, nowIso,
    POSTGRES_TELEMETRY_V1_PENDING_OBJECT_KIND);
}

async function registerPendingObjectOfKind(
  pool: PostgresPool, schema: string, contributionId: string, objectKey: string, nowIso: string,
  kind: string,
): Promise<void> {
  const pending = table(schema, "pending_objects");
  const read = () => withPostgresRead(pool, async (client) => {
    const result = await client.query<{
      contribution_id: string; object_key: string; object_kind: string; reconciliation_state: string;
    }>(
      `SELECT contribution_id, object_key, object_kind, reconciliation_state FROM ${pending}
        WHERE contribution_id = $1`,
      [contributionId],
    );
    return validPendingObject(result.rows[0], contributionId, objectKey, "registered", kind);
  }, { operation: "telemetry_v1.pending_read" });
  try {
    await withPostgresMutation(pool, async (client) => {
      const inserted = await client.query(
        `INSERT INTO ${table(schema, "pending_objects")} (contribution_id, object_key, object_kind, registered_at, reconciliation_state)
         VALUES ($1, $2, $3, $4::timestamptz, 'registered') ON CONFLICT (contribution_id) DO NOTHING`,
        [contributionId, objectKey, kind, nowIso],
      );
      if (inserted.rowCount !== 1) throw unavailable();
    }, { operation: "telemetry_v1.pending_register" });
  } catch {
    // A lost COMMIT acknowledgement may still have installed the row; only a
    // fresh read proves it. Never write the object store without that proof.
    try { if (await read()) return; } catch { /* outcome unknown */ }
    throw unavailable();
  }
}

/**
 * Remove this request's object when no chunk references it (D1: the
 * QUARANTINE delete plus clearPendingQuarantineObject). The journal row is
 * claimed 'deleting' first, so an uncertain delete stays resumable.
 */
async function retireUnreferencedObject(
  pool: PostgresPool, schema: string, objectStore: PostgresTelemetryV1ObjectStore,
  input: { chunkRowId: string; objectKey: string; authorizationId: string },
): Promise<boolean> {
  return retireUnreferencedObjectOfKind(pool, schema, objectStore, input,
    POSTGRES_TELEMETRY_V1_PENDING_OBJECT_KIND, "telemetry_v1_chunks");
}

async function retireUnreferencedObjectOfKind(
  pool: PostgresPool, schema: string, objectStore: PostgresTelemetryV1ObjectStore,
  input: { chunkRowId: string; objectKey: string; authorizationId: string },
  kind: string, referencingTable: "telemetry_v1_chunks" | "telemetry_contributions",
): Promise<boolean> {
  const pending = table(schema, "pending_objects");
  const chunks = table(schema, referencingTable);
  const leaseId = crypto.randomUUID();
  const reference = `SELECT EXISTS (SELECT 1 FROM ${chunks}
    WHERE id = $1 OR r2_key = $2 OR device_upload_authorization_id = $3) AS referenced`;
  const claimed = await withPostgresMutation(pool, async (client) => {
    const row = await client.query<{
      contribution_id: string; object_key: string; object_kind: string; reconciliation_state: string;
    }>(
      `SELECT contribution_id, object_key, object_kind, reconciliation_state FROM ${pending}
        WHERE contribution_id = $1 FOR UPDATE`,
      [input.chunkRowId],
    );
    if (!validPendingObject(row.rows[0], input.chunkRowId, input.objectKey, "registered", kind)) return false;
    const referenced = await client.query<{ referenced: boolean }>(
      reference, [input.chunkRowId, input.objectKey, input.authorizationId]);
    if (referenced.rows[0]?.referenced !== false) return false;
    const updated = await client.query(
      `UPDATE ${pending} SET reconciliation_state = 'deleting', reconciliation_lease_id = $2
        WHERE contribution_id = $1 AND object_key = $3 AND object_kind = $4
          AND reconciliation_state = 'registered'`,
      [input.chunkRowId, leaseId, input.objectKey, kind],
    );
    return updated.rowCount === 1;
  }, { operation: "telemetry_v1.object_claim" });
  if (!claimed) return false;
  await objectStore.delete(input.objectKey);
  return withPostgresMutation(pool, async (client) => {
    const referenced = await client.query<{ referenced: boolean }>(
      reference, [input.chunkRowId, input.objectKey, input.authorizationId]);
    if (referenced.rows[0]?.referenced !== false) return false;
    const removed = await client.query(
      `DELETE FROM ${pending} WHERE contribution_id = $1 AND object_key = $2 AND object_kind = $3
          AND reconciliation_state = 'deleting' AND reconciliation_lease_id = $4`,
      [input.chunkRowId, input.objectKey, kind, leaseId],
    );
    return removed.rowCount === 1;
  }, { operation: "telemetry_v1.object_retire" });
}

async function bestEffortRetire(
  pool: PostgresPool, schema: string, objectStore: PostgresTelemetryV1ObjectStore,
  input: { chunkRowId: string; objectKey: string; authorizationId: string },
): Promise<void> {
  try { await retireUnreferencedObject(pool, schema, objectStore, input); }
  catch { /* The durable pending row stays the reconciliation journal. */ }
}

/**
 * telemetry-envelope-v1.0 after the shared preamble: the port of
 * handleTelemetryV1Contribution (src/index.ts at d43c8f92) for
 * TELEMETRY_STORAGE_MODE=typed. Returns the Worker's 202 receipt or throws
 * the Worker's ApiError.
 */
export async function admitPostgresTelemetryV1Contribution(
  input: PostgresTelemetryV1ContributionInput,
): Promise<Response> {
  const nowEpoch = requestEpoch(input.nowEpoch);
  const schemaConfig: PostgresSchemaConfig = createPostgresSchemaConfig(input.schema ?? {});
  const schema = schemaName(schemaConfig);
  const { pool, objectStore, sourceNamespace } = input;
  if (input.authorization.authorizationKind !== "device") throw uploadUnavailable();
  if (input.participant.consentVersion !== TELEMETRY_CONSENT_VERSION) {
    throw new ApiError(400, "TELEMETRY_REQUIRED");
  }
  const envelope = validateTelemetryV1Envelope(input.body.value);
  const envelopeDigest = await telemetryEnvelopeDigest(envelope);
  const principal: PostgresTelemetryV1Principal = Object.freeze({
    participantId: input.participant.id, deviceId: input.deviceId,
  });
  if (typeof principal.deviceId !== "string" || principal.deviceId.length < 1) throw uploadUnavailable();
  // resolveTelemetryStorageMode(..., 'v1'): an unpinned or mismatched typed
  // target refuses the request before any decrypt or write.
  await withPostgresRead(pool, (client) => readAdmissionState(client, schema, sourceNamespace, false),
    { operation: "telemetry_v1.storage_mode", preserveSafeError });

  const envelopeReplay = await withPostgresRead(pool,
    (client) => chunkByEnvelopeDigest(client, schema, principal.participantId, envelopeDigest),
    { operation: "telemetry_v1.envelope_replay", preserveSafeError });
  if (envelopeReplay) {
    return validatedReplay(pool, schema, envelopeReplay, principal.deviceId, sourceNamespace);
  }

  const plaintext = await decryptSyntheticEnvelope(envelope, input.envelopePublicJwk, input.envelopePrivateJwk);
  const chunk = parseTelemetryV1Chunk(plaintext);
  assertTelemetryV1ConsentCurrent(chunk.consent);
  if (!await withPostgresRead(pool, (client) => deviceConsentCurrent(client, schema, principal),
    { operation: "telemetry_v1.consent", preserveSafeError })) {
    throw new ApiError(403, "TELEMETRY_CONSENT_INVALID");
  }
  const canonicalRecords = canonicalJson(chunk.records);
  if (encoder.encode(canonicalRecords).byteLength > MAX_TELEMETRY_V1_CHUNK_CANONICAL_BYTES) {
    throw new ApiError(400, "CHUNK_INVALID");
  }
  if (await sha256Hex(canonicalRecords) !== chunk.chunkDigest) {
    throw new ApiError(400, "CHUNK_DIGEST_MISMATCH");
  }
  const current = await withPostgresRead(pool, (client) => currentChunk(client, schema, principal, chunk),
    { operation: "telemetry_v1.current", preserveSafeError });
  if (current && current.chunk_digest === chunk.chunkDigest) {
    return validatedReplay(pool, schema, current, principal.deviceId, sourceNamespace);
  }
  if (current ? chunk.chunkRevision !== current.revision + 1 : chunk.chunkRevision !== 1) {
    throw new ApiError(409, "CHUNK_REVISION_CONFLICT");
  }
  const admission = await withPostgresRead(pool, (client) => chunkAdmission(client, schema, principal, nowEpoch),
    { operation: "telemetry_v1.admission", preserveSafeError });
  if (admission.state === "exhausted") throw telemetryV1ChunkAdmissionError(admission, nowEpoch);
  if (current && chunk.stream === "usage" && await withPostgresRead(pool,
    (client) => usageCorrectionRuntimeActive(client, schema),
    { operation: "telemetry_v1.correction_runtime", preserveSafeError })) {
    // Refuse before any object write (module comment).
    throw unavailable();
  }

  const chunkRowId = `chunk:${crypto.randomUUID()}`;
  const r2Key = `telemetry/v1-${crypto.randomUUID()}`;
  const createdAt = new Date(nowEpoch).toISOString();
  const objectInput = { chunkRowId, objectKey: r2Key, authorizationId: input.authorization.authorizationId };
  await registerPendingObject(pool, schema, chunkRowId, r2Key, createdAt);
  try {
    await objectStore.put(r2Key, JSON.stringify(envelope), {
      contentType: "application/json",
      customMetadata: {
        contributionId: chunkRowId,
        schemaVersion: TELEMETRY_V1_ENVELOPE_SCHEMA_VERSION,
        plaintextSchemaVersion: chunk.schemaVersion,
        synthetic: "false",
      },
    });
  } catch {
    // A failed PUT may still have stored bytes; keep the pending row.
    throw unavailable();
  }

  const authorizationEnvelopeDigest = await sha256Hex(input.body.raw);
  const persistInput: PersistInput = {
    principal, chunk, chunkRowId, r2Key, envelopeDigest, authorizationEnvelopeDigest,
    authorizationId: input.authorization.authorizationId, createdAt, sourceNamespace, nowEpoch, schemaConfig,
  };
  let result: { acceptedRecords: number; replay: boolean; supersededRevision: number | null };
  try {
    result = await withPostgresMutation(pool, (client) => persistTypedChunk(client, schema, persistInput), {
      operation: "telemetry_v1.admit",
      isolationLevel: "read_committed",
      statementTimeoutMilliseconds: 60_000,
      lockTimeoutMilliseconds: 5_000,
      preserveSafeError,
    });
  } catch (error) {
    // The transaction may have committed before its acknowledgement was
    // lost. Only a completed lookup distinguishes our committed chunk from
    // an orphan object (index.ts catch block at d43c8f92).
    let replay: TelemetryV1ChunkRow | null;
    try {
      replay = await withPostgresRead(pool, async (client) =>
        await chunkByEnvelopeDigest(client, schema, principal.participantId, envelopeDigest)
          ?? await currentChunk(client, schema, principal, chunk),
      { operation: "telemetry_v1.recover", preserveSafeError });
    } catch {
      throw unavailable();
    }
    if (replay && replay.chunk_digest === chunk.chunkDigest) {
      const response = await validatedReplay(pool, schema, replay, principal.deviceId, sourceNamespace);
      if (replay.id !== chunkRowId) await bestEffortRetire(pool, schema, objectStore, objectInput);
      return response;
    }
    await bestEffortRetire(pool, schema, objectStore, objectInput);
    if (error instanceof ApiError) throw error;
    let retryAdmission: TelemetryV1ChunkAdmission;
    try {
      retryAdmission = await withPostgresRead(pool,
        (client) => chunkAdmission(client, schema, principal, Date.now()),
        { operation: "telemetry_v1.admission_retry", preserveSafeError });
    } catch {
      throw unavailable();
    }
    if (retryAdmission.state === "exhausted") throw telemetryV1ChunkAdmissionError(retryAdmission);
    throw unavailable();
  }

  if (result.replay) {
    // A recovered response acknowledges the committed id, never this
    // request's proposed one when another request won the same content.
    const row = await withPostgresRead(pool,
      (client) => chunkByEnvelopeDigest(client, schema, principal.participantId, envelopeDigest),
      { operation: "telemetry_v1.replay_read", preserveSafeError });
    const retained = row ?? await withPostgresRead(pool, (client) => currentChunk(client, schema, principal, chunk),
      { operation: "telemetry_v1.replay_current", preserveSafeError });
    if (!retained) throw unavailable();
    const response = await validatedReplay(pool, schema, retained, principal.deviceId, sourceNamespace);
    if (retained.id !== chunkRowId) await bestEffortRetire(pool, schema, objectStore, objectInput);
    return response;
  }
  const [throughDay, settledAdmission] = await withPostgresRead(pool, async (client) => [
    await acknowledgedThroughDay(client, schema, principal),
    await chunkAdmission(client, schema, principal, nowEpoch),
  ] as const, { operation: "telemetry_v1.receipt", preserveSafeError });
  return jsonResponse({
    schemaVersion: "telemetry-chunk-receipt-v1.0",
    contributionId: chunkRowId,
    chunkId: chunk.chunkId,
    chunkRevision: chunk.chunkRevision,
    status: "accepted",
    supersededRevision: result.supersededRevision,
    recordCounts: { declared: chunk.records.length, accepted: result.acceptedRecords },
    acknowledgedThroughDay: throughDay,
    admission: settledAdmission,
  }, 202);
}

/**
 * Port of recordDeviceUploadReceipt (device-auth.ts at d43c8f92) for the
 * shared contributions preamble: after any handler's 202, the one-use
 * authorization is consumed against the receipt's contributionId (for a
 * replay, the retained chunk's id). A fresh v1.0 admission has already
 * consumed it in its own transaction; that is accepted as the same outcome.
 */
export async function recordPostgresDeviceUploadReceipt(
  pool: PostgresPool,
  authorizationId: string,
  contributionId: string,
  options: { readonly schema?: PostgresSchemaOptions; readonly nowEpoch?: number } = {},
): Promise<void> {
  const nowIso = new Date(requestEpoch(options.nowEpoch)).toISOString();
  const schema = schemaName(options.schema);
  const accountlessAuthority = `EXISTS (
    SELECT 1 FROM ${table(schema, "device_credentials")} device
      JOIN ${table(schema, "participants")} participant ON participant.id = device.participant_id
      JOIN ${table(schema, "accountless_enrollment_ledger")} ledger
        ON ledger.device_id = device.accountless_enrollment_device_id
      JOIN ${table(schema, "accountless_upload_owners")} owner ON owner.enrollment_device_id = ledger.device_id
      JOIN ${table(schema, "accountless_v11_device_authorizations")} grant_row
        ON grant_row.enrollment_device_id = ledger.device_id
     WHERE device.id = upload.issued_by_device_id AND device.participant_id = upload.participant_id
       AND device.authority_kind = 'accountless' AND device.state = 'active'
       AND participant.owner_kind = 'accountless' AND participant.state = 'active'
       AND ledger.state = 'active' AND ledger.expires_at = device.expires_at
       AND ledger.expires_at > $3::timestamptz
       AND owner.participant_id = participant.id AND owner.device_credential_id = device.id
       AND owner.state = 'active' AND owner.expires_at = ledger.expires_at
       AND grant_row.participant_id = participant.id AND grant_row.device_credential_id = device.id
       AND grant_row.state = 'active' AND grant_row.expires_at = ledger.expires_at)`;
  try {
    await withPostgresMutation(pool, async (client) => {
      const updated = await client.query(
        `UPDATE ${table(schema, "device_upload_authorizations")} upload
            SET state = 'consumed', consumed_at = $3::timestamptz, consumed_contribution_id = $2,
                consume_lease_expires_at = NULL
          WHERE upload.id = $1 AND upload.state = 'consuming'
            AND upload.consume_lease_expires_at > $3::timestamptz AND upload.expires_at > $3::timestamptz
            AND (NOT EXISTS (SELECT 1 FROM ${table(schema, "device_credentials")} device
                   WHERE device.id = upload.issued_by_device_id AND device.authority_kind = 'accountless')
                 OR ${accountlessAuthority})`,
        [authorizationId, contributionId, nowIso],
      );
      if (updated.rowCount === 1) return;
      const existing = await client.query<{ state: string; consumed_contribution_id: string | null }>(
        `SELECT state, consumed_contribution_id FROM ${table(schema, "device_upload_authorizations")}
          WHERE id = $1`,
        [authorizationId],
      );
      const row = existing.rows[0];
      if (row?.state !== "consumed" || row.consumed_contribution_id !== contributionId) {
        throw new ApiError(401, "UPLOAD_AUTH_INVALID");
      }
    }, { operation: "device_upload.receipt", preserveSafeError });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unavailable();
  }
}

// ---------------------------------------------------------------------------
// telemetry-envelope-v0.1: handleTelemetryContribution (src/index.ts at
// d43c8f92) with insertTelemetryContribution (telemetry-repository.ts) and the
// D1 insert triggers on telemetry_contributions as explicit steps. The weekly
// admission window is enforced by the staged legacy_contribution_admission
// migration's triggers, exactly as D1 migrations/0014 does.
//
// Deliberate differences, each a refusal:
//   - The account-scoped (v0.2 consent) branch answers the Worker's deployed
//     refusal, 503 ACCOUNT_SCOPED_INGEST_DISABLED: production never runs the
//     loopback-only local preview it requires, and the origin cannot.
//   - A replayed contribution whose accounting step never finished
//     (accepted_record_count NULL, repaired from its records by D1) is
//     refused with 503 instead of being repaired; a PostgreSQL admission
//     commits header, records and accounting in one transaction, so only an
//     imported row can be in that state.
// ---------------------------------------------------------------------------

export const POSTGRES_TELEMETRY_V01_PENDING_OBJECT_KIND = "telemetry";

interface V01ReplayRow {
  id: string;
  status: string;
  declared_record_count: number;
  accepted_record_count: number | null;
}

function v01ReplayResponse(row: V01ReplayRow): Response {
  if (row.accepted_record_count === null) throw unavailable();
  const declared = safeInteger(row.declared_record_count);
  const accepted = safeInteger(row.accepted_record_count);
  return jsonResponse({
    contributionId: row.id,
    status: row.status,
    replayed: true,
    recordCounts: { declared, accepted, deduplicated: declared - accepted },
    accountingVerification: "server_repriced",
  }, 202, { "idempotency-replayed": "true" });
}

async function v01ContributionByDigest(
  client: PostgresClient, schema: string, participantId: string, digest: string,
  kind: "plaintext" | "envelope",
): Promise<V01ReplayRow | null> {
  const column = kind === "plaintext" ? "plaintext_digest" : "envelope_digest";
  const result = await client.query<V01ReplayRow>(
    `SELECT id, status, declared_record_count, accepted_record_count
       FROM ${table(schema, "telemetry_contributions")}
      WHERE participant_id = $1 AND ${column} = $2`,
    [participantId, digest],
  );
  return result.rows[0] ?? null;
}

/** Port of telemetryContributionAdmission (telemetry-repository.ts). */
async function v01Admission(
  client: PostgresClient, schema: string, participantId: string, nowEpoch: number,
): Promise<TelemetryContributionAdmission> {
  const window = telemetryContributionAdmissionWindow(nowEpoch);
  const result = await client.query<{ accepted_count: number }>(
    `SELECT accepted_count FROM ${table(schema, "telemetry_contribution_admission_windows")}
      WHERE participant_id = $1 AND window_started_at = $2::timestamptz`,
    [participantId, window.startsAt],
  );
  const acceptedBatches = Math.max(0, Math.min(MAX_TELEMETRY_CONTRIBUTIONS_PER_ADMISSION_WINDOW,
    Number(result.rows[0]?.accepted_count ?? 0)));
  const remainingBatches = Math.max(0, MAX_TELEMETRY_CONTRIBUTIONS_PER_ADMISSION_WINDOW - acceptedBatches);
  return {
    schemaVersion: "telemetry-contribution-admission-v0.1",
    state: remainingBatches > 0 ? "available" : "exhausted",
    window: {
      kind: "fixed_utc",
      anchor: "monday_00_00_utc",
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      durationMilliseconds: TELEMETRY_CONTRIBUTION_ADMISSION_WINDOW_MILLISECONDS,
    },
    acceptedBatches,
    remainingBatches,
    maximumBatches: MAX_TELEMETRY_CONTRIBUTIONS_PER_ADMISSION_WINDOW,
    slotRefundPolicy: "not_refunded_by_contribution_deletion",
  };
}

/** Port of telemetryContributionLimitError (src/index.ts, private there). */
function v01LimitError(admission: TelemetryContributionAdmission, nowEpoch = Date.now()): ApiError {
  const retryAtEpoch = Date.parse(admission.window.endsAt);
  const retryAfterSeconds = Number.isFinite(retryAtEpoch)
    ? Math.max(1, Math.ceil((retryAtEpoch - nowEpoch) / 1000))
    : 1;
  return new ApiError(429, "CONTRIBUTION_LIMIT_REACHED", {
    publicDetails: { admission, retryAt: admission.window.endsAt },
    responseHeaders: { "retry-after": String(retryAfterSeconds) },
  });
}

/** The D1 per-statement server-price totals (storedServerPricingTotals). */
function v01StoredPricingTotals(serverPricing: readonly ServerPricingResult[], stored: readonly boolean[]) {
  let costNanousd = 0;
  let fullyPricedEvents = 0;
  let partiallyPricedEvents = 0;
  let unpricedEvents = 0;
  const priceBases = new Set<string>();
  const priceEpochBases = new Set<string>();
  const eventTimes: string[] = [];
  let missingEventTime = false;
  for (const [index, pricing] of serverPricing.entries()) {
    if (!stored[index]) continue;
    costNanousd += pricing.costNanousd;
    if (pricing.coverageStatus === "fully_priced") fullyPricedEvents += 1;
    else if (pricing.coverageStatus === "partially_priced") partiallyPricedEvents += 1;
    else unpricedEvents += 1;
    priceBases.add(pricing.priceBasis);
    priceEpochBases.add(pricing.priceEpochBasis);
    if (pricing.priceEventTime === null) missingEventTime = true;
    else eventTimes.push(pricing.priceEventTime);
  }
  eventTimes.sort();
  return {
    costNanousd, fullyPricedEvents, partiallyPricedEvents, unpricedEvents,
    priceBasis: priceBases.size === 0 ? "unpriced" : priceBases.size === 1 ? [...priceBases][0]! : "mixed_api_prices",
    priceEpochBasis: priceEpochBases.size === 1 ? [...priceEpochBases][0]! : null,
    eventTimeStart: missingEventTime ? null : eventTimes[0] ?? null,
    eventTimeEnd: missingEventTime ? null : eventTimes.at(-1) ?? null,
  };
}

interface V01PersistInput {
  readonly principal: PostgresTelemetryV1Principal;
  readonly authorizationId: string;
  readonly contributionId: string;
  readonly r2Key: string;
  readonly envelopeDigest: string;
  readonly plaintextDigest: string;
  readonly record: TelemetryContribution;
  readonly createdAt: string;
  readonly nowEpoch: number;
}

class V01AdmissionWindowExhausted extends Error {}

/**
 * The D1 batch plus its accounting UPDATE as one PostgreSQL transaction.
 * D1's BEFORE INSERT guards run first under row locks: active social
 * participant, consuming device grant, participant-floor transport check
 * (telemetry_transport_legacy_insert reads only the participant floor) and
 * the pending-object reconciliation fence; its AFTER INSERT effects follow:
 * grant consumption and the pending registration cleared.
 */
async function persistV01Contribution(
  client: PostgresClient, schema: string, input: V01PersistInput,
): Promise<{ acceptedRecords: number; deduplicatedRecords: number }> {
  const { principal, record } = input;
  const nowIso = new Date(input.nowEpoch).toISOString();
  const participant = await client.query<{ state: string; owner_kind: string }>(
    `SELECT state, owner_kind FROM ${table(schema, "participants")} WHERE id = $1 FOR UPDATE`,
    [principal.participantId],
  );
  if (participant.rows[0]?.state !== "active" || participant.rows[0]?.owner_kind !== "social") {
    throw new ApiError(409, "PARTICIPANT_DELETING");
  }
  const grant = await client.query<{ id: string }>(
    `SELECT id FROM ${table(schema, "device_upload_authorizations")}
      WHERE id = $1 AND participant_id = $2 AND issued_by_device_id = $3 AND state = 'consuming'
        AND consume_lease_expires_at > $4::timestamptz AND expires_at > $4::timestamptz
      FOR UPDATE`,
    [input.authorizationId, principal.participantId, principal.deviceId, nowIso],
  );
  if (grant.rows.length !== 1) throw uploadUnavailable();
  const floor = await client.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM ${table(schema, "telemetry_transport_formats")} format_row
         JOIN ${table(schema, "telemetry_transport_participant_floors")} floor_row
           ON floor_row.participant_id = $1
        WHERE format_row.schema_version = 'telemetry-contribution-v0.1'
          AND format_row.lifecycle = 'accepted' AND format_row.format_rank >= floor_row.minimum_rank
     ) AS allowed`,
    [principal.participantId],
  );
  if (floor.rows[0]?.allowed !== true) throw new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED");
  const pending = await client.query<{ object_key: string; reconciliation_state: string }>(
    `SELECT object_key, reconciliation_state FROM ${table(schema, "pending_objects")}
      WHERE contribution_id = $1 FOR UPDATE`,
    [input.contributionId],
  );
  if (pending.rows[0]?.object_key !== input.r2Key || pending.rows[0]?.reconciliation_state !== "registered") {
    throw unavailable();
  }

  const declared = record.usageEvents.length + record.quotaSnapshots.length + record.activityMarkers.length;
  try {
    await client.query(
      `INSERT INTO ${table(schema, "telemetry_contributions")} (
         id, participant_id, plaintext_digest, envelope_digest, r2_key, status, schema_version,
         range_start, range_end, client_platform, provider_policy_epoch, estimated_api_cost_usd,
         priced_event_coverage_percent, unknown_model_event_count, unknown_billable_units, price_basis,
         declared_record_count, created_at, upload_authorization_id, device_upload_authorization_id,
         transport_schema_version
       ) VALUES ($1, $2, $3, $4, $5, 'accepted', $6, $7::timestamptz, $8::timestamptz, $9, $10, $11,
         $12, $13, $14, $15, $16, $17::timestamptz, NULL, $18, 'telemetry-contribution-v0.1')`,
      [input.contributionId, principal.participantId, input.plaintextDigest, input.envelopeDigest, input.r2Key,
        record.schemaVersion, record.coveredAt.startAt, record.coveredAt.endAt, record.clientPlatform,
        record.providerPolicyEpoch, record.accounting.estimatedApiCostUsd,
        record.accounting.pricedEventCoveragePercent, record.accounting.unknownModelEventCount,
        record.accounting.unknownBillableUnits, record.accounting.priceBasis, declared, input.createdAt,
        input.authorizationId],
    );
  } catch (error) {
    // The staged window trigger (D1 0014) raises a constant P1003.
    if (error !== null && typeof error === "object" && Reflect.get(error, "code") === "P1003") {
      throw new V01AdmissionWindowExhausted();
    }
    throw error;
  }

  const serverPricing = record.usageEvents.map(priceTelemetryUsageEvent);
  const stored: boolean[] = [];
  const occurrence = async (kind: string, occurrenceId: string) => {
    await client.query(
      `INSERT INTO ${table(schema, "telemetry_contribution_occurrences")}
         (contribution_id, participant_id, record_kind, occurrence_id, dataset_id, account_track_id, policy_epoch)
       VALUES ($1, $2, $3, $4, NULL, 'unattributed', NULL)`,
      [input.contributionId, principal.participantId, kind, occurrenceId],
    );
  };
  for (const [index, row] of record.usageEvents.entries()) {
    const pricing = serverPricing[index]!;
    const inserted = await client.query(
      `INSERT INTO ${table(schema, "telemetry_records")} (
         origin_contribution_id, participant_id, record_kind, occurrence_id, observed_at, provider, model_id,
         model_fingerprint, speed_mode, api_service_tier, surface, billing_surface, total_input_context_tokens,
         reasoning_effort, agent_scope, input_uncached_tokens, input_cache_read_tokens, input_cache_write_tokens,
         output_text_tokens, output_reasoning_tokens, output_combined_tokens, tool_units, estimated_api_cost_usd,
         pricing_coverage_percent, unknown_billable_units, server_cost_usd, server_cost_nanousd,
         server_pricing_coverage_percent, server_unknown_billable_units, server_pricing_status,
         server_pricing_method_version, server_price_registry_version, server_price_registry_sha256,
         server_price_card_ids, server_unpriced_reason_codes, server_price_epoch_basis, server_tier_basis,
         server_api_service_tier, server_price_basis, server_price_event_time, dataset_id, account_track_id,
         policy_epoch, record_json
       ) VALUES ($1, $2, 'usage', $3, $4::timestamptz, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
         $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33::jsonb, $34::jsonb,
         $35, $36, $37, $38, $39::timestamptz, NULL, 'unattributed', NULL, $40::jsonb)
       ON CONFLICT (participant_id, record_kind, occurrence_id) DO NOTHING`,
      [input.contributionId, principal.participantId, row.eventId, row.eventTime, row.provider, row.modelId,
        row.modelFingerprint, row.speedMode, row.apiServiceTier, row.surface, row.billingSurface,
        row.totalInputContextTokens ?? null, row.reasoningEffort, row.agentScope,
        row.components.inputUncachedTokens ?? null, row.components.inputCacheReadTokens ?? null,
        row.components.inputCacheWriteTokens ?? null, row.components.outputTextTokens ?? null,
        row.components.outputReasoningTokens ?? null, row.components.outputCombinedTokens ?? null,
        Object.values(row.toolClassCounts).reduce((sum, value) => sum + value, 0),
        row.accounting.estimatedApiCostUsd, row.accounting.pricingCoveragePercent,
        row.accounting.unknownBillableUnits, pricing.exactCostUsd, pricing.costNanousd, pricing.coveragePercent,
        pricing.unknownBillableUnits, pricing.coverageStatus, pricing.methodVersion, pricing.registryVersion,
        pricing.registrySha256, canonicalJson(pricing.selectedPriceCardIds),
        canonicalJson(pricing.unpricedReasonCodes), pricing.priceEpochBasis, pricing.tierBasis,
        pricing.apiServiceTier, pricing.priceBasis, pricing.priceEventTime, canonicalJson(row)],
    );
    stored.push(inserted.rowCount === 1);
    await occurrence("usage", row.eventId);
  }
  for (const row of record.quotaSnapshots) {
    const inserted = await client.query(
      `INSERT INTO ${table(schema, "telemetry_records")} (
         origin_contribution_id, participant_id, record_kind, occurrence_id, observed_at, provider, plan_type,
         plan_variant, limit_id, slot, used_percent, window_duration_minutes, resets_at, dataset_id,
         account_track_id, policy_epoch, record_json
       ) VALUES ($1, $2, 'quota', $3, $4::timestamptz, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, NULL,
         'unattributed', NULL, $13::jsonb)
       ON CONFLICT (participant_id, record_kind, occurrence_id) DO NOTHING`,
      [input.contributionId, principal.participantId, row.snapshotId, row.observedTime, row.provider,
        row.planType, row.planVariant, row.limitId, row.slot, row.usedPercent, row.windowDurationMinutes,
        row.resetsAt, canonicalJson(row)],
    );
    stored.push(inserted.rowCount === 1);
    await occurrence("quota", row.snapshotId);
  }
  for (const row of record.activityMarkers) {
    const inserted = await client.query(
      `INSERT INTO ${table(schema, "telemetry_records")} (
         origin_contribution_id, participant_id, record_kind, occurrence_id, observed_at, surface, plan_type,
         plan_variant, dataset_id, account_track_id, policy_epoch, record_json
       ) VALUES ($1, $2, 'activity', $3, $4::timestamptz, $5, $6, $7, NULL, 'unattributed', NULL, $8::jsonb)
       ON CONFLICT (participant_id, record_kind, occurrence_id) DO NOTHING`,
      [input.contributionId, principal.participantId, row.markerId, row.observedTime, row.surface,
        row.planType, row.planVariant, canonicalJson(row)],
    );
    stored.push(inserted.rowCount === 1);
    await occurrence("activity", row.markerId);
  }
  const acceptedRecords = stored.filter(Boolean).length;
  const accounting = v01StoredPricingTotals(serverPricing, stored.slice(0, serverPricing.length));
  const updated = await client.query(
    `UPDATE ${table(schema, "telemetry_contributions")}
        SET server_cost_nanousd = $1, server_priced_event_count = $2,
            server_partially_priced_event_count = $3, server_unpriced_event_count = $4,
            server_pricing_method_version = $5, server_price_registry_version = $6,
            server_price_registry_sha256 = $7, server_price_basis = $8, server_price_epoch_basis = $9,
            server_price_event_time_start = $10::timestamptz, server_price_event_time_end = $11::timestamptz,
            accepted_record_count = $12
      WHERE id = $13 AND participant_id = $14`,
    [accounting.costNanousd, accounting.fullyPricedEvents, accounting.partiallyPricedEvents,
      accounting.unpricedEvents, serverPricing[0]?.methodVersion ?? null, serverPricing[0]?.registryVersion ?? null,
      serverPricing[0]?.registrySha256 ?? null, accounting.priceBasis, accounting.priceEpochBasis,
      accounting.eventTimeStart, accounting.eventTimeEnd, acceptedRecords, input.contributionId,
      principal.participantId],
  );
  if (updated.rowCount !== 1) throw unavailable();
  // D1 telemetry_contributions_consume_device_upload and
  // telemetry_contributions_clear_pending_quarantine.
  const consumed = await client.query(
    `UPDATE ${table(schema, "device_upload_authorizations")}
        SET state = 'consumed', consumed_at = $2::timestamptz, consume_lease_expires_at = NULL,
            consumed_contribution_id = $3
      WHERE id = $1 AND participant_id = $4 AND state = 'consuming'`,
    [input.authorizationId, input.createdAt, input.contributionId, principal.participantId],
  );
  if (consumed.rowCount !== 1) throw uploadUnavailable();
  await client.query(
    `DELETE FROM ${table(schema, "pending_objects")}
      WHERE contribution_id = $1 AND object_key = $2 AND reconciliation_state = 'registered'`,
    [input.contributionId, input.r2Key],
  );
  return { acceptedRecords, deduplicatedRecords: declared - acceptedRecords };
}

/**
 * telemetry-envelope-v0.1 after the shared preamble: the port of
 * handleTelemetryContribution (src/index.ts at d43c8f92). Returns the
 * Worker's 202 receipt (fresh or replayed) or throws the Worker's ApiError.
 */
export async function admitPostgresTelemetryV01Contribution(
  input: Omit<PostgresTelemetryV1ContributionInput, "sourceNamespace">,
): Promise<Response> {
  const nowEpoch = requestEpoch(input.nowEpoch);
  const schemaConfig: PostgresSchemaConfig = createPostgresSchemaConfig(input.schema ?? {});
  const schema = schemaName(schemaConfig);
  const { pool, objectStore } = input;
  if (input.participant.consentVersion === ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION) {
    // assertAccountScopedLocalPreview outside ACCOUNT_SCOPED_INGEST_MODE=local_preview.
    throw new ApiError(503, "ACCOUNT_SCOPED_INGEST_DISABLED");
  }
  if (input.participant.consentVersion !== TELEMETRY_CONSENT_VERSION) {
    throw new ApiError(400, "TELEMETRY_REQUIRED");
  }
  if (typeof input.deviceId !== "string" || input.deviceId.length < 1) throw uploadUnavailable();
  const principal: PostgresTelemetryV1Principal = Object.freeze({
    participantId: input.participant.id, deviceId: input.deviceId,
  });
  await assertPostgresTelemetryTransportWriteAllowed(pool, principal, "telemetry-contribution-v0.1",
    { schema: schemaConfig, nowEpoch });
  const envelope = validateTelemetryEnvelope(input.body.value);
  const envelopeDigest = await telemetryEnvelopeDigest(envelope);
  const envelopeReplay = await withPostgresRead(pool,
    (client) => v01ContributionByDigest(client, schema, principal.participantId, envelopeDigest, "envelope"),
    { operation: "telemetry_v01.envelope_replay", preserveSafeError });
  if (envelopeReplay) return v01ReplayResponse(envelopeReplay);
  const admission = await withPostgresRead(pool,
    (client) => v01Admission(client, schema, principal.participantId, nowEpoch),
    { operation: "telemetry_v01.admission", preserveSafeError });
  if (admission.state === "exhausted") throw v01LimitError(admission, nowEpoch);

  const plaintext = await decryptSyntheticEnvelope(envelope, input.envelopePublicJwk, input.envelopePrivateJwk);
  const record = validateTelemetryContribution(plaintext);
  const plaintextDigest = await sha256Hex(canonicalJson(record));
  const contentReplay = await withPostgresRead(pool,
    (client) => v01ContributionByDigest(client, schema, principal.participantId, plaintextDigest, "plaintext"),
    { operation: "telemetry_v01.content_replay", preserveSafeError });
  if (contentReplay) return v01ReplayResponse(contentReplay);

  const contributionId = `contribution:${crypto.randomUUID()}`;
  const r2Key = `telemetry/${crypto.randomUUID()}`;
  const createdAt = new Date(nowEpoch).toISOString();
  await registerPendingObjectOfKind(pool, schema, contributionId, r2Key, createdAt,
    POSTGRES_TELEMETRY_V01_PENDING_OBJECT_KIND);
  try {
    await objectStore.put(r2Key, JSON.stringify(envelope), {
      contentType: "application/json",
      customMetadata: {
        contributionId,
        schemaVersion: envelope.schemaVersion,
        plaintextSchemaVersion: record.schemaVersion,
        synthetic: "false",
      },
    });
  } catch {
    throw unavailable();
  }
  let result: { acceptedRecords: number; deduplicatedRecords: number };
  try {
    result = await withPostgresMutation(pool, (client) => persistV01Contribution(client, schema, {
      principal, authorizationId: input.authorization.authorizationId, contributionId, r2Key, envelopeDigest,
      plaintextDigest, record, createdAt, nowEpoch,
    }), {
      operation: "telemetry_v01.admit",
      isolationLevel: "read_committed",
      statementTimeoutMilliseconds: 60_000,
      lockTimeoutMilliseconds: 5_000,
      preserveSafeError: (error) => error instanceof V01AdmissionWindowExhausted ? error : preserveSafeError(error),
    });
  } catch (error) {
    // A committed write whose acknowledgement was lost is answered from the
    // canonical row; only a completed lookup with no row allows cleanup.
    let replay: V01ReplayRow | null;
    try {
      replay = await withPostgresRead(pool,
        (client) => v01ContributionByDigest(client, schema, principal.participantId, plaintextDigest, "plaintext"),
        { operation: "telemetry_v01.recover", preserveSafeError });
    } catch {
      throw unavailable();
    }
    if (replay) return v01ReplayResponse(replay);
    try {
      await retireUnreferencedObjectOfKind(pool, schema, objectStore, {
        chunkRowId: contributionId, objectKey: r2Key, authorizationId: input.authorization.authorizationId,
      }, POSTGRES_TELEMETRY_V01_PENDING_OBJECT_KIND, "telemetry_contributions");
    } catch { /* the durable pending row stays the reconciliation journal */ }
    let retryAdmission: TelemetryContributionAdmission;
    try {
      retryAdmission = await withPostgresRead(pool,
        (client) => v01Admission(client, schema, principal.participantId, Date.now()),
        { operation: "telemetry_v01.admission_retry", preserveSafeError });
    } catch {
      throw unavailable();
    }
    if (retryAdmission.state === "exhausted") throw v01LimitError(retryAdmission);
    if (error instanceof ApiError) throw error;
    throw unavailable();
  }
  return jsonResponse({
    contributionId,
    status: "accepted",
    recordCounts: {
      usageEvents: record.usageEvents.length,
      quotaSnapshots: record.quotaSnapshots.length,
      activityMarkers: record.activityMarkers.length,
      accepted: result.acceptedRecords,
      deduplicated: result.deduplicatedRecords,
    },
    accountingVerification: "server_repriced",
  }, 202);
}
