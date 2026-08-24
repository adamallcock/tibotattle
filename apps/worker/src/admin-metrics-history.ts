/**
 * Owner-dashboard metrics history: day-bucketed event series computed
 * retroactively from the tables that retain their rows, plus hourly gauge
 * snapshots for the numbers that exist only as current state.
 *
 * Two deliberate boundaries:
 *
 * - Sign-in handoffs are NOT an event series here. Expired handoff rows are
 *   purged minutes after expiry by scheduled maintenance, so any series read
 *   from those tables would silently undercount forever. Web sessions are the
 *   retained record that a sign-in completed; delivery-failure tracking needs
 *   a purge-surviving counter and is queued separately.
 *
 * - Aggregate identity boundary: everything this module reads or stores is a
 *   count, a sum, or a day bucket. No participant identifiers, no per-account
 *   rows, and the snapshot JSON is shape-checked small.
 */

export const ADMIN_METRICS_HISTORY_SCHEMA_VERSION = "admin-metrics-history-v0.1";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
// Snapshots are captured by the per-minute maintenance cron but self-throttle
// to roughly hourly; 55 minutes tolerates cron jitter without doubling rows.
const SNAPSHOT_MIN_INTERVAL_MILLISECONDS = 55 * 60 * 1_000;
// Full-history payload discipline: every snapshot inside this horizon is
// served at capture granularity; older history is downsampled to the last
// snapshot of each day. The span is never truncated — day one is always in
// the payload — only the intra-day points age out.
const SNAPSHOT_FULL_RESOLUTION_DAYS = 14;
// The gauge JSON is a small flat object; anything larger than this is a bug
// in the capture path, and refusing the write beats growing rows unbounded.
const SNAPSHOT_JSON_LIMIT_BYTES = 4_000;

interface DayCountRow {
  day: string;
  n: number;
}

export interface AdminEventSeries {
  total: number;
  last24Hours: number;
  previous24Hours: number;
  byDay: { day: string; count: number }[];
}

export interface AdminMetricsHistory {
  schemaVersion: typeof ADMIN_METRICS_HISTORY_SCHEMA_VERSION;
  generatedAt: string;
  events: {
    participants: AdminEventSeries;
    webSessions: AdminEventSeries;
    devicePairings: AdminEventSeries;
    deviceCredentials: AdminEventSeries;
    deviceConsents: AdminEventSeries;
    uploadedChunks: AdminEventSeries;
    uploadedRecords: AdminEventSeries;
    uploadingParticipants: AdminEventSeries;
  };
  downloads: {
    available: boolean;
    byDay: { day: string; cumulativeDmgDownloads: number }[];
  };
  gauges: {
    snapshots: { capturedAt: string; metrics: Record<string, number> }[];
  };
}

function iso(epoch: number): string {
  return new Date(epoch).toISOString();
}

async function eventSeries(
  db: D1Database,
  options: {
    table: string;
    timestampColumn: string;
    nowEpoch: number;
    // COUNT(*) unless given: an aggregate over rows in the bucket.
    bucketExpression?: string;
  },
): Promise<AdminEventSeries> {
  const { table, timestampColumn, nowEpoch } = options;
  const expression = options.bucketExpression ?? "COUNT(*)";
  const since24h = iso(nowEpoch - DAY_MILLISECONDS);
  const since48h = iso(nowEpoch - 2 * DAY_MILLISECONDS);
  const [byDay, windows] = await Promise.all([
    db.prepare(
      `SELECT substr(${timestampColumn}, 1, 10) AS day, ${expression} AS n
         FROM ${table}
        WHERE ${timestampColumn} IS NOT NULL
        GROUP BY substr(${timestampColumn}, 1, 10)
        ORDER BY day`,
    ).all<DayCountRow>(),
    db.prepare(
      `SELECT
         (SELECT ${expression} FROM ${table}
           WHERE ${timestampColumn} IS NOT NULL) AS total,
         (SELECT ${expression} FROM ${table}
           WHERE ${timestampColumn} >= ?1) AS last24,
         (SELECT ${expression} FROM ${table}
           WHERE ${timestampColumn} >= ?2 AND ${timestampColumn} < ?1) AS prev24`,
    ).bind(since24h, since48h)
      .first<{ total: number; last24: number; prev24: number }>(),
  ]);
  return {
    total: Number(windows?.total ?? 0),
    last24Hours: Number(windows?.last24 ?? 0),
    previous24Hours: Number(windows?.prev24 ?? 0),
    byDay: byDay.results.map((row) => ({
      day: row.day,
      count: Number(row.n ?? 0),
    })),
  };
}

