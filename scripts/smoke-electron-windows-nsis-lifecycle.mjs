#!/usr/bin/env node

// Disposable hosted-runner proof for an unsigned Windows development installer.
// It never signs, enables production selection, or accepts a user-selected
// install location. The only NSIS /D target is a new private child of
// RUNNER_TEMP. The receipt keeps application credential persistence unproven:
// the accountless FD3 journey deletes its synthetic record, while the
// observation credential is scoped to the disposable runner account lifetime.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  createWindowsAccountlessSmokeProtocol,
  observeWindowsSmokeStderr,
  prepareWindowsAccountlessSmokeFirstRunAcknowledgementForTest,
  verifyWindowsAccountlessSmokePackage,
} from "./smoke-electron-windows-accountless.mjs";
import {
  buildWindowsDevelopmentLaunchSpec,
  prepareWindowsDevelopmentProfile,
} from "./launch-electron-windows-development.mjs";

const PREFIX = "ELECTRON_WINDOWS_NSIS_LIFECYCLE_";
const require = createRequire(import.meta.url);
const REVISION = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const APP_EXECUTABLE = "TiboTattle Dev.exe";
const UNINSTALLER = "Uninstall TiboTattle Dev.exe";
const APP_BUILDER_LIB_VERSION = "26.15.7";
// UUID v5(appId, electron-builder's pinned NSIS namespace) for the fixed
// development appId com.adamallcock.tibotattle.electron.dev. This runner
// checks it only; it never creates, repairs, or removes registry entries.
const UNINSTALL_REGISTRY_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\962AD905-00AD-56CE-85F1-F2541D787AC7";
const PROCESS_SNAPSHOT_TIMEOUT_MS = 20_000;
const INSTALLER_TIMEOUT_MS = 180_000;
const UNINSTALLER_TIMEOUT_MS = 120_000;
const PROCESS_CLEANUP_TIMEOUT_MS = 10_000;
const PROGRAM_TERMINATION_GRACE_MS = 10_000;
const UNINSTALL_POSTCONDITION_ATTEMPTS = 40;
const UNINSTALL_POSTCONDITION_INTERVAL_MS = 250;
const UNINSTALL_POSTCONDITION_BUDGET_MS = 20_000;
const PROGRAM_OUTPUT_LIMIT_BYTES = 64 * 1024;
const REGISTRY_ABSENT = "absent-v1";
const REGISTRY_EXPECTED = "expected-v1";
const REGISTRY_OTHER = "other-v1";
// This value is injected only into the two fixed read-only PowerShell probes.
// It is deliberately not inherited from the parent environment by any child.
export const WINDOWS_NSIS_LIFECYCLE_EXPECTED_PATH_ENVIRONMENT_KEY =
  "TIBOTATTLE_NSIS_LIFECYCLE_EXPECTED_PATH_V1";
const INSTALLER_ENVIRONMENT_KEYS = Object.freeze([
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATH",
  "PATHEXT",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
  "NUMBER_OF_PROCESSORS",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "ProgramData",
  "ProgramFiles",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramW6432",
]);

function fail(code) {
  const fixed = `${PREFIX}${code}`;
  throw Object.assign(new Error(fixed), { code: fixed });
}

function fixedCode(error) {
  return /^ELECTRON_WINDOWS_NSIS_LIFECYCLE_[A-Z_]+$/u.test(error?.code ?? "")
    ? error.code
    : `${PREFIX}FAILED`;
}

function validAbsolutePath(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4096
    && !value.includes("\0")
    && isAbsolute(value);
}

function validDigest(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Number.isSafeInteger(value.bytes)
    && value.bytes > 0
    && SHA256.test(value.sha256 ?? "");
}

function fixedError(code) {
  const error = new Error(`${PREFIX}${code}`);
  error.code = error.message;
  return error;
}

function assertLifecycleOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).length !== 5
      || !validAbsolutePath(options.installerPath)
      || !validAbsolutePath(options.stagedAppPath)
      || !validAbsolutePath(options.packageReceiptPath)
      || !validAbsolutePath(options.receiptPath)
      || !REVISION.test(options.sourceRevision ?? "")) {
    fail("ARGUMENT_INVALID");
  }
  return Object.freeze({ ...options });
}

export function parseWindowsNsisLifecycleArguments(argv) {
  const names = new Map([
    ["--installer", "installerPath"],
    ["--staged-app", "stagedAppPath"],
    ["--package-receipt", "packageReceiptPath"],
    ["--source-revision", "sourceRevision"],
    ["--receipt", "receiptPath"],
  ]);
  if (!Array.isArray(argv)) fail("ARGUMENT_INVALID");
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = names.get(argv[index]);
    const value = argv[index + 1];
    if (!key || Object.hasOwn(result, key) || typeof value !== "string" || !value
        || value.includes("\0")) {
      fail("ARGUMENT_INVALID");
    }
    if (key === "sourceRevision" ? !REVISION.test(value) : !validAbsolutePath(value)) {
      fail("ARGUMENT_INVALID");
    }
    result[key] = value;
  }
  if (Object.keys(result).length !== names.size) fail("ARGUMENT_INVALID");
  return Object.freeze(result);
}

/** The special NSIS /D switch is final and receives a closed, space-free path. */
export function buildWindowsNsisInstallArguments(installationRoot) {
  const normalized = typeof installationRoot === "string"
    ? win32.resolve(installationRoot)
    : "";
  if (!/^[A-Za-z]:\\(?:[A-Za-z0-9._-]+\\)*[A-Za-z0-9._-]+$/u.test(normalized)) {
    fail("INSTALL_ROOT_INVALID");
  }
  return Object.freeze(["/S", `/D=${normalized}`]);
}

/**
 * The lifecycle runner must be the first controlled application launch. This
 * source check binds that assumption to the exact pinned NSIS template: its
 * silent branch reaches StartApp only for the explicit force-run flag, which
 * our closed install arguments do not contain.
 */
