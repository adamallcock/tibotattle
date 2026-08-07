import {
  COMMUNITY_WEEKLY_CUTOFF_MILLISECONDS,
  COMMUNITY_WEEKLY_LEASE_MILLISECONDS,
  COMMUNITY_WEEKLY_MAX_CELLS,
  COMMUNITY_WEEKLY_MINIMUM_PARTICIPANTS,
  COMMUNITY_WEEKLY_POLICY_VERSION,
} from "./constants";
import { APP_PRICE_REGISTRY_MANIFEST } from "@app-usagemonitor/accounting";
import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import {
  TELEMETRY_MODEL_IDS,
  TELEMETRY_PLAN_TYPES,
} from "./telemetry-validation";
import { parseStoredJson } from "./stored-record";

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
// v0.3 changes the public cohort claim: open-enrollment aggregates are gated
// by distinct social-provider accounts and maturity controls, not independently
// verified people. Sealed v0.2 payloads remain readable at the public edge,
// while new builder output must carry the more precise contract version.
const SNAPSHOT_SCHEMA_VERSION = "community-weekly-snapshot-v0.3";
const COMPARISON_SOURCE_SNAPSHOT_SCHEMA_VERSIONS = new Set([
  "community-weekly-snapshot-v0.2",
  SNAPSHOT_SCHEMA_VERSION,
]);
const COMPARISON_SCHEMA_VERSION = "participant-community-comparison-v0.2";
const SNAPSHOT_ID_PATTERN = /^community-weekly:\d{4}-\d{2}-\d{2}(?::r[1-9]\d*)?$/u;
const DEFAULT_COMMUNITY_SNAPSHOT_POLICY: CommunitySnapshotPolicy = Object.freeze({
  maturityDays: 7,
  minimumAcceptedCollectionDays: 2,
  accountUsageEventsCap: 1_000,
  accountTokenComponentsCap: 5_000_000,
  accountToolUnitsCap: 1_000,
  policyRevision: 1,
});
// Mirrors the closed planType/planVariant enums in
// packages/telemetry-contract/schemas/v0.2/quota-snapshot.schema.json.
// Allowance-relative aggregates must never blend plans, so every published
// cell carries an explicit plan cohort; absent or mixed-in-window evidence
// stays the explicit "unknown" cohort rather than being inferred.
const PLAN_COHORT_TYPES = new Set<string>(TELEMETRY_PLAN_TYPES);
const PLAN_COHORT_VARIANTS = Object.freeze([
  "pro-20x", "pro-10x-promo", "pro-5x", "plus", "unknown",
]);
const PUBLIC_MODEL_IDS_SQL = TELEMETRY_MODEL_IDS
  .filter((modelId) => modelId !== "unknown")
  .map((modelId) => `'${modelId}'`)
  .join(", ");
const METRICS = [
  ["usageEvents", "usage_events", 1_000, 10, "events"],
  ["inputUncachedTokens", "input_uncached_tokens", 5_000_000, 100_000, "tokens"],
  ["inputCacheReadTokens", "input_cache_read_tokens", 5_000_000, 100_000, "tokens"],
  ["inputCacheWriteTokens", "input_cache_write_tokens", 5_000_000, 100_000, "tokens"],
  ["outputTextTokens", "output_text_tokens", 5_000_000, 100_000, "tokens"],
  ["outputReasoningTokens", "output_reasoning_tokens", 5_000_000, 100_000, "tokens"],
  ["outputCombinedTokens", "output_combined_tokens", 5_000_000, 100_000, "tokens"],
  ["toolUnits", "tool_units", 1_000, 10, "units"],
] as const;

/**
 * Release controls are stored in D1 so operators can only tighten the
 * open-cohort maturity window and account-level caps without changing a
 * Worker bundle. The optional override exists for deterministic tooling/tests
 * and lets a caller pin an equally-or-more-conservative policy used by a
 * rebuild.
 */
export interface CommunitySnapshotPolicy {
  maturityDays: number;
  minimumAcceptedCollectionDays: number;
  accountUsageEventsCap: number;
  accountTokenComponentsCap: number;
  accountToolUnitsCap: number;
  policyRevision: number;
}

export interface CommunitySnapshotPolicyOverride {
  maturityDays?: number;
  minimumAcceptedCollectionDays?: number;
  accountUsageEventsCap?: number;
  accountTokenComponentsCap?: number;
  accountToolUnitsCap?: number;
  policyRevision?: number;
}

interface CommunitySnapshotPolicyRow {
  maturity_days: number;
  minimum_accepted_collection_days: number;
  account_usage_events_cap: number;
  account_token_components_cap: number;
  account_tool_units_cap: number;
  policy_revision: number;
}

interface CommunitySnapshotPolicyEpochRow extends CommunitySnapshotPolicyRow {
  mutation_epoch: number;
}

interface AggregatedCellRow {
  provider: string;
  plan_type: string;
  plan_variant: string;
  model_id: string;
  cohort_support: number;
  usage_events_support: number;
  usage_events_clipped: number;
  input_uncached_tokens_support: number;
  input_uncached_tokens_clipped: number;
  input_cache_read_tokens_support: number;
  input_cache_read_tokens_clipped: number;
  input_cache_write_tokens_support: number;
  input_cache_write_tokens_clipped: number;
  output_text_tokens_support: number;
  output_text_tokens_clipped: number;
  output_reasoning_tokens_support: number;
  output_reasoning_tokens_clipped: number;
  output_combined_tokens_support: number;
  output_combined_tokens_clipped: number;
  tool_units_support: number;
  tool_units_clipped: number;
}

interface SnapshotRow {
  payload_json: string;
  release_state: "published" | "suppressed" | "withdrawn";
  snapshot_id: string;
  revision: number;
  week_start: string;
  week_end: string;
  ingestion_cutoff_at: string;
}

interface CommunityWeek {
  startAt: string;
  endAt: string;
  cutoffAt: string;
}

