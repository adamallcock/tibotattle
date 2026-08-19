import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

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
  assert.match(source, /shell: false/u);
  assert.match(source, /windowsHide: true/u);
  assert.match(source, /--user-data-dir=/u);
  assert.match(source, /CLAUDE_CONFIG_DIR/u);
  assert.match(source, /CODEX_HOME/u);
  assert.match(source, /USAGE_MONITOR_STATE_ROOT/u);
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
    'credentialCommand(primary, nextPrimaryLine, "credential-probe-v1")',
  );
  const credentialCreate = source.indexOf(
    'credentialCommand(primary, nextPrimaryLine, "credential-create-v1")',
  );
  const credentialRead = source.indexOf(
    'credentialCommand(relaunch, nextRelaunchLine, "credential-read-v1")',
  );
  const credentialDelete = source.indexOf(
    'credentialCommand(relaunch, nextRelaunchLine, "credential-delete-v1")',
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
  const primaryQuit = source.indexOf('primary.stdin?.write("quit-v1\\n")');
  const relaunchMonitor = source.indexOf("const relaunchDescendantMonitor");
  const relaunchQuit = source.indexOf('relaunch.stdin?.write("quit-v1\\n")');
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
  assert.doesNotMatch(source, /result\.noOrphan\s*=\s*true/u);
  const primaryOrphanCheck = source.indexOf(
    '"primary descendant cleanup"',
  );
  const relaunchOrphanCheck = source.indexOf(
    '"relaunch descendant cleanup"',
  );
  const noOrphanAssignment = source.indexOf(
    "result.noOrphan = primaryNoOrphan && relaunchNoOrphan",
  );
  assert.ok(primaryOrphanCheck >= 0 && relaunchOrphanCheck >= 0);
  assert.ok(noOrphanAssignment > primaryOrphanCheck);
  assert.ok(noOrphanAssignment > relaunchOrphanCheck);
  assert.match(source, /contentFree: true/u);
  assert.match(source, /status,\n\s+target: "win32-x64"/u);
  assert.match(source, /aggregate\("unsupported"\)/u);
  assert.doesNotMatch(source, /windowsProductionReady\s*:\s*true/u);
  assert.match(entry, /WINDOWS_ELECTRON_SMOKE_CONTROL/u);
  assert.match(entry, /stdin/u);
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
