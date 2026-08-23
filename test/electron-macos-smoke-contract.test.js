import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertMacAppContract,
  buildClosedReceipt,
  classifyAutomaticStartupRefreshReceipt,
  ELECTRON_MACOS_SMOKE_FAILURE_REASONS,
  ELECTRON_MACOS_SMOKE_STARTUP_REFRESH_ERROR_CODES,
  observeLocalRefreshRequests,
} from "../scripts/smoke-electron-macos.mjs";

class FakeCdp {
  constructor() {
    this.listeners = new Map();
  }

  on(eventName, listener) {
    const listeners = this.listeners.get(eventName) ?? new Set();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
    return () => listeners.delete(listener);
  }

  emit(eventName, payload) {
    for (const listener of this.listeners.get(eventName) ?? []) listener(payload);
  }
}

function emitRefresh(cdp, { origin, requestId, loaderId }) {
  cdp.emit("Network.requestWillBeSent", {
    request: {
      method: "POST",
      url: `${origin}/api/local/refresh`,
    },
    requestId,
    loaderId,
  });
}

test("macOS Electron smoke is an explicit packaged arm64 lane", async () => {
  const source = await readFile("scripts/smoke-electron-macos.mjs", "utf8");
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.scripts["smoke:electron:macos"], "node ./scripts/smoke-electron-macos.mjs");
  assert.match(source, /TIBOTATTLE_ELECTRON_APP/u);
  assert.match(source, /TiboTattle Dev\.app/u);
  assert.match(source, /darwin-arm64-electron-app/u);
  assert.match(source, /USAGE_MONITOR_STATE_ROOT/u);
  assert.match(source, /CODEX_HOME/u);
  assert.match(source, /desktop-first-run-v1\.json/u);
  assert.match(source, /Page\.enable/u);
  assert.match(source, /Network\.enable/u);
  assert.match(source, /Page\.getFrameTree/u);
  assert.match(source, /localDashboardReady/u);
  assert.match(source, /assertDashboardData/u);
  assert.match(source, /failureReason/u);
  assert.match(source, /dashboard_data_unavailable/u);
  assert.match(source, /runSmoke\(appPath, progress\)/u);
  assert.match(source, /recordSmokeProgress/u);
  assert.match(source, /dashboard_renderer_unavailable/u);
  assert.match(source, /refreshObserver\.selectOrigin/u);
  assert.match(source, /refreshObserver\.selectLoader/u);
  assert.match(source, /refreshObserver\.seal/u);
  assert.match(source, /#weekly/u);
  assert.match(source, /#share-panel/u);
  assert.match(source, /electron-settings/u);
  assert.match(source, /SIGUSR2/u);
  assert.match(source, /contentFree: true/u);
  assert.match(source, /qualification: "development-only"/u);
  assert.ok(ELECTRON_MACOS_SMOKE_FAILURE_REASONS.includes("dashboard_data_unavailable"));
  const chrome = source.indexOf("dashboardReceipt = await assertDashboardShell(cdp)");
  const refresh = source.indexOf("startupReceipt = await assertAutomaticStartupRefresh");
  const data = source.indexOf("...(await assertDashboardData(cdp))");
  assert.ok(chrome >= 0 && refresh > chrome && data > refresh);
});

test("macOS app contract rejects the wrong host, architecture, and bundle shape", () => {
  const valid = assertMacAppContract({
    platform: "darwin",
    architecture: "arm64",
    appPath: "/tmp/TiboTattle Dev.app",
    bundleExists: true,
    executableExists: true,
    asarExists: true,
    executableArchitecture: "arm64",
  });
  assert.deepEqual(valid, {
    platform: "darwin",
    architecture: "arm64",
    appName: "TiboTattle Dev",
    target: "darwin-arm64",
  });
  for (const options of [
    { platform: "linux", architecture: "arm64" },
    { platform: "darwin", architecture: "x64" },
    { platform: "darwin", architecture: "arm64", appPath: "/tmp/TiboTattle.app" },
    { platform: "darwin", architecture: "arm64", appPath: "/tmp/TiboTattle Dev.app", asarExists: false },
    { platform: "darwin", architecture: "arm64", appPath: "/tmp/TiboTattle Dev.app", executableArchitecture: "x64" },
  ]) {
    assert.throws(() => assertMacAppContract(options), TypeError);
  }
});

test("macOS startup refresh evidence is bound to the validated origin and loader", () => {
  const cdp = new FakeCdp();
  const observer = observeLocalRefreshRequests(cdp);
  const dashboardOrigin = "http://127.0.0.1:43123";
  const otherLoopbackOrigin = "http://127.0.0.1:43124";

  observer.selectLoader("loader-current");
  emitRefresh(cdp, {
    origin: dashboardOrigin,
    requestId: "current-valid",
    loaderId: "loader-current",
  });
  emitRefresh(cdp, {
    origin: otherLoopbackOrigin,
    requestId: "current-wrong-origin",
    loaderId: "loader-current",
  });
  assert.deepEqual(observer.snapshot(), []);

  assert.equal(observer.selectOrigin(dashboardOrigin), dashboardOrigin);
  assert.deepEqual(observer.snapshot(), [{
    requestId: "current-valid",
    loaderId: "loader-current",
    origin: dashboardOrigin,
  }]);
  emitRefresh(cdp, {
    origin: dashboardOrigin,
    requestId: "different-loader",
    loaderId: "loader-old",
  });
  assert.equal(observer.snapshot().length, 1);

  observer.reset();
  observer.selectOrigin(dashboardOrigin);
  observer.selectLoader("loader-fresh");
  emitRefresh(cdp, {
    origin: dashboardOrigin,
    requestId: "fresh-valid",
    loaderId: "loader-fresh",
  });
  assert.equal(observer.snapshot().length, 1);
  observer.seal();
  emitRefresh(cdp, {
    origin: dashboardOrigin,
    requestId: "sealed-request",
    loaderId: "loader-fresh",
  });
  assert.equal(observer.snapshot().length, 1);
  observer.dispose();
});

test("macOS startup receipt requires one new request and terminal success", () => {
  const codes = ELECTRON_MACOS_SMOKE_STARTUP_REFRESH_ERROR_CODES;
  assert.deepEqual(
    classifyAutomaticStartupRefreshReceipt({
      phase: "acceptance",
      requestCount: 1,
      refresh: { status: "succeeded", refreshId: "new-refresh" },
      previousRefreshId: "old-refresh",
    }),
    { status: "accepted", refreshId: "new-refresh" },
  );
  assert.deepEqual(
    classifyAutomaticStartupRefreshReceipt({
      phase: "completion",
      requestCount: 1,
      refresh: { status: "succeeded", refreshId: "new-refresh" },
      expectedRefreshId: "new-refresh",
    }),
    { status: "completed", refreshId: "new-refresh" },
  );
  assert.deepEqual(
    classifyAutomaticStartupRefreshReceipt({
      phase: "acceptance",
      requestCount: 1,
      refresh: { status: "succeeded", refreshId: "old-refresh" },
      previousRefreshId: "old-refresh",
    }),
    { status: "pending" },
  );
  assert.deepEqual(
    classifyAutomaticStartupRefreshReceipt({
      phase: "acceptance",
      requestCount: 2,
      refresh: { status: "running", refreshId: "new-refresh" },
    }),
    { status: "failed", errorCode: codes.duplicate },
  );
  assert.deepEqual(
    classifyAutomaticStartupRefreshReceipt({
      phase: "completion",
      requestCount: 1,
      refresh: { status: "succeeded", refreshId: "other-refresh" },
      expectedRefreshId: "new-refresh",
    }),
    { status: "failed", errorCode: codes.changedReceipt },
  );
});

test("closed macOS receipt is content-free and has no runtime identifiers", () => {
  const receipt = buildClosedReceipt({
    status: "passed",
    cleanQuit: true,
    startupRefresh: {
      requestCount: 1,
      originBound: true,
      activeLoaderBound: true,
      refreshIdChanged: true,
      terminalStatus: "succeeded",
    },
    dashboard: { chrome: true, dataFlow: true, navCount: 5 },
    settings: { connected: true, tabCount: 3, tabs: true },
    share: {
      route: "#weekly",
      panelVisible: true,
      panelFocused: true,
      canvas: true,
    },
  });
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.cleanQuit, true);
  assert.equal(receipt.contentFree, true);
  assert.equal(receipt.failureReason, null);
  assert.equal(receipt.startupRefresh.requestCount, 1);
  assert.equal(receipt.startupRefresh.terminalStatus, "succeeded");
  assert.equal(receipt.dashboard.dataFlow, true);
  assert.equal(receipt.settings.connected, true);
  assert.equal(receipt.share.route, "#weekly");
  assert.equal(Object.hasOwn(receipt, "refreshId"), false);
  assert.equal(Object.hasOwn(receipt, "dashboardOrigin"), false);
  assert.equal(Object.hasOwn(receipt, "fixtureRoot"), false);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.startupRefresh), true);
});

