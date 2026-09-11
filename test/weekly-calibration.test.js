import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  analyzeWeeklyCalibration,
  BOUNDED_WEEKLY_CALIBRATION_RESET_LIMIT,
  projectBoundedWeeklyCalibrationSummary,
  renderWeeklyCalibrationReport,
  validWeeklyPlanPopulations,
} from "../src/reporting/index.js";
import { verifyWeeklyCalibration } from "../src/verify-weekly-calibration.js";

test("weekly calibration package shortcut pins the full historical ledger", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const command = packageJson.scripts["calibrate:weekly"];
  assert.match(command, /transitions-simple-history-2026-06-11-to-2026-07-24-v0\.3\.2\.json/);
  assert.match(command, /weekly-calibration-v0\.2\.json/);
});

test("bounded weekly summary rejects malformed datasets", () => {
  assert.throws(
    () => projectBoundedWeeklyCalibrationSummary(null),
    /Weekly calibration dataset is invalid/,
  );
  assert.throws(
    () => projectBoundedWeeklyCalibrationSummary({ transitions: {} }),
    /Weekly calibration dataset is invalid/,
  );
  assert.throws(
    () => projectBoundedWeeklyCalibrationSummary(
      { transitions: [] },
      { forcedCandidateId: "hostile" },
    ),
    /Unknown forced weekly calibration candidate/,
  );
});

test("bounded weekly summaries can pin each speed-priced scenario", () => {
  const reset = Math.floor(
    Date.parse("2026-08-20T00:00:00.000Z") / 1_000,
  );
  const transitions = resetTransitions({ reset, capacityUsd: 800 }).map(
    (row) => ({
      ...row,
      lastPriorCumulativeQuotaWeightedUpperUsd:
        row.lastPriorCumulativeApiPricedUsd * 2.5,
      firstNextCumulativeQuotaWeightedUpperUsd:
        row.firstNextCumulativeApiPricedUsd * 2.5,
    }),
  );
  const lower = projectBoundedWeeklyCalibrationSummary(
    dataset(transitions),
    { forcedCandidateId: "speed_lower" },
  );
  const upper = projectBoundedWeeklyCalibrationSummary(
    dataset(transitions),
    { forcedCandidateId: "speed_upper" },
  );
  assert.equal(lower.validation.selectedCostBasis, "speed_lower");
  assert.equal(upper.validation.selectedCostBasis, "speed_upper");
  assert.equal(lower.estimate.medianApiPriceEquivalentUsd, 800);
  assert.equal(upper.estimate.medianApiPriceEquivalentUsd, 2_000);
  assert.deepEqual(
    lower.recentResets.map((row) => row.resetIdentity),
    upper.recentResets.map((row) => row.resetIdentity),
  );
});

test("bounded weekly summary embeds a defensive composition projection", () => {
  const empty = projectBoundedWeeklyCalibrationSummary({ transitions: [] });
  assert.equal(empty.composition, null);

  const fitted = projectBoundedWeeklyCalibrationSummary({ transitions: [] }, {
    composition: {
      status: "fitted",
      grainHours: 2,
      observationCount: 500,
      capacityUsdByModel: { "gpt-5.6-sol": 2_539.01, "gpt-5.6-terra": 899.26, other: null },
      modelCostShares: { "gpt-5.6-sol": 0.46, "gpt-5.6-terra": 0.11 },
      r2: 0.7592,
      singleConstantUsd: 2_060.65,
      singleConstantR2: 0.664,
      blendedRecentMixUsd: 2_007.24,
      recentMixDays: 14,
    },
  });
  assert.equal(fitted.composition.status, "fitted");
  assert.equal(fitted.composition.capacityUsdByModel["gpt-5.6-sol"], 2_539.01);
  assert.equal(fitted.composition.capacityUsdByModel.other, null);
  assert.equal(fitted.composition.blendedRecentMixUsd, 2_007.24);

  // A non-fitted status never carries a vector, and a malformed block
  // degrades to null instead of poisoning the summary.
  const fallback = projectBoundedWeeklyCalibrationSummary({ transitions: [] }, {
    composition: {
      status: "fallback_blended",
      observationCount: 40,
      capacityUsdByModel: null,
      singleConstantUsd: 1_800,
      r2: 0.4,
      singleConstantR2: 0.41,
      blendedRecentMixUsd: null,
    },
  });
  assert.equal(fallback.composition.status, "fallback_blended");
  assert.equal(fallback.composition.capacityUsdByModel, null);
  assert.equal(fallback.composition.singleConstantUsd, 1_800);

  const malformed = projectBoundedWeeklyCalibrationSummary({ transitions: [] }, {
    composition: { status: "surprise" },
  });
  assert.equal(malformed.composition, null);
});

