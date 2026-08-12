import { APP_PRICE_REGISTRY_MANIFEST } from "@app-usagemonitor/accounting";
import { SEVEN_DAY_WINDOW_MINUTES } from "@app-usagemonitor/quota-analysis";
import { accountScopedQuotaAnalysis } from "./quota-analysis";
import { accountScopedQuotaAnalysisV1 } from "./quota-analysis-v1";

/**
 * The community allowance series: for a UTC day, the fitted seven-day Codex
 * allowance in API-price-equivalent dollars across every qualifying reset fit
 * observed in the trailing 30 days, over all active contributing accounts.
 *
 * The estimator is NOT re-implemented here. Every fit comes from the shared
 * calibration package via `accountScopedQuotaAnalysis` — the same per-reset
 * `fitResetCapacity` gates (minimum boundaries, minimum displayed span,
 * train/holdout split, sensitivity width) that back the app's private
 * dashboard and share card. What this module adds is only the cross-account
 * day summary: median central estimate plus the middle-80% band across the
 * qualifying fits, in the same statistic family as the shared package's
 * `summarizeTrack` (median across reset fits, q10–q90 band).
 *
 * Honesty note carried into the published payload: qualification is the
 * shared package's fit gates plus a 40pp observed-span floor — the same
 * floor the app's public share card names ("40pp span") — so the published
 * community figure and the numbers people screenshot from their own app are
 * the same methodology. `spanFloorPp` carries the floor explicitly.
 *
 * Plan-cohort discipline, matching the weekly snapshots' cohort keying: an
 * allowance is a property of one plan, so mixing plan cohorts would publish
 * a median of two different products the moment a second cohort contributes.
 * The series is therefore pinned to a single declared cohort — the basis
 * string names it, the block carries `planType`/`planVariant`, and fits from
 * any other cohort never enter the corpus. Widening beyond one cohort means
 * publishing per-cohort blocks under new basis strings, never pooling.
 */

export const COMMUNITY_ALLOWANCE_BASIS = "seven_day_codex_pro20x_trailing_30d";
export const COMMUNITY_ALLOWANCE_PLAN_TYPE = "pro";
export const COMMUNITY_ALLOWANCE_PLAN_VARIANT = "pro-20x";
export const COMMUNITY_ALLOWANCE_TRAILING_DAYS = 30;
export const COMMUNITY_ALLOWANCE_QUALIFICATION =
  "shared_reset_fit_gates_40pp_span_floor";
// The same observed-span floor the app's public share card names ("40pp
// span"): short-span fits extrapolate a whole week from a sliver of quota
// movement and are the noisiest inputs to the published median, and the
// community figure must be the same methodology a reader's own app shows.
export const COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP = 40;
// Mirrors MINIMUM_RESETS_FOR_UNCERTAINTY in the shared calibration package:
// below three fits a q10–q90 band is an artifact of interpolation, not a
// spread, so the band is withheld and only the central estimate publishes.
const MINIMUM_FITS_FOR_BAND = 3;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const NANOUSD_PER_USD = 1_000_000_000;
// Bump when the v1 fit-adapter's synthesis or pricing basis changes, so a
// stale fit cache (keyed partly on this) invalidates without a chunk change.
const FIT_ADAPTER_VERSION = "v1-fit-1";

export interface CommunityAllowanceFit {
  participantId: string;
  capacityNanousd: number;
  lastObservedAt: string;
}

export interface CommunityDailyAllowance {
  basis: typeof COMMUNITY_ALLOWANCE_BASIS;
  limitId: "codex";
  planType: typeof COMMUNITY_ALLOWANCE_PLAN_TYPE;
  planVariant: typeof COMMUNITY_ALLOWANCE_PLAN_VARIANT;
  windowDurationMinutes: number;
  trailingDays: number;
  qualification: typeof COMMUNITY_ALLOWANCE_QUALIFICATION;
  spanFloorPp: typeof COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP;
  fitCount: number;
  participantCount: number;
  centralUsd: number | null;
  band80Usd: { lowerUsd: number; upperUsd: number } | null;
}

interface AnalysisResetFit {
  status?: unknown;
  limitId?: unknown;
  windowDurationMinutes?: unknown;
  capacityNanousd?: unknown;
  displayedSpanPp?: unknown;
  lastObservedAt?: unknown;
}

interface AnalysisCalibrationTrack {
  resets?: AnalysisResetFit[];
}

interface AnalysisTrack {
  continuity?: { planType?: unknown; planVariant?: unknown };
  calibration?: { tracks?: AnalysisCalibrationTrack[] };
}

interface AnalysisResult {
  status?: unknown;
  tracks?: AnalysisTrack[];
}