export async function assertPinnedNsisSilentInstallDoesNotAutoRun({
  resolveModule = (specifier) => require.resolve(specifier),
  createModuleRequire = createRequire,
  readText = (path) => readFile(path, "utf8"),
} = {}) {
  if (typeof resolveModule !== "function" || typeof createModuleRequire !== "function"
      || typeof readText !== "function") {
    fail("NSIS_TEMPLATE_UNVERIFIED");
  }
  let packagePath;
  try {
    // app-builder-lib is a transitive dependency of our direct
    // electron-builder install. Resolve from that package rather than relying
    // on a hoisted transitive dependency in pnpm's isolated layout.
    const electronBuilderEntry = resolveModule("electron-builder");
    packagePath = createModuleRequire(electronBuilderEntry).resolve("app-builder-lib/package.json");
  } catch {
    fail("NSIS_TEMPLATE_UNVERIFIED");
  }
  if (!validAbsolutePath(packagePath)) fail("NSIS_TEMPLATE_UNVERIFIED");
  const packageRoot = dirname(packagePath);
  let metadata;
  let installSection;
  let targetSource;
  try {
    [metadata, installSection, targetSource] = await Promise.all([
      readText(packagePath),
      readText(join(packageRoot, "templates", "nsis", "installSection.nsh")),
      readText(join(packageRoot, "out", "targets", "nsis", "NsisTarget.js")),
    ]);
    metadata = JSON.parse(metadata);
  } catch {
    fail("NSIS_TEMPLATE_UNVERIFIED");
  }
  if (metadata?.name !== "app-builder-lib" || metadata.version !== APP_BUILDER_LIB_VERSION
      || typeof installSection !== "string" || typeof targetSource !== "string"
      // The generator must reserve force-run as an explicit command-line
      // switch, rather than making it a default installer action.
      || !/\.flags\(\["updated",\s*"force-run"/u.test(targetSource)
      // One-click installers start only when non-silent or force-run; this
      // runner is silent and supplies neither force-run spelling.
      || !/!ifdef ONE_CLICK[\s\S]*?!ifdef RUN_AFTER_FINISH[\s\S]*?\$\{ifNot\}\s+\$\{Silent\}[\s\S]*?\$\{orIf\}\s+\$\{isForceRun\}[\s\S]*?!insertmacro doStartApp[\s\S]*?!else[\s\S]*?\$\{if\}\s+\$\{isForceRun\}[\s\S]*?!insertmacro doStartApp[\s\S]*?!endif[\s\S]*?!insertmacro quitSuccess/u.test(installSection)
      // Assisted installers likewise require force-run in their silent path.
      || !/!else[\s\S]*?\$\{if\}\s+\$\{isForceRun\}[\s\S]*?\$\{andIf\}\s+\$\{Silent\}[\s\S]*?!insertmacro doStartApp/u.test(installSection)) {
    fail("NSIS_TEMPLATE_UNVERIFIED");
  }
  const argumentsForEmptyRoot = buildWindowsNsisInstallArguments("C:\\runner\\tmp\\app");
  if (argumentsForEmptyRoot.length !== 2 || argumentsForEmptyRoot.some((value) => /force-run/iu.test(value))) {
    fail("NSIS_TEMPLATE_UNVERIFIED");
  }
  return true;
}

/** Bind the selected NSIS executable to the exact unsigned development receipt. */
export function assertWindowsNsisInstallerIdentity({
  receipt,
  sourceRevision,
  installerPath,
  installer,
} = {}) {
  if (!REVISION.test(sourceRevision ?? "")
      || receipt === null
      || typeof receipt !== "object"
      || Array.isArray(receipt)
      || receipt.schemaVersion !== "tibotattle-electron-development-package-v1"
      || receipt.sourceRevision !== sourceRevision
      || receipt.target !== "win32-x64"
      || receipt.format !== "distribution"
      || receipt.status !== "development_package_verified"
      || receipt.runtimeExecuted !== false
      || receipt.signed !== false
      || receipt.published !== false
      || receipt.updaterEnabled !== false
      || receipt.installedLifecycleQualified !== false
      || !validDigest(installer)
      || typeof installerPath !== "string") {
    fail("INSTALLER_IDENTITY_INVALID");
  }
  const installerName = basename(installerPath);
  if (!installerName.endsWith(".exe")) fail("INSTALLER_IDENTITY_INVALID");
  if (!Array.isArray(receipt.distributions)) fail("INSTALLER_IDENTITY_INVALID");
  const matches = receipt.distributions.filter((entry) => entry !== null
    && typeof entry === "object"
    && !Array.isArray(entry)
    && entry.file === installerName
    && validDigest(entry));
  if (matches.length !== 1
      || matches[0].bytes !== installer.bytes
      || matches[0].sha256 !== installer.sha256) {
    fail("INSTALLER_IDENTITY_INVALID");
  }
  return Object.freeze({
    sourceRevision,
    installerBytes: installer.bytes,
    installerSha256: installer.sha256,
  });
}

export function parseWindowsProcessSnapshot(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > PROGRAM_OUTPUT_LIMIT_BYTES) {
    fail("PROCESS_PROOF_UNAVAILABLE");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("PROCESS_PROOF_UNAVAILABLE");
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const pid = entry?.ProcessId;
    const parentPid = entry?.ParentProcessId;
    const creation = entry?.CreationDate;
    if (!Number.isSafeInteger(pid) || pid <= 0
        || !Number.isSafeInteger(parentPid) || parentPid < 0
        || typeof creation !== "string" || creation.length === 0 || creation.length > 256
        || creation.includes("\0")) {
      fail("PROCESS_PROOF_UNAVAILABLE");
    }
    const key = `${pid}:${creation}`;
    if (seen.has(key)) fail("PROCESS_PROOF_UNAVAILABLE");
    seen.add(key);
    result.push(Object.freeze({ pid, parentPid, creation }));
  }
  return Object.freeze(result);
}

export function ownedWindowsProcessTree(snapshot, rootPid) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || !Array.isArray(snapshot)) {
    fail("PROCESS_PROOF_UNAVAILABLE");
  }
  const byParent = new Map();
  let root = null;
  for (const entry of snapshot) {
    if (entry?.pid === rootPid) root = entry;
    const children = byParent.get(entry?.parentPid) ?? [];
    children.push(entry);
    byParent.set(entry?.parentPid, children);
  }
  if (root === null) fail("PROCESS_PROOF_UNAVAILABLE");
  const result = [];
  const pending = [root];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.shift();
    const key = `${current.pid}:${current.creation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(Object.freeze({ pid: current.pid, creation: current.creation }));
    for (const child of byParent.get(current.pid) ?? []) pending.push(child);
  }
  return Object.freeze(result);
}

export function assertWindowsProcessTreeExited(tracked, snapshot) {
  if (!Array.isArray(tracked) || !Array.isArray(snapshot)) fail("PROCESS_PROOF_UNAVAILABLE");
  for (const prior of tracked) {
    if (snapshot.some((current) => current?.pid === prior?.pid
        && current?.creation === prior?.creation)) {
      fail("OWNED_PROCESS_REMAINS");
    }
  }
  return true;
}

async function regularFile(path, maxBytes = Infinity) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    fail("FILE_UNSAFE");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.size <= 0 || metadata.size > maxBytes) {
    fail("FILE_UNSAFE");
  }
  return metadata;
}

async function digestRegularFile(path) {
  const metadata = await regularFile(path);
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    if (bytes !== metadata.size) fail("FILE_CHANGED");
    return Object.freeze({ bytes, sha256: hash.digest("hex") });
  } finally {
    await handle.close();
  }
}

async function defaultVerifyInstaller(options) {
  if (dirname(resolve(options.installerPath)) !== dirname(resolve(options.packageReceiptPath))) {
    fail("INSTALLER_IDENTITY_INVALID");
  }
  await regularFile(options.packageReceiptPath, 256 * 1024);
  let receipt;
  try {
    receipt = JSON.parse(await readFile(options.packageReceiptPath, "utf8"));
  } catch {
    fail("INSTALLER_IDENTITY_INVALID");
  }
  return assertWindowsNsisInstallerIdentity({
    receipt,
    sourceRevision: options.sourceRevision,
    installerPath: options.installerPath,
    installer: await digestRegularFile(options.installerPath),
  });
}

async function pathMissing(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    fail("PATH_UNAVAILABLE");
  }
}

async function defaultCreateOwnedRoot(runnerTemp) {
  let base;
  try {
    base = resolve(runnerTemp);
    const metadata = await lstat(base);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("RUNNER_TEMP_INVALID");
  } catch (error) {
    if (error?.code === `${PREFIX}RUNNER_TEMP_INVALID`) throw error;
    fail("RUNNER_TEMP_INVALID");
  }
  const root = await mkdtemp(join(base, "tibotattle-nsis-lifecycle-"));
  const direct = relative(base, root);
  if (!direct || direct.includes("..") || direct.includes("/") || direct.includes("\\")
      || !/^[A-Za-z0-9._-]+$/u.test(direct)) {
    fail("OWNED_ROOT_INVALID");
  }
  try {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("OWNED_ROOT_INVALID");
  } catch (error) {
    if (error?.code === `${PREFIX}OWNED_ROOT_INVALID`) throw error;
    fail("OWNED_ROOT_INVALID");
  }
  return root;
}

function selectedInstallerEnvironment(environment, fixedProbePath = null) {
  const selected = {};
  for (const key of INSTALLER_ENVIRONMENT_KEYS) {
    const value = environment?.[key];
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) {
      selected[key] = value;
    }
  }
  // Do not forward an ambient value with this name. Only the fixed read-only
  // probe call below can add its prevalidated path to a child environment.
  if (fixedProbePath !== null) {
    if (!validAbsolutePath(fixedProbePath)) fail("PROGRAM_INVALID");
    selected[WINDOWS_NSIS_LIFECYCLE_EXPECTED_PATH_ENVIRONMENT_KEY] = fixedProbePath;
  }
  return selected;
}

function validProgramResult(value, captureOutput = false) {
  return value !== null
    && typeof value === "object"
    && (value.exitCode === null || Number.isInteger(value.exitCode))
    && typeof value.timedOut === "boolean"
    && typeof value.settled === "boolean"
    && (!captureOutput || typeof value.stdout === "string");
}

function programExecutionOutcome(result) {
  if (!validProgramResult(result)) {
    return Object.freeze({ settled: false, succeeded: false });
  }
  return Object.freeze({
    settled: result.settled,
    succeeded: result.settled && !result.timedOut && result.exitCode === 0,
  });
}

function assertProgramExecutionOutcome(value, stage) {
  if (value === null || typeof value !== "object"
      || typeof value.settled !== "boolean" || typeof value.succeeded !== "boolean") {
    fail(`${stage}_UNSETTLED`);
  }
  return value;
}

export async function runWindowsNsisLifecycleProgram(command, args, {
  timeoutMs,
  captureOutput = false,
  environment = process.env,
  fixedProbePath = null,
} = {}, {
  spawnProcess = spawn,
  terminationGraceMs = PROGRAM_TERMINATION_GRACE_MS,
} = {}) {
  if (!validAbsolutePath(command) || !Array.isArray(args)
      || args.some((value) => typeof value !== "string" || value.includes("\0"))
      || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
      || (fixedProbePath !== null && !validAbsolutePath(fixedProbePath))
      || typeof spawnProcess !== "function"
      || !Number.isSafeInteger(terminationGraceMs) || terminationGraceMs <= 0) {
    fail("PROGRAM_INVALID");
  }
  return new Promise((resolveProgram) => {
    let child;
    try {
      child = spawnProcess(command, args, {
        shell: false,
        windowsHide: true,
        env: selectedInstallerEnvironment(environment, fixedProbePath),
        stdio: captureOutput ? ["ignore", "pipe", "ignore"] : "ignore",
      });
    } catch {
      resolveProgram(Object.freeze({ exitCode: null, timedOut: false, settled: true, stdout: "" }));
      return;
    }
    let stdout = "";
    let overflow = false;
    if (captureOutput) {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        if (overflow) return;
        stdout += chunk;
        if (stdout.length > PROGRAM_OUTPUT_LIMIT_BYTES) {
          overflow = true;
          stdout = "";
        }
      });
    }
    let delivered = false;
    let timedOut = false;
    let deadlineTimer = null;
    let terminationTimer = null;
    const finish = (exitCode, settled) => {
      if (delivered) return;
      delivered = true;
      clearTimeout(deadlineTimer);
      clearTimeout(terminationTimer);
      // Once the deadline fired, even a later child close cannot prove that a
      // self-extracting installer did not leave a temporary clone behind.
      // Treat the whole operation as unsettled so no cleanup races it.
      const operationSettled = settled && !timedOut;
      if (!operationSettled) {
        // The installer may still own files or registry state. Detach only so
        // this evidence runner can return its failed receipt; its caller
        // refuses all cleanup while this operation remains unsettled.
        child.stdout?.destroy();
        child.unref?.();
      }
      resolveProgram(Object.freeze({
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        timedOut,
        settled: operationSettled,
        stdout: captureOutput && !overflow ? stdout : "",
      }));
    };
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* bounded grace resolves the fixed result. */ }
      if (!delivered) {
        terminationTimer = setTimeout(() => finish(null, false), terminationGraceMs);
      }
    }, timeoutMs);
    child.once("error", () => finish(null, true));
    child.once("close", (code) => finish(code, true));
  });
}

const defaultRunProgram = runWindowsNsisLifecycleProgram;

function systemExecutable(environment, relativePath) {
  const root = environment?.SystemRoot;
  if (!validAbsolutePath(root) || root.includes("\0")) fail("SYSTEM_ROOT_INVALID");
  return join(root, ...relativePath);
}

export function parseWindowsNsisRegistryInspectionResult(output) {
  if (typeof output !== "string" || output.length === 0
      || output.length > PROGRAM_OUTPUT_LIMIT_BYTES) {
    fail("REGISTRY_UNAVAILABLE");
  }
  if (output === REGISTRY_ABSENT || output === REGISTRY_EXPECTED || output === REGISTRY_OTHER) {
    return output;
  }
  fail("REGISTRY_UNAVAILABLE");
}

function fixedPowerShellExpectedPathPrelude() {
  return `function ConvertTo-CanonicalLifecyclePath([string]$path){$full=[System.IO.Path]::GetFullPath($path);$root=[System.IO.Path]::GetPathRoot($full);if([string]::IsNullOrWhiteSpace($root) -or -not [System.IO.Path]::IsPathRooted($full)){throw 'expected-path'};if($full.Length -gt $root.Length){return $full.TrimEnd([System.IO.Path]::DirectorySeparatorChar,[System.IO.Path]::AltDirectorySeparatorChar)};return $full};$expectedPathRaw=[Environment]::GetEnvironmentVariable('${WINDOWS_NSIS_LIFECYCLE_EXPECTED_PATH_ENVIRONMENT_KEY}','Process');if($expectedPathRaw -isnot [string] -or [string]::IsNullOrWhiteSpace($expectedPathRaw) -or -not [System.IO.Path]::IsPathRooted($expectedPathRaw)){throw 'expected-path'};$expected=ConvertTo-CanonicalLifecyclePath($expectedPathRaw);`;
}

/** A fixed, read-only Registry API probe with no raw registry value in stdout. */
export function buildWindowsNsisRegistryInspectionArguments(expectedInstallationRoot) {
  if (!validAbsolutePath(expectedInstallationRoot)) fail("REGISTRY_UNAVAILABLE");
  const query = `$ErrorActionPreference='Stop';${fixedPowerShellExpectedPathPrelude()}$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\962AD905-00AD-56CE-85F1-F2541D787AC7',$false);if($null -eq $key){[Console]::Out.Write('absent-v1');exit 0};try{$value=$key.GetValue('InstallLocation',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);if($value -isnot [string]){throw 'install-location'};$observed=ConvertTo-CanonicalLifecyclePath($value);if([string]::Equals($observed,$expected,[System.StringComparison]::OrdinalIgnoreCase)){[Console]::Out.Write('expected-v1')}else{[Console]::Out.Write('other-v1')}}finally{$key.Dispose()}`;
  return Object.freeze([
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    query,
  ]);
}

