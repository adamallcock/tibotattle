import test from "node:test";
import assert from "node:assert/strict";
import { analyzeWeeklyLimitHistory, renderWeeklyLimitHistoryReport } from "../src/weekly-limit-history.js";

function transition(index, {
  capacityUsd = 600,
  quotaWeightedLowerCapacityUsd = null,
  quotaWeightedUpperCapacityUsd = null,
  reset = 1785000000,
  state = "unknown",
  tierUsageEventCounts = { standard: 1 },
} = {}) {
  const prior = index;
  const next = index + 1;
  return {
    provider: "openai_codex",
    planType: "pro",
    limitId: "codex",
    slot: "secondary",
    windowDurationMins: 10080,
    resetsAt: reset,
    eventTime: new Date((reset - 600 + index) * 1000).toISOString(),
    lastPriorObservedAt: new Date((reset - 601 + index) * 1000).toISOString(),
    firstNextObservedAt: new Date((reset - 600 + index) * 1000).toISOString(),
    priorUsedPercent: prior,
    nextUsedPercent: next,
    lastPriorCumulativeApiPricedUsd: prior * capacityUsd / 100,
    firstNextCumulativeApiPricedUsd: next * capacityUsd / 100,
    lastPriorCumulativeQuotaWeightedLowerUsd: Number.isFinite(quotaWeightedLowerCapacityUsd)
      ? prior * quotaWeightedLowerCapacityUsd / 100
      : null,
    firstNextCumulativeQuotaWeightedLowerUsd: Number.isFinite(quotaWeightedLowerCapacityUsd)
      ? next * quotaWeightedLowerCapacityUsd / 100
      : null,
    lastPriorCumulativeQuotaWeightedUpperUsd: Number.isFinite(quotaWeightedUpperCapacityUsd)
      ? prior * quotaWeightedUpperCapacityUsd / 100
      : null,
    firstNextCumulativeQuotaWeightedUpperUsd: Number.isFinite(quotaWeightedUpperCapacityUsd)
      ? next * quotaWeightedUpperCapacityUsd / 100
      : null,
    marginalUsageEventCount: 1,
    tierUsageEventCounts,
    controlledState: state,
    quality: {
      localCoverage: { elapsedTimeCoverageFraction: 1 },
      pricingWarnings: [],
      attributionWarnings: [],
    },
  };
}

function dataset() {
  return {
    parserVersion: "0.3.2",
    scope: { startAt: "2026-07-01T00:00:00Z", endAt: "2026-07-23T00:00:00Z", snapshotIntervalsIncluded: false },
    pricing: { basis: "standard_openai_api_prices_not_codex_subscription_credits" },
    transitions: [
      ...Array.from({ length: 10 }, (_, index) => transition(index, { reset: 1785000000, capacityUsd: 600 })),
      ...Array.from({ length: 10 }, (_, index) => transition(index, { reset: 1785604800, capacityUsd: 500 })),
    ],
  };
}

test("history analyzer reports descriptive reset slopes but refuses a cap with unknown controls", () => {
  const report = analyzeWeeklyLimitHistory(dataset());
  assert.equal(report.verdict, "not_testable");
  assert.equal(report.quality.usableDiagnosticResetGroups, 2);
  assert.equal(report.descriptiveStandardApiEquivalent.medianUsd, 550);
  assert.equal(report.quality.unboundedMissingUsage, true);
  assert.equal(report.conditionalRecentBallpark.decisionUsefulness.asActualAllowance, false);
  assert.equal(report.conditionalRecentBallpark.decisionUsefulness.actualAllowanceBlocker, "unbounded_missing_shared_pool_usage");
  assert.equal(report.earlyLateComparison.providerPolicyChangeConfirmed, false);
  assert.equal(report.earlyLateComparison.changeClassification, "suggestive");
  assert.equal(report.resetToResetRatios.length, 1);
  assert.equal(report.resetToResetRatios[0].standardRatio, 0.833333);
  assert.equal(report.unavailableIdentifiabilityDiagnostics.exactFeasibleIntervalUsd, null);
  assert.match(report.unavailableIdentifiabilityDiagnostics.reason, /unknown control state/);
  assert.match(renderWeeklyLimitHistoryReport(report), /This is not a weekly allowance estimate/);
});

