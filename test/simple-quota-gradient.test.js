import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compositionExpectedPp } from "@app-usagemonitor/quota-analysis";
import {
  analyzeFastDiagnostic,
  analyzeSimpleQuotaGradient,
  buildRollingHours,
  summarizeSlotSemantics,
} from "../src/simple-quota-gradient.js";

function fixture() {
  const reset = 1_800_000_000;
  const otherReset = reset + 10_000;
  const intervals = Array.from({ length: 6 }, (_, index) => ({
    provider: "openai_codex",
    accountScopeId: "account-a",
    planType: "pro",
    planVariant: "pro-20x",
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

test("never mixes two accounts or plan variants sharing the same reset timestamp", () => {
  const value = fixture();
  const foreignAccount = value.recent.snapshotIntervals.slice(0, 2).map((row, index) => ({
    ...row,
    accountScopeId: "account-b",
    marginalApiPricedUsd: 999,
    eventTime: new Date(Date.UTC(2026, 6, 1, 12 + index)).toISOString(),
  }));
  const foreignPlan = value.recent.snapshotIntervals.slice(0, 2).map((row, index) => ({
    ...row,
    planType: "prolite",
    marginalApiPricedUsd: 999,
    eventTime: new Date(Date.UTC(2026, 6, 1, 14 + index)).toISOString(),
  }));
  value.recent.snapshotIntervals.push(...foreignAccount, ...foreignPlan);
  const result = analyzeSimpleQuotaGradient(value.recent, value.history);
  assert.equal(result.selectedReset.snapshotIntervals, 6);
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

// --- Composition-aware expected line and pool-saturation guard --------------
// Design: docs/design/composition-aware-expected-line.md (owner-approved).

const COMPOSITION = Object.freeze({
  capacityUsdByModel: Object.freeze({
    "gpt-5.6-sol": 2_500,
    "gpt-5.6-terra": 900,
  }),
  blendedCapacityUsd: 2_000,
});

function compositionInterval({
  hour,
  priorUsedPercent,
  nextUsedPercent,
  costsByModel,
}) {
  const modelMix = Object.fromEntries(Object.entries(costsByModel)
    .map(([model, costUsd]) => [model, { costUsd, events: 1 }]));
  return {
    eventTime: new Date(Date.UTC(2026, 6, 20, hour, 30)).toISOString(),
    marginalApiPricedUsd: Object.values(costsByModel)
      .reduce((sum, value) => sum + value, 0),
    marginalUsageEventCount: 1,
    priorUsedPercent,
    nextUsedPercent,
    modelMix,
  };
}

function expectedSeries(rolling) {
  return rolling.filter((row) => row.series === "Expected from API cost");
}

test("a mixed window's expected movement is the per-model sum, and pure windows price at their own capacities", () => {
  const rolling = buildRollingHours([
    compositionInterval({ hour: 0, priorUsedPercent: 10, nextUsedPercent: 11, costsByModel: { "gpt-5.6-sol": 25 } }),
    compositionInterval({ hour: 1, priorUsedPercent: 11, nextUsedPercent: 12, costsByModel: { "gpt-5.6-terra": 9 } }),
    compositionInterval({ hour: 2, priorUsedPercent: 12, nextUsedPercent: 13, costsByModel: { "gpt-5.6-sol": 50, "gpt-5.6-terra": 4.5 } }),
  ], COMPOSITION, 1);
  const expected = expectedSeries(rolling);
  // Sol-pure hour at sol's capacity.
  assert.equal(expected[0].quota_change_pp, 25 * 100 / 2_500);
  // Terra-pure hour at terra's capacity.
  assert.equal(expected[1].quota_change_pp, 9 * 100 / 900);
  // Mixed hour: the per-model sum — never the blended constant.
  assert.equal(expected[2].quota_change_pp, 50 * 100 / 2_500 + 4.5 * 100 / 900);
  assert.notEqual(expected[2].quota_change_pp, 54.5 * 100 / 2_000);
});

test("cost from a model outside the fitted vector prices at the blended fallback", () => {
  const rolling = buildRollingHours([
    compositionInterval({ hour: 0, priorUsedPercent: 10, nextUsedPercent: 11, costsByModel: { "gpt-9-new": 20 } }),
  ], COMPOSITION, 1);
  assert.equal(expectedSeries(rolling)[0].quota_change_pp, 20 * 100 / 2_000);
});

test("a scalar capacity still carries the whole line as one blended constant", () => {
  const rolling = buildRollingHours([
    compositionInterval({ hour: 0, priorUsedPercent: 10, nextUsedPercent: 11, costsByModel: { "gpt-5.6-sol": 25 } }),
  ], 2_000, 1);
  assert.equal(expectedSeries(rolling)[0].quota_change_pp, 25 * 100 / 2_000);
});

test("a window that starts at the ceiling is pool-saturated: both series null and flagged", () => {
  const intervals = [
    compositionInterval({ hour: 0, priorUsedPercent: 98, nextUsedPercent: 100, costsByModel: { "gpt-5.6-sol": 50 } }),
    // Pool pegged: cost keeps accruing while the display cannot move.
    compositionInterval({ hour: 1, priorUsedPercent: 100, nextUsedPercent: 100, costsByModel: { "gpt-5.6-sol": 400 } }),
    compositionInterval({ hour: 2, priorUsedPercent: 100, nextUsedPercent: 100, costsByModel: { "gpt-5.6-sol": 400 } }),
  ];
  const rolling = buildRollingHours(intervals, COMPOSITION, 1);
  const observed = rolling.filter((row) => row.series === "Observed quota change");
  const expected = expectedSeries(rolling);
  assert.equal(observed[0].pool_saturated, false);
  assert.equal(expected[0].quota_change_pp, 50 * 100 / 2_500);
  for (const index of [1, 2]) {
    assert.equal(observed[index].pool_saturated, true);
    assert.equal(observed[index].quota_change_pp, null);
    assert.equal(expected[index].quota_change_pp, null);
  }
});

test("a used_percent reset starts a fresh segment; no window ever spans the boundary", () => {
  const intervals = [
    compositionInterval({ hour: 0, priorUsedPercent: 96, nextUsedPercent: 98, costsByModel: { "gpt-5.6-sol": 50 } }),
    compositionInterval({ hour: 1, priorUsedPercent: 98, nextUsedPercent: 100, costsByModel: { "gpt-5.6-sol": 50 } }),
    // Reset: the display falls from the ceiling to 2 and climbs again.
    compositionInterval({ hour: 2, priorUsedPercent: 100, nextUsedPercent: 2, costsByModel: { "gpt-5.6-sol": 1 } }),
    compositionInterval({ hour: 3, priorUsedPercent: 2, nextUsedPercent: 5, costsByModel: { "gpt-5.6-sol": 75 } }),
    compositionInterval({ hour: 4, priorUsedPercent: 5, nextUsedPercent: 7, costsByModel: { "gpt-5.6-sol": 50 } }),
  ];
  const rolling = buildRollingHours(intervals, COMPOSITION, 3);
  const observed = rolling.filter((row) => row.series === "Observed quota change");
  // The reset splits the series: no three-hour window mixes the pre-reset
  // envelope into the fresh segment, so no observed movement can exceed the
  // fresh segment's own span — the monotone envelope can never smear the
  // reset into a permanent 100 ceiling.
  assert.ok(observed.length >= 1);
  for (const row of observed) {
    assert.ok(row.quota_change_pp === null
      || (row.quota_change_pp >= 0 && row.quota_change_pp <= 7));
  }
  const lastObserved = observed.at(-1);
  assert.ok(lastObserved.quota_change_pp !== null);
  assert.ok(lastObserved.quota_change_pp <= 7);
});

test("a single stale dip that recovers never starts a segment or fabricates movement", () => {
  // Live-corpus shape (266 raw-grain occurrences): one interleaved reading
  // from a stale source drops far below the envelope and the next reading
  // recovers. Splitting on the single dip would anchor a fresh segment at
  // the stale value and book the recovery (~55pp here) as observed movement
  // against pennies of cost.
  const intervals = [
    compositionInterval({ hour: 0, priorUsedPercent: 60, nextUsedPercent: 61, costsByModel: { "gpt-5.6-sol": 25 } }),
    compositionInterval({ hour: 1, priorUsedPercent: 61, nextUsedPercent: 6, costsByModel: { "gpt-5.6-sol": 1 } }),
    compositionInterval({ hour: 2, priorUsedPercent: 6, nextUsedPercent: 61, costsByModel: { "gpt-5.6-sol": 1 } }),
    compositionInterval({ hour: 3, priorUsedPercent: 61, nextUsedPercent: 62, costsByModel: { "gpt-5.6-sol": 25 } }),
  ];
  const rolling = buildRollingHours(intervals, COMPOSITION, 1);
  const observed = rolling.filter((row) => row.series === "Observed quota change");
  // One segment, monotone envelope: total observed movement is 60 -> 62,
  // never a +55 phantom.
  for (const row of observed) {
    assert.ok(row.quota_change_pp === null || row.quota_change_pp <= 2);
  }
  const total = observed.reduce((sum, row) => sum + (row.quota_change_pp ?? 0), 0);
  assert.ok(Math.abs(total - 2) < 1e-9);
});

test("two consecutive confirming readings still split a genuine reset into a fresh segment", () => {
  const intervals = [
    compositionInterval({ hour: 0, priorUsedPercent: 60, nextUsedPercent: 61, costsByModel: { "gpt-5.6-sol": 25 } }),
    // Banked reset: the display drops and STAYS down across two readings.
    compositionInterval({ hour: 1, priorUsedPercent: 61, nextUsedPercent: 6, costsByModel: { "gpt-5.6-sol": 1 } }),
    compositionInterval({ hour: 2, priorUsedPercent: 6, nextUsedPercent: 7, costsByModel: { "gpt-5.6-sol": 10 } }),
    compositionInterval({ hour: 3, priorUsedPercent: 7, nextUsedPercent: 9, costsByModel: { "gpt-5.6-sol": 20 } }),
  ];
  const rolling = buildRollingHours(intervals, COMPOSITION, 1);
  const observed = rolling.filter((row) => row.series === "Observed quota change");
  // The confirmed drop starts a fresh segment: no window mixes 61 with the
  // post-reset climb, and post-reset movement is measured from the low base.
  for (const row of observed) {
    assert.ok(row.quota_change_pp === null
      || (row.quota_change_pp >= 0 && row.quota_change_pp <= 3));
  }
  const lastObserved = observed.at(-1);
  assert.equal(lastObserved.quota_change_pp, 2);
});

test("buildRollingResidual counts the saturated windows its AUC excluded", () => {
  const intervals = [
    compositionInterval({ hour: 0, priorUsedPercent: 98, nextUsedPercent: 100, costsByModel: { "gpt-5.6-sol": 50 } }),
    compositionInterval({ hour: 1, priorUsedPercent: 100, nextUsedPercent: 100, costsByModel: { "gpt-5.6-sol": 400 } }),
    compositionInterval({ hour: 2, priorUsedPercent: 100, nextUsedPercent: 100, costsByModel: { "gpt-5.6-sol": 400 } }),
  ];
  const value = fixture();
  for (const [index, interval] of intervals.entries()) {
    Object.assign(value.recent.snapshotIntervals[index], interval, {
      eventTime: value.recent.snapshotIntervals[index].eventTime,
    });
  }
  // The remaining fixture intervals keep the series alive; the point of this
  // assertion is only that the summary surfaces the exclusion count.
  const result = analyzeSimpleQuotaGradient(value.recent, value.history);
  assert.ok(Number.isInteger(result.gradient.rollingSaturatedWindowsExcluded));
});

test("analyzeSimpleQuotaGradient threads the composition vector into the rolling line", () => {
  const value = fixture();
  for (const interval of value.recent.snapshotIntervals) {
    interval.modelMix = { "gpt-5.6-sol": { costUsd: interval.marginalApiPricedUsd, events: 1 } };
  }
  const result = analyzeSimpleQuotaGradient(value.recent, value.history, {
    composition: {
      capacityUsdByModel: { "gpt-5.6-sol": 1_200 },
      blendedCapacityUsd: 1_200,
    },
  });
  assert.equal(result.gradient.rollingExpectedBasis, "composition_per_model");
  assert.deepEqual(result.gradient.compositionCapacityUsdByModel, { "gpt-5.6-sol": 1_200 });
  const expected = result.datasets.rolling.filter((row) => row.series === "Expected from API cost");
  // Three hourly intervals of $6 sol-priced cost at $1,200/100pp.
  assert.equal(expected[0].quota_change_pp, 18 * 100 / 1_200);
  // Without the option the same fixture stays on the blended constant.
  const blended = analyzeSimpleQuotaGradient(value.recent, value.history);
  assert.equal(blended.gradient.rollingExpectedBasis, "blended_constant");
  assert.equal(blended.gradient.compositionCapacityUsdByModel, null);
});

// Golden windows from the live unified index (read-only derivation
// 2026-08-11): the two deep-dive deviation windows. Each fixture pins the
// constant-line residual as shipped and asserts the composition-aware line
// with the saturation guard collapses it.
for (const fixtureFile of [
  "fixtures/composition/deviation-window-jul24.json",
  "fixtures/composition/deviation-window-jul29-30.json",
]) {
  test(`golden window ${fixtureFile.split("/").at(-1)} collapses versus the constant baseline`, async () => {
    const golden = JSON.parse(
      await readFile(new URL(fixtureFile, import.meta.url), "utf8"),
    );
    const { intervals, expectations, constantCapacityUsd, composition } = golden;
    const allCost = intervals.reduce((sum, row) => sum + row.marginalApiPricedUsd, 0);
    assert.ok(Math.abs(allCost - expectations.allCostUsd) < 0.05);
    // BEFORE: the constant line integrates every dollar, pegged spans
    // included — reproduce the shipped residual arithmetically.
    const spanPp = intervals.reduce((sum, row) => sum
      + Math.max(0, row.nextUsedPercent - row.priorUsedPercent), 0);
    assert.ok(Math.abs(spanPp - expectations.spanPp) < 0.05);
    const residualBefore = spanPp - allCost * 100 / constantCapacityUsd;
    assert.ok(Math.abs(residualBefore - expectations.residualBeforePp) < 0.05);
    // AFTER: composition expected over non-pegged intervals only.
    let compositionExpected = 0;
    let saturatedCost = 0;
    for (const row of intervals) {
      const costs = Object.fromEntries(Object.entries(row.modelMix)
        .map(([model, value]) => [model, value.costUsd]));
      if (row.priorUsedPercent >= 100) {
        saturatedCost += row.marginalApiPricedUsd;
        continue;
      }
      compositionExpected += compositionExpectedPp(costs, {
        capacityUsdByModel: composition.capacityUsdByModel,
        fallbackCapacityUsd: constantCapacityUsd,
      });
    }
    const residualAfter = spanPp - compositionExpected;
    assert.ok(Math.abs(residualAfter - expectations.residualAfterPp) < 0.05);
    assert.ok(Math.abs(saturatedCost - expectations.saturatedCostUsd) < 0.05);
    // The collapse itself.
    assert.ok(Math.abs(residualAfter) < Math.abs(residualBefore));
    // And the rolling pipeline agrees: saturated windows are flagged with
    // null series values rather than integrated.
    const rolling = buildRollingHours(intervals, {
      capacityUsdByModel: composition.capacityUsdByModel,
      blendedCapacityUsd: composition.blendedCapacityUsd,
    }, 3);
    const saturatedRows = rolling.filter((row) => row.pool_saturated === true);
    if (expectations.saturatedBins > 0) {
      assert.ok(saturatedRows.length > 0);
      for (const row of saturatedRows) assert.equal(row.quota_change_pp, null);
    } else {
      assert.equal(saturatedRows.length, 0);
    }
  });
}
