import { APP_PRICE_REGISTRY_MANIFEST } from "@app-usagemonitor/accounting";
import { PLAN_ATTRIBUTION_POLICY, SEVEN_DAY_WINDOW_MINUTES } from "@app-usagemonitor/quota-analysis";
import { accountScopedQuotaAnalysis } from "./quota-analysis";
import {
  V1_ANALYSIS_WINDOW_DAYS,
  V1_PLAN_ATTRIBUTION_ADAPTER_VERSION,
  accountScopedModelCompositionV1,
  accountScopedQuotaAnalysisV1,
} from "./quota-analysis-v1";
import type {
  V1ModelComposition,
  V1ModelCompositionResult,
} from "./quota-analysis-v1";
import { SERVER_PRICING_METHOD_VERSION } from "./server-pricing";
import {
  V1_SOURCE_SELECTION_METHOD_VERSION,
  assertV1SourcePinCurrent,
  loadV1SourcePin,
} from "./telemetry-v1-source-selection";
import type { V1SourcePin } from "./telemetry-v1-source-selection";
import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import { accountScopedModelCompositionV11, accountScopedQuotaAnalysisV11,
  V11_PLAN_ATTRIBUTION_ADAPTER_VERSION } from "./quota-analysis-v11";
import { assertV11SourcePinCurrent, loadV11SourcePin, V11_DOMAIN_METHOD_VERSION,
  type V11SourcePin } from "./telemetry-v11-domain";

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
// OpenAI context-sensitive pricer no longer refuses every reset. v1-fit-6:
// Codex subscription Fast events price at the published Priority (Fast) API
// rate via the speed ratio (server pricing v0.3), so fits move to the
// speed-priced basis; the server pricing method version also joins the cache
// key so future pricing-semantics changes self-invalidate.
const FIT_ADAPTER_VERSION = "v1-fit-7";
export const COMMUNITY_ATTRIBUTION_METHOD_VERSION =
  [PLAN_ATTRIBUTION_POLICY.methodVersion, V1_SOURCE_SELECTION_METHOD_VERSION,
    V1_PLAN_ATTRIBUTION_ADAPTER_VERSION, V11_PLAN_ATTRIBUTION_ADAPTER_VERSION,
    V11_DOMAIN_METHOD_VERSION].join(":");
// The tail of every v1 fit-cache key beyond the participant's chunk epoch.
// One constant serves the writer and both readers so they can never diverge
// (a 2026-08-30 regression had the corpus reader expecting one fewer segment,
// which starved the admin allowance preview).
const V1_FIT_CACHE_KEY_SUFFIX =
  `${APP_PRICE_REGISTRY_MANIFEST.sha256}:${FIT_ADAPTER_VERSION}:${SERVER_PRICING_METHOD_VERSION}:${COMMUNITY_ATTRIBUTION_METHOD_VERSION}`;

function analysisFromDay(nowMs: number): string {
  if (!Number.isFinite(nowMs)) throw new TypeError("analysis time invalid");
  return new Date(nowMs - V1_ANALYSIS_WINDOW_DAYS * MILLISECONDS_PER_DAY)
    .toISOString().slice(0, 10);
}

type LegacySource = "v0.2" | "v1" | "mixed" | "v1.1";
type CommunitySourcePin = V1SourcePin | V11SourcePin;

function isV11Pin(pin: CommunitySourcePin): pin is V11SourcePin {
  return "source" in pin && pin.source === "v1.1";
}

async function assertCommunitySourcePinCurrent(db: D1Database, pin: CommunitySourcePin): Promise<void> {
  if (isV11Pin(pin)) await assertV11SourcePinCurrent(db, pin);
  else await assertV1SourcePinCurrent(db, pin);
}

function sourceCacheKey(pin: CommunitySourcePin, fromDay: string, suffix: string, source: LegacySource = "v1"): string {
  if (!Number.isSafeInteger(pin.inputRevision) || pin.inputRevision! < 0) {
    throw new Error("analytical input revision unavailable");
  }
  return `${source}:${pin.inputRevision}:${fromDay}:${suffix}`;
}

