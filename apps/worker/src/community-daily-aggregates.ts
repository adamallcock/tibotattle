import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";

/**
 * Day-partitioned community aggregates for telemetry-contribution-v1.0
 * (docs/design/2026-08-07-incremental-contribution-model.md, section 4).
 *
 * This deliberately reuses the revisioned pattern migration 0012 established
 * for weekly snapshots — published revisions are immutable rows, recomputation
 * writes revision N+1 — and replaces the sealing semantics: any accepted chunk
 * revision enqueues its day (via the 0031 journal trigger) and the hourly cron
 * drains the queue, so June recomputes when June data lands in August. Per
 * owner decision 4, no per-day suppression threshold blocks publication.
 */
export const COMMUNITY_DAILY_POLICY_VERSION = "community-daily-v1.0";
const DAILY_AGGREGATE_SCHEMA_VERSION = "community-daily-aggregate-v1.0";
const MAX_DAILY_AGGREGATE_CELLS = 100;

interface DailyRebuildRow {
  day: string;
  requested_epoch: number;
  requested_at: string;
}

interface DailyTotalsRow {
  contributing_participants: number;
  contributing_devices: number;
  usage_events: number;
  quota_observations: number;
  session_dimensions: number;
  input_uncached_tokens: number;
  input_cache_read_tokens: number;
  input_cache_write_tokens: number;
  output_text_tokens: number;
  output_reasoning_tokens: number;
  output_combined_tokens: number;
}

interface DailyCellRow {
  provider: string;
  model_id: string;
  usage_events: number;
  input_uncached_tokens: number;
  input_cache_read_tokens: number;
  input_cache_write_tokens: number;
  output_text_tokens: number;
  output_reasoning_tokens: number;
  output_combined_tokens: number;
}

