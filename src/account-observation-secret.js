import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultExportStateDirectory } from "./export-identity.js";

const SECRET_BYTES = 32;
const LOCK_SCHEMA_VERSION = "account-observation-operation-v1";
const MAXIMUM_LOCK_BYTES = 256;
const DEFAULT_STALE_LOCK_MILLISECONDS = 5 * 60 * 1000;
const MAXIMUM_CLOCK_SKEW_MILLISECONDS = 60 * 1000;

export function defaultAccountObservationOperationLockFile(options) {
  return join(defaultExportStateDirectory(options), "account-observation-operation.lock");
}

export class AccountObservationSecretError extends Error {
  constructor(code) {
    super("Account observation credential is unavailable");
    this.name = "AccountObservationSecretError";
    this.code = code;
  }
}

function fail(code) {
  throw new AccountObservationSecretError(code);
}

function assertBackend(backend, capability, { createIfMissing = true } = {}) {
  let valid = capability !== null && capability !== undefined;
  try {
    valid = valid && backend !== null && typeof backend === "object"
      && typeof backend.read === "function"
      && (!createIfMissing || typeof backend.createIfMissing === "function");
  } catch {
    valid = false;
  }
  if (!valid) fail("account_observation_credential_invalid");
}

function copySecret(value) {
  if (!Buffer.isBuffer(value) || value.byteLength !== SECRET_BYTES) {
    if (Buffer.isBuffer(value)) value.fill(0);
    fail("account_observation_credential_unavailable");
  }
  return Buffer.from(value);
}

async function invokeBackend(backend, method, ...args) {
  try {
    return await backend[method](...args);
  } catch (error) {
    let code;
    try {
      code = error?.code;
    } catch {
      // Hostile backend errors are collapsed below.
    }
    if (code === "export_identity_keychain_locked"
        || code === "windows_credential_manager_locked") {
      fail("account_observation_credential_locked");
    }
    if (code === "export_identity_keychain_migration_required") {
      fail("account_observation_credential_migration_required");
    }
    fail("account_observation_credential_unavailable");
  }
}

function sameIdentity(left, right) {
  return typeof left?.dev === "number" && typeof left?.ino === "number"
    && typeof right?.dev === "number" && typeof right?.ino === "number"
    && left.dev === right.dev && left.ino === right.ino;
}

function assertOwnerOnlyLock(stats) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
      || stats.size < 0 || stats.size > MAXIMUM_LOCK_BYTES) {
    fail("account_observation_credential_unavailable");
  }
  if (typeof process.getuid === "function" && typeof stats.uid === "number" && stats.uid !== process.getuid()) {
    fail("account_observation_credential_unavailable");
  }
  if (process.platform !== "win32" && (stats.mode & 0o777) !== 0o600) {
    fail("account_observation_credential_unavailable");
  }
}

async function prepareLockDirectory(path) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail("account_observation_credential_unavailable");
  if (typeof process.getuid === "function" && typeof stats.uid === "number" && stats.uid !== process.getuid()) {
    fail("account_observation_credential_unavailable");
  }
  if (process.platform !== "win32" && (stats.mode & 0o022) !== 0) {
    fail("account_observation_credential_unavailable");
  }
  return { directory, identity: { dev: stats.dev, ino: stats.ino } };
}

async function assertLockDirectory(directoryState) {
  const stats = await lstat(directoryState.directory);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !sameIdentity(stats, directoryState.identity)
      || (typeof process.getuid === "function" && typeof stats.uid === "number" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o022) !== 0)) {
    fail("account_observation_credential_unavailable");
  }
}

