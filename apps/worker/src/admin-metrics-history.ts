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

import {
  COMMUNITY_ALLOWANCE_BASIS,
  readCachedCommunityAllowanceCorpus,
  type CommunityAllowanceFit,
} from "./community-allowance";
import { isCurrentCommunityAllowancePublication,
  type CommunityAllowancePublicationStateRow } from "./community-daily-aggregates";
import { QUARANTINE_RECONCILIATION_GRACE_MILLISECONDS } from "./constants";
import { ApiError } from "./errors";
import { readPublishedStorageCommunityAdminPreview } from "./storage-community-graph-publication";
import type { StorageAnalyticsBindings } from "./analytics-delivery";
import {
  TELEMETRY_V12_ADMIN_SCHEMA_SQL,
  telemetryV12AdminSchemaPresent,
  type TelemetryV12AdminSchemaRow,
} from "./telemetry-v12-table";

export const ADMIN_METRICS_HISTORY_SCHEMA_VERSION = "admin-metrics-history-v0.3";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const RECENT_EVENT_CALENDAR_DAYS = 30;
// Snapshots are captured by the per-minute maintenance cron but self-throttle
// to roughly hourly; 55 minutes tolerates cron jitter without doubling rows.
const SNAPSHOT_MIN_INTERVAL_MILLISECONDS = 55 * 60 * 1_000;
// Cache refresh uses the same jitter-tolerant cadence as gauge capture.
// A missed refresh must not erase a valid publication: its own generatedAt
// and date window remain the evidence boundary, rather than elapsed wall time.
const HISTORY_CACHE_MIN_INTERVAL_MILLISECONDS = 55 * 60 * 1_000;
const HISTORY_CACHE_MAX_FUTURE_SKEW_MILLISECONDS = 5 * 60 * 1_000;
// 30 day-buckets across nine event series plus at most ~hourly gauge points is
// comfortably below this. The cap is deliberately far below D1's value limit
// and is enforced both by migration 0039 and before each cache write/read.
const HISTORY_CACHE_JSON_LIMIT_BYTES = 512 * 1_024;
// Full-resolution payload discipline: every snapshot inside this horizon is
// served at capture granularity; the preceding part of the bounded 30-day
// window is downsampled to the last snapshot of each day.
const SNAPSHOT_FULL_RESOLUTION_DAYS = 14;
const SNAPSHOT_HISTORY_DAYS = 30;
// 55-minute capture can produce at most 367 points in 14 days; add 16 daily
// points for the older window and a small boundary margin.
const SNAPSHOT_RESULT_LIMIT = 400;
// The gauge JSON is a small flat object; anything larger than this is a bug
// in the capture path, and refusing the write beats growing rows unbounded.
const SNAPSHOT_JSON_LIMIT_BYTES = 4_000;
// Typed-storage maintenance runs alongside journal catch-up. It may inspect
// retained operational headers, never an unbounded raw-record corpus. Refuse a
// publication when an exact source series exceeds this explicit scan bound.
const STORAGE_ADMIN_SOURCE_ROW_LIMIT = 10_000;

interface DayCountRow {
  day: string;
  n: number;
}

interface V1UploadDayRow {
  day: string;
  chunks: number;
  records: number;
  participants: number;
}

interface V1UploadWindowRow {
  chunks_total: number;
  chunks_last24: number;
  chunks_prev24: number;
  records_total: number;
  records_last24: number;
  records_prev24: number;
  participants_total: number;
  participants_last24: number;
  participants_prev24: number;
}

export interface AdminEventSeries {
  total: number;
  last24Hours: number;
  previous24Hours: number;
  byDayStartsAt: string;
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
    acceptedUploads: AdminEventSeries;
    uploadedRecords: AdminEventSeries;
    uploadingParticipants: AdminEventSeries;
  };
  downloads: {
    available: boolean;
    byDayStartsAt: string;
    byDay: { day: string; cumulativeDmgDownloads: number }[];
  };
  gauges: {
    snapshots: { capturedAt: string; metrics: Record<string, number> }[];
  };
}

function iso(epoch: number): string {
  return new Date(epoch).toISOString();
}

function recentCalendarDayStart(nowEpoch: number): string {
  const now = new Date(nowEpoch);
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - (RECENT_EVENT_CALENDAR_DAYS - 1),
  )).toISOString();
}

async function eventSeries(
  db: D1Database,
  options: {
    table: string;
    timestampColumn: string;
    nowEpoch: number;
    // COUNT(*) unless given: an aggregate over rows in the bucket.
    bucketExpression?: string;
    maximumRows?: number;
  },
): Promise<AdminEventSeries> {
  const { table, timestampColumn, nowEpoch, maximumRows } = options;
  const expression = options.bucketExpression ?? "COUNT(*)";
  if (maximumRows !== undefined && expression !== "COUNT(*)") {
    throw new Error("bounded event expression unavailable");
  }
  const relation = maximumRows === undefined ? table : "source_rows";
  const sourceCte = maximumRows === undefined ? "" : `WITH source_rows AS (
    SELECT ${timestampColumn} FROM ${table}
     WHERE ${timestampColumn} IS NOT NULL
     ORDER BY ${timestampColumn} DESC LIMIT ${maximumRows + 1}
  ) `;
  const since24h = iso(nowEpoch - DAY_MILLISECONDS);
  const since48h = iso(nowEpoch - 2 * DAY_MILLISECONDS);
  const recentDayStart = recentCalendarDayStart(nowEpoch);
  const [byDay, windows] = await Promise.all([
    db.prepare(
      `${sourceCte}SELECT substr(${timestampColumn}, 1, 10) AS day, ${expression} AS n
         FROM ${relation}
        WHERE ${timestampColumn} IS NOT NULL
          AND ${timestampColumn} >= ?1
        GROUP BY substr(${timestampColumn}, 1, 10)
        ORDER BY day`,
    ).bind(recentDayStart).all<DayCountRow>(),
    db.prepare(
      `${sourceCte}SELECT
         (SELECT ${expression} FROM ${relation}
           WHERE ${timestampColumn} IS NOT NULL) AS total,
         (SELECT ${expression} FROM ${relation}
           WHERE ${timestampColumn} >= ?1) AS last24,
         (SELECT ${expression} FROM ${relation}
           WHERE ${timestampColumn} >= ?2 AND ${timestampColumn} < ?1) AS prev24,
         (SELECT COUNT(*) FROM ${relation}) AS scanned_rows`,
    ).bind(since24h, since48h)
      .first<{ total: number; last24: number; prev24: number; scanned_rows: number }>(),
  ]);
  if (maximumRows !== undefined
      && Number(windows?.scanned_rows ?? maximumRows + 1) > maximumRows) {
    throw new Error("admin metric source bound exceeded");
  }
  return {
    total: Number(windows?.total ?? 0),
    last24Hours: Number(windows?.last24 ?? 0),
    previous24Hours: Number(windows?.prev24 ?? 0),
    byDayStartsAt: recentDayStart.slice(0, 10),
    byDay: byDay.results.map((row) => ({
      day: row.day,
      count: Number(row.n ?? 0),
    })),
  };
}