interface RebuildRow {
  week_start: string;
  week_end: string;
  ingestion_cutoff_at: string;
  requested_epoch: number;
}

interface ParticipantCellRow {
  provider: string;
  model_id: string;
  usage_events: number;
  input_uncached_tokens: number | null;
  input_cache_read_tokens: number | null;
  input_cache_write_tokens: number | null;
  output_text_tokens: number | null;
  output_reasoning_tokens: number | null;
  output_combined_tokens: number | null;
  tool_units: number | null;
}

function validPolicyNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateCommunitySnapshotPolicy(
  policy: CommunitySnapshotPolicy,
): CommunitySnapshotPolicy {
  if (!validPolicyNumber(policy.maturityDays) || policy.maturityDays < 7
      || policy.maturityDays > 3650
      || !validPolicyNumber(policy.minimumAcceptedCollectionDays)
      || policy.minimumAcceptedCollectionDays < 2
      || policy.minimumAcceptedCollectionDays > 366
      || !validPolicyNumber(policy.accountUsageEventsCap)
      || policy.accountUsageEventsCap < 1
      || policy.accountUsageEventsCap > 1_000
      || !validPolicyNumber(policy.accountTokenComponentsCap)
      || policy.accountTokenComponentsCap < 1
      || policy.accountTokenComponentsCap > 5_000_000
      || !validPolicyNumber(policy.accountToolUnitsCap)
      || policy.accountToolUnitsCap < 1
      || policy.accountToolUnitsCap > 1_000
      || !validPolicyNumber(policy.policyRevision)
      || policy.policyRevision < 1) {
    throw new Error("invalid community snapshot policy");
  }
  return policy;
}

function withPolicyOverride(
  base: CommunitySnapshotPolicy,
  override: CommunitySnapshotPolicyOverride | undefined,
): CommunitySnapshotPolicy {
  if (!override) return validateCommunitySnapshotPolicy(base);
  return validateCommunitySnapshotPolicy({
    ...base,
    ...Object.fromEntries(Object.entries(override).filter(([, value]) => value !== undefined)),
  } as CommunitySnapshotPolicy);
}

function policyFromRow(row: CommunitySnapshotPolicyRow | null): CommunitySnapshotPolicy {
  if (row === null) return DEFAULT_COMMUNITY_SNAPSHOT_POLICY;
  return {
    maturityDays: Number(row.maturity_days),
    minimumAcceptedCollectionDays: Number(row.minimum_accepted_collection_days),
    accountUsageEventsCap: Number(row.account_usage_events_cap),
    accountTokenComponentsCap: Number(row.account_token_components_cap),
    accountToolUnitsCap: Number(row.account_tool_units_cap),
    policyRevision: Number(row.policy_revision),
  };
}

export async function readCommunitySnapshotPolicy(
  db: D1Database,
  override?: CommunitySnapshotPolicyOverride,
): Promise<CommunitySnapshotPolicy> {
  const row = await db.prepare(
    `SELECT maturity_days, minimum_accepted_collection_days,
            account_usage_events_cap, account_token_components_cap,
            account_tool_units_cap, policy_revision
       FROM community_snapshot_policy
      WHERE singleton_id = 1`,
  ).first<CommunitySnapshotPolicyRow>();
  return withPolicyOverride(policyFromRow(row), override);
}

/**
 * A snapshot must bind its policy and mutation epoch from one D1 read. If a
 * semantic policy update races a build after this read, its trigger advances
 * the epoch and the finalization predicate rejects the stale build. Reading
 * the two values separately would leave a window where an old policy could
 * be stamped with the new epoch.
 */
async function readCommunitySnapshotPolicySnapshot(
  db: D1Database,
  override?: CommunitySnapshotPolicyOverride,
): Promise<{ policy: CommunitySnapshotPolicy; mutationEpoch: number }> {
  const row = await db.prepare(
    `SELECT p.maturity_days, p.minimum_accepted_collection_days,
            p.account_usage_events_cap, p.account_token_components_cap,
            p.account_tool_units_cap, p.policy_revision,
            m.mutation_epoch
       FROM community_snapshot_policy p
       JOIN community_snapshot_mutation_control m
         ON m.singleton_id = 1
      WHERE p.singleton_id = 1`,
  ).first<CommunitySnapshotPolicyEpochRow>();
  if (!row
      || !Number.isSafeInteger(Number(row.mutation_epoch))
      || Number(row.mutation_epoch) < 0) {
    throw new Error("community snapshot policy control unavailable");
  }
  return {
    policy: withPolicyOverride(policyFromRow(row), override),
    mutationEpoch: Number(row.mutation_epoch),
  };
}

function participantComparisonUnavailable(
  reason: string,
  row?: SnapshotRow,
): object {
  return {
    schemaVersion: COMPARISON_SCHEMA_VERSION,
    status: "not_testable",
    reason,
    ...(row ? {
      snapshotId: row.snapshot_id,
      snapshotRevision: row.revision,
      period: { startAt: row.week_start, endAt: row.week_end },
      ingestionCutoffAt: row.ingestion_cutoff_at,
    } : {}),
    cells: [],
  };
}

export function communityWeekForScheduledTime(scheduledTime: number): CommunityWeek {
  const cutoffEligible = new Date(scheduledTime - COMMUNITY_WEEKLY_CUTOFF_MILLISECONDS);
  cutoffEligible.setUTCHours(0, 0, 0, 0);
  const daysSinceMonday = (cutoffEligible.getUTCDay() + 6) % 7;
  const endEpoch = cutoffEligible.getTime() - daysSinceMonday * DAY;
  return {
    startAt: new Date(endEpoch - WEEK).toISOString(),
    endAt: new Date(endEpoch).toISOString(),
    cutoffAt: new Date(endEpoch + COMMUNITY_WEEKLY_CUTOFF_MILLISECONDS).toISOString(),
  };
}