async function defaultInspectRegistry({
  environment,
  runProgram,
  expectedInstallationRoot,
  timeoutMs = PROCESS_SNAPSHOT_TIMEOUT_MS,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > PROCESS_SNAPSHOT_TIMEOUT_MS) {
    fail("REGISTRY_UNAVAILABLE");
  }
  const command = systemExecutable(environment, [
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  ]);
  const result = await runProgram(command, buildWindowsNsisRegistryInspectionArguments(expectedInstallationRoot), {
    timeoutMs,
    captureOutput: true,
    environment,
    fixedProbePath: expectedInstallationRoot,
  });
  if (!validProgramResult(result, true)) fail("REGISTRY_UNAVAILABLE");
  if (!result.settled || result.timedOut || result.exitCode !== 0) fail("REGISTRY_UNAVAILABLE");
  return parseWindowsNsisRegistryInspectionResult(result.stdout);
}

async function defaultExecuteInstaller({ installerPath, installationRoot, environment, runProgram }) {
  const result = await runProgram(installerPath, buildWindowsNsisInstallArguments(installationRoot), {
    timeoutMs: INSTALLER_TIMEOUT_MS,
    environment,
  });
  return programExecutionOutcome(result);
}

async function defaultAssertUninstaller(uninstallerPath) {
  await regularFile(uninstallerPath);
}

