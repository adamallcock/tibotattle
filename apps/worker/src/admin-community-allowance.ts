import {
  COMMUNITY_ALLOWANCE_PERSONAL_PLAN_CONFIG,
  COMMUNITY_ALLOWANCE_QUALIFICATION,
  COMMUNITY_ALLOWANCE_RECONSTRUCTABLE_DAYS,
  COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP,
  COMMUNITY_ALLOWANCE_TRAILING_DAYS,
  readCachedCommunityAllowanceCorpus,
  summarizeCommunityAllowanceFits,
} from "./community-allowance";
import type { CommunityAllowanceFit } from "./community-allowance";
import { ApiError } from "./errors";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const MINIMUM_FITS_FOR_BAND = 3;
// The preview is roughly 70 small aggregate rows. Keep its ceiling well below
// D1's value limit and enforce it before both cache writes and reads.
const PREVIEW_CACHE_JSON_LIMIT_BYTES = 128 * 1_024;
// Scheduled maintenance runs every minute but only rebuilds this aggregate
// about hourly. Two hours tolerates one missed Cron without serving it forever.
const PREVIEW_CACHE_MIN_INTERVAL_MILLISECONDS = 55 * 60 * 1_000;
const PREVIEW_CACHE_MAX_AGE_MILLISECONDS = 2 * 60 * 60 * 1_000;
const PREVIEW_CACHE_MAX_FUTURE_SKEW_MILLISECONDS = 5 * 60 * 1_000;

export const ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_SCHEMA_VERSION =
  "admin-community-allowance-preview-v0.1";
export const ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_BASIS =
  "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d_preview";

/**
 * The v1 analyzer exposes a trailing 100-day fit corpus. Each historical point
 * itself needs the preceding 30 days, so only the newest 70 days can be
 * recomputed from today's corpus without silently shortening an older point's
 * evidence window.
 */
export const ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS =
  COMMUNITY_ALLOWANCE_RECONSTRUCTABLE_DAYS;

export const ADMIN_COMMUNITY_ALLOWANCE_PLAN_CONFIG =
  COMMUNITY_ALLOWANCE_PERSONAL_PLAN_CONFIG;

type AdminCommunityAllowancePlanType =
  (typeof ADMIN_COMMUNITY_ALLOWANCE_PLAN_CONFIG)[number]["planType"];

export interface AdminCommunityAllowanceSummary {
  readonly fitCount: number;
  readonly participantCount: number;
  readonly centralUsd: number | null;
  readonly band80Usd: {
    readonly lowerUsd: number;
    readonly upperUsd: number;
  } | null;
}

export interface AdminCommunityAllowancePreviewDay {
  readonly day: string;
  readonly combined: AdminCommunityAllowanceSummary;
  readonly byPlanType: Readonly<Record<
    AdminCommunityAllowancePlanType,
    AdminCommunityAllowanceSummary
  >>;
}

export interface AdminCommunityAllowanceCoverage {
  readonly uploadingParticipantCount: number;
  readonly cachedParticipantCount: number;
  readonly recentFittedParticipantCount: number;
  readonly mergeEligibleParticipantCount: number;
  readonly noQualifyingFitParticipantCount: number;
  readonly noRecentFitParticipantCount: number;
  readonly unsupportedPlanParticipantCount: number;
}

