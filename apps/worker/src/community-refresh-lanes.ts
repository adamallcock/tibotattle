import { communityAnalysisCacheVersion } from "./community-allowance";
import { COMMUNITY_DAILY_SPEND_PRICING_METHOD, COMMUNITY_DAILY_SPEND_REGISTRY_SHA256,
  DAILY_SPEND_CAPACITY_POLICY } from "./community-daily-spend";

export type CommunityRefreshLane = "current" | "daily";
export interface CommunityRefreshLanePin {
  lane: CommunityRefreshLane;
  sourceEpoch: number;
  day: string;
  method: string;
  current: boolean;
}

export function communityRefreshLaneMethod(lane: CommunityRefreshLane): string {
  return lane === "daily" ? `${communityAnalysisCacheVersion()}:${COMMUNITY_DAILY_SPEND_PRICING_METHOD}:${COMMUNITY_DAILY_SPEND_REGISTRY_SHA256}:${DAILY_SPEND_CAPACITY_POLICY}`
    : communityAnalysisCacheVersion();
}

/** One indexed metadata read on a no-change invocation. Completion never
 * depends on time elapsed and cannot skip a newly queued correction. */
export async function readCommunityRefreshLane(db: D1Database, lane: CommunityRefreshLane,
  nowMs: number): Promise<CommunityRefreshLanePin> {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const method = communityRefreshLaneMethod(lane);
  const row = await db.prepare(`SELECT s.mutation_epoch,l.source_epoch,l.utc_day,l.method_version,l.state,
      CASE WHEN ?1='daily' THEN EXISTS(SELECT 1 FROM community_daily_aggregate_rebuilds LIMIT 1) ELSE 0 END AS pending
    FROM community_snapshot_mutation_control s LEFT JOIN community_refresh_lanes l ON l.lane=?1
    WHERE s.singleton_id=1`).bind(lane).first<{
      mutation_epoch: number; source_epoch: number | null; utc_day: string | null;
      method_version: string | null; state: string | null; pending: number;
    }>();
  if (!row || !Number.isSafeInteger(row.mutation_epoch) || row.mutation_epoch < 0) {
    throw new TypeError("refresh lane source unavailable");
  }
  return { lane, sourceEpoch: row.mutation_epoch, day, method,
    current: row.state === "complete" && row.source_epoch === row.mutation_epoch
      && row.utc_day === day && row.method_version === method && row.pending === 0 };
}

/** The receipt and its source fence commit together. A concurrent upload cannot
 * make an incomplete generation look complete. No telemetry or cache is read. */
export async function recordCommunityRefreshLane(db: D1Database, pin: CommunityRefreshLanePin,
  complete: boolean, nowMs: number, maintenanceLease?: string): Promise<boolean> {
  const updatedAt = new Date(nowMs).toISOString();
  const written = await db.prepare(`INSERT INTO community_refresh_lanes
    (lane,source_epoch,utc_day,method_version,state,updated_at,completed_at,restart_reason)
    SELECT ?1,?2,?3,?4,?5,?6,?7,NULL
    WHERE EXISTS(SELECT 1 FROM community_snapshot_mutation_control WHERE singleton_id=1 AND mutation_epoch=?2)
      AND (?8 IS NULL OR EXISTS(SELECT 1 FROM retention_state WHERE singleton=1
        AND maintenance_lease_token=?8 AND maintenance_lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
      AND (?1!='daily' OR ?5!='complete' OR NOT EXISTS(SELECT 1 FROM community_daily_aggregate_rebuilds LIMIT 1))
    ON CONFLICT(lane) DO UPDATE SET source_epoch=excluded.source_epoch,utc_day=excluded.utc_day,
      method_version=excluded.method_version,state=excluded.state,updated_at=excluded.updated_at,
      completed_at=excluded.completed_at,
      restart_reason=CASE WHEN community_refresh_lanes.method_version!=excluded.method_version THEN 'method_changed'
        WHEN community_refresh_lanes.source_epoch!=excluded.source_epoch THEN 'input_changed'
        ELSE community_refresh_lanes.restart_reason END`)
    .bind(pin.lane, pin.sourceEpoch, pin.day, pin.method, complete ? "complete" : "queued", updatedAt,
      complete ? updatedAt : null, maintenanceLease ?? null).run();
  return written.meta.changes === 1;
}
