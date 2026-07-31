import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  analyzeWeeklyCalibration,
  BOUNDED_WEEKLY_CALIBRATION_RESET_LIMIT,
  projectBoundedWeeklyCalibrationSummary,
  renderWeeklyCalibrationReport,
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
      slot: reset < 1_800_000_000 ? "secondary" : "primary",
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