async function downloadSeries(
  db: D1Database,
): Promise<AdminMetricsHistory["downloads"]> {
  try {
    const rows = await db.prepare(
      `SELECT latest.day AS day, SUM(assets.asset_download_count) AS n
         FROM (
           SELECT substr(observed_at, 1, 10) AS day,
                  MAX(observed_at) AS last_observed_at
             FROM github_distribution_snapshots
            GROUP BY substr(observed_at, 1, 10)
         ) AS latest
         JOIN github_release_asset_snapshots AS assets
           ON assets.observed_at = latest.last_observed_at
          AND assets.is_dmg = 1
        GROUP BY latest.day
        ORDER BY latest.day`,
    ).all<DayCountRow>();
    return {
      available: true,
      byDay: rows.results.map((row) => ({
        day: row.day,
        cumulativeDmgDownloads: Number(row.n ?? 0),
      })),
    };
  } catch {
    // Distribution snapshots are production-only; other environments read an
    // absent table as an absent series, never a failure.
    return { available: false, byDay: [] };
  }
}

export async function readAdminMetricsHistory(
  db: D1Database,
  nowEpoch: number,
): Promise<AdminMetricsHistory> {
  const [
    participants,
    webSessions,
    devicePairings,
    deviceCredentials,
    deviceConsents,
    uploadedChunks,
    uploadedRecords,
    uploadingParticipants,
    downloads,
    snapshots,
  ] = await Promise.all([
    eventSeries(db, { table: "participants", timestampColumn: "created_at", nowEpoch }),
    eventSeries(db, { table: "web_sessions", timestampColumn: "issued_at", nowEpoch }),
    eventSeries(db, { table: "device_pairings", timestampColumn: "issued_at", nowEpoch }),
    eventSeries(db, { table: "device_credentials", timestampColumn: "issued_at", nowEpoch }),
    eventSeries(db, {
      table: "telemetry_v1_device_consents",
      timestampColumn: "consented_at",
      nowEpoch,
    }),
    eventSeries(db, { table: "telemetry_v1_chunks", timestampColumn: "created_at", nowEpoch }),
    eventSeries(db, {
      table: "telemetry_v1_chunks",
      timestampColumn: "created_at",
      nowEpoch,
      bucketExpression: "COALESCE(SUM(record_count), 0)",
    }),
    eventSeries(db, {
      table: "telemetry_v1_chunks",
      timestampColumn: "created_at",
      nowEpoch,
      bucketExpression: "COUNT(DISTINCT participant_id)",
    }),
    downloadSeries(db),
    readGaugeSnapshots(db, nowEpoch),
  ]);
  return {
    schemaVersion: ADMIN_METRICS_HISTORY_SCHEMA_VERSION,
    generatedAt: iso(nowEpoch),
    events: {
      participants,
      webSessions,
      devicePairings,
      deviceCredentials,
      deviceConsents,
      uploadedChunks,
      uploadedRecords,
      uploadingParticipants,
    },
    downloads,
    gauges: { snapshots },
  };
}

async function readGaugeSnapshots(
  db: D1Database,
  nowEpoch: number,
): Promise<AdminMetricsHistory["gauges"]["snapshots"]> {
  const fullResolutionSince = iso(
    nowEpoch - SNAPSHOT_FULL_RESOLUTION_DAYS * DAY_MILLISECONDS,
  );
  try {
    const rows = await db.prepare(
      `SELECT captured_at, metrics_json FROM admin_metric_snapshots
        WHERE captured_at >= ?1
        UNION ALL
        SELECT captured_at, metrics_json FROM admin_metric_snapshots
         WHERE captured_at < ?1
           AND captured_at IN (
             SELECT MAX(captured_at) FROM admin_metric_snapshots
              WHERE captured_at < ?1
              GROUP BY substr(captured_at, 1, 10)
           )
        ORDER BY captured_at`,
    ).bind(fullResolutionSince).all<{ captured_at: string; metrics_json: string }>();
    const snapshots: AdminMetricsHistory["gauges"]["snapshots"] = [];
    for (const row of rows.results) {
      try {
        const metrics = JSON.parse(row.metrics_json) as Record<string, unknown>;
        const clean: Record<string, number> = {};
        for (const [key, value] of Object.entries(metrics)) {
          if (typeof value === "number" && Number.isFinite(value)) {
            clean[key] = value;
          }
        }
        snapshots.push({ capturedAt: row.captured_at, metrics: clean });
      } catch {
        // One corrupt row never hides the rest of the history.
      }
    }
    return snapshots;
  } catch {
    // Migration 0038 not applied yet: history simply starts when it is.
    return [];
  }
}

