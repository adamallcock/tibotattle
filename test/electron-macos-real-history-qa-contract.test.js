import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  REAL_HISTORY_QA_MODES,
  REAL_HISTORY_QA_TIMEOUTS,
  buildRealHistoryReceipt,
  cancelHttpResponseValid,
  capturedDescendantPidsGone,
  capturedDescendantPidsValid,
  classifyAdvancedModuleText,
  classifyRealHistoryTerminal,
  communityParitySnapshotValid,
  controlPlaneSnapshotValid,
  createControlPlaneObserver,
  createNetworkBoundaryObserver,
  createRefreshObserver,
  localQaCommunityParitySnapshotValid,
  parseRealHistoryArguments,
  realHistoryDashboardReadySnapshotValid,
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
  assert.deepEqual(REAL_HISTORY_QA_MODES, ["cancel", "full", "relaunch"]);
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
    startup: {
      requestCount: 1,
      refreshIdChanged: true,
      terminalStatus: "degraded",
      degradedFailureCode: "codex_rollout_generation_ambiguous",
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
  assert.deepEqual(receipt.controlPlane, {
    active: true,
    sampleCount: 3,
    healthSuccessCount: 3,
    refreshStatusSuccessCount: 3,
    maxLatencyMs: 21,
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

test("control-plane gate requires bounded health/status samples", () => {
  assert.equal(controlPlaneSnapshotValid({
    active: true,
    sampleCount: 3,
    healthSuccessCount: 3,
    refreshStatusSuccessCount: 3,
    maxLatencyMs: 0,
  }), true);
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
  });
  assert.deepEqual(untrusted.cancel.http, {
    requestCount: 0,
    status: 0,
    latencyMs: 0,
    accepted: false,
  });
});

test("timer and control-plane probes run concurrently and retain safe evidence on timer failure", async () => {
  const controlPlane = {
    active: true,
    sampleCount: 3,
    healthSuccessCount: 3,
    refreshStatusSuccessCount: 3,
    maxLatencyMs: 21,
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
      contributionDevicePairing: true,
      incrementalContributionSync: "telemetry-contribution-v1.0",
    },
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
  assert.match(source, /verifyPackagedArtifactIdentity/u);
  assert.match(source, /createReadStream/u);
  assert.match(source, /artifactIdentityVerified: true/u);
  assert.match(source, /serviceReachabilityProven/u);
  assert.match(source, /centralServiceProxy === true/u);
  assert.match(source, /new URL\("\/api\/health", session\.dashboardUrl\)/u);
  assert.match(source, /serviceHealth\?\.status === "ok"/u);
  assert.match(source, /REAL_HISTORY_QA_CONTROL_PLANE_MAX_LATENCY_MS/u);
  assert.match(source, /sampleTimerAndControlPlaneConcurrently/u);
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
  assert.match(source, /cancelHttp/u);
  assert.match(source, /status\.refresh\.quickResultAt/u);
  assert.match(source, /status\.refresh\.progress\?\.phase === "quick_result"/u);
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
