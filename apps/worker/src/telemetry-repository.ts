import { sha256Hex } from "./crypto";
import { ApiError } from "./errors";
import type {
  TelemetryActivityMarker,
  TelemetryContribution,
  TelemetryEnvelope,
  TelemetryQuotaSnapshot,
  TelemetryUsageEvent,
} from "./telemetry-validation";

export interface TelemetryContributionRow {
  id: string;
  participant_id: string;
  plaintext_digest: string;
  envelope_digest: string;
  r2_key: string;
  status: "accepted" | "deleting";
  schema_version: "telemetry-contribution-v0.1";
  range_start: string;
  range_end: string;
  client_platform: string;
  provider_policy_epoch: string;
  estimated_api_cost_usd: string | null;
  priced_event_coverage_percent: number;
  unknown_model_event_count: number;
  unknown_billable_units: number;
  price_basis: string;
  declared_record_count: number;
  accepted_record_count?: number;
  created_at: string;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(Reflect.get(value, key))}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function telemetryEnvelopeDigest(envelope: TelemetryEnvelope): Promise<string> {
  return sha256Hex([
    envelope.schemaVersion,
    envelope.keyId,
    envelope.wrappedKey,
    envelope.iv,
    envelope.ciphertext,
  ].join("\0"));
}

export async function telemetryPlaintextDigest(record: TelemetryContribution): Promise<string> {
  return sha256Hex(stableJson(record));
}

export async function existingTelemetryContribution(
  db: D1Database,
  participantId: string,
  digest: string,
  kind: "plaintext" | "envelope" = "plaintext",
): Promise<TelemetryContributionRow | null> {
  const column = kind === "plaintext" ? "plaintext_digest" : "envelope_digest";
  return db.prepare(
    `SELECT c.*,
        (SELECT COUNT(*) FROM telemetry_records r WHERE r.origin_contribution_id = c.id)
          AS accepted_record_count
      FROM telemetry_contributions c
      WHERE c.participant_id = ? AND c.${column} = ?`,
  ).bind(participantId, digest).first<TelemetryContributionRow>();
}

export async function telemetryContributionCount(
  db: D1Database,
  participantId: string,
): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS total FROM telemetry_contributions WHERE participant_id = ?",
  ).bind(participantId).first<{ total: number }>();
  return row?.total ?? 0;
}

function nullable(value: number | null): number | null {
  return value ?? null;
}

function toolUnits(row: TelemetryUsageEvent): number {
  return Object.values(row.toolClassCounts).reduce((sum, value) => sum + value, 0);
}

