/** Historical publication continuity, never evidence of current pricing.
 * Kernel 10's closed spend contract before 9e78ecb3d re-vendored v0.6/v0.9.
 * Callers must additionally prove the head, kernel and current exclusions.
 */
export const KERNEL10_SPEND_METHOD = "server-api-price-equivalent-v0.5";
export const KERNEL10_SPEND_REGISTRY = "48119389ecbcaced58837bc24fa852c3c4a99835289b417e69f34fb0166a63b9";
const BASIS = "reported_usage_event_time_api_price_equivalent_v1";
const CAPACITY_POLICY = "daily-spend-capacity-2048-chunks-200000-events";
const NORMAL_KEYS = ["basis", "currency", "knownCostUsd", "coverage", "usageEvents", "fullyPricedUsageEvents",
  "partiallyPricedUsageEvents", "unpricedUsageEvents", "pricingMethodVersion", "registrySha256"];

/** Validate the original block without changing its amount or identity. */
export function isKernel10PublishedSpend(value: unknown, usageEvents: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const spend = value as Record<string, unknown>;
  const unprocessed = spend.unprocessedUsageEvents ?? 0;
  const limited = typeof unprocessed === "number" && unprocessed > 0;
  const keys = limited ? [...NORMAL_KEYS, "unprocessedUsageEvents", "unavailableReason", "processingPolicyVersion"] : NORMAL_KEYS;
  if (Object.keys(spend).length !== keys.length || keys.some(key => !Object.hasOwn(spend, key))
      || spend.basis !== BASIS || spend.currency !== "USD"
      || spend.pricingMethodVersion !== KERNEL10_SPEND_METHOD || spend.registrySha256 !== KERNEL10_SPEND_REGISTRY
      || spend.usageEvents !== usageEvents) return false;
  const counts = [spend.usageEvents, spend.fullyPricedUsageEvents, spend.partiallyPricedUsageEvents,
    spend.unpricedUsageEvents, unprocessed];
  if (!counts.every(count => typeof count === "number" && Number.isSafeInteger(count) && count >= 0)) return false;
  const [events, full, partial, unpriced] = counts as number[];
  if (full! + partial! + unpriced! + Number(unprocessed) !== events) return false;
  if (limited && (unprocessed !== events || Number(events) <= 2_048
      || spend.unavailableReason !== "processing_capacity_exceeded" || spend.processingPolicyVersion !== CAPACITY_POLICY)) return false;
  const known = events === 0 || full! + partial! > 0;
  const coverage = !known ? "unavailable" : full === events ? "complete" : "partial";
  return spend.coverage === coverage && (known
    ? typeof spend.knownCostUsd === "number" && Number.isFinite(spend.knownCostUsd) && spend.knownCostUsd >= 0
      && (events !== 0 || spend.knownCostUsd === 0)
    : spend.knownCostUsd === null);
}

export function isKernel10PublishedDailyPayload(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const totals = payload.totals;
  return payload.schemaVersion === "community-daily-aggregate-v1.0" && payload.policyVersion === "community-daily-v1.0"
    && payload.immutableRevision === true && payload.recomputesOnLateData === true
    && totals !== null && typeof totals === "object" && !Array.isArray(totals)
    && isKernel10PublishedSpend(payload.apiEquivalentSpend, (totals as Record<string, unknown>).usageEvents);
}
