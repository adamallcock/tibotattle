#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { mineCodexTransitions } from "./codex-transition-miner.js";
import { buildRollingHours } from "./simple-quota-gradient.js";

const root = process.cwd();
const historyPath = resolve(root, ".usage-monitor/weekly-limit-simple-history-2026-07-24-v0.1.json");
const outputPath = resolve(root, ".usage-monitor/rolling-quota-history-2026-06-11-to-2026-07-24-v0.1.json");
const startAt = "2026-06-11T00:00:00.000Z";
const endAt = "2026-07-24T13:51:29.000Z";
const weeklyWindowMins = 10_080;
const july13Reset = 1_784_487_650;

function seriesKey(row) {
  return [row.provider, row.planType, row.limitId, row.slot, row.windowDurationMins, row.resetsAt].join("|");
}

function timeLabels(timestamp) {
  const value = new Date(timestamp);
  const utc = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(value);
  const eastern = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(value);
  return { utc, eastern };
}

const history = JSON.parse(await readFile(historyPath, "utf8"));
const diagnostics = history.resetDiagnostics
  .filter((row) => row.windowDurationMins === weeklyWindowMins
    && Number.isFinite(row.descriptiveCapacityUsd)
    && (row.usableDiagnostic === true || row.resetsAt === july13Reset))
  .sort((left, right) => left.firstObservedAt.localeCompare(right.firstObservedAt));
const selectedByKey = new Map(diagnostics.map((row) => [seriesKey(row), row]));

const mined = await mineCodexTransitions({
  startAt,
  endAt,
  offline: true,
  includeSnapshotIntervals: true,
  windowDurationMins: weeklyWindowMins,
});
const groups = new Map();
for (const interval of mined.snapshotIntervals) {
  const key = seriesKey(interval);
  if (!selectedByKey.has(key)) continue;
  const rows = groups.get(key) ?? [];
  rows.push(interval);
  groups.set(key, rows);
}

const rollingRows = [];
const selectedResets = [];
for (const diagnostic of diagnostics) {
  const key = seriesKey(diagnostic);
  const intervals = groups.get(key) ?? [];
  if (intervals.length === 0) continue;
  const rows = buildRollingHours(intervals, diagnostic.descriptiveCapacityUsd, 3);
  for (const row of rows) {
    const labels = timeLabels(row.timestamp);
    rollingRows.push({
      ...row,
      utc_hour: labels.utc,
      eastern_hour: labels.eastern,
      reset_at: diagnostic.resetIdentity,
      reset_segment: key,
      reset_gradient_usd: diagnostic.descriptiveCapacityUsd,
      gradient_quality: diagnostic.usableDiagnostic ? "quality-qualified" : "diagnostic-only",
    });
  }
  if (rows.length > 0) {
    const breakAt = new Date(Date.parse(rows.at(-1).timestamp) + 1).toISOString();
    for (const series of ["Observed quota change", "Expected from API cost"]) {
      rollingRows.push({
        timestamp: breakAt,
        utc_hour: timeLabels(breakAt).utc,
        eastern_hour: timeLabels(breakAt).eastern,
        reset_at: diagnostic.resetIdentity,
        reset_segment: key,
        reset_gradient_usd: diagnostic.descriptiveCapacityUsd,
        gradient_quality: diagnostic.usableDiagnostic ? "quality-qualified" : "diagnostic-only",
        rolling_api_cost_usd: null,
        rolling_event_count: null,
        smoothing_hours: 3,
        series,
        quota_change_pp: null,
      });
    }
  }
  selectedResets.push({
    reset_at: diagnostic.resetIdentity,
    first_observed_at: diagnostic.firstObservedAt,
    last_observed_at: diagnostic.lastObservedAt,
    slot: diagnostic.slot,
    reset_gradient_usd: diagnostic.descriptiveCapacityUsd,
    gradient_quality: diagnostic.usableDiagnostic ? "quality-qualified" : "diagnostic-only",
    snapshot_intervals: intervals.length,
    rolling_points: rows.length / 2,
  });
}
rollingRows.sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.series.localeCompare(right.series));

const output = {
  schemaVersion: "0.1",
  materializedAt: new Date().toISOString(),
  scope: {
    startAt,
    endAt,
    provider: "openai_codex",
    windowDurationMins: weeklyWindowMins,
    smoothingHours: 3,
    timeZones: ["UTC", "America/New_York"],
  },
  source: {
    parserVersion: mined.parserVersion,
    filesScanned: mined.summary.filesScanned,
    weeklySnapshotIntervalsScanned: mined.summary.snapshotIntervals,
    selectedResetDiagnostics: selectedResets.length,
  },
  selectedResets,
  rows: rollingRows,
};

await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  outputPath,
  selectedResets: selectedResets.length,
  rollingRows: rollingRows.length,
  firstTimestamp: rollingRows[0]?.timestamp ?? null,
  lastTimestamp: rollingRows.at(-1)?.timestamp ?? null,
  weeklySnapshotIntervalsScanned: mined.summary.snapshotIntervals,
}, null, 2)}\n`);
