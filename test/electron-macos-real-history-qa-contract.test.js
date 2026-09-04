import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  REAL_HISTORY_QA_MODES,
  REAL_HISTORY_QA_CONTROL_PLANE_P95_MAX_LATENCY_MS,
  REAL_HISTORY_QA_TIMEOUTS,
  REAL_HISTORY_QA_QUICK_RESULT_MAX_MS,
  buildRealHistoryReceipt,
  cancelHttpResponseValid,
  capturedDescendantPidsGone,
  capturedDescendantPidsValid,
  classifyAdvancedModuleText,
  classifyRealHistoryTerminal,
  communityServiceConfigurationState,
  communityParitySnapshotValid,
  controlPlaneLatencyP95Ms,
  controlPlaneSnapshotValid,
  createControlPlaneObserver,
  createNetworkBoundaryObserver,
  createRefreshObserver,
  localQaCommunityParitySnapshotValid,
  parseRealHistoryArguments,
  realHistoryDashboardReadySnapshotValid,
  realHistoryCancelBoundaryReady,
  releaseRealHistoryRefreshGate,
  runLaunchGate,
  sampleTimerAndControlPlaneConcurrently,
  waitForLaunchGate,
  waitFor,
  verifyPackagedArtifactIdentity,
  usageParitySnapshotValid,
} from "../scripts/qa-electron-macos-real-history.mjs";

const VALID_ARGS = [
  "--app", "/tmp/TiboTattle Dev.app",
  "--profile", "/tmp/tibotattle-real-history-profile",
  "--codex-home", "/tmp/codex-home",
  "--artifact-sha256", "a".repeat(64),
  "--source-revision", "1".repeat(40),
];

function degradedRefresh(overrides = {}) {
  return {
    status: "degraded",
    refreshId: "internal-refresh-id",
    errorCode: "refresh_degraded",
    failedStep: "unified_index",
    failureCode: "codex_rollout_generation_ambiguous",
    result: {
      unifiedIndex: {
        status: "ingested",
        generation: {
          status: "partial",
          blockReason: "codex_rollout_sources_quarantined",
          skippedSourceCount: 4,
          skippedThreadCount: 2,
          reasonCounts: {
            codex_rollout_generation_ambiguous: 2,
          },
          discoveryComplete: true,
          diagnosticsComplete: true,
          usageProvenanceComplete: true,
          sourceOrderComplete: true,
          quotaProvenanceComplete: true,
        },
      },
      accounting: {
        status: "replay_safe",
        sourceMode: "unified",
        coverageStatus: "partial",
        generationMatched: true,
        fallbackCount: 0,
        diagnosticsAvailable: true,
      },
    },
    ...overrides,
  };
}

test("real-history QA requires explicit isolated inputs and bounded modes", () => {
  assert.deepEqual(REAL_HISTORY_QA_MODES, ["cancel", "snapshot", "full", "relaunch"]);
  const parsed = parseRealHistoryArguments(VALID_ARGS.concat(["--mode", "relaunch", "--debug-port", "43210"]));
  assert.deepEqual(parsed, {
    help: false,
    appPath: "/tmp/TiboTattle Dev.app",
    profilePath: "/tmp/tibotattle-real-history-profile",
    codexHomePath: "/tmp/codex-home",
    mode: "relaunch",
    debugPort: 43210,
    receiptPath: null,
    artifactSha256: "a".repeat(64),
    sourceRevision: "1".repeat(40),
  });
  for (const args of [
    [],
    VALID_ARGS.slice(0, -2),
    VALID_ARGS.concat(["--mode", "unknown"]),
    VALID_ARGS.concat(["--debug-port", "80"]),
    VALID_ARGS.concat(["--app", "relative.app"]),
    VALID_ARGS.concat(["--profile", "/tmp/codex-home"]),
    VALID_ARGS.concat(["--unknown", "value"]),
    VALID_ARGS.concat(["--artifact-sha256", "A".repeat(64)]),
    VALID_ARGS.concat(["--source-revision", "A".repeat(40)]),
    VALID_ARGS.concat(["--source-revision", "2".repeat(40)]),
  ]) {
    assert.throws(() => parseRealHistoryArguments(args), (error) => {
      assert.equal(error.code, "REAL_HISTORY_QA_INPUT_INVALID");
      assert.equal(error.qaReason, "input_invalid");
      return true;
    });
  }
  assert.deepEqual(parseRealHistoryArguments(["--help"]), { help: true });
  assert.equal(
    parseRealHistoryArguments(VALID_ARGS.concat(["--receipt", "/tmp/receipt.json"]))
      .receiptPath,
    "/tmp/receipt.json",
  );
  assert.equal(
    parseRealHistoryArguments(VALID_ARGS.concat(["--mode", "snapshot"]))
      .mode,
    "snapshot",
  );
  assert.equal(
    parseRealHistoryArguments(
      VALID_ARGS.filter((value, index, values) => value !== "--source-revision"
        && values[index - 1] !== "--source-revision"),
      { SOURCE_REVISION: "2".repeat(40) },
    ).sourceRevision,
    "2".repeat(40),
  );
  assert.throws(
    () => parseRealHistoryArguments(
      VALID_ARGS,
      { SOURCE_REVISION: "2".repeat(40) },
    ),
    (error) => error.code === "REAL_HISTORY_QA_INPUT_INVALID"
      && error.qaReason === "input_invalid",
  );
});

test("real-history QA preserves macOS login Keychain discovery while isolating app state", async () => {
  const source = await readFile("scripts/qa-electron-macos-real-history.mjs", "utf8");
  assert.match(source, /HOME: process\.env\.HOME/u);
  assert.doesNotMatch(source, /HOME: fixture\.roots\.home/u);
  assert.match(source, /--user-data-dir=\$\{fixture\.userData\}/u);
  assert.match(source, /USAGE_MONITOR_STATE_ROOT: fixture\.roots\.state/u);
  assert.match(source, /XDG_CONFIG_HOME: fixture\.roots\.config/u);
  assert.match(source, /USAGE_MONITOR_TEST_LANE: MACOS_LOCAL_QA_TEST_LANE/u);
});

