import { canonicalJson } from "./canonical-json";
import {
  buildCommunityDailyPayload,
  type DailyCellRow,
  type DailyTotalsRow,
} from "./community-daily-aggregates";
import {
  DAILY_SPEND_CHUNKS_PER_PASS,
  DAILY_SPEND_EVENTS_PER_PASS,
  COMMUNITY_DAILY_SPEND_BASIS,
  COMMUNITY_DAILY_SPEND_PRICING_METHOD,
  COMMUNITY_DAILY_SPEND_REGISTRY_SHA256,
  DAILY_SPEND_CAPACITY_POLICY,
  finalizeCommunityDailySpend,
  type CommunityDailySpend,
} from "./community-daily-spend";
import { priceChunkUsageRecord } from "./quota-analysis-v1";
import { sha256Hex } from "./crypto";
import {
  createPostgresSchemaConfig,
  createPostgresSourceIdentityConfig,
  normalizePostgresError,
  PostgresStorageError,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresQueryResult,
  type PostgresSchemaOptions,
} from "./postgres-client";
import { MAX_V1_SOURCE_CHUNKS } from "./telemetry-v1-source-selection";
import { priceTelemetryUsageEvent } from "./server-pricing";
import type { TelemetryUsageEvent } from "./telemetry-validation";
import {
  parseTelemetryV12Record,
  REVIEWED_MODEL_CATALOG,
  type TelemetryV12UsageEvent,
} from "@app-usagemonitor/telemetry-contract";

const MAX_DAILY_AGGREGATE_CELLS = 100;
const SPEND_FETCH_BATCH_SIZE = 1_000;
const DAILY_SOURCE_TRANSACTION_TIMEOUT_MILLISECONDS = 40_000;
const DAILY_SOURCE_EXPIRY_LOOKAHEAD_SECONDS = 45;
const POSTGRES_DAILY_V12_PROVIDERS = new Set(["openai_codex", "anthropic_claude_code"]);
const POSTGRES_DAILY_V12_BILLING_SURFACES = new Set([
  "chatgpt_subscription", "openai_api", "claude_subscription", "unknown",
]);
const POSTGRES_DAILY_V12_SPEED_MODES = new Set(["standard", "fast", "unknown", "other"]);
const POSTGRES_DAILY_V12_API_SERVICE_TIERS = new Set([
  "standard", "priority", "flex", "batch", "unknown", "other", "default",
]);
const POSTGRES_DAILY_V12_REASONING_EFFORTS = new Set([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "unknown",
]);
const POSTGRES_DAILY_V12_MODEL_BY_ID = new Map(REVIEWED_MODEL_CATALOG.map((model) => [model.id, model]));

interface DailyFenceRow {
  readonly public_source_generation: string | number;
  readonly source_id: string;
  readonly source_authority_epoch: string | number;
  readonly cursor_sequence: string | number;
  readonly cursor_authority_epoch: string | number;
  readonly v1_source_namespace: string;
  readonly v1_runtime_contract_version: string | number;
  readonly v11_source_namespace: string;
  readonly v11_runtime_contract_version: string | number;
  readonly policy_revision: string | number;
  readonly collection_revision: string | number;
  readonly telemetry_v12_runtime_state: string;
  readonly telemetry_v12_runtime_revision: string | number;
  readonly telemetry_v12_typed_runtime_state: string;
  readonly telemetry_v12_typed_runtime_policy_revision: string | number;
  readonly telemetry_v12_accountless_authorization_count: string | number;
  readonly telemetry_v12_next_accountless_authorization_expiry: string | Date | null;
  readonly telemetry_v12_accountless_authorization_expires_soon: boolean;
  readonly control_state: string;
  readonly publication_enabled: boolean;
}

interface JournalFenceRow {
  readonly latest_sequence: string | number;
  readonly terminal_sequence: string | number;
}

interface RevisionRow {
  readonly revision: string | number;
  readonly release_state: string;
  readonly payload_json: string;
  readonly payload_sha256: string;
  readonly source_authority_epoch: string | number;
  readonly source_cursor_sequence: string | number;
  readonly policy_revision: string | number;
  readonly collection_revision: string | number;
  readonly telemetry_v12_runtime_state: string | null;
  readonly telemetry_v12_runtime_revision: string | number | null;
  readonly telemetry_v12_typed_runtime_state: string | null;
  readonly telemetry_v12_typed_runtime_policy_revision: string | number | null;
  readonly telemetry_v12_accountless_authorization_count: string | number | null;
  readonly telemetry_v12_next_accountless_authorization_expiry: string | Date | null;
  readonly public_source_generation: string | number | null;
}

interface DailyTotalsQueryRow extends Record<string, unknown> {
  readonly contributing_participants: string | number;
  readonly contributing_devices: string | number;
  readonly usage_events: string | number;
  readonly quota_observations: string | number;
  readonly session_dimensions: string | number;
  readonly input_uncached_tokens: string | number;
  readonly input_cache_read_tokens: string | number;
  readonly input_cache_write_tokens: string | number;
  readonly output_text_tokens: string | number;
  readonly output_reasoning_tokens: string | number;
  readonly output_combined_tokens: string | number;
}

interface DailyCellQueryRow extends Record<string, unknown> {
  readonly provider: string;
  readonly model_id: string;
  readonly usage_events: string | number;
  readonly input_uncached_tokens: string | number;
  readonly input_cache_read_tokens: string | number;
  readonly input_cache_write_tokens: string | number;
  readonly output_text_tokens: string | number;
  readonly output_reasoning_tokens: string | number;
  readonly output_combined_tokens: string | number;
}

interface SpendChunkQueryRow extends Record<string, unknown> {
  readonly chunk_count: string | number;
  readonly accepted_record_count: string | number;
}

interface SpendRecordQueryRow extends Record<string, unknown> {
  readonly participant_id: string;
  readonly device_id: string;
  readonly chunk_id: string;
  readonly source_format: string | number;
  readonly occurrence_id: string;
  readonly observed_at: string;
  readonly record_json: string;
}

export interface PostgresTypedV12DailyUsagePrice {
  readonly costNanousd: number;
  readonly pricingStatus: "fully_priced" | "partially_priced" | "unpriced";
  readonly modelId: string | null;
  readonly unpricedReasonCodes: readonly string[];
}

function invalid(): never {
  throw new PostgresStorageError("invalid", "community_daily.publish", { retryable: false });
}