async function loadCommunitySourcePin(db: D1Database, participantId: string, fromDay: string, source: LegacySource) {
  if (source === "v1.1") {
    const sourcePin = await loadV11SourcePin(db, participantId, {fromDay});
    if (!sourcePin) throw new Error("activated attribution source unavailable");
    return {sourcePin, fingerprint: sourcePin.fingerprint};
  }
  const sourcePin = await loadV1SourcePin(db, { participantId, fromDay });
  const legacy = await db.prepare(`SELECT id, plaintext_digest, envelope_digest, dataset_id,
      range_start, range_end, created_at FROM telemetry_contributions
    WHERE participant_id = ? AND status = 'accepted'
      AND transport_schema_version = 'telemetry-contribution-v0.2'
    ORDER BY id LIMIT 101`).bind(participantId).all<Record<string, unknown>>();
  if (legacy.results.length > 100) throw new Error("legacy source vector limit exceeded");
  await assertV1SourcePinCurrent(db, sourcePin);
  const fingerprint = await sha256Hex(canonicalJson({
    methodVersion: COMMUNITY_ATTRIBUTION_METHOD_VERSION,
    v1: sourcePin.fingerprint, legacy: legacy.results,
  }));
  return { sourcePin, fingerprint };
}

function parsedCachedFits(json: string, participantId: string): CommunityAllowanceFit[] | null {
  let values: unknown;
  try { values = JSON.parse(json); } catch { return null; }
  if (!Array.isArray(values) || values.length > 50_000) return null;
  const fits: CommunityAllowanceFit[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || value.participantId !== participantId
        || typeof value.planType !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/u.test(value.planType)
        || typeof value.capacityNanousd !== "number" || !Number.isFinite(value.capacityNanousd)
        || value.capacityNanousd <= 0 || typeof value.lastObservedAt !== "string"
        || !Number.isFinite(Date.parse(value.lastObservedAt))) return null;
    fits.push({ participantId, planType: value.planType,
      capacityNanousd: value.capacityNanousd, lastObservedAt: value.lastObservedAt });
  }
  return fits;
}

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

