import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeFastDiagnostic,
  analyzeSimpleQuotaGradient,
  summarizeSlotSemantics,
} from "../src/simple-quota-gradient.js";

function fixture() {
  const reset = 1_800_000_000;
  const otherReset = reset + 10_000;
  const intervals = Array.from({ length: 6 }, (_, index) => ({
    provider: "openai_codex",
    planType: "pro",
    limitId: "codex",
    slot: "primary",
    windowDurationMins: 10_080,
    resetsAt: reset,
    eventTime: new Date(Date.UTC(2026, 6, 1, index)).toISOString(),
    marginalApiPricedUsd: 6,
    marginalUsageEventCount: 1,
    priorUsedPercent: index,
    nextUsedPercent: index + 1,
    quality: {
      localCoverage: { elapsedTimeCoverageFraction: 1 },
      pricingWarnings: [],
      attributionWarnings: [],
    },
  }));
  intervals.push({ ...intervals[0], resetsAt: otherReset, marginalApiPricedUsd: 999 });
  const transitions = Array.from({ length: 6 }, (_, index) => ({
    ...intervals[index],
    eventTime: intervals[index].eventTime,
    lastPriorObservedAt: intervals[index].eventTime,
    firstNextObservedAt: intervals[index].eventTime,
    lastPriorCumulativeApiPricedUsd: index * 6,
    firstNextCumulativeApiPricedUsd: (index + 1) * 6,
  }));
  return {
    recent: { snapshotIntervals: intervals, transitions },
    history: {
      resetDiagnostics: [
        {
          ...intervals[0],
          resetIdentity: new Date(reset * 1000).toISOString(),
          firstObservedAt: intervals[0].eventTime,
          descriptiveCapacityUsd: 600,
          central80PercentRangeUsd: { lower: 540, upper: 660 },
          eligibleTransitions: 6,
          percentSpan: 6,
          usableDiagnostic: true,
        },
        {
          ...intervals[0],
          resetsAt: reset - 604_800,
          resetIdentity: new Date((reset - 604_800) * 1000).toISOString(),
          firstObservedAt: "2026-06-24T00:00:00.000Z",
          descriptiveCapacityUsd: 500,
          central80PercentRangeUsd: { lower: 450, upper: 550 },
          eligibleTransitions: 10,
          percentSpan: 20,
          usableDiagnostic: true,
        },
      ],
    },
  };
}

test("selects the dominant reset and never mixes a different reset into rolling cost", () => {
  const value = fixture();
  const result = analyzeSimpleQuotaGradient(value.recent, value.history);
  assert.equal(result.selectedReset.snapshotIntervals, 6);
  assert.equal(result.selectedReset.transitions, 6);
  assert.equal(result.gradient.capacityUsd, 600);
  assert.equal(result.datasets.rolling[0].rolling_api_cost_usd, 18);
  assert.ok(result.datasets.rolling.every((row) => row.rolling_api_cost_usd < 999));
});

test("constructs a cumulative fitted line and a three-hour rolling comparison", () => {
  const value = fixture();
  const result = analyzeSimpleQuotaGradient(value.recent, value.history);
  const observed = result.datasets.curve.filter((row) => row.series === "Observed quota");
  const fitted = result.datasets.curve.filter((row) => row.series === "Fitted gradient");
  assert.equal(observed.length, 7);
  assert.equal(fitted.length, 7);
  assert.equal(observed.at(-1).quota_consumed_pp, 6);
  assert.equal(fitted.at(-1).quota_consumed_pp, 6);
  assert.equal(fitted.at(-1).api_cost_usd, 36);
  assert.equal(result.gradient.meanAbsoluteErrorPp, 0);
  assert.equal(result.datasets.rolling.length, 8);
  assert.match(result.datasets.rolling[0].window_end_utc_label, /UTC/);
  assert.match(result.datasets.rolling[0].window_end_eastern_label, /E(?:D|S)T/);
  assert.equal(result.gradient.rollingSignedAucPpHours, 0);
  assert.equal(result.gradient.rollingAbsoluteAucPpHours, 0);
  assert.equal(result.datasets.rollingResidual.length, 4);
});

test("retains reset-specific central estimates and uncertainty envelopes", () => {
  const value = fixture();
  const result = analyzeSimpleQuotaGradient(value.recent, value.history);
  assert.equal(result.history.usableResetCount, 2);
  assert.equal(result.datasets.resetTrend.length, 6);
  assert.deepEqual(
    result.datasets.resetTrend.filter((row) => row.reset_at === new Date(1_800_000_000 * 1000).toISOString()).map((row) => row.capacity_usd),
    [600, 540, 660],
  );
});

test("uses duration rather than primary or secondary slot names", () => {
  const rows = summarizeSlotSemantics({
    transitions: [
      { slot: "primary", windowDurationMins: 300, eventTime: "2026-07-01T00:00:00.000Z" },
      { slot: "secondary", windowDurationMins: 10_080, eventTime: "2026-07-01T00:01:00.000Z" },
      { slot: "primary", windowDurationMins: 10_080, eventTime: "2026-07-12T00:00:00.000Z" },
    ],
  });
  assert.deepEqual(rows.map((row) => [row.slot, row.window_label]), [
    ["primary", "5 hours"],
    ["secondary", "7 days"],
    ["primary", "7 days"],
  ]);
});

test("captured Fast weighting reconciles a Fast segment with a later Standard reference", () => {
  const reset = 1_784_487_650;
  const base = {
    provider: "openai_codex",
    planType: "pro",
    limitId: "codex",
    slot: "primary",
    windowDurationMins: 10_080,
    resetsAt: reset,
    marginalUsageEventCount: 1,
  };
  const snapshotIntervals = [
    { ...base, eventTime: "2026-07-13T14:10:00.000Z", marginalApiPricedUsd: 2, priorUsedPercent: 10, nextUsedPercent: 11, tierUsageEventCounts: { fast: 1 } },
    { ...base, eventTime: "2026-07-13T15:10:00.000Z", marginalApiPricedUsd: 2, priorUsedPercent: 11, nextUsedPercent: 12, tierUsageEventCounts: { fast: 1 } },
    { ...base, eventTime: "2026-07-13T22:10:00.000Z", marginalApiPricedUsd: 5, priorUsedPercent: 12, nextUsedPercent: 13, tierUsageEventCounts: { standard: 1 } },
  ];
  const result = analyzeFastDiagnostic({ snapshotIntervals });
  assert.equal(result.fast.rawImpliedCapacityUsd, 200);
  assert.equal(result.fast.tierWeightedImpliedCapacityUsd, 500);
  assert.equal(result.reference.rawImpliedCapacityUsd, 500);
  assert.equal(result.segmentTable[0].speed_evidence, "2 Fast events");
  assert.equal(result.windowDiagnostics.length, 3);
  assert.deepEqual(result.windowDiagnostics.map((row) => row.window_hours), [1, 2, 3]);
  assert.match(result.hourly[0].hour_end_eastern_label, /EDT/);
});
