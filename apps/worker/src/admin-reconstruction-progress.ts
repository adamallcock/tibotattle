import { SEVEN_DAY_WINDOW_MINUTES } from "@app-usagemonitor/quota-analysis";
import { isCurrentCommunityDailySpend } from "./community-daily-spend";
import { isCurrentCommunityAllowancePublication,
  type CommunityAllowancePublicationStateRow } from "./community-daily-aggregates";
import { V1_ANALYSIS_WINDOW_DAYS, V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION,
  MAX_DOWNSAMPLED_QUOTA_ROWS } from "./quota-analysis-v1";

const DAY_MS = 86_400_000;
const MAX_ACCOUNTS = 10_000;
const MAX_PENDING_DAYS = 10_000;
const SCHEMA = "admin-reconstruction-progress-v0.1";
type Mode = "resumable" | "synchronous" | "paused" | "unknown";
interface PhaseRow { phase: string; total: number; progress: number; }
interface DailyRow { released_at: string | null; spend_json: string | null;
  usage_events: number | null; revision_probe_capped: number; }

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("invalid reconstruction count");
  }
  return value;
}
function timestamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("invalid reconstruction timestamp");
  }
  return new Date(value).toISOString();
}

/** Indexed, content-free checkpoint census, not another analysis/cache reader.
 * A complete checkpoint means acquisition finished, NOT a current published fit.
 * Exclude erased accounts and explicitly separate work invalidated by uploads,
 * a changed adapter/window, or successor-domain activation. Never return IDs.
 */
export const ADMIN_RECONSTRUCTION_PHASES_SQL = `WITH head_page AS MATERIALIZED (
  SELECT participant_id,input_revision,source_method_version,observed_at_cutoff,
    resets_at_cutoff,window_minutes,max_quota_rows,phase,progress_revision
  FROM community_analysis_work ORDER BY participant_id LIMIT ?3
)
SELECT phase, COUNT(*) AS total,
    SUM(progress_revision) AS progress FROM (
  SELECT CASE WHEN v.revision IS NULL OR v.revision != h.input_revision
      OR h.source_method_version != ?1 OR h.observed_at_cutoff != ?2
      OR h.resets_at_cutoff != ?4 OR h.window_minutes != ?5 OR h.max_quota_rows != ?6
      OR EXISTS (SELECT 1 FROM telemetry_v11_domain_heads d WHERE d.participant_id=h.participant_id)
    THEN 'source_changed' ELSE h.phase END AS phase, h.progress_revision
  FROM head_page h CROSS JOIN participants p ON p.id=h.participant_id
  LEFT JOIN community_analytical_input_versions v ON v.participant_id=h.participant_id
  WHERE p.state='active'
) GROUP BY phase
UNION ALL SELECT '__page__', COUNT(*), 0 FROM head_page`;

export const ADMIN_RECONSTRUCTION_NEWEST_SQL = `WITH cache_page AS MATERIALIZED (
  SELECT participant_id,computed_at FROM community_allowance_fit_cache
  ORDER BY participant_id LIMIT ?1
)
SELECT MAX(c.computed_at) AS newest, (SELECT COUNT(*) FROM cache_page) AS examined
FROM cache_page c CROSS JOIN participants p ON p.id=c.participant_id WHERE p.state='active'`;

/** At most 366 day probes, each capped at 32 physical revisions before filtering.
 * An exhausted withdrawn prefix is unavailable, not a falsely missing day.
 * Only the small additive spend block crosses into JS, never daily cells.
 */
export const ADMIN_RECONSTRUCTION_DAYS_SQL = `WITH RECURSIVE days(day) AS (
  SELECT ?1 UNION ALL SELECT date(day, '+1 day') FROM days WHERE day < ?2
)
SELECT a.released_at,
  CASE WHEN a.aggregate_id IS NULL THEN (
    SELECT COUNT(*) >= 32 FROM (SELECT aggregate_id FROM community_daily_aggregates
      WHERE day=days.day ORDER BY revision DESC LIMIT 32)
  ) ELSE 0 END AS revision_probe_capped,
  CASE WHEN json_valid(a.payload_json) THEN
    CASE WHEN json_type(a.payload_json, '$.apiEquivalentSpend') = 'object'
      AND length(json_extract(a.payload_json, '$.apiEquivalentSpend')) <= 2048
      THEN json_extract(a.payload_json, '$.apiEquivalentSpend') ELSE NULL END
    ELSE NULL END AS spend_json,
  CASE WHEN json_valid(a.payload_json) THEN
    CASE WHEN json_type(a.payload_json, '$.totals.usageEvents') = 'integer'
      THEN json_extract(a.payload_json, '$.totals.usageEvents') ELSE NULL END
    ELSE NULL END AS usage_events
FROM days LEFT JOIN community_daily_aggregates a ON a.aggregate_id = (
  SELECT aggregate_id FROM (
    SELECT aggregate_id,release_state,revision FROM community_daily_aggregates
    WHERE day=days.day ORDER BY revision DESC LIMIT 32
  ) WHERE release_state='published' ORDER BY revision DESC LIMIT 1
) LIMIT 366`;

/** Optional owner-only diagnostics. Failure cannot take Operations down.
 * Every read is a bounded derived-table lookup; refresh never advances work.
 */