async function defaultExecuteUninstaller({ uninstallerPath, environment, runProgram }) {
  const result = await runProgram(uninstallerPath, ["/S"], {
    timeoutMs: UNINSTALLER_TIMEOUT_MS,
    environment,
  });
  return programExecutionOutcome(result);
}

async function defaultReadWindowsProcessSnapshot({ environment, runProgram }) {
  const command = systemExecutable(environment, [
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  ]);
  // This fixed read-only query returns only PID, parent PID, and creation time.
  // It receives no caller data and emits no executable path or environment.
  const query = "$ErrorActionPreference='Stop';$rows=@(Get-CimInstance Win32_Process|Where-Object {$null -ne $_.CreationDate}|Select-Object ProcessId,ParentProcessId,CreationDate);[Console]::Out.Write(($rows|ConvertTo-Json -Compress -Depth 2))";
  const result = await runProgram(command, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    query,
  ], {
    timeoutMs: PROCESS_SNAPSHOT_TIMEOUT_MS,
    captureOutput: true,
    environment,
  });
  if (!validProgramResult(result, true) || !result.settled || result.timedOut || result.exitCode !== 0) {
    fail("PROCESS_PROOF_UNAVAILABLE");
  }
  return parseWindowsProcessSnapshot(result.stdout);
}

/**
 * Ask WMI only whether the exact installed Electron executable remains. The
 * app path is a fixed, validated child-only environment value, never
 * interpolated into the command or copied from the parent environment.
 * Output deliberately keeps paths out of receipts and logs.
 */
export function buildWindowsExactExecutableProcessQueryArguments(appPath) {
  if (!validAbsolutePath(appPath)) fail("PROCESS_PROOF_UNAVAILABLE");
  const query = `$ErrorActionPreference='Stop';${fixedPowerShellExpectedPathPrelude()}$rows=@(Get-CimInstance Win32_Process|Where-Object {$null -ne $_.CreationDate -and $null -ne $_.ExecutablePath -and [string]::Equals($_.ExecutablePath,$expected,[System.StringComparison]::OrdinalIgnoreCase)}|Select-Object ProcessId,ParentProcessId,CreationDate);[Console]::Out.Write((ConvertTo-Json -InputObject @($rows) -Compress -Depth 2))`;
  return Object.freeze([
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    query,
  ]);
}

async function defaultReadInstalledExecutableProcesses({ appPath, environment, runProgram }) {
  const command = systemExecutable(environment, [
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  ]);
  const result = await runProgram(command, buildWindowsExactExecutableProcessQueryArguments(appPath), {
    timeoutMs: PROCESS_SNAPSHOT_TIMEOUT_MS,
    captureOutput: true,
    environment,
    fixedProbePath: appPath,
  });
  if (!validProgramResult(result, true) || !result.settled || result.timedOut || result.exitCode !== 0) {
    fail("PROCESS_PROOF_UNAVAILABLE");
  }
  return parseWindowsProcessSnapshot(result.stdout);
}

function waitForChildExit(child, timeoutMs) {
  if (child?.exitCode !== null || child?.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child?.off?.("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child?.once?.("exit", onExit);
  });
}

