/** Preserve exact pricing coverage when inspecting a time bucket or model. */
export function cacheReuseMetricLines(summary, impact, { t, formatCount, formatApiMoney }) {
  const subtotalScope = impact?.coverageStatus !== "complete"
    || summary.coverageStatus !== "complete" || summary.unpricedDrops > 0;
  // Ordering gaps cannot be assigned to a bucket. Retain admitted subtotals,
  // while withholding whole-period totals and unsupported zero prices.
  const premium = summary.comparableReturns === 0 ? null
    : subtotalScope
      ? summary.coveredSubtotal?.standardApiPremiumUsd
        ?? (summary.coverageStatus === "complete" && summary.unpricedDrops === 0
          ? summary.estimatedPremiumUsd : null)
      : summary.estimatedPremiumUsd;
  return [
    t("accounting.cacheContinuity.outcome.readoutLost", {
      tokens: formatCount(summary.lostCacheTokens),
    }),
    t(subtotalScope
      ? summary.unpricedDrops > 0
        ? "accounting.cacheContinuity.outcome.readoutSubtotalUnpriced"
        : "accounting.cacheContinuity.outcome.readoutSubtotal"
      : "accounting.cacheContinuity.outcome.readoutApi", {
      amount: premium === null || premium === undefined
        ? t("accounting.cacheContinuity.premiumUnavailable")
        : formatApiMoney(premium),
      priced: formatCount(summary.pricedDrops),
      unpriced: formatCount(summary.unpricedDrops),
    }),
  ];
}

export function cacheReuseCoverageNote(impact, { t, formatCount }) {
  if (impact?.status !== "available") return "";
  const exclusions = [
    [impact.orderingCoverageGaps, "ordering"],
    [impact.uncoveredReturns, "boundary"],
    [impact.unpricedDrops, "pricing"],
  ].filter(([count]) => count > 0);
  if (impact.coverageStatus === "complete" && exclusions.length === 0) return "";
  return [
    t("accounting.cacheContinuity.outcome.coverage.partial"),
    ...exclusions.map(([count, kind]) => t(
      `accounting.cacheContinuity.outcome.coverage.${kind}`,
      { count: formatCount(count) },
    )),
  ].join(" ");
}