function unavailable(operation = "community_daily.publish_authority"): never {
  throw new PostgresStorageError("unavailable", operation, { retryable: false });
}

function integer(value: unknown, minimum = 0): number {
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < minimum) invalid();
  return parsed;
}

function timestamp(value: unknown): string | null {
  if (value === null) return null;
  const milliseconds = value instanceof Date
    ? value.valueOf()
    : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(milliseconds)) invalid();
  return new Date(milliseconds).toISOString();
}

function nullableInteger(value: unknown, minimum = 0): number | null {
  return value === null ? null : integer(value, minimum);
}

/**
 * Price a decoded PostgreSQL v1.2 usage record without converting it to the
 * lossy v1 JSON shape. Validate the closed v1.2 contract before mapping fields;
 * typed storage has an explicit Anthropic 5m/1h cache-write split, which is
 * passed directly to the shared pricer.
 * This adapter is intentionally not wired into the public daily source CTE
 * until v1.2 publication eligibility and its commit-time fences are proven.
 */
export function pricePostgresTypedV12DailyUsageRecord(
  value: unknown,
): PostgresTypedV12DailyUsagePrice | null {
  let usage: TelemetryV12UsageEvent;
  try {
    usage = parseTelemetryV12Record("usage", value) as TelemetryV12UsageEvent;
  } catch {
    invalid();
  }
  const model = usage.modelId === "unknown"
    ? null
    : POSTGRES_DAILY_V12_MODEL_BY_ID.get(
      usage.modelId as Exclude<TelemetryUsageEvent["modelId"], "unknown">,
    );
  if (!POSTGRES_DAILY_V12_PROVIDERS.has(usage.provider)
      || (usage.modelId !== "unknown" && model?.provider !== usage.provider)
      || !POSTGRES_DAILY_V12_BILLING_SURFACES.has(usage.billingSurface)
      || !POSTGRES_DAILY_V12_SPEED_MODES.has(usage.speedMode)
      || !POSTGRES_DAILY_V12_API_SERVICE_TIERS.has(usage.apiServiceTier)
      || !POSTGRES_DAILY_V12_REASONING_EFFORTS.has(usage.reasoningEffort)) invalid();
  const ttlFiveMinute = usage.cacheWriteTtl?.fiveMinuteTokens ?? null;
  const ttlOneHour = usage.cacheWriteTtl?.oneHourTokens ?? null;
  const aggregateCacheWrite = usage.components.inputCacheWriteTokens;
  if ((ttlFiveMinute === null) !== (ttlOneHour === null)
      || (ttlFiveMinute !== null && (ttlOneHour === null || aggregateCacheWrite === null
        || ttlFiveMinute + ttlOneHour !== aggregateCacheWrite))) invalid();
  const components = {
    inputUncachedTokens: usage.components.inputUncachedTokens,
    inputCacheReadTokens: usage.components.inputCacheReadTokens,
    inputCacheWriteTokens: aggregateCacheWrite,
    inputCacheWrite5mTokens: ttlFiveMinute,
    inputCacheWrite1hTokens: ttlOneHour,
    outputTextTokens: usage.components.outputTextTokens,
    outputReasoningTokens: usage.components.outputReasoningTokens,
    outputCombinedTokens: usage.components.outputCombinedTokens,
  };
  // Match the existing daily pricing adapter's DROP behavior for a typed usage
  // row that has no token observations. Context alone is not billable evidence.
  if (components.inputUncachedTokens === null
      && components.inputCacheReadTokens === null
      && components.inputCacheWriteTokens === null
      && components.inputCacheWrite5mTokens === null
      && components.inputCacheWrite1hTokens === null
      && components.outputTextTokens === null
      && components.outputReasoningTokens === null
      && components.outputCombinedTokens === null) return null;
  const pricingEvent = {
    schemaVersion: "usage-event-v0.1",
    eventTime: usage.eventTime,
    provider: usage.provider,
    modelId: usage.modelId,
    modelRecognition: usage.modelId === "unknown" ? "unrecognized" : "recognized",
    modelFingerprint: null,
    billingSurface: usage.billingSurface,
    speedMode: usage.speedMode,
    // `default` is a valid typed-v1.2 transport value, but it is not a price
    // tier in the shared v0.1 pricing contract. Preserve it as unknown rather
    // than infer `standard`.
    apiServiceTier: usage.apiServiceTier === "default" ? "unknown" : usage.apiServiceTier,
    reasoningEffort: usage.reasoningEffort,
    components,
    totalInputContextTokens: usage.totalInputContextTokens,
  } as unknown as TelemetryUsageEvent;
  const priced = priceTelemetryUsageEvent(pricingEvent);
  return Object.freeze({
    costNanousd: priced.costNanousd,
    pricingStatus: priced.coverageStatus,
    modelId: usage.modelId === "unknown" ? null : usage.modelId,
    unpricedReasonCodes: Object.freeze([...priced.unpricedReasonCodes]),
  });
}

function dayValue(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)
      || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
      || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) invalid();
  return value;
}

function schemaName(options: PostgresSchemaOptions | undefined): string {
  return quotePostgresIdentifier(createPostgresSchemaConfig(options).primarySchema);
}

export type PostgresCommunityDailyDaySourceEligibility = Readonly<{
  v1SelectedRecordsPresent: boolean;
  v11SelectedRecordsPresent: boolean;
}>;

export interface ReadPostgresCommunityDailyDaySourceEligibilityOptions {
  readonly day: string;
  readonly schema?: PostgresSchemaOptions;
}