test("real-history timeout budgets are finite and bounded", () => {
  for (const [name, value] of Object.entries(REAL_HISTORY_QA_TIMEOUTS)) {
    assert.ok(Number.isSafeInteger(value), `${name} must be an integer`);
    assert.ok(value > 0, `${name} must be positive`);
    assert.ok(value <= 125 * 60_000, `${name} must be bounded`);
  }
  assert.ok(REAL_HISTORY_QA_TIMEOUTS.healthMs <= REAL_HISTORY_QA_TIMEOUTS.operationMs * 2);
  assert.equal(REAL_HISTORY_QA_TIMEOUTS.refreshMs, 45 * 60_000);
  assert.equal(REAL_HISTORY_QA_CONTROL_PLANE_P95_MAX_LATENCY_MS, 250);
  assert.equal(REAL_HISTORY_QA_QUICK_RESULT_MAX_MS, 30_000);
});

test("real-history launch gates classify raw timeout and setup errors without exposing them", async () => {
  const launchGate = {
    code: "REAL_HISTORY_QA_LAUNCH_FAILED",
    stage: "launch",
    reason: "launch_failed",
  };
  const dashboardGate = {
    code: "REAL_HISTORY_QA_DASHBOARD_UNAVAILABLE",
    stage: "dashboard",
    reason: "dashboard_unavailable",
  };
  await assert.rejects(
    () => waitForLaunchGate(
      () => null,
      1,
      "test remote debugging",
      launchGate,
      1,
    ),
    (error) => {
      assert.equal(error.code, launchGate.code);
      assert.equal(error.qaStage, launchGate.stage);
      assert.equal(error.qaReason, launchGate.reason);
      assert.equal(Object.hasOwn(error, "cause"), false);
      return true;
    },
  );
  await assert.rejects(
    () => runLaunchGate(
      () => { throw new Error("machine-specific setup detail"); },
      dashboardGate,
    ),
    (error) => {
      assert.equal(error.code, dashboardGate.code);
      assert.equal(error.qaStage, dashboardGate.stage);
      assert.equal(error.qaReason, dashboardGate.reason);
      assert.equal(error.message, dashboardGate.code);
      assert.equal(Object.hasOwn(error, "cause"), false);
      return true;
    },
  );
  const receipt = buildRealHistoryReceipt({
    status: "failed",
    failureStage: dashboardGate.stage,
    failureReason: dashboardGate.reason,
    artifactSha256: "b".repeat(64),
    artifactIdentityVerified: true,
  });
  assert.equal(receipt.failureStage, "dashboard");
  assert.equal(receipt.failureReason, "dashboard_unavailable");
  assert.equal(JSON.stringify(receipt).includes("machine-specific"), false);
});

test("real-history startup gate requires the exact preload release bridge and returns structured refresh failures", async () => {
  const makeCdp = (value) => ({
    async evaluate() {
      return value;
    },
  });
  assert.equal(await releaseRealHistoryRefreshGate(makeCdp(true)), true);
  for (const value of [false, null, undefined]) {
    await assert.rejects(
      () => releaseRealHistoryRefreshGate(makeCdp(value)),
      (error) => {
        assert.equal(error.code, "REAL_HISTORY_QA_REFRESH_NOT_STARTED");
        assert.equal(error.qaStage, "refresh");
        assert.equal(error.qaReason, "refresh_not_started");
        return true;
      },
    );
  }
  await assert.rejects(
    () => releaseRealHistoryRefreshGate({
      async evaluate() {
        throw new Error("private CDP detail");
      },
    }),
    (error) => {
      assert.equal(error.code, "REAL_HISTORY_QA_DASHBOARD_UNAVAILABLE");
      assert.equal(error.qaStage, "dashboard");
      assert.equal(error.qaReason, "dashboard_unavailable");
      assert.equal(JSON.stringify(error).includes("private CDP detail"), false);
      return true;
    },
  );
});

test("real-history dashboard readiness retries truthy boot snapshots until the exact root is ready", async () => {
  const expectedOrigin = "http://127.0.0.1:49299";
  const snapshots = [
    {
      ready: false,
      title: "TiboTattle",
      heading: "",
      location: `${expectedOrigin}/`,
    },
    {
      ready: true,
      title: "Loading TiboTattle",
      heading: "Where your allowance stands",
      location: `${expectedOrigin}/`,
    },
    {
      ready: true,
      title: "TiboTattle",
      heading: "Where your allowance stands",
      location: `${expectedOrigin}/#weekly`,
    },
    {
      ready: true,
      title: "TiboTattle",
      heading: "Where your allowance stands",
      location: `${expectedOrigin}/`,
    },
  ];
  let attempts = 0;
  const ready = await waitFor(() => {
    const snapshot = snapshots[Math.min(attempts++, snapshots.length - 1)];
    return realHistoryDashboardReadySnapshotValid(snapshot, expectedOrigin)
      ? snapshot
      : null;
  }, 2_000, "test dashboard readiness", 1);
  assert.equal(attempts, 4);
  assert.deepEqual(ready, snapshots[3]);

  for (const invalid of [
    { ...snapshots[3], ready: false },
    { ...snapshots[3], title: "Loading TiboTattle" },
    { ...snapshots[3], heading: "   " },
    { ...snapshots[3], location: `${expectedOrigin}/electron-settings.html` },
    { ...snapshots[3], location: `${expectedOrigin}/?ready=1` },
    { ...snapshots[3], location: `${expectedOrigin}/#overview` },
    { ...snapshots[3], location: "http://localhost:49299/" },
  ]) {
    assert.equal(realHistoryDashboardReadySnapshotValid(invalid, expectedOrigin), false);
  }
});

