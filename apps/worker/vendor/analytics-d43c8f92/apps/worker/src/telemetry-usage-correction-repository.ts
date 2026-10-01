import {
  canonicalTelemetryV11Json,
} from "@app-usagemonitor/telemetry-contract";
import { decodeTypedTelemetryId, encodeTypedTelemetryId, typedTelemetryIdSql } from "./typed-telemetry-codec";
import { readTypedTelemetryRowsByStorageIds } from "./typed-telemetry-compatibility";
import {
  prepareUsageCorrectionAssertion,
  USAGE_TOTAL_CORRECTION_METHOD,
  type UsageCorrectionAssertion,
  type UsageCorrectionFormat,
} from "./telemetry-usage-reconciliation";

export const TELEMETRY_USAGE_CORRECTION_RUNTIME_TABLE = "telemetry_usage_correction_runtime";
export const TELEMETRY_USAGE_CORRECTION_HISTORY_TABLE = "telemetry_usage_correction_history";
export const TELEMETRY_USAGE_CORRECTION_FACTS_TABLE = "telemetry_usage_correction_facts";
export const MAX_TELEMETRY_USAGE_CORRECTION_CAPTURE_ROWS = 200;
export const MAX_TELEMETRY_USAGE_CORRECTION_PAGE = 200;
/** Effective usage may collapse many immutable replacement facts into one
 * source variant before paging. The analytical reader still refuses a larger
 * distinct set instead of dropping contradictory evidence. */
export const MAX_TELEMETRY_USAGE_CORRECTION_SOURCE_VARIANTS = 3_200;
export const MAX_TELEMETRY_USAGE_CORRECTION_PAGE_BYTES = 1_250_000;
export const MAX_TELEMETRY_USAGE_CORRECTION_TRANSACTION_STATEMENTS = 900;
export const TELEMETRY_USAGE_CORRECTION_SCHEMA_VERSION = "telemetry-usage-correction-v1" as const;

const HEX64 = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SOURCE_FORMATS = new Set<UsageCorrectionFormat>(["v1", "v11", "v12"]);
const SOURCE_VIEW = "typed_telemetry_compatibility_records";
const TOKEN_BYTES_MAX = 16_384;
const TOKEN_MAX = 1_000_000_000_000;
const encoder = new TextEncoder();
// Capture performs one runtime read, one owner read, one JSON_each source-page
// read, and one JSON_each post-commit verification read in addition to its
// archive/fence batch. Keep those fixed calls inside the invocation budget.
const CORRECTION_CAPTURE_FIXED_READS = 4;
// The archive is one INSERT ... SELECT statement for the whole bounded page;
// its AFTER INSERT trigger creates one fact per row inside that same SQLite
// transaction. These are local work units, not D1 subrequest counts.
const CORRECTION_CAPTURE_ARCHIVE_STATEMENTS = 1;

export type TelemetryUsageCorrectionRepositoryErrorCode =
  | "TELEMETRY_USAGE_CORRECTION_UNAVAILABLE"
  | "TELEMETRY_USAGE_CORRECTION_NOT_ACTIVE"
  | "TELEMETRY_USAGE_CORRECTION_INVALID"
  | "TELEMETRY_USAGE_CORRECTION_LIMIT"
  | "TELEMETRY_USAGE_CORRECTION_SOURCE_UNAVAILABLE"
  | "TELEMETRY_USAGE_CORRECTION_SOURCE_MISMATCH"
  | "TELEMETRY_USAGE_CORRECTION_OWNER_CONFLICT"
  | "TELEMETRY_USAGE_CORRECTION_CAS_MISMATCH";

export class TelemetryUsageCorrectionRepositoryError extends Error {
  constructor(readonly code: TelemetryUsageCorrectionRepositoryErrorCode) {
    super(code);
    this.name = "TelemetryUsageCorrectionRepositoryError";
  }
}

export interface TelemetryUsageCorrectionSource {
  readonly participantId: string;
  /** Owner-scoped journal identity, never a device or contribution id. */
  readonly ownerDigest: string;
  readonly ownerRevision: number;
  readonly authorityEpoch: number;
  readonly sourceNamespace: string;
  /** Typed row id, retained only as a provenance reference. */
  readonly sourceStorageRowId: number;
  readonly sourceRowId: number;
  readonly sourceFormat: UsageCorrectionFormat;
  readonly sourceDeviceId: string;
  readonly sourceChunkId: string;
  readonly sourceManifestId: string | null;
  /** Maintained canonical record bytes from the source reader. */
  readonly recordJson: string;
  readonly capturedAt?: string;
}

export interface PreparedTelemetryUsageCorrectionCapture {
  readonly assertion: UsageCorrectionAssertion;
  /** Commits history, fact, CAS fences, and optional source retirement in one
   * bounded transaction. Raw source bytes are never rewritten here. */
  readonly commit: (retirementStatements?: readonly D1PreparedStatement[]) => Promise<UsageCorrectionAssertion>;
  readonly commitWithResults: (retirementStatements?: readonly D1PreparedStatement[]) => Promise<{
    readonly assertion: UsageCorrectionAssertion;
    readonly results: readonly D1Result<unknown>[];
  }>;
}

export interface PreparedTelemetryUsageCorrectionCaptureBatch {
  readonly assertions: readonly UsageCorrectionAssertion[];
  /** Commits every archive/fact pair plus optional source retirement in one
   * bounded transaction. Partial archive/fact batches are not exposed. */
  readonly commit: (retirementStatements?: readonly D1PreparedStatement[]) => Promise<readonly UsageCorrectionAssertion[]>;
  readonly commitWithResults: (retirementStatements?: readonly D1PreparedStatement[]) => Promise<{
    readonly assertions: readonly UsageCorrectionAssertion[];
    readonly results: readonly D1Result<unknown>[];
  }>;
}

export interface TelemetryUsageCorrectionHistoryRow {
  readonly id: number;
  readonly participantId: string;
  readonly ownerDigest: string;
  readonly ownerRevision: number;
  readonly authorityEpoch: number;
  readonly source: {
    readonly format: "v1" | "v11";
    readonly namespaceId: number;
    readonly ownerId: number;
    readonly deviceId: number;
    readonly chunkId: number;
    readonly manifestId: number | null;
    readonly storageRowId: number;
    readonly rowId: number;
    readonly occurrenceId: string;
    readonly eventTime: string;
    readonly chunkDigest: string;
    readonly eventDigest: string;
    readonly recordDigest: string;
    readonly baseDigest: string;
  };
  readonly usage: {
    readonly provider: string;
    readonly modelId: string;
    readonly sessionUuid: string;
    readonly speedMode: string;
    readonly apiServiceTier: string;
    readonly surface: string;
    readonly billingSurface: string;
    readonly reasoningEffort: string;
    readonly agentScope: string;
    readonly outcome: string;
    readonly accountBasis: string | null;
    readonly accountTrackId: string | null;
    readonly planBasis: string | null;
    readonly attributionPlanType: string | null;
    readonly planEraId: string | null;
    readonly totalInputContextTokens: number | null;
    readonly inputUncachedTokens: number | null;
    readonly inputCacheReadTokens: number | null;
    readonly inputCacheWriteTokens: number | null;
    readonly outputTextTokens: number | null;
    readonly outputReasoningTokens: number | null;
    readonly outputCombinedTokens: number | null;
  };
  /** Reconstructed and rehashed canonical source bytes. These are returned
   * only after the stored digest/base proof has been checked; callers must
   * treat them as analytical input, never as a replacement receipt. */
  readonly recordJson: string;
  readonly capturedAt: string;
}

export interface TelemetryUsageCorrectionFactRow {
  readonly id: number;
  readonly sourceHistoryId: number;
  readonly participantId: string;
  readonly ownerDigest: string;
  readonly ownerRevision: number;
  readonly authorityEpoch: number;
  readonly source: TelemetryUsageCorrectionHistoryRow["source"];
  readonly totalInputContextTokens: number | null;
  readonly outputCombinedTokens: number | null;
  /** Same verified canonical bytes as the corresponding history row. */
  readonly recordJson: string;
  readonly methodVersion: typeof USAGE_TOTAL_CORRECTION_METHOD;
  readonly capturedAt: string;
}

interface RuntimeRow {
  schema_version: typeof TELEMETRY_USAGE_CORRECTION_SCHEMA_VERSION;
  state: "staged" | "active";
  method_version: string;
  max_capture_rows: number;
  max_history_page: number;
}

interface OwnerRow {
  participant_id: string;
  owner_digest: string;
  state: "active" | "withdrawn" | "erased";
  revision: number;
  authority_epoch: number;
}

