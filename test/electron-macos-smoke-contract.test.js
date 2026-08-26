import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertMacAppContract,
  buildClosedReceipt,
  classifyMacDashboardParityEvidence,
  classifyAutomaticStartupRefreshReceipt,
  ELECTRON_MACOS_SMOKE_FAILURE_REASONS,
  ELECTRON_MACOS_SMOKE_DEGRADED_FAILURE_CODES,
  ELECTRON_MACOS_SMOKE_STARTUP_REFRESH_ERROR_CODES,
  hasMeaningfulMacCostEvidence,
  isMacDashboardTarget,
  isMacSettingsTarget,
  observeLocalRefreshRequests,
  selectMacDashboardTarget,
  selectMacSettingsTarget,
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
  assert.match(source, /USAGE_MONITOR_ELECTRON_SMOKE_CONTROL/u);
  assert.match(source, /Page\.enable/u);
  assert.match(source, /Network\.enable/u);
  assert.doesNotMatch(source, /Page\.reload/u);
  assert.match(source, /Page\.getFrameTree/u);
  assert.match(source, /localDashboardReady/u);
  assert.match(source, /assertDashboardData/u);
  assert.match(source, /assertDashboardParitySurfaces/u);
  assert.match(source, /#accounting-component-counts/u);
  assert.match(source, /#accounting-component-costs/u);
  assert.match(source, /#accounting-models/u);
  assert.match(source, /#cache-reuse-outcome/u);
  assert.match(source, /#identity-google-signin/u);
  assert.match(source, /#identity-apple-signin/u);
  assert.match(source, /no contribution service/u);
  assert.match(source, /failureReason/u);
  assert.match(source, /dashboard_data_unavailable/u);
  assert.match(source, /runSmoke\(appPath, progress\)/u);
  assert.match(source, /recordSmokeProgress/u);
  assert.match(source, /dashboard_renderer_unavailable/u);
  assert.match(source, /refreshObserver\.selectOrigin/u);
  assert.match(source, /refreshObserver\.selectLoader/u);
  assert.match(source, /refreshObserver\.seal/u);
  assert.match(source, /selectMacDashboardTarget/u);
  assert.match(source, /isMacSettingsTarget/u);
  assert.match(source, /selectMacSettingsTarget/u);
  assert.match(source, /__TIBOTATTLE_ELECTRON_MACOS_SMOKE__/u);
  assert.match(source, /bindMacSmokeRefreshObserver/u);
  assert.match(source, /releaseMacSmokeRefreshGate/u);
  assert.match(source, /releaseStartupRefresh/u);
  assert.match(source, /terminalStatus: "degraded"/u);
  assert.match(source, /degradedFailureCode/u);
  assert.match(source, /codex_rollout_sources_quarantined/u);
  assert.match(source, /meaningfulTokenRows/u);
  assert.match(source, /advancedModulesReady/u);
  assert.match(source, /partialHistoryDetail/u);
  assert.match(source, /#weekly/u);
  assert.match(source, /#share-panel/u);
  assert.match(source, /electron-settings/u);
  assert.match(source, /SIGUSR2/u);
  assert.match(source, /contentFree: true/u);
  assert.match(source, /qualification: "development-only"/u);
  assert.ok(ELECTRON_MACOS_SMOKE_FAILURE_REASONS.includes("dashboard_data_unavailable"));
  assert.ok(ELECTRON_MACOS_SMOKE_FAILURE_REASONS.includes("usage_parity_invalid"));
  assert.ok(ELECTRON_MACOS_SMOKE_FAILURE_REASONS.includes("community_parity_invalid"));
  const chrome = source.indexOf("dashboardReceipt = await assertDashboardShell(cdp)");
  const refresh = source.indexOf("startupReceipt = await assertAutomaticStartupRefresh");
  const data = source.indexOf("...(await assertDashboardData(cdp))");
  const parity = source.indexOf("parityReceipt = await assertDashboardParitySurfaces");
  const share = source.indexOf("shareReceipt = await assertShareFlow(cdp)");
  assert.ok(chrome >= 0 && refresh > chrome && data > refresh && parity > data && share > parity);
  const networkEnable = source.indexOf('await cdp.request("Network.enable")');
  const binding = source.indexOf("const refreshBinding = await bindMacSmokeRefreshObserver");
  const release = source.indexOf("await releaseMacSmokeRefreshGate(cdp)");
  assert.ok(networkEnable >= 0 && binding > networkEnable && release > binding && refresh > release);
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

test("macOS smoke selects only the exact ephemeral loopback dashboard target", () => {
  const debugPort = 43123;
  const dashboardPort = 49299;
  const target = (url, overrides = {}) => ({
    type: "page",
    url,
    webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort}/devtools/page/1`,
    ...overrides,
  });
  const valid = target(`http://127.0.0.1:${dashboardPort}/`);
  assert.equal(isMacDashboardTarget(valid, debugPort), true);
  assert.equal(
    selectMacDashboardTarget([
      target(`data:text/html,<h1>loading</h1>`),
      target("file:///tmp/recovery.html"),
      target(`https://127.0.0.1:${dashboardPort}/`),
      target(`http://localhost:${dashboardPort}/`),
      target(`http://127.0.0.1:${dashboardPort}/electron-settings.html`),
      target(`http://127.0.0.1:${dashboardPort}/#weekly`),
      target(`http://127.0.0.1:${dashboardPort}/?ready=1`),
      target(`http://user:pass@127.0.0.1:${dashboardPort}/`),
      target(`http://127.0.0.2:${dashboardPort}/`),
      { ...valid, type: "other" },
      {
        ...valid,
        webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort + 1}/devtools/page/2`,
      },
      valid,
    ],
    debugPort,
  ), valid);
  for (const rejected of [
    target(`data:text/html,<h1>loading</h1>`),
    target("file:///tmp/recovery.html"),
    target(`https://127.0.0.1:${dashboardPort}/`),
    target(`http://localhost:${dashboardPort}/`),
    target(`http://127.0.0.1:${dashboardPort}/electron-settings.html`),
    target(`http://127.0.0.1:${dashboardPort}/#weekly`),
    target(`http://127.0.0.1:${dashboardPort}/?ready=1`),
    target(`http://user:pass@127.0.0.1:${dashboardPort}/`),
    target("http://127.0.0.1/"),
    target(`http://127.0.0.2:${dashboardPort}/`),
    { ...valid, type: "other" },
    { ...valid, webSocketDebuggerUrl: "" },
    {
      ...valid,
      webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort + 1}/devtools/page/2`,
    },
  ]) {
    assert.equal(isMacDashboardTarget(rejected, debugPort), false);
  }
});

test("macOS smoke selects Settings only for the exact dashboard origin and CDP port", () => {
  const debugPort = 43123;
  const dashboardPort = 49299;
  const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;
  const target = (url, overrides = {}) => ({
    type: "page",
    url,
    webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort}/devtools/page/settings`,
    ...overrides,
  });
  const valid = target(`${dashboardOrigin}/electron-settings.html#general`);
  assert.equal(isMacSettingsTarget(valid, dashboardOrigin, debugPort), true);
  assert.equal(
    selectMacSettingsTarget([
      target(`http://127.0.0.1:${dashboardPort + 1}/electron-settings.html`),
      target(`http://localhost:${dashboardPort}/electron-settings.html`),
      target(`https://127.0.0.1:${dashboardPort}/electron-settings.html`),
      target(`${dashboardOrigin}/electron-settings.html?section=general`),
      target(`http://user:pass@127.0.0.1:${dashboardPort}/electron-settings.html`),
      target(`${dashboardOrigin}/electron-settings.html`, {
        webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort + 1}/devtools/page/wrong-port`,
      }),
      target(`${dashboardOrigin}/electron-settings.html`, {
        webSocketDebuggerUrl: `ws://localhost:${debugPort}/devtools/page/wrong-host`,
      }),
      target(`${dashboardOrigin}/electron-settings.html`, {
        webSocketDebuggerUrl: `wss://127.0.0.1:${debugPort}/devtools/page/wrong-protocol`,
      }),
      target(`${dashboardOrigin}/electron-settings.html`, {
        webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort}/json/version`,
      }),
      { ...valid, type: "other" },
      valid,
    ],
    dashboardOrigin,
    debugPort,
  ), valid);
  for (const rejected of [
    target(`http://127.0.0.1:${dashboardPort + 1}/electron-settings.html`),
    target(`http://localhost:${dashboardPort}/electron-settings.html`),
    target(`https://127.0.0.1:${dashboardPort}/electron-settings.html`),
    target(`${dashboardOrigin}/electron-settings.html?section=general`),
    target(`http://user:pass@127.0.0.1:${dashboardPort}/electron-settings.html`),
    target(`${dashboardOrigin}/electron-settings.html`, {
      webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort + 1}/devtools/page/wrong-port`,
    }),
    target(`${dashboardOrigin}/electron-settings.html`, {
      webSocketDebuggerUrl: `ws://localhost:${debugPort}/devtools/page/wrong-host`,
    }),
    target(`${dashboardOrigin}/electron-settings.html`, {
      webSocketDebuggerUrl: `wss://127.0.0.1:${debugPort}/devtools/page/wrong-protocol`,
    }),
    target(`${dashboardOrigin}/electron-settings.html`, {
      webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort}/json/version`,
    }),
    { ...valid, type: "other" },
    { ...valid, webSocketDebuggerUrl: "" },
  ]) {
    assert.equal(isMacSettingsTarget(rejected, dashboardOrigin, debugPort), false);
  }
  assert.equal(
    isMacSettingsTarget(valid, `http://127.0.0.1:${dashboardPort + 1}`, debugPort),
    false,
  );
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
    {
      status: "completed",
      refreshId: "new-refresh",
      terminalStatus: "succeeded",
    },
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

test("macOS startup receipt accepts only coherent partial quarantine as degraded", () => {
  const codes = ELECTRON_MACOS_SMOKE_STARTUP_REFRESH_ERROR_CODES;
  const refresh = {
    status: "degraded",
    refreshId: "partial-refresh",
    errorCode: "refresh_degraded",
    failedStep: "unified_index",
    failureCode: "codex_rollout_generation_ambiguous",
    result: {
      unifiedIndex: {
        status: "ingested",
        generation: {
          status: "partial",
          blockReason: "codex_rollout_sources_quarantined",
          skippedSourceCount: 2,
          skippedThreadCount: 1,
          reasonCounts: {
            codex_rollout_generation_ambiguous: 1,
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
  };
  assert.deepEqual(
    classifyAutomaticStartupRefreshReceipt({
      phase: "completion",
      requestCount: 1,
      refresh,
      expectedRefreshId: "partial-refresh",
    }),
    {
      status: "completed",
      refreshId: "partial-refresh",
      terminalStatus: "degraded",
      degradedFailureCode: "codex_rollout_generation_ambiguous",
    },
  );
  for (const failureCode of ELECTRON_MACOS_SMOKE_DEGRADED_FAILURE_CODES) {
    const candidate = structuredClone(refresh);
    candidate.failureCode = failureCode;
    candidate.result.unifiedIndex.generation.reasonCounts = { [failureCode]: 1 };
    assert.equal(classifyAutomaticStartupRefreshReceipt({
      phase: "completion",
      requestCount: 1,
      refresh: candidate,
      expectedRefreshId: "partial-refresh",
    }).status, "completed", failureCode);
  }
  assert.deepEqual(
    classifyAutomaticStartupRefreshReceipt({
      phase: "completion",
      requestCount: 1,
      refresh: {
        ...refresh,
        result: {
          ...refresh.result,
          accounting: {
            ...refresh.result.accounting,
            generationMatched: false,
          },
        },
      },
      expectedRefreshId: "partial-refresh",
    }),
    { status: "failed", errorCode: codes.degradedInvalid },
  );
  assert.deepEqual(
    classifyAutomaticStartupRefreshReceipt({
      phase: "completion",
      requestCount: 1,
      refresh: { ...refresh, failureCode: "codex_rollout_content_invalid" },
      expectedRefreshId: "partial-refresh",
    }),
    { status: "failed", errorCode: codes.degradedInvalid },
  );
  assert.deepEqual(
    classifyAutomaticStartupRefreshReceipt({
      phase: "completion",
      requestCount: 1,
      refresh: { ...refresh, failureCode: "private_failure" },
      expectedRefreshId: "partial-refresh",
    }),
    { status: "failed", errorCode: codes.degradedInvalid },
  );
});

test("macOS parity evidence rejects empty Usage rows and hidden legacy Community layout", () => {
  const health = {
    capabilities: {
      contributionDevicePairing: true,
      incrementalContributionSync: "telemetry-contribution-v1.0",
    },
  };
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
    priceCoverage: true,
    advancedModuleShellCount: 3,
    advancedModuleAvailableCount: 1,
    advancedModuleUnavailableCount: 2,
    advancedModulesReady: true,
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
    currentLayout: true,
    noServiceCopy: false,
  };
  assert.deepEqual(
    classifyMacDashboardParityEvidence({ health, usage, community }),
    { status: "passed", reason: null },
  );
  assert.deepEqual(
    classifyMacDashboardParityEvidence({
      health,
      usage: { ...usage, tokenCountRows: 0, modelIdentityRows: 0 },
      community,
    }),
    { status: "failed", reason: "usage" },
  );
  assert.deepEqual(
    classifyMacDashboardParityEvidence({
      health,
      usage: { ...usage, meaningfulCostRows: 0, priceCoverage: false },
      community,
    }),
    { status: "failed", reason: "usage" },
  );
  assert.deepEqual(
    classifyMacDashboardParityEvidence({
      health,
      usage: { ...usage, advancedModulesReady: false },
      community,
    }),
    { status: "failed", reason: "usage" },
  );
  assert.deepEqual(
    classifyMacDashboardParityEvidence({
      health,
      usage,
      community: { ...community, currentLayout: false },
    }),
    { status: "failed", reason: "community" },
  );
  assert.deepEqual(
    classifyMacDashboardParityEvidence({
      health: {
        capabilities: {
          contributionDevicePairing: true,
          incrementalContributionSync: false,
        },
      },
      usage,
      community,
    }),
    { status: "failed", reason: "community" },
  );
  assert.deepEqual(
    classifyMacDashboardParityEvidence({
      health,
      usage,
      community: { ...community, partialHistoryDetail: false },
      startupRefresh: { terminalStatus: "degraded" },
    }),
    { status: "failed", reason: "community" },
  );
  assert.deepEqual(
    classifyMacDashboardParityEvidence({
      health,
      usage,
      community: { ...community, partialHistoryDetail: true },
      startupRefresh: { terminalStatus: "degraded" },
    }),
    { status: "passed", reason: null },
  );
});

test("macOS cost-row evidence rejects placeholders and accepts priced or explained rows", () => {
  for (const placeholder of [
    "Cached input —",
    "Cached input $0.00",
    "Cached input 0.00",
    "Cached input",
  ]) {
    assert.equal(hasMeaningfulMacCostEvidence(placeholder), false, placeholder);
  }
  for (const evidence of [
    "Cached input $0.01",
    "Cached input < $0.01",
    "Cached input not priced",
    "Cached input: price unavailable",
    "Cached input: no published price",
    "Cached input: cost withheld",
  ]) {
    assert.equal(hasMeaningfulMacCostEvidence(evidence), true, evidence);
  }
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
    parity: {
      usage: {
        pageVisible: true,
        periodCount: 4,
        summaryCardCount: 4,
        tokenCountRows: 3,
        costContributionRows: 2,
        modelIdentityRows: 1,
        meaningfulTokenRows: 3,
        meaningfulCostRows: 2,
        meaningfulModelRows: 1,
        priceCoverage: true,
        advancedModuleShells: true,
        advancedModulesAvailable: 1,
        advancedModulesUnavailable: 2,
        advancedModulesReady: true,
      },
      community: {
        pageVisible: true,
        serviceConfigured: true,
        journeyStageCount: 2,
        currentLayout: true,
        providerControls: true,
        indexTerminal: true,
        partialHistoryDetail: false,
      },
    },
    settings: { connected: true, tabCount: 3, tabs: true },
    share: {
      route: "#weekly",
      panelVisible: true,
      panelFocused: true,
      canvas: true,
    },
  });
  assert.equal(receipt.schemaVersion, "tibotattle-electron-macos-smoke-v2");
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.cleanQuit, true);
  assert.equal(receipt.contentFree, true);
  assert.equal(receipt.failureReason, null);
  assert.equal(receipt.startupRefresh.requestCount, 1);
  assert.equal(receipt.startupRefresh.terminalStatus, "succeeded");
  assert.equal(receipt.startupRefresh.degradedFailureCode, null);
  assert.equal(receipt.dashboard.dataFlow, true);
  assert.equal(receipt.parity.usage.summaryCardCount, 4);
  assert.equal(receipt.parity.usage.advancedModuleShells, true);
  assert.equal(receipt.parity.usage.tokenCountRows, 3);
  assert.equal(receipt.parity.usage.meaningfulTokenRows, 3);
  assert.equal(receipt.parity.usage.meaningfulCostRows, 2);
  assert.equal(receipt.parity.usage.meaningfulModelRows, 1);
  assert.equal(receipt.parity.usage.priceCoverage, true);
  assert.equal(receipt.parity.usage.advancedModulesReady, true);
  assert.equal(receipt.parity.usage.advancedModulesAvailable, 1);
  assert.equal(receipt.parity.usage.advancedModulesUnavailable, 2);
  assert.equal(receipt.parity.community.serviceConfigured, true);
  assert.equal(receipt.parity.community.currentLayout, true);
  assert.equal(receipt.parity.community.partialHistoryDetail, false);
  assert.equal(receipt.settings.connected, true);
  assert.equal(receipt.share.route, "#weekly");
  assert.equal(Object.hasOwn(receipt, "refreshId"), false);
  assert.equal(Object.hasOwn(receipt, "dashboardOrigin"), false);
  assert.equal(Object.hasOwn(receipt, "fixtureRoot"), false);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.startupRefresh), true);
});

test("closed macOS receipt preserves a bounded degraded startup code", () => {
  const receipt = buildClosedReceipt({
    status: "passed",
    cleanQuit: true,
    startupRefresh: {
      requestCount: 1,
      originBound: true,
      activeLoaderBound: true,
      refreshIdChanged: true,
      terminalStatus: "degraded",
      degradedFailureCode: "codex_rollout_generation_ambiguous",
    },
  });
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.startupRefresh.terminalStatus, "degraded");
  assert.equal(
    receipt.startupRefresh.degradedFailureCode,
    "codex_rollout_generation_ambiguous",
  );
  assert.equal(
    buildClosedReceipt({
      status: "passed",
      startupRefresh: {
        terminalStatus: "degraded",
        degradedFailureCode: "private-error",
      },
    }).startupRefresh.terminalStatus,
    "unknown",
  );
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