async function defaultStopOwnedChild(child, { environment, runProgram }) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return false;
  const command = systemExecutable(environment, ["System32", "taskkill.exe"]);
  const result = await runProgram(command, ["/PID", String(child.pid), "/T", "/F"], {
    timeoutMs: PROCESS_CLEANUP_TIMEOUT_MS,
    environment,
  });
  if (!validProgramResult(result) || !result.settled || result.timedOut || result.exitCode !== 0) {
    return false;
  }
  return waitForChildExit(child, PROCESS_CLEANUP_TIMEOUT_MS);
}

function observeOwnedProcessTreeAtReady(child, readSnapshot) {
  let settled = false;
  let snapshotStarted = false;
  let resolveTracked;
  let rejectTracked;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolveTracked = resolvePromise;
    rejectTracked = rejectPromise;
  });
  // A failing lifecycle may exit before the first ready response. Attach a
  // rejection handler immediately so its later cleanup cannot create an
  // unhandled rejection while the primary error is being retained in receipt.
  promise.catch(() => {});
  const settle = (error, value) => {
    if (settled) return;
    settled = true;
    if (error) rejectTracked(error); else resolveTracked(value);
  };
  const onMessage = (message) => {
    if (message?.type !== "windows-electron-smoke-v1"
        || message?.message !== "state-v1"
        || message.started !== true
        || message.primary !== true
        || message.window !== true
        || message.tray !== true
        || !Number.isSafeInteger(child?.pid)
        || child.pid <= 0) {
      return;
    }
    if (snapshotStarted) return;
    snapshotStarted = true;
    Promise.resolve(readSnapshot())
      .then((snapshot) => settle(null, ownedWindowsProcessTree(snapshot, child.pid)))
      .catch(() => settle(fixedError("PROCESS_PROOF_UNAVAILABLE")));
  };
  const onEnded = () => settle(fixedError("PROCESS_PROOF_UNAVAILABLE"));
  child.on("message", onMessage);
  child.once("error", onEnded);
  child.once("exit", onEnded);
  return Object.freeze({
    wait: () => promise,
    close() {
      child.off("message", onMessage);
      child.off("error", onEnded);
      child.off("exit", onEnded);
    },
  });
}

const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

/**
 * Reuse the fixed accountless protocol but fence its mutation and quit steps
 * behind the ready-time process snapshot. This prevents the app from exiting
 * before its first process-tree proof exists.
 */
export async function exerciseWindowsNsisLifecycleSmoke(child, {
  timeoutMs = 60_000,
  observations = null,
  readyBarrier,
} = {}) {
  if (typeof readyBarrier !== "function") fail("PROCESS_PROOF_UNAVAILABLE");
  const protocol = createWindowsAccountlessSmokeProtocol(child, { timeoutMs, observations });
  try {
    const deadline = Date.now() + timeoutMs;
    let tracked = null;
    while (true) {
      const state = await protocol.request("status-v1");
      if (state.started && state.primary && state.window && state.tray) {
        tracked = await readyBarrier();
        if (!Array.isArray(tracked)) fail("PROCESS_PROOF_UNAVAILABLE");
        break;
      }
      if (Date.now() >= deadline) fail("APPLICATION_STARTUP_TIMEOUT");
      await delay(250);
    }
    if (observations) observations.storageRequested = true;
    await protocol.request("accountless-storage-v1");
    if (observations) observations.storagePassed = true;
    if (observations) observations.accountObservationStorageRequested = true;
    await protocol.request("account-observation-storage-v1");
    if (observations) observations.accountObservationStoragePassed = true;
    await protocol.request("quit-v1");
    if (observations) observations.quitAcknowledged = true;
    if (!await waitForChildExit(child, PROCESS_CLEANUP_TIMEOUT_MS)) fail("APPLICATION_QUIT_TIMEOUT");
    if (child.exitCode !== 0) fail("APPLICATION_CHILD_FAILED");
    return tracked;
  } finally {
    protocol.close();
  }
}

export async function defaultLaunchAndExercise({
  appPath,
  profile,
  launchOrdinal,
  environment,
  spawnApplication = spawn,
  exercise = exerciseWindowsNsisLifecycleSmoke,
  observeStderr = observeWindowsSmokeStderr,
  readProcessSnapshot = defaultReadWindowsProcessSnapshot,
  readInstalledExecutableProcesses = defaultReadInstalledExecutableProcesses,
  stopChild = defaultStopOwnedChild,
  runProgram = defaultRunProgram,
}) {
  const spec = buildWindowsDevelopmentLaunchSpec({ appPath, profile, environment });
  let child = null;
  let tracker = null;
  const observations = {
    entryFailureObserved: false,
    statusResponseObserved: false,
    storageRequested: false,
    storagePassed: false,
    accountObservationStorageRequested: false,
    accountObservationStoragePassed: false,
    accountObservationFailureStage: null,
    quitAcknowledged: false,
    sendFailureCode: null,
  };
  try {
    // This is a point-in-time read immediately before each top-level spawn.
    // It prevents a later launch from accepting an exact installed Electron
    // executable that survived the preceding lifecycle step.
    if ((await readInstalledExecutableProcesses({ appPath, environment, runProgram })).length !== 0) {
      fail("INSTALLED_EXECUTABLE_PRESENT_BEFORE_LAUNCH");
    }
    child = spawnApplication(spec.command, spec.args, {
      ...spec.options,
      env: {
        ...spec.options.env,
        GITHUB_ACTIONS: "true",
        USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "windows-v1",
        USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION: "windows-account-observation-fd4-v1",
        USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID: randomUUID(),
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) fail("APPLICATION_LAUNCH_UNAVAILABLE");
    observeStderr(child.stderr, observations);
    tracker = observeOwnedProcessTreeAtReady(
      child,
      () => readProcessSnapshot({ environment, runProgram }),
    );
    const tracked = await exercise(child, {
      observations,
      readyBarrier: () => tracker.wait(),
    });
    assertWindowsProcessTreeExited(
      tracked,
      await readProcessSnapshot({ environment, runProgram }),
    );
    if ((await readInstalledExecutableProcesses({ appPath, environment, runProgram })).length !== 0) {
      fail("INSTALLED_EXECUTABLE_REMAINS");
    }
    return Object.freeze({
      pid: child.pid,
      observedProcessTreeExited: true,
      installedExecutableAbsentAtPreLaunchSnapshot: true,
      installedExecutableAbsentAtPostExitSnapshot: true,
      storageJourneyCompleted: observations.storagePassed === true
        && observations.accountObservationStoragePassed === true,
    });
  } finally {
    tracker?.close();
    if (!await stopChild(child, { environment, runProgram })) fail("PROCESS_CLEANUP_UNCONFIRMED");
  }
}

function assertLifecycleHost({ platform, architecture, environment }) {
  if (platform !== "win32" || architecture !== "x64") fail("WINDOWS_X64_REQUIRED");
  if (environment?.GITHUB_ACTIONS !== "true") fail("DISPOSABLE_CI_REQUIRED");
  const runnerTemp = environment.RUNNER_TEMP;
  if (!validAbsolutePath(runnerTemp) || /\s/u.test(runnerTemp)) fail("RUNNER_TEMP_INVALID");
  return resolve(runnerTemp);
}

function assertLaunchResult(result) {
  if (result === null
      || typeof result !== "object"
      || !Number.isSafeInteger(result.pid)
      || result.pid <= 0
      || result.observedProcessTreeExited !== true
      || result.installedExecutableAbsentAtPreLaunchSnapshot !== true
      || result.installedExecutableAbsentAtPostExitSnapshot !== true
      || result.storageJourneyCompleted !== true) {
    fail("APPLICATION_LIFECYCLE_INVALID");
  }
  return result;
}

function assertInstalledLaunchPackageIdentity(value, sourceRevision) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 3
      || value.sourceRevision !== sourceRevision
      || !SHA256.test(value.artifactSha256 ?? "")
      || !SHA256.test(value.executableSha256 ?? "")) {
    fail("INSTALLED_PACKAGE_IDENTITY_INVALID");
  }
  return Object.freeze({
    sourceRevision: value.sourceRevision,
    artifactSha256: value.artifactSha256,
    executableSha256: value.executableSha256,
  });
}

