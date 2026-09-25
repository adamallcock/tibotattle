import {
  canonicalTelemetryV11Json,
  parseTelemetryV11Attribution,
  parseTelemetryV11Record,
  type TelemetryV11Attribution,
} from "@app-usagemonitor/telemetry-contract";
import { sha256Hex } from "./crypto";
import {
  createPostgresSchemaConfig,
  createPostgresSourceIdentityConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresQueryResult,
  type PostgresSchemaConfig,
  type PostgresSourceIdentityConfig,
} from "./postgres-client";
import {
  readPostgresTelemetryV12EffectiveCandidatePage,
  readPostgresTelemetryV12EffectiveOccurrences,
  type PostgresTelemetryV12EffectiveCursor,
  type PostgresTelemetryV12EffectiveRecord,
} from "./postgres-typed-v12-effective-reader";
import {
  decodeTypedTelemetryId,
  decodeTypedTelemetryRecord,
  type TypedTelemetryFields,
  type TypedTelemetryFormat,
} from "./typed-telemetry-codec";

export type PostgresEffectiveStream = "usage" | "quota" | "session";
export type PostgresEffectiveFormat = "v1" | "v11" | "v12";

export interface PostgresEffectiveCursor {
  readonly observedAtMs: number;
  readonly occurrenceId: string;
}

export interface PostgresEffectiveSourcePin {
  readonly sourceId: string;
  readonly sourceNamespace: string;
  readonly storageAuthorityEpoch: number;
  readonly sourceCursorSequence: number;
  readonly sourceCursorAuthorityEpoch: number;
  readonly v1ImportGeneration: number;
  readonly v1ImportDigest: string;
  readonly v11ImportGeneration: number;
  readonly v11ImportDigest: string;
}

export interface PostgresEffectiveOwnerPin extends PostgresEffectiveSourcePin {
  readonly ownerDigest: string;
  readonly participantId: string;
  readonly inputRevision: number;
  readonly ownerRevision: number;
  readonly authorityEpoch: number;
  readonly v12State: string | null;
  readonly v12GenerationId: string | null;
}

export interface PostgresEffectiveOwner {
  readonly ownerDigest: string;
  readonly participantId: string;
  readonly inputRevision: number;
  readonly ownerRevision: number;
  readonly authorityEpoch: number;
  readonly hasV1: boolean;
  readonly hasV11: boolean;
  readonly hasV12: boolean;
  /** Compatibility aggregate: true when either typed legacy family is effective. */
  readonly hasLegacy: boolean;
  readonly hasEffective: boolean;
  readonly pin: PostgresEffectiveOwnerPin;
}

export interface PostgresEffectiveOwnersCursor {
  readonly ownerDigest: string;
  readonly sourcePin: PostgresEffectiveSourcePin;
}

export interface PostgresEffectiveOwnersPage {
  readonly available: true;
  readonly sourceId: string;
  readonly sourceNamespace: string;
  readonly owners: readonly PostgresEffectiveOwner[];
  readonly sourcePin: PostgresEffectiveSourcePin;
  readonly next: PostgresEffectiveOwnersCursor | null;
}

export interface ListPostgresEffectiveOwnersOptions {
  readonly sourceId?: unknown;
  readonly sourceNamespace?: unknown;
  readonly after?: PostgresEffectiveOwnersCursor;
  readonly limit?: number;
  readonly schema?: PostgresSchemaConfig;
}

export interface PostgresEffectiveOccurrence {
  readonly occurrenceId: string;
  readonly observedAtMs: number;
  readonly eventTime: string | null;
  readonly eventTimeConflict: boolean;
  readonly status: "compatible" | "conflict";
  readonly sourceCount: number;
  readonly sourceFormats: readonly PostgresEffectiveFormat[];
  /** Deterministic digest of every effective source row folded into this occurrence. */
  readonly sourceFingerprint: string;
  readonly recordJson: string | null;
}

export interface PostgresEffectiveHistoryPage {
  readonly available: boolean;
  /** Usage is unavailable until the separate correction-history family transfers. */
  readonly correctionFamilyAvailable: boolean | null;
  readonly sourceId: string;
  readonly sourceNamespace: string;
  readonly ownerDigest: string;
  readonly participantId: string;
  readonly day: string;
  readonly stream: PostgresEffectiveStream;
  readonly rows: readonly PostgresEffectiveOccurrence[];
  readonly sourcePin: PostgresEffectiveSourcePin | null;
  readonly ownerPin: PostgresEffectiveOwnerPin | null;
  readonly next: PostgresEffectiveCursor | null;
}

export interface ReadPostgresEffectiveHistoryOptions {
  readonly sourceId?: unknown;
  readonly sourceNamespace?: unknown;
  readonly ownerDigest?: unknown;
  readonly day?: unknown;
  readonly stream?: unknown;
  readonly after?: PostgresEffectiveCursor;
  readonly limit?: number;
  /** Maximum typed-source rows fetched per database subpage (defaults to 512). */
  readonly sourceFetchBatchSize?: number;
  readonly expectedPin?: PostgresEffectiveOwnerPin;
  readonly schema?: PostgresSchemaConfig;
}

export interface AssertPostgresEffectiveHistoryCurrentOptions {
  readonly sourceId?: unknown;
  readonly sourceNamespace?: unknown;
  readonly ownerDigest?: unknown;
  readonly pin: PostgresEffectiveOwnerPin;
  readonly schema?: PostgresSchemaConfig;
}

export interface PostgresTypedLegacyFamilyReceiptInput {
  readonly sourceFormat: 10 | 11;
  readonly generation: number;
  /** Exact sealed source-family digest from an independently parity-checked import. */
  readonly sourceDigest: string;
  readonly sourceRowCount: number;
  readonly membershipRowCount: number;
}

export interface FinalizePostgresTypedLegacyFamilyReceiptsOptions {
  readonly sourceId?: unknown;
  readonly sourceNamespace?: unknown;
  /** Both legacy families are committed atomically. This is not an admission/proof receipt. */
  readonly receipts: readonly PostgresTypedLegacyFamilyReceiptInput[];
  readonly schema?: PostgresSchemaConfig;
}

export type PostgresLegacyEffectiveErrorCode =
  | "POSTGRES_LEGACY_EFFECTIVE_INVALID"
  | "POSTGRES_LEGACY_EFFECTIVE_UNAVAILABLE"
  | "POSTGRES_LEGACY_EFFECTIVE_LIMIT"
  | "POSTGRES_LEGACY_EFFECTIVE_CAS_MISMATCH"
  | "POSTGRES_LEGACY_EFFECTIVE_SOURCE_CONFLICT";

export class PostgresLegacyEffectiveError extends Error {
  constructor(readonly code: PostgresLegacyEffectiveErrorCode) {
    super(code);
    this.name = "PostgresLegacyEffectiveError";
  }
}

interface FamilyReceiptRow {
  generation: string | number;
  source_digest: string;
  source_row_count: string | number;
  membership_row_count: string | number;
}

interface GlobalPinRow extends FamilyReceiptRow {
  source_id: string;
  storage_authority_epoch: string | number;
  source_cursor_sequence: string | number;
  source_cursor_authority_epoch: string | number;
  v1_generation: string | number;
  v1_digest: string;
  v1_source_rows: string | number;
  v1_membership_rows: string | number;
  v11_generation: string | number;
  v11_digest: string;
  v11_source_rows: string | number;
  v11_membership_rows: string | number;
}

interface FinalizedReceiptRow extends FamilyReceiptRow {
  source_format: string | number;
}

interface OwnerScopeRow {
  participant_id: string;
  owner_digest: string;
  owner_revision: string | number;
  authority_epoch: string | number;
  input_revision: string | number;
  v12_state: string | null;
  v12_generation_id: string | null;
}

interface CandidateRow {
  occurrence_id: string;
  observed_at_ms: string | number;
}

interface LegacyStorageRow {
  storage_row_id: string | number;
  source_row_id: string | number;
  format: string | number;
  stream: string | number;
  occurrence_id: Uint8Array;
  observed_at_ms: string | number;
  canonical_digest: Uint8Array;
  device_id: Uint8Array;
  provider: string;
  session_id: Uint8Array | null;
  model: string | null;
  speed_mode: string | null;
  api_service_tier: string | null;
  surface: string | null;
  billing_surface: string | null;
  reasoning_effort: string | null;
  agent_scope: string | null;
  outcome: string | null;
  total_input_context_tokens: string | number | null;
  input_uncached_tokens: string | number | null;
  input_cache_read_tokens: string | number | null;
  input_cache_write_tokens: string | number | null;
  output_text_tokens: string | number | null;
  output_reasoning_tokens: string | number | null;
  output_combined_tokens: string | number | null;
  plan_type: string | null;
  plan_variant: string | null;
  limit_id: string | null;
  slot: string | null;
  used_percent: number | string | null;
  window_duration_minutes: string | number | null;
  resets_at_ms: string | number | null;
  account_basis: number | null;
  account_track: Uint8Array | null;
  plan_basis: number | null;
  attribution_plan_type: string | null;
  plan_era: Uint8Array | null;
  tool_json: string | null;
}

interface LegacySource {
  readonly format: "v1" | "v11";
  readonly sourceRowId: number;
  readonly storageRowId: number;
  readonly deviceId: string;
  readonly occurrenceId: string;
  readonly observedAtMs: number;
  readonly canonicalDigest: string;
  readonly recordJson: string;
}

interface EffectiveOccurrenceFold {
  readonly candidate: CandidateRow;
  readonly sourceFormats: Set<PostgresEffectiveFormat>;
  sourceCount: number;
  observedAtMs: number | null;
  eventTimeConflict: boolean;
  baseRecordCanonical: string | null;
  baseRecord: Record<string, unknown> | null;
  conflict: boolean;
  accountTrackSet: boolean;
  accountTrackId: string | null;
  accountTrackConflict: boolean;
  accountFact: TelemetryV11Attribution | null;
  planTypeSet: boolean;
  planType: string | null;
  planTypeConflict: boolean;
  planEraSet: boolean;
  planEraId: string | null;
  planEraConflict: boolean;
  planFact: TelemetryV11Attribution | null;
  legacyDigest: string | null;
  v12Digest: string | null;
}

const OWNER_DIGEST = /^[0-9a-f]{64}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const OCCURRENCE = /^[A-Za-z0-9._:-]{8,128}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const ACCOUNT_BASES = ["unavailable", "same_source", "provisional_marker"] as const;
const PLAN_BASES = ["unavailable", "same_source_occurrence", "provisional_marker", "conflicted"] as const;
const STREAM_CODES: Readonly<Record<PostgresEffectiveStream, number>> = Object.freeze({ usage: 1, quota: 2, session: 3 });
const STREAM_NAMES: Readonly<Record<number, PostgresEffectiveStream>> = Object.freeze({ 1: "usage", 2: "quota", 3: "session" });
const MAX_PAGE = 200;
// Source expansion is keyset-paged independently of the bounded occurrence
// page. This bounds each PostgreSQL response without truncating valid history.
const MAX_SOURCE_ROWS_PER_FETCH = 512;
const MIN_MS = -8_640_000_000_000_000;
const MAX_MS = 8_640_000_000_000_000;
const UNAVAILABLE = (): never => fail("POSTGRES_LEGACY_EFFECTIVE_UNAVAILABLE");

const REQUIRED_RELATIONS = Object.freeze([
  "analytics_owner_state",
  "analytics_source_cursors",
  "community_analytical_input_versions",
  "device_credentials",
  "participants",
  "storage_owner_erasure_receipts",
  "storage_source_state",
  "storage_v11_event_sources",
  "storage_v11_owner_links",
  "telemetry_v11_chunks",
  "telemetry_v11_day_manifests",
  "telemetry_v11_domain_days",
  "telemetry_v11_domains",
  "telemetry_v12_domain_days",
  "telemetry_v12_domain_heads",
  "telemetry_v12_day_manifests",
  "telemetry_v12_runtime",
  "telemetry_v12_chunks",
  "telemetry_v12_typed_active_authorizations",
  "telemetry_v12_typed_records",
  "telemetry_v12_typed_runtime",
  "telemetry_v1_chunks",
  "typed_v1_admission_state",
  "typed_v1_chunk_allocations",
  "typed_v1_event_sources",
  "typed_v1_record_admissions",
  "typed_v11_admission_state",
  "typed_v11_chunk_allocations",
  "typed_v11_manifest_memberships",
  "typed_v11_record_proofs",
  "typed_telemetry_admission_transfer_receipts",
  "typed_telemetry_attributions",
  "typed_telemetry_chunks",
  "typed_telemetry_devices",
  "typed_telemetry_dictionary",
  "typed_telemetry_identifiers",
  "typed_telemetry_manifests",
  "typed_telemetry_namespaces",
  "typed_telemetry_owner_memberships",
  "typed_telemetry_owners",
  "typed_telemetry_quota_dimensions",
  "typed_telemetry_records",
  "typed_telemetry_session_tools",
  "typed_telemetry_source_family_receipts",
  "typed_telemetry_usage",
  "typed_telemetry_quota",
]);

function fail(code: PostgresLegacyEffectiveErrorCode): never {
  throw new PostgresLegacyEffectiveError(code);
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === "string" && /^-?\d+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return UNAVAILABLE();
  }
  return parsed;
}

function text(value: unknown, minimum = 1, maximum = 256): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) return UNAVAILABLE();
  return value;
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return Uint8Array.from(value);
  }
  return UNAVAILABLE();
}

