import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { isProxy } from "node:util/types";
import { defaultExportStateDirectory } from "./participant-identity.js";
import { isWindowsProtectedStateStore } from "./windows-protected-state-store.js";
import { assertWindowsProductionReadiness } from "./windows-production-readiness.js";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const STATE_SCHEMA = "claude-callback-lifecycle-v1";
const WINDOWS_RUNNER_SCHEMA = "claude-callback-runner-v1";
const WINDOWS_RUNNER_KINDS = new Set(["git_bash", "powershell"]);
const STATE_FILE = "lifecycle-state.json";
const STATE_PENDING_FILE = ".lifecycle-state.pending";
const LOCK_FILE = "operation.lock";
const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 128 * 1024;
const BUFFER_FILL = Buffer.prototype.fill;
const IS_BUFFER = Buffer.isBuffer;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
).get;
const ERROR_CODES = new Set([
  "invalid_configuration",
  "settings_parent",
  "settings_missing",
  "settings_type",
  "settings_owner",
  "settings_mode",
  "settings_links",
  "settings_size",
  "settings_json",
  "settings_replaced",
  "settings_write",
  "state_directory",
  "state_file",
  "state_shape",
  "state_replaced",
  "state_write",
  "busy",
  "conflict",
  "coexistence_unsupported",
  "runtime_state",
  "not_uninstalled",
  "windows_state_unqualified",
]);

const WINDOWS_SYSTEM_ROOT_DEFAULT = "C:\\Windows";
const WINDOWS_GIT_BASH_RELATIVE_PATHS = Object.freeze([
  ["ProgramFiles", "Git", "bin", "bash.exe"],
  ["ProgramW6432", "Git", "bin", "bash.exe"],
  ["LOCALAPPDATA", "Programs", "Git", "bin", "bash.exe"],
  ["USERPROFILE", "scoop", "apps", "git", "current", "bin", "bash.exe"],
]);

function fixedRunnerError() {
  fail("coexistence_unsupported");
}

export class ClaudeCallbackLifecycleError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) throw new TypeError("Unknown Claude callback lifecycle error code");
    super("Claude callback lifecycle operation failed");
    this.name = "ClaudeCallbackLifecycleError";
    this.code = `claude_callback_lifecycle_${code}`;
  }
}

function fail(code) {
  throw new ClaudeCallbackLifecycleError(code);
}

/**
 * The callback lifecycle owns Windows-sensitive settings, state, and lock
 * paths. Windows calls must be composed from two repository-branded protected
 * stores: one rooted at the lifecycle directory and one rooted at the Claude
 * settings parent. The stores remain unqualified while native proof is
 * pending; this function checks composition and path ownership only.
 */
function selectedPlatform(options = {}) {
  let requestedPlatform;
  const runtimePlatform = process.platform;
  try {
    requestedPlatform = options?.platform;
  } catch {
    fail("invalid_configuration");
  }
  const platform = requestedPlatform === undefined ? runtimePlatform : requestedPlatform;
  if (typeof platform !== "string" || platform.length < 1 || platform.length > 32) {
    fail("invalid_configuration");
  }
  if (runtimePlatform === "win32") {
    if (platform !== "win32") fail("windows_state_unqualified");
    return "win32";
  }
  if (platform === runtimePlatform) return runtimePlatform;
  if (platform === "win32") return "win32";
  fail("invalid_configuration");
}

function canonicalWindowsPath(path, code = "invalid_configuration") {
  if (typeof path !== "string" || path.length < 4 || path.length > 4096 || path.includes("\0")) {
    fail(code);
  }
  let normalized;
  try {
    normalized = win32.normalize(path.replaceAll("/", "\\"));
  } catch {
    fail(code);
  }
  if (!win32.isAbsolute(normalized) || !/^(?:\\\\\?\\)?[A-Za-z]:\\/u.test(normalized)) {
    fail(code);
  }
  return normalized.endsWith("\\") && normalized.length > 3
    ? normalized.slice(0, -1)
    : normalized;
}

function sameWindowsPath(left, right) {
  return canonicalWindowsPath(left).toLowerCase() === canonicalWindowsPath(right).toLowerCase();
}

function runnerRecord(value) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)
        || isProxy(value)
        || Object.keys(value).sort().join("\0") !== "executable\0kind\0schemaVersion"
        || value.schemaVersion !== WINDOWS_RUNNER_SCHEMA
        || !WINDOWS_RUNNER_KINDS.has(value.kind)) {
      fixedRunnerError();
    }
    const executable = canonicalWindowsPath(value.executable);
    if (/[\u0001-\u001f]/u.test(executable)) fixedRunnerError();
    if (value.kind === "git_bash") {
      const reviewedGitBashPath = /^(?:[a-z]:\\program files(?: \(x86\))?\\git\\bin\\bash\.exe|[a-z]:\\users\\[^\\]+\\appdata\\local\\programs\\git\\bin\\bash\.exe|[a-z]:\\users\\[^\\]+\\scoop\\apps\\git\\current\\bin\\bash\.exe)$/iu;
      if (!reviewedGitBashPath.test(executable)) fixedRunnerError();
    } else if (
      !/^[a-z]:\\windows\\system32\\windowspowershell\\v1\.0\\powershell\.exe$/iu.test(executable)
    ) {
      fixedRunnerError();
    }
    return Object.freeze({
      schemaVersion: WINDOWS_RUNNER_SCHEMA,
      kind: value.kind,
      executable,
    });
  } catch (error) {
    // Preserve our closed lifecycle code, collapsing hostile getters/proxies
    // and malformed runner records to the same content-free outcome.
    if (error instanceof ClaudeCallbackLifecycleError) throw error;
    fixedRunnerError();
  }
}

function sameRunnerIdentity(left, right) {
  try {
    const first = runnerRecord(left);
    const second = runnerRecord(right);
    return first.kind === second.kind
      && first.executable.toLowerCase() === second.executable.toLowerCase();
  } catch {
    return false;
  }
}

function windowsRunnerDescriptor(kind, executable) {
  return runnerRecord({
    schemaVersion: WINDOWS_RUNNER_SCHEMA,
    kind,
    executable,
  });
}

