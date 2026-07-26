import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeQuotaCalibration,
  fitResetCapacity,
} from "../shared/quota-calibration.js";
import { buildResetEvidence } from "../shared/quota-tracks.js";

function opaqueId(kind, value) {
  return `${kind}:v1:${BigInt(value).toString(16).padStart(64, "0")}`;
}

function iso(timestampMs) {
  return new Date(timestampMs).toISOString();
}

function calibrationInput({
  duration = 300,
  capacities = [600_000_000_000],
  pointCount = 10,
} = {}) {
  const datasets = [];
  const quotaSnapshots = [];
  const usageEvents = [];
  const baseResetMs = Date.UTC(2026, 0, 8);
  const durationMs = duration * 60_000;
  const spacingMs = Math.floor(durationMs / 15);
  const accountTrackId = opaqueId("account-track", 1);

  capacities.forEach((capacityNanousd, resetIndex) => {
    const resetAtMs = baseResetMs + resetIndex * durationMs;
    const firstObservedMs = resetAtMs - durationMs + spacingMs;
    const datasetId = opaqueId("dataset", 1_000 + resetIndex);
    datasets.push({ datasetId, complete: true });
    for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
      quotaSnapshots.push({
        snapshotId: opaqueId(
          "snapshot",
          10_000 + resetIndex * 100 + pointIndex,
        ),
        datasetId,
        accountTrackId,
        provider: "openai",
        planType: "subscription",
        planVariant: "pro",
        limitId: "shared-quota",
        slot: resetIndex % 2 === 0 ? "primary" : "secondary",
        windowDurationMinutes: duration,
        resetsAt: iso(resetAtMs),
        observedAt: iso(firstObservedMs + pointIndex * spacingMs),
        receivedAt: iso(firstObservedMs + pointIndex * spacingMs),
        usedPercent: pointIndex,
        displayPrecision: 0,
        policyEpoch: "quota-v1",
      });
      if (pointIndex > 0) {
        usageEvents.push({
          eventId: opaqueId(
            "event",
            20_000 + resetIndex * 100 + pointIndex,
          ),
          datasetId,
          accountTrackId,
          provider: "openai",
          planType: "subscription",
          planVariant: "pro",
          limitId: "shared-quota",
          observedAt: iso(
            firstObservedMs + (pointIndex - 0.5) * spacingMs,
          ),
          costNanousd: capacityNanousd / 100,
          pricingStatus: "fully_priced",
          policyEpoch: "quota-v1",
        });
      }
    }
  });
  return { datasets, quotaSnapshots, usageEvents };
}

function analyze(options) {
  return analyzeQuotaCalibration(buildResetEvidence(calibrationInput(options)));
}

function compactTrack(track) {
  const compactScore = (score) => score ? {
    pointCount: score.pointCount,
    meanAbsoluteErrorPp: score.meanAbsoluteErrorPp,
    signedBiasPp: score.signedBiasPp,
    finalDifferencePp: score.finalDifferencePp,
    rows: score.rows.map(({ observedAt: _observedAt, ...row }) => row),
  } : null;
  return {
    estimatedResetCount: track.estimatedResetCount,
    medianCapacityNanousd: track.medianCapacityNanousd,
    acrossResetSensitivityRangeNanousd:
      track.acrossResetSensitivityRangeNanousd,
    empiricalForecastError: track.empiricalForecastError,
    resetFits: track.resets.map((row) => ({
      status: row.status,
      capacityNanousd: row.capacityNanousd,
      trainingCount: row.training?.boundaryCount ?? null,
      holdoutCount: row.holdout?.boundaryCount ?? null,
      priorResetCount: row.priorForecast?.priorResetCount ?? null,
      forecastScore: compactScore(row.priorForecast?.score),
    })),
  };
}