test("bounded weekly summary retains up to 64 reset series from a 31-day window", () => {
  const firstReset = Math.floor(
    Date.parse("2026-07-01T12:00:00.000Z") / 1_000,
  );
  const resets = Array.from(
    { length: BOUNDED_WEEKLY_CALIBRATION_RESET_LIMIT + 6 },
    (_, index) => firstReset + index * 10 * 60 * 60,
  );
  const input = dataset(resets.flatMap((reset, index) => (
    resetTransitions({ reset, capacityUsd: 600 + index })
  )));
  input.scope = {
    ...input.scope,
    startAt: "2026-06-30T00:00:00.000Z",
    endAt: "2026-08-01T00:00:00.000Z",
  };

  const summary = projectBoundedWeeklyCalibrationSummary(input);

  assert.equal(
    summary.recentResets.length,
    BOUNDED_WEEKLY_CALIBRATION_RESET_LIMIT,
  );
  assert.equal(
    summary.recentResets[0].resetIdentity,
    new Date(resets[6] * 1_000).toISOString(),
  );
  assert.equal(
    summary.recentResets.at(-1).resetIdentity,
    new Date(resets.at(-1) * 1_000).toISOString(),
  );
});

function resetTransitions({
  reset,
  capacityUsd = 600,
  weightedCost = null,
  accountScopeId = "scope-a",
  planVariant = "pro-20x",
  slot = reset < 1_800_000_000 ? "secondary" : "primary",
}) {
  const percentages = Array.from({ length: 21 }, (_, index) => index);
  const standard = (percent) => percent * capacityUsd / 100;
  const weighted = weightedCost ?? standard;
  return percentages.slice(1).map((percent, index) => {
    const prior = percentages[index];
    return {
      accountScopeId,
      planVariant,
      provider: "openai_codex",
      planType: "pro",
      limitId: "codex",
      slot,
      windowDurationMins: 10_080,
      resetsAt: reset,
      eventTime: new Date((reset - 100_000 + index * 60) * 1000).toISOString(),
      lastPriorObservedAt: new Date((reset - 100_001 + index * 60) * 1000).toISOString(),
      firstNextObservedAt: new Date((reset - 100_000 + index * 60) * 1000).toISOString(),
      priorUsedPercent: prior,
      nextUsedPercent: percent,
      lastPriorCumulativeApiPricedUsd: standard(prior),
      firstNextCumulativeApiPricedUsd: standard(percent),
      lastPriorCumulativeQuotaWeightedLowerUsd: weighted(prior),
      firstNextCumulativeQuotaWeightedLowerUsd: weighted(percent),
      lastPriorCumulativeQuotaWeightedUpperUsd: weighted(prior),
      firstNextCumulativeQuotaWeightedUpperUsd: weighted(percent),
      marginalUsageEventCount: 1,
      tierUsageEventCounts: { standard: 1 },
      controlledState: "unknown",
      quality: {
        localCoverage: { elapsedTimeCoverageFraction: 1 },
        pricingWarnings: [],
        attributionWarnings: [],
      },
    };
  });
}