function environmentString(environment, key) {
  const value = environmentValue(environment, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Select the only two reviewed Windows command runners. Git Bash is preferred
 * because it matches the POSIX command language Claude already documents; the
 * inbox Windows PowerShell is the deterministic fallback. This is deliberately
 * synchronous: installation must select and persist one runner before it can
 * mutate Claude settings. Runtime replay uses the persisted descriptor and
 * never re-selects a different shell.
 */
export function selectClaudeCallbackRunner({
  platform = process.platform,
  environment = process.env,
  exists = existsSync,
  runner = null,
} = {}) {
  if (platform !== "win32") return null;
  if (typeof exists !== "function") fixedRunnerError();
  if (runner !== null) return runnerRecord(runner);
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    fixedRunnerError();
  }
  for (const [rootKey, ...parts] of WINDOWS_GIT_BASH_RELATIVE_PATHS) {
    const root = environmentString(environment, rootKey);
    if (!root) continue;
    let candidate;
    try {
      candidate = win32.join(canonicalWindowsPath(root), ...parts);
    } catch {
      continue;
    }
    try {
      if (exists(candidate)) return windowsRunnerDescriptor("git_bash", candidate);
    } catch {
      // A hostile or inaccessible candidate is not a runner. Continue to the
      // next fixed location and ultimately to the PowerShell fallback.
    }
  }
  const systemRoot = environmentString(environment, "SystemRoot") ?? WINDOWS_SYSTEM_ROOT_DEFAULT;
  let powershell;
  try {
    powershell = win32.join(canonicalWindowsPath(systemRoot),
      "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  } catch {
    fixedRunnerError();
  }
  try {
    if (exists(powershell)) return windowsRunnerDescriptor("powershell", powershell);
  } catch {
    // Fall through to the fixed coexistence error without exposing the path.
  }
  fixedRunnerError();
}

export function validateClaudeCallbackRunner(value) {
  return runnerRecord(value);
}

function runnerCommandArguments(runner, command) {
  const selected = runnerRecord(runner);
  if (selected.kind === "git_bash") {
    return {
      command: selected.executable,
      args: ["--noprofile", "--norc", "-c", command],
    };
  }
  return {
    command: selected.executable,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
  };
}

export function buildClaudeCallbackRunnerInvocation(runner, command) {
  if (typeof command !== "string" || command.length < 1 || command.length > 8192
      || command.includes("\0")) fixedRunnerError();
  return runnerCommandArguments(runner, command);
}

const WINDOWS_CLAUDE_INVALID_COMPONENT = /[<>:"|?*]/u;
const WINDOWS_CLAUDE_DEVICE_STEM = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

function isReservedClaudeWindowsComponent(component) {
  const stem = component.split(".", 1)[0].replace(/[ .]+$/gu, "");
  return WINDOWS_CLAUDE_DEVICE_STEM.test(stem);
}

function assertClaudeWindowsComponent(component) {
  if (component === "") return;
  if (component === "." || component === ".."
      || WINDOWS_CLAUDE_INVALID_COMPONENT.test(component)
      || /[. ]$/u.test(component)
      || isReservedClaudeWindowsComponent(component)) {
    fail("invalid_configuration");
  }
}

function canonicalClaudeWindowsPath(path) {
  if (typeof path !== "string" || path.length < 4 || path.length > 4096
      || !/^[A-Za-z]:[\\/]/u.test(path) || path.includes("\0")
      || /[\u0001-\u001f]/u.test(path)) {
    fail("invalid_configuration");
  }
  const input = path.replaceAll("/", "\\");
  const withoutDrive = input.slice(3);
  // Repeated separators are intentionally accepted and canonicalized by the
  // shared Win32 normalizer; every non-empty component remains policy-checked.
  for (const component of withoutDrive.split("\\")) assertClaudeWindowsComponent(component);
  return canonicalWindowsPath(path, "invalid_configuration");
}

function environmentValue(environment, key) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment) || isProxy(environment)) {
    fail("invalid_configuration");
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(environment, key);
    if (descriptor === undefined) return undefined;
    if (!Object.hasOwn(descriptor, "value")) fail("invalid_configuration");
    return descriptor.value;
  } catch (error) {
    if (error instanceof ClaudeCallbackLifecycleError) throw error;
    fail("invalid_configuration");
  }
}

function resolveClaudeConfigRoot(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options) || isProxy(options)) {
    fail("invalid_configuration");
  }
  const platform = selectedPlatform(options);
  const environment = Object.hasOwn(options, "environment")
    ? options.environment
    : process.env;
  const configuredHome = Object.hasOwn(options, "homeDirectory")
    ? options.homeDirectory
    : platform === "win32"
      ? environmentValue(environment, "USERPROFILE") ?? homedir()
      : homedir();
  const configCandidate = Object.hasOwn(options, "claudeConfigDirectory")
    ? options.claudeConfigDirectory
    : environmentValue(environment, "CLAUDE_CONFIG_DIR");
  if (platform === "win32") {
    const home = canonicalClaudeWindowsPath(configuredHome);
    const configDirectory = configCandidate === undefined
      ? win32.join(home, ".claude")
      : canonicalClaudeWindowsPath(configCandidate);
    return Object.freeze({
      platform,
      homeDirectory: home,
      configDirectory,
      settingsFile: win32.join(configDirectory, "settings.json"),
    });
  }
  if (typeof configuredHome !== "string" || !isAbsolute(configuredHome)
      || resolve(configuredHome) !== configuredHome) {
    fail("invalid_configuration");
  }
  if (configCandidate !== undefined && (typeof configCandidate !== "string"
      || !isAbsolute(configCandidate) || resolve(configCandidate) !== configCandidate)) {
    fail("invalid_configuration");
  }
  const configDirectory = configCandidate === undefined
    ? join(configuredHome, ".claude")
    : configCandidate;
  return Object.freeze({
    platform,
    homeDirectory: configuredHome,
    configDirectory,
    settingsFile: join(configDirectory, "settings.json"),
  });
}

function assertWindowsProtectedStores(options, { lifecycleDirectory, settingsFile }) {
  if (selectedPlatform(options) !== "win32") return null;
  let lifecycleStore;
  let settingsStore;
  try {
    lifecycleStore = options?.windowsLifecycleStore ?? null;
    settingsStore = options?.windowsSettingsStore ?? null;
  } catch {
    fail("invalid_configuration");
  }
  if (!isWindowsProtectedStateStore(lifecycleStore)
      || !isWindowsProtectedStateStore(settingsStore)) {
    fail("windows_state_unqualified");
  }
  if (process.platform === "win32") {
    try {
      assertWindowsProductionReadiness({
        platform: "win32",
        architecture: process.arch,
        readiness: options?.windowsReadiness ?? null,
      });
    } catch {
      fail("windows_state_unqualified");
    }
    for (const store of [lifecycleStore, settingsStore]) {
      let qualified = false;
      try {
        qualified = store.productionSafe === true
          && store.rootBindingSafe === true
          && store.nativeReadBounded === true;
      } catch {
        qualified = false;
      }
      if (!qualified) fail("windows_state_unqualified");
    }
  }
  let lifecycleRoot;
  let settingsRoot;
  try {
    lifecycleRoot = lifecycleStore.rootPath;
    settingsRoot = settingsStore.rootPath;
  } catch {
    fail("windows_state_unqualified");
  }
  if (!sameWindowsPath(lifecycleDirectory, lifecycleRoot)) {
    fail("windows_state_unqualified");
  }
  const settingsPath = canonicalWindowsPath(settingsFile);
  const settingsParent = win32.dirname(settingsPath);
  const settingsName = win32.basename(settingsPath);
  if (!sameWindowsPath(settingsParent, settingsRoot)
      || settingsName.toLowerCase() !== "settings.json") {
    fail("windows_state_unqualified");
  }
  return Object.freeze({
    lifecycleStore,
    settingsStore,
    stateName: STATE_FILE,
    pendingName: STATE_PENDING_FILE,
    lockName: LOCK_FILE,
    settingsName: "settings.json",
  });
}

function assertWindowsLifecycleStateSupported(options = {}, paths = {}) {
  if (selectedPlatform(options) !== "win32") return null;
  return assertWindowsProtectedStores(options, paths);
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function sameProtectedIdentity(left, right) {
  return left?.volumeSerialNumber === right?.volumeSerialNumber
    && left?.fileId === right?.fileId
    && left?.linkCount === right?.linkCount;
}

function digestBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isProtectedStoreError(error, suffix) {
  return error?.code === `windows_protected_state_store_${suffix}`;
}

function protectedStoreFailure(error, code) {
  if (error instanceof ClaudeCallbackLifecycleError) throw error;
  fail(code);
}

async function lstatIfExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("state_file");
  }
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertOwnedDirectory(stats, code, { ownerOnly = false } = {}) {
  if (!stats?.isDirectory() || stats.isSymbolicLink()) fail(code);
  if (currentUid() !== null && stats.uid !== currentUid()) fail(code);
  if (process.platform !== "win32"
      && (ownerOnly ? (stats.mode & 0o777) !== 0o700 : (stats.mode & 0o022) !== 0)) fail(code);
}