function basePayload(
  snapshotId: string,
  startAt: string,
  endAt: string,
  cutoffAt: string,
  revision: number,
  releasedAt: string,
  policy: CommunitySnapshotPolicy,
): Record<string, unknown> {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId,
    snapshotRevision: revision,
    period: { startAt, endAt },
    ingestionCutoffAt: cutoffAt,
    releasedAt,
    immutable: true,
    nonOverlapping: true,
    priceRegistryVersion: APP_PRICE_REGISTRY_MANIFEST.version,
    planCohorts: {
      key: "provider_planType_planVariant_modelId",
      unknownPolicy: "absent_or_mixed_in_window_stays_explicit_unknown",
    },
    cohortEligibility: "provider_account_gated_open_cohort",
    privacyPolicy: {
      version: COMMUNITY_WEEKLY_POLICY_VERSION,
      minimumProviderAccountParticipants: COMMUNITY_WEEKLY_MINIMUM_PARTICIPANTS,
      maturity: {
        appliesTo: "open_provider_account_cohort",
        maturityDays: policy.maturityDays,
        minimumAcceptedCollectionDays: policy.minimumAcceptedCollectionDays,
        acceptedCollectionDayBasis: "telemetry_contribution_created_at_before_cutoff",
      },
      clipping: {
        usageEventsPerParticipantPerCell: 1_000,
        tokensPerComponentPerParticipantPerCell: 5_000_000,
        toolUnitsPerParticipantPerCell: 1_000,
        usageEventsPerParticipantPerSnapshot: policy.accountUsageEventsCap,
        tokensPerComponentPerParticipantPerSnapshot: policy.accountTokenComponentsCap,
        toolUnitsPerParticipantPerSnapshot: policy.accountToolUnitsCap,
      },
      rounding: {
        usageEvents: 10,
        tokenComponents: 100_000,
        toolUnits: 10,
        direction: "down",
      },
      deletionDisposition: "withdraw_then_rebuild_without_deleted_source",
    },
  };
}

function suppressedPayload(
  base: Record<string, unknown>,
): object {
  return {
    ...base,
    releaseStatus: "suppressed",
    cells: [],
    reason: "privacy_release_policy_not_met",
  };
}

export async function buildCommunityWeeklySnapshot(
  db: D1Database,
  scheduledTime: number,
  policyOverride?: CommunitySnapshotPolicyOverride,
): Promise<{ state: "built" | "existing" | "lease_unavailable"; snapshotId: string }> {
  return buildCommunityWeeklySnapshotForPeriod(
    db,
    communityWeekForScheduledTime(scheduledTime),
    scheduledTime,
    policyOverride,
  );
}

function validateCommunityWeek(period: CommunityWeek): void {
  const start = Date.parse(period.startAt);
  const end = Date.parse(period.endAt);
  const cutoff = Date.parse(period.cutoffAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(cutoff)
      || new Date(start).toISOString() !== period.startAt
      || new Date(end).toISOString() !== period.endAt
      || new Date(cutoff).toISOString() !== period.cutoffAt
      || end - start !== WEEK
      || cutoff < end) {
    throw new Error("invalid community snapshot rebuild period");
  }
}