async function downloadSeries(
  db: D1Database,
  nowEpoch: number,
): Promise<AdminMetricsHistory["downloads"]> {
  try {
    const recentDayStart = recentCalendarDayStart(nowEpoch);
    const rows = await db.prepare(
      `SELECT latest.day AS day, SUM(assets.asset_download_count) AS n
         FROM (
           SELECT substr(observed_at, 1, 10) AS day,
                  MAX(observed_at) AS last_observed_at
             FROM github_distribution_snapshots
            WHERE observed_at >= ?1
            GROUP BY substr(observed_at, 1, 10)
         ) AS latest
         JOIN github_release_asset_snapshots AS assets
           ON assets.observed_at = latest.last_observed_at
          AND assets.is_dmg = 1
        GROUP BY latest.day
        ORDER BY latest.day`,
    ).bind(recentDayStart).all<DayCountRow>();
    return {
      available: true,
      byDayStartsAt: recentDayStart.slice(0, 10),
      byDay: rows.results.map((row) => ({
        day: row.day,
        cumulativeDmgDownloads: Number(row.n ?? 0),
      })),
    };
  } catch {
    // Distribution snapshots are production-only; other environments read an
    // absent table as an absent series, never a failure.
    return {
      available: false,
      byDayStartsAt: recentCalendarDayStart(nowEpoch).slice(0, 10),
      byDay: [],
    };
  }
}

function seriesFromV1Rows(
  byDay: readonly V1UploadDayRow[],
  windows: V1UploadWindowRow | null,
  key: "chunks" | "records" | "participants",
  byDayStartsAt: string,
): AdminEventSeries {
  return {
    total: Number(windows?.[`${key}_total`] ?? 0),
    last24Hours: Number(windows?.[`${key}_last24`] ?? 0),
    previous24Hours: Number(windows?.[`${key}_prev24`] ?? 0),
    byDayStartsAt,
    byDay: byDay.map((row) => ({
      day: row.day,
      count: Number(row[key] ?? 0),
    })),
  };
}

/**
 * All three v1 upload series share one journal and timestamp, so scan it once
 * for day buckets and once for rolling windows instead of issuing six SELECTs.
 */
async function v1UploadEventSeries(
  db: D1Database,
  nowEpoch: number,
  maximumRows?: number,
  includeV11 = false,
  includeV12 = false,
): Promise<{
  uploadedChunks: AdminEventSeries;
  uploadedRecords: AdminEventSeries;
  uploadingParticipants: AdminEventSeries;
}> {
  const since24h = iso(nowEpoch - DAY_MILLISECONDS);
  const since48h = iso(nowEpoch - 2 * DAY_MILLISECONDS);
  const recentDayStart = recentCalendarDayStart(nowEpoch);
  const relation = maximumRows === undefined && !includeV11
    ? "telemetry_v1_chunks" : "source_rows";
  const sourceCte = includeV11 ? `WITH source_rows AS (
    SELECT created_at,accepted_record_count AS record_count,participant_id
      FROM telemetry_v1_chunks WHERE created_at IS NOT NULL
    UNION ALL
    SELECT created_at,record_count,participant_id
      FROM telemetry_v11_chunks WHERE created_at IS NOT NULL
    ${includeV12 ? `UNION ALL
    SELECT created_at,record_count,participant_id
      FROM telemetry_v12_chunks WHERE created_at IS NOT NULL` : ""}
  ) ` : maximumRows === undefined ? "" : `WITH source_rows AS (
    SELECT created_at,record_count,participant_id FROM telemetry_v1_chunks
     WHERE created_at IS NOT NULL
     ORDER BY created_at DESC LIMIT ${maximumRows + 1}
  ) `;
  const [byDay, windows] = await Promise.all([
    db.prepare(
      `${sourceCte}SELECT substr(created_at, 1, 10) AS day,
              COUNT(*) AS chunks,
              COALESCE(SUM(record_count), 0) AS records,
              COUNT(DISTINCT participant_id) AS participants
         FROM ${relation}
        WHERE created_at IS NOT NULL
          AND created_at >= ?1
        GROUP BY substr(created_at, 1, 10)
        ORDER BY day`,
    ).bind(recentDayStart).all<V1UploadDayRow>(),
    db.prepare(
      `${sourceCte}SELECT
         COUNT(*) AS chunks_total,
         COALESCE(SUM(CASE WHEN created_at >= ?1 THEN 1 ELSE 0 END), 0)
           AS chunks_last24,
         COALESCE(SUM(CASE WHEN created_at >= ?2 AND created_at < ?1
           THEN 1 ELSE 0 END), 0) AS chunks_prev24,
         COALESCE(SUM(record_count), 0) AS records_total,
         COALESCE(SUM(CASE WHEN created_at >= ?1 THEN record_count ELSE 0 END), 0)
           AS records_last24,
         COALESCE(SUM(CASE WHEN created_at >= ?2 AND created_at < ?1
           THEN record_count ELSE 0 END), 0) AS records_prev24,
         COUNT(DISTINCT participant_id) AS participants_total,
         COUNT(DISTINCT CASE WHEN created_at >= ?1 THEN participant_id END)
           AS participants_last24,
         COUNT(DISTINCT CASE WHEN created_at >= ?2 AND created_at < ?1
           THEN participant_id END) AS participants_prev24,
         COUNT(*) AS scanned_rows
         FROM ${relation}
        WHERE created_at IS NOT NULL`,
    ).bind(since24h, since48h)
      .first<V1UploadWindowRow & { scanned_rows: number }>(),
  ]);
  if (maximumRows !== undefined
      && Number(windows?.scanned_rows ?? maximumRows + 1) > maximumRows) {
    throw new Error("admin metric source bound exceeded");
  }
  return {
    uploadedChunks: seriesFromV1Rows(
      byDay.results,
      windows,
      "chunks",
      recentDayStart.slice(0, 10),
    ),
    uploadedRecords: seriesFromV1Rows(
      byDay.results,
      windows,
      "records",
      recentDayStart.slice(0, 10),
    ),
    uploadingParticipants: seriesFromV1Rows(
      byDay.results,
      windows,
      "participants",
      recentDayStart.slice(0, 10),
    ),
  };
}

async function acceptedTelemetryUploadEventSeries(
  db: D1Database,
  nowEpoch: number,
  maximumRows?: number,
): Promise<AdminEventSeries> {
  const since24h = iso(nowEpoch - DAY_MILLISECONDS);
  const since48h = iso(nowEpoch - 2 * DAY_MILLISECONDS);
  const recentDayStart = recentCalendarDayStart(nowEpoch);
  const relation = maximumRows === undefined ? "telemetry_contributions" : "source_rows";
  const sourceCte = maximumRows === undefined ? "" : `WITH source_rows AS (
    SELECT created_at,status FROM telemetry_contributions
     WHERE status='accepted' AND created_at IS NOT NULL
     ORDER BY created_at DESC LIMIT ${maximumRows + 1}
  ) `;
  const [byDay, windows] = await Promise.all([
    db.prepare(
      `${sourceCte}SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n
         FROM ${relation}
        WHERE status = 'accepted' AND created_at IS NOT NULL
          AND created_at >= ?1
        GROUP BY substr(created_at, 1, 10)
        ORDER BY day`,
    ).bind(recentDayStart).all<DayCountRow>(),
    db.prepare(
      `${sourceCte}SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN created_at >= ?1 THEN 1 ELSE 0 END), 0)
                AS last24,
              COALESCE(SUM(CASE WHEN created_at >= ?2 AND created_at < ?1
                THEN 1 ELSE 0 END), 0) AS prev24,
              COUNT(*) AS scanned_rows
         FROM ${relation}
        WHERE status = 'accepted' AND created_at IS NOT NULL`,
    ).bind(since24h, since48h)
      .first<{ total: number; last24: number; prev24: number; scanned_rows: number }>(),
  ]);
  if (maximumRows !== undefined
      && Number(windows?.scanned_rows ?? maximumRows + 1) > maximumRows) {
    throw new Error("admin metric source bound exceeded");
  }
  return {
    total: Number(windows?.total ?? 0),
    last24Hours: Number(windows?.last24 ?? 0),
    previous24Hours: Number(windows?.prev24 ?? 0),
    byDayStartsAt: recentDayStart.slice(0, 10),
    byDay: byDay.results.map((row) => ({
      day: row.day,
      count: Number(row.n ?? 0),
    })),
  };
}