test("five-hour and seven-day reset calibration have duration-generic behavior", () => {
  const capacities = [
    600_000_000_000,
    620_000_000_000,
    610_000_000_000,
    630_000_000_000,
    605_000_000_000,
  ];
  const fiveHour = analyze({ duration: 300, capacities }).tracks[0];
  const sevenDay = analyze({ duration: 10_080, capacities }).tracks[0];
  assert.deepEqual(compactTrack(sevenDay), compactTrack(fiveHour));
  assert.equal(fiveHour.windowDurationMinutes, 300);
  assert.equal(sevenDay.windowDurationMinutes, 10_080);
  assert.equal(fiveHour.resets[0].training.boundaryCount, 7);
  assert.equal(fiveHour.resets[0].holdout.boundaryCount, 3);
});

test("forecasts use two to three completed prior resets and never future resets", () => {
  const firstFour = analyze({
    capacities: [
      600_000_000_000,
      610_000_000_000,
      620_000_000_000,
      630_000_000_000,
    ],
  }).tracks[0];
  const withFuture = analyze({
    capacities: [
      600_000_000_000,
      610_000_000_000,
      620_000_000_000,
      630_000_000_000,
      2_000_000_000_000,
    ],
  }).tracks[0];
  assert.deepEqual(withFuture.resets[3], firstFour.resets[3]);
  assert.equal(withFuture.resets[0].priorForecast, null);
  assert.equal(withFuture.resets[1].priorForecast, null);
  assert.equal(withFuture.resets[2].priorForecast.priorResetCount, 2);
  assert.equal(withFuture.resets[4].priorForecast.priorResetCount, 3);
  for (const row of withFuture.resets.slice(2)) {
    assert.ok(row.priorForecast.trainedThrough <= row.firstObservedAt);
  }
});

test("the later thirty percent is scored but cannot change the fitted capacity", () => {
  const baselineInput = calibrationInput();
  const perturbedInput = structuredClone(baselineInput);
  perturbedInput.usageEvents.at(-1).costNanousd = 60_000_000_000;
  perturbedInput.usageEvents.at(-2).costNanousd = 60_000_000_000;
  const baseline = fitResetCapacity(buildResetEvidence(baselineInput).resets[0]);
  const perturbed = fitResetCapacity(buildResetEvidence(perturbedInput).resets[0]);
  assert.equal(perturbed.capacityNanousd, baseline.capacityNanousd);
  assert.notEqual(
    perturbed.holdout.meanAbsoluteErrorPp,
    baseline.holdout.meanAbsoluteErrorPp,
  );
});

test("uncertainty and empirical errors remain null below their sample gates", () => {
  const belowGate = analyze({
    capacities: [600_000_000_000, 610_000_000_000],
  }).tracks[0];
  assert.equal(belowGate.acrossResetSensitivityRangeNanousd, null);
  assert.equal(belowGate.empiricalForecastError, null);

  const enough = analyze({
    capacities: [
      600_000_000_000,
      610_000_000_000,
      620_000_000_000,
      630_000_000_000,
      640_000_000_000,
    ],
  }).tracks[0];
  assert.notEqual(enough.acrossResetSensitivityRangeNanousd, null);
  assert.equal(enough.empiricalForecastError.scoredResetCount, 3);
});

test("insufficient boundaries are refused without producing estimates", () => {
  const evidence = buildResetEvidence(
    calibrationInput({ pointCount: 4 }),
  ).resets[0];
  const result = fitResetCapacity(evidence);
  assert.equal(result.status, "not_testable");
  assert.equal(result.capacityNanousd, null);
  assert.ok(result.refusalCodes.includes("too_few_boundaries"));
  assert.ok(result.refusalCodes.includes("insufficient_holdout_boundaries"));
});

test("calibration output is deterministic under arbitrary input ordering", () => {
  const input = calibrationInput({
    capacities: [
      600_000_000_000,
      610_000_000_000,
      620_000_000_000,
      630_000_000_000,
    ],
  });
  const expected = analyzeQuotaCalibration(buildResetEvidence(input));
  const reversed = {
    datasets: [...input.datasets].reverse(),
    quotaSnapshots: [...input.quotaSnapshots].reverse(),
    usageEvents: [...input.usageEvents].reverse(),
  };
  assert.deepEqual(
    analyzeQuotaCalibration(buildResetEvidence(reversed)),
    expected,
  );
});