async function buildCommunityWeeklySnapshotForPeriod(
  db: D1Database,
  period: CommunityWeek,
  scheduledTime: number,
  policyOverride?: CommunitySnapshotPolicyOverride,
): Promise<{ state: "built" | "existing" | "lease_unavailable"; snapshotId: string }> {
  validateCommunityWeek(period);
  if (!Number.isFinite(scheduledTime)) throw new Error("invalid scheduled time");
  const { startAt, endAt, cutoffAt } = period;
  const { policy, mutationEpoch } = await readCommunitySnapshotPolicySnapshot(
    db,
    policyOverride,
  );
  const existing = await db.prepare(
    `SELECT snapshot_id, source_mutation_epoch
       FROM community_weekly_snapshots
      WHERE week_start = ? AND release_state IN ('published', 'suppressed')
      ORDER BY revision DESC LIMIT 1`,
  ).bind(startAt).first<{
    snapshot_id: string;
    source_mutation_epoch: number;
  }>();
  if (existing && existing.source_mutation_epoch >= mutationEpoch) {
    await db.prepare(
      `DELETE FROM community_weekly_snapshot_rebuilds
        WHERE week_start = ? AND requested_epoch <= ?`,
    ).bind(startAt, existing.source_mutation_epoch).run();
    return { state: "existing", snapshotId: existing.snapshot_id };
  }

  const owner = crypto.randomUUID();
  const now = new Date(scheduledTime).toISOString();
  const leaseExpiresAt = new Date(scheduledTime + COMMUNITY_WEEKLY_LEASE_MILLISECONDS)
    .toISOString();
  await db.prepare(
    `INSERT INTO community_snapshot_builders (
      week_start, owner_nonce, mutation_epoch, lease_expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(week_start) DO UPDATE SET
      owner_nonce = excluded.owner_nonce,
      mutation_epoch = excluded.mutation_epoch,
      lease_expires_at = excluded.lease_expires_at,
      created_at = excluded.created_at
    WHERE community_snapshot_builders.lease_expires_at <= ?`,
  ).bind(
    startAt,
    owner,
    mutationEpoch,
    leaseExpiresAt,
    now,
    now,
  ).run();
  const lease = await db.prepare(
    `SELECT owner_nonce, mutation_epoch FROM community_snapshot_builders
      WHERE week_start = ?`,
  ).bind(startAt).first<{ owner_nonce: string; mutation_epoch: number }>();
  if (lease?.owner_nonce !== owner || lease.mutation_epoch !== mutationEpoch) {
    return {
      state: "lease_unavailable",
      snapshotId: existing?.snapshot_id ?? `community-weekly:${startAt.slice(0, 10)}`,
    };
  }

  const revisionRow = await db.prepare(
    `SELECT COALESCE(MAX(revision), 0) + 1 AS revision
       FROM community_weekly_snapshots WHERE week_start = ?`,
  ).bind(startAt).first<{ revision: number }>();
  const revision = Number(revisionRow?.revision ?? 1);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("invalid community snapshot revision");
  }
  const snapshotId = revision === 1
    ? `community-weekly:${startAt.slice(0, 10)}`
    : `community-weekly:${startAt.slice(0, 10)}:r${revision}`;
  const maturityBeforeAt = new Date(
    Date.parse(endAt) - policy.maturityDays * DAY,
  ).toISOString();

  const cellRows = await db.prepare(
    `WITH caps AS (
      SELECT ? AS account_usage_events_cap,
             ? AS account_token_components_cap,
             ? AS account_tool_units_cap
    ), eligible_participants AS (
      SELECT DISTINCT p.id AS participant_id
        FROM participants p
        JOIN participant_community_eligibility e
          ON e.participant_id = p.id
       WHERE p.state = 'active'
         AND NOT EXISTS (
           SELECT 1
             FROM community_aggregate_exclusions x
            WHERE x.participant_id = p.id
              AND x.scope = 'community_weekly'
              AND x.state = 'active'
              AND x.effective_at < ?
              AND (x.expires_at IS NULL OR x.expires_at > ?)
         )
         -- v0.3 is explicitly an open, provider-account-gated cohort. Do not
         -- silently mix invite-only participants into a payload that makes
         -- that public claim; invite cohorts need their own reviewed contract.
         AND e.grant_id LIKE 'open:%'
         AND p.identity_link_key IS NOT NULL
         AND p.created_at <= ?
         AND (
           SELECT COUNT(DISTINCT substr(c.created_at, 1, 10))
             FROM telemetry_contributions c
            WHERE c.participant_id = p.id
              AND c.status = 'accepted'
              AND c.created_at >= ?
              AND c.created_at < ?
         ) >= ?
    ), participant_plans AS (
      SELECT r.participant_id,
        CASE WHEN COUNT(DISTINCT COALESCE(r.plan_type, 'unknown')) = 1
             THEN MAX(COALESCE(r.plan_type, 'unknown'))
             ELSE 'unknown' END AS plan_type,
        CASE WHEN COUNT(DISTINCT COALESCE(r.plan_variant, 'unknown')) = 1
             THEN MAX(COALESCE(r.plan_variant, 'unknown'))
             ELSE 'unknown' END AS plan_variant
      FROM telemetry_records r
      JOIN eligible_participants ep
        ON ep.participant_id = r.participant_id
      WHERE r.record_kind = 'quota'
        AND r.observed_at >= ? AND r.observed_at < ?
        AND EXISTS (
          SELECT 1
            FROM telemetry_contribution_occurrences o
            JOIN telemetry_contributions c ON c.id = o.contribution_id
           WHERE o.participant_id = r.participant_id
             AND o.record_kind = r.record_kind
             AND o.occurrence_id = r.occurrence_id
             AND c.status = 'accepted'
             AND c.created_at < ?
        )
      GROUP BY r.participant_id
    ), qualified AS (
      SELECT
        r.participant_id,
        r.provider,
        COALESCE(pp.plan_type, 'unknown') AS plan_type,
        COALESCE(pp.plan_variant, 'unknown') AS plan_variant,
        CASE
        WHEN r.model_id IN (${PUBLIC_MODEL_IDS_SQL})
        THEN r.model_id ELSE 'unknown' END AS model_id,
        r.input_uncached_tokens, r.input_cache_read_tokens,
        r.input_cache_write_tokens, r.output_text_tokens,
        r.output_reasoning_tokens, r.output_combined_tokens, r.tool_units
      FROM telemetry_records r
      LEFT JOIN participant_plans pp
        ON pp.participant_id = r.participant_id
      JOIN eligible_participants ep
        ON ep.participant_id = r.participant_id
      WHERE r.record_kind = 'usage'
        AND r.observed_at >= ? AND r.observed_at < ?
        AND r.provider IN ('openai_codex', 'anthropic_claude_code')
        AND EXISTS (
          SELECT 1
            FROM telemetry_contribution_occurrences o
            JOIN telemetry_contributions c ON c.id = o.contribution_id
           WHERE o.participant_id = r.participant_id
             AND o.record_kind = r.record_kind
             AND o.occurrence_id = r.occurrence_id
             AND c.status = 'accepted'
             AND c.created_at < ?
        )
    ), per_participant AS (
      SELECT participant_id, provider, plan_type, plan_variant, model_id,
        COUNT(*) AS usage_events,
        SUM(input_uncached_tokens) AS input_uncached_tokens,
        SUM(input_cache_read_tokens) AS input_cache_read_tokens,
        SUM(input_cache_write_tokens) AS input_cache_write_tokens,
        SUM(output_text_tokens) AS output_text_tokens,
        SUM(output_reasoning_tokens) AS output_reasoning_tokens,
        SUM(output_combined_tokens) AS output_combined_tokens,
        SUM(tool_units) AS tool_units
      FROM qualified
      GROUP BY participant_id, provider, plan_type, plan_variant, model_id
    ), per_cell_clipped AS (
      SELECT p.*, c.account_usage_events_cap,
        c.account_token_components_cap, c.account_tool_units_cap,
        MIN(p.usage_events, 1000) AS usage_events_cell_clipped,
        CASE WHEN p.input_uncached_tokens IS NULL THEN NULL
             ELSE MIN(p.input_uncached_tokens, 5000000) END
          AS input_uncached_tokens_cell_clipped,
        CASE WHEN p.input_cache_read_tokens IS NULL THEN NULL
             ELSE MIN(p.input_cache_read_tokens, 5000000) END
          AS input_cache_read_tokens_cell_clipped,
        CASE WHEN p.input_cache_write_tokens IS NULL THEN NULL
             ELSE MIN(p.input_cache_write_tokens, 5000000) END
          AS input_cache_write_tokens_cell_clipped,
        CASE WHEN p.output_text_tokens IS NULL THEN NULL
             ELSE MIN(p.output_text_tokens, 5000000) END
          AS output_text_tokens_cell_clipped,
        CASE WHEN p.output_reasoning_tokens IS NULL THEN NULL
             ELSE MIN(p.output_reasoning_tokens, 5000000) END
          AS output_reasoning_tokens_cell_clipped,
        CASE WHEN p.output_combined_tokens IS NULL THEN NULL
             ELSE MIN(p.output_combined_tokens, 5000000) END
          AS output_combined_tokens_cell_clipped,
        CASE WHEN p.tool_units IS NULL THEN NULL
             ELSE MIN(p.tool_units, 1000) END
          AS tool_units_cell_clipped
      FROM per_participant p
      CROSS JOIN caps c
    ), account_clipped AS (
      SELECT p.*,
        CASE WHEN p.usage_events_cell_clipped IS NULL THEN NULL ELSE MAX(0, MIN(
          p.usage_events_cell_clipped,
          p.account_usage_events_cap - COALESCE(SUM(p.usage_events_cell_clipped)
            OVER (PARTITION BY p.participant_id
                  ORDER BY p.provider, p.plan_type, p.plan_variant, p.model_id
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
        )) END AS usage_events_clipped,
        CASE WHEN p.input_uncached_tokens_cell_clipped IS NULL THEN NULL ELSE MAX(0, MIN(
          p.input_uncached_tokens_cell_clipped,
          p.account_token_components_cap - COALESCE(SUM(p.input_uncached_tokens_cell_clipped)
            OVER (PARTITION BY p.participant_id
                  ORDER BY p.provider, p.plan_type, p.plan_variant, p.model_id
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
        )) END AS input_uncached_tokens_clipped,
        CASE WHEN p.input_cache_read_tokens_cell_clipped IS NULL THEN NULL ELSE MAX(0, MIN(
          p.input_cache_read_tokens_cell_clipped,
          p.account_token_components_cap - COALESCE(SUM(p.input_cache_read_tokens_cell_clipped)
            OVER (PARTITION BY p.participant_id
                  ORDER BY p.provider, p.plan_type, p.plan_variant, p.model_id
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
        )) END AS input_cache_read_tokens_clipped,
        CASE WHEN p.input_cache_write_tokens_cell_clipped IS NULL THEN NULL ELSE MAX(0, MIN(
          p.input_cache_write_tokens_cell_clipped,
          p.account_token_components_cap - COALESCE(SUM(p.input_cache_write_tokens_cell_clipped)
            OVER (PARTITION BY p.participant_id
                  ORDER BY p.provider, p.plan_type, p.plan_variant, p.model_id
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
        )) END AS input_cache_write_tokens_clipped,
        CASE WHEN p.output_text_tokens_cell_clipped IS NULL THEN NULL ELSE MAX(0, MIN(
          p.output_text_tokens_cell_clipped,
          p.account_token_components_cap - COALESCE(SUM(p.output_text_tokens_cell_clipped)
            OVER (PARTITION BY p.participant_id
                  ORDER BY p.provider, p.plan_type, p.plan_variant, p.model_id
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
        )) END AS output_text_tokens_clipped,
        CASE WHEN p.output_reasoning_tokens_cell_clipped IS NULL THEN NULL ELSE MAX(0, MIN(
          p.output_reasoning_tokens_cell_clipped,
          p.account_token_components_cap - COALESCE(SUM(p.output_reasoning_tokens_cell_clipped)
            OVER (PARTITION BY p.participant_id
                  ORDER BY p.provider, p.plan_type, p.plan_variant, p.model_id
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
        )) END AS output_reasoning_tokens_clipped,
        CASE WHEN p.output_combined_tokens_cell_clipped IS NULL THEN NULL ELSE MAX(0, MIN(
          p.output_combined_tokens_cell_clipped,
          p.account_token_components_cap - COALESCE(SUM(p.output_combined_tokens_cell_clipped)
            OVER (PARTITION BY p.participant_id
                  ORDER BY p.provider, p.plan_type, p.plan_variant, p.model_id
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
        )) END AS output_combined_tokens_clipped,
        CASE WHEN p.tool_units_cell_clipped IS NULL THEN NULL ELSE MAX(0, MIN(
          p.tool_units_cell_clipped,
          p.account_tool_units_cap - COALESCE(SUM(p.tool_units_cell_clipped)
            OVER (PARTITION BY p.participant_id
                  ORDER BY p.provider, p.plan_type, p.plan_variant, p.model_id
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
        )) END AS tool_units_clipped
      FROM per_cell_clipped p
    )
    SELECT provider, plan_type, plan_variant, model_id,
      (SELECT COUNT(*) FROM eligible_participants) AS cohort_support,
      COUNT(*) AS usage_events_support,
      SUM(usage_events_clipped) AS usage_events_clipped,
      COUNT(input_uncached_tokens) AS input_uncached_tokens_support,
      SUM(input_uncached_tokens_clipped) AS input_uncached_tokens_clipped,
      COUNT(input_cache_read_tokens) AS input_cache_read_tokens_support,
      SUM(input_cache_read_tokens_clipped) AS input_cache_read_tokens_clipped,
      COUNT(input_cache_write_tokens) AS input_cache_write_tokens_support,
      SUM(input_cache_write_tokens_clipped) AS input_cache_write_tokens_clipped,
      COUNT(output_text_tokens) AS output_text_tokens_support,
      SUM(output_text_tokens_clipped) AS output_text_tokens_clipped,
      COUNT(output_reasoning_tokens) AS output_reasoning_tokens_support,
      SUM(output_reasoning_tokens_clipped) AS output_reasoning_tokens_clipped,
      COUNT(output_combined_tokens) AS output_combined_tokens_support,
      SUM(output_combined_tokens_clipped) AS output_combined_tokens_clipped,
      COUNT(tool_units) AS tool_units_support,
      SUM(tool_units_clipped) AS tool_units_clipped
    FROM account_clipped
    GROUP BY provider, plan_type, plan_variant, model_id
    HAVING COUNT(*) >= ?
    ORDER BY provider, plan_type, plan_variant, model_id
    LIMIT ?`,
  ).bind(
    policy.accountUsageEventsCap,
    policy.accountTokenComponentsCap,
    policy.accountToolUnitsCap,
    endAt,
    startAt,
    maturityBeforeAt,
    startAt,
    cutoffAt,
    policy.minimumAcceptedCollectionDays,
    startAt,
    endAt,
    cutoffAt,
    startAt,
    endAt,
    cutoffAt,
    COMMUNITY_WEEKLY_MINIMUM_PARTICIPANTS,
    COMMUNITY_WEEKLY_MAX_CELLS + 1,
  ).all<AggregatedCellRow>();

  const cohortSupport = Number(cellRows.results[0]?.cohort_support ?? 0);
  const base = basePayload(
    snapshotId,
    startAt,
    endAt,
    cutoffAt,
    revision,
    now,
    policy,
  );
  let releaseState: "published" | "suppressed" = "published";
  let payload: object;
  if (cohortSupport < COMMUNITY_WEEKLY_MINIMUM_PARTICIPANTS) {
    releaseState = "suppressed";
    payload = suppressedPayload(base);
  } else if (cellRows.results.length > COMMUNITY_WEEKLY_MAX_CELLS) {
    releaseState = "suppressed";
    payload = suppressedPayload(base);
  } else if (cellRows.results.length === 0) {
    releaseState = "suppressed";
    payload = suppressedPayload(base);
  } else {
    const cells = cellRows.results.map((row) => {
      const metrics = Object.fromEntries(METRICS.map(
        ([publicName, column, cap, quantum, unit]) => {
          const support = Number(row[`${column}_support` as keyof AggregatedCellRow]);
          if (support < COMMUNITY_WEEKLY_MINIMUM_PARTICIPANTS) {
            return [publicName, { status: "suppressed" }];
          }
          const clipped = Number(
            row[`${column}_clipped` as keyof AggregatedCellRow],
          );
          return [publicName, {
            status: "released",
            value: Math.floor(clipped / quantum) * quantum,
            unit: unit === "events" ? "events_rounded_down"
              : unit === "tokens" ? "tokens_rounded_down"
                : "tool_units_rounded_down",
          }];
        },
      ));
      return {
        provider: row.provider,
        planType: row.plan_type,
        planVariant: row.plan_variant,
        modelId: row.model_id,
        metrics,
      };
    });
    payload = { ...base, releaseStatus: "published", cells };
  }
  const payloadJson = canonicalJson(payload);
  const payloadHash = await sha256Hex(payloadJson);
  const results = await db.batch([
    db.prepare(
      `INSERT INTO community_weekly_snapshots (
        snapshot_id, week_start, week_end, revision, source_mutation_epoch,
        ingestion_cutoff_at, released_at, policy_version, payload_json,
        payload_sha256, release_state, sealed_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM community_snapshot_builders
         WHERE week_start = ? AND owner_nonce = ? AND mutation_epoch = ?
           AND lease_expires_at > ?
      )
      AND EXISTS (
        SELECT 1 FROM community_snapshot_mutation_control
         WHERE singleton_id = 1 AND mutation_epoch = ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM community_weekly_snapshots
         WHERE week_start = ? AND release_state IN ('published', 'suppressed')
      )`,
    ).bind(
      snapshotId,
      startAt,
      endAt,
      revision,
      mutationEpoch,
      cutoffAt,
      now,
      COMMUNITY_WEEKLY_POLICY_VERSION,
      payloadJson,
      payloadHash,
      releaseState,
      now,
      startAt,
      owner,
      mutationEpoch,
      now,
      mutationEpoch,
      startAt,
    ),
    db.prepare(
      `DELETE FROM community_snapshot_builders
        WHERE week_start = ? AND owner_nonce = ?`,
    ).bind(startAt, owner),
    db.prepare(
      `DELETE FROM community_weekly_snapshot_rebuilds
        WHERE week_start = ? AND requested_epoch <= ?
          AND EXISTS (
            SELECT 1 FROM community_weekly_snapshots
             WHERE snapshot_id = ? AND source_mutation_epoch = ?
               AND release_state IN ('published', 'suppressed')
          )`,
    ).bind(
      startAt,
      mutationEpoch,
      snapshotId,
      mutationEpoch,
    ),
  ]);
  if (results[0]?.meta.changes === 1) return { state: "built", snapshotId };
  const raced = await db.prepare(
    `SELECT snapshot_id, payload_sha256 FROM community_weekly_snapshots
      WHERE week_start = ? AND release_state IN ('published', 'suppressed')
      ORDER BY revision DESC LIMIT 1`,
  ).bind(startAt).first<{ snapshot_id: string; payload_sha256: string }>();
  if (raced?.payload_sha256 === payloadHash) {
    return { state: "existing", snapshotId: raced.snapshot_id };
  }
  throw new Error("community snapshot finalization cancelled or conflicted");
}

