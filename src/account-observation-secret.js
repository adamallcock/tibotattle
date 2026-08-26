import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultExportStateDirectory } from "./export-identity.js";
import {
  assertWindowsFilesystemProductionSafe,
  isWindowsFilesystemAdapter,
  isWindowsFilesystemIdentity,
} from "./platform/index.js";

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

function assertBackend(backend, capability) {
  let valid = capability !== null && capability !== undefined;
  try {
    valid = valid && backend !== null && typeof backend === "object"
      && typeof backend.read === "function"
      && typeof backend.createIfMissing === "function";
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
    fail(code === "export_identity_keychain_locked"
      || code === "windows_credential_manager_locked"
      ? "account_observation_credential_locked"
      : "account_observation_credential_unavailable");
  }
}

function sameIdentity(left, right) {
  if (isWindowsFilesystemIdentity(left) && isWindowsFilesystemIdentity(right)) {
    return left.volumeSerialNumber === right.volumeSerialNumber
      && left.fileId === right.fileId;
  }
  return typeof left?.dev === "number" && typeof left?.ino === "number"
    && typeof right?.dev === "number" && typeof right?.ino === "number"
    && left.dev === right.dev && left.ino === right.ino;
}

function isWindowsFilesystemNotFound(error) {
  return error?.code === "ENOENT"
    || error?.code === "WINDOWS_FILESYSTEM_NOT_FOUND";
}

function isWindowsFilesystemAlreadyExists(error) {
  return error?.code === "EEXIST"
    || error?.code === "WINDOWS_FILESYSTEM_ALREADY_EXISTS";
}

function resolveWindowsFilesystemAdapter(adapter) {
  const selected = adapter ?? null;
  // No adapter is the existing development/portable path. Production Windows
  // selection is gated separately, so this loader must not turn an ordinary
  // no-adapter test or developer invocation into an accidental policy claim.
  if (selected === null) return null;
  if (!isWindowsFilesystemAdapter(selected)) {
    fail("account_observation_credential_unavailable");
  }
  try {
    return assertWindowsFilesystemProductionSafe(selected);
  } catch {
    fail("account_observation_credential_invalid");
  }
}

function assertWindowsLockMetadata(metadata) {
  if (metadata?.isDirectory !== false
      || metadata.isRegularFile !== true
      || metadata.isReparsePoint !== false
      || metadata.ownerMatches !== true
      || metadata.nullDacl !== false
      || metadata.daclProtected !== true
      || metadata.broadAccess !== false
      || metadata.nonOwnerAllow !== false
      || metadata.unrecognizedAce !== false
      || metadata.finalPathResolved !== true
      || !isWindowsFilesystemIdentity(metadata.identity)
      || metadata.identity.linkCount !== 1) {
    fail("account_observation_credential_unavailable");
  }
  return metadata;
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

async function prepareLockDirectory(path, windowsFilesystem = null) {
  const directory = dirname(path);
  if (windowsFilesystem !== null) {
    let identity;
    try {
      identity = windowsFilesystem.ensureDirectory(directory);
    } catch {
      fail("account_observation_credential_unavailable");
    }
    if (!isWindowsFilesystemIdentity(identity) || identity.linkCount !== 1) {
      fail("account_observation_credential_unavailable");
    }
    return { directory, identity, windowsFilesystem };
  }
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
  if (directoryState.windowsFilesystem !== undefined) {
    try {
      const metadata = directoryState.windowsFilesystem.inspectPath(directoryState.directory);
      if (!isWindowsFilesystemIdentity(directoryState.identity)
          || directoryState.identity.linkCount !== 1
          || metadata?.isDirectory !== true
          || metadata.isRegularFile !== false
          || metadata.isReparsePoint !== false
          || metadata.ownerMatches !== true
          || metadata.nullDacl !== false
          || metadata.daclProtected !== true
          || metadata.broadAccess !== false
          || metadata.nonOwnerAllow !== false
          || metadata.unrecognizedAce !== false
          || metadata.finalPathResolved !== true
          || !isWindowsFilesystemIdentity(metadata.identity)
          || metadata.identity.linkCount !== 1
          || !sameIdentity(metadata.identity, directoryState.identity)) {
        fail("account_observation_credential_unavailable");
      }
    } catch (error) {
      if (error instanceof AccountObservationSecretError) throw error;
      fail("account_observation_credential_unavailable");
    }
    return;
  }
  const stats = await lstat(directoryState.directory);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !sameIdentity(stats, directoryState.identity)
      || (typeof process.getuid === "function" && typeof stats.uid === "number" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o022) !== 0)) {
    fail("account_observation_credential_unavailable");
  }
}