async function verifyInstalledPackageBeforeLaunch({
  verifyInstalledPackage,
  appPath,
  stagedAppPath,
  packageReceiptPath,
  sourceRevision,
}) {
  let verified;
  try {
    verified = await verifyInstalledPackage({
      appPath,
      stagedAppPath,
      packageReceiptPath,
      sourceRevision,
    });
  } catch {
    fail("INSTALLED_PACKAGE_IDENTITY_INVALID");
  }
  return assertInstalledLaunchPackageIdentity(verified, sourceRevision);
}

function sameInstalledLaunchPackageIdentity(left, right) {
  return left !== null && right !== null
    && left.sourceRevision === right.sourceRevision
    && left.artifactSha256 === right.artifactSha256
    && left.executableSha256 === right.executableSha256;
}

/**
 * NSIS can finish its visible process shortly before its own temporary clone
 * releases the app tree or uninstall key. Observe only the two fixed
 * postconditions under one monotonic budget; never reinstall or replay a
 * mutation to make a late cleanup appear successful. A local filesystem read
 * itself is not cancellable, so an expired budget after that read refuses the
 * result rather than claiming a strict wall-clock bound for local I/O.
 */
async function observeUninstallPostconditions({
  installationRoot,
  environment,
  runProgram,
  isMissing,
  inspectRegistry,
  waitForCleanupPoll,
  monotonicNow = () => performance.now(),
  budgetMs = UNINSTALL_POSTCONDITION_BUDGET_MS,
  terminationGraceMs = PROGRAM_TERMINATION_GRACE_MS,
}) {
  if (typeof monotonicNow !== "function"
      || !Number.isSafeInteger(budgetMs) || budgetMs <= terminationGraceMs
      || !Number.isSafeInteger(terminationGraceMs) || terminationGraceMs <= 0) {
    return Object.freeze({ installRootAbsent: false, uninstallRegistryAbsent: false });
  }
  let startedAt;
  try {
    startedAt = monotonicNow();
  } catch {
    return Object.freeze({ installRootAbsent: false, uninstallRegistryAbsent: false });
  }
  if (!Number.isFinite(startedAt)) {
    return Object.freeze({ installRootAbsent: false, uninstallRegistryAbsent: false });
  }
  const deadline = startedAt + budgetMs;
  const remainingBudget = () => {
    try {
      const now = monotonicNow();
      return Number.isFinite(now) ? deadline - now : null;
    } catch {
      return null;
    }
  };
  for (let attempt = 0; attempt < UNINSTALL_POSTCONDITION_ATTEMPTS; attempt += 1) {
    if (!(remainingBudget() > 0)) break;
    const installRootAbsent = await isMissing(installationRoot);
    const remainingBeforeProbe = remainingBudget();
    // runWindowsNsisLifecycleProgram can spend its timeout plus a termination
    // grace period. Reserve that full grace within the one shared budget.
    const registryTimeoutMs = remainingBeforeProbe === null
      ? 0
      : Math.min(
        PROCESS_SNAPSHOT_TIMEOUT_MS,
        Math.floor(remainingBeforeProbe - terminationGraceMs),
      );
    if (registryTimeoutMs <= 0) break;
    const uninstallRegistryAbsent = (await inspectRegistry({
      environment,
      runProgram,
      expectedInstallationRoot: installationRoot,
      timeoutMs: registryTimeoutMs,
    })) === REGISTRY_ABSENT;
    if (!(remainingBudget() >= 0)) break;
    if (installRootAbsent && uninstallRegistryAbsent) {
      return Object.freeze({ installRootAbsent, uninstallRegistryAbsent });
    }
    if (attempt + 1 < UNINSTALL_POSTCONDITION_ATTEMPTS) {
      const remainingBeforeWait = remainingBudget();
      const delayMs = remainingBeforeWait === null
        ? 0
        : Math.min(UNINSTALL_POSTCONDITION_INTERVAL_MS, Math.floor(remainingBeforeWait));
      if (delayMs <= 0) break;
      await waitForCleanupPoll(delayMs);
    }
  }
  return Object.freeze({ installRootAbsent: false, uninstallRegistryAbsent: false });
}

