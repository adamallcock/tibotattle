import { SEVEN_DAY_WINDOW_MINUTES } from "@app-usagemonitor/quota-analysis";
import { accountScopedQuotaAnalysis } from "./quota-analysis";

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
 * shared package's fit gates with no display-side span floor (the app's
 * allowance page applies an additional 50pp floor at render time; this series
 * publishes `spanFloorPp: 0` so the two counts are never conflated).
 */

export const COMMUNITY_ALLOWANCE_BASIS = "seven_day_codex_trailing_30d";
export const COMMUNITY_ALLOWANCE_TRAILING_DAYS = 30;
export const COMMUNITY_ALLOWANCE_QUALIFICATION =
  "shared_reset_fit_gates_no_span_floor";
// Mirrors MINIMUM_RESETS_FOR_UNCERTAINTY in the shared calibration package:
// below three fits a q10–q90 band is an artifact of interpolation, not a
// spread, so the band is withheld and only the central estimate publishes.
const MINIMUM_FITS_FOR_BAND = 3;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const NANOUSD_PER_USD = 1_000_000_000;

export interface CommunityAllowanceFit {
  participantId: string;
  capacityNanousd: number;
  lastObservedAt: string;
}

export interface CommunityDailyAllowance {
  basis: typeof COMMUNITY_ALLOWANCE_BASIS;
  limitId: "codex";
  windowDurationMinutes: number;
  trailingDays: number;
  qualification: typeof COMMUNITY_ALLOWANCE_QUALIFICATION;
  spanFloorPp: 0;
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
  lastObservedAt?: unknown;
}

interface AnalysisCalibrationTrack {
  resets?: AnalysisResetFit[];
}

interface AnalysisTrack {
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
 * Enumerate every active participant with accepted v0.2 contributions and
 * collect their qualifying seven-day Codex reset fits. The v0.2 corpus is the
 * only fit-capable corpus today: v1 chunks carry no server pricing, track
 * attribution, or receipt metadata, all hard-required by the shared fit
 * validators. When v1 grows those fields this collector is the single seam to
 * retarget.
 */
export async function collectCommunityAllowanceFits(
  db: D1Database,
): Promise<CommunityAllowanceFit[]> {
  const participants = await db.prepare(
    `SELECT DISTINCT c.participant_id AS participant_id
       FROM telemetry_contributions c
       JOIN participants p ON p.id = c.participant_id AND p.state = 'active'
      WHERE c.status = 'accepted'
        AND c.transport_schema_version = 'telemetry-contribution-v0.2'
      ORDER BY c.participant_id`,
  ).all<{ participant_id: string }>();
  const fits: CommunityAllowanceFit[] = [];
  for (const row of participants.results) {
    const analysis = await accountScopedQuotaAnalysis(
      db,
      row.participant_id,
    ) as AnalysisResult;
    if (analysis.status !== "ready" || !Array.isArray(analysis.tracks)) continue;
    for (const track of analysis.tracks) {
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
              || typeof reset.lastObservedAt !== "string"
              || !Number.isFinite(Date.parse(reset.lastObservedAt))) {
            continue;
          }
          fits.push({
            participantId: row.participant_id,
            capacityNanousd: reset.capacityNanousd,
            lastObservedAt: reset.lastObservedAt,
          });
        }
      }
    }
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
    windowDurationMinutes: SEVEN_DAY_WINDOW_MINUTES,
    trailingDays: COMMUNITY_ALLOWANCE_TRAILING_DAYS,
    qualification: COMMUNITY_ALLOWANCE_QUALIFICATION,
    spanFloorPp: 0,
    fitCount: qualifying.length,
    participantCount: new Set(qualifying.map((fit) => fit.participantId)).size,
    centralUsd: central === null ? null : usd(central),
    band80Usd: qualifying.length >= MINIMUM_FITS_FOR_BAND
        && lower !== null && upper !== null
      ? { lowerUsd: usd(lower), upperUsd: usd(upper) }
      : null,
  };
}