async function syncLockDirectory(directoryState) {
  await assertLockDirectory(directoryState);
  if (directoryState.windowsFilesystem !== undefined) return;
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
  if (directoryState.windowsFilesystem !== undefined) {
    let metadata;
    try {
      metadata = assertWindowsLockMetadata(
        directoryState.windowsFilesystem.inspectPath(path),
      );
    } catch (error) {
      if (isWindowsFilesystemNotFound(error)) return null;
      if (error instanceof AccountObservationSecretError) throw error;
      fail("account_observation_credential_unavailable");
    }
    let observed;
    try {
      observed = directoryState.windowsFilesystem.readFile(path);
    } catch {
      fail("account_observation_credential_unavailable");
    }
    try {
      if (!Buffer.isBuffer(observed?.data)
          || !sameIdentity(metadata.identity, observed.identity)) {
        fail("account_observation_credential_unavailable");
      }
      const owner = parseLockContent(observed.data);
      return {
        kind: "complete",
        owner,
        identity: metadata.identity,
        // The native boundary publishes the complete lock in one create call,
        // so there is no mtime-based incomplete-write recovery path. The
        // signed content timestamp is the only stale-owner clock available.
        mtimeMs: owner.createdAtMs,
      };
    } finally {
      observed?.data?.fill?.(0);
    }
  }
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
  if (directoryState.windowsFilesystem !== undefined) {
    try {
      directoryState.windowsFilesystem.deleteFile(path, inspected.identity);
    } catch (error) {
      if (isWindowsFilesystemNotFound(error)
          || error?.code === "WINDOWS_FILESYSTEM_IDENTITY_MISMATCH") {
        return false;
      }
      fail("account_observation_credential_unavailable");
    }
    await syncLockDirectory(directoryState);
    await operationHook?.("after-stale-lock-removal");
    return true;
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
  windowsFilesystem = null,
}) {
  const directoryState = await prepareLockDirectory(path, windowsFilesystem);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (windowsFilesystem !== null) {
      let identity;
      try {
        identity = windowsFilesystem.createFile(
          path,
          Buffer.from(lockContent(processId, clock()), "utf8"),
        );
      } catch (error) {
        if (!isWindowsFilesystemAlreadyExists(error)) {
          fail("account_observation_credential_unavailable");
        }
        const inspected = await inspectExistingLock(path, directoryState);
        if (inspected === null) continue;
        const now = clock();
        if (!Number.isFinite(now)) fail("account_observation_credential_unavailable");
        const age = now - inspected.owner.createdAtMs;
        if (age < -MAXIMUM_CLOCK_SKEW_MILLISECONDS) {
          fail("account_observation_credential_unavailable");
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
        const metadata = assertWindowsLockMetadata(
          windowsFilesystem.inspectPath(path),
        );
        if (!sameIdentity(identity, metadata.identity)) {
          fail("account_observation_credential_unavailable");
        }
        const observed = windowsFilesystem.readFile(path);
        try {
          if (!Buffer.isBuffer(observed?.data)
              || !sameIdentity(identity, observed.identity)
              || !parseLockContent(observed.data)) {
            fail("account_observation_credential_unavailable");
          }
        } finally {
          observed?.data?.fill?.(0);
        }
        await assertLockDirectory(directoryState);
        await syncLockDirectory(directoryState);
        await operationHook?.("after-operation-lock-acquired");
        return {
          handle: null,
          identity,
          directoryState,
          windowsFilesystem,
        };
      } catch (error) {
        try {
          windowsFilesystem.deleteFile(path, identity);
        } catch {
          // The fixed failure below is more useful than an unsafe cleanup guess.
        }
        if (error instanceof AccountObservationSecretError) throw error;
        fail("account_observation_credential_unavailable");
      }
    }
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
  if (lease.windowsFilesystem !== undefined) {
    try {
      await assertLockDirectory(lease.directoryState);
      lease.windowsFilesystem.deleteFile(path, lease.identity);
      await syncLockDirectory(lease.directoryState);
      return;
    } catch (error) {
      if (isWindowsFilesystemNotFound(error)) return;
      fail("account_observation_credential_unavailable");
    }
  }
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
  windowsFilesystemAdapter = null,
} = {}) {
  assertBackend(backend, capability);
  const windowsFilesystem = resolveWindowsFilesystemAdapter(windowsFilesystemAdapter);
  if (typeof generateSecret !== "function" || typeof clock !== "function" || typeof processExists !== "function"
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
      windowsFilesystem,
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