// Enumerate evidence, not a participant-wide preference. Each format is
// analyzed independently; the reset-domain arbiter below chooses one source
// for overlapping fits while retaining disjoint history from both.
const COMMUNITY_ALLOWANCE_PARTICIPANT_SOURCES_CTE = `participant_sources AS (
  SELECT participant_id,
         CASE WHEN MAX(source = 'v1.1') = 1 THEN 'v1.1'
           WHEN COUNT(DISTINCT source) > 1 THEN 'mixed' ELSE MIN(source) END AS source
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
      UNION ALL
      SELECT h.participant_id, 'v1.1' AS source FROM telemetry_v11_domain_heads h
        JOIN participants p3 ON p3.id = h.participant_id AND p3.state = 'active'
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
  firstObservedAt?: unknown;
  resetsAt?: unknown;
  boundaryCount?: unknown;
}

interface AnalysisCalibrationTrack {
  resets?: AnalysisResetFit[];
}

interface AnalysisTrack {
  continuity?: { planType?: unknown; planVariant?: unknown; accountTrackId?: unknown;
    provider?: unknown; policyEpoch?: unknown; planEraKey?: unknown };
  calibration?: { tracks?: AnalysisCalibrationTrack[] };
}

interface AnalysisResult {
  status?: unknown;
  tracks?: AnalysisTrack[];
}

/** Select only after fit and population gates; never fit a mixed-format numerator. */
export function selectCommunityAllowanceAnalysisFits(
  participantId: string,
  inputs: readonly { source: "v0.2" | "v1" | "v1.1"; analysis: AnalysisResult }[],
): CommunityAllowanceFit[] {
  const byParent = new Map<string, {
    fit: CommunityAllowanceFit; source: "v0.2" | "v1" | "v1.1"; domain: string;
    span: number; boundaries: number; last: string; era: string;
  }>();
  for (const { source, analysis } of inputs) {
    if (analysis.status !== "ready" || !Array.isArray(analysis.tracks)) continue;
    for (const track of analysis.tracks) {
      const continuity = track.continuity;
      const planType = continuity?.planType;
      if (typeof planType !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/u.test(planType)) continue;
      for (const calibration of track.calibration?.tracks ?? []) {
        for (const reset of calibration.resets ?? []) {
          if (reset.status !== "conditional_estimate" || reset.limitId !== "codex"
              || reset.windowDurationMinutes !== SEVEN_DAY_WINDOW_MINUTES
              || typeof reset.capacityNanousd !== "number" || !Number.isFinite(reset.capacityNanousd)
              || reset.capacityNanousd <= 0 || typeof reset.displayedSpanPp !== "number"
              || !Number.isFinite(reset.displayedSpanPp) || reset.displayedSpanPp < COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP
              || typeof reset.lastObservedAt !== "string" || !Number.isFinite(Date.parse(reset.lastObservedAt))
              || typeof reset.resetsAt !== "string" || !Number.isFinite(Date.parse(reset.resetsAt))) continue;
          const domain = JSON.stringify([participantId, continuity?.provider ?? "openai_codex",
            planType, continuity?.planVariant ?? "unknown", reset.limitId,
            reset.windowDurationMinutes, reset.resetsAt]);
          const parent = JSON.stringify([source, domain, continuity?.accountTrackId ?? "unattributed",
            continuity?.policyEpoch ?? "unknown"]);
          const candidate = {
            fit: { participantId, planType, capacityNanousd: reset.capacityNanousd,
              lastObservedAt: reset.lastObservedAt }, source, domain,
            span: reset.displayedSpanPp,
            boundaries: typeof reset.boundaryCount === "number" ? reset.boundaryCount : 0,
            last: reset.lastObservedAt,
            era: typeof continuity?.planEraKey === "string" ? continuity.planEraKey : "legacy",
          };
          const previous = byParent.get(parent);
          if (!previous || candidate.span > previous.span
              || (candidate.span === previous.span && candidate.boundaries > previous.boundaries)
              || (candidate.span === previous.span && candidate.boundaries === previous.boundaries
                && (candidate.last > previous.last || (candidate.last === previous.last && candidate.era < previous.era)))) {
            byParent.set(parent, candidate);
          }
        }
      }
    }
  }
  // Account-linked v0.2 is preferred only for an overlapping qualifying reset
  // domain. A sparse/non-fitting legacy shard cannot erase disjoint or otherwise
  // usable v1 history. This is source arbitration, never identity equivalence.
  const legacyDomains = new Set([...byParent.values()].filter((row) => row.source === "v0.2")
    .map((row) => row.domain));
  return [...byParent.values()]
    .filter((row) => row.source === "v0.2" || !legacyDomains.has(row.domain))
    .map((row) => row.fit);
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
 * Formats are fitted independently, then one qualifying source is selected
 * per overlapping reset domain. This retains disjoint history without joining
 * a new quota to old unscoped usage or multiplying a reset's vote. The derived
 * cache is pinned to exact source fingerprints and monotonic input revisions.
 */
export async function collectCommunityAllowanceFits(
  db: D1Database,
  nowMs: number = Date.now(),
): Promise<CommunityAllowanceFit[]> {
  const participants = await db.prepare(
    `WITH ${COMMUNITY_ALLOWANCE_PARTICIPANT_SOURCES_CTE}
     SELECT participant_id, source FROM participant_sources ORDER BY participant_id`,
  ).all<{ participant_id: string; source: LegacySource }>();
  const fits: CommunityAllowanceFit[] = [];
  const fromDay = analysisFromDay(nowMs);
  for (const row of participants.results) {
    // Source pinning is correctness, not an optional cache optimization.
    // An unavailable or changing source cannot become a fabricated zero-fit result.
    const { sourcePin, fingerprint } = await loadCommunitySourcePin(db, row.participant_id, fromDay, row.source);
    const cacheKey = sourceCacheKey(sourcePin, fromDay, V1_FIT_CACHE_KEY_SUFFIX, row.source);
    let cachedFits: CommunityAllowanceFit[] | null = null;
    try {
      const cached = await db.prepare(
        `SELECT fits_json FROM community_allowance_fit_cache
         WHERE participant_id = ? AND cache_key = ?
           AND input_fingerprint = ? AND source_method_version = ?`,
      ).bind(row.participant_id, cacheKey, fingerprint, COMMUNITY_ATTRIBUTION_METHOD_VERSION)
        .first<{ fits_json: string }>();
      if (cached) cachedFits = parsedCachedFits(cached.fits_json, row.participant_id);
    } catch {
      // Cache availability does not authorize an unpinned analytical read.
    }
    if (cachedFits !== null) {
      await assertCommunitySourcePinCurrent(db, sourcePin);
      fits.push(...cachedFits);
      continue;
    }
    const analyses: { source: "v0.2" | "v1" | "v1.1"; analysis: AnalysisResult }[] = [];
    if (isV11Pin(sourcePin)) analyses.push({source: "v1.1",
      analysis: await accountScopedQuotaAnalysisV11(db, row.participant_id, {nowMs, sourcePin}) as AnalysisResult});
    else if (row.source !== "v0.2") analyses.push({
      source: "v1",
      analysis: await accountScopedQuotaAnalysisV1(db, row.participant_id, { nowMs, sourcePin }) as AnalysisResult,
    });
    if (row.source === "v0.2" || row.source === "mixed") analyses.push({
      source: "v0.2",
      analysis: await accountScopedQuotaAnalysis(db, row.participant_id) as AnalysisResult,
    });
    const participantFits = selectCommunityAllowanceAnalysisFits(row.participant_id, analyses);
    await assertCommunitySourcePinCurrent(db, sourcePin);
    try {
      await db.prepare(
        `INSERT INTO community_allowance_fit_cache (
           participant_id, cache_key, fits_json, computed_at, input_fingerprint, source_method_version
         ) SELECT ?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?4, ?5
           WHERE EXISTS (
             SELECT 1 FROM community_analytical_input_versions v
             JOIN participants p ON p.id = v.participant_id AND p.state = 'active'
             WHERE v.participant_id = ?1 AND v.revision = ?6
           )
         ON CONFLICT(participant_id) DO UPDATE SET cache_key = excluded.cache_key,
           fits_json = excluded.fits_json, computed_at = excluded.computed_at,
           input_fingerprint = excluded.input_fingerprint, source_method_version = excluded.source_method_version`,
      ).bind(row.participant_id, cacheKey, JSON.stringify(participantFits), fingerprint,
        COMMUNITY_ATTRIBUTION_METHOD_VERSION, sourcePin.inputRevision).run();
    } catch {
      // Derived cache write is best effort; final publication still has its own epoch fence.
    }
    fits.push(...participantFits);
  }
  fits.sort((left, right) => left.lastObservedAt.localeCompare(right.lastObservedAt)
    || left.capacityNanousd - right.capacityNanousd || left.participantId.localeCompare(right.participantId));
  return fits;
}

interface CachedCommunityAllowanceFitRow {
  participant_id: string;
  source: LegacySource;
  expected_cache_key: string | null;
  cache_key: string | null;
  fits_json: string | null;
  input_fingerprint: string | null;
  source_method_version: string | null;
}

/**
 * Fully validated, cache-backed fit evidence for the active uploading cohort.
 * Participant identifiers stay inside Worker code; callers must project only
 * aggregate counts before returning anything to a browser.
 */
export interface CachedCommunityAllowanceCorpus {
  readonly participantIds: readonly string[];
  readonly fits: readonly CommunityAllowanceFit[];
}

/**
 * Read the validated fit-cache corpus for scheduled aggregate construction
 * without invoking either raw-corpus analyzer or issuing a database mutation.
 *
 * The single SELECT verifies each active participant's monotonic input revision
 * against the same method/pricing/day cache key used by the scheduled collector.
 * A matching stored exact fingerprint attests the pinned input at that revision.
 * Missing/stale rows fail closed; this SELECT-only source never substitutes raw
 * work. Browser routes must read their own aggregate singleton instead;
 * the scheduled aggregate builder remains the sole fit-cache warmer and keeps
 * its existing best-effort INSERT behaviour.
 */
export async function readCachedCommunityAllowanceCorpus(
  db: D1Database,
  nowMs: number = Date.now(),
): Promise<CachedCommunityAllowanceCorpus | null> {
  let rows: CachedCommunityAllowanceFitRow[];
  try {
    const result = await db.prepare(
      `WITH ${COMMUNITY_ALLOWANCE_PARTICIPANT_SOURCES_CTE},
       v1_epochs AS (
         SELECT sources.participant_id,
                sources.source || ':' || CAST(versions.revision AS TEXT)
                  || ':' || ?1 || ':' || ?2 AS expected_cache_key
           FROM participant_sources sources
           LEFT JOIN community_analytical_input_versions versions
             ON versions.participant_id = sources.participant_id
       )
       SELECT sources.participant_id,
              sources.source,
              epochs.expected_cache_key,
              cache.cache_key,
              cache.fits_json,
              cache.input_fingerprint,
              cache.source_method_version
         FROM participant_sources sources
         LEFT JOIN v1_epochs epochs
           ON epochs.participant_id = sources.participant_id
         LEFT JOIN community_allowance_fit_cache cache
           ON cache.participant_id = sources.participant_id
        ORDER BY sources.participant_id`,
    ).bind(
      analysisFromDay(nowMs),
      V1_FIT_CACHE_KEY_SUFFIX,
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
  for (const row of rows) {
    if (typeof row.participant_id !== "string"
        || row.participant_id.length === 0
        || participants.has(row.participant_id)
        || !["v0.2", "v1", "mixed", "v1.1"].includes(row.source)
        || typeof row.expected_cache_key !== "string"
        || row.expected_cache_key.length === 0
        || row.cache_key !== row.expected_cache_key
        || typeof row.input_fingerprint !== "string"
        || !/^[a-f0-9]{64}$/u.test(row.input_fingerprint)
        || row.source_method_version !== COMMUNITY_ATTRIBUTION_METHOD_VERSION
        || typeof row.fits_json !== "string") {
      return null;
    }
    participants.add(row.participant_id);
    const cachedFits = parsedCachedFits(row.fits_json, row.participant_id);
    if (cachedFits === null) return null;
    fits.push(...cachedFits);
  }
  fits.sort((left, right) => (
    left.lastObservedAt.localeCompare(right.lastObservedAt)
    || left.capacityNanousd - right.capacityNanousd
    || left.participantId.localeCompare(right.participantId)
  ));
  return Object.freeze({
    participantIds: Object.freeze([...participants].sort()),
    fits: Object.freeze(fits),
  });
}

/**
 * Compatibility projection for existing scheduled/public aggregation code.
 * It deliberately delegates to the corpus reader so there remains one cache
 * validation and source-selection contract.
 */
export async function readCachedCommunityAllowanceFits(
  db: D1Database,
  nowMs: number = Date.now(),
): Promise<CommunityAllowanceFit[] | null> {
  const corpus = await readCachedCommunityAllowanceCorpus(db, nowMs);
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

// ---------------------------------------------------------------------------
// Per-model composition collection
// ---------------------------------------------------------------------------

// Bump when the composition adapter's synthesis, pricing basis, or fold
// changes. Deliberately separate from FIT_ADAPTER_VERSION: a composition
// change must not invalidate every blended fit cache, and vice versa.
// v1-composition-2: multi-plan windows refuse (plan-multiplier
// incommensurability), not-fully-priced events void their whole bin, and the
// cached shape carries latestQuotaObservedAt + poisonedBinCount and includes
// refusals so a refusing participant stops re-running the raw corpus scan
// every warm pass.
const COMPOSITION_ADAPTER_VERSION = "v1-composition-3";
const COMPOSITION_CACHE_KEY_SUFFIX =
  `${APP_PRICE_REGISTRY_MANIFEST.sha256}:${COMPOSITION_ADAPTER_VERSION}:${SERVER_PRICING_METHOD_VERSION}:${COMMUNITY_ATTRIBUTION_METHOD_VERSION}`;
// The composition JSON is a per-model vector plus diagnostics — a few hundred
// bytes. The storage CHECK allows 32 KiB; enforcing half that here keeps a
// pathological model census from ever reaching the write.
const COMPOSITION_CACHE_JSON_LIMIT_BYTES = 16 * 1024;

export interface CommunityModelComposition {
  readonly participantId: string;
  readonly composition: V1ModelComposition;
}

function validCachedComposition(
  value: unknown,
): value is V1ModelCompositionResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.status === "not_testable") {
    return typeof candidate.reason === "string";
  }
  return candidate.status === "ready"
    && typeof candidate.planType === "string"
    && typeof candidate.latestQuotaObservedAt === "string"
    && typeof candidate.fit === "object" && candidate.fit !== null;
}

/**
 * Enumerate every active v1-source participant and collect their per-model
 * composition fit, through the same chunk-epoch cache discipline as the
 * blended fit collector above.
 *
 * v0.2-source participants are skipped: their at-rest corpus has no
 * composition reader yet, and a silent blended stand-in would defeat the
 * point of a per-model view. The admin payload carries the counts so the gap
 * is visible rather than implied away.
 */
export async function collectCommunityModelCompositions(
  db: D1Database,
  nowMs: number = Date.now(),
): Promise<{
  compositions: CommunityModelComposition[];
  v1ParticipantCount: number;
  unsupportedSourceParticipantCount: number;
  refusedParticipantCount: number;
  storeAvailable: boolean;
}> {
  const participants = await db.prepare(
    `WITH ${COMMUNITY_ALLOWANCE_PARTICIPANT_SOURCES_CTE}
     SELECT participant_id, source
       FROM participant_sources
      ORDER BY participant_id`,
  ).all<{ participant_id: string; source: LegacySource }>();
  const compositions: CommunityModelComposition[] = [];
  let v1ParticipantCount = 0;
  let unsupportedSourceParticipantCount = 0;
  let refusedParticipantCount = 0;
  // Without the 0041 store, every warm pass would silently re-run the full
  // per-participant corpus scan and throw the result away. Probe once and
  // skip the expensive work entirely; the day series just does not advance
  // until the migration is applied, which the caller reports rather than
  // masks.
  let storeAvailable = true;
  try {
    await db.prepare(
      "SELECT 1 FROM community_model_composition_cache LIMIT 1",
    ).first();
  } catch {
    storeAvailable = false;
  }
  for (const row of participants.results) {
    const fromDay = analysisFromDay(nowMs);
    // Composition is one whole-window domain, unlike independent reset fits.
    // A v0.2 shard outside that domain must not suppress useful v1 composition;
    // overlapping account-linked rows have no composition adapter and cannot
    // be silently stitched to the unscoped v1 numerator.
    const legacyOverlap = row.source === "mixed" ? await db.prepare(`
      SELECT 1 FROM telemetry_records r
       JOIN telemetry_contribution_occurrences o
         ON o.participant_id = r.participant_id AND o.record_kind = r.record_kind
        AND o.occurrence_id = r.occurrence_id
       JOIN telemetry_contributions c ON c.id = o.contribution_id
      WHERE r.participant_id = ? AND r.record_kind = 'quota'
        AND r.provider = 'openai_codex' AND r.limit_id = 'codex' AND r.observed_at >= ?
        AND c.status = 'accepted' AND c.transport_schema_version = 'telemetry-contribution-v0.2'
      LIMIT 1`).bind(row.participant_id, `${fromDay}T00:00:00.000Z`).first() : null;
    if (row.source === "v0.2" || legacyOverlap !== null) {
      unsupportedSourceParticipantCount += 1;
      continue;
    }
    v1ParticipantCount += 1;
    if (!storeAvailable) continue;
    const sourcePin: CommunitySourcePin = row.source === "v1.1"
      ? (await loadV11SourcePin(db, row.participant_id, {fromDay}))!
      : await loadV1SourcePin(db, { participantId: row.participant_id, fromDay });
    if (!sourcePin) throw new Error("activated attribution source unavailable");
    let cacheKey: string | null = null;
    try {
      cacheKey = sourceCacheKey(sourcePin, fromDay, COMPOSITION_CACHE_KEY_SUFFIX, isV11Pin(sourcePin) ? "v1.1" : "v1");
      const cached = await db.prepare(
        `SELECT composition_json FROM community_model_composition_cache
          WHERE participant_id = ? AND cache_key = ?
            AND input_fingerprint = ? AND source_method_version = ?`,
      ).bind(row.participant_id, cacheKey, sourcePin.fingerprint,
        COMMUNITY_ATTRIBUTION_METHOD_VERSION).first<{ composition_json: string }>();
      if (cached) {
        const parsed: unknown = JSON.parse(cached.composition_json);
        if (validCachedComposition(parsed)) {
          await assertCommunitySourcePinCurrent(db, sourcePin);
          if (parsed.status === "ready") {
            compositions.push({ participantId: row.participant_id, composition: parsed });
          } else {
            refusedParticipantCount += 1;
          }
          continue;
        }
      }
    } catch {
      // The cache is a pure optimization; migration 0041 may not be applied
      // yet. cacheKey stays null so the write below is skipped too, and the
      // next pass retries the cache.
      cacheKey = null;
    }
    let result: V1ModelCompositionResult;
    try {
      result = isV11Pin(sourcePin)
        ? await accountScopedModelCompositionV11(db, row.participant_id, {nowMs, sourcePin})
        : await accountScopedModelCompositionV1(db, row.participant_id, {nowMs, sourcePin});
    } catch {
      // A single participant's analyzer throw never aborts the collector —
      // and, unlike a refusal, is never cached: a transient D1 error must not
      // become a durable "refused" verdict.
      refusedParticipantCount += 1;
      continue;
    }
    await assertCommunitySourcePinCurrent(db, sourcePin);
    if (result.status === "ready") {
      compositions.push({ participantId: row.participant_id, composition: result });
    } else {
      refusedParticipantCount += 1;
    }
    if (cacheKey !== null) {
      try {
        const compositionJson = JSON.stringify(result);
        if (new TextEncoder().encode(compositionJson).byteLength
            <= COMPOSITION_CACHE_JSON_LIMIT_BYTES) {
          await db.prepare(
            `INSERT INTO community_model_composition_cache (
               participant_id, cache_key, composition_json, computed_at,
               input_fingerprint, source_method_version
             ) SELECT ?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?4, ?5
               WHERE EXISTS (
                 SELECT 1 FROM community_analytical_input_versions v
                 JOIN participants p ON p.id = v.participant_id AND p.state = 'active'
                 WHERE v.participant_id = ?1 AND v.revision = ?6
               )
             ON CONFLICT(participant_id) DO UPDATE SET
               cache_key = excluded.cache_key,
               composition_json = excluded.composition_json,
               computed_at = excluded.computed_at,
               input_fingerprint = excluded.input_fingerprint,
               source_method_version = excluded.source_method_version`,
          ).bind(row.participant_id, cacheKey, compositionJson, sourcePin.fingerprint,
            COMMUNITY_ATTRIBUTION_METHOD_VERSION, sourcePin.inputRevision).run();
        }
      } catch {
        // Best-effort cache write; a failure just means the next pass
        // recomputes.
      }
    }
  }
  return {
    compositions,
    v1ParticipantCount,
    unsupportedSourceParticipantCount,
    refusedParticipantCount,
    storeAvailable,
  };
}
