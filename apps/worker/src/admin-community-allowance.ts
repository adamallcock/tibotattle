import {
  COMMUNITY_ALLOWANCE_QUALIFICATION,
  COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP,
  COMMUNITY_ALLOWANCE_TRAILING_DAYS,
  readCachedCommunityAllowanceFits,
} from "./community-allowance";
import type { CommunityAllowanceFit } from "./community-allowance";
import { V1_ANALYSIS_WINDOW_DAYS } from "./quota-analysis-v1";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const NANOUSD_PER_USD = 1_000_000_000;
const MINIMUM_FITS_FOR_BAND = 3;

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
  V1_ANALYSIS_WINDOW_DAYS - COMMUNITY_ALLOWANCE_TRAILING_DAYS;

export const ADMIN_COMMUNITY_ALLOWANCE_PLAN_CONFIG = Object.freeze([
  Object.freeze({ planType: "pro", label: "Pro 20x", multiplier: 1 }),
  Object.freeze({ planType: "prolite", label: "Pro 5x", multiplier: 4 }),
  Object.freeze({ planType: "plus", label: "Plus", multiplier: 20 }),
] as const);

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
  readonly days: readonly AdminCommunityAllowancePreviewDay[];
}

function quantile(values: readonly number[], probability: number): number | null {
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
  return Math.round((nanousd / NANOUSD_PER_USD + Number.EPSILON) * 10_000)
    / 10_000;
}

function summarizeFits(
  fits: readonly CommunityAllowanceFit[],
  multiplier: number | ((fit: CommunityAllowanceFit) => number),
): AdminCommunityAllowanceSummary {
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
): AdminCommunityAllowancePreview {
  if (!Number.isFinite(nowMs)) {
    throw new Error("invalid admin community allowance preview time");
  }
  const to = new Date(nowMs).toISOString().slice(0, 10);
  const toStartMs = Date.parse(`${to}T00:00:00.000Z`);
  const fromStartMs = toStartMs
    - (ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS - 1) * MILLISECONDS_PER_DAY;
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
    days: Object.freeze(days),
  });
}

export async function readAdminCommunityAllowancePreview(
  db: D1Database,
  nowMs: number = Date.now(),
): Promise<AdminCommunityAllowancePreview | null> {
  const fits = await readCachedCommunityAllowanceFits(db);
  return fits === null ? null : buildAdminCommunityAllowancePreview(fits, nowMs);
}
