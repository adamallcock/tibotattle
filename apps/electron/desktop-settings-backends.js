import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

import {
  validateDesktopSettingsSnapshot,
} from "./desktop-contract.js";
import {
  isWindowsProtectedStateStore,
  isWindowsProtectedStateStoreError,
} from "../../src/platform/index.js";

/**
 * The settings payload is deliberately much smaller than the native Windows
 * state-store ceiling.  Keeping the limit here means the POSIX and protected
 * Windows implementations have the same bounded input contract.
 */
export const DESKTOP_SETTINGS_BACKEND_MAX_BYTES = 64 * 1024;
export const DESKTOP_SETTINGS_FILE_NAME = "desktop-settings-v1.json";
export const DESKTOP_SETTINGS_STAGE_PREFIX = ".desktop-settings-v1";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const READ_FLAGS = constants.O_RDONLY | NOFOLLOW;
const WRITE_FLAGS = constants.O_WRONLY
  | constants.O_CREAT
  | constants.O_EXCL
  | NOFOLLOW;
const POSIX_PLATFORMS = new Set([
  "aix",
  "darwin",
  "freebsd",
  "linux",
  "netbsd",
  "openbsd",
]);
const ERROR_CODES = new Set([
  "invalid_configuration",
  "unsupported_platform",
  "invalid_snapshot",
  "unsafe_state",
  "corrupt",
  "too_large",
  "unavailable",
  "write_failed",
  "store_invalid",
  "store_unsafe",
  "reconciliation_required",
]);
const WINDOWS_ERROR_CODES = Object.freeze({
  windows_protected_state_store_invalid_configuration: "store_invalid",
  windows_protected_state_store_invalid_adapter: "store_invalid",
  windows_protected_state_store_invalid_root: "store_unsafe",
  windows_protected_state_store_invalid_path: "store_invalid",
  windows_protected_state_store_path_escape: "store_unsafe",
  windows_protected_state_store_invalid_identity: "store_unsafe",
  windows_protected_state_store_security_policy: "store_unsafe",
  windows_protected_state_store_missing: "missing",
  windows_protected_state_store_already_exists: "write_failed",
  windows_protected_state_store_identity_mismatch: "write_failed",
  windows_protected_state_store_too_large: "too_large",
  windows_protected_state_store_unavailable: "unavailable",
  windows_protected_state_store_contended: "write_failed",
  windows_protected_state_store_audit_failed: "unavailable",
});

const BACKEND_ERRORS = new WeakSet();

/**
 * Fixed, content-free errors for both settings backends.  Native filesystem
 * messages and paths never cross the Electron settings boundary.
 */
export class DesktopSettingsBackendError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown desktop settings backend error code");
    }
    super("Desktop settings backend operation failed");
    this.name = "DesktopSettingsBackendError";
    this.code = `desktop_settings_backend_${code}`;
    BACKEND_ERRORS.add(this);
  }
}

export function isDesktopSettingsBackendError(error) {
  return Boolean(error
    && BACKEND_ERRORS.has(error)
    && Object.getPrototypeOf(error) === DesktopSettingsBackendError.prototype);
}

function fail(code) {
  throw new DesktopSettingsBackendError(code);
}

function nativeCode(error) {
  try {
    return typeof error?.code === "string" ? error.code : "";
  } catch {
    return "";
  }
}

function mapFilesystemError(error, fallback = "unavailable") {
  if (isDesktopSettingsBackendError(error)) throw error;
  const code = nativeCode(error);
  if (code === "ELOOP"
      || code === "ENOTDIR"
      || code === "EACCES"
      || code === "EPERM") {
    fail("unsafe_state");
  }
  if (code === "EFBIG" || code === "ENOSPC") fail("too_large");
  if (code === "EEXIST") fail("write_failed");
  fail(fallback);
}

function mapWindowsError(error, { missing = false } = {}) {
  if (isDesktopSettingsBackendError(error)) throw error;
  let code = "";
  try {
    if (isWindowsProtectedStateStoreError(error)) code = nativeCode(error);
  } catch {
    code = "";
  }
  const mapped = WINDOWS_ERROR_CODES[code] ?? "unavailable";
  if (mapped === "missing" && missing) return null;
  if (mapped === "missing") fail("unavailable");
  fail(mapped);
}