export async function rebuildPendingCommunityWeeklySnapshots(
  db: D1Database,
  scheduledTime: number,
  maximumRebuilds = 5,
  policyOverride?: CommunitySnapshotPolicyOverride,
): Promise<{ processed: number; remaining: boolean; snapshotIds: string[] }> {
  if (!Number.isFinite(scheduledTime)
      || !Number.isSafeInteger(maximumRebuilds)
      || maximumRebuilds < 1
      || maximumRebuilds > 10) {
    throw new Error("invalid community snapshot rebuild request");
  }
  const rows = await db.prepare(
    `SELECT week_start, week_end, ingestion_cutoff_at, requested_epoch
       FROM community_weekly_snapshot_rebuilds
      ORDER BY requested_epoch, week_start
      LIMIT ?`,
  ).bind(maximumRebuilds + 1).all<RebuildRow>();
  const snapshotIds: string[] = [];
  let processed = 0;
  for (const row of rows.results.slice(0, maximumRebuilds)) {
    const result = await buildCommunityWeeklySnapshotForPeriod(db, {
      startAt: row.week_start,
      endAt: row.week_end,
      cutoffAt: row.ingestion_cutoff_at,
    }, scheduledTime, policyOverride);
    if (result.state === "lease_unavailable") break;
    processed += 1;
    snapshotIds.push(result.snapshotId);
  }
  const pending = await db.prepare(
    "SELECT 1 AS pending FROM community_weekly_snapshot_rebuilds LIMIT 1",
  ).first<{ pending: number }>();
  return { processed, remaining: Boolean(pending), snapshotIds };
}