function publicDailySourceCtes(schema: string): string {
  // This mirrors the social and accountless v1.1 branches of the D1
  // community_public_source_owners projection: active social/accountless
  // authority, plus accountless v1.1 history that was pinned before an exact
  // user opt-out. Opt-out retains the accepted current head but does not
  // retain upload authority or create a terminal source event. D1 isolation
  // 0011 also admits accountless v1.2 owners (active and retained). Those
  // branches are deliberately absent: this publisher reads only v1 and v1.1
  // records, which a v1.2-only install does not have, so they would select
  // nothing. Counting v1.2 evidence here, with those branches, is separate.
  return `WITH public_owners AS (
      SELECT participant.id AS participant_id, NULL::text AS device_id
        FROM ${schema}.participants participant
       WHERE participant.owner_kind = 'social' AND participant.state = 'active'
      UNION ALL
      SELECT participant.id AS participant_id, device.id AS device_id
        FROM ${schema}.accountless_upload_owners owner
        JOIN ${schema}.participants participant ON participant.id = owner.participant_id
        JOIN ${schema}.accountless_enrollment_ledger ledger ON ledger.device_id = owner.enrollment_device_id
        JOIN ${schema}.device_credentials device ON device.id = owner.device_credential_id
        JOIN ${schema}.accountless_v11_device_authorizations grant_row
          ON grant_row.enrollment_device_id = owner.enrollment_device_id
         AND grant_row.participant_id = owner.participant_id
         AND grant_row.device_credential_id = owner.device_credential_id
       WHERE participant.owner_kind = 'accountless' AND participant.state = 'active'
         AND owner.state = 'active' AND owner.revoked_at IS NULL AND owner.revocation_reason IS NULL
         AND ledger.state = 'active' AND ledger.revoked_at IS NULL AND ledger.revocation_reason IS NULL
         AND device.state = 'active' AND device.revoked_at IS NULL
         AND grant_row.state = 'active' AND grant_row.revoked_at IS NULL AND grant_row.revocation_reason IS NULL
         AND device.participant_id = participant.id AND device.authority_kind = 'accountless'
         AND device.id = ledger.device_id
         AND device.accountless_enrollment_device_id = ledger.device_id
         AND device.paired_via_pairing_id IS NULL AND device.social_verified_at IS NULL
         AND device.secret_hash = ledger.device_secret_hash
         AND ledger.schema_version = 'accountless-enrollment-v0.1'
         AND ledger.policy_version = 'accountless-opt-out-v1'
         AND ledger.authorization_basis = 'accountless-policy-v1'
         AND owner.policy_version = ledger.policy_version
         AND owner.authorization_basis = ledger.authorization_basis
         AND grant_row.telemetry_schema_version = 'telemetry-contribution-v1.1'
         AND grant_row.field_dictionary_version = 'telemetry-v1.1-registry-2026-08-31.1'
         AND grant_row.privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.1'
         AND owner.expires_at = ledger.expires_at AND device.expires_at = ledger.expires_at
         AND grant_row.expires_at = ledger.expires_at
         AND EXISTS (
           SELECT 1 FROM ${schema}.telemetry_v11_domain_heads head
           JOIN ${schema}.telemetry_v11_domains domain ON domain.id = head.generation_id
            WHERE head.participant_id = participant.id
              AND domain.participant_id = participant.id AND domain.device_id = device.id
         )
      UNION ALL
      SELECT participant.id AS participant_id, device.id AS device_id
        FROM ${schema}.accountless_public_history_retention retained
        JOIN ${schema}.participants participant
          ON participant.id = retained.participant_id
        JOIN ${schema}.accountless_upload_owners owner
          ON owner.participant_id = retained.participant_id
         AND owner.enrollment_device_id = retained.enrollment_device_id
         AND owner.device_credential_id = retained.device_credential_id
        JOIN ${schema}.accountless_enrollment_ledger ledger
          ON ledger.device_id = retained.enrollment_device_id
        JOIN ${schema}.device_credentials device
          ON device.id = retained.device_credential_id
         AND device.participant_id = retained.participant_id
        JOIN ${schema}.accountless_v11_device_authorizations grant_row
          ON grant_row.enrollment_device_id = retained.enrollment_device_id
         AND grant_row.participant_id = retained.participant_id
         AND grant_row.device_credential_id = retained.device_credential_id
        JOIN ${schema}.telemetry_v11_domain_heads head
          ON head.participant_id = retained.participant_id
         AND head.generation_id = retained.generation_id
         AND head.revision = retained.head_revision
        JOIN ${schema}.telemetry_v11_domains domain
          ON domain.id = retained.generation_id
         AND domain.participant_id = retained.participant_id
         AND domain.device_id = retained.device_credential_id
       WHERE participant.owner_kind = 'accountless' AND participant.state = 'active'
         AND ledger.state = 'revoked' AND ledger.revocation_reason = 'user_opt_out'
         AND owner.state = 'revoked' AND owner.revocation_reason = 'user_opt_out'
         AND grant_row.state = 'revoked' AND grant_row.revocation_reason = 'user_opt_out'
         AND device.state = 'revoked' AND device.authority_kind = 'accountless'
         AND ledger.revoked_at = retained.retained_at
         AND owner.revoked_at = retained.retained_at
         AND grant_row.revoked_at = retained.retained_at
         AND device.revoked_at = retained.retained_at
         AND device.id = ledger.device_id
         AND device.accountless_enrollment_device_id = ledger.device_id
         AND device.paired_via_pairing_id IS NULL AND device.social_verified_at IS NULL
         AND device.secret_hash = ledger.device_secret_hash
         AND ledger.schema_version = 'accountless-enrollment-v0.1'
         AND ledger.policy_version = 'accountless-opt-out-v1'
         AND ledger.authorization_basis = 'accountless-policy-v1'
         AND owner.policy_version = ledger.policy_version
         AND owner.authorization_basis = ledger.authorization_basis
         AND grant_row.telemetry_schema_version = 'telemetry-contribution-v1.1'
         AND grant_row.field_dictionary_version = 'telemetry-v1.1-registry-2026-08-31.1'
         AND grant_row.privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.1'
         AND owner.expires_at = ledger.expires_at
         AND device.expires_at = ledger.expires_at
         AND grant_row.expires_at = ledger.expires_at
    ), active_chunks AS (
      SELECT chunk.id AS chunk_id, chunk.participant_id, chunk.device_id,
             chunk.chunk_day AS observed_day, chunk.stream, chunk.created_at,
             chunk.accepted_record_count, NULL::text AS manifest_id, 10 AS source_format
        FROM ${schema}.telemetry_v1_chunks chunk
        JOIN public_owners eligible ON eligible.participant_id = chunk.participant_id
          AND (eligible.device_id IS NULL OR eligible.device_id = chunk.device_id)
       WHERE chunk.chunk_day = $1::date AND chunk.superseded_at IS NULL
         AND chunk.accepted_record_count > 0
         AND NOT EXISTS (
           SELECT 1 FROM ${schema}.telemetry_v11_domain_heads head
            WHERE head.participant_id = chunk.participant_id
         )
      UNION ALL
      SELECT chunk.id AS chunk_id, chunk.participant_id, chunk.device_id,
             chunk.chunk_day AS observed_day, chunk.stream, chunk.created_at,
             chunk.record_count AS accepted_record_count, chunk.manifest_id, 11 AS source_format
        FROM ${schema}.telemetry_v11_domain_heads head
        JOIN ${schema}.telemetry_v11_domains domain
          ON domain.id = head.generation_id AND domain.participant_id = head.participant_id
        JOIN ${schema}.telemetry_v11_domain_days day_row
          ON day_row.generation_id = domain.id AND day_row.observed_day = $1::date
        JOIN ${schema}.telemetry_v11_chunks chunk
          ON chunk.manifest_id = day_row.manifest_id
         AND chunk.participant_id = domain.participant_id
         AND chunk.device_id = domain.device_id
         AND chunk.chunk_day = day_row.observed_day
        JOIN public_owners eligible ON eligible.participant_id = chunk.participant_id
          AND (eligible.device_id IS NULL OR eligible.device_id = chunk.device_id)
    ), device_evidence AS (
      SELECT participant_id, observed_day, device_id,
             bool_or(stream <> 'session') AS has_analytical,
             max(created_at) FILTER (WHERE stream <> 'session') AS newest_analytical,
             max(created_at) FILTER (WHERE stream = 'session') AS newest_session
        FROM active_chunks
       GROUP BY participant_id, observed_day, device_id
    ), ranked_devices AS (
      SELECT participant_id, observed_day, device_id,
             row_number() OVER (
               PARTITION BY participant_id, observed_day
               ORDER BY has_analytical DESC,
                        COALESCE(newest_analytical, newest_session) DESC,
                        device_id COLLATE "C" DESC
             ) AS winner_rank
        FROM device_evidence
    ), winning_devices AS (
      SELECT participant_id, observed_day, device_id
        FROM ranked_devices WHERE winner_rank = 1
    ), active_records AS (
      SELECT chunk.participant_id, chunk.device_id,
             chunk.chunk_id, chunk.source_format, record.occurrence_id, record.observed_at,
             record.stream, record.provider, record.model_id,
             record.input_uncached_tokens, record.input_cache_read_tokens,
             record.input_cache_write_tokens, record.output_text_tokens,
             record.output_reasoning_tokens, record.output_combined_tokens,
             record.record_json::text AS record_json
        FROM active_chunks chunk
        JOIN winning_devices winner USING (participant_id, observed_day, device_id)
        JOIN ${schema}.telemetry_v1_records record
          ON chunk.source_format = 10 AND record.chunk_row_id = chunk.chunk_id
         AND record.participant_id = chunk.participant_id AND record.device_id = chunk.device_id
         AND record.stream = chunk.stream AND record.observed_day = chunk.observed_day
      UNION ALL
      SELECT chunk.participant_id, chunk.device_id,
             chunk.chunk_id, chunk.source_format, record.occurrence_id, record.observed_at,
             record.stream,
             record.record_json::jsonb ->> 'provider' AS provider,
             record.record_json::jsonb ->> 'modelId' AS model_id,
             NULLIF(record.record_json::jsonb #>> '{components,inputUncachedTokens}', '')::bigint,
             NULLIF(record.record_json::jsonb #>> '{components,inputCacheReadTokens}', '')::bigint,
             NULLIF(record.record_json::jsonb #>> '{components,inputCacheWriteTokens}', '')::bigint,
             NULLIF(record.record_json::jsonb #>> '{components,outputTextTokens}', '')::bigint,
             NULLIF(record.record_json::jsonb #>> '{components,outputReasoningTokens}', '')::bigint,
             NULLIF(record.record_json::jsonb #>> '{components,outputCombinedTokens}', '')::bigint,
             record.record_json
        FROM active_chunks chunk
        JOIN winning_devices winner USING (participant_id, observed_day, device_id)
        JOIN ${schema}.telemetry_v11_records record
          ON chunk.source_format = 11 AND record.chunk_id = chunk.chunk_id
         AND record.manifest_id = chunk.manifest_id
         AND record.stream = chunk.stream
    )`;
}