test("near-identical reset timestamps select the group with more evidence", () => {
  const value = dataset();
  value.transitions.push(...Array.from({ length: 8 }, (_, index) => transition(index, { reset: 1785000001, capacityUsd: 900 })));
  const report = analyzeWeeklyLimitHistory(value);
  assert.equal(report.nearDuplicateResetGroupsSuppressed.length, 1);
  assert.equal(report.resetDiagnostics[0].resetsAt, 1785000000);
});

test("weekly reset deduplication never crosses account or plan partitions", () => {
  const reset = 1785000000;
  const first = Array.from({ length: 10 }, (_, index) => ({
    ...transition(index, { reset, capacityUsd: 600 }),
    accountScopeId: "scope-a",
    planVariant: "pro-20x",
  }));
  const second = Array.from({ length: 10 }, (_, index) => ({
    ...transition(index, { reset, capacityUsd: 300 }),
    accountScopeId: "scope-b",
    planVariant: "pro-5x",
  }));
  const report = analyzeWeeklyLimitHistory({ ...dataset(), transitions: [...first, ...second] });
  assert.equal(report.resetDiagnostics.length, 2);
  assert.deepEqual(report.resetDiagnostics.map((group) => [group.accountScopeId, group.planVariant]), [
    ["scope-a", "pro-20x"],
    ["scope-b", "pro-5x"],
  ]);
  assert.equal(report.crossPartitionHeadlineSuppressed, true);
  assert.equal(report.descriptiveStandardApiEquivalent, null);
  assert.equal(report.resetToResetRatios.length, 0);
  assert.equal(report.partitionSummaries.length, 2);
});

test("history analyzer preserves Standard, Fast, unknown, and unavailable tier sensitivity", () => {
  const resetCases = [
    { reset: 1785000000, lower: 600, upper: 600, counts: { standard: 1 } },
    { reset: 1785604800, lower: 1500, upper: 1500, counts: { fast: 1 } },
    { reset: 1786209600, lower: 1200, upper: 1200, counts: { fast: 1 } },
    { reset: 1786814400, lower: 600, upper: 1500, counts: { unknown: 1 } },
    { reset: 1787419200, lower: null, upper: null, counts: { fast: 1 } },
  ];
  const value = dataset();
  value.transitions = resetCases.flatMap(({ reset, lower, upper, counts }) =>
    Array.from({ length: 10 }, (_, index) => transition(index, {
      reset,
      capacityUsd: 600,
      quotaWeightedLowerCapacityUsd: lower,
      quotaWeightedUpperCapacityUsd: upper,
      tierUsageEventCounts: counts,
    })));
  const report = analyzeWeeklyLimitHistory(value);
  const byReset = new Map(report.resetDiagnostics.map((item) => [item.resetsAt, item]));
  assert.deepEqual(byReset.get(1785000000).quotaWeightedSensitivity, {
    unknownAsStandardCapacityUsd: 600,
    unknownAsFastCapacityUsd: 600,
  });
  assert.deepEqual(byReset.get(1785604800).quotaWeightedSensitivity, {
    unknownAsStandardCapacityUsd: 1500,
    unknownAsFastCapacityUsd: 1500,
  });
  assert.deepEqual(byReset.get(1786209600).quotaWeightedSensitivity, {
    unknownAsStandardCapacityUsd: 1200,
    unknownAsFastCapacityUsd: 1200,
  });
  assert.deepEqual(byReset.get(1786814400).quotaWeightedSensitivity, {
    unknownAsStandardCapacityUsd: 600,
    unknownAsFastCapacityUsd: 1500,
  });
  assert.equal(byReset.get(1787419200).quotaWeightedSensitivity, null);
});

test("history renderer does not claim a tier ratio when sensitivity is unavailable", () => {
  const value = dataset();
  value.transitions = [1785000000, 1785604800].flatMap((reset) =>
    Array.from({ length: 10 }, (_, index) => transition(index, {
      reset,
      quotaWeightedLowerCapacityUsd: null,
      quotaWeightedUpperCapacityUsd: null,
      tierUsageEventCounts: { fast: 1 },
    })));
  const rendered = renderWeeklyLimitHistoryReport(analyzeWeeklyLimitHistory(value));
  assert.match(rendered, /tier-weighted early\/late ratio is unavailable/);
  assert.doesNotMatch(rendered, /possible late\/early ratio crosses 1/);
});
