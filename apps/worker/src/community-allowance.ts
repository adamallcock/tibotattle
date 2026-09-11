import { APP_PRICE_REGISTRY_MANIFEST } from "@app-usagemonitor/accounting";
import { MODEL_COMPOSITION_POLICY, PLAN_ATTRIBUTION_POLICY, SEVEN_DAY_WINDOW_MINUTES } from "@app-usagemonitor/quota-analysis";
import { accountScopedQuotaAnalysis } from "./quota-analysis";
import {
  V1_ANALYSIS_WINDOW_DAYS,
  V1_PLAN_ATTRIBUTION_ADAPTER_VERSION,
  V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION,
  accountScopedModelCompositionV1,
  accountScopedQuotaAnalysisV1,
} from "./quota-analysis-v1";
import type {
  V1ModelComposition,
  V1ModelCompositionResult,
} from "./quota-analysis-v1";
import { SERVER_PRICING_METHOD_VERSION } from "./server-pricing";
import {
  COMMUNITY_PUBLIC_SOURCE_POLICY_VERSION,
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
import { currentAnalysisPublicationStatements, type CurrentAnalysisQueueClaim } from "./community-analysis-queue";

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
 * the estimate. The daily payload carries the resulting combined summary;
 * the optional public breakdown adds reviewed plan/model summaries, while
 * identifiers and operational diagnostics remain private admin evidence.
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
    // Invalidate all prior caches when the resumable calculator is installed.
    // Legacy direct adapters remain supported for their explicit callers; the
    // recovery scheduler only writes the acquired-input adapter's results.
    V1_PLAN_ATTRIBUTION_ADAPTER_VERSION, V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION,
    V11_PLAN_ATTRIBUTION_ADAPTER_VERSION,
    // Public readiness and derived admin output must invalidate alongside the
    // fit caches when the dollar-equivalent pricing semantics change.
    V11_DOMAIN_METHOD_VERSION, SERVER_PRICING_METHOD_VERSION,
    COMMUNITY_PUBLIC_SOURCE_POLICY_VERSION].join(":");
// The tail of every v1 fit-cache key beyond the participant's chunk epoch.
// One constant serves the writer and both readers so they can never diverge
// (a 2026-08-30 regression had the corpus reader expecting one fewer segment,
// which starved the admin allowance preview).
export const V1_FIT_CACHE_KEY_SUFFIX =
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

