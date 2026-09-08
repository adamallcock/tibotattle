#!/usr/bin/env node

// Disposable hosted-runner proof for an unsigned Windows development installer.
// It never signs, enables production selection, or accepts a user-selected
// install location. The only NSIS /D target is a new private child of
// RUNNER_TEMP. The receipt keeps application credential persistence unproven:
// the accountless FD3 journey deletes its synthetic record, while the
// observation credential is scoped to the disposable runner account lifetime.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, open, readFile, readdir, rmdir, rm, unlink } from "node:fs/promises";
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
import {
  WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_SMOKE_FAILURE_STAGES,
  WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_LIFECYCLE_FIRST_PHASE,
  WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_LIFECYCLE_PHASE_ENVIRONMENT_KEY,
  WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_LIFECYCLE_RESTART_PHASE,
} from "../apps/electron/windows-account-observation-qualification-smoke.js";
import {
  validateWindowsElectronQualificationRunId,
} from "../apps/electron/windows-qualification.js";

const PREFIX = "ELECTRON_WINDOWS_NSIS_LIFECYCLE_";
const require = createRequire(import.meta.url);
const REVISION = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const APP_EXECUTABLE = "TiboTattle Dev.exe";
const NORMAL_CANDIDATE_APP_EXECUTABLE = "TiboTattle.exe";
const UNINSTALLER = "Uninstall TiboTattle Dev.exe";
const APP_BUILDER_LIB_VERSION = "26.15.7";
// UUID v5(appId, electron-builder's pinned NSIS namespace) for the fixed
// development appId com.adamallcock.tibotattle.electron.dev. The pinned NSIS
// template writes InstallLocation to this install key; the distinct Uninstall
// key contains only uninstall metadata. This runner checks it only; it never
// creates, repairs, or removes registry entries.
export const WINDOWS_NSIS_LIFECYCLE_INSTALL_REGISTRY_SUBKEY =
  "Software\\962AD905-00AD-56CE-85F1-F2541D787AC7";
export const WINDOWS_NSIS_LIFECYCLE_UNINSTALL_REGISTRY_SUBKEY =
  "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\962AD905-00AD-56CE-85F1-F2541D787AC7";
const PROCESS_SNAPSHOT_TIMEOUT_MS = 20_000;
const INSTALLER_TIMEOUT_MS = 180_000;
const UNINSTALLER_TIMEOUT_MS = 120_000;
const PROCESS_CLEANUP_TIMEOUT_MS = 10_000;
const PROGRAM_TERMINATION_GRACE_MS = 10_000;
const UNINSTALL_POSTCONDITION_ATTEMPTS = 40;
const UNINSTALL_POSTCONDITION_INTERVAL_MS = 250;
const UNINSTALL_POSTCONDITION_BUDGET_MS = 30_000;
const PROGRAM_OUTPUT_LIMIT_BYTES = 64 * 1024;
const REGISTRY_ABSENT = "absent-v1";
const REGISTRY_EXPECTED = "expected-v1";
const REGISTRY_OTHER = "other-v1";
const WINDOWS_PROCESS_ID_MAX = 0xffff_ffff;
const PROCESS_SNAPSHOT_MAX_TARGETS = 4096;
const WINDOWS_POWER_SHELL_UTILITY_MODULE = "Microsoft.PowerShell.Utility";
const FIRST_LAUNCH_PHASES = new Set([
  "not_reached",
  "installed_executable_prelaunch_read",
  "launcher_child_spawn",
  "ready_private_ipc",
  "ready_process_identity",
  "accountless_storage_private_ipc",
  "account_observation_storage_private_ipc",
  "quit_private_ipc",
  "quit_child_exit",
  "process_identity_post_exit",
  "installed_executable_post_exit_read",
  "launcher_child_cleanup",
  "completed",
]);
const POST_UNINSTALL_PHASES = new Set([
  "not_attempted",
  "both_predicates_absent",
  "install_root_present",
  "uninstall_registry_present",
  "both_predicates_present",
  "install_root_probe_unavailable",
  "uninstall_registry_probe_unavailable",
  "postcondition_wait_unavailable",
  "postcondition_probe_unavailable",
  "postcondition_budget_exhausted",
]);
const POST_UNINSTALL_FAILURE_CODES = Object.freeze({
  install_root_present: `${PREFIX}POST_UNINSTALL_INSTALL_ROOT_PRESENT`,
  uninstall_registry_present: `${PREFIX}POST_UNINSTALL_UNINSTALL_REGISTRY_PRESENT`,
  both_predicates_present: `${PREFIX}POST_UNINSTALL_PREDICATES_PRESENT`,
  install_root_probe_unavailable: `${PREFIX}POST_UNINSTALL_INSTALL_ROOT_PROBE_UNAVAILABLE`,
  uninstall_registry_probe_unavailable: `${PREFIX}POST_UNINSTALL_REGISTRY_PROBE_UNAVAILABLE`,
  postcondition_wait_unavailable: `${PREFIX}POST_UNINSTALL_WAIT_UNAVAILABLE`,
  postcondition_probe_unavailable: `${PREFIX}POST_UNINSTALL_PROBE_UNAVAILABLE`,
  postcondition_budget_exhausted: `${PREFIX}POST_UNINSTALL_BUDGET_EXHAUSTED`,
});
const POST_UNINSTALL_REGISTRY_PROBE_FAILURE_CODES = new Set([
  `${PREFIX}POST_UNINSTALL_REGISTRY_PROBE_UNAVAILABLE`,
  `${PREFIX}POST_UNINSTALL_REGISTRY_PROBE_TIMED_OUT`,
  `${PREFIX}POST_UNINSTALL_REGISTRY_PROBE_UNSETTLED`,
  `${PREFIX}POST_UNINSTALL_REGISTRY_PROBE_START_UNAVAILABLE`,
  `${PREFIX}POST_UNINSTALL_REGISTRY_PROBE_EXIT_NONZERO`,
  `${PREFIX}POST_UNINSTALL_REGISTRY_PROBE_OUTPUT_INVALID`,
]);
const FIRST_LAUNCH_FAILURE_CODES = new Set([
  `${PREFIX}FAILED`,
  `${PREFIX}APPLICATION_LAUNCH_UNAVAILABLE`,
  `${PREFIX}APPLICATION_STARTUP_TIMEOUT`,
  `${PREFIX}APPLICATION_QUIT_TIMEOUT`,
  `${PREFIX}APPLICATION_CHILD_FAILED`,
  `${PREFIX}PROCESS_PROOF_UNAVAILABLE`,
  `${PREFIX}PROCESS_CLEANUP_UNCONFIRMED`,
  `${PREFIX}INSTALLED_EXECUTABLE_PRESENT_BEFORE_LAUNCH`,
  `${PREFIX}INSTALLED_EXECUTABLE_REMAINS`,
  `${PREFIX}OWNED_PROCESS_REMAINS`,
  "ELECTRON_WINDOWS_ACCOUNTLESS_SMOKE_CHILD_EXITED",
  "ELECTRON_WINDOWS_ACCOUNTLESS_SMOKE_RESPONSE_INVALID",
  "ELECTRON_WINDOWS_ACCOUNTLESS_SMOKE_STORAGE_FAILED",
  "ELECTRON_WINDOWS_ACCOUNTLESS_SMOKE_OBSERVATION_STORAGE_FAILED",
  "ELECTRON_WINDOWS_ACCOUNTLESS_SMOKE_COMMAND_REFUSED",
  "ELECTRON_WINDOWS_ACCOUNTLESS_SMOKE_TIMEOUT",
  "ELECTRON_WINDOWS_ACCOUNTLESS_SMOKE_SEND_FAILED",
  "ELECTRON_WINDOWS_ACCOUNTLESS_SMOKE_CLOSED",
]);
const FIRST_LAUNCH_SEND_FAILURE_CODES = new Set([
  "EPIPE",
  "ECONNRESET",
  "ERR_IPC_CHANNEL_CLOSED",
  "ERR_IPC_DISCONNECTED",
  "unclassified",
]);
const FIRST_LAUNCH_OBSERVATION_FAILURE_STAGES = new Set(
  WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_SMOKE_FAILURE_STAGES,
);
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

