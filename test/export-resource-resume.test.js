import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPORT_RESOURCE_POLICY_VERSION,
  ExportResourceLimitError,
  createExportResourceGuard,
} from "../src/export-resource-policy.js";

function durableUsage(overrides = {}) {
  return {
    policyVersion: EXPORT_RESOURCE_POLICY_VERSION,
    sourceFiles: 2,
    sourceBytes: 20,
    directoryEntries: 3,
    lines: 4,
    oversizedIrrelevantLines: 1,
    outputRecords: 2,
    expandedRecordBytes: 8,
    cumulativeElapsedMs: 5,
    peakRssBytes: 11,
    workspaceHighWaterBytes: 12,
    recoveryReservations: 1,
    ...overrides,
  };
}

test("resumed guards retain cumulative line, output, and elapsed limits", () => {
  let now = 100;
  const initialUsage = durableUsage({ lines: 9, outputRecords: 2, expandedRecordBytes: 8, cumulativeElapsedMs: 9 });
  const guard = createExportResourceGuard({
    scope: "export_set",
    initialUsage,
    limits: {
      maximumElapsedMs: 10,
      maximumOutputRecords: 2,
      maximumExpandedRecordBytes: 8,
      maximumExportSetRecords: 2,
      maximumExportSetExpandedRecordBytes: 8,
    },
    clock: () => now,
    rss: () => 0,
  });

  guard.observeLine(1);
  assert.equal(guard.durableSnapshot().lines, 10);
  assert.throws(() => guard.observeOutputRecord(0), (error) => error instanceof ExportResourceLimitError
    && error.code === "export_resource_output_records");
  now += 2;
  assert.throws(() => guard.checkRuntime(), (error) => error instanceof ExportResourceLimitError
    && error.code === "export_resource_elapsed_time");
});

test("resumed source-plan gauges validate instead of double-counting discovery", () => {
  const guard = createExportResourceGuard({
    initialUsage: durableUsage(),
    limits: { maximumSourceFiles: 2, maximumSourceBytes: 20 },
    clock: () => 0,
    rss: () => 0,
  });

  guard.observeSourceFile(20);
  guard.observeSourcePlan(2, 20);
  assert.equal(guard.durableSnapshot().sourceFiles, 2);
  assert.equal(guard.durableSnapshot().sourceBytes, 20);
  assert.throws(() => guard.observeSourcePlan(3, 20), /does not match/);
  assert.throws(() => guard.observeSourcePlan(2, 21), /does not match/);
});

test("resumed resource high waters use maxima and durable output totals cannot reset", () => {
  let currentRss = 8;
  const guard = createExportResourceGuard({
    initialUsage: durableUsage({ peakRssBytes: 11, workspaceHighWaterBytes: 12 }),
    clock: () => 0,
    rss: () => currentRss,
  });

  guard.observeWorkspace(7);
  currentRss = 15;
  guard.checkRuntime();
  guard.observeWorkspace(17);
  currentRss = 9;
  guard.checkRuntime();
  const snapshot = guard.durableSnapshot();
  assert.equal(snapshot.peakRssBytes, 15);
  assert.equal(snapshot.workspaceHighWaterBytes, 17);
  assert.throws(() => guard.observeOutputTotals(1, 8), /cannot decrease/);
  assert.throws(() => guard.observeOutputTotals(2, 7), /cannot decrease/);
});

test("initial durable usage is strict and rejects policy or already-exceeded ceilings", () => {
  assert.throws(() => createExportResourceGuard({
    initialUsage: durableUsage({ policyVersion: "old-policy" }),
  }), /policy version/);
  assert.throws(() => createExportResourceGuard({
    initialUsage: durableUsage({ unexpected: 1 }),
  }), /exact durable usage shape/);
  assert.throws(() => createExportResourceGuard({
    initialUsage: durableUsage({ outputRecords: 3 }),
    limits: { maximumOutputRecords: 2 },
  }), (error) => error instanceof ExportResourceLimitError
    && error.code === "export_resource_output_records");
});