export interface AdminCommunityAllowancePreview {
  readonly schemaVersion:
    typeof ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly from: string;
  readonly to: string;
  readonly basis: typeof ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_BASIS;
  readonly referencePlanType: "pro";
  readonly trailingDays: typeof COMMUNITY_ALLOWANCE_TRAILING_DAYS;
  readonly qualification: typeof COMMUNITY_ALLOWANCE_QUALIFICATION;
  readonly spanFloorPp: typeof COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP;
  readonly plans: typeof ADMIN_COMMUNITY_ALLOWANCE_PLAN_CONFIG;
  readonly coverage: AdminCommunityAllowanceCoverage;
  readonly days: readonly AdminCommunityAllowancePreviewDay[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(epoch)
    && new Date(epoch).toISOString().slice(0, 10) === value;
}

function validSummary(value: unknown): value is AdminCommunityAllowanceSummary {
  const summary = record(value);
  if (summary === null || !exactKeys(summary, [
    "fitCount",
    "participantCount",
    "centralUsd",
    "band80Usd",
  ]) || !validCount(summary.fitCount)
      || !validCount(summary.participantCount)
      || summary.participantCount > summary.fitCount) {
    return false;
  }
  if (summary.fitCount === 0) {
    return summary.participantCount === 0
      && summary.centralUsd === null
      && summary.band80Usd === null;
  }
  if (summary.participantCount === 0
      || !validFiniteNonNegative(summary.centralUsd)) return false;
  if (summary.fitCount < MINIMUM_FITS_FOR_BAND) {
    return summary.band80Usd === null;
  }
  const band = record(summary.band80Usd);
  return band !== null
    && exactKeys(band, ["lowerUsd", "upperUsd"])
    && validFiniteNonNegative(band.lowerUsd)
    && validFiniteNonNegative(band.upperUsd)
    && band.lowerUsd <= summary.centralUsd
    && summary.centralUsd <= band.upperUsd;
}

function validCachedAdminCommunityAllowancePreview(
  value: unknown,
  storedGeneratedAt: string,
  nowEpoch: number,
): value is AdminCommunityAllowancePreview {
  if (!Number.isFinite(nowEpoch)) return false;
  const preview = record(value);
  if (preview === null || !exactKeys(preview, [
    "schemaVersion",
    "generatedAt",
    "from",
    "to",
    "basis",
    "referencePlanType",
    "trailingDays",
    "qualification",
    "spanFloorPp",
    "plans",
    "coverage",
    "days",
  ]) || preview.schemaVersion !== ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_SCHEMA_VERSION
      || preview.generatedAt !== storedGeneratedAt
      || !validIsoTimestamp(preview.generatedAt)
      || preview.basis !== ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_BASIS
      || preview.referencePlanType !== "pro"
      || preview.trailingDays !== COMMUNITY_ALLOWANCE_TRAILING_DAYS
      || preview.qualification !== COMMUNITY_ALLOWANCE_QUALIFICATION
      || preview.spanFloorPp !== COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP) {
    return false;
  }
  const generatedEpoch = Date.parse(preview.generatedAt);
  if (generatedEpoch > nowEpoch + PREVIEW_CACHE_MAX_FUTURE_SKEW_MILLISECONDS
      || nowEpoch - generatedEpoch > PREVIEW_CACHE_MAX_AGE_MILLISECONDS) {
    return false;
  }

  if (!Array.isArray(preview.plans)
      || preview.plans.length !== ADMIN_COMMUNITY_ALLOWANCE_PLAN_CONFIG.length) {
    return false;
  }
  for (const [index, expected] of ADMIN_COMMUNITY_ALLOWANCE_PLAN_CONFIG.entries()) {
    const plan = record(preview.plans[index]);
    if (plan === null
        || !exactKeys(plan, ["planType", "label", "multiplier"])
        || plan.planType !== expected.planType
        || plan.label !== expected.label
        || plan.multiplier !== expected.multiplier) {
      return false;
    }
  }

  const coverage = record(preview.coverage);
  const coverageKeys = [
    "uploadingParticipantCount",
    "cachedParticipantCount",
    "recentFittedParticipantCount",
    "mergeEligibleParticipantCount",
    "noQualifyingFitParticipantCount",
    "noRecentFitParticipantCount",
    "unsupportedPlanParticipantCount",
  ] as const;
  if (coverage === null || !exactKeys(coverage, coverageKeys)
      || coverageKeys.some((key) => !validCount(coverage[key]))) {
    return false;
  }
  const uploading = coverage.uploadingParticipantCount as number;
  const cached = coverage.cachedParticipantCount as number;
  const recent = coverage.recentFittedParticipantCount as number;
  const eligible = coverage.mergeEligibleParticipantCount as number;
  const noQualifying = coverage.noQualifyingFitParticipantCount as number;
  const noRecent = coverage.noRecentFitParticipantCount as number;
  const unsupported = coverage.unsupportedPlanParticipantCount as number;
  if (cached !== uploading
      || recent !== eligible + unsupported
      || uploading !== noQualifying + noRecent + recent) {
    return false;
  }

  if (!validDay(preview.from)
      || !validDay(preview.to)
      || preview.to !== preview.generatedAt.slice(0, 10)
      || !Array.isArray(preview.days)
      || preview.days.length !== ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS) {
    return false;
  }
  const fromEpoch = Date.parse(`${preview.from}T00:00:00.000Z`);
  const expectedFromEpoch = Date.parse(`${preview.to}T00:00:00.000Z`)
    - (ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS - 1) * MILLISECONDS_PER_DAY;
  if (fromEpoch !== expectedFromEpoch) return false;

  for (const [index, candidate] of preview.days.entries()) {
    const day = record(candidate);
    const expectedDay = new Date(fromEpoch + index * MILLISECONDS_PER_DAY)
      .toISOString().slice(0, 10);
    if (day === null
        || !exactKeys(day, ["day", "combined", "byPlanType"])
        || day.day !== expectedDay
        || !validSummary(day.combined)) {
      return false;
    }
    const byPlan = record(day.byPlanType);
    if (byPlan === null || !exactKeys(
      byPlan,
      ADMIN_COMMUNITY_ALLOWANCE_PLAN_CONFIG.map((plan) => plan.planType),
    )) {
      return false;
    }
    const summaries: AdminCommunityAllowanceSummary[] = [];
    for (const plan of ADMIN_COMMUNITY_ALLOWANCE_PLAN_CONFIG) {
      const summary = byPlan[plan.planType];
      if (!validSummary(summary)) return false;
      summaries.push(summary);
    }
    const fitCount = summaries.reduce((sum, summary) => sum + summary.fitCount, 0);
    const participantCount = summaries.reduce(
      (sum, summary) => sum + summary.participantCount,
      0,
    );
    const largestPlanParticipantCount = Math.max(
      ...summaries.map((summary) => summary.participantCount),
    );
    if (!Number.isSafeInteger(fitCount)
        || !Number.isSafeInteger(participantCount)
        || day.combined.fitCount !== fitCount
        || day.combined.participantCount < largestPlanParticipantCount
        || day.combined.participantCount > participantCount) {
      return false;
    }
  }
  const latest = record(preview.days.at(-1));
  const latestCombined = record(latest?.combined);
  return latestCombined !== null
    && latestCombined.participantCount === eligible;
}

function summarizeFits(
  fits: readonly CommunityAllowanceFit[],
  multiplier: number | ((fit: CommunityAllowanceFit) => number),
): AdminCommunityAllowanceSummary {
  return summarizeCommunityAllowanceFits(fits, multiplier);
}

function previewDay(
  fits: readonly CommunityAllowanceFit[],
  day: string,
): AdminCommunityAllowancePreviewDay {
  const dayStartMs = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(dayStartMs)) {
    throw new Error("invalid admin community allowance preview day");
  }
  const windowEndMs = dayStartMs + MILLISECONDS_PER_DAY;
  const windowStartMs = windowEndMs
    - COMMUNITY_ALLOWANCE_TRAILING_DAYS * MILLISECONDS_PER_DAY;
  const inWindow = fits.filter((fit) => {
    const observedMs = Date.parse(fit.lastObservedAt);
    return observedMs > windowStartMs && observedMs <= windowEndMs;
  });
  const planConfig = new Map(
    ADMIN_COMMUNITY_ALLOWANCE_PLAN_CONFIG.map((plan) => [plan.planType, plan]),
  );
  const eligible = inWindow.filter((fit) => planConfig.has(
    fit.planType as AdminCommunityAllowancePlanType,
  ));
  const byPlanType = Object.fromEntries(
    ADMIN_COMMUNITY_ALLOWANCE_PLAN_CONFIG.map((plan) => [
      plan.planType,
      summarizeFits(
        eligible.filter((fit) => fit.planType === plan.planType),
        plan.multiplier,
      ),
    ]),
  ) as Record<AdminCommunityAllowancePlanType, AdminCommunityAllowanceSummary>;
  return Object.freeze({
    day,
    combined: summarizeFits(eligible, (fit) => (
      planConfig.get(fit.planType as AdminCommunityAllowancePlanType)?.multiplier
        ?? 0
    )),
    byPlanType: Object.freeze(byPlanType),
  });
}