function fixedDiagnosticCode(error) {
  return FIRST_LAUNCH_FAILURE_CODES.has(error?.code)
    ? error.code
    : `${PREFIX}FAILED`;
}

function createFirstLaunchDiagnostic() {
  return { phase: "not_reached", failureCode: null, observations: null };
}

function setFirstLaunchPhase(diagnostic, phase) {
  if (diagnostic === null || diagnostic === undefined) return;
  if (typeof diagnostic !== "object" || !FIRST_LAUNCH_PHASES.has(phase)) return;
  diagnostic.phase = phase;
}

function recordFirstLaunchFailure(diagnostic, error) {
  if (diagnostic === null || diagnostic === undefined) return;
  if (typeof diagnostic !== "object") return;
  diagnostic.failureCode = fixedDiagnosticCode(error);
}

function recordFirstLaunchObservations(diagnostic, observations) {
  if (diagnostic === null || diagnostic === undefined || typeof diagnostic !== "object") return;
  diagnostic.observations = observations;
}

function boundedFirstLaunchObservations(observations) {
  return Object.freeze({
    entryFailureObserved: observations?.entryFailureObserved === true,
    statusResponseObserved: observations?.statusResponseObserved === true,
    storageRequested: observations?.storageRequested === true,
    storagePassed: observations?.storagePassed === true,
    accountObservationStorageRequested: observations?.accountObservationStorageRequested === true,
    accountObservationStoragePassed: observations?.accountObservationStoragePassed === true,
    accountObservationFailureStage: FIRST_LAUNCH_OBSERVATION_FAILURE_STAGES
      .has(observations?.accountObservationFailureStage)
      ? observations.accountObservationFailureStage
      : null,
    quitAcknowledged: observations?.quitAcknowledged === true,
    sendFailureCode: FIRST_LAUNCH_SEND_FAILURE_CODES.has(observations?.sendFailureCode)
      ? observations.sendFailureCode
      : null,
  });
}

function boundedFirstLaunchDiagnostic(diagnostic) {
  const phase = FIRST_LAUNCH_PHASES.has(diagnostic?.phase)
    ? diagnostic.phase
    : "not_reached";
  const failureCode = FIRST_LAUNCH_FAILURE_CODES.has(diagnostic?.failureCode)
    ? diagnostic.failureCode
    : null;
  return Object.freeze({
    phase,
    failureCode,
    observations: boundedFirstLaunchObservations(diagnostic?.observations),
  });
}

function postUninstallResult(phase, failureCode = null) {
  if (!POST_UNINSTALL_PHASES.has(phase)) fail("POST_UNINSTALL_DIAGNOSTIC_INVALID");
  const selectedFailureCode = phase === "uninstall_registry_probe_unavailable"
      && POST_UNINSTALL_REGISTRY_PROBE_FAILURE_CODES.has(failureCode)
    ? failureCode
    : POST_UNINSTALL_FAILURE_CODES[phase] ?? null;
  return Object.freeze({
    installRootAbsent: phase === "both_predicates_absent",
    uninstallRegistryAbsent: phase === "both_predicates_absent",
    phase,
    failureCode: selectedFailureCode,
  });
}

function boundedPostUninstallDiagnostic(diagnostic) {
  const phase = POST_UNINSTALL_PHASES.has(diagnostic?.phase)
    ? diagnostic.phase
    : "not_attempted";
  return postUninstallResult(phase, diagnostic?.failureCode);
}

function validAbsolutePath(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4096
    && !value.includes("\0")
    && isAbsolute(value);
}

