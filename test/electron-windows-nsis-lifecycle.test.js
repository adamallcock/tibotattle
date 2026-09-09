import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_LIFECYCLE_FIRST_PHASE,
  WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_LIFECYCLE_PHASE_ENVIRONMENT_KEY,
  WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_LIFECYCLE_RESTART_PHASE,
} from "../apps/electron/windows-account-observation-qualification-smoke.js";

import {
  assertPinnedNsisSilentInstallDoesNotAutoRun,
  assertWindowsNsisInstallerIdentity,
  assertWindowsProcessTreeExited,
  buildWindowsExactExecutableProcessQueryArguments,
  buildWindowsNsisInstallArguments,
  buildWindowsNsisUninstallArguments,
  buildWindowsNsisRegistryInspectionArguments,
  buildWindowsOwnedProcessSnapshotQueryArguments,
  defaultLaunchAndExercise,
  exerciseWindowsNsisLifecycleSmoke,
  ownedWindowsProcessTree,
  parseWindowsNsisLifecycleArguments,
  parseWindowsNsisRegistryInspectionResult,
  parseWindowsProcessSnapshot,
  runWindowsNsisLifecycleProgram,
  runWindowsNsisLifecycle,
  WINDOWS_NSIS_LIFECYCLE_INSTALL_REGISTRY_SUBKEY,
  WINDOWS_NSIS_LIFECYCLE_EXPECTED_PATH_ENVIRONMENT_KEY,
  WINDOWS_NSIS_LIFECYCLE_UNINSTALL_REGISTRY_SUBKEY,
} from "../scripts/smoke-electron-windows-nsis-lifecycle.mjs";

const revision = "a".repeat(40);
const qualificationRunId = "550e8400-e29b-41d4-a716-446655440000";
const installerDigest = Object.freeze({ bytes: 123, sha256: "b".repeat(64) });
const installedIdentity = Object.freeze({
  sourceRevision: revision,
  artifactSha256: "c".repeat(64),
  executableSha256: "d".repeat(64),
});

function packageReceipt(installerName = "TiboTattle-Dev-0.1.18-win-x64.exe") {
  return {
    schemaVersion: "tibotattle-electron-development-package-v1",
    sourceRevision: revision,
    target: "win32-x64",
    format: "distribution",
    status: "development_package_verified",
    runtimeExecuted: false,
    signed: false,
    published: false,
    updaterEnabled: false,
    installedLifecycleQualified: false,
    distributions: [{ file: installerName, ...installerDigest }],
  };
}

function profile(root) {
  const underRoot = (name) => join(root, name);
  return Object.freeze({
    root,
    userData: underRoot("user-data"),
    home: underRoot("home"),
    appdata: underRoot("appdata"),
    localappdata: underRoot("localappdata"),
    codex: underRoot("codex"),
    claude: underRoot("claude"),
    state: underRoot("state"),
    config: underRoot("config"),
    data: underRoot("data"),
    cache: underRoot("cache"),
    runtime: underRoot("runtime"),
    tmp: underRoot("tmp"),
  });
}

const IN_PLACE_UNINSTALLER_CONTENT = "unchanged in-place uninstaller\n";

function runInPlaceUninstallerResidueScenario({
  root,
  receiptPath,
  mutate = async () => {},
  accountObservationStorageJourneyCompleted = true,
  waitForCleanupPoll,
  monotonicNow,
  uninstallPostconditionBudgetMs,
  uninstallProgramTerminationGraceMs,
  removeOwnedRoot,
}) {
  const ownedRoot = join(root, "owned");
  const installationRoot = join(ownedRoot, "app");
  const uninstallerPath = join(installationRoot, "Uninstall TiboTattle Dev.exe");
  const state = { registryQueries: 0, uninstallerInstallationRoot: null };
  const optionalDependencies = {};
  if (waitForCleanupPoll !== undefined) optionalDependencies.waitForCleanupPoll = waitForCleanupPoll;
  if (monotonicNow !== undefined) optionalDependencies.monotonicNow = monotonicNow;
  if (uninstallPostconditionBudgetMs !== undefined) {
    optionalDependencies.uninstallPostconditionBudgetMs = uninstallPostconditionBudgetMs;
  }
  if (uninstallProgramTerminationGraceMs !== undefined) {
    optionalDependencies.uninstallProgramTerminationGraceMs = uninstallProgramTerminationGraceMs;
  }
  if (removeOwnedRoot !== undefined) optionalDependencies.removeOwnedRoot = removeOwnedRoot;
  const operation = runWindowsNsisLifecycle({
    installerPath: join(root, "installer.exe"),
    stagedAppPath: join(root, "staged"),
    packageReceiptPath: join(root, "development-package.json"),
    sourceRevision: revision,
    receiptPath,
  }, {
    platform: "win32",
    architecture: "x64",
    environment: { GITHUB_ACTIONS: "true", RUNNER_TEMP: root, SystemRoot: "C:\\Windows" },
    verifyInstaller: async () => ({ sourceRevision: revision, installerBytes: 123, installerSha256: "b".repeat(64) }),
    verifySilentNsisTemplate: async () => true,
    createOwnedRoot: async () => ownedRoot,
    inspectRegistry: async () => {
      state.registryQueries += 1;
      return state.registryQueries === 2 ? "expected-v1" : "absent-v1";
    },
    executeInstaller: async () => {
      await mkdir(installationRoot, { recursive: true });
      await writeFile(uninstallerPath, IN_PLACE_UNINSTALLER_CONTENT);
      return { settled: true, succeeded: true };
    },
    verifyInstalledPackage: async () => installedIdentity,
    prepareProfile: async ({ profilePath }) => profile(profilePath),
    prepareFirstRun: async () => {},
    launchAndExercise: async ({ launchOrdinal }) => ({
      pid: launchOrdinal === 1 ? 1001 : 1002,
      observedProcessTreeExited: true,
      installedExecutableAbsentAtPreLaunchSnapshot: true,
      installedExecutableAbsentAtPostExitSnapshot: true,
      accountObservationStorageJourneyCompleted: typeof accountObservationStorageJourneyCompleted === "function"
        ? accountObservationStorageJourneyCompleted(launchOrdinal)
        : accountObservationStorageJourneyCompleted,
      storageJourneyCompleted: true,
    }),
    executeUninstaller: async ({ uninstallerPath: selectedUninstallerPath, installationRoot: selectedInstallationRoot }) => {
      assert.equal(selectedUninstallerPath, uninstallerPath);
      state.uninstallerInstallationRoot = selectedInstallationRoot;
      await mutate(installationRoot, uninstallerPath);
      return { settled: true, succeeded: true };
    },
    ...optionalDependencies,
  });
  return { operation, ownedRoot, installationRoot, uninstallerPath, state };
}

test("Windows NSIS lifecycle runner accepts only its five exact absolute inputs", () => {
  const argv = [
    "--installer", resolve("TiboTattle-Dev-0.1.18-win-x64.exe"),
    "--staged-app", resolve("staged"),
    "--package-receipt", resolve("development-package.json"),
    "--source-revision", revision,
    "--receipt", resolve("nsis-lifecycle.json"),
  ];
  assert.equal(parseWindowsNsisLifecycleArguments(argv).sourceRevision, revision);
  for (const invalid of [
    [],
    argv.slice(0, -1),
    [...argv, "--installer", resolve("other.exe")],
    [...argv, "--install-root", resolve("unsafe")],
    [...argv, "--signing-key", "not-allowed"],
    argv.map((value) => value === resolve("staged") ? "relative" : value),
  ]) {
    assert.throws(() => parseWindowsNsisLifecycleArguments(invalid), /ARGUMENT_INVALID/u);
  }
});

test("NSIS commands keep their exact installation root final and reject unsafe roots", () => {
  assert.deepEqual(
    buildWindowsNsisInstallArguments("C:\\runner\\tmp\\tibotattle-nsis\\app"),
    ["/S", "/D=C:\\runner\\tmp\\tibotattle-nsis\\app"],
  );
  assert.deepEqual(
    buildWindowsNsisUninstallArguments("C:\\runner\\tmp\\tibotattle-nsis\\app"),
    ["/S", "_?=C:\\runner\\tmp\\tibotattle-nsis\\app"],
  );
  for (const path of [
    "C:\\runner temp\\app",
    "C:\\runner\\quote\"\\app",
    "relative\\app",
    "C:relative\\app",
    "\\runner\\app",
    "C:\\runner\\..\\app",
  ]) {
    assert.throws(() => buildWindowsNsisInstallArguments(path), /INSTALL_ROOT_INVALID/u);
    assert.throws(() => buildWindowsNsisUninstallArguments(path), /INSTALL_ROOT_INVALID/u);
  }
});