/**
 * Pure, production-shaped preview builder. It intentionally does not mutate or
 * publish community_daily_aggregates: the merged basis remains owner-only
 * until its admin trial has been reviewed.
 */
export function buildAdminCommunityAllowancePreview(
  fits: readonly CommunityAllowanceFit[],
  nowMs: number,
  participantIds: readonly string[] = [
    ...new Set(fits.map((fit) => fit.participantId)),
  ],
): AdminCommunityAllowancePreview {
  if (!Number.isFinite(nowMs)) {
    throw new Error("invalid admin community allowance preview time");
  }
  const to = new Date(nowMs).toISOString().slice(0, 10);
  const toStartMs = Date.parse(`${to}T00:00:00.000Z`);
  const fromStartMs = toStartMs
    - (ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS - 1) * MILLISECONDS_PER_DAY;
  const cohort = [...new Set(participantIds)].sort();
  if (cohort.some((participantId) => (
    typeof participantId !== "string" || participantId.length === 0
  ))) {
    throw new Error("invalid admin community allowance preview cohort");
  }
  const cohortSet = new Set(cohort);
  if (fits.some((fit) => !cohortSet.has(fit.participantId))) {
    throw new Error("admin community allowance fit outside preview cohort");
  }
  const windowEndMs = toStartMs + MILLISECONDS_PER_DAY;
  const windowStartMs = windowEndMs
    - COMMUNITY_ALLOWANCE_TRAILING_DAYS * MILLISECONDS_PER_DAY;
  const eligiblePlans = new Set<string>(
    ADMIN_COMMUNITY_ALLOWANCE_PLAN_CONFIG.map((plan) => plan.planType),
  );
  const fitsByParticipant = new Map<string, CommunityAllowanceFit[]>();
  for (const fit of fits) {
    const bucket = fitsByParticipant.get(fit.participantId);
    if (bucket) bucket.push(fit);
    else fitsByParticipant.set(fit.participantId, [fit]);
  }
  let recentFittedParticipantCount = 0;
  let mergeEligibleParticipantCount = 0;
  let noQualifyingFitParticipantCount = 0;
  let noRecentFitParticipantCount = 0;
  let unsupportedPlanParticipantCount = 0;
  for (const participantId of cohort) {
    const participantFits = fitsByParticipant.get(participantId) ?? [];
    if (participantFits.length === 0) {
      noQualifyingFitParticipantCount += 1;
      continue;
    }
    const recentFits = participantFits.filter((fit) => {
      const observedMs = Date.parse(fit.lastObservedAt);
      return observedMs > windowStartMs && observedMs <= windowEndMs;
    });
    if (recentFits.length === 0) {
      noRecentFitParticipantCount += 1;
      continue;
    }
    recentFittedParticipantCount += 1;
    if (recentFits.some((fit) => eligiblePlans.has(fit.planType))) {
      mergeEligibleParticipantCount += 1;
    } else {
      unsupportedPlanParticipantCount += 1;
    }
  }
  const coverage = Object.freeze({
    uploadingParticipantCount: cohort.length,
    // The endpoint fails closed unless every selected uploader has a current,
    // validated cache row, so a successful preview is fully cache-covered.
    cachedParticipantCount: cohort.length,
    recentFittedParticipantCount,
    mergeEligibleParticipantCount,
    noQualifyingFitParticipantCount,
    noRecentFitParticipantCount,
    unsupportedPlanParticipantCount,
  });
  const days = Array.from(
    { length: ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS },
    (_, index) => previewDay(
      fits,
      new Date(fromStartMs + index * MILLISECONDS_PER_DAY)
        .toISOString()
        .slice(0, 10),
    ),
  );
  return Object.freeze({
    schemaVersion: ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    from: days[0]!.day,
    to,
    basis: ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_BASIS,
    referencePlanType: "pro",
    trailingDays: COMMUNITY_ALLOWANCE_TRAILING_DAYS,
    qualification: COMMUNITY_ALLOWANCE_QUALIFICATION,
    spanFloorPp: COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP,
    plans: ADMIN_COMMUNITY_ALLOWANCE_PLAN_CONFIG,
    coverage,
    days: Object.freeze(days),
  });
}