function addEventSeries(
  left: AdminEventSeries,
  right: AdminEventSeries,
): AdminEventSeries {
  if (left.byDayStartsAt !== right.byDayStartsAt) {
    throw new Error("event history windows do not match");
  }
  const counts = new Map<string, number>();
  for (const row of [...left.byDay, ...right.byDay]) {
    counts.set(row.day, (counts.get(row.day) ?? 0) + row.count);
  }
  return {
    total: left.total + right.total,
    last24Hours: left.last24Hours + right.last24Hours,
    previous24Hours: left.previous24Hours + right.previous24Hours,
    byDayStartsAt: left.byDayStartsAt,
    byDay: [...counts.entries()]
      .sort(([leftDay], [rightDay]) => leftDay.localeCompare(rightDay))
      .map(([day, count]) => ({ day, count })),
  };
}

/** Scheduled SELECT-only builder. Interactive requests must use the cache. */
export async function readAdminMetricsHistory(
  db: D1Database,
  nowEpoch: number,
): Promise<AdminMetricsHistory> {
  return buildAdminMetricsHistory(
    db,
    readGaugeSnapshots(db, nowEpoch),
    nowEpoch,
  );
}

async function buildAdminMetricsHistory(
  source: D1Database,
  snapshotsPromise: Promise<AdminMetricsHistory["gauges"]["snapshots"]>,
  nowEpoch: number,
  maximumRows?: number,
  includeV11 = false,
  includeV12 = false,
): Promise<AdminMetricsHistory> {
  const [
    participants,
    webSessions,
    devicePairings,
    deviceCredentials,
    deviceConsents,
    v1Uploads,
    acceptedTelemetryUploads,
    downloads,
    snapshots,
  ] = await Promise.all([
    eventSeries(source, { table: "participants", timestampColumn: "created_at", nowEpoch, maximumRows }),
    eventSeries(source, { table: "web_sessions", timestampColumn: "issued_at", nowEpoch, maximumRows }),
    eventSeries(source, { table: "device_pairings", timestampColumn: "issued_at", nowEpoch, maximumRows }),
    eventSeries(source, { table: "device_credentials", timestampColumn: "issued_at", nowEpoch, maximumRows }),
    eventSeries(source, {
      table: "telemetry_v1_device_consents",
      timestampColumn: "consented_at",
      nowEpoch,
      maximumRows,
    }),
    v1UploadEventSeries(
      source,
      nowEpoch,
      includeV11 ? undefined : maximumRows,
      includeV11,
      includeV12,
    ),
    acceptedTelemetryUploadEventSeries(source, nowEpoch, maximumRows),
    downloadSeries(source, nowEpoch),
    snapshotsPromise,
  ]);
  const acceptedUploads = addEventSeries(
    v1Uploads.uploadedChunks,
    acceptedTelemetryUploads,
  );
  return {
    schemaVersion: ADMIN_METRICS_HISTORY_SCHEMA_VERSION,
    generatedAt: iso(nowEpoch),
    events: {
      participants,
      webSessions,
      devicePairings,
      deviceCredentials,
      deviceConsents,
      uploadedChunks: v1Uploads.uploadedChunks,
      acceptedUploads,
      uploadedRecords: v1Uploads.uploadedRecords,
      uploadingParticipants: v1Uploads.uploadingParticipants,
    },
    downloads,
    gauges: { snapshots },
  };
}

/** Scheduled typed-storage builder. Operational tables retain their explicit
 * row bound. Compact v1/v1.1/v1.2 upload headers are aggregated exactly so a large
 * recovered corpus does not make the cache permanently unavailable. */
async function readStorageAdminMetricsHistory(
  bindings: StorageAnalyticsBindings,
  nowEpoch: number,
  includeV12: boolean,
): Promise<AdminMetricsHistory> {
  return buildAdminMetricsHistory(
    bindings.source,
    readStorageGaugeSnapshots(bindings.target, bindings.sourceId, nowEpoch),
    nowEpoch,
    STORAGE_ADMIN_SOURCE_ROW_LIMIT,
    true,
    includeV12,
  );
}

const ADMIN_EVENT_SERIES_NAMES = Object.freeze([
  "participants",
  "webSessions",
  "devicePairings",
  "deviceCredentials",
  "deviceConsents",
  "uploadedChunks",
  "acceptedUploads",
  "uploadedRecords",
  "uploadingParticipants",
] as const);
const FIXED_GAUGE_KEYS = new Set([
  "participantsTotal",
  "participantsActive",
  "corpusChunks",
  "corpusCurrentChunks",
  "corpusCurrentRecords",
  "contributingAccountsTotal",
  "contributingAccountsTotalBounded",
  "quarantinePendingObjects",
  "quarantinePendingObjectsBounded",
  "quarantineWithinGrace",
  "quarantineDueReferenced",
  "quarantineDueUnreferenced",
  "bandFitCount",
  "bandParticipantCount",
]);
const BOUNDED_GAUGE_KEYS = new Set([
  "contributingAccountsTotalBounded",
  "quarantinePendingObjectsBounded",
]);
const COHORT_GAUGE_KEY =
  /^(?:cohortParticipants|cohortMedianUsd)_[a-z0-9_]{1,40}$/u;
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/u;
const CACHE_MAX_GAUGES_PER_SNAPSHOT = 128;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length
    && keys.every((key, index) => key === sortedExpected[index]);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function isCalendarDay(value: unknown): value is string {
  if (typeof value !== "string" || !CALENDAR_DAY.test(value)) return false;
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(epoch)
    && new Date(epoch).toISOString().slice(0, 10) === value;
}

function validEventSeries(
  value: unknown,
  generatedDay: string,
  expectedStartsAt: string,
): value is AdminEventSeries {
  const series = record(value);
  if (series === null || !exactKeys(series, [
    "total",
    "last24Hours",
    "previous24Hours",
    "byDayStartsAt",
    "byDay",
  ])) return false;
  if (!isCount(series.total)
      || !isCount(series.last24Hours)
      || !isCount(series.previous24Hours)
      || series.last24Hours > series.total
      || series.previous24Hours > series.total
      || series.byDayStartsAt !== expectedStartsAt
      || !Array.isArray(series.byDay)
      || series.byDay.length > RECENT_EVENT_CALENDAR_DAYS) {
    return false;
  }
  let previousDay = "";
  for (const candidate of series.byDay) {
    const row = record(candidate);
    if (row === null || !exactKeys(row, ["day", "count"])
        || !isCalendarDay(row.day)
        || !isCount(row.count)
        || row.day < expectedStartsAt
        || row.day > generatedDay
        || row.day <= previousDay) {
      return false;
    }
    previousDay = row.day;
  }
  return true;
}

