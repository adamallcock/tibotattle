import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  aggregate,
  classifySmokeFailure,
  createSyntheticFixture,
  WINDOWS_ELECTRON_SMOKE_FAILURE_REASON_ALLOWLIST,
  WINDOWS_ELECTRON_SMOKE_FAILURE_STAGE_ALLOWLIST,
  waitFor,
} from "../scripts/smoke-electron-windows.mjs";

test("Windows Electron smoke is packaged, x64-only, and content-free", async () => {
  const source = await readFile("scripts/smoke-electron-windows.mjs", "utf8");
  const entry = await readFile("apps/electron/main.js", "utf8");
  const lifecycle = await readFile("apps/electron/desktop-lifecycle.js", "utf8");
  const gate = await readFile("apps/electron/platform-gate.js", "utf8");
  const qualification = await readFile("apps/electron/windows-qualification.js", "utf8");
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
  assert.match(source, /failureStage/u);
  assert.match(source, /failureReason/u);
  assert.match(source, /classifySmokeFailure/u);
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
  assert.match(source, /platform: "win32"/u);
  assert.match(source, /architecture: "x64"/u);
  assert.match(source, /windowsFilesystemAdapter\.ensureDirectory\(stateRoot\)/u);
  assert.doesNotMatch(source, /\b(?:mkdir|makeDirectory)\(stateRoot/u);
  assert.match(source, /localDashboardReady/u);
  assert.match(source, /\/api\/local\/refresh/u);
  assert.match(source, /X-Usage-Monitor-Local/u);
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

test("Windows Electron smoke creates stateRoot through the native adapter only", async () => {
  const ordinaryDirectories = [];
  const adapterDirectories = [];
  let adapterOptions = null;
  const fixture = await createSyntheticFixture({
    windowsFilesystemAdapterFactory(options) {
      adapterOptions = options;
      return {
        ensureDirectory(path) {
          adapterDirectories.push(path);
          return {
            volumeSerialNumber: "0000000000000001",
            fileId: "00112233445566778899aabbccddeeff",
            linkCount: 1,
          };
        },
      };
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
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
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
    "unknown",
  ]);
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
