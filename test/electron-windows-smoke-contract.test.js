import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  attachSmokeChildErrorBoundary,
  attachSmokeMonitorRejectionBoundary,
  aggregate,
  buildPackagedElectronArgs,
  classifyAutomaticStartupRefreshReceipt,
  classifyWindowsSmokeStartupGateResult,
  classifySmokeFailure,
  createSyntheticFixture,
  classifyWindowsDashboardTargetPoll,
  isWindowsDashboardTarget,
  isWindowsRecoveryTarget,
  isWindowsSmokeDirectEntry,
  observeLocalRefreshRequests,
  queryWindowsProcessTableForTest,
  selectWindowsDashboardTarget,
  WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_ERROR_CODES,
  WINDOWS_ELECTRON_SMOKE_DASHBOARD_CHECKPOINT_ALLOWLIST,
  WINDOWS_ELECTRON_SMOKE_FAILURE_REASON_ALLOWLIST,
  WINDOWS_ELECTRON_SMOKE_FAILURE_STAGE_ALLOWLIST,
  normalizeWindowsDashboardCheckpoint,
  releaseWindowsSmokeRefreshGate,
  WINDOWS_ELECTRON_SMOKE_STARTUP_GATE_ERROR_CODES,
  waitFor,
} from "../scripts/smoke-electron-windows.mjs";

test("Windows smoke direct entry tolerates case-only checkout path differences", () => {
  const modulePath = "C:\\actions\\_work\\TiboTattle\\TiboTattle\\scripts\\smoke-electron-windows.mjs";
  const argvPath = "c:\\ACTIONS\\_WORK\\tibotattle\\tibotattle\\SCRIPTS\\smoke-electron-windows.mjs";
  assert.equal(
    isWindowsSmokeDirectEntry({ argvPath, modulePath, platform: "win32" }),
    true,
  );
  assert.equal(
    isWindowsSmokeDirectEntry({
      argvPath: `${argvPath.slice(0, -3)}js2`,
      modulePath,
      platform: "win32",
    }),
    false,
  );
  assert.equal(
    isWindowsSmokeDirectEntry({
      argvPath: "/tmp/Scripts/smoke-electron-windows.mjs",
      modulePath: "/tmp/scripts/smoke-electron-windows.mjs",
      platform: "linux",
    }),
    false,
  );
});