export async function loadCommunitySourcePin(db: D1Database, participantId: string, fromDay: string, source: LegacySource,
  options?: { includeDayDependencies?: boolean }) {
  if (source === "v1.1") {
    const sourcePin = await loadV11SourcePin(db, participantId, {fromDay});
    if (!sourcePin) throw new Error("activated attribution source unavailable");
    return {sourcePin, fingerprint: sourcePin.fingerprint};
  }
  const sourcePin = await loadV1SourcePin(db, { participantId, fromDay }, options);
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

/** All analytical versions used by either current cache, excluding display copy. */
export function communityAnalysisCacheVersion(): string {
  return `${V1_FIT_CACHE_KEY_SUFFIX}:${COMPOSITION_CACHE_KEY_SUFFIX}`;
}

export function parsedCachedFits(json: string, participantId: string): CommunityAllowanceFit[] | null {
  let values: unknown;
  try { values = JSON.parse(json); } catch { return null; }
  if (!Array.isArray(values) || values.length > 50_000) return null;
  const fits: CommunityAllowanceFit[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).length !== 4
        || Object.keys(value).some(key => !["participantId","planType","capacityNanousd","lastObservedAt"].includes(key))
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
          AND p.owner_kind = 'social'
       WHERE c.status = 'accepted'
         AND c.transport_schema_version = 'telemetry-contribution-v0.2'
      UNION ALL
      SELECT c2.participant_id, 'v1' AS source
        FROM telemetry_v1_chunks c2
        JOIN participants p2 ON p2.id = c2.participant_id AND p2.state = 'active'
          AND p2.owner_kind = 'social'
       WHERE c2.superseded_at IS NULL
      UNION ALL
      SELECT h.participant_id, 'v1.1' AS source FROM telemetry_v11_domain_heads h
       WHERE EXISTS (SELECT 1 FROM community_public_source_owners p3 WHERE p3.participant_id = h.participant_id)
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
             WHERE v.participant_id = ?1 AND v.revision = ?6
               AND EXISTS (SELECT 1 FROM community_public_source_owners p WHERE p.participant_id = v.participant_id)
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
  options?: CommunityCacheReadOptions,
): Promise<CachedCommunityAllowanceCorpus | null> {
  if (options) return readBoundedCommunityAllowanceCorpus(db, nowMs, options);
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
  options?: CommunityCacheReadOptions,
): Promise<CommunityAllowanceFit[] | null> {
  const corpus = await readCachedCommunityAllowanceCorpus(db, nowMs, options);
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
export const COMPOSITION_CACHE_KEY_SUFFIX =
  `${APP_PRICE_REGISTRY_MANIFEST.sha256}:${COMPOSITION_ADAPTER_VERSION}:${SERVER_PRICING_METHOD_VERSION}:${COMMUNITY_ATTRIBUTION_METHOD_VERSION}`;
// The composition JSON is a per-model vector plus diagnostics — a few hundred
// bytes. The storage CHECK allows 32 KiB; enforcing half that here keeps a
// pathological model census from ever reaching the write.
const COMPOSITION_CACHE_JSON_LIMIT_BYTES = 16 * 1024;

export interface CommunityModelComposition {
  readonly participantId: string;
  readonly composition: V1ModelComposition;
}

export interface CachedCommunityModelCompositions {
  compositions: CommunityModelComposition[];
  v1ParticipantCount: number;
  unsupportedSourceParticipantCount: number;
  refusedParticipantCount: number;
  storeAvailable: true;
}

export const COMMUNITY_MODEL_CACHE_PAGE_SIZE = 64;
export const COMMUNITY_MODEL_CACHE_MAX_PAGES = 16;
export const COMMUNITY_MODEL_CACHE_MAX_BYTES = 16 * 1024 * 1024;
export const COMMUNITY_MODEL_CACHE_MAX_QUERIES = COMMUNITY_MODEL_CACHE_MAX_PAGES + 2;

export interface CommunityModelCacheReadBudget {
  remainingQueries: number;
  deadlineMs: number;
  now?: () => number;
  reserveQueries?: number;
}

export interface CommunityCacheReadOptions {
  budget: CommunityModelCacheReadBudget;
  pageSize?: number;
  maxPages?: number;
  maxBytes?: number;
}

// Materialize only eligible contributing IDs before the bounded source lookups.
// The lookahead row is not evidence admission: it proves whether another page
// exists. Never group or materialize the complete analytical corpus here.
export const COMMUNITY_PARTICIPANT_PAGE_CTE = `
WITH participant_page AS MATERIALIZED (
  SELECT p.id, p.state FROM community_current_analysis_queue q
  JOIN participants p ON p.id = q.participant_id
  WHERE q.participant_id > ?1 AND p.state != 'deleting'
    AND (p.owner_kind = 'social' OR EXISTS (
      SELECT 1 FROM community_public_source_owners public_source WHERE public_source.participant_id = p.id)) AND (
    EXISTS (SELECT 1 FROM telemetry_v1_chunks c INDEXED BY telemetry_v1_chunks_current_identity
      WHERE c.participant_id = p.id AND c.superseded_at IS NULL)
    OR EXISTS (SELECT 1 FROM telemetry_v11_domain_heads h WHERE h.participant_id = p.id)
    OR EXISTS (SELECT 1 FROM telemetry_contributions c WHERE c.participant_id = p.id
      AND c.status = 'accepted' AND c.transport_schema_version = 'telemetry-contribution-v0.2'))
  ORDER BY q.participant_id LIMIT ?2
), sources AS MATERIALIZED (
  SELECT p.id, p.state,
    CASE WHEN p.state = 'active' THEN EXISTS (
      SELECT 1 FROM telemetry_contributions c
      WHERE c.participant_id = p.id AND c.status = 'accepted'
        AND c.transport_schema_version = 'telemetry-contribution-v0.2'
    ) ELSE 0 END AS has_legacy,
    CASE WHEN p.state = 'active' THEN EXISTS (
      SELECT 1 FROM telemetry_v1_chunks c INDEXED BY telemetry_v1_chunks_current_identity
      WHERE c.participant_id = p.id AND c.superseded_at IS NULL
    ) ELSE 0 END AS has_v1,
    CASE WHEN p.state = 'active' THEN EXISTS (
      SELECT 1 FROM telemetry_v11_domain_heads h WHERE h.participant_id = p.id
    ) ELSE 0 END AS has_v11
  FROM participant_page p
)`;

export const CACHED_COMMUNITY_MODEL_COMPOSITIONS_PAGE_SQL = `${COMMUNITY_PARTICIPANT_PAGE_CTE}
SELECT s.id AS participant_id, s.state, s.has_legacy, s.has_v1, s.has_v11,
  CASE WHEN s.has_v11 = 0 AND s.has_v1 = 1 AND s.has_legacy = 1 THEN EXISTS (
    SELECT 1 FROM telemetry_records r INDEXED BY telemetry_records_participant_time
    WHERE r.participant_id = s.id AND r.observed_at >= ?3 AND r.record_kind = 'quota'
      AND r.provider = 'openai_codex' AND r.limit_id = 'codex'
      AND EXISTS (
        SELECT 1 FROM telemetry_contribution_occurrences o INDEXED BY telemetry_contribution_occurrences_record
        JOIN telemetry_contributions c ON c.id = o.contribution_id
        WHERE o.participant_id = r.participant_id AND o.record_kind = r.record_kind
          AND o.occurrence_id = r.occurrence_id AND c.status = 'accepted'
          AND c.transport_schema_version = 'telemetry-contribution-v0.2'
      )
  ) ELSE 0 END AS legacy_overlap,
  versions.revision AS input_revision,
  CASE WHEN length(CAST(cache.cache_key AS BLOB)) <= 512 THEN cache.cache_key ELSE NULL END AS cache_key,
  CASE WHEN length(CAST(cache.input_fingerprint AS BLOB)) = 64 THEN cache.input_fingerprint ELSE NULL END AS input_fingerprint,
  CASE WHEN length(CAST(cache.source_method_version AS BLOB)) <= 2048 THEN cache.source_method_version ELSE NULL END AS source_method_version,
  CASE WHEN length(CAST(cache.composition_json AS BLOB)) <= ?4
    THEN cache.composition_json ELSE NULL END AS composition_json
FROM sources s
LEFT JOIN community_analytical_input_versions versions ON versions.participant_id = s.id
LEFT JOIN community_model_composition_cache cache ON cache.participant_id = s.id
ORDER BY s.id`;

/** Page small source/cache metadata first; never return many large fit blobs in
 * one D1 response. The following per-participant reads share a byte/query budget.
 */
export const CACHED_COMMUNITY_ALLOWANCE_PAGE_SQL = `${COMMUNITY_PARTICIPANT_PAGE_CTE}
SELECT s.id AS participant_id, s.state, s.has_legacy, s.has_v1, s.has_v11,
  versions.revision AS input_revision,
  CASE WHEN length(CAST(cache.cache_key AS BLOB)) <= 512 THEN cache.cache_key ELSE NULL END AS cache_key,
  CASE WHEN length(CAST(cache.input_fingerprint AS BLOB)) = 64 THEN cache.input_fingerprint ELSE NULL END AS input_fingerprint,
  CASE WHEN length(CAST(cache.source_method_version AS BLOB)) <= 2048 THEN cache.source_method_version ELSE NULL END AS source_method_version,
  length(CAST(cache.fits_json AS BLOB)) AS fits_bytes
FROM sources s
LEFT JOIN community_analytical_input_versions versions ON versions.participant_id = s.id
LEFT JOIN community_allowance_fit_cache cache ON cache.participant_id = s.id
ORDER BY s.id`;

export const CACHED_COMMUNITY_ALLOWANCE_PAYLOADS_SQL = `WITH expected AS MATERIALIZED (
  SELECT json_extract(value,'$.participant') AS participant_id,json_extract(value,'$.key') AS cache_key,
    json_extract(value,'$.fingerprint') AS fingerprint,json_extract(value,'$.bytes') AS bytes FROM json_each(?1))
SELECT e.participant_id,CASE WHEN length(CAST(c.fits_json AS BLOB))=e.bytes THEN c.fits_json ELSE NULL END AS fits_json
FROM expected e LEFT JOIN community_allowance_fit_cache c ON c.participant_id=e.participant_id
  AND c.cache_key=e.cache_key AND c.input_fingerprint=e.fingerprint AND c.source_method_version=?2
ORDER BY e.participant_id`;

function spendCommunityCacheQuery(budget: CommunityModelCacheReadBudget): boolean {
  const reserve = budget.reserveQueries ?? 0, now = (budget.now ?? Date.now)();
  if (!cacheCount(budget.remainingQueries) || !cacheCount(reserve)
      || !Number.isFinite(budget.deadlineMs) || !Number.isFinite(now)
      || now >= budget.deadlineMs || budget.remainingQueries - reserve < 1) return false;
  budget.remainingQueries -= 1;
  return true;
}

async function readBoundedCommunityAllowanceCorpus(db: D1Database, nowMs: number,
  options: CommunityCacheReadOptions): Promise<CachedCommunityAllowanceCorpus | null> {
  const { budget } = options;
  const pageSize = options.pageSize ?? COMMUNITY_MODEL_CACHE_PAGE_SIZE;
  const maxPages = options.maxPages ?? COMMUNITY_MODEL_CACHE_MAX_PAGES;
  const maxBytes = options.maxBytes ?? COMMUNITY_MODEL_CACHE_MAX_BYTES;
  if (!Number.isFinite(nowMs) || !cacheCount(pageSize) || pageSize < 1 || pageSize > COMMUNITY_MODEL_CACHE_PAGE_SIZE
      || !cacheCount(maxPages) || maxPages < 1 || maxPages > COMMUNITY_MODEL_CACHE_MAX_PAGES
      || !cacheCount(maxBytes) || maxBytes > COMMUNITY_MODEL_CACHE_MAX_BYTES) return null;
  const epoch = async (): Promise<number | null> => {
    if (!spendCommunityCacheQuery(budget)) return null;
    const row = await db.prepare("SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id = 1")
      .first<{ mutation_epoch: number }>();
    return cacheCount(row?.mutation_epoch) ? row!.mutation_epoch : null;
  };
  try {
    const firstEpoch = await epoch();
    if (firstEpoch === null) return null;
    const fromDay = analysisFromDay(nowMs), participantIds: string[] = [], fits: CommunityAllowanceFit[] = [];
    let cursor = "", bytes = 0;
    for (let page = 0; page < maxPages; page++) {
      if (!spendCommunityCacheQuery(budget)) return null;
      const { results: rows } = await db.prepare(CACHED_COMMUNITY_ALLOWANCE_PAGE_SQL)
        .bind(cursor, pageSize + 1).all<Omit<CachedModelPageRow, "legacy_overlap" | "composition_json"> & { fits_bytes: number | null }>();
      if (!Array.isArray(rows) || rows.length > pageSize + 1) return null;
      let previous = cursor;
      for (const row of rows) {
        if (typeof row.participant_id !== "string" || row.participant_id.length < 1 || row.participant_id.length > 128
            || row.participant_id <= previous || !["active", "deleting"].includes(row.state)) return null;
        previous = row.participant_id;
      }
      const selected: {participant:string;key:string;fingerprint:string;bytes:number}[] = [];
      for (const row of rows.slice(0, pageSize)) {
        cursor = row.participant_id;
        if (row.state !== "active") continue;
        if (![row.has_legacy, row.has_v1, row.has_v11].every(flag => flag === 0 || flag === 1)) return null;
        if (!row.has_legacy && !row.has_v1 && !row.has_v11) continue;
        const source: LegacySource = row.has_v11 ? "v1.1" : row.has_v1 ? row.has_legacy ? "mixed" : "v1" : "v0.2";
        if (!cacheCount(row.input_revision) || row.cache_key !== `${source}:${row.input_revision}:${fromDay}:${V1_FIT_CACHE_KEY_SUFFIX}`
            || row.source_method_version !== COMMUNITY_ATTRIBUTION_METHOD_VERSION
            || typeof row.input_fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(row.input_fingerprint)
            || !cacheCount(row.fits_bytes) || row.fits_bytes! > maxBytes - bytes) return null;
        selected.push({participant:row.participant_id,key:row.cache_key,fingerprint:row.input_fingerprint,bytes:row.fits_bytes});
      }
      // Pack up to64 small caches in a query, with a strict2MiB response bound.
      // Metadata is already validated; exact keys/fingerprints and lengths are
      // rechecked in the payload statement before the final source-epoch fence.
      for (let offset=0;offset<selected.length;) {
        const batch: typeof selected = []; let batchBytes=0;
        while (offset<selected.length && batchBytes+selected[offset]!.bytes<=2*1024*1024) {
          const row=selected[offset++]!; batch.push(row); batchBytes+=row.bytes;
        }
        // Preserve the established per-account contract: one larger cache may
        // consume the remaining corpus allocation, but never shares a response
        // with other accounts. The total16MiB fence remains unchanged.
        if (batch.length===0 && selected[offset] && selected[offset]!.bytes<=maxBytes-bytes) {
          const row=selected[offset++]!;batch.push(row);batchBytes=row.bytes;
        }
        if (batch.length===0 || bytes+batchBytes>maxBytes || !spendCommunityCacheQuery(budget)) return null;
        const payloads=(await db.prepare(CACHED_COMMUNITY_ALLOWANCE_PAYLOADS_SQL)
          .bind(JSON.stringify(batch),COMMUNITY_ATTRIBUTION_METHOD_VERSION)
          .all<{participant_id:string;fits_json:string|null}>()).results;
        if (!Array.isArray(payloads) || payloads.length!==batch.length) return null;
        for (let index=0;index<payloads.length;index++) {
          const payload=payloads[index]!,expected=batch[index]!;
          if (payload.participant_id!==expected.participant || typeof payload.fits_json!=="string"
              || new TextEncoder().encode(payload.fits_json).byteLength!==expected.bytes) return null;
          const parsed=parsedCachedFits(payload.fits_json,payload.participant_id);
          if (!parsed) return null;
          participantIds.push(payload.participant_id);
          // Avoid argument-count limits for a valid50,000-fit participant.
          for (const fit of parsed) fits.push(fit);
        }
        bytes+=batchBytes;
      }
      if (rows.length <= pageSize) {
        if (await epoch() !== firstEpoch) return null;
        fits.sort((left, right) => left.lastObservedAt.localeCompare(right.lastObservedAt)
          || left.capacityNanousd - right.capacityNanousd || left.participantId.localeCompare(right.participantId));
        return Object.freeze({ participantIds: Object.freeze(participantIds), fits: Object.freeze(fits) });
      }
    }
    return null;
  } catch {
    return null;
  }
}

interface CachedModelPageRow {
  participant_id: string; state: string;
  has_legacy: number; has_v1: number; has_v11: number; legacy_overlap: number;
  input_revision: number | null; cache_key: string | null;
  input_fingerprint: string | null; source_method_version: string | null;
  composition_json: string | null;
}

function cacheObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function cacheKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function cacheCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function cacheFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function cacheNullableFinite(value: unknown): boolean { return value === null || cacheFinite(value); }
function cacheInstant(value: unknown): value is string {
  return typeof value === "string" && value.length === 24 && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}
function cacheModelMap(value: unknown, capacity = false): value is Record<string, number | null> {
  return cacheObject(value) && Object.entries(value).every(([key, number]) =>
    /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,255}$/u.test(key)
    && (capacity && number === null || cacheFinite(number) && number >= 0 && (capacity || number <= 1)));
}

// This vocabulary is the completed v1/v1.1 composition adapters' analytical
// refusals, not transport errors, transient failures, or unfinished work.
const COMPOSITION_CACHE_REFUSALS = new Set([
  "supported_quota_track_unavailable", "plan_attribution_limit_exceeded",
  "multi_plan_window_unsupported", "multi_provider_window_unsupported",
  "downsampled_quota_limit_exceeded", "windowed_usage_limit_exceeded",
  "usage_cost_limit_exceeded", "multi_account_window_unsupported",
  "multi_era_window_unsupported", "continuity_track_limit_exceeded",
  "usage_day_limit_exceeded", "invalid_attribution_record",
  "session_interval_scope_limit_exceeded", "reduced_usage_limit_exceeded",
  "usage_attribution_unresolved",
]);

const SCALAR_CACHE_REFUSALS: Record<"v0.2" | "v1" | "v1.1", ReadonlySet<string>> = {
  "v0.2": new Set(["analysis_record_limit_exceeded", "account_scoped_dataset_unavailable",
    "plan_attribution_limit_exceeded", "supported_quota_track_unavailable", "continuity_track_limit_exceeded"]),
  v1: new Set(["supported_quota_track_unavailable", "continuity_track_limit_exceeded", "plan_attribution_limit_exceeded",
    "downsampled_quota_limit_exceeded", "windowed_usage_limit_exceeded", "session_interval_scope_limit_exceeded", "usage_cost_limit_exceeded"]),
  "v1.1": new Set(["plan_attribution_limit_exceeded", "downsampled_quota_limit_exceeded", "continuity_track_limit_exceeded",
    "usage_day_limit_exceeded", "windowed_usage_limit_exceeded", "invalid_attribution_record",
    "session_interval_scope_limit_exceeded", "supported_quota_track_unavailable", "attribution_hazard_limit_exceeded",
    "usage_cost_limit_exceeded", "reduced_usage_limit_exceeded"]),
};

function validCompleteScalarAnalysis(value: unknown, source: "v0.2" | "v1" | "v1.1", fingerprint: string): boolean {
  if (!cacheObject(value)) return false;
  const method = source === "v1.1" ? V11_PLAN_ATTRIBUTION_ADAPTER_VERSION : V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION;
  if (Object.hasOwn(value, "attributionMethod") && value.attributionMethod !== method
      || Object.hasOwn(value, "inputFingerprint") && value.inputFingerprint !== fingerprint) return false;
  if (value.status === "not_testable") {
    // Acquisition returns the bare form; completed adapters also carry their
    // schema/attribution metadata and an explicitly empty track collection.
    return Object.keys(value).every(key => ["status", "reason", "schemaVersion", "tracks", "attributionMethod", "inputFingerprint"].includes(key))
      && typeof value.reason === "string" && SCALAR_CACHE_REFUSALS[source].has(value.reason)
      && (!Object.hasOwn(value, "schemaVersion") || value.schemaVersion === "account-scoped-quota-analysis-v0.1")
      && (!Object.hasOwn(value, "tracks") || Array.isArray(value.tracks) && value.tracks.length === 0);
  }
  if (value.status !== "ready" || value.schemaVersion !== "account-scoped-quota-analysis-v0.1"
      || value.fragmentSelection !== "unselected_diagnostics" || !Array.isArray(value.tracks)
      || !Object.keys(value).every(key => ["status", "schemaVersion", "fragmentSelection", "tracks", "attributionMethod", "inputFingerprint"].includes(key))) return false;
  // Filtering a malformed track into an empty fit set would turn an internal
  // error into authoritative evidence. Validate the shared-kernel envelope
  // before applying the existing statistical population/fit selection gates.
  return value.tracks.every(track => {
    if (!cacheObject(track) || !cacheObject(track.continuity) || !cacheObject(track.calibration)) return false;
    const continuity = track.continuity, calibration = track.calibration;
    if (!["planType", "planVariant", "accountTrackId", "provider", "policyEpoch", "planEraKey"]
      .every(key => typeof continuity[key] === "string" && (continuity[key] as string).length > 0)
      || !/^[a-z][a-z0-9_-]{0,31}$/u.test(String(continuity.planType))
      || calibration.schemaVersion !== "quota-calibration-v0.1" || !Array.isArray(calibration.tracks)
      || calibration.trackCount !== calibration.tracks.length) return false;
    return calibration.tracks.every(calibrationTrack => cacheObject(calibrationTrack) && Array.isArray(calibrationTrack.resets)
      && calibrationTrack.resets.every(reset => cacheObject(reset)
        && reset.schemaVersion === "quota-reset-calibration-v0.1"
        && ["conditional_estimate", "not_testable"].includes(String(reset.status))
        && typeof reset.limitId === "string" && cacheCount(reset.windowDurationMinutes)
        && cacheCount(reset.boundaryCount) && cacheFinite(reset.displayedSpanPp)
        && cacheInstant(reset.firstObservedAt) && cacheInstant(reset.lastObservedAt) && cacheInstant(reset.resetsAt)
        && (reset.status === "not_testable" ? reset.capacityNanousd === null
          : cacheFinite(reset.capacityNanousd) && reset.capacityNanousd > 0)));
  });
}

function validCompositionFit(value: unknown): boolean {
  if (!cacheObject(value)) return false;
  const baseKeys = ["status", "observationCount", "totalCostUsd", "modelCostShares",
    "capacityUsdByModel", "singleConstantUsd", "r2", "singleConstantR2", "solverConverged"];
  const insufficient = value.status === "insufficient_observations";
  if (!cacheKeys(value, insufficient ? baseKeys : [...baseKeys, "identification"])
      || !["fitted", "fallback_blended", "insufficient_observations"].includes(String(value.status))
      || !cacheCount(value.observationCount) || !cacheNullableFinite(value.totalCostUsd)
      || value.totalCostUsd !== null && (value.totalCostUsd as number) < 0
      || !cacheModelMap(value.modelCostShares)
      || !cacheNullableFinite(value.singleConstantUsd)
      || value.singleConstantUsd !== null && (value.singleConstantUsd as number) < 0
      || !cacheNullableFinite(value.r2) || value.r2 !== null && (value.r2 as number) > 1
      || !cacheNullableFinite(value.singleConstantR2) || value.singleConstantR2 !== null && (value.singleConstantR2 as number) > 1) return false;
  if (insufficient) return value.capacityUsdByModel === null && value.r2 === null && value.solverConverged === null;
  const identification = value.identification;
  if (value.observationCount < MODEL_COMPOSITION_POLICY.minimumObservations
      || typeof value.solverConverged !== "boolean" || !cacheObject(identification)
      || !cacheKeys(identification, ["adjustedR2", "singleConstantAdjustedR2", "splitHalfIdentified", "splitHalfMaxCapacityDriftFraction"])
      || !cacheNullableFinite(identification.adjustedR2)
      || identification.adjustedR2 !== null && (identification.adjustedR2 as number) > 1
      || !cacheNullableFinite(identification.singleConstantAdjustedR2)
      || identification.singleConstantAdjustedR2 !== null && (identification.singleConstantAdjustedR2 as number) > 1
      || typeof identification.splitHalfIdentified !== "boolean"
      || !cacheFinite(identification.splitHalfMaxCapacityDriftFraction)
      || identification.splitHalfMaxCapacityDriftFraction < 0) return false;
  if (value.status === "fallback_blended") return value.capacityUsdByModel === null;
  return value.solverConverged === true && identification.splitHalfIdentified === true
    && identification.splitHalfMaxCapacityDriftFraction <= MODEL_COMPOSITION_POLICY.maxSplitHalfCapacityDriftFraction
    && cacheFinite(value.r2) && cacheModelMap(value.capacityUsdByModel, true)
    && Object.values(value.capacityUsdByModel).some(number => number !== null && number > 0);
}

export function validCompleteCachedComposition(value: unknown, fingerprint: string, method: string): value is V1ModelCompositionResult {
  if (!cacheObject(value)) return false;
  if (value.status === "not_testable") {
    return (cacheKeys(value, ["status", "reason"])
      || cacheKeys(value, ["status", "reason", "tracks"]) && Array.isArray(value.tracks) && value.tracks.length === 0)
      && typeof value.reason === "string"
      && COMPOSITION_CACHE_REFUSALS.has(value.reason);
  }
  return cacheKeys(value, ["status", "planType", "fit", "voidedBinCount", "poolCount", "quotaRowCount",
    "usageEventCount", "unpricedUsageEventCount", "poisonedBinCount", "latestQuotaObservedAt",
    "attributionStatus", "attributionMethod", "inputFingerprint"])
    && value.status === "ready" && typeof value.planType === "string" && /^[a-z][a-z0-9_-]{0,31}$/u.test(value.planType)
    && [value.voidedBinCount, value.poolCount, value.quotaRowCount, value.usageEventCount,
      value.unpricedUsageEventCount, value.poisonedBinCount].every(cacheCount)
    && (value.quotaRowCount as number) <= 60_000 && (value.usageEventCount as number) + (value.unpricedUsageEventCount as number) <= 1_000_000
    && cacheInstant(value.latestQuotaObservedAt) && value.attributionStatus === "legacy_conditional"
    && (value.attributionMethod === method || method === V1_PLAN_ATTRIBUTION_ADAPTER_VERSION
      && value.attributionMethod === V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION)
    && value.inputFingerprint === fingerprint && validCompositionFit(value.fit);
}

export interface CommunityAnalysisCacheIdentity {
  participantId: string;
  source: LegacySource;
  sourcePin: CommunitySourcePin;
  fitFingerprint: string;
  fromDay: string;
  compositionSupported: boolean;
}

/** Reuse a completed v1 calculation without re-reading its chunk vector.
 * The durable acquisition head already pins that vector to the journal revision.
 * Both payloads and their fingerprints are still checked, so corrupt caches are
 * repaired instead of being hidden behind matching metadata. Other source kinds
 * keep their existing exact-pin path; this does not invent a successor adapter.
 */
export async function completedCommunityAnalysisCachesCurrent(db: D1Database,
  participantId: string, inputRevision: number, fromDay: string): Promise<boolean> {
  if (!Number.isSafeInteger(inputRevision) || inputRevision < 0) return false;
  const row = await db.prepare(`SELECT
      CASE WHEN length(CAST(f.fits_json AS BLOB)) <= ?7 THEN f.fits_json END AS fits_json,
      CASE WHEN length(CAST(c.composition_json AS BLOB)) <= ?8 THEN c.composition_json END AS composition_json,
      CASE WHEN length(f.input_fingerprint) = 64 THEN f.input_fingerprint END AS fit_fingerprint,
      CASE WHEN length(w.input_fingerprint) = 64 THEN w.input_fingerprint END AS input_fingerprint
    FROM community_analysis_work w
    JOIN participants p ON p.id = w.participant_id AND p.state = 'active' AND p.owner_kind = 'social'
    JOIN community_analytical_input_versions v ON v.participant_id = w.participant_id AND v.revision = ?2
    JOIN community_allowance_fit_cache f ON f.participant_id = w.participant_id
      AND f.cache_key = ?3 AND f.source_method_version = ?5
    JOIN community_model_composition_cache c ON c.participant_id = w.participant_id
      AND c.cache_key = ?4 AND c.source_method_version = ?5 AND c.input_fingerprint = w.input_fingerprint
    WHERE w.participant_id = ?1 AND w.input_revision = ?2 AND w.phase = 'complete'
      AND w.source_kind = 'v1' AND w.source_method_version = ?6 AND w.observed_at_cutoff = ?9
      AND NOT EXISTS (SELECT 1 FROM telemetry_v11_domain_heads WHERE participant_id = ?1)
      AND NOT EXISTS (SELECT 1 FROM telemetry_contributions
        WHERE participant_id = ?1 AND status = 'accepted' AND transport_schema_version = 'telemetry-contribution-v0.2')
    LIMIT 1`).bind(participantId, inputRevision,
      `v1:${inputRevision}:${fromDay}:${V1_FIT_CACHE_KEY_SUFFIX}`,
      `v1:${inputRevision}:${fromDay}:${COMPOSITION_CACHE_KEY_SUFFIX}`,
      COMMUNITY_ATTRIBUTION_METHOD_VERSION, V1_RESUMABLE_ATTRIBUTION_ADAPTER_VERSION,
      COMMUNITY_MODEL_CACHE_MAX_BYTES, COMPOSITION_CACHE_JSON_LIMIT_BYTES, `${fromDay}T00:00:00.000Z`)
    .first<{ fits_json: string | null; composition_json: string | null;
      fit_fingerprint: string | null; input_fingerprint: string | null }>();
  if (typeof row?.input_fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(row.input_fingerprint)
      || typeof row.fits_json !== "string" || typeof row.composition_json !== "string") return false;
  const expectedFitFingerprint = await sha256Hex(canonicalJson({
    methodVersion: COMMUNITY_ATTRIBUTION_METHOD_VERSION, v1: row.input_fingerprint, legacy: [],
  }));
  if (row.fit_fingerprint !== expectedFitFingerprint || parsedCachedFits(row.fits_json, participantId) === null) return false;
  try {
    return validCompleteCachedComposition(JSON.parse(row.composition_json), row.input_fingerprint,
      V1_PLAN_ATTRIBUTION_ADAPTER_VERSION);
  } catch { return false; }
}

/** Small exact cache probe for one scheduled participant. A matching revision
 * alone does not hide malformed cached output; the warmer can repair it.
 */
export async function communityAnalysisCachesCurrent(db: D1Database,
  identity: CommunityAnalysisCacheIdentity): Promise<boolean> {
  const { participantId, source, sourcePin, fitFingerprint, fromDay } = identity;
  const fitKey = sourceCacheKey(sourcePin, fromDay, V1_FIT_CACHE_KEY_SUFFIX, source);
  const fit = await db.prepare(`SELECT CASE WHEN length(CAST(fits_json AS BLOB)) <= ?5 THEN fits_json ELSE NULL END AS fits_json
    FROM community_allowance_fit_cache WHERE participant_id=?1 AND cache_key=?2 AND input_fingerprint=?3 AND source_method_version=?4`)
    .bind(participantId, fitKey, fitFingerprint, COMMUNITY_ATTRIBUTION_METHOD_VERSION, COMMUNITY_MODEL_CACHE_MAX_BYTES)
    .first<{ fits_json: string | null }>();
  if (typeof fit?.fits_json !== "string" || parsedCachedFits(fit.fits_json, participantId) === null) return false;
  if (!identity.compositionSupported) return true;
  const method = isV11Pin(sourcePin) ? V11_PLAN_ATTRIBUTION_ADAPTER_VERSION : V1_PLAN_ATTRIBUTION_ADAPTER_VERSION;
  const composition = await db.prepare(`SELECT CASE WHEN length(CAST(composition_json AS BLOB)) <= ?5
      THEN composition_json ELSE NULL END AS composition_json FROM community_model_composition_cache
    WHERE participant_id=?1 AND cache_key=?2 AND input_fingerprint=?3 AND source_method_version=?4`)
    .bind(participantId, sourceCacheKey(sourcePin, fromDay, COMPOSITION_CACHE_KEY_SUFFIX, isV11Pin(sourcePin) ? "v1.1" : "v1"),
      sourcePin.fingerprint, COMMUNITY_ATTRIBUTION_METHOD_VERSION, COMPOSITION_CACHE_JSON_LIMIT_BYTES)
    .first<{ composition_json: string | null }>();
  if (typeof composition?.composition_json !== "string") return false;
  try { return validCompleteCachedComposition(JSON.parse(composition.composition_json), sourcePin.fingerprint, method); }
  catch { return false; }
}

/** Both derived caches promote atomically under the same active-participant,
 * source-revision, successor-precedence and owned-maintenance-lease fence.
 * Neither a transient failure nor incomplete acquisition may call this API.
 */
export async function publishCommunityAnalysisCaches(db: D1Database,
  identity: CommunityAnalysisCacheIdentity, analyses: readonly { source: "v0.2" | "v1" | "v1.1"; analysis: object }[],
  composition: V1ModelCompositionResult | null, maintenanceLease: string,
  queueClaim?: CurrentAnalysisQueueClaim): Promise<boolean> {
  const { participantId, sourcePin, source, fromDay, fitFingerprint } = identity;
  const scopeMatches = isV11Pin(sourcePin) ? sourcePin.participantId === participantId
    : "participantId" in sourcePin.scope && sourcePin.scope.participantId === participantId && sourcePin.scope.fromDay === fromDay;
  if (!maintenanceLease || !scopeMatches
      || !Number.isSafeInteger(sourcePin.inputRevision) || sourcePin.inputRevision === null || sourcePin.inputRevision < 0
      || !/^[a-f0-9]{64}$/u.test(fitFingerprint)) throw new TypeError("community cache publication identity invalid");
  if (queueClaim && (queueClaim.participantId !== participantId || queueClaim.inputRevision !== sourcePin.inputRevision
    || queueClaim.method !== communityAnalysisCacheVersion()
    || queueClaim.day !== new Date(Date.parse(`${fromDay}T00:00:00.000Z`)
      + V1_ANALYSIS_WINDOW_DAYS * MILLISECONDS_PER_DAY).toISOString().slice(0, 10))) {
    throw new TypeError("community cache queue publication identity invalid");
  }
  const expectedSources = source === "mixed" ? ["v0.2", "v1"] : [source];
  if (analyses.length !== expectedSources.length || expectedSources.some(expected =>
    analyses.filter(input => input.source === expected).length !== 1)
    || analyses.some(({analysis,source:analyticalSource}) => !validCompleteScalarAnalysis(analysis, analyticalSource, sourcePin.fingerprint))) {
    throw new TypeError("only complete analytical results can be cached");
  }
  const fits = selectCommunityAllowanceAnalysisFits(participantId, analyses);
  const fitsJson = JSON.stringify(fits), compositionJson = composition === null ? null : JSON.stringify(composition);
  if (new TextEncoder().encode(fitsJson).byteLength > COMMUNITY_MODEL_CACHE_MAX_BYTES
      || parsedCachedFits(fitsJson, participantId) === null) return false;
  if (identity.compositionSupported && (composition === null || compositionJson === null
      || new TextEncoder().encode(compositionJson).byteLength > COMPOSITION_CACHE_JSON_LIMIT_BYTES
      || !validCompleteCachedComposition(composition, sourcePin.fingerprint, isV11Pin(sourcePin)
        ? V11_PLAN_ATTRIBUTION_ADAPTER_VERSION : V1_PLAN_ATTRIBUTION_ADAPTER_VERSION))) return false;
  if (!identity.compositionSupported && composition !== null) throw new TypeError("unsupported composition cache publication");
  await assertCommunitySourcePinCurrent(db, sourcePin);
  const guard = `EXISTS (SELECT 1 FROM participants p
      JOIN community_analytical_input_versions v ON v.participant_id=p.id
      WHERE p.id=?1 AND v.revision=?6
        AND EXISTS (SELECT 1 FROM community_public_source_owners public_source WHERE public_source.participant_id=p.id)
        AND EXISTS (SELECT 1 FROM telemetry_v11_domain_heads h WHERE h.participant_id=p.id)=?7)
    AND EXISTS (SELECT 1 FROM retention_state
      WHERE singleton=1 AND maintenance_lease_token=?8
        AND maintenance_lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
  const statements = [db.prepare(`INSERT INTO community_allowance_fit_cache
      (participant_id,cache_key,fits_json,computed_at,input_fingerprint,source_method_version)
    SELECT ?1,?2,?3,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?4,?5 WHERE ${guard}
    ON CONFLICT(participant_id) DO UPDATE SET cache_key=excluded.cache_key,fits_json=excluded.fits_json,
      computed_at=excluded.computed_at,input_fingerprint=excluded.input_fingerprint,source_method_version=excluded.source_method_version
    RETURNING participant_id`)
    .bind(participantId, sourceCacheKey(sourcePin, fromDay, V1_FIT_CACHE_KEY_SUFFIX, source), fitsJson,
      fitFingerprint, COMMUNITY_ATTRIBUTION_METHOD_VERSION, sourcePin.inputRevision, isV11Pin(sourcePin) ? 1 : 0, maintenanceLease)];
  if (identity.compositionSupported) statements.push(db.prepare(`INSERT INTO community_model_composition_cache
      (participant_id,cache_key,composition_json,computed_at,input_fingerprint,source_method_version)
    SELECT ?1,?2,?3,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?4,?5 WHERE ${guard}
    ON CONFLICT(participant_id) DO UPDATE SET cache_key=excluded.cache_key,composition_json=excluded.composition_json,
      computed_at=excluded.computed_at,input_fingerprint=excluded.input_fingerprint,source_method_version=excluded.source_method_version
    RETURNING participant_id`)
    .bind(participantId, sourceCacheKey(sourcePin, fromDay, COMPOSITION_CACHE_KEY_SUFFIX, isV11Pin(sourcePin) ? "v1.1" : "v1"),
      compositionJson, sourcePin.fingerprint, COMMUNITY_ATTRIBUTION_METHOD_VERSION, sourcePin.inputRevision,
      isV11Pin(sourcePin) ? 1 : 0, maintenanceLease));
  // Recheck inside the SAME transaction, including time expiry between the
  // two writes. A failed condition must roll back an earlier successful write,
  // not merely turn the second INSERT into a no-op. The existing NOT NULL
  // constraint is an assertion; no null value can become durable.
  statements.push(db.prepare(`UPDATE community_allowance_fit_cache
    SET fits_json=CASE WHEN ${guard} THEN fits_json ELSE NULL END WHERE participant_id=?1 RETURNING participant_id`)
    .bind(participantId, null, null, null, null, sourcePin.inputRevision, isV11Pin(sourcePin) ? 1 : 0, maintenanceLease));
  if (queueClaim) {
    const queue = currentAnalysisPublicationStatements(db, queueClaim, maintenanceLease);
    statements.unshift(queue.before);
    statements.push(queue.after);
  }
  try {
    const results = await db.batch<{ participant_id: string }>(statements);
    // D1 change counts include receipt-trigger effects. RETURNING attests the
    // exact authorized top-level row instead; every write and the final
    // in-transaction authority assertion must identify this participant once.
    return results.length === statements.length && results.every(result =>
      result.results.length === 1 && result.results[0]?.participant_id === participantId);
  } catch (error) {
    if (error instanceof Error && error.message.includes("NOT NULL constraint failed: community_allowance_fit_cache.fits_json")) return false;
    if (queueClaim && error instanceof Error && error.message.includes("CHECK constraint failed: dirty_generation")) return false;
    if (queueClaim && error instanceof Error
      && error.message.includes("NOT NULL constraint failed: community_current_analysis_queue.pending")) return false;
    throw error;
  }
}

/** SELECT-only complete-cohort composition evidence. The 1,024 physical-row
 * ceiling is a resource limit causing whole-cohort deferral, never an admission
 * rule or permission to publish a prefix. Scheduler integration must supply the
 * same budget used by the rest of that invocation; no caller is wired yet.
 */
export async function readCachedCommunityModelCompositions(
  db: D1Database, nowMs: number = Date.now(),
  options: { budget?: CommunityModelCacheReadBudget; pageSize?: number; maxPages?: number; maxBytes?: number } = {},
): Promise<CachedCommunityModelCompositions | null> {
  const pageSize = options.pageSize ?? COMMUNITY_MODEL_CACHE_PAGE_SIZE;
  const maxPages = options.maxPages ?? COMMUNITY_MODEL_CACHE_MAX_PAGES;
  const maxBytes = options.maxBytes ?? COMMUNITY_MODEL_CACHE_MAX_BYTES;
  const budget = options.budget ?? { remainingQueries: COMMUNITY_MODEL_CACHE_MAX_QUERIES, deadlineMs: Date.now() + 30_000 };
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > COMMUNITY_MODEL_CACHE_PAGE_SIZE
      || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > COMMUNITY_MODEL_CACHE_MAX_PAGES
      || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > COMMUNITY_MODEL_CACHE_MAX_BYTES) return null;
  const charge = (): boolean => {
    const reserve = budget.reserveQueries ?? 0;
    const now = (budget.now ?? Date.now)();
    if (!cacheCount(budget.remainingQueries) || !cacheCount(reserve) || !Number.isFinite(budget.deadlineMs)
        || !Number.isFinite(now) || now >= budget.deadlineMs || budget.remainingQueries - reserve < 1) return false;
    budget.remainingQueries -= 1;
    return true;
  };
  const epoch = async (): Promise<number | null> => {
    if (!charge()) return null;
    const row = await db.prepare("SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id = 1")
      .first<{ mutation_epoch: number }>();
    return cacheCount(row?.mutation_epoch) ? row!.mutation_epoch : null;
  };
  try {
    const initialEpoch = await epoch();
    if (initialEpoch === null) return null;
    const fromDay = analysisFromDay(nowMs);
    const result: CachedCommunityModelCompositions = { compositions: [], v1ParticipantCount: 0,
      unsupportedSourceParticipantCount: 0, refusedParticipantCount: 0, storeAvailable: true };
    let cursor = "", bytes = 0;
    for (let page = 0; page < maxPages; page++) {
      if (!charge()) return null;
      const rows = (await db.prepare(CACHED_COMMUNITY_MODEL_COMPOSITIONS_PAGE_SQL)
        .bind(cursor, pageSize + 1, `${fromDay}T00:00:00.000Z`, COMPOSITION_CACHE_JSON_LIMIT_BYTES)
        .all<CachedModelPageRow>()).results;
      if (!Array.isArray(rows) || rows.length > pageSize + 1) return null;
      let previous = cursor;
      for (const row of rows) {
        if (typeof row.participant_id !== "string" || row.participant_id.length < 1 || row.participant_id.length > 128
            || row.participant_id <= previous || !["active", "deleting"].includes(row.state)) return null;
        previous = row.participant_id;
      }
      for (const row of rows.slice(0, pageSize)) {
        cursor = row.participant_id;
        if (row.state !== "active") continue;
        if (![row.has_legacy, row.has_v1, row.has_v11, row.legacy_overlap].every(flag => flag === 0 || flag === 1)) return null;
        if (row.has_legacy === 0 && row.has_v1 === 0 && row.has_v11 === 0) continue;
        if (!cacheCount(row.input_revision)) return null;
        if (row.has_v11 === 0 && (row.has_v1 === 0 || row.legacy_overlap === 1)) {
          result.unsupportedSourceParticipantCount += 1;
          continue;
        }
        const source = row.has_v11 === 1 ? "v1.1" : "v1";
        if (row.cache_key !== `${source}:${row.input_revision}:${fromDay}:${COMPOSITION_CACHE_KEY_SUFFIX}`
            || row.source_method_version !== COMMUNITY_ATTRIBUTION_METHOD_VERSION
            || typeof row.input_fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(row.input_fingerprint)
            || typeof row.composition_json !== "string") return null;
        const rowBytes = new TextEncoder().encode(row.composition_json).byteLength;
        if (rowBytes > COMPOSITION_CACHE_JSON_LIMIT_BYTES || (bytes += rowBytes) > maxBytes) return null;
        const value: unknown = JSON.parse(row.composition_json);
        if (!validCompleteCachedComposition(value, row.input_fingerprint, source === "v1.1"
          ? V11_PLAN_ATTRIBUTION_ADAPTER_VERSION : V1_PLAN_ATTRIBUTION_ADAPTER_VERSION)) return null;
        result.v1ParticipantCount += 1;
        if (value.status === "ready") result.compositions.push({ participantId: row.participant_id, composition: value });
        else result.refusedParticipantCount += 1;
      }
      if (rows.length <= pageSize) return await epoch() === initialEpoch ? result : null;
    }
    return null;
  } catch {
    // Missing store, invalid JSON, source churn and transport failures all defer.
    return null;
  }
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
  // Without the 0042 store, every warm pass would silently re-run the full
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
      // The cache is a pure optimization; migration 0042 may not be applied
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
                 WHERE v.participant_id = ?1 AND v.revision = ?6
                   AND EXISTS (SELECT 1 FROM community_public_source_owners p WHERE p.participant_id = v.participant_id)
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