test("full-history terminal acceptance allows success and only coherent quarantine degradation", () => {
  assert.deepEqual(
    classifyRealHistoryTerminal({ status: "succeeded", refreshId: "internal" }),
    { accepted: true, terminalStatus: "succeeded", degradedFailureCode: null },
  );
  assert.deepEqual(
    classifyRealHistoryTerminal(degradedRefresh()),
    {
      accepted: true,
      terminalStatus: "degraded",
      degradedFailureCode: "codex_rollout_generation_ambiguous",
    },
  );
  assert.equal(classifyRealHistoryTerminal(degradedRefresh({
    result: {
      ...degradedRefresh().result,
      accounting: {
        ...degradedRefresh().result.accounting,
        generationMatched: false,
      },
    },
  })).accepted, false);
  assert.equal(classifyRealHistoryTerminal({
    ...degradedRefresh(),
    failureCode: "private_unbounded_error",
  }).accepted, false);
  assert.equal(classifyRealHistoryTerminal(degradedRefresh({
    result: {
      ...degradedRefresh().result,
      unifiedIndex: {
        ...degradedRefresh().result.unifiedIndex,
        generation: {
          ...degradedRefresh().result.unifiedIndex.generation,
          reasonCounts: undefined,
        },
      },
    },
  })).accepted, false);
  assert.equal(classifyRealHistoryTerminal(degradedRefresh({
    result: {
      ...degradedRefresh().result,
      unifiedIndex: {
        ...degradedRefresh().result.unifiedIndex,
        generation: {
          ...degradedRefresh().result.unifiedIndex.generation,
          reasonCounts: { codex_rollout_generation_ambiguous: 0 },
        },
      },
    },
  })).accepted, false);
  assert.equal(classifyRealHistoryTerminal(degradedRefresh({
    result: {
      ...degradedRefresh().result,
      unifiedIndex: {
        ...degradedRefresh().result.unifiedIndex,
        generation: {
          ...degradedRefresh().result.unifiedIndex.generation,
          reasonCounts: { codex_rollout_content_invalid: 2 },
        },
      },
    },
  })).accepted, false);
  assert.equal(classifyRealHistoryTerminal({ status: "failed" }).accepted, false);
});

test("real-history receipt is allowlisted, content-free, and strips refresh identity", () => {
  const receipt = buildRealHistoryReceipt({
    mode: "relaunch",
    status: "passed",
    cleanQuit: true,
    timer: { sampleCount: 5, uniqueCount: 5, advanced: true },
    controlPlane: {
      active: true,
      sampleCount: 3,
      healthSuccessCount: 3,
      refreshStatusSuccessCount: 3,
      maxLatencyMs: 21,
      p95LatencyMs: 21,
    },
    cancel: {
      acknowledgedMs: 40,
      terminalMs: 120,
      terminalStatus: "cancelled",
      http: { requestCount: 1, status: 202, latencyMs: 12, accepted: true },
    },
    retry: {
      newRefreshId: true,
      accepted: true,
      terminalStatus: "cancelled",
      cancelHttp: { requestCount: 1, status: 202, latencyMs: 9, accepted: true },
    },
    artifactSha256: "b".repeat(64),
    artifactIdentityVerified: true,
    sourceRevision: "1".repeat(40),
    startup: {
      requestCount: 1,
      refreshIdChanged: true,
      terminalStatus: "degraded",
      degradedFailureCode: "codex_rollout_generation_ambiguous",
      quickResultObserved: true,
      quickResultDurationMs: 1_234,
      refreshId: "private-refresh-id",
    },
    parity: {
      dashboard: { populated: true },
      usage: {
        pageVisible: true,
        periodCount: 4,
        summaryCardCount: 4,
        meaningfulTokenRows: 3,
        meaningfulCostRows: 2,
        meaningfulModelRows: 1,
        meaningfulModelMetricCells: 3,
        advancedModulesAvailable: 2,
        advancedModulesUnavailable: 1,
        advancedModulesExplicit: true,
        advancedModulesReady: true,
      },
      community: {
        pageVisible: true,
        serviceConfigured: true,
        serviceReachability: "ok",
        serviceReachabilityProven: true,
        currentLayout: true,
        providerControlsEnabled: true,
        indexTerminal: true,
        partialHistoryDetail: true,
      },
    },
    relaunch: {
      persistedDashboard: true,
      newAutomaticRefresh: true,
      firstTerminalStatus: "succeeded",
      secondTerminalStatus: "degraded",
      firstRefreshId: "private-first-id",
      secondRefreshId: "private-second-id",
    },
  });
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.contentFree, true);
  assert.equal(receipt.sourceRevision, "1".repeat(40));
  assert.equal(receipt.sourceRevisionBound, true);
  assert.deepEqual(receipt.artifact, {
    sha256: "b".repeat(64),
    identityBound: true,
  });
  assert.deepEqual(buildRealHistoryReceipt({ status: "failed", artifactSha256: "b".repeat(64) }).artifact, {
    sha256: null,
    identityBound: false,
  });
  assert.equal(receipt.cleanQuit, true);
  assert.equal(receipt.parity.usage.meaningfulModelMetricCells, 3);
  assert.equal(receipt.parity.usage.advancedModulesAvailable, 2);
  assert.equal(receipt.parity.usage.advancedModulesUnavailable, 1);
  assert.equal(receipt.parity.community.providerControlsEnabled, true);
  assert.equal(receipt.parity.community.serviceReachability, "ok");
  assert.equal(receipt.parity.community.serviceReachabilityProven, true);
  assert.equal(receipt.startupRefresh.terminalStatus, "degraded");
  assert.equal(receipt.startupRefresh.quickResultObserved, true);
  assert.equal(receipt.startupRefresh.quickResultDurationMs, 1_234);
  assert.equal(receipt.startupRefresh.timedOut, false);
  assert.deepEqual(receipt.controlPlane, {
    active: true,
    sampleCount: 3,
    healthSuccessCount: 3,
    refreshStatusSuccessCount: 3,
    maxLatencyMs: 21,
    p95LatencyMs: 21,
  });
  assert.deepEqual(receipt.cancel.http, {
    requestCount: 1,
    status: 202,
    latencyMs: 12,
    accepted: true,
  });
  assert.deepEqual(receipt.retry.cancelHttp, {
    requestCount: 1,
    status: 202,
    latencyMs: 9,
    accepted: true,
  });
  assert.equal(receipt.relaunch.persistedDashboard, true);
  assert.equal(receipt.relaunch.newAutomaticRefresh, true);
  assert.equal(Object.hasOwn(receipt, "refreshId"), false);
  assert.equal(JSON.stringify(receipt).includes("private-refresh-id"), false);
  assert.equal(JSON.stringify(receipt).includes("private-first-id"), false);
  assert.equal(JSON.stringify(receipt).includes("127.0.0.1"), false);
  assert.equal(JSON.stringify(receipt).includes("/tmp/"), false);
  assert.equal(JSON.stringify(receipt).includes("http://"), false);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.startupRefresh), true);
  assert.equal(Object.isFrozen(receipt.controlPlane), true);
  assert.equal(Object.isFrozen(receipt.cancel.http), true);
});

