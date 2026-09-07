import { createHash, randomUUID } from "node:crypto";
import { constants as fileSystemConstants } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  DESKTOP_DEFAULT_SETTINGS,
  migrateDesktopSettingsSnapshot,
  validateDesktopSettingsSnapshot,
} from "./desktop-contract.js";
import {
  DESKTOP_FIRST_RUN_RECEIPT_FILE_NAME,
  DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
} from "./desktop-first-run.js";
import { PRODUCTION_ELECTRON_APP_ID } from "./desktop-updater.js";

/**
 * Source-level native-to-Electron handover.  This intentionally supports only
 * a guided, signed install: current 0.1.17 and 0.1.18 native artifacts do not
 * contain a general handover command, so it is not a direct Sparkle updater.
 *
 * The coordinator is deliberately invoked before the Electron runtime opens
 * its companion state.  It copies an already-stopped native state root into a
 * private staged candidate, validates it and then publishes the two Electron
 * roots through a durable transaction journal.  It never deletes or rewrites
 * the native root, credentials, or installed native application.
 */
export const NATIVE_ELECTRON_HANDOVER_SCHEMA_VERSION =
  "tibotattle-native-electron-handover-v1";
export const NATIVE_ELECTRON_HANDOVER_ROUTE = "guided_signed_install";
// Shared with the Electron updater's closed production policy. This import is
// an identity consistency check, not updater or signed-artifact evidence.
export const NATIVE_ELECTRON_APP_ID = PRODUCTION_ELECTRON_APP_ID;
export const SUPPORTED_NATIVE_HANDOVER_VERSIONS = Object.freeze(["0.1.17", "0.1.18"]);
export const NATIVE_ELECTRON_HANDOVER_LEASE_FILE = "lease-v1.json";
export const NATIVE_ELECTRON_HANDOVER_JOURNAL_FILE = "journal-v1.json";
export const NATIVE_ELECTRON_HANDOVER_MARKER_FILE = "completed-v1.json";
export const NATIVE_ELECTRON_HANDOVER_MAX_ENTRIES = 1_000_000;
export const NATIVE_ELECTRON_HANDOVER_MAX_BYTES = 128 * 1024 * 1024 * 1024;

const NATIVE_LAUNCHER_SETTINGS_FILE = "launcher-settings-v1.json";
const NATIVE_LAUNCHER_SETTINGS_SCHEMA = "usage-monitor-launcher-settings-v1";
const NATIVE_FIRST_RUN_FILE = "first-run-v1.json";
const NATIVE_FIRST_RUN_SCHEMA = "usage-monitor-first-run-v1";
const STATE_SALT_FILE = "local-unified-index-device-salt-v1";
const STATE_INDEX_FILE = "local-unified-index-v1.sqlite";
const STAGING_DIRECTORY = "staging";
const BACKUP_DIRECTORY = "backups";
const CONTROL_DIRECTORY = ".native-electron-handover-v1";
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const NOFOLLOW = fileSystemConstants.O_NOFOLLOW ?? 0;
const READ_FLAGS = (fileSystemConstants.O_RDONLY ?? 0) | NOFOLLOW;
const CREATE_EXCLUSIVE_FLAGS = (fileSystemConstants.O_WRONLY ?? 1)
  | (fileSystemConstants.O_CREAT ?? 0)
  | (fileSystemConstants.O_EXCL ?? 0)
  | NOFOLLOW;
const JOURNAL_PHASES = new Set([
  "started",
  "prepared",
  "backed_up",
  "staged",
  "published_state",
  "published",
  "electron_login_owned",
  "completed",
]);
const SAFE_LINEAGE = /^[A-Za-z0-9._:+-]{1,256}$/u;
const SAFE_VERSION = /^(?:0|[1-9][0-9]{0,9})(?:\.(?:0|[1-9][0-9]{0,9})){0,7}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CODE_HASH = /^[a-f0-9]{40,64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HANDOVER_ERRORS = new WeakSet();

export class NativeElectronHandoverError extends Error {
  constructor(code) {
    super("Native-to-Electron handover could not continue");
    this.name = "NativeElectronHandoverError";
    this.code = `native_electron_handover_${code}`;
    HANDOVER_ERRORS.add(this);
  }
}

export function isNativeElectronHandoverError(error) {
  return Boolean(error
    && HANDOVER_ERRORS.has(error)
    && Object.getPrototypeOf(error) === NativeElectronHandoverError.prototype);
}

function fail(code) {
  throw new NativeElectronHandoverError(code);
}

function plainRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys) {
  return plainRecord(value)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function assertAbsolutePath(value, code = "invalid_configuration") {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
      || !isAbsolute(value)) {
    fail(code);
  }
  return resolve(value);
}

function assertCount(value, maximum, code = "invalid_configuration") {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail(code);
  return value;
}

function pathContains(parent, child) {
  const result = relative(parent, child);
  return result === "" || (!result.startsWith(`..${String.raw`/`}`)
    && result !== ".." && !result.includes(`..${String.raw`/`}`));
}

function pathsOverlap(left, right) {
  return pathContains(left, right) || pathContains(right, left);
}

function safeString(value, expression = SAFE_LINEAGE) {
  return typeof value === "string" && expression.test(value);
}

function compareNumericVersions(left, right) {
  if (!safeString(left, SAFE_VERSION) || !safeString(right, SAFE_VERSION)) return null;
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  const count = Math.max(a.length, b.length);
  for (let index = 0; index < count; index += 1) {
    const aValue = a[index] ?? 0;
    const bValue = b[index] ?? 0;
    if (aValue < bValue) return -1;
    if (aValue > bValue) return 1;
  }
  return 0;
}