function validDownloads(
  value: unknown,
  generatedDay: string,
  expectedStartsAt: string,
): value is AdminMetricsHistory["downloads"] {
  const downloads = record(value);
  if (downloads === null || !exactKeys(downloads, [
    "available",
    "byDayStartsAt",
    "byDay",
  ])
      || typeof downloads.available !== "boolean"
      || downloads.byDayStartsAt !== expectedStartsAt
      || !Array.isArray(downloads.byDay)
      || downloads.byDay.length > RECENT_EVENT_CALENDAR_DAYS
      || (!downloads.available && downloads.byDay.length !== 0)) {
    return false;
  }
  let previousDay = "";
  for (const candidate of downloads.byDay) {
    const row = record(candidate);
    if (row === null
        || !exactKeys(row, ["day", "cumulativeDmgDownloads"])
        || !isCalendarDay(row.day)
        || !isCount(row.cumulativeDmgDownloads)
        || row.day < expectedStartsAt
        || row.day > generatedDay
        || row.day <= previousDay) {
      return false;
    }
    previousDay = row.day;
  }
  return true;
}

function validGaugeSnapshots(
  value: unknown,
  generatedEpoch: number,
): value is AdminMetricsHistory["gauges"] {
  const gauges = record(value);
  if (gauges === null || !exactKeys(gauges, ["snapshots"])
      || !Array.isArray(gauges.snapshots)
      || gauges.snapshots.length > SNAPSHOT_RESULT_LIMIT) {
    return false;
  }
  const earliestEpoch = generatedEpoch
    - SNAPSHOT_HISTORY_DAYS * DAY_MILLISECONDS;
  let previousEpoch = -Infinity;
  for (const candidate of gauges.snapshots) {
    const snapshot = record(candidate);
    if (snapshot === null
        || !exactKeys(snapshot, ["capturedAt", "metrics"])
        || !isIsoTimestamp(snapshot.capturedAt)) {
      return false;
    }
    const capturedEpoch = Date.parse(snapshot.capturedAt);
    if (capturedEpoch < earliestEpoch
        || capturedEpoch > generatedEpoch
        || capturedEpoch <= previousEpoch) {
      return false;
    }
    const metrics = record(snapshot.metrics);
    if (metrics === null
        || Object.keys(metrics).length > CACHE_MAX_GAUGES_PER_SNAPSHOT) {
      return false;
    }
    for (const [key, metric] of Object.entries(metrics)) {
      if ((!FIXED_GAUGE_KEYS.has(key) && !COHORT_GAUGE_KEY.test(key))
          || !isCount(metric)
          || (BOUNDED_GAUGE_KEYS.has(key) && metric > 1)) {
        return false;
      }
    }
    previousEpoch = capturedEpoch;
  }
  return true;
}

function validCachedAdminMetricsHistory(
  value: unknown,
  storedGeneratedAt: string,
  nowEpoch: number,
): value is AdminMetricsHistory {
  const history = record(value);
  if (history === null || !exactKeys(history, [
    "schemaVersion",
    "generatedAt",
    "events",
    "downloads",
    "gauges",
  ])
      || history.schemaVersion !== ADMIN_METRICS_HISTORY_SCHEMA_VERSION
      || history.generatedAt !== storedGeneratedAt
      || !isIsoTimestamp(history.generatedAt)) {
    return false;
  }
  const generatedEpoch = Date.parse(history.generatedAt);
  if (generatedEpoch > nowEpoch + HISTORY_CACHE_MAX_FUTURE_SKEW_MILLISECONDS) {
    return false;
  }
  const generatedDay = history.generatedAt.slice(0, 10);
  const expectedStartsAt = recentCalendarDayStart(generatedEpoch).slice(0, 10);
  const events = record(history.events);
  if (events === null
      || !exactKeys(events, ADMIN_EVENT_SERIES_NAMES)
      || ADMIN_EVENT_SERIES_NAMES.some((name) => (
        !validEventSeries(events[name], generatedDay, expectedStartsAt)
      ))) {
    return false;
  }
  return validDownloads(history.downloads, generatedDay, expectedStartsAt)
    && validGaugeSnapshots(history.gauges, generatedEpoch);
}

function cacheUnavailable(): never {
  throw new ApiError(503, "ADMIN_METRICS_HISTORY_CACHE_UNAVAILABLE");
}

function parseCachedHistoryRow(
  row: { generated_at: string; payload_json: string } | null,
  nowEpoch: number,
): AdminMetricsHistory {
  if (row === null
      || typeof row.generated_at !== "string"
      || typeof row.payload_json !== "string"
      || new TextEncoder().encode(row.payload_json).byteLength
        > HISTORY_CACHE_JSON_LIMIT_BYTES) {
    return cacheUnavailable();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json);
  } catch {
    return cacheUnavailable();
  }
  if (!validCachedAdminMetricsHistory(parsed, row.generated_at, nowEpoch)) {
    return cacheUnavailable();
  }
  return parsed;
}

/**
 * The interactive owner route's complete data path after authentication: one
 * bounded SELECT from the singleton aggregate cache. It never rebuilds,
 * analyzes, or writes in response to a browser request.
 */
export async function readCachedAdminMetricsHistory(
  db: D1Database,
  nowEpoch: number,
): Promise<AdminMetricsHistory> {
  let row: { generated_at: string; payload_json: string } | null;
  try {
    row = await db.prepare(
      `SELECT generated_at, payload_json
         FROM admin_metrics_history_cache
        WHERE singleton = 1 AND length(payload_json) <= ?1
        LIMIT 1`,
    ).bind(HISTORY_CACHE_JSON_LIMIT_BYTES)
      .first<{ generated_at: string; payload_json: string }>();
  } catch {
    throw new ApiError(503, "ADMIN_METRICS_HISTORY_STORAGE_UNAVAILABLE");
  }
  return parseCachedHistoryRow(row, nowEpoch);
}

/** Typed interactive route: one target SELECT, pinned to the exact registered
 * source. Source authority resolution happens before this helper is called.
 *
 * The analytics scheduler writes this publication and the main Worker serves
 * it, and they deploy separately. Each payload contract therefore has its own
 * row, so an upgraded writer never replaces the one an older reader serves.
 * The source-keyed 0016 row remains a fallback that validation accepts only
 * when it carries this reader's contract; either Worker can deploy first. */