test("snapshot receipt proves seeded parity without claiming terminal refresh", () => {
  const receipt = buildRealHistoryReceipt({
    mode: "snapshot",
    status: "passed",
    cleanQuit: true,
    artifactSha256: "c".repeat(64),
    artifactIdentityVerified: true,
    sourceRevision: "2".repeat(40),
    startup: {
      requestCount: 1,
      refreshIdChanged: true,
      terminalStatus: "not_evaluated",
      terminalEvaluated: false,
      quickResultObserved: true,
      refreshId: "private-snapshot-refresh-id",
    },
    timer: { sampleCount: 5, uniqueCount: 5, advanced: true },
    controlPlane: {
      active: true,
      sampleCount: 3,
      healthSuccessCount: 3,
      refreshStatusSuccessCount: 3,
      maxLatencyMs: 17,
      p95LatencyMs: 17,
    },
    parity: {
      dashboard: { populated: true },
      usage: {
        pageVisible: true,
        periodCount: 4,
        summaryCardCount: 4,
        meaningfulTokenRows: 3,
        meaningfulCostRows: 2,
        meaningfulModelRows: 1,
        meaningfulModelMetricCells: 3,
        advancedModulesExplicit: true,
        advancedModulesAvailable: 2,
        advancedModulesUnavailable: 1,
        advancedModulesReady: true,
      },
      community: {
        pageVisible: true,
        serviceConfigured: false,
        serviceReachability: "not_configured",
        serviceReachabilityProven: false,
        currentLayout: true,
        providerControlsEnabled: false,
        indexTerminal: true,
        partialHistoryDetail: false,
        noServiceCopy: true,
        noServiceNoticeCount: 1,
      },
    },
    cancel: {
      acknowledgedMs: 40,
      terminalMs: 120,
      terminalStatus: "cancelled",
      http: { requestCount: 1, status: 202, latencyMs: 12, accepted: true },
    },
    retry: {
      newRefreshId: true,
      accepted: true,
      terminalStatus: "cancelled",
      cancelHttp: { requestCount: 1, status: 202, latencyMs: 9, accepted: true },
    },
  });

  assert.equal(receipt.schemaVersion, "tibotattle-electron-macos-real-history-v3");
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.mode, "snapshot");
  assert.equal(receipt.sourceRevision, "2".repeat(40));
  assert.equal(receipt.sourceRevisionBound, true);
  assert.equal(receipt.startupRefresh.requestCount, 1);
  assert.equal(receipt.startupRefresh.refreshIdChanged, true);
  assert.equal(receipt.startupRefresh.terminalStatus, "not_evaluated");
  assert.equal(receipt.startupRefresh.terminalEvaluated, false);
  assert.equal(receipt.startupRefresh.quickResultObserved, true);
  assert.equal(receipt.parity.community.noServiceCopy, true);
  assert.equal(receipt.parity.community.noServiceNoticeCount, 1);
  assert.equal(JSON.stringify(receipt).includes("private-snapshot-refresh-id"), false);
});

test("passed v3 receipts fail closed without exact source, artifact, or p95 proof", () => {
  const artifactIdentity = {
    artifactSha256: "d".repeat(64),
    artifactIdentityVerified: true,
  };
  const controlPlane = {
    active: true,
    sampleCount: 3,
    healthSuccessCount: 3,
    refreshStatusSuccessCount: 3,
    maxLatencyMs: 40,
    p95LatencyMs: 40,
  };
  const complete = buildRealHistoryReceipt({
    status: "passed",
    ...artifactIdentity,
    sourceRevision: "3".repeat(40),
    controlPlane,
    startup: { quickResultDurationMs: 2_000 },
  });
  assert.equal(complete.status, "passed");
  assert.equal(complete.sourceRevision, "3".repeat(40));
  assert.equal(complete.sourceRevisionBound, true);
  assert.deepEqual(complete.artifact, {
    sha256: "d".repeat(64),
    identityBound: true,
  });
  assert.equal(complete.controlPlane.p95LatencyMs, 40);
  assert.equal(complete.startupRefresh.quickResultDurationMs, 2_000);

  const missingRevision = buildRealHistoryReceipt({
    status: "passed",
    controlPlane,
  });
  assert.equal(missingRevision.status, "failed");
  assert.equal(missingRevision.sourceRevision, null);
  assert.equal(missingRevision.sourceRevisionBound, false);
  assert.equal(missingRevision.failureStage, "input");
  assert.equal(missingRevision.failureReason, "input_invalid");

  const missingArtifact = buildRealHistoryReceipt({
    status: "passed",
    sourceRevision: "3".repeat(40),
    controlPlane,
  });
  assert.equal(missingArtifact.status, "failed");
  assert.equal(missingArtifact.sourceRevisionBound, true);
  assert.deepEqual(missingArtifact.artifact, {
    sha256: null,
    identityBound: false,
  });
  assert.equal(missingArtifact.failureStage, "input");
  assert.equal(missingArtifact.failureReason, "artifact_invalid");

  const unverifiedArtifact = buildRealHistoryReceipt({
    status: "passed",
    artifactSha256: "d".repeat(64),
    artifactIdentityVerified: false,
    sourceRevision: "3".repeat(40),
    controlPlane,
  });
  assert.equal(unverifiedArtifact.status, "failed");
  assert.equal(unverifiedArtifact.failureStage, "input");
  assert.equal(unverifiedArtifact.failureReason, "artifact_invalid");

  const missingP95 = buildRealHistoryReceipt({
    status: "passed",
    ...artifactIdentity,
    sourceRevision: "3".repeat(40),
    controlPlane: { ...controlPlane, p95LatencyMs: undefined },
  });
  assert.equal(missingP95.status, "failed");
  assert.equal(missingP95.failureStage, "refresh");
  assert.equal(missingP95.failureReason, "control_plane_unresponsive");

  const overP95 = buildRealHistoryReceipt({
    status: "passed",
    ...artifactIdentity,
    sourceRevision: "3".repeat(40),
    controlPlane: { ...controlPlane, p95LatencyMs: 251, maxLatencyMs: 251 },
  });
  assert.equal(overP95.status, "failed");
  assert.equal(overP95.controlPlane.active, false);
  assert.equal(overP95.controlPlane.p95LatencyMs, 251);
  assert.equal(overP95.failureReason, "control_plane_unresponsive");

  const lateQuickResult = buildRealHistoryReceipt({
    status: "passed",
    ...artifactIdentity,
    sourceRevision: "3".repeat(40),
    controlPlane,
    startup: { quickResultObserved: true, quickResultDurationMs: 30_001 },
  });
  assert.equal(lateQuickResult.status, "failed");
  assert.equal(lateQuickResult.failureStage, "refresh");
  assert.equal(lateQuickResult.failureReason, "quick_result_timeout");
  assert.equal(lateQuickResult.startupRefresh.quickResultDurationMs, null);
  assert.equal(lateQuickResult.startupRefresh.quickResultObserved, false);
});