function validWindowsProcessId(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= WINDOWS_PROCESS_ID_MAX;
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

function normalizedWindowsNsisInstallationRoot(installationRoot) {
  // Validate before resolution: Windows would otherwise turn a relative
  // target into a valid-looking path under the runner's current directory.
  if (typeof installationRoot !== "string"
      || !/^[A-Za-z]:\\(?:[A-Za-z0-9._-]+\\)*[A-Za-z0-9._-]+$/u.test(installationRoot)
      || installationRoot.split("\\").some((part) => part === "." || part === "..")) {
    fail("INSTALL_ROOT_INVALID");
  }
  return win32.resolve(installationRoot);
}

/** The special NSIS /D switch is final and receives a closed, space-free path. */
export function buildWindowsNsisInstallArguments(installationRoot) {
  return Object.freeze(["/S", `/D=${normalizedWindowsNsisInstallationRoot(installationRoot)}`]);
}

/** NSIS requires the in-place uninstaller's exact _?= target to be final. */
export function buildWindowsNsisUninstallArguments(installationRoot) {
  return Object.freeze(["/S", `_?=${normalizedWindowsNsisInstallationRoot(installationRoot)}`]);
}

/**
 * The lifecycle runner must be the first controlled application launch. This
 * source check binds that assumption to the exact pinned NSIS template: its
 * silent branch reaches StartApp only for the explicit force-run flag, which
 * our closed install arguments do not contain. It also binds the separate
 * install-registration key to the template's InstallLocation write.
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
  let multiUser;
  let installer;
  let installUtil;
  let uninstaller;
  try {
    [metadata, installSection, targetSource, multiUser, installer, installUtil, uninstaller] = await Promise.all([
      readText(packagePath),
      readText(join(packageRoot, "templates", "nsis", "installSection.nsh")),
      readText(join(packageRoot, "out", "targets", "nsis", "NsisTarget.js")),
      readText(join(packageRoot, "templates", "nsis", "multiUser.nsh")),
      readText(join(packageRoot, "templates", "nsis", "include", "installer.nsh")),
      readText(join(packageRoot, "templates", "nsis", "include", "installUtil.nsh")),
      readText(join(packageRoot, "templates", "nsis", "uninstaller.nsh")),
    ]);
    metadata = JSON.parse(metadata);
  } catch {
    fail("NSIS_TEMPLATE_UNVERIFIED");
  }
  if (metadata?.name !== "app-builder-lib" || metadata.version !== APP_BUILDER_LIB_VERSION
      || typeof installSection !== "string" || typeof targetSource !== "string"
      || typeof multiUser !== "string" || typeof installer !== "string"
      || typeof installUtil !== "string" || typeof uninstaller !== "string"
      // The generator must reserve force-run as an explicit command-line
      // switch, rather than making it a default installer action.
      || !/\.flags\(\["updated",\s*"force-run"/u.test(targetSource)
      // One-click installers start only when non-silent or force-run; this
      // runner is silent and supplies neither force-run spelling.
      || !/!ifdef ONE_CLICK[\s\S]*?!ifdef RUN_AFTER_FINISH[\s\S]*?\$\{ifNot\}\s+\$\{Silent\}[\s\S]*?\$\{orIf\}\s+\$\{isForceRun\}[\s\S]*?!insertmacro doStartApp[\s\S]*?!else[\s\S]*?\$\{if\}\s+\$\{isForceRun\}[\s\S]*?!insertmacro doStartApp[\s\S]*?!endif[\s\S]*?!insertmacro quitSuccess/u.test(installSection)
      // Assisted installers likewise require force-run in their silent path.
      || !/!else[\s\S]*?\$\{if\}\s+\$\{isForceRun\}[\s\S]*?\$\{andIf\}\s+\$\{Silent\}[\s\S]*?!insertmacro doStartApp/u.test(installSection)
      // The per-user install key is intentionally separate from the uninstall
      // record and is where electron-builder persists InstallLocation.
      || !/!define\s+\/ifndef\s+INSTALL_REGISTRY_KEY\s+"Software\\\$\{APP_GUID\}"/u.test(multiUser)
      || !/!macro registryAddInstallInfo[\s\S]*?WriteRegStr\s+SHELL_CONTEXT\s+"\$\{INSTALL_REGISTRY_KEY\}"\s+InstallLocation\s+"\$INSTDIR"/u.test(installer)
      // The pinned updater uses the in-place uninstaller with the exact root
      // final. Its template removes the app tree and both fixed registry keys;
      // the lifecycle runner may finish only that unchanged in-place executable
      // with unlink + a non-recursive rmdir, then independently rechecks both.
      || !installUtil.includes('ExecWait \'"$uninstallerFileName" /S /KEEP_APP_DATA $0 _?=$installationDir\' $R0')
      || !uninstaller.includes("SetOutPath $TEMP")
      || !uninstaller.includes("RMDir /r $INSTDIR")
      || !uninstaller.includes('DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"')
      || !uninstaller.includes('DeleteRegKey SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}"')) {
    fail("NSIS_TEMPLATE_UNVERIFIED");
  }
  const argumentsForEmptyRoot = buildWindowsNsisInstallArguments("C:\\runner\\tmp\\app");
  const argumentsForInPlaceUninstall = buildWindowsNsisUninstallArguments("C:\\runner\\tmp\\app");
  if (argumentsForEmptyRoot.length !== 2 || argumentsForEmptyRoot.some((value) => /force-run/iu.test(value))
      || argumentsForInPlaceUninstall.length !== 2
      || argumentsForInPlaceUninstall[1] !== "_?=C:\\runner\\tmp\\app") {
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

function selectedInstallerEnvironment(
  environment,
  fixedProbePath = null,
  fixedPowerShellUtilityModules = false,
) {
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
  // Process-proof queries use only the Windows PowerShell system module
  // directory. Do not forward a user, runner, or ambient module search path.
  if (fixedPowerShellUtilityModules) {
    selected.PSModulePath = systemPowerShellUtilityModuleDirectory(environment);
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
  fixedPowerShellUtilityModules = false,
} = {}, {
  spawnProcess = spawn,
  terminationGraceMs = PROGRAM_TERMINATION_GRACE_MS,
} = {}) {
  if (!validAbsolutePath(command) || !Array.isArray(args)
      || args.some((value) => typeof value !== "string" || value.includes("\0"))
      || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
      || (fixedProbePath !== null && !validAbsolutePath(fixedProbePath))
      || typeof fixedPowerShellUtilityModules !== "boolean"
      || (fixedPowerShellUtilityModules && (!captureOutput
        || command !== systemPowerShellExecutable(environment)))
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
        env: selectedInstallerEnvironment(
          environment,
          fixedProbePath,
          fixedPowerShellUtilityModules,
        ),
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

function systemPowerShellExecutable(environment) {
  return systemExecutable(environment, [
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  ]);
}

function systemPowerShellUtilityModuleDirectory(environment) {
  return systemExecutable(environment, [
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "Modules",
  ]);
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

function failRegistryUnavailable(postUninstallFailureCode = null) {
  const error = Object.assign(new Error(`${PREFIX}REGISTRY_UNAVAILABLE`), {
    code: `${PREFIX}REGISTRY_UNAVAILABLE`,
  });
  if (POST_UNINSTALL_REGISTRY_PROBE_FAILURE_CODES.has(postUninstallFailureCode)) {
    error.postUninstallRegistryProbeFailureCode = postUninstallFailureCode;
  }
  throw error;
}

function fixedPowerShellExpectedPathPrelude() {
  return `function ConvertTo-CanonicalLifecyclePath([string]$path){$full=[System.IO.Path]::GetFullPath($path);$root=[System.IO.Path]::GetPathRoot($full);if([string]::IsNullOrWhiteSpace($root) -or -not [System.IO.Path]::IsPathRooted($full)){throw 'expected-path'};if($full.Length -gt $root.Length){return $full.TrimEnd([System.IO.Path]::DirectorySeparatorChar,[System.IO.Path]::AltDirectorySeparatorChar)};return $full};$expectedPathRaw=[Environment]::GetEnvironmentVariable('${WINDOWS_NSIS_LIFECYCLE_EXPECTED_PATH_ENVIRONMENT_KEY}','Process');if($expectedPathRaw -isnot [string] -or [string]::IsNullOrWhiteSpace($expectedPathRaw) -or -not [System.IO.Path]::IsPathRooted($expectedPathRaw)){throw 'expected-path'};$expected=ConvertTo-CanonicalLifecyclePath($expectedPathRaw);`;
}

function fixedPowerShellUtilityModulePrelude() {
  return `Import-Module -Name ${WINDOWS_POWER_SHELL_UTILITY_MODULE} -ErrorAction Stop;`;
}

/** A fixed, read-only Registry API probe with no raw registry value in stdout. */
export function buildWindowsNsisRegistryInspectionArguments(expectedInstallationRoot) {
  if (!validAbsolutePath(expectedInstallationRoot)) fail("REGISTRY_UNAVAILABLE");
  const query = `$ErrorActionPreference='Stop';${fixedPowerShellExpectedPathPrelude()}$installKey=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${WINDOWS_NSIS_LIFECYCLE_INSTALL_REGISTRY_SUBKEY}',$false);$uninstallKey=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${WINDOWS_NSIS_LIFECYCLE_UNINSTALL_REGISTRY_SUBKEY}',$false);try{if(($null -eq $installKey) -and ($null -eq $uninstallKey)){[Console]::Out.Write('absent-v1')}elseif(($null -eq $installKey) -or ($null -eq $uninstallKey)){[Console]::Out.Write('other-v1')}else{$value=$installKey.GetValue('InstallLocation',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);if($value -isnot [string]){throw 'install-location'};$observed=ConvertTo-CanonicalLifecyclePath($value);if([string]::Equals($observed,$expected,[System.StringComparison]::OrdinalIgnoreCase)){[Console]::Out.Write('expected-v1')}else{[Console]::Out.Write('other-v1')}}}finally{if($null -ne $installKey){$installKey.Dispose()};if($null -ne $uninstallKey){$uninstallKey.Dispose()}}`;
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
    failRegistryUnavailable();
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
  if (!validProgramResult(result, true)) failRegistryUnavailable();
  if (result.timedOut) {
    failRegistryUnavailable(`${PREFIX}POST_UNINSTALL_REGISTRY_PROBE_TIMED_OUT`);
  }
  if (!result.settled) {
    failRegistryUnavailable(`${PREFIX}POST_UNINSTALL_REGISTRY_PROBE_UNSETTLED`);
  }
  if (result.exitCode === null) {
    failRegistryUnavailable(`${PREFIX}POST_UNINSTALL_REGISTRY_PROBE_START_UNAVAILABLE`);
  }
  if (result.exitCode !== 0) {
    failRegistryUnavailable(`${PREFIX}POST_UNINSTALL_REGISTRY_PROBE_EXIT_NONZERO`);
  }
  try {
    return parseWindowsNsisRegistryInspectionResult(result.stdout);
  } catch {
    failRegistryUnavailable(`${PREFIX}POST_UNINSTALL_REGISTRY_PROBE_OUTPUT_INVALID`);
  }
}

async function defaultExecuteInstaller({ installerPath, installationRoot, environment, runProgram }) {
  const result = await runProgram(installerPath, buildWindowsNsisInstallArguments(installationRoot), {
    timeoutMs: INSTALLER_TIMEOUT_MS,
    environment,
  });
  return programExecutionOutcome(result);
}

async function defaultAssertUninstaller(uninstallerPath) {
  return digestRegularFile(uninstallerPath);
}

function sameDigest(left, right) {
  return validDigest(left) && validDigest(right)
    && left.bytes === right.bytes
    && left.sha256 === right.sha256;
}

/**
 * NSIS' in-place `_?=` mode can leave only its running executable behind.
 * The generated template has already removed the app and registry records;
 * complete that one exact, unchanged file only after rechecking those facts.
 * This never recursively removes an installation root.
 */
async function completeInPlaceUninstallerResidue({
  installationRoot,
  uninstallerPath,
  uninstallerIdentity,
  environment,
  runProgram,
  isMissing,
  inspectRegistry,
}) {
  if (await isMissing(installationRoot)) return false;
  if (!validDigest(uninstallerIdentity)
      || resolve(uninstallerPath) !== join(resolve(installationRoot), UNINSTALLER)) {
    fail("UNINSTALLER_RESIDUE_UNSAFE");
  }
  const registry = await inspectRegistry({
    environment,
    runProgram,
    expectedInstallationRoot: installationRoot,
  });
  if (registry !== REGISTRY_ABSENT) fail("UNINSTALLER_RESIDUE_UNSAFE");
  let metadata;
  let entries;
  try {
    [metadata, entries] = await Promise.all([
      lstat(installationRoot),
      readdir(installationRoot, { withFileTypes: true }),
    ]);
  } catch {
    fail("UNINSTALLER_RESIDUE_UNSAFE");
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || entries.length !== 1 || entries[0]?.name !== UNINSTALLER
      || !entries[0].isFile() || entries[0].isSymbolicLink()) {
    fail("UNINSTALLER_RESIDUE_UNSAFE");
  }
  let residueIdentity;
  try {
    residueIdentity = await digestRegularFile(uninstallerPath);
  } catch {
    fail("UNINSTALLER_RESIDUE_UNSAFE");
  }
  if (!sameDigest(uninstallerIdentity, residueIdentity)) fail("UNINSTALLER_RESIDUE_UNSAFE");
  try {
    await unlink(uninstallerPath);
    await rmdir(installationRoot);
  } catch {
    // A concurrent entry or replacement leaves the owned root intact. Do not
    // fall back to a recursive removal that could hide that uncertainty.
    fail("UNINSTALLER_RESIDUE_UNSAFE");
  }
  return true;
}

async function defaultExecuteUninstaller({ uninstallerPath, installationRoot, environment, runProgram }) {
  const result = await runProgram(uninstallerPath, buildWindowsNsisUninstallArguments(installationRoot), {
    timeoutMs: UNINSTALLER_TIMEOUT_MS,
    environment,
  });
  return programExecutionOutcome(result);
}

const WINDOWS_TOOLHELP_PROCESS_SNAPSHOT_SOURCE = String.raw`using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;

public static class TiboTattleWindowsProcessSnapshot
{
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
    private const int ERROR_NO_MORE_FILES = 18;
    private const int ERROR_INVALID_PARAMETER = 87;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint dwLowDateTime;
        public uint dwHighDateTime;
    }

    private sealed class SnapshotEntry
    {
        public uint ProcessId;
        public uint ParentProcessId;
    }

    public sealed class Evidence
    {
        public uint ProcessId { get; private set; }
        public uint ParentProcessId { get; private set; }
        public string CreationDate { get; private set; }

        public Evidence(uint processId, uint parentProcessId, ulong creationDate)
        {
            ProcessId = processId;
            ParentProcessId = parentProcessId;
            CreationDate = creationDate.ToString(CultureInfo.InvariantCulture);
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(IntPtr hProcess, out FILETIME lpCreationTime,
        out FILETIME lpExitTime, out FILETIME lpKernelTime, out FILETIME lpUserTime);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);

    private static Dictionary<uint, SnapshotEntry> CaptureProcessTable()
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == IntPtr.Zero || snapshot == INVALID_HANDLE_VALUE)
        {
            throw new InvalidOperationException();
        }
        try
        {
            var entries = new Dictionary<uint, SnapshotEntry>();
            var current = new PROCESSENTRY32();
            current.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (!Process32First(snapshot, ref current))
            {
                throw new InvalidOperationException();
            }
            while (true)
            {
                if (entries.ContainsKey(current.th32ProcessID) || entries.Count >= 65536)
                {
                    throw new InvalidOperationException();
                }
                entries.Add(current.th32ProcessID, new SnapshotEntry {
                    ProcessId = current.th32ProcessID,
                    ParentProcessId = current.th32ParentProcessID,
                });
                current.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                if (Process32Next(snapshot, ref current))
                {
                    continue;
                }
                if (Marshal.GetLastWin32Error() != ERROR_NO_MORE_FILES)
                {
                    throw new InvalidOperationException();
                }
                return entries;
            }
        }
        finally
        {
            if (!CloseHandle(snapshot))
            {
                throw new InvalidOperationException();
            }
        }
    }

    private static bool TryReadEvidence(SnapshotEntry entry, out Evidence evidence, out bool absent)
    {
        evidence = null;
        absent = false;
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, entry.ProcessId);
        if (process == IntPtr.Zero || process == INVALID_HANDLE_VALUE)
        {
            if (Marshal.GetLastWin32Error() == ERROR_INVALID_PARAMETER)
            {
                absent = true;
            }
            return false;
        }
        try
        {
            FILETIME creation;
            FILETIME exit;
            FILETIME kernel;
            FILETIME user;
            if (!GetProcessTimes(process, out creation, out exit, out kernel, out user))
            {
                return false;
            }
            ulong creationDate = ((ulong)creation.dwHighDateTime << 32) | creation.dwLowDateTime;
            if (creationDate == 0)
            {
                return false;
            }
            evidence = new Evidence(entry.ProcessId, entry.ParentProcessId, creationDate);
            return true;
        }
        finally
        {
            if (!CloseHandle(process))
            {
                throw new InvalidOperationException();
            }
        }
    }

    public static Evidence[] Read(uint rootProcessId, uint[] retainedProcessIds)
    {
        bool rootMode = rootProcessId != 0;
        if ((rootMode && retainedProcessIds != null && retainedProcessIds.Length != 0)
            || (!rootMode && (retainedProcessIds == null || retainedProcessIds.Length == 0)))
        {
            throw new InvalidOperationException();
        }
        var entries = CaptureProcessTable();
        var selected = new HashSet<uint>();
        if (rootMode)
        {
            if (!entries.ContainsKey(rootProcessId))
            {
                throw new InvalidOperationException();
            }
            var children = new Dictionary<uint, List<uint>>();
            foreach (SnapshotEntry entry in entries.Values)
            {
                List<uint> childIds;
                if (!children.TryGetValue(entry.ParentProcessId, out childIds))
                {
                    childIds = new List<uint>();
                    children.Add(entry.ParentProcessId, childIds);
                }
                childIds.Add(entry.ProcessId);
            }
            var pending = new Queue<uint>();
            pending.Enqueue(rootProcessId);
            while (pending.Count != 0)
            {
                uint processId = pending.Dequeue();
                if (!selected.Add(processId))
                {
                    continue;
                }
                List<uint> childIds;
                if (children.TryGetValue(processId, out childIds))
                {
                    foreach (uint childId in childIds)
                    {
                        pending.Enqueue(childId);
                    }
                }
            }
        }
        else
        {
            var seen = new HashSet<uint>();
            foreach (uint processId in retainedProcessIds)
            {
                if (processId == 0 || !seen.Add(processId))
                {
                    throw new InvalidOperationException();
                }
                if (entries.ContainsKey(processId))
                {
                    selected.Add(processId);
                }
            }
        }

        var results = new List<Evidence>();
        bool rootObserved = false;
        foreach (uint processId in selected)
        {
            Evidence evidence;
            bool absent;
            if (!TryReadEvidence(entries[processId], out evidence, out absent))
            {
                if (absent && (!rootMode || processId != rootProcessId))
                {
                    continue;
                }
                throw new InvalidOperationException();
            }
            if (processId == rootProcessId)
            {
                rootObserved = true;
            }
            results.Add(evidence);
        }
        if (rootMode && !rootObserved)
        {
            throw new InvalidOperationException();
        }
        results.Sort(delegate(Evidence left, Evidence right) {
            return left.ProcessId.CompareTo(right.ProcessId);
        });
        return results.ToArray();
    }
}`;

function validTrackedWindowsProcessIds(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > PROCESS_SNAPSHOT_MAX_TARGETS) {
    return false;
  }
  const seen = new Set();
  for (const processId of value) {
    if (!validWindowsProcessId(processId) || seen.has(processId)) return false;
    seen.add(processId);
  }
  return true;
}