test("pinned NSIS source proves a silent install cannot start the app without force-run", async () => {
  const packageRoot = resolve("trusted", "node_modules", "app-builder-lib");
  const packagePath = join(packageRoot, "package.json");
  const installSection = [
    "!ifdef ONE_CLICK",
    "  !ifdef RUN_AFTER_FINISH",
    "    ${ifNot} ${Silent}",
    "    ${orIf} ${isForceRun}",
    "      !insertmacro doStartApp",
    "    ${endIf}",
    "  !else",
    "    ${if} ${isForceRun}",
    "      !insertmacro doStartApp",
    "    ${endIf}",
    "  !endif",
    "  !insertmacro quitSuccess",
    "!else",
    "  ${if} ${isForceRun}",
    "  ${andIf} ${Silent}",
    "    !insertmacro doStartApp",
    "  ${endIf}",
    "!endif",
  ].join("\n");
  const target = 'scriptGenerator.flags(["updated", "force-run", "keep-shortcuts"]);';
  const multiUser = '!define /ifndef INSTALL_REGISTRY_KEY "Software\\${APP_GUID}"';
  const installer = [
    "!macro registryAddInstallInfo",
    '  WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"',
    "!macroend",
  ].join("\n");
  const installUtil = [
    "OneMoreAttempt:",
    "  ExecWait '\"$uninstallerFileName\" /S /KEEP_APP_DATA $0 _?=$installationDir' $R0",
  ].join("\n");
  const uninstaller = [
    "SetOutPath $TEMP",
    "RMDir /r $INSTDIR",
    'DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"',
    'DeleteRegKey SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}"',
  ].join("\n");
  await assert.doesNotReject(assertPinnedNsisSilentInstallDoesNotAutoRun({
    resolveModule: (specifier) => {
      assert.equal(specifier, "electron-builder");
      return "/trusted/node_modules/electron-builder/out/index.js";
    },
    createModuleRequire: () => ({
      resolve: (specifier) => {
        assert.equal(specifier, "app-builder-lib/package.json");
        return packagePath;
      },
    }),
    readText: async (path) => {
      if (path === packagePath) return JSON.stringify({ name: "app-builder-lib", version: "26.15.7" });
      if (path === join(packageRoot, "templates", "nsis", "installSection.nsh")) return installSection;
      if (path === join(packageRoot, "out", "targets", "nsis", "NsisTarget.js")) return target;
      if (path === join(packageRoot, "templates", "nsis", "multiUser.nsh")) return multiUser;
      if (path === join(packageRoot, "templates", "nsis", "include", "installer.nsh")) return installer;
      if (path === join(packageRoot, "templates", "nsis", "include", "installUtil.nsh")) return installUtil;
      if (path === join(packageRoot, "templates", "nsis", "uninstaller.nsh")) return uninstaller;
      throw new Error("unexpected source");
    },
  }));
  await assert.rejects(assertPinnedNsisSilentInstallDoesNotAutoRun({
    resolveModule: () => "/trusted/node_modules/electron-builder/out/index.js",
    createModuleRequire: () => ({ resolve: () => packagePath }),
    readText: async (path) => path.endsWith("package.json")
      ? JSON.stringify({ name: "app-builder-lib", version: "26.15.7" })
      : "missing force-run proof",
  }), /NSIS_TEMPLATE_UNVERIFIED/u);
});

test("registry and Windows process probes use fixed read-only PowerShell contracts", () => {
  const installationRoot = resolve("tibotattle-nsis-app");
  const registryArguments = buildWindowsNsisRegistryInspectionArguments(installationRoot);
  assert.equal(registryArguments.includes(installationRoot), false);
  assert.match(registryArguments[4], /Registry\]::CurrentUser\.OpenSubKey/u);
  assert.ok(registryArguments[4].includes(WINDOWS_NSIS_LIFECYCLE_INSTALL_REGISTRY_SUBKEY));
  assert.ok(registryArguments[4].includes(WINDOWS_NSIS_LIFECYCLE_UNINSTALL_REGISTRY_SUBKEY));
  assert.match(registryArguments[4], /\(\$null -eq \$installKey\) -and \(\$null -eq \$uninstallKey\)/u);
  assert.doesNotMatch(registryArguments[4], /\$uninstallKey\.GetValue/u);
  assert.match(registryArguments[4], new RegExp(WINDOWS_NSIS_LIFECYCLE_EXPECTED_PATH_ENVIRONMENT_KEY, "u"));
  assert.match(registryArguments[4], /ConvertTo-CanonicalLifecyclePath/u);
  assert.match(registryArguments[4], /\$observed=ConvertTo-CanonicalLifecyclePath\(\$value\)/u);
  assert.match(registryArguments[4], /TrimEnd\(\[System\.IO\.Path\]::DirectorySeparatorChar/u);
  assert.doesNotMatch(registryArguments[4], /\$args\[0\]/u);
  assert.doesNotMatch(registryArguments[4], /reg\.exe|Remove-Item|Set-Item/u);
  assert.equal(parseWindowsNsisRegistryInspectionResult("absent-v1"), "absent-v1");
  assert.equal(parseWindowsNsisRegistryInspectionResult("expected-v1"), "expected-v1");
  assert.equal(parseWindowsNsisRegistryInspectionResult("other-v1"), "other-v1");
  assert.throws(() => parseWindowsNsisRegistryInspectionResult("exit-one"), /REGISTRY_UNAVAILABLE/u);

  const appPath = join(installationRoot, "TiboTattle Dev.exe");
  const processArguments = buildWindowsExactExecutableProcessQueryArguments(appPath);
  assert.equal(processArguments.includes(appPath), false);
  assert.match(processArguments[4], /\[System\.Diagnostics\.Process\]::GetProcessesByName\('TiboTattle Dev'\)/u);
  assert.match(processArguments[4], /Import-Module -Name Microsoft\.PowerShell\.Utility -ErrorAction Stop/u);
  assert.match(processArguments[4], /\$process\.MainModule\.FileName/u);
  assert.match(processArguments[4], /\$process\.StartTime\.ToFileTimeUtc\(\)/u);
  assert.match(processArguments[4], /TiboTattleWindowsProcessSnapshot\]::Read/u);
  assert.match(processArguments[4], /\$process\.Dispose\(\)/u);
  assert.doesNotMatch(processArguments[4], /ParentProcessId=0/u);
  assert.doesNotMatch(processArguments[4], /Get-CimInstance|Win32_Process|WMI/u);
  assert.match(processArguments[4], new RegExp(WINDOWS_NSIS_LIFECYCLE_EXPECTED_PATH_ENVIRONMENT_KEY, "u"));
  assert.doesNotMatch(processArguments[4], /\$args\[0\]/u);
  assert.doesNotMatch(processArguments[4], /Remove-|Stop-Process|Start-Process/u);
  assert.throws(
    () => buildWindowsExactExecutableProcessQueryArguments(join(installationRoot, "other.exe")),
    /PROCESS_PROOF_UNAVAILABLE/u,
  );
  const normalCandidateArguments = buildWindowsExactExecutableProcessQueryArguments(
    join(installationRoot, "TiboTattle.exe"),
    { executableName: "TiboTattle.exe" },
  );
  assert.match(normalCandidateArguments[4], /GetProcessesByName\('TiboTattle'\)/u);
  assert.throws(
    () => buildWindowsExactExecutableProcessQueryArguments(
      join(installationRoot, "other.exe"),
      { executableName: "other.exe" },
    ),
    /PROCESS_PROOF_UNAVAILABLE/u,
  );

  const readySnapshotArguments = buildWindowsOwnedProcessSnapshotQueryArguments({ rootProcessId: 42 });
  assert.match(readySnapshotArguments[4], /Import-Module -Name Microsoft\.PowerShell\.Utility -ErrorAction Stop/u);
  assert.match(readySnapshotArguments[4], /CreateToolhelp32Snapshot/u);
  assert.match(readySnapshotArguments[4], /Process32First/u);
  assert.match(readySnapshotArguments[4], /Process32Next/u);
  assert.match(readySnapshotArguments[4], /OpenProcess/u);
  assert.match(readySnapshotArguments[4], /GetProcessTimes/u);
  assert.doesNotMatch(readySnapshotArguments[4], /Get-CimInstance|Win32_Process|WMI/u);
  assert.doesNotMatch(readySnapshotArguments[4], /Remove-|Stop-Process|Start-Process|taskkill/u);
  assert.match(readySnapshotArguments[4], /\[uint32\]42/u);
  const retainedSnapshotArguments = buildWindowsOwnedProcessSnapshotQueryArguments({
    retainedProcessIds: [42, 43],
  });
  assert.match(retainedSnapshotArguments[4], /\[uint32\[\]\]@\(42,43\)/u);
  assert.throws(
    () => buildWindowsOwnedProcessSnapshotQueryArguments({ rootProcessId: 0 }),
    /PROCESS_PROOF_UNAVAILABLE/u,
  );
  assert.throws(
    () => buildWindowsOwnedProcessSnapshotQueryArguments({ retainedProcessIds: [42, 42] }),
    /PROCESS_PROOF_UNAVAILABLE/u,
  );
});

test("read-only PowerShell probes receive only fixed child state", async () => {
  const expectedPath = resolve("tibotattle-nsis-probe-path");
  const systemRoot = resolve("synthetic-windows");
  const powerShell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const moduleDirectory = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules");
  const captured = [];
  const spawnProcess = (_command, _argumentsList, options) => {
    captured.push(options.env);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };
  await runWindowsNsisLifecycleProgram(resolve("powershell.exe"), ["-Command", "exit 0"], {
    timeoutMs: 100,
    environment: {
      SystemRoot: systemRoot,
      [WINDOWS_NSIS_LIFECYCLE_EXPECTED_PATH_ENVIRONMENT_KEY]: "/ambient/must-not-pass",
      PSModulePath: "/ambient/must-not-pass",
    },
  }, { spawnProcess });
  await runWindowsNsisLifecycleProgram(resolve("powershell.exe"), ["-Command", "exit 0"], {
    timeoutMs: 100,
    environment: { SystemRoot: systemRoot, PSModulePath: "/ambient/must-not-pass" },
    fixedProbePath: expectedPath,
  }, { spawnProcess });
  await runWindowsNsisLifecycleProgram(powerShell, ["-Command", "exit 0"], {
    timeoutMs: 100,
    captureOutput: true,
    environment: { SystemRoot: systemRoot, PSModulePath: "/ambient/must-not-pass" },
    fixedPowerShellUtilityModules: true,
  }, { spawnProcess });
  assert.equal(Object.hasOwn(captured[0], WINDOWS_NSIS_LIFECYCLE_EXPECTED_PATH_ENVIRONMENT_KEY), false);
  assert.equal(captured[1][WINDOWS_NSIS_LIFECYCLE_EXPECTED_PATH_ENVIRONMENT_KEY], expectedPath);
  assert.equal(Object.hasOwn(captured[0], "PSModulePath"), false);
  assert.equal(Object.hasOwn(captured[1], "PSModulePath"), false);
  assert.equal(captured[2].PSModulePath, moduleDirectory);
  await assert.rejects(
    runWindowsNsisLifecycleProgram(resolve("not-powershell.exe"), ["-Command", "exit 0"], {
      timeoutMs: 100,
      captureOutput: true,
      environment: { SystemRoot: systemRoot },
      fixedPowerShellUtilityModules: true,
    }, { spawnProcess }),
    /PROGRAM_INVALID/u,
  );
  await assert.rejects(
    runWindowsNsisLifecycleProgram(powerShell, ["-Command", "exit 0"], {
      timeoutMs: 100,
      environment: { SystemRoot: systemRoot },
      fixedPowerShellUtilityModules: true,
    }, { spawnProcess }),
    /PROGRAM_INVALID/u,
  );
});