function hex(value: unknown): string {
  return [...bytes(value)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function nullableInteger(value: unknown, maximum = 1_000_000_000_000): number | null {
  return value === null ? null : integer(value, 0, maximum);
}

function normalizeIdentity(options: { sourceId?: unknown; sourceNamespace?: unknown }): PostgresSourceIdentityConfig {
  try {
    return createPostgresSourceIdentityConfig(options);
  } catch {
    fail("POSTGRES_LEGACY_EFFECTIVE_INVALID");
  }
}

function schemaName(options: { schema?: PostgresSchemaConfig }): string {
  try {
    return quotePostgresIdentifier(createPostgresSchemaConfig(options.schema ?? {}).primarySchema);
  } catch {
    fail("POSTGRES_LEGACY_EFFECTIVE_INVALID");
  }
}

function table(schema: string, name: string): string {
  return `${schema}.${quotePostgresIdentifier(name)}`;
}

function validDay(value: unknown): string {
  if (typeof value !== "string" || !DAY.test(value)
      || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
      || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    fail("POSTGRES_LEGACY_EFFECTIVE_INVALID");
  }
  return value;
}

function stream(value: unknown): PostgresEffectiveStream {
  if (value === "usage" || value === "quota" || value === "session") return value;
  fail("POSTGRES_LEGACY_EFFECTIVE_INVALID");
}

function normalizeCursor(value: PostgresEffectiveCursor | undefined): PostgresEffectiveCursor {
  if (value === undefined) return Object.freeze({ observedAtMs: MIN_MS, occurrenceId: "" });
  if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "observedAtMs,occurrenceId"
      || typeof value.occurrenceId !== "string" || !OCCURRENCE.test(value.occurrenceId)) {
    fail("POSTGRES_LEGACY_EFFECTIVE_INVALID");
  }
  return Object.freeze({
    observedAtMs: integer(value.observedAtMs, MIN_MS, MAX_MS),
    occurrenceId: value.occurrenceId,
  });
}

function normalizeLimit(value: unknown): number {
  return integer(value ?? 100, 1, MAX_PAGE);
}

function normalizeSourceFetchBatchSize(value: unknown): number {
  if (value === undefined) return MAX_SOURCE_ROWS_PER_FETCH;
  if (typeof value !== "number" || !Number.isSafeInteger(value)
      || value < 1 || value > MAX_SOURCE_ROWS_PER_FETCH) fail("POSTGRES_LEGACY_EFFECTIVE_INVALID");
  return value;
}

function dayNumber(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`) / 86_400_000;
}

function normalizeSourcePin(row: GlobalPinRow, identity: PostgresSourceIdentityConfig): PostgresEffectiveSourcePin {
  if (row.source_id !== identity.sourceId
      || !SHA256.test(row.v1_digest) || !SHA256.test(row.v11_digest)) UNAVAILABLE();
  return Object.freeze({
    sourceId: row.source_id,
    sourceNamespace: identity.sourceNamespace,
    storageAuthorityEpoch: integer(row.storage_authority_epoch),
    sourceCursorSequence: integer(row.source_cursor_sequence),
    sourceCursorAuthorityEpoch: integer(row.source_cursor_authority_epoch),
    v1ImportGeneration: integer(row.v1_generation, 1),
    v1ImportDigest: row.v1_digest,
    v11ImportGeneration: integer(row.v11_generation, 1),
    v11ImportDigest: row.v11_digest,
  });
}

function sameSourcePin(left: PostgresEffectiveSourcePin, right: PostgresEffectiveSourcePin): boolean {
  return left.sourceId === right.sourceId && left.sourceNamespace === right.sourceNamespace
    && left.storageAuthorityEpoch === right.storageAuthorityEpoch
    && left.sourceCursorSequence === right.sourceCursorSequence
    && left.sourceCursorAuthorityEpoch === right.sourceCursorAuthorityEpoch
    && left.v1ImportGeneration === right.v1ImportGeneration && left.v1ImportDigest === right.v1ImportDigest
    && left.v11ImportGeneration === right.v11ImportGeneration && left.v11ImportDigest === right.v11ImportDigest;
}

function ownerPin(sourcePin: PostgresEffectiveSourcePin, row: OwnerScopeRow): PostgresEffectiveOwnerPin {
  return Object.freeze({
    ...sourcePin,
    ownerDigest: row.owner_digest,
    participantId: text(row.participant_id),
    inputRevision: integer(row.input_revision),
    ownerRevision: integer(row.owner_revision),
    authorityEpoch: integer(row.authority_epoch),
    v12State: row.v12_state,
    v12GenerationId: row.v12_generation_id,
  });
}

function sameOwnerPin(left: PostgresEffectiveOwnerPin, right: PostgresEffectiveOwnerPin): boolean {
  return sameSourcePin(left, right)
    && left.ownerDigest === right.ownerDigest && left.participantId === right.participantId
    && left.inputRevision === right.inputRevision && left.ownerRevision === right.ownerRevision
    && left.authorityEpoch === right.authorityEpoch && left.v12State === right.v12State
    && left.v12GenerationId === right.v12GenerationId;
}

function normalizeSourcePinInput(value: PostgresEffectiveSourcePin): PostgresEffectiveSourcePin {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== [
        "sourceId", "sourceNamespace", "storageAuthorityEpoch", "sourceCursorSequence",
        "sourceCursorAuthorityEpoch", "v1ImportGeneration", "v1ImportDigest",
        "v11ImportGeneration", "v11ImportDigest",
      ].sort().join(",")) fail("POSTGRES_LEGACY_EFFECTIVE_INVALID");
  const identity = normalizeIdentity({ sourceId: value.sourceId, sourceNamespace: value.sourceNamespace });
  if (!SHA256.test(value.v1ImportDigest) || !SHA256.test(value.v11ImportDigest)) {
    fail("POSTGRES_LEGACY_EFFECTIVE_INVALID");
  }
  return Object.freeze({
    sourceId: identity.sourceId,
    sourceNamespace: identity.sourceNamespace,
    storageAuthorityEpoch: integer(value.storageAuthorityEpoch),
    sourceCursorSequence: integer(value.sourceCursorSequence),
    sourceCursorAuthorityEpoch: integer(value.sourceCursorAuthorityEpoch),
    v1ImportGeneration: integer(value.v1ImportGeneration, 1),
    v1ImportDigest: value.v1ImportDigest,
    v11ImportGeneration: integer(value.v11ImportGeneration, 1),
    v11ImportDigest: value.v11ImportDigest,
  });
}

function normalizeOwnerPinInput(value: PostgresEffectiveOwnerPin): PostgresEffectiveOwnerPin {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== [
        "authorityEpoch", "inputRevision", "ownerDigest", "ownerRevision", "participantId", "sourceId",
        "sourceNamespace", "sourceCursorAuthorityEpoch", "sourceCursorSequence", "storageAuthorityEpoch",
        "v1ImportDigest", "v1ImportGeneration", "v11ImportDigest", "v11ImportGeneration",
        "v12GenerationId", "v12State",
      ].sort().join(",")) fail("POSTGRES_LEGACY_EFFECTIVE_INVALID");
  const source = normalizeSourcePinInput({
    sourceId: value.sourceId,
    sourceNamespace: value.sourceNamespace,
    storageAuthorityEpoch: value.storageAuthorityEpoch,
    sourceCursorSequence: value.sourceCursorSequence,
    sourceCursorAuthorityEpoch: value.sourceCursorAuthorityEpoch,
    v1ImportGeneration: value.v1ImportGeneration,
    v1ImportDigest: value.v1ImportDigest,
    v11ImportGeneration: value.v11ImportGeneration,
    v11ImportDigest: value.v11ImportDigest,
  });
  if (!OWNER_DIGEST.test(value.ownerDigest)) fail("POSTGRES_LEGACY_EFFECTIVE_INVALID");
  return Object.freeze({
    ...source,
    ownerDigest: value.ownerDigest,
    participantId: text(value.participantId),
    inputRevision: integer(value.inputRevision),
    ownerRevision: integer(value.ownerRevision),
    authorityEpoch: integer(value.authorityEpoch),
    v12State: value.v12State === null ? null : text(value.v12State),
    v12GenerationId: value.v12GenerationId === null ? null : text(value.v12GenerationId),
  });
}

function schemaIdentifier(schema: string): string {
  return schema.replaceAll('"', "");
}

async function assertSchema(client: PostgresClient, schema: string): Promise<void> {
  const result = await client.query<{ name: string }>(
    `SELECT relation.relname AS name
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relname = ANY($2::text[])
        AND relation.relkind IN ('r', 'v')`,
    [schemaIdentifier(schema), REQUIRED_RELATIONS],
  );
  if (result.rows.length !== REQUIRED_RELATIONS.length
      || new Set(result.rows.map((row) => row.name)).size !== REQUIRED_RELATIONS.length) UNAVAILABLE();
}

async function readGlobalPin(
  client: PostgresClient,
  schema: string,
  identity: PostgresSourceIdentityConfig,
): Promise<PostgresEffectiveSourcePin> {
  const result = await client.query<GlobalPinRow>(
    `SELECT source.source_id,
            source.authority_epoch AS storage_authority_epoch,
            cursor.sequence AS source_cursor_sequence,
            cursor.authority_epoch AS source_cursor_authority_epoch,
            v1.generation AS v1_generation,v1.source_digest AS v1_digest,
            v1.source_row_count AS v1_source_rows,v1.membership_row_count AS v1_membership_rows,
            v11.generation AS v11_generation,v11.source_digest AS v11_digest,
            v11.source_row_count AS v11_source_rows,v11.membership_row_count AS v11_membership_rows
       FROM ${table(schema, "storage_source_state")} source
       JOIN ${table(schema, "analytics_source_cursors")} cursor ON cursor.source_id=source.source_id
       JOIN ${table(schema, "typed_telemetry_source_family_receipts")} v1
         ON v1.source_namespace=$2 AND v1.source_format=10
       JOIN ${table(schema, "typed_telemetry_source_family_receipts")} v11
         ON v11.source_namespace=$2 AND v11.source_format=11
       JOIN ${table(schema, "typed_telemetry_admission_transfer_receipts")} admission_receipt
         ON admission_receipt.v1_source_namespace=$2 AND admission_receipt.v1_source_format=10
        AND admission_receipt.v11_source_namespace=$2 AND admission_receipt.v11_source_format=11
        AND admission_receipt.v1_base_generation=v1.generation
        AND admission_receipt.v11_base_generation=v11.generation
      WHERE source.singleton=1 AND source.source_id=$1`,
    [identity.sourceId, identity.sourceNamespace],
  );
  if (result.rows.length !== 1) UNAVAILABLE();
  const row = result.rows[0]!;
  const pin = normalizeSourcePin(row, identity);
  // The family receipts are also shape-checked here. They remain operator
  // supplied transfer attestations; this read path never infers completeness
  // from a nonempty table or from a v1.2-only owner.
  integer(row.v1_source_rows);
  integer(row.v1_membership_rows);
  integer(row.v11_source_rows);
  integer(row.v11_membership_rows);
  return pin;
}

function normalizeFinalizationReceipts(value: unknown): readonly PostgresTypedLegacyFamilyReceiptInput[] {
  if (!Array.isArray(value) || value.length !== 2) fail("POSTGRES_LEGACY_EFFECTIVE_INVALID");
  const normalized = value.map((item): PostgresTypedLegacyFamilyReceiptInput => {
    if (!item || typeof item !== "object" || Array.isArray(item)
        || Object.keys(item).sort().join(",")
          !== "generation,membershipRowCount,sourceDigest,sourceFormat,sourceRowCount") {
      fail("POSTGRES_LEGACY_EFFECTIVE_INVALID");
    }
    const receipt = item as PostgresTypedLegacyFamilyReceiptInput;
    if (receipt.sourceFormat !== 10 && receipt.sourceFormat !== 11) fail("POSTGRES_LEGACY_EFFECTIVE_INVALID");
    if (typeof receipt.sourceDigest !== "string" || !SHA256.test(receipt.sourceDigest)) {
      fail("POSTGRES_LEGACY_EFFECTIVE_INVALID");
    }
    return Object.freeze({ sourceFormat: receipt.sourceFormat,
      generation: integer(receipt.generation, 1), sourceDigest: receipt.sourceDigest,
      sourceRowCount: integer(receipt.sourceRowCount), membershipRowCount: integer(receipt.membershipRowCount) });
  }).sort((left, right) => left.sourceFormat - right.sourceFormat);
  if (normalized[0]?.sourceFormat !== 10 || normalized[1]?.sourceFormat !== 11) {
    fail("POSTGRES_LEGACY_EFFECTIVE_INVALID");
  }
  return Object.freeze(normalized);
}

/**
 * Persist the two v1/v1.1 family receipts only after the transfer runner has
 * independently compared its sealed source and PostgreSQL rows. This helper
 * repeats the exact row, membership, and source-authority counts in one
 * repeatable-read transaction. It does not import or attest admission,
 * preservation-proof, or usage-correction families. A caller must complete
 * those separate transfer/reconciliation gates before invoking it for reader
 * activation.
 */
export async function finalizePostgresTypedLegacyFamilyReceipts(
  pool: PostgresPool,
  input: FinalizePostgresTypedLegacyFamilyReceiptsOptions,
): Promise<readonly PostgresTypedLegacyFamilyReceiptInput[]> {
  const identity = normalizeIdentity(input);
  const schema = schemaName(input);
  const receipts = normalizeFinalizationReceipts(input.receipts);
  return withPostgresMutation(pool, async (client) => {
    await assertSchema(client, schema);
    // Serialize finalizers for this namespace. Transfer writers must be quiesced
    // by their orchestrator and are deliberately not coupled to this helper.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [`typed-legacy-receipts:${identity.sourceNamespace}`]);
    const source = await client.query<{ source_id: string; sequence: string | number }>(
      `SELECT source.source_id,cursor.sequence
         FROM ${table(schema, "storage_source_state")} source
         JOIN ${table(schema, "analytics_source_cursors")} cursor ON cursor.source_id=source.source_id
        WHERE source.singleton=1 AND source.source_id=$1
        FOR SHARE OF source,cursor`, [identity.sourceId]);
    if (source.rows.length !== 1) UNAVAILABLE();

    for (const receipt of receipts) {
      const counts = await client.query<{
        source_row_count: string | number;
        membership_row_count: string | number;
        invalid_participants: string | number;
        invalid_event_authority: string | number;
        missing_lineage_rows: string | number;
      }>(
        `SELECT
          (SELECT count(*) FROM ${table(schema, "typed_telemetry_records")} record
            JOIN ${table(schema, "typed_telemetry_owner_memberships")} membership
              ON membership.namespace_id=record.namespace_id AND membership.owner_id=record.owner_id
             AND membership.source_format=record.format
           WHERE membership.source_namespace=$1 AND membership.source_format=$2) AS source_row_count,
          (SELECT count(*) FROM ${table(schema, "typed_telemetry_owner_memberships")} membership
           WHERE membership.source_namespace=$1 AND membership.source_format=$2) AS membership_row_count,
          (SELECT count(*) FROM ${table(schema, "typed_telemetry_owner_memberships")} membership
            LEFT JOIN ${table(schema, "participants")} participant ON participant.id=membership.participant_id
           WHERE membership.source_namespace=$1 AND membership.source_format=$2
             AND (participant.id IS NULL OR participant.state<>'active')) AS invalid_participants,
          CASE WHEN $2=10 THEN (
            SELECT count(*) FROM ${table(schema, "typed_v1_event_sources")} event
              LEFT JOIN ${table(schema, "participants")} participant ON participant.id=event.participant_id
              LEFT JOIN ${table(schema, "storage_v11_owner_links")} owner_link
                ON owner_link.participant_id=event.participant_id AND owner_link.owner_digest=event.owner_digest
              LEFT JOIN ${table(schema, "storage_owner_erasure_receipts")} erased
                ON erased.owner_digest=event.owner_digest
             WHERE event.source_namespace=$1
               AND (participant.id IS NULL OR owner_link.participant_id IS NULL
                 OR owner_link.state='erased' AND erased.owner_digest IS NULL)
          ) ELSE (
            SELECT count(*) FROM ${table(schema, "storage_v11_event_sources")} event
              JOIN ${table(schema, "typed_telemetry_owner_memberships")} membership
                ON membership.participant_id=event.participant_id
               AND membership.source_format=11 AND membership.source_namespace=$1
              LEFT JOIN ${table(schema, "participants")} participant ON participant.id=event.participant_id
              LEFT JOIN ${table(schema, "storage_v11_owner_links")} owner_link
                ON owner_link.participant_id=event.participant_id AND owner_link.owner_digest=event.owner_digest
              LEFT JOIN ${table(schema, "storage_owner_erasure_receipts")} erased
                ON erased.owner_digest=event.owner_digest
             WHERE participant.id IS NULL OR owner_link.participant_id IS NULL
               OR owner_link.state='erased' AND erased.owner_digest IS NULL
          ) END AS invalid_event_authority,
          CASE WHEN $2=10 THEN ${missingV1LineageRowsSql(schema)}
            ELSE ${missingV11LineageRowsSql(schema)} END AS missing_lineage_rows`,
        [identity.sourceNamespace, receipt.sourceFormat]);
      if (counts.rows.length !== 1) UNAVAILABLE();
      const countsRow = counts.rows[0]!;
      if (integer(countsRow.source_row_count) !== receipt.sourceRowCount
          || integer(countsRow.membership_row_count) !== receipt.membershipRowCount
          || integer(countsRow.invalid_participants) !== 0
          || integer(countsRow.invalid_event_authority) !== 0
          || integer(countsRow.missing_lineage_rows) !== 0) {
        fail("POSTGRES_LEGACY_EFFECTIVE_SOURCE_CONFLICT");
      }
      await client.query(
        `INSERT INTO ${table(schema, "typed_telemetry_source_family_receipts")} (
           source_namespace,source_format,generation,source_digest,source_row_count,membership_row_count,reconciled_at
         ) VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp())
         ON CONFLICT (source_namespace,source_format) DO UPDATE SET
           generation=EXCLUDED.generation,source_digest=EXCLUDED.source_digest,
           source_row_count=EXCLUDED.source_row_count,membership_row_count=EXCLUDED.membership_row_count,
           reconciled_at=EXCLUDED.reconciled_at
         WHERE typed_telemetry_source_family_receipts.generation<EXCLUDED.generation`,
        [identity.sourceNamespace, receipt.sourceFormat, receipt.generation, receipt.sourceDigest,
          receipt.sourceRowCount, receipt.membershipRowCount]);
    }

    const persisted = await client.query<FinalizedReceiptRow>(
      `SELECT source_format,generation,source_digest,source_row_count,membership_row_count
         FROM ${table(schema, "typed_telemetry_source_family_receipts")}
        WHERE source_namespace=$1 AND source_format IN (10,11) ORDER BY source_format`,
      [identity.sourceNamespace]);
    if (persisted.rows.length !== receipts.length) fail("POSTGRES_LEGACY_EFFECTIVE_SOURCE_CONFLICT");
    for (let index = 0; index < receipts.length; index += 1) {
      const expected = receipts[index]!;
      const actual = persisted.rows[index]!;
      if (integer(actual.source_format) !== expected.sourceFormat
          || integer(actual.generation, 1) !== expected.generation
          || actual.source_digest !== expected.sourceDigest
          || integer(actual.source_row_count) !== expected.sourceRowCount
          || integer(actual.membership_row_count) !== expected.membershipRowCount) {
        fail("POSTGRES_LEGACY_EFFECTIVE_SOURCE_CONFLICT");
      }
    }
    return receipts;
  }, { operation: "legacy_effective.finalize_receipts", isolationLevel: "repeatable_read",
    statementTimeoutMilliseconds: 60_000, lockTimeoutMilliseconds: 10_000,
    preserveSafeError: (error) => error instanceof PostgresLegacyEffectiveError ? error : null });
}

function ownerScopeSql(schema: string): string {
  return `SELECT link.participant_id,link.owner_digest,owner.revision AS owner_revision,
          owner.authority_epoch,input.revision AS input_revision,
          (COALESCE(v12_runtime.state,'missing')||':'||COALESCE(v12_typed_runtime.state,'missing')) AS v12_state,
          head.generation_id AS v12_generation_id
     FROM ${table(schema, "storage_v11_owner_links")} link
     JOIN ${table(schema, "participants")} participant
       ON participant.id=link.participant_id AND participant.state='active'
     JOIN ${table(schema, "analytics_owner_state")} owner
       ON owner.owner_digest=link.owner_digest AND owner.source_id=$2 AND owner.state='active'
     JOIN ${table(schema, "community_analytical_input_versions")} input
       ON input.participant_id=participant.id
     LEFT JOIN ${table(schema, "telemetry_v12_runtime")} v12_runtime ON v12_runtime.id=1
     LEFT JOIN ${table(schema, "telemetry_v12_typed_runtime")} v12_typed_runtime ON v12_typed_runtime.id=1
     LEFT JOIN ${table(schema, "telemetry_v12_domain_heads")} head
       ON head.participant_id=participant.id
    WHERE link.owner_digest=$1 AND link.state='active'
      AND NOT EXISTS (SELECT 1 FROM ${table(schema, "storage_owner_erasure_receipts")} erased
                       WHERE erased.owner_digest=link.owner_digest)`;
}

async function readOwnerScope(
  client: PostgresClient,
  schema: string,
  identity: PostgresSourceIdentityConfig,
  sourcePin: PostgresEffectiveSourcePin,
  ownerDigest: string,
): Promise<PostgresEffectiveOwnerPin> {
  const result = await client.query<OwnerScopeRow>(ownerScopeSql(schema), [ownerDigest, identity.sourceId]);
  if (result.rows.length !== 1) fail("POSTGRES_LEGACY_EFFECTIVE_CAS_MISMATCH");
  const row = result.rows[0]!;
  const pin = ownerPin(sourcePin, row);
  if (!sameSourcePin(pin, sourcePin) || pin.ownerDigest !== ownerDigest) {
    fail("POSTGRES_LEGACY_EFFECTIVE_CAS_MISMATCH");
  }
  return pin;
}

async function captureOwnerPin(
  pool: PostgresPool,
  schema: string,
  identity: PostgresSourceIdentityConfig,
  ownerDigest: string,
): Promise<PostgresEffectiveOwnerPin> {
  if (!OWNER_DIGEST.test(ownerDigest)) fail("POSTGRES_LEGACY_EFFECTIVE_INVALID");
  return withPostgresRead(pool, async (client) => {
    await assertSchema(client, schema);
    const sourcePin = await readGlobalPin(client, schema, identity);
    return readOwnerScope(client, schema, identity, sourcePin, ownerDigest);
  }, { operation: "legacy_effective.scope", statementTimeoutMilliseconds: 10_000, lockTimeoutMilliseconds: 5_000,
    preserveSafeError: (error) => error instanceof PostgresLegacyEffectiveError ? error : null });
}

/** Count typed v1 rows without a complete, owner-authorized source-row mapping. */
function missingV1LineageRowsSql(schema: string): string {
  const chunkId = typedIdTextSql("typed_chunk.original_id");
  const deviceId = typedIdTextSql("typed_device.original_id");
  return `(SELECT count(*)
    FROM ${table(schema, "typed_telemetry_owner_memberships")} membership
    JOIN ${table(schema, "typed_telemetry_records")} record
      ON record.namespace_id=membership.namespace_id AND record.owner_id=membership.owner_id
     AND record.format=membership.source_format
    JOIN ${table(schema, "typed_telemetry_devices")} typed_device
      ON typed_device.id=record.device_id AND typed_device.namespace_id=record.namespace_id
     AND typed_device.owner_id=record.owner_id
    JOIN ${table(schema, "typed_telemetry_chunks")} typed_chunk
      ON typed_chunk.id=record.chunk_id AND typed_chunk.namespace_id=record.namespace_id
     AND typed_chunk.format=record.format AND typed_chunk.owner_id=record.owner_id
     AND typed_chunk.device_id=record.device_id AND typed_chunk.stream=record.stream
    WHERE membership.source_namespace=$1 AND membership.source_format=10
      AND NOT EXISTS (
        SELECT 1
          FROM ${table(schema, "typed_v1_event_sources")} event
          JOIN ${table(schema, "storage_v11_owner_links")} owner_link
            ON owner_link.participant_id=event.participant_id AND owner_link.owner_digest=event.owner_digest
          LEFT JOIN ${table(schema, "storage_owner_erasure_receipts")} erased
            ON erased.owner_digest=event.owner_digest
          JOIN ${table(schema, "telemetry_v1_chunks")} chunk
            ON chunk.id=event.chunk_id AND chunk.participant_id=membership.participant_id
           AND chunk.id=(${chunkId}) AND chunk.device_id=(${deviceId})
           AND chunk.stream=CASE record.stream WHEN 1 THEN 'usage' WHEN 2 THEN 'quota' ELSE 'session' END
           AND chunk.accepted_record_count=chunk.record_count
          JOIN ${table(schema, "typed_v1_admission_state")} admission_state
            ON admission_state.id=1 AND admission_state.namespace_id=record.namespace_id
           AND admission_state.source_namespace=membership.source_namespace
          JOIN ${table(schema, "typed_v1_chunk_allocations")} allocation
            ON allocation.chunk_id=chunk.id AND allocation.namespace_id=record.namespace_id
           AND allocation.chunk_original=typed_chunk.original_id
           AND allocation.record_count=chunk.record_count
          JOIN ${table(schema, "typed_v1_record_admissions")} admission
            ON admission.typed_record_id=record.id AND admission.chunk_id=chunk.id
         WHERE event.source_namespace=membership.source_namespace
           AND event.participant_id=membership.participant_id
           AND (owner_link.state<>'erased' OR erased.owner_digest IS NOT NULL)
           AND record.source_row_id>=allocation.first_source_row_id
           AND record.source_row_id<allocation.first_source_row_id+allocation.record_count
           AND record.observed_day=(chunk.chunk_day-DATE '1970-01-01')::integer
           AND chunk.record_count=(SELECT count(*) FROM ${table(schema, "typed_v1_record_admissions")} admitted
             WHERE admitted.chunk_id=chunk.id)
           AND chunk.record_count=(SELECT count(*) FROM ${table(schema, "typed_telemetry_records")} typed_record
             WHERE typed_record.chunk_id=typed_chunk.id AND typed_record.format=10)
      ))`;
}

/** Count typed v1.1 rows without a complete, owner-authorized source-row mapping. */
function missingV11LineageRowsSql(schema: string): string {
  const chunkId = typedIdTextSql("typed_chunk.original_id");
  const deviceId = typedIdTextSql("typed_device.original_id");
  const manifestId = typedIdTextSql("typed_manifest.original_id");
  return `(SELECT count(*)
    FROM ${table(schema, "typed_telemetry_owner_memberships")} membership
    JOIN ${table(schema, "typed_telemetry_records")} record
      ON record.namespace_id=membership.namespace_id AND record.owner_id=membership.owner_id
     AND record.format=membership.source_format
    JOIN ${table(schema, "typed_telemetry_devices")} typed_device
      ON typed_device.id=record.device_id AND typed_device.namespace_id=record.namespace_id
     AND typed_device.owner_id=record.owner_id
    JOIN ${table(schema, "typed_telemetry_chunks")} typed_chunk
      ON typed_chunk.id=record.chunk_id AND typed_chunk.namespace_id=record.namespace_id
     AND typed_chunk.format=record.format AND typed_chunk.owner_id=record.owner_id
     AND typed_chunk.device_id=record.device_id AND typed_chunk.stream=record.stream
    JOIN ${table(schema, "typed_telemetry_manifests")} typed_manifest
      ON typed_manifest.id=record.manifest_id AND typed_manifest.namespace_id=record.namespace_id
     AND typed_manifest.owner_id=record.owner_id AND typed_manifest.device_id=record.device_id
    WHERE membership.source_namespace=$1 AND membership.source_format=11
      AND NOT EXISTS (
        SELECT 1
          FROM ${table(schema, "storage_v11_event_sources")} event
          JOIN ${table(schema, "storage_v11_owner_links")} owner_link
            ON owner_link.participant_id=event.participant_id AND owner_link.owner_digest=event.owner_digest
          LEFT JOIN ${table(schema, "storage_owner_erasure_receipts")} erased
            ON erased.owner_digest=event.owner_digest
          JOIN ${table(schema, "telemetry_v11_domains")} generation
            ON generation.id=event.generation_id AND generation.participant_id=event.participant_id
           AND generation.device_id=event.device_id AND generation.manifest_digest=event.manifest_digest
           AND generation.from_day=event.from_day AND generation.through_day=event.through_day
           AND generation.input_revision=event.input_revision
          JOIN ${table(schema, "telemetry_v11_domain_days")} domain_day
            ON domain_day.generation_id=generation.id
           AND domain_day.observed_day=(DATE '1970-01-01'+record.observed_day)
          JOIN ${table(schema, "telemetry_v11_day_manifests")} manifest
            ON manifest.id=domain_day.manifest_id AND manifest.state='ready'
           AND manifest.participant_id=generation.participant_id AND manifest.device_id=generation.device_id
           AND manifest.chunk_day=domain_day.observed_day AND (${manifestId})=manifest.id
           AND typed_manifest.chunk_day=record.observed_day
          JOIN ${table(schema, "telemetry_v11_chunks")} chunk
            ON chunk.id=(${chunkId}) AND chunk.manifest_id=manifest.id
           AND chunk.participant_id=membership.participant_id AND chunk.device_id=generation.device_id
           AND chunk.device_id=(${deviceId})
           AND chunk.stream=CASE record.stream WHEN 1 THEN 'usage' WHEN 2 THEN 'quota' ELSE 'session' END
          JOIN ${table(schema, "typed_v11_admission_state")} admission_state
            ON admission_state.id=1 AND admission_state.namespace_id=record.namespace_id
           AND admission_state.source_namespace=membership.source_namespace
          JOIN ${table(schema, "typed_v11_chunk_allocations")} allocation
            ON allocation.chunk_id=chunk.id AND allocation.namespace_id=record.namespace_id
           AND allocation.chunk_original=typed_chunk.original_id
           AND allocation.record_count=chunk.record_count
          JOIN ${table(schema, "typed_v11_manifest_memberships")} manifest_membership
            ON manifest_membership.manifest_id=manifest.id
           AND manifest_membership.typed_manifest_id=typed_manifest.id
          JOIN ${table(schema, "typed_v11_record_proofs")} proof
            ON proof.typed_record_id=record.id AND proof.chunk_key=typed_chunk.id
           AND proof.manifest_key=typed_manifest.id AND proof.stream_code=record.stream
           AND proof.occurrence_blob=record.occurrence_id AND proof.base_digest=record.canonical_digest
           AND proof.observed_at_ms=record.observed_at_ms
         WHERE event.participant_id=membership.participant_id
           AND membership.source_namespace=$1
           AND (owner_link.state<>'erased' OR erased.owner_digest IS NOT NULL)
           AND record.source_row_id>=allocation.first_source_row_id
           AND record.source_row_id<allocation.first_source_row_id+allocation.record_count
           AND chunk.record_count=(SELECT count(*) FROM ${table(schema, "typed_v11_record_proofs")} proved
             WHERE proved.chunk_key=typed_chunk.id AND proved.manifest_key=typed_manifest.id)
           AND chunk.record_count=(SELECT count(*) FROM ${table(schema, "typed_telemetry_records")} typed_record
             WHERE typed_record.chunk_id=typed_chunk.id AND typed_record.format=11)
      ))`;
}

function v1ExistsSql(schema: string, participantExpr: string, ownerExpr: string, namespaceExpr: string): string {
  const chunkText = typedIdTextSql("typed_chunk.original_id");
  const deviceText = typedIdTextSql("typed_device.original_id");
  return `EXISTS (
    SELECT 1
      FROM ${table(schema, "typed_telemetry_owner_memberships")} membership
      JOIN ${table(schema, "typed_telemetry_owners")} typed_owner
        ON typed_owner.id=membership.owner_id AND typed_owner.namespace_id=membership.namespace_id
      JOIN ${table(schema, "typed_telemetry_records")} record
        ON record.namespace_id=membership.namespace_id AND record.owner_id=typed_owner.id
       AND record.format=10
      JOIN ${table(schema, "typed_telemetry_devices")} typed_device
        ON typed_device.id=record.device_id AND typed_device.namespace_id=record.namespace_id
       AND typed_device.owner_id=record.owner_id
      JOIN ${table(schema, "typed_telemetry_chunks")} typed_chunk
        ON typed_chunk.id=record.chunk_id AND typed_chunk.namespace_id=record.namespace_id
       AND typed_chunk.format=record.format AND typed_chunk.owner_id=record.owner_id
       AND typed_chunk.device_id=record.device_id AND typed_chunk.stream=record.stream
      JOIN ${table(schema, "typed_v1_event_sources")} event
        ON event.source_namespace=membership.source_namespace
       AND event.participant_id=membership.participant_id AND event.owner_digest=${ownerExpr}
      JOIN ${table(schema, "telemetry_v1_chunks")} chunk
        ON chunk.id=event.chunk_id AND (${chunkText})=chunk.id
       AND chunk.participant_id=membership.participant_id AND chunk.device_id=(${deviceText})
       AND chunk.stream=CASE record.stream WHEN 1 THEN 'usage' WHEN 2 THEN 'quota' ELSE 'session' END
       AND chunk.superseded_at IS NULL AND chunk.accepted_record_count=chunk.record_count
      JOIN ${table(schema, "typed_v1_admission_state")} admission_state
        ON admission_state.id=1 AND admission_state.namespace_id=record.namespace_id
       AND admission_state.source_namespace=membership.source_namespace
      JOIN ${table(schema, "typed_v1_chunk_allocations")} allocation
        ON allocation.chunk_id=chunk.id AND allocation.namespace_id=record.namespace_id
       AND allocation.chunk_original=typed_chunk.original_id
       AND allocation.record_count=chunk.record_count
      JOIN ${table(schema, "typed_v1_record_admissions")} admission
        ON admission.typed_record_id=record.id AND admission.chunk_id=chunk.id
       AND record.source_row_id>=allocation.first_source_row_id
       AND record.source_row_id<allocation.first_source_row_id+allocation.record_count
       AND record.observed_day=(chunk.chunk_day-DATE '1970-01-01')::integer
       AND chunk.record_count=(SELECT count(*) FROM ${table(schema, "typed_v1_record_admissions")} admitted
         WHERE admitted.chunk_id=chunk.id)
       AND chunk.record_count=(SELECT count(*) FROM ${table(schema, "typed_telemetry_records")} typed_record
         WHERE typed_record.chunk_id=typed_chunk.id AND typed_record.format=10)
       AND EXISTS (SELECT 1 FROM ${table(schema, "storage_v11_owner_links")} owner_link
         WHERE owner_link.participant_id=event.participant_id AND owner_link.owner_digest=event.owner_digest
           AND owner_link.state='active')
     WHERE membership.participant_id=${participantExpr} AND membership.source_namespace=${namespaceExpr}
       AND membership.source_format=10)`;
}

function v11ExistsSql(schema: string, participantExpr: string, ownerExpr: string, namespaceExpr: string): string {
  const chunkText = typedIdTextSql("typed_chunk.original_id");
  const deviceText = typedIdTextSql("typed_device.original_id");
  const manifestText = typedIdTextSql("typed_manifest.original_id");
  return `EXISTS (
    SELECT 1
      FROM ${table(schema, "typed_telemetry_owner_memberships")} membership
      JOIN ${table(schema, "typed_telemetry_owners")} typed_owner
        ON typed_owner.id=membership.owner_id AND typed_owner.namespace_id=membership.namespace_id
      JOIN ${table(schema, "typed_telemetry_records")} record
        ON record.namespace_id=membership.namespace_id AND record.owner_id=typed_owner.id
       AND record.format=11
      JOIN ${table(schema, "typed_telemetry_devices")} typed_device
        ON typed_device.id=record.device_id AND typed_device.namespace_id=record.namespace_id
       AND typed_device.owner_id=record.owner_id
      JOIN ${table(schema, "typed_telemetry_chunks")} typed_chunk
        ON typed_chunk.id=record.chunk_id AND typed_chunk.namespace_id=record.namespace_id
       AND typed_chunk.format=record.format AND typed_chunk.owner_id=record.owner_id
       AND typed_chunk.device_id=record.device_id AND typed_chunk.stream=record.stream
      JOIN ${table(schema, "typed_telemetry_manifests")} typed_manifest
        ON typed_manifest.id=record.manifest_id AND typed_manifest.namespace_id=record.namespace_id
       AND typed_manifest.owner_id=record.owner_id AND typed_manifest.device_id=record.device_id
      JOIN ${table(schema, "storage_v11_event_sources")} event
        ON event.participant_id=membership.participant_id AND event.owner_digest=${ownerExpr}
      JOIN ${table(schema, "telemetry_v11_domains")} generation
        ON generation.id=event.generation_id AND generation.participant_id=event.participant_id
       AND generation.device_id=event.device_id AND generation.manifest_digest=event.manifest_digest
       AND generation.from_day=event.from_day AND generation.through_day=event.through_day
       AND generation.input_revision=event.input_revision
      JOIN ${table(schema, "telemetry_v11_domain_days")} domain_day
        ON domain_day.generation_id=generation.id
      JOIN ${table(schema, "telemetry_v11_day_manifests")} manifest
        ON manifest.id=domain_day.manifest_id AND manifest.state='ready'
       AND manifest.participant_id=generation.participant_id AND manifest.device_id=generation.device_id
       AND manifest.chunk_day=domain_day.observed_day
       AND (${manifestText})=manifest.id AND typed_manifest.chunk_day=record.observed_day
      JOIN ${table(schema, "telemetry_v11_chunks")} chunk
        ON chunk.id=(${chunkText}) AND chunk.manifest_id=manifest.id
       AND chunk.participant_id=membership.participant_id AND chunk.device_id=generation.device_id
       AND chunk.device_id=(${deviceText})
       AND chunk.stream=CASE record.stream WHEN 1 THEN 'usage' WHEN 2 THEN 'quota' ELSE 'session' END
      JOIN ${table(schema, "typed_v11_admission_state")} admission_state
        ON admission_state.id=1 AND admission_state.namespace_id=record.namespace_id
       AND admission_state.source_namespace=membership.source_namespace
      JOIN ${table(schema, "typed_v11_chunk_allocations")} allocation
        ON allocation.chunk_id=chunk.id AND allocation.namespace_id=record.namespace_id
       AND allocation.chunk_original=typed_chunk.original_id
       AND allocation.record_count=chunk.record_count
      JOIN ${table(schema, "typed_v11_manifest_memberships")} manifest_membership
        ON manifest_membership.manifest_id=manifest.id
       AND manifest_membership.typed_manifest_id=typed_manifest.id
      JOIN ${table(schema, "typed_v11_record_proofs")} proof
        ON proof.typed_record_id=record.id AND proof.chunk_key=typed_chunk.id
       AND proof.manifest_key=typed_manifest.id AND proof.stream_code=record.stream
       AND proof.occurrence_blob=record.occurrence_id AND proof.base_digest=record.canonical_digest
       AND proof.observed_at_ms=record.observed_at_ms
       AND record.source_row_id>=allocation.first_source_row_id
       AND record.source_row_id<allocation.first_source_row_id+allocation.record_count
       AND chunk.record_count=(SELECT count(*) FROM ${table(schema, "typed_v11_record_proofs")} proved
         WHERE proved.chunk_key=typed_chunk.id AND proved.manifest_key=typed_manifest.id)
       AND chunk.record_count=(SELECT count(*) FROM ${table(schema, "typed_telemetry_records")} typed_record
         WHERE typed_record.chunk_id=typed_chunk.id AND typed_record.format=11)
      JOIN ${table(schema, "storage_v11_owner_links")} owner_link
        ON owner_link.participant_id=event.participant_id AND owner_link.owner_digest=event.owner_digest
       AND owner_link.state='active'
      JOIN ${table(schema, "device_credentials")} device
        ON device.id=generation.device_id AND device.participant_id=generation.participant_id
       AND device.state='active'
     WHERE membership.participant_id=${participantExpr} AND membership.source_namespace=${namespaceExpr}
       AND membership.source_format=11)`;
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
  return `(CASE ${cases.map(([tag, value, minimum, maximum]) =>
    `WHEN get_byte(${column},0)=${tag} AND octet_length(${column}) BETWEEN ${minimum} AND ${maximum} THEN ${value}`).join(" ")} ELSE NULL END)`;
}

function historyFlagsSql(schema: string): string {
  return `SELECT ${v1ExistsSql(schema, "participant.id", "owner.owner_digest", "$2")} AS has_v1,
      ${v11ExistsSql(schema, "participant.id", "owner.owner_digest", "$2")} AS has_v11,
      EXISTS (
        SELECT 1 FROM ${table(schema, "telemetry_v12_domain_heads")} head
        JOIN ${table(schema, "telemetry_v12_runtime")} runtime ON runtime.id=1 AND runtime.state='active'
        JOIN ${table(schema, "telemetry_v12_domains")} generation
          ON generation.id=head.generation_id AND generation.participant_id=head.participant_id
        JOIN ${table(schema, "telemetry_v12_domain_days")} domain_day ON domain_day.generation_id=generation.id
        JOIN ${table(schema, "telemetry_v12_day_manifests")} manifest
          ON manifest.id=domain_day.manifest_id AND manifest.state='ready'
         AND manifest.manifest_digest=domain_day.manifest_digest
        JOIN ${table(schema, "telemetry_v12_chunks")} chunk
          ON chunk.manifest_id=manifest.id AND chunk.participant_id=generation.participant_id
         AND chunk.device_id=generation.device_id AND chunk.chunk_day=manifest.chunk_day
        JOIN ${table(schema, "telemetry_v12_typed_records")} record ON record.chunk_id=chunk.id
        JOIN ${table(schema, "telemetry_v12_typed_active_authorizations")} auth
          ON auth.participant_id=generation.participant_id AND auth.device_id=generation.device_id
        JOIN ${table(schema, "telemetry_v12_typed_runtime")} typed_runtime
          ON typed_runtime.id=1 AND typed_runtime.state='active'
        WHERE head.participant_id=participant.id
      ) AS has_v12`;
}

interface HistoryFlagsRow {
  has_v1: boolean;
  has_v11: boolean;
  has_v12: boolean;
}

interface OwnerListRow extends OwnerScopeRow, HistoryFlagsRow {}

function ownerFromRow(row: OwnerListRow, sourcePin: PostgresEffectiveSourcePin): PostgresEffectiveOwner {
  const pin = ownerPin(sourcePin, row);
  const hasLegacy = row.has_v1 || row.has_v11;
  // D1 calls legacy v1/v1.1 effective only when its additive correction
  // authority is present. That family is not transferred into PostgreSQL yet,
  // so legacy-only sources remain readable for quota/session while effective
  // usage and graph inputs stay unavailable. Typed v1.2 has its own complete
  // active authorization lane.
  const hasEffective = row.has_v12;
  return Object.freeze({
    ownerDigest: pin.ownerDigest,
    participantId: pin.participantId,
    inputRevision: pin.inputRevision,
    ownerRevision: pin.ownerRevision,
    authorityEpoch: pin.authorityEpoch,
    hasV1: row.has_v1,
    hasV11: row.has_v11,
    hasV12: row.has_v12,
    hasLegacy,
    hasEffective,
    pin,
  });
}

function normalizeOwnersCursor(value: PostgresEffectiveOwnersCursor | undefined): PostgresEffectiveOwnersCursor | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "ownerDigest,sourcePin"
      || !OWNER_DIGEST.test(value.ownerDigest)) fail("POSTGRES_LEGACY_EFFECTIVE_INVALID");
  return Object.freeze({ ownerDigest: value.ownerDigest, sourcePin: normalizeSourcePinInput(value.sourcePin) });
}

/** List the active, effective source owners in stable owner-digest order. Both
 * legacy-family receipts are mandatory: without them, an empty membership set
 * cannot distinguish an empty owner from a family that was never copied. */
export async function listPostgresEffectiveOwners(
  pool: PostgresPool,
  input: ListPostgresEffectiveOwnersOptions,
): Promise<PostgresEffectiveOwnersPage> {
  try {
    return await withPostgresRead(pool, async (client) => {
      return await listPostgresEffectiveOwnersOnClient(client, input);
    }, { operation: "legacy_effective.owners", statementTimeoutMilliseconds: 15_000, lockTimeoutMilliseconds: 5_000,
      preserveSafeError: (error) => error instanceof PostgresLegacyEffectiveError ? error : null });
  } catch (error) {
    if (error instanceof PostgresLegacyEffectiveError) throw error;
    throw new PostgresLegacyEffectiveError("POSTGRES_LEGACY_EFFECTIVE_UNAVAILABLE");
  }
}

/** Read one bounded effective-owner page on an already-owned transaction
 * client. This lets compound callers keep publication paging and owner locks
 * on one pool connection instead of opening a nested connection per page. */
export async function listPostgresEffectiveOwnersOnClient(
  client: PostgresClient,
  input: ListPostgresEffectiveOwnersOptions,
): Promise<PostgresEffectiveOwnersPage> {
  try {
    const identity = normalizeIdentity(input);
    const schema = schemaName(input);
    const after = normalizeOwnersCursor(input.after);
    const limit = normalizeLimit(input.limit);
    await assertSchema(client, schema);
    const sourcePin = await readGlobalPin(client, schema, identity);
    if (after && !sameSourcePin(sourcePin, after.sourcePin)) {
      fail("POSTGRES_LEGACY_EFFECTIVE_CAS_MISMATCH");
    }
    const flags = historyFlagsSql(schema);
    const result = await client.query<OwnerListRow>(
      `SELECT link.participant_id,owner.owner_digest,owner.revision AS owner_revision,
              owner.authority_epoch,input.revision AS input_revision,
              (COALESCE(runtime.state,'missing')||':'||COALESCE(typed_runtime.state,'missing')) AS v12_state,
              head.generation_id AS v12_generation_id,
              flags.has_v1,flags.has_v11,flags.has_v12
         FROM ${table(schema, "storage_v11_owner_links")} link
         JOIN ${table(schema, "participants")} participant
           ON participant.id=link.participant_id AND participant.state='active'
         JOIN ${table(schema, "analytics_owner_state")} owner
           ON owner.owner_digest=link.owner_digest AND owner.source_id=$1 AND owner.state='active'
         JOIN ${table(schema, "community_analytical_input_versions")} input
           ON input.participant_id=participant.id
         LEFT JOIN ${table(schema, "telemetry_v12_runtime")} runtime ON runtime.id=1
         LEFT JOIN ${table(schema, "telemetry_v12_typed_runtime")} typed_runtime ON typed_runtime.id=1
         LEFT JOIN ${table(schema, "telemetry_v12_domain_heads")} head
           ON head.participant_id=participant.id
         CROSS JOIN LATERAL (${flags}) flags
        WHERE link.state='active'
          AND NOT EXISTS (SELECT 1 FROM ${table(schema, "storage_owner_erasure_receipts")} erased
                           WHERE erased.owner_digest=link.owner_digest)
          AND (flags.has_v1 OR flags.has_v11 OR flags.has_v12)
          AND ($3::text IS NULL OR owner.owner_digest COLLATE "C" > $3::text COLLATE "C")
        ORDER BY owner.owner_digest COLLATE "C" LIMIT $4`,
      [identity.sourceId, identity.sourceNamespace, after?.ownerDigest ?? null, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    const owners = result.rows.slice(0, limit).map((row) => ownerFromRow(row, sourcePin));
    const next = hasMore && owners.length > 0
      ? Object.freeze({ ownerDigest: owners.at(-1)!.ownerDigest, sourcePin }) : null;
    return Object.freeze({ available: true, sourceId: identity.sourceId, sourceNamespace: identity.sourceNamespace,
      owners: Object.freeze(owners), sourcePin, next });
  } catch (error) {
    if (error instanceof PostgresLegacyEffectiveError) throw error;
    throw new PostgresLegacyEffectiveError("POSTGRES_LEGACY_EFFECTIVE_UNAVAILABLE");
  }
}

function candidateSql(schema: string): string {
  const occurrence = typedIdTextSql("record.occurrence_id");
  const v1ChunkText = typedIdTextSql("typed_chunk.original_id");
  const v1DeviceText = typedIdTextSql("typed_device.original_id");
  const v11ChunkText = typedIdTextSql("typed_chunk.original_id");
  const v11DeviceText = typedIdTextSql("typed_device.original_id");
  const v11ManifestText = typedIdTextSql("typed_manifest.original_id");
  return `WITH direct AS (
    SELECT (${occurrence}) COLLATE "C" AS occurrence_id,record.observed_at_ms
      FROM ${table(schema, "typed_telemetry_owner_memberships")} membership
      JOIN ${table(schema, "typed_telemetry_records")} record
        ON record.namespace_id=membership.namespace_id AND record.owner_id=membership.owner_id
       AND record.format=membership.source_format AND record.stream=$4
      JOIN ${table(schema, "typed_telemetry_devices")} typed_device
        ON typed_device.id=record.device_id AND typed_device.namespace_id=record.namespace_id
       AND typed_device.owner_id=record.owner_id
      JOIN ${table(schema, "typed_telemetry_chunks")} typed_chunk
        ON typed_chunk.id=record.chunk_id AND typed_chunk.namespace_id=record.namespace_id
       AND typed_chunk.format=record.format AND typed_chunk.owner_id=record.owner_id
       AND typed_chunk.device_id=record.device_id AND typed_chunk.stream=record.stream
      JOIN ${table(schema, "typed_v1_event_sources")} event
        ON event.participant_id=membership.participant_id
       AND event.source_namespace=membership.source_namespace AND event.owner_digest=$1
      JOIN ${table(schema, "telemetry_v1_chunks")} chunk
        ON chunk.id=event.chunk_id AND (${v1ChunkText})=chunk.id
       AND chunk.participant_id=membership.participant_id AND chunk.device_id=(${v1DeviceText})
       AND chunk.stream=CASE record.stream WHEN 1 THEN 'usage' WHEN 2 THEN 'quota' ELSE 'session' END
       AND chunk.superseded_at IS NULL AND chunk.accepted_record_count=chunk.record_count
      JOIN ${table(schema, "typed_v1_admission_state")} admission_state
        ON admission_state.id=1 AND admission_state.namespace_id=record.namespace_id
       AND admission_state.source_namespace=membership.source_namespace
      JOIN ${table(schema, "typed_v1_chunk_allocations")} allocation
        ON allocation.chunk_id=chunk.id AND allocation.namespace_id=record.namespace_id
       AND allocation.chunk_original=typed_chunk.original_id
       AND allocation.record_count=chunk.record_count
      JOIN ${table(schema, "typed_v1_record_admissions")} admission
        ON admission.typed_record_id=record.id AND admission.chunk_id=chunk.id
       AND record.source_row_id>=allocation.first_source_row_id
       AND record.source_row_id<allocation.first_source_row_id+allocation.record_count
       AND record.observed_day=(chunk.chunk_day-DATE '1970-01-01')::integer
       AND chunk.record_count=(SELECT count(*) FROM ${table(schema, "typed_v1_record_admissions")} admitted
         WHERE admitted.chunk_id=chunk.id)
       AND chunk.record_count=(SELECT count(*) FROM ${table(schema, "typed_telemetry_records")} typed_record
         WHERE typed_record.chunk_id=typed_chunk.id AND typed_record.format=10)
       AND EXISTS (SELECT 1 FROM ${table(schema, "storage_v11_owner_links")} owner_link
         WHERE owner_link.participant_id=event.participant_id AND owner_link.owner_digest=event.owner_digest
           AND owner_link.state='active')
     WHERE membership.participant_id=$2 AND membership.source_namespace=$3 AND membership.source_format=10
       AND record.observed_day=$5
    UNION ALL
    SELECT (${occurrence}) COLLATE "C" AS occurrence_id,record.observed_at_ms
      FROM ${table(schema, "typed_telemetry_owner_memberships")} membership
      JOIN ${table(schema, "typed_telemetry_records")} record
        ON record.namespace_id=membership.namespace_id AND record.owner_id=membership.owner_id
       AND record.format=membership.source_format AND record.stream=$4
      JOIN ${table(schema, "typed_telemetry_devices")} typed_device
        ON typed_device.id=record.device_id AND typed_device.namespace_id=record.namespace_id
       AND typed_device.owner_id=record.owner_id
      JOIN ${table(schema, "typed_telemetry_chunks")} typed_chunk
        ON typed_chunk.id=record.chunk_id AND typed_chunk.namespace_id=record.namespace_id
       AND typed_chunk.format=record.format AND typed_chunk.owner_id=record.owner_id
       AND typed_chunk.device_id=record.device_id AND typed_chunk.stream=record.stream
      JOIN ${table(schema, "typed_telemetry_manifests")} typed_manifest
        ON typed_manifest.id=record.manifest_id AND typed_manifest.namespace_id=record.namespace_id
       AND typed_manifest.owner_id=record.owner_id AND typed_manifest.device_id=record.device_id
      JOIN ${table(schema, "storage_v11_event_sources")} event
        ON event.participant_id=membership.participant_id AND event.owner_digest=$1
      JOIN ${table(schema, "telemetry_v11_domains")} generation
        ON generation.id=event.generation_id AND generation.participant_id=event.participant_id
       AND generation.device_id=event.device_id AND generation.manifest_digest=event.manifest_digest
       AND generation.from_day=event.from_day AND generation.through_day=event.through_day
       AND generation.input_revision=event.input_revision
      JOIN ${table(schema, "telemetry_v11_domain_days")} domain_day
        ON domain_day.generation_id=generation.id
       AND domain_day.observed_day=(DATE '1970-01-01'+$5::integer)
      JOIN ${table(schema, "telemetry_v11_day_manifests")} manifest
        ON manifest.id=domain_day.manifest_id AND manifest.state='ready'
       AND manifest.participant_id=generation.participant_id AND manifest.device_id=generation.device_id
       AND manifest.chunk_day=domain_day.observed_day
       AND (${v11ManifestText})=manifest.id AND typed_manifest.chunk_day=record.observed_day
      JOIN ${table(schema, "telemetry_v11_chunks")} chunk
        ON chunk.id=(${v11ChunkText}) AND chunk.manifest_id=manifest.id
       AND chunk.participant_id=membership.participant_id AND chunk.device_id=generation.device_id
       AND chunk.device_id=(${v11DeviceText})
       AND chunk.stream=CASE record.stream WHEN 1 THEN 'usage' WHEN 2 THEN 'quota' ELSE 'session' END
      JOIN ${table(schema, "typed_v11_admission_state")} admission_state
        ON admission_state.id=1 AND admission_state.namespace_id=record.namespace_id
       AND admission_state.source_namespace=membership.source_namespace
      JOIN ${table(schema, "typed_v11_chunk_allocations")} allocation
        ON allocation.chunk_id=chunk.id AND allocation.namespace_id=record.namespace_id
       AND allocation.chunk_original=typed_chunk.original_id
       AND allocation.record_count=chunk.record_count
      JOIN ${table(schema, "typed_v11_manifest_memberships")} manifest_membership
        ON manifest_membership.manifest_id=manifest.id
       AND manifest_membership.typed_manifest_id=typed_manifest.id
      JOIN ${table(schema, "typed_v11_record_proofs")} proof
        ON proof.typed_record_id=record.id AND proof.chunk_key=typed_chunk.id
       AND proof.manifest_key=typed_manifest.id AND proof.stream_code=record.stream
       AND proof.occurrence_blob=record.occurrence_id AND proof.base_digest=record.canonical_digest
       AND proof.observed_at_ms=record.observed_at_ms
       AND record.source_row_id>=allocation.first_source_row_id
       AND record.source_row_id<allocation.first_source_row_id+allocation.record_count
       AND chunk.record_count=(SELECT count(*) FROM ${table(schema, "typed_v11_record_proofs")} proved
         WHERE proved.chunk_key=typed_chunk.id AND proved.manifest_key=typed_manifest.id)
       AND chunk.record_count=(SELECT count(*) FROM ${table(schema, "typed_telemetry_records")} typed_record
         WHERE typed_record.chunk_id=typed_chunk.id AND typed_record.format=11)
      JOIN ${table(schema, "storage_v11_owner_links")} owner_link
        ON owner_link.participant_id=event.participant_id AND owner_link.owner_digest=event.owner_digest
       AND owner_link.state='active'
      JOIN ${table(schema, "device_credentials")} device
        ON device.id=generation.device_id AND device.participant_id=generation.participant_id
       AND device.state='active'
     WHERE membership.participant_id=$2 AND membership.source_namespace=$3 AND membership.source_format=11
       AND record.observed_day=$5
  ), grouped AS MATERIALIZED (
    SELECT occurrence_id,MIN(observed_at_ms) AS observed_at_ms FROM direct GROUP BY occurrence_id
  )
  SELECT occurrence_id,observed_at_ms FROM grouped
   WHERE observed_at_ms>$6 OR (observed_at_ms=$6 AND occurrence_id COLLATE "C">$7::text COLLATE "C")
   ORDER BY observed_at_ms,occurrence_id COLLATE "C" LIMIT $8`;
}

async function readLegacyCandidates(
  pool: PostgresPool,
  schema: string,
  pin: PostgresEffectiveOwnerPin,
  streamName: PostgresEffectiveStream,
  day: string,
  after: PostgresEffectiveCursor,
  limit: number,
): Promise<{ rows: readonly CandidateRow[]; hasMore: boolean }> {
  const result = await withPostgresRead(pool, async (client) => {
    await assertSchema(client, schema);
    const identity = normalizeIdentity(pin);
    const sourcePin = await readGlobalPin(client, schema, identity);
    const livePin = await readOwnerScope(client, schema, identity, sourcePin, pin.ownerDigest);
    if (!sameOwnerPin(livePin, pin)) fail("POSTGRES_LEGACY_EFFECTIVE_CAS_MISMATCH");
    return client.query<CandidateRow>(candidateSql(schema), [pin.ownerDigest, pin.participantId,
      identity.sourceNamespace, STREAM_CODES[streamName], dayNumber(day), after.observedAtMs,
      after.occurrenceId, limit + 1]);
  }, { operation: "legacy_effective.candidates", statementTimeoutMilliseconds: 15_000, lockTimeoutMilliseconds: 5_000,
    preserveSafeError: (error) => error instanceof PostgresLegacyEffectiveError ? error : null });
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit).map((row) => {
    if (typeof row.occurrence_id !== "string" || !OCCURRENCE.test(row.occurrence_id)) UNAVAILABLE();
    return Object.freeze({ occurrence_id: row.occurrence_id,
      observed_at_ms: integer(row.observed_at_ms, MIN_MS, MAX_MS) });
  });
  return { rows: Object.freeze(rows), hasMore };
}

function sourceRowsSql(schema: string): string {
  const occurrence = typedIdTextSql("record.occurrence_id");
  const device = typedIdTextSql("record.device_id");
  const v1Device = typedIdTextSql("typed_device.original_id");
  const v1ChunkText = typedIdTextSql("typed_chunk.original_id");
  const v11ChunkText = typedIdTextSql("typed_chunk.original_id");
  const v11Device = typedIdTextSql("typed_device.original_id");
  const v11ManifestText = typedIdTextSql("typed_manifest.original_id");
  return `WITH requested(occurrence_id) AS MATERIALIZED (
    SELECT value FROM jsonb_array_elements_text($4::jsonb) value
  ), direct AS (
    SELECT record.id AS storage_row_id,record.source_row_id,record.format,record.stream,
           (${occurrence}) COLLATE "C" AS occurrence_key,
           record.occurrence_id,record.observed_at_ms,record.canonical_digest,typed_device.original_id AS device_id
      FROM ${table(schema, "typed_telemetry_owner_memberships")} membership
      JOIN ${table(schema, "typed_telemetry_records")} record
        ON record.namespace_id=membership.namespace_id AND record.owner_id=membership.owner_id
       AND record.format=membership.source_format AND record.stream=$5
      JOIN requested selected ON selected.occurrence_id=(${occurrence})
      JOIN ${table(schema, "typed_telemetry_devices")} typed_device
        ON typed_device.id=record.device_id AND typed_device.namespace_id=record.namespace_id
       AND typed_device.owner_id=record.owner_id
      JOIN ${table(schema, "typed_telemetry_chunks")} typed_chunk
        ON typed_chunk.id=record.chunk_id AND typed_chunk.namespace_id=record.namespace_id
       AND typed_chunk.format=record.format AND typed_chunk.owner_id=record.owner_id
       AND typed_chunk.device_id=record.device_id AND typed_chunk.stream=record.stream
      JOIN ${table(schema, "typed_v1_event_sources")} event
        ON event.participant_id=membership.participant_id
       AND event.source_namespace=membership.source_namespace AND event.owner_digest=$1
      JOIN ${table(schema, "telemetry_v1_chunks")} chunk
        ON chunk.id=event.chunk_id AND (${v1ChunkText})=chunk.id
       AND chunk.participant_id=membership.participant_id AND chunk.device_id=(${v1Device})
       AND chunk.stream=CASE record.stream WHEN 1 THEN 'usage' WHEN 2 THEN 'quota' ELSE 'session' END
       AND chunk.superseded_at IS NULL AND chunk.accepted_record_count=chunk.record_count
      JOIN ${table(schema, "typed_v1_admission_state")} admission_state
        ON admission_state.id=1 AND admission_state.namespace_id=record.namespace_id
       AND admission_state.source_namespace=membership.source_namespace
      JOIN ${table(schema, "typed_v1_chunk_allocations")} allocation
        ON allocation.chunk_id=chunk.id AND allocation.namespace_id=record.namespace_id
       AND allocation.chunk_original=typed_chunk.original_id
       AND allocation.record_count=chunk.record_count
      JOIN ${table(schema, "typed_v1_record_admissions")} admission
        ON admission.typed_record_id=record.id AND admission.chunk_id=chunk.id
       AND record.source_row_id>=allocation.first_source_row_id
       AND record.source_row_id<allocation.first_source_row_id+allocation.record_count
       AND record.observed_day=(chunk.chunk_day-DATE '1970-01-01')::integer
       AND chunk.record_count=(SELECT count(*) FROM ${table(schema, "typed_v1_record_admissions")} admitted
         WHERE admitted.chunk_id=chunk.id)
       AND chunk.record_count=(SELECT count(*) FROM ${table(schema, "typed_telemetry_records")} typed_record
         WHERE typed_record.chunk_id=typed_chunk.id AND typed_record.format=10)
       AND EXISTS (SELECT 1 FROM ${table(schema, "storage_v11_owner_links")} owner_link
         WHERE owner_link.participant_id=event.participant_id AND owner_link.owner_digest=event.owner_digest
           AND owner_link.state='active')
     WHERE membership.participant_id=$2 AND membership.source_namespace=$3
       AND membership.source_format=10
    UNION ALL
    SELECT record.id AS storage_row_id,record.source_row_id,record.format,record.stream,
           (${occurrence}) COLLATE "C" AS occurrence_key,
           record.occurrence_id,record.observed_at_ms,record.canonical_digest,typed_device.original_id AS device_id
      FROM ${table(schema, "typed_telemetry_owner_memberships")} membership
      JOIN ${table(schema, "typed_telemetry_records")} record
        ON record.namespace_id=membership.namespace_id AND record.owner_id=membership.owner_id
       AND record.format=membership.source_format AND record.stream=$5
      JOIN requested selected ON selected.occurrence_id=(${occurrence})
      JOIN ${table(schema, "typed_telemetry_devices")} typed_device
        ON typed_device.id=record.device_id AND typed_device.namespace_id=record.namespace_id
       AND typed_device.owner_id=record.owner_id
      JOIN ${table(schema, "typed_telemetry_chunks")} typed_chunk
        ON typed_chunk.id=record.chunk_id AND typed_chunk.namespace_id=record.namespace_id
       AND typed_chunk.format=record.format AND typed_chunk.owner_id=record.owner_id
       AND typed_chunk.device_id=record.device_id AND typed_chunk.stream=record.stream
      JOIN ${table(schema, "typed_telemetry_manifests")} typed_manifest
        ON typed_manifest.id=record.manifest_id AND typed_manifest.namespace_id=record.namespace_id
       AND typed_manifest.owner_id=record.owner_id AND typed_manifest.device_id=record.device_id
      JOIN ${table(schema, "storage_v11_event_sources")} event
        ON event.participant_id=membership.participant_id AND event.owner_digest=$1
      JOIN ${table(schema, "telemetry_v11_domains")} generation
        ON generation.id=event.generation_id AND generation.participant_id=event.participant_id
       AND generation.device_id=event.device_id AND generation.manifest_digest=event.manifest_digest
       AND generation.from_day=event.from_day AND generation.through_day=event.through_day
       AND generation.input_revision=event.input_revision
      JOIN ${table(schema, "telemetry_v11_domain_days")} domain_day
        ON domain_day.generation_id=generation.id
       AND domain_day.observed_day=(DATE '1970-01-01'+record.observed_day)
      JOIN ${table(schema, "telemetry_v11_day_manifests")} manifest
        ON manifest.id=domain_day.manifest_id AND manifest.state='ready'
       AND manifest.participant_id=generation.participant_id AND manifest.device_id=generation.device_id
       AND manifest.chunk_day=domain_day.observed_day AND (${v11ManifestText})=manifest.id
       AND typed_manifest.chunk_day=record.observed_day
      JOIN ${table(schema, "telemetry_v11_chunks")} chunk
        ON chunk.id=(${v11ChunkText}) AND chunk.manifest_id=manifest.id
       AND chunk.participant_id=membership.participant_id AND chunk.device_id=generation.device_id
       AND chunk.device_id=(${v11Device})
       AND chunk.stream=CASE record.stream WHEN 1 THEN 'usage' WHEN 2 THEN 'quota' ELSE 'session' END
      JOIN ${table(schema, "typed_v11_admission_state")} admission_state
        ON admission_state.id=1 AND admission_state.namespace_id=record.namespace_id
       AND admission_state.source_namespace=membership.source_namespace
      JOIN ${table(schema, "typed_v11_chunk_allocations")} allocation
        ON allocation.chunk_id=chunk.id AND allocation.namespace_id=record.namespace_id
       AND allocation.chunk_original=typed_chunk.original_id
       AND allocation.record_count=chunk.record_count
      JOIN ${table(schema, "typed_v11_manifest_memberships")} manifest_membership
        ON manifest_membership.manifest_id=manifest.id
       AND manifest_membership.typed_manifest_id=typed_manifest.id
      JOIN ${table(schema, "typed_v11_record_proofs")} proof
        ON proof.typed_record_id=record.id AND proof.chunk_key=typed_chunk.id
       AND proof.manifest_key=typed_manifest.id AND proof.stream_code=record.stream
       AND proof.occurrence_blob=record.occurrence_id AND proof.base_digest=record.canonical_digest
       AND proof.observed_at_ms=record.observed_at_ms
       AND record.source_row_id>=allocation.first_source_row_id
       AND record.source_row_id<allocation.first_source_row_id+allocation.record_count
       AND chunk.record_count=(SELECT count(*) FROM ${table(schema, "typed_v11_record_proofs")} proved
         WHERE proved.chunk_key=typed_chunk.id AND proved.manifest_key=typed_manifest.id)
       AND chunk.record_count=(SELECT count(*) FROM ${table(schema, "typed_telemetry_records")} typed_record
         WHERE typed_record.chunk_id=typed_chunk.id AND typed_record.format=11)
      JOIN ${table(schema, "storage_v11_owner_links")} owner_link
        ON owner_link.participant_id=event.participant_id AND owner_link.owner_digest=event.owner_digest
       AND owner_link.state='active'
      JOIN ${table(schema, "device_credentials")} device
        ON device.id=generation.device_id AND device.participant_id=generation.participant_id
       AND device.state='active'
     WHERE membership.participant_id=$2 AND membership.source_namespace=$3
       AND membership.source_format=11
  ), deduplicated AS (
    SELECT DISTINCT ON (format,device_id,occurrence_id,observed_at_ms,canonical_digest)
           storage_row_id,source_row_id,format,stream,occurrence_key,occurrence_id,observed_at_ms,canonical_digest,device_id
      FROM direct
     ORDER BY format,device_id,occurrence_id,observed_at_ms,canonical_digest,storage_row_id
  ), selected AS (
    SELECT * FROM deduplicated
     WHERE $6::text IS NULL
        OR occurrence_key > $6::text COLLATE "C"
        OR occurrence_key = $6::text COLLATE "C" AND storage_row_id > $7::bigint
     ORDER BY occurrence_key,storage_row_id LIMIT $8
  )
  SELECT selected.storage_row_id,selected.source_row_id,selected.format,selected.stream,
         selected.occurrence_id,selected.observed_at_ms,selected.canonical_digest,selected.device_id,
         provider.value AS provider,identifier.value AS session_id,
         model.value AS model,speed.value AS speed_mode,tier.value AS api_service_tier,
         surface.value AS surface,billing.value AS billing_surface,effort.value AS reasoning_effort,
         scope.value AS agent_scope,outcome.value AS outcome,
         usage.total_input_context_tokens,usage.input_uncached_tokens,usage.input_cache_read_tokens,
         usage.input_cache_write_tokens,usage.output_text_tokens,usage.output_reasoning_tokens,
         usage.output_combined_tokens,
         dimensions_plan.value AS plan_type,dimensions_variant.value AS plan_variant,
         limit_row.value AS limit_id,slot_row.value AS slot,quota.used_percent,
         quota.window_duration_minutes,quota.resets_at_ms,
         COALESCE(usage_attribution.account_basis,quota_attribution.account_basis) AS account_basis,
         COALESCE(usage_attribution.account_track,quota_attribution.account_track) AS account_track,
         COALESCE(usage_attribution.plan_basis,quota_attribution.plan_basis) AS plan_basis,
         COALESCE(usage_plan.value,quota_plan.value) AS attribution_plan_type,
         COALESCE(usage_attribution.plan_era,quota_attribution.plan_era) AS plan_era,
         CASE WHEN selected.stream=3 THEN COALESCE((
           SELECT jsonb_object_agg(tool.value,tool_count.count)::text
             FROM ${table(schema, "typed_telemetry_session_tools")} tool_count
             JOIN ${table(schema, "typed_telemetry_dictionary")} tool ON tool.id=tool_count.tool_class_id
            WHERE tool_count.record_id=selected.storage_row_id
         ),'{}') ELSE NULL END AS tool_json
    FROM selected
    JOIN ${table(schema, "typed_telemetry_records")} record ON record.id=selected.storage_row_id
    JOIN ${table(schema, "typed_telemetry_dictionary")} provider ON provider.id=record.provider_id
    LEFT JOIN ${table(schema, "typed_telemetry_usage")} usage ON usage.record_id=record.id
    LEFT JOIN ${table(schema, "typed_telemetry_identifiers")} identifier
      ON identifier.id=usage.session_id AND identifier.namespace_id=record.namespace_id AND identifier.owner_id=record.owner_id
    LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} model ON model.id=usage.model_id
    LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} speed ON speed.id=usage.speed_mode_id
    LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} tier ON tier.id=usage.api_service_tier_id
    LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} surface ON surface.id=usage.surface_id
    LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} billing ON billing.id=usage.billing_surface_id
    LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} effort ON effort.id=usage.reasoning_effort_id
    LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} scope ON scope.id=usage.agent_scope_id
    LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} outcome ON outcome.id=usage.outcome_id
    LEFT JOIN ${table(schema, "typed_telemetry_attributions")} usage_attribution ON usage_attribution.id=usage.attribution_id
    LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} usage_plan ON usage_plan.id=usage_attribution.plan_type_id
    LEFT JOIN ${table(schema, "typed_telemetry_quota")} quota ON quota.record_id=record.id
    LEFT JOIN ${table(schema, "typed_telemetry_quota_dimensions")} dimensions
      ON dimensions.id=quota.dimensions_id AND dimensions.namespace_id=record.namespace_id AND dimensions.owner_id=record.owner_id
    LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} dimensions_plan ON dimensions_plan.id=dimensions.plan_type_id
    LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} dimensions_variant ON dimensions_variant.id=dimensions.plan_variant_id
    LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} limit_row ON limit_row.id=quota.limit_id
    LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} slot_row ON slot_row.id=quota.slot_id
    LEFT JOIN ${table(schema, "typed_telemetry_attributions")} quota_attribution
      ON quota_attribution.id=dimensions.attribution_id
    LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} quota_plan ON quota_plan.id=quota_attribution.plan_type_id
   ORDER BY selected.occurrence_key,selected.storage_row_id`;
}

function attribution(row: LegacyStorageRow): TelemetryV11Attribution | null {
  if (row.account_basis === null || row.plan_basis === null || row.attribution_plan_type === null
      || row.account_track === null || row.plan_era === null) {
    if (row.format === 10 || row.stream === 3) return null;
    return UNAVAILABLE();
  }
  const accountBasis = ACCOUNT_BASES[integer(row.account_basis, 0, ACCOUNT_BASES.length - 1)];
  const planBasis = PLAN_BASES[integer(row.plan_basis, 0, PLAN_BASES.length - 1)];
  if (!accountBasis || !planBasis) return UNAVAILABLE();
  const accountTrackBytes = bytes(row.account_track);
  const planEraBytes = bytes(row.plan_era);
  const accountTrackId = accountTrackBytes.length === 0 ? null : decodeTypedTelemetryId(accountTrackBytes);
  const planEraId = planEraBytes.length === 0 ? null : decodeTypedTelemetryId(planEraBytes);
  try {
    return parseTelemetryV11Attribution({ accountBasis, accountTrackId, planBasis,
      planType: text(row.attribution_plan_type, 1, 64), planEraId });
  } catch {
    return UNAVAILABLE();
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return UNAVAILABLE();
  return value as Record<string, unknown>;
}

function tools(value: string | null, row: LegacyStorageRow): Record<string, number> | null {
  if (row.stream !== 3) return null;
  if (typeof value !== "string") return UNAVAILABLE();
  try {
    const parsed: unknown = JSON.parse(value);
    const result: Record<string, number> = {};
    for (const [key, count] of Object.entries(objectRecord(parsed))) {
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return UNAVAILABLE();
      result[key] = count;
    }
    return result;
  } catch {
    return UNAVAILABLE();
  }
}

async function decodeLegacyRow(row: LegacyStorageRow): Promise<LegacySource> {
  const formatCode = integer(row.format, 10, 11);
  if (formatCode !== 10 && formatCode !== 11) return UNAVAILABLE();
  const format: TypedTelemetryFormat = formatCode === 10 ? "v1" : "v11";
  const streamCode = integer(row.stream, 1, 3);
  const streamName = STREAM_NAMES[streamCode];
  if (!streamName || typeof row.provider !== "string") return UNAVAILABLE();
  const fields: TypedTelemetryFields = {
    format,
    stream: streamName,
    occurrenceId: bytes(row.occurrence_id),
    observedAtMs: integer(row.observed_at_ms, MIN_MS, MAX_MS),
    provider: text(row.provider, 1, 64),
    attribution: attribution(row),
    usage: null,
    quota: null,
    tools: null,
  };
  if (streamName === "usage") {
    if (row.session_id === null || row.model === null || row.speed_mode === null || row.api_service_tier === null
        || row.surface === null || row.billing_surface === null || row.reasoning_effort === null
        || row.agent_scope === null || row.outcome === null) return UNAVAILABLE();
    fields.usage = {
      sessionId: bytes(row.session_id),
      modelId: text(row.model, 1, 64),
      speedMode: text(row.speed_mode, 1, 64),
      apiServiceTier: text(row.api_service_tier, 1, 64),
      surface: text(row.surface, 1, 64),
      billingSurface: text(row.billing_surface, 1, 64),
      reasoningEffort: text(row.reasoning_effort, 1, 64),
      agentScope: text(row.agent_scope, 1, 64),
      outcome: text(row.outcome, 1, 64),
      totalInputContextTokens: nullableInteger(row.total_input_context_tokens),
      components: {
        inputUncachedTokens: nullableInteger(row.input_uncached_tokens),
        inputCacheReadTokens: nullableInteger(row.input_cache_read_tokens),
        inputCacheWriteTokens: nullableInteger(row.input_cache_write_tokens),
        outputTextTokens: nullableInteger(row.output_text_tokens),
        outputReasoningTokens: nullableInteger(row.output_reasoning_tokens),
        outputCombinedTokens: nullableInteger(row.output_combined_tokens),
      },
    };
  } else if (streamName === "quota") {
    if (row.plan_type === null || row.plan_variant === null || row.limit_id === null || row.slot === null) return UNAVAILABLE();
    const usedPercent = row.used_percent === null ? null : Number(row.used_percent);
    if (usedPercent !== null && (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100)) return UNAVAILABLE();
    fields.quota = {
      planType: text(row.plan_type, 1, 64),
      planVariant: text(row.plan_variant, 1, 64),
      limitId: text(row.limit_id, 1, 64),
      slot: text(row.slot, 1, 64),
      usedPercent,
      windowDurationMinutes: nullableInteger(row.window_duration_minutes, 527_040),
      resetsAtMs: nullableInteger(row.resets_at_ms, MAX_MS),
    };
  } else {
    fields.tools = tools(row.tool_json, row);
  }
  if ((format === "v1" || streamName === "session") && fields.attribution !== null) return UNAVAILABLE();
  let record: ReturnType<typeof decodeTypedTelemetryRecord>;
  try {
    record = decodeTypedTelemetryRecord(fields);
  } catch {
    return UNAVAILABLE();
  }
  const canonical = canonicalTelemetryV11Json(record);
  const canonicalDigest = hex(row.canonical_digest);
  if (await sha256Hex(canonical) !== canonicalDigest) UNAVAILABLE();
  const projected = genericRecordJson(format, streamName, canonical);
  return Object.freeze({
    format,
    sourceRowId: integer(row.source_row_id, 1),
    storageRowId: integer(row.storage_row_id, 1),
    deviceId: decodeTypedTelemetryId(bytes(row.device_id)),
    occurrenceId: decodeTypedTelemetryId(bytes(row.occurrence_id)),
    observedAtMs: fields.observedAtMs,
    canonicalDigest,
    recordJson: projected,
  });
}

function genericRecordJson(format: TypedTelemetryFormat, streamName: PostgresEffectiveStream, canonical: string): string {
  if (format === "v11") return canonical;
  let value: Record<string, unknown>;
  try {
    value = objectRecord(JSON.parse(canonical));
  } catch {
    return UNAVAILABLE();
  }
  const schemaVersion = value.schemaVersion;
  if (typeof schemaVersion !== "string" || !schemaVersion.endsWith("-v1.0")) return UNAVAILABLE();
  if (streamName !== "session") {
    const planType = streamName === "quota" && typeof value.planType === "string" ? value.planType : "unknown";
    value.accountPlanAttribution = {
      accountBasis: "unavailable",
      accountTrackId: null,
      planBasis: planType === "unknown" ? "unavailable" : "same_source_occurrence",
      planType,
      planEraId: null,
    };
  }
  value.schemaVersion = `${schemaVersion.slice(0, -"v1.0".length)}v1.1`;
  return canonicalTelemetryV11Json(value);
}

async function readLegacySources(
  pool: PostgresPool,
  schema: string,
  pin: PostgresEffectiveOwnerPin,
  streamName: PostgresEffectiveStream,
  occurrenceIds: readonly string[],
  folds: ReadonlyMap<string, EffectiveOccurrenceFold>,
  fetchBatchSize: number,
): Promise<void> {
  if (occurrenceIds.length < 1 || occurrenceIds.length > MAX_PAGE) return;
  await withPostgresRead(pool, async (client) => {
    await assertSchema(client, schema);
    const identity = normalizeIdentity(pin);
    const sourcePin = await readGlobalPin(client, schema, identity);
    const livePin = await readOwnerScope(client, schema, identity, sourcePin, pin.ownerDigest);
    if (!sameOwnerPin(livePin, pin)) fail("POSTGRES_LEGACY_EFFECTIVE_CAS_MISMATCH");
    let afterOccurrenceId: string | null = null;
    let afterStorageRowId: number | null = null;
    while (true) {
      const result: PostgresQueryResult<LegacyStorageRow> = await client.query<LegacyStorageRow>(sourceRowsSql(schema), [pin.ownerDigest, pin.participantId,
        identity.sourceNamespace, JSON.stringify(occurrenceIds), STREAM_CODES[streamName],
        afterOccurrenceId, afterStorageRowId, fetchBatchSize + 1]);
      const rawPage: readonly LegacyStorageRow[] = result.rows.slice(0, fetchBatchSize);
      const decoded: readonly LegacySource[] = await Promise.all(rawPage.map(decodeLegacyRow));
      for (const source of decoded) {
        const fold = folds.get(source.occurrenceId);
        if (!fold) fail("POSTGRES_LEGACY_EFFECTIVE_SOURCE_CONFLICT");
        addFoldRecord(fold, streamName, source.recordJson, source.observedAtMs);
        if (fold.sourceCount === Number.MAX_SAFE_INTEGER) fail("POSTGRES_LEGACY_EFFECTIVE_LIMIT");
        fold.sourceCount += 1;
        fold.sourceFormats.add(source.format);
        const prior = fold.legacyDigest ?? "postgres-legacy-effective-source-v1";
        fold.legacyDigest = await sha256Hex(JSON.stringify([prior, source.format, source.sourceRowId,
          source.deviceId, source.observedAtMs, source.canonicalDigest]));
      }
      if (result.rows.length <= fetchBatchSize) return;
      const last: LegacySource | undefined = decoded.at(-1);
      if (!last) fail("POSTGRES_LEGACY_EFFECTIVE_UNAVAILABLE");
      afterOccurrenceId = last.occurrenceId;
      afterStorageRowId = last.storageRowId;
    }
  }, { operation: "legacy_effective.sources", statementTimeoutMilliseconds: 60_000, lockTimeoutMilliseconds: 5_000,
    preserveSafeError: (error) => error instanceof PostgresLegacyEffectiveError ? error : null });
}

function compareCandidates(left: CandidateRow, right: CandidateRow): number {
  return integer(left.observed_at_ms, MIN_MS, MAX_MS) - integer(right.observed_at_ms, MIN_MS, MAX_MS)
    || (left.occurrence_id < right.occurrence_id ? -1 : left.occurrence_id > right.occurrence_id ? 1 : 0);
}

function parseAttribution(value: unknown): TelemetryV11Attribution {
  try {
    return parseTelemetryV11Attribution(value);
  } catch {
    fail("POSTGRES_LEGACY_EFFECTIVE_SOURCE_CONFLICT");
  }
}

function createOccurrenceFold(candidate: CandidateRow): EffectiveOccurrenceFold {
  return {
    candidate,
    sourceFormats: new Set(),
    sourceCount: 0,
    observedAtMs: null,
    eventTimeConflict: false,
    baseRecordCanonical: null,
    baseRecord: null,
    conflict: false,
    accountTrackSet: false,
    accountTrackId: null,
    accountTrackConflict: false,
    accountFact: null,
    planTypeSet: false,
    planType: null,
    planTypeConflict: false,
    planEraSet: false,
    planEraId: null,
    planEraConflict: false,
    planFact: null,
    legacyDigest: null,
    v12Digest: null,
  };
}

function foldAttribution(fold: EffectiveOccurrenceFold, record: Record<string, unknown>, streamName: PostgresEffectiveStream): void {
  const planType = streamName === "quota" && typeof record.planType === "string" ? record.planType : "unknown";
  const fact = record.accountPlanAttribution === undefined
    ? parseAttribution({ accountBasis: "unavailable", accountTrackId: null,
      planBasis: planType === "unknown" ? "unavailable" : "same_source_occurrence", planType, planEraId: null })
    : parseAttribution(record.accountPlanAttribution);
  if (fact.accountBasis !== "unavailable") {
    if (!fold.accountTrackSet) {
      fold.accountTrackSet = true;
      fold.accountTrackId = fact.accountTrackId;
      fold.accountFact = fact;
    } else if (fold.accountTrackId !== fact.accountTrackId) {
      fold.accountTrackConflict = true;
    } else if (fact.accountBasis === "same_source" && fold.accountFact?.accountBasis !== "same_source") {
      fold.accountFact = fact;
    }
  }
  if (fact.planBasis === "conflicted") fold.planTypeConflict = true;
  if (["unavailable", "conflicted"].includes(fact.planBasis)) return;
  if (!fold.planTypeSet) {
    fold.planTypeSet = true;
    fold.planType = fact.planType;
  } else if (fold.planType !== fact.planType) {
    fold.planTypeConflict = true;
  }
  if (fact.planEraId !== null) {
    if (!fold.planEraSet) {
      fold.planEraSet = true;
      fold.planEraId = fact.planEraId;
    } else if (fold.planEraId !== fact.planEraId) {
      fold.planEraConflict = true;
    }
  }
  if (fold.planFact === null || fact.planBasis === "same_source_occurrence"
      && fold.planFact.planBasis !== "same_source_occurrence") fold.planFact = fact;
}

function addFoldRecord(
  fold: EffectiveOccurrenceFold,
  streamName: PostgresEffectiveStream,
  recordJson: string,
  observedAtMs: number,
): void {
  let record: Record<string, unknown>;
  try {
    record = objectRecord(JSON.parse(recordJson));
  } catch {
    fail("POSTGRES_LEGACY_EFFECTIVE_SOURCE_CONFLICT");
  }
  if (fold.observedAtMs === null) fold.observedAtMs = observedAtMs;
  else if (fold.observedAtMs !== observedAtMs) fold.eventTimeConflict = true;
  let comparison: string;
  if (streamName === "session") comparison = canonicalTelemetryV11Json(record);
  else {
    const { accountPlanAttribution: _attribution, ...base } = record;
    comparison = canonicalTelemetryV11Json(base);
  }
  if (fold.baseRecordCanonical === null) {
    fold.baseRecordCanonical = comparison;
    fold.baseRecord = record;
  } else if (fold.baseRecordCanonical !== comparison) {
    fold.conflict = true;
  }
  if (streamName !== "session") foldAttribution(fold, record, streamName);
}

function finishFoldAttribution(fold: EffectiveOccurrenceFold): TelemetryV11Attribution {
  const account = !fold.accountTrackConflict ? fold.accountFact : null;
  const planConflict = fold.planTypeConflict || fold.planEraConflict;
  const plan = !planConflict && fold.planTypeSet ? fold.planFact : null;
  return parseAttribution({ accountBasis: account?.accountBasis ?? "unavailable",
    accountTrackId: account?.accountTrackId ?? null,
    planBasis: planConflict ? "conflicted" : plan?.planBasis ?? "unavailable",
    planType: plan?.planType ?? "unknown", planEraId: plan ? fold.planEraId : null });
}

async function finishOccurrenceFold(
  fold: EffectiveOccurrenceFold,
  streamName: PostgresEffectiveStream,
  v12Records: readonly PostgresTelemetryV12EffectiveRecord[],
): Promise<PostgresEffectiveOccurrence> {
  const v12 = v12Records.filter((record) => record.occurrenceId === fold.candidate.occurrence_id)
    .slice().sort((left, right) => left.sourceRecordKey < right.sourceRecordKey ? -1
      : left.sourceRecordKey > right.sourceRecordKey ? 1 : 0);
  for (const row of v12) {
    const observedAtMs = Date.parse(row.observedAt);
    if (!Number.isSafeInteger(observedAtMs)) fail("POSTGRES_LEGACY_EFFECTIVE_SOURCE_CONFLICT");
    addFoldRecord(fold, streamName, row.recordJson, observedAtMs);
    if (fold.sourceCount === Number.MAX_SAFE_INTEGER) fail("POSTGRES_LEGACY_EFFECTIVE_LIMIT");
    fold.sourceCount += 1;
    fold.sourceFormats.add("v12");
    const prior = fold.v12Digest ?? "postgres-v12-effective-source-v1";
    fold.v12Digest = await sha256Hex(JSON.stringify([prior, row.sourceRecordKey, observedAtMs,
      await sha256Hex(row.recordJson)]));
  }
  const eventTimeConflict = fold.eventTimeConflict;
  let conflict = fold.conflict || eventTimeConflict || fold.sourceCount === 0;
  let recordJson: string | null = null;
  if (!conflict && fold.baseRecord !== null) {
    try {
      const value = streamName === "session" ? fold.baseRecord : {
        ...fold.baseRecord,
        accountPlanAttribution: finishFoldAttribution(fold),
      };
      recordJson = canonicalTelemetryV11Json(parseTelemetryV11Record(streamName, value));
    } catch {
      conflict = true;
    }
  }
  const sourceFormats = [...fold.sourceFormats].sort() as PostgresEffectiveFormat[];
  const observedAtMs = integer(fold.candidate.observed_at_ms, MIN_MS, MAX_MS);
  const sourceFingerprint = await sha256Hex(JSON.stringify([
    "postgres-effective-occurrence-source-v1",
    fold.candidate.occurrence_id,
    fold.sourceCount,
    sourceFormats,
    fold.legacyDigest ?? "postgres-legacy-effective-source-empty-v1",
    fold.v12Digest ?? "postgres-v12-effective-source-empty-v1",
    eventTimeConflict ? "event-time-conflict" : fold.observedAtMs,
    conflict ? "conflict" : "compatible",
    recordJson === null ? null : await sha256Hex(recordJson),
  ]));
  return Object.freeze({ occurrenceId: fold.candidate.occurrence_id, observedAtMs,
    eventTime: eventTimeConflict || fold.observedAtMs === null ? null : new Date(fold.observedAtMs).toISOString(),
    eventTimeConflict, status: conflict ? "conflict" : "compatible", sourceCount: fold.sourceCount,
    sourceFormats: Object.freeze(sourceFormats), sourceFingerprint, recordJson: conflict ? null : recordJson });
}

async function assertLivePin(
  pool: PostgresPool,
  schema: string,
  identity: PostgresSourceIdentityConfig,
  pin: PostgresEffectiveOwnerPin,
): Promise<void> {
  const live = await captureOwnerPin(pool, schema, identity, pin.ownerDigest);
  if (!sameOwnerPin(live, pin)) fail("POSTGRES_LEGACY_EFFECTIVE_CAS_MISMATCH");
}

/** Read one keyset page of whole occurrence groups across active v1, v1.1,
 * and v1.2 sources. Source rows are fetched through bounded internal keyset
 * subpages (default 512 rows, configurable down to 1) and folded into a stable
 * per-occurrence source fingerprint; no valid source rows are truncated and
 * the API cursor never cuts an occurrence group. D1 does not choose a winning
 * format: overlap is compatible only when times and non-attribution fields agree. */
export async function readPostgresEffectiveHistoryPage(
  pool: PostgresPool,
  input: ReadPostgresEffectiveHistoryOptions,
): Promise<PostgresEffectiveHistoryPage> {
  const identity = normalizeIdentity(input);
  const schema = schemaName(input);
  const ownerDigest = input.ownerDigest;
  if (typeof ownerDigest !== "string" || !OWNER_DIGEST.test(ownerDigest)) fail("POSTGRES_LEGACY_EFFECTIVE_INVALID");
  const requestedDay = validDay(input.day);
  const streamName = stream(input.stream);
  const after = normalizeCursor(input.after);
  const pageLimit = normalizeLimit(input.limit);
  const sourceFetchBatchSize = normalizeSourceFetchBatchSize(input.sourceFetchBatchSize);
  const pin = input.expectedPin === undefined
    ? await captureOwnerPin(pool, schema, identity, ownerDigest)
    : normalizeOwnerPinInput(input.expectedPin);
  if (pin.ownerDigest !== ownerDigest || pin.sourceId !== identity.sourceId
      || pin.sourceNamespace !== identity.sourceNamespace) fail("POSTGRES_LEGACY_EFFECTIVE_INVALID");
  await assertLivePin(pool, schema, identity, pin);

  // The v1.0/v1.1 usage result contract includes separately admitted additive
  // corrections. Migration 0031 deliberately does not certify those rows;
  // returning raw usage alone could silently reintroduce a corrected total.
  if (streamName === "usage") {
    return Object.freeze({ available: false, correctionFamilyAvailable: false, sourceId: identity.sourceId,
      sourceNamespace: identity.sourceNamespace, ownerDigest, participantId: pin.participantId,
      day: requestedDay, stream: streamName, rows: Object.freeze([]), sourcePin: sourcePinFromOwner(pin),
      ownerPin: pin, next: null });
  }

  const [directPage, v12Page] = await Promise.all([
    readLegacyCandidates(pool, schema, pin, streamName, requestedDay, after, pageLimit),
    pin.v12State === "active:active" && pin.v12GenerationId !== null
      ? readPostgresTelemetryV12EffectiveCandidatePage(pool, {
        participantId: pin.participantId, day: requestedDay, stream: streamName,
        after: v12Cursor(after), limit: pageLimit,
      }, { schema: createPostgresSchemaConfig({ primarySchema: schemaIdentifier(schema) }) })
      : Promise.resolve({ available: true, records: Object.freeze([]), next: null }),
  ]);
  if (!v12Page.available && pin.v12State === "active:active" && pin.v12GenerationId !== null) UNAVAILABLE();
  const candidates = new Map<string, CandidateRow>();
  for (const row of directPage.rows) {
    const old = candidates.get(row.occurrence_id);
    if (!old || compareCandidates(row, old) < 0) candidates.set(row.occurrence_id, row);
  }
  for (const row of v12Page.records) {
    const candidate = { occurrence_id: row.occurrenceId, observed_at_ms: row.observedAtMs };
    const old = candidates.get(candidate.occurrence_id);
    if (!old || compareCandidates(candidate, old) < 0) candidates.set(candidate.occurrence_id, candidate);
  }
  const ordered = [...candidates.values()].filter((row) => integer(row.observed_at_ms, MIN_MS, MAX_MS) > after.observedAtMs
    || integer(row.observed_at_ms, MIN_MS, MAX_MS) === after.observedAtMs
      && row.occurrence_id > after.occurrenceId).sort(compareCandidates);
  const hasMore = ordered.length > pageLimit || directPage.hasMore || v12Page.next !== null;
  const selected = ordered.slice(0, pageLimit);
  if (selected.length === 0) {
    await assertLivePin(pool, schema, identity, pin);
    return Object.freeze({ available: true, correctionFamilyAvailable: null, sourceId: identity.sourceId,
      sourceNamespace: identity.sourceNamespace, ownerDigest, participantId: pin.participantId,
      day: requestedDay, stream: streamName, rows: Object.freeze([]), sourcePin: sourcePinFromOwner(pin),
      ownerPin: pin, next: null });
  }
  const occurrenceIds = selected.map((row) => row.occurrence_id);
  const folds = new Map(selected.map((candidate) => [candidate.occurrence_id, createOccurrenceFold(candidate)]));
  const [, v12Rows] = await Promise.all([
    readLegacySources(pool, schema, pin, streamName, occurrenceIds, folds, sourceFetchBatchSize),
    pin.v12State === "active:active" && pin.v12GenerationId !== null
      ? readPostgresTelemetryV12EffectiveOccurrences(pool, {
        participantId: pin.participantId, stream: streamName, occurrenceIds,
      }, { schema: createPostgresSchemaConfig({ primarySchema: schemaIdentifier(schema) }) })
      : Promise.resolve({ available: true, records: Object.freeze([]) }),
  ]);
  if (!v12Rows.available && pin.v12State === "active:active" && pin.v12GenerationId !== null) UNAVAILABLE();
  const rows = await Promise.all(selected.map((candidate) =>
    finishOccurrenceFold(folds.get(candidate.occurrence_id)!, streamName, v12Rows.records)));
  await assertLivePin(pool, schema, identity, pin);
  const last = selected.at(-1)!;
  return Object.freeze({ available: true, correctionFamilyAvailable: null, sourceId: identity.sourceId,
    sourceNamespace: identity.sourceNamespace, ownerDigest, participantId: pin.participantId,
    day: requestedDay, stream: streamName, rows: Object.freeze(rows), sourcePin: sourcePinFromOwner(pin),
    ownerPin: pin, next: hasMore ? Object.freeze({ observedAtMs: integer(last.observed_at_ms, MIN_MS, MAX_MS),
      occurrenceId: last.occurrence_id }) : null });
}

function sourcePinFromOwner(pin: PostgresEffectiveOwnerPin): PostgresEffectiveSourcePin {
  const { ownerDigest: _ownerDigest, participantId: _participantId, inputRevision: _inputRevision,
    ownerRevision: _ownerRevision, authorityEpoch: _authorityEpoch, v12State: _v12State,
    v12GenerationId: _v12GenerationId, ...sourcePin } = pin;
  return Object.freeze(sourcePin);
}

function v12Cursor(cursor: PostgresEffectiveCursor): PostgresTelemetryV12EffectiveCursor | undefined {
  return cursor.observedAtMs === MIN_MS && cursor.occurrenceId === "" ? undefined : cursor;
}

/** Recheck live source/import watermarks and owner authority for one pinned
 * history calculation. A change throws a closed CAS mismatch. */
export async function assertPostgresEffectiveHistoryCurrent(
  pool: PostgresPool,
  input: AssertPostgresEffectiveHistoryCurrentOptions,
): Promise<void> {
  const identity = normalizeIdentity(input);
  const schema = schemaName(input);
  const pin = normalizeOwnerPinInput(input.pin);
  if (pin.ownerDigest !== input.ownerDigest || pin.sourceId !== identity.sourceId
      || pin.sourceNamespace !== identity.sourceNamespace) fail("POSTGRES_LEGACY_EFFECTIVE_INVALID");
  await assertLivePin(pool, schema, identity, pin);
}
