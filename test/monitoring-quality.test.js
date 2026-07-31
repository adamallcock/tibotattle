import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeMonitoringQuality,
  classifyMonitoringInterval,
  renderMonitoringQualityReport,
} from "../src/reporting/index.js";

function interval(overrides = {}) {
  return {
    provider: "openai_codex",
    planType: "pro",
    limitId: "codex",
    slot: "primary",
    windowDurationMins: 10_080,
    resetsAt: 1_800_000_000,
    eventTime: "2026-07-24T10:01:00.000Z",
    elapsedMs: 60_000,
    priorUsedPercent: 10,
    nextUsedPercent: 10,
    marginalUsageEventCount: 1,
    marginalApiPricedUsd: 1,
    tierUsageEventCounts: { standard: 1 },
    accountScopeId: "scope-v1:test",
    planVariant: "pro-20x",
    controlledState: "unknown",
    snapshot: { providerSnapshotAgeMs: 0 },
    quality: { elapsedTimeCoverageFraction: 1, pricingWarnings: [], attributionWarnings: [] },
    ...overrides,
  };
}

function fixture() {
  const reset = 1_800_000_000;
  const intervals = [
    interval({ eventTime: "2026-07-24T10:01:00.000Z" }),
    interval({ eventTime: "2026-07-24T10:02:00.000Z" }),
    interval({ eventTime: "2026-07-24T10:03:00.000Z", priorUsedPercent: 10, nextUsedPercent: 11 }),
    interval({ eventTime: "2026-07-24T10:04:00.000Z", priorUsedPercent: 11, nextUsedPercent: 10 }),
  ];
  return {
    schemaVersion: "0.3",
    parserVersion: "0.3.2",
    scope: { provider: "openai_codex", startAt: "2026-07-24T10:00:00.000Z", endAt: "2026-07-24T11:00:00.000Z" },
    diagnostics: { filesScanned: 2, malformedLines: 1, malformedUsageRecords: 0, missingRateLimitRecords: 0, malformedRateLimitRecords: 1, forkReplayEventsSkipped: 5, replayedEventsSkipped: 2 },
    windowGroups: [
      { ...intervals[0], snapshotCount: 5, transitionCount: 2, monotonicTransitionCount: 1, regressionTransitionCount: 1 },
      { ...intervals[0], resetsAt: reset + 1, snapshotCount: 1, transitionCount: 0, monotonicTransitionCount: 0, regressionTransitionCount: 0 },
      { ...intervals[0], limitId: "moving", resetsAt: reset + 500, snapshotCount: 1, transitionCount: 0, monotonicTransitionCount: 0, regressionTransitionCount: 0 },
      { ...intervals[0], limitId: "moving", resetsAt: reset + 800, snapshotCount: 1, transitionCount: 0, monotonicTransitionCount: 0, regressionTransitionCount: 0 },
    ],
    snapshotIntervals: intervals,
    transitions: [intervals[2], intervals[3]],
  };
}

test("classifies monitoring dimensions without collapsing unknown metadata into a score", () => {
  const flags = classifyMonitoringInterval(interval({
    accountScopeId: "unattributed",
    planVariant: "unknown",
    nextUsedPercent: 12,
    marginalUsageEventCount: 0,
    tierUsageEventCounts: { unknown: 1 },
    snapshot: { providerSnapshotAgeMs: null },
  }));
  assert.equal(flags.quotaSignal, "skipped_value");
  assert.equal(flags.localReceipt, "missing_for_increase");
  assert.equal(flags.speedCoverage, "unknown");
  assert.equal(flags.accountScope, "unknown");
  assert.equal(flags.providerSnapshotAge, "unknown");
  assert.equal(flags.fitEligible, false);
});

test("profiles collector freshness, reset jitter, quantization, and prioritized opportunities", () => {
  const collectorRecords = [{
    kind: "codex_quota_snapshot",
    source: "app_server_read",
    observedAt: "2026-07-24T10:00:00.000Z",
  }];
  const report = analyzeMonitoringQuality({
    transitions: fixture(),
    collectorRecords,
    now: "2026-07-24T12:00:00.000Z",
  });
  assert.equal(report.collector.status, "stale");
  assert.equal(report.scope.dominantSeries.limitId, "codex");
  assert.equal(report.resetFamilies[0].exactResetGroups, 2);
  assert.equal(report.resetFamilies[0].jitterClusters120s, 1);
  assert.equal(report.quantization.flatIntervals, 2);
  assert.equal(report.quantization.regressionIntervals, 1);
  assert.equal(report.quantization.runsBeforeIncrease, 1);
  assert.equal(report.quantization.usageEventsP50, 2);
  assert.ok(report.opportunities.some((row) => row.id === "collector_continuity" && row.priority === "P0"));
  assert.ok(report.opportunities.some((row) => row.id === "reset_identity_stabilization"));
  assert.match(renderMonitoringQualityReport(report), /Usage Monitor Quality Diagnostic/);
});

test("keeps continuity as a P0 when a refresh follows a long app-server gap", () => {
  const report = analyzeMonitoringQuality({
    transitions: fixture(),
    collectorRecords: [
      { kind: "codex_quota_snapshot", source: "app_server_read", observedAt: "2026-07-24T10:00:00.000Z" },
      { kind: "codex_quota_snapshot", source: "app_server_read", observedAt: "2026-07-24T11:59:55.000Z" },
    ],
    now: "2026-07-24T12:00:00.000Z",
  });
  assert.equal(report.collector.status, "fresh");
  assert.equal(report.collector.latestAppServerGapMs, 7_195_000);
  assert.ok(report.opportunities.some((row) => row.id === "collector_continuity" && /fresh after/.test(row.evidence)));
});
