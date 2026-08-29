import { APP_PRICE_REGISTRY_MANIFEST } from "@app-usagemonitor/accounting";
import {
  MODEL_COMPOSITION_POLICY,
  SEVEN_DAY_WINDOW_MINUTES,
} from "@app-usagemonitor/quota-analysis";
import { accountScopedQuotaAnalysis } from "./quota-analysis";
import {
  V1_ANALYSIS_WINDOW_DAYS,
  accountScopedQuotaAnalysisV1WithComposition,
} from "./quota-analysis-v1";
import type { V1ModelCompositionObservation } from "./quota-analysis-v1";
import { SERVER_PRICING_METHOD_VERSION } from "./server-pricing";

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
 * Personal-plan fits are normalized to one Pro 20x-equivalent basis before
 * they are combined. This is the same deliberately narrow merge trial shown
 * in the private admin dashboard: Pro stays unchanged, Pro 5x is multiplied
 * by four, and Plus by twenty. Unsupported or unknown plan labels do not enter
 * the estimate. The public wire carries only the resulting combined summary;
 * plan-specific diagnostics remain private admin evidence.
 */

export const COMMUNITY_ALLOWANCE_BASIS =
  "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d";
export const COMMUNITY_ALLOWANCE_REFERENCE_PLAN_TYPE = "pro";
export const COMMUNITY_ALLOWANCE_NORMALIZATION =
  "pro_x1_prolite_x4_plus_x20";
export const COMMUNITY_ALLOWANCE_TRAILING_DAYS = 30;
export const COMMUNITY_ALLOWANCE_RECONSTRUCTABLE_DAYS =
  V1_ANALYSIS_WINDOW_DAYS - COMMUNITY_ALLOWANCE_TRAILING_DAYS;
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
// Bump when the v1 fit-adapter's synthesis, pricing basis, or cohort
// definition changes, so a stale fit cache (keyed partly on this) invalidates
// without a chunk change. v1-fit-2: cohort by plan_type alone (dropped the
// synthesized pro-20x variant pin). v1-fit-3: derive totalInputContextTokens
// for v1 usage (records carry it null) + drop no-observation records, so the
// OpenAI context-sensitive pricer no longer refuses every reset. v1-fit-6 adds
// bounded model-composition observations, the explicit server-pricing method
// key, and the Sol Work Mode alias policy used by the admin estimator.
// v1-fit-7 preserves the personal-plan era on every observation so the admin
// estimator can normalize Pro, ProLite, and Plus rows before fitting.
// v1-fit-8 binds the scalar-source choice into the cache key so a participant
// switching between dual-source/v0.2 and v1-only evidence cannot reuse scalar
// fits produced by the other source.
const FIT_ADAPTER_VERSION =
  "v1-fit-8-personal-plan-model-composition-source-key";
const MAX_MODEL_OBSERVATIONS_PER_PARTICIPANT = 10_000;
const MAX_MODEL_OBSERVATIONS_JSON_BYTES = 512 * 1_024;

export const COMMUNITY_ALLOWANCE_PERSONAL_PLAN_CONFIG = Object.freeze([
  Object.freeze({ planType: "pro", label: "Pro 20x", multiplier: 1 }),
  Object.freeze({ planType: "prolite", label: "Pro 5x", multiplier: 4 }),
  Object.freeze({ planType: "plus", label: "Plus", multiplier: 20 }),
] as const);

export type CommunityAllowancePersonalPlanType =
  (typeof COMMUNITY_ALLOWANCE_PERSONAL_PLAN_CONFIG)[number]["planType"];

const COMMUNITY_ALLOWANCE_PERSONAL_PLAN_BY_TYPE = new Map<string, {
  readonly planType: CommunityAllowancePersonalPlanType;
  readonly label: string;
  readonly multiplier: number;
}>(COMMUNITY_ALLOWANCE_PERSONAL_PLAN_CONFIG.map((plan) => [
  plan.planType,
  plan,
]));