/**
 * Scheduled-only preview source. The fit-corpus reader is SELECT-only but may
 * scan the active cache corpus, so browser requests must never call this path.
 */
export async function buildAdminCommunityAllowancePreviewFromSource(
  db: D1Database,
  nowMs: number = Date.now(),
): Promise<AdminCommunityAllowancePreview | null> {
  const corpus = await readCachedCommunityAllowanceCorpus(db);
  return corpus === null
    ? null
    : buildAdminCommunityAllowancePreview(
      corpus.fits,
      nowMs,
      corpus.participantIds,
    );
}

function previewCacheUnavailable(): never {
  throw new ApiError(503, "ADMIN_ALLOWANCE_CACHE_UNAVAILABLE");
}

/**
 * The interactive owner route's entire post-authentication data path: one
 * bounded SELECT from a singleton aggregate cache. Missing, stale, oversized,
 * or malformed content fails closed; it never falls through to fit evidence.
 */
export async function readCachedAdminCommunityAllowancePreview(
  db: D1Database,
  nowEpoch: number,
): Promise<AdminCommunityAllowancePreview> {
  let row: { generated_at: string; payload_json: string } | null;
  try {
    row = await db.prepare(
      `SELECT generated_at, payload_json
         FROM admin_community_allowance_preview_cache
        WHERE singleton = 1 AND length(payload_json) <= ?1
        LIMIT 1`,
    ).bind(PREVIEW_CACHE_JSON_LIMIT_BYTES)
      .first<{ generated_at: string; payload_json: string }>();
  } catch {
    return previewCacheUnavailable();
  }
  if (row === null
      || typeof row.generated_at !== "string"
      || typeof row.payload_json !== "string"
      || new TextEncoder().encode(row.payload_json).byteLength
        > PREVIEW_CACHE_JSON_LIMIT_BYTES) {
    return previewCacheUnavailable();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json);
  } catch {
    return previewCacheUnavailable();
  }
  if (!validCachedAdminCommunityAllowancePreview(
    parsed,
    row.generated_at,
    nowEpoch,
  )) {
    return previewCacheUnavailable();
  }
  return parsed;
}