interface SourceRow {
  storage_row_id: number;
  source_namespace: string;
  format: UsageCorrectionFormat;
  format_code: number;
  source_row_id: number;
  participant_id: string;
  device_id: string;
  chunk_row_id: string;
  manifest_id: string | null;
  stream: "usage";
  occurrence_id: string;
  observed_at: string;
  provider: string;
  model_id: string;
  session_uuid: string;
  speed_mode: string;
  api_service_tier: string;
  surface: string;
  billing_surface: string;
  reasoning_effort: string;
  agent_scope: string;
  outcome: string;
  total_input_context_tokens: number | null;
  input_uncached_tokens: number | null;
  input_cache_read_tokens: number | null;
  input_cache_write_tokens: number | null;
  output_text_tokens: number | null;
  output_reasoning_tokens: number | null;
  output_combined_tokens: number | null;
  namespace_id: number;
  owner_id: number;
  device_storage_id: number;
  chunk_storage_id: number;
  manifest_storage_id: number | null;
  occurrence_blob: ArrayBuffer | Uint8Array;
  observed_at_ms: number;
  provider_id: number;
  session_id: number;
  model_storage_id: number;
  speed_mode_id: number;
  api_service_tier_id: number;
  surface_id: number;
  billing_surface_id: number;
  reasoning_effort_id: number;
  agent_scope_id: number;
  outcome_id: number;
  attribution_id: number | null;
  canonical_blob: ArrayBuffer | Uint8Array;
  canonical_sha256: string;
  source_chunk_digest: string;
  source_event_digest: string;
}

interface HistoryDbRow extends Record<string, unknown> {
  id: number;
  participant_id: string;
  owner_digest: ArrayBuffer | Uint8Array;
  owner_revision: number;
  authority_epoch: number;
  source_format: number;
  namespace_id: number;
  owner_id: number;
  device_id: number;
  chunk_id: number;
  manifest_id: number | null;
  source_storage_row_id: number;
  source_row_id: number;
  occurrence_id: ArrayBuffer | Uint8Array;
  event_time_ms: number;
  provider_value: string;
  session_blob: ArrayBuffer | Uint8Array;
  model_value: string;
  speed_mode_value: string;
  api_service_tier_value: string;
  surface_value: string;
  billing_surface_value: string;
  reasoning_effort_value: string;
  agent_scope_value: string;
  outcome_value: string;
  attribution_account_basis: number | null;
  attribution_account_track_blob: ArrayBuffer | Uint8Array | null;
  attribution_plan_basis: number | null;
  attribution_plan_type_value: string | null;
  attribution_plan_era_blob: ArrayBuffer | Uint8Array | null;
  total_input_context_tokens: number | null;
  input_uncached_tokens: number | null;
  input_cache_read_tokens: number | null;
  input_cache_write_tokens: number | null;
  output_text_tokens: number | null;
  output_reasoning_tokens: number | null;
  output_combined_tokens: number | null;
  source_chunk_digest: ArrayBuffer | Uint8Array;
  source_event_digest: ArrayBuffer | Uint8Array;
  record_digest: ArrayBuffer | Uint8Array;
  base_digest: ArrayBuffer | Uint8Array;
  captured_at_ms: number;
  fact_id?: number;
  fact_captured_at_ms?: number;
  fact_method_version?: number;
}

type Row = Record<string, unknown>;

function fail(code: TelemetryUsageCorrectionRepositoryErrorCode = "TELEMETRY_USAGE_CORRECTION_INVALID"): never {
  throw new TelemetryUsageCorrectionRepositoryError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) fail();
  return value;
}

function nullableText(value: unknown, max = 256): string | null {
  return value === null ? null : text(value, max);
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail();
  return value;
}

function nullableInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number | null {
  return value === null ? null : integer(value, minimum, maximum);
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) fail();
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !HEX64.test(value)) fail();
  return value;
}

function instant(value: unknown): string {
  if (typeof value !== "string" || !INSTANT.test(value) || new Date(value).toISOString() !== value) fail();
  return value;
}

function sourceFormat(value: unknown): UsageCorrectionFormat {
  if (typeof value !== "string" || !SOURCE_FORMATS.has(value as UsageCorrectionFormat)) fail();
  return value as UsageCorrectionFormat;
}

function formatCode(value: UsageCorrectionFormat): number {
  if (value === "v1") return 10;
  if (value === "v11") return 11;
  fail("TELEMETRY_USAGE_CORRECTION_SOURCE_UNAVAILABLE");
}

function formatName(value: unknown): "v1" | "v11" {
  if (value === 10) return "v1";
  if (value === 11) return "v11";
  fail("TELEMETRY_USAGE_CORRECTION_SOURCE_UNAVAILABLE");
}