// One canonical source-selection CTE feeds both the scheduled collector and
// the admin cache reader. Scalar allowance fits retain v0.2 precedence, while
// `has_v1` independently records whether current v1 chunks can contribute
// model-composition evidence. Keeping both decisions in one CTE prevents dual
// contributors from disappearing from the model corpus.
const COMMUNITY_ALLOWANCE_PARTICIPANT_SOURCES_CTE = `participant_sources AS (
  SELECT participant_id,
         CASE WHEN MAX(has_v02) = 1 THEN 'v0.2' ELSE 'v1' END AS source,
         MAX(has_v1) AS has_v1
    FROM (
      SELECT c.participant_id AS participant_id, 1 AS has_v02, 0 AS has_v1
        FROM telemetry_contributions c
        JOIN participants p ON p.id = c.participant_id AND p.state = 'active'
       WHERE c.status = 'accepted'
         AND c.transport_schema_version = 'telemetry-contribution-v0.2'
      UNION ALL
      SELECT c2.participant_id, 0 AS has_v02, 1 AS has_v1
        FROM telemetry_v1_chunks c2
        JOIN participants p2 ON p2.id = c2.participant_id AND p2.state = 'active'
       WHERE c2.superseded_at IS NULL
    )
   GROUP BY participant_id
)`;

export interface CommunityAllowanceFit {
  participantId: string;
  // The Codex plan_type this fit was observed on (pro, prolite, plus, ...).
  // The public summary admits only the explicitly configured personal plans
  // and normalizes them to the reference plan; no separate variant is needed.
  planType: string;
  capacityNanousd: number;
  lastObservedAt: string;
}

export interface CommunityModelCompositionObservation
  extends V1ModelCompositionObservation {
  readonly participantId: string;
}

export interface CommunityDailyAllowance {
  basis: typeof COMMUNITY_ALLOWANCE_BASIS;
  limitId: "codex";
  referencePlanType: typeof COMMUNITY_ALLOWANCE_REFERENCE_PLAN_TYPE;
  normalization: typeof COMMUNITY_ALLOWANCE_NORMALIZATION;
  windowDurationMinutes: number;
  trailingDays: number;
  qualification: typeof COMMUNITY_ALLOWANCE_QUALIFICATION;
  spanFloorPp: typeof COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP;
  fitCount: number;
  participantCount: number;
  centralUsd: number | null;
  band80Usd: { lowerUsd: number; upperUsd: number } | null;
}

export interface CommunityAllowanceSummary {
  readonly fitCount: number;
  readonly participantCount: number;
  readonly centralUsd: number | null;
  readonly band80Usd: {
    readonly lowerUsd: number;
    readonly upperUsd: number;
  } | null;
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

function parseCachedModelObservations(
  value: string,
  participantId: string,
): CommunityModelCompositionObservation[] | null {
  if (new TextEncoder().encode(value).byteLength
      > MAX_MODEL_OBSERVATIONS_JSON_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)
      || parsed.length > MAX_MODEL_OBSERVATIONS_PER_PARTICIPANT) return null;
  const result: CommunityModelCompositionObservation[] = [];
  let priorBinStartMs = Number.NEGATIVE_INFINITY;
  for (const candidate of parsed) {
    if (typeof candidate !== "object" || candidate === null
        || Array.isArray(candidate)) return null;
    const observation = candidate as Record<string, unknown>;
    const plan = COMMUNITY_ALLOWANCE_PERSONAL_PLAN_BY_TYPE.get(
      typeof observation.planType === "string" ? observation.planType : "",
    );
    if (Object.keys(observation).sort().join(",")
          !== "binStartMs,costByModel,participantId,planType,ppDelta"
        || observation.participantId !== participantId
        || plan === undefined
        || typeof observation.binStartMs !== "number"
        || !Number.isSafeInteger(observation.binStartMs)
        || observation.binStartMs % MODEL_COMPOSITION_POLICY.grainMs !== 0
        || observation.binStartMs <= priorBinStartMs
        || typeof observation.ppDelta !== "number"
        || !Number.isFinite(observation.ppDelta)
        || observation.ppDelta <= 0
        || typeof observation.costByModel !== "object"
        || observation.costByModel === null
        || Array.isArray(observation.costByModel)) return null;
    const costs: Record<string, number> = {};
    let totalCost = 0;
    for (const [modelId, cost] of Object.entries(
      observation.costByModel as Record<string, unknown>,
    )) {
      if (modelId.length === 0 || modelId.length > 128
          || typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
        return null;
      }
      costs[modelId] = cost;
      totalCost += cost;
    }
    if (!(totalCost > 0)) return null;
    priorBinStartMs = observation.binStartMs;
    result.push({
      participantId,
      planType: plan.planType,
      binStartMs: observation.binStartMs,
      ppDelta: observation.ppDelta,
      costByModel: Object.freeze(costs),
    });
  }
  return result;
}