export async function readCachedStorageAdminMetricsHistory(
  bindings: StorageAnalyticsBindings,
  nowEpoch: number,
): Promise<AdminMetricsHistory> {
  let row: { generated_at: string; payload_json: string } | null;
  try {
    row = await bindings.target.prepare(
      `SELECT candidate.generated_at,candidate.payload_json
         FROM (
           SELECT 0 AS preference,source_id,generated_at,payload_json
             FROM analytics_admin_metrics_history_publications
            WHERE source_id=?1 AND schema_version=?4
           UNION ALL
           SELECT 1 AS preference,source_id,generated_at,payload_json
             FROM analytics_admin_metrics_history_cache
            WHERE source_id=?1
         ) candidate
         JOIN analytics_runtime_sources source ON source.source_id=candidate.source_id
        WHERE source.source_namespace=?2 AND source.contract_version=1
          AND length(candidate.payload_json)<=?3
        ORDER BY candidate.preference
        LIMIT 1`,
    ).bind(
      bindings.sourceId,
      bindings.sourceNamespace,
      HISTORY_CACHE_JSON_LIMIT_BYTES,
      ADMIN_METRICS_HISTORY_SCHEMA_VERSION,
    ).first<{ generated_at: string; payload_json: string }>();
  } catch {
    throw new ApiError(503, "ADMIN_METRICS_HISTORY_STORAGE_UNAVAILABLE");
  }
  return parseCachedHistoryRow(row, nowEpoch);
}

export interface AdminMetricsHistoryCacheResult {
  code:
    | "HISTORY_CACHE_REFRESHED"
    | "HISTORY_CACHE_CURRENT"
    | "HISTORY_CACHE_UNAVAILABLE";
}

async function storageAdminSourceMatches(
  bindings: StorageAnalyticsBindings,
): Promise<{ matches: boolean; includeV12: boolean }> {
  if (bindings.source === bindings.target) {
    return { matches: false, includeV12: false };
  }
  const row = await bindings.source.prepare(
    `SELECT 1 AS ready, ${TELEMETRY_V12_ADMIN_SCHEMA_SQL}
       FROM storage_source_state source
       JOIN typed_v1_admission_state v1 ON v1.id=1
         AND v1.runtime_contract_version=1
       JOIN typed_v11_admission_state v11 ON v11.id=1
         AND v11.runtime_contract_version=1
      WHERE source.singleton=1 AND source.source_id=?1
        AND v1.source_namespace=?2 AND v11.source_namespace=?2
      LIMIT 1`,
  ).bind(bindings.sourceId, bindings.sourceNamespace)
    .first<{ ready: number } & TelemetryV12AdminSchemaRow>();
  if (row?.ready !== 1) return { matches: false, includeV12: false };
  return { matches: true, includeV12: telemetryV12AdminSchemaPresent(row) };
}

/**
 * Scheduled-only cache refresh. It self-throttles before executing the raw
 * SELECT-only history builder, writes one shape-checked aggregate row when due,
 * and never throws into retention/publication maintenance.
 */
export async function warmAdminMetricsHistoryCache(
  db: D1Database,
  nowEpoch: number,
): Promise<AdminMetricsHistoryCacheResult> {
  try {
    const existing = await db.prepare(
      `SELECT generated_at, payload_json FROM admin_metrics_history_cache
        WHERE singleton = 1 AND length(payload_json) <= ?1
        LIMIT 1`,
    ).bind(HISTORY_CACHE_JSON_LIMIT_BYTES)
      .first<{ generated_at: string; payload_json: string }>();
    const existingEpoch = Date.parse(existing?.generated_at ?? "");
    let existingPayload: unknown = null;
    try {
      existingPayload = JSON.parse(existing?.payload_json ?? "");
    } catch {
      // A fresh-but-corrupt row must be rebuilt immediately, not trusted until
      // the normal 55-minute cadence expires.
    }
    if (Number.isFinite(existingEpoch)
        && existingEpoch <= nowEpoch + HISTORY_CACHE_MAX_FUTURE_SKEW_MILLISECONDS
        && nowEpoch - existingEpoch < HISTORY_CACHE_MIN_INTERVAL_MILLISECONDS
        && validCachedAdminMetricsHistory(
          existingPayload,
          existing?.generated_at ?? "",
          nowEpoch,
        )) {
      return { code: "HISTORY_CACHE_CURRENT" };
    }

    const history = await readAdminMetricsHistory(db, nowEpoch);
    const payloadJson = JSON.stringify(history);
    if (new TextEncoder().encode(payloadJson).byteLength
          > HISTORY_CACHE_JSON_LIMIT_BYTES
        || !validCachedAdminMetricsHistory(history, history.generatedAt, nowEpoch)) {
      return { code: "HISTORY_CACHE_UNAVAILABLE" };
    }
    const write = await db.prepare(
      `INSERT INTO admin_metrics_history_cache (
         singleton, generated_at, payload_json
       ) VALUES (1, ?1, ?2)
       ON CONFLICT(singleton) DO UPDATE SET
         generated_at = excluded.generated_at,
         payload_json = excluded.payload_json`,
    ).bind(history.generatedAt, payloadJson).run();
    return write.meta.changes === 1
      ? { code: "HISTORY_CACHE_REFRESHED" }
      : { code: "HISTORY_CACHE_UNAVAILABLE" };
  } catch {
    return { code: "HISTORY_CACHE_UNAVAILABLE" };
  }
}

/** Typed scheduled cache refresh. Retained events come from ingestion while
 * the aggregate cache and its post-migration gauge history stay in analytics.
 * It reads and writes only this contract's publication, leaving rows that
 * other contracts' readers serve untouched. */
export async function warmStorageAdminMetricsHistoryCache(
  bindings: StorageAnalyticsBindings,
  nowEpoch: number,
): Promise<AdminMetricsHistoryCacheResult> {
  try {
    const source = await storageAdminSourceMatches(bindings);
    if (!source.matches) {
      return { code: "HISTORY_CACHE_UNAVAILABLE" };
    }
    const existing = await bindings.target.prepare(
      `SELECT publication.generated_at,publication.payload_json
         FROM analytics_runtime_sources source
         LEFT JOIN analytics_admin_metrics_history_publications publication
           ON publication.source_id=source.source_id
          AND publication.schema_version=?4
        WHERE source.source_id=?1 AND source.source_namespace=?2
          AND source.contract_version=1
          AND (publication.payload_json IS NULL
            OR length(publication.payload_json)<=?3)
        LIMIT 1`,
    ).bind(
      bindings.sourceId,
      bindings.sourceNamespace,
      HISTORY_CACHE_JSON_LIMIT_BYTES,
      ADMIN_METRICS_HISTORY_SCHEMA_VERSION,
    ).first<{ generated_at: string | null; payload_json: string | null }>();
    if (existing === null) return { code: "HISTORY_CACHE_UNAVAILABLE" };
    const existingEpoch = Date.parse(existing.generated_at ?? "");
    let existingPayload: unknown = null;
    try {
      existingPayload = JSON.parse(existing.payload_json ?? "");
    } catch {
      // A corrupt cache is rebuilt immediately when bounded source evidence is
      // available; it is never served merely because it is recent.
    }
    if (typeof existing.generated_at === "string"
        && Number.isFinite(existingEpoch)
        && existingEpoch <= nowEpoch + HISTORY_CACHE_MAX_FUTURE_SKEW_MILLISECONDS
        && nowEpoch - existingEpoch < HISTORY_CACHE_MIN_INTERVAL_MILLISECONDS
        && validCachedAdminMetricsHistory(
          existingPayload,
          existing.generated_at,
          nowEpoch,
        )) {
      return { code: "HISTORY_CACHE_CURRENT" };
    }

    const history = await readStorageAdminMetricsHistory(
      bindings, nowEpoch, source.includeV12,
    );
    // Gauge history starts at the first successful typed capture. An empty
    // target must remain unavailable rather than look like proven zero history.
    if (history.gauges.snapshots.length === 0) {
      return { code: "HISTORY_CACHE_UNAVAILABLE" };
    }
    const payloadJson = JSON.stringify(history);
    if (new TextEncoder().encode(payloadJson).byteLength
          > HISTORY_CACHE_JSON_LIMIT_BYTES
        || !validCachedAdminMetricsHistory(history, history.generatedAt, nowEpoch)) {
      return { code: "HISTORY_CACHE_UNAVAILABLE" };
    }
    const write = await bindings.target.prepare(
      `INSERT INTO analytics_admin_metrics_history_publications(
         source_id,schema_version,generated_at,payload_json
       ) VALUES(?1,?2,?3,?4)
       ON CONFLICT(source_id,schema_version) DO UPDATE SET
         generated_at=excluded.generated_at,payload_json=excluded.payload_json`,
    ).bind(
      bindings.sourceId,
      history.schemaVersion,
      history.generatedAt,
      payloadJson,
    ).run();
    return write.meta.changes === 1
      ? { code: "HISTORY_CACHE_REFRESHED" }
      : { code: "HISTORY_CACHE_UNAVAILABLE" };
  } catch {
    return { code: "HISTORY_CACHE_UNAVAILABLE" };
  }
}