function bytes(value: unknown, minimum = 1, maximum = 257): Uint8Array {
  const result = value instanceof ArrayBuffer ? new Uint8Array(value)
    : value instanceof Uint8Array ? value
      : Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
        ? Uint8Array.from(value as number[]) : null;
  if (!result || result.byteLength < minimum || result.byteLength > maximum) fail();
  return result;
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

function hex(value: unknown): string {
  return Array.from(bytes(value, 32, 32), (item) => item.toString(16).padStart(2, "0")).join("");
}

function digestBuffer(value: string): ArrayBuffer {
  if (!HEX64.test(value)) fail("TELEMETRY_USAGE_CORRECTION_INVALID");
  const result = new Uint8Array(32);
  for (let index = 0; index < result.length; index += 1) result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return result.buffer;
}

function validateSource(value: unknown): TelemetryUsageCorrectionSource {
  if (!isRecord(value)) fail();
  const required = ["authorityEpoch", "ownerDigest", "ownerRevision", "participantId", "recordJson",
    "sourceChunkId", "sourceDeviceId", "sourceFormat", "sourceManifestId", "sourceNamespace", "sourceRowId",
    "sourceStorageRowId"];
  const allowed = new Set([...required, "capturedAt"]);
  if (Object.keys(value).some((key) => !allowed.has(key))
      || required.some((key) => !Object.hasOwn(value, key))) fail();
  const sourceFormatValue = sourceFormat(value.sourceFormat);
  const recordJson = text(value.recordJson, TOKEN_BYTES_MAX);
  if (encoder.encode(recordJson).byteLength > TOKEN_BYTES_MAX) fail("TELEMETRY_USAGE_CORRECTION_LIMIT");
  const capturedAt = value.capturedAt === undefined ? new Date().toISOString() : instant(value.capturedAt);
  const manifestId = value.sourceManifestId === null ? null : identifier(value.sourceManifestId);
  if ((sourceFormatValue === "v1") !== (manifestId === null)) fail();
  return Object.freeze({
    participantId: identifier(value.participantId), ownerDigest: digest(value.ownerDigest),
    ownerRevision: integer(value.ownerRevision, 1, 0x7fffffff), authorityEpoch: integer(value.authorityEpoch, 1, 0x7fffffff),
    sourceNamespace: identifier(value.sourceNamespace), sourceStorageRowId: integer(value.sourceStorageRowId, 1),
    sourceRowId: integer(value.sourceRowId, 1), sourceFormat: sourceFormatValue, sourceDeviceId: identifier(value.sourceDeviceId),
    sourceChunkId: identifier(value.sourceChunkId), sourceManifestId: manifestId, recordJson, capturedAt,
  });
}

function validateRuntime(row: RuntimeRow | null, active: boolean): RuntimeRow {
  if (!row || row.schema_version !== TELEMETRY_USAGE_CORRECTION_SCHEMA_VERSION
      || row.method_version !== USAGE_TOTAL_CORRECTION_METHOD
      || (row.state !== "staged" && row.state !== "active")
      || !Number.isSafeInteger(row.max_capture_rows) || row.max_capture_rows < 1
      || row.max_capture_rows > MAX_TELEMETRY_USAGE_CORRECTION_CAPTURE_ROWS
      || !Number.isSafeInteger(row.max_history_page) || row.max_history_page < 1
      || row.max_history_page > MAX_TELEMETRY_USAGE_CORRECTION_PAGE) fail("TELEMETRY_USAGE_CORRECTION_UNAVAILABLE");
  if (active && row.state !== "active") fail("TELEMETRY_USAGE_CORRECTION_NOT_ACTIVE");
  return row;
}

async function runtime(db: D1Database, active = false): Promise<RuntimeRow> {
  try {
    return validateRuntime(await db.prepare(
      `SELECT schema_version,state,method_version,max_capture_rows,max_history_page
         FROM ${TELEMETRY_USAGE_CORRECTION_RUNTIME_TABLE} WHERE id=1`,
    ).first<RuntimeRow>(), active);
  } catch (error) {
    if (error instanceof TelemetryUsageCorrectionRepositoryError) throw error;
    fail("TELEMETRY_USAGE_CORRECTION_UNAVAILABLE");
  }
}

function ownerDigestValue(source: TelemetryUsageCorrectionSource): ArrayBuffer {
  return digestBuffer(source.ownerDigest);
}

async function owner(db: D1Database, source: TelemetryUsageCorrectionSource): Promise<OwnerRow> {
  try {
    const row = await db.prepare(
      `SELECT link.participant_id,link.owner_digest,link.state,owner.revision,owner.authority_epoch
        FROM storage_v11_owner_links link JOIN storage_owner_revisions owner
           ON owner.owner_digest=link.owner_digest
        WHERE link.participant_id=? AND link.owner_digest=?
          AND link.state='active' AND owner.state='active' LIMIT 2`,
    ).bind(source.participantId, source.ownerDigest).first<OwnerRow>();
    if (!row || row.participant_id !== source.participantId || row.owner_digest !== source.ownerDigest
        || row.state !== "active" || row.revision !== source.ownerRevision || row.authority_epoch !== source.authorityEpoch) {
      fail("TELEMETRY_USAGE_CORRECTION_OWNER_CONFLICT");
    }
    return row;
  } catch (error) {
    if (error instanceof TelemetryUsageCorrectionRepositoryError) throw error;
    fail("TELEMETRY_USAGE_CORRECTION_OWNER_CONFLICT");
  }
}

function validateLoadedSource(source: TelemetryUsageCorrectionSource, row: SourceRow): void {
  if (row.storage_row_id !== source.sourceStorageRowId || row.source_row_id !== source.sourceRowId
      || row.format !== source.sourceFormat || row.source_namespace !== source.sourceNamespace
      || row.participant_id !== source.participantId || row.device_id !== source.sourceDeviceId
      || row.chunk_row_id !== source.sourceChunkId || row.manifest_id !== source.sourceManifestId
      || row.stream !== "usage" || row.format_code !== formatCode(source.sourceFormat)
      || !HEX64.test(row.canonical_sha256) || !HEX64.test(row.source_chunk_digest)
      || !HEX64.test(row.source_event_digest)) fail("TELEMETRY_USAGE_CORRECTION_SOURCE_UNAVAILABLE");
}

/** The requested IDs are materialized before the compatibility view is joined.
 * This is the same bounded-page shape used by the typed reader: the view's
 * dictionary expansion is reached through a primary-key page, rather than
 * materializing every owner row before applying the requested source set.
 */
export const TELEMETRY_USAGE_CORRECTION_SOURCE_PAGE_SQL = `
  WITH requested(storage_row_id) AS MATERIALIZED (
    SELECT DISTINCT CAST(value AS INTEGER) FROM json_each(?)
  ),
  page AS MATERIALIZED (
    SELECT requested.storage_row_id
      FROM requested
      JOIN typed_telemetry_records raw ON raw.id=requested.storage_row_id
  )
  SELECT decoded.storage_row_id,decoded.source_namespace,decoded.format,decoded.format_code,
    decoded.source_row_id,decoded.participant_id,decoded.device_id,decoded.chunk_row_id,
    decoded.manifest_id,decoded.stream,decoded.occurrence_id,decoded.observed_at,
    decoded.provider,decoded.model_id,decoded.session_uuid,decoded.speed_mode,
    decoded.api_service_tier,decoded.surface,decoded.billing_surface,decoded.reasoning_effort,
    decoded.agent_scope,decoded.outcome,decoded.total_input_context_tokens,
    decoded.input_uncached_tokens,decoded.input_cache_read_tokens,decoded.input_cache_write_tokens,
    decoded.output_text_tokens,decoded.output_reasoning_tokens,decoded.output_combined_tokens,
    raw.namespace_id,raw.owner_id,raw.device_id AS device_storage_id,raw.chunk_id AS chunk_storage_id,
    raw.manifest_id AS manifest_storage_id,raw.occurrence_id AS occurrence_blob,
    raw.observed_at_ms,raw.provider_id,usage.session_id,usage.model_id AS model_storage_id,
    usage.speed_mode_id,usage.api_service_tier_id,usage.surface_id,usage.billing_surface_id,
    usage.reasoning_effort_id,usage.agent_scope_id,usage.outcome_id,usage.attribution_id,
    raw.canonical_digest AS canonical_blob,decoded.canonical_sha256,
    (SELECT chunk_digest FROM telemetry_v1_chunks chunk_digest_row
      WHERE chunk_digest_row.id=decoded.chunk_row_id) AS source_chunk_digest,
    (SELECT event_digest FROM typed_v1_event_sources event_digest_row
      WHERE event_digest_row.chunk_id=decoded.chunk_row_id
        AND event_digest_row.owner_digest=current_link.owner_digest) AS source_event_digest
  FROM page
  CROSS JOIN ${SOURCE_VIEW} decoded ON decoded.storage_row_id=page.storage_row_id
  JOIN typed_telemetry_records raw ON raw.id=page.storage_row_id
  JOIN typed_telemetry_usage usage ON usage.record_id=raw.id
  JOIN storage_v11_owner_links current_link
    ON current_link.participant_id=decoded.participant_id
   AND current_link.owner_digest=lower(?)
   AND current_link.state='active'
  JOIN storage_owner_revisions current_owner
    ON current_owner.owner_digest=current_link.owner_digest
   AND current_owner.state='active'
  WHERE decoded.participant_id=? AND decoded.source_namespace=?
    AND decoded.format_code=10 AND decoded.stream='usage'
    AND EXISTS (
      SELECT 1
        FROM typed_v1_record_admissions admission
        JOIN telemetry_v1_chunks current_chunk ON current_chunk.id=admission.chunk_id
        JOIN typed_v1_admission_state current_state
          ON current_state.id=1 AND current_state.runtime_contract_version=1
        JOIN typed_v1_event_sources current_event ON current_event.chunk_id=current_chunk.id
       WHERE admission.typed_record_id=raw.id
         AND current_chunk.id=decoded.chunk_row_id
         AND current_chunk.participant_id=decoded.participant_id
         AND current_chunk.device_id=decoded.device_id
         AND current_chunk.stream='usage'
         AND current_chunk.superseded_at IS NULL
         AND current_chunk.accepted_record_count=current_chunk.record_count
         AND current_chunk.record_count=(
           SELECT count(*) FROM typed_v1_record_admissions current_admission
            WHERE current_admission.chunk_id=current_chunk.id
         )
         AND current_state.source_namespace=decoded.source_namespace
         AND current_event.owner_digest=current_link.owner_digest
         AND current_event.source_namespace=decoded.source_namespace
         -- The owner head may point to a newer chunk; it is not the
         -- authority digest for every admitted unsuperseded chunk.
    )`;

/** Load a bounded page in one JSON_each query. The JSON value is one bind,
 * keeping the deployed D1 statement below its 100-bind limit even at 200
 * source rows. Each input source is checked against the returned durable row
 * after the query, so duplicate or mismatched requested identities fail closed.
 */
async function sourceRows(db: D1Database, sources: readonly TelemetryUsageCorrectionSource[]): Promise<SourceRow[]> {
  if (sources.some((source) => source.sourceFormat !== "v1")) {
    fail("TELEMETRY_USAGE_CORRECTION_SOURCE_UNAVAILABLE");
  }
  const first = sources[0]!;
  const requested = JSON.stringify(sources.map((source) => source.sourceStorageRowId));
  const requestedIds = new Set(sources.map((source) => source.sourceStorageRowId));
  try {
    const rows = (await db.prepare(TELEMETRY_USAGE_CORRECTION_SOURCE_PAGE_SQL)
      .bind(requested, first.ownerDigest, first.participantId, first.sourceNamespace).all<SourceRow>()).results;
    if (rows.length !== requestedIds.size) fail("TELEMETRY_USAGE_CORRECTION_SOURCE_UNAVAILABLE");
    const byStorageId = new Map(rows.map((row) => [row.storage_row_id, row]));
    return sources.map((source) => {
      const row = byStorageId.get(source.sourceStorageRowId);
      if (!row) fail("TELEMETRY_USAGE_CORRECTION_SOURCE_UNAVAILABLE");
      validateLoadedSource(source, row);
      return row;
    });
  } catch (error) {
    if (error instanceof TelemetryUsageCorrectionRepositoryError) throw error;
    fail("TELEMETRY_USAGE_CORRECTION_SOURCE_UNAVAILABLE");
  }
}

function validateAssertion(assertion: UsageCorrectionAssertion, row: SourceRow): void {
  if (!assertion || assertion.methodVersion !== USAGE_TOTAL_CORRECTION_METHOD
      || assertion.occurrenceId !== row.occurrence_id || assertion.eventTime !== row.observed_at
      || assertion.recordDigest !== row.canonical_sha256.toLowerCase()
      || !HEX64.test(assertion.baseDigest) || !HEX64.test(assertion.recordDigest)
      || assertion.totalInputContextTokens !== row.total_input_context_tokens
      || assertion.outputCombinedTokens !== row.output_combined_tokens) {
    fail("TELEMETRY_USAGE_CORRECTION_SOURCE_MISMATCH");
  }
}

function capturedAtMs(source: TelemetryUsageCorrectionSource): number {
  const value = Date.parse(source.capturedAt ?? "");
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) fail();
  return value;
}

function concatenatedDigestBlob(assertions: readonly UsageCorrectionAssertion[], rows: readonly SourceRow[]): ArrayBuffer {
  if (assertions.length !== rows.length || assertions.length < 1
      || assertions.length > MAX_TELEMETRY_USAGE_CORRECTION_CAPTURE_ROWS) fail("TELEMETRY_USAGE_CORRECTION_LIMIT");
  const result = new Uint8Array(assertions.length * 96);
  assertions.forEach((assertion, index) => {
    const source = rows[index]!;
    const chunk = new Uint8Array(digestBuffer(source.source_chunk_digest));
    const event = new Uint8Array(digestBuffer(source.source_event_digest));
    const base = new Uint8Array(digestBuffer(assertion.baseDigest));
    result.set(chunk, index * 96);
    result.set(event, index * 96 + 32);
    result.set(base, index * 96 + 64);
  });
  return result.buffer;
}