test("mixed-plan summaries retain legacy evidence without pooling plan medians", () => {
  const reset = Math.floor(Date.parse("2026-08-20T00:00:00.000Z") / 1_000);
  const pro = resetTransitions({ reset, capacityUsd: 1_600, accountScopeId: "unattributed" });
  const plus = resetTransitions({ reset: reset + 604_800, capacityUsd: 80, accountScopeId: "unattributed" })
    .map((row) => ({ ...row, planType: "plus", planVariant: "unknown" }));
  const result = projectBoundedWeeklyCalibrationSummary(dataset([...pro, ...plus]));
  assert.equal(result.selectedPlanType, "plus");
  assert.equal(result.estimate.medianApiPriceEquivalentUsd, 80);
  assert.deepEqual(result.planPopulations.map((row) => [
    row.planType, row.estimate.medianApiPriceEquivalentUsd,
  ]), [["plus", 80], ["pro", 1_600]]);
  assert.ok(result.recentResets.every((row) => row.planType === "plus"));
  assert.equal(result.planAttribution.accountVerified, false);
  const selectedPro = projectBoundedWeeklyCalibrationSummary(dataset([...pro, ...plus]), { planType: "pro" });
  assert.equal(selectedPro.estimate.medianApiPriceEquivalentUsd, 1_600);
});

test("bounded summaries describe a fit from its first eligible transition", () => {
  const reset = Math.floor(Date.parse("2026-08-20T00:00:00.000Z") / 1_000);
  const diagnosticJumpUsd = 5_994;
  const transitions = resetTransitions({ reset }).slice(0, 8).map((row, index) => ({
    ...row,
    // The rejected first interval contains a large attribution-uncertain
    // cost jump. Later admitted intervals continue from that ledger value at
    // the ordinary $600/100pp slope. If the first row ever leaks into the
    // fit, its outlying boundary makes the counterfactual projection fail
    // instead of coincidentally retaining the expected headline.
    lastPriorCumulativeApiPricedUsd:
      row.lastPriorCumulativeApiPricedUsd + (index === 0 ? 0 : diagnosticJumpUsd),
    firstNextCumulativeApiPricedUsd:
      row.firstNextCumulativeApiPricedUsd + diagnosticJumpUsd,
    lastPriorCumulativeQuotaWeightedLowerUsd:
      row.lastPriorCumulativeQuotaWeightedLowerUsd + (index === 0 ? 0 : diagnosticJumpUsd),
    firstNextCumulativeQuotaWeightedLowerUsd:
      row.firstNextCumulativeQuotaWeightedLowerUsd + diagnosticJumpUsd,
    lastPriorCumulativeQuotaWeightedUpperUsd:
      row.lastPriorCumulativeQuotaWeightedUpperUsd + (index === 0 ? 0 : diagnosticJumpUsd),
    firstNextCumulativeQuotaWeightedUpperUsd:
      row.firstNextCumulativeQuotaWeightedUpperUsd + diagnosticJumpUsd,
    aggregationEligibility: index === 0
      ? "diagnostic_only"
      : "primary_conditional",
  }));

  const summary = projectBoundedWeeklyCalibrationSummary(dataset(transitions));

  assert.equal(summary.status, "estimated");
  assert.equal(summary.estimate.medianApiPriceEquivalentUsd, 600);
  assert.equal(summary.recentResets[0].eligibleTransitions, 7);
  assert.equal(
    summary.recentResets[0].aggregationEligibility,
    "primary_conditional",
  );
  assert.equal(validWeeklyPlanPopulations(summary), true);

  const accidentallyAdmitted = projectBoundedWeeklyCalibrationSummary(dataset(
    transitions.map((row, index) => index === 0
      ? { ...row, aggregationEligibility: "primary_conditional" }
      : row),
  ));
  assert.equal(accidentallyAdmitted.status, "insufficient_evidence");
  assert.equal(accidentallyAdmitted.estimate, null);
});

test("a newly observed plan without a fit never borrows an older plan's headline", () => {
  const reset = Math.floor(Date.parse("2026-08-20T00:00:00.000Z") / 1_000);
  const input = dataset(resetTransitions({ reset }));
  input.attribution = { latestPlanType: "plus", planTypes: ["pro", "plus"] };
  const result = projectBoundedWeeklyCalibrationSummary(input);
  assert.equal(result.selectedPlanType, "plus");
  assert.equal(result.estimate, null);
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.planPopulations.find((row) => row.planType === "pro").estimate.medianApiPriceEquivalentUsd, 600);
});