function lifecycleReceipt({
  identity,
  installerIdentity,
  errorCode,
  installationAttempted,
  installationPerformed,
  installerSettled,
  preexistingRegistryAbsent,
  firstInstalledBytesVerified,
  secondInstalledBytesVerified,
  sameInstalledApplicationBytesBound,
  firstRunAcknowledgementPrepared,
  launches,
  uninstallationAttempted,
  uninstallationPerformed,
  uninstallerSettled,
  installRootAbsent,
  uninstallRegistryAbsent,
  ownedTemporaryRootRemoved,
}) {
  const first = launches[0] ?? null;
  const second = launches[1] ?? null;
  return {
    schemaVersion: "windows-electron-nsis-lifecycle-v1",
    status: errorCode ? "failed" : "passed",
    ...(installerIdentity ?? {}),
    ...(identity ?? {}),
    target: "win32-x64",
    unsignedDevelopmentOnly: true,
    signed: false,
    productionReady: false,
    installationAttempted,
    installationPerformed,
    installerSettled,
    preexistingRegistryAbsent,
    // Each launch receives a fresh package verification. These are snapshots,
    // not a claim that installed bytes remained unchanged continuously.
    firstInstalledBytesVerified,
    secondInstalledBytesVerified,
    sameInstalledApplicationBytesBound,
    firstRunAcknowledgementPrepared,
    topLevelLaunches: launches.length,
    topLevelProcessIdsDistinct: first !== null && second !== null && first.pid !== second.pid,
    firstObservedApplicationProcessTreeExited: first?.observedProcessTreeExited === true,
    secondObservedApplicationProcessTreeExited: second?.observedProcessTreeExited === true,
    firstInstalledExecutableAbsentAtPreLaunchSnapshot:
      first?.installedExecutableAbsentAtPreLaunchSnapshot === true,
    firstInstalledExecutableAbsentAtPostExitSnapshot:
      first?.installedExecutableAbsentAtPostExitSnapshot === true,
    secondInstalledExecutableAbsentAtPreLaunchSnapshot:
      second?.installedExecutableAbsentAtPreLaunchSnapshot === true,
    secondInstalledExecutableAbsentAtPostExitSnapshot:
      second?.installedExecutableAbsentAtPostExitSnapshot === true,
    // The query covers every process still running this exact installed
    // Electron executable. It cannot prove cleanup of arbitrary helper
    // executables, so that broader process-tree claim remains unavailable.
    fullOwnedDescendantCleanupVerified: false,
    profileReusedAcrossLaunches: launches.length === 2,
    // The accountless FD3 journey intentionally removes its synthetic record
    // at exit. The FD4 observation credential is scoped only to this
    // disposable runner account, so same-profile relaunch is not evidence of
    // retained application credentials.
    persistentApplicationCredentialStateVerified: false,
    accountlessSyntheticRecordDeleted: launches.length === 2
      && launches.every((launch) => launch.storageJourneyCompleted === true),
    accountObservationCredentialCleanup: "disposable_runner_account_lifetime",
    uninstallationAttempted,
    uninstallationPerformed,
    uninstallerSettled,
    installRootAbsent,
    uninstallRegistryAbsent,
    cleanupVerificationSkippedBecauseOperationUnsettled:
      installerSettled !== true
      || (uninstallationAttempted === true && uninstallationPerformed !== true),
    cleanupConfirmed: installationAttempted === true
      && installerSettled === true
      && uninstallerSettled === true
      && uninstallationPerformed === true
      && installRootAbsent === true
      && uninstallRegistryAbsent === true,
    ownedTemporaryRootRemoved,
    errorCode,
  };
}

/**
 * Run only in an explicitly isolated hosted Windows runner. Named injection
 * points make the no-install source contract testable without simulating a
 * system installation on a developer machine.
 */