/** Insert a whole source page with one prepared statement. The digest blob is
 * positional (chunk, event, base, 32 bytes each), so SQLite needs no unhex
 * extension and the D1 bind count stays constant at the maximum page size.
 * The history trigger creates each corresponding fact in this transaction.
 */
function historyInsertPage(db: D1Database, sources: readonly TelemetryUsageCorrectionSource[],
  rows: readonly SourceRow[], assertions: readonly UsageCorrectionAssertion[]): D1PreparedStatement {
  const metadata = sources.map((source, index) => ({
    ordinal: index,
    participantId: source.participantId,
    sourceNamespace: source.sourceNamespace,
    sourceStorageRowId: source.sourceStorageRowId,
    sourceRowId: source.sourceRowId,
    sourceFormat: formatCode(source.sourceFormat),
    sourceDeviceId: source.sourceDeviceId,
    sourceChunkId: source.sourceChunkId,
    sourceManifestId: source.sourceManifestId,
    recordDigest: assertions[index]!.recordDigest,
    capturedAtMs: capturedAtMs(source),
  }));
  const first = sources[0]!;
  return db.prepare(`
    WITH requested AS MATERIALIZED (
      SELECT
        CAST(json_extract(value,'$.ordinal') AS INTEGER) AS ordinal,
        json_extract(value,'$.participantId') AS participant_id,
        json_extract(value,'$.sourceNamespace') AS source_namespace,
        CAST(json_extract(value,'$.sourceStorageRowId') AS INTEGER) AS source_storage_row_id,
        CAST(json_extract(value,'$.sourceRowId') AS INTEGER) AS source_row_id,
        CAST(json_extract(value,'$.sourceFormat') AS INTEGER) AS source_format,
        json_extract(value,'$.sourceDeviceId') AS source_device_id,
        json_extract(value,'$.sourceChunkId') AS source_chunk_id,
        json_extract(value,'$.sourceManifestId') AS source_manifest_id,
        lower(json_extract(value,'$.recordDigest')) AS record_digest,
        CAST(json_extract(value,'$.capturedAtMs') AS INTEGER) AS captured_at_ms
      FROM json_each(?)
    ),
    digests AS (SELECT ? AS digest_blob)
    INSERT INTO telemetry_usage_correction_history (
      participant_id,owner_digest,owner_revision,authority_epoch,source_format,namespace_id,owner_id,
      device_id,chunk_id,manifest_id,source_storage_row_id,source_row_id,occurrence_id,event_time_ms,
      provider_id,session_id,model_id,speed_mode_id,api_service_tier_id,surface_id,billing_surface_id,
      reasoning_effort_id,agent_scope_id,outcome_id,attribution_id,total_input_context_tokens,
      input_uncached_tokens,input_cache_read_tokens,input_cache_write_tokens,output_text_tokens,
      output_reasoning_tokens,output_combined_tokens,source_chunk_digest,source_event_digest,
      record_digest,base_digest,captured_at_ms
    )
    SELECT requested.participant_id,?, ?,?,requested.source_format,
      raw.namespace_id,raw.owner_id,raw.device_id,raw.chunk_id,raw.manifest_id,
      raw.id,raw.source_row_id,raw.occurrence_id,raw.observed_at_ms,raw.provider_id,usage.session_id,
      usage.model_id,usage.speed_mode_id,usage.api_service_tier_id,usage.surface_id,usage.billing_surface_id,
      usage.reasoning_effort_id,usage.agent_scope_id,usage.outcome_id,usage.attribution_id,
      usage.total_input_context_tokens,usage.input_uncached_tokens,usage.input_cache_read_tokens,
      usage.input_cache_write_tokens,usage.output_text_tokens,usage.output_reasoning_tokens,
      usage.output_combined_tokens,
      substr(digests.digest_blob,requested.ordinal * 96 + 1,32),
      substr(digests.digest_blob,requested.ordinal * 96 + 33,32),
      raw.canonical_digest,
      substr(digests.digest_blob,requested.ordinal * 96 + 65,32),
      requested.captured_at_ms
    FROM requested CROSS JOIN digests
    JOIN typed_telemetry_records raw ON raw.id=requested.source_storage_row_id
    JOIN typed_telemetry_usage usage ON usage.record_id=raw.id
    JOIN ${SOURCE_VIEW} decoded ON decoded.storage_row_id=raw.id
    WHERE raw.format=requested.source_format AND raw.source_row_id=requested.source_row_id
      AND decoded.stream='usage' AND decoded.source_namespace=requested.source_namespace
      AND decoded.participant_id=requested.participant_id AND decoded.device_id=requested.source_device_id
      AND decoded.chunk_row_id=requested.source_chunk_id
      AND decoded.manifest_id IS requested.source_manifest_id
      AND lower(decoded.canonical_sha256)=requested.record_digest
      AND lower(hex(raw.canonical_digest))=requested.record_digest
    ON CONFLICT DO NOTHING
  `).bind(JSON.stringify(metadata), concatenatedDigestBlob(assertions, rows),
    ownerDigestValue(first), first.ownerRevision, first.authorityEpoch);
}

interface PreparedCaptureContext {
  readonly sources: readonly TelemetryUsageCorrectionSource[];
  readonly rows: readonly SourceRow[];
  readonly assertions: readonly UsageCorrectionAssertion[];
  readonly statements: readonly D1PreparedStatement[];
  readonly runtimeState: RuntimeRow["state"];
  readonly invocationReadReserve: number;
}

function validateSourcePage(input: readonly TelemetryUsageCorrectionSource[]): TelemetryUsageCorrectionSource[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_TELEMETRY_USAGE_CORRECTION_CAPTURE_ROWS) {
    fail("TELEMETRY_USAGE_CORRECTION_LIMIT");
  }
  const sources = input.map((value) => validateSource(value));
  let bytesTotal = 0;
  for (const source of sources) {
    if (source.sourceFormat !== "v1") fail("TELEMETRY_USAGE_CORRECTION_SOURCE_UNAVAILABLE");
    bytesTotal += encoder.encode(source.recordJson).byteLength;
    if (bytesTotal > MAX_TELEMETRY_USAGE_CORRECTION_PAGE_BYTES) fail("TELEMETRY_USAGE_CORRECTION_LIMIT");
  }
  const first = sources[0]!;
  if (sources.some((source) => source.participantId !== first.participantId
      || source.ownerDigest !== first.ownerDigest
      || source.ownerRevision !== first.ownerRevision
      || source.authorityEpoch !== first.authorityEpoch
      || source.sourceNamespace !== first.sourceNamespace)) {
    fail("TELEMETRY_USAGE_CORRECTION_OWNER_CONFLICT");
  }
  return sources;
}

function casFence(db: D1Database, source: TelemetryUsageCorrectionSource,
  state: RuntimeRow["state"]): D1PreparedStatement {
  return db.prepare(`INSERT INTO telemetry_usage_correction_cas_guard(
      id,participant_id,owner_digest,owner_revision,authority_epoch,runtime_state
    ) VALUES(1,?,?,?,?,?)`).bind(
    source.participantId, ownerDigestValue(source), source.ownerRevision, source.authorityEpoch, state,
  );
}

function mapCaptureError(error: unknown): never {
  if (error instanceof TelemetryUsageCorrectionRepositoryError) throw error;
  const message = String(error);
  if (message.includes("telemetry_usage_correction_owner_conflict")) fail("TELEMETRY_USAGE_CORRECTION_OWNER_CONFLICT");
  if (message.includes("telemetry_usage_correction_source_proof")) fail("TELEMETRY_USAGE_CORRECTION_SOURCE_MISMATCH");
  if (message.includes("telemetry_usage_correction_unavailable")) fail("TELEMETRY_USAGE_CORRECTION_UNAVAILABLE");
  if (message.includes("telemetry_usage_correction_history_retained")
      || message.includes("telemetry_usage_correction_fact_retained")) fail("TELEMETRY_USAGE_CORRECTION_OWNER_CONFLICT");
  fail("TELEMETRY_USAGE_CORRECTION_CAS_MISMATCH");
}