test("returning plan-era fragments cannot multiply one reset's primary votes", () => {
  const reset = Math.floor(Date.parse("2026-08-20T00:00:00.000Z") / 1_000);
  const first = resetTransitions({ reset, capacityUsd: 800 }).slice(0, 12)
    .map((row) => ({ ...row, planEraKey: "pro:first", aggregationEligibility: "primary_conditional" }));
  const returned = resetTransitions({ reset, capacityUsd: 600 }).map((row) => ({
    ...row, planEraKey: "pro:return", aggregationEligibility: "primary_conditional",
    eventTime: new Date(Date.parse(row.eventTime) + 3_600_000).toISOString(),
    lastPriorObservedAt: new Date(Date.parse(row.lastPriorObservedAt) + 3_600_000).toISOString(),
    firstNextObservedAt: new Date(Date.parse(row.firstNextObservedAt) + 3_600_000).toISOString(),
  }));
  const report = analyzeWeeklyCalibration(dataset([...first, ...returned]));
  assert.equal(report.weeklyValueSummary.resetCount, 1);
  assert.equal(report.weeklyValueSummary.medianApiPriceEquivalentUsd, 600);
  assert.equal(report.resetValues[0].planEraKey, "pro:return");
  const excluded = report.fragmentDiagnostics.find((row) => (
    row.planEraKey === "pro:first" && row.candidateId === "standard_api"
  ));
  assert.equal(excluded.reason, "another_qualifying_fragment_represents_reset");
  assert.equal(excluded.apiPriceEquivalentUsd, 800);
  assert.ok(excluded.observedSpanPercentagePoints > 0);
  assert.ok(excluded.uniqueBoundaries > 0);
  const selection = report.quality.fragmentSelection.find((row) => row.candidateId === "standard_api");
  assert.deepEqual(selection.primary, {
    count: 1, medianApiPriceEquivalentUsd: 600,
    central80ApiPriceEquivalentUsd: { lower: 600, upper: 600 },
  });
  assert.deepEqual(selection.diagnosticOnly, {
    count: 1, medianApiPriceEquivalentUsd: 800,
    central80ApiPriceEquivalentUsd: { lower: 800, upper: 800 },
  });
  assert.match(renderWeeklyCalibrationReport(report),
    /\| standard_api \| 1 \| \$600\.00 \| 1 \| \$800\.00 \|/);
  // Diagnostics cannot become a second vote or enter the bounded headline DTO.
  const summary = projectBoundedWeeklyCalibrationSummary(dataset([...first, ...returned]));
  assert.equal(summary.estimate.qualifyingResets, 1);
  assert.equal(summary.estimate.medianApiPriceEquivalentUsd, 600);
  assert.equal(Object.hasOwn(summary, "fragmentDiagnostics"), false);
});

test("fragment selection reports absent diagnostics as unavailable rather than zero capacity", () => {
  const reset = Math.floor(Date.parse("2026-08-20T00:00:00.000Z") / 1_000);
  const report = analyzeWeeklyCalibration(dataset(resetTransitions({ reset })));
  const selection = report.quality.fragmentSelection.find((row) => row.candidateId === "standard_api");
  assert.deepEqual(selection.diagnosticOnly, {
    count: 0, medianApiPriceEquivalentUsd: null,
    central80ApiPriceEquivalentUsd: { lower: null, upper: null },
  });
});

test("mixed unscoped composition never escapes as a selected-plan vector", () => {
  const input = { transitions: [], attribution: { latestPlanType: "pro", planTypes: ["plus", "pro"] } };
  const result = projectBoundedWeeklyCalibrationSummary(input, {
    composition: { status: "fitted", capacityUsdByModel: { "gpt-5": 200 }, observationCount: 100 },
  });
  assert.equal(result.composition, null);
  assert.ok(result.planPopulations.every((population) => population.composition === null));
});