function assertOptionsObject(options, label) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError(`${label} must be an object`);
  }
  return options;
}

function assertPlatform(platform, expected) {
  if (typeof platform !== "string" || platform.length === 0) {
    throw new TypeError("platform must be a non-empty string");
  }
  if (expected === "posix" && !POSIX_PLATFORMS.has(platform)) {
    fail("unsupported_platform");
  }
  if (expected === "windows" && platform !== "win32") {
    fail("unsupported_platform");
  }
  return platform;
}

function assertAbsoluteRoot(rootPath) {
  if (typeof rootPath !== "string"
      || rootPath.length === 0
      || rootPath.includes("\0")
      || !isAbsolute(rootPath)) {
    throw new TypeError("rootPath must be an absolute path");
  }
  return rootPath;
}

function assertFixedChildName(name) {
  if (typeof name !== "string"
      || name.length < 1
      || name.length > 255
      || name.includes("\0")
      || basename(name) !== name
      || name === "."
      || name === ".."
      || name.includes("/")
      || name.includes("\\")) {
    throw new TypeError("settings filename must be one fixed child name");
  }
  return name;
}

function assertMaximumBytes(maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes)
      || maximumBytes < 1
      || maximumBytes > DESKTOP_SETTINGS_BACKEND_MAX_BYTES) {
    throw new TypeError("maximumBytes is invalid");
  }
  return maximumBytes;
}

function requireFs(fs) {
  assertOptionsObject(fs, "fs");
  for (const method of ["chmod", "lstat", "mkdir", "open", "rename", "unlink"]) {
    if (typeof fs[method] !== "function") {
      throw new TypeError(`fs.${method} is required`);
    }
  }
  return fs;
}

function numberValue(value) {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)
        || value < BigInt(Number.MIN_SAFE_INTEGER)) return null;
    return Number(value);
  }
  return Number.isSafeInteger(value) ? value : null;
}

function statMode(stats) {
  const mode = numberValue(stats?.mode);
  return mode === null ? null : mode & 0o777;
}

function statSize(stats) {
  const size = numberValue(stats?.size);
  return size !== null && size >= 0 ? size : null;
}

function statLinkCount(stats) {
  const links = numberValue(stats?.nlink);
  return links !== null && links >= 0 ? links : null;
}

function statUid(stats) {
  const uid = numberValue(stats?.uid);
  return uid === null || uid < 0 ? null : uid;
}

function statIdentity(stats) {
  const dev = stats?.dev;
  const ino = stats?.ino;
  if (dev === undefined || ino === undefined) return null;
  return `${String(dev)}:${String(ino)}`;
}

function sameStatIdentity(left, right) {
  const leftIdentity = statIdentity(left);
  const rightIdentity = statIdentity(right);
  return leftIdentity !== null && leftIdentity === rightIdentity;
}

function currentUidGetter(options) {
  const getter = options.currentUid ?? (() => (
    typeof process.getuid === "function" ? process.getuid() : null
  ));
  if (typeof getter !== "function") throw new TypeError("currentUid must be a function");
  return () => {
    let value;
    try {
      value = getter();
    } catch {
      fail("unavailable");
    }
    if (value === null || value === undefined) return null;
    const uid = numberValue(value);
    if (uid === null || uid < 0) fail("unsafe_state");
    return uid;
  };
}

function assertDirectoryStats(stats, uid) {
  let directory = false;
  let symlink = false;
  try {
    directory = stats?.isDirectory?.() === true;
    symlink = stats?.isSymbolicLink?.() === true;
  } catch {
    fail("unsafe_state");
  }
  if (!directory || symlink || statMode(stats) !== DIRECTORY_MODE) {
    fail("unsafe_state");
  }
  const owner = statUid(stats);
  if (owner === null || (uid !== null && owner !== uid)) fail("unsafe_state");
  return stats;
}