test("packaged smoke launch args debug only the primary and relaunch processes", () => {
  const primaryArgs = buildPackagedElectronArgs({
    userDataDir: "C:\\temp\\electron-user-data",
    remoteDebuggingPort: 43123,
  });
  const relaunchArgs = buildPackagedElectronArgs({
    userDataDir: "C:\\temp\\electron-user-data",
    remoteDebuggingPort: 43124,
  });
  const secondaryArgs = buildPackagedElectronArgs({
    userDataDir: "C:\\temp\\electron-user-data",
    remoteDebugging: false,
  });

  assert.deepEqual(primaryArgs, [
    "--user-data-dir=C:\\temp\\electron-user-data",
    "--remote-debugging-port=43123",
    "--remote-debugging-address=127.0.0.1",
    "--disable-gpu",
    "--no-first-run",
  ]);
  assert.deepEqual(relaunchArgs, [
    "--user-data-dir=C:\\temp\\electron-user-data",
    "--remote-debugging-port=43124",
    "--remote-debugging-address=127.0.0.1",
    "--disable-gpu",
    "--no-first-run",
  ]);
  assert.deepEqual(secondaryArgs, [
    "--user-data-dir=C:\\temp\\electron-user-data",
    "--disable-gpu",
    "--no-first-run",
  ]);
  assert.equal(
    secondaryArgs.some((argument) => argument.startsWith("--remote-debugging-")),
    false,
  );
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

function emitRefresh(cdp, {
  origin,
  requestId,
  loaderId,
}) {
  cdp.emit("Network.requestWillBeSent", {
    request: {
      method: "POST",
      url: `${origin}/api/local/refresh`,
    },
    requestId,
    loaderId,
  });
}

function fakeProcessTableProbe() {
  const probe = new EventEmitter();
  probe.stdout = new EventEmitter();
  probe.exitCode = null;
  probe.signalCode = null;
  probe.kill = () => {
    probe.exitCode = -1;
    return true;
  };
  return probe;
}

test("Windows Electron smoke is packaged, x64-only, and content-free", async () => {
  const source = await readFile("scripts/smoke-electron-windows.mjs", "utf8");
  const entry = await readFile("apps/electron/main.js", "utf8");
  const lifecycle = await readFile("apps/electron/desktop-lifecycle.js", "utf8");
  const gate = await readFile("apps/electron/platform-gate.js", "utf8");
  const qualification = await readFile("apps/electron/windows-qualification.js", "utf8");
  const workflow = await readFile(".github/workflows/windows-portability.yml", "utf8");
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(packageJson.scripts["smoke:electron:windows"], "node ./scripts/smoke-electron-windows.mjs");
  assert.match(source, /win-unpacked/u);
  assert.match(source, /TiboTattle Dev\.exe/u);
  assert.match(source, /process\.platform !== "win32"/u);
  assert.match(source, /process\.arch !== "x64"/u);
  assert.match(source, /0x8664/u);
  assert.match(source, /WINDOWS_ELECTRON_SMOKE_EXITED_BEFORE_CONTROL/u);
  assert.match(source, /WINDOWS_ELECTRON_SMOKE_FAILURE_STAGE_ALLOWLIST/u);
  assert.match(source, /WINDOWS_ELECTRON_SMOKE_FAILURE_REASON_ALLOWLIST/u);
  assert.match(workflow, /'status'/u);
  assert.match(source, /failureStage/u);
  assert.match(source, /failureReason/u);
  assert.match(source, /classifySmokeFailure/u);
  assert.match(source, /TIBOTATTLE_ELECTRON_RUNTIME_SMOKE_OUTPUT_PATH/u);
  assert.match(source, /TIBOTATTLE_ELECTRON_RUNTIME_SMOKE_DIAGNOSTIC_PATH/u);
  assert.match(source, /await writeSmokeDiagnostic\("module_loaded"\)/u);
  assert.match(source, /terminate_process_tree_started/u);
  assert.match(source, /terminate_process_tree_finished/u);
  assert.match(source, /cleanup_started/u);
  assert.match(source, /post_terminate_cleanup_started/u);
  assert.match(source, /cleanup_finished/u);
  assert.match(source, /await writeFile\(outputPath, `\$\{JSON\.stringify\(output\)\}/u);
  for (const reason of [
    "refresh_not_accepted",
    "refresh_terminal_failed",
    "status_schema",
    "status_state",
    "status_query_accepted",
    "status_method_accepted",
    "dash_loopback",
    "dash_origin",
    "dash_health",
    "dash_topbar",
    "dash_sidebar",
    "dash_nav",
    "dash_active_nav",
    "dash_active_page",
    "dash_refresh",
    "dash_language",
    "dash_trends_nav",
    "dash_trends_page",
    "dash_previous_page",
    "dash_trends_count",
    "dash_refresh_boundary",
    "dash_startup_duplicate",
    "dash_startup_receipt",
    "dash_startup_changed",
    "dash_startup_failed",
    "dash_startup_cancelled",
  ]) {
    assert.match(workflow, new RegExp(`'${reason}'`, "u"));
  }
  assert.match(source, /WINDOWS_ELECTRON_SMOKE_CONTROL_TIMEOUT/u);
  assert.match(source, /WINDOWS_ELECTRON_SMOKE_DASHBOARD_TIMEOUT/u);
  assert.match(source, /WINDOWS_ELECTRON_SMOKE_REFRESH_TIMEOUT/u);
  assert.match(source, /WINDOWS_ELECTRON_SMOKE_RELAUNCH_TIMEOUT/u);
  const runSmokeStart = source.indexOf("export async function runSmoke");
  const runSmokeTry = source.indexOf("  try {", runSmokeStart);
  const fixtureSetup = source.indexOf(
    "fixture = await createSyntheticFixture();",
    runSmokeTry,
  );
  const runSmokeCatch = source.indexOf("\n  } catch (error) {", fixtureSetup);
  assert.ok(
    runSmokeStart >= 0
      && runSmokeTry > runSmokeStart
      && fixtureSetup > runSmokeTry
      && runSmokeCatch > fixtureSetup,
    "fixture setup must stay inside the classified smoke boundary",
  );
  assert.match(source, /WINDOWS_ELECTRON_SMOKE_FIXTURE_SETUP_FAILED/u);
  assert.match(source, /if \(fixture !== null\) \{[\s\S]*?rm\(fixture\.root/u);
  assert.doesNotMatch(source, /lastError\.message/u);
  assert.match(source, /isTerminalSmokeError/u);
  assert.match(source, /if \(isTerminalSmokeError\(error\)\) throw error/u);
  assert.doesNotMatch(source, /command\([^\n]+\)\.catch\(\(\) => null\)/u);
  assert.match(source, /shell: false/u);
  assert.match(source, /windowsHide: true/u);
  assert.match(source, /stdio:\s*\["ignore",\s*"ignore",\s*"ignore",\s*"ipc"\]/u);
  assert.match(source, /child\.send/u);
  assert.match(source, /child\.on\?\.\("message"/u);
  assert.match(source, /return attachSmokeChildErrorBoundary\(child\)/u);
  assert.match(source, /normalizeControlMessage/u);
  assert.match(source, /exactKeys/u);
  assert.match(source, /nextMessage\.close/u);
  assert.doesNotMatch(source, /(?:primary|relaunch|second)\.(?:stdin|stdout)/u);
  assert.match(source, /--user-data-dir=/u);
  assert.match(source, /CLAUDE_CONFIG_DIR/u);
  assert.match(source, /CODEX_HOME/u);
  assert.match(source, /USAGE_MONITOR_STATE_ROOT/u);
  assert.match(source, /createWindowsFilesystemAdapter/u);
  assert.match(source, /createWindowsProtectedStateStore/u);
  assert.match(source, /createDesktopFirstRunReceiptBackend/u);
  assert.match(source, /DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION/u);
  assert.match(source, /windowsProtectedStateStoreFactory/u);
  assert.match(source, /firstRunReceiptBackendFactory/u);
  assert.match(source, /platform: "win32"/u);
  assert.match(source, /architecture: "x64"/u);
  assert.match(source, /windowsFilesystemAdapter\.ensureDirectory\(stateRoot\)/u);
  assert.doesNotMatch(source, /\b(?:mkdir|makeDirectory)\(stateRoot/u);
  assert.match(source, /localDashboardReady/u);
  assert.match(source, /\/api\/local\/refresh/u);
  assert.match(source, /__TIBOTATTLE_ELECTRON_WINDOWS_SMOKE__/u);
  assert.match(source, /releaseWindowsSmokeRefreshGate/u);
  assert.match(source, /Object\.isFrozen\(bridge\)/u);
  assert.match(source, /waitForStartupRefresh\.length !== 0/u);
  assert.match(source, /releaseStartupRefresh\.length !== 0/u);
  assert.match(source, /bridge\.releaseStartupRefresh\(\)/u);
  assert.match(source, /WINDOWS_ELECTRON_SMOKE_REFRESH_BOUNDARY_INVALID/u);
  assert.match(source, /\/api\/local\/desktop-status/u);
  assert.match(source, /validateDesktopShellStatus/u);
  assert.match(source, /DESKTOP_STATUS_SCHEMA_INVALID/u);
  assert.match(source, /DESKTOP_STATUS_FAIL_CLOSED_INVALID/u);
  assert.doesNotMatch(source, /DESKTOP_STATUS_ALLOWANCE_INVALID/u);
  assert.match(source, /assertFailClosedDesktopStatusRoute/u);
  assert.match(source, /does not qualify direct provider evidence/u);
  assert.match(source, /status\.state !== "stale"/u);
  assert.match(source, /status\.allowance !== null/u);
  assert.match(source, /status\.notificationEvidence !== null/u);
  assert.match(source, /DESKTOP_STATUS_QUERY_ACCEPTED/u);
  assert.match(source, /DESKTOP_STATUS_METHOD_ACCEPTED/u);
  assert.match(source, /X-Usage-Monitor-Local/u);
  const syntheticRefreshBody = source.slice(
    source.indexOf("async function runSyntheticRefresh"),
    source.indexOf("async function assertFailClosedDesktopStatusRoute"),
  );
  assert.match(
    syntheticRefreshBody,
    /Origin:\s+dashboardUrl\.origin/u,
    "synthetic refresh must stamp the validated dashboard origin",
  );
  assert.doesNotMatch(
    syntheticRefreshBody,
    /Origin:\s+(?:undefined|null|["'][^"']*["'])/u,
    "synthetic refresh must not omit or hard-code the origin",
  );
  assert.match(source, /Page\.getFrameTree/u);
  assert.match(source, /Network\.enable/u);
  assert.match(source, /isWindowsDashboardTarget/u);
  assert.match(source, /selectWindowsDashboardTarget/u);
  assert.match(
    source,
    /const selected = selectWindowsDashboardTarget\(targets, port\)/u,
    "dashboard target polling must ignore non-dashboard pages until the exact target exists",
  );
  assert.match(source, /target\.url === `http:\/\/127\.0\.0\.1:\$\{dashboardPort\}\/`/u);
  assert.match(source, /websocket\.port === String\(debugPort\)/u);
  assert.match(source, /observeLocalRefreshRequests/u);
  assert.match(source, /refreshObserver\.selectOrigin/u);
  assert.match(source, /assertAutomaticStartupRefresh/u);
  assert.match(source, /refreshObserver\.selectLoader/u);
  assert.match(source, /refreshObserver\.seal/u);
  assert.match(source, /STARTUP_REFRESH_DUPLICATED/u);
  assert.match(source, /previousRefreshId/u);
  assert.match(source, /refreshObserver\.reset\(\)/u);
  assert.match(source, /const initialLoader = await waitFor/u);
  assert.match(
    source,
    /mainFrameLoaderId\(cdp\)[\s\S]+?checkpoint\("frame_unavailable"\)/u,
    "initial loader acquisition must preserve a frame-unavailable checkpoint",
  );
  assert.doesNotMatch(source, /waitFor\(\s+\(\) => readRequiredRefreshLoader\(cdp\)/u);
  assert.match(source, /reloadDashboardDocument/u);
  assert.match(source, /Page\.enable/u);
  assert.match(source, /Page\.reload/u);
  assert.match(source, /Page\.frameNavigated/u);
  assert.match(source, /performance\.timeOrigin/u);
  assert.doesNotMatch(source, /location\.reload\(\)/u);
  assert.match(source, /secondInstanceRejected/u);
  assert.match(source, /export function buildPackagedElectronArgs/u);
  assert.match(source, /remoteDebuggingPort/u);
  assert.match(source, /remoteDebugging = true/u);
  assert.match(source, /remoteDebugging: false/u);
  assert.match(
    source,
    /primary = spawnPackagedElectron\(executable, fixture, primaryPort, artifactRoot\)/u,
  );
  assert.match(
    source,
    /second = spawnPackagedElectron\(executable, fixture, null, artifactRoot, \{\s*remoteDebugging: false,\s*\}\)/u,
  );
  assert.match(
    source,
    /relaunch = spawnPackagedElectron\(executable, fixture, relaunchPort, artifactRoot\)/u,
  );
  assert.doesNotMatch(source, /assertSecondInstanceNeverReady|secondEndpointMonitor|secondPort/u);
  assert.match(source, /primaryDuringSecond/u);
  assert.match(source, /primaryAfterSecond/u);
  assert.match(source, /SECOND_INSTANCE_BECAME_PRIMARY/u);
  assert.match(source, /showHideTrayLifecycle/u);
  assert.match(source, /tray-hide-v1/u);
  assert.match(source, /tray-show-v1/u);
  assert.match(source, /tray-toggle-v1/u);
  const credentialProbe = source.indexOf(
    'credentialCommand(primary, nextPrimaryMessage, "credential-probe-v1")',
  );
  const credentialCreate = source.indexOf(
    'credentialCommand(primary, nextPrimaryMessage, "credential-create-v1")',
  );
  const credentialRead = source.indexOf(
    'credentialCommand(relaunch, nextRelaunchMessage, "credential-read-v1")',
  );
  const credentialDelete = source.indexOf(
    'credentialCommand(relaunch, nextRelaunchMessage, "credential-delete-v1")',
  );
  assert.ok(credentialProbe >= 0 && credentialCreate > credentialProbe);
  assert.ok(credentialRead > credentialCreate && credentialDelete > credentialRead);
  assert.match(source, /credentialMayExist/u);
  assert.match(source, /credentialDeleted/u);
  assert.match(source, /directCredentialCleanup\(fixture, artifactRoot\)/u);
  assert.match(source, /app\.asar\.unpacked/u);
  assert.match(source, /loadAuditedWindowsCredentialBinding/u);
  assert.match(source, /remaining === null/u);
  assert.match(source, /monitorDescendantsUntilExit/u);
  assert.match(source, /attachSmokeMonitorRejectionBoundary/u);
  const refreshSucceeded = source.indexOf('value === "succeeded"');
  const refreshBoundary = source.indexOf("await reloadDashboardDocument(connection)");
  assert.ok(refreshSucceeded >= 0 && refreshBoundary > refreshSucceeded);
  const desktopStatusRoute = source.indexOf(
    "await assertFailClosedDesktopStatusRoute(connection)",
  );
  const syntheticRefreshReceipt = source.indexOf(
    "progress.syntheticRefresh = true",
  );
  const statusPhase = source.indexOf('failurePhase = "status";');
  assert.ok(
    desktopStatusRoute >= 0
      && syntheticRefreshReceipt >= 0
      && syntheticRefreshReceipt < desktopStatusRoute
      && statusPhase > syntheticRefreshReceipt
      && statusPhase < desktopStatusRoute,
    "synthetic refresh must be receipted before the separate packaged desktop-status route is qualified",
  );
  const automaticRefresh = source.indexOf("await assertAutomaticStartupRefresh({");
  const syntheticRefresh = source.indexOf("async function runSyntheticRefresh");
  assert.ok(
    automaticRefresh >= 0
      && syntheticRefresh > automaticRefresh,
    "the real startup refresh is qualified before the explicit synthetic refresh",
  );
  const readyWait = source.indexOf("const ready = await waitFor");
  assert.ok(
    readyWait >= 0 && automaticRefresh > readyWait,
    "the startup refresh check is ordered after the readiness wait",
  );
  const secondMonitor = source.indexOf(
    "const secondDescendantMonitor = attachSmokeMonitorRejectionBoundary(",
  );
  const secondExit = source.indexOf("childExitPromise(second)");
  const primaryMonitor = source.indexOf(
    "const primaryDescendantMonitor = attachSmokeMonitorRejectionBoundary(",
  );
  const primaryQuit = source.indexOf("await quitCommand(\n        primary,");
  const relaunchMonitor = source.indexOf(
    "const relaunchDescendantMonitor = attachSmokeMonitorRejectionBoundary(",
  );
  const relaunchQuit = source.indexOf("await quitCommand(\n          relaunch,");
  assert.ok(secondMonitor >= 0 && secondExit > secondMonitor);
  assert.ok(primaryMonitor >= 0 && primaryQuit > primaryMonitor);
  assert.ok(relaunchMonitor >= 0 && relaunchQuit > relaunchMonitor);
  assert.match(source, /relaunchPersistence/u);
  assert.match(source, /WINDOWS_PROCESS_TABLE_QUERY/u);
  assert.match(source, /Get-CimInstance -ClassName Win32_Process/u);
  const processTableQuery = source.slice(
    source.indexOf("async function queryWindowsProcessTableWithSpawner"),
    source.indexOf("async function captureDescendantPids"),
  );
  assert.match(processTableQuery, /probe\.once\("close"/u);
  assert.doesNotMatch(processTableQuery, /probe\.once\("exit"/u);
  assert.match(source, /queryWindowsProcessTableForTest/u);
  assert.match(source, /captureDescendantPids/u);
  assert.match(source, /addCurrentDescendants/u);
  assert.match(source, /waitForDescendantsGone/u);
  assert.match(source, /second instance descendant cleanup/u);
  assert.match(source, /requireNonEmpty: false/u);
  assert.match(source, /table\.has\(pid\)/u);
  assert.doesNotMatch(source, /progress\.noOrphan\s*=\s*true/u);
  const primaryOrphanCheck = source.indexOf(
    '"primary descendant cleanup"',
  );
  const relaunchOrphanCheck = source.indexOf(
    '"relaunch descendant cleanup"',
  );
  const noOrphanAssignment = source.indexOf(
    "progress.noOrphan = primaryNoOrphan && relaunchNoOrphan",
  );
  assert.ok(primaryOrphanCheck >= 0 && relaunchOrphanCheck >= 0);
  assert.ok(noOrphanAssignment > primaryOrphanCheck);
  assert.ok(noOrphanAssignment > relaunchOrphanCheck);
  assert.match(source, /contentFree: true/u);
  assert.match(source, /status,\n\s+target: "win32-x64"/u);
  assert.match(source, /aggregate\("unsupported"\)/u);
  assert.doesNotMatch(source, /windowsProductionReady\s*:\s*true/u);
  assert.match(entry, /WINDOWS_ELECTRON_SMOKE_CONTROL/u);
  assert.match(entry, /messageSource\.on\("message"/u);
  assert.match(entry, /sendControlMessage/u);
  assert.match(entry, /sendControlMessage\.call\([\s\S]*callback/u);
  assert.match(entry, /installWindowsSmokeControlForTest/u);
  assert.match(entry, /credentialProbe/u);
  assert.match(entry, /credentialCommand/u);
  assert.match(entry, /disconnect/u);
  assert.doesNotMatch(entry, /process\.(?:stdin|stdout)/u);
  assert.match(entry, /credential-probe-v1/u);
  assert.match(entry, /credential-create-v1/u);
  assert.match(entry, /credential-read-v1/u);
  assert.match(entry, /credential-delete-v1/u);
  assert.match(entry, /runWindowsElectronQualificationCredentialProbe/u);
  assert.match(gate, /windowsQualificationOnly/u);
  assert.doesNotMatch(entry, /ipcRenderer|contextBridge/u);
  assert.match(lifecycle, /windowVisible/u);
  assert.match(qualification, /windows-electron-v1/u);
  assert.match(qualification, /windows-electron-smoke/u);
  assert.match(qualification, /usage-monitor-electron-runtime-v0\.1/u);
  assert.match(qualification, /included_unverified/u);
  assert.match(qualification, /\.asar/iu);
  assert.match(qualification, /unpacked/u);
  assert.match(qualification, /KEYTAR_WIN32_X64_SHA256/u);
  assert.match(qualification, /runWindowsCredentialManagerProbe/u);
  assert.match(qualification, /runWindowsElectronQualificationCredentialCommandForTest/u);
  assert.match(qualification, /windows-qualification/u);
  assert.doesNotMatch(qualification, /console\.(?:log|error|warn)/u);
});

test("Windows smoke selects only the exact ephemeral loopback dashboard target", () => {
  const debugPort = 43123;
  const dashboardPort = 49299;
  const target = (url, overrides = {}) => ({
    type: "page",
    url,
    webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort}/devtools/page/1`,
    ...overrides,
  });
  const valid = target(`http://127.0.0.1:${dashboardPort}/`);
  assert.equal(isWindowsDashboardTarget(valid, debugPort), true);
  assert.equal(
    selectWindowsDashboardTarget([
      target("data:text/html,<h1>loading</h1>"),
      target("file:///tmp/recovery.html"),
      target(`https://127.0.0.1:${dashboardPort}/`),
      target(`http://localhost:${dashboardPort}/`),
      target(`http://127.0.0.1:${dashboardPort}/electron-settings.html`),
      target(`http://127.0.0.1:${dashboardPort}/#weekly`),
      target(`http://127.0.0.1:${dashboardPort}/?ready=1`),
      target(`http://user:pass@127.0.0.1:${dashboardPort}/`),
      target(`http://127.0.0.2:${dashboardPort}/`),
      target(`http://127.0.0.1:${dashboardPort}`),
      { ...valid, type: "other" },
      {
        ...valid,
        webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort + 1}/devtools/page/2`,
      },
      {
        ...valid,
        webSocketDebuggerUrl: `ws://localhost:${debugPort}/devtools/page/wrong-host`,
      },
      {
        ...valid,
        webSocketDebuggerUrl: `wss://127.0.0.1:${debugPort}/devtools/page/wrong-protocol`,
      },
      {
        ...valid,
        webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort}/json/version`,
      },
      {
        ...valid,
        webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort}/devtools/page/`,
      },
      {
        ...valid,
        webSocketDebuggerUrl: `ws://user:pass@127.0.0.1:${debugPort}/devtools/page/auth`,
      },
      {
        ...valid,
        webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort}/devtools/page/query?bad=1`,
      },
      valid,
    ],
    debugPort,
  ), valid);
  for (const rejected of [
    target("data:text/html,<h1>loading</h1>"),
    target("file:///tmp/recovery.html"),
    target(`https://127.0.0.1:${dashboardPort}/`),
    target(`http://localhost:${dashboardPort}/`),
    target(`http://127.0.0.1:${dashboardPort}/electron-settings.html`),
    target(`http://127.0.0.1:${dashboardPort}/#weekly`),
    target(`http://127.0.0.1:${dashboardPort}/?ready=1`),
    target(`http://user:pass@127.0.0.1:${dashboardPort}/`),
    target(`http://127.0.0.2:${dashboardPort}/`),
    target(`http://127.0.0.1:${dashboardPort}`),
    target("not a URL"),
    { ...valid, type: "other" },
    { ...valid, webSocketDebuggerUrl: "" },
    {
      ...valid,
      webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort + 1}/devtools/page/wrong-port`,
    },
    {
      ...valid,
      webSocketDebuggerUrl: `ws://localhost:${debugPort}/devtools/page/wrong-host`,
    },
    {
      ...valid,
      webSocketDebuggerUrl: `wss://127.0.0.1:${debugPort}/devtools/page/wrong-protocol`,
    },
    {
      ...valid,
      webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort}/json/version`,
    },
    {
      ...valid,
      webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort}/devtools/page/`,
    },
    {
      ...valid,
      webSocketDebuggerUrl: `ws://user:pass@127.0.0.1:${debugPort}/devtools/page/auth`,
    },
    {
      ...valid,
      webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort}/devtools/page/query?bad=1`,
    },
  ]) {
    assert.equal(isWindowsDashboardTarget(rejected, debugPort), false);
  }
  assert.equal(selectWindowsDashboardTarget(valid, debugPort), undefined);
  assert.equal(selectWindowsDashboardTarget([valid], 0), undefined);
  assert.equal(selectWindowsDashboardTarget([valid], 65_536), undefined);
  assert.equal(selectWindowsDashboardTarget([valid], "43123"), undefined);
});

test("Windows dashboard polling labels only the fixed recovery data surface as recovery", () => {
  const debugPort = 43123;
  const dashboardPort = 49299;
  const target = (url, overrides = {}) => ({
    type: "page",
    url,
    webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort}/devtools/page/1`,
    ...overrides,
  });
  const recovery = target("data:text/html;charset=utf-8,%3Cmain%3Erecovery%3C%2Fmain%3E");
  const settings = target(`http://127.0.0.1:${dashboardPort}/electron-settings.html`);
  const hostileLocalPage = target(`http://127.0.0.1:${dashboardPort}/unexpected.html`);
  const valid = target(`http://127.0.0.1:${dashboardPort}/`);
  assert.equal(isWindowsRecoveryTarget(recovery), true);
  assert.equal(isWindowsRecoveryTarget(settings), false);
  assert.equal(isWindowsRecoveryTarget(hostileLocalPage), false);
  assert.equal(classifyWindowsDashboardTargetPoll([], debugPort), "target_poll_no_page");
  assert.equal(
    classifyWindowsDashboardTargetPoll([recovery], debugPort),
    "target_poll_recovery_only",
  );
  assert.equal(
    classifyWindowsDashboardTargetPoll([recovery, settings], debugPort),
    "target_poll_no_page",
  );
  assert.equal(
    classifyWindowsDashboardTargetPoll([hostileLocalPage], debugPort),
    "target_poll_no_page",
  );
  assert.equal(
    classifyWindowsDashboardTargetPoll([recovery, valid], debugPort),
    "target_poll_dashboard_candidate",
  );
});