test("refresh timeout evidence remains an unevaluated failure", () => {
  const receipt = buildRealHistoryReceipt({
    status: "failed",
    sourceRevision: "4".repeat(40),
    failureStage: "refresh",
    failureReason: "refresh_timeout",
    startup: {
      requestCount: 1,
      refreshIdChanged: true,
      terminalStatus: "unknown",
      terminalEvaluated: false,
      timedOut: true,
    },
  });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.failureStage, "refresh");
  assert.equal(receipt.failureReason, "refresh_timeout");
  assert.equal(receipt.startupRefresh.terminalStatus, "unknown");
  assert.equal(receipt.startupRefresh.terminalEvaluated, false);
  assert.equal(receipt.startupRefresh.timedOut, true);
});

test("control-plane gate requires bounded health/status samples", () => {
  assert.equal(controlPlaneLatencyP95Ms([0, 10, 20, 30, 40, 50]), 50);
  assert.equal(controlPlaneLatencyP95Ms([0, 250, 250]), 250);
  assert.equal(controlPlaneLatencyP95Ms([]), null);
  assert.equal(controlPlaneLatencyP95Ms([0, -1]), null);
  assert.equal(controlPlaneLatencyP95Ms([0, 3_001]), null);
  assert.equal(controlPlaneSnapshotValid({
    active: true,
    sampleCount: 3,
    healthSuccessCount: 3,
    refreshStatusSuccessCount: 3,
    maxLatencyMs: 0,
    p95LatencyMs: 0,
  }), true);
  assert.equal(controlPlaneSnapshotValid({
    active: true,
    sampleCount: 3,
    healthSuccessCount: 3,
    refreshStatusSuccessCount: 3,
    maxLatencyMs: 251,
    p95LatencyMs: 251,
  }), false);
  assert.equal(controlPlaneSnapshotValid({
    active: true,
    sampleCount: 2,
    healthSuccessCount: 2,
    refreshStatusSuccessCount: 2,
    maxLatencyMs: 0,
  }), false);
  assert.equal(controlPlaneSnapshotValid({
    active: true,
    sampleCount: 3,
    healthSuccessCount: 3,
    refreshStatusSuccessCount: 3,
    maxLatencyMs: 3_001,
  }), false);
  assert.equal(controlPlaneSnapshotValid({
    active: true,
    sampleCount: 3,
    healthSuccessCount: 4,
    refreshStatusSuccessCount: 3,
    maxLatencyMs: 0,
  }), false);
  const untrusted = buildRealHistoryReceipt({
    status: "passed",
    controlPlane: {
      active: true,
      sampleCount: 1,
      healthSuccessCount: 1,
      refreshStatusSuccessCount: 1,
      maxLatencyMs: 99_999,
    },
    cancel: {
      http: { requestCount: 7, status: 500, latencyMs: -1, accepted: true },
    },
  });
  assert.deepEqual(untrusted.controlPlane, {
    active: false,
    sampleCount: 0,
    healthSuccessCount: 0,
    refreshStatusSuccessCount: 0,
    maxLatencyMs: 0,
    p95LatencyMs: 0,
  });
  assert.deepEqual(untrusted.cancel.http, {
    requestCount: 0,
    status: 0,
    latencyMs: 0,
    accepted: false,
  });
});

test("cancel mode accepts both quick-result and bounded deep-index progress", () => {
  const base = {
    status: "running",
    refreshId: "refresh-id",
    quickResultAt: "2026-08-27T12:00:00.000Z",
  };
  assert.equal(realHistoryCancelBoundaryReady({
    ...base,
    progress: { phase: "quick_result" },
  }), true);
  assert.equal(realHistoryCancelBoundaryReady({
    ...base,
    progress: {
      kind: "unified_index",
      status: "scanning",
      phase: "rollout_index",
      filesDiscovered: 12,
      filesSelected: 10,
      filesProcessed: 4,
      recordsWritten: 27,
    },
  }), true);
  for (const refresh of [
    { ...base, status: "succeeded", progress: { phase: "quick_result" } },
    { ...base, quickResultAt: "invalid", progress: { phase: "quick_result" } },
    { ...base, progress: { kind: "unified_index", status: "scanning", phase: "rollout_index",
      filesDiscovered: 2, filesSelected: 3, filesProcessed: 1, recordsWritten: 1 } },
    { ...base, progress: { kind: "unified_index", status: "scanning", phase: "rollout_index",
      filesDiscovered: 2, filesSelected: 2, filesProcessed: -1, recordsWritten: 1 } },
  ]) {
    assert.equal(realHistoryCancelBoundaryReady(refresh), false);
  }
});