async function assertCanonicalOwnedDirectory(path, code, options = {}) {
  const target = resolve(path);
  const stats = await lstatIfExists(target);
  if (!stats) fail(code);
  assertOwnedDirectory(stats, code, options);
  let canonical;
  try {
    canonical = await realpath(target);
  } catch {
    fail(code);
  }
  if (canonical !== target) fail(code);
  return { dev: stats.dev, ino: stats.ino };
}

async function ensureLifecycleDirectory(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096) fail("invalid_configuration");
  const target = resolve(path);
  const parent = dirname(target);
  const parentStats = await lstatIfExists(parent);
  if (!parentStats) {
    try {
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await chmod(parent, 0o700);
    } catch {
      fail("state_directory");
    }
  }
  await assertCanonicalOwnedDirectory(parent, "state_directory", { ownerOnly: true });
  let created = false;
  try {
    await mkdir(target, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") fail("state_directory");
  }
  if (created) await chmod(target, 0o700).catch(() => fail("state_directory"));
  return assertCanonicalOwnedDirectory(target, "state_directory", { ownerOnly: true });
}

function assertStrictFile(stats, { code, maximumBytes, allowEmpty = false, mode = 0o600 }) {
  if (!stats?.isFile() || stats.isSymbolicLink()) fail(code);
  if (stats.nlink !== 1) fail(code);
  if (currentUid() !== null && stats.uid !== currentUid()) fail(code);
  if (process.platform !== "win32" && (stats.mode & 0o777) !== mode) fail(code);
  if ((!allowEmpty && stats.size < 1) || stats.size > maximumBytes) fail(code);
}

async function readStrictFile(path, {
  code,
  maximumBytes,
  allowMissing = false,
  allowEmpty = false,
  mode = 0o600,
}) {
  const pathStats = await lstatIfExists(path);
  if (!pathStats) {
    if (allowMissing) return null;
    fail(code);
  }
  assertStrictFile(pathStats, { code, maximumBytes, allowEmpty, mode });
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const opened = await handle.stat();
    assertStrictFile(opened, { code, maximumBytes, allowEmpty, mode });
    if (!sameIdentity(pathStats, opened) || pathStats.size !== opened.size) fail(code);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameIdentity(opened, after) || after.size !== bytes.byteLength) fail(code);
    return { bytes, stats: after };
  } catch (error) {
    if (error instanceof ClaudeCallbackLifecycleError) throw error;
    fail(code);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function digestValue(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function equalValue(left, right) {
  return digestValue(left) === digestValue(right);
}

function validateStatusLineBackup(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== "present\0value"
      || typeof value.present !== "boolean") fail("state_shape");
  if (!value.present && value.value !== null) fail("state_shape");
  const bytes = Buffer.byteLength(stableJson(value));
  if (bytes > 64 * 1024) fail("state_shape");
  return value;
}

function validateManagedStatusLine(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== "command\0type"
      || value.type !== "command"
      || typeof value.command !== "string"
      || value.command.length < 1
      || value.command.length > 8192) fail("state_shape");
  return value;
}

function validateCoexistingStatusLine(backup) {
  validateStatusLineBackup(backup);
  if (!backup.present) return null;
  const value = backup.value;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== "command\0type"
      || value.type !== "command"
      || typeof value.command !== "string"
      || value.command.length < 1
      || value.command.length > 8192
      || value.command.includes("\0")) fail("coexistence_unsupported");
  return value.command;
}

function assertManagedStateMatches(state, installedStatusLine) {
  if (state && !equalValue(state.installedStatusLine, installedStatusLine)) fail("conflict");
}

function assertStateRunnerCompatibility(state, platform) {
  if (platform !== "win32" || state === null || state.phase === "uninstalled") return;
  if (state.previousStatusLine?.present
      && (!Object.hasOwn(state, "previousRunner") || state.previousRunner === null)) {
    // Do not rediscover a shell for a legacy state: doing so could replay the
    // user's command under different semantics and would make recovery mutate
    // settings before coexistence has been established.
    fail("coexistence_unsupported");
  }
}

function validateLifecycleState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("state_shape");
  const keys = Object.keys(value).sort().join("\0");
  if (keys !== "installedStatusLine\0operationId\0phase\0previousStatusLine\0schemaVersion"
      && keys !== "installedStatusLine\0operationId\0phase\0previousRunner\0previousStatusLine\0schemaVersion") {
    fail("state_shape");
  }
  if (value.schemaVersion !== STATE_SCHEMA
      || !["install_prepared", "installed", "uninstall_prepared", "uninstalled"].includes(value.phase)
      || (value.operationId !== null && (typeof value.operationId !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value.operationId)))) fail("state_shape");
  validateManagedStatusLine(value.installedStatusLine);
  if (value.phase === "uninstalled") {
    if (value.previousStatusLine !== null || value.operationId !== null) fail("state_shape");
  } else {
    validateStatusLineBackup(value.previousStatusLine);
    if (value.operationId === null) fail("state_shape");
  }
  if (Object.hasOwn(value, "previousRunner")) {
    if (value.previousRunner !== null) validateClaudeCallbackRunner(value.previousRunner);
    const priorPresent = value.previousStatusLine !== null
      && value.previousStatusLine.present === true;
    if (priorPresent !== (value.previousRunner !== null)) fail("state_shape");
  } else if (value.previousStatusLine?.present && value.schemaVersion === STATE_SCHEMA
      && value.phase !== "uninstalled") {
    // Older POSIX states intentionally have no runner field. A Windows
    // runtime will reject this legacy shape before it can execute the command.
  }
  return value;
}

async function readLifecycleState(directory, storage = null) {
  if (storage) {
    let result;
    try {
      result = storage.lifecycleStore.readJson(storage.stateName);
    } catch (error) {
      if (isProtectedStoreError(error, "missing")) return null;
      protectedStoreFailure(error, "state_file");
    }
    validateLifecycleState(result.value);
    if (stableJson(result.value) !== result.data.toString("utf8")) fail("state_shape");
    return result.value;
  }
  const result = await readStrictFile(join(directory, STATE_FILE), {
    code: "state_file",
    maximumBytes: MAX_STATE_BYTES,
    allowMissing: true,
  });
  if (result === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(result.bytes.toString("utf8"));
  } catch {
    fail("state_shape");
  }
  validateLifecycleState(parsed);
  if (stableJson(parsed) !== result.bytes.toString("utf8")) fail("state_shape");
  return parsed;
}

async function assertPathIdentity(path, expected, { allowMissing = false, code = "state_replaced" } = {}) {
  const current = await lstatIfExists(path);
  if (current === null && allowMissing && expected === null) return;
  if (current === null || expected === null || !sameIdentity(current, expected)) fail(code);
  return current;
}

async function cleanupPendingState(directory, storage = null) {
  if (storage) {
    try {
      storage.lifecycleStore.cleanupPending(storage.pendingName);
      return;
    } catch (error) {
      protectedStoreFailure(error, "state_write");
    }
  }
  const pendingPath = join(directory, STATE_PENDING_FILE);
  const pending = await lstatIfExists(pendingPath);
  if (!pending) return;
  assertStrictFile(pending, { code: "state_file", maximumBytes: MAX_STATE_BYTES });
  await unlink(pendingPath).catch(() => fail("state_write"));
  await syncDirectory(directory).catch(() => fail("state_write"));
}