function toolhelpPowerShellTypeDefinition() {
  return `$source=@'
${WINDOWS_TOOLHELP_PROCESS_SNAPSHOT_SOURCE}
'@
Add-Type -TypeDefinition $source -ErrorAction Stop;
`;
}

/**
 * A fixed Toolhelp/Win32 query for either a ready app's live descendant tree
 * or the retained PIDs to recheck after it exits. It emits only PID, parent
 * PID, and exact creation metadata; each selected live process must permit
 * `GetProcessTimes`, otherwise the proof fails closed.
 */
export function buildWindowsOwnedProcessSnapshotQueryArguments({ rootProcessId = null, retainedProcessIds = null } = {}) {
  const rootMode = rootProcessId !== null;
  if ((rootMode && (!validWindowsProcessId(rootProcessId) || retainedProcessIds !== null))
      || (!rootMode && !validTrackedWindowsProcessIds(retainedProcessIds))) {
    fail("PROCESS_PROOF_UNAVAILABLE");
  }
  const root = rootMode ? rootProcessId : 0;
  const retained = rootMode ? "@()" : `@(${retainedProcessIds.join(",")})`;
  const query = `$ErrorActionPreference='Stop';${fixedPowerShellUtilityModulePrelude()}${toolhelpPowerShellTypeDefinition()}$rows=[TiboTattleWindowsProcessSnapshot]::Read([uint32]${root},[uint32[]]${retained});[Console]::Out.Write((ConvertTo-Json -InputObject @($rows) -Compress -Depth 2))`;
  return Object.freeze([
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    query,
  ]);
}

