import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  assertPinnedNsisSilentInstallDoesNotAutoRun,
  assertWindowsNsisInstallerIdentity,
  assertWindowsProcessTreeExited,
  buildWindowsExactExecutableProcessQueryArguments,
  buildWindowsNsisInstallArguments,
  buildWindowsNsisRegistryInspectionArguments,
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
} from "../scripts/smoke-electron-windows-nsis-lifecycle.mjs";

const revision = "a".repeat(40);
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

test("NSIS command keeps /D final and rejects whitespace or quote-bearing install roots", () => {
  assert.deepEqual(
    buildWindowsNsisInstallArguments("C:\\runner\\tmp\\tibotattle-nsis\\app"),
    ["/S", "/D=C:\\runner\\tmp\\tibotattle-nsis\\app"],
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

test("registry and exact-executable probes use fixed read-only PowerShell contracts", () => {
  const installationRoot = resolve("tibotattle-nsis-app");
  const registryArguments = buildWindowsNsisRegistryInspectionArguments(installationRoot);
  assert.equal(registryArguments.includes(installationRoot), false);
  assert.match(registryArguments[4], /Registry\]::CurrentUser\.OpenSubKey/u);
  assert.ok(registryArguments[4].includes(WINDOWS_NSIS_LIFECYCLE_INSTALL_REGISTRY_SUBKEY));
  assert.doesNotMatch(registryArguments[4], /CurrentVersion\\Uninstall/u);
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
  assert.match(processArguments[4], /Get-CimInstance Win32_Process/u);
  assert.match(processArguments[4], new RegExp(WINDOWS_NSIS_LIFECYCLE_EXPECTED_PATH_ENVIRONMENT_KEY, "u"));
  assert.doesNotMatch(processArguments[4], /\$args\[0\]/u);
  assert.doesNotMatch(processArguments[4], /Remove-|Stop-Process|Start-Process/u);
});

test("read-only PowerShell probes receive only an explicit fixed child path", async () => {
  const expectedPath = resolve("tibotattle-nsis-probe-path");
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
      SystemRoot: "/synthetic/windows",
      [WINDOWS_NSIS_LIFECYCLE_EXPECTED_PATH_ENVIRONMENT_KEY]: "/ambient/must-not-pass",
    },
  }, { spawnProcess });
  await runWindowsNsisLifecycleProgram(resolve("powershell.exe"), ["-Command", "exit 0"], {
    timeoutMs: 100,
    environment: { SystemRoot: "/synthetic/windows" },
    fixedProbePath: expectedPath,
  }, { spawnProcess });
  assert.equal(Object.hasOwn(captured[0], WINDOWS_NSIS_LIFECYCLE_EXPECTED_PATH_ENVIRONMENT_KEY), false);
  assert.equal(captured[1][WINDOWS_NSIS_LIFECYCLE_EXPECTED_PATH_ENVIRONMENT_KEY], expectedPath);
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

test("Windows hosted CI classifies a disposable present install-location key", {
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
  const create = [
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
    `$subKey='${WINDOWS_NSIS_LIFECYCLE_INSTALL_REGISTRY_SUBKEY}';`,
    `$expected=${expectedPathLookup};`,
    "$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subKey,$true);",
    "if($null -eq $key){throw 'missing'};",
    "try{$value=$key.GetValue('InstallLocation',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);if($value -cne $expected){throw 'ownership'}}finally{$key.Dispose()};",
    "[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($subKey,$false)",
  ].join("");
  let created = false;
  try {
    const setup = invoke(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", create]);
    assertSuccess(setup);
    created = true;
    const present = inspect();
    assertSuccess(present);
    assert.equal(parseWindowsNsisRegistryInspectionResult(present.stdout), "expected-v1");
  } finally {
    if (created) {
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

test("launch proof fences ready snapshot and rejects a lingering exact installed executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-nsis-launch-test-"));
  const appPath = join(root, "TiboTattle Dev.exe");
  const child = new FixedSmokeChild(505);
  const processCalls = [];
  let snapshots = 0;
  try {
    const result = await defaultLaunchAndExercise({
      appPath,
      profile: profile(join(root, "profile")),
      launchOrdinal: 1,
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
        processCalls.push("snapshot");
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
    assert.deepEqual(processCalls, ["exact-executable", "snapshot", "snapshot", "exact-executable"]);
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
      launchAndExercise: async ({ appPath, profile: selected, launchOrdinal }) => {
        calls.push(["launch", launchOrdinal, appPath, selected.root]);
        return {
          pid: launchOrdinal === 1 ? 101 : 202,
          observedProcessTreeExited: true,
          installedExecutableAbsentAtPreLaunchSnapshot: true,
          installedExecutableAbsentAtPostExitSnapshot: true,
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
    assert.deepEqual(calls.filter(([name]) => name === "launch").map((entry) => entry[1]), [1, 2]);
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
    assert.equal(receipt.persistentApplicationCredentialStateVerified, false);
    assert.equal(receipt.accountlessSyntheticRecordDeleted, true);
    assert.equal(receipt.accountObservationCredentialCleanup, "disposable_runner_account_lifetime");
    assert.equal(receipt.uninstallRegistryAbsent, true);
    assert.equal(receipt.cleanupConfirmed, true);
    assert.equal(receipt.productionReady, false);
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
  } finally {
    await rm(root, { recursive: true, force: true });
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
