import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isProxy } from "node:util/types";

function configurationFailure() {
  throw new TypeError("Owner-only export workspace lease configuration is invalid");
}

function ownStableJson(configuration) {
  try {
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration) || isProxy(configuration)
        || !Object.hasOwn(configuration, "stableJson")) configurationFailure();
    const descriptor = Object.getOwnPropertyDescriptor(configuration, "stableJson");
    if (!descriptor || !Object.hasOwn(descriptor, "value")) configurationFailure();
    const stableJson = descriptor.value;
    if (typeof stableJson !== "function" || isProxy(stableJson)) configurationFailure();
    return stableJson;
  } catch {
    configurationFailure();
  }
}

/** Platform owner for the export-workspace exclusive lease protocol. */
export function createOwnerOnlyExportWorkspaceLeaseContext(configuration = {}) {
  const stableJson = ownStableJson(configuration);
const LOCK_BASENAME = ".app-usagemonitor-export-workspace.lock";
const LOCK_VERSION = "export-workspace-lock-v1";
const trustedWorkspaceLockErrors = new WeakSet();

class ExportWorkspaceLockError extends Error {
  constructor(code) {
    if (!new Set(["contended", "invalid", "race"]).has(code)) throw new TypeError("Unknown workspace-lock code");
    super(`Local export workspace lock failed (${code})`);
    this.name = "ExportWorkspaceLockError";
    this.code = `export_workspace_lock_${code}`;
    trustedWorkspaceLockErrors.add(this);
  }
}

function isTrustedExportWorkspaceLockError(error) {
  return Boolean(error && trustedWorkspaceLockErrors.has(error)
    && Object.getPrototypeOf(error) === ExportWorkspaceLockError.prototype);
}

function fail(code) {
  throw new ExportWorkspaceLockError(code);
}

function assertDirectory(stats) {
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail("invalid");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) fail("invalid");
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) fail("invalid");
}

function assertLock(stats) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size < 1 || stats.size > 1024) fail("invalid");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) fail("invalid");
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) fail("invalid");
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
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

async function inspectLock(path) {
  const pathStats = await lstat(path);
  assertLock(pathStats);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stats = await handle.stat();
    assertLock(stats);
    if (stats.dev !== pathStats.dev || stats.ino !== pathStats.ino) fail("race");
    let value;
    try {
      value = JSON.parse(await handle.readFile("utf8"));
    } catch {
      fail("invalid");
    }
    if (value?.version !== LOCK_VERSION || !Number.isSafeInteger(value.pid)
        || typeof value.token !== "string" || !/^[0-9a-f-]{36}$/.test(value.token)) fail("invalid");
    return { stats, value };
  } finally {
    await handle.close();
  }
}

async function removeExactLock(path, expected) {
  const current = await lstat(path);
  assertLock(current);
  if (current.dev !== expected.dev || current.ino !== expected.ino) fail("race");
  await unlink(path);
}

async function withExportWorkspaceLease(directory, callback, {
  create = true,
  normalizePermissions = true,
} = {}) {
  if (typeof callback !== "function") throw new TypeError("Workspace lease callback is required");
  const target = resolve(directory);
  if (create) await mkdir(target, { recursive: true, mode: 0o700 });
  let initial;
  try {
    initial = await lstat(target);
  } catch (error) {
    if (!create && error.code === "ENOENT") fail("invalid");
    throw error;
  }
  if (!initial.isDirectory() || initial.isSymbolicLink()
      || (typeof process.getuid === "function" && initial.uid !== process.getuid())) fail("invalid");
  if (process.platform !== "win32" && (initial.mode & 0o077) !== 0) {
    if (!normalizePermissions) fail("invalid");
    await chmod(target, 0o700);
  }
  const canonicalTarget = await realpath(target);
  const canonicalStats = await lstat(canonicalTarget);
  assertDirectory(canonicalStats);
  if (canonicalStats.dev !== initial.dev || canonicalStats.ino !== initial.ino) fail("race");
  const lockPath = join(canonicalTarget, LOCK_BASENAME);
  let owned = null;
  for (let attempt = 0; attempt < 10 && !owned; attempt += 1) {
    const token = randomUUID();
    let handle;
    try {
      handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(stableJson({ version: LOCK_VERSION, pid: process.pid, token }));
      await handle.sync();
      const stats = await handle.stat();
      assertLock(stats);
      owned = { stats, token };
      await handle.close();
      handle = null;
      await syncDirectory(canonicalTarget);
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error.code !== "EEXIST") throw error;
      const existing = await inspectLock(lockPath);
      if (processAlive(existing.value.pid)) fail("contended");
      try {
        await removeExactLock(lockPath, existing.stats);
        await syncDirectory(canonicalTarget);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT" && !(cleanupError instanceof ExportWorkspaceLockError)) throw cleanupError;
      }
    }
  }
  if (!owned) fail("race");
  try {
    return await callback(canonicalTarget, canonicalStats);
  } finally {
    try {
      const current = await inspectLock(lockPath);
      if (current.value.token !== owned.token) fail("race");
      await removeExactLock(lockPath, owned.stats);
      await syncDirectory(canonicalTarget);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function withExistingExportWorkspaceLease(directory, callback) {
  return withExportWorkspaceLease(directory, callback, { create: false, normalizePermissions: false });
}

  return Object.freeze({
    ExportWorkspaceLockError,
    isTrustedExportWorkspaceLockError,
    withExportWorkspaceLease,
    withExistingExportWorkspaceLease,
  });
}