test("timer and control-plane probes run concurrently and retain safe evidence on timer failure", async () => {
  const controlPlane = {
    active: true,
    sampleCount: 3,
    healthSuccessCount: 3,
    refreshStatusSuccessCount: 3,
    maxLatencyMs: 21,
    p95LatencyMs: 21,
  };
  const timerError = Object.assign(
    new Error("private timer detail"),
    {
      qaStage: "refresh",
      qaReason: "timer_stalled",
      qaEvidence: {
        timer: { sampleCount: 4, uniqueCount: 1, advanced: false },
      },
    },
  );
  let timerStarted = false;
  let controlPlaneStarted = false;
  await assert.rejects(
    () => sampleTimerAndControlPlaneConcurrently(
      async () => {
        timerStarted = true;
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 5));
        throw timerError;
      },
      async () => {
        controlPlaneStarted = true;
        await new Promise((resolveControlPlane) => setTimeout(resolveControlPlane, 1));
        return controlPlane;
      },
    ),
    (error) => {
      assert.equal(error, timerError);
      assert.equal(error.qaReason, "timer_stalled");
      assert.equal(timerStarted, true);
      assert.equal(controlPlaneStarted, true);
      assert.deepEqual(error.qaEvidence.timer, {
        sampleCount: 4,
        uniqueCount: 1,
        advanced: false,
      });
      assert.deepEqual(error.qaEvidence.controlPlane, controlPlane);
      assert.equal(JSON.stringify(error).includes("private timer detail"), false);
      return true;
    },
  );

  const receipt = buildRealHistoryReceipt({
    status: "failed",
    failureStage: "refresh",
    failureReason: "timer_stalled",
    timer: timerError.qaEvidence.timer,
    controlPlane: timerError.qaEvidence.controlPlane,
  });
  assert.equal(receipt.failureReason, "timer_stalled");
  assert.deepEqual(receipt.timer, timerError.qaEvidence.timer);
  assert.deepEqual(receipt.controlPlane, controlPlane);
  assert.equal(JSON.stringify(receipt).includes("private timer detail"), false);
});

test("control-plane observer retains only exact loopback route response metadata", () => {
  const handlers = new Map();
  const cdp = {
    on(method, handler) {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    },
  };
  const observer = createControlPlaneObserver(cdp, "http://127.0.0.1:4321");
  const emit = (method, event) => handlers.get(method)?.(event);
  emit("Network.requestWillBeSent", {
    requestId: "health-1",
    request: { method: "GET", url: "http://127.0.0.1:4321/api/local/health" },
  });
  emit("Network.responseReceived", {
    requestId: "health-1",
    response: { status: 200 },
  });
  emit("Network.requestWillBeSent", {
    requestId: "foreign-1",
    request: { method: "GET", url: "http://localhost:4321/api/local/health" },
  });
  emit("Network.responseReceived", {
    requestId: "foreign-1",
    response: { status: 200 },
  });
  emit("Network.requestWillBeSent", {
    requestId: "cancel-1",
    request: { method: "POST", url: "http://127.0.0.1:4321/api/local/refresh/cancel" },
  });
  emit("Network.responseReceived", {
    requestId: "cancel-1",
    response: { status: 202 },
  });
  assert.deepEqual(observer.snapshot().map(({ method, path, status }) => ({ method, path, status })), [
    { method: "GET", path: "/api/local/health", status: 200 },
    { method: "POST", path: "/api/local/refresh/cancel", status: 202 },
  ]);
  observer.reset();
  assert.deepEqual(observer.snapshot(), []);
  observer.dispose();
});

test("real-history network boundary rejects external traffic and local contribution mutations", () => {
  const handlers = new Map();
  const cdp = {
    on(method, handler) {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    },
  };
  const observe = (request) => handlers.get("Network.requestWillBeSent")?.({ request });
  let finish = createNetworkBoundaryObserver(cdp, "http://127.0.0.1:4321");
  observe({ method: "POST", url: "http://127.0.0.1:4321/api/local/refresh" });
  observe({ method: "POST", url: "http://127.0.0.1:4321/api/local/refresh/cancel" });
  observe({ method: "POST", url: "http://127.0.0.1:4321/api/local/contribution/sync-next" });
  assert.equal(finish(), null);

  finish = createNetworkBoundaryObserver(cdp, "http://127.0.0.1:4321");
  observe({ method: "GET", url: "http://127.0.0.1:4321/api/local/contribution/sync-status" });
  observe({ method: "POST", url: "http://127.0.0.1:4321/api/local/contribution/prepare" });
  assert.equal(finish(), "local_contribution_mutation");

  finish = createNetworkBoundaryObserver(cdp, "http://127.0.0.1:4321");
  observe({ method: "POST", url: "http://127.0.0.1:4321/api/local/identity/hosted-signin-handoff" });
  assert.equal(finish(), "local_identity_mutation");

  finish = createNetworkBoundaryObserver(cdp, "http://127.0.0.1:4321");
  observe({ method: "GET", url: "https://tibotattle.com/api/health" });
  assert.equal(finish(), "external_http");
});

test("cancel proof requires the renderer POST rather than a GET with the same status", () => {
  const accepted = {
    method: "POST",
    path: "/api/local/refresh/cancel",
    status: 202,
    latencyMs: 12,
  };
  assert.equal(cancelHttpResponseValid(accepted), true);
  assert.equal(cancelHttpResponseValid({ ...accepted, method: "GET" }), false);
  assert.equal(cancelHttpResponseValid({ ...accepted, path: "/api/local/refresh" }), false);
  assert.equal(cancelHttpResponseValid({ ...accepted, status: 200 }), false);
  assert.equal(cancelHttpResponseValid({ ...accepted, latencyMs: 3_001 }), false);
});

test("real-history process proof requires exact captured descendants and observes their disappearance", () => {
  assert.equal(capturedDescendantPidsValid([]), false);
  assert.equal(capturedDescendantPidsValid([123, 123]), false);
  assert.equal(capturedDescendantPidsValid([123, 456]), true);
  assert.equal(capturedDescendantPidsValid([123, 0]), false);
  assert.equal(capturedDescendantPidsGone([123, 456], () => false), true);
  assert.equal(capturedDescendantPidsGone([123, 456], (pid) => pid === 456), false);
  assert.equal(capturedDescendantPidsGone([], () => false), false);
});