async function writeLifecycleState(directory, value, storage = null) {
  validateLifecycleState(value);
  const bytes = Buffer.from(stableJson(value));
  if (bytes.byteLength > MAX_STATE_BYTES) fail("state_shape");
  if (storage) {
    await cleanupPendingState(directory, storage);
    let previous = null;
    try {
      previous = storage.lifecycleStore.read(storage.stateName);
    } catch (error) {
      if (!isProtectedStoreError(error, "missing")) protectedStoreFailure(error, "state_file");
    }
    try {
      if (previous) storage.lifecycleStore.replace(storage.stateName, previous.identity, bytes);
      else storage.lifecycleStore.create(storage.stateName, bytes);
    } catch (error) {
      protectedStoreFailure(error, "state_write");
    }
    return;
  }
  await cleanupPendingState(directory);
  const statePath = join(directory, STATE_FILE);
  const previous = await lstatIfExists(statePath);
  if (previous) assertStrictFile(previous, { code: "state_file", maximumBytes: MAX_STATE_BYTES });
  const pendingPath = join(directory, STATE_PENDING_FILE);
  let handle;
  try {
    handle = await open(pendingPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const pendingStats = await handle.stat();
    assertStrictFile(pendingStats, { code: "state_write", maximumBytes: MAX_STATE_BYTES });
    await handle.close();
    handle = null;
    await assertPathIdentity(statePath, previous, { allowMissing: true });
    await rename(pendingPath, statePath);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    const pending = await lstatIfExists(pendingPath);
    if (pending?.isFile() && pending.nlink === 1) await unlink(pendingPath).catch(() => {});
    if (error instanceof ClaudeCallbackLifecycleError) throw error;
    fail("state_write");
  }
}

async function readSettings(settingsFile, storage = null) {
  if (storage) {
    let result;
    try {
      result = storage.settingsStore.read(storage.settingsName);
    } catch (error) {
      if (isProtectedStoreError(error, "missing")) {
        return {
          path: settingsFile,
          parent: storage.settingsStore.rootPath,
          parentIdentity: null,
          exists: false,
          stats: null,
          identity: null,
          byteLength: 0,
          contentDigest: null,
          mode: 0o600,
          value: {},
          protectedStore: storage.settingsStore,
          protectedName: storage.settingsName,
        };
      }
      protectedStoreFailure(error, "settings_type");
    }
    if (result.data.byteLength < 2 || result.data.byteLength > MAX_SETTINGS_BYTES) {
      fail("settings_size");
    }
    let value;
    try {
      value = JSON.parse(result.data.toString("utf8"));
    } catch {
      fail("settings_json");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("settings_json");
    return {
      path: settingsFile,
      parent: storage.settingsStore.rootPath,
      parentIdentity: null,
      exists: true,
      stats: null,
      identity: result.identity,
      byteLength: result.data.byteLength,
      contentDigest: digestBytes(result.data),
      mode: 0o600,
      value,
      protectedStore: storage.settingsStore,
      protectedName: storage.settingsName,
    };
  }
  if (typeof settingsFile !== "string" || !isAbsolute(settingsFile) || settingsFile.length > 4096) {
    fail("invalid_configuration");
  }
  const path = resolve(settingsFile);
  const parent = dirname(path);
  const parentIdentity = await assertCanonicalOwnedDirectory(parent, "settings_parent");
  const pathStats = await lstatIfExists(path);
  if (!pathStats) return { path, parent, parentIdentity, exists: false, stats: null, mode: 0o600, value: {} };
  if (!pathStats.isFile() || pathStats.isSymbolicLink()) fail("settings_type");
  if (pathStats.nlink !== 1) fail("settings_links");
  if (currentUid() !== null && pathStats.uid !== currentUid()) fail("settings_owner");
  if (process.platform !== "win32" && (pathStats.mode & 0o022) !== 0) fail("settings_mode");
  if (pathStats.size < 2 || pathStats.size > MAX_SETTINGS_BYTES) fail("settings_size");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const opened = await handle.stat();
    if (!sameIdentity(pathStats, opened) || pathStats.size !== opened.size || opened.nlink !== 1) fail("settings_replaced");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameIdentity(opened, after) || after.size !== bytes.byteLength) fail("settings_replaced");
    let value;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("settings_json");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("settings_json");
    return { path, parent, parentIdentity, exists: true, stats: after, mode: pathStats.mode & 0o777, value };
  } catch (error) {
    if (error instanceof ClaudeCallbackLifecycleError) throw error;
    fail("settings_replaced");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function revalidateSettings(snapshot) {
  if (snapshot.protectedStore) {
    let current;
    try {
      current = snapshot.protectedStore.read(snapshot.protectedName);
    } catch (error) {
      if (isProtectedStoreError(error, "missing")) {
        if (!snapshot.exists) return;
        fail("settings_replaced");
      }
      protectedStoreFailure(error, "settings_replaced");
    }
    if (!snapshot.exists
        || !sameProtectedIdentity(current.identity, snapshot.identity)
        || current.data.byteLength !== snapshot.byteLength
        || digestBytes(current.data) !== snapshot.contentDigest) {
      fail("settings_replaced");
    }
    return;
  }
  const parent = await lstatIfExists(snapshot.parent);
  assertOwnedDirectory(parent, "settings_parent");
  if (!sameIdentity(parent, snapshot.parentIdentity)) fail("settings_replaced");
  const current = await lstatIfExists(snapshot.path);
  if (!snapshot.exists) {
    if (current !== null) fail("settings_replaced");
    return;
  }
  if (!current || !sameIdentity(current, snapshot.stats) || current.size !== snapshot.stats.size
      || current.nlink !== 1 || (process.platform !== "win32" && (current.mode & 0o022) !== 0)) {
    fail("settings_replaced");
  }
}

async function writeSettings(snapshot, value, failpoint = async () => {}) {
  if (typeof failpoint !== "function") fail("invalid_configuration");
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (bytes.byteLength > MAX_SETTINGS_BYTES) fail("settings_size");
  if (snapshot.protectedStore) {
    try {
      await revalidateSettings(snapshot);
      await failpoint("before_settings_replace");
      await revalidateSettings(snapshot);
      if (snapshot.exists) {
        snapshot.protectedStore.replace(snapshot.protectedName, snapshot.identity, bytes);
      } else {
        snapshot.protectedStore.create(snapshot.protectedName, bytes);
      }
    } catch (error) {
      if (error instanceof ClaudeCallbackLifecycleError) throw error;
      if (isProtectedStoreError(error, "already_exists")
          || isProtectedStoreError(error, "identity_mismatch")
          || isProtectedStoreError(error, "missing")) {
        fail("settings_replaced");
      }
      protectedStoreFailure(error, "settings_write");
    }
    return;
  }
  const temporaryPath = join(snapshot.parent, `.settings.json.app-usagemonitor.${randomUUID()}.tmp`);
  let handle;
  let temporaryStats;
  try {
    await revalidateSettings(snapshot);
    handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, snapshot.mode);
    await handle.chmod(snapshot.mode);
    await handle.writeFile(bytes);
    await handle.sync();
    temporaryStats = await handle.stat();
    if (!temporaryStats.isFile() || temporaryStats.nlink !== 1 || temporaryStats.size !== bytes.byteLength) fail("settings_write");
    await failpoint("before_settings_replace");
    await revalidateSettings(snapshot);
    const pathTempStats = await lstatIfExists(temporaryPath);
    if (!pathTempStats || !sameIdentity(pathTempStats, temporaryStats) || pathTempStats.nlink !== 1) fail("settings_replaced");
    await handle.close();
    handle = null;
    await rename(temporaryPath, snapshot.path);
    await syncDirectory(snapshot.parent);
  } catch (error) {
    await handle?.close().catch(() => {});
    const pending = await lstatIfExists(temporaryPath);
    if (pending && temporaryStats && sameIdentity(pending, temporaryStats) && pending.nlink === 1) {
      await unlink(temporaryPath).catch(() => {});
    }
    if (error instanceof ClaudeCallbackLifecycleError) throw error;
    fail("settings_write");
  }
}

function backupFromSettings(settings) {
  const present = Object.hasOwn(settings, "statusLine");
  const value = present ? structuredClone(settings.statusLine) : null;
  return validateStatusLineBackup({ present, value });
}

function applyStatusLine(settings, backup) {
  const next = structuredClone(settings);
  if (backup.present) next.statusLine = structuredClone(backup.value);
  else delete next.statusLine;
  return next;
}

function statusLineMatches(settings, expected) {
  const current = backupFromSettings(settings);
  return current.present === expected.present && equalValue(current.value, expected.value);
}

function managedBackup(installedStatusLine) {
  return { present: true, value: installedStatusLine };
}

function settingsTargetIdentity(settings) {
  if (!settings.exists) return { exists: false };
  if (settings.identity) {
    return {
      exists: true,
      volumeSerialNumber: settings.identity.volumeSerialNumber,
      fileId: settings.identity.fileId,
      linkCount: settings.identity.linkCount,
    };
  }
  return {
    exists: true,
    device: settings.stats.dev,
    inode: settings.stats.ino,
    birthtimeMilliseconds: Math.trunc(settings.stats.birthtimeMs),
  };
}

function shellQuote(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || value.includes("\0")) {
    fail("invalid_configuration");
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function powershellQuote(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096
      || value.includes("\0") || /[\u0001-\u001f]/u.test(value)) {
    fail("invalid_configuration");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function gitBashPath(value) {
  const normalized = canonicalWindowsPath(value, "invalid_configuration");
  const drive = normalized[0].toLowerCase();
  return `/${drive}${normalized.slice(2).replaceAll("\\", "/")}`;
}

function buildWindowsManagedCommand({
  runner,
  nodeExecutable,
  runtimeScript,
}) {
  const selected = runnerRecord(runner);
  const executable = canonicalWindowsPath(nodeExecutable, "invalid_configuration");
  const script = canonicalWindowsPath(runtimeScript, "invalid_configuration");
  if (selected.kind === "git_bash") {
    return `ELECTRON_RUN_AS_NODE=1 ${shellQuote(gitBashPath(executable))} ${shellQuote(gitBashPath(script))}`;
  }
  return `$env:ELECTRON_RUN_AS_NODE = '1'; & ${powershellQuote(executable)} ${powershellQuote(script)}`;
}

export function createClaudeCallbackLifecycleContext(configuration = {}) {
  let ClaudeCallbackCapabilityError;
  let ensureClaudeCallbackCapability;
  let planClaudeCallbackCapabilityRemoval;
  let removeClaudeCallbackCapability;
  let rotateClaudeCallbackCapability;
  let runtimeScript;
  try {
    if (
      configuration === null
      || typeof configuration !== "object"
      || Array.isArray(configuration)
    ) {
      fail("invalid_configuration");
    }
    ClaudeCallbackCapabilityError =
      configuration.ClaudeCallbackCapabilityError;
    ensureClaudeCallbackCapability =
      configuration.ensureClaudeCallbackCapability;
    planClaudeCallbackCapabilityRemoval =
      configuration.planClaudeCallbackCapabilityRemoval;
    removeClaudeCallbackCapability =
      configuration.removeClaudeCallbackCapability;
    rotateClaudeCallbackCapability =
      configuration.rotateClaudeCallbackCapability;
    runtimeScript = configuration.runtimeScript;
  } catch (error) {
    if (error instanceof ClaudeCallbackLifecycleError) throw error;
    fail("invalid_configuration");
  }
  if (
    typeof ClaudeCallbackCapabilityError !== "function"
    || isProxy(ClaudeCallbackCapabilityError)
    || typeof ensureClaudeCallbackCapability !== "function"
    || isProxy(ensureClaudeCallbackCapability)
    || typeof planClaudeCallbackCapabilityRemoval !== "function"
    || isProxy(planClaudeCallbackCapabilityRemoval)
    || typeof removeClaudeCallbackCapability !== "function"
    || isProxy(removeClaudeCallbackCapability)
    || typeof rotateClaudeCallbackCapability !== "function"
    || isProxy(rotateClaudeCallbackCapability)
    || typeof runtimeScript !== "string"
    || !isAbsolute(runtimeScript)
    || runtimeScript.length < 1
    || runtimeScript.length > 4096
    || runtimeScript.includes("\0")
  ) {
    fail("invalid_configuration");
  }
  let capabilityErrorPrototype;
  try {
    capabilityErrorPrototype = ClaudeCallbackCapabilityError.prototype;
    if (
      capabilityErrorPrototype === null
      || typeof capabilityErrorPrototype !== "object"
      || !Object.prototype.isPrototypeOf.call(
        Error.prototype,
        capabilityErrorPrototype,
      )
    ) {
      fail("invalid_configuration");
    }
  } catch (error) {
    if (error instanceof ClaudeCallbackLifecycleError) throw error;
    fail("invalid_configuration");
  }

function defaultClaudeSettingsFile(options = {}) {
  return resolveClaudeConfigRoot(options).settingsFile;
}

function defaultClaudeCallbackLifecycleDirectory(options = {}) {
  return join(defaultExportStateDirectory(options), "claude-callback-lifecycle-v1");
}

function buildManagedClaudeStatusLine({
  nodeExecutable = process.execPath,
  runtimeScript: selectedRuntimeScript = runtimeScript,
  platform = process.platform,
  windowsRunner = null,
  environment = process.env,
} = {}) {
  if (platform === "win32") {
    const runner = selectClaudeCallbackRunner({
      platform,
      environment,
      runner: windowsRunner,
    });
    return Object.freeze({
      type: "command",
      command: buildWindowsManagedCommand({
        runner,
        nodeExecutable,
        runtimeScript: selectedRuntimeScript,
      }),
    });
  }
  return Object.freeze({
    type: "command",
    command: `${shellQuote(nodeExecutable)} ${shellQuote(selectedRuntimeScript)}`,
  });
}

function isReviewedCapabilityError(error) {
  try {
    return error !== null
      && typeof error === "object"
      && !isProxy(error)
      && Object.getPrototypeOf(error) === capabilityErrorPrototype;
  } catch {
    return false;
  }
}

function assertExactRecord(value, expectedKeys) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join("\0") !== expectedKeys
  ) {
    fail("invalid_configuration");
  }
  return value;
}

async function invokeCapabilityOperation(operation, options, validateResult) {
  let result;
  try {
    result = await Reflect.apply(operation, undefined, [options]);
  } catch (error) {
    if (isReviewedCapabilityError(error)) throw error;
    fail("invalid_configuration");
  }
  try {
    return validateResult(result);
  } catch (error) {
    if (isReviewedCapabilityError(error)) throw error;
    fail("invalid_configuration");
  }
}

function zeroizeBuffer(value) {
  try {
    Reflect.apply(BUFFER_FILL, value, [0]);
  } catch {
    fail("invalid_configuration");
  }
}

function bufferByteLength(value) {
  try {
    return Reflect.apply(TYPED_ARRAY_BYTE_LENGTH, value, []);
  } catch {
    fail("invalid_configuration");
  }
}

function validateEnsuredCapability(result) {
  let returnedSecret = null;
  let secretCandidate;
  try {
    if (
      result !== null
      && (typeof result === "object" || typeof result === "function")
    ) {
      secretCandidate = result.secret;
      if (IS_BUFFER(secretCandidate)) returnedSecret = secretCandidate;
    }
    assertExactRecord(result, "secret\0status");
    const status = result.status;
    if (
      !["created", "existing"].includes(status)
      || !IS_BUFFER(secretCandidate)
      || bufferByteLength(secretCandidate) !== 32
    ) {
      fail("invalid_configuration");
    }
    return status;
  } finally {
    if (returnedSecret !== null) zeroizeBuffer(returnedSecret);
  }
}

function validateRotatedCapability(result) {
  assertExactRecord(result, "status");
  if (result.status !== "rotated") fail("invalid_configuration");
  return Object.freeze({ status: "rotated" });
}

function validatePlannedCapabilityRemoval(result) {
  assertExactRecord(result, "confirmationToken\0status");
  const status = result.status;
  const confirmationToken = result.confirmationToken;
  if (
    !["missing", "ready"].includes(status)
    || (status === "missing" && confirmationToken !== null)
    || (status === "ready"
      && (typeof confirmationToken !== "string"
        || !/^[A-F0-9]{20}$/.test(confirmationToken)))
  ) {
    fail("invalid_configuration");
  }
  return Object.freeze({ status, confirmationToken });
}

function validateRemovedCapability(result) {
  assertExactRecord(result, "secureErasure\0status");
  if (result.status !== "removed" || result.secureErasure !== false) {
    fail("invalid_configuration");
  }
  return Object.freeze({ status: "removed", secureErasure: false });
}

async function ensureCapability(options) {
  return invokeCapabilityOperation(
    ensureClaudeCallbackCapability,
    options,
    validateEnsuredCapability,
  );
}

async function rotateCapability(options) {
  return invokeCapabilityOperation(
    rotateClaudeCallbackCapability,
    options,
    validateRotatedCapability,
  );
}

async function planCapabilityRemoval(options) {
  return invokeCapabilityOperation(
    planClaudeCallbackCapabilityRemoval,
    options,
    validatePlannedCapabilityRemoval,
  );
}

async function removeCapability(options) {
  return invokeCapabilityOperation(
    removeClaudeCallbackCapability,
    options,
    validateRemovedCapability,
  );
}

async function withLifecycleLock(directory, callback, {
  processId = process.pid,
  processExists = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  },
  nowMilliseconds = () => Date.now(),
  staleLockMilliseconds = 5_000,
} = {}, storage = null) {
  if (typeof callback !== "function" || typeof processExists !== "function"
      || typeof nowMilliseconds !== "function"
      || !Number.isSafeInteger(staleLockMilliseconds) || staleLockMilliseconds < 1
      || !Number.isSafeInteger(processId) || processId < 1) fail("invalid_configuration");
  if (storage) {
    try {
      return await storage.lifecycleStore.withOperationLease(storage.lockName, async () => {
        await cleanupPendingState(directory, storage);
        return callback();
      });
    } catch (error) {
      if (error instanceof ClaudeCallbackLifecycleError) throw error;
      if (typeof error?.code === "string"
          && error.code.startsWith("windows_protected_state_store_")) {
        protectedStoreFailure(error, "busy");
      }
      throw error;
    }
  }
  const directoryIdentity = await ensureLifecycleDirectory(directory);
  const lockPath = join(directory, LOCK_FILE);
  let handle;
  let lockStats;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(`${processId}\n`);
      await handle.sync();
      lockStats = await handle.stat();
      assertStrictFile(lockStats, { code: "busy", maximumBytes: 32 });
      break;
    } catch (error) {
      await handle?.close().catch(() => {});
      handle = null;
      if (error?.code !== "EEXIST") {
        if (error instanceof ClaudeCallbackLifecycleError) throw error;
        fail("busy");
      }
      const existing = await readStrictFile(lockPath, {
        code: "busy",
        maximumBytes: 32,
        allowEmpty: true,
      });
      const match = /^(\d+)\n$/.exec(existing.bytes.toString("utf8"));
      const owner = Number(match?.[1]);
      const age = nowMilliseconds() - existing.stats.mtimeMs;
      const invalidOwner = !Number.isSafeInteger(owner) || owner < 1;
      if ((invalidOwner && (!Number.isFinite(age) || age < staleLockMilliseconds))
          || (!invalidOwner && processExists(owner))) fail("busy");
      const current = await lstatIfExists(lockPath);
      if (!current || !sameIdentity(current, existing.stats)) fail("busy");
      await unlink(lockPath).catch(() => fail("busy"));
      await syncDirectory(directory).catch(() => fail("busy"));
    }
  }
  if (!handle || !lockStats) fail("busy");
  try {
    const currentDirectory = await lstatIfExists(directory);
    if (!currentDirectory || !sameIdentity(currentDirectory, directoryIdentity)) fail("state_directory");
    await cleanupPendingState(directory);
    return await callback();
  } finally {
    await handle.close().catch(() => {});
    const current = await lstatIfExists(lockPath);
    if (!current || !sameIdentity(current, lockStats) || current.nlink !== 1) fail("busy");
    await unlink(lockPath).catch(() => fail("busy"));
    await syncDirectory(directory).catch(() => fail("busy"));
  }
}