async function defaultReadWindowsProcessSnapshot({
  environment,
  runProgram,
  rootProcessId = null,
  retainedProcessIds = null,
}) {
  const command = systemPowerShellExecutable(environment);
  const result = await runProgram(command, buildWindowsOwnedProcessSnapshotQueryArguments({
    rootProcessId,
    retainedProcessIds,
  }), {
    timeoutMs: PROCESS_SNAPSHOT_TIMEOUT_MS,
    captureOutput: true,
    environment,
    fixedPowerShellUtilityModules: true,
  });
  if (!validProgramResult(result, true) || !result.settled || result.timedOut || result.exitCode !== 0) {
    fail("PROCESS_PROOF_UNAVAILABLE");
  }
  return parseWindowsProcessSnapshot(result.stdout);
}

/**
 * Ask the .NET process API only whether the exact installed Electron
 * executable remains. The app path is a fixed, validated child-only
 * environment value, never interpolated into the command or copied from the
 * parent environment. Output deliberately keeps paths out of receipts and
 * logs.
 */
export function buildWindowsExactExecutableProcessQueryArguments(appPath, {
  executableName = APP_EXECUTABLE,
} = {}) {
  if (!validAbsolutePath(appPath)
      || ![APP_EXECUTABLE, NORMAL_CANDIDATE_APP_EXECUTABLE].includes(executableName)
      || basename(appPath) !== executableName) {
    fail("PROCESS_PROOF_UNAVAILABLE");
  }
  const imageName = executableName.slice(0, -".exe".length);
  // The image name is fixed. Every matching process must disclose both its
  // module path and start time: an access failure therefore rejects the proof
  // rather than silently treating an uninspectable process as absent. For an
  // exact match, Toolhelp supplies its real parent PID and independently
  // rechecks the same creation identity. The expected path remains a validated
  // child-only value, so this query never interpolates a caller-controlled path.
  const query = `$ErrorActionPreference='Stop';${fixedPowerShellExpectedPathPrelude()}${fixedPowerShellUtilityModulePrelude()}$matches=@();foreach($process in [System.Diagnostics.Process]::GetProcessesByName('${imageName}')){try{$processPath=$process.MainModule.FileName;$creationDate=$process.StartTime.ToFileTimeUtc().ToString([System.Globalization.CultureInfo]::InvariantCulture);if($processPath -isnot [string] -or [string]::IsNullOrWhiteSpace($processPath) -or [string]::IsNullOrWhiteSpace($creationDate)){throw 'process-proof'};if([string]::Equals($processPath,$expected,[System.StringComparison]::OrdinalIgnoreCase)){$matches+=[pscustomobject]@{ProcessId=[uint32]$process.Id;CreationDate=$creationDate}}}finally{$process.Dispose()}};if($matches.Count -eq 0){$rows=@()}else{${toolhelpPowerShellTypeDefinition()}$processIds=[uint32[]]@($matches|ForEach-Object {[uint32]$_.ProcessId});$proof=@([TiboTattleWindowsProcessSnapshot]::Read([uint32]0,$processIds));$rows=@();foreach($match in $matches){$evidence=@($proof|Where-Object {$_.ProcessId -eq $match.ProcessId -and [string]::Equals($_.CreationDate,$match.CreationDate,[System.StringComparison]::Ordinal)});if($evidence.Count -gt 1){throw 'process-proof'};if($evidence.Count -eq 1){$rows+=$evidence[0]}}};[Console]::Out.Write((ConvertTo-Json -InputObject @($rows) -Compress -Depth 2))`;
  return Object.freeze([
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    query,
  ]);
}