function usageStatement(
  db: D1Database,
  participantId: string,
  contributionId: string,
  row: TelemetryUsageEvent,
): [D1PreparedStatement, D1PreparedStatement] {
  return [db.prepare(
    `INSERT OR IGNORE INTO telemetry_records (
      origin_contribution_id, participant_id, record_kind, occurrence_id, observed_at,
      provider, model_id, model_fingerprint, speed_mode, api_service_tier, surface,
      input_uncached_tokens, input_cache_read_tokens, input_cache_write_tokens,
      output_text_tokens, output_reasoning_tokens, output_combined_tokens, tool_units,
      estimated_api_cost_usd, pricing_coverage_percent, unknown_billable_units, record_json
    ) VALUES (?, ?, 'usage', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    contributionId,
    participantId,
    row.eventId,
    row.eventTime,
    row.provider,
    row.modelId,
    row.modelFingerprint,
    row.speedMode,
    row.apiServiceTier,
    row.surface,
    nullable(row.components.inputUncachedTokens),
    nullable(row.components.inputCacheReadTokens),
    nullable(row.components.inputCacheWriteTokens),
    nullable(row.components.outputTextTokens),
    nullable(row.components.outputReasoningTokens),
    nullable(row.components.outputCombinedTokens),
    toolUnits(row),
    row.accounting.estimatedApiCostUsd,
    row.accounting.pricingCoveragePercent,
    row.accounting.unknownBillableUnits,
    stableJson(row),
  ), occurrenceLink(db, participantId, contributionId, "usage", row.eventId)];
}

function quotaStatement(
  db: D1Database,
  participantId: string,
  contributionId: string,
  row: TelemetryQuotaSnapshot,
): [D1PreparedStatement, D1PreparedStatement] {
  return [db.prepare(
    `INSERT OR IGNORE INTO telemetry_records (
      origin_contribution_id, participant_id, record_kind, occurrence_id, observed_at,
      provider, plan_type, plan_variant, limit_id, slot, used_percent,
      window_duration_minutes, resets_at, record_json
    ) VALUES (?, ?, 'quota', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    contributionId,
    participantId,
    row.snapshotId,
    row.observedTime,
    row.provider,
    row.planType,
    row.planVariant,
    row.limitId,
    row.slot,
    row.usedPercent,
    row.windowDurationMinutes,
    row.resetsAt,
    stableJson(row),
  ), occurrenceLink(db, participantId, contributionId, "quota", row.snapshotId)];
}

function markerStatement(
  db: D1Database,
  participantId: string,
  contributionId: string,
  row: TelemetryActivityMarker,
): [D1PreparedStatement, D1PreparedStatement] {
  return [db.prepare(
    `INSERT OR IGNORE INTO telemetry_records (
      origin_contribution_id, participant_id, record_kind, occurrence_id, observed_at,
      surface, plan_type, plan_variant, record_json
    ) VALUES (?, ?, 'activity', ?, ?, ?, ?, ?, ?)`,
  ).bind(
    contributionId,
    participantId,
    row.markerId,
    row.observedTime,
    row.surface,
    row.planType,
    row.planVariant,
    stableJson(row),
  ), occurrenceLink(db, participantId, contributionId, "activity", row.markerId)];
}

function occurrenceLink(
  db: D1Database,
  participantId: string,
  contributionId: string,
  kind: "usage" | "quota" | "activity",
  occurrenceId: string,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO telemetry_contribution_occurrences (
      contribution_id, participant_id, record_kind, occurrence_id
    ) VALUES (?, ?, ?, ?)`,
  ).bind(contributionId, participantId, kind, occurrenceId);
}

export async function insertTelemetryContribution(
  db: D1Database,
  participantId: string,
  contributionId: string,
  r2Key: string,
  envelopeDigest: string,
  plaintextDigest: string,
  record: TelemetryContribution,
  createdAt: string,
): Promise<{ acceptedRecords: number; deduplicatedRecords: number }> {
  const recordPairs = [
    ...record.usageEvents.map((row) => usageStatement(db, participantId, contributionId, row)),
    ...record.quotaSnapshots.map((row) => quotaStatement(db, participantId, contributionId, row)),
    ...record.activityMarkers.map((row) => markerStatement(db, participantId, contributionId, row)),
  ];
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO telemetry_contributions (
        id, participant_id, plaintext_digest, envelope_digest, r2_key, status,
        schema_version, range_start, range_end, client_platform, provider_policy_epoch,
        estimated_api_cost_usd, priced_event_coverage_percent, unknown_model_event_count,
        unknown_billable_units, price_basis, declared_record_count, created_at
      ) VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      contributionId,
      participantId,
      plaintextDigest,
      envelopeDigest,
      r2Key,
      record.schemaVersion,
      record.coveredAt.startAt,
      record.coveredAt.endAt,
      record.clientPlatform,
      record.providerPolicyEpoch,
      record.accounting.estimatedApiCostUsd,
      record.accounting.pricedEventCoveragePercent,
      record.accounting.unknownModelEventCount,
      record.accounting.unknownBillableUnits,
      record.accounting.priceBasis,
      record.usageEvents.length + record.quotaSnapshots.length + record.activityMarkers.length,
      createdAt,
    ),
    ...recordPairs.flat(),
  ];
  const results = await db.batch(statements);
  if (results[0]?.meta.changes !== 1) throw new ApiError(409, "PARTICIPANT_DELETING");
  const totalRecords = recordPairs.length;
  const acceptedRecords = recordPairs.reduce(
    (sum, _pair, index) => sum + Number(results[1 + (index * 2)]?.meta.changes ?? 0),
    0,
  );
  return { acceptedRecords, deduplicatedRecords: totalRecords - acceptedRecords };
}

export async function listTelemetryContributions(
  db: D1Database,
  participantId: string,
): Promise<TelemetryContributionRow[]> {
  const result = await db.prepare(
    `SELECT c.*,
        (SELECT COUNT(*) FROM telemetry_records r WHERE r.origin_contribution_id = c.id)
          AS accepted_record_count
      FROM telemetry_contributions c
      WHERE c.participant_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT 101`,
  ).bind(participantId).all<TelemetryContributionRow>();
  return result.results;
}

export async function telemetryContributionById(
  db: D1Database,
  participantId: string,
  contributionId: string,
): Promise<TelemetryContributionRow | null> {
  return db.prepare(
    `SELECT c.*,
        (SELECT COUNT(*) FROM telemetry_records r WHERE r.origin_contribution_id = c.id)
          AS accepted_record_count
      FROM telemetry_contributions c WHERE c.participant_id = ? AND c.id = ?`,
  ).bind(participantId, contributionId).first<TelemetryContributionRow>();
}

export async function telemetryRecordsForContribution(
  db: D1Database,
  participantId: string,
  contributionId: string,
): Promise<Array<{ record_kind: string; record_json: string }>> {
  const result = await db.prepare(
    `SELECT r.record_kind, r.record_json FROM telemetry_records r
      JOIN telemetry_contribution_occurrences o
        ON o.participant_id = r.participant_id
       AND o.record_kind = r.record_kind
       AND o.occurrence_id = r.occurrence_id
      WHERE o.participant_id = ? AND o.contribution_id = ?
      ORDER BY r.observed_at ASC, r.id ASC LIMIT 501`,
  ).bind(participantId, contributionId).all<{ record_kind: string; record_json: string }>();
  return result.results;
}

export async function deleteTelemetryContribution(
  db: D1Database,
  participantId: string,
  contributionId: string,
): Promise<void> {
  await db.batch([
    db.prepare(
      "DELETE FROM telemetry_contributions WHERE participant_id = ? AND id = ?",
    ).bind(participantId, contributionId),
    db.prepare(
      `DELETE FROM telemetry_records
        WHERE participant_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM telemetry_contribution_occurrences o
             WHERE o.participant_id = telemetry_records.participant_id
               AND o.record_kind = telemetry_records.record_kind
               AND o.occurrence_id = telemetry_records.occurrence_id
          )`,
    ).bind(participantId),
  ]);
}

export function telemetryContributionMetadata(row: TelemetryContributionRow): object {
  return {
    contributionId: row.id,
    status: row.status,
    schemaVersion: row.schema_version,
    coveredAt: { startAt: row.range_start, endAt: row.range_end },
    clientPlatform: row.client_platform,
    providerPolicyEpoch: row.provider_policy_epoch,
    accounting: {
      estimatedApiCostUsd: row.estimated_api_cost_usd,
      pricedEventCoveragePercent: row.priced_event_coverage_percent,
      unknownModelEventCount: row.unknown_model_event_count,
      unknownBillableUnits: row.unknown_billable_units,
      priceBasis: row.price_basis,
      verification: "client_declared_unverified",
    },
    recordCounts: {
      declared: row.declared_record_count,
      accepted: row.accepted_record_count ?? 0,
      deduplicated: row.declared_record_count - (row.accepted_record_count ?? 0),
    },
    createdAt: row.created_at,
  };
}

interface CountsRow {
  usage_events: number;
  quota_snapshots: number;
  activity_markers: number;
  input_uncached_tokens: number;
  input_cache_read_tokens: number;
  input_cache_write_tokens: number;
  output_text_tokens: number;
  output_reasoning_tokens: number;
  output_combined_tokens: number;
  tool_units: number;
}

function zeroCounts(): CountsRow {
  return {
    usage_events: 0,
    quota_snapshots: 0,
    activity_markers: 0,
    input_uncached_tokens: 0,
    input_cache_read_tokens: 0,
    input_cache_write_tokens: 0,
    output_text_tokens: 0,
    output_reasoning_tokens: 0,
    output_combined_tokens: 0,
    tool_units: 0,
  };
}

const TOTALS_SQL = `SELECT
  SUM(CASE WHEN record_kind = 'usage' THEN 1 ELSE 0 END) AS usage_events,
  SUM(CASE WHEN record_kind = 'quota' THEN 1 ELSE 0 END) AS quota_snapshots,
  SUM(CASE WHEN record_kind = 'activity' THEN 1 ELSE 0 END) AS activity_markers,
  COALESCE(SUM(input_uncached_tokens), 0) AS input_uncached_tokens,
  COALESCE(SUM(input_cache_read_tokens), 0) AS input_cache_read_tokens,
  COALESCE(SUM(input_cache_write_tokens), 0) AS input_cache_write_tokens,
  COALESCE(SUM(output_text_tokens), 0) AS output_text_tokens,
  COALESCE(SUM(output_reasoning_tokens), 0) AS output_reasoning_tokens,
  COALESCE(SUM(output_combined_tokens), 0) AS output_combined_tokens,
  COALESCE(SUM(tool_units), 0) AS tool_units
  FROM telemetry_records`;

function insights(totals: CountsRow, fastEvents: number, pricedEvents: number): object[] {
  const input = totals.input_uncached_tokens + totals.input_cache_read_tokens
    + totals.input_cache_write_tokens;
  const output = totals.output_text_tokens + totals.output_reasoning_tokens
    + totals.output_combined_tokens;
  return [
    {
      code: "cache_share",
      value: input > 0 ? totals.input_cache_read_tokens / input : null,
      label: "Share of input served from cache",
    },
    {
      code: "reasoning_share",
      value: output > 0 ? totals.output_reasoning_tokens / output : null,
      label: "Share of output reported as reasoning",
    },
    {
      code: "fast_event_share",
      value: totals.usage_events > 0 ? fastEvents / totals.usage_events : null,
      label: "Share of usage events marked fast",
    },
    {
      code: "client_price_coverage",
      value: totals.usage_events > 0 ? pricedEvents / totals.usage_events : null,
      label: "Share with a client-declared API-cost estimate",
      verification: "client_declared_unverified",
    },
  ];
}

export async function personalStats(db: D1Database, participantId: string): Promise<object> {
  const [totalRow, breakdown, daily, latestQuota, gradientRows, speedRow, contributionRow] = await Promise.all([
    db.prepare(`${TOTALS_SQL} WHERE participant_id = ?`).bind(participantId).first<CountsRow>(),
    db.prepare(
      `SELECT provider, model_id AS modelId, COUNT(*) AS events,
        COALESCE(SUM(input_uncached_tokens), 0) AS inputUncachedTokens,
        COALESCE(SUM(input_cache_read_tokens), 0) AS inputCacheReadTokens,
        COALESCE(SUM(output_text_tokens), 0) AS outputTextTokens,
        COALESCE(SUM(output_reasoning_tokens), 0) AS outputReasoningTokens
       FROM telemetry_records
       WHERE participant_id = ? AND record_kind = 'usage'
       GROUP BY provider, model_id ORDER BY events DESC, provider, model_id LIMIT 50`,
    ).bind(participantId).all(),
    db.prepare(
      `SELECT substr(observed_at, 1, 10) AS day, COUNT(*) AS events,
        COALESCE(SUM(COALESCE(input_uncached_tokens, 0)
          + COALESCE(input_cache_read_tokens, 0) + COALESCE(input_cache_write_tokens, 0)
          + COALESCE(output_text_tokens, 0) + COALESCE(output_reasoning_tokens, 0)
          + COALESCE(output_combined_tokens, 0)), 0) AS tokens
       FROM telemetry_records WHERE participant_id = ? AND record_kind = 'usage'
       GROUP BY day ORDER BY day DESC LIMIT 180`,
    ).bind(participantId).all(),
    db.prepare(
      `SELECT record_json FROM telemetry_records
       WHERE participant_id = ? AND record_kind = 'quota'
       ORDER BY observed_at DESC, id DESC LIMIT 20`,
    ).bind(participantId).all<{ record_json: string }>(),
    db.prepare(
      `WITH quota_groups AS (
        SELECT provider, limit_id, window_duration_minutes, resets_at,
          COUNT(*) AS snapshots, MIN(observed_at) AS firstObservedAt,
          MAX(observed_at) AS lastObservedAt, MIN(used_percent) AS minimumUsedPercent,
          MAX(used_percent) AS maximumUsedPercent
        FROM telemetry_records
        WHERE participant_id = ? AND record_kind = 'quota'
        GROUP BY provider, limit_id, window_duration_minutes, resets_at
      )
      SELECT q.*,
        (SELECT COUNT(*) FROM telemetry_records u
          WHERE u.participant_id = ? AND u.record_kind = 'usage'
            AND u.observed_at BETWEEN q.firstObservedAt AND q.lastObservedAt) AS usageEvents,
        (SELECT COALESCE(SUM(CAST(u.estimated_api_cost_usd AS REAL)), 0)
          FROM telemetry_records u
          WHERE u.participant_id = ? AND u.record_kind = 'usage'
            AND u.estimated_api_cost_usd IS NOT NULL
            AND u.observed_at BETWEEN q.firstObservedAt AND q.lastObservedAt) AS clientEstimatedApiCostUsd
      FROM quota_groups q ORDER BY q.lastObservedAt DESC LIMIT 20`,
    ).bind(participantId, participantId, participantId).all(),
    db.prepare(
      `SELECT
        SUM(CASE WHEN speed_mode = 'fast' THEN 1 ELSE 0 END) AS fast,
        SUM(CASE WHEN estimated_api_cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS priced,
        COALESCE(SUM(CAST(estimated_api_cost_usd AS REAL)), 0) AS clientEstimatedApiCostUsd,
        COALESCE(SUM(unknown_billable_units), 0) AS unknownBillableUnits
       FROM telemetry_records WHERE participant_id = ? AND record_kind = 'usage'`,
    ).bind(participantId).first<{
      fast: number;
      priced: number;
      clientEstimatedApiCostUsd: number;
      unknownBillableUnits: number;
    }>(),
    db.prepare(
      `SELECT COUNT(*) AS contributions
       FROM telemetry_contributions WHERE participant_id = ?`,
    ).bind(participantId).first(),
  ]);
  const totals = totalRow ?? zeroCounts();
  return {
    schemaVersion: "participant-stats-v0.1",
    participantId,
    totals: {
      contributions: Reflect.get(contributionRow ?? {}, "contributions") ?? 0,
      usageEvents: totals.usage_events,
      quotaSnapshots: totals.quota_snapshots,
      activityMarkers: totals.activity_markers,
      inputUncachedTokens: totals.input_uncached_tokens,
      inputCacheReadTokens: totals.input_cache_read_tokens,
      inputCacheWriteTokens: totals.input_cache_write_tokens,
      outputTextTokens: totals.output_text_tokens,
      outputReasoningTokens: totals.output_reasoning_tokens,
      outputCombinedTokens: totals.output_combined_tokens,
      toolUnits: totals.tool_units,
      clientEstimatedApiCostUsd: speedRow?.clientEstimatedApiCostUsd ?? 0,
      unknownBillableUnits: speedRow?.unknownBillableUnits ?? 0,
      priceVerification: "client_declared_unverified",
    },
    byModel: breakdown.results,
    daily: [...daily.results].reverse(),
    latestQuota: latestQuota.results.map((row) => JSON.parse(row.record_json) as unknown),
    quotaGradients: gradientRows.results.map((row) => {
      const snapshots = Number(Reflect.get(row, "snapshots") ?? 0);
      const minimum = Number(Reflect.get(row, "minimumUsedPercent") ?? 0);
      const maximum = Number(Reflect.get(row, "maximumUsedPercent") ?? 0);
      const span = maximum - minimum;
      const usageEvents = Number(Reflect.get(row, "usageEvents") ?? 0);
      const cost = Number(Reflect.get(row, "clientEstimatedApiCostUsd") ?? 0);
      const testable = snapshots >= 2 && span > 0 && usageEvents > 0 && cost > 0;
      return {
        provider: Reflect.get(row, "provider"),
        limitId: Reflect.get(row, "limit_id"),
        windowDurationMinutes: Reflect.get(row, "window_duration_minutes"),
        resetsAt: Reflect.get(row, "resets_at"),
        firstObservedAt: Reflect.get(row, "firstObservedAt"),
        lastObservedAt: Reflect.get(row, "lastObservedAt"),
        snapshots,
        observedUsedPercentSpan: span,
        usageEvents,
        clientEstimatedApiCostUsd: cost,
        status: testable ? "conditional_estimate" : "not_testable",
        reason: testable ? null
          : snapshots < 2 ? "insufficient_quota_observations"
            : span <= 0 ? "no_observed_quota_movement"
              : usageEvents < 1 ? "no_usage_in_interval"
                : "no_client_priced_usage_in_interval",
        clientEstimatedApiCostPerPercentagePoint: testable ? cost / span : null,
        verification: "client_declared_unverified",
      };
    }),
    insights: insights(totals, speedRow?.fast ?? 0, speedRow?.priced ?? 0),
    generatedAt: new Date().toISOString(),
  };
}

export async function communityStats(
  db: D1Database,
  minimumParticipants: number,
  { eligibleOnly = false }: { eligibleOnly?: boolean } = {},
): Promise<object> {
  const eligibilityPredicate = eligibleOnly
    ? "participant_id IN (SELECT participant_id FROM participant_community_eligibility)"
    : "1 = 1";
  const participantRow = await db.prepare(
    `SELECT COUNT(DISTINCT participant_id) AS total FROM telemetry_records
      WHERE ${eligibilityPredicate}`,
  ).first<{ total: number }>();
  const participantCount = participantRow?.total ?? 0;
  if (participantCount < minimumParticipants) {
    return {
      schemaVersion: "community-stats-v0.1",
      suppressed: true,
      participantCount,
      minimumParticipants,
      cohortEligibility: eligibleOnly ? "invite_only" : "local_open_development",
      reason: "minimum_cohort_not_met",
    };
  }
  const [totalRow, breakdown, daily, speedRow] = await Promise.all([
    db.prepare(`${TOTALS_SQL} WHERE ${eligibilityPredicate}`).first<CountsRow>(),
    db.prepare(
      `SELECT provider, model_id AS modelId, COUNT(*) AS events,
        COUNT(DISTINCT participant_id) AS participants,
        COALESCE(SUM(input_uncached_tokens), 0) AS inputUncachedTokens,
        COALESCE(SUM(input_cache_read_tokens), 0) AS inputCacheReadTokens,
        COALESCE(SUM(output_text_tokens), 0) AS outputTextTokens,
        COALESCE(SUM(output_reasoning_tokens), 0) AS outputReasoningTokens
       FROM telemetry_records WHERE record_kind = 'usage' AND ${eligibilityPredicate}
       GROUP BY provider, model_id HAVING COUNT(DISTINCT participant_id) >= ?
       ORDER BY events DESC, provider, model_id LIMIT 50`,
    ).bind(minimumParticipants).all(),
    db.prepare(
      `SELECT substr(observed_at, 1, 10) AS day, COUNT(*) AS events,
        COUNT(DISTINCT participant_id) AS participants,
        COALESCE(SUM(COALESCE(input_uncached_tokens, 0)
          + COALESCE(input_cache_read_tokens, 0) + COALESCE(input_cache_write_tokens, 0)
          + COALESCE(output_text_tokens, 0) + COALESCE(output_reasoning_tokens, 0)
          + COALESCE(output_combined_tokens, 0)), 0) AS tokens
       FROM telemetry_records WHERE record_kind = 'usage' AND ${eligibilityPredicate}
       GROUP BY day HAVING COUNT(DISTINCT participant_id) >= ?
       ORDER BY day DESC LIMIT 180`,
    ).bind(minimumParticipants).all(),
    db.prepare(
      `SELECT
        SUM(CASE WHEN speed_mode = 'fast' THEN 1 ELSE 0 END) AS fast,
        SUM(CASE WHEN estimated_api_cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS priced
       FROM telemetry_records WHERE record_kind = 'usage' AND ${eligibilityPredicate}`,
    ).first<{ fast: number; priced: number }>(),
  ]);
  const totals = totalRow ?? zeroCounts();
  return {
    schemaVersion: "community-stats-v0.1",
    suppressed: false,
    participantCount,
    minimumParticipants,
    cohortEligibility: eligibleOnly ? "invite_only" : "local_open_development",
    totals: {
      usageEvents: totals.usage_events,
      quotaSnapshots: totals.quota_snapshots,
      activityMarkers: totals.activity_markers,
      inputUncachedTokens: totals.input_uncached_tokens,
      inputCacheReadTokens: totals.input_cache_read_tokens,
      inputCacheWriteTokens: totals.input_cache_write_tokens,
      outputTextTokens: totals.output_text_tokens,
      outputReasoningTokens: totals.output_reasoning_tokens,
      outputCombinedTokens: totals.output_combined_tokens,
      toolUnits: totals.tool_units,
    },
    byModel: breakdown.results,
    daily: [...daily.results].reverse(),
    insights: insights(totals, speedRow?.fast ?? 0, speedRow?.priced ?? 0),
    generatedAt: new Date().toISOString(),
  };
}