test("failed macOS receipt keeps an allowlisted fixed reason", () => {
  const receipt = buildClosedReceipt({
    status: "failed",
    failureStage: "dashboard",
    failureReason: "dashboard_data_unavailable",
  });
  assert.equal(receipt.failureStage, "dashboard");
  assert.equal(receipt.failureReason, "dashboard_data_unavailable");
  assert.equal(
    buildClosedReceipt({
      status: "failed",
      failureStage: "dashboard",
      failureReason: "/private/path or raw renderer text",
    }).failureReason,
    "runtime_failed",
  );
  assert.equal(Object.hasOwn(receipt, "error"), false);
});

test("failed renderer readiness receipt retains completed chrome and refresh progress", () => {
  const receipt = buildClosedReceipt({
    status: "failed",
    failureStage: "dashboard",
    failureReason: "dashboard_renderer_unavailable",
    dashboard: { chrome: true, dataFlow: false, navCount: 5 },
    startupRefresh: {
      requestCount: 1,
      originBound: true,
      activeLoaderBound: true,
      refreshIdChanged: true,
      terminalStatus: "succeeded",
    },
  });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.failureReason, "dashboard_renderer_unavailable");
  assert.equal(receipt.dashboard.chrome, true);
  assert.equal(receipt.dashboard.navCount, 5);
  assert.equal(receipt.dashboard.dataFlow, false);
  assert.equal(receipt.startupRefresh.requestCount, 1);
  assert.equal(receipt.startupRefresh.terminalStatus, "succeeded");
  assert.equal(receipt.settings.connected, false);
  assert.equal(receipt.share.panelVisible, false);
});
