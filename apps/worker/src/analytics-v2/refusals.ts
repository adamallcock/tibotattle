/**
 * analytics-v2 refusals (A-2): explicit, closed records of every owner, day
 * and family the fast path did not compute.
 *
 * A refusal is never converted to zero or to inferred continuity: the refused
 * owner-day or evaluation is left out of every community figure that would
 * need it, and the refusal itself travels in AnalyticsV2RunOutputs. Only the
 * closed reasons in contract.ts may appear. A kernel refusal with a reason the
 * contract does not list is rethrown rather than renamed, because a new
 * reason is a contract change through the integration lead.
 */
import { SharedAnalyticsUnavailable } from "../../vendor/analytics-d43c8f92/entry";
import {
  ANALYTICS_V2_DAY_PATTERN,
  ANALYTICS_V2_OWNER_DIGEST_PATTERN,
  ANALYTICS_V2_REFUSAL_FAMILIES,
  ANALYTICS_V2_REFUSAL_REASONS,
  type AnalyticsV2Day,
  type AnalyticsV2OwnerDigest,
  type AnalyticsV2Refusal,
  type AnalyticsV2RefusalFamily,
  type AnalyticsV2RefusalReason,
} from "./contract";

const REASONS: ReadonlySet<string> = new Set(ANALYTICS_V2_REFUSAL_REASONS);
const FAMILY_ORDER = new Map<string, number>(ANALYTICS_V2_REFUSAL_FAMILIES.map((family, index) => [family, index]));

export function isAnalyticsV2RefusalReason(value: unknown): value is AnalyticsV2RefusalReason {
  return typeof value === "string" && REASONS.has(value);
}

/** Build one validated refusal. Owner-family refusals carry day null. */
export function analyticsV2Refusal(ownerDigest: AnalyticsV2OwnerDigest, day: AnalyticsV2Day | null,
  family: AnalyticsV2RefusalFamily, reason: AnalyticsV2RefusalReason): AnalyticsV2Refusal {
  if (!ANALYTICS_V2_OWNER_DIGEST_PATTERN.test(ownerDigest) || !FAMILY_ORDER.has(family)
    || !isAnalyticsV2RefusalReason(reason) || (family === "owner") !== (day === null)
    || (day !== null && !ANALYTICS_V2_DAY_PATTERN.test(day))) {
    throw new TypeError("ANALYTICS_V2_REFUSAL_INVALID");
  }
  return Object.freeze({ ownerDigest, day, family, reason });
}

/**
 * The closed reason of a kernel refusal, or null when `error` is not a
 * refusal at all. SharedAnalyticsUnavailable covers every shared-reducer
 * refusal, including the checkedRows conflict/order throw
 * (source_conflict_or_order). Any other error is a defect the caller rethrows.
 */
export function kernelRefusalReason(error: unknown): AnalyticsV2RefusalReason | null {
  if (!(error instanceof SharedAnalyticsUnavailable)) return null;
  if (!isAnalyticsV2RefusalReason(error.reason)) throw error;
  return error.reason;
}

/** Deterministic order: owner, owner-level first then day, family, reason. */
export function compareAnalyticsV2Refusals(left: AnalyticsV2Refusal, right: AnalyticsV2Refusal): number {
  if (left.ownerDigest !== right.ownerDigest) return left.ownerDigest < right.ownerDigest ? -1 : 1;
  if (left.day !== right.day) {
    if (left.day === null) return -1;
    if (right.day === null) return 1;
    return left.day < right.day ? -1 : 1;
  }
  const family = FAMILY_ORDER.get(left.family)! - FAMILY_ORDER.get(right.family)!;
  if (family !== 0) return family;
  return left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0;
}