test("weekly reset provenance preserves mixed historical card windows", () => {
  const reset = Math.floor(Date.parse("2026-08-03T00:00:00.000Z") / 1_000);
  const preChangeId = "openai:gpt-5.6-terra:standard:short-through-2026-07-29:official-observed-2026-08-30";
  const postChangeId = "openai:gpt-5.6-terra:standard:short-from-2026-07-30:official-observed-2026-08-30";
  const transitions = resetTransitions({ reset }).map((row, index) => {
    const eventTime = new Date(
      Date.parse("2026-07-29T14:00:00.000Z") + index * 60 * 60 * 1_000,
    ).toISOString();
    const priceCardId = index < 10 ? preChangeId : postChangeId;
    return {
      ...row,
      eventTime,
      lastPriorObservedAt: eventTime,
      firstNextObservedAt: eventTime,
      priceCardIds: [priceCardId],
      priceCardBreakdown: [{
        priceCardId,
        events: 1,
        costUsd: index < 10 ? "2.5" : "2",
      }],
    };
  });
  const report = analyzeWeeklyCalibration(dataset(transitions));

  assert.equal(report.resetValues.length, 1);
  assert.deepEqual(report.resetValues[0].priceCardIds, [postChangeId, preChangeId].sort());
  assert.deepEqual(report.resetValues[0].priceCardBreakdown, [
    { priceCardId: postChangeId, events: 10, costUsd: "20" },
    { priceCardId: preChangeId, events: 10, costUsd: "25" },
  ]);
});

test("weekly calibration merges a sequential primary-to-secondary slot move into one reset", () => {
  const reset = 1_785_000_000;
  const transitions = resetTransitions({ reset, slot: "primary" }).map((row, index) => ({
    ...row,
    slot: index < 10 ? "primary" : "secondary",
  }));
  const report = analyzeWeeklyCalibration(dataset(transitions));

  assert.equal(report.resetValues.length, 1);
  assert.equal(report.quality.exactResetGroups, 2);
  assert.equal(report.quality.selectedResetGroups, 1);
  assert.equal(report.quality.duplicateResetGroupsSuppressed, 0);
});

test("weekly calibration refuses simultaneous slots for one logical reset", () => {
  const reset = 1_785_000_000;
  const transitions = [
    ...resetTransitions({ reset, slot: "primary" }),
    ...resetTransitions({ reset, slot: "secondary" }),
  ];
  const report = analyzeWeeklyCalibration(dataset(transitions));

  assert.equal(report.resetValues.length, 0);
  assert.equal(report.quality.duplicateResetGroupsSuppressed, 1);
  assert.equal(report.duplicateResetGroupsSuppressed[0].reason, "simultaneous_slot_conflict");
});

test("weekly calibration keeps only non-overlapping observation windows in a continuity track", () => {
  const firstReset = 1_785_000_000;
  const resets = [
    firstReset,
    firstReset + 100,
    firstReset + 604_800,
    firstReset + 1_209_600,
  ];
  const report = analyzeWeeklyCalibration(dataset(resets.flatMap((reset, index) => resetTransitions({
    reset,
    capacityUsd: 600 + index * 10,
  }))));

  assert.equal(report.resetValues.length, 3);
  assert.ok(report.duplicateResetGroupsSuppressed.some((row) => row.reason === "overlapping_observation_window"));
  assert.ok(report.resetValues.every((row, index) => index === 0
    || report.resetValues[index - 1].lastObservedAt <= row.firstObservedAt));
});

function dataset(transitions) {
  return {
    parserVersion: "0.3.2",
    scope: {
      startAt: "2026-06-01T00:00:00.000Z",
      endAt: "2026-07-24T00:00:00.000Z",
      snapshotIntervalsIncluded: false,
    },
    pricing: { basis: "standard_openai_api_prices_not_codex_subscription_credits" },
    transitions,
  };
}