async function readGaugeSnapshots(
  db: D1Database,
  nowEpoch: number,
): Promise<AdminMetricsHistory["gauges"]["snapshots"]> {
  const fullResolutionSince = iso(
    nowEpoch - SNAPSHOT_FULL_RESOLUTION_DAYS * DAY_MILLISECONDS,
  );
  const historySince = iso(
    nowEpoch - SNAPSHOT_HISTORY_DAYS * DAY_MILLISECONDS,
  );
  try {
    const rows = await db.prepare(
      `SELECT captured_at, metrics_json FROM (
         SELECT captured_at, metrics_json FROM admin_metric_snapshots
          WHERE captured_at >= ?1
         UNION ALL
         SELECT captured_at, metrics_json FROM admin_metric_snapshots
          WHERE captured_at >= ?2 AND captured_at < ?1
            AND captured_at IN (
              SELECT MAX(captured_at) FROM admin_metric_snapshots
               WHERE captured_at >= ?2 AND captured_at < ?1
               GROUP BY substr(captured_at, 1, 10)
            )
         ORDER BY captured_at DESC
         LIMIT ?3
       )
       ORDER BY captured_at`,
    ).bind(
      fullResolutionSince,
      historySince,
      SNAPSHOT_RESULT_LIMIT,
    ).all<{ captured_at: string; metrics_json: string }>();
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

async function readStorageGaugeSnapshots(
  db: D1Database,
  sourceId: string,
  nowEpoch: number,
): Promise<AdminMetricsHistory["gauges"]["snapshots"]> {
  const fullResolutionSince = iso(
    nowEpoch - SNAPSHOT_FULL_RESOLUTION_DAYS * DAY_MILLISECONDS,
  );
  const historySince = iso(
    nowEpoch - SNAPSHOT_HISTORY_DAYS * DAY_MILLISECONDS,
  );
  const rows = await db.prepare(
    `SELECT captured_at,metrics_json FROM (
       SELECT captured_at,metrics_json
         FROM analytics_admin_metric_snapshots
        WHERE source_id=?1 AND captured_at>=?2
       UNION ALL
       SELECT captured_at,metrics_json
         FROM analytics_admin_metric_snapshots
        WHERE source_id=?1 AND captured_at>=?3 AND captured_at<?2
          AND captured_at IN (
            SELECT MAX(captured_at) FROM analytics_admin_metric_snapshots
             WHERE source_id=?1 AND captured_at>=?3 AND captured_at<?2
             GROUP BY substr(captured_at,1,10)
          )
       ORDER BY captured_at DESC LIMIT ?4
     ) ORDER BY captured_at`,
  ).bind(sourceId, fullResolutionSince, historySince, SNAPSHOT_RESULT_LIMIT)
    .all<{ captured_at: string; metrics_json: string }>();
  const snapshots: AdminMetricsHistory["gauges"]["snapshots"] = [];
  for (const row of rows.results) {
    try {
      const metrics = JSON.parse(row.metrics_json) as Record<string, unknown>;
      const clean: Record<string, number> = {};
      for (const [key, value] of Object.entries(metrics)) {
        if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
      }
      snapshots.push({ capturedAt: row.captured_at, metrics: clean });
    } catch {
      // One corrupt aggregate row cannot smuggle fields or hide valid rows.
    }
  }
  return snapshots;
}

export interface AdminMetricSnapshotResult {
  code: "SNAPSHOT_CAPTURED" | "SNAPSHOT_CURRENT" | "SNAPSHOT_UNAVAILABLE";
}

interface AdminMetricGaugeRow {
  participants_total: number;
  participants_active: number;
  corpus_chunks: number;
  corpus_current_chunks: number;
  corpus_current_records: number;
  contributing_accounts_total: number;
  contributing_accounts_bounded: number;
  quarantine_pending_objects: number;
  quarantine_pending_objects_bounded: number;
  quarantine_within_grace: number;
  quarantine_due_referenced: number;
  quarantine_due_unreferenced: number;
  participant_rows: number;
  chunk_rows: number;
  legacy_contribution_rows: number;
}

/**
 * One aggregate SELECT captures all D1-backed current-state card values. Each
 * source is scanned at most once inside the statement, and browser requests
 * never execute it: only the self-throttled scheduled capture does.
 */
async function readCurrentStateGauges(
  db: D1Database,
  nowEpoch: number,
  maximumRows?: number,
  includeV11 = false,
  includeV12 = false,
): Promise<Record<string, number>> {
  const cutoffAt = iso(
    nowEpoch - QUARANTINE_RECONCILIATION_GRACE_MILLISECONDS,
  );
  const participantRelation = maximumRows === undefined
    ? "participants" : "bounded_participants";
  const chunkRelation = includeV11
    ? "typed_chunk_headers"
    : maximumRows === undefined ? "telemetry_v1_chunks" : "bounded_chunks";
  const legacyContributionRelation = maximumRows === undefined
    ? "telemetry_contributions" : "bounded_legacy_contributions";
  const boundedSourceRelations = maximumRows === undefined ? "" : `
     bounded_participants AS (
       SELECT state FROM participants ORDER BY id LIMIT ${maximumRows + 1}
     ),
     ${includeV11 ? `typed_chunk_headers AS (
       SELECT participant_id,accepted_record_count AS record_count
         FROM telemetry_v1_chunks
       UNION ALL
       SELECT participant_id,record_count
         FROM telemetry_v11_chunks
       ${includeV12 ? `UNION ALL
       SELECT participant_id,record_count
         FROM telemetry_v12_chunks` : ""}
     )` : `bounded_chunks AS (
       SELECT id,participant_id,record_count,superseded_at,r2_key,created_at
         FROM telemetry_v1_chunks ORDER BY created_at DESC,id DESC
        LIMIT ${maximumRows + 1}
     )`},
     bounded_legacy_contributions AS (
       SELECT participant_id,status,r2_key FROM telemetry_contributions
        ORDER BY created_at DESC,id DESC LIMIT ${maximumRows + 1}
     ),`;
  const legacyContributionMetrics = maximumRows === undefined
    ? "SELECT 0 AS total"
    : `SELECT COUNT(*) AS total FROM ${legacyContributionRelation}`;
  const row = await db.prepare(
    `WITH ${boundedSourceRelations} participant_metrics AS (
       SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END), 0)
                AS active
         FROM ${participantRelation}
     ),
     chunk_metrics AS (
       ${includeV11 ? `SELECT COUNT(*) AS chunks,
              ((SELECT COUNT(*) FROM telemetry_analytical_chunks)
               ${includeV12 ? `+ (SELECT COUNT(*) FROM telemetry_v12_domain_heads head
                 JOIN telemetry_v12_domain_days day ON day.generation_id=head.generation_id
                 JOIN telemetry_v12_chunks chunk ON chunk.participant_id=head.participant_id
                  AND chunk.manifest_id=day.manifest_id)` : ""})
                AS current_chunks,
              (COALESCE((SELECT SUM(accepted_record_count)
                FROM telemetry_analytical_chunks),0)
               ${includeV12 ? `+ COALESCE((SELECT SUM(chunk.record_count)
                 FROM telemetry_v12_domain_heads head
                 JOIN telemetry_v12_domain_days day ON day.generation_id=head.generation_id
                 JOIN telemetry_v12_chunks chunk ON chunk.participant_id=head.participant_id
                  AND chunk.manifest_id=day.manifest_id),0)` : ""})
                AS current_records
         FROM typed_chunk_headers` : `SELECT COUNT(*) AS chunks,
              COALESCE(SUM(CASE WHEN superseded_at IS NULL
                THEN 1 ELSE 0 END), 0)
                AS current_chunks,
              COALESCE(SUM(CASE WHEN superseded_at IS NULL
                THEN record_count ELSE 0 END), 0)
                AS current_records
         FROM ${chunkRelation}`}
     ),
     legacy_contribution_metrics AS (
       ${legacyContributionMetrics}
     ),
     contributing_accounts_raw AS (
       SELECT COUNT(*) AS total FROM (
         SELECT participant_id FROM (
           SELECT participant_id FROM ${legacyContributionRelation}
            WHERE status = 'accepted'
           UNION
           SELECT participant_id FROM ${chunkRelation}
         )
         ORDER BY participant_id
         LIMIT 10001
       )
     ),
     contributing_accounts AS (
       SELECT CASE WHEN total > 10000 THEN 10000 ELSE total END AS total,
              CASE WHEN total > 10000 THEN 1 ELSE 0 END AS bounded
         FROM contributing_accounts_raw
     ),
     pending AS (
       SELECT r2_key, registered_at
         FROM pending_quarantine_objects
        ORDER BY registered_at, r2_key
        LIMIT 10001
     ),
     quarantine_metrics_raw AS (
       SELECT COUNT(*) AS pending_objects,
              COALESCE(SUM(CASE WHEN registered_at > ?1 THEN 1 ELSE 0 END), 0)
                AS within_grace,
              COALESCE(SUM(CASE WHEN registered_at <= ?1 AND (
                EXISTS (SELECT 1 FROM contributions WHERE r2_key = pending.r2_key)
                OR EXISTS (
                  SELECT 1 FROM telemetry_contributions
                   WHERE r2_key = pending.r2_key
                )
                OR EXISTS (
                  SELECT 1 FROM telemetry_v1_chunks
                   WHERE r2_key = pending.r2_key
                )
                OR EXISTS (
                  SELECT 1 FROM telemetry_v11_chunks
                   WHERE r2_key = pending.r2_key
                )
                ${includeV12 ? `OR EXISTS (
                  SELECT 1 FROM telemetry_v12_chunks
                   WHERE r2_key = pending.r2_key
                )` : ""}
              ) THEN 1 ELSE 0 END), 0) AS due_referenced,
              COALESCE(SUM(CASE WHEN registered_at <= ?1
                AND NOT EXISTS (
                  SELECT 1 FROM contributions WHERE r2_key = pending.r2_key
                )
                AND NOT EXISTS (
                  SELECT 1 FROM telemetry_contributions
                   WHERE r2_key = pending.r2_key
                )
                AND NOT EXISTS (
                  SELECT 1 FROM telemetry_v1_chunks
                   WHERE r2_key = pending.r2_key
                )
                AND NOT EXISTS (
                  SELECT 1 FROM telemetry_v11_chunks
                   WHERE r2_key = pending.r2_key
                )
                ${includeV12 ? `AND NOT EXISTS (
                  SELECT 1 FROM telemetry_v12_chunks
                   WHERE r2_key = pending.r2_key
                )` : ""}
                THEN 1 ELSE 0 END), 0) AS due_unreferenced
         FROM pending
     ),
     quarantine_metrics AS (
       SELECT CASE WHEN pending_objects > 10000
                   THEN 10000 ELSE pending_objects END AS pending_objects,
              CASE WHEN within_grace > 10000
                   THEN 10000 ELSE within_grace END AS within_grace,
              CASE WHEN due_referenced > 10000
                   THEN 10000 ELSE due_referenced END AS due_referenced,
              CASE WHEN due_unreferenced > 10000
                   THEN 10000 ELSE due_unreferenced END AS due_unreferenced,
              CASE WHEN pending_objects > 10000 THEN 1 ELSE 0 END AS bounded
         FROM quarantine_metrics_raw
     )
     SELECT participant_metrics.total AS participants_total,
            participant_metrics.active AS participants_active,
            chunk_metrics.chunks AS corpus_chunks,
            chunk_metrics.current_chunks AS corpus_current_chunks,
            chunk_metrics.current_records AS corpus_current_records,
            contributing_accounts.total AS contributing_accounts_total,
            contributing_accounts.bounded AS contributing_accounts_bounded,
            quarantine_metrics.pending_objects AS quarantine_pending_objects,
            quarantine_metrics.bounded AS quarantine_pending_objects_bounded,
            quarantine_metrics.within_grace AS quarantine_within_grace,
            quarantine_metrics.due_referenced AS quarantine_due_referenced,
            quarantine_metrics.due_unreferenced AS quarantine_due_unreferenced,
            participant_metrics.total AS participant_rows,
            chunk_metrics.chunks AS chunk_rows,
            legacy_contribution_metrics.total AS legacy_contribution_rows
       FROM participant_metrics, chunk_metrics, contributing_accounts,
            quarantine_metrics, legacy_contribution_metrics`,
  ).bind(cutoffAt).first<AdminMetricGaugeRow>();
  if (!row) throw new Error("admin metric gauges unavailable");
  if (maximumRows !== undefined
      && (Number(row.participant_rows) > maximumRows
        || (!includeV11 && Number(row.chunk_rows) > maximumRows)
        || Number(row.legacy_contribution_rows) > maximumRows)) {
    throw new Error("admin metric source bound exceeded");
  }
  const gauges = {
    participantsTotal: Number(row.participants_total),
    participantsActive: Number(row.participants_active),
    corpusChunks: Number(row.corpus_chunks),
    corpusCurrentChunks: Number(row.corpus_current_chunks),
    corpusCurrentRecords: Number(row.corpus_current_records),
    contributingAccountsTotal: Number(row.contributing_accounts_total),
    contributingAccountsTotalBounded: Number(row.contributing_accounts_bounded),
    quarantinePendingObjects: Number(row.quarantine_pending_objects),
    quarantinePendingObjectsBounded:
      Number(row.quarantine_pending_objects_bounded),
    quarantineWithinGrace: Number(row.quarantine_within_grace),
    quarantineDueReferenced: Number(row.quarantine_due_referenced),
    quarantineDueUnreferenced: Number(row.quarantine_due_unreferenced),
  };
  if (Object.values(gauges).some((value) => (
    !Number.isSafeInteger(value) || value < 0
  ))) {
    throw new Error("invalid admin metric gauge");
  }
  return gauges;
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
    const [current, band] = await Promise.all([
      readCurrentStateGauges(db, nowEpoch),
      readPublishedBandGauges(db, nowEpoch),
    ]);
    const metrics: Record<string, number> = {
      ...current,
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

/** Typed hourly capture. Operational counts remain source-owned; only the
 * small source-keyed aggregate row crosses into analytics storage. */
export async function captureStorageAdminMetricSnapshot(
  bindings: StorageAnalyticsBindings,
  nowEpoch: number,
): Promise<AdminMetricSnapshotResult> {
  try {
    const source = await storageAdminSourceMatches(bindings);
    if (!source.matches) {
      return { code: "SNAPSHOT_UNAVAILABLE" };
    }
    const registered = await bindings.target.prepare(
      `SELECT 1 AS ready FROM analytics_runtime_sources
        WHERE source_id=?1 AND source_namespace=?2 AND contract_version=1
        LIMIT 1`,
    ).bind(bindings.sourceId, bindings.sourceNamespace).first<number>("ready");
    if (registered !== 1) return { code: "SNAPSHOT_UNAVAILABLE" };
    const latest = await bindings.target.prepare(
      `SELECT MAX(captured_at) AS captured_at
         FROM analytics_admin_metric_snapshots WHERE source_id=?1`,
    ).bind(bindings.sourceId).first<{ captured_at: string | null }>();
    const latestEpoch = Date.parse(latest?.captured_at ?? "");
    if (Number.isFinite(latestEpoch)
        && nowEpoch - latestEpoch < SNAPSHOT_MIN_INTERVAL_MILLISECONDS) {
      return { code: "SNAPSHOT_CURRENT" };
    }
    const [current, band] = await Promise.all([
      readCurrentStateGauges(
        bindings.source,
        nowEpoch,
        STORAGE_ADMIN_SOURCE_ROW_LIMIT,
        true,
        source.includeV12,
      ),
      readStoragePublishedBandGauges(bindings, nowEpoch),
    ]);
    const metricsJson = JSON.stringify({ ...current, ...band });
    if (metricsJson.length > SNAPSHOT_JSON_LIMIT_BYTES) {
      return { code: "SNAPSHOT_UNAVAILABLE" };
    }
    const write = await bindings.target.prepare(
      `INSERT INTO analytics_admin_metric_snapshots(
         source_id,captured_at,metrics_json
       ) VALUES(?1,?2,?3)
       ON CONFLICT(source_id,captured_at) DO NOTHING`,
    ).bind(bindings.sourceId, iso(nowEpoch), metricsJson).run();
    return write.meta.changes === 1
      ? { code: "SNAPSHOT_CAPTURED" }
      : { code: "SNAPSHOT_CURRENT" };
  } catch {
    return { code: "SNAPSHOT_UNAVAILABLE" };
  }
}

async function readStoragePublishedBandGauges(
  bindings: StorageAnalyticsBindings,
  nowEpoch: number,
): Promise<Record<string, number>> {
  try {
    const preview = await readPublishedStorageCommunityAdminPreview(
      bindings,
      nowEpoch,
    );
    const latest = preview?.days.at(-1)?.combined;
    if (!latest
        || !Number.isSafeInteger(latest.fitCount) || latest.fitCount < 0
        || !Number.isSafeInteger(latest.participantCount)
        || latest.participantCount < 0
        || latest.participantCount > latest.fitCount) {
      return {};
    }
    return {
      bandFitCount: latest.fitCount,
      bandParticipantCount: latest.participantCount,
    };
  } catch {
    // Publication absence leaves these gauges unavailable, never zero.
    return {};
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
      `SELECT a.payload_json, state.publication_state, state.expected_basis,
          state.attribution_method_version, state.safe_from_day, state.safe_to_day
        FROM community_daily_aggregates a JOIN community_allowance_publication_state state ON state.singleton=1
        WHERE a.release_state = 'published' AND a.day BETWEEN state.safe_from_day AND state.safe_to_day
        ORDER BY a.day DESC, a.revision DESC
        LIMIT 1`,
    ).first<CommunityAllowancePublicationStateRow & { payload_json: string }>();
    if (published && isCurrentCommunityAllowancePublication(published, nowEpoch)) {
      const payload = JSON.parse(published.payload_json) as {
        allowance?: { basis?: unknown; fitCount?: unknown; participantCount?: unknown };
      };
      const {fitCount, participantCount, basis} = payload.allowance ?? {};
      if (basis === COMMUNITY_ALLOWANCE_BASIS && typeof fitCount === "number"
          && Number.isSafeInteger(fitCount) && fitCount >= 0
          && typeof participantCount === "number" && Number.isSafeInteger(participantCount)
          && participantCount >= 0 && participantCount <= fitCount) {
        gauges.bandFitCount = fitCount;
        gauges.bandParticipantCount = participantCount;
      }
    }
  } catch {
    // Absent aggregate tables (fresh environment) leave the gauges out.
  }
  try {
    const corpus = await readCachedCommunityAllowanceCorpus(db, nowEpoch);
    if (corpus !== null) {
      Object.assign(gauges, computeCohortGaugesFromCorpus(corpus.fits, nowEpoch));
    }
  } catch {
    // Missing, stale, or corrupt validated cache evidence leaves cohort gauges
    // out. Never fall back to every historical cache row: it can include
    // setup-only or no-longer-selected accounts and would overstate coverage.
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
  const participantFits: {
    planType?: unknown;
    lastObservedAt?: unknown;
    capacityNanousd?: unknown;
  }[][] = [];
  for (const fitsJson of fitsJsonRows) {
    try {
      const parsed: unknown = JSON.parse(fitsJson);
      if (Array.isArray(parsed)) participantFits.push(parsed);
    } catch {
      // A corrupt cache row is the fit collector's problem, not history's.
    }
  }
  return computeCohortGaugesFromParticipantFits(participantFits, nowEpoch);
}

function computeCohortGaugesFromCorpus(
  fits: readonly CommunityAllowanceFit[],
  nowEpoch: number,
): Record<string, number> {
  const byParticipant = new Map<string, CommunityAllowanceFit[]>();
  for (const fit of fits) {
    const bucket = byParticipant.get(fit.participantId);
    if (bucket) bucket.push(fit);
    else byParticipant.set(fit.participantId, [fit]);
  }
  return computeCohortGaugesFromParticipantFits(
    [...byParticipant.values()],
    nowEpoch,
  );
}

function computeCohortGaugesFromParticipantFits(
  participantFits: readonly (readonly {
    planType?: unknown;
    lastObservedAt?: unknown;
    capacityNanousd?: unknown;
  }[])[],
  nowEpoch: number,
): Record<string, number> {
  const trailingSince = iso(nowEpoch - 30 * DAY_MILLISECONDS);
  const planParticipants = new Map<string, number>();
  const planCapacitiesUsd = new Map<string, number[]>();
  for (const fits of participantFits) {
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