function parseCachedFits(
  value: string,
  participantId: string,
): CommunityAllowanceFit[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const fits: CommunityAllowanceFit[] = [];
  for (const candidate of parsed) {
    if (typeof candidate !== "object" || candidate === null
        || Array.isArray(candidate)) return null;
    const fit = candidate as Record<string, unknown>;
    if (Object.keys(fit).sort().join(",")
          !== "capacityNanousd,lastObservedAt,participantId,planType"
        || fit.participantId !== participantId
        || typeof fit.planType !== "string"
        || fit.planType.length === 0
        || typeof fit.capacityNanousd !== "number"
        || !Number.isFinite(fit.capacityNanousd)
        || fit.capacityNanousd <= 0
        || typeof fit.lastObservedAt !== "string"
        || !Number.isFinite(Date.parse(fit.lastObservedAt))) return null;
    fits.push({
      participantId,
      planType: fit.planType,
      capacityNanousd: fit.capacityNanousd,
      lastObservedAt: fit.lastObservedAt,
    });
  }
  return fits;
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
 * Shared summary primitive for the public combined series and the private
 * admin comparison. Keeping the quantiles and currency rounding here ensures
 * the two views cannot silently diverge while the merge is reviewed.
 */
export function summarizeCommunityAllowanceFits(
  fits: readonly CommunityAllowanceFit[],
  multiplier: number | ((fit: CommunityAllowanceFit) => number),
): CommunityAllowanceSummary {
  const capacities = fits.map((fit) => {
    const factor = typeof multiplier === "function" ? multiplier(fit) : multiplier;
    return fit.capacityNanousd * factor;
  });
  const central = quantile(capacities, 0.5);
  const lower = quantile(capacities, 0.1);
  const upper = quantile(capacities, 0.9);
  return Object.freeze({
    fitCount: fits.length,
    participantCount: new Set(fits.map((fit) => fit.participantId)).size,
    centralUsd: central === null ? null : usd(central),
    band80Usd: fits.length >= MINIMUM_FITS_FOR_BAND
        && lower !== null && upper !== null
      ? Object.freeze({ lowerUsd: usd(lower), upperUsd: usd(upper) })
      : null,
  });
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
 * A participant with both corpora keeps v0.2 as the scalar-fit source so one
 * account's resets are not double-counted, but its current v1 chunks are still
 * analyzed exactly once for model composition. Every participant with v1
 * chunks reads that composition through the cheap content-epoch cache; pure-v1
 * participants can reuse their scalar fits from the same row too.
 */
export async function collectCommunityAllowanceCorpus(
  db: D1Database,
  nowMs: number = Date.now(),
): Promise<CachedCommunityAllowanceCorpus> {
  const participants = await db.prepare(
    `WITH ${COMMUNITY_ALLOWANCE_PARTICIPANT_SOURCES_CTE}
     SELECT participant_id, source, has_v1
       FROM participant_sources
      ORDER BY participant_id`,
  ).all<{
    participant_id: string;
    source: "v0.2" | "v1";
    has_v1: number;
  }>();
  const fits: CommunityAllowanceFit[] = [];
  const modelObservations: CommunityModelCompositionObservation[] = [];
  const participantIds = participants.results.map((row) => row.participant_id);
  for (const row of participants.results) {
    // Every participant with current v1 chunks may reuse model observations
    // when the chunk journal (count, newest created_at, revision sum), pricing
    // registry, and adapter are unchanged. A pure-v1 source can reuse scalar
    // fits from the same row; a dual source still recomputes its v0.2 scalar fit.
    let v1CacheKey: string | null = null;
    let cachedModelObservations:
      CommunityModelCompositionObservation[] | null = null;
    if (row.has_v1 === 1) {
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
          + `${SERVER_PRICING_METHOD_VERSION}:${FIT_ADAPTER_VERSION}:`
          + `${row.source}`;
        const cached = await db.prepare(
          `SELECT fits_json, model_observations_json
             FROM community_allowance_fit_cache
            WHERE participant_id = ? AND cache_key = ?`,
        ).bind(row.participant_id, v1CacheKey).first<{
          fits_json: string;
          model_observations_json: string | null;
        }>();
        const cachedFits = cached && typeof cached.fits_json === "string"
          ? parseCachedFits(cached.fits_json, row.participant_id)
          : null;
        cachedModelObservations = cached
            && typeof cached.model_observations_json === "string"
          ? parseCachedModelObservations(
              cached.model_observations_json,
              row.participant_id,
            )
          : null;
        if (row.source === "v1"
            && cachedFits !== null && cachedModelObservations !== null) {
          fits.push(...cachedFits);
          modelObservations.push(...cachedModelObservations);
          continue;
        }
      } catch {
        // The fit cache is a pure optimization. If it is unavailable — most
        // likely migration 0035 has not been applied to this database yet —
        // degrade to computing the fit fresh this pass rather than aborting the
        // whole community aggregate. v1CacheKey stays null so the write below is
        // skipped too, and the next pass retries the cache.
        v1CacheKey = null;
        cachedModelObservations = null;
      }
    }
    const participantFits: CommunityAllowanceFit[] = [];
    let participantModelObservations = cachedModelObservations ?? [];
    let modelEvidenceAvailable = cachedModelObservations !== null;
    let scalarAnalysisSucceeded = false;
    let analysis: AnalysisResult | null = null;
    if (row.source === "v1") {
      try {
        const result = await accountScopedQuotaAnalysisV1WithComposition(
          db,
          row.participant_id,
          { nowMs },
        );
        analysis = result.analysis as AnalysisResult;
        scalarAnalysisSucceeded = true;
        participantModelObservations = result.compositionObservations.map(
          (observation) => ({
            participantId: row.participant_id,
            ...observation,
          }),
        );
        modelEvidenceAvailable = true;
      } catch {
        // One participant contributes neither scalar nor freshly computed model
        // evidence on this pass. A previously validated model cache may still
        // contribute without inventing a scalar fit.
      }
    } else {
      try {
        analysis = await accountScopedQuotaAnalysis(
          db,
          row.participant_id,
        ) as AnalysisResult;
        scalarAnalysisSucceeded = true;
      } catch {
        // Scalar v0.2 evidence is independent from current v1 composition.
      }
      if (row.has_v1 === 1 && cachedModelObservations === null) {
        try {
          const result = await accountScopedQuotaAnalysisV1WithComposition(
            db,
            row.participant_id,
            { nowMs },
          );
          participantModelObservations = result.compositionObservations.map(
            (observation) => ({
              participantId: row.participant_id,
              ...observation,
            }),
          );
          modelEvidenceAvailable = true;
        } catch {
          // The v0.2 scalar fit may still contribute; model evidence remains
          // explicitly absent for this participant on this pass.
        }
      }
    }
    if (analysis?.status === "ready" && Array.isArray(analysis.tracks)) {
      for (const track of analysis.tracks) {
        // The collector gathers qualifying fits for EVERY plan_type, each
        // tagged with its plan (the Codex plan IS the plan + multiplier:
        // pro = 20x, prolite = 5x; the "variant" is not a real distinction —
        // real v1 uploads carry planVariant "unknown"). The published
        // allowance band filters to plan_type "pro" in
        // summarizeCommunityAllowanceDay; the full set also feeds the
        // per-plan_type capacity monitor. A missing/blank plan_type can seed
        // no cohort, so it is skipped.
        const trackPlanType = track.continuity?.planType;
        if (typeof trackPlanType !== "string" || trackPlanType.length === 0) {
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
              planType: trackPlanType,
              capacityNanousd: reset.capacityNanousd,
              lastObservedAt: reset.lastObservedAt,
            });
          }
        }
      }
    }
    if (row.has_v1 === 1 && v1CacheKey !== null && modelEvidenceAvailable
        && (row.source === "v0.2" || scalarAnalysisSucceeded)) {
      try {
        const observationsJson = JSON.stringify(participantModelObservations);
        if (participantModelObservations.length
              > MAX_MODEL_OBSERVATIONS_PER_PARTICIPANT
            || new TextEncoder().encode(observationsJson).byteLength
              > MAX_MODEL_OBSERVATIONS_JSON_BYTES) {
          throw new RangeError("model composition cache exceeds bounded size");
        }
        await db.prepare(
          `INSERT INTO community_allowance_fit_cache (
            participant_id, cache_key, fits_json, model_observations_json,
            computed_at
          ) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ON CONFLICT(participant_id) DO UPDATE SET
            cache_key = excluded.cache_key,
            fits_json = excluded.fits_json,
            model_observations_json = excluded.model_observations_json,
            computed_at = excluded.computed_at`,
        ).bind(
          row.participant_id,
          v1CacheKey,
          JSON.stringify(participantFits),
          observationsJson,
        ).run();
      } catch {
        // Best-effort cache write (see the read note above): a failure just
        // means the next pass recomputes; the fits already collected stand.
      }
    }
    for (const fit of participantFits) fits.push(fit);
    modelObservations.push(...participantModelObservations);
  }
  // Deterministic order so identical sources canonicalize identically.
  fits.sort((left, right) => (
    left.lastObservedAt.localeCompare(right.lastObservedAt)
    || left.capacityNanousd - right.capacityNanousd
    || left.participantId.localeCompare(right.participantId)
  ));
  modelObservations.sort((left, right) => (
    left.binStartMs - right.binStartMs
    || left.planType.localeCompare(right.planType)
    || left.participantId.localeCompare(right.participantId)
  ));
  return Object.freeze({
    participantIds: Object.freeze([...participantIds].sort()),
    fits: Object.freeze(fits),
    modelObservations: Object.freeze(modelObservations),
  });
}