export async function readAdminReconstructionProgress(db: D1Database,
  nowMs: number, reconstructionMode: unknown = "unknown") {
  const observedAt = new Date(nowMs).toISOString();
  const mode: Mode = reconstructionMode === "legacy" ? "synchronous"
    : reconstructionMode === "resumable" || reconstructionMode === "paused"
      ? reconstructionMode : "unknown";
  const base = { schemaVersion: SCHEMA, observedAt, mode };
  try {
    const toDay = observedAt.slice(0, 10);
    const fromDay = new Date(Date.parse(`${toDay}T00:00:00.000Z`) - 365 * DAY_MS).toISOString().slice(0, 10);
    const cutoff = `${new Date(nowMs - V1_ANALYSIS_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10)}T00:00:00.000Z`;
    const resetsCutoff = new Date(Date.parse(cutoff) + SEVEN_DAY_WINDOW_MINUTES * 60_000).toISOString();
    const [lookup, phases, newest, maintenance, publication, pending, days] = await Promise.all([
      db.prepare(`SELECT through_record_id, last_record_id, is_complete
        FROM telemetry_v1_quota_fit_backfill WHERE singleton_id=1`)
        .first<{ through_record_id: number; last_record_id: number; is_complete: number }>(),
      db.prepare(ADMIN_RECONSTRUCTION_PHASES_SQL)
        .bind(V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION, cutoff, MAX_ACCOUNTS,
          resetsCutoff, SEVEN_DAY_WINDOW_MINUTES, MAX_DOWNSAMPLED_QUOTA_ROWS).all<PhaseRow>(),
      db.prepare(ADMIN_RECONSTRUCTION_NEWEST_SQL)
        .bind(MAX_ACCOUNTS).first<{ newest: string | null; examined: number }>(),
      db.prepare(`SELECT maintenance_run_at, maintenance_lease_expires_at
        FROM retention_state WHERE singleton=1`)
        .first<{ maintenance_run_at: string | null; maintenance_lease_expires_at: string | null }>(),
      db.prepare(`SELECT publication_state, expected_basis, attribution_method_version,
        safe_from_day, safe_to_day FROM community_allowance_publication_state WHERE singleton=1`)
        .first<CommunityAllowancePublicationStateRow>(),
      db.prepare(`SELECT COUNT(*) AS total FROM (
        SELECT day FROM community_daily_aggregate_rebuilds ORDER BY day LIMIT ?)`)
        .bind(MAX_PENDING_DAYS).first<{ total: number }>(),
      db.prepare(ADMIN_RECONSTRUCTION_DAYS_SQL).bind(fromDay, toDay).all<DailyRow>(),
    ]);
    if (!lookup || !newest || !maintenance || !pending
        || ![0, 1].includes(lookup.is_complete) || phases.results.length > 6 || days.results.length > 366) {
      throw new TypeError("reconstruction metadata unavailable");
    }
    const totals = { complete: 0, plan: 0, fitability: 0, endpoints: 0, source_changed: 0 };
    let checkpointsWritten = 0, examinedAccounts: number | null = null;
    for (const row of phases.results) {
      if (row.phase === "__page__") { examinedAccounts = count(row.total); continue; }
      if (!Object.hasOwn(totals, row.phase)) throw new TypeError("invalid reconstruction phase");
      totals[row.phase as keyof typeof totals] = count(row.total);
      checkpointsWritten = count(checkpointsWritten + count(row.progress));
    }
    const trackedAccounts = count(Object.values(totals).reduce((sum, value) => sum + value, 0));
    const examinedCaches = count(newest.examined);
    if (examinedAccounts === null || examinedAccounts > MAX_ACCOUNTS
        || trackedAccounts > examinedAccounts || examinedCaches > MAX_ACCOUNTS) {
      throw new TypeError("reconstruction census exceeded");
    }
    let pricedDays = 0, publishedDays = 0, latestPublishedAt: string | null = null;
    for (const row of days.results) {
      if (row.revision_probe_capped !== 0) throw new TypeError("reconstruction revision probe exhausted");
      const releasedAt = timestamp(row.released_at);
      if (releasedAt === null) continue;
      publishedDays++;
      if (releasedAt !== null && (latestPublishedAt === null || releasedAt > latestPublishedAt)) latestPublishedAt = releasedAt;
      if (row.spend_json === null) continue;
      const spend: unknown = JSON.parse(row.spend_json);
      if (isCurrentCommunityDailySpend(spend) && spend.usageEvents === row.usage_events
          && spend.knownCostUsd !== null) pricedDays++;
    }
    const lastRecordId = count(lookup.last_record_id), throughRecordId = count(lookup.through_record_id);
    if (lastRecordId > throughRecordId || (lookup.is_complete === 1 && lastRecordId !== throughRecordId)) {
      throw new TypeError("invalid reconstruction lookup");
    }
    const leaseExpiresAt = timestamp(maintenance.maintenance_lease_expires_at);
    const pendingDays = count(pending.total);
    if (pendingDays > MAX_PENDING_DAYS) throw new TypeError("reconstruction queue exceeded");
    return { ...base, status: "available" as const,
      lookup: { complete: lookup.is_complete === 1, lastRecordId, throughRecordId },
      calculations: { trackedAccounts, completedAccounts: totals.complete,
        preparingAccounts: totals.plan, scanningAccounts: totals.fitability,
        finalizingAccounts: totals.endpoints, sourceChangedAccounts: totals.source_changed,
        checkpointsWritten, bounded: examinedAccounts === MAX_ACCOUNTS || examinedCaches === MAX_ACCOUNTS,
        newestResultAt: timestamp(newest.newest) },
      maintenance: { running: leaseExpiresAt !== null && Date.parse(leaseExpiresAt) > nowMs,
        lastRunAt: timestamp(maintenance.maintenance_run_at), leaseExpiresAt },
      publication: { state: publication === null ? "unknown" as const
        : isCurrentCommunityAllowancePublication(publication, nowMs) ? "ready" as const : "updating" as const,
        pendingDays, pendingDaysBounded: pendingDays === MAX_PENDING_DAYS,
        publishedDays, pricedDays, latestPublishedAt },
    };
  } catch {
    return { ...base, status: "unavailable" as const };
  }
}