test("Windows PowerShell fixed path probe rejects missing and malformed child values", {
  skip: process.platform !== "win32",
}, () => {
  const systemRoot = process.env.SystemRoot;
  assert.equal(typeof systemRoot, "string");
  const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const expectedPath = join(process.env.TEMP ?? systemRoot, "tibotattle-nsis-probe-path");
  const argumentsList = buildWindowsNsisRegistryInspectionArguments(expectedPath);
  const invoke = (value) => {
    const environment = { ...process.env };
    delete environment[WINDOWS_NSIS_LIFECYCLE_EXPECTED_PATH_ENVIRONMENT_KEY];
    if (value !== undefined) environment[WINDOWS_NSIS_LIFECYCLE_EXPECTED_PATH_ENVIRONMENT_KEY] = value;
    return spawnSync(executable, argumentsList, {
      encoding: "utf8",
      timeout: 20_000,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: environment,
    });
  };
  const valid = invoke(expectedPath);
  assert.equal(valid.error, undefined);
  assert.equal(valid.signal, null);
  assert.equal(valid.status, 0);
  assert.doesNotThrow(() => parseWindowsNsisRegistryInspectionResult(valid.stdout));
  for (const malformed of [undefined, "relative-path", "C:\\invalid|path"]) {
    const result = invoke(malformed);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  }
});

test("Windows hosted CI runs a closed .NET baseline and fixed Utility module probe", {
  skip: process.platform !== "win32" || process.arch !== "x64" || process.env.GITHUB_ACTIONS !== "true",
}, async () => {
  const systemRoot = process.env.SystemRoot;
  assert.equal(typeof systemRoot, "string");
  const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const invoke = (query, fixedPowerShellUtilityModules) => runWindowsNsisLifecycleProgram(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", query],
    {
      timeoutMs: 20_000,
      captureOutput: true,
      environment: process.env,
      fixedPowerShellUtilityModules,
    },
  );
  const dotNetResult = await invoke(
    "$ErrorActionPreference='Stop';[Console]::Out.Write('dotnet-v1')",
    false,
  );
  assert.equal(dotNetResult.settled, true);
  assert.equal(dotNetResult.timedOut, false);
  assert.equal(dotNetResult.exitCode, 0);
  assert.equal(dotNetResult.stdout, "dotnet-v1");
  const utilityResult = await invoke(
    "$ErrorActionPreference='Stop';Import-Module -Name Microsoft.PowerShell.Utility -ErrorAction Stop;$value=[pscustomobject]@{proof='utility-v1'};[Console]::Out.Write((ConvertTo-Json -InputObject $value -Compress))",
    true,
  );
  assert.equal(utilityResult.settled, true);
  assert.equal(utilityResult.timedOut, false);
  assert.equal(utilityResult.exitCode, 0);
  assert.equal(utilityResult.stdout, '{"proof":"utility-v1"}');
});