/** Compatibility projection for public daily aggregation consumers. */
export async function collectCommunityAllowanceFits(
  db: D1Database,
  nowMs: number = Date.now(),
): Promise<CommunityAllowanceFit[]> {
  const corpus = await collectCommunityAllowanceCorpus(db, nowMs);
  return [...corpus.fits];
}

interface CachedCommunityAllowanceFitRow {
  participant_id: string;
  source: "v0.2" | "v1";
  has_v1: number;
  expected_cache_key: string | null;
  cache_key: string | null;
  fits_json: string | null;
  model_observations_json: string | null;
}

/**
 * Fully validated, cache-backed fit evidence for the active uploading cohort.
 * Participant identifiers stay inside Worker code; callers must project only
 * aggregate counts before returning anything to a browser.
 */
export interface CachedCommunityAllowanceCorpus {
  readonly participantIds: readonly string[];
  readonly fits: readonly CommunityAllowanceFit[];
  readonly modelObservations:
    readonly CommunityModelCompositionObservation[];
}

/**
 * Read the validated fit-cache corpus for scheduled aggregate construction
 * without invoking either raw-corpus analyzer or issuing a database mutation.
 *
 * The single SELECT verifies each active participant's cheap chunk epoch
 * against the same registry + adapter cache key used by the scheduled
 * collector. `has_v1` keeps the composition-cache epoch independent from the
 * scalar source choice. Missing/stale v1 rows and v0.2-selected participants
 * still fail closed as a complete corpus: v0.2 scalar evidence requires raw
 * analysis and this SELECT-only source cannot substitute that work. Browser
 * routes must read their own aggregate singleton instead; the scheduled
 * aggregate builder remains the sole fit-cache warmer and keeps its existing
 * best-effort INSERT behaviour.
 */