function uninstalledState(installedStatusLine) {
  return {
    schemaVersion: STATE_SCHEMA,
    phase: "uninstalled",
    operationId: null,
    previousStatusLine: null,
    installedStatusLine,
  };
}

async function recoverPreparedState({
  directory,
  settingsFile,
  state,
  failpoint,
  storage = null,
  platform = null,
}) {
  assertStateRunnerCompatibility(state, platform);
  if (!state || !["install_prepared", "uninstall_prepared"].includes(state.phase)) return state;
  const settings = await readSettings(settingsFile, storage);
  const managed = managedBackup(state.installedStatusLine);
  const prior = state.previousStatusLine;
  if (state.phase === "install_prepared") {
    if (statusLineMatches(settings.value, prior)) {
      await writeSettings(settings, applyStatusLine(settings.value, managed), failpoint);
    } else if (!statusLineMatches(settings.value, managed)) {
      fail("conflict");
    }
    const committed = { ...state, phase: "installed" };
    await writeLifecycleState(directory, committed, storage);
    return committed;
  }
  if (statusLineMatches(settings.value, managed)) {
    await writeSettings(settings, applyStatusLine(settings.value, prior), failpoint);
  } else if (!statusLineMatches(settings.value, prior)) {
    fail("conflict");
  }
  const committed = uninstalledState(state.installedStatusLine);
  await writeLifecycleState(directory, committed, storage);
  return committed;
}