// Same linear-interpolation quantile as the shared calibration package uses
// for its own summaries (unexported there); duplicated deliberately so the
// published band is the same statistic the app's across-reset band uses.
function quantile(values: number[], probability: number): number | null {
  const ordered = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (ordered.length === 0) return null;
  const position = (ordered.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower]!;
  const weight = position - lower;
  return ordered[lower]! * (1 - weight) + ordered[upper]! * weight;
}

function usd(nanousd: number): number {
  // Four decimal places keeps sub-cent precision without publishing float
  // noise; canonical JSON then hashes identically across rebuilds of the
  // same sources.
  return Math.round((nanousd / NANOUSD_PER_USD + Number.EPSILON) * 10_000) / 10_000;
}

/**
 * Enumerate every active participant with a fit-capable corpus and collect
 * their qualifying seven-day Codex reset fits.
 *
 * Two corpora are fit-capable. The v0.2 contribution corpus carries server
 * pricing, track attribution, dataset, and receipt metadata at rest. The v1.0
 * chunk corpus carries none of those, so `accountScopedQuotaAnalysisV1`
 * synthesizes them server-side and reprices every usage event from tokens with
 * the same shared pricer — producing fits from exactly the same shared
 * calibration package, with ZERO new calibration math (see quota-analysis-v1.ts).
 *
 * A participant with both corpora is analyzed once, via v0.2 (MIN(source)):
 * the v0.2 rows are the richer at-rest evidence, and analyzing both would
 * double-count one account's resets. v1-source participants additionally read
 * through a cheap content-epoch fit cache, since the per-chunk read + reprice +
 * fit is the expensive part of a cron pass and only changes when the chunk
 * journal does.
 */
export async function collectCommunityAllowanceFits(
  db: D1Database,
): Promise<CommunityAllowanceFit[]> {
  const participants = await db.prepare(
    `SELECT participant_id, MIN(source) AS source
       FROM (
         SELECT c.participant_id AS participant_id, 'v0.2' AS source
           FROM telemetry_contributions c
           JOIN participants p ON p.id = c.participant_id AND p.state = 'active'
          WHERE c.status = 'accepted'
            AND c.transport_schema_version = 'telemetry-contribution-v0.2'
         UNION ALL
         SELECT c2.participant_id, 'v1' AS source
           FROM telemetry_v1_chunks c2
           JOIN participants p2 ON p2.id = c2.participant_id AND p2.state = 'active'
          WHERE c2.superseded_at IS NULL
       )
      GROUP BY participant_id
      ORDER BY participant_id`,
  ).all<{ participant_id: string; source: "v0.2" | "v1" }>();
  const fits: CommunityAllowanceFit[] = [];
  for (const row of participants.results) {
    // v1-source fit cache: reuse the last computed fits when the chunk journal
    // (count, newest created_at, revision sum) plus the pricing registry and
    // this adapter version are unchanged. A cache hit skips the read + reprice
    // + fit entirely.
    let v1CacheKey: string | null = null;
    if (row.source === "v1") {
      try {
        const epoch = await db.prepare(
          `SELECT COUNT(*) AS n,
                  COALESCE(MAX(created_at), '') AS newest,
                  COALESCE(SUM(revision), 0) AS revsum
             FROM telemetry_v1_chunks
            WHERE participant_id = ? AND superseded_at IS NULL`,
        ).bind(row.participant_id).first<{ n: number; newest: string; revsum: number }>();
        v1CacheKey = `${Number(epoch?.n ?? 0)}:${epoch?.newest ?? ""}:`
          + `${Number(epoch?.revsum ?? 0)}:${APP_PRICE_REGISTRY_MANIFEST.sha256}:`
          + `${FIT_ADAPTER_VERSION}`;
        const cached = await db.prepare(
          `SELECT fits_json FROM community_allowance_fit_cache
            WHERE participant_id = ? AND cache_key = ?`,
        ).bind(row.participant_id, v1CacheKey).first<{ fits_json: string }>();
        if (cached) {
          for (const fit of JSON.parse(cached.fits_json) as CommunityAllowanceFit[]) {
            fits.push(fit);
          }
          continue;
        }
      } catch {
        // The fit cache is a pure optimization. If it is unavailable — most
        // likely migration 0035 has not been applied to this database yet —
        // degrade to computing the fit fresh this pass rather than aborting the
        // whole community aggregate. v1CacheKey stays null so the write below is
        // skipped too, and the next pass retries the cache.
        v1CacheKey = null;
      }
    }
    const participantFits: CommunityAllowanceFit[] = [];
    try {
      const analysis = (row.source === "v1"
        ? await accountScopedQuotaAnalysisV1(db, row.participant_id)
        : await accountScopedQuotaAnalysis(db, row.participant_id)) as AnalysisResult;
      if (analysis.status === "ready" && Array.isArray(analysis.tracks)) {
        for (const track of analysis.tracks) {
          // Plan-cohort pin: fits from any other cohort are a different
          // product's allowance and must never enter this corpus (module doc).
          if (track.continuity?.planType !== COMMUNITY_ALLOWANCE_PLAN_TYPE
              || track.continuity?.planVariant !== COMMUNITY_ALLOWANCE_PLAN_VARIANT) {
            continue;
          }
          const calibrationTracks = track.calibration?.tracks;
          if (!Array.isArray(calibrationTracks)) continue;
          for (const calibrationTrack of calibrationTracks) {
            if (!Array.isArray(calibrationTrack.resets)) continue;
            for (const reset of calibrationTrack.resets) {
              if (reset.status !== "conditional_estimate"
                  || reset.limitId !== "codex"
                  || reset.windowDurationMinutes !== SEVEN_DAY_WINDOW_MINUTES
                  || typeof reset.capacityNanousd !== "number"
                  || !Number.isFinite(reset.capacityNanousd)
                  || reset.capacityNanousd <= 0
                  || typeof reset.displayedSpanPp !== "number"
                  || !Number.isFinite(reset.displayedSpanPp)
                  || reset.displayedSpanPp < COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP
                  || typeof reset.lastObservedAt !== "string"
                  || !Number.isFinite(Date.parse(reset.lastObservedAt))) {
                continue;
              }
              participantFits.push({
                participantId: row.participant_id,
                capacityNanousd: reset.capacityNanousd,
                lastObservedAt: reset.lastObservedAt,
              });
            }
          }
        }
      }
    } catch {
      // Any residual throw from a single participant's analyzer yields zero
      // fits for that participant and never aborts the whole collector.
      continue;
    }
    if (row.source === "v1" && v1CacheKey !== null) {
      try {
        await db.prepare(
          `INSERT INTO community_allowance_fit_cache (
            participant_id, cache_key, fits_json, computed_at
          ) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ON CONFLICT(participant_id) DO UPDATE SET
            cache_key = excluded.cache_key,
            fits_json = excluded.fits_json,
            computed_at = excluded.computed_at`,
        ).bind(
          row.participant_id,
          v1CacheKey,
          JSON.stringify(participantFits),
        ).run();
      } catch {
        // Best-effort cache write (see the read note above): a failure just
        // means the next pass recomputes; the fits already collected stand.
      }
    }
    for (const fit of participantFits) fits.push(fit);
  }
  // Deterministic order so identical sources canonicalize identically.
  fits.sort((left, right) => (
    left.lastObservedAt.localeCompare(right.lastObservedAt)
    || left.capacityNanousd - right.capacityNanousd
    || left.participantId.localeCompare(right.participantId)
  ));
  return fits;
}

