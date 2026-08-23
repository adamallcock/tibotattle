import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import test from "node:test";

import {
  aggregate,
  classifyAutomaticStartupRefreshReceipt,
  classifySmokeFailure,
  createSyntheticFixture,
  observeLocalRefreshRequests,
  queryWindowsProcessTableForTest,
  WINDOWS_ELECTRON_SMOKE_STARTUP_REFRESH_ERROR_CODES,
  WINDOWS_ELECTRON_SMOKE_FAILURE_REASON_ALLOWLIST,
  WINDOWS_ELECTRON_SMOKE_FAILURE_STAGE_ALLOWLIST,
  waitFor,
} from "../scripts/smoke-electron-windows.mjs";

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
  assert.doesNotMatch(source, /lastError\.message/u);
  assert.match(source, /isTerminalSmokeError/u);
  assert.match(source, /if \(isTerminalSmokeError\(error\)\) throw error/u);
  assert.doesNotMatch(source, /command\([^\n]+\)\.catch\(\(\) => null\)/u);
  assert.match(source, /shell: false/u);
  assert.match(source, /windowsHide: true/u);
  assert.match(source, /stdio:\s*\["ignore",\s*"ignore",\s*"ignore",\s*"ipc"\]/u);
  assert.match(source, /child\.send/u);
  assert.match(source, /child\.on\?\.\("message"/u);
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
  assert.match(source, /observeLocalRefreshRequests/u);
  assert.match(source, /refreshObserver\.selectOrigin/u);
  assert.match(source, /assertAutomaticStartupRefresh/u);
  assert.match(source, /refreshObserver\.selectLoader/u);
  assert.match(source, /refreshObserver\.seal/u);
  assert.match(source, /STARTUP_REFRESH_DUPLICATED/u);
  assert.match(source, /previousRefreshId/u);
  assert.match(source, /refreshObserver\.reset\(\)/u);
  assert.match(
    source,
    /selectRequiredRefreshLoader\(refreshObserver, await waitFor\(\s+\(\) => mainFrameLoaderId\(cdp\)/u,
    "initial loader acquisition must poll through a null result",
  );
  assert.doesNotMatch(source, /waitFor\(\s+\(\) => readRequiredRefreshLoader\(cdp\)/u);
  assert.match(source, /reloadDashboardDocument/u);
  assert.match(source, /Page\.enable/u);
  assert.match(source, /Page\.reload/u);
  assert.match(source, /Page\.frameNavigated/u);
  assert.match(source, /performance\.timeOrigin/u);
  assert.doesNotMatch(source, /location\.reload\(\)/u);
  assert.match(source, /secondInstanceRejected/u);
  assert.match(source, /assertSecondInstanceNeverReady/u);
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
  const secondMonitor = source.indexOf("const secondDescendantMonitor");
  const secondExit = source.indexOf("childExitPromise(second)");
  const primaryMonitor = source.indexOf("const primaryDescendantMonitor");
  const primaryQuit = source.indexOf("await quitCommand(\n        primary,");
  const relaunchMonitor = source.indexOf("const relaunchDescendantMonitor");
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