export async function readCachedCommunityAllowanceCorpus(
  db: D1Database,
): Promise<CachedCommunityAllowanceCorpus | null> {
  let rows: CachedCommunityAllowanceFitRow[];
  try {
    const result = await db.prepare(
      `WITH ${COMMUNITY_ALLOWANCE_PARTICIPANT_SOURCES_CTE},
       v1_epochs AS (
         SELECT sources.participant_id,
                CAST(COUNT(chunks.participant_id) AS TEXT)
                  || ':' || COALESCE(MAX(chunks.created_at), '')
                  || ':' || CAST(COALESCE(SUM(chunks.revision), 0) AS TEXT)
                  || ':' || ? || ':' || ? || ':' || ?
                  || ':' || sources.source AS expected_cache_key
           FROM participant_sources sources
           LEFT JOIN telemetry_v1_chunks chunks
             ON chunks.participant_id = sources.participant_id
            AND chunks.superseded_at IS NULL
          WHERE sources.has_v1 = 1
          GROUP BY sources.participant_id
       )
       SELECT sources.participant_id,
              sources.source,
              sources.has_v1,
              epochs.expected_cache_key,
              cache.cache_key,
              cache.fits_json,
              cache.model_observations_json
         FROM participant_sources sources
         LEFT JOIN v1_epochs epochs
           ON epochs.participant_id = sources.participant_id
         LEFT JOIN community_allowance_fit_cache cache
           ON cache.participant_id = sources.participant_id
        ORDER BY sources.participant_id`,
    ).bind(
      APP_PRICE_REGISTRY_MANIFEST.sha256,
      SERVER_PRICING_METHOD_VERSION,
      FIT_ADAPTER_VERSION,
    ).all<CachedCommunityAllowanceFitRow>();
    if (!Array.isArray(result.results)) return null;
    rows = result.results;
  } catch {
    // A missing cache table or failed SELECT is an unavailable preview, never
    // permission to fall through to raw analysis from an interactive request.
    return null;
  }

  const participants = new Set<string>();
  const fits: CommunityAllowanceFit[] = [];
  const modelObservations: CommunityModelCompositionObservation[] = [];
  for (const row of rows) {
    if (typeof row.participant_id !== "string"
        || row.participant_id.length === 0
        || participants.has(row.participant_id)
        || row.source !== "v1"
        || row.has_v1 !== 1
        || typeof row.expected_cache_key !== "string"
        || row.expected_cache_key.length === 0
        || row.cache_key !== row.expected_cache_key
        || typeof row.fits_json !== "string"
        || typeof row.model_observations_json !== "string") {
      return null;
    }
    participants.add(row.participant_id);
    const participantFits = parseCachedFits(
      row.fits_json,
      row.participant_id,
    );
    if (participantFits === null) return null;
    fits.push(...participantFits);
    const participantModelObservations = parseCachedModelObservations(
      row.model_observations_json,
      row.participant_id,
    );
    if (participantModelObservations === null) return null;
    modelObservations.push(...participantModelObservations);
  }
  fits.sort((left, right) => (
    left.lastObservedAt.localeCompare(right.lastObservedAt)
    || left.capacityNanousd - right.capacityNanousd
    || left.participantId.localeCompare(right.participantId)
  ));
  modelObservations.sort((left, right) => (
    left.binStartMs - right.binStartMs
    || left.planType.localeCompare(right.planType)
    || left.participantId.localeCompare(right.participantId)
  ));
  return Object.freeze({
    participantIds: Object.freeze([...participants].sort()),
    fits: Object.freeze(fits),
    modelObservations: Object.freeze(modelObservations),
  });
}