/**
 * Report whether this exact publisher projection would select any v1/v1.1
 * records for one day. A pool call opens a bounded read-only transaction; a
 * client call uses the caller's current transaction and leaves its snapshot,
 * bounds, and lifecycle to the caller. The result contains booleans only; a
 * missing query result is unavailable rather than an empty day.
 */
export async function readPostgresCommunityDailyDaySourceEligibility(
  poolOrClient: PostgresPool | PostgresClient,
  options: ReadPostgresCommunityDailyDaySourceEligibilityOptions,
): Promise<PostgresCommunityDailyDaySourceEligibility> {
  const capturedDay = dayValue(options.day);
  const schema = schemaName(options.schema);
  const ctes = publicDailySourceCtes(schema);
  const read = async (client: PostgresClient) => {
    const result = await client.query<{
      readonly v1_selected_records_present: boolean;
      readonly v11_selected_records_present: boolean;
    }>(
      `${ctes}
       SELECT COALESCE(bool_or(record.source_format = 10), false)
                AS v1_selected_records_present,
              COALESCE(bool_or(record.source_format = 11), false)
                AS v11_selected_records_present
         FROM active_records record`,
      [capturedDay],
    );
    if (!Array.isArray(result.rows) || result.rows.length !== 1) {
      unavailable("community_daily.source_eligibility");
    }
    const row = result.rows[0];
    if (row === undefined || typeof row.v1_selected_records_present !== "boolean"
        || typeof row.v11_selected_records_present !== "boolean") {
      unavailable("community_daily.source_eligibility");
    }
    return Object.freeze({
      v1SelectedRecordsPresent: row.v1_selected_records_present,
      v11SelectedRecordsPresent: row.v11_selected_records_present,
    });
  };
  if (poolOrClient !== null && typeof poolOrClient === "object"
      && typeof (poolOrClient as PostgresClient).release !== "function"
      && typeof (poolOrClient as PostgresPool).connect === "function") {
    return withPostgresRead(poolOrClient as PostgresPool, read, {
      operation: "community_daily.source_eligibility",
      statementTimeoutMilliseconds: 10_000,
      lockTimeoutMilliseconds: 2_000,
    });
  }
  if (poolOrClient !== null && typeof poolOrClient === "object"
      && typeof (poolOrClient as PostgresClient).query === "function") {
    try {
      return await read(poolOrClient as PostgresClient);
    } catch (error) {
      if (error instanceof PostgresStorageError) throw error;
      throw normalizePostgresError(error, "community_daily.source_eligibility");
    }
  }
  unavailable("community_daily.source_eligibility");
}