test("Windows dashboard checkpoints are fixed, content-free, and retained on failure", () => {
  assert.deepEqual(WINDOWS_ELECTRON_SMOKE_DASHBOARD_CHECKPOINT_ALLOWLIST, [
    "not_started",
    "debug_endpoint_ready",
    "target_poll_no_page",
    "target_poll_recovery_only",
    "target_poll_dashboard_candidate",
    "cdp_attach_failed",
    "frame_unavailable",
    "renderer_not_ready",
    "dashboard_ready",
  ]);
  for (const checkpoint of WINDOWS_ELECTRON_SMOKE_DASHBOARD_CHECKPOINT_ALLOWLIST) {
    assert.equal(normalizeWindowsDashboardCheckpoint(checkpoint), checkpoint);
  }
  for (const invalid of [
    null,
    undefined,
    "http://127.0.0.1:43123/",
    "C:\\private\\dashboard.log",
    "private renderer content",
    "target_poll_dashboard_candidate secret",
  ]) {
    assert.equal(normalizeWindowsDashboardCheckpoint(invalid), "not_started");
  }
  const failed = aggregate("failed", {
    dashboardCheckpoint: "target_poll_recovery_only",
    failureStage: "dashboard",
    failureReason: "timeout",
    title: "must not cross the aggregate boundary",
    url: "http://127.0.0.1:49299/",
  });
  assert.equal(failed.dashboardCheckpoint, "target_poll_recovery_only");
  assert.doesNotMatch(
    JSON.stringify(failed),
    /(?:[A-Za-z]:[\\/]|127\.0\.0\.1|private|title|url|renderer content|\.log)/iu,
  );
});