test("real-history binds receipt identity to the exact app.asar bytes and rejects mismatches", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-real-history-artifact-"));
  const appPath = join(root, "TiboTattle Dev.app");
  const resources = join(appPath, "Contents", "Resources");
  const asar = join(resources, "app.asar");
  const bytes = Buffer.from("exact packaged app bytes\n", "utf8");
  const expected = createHash("sha256").update(bytes).digest("hex");
  try {
    await mkdir(resources, { recursive: true });
    await writeFile(asar, bytes);
    assert.equal(await verifyPackagedArtifactIdentity(appPath, expected), expected);
    await assert.rejects(
      () => verifyPackagedArtifactIdentity(appPath, "0".repeat(64)),
      (error) => {
        assert.equal(error.code, "REAL_HISTORY_QA_ARTIFACT_MISMATCH");
        assert.equal(error.qaReason, "artifact_invalid");
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real-history cancellation observer accepts one exact active-loader POST only", () => {
  const handlers = new Map();
  const cdp = {
    on(method, handler) {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    },
  };
  const observer = createRefreshObserver(cdp);
  const emit = (event) => handlers.get("Network.requestWillBeSent")?.(event);
  observer.select({
    expectedOrigin: "http://127.0.0.1:1234",
    expectedLoaderId: "active-loader",
  });
  emit({
    loaderId: "other-loader",
    request: { method: "POST", url: "http://127.0.0.1:1234/api/local/refresh" },
  });
  emit({
    loaderId: "active-loader",
    request: { method: "POST", url: "http://localhost:1234/api/local/refresh" },
  });
  emit({
    loaderId: "active-loader",
    request: { method: "GET", url: "http://127.0.0.1:1234/api/local/refresh" },
  });
  emit({
    loaderId: "active-loader",
    request: { method: "POST", url: "http://127.0.0.1:1234/api/local/refresh" },
  });
  assert.equal(observer.snapshot().length, 1);
  assert.equal(Number.isFinite(observer.snapshot()[0].startedAtMonotonicMs), true);
  observer.reset();
  assert.equal(observer.snapshot().length, 0);
  observer.seal();
  emit({
    loaderId: "active-loader",
    request: { method: "POST", url: "http://127.0.0.1:1234/api/local/refresh" },
  });
  assert.equal(observer.snapshot().length, 0);
  observer.dispose();
});

test("real-history parity helpers reject blank model metrics, hidden advanced modules, or disabled providers", () => {
  assert.deepEqual(classifyAdvancedModuleText("Loading cache continuity…"), {
    explicitContent: false,
    explicitUnavailable: false,
    placeholder: true,
    terminalEvidence: false,
  });
  assert.equal(classifyAdvancedModuleText("No cache priced observations").terminalEvidence, true);
  assert.equal(classifyAdvancedModuleText("No cache priced observations").explicitUnavailable, true);
  assert.equal(classifyAdvancedModuleText("Checking…").terminalEvidence, false);
  const usage = {
    route: "#accounting",
    pageVisible: true,
    periodCount: 4,
    summaryCardCount: 4,
    tokenCountRows: 1,
    costContributionRows: 1,
    modelIdentityRows: 1,
    meaningfulTokenRows: 1,
    meaningfulCostRows: 1,
    meaningfulModelRows: 1,
    meaningfulModelMetricCells: 2,
    priceCoverage: true,
    advancedModuleShellCount: 3,
    advancedModulesExplicit: true,
    advancedModulesReady: true,
  };
  assert.equal(usageParitySnapshotValid(usage), true);
  assert.equal(usageParitySnapshotValid({ ...usage, meaningfulModelMetricCells: 1 }), false);
  assert.equal(usageParitySnapshotValid({ ...usage, advancedModulesExplicit: false }), false);

  const health = {
    capabilities: {
      centralServiceProxy: true,
      contributionDevicePairing: true,
      incrementalContributionSync: "telemetry-contribution-v1.0",
    },
    serviceReachability: "ok",
    serviceReachabilityProven: true,
  };
  const community = {
    route: "#community",
    pageVisible: true,
    journeyStageCount: 2,
    indexTerminal: true,
    indexDetail: true,
    partialHistoryDetail: false,
    googleButton: true,
    appleButton: true,
    googleButtonEnabled: true,
    appleButtonEnabled: true,
    currentLayout: true,
    consentVisible: true,
    noServiceCopy: false,
  };
  assert.equal(communityParitySnapshotValid(community, health), true);
  assert.equal(communityParitySnapshotValid(community, {
    ...health,
    serviceReachabilityProven: false,
  }), false);
  assert.equal(communityParitySnapshotValid({ ...community, appleButtonEnabled: false }, health), false);
  assert.equal(communityParitySnapshotValid(community, {
    capabilities: { ...health.capabilities, incrementalContributionSync: false },
  }), false);

  const localHealth = {
    capabilities: {
      centralServiceProxy: false,
      contributionDevicePairing: false,
      incrementalContributionSync: false,
    },
    serviceReachability: "not_configured",
    serviceReachabilityProven: false,
  };
  const localCommunity = {
    ...community,
    googleButtonEnabled: false,
    appleButtonEnabled: false,
    consentVisible: false,
    noServiceCopy: true,
    noServiceNoticeCount: 1,
  };
  assert.equal(
    localQaCommunityParitySnapshotValid(localCommunity, localHealth),
    true,
  );
  assert.equal(
    localQaCommunityParitySnapshotValid({
      ...localCommunity,
      noServiceNoticeCount: 2,
    }, localHealth),
    false,
  );
  assert.equal(
    localQaCommunityParitySnapshotValid({
      ...localCommunity,
      googleButtonEnabled: true,
    }, localHealth),
    false,
  );
});

test("community service gate accepts only exact local or production states", () => {
  const productionHealth = {
    capabilities: {
      centralServiceProxy: true,
      contributionDevicePairing: true,
      incrementalContributionSync: "telemetry-contribution-v1.0",
    },
    serviceReachability: "ok",
    serviceReachabilityProven: true,
  };
  const localHealth = {
    capabilities: {
      centralServiceProxy: false,
      contributionDevicePairing: false,
      incrementalContributionSync: false,
    },
    serviceReachability: "not_configured",
    serviceReachabilityProven: false,
  };

  assert.equal(communityServiceConfigurationState(productionHealth), "configured");
  assert.equal(communityServiceConfigurationState(localHealth), "not_configured");

  const partialStates = [
    {
      ...productionHealth,
      capabilities: { ...productionHealth.capabilities, contributionDevicePairing: false },
    },
    {
      ...productionHealth,
      capabilities: { ...productionHealth.capabilities, incrementalContributionSync: false },
    },
    {
      ...localHealth,
      capabilities: { ...localHealth.capabilities, centralServiceProxy: true },
      serviceReachability: "ok",
      serviceReachabilityProven: true,
    },
    {
      ...localHealth,
      capabilities: { ...localHealth.capabilities, contributionDevicePairing: true },
    },
  ];
  for (const health of partialStates) {
    assert.equal(communityServiceConfigurationState(health), "invalid");
  }

  assert.equal(communityServiceConfigurationState({ capabilities: {} }), "invalid");
  assert.equal(communityServiceConfigurationState({
    ...productionHealth,
    serviceReachability: "unavailable",
    serviceReachabilityProven: false,
  }), "invalid");
  assert.equal(communityServiceConfigurationState({
    ...localHealth,
    serviceReachability: "ok",
    serviceReachabilityProven: true,
  }), "invalid");
});

test("source contract preserves the real profile and bounds every health poll", async () => {
  const source = await readFile(new URL("../scripts/qa-electron-macos-real-history.mjs", import.meta.url), "utf8");
  assert.match(source, /The profile is private and persistent/u);
  assert.match(source, /no teardown removes it/u);
  assert.match(source, /AbortController/u);
  assert.match(source, /X-Usage-Monitor-Local/u);
  assert.match(source, /fetchJson\(healthUrl, REAL_HISTORY_QA_TIMEOUTS\.healthMs\)/u);
  assert.match(source, /refreshIdChanged: true/u);
  assert.match(source, /refreshId,/u);
  assert.match(source, /profileIsolated: true/u);
  assert.match(source, /--artifact-sha256/u);
  assert.match(source, /--source-revision/u);
  assert.match(source, /SOURCE_REVISION/u);
  assert.match(source, /SOURCE_REVISION_PATTERN/u);
  assert.match(source, /verifyPackagedArtifactIdentity/u);
  assert.match(source, /createReadStream/u);
  assert.match(source, /artifactIdentityVerified: true/u);
  assert.match(source, /serviceReachabilityProven/u);
  assert.match(source, /centralServiceProxy === true/u);
  assert.match(source, /contributionDevicePairing === false/u);
  assert.match(source, /incrementalContributionSync === false/u);
  assert.match(source, /communityServiceConfigurationState\(health\)/u);
  assert.match(source, /new URL\("\/api\/health", session\.dashboardUrl\)/u);
  assert.match(source, /serviceHealth\?\.status === "ok"/u);
  assert.match(source, /REAL_HISTORY_QA_CONTROL_PLANE_MAX_LATENCY_MS/u);
  assert.match(source, /REAL_HISTORY_QA_CONTROL_PLANE_P95_MAX_LATENCY_MS/u);
  assert.match(source, /controlPlaneLatencyP95Ms/u);
  assert.match(source, /p95LatencyMs/u);
  assert.match(source, /REAL_HISTORY_QA_QUICK_RESULT_MAX_MS/u);
  assert.match(source, /quickResultDurationMs/u);
  assert.match(source, /refreshMs: 45 \* 60_000/u);
  assert.match(source, /refresh_timeout/u);
  assert.match(source, /timedOut/u);
  assert.match(source, /sampleTimerAndControlPlaneConcurrently/u);
  assert.match(source, /sampleControlPlaneStatus\(session/u);
  assert.doesNotMatch(source, /sampleControlPlane\s*\?\s*sampleControlPlane\(/u);
  assert.match(source, /let completionError = null/u);
  assert.match(source, /attachQaEvidence\(completionError, \{/u);
  assert.match(source, /timer: timerResult \?\? samplerEvidence/u);
  assert.match(source, /Promise\.allSettled\(\[/u);
  assert.match(source, /timer: evidence\.timer/u);
  assert.match(source, /controlPlane: evidence\.controlPlane/u);
  assert.match(source, /cancel: evidence\.cancel/u);
  assert.match(source, /retry: evidence\.retry/u);
  assert.match(source, /options\?\.receiptPath/u);
  assert.match(source, /waitForLaunchGate/u);
  assert.match(source, /runLaunchGate/u);
  assert.match(source, /releaseRealHistoryRefreshGate/u);
  assert.match(source, /__TIBOTATTLE_ELECTRON_MACOS_SMOKE__/u);
  assert.match(source, /Object\.keys\(bridge\)\.length !== 3/u);
  assert.match(source, /bridge\.releaseStartupRefresh\(\) === true/u);
  assert.match(source, /Network\.responseReceived/u);
  assert.match(source, /sampleControlPlane/u);
  assert.match(source, /sampleControlPlane: true/u);
  assert.match(source, /controlPlane = startup.controlPlane/u);
  assert.match(source, /remainingRefreshBudgetMs()/u);
  assert.match(source, /REAL_HISTORY_QA_REFRESH_TIMEOUT/u);
  assert.match(source, /cancelHttp/u);
  assert.match(source, /refresh\.quickResultAt/u);
  assert.match(source, /realHistoryCancelBoundaryReady\(status\?\.refresh\)/u);
  assert.match(source, /refresh\.progress\?\.phase === "quick_result"/u);
  assert.match(source, /snapshot seeded snapshot -> Usage\/Community parity/u);
  assert.match(source, /deferStartupRefresh: options\.mode === "snapshot"/u);
  assert.match(source, /terminalStatus: "not_evaluated"/u);
  assert.match(source, /session\.releaseStartupRefresh\(\)/u);
  assert.match(source, /(?:loading|preparing|checking)/u);
  assert.match(source, /capturedDescendantPidsGone/u);
  assert.match(source, /session\.expectedDescendantPids = descendantsOf\(child\.pid\)/u);
  assert.match(source, /capturedDescendantCount: expectedDescendantPids\.length/u);
  assert.match(source, /session\.observer\.snapshot\(\)\.length !== 1/u);
  const pageEnable = source.indexOf('await cdp.request("Page.enable")');
  const networkEnable = source.indexOf('await cdp.request("Network.enable")');
  const binding = source.indexOf("const binding = await waitForLaunchGate");
  const observerSelect = source.indexOf("observer.select({ expectedOrigin: binding.origin");
  const release = source.indexOf("await releaseRealHistoryRefreshGate(cdp)");
  const readiness = source.indexOf("const ready = await waitForLaunchGate");
  assert.ok(pageEnable >= 0
    && networkEnable > pageEnable
    && binding > networkEnable
    && observerSelect > binding
    && release > observerSelect
    && readiness > release);
});
