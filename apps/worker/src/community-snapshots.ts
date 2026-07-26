import {
  COMMUNITY_WEEKLY_CUTOFF_MILLISECONDS,
  COMMUNITY_WEEKLY_LEASE_MILLISECONDS,
  COMMUNITY_WEEKLY_MAX_CELLS,
  COMMUNITY_WEEKLY_MINIMUM_PARTICIPANTS,
  COMMUNITY_WEEKLY_POLICY_VERSION,
} from "./constants";
import { sha256Hex } from "./crypto";
import { TELEMETRY_MODEL_IDS } from "./telemetry-validation";

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
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

interface AggregatedCellRow {
  provider: string;
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
  week_start: string;
  week_end: string;
  ingestion_cutoff_at: string;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

export function communityWeekForScheduledTime(scheduledTime: number): {
  startAt: string;
  endAt: string;
  cutoffAt: string;
} {
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
): Record<string, unknown> {
  return {
    schemaVersion: "community-weekly-snapshot-v0.1",
    snapshotId,
    period: { startAt, endAt },
    ingestionCutoffAt: cutoffAt,
    releasedAt: cutoffAt,
    immutable: true,
    nonOverlapping: true,
    privacyPolicy: {
      version: COMMUNITY_WEEKLY_POLICY_VERSION,
      minimumIndependentParticipants: COMMUNITY_WEEKLY_MINIMUM_PARTICIPANTS,
      clipping: {
        usageEventsPerParticipantPerCell: 1_000,
        tokensPerComponentPerParticipantPerCell: 5_000_000,
        toolUnitsPerParticipantPerCell: 1_000,
      },
      rounding: {
        usageEvents: 10,
        tokenComponents: 100_000,
        toolUnits: 10,
        direction: "down",
      },
      deletionDisposition: "withdraw_all_snapshots",
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
): Promise<{ state: "built" | "existing" | "lease_unavailable"; snapshotId: string }> {
  const { startAt, endAt, cutoffAt } = communityWeekForScheduledTime(scheduledTime);
  const snapshotId = `community-weekly:${startAt.slice(0, 10)}`;
  const existing = await db.prepare(
    "SELECT snapshot_id FROM community_weekly_snapshots WHERE week_start = ?",
  ).bind(startAt).first<{ snapshot_id: string }>();
  if (existing) return { state: "existing", snapshotId: existing.snapshot_id };

  const epochRow = await db.prepare(
    `SELECT mutation_epoch FROM community_snapshot_mutation_control
      WHERE singleton_id = 1`,
  ).first<{ mutation_epoch: number }>();
  if (!epochRow) throw new Error("community snapshot mutation control unavailable");
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
    epochRow.mutation_epoch,
    leaseExpiresAt,
    now,
    now,
  ).run();
  const lease = await db.prepare(
    `SELECT owner_nonce, mutation_epoch FROM community_snapshot_builders
      WHERE week_start = ?`,
  ).bind(startAt).first<{ owner_nonce: string; mutation_epoch: number }>();
  if (lease?.owner_nonce !== owner || lease.mutation_epoch !== epochRow.mutation_epoch) {
    return { state: "lease_unavailable", snapshotId };
  }

  const cellRows = await db.prepare(
    `WITH qualified AS (
      SELECT
        r.participant_id,
        r.provider,
        CASE
        WHEN r.model_id IN (${PUBLIC_MODEL_IDS_SQL})
        THEN r.model_id ELSE 'unknown' END AS model_id,
        r.input_uncached_tokens, r.input_cache_read_tokens,
        r.input_cache_write_tokens, r.output_text_tokens,
        r.output_reasoning_tokens, r.output_combined_tokens, r.tool_units
      FROM telemetry_records r
      WHERE r.record_kind = 'usage'
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
    ), per_participant AS (
      SELECT participant_id, provider, model_id,
        COUNT(*) AS usage_events,
        SUM(input_uncached_tokens) AS input_uncached_tokens,
        SUM(input_cache_read_tokens) AS input_cache_read_tokens,
        SUM(input_cache_write_tokens) AS input_cache_write_tokens,
        SUM(output_text_tokens) AS output_text_tokens,
        SUM(output_reasoning_tokens) AS output_reasoning_tokens,
        SUM(output_combined_tokens) AS output_combined_tokens,
        SUM(tool_units) AS tool_units
      FROM qualified
      GROUP BY participant_id, provider, model_id
    )
    SELECT provider, model_id,
      (SELECT COUNT(DISTINCT participant_id) FROM qualified) AS cohort_support,
      COUNT(*) AS usage_events_support,
      SUM(MIN(usage_events, 1000)) AS usage_events_clipped,
      COUNT(input_uncached_tokens) AS input_uncached_tokens_support,
      SUM(MIN(input_uncached_tokens, 5000000)) AS input_uncached_tokens_clipped,
      COUNT(input_cache_read_tokens) AS input_cache_read_tokens_support,
      SUM(MIN(input_cache_read_tokens, 5000000)) AS input_cache_read_tokens_clipped,
      COUNT(input_cache_write_tokens) AS input_cache_write_tokens_support,
      SUM(MIN(input_cache_write_tokens, 5000000)) AS input_cache_write_tokens_clipped,
      COUNT(output_text_tokens) AS output_text_tokens_support,
      SUM(MIN(output_text_tokens, 5000000)) AS output_text_tokens_clipped,
      COUNT(output_reasoning_tokens) AS output_reasoning_tokens_support,
      SUM(MIN(output_reasoning_tokens, 5000000)) AS output_reasoning_tokens_clipped,
      COUNT(output_combined_tokens) AS output_combined_tokens_support,
      SUM(MIN(output_combined_tokens, 5000000)) AS output_combined_tokens_clipped,
      COUNT(tool_units) AS tool_units_support,
      SUM(MIN(tool_units, 1000)) AS tool_units_clipped
    FROM per_participant
    GROUP BY provider, model_id
    HAVING COUNT(*) >= ?
    ORDER BY provider, model_id
    LIMIT ?`,
  ).bind(
    startAt,
    endAt,
    cutoffAt,
    COMMUNITY_WEEKLY_MINIMUM_PARTICIPANTS,
    COMMUNITY_WEEKLY_MAX_CELLS + 1,
  ).all<AggregatedCellRow>();

  const cohortSupport = Number(cellRows.results[0]?.cohort_support ?? 0);
  const base = basePayload(snapshotId, startAt, endAt, cutoffAt);
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
      return { provider: row.provider, modelId: row.model_id, metrics };
    });
    payload = { ...base, releaseStatus: "published", cells };
  }
  const payloadJson = stableJson(payload);
  const payloadHash = await sha256Hex(payloadJson);
  const results = await db.batch([
    db.prepare(
      `INSERT INTO community_weekly_snapshots (
        snapshot_id, week_start, week_end, ingestion_cutoff_at, released_at,
        policy_version, payload_json, payload_sha256, release_state, sealed_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
        SELECT 1 FROM community_weekly_snapshots WHERE week_start = ?
      )`,
    ).bind(
      snapshotId,
      startAt,
      endAt,
      cutoffAt,
      cutoffAt,
      COMMUNITY_WEEKLY_POLICY_VERSION,
      payloadJson,
      payloadHash,
      releaseState,
      now,
      startAt,
      owner,
      epochRow.mutation_epoch,
      now,
      epochRow.mutation_epoch,
      startAt,
    ),
    db.prepare(
      `DELETE FROM community_snapshot_builders
        WHERE week_start = ? AND owner_nonce = ?`,
    ).bind(startAt, owner),
  ]);
  if (results[0]?.meta.changes === 1) return { state: "built", snapshotId };
  const raced = await db.prepare(
    `SELECT snapshot_id, payload_sha256 FROM community_weekly_snapshots
      WHERE week_start = ?`,
  ).bind(startAt).first<{ snapshot_id: string; payload_sha256: string }>();
  if (raced?.payload_sha256 === payloadHash) {
    return { state: "existing", snapshotId: raced.snapshot_id };
  }
  throw new Error("community snapshot finalization cancelled or conflicted");
}

export async function readLatestCommunityWeeklySnapshot(
  db: D1Database,
): Promise<string> {
  const row = await db.prepare(
    `SELECT payload_json, release_state, snapshot_id, week_start, week_end,
            ingestion_cutoff_at
       FROM community_weekly_snapshots
      ORDER BY week_end DESC LIMIT 1`,
  ).first<SnapshotRow>();
  if (!row) {
    return stableJson({
      schemaVersion: "community-weekly-snapshot-v0.1",
      releaseStatus: "not_yet_published",
      reason: "stable_snapshot_unavailable",
      immutable: true,
      nonOverlapping: true,
    });
  }
  if (row.release_state === "withdrawn") {
    return stableJson({
      schemaVersion: "community-weekly-snapshot-v0.1",
      releaseStatus: "withdrawn",
      snapshotId: row.snapshot_id,
      period: { startAt: row.week_start, endAt: row.week_end },
      ingestionCutoffAt: row.ingestion_cutoff_at,
      reason: "source_data_withdrawn",
      immutable: true,
      nonOverlapping: true,
    });
  }
  return row.payload_json;
}