async function syncLockDirectory(directoryState) {
  await assertLockDirectory(directoryState);
  // Windows cannot open a directory for fsync. The lock file itself is
  // flushed before this point; the unavailable directory-entry barrier is a
  // POSIX-only durability primitive.
  if (process.platform === "win32") return;
  let handle;
  try {
    handle = await open(directoryState.directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    await handle.sync();
  } catch {
    fail("account_observation_credential_unavailable");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function lockContent(processId, now) {
  return `${JSON.stringify({
    schemaVersion: LOCK_SCHEMA_VERSION,
    processId,
    createdAt: new Date(now).toISOString(),
  })}\n`;
}

function parseLockContent(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 1 || bytes.byteLength > MAXIMUM_LOCK_BYTES) {
    fail("account_observation_credential_unavailable");
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("account_observation_credential_unavailable");
  }
  const keys = Object.keys(parsed ?? {}).sort();
  const createdAtMs = Date.parse(parsed?.createdAt);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || keys.join("\0") !== "createdAt\0processId\0schemaVersion"
      || parsed.schemaVersion !== LOCK_SCHEMA_VERSION
      || !Number.isSafeInteger(parsed.processId) || parsed.processId < 1
      || !Number.isFinite(createdAtMs) || new Date(createdAtMs).toISOString() !== parsed.createdAt
      || lockContent(parsed.processId, createdAtMs) !== bytes.toString("utf8")) {
    fail("account_observation_credential_unavailable");
  }
  return { processId: parsed.processId, createdAtMs };
}

function looksLikeIncompleteLockContent(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength > MAXIMUM_LOCK_BYTES) return false;
  if (bytes.byteLength === 0) return true;
  const text = bytes.toString("utf8");
  if (text.includes("\uFFFD") || text.includes("\n")) return false;
  const prefix = `{"schemaVersion":"${LOCK_SCHEMA_VERSION}","processId":`;
  return prefix.startsWith(text) || text.startsWith(prefix);
}

async function inspectExistingLock(path, directoryState) {
  await assertLockDirectory(directoryState);
  let pathStats;
  try {
    pathStats = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("account_observation_credential_unavailable");
  }
  assertOwnerOnlyLock(pathStats);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    assertOwnerOnlyLock(opened);
    if (!sameIdentity(pathStats, opened)) return null;
    const bytes = await handle.readFile();
    const afterRead = await handle.stat();
    if (!sameIdentity(opened, afterRead) || afterRead.nlink !== 1 || afterRead.size !== bytes.byteLength
        || afterRead.mtimeMs !== opened.mtimeMs) return null;
    try {
      const owner = parseLockContent(bytes);
      return { kind: "complete", owner, identity: { dev: opened.dev, ino: opened.ino }, mtimeMs: opened.mtimeMs };
    } catch (error) {
      if (!looksLikeIncompleteLockContent(bytes)) throw error;
      return { kind: "incomplete", owner: null, identity: { dev: opened.dev, ino: opened.ino }, mtimeMs: opened.mtimeMs };
    }
  } catch (error) {
    if (error instanceof AccountObservationSecretError) throw error;
    fail("account_observation_credential_unavailable");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function removeExactStaleLock(path, directoryState, inspected, operationHook) {
  await operationHook?.("before-stale-lock-removal");
  await assertLockDirectory(directoryState);
  const revalidated = await inspectExistingLock(path, directoryState);
  if (revalidated === null || !sameIdentity(revalidated.identity, inspected.identity)
      || revalidated.kind !== inspected.kind || revalidated.mtimeMs !== inspected.mtimeMs
      || (revalidated.kind === "complete"
        && (revalidated.owner.processId !== inspected.owner.processId
          || revalidated.owner.createdAtMs !== inspected.owner.createdAtMs))) {
    return false;
  }
  let current;
  try {
    current = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    fail("account_observation_credential_unavailable");
  }
  assertOwnerOnlyLock(current);
  if (!sameIdentity(current, inspected.identity)) return false;
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    fail("account_observation_credential_unavailable");
  }
  await syncLockDirectory(directoryState);
  await operationHook?.("after-stale-lock-removal");
  return true;
}

async function acquireOperationLease(path, {
  clock,
  processExists,
  processId,
  staleLockMilliseconds,
  operationHook,
}) {
  const directoryState = await prepareLockDirectory(path);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let handle;
    let createdIdentity = null;
    try {
      handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      if (error?.code !== "EEXIST") fail("account_observation_credential_unavailable");
      const inspected = await inspectExistingLock(path, directoryState);
      if (inspected === null) continue;
      const now = clock();
      if (!Number.isFinite(now)) fail("account_observation_credential_unavailable");
      const age = now - (inspected.kind === "complete" ? inspected.owner.createdAtMs : inspected.mtimeMs);
      if (age < -MAXIMUM_CLOCK_SKEW_MILLISECONDS) fail("account_observation_credential_unavailable");
      if (inspected.kind === "incomplete") {
        if (age < staleLockMilliseconds) {
          if (attempt < 3) {
            await new Promise((resolveRetry) => setTimeout(resolveRetry, 5));
            continue;
          }
          fail("account_observation_credential_locked");
        }
        if (await removeExactStaleLock(path, directoryState, inspected, operationHook)) continue;
        continue;
      }
      let ownerExists;
      try {
        ownerExists = processExists(inspected.owner.processId) === true;
      } catch {
        fail("account_observation_credential_unavailable");
      }
      if (age < staleLockMilliseconds || ownerExists) {
        fail("account_observation_credential_locked");
      }
      if (await removeExactStaleLock(path, directoryState, inspected, operationHook)) continue;
      continue;
    }
    try {
      const created = await handle.stat();
      createdIdentity = { dev: created.dev, ino: created.ino };
      const now = clock();
      if (!Number.isFinite(now)) fail("account_observation_credential_unavailable");
      const content = lockContent(processId, now);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      const stats = await handle.stat();
      assertOwnerOnlyLock(stats);
      if (stats.size !== Buffer.byteLength(content)) fail("account_observation_credential_unavailable");
      await assertLockDirectory(directoryState);
      await syncLockDirectory(directoryState);
      await operationHook?.("after-operation-lock-acquired");
      return { handle, identity: { dev: stats.dev, ino: stats.ino }, directoryState };
    } catch (error) {
      await handle.close().catch(() => {});
      try {
        const current = await lstat(path);
        if (sameIdentity(current, createdIdentity)) {
          await unlink(path);
          await syncLockDirectory(directoryState);
        }
      } catch {
        // The fixed failure below is more useful than an unsafe cleanup guess.
      }
      if (error instanceof AccountObservationSecretError) throw error;
      fail("account_observation_credential_unavailable");
    }
  }
  fail("account_observation_credential_locked");
}

