import { COMMUNITY_ATTRIBUTION_METHOD_VERSION, communityAnalysisCacheVersion } from "./community-allowance";
import { readCommunityModelHistoryProgress } from "./community-model-history";
import { communityRefreshLaneMethod } from "./community-refresh-lanes";
import { ApiError } from "./errors";

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError("invalid refresh metadata");
  return value;
}
function iso(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new TypeError("invalid refresh metadata");
  return new Date(value).toISOString();
}

export const PREPARATION_PROGRESS_DAY_LIMIT = 10_000;

/** A fixed-size metadata census, never a source-record scan or preparation
 * trigger. These are retained reusable inputs, not remaining history work. */
export async function readAdminPreparationProgress(db: D1Database) {
  try {
    const row = await db.prepare(`WITH preparation_heads AS (
      SELECT phase,progress_revision,quota_count,usage_count
      FROM community_prepared_source_days ORDER BY participant_id,source_day LIMIT ?1
    ) SELECT COUNT(*) AS tracked_days,
      TOTAL(CASE WHEN phase='complete' THEN 1 ELSE 0 END) AS complete_days,
      TOTAL(CASE WHEN phase IN ('quota','usage') THEN 1 ELSE 0 END) AS building_days,
      TOTAL(CASE WHEN phase='discarding' THEN 1 ELSE 0 END) AS retiring_days,
      TOTAL(progress_revision) AS checkpoint_steps,TOTAL(quota_count) AS quota_observations,
      TOTAL(usage_count) AS usage_events FROM preparation_heads`)
      .bind(PREPARATION_PROGRESS_DAY_LIMIT + 1).first<{
        tracked_days: number; complete_days: number; building_days: number; retiring_days: number;
        checkpoint_steps: number; quota_observations: number; usage_events: number;
      }>();
    if (!row || row.tracked_days > PREPARATION_PROGRESS_DAY_LIMIT) return null;
    const result = { trackedDays: count(row.tracked_days), completeDays: count(row.complete_days),
      buildingDays: count(row.building_days), retiringDays: count(row.retiring_days),
      checkpointSteps: count(row.checkpoint_steps), quotaObservations: count(row.quota_observations),
      usageEvents: count(row.usage_events) };
    return result.completeDays + result.buildingDays + result.retiringDays === result.trackedDays
      ? result : null;
  } catch {
    // An optional counter outage does not make already verified graph metadata
    // unavailable. TOTAL avoids SQLite integer overflow; unsafe totals stay null.
    return null;
  }
}

/** Owner-only, closed and content-free. Read-only metadata, not a maintenance
 * trigger or a fit/query fallback. Failure preserves the browser's last read. */