test("Windows dashboard target polling remains strict and records checkpoint sequencing", async () => {
  const source = await readFile("scripts/smoke-electron-windows.mjs", "utf8");
  const connectionStart = source.indexOf("async function dashboardConnection");
  const endpoint = source.indexOf('checkpoint("debug_endpoint_ready")', connectionStart);
  const targetPoll = source.indexOf("classifyWindowsDashboardTargetPoll", connectionStart);
  const attach = source.indexOf('checkpoint("cdp_attach_failed")', connectionStart);
  const frame = source.indexOf('checkpoint("frame_unavailable")', connectionStart);
  const renderer = source.indexOf('checkpoint("renderer_not_ready")', connectionStart);
  const ready = source.indexOf('checkpoint("dashboard_ready")', connectionStart);
  assert.ok(endpoint >= 0);
  assert.ok(targetPoll > endpoint);
  assert.ok(attach > targetPoll);
  assert.ok(frame > attach);
  assert.ok(renderer > frame);
  assert.ok(ready > renderer);
  assert.match(source, /target_poll_no_page/u);
  assert.match(source, /target_poll_recovery_only/u);
  assert.match(source, /return selectWindowsDashboardTarget|selectWindowsDashboardTarget\(targets, port\)/u);
  assert.match(source, /dashboardCheckpoint/u);
  assert.match(source, /dashboardCheckpoint: normalizeWindowsDashboardCheckpoint/u);
  const pageEnable = source.indexOf('await cdp.request("Page.enable")', connectionStart);
  const networkEnable = source.indexOf('await cdp.request("Network.enable")', connectionStart);
  const initialLoaderBinding = source.indexOf(
    "selectRequiredRefreshLoader(refreshObserver, initialLoader)",
    connectionStart,
  );
  const rendererReadyWait = source.indexOf("const ready = await waitFor", connectionStart);
  const readyLoaderBinding = source.indexOf(
    "selectRequiredRefreshLoader(refreshObserver, readyLoader)",
    connectionStart,
  );
  const originValidation = source.indexOf(
    "refreshObserver.selectOrigin(dashboardUrl.origin)",
    connectionStart,
  );
  const gateRelease = source.indexOf(
    "await releaseWindowsSmokeRefreshGate(cdp)",
    connectionStart,
  );
  const automaticRefresh = source.indexOf(
    "await assertAutomaticStartupRefresh({",
    connectionStart,
  );
  assert.ok(pageEnable >= 0);
  assert.ok(networkEnable > pageEnable);
  assert.ok(initialLoaderBinding > networkEnable);
  assert.ok(rendererReadyWait > initialLoaderBinding);
  assert.ok(readyLoaderBinding > rendererReadyWait);
  assert.ok(originValidation > readyLoaderBinding);
  assert.ok(gateRelease > originValidation);
  assert.ok(automaticRefresh > gateRelease);
  assert.match(source, /dashboardUrl\.origin !== targetDashboardOrigin/u);
});