async function inspectUnlocked({
  directory,
  settingsFile,
  installedStatusLine,
  storage = null,
  platform = null,
}) {
  const state = await readLifecycleState(directory, storage);
  assertStateRunnerCompatibility(state, platform);
  assertManagedStateMatches(state, installedStatusLine);
  const settings = await readSettings(settingsFile, storage);
  const managed = managedBackup(installedStatusLine);
  let status;
  if (state === null || state.phase === "uninstalled") {
    status = statusLineMatches(settings.value, managed) ? "conflict" : "not_installed";
  } else if (["install_prepared", "uninstall_prepared"].includes(state.phase)) {
    status = "recovery_required";
  } else {
    status = statusLineMatches(settings.value, managed) ? "installed" : "conflict";
  }
  const targetBinding = digestValue({
    schemaVersion: STATE_SCHEMA,
    lifecycleStatus: status,
    managedStatusLine: installedStatusLine,
    settingsTarget: settingsTargetIdentity(settings),
  });
  return { status, state, targetBinding };
}

async function inspectClaudeCallbackLifecycle(options = {}) {
  const platform = selectedPlatform(options);
  const settingsFile = options.settingsFile ?? defaultClaudeSettingsFile(options);
  const lifecycleDirectory = options.lifecycleDirectory
    ?? defaultClaudeCallbackLifecycleDirectory(options);
  // Validate the Windows state authority before discovering a command runner.
  // Runner selection is useful only after the protected stores have proved
  // their ownership; an unqualified process must fail with the fixed state
  // error before it can derive or inspect any callback runtime state.
  const storage = assertWindowsLifecycleStateSupported(options, { settingsFile, lifecycleDirectory });
  const windowsRunner = platform === "win32"
    ? selectClaudeCallbackRunner({
      platform,
      environment: options.environment,
      runner: options.windowsRunner ?? null,
    })
    : null;
  const installedStatusLine = options.installedStatusLine
    ?? buildManagedClaudeStatusLine({ platform, windowsRunner });
  validateManagedStatusLine(installedStatusLine);
  if (storage) {
    const inspected = await inspectUnlocked({ directory: lifecycleDirectory, settingsFile, installedStatusLine, storage, platform });
    return { status: inspected.status, targetBinding: inspected.targetBinding };
  }
  const directoryStats = await lstatIfExists(lifecycleDirectory);
  if (!directoryStats) {
    const settings = await readSettings(settingsFile);
    const status = statusLineMatches(settings.value, managedBackup(installedStatusLine)) ? "conflict" : "not_installed";
    return {
      status,
      targetBinding: digestValue({
        schemaVersion: STATE_SCHEMA,
        lifecycleStatus: status,
        managedStatusLine: installedStatusLine,
        settingsTarget: settingsTargetIdentity(settings),
      }),
    };
  }
  await assertCanonicalOwnedDirectory(lifecycleDirectory, "state_directory", { ownerOnly: true });
  const inspected = await inspectUnlocked({ directory: lifecycleDirectory, settingsFile, installedStatusLine, platform });
  return { status: inspected.status, targetBinding: inspected.targetBinding };
}