function normalizedCandidate(candidate) {
  if (!plainRecord(candidate)
      || !exactKeys(candidate, ["route", "native", "electron", "signatureEvidence"])) {
    fail("invalid_candidate");
  }
  if (candidate.route !== NATIVE_ELECTRON_HANDOVER_ROUTE) {
    // Sparkle does not have a verified native-to-Electron replacement route.
    fail("unsupported_route");
  }
  if (!plainRecord(candidate.native)
      || !exactKeys(candidate.native, ["appId", "version", "build", "signingLineage"])
      || !plainRecord(candidate.electron)
      || !exactKeys(candidate.electron, ["appId", "version", "build", "signingLineage"])
      || !plainRecord(candidate.signatureEvidence)
      || !exactKeys(candidate.signatureEvidence, ["nativeCodeHash", "electronCodeHash", "helperCodeHash"])) {
    fail("invalid_candidate");
  }
  const { native, electron, signatureEvidence } = candidate;
  if (native.appId !== NATIVE_ELECTRON_APP_ID || electron.appId !== NATIVE_ELECTRON_APP_ID) {
    fail("app_identity_mismatch");
  }
  if (!SUPPORTED_NATIVE_HANDOVER_VERSIONS.includes(native.version)) {
    fail("unsupported_native_version");
  }
  if (!safeString(native.build, SAFE_VERSION) || !safeString(electron.build, SAFE_VERSION)
      || !safeString(electron.version, SAFE_VERSION)
      || !safeString(native.signingLineage) || !safeString(electron.signingLineage)
      || native.signingLineage !== electron.signingLineage) {
    fail("signing_lineage_mismatch");
  }
  if (compareNumericVersions(electron.build, native.build) !== 1) {
    fail("nonmonotonic_build");
  }
  if (!safeString(signatureEvidence.nativeCodeHash, CODE_HASH)
      || !safeString(signatureEvidence.electronCodeHash, CODE_HASH)
      || !safeString(signatureEvidence.helperCodeHash, CODE_HASH)) {
    // The production orchestration obtains these from local `codesign`
    // verification. A package flag, archive label, or caller boolean does not
    // establish that the old app, new app, and bridge are signed code.
    fail("signature_evidence_invalid");
  }
  return Object.freeze({
    route: candidate.route,
    native: Object.freeze({ ...native }),
    electron: Object.freeze({ ...electron }),
    signatureEvidence: Object.freeze({ ...signatureEvidence }),
  });
}

export function validateNativeElectronHandoverCandidate(candidate) {
  return normalizedCandidate(candidate);
}

export function nativeElectronHandoverCandidateDigest(candidate) {
  const normalized = normalizedCandidate(candidate);
  return createHash("sha256")
    .update(JSON.stringify(normalized), "utf8")
    .digest("hex");
}

function currentUid() {
  if (typeof process.getuid !== "function") return null;
  try {
    const uid = process.getuid();
    return Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
  } catch {
    return null;
  }
}

function numeric(value) {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) return null;
    return Number(value);
  }
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function mode(stats) {
  const value = numeric(stats?.mode);
  return value === null ? null : value & 0o777;
}

function inode(stats) {
  const dev = stats?.dev;
  const ino = stats?.ino;
  return dev === undefined || ino === undefined ? null : `${String(dev)}:${String(ino)}`;
}

function sameInode(left, right) {
  const a = inode(left);
  const b = inode(right);
  return a !== null && a === b;
}

function ownedByCurrentUser(stats, uid) {
  const owner = numeric(stats?.uid);
  return uid === null || (owner !== null && owner === uid);
}

function isPrivate(stats) {
  const selected = mode(stats);
  return selected !== null && (selected & 0o077) === 0;
}

function regularFile(stats) {
  try { return stats?.isFile?.() === true; } catch { return false; }
}

function directory(stats) {
  try { return stats?.isDirectory?.() === true; } catch { return false; }
}

function symbolicLink(stats) {
  try { return stats?.isSymbolicLink?.() === true; } catch { return true; }
}

function linkCount(stats) {
  const count = numeric(stats?.nlink);
  return count === null ? null : count;
}

async function lstatRequired(path, code = "unsafe_state") {
  try {
    return await nodeFs.lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") fail("missing_state");
    fail(code);
  }
}

async function lstatOptional(path) {
  try {
    return await nodeFs.lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("unsafe_state");
  }
}

function assertPrivateDirectoryStats(stats, uid, code = "unsafe_state", allowReadable = false) {
  // Directory link counts grow with child directories on POSIX filesystems;
  // they cannot be treated as a hard-link signal. Regular files below retain
  // the exact-one-link requirement.
  const protectedMode = allowReadable ? (stats.mode & 0o022) === 0 : isPrivate(stats);
  if (!directory(stats) || symbolicLink(stats) || !ownedByCurrentUser(stats, uid) || !protectedMode) {
    fail(code);
  }
}

function assertPrivateFileStats(stats, uid, code = "unsafe_state", allowReadable = false) {
  const size = numeric(stats?.size);
  const protectedMode = allowReadable ? (stats.mode & 0o022) === 0 : isPrivate(stats);
  if (!regularFile(stats) || symbolicLink(stats) || !ownedByCurrentUser(stats, uid)
      || !protectedMode || linkCount(stats) !== 1 || size === null) {
    fail(code);
  }
  return size;
}

async function mkdirPrivate(path) {
  try {
    await nodeFs.mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
    await nodeFs.chmod(path, DIRECTORY_MODE);
  } catch {
    fail("write_failed");
  }
  const stats = await lstatRequired(path, "write_failed");
  assertPrivateDirectoryStats(stats, currentUid(), "write_failed");
}

async function fsyncDirectory(path) {
  let handle;
  try {
    handle = await nodeFs.open(path, READ_FLAGS);
    await handle.sync();
  } catch {
    fail("write_failed");
  } finally {
    try { await handle?.close(); } catch { /* best effort after sync failure */ }
  }
}

async function atomicJson(path, value) {
  const parent = resolve(join(path, ".."));
  await mkdirPrivate(parent);
  const temp = join(parent, `.${randomUUID()}.tmp`);
  let handle;
  try {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    handle = await nodeFs.open(temp, CREATE_EXCLUSIVE_FLAGS, FILE_MODE);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await nodeFs.chmod(temp, FILE_MODE);
    await nodeFs.rename(temp, path);
    await fsyncDirectory(parent);
  } catch {
    try { await handle?.close(); } catch { /* no-op */ }
    try { await nodeFs.unlink(temp); } catch { /* no-op */ }
    fail("write_failed");
  }
}