function safeTotals(row: DailyTotalsQueryRow | undefined): DailyTotalsRow {
  if (!row) invalid();
  return {
    contributing_participants: integer(row.contributing_participants),
    contributing_devices: integer(row.contributing_devices),
    usage_events: integer(row.usage_events),
    quota_observations: integer(row.quota_observations),
    session_dimensions: integer(row.session_dimensions),
    input_uncached_tokens: integer(row.input_uncached_tokens),
    input_cache_read_tokens: integer(row.input_cache_read_tokens),
    input_cache_write_tokens: integer(row.input_cache_write_tokens),
    output_text_tokens: integer(row.output_text_tokens),
    output_reasoning_tokens: integer(row.output_reasoning_tokens),
    output_combined_tokens: integer(row.output_combined_tokens),
  };
}

function safeCells(rows: readonly DailyCellQueryRow[]): DailyCellRow[] {
  if (rows.length > MAX_DAILY_AGGREGATE_CELLS + 1) invalid();
  return rows.map((row) => {
    if (typeof row.provider !== "string" || row.provider.length < 1 || row.provider.length > 128
        || typeof row.model_id !== "string" || row.model_id.length < 1 || row.model_id.length > 512) invalid();
    return {
      provider: row.provider,
      model_id: row.model_id,
      usage_events: integer(row.usage_events),
      input_uncached_tokens: integer(row.input_uncached_tokens),
      input_cache_read_tokens: integer(row.input_cache_read_tokens),
      input_cache_write_tokens: integer(row.input_cache_write_tokens),
      output_text_tokens: integer(row.output_text_tokens),
      output_reasoning_tokens: integer(row.output_reasoning_tokens),
      output_combined_tokens: integer(row.output_combined_tokens),
    };
  });
}

function unavailableSpend(usageEvents: number): CommunityDailySpend {
  return {
    basis: COMMUNITY_DAILY_SPEND_BASIS,
    currency: "USD" as const,
    knownCostUsd: null,
    coverage: "unavailable" as const,
    usageEvents,
    fullyPricedUsageEvents: 0,
    partiallyPricedUsageEvents: 0,
    unpricedUsageEvents: 0,
    pricingMethodVersion: COMMUNITY_DAILY_SPEND_PRICING_METHOD,
    registrySha256: COMMUNITY_DAILY_SPEND_REGISTRY_SHA256,
    unprocessedUsageEvents: usageEvents,
    unavailableReason: "processing_capacity_exceeded" as const,
    processingPolicyVersion: DAILY_SPEND_CAPACITY_POLICY,
  };
}

async function priceDailySpend(
  client: PostgresClient,
  ctes: string,
  day: string,
  usageEvents: number,
): Promise<ReturnType<typeof finalizeCommunityDailySpend> | ReturnType<typeof unavailableSpend>> {
  if (usageEvents > DAILY_SPEND_EVENTS_PER_PASS) return unavailableSpend(usageEvents);
  const chunkResult = await client.query<SpendChunkQueryRow>(
    `${ctes}
     SELECT count(*)::text AS chunk_count,
            COALESCE(sum(chunk.accepted_record_count), 0)::text AS accepted_record_count
       FROM active_chunks chunk
       JOIN winning_devices winner USING (participant_id, observed_day, device_id)
      WHERE chunk.stream = 'usage'`,
    [day],
  );
  if (!Array.isArray(chunkResult.rows) || chunkResult.rows.length !== 1) {
    unavailable("community_daily.spend_chunks");
  }
  const usageChunks = integer(chunkResult.rows[0]?.chunk_count);
  if (usageChunks > MAX_V1_SOURCE_CHUNKS) unavailable("community_daily.spend_chunks");
  const expectedEvents = integer(chunkResult.rows[0]?.accepted_record_count);
  if (expectedEvents !== usageEvents) unavailable("community_daily.spend_source_mismatch");
  if (usageChunks > DAILY_SPEND_CHUNKS_PER_PASS) return unavailableSpend(usageEvents);
  if (usageEvents === 0) {
    return finalizeCommunityDailySpend({
      usageEvents: 0,
      knownNanousd: 0n,
      fullyPricedUsageEvents: 0,
      partiallyPricedUsageEvents: 0,
      unpricedUsageEvents: 0,
    });
  }

  const cursor = "community_daily_spend_cursor";
  // `day` is validated by dayValue and contains only ISO date digits. DECLARE
  // takes one SQL statement, so bind the validated date as a literal rather
  // than trying to bind through PostgreSQL's cursor declaration syntax.
  const cursorCtes = ctes.replaceAll("$1::date", `DATE '${day}'`);
  await client.query(
    `DECLARE ${cursor} NO SCROLL CURSOR WITHOUT HOLD FOR
     ${cursorCtes}
     SELECT record.participant_id, record.device_id, record.chunk_id,
            record.source_format, record.occurrence_id,
            to_char(record.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at,
            record.record_json
       FROM active_records record
      WHERE record.stream = 'usage'
      ORDER BY record.participant_id COLLATE "C", record.device_id COLLATE "C",
               record.chunk_id COLLATE "C", record.source_format,
               record.occurrence_id COLLATE "C"`,
  );
  let seen = 0;
  let knownNanousd = 0n;
  let fullyPricedUsageEvents = 0;
  let partiallyPricedUsageEvents = 0;
  let unpricedUsageEvents = 0;
  while (true) {
    // Fetch at most one row beyond the aggregate count. This also verifies
    // exhaustion when usageEvents is an exact multiple of the page size.
    const fetchCount = Math.min(SPEND_FETCH_BATCH_SIZE, usageEvents - seen + 1);
    const page: PostgresQueryResult<SpendRecordQueryRow> = await client.query<SpendRecordQueryRow>(
      `FETCH FORWARD ${fetchCount} FROM ${cursor}`,
    );
    if (!Array.isArray(page.rows) || page.rows.length > fetchCount) {
      unavailable("community_daily.spend_rows");
    }
    if (page.rows.length === 0) {
      if (seen !== usageEvents) unavailable("community_daily.spend_rows");
      break;
    }
    if (seen + page.rows.length > usageEvents) unavailable("community_daily.spend_event_count");
    for (const row of page.rows) {
      const priced = priceChunkUsageRecord(row.record_json, row.observed_at);
      if (priced === null || priced.pricingStatus === "unpriced") {
        unpricedUsageEvents += 1;
      } else {
        if (!Number.isSafeInteger(priced.costNanousd) || priced.costNanousd < 0) invalid();
        knownNanousd += BigInt(priced.costNanousd);
        if (priced.pricingStatus === "fully_priced") fullyPricedUsageEvents += 1;
        else partiallyPricedUsageEvents += 1;
      }
      integer(row.source_format, 10);
      seen += 1;
    }
  }
  if (seen !== usageEvents) unavailable("community_daily.spend_event_count");
  // If fetching/pricing failed, the transaction rollback releases the
  // transaction-scoped cursor. Closing only on success avoids masking errors.
  await client.query(`CLOSE ${cursor}`);
  return finalizeCommunityDailySpend({
    usageEvents,
    knownNanousd,
    fullyPricedUsageEvents,
    partiallyPricedUsageEvents,
    unpricedUsageEvents,
  });
}