function assertFileStats(stats, uid, maximumBytes, { allowEmpty = true } = {}) {
  let regular = false;
  let symlink = false;
  try {
    regular = stats?.isFile?.() === true;
    symlink = stats?.isSymbolicLink?.() === true;
  } catch {
    fail("unsafe_state");
  }
  const size = statSize(stats);
  const links = statLinkCount(stats);
  const owner = statUid(stats);
  if (!regular || symlink || links !== 1 || size === null
      || size > maximumBytes
      || (!allowEmpty && size < 1)
      || statMode(stats) !== FILE_MODE
      || owner === null
      || (uid !== null && owner !== uid)) {
    if (size !== null && size > maximumBytes) fail("too_large");
    fail("unsafe_state");
  }
  return size;
}

function encodeSnapshot(snapshot, maximumBytes) {
  let validated;
  try {
    validated = validateDesktopSettingsSnapshot(snapshot);
  } catch {
    fail("invalid_snapshot");
  }
  let bytes;
  try {
    bytes = Buffer.from(`${JSON.stringify(validated)}\n`, "utf8");
  } catch {
    fail("invalid_snapshot");
  }
  if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
    bytes.fill(0);
    fail("too_large");
  }
  return Object.freeze({ snapshot: validated, bytes });
}

function decodeSnapshot(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    fail("corrupt");
  }
  try {
    return validateDesktopSettingsSnapshot(parsed);
  } catch {
    fail("corrupt");
  }
}

/**
 * The settings file format is also used by the first-run receipt, which is a
 * separate fixed child with a different schema.  Keep the filesystem and
 * protected-store security code shared while making the value codec explicit
 * so one record can never be decoded as another record by accident.
 */
function defaultRecordCodec() {
  return Object.freeze({
    encode(value, maximumBytes) {
      const encoded = encodeSnapshot(value, maximumBytes);
      return Object.freeze({ value: encoded.snapshot, bytes: encoded.bytes });
    },
    decodeBytes(bytes) {
      return decodeSnapshot(bytes);
    },
    decodeValue(value) {
      try {
        return validateDesktopSettingsSnapshot(value);
      } catch {
        fail("corrupt");
      }
    },
  });
}

function assertRecordCodec(codec) {
  const selected = codec === undefined ? defaultRecordCodec() : codec;
  if (selected === null
      || typeof selected !== "object"
      || Array.isArray(selected)
      || typeof selected.encode !== "function"
      || typeof selected.decodeBytes !== "function"
      || typeof selected.decodeValue !== "function") {
    throw new TypeError("codec must implement encode, decodeBytes, and decodeValue");
  }
  return selected;
}

function assertEncodedRecord(encoded, maximumBytes) {
  if (encoded === null
      || typeof encoded !== "object"
      || Array.isArray(encoded)
      || !(encoded.bytes instanceof Uint8Array)
      || encoded.bytes.byteLength < 1
      || encoded.bytes.byteLength > maximumBytes
      || encoded.value === null
      || typeof encoded.value !== "object"
      || Array.isArray(encoded.value)) {
    fail("invalid_snapshot");
  }
  return encoded;
}

function snapshotsEqual(left, right) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function assertProtectedRecordBytes(record, maximumBytes) {
  if (!(record?.data instanceof Uint8Array)
      || record.data.byteLength < 1) {
    fail("corrupt");
  }
  if (record.data.byteLength > maximumBytes) fail("too_large");
}

function stageName(filename, id) {
  if (typeof id !== "string"
      || id.length < 1
      || id.length > 128
      || id.includes("\0")
      || id.includes("/")
      || id.includes("\\")) {
    fail("invalid_configuration");
  }
  // The target filename remains fixed; a unique O_EXCL stage prevents a
  // stale process from being silently overwritten before the atomic rename.
  return `.${DESKTOP_SETTINGS_STAGE_PREFIX.slice(1)}.${filename}.${id}.tmp`;
}

function isMissing(error) {
  return nativeCode(error) === "ENOENT";
}

/**
 * POSIX/macOS owner-only settings backend.
 *
 * The filesystem implementation is injected to keep the boundary directly
 * testable.  Production should inject node:fs/promises and an absolute,
 * application-owned state root.  Existing unsafe state is never repaired or
 * chmodded: callers receive one fixed failure instead.
 */