test("Windows preload startup gate requires one exact successful release", async () => {
  const expressions = [];
  const cdp = {
    async evaluate(expression) {
      expressions.push(expression);
      return "released";
    },
  };
  assert.equal(await releaseWindowsSmokeRefreshGate(cdp), true);
  assert.equal(expressions.length, 1);
  assert.match(expressions[0], /__TIBOTATTLE_ELECTRON_WINDOWS_SMOKE__/u);
  assert.match(expressions[0], /Object\.isFrozen\(bridge\)/u);
  assert.match(expressions[0], /Object\.keys\(bridge\)\[0\] !== "version"/u);
  assert.match(expressions[0], /waitForStartupRefresh\.length !== 0/u);
  assert.match(expressions[0], /releaseStartupRefresh\.length !== 0/u);
  assert.match(expressions[0], /releaseStartupRefresh\(\)/u);

  const errorCode = WINDOWS_ELECTRON_SMOKE_STARTUP_GATE_ERROR_CODES.boundaryInvalid;
  for (const [result, reason] of [
    ["missing", "missing"],
    ["malformed", "malformed"],
    ["duplicate", "duplicate"],
    [null, "malformed"],
    [{ status: "released" }, "malformed"],
  ]) {
    assert.deepEqual(
      classifyWindowsSmokeStartupGateResult(result),
      result === "released"
        ? { status: "released" }
        : { status: "failed", errorCode, reason },
    );
    await assert.rejects(
      () => releaseWindowsSmokeRefreshGate({
        evaluate: async () => result,
      }),
      (error) => error?.code === errorCode,
      `gate result ${String(result)} must fail closed`,
    );
  }
  await assert.rejects(
    () => releaseWindowsSmokeRefreshGate(null),
    (error) => error?.code === errorCode,
  );
});

test("Windows startup refresh evidence requires the validated origin and active loader", () => {
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
  // Before the renderer location is validated, no request is acceptable
  // evidence, even though both requests use loopback.
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
  emitRefresh(cdp, {
    origin: otherLoopbackOrigin,
    requestId: "later-wrong-origin",
    loaderId: "loader-current",
  });
  assert.equal(observer.snapshot().length, 1);

  observer.reset();
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
  observer.reset();
  assert.equal(observer.selectLoader(null), null);
  emitRefresh(cdp, {
    origin: dashboardOrigin,
    requestId: "foreign-loader-after-invalid-selection",
    loaderId: "loader-foreign",
  });
  assert.deepEqual(observer.snapshot(), []);
  observer.dispose();
});

test("Windows startup refresh receipt semantics are stateful and content-free", () => {
  const codes = WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_ERROR_CODES;
  assert.deepEqual(
    classifyAutomaticStartupRefreshReceipt({
      phase: "completion",
      requestCount: 1,
      refresh: { status: "succeeded", refreshId: "refresh-new" },
      expectedRefreshId: "refresh-new",
    }),
    { status: "completed", refreshId: "refresh-new" },
  );
  assert.deepEqual(
    classifyAutomaticStartupRefreshReceipt({
      phase: "acceptance",
      requestCount: 1,
      refresh: { status: "succeeded", refreshId: "refresh-old" },
      previousRefreshId: "refresh-old",
    }),
    { status: "pending" },
  );
  assert.deepEqual(
    classifyAutomaticStartupRefreshReceipt({
      phase: "acceptance",
      requestCount: 2,
      refresh: { status: "running", refreshId: "refresh-new" },
    }),
    { status: "failed", errorCode: codes.duplicate },
  );
  for (const [status, errorCode] of [
    ["failed", codes.failed],
    ["cancelled", codes.cancelled],
  ]) {
    assert.deepEqual(
      classifyAutomaticStartupRefreshReceipt({
        phase: "completion",
        requestCount: 1,
        refresh: { status, refreshId: "refresh-new" },
        expectedRefreshId: "refresh-new",
      }),
      { status: "failed", errorCode },
    );
  }
  assert.deepEqual(
    classifyAutomaticStartupRefreshReceipt({
      phase: "completion",
      requestCount: 1,
      refresh: { status: "succeeded", refreshId: "refresh-other" },
      expectedRefreshId: "refresh-new",
    }),
    { status: "failed", errorCode: codes.changedReceipt },
  );
  assert.deepEqual(
    classifyAutomaticStartupRefreshReceipt({
      phase: "acceptance",
      requestCount: 1,
      refresh: { status: "running" },
      previousRefreshId: "refresh-old",
    }),
    { status: "failed", errorCode: codes.invalidReceipt },
  );
});