async function verifyCapturedFacts(db: D1Database, context: PreparedCaptureContext): Promise<void> {
  const requestedRows = context.sources.map((source, index) => {
    const row = context.rows[index]!;
    const assertion = context.assertions[index]!;
    return {
      namespaceId: row.namespace_id, ownerId: row.owner_id,
      deviceId: row.device_storage_id, chunkId: row.chunk_storage_id, manifestId: row.manifest_storage_id,
      sourceRowId: row.source_row_id, sourceChunkDigest: row.source_chunk_digest,
      sourceEventDigest: row.source_event_digest, recordDigest: assertion.recordDigest,
      baseDigest: assertion.baseDigest,
    };
  });
  const expected = new Set(requestedRows.map((row) => JSON.stringify(row))).size;
  const first = context.sources[0]!;
  const rows = (await db.prepare(`
    WITH requested AS (
      SELECT DISTINCT
        CAST(json_extract(value,'$.namespaceId') AS INTEGER) AS namespace_id,
        CAST(json_extract(value,'$.ownerId') AS INTEGER) AS owner_id,
        CAST(json_extract(value,'$.deviceId') AS INTEGER) AS device_id,
        CAST(json_extract(value,'$.chunkId') AS INTEGER) AS chunk_id,
        CAST(json_extract(value,'$.manifestId') AS INTEGER) AS manifest_id,
        CAST(json_extract(value,'$.sourceRowId') AS INTEGER) AS source_row_id,
        lower(json_extract(value,'$.sourceChunkDigest')) AS source_chunk_digest,
        lower(json_extract(value,'$.sourceEventDigest')) AS source_event_digest,
        lower(json_extract(value,'$.recordDigest')) AS record_digest,
        lower(json_extract(value,'$.baseDigest')) AS base_digest
      FROM json_each(?)
    )
    SELECT h.id
      FROM requested r
      JOIN telemetry_usage_correction_history h
        ON h.participant_id=? AND h.owner_digest IS ?
       AND h.source_format=10
       AND h.namespace_id=r.namespace_id AND h.owner_id=r.owner_id AND h.device_id=r.device_id
       AND h.chunk_id=r.chunk_id AND h.manifest_id IS r.manifest_id AND h.source_row_id=r.source_row_id
       AND lower(hex(h.source_chunk_digest))=r.source_chunk_digest
       AND lower(hex(h.source_event_digest))=r.source_event_digest
       AND lower(hex(h.record_digest))=r.record_digest
       AND lower(hex(h.base_digest))=r.base_digest
      JOIN telemetry_usage_correction_facts f ON f.history_id=h.id AND f.method_version=1
  `).bind(JSON.stringify(requestedRows), first.participantId, ownerDigestValue(first)).all<{ id: number }>()).results;
  if (rows.length !== expected) fail("TELEMETRY_USAGE_CORRECTION_CAS_MISMATCH");
}

async function prepareCaptureContextFromRows(
  db: D1Database,
  sources: readonly TelemetryUsageCorrectionSource[],
  rows: readonly SourceRow[],
  state: RuntimeRow,
  invocationReadReserve = CORRECTION_CAPTURE_FIXED_READS,
): Promise<PreparedCaptureContext> {
  if (rows.length !== sources.length) fail("TELEMETRY_USAGE_CORRECTION_SOURCE_UNAVAILABLE");
  if (state.max_capture_rows < sources.length) fail("TELEMETRY_USAGE_CORRECTION_LIMIT");
  const assertions = await Promise.all(sources.map((source) =>
    prepareUsageCorrectionAssertion({ format: source.sourceFormat, recordJson: source.recordJson })));
  rows.forEach((row, index) => validateAssertion(assertions[index]!, row));
  const statements = [historyInsertPage(db, sources, rows, assertions)];
  return Object.freeze({ sources: Object.freeze([...sources]), rows: Object.freeze([...rows]),
    assertions: Object.freeze(assertions), statements: Object.freeze(statements), runtimeState: state.state,
    invocationReadReserve });
}

async function prepareCaptureContext(
  db: D1Database, input: readonly TelemetryUsageCorrectionSource[],
): Promise<PreparedCaptureContext> {
  const sources = validateSourcePage(input);
  const state = await runtime(db);
  if (state.max_capture_rows < sources.length) fail("TELEMETRY_USAGE_CORRECTION_LIMIT");
  const first = sources[0]!;
  // One owner read and one runtime read cover the whole bounded source page.
  await owner(db, first);
  const rows = await sourceRows(db, sources);
  return prepareCaptureContextFromRows(db, sources, rows, state);
}

async function commitCaptureContextWithResults(db: D1Database, context: PreparedCaptureContext,
  retirementStatements: readonly D1PreparedStatement[] = [], preserveCallerErrors = false): Promise<{
    readonly assertions: readonly UsageCorrectionAssertion[];
    readonly results: readonly D1Result<unknown>[];
  }> {
  if (!Array.isArray(retirementStatements)
      || context.statements.length + retirementStatements.length + 1 + context.invocationReadReserve
        > MAX_TELEMETRY_USAGE_CORRECTION_TRANSACTION_STATEMENTS) {
    fail("TELEMETRY_USAGE_CORRECTION_LIMIT");
  }
  let results: readonly D1Result<unknown>[];
  try {
    // These fences execute after every history/fact insert and immediately
    // before source retirement. D1 serializes the batch, so a changed owner or
    // runtime rolls back the complete archive/fact/retirement transaction.
    results = await db.batch([...context.statements, casFence(db, context.sources[0]!, context.runtimeState), ...retirementStatements]);
    if (results.some((result) => !result.success)) {
      if (preserveCallerErrors) throw new Error("telemetry_usage_correction_batch_failed");
      fail("TELEMETRY_USAGE_CORRECTION_CAS_MISMATCH");
    }
  } catch (error) {
    if (preserveCallerErrors && !(error instanceof TelemetryUsageCorrectionRepositoryError)
        && !String(error).includes("telemetry_usage_correction_")) throw error;
    mapCaptureError(error);
  }
  await verifyCapturedFacts(db, context);
  return { assertions: context.assertions, results: results!.slice(context.statements.length + 1) };
}

async function commitCaptureContext(db: D1Database, context: PreparedCaptureContext,
  retirementStatements: readonly D1PreparedStatement[] = []): Promise<readonly UsageCorrectionAssertion[]> {
  return (await commitCaptureContextWithResults(db, context, retirementStatements)).assertions;
}

/** Prepare a bounded, owner-scoped v1 source page. No partial statement list
 * is exposed; callers commit both archive and fact rows through `commit()`. */
export async function prepareTelemetryUsageCorrectionCaptureBatch(
  db: D1Database, input: readonly TelemetryUsageCorrectionSource[],
): Promise<PreparedTelemetryUsageCorrectionCaptureBatch> {
  const context = await prepareCaptureContext(db, input);
  return Object.freeze({ assertions: context.assertions,
    commit: (retirementStatements?: readonly D1PreparedStatement[]) =>
      commitCaptureContext(db, context, retirementStatements ?? []),
    commitWithResults: (retirementStatements?: readonly D1PreparedStatement[]) =>
      commitCaptureContextWithResults(db, context, retirementStatements ?? [], true) });
}

const CORRECTION_V1_REPLACEMENT_READ_RESERVE = 16;

interface V1ReplacementSourceRow {
  chunk_row_id: string;
  record_count: number;
  storage_row_id: number;
  source_row_id: number;
  participant_id: string;
  source_namespace: string;
  owner_digest: string;
  owner_revision: number;
  authority_epoch: number;
}

/**
 * Prepare the archive side of an actual typed-v1 supersession. The first query
 * resolves one admitted current chunk into at most 200 immutable storage row
 * ids; sourceRows then expands exactly that page through the compatibility
 * reader. A staged or absent migration keeps the existing writer path intact.
 * A present but malformed/newer runtime fails closed.
 */
