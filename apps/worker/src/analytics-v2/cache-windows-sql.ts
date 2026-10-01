/**
 * Read-time community cache-retention windows over analytics_v2_cache_bands
 * (GCP fast path, A-4).
 *
 * This is the PostgreSQL counterpart of d43c8f92
 * cache-retention-day.ts readCacheRetentionCommunityBands and
 * readCacheRetentionCommunitySeries. The analytics-refresh job (A-2/A-3)
 * stores one row per owner, day, model, effort and band, computed by the
 * vendored reduceCacheRetentionDay under the vendored method, so there is no
 * mark/value join and no method column to fence on: every stored row is the
 * current method's row.
 *
 * For each production window (day, week, month, all; calendar days ending
 * today inclusive, `all` unbounded) the reader runs the same two aggregates
 * production runs:
 * - pooled: SUM of the seven counters GROUP BY owner, band;
 * - by model: the same GROUP BY owner, band, model, with effort summed over.
 * The pooled read is separate because `sessions` is a per-row distinct count;
 * summing it across models would double count a session that used two.
 *
 * The rows are then projected with the vendored mergeCacheRetentionBands and
 * publicCacheRetentionWindow (which applies publicCacheRetentionCurve and the
 * production model limit of 8). No window with evidence is absence: the series
 * is null, never four windows of ten zeroes.
 *
 * Output carries counts and contributor shares only. Owner digests are read to
 * count contributors and never leave this module.
 */
import {
  CACHE_RETENTION_METHOD,
  CACHE_RETENTION_METRIC_ID,
  CACHE_RETENTION_PUBLIC_SCHEMA_VERSION,
  CACHE_RETENTION_WINDOWS,
  mergeCacheRetentionBands,
  publicCacheRetentionWindow,
  type CacheRetentionBandRow,
  type CacheRetentionWindowId,
  type PublicCacheRetentionSeries,
  type PublicCacheRetentionWindow,
} from "../../vendor/analytics-d43c8f92/entry";
// Not re-exported by the vendor facade (entry.ts); imported from the same
// vendored d43c8f92 module the facade's cache-retention exports come from.
import { CACHE_RETENTION_BAND_IDS } from "../../vendor/analytics-d43c8f92/apps/worker/src/cache-retention-values";
import { quotePostgresIdentifier, type PostgresClient } from "../postgres-client";
import { ANALYTICS_V2_CACHE_BAND_COUNTERS, ANALYTICS_V2_TABLES } from "./contract";

const DAY_MS = 86_400_000;
const DECIMAL_COUNT = /^(?:0|[1-9][0-9]{0,15})$/u;

/** The production band vocabulary, in method order. */
export const ANALYTICS_V2_CACHE_RETENTION_BAND_IDS: readonly string[] = CACHE_RETENTION_BAND_IDS;

/** One window's raw aggregate rows, as production's two reads return them. */
export interface AnalyticsV2CacheWindowRows {
  readonly window: CacheRetentionWindowId;
  readonly days: number | null;
  readonly fromDay: string | null;
  readonly pooled: readonly CacheRetentionBandRow[];
  readonly modelRows: readonly CacheRetentionBandRow[];
}

function fail(): never {
  throw new Error("ANALYTICS_V2_CACHE_WINDOWS_UNAVAILABLE");
}

/**
 * Inclusive lower day of a today-inclusive window, exactly as production
 * computes it from nowMs, or null for the unbounded `all` window.
 */