/**
 * Pure day summary. A fit qualifies for day D when its `lastObservedAt` falls
 * in the half-open trailing window (end-of-D minus 30 days, end-of-D]: the
 * fit had fully materialized by the end of that day and is at most 30 days
 * stale. A day with zero qualifying fits still publishes the block — fitCount
 * 0 with null estimates is the honest "no estimate yet", distinct from an
 * older revision that predates the series entirely.
 */
export function summarizeCommunityAllowanceDay(
  fits: readonly CommunityAllowanceFit[],
  day: string,
): CommunityDailyAllowance {
  const dayStartMs = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(dayStartMs)) {
    throw new Error("invalid community allowance day");
  }
  const windowEndMs = dayStartMs + MILLISECONDS_PER_DAY;
  const windowStartMs = windowEndMs
    - COMMUNITY_ALLOWANCE_TRAILING_DAYS * MILLISECONDS_PER_DAY;
  const qualifying = fits.filter((fit) => {
    const observedMs = Date.parse(fit.lastObservedAt);
    return observedMs > windowStartMs && observedMs <= windowEndMs;
  });
  const capacities = qualifying.map((fit) => fit.capacityNanousd);
  const central = quantile(capacities, 0.5);
  const lower = quantile(capacities, 0.1);
  const upper = quantile(capacities, 0.9);
  return {
    basis: COMMUNITY_ALLOWANCE_BASIS,
    limitId: "codex",
    planType: COMMUNITY_ALLOWANCE_PLAN_TYPE,
    planVariant: COMMUNITY_ALLOWANCE_PLAN_VARIANT,
    windowDurationMinutes: SEVEN_DAY_WINDOW_MINUTES,
    trailingDays: COMMUNITY_ALLOWANCE_TRAILING_DAYS,
    qualification: COMMUNITY_ALLOWANCE_QUALIFICATION,
    spanFloorPp: COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP,
    fitCount: qualifying.length,
    participantCount: new Set(qualifying.map((fit) => fit.participantId)).size,
    centralUsd: central === null ? null : usd(central),
    band80Usd: qualifying.length >= MINIMUM_FITS_FOR_BAND
        && lower !== null && upper !== null
      ? { lowerUsd: usd(lower), upperUsd: usd(upper) }
      : null,
  };
}