async function releaseOperationLease(path, lease) {
  await lease.handle.close().catch(() => {});
  try {
    await assertLockDirectory(lease.directoryState);
    const stats = await lstat(path);
    if (!sameIdentity(stats, lease.identity)) fail("account_observation_credential_unavailable");
    assertOwnerOnlyLock(stats);
    await unlink(path);
    await syncLockDirectory(lease.directoryState);
  } catch (error) {
    if (error?.code !== "ENOENT") fail("account_observation_credential_unavailable");
  }
}

export function createAccountObservationSecretLoader({
  backend,
  capability,
  createIfMissing = true,
  operationLockFile = defaultAccountObservationOperationLockFile(),
  generateSecret = () => randomBytes(SECRET_BYTES),
  clock = () => Date.now(),
  processExists = (processId) => {
    try {
      process.kill(processId, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  },
  processId = process.pid,
  staleLockMilliseconds = DEFAULT_STALE_LOCK_MILLISECONDS,
  operationHook = null,
} = {}) {
  assertBackend(backend, capability, { createIfMissing });
  if (typeof createIfMissing !== "boolean"
      || typeof generateSecret !== "function" || typeof clock !== "function" || typeof processExists !== "function"
      || !Number.isSafeInteger(processId) || processId < 1
      || !Number.isFinite(staleLockMilliseconds) || staleLockMilliseconds < 1
      || (operationHook !== null && typeof operationHook !== "function")) {
    fail("account_observation_credential_invalid");
  }

  return async function loadAccountObservationSecret() {
    const lease = await acquireOperationLease(operationLockFile, {
      clock,
      processExists,
      processId,
      staleLockMilliseconds,
      operationHook,
    });
    let generated = null;
    let generatedValue = null;
    let persisted = null;
    try {
      const existing = await invokeBackend(backend, "read", capability);
      if (existing !== null) {
        const result = copySecret(existing);
        if (Buffer.isBuffer(existing)) existing.fill(0);
        return result;
      }
      // Upload/review may lease an existing observation root, but must never
      // create an identity merely because contribution was requested.
      if (!createIfMissing) return null;

      generatedValue = generateSecret();
      generated = copySecret(generatedValue);
      if (Buffer.isBuffer(generatedValue)) generatedValue.fill(0);
      const outcome = await invokeBackend(backend, "createIfMissing", capability, generated);
      if (outcome !== "created" && outcome !== "existing") {
        fail("account_observation_credential_unavailable");
      }
      persisted = await invokeBackend(backend, "read", capability);
      if (persisted === null) fail("account_observation_credential_unavailable");
      const result = copySecret(persisted);
      if (outcome === "created" && !result.equals(generated)) {
        result.fill(0);
        fail("account_observation_credential_unavailable");
      }
      return result;
    } finally {
      if (Buffer.isBuffer(generatedValue)) generatedValue.fill(0);
      generated?.fill(0);
      if (Buffer.isBuffer(persisted)) persisted.fill(0);
      await releaseOperationLease(operationLockFile, lease);
    }
  };
}

export function createDevelopmentAccountObservationSecretLoader(secret) {
  const copy = copySecret(secret);
  return async function loadDevelopmentAccountObservationSecret() {
    return Buffer.from(copy);
  };
}
