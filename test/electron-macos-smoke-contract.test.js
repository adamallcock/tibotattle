import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DESKTOP_DEFAULT_CODEX_ROOT_ID } from "../apps/electron/desktop-codex-roots.js";
import {
  assertMacAppContract,
  assertMacSyntheticFixtureSettings,
  buildClosedReceipt,
  classifyMacDashboardParityEvidence,
  classifyAutomaticStartupRefreshReceipt,
  createSyntheticFixture,
  ELECTRON_MACOS_SMOKE_FAILURE_REASONS,
  ELECTRON_MACOS_SMOKE_DEGRADED_FAILURE_CODES,
  ELECTRON_MACOS_SMOKE_STARTUP_REFRESH_ERROR_CODES,
  hasMeaningfulMacCostEvidence,
  isMacPathFreeSettingsSnapshot,
  isMacPathfulCodexHomes,
  macSmokeCodexHomes,
  readMacSyntheticFixtureSettings,
  readMacSyntheticFixtureRefreshInterval,
  classifyMacSettingsEvidence,
  classifyMacSettingsPersistenceEvidence,
  isMacDashboardTarget,
  isMacSettingsTarget,
  observeLocalRefreshRequests,
  selectMacDashboardTarget,
  selectMacSettingsTarget,
  verifyMacSmokeArtifactIdentity,
} from "../scripts/smoke-electron-macos.mjs";