export type LatestCommunitySnapshotRead =
  | Readonly<{
      payloadJson: string;
      cacheable: false;
    }>
  | Readonly<{
      payloadJson: string;
      cacheable: true;
      snapshotId: string;
      revision: number;
    }>;

function publishedSnapshotIsCacheable(row: SnapshotRow): boolean {
  if (row.release_state !== "published"
      || !SNAPSHOT_ID_PATTERN.test(row.snapshot_id)
      || !Number.isSafeInteger(row.revision)
      || row.revision < 1) {
    return false;
  }
  const payload = parseStoredJson<unknown>(row.payload_json);
  return typeof payload === "object"
    && payload !== null
    && !Array.isArray(payload)
    && Reflect.get(payload, "schemaVersion") === SNAPSHOT_SCHEMA_VERSION
    && Reflect.get(payload, "releaseStatus") === "published"
    && Reflect.get(payload, "snapshotId") === row.snapshot_id
    && Reflect.get(payload, "snapshotRevision") === row.revision
    && Reflect.get(payload, "immutable") === true;
}

export async function readLatestCommunityWeeklySnapshot(
  db: D1Database,
): Promise<LatestCommunitySnapshotRead> {
  const row = await db.prepare(
    `SELECT payload_json, release_state, snapshot_id, revision, week_start, week_end,
            ingestion_cutoff_at
       FROM community_weekly_snapshots
      ORDER BY week_end DESC, revision DESC LIMIT 1`,
  ).first<SnapshotRow>();
  if (!row) {
    return Object.freeze({
      payloadJson: canonicalJson({
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        releaseStatus: "not_yet_published",
        reason: "stable_snapshot_unavailable",
        immutable: true,
        nonOverlapping: true,
      }),
      cacheable: false,
    });
  }
  if (row.release_state === "withdrawn") {
    return Object.freeze({
      payloadJson: canonicalJson({
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        releaseStatus: "withdrawn",
        snapshotId: row.snapshot_id,
        snapshotRevision: row.revision,
        period: { startAt: row.week_start, endAt: row.week_end },
        ingestionCutoffAt: row.ingestion_cutoff_at,
        reason: "source_data_withdrawn",
        immutable: true,
        nonOverlapping: true,
      }),
      cacheable: false,
    });
  }
  if (publishedSnapshotIsCacheable(row)) {
    return Object.freeze({
      payloadJson: row.payload_json,
      cacheable: true,
      snapshotId: row.snapshot_id,
      revision: row.revision,
    });
  }
  return Object.freeze({ payloadJson: row.payload_json, cacheable: false });
}