export async function readAdminGraphRefreshProgress(db: D1Database, nowMs: number, mode: unknown,
  options: { includePreparation?: boolean } = {}) {
  try {
    const generatedAt = new Date(nowMs).toISOString();
    const row = await db.prepare(`SELECT s.mutation_epoch,s.graph_invalidation_epoch,
      s.graph_last_change_reason,s.graph_last_change_at,s.graph_last_invalidated_at,
      p.source_mutation_epoch,p.generated_at,
      c.source_epoch AS current_epoch,c.state AS current_state,c.utc_day AS current_day,
      c.updated_at AS current_updated_at,c.method_version AS current_method,c.restart_reason,
      d.source_epoch AS daily_epoch,d.state AS daily_state,d.utc_day AS daily_day,d.updated_at AS daily_updated_at,
      d.method_version AS daily_method,
      EXISTS(SELECT 1 FROM community_daily_aggregate_rebuilds LIMIT 1) AS daily_pending
      FROM community_snapshot_mutation_control s
      LEFT JOIN admin_community_allowance_preview_cache p ON p.singleton=1
        AND p.attribution_method_version=?1 AND p.source_mutation_epoch>=s.graph_invalidation_epoch
        AND p.source_mutation_epoch<=s.mutation_epoch
      LEFT JOIN community_refresh_lanes c ON c.lane='current'
      LEFT JOIN community_refresh_lanes d ON d.lane='daily'
      WHERE s.singleton_id=1`).bind(COMMUNITY_ATTRIBUTION_METHOD_VERSION).first<{
        mutation_epoch: number; graph_invalidation_epoch: number;
        graph_last_change_reason: string | null; graph_last_change_at: string | null; graph_last_invalidated_at: string | null;
        source_mutation_epoch: number | null; generated_at: string | null;
        current_epoch: number | null; current_state: string | null; current_day: string | null;
        current_updated_at: string | null; current_method: string | null; restart_reason: string | null;
        daily_epoch: number | null; daily_state: string | null; daily_day: string | null;
        daily_updated_at: string | null; daily_pending: number; daily_method: string | null;
      }>();
    if (!row) throw new TypeError("refresh metadata absent");
    const history = await readCommunityModelHistoryProgress(db, nowMs);
    const preparation = options.includePreparation ? await readAdminPreparationProgress(db) : null;
    const after = await db.prepare(`SELECT s.mutation_epoch,p.source_mutation_epoch,p.generated_at
      FROM community_snapshot_mutation_control s LEFT JOIN admin_community_allowance_preview_cache p ON p.singleton=1
        AND p.attribution_method_version=?1 AND p.source_mutation_epoch>=s.graph_invalidation_epoch
        AND p.source_mutation_epoch<=s.mutation_epoch WHERE s.singleton_id=1`)
      .bind(COMMUNITY_ATTRIBUTION_METHOD_VERSION)
      .first<{ mutation_epoch: number; source_mutation_epoch: number | null; generated_at: string | null }>();
    if (!history || after?.mutation_epoch !== row.mutation_epoch
      || after.source_mutation_epoch !== row.source_mutation_epoch || after.generated_at !== row.generated_at) {
      throw new TypeError("refresh metadata changed");
    }
    const requestedGeneration = count(row.mutation_epoch);
    const currentComplete = row.current_state === "complete" && row.current_epoch === requestedGeneration
      && row.current_day === generatedAt.slice(0, 10) && row.current_method === communityAnalysisCacheVersion();
    const dailyComplete = row.daily_pending === 0 && row.daily_state === "complete"
      && row.daily_epoch === requestedGeneration && row.daily_day === generatedAt.slice(0, 10)
      && row.daily_method === communityRefreshLaneMethod("daily");
    const publishedGeneration = row.source_mutation_epoch === null ? null : count(row.source_mutation_epoch);
    const phase = !currentComplete ? "current" as const : history.resolvedDays < history.requiredDays ? "history" as const
      : !dailyComplete ? "daily" as const : publishedGeneration !== requestedGeneration ? "publication" as const : null;
    const updatedAt = [iso(row.current_updated_at), iso(row.daily_updated_at), iso(row.graph_last_change_at)]
      .filter((value): value is string => value !== null).sort().at(-1) ?? null;
    const trigger = row.graph_last_change_reason === "accepted-append" ? "contribution" as const
      : row.graph_last_change_reason === "accepted-correction" ? "correction" as const
        : row.current_method !== null && row.current_method !== communityAnalysisCacheVersion() ? "method_change" as const
          : row.current_day !== null && row.current_day !== generatedAt.slice(0, 10) ? "day_boundary" as const : null;
    const restartReason = row.restart_reason === "input_changed" || row.restart_reason === "method_changed"
      || row.restart_reason === "retry" ? row.restart_reason : null;
    return { ...(options.includePreparation ? { schemaVersion: 2 as const, preparation } : { schemaVersion: 1 as const }), generatedAt,
      publication: { state: publishedGeneration !== null ? "ready" as const
        : row.graph_last_invalidated_at !== null ? "invalidated" as const : "empty" as const,
        requestedGeneration, preparedGeneration: currentComplete && history.resolvedDays === history.requiredDays
          ? requestedGeneration : null,
        publishedGeneration, publishedAt: iso(row.generated_at) },
      work: { state: mode === "paused" ? "paused" as const : mode !== "resumable" && mode !== "legacy"
        ? "unavailable" as const : phase === null ? "idle" as const : "queued" as const,
        phase, updatedAt, trigger, restartReason }, history };
  } catch {
    throw new ApiError(503, "ADMIN_RECONSTRUCTION_PROGRESS_UNAVAILABLE");
  }
}