async function assertDailySourceChunkCapacity(
  client: PostgresClient,
  ctes: string,
  day: string,
): Promise<void> {
  const result = await client.query<{ chunk_count: string | number }>(
    `${ctes}
     SELECT count(*)::text AS chunk_count
       FROM (SELECT chunk_id FROM active_chunks LIMIT $2) bounded_chunks`,
    [day, MAX_V1_SOURCE_CHUNKS + 1],
  );
  if (!Array.isArray(result.rows) || result.rows.length !== 1
      || integer(result.rows[0]?.chunk_count) > MAX_V1_SOURCE_CHUNKS) {
    unavailable("community_daily.source_chunks");
  }
}

async function captureFence(
  client: PostgresClient,
  schema: string,
  sourceId: string,
  sourceNamespace: string,
  lockedPublicSourceGeneration: number,
) {
  // Requires staged primary 0093 and 0095 to be deliberately promoted/applied
  // before deploying this reader. The generation lock was acquired before this
  // read. All tables consulted here and by publicDailySourceCtes advance that
  // lock in a BEFORE STATEMENT trigger; no row locks are taken here, avoiding
  // inversions with writers that already hold source/journal rows.
  const result = await client.query<DailyFenceRow>(
    `SELECT source.source_id,
            public_source.revision AS public_source_generation,
            source.authority_epoch AS source_authority_epoch,
            cursor.sequence AS cursor_sequence,
            cursor.authority_epoch AS cursor_authority_epoch,
            v1.source_namespace AS v1_source_namespace,
            v1.runtime_contract_version AS v1_runtime_contract_version,
            v11.source_namespace AS v11_source_namespace,
            v11.runtime_contract_version AS v11_runtime_contract_version,
            policy.policy_revision,
            controls.revision AS collection_revision,
            telemetry_v12_runtime.state AS telemetry_v12_runtime_state,
            telemetry_v12_runtime.revision AS telemetry_v12_runtime_revision,
            telemetry_v12_typed_runtime.state AS telemetry_v12_typed_runtime_state,
            telemetry_v12_typed_runtime.policy_revision AS telemetry_v12_typed_runtime_policy_revision,
            (SELECT count(*) FROM ${schema}.accountless_v12_device_authorizations account_auth
              WHERE account_auth.state='active'
                AND account_auth.expires_at > transaction_timestamp())
              AS telemetry_v12_accountless_authorization_count,
            (SELECT min(account_auth.expires_at) FROM ${schema}.accountless_v12_device_authorizations account_auth
              WHERE account_auth.state='active'
                AND account_auth.expires_at > transaction_timestamp())
              AS telemetry_v12_next_accountless_authorization_expiry,
            EXISTS (SELECT 1 FROM ${schema}.accountless_v12_device_authorizations account_auth
              WHERE account_auth.state='active'
                AND account_auth.expires_at > transaction_timestamp()
                AND account_auth.expires_at <= transaction_timestamp()
                  + ($2::integer * interval '1 second'))
              AS telemetry_v12_accountless_authorization_expires_soon,
            controls.control_state,
            controls.publication_enabled
       FROM ${schema}.storage_source_state source
       JOIN ${schema}.community_daily_v12_authority_state public_source ON public_source.id=1
       JOIN ${schema}.analytics_source_cursors cursor ON cursor.source_id=source.source_id
       JOIN ${schema}.typed_v1_admission_state v1 ON v1.id=1
       JOIN ${schema}.typed_v11_admission_state v11 ON v11.id=1
       JOIN ${schema}.publication_state policy ON policy.singleton=1
       JOIN ${schema}.collection_controls controls ON controls.singleton=1
       JOIN ${schema}.telemetry_v12_runtime telemetry_v12_runtime ON telemetry_v12_runtime.id=1
       JOIN ${schema}.telemetry_v12_typed_runtime telemetry_v12_typed_runtime ON telemetry_v12_typed_runtime.id=1
      WHERE source.singleton=1 AND source.source_id=$1`,
    [sourceId, DAILY_SOURCE_EXPIRY_LOOKAHEAD_SECONDS],
  );
  const row = result.rows[0];
  if (!Array.isArray(result.rows) || result.rows.length !== 1 || !row
      || row.source_id !== sourceId
      || integer(row.public_source_generation, 1) !== lockedPublicSourceGeneration
      || row.v1_source_namespace !== sourceNamespace || row.v11_source_namespace !== sourceNamespace
      || integer(row.v1_runtime_contract_version) !== 1
      || integer(row.v11_runtime_contract_version) !== 1
      || integer(row.policy_revision, 1) < 1 || integer(row.collection_revision, 1) < 1
      || !["staged", "active", "blocked"].includes(row.telemetry_v12_runtime_state)
      || integer(row.telemetry_v12_runtime_revision) < 0
      || !["staged", "active"].includes(row.telemetry_v12_typed_runtime_state)
      || integer(row.telemetry_v12_typed_runtime_policy_revision, 1) < 1
      || row.telemetry_v12_accountless_authorization_expires_soon !== false
      || row.control_state !== "operational" || row.publication_enabled !== true) {
    unavailable("community_daily.authority_fence");
  }
  const v12AuthorizationCount = integer(row.telemetry_v12_accountless_authorization_count);
  const v12NextAuthorizationExpiry = timestamp(row.telemetry_v12_next_accountless_authorization_expiry);
  if ((v12AuthorizationCount === 0) !== (v12NextAuthorizationExpiry === null)) unavailable();
  const journal = await client.query<JournalFenceRow>(
    `SELECT COALESCE(max(change.sequence), 0)::text AS latest_sequence,
            COALESCE(max(change.sequence) FILTER (WHERE change.kind IN ('owner-withdrawn', 'owner-erased')), 0)::text AS terminal_sequence
       FROM ${schema}.storage_ingestion_changes change WHERE change.source_id=$1`,
    [sourceId],
  );
  const latestSequence = integer(journal.rows[0]?.latest_sequence);
  const terminalSequence = integer(journal.rows[0]?.terminal_sequence);
  const sourceAuthorityEpoch = integer(row.source_authority_epoch);
  const cursorSequence = integer(row.cursor_sequence);
  if (integer(row.cursor_authority_epoch) !== sourceAuthorityEpoch
      || latestSequence > cursorSequence || terminalSequence > cursorSequence) {
    unavailable("community_daily.source_not_current");
  }
  return Object.freeze({
    sourceAuthorityEpoch,
    publicSourceGeneration: integer(row.public_source_generation, 1),
    cursorSequence,
    policyRevision: integer(row.policy_revision, 1),
    collectionRevision: integer(row.collection_revision, 1),
    telemetryV12RuntimeState: row.telemetry_v12_runtime_state,
    telemetryV12RuntimeRevision: integer(row.telemetry_v12_runtime_revision),
    telemetryV12TypedRuntimeState: row.telemetry_v12_typed_runtime_state,
    telemetryV12TypedRuntimePolicyRevision: integer(row.telemetry_v12_typed_runtime_policy_revision, 1),
    telemetryV12AccountlessAuthorizationCount: v12AuthorizationCount,
    telemetryV12NextAccountlessAuthorizationExpiry: v12NextAuthorizationExpiry,
  });
}