async function defaultReadInstalledExecutableProcesses({ appPath, environment, runProgram }) {
  const command = systemPowerShellExecutable(environment);
  const result = await runProgram(command, buildWindowsExactExecutableProcessQueryArguments(appPath), {
    timeoutMs: PROCESS_SNAPSHOT_TIMEOUT_MS,
    captureOutput: true,
    environment,
    fixedProbePath: appPath,
    fixedPowerShellUtilityModules: true,
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
  firstLaunchDiagnostic = null,
} = {}) {
  if (typeof readyBarrier !== "function") fail("PROCESS_PROOF_UNAVAILABLE");
  const protocol = createWindowsAccountlessSmokeProtocol(child, { timeoutMs, observations });
  const request = async (command, phase) => {
    setFirstLaunchPhase(firstLaunchDiagnostic, phase);
    try {
      return await protocol.request(command);
    } catch (error) {
      recordFirstLaunchFailure(firstLaunchDiagnostic, error);
      throw error;
    }
  };
  try {
    const deadline = Date.now() + timeoutMs;
    let tracked = null;
    while (true) {
      const state = await request("status-v1", "ready_private_ipc");
      if (state.started && state.primary && state.window && state.tray) {
        setFirstLaunchPhase(firstLaunchDiagnostic, "ready_process_identity");
        tracked = await readyBarrier();
        if (!Array.isArray(tracked)) fail("PROCESS_PROOF_UNAVAILABLE");
        break;
      }
      if (Date.now() >= deadline) fail("APPLICATION_STARTUP_TIMEOUT");
      await delay(250);
    }
    if (observations) observations.storageRequested = true;
    await request("accountless-storage-v1", "accountless_storage_private_ipc");
    if (observations) observations.storagePassed = true;
    if (observations) observations.accountObservationStorageRequested = true;
    await request("account-observation-storage-v1", "account_observation_storage_private_ipc");
    if (observations) observations.accountObservationStoragePassed = true;
    await request("quit-v1", "quit_private_ipc");
    if (observations) observations.quitAcknowledged = true;
    setFirstLaunchPhase(firstLaunchDiagnostic, "quit_child_exit");
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
  qualificationRunId,
  environment,
  spawnApplication = spawn,
  exercise = exerciseWindowsNsisLifecycleSmoke,
  observeStderr = observeWindowsSmokeStderr,
  readProcessSnapshot = defaultReadWindowsProcessSnapshot,
  readInstalledExecutableProcesses = defaultReadInstalledExecutableProcesses,
  stopChild = defaultStopOwnedChild,
  runProgram = defaultRunProgram,
  firstLaunchDiagnostic = null,
}) {
  let selectedQualificationRunId;
  try {
    selectedQualificationRunId = validateWindowsElectronQualificationRunId(qualificationRunId);
  } catch {
    fail("APPLICATION_LAUNCH_UNAVAILABLE");
  }
  const observationLifecyclePhase = launchOrdinal === 1
    ? WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_LIFECYCLE_FIRST_PHASE
    : launchOrdinal === 2
      ? WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_LIFECYCLE_RESTART_PHASE
      : null;
  if (observationLifecyclePhase === null) fail("APPLICATION_LAUNCH_UNAVAILABLE");
  const spec = buildWindowsDevelopmentLaunchSpec({ appPath, profile, environment });
  let child = null;
  let tracker = null;
  let primaryError = null;
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
  recordFirstLaunchObservations(firstLaunchDiagnostic, observations);
  try {
    // This is a point-in-time read immediately before each top-level spawn.
    // It prevents a later launch from accepting an exact installed Electron
    // executable that survived the preceding lifecycle step.
    setFirstLaunchPhase(firstLaunchDiagnostic, "installed_executable_prelaunch_read");
    if ((await readInstalledExecutableProcesses({ appPath, environment, runProgram })).length !== 0) {
      fail("INSTALLED_EXECUTABLE_PRESENT_BEFORE_LAUNCH");
    }
    setFirstLaunchPhase(firstLaunchDiagnostic, "launcher_child_spawn");
    try {
      child = spawnApplication(spec.command, spec.args, {
        ...spec.options,
        env: {
          ...spec.options.env,
          GITHUB_ACTIONS: "true",
          USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "windows-v1",
          USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION: "windows-account-observation-fd4-v1",
          USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID: selectedQualificationRunId,
          [WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_LIFECYCLE_PHASE_ENVIRONMENT_KEY]: observationLifecyclePhase,
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
    } catch {
      fail("APPLICATION_LAUNCH_UNAVAILABLE");
    }
    if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) fail("APPLICATION_LAUNCH_UNAVAILABLE");
    observeStderr(child.stderr, observations);
    tracker = observeOwnedProcessTreeAtReady(
      child,
      () => readProcessSnapshot({
        environment,
        runProgram,
        rootProcessId: child.pid,
        retainedProcessIds: null,
      }),
    );
    setFirstLaunchPhase(firstLaunchDiagnostic, "ready_private_ipc");
    const tracked = await exercise(child, {
      observations,
      readyBarrier: () => tracker.wait(),
      firstLaunchDiagnostic,
    });
    setFirstLaunchPhase(firstLaunchDiagnostic, "process_identity_post_exit");
    assertWindowsProcessTreeExited(
      tracked,
      await readProcessSnapshot({
        environment,
        runProgram,
        rootProcessId: null,
        retainedProcessIds: tracked.map(({ pid }) => pid),
      }),
    );
    setFirstLaunchPhase(firstLaunchDiagnostic, "installed_executable_post_exit_read");
    if ((await readInstalledExecutableProcesses({ appPath, environment, runProgram })).length !== 0) {
      fail("INSTALLED_EXECUTABLE_REMAINS");
    }
    setFirstLaunchPhase(firstLaunchDiagnostic, "completed");
    return Object.freeze({
      pid: child.pid,
      observedProcessTreeExited: true,
      installedExecutableAbsentAtPreLaunchSnapshot: true,
      installedExecutableAbsentAtPostExitSnapshot: true,
      storageJourneyCompleted: observations.storagePassed === true
        && observations.accountObservationStoragePassed === true,
    });
  } catch (error) {
    primaryError = error;
    recordFirstLaunchFailure(firstLaunchDiagnostic, error);
    throw error;
  } finally {
    tracker?.close();
    let stopped = false;
    try {
      stopped = await stopChild(child, { environment, runProgram });
    } catch {
      stopped = false;
    }
    if (!stopped && primaryError === null) {
      setFirstLaunchPhase(firstLaunchDiagnostic, "launcher_child_cleanup");
      const cleanupError = fixedError("PROCESS_CLEANUP_UNCONFIRMED");
      recordFirstLaunchFailure(firstLaunchDiagnostic, cleanupError);
      throw cleanupError;
    }
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
    return postUninstallResult("postcondition_probe_unavailable");
  }
  let startedAt;
  try {
    startedAt = monotonicNow();
  } catch {
    return postUninstallResult("postcondition_probe_unavailable");
  }
  if (!Number.isFinite(startedAt)) {
    return postUninstallResult("postcondition_probe_unavailable");
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
  let lastPhase = "postcondition_budget_exhausted";
  for (let attempt = 0; attempt < UNINSTALL_POSTCONDITION_ATTEMPTS; attempt += 1) {
    if (!(remainingBudget() > 0)) break;
    let installRootAbsent;
    try {
      installRootAbsent = await isMissing(installationRoot);
    } catch {
      return postUninstallResult("install_root_probe_unavailable");
    }
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
    let uninstallRegistryAbsent;
    try {
      uninstallRegistryAbsent = (await inspectRegistry({
        environment,
        runProgram,
        expectedInstallationRoot: installationRoot,
        timeoutMs: registryTimeoutMs,
      })) === REGISTRY_ABSENT;
    } catch (error) {
      return postUninstallResult(
        "uninstall_registry_probe_unavailable",
        error?.postUninstallRegistryProbeFailureCode,
      );
    }
    if (!(remainingBudget() >= 0)) break;
    if (installRootAbsent && uninstallRegistryAbsent) {
      return postUninstallResult("both_predicates_absent");
    }
    lastPhase = installRootAbsent
      ? "uninstall_registry_present"
      : uninstallRegistryAbsent
        ? "install_root_present"
        : "both_predicates_present";
    if (attempt + 1 < UNINSTALL_POSTCONDITION_ATTEMPTS) {
      const remainingBeforeWait = remainingBudget();
      const delayMs = remainingBeforeWait === null
        ? 0
        : Math.min(UNINSTALL_POSTCONDITION_INTERVAL_MS, Math.floor(remainingBeforeWait));
      if (delayMs <= 0) break;
      try {
        await waitForCleanupPoll(delayMs);
      } catch {
        return postUninstallResult("postcondition_wait_unavailable");
      }
    }
  }
  return postUninstallResult(lastPhase);
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
  firstLaunchDiagnostic,
  launches,
  uninstallationAttempted,
  uninstallationPerformed,
  uninstallerSettled,
  inPlaceUninstallerResidueRemoved,
  installRootAbsent,
  uninstallRegistryAbsent,
  postUninstallDiagnostic,
  ownedTemporaryRootRemoved,
}) {
  const first = launches[0] ?? null;
  const second = launches[1] ?? null;
  const boundedFirstLaunch = boundedFirstLaunchDiagnostic(firstLaunchDiagnostic);
  const boundedPostUninstall = boundedPostUninstallDiagnostic(postUninstallDiagnostic);
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
    firstLaunchPhase: boundedFirstLaunch.phase,
    firstLaunchFailureCode: boundedFirstLaunch.failureCode,
    firstLaunchObservations: boundedFirstLaunch.observations,
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
    // Only true when the runner removed one digest-matched in-place
    // uninstaller and then removed its otherwise-empty install directory.
    // The final root/registry checks below remain the cleanup authority.
    inPlaceUninstallerResidueRemoved: inPlaceUninstallerResidueRemoved === true,
    installRootAbsent,
    uninstallRegistryAbsent,
    postUninstallPhase: boundedPostUninstall.phase,
    postUninstallFailureCode: boundedPostUninstall.failureCode,
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

function lifecycleEntrypointRunning() {
  return resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
}

function emitLifecycleFailureDiagnostics(receipt) {
  if (!lifecycleEntrypointRunning() || receipt?.status !== "failed") return;
  try {
    process.stderr.write(`${PREFIX}DIAGNOSTIC_FIRST_LAUNCH_PHASE=${receipt.firstLaunchPhase.toUpperCase()}\n`);
    process.stderr.write(`${PREFIX}DIAGNOSTIC_FIRST_LAUNCH_FAILURE=${receipt.firstLaunchFailureCode ?? "NONE"}\n`);
    process.stderr.write(`${PREFIX}DIAGNOSTIC_POST_UNINSTALL_PHASE=${receipt.postUninstallPhase.toUpperCase()}\n`);
  } catch {
    // The reserved receipt is the durable evidence if CI stderr is unavailable.
  }
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
  let uninstallerIdentity = null;
  let errorCode = null;
  let installationAttempted = false;
  let installationPerformed = false;
  let installerSettled = null;
  let preexistingRegistryAbsent = false;
  let firstInstalledBytesVerified = false;
  let secondInstalledBytesVerified = false;
  let sameInstalledApplicationBytesBound = false;
  let firstRunAcknowledgementPrepared = false;
  const qualificationRunId = randomUUID();
  const firstLaunchDiagnostic = createFirstLaunchDiagnostic();
  const launches = [];
  let uninstallationAttempted = false;
  let uninstallationPerformed = false;
  let uninstallerSettled = null;
  let inPlaceUninstallerResidueRemoved = false;
  let installRootAbsent = false;
  let uninstallRegistryAbsent = false;
  let postUninstallDiagnostic = postUninstallResult("not_attempted");
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
    uninstallerIdentity = await assertUninstaller(uninstallerPath);
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
    setFirstLaunchPhase(firstLaunchDiagnostic, "launcher_child_spawn");
    const first = assertLaunchResult(await launchAndExercise({
      appPath,
      profile,
      launchOrdinal: 1,
      qualificationRunId,
      environment,
      runProgram,
      firstLaunchDiagnostic,
    }));
    setFirstLaunchPhase(firstLaunchDiagnostic, "completed");
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
      qualificationRunId,
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
    const uninstallerOutcome = await executeUninstaller({
      uninstallerPath,
      installationRoot,
      environment,
      runProgram,
    });
    uninstallerSettled = uninstallerOutcome?.settled === true;
    const checkedUninstallerOutcome = assertProgramExecutionOutcome(uninstallerOutcome, "UNINSTALLER");
    if (!checkedUninstallerOutcome.settled) fail("UNINSTALLER_UNSETTLED");
    if (!checkedUninstallerOutcome.succeeded) fail("UNINSTALLER_FAILED");
    uninstallationPerformed = true;
    if (validDigest(uninstallerIdentity)) {
      inPlaceUninstallerResidueRemoved = await completeInPlaceUninstallerResidue({
        installationRoot,
        uninstallerPath,
        uninstallerIdentity,
        environment,
        runProgram,
        isMissing,
        inspectRegistry,
      });
    }
  } catch (error) {
    if (firstLaunchDiagnostic.phase !== "not_reached"
        && firstLaunchDiagnostic.phase !== "completed"
        && !FIRST_LAUNCH_FAILURE_CODES.has(firstLaunchDiagnostic.failureCode)) {
      recordFirstLaunchFailure(firstLaunchDiagnostic, error);
    }
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
          uninstallerIdentity = await assertUninstaller(uninstallerPath);
          uninstallationAttempted = true;
          const cleanupUninstallerOutcome = await executeUninstaller({
            uninstallerPath,
            installationRoot,
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
          if (validDigest(uninstallerIdentity)) {
            inPlaceUninstallerResidueRemoved = await completeInPlaceUninstallerResidue({
              installationRoot,
              uninstallerPath,
              uninstallerIdentity,
              environment,
              runProgram,
              isMissing,
              inspectRegistry,
            });
          }
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
        postUninstallDiagnostic = await observeUninstallPostconditions({
          installationRoot,
          environment,
          runProgram,
          isMissing,
          inspectRegistry,
          waitForCleanupPoll,
          monotonicNow,
          budgetMs: uninstallPostconditionBudgetMs,
          terminationGraceMs: uninstallProgramTerminationGraceMs,
        });
        ({ installRootAbsent, uninstallRegistryAbsent } = postUninstallDiagnostic);
        if (!installRootAbsent || !uninstallRegistryAbsent) {
          recordCleanupFailure();
        }
      } catch {
        postUninstallDiagnostic = postUninstallResult("postcondition_probe_unavailable");
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
      firstLaunchDiagnostic,
      launches,
      uninstallationAttempted,
      uninstallationPerformed,
      uninstallerSettled,
      inPlaceUninstallerResidueRemoved,
      installRootAbsent,
      uninstallRegistryAbsent,
      postUninstallDiagnostic,
      ownedTemporaryRootRemoved,
    });
    try {
      await receiptHandle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
      await receiptHandle.sync();
    } finally {
      await receiptHandle.close();
    }
    emitLifecycleFailureDiagnostics(receipt);
  }
  if (errorCode) throw Object.assign(new Error(errorCode), { code: errorCode });
  return Object.freeze({ status: "passed", ...installerIdentity, ...identity });
}

if (lifecycleEntrypointRunning()) {
  try {
    process.stdout.write(`${JSON.stringify(await runWindowsNsisLifecycle(
      parseWindowsNsisLifecycleArguments(process.argv.slice(2)),
    ))}\n`);
  } catch (error) {
    process.stderr.write(`${fixedCode(error)}\n`);
    process.exitCode = 1;
  }
}
