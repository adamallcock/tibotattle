#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { scanAndPriceCodexLogs } from "./codex-local-usage-analysis.js";
import { writeJsonOwnerOnlyAtomic } from "./storage.js";

const root = process.cwd();
const calibrationPath = resolve(root, ".usage-monitor/weekly-calibration-v0.2.json");
const outputPath = resolve(root, ".usage-monitor/weekly-calibration-high-error-audit-v0.1.json");
const calibration = JSON.parse(await readFile(calibrationPath, "utf8"));
const resetByIdentity = new Map(calibration.resetValues.map((row) => [row.resetIdentity, row]));
const targets = calibration.errorConcentration.resets.slice(0, 2);
const resets = [];

for (const target of targets) {
  const reset = resetByIdentity.get(target.resetIdentity);
  if (!reset) throw new Error(`Missing reset row for ${target.resetIdentity}`);
  const scan = await scanAndPriceCodexLogs({
    startAt: reset.firstObservedAt,
    endAt: reset.lastObservedAt,
    offline: true,
  });
  resets.push({
    resetIdentity: target.resetIdentity,
    weekLabel: target.weekLabel,
    firstObservedAt: reset.firstObservedAt,
    lastObservedAt: reset.lastObservedAt,
    errorContribution: target,
    localSurfaceEvidence: {
      eventCount: scan.eventCount,
      totalTokens: scan.totalTokens,
      standardApiPricedUsd: scan.runcost.totalUsd,
      components: scan.components,
      bySurface: scan.bySurface,
      toolCallsByClass: scan.toolCallsByClass,
      serverBillableUnits: scan.serverBillableUnits,
      speedModeCounts: scan.runcost.observedTierUsageEventCounts,
      byModel: scan.runcost.byModel,
      sourceDiagnostics: {
        usageBearingRollouts: scan.diagnostics.usageBearingRollouts,
        replayedUsageEventsSkipped: scan.diagnostics.replayedUsageEventsSkipped,
        malformedUsageEvents: scan.diagnostics.malformedUsageEvents,
      },
    },
    unobservedSurfaceBoundary: [
      "chatgpt_web",
      "chatgpt_work",
      "codex_cloud_without_local_rollout",
      "other_machine",
      "voice_or_dictation",
      "third_party_authenticated_client",
    ],
  });
}

const report = {
  schemaVersion: "weekly-calibration-high-error-audit-v0.1",
  kind: "privacy_safe_high_error_reset_audit",
  generatedAt: new Date().toISOString(),
  sourceCalibration: ".usage-monitor/weekly-calibration-v0.2.json",
  selection: "two largest contributions to selected-ledger chronological holdout absolute error",
  resets,
  privacy: {
    contentStored: false,
    pathsStored: false,
    rawAccountIdentifiersStored: false,
    credentialsStored: false,
    toolArgumentsStored: false,
  },
};

await writeJsonOwnerOnlyAtomic(outputPath, report);
process.stdout.write(`${JSON.stringify({ outputPath, resetCount: resets.length }, null, 2)}\n`);