async function recoverClaudeCallbackLifecycle(options = {}) {
  const platform = selectedPlatform(options);
  const settingsFile = options.settingsFile ?? defaultClaudeSettingsFile(options);
  const directory = options.lifecycleDirectory
    ?? defaultClaudeCallbackLifecycleDirectory(options);
  const storage = assertWindowsLifecycleStateSupported(options, { settingsFile, lifecycleDirectory: directory });
  const windowsRunner = platform === "win32"
    ? selectClaudeCallbackRunner({
      platform,
      environment: options.environment,
      runner: options.windowsRunner ?? null,
    })
    : null;
  const installedStatusLine = options.installedStatusLine
    ?? buildManagedClaudeStatusLine({ platform, windowsRunner });
  const failpoint = options.failpoint ?? (async () => {});
  return withLifecycleLock(directory, async () => {
    const state = await readLifecycleState(directory, storage);
    assertManagedStateMatches(state, installedStatusLine);
    const recovered = await recoverPreparedState({ directory, settingsFile, state, failpoint, storage, platform });
    const inspected = await inspectUnlocked({ directory, settingsFile, installedStatusLine, storage, platform });
    return { status: inspected.status, recovered: recovered?.phase ?? "none" };
  }, options, storage);
}

async function installClaudeCallback(options = {}) {
  const platform = selectedPlatform(options);
  const settingsFile = options.settingsFile ?? defaultClaudeSettingsFile(options);
  const directory = options.lifecycleDirectory
    ?? defaultClaudeCallbackLifecycleDirectory(options);
  const storage = assertWindowsLifecycleStateSupported(options, { settingsFile, lifecycleDirectory: directory });
  const windowsRunner = platform === "win32"
    ? selectClaudeCallbackRunner({
      platform,
      environment: options.environment,
      runner: options.windowsRunner ?? null,
    })
    : null;
  const installedStatusLine = options.installedStatusLine
    ?? buildManagedClaudeStatusLine({ platform, windowsRunner });
  const failpoint = options.failpoint ?? (async () => {});
  validateManagedStatusLine(installedStatusLine);
  return withLifecycleLock(directory, async () => {
    let state = await readLifecycleState(directory, storage);
    assertManagedStateMatches(state, installedStatusLine);
    state = await recoverPreparedState({ directory, settingsFile, state, failpoint, storage, platform });
    const inspected = await inspectUnlocked({ directory, settingsFile, installedStatusLine, storage, platform });
    if (inspected.status === "conflict") fail("conflict");
    const settings = inspected.status === "installed" ? null : await readSettings(settingsFile, storage);
    if (settings) validateCoexistingStatusLine(backupFromSettings(settings.value));
    const previousRunner = settings?.value?.statusLine
      ? (platform === "win32"
        ? selectClaudeCallbackRunner({
          platform,
          environment: options.environment,
          runner: options.windowsRunner ?? windowsRunner,
        })
        : null)
      : null;
    const capability = await ensureCapability({
      backend: options.backend,
      generateSecret: options.generateSecret,
    });
    if (inspected.status === "installed") return { status: "already_installed", capability };
    const prepared = {
      schemaVersion: STATE_SCHEMA,
      phase: "install_prepared",
      operationId: randomUUID(),
      previousStatusLine: backupFromSettings(settings.value),
      installedStatusLine,
    };
    if (previousRunner !== null) prepared.previousRunner = previousRunner;
    await writeLifecycleState(directory, prepared, storage);
    await failpoint("after_install_state_prepared");
    await writeSettings(settings, applyStatusLine(settings.value, managedBackup(installedStatusLine)), failpoint);
    await failpoint("after_install_settings_written");
    await writeLifecycleState(directory, { ...prepared, phase: "installed" }, storage);
    await failpoint("after_install_state_committed");
    return { status: "installed", capability };
  }, options, storage);
}

async function uninstallClaudeCallback(options = {}) {
  const platform = selectedPlatform(options);
  const settingsFile = options.settingsFile ?? defaultClaudeSettingsFile(options);
  const directory = options.lifecycleDirectory
    ?? defaultClaudeCallbackLifecycleDirectory(options);
  const storage = assertWindowsLifecycleStateSupported(options, { settingsFile, lifecycleDirectory: directory });
  const windowsRunner = platform === "win32"
    ? selectClaudeCallbackRunner({
      platform,
      environment: options.environment,
      runner: options.windowsRunner ?? null,
    })
    : null;
  const installedStatusLine = options.installedStatusLine
    ?? buildManagedClaudeStatusLine({ platform, windowsRunner });
  const failpoint = options.failpoint ?? (async () => {});
  return withLifecycleLock(directory, async () => {
    let state = await readLifecycleState(directory, storage);
    assertManagedStateMatches(state, installedStatusLine);
    state = await recoverPreparedState({ directory, settingsFile, state, failpoint, storage, platform });
    const inspected = await inspectUnlocked({ directory, settingsFile, installedStatusLine, storage, platform });
    if (inspected.status === "conflict") fail("conflict");
    if (inspected.status === "not_installed") return { status: "already_uninstalled", capabilityPreserved: true };
    const settings = await readSettings(settingsFile, storage);
    const prepared = { ...state, phase: "uninstall_prepared", operationId: randomUUID() };
    await writeLifecycleState(directory, prepared, storage);
    await failpoint("after_uninstall_state_prepared");
    await writeSettings(settings, applyStatusLine(settings.value, prepared.previousStatusLine), failpoint);
    await failpoint("after_uninstall_settings_written");
    await writeLifecycleState(directory, uninstalledState(installedStatusLine), storage);
    await failpoint("after_uninstall_state_committed");
    return { status: "uninstalled", capabilityPreserved: true };
  }, options, storage);
}