export interface AdminCommunityAllowancePreviewCacheResult {
  readonly code:
    | "ALLOWANCE_PREVIEW_CACHE_REFRESHED"
    | "ALLOWANCE_PREVIEW_CACHE_CURRENT"
    | "ALLOWANCE_PREVIEW_CACHE_UNAVAILABLE";
}

/**
 * Scheduled-only cache materialization. A valid fresh singleton self-throttles
 * the source read. Otherwise maintenance builds the real preview from the
 * existing validated SELECT-only fit-cache path and atomically replaces one
 * bounded aggregate row. Every failure is reported as data, never thrown into
 * the retention/publication maintenance pass.
 */
export async function warmAdminCommunityAllowancePreviewCache(
  db: D1Database,
  nowEpoch: number,
): Promise<AdminCommunityAllowancePreviewCacheResult> {
  try {
    const existing = await db.prepare(
      `SELECT generated_at, payload_json
         FROM admin_community_allowance_preview_cache
        WHERE singleton = 1 AND length(payload_json) <= ?1
        LIMIT 1`,
    ).bind(PREVIEW_CACHE_JSON_LIMIT_BYTES)
      .first<{ generated_at: string; payload_json: string }>();
    if (existing !== null
        && typeof existing.generated_at === "string"
        && typeof existing.payload_json === "string"
        && new TextEncoder().encode(existing.payload_json).byteLength
          <= PREVIEW_CACHE_JSON_LIMIT_BYTES) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(existing.payload_json);
      } catch {
        // A corrupt current row is rebuilt immediately rather than retained
        // until its timestamp ages past the refresh interval.
      }
      const existingEpoch = Date.parse(existing.generated_at);
      if (Number.isFinite(existingEpoch)
          && nowEpoch - existingEpoch < PREVIEW_CACHE_MIN_INTERVAL_MILLISECONDS
          && validCachedAdminCommunityAllowancePreview(
            parsed,
            existing.generated_at,
            nowEpoch,
          )) {
        return { code: "ALLOWANCE_PREVIEW_CACHE_CURRENT" };
      }
    }

    const preview = await buildAdminCommunityAllowancePreviewFromSource(
      db,
      nowEpoch,
    );
    if (preview === null) {
      return { code: "ALLOWANCE_PREVIEW_CACHE_UNAVAILABLE" };
    }
    const payloadJson = JSON.stringify(preview);
    if (new TextEncoder().encode(payloadJson).byteLength
          > PREVIEW_CACHE_JSON_LIMIT_BYTES
        || !validCachedAdminCommunityAllowancePreview(
          preview,
          preview.generatedAt,
          nowEpoch,
        )) {
      return { code: "ALLOWANCE_PREVIEW_CACHE_UNAVAILABLE" };
    }
    const write = await db.prepare(
      `INSERT INTO admin_community_allowance_preview_cache (
         singleton, generated_at, payload_json
       ) VALUES (1, ?1, ?2)
       ON CONFLICT(singleton) DO UPDATE SET
         generated_at = excluded.generated_at,
         payload_json = excluded.payload_json`,
    ).bind(preview.generatedAt, payloadJson).run();
    return write.meta.changes === 1
      ? { code: "ALLOWANCE_PREVIEW_CACHE_REFRESHED" }
      : { code: "ALLOWANCE_PREVIEW_CACHE_UNAVAILABLE" };
  } catch {
    return { code: "ALLOWANCE_PREVIEW_CACHE_UNAVAILABLE" };
  }
}
