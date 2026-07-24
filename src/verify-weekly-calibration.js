#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { writeJsonOwnerOnlyAtomic } from "./storage.js";

function median(values) {
  const ordered = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (ordered.length === 0) return null;
  const middle = (ordered.length - 1) / 2;
  const lower = Math.floor(middle);
  const upper = Math.ceil(middle);
  return lower === upper ? ordered[lower] : (ordered[lower] + ordered[upper]) / 2;
}

function close(actual, expected, tolerance = 1e-6) {
  return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance;
}

export function verifyWeeklyCalibration(report) {
  const failures = [];
  const check = (id, passed, evidence) => {
    if (!passed) failures.push({ id, evidence });
  };
  const selected = report.selection.candidateScores.find((row) => row.id === report.selection.selectedCandidateId);
  const values = report.resetValues.map((row) => row.apiPriceEquivalentUsd);
  const holdoutPoints = report.resetValues.flatMap((row) => Array.from(
    { length: row.chronologicalHoldout.holdoutPointCount },
    () => ({ mae: row.chronologicalHoldout.meanAbsoluteErrorPp, bias: row.chronologicalHoldout.signedBiasPp }),
  ));
  const weightedHoldoutMae = holdoutPoints.reduce((sum, row) => sum + row.mae, 0) / holdoutPoints.length;
  const weightedHoldoutBias = holdoutPoints.reduce((sum, row) => sum + row.bias, 0) / holdoutPoints.length;
  const priorPoints = report.resetValues.flatMap((row) => row.priorPrediction?.rows ?? []);
  const priorMae = priorPoints.reduce((sum, row) => sum + row.absoluteErrorPp, 0) / priorPoints.length;
  const priorBias = priorPoints.reduce((sum, row) => sum + row.residualPp, 0) / priorPoints.length;
  check("reset_count", report.weeklyValueSummary.resetCount === report.resetValues.length, {
    summary: report.weeklyValueSummary.resetCount,
    rows: report.resetValues.length,
  });
  check("median_value", close(median(values), report.weeklyValueSummary.medianApiPriceEquivalentUsd), {
    recomputed: median(values),
    reported: report.weeklyValueSummary.medianApiPriceEquivalentUsd,
  });
  check("selected_holdout_mae", close(weightedHoldoutMae, selected.pooledHoldoutMaePp), {
    recomputed: weightedHoldoutMae,
    reported: selected.pooledHoldoutMaePp,
  });
  check("selected_holdout_bias", close(weightedHoldoutBias, selected.pooledHoldoutBiasPp), {
    recomputed: weightedHoldoutBias,
    reported: selected.pooledHoldoutBiasPp,
  });
  check("prior_mae", close(priorMae, report.prospectiveStyleValidation.pooledMeanAbsoluteErrorPp), {
    recomputed: priorMae,
    reported: report.prospectiveStyleValidation.pooledMeanAbsoluteErrorPp,
  });
  check("prior_bias", close(priorBias, report.prospectiveStyleValidation.pooledSignedBiasPp), {
    recomputed: priorBias,
    reported: report.prospectiveStyleValidation.pooledSignedBiasPp,
  });
  const contributionShare = report.errorConcentration.resets.reduce((sum, row) => sum + row.shareOfTotal, 0);
  check("error_contribution_allocation", close(contributionShare, 1, 1e-5), { recomputed: contributionShare });
  const resetByIdentity = new Map(report.resetValues.map((row) => [row.resetIdentity, row]));
  for (const row of report.resetValues) {
    for (const forecast of [row.priorPrediction, row.selectedForecast].filter(Boolean)) {
      for (const priorIdentity of forecast.priorResetIdentities ?? []) {
        const prior = resetByIdentity.get(priorIdentity);
        check("forecast_prior_exists", Boolean(prior), { resetIdentity: row.resetIdentity, priorIdentity });
        if (!prior) continue;
        check("forecast_no_future", prior.lastObservedAt <= row.firstObservedAt, {
          resetIdentity: row.resetIdentity,
          priorIdentity,
          priorLastObservedAt: prior.lastObservedAt,
          currentFirstObservedAt: row.firstObservedAt,
        });
        check("forecast_partition_isolation", prior.continuityTrack === row.continuityTrack, {
          resetIdentity: row.resetIdentity,
          priorIdentity,
          priorTrack: prior.continuityTrack,
          currentTrack: row.continuityTrack,
        });
      }
    }
    for (const checkpoint of Object.values(row.onlineCheckpoints ?? {}).filter(Boolean)) {
      const scored = [checkpoint.onlineScore, checkpoint.correctedOnlineScore, checkpoint.priorScore].filter(Boolean);
      check("checkpoint_prefix_has_later_data", checkpoint.trainingBoundaryCount + checkpoint.laterBoundaryCount === row.pointCount, {
        resetIdentity: row.resetIdentity,
        checkpointId: checkpoint.checkpointId,
      });
      for (const score of scored) {
        check("checkpoint_no_lookahead", score.rows.every((point) => point.observedAt > checkpoint.checkpointObservedAt), {
          resetIdentity: row.resetIdentity,
          checkpointId: checkpoint.checkpointId,
          checkpointObservedAt: checkpoint.checkpointObservedAt,
        });
      }
    }
  }
  return {
    schemaVersion: "weekly-calibration-verification-v0.1",
    status: failures.length === 0 ? "passed" : "failed",
    checkedAt: new Date().toISOString(),
    checkCount: 7 + report.resetValues.reduce((sum, row) => sum
      + (row.priorPrediction?.priorResetIdentities?.length ?? 0) * 3
      + (row.selectedForecast?.priorResetIdentities?.length ?? 0) * 3
      + Object.values(row.onlineCheckpoints ?? {}).filter(Boolean).length, 0),
    failures,
  };
}

async function main() {
  const inputPath = resolve(process.argv[2] ?? ".usage-monitor/weekly-calibration-v0.2.json");
  const outputPath = resolve(process.argv[3] ?? ".usage-monitor/weekly-calibration-verification-v0.1.json");
  const report = JSON.parse(await readFile(inputPath, "utf8"));
  const receipt = verifyWeeklyCalibration(report);
  await writeJsonOwnerOnlyAtomic(outputPath, receipt);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.status !== "passed") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