async function rotateManagedClaudeCallbackCapability(options = {}) {
  const platform = selectedPlatform(options);
  const settingsFile = options.settingsFile ?? defaultClaudeSettingsFile(options);
  const directory = options.lifecycleDirectory
    ?? defaultClaudeCallbackLifecycleDirectory(options);
  const storage = assertWindowsLifecycleStateSupported(options, { settingsFile, lifecycleDirectory: directory });
  const windowsRunner = platform === "win32"
    ? selectClaudeCallbackRunner({
      platform,
      environment: options.environment,
      runner: options.windowsRunner ?? null,
    })
    : null;
  const installedStatusLine = options.installedStatusLine
    ?? buildManagedClaudeStatusLine({ platform, windowsRunner });
  return withLifecycleLock(directory, async () => {
    const initial = await readLifecycleState(directory, storage);
    assertManagedStateMatches(initial, installedStatusLine);
    const state = await recoverPreparedState({
      directory,
      settingsFile,
      state: initial,
      failpoint: options.failpoint ?? (async () => {}),
      storage,
      platform,
    });
    void state;
    return rotateCapability({
      backend: options.backend,
      confirm: options.confirm,
      generateSecret: options.generateSecret,
    });
  }, options, storage);
}

async function planManagedClaudeCallbackCapabilityRemoval(options = {}) {
  const platform = selectedPlatform(options);
  const settingsFile = options.settingsFile ?? defaultClaudeSettingsFile(options);
  const directory = options.lifecycleDirectory
    ?? defaultClaudeCallbackLifecycleDirectory(options);
  const storage = assertWindowsLifecycleStateSupported(options, { settingsFile, lifecycleDirectory: directory });
  const windowsRunner = platform === "win32"
    ? selectClaudeCallbackRunner({
      platform,
      environment: options.environment,
      runner: options.windowsRunner ?? null,
    })
    : null;
  const installedStatusLine = options.installedStatusLine
    ?? buildManagedClaudeStatusLine({ platform, windowsRunner });
  return withLifecycleLock(directory, async () => {
    const initial = await readLifecycleState(directory, storage);
    assertManagedStateMatches(initial, installedStatusLine);
    const state = await recoverPreparedState({
      directory,
      settingsFile,
      state: initial,
      failpoint: options.failpoint ?? (async () => {}),
      storage,
      platform,
    });
    void state;
    const inspected = await inspectUnlocked({ directory, settingsFile, installedStatusLine, storage, platform });
    if (inspected.status !== "not_installed") fail("not_uninstalled");
    return planCapabilityRemoval({
      backend: options.backend,
      targetBinding: inspected.targetBinding,
    });
  }, options, storage);
}

async function removeManagedClaudeCallbackCapability(options = {}) {
  const platform = selectedPlatform(options);
  const settingsFile = options.settingsFile ?? defaultClaudeSettingsFile(options);
  const directory = options.lifecycleDirectory
    ?? defaultClaudeCallbackLifecycleDirectory(options);
  const storage = assertWindowsLifecycleStateSupported(options, { settingsFile, lifecycleDirectory: directory });
  const windowsRunner = platform === "win32"
    ? selectClaudeCallbackRunner({
      platform,
      environment: options.environment,
      runner: options.windowsRunner ?? null,
    })
    : null;
  const installedStatusLine = options.installedStatusLine
    ?? buildManagedClaudeStatusLine({ platform, windowsRunner });
  return withLifecycleLock(directory, async () => {
    const initial = await readLifecycleState(directory, storage);
    assertManagedStateMatches(initial, installedStatusLine);
    await recoverPreparedState({
      directory,
      settingsFile,
      state: initial,
      failpoint: options.failpoint ?? (async () => {}),
      storage,
      platform,
    });
    const inspected = await inspectUnlocked({ directory, settingsFile, installedStatusLine, storage, platform });
    if (inspected.status !== "not_installed") fail("not_uninstalled");
    return removeCapability({
      backend: options.backend,
      targetBinding: inspected.targetBinding,
      providedToken: options.providedToken,
    });
  }, options, storage);
}

// Runtime-only accessor. It returns the command to the local callback process,
// never to inspect/CLI output, and reads only the owner-only lifecycle state.
async function readClaudeCallbackRuntimeConfiguration(options = {}) {
  const platform = selectedPlatform(options);
  const lifecycleDirectory = options.lifecycleDirectory
    ?? defaultClaudeCallbackLifecycleDirectory(options);
  const settingsFile = options.settingsFile ?? defaultClaudeSettingsFile(options);
  const storage = assertWindowsLifecycleStateSupported(options, {
    settingsFile,
    lifecycleDirectory,
  });
  const windowsRunner = platform === "win32"
    ? selectClaudeCallbackRunner({
      platform,
      environment: options.environment,
      runner: options.windowsRunner ?? null,
    })
    : null;
  const installedStatusLine = options.installedStatusLine
    ?? buildManagedClaudeStatusLine({ platform, windowsRunner });
  const runtimeConfiguration = (state) => {
    const previousCommand = validateCoexistingStatusLine(state.previousStatusLine);
    if (platform !== "win32" || previousCommand === null) {
      return { previousCommand };
    }
    if (!Object.hasOwn(state, "previousRunner") || state.previousRunner === null) {
      // A legacy Windows state has no trustworthy shell identity. Do not
      // rediscover a different shell or mutate the user's settings.
      fail("coexistence_unsupported");
    }
    const previousRunner = validateClaudeCallbackRunner(state.previousRunner);
    // The runner selected for this invocation is only an identity check. The
    // persisted runner remains the one used for replay; a state edit that
    // substitutes another allowlisted installation must fail closed.
    if (!sameRunnerIdentity(previousRunner, windowsRunner)) fail("coexistence_unsupported");
    return { previousCommand, previousRunner };
  };
  if (storage) {
    const state = await readLifecycleState(lifecycleDirectory, storage);
    if (!state || !["install_prepared", "installed", "uninstall_prepared"].includes(state.phase)) {
      fail("runtime_state");
    }
    assertManagedStateMatches(state, installedStatusLine);
    return runtimeConfiguration(state);
  }
  await assertCanonicalOwnedDirectory(lifecycleDirectory, "runtime_state", { ownerOnly: true });
  const state = await readLifecycleState(lifecycleDirectory);
  if (!state || !["install_prepared", "installed", "uninstall_prepared"].includes(state.phase)) {
    fail("runtime_state");
  }
  assertManagedStateMatches(state, installedStatusLine);
  return runtimeConfiguration(state);
}

  return Object.freeze({
    buildManagedClaudeStatusLine,
    defaultClaudeCallbackLifecycleDirectory,
    defaultClaudeSettingsFile,
    inspectClaudeCallbackLifecycle,
    installClaudeCallback,
    planManagedClaudeCallbackCapabilityRemoval,
    readClaudeCallbackRuntimeConfiguration,
    recoverClaudeCallbackLifecycle,
    removeManagedClaudeCallbackCapability,
    rotateManagedClaudeCallbackCapability,
    uninstallClaudeCallback,
  });
}