export function createPosixDesktopSettingsBackend(options = {}) {
  const configuration = assertOptionsObject(options, "options");
  const platform = assertPlatform(
    configuration.platform ?? process.platform,
    "posix",
  );
  const rootPath = assertAbsoluteRoot(configuration.rootPath ?? configuration.root);
  const filename = assertFixedChildName(
    configuration.filename ?? DESKTOP_SETTINGS_FILE_NAME,
  );
  const maximumBytes = assertMaximumBytes(
    configuration.maximumBytes ?? DESKTOP_SETTINGS_BACKEND_MAX_BYTES,
  );
  const fs = requireFs(configuration.fs ?? nodeFs);
  const codec = assertRecordCodec(configuration.codec);
  const currentUid = currentUidGetter(configuration);
  const makeId = configuration.idFactory ?? randomUUID;
  if (typeof makeId !== "function") throw new TypeError("idFactory must be a function");
  const syncDirectory = configuration.syncDirectory ?? (async (path) => {
    let handle;
    try {
      handle = await fs.open(path, "r");
      if (typeof handle?.sync !== "function") fail("unavailable");
      await handle.sync();
    } catch (error) {
      if (isDesktopSettingsBackendError(error)) throw error;
      mapFilesystemError(error);
    } finally {
      try {
        await handle?.close?.();
      } catch (error) {
        if (!isDesktopSettingsBackendError(error)) fail("unavailable");
      }
    }
  });
  if (typeof syncDirectory !== "function") throw new TypeError("syncDirectory must be a function");

  const targetPath = join(rootPath, filename);

  async function lstatOrNull(path) {
    try {
      return await fs.lstat(path);
    } catch (error) {
      if (isMissing(error)) return null;
      mapFilesystemError(error);
    }
  }

  async function ensureRoot({ create }) {
    let stats = await lstatOrNull(rootPath);
    if (stats === null) {
      if (!create) return null;
      try {
        const created = await fs.mkdir(rootPath, {
          recursive: true,
          mode: DIRECTORY_MODE,
        });
        // Node returns the first path it created for recursive mkdir.  Only
        // chmod when that result is the requested final directory; an
        // undefined result means another process already supplied it, so an
        // unsafe pre-existing directory remains a hard failure below.
        if (created === rootPath) await fs.chmod(rootPath, DIRECTORY_MODE);
      } catch (error) {
        mapFilesystemError(error);
      }
      stats = await lstatOrNull(rootPath);
      if (stats === null) fail("unavailable");
    }
    assertDirectoryStats(stats, currentUid());
    return stats;
  }

  async function inspectTarget({ allowMissing = true } = {}) {
    const stats = await lstatOrNull(targetPath);
    if (stats === null) {
      if (allowMissing) return null;
      fail("unavailable");
    }
    assertFileStats(stats, currentUid(), maximumBytes);
    return stats;
  }

  async function assertRootUnchanged(reference) {
    const current = await fs.lstat(rootPath);
    assertDirectoryStats(current, currentUid());
    if (!sameStatIdentity(reference, current)) fail("unsafe_state");
    return current;
  }

  async function read() {
    const rootStats = await ensureRoot({ create: false });
    if (rootStats === null) return null;
    const targetStats = await inspectTarget();
    if (targetStats === null) return null;
    const size = statSize(targetStats);
    if (size === null) fail("unsafe_state");
    await assertRootUnchanged(rootStats);

    let handle;
    let primary;
    let bytes;
    try {
      try {
        handle = await fs.open(targetPath, READ_FLAGS);
        const openedStats = await handle.stat();
        assertFileStats(openedStats, currentUid(), maximumBytes);
        if (!sameStatIdentity(targetStats, openedStats)
            || statSize(openedStats) !== size) {
          fail("unsafe_state");
        }
        const buffer = Buffer.alloc(maximumBytes + 1);
        const result = await handle.read(buffer, 0, buffer.byteLength, 0);
        if (!result || !Number.isSafeInteger(result.bytesRead)
            || result.bytesRead < 0 || result.bytesRead > maximumBytes) {
          buffer.fill(0);
          fail("too_large");
        }
        if (result.bytesRead !== size) {
          buffer.fill(0);
          fail("unsafe_state");
        }
        bytes = Buffer.from(buffer.subarray(0, result.bytesRead));
        buffer.fill(0);
        const afterHandle = await handle.stat();
        const afterPath = await fs.lstat(targetPath);
        assertFileStats(afterHandle, currentUid(), maximumBytes);
        assertFileStats(afterPath, currentUid(), maximumBytes);
        if (!sameStatIdentity(openedStats, afterHandle)
            || !sameStatIdentity(afterHandle, afterPath)
            || statSize(afterHandle) !== size
            || statSize(afterPath) !== size) {
          bytes.fill(0);
          fail("unsafe_state");
        }
        await assertRootUnchanged(rootStats);
      } catch (error) {
        primary = error;
      }
    } finally {
      try {
        await handle?.close?.();
      } catch (error) {
        if (primary === undefined) primary = error;
      }
    }
    void rootStats;
    if (primary !== undefined) {
      if (isDesktopSettingsBackendError(primary)) throw primary;
      mapFilesystemError(primary);
    }
    try {
      return codec.decodeBytes(bytes);
    } finally {
      bytes?.fill(0);
    }
  }

  async function save(snapshot) {
    const encoded = assertEncodedRecord(codec.encode(snapshot, maximumBytes), maximumBytes);
    const { bytes } = encoded;
    let stagePath;
    let handle;
    let stageOwned = false;
    let committed = false;
    let primary;
    try {
      const rootStats = await ensureRoot({ create: true });
      await inspectTarget();
      let id;
      try {
        id = makeId();
      } catch {
        fail("invalid_configuration");
      }
      stagePath = join(rootPath, stageName(filename, id));
      try {
        handle = await fs.open(stagePath, WRITE_FLAGS, FILE_MODE);
        stageOwned = true;
        await handle.chmod(FILE_MODE);
        await handle.writeFile(bytes);
        await handle.sync();
        const stageStats = await handle.stat();
        const stageSize = assertFileStats(
          stageStats,
          currentUid(),
          maximumBytes,
          { allowEmpty: false },
        );
        if (stageSize !== bytes.byteLength) fail("unsafe_state");
        await handle.close();
        handle = null;
        const stagePathStats = await fs.lstat(stagePath);
        assertFileStats(stagePathStats, currentUid(), maximumBytes, {
          allowEmpty: false,
        });
        if (statSize(stagePathStats) !== bytes.byteLength) fail("unsafe_state");
        const currentRootStats = await fs.lstat(rootPath);
        assertDirectoryStats(currentRootStats, currentUid());
        if (!sameStatIdentity(rootStats, currentRootStats)) fail("unsafe_state");
        // Revalidate the destination immediately before rename.  rename is
        // atomic, but replacing a destination that became a symlink or hard
        // link would violate the fail-closed state policy.
        await inspectTarget();
        await fs.rename(stagePath, targetPath);
        committed = true;
        await syncDirectory(rootPath);
        const finalRootStats = await fs.lstat(rootPath);
        assertDirectoryStats(finalRootStats, currentUid());
        if (!sameStatIdentity(rootStats, finalRootStats)) fail("unsafe_state");
        const finalStats = await fs.lstat(targetPath);
        assertFileStats(finalStats, currentUid(), maximumBytes, {
          allowEmpty: false,
        });
        if (statSize(finalStats) !== bytes.byteLength) fail("unsafe_state");
      } catch (error) {
        primary = error;
      }
    } catch (error) {
      primary = error;
    } finally {
      try {
        await handle?.close?.();
      } catch (error) {
        if (primary === undefined) primary = error;
      }
      if (!committed && stageOwned && stagePath !== undefined) {
        try {
          await fs.unlink(stagePath);
        } catch (error) {
          if (!isMissing(error) && primary === undefined) primary = error;
        }
      }
    }
    if (primary !== undefined && committed) {
      // rename is the atomic publication point. A later directory-sync or
      // read-back failure must not make callers believe the old in-memory
      // snapshot is still on disk. Re-read the published file and reconcile
      // the outcome to the new snapshot; if it cannot be proven, surface an
      // explicit reconciliation state instead of an ordinary write failure.
      let observed;
      try {
        observed = await read();
      } catch {
        observed = null;
      }
      if (snapshotsEqual(observed, encoded.value)) {
        primary = undefined;
      } else {
        primary = new DesktopSettingsBackendError("reconciliation_required");
      }
    }
    bytes.fill(0);
    if (primary !== undefined) {
      if (isDesktopSettingsBackendError(primary)) throw primary;
      mapFilesystemError(primary);
    }
    return encoded.value;
  }

  return Object.freeze({ load: read, save });
}