export interface AdminMetricSnapshotResult {
  code: "SNAPSHOT_CAPTURED" | "SNAPSHOT_CURRENT" | "SNAPSHOT_UNAVAILABLE";
}

/**
 * Hourly gauge capture, called from the per-minute maintenance cron. The
 * numbers here are the ones that cannot be reconstructed later: backlog
 * states, corpus posture, and the published-band cohort. Never throws — a
 * capture that cannot run reports itself and stands aside.
 */
export async function captureAdminMetricSnapshot(
  db: D1Database,
  nowEpoch: number,
): Promise<AdminMetricSnapshotResult> {
  try {
    const latest = await db.prepare(
      "SELECT MAX(captured_at) AS captured_at FROM admin_metric_snapshots",
    ).first<{ captured_at: string | null }>();
    const latestEpoch = Date.parse(latest?.captured_at ?? "");
    if (
      Number.isFinite(latestEpoch)
      && nowEpoch - latestEpoch < SNAPSHOT_MIN_INTERVAL_MILLISECONDS
    ) {
      return { code: "SNAPSHOT_CURRENT" };
    }
    const [quarantine, corpus, participants, band] = await Promise.all([
      db.prepare(
        `SELECT COUNT(*) AS pending FROM (
           SELECT 1 FROM pending_quarantine_objects LIMIT 10000
         )`,
      ).first<{ pending: number }>(),
      db.prepare(
        `SELECT COUNT(*) AS chunks,
                SUM(CASE WHEN superseded_at IS NULL THEN 1 ELSE 0 END) AS current_chunks,
                COALESCE(SUM(CASE WHEN superseded_at IS NULL THEN record_count ELSE 0 END), 0)
                  AS current_records
           FROM telemetry_v1_chunks`,
      ).first<{ chunks: number; current_chunks: number; current_records: number }>(),
      db.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS active
           FROM participants`,
      ).first<{ total: number; active: number }>(),
      readPublishedBandGauges(db, nowEpoch),
    ]);
    const metrics: Record<string, number> = {
      quarantinePendingObjects: Number(quarantine?.pending ?? 0),
      corpusChunks: Number(corpus?.chunks ?? 0),
      corpusCurrentChunks: Number(corpus?.current_chunks ?? 0),
      corpusCurrentRecords: Number(corpus?.current_records ?? 0),
      participantsTotal: Number(participants?.total ?? 0),
      participantsActive: Number(participants?.active ?? 0),
      ...band,
    };
    const metricsJson = JSON.stringify(metrics);
    if (metricsJson.length > SNAPSHOT_JSON_LIMIT_BYTES) {
      return { code: "SNAPSHOT_UNAVAILABLE" };
    }
    await db.prepare(
      `INSERT INTO admin_metric_snapshots (captured_at, metrics_json)
       VALUES (?, ?)
       ON CONFLICT(captured_at) DO NOTHING`,
    ).bind(iso(nowEpoch), metricsJson).run();
    return { code: "SNAPSHOT_CAPTURED" };
  } catch {
    return { code: "SNAPSHOT_UNAVAILABLE" };
  }
}

/**
 * The published community band cohort, read from the latest published daily
 * aggregate: the number the public site renders as "from N people", plus the
 * fit-corpus cohort sizes by plan so a second plan's cohort is visible while
 * it grows toward publishability.
 */
async function readPublishedBandGauges(
  db: D1Database,
  nowEpoch: number,
): Promise<Record<string, number>> {
  const gauges: Record<string, number> = {};
  try {
    const published = await db.prepare(
      `SELECT payload_json FROM community_daily_aggregates
        WHERE release_state = 'published'
        ORDER BY day DESC, revision DESC
        LIMIT 1`,
    ).first<{ payload_json: string }>();
    if (published) {
      const payload = JSON.parse(published.payload_json) as {
        allowance?: { fitCount?: unknown; participantCount?: unknown };
      };
      const fitCount = Number(payload.allowance?.fitCount);
      const participantCount = Number(payload.allowance?.participantCount);
      if (Number.isFinite(fitCount)) gauges.bandFitCount = fitCount;
      if (Number.isFinite(participantCount)) {
        gauges.bandParticipantCount = participantCount;
      }
    }
  } catch {
    // Absent aggregate tables (fresh environment) leave the gauges out.
  }
  try {
    const rows = await db.prepare(
      "SELECT fits_json FROM community_allowance_fit_cache",
    ).all<{ fits_json: string }>();
    Object.assign(
      gauges,
      computeCohortGauges(rows.results.map((row) => row.fits_json), nowEpoch),
    );
  } catch {
    // Absent fit cache (migration 0035 missing) leaves cohort gauges out.
  }
  return gauges;
}

// Plan identifiers come from the Codex KnownPlan enum (lowercase, underscored,
// e.g. "self_serve_business_prolite"); the guard keeps a hostile cache value
// from smuggling an odd JSON key into the gauge object.
const COHORT_PLAN_KEY = /^[a-z0-9_]{1,40}$/;

/**
 * Per-plan cohort view from the per-participant fit-cache rows, for two owner
 * questions the published pro-only band cannot answer: how many DISTINCT people
 * are on each plan, and what each plan's reset window measures.
 *
 * A single account legitimately carries fits under several plan labels — plan
 * changes over time leave every era in the retained history, and records that
 * never received a plan stamp surface as "unknown" alongside the account's real
 * plan. So a participant is attributed to ONE cohort: the plan of their most
 * recent qualifying fit (their current plan). Counting a person under every
 * label they ever showed overcounts people and is exactly the bug this avoids.
 * Per-plan median capacity, by contrast, pools every qualifying fit under its
 * own label, so a plan's measured window is independent of who is "on" it.
 * Only fits inside the published trailing window count, mirroring
 * summarizeCommunityAllowanceDay.
 *
 * Exported for unit tests; the fit-cache FK makes D1 seeding impractical.
 */
export function computeCohortGauges(
  fitsJsonRows: readonly string[],
  nowEpoch: number,
): Record<string, number> {
  const trailingSince = iso(nowEpoch - 30 * DAY_MILLISECONDS);
  const planParticipants = new Map<string, number>();
  const planCapacitiesUsd = new Map<string, number[]>();
  for (const fitsJson of fitsJsonRows) {
    try {
      const fits = JSON.parse(fitsJson) as {
        planType?: unknown;
        lastObservedAt?: unknown;
        capacityNanousd?: unknown;
      }[];
      let currentPlan: string | null = null;
      let currentObservedAt = "";
      for (const fit of Array.isArray(fits) ? fits : []) {
        if (typeof fit.planType !== "string" || fit.planType.length === 0) {
          continue;
        }
        if (
          typeof fit.lastObservedAt !== "string"
          || fit.lastObservedAt < trailingSince
        ) {
          continue;
        }
        if (
          typeof fit.capacityNanousd === "number"
          && Number.isFinite(fit.capacityNanousd)
          && fit.capacityNanousd > 0
        ) {
          const list = planCapacitiesUsd.get(fit.planType) ?? [];
          list.push(fit.capacityNanousd / 1e9);
          planCapacitiesUsd.set(fit.planType, list);
        }
        if (fit.lastObservedAt > currentObservedAt) {
          currentObservedAt = fit.lastObservedAt;
          currentPlan = fit.planType;
        }
      }
      if (currentPlan !== null) {
        planParticipants.set(
          currentPlan,
          (planParticipants.get(currentPlan) ?? 0) + 1,
        );
      }
    } catch {
      // A corrupt cache row is the fit collector's problem, not history's.
    }
  }
  const gauges: Record<string, number> = {};
  for (const [plan, count] of planParticipants) {
    if (COHORT_PLAN_KEY.test(plan)) gauges[`cohortParticipants_${plan}`] = count;
  }
  for (const [plan, capacities] of planCapacitiesUsd) {
    if (!COHORT_PLAN_KEY.test(plan) || capacities.length === 0) continue;
    const sorted = capacities.sort((a, b) => a - b);
    const median = sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
    gauges[`cohortMedianUsd_${plan}`] = Math.round(median);
  }
  return gauges;
}