async function buildCommunityDailyAggregate(
  db: D1Database,
  rebuild: DailyRebuildRow,
  scheduledTime: number,
): Promise<{ state: "built" | "conflicted"; aggregateId: string }> {
  const { day } = rebuild;
  // Bind the build to the mutation epoch it read its sources under, exactly
  // as the weekly builder does: a participant deletion bumps the epoch (0012
  // trigger), so a build racing a deletion cannot publish the deleted data —
  // its finalization predicate below rejects the stale snapshot.
  const epochRow = await db.prepare(
    `SELECT mutation_epoch FROM community_snapshot_mutation_control
      WHERE singleton_id = 1`,
  ).first<{ mutation_epoch: number }>();
  const buildEpoch = Number(epochRow?.mutation_epoch);
  if (!Number.isSafeInteger(buildEpoch) || buildEpoch < 0) {
    throw new Error("community daily aggregate mutation control unavailable");
  }
  const [totals, cells, revisionRow] = await Promise.all([
    db.prepare(
      `SELECT
        COUNT(DISTINCT r.participant_id) AS contributing_participants,
        COUNT(DISTINCT r.participant_id || ':' || r.device_id)
          AS contributing_devices,
        SUM(CASE WHEN r.stream = 'usage' THEN 1 ELSE 0 END) AS usage_events,
        SUM(CASE WHEN r.stream = 'quota' THEN 1 ELSE 0 END)
          AS quota_observations,
        SUM(CASE WHEN r.stream = 'session' THEN 1 ELSE 0 END)
          AS session_dimensions,
        COALESCE(SUM(r.input_uncached_tokens), 0) AS input_uncached_tokens,
        COALESCE(SUM(r.input_cache_read_tokens), 0)
          AS input_cache_read_tokens,
        COALESCE(SUM(r.input_cache_write_tokens), 0)
          AS input_cache_write_tokens,
        COALESCE(SUM(r.output_text_tokens), 0) AS output_text_tokens,
        COALESCE(SUM(r.output_reasoning_tokens), 0)
          AS output_reasoning_tokens,
        COALESCE(SUM(r.output_combined_tokens), 0) AS output_combined_tokens
       FROM telemetry_v1_records r
       JOIN participants p ON p.id = r.participant_id AND p.state = 'active'
       WHERE r.observed_day = ?`,
    ).bind(day).first<DailyTotalsRow>(),
    db.prepare(
      `SELECT r.provider, r.model_id,
        COUNT(*) AS usage_events,
        COALESCE(SUM(r.input_uncached_tokens), 0) AS input_uncached_tokens,
        COALESCE(SUM(r.input_cache_read_tokens), 0)
          AS input_cache_read_tokens,
        COALESCE(SUM(r.input_cache_write_tokens), 0)
          AS input_cache_write_tokens,
        COALESCE(SUM(r.output_text_tokens), 0) AS output_text_tokens,
        COALESCE(SUM(r.output_reasoning_tokens), 0)
          AS output_reasoning_tokens,
        COALESCE(SUM(r.output_combined_tokens), 0) AS output_combined_tokens
       FROM telemetry_v1_records r
       JOIN participants p ON p.id = r.participant_id AND p.state = 'active'
       WHERE r.observed_day = ? AND r.stream = 'usage'
       GROUP BY r.provider, r.model_id
       ORDER BY r.provider, r.model_id
       LIMIT ?`,
    ).bind(day, MAX_DAILY_AGGREGATE_CELLS + 1).all<DailyCellRow>(),
    db.prepare(
      `SELECT COALESCE(MAX(revision), 0) + 1 AS revision
         FROM community_daily_aggregates WHERE day = ?`,
    ).bind(day).first<{ revision: number }>(),
  ]);
  const revision = Number(revisionRow?.revision ?? 1);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("invalid community daily aggregate revision");
  }
  const aggregateId = `community-daily:${day}:r${revision}`;
  const releasedAt = new Date(scheduledTime).toISOString();
  const cellRows = cells.results.slice(0, MAX_DAILY_AGGREGATE_CELLS);
  const payload = {
    schemaVersion: DAILY_AGGREGATE_SCHEMA_VERSION,
    aggregateId,
    day,
    revision,
    releasedAt,
    // Revisions replace sealing: this row never mutates, and late or revised
    // source data produces the next revision instead of being rejected.
    immutableRevision: true,
    recomputesOnLateData: true,
    policyVersion: COMMUNITY_DAILY_POLICY_VERSION,
    suppression: "none_daily_grain_by_owner_decision",
    totals: {
      contributingParticipants: Number(totals?.contributing_participants ?? 0),
      contributingDevices: Number(totals?.contributing_devices ?? 0),
      usageEvents: Number(totals?.usage_events ?? 0),
      quotaObservations: Number(totals?.quota_observations ?? 0),
      sessionDimensions: Number(totals?.session_dimensions ?? 0),
      inputUncachedTokens: Number(totals?.input_uncached_tokens ?? 0),
      inputCacheReadTokens: Number(totals?.input_cache_read_tokens ?? 0),
      inputCacheWriteTokens: Number(totals?.input_cache_write_tokens ?? 0),
      outputTextTokens: Number(totals?.output_text_tokens ?? 0),
      outputReasoningTokens: Number(totals?.output_reasoning_tokens ?? 0),
      outputCombinedTokens: Number(totals?.output_combined_tokens ?? 0),
    },
    cellsTruncated: cells.results.length > MAX_DAILY_AGGREGATE_CELLS,
    cells: cellRows.map((cell) => ({
      provider: cell.provider,
      modelId: cell.model_id,
      usageEvents: Number(cell.usage_events),
      inputUncachedTokens: Number(cell.input_uncached_tokens),
      inputCacheReadTokens: Number(cell.input_cache_read_tokens),
      inputCacheWriteTokens: Number(cell.input_cache_write_tokens),
      outputTextTokens: Number(cell.output_text_tokens),
      outputReasoningTokens: Number(cell.output_reasoning_tokens),
      outputCombinedTokens: Number(cell.output_combined_tokens),
    })),
  };
  const payloadJson = canonicalJson(payload);
  const payloadHash = await sha256Hex(payloadJson);
  const results = await db.batch([
    // The finalization predicate mirrors the weekly builder's: the build is
    // cancelled outright when the mutation epoch moved after its source
    // reads — a deletion mid-build must never publish the deleted data.
    db.prepare(
      `INSERT INTO community_daily_aggregates (
        aggregate_id, day, revision, source_mutation_epoch, policy_version,
        payload_json, payload_sha256, release_state, released_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, 'published', ?
      WHERE NOT EXISTS (
        SELECT 1 FROM community_daily_aggregates
         WHERE day = ? AND revision >= ?
      )
      AND EXISTS (
        SELECT 1 FROM community_snapshot_mutation_control
         WHERE singleton_id = 1 AND mutation_epoch = ?
      )`,
    ).bind(
      aggregateId,
      day,
      revision,
      buildEpoch,
      COMMUNITY_DAILY_POLICY_VERSION,
      payloadJson,
      payloadHash,
      releasedAt,
      day,
      revision,
      buildEpoch,
    ),
    // Clear exactly the request this build answered, and only when this
    // build's revision actually published. A cancelled build leaves the row
    // queued for the next pass; a concurrent arrival upserts a fresh
    // requested_at and the delete no-ops — convergent, never lossy.
    db.prepare(
      `DELETE FROM community_daily_aggregate_rebuilds
        WHERE day = ? AND requested_at = ? AND requested_epoch = ?
          AND EXISTS (
            SELECT 1 FROM community_daily_aggregates
             WHERE day = ? AND revision = ? AND source_mutation_epoch = ?
               AND release_state = 'published'
          )`,
    ).bind(
      day,
      rebuild.requested_at,
      rebuild.requested_epoch,
      day,
      revision,
      buildEpoch,
    ),
  ]);
  if (results[0]?.meta.changes === 1) {
    return { state: "built", aggregateId };
  }
  return { state: "conflicted", aggregateId };
}