/**
 * Windows settings backend over the repository-branded protected state store.
 * This adapter intentionally has no ordinary Node filesystem fallback.  The
 * protected store returns an identity with every read; replacements must pass
 * that exact identity back to replaceJson.
 */
export function createWindowsDesktopSettingsBackend(options = {}) {
  const configuration = assertOptionsObject(options, "options");
  assertPlatform(configuration.platform ?? "win32", "windows");
  let store;
  try {
    store = configuration.windowsProtectedStateStore;
    if (!isWindowsProtectedStateStore(store)) fail("store_invalid");
  } catch (error) {
    if (isDesktopSettingsBackendError(error)) throw error;
    fail("store_invalid");
  }
  if (typeof store.readJson !== "function"
      || typeof store.createJson !== "function"
      || typeof store.replaceJson !== "function") {
    fail("store_invalid");
  }
  const childName = assertFixedChildName(
    configuration.childName ?? DESKTOP_SETTINGS_FILE_NAME,
  );
  const storeMaximumBytes = Number.isSafeInteger(store.maxBytes)
    ? store.maxBytes
    : DESKTOP_SETTINGS_BACKEND_MAX_BYTES;
  const maximumBytes = assertMaximumBytes(
    configuration.maximumBytes ?? Math.min(
      DESKTOP_SETTINGS_BACKEND_MAX_BYTES,
      storeMaximumBytes,
    ),
  );
  if (storeMaximumBytes < maximumBytes) fail("store_invalid");
  const codec = assertRecordCodec(configuration.codec);

  async function load() {
    let record;
    try {
      record = await store.readJson(childName);
    } catch (error) {
      return mapWindowsError(error, { missing: true });
    }
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      fail("corrupt");
    }
    assertProtectedRecordBytes(record, maximumBytes);
    const data = record.value;
    let validated;
    try {
      validated = codec.decodeValue(data);
    } catch {
      fail("corrupt");
    }
    return validated;
  }

  async function save(snapshot) {
    // validate and bound before touching the protected state store.  The
    // native store performs its own stable JSON serialization and ceiling
    // check, but the desktop contract remains the authority here.
    const encoded = assertEncodedRecord(codec.encode(snapshot, maximumBytes), maximumBytes);
    encoded.bytes.fill(0);
    let existing;
    try {
      existing = await store.readJson(childName);
    } catch (error) {
      const code = nativeCode(error);
      if (!isWindowsProtectedStateStoreError(error)
          || code !== "windows_protected_state_store_missing") {
        mapWindowsError(error);
      }
    }
    try {
      if (existing === undefined || existing === null) {
        await store.createJson(childName, encoded.value);
      } else {
        if (typeof existing !== "object" || Array.isArray(existing)) fail("corrupt");
        assertProtectedRecordBytes(existing, maximumBytes);
        try {
          codec.decodeValue(existing.value);
        } catch {
          fail("corrupt");
        }
        await store.replaceJson(childName, existing.identity, encoded.value);
      }
    } catch (error) {
      if (isDesktopSettingsBackendError(error)) throw error;
      mapWindowsError(error);
    }
    return encoded.value;
  }

  return Object.freeze({ load, save });
}

export const createMacDesktopSettingsBackend = createPosixDesktopSettingsBackend;
export const createMacOSDesktopSettingsBackend = createPosixDesktopSettingsBackend;