export async function runWindowsNsisLifecycle(options, {
  platform = process.platform,
  architecture = process.arch,
  environment = process.env,
  reserveReceipt = (path) => open(path, "wx", 0o600),
  verifyInstaller = defaultVerifyInstaller,
  verifySilentNsisTemplate = assertPinnedNsisSilentInstallDoesNotAutoRun,
  createOwnedRoot = defaultCreateOwnedRoot,
  isMissing = pathMissing,
  inspectRegistry = defaultInspectRegistry,
  executeInstaller = defaultExecuteInstaller,
  assertUninstaller = defaultAssertUninstaller,
  verifyInstalledPackage = verifyWindowsAccountlessSmokePackage,
  prepareProfile = prepareWindowsDevelopmentProfile,
  prepareFirstRun = prepareWindowsAccountlessSmokeFirstRunAcknowledgementForTest,
  launchAndExercise = defaultLaunchAndExercise,
  executeUninstaller = defaultExecuteUninstaller,
  removeOwnedRoot = (path) => rm(path, { recursive: true, force: false }),
  runProgram = defaultRunProgram,
  waitForCleanupPoll = delay,
  monotonicNow = () => performance.now(),
  uninstallPostconditionBudgetMs = UNINSTALL_POSTCONDITION_BUDGET_MS,
  uninstallProgramTerminationGraceMs = PROGRAM_TERMINATION_GRACE_MS,
} = {}) {
  const runnerTemp = assertLifecycleHost({ platform, architecture, environment });
  const selectedOptions = assertLifecycleOptions(options);
  const receiptHandle = await reserveReceipt(selectedOptions.receiptPath);
  let identity = null;
  let installerIdentity = null;
  let ownedRoot = null;
  let installationRoot = null;
  let uninstallerPath = null;
  let errorCode = null;
  let installationAttempted = false;
  let installationPerformed = false;
  let installerSettled = null;
  let preexistingRegistryAbsent = false;
  let firstInstalledBytesVerified = false;
  let secondInstalledBytesVerified = false;
  let sameInstalledApplicationBytesBound = false;
  let firstRunAcknowledgementPrepared = false;
  const launches = [];
  let uninstallationAttempted = false;
  let uninstallationPerformed = false;
  let uninstallerSettled = null;
  let installRootAbsent = false;
  let uninstallRegistryAbsent = false;
  let ownedTemporaryRootRemoved = false;
  try {
    installerIdentity = await verifyInstaller(selectedOptions);
    if (await verifySilentNsisTemplate() !== true) fail("NSIS_TEMPLATE_UNVERIFIED");
    ownedRoot = await createOwnedRoot(runnerTemp);
    installationRoot = join(ownedRoot, "app");
    uninstallerPath = join(installationRoot, UNINSTALLER);
    if (!await isMissing(installationRoot)) fail("INSTALL_ROOT_DIRTY");
    const initialRegistry = await inspectRegistry({
      environment,
      runProgram,
      expectedInstallationRoot: installationRoot,
    });
    if (initialRegistry !== REGISTRY_ABSENT) fail("REGISTRY_DIRTY");
    preexistingRegistryAbsent = true;

    installationAttempted = true;
    const installerOutcome = await executeInstaller({
      installerPath: selectedOptions.installerPath,
      installationRoot,
      environment,
      runProgram,
    });
    installerSettled = installerOutcome?.settled === true;
    const checkedInstallerOutcome = assertProgramExecutionOutcome(installerOutcome, "INSTALLER");
    if (!checkedInstallerOutcome.settled) fail("INSTALLER_UNSETTLED");
    if (!checkedInstallerOutcome.succeeded) fail("INSTALLER_FAILED");
    installationPerformed = true;
    const installedRegistry = await inspectRegistry({
      environment,
      runProgram,
      expectedInstallationRoot: installationRoot,
    });
    if (installedRegistry !== REGISTRY_EXPECTED) {
      fail("INSTALL_REGISTRY_INVALID");
    }
    const appPath = join(installationRoot, APP_EXECUTABLE);
    await assertUninstaller(uninstallerPath);
    const profile = await prepareProfile({
      appPath,
      profilePath: join(ownedRoot, "profile"),
    });
    const firstSpec = buildWindowsDevelopmentLaunchSpec({ appPath, profile, environment });
    await prepareFirstRun({
      profile,
      environment: firstSpec.options.env,
      stagedAppPath: selectedOptions.stagedAppPath,
    });
    firstRunAcknowledgementPrepared = true;
    identity = await verifyInstalledPackageBeforeLaunch({
      verifyInstalledPackage,
      appPath,
      stagedAppPath: selectedOptions.stagedAppPath,
      packageReceiptPath: selectedOptions.packageReceiptPath,
      sourceRevision: selectedOptions.sourceRevision,
    });
    firstInstalledBytesVerified = true;
    const first = assertLaunchResult(await launchAndExercise({
      appPath,
      profile,
      launchOrdinal: 1,
      environment,
      runProgram,
    }));
    launches.push(first);
    const secondIdentity = await verifyInstalledPackageBeforeLaunch({
      verifyInstalledPackage,
      appPath,
      stagedAppPath: selectedOptions.stagedAppPath,
      packageReceiptPath: selectedOptions.packageReceiptPath,
      sourceRevision: selectedOptions.sourceRevision,
    });
    secondInstalledBytesVerified = true;
    if (!sameInstalledLaunchPackageIdentity(identity, secondIdentity)) {
      fail("INSTALLED_PACKAGE_IDENTITY_INVALID");
    }
    sameInstalledApplicationBytesBound = true;
    const second = assertLaunchResult(await launchAndExercise({
      appPath,
      profile,
      launchOrdinal: 2,
      environment,
      runProgram,
    }));
    launches.push(second);
    if (first.pid === second.pid) fail("APPLICATION_PID_REUSED");
    if (!first.observedProcessTreeExited || !second.observedProcessTreeExited
        || !first.installedExecutableAbsentAtPreLaunchSnapshot
        || !first.installedExecutableAbsentAtPostExitSnapshot
        || !second.installedExecutableAbsentAtPreLaunchSnapshot
        || !second.installedExecutableAbsentAtPostExitSnapshot) {
      fail("OWNED_PROCESS_REMAINS");
    }

    uninstallationAttempted = true;
    const uninstallerOutcome = await executeUninstaller({ uninstallerPath, environment, runProgram });
    uninstallerSettled = uninstallerOutcome?.settled === true;
    const checkedUninstallerOutcome = assertProgramExecutionOutcome(uninstallerOutcome, "UNINSTALLER");
    if (!checkedUninstallerOutcome.settled) fail("UNINSTALLER_UNSETTLED");
    if (!checkedUninstallerOutcome.succeeded) fail("UNINSTALLER_FAILED");
    uninstallationPerformed = true;
  } catch (error) {
    errorCode = fixedCode(error);
  } finally {
    const recordCleanupFailure = () => {
      // Keep the primary failed operation in the receipt. Cleanup cannot make
      // a failed install, package check, launch, or uninstaller look repaired.
      if (errorCode === null) errorCode = `${PREFIX}CLEANUP_UNCONFIRMED`;
    };
    // A failed installer can still leave its exact owned app tree and registry
    // entry. If either exists, use only the generated uninstaller; never
    // delete a registry key or a non-owned installation to repair the runner.
    // Once an uninstaller has been attempted, its failure is terminal: do not
    // replay that mutation merely to obtain a cleaner receipt.
    if (installerSettled === true && installationAttempted
        && uninstallationAttempted === false && uninstallerPath !== null) {
      try {
        const partialAppPresent = installationRoot !== null && !await isMissing(installationRoot);
        const partialRegistryPresent = (await inspectRegistry({
          environment,
          runProgram,
          expectedInstallationRoot: installationRoot,
        })) !== REGISTRY_ABSENT;
        if (partialAppPresent || partialRegistryPresent) {
          await assertUninstaller(uninstallerPath);
          uninstallationAttempted = true;
          const cleanupUninstallerOutcome = await executeUninstaller({
            uninstallerPath,
            environment,
            runProgram,
          });
          uninstallerSettled = cleanupUninstallerOutcome?.settled === true;
          const checkedCleanupUninstallerOutcome = assertProgramExecutionOutcome(
            cleanupUninstallerOutcome,
            "UNINSTALLER",
          );
          if (!checkedCleanupUninstallerOutcome.settled || !checkedCleanupUninstallerOutcome.succeeded) {
            fail("CLEANUP_UNCONFIRMED");
          }
          uninstallationPerformed = true;
        } else {
          installRootAbsent = true;
          uninstallRegistryAbsent = true;
        }
      } catch {
        recordCleanupFailure();
      }
    }
    if (uninstallationPerformed === true && installationRoot !== null) {
      try {
        ({ installRootAbsent, uninstallRegistryAbsent } = await observeUninstallPostconditions({
          installationRoot,
          environment,
          runProgram,
          isMissing,
          inspectRegistry,
          waitForCleanupPoll,
          monotonicNow,
          budgetMs: uninstallPostconditionBudgetMs,
          terminationGraceMs: uninstallProgramTerminationGraceMs,
        }));
        if (!installRootAbsent || !uninstallRegistryAbsent) {
          recordCleanupFailure();
        }
      } catch {
        recordCleanupFailure();
      }
    }
    if (ownedRoot !== null && (!installationAttempted
        || (uninstallationPerformed === true && uninstallerSettled === true
          && installRootAbsent && uninstallRegistryAbsent))) {
      try {
        await removeOwnedRoot(ownedRoot);
        ownedTemporaryRootRemoved = true;
      } catch {
        recordCleanupFailure();
      }
    }
    const receipt = lifecycleReceipt({
      identity,
      installerIdentity,
      errorCode,
      installationAttempted,
      installationPerformed,
      installerSettled,
      preexistingRegistryAbsent,
      firstInstalledBytesVerified,
      secondInstalledBytesVerified,
      sameInstalledApplicationBytesBound,
      firstRunAcknowledgementPrepared,
      launches,
      uninstallationAttempted,
      uninstallationPerformed,
      uninstallerSettled,
      installRootAbsent,
      uninstallRegistryAbsent,
      ownedTemporaryRootRemoved,
    });
    try {
      await receiptHandle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
      await receiptHandle.sync();
    } finally {
      await receiptHandle.close();
    }
  }
  if (errorCode) throw Object.assign(new Error(errorCode), { code: errorCode });
  return Object.freeze({ status: "passed", ...installerIdentity, ...identity });
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await runWindowsNsisLifecycle(
      parseWindowsNsisLifecycleArguments(process.argv.slice(2)),
    ))}\n`);
  } catch (error) {
    process.stderr.write(`${fixedCode(error)}\n`);
    process.exitCode = 1;
  }
}