test("weekly calibration chooses Standard API when every candidate is identical", () => {
  const transitions = [1_785_000_000, 1_785_604_800, 1_786_209_600, 1_786_814_400]
    .flatMap((reset, index) => resetTransitions({ reset, capacityUsd: 600 + index * 10 }));
  const report = analyzeWeeklyCalibration(dataset(transitions));
  assert.equal(report.selection.selectedCandidateId, "standard_api");
  assert.equal(report.resetValues.length, 4);
  assert.ok(report.resetValues.every((row) => row.chronologicalHoldout.meanAbsoluteErrorPp < 0.2));
  assert.equal(report.interpretation.identifiedProviderAllowance, false);
  assert.equal(report.baselineReceipt.status, "different_dataset");
  assert.equal(report.displayLagSelection.selectedCandidateId, "no_delay");
  assert.match(renderWeeklyCalibrationReport(report), /not an identified provider allowance/i);
});

test("chronological holdout selects speed-weighted cost when later Standard cost underpredicts quota", () => {
  const weighted = (percent) => percent * 6;
  const transitions = [1_785_000_000, 1_785_604_800, 1_786_209_600, 1_786_814_400]
    .flatMap((reset) => resetTransitions({
      reset,
      capacityUsd: 600,
      weightedCost: weighted,
    }).map((row) => {
      const standard = (percent) => percent <= 14 ? percent * 6 : 84 + (percent - 14) * 3;
      return {
        ...row,
        lastPriorCumulativeApiPricedUsd: standard(row.priorUsedPercent),
        firstNextCumulativeApiPricedUsd: standard(row.nextUsedPercent),
      };
    }));
  const report = analyzeWeeklyCalibration(dataset(transitions));
  assert.equal(report.selection.selectedCandidateId, "speed_lower");
  const standard = report.selection.candidateScores.find((row) => row.id === "standard_api");
  const selected = report.selection.candidateScores.find((row) => row.id === "speed_lower");
  assert.ok(selected.pooledHoldoutMaePp < standard.pooledHoldoutMaePp);
  assert.ok(report.selection.standardBaselineImprovement.pooledRelativeFraction > 0);
});

test("prior-reset validation is no-look-ahead and stays within account and plan continuity tracks", () => {
  const resets = [1_785_000_000, 1_785_604_800, 1_786_209_600, 1_786_814_400];
  const firstAccount = resets.flatMap((reset, index) => resetTransitions({ reset, capacityUsd: 500 + index * 100 }));
  const secondAccount = resets.slice(0, 2).flatMap((reset) => resetTransitions({
    reset: reset + 10,
    capacityUsd: 2_000,
    accountScopeId: "scope-b",
    planVariant: "pro-5x",
  }));
  const report = analyzeWeeklyCalibration(dataset([...firstAccount, ...secondAccount]));
  const accountA = report.resetValues.filter((row) => row.accountScopeId === "scope-a");
  assert.equal(accountA[0].priorPrediction, null);
  assert.equal(accountA[1].priorPrediction, null);
  assert.equal(accountA[2].priorPrediction.priorResetCount, 2);
  assert.ok(accountA[2].priorPrediction.forecastCapacityUsd < 1_000);
  const accountB = report.resetValues.filter((row) => row.accountScopeId === "scope-b");
  assert.ok(accountB.every((row) => row.priorPrediction === null));
});

test("unstable reset slopes fail the pairwise-width quality gate", () => {
  const stable = [1_785_000_000, 1_785_604_800, 1_786_209_600]
    .flatMap((reset) => resetTransitions({ reset, capacityUsd: 600 }));
  const unstable = resetTransitions({ reset: 1_786_814_400, capacityUsd: 600 }).map((row) => ({
    ...row,
    lastPriorCumulativeApiPricedUsd: row.priorUsedPercent < 10 ? row.priorUsedPercent : row.priorUsedPercent * 100,
    firstNextCumulativeApiPricedUsd: row.nextUsedPercent < 10 ? row.nextUsedPercent : row.nextUsedPercent * 100,
    lastPriorCumulativeQuotaWeightedLowerUsd: row.priorUsedPercent < 10 ? row.priorUsedPercent : row.priorUsedPercent * 100,
    firstNextCumulativeQuotaWeightedLowerUsd: row.nextUsedPercent < 10 ? row.nextUsedPercent : row.nextUsedPercent * 100,
    lastPriorCumulativeQuotaWeightedUpperUsd: row.priorUsedPercent < 10 ? row.priorUsedPercent : row.priorUsedPercent * 100,
    firstNextCumulativeQuotaWeightedUpperUsd: row.nextUsedPercent < 10 ? row.nextUsedPercent : row.nextUsedPercent * 100,
  }));
  const report = analyzeWeeklyCalibration(dataset([...stable, ...unstable]));
  assert.equal(report.resetValues.length, 3);
});