const TEST_SOURCE_REVISION = "a".repeat(40);
const TEST_ARTIFACT_SHA256 = "b".repeat(64);
const TEST_RECEIPT_IDENTITY = Object.freeze({
  sourceRevision: TEST_SOURCE_REVISION,
  artifactSha256: TEST_ARTIFACT_SHA256,
  artifactIdentityVerified: true,
});

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
  assert.match(source, /HOME: process\.env\.HOME/u);
  assert.doesNotMatch(source, /HOME: fixture\.home/u);
  assert.match(source, /desktop-first-run-v1\.json/u);
  assert.match(source, /desktop-settings-v1\.json/u);
  assert.match(source, /secondaryCodexHome/u);
  assert.match(source, /codexHomes: macSmokeCodexHomes\(codexHome, secondaryCodexHome\)/u);
  assert.match(source, /DESKTOP_SETTINGS_SCHEMA_VERSION/u);
  assert.match(source, /USAGE_MONITOR_ELECTRON_SMOKE_CONTROL/u);
  assert.match(source, /USAGE_MONITOR_TEST_LANE: MACOS_LOCAL_QA_TEST_LANE/u);
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
  assert.match(source, /runSmoke\(appPath, progress, \{/u);
  assert.match(source, /--source-revision/u);
  assert.match(source, /--artifact-sha256/u);
  assert.match(source, /verifyMacSmokeArtifactIdentity/u);
  assert.match(source, /recordSmokeProgress/u);
  assert.match(source, /dashboard_renderer_unavailable/u);
  assert.match(source, /refreshObserver\.selectOrigin/u);
  assert.match(source, /refreshObserver\.selectLoader/u);
  assert.match(source, /refreshObserver\.seal/u);
  assert.match(source, /selectMacDashboardTarget/u);
  assert.match(source, /isMacSettingsTarget/u);
  assert.match(source, /selectMacSettingsTarget/u);
  assert.match(source, /getCodexHomesForSettings/u);
  assert.match(source, /genericSnapshotPathFree/u);
  assert.match(source, /pathfulRead/u);
  assert.match(source, /settings-codex-roots/u);
  assert.match(source, /settings-primary-codex-root/u);
  assert.match(source, /settings-add-codex-root/u);
  assert.match(source, /readMacSyntheticFixtureRefreshInterval/u);
  assert.match(source, /classifyMacSettingsPersistenceEvidence/u);
  assert.match(source, /window\.close\(\)/u);
  assert.match(source, /setRefreshInterval\(900\)/u);
  assert.match(source, /refreshIntervalPersisted/u);
  assert.match(source, /Electron Settings reopen target/u);
  assert.match(source, /isMacPathFreeSettingsSnapshot/u);
  assert.match(source, /classifyMacSettingsEvidence/u);
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
  assert.match(source, /redundantShareLauncherAbsent/u);
  assert.doesNotMatch(source, /querySelector\("#electron-share-button"\)\?\.click/u);
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

test("macOS smoke keeps both Codex roots explicit and disposable", () => {
  const primaryPath = "/tmp/tibotattle-electron-macos/profile/home/.codex";
  const secondaryPath = "/tmp/tibotattle-electron-macos/profile/codex-secondary";
  const roots = macSmokeCodexHomes(primaryPath, secondaryPath);
  assert.equal(roots.activityRoots.length, 2);
  assert.equal(roots.primaryRootId, roots.activityRoots[0].rootId);
  assert.deepEqual(
    roots.activityRoots.map(({ kind, path, enabled }) => ({ kind, path, enabled })),
    [
      { kind: "custom", path: primaryPath, enabled: true },
      { kind: "custom", path: secondaryPath, enabled: true },
    ],
  );
  assert.equal(isMacPathfulCodexHomes(roots), true);
  assert.throws(() => macSmokeCodexHomes(primaryPath, primaryPath), TypeError);
  assert.throws(() => macSmokeCodexHomes(".codex", secondaryPath), TypeError);
});

test("macOS synthetic fixture persists exactly two custom roots without the default sentinel", async () => {
  const fixture = await createSyntheticFixture();
  try {
    const identity = await stat(fixture.identityFile);
    assert.equal(identity.isFile(), true);
    assert.equal(identity.mode & 0o777, 0o600);
    assert.equal(identity.size, 44);
    assert.equal(fixture.identityFile.startsWith(`${fixture.profile}/`), true);
    const evidence = await readMacSyntheticFixtureSettings(
      fixture.settingsPath,
      fixture.codexHome,
      fixture.secondaryCodexHome,
    );
    assert.deepEqual(evidence, {
      status: "passed",
      rootCount: 2,
      customRootCount: 2,
      defaultRootCount: 0,
      primaryRootExplicit: true,
    });
    const persisted = JSON.parse(await readFile(fixture.settingsPath, "utf8"));
    assert.equal(persisted.codexHomes.activityRoots.length, 2);
    assert.equal(
      persisted.codexHomes.activityRoots.every((root) => root.kind === "custom"),
      true,
    );
    assert.equal(
      persisted.codexHomes.activityRoots.some(
        (root) => root.rootId === DESKTOP_DEFAULT_CODEX_ROOT_ID,
      ),
      false,
    );
    assert.throws(
      () => assertMacSyntheticFixtureSettings({
        ...persisted,
        codexHomes: {
          activityRoots: [
            {
              rootId: DESKTOP_DEFAULT_CODEX_ROOT_ID,
              kind: "default",
              path: null,
              enabled: true,
            },
            persisted.codexHomes.activityRoots[1],
          ],
          primaryRootId: DESKTOP_DEFAULT_CODEX_ROOT_ID,
        },
      }, {
        primaryPath: fixture.codexHome,
        secondaryPath: fixture.secondaryCodexHome,
      }),
      TypeError,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("macOS synthetic fixture exposes only a bounded refresh interval read", async () => {
  const fixture = await createSyntheticFixture();
  try {
    assert.equal(
      await readMacSyntheticFixtureRefreshInterval(fixture.settingsPath),
      300,
    );
    await writeFile(
      fixture.settingsPath,
      `${JSON.stringify({
        schemaVersion: "tibotattle-desktop-settings-v2",
        refreshIntervalSeconds: 900,
      })}\n`,
      { mode: 0o600 },
    );
    assert.equal(
      await readMacSyntheticFixtureRefreshInterval(fixture.settingsPath),
      900,
    );
    await writeFile(
      fixture.settingsPath,
      `${JSON.stringify({
        schemaVersion: "tibotattle-desktop-settings-v2",
        refreshIntervalSeconds: 42,
      })}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      readMacSyntheticFixtureRefreshInterval(fixture.settingsPath),
      TypeError,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("macOS Settings persistence evidence requires bridge, file, close, and reopen proof", () => {
  const complete = classifyMacSettingsPersistenceEvidence({
    initialRefreshInterval: 300,
    changedRefreshInterval: 900,
    persistedRefreshInterval: 900,
    closeObserved: true,
    reopened: true,
    reopenedRefreshInterval: 900,
    persistedAfterReopen: 900,
  });
  assert.deepEqual(complete, {
    status: "passed",
    initialValid: true,
    changed: true,
    persisted: true,
    closeObserved: true,
    reopened: true,
    retained: true,
    fileRetained: true,
  });
  for (const invalid of [
    { changedRefreshInterval: 300 },
    { persistedRefreshInterval: 300 },
    { closeObserved: false },
    { reopened: false },
    { reopenedRefreshInterval: 300 },
    { persistedAfterReopen: 300 },
  ]) {
    assert.equal(
      classifyMacSettingsPersistenceEvidence({
        initialRefreshInterval: 300,
        changedRefreshInterval: 900,
        persistedRefreshInterval: 900,
        closeObserved: true,
        reopened: true,
        reopenedRefreshInterval: 900,
        persistedAfterReopen: 900,
        ...invalid,
      }).status,
      "failed",
    );
  }
});

test("macOS Settings smoke performs persistence before close and reopens through dashboard", async () => {
  const source = await readFile("scripts/smoke-electron-macos.mjs", "utf8");
  const settingsStart = source.indexOf("async function assertSettingsFlow");
  const persistenceRead = source.indexOf(
    "Electron Settings persisted refresh interval",
    settingsStart,
  );
  const close = source.indexOf("closeMacSettingsWindow(settingsCdp", persistenceRead);
  const dashboardReopen = source.indexOf(
    "document.querySelector('#electron-settings-button')?.click()",
    close,
  );
  const reopenedTarget = source.indexOf("Electron Settings reopen target", dashboardReopen);
  const persistenceClassify = source.indexOf(
    "classifyMacSettingsPersistenceEvidence({",
    reopenedTarget,
  );
  assert.ok(settingsStart >= 0);
  assert.ok(persistenceRead > settingsStart);
  assert.ok(close > persistenceRead);
  assert.ok(dashboardReopen > close);
  assert.ok(reopenedTarget > dashboardReopen);
  assert.ok(persistenceClassify > reopenedTarget);
  assert.match(source.slice(settingsStart, persistenceClassify), /settingsPath/u);
  assert.match(source.slice(0, settingsStart), /window\.close\(\)/u);
  assert.match(source.slice(settingsStart, persistenceClassify), /refreshIntervalSeconds/u);
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

test("macOS Settings smoke requires multi-root semantics and separate pathful read", () => {
  const defaultRootId = "00000000-0000-4000-8000-000000000001";
  const customRootId = "11111111-1111-4111-8111-111111111111";
  const genericSettings = {
    settings: {
      codexHomes: {
        activityRoots: [
          { rootId: defaultRootId, kind: "default", enabled: true },
          { rootId: customRootId, kind: "custom", enabled: true },
        ],
        primaryRootId: defaultRootId,
      },
    },
  };
  const pathfulRoots = {
    activityRoots: [
      {
        rootId: defaultRootId,
        kind: "default",
        path: null,
        enabled: true,
      },
      {
        rootId: customRootId,
        kind: "custom",
        path: "/tmp/tibotattle-electron-macos-secondary",
        enabled: true,
      },
    ],
    primaryRootId: defaultRootId,
  };
  assert.equal(isMacPathFreeSettingsSnapshot(genericSettings), true);
  assert.equal(isMacPathfulCodexHomes(pathfulRoots), true);
  assert.deepEqual(
    classifyMacSettingsEvidence({
      rootCount: 2,
      renderedRootCount: 2,
      primaryRadioCount: 2,
      selectedPrimaryCount: 1,
      selectedPrimaryRootId: defaultRootId,
      primaryCardCount: 1,
      listRole: true,
      cardsHaveSemantics: true,
      addPresent: true,
      addDisabled: false,
      genericSettings,
      genericDashboardSettings: genericSettings,
      pathfulRoots,
    }),
    {
      status: "passed",
      rootCount: 2,
      renderedRootCount: 2,
      primarySelected: true,
      listSemantics: true,
      addPresent: true,
      addEnabled: true,
      genericSnapshotPathFree: true,
      pathfulRead: true,
    },
  );
  assert.equal(
    isMacPathFreeSettingsSnapshot({
      settings: {
        codexHomes: {
          activityRoots: [
            {
              rootId: customRootId,
              kind: "custom",
              enabled: true,
              path: "/tmp/should-not-cross-the-generic-boundary",
            },
          ],
          primaryRootId: customRootId,
        },
      },
    }),
    false,
  );
  for (const invalid of [
    { selectedPrimaryCount: 2 },
    { primaryCardCount: 0 },
    { listRole: false },
    { cardsHaveSemantics: false },
    { addPresent: false },
    { addDisabled: true },
    {
      genericDashboardSettings: {
        settings: {
          codexHomes: {
            activityRoots: [
              {
                rootId: customRootId,
                kind: "custom",
                enabled: true,
                path: "/tmp/should-not-cross-the-dashboard-boundary",
              },
            ],
            primaryRootId: customRootId,
          },
        },
      },
    },
    { pathfulRoots: { ...pathfulRoots, primaryRootId: customRootId } },
  ]) {
    assert.equal(
      classifyMacSettingsEvidence({
        rootCount: 2,
        renderedRootCount: 2,
        primaryRadioCount: 2,
        selectedPrimaryCount: 1,
        selectedPrimaryRootId: defaultRootId,
        primaryCardCount: 1,
        listRole: true,
        cardsHaveSemantics: true,
        addPresent: true,
        addDisabled: false,
        genericSettings,
        genericDashboardSettings: genericSettings,
        pathfulRoots,
        ...invalid,
      }).status,
      "failed",
    );
  }
});

test("macOS Settings smoke requires Add to be disabled exactly at the root limit", () => {
  const defaultRootId = "00000000-0000-4000-8000-000000000001";
  const customRootIds = [
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
    "77777777-7777-4777-8777-777777777777",
    "88888888-8888-4888-8888-888888888888",
  ];
  const roots = [
    {
      rootId: defaultRootId,
      kind: "default",
      path: null,
      enabled: true,
    },
    ...customRootIds.map((rootId, index) => ({
      rootId,
      kind: "custom",
      path: `/tmp/tibotattle-electron-macos-secondary-${index + 1}`,
      enabled: true,
    })),
  ];
  const pathfulRoots = { activityRoots: roots, primaryRootId: defaultRootId };
  const genericSettings = {
    settings: {
      codexHomes: {
        activityRoots: roots.map(({ rootId, kind, enabled }) => ({
          rootId,
          kind,
          enabled,
        })),
        primaryRootId: defaultRootId,
      },
    },
  };
  const base = {
    rootCount: 8,
    renderedRootCount: 8,
    primaryRadioCount: 8,
    selectedPrimaryCount: 1,
    selectedPrimaryRootId: defaultRootId,
    primaryCardCount: 1,
    listRole: true,
    cardsHaveSemantics: true,
    addPresent: true,
    genericSettings,
    genericDashboardSettings: genericSettings,
    pathfulRoots,
  };
  assert.deepEqual(
    classifyMacSettingsEvidence({ ...base, addDisabled: true }),
    {
      status: "passed",
      rootCount: 8,
      renderedRootCount: 8,
      primarySelected: true,
      listSemantics: true,
      addPresent: true,
      addEnabled: false,
      genericSnapshotPathFree: true,
      pathfulRead: true,
    },
  );
  assert.equal(
    classifyMacSettingsEvidence({ ...base, addDisabled: false }).status,
    "failed",
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
      centralServiceProxy: true,
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
    googleButtonEnabled: true,
    appleButtonEnabled: true,
    currentLayout: true,
    consentVisible: true,
    noServiceCopy: false,
    noServiceNoticeCount: 0,
  };
  assert.deepEqual(
    classifyMacDashboardParityEvidence({ health, usage, community }),
    { status: "passed", reason: null },
  );
  const accountlessHealth = { capabilities: {
    centralServiceProxy: false,
    contributionDevicePairing: false,
    incrementalContributionSync: false,
  } };
  const accountlessCommunity = {
    route: "#community",
    pageVisible: true,
    accountlessMode: true,
    accountlessPanel: true,
    accountlessPreferenceReady: true,
    accountlessState: true,
    accountlessTransport: true,
    sharingSettingsEnabled: true,
    legacyJourneyVisible: false,
    googleButton: false,
    appleButton: false,
    googleButtonEnabled: false,
    appleButtonEnabled: false,
    consentVisible: false,
    partialHistoryDetail: false,
  };
  const accountlessEvidence = { health: accountlessHealth, usage, community: accountlessCommunity };
  assert.deepEqual(classifyMacDashboardParityEvidence(accountlessEvidence),
    { status: "passed", reason: null });
  for (const key of ["accountlessPanel", "accountlessPreferenceReady", "accountlessState",
    "accountlessTransport", "sharingSettingsEnabled"]) {
    assert.deepEqual(classifyMacDashboardParityEvidence({
      ...accountlessEvidence, community: { ...accountlessCommunity, [key]: false },
    }), { status: "failed", reason: "community" }, key);
  }
  for (const key of ["legacyJourneyVisible", "googleButton", "appleButton",
    "googleButtonEnabled", "appleButtonEnabled", "consentVisible"]) {
    assert.deepEqual(classifyMacDashboardParityEvidence({
      ...accountlessEvidence, community: { ...accountlessCommunity, [key]: true },
    }), { status: "failed", reason: "community" }, key);
  }
  assert.deepEqual(classifyMacDashboardParityEvidence({ ...accountlessEvidence, health }),
    { status: "failed", reason: "community" }, "accountless mode cannot retain hosted upload authority");
  assert.deepEqual(classifyMacDashboardParityEvidence({
    ...accountlessEvidence, startupRefresh: { terminalStatus: "degraded" },
  }), { status: "failed", reason: "community" }, "hidden legacy partial detail is not visible disclosure");
  assert.deepEqual(
    classifyMacDashboardParityEvidence({
      health: {
        capabilities: {
          ...health.capabilities,
          centralServiceProxy: false,
        },
      },
      usage,
      community,
    }),
    { status: "failed", reason: "community" },
  );
  assert.deepEqual(
    classifyMacDashboardParityEvidence({
      health: {
        capabilities: {
          centralServiceProxy: false,
          contributionDevicePairing: false,
          incrementalContributionSync: false,
        },
      },
      usage,
      community: {
        ...community,
        googleButtonEnabled: false,
        appleButtonEnabled: false,
        consentVisible: false,
        noServiceCopy: true,
        noServiceNoticeCount: 1,
      },
    }),
    { status: "passed", reason: null },
  );
  assert.deepEqual(
    classifyMacDashboardParityEvidence({
      health: {
        capabilities: {
          centralServiceProxy: false,
          contributionDevicePairing: false,
          incrementalContributionSync: false,
        },
      },
      usage,
      community: {
        ...community,
        googleButtonEnabled: false,
        appleButtonEnabled: false,
        consentVisible: false,
        noServiceCopy: true,
        noServiceNoticeCount: 2,
      },
    }),
    { status: "failed", reason: "community" },
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
    ...TEST_RECEIPT_IDENTITY,
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
    settings: {
      connected: true,
      tabCount: 3,
      tabs: true,
      rootCount: 2,
      renderedRootCount: 2,
      primarySelected: true,
      listSemantics: true,
      addPresent: true,
      addEnabled: true,
      genericSnapshotPathFree: true,
      pathfulRead: true,
      refreshIntervalPersisted: true,
    },
    share: {
      route: "#weekly",
      panelVisible: true,
      panelFocused: true,
      canvas: true,
    },
  });
  assert.equal(receipt.schemaVersion, "tibotattle-electron-macos-smoke-v4");
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.cleanQuit, true);
  assert.equal(receipt.contentFree, true);
  assert.equal(receipt.failureReason, null);
  assert.deepEqual(receipt.source, {
    revision: TEST_SOURCE_REVISION,
    identified: true,
  });
  assert.deepEqual(receipt.artifact, {
    sha256: TEST_ARTIFACT_SHA256,
    identityBound: true,
  });
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
  assert.equal(receipt.settings.rootCount, 2);
  assert.equal(receipt.settings.renderedRootCount, 2);
  assert.equal(receipt.settings.primarySelected, true);
  assert.equal(receipt.settings.listSemantics, true);
  assert.equal(receipt.settings.addPresent, true);
  assert.equal(receipt.settings.addEnabled, true);
  assert.equal(receipt.settings.genericSnapshotPathFree, true);
  assert.equal(receipt.settings.pathfulRead, true);
  assert.equal(receipt.settings.refreshIntervalPersisted, true);
  assert.equal(Object.hasOwn(receipt.settings, "path"), false);
  assert.equal(Object.hasOwn(receipt.settings, "activityRoots"), false);
  assert.equal(receipt.share.route, "#weekly");
  assert.equal(Object.hasOwn(receipt, "refreshId"), false);
  assert.equal(Object.hasOwn(receipt, "dashboardOrigin"), false);
  assert.equal(Object.hasOwn(receipt, "fixtureRoot"), false);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.startupRefresh), true);
});

test("passed macOS receipt fails closed without exact source and artifact identity", () => {
  const missing = buildClosedReceipt({ status: "passed" });
  assert.equal(missing.status, "failed");
  assert.equal(missing.failureStage, "contract");
  assert.equal(missing.failureReason, "source_revision_invalid");
  assert.equal(missing.source.identified, false);
  assert.equal(missing.artifact.identityBound, false);

  const sourceOnly = buildClosedReceipt({
    status: "passed",
    sourceRevision: TEST_SOURCE_REVISION,
  });
  assert.equal(sourceOnly.status, "failed");
  assert.equal(sourceOnly.failureReason, "artifact_identity_invalid");
});

test("macOS smoke recomputes and binds the selected app ASAR digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-mac-smoke-identity-"));
  const app = join(root, "TiboTattle Dev.app");
  const resources = join(app, "Contents", "Resources");
  const bytes = Buffer.from("reviewed-asar-fixture", "utf8");
  const expected = createHash("sha256").update(bytes).digest("hex");
  try {
    await mkdir(resources, { recursive: true });
    await writeFile(join(resources, "app.asar"), bytes);
    assert.equal(await verifyMacSmokeArtifactIdentity(app, expected), expected);
    await assert.rejects(
      verifyMacSmokeArtifactIdentity(app, "0".repeat(64)),
      (error) => error?.code === "ELECTRON_MACOS_SMOKE_ARTIFACT_IDENTITY_INVALID",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("closed macOS receipt preserves a bounded degraded startup code", () => {
  const receipt = buildClosedReceipt({
    status: "passed",
    ...TEST_RECEIPT_IDENTITY,
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
      ...TEST_RECEIPT_IDENTITY,
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
  assert.equal(receipt.settings.refreshIntervalPersisted, false);
  assert.equal(receipt.share.panelVisible, false);
});