/**
 * Compatibility projection for existing scheduled/public aggregation code.
 * It deliberately delegates to the corpus reader so there remains one cache
 * validation and source-selection contract.
 */
export async function readCachedCommunityAllowanceFits(
  db: D1Database,
): Promise<CommunityAllowanceFit[] | null> {
  const corpus = await readCachedCommunityAllowanceCorpus(db);
  return corpus === null ? null : [...corpus.fits];
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
    if (!COMMUNITY_ALLOWANCE_PERSONAL_PLAN_BY_TYPE.has(fit.planType)) return false;
    const observedMs = Date.parse(fit.lastObservedAt);
    return observedMs > windowStartMs && observedMs <= windowEndMs;
  });
  const summary = summarizeCommunityAllowanceFits(qualifying, (fit) => (
    COMMUNITY_ALLOWANCE_PERSONAL_PLAN_BY_TYPE.get(fit.planType)?.multiplier
      ?? 0
  ));
  return {
    basis: COMMUNITY_ALLOWANCE_BASIS,
    limitId: "codex",
    referencePlanType: COMMUNITY_ALLOWANCE_REFERENCE_PLAN_TYPE,
    normalization: COMMUNITY_ALLOWANCE_NORMALIZATION,
    windowDurationMinutes: SEVEN_DAY_WINDOW_MINUTES,
    trailingDays: COMMUNITY_ALLOWANCE_TRAILING_DAYS,
    qualification: COMMUNITY_ALLOWANCE_QUALIFICATION,
    spanFloorPp: COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP,
    ...summary,
  };
}