function sameV12AuthorityPin(previous: RevisionRow, fence: Awaited<ReturnType<typeof captureFence>>): boolean {
  if (previous.telemetry_v12_runtime_state === null
      || previous.telemetry_v12_typed_runtime_state === null
      || previous.telemetry_v12_runtime_revision === null
      || previous.telemetry_v12_typed_runtime_policy_revision === null
      || previous.telemetry_v12_accountless_authorization_count === null
      || previous.public_source_generation === null) return false;
  return nullableInteger(previous.public_source_generation, 1) === fence.publicSourceGeneration
    && previous.telemetry_v12_runtime_state === fence.telemetryV12RuntimeState
    && nullableInteger(previous.telemetry_v12_runtime_revision) === fence.telemetryV12RuntimeRevision
    && previous.telemetry_v12_typed_runtime_state === fence.telemetryV12TypedRuntimeState
    && nullableInteger(previous.telemetry_v12_typed_runtime_policy_revision, 1)
      === fence.telemetryV12TypedRuntimePolicyRevision
    && nullableInteger(previous.telemetry_v12_accountless_authorization_count)
      === fence.telemetryV12AccountlessAuthorizationCount
    && timestamp(previous.telemetry_v12_next_accountless_authorization_expiry)
      === fence.telemetryV12NextAccountlessAuthorizationExpiry;
}

export interface PublishPostgresCommunityDailyOptions {
  readonly sourceId: string;
  readonly sourceNamespace: string;
  readonly day: string;
  readonly nowMs?: number;
  readonly schema?: PostgresSchemaOptions;
}

export type PostgresCommunityDailyPublication = Readonly<{
  state: "published" | "unchanged";
  day: string;
  revision: number;
}>;

/**
 * Publish one explicitly requested UTC day using the current D1 daily source
 * semantics: public social sources plus eligible v1.1 accountless sources,
 * one winning device per participant/day, and v1 records retired after a v1.1
 * domain head exists. PostgreSQL v1.2 telemetry remains excluded because the
 * Worker `telemetry_analytical_records` projection currently excludes v1.2.
 *
 * This test-side publication adapter writes activity and API-price fields only.
 * The Worker allowance-fit readiness and preview cache have a separate producer
 * contract; their absence does not make this daily row allowance-ready.
 * PostgreSQL terminal events conservatively withdraw every daily revision for
 * the source. After the cursor catches up, a successor is a new immutable
 * revision built from current public-owner eligibility; this does not provide
 * the D1 per-day containment behavior.
 */