export function analyticsV2CacheWindowFromDay(nowMs: number, days: number | null): string | null {
  if (!Number.isSafeInteger(nowMs)) fail();
  if (days === null) return null;
  if (!Number.isSafeInteger(days) || days < 1) fail();
  return new Date(nowMs - (days - 1) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The pooled or by-model aggregate over analytics_v2_cache_bands. `day` is
 * compared as a date so the statement does not depend on whether the column
 * is date or ISO text; $1 is the inclusive lower day when `bounded`.
 */
export function analyticsV2CacheBandsSql(
  schema: string,
  options: { readonly byModel: boolean; readonly bounded: boolean },
): string {
  const table = `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(ANALYTICS_V2_TABLES.cacheBands)}`;
  const sums = ANALYTICS_V2_CACHE_BAND_COUNTERS
    .map((counter) => `SUM(b.${counter})::text AS ${counter}`)
    .join(",\n       ");
  const groups = options.byModel ? "b.owner_digest, b.band, b.model" : "b.owner_digest, b.band";
  const order = options.byModel
    ? `b.owner_digest COLLATE "C", b.band COLLATE "C", b.model COLLATE "C"`
    : `b.owner_digest COLLATE "C", b.band COLLATE "C"`;
  return `SELECT b.owner_digest::text AS owner_digest, b.band::text AS band,${
    options.byModel ? " b.model::text AS model," : ""}
       ${sums}
  FROM ${table} b${options.bounded ? "\n WHERE b.day::date >= $1::date" : ""}
 GROUP BY ${groups}
 ORDER BY ${order}`;
}

function count(value: unknown): number {
  if (typeof value !== "string" || !DECIMAL_COUNT.test(value)) fail();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail();
  return parsed;
}

type AggregateRow = Readonly<Record<string, unknown>>;

/** Production's row shape: owner, band, the seven counters, and model only when grouped by it. */
function bandRow(row: AggregateRow, byModel: boolean): CacheRetentionBandRow {
  const band = row.band;
  if (typeof row.owner_digest !== "string" || typeof band !== "string"
      || !CACHE_RETENTION_BAND_IDS.includes(band as CacheRetentionBandRow["band"])) fail();
  if (byModel && typeof row.model !== "string") fail();
  return {
    ownerDigest: row.owner_digest,
    band: band as CacheRetentionBandRow["band"],
    adjacencies: count(row.adjacencies),
    reusedMoreThanHalf: count(row.reused_more_than_half),
    matchedOrExceeded: count(row.matched_or_exceeded),
    unorderedTies: count(row.unordered_ties),
    excludedInsufficientEvidence: count(row.excluded_insufficient_evidence),
    excludedContextContracted: count(row.excluded_context_contracted),
    sessions: count(row.sessions),
    ...(byModel ? { model: row.model as string } : {}),
  };
}

/**
 * Run the eight production aggregates (pooled and by model, four windows) on
 * the caller's connection, inside the caller's read transaction, so all four
 * windows come from one snapshot. Throws on any read or shape failure.
 */
export async function readAnalyticsV2CacheWindowRows(
  client: PostgresClient,
  schema: string,
  nowMs: number,
): Promise<readonly AnalyticsV2CacheWindowRows[]> {
  if (client === null || typeof client !== "object" || typeof client.query !== "function") fail();
  const windows: AnalyticsV2CacheWindowRows[] = [];
  for (const span of CACHE_RETENTION_WINDOWS) {
    const fromDay = analyticsV2CacheWindowFromDay(nowMs, span.days);
    const bounded = fromDay !== null;
    const values = bounded ? [fromDay] : [];
    const pooled = await client.query<AggregateRow>(
      analyticsV2CacheBandsSql(schema, { byModel: false, bounded }), values,
    );
    const modelRows = await client.query<AggregateRow>(
      analyticsV2CacheBandsSql(schema, { byModel: true, bounded }), values,
    );
    if (!Array.isArray(pooled?.rows) || !Array.isArray(modelRows?.rows)) fail();
    windows.push(Object.freeze({
      window: span.id,
      days: span.days,
      fromDay,
      pooled: Object.freeze(pooled.rows.map((row) => bandRow(row, false))),
      modelRows: Object.freeze(modelRows.rows.map((row) => bandRow(row, true))),
    }));
  }
  return Object.freeze(windows);
}

/**
 * Project the windows exactly as production's readCacheRetentionCommunitySeries
 * does: null when no window has pooled evidence, otherwise every window pooled
 * and cut by model under the vendored method version. Throws when a stored row
 * fails the vendored counter validation, as production's read does.
 */
export function composeAnalyticsV2CacheRetentionSeries(
  windows: readonly AnalyticsV2CacheWindowRows[],
): PublicCacheRetentionSeries | null {
  if (!Array.isArray(windows) || windows.length !== CACHE_RETENTION_WINDOWS.length) fail();
  const projected: PublicCacheRetentionWindow[] = [];
  let anyEvidence = false;
  for (const [index, span] of CACHE_RETENTION_WINDOWS.entries()) {
    const rows = windows[index];
    if (rows === undefined || rows.window !== span.id || rows.days !== span.days) fail();
    if (rows.pooled.length > 0) anyEvidence = true;
    projected.push(publicCacheRetentionWindow({
      window: span.id,
      days: span.days,
      pooled: mergeCacheRetentionBands(rows.pooled),
      modelRows: rows.modelRows,
    }));
  }
  if (!anyEvidence) return null;
  return {
    schemaVersion: CACHE_RETENTION_PUBLIC_SCHEMA_VERSION,
    metric: CACHE_RETENTION_METRIC_ID,
    methodVersion: CACHE_RETENTION_METHOD.version,
    measures: "consecutive_requests",
    gapBasis: "response_end_to_response_end",
    windows: projected,
  };
}