export interface CommunityPlanCapacity {
  medianCapacityNanousd: number;
  participantCount: number;
  fitCount: number;
}

// Keyed by Codex plan_type (pro, prolite, plus, ...). Additive observability
// block; never gates the published allowance band.
export type CommunityCapacityByPlanType = Record<string, CommunityPlanCapacity>;

/**
 * Additive observability: the median observed seven-day capacity per plan_type
 * over the SAME trailing-30d window and fit gates as the published band. It lets
 * the pro:prolite:plus capacity ratios be watched at READ time against the
 * plans' stated multipliers (pro = 20x, prolite = 5x, so pro:prolite ~= 4x).
 * A sustained divergence flags plan_type mislabeling at the source or an OpenAI
 * multiplier change — the signal the retired plan-timeline guesswork used to
 * (badly) approximate. Ratios are never stored (only per-plan medians), so no
 * multiplier belief is baked into the wire. Keys are sorted so identical inputs
 * canonicalize identically.
 */
export function summarizeCommunityCapacityByPlanType(
  fits: readonly CommunityAllowanceFit[],
  day: string,
): CommunityCapacityByPlanType {
  const dayStartMs = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(dayStartMs)) {
    throw new Error("invalid community allowance day");
  }
  const windowEndMs = dayStartMs + MILLISECONDS_PER_DAY;
  const windowStartMs = windowEndMs
    - COMMUNITY_ALLOWANCE_TRAILING_DAYS * MILLISECONDS_PER_DAY;
  const byPlanType = new Map<string, CommunityAllowanceFit[]>();
  for (const fit of fits) {
    const observedMs = Date.parse(fit.lastObservedAt);
    if (!(observedMs > windowStartMs && observedMs <= windowEndMs)) continue;
    const bucket = byPlanType.get(fit.planType);
    if (bucket) bucket.push(fit);
    else byPlanType.set(fit.planType, [fit]);
  }
  const result: CommunityCapacityByPlanType = {};
  for (const planType of [...byPlanType.keys()].sort()) {
    const bucket = byPlanType.get(planType) ?? [];
    const median = quantile(bucket.map((fit) => fit.capacityNanousd), 0.5);
    result[planType] = {
      medianCapacityNanousd: median === null ? 0 : Math.round(median),
      participantCount: new Set(bucket.map((fit) => fit.participantId)).size,
      fitCount: bucket.length,
    };
  }
  return result;
}