export async function prepareTelemetryUsageCorrectionForV1Replacement(
  db: D1Database,
  input: { readonly participantId: string; readonly deviceId: string; readonly sourceNamespace: string; readonly chunkRowId: string },
): Promise<PreparedTelemetryUsageCorrectionCaptureBatch | null> {
  if (!isRecord(input)) fail();
  const scope = Object.freeze({
    participantId: identifier(input.participantId),
    deviceId: identifier(input.deviceId),
    sourceNamespace: identifier(input.sourceNamespace),
    chunkRowId: identifier(input.chunkRowId),
  });
  const runtimeTable = await db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`,
  ).bind(TELEMETRY_USAGE_CORRECTION_RUNTIME_TABLE).first<{ name: string }>();
  if (!runtimeTable) return null;
  const state = await runtime(db);
  if (state.state !== "active") return null;
  let current: V1ReplacementSourceRow[];
  try {
    current = (await db.prepare(`
      WITH current AS MATERIALIZED (
        SELECT chunk.id AS chunk_row_id,chunk.record_count,event.participant_id,event.source_namespace,
          event.owner_digest,owner.revision AS owner_revision,owner.authority_epoch
          FROM telemetry_v1_chunks chunk
          JOIN typed_v1_event_sources event ON event.chunk_id=chunk.id
          JOIN storage_v11_owner_links link
            ON link.participant_id=event.participant_id
           AND link.owner_digest=event.owner_digest AND link.state='active'
          JOIN storage_owner_revisions owner
            ON owner.owner_digest=event.owner_digest AND owner.state='active'
         WHERE chunk.id=? AND chunk.participant_id=? AND chunk.device_id=?
           AND chunk.stream='usage' AND chunk.superseded_at IS NULL
           AND chunk.record_count BETWEEN 1 AND 200
           AND chunk.accepted_record_count=chunk.record_count
           AND event.source_namespace=?
           AND chunk.record_count=(SELECT count(*) FROM typed_v1_record_admissions admitted
                                   WHERE admitted.chunk_id=chunk.id)
      ),
      page AS MATERIALIZED (
        SELECT current.chunk_row_id,current.record_count,current.participant_id,current.source_namespace,
          current.owner_digest,current.owner_revision,current.authority_epoch,
          admitted.typed_record_id AS storage_row_id,raw.source_row_id
          FROM current
          JOIN typed_v1_record_admissions admitted ON admitted.chunk_id=current.chunk_row_id
          JOIN typed_telemetry_records raw ON raw.id=admitted.typed_record_id
            AND raw.format=10 AND raw.stream=1
         ORDER BY admitted.typed_record_id LIMIT 201
      )
      SELECT * FROM page
    `).bind(scope.chunkRowId, scope.participantId, scope.deviceId, scope.sourceNamespace)
      .all<V1ReplacementSourceRow>()).results;
  } catch (error) {
    if (error instanceof TelemetryUsageCorrectionRepositoryError) throw error;
    fail("TELEMETRY_USAGE_CORRECTION_SOURCE_UNAVAILABLE");
  }
  if (current.length < 1 || current.length > MAX_TELEMETRY_USAGE_CORRECTION_CAPTURE_ROWS
      || current.some((row) => row.chunk_row_id !== scope.chunkRowId || row.record_count !== current.length
        || !Number.isSafeInteger(row.storage_row_id) || row.storage_row_id < 1)) {
    fail("TELEMETRY_USAGE_CORRECTION_SOURCE_UNAVAILABLE");
  }
  const first = current[0]!;
  const provisional = current.map((row) => ({
    participantId: row.participant_id, ownerDigest: row.owner_digest,
    ownerRevision: row.owner_revision, authorityEpoch: row.authority_epoch,
    sourceNamespace: row.source_namespace, sourceStorageRowId: row.storage_row_id,
    sourceRowId: row.source_row_id, sourceFormat: "v1" as const, sourceDeviceId: scope.deviceId,
    sourceChunkId: row.chunk_row_id, sourceManifestId: null, recordJson: "{}",
  }));
  const rows = await sourceRows(db, provisional);
  const decoded = await readTypedTelemetryRowsByStorageIds(db, {
    sourceNamespace: first.source_namespace,
    participantId: first.participant_id,
    storageRowIds: rows.map((row) => row.storage_row_id),
  });
  const decodedBySourceRowId = new Map(decoded.map((row) => [row.source_row_id, row]));
  const sources = validateSourcePage(rows.map((row, index) => ({
    ...provisional[index]!, sourceRowId: row.source_row_id,
    recordJson: decodedBySourceRowId.get(row.source_row_id)?.record_json ?? "",
  })));
  if (sources.length !== current.length || sources.some((source, index) =>
      source.sourceStorageRowId !== current[index]!.storage_row_id
      || source.sourceChunkId !== first.chunk_row_id
      || source.ownerDigest !== first.owner_digest
      || source.ownerRevision !== first.owner_revision
      || source.authorityEpoch !== first.authority_epoch)) {
    fail("TELEMETRY_USAGE_CORRECTION_SOURCE_MISMATCH");
  }
  const context = await prepareCaptureContextFromRows(
    db, sources, rows, state, CORRECTION_V1_REPLACEMENT_READ_RESERVE,
  );
  return Object.freeze({ assertions: context.assertions,
    commit: (retirementStatements?: readonly D1PreparedStatement[]) =>
      commitCaptureContext(db, context, retirementStatements ?? []),
    commitWithResults: (retirementStatements?: readonly D1PreparedStatement[]) =>
      commitCaptureContextWithResults(db, context, retirementStatements ?? [], true) });
}

export async function prepareTelemetryUsageCorrectionCapture(
  db: D1Database, input: TelemetryUsageCorrectionSource,
): Promise<PreparedTelemetryUsageCorrectionCapture> {
  const prepared = await prepareTelemetryUsageCorrectionCaptureBatch(db, [input]);
  return Object.freeze({ assertion: prepared.assertions[0]!,
    commit: async (retirementStatements?: readonly D1PreparedStatement[]) =>
      (await prepared.commit(retirementStatements))[0]!,
    commitWithResults: async (retirementStatements?: readonly D1PreparedStatement[]) => {
      const result = await prepared.commitWithResults(retirementStatements);
      return { assertion: result.assertions[0]!, results: result.results };
    } });
}

/** Capture one v1 source before optional retirement. All supplied retirement
 * statements run in the same bounded D1 transaction as archive and fact rows. */
export async function captureTelemetryUsageCorrectionBeforeDelete(
  db: D1Database, input: TelemetryUsageCorrectionSource,
  retirementStatements?: readonly D1PreparedStatement[],
): Promise<UsageCorrectionAssertion> {
  const prepared = await prepareTelemetryUsageCorrectionCapture(db, input);
  return prepared.commit(retirementStatements);
}

const HISTORY_COLUMNS = `
  h.*, provider.value AS provider_value, session.value AS session_blob,
    model.value AS model_value, speed.value AS speed_mode_value, tier.value AS api_service_tier_value,
    surface.value AS surface_value, billing.value AS billing_surface_value,
    effort.value AS reasoning_effort_value, scope.value AS agent_scope_value, outcome.value AS outcome_value,
    attribution.account_basis AS attribution_account_basis,
    attribution.account_track AS attribution_account_track_blob,
    attribution.plan_basis AS attribution_plan_basis,
    attribution_plan.value AS attribution_plan_type_value,
    attribution.plan_era AS attribution_plan_era_blob`;
const HISTORY_FROM = `
  FROM telemetry_usage_correction_history h
  JOIN typed_telemetry_dictionary provider ON provider.id=h.provider_id
  JOIN typed_telemetry_identifiers session ON session.id=h.session_id
  JOIN typed_telemetry_dictionary model ON model.id=h.model_id
  JOIN typed_telemetry_dictionary speed ON speed.id=h.speed_mode_id
  JOIN typed_telemetry_dictionary tier ON tier.id=h.api_service_tier_id
  JOIN typed_telemetry_dictionary surface ON surface.id=h.surface_id
  JOIN typed_telemetry_dictionary billing ON billing.id=h.billing_surface_id
  JOIN typed_telemetry_dictionary effort ON effort.id=h.reasoning_effort_id
  JOIN typed_telemetry_dictionary scope ON scope.id=h.agent_scope_id
  JOIN typed_telemetry_dictionary outcome ON outcome.id=h.outcome_id
  LEFT JOIN typed_telemetry_attributions attribution ON attribution.id=h.attribution_id
  LEFT JOIN typed_telemetry_dictionary attribution_plan ON attribution_plan.id=attribution.plan_type_id
`;

function nullableId(value: unknown): string | null {
  return value === null ? null : decodeTypedTelemetryId(bytes(value));
}

function usageRecord(row: HistoryDbRow): { format: "v1" | "v11"; recordJson: string } {
  const format = formatName(row.source_format);
  const record: Record<string, unknown> = {
    schemaVersion: format === "v1" ? "usage-event-v1.0" : "usage-event-v1.1",
    eventId: decodeTypedTelemetryId(bytes(row.occurrence_id)),
    eventTime: new Date(integer(row.event_time_ms, -8640000000000000, 8640000000000000)).toISOString(),
    sessionUuid: decodeTypedTelemetryId(bytes(row.session_blob)),
    provider: text(row.provider_value, 64), modelId: text(row.model_value, 64),
    speedMode: text(row.speed_mode_value, 64), apiServiceTier: text(row.api_service_tier_value, 64),
    surface: text(row.surface_value, 64), billingSurface: text(row.billing_surface_value, 64),
    reasoningEffort: text(row.reasoning_effort_value, 64), agentScope: text(row.agent_scope_value, 64),
    outcome: text(row.outcome_value, 64), totalInputContextTokens: nullableInteger(row.total_input_context_tokens, 0, TOKEN_MAX),
    components: {
      inputUncachedTokens: nullableInteger(row.input_uncached_tokens, 0, TOKEN_MAX),
      inputCacheReadTokens: nullableInteger(row.input_cache_read_tokens, 0, TOKEN_MAX),
      inputCacheWriteTokens: nullableInteger(row.input_cache_write_tokens, 0, TOKEN_MAX),
      outputTextTokens: nullableInteger(row.output_text_tokens, 0, TOKEN_MAX),
      outputReasoningTokens: nullableInteger(row.output_reasoning_tokens, 0, TOKEN_MAX),
      outputCombinedTokens: nullableInteger(row.output_combined_tokens, 0, TOKEN_MAX),
    },
  };
  if (format === "v11") {
    const accountBasis = ["unavailable", "same_source", "provisional_marker"][integer(row.attribution_account_basis, 0, 2)]!;
    const planBasis = ["unavailable", "same_source_occurrence", "provisional_marker", "conflicted"][integer(row.attribution_plan_basis, 0, 3)]!;
    record.accountPlanAttribution = {
      accountBasis, accountTrackId: nullableId(row.attribution_account_track_blob), planBasis,
      planType: text(row.attribution_plan_type_value, 64), planEraId: nullableId(row.attribution_plan_era_blob),
    };
  }
  return { format, recordJson: canonicalTelemetryV11Json(record) };
}

async function parseHistory(row: HistoryDbRow): Promise<TelemetryUsageCorrectionHistoryRow> {
  const format = formatName(row.source_format);
  const ownerDigest = hex(row.owner_digest), recordDigest = hex(row.record_digest), baseDigest = hex(row.base_digest);
  const rebuilt = usageRecord(row);
  const assertion = await prepareUsageCorrectionAssertion({ format, recordJson: rebuilt.recordJson });
  if (assertion.recordDigest !== recordDigest || assertion.baseDigest !== baseDigest) {
    fail("TELEMETRY_USAGE_CORRECTION_SOURCE_MISMATCH");
  }
  const result: TelemetryUsageCorrectionHistoryRow = {
    id: integer(row.id, 1), participantId: identifier(row.participant_id), ownerDigest,
    ownerRevision: integer(row.owner_revision, 1, 0x7fffffff), authorityEpoch: integer(row.authority_epoch, 1, 0x7fffffff),
    source: {
      format, namespaceId: integer(row.namespace_id, 1), ownerId: integer(row.owner_id, 1), deviceId: integer(row.device_id, 1),
      chunkId: integer(row.chunk_id, 1), manifestId: row.manifest_id === null ? null : integer(row.manifest_id, 1),
      storageRowId: integer(row.source_storage_row_id, 1), rowId: integer(row.source_row_id, 1),
      occurrenceId: decodeTypedTelemetryId(bytes(row.occurrence_id)), eventTime: rebuilt.recordJson
        ? JSON.parse(rebuilt.recordJson).eventTime as string : fail(),
      chunkDigest: hex(row.source_chunk_digest), eventDigest: hex(row.source_event_digest), recordDigest, baseDigest,
    },
    usage: {
      provider: text(row.provider_value, 64), modelId: text(row.model_value, 64), sessionUuid: decodeTypedTelemetryId(bytes(row.session_blob)),
      speedMode: text(row.speed_mode_value, 64), apiServiceTier: text(row.api_service_tier_value, 64),
      surface: text(row.surface_value, 64), billingSurface: text(row.billing_surface_value, 64),
      reasoningEffort: text(row.reasoning_effort_value, 64), agentScope: text(row.agent_scope_value, 64), outcome: text(row.outcome_value, 64),
      accountBasis: row.attribution_account_basis === null ? null : ["unavailable", "same_source", "provisional_marker"][integer(row.attribution_account_basis, 0, 2)]!,
      accountTrackId: nullableId(row.attribution_account_track_blob),
      planBasis: row.attribution_plan_basis === null ? null : ["unavailable", "same_source_occurrence", "provisional_marker", "conflicted"][integer(row.attribution_plan_basis, 0, 3)]!,
      attributionPlanType: nullableText(row.attribution_plan_type_value, 64), planEraId: nullableId(row.attribution_plan_era_blob),
      totalInputContextTokens: nullableInteger(row.total_input_context_tokens, 0, TOKEN_MAX),
      inputUncachedTokens: nullableInteger(row.input_uncached_tokens, 0, TOKEN_MAX), inputCacheReadTokens: nullableInteger(row.input_cache_read_tokens, 0, TOKEN_MAX),
      inputCacheWriteTokens: nullableInteger(row.input_cache_write_tokens, 0, TOKEN_MAX), outputTextTokens: nullableInteger(row.output_text_tokens, 0, TOKEN_MAX),
      outputReasoningTokens: nullableInteger(row.output_reasoning_tokens, 0, TOKEN_MAX), outputCombinedTokens: nullableInteger(row.output_combined_tokens, 0, TOKEN_MAX),
    },
    recordJson: rebuilt.recordJson,
    capturedAt: new Date(integer(row.captured_at_ms, 0, 8640000000000000)).toISOString(),
  };
  return Object.freeze(result);
}

async function parseFact(row: HistoryDbRow): Promise<TelemetryUsageCorrectionFactRow> {
  const history = await parseHistory(row);
  if (row.fact_id === undefined || row.fact_method_version !== 1 || row.fact_captured_at_ms === undefined) {
    fail("TELEMETRY_USAGE_CORRECTION_SOURCE_MISMATCH");
  }
  return Object.freeze({ id: integer(row.fact_id, 1), sourceHistoryId: history.id,
    participantId: history.participantId, ownerDigest: history.ownerDigest, ownerRevision: history.ownerRevision,
    authorityEpoch: history.authorityEpoch, source: history.source,
    totalInputContextTokens: history.usage.totalInputContextTokens, outputCombinedTokens: history.usage.outputCombinedTokens,
    recordJson: history.recordJson,
    methodVersion: USAGE_TOTAL_CORRECTION_METHOD,
    capturedAt: new Date(integer(row.fact_captured_at_ms, 0, 8640000000000000)).toISOString() });
}

export interface TelemetryUsageCorrectionReadOptions {
  /** Every page is owner-scoped so a cursor cannot cross an authority epoch. */
  readonly ownerDigest: string;
  readonly ownerRevision: number;
  readonly authorityEpoch: number;
  /** Optional UTC day predicate for readers that must avoid scanning an
   * owner's entire retained correction history before arithmetic. */
  readonly day?: string;
  readonly afterId?: number;
  readonly limit?: number;
  /** Expand only these complete occurrence groups, including crossed-day variants. */
  readonly occurrenceIds?: readonly string[];
}

type NormalizedTelemetryUsageCorrectionReadOptions = Readonly<{
  ownerDigest: string; ownerRevision: number; authorityEpoch: number; day: string | null;
  dayStartMs: number | null; dayEndMs: number | null; afterId: number; limit: number; occurrenceIds: readonly string[] | null;
}>;

function correctionReadDay(value: unknown): { day: string; startMs: number; endMs: number } {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) fail();
  const startMs = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isSafeInteger(startMs) || new Date(startMs).toISOString().slice(0, 10) !== value
      || startMs > 8640000000000000 - 86_400_000) fail();
  return { day: value, startMs, endMs: startMs + 86_400_000 };
}

function readOptions(options: TelemetryUsageCorrectionReadOptions | undefined): NormalizedTelemetryUsageCorrectionReadOptions {
  const value = options ?? {};
  if (!isRecord(value) || Object.keys(value).some((key) =>
    !["afterId", "authorityEpoch", "day", "limit", "occurrenceIds", "ownerDigest", "ownerRevision"].includes(key))) fail();
  const day = value.day === undefined ? null : correctionReadDay(value.day);
  const occurrenceIds = value.occurrenceIds === undefined ? null : value.occurrenceIds;
  if (occurrenceIds !== null && (!Array.isArray(occurrenceIds) || occurrenceIds.length < 1
    || occurrenceIds.length > MAX_TELEMETRY_USAGE_CORRECTION_PAGE
    || occurrenceIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/u.test(id))
    || new Set(occurrenceIds).size !== occurrenceIds.length)) fail();
  return Object.freeze({
    ownerDigest: digest(value.ownerDigest),
    ownerRevision: integer(value.ownerRevision, 1, 0x7fffffff),
    authorityEpoch: integer(value.authorityEpoch, 1, 0x7fffffff),
    day: day?.day ?? null, dayStartMs: day?.startMs ?? null, dayEndMs: day?.endMs ?? null,
    occurrenceIds: occurrenceIds === null ? null : Object.freeze([...occurrenceIds]),
    afterId: value.afterId === undefined ? 0 : integer(value.afterId, 0),
    limit: value.limit === undefined ? MAX_TELEMETRY_USAGE_CORRECTION_PAGE : integer(value.limit, 1, MAX_TELEMETRY_USAGE_CORRECTION_PAGE),
  });
}

async function assertReadOwnerCas(db: D1Database, read: NormalizedTelemetryUsageCorrectionReadOptions): Promise<void> {
  const row = await db.prepare(`SELECT owner.owner_digest,owner.revision,owner.authority_epoch
    FROM storage_owner_revisions owner
    JOIN storage_v11_owner_links link ON link.owner_digest=owner.owner_digest
      AND link.state='active'
    WHERE owner.owner_digest=? AND owner.state='active' LIMIT 2`).bind(read.ownerDigest).first<{
      owner_digest: string; revision: number; authority_epoch: number;
    }>();
  if (!row || row.owner_digest !== read.ownerDigest || row.revision !== read.ownerRevision
      || row.authority_epoch !== read.authorityEpoch) fail("TELEMETRY_USAGE_CORRECTION_CAS_MISMATCH");
}

async function historyRows(db: D1Database, read: NormalizedTelemetryUsageCorrectionReadOptions,
  facts: boolean): Promise<{ rows: readonly HistoryDbRow[]; nextAfterId: number | null }> {
  await assertReadOwnerCas(db, read);
  const suffix = facts ? "JOIN telemetry_usage_correction_facts f ON f.history_id=h.id" : "";
  const columns = facts ? `${HISTORY_COLUMNS}, f.id AS fact_id, f.method_version AS fact_method_version, f.captured_at_ms AS fact_captured_at_ms` : HISTORY_COLUMNS;
  const where = facts ? "f.id>?" : "h.id>?";
  const order = facts ? "f.id" : "h.id";
  const dayWhere = read.dayStartMs === null ? "" : " AND h.event_time_ms>=? AND h.event_time_ms<?";
  const ownerDigest = digestBuffer(read.ownerDigest);
  const occurrenceWhere = read.occurrenceIds === null ? ''
    : ' AND lower(hex(h.occurrence_id)) IN (SELECT value FROM json_each(?))';
  const ids = read.occurrenceIds?.map(id => Array.from(encodeTypedTelemetryId(id), byte => byte.toString(16).padStart(2,'0')).join(''));
  const rows = await db.prepare(`SELECT ${columns}${HISTORY_FROM}${suffix}
    WHERE ${where} AND h.owner_digest IS ?${dayWhere}${occurrenceWhere}
    ORDER BY ${order} LIMIT ?`).bind(read.afterId, ownerDigest,
      ...(read.dayStartMs === null ? [] : [read.dayStartMs,read.dayEndMs]),
      ...(ids ? [JSON.stringify(ids)] : []),read.limit+1).all<HistoryDbRow>();
  const selected = rows.results.slice(0, read.limit);
  const nextAfterId = rows.results.length > read.limit && selected.length > 0
    ? integer((selected.at(-1) as HistoryDbRow)[facts ? "fact_id" : "id"], 1) : null;
  await assertReadOwnerCas(db, read);
  return { rows: selected, nextAfterId };
}

export async function readTelemetryUsageCorrectionHistory(
  db: D1Database, options?: TelemetryUsageCorrectionReadOptions,
): Promise<{ rows: readonly TelemetryUsageCorrectionHistoryRow[]; nextAfterId: number | null }> {
  await runtime(db);
  const read = readOptions(options);
  const selected = await historyRows(db, read, false);
  const parsed: TelemetryUsageCorrectionHistoryRow[] = [];
  for (const row of selected.rows) parsed.push(await parseHistory(row));
  await assertReadOwnerCas(db, read);
  return Object.freeze({ rows: Object.freeze(parsed), nextAfterId: selected.nextAfterId });
}

/** Read derived facts only after a separate activation changes the runtime
 * fence. Staged history can be audited, but it cannot become accounting input. */
export async function readTelemetryUsageCorrectionEffectiveFacts(
  db: D1Database, options?: TelemetryUsageCorrectionReadOptions,
): Promise<{ rows: readonly TelemetryUsageCorrectionFactRow[]; nextAfterId: number | null }> {
  await runtime(db, true);
  const read = readOptions(options);
  const selected = await historyRows(db, read, true);
  const parsed: TelemetryUsageCorrectionFactRow[] = [];
  for (const row of selected.rows) parsed.push(await parseFact(row));
  await assertReadOwnerCas(db, read);
  return Object.freeze({ rows: Object.freeze(parsed), nextAfterId: selected.nextAfterId });
}

/**
 * Read only the earliest immutable fact for each semantic source variant.
 *
 * The ordinary effective-facts API above is intentionally a physical audit
 * cursor: callers can inspect every captured fact. The usage reader has a
 * different contract. Repeated replacement generations with identical
 * canonical bytes are one source variant, so grouping must happen in D1
 * before the bounded page is returned; otherwise a large duplicate archive
 * would consume an unbounded number of physical pages before the reader could
 * discover that it had no additional analytical evidence.
 *
 * The grouping key keeps device, format, occurrence, event time, and the
 * verified canonical record digest. A different key is therefore returned as
 * a separate variant and remains visible to reconciliation. The query pages
 * representative fact IDs, while the default audit reader above remains
 * unchanged.
 */
export async function readTelemetryUsageCorrectionEffectiveSourceVariants(
  db: D1Database, options?: TelemetryUsageCorrectionReadOptions,
): Promise<{ rows: readonly TelemetryUsageCorrectionFactRow[]; nextAfterId: number | null }> {
  await runtime(db, true);
  const read = readOptions(options);
  // Occurrence expansion deliberately follows every timestamp variant,
  // including variants outside the selected display day. A day predicate would
  // silently turn a crossed-day conflict into two independently priced rows.
  if (read.occurrenceIds === null || read.day !== null
      || read.limit !== MAX_TELEMETRY_USAGE_CORRECTION_PAGE) {
    fail("TELEMETRY_USAGE_CORRECTION_INVALID");
  }
  await assertReadOwnerCas(db, read);

  const occurrenceWhere = ' AND lower(hex(h.occurrence_id)) IN (SELECT value FROM json_each(?))';
  const ids = read.occurrenceIds.map(id => Array.from(encodeTypedTelemetryId(id), byte =>
    byte.toString(16).padStart(2, "0")).join(""));
  const columns = `${HISTORY_COLUMNS}, f.id AS fact_id, f.method_version AS fact_method_version,
    f.captured_at_ms AS fact_captured_at_ms`;
  const rows = await db.prepare(`
    WITH representatives AS MATERIALIZED (
      SELECT MIN(f.id) AS fact_id
        FROM telemetry_usage_correction_history h
        JOIN telemetry_usage_correction_facts f
          ON f.history_id=h.id AND f.method_version=1
       WHERE h.owner_digest IS ?${occurrenceWhere}
       GROUP BY h.source_format,h.device_id,h.occurrence_id,h.event_time_ms,h.record_digest
    ), selected AS MATERIALIZED (
      SELECT fact_id FROM representatives
       WHERE fact_id>?
       ORDER BY fact_id LIMIT ?
    )
    SELECT ${columns}${HISTORY_FROM}
      JOIN telemetry_usage_correction_facts f
        ON f.history_id=h.id AND f.method_version=1
      JOIN selected ON selected.fact_id=f.id
     ORDER BY f.id
  `).bind(digestBuffer(read.ownerDigest), JSON.stringify(ids), read.afterId,
    read.limit + 1).all<HistoryDbRow>();
  const selected = rows.results.slice(0, read.limit);
  const parsed: TelemetryUsageCorrectionFactRow[] = [];
  for (const row of selected) parsed.push(await parseFact(row));
  await assertReadOwnerCas(db, read);
  const nextAfterId = rows.results.length > read.limit && selected.length > 0
    ? integer((selected.at(-1) as HistoryDbRow).fact_id, 1) : null;
  return Object.freeze({ rows: Object.freeze(parsed), nextAfterId });
}

/** Candidate coordinates only: complete occurrence groups are expanded by the
 * effective reader after merging the family cursors. A dense day never needs
 * its whole correction archive decoded to return the next bounded page. */
export async function readTelemetryUsageCorrectionCandidates(db:D1Database, options:TelemetryUsageCorrectionReadOptions & {
  day:string; after?:{observedAtMs:number;occurrenceId:string};
}):Promise<readonly {occurrenceId:string;observedAtMs:number}[]> {
  const {after,...scope}=options;
  const read=readOptions(scope);
  await runtime(db,true);await assertReadOwnerCas(db,read);
  const time=after ? integer(after.observedAtMs,-8640000000000000,8640000000000000) : -8640000000000000;
  const occurrenceId=after?.occurrenceId??'';
  if(typeof occurrenceId!=='string'||occurrenceId!==''&&!/^[A-Za-z0-9._:-]{8,128}$/u.test(occurrenceId))fail();
  const rows=(await db.prepare(`WITH grouped AS (
    SELECT h.occurrence_id,${typedTelemetryIdSql('h.occurrence_id')} AS occurrence_text,
      MIN(h.event_time_ms) AS observed_at_ms
    FROM telemetry_usage_correction_history h JOIN telemetry_usage_correction_facts f ON f.history_id=h.id
    WHERE h.owner_digest IS ? AND h.event_time_ms>=? AND h.event_time_ms<? GROUP BY h.occurrence_id
  ) SELECT occurrence_id,occurrence_text,observed_at_ms FROM grouped
    WHERE observed_at_ms>? OR (observed_at_ms=? AND occurrence_text>?)
    ORDER BY observed_at_ms,occurrence_text LIMIT ?`).bind(digestBuffer(read.ownerDigest),read.dayStartMs,
      read.dayEndMs,time,time,occurrenceId,read.limit+1)
    .all<{occurrence_id:ArrayBuffer;occurrence_text:string;observed_at_ms:number}>()).results;
  const result=rows.map(row=>{
    const id=decodeTypedTelemetryId(bytes(row.occurrence_id));
    if(id!==row.occurrence_text)fail('TELEMETRY_USAGE_CORRECTION_SOURCE_MISMATCH');
    return {occurrenceId:id,observedAtMs:integer(row.observed_at_ms,-8640000000000000,8640000000000000)};
  });
  await assertReadOwnerCas(db,read);return Object.freeze(result);
}