export async function publishPostgresCommunityDailyDay(
  pool: PostgresPool,
  options: PublishPostgresCommunityDailyOptions,
): Promise<PostgresCommunityDailyPublication> {
  const identity = createPostgresSourceIdentityConfig(options);
  const capturedDay = dayValue(options.day);
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError("invalid PostgreSQL community daily timestamp");
  const releasedAt = new Date(nowMs).toISOString();
  const schema = schemaName(options.schema);
  const ctes = publicDailySourceCtes(schema);

  return withPostgresMutation(pool, async (client) => {
    // The transaction bound leaves a five-second margin after the 45-second
    // expiry look-ahead checked below. `SET LOCAL` does not establish the
    // REPEATABLE READ snapshot; the advisory lock remains the first SELECT.
    await client.query(
      `SET LOCAL transaction_timeout='${DAILY_SOURCE_TRANSACTION_TIMEOUT_MILLISECONDS}ms'`,
    );
    // Serialize same-day revisions without locking unrelated publication days.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 731042))",
      [`${identity.sourceId}\u001f${capturedDay}`],
    );
    const generationLock = await client.query<{ revision: string | number }>(
      `SELECT revision FROM ${schema}.community_daily_v12_authority_state
        WHERE id=1 FOR SHARE`,
    );
    if (!Array.isArray(generationLock.rows) || generationLock.rows.length !== 1) {
      unavailable("community_daily.authority_generation");
    }
    const lockedPublicSourceGeneration = integer(generationLock.rows[0]?.revision, 1);
    const fence = await captureFence(
      client, schema, identity.sourceId, identity.sourceNamespace, lockedPublicSourceGeneration,
    );
    const previousResult = await client.query<RevisionRow>(
      `SELECT revision, release_state, payload_json, payload_sha256,
              source_authority_epoch, source_cursor_sequence,
              policy_revision, collection_revision,
              public_source_generation,
              telemetry_v12_runtime_state, telemetry_v12_runtime_revision,
              telemetry_v12_typed_runtime_state, telemetry_v12_typed_runtime_policy_revision,
              telemetry_v12_accountless_authorization_count,
              telemetry_v12_next_accountless_authorization_expiry
         FROM ${schema}.community_daily_aggregates
        WHERE source_id=$1 AND source_namespace=$2 AND day=$3::date
        ORDER BY revision DESC LIMIT 1`,
      [identity.sourceId, identity.sourceNamespace, capturedDay],
    );
    const previous = previousResult.rows[0];
    if (previous && previous.release_state === "published"
        && integer(previous.source_authority_epoch) === fence.sourceAuthorityEpoch
        && integer(previous.source_cursor_sequence) === fence.cursorSequence
        && integer(previous.policy_revision, 1) === fence.policyRevision
        && integer(previous.collection_revision, 1) === fence.collectionRevision
        && sameV12AuthorityPin(previous, fence)
        && await sha256Hex(previous.payload_json) === previous.payload_sha256) {
      return Object.freeze({ state: "unchanged", day: capturedDay, revision: integer(previous.revision, 1) });
    }
    const revision = integer(previous?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) invalid();
    await assertDailySourceChunkCapacity(client, ctes, capturedDay);
    const totalsResult = await client.query<DailyTotalsQueryRow>(
      `${ctes}
       SELECT count(DISTINCT record.participant_id)::text AS contributing_participants,
              count(DISTINCT record.participant_id || ':' || record.device_id)::text AS contributing_devices,
              count(*) FILTER (WHERE record.stream='usage')::text AS usage_events,
              count(*) FILTER (WHERE record.stream='quota')::text AS quota_observations,
              count(*) FILTER (WHERE record.stream='session')::text AS session_dimensions,
              COALESCE(sum(record.input_uncached_tokens), 0)::text AS input_uncached_tokens,
              COALESCE(sum(record.input_cache_read_tokens), 0)::text AS input_cache_read_tokens,
              COALESCE(sum(record.input_cache_write_tokens), 0)::text AS input_cache_write_tokens,
              COALESCE(sum(record.output_text_tokens), 0)::text AS output_text_tokens,
              COALESCE(sum(record.output_reasoning_tokens), 0)::text AS output_reasoning_tokens,
              COALESCE(sum(COALESCE(record.output_combined_tokens,
                COALESCE(record.output_text_tokens, 0) + COALESCE(record.output_reasoning_tokens, 0))), 0)::text
                AS output_combined_tokens
         FROM active_records record`,
      [capturedDay],
    );
    const totals = safeTotals(totalsResult.rows[0]);
    const cellResult = await client.query<DailyCellQueryRow>(
      `${ctes}
       SELECT record.provider, record.model_id,
              count(*)::text AS usage_events,
              COALESCE(sum(record.input_uncached_tokens), 0)::text AS input_uncached_tokens,
              COALESCE(sum(record.input_cache_read_tokens), 0)::text AS input_cache_read_tokens,
              COALESCE(sum(record.input_cache_write_tokens), 0)::text AS input_cache_write_tokens,
              COALESCE(sum(record.output_text_tokens), 0)::text AS output_text_tokens,
              COALESCE(sum(record.output_reasoning_tokens), 0)::text AS output_reasoning_tokens,
              COALESCE(sum(COALESCE(record.output_combined_tokens,
                COALESCE(record.output_text_tokens, 0) + COALESCE(record.output_reasoning_tokens, 0))), 0)::text
                AS output_combined_tokens
         FROM active_records record
        WHERE record.stream='usage'
        GROUP BY record.provider, record.model_id
        ORDER BY record.provider COLLATE "C", record.model_id COLLATE "C"
        LIMIT $2`,
      [capturedDay, MAX_DAILY_AGGREGATE_CELLS + 1],
    );
    const cells = safeCells(cellResult.rows);
    const spend = await priceDailySpend(client, ctes, capturedDay, totals.usage_events);
    const payload = buildCommunityDailyPayload({
      day: capturedDay,
      revision,
      releasedAt,
      totals,
      cells,
      cellsTruncated: cells.length > MAX_DAILY_AGGREGATE_CELLS,
      spend,
    });
    const payloadJson = canonicalJson(payload);
    if (new TextEncoder().encode(payloadJson).byteLength > 262_144) unavailable("community_daily.payload_size");
    const payloadSha256 = await sha256Hex(payloadJson);

    const inserted = await client.query<{ revision: string | number }>(
      `INSERT INTO ${schema}.community_daily_aggregates (
         source_id, source_namespace, day, revision, payload_json, payload_sha256,
         source_authority_epoch, source_cursor_sequence, policy_revision,
         collection_revision, public_source_generation,
         telemetry_v12_runtime_state, telemetry_v12_runtime_revision,
         telemetry_v12_typed_runtime_state, telemetry_v12_typed_runtime_policy_revision,
         telemetry_v12_accountless_authorization_count,
         telemetry_v12_next_accountless_authorization_expiry,
         release_state, released_at
       )
       SELECT $1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
              'published',$18::timestamptz
        WHERE NOT EXISTS (
          SELECT 1 FROM ${schema}.storage_ingestion_changes change
           WHERE change.source_id=$1
             AND change.kind IN ('owner-withdrawn','owner-erased')
             AND change.sequence > $8
        )
       RETURNING revision`,
      [identity.sourceId, identity.sourceNamespace, capturedDay, revision, payloadJson, payloadSha256,
        fence.sourceAuthorityEpoch, fence.cursorSequence, fence.policyRevision, fence.collectionRevision,
        fence.publicSourceGeneration,
        fence.telemetryV12RuntimeState, fence.telemetryV12RuntimeRevision,
        fence.telemetryV12TypedRuntimeState, fence.telemetryV12TypedRuntimePolicyRevision,
        fence.telemetryV12AccountlessAuthorizationCount,
        fence.telemetryV12NextAccountlessAuthorizationExpiry, releasedAt],
    );
    if (inserted.rowCount !== 1 || inserted.rows[0]?.revision === undefined) unavailable("community_daily.publish_fence");
    return Object.freeze({ state: "published", day: capturedDay, revision: integer(inserted.rows[0].revision, 1) });
  }, {
    operation: "community_daily.publish",
    isolationLevel: "repeatable_read",
    statementTimeoutMilliseconds: 60_000,
    lockTimeoutMilliseconds: 5_000,
    preserveSafeError: (error) => error instanceof PostgresStorageError ? error : null,
  });
}
