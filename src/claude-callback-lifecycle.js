import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultExportStateDirectory } from "./export-identity.js";
import {
  ensureClaudeCallbackCapability,
  planClaudeCallbackCapabilityRemoval,
  removeClaudeCallbackCapability,
  rotateClaudeCallbackCapability,
} from "./claude-callback-capability.js";
import { syncDirectory } from "./storage.js";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const STATE_SCHEMA = "claude-callback-lifecycle-v1";
const STATE_FILE = "lifecycle-state.json";
const STATE_PENDING_FILE = ".lifecycle-state.pending";
const LOCK_FILE = "operation.lock";
const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 128 * 1024;
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
]);

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

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

async function lstatIfExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("state_file");
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

function validateLifecycleState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== "installedStatusLine\0operationId\0phase\0previousStatusLine\0schemaVersion"
      || value.schemaVersion !== STATE_SCHEMA
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
  return value;
}

async function readLifecycleState(directory) {
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

async function cleanupPendingState(directory) {
  const pendingPath = join(directory, STATE_PENDING_FILE);
  const pending = await lstatIfExists(pendingPath);
  if (!pending) return;
  assertStrictFile(pending, { code: "state_file", maximumBytes: MAX_STATE_BYTES });
  await unlink(pendingPath).catch(() => fail("state_write"));
  await syncDirectory(directory).catch(() => fail("state_write"));
}

async function writeLifecycleState(directory, value) {
  validateLifecycleState(value);
  const bytes = Buffer.from(stableJson(value));
  if (bytes.byteLength > MAX_STATE_BYTES) fail("state_shape");
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

async function readSettings(settingsFile) {
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

export function defaultClaudeSettingsFile({ homeDirectory = homedir() } = {}) {
  if (typeof homeDirectory !== "string" || !isAbsolute(homeDirectory)) fail("invalid_configuration");
  return join(homeDirectory, ".claude", "settings.json");
}

export function defaultClaudeCallbackLifecycleDirectory(options = {}) {
  return join(defaultExportStateDirectory(options), "claude-callback-lifecycle-v1");
}

export function buildManagedClaudeStatusLine({
  nodeExecutable = process.execPath,
  runtimeScript = fileURLToPath(new URL("./claude-callback-runtime.js", import.meta.url)),
} = {}) {
  return Object.freeze({
    type: "command",
    command: `${shellQuote(nodeExecutable)} ${shellQuote(runtimeScript)}`,
  });
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
} = {}) {
  if (typeof callback !== "function" || typeof processExists !== "function"
      || typeof nowMilliseconds !== "function"
      || !Number.isSafeInteger(staleLockMilliseconds) || staleLockMilliseconds < 1
      || !Number.isSafeInteger(processId) || processId < 1) fail("invalid_configuration");
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

async function recoverPreparedState({ directory, settingsFile, state, failpoint }) {
  if (!state || !["install_prepared", "uninstall_prepared"].includes(state.phase)) return state;
  const settings = await readSettings(settingsFile);
  const managed = managedBackup(state.installedStatusLine);
  const prior = state.previousStatusLine;
  if (state.phase === "install_prepared") {
    if (statusLineMatches(settings.value, prior)) {
      await writeSettings(settings, applyStatusLine(settings.value, managed), failpoint);
    } else if (!statusLineMatches(settings.value, managed)) {
      fail("conflict");
    }
    const committed = { ...state, phase: "installed" };
    await writeLifecycleState(directory, committed);
    return committed;
  }
  if (statusLineMatches(settings.value, managed)) {
    await writeSettings(settings, applyStatusLine(settings.value, prior), failpoint);
  } else if (!statusLineMatches(settings.value, prior)) {
    fail("conflict");
  }
  const committed = uninstalledState(state.installedStatusLine);
  await writeLifecycleState(directory, committed);
  return committed;
}

async function inspectUnlocked({ directory, settingsFile, installedStatusLine }) {
  const state = await readLifecycleState(directory);
  assertManagedStateMatches(state, installedStatusLine);
  const settings = await readSettings(settingsFile);
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

export async function inspectClaudeCallbackLifecycle({
  settingsFile = defaultClaudeSettingsFile(),
  lifecycleDirectory = defaultClaudeCallbackLifecycleDirectory(),
  installedStatusLine = buildManagedClaudeStatusLine(),
} = {}) {
  validateManagedStatusLine(installedStatusLine);
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
  const inspected = await inspectUnlocked({ directory: lifecycleDirectory, settingsFile, installedStatusLine });
  return { status: inspected.status, targetBinding: inspected.targetBinding };
}

export async function recoverClaudeCallbackLifecycle(options = {}) {
  const settingsFile = options.settingsFile ?? defaultClaudeSettingsFile();
  const directory = options.lifecycleDirectory ?? defaultClaudeCallbackLifecycleDirectory();
  const installedStatusLine = options.installedStatusLine ?? buildManagedClaudeStatusLine();
  const failpoint = options.failpoint ?? (async () => {});
  return withLifecycleLock(directory, async () => {
    const state = await readLifecycleState(directory);
    assertManagedStateMatches(state, installedStatusLine);
    const recovered = await recoverPreparedState({ directory, settingsFile, state, failpoint });
    const inspected = await inspectUnlocked({ directory, settingsFile, installedStatusLine });
    return { status: inspected.status, recovered: recovered?.phase ?? "none" };
  }, options);
}

export async function installClaudeCallback(options = {}) {
  const settingsFile = options.settingsFile ?? defaultClaudeSettingsFile();
  const directory = options.lifecycleDirectory ?? defaultClaudeCallbackLifecycleDirectory();
  const installedStatusLine = options.installedStatusLine ?? buildManagedClaudeStatusLine();
  const failpoint = options.failpoint ?? (async () => {});
  validateManagedStatusLine(installedStatusLine);
  return withLifecycleLock(directory, async () => {
    let state = await readLifecycleState(directory);
    assertManagedStateMatches(state, installedStatusLine);
    state = await recoverPreparedState({ directory, settingsFile, state, failpoint });
    const inspected = await inspectUnlocked({ directory, settingsFile, installedStatusLine });
    if (inspected.status === "conflict") fail("conflict");
    const settings = inspected.status === "installed" ? null : await readSettings(settingsFile);
    if (settings) validateCoexistingStatusLine(backupFromSettings(settings.value));
    let ensured;
    try {
      ensured = await ensureClaudeCallbackCapability({ backend: options.backend, generateSecret: options.generateSecret });
    } finally {
      ensured?.secret?.fill(0);
    }
    if (inspected.status === "installed") return { status: "already_installed", capability: ensured.status };
    const prepared = {
      schemaVersion: STATE_SCHEMA,
      phase: "install_prepared",
      operationId: randomUUID(),
      previousStatusLine: backupFromSettings(settings.value),
      installedStatusLine,
    };
    await writeLifecycleState(directory, prepared);
    await failpoint("after_install_state_prepared");
    await writeSettings(settings, applyStatusLine(settings.value, managedBackup(installedStatusLine)), failpoint);
    await failpoint("after_install_settings_written");
    await writeLifecycleState(directory, { ...prepared, phase: "installed" });
    await failpoint("after_install_state_committed");
    return { status: "installed", capability: ensured.status };
  }, options);
}

export async function uninstallClaudeCallback(options = {}) {
  const settingsFile = options.settingsFile ?? defaultClaudeSettingsFile();
  const directory = options.lifecycleDirectory ?? defaultClaudeCallbackLifecycleDirectory();
  const installedStatusLine = options.installedStatusLine ?? buildManagedClaudeStatusLine();
  const failpoint = options.failpoint ?? (async () => {});
  return withLifecycleLock(directory, async () => {
    let state = await readLifecycleState(directory);
    assertManagedStateMatches(state, installedStatusLine);
    state = await recoverPreparedState({ directory, settingsFile, state, failpoint });
    const inspected = await inspectUnlocked({ directory, settingsFile, installedStatusLine });
    if (inspected.status === "conflict") fail("conflict");
    if (inspected.status === "not_installed") return { status: "already_uninstalled", capabilityPreserved: true };
    const settings = await readSettings(settingsFile);
    const prepared = { ...state, phase: "uninstall_prepared", operationId: randomUUID() };
    await writeLifecycleState(directory, prepared);
    await failpoint("after_uninstall_state_prepared");
    await writeSettings(settings, applyStatusLine(settings.value, prepared.previousStatusLine), failpoint);
    await failpoint("after_uninstall_settings_written");
    await writeLifecycleState(directory, uninstalledState(installedStatusLine));
    await failpoint("after_uninstall_state_committed");
    return { status: "uninstalled", capabilityPreserved: true };
  }, options);
}

export async function rotateManagedClaudeCallbackCapability(options = {}) {
  const settingsFile = options.settingsFile ?? defaultClaudeSettingsFile();
  const directory = options.lifecycleDirectory ?? defaultClaudeCallbackLifecycleDirectory();
  const installedStatusLine = options.installedStatusLine ?? buildManagedClaudeStatusLine();
  return withLifecycleLock(directory, async () => {
    const initial = await readLifecycleState(directory);
    assertManagedStateMatches(initial, installedStatusLine);
    const state = await recoverPreparedState({
      directory,
      settingsFile,
      state: initial,
      failpoint: options.failpoint ?? (async () => {}),
    });
    void state;
    return rotateClaudeCallbackCapability({
      backend: options.backend,
      confirm: options.confirm,
      generateSecret: options.generateSecret,
    });
  }, options);
}

export async function planManagedClaudeCallbackCapabilityRemoval(options = {}) {
  const settingsFile = options.settingsFile ?? defaultClaudeSettingsFile();
  const directory = options.lifecycleDirectory ?? defaultClaudeCallbackLifecycleDirectory();
  const installedStatusLine = options.installedStatusLine ?? buildManagedClaudeStatusLine();
  return withLifecycleLock(directory, async () => {
    const initial = await readLifecycleState(directory);
    assertManagedStateMatches(initial, installedStatusLine);
    const state = await recoverPreparedState({
      directory,
      settingsFile,
      state: initial,
      failpoint: options.failpoint ?? (async () => {}),
    });
    void state;
    const inspected = await inspectUnlocked({ directory, settingsFile, installedStatusLine });
    if (inspected.status !== "not_installed") fail("not_uninstalled");
    return planClaudeCallbackCapabilityRemoval({ backend: options.backend, targetBinding: inspected.targetBinding });
  }, options);
}

export async function removeManagedClaudeCallbackCapability(options = {}) {
  const settingsFile = options.settingsFile ?? defaultClaudeSettingsFile();
  const directory = options.lifecycleDirectory ?? defaultClaudeCallbackLifecycleDirectory();
  const installedStatusLine = options.installedStatusLine ?? buildManagedClaudeStatusLine();
  return withLifecycleLock(directory, async () => {
    const initial = await readLifecycleState(directory);
    assertManagedStateMatches(initial, installedStatusLine);
    await recoverPreparedState({
      directory,
      settingsFile,
      state: initial,
      failpoint: options.failpoint ?? (async () => {}),
    });
    const inspected = await inspectUnlocked({ directory, settingsFile, installedStatusLine });
    if (inspected.status !== "not_installed") fail("not_uninstalled");
    return removeClaudeCallbackCapability({
      backend: options.backend,
      targetBinding: inspected.targetBinding,
      providedToken: options.providedToken,
    });
  }, options);
}

// Runtime-only accessor. It returns the command to the local callback process,
// never to inspect/CLI output, and reads only the owner-only lifecycle state.
export async function readClaudeCallbackRuntimeConfiguration({
  lifecycleDirectory = defaultClaudeCallbackLifecycleDirectory(),
  installedStatusLine = buildManagedClaudeStatusLine(),
} = {}) {
  await assertCanonicalOwnedDirectory(lifecycleDirectory, "runtime_state", { ownerOnly: true });
  const state = await readLifecycleState(lifecycleDirectory);
  if (!state || !["install_prepared", "installed", "uninstall_prepared"].includes(state.phase)) {
    fail("runtime_state");
  }
  assertManagedStateMatches(state, installedStatusLine);
  return { previousCommand: validateCoexistingStatusLine(state.previousStatusLine) };
}