test("forecast rule selection never changes an earlier prediction when a future reset changes", () => {
  const resets = Array.from({ length: 8 }, (_, index) => 1_785_000_000 + index * 604_800);
  const base = resets.flatMap((reset, index) => resetTransitions({ reset, capacityUsd: 500 + index * 25 }));
  const changed = resets.flatMap((reset, index) => resetTransitions({
    reset,
    capacityUsd: index === resets.length - 1 ? 4_000 : 500 + index * 25,
  }));
  const first = analyzeWeeklyCalibration(dataset(base));
  const second = analyzeWeeklyCalibration(dataset(changed));
  const targetIdentity = first.resetValues.at(-2).resetIdentity;
  assert.deepEqual(
    first.resetValues.find((row) => row.resetIdentity === targetIdentity).selectedForecast,
    second.resetValues.find((row) => row.resetIdentity === targetIdentity).selectedForecast,
  );
});

test("persistent regime candidate waits for two prior shifted resets", () => {
  const capacities = [500, 500, 500, 500, 800, 800, 800];
  const transitions = capacities.flatMap((capacityUsd, index) => resetTransitions({
    reset: 1_785_000_000 + index * 604_800,
    capacityUsd,
  }));
  const report = analyzeWeeklyCalibration(dataset(transitions));
  const regime = report.forecastModelSelection.candidates.find((candidate) => candidate.id === "regime_15pct_persistence_2");
  assert.deepEqual(regime.detectedRegimeForecasts, [report.resetValues[6].resetIdentity]);
  assert.ok(!regime.detectedRegimeForecasts.includes(report.resetValues[5].resetIdentity));
});

test("online checkpoints report insufficient evidence rather than inventing an update", () => {
  const transitions = Array.from({ length: 7 }, (_, index) => resetTransitions({
    reset: 1_785_000_000 + index * 604_800,
    capacityUsd: 600,
  })).flat();
  const report = analyzeWeeklyCalibration(dataset(transitions));
  assert.equal(report.onlineCalibration.selectionStatus, "insufficient_evidence");
  assert.equal(report.onlineCalibration.selectedCheckpointId, null);
  assert.equal(report.onlineCalibration.currentReset.status, "prior_only_online_update_rejected");
});

test("holdout error contributions form a complete audit allocation", () => {
  const transitions = Array.from({ length: 5 }, (_, index) => resetTransitions({
    reset: 1_785_000_000 + index * 604_800,
    capacityUsd: 600 + index * 20,
  }).map((row) => {
    const adjusted = (percent) => percent <= 14 ? percent * 6 : 84 + (percent - 14) * 5.5;
    return {
      ...row,
      lastPriorCumulativeApiPricedUsd: adjusted(row.priorUsedPercent),
      firstNextCumulativeApiPricedUsd: adjusted(row.nextUsedPercent),
      lastPriorCumulativeQuotaWeightedLowerUsd: adjusted(row.priorUsedPercent),
      firstNextCumulativeQuotaWeightedLowerUsd: adjusted(row.nextUsedPercent),
      lastPriorCumulativeQuotaWeightedUpperUsd: adjusted(row.priorUsedPercent),
      firstNextCumulativeQuotaWeightedUpperUsd: adjusted(row.nextUsedPercent),
    };
  })).flat();
  const report = analyzeWeeklyCalibration(dataset(transitions));
  const totalShare = report.errorConcentration.resets.reduce((sum, row) => sum + row.shareOfTotal, 0);
  assert.ok(Math.abs(totalShare - 1) < 1e-5);
  assert.ok(report.errorConcentration.resets.every((row) => row.evidenceProfile.coverage));
  assert.equal(verifyWeeklyCalibration(report).status, "passed");
});