test("Windows Electron smoke creates stateRoot through the native adapter only", async () => {
  const ordinaryDirectories = [];
  const adapterDirectories = [];
  let adapterOptions = null;
  let protectedStoreOptions = null;
  let receiptBackendOptions = null;
  const protectedStore = Object.freeze({ name: "protected-store" });
  const receiptSaves = [];
  const receiptBackend = Object.freeze({
    async save(value) {
      receiptSaves.push(value);
    },
  });
  let adapter;
  const fixture = await createSyntheticFixture({
    windowsFilesystemAdapterFactory(options) {
      adapterOptions = options;
      adapter = {
        ensureDirectory(path) {
          adapterDirectories.push(path);
          return {
            volumeSerialNumber: "0000000000000001",
            fileId: "00112233445566778899aabbccddeeff",
            linkCount: 1,
          };
        },
      };
      return adapter;
    },
    windowsProtectedStateStoreFactory(options) {
      protectedStoreOptions = options;
      return protectedStore;
    },
    firstRunReceiptBackendFactory(options) {
      receiptBackendOptions = options;
      return receiptBackend;
    },
    makeDirectory(path, options) {
      ordinaryDirectories.push(path);
      return mkdir(path, options);
    },
  });
  try {
    assert.deepEqual(adapterOptions, { platform: "win32", architecture: "x64" });
    assert.deepEqual(adapterDirectories, [fixture.stateRoot]);
    assert.equal(ordinaryDirectories.includes(fixture.stateRoot), false);
    const settingsRoot = join(fixture.userData, "desktop-settings");
    assert.equal(protectedStoreOptions.adapter, adapter);
    assert.equal(protectedStoreOptions.rootPath, settingsRoot);
    assert.equal(receiptBackendOptions.platform, "win32");
    assert.equal(receiptBackendOptions.rootPath, settingsRoot);
    assert.equal(receiptBackendOptions.windowsProtectedStateStore, protectedStore);
    assert.deepEqual(receiptSaves, [{
      schemaVersion: "tibotattle-desktop-first-run-v1",
      acknowledged: true,
    }]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Windows Electron smoke removes its fixture when first-run receipt seeding fails", async () => {
  const removedRoots = [];
  await assert.rejects(
    createSyntheticFixture({
      windowsFilesystemAdapterFactory() {
        return { ensureDirectory() {} };
      },
      windowsProtectedStateStoreFactory() {
        throw Object.assign(new Error("seed failed"), {
          code: "WINDOWS_ELECTRON_SMOKE_FIRST_RUN_SEED_FAILED",
        });
      },
      async removeDirectory(path, options) {
        removedRoots.push({ path, options });
        await rm(path, options);
      },
    }),
    (error) => error?.code === "WINDOWS_ELECTRON_SMOKE_FIRST_RUN_SEED_FAILED",
  );
  assert.equal(removedRoots.length, 1);
  assert.deepEqual(removedRoots[0].options, { recursive: true, force: true });
  await assert.rejects(readFile(removedRoots[0].path), { code: "ENOENT" });
});

test("Windows Electron smoke removes its fixture when native state setup fails", async () => {
  const removedRoots = [];
  await assert.rejects(
    createSyntheticFixture({
      windowsFilesystemAdapterFactory() {
        return {
          ensureDirectory() {
            throw Object.assign(new Error("fixed adapter failure"), {
              code: "WINDOWS_FILESYSTEM_SECURITY_POLICY",
            });
          },
        };
      },
      async removeDirectory(path, options) {
        removedRoots.push({ path, options });
        await rm(path, options);
      },
    }),
    (error) => error?.code === "WINDOWS_FILESYSTEM_SECURITY_POLICY",
  );
  assert.equal(removedRoots.length, 1);
  assert.deepEqual(removedRoots[0].options, { recursive: true, force: true });
  await assert.rejects(readFile(removedRoots[0].path), { code: "ENOENT" });
});

test("failed Windows Electron smoke preserves completed closed-schema progress", () => {
  const progress = {
    artifact: true,
    dashboardReady: true,
    dashboardCheckpoint: "renderer_not_ready",
    syntheticRefresh: false,
    failureStage: "control",
    failureReason: "child_exit",
    credentialPersistence: false,
    secret: "must not cross the aggregate boundary",
  };
  const failed = aggregate("failed", progress);

  assert.deepEqual(failed, {
    status: "failed",
    target: "win32-x64",
    contentFree: true,
    failureStage: "control",
    failureReason: "child_exit",
    artifact: true,
    dashboardReady: true,
    dashboardCheckpoint: "renderer_not_ready",
    syntheticRefresh: false,
    secondInstanceRejected: false,
    showHideTrayLifecycle: false,
    cleanQuit: false,
    noOrphan: false,
    statePersistence: false,
    credentialPersistence: false,
    relaunchPersistence: false,
  });
  assert.equal(Object.hasOwn(failed, "secret"), false);
  assert.equal(progress.artifact, true);
});

test("packaged child spawn errors stay inside the aggregate boundary", () => {
  const child = new EventEmitter();
  assert.doesNotThrow(() => attachSmokeChildErrorBoundary(child));
  assert.doesNotThrow(() => {
    child.emit("error", new Error("private launch details"));
  });
});

test("deferred monitor rejection is handled immediately and still propagates", async () => {
  let unhandledReason = null;
  const onUnhandledRejection = (reason) => {
    unhandledReason = reason;
  };
  process.on("unhandledRejection", onUnhandledRejection);
  const expected = new Error("fixed monitor failure");
  const monitor = Promise.reject(expected);
  const returned = attachSmokeMonitorRejectionBoundary(monitor);
  try {
    assert.equal(returned, monitor);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandledReason, null);
    await assert.rejects(returned, (error) => error === expected);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
});

test("fixture setup failures use the artifact assertion diagnostic", () => {
  assert.deepEqual(
    classifySmokeFailure(
      { code: "WINDOWS_ELECTRON_SMOKE_FIXTURE_SETUP_FAILED" },
      "artifact",
    ),
    { failureStage: "artifact", failureReason: "assertion" },
  );
  const failed = aggregate("failed", {
    failureStage: "artifact",
    failureReason: "assertion",
  });
  assert.equal(failed.contentFree, true);
  assert.equal(failed.failureStage, "artifact");
  assert.equal(failed.failureReason, "assertion");
});

test("Windows Electron smoke diagnostics are fixed, phase-bound, and content-free", () => {
  assert.deepEqual(WINDOWS_ELECTRON_SMOKE_FAILURE_STAGE_ALLOWLIST, [
    "none",
    "unsupported",
    "artifact",
    "launch",
    "control",
    "dashboard",
    "credential",
    "lifecycle",
    "refresh",
    "status",
    "persistence",
    "instance",
    "shutdown",
    "relaunch",
    "unknown",
  ]);
  assert.deepEqual(WINDOWS_ELECTRON_SMOKE_FAILURE_REASON_ALLOWLIST, [
    "none",
    "unsupported",
    "child_exit",
    "timeout",
    "protocol",
    "assertion",
    "operation",
    "refresh_not_accepted",
    "refresh_terminal_failed",
    "status_schema",
    "status_state",
    "status_query_accepted",
    "status_method_accepted",
    "dash_loopback",
    "dash_origin",
    "dash_health",
    "dash_topbar",
    "dash_sidebar",
    "dash_nav",
    "dash_active_nav",
    "dash_active_page",
    "dash_refresh",
    "dash_language",
    "dash_trends_nav",
    "dash_trends_page",
    "dash_previous_page",
    "dash_trends_count",
    "dash_refresh_boundary",
    "dash_startup_duplicate",
    "dash_startup_receipt",
    "dash_startup_changed",
    "dash_startup_failed",
    "dash_startup_cancelled",
    "unknown",
  ]);
  const dashboardFailureCases = [
    ["WINDOWS_ELECTRON_SMOKE_LOOPBACK_REQUIRED", "dash_loopback", "assertion"],
    ["WINDOWS_ELECTRON_SMOKE_LOOPBACK_ORIGIN_INVALID", "dash_origin", "assertion"],
    ["WINDOWS_ELECTRON_SMOKE_COMPANION_NOT_READY", "dash_health", "assertion"],
    ["WINDOWS_ELECTRON_SMOKE_SHELL_TOPBAR_MISSING", "dash_topbar", "assertion"],
    ["WINDOWS_ELECTRON_SMOKE_SHELL_SIDEBAR_MISSING", "dash_sidebar", "assertion"],
    ["WINDOWS_ELECTRON_SMOKE_SHELL_NAVIGATION_INVALID", "dash_nav", "assertion"],
    ["WINDOWS_ELECTRON_SMOKE_SHELL_ACTIVE_NAV_INVALID", "dash_active_nav", "assertion"],
    ["WINDOWS_ELECTRON_SMOKE_SHELL_ACTIVE_PAGE_INVALID", "dash_active_page", "assertion"],
    ["WINDOWS_ELECTRON_SMOKE_SHELL_REFRESH_MISSING", "dash_refresh", "assertion"],
    ["WINDOWS_ELECTRON_SMOKE_SHELL_LANGUAGE_MISSING", "dash_language", "assertion"],
    ["WINDOWS_ELECTRON_SMOKE_SHELL_TRENDS_INACTIVE", "dash_trends_nav", "assertion"],
    ["WINDOWS_ELECTRON_SMOKE_SHELL_TRENDS_PAGE_INACTIVE", "dash_trends_page", "assertion"],
    ["WINDOWS_ELECTRON_SMOKE_SHELL_PREVIOUS_PAGE_ACTIVE", "dash_previous_page", "assertion"],
    ["WINDOWS_ELECTRON_SMOKE_SHELL_TRENDS_COUNT_INVALID", "dash_trends_count", "assertion"],
    ["WINDOWS_ELECTRON_SMOKE_REFRESH_BOUNDARY_INVALID", "dash_refresh_boundary", "protocol"],
    ["WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_DUPLICATED", "dash_startup_duplicate", "assertion"],
    ["WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_RECEIPT_INVALID", "dash_startup_receipt", "assertion"],
    ["WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_RECEIPT_CHANGED", "dash_startup_changed", "assertion"],
    ["WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_FAILED", "dash_startup_failed", "assertion"],
    ["WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_CANCELLED", "dash_startup_cancelled", "assertion"],
  ];
  const dashboardReasons = dashboardFailureCases.map(([, reason]) => reason);
  assert.equal(new Set(dashboardReasons).size, dashboardReasons.length);
  assert.doesNotMatch(
    JSON.stringify(dashboardReasons),
    /(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/|\\Users\\|username|password|secret|token|pid|process|stdout|stderr|command|executable)/iu,
  );
  for (const [code, reason, nonDashboardReason] of dashboardFailureCases) {
    assert.deepEqual(
      classifySmokeFailure({ code }, "dashboard"),
      { failureStage: "dashboard", failureReason: reason },
    );
    assert.deepEqual(
      classifySmokeFailure({ code }, "refresh"),
      { failureStage: "refresh", failureReason: reason },
    );
    assert.deepEqual(
      classifySmokeFailure({ code }, "control"),
      { failureStage: "control", failureReason: nonDashboardReason },
    );
  }
  const fixedFailureCases = [
    [
      "WINDOWS_ELECTRON_SMOKE_REFRESH_NOT_ACCEPTED",
      "refresh_not_accepted",
      "refresh",
    ],
    [
      "WINDOWS_ELECTRON_SMOKE_REFRESH_FAILED",
      "refresh_terminal_failed",
      "refresh",
    ],
    [
      "WINDOWS_ELECTRON_SMOKE_DESKTOP_STATUS_SCHEMA_INVALID",
      "status_schema",
      "status",
    ],
    [
      "WINDOWS_ELECTRON_SMOKE_DESKTOP_STATUS_FAIL_CLOSED_INVALID",
      "status_state",
      "status",
    ],
    [
      "WINDOWS_ELECTRON_SMOKE_DESKTOP_STATUS_QUERY_ACCEPTED",
      "status_query_accepted",
      "status",
    ],
    [
      "WINDOWS_ELECTRON_SMOKE_DESKTOP_STATUS_METHOD_ACCEPTED",
      "status_method_accepted",
      "status",
    ],
  ];
  for (const [code, reason, phase] of fixedFailureCases) {
    assert.deepEqual(
      classifySmokeFailure({
        code,
        state: "fresh",
        allowance: { remainingPercent: 100 },
        notificationEvidence: { secret: "must not cross the aggregate boundary" },
      }, phase),
      { failureStage: phase, failureReason: reason },
    );
    assert.deepEqual(
      classifySmokeFailure({ code }, "control"),
      { failureStage: "control", failureReason: reason },
    );
  }
  const stateOnlyFailure = aggregate("failed", {
    failureStage: "status",
    failureReason: "status_state",
    state: "fresh",
    allowance: { remainingPercent: 100 },
    notificationEvidence: { secret: "must not cross the aggregate boundary" },
  });
  assert.deepEqual(
    stateOnlyFailure,
    {
      status: "failed",
      target: "win32-x64",
      contentFree: true,
      failureStage: "status",
      failureReason: "status_state",
      artifact: false,
      dashboardReady: false,
      dashboardCheckpoint: "not_started",
      syntheticRefresh: false,
      secondInstanceRejected: false,
      showHideTrayLifecycle: false,
      cleanQuit: false,
      noOrphan: false,
      statePersistence: false,
      credentialPersistence: false,
      relaunchPersistence: false,
    },
  );
  assert.deepEqual(
    classifySmokeFailure(
      { code: "WINDOWS_ELECTRON_SMOKE_EXITED_BEFORE_CONTROL" },
      "control",
    ),
    { failureStage: "control", failureReason: "child_exit" },
  );
  assert.deepEqual(
    classifySmokeFailure(
      { code: "WINDOWS_ELECTRON_SMOKE_EXITED_BEFORE_READY" },
      "dashboard",
    ),
    { failureStage: "dashboard", failureReason: "child_exit" },
  );
  assert.deepEqual(
    classifySmokeFailure(
      { code: "WINDOWS_ELECTRON_SMOKE_CONTROL_TIMEOUT" },
      "control",
    ),
    { failureStage: "control", failureReason: "timeout" },
  );
  assert.deepEqual(
    classifySmokeFailure(new Error("private path and process details"), "dashboard"),
    { failureStage: "unknown", failureReason: "unknown" },
  );
  assert.deepEqual(
    aggregate("passed", {
      failureStage: "control",
      failureReason: "child_exit",
    }),
    {
      status: "passed",
      target: "win32-x64",
      contentFree: true,
      failureStage: "none",
      failureReason: "none",
      artifact: false,
      dashboardReady: false,
      dashboardCheckpoint: "not_started",
      syntheticRefresh: false,
      secondInstanceRejected: false,
      showHideTrayLifecycle: false,
      cleanQuit: false,
      noOrphan: false,
      statePersistence: false,
      credentialPersistence: false,
      relaunchPersistence: false,
    },
  );
  const invalid = aggregate("failed", {
    failureStage: "/private/path",
    failureReason: "private message",
  });
  assert.equal(invalid.failureStage, "unknown");
  assert.equal(invalid.failureReason, "unknown");
  assert.doesNotMatch(JSON.stringify(invalid), /private|path|message/iu);
});

test("waitFor fails fast for terminal smoke errors and retries transient misses", async () => {
  let terminalCalls = 0;
  await assert.rejects(
    waitFor(() => {
      terminalCalls += 1;
      const error = new Error("closed child");
      error.code = "WINDOWS_ELECTRON_SMOKE_EXITED_BEFORE_CONTROL";
      throw error;
    }, 5_000, "terminal smoke"),
    (error) => {
      assert.equal(error.code, "WINDOWS_ELECTRON_SMOKE_EXITED_BEFORE_CONTROL");
      return true;
    },
  );
  assert.equal(terminalCalls, 1);

  let transientCalls = 0;
  const recovered = await waitFor(() => {
    transientCalls += 1;
    if (transientCalls < 2) throw new Error("debugging endpoint not ready");
    return "ready";
  }, 5_000, "transient smoke");
  assert.equal(recovered, "ready");
  assert.equal(transientCalls, 2);

  let timeoutCalls = 0;
  const recoveredAfterTimeout = await waitFor(() => {
    timeoutCalls += 1;
    if (timeoutCalls < 2) {
      const error = new Error("bounded control timeout");
      error.code = "WINDOWS_ELECTRON_SMOKE_CONTROL_TIMEOUT";
      throw error;
    }
    return "ready";
  }, 5_000, "timeout smoke", "WINDOWS_ELECTRON_SMOKE_CONTROL_TIMEOUT");
  assert.equal(recoveredAfterTimeout, "ready");
  assert.equal(timeoutCalls, 2);

  let loaderReads = 0;
  const initialLoader = await waitFor(() => {
    loaderReads += 1;
    return loaderReads === 1 ? null : "loader-initial";
  }, 5_000, "initial dashboard loader");
  assert.equal(initialLoader, "loader-initial");
  assert.equal(loaderReads, 2);
});

test("Windows process-table probe waits for close and retains trailing drained rows", async () => {
  const probe = fakeProcessTableProbe();
  const calls = [];
  const pending = queryWindowsProcessTableForTest({
    spawnProbe(...args) {
      calls.push(args);
      return probe;
    },
  });
  probe.stdout.emit("data", "0:0\n100:1\n");
  probe.exitCode = 0;
  probe.emit("exit", 0, null);
  probe.stdout.emit("data", "200:100\n");
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  probe.emit("close", 0, null);
  const table = await pending;
  assert.deepEqual([...table.entries()], [[100, 1], [200, 100]]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], "powershell.exe");
  assert.deepEqual(calls[0][2], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
});

test("Windows process-table probe rejects nonzero close and drained malformed output", async () => {
  const nonzeroProbe = fakeProcessTableProbe();
  const nonzero = queryWindowsProcessTableForTest({
    spawnProbe: () => nonzeroProbe,
  });
  nonzeroProbe.stdout.emit("data", "100:1\n");
  nonzeroProbe.exitCode = 7;
  nonzeroProbe.emit("close", 7, null);
  await assert.rejects(nonzero, /process table probe failed/u);

  const malformedProbe = fakeProcessTableProbe();
  const malformed = queryWindowsProcessTableForTest({
    spawnProbe: () => malformedProbe,
  });
  malformedProbe.stdout.emit("data", "100:1\nbad-row\n");
  malformedProbe.exitCode = 0;
  malformedProbe.emit("close", 0, null);
  await assert.rejects(
    malformed,
    (error) => error?.code === "WINDOWS_ELECTRON_SMOKE_PROCESS_TABLE_INVALID",
  );

  const invalidIdleParentProbe = fakeProcessTableProbe();
  const invalidIdleParent = queryWindowsProcessTableForTest({
    spawnProbe: () => invalidIdleParentProbe,
  });
  invalidIdleParentProbe.stdout.emit("data", "0:9\n");
  invalidIdleParentProbe.exitCode = 0;
  invalidIdleParentProbe.emit("close", 0, null);
  await assert.rejects(
    invalidIdleParent,
    (error) => error?.code === "WINDOWS_ELECTRON_SMOKE_PROCESS_TABLE_INVALID",
  );
});

test("non-Windows Electron smoke reports unsupported rather than success", () => {
  if (process.platform === "win32") return;
  const result = spawnSync(
    process.execPath,
    ["scripts/smoke-electron-windows.mjs"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout.trim());
  assert.deepEqual(output, {
    status: "unsupported",
    target: "win32-x64",
    contentFree: true,
    failureStage: "unsupported",
    failureReason: "unsupported",
    artifact: false,
    dashboardReady: false,
    dashboardCheckpoint: "not_started",
    syntheticRefresh: false,
    secondInstanceRejected: false,
    showHideTrayLifecycle: false,
    cleanQuit: false,
    noOrphan: false,
    statePersistence: false,
    credentialPersistence: false,
    relaunchPersistence: false,
  });
});

test("import-only Windows smoke leaves an entry-boundary diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-electron-windows-entry-"));
  const outputPath = join(root, "aggregate.json");
  const diagnosticPath = join(root, "diagnostic.json");
  try {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", "import('./scripts/smoke-electron-windows.mjs')"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          TIBOTATTLE_ELECTRON_RUNTIME_SMOKE_OUTPUT_PATH: outputPath,
          TIBOTATTLE_ELECTRON_RUNTIME_SMOKE_DIAGNOSTIC_PATH: diagnosticPath,
        },
      },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    await assert.rejects(readFile(outputPath));
    assert.deepEqual(JSON.parse(await readFile(diagnosticPath, "utf8")), {
      schemaVersion: "tibotattle-windows-electron-runtime-diagnostic-v1",
      status: "running",
      phase: "module_loaded",
      exitClass: "running",
      contentFree: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows Electron smoke can seal its aggregate through an explicit sidecar", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "tibotattle-electron-windows-sidecar-"));
  const outputPath = join(root, "aggregate.json");
  const diagnosticPath = join(root, "diagnostic.json");
  try {
    const result = spawnSync(
      process.execPath,
      ["scripts/smoke-electron-windows.mjs"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TIBOTATTLE_ELECTRON_RUNTIME_SMOKE_OUTPUT_PATH: outputPath,
          TIBOTATTLE_ELECTRON_RUNTIME_SMOKE_DIAGNOSTIC_PATH: diagnosticPath,
        },
      },
    );
    assert.equal(result.status, 0);
    const consoleAggregate = JSON.parse(result.stdout.trim());
    const sidecarAggregate = JSON.parse(await readFile(outputPath, "utf8"));
    const diagnostic = JSON.parse(await readFile(diagnosticPath, "utf8"));
    assert.deepEqual(sidecarAggregate, consoleAggregate);
    assert.deepEqual(diagnostic, {
      schemaVersion: "tibotattle-windows-electron-runtime-diagnostic-v1",
      status: "sealed",
      phase: "completed",
      exitClass: "completed",
      contentFree: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