export async function rebuildPendingCommunityDailyAggregates(
  db: D1Database,
  scheduledTime: number,
  maximumRebuilds = 24,
): Promise<{ processed: number; remaining: boolean; aggregateIds: string[] }> {
  if (!Number.isFinite(scheduledTime)
      || !Number.isSafeInteger(maximumRebuilds)
      || maximumRebuilds < 1
      || maximumRebuilds > 48) {
    throw new Error("invalid community daily aggregate rebuild request");
  }
  const rows = await db.prepare(
    `SELECT day, requested_epoch, requested_at
       FROM community_daily_aggregate_rebuilds
      ORDER BY day ASC
      LIMIT ?`,
  ).bind(maximumRebuilds + 1).all<DailyRebuildRow>();
  const aggregateIds: string[] = [];
  let processed = 0;
  for (const row of rows.results.slice(0, maximumRebuilds)) {
    const result = await buildCommunityDailyAggregate(db, row, scheduledTime);
    processed += 1;
    aggregateIds.push(result.aggregateId);
  }
  const pending = await db.prepare(
    "SELECT 1 AS pending FROM community_daily_aggregate_rebuilds LIMIT 1",
  ).first<{ pending: number }>();
  return { processed, remaining: Boolean(pending), aggregateIds };
}

export interface LatestCommunityDailyAggregateRow {
  aggregate_id: string;
  day: string;
  revision: number;
  release_state: "published" | "withdrawn";
  payload_json: string;
}

export async function readLatestCommunityDailyAggregate(
  db: D1Database,
  day: string,
): Promise<LatestCommunityDailyAggregateRow | null> {
  return db.prepare(
    `SELECT aggregate_id, day, revision, release_state, payload_json
       FROM community_daily_aggregates
      WHERE day = ?
      ORDER BY revision DESC
      LIMIT 1`,
  ).bind(day).first<LatestCommunityDailyAggregateRow>();
}