async function readPrivateJson(path, { missing = false, maximumBytes = 64 * 1024 } = {}) {
  let stats;
  try {
    stats = await nodeFs.lstat(path);
  } catch (error) {
    if (missing && error?.code === "ENOENT") return null;
    fail(missing ? "unsafe_state" : "recovery_required");
  }
  const size = assertPrivateFileStats(stats, currentUid(), "unsafe_state");
  if (size < 1 || size > maximumBytes) fail("unsafe_state");
  let handle;
  try {
    handle = await nodeFs.open(path, READ_FLAGS);
    const before = await handle.stat();
    if (!sameInode(stats, before) || !regularFile(before)) fail("unsafe_state");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameInode(before, after) || bytes.byteLength !== size) fail("unsafe_state");
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (isNativeElectronHandoverError(error)) throw error;
    fail("unsafe_state");
  } finally {
    try { await handle?.close(); } catch { /* no-op */ }
  }
}

async function writeFilePrivate(path, bytes) {
  const parent = resolve(join(path, ".."));
  await mkdirPrivate(parent);
  const temp = join(parent, `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await nodeFs.open(temp, CREATE_EXCLUSIVE_FLAGS, FILE_MODE);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await nodeFs.chmod(temp, FILE_MODE);
    await nodeFs.rename(temp, path);
    await fsyncDirectory(parent);
  } catch {
    try { await handle?.close(); } catch { /* no-op */ }
    try { await nodeFs.unlink(temp); } catch { /* no-op */ }
    fail("write_failed");
  }
}

function objectDigest(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function entryDigest(entries) {
  return createHash("sha256").update(JSON.stringify(entries), "utf8").digest("hex");
}

async function collectTree(root, limits, { allowReadableDescendants = false } = {}) {
  const uid = currentUid();
  const rootStats = await lstatRequired(root);
  assertPrivateDirectoryStats(rootStats, uid);
  const entries = [];
  let totalBytes = 0;
  let count = 0;

  async function visit(absolute, relativePath) {
    const stats = await lstatRequired(absolute);
    if (symbolicLink(stats)) fail("unsafe_state");
    if (directory(stats)) {
      assertPrivateDirectoryStats(stats, uid, "unsafe_state", allowReadableDescendants && relativePath !== "");
      count += 1;
      if (count > limits.maximumEntries) fail("state_too_large");
      const names = await nodeFs.readdir(absolute);
      names.sort((a, b) => a.localeCompare(b, "en"));
      if (relativePath !== "") entries.push({ path: relativePath, type: "directory" });
      for (const name of names) {
        if (name.length < 1 || name === "." || name === ".." || name.includes("\0")) {
          fail("unsafe_state");
        }
        await visit(join(absolute, name), relativePath === "" ? name : `${relativePath}/${name}`);
      }
      return;
    }
    const size = assertPrivateFileStats(stats, uid, "unsafe_state", allowReadableDescendants);
    count += 1;
    totalBytes += size;
    if (count > limits.maximumEntries || totalBytes > limits.maximumBytes) fail("state_too_large");
    const digest = await digestStableFile(absolute, stats, size);
    entries.push({ path: relativePath, type: "file", bytes: size, sha256: digest });
  }

  await visit(root, "");
  return Object.freeze({
    entries: Object.freeze(entries),
    count,
    bytes: totalBytes,
    digest: entryDigest(entries),
  });
}

async function digestStableFile(path, initial, expectedSize) {
  let handle;
  try {
    handle = await nodeFs.open(path, READ_FLAGS);
    const before = await handle.stat();
    if (!sameInode(initial, before) || !regularFile(before)
        || numeric(before.size) !== expectedSize || linkCount(before) !== 1) {
      fail("unsafe_state");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, expectedSize)));
    let position = 0;
    while (position < expectedSize) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expectedSize - position), position);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 1) fail("unsafe_state");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (!sameInode(before, after) || numeric(after.size) !== expectedSize) fail("unsafe_state");
    return hash.digest("hex");
  } catch (error) {
    if (isNativeElectronHandoverError(error)) throw error;
    fail("unsafe_state");
  } finally {
    try { await handle?.close(); } catch { /* no-op */ }
  }
}

async function copyTree(source, destination, limits, { allowReadableDescendants = false } = {}) {
  const inventory = await collectTree(source, limits, { allowReadableDescendants });
  const destinationExisting = await lstatOptional(destination);
  if (destinationExisting !== null) fail("destination_exists");
  await mkdirPrivate(destination);
  let copiedBytes = 0;
  let copiedEntries = 0;

  async function copyEntry(sourcePath, destinationPath) {
    const sourceStats = await lstatRequired(sourcePath);
    if (directory(sourceStats)) {
      assertPrivateDirectoryStats(sourceStats, currentUid(), "unsafe_state", allowReadableDescendants && sourcePath !== source);
      if (sourcePath !== source) await mkdirPrivate(destinationPath);
      const names = await nodeFs.readdir(sourcePath);
      names.sort((a, b) => a.localeCompare(b, "en"));
      for (const name of names) await copyEntry(join(sourcePath, name), join(destinationPath, name));
      return;
    }
    const size = assertPrivateFileStats(sourceStats, currentUid(), "unsafe_state", allowReadableDescendants);
    copiedEntries += 1;
    copiedBytes += size;
    if (copiedEntries > limits.maximumEntries || copiedBytes > limits.maximumBytes) fail("state_too_large");
    await copyStableFile(sourcePath, destinationPath, sourceStats, size);
  }

  await copyEntry(source, destination);
  const copied = await collectTree(destination, limits);
  if (copied.digest !== inventory.digest || copied.bytes !== inventory.bytes || copied.count !== inventory.count) {
    fail("copy_verification_failed");
  }
  return inventory;
}

async function copyStableFile(source, destination, initial, expectedSize) {
  let sourceHandle;
  let destinationHandle;
  try {
    sourceHandle = await nodeFs.open(source, READ_FLAGS);
    const before = await sourceHandle.stat();
    if (!sameInode(initial, before) || !regularFile(before) || numeric(before.size) !== expectedSize
        || linkCount(before) !== 1) {
      fail("unsafe_state");
    }
    destinationHandle = await nodeFs.open(destination, CREATE_EXCLUSIVE_FLAGS, FILE_MODE);
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, expectedSize)));
    let position = 0;
    while (position < expectedSize) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, Math.min(buffer.length, expectedSize - position), position);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 1) fail("unsafe_state");
      let written = 0;
      while (written < bytesRead) {
        const { bytesWritten } = await destinationHandle.write(buffer, written, bytesRead - written, position + written);
        if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 1) fail("copy_failed");
        written += bytesWritten;
      }
      position += bytesRead;
    }
    await destinationHandle.sync();
    const after = await sourceHandle.stat();
    if (!sameInode(before, after) || numeric(after.size) !== expectedSize) fail("source_changed");
  } catch (error) {
    if (isNativeElectronHandoverError(error)) throw error;
    fail("copy_failed");
  } finally {
    try { await sourceHandle?.close(); } catch { /* no-op */ }
    try { await destinationHandle?.close(); } catch { /* no-op */ }
  }
}

async function validateSalt(root) {
  const index = await lstatOptional(join(root, STATE_INDEX_FILE));
  if (index === null) return;
  assertPrivateFileStats(index, currentUid());
  const saltPath = join(root, STATE_SALT_FILE);
  const salt = await lstatRequired(saltPath, "identity_salt_missing");
  const size = assertPrivateFileStats(salt, currentUid(), "identity_salt_missing");
  if (size !== 32) fail("identity_salt_invalid");
}

function normalizePreferences(value) {
  if (!plainRecord(value)
      || !exactKeys(value, ["language", "appearance", "refreshIntervalSeconds", "startAtLogin"])) {
    fail("native_bridge_invalid");
  }
  const language = value.language === "en-US" ? "en" : value.language;
  if (!["system", "en", "zh-Hans", "es"].includes(language)
      || !["system", "light", "dark"].includes(value.appearance)
      || ![60, 300, 900, 1800].includes(value.refreshIntervalSeconds)
      || typeof value.startAtLogin !== "boolean") {
    fail("native_bridge_invalid");
  }
  return Object.freeze({
    language,
    appearance: value.appearance,
    refreshIntervalSeconds: value.refreshIntervalSeconds,
    startAtLogin: value.startAtLogin,
  });
}

function preferencesFromJournal(value) {
  if (!plainRecord(value)) fail("recovery_required");
  return normalizePreferences({
    language: value.language,
    appearance: value.appearance,
    refreshIntervalSeconds: value.refreshIntervalSeconds,
    startAtLogin: value.startAtLogin,
  });
}

async function nativeSettings(root) {
  const settings = await readPrivateJson(join(root, NATIVE_LAUNCHER_SETTINGS_FILE), { missing: true });
  if (settings === null) return null;
  if (!exactKeys(settings, ["schemaVersion", "codexHome"])
      || settings.schemaVersion !== NATIVE_LAUNCHER_SETTINGS_SCHEMA
      || typeof settings.codexHome !== "string" || settings.codexHome.length === 0
      || settings.codexHome.includes("\0") || !isAbsolute(settings.codexHome)) {
    fail("native_settings_invalid");
  }
  return settings;
}

async function nativeFirstRunAcknowledged(root) {
  const receipt = await readPrivateJson(join(root, NATIVE_FIRST_RUN_FILE), { missing: true });
  if (receipt === null) return false;
  if (!exactKeys(receipt, ["schemaVersion", "acknowledged"])
      || receipt.schemaVersion !== NATIVE_FIRST_RUN_SCHEMA || receipt.acknowledged !== true) {
    fail("native_first_run_invalid");
  }
  return true;
}

async function stageSettings({ stageSettingsRoot, sourceStateRoot, preferences }) {
  await mkdirPrivate(stageSettingsRoot);
  const source = await nativeSettings(sourceStateRoot);
  const legacy = source ?? {
    schemaVersion: NATIVE_LAUNCHER_SETTINGS_SCHEMA,
    codexHome: null,
  };
  let snapshot;
  try {
    snapshot = source === null
      ? { ...DESKTOP_DEFAULT_SETTINGS }
      : migrateDesktopSettingsSnapshot(legacy);
    snapshot = validateDesktopSettingsSnapshot({
      ...snapshot,
      language: preferences.language,
      appearance: preferences.appearance,
      refreshIntervalSeconds: preferences.refreshIntervalSeconds,
      startAtLogin: preferences.startAtLogin,
    });
  } catch {
    fail("native_settings_invalid");
  }
  await writeFilePrivate(
    join(stageSettingsRoot, "desktop-settings-v1.json"),
    Buffer.from(`${JSON.stringify(snapshot)}\n`, "utf8"),
  );
  if (await nativeFirstRunAcknowledged(sourceStateRoot)) {
    await writeFilePrivate(
      join(stageSettingsRoot, DESKTOP_FIRST_RUN_RECEIPT_FILE_NAME),
      Buffer.from(`${JSON.stringify({
        schemaVersion: DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
        acknowledged: true,
      })}\n`, "utf8"),
    );
  }
  return objectDigest(snapshot);
}

// A journal may identify a directory that was created before an interrupted
// copy reached its next durable checkpoint.  It is safe to remove only that
// exact operation-owned tree after fully validating its private shape; an
// unrelated or malformed tree remains a recovery error.
async function removeJournalOwnedTree(path, limits) {
  const stats = await lstatOptional(path);
  if (stats === null) return;
  try {
    await collectTree(path, limits);
    await nodeFs.rm(path, { recursive: true, force: false, maxRetries: 0 });
    await fsyncDirectory(resolve(join(path, "..")));
  } catch (error) {
    if (isNativeElectronHandoverError(error)) throw error;
    fail("recovery_required");
  }
}

function emptyDirectoryForMigration(stats) {
  return directory(stats) && !symbolicLink(stats);
}

async function assertTargetAvailable(path, allowExisting) {
  const stats = await lstatOptional(path);
  if (stats === null) return;
  if (allowExisting) return;
  if (!emptyDirectoryForMigration(stats)) fail("target_exists");
  try {
    if ((await nodeFs.readdir(path)).length !== 0) fail("target_exists");
  } catch (error) {
    if (isNativeElectronHandoverError(error)) throw error;
    fail("target_exists");
  }
}

async function renameStagedRoot(stageRoot, targetRoot) {
  const target = await lstatOptional(targetRoot);
  if (target !== null) {
    if (!emptyDirectoryForMigration(target)) fail("target_exists");
    try {
      if ((await nodeFs.readdir(targetRoot)).length !== 0) fail("target_exists");
      await nodeFs.rmdir(targetRoot);
    } catch (error) {
      if (isNativeElectronHandoverError(error)) throw error;
      fail("publish_failed");
    }
  }
  try {
    await nodeFs.rename(stageRoot, targetRoot);
    await fsyncDirectory(resolve(join(targetRoot, "..")));
  } catch {
    fail("publish_failed");
  }
}

function normalizeBridgeResult(value) {
  if (!plainRecord(value)
      || !exactKeys(value, ["status", "nativeWriterStopped", "loginItemDisabled", "preferences", "credentialState"])
      || value.status !== "prepared"
      || value.nativeWriterStopped !== true
      || value.loginItemDisabled !== true
      || !["unchanged", "unavailable"].includes(value.credentialState)) {
    fail("native_bridge_invalid");
  }
  return Object.freeze({
    preferences: normalizePreferences(value.preferences),
    credentialState: value.credentialState,
  });
}

function requireControl(value) {
  if (!plainRecord(value)
      || typeof value.prepareNativeHandover !== "function"
      || typeof value.claimElectronLoginItem !== "function") {
    fail("invalid_control_adapter");
  }
  return value;
}

function boundedOperationId(value) {
  if (typeof value !== "string" || !UUID.test(value)) fail("recovery_required");
  return value;
}

function normalizedJournal(value, candidateDigest) {
  if (!plainRecord(value)
      || !exactKeys(value, ["schemaVersion", "operationId", "candidateDigest", "phase", "preferences", "backupDigest", "settingsDigest"])
      || value.schemaVersion !== NATIVE_ELECTRON_HANDOVER_SCHEMA_VERSION
      || !UUID.test(value.operationId) || !SHA256.test(value.candidateDigest)
      || !JOURNAL_PHASES.has(value.phase)
      || (value.preferences !== null && (!exactKeys(value.preferences, [
        "language", "appearance", "refreshIntervalSeconds", "startAtLogin", "credentialState",
      ]) || !["unchanged", "unavailable"].includes(value.preferences.credentialState)))
      || (value.backupDigest !== null && !SHA256.test(value.backupDigest))
      || (value.settingsDigest !== null && !SHA256.test(value.settingsDigest))) {
    fail("recovery_required");
  }
  if (value.candidateDigest !== candidateDigest) fail("candidate_changed_during_recovery");
  if (value.preferences !== null) {
    normalizePreferences({
      language: value.preferences.language,
      appearance: value.preferences.appearance,
      refreshIntervalSeconds: value.preferences.refreshIntervalSeconds,
      startAtLogin: value.preferences.startAtLogin,
    });
  }
  return Object.freeze({ ...value });
}

async function writeJournal(path, journal) {
  await atomicJson(path, journal);
  return journal;
}

async function readJournal(path, candidateDigest) {
  const parsed = await readPrivateJson(path, { missing: true });
  return parsed === null ? null : normalizedJournal(parsed, candidateDigest);
}

async function writeMarker(path, journal) {
  const marker = {
    schemaVersion: NATIVE_ELECTRON_HANDOVER_SCHEMA_VERSION,
    operationId: journal.operationId,
    candidateDigest: journal.candidateDigest,
    phase: "completed",
  };
  await atomicJson(path, marker);
}

/**
 * Read the local completion record without creating a directory or requiring
 * the old native app to still exist. Future Electron-to-Electron updates use
 * this before predecessor discovery, so an already-migrated profile is never
 * held hostage by the retired native bundle.
 */
export async function inspectNativeElectronHandoverCompletion({ userDataRoot, controlRoot } = {}) {
  let root;
  let selectedControlRoot;
  try {
    root = assertAbsolutePath(userDataRoot);
    selectedControlRoot = controlRoot === undefined
      ? join(root, CONTROL_DIRECTORY)
      : assertAbsolutePath(controlRoot);
    const companionRoot = join(root, "companion-state");
    const settingsRoot = join(root, "desktop-settings");
    if (!pathContains(root, selectedControlRoot)
        || pathsOverlap(selectedControlRoot, companionRoot)
        || pathsOverlap(selectedControlRoot, settingsRoot)) {
      return Object.freeze({ status: "invalid" });
    }
  } catch {
    return Object.freeze({ status: "invalid" });
  }
  // Do not trust a completion marker through a swapped or public control
  // directory. A missing control root is the ordinary fresh-profile state;
  // an existing one must be the private directory created by this coordinator.
  try {
    const control = await lstatOptional(selectedControlRoot);
    if (control === null) return Object.freeze({ status: "absent" });
    const userData = await lstatRequired(root, "unsafe_state");
    assertPrivateDirectoryStats(userData, currentUid(), "unsafe_state");
    assertPrivateDirectoryStats(control, currentUid(), "unsafe_state");
  } catch {
    return Object.freeze({ status: "invalid" });
  }
  const markerPath = join(selectedControlRoot, NATIVE_ELECTRON_HANDOVER_MARKER_FILE);
  let marker;
  try {
    marker = await readPrivateJson(markerPath, { missing: true });
  } catch {
    return Object.freeze({ status: "invalid" });
  }
  if (marker === null) return Object.freeze({ status: "absent" });
  if (!exactKeys(marker, ["schemaVersion", "operationId", "candidateDigest", "phase"])
      || marker.schemaVersion !== NATIVE_ELECTRON_HANDOVER_SCHEMA_VERSION
      || !UUID.test(marker.operationId) || !SHA256.test(marker.candidateDigest)
      || marker.phase !== "completed") {
    return Object.freeze({ status: "invalid" });
  }
  try {
    const state = await lstatRequired(join(root, "companion-state"), "unsafe_state");
    const settings = await lstatRequired(join(root, "desktop-settings"), "unsafe_state");
    assertPrivateDirectoryStats(state, currentUid(), "unsafe_state");
    assertPrivateDirectoryStats(settings, currentUid(), "unsafe_state");
  } catch {
    return Object.freeze({ status: "invalid" });
  }
  return Object.freeze({ status: "completed" });
}

function defaultPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function acquireLease({ controlRoot, candidateDigest, pidAlive, operationId }) {
  const path = join(controlRoot, NATIVE_ELECTRON_HANDOVER_LEASE_FILE);
  const payload = {
    schemaVersion: NATIVE_ELECTRON_HANDOVER_SCHEMA_VERSION,
    operationId,
    candidateDigest,
    pid: process.pid,
  };
  try {
    const handle = await nodeFs.open(path, CREATE_EXCLUSIVE_FLAGS, FILE_MODE);
    try {
      await handle.writeFile(Buffer.from(`${JSON.stringify(payload)}\n`, "utf8"));
      await handle.sync();
    } finally {
      await handle.close();
    }
    return Object.freeze({ path, payload });
  } catch (error) {
    if (error?.code !== "EEXIST") fail("lease_unavailable");
  }
  const previous = await readPrivateJson(path, { missing: false });
  if (!exactKeys(previous, ["schemaVersion", "operationId", "candidateDigest", "pid"])
      || previous.schemaVersion !== NATIVE_ELECTRON_HANDOVER_SCHEMA_VERSION
      || !UUID.test(previous.operationId) || !SHA256.test(previous.candidateDigest)
      || !Number.isSafeInteger(previous.pid) || previous.pid < 2) {
    fail("lease_unavailable");
  }
  if (pidAlive(previous.pid)) fail("lease_contended");
  // An expired process lease is recoverable only when the exact journal binds
  // it to this candidate. Never remove an unreadable or unrelated lease.
  const journal = await readPrivateJson(join(controlRoot, NATIVE_ELECTRON_HANDOVER_JOURNAL_FILE), { missing: true });
  if (journal === null || journal.operationId !== previous.operationId
      || journal.candidateDigest !== candidateDigest) {
    fail("lease_unavailable");
  }
  try {
    await nodeFs.unlink(path);
  } catch {
    fail("lease_unavailable");
  }
  return acquireLease({ controlRoot, candidateDigest, pidAlive, operationId });
}

async function releaseLease(lease) {
  if (lease === null) return;
  try {
    const current = await readPrivateJson(lease.path, { missing: true });
    if (current !== null && current.operationId === lease.payload.operationId
        && current.pid === lease.payload.pid && current.candidateDigest === lease.payload.candidateDigest) {
      await nodeFs.unlink(lease.path);
      await fsyncDirectory(resolve(join(lease.path, "..")));
    }
  } catch {
    // The durable journal, not lease removal, is the recovery authority.
  }
}

function checkpointHook(hook, phase) {
  if (hook === undefined) return Promise.resolve();
  if (typeof hook !== "function") fail("invalid_configuration");
  return Promise.resolve().then(() => hook(phase));
}

function config(options) {
  if (!plainRecord(options)) fail("invalid_configuration");
  const allowed = new Set([
    "nativeStateRoot", "userDataRoot", "backupRoot", "nativeAppPath", "candidate", "control",
    "maximumEntries", "maximumBytes", "controlRoot", "pidAlive", "afterCheckpoint",
  ]);
  if (Reflect.ownKeys(options).some((key) => !allowed.has(key))) fail("invalid_configuration");
  const nativeStateRoot = assertAbsolutePath(options.nativeStateRoot);
  const userDataRoot = assertAbsolutePath(options.userDataRoot);
  const backupRoot = assertAbsolutePath(options.backupRoot);
  const nativeAppPath = assertAbsolutePath(options.nativeAppPath);
  const controlRoot = options.controlRoot === undefined
    ? join(userDataRoot, CONTROL_DIRECTORY)
    : assertAbsolutePath(options.controlRoot);
  const companionRoot = join(userDataRoot, "companion-state");
  const settingsRoot = join(userDataRoot, "desktop-settings");
  if (pathsOverlap(nativeStateRoot, userDataRoot) || pathsOverlap(nativeStateRoot, backupRoot)
      || pathsOverlap(backupRoot, userDataRoot) || pathsOverlap(nativeStateRoot, controlRoot)
      || pathsOverlap(backupRoot, controlRoot)) {
    fail("overlapping_roots");
  }
  if (!pathContains(userDataRoot, controlRoot) || pathsOverlap(controlRoot, companionRoot)
      || pathsOverlap(controlRoot, settingsRoot)) {
    fail("invalid_configuration");
  }
  return Object.freeze({
    nativeStateRoot,
    userDataRoot,
    backupRoot,
    nativeAppPath,
    controlRoot,
    companionRoot,
    settingsRoot,
    candidate: normalizedCandidate(options.candidate),
    control: requireControl(options.control),
    maximumEntries: assertCount(options.maximumEntries ?? NATIVE_ELECTRON_HANDOVER_MAX_ENTRIES,
      NATIVE_ELECTRON_HANDOVER_MAX_ENTRIES),
    maximumBytes: assertCount(options.maximumBytes ?? NATIVE_ELECTRON_HANDOVER_MAX_BYTES,
      NATIVE_ELECTRON_HANDOVER_MAX_BYTES),
    pidAlive: options.pidAlive ?? defaultPidAlive,
    afterCheckpoint: options.afterCheckpoint,
  });
}

/**
 * Perform or resume an idempotent native-to-Electron state handover.
 *
 * The control adapter owns only OS-facing operations: stop the old native
 * writer, disable its login item, and make Electron the login owner. Files are
 * copied by this coordinator using real filesystem operations; test adapters
 * can fake only the external OS boundary and still exercise the journal,
 * backup, staging, and recovery code.
 */
export async function runNativeElectronHandover(options = {}) {
  const selected = config(options);
  const candidateDigest = nativeElectronHandoverCandidateDigest(selected.candidate);
  const limits = Object.freeze({
    maximumEntries: selected.maximumEntries,
    maximumBytes: selected.maximumBytes,
  });
  // Older native SQLite/Finder files can be 0644 inside the owner-only root.
  // That root remains mandatory; descendants must still be owned, non-writable
  // by others, non-linked regular entries. Every destination is tightened to
  // 0600/0700 without changing any source permissions or content.
  const legacySourceOptions = Object.freeze({ allowReadableDescendants: true });
  // Completion belongs to the profile, rather than to the candidate that
  // performed the first copy. Check it before inspecting the retired source so
  // subsequent signed Electron updates can keep running after that app is no
  // longer present. A malformed completion record remains fail-closed.
  const readProfileCompletion = () => inspectNativeElectronHandoverCompletion({
    userDataRoot: selected.userDataRoot,
    controlRoot: selected.controlRoot,
  });
  const completeResult = () => Object.freeze({
    status: "already_migrated",
    stateRoot: selected.companionRoot,
    settingsRoot: selected.settingsRoot,
  });
  let completion = await readProfileCompletion();
  if (completion.status === "completed") {
    return completeResult();
  }
  if (completion.status === "invalid") fail("recovery_required");
  // Reject an unsafe or missing native root before creating a control journal,
  // backup, or Electron target directory. The writer is stopped only after
  // this read-only structural preflight succeeds.
  await collectTree(selected.nativeStateRoot, limits, legacySourceOptions);
  await mkdirPrivate(selected.userDataRoot);
  await mkdirPrivate(selected.backupRoot);
  await mkdirPrivate(selected.controlRoot);

  const journalPath = join(selected.controlRoot, NATIVE_ELECTRON_HANDOVER_JOURNAL_FILE);
  const markerPath = join(selected.controlRoot, NATIVE_ELECTRON_HANDOVER_MARKER_FILE);
  completion = await readProfileCompletion();
  if (completion.status === "completed") return completeResult();
  if (completion.status === "invalid") fail("recovery_required");

  let journal = await readJournal(journalPath, candidateDigest);
  const operationId = journal?.operationId ?? randomUUID();
  let lease = null;
  try {
    lease = await acquireLease({
      controlRoot: selected.controlRoot,
      candidateDigest,
      pidAlive: selected.pidAlive,
      operationId,
    });
    // Re-read after acquiring the exclusive lease so a just-completed peer is
    // never resumed as a second migration.
    completion = await readProfileCompletion();
    if (completion.status === "completed") return completeResult();
    if (completion.status === "invalid") fail("recovery_required");
    journal = await readJournal(journalPath, candidateDigest);
    if (journal === null) {
      await assertTargetAvailable(selected.companionRoot, false);
      await assertTargetAvailable(selected.settingsRoot, false);
      // The source shape was read-only preflighted before any Electron state
      // write. Re-read it below after the native writer is stopped.
      journal = {
        schemaVersion: NATIVE_ELECTRON_HANDOVER_SCHEMA_VERSION,
        operationId,
        candidateDigest,
        phase: "started",
        preferences: null,
        backupDigest: null,
        settingsDigest: null,
      };
      await writeJournal(journalPath, journal);
    }

    // A saved phase cannot prove that the native app stayed stopped across a
    // crash or reboot. Re-establish ownership on every incomplete attempt.
    // Retain the original preference snapshot: login is now disabled, so a
    // resumed bridge response must not overwrite the user's prior choice.
    if (journal.phase === "completed") fail("recovery_required");
    let bridge;
    try {
      bridge = normalizeBridgeResult(await selected.control.prepareNativeHandover({
        nativeAppPath: selected.nativeAppPath,
        candidate: selected.candidate,
      }));
    } catch (error) {
      if (isNativeElectronHandoverError(error)) throw error;
      fail("native_bridge_unavailable");
    }
    if (journal.phase === "started") {
      journal = {
        ...journal,
        phase: "prepared",
        preferences: { ...bridge.preferences, credentialState: bridge.credentialState },
      };
      await writeJournal(journalPath, journal);
      await checkpointHook(selected.afterCheckpoint, journal.phase);
    } else if (journal.phase === "electron_login_owned") {
      // The bridge just withdrew the same-identity login registration again.
      // Reclaim it before writing completion, including after a late crash.
      journal = { ...journal, phase: "published" };
      await writeJournal(journalPath, journal);
    }
    const stageRoot = join(selected.controlRoot, STAGING_DIRECTORY, boundedOperationId(journal.operationId));
    const stageStateRoot = join(stageRoot, "companion-state");
    const stageSettingsRoot = join(stageRoot, "desktop-settings");
    const backupStateRoot = join(selected.backupRoot, BACKUP_DIRECTORY, boundedOperationId(journal.operationId), "companion-state");

    if (journal.backupDigest !== null
        && (await collectTree(selected.nativeStateRoot, limits, legacySourceOptions)).digest !== journal.backupDigest) {
      // The user may have resumed the native app after an interruption. Keep
      // the prior backup and restart from its now-stopped, newer history.
      // Never overwrite published roots that have changed independently.
      for (const [path, expected] of [
        [selected.companionRoot, journal.backupDigest],
        [selected.settingsRoot, journal.settingsDigest],
      ]) {
        if (await lstatOptional(path) !== null
            && (expected === null || (await collectTree(path, limits)).digest !== expected)) {
          fail("recovery_required");
        }
      }
      if (await lstatOptional(backupStateRoot) !== null) {
        if ((await collectTree(backupStateRoot, limits)).digest !== journal.backupDigest) {
          fail("copy_verification_failed");
        }
        await nodeFs.rename(backupStateRoot,
          join(backupStateRoot, "..", `retained-snapshot-${randomUUID()}`));
        await fsyncDirectory(join(backupStateRoot, ".."));
      }
      await removeJournalOwnedTree(selected.companionRoot, limits);
      await removeJournalOwnedTree(selected.settingsRoot, limits);
      await removeJournalOwnedTree(stageRoot, limits);
      journal = { ...journal, phase: "prepared", backupDigest: null, settingsDigest: null };
      await writeJournal(journalPath, journal);
    }

    if (journal.phase === "prepared") {
      // A power loss while creating a backup leaves this phase unchanged. The
      // exact journal binds the cleanup to this operation, then the source is
      // copied again only after the native writer has remained stopped.
      await removeJournalOwnedTree(backupStateRoot, limits);
      await mkdirPrivate(resolve(join(backupStateRoot, "..")));
      const before = await collectTree(selected.nativeStateRoot, limits, legacySourceOptions);
      await copyTree(selected.nativeStateRoot, backupStateRoot, limits, legacySourceOptions);
      const after = await collectTree(selected.nativeStateRoot, limits, legacySourceOptions);
      const backup = await collectTree(backupStateRoot, limits);
      if (before.digest !== after.digest || before.digest !== backup.digest) fail("source_changed");
      await validateSalt(backupStateRoot);
      journal = { ...journal, phase: "backed_up", backupDigest: backup.digest };
      await writeJournal(journalPath, journal);
      await checkpointHook(selected.afterCheckpoint, journal.phase);
    }

    if (journal.phase === "backed_up") {
      await removeJournalOwnedTree(stageRoot, limits);
      await mkdirPrivate(resolve(join(stageRoot, "..")));
      await mkdirPrivate(stageRoot);
      await copyTree(backupStateRoot, stageStateRoot, limits);
      const preferences = preferencesFromJournal(journal.preferences);
      await stageSettings({
        stageSettingsRoot,
        sourceStateRoot: backupStateRoot,
        preferences,
      });
      const settingsDigest = (await collectTree(stageSettingsRoot, limits)).digest;
      const staged = await collectTree(stageStateRoot, limits);
      if (staged.digest !== journal.backupDigest) fail("copy_verification_failed");
      await validateSalt(stageStateRoot);
      journal = { ...journal, phase: "staged", settingsDigest };
      await writeJournal(journalPath, journal);
      await checkpointHook(selected.afterCheckpoint, journal.phase);
    }

    if (journal.phase === "staged") {
      const staged = await lstatOptional(stageStateRoot);
      const published = await lstatOptional(selected.companionRoot);
      if (staged === null && published !== null) {
        if ((await collectTree(selected.companionRoot, limits)).digest !== journal.backupDigest) {
          fail("publish_verification_failed");
        }
      } else if (staged !== null && published === null) {
        await renameStagedRoot(stageStateRoot, selected.companionRoot);
      } else if (staged !== null && published !== null && emptyDirectoryForMigration(published)
          && (await nodeFs.readdir(selected.companionRoot)).length === 0) {
        await renameStagedRoot(stageStateRoot, selected.companionRoot);
      } else {
        fail("recovery_required");
      }
      journal = { ...journal, phase: "published_state" };
      await writeJournal(journalPath, journal);
      await checkpointHook(selected.afterCheckpoint, journal.phase);
    }

    if (journal.phase === "published_state") {
      const staged = await lstatOptional(stageSettingsRoot);
      const publishedSettings = await lstatOptional(selected.settingsRoot);
      if (staged === null && publishedSettings !== null) {
        if ((await collectTree(selected.settingsRoot, limits)).digest !== journal.settingsDigest) {
          fail("publish_verification_failed");
        }
      } else if (staged !== null && publishedSettings === null) {
        await renameStagedRoot(stageSettingsRoot, selected.settingsRoot);
      } else if (staged !== null && publishedSettings !== null && emptyDirectoryForMigration(publishedSettings)
          && (await nodeFs.readdir(selected.settingsRoot)).length === 0) {
        await renameStagedRoot(stageSettingsRoot, selected.settingsRoot);
      } else {
        fail("recovery_required");
      }
      const published = await collectTree(selected.companionRoot, limits);
      if (published.digest !== journal.backupDigest) fail("publish_verification_failed");
      await validateSalt(selected.companionRoot);
      journal = { ...journal, phase: "published" };
      await writeJournal(journalPath, journal);
      await checkpointHook(selected.afterCheckpoint, journal.phase);
    }

    if (journal.phase === "published") {
      if ((await collectTree(selected.nativeStateRoot, limits, legacySourceOptions)).digest !== journal.backupDigest) {
        fail("source_changed");
      }
      const preferences = preferencesFromJournal(journal.preferences);
      let claimed;
      try {
        claimed = await selected.control.claimElectronLoginItem({
          startAtLogin: preferences.startAtLogin,
          candidate: selected.candidate,
        });
      } catch (error) {
        if (isNativeElectronHandoverError(error)) throw error;
        fail("electron_login_item_unavailable");
      }
      if (claimed !== "owned") fail("electron_login_item_unavailable");
      journal = { ...journal, phase: "electron_login_owned" };
      await writeJournal(journalPath, journal);
      await checkpointHook(selected.afterCheckpoint, journal.phase);
    }

    if (journal.phase === "electron_login_owned") {
      await writeMarker(markerPath, journal);
      journal = { ...journal, phase: "completed" };
      await writeJournal(journalPath, journal);
      await checkpointHook(selected.afterCheckpoint, journal.phase);
    }

    if (journal.phase !== "completed") fail("recovery_required");
    return Object.freeze({ status: "migrated", stateRoot: selected.companionRoot, settingsRoot: selected.settingsRoot });
  } finally {
    await releaseLease(lease);
  }
}