export async function readParticipantCommunityComparison(
  db: D1Database,
  participantId: string,
): Promise<object> {
  const row = await db.prepare(
    `SELECT payload_json, release_state, snapshot_id, revision, week_start,
            week_end, ingestion_cutoff_at
       FROM community_weekly_snapshots
      ORDER BY week_end DESC, revision DESC LIMIT 1`,
  ).first<SnapshotRow>();
  if (!row) return participantComparisonUnavailable("stable_snapshot_unavailable");
  if (row.release_state !== "published") {
    return participantComparisonUnavailable("community_snapshot_not_released", row);
  }

  const payload = parseStoredJson<unknown>(row.payload_json);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)
      || !COMPARISON_SOURCE_SNAPSHOT_SCHEMA_VERSIONS.has(
        Reflect.get(payload, "schemaVersion") as string,
      )
      || Reflect.get(payload, "releaseStatus") !== "published"
      || Reflect.get(payload, "snapshotId") !== row.snapshot_id
      || Reflect.get(payload, "snapshotRevision") !== row.revision
      || Reflect.get(payload, "immutable") !== true
      || !Array.isArray(Reflect.get(payload, "cells"))
      || (Reflect.get(payload, "cells") as unknown[]).length > COMMUNITY_WEEKLY_MAX_CELLS) {
    return participantComparisonUnavailable("community_snapshot_contract_invalid", row);
  }

  const participantPlanRow = await db.prepare(
    `SELECT
      CASE WHEN COUNT(DISTINCT COALESCE(r.plan_type, 'unknown')) = 1
           THEN MAX(COALESCE(r.plan_type, 'unknown'))
           ELSE 'unknown' END AS plan_type,
      CASE WHEN COUNT(DISTINCT COALESCE(r.plan_variant, 'unknown')) = 1
           THEN MAX(COALESCE(r.plan_variant, 'unknown'))
           ELSE 'unknown' END AS plan_variant
    FROM telemetry_records r
    WHERE r.participant_id = ?
      AND r.record_kind = 'quota'
      AND r.observed_at >= ? AND r.observed_at < ?
      AND EXISTS (
        SELECT 1
          FROM telemetry_contribution_occurrences o
          JOIN telemetry_contributions c ON c.id = o.contribution_id
         WHERE o.participant_id = r.participant_id
           AND o.record_kind = r.record_kind
           AND o.occurrence_id = r.occurrence_id
           AND c.status = 'accepted'
           AND c.created_at < ?
      )`,
  ).bind(
    participantId,
    row.week_start,
    row.week_end,
    row.ingestion_cutoff_at,
  ).first<{ plan_type: string | null; plan_variant: string | null }>();
  const participantPlanType = participantPlanRow?.plan_type ?? "unknown";
  const participantPlanVariant = participantPlanRow?.plan_variant ?? "unknown";

  const participantRows = await db.prepare(
    `SELECT
      r.provider,
      CASE
        WHEN r.model_id IN (${PUBLIC_MODEL_IDS_SQL})
        THEN r.model_id ELSE 'unknown' END AS model_id,
      COUNT(*) AS usage_events,
      SUM(r.input_uncached_tokens) AS input_uncached_tokens,
      SUM(r.input_cache_read_tokens) AS input_cache_read_tokens,
      SUM(r.input_cache_write_tokens) AS input_cache_write_tokens,
      SUM(r.output_text_tokens) AS output_text_tokens,
      SUM(r.output_reasoning_tokens) AS output_reasoning_tokens,
      SUM(r.output_combined_tokens) AS output_combined_tokens,
      SUM(r.tool_units) AS tool_units
    FROM telemetry_records r
    JOIN participants p
      ON p.id = r.participant_id AND p.state = 'active'
    WHERE r.participant_id = ?
      AND r.record_kind = 'usage'
      AND r.observed_at >= ? AND r.observed_at < ?
      AND r.provider IN ('openai_codex', 'anthropic_claude_code')
      AND EXISTS (
        SELECT 1 FROM participant_community_eligibility e
         WHERE e.participant_id = r.participant_id
      )
      AND EXISTS (
        SELECT 1
          FROM telemetry_contribution_occurrences o
          JOIN telemetry_contributions c ON c.id = o.contribution_id
         WHERE o.participant_id = r.participant_id
           AND o.record_kind = r.record_kind
           AND o.occurrence_id = r.occurrence_id
           AND c.status = 'accepted'
           AND c.created_at < ?
      )
    GROUP BY r.provider, model_id
    ORDER BY r.provider, model_id
    LIMIT ?`,
  ).bind(
    participantId,
    row.week_start,
    row.week_end,
    row.ingestion_cutoff_at,
    COMMUNITY_WEEKLY_MAX_CELLS + 1,
  ).all<ParticipantCellRow>();
  if (participantRows.results.length > COMMUNITY_WEEKLY_MAX_CELLS) {
    return participantComparisonUnavailable("participant_comparison_too_large", row);
  }
  const participantByCell = new Map(
    participantRows.results.map((item) => [
      `${item.provider}\0${item.model_id}`,
      item,
    ]),
  );
  const cells: object[] = [];
  for (const sourceCell of Reflect.get(payload, "cells") as unknown[]) {
    if (typeof sourceCell !== "object" || sourceCell === null || Array.isArray(sourceCell)) {
      return participantComparisonUnavailable("community_snapshot_contract_invalid", row);
    }
    const provider = Reflect.get(sourceCell, "provider");
    const planType = Reflect.get(sourceCell, "planType");
    const planVariant = Reflect.get(sourceCell, "planVariant");
    const modelId = Reflect.get(sourceCell, "modelId");
    const sourceMetrics = Reflect.get(sourceCell, "metrics");
    if (!["openai_codex", "anthropic_claude_code"].includes(String(provider))
        || !PLAN_COHORT_TYPES.has(String(planType))
        || !PLAN_COHORT_VARIANTS.includes(String(planVariant))
        || ![...TELEMETRY_MODEL_IDS, "unknown"].includes(String(modelId))
        || typeof sourceMetrics !== "object"
        || sourceMetrics === null
        || Array.isArray(sourceMetrics)) {
      return participantComparisonUnavailable("community_snapshot_contract_invalid", row);
    }
    const cellInParticipantCohort = planType === participantPlanType
      && planVariant === participantPlanVariant;
    const participant = cellInParticipantCohort
      ? participantByCell.get(`${provider}\0${modelId}`)
      : undefined;
    const metrics: Record<string, object> = {};
    for (const [publicName, column, cap, _quantum, unit] of METRICS) {
      const communityMetric = Reflect.get(sourceMetrics, publicName);
      if (typeof communityMetric !== "object"
          || communityMetric === null
          || Array.isArray(communityMetric)
          || !["released", "suppressed"].includes(
            String(Reflect.get(communityMetric, "status")),
          )) {
        return participantComparisonUnavailable(
          "community_snapshot_contract_invalid",
          row,
        );
      }
      if (Reflect.get(communityMetric, "status") === "suppressed") {
        metrics[publicName] = { status: "community_not_released" };
        continue;
      }
      const communityRoundedValue = Number(Reflect.get(communityMetric, "value"));
      if (!Number.isSafeInteger(communityRoundedValue)
          || communityRoundedValue < 0) {
        return participantComparisonUnavailable(
          "community_snapshot_contract_invalid",
          row,
        );
      }
      const participantSourceValue = participant
        ? participant[column as keyof ParticipantCellRow]
        : 0;
      if (participantSourceValue === null) {
        metrics[publicName] = {
          status: "participant_component_unavailable",
          communityRoundedValue,
          unit,
        };
        continue;
      }
      const participantValue = Number(participantSourceValue);
      if (!Number.isSafeInteger(participantValue) || participantValue < 0) {
        return participantComparisonUnavailable(
          "participant_comparison_contract_invalid",
          row,
        );
      }
      metrics[publicName] = {
        status: "comparable",
        participantClippedValue: Math.min(participantValue, cap),
        communityRoundedValue,
        unit,
      };
    }
    cells.push({
      provider,
      planType,
      planVariant,
      modelId,
      cohortMatchesParticipant: cellInParticipantCohort,
      participantHasActivity: Boolean(participant?.usage_events),
      metrics,
    });
  }
  return {
    schemaVersion: COMPARISON_SCHEMA_VERSION,
    status: "ready",
    snapshotId: row.snapshot_id,
    snapshotRevision: row.revision,
    period: { startAt: row.week_start, endAt: row.week_end },
    ingestionCutoffAt: row.ingestion_cutoff_at,
    participantPlanCohort: {
      planType: participantPlanType,
      planVariant: participantPlanVariant,
    },
    interpretation: "own_clipped_contribution_vs_public_rounded_total",
    cells,
  };
}