test("Windows hosted CI runs the narrow exact-executable proof in its closed child environment", {
  skip: process.platform !== "win32" || process.arch !== "x64" || process.env.GITHUB_ACTIONS !== "true",
}, async () => {
  const systemRoot = process.env.SystemRoot;
  const runnerTemp = process.env.RUNNER_TEMP;
  assert.equal(typeof systemRoot, "string");
  assert.equal(typeof runnerTemp, "string");
  const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // The generated child does not exist and is never created. The query still
  // receives it only through the runner's explicitly injected child variable.
  const expectedPath = join(
    runnerTemp,
    `tibotattle-nsis-exact-process-probe-${process.pid}`,
    "TiboTattle Dev.exe",
  );
  const result = await runWindowsNsisLifecycleProgram(
    executable,
    buildWindowsExactExecutableProcessQueryArguments(expectedPath),
    {
      timeoutMs: 20_000,
      captureOutput: true,
      environment: process.env,
      fixedProbePath: expectedPath,
      fixedPowerShellUtilityModules: true,
    },
  );
  assert.equal(result.settled, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(parseWindowsProcessSnapshot(result.stdout), []);
});

function waitForNativeFixtureExit(child, timeoutMs = 5_000) {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* Test failure below preserves no residue. */ }
      rejectExit(new Error("native fixture did not exit"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectExit(error);
    });
    child.once("close", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

test("Windows hosted CI runs Toolhelp ready and retained-process proofs with real identity metadata", {
  skip: process.platform !== "win32" || process.arch !== "x64" || process.env.GITHUB_ACTIONS !== "true",
}, async () => {
  const systemRoot = process.env.SystemRoot;
  assert.equal(typeof systemRoot, "string");
  const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const invokeSnapshot = async (argumentsList) => runWindowsNsisLifecycleProgram(
    executable,
    argumentsList,
    {
      timeoutMs: 20_000,
      captureOutput: true,
      environment: process.env,
      fixedPowerShellUtilityModules: true,
    },
  );
  const readyResult = await invokeSnapshot(
    buildWindowsOwnedProcessSnapshotQueryArguments({ rootProcessId: process.pid }),
  );
  assert.equal(readyResult.settled, true);
  assert.equal(readyResult.timedOut, false);
  assert.equal(readyResult.exitCode, 0);
  const readySnapshot = parseWindowsProcessSnapshot(readyResult.stdout);
  const testRunner = readySnapshot.find((entry) => entry.pid === process.pid);
  assert.ok(testRunner);
  assert.match(testRunner.creation, /^[0-9]+$/u);
  assert.ok(readySnapshot.some((entry) => entry.parentPid === process.pid));

  const fixture = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  let fixtureExited = false;
  const fixtureExit = waitForNativeFixtureExit(fixture, 20_000).then(() => {
    fixtureExited = true;
  });
  fixtureExit.catch(() => {});
  try {
    assert.ok(Number.isSafeInteger(fixture.pid) && fixture.pid > 0);
    const fixtureReady = await invokeSnapshot(
      buildWindowsOwnedProcessSnapshotQueryArguments({ rootProcessId: fixture.pid }),
    );
    assert.equal(fixtureReady.settled, true);
    assert.equal(fixtureReady.timedOut, false);
    assert.equal(fixtureReady.exitCode, 0);
    const fixtureSnapshot = parseWindowsProcessSnapshot(fixtureReady.stdout);
    const fixtureIdentity = fixtureSnapshot.find((entry) => entry.pid === fixture.pid);
    assert.ok(fixtureIdentity);
    assert.equal(fixtureIdentity.parentPid, process.pid);
    assert.match(fixtureIdentity.creation, /^[0-9]+$/u);

    fixture.kill();
    await fixtureExit;
    const retainedResult = await invokeSnapshot(
      buildWindowsOwnedProcessSnapshotQueryArguments({ retainedProcessIds: [fixtureIdentity.pid] }),
    );
    assert.equal(retainedResult.settled, true);
    assert.equal(retainedResult.timedOut, false);
    assert.equal(retainedResult.exitCode, 0);
    const retainedSnapshot = parseWindowsProcessSnapshot(retainedResult.stdout);
    assert.equal(retainedSnapshot.some((entry) => entry.pid === fixtureIdentity.pid
      && entry.creation === fixtureIdentity.creation), false);
  } finally {
    if (!fixtureExited) {
      try { fixture.kill(); } catch { /* Fixture cleanup is best effort after failure. */ }
      await fixtureExit.catch(() => {});
    }
  }
});

test("Windows hosted CI refuses an orphaned uninstall key before classifying a disposable installation", {
  skip: process.platform !== "win32" || process.arch !== "x64" || process.env.GITHUB_ACTIONS !== "true",
}, () => {
  const systemRoot = process.env.SystemRoot;
  const runnerTemp = process.env.RUNNER_TEMP;
  assert.equal(typeof systemRoot, "string");
  assert.equal(typeof runnerTemp, "string");
  const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const expectedPath = join(runnerTemp, "tibotattle-nsis-present-key-probe");
  const argumentsList = buildWindowsNsisRegistryInspectionArguments(expectedPath);
  const environment = {
    ...process.env,
    [WINDOWS_NSIS_LIFECYCLE_EXPECTED_PATH_ENVIRONMENT_KEY]: expectedPath,
  };
  const invoke = (argumentsForProgram) => spawnSync(executable, argumentsForProgram, {
    encoding: "utf8",
    timeout: 20_000,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: environment,
  });
  const inspect = () => invoke(argumentsList);
  const assertSuccess = (result) => {
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0);
  };
  const preexisting = inspect();
  assertSuccess(preexisting);
  // This test writes only a key proven absent in a disposable hosted runner.
  // It never replaces an existing development installation record.
  assert.equal(parseWindowsNsisRegistryInspectionResult(preexisting.stdout), "absent-v1");
  const expectedPathLookup = `[Environment]::GetEnvironmentVariable('${WINDOWS_NSIS_LIFECYCLE_EXPECTED_PATH_ENVIRONMENT_KEY}','Process')`;
  const markerName = "TiboTattleNsisLifecycleOwnedV1";
  const markerValue = "tibotattle-nsis-lifecycle-owned-v1";
  const createUninstall = [
    "$ErrorActionPreference='Stop';",
    `$subKey='${WINDOWS_NSIS_LIFECYCLE_UNINSTALL_REGISTRY_SUBKEY}';`,
    `$markerName='${markerName}';`,
    `$markerValue='${markerValue}';`,
    "$existing=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subKey,$false);",
    "if($null -ne $existing){try{throw 'preexisting'}finally{$existing.Dispose()}};",
    "$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($subKey,$true);",
    "if($null -eq $key){throw 'create'};",
    "try{$key.SetValue($markerName,$markerValue,[Microsoft.Win32.RegistryValueKind]::String)}finally{$key.Dispose()}",
  ].join("");
  const createInstall = [
    "$ErrorActionPreference='Stop';",
    `$subKey='${WINDOWS_NSIS_LIFECYCLE_INSTALL_REGISTRY_SUBKEY}';`,
    `$expected=${expectedPathLookup};`,
    "if($expected -isnot [string] -or [string]::IsNullOrWhiteSpace($expected) -or -not [System.IO.Path]::IsPathRooted($expected)){throw 'expected-path'};",
    "$existing=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subKey,$false);",
    "if($null -ne $existing){try{throw 'preexisting'}finally{$existing.Dispose()}};",
    "$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($subKey,$true);",
    "if($null -eq $key){throw 'create'};",
    "try{$key.SetValue('InstallLocation',$expected,[Microsoft.Win32.RegistryValueKind]::String)}finally{$key.Dispose()}",
  ].join("");
  const remove = [
    "$ErrorActionPreference='Stop';",
    `$expected=${expectedPathLookup};`,
    `$markerName='${markerName}';`,
    `$markerValue='${markerValue}';`,
    `$installSubKey='${WINDOWS_NSIS_LIFECYCLE_INSTALL_REGISTRY_SUBKEY}';`,
    `$uninstallSubKey='${WINDOWS_NSIS_LIFECYCLE_UNINSTALL_REGISTRY_SUBKEY}';`,
    "$uninstallKey=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($uninstallSubKey,$true);",
    "if($null -eq $uninstallKey){throw 'missing-uninstall'};",
    "try{$marker=$uninstallKey.GetValue($markerName,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);if($marker -cne $markerValue){throw 'uninstall-ownership'}}finally{$uninstallKey.Dispose()};",
    "$installKey=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($installSubKey,$true);",
    "if($null -ne $installKey){try{$value=$installKey.GetValue('InstallLocation',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);if($value -cne $expected){throw 'install-ownership'}}finally{$installKey.Dispose()};[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($installSubKey,$false)};",
    "[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($uninstallSubKey,$false)",
  ].join("");
  let ownedUninstall = false;
  try {
    const orphanSetup = invoke(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", createUninstall]);
    assertSuccess(orphanSetup);
    ownedUninstall = true;
    const orphaned = inspect();
    assertSuccess(orphaned);
    assert.equal(parseWindowsNsisRegistryInspectionResult(orphaned.stdout), "other-v1");
    const installSetup = invoke(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", createInstall]);
    assertSuccess(installSetup);
    const present = inspect();
    assertSuccess(present);
    assert.equal(parseWindowsNsisRegistryInspectionResult(present.stdout), "expected-v1");
  } finally {
    if (ownedUninstall) {
      const cleanup = invoke(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", remove]);
      assertSuccess(cleanup);
    }
  }
  const absent = inspect();
  assertSuccess(absent);
  assert.equal(parseWindowsNsisRegistryInspectionResult(absent.stdout), "absent-v1");
});

test("a non-closing installer process produces a bounded unsettled result", async () => {
  class NonClosingChild extends EventEmitter {
    constructor() {
      super();
      this.killCalls = 0;
      this.unrefCalls = 0;
    }

    kill() { this.killCalls += 1; }

    unref() { this.unrefCalls += 1; }
  }
  const child = new NonClosingChild();
  const result = await runWindowsNsisLifecycleProgram(resolve("installer.exe"), ["/S"], {
    timeoutMs: 5,
    environment: {},
  }, {
    spawnProcess: () => child,
    terminationGraceMs: 5,
  });
  assert.deepEqual(result, {
    exitCode: null,
    timedOut: true,
    settled: false,
    stdout: "",
  });
  assert.equal(child.killCalls, 1);
  assert.equal(child.unrefCalls, 1);

  class ClosingAfterDeadlineChild extends NonClosingChild {
    kill() {
      super.kill();
      this.emit("close", 0);
    }
  }
  const closingChild = new ClosingAfterDeadlineChild();
  const closedAfterDeadline = await runWindowsNsisLifecycleProgram(resolve("installer.exe"), ["/S"], {
    timeoutMs: 5,
    environment: {},
  }, {
    spawnProcess: () => closingChild,
    terminationGraceMs: 20,
  });
  assert.equal(closedAfterDeadline.timedOut, true);
  assert.equal(closedAfterDeadline.settled, false);
  assert.equal(closingChild.unrefCalls, 1);
});

test("installer identity requires the exact unsigned development distribution row", () => {
  const installerPath = resolve("TiboTattle-Dev-0.1.18-win-x64.exe");
  assert.deepEqual(assertWindowsNsisInstallerIdentity({
    receipt: packageReceipt(),
    sourceRevision: revision,
    installerPath,
    installer: installerDigest,
  }), {
    sourceRevision: revision,
    installerBytes: 123,
    installerSha256: "b".repeat(64),
  });
  for (const changed of [
    { signed: true },
    { installedLifecycleQualified: true },
    { distributions: [{ file: "other.exe", ...installerDigest }] },
    { distributions: [{ file: "TiboTattle-Dev-0.1.18-win-x64.exe", bytes: 124, sha256: "b".repeat(64) }] },
  ]) {
    assert.throws(() => assertWindowsNsisInstallerIdentity({
      receipt: { ...packageReceipt(), ...changed },
      sourceRevision: revision,
      installerPath,
      installer: installerDigest,
    }), /INSTALLER_IDENTITY_INVALID/u);
  }
});

test("process proof retains only the first app and its exact live descendants", () => {
  const snapshot = parseWindowsProcessSnapshot(JSON.stringify([
    { ProcessId: 100, ParentProcessId: 1, CreationDate: "one" },
    { ProcessId: 101, ParentProcessId: 100, CreationDate: "two" },
    { ProcessId: 102, ParentProcessId: 101, CreationDate: "three" },
    { ProcessId: 103, ParentProcessId: 1, CreationDate: "other" },
  ]));
  const tracked = ownedWindowsProcessTree(snapshot, 100);
  assert.deepEqual(tracked, [
    { pid: 100, creation: "one" },
    { pid: 101, creation: "two" },
    { pid: 102, creation: "three" },
  ]);
  assert.equal(assertWindowsProcessTreeExited(tracked, [
    { pid: 100, parentPid: 1, creation: "replacement" },
    { pid: 103, parentPid: 1, creation: "other" },
  ]), true);
  assert.throws(() => assertWindowsProcessTreeExited(tracked, [
    { pid: 101, parentPid: 1, creation: "two" },
  ]), /OWNED_PROCESS_REMAINS/u);
});

class FixedSmokeChild extends EventEmitter {
  constructor(pid = 404) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.stderr = new EventEmitter();
    this.stderr.setEncoding = () => {};
    this.commands = [];
  }

  send(message, callback) {
    this.commands.push(message.command);
    queueMicrotask(() => {
      if (message.command === "status-v1") {
        this.emit("message", {
          type: "windows-electron-smoke-v1",
          message: "state-v1",
          started: true,
          primary: true,
          window: true,
          visible: true,
          tray: true,
        });
      } else if (message.command === "accountless-storage-v1"
          || message.command === "account-observation-storage-v1") {
        this.emit("message", {
          type: "windows-electron-smoke-v1",
          message: "credential-v1",
          operation: message.command,
          status: "passed-v1",
        });
      } else if (message.command === "quit-v1") {
        this.emit("message", {
          type: "windows-electron-smoke-v1",
          message: "quit-v1",
          status: "accepted-v1",
        });
        this.exitCode = 0;
        this.emit("exit", 0, null);
      }
      callback?.(null);
    });
  }
}

test("lifecycle smoke establishes its ready proof before any storage or quit command", async () => {
  const child = new FixedSmokeChild();
  const sequence = [];
  const observations = {};
  const tracked = await exerciseWindowsNsisLifecycleSmoke(child, {
    observations,
    readyBarrier: async () => {
      sequence.push("ready-proof");
      return [{ pid: child.pid, creation: "ready" }];
    },
  });
  assert.deepEqual(tracked, [{ pid: child.pid, creation: "ready" }]);
  assert.deepEqual(child.commands, [
    "status-v1",
    "accountless-storage-v1",
    "account-observation-storage-v1",
    "quit-v1",
  ]);
  assert.equal(sequence[0], "ready-proof");
  assert.equal(observations.storagePassed, true);
  assert.equal(observations.accountObservationStoragePassed, true);
});

test("lifecycle smoke records a closed child-exit code at the ready private-IPC boundary", async () => {
  const child = new FixedSmokeChild(405);
  const firstLaunchDiagnostic = { phase: "not_reached", failureCode: null };
  child.send = (message, callback) => {
    child.commands.push(message.command);
    queueMicrotask(() => {
      child.exitCode = 1;
      child.emit("exit", 1, null);
      callback?.(null);
    });
  };
  await assert.rejects(exerciseWindowsNsisLifecycleSmoke(child, {
    firstLaunchDiagnostic,
    readyBarrier: async () => { throw new Error("must not reach ready proof"); },
  }), (error) => error?.code === "ELECTRON_WINDOWS_ACCOUNTLESS_SMOKE_CHILD_EXITED");
  assert.deepEqual(firstLaunchDiagnostic, {
    phase: "ready_private_ipc",
    failureCode: "ELECTRON_WINDOWS_ACCOUNTLESS_SMOKE_CHILD_EXITED",
  });
});

test("launch proof fences ready snapshot and rejects a lingering exact installed executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-nsis-launch-test-"));
  const appPath = join(root, "TiboTattle Dev.exe");
  const child = new FixedSmokeChild(505);
  const processCalls = [];
  const processRequestDetails = [];
  let spawnedEnvironment = null;
  let snapshots = 0;
  try {
    const result = await defaultLaunchAndExercise({
      appPath,
      profile: profile(join(root, "profile")),
      launchOrdinal: 1,
      qualificationRunId,
      environment: { SystemRoot: "C:\\Windows" },
      spawnApplication: (_command, _argumentsList, options) => {
        spawnedEnvironment = options.env;
        return child;
      },
      exercise: async (_child, { observations, readyBarrier }) => {
        child.emit("message", {
          type: "windows-electron-smoke-v1",
          message: "state-v1",
          started: true,
          primary: true,
          window: true,
          visible: true,
          tray: true,
        });
        const tracked = await readyBarrier();
        observations.storagePassed = true;
        observations.accountObservationStoragePassed = true;
        child.exitCode = 0;
        return tracked;
      },
      readProcessSnapshot: async ({ rootProcessId, retainedProcessIds }) => {
        processCalls.push("snapshot");
        processRequestDetails.push({ rootProcessId, retainedProcessIds });
        snapshots += 1;
        return snapshots === 1
          ? [{ pid: child.pid, parentPid: 1, creation: "started" }]
          : [];
      },
      readInstalledExecutableProcesses: async () => {
        processCalls.push("exact-executable");
        return [];
      },
      stopChild: async () => true,
    });
    assert.equal(result.observedProcessTreeExited, true);
    assert.equal(result.installedExecutableAbsentAtPreLaunchSnapshot, true);
    assert.equal(result.installedExecutableAbsentAtPostExitSnapshot, true);
    assert.equal(result.accountObservationStorageJourneyCompleted, true);
    assert.deepEqual(processCalls, ["exact-executable", "snapshot", "snapshot", "exact-executable"]);
    assert.deepEqual(processRequestDetails, [
      { rootProcessId: child.pid, retainedProcessIds: null },
      { rootProcessId: null, retainedProcessIds: [child.pid] },
    ]);
    assert.equal(spawnedEnvironment.USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID, qualificationRunId);
    assert.equal(
      spawnedEnvironment[WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_LIFECYCLE_PHASE_ENVIRONMENT_KEY],
      WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_LIFECYCLE_FIRST_PHASE,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("second top-level launch binds the existing lifecycle run ID to restart-read only", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-nsis-second-launch-phase-test-"));
  const appPath = join(root, "TiboTattle Dev.exe");
  const child = new FixedSmokeChild(506);
  let snapshots = 0;
  let spawnedEnvironment = null;
  try {
    await defaultLaunchAndExercise({
      appPath,
      profile: profile(join(root, "profile")),
      launchOrdinal: 2,
      qualificationRunId,
      environment: { SystemRoot: "C:\\Windows" },
      spawnApplication: (_command, _argumentsList, options) => {
        spawnedEnvironment = options.env;
        return child;
      },
      exercise: async (_child, { observations, readyBarrier }) => {
        child.emit("message", {
          type: "windows-electron-smoke-v1",
          message: "state-v1",
          started: true,
          primary: true,
          window: true,
          visible: true,
          tray: true,
        });
        const tracked = await readyBarrier();
        observations.storagePassed = true;
        observations.accountObservationStoragePassed = true;
        child.exitCode = 0;
        return tracked;
      },
      readProcessSnapshot: async () => {
        snapshots += 1;
        return snapshots === 1 ? [{ pid: child.pid, parentPid: 1, creation: "started" }] : [];
      },
      readInstalledExecutableProcesses: async () => [],
      stopChild: async () => true,
    });
    assert.equal(spawnedEnvironment.USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID, qualificationRunId);
    assert.equal(
      spawnedEnvironment[WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_LIFECYCLE_PHASE_ENVIRONMENT_KEY],
      WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_LIFECYCLE_RESTART_PHASE,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launch proof refuses a later exact installed-executable process before the next launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-nsis-lingering-test-"));
  const appPath = join(root, "TiboTattle Dev.exe");
  const child = new FixedSmokeChild(606);
  let snapshots = 0;
  try {
    await assert.rejects(defaultLaunchAndExercise({
      appPath,
      profile: profile(join(root, "profile")),
      launchOrdinal: 1,
      qualificationRunId,
      environment: { SystemRoot: "C:\\Windows" },
      spawnApplication: () => child,
      exercise: async (_child, { observations, readyBarrier }) => {
        child.emit("message", {
          type: "windows-electron-smoke-v1",
          message: "state-v1",
          started: true,
          primary: true,
          window: true,
          visible: true,
          tray: true,
        });
        const tracked = await readyBarrier();
        observations.storagePassed = true;
        observations.accountObservationStoragePassed = true;
        child.exitCode = 0;
        return tracked;
      },
      readProcessSnapshot: async () => {
        snapshots += 1;
        return snapshots === 1 ? [{ pid: child.pid, parentPid: 1, creation: "started" }] : [];
      },
      readInstalledExecutableProcesses: async () => {
        const checks = snapshots;
        return checks === 0 ? [] : [{
          pid: 707,
          parentPid: 1,
          creation: "orphan",
        }];
      },
      stopChild: async () => true,
    }), /INSTALLED_EXECUTABLE_REMAINS/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launch refuses an exact installed executable at its immediate pre-spawn snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-nsis-prelaunch-test-"));
  const appPath = join(root, "TiboTattle Dev.exe");
  let launches = 0;
  try {
    await assert.rejects(defaultLaunchAndExercise({
      appPath,
      profile: profile(join(root, "profile")),
      launchOrdinal: 2,
      qualificationRunId,
      environment: { SystemRoot: "C:\\Windows" },
      spawnApplication: () => {
        launches += 1;
        return new FixedSmokeChild(707);
      },
      readInstalledExecutableProcesses: async () => [{
        pid: 606,
        parentPid: 1,
        creation: "still-running",
      }],
      stopChild: async () => true,
    }), /INSTALLED_EXECUTABLE_PRESENT_BEFORE_LAUNCH/u);
    assert.equal(launches, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle binds installed bytes, uses two distinct top-level processes in order, and writes a bounded receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-nsis-lifecycle-test-"));
  const receiptPath = join(root, "receipt.json");
  const ownedRoot = join(root, "owned");
  const installationRoot = join(ownedRoot, "app");
  const calls = [];
  let registryQueries = 0;
  let missingQueries = 0;
  try {
    const result = await runWindowsNsisLifecycle({
      installerPath: join(root, "TiboTattle-Dev-0.1.18-win-x64.exe"),
      stagedAppPath: join(root, "staged"),
      packageReceiptPath: join(root, "development-package.json"),
      sourceRevision: revision,
      receiptPath,
    }, {
      platform: "win32",
      architecture: "x64",
      environment: {
        GITHUB_ACTIONS: "true",
        RUNNER_TEMP: root,
        SystemRoot: "C:\\Windows",
      },
      verifyInstaller: async () => ({ sourceRevision: revision, installerBytes: 123, installerSha256: "b".repeat(64) }),
      verifySilentNsisTemplate: async () => true,
      createOwnedRoot: async () => ownedRoot,
      isMissing: async () => {
        missingQueries += 1;
        // The first post-uninstall observation sees the exact NSIS cleanup
        // still settling; the second proves the fixed root is gone.
        return missingQueries === 1 || missingQueries >= 3;
      },
      inspectRegistry: async () => {
        registryQueries += 1;
        if (registryQueries === 2 || registryQueries === 3) return "expected-v1";
        return "absent-v1";
      },
      executeInstaller: async ({ installerPath, installationRoot: destination }) => {
        calls.push(["install", installerPath, destination]);
        return { settled: true, succeeded: true };
      },
      assertUninstaller: async (path) => calls.push(["uninstaller", path]),
      verifyInstalledPackage: async (options) => {
        calls.push(["verify-installed", options.appPath, options.stagedAppPath]);
        return installedIdentity;
      },
      prepareProfile: async ({ appPath, profilePath }) => {
        calls.push(["profile", appPath, profilePath]);
        return profile(profilePath);
      },
      prepareFirstRun: async ({ profile: selected, stagedAppPath }) => {
        calls.push(["first-run", selected.root, stagedAppPath]);
      },
      launchAndExercise: async ({ appPath, profile: selected, launchOrdinal, qualificationRunId: selectedRunId }) => {
        calls.push(["launch", launchOrdinal, appPath, selected.root, selectedRunId]);
        return {
          pid: launchOrdinal === 1 ? 101 : 202,
          observedProcessTreeExited: true,
          installedExecutableAbsentAtPreLaunchSnapshot: true,
          installedExecutableAbsentAtPostExitSnapshot: true,
          accountObservationStorageJourneyCompleted: true,
          storageJourneyCompleted: true,
        };
      },
      executeUninstaller: async ({ uninstallerPath }) => {
        calls.push(["uninstall", uninstallerPath]);
        return { settled: true, succeeded: true };
      },
      removeOwnedRoot: async (path) => calls.push(["remove-root", path]),
      waitForCleanupPoll: async (milliseconds) => calls.push(["cleanup-poll", milliseconds]),
    });
    assert.deepEqual(result, {
      status: "passed",
      sourceRevision: revision,
      installerBytes: 123,
      installerSha256: "b".repeat(64),
      artifactSha256: "c".repeat(64),
      executableSha256: "d".repeat(64),
    });
    assert.deepEqual(calls.map(([name]) => name), [
      "install",
      "uninstaller",
      "profile",
      "first-run",
      "verify-installed",
      "launch",
      "verify-installed",
      "launch",
      "uninstall",
      "cleanup-poll",
      "remove-root",
    ]);
    const launchCalls = calls.filter(([name]) => name === "launch");
    assert.deepEqual(launchCalls.map((entry) => entry[1]), [1, 2]);
    assert.equal(launchCalls[0][4], launchCalls[1][4]);
    assert.match(launchCalls[0][4], /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
    assert.equal(calls.find(([name]) => name === "verify-installed")[1], join(installationRoot, "TiboTattle Dev.exe"));
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.topLevelLaunches, 2);
    assert.equal(receipt.topLevelProcessIdsDistinct, true);
    assert.equal(receipt.firstObservedApplicationProcessTreeExited, true);
    assert.equal(receipt.secondObservedApplicationProcessTreeExited, true);
    assert.equal(receipt.firstInstalledExecutableAbsentAtPreLaunchSnapshot, true);
    assert.equal(receipt.firstInstalledExecutableAbsentAtPostExitSnapshot, true);
    assert.equal(receipt.secondInstalledExecutableAbsentAtPreLaunchSnapshot, true);
    assert.equal(receipt.secondInstalledExecutableAbsentAtPostExitSnapshot, true);
    assert.equal(receipt.fullOwnedDescendantCleanupVerified, false);
    assert.equal(receipt.profileReusedAcrossLaunches, true);
    assert.equal(receipt.firstInstalledBytesVerified, true);
    assert.equal(receipt.secondInstalledBytesVerified, true);
    assert.equal(receipt.sameInstalledApplicationBytesBound, true);
    assert.equal(receipt.firstLaunchPhase, "completed");
    assert.equal(receipt.firstLaunchFailureCode, null);
    assert.equal(receipt.persistentApplicationCredentialStateVerified, false);
    assert.equal(receipt.syntheticAccountObservationCredentialReadAcrossTopLevelRelaunches, true);
    assert.equal(receipt.accountlessSyntheticRecordDeleted, true);
    assert.equal(receipt.accountObservationCredentialCleanup, "disposable_runner_account_lifetime");
    assert.equal(receipt.uninstallRegistryAbsent, true);
    assert.equal(receipt.postUninstallPhase, "both_predicates_absent");
    assert.equal(receipt.postUninstallFailureCode, null);
    assert.equal(receipt.cleanupConfirmed, true);
    assert.equal(receipt.productionReady, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("in-place NSIS residue cleanup removes only the unchanged generated uninstaller", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-nsis-in-place-residue-"));
  const receiptPath = join(root, "receipt.json");
  try {
    const scenario = runInPlaceUninstallerResidueScenario({ root, receiptPath });
    const result = await scenario.operation;
    assert.equal(scenario.state.uninstallerInstallationRoot, scenario.installationRoot);
    assert.equal(result.status, "passed");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.inPlaceUninstallerResidueRemoved, true);
    assert.equal(receipt.installRootAbsent, true);
    assert.equal(receipt.uninstallRegistryAbsent, true);
    assert.equal(receipt.cleanupConfirmed, true);
    await assert.rejects(lstat(scenario.uninstallerPath), { code: "ENOENT" });
    await assert.rejects(lstat(scenario.installationRoot), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("NSIS receipt keeps synthetic FD4 relaunch evidence unavailable when either launch lacks its closed acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-nsis-fd4-relaunch-test-"));
  const receiptPath = join(root, "receipt.json");
  try {
    const scenario = runInPlaceUninstallerResidueScenario({
      root,
      receiptPath,
      accountObservationStorageJourneyCompleted: (launchOrdinal) => launchOrdinal === 1,
    });
    await scenario.operation;
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.syntheticAccountObservationCredentialReadAcrossTopLevelRelaunches, false);
    assert.equal(receipt.persistentApplicationCredentialStateVerified, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("in-place NSIS residue cleanup refuses extra or changed entries", async (t) => {
  const cases = [
    {
      name: "extra entry",
      mutate: async (installationRoot, uninstallerPath) => {
        await writeFile(join(installationRoot, "unexpected.bin"), "unexpected\n");
      },
      verify: async (installationRoot, uninstallerPath) => {
        assert.equal(await readFile(join(installationRoot, "unexpected.bin"), "utf8"), "unexpected\n");
        assert.equal(await readFile(uninstallerPath, "utf8"), IN_PLACE_UNINSTALLER_CONTENT);
      },
    },
    {
      name: "changed uninstaller",
      mutate: async (_installationRoot, uninstallerPath) => {
        await writeFile(uninstallerPath, "replaced in-place uninstaller\n");
      },
      verify: async (_installationRoot, uninstallerPath) => {
        assert.equal(await readFile(uninstallerPath, "utf8"), "replaced in-place uninstaller\n");
      },
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-nsis-unsafe-residue-"));
      const receiptPath = join(root, "receipt.json");
      let rootRemovals = 0;
      try {
        const lifecycle = runInPlaceUninstallerResidueScenario({
          root,
          receiptPath,
          mutate: scenario.mutate,
          waitForCleanupPoll: async () => {},
          monotonicNow: () => 0,
          uninstallPostconditionBudgetMs: 10_001,
          uninstallProgramTerminationGraceMs: 10_000,
          removeOwnedRoot: async () => { rootRemovals += 1; },
        });
        await assert.rejects(lifecycle.operation, /UNINSTALLER_RESIDUE_UNSAFE/u);
        assert.equal(rootRemovals, 0);
        await scenario.verify(lifecycle.installationRoot, lifecycle.uninstallerPath);
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        assert.equal(receipt.inPlaceUninstallerResidueRemoved, false);
        assert.equal(receipt.installRootAbsent, false);
        // The boolean is the all-postconditions result; the fixed phase is
        // the content-free evidence that the registry was already absent.
        assert.equal(receipt.uninstallRegistryAbsent, false);
        assert.equal(receipt.postUninstallPhase, "install_root_present");
        assert.equal(receipt.cleanupConfirmed, false);
        assert.equal(receipt.errorCode, "ELECTRON_WINDOWS_NSIS_LIFECYCLE_UNINSTALLER_RESIDUE_UNSAFE");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("a first installed-launch failure retains its closed IPC code and phase in the receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-nsis-first-launch-diagnostic-"));
  const receiptPath = join(root, "receipt.json");
  const ownedRoot = join(root, "owned");
  let missingQueries = 0;
  let registryQueries = 0;
  try {
    await assert.rejects(runWindowsNsisLifecycle({
      installerPath: join(root, "installer.exe"),
      stagedAppPath: join(root, "staged"),
      packageReceiptPath: join(root, "development-package.json"),
      sourceRevision: revision,
      receiptPath,
    }, {
      platform: "win32",
      architecture: "x64",
      environment: { GITHUB_ACTIONS: "true", RUNNER_TEMP: root, SystemRoot: "C:\\Windows" },
      verifyInstaller: async () => ({ sourceRevision: revision, installerBytes: 123, installerSha256: "b".repeat(64) }),
      verifySilentNsisTemplate: async () => true,
      createOwnedRoot: async () => ownedRoot,
      isMissing: async () => {
        missingQueries += 1;
        return missingQueries === 1 || missingQueries >= 3;
      },
      inspectRegistry: async () => {
        registryQueries += 1;
        return registryQueries === 1 || registryQueries >= 4 ? "absent-v1" : "expected-v1";
      },
      executeInstaller: async () => ({ settled: true, succeeded: true }),
      assertUninstaller: async () => {},
      verifyInstalledPackage: async () => installedIdentity,
      prepareProfile: async ({ profilePath }) => profile(profilePath),
      prepareFirstRun: async () => {},
      launchAndExercise: async ({ firstLaunchDiagnostic }) => {
        firstLaunchDiagnostic.phase = "ready_private_ipc";
        firstLaunchDiagnostic.failureCode = "ELECTRON_WINDOWS_ACCOUNTLESS_SMOKE_NOT_ALLOWLISTED";
        firstLaunchDiagnostic.observations = {
          entryFailureObserved: true,
          statusResponseObserved: true,
          storageRequested: false,
          storagePassed: false,
          accountObservationStorageRequested: false,
          accountObservationStoragePassed: false,
          accountObservationFailureStage: "child_create",
          quitAcknowledged: false,
          sendFailureCode: "EPIPE",
        };
        const error = new Error("ELECTRON_WINDOWS_ACCOUNTLESS_SMOKE_CHILD_EXITED");
        error.code = "ELECTRON_WINDOWS_ACCOUNTLESS_SMOKE_CHILD_EXITED";
        throw error;
      },
      executeUninstaller: async () => ({ settled: true, succeeded: true }),
      removeOwnedRoot: async () => {},
    }), /ELECTRON_WINDOWS_NSIS_LIFECYCLE_FAILED/u);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.errorCode, "ELECTRON_WINDOWS_NSIS_LIFECYCLE_FAILED");
    assert.equal(receipt.firstLaunchPhase, "ready_private_ipc");
    assert.equal(receipt.firstLaunchFailureCode, "ELECTRON_WINDOWS_ACCOUNTLESS_SMOKE_CHILD_EXITED");
    assert.deepEqual(receipt.firstLaunchObservations, {
      entryFailureObserved: true,
      statusResponseObserved: true,
      storageRequested: false,
      storagePassed: false,
      accountObservationStorageRequested: false,
      accountObservationStoragePassed: false,
      accountObservationFailureStage: "child_create",
      quitAcknowledged: false,
      sendFailureCode: "EPIPE",
    });
    assert.equal(receipt.uninstallationPerformed, true);
    assert.equal(receipt.postUninstallPhase, "both_predicates_absent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a mismatched reverify refuses the second launch and preserves the first failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-nsis-reverify-test-"));
  const receiptPath = join(root, "receipt.json");
  const ownedRoot = join(root, "owned");
  let missingCalls = 0;
  let registryCalls = 0;
  let packageVerifications = 0;
  let launches = 0;
  let uninstallerRuns = 0;
  try {
    await assert.rejects(runWindowsNsisLifecycle({
      installerPath: join(root, "installer.exe"),
      stagedAppPath: join(root, "staged"),
      packageReceiptPath: join(root, "development-package.json"),
      sourceRevision: revision,
      receiptPath,
    }, {
      platform: "win32",
      architecture: "x64",
      environment: { GITHUB_ACTIONS: "true", RUNNER_TEMP: root, SystemRoot: "C:\\Windows" },
      verifyInstaller: async () => ({ sourceRevision: revision, installerBytes: 123, installerSha256: "b".repeat(64) }),
      verifySilentNsisTemplate: async () => true,
      createOwnedRoot: async () => ownedRoot,
      isMissing: async () => {
        missingCalls += 1;
        return missingCalls === 1 || missingCalls >= 3;
      },
      inspectRegistry: async () => {
        registryCalls += 1;
        return registryCalls === 1 || registryCalls >= 4 ? "absent-v1" : "expected-v1";
      },
      executeInstaller: async () => ({ settled: true, succeeded: true }),
      assertUninstaller: async () => {},
      verifyInstalledPackage: async () => {
        packageVerifications += 1;
        return packageVerifications === 1
          ? installedIdentity
          : { ...installedIdentity, artifactSha256: "e".repeat(64) };
      },
      prepareProfile: async ({ profilePath }) => profile(profilePath),
      prepareFirstRun: async () => {},
      launchAndExercise: async ({ launchOrdinal }) => {
        launches += 1;
        return {
          pid: launchOrdinal === 1 ? 111 : 222,
          observedProcessTreeExited: true,
          installedExecutableAbsentAtPreLaunchSnapshot: true,
          installedExecutableAbsentAtPostExitSnapshot: true,
          storageJourneyCompleted: true,
        };
      },
      executeUninstaller: async () => {
        uninstallerRuns += 1;
        return { settled: true, succeeded: true };
      },
      removeOwnedRoot: async () => {},
    }), /INSTALLED_PACKAGE_IDENTITY_INVALID/u);
    assert.equal(packageVerifications, 2);
    assert.equal(launches, 1);
    assert.equal(uninstallerRuns, 1);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.errorCode, "ELECTRON_WINDOWS_NSIS_LIFECYCLE_INSTALLED_PACKAGE_IDENTITY_INVALID");
    assert.equal(receipt.topLevelLaunches, 1);
    assert.equal(receipt.firstInstalledBytesVerified, true);
    assert.equal(receipt.secondInstalledBytesVerified, true);
    assert.equal(receipt.sameInstalledApplicationBytesBound, false);
    assert.equal(receipt.cleanupConfirmed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed uninstaller is terminal and retains its original cleanup uncertainty", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-nsis-uninstaller-failure-test-"));
  const receiptPath = join(root, "receipt.json");
  const ownedRoot = join(root, "owned");
  let registryCalls = 0;
  let uninstallerRuns = 0;
  let cleanupPolls = 0;
  let rootRemovals = 0;
  try {
    await assert.rejects(runWindowsNsisLifecycle({
      installerPath: join(root, "installer.exe"),
      stagedAppPath: join(root, "staged"),
      packageReceiptPath: join(root, "development-package.json"),
      sourceRevision: revision,
      receiptPath,
    }, {
      platform: "win32",
      architecture: "x64",
      environment: { GITHUB_ACTIONS: "true", RUNNER_TEMP: root, SystemRoot: "C:\\Windows" },
      verifyInstaller: async () => ({ sourceRevision: revision, installerBytes: 123, installerSha256: "b".repeat(64) }),
      verifySilentNsisTemplate: async () => true,
      createOwnedRoot: async () => ownedRoot,
      isMissing: async () => true,
      inspectRegistry: async () => {
        registryCalls += 1;
        return registryCalls === 1 ? "absent-v1" : "expected-v1";
      },
      executeInstaller: async () => ({ settled: true, succeeded: true }),
      assertUninstaller: async () => {},
      verifyInstalledPackage: async () => installedIdentity,
      prepareProfile: async ({ profilePath }) => profile(profilePath),
      prepareFirstRun: async () => {},
      launchAndExercise: async ({ launchOrdinal }) => ({
        pid: launchOrdinal === 1 ? 333 : 444,
        observedProcessTreeExited: true,
        installedExecutableAbsentAtPreLaunchSnapshot: true,
        installedExecutableAbsentAtPostExitSnapshot: true,
        storageJourneyCompleted: true,
      }),
      executeUninstaller: async () => {
        uninstallerRuns += 1;
        return { settled: true, succeeded: false };
      },
      waitForCleanupPoll: async () => { cleanupPolls += 1; },
      removeOwnedRoot: async () => { rootRemovals += 1; },
    }), /UNINSTALLER_FAILED/u);
    assert.equal(uninstallerRuns, 1);
    assert.equal(cleanupPolls, 0);
    assert.equal(rootRemovals, 0);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.errorCode, "ELECTRON_WINDOWS_NSIS_LIFECYCLE_UNINSTALLER_FAILED");
    assert.equal(receipt.uninstallationAttempted, true);
    assert.equal(receipt.uninstallationPerformed, false);
    assert.equal(receipt.cleanupVerificationSkippedBecauseOperationUnsettled, true);
    assert.equal(receipt.cleanupConfirmed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("post-uninstall polling uses one monotonic budget across fixed probes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-nsis-postcondition-budget-test-"));
  const receiptPath = join(root, "receipt.json");
  const ownedRoot = join(root, "owned");
  let now = 0;
  let missingCalls = 0;
  let registryCalls = 0;
  const postconditionTimeouts = [];
  const cleanupPolls = [];
  try {
    await assert.rejects(runWindowsNsisLifecycle({
      installerPath: join(root, "installer.exe"),
      stagedAppPath: join(root, "staged"),
      packageReceiptPath: join(root, "development-package.json"),
      sourceRevision: revision,
      receiptPath,
    }, {
      platform: "win32",
      architecture: "x64",
      environment: { GITHUB_ACTIONS: "true", RUNNER_TEMP: root, SystemRoot: "C:\\Windows" },
      verifyInstaller: async () => ({ sourceRevision: revision, installerBytes: 123, installerSha256: "b".repeat(64) }),
      verifySilentNsisTemplate: async () => true,
      createOwnedRoot: async () => ownedRoot,
      isMissing: async () => {
        missingCalls += 1;
        return missingCalls === 1;
      },
      inspectRegistry: async ({ timeoutMs } = {}) => {
        registryCalls += 1;
        if (timeoutMs !== undefined) {
          postconditionTimeouts.push(timeoutMs);
          now += 11;
        }
        return registryCalls === 1 ? "absent-v1" : "expected-v1";
      },
      executeInstaller: async () => ({ settled: true, succeeded: true }),
      assertUninstaller: async () => {},
      verifyInstalledPackage: async () => installedIdentity,
      prepareProfile: async ({ profilePath }) => profile(profilePath),
      prepareFirstRun: async () => {},
      launchAndExercise: async ({ launchOrdinal }) => ({
        pid: launchOrdinal === 1 ? 555 : 666,
        observedProcessTreeExited: true,
        installedExecutableAbsentAtPreLaunchSnapshot: true,
        installedExecutableAbsentAtPostExitSnapshot: true,
        storageJourneyCompleted: true,
      }),
      executeUninstaller: async () => ({ settled: true, succeeded: true }),
      waitForCleanupPoll: async (milliseconds) => {
        cleanupPolls.push(milliseconds);
        now += milliseconds;
      },
      monotonicNow: () => now,
      uninstallPostconditionBudgetMs: 10_010,
      uninstallProgramTerminationGraceMs: 10_000,
      removeOwnedRoot: async () => { throw new Error("must not remove on unconfirmed cleanup"); },
    }), /CLEANUP_UNCONFIRMED/u);
    assert.deepEqual(postconditionTimeouts, [10]);
    assert.deepEqual(cleanupPolls, [250]);
    assert.equal(registryCalls, 3);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.cleanupConfirmed, false);
    assert.equal(receipt.installRootAbsent, false);
    assert.equal(receipt.uninstallRegistryAbsent, false);
    assert.equal(receipt.postUninstallPhase, "both_predicates_present");
    assert.equal(
      receipt.postUninstallFailureCode,
      "ELECTRON_WINDOWS_NSIS_LIFECYCLE_POST_UNINSTALL_PREDICATES_PRESENT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default post-uninstall budget leaves the full registry timeout before its termination grace", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-nsis-postcondition-default-budget-test-"));
  const receiptPath = join(root, "receipt.json");
  const ownedRoot = join(root, "owned");
  let registryCalls = 0;
  let removedRoots = 0;
  const postconditionTimeouts = [];
  try {
    await assert.rejects(runWindowsNsisLifecycle({
      installerPath: join(root, "installer.exe"),
      stagedAppPath: join(root, "staged"),
      packageReceiptPath: join(root, "development-package.json"),
      sourceRevision: revision,
      receiptPath,
    }, {
      platform: "win32",
      architecture: "x64",
      environment: { GITHUB_ACTIONS: "true", RUNNER_TEMP: root, SystemRoot: "C:\\Windows" },
      verifyInstaller: async () => ({ sourceRevision: revision, installerBytes: 123, installerSha256: "b".repeat(64) }),
      verifySilentNsisTemplate: async () => true,
      createOwnedRoot: async () => ownedRoot,
      isMissing: async () => true,
      inspectRegistry: async ({ timeoutMs } = {}) => {
        registryCalls += 1;
        if (timeoutMs === undefined) return registryCalls === 1 ? "absent-v1" : "expected-v1";
        postconditionTimeouts.push(timeoutMs);
        throw Object.assign(new Error("synthetic registry timeout"), {
          postUninstallRegistryProbeFailureCode:
            "ELECTRON_WINDOWS_NSIS_LIFECYCLE_POST_UNINSTALL_REGISTRY_PROBE_TIMED_OUT",
        });
      },
      executeInstaller: async () => ({ settled: true, succeeded: true }),
      assertUninstaller: async () => {},
      verifyInstalledPackage: async () => installedIdentity,
      prepareProfile: async ({ profilePath }) => profile(profilePath),
      prepareFirstRun: async () => {},
      launchAndExercise: async ({ launchOrdinal }) => ({
        pid: launchOrdinal === 1 ? 901 : 902,
        observedProcessTreeExited: true,
        installedExecutableAbsentAtPreLaunchSnapshot: true,
        installedExecutableAbsentAtPostExitSnapshot: true,
        storageJourneyCompleted: true,
      }),
      executeUninstaller: async () => ({ settled: true, succeeded: true }),
      monotonicNow: () => 0,
      removeOwnedRoot: async () => { removedRoots += 1; },
    }), /CLEANUP_UNCONFIRMED/u);
    assert.deepEqual(postconditionTimeouts, [20_000]);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.postUninstallPhase, "uninstall_registry_probe_unavailable");
    assert.equal(
      receipt.postUninstallFailureCode,
      "ELECTRON_WINDOWS_NSIS_LIFECYCLE_POST_UNINSTALL_REGISTRY_PROBE_TIMED_OUT",
    );
    assert.equal(receipt.cleanupConfirmed, false);
    assert.equal(receipt.ownedTemporaryRootRemoved, false);
    assert.equal(removedRoots, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("post-uninstall receipts isolate fixed probe failures without releasing the owned root", async (t) => {
  const registryProbeScenario = (name, result, failureCode) => ({
    name,
    phase: "uninstall_registry_probe_unavailable",
    failureCode,
    isMissing: async () => true,
    runProgram: (() => {
      let calls = 0;
      return async () => {
        calls += 1;
        if (calls === 1) {
          return { settled: true, timedOut: false, exitCode: 0, stdout: "absent-v1" };
        }
        if (calls === 2) {
          return { settled: true, timedOut: false, exitCode: 0, stdout: "expected-v1" };
        }
        return result;
      };
    })(),
  });
  const scenarios = [
    {
      name: "install-root read",
      phase: "install_root_probe_unavailable",
      failureCode: "ELECTRON_WINDOWS_NSIS_LIFECYCLE_POST_UNINSTALL_INSTALL_ROOT_PROBE_UNAVAILABLE",
      isMissing: (() => {
        let calls = 0;
        return async () => {
          calls += 1;
          if (calls === 2) throw new Error("synthetic missing-path refusal");
          return true;
        };
      })(),
      inspectRegistry: (() => {
        let calls = 0;
        return async () => {
          calls += 1;
          return calls === 1 ? "absent-v1" : "expected-v1";
        };
      })(),
    },
    registryProbeScenario(
      "registry timeout",
      { settled: false, timedOut: true, exitCode: null, stdout: "" },
      "ELECTRON_WINDOWS_NSIS_LIFECYCLE_POST_UNINSTALL_REGISTRY_PROBE_TIMED_OUT",
    ),
    registryProbeScenario(
      "unsettled registry child",
      { settled: false, timedOut: false, exitCode: null, stdout: "" },
      "ELECTRON_WINDOWS_NSIS_LIFECYCLE_POST_UNINSTALL_REGISTRY_PROBE_UNSETTLED",
    ),
    registryProbeScenario(
      "registry child unavailable at start",
      { settled: true, timedOut: false, exitCode: null, stdout: "" },
      "ELECTRON_WINDOWS_NSIS_LIFECYCLE_POST_UNINSTALL_REGISTRY_PROBE_START_UNAVAILABLE",
    ),
    registryProbeScenario(
      "registry child nonzero exit",
      { settled: true, timedOut: false, exitCode: 1, stdout: "" },
      "ELECTRON_WINDOWS_NSIS_LIFECYCLE_POST_UNINSTALL_REGISTRY_PROBE_EXIT_NONZERO",
    ),
    registryProbeScenario(
      "registry child invalid output",
      { settled: true, timedOut: false, exitCode: 0, stdout: "invalid" },
      "ELECTRON_WINDOWS_NSIS_LIFECYCLE_POST_UNINSTALL_REGISTRY_PROBE_OUTPUT_INVALID",
    ),
    {
      name: "postcondition wait",
      phase: "postcondition_wait_unavailable",
      failureCode: "ELECTRON_WINDOWS_NSIS_LIFECYCLE_POST_UNINSTALL_WAIT_UNAVAILABLE",
      isMissing: (() => {
        let calls = 0;
        return async () => {
          calls += 1;
          return calls === 1;
        };
      })(),
      inspectRegistry: (() => {
        let calls = 0;
        return async () => {
          calls += 1;
          return calls === 1 ? "absent-v1" : "expected-v1";
        };
      })(),
      waitForCleanupPoll: async () => { throw new Error("synthetic wait refusal"); },
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-nsis-postcondition-diagnostic-test-"));
      const receiptPath = join(root, "receipt.json");
      const ownedRoot = join(root, "owned");
      let removedRoots = 0;
      try {
        await assert.rejects(runWindowsNsisLifecycle({
          installerPath: join(root, "installer.exe"),
          stagedAppPath: join(root, "staged"),
          packageReceiptPath: join(root, "development-package.json"),
          sourceRevision: revision,
          receiptPath,
        }, {
          platform: "win32",
          architecture: "x64",
          environment: { GITHUB_ACTIONS: "true", RUNNER_TEMP: root, SystemRoot: root },
          verifyInstaller: async () => ({ sourceRevision: revision, installerBytes: 123, installerSha256: "b".repeat(64) }),
          verifySilentNsisTemplate: async () => true,
          createOwnedRoot: async () => ownedRoot,
          isMissing: scenario.isMissing,
          ...(scenario.inspectRegistry ? { inspectRegistry: scenario.inspectRegistry } : {}),
          ...(scenario.runProgram ? { runProgram: scenario.runProgram } : {}),
          executeInstaller: async () => ({ settled: true, succeeded: true }),
          assertUninstaller: async () => {},
          verifyInstalledPackage: async () => installedIdentity,
          prepareProfile: async ({ profilePath }) => profile(profilePath),
          prepareFirstRun: async () => {},
          launchAndExercise: async ({ launchOrdinal }) => ({
            pid: launchOrdinal === 1 ? 777 : 888,
            observedProcessTreeExited: true,
            installedExecutableAbsentAtPreLaunchSnapshot: true,
            installedExecutableAbsentAtPostExitSnapshot: true,
            storageJourneyCompleted: true,
          }),
          executeUninstaller: async () => ({ settled: true, succeeded: true }),
          waitForCleanupPoll: scenario.waitForCleanupPoll ?? (async () => {}),
          removeOwnedRoot: async () => { removedRoots += 1; },
        }), /CLEANUP_UNCONFIRMED/u);
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        assert.equal(receipt.errorCode, "ELECTRON_WINDOWS_NSIS_LIFECYCLE_CLEANUP_UNCONFIRMED");
        assert.equal(receipt.installationPerformed, true);
        assert.equal(receipt.uninstallationPerformed, true);
        assert.equal(receipt.uninstallerSettled, true);
        assert.equal(receipt.topLevelLaunches, 2);
        assert.equal(receipt.postUninstallPhase, scenario.phase);
        assert.equal(receipt.postUninstallFailureCode, scenario.failureCode);
        assert.equal(receipt.cleanupConfirmed, false);
        assert.equal(receipt.ownedTemporaryRootRemoved, false);
        assert.equal(removedRoots, 0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("an identity refusal writes the fixed failure receipt before any installer action", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-nsis-lifecycle-refusal-"));
  const receiptPath = join(root, "receipt.json");
  let installerCalls = 0;
  try {
    await assert.rejects(runWindowsNsisLifecycle({
      installerPath: join(root, "installer.exe"),
      stagedAppPath: join(root, "staged"),
      packageReceiptPath: join(root, "development-package.json"),
      sourceRevision: revision,
      receiptPath,
    }, {
      platform: "win32",
      architecture: "x64",
      environment: { GITHUB_ACTIONS: "true", RUNNER_TEMP: root, SystemRoot: "C:\\Windows" },
      verifyInstaller: async () => {
        const error = new Error("refused");
        error.code = "ELECTRON_WINDOWS_NSIS_LIFECYCLE_INSTALLER_IDENTITY_INVALID";
        throw error;
      },
      executeInstaller: async () => { installerCalls += 1; },
    }), /INSTALLER_IDENTITY_INVALID/u);
    assert.equal(installerCalls, 0);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.errorCode, "ELECTRON_WINDOWS_NSIS_LIFECYCLE_INSTALLER_IDENTITY_INVALID");
    assert.equal(receipt.installationPerformed, false);
    assert.equal(receipt.accountlessSyntheticRecordDeleted, false);
    assert.equal(receipt.productionReady, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a repeated top-level PID refuses success and still runs the exact uninstaller cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-nsis-lifecycle-pid-"));
  const receiptPath = join(root, "receipt.json");
  const ownedRoot = join(root, "owned");
  const installationRoot = join(ownedRoot, "app");
  let registryQueries = 0;
  let duplicateIsMissingCalls = 0;
  let uninstallerRuns = 0;
  try {
    await assert.rejects(runWindowsNsisLifecycle({
      installerPath: join(root, "installer.exe"),
      stagedAppPath: join(root, "staged"),
      packageReceiptPath: join(root, "development-package.json"),
      sourceRevision: revision,
      receiptPath,
    }, {
      platform: "win32",
      architecture: "x64",
      environment: { GITHUB_ACTIONS: "true", RUNNER_TEMP: root, SystemRoot: "C:\\Windows" },
      verifyInstaller: async () => ({ sourceRevision: revision, installerBytes: 123, installerSha256: "b".repeat(64) }),
      verifySilentNsisTemplate: async () => true,
      createOwnedRoot: async () => ownedRoot,
      isMissing: async () => {
        const call = duplicateIsMissingCalls;
        duplicateIsMissingCalls += 1;
        // First call preflights the absent target. The installer then owns the
        // tree until its exact uninstaller settles it in finally.
        return call === 0 || call >= 2;
      },
      inspectRegistry: async () => {
        registryQueries += 1;
        return registryQueries === 2 ? "expected-v1" : "absent-v1";
      },
      executeInstaller: async () => ({ settled: true, succeeded: true }),
      assertUninstaller: async () => {},
      verifyInstalledPackage: async () => installedIdentity,
      prepareProfile: async ({ profilePath }) => profile(profilePath),
      prepareFirstRun: async () => {},
      launchAndExercise: async () => ({
        pid: 101,
        observedProcessTreeExited: true,
        installedExecutableAbsentAtPreLaunchSnapshot: true,
        installedExecutableAbsentAtPostExitSnapshot: true,
        storageJourneyCompleted: true,
      }),
      executeUninstaller: async () => {
        uninstallerRuns += 1;
        return { settled: true, succeeded: true };
      },
      removeOwnedRoot: async () => {},
    }), /APPLICATION_PID_REUSED/u);
    assert.equal(uninstallerRuns, 1);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.topLevelLaunches, 2);
    assert.equal(receipt.topLevelProcessIdsDistinct, false);
    assert.equal(receipt.uninstallationPerformed, true);
    assert.equal(receipt.uninstallRegistryAbsent, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unsettled installer retains its receipt and refuses competing cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-nsis-lifecycle-unsettled-"));
  const receiptPath = join(root, "receipt.json");
  const ownedRoot = join(root, "owned");
  let missingQueries = 0;
  let registryQueries = 0;
  let uninstallerRuns = 0;
  let rootRemovals = 0;
  try {
    await assert.rejects(runWindowsNsisLifecycle({
      installerPath: join(root, "installer.exe"),
      stagedAppPath: join(root, "staged"),
      packageReceiptPath: join(root, "development-package.json"),
      sourceRevision: revision,
      receiptPath,
    }, {
      platform: "win32",
      architecture: "x64",
      environment: { GITHUB_ACTIONS: "true", RUNNER_TEMP: root, SystemRoot: "C:\\Windows" },
      verifyInstaller: async () => ({ sourceRevision: revision, installerBytes: 123, installerSha256: "b".repeat(64) }),
      verifySilentNsisTemplate: async () => true,
      createOwnedRoot: async () => ownedRoot,
      isMissing: async () => {
        missingQueries += 1;
        return true;
      },
      inspectRegistry: async () => {
        registryQueries += 1;
        return "absent-v1";
      },
      executeInstaller: async () => ({ settled: false, succeeded: false }),
      assertUninstaller: async () => { throw new Error("must not run"); },
      executeUninstaller: async () => { uninstallerRuns += 1; return { settled: true, succeeded: true }; },
      removeOwnedRoot: async () => { rootRemovals += 1; },
    }), /INSTALLER_UNSETTLED/u);
    assert.equal(missingQueries, 1);
    assert.equal(registryQueries, 1);
    assert.equal(uninstallerRuns, 0);
    assert.equal(rootRemovals, 0);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.errorCode, "ELECTRON_WINDOWS_NSIS_LIFECYCLE_INSTALLER_UNSETTLED");
    assert.equal(receipt.installerSettled, false);
    assert.equal(receipt.cleanupVerificationSkippedBecauseOperationUnsettled, true);
    assert.equal(receipt.ownedTemporaryRootRemoved, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
