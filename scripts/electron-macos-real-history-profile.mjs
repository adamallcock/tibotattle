#!/usr/bin/env node

/**
 * Prepare and launch a durable, private macOS real-history Electron profile.
 *
 * `prepare` copies only the retained, derived local state owned by the
 * companion. SQLite files are copied with the online backup API from a
 * read-only connection, so a live WAL is folded into the copy instead of
 * being mistaken for a complete main-file copy. The companion's immutable
 * device salt is copied beside both databases; without that salt the copied
 * session and scope keys would be unrelated to the retained rows.
 *
 * `launch` binds a caller-selected packaged app to its expected app.asar
 * digest and source revision, then delegates the actual rendered checks to
 * the existing real-history QA harness. The profile is persistent and is
 * never removed or replaced by this script. The harness receives an explicit
 * development export identity file, so this lane never needs the production
 * export-identity Keychain item. Hosted contribution remains disabled.
 *
 * Output and receipts are content-free. Source paths, Codex rows, account
 * identifiers, raw salts, credentials, and renderer text never cross the
 * output boundary.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { DatabaseSync, backup } from "node:sqlite";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadOrCreateParticipantSecret } from "../src/export-identity.js";
import {
  LOCAL_COLLECTOR_STATE_SCHEMA_VERSION,
} from "../src/local-collector-state.js";
import {
  LEGACY_LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
  LOCAL_UNIFIED_INDEX_APPLICATION_ID,
  LOCAL_UNIFIED_INDEX_MINIMUM_READER_USER_VERSION,
  LOCAL_UNIFIED_INDEX_MINIMUM_WRITER_USER_VERSION,
  LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
  LOCAL_UNIFIED_INDEX_USER_VERSION,
  openLocalUnifiedIndex,
  readLocalUnifiedIndexCompatibility,
} from "../src/local-unified-index.js";
import { syncDirectory } from "../src/platform/owner-only-filesystem.js";
import { verifyPackagedArtifactIdentity } from "./qa-electron-macos-real-history.mjs";

export const REAL_HISTORY_PROFILE_SCHEMA_VERSION =
  "tibotattle-electron-macos-real-history-profile-v1";
export const REAL_HISTORY_PROFILE_COMMANDS = Object.freeze([
  "prepare",
  "launch",
  "interactive",
]);

const PROFILE_RECEIPT_NAME = "profile-handoff-v1.json";
const QA_RECEIPT_NAME = "real-history-receipt.json";
const INDEX_NAME = "local-unified-index-v1.sqlite";
const COLLECTOR_NAME = "local-collector-state-v1.sqlite";
const DEVICE_SALT_NAME = "local-unified-index-device-salt-v1";
const IDENTITY_NAME = "export-identity";
const INDEX_APPLICATION_ID = LOCAL_UNIFIED_INDEX_APPLICATION_ID;
const INDEX_MINIMUM_KNOWN_USER_VERSION = 1;
const COLLECTOR_APPLICATION_ID = 0x554d4353;
const COLLECTOR_USER_VERSION = 1;
const PROFILE_FILE_MAX_BYTES = 128 * 1024;
const SOURCE_PATH_MAX_BYTES = 4_096;
const IDENTITY_FILE_BYTES = 44;
const DEVICE_SALT_BYTES = 32;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const SOURCE_FILE_NAMES = Object.freeze([INDEX_NAME, COLLECTOR_NAME, DEVICE_SALT_NAME]);
const SQLITE_SIDECAR_SUFFIXES = Object.freeze(["-wal", "-shm", "-journal"]);
const QA_MODES = Object.freeze(["cancel", "snapshot", "full", "relaunch"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const PROFILE_PATH_COMPONENT_PATTERN = /^(?:[A-Za-z0-9._-]+)$/u;
const INDEX_SCHEMA_VERSIONS = new Set([
  LEGACY_LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
  LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
]);

function profileError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function fail(code) {
  throw profileError(code);
}

function absolutePath(value, code = "ELECTRON_REAL_HISTORY_PROFILE_INPUT_INVALID") {
  if (typeof value !== "string"
      || value.length < 1
      || value.length > SOURCE_PATH_MAX_BYTES
      || value.includes("\0")
      || !isAbsolute(value)) {
    fail(code);
  }
  const selected = resolve(value);
  if (selected === parse(selected).root) fail(code);
  return selected;
}

function pathWithin(root, candidate, { allowRoot = false } = {}) {
  const child = relative(root, candidate);
  return (allowRoot && child === "")
    || (child !== ""
      && child !== ".."
      && !child.startsWith(`..${sep}`)
      && !isAbsolute(child));
}

function pathsOverlap(left, right) {
  return left === right
    || pathWithin(left, right, { allowRoot: true })
    || pathWithin(right, left, { allowRoot: true });
}

function uidMatches(metadata) {
  return typeof process.getuid !== "function"
    || typeof metadata?.uid !== "number"
    || metadata.uid === process.getuid();
}

function ownerControlledDirectoryMetadata(metadata, { exact = false } = {}) {
  if (!metadata?.isDirectory?.() || metadata.isSymbolicLink() || !uidMatches(metadata)) {
    return false;
  }
  return process.platform === "win32"
    ? true
    : exact
      ? (metadata.mode & 0o0777) === 0o700
      : (metadata.mode & 0o022) === 0;
}

function ownerOnlyFileMetadata(metadata) {
  return metadata?.isFile?.()
    && !metadata.isSymbolicLink()
    && metadata.nlink === 1
    && uidMatches(metadata)
    && (process.platform === "win32" || (metadata.mode & 0o077) === 0);
}

async function safeDirectory(path, { exact = false, missing = false } = {}) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (missing && error?.code === "ENOENT") return null;
    fail("ELECTRON_REAL_HISTORY_PROFILE_DIRECTORY_INVALID");
  }
  if (!ownerControlledDirectoryMetadata(metadata, { exact })) {
    fail("ELECTRON_REAL_HISTORY_PROFILE_DIRECTORY_INVALID");
  }
  return metadata;
}

async function assertNoSymlinkComponents(path) {
  let cursor = resolve(path);
  while (true) {
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink()) fail("ELECTRON_REAL_HISTORY_PROFILE_PATH_INVALID");
      // Existing system prefixes such as /private on macOS may themselves be
      // symlinks. The controlled path is the requested object plus its first
      // existing parent; the file/directory guards below open the requested
      // object without following its final component.
      return;
    } catch (error) {
      if (error?.code === "ENOENT") {
        const parent = dirname(cursor);
        if (parent === cursor) return;
        cursor = parent;
        continue;
      }
      if (error?.code?.startsWith("ELECTRON_REAL_HISTORY_PROFILE_")) throw error;
      fail("ELECTRON_REAL_HISTORY_PROFILE_PATH_INVALID");
    }
  }
}

async function assertSourceRoot(sourceRoot) {
  await assertNoSymlinkComponents(sourceRoot);
  await safeDirectory(sourceRoot, { exact: false });
}

function metadataIdentity(metadata) {
  return Object.freeze({
    dev: metadata?.dev ?? null,
    ino: metadata?.ino ?? null,
    size: Number(metadata?.size ?? -1),
    mtimeMs: Number(metadata?.mtimeMs ?? -1),
    ctimeMs: Number(metadata?.ctimeMs ?? -1),
  });
}

function sameMetadata(left, right) {
  return left !== null
    && right !== null
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function sourceFileMetadata(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    fail("ELECTRON_REAL_HISTORY_PROFILE_SOURCE_MISSING");
  }
  if (!ownerOnlyFileMetadata(metadata)) {
    fail("ELECTRON_REAL_HISTORY_PROFILE_SOURCE_INVALID");
  }
  return metadata;
}

async function sidecarMetadata(path) {
  const result = {};
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const sidecar = `${path}${suffix}`;
    try {
      const metadata = await lstat(sidecar);
      if (!ownerOnlyFileMetadata(metadata)) fail("ELECTRON_REAL_HISTORY_PROFILE_SOURCE_INVALID");
      result[suffix] = metadataIdentity(metadata);
    } catch (error) {
      if (error?.code === "ENOENT") {
        result[suffix] = null;
        continue;
      }
      if (error?.code?.startsWith("ELECTRON_REAL_HISTORY_PROFILE_")) throw error;
      fail("ELECTRON_REAL_HISTORY_PROFILE_SOURCE_INVALID");
    }
  }
  return Object.freeze(result);
}

function sidecarsEqual(left, right) {
  return SQLITE_SIDECAR_SUFFIXES.every((suffix) => {
    const a = left?.[suffix] ?? null;
    const b = right?.[suffix] ?? null;
    if (a === null || b === null) return a === b;
    return sameMetadata(a, b);
  });
}

function scalar(database, sql, key, ...parameters) {
  return database.prepare(sql).get(...parameters)?.[key] ?? null;
}

function schemaValue(database, key, column = "value") {
  try {
    return scalar(
      database,
      `SELECT ${column} FROM meta WHERE key = ?`,
      column,
      key,
    );
  } catch {
    return null;
  }
}

function validateDatabaseShape(database, kind, {
  allowMigratable = false,
  deep = true,
} = {}) {
  const applicationId = Number(scalar(database, "PRAGMA application_id", "application_id"));
  const userVersion = Number(scalar(database, "PRAGMA user_version", "user_version"));
  const journalMode = String(scalar(database, "PRAGMA journal_mode", "journal_mode") ?? "")
    .toLowerCase();
  const dataVersion = Number(scalar(database, "PRAGMA data_version", "data_version"));
  // Launch-time validation uses SQLite's bounded one-error form. Preparation
  // still runs the complete check; relaunching a durable profile should not
  // repeatedly stream a potentially large history into an unbounded result.
  const quickCheck = deep
    ? scalar(database, "PRAGMA quick_check", "quick_check")
    : scalar(database, "PRAGMA quick_check(1)", "quick_check");
  if (!Number.isSafeInteger(dataVersion)
      || quickCheck !== "ok"
      || !["delete", "truncate", "persist", "memory", "wal", "off"].includes(journalMode)) {
    fail("ELECTRON_REAL_HISTORY_PROFILE_SOURCE_SCHEMA_INVALID");
  }
  if (kind === "unified_index") {
    let compatibility;
    try {
      compatibility = readLocalUnifiedIndexCompatibility(database);
    } catch {
      fail("ELECTRON_REAL_HISTORY_PROFILE_SOURCE_SCHEMA_INVALID");
    }
    const schemaVersion = schemaValue(database, "schema_version");
    const compatibilityValid = compatibility?.metadataPartial !== true
      && compatibility?.metadataMalformed !== true
      && (compatibility?.formatUserVersion === null
        || (compatibility.formatUserVersion >= INDEX_MINIMUM_KNOWN_USER_VERSION
          && compatibility.formatUserVersion <= LOCAL_UNIFIED_INDEX_USER_VERSION))
      && Number.isSafeInteger(compatibility?.minimumReaderUserVersion)
      && compatibility.minimumReaderUserVersion >= INDEX_MINIMUM_KNOWN_USER_VERSION
      && compatibility.minimumReaderUserVersion <= LOCAL_UNIFIED_INDEX_USER_VERSION
      && Number.isSafeInteger(compatibility?.minimumWriterUserVersion)
      && compatibility.minimumWriterUserVersion >= INDEX_MINIMUM_KNOWN_USER_VERSION
      && compatibility.minimumWriterUserVersion <= LOCAL_UNIFIED_INDEX_USER_VERSION;
    const current = userVersion === LOCAL_UNIFIED_INDEX_USER_VERSION
      && schemaVersion === LOCAL_UNIFIED_INDEX_SCHEMA_VERSION
      && compatibility?.metadataPresent === true
      && compatibility.formatUserVersion === LOCAL_UNIFIED_INDEX_USER_VERSION
      && compatibility.minimumReaderUserVersion
        === LOCAL_UNIFIED_INDEX_MINIMUM_READER_USER_VERSION
      && compatibility.minimumWriterUserVersion
        === LOCAL_UNIFIED_INDEX_MINIMUM_WRITER_USER_VERSION;
    const migratable = allowMigratable
      && userVersion >= INDEX_MINIMUM_KNOWN_USER_VERSION
      && userVersion < LOCAL_UNIFIED_INDEX_USER_VERSION
      && INDEX_SCHEMA_VERSIONS.has(schemaVersion)
      && compatibilityValid;
    if (applicationId !== INDEX_APPLICATION_ID
        || !Number.isSafeInteger(userVersion)
        || userVersion < INDEX_MINIMUM_KNOWN_USER_VERSION
        || userVersion > LOCAL_UNIFIED_INDEX_USER_VERSION
        || (!current && !migratable)) {
      fail("ELECTRON_REAL_HISTORY_PROFILE_SOURCE_SCHEMA_INVALID");
    }
    return Object.freeze({
      kind,
      schemaVersion,
      applicationId,
      userVersion,
      journalMode,
      quickCheck,
      migratable,
    });
  }
  if (kind === "collector_state") {
    const schema = schemaValue(database, "schema_version", "value_json");
    if (applicationId !== COLLECTOR_APPLICATION_ID
        || userVersion !== COLLECTOR_USER_VERSION
        || schema !== JSON.stringify(LOCAL_COLLECTOR_STATE_SCHEMA_VERSION)) {
      fail("ELECTRON_REAL_HISTORY_PROFILE_SOURCE_SCHEMA_INVALID");
    }
    return Object.freeze({
      kind,
      schemaVersion: LOCAL_COLLECTOR_STATE_SCHEMA_VERSION,
      applicationId,
      userVersion,
      journalMode,
      quickCheck,
    });
  }
  fail("ELECTRON_REAL_HISTORY_PROFILE_SOURCE_SCHEMA_INVALID");
}

function databaseStructureDigest(database) {
  const schema = database.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema "
      + "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  ).all();
  return createHash("sha256").update(JSON.stringify(schema)).digest("hex");
}

function configureReadOnlyDatabase(database) {
  try {
    database.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;");
    database.enableDefensive?.(true);
  } catch {
    fail("ELECTRON_REAL_HISTORY_PROFILE_SOURCE_SCHEMA_INVALID");
  }
}

async function validateCopiedDatabase(path, kind, { deep = true } = {}) {
  const metadata = await sourceFileMetadata(path);
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
    configureReadOnlyDatabase(database);
    const shape = validateDatabaseShape(database, kind, { deep });
    const after = await lstat(path);
    if (!sameMetadata(metadataIdentity(metadata), metadataIdentity(after))) {
      fail("ELECTRON_REAL_HISTORY_PROFILE_TARGET_CHANGED");
    }
    return Object.freeze({
      ...shape,
      structureDigest: databaseStructureDigest(database),
      bytes: Number(metadata.size),
    });
  } catch (error) {
    if (error?.code?.startsWith("ELECTRON_REAL_HISTORY_PROFILE_")) throw error;
    fail("ELECTRON_REAL_HISTORY_PROFILE_TARGET_INVALID");
  } finally {
    database?.close();
  }
}

async function assertAbsent(path, code) {
  try {
    await lstat(path);
    fail(code);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    if (error?.code?.startsWith("ELECTRON_REAL_HISTORY_PROFILE_")) throw error;
    fail(code);
  }
}

async function syncFile(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    await handle.sync();
  } catch {
    fail("ELECTRON_REAL_HISTORY_PROFILE_DURABILITY_FAILED");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readBoundedOwnerFile(path, maximumBytes, code) {
  let handle;
  try {
    const before = await lstat(path);
    if (!ownerOnlyFileMetadata(before) || before.size < 1 || before.size > maximumBytes) {
      fail(code);
    }
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!ownerOnlyFileMetadata(opened) || !sameMetadata(
      metadataIdentity(before),
      metadataIdentity(opened),
    )) {
      fail(code);
    }
    const bytes = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (!sameMetadata(metadataIdentity(opened), metadataIdentity(after))
        || offset !== after.size
        || offset > maximumBytes) {
      fail(code);
    }
    return bytes.subarray(0, offset);
  } catch (error) {
    if (error?.code?.startsWith("ELECTRON_REAL_HISTORY_PROFILE_")) throw error;
    fail(code);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function createSqliteBackup(sourcePath, targetPath, kind) {
  const sourceMetadataBefore = await sourceFileMetadata(sourcePath);
  const sourceSidecarsBefore = await sidecarMetadata(sourcePath);
  await assertAbsent(targetPath, "ELECTRON_REAL_HISTORY_PROFILE_TARGET_EXISTS");
  let source;
  let sourceShape;
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true, timeout: 5_000 });
    configureReadOnlyDatabase(source);
    sourceShape = validateDatabaseShape(source, kind, {
      allowMigratable: kind === "unified_index",
    });
    const dataVersionBefore = Number(scalar(source, "PRAGMA data_version", "data_version"));
    await backup(source, targetPath);
    const dataVersionAfter = Number(scalar(source, "PRAGMA data_version", "data_version"));
    if (dataVersionBefore !== dataVersionAfter) {
      fail("ELECTRON_REAL_HISTORY_PROFILE_SOURCE_CHANGED");
    }
  } catch (error) {
    if (error?.code?.startsWith("ELECTRON_REAL_HISTORY_PROFILE_")) throw error;
    fail("ELECTRON_REAL_HISTORY_PROFILE_BACKUP_FAILED");
  } finally {
    source?.close();
  }
  const sourceMetadataAfter = await sourceFileMetadata(sourcePath);
  const sourceSidecarsAfter = await sidecarMetadata(sourcePath);
  if (!sameMetadata(
    metadataIdentity(sourceMetadataBefore),
    metadataIdentity(sourceMetadataAfter),
  ) || !sidecarsEqual(sourceSidecarsBefore, sourceSidecarsAfter)) {
    fail("ELECTRON_REAL_HISTORY_PROFILE_SOURCE_CHANGED");
  }
  await chmod(targetPath, 0o600);
  await syncFile(targetPath);
  if (sourceShape.migratable === true) {
    let migrated;
    try {
      migrated = openLocalUnifiedIndex(targetPath, { readOnly: false });
    } catch {
      fail("ELECTRON_REAL_HISTORY_PROFILE_TARGET_MIGRATION_FAILED");
    } finally {
      migrated?.close();
    }
    await syncFile(targetPath);
  }
  const targetShape = await validateCopiedDatabase(targetPath, kind);
  return Object.freeze({
    source: sourceShape,
    target: targetShape,
  });
}

async function readDeviceSaltSnapshot(sourcePath) {
  const sourceBefore = await sourceFileMetadata(sourcePath);
  let bytes;
  try {
    // This helper reads without creating, chmodding, or otherwise repairing
    // the source identity file.
    const module = await import("../src/local-unified-index.js");
    bytes = await module.readExistingDeviceSalt(sourcePath);
  } catch (error) {
    if (error?.code?.startsWith("ELECTRON_REAL_HISTORY_PROFILE_")) throw error;
    fail("ELECTRON_REAL_HISTORY_PROFILE_SALT_INVALID");
  }
  const expected = Buffer.from(bytes);
  if (bytes.byteLength !== DEVICE_SALT_BYTES) {
    bytes.fill(0);
    expected.fill(0);
    fail("ELECTRON_REAL_HISTORY_PROFILE_SALT_INVALID");
  }
  const sourceAfterRead = await sourceFileMetadata(sourcePath);
  if (!sameMetadata(metadataIdentity(sourceBefore), metadataIdentity(sourceAfterRead))) {
    bytes.fill(0);
    expected.fill(0);
    fail("ELECTRON_REAL_HISTORY_PROFILE_SOURCE_CHANGED");
  }
  const sourceAfter = await sourceFileMetadata(sourcePath);
  const snapshot = Object.freeze({
    metadata: metadataIdentity(sourceAfter),
    bytes: Buffer.from(bytes),
  });
  bytes.fill(0);
  if (!sameMetadata(metadataIdentity(sourceBefore), metadataIdentity(sourceAfter))) {
    snapshot.bytes.fill(0);
    fail("ELECTRON_REAL_HISTORY_PROFILE_SOURCE_CHANGED");
  }
  return snapshot;
}

async function copyDeviceSalt(sourcePath, targetPath, snapshot) {
  if (!snapshot?.bytes || snapshot.bytes.byteLength !== DEVICE_SALT_BYTES) {
    fail("ELECTRON_REAL_HISTORY_PROFILE_SALT_INVALID");
  }
  const sourceBefore = await sourceFileMetadata(sourcePath);
  if (!sameMetadata(snapshot.metadata, metadataIdentity(sourceBefore))) {
    fail("ELECTRON_REAL_HISTORY_PROFILE_SOURCE_CHANGED");
  }
  await assertAbsent(targetPath, "ELECTRON_REAL_HISTORY_PROFILE_TARGET_EXISTS");
  let handle;
  const bytes = Buffer.from(snapshot.bytes);
  try {
    handle = await open(
      targetPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
  } catch {
    fail("ELECTRON_REAL_HISTORY_PROFILE_SALT_COPY_FAILED");
  } finally {
    bytes.fill(0);
    await handle?.close().catch(() => {});
  }
  await chmod(targetPath, 0o600);
  let copied;
  try {
    copied = await import("../src/local-unified-index.js").then(
      (module) => module.readExistingDeviceSalt(targetPath),
    );
    if (copied.byteLength !== DEVICE_SALT_BYTES
        || !timingSafeEqual(copied, snapshot.bytes)) {
      fail("ELECTRON_REAL_HISTORY_PROFILE_SALT_COPY_FAILED");
    }
    return Object.freeze({ copied: true, bytes: DEVICE_SALT_BYTES });
  } catch (error) {
    if (error?.code?.startsWith("ELECTRON_REAL_HISTORY_PROFILE_")) throw error;
    fail("ELECTRON_REAL_HISTORY_PROFILE_SALT_COPY_FAILED");
  } finally {
    copied?.fill(0);
  }
}

async function verifyDeviceSaltSnapshot(sourcePath, snapshot) {
  let current;
  try {
    const module = await import("../src/local-unified-index.js");
    current = await module.readExistingDeviceSalt(sourcePath);
    const metadata = await sourceFileMetadata(sourcePath);
    if (current.byteLength !== snapshot.bytes.byteLength
        || !timingSafeEqual(current, snapshot.bytes)
        || !sameMetadata(snapshot.metadata, metadataIdentity(metadata))) {
      fail("ELECTRON_REAL_HISTORY_PROFILE_SOURCE_CHANGED");
    }
  } catch (error) {
    if (error?.code?.startsWith("ELECTRON_REAL_HISTORY_PROFILE_")) throw error;
    fail("ELECTRON_REAL_HISTORY_PROFILE_SOURCE_CHANGED");
  } finally {
    current?.fill(0);
  }
}

async function writeExclusive(path, value, mode = 0o600) {
  await assertAbsent(path, "ELECTRON_REAL_HISTORY_PROFILE_TARGET_EXISTS");
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      mode,
    );
    await handle.writeFile(value);
    await handle.sync();
  } catch {
    fail("ELECTRON_REAL_HISTORY_PROFILE_WRITE_FAILED");
  } finally {
    await handle?.close().catch(() => {});
  }
  await chmod(path, mode);
}

async function prepareDirectories(profile) {
  const roots = Object.freeze({
    userData: join(profile, "user-data"),
    desktopSettings: join(profile, "user-data", "desktop-settings"),
    home: join(profile, "home"),
    claude: join(profile, "claude"),
    state: join(profile, "state"),
    config: join(profile, "config"),
    data: join(profile, "data"),
    cache: join(profile, "cache"),
    runtime: join(profile, "runtime"),
    tmp: join(profile, "tmp"),
    identity: join(profile, "identity"),
  });
  for (const directory of Object.values(roots)) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await safeDirectory(directory, { exact: true });
  }
  return roots;
}

async function createDevelopmentIdentity(identityFile) {
  try {
    const result = await loadOrCreateParticipantSecret({
      environmentSecret: null,
      secretFile: identityFile,
      legacySecretFile: null,
    });
    result?.secret?.fill?.(0);
  } catch {
    fail("ELECTRON_REAL_HISTORY_PROFILE_IDENTITY_FAILED");
  }
  let metadata;
  try {
    metadata = await lstat(identityFile);
  } catch {
    fail("ELECTRON_REAL_HISTORY_PROFILE_IDENTITY_INVALID");
  }
  if (!ownerOnlyFileMetadata(metadata) || metadata.size !== IDENTITY_FILE_BYTES
      || (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600)) {
    fail("ELECTRON_REAL_HISTORY_PROFILE_IDENTITY_INVALID");
  }
  return Object.freeze({
    relativePath: "identity/export-identity",
    mode: "owner_only_file_development_override",
    bytes: IDENTITY_FILE_BYTES,
  });
}

function handoffReceipt({ index, collector, identity }) {
  return Object.freeze({
    schemaVersion: REAL_HISTORY_PROFILE_SCHEMA_VERSION,
    status: "prepared",
    profileIsolated: true,
    contentFree: true,
    stateMode: "unified",
    nativeState: Object.freeze({
      unifiedIndex: Object.freeze({
        relativePath: `state/${INDEX_NAME}`,
        schemaVersion: index.target.schemaVersion,
        applicationId: index.target.applicationId,
        userVersion: index.target.userVersion,
        journalMode: index.target.journalMode,
        quickCheck: index.target.quickCheck,
        structureDigest: index.target.structureDigest,
        bytes: index.target.bytes,
      }),
      collectorState: Object.freeze({
        relativePath: `state/${COLLECTOR_NAME}`,
        schemaVersion: collector.target.schemaVersion,
        applicationId: collector.target.applicationId,
        userVersion: collector.target.userVersion,
        journalMode: collector.target.journalMode,
        quickCheck: collector.target.quickCheck,
        structureDigest: collector.target.structureDigest,
        bytes: collector.target.bytes,
      }),
    }),
    deviceSalt: Object.freeze({
      relativePath: `state/${DEVICE_SALT_NAME}`,
      copied: true,
      bytes: DEVICE_SALT_BYTES,
    }),
    exportIdentity: identity,
    providerAccess: Object.freeze({
      hostedOrigin: "none",
      contributionEnabled: false,
      developmentIdentityOnly: true,
    }),
  });
}

async function writeJsonExclusive(path, value) {
  await writeExclusive(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

async function createProfileSettings(roots, codexHome) {
  await writeJsonExclusive(join(roots.desktopSettings, "desktop-first-run-v1.json"), {
    schemaVersion: "tibotattle-desktop-first-run-v1",
    acknowledged: true,
  });
  await writeJsonExclusive(join(roots.desktopSettings, "desktop-settings-v1.json"), {
    schemaVersion: "tibotattle-desktop-settings-v1",
    codexHome: { mode: "custom", path: codexHome },
    language: "system",
    appearance: "system",
    refreshIntervalSeconds: 300,
    startAtLogin: false,
    notifications: { enabled: false, threshold: "off" },
    sidebarCollapsed: false,
  });
}

export async function prepareRealHistoryProfile({
  sourceStateRoot,
  profilePath,
  codexHomePath,
} = {}) {
  const sourceRoot = absolutePath(sourceStateRoot);
  const profile = absolutePath(profilePath);
  const codexHome = absolutePath(codexHomePath);
  if (pathsOverlap(sourceRoot, profile)
      || pathsOverlap(profile, codexHome)
      || pathsOverlap(sourceRoot, codexHome)) {
    fail("ELECTRON_REAL_HISTORY_PROFILE_PATH_INVALID");
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    fail("ELECTRON_REAL_HISTORY_PROFILE_MAC_ARM64_REQUIRED");
  }
  await assertSourceRoot(sourceRoot);
  await assertNoSymlinkComponents(profile);
  await assertNoSymlinkComponents(codexHome);
  await safeDirectory(codexHome, { exact: false });
  const sourceIndex = join(sourceRoot, INDEX_NAME);
  const sourceCollector = join(sourceRoot, COLLECTOR_NAME);
  const sourceSalt = join(sourceRoot, DEVICE_SALT_NAME);
  for (const sourceName of SOURCE_FILE_NAMES) {
    if (!PROFILE_PATH_COMPONENT_PATTERN.test(sourceName)) {
      fail("ELECTRON_REAL_HISTORY_PROFILE_SOURCE_INVALID");
    }
  }
  // Check the source identity before reserving any destination. This is a
  // read-only preflight and deliberately never repairs missing state.
  await sourceFileMetadata(sourceIndex);
  await sourceFileMetadata(sourceCollector);
  await sourceFileMetadata(sourceSalt);

  const parent = dirname(profile);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(parent);
  await safeDirectory(parent, { exact: false });
  await assertAbsent(profile, "ELECTRON_REAL_HISTORY_PROFILE_TARGET_EXISTS");
  const staging = join(
    parent,
    `.${basename(profile)}.building-${process.pid}-${Date.now()}`,
  );
  await assertAbsent(staging, "ELECTRON_REAL_HISTORY_PROFILE_TARGET_EXISTS");
  await mkdir(staging, { mode: 0o700 });
  let completed = false;
  try {
    await safeDirectory(staging, { exact: true });
    const roots = await prepareDirectories(staging);
    const stateIndex = join(roots.state, INDEX_NAME);
    const stateCollector = join(roots.state, COLLECTOR_NAME);
    const stateSalt = join(roots.state, DEVICE_SALT_NAME);
    let saltSnapshot;
    try {
      // Copy the salt before the database backups, then verify that both its
      // bytes and identity metadata remained unchanged for the whole snapshot
      // window. A rotating salt must never be paired with retained rows.
      saltSnapshot = await readDeviceSaltSnapshot(sourceSalt);
      const salt = await copyDeviceSalt(sourceSalt, stateSalt, saltSnapshot);
      const [index, collector] = await Promise.all([
        createSqliteBackup(sourceIndex, stateIndex, "unified_index"),
        createSqliteBackup(sourceCollector, stateCollector, "collector_state"),
      ]);
      await verifyDeviceSaltSnapshot(sourceSalt, saltSnapshot);
      const identity = await createDevelopmentIdentity(join(roots.identity, IDENTITY_NAME));
      await createProfileSettings(roots, codexHome);
      const receipt = handoffReceipt({ index, collector, identity });
      await writeJsonExclusive(join(staging, PROFILE_RECEIPT_NAME), receipt);
      await syncDirectory(staging);
      await rename(staging, profile);
      await chmod(profile, 0o700);
      await syncDirectory(parent);
      completed = true;
      return Object.freeze({
        status: "prepared",
        schemaVersion: REAL_HISTORY_PROFILE_SCHEMA_VERSION,
        deviceSaltCopied: salt.copied === true,
        hostedOrigin: "none",
        contributionEnabled: false,
      });
    } finally {
      saltSnapshot?.bytes.fill(0);
    }
  } finally {
    if (!completed) await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

function readBoundedJson(path) {
  return readBoundedOwnerFile(
    path,
    PROFILE_FILE_MAX_BYTES,
    "ELECTRON_REAL_HISTORY_PROFILE_HANDOFF_INVALID",
  ).then((bytes) => {
    if (bytes.byteLength < 2) {
      fail("ELECTRON_REAL_HISTORY_PROFILE_HANDOFF_INVALID");
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("ELECTRON_REAL_HISTORY_PROFILE_HANDOFF_INVALID");
    }
  });
}

function relativeProfilePath(profile, candidate) {
  const selected = resolve(candidate);
  if (!pathWithin(profile, selected)
      || selected.includes("\0")) {
    fail("ELECTRON_REAL_HISTORY_PROFILE_HANDOFF_INVALID");
  }
  return selected;
}

function interactiveEnvironment(profile, codexHomePath) {
  return Object.fromEntries(Object.entries({
    PATH: process.env.PATH,
    LANG: "en_US.UTF-8",
    HOME: process.env.HOME,
    TMPDIR: profile.roots.tmp,
    CODEX_HOME: codexHomePath,
    CLAUDE_CONFIG_DIR: profile.roots.claude,
    XDG_CONFIG_HOME: profile.roots.config,
    XDG_DATA_HOME: profile.roots.data,
    XDG_CACHE_HOME: profile.roots.cache,
    XDG_RUNTIME_DIR: profile.roots.runtime,
    USAGE_MONITOR_STATE_ROOT: profile.roots.state,
    USAGE_MONITOR_ACCOUNTING_SOURCE_MODE: "unified",
    USAGE_MONITOR_TEST_LANE: "macos-electron-local-qa-v1",
    USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY: "1",
    USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE: profile.identityPath,
    ELECTRON_NO_ATTACH_CONSOLE: "1",
  }).filter(([, value]) => value !== undefined));
}

async function validateIdentityFile(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    fail("ELECTRON_REAL_HISTORY_PROFILE_IDENTITY_INVALID");
  }
  if (!ownerOnlyFileMetadata(metadata)
      || metadata.size !== IDENTITY_FILE_BYTES
      || (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600)) {
    fail("ELECTRON_REAL_HISTORY_PROFILE_IDENTITY_INVALID");
  }
  const content = await readBoundedOwnerFile(
    path,
    IDENTITY_FILE_BYTES,
    "ELECTRON_REAL_HISTORY_PROFILE_IDENTITY_INVALID",
  );
  if (content.byteLength !== IDENTITY_FILE_BYTES
      || !/^[A-Za-z0-9_-]{43}\n$/u.test(content.toString("utf8"))) {
    fail("ELECTRON_REAL_HISTORY_PROFILE_IDENTITY_INVALID");
  }
}

export async function validateRealHistoryProfile(profilePath) {
  const profile = absolutePath(profilePath);
  await assertNoSymlinkComponents(profile);
  await safeDirectory(profile, { exact: true });
  const receipt = await readBoundedJson(join(profile, PROFILE_RECEIPT_NAME));
  if (receipt === null
      || typeof receipt !== "object"
      || Array.isArray(receipt)
      || receipt.schemaVersion !== REAL_HISTORY_PROFILE_SCHEMA_VERSION
      || receipt.status !== "prepared"
      || receipt.profileIsolated !== true
      || receipt.contentFree !== true
      || receipt.stateMode !== "unified"
      || receipt.providerAccess?.hostedOrigin !== "none"
      || receipt.providerAccess?.contributionEnabled !== false
      || receipt.providerAccess?.developmentIdentityOnly !== true
      || receipt.deviceSalt?.copied !== true
      || receipt.deviceSalt?.bytes !== DEVICE_SALT_BYTES
      || receipt.nativeState?.unifiedIndex?.relativePath !== `state/${INDEX_NAME}`
      || receipt.nativeState?.collectorState?.relativePath !== `state/${COLLECTOR_NAME}`
      || !DIGEST_PATTERN.test(receipt.nativeState?.unifiedIndex?.structureDigest ?? "")
      || !DIGEST_PATTERN.test(receipt.nativeState?.collectorState?.structureDigest ?? "")
      || receipt.deviceSalt?.relativePath !== `state/${DEVICE_SALT_NAME}`
      || receipt.exportIdentity?.relativePath !== `identity/${IDENTITY_NAME}`
      || receipt.exportIdentity?.mode !== "owner_only_file_development_override"
      || receipt.exportIdentity?.bytes !== IDENTITY_FILE_BYTES) {
    fail("ELECTRON_REAL_HISTORY_PROFILE_HANDOFF_INVALID");
  }
  const roots = await prepareValidationDirectories(profile);
  const indexPath = relativeProfilePath(profile, join(profile, `state/${INDEX_NAME}`));
  const collectorPath = relativeProfilePath(profile, join(profile, `state/${COLLECTOR_NAME}`));
  const saltPath = relativeProfilePath(profile, join(profile, `state/${DEVICE_SALT_NAME}`));
  const identityPath = relativeProfilePath(profile, join(profile, `identity/${IDENTITY_NAME}`));
  if (basename(indexPath) !== INDEX_NAME
      || basename(collectorPath) !== COLLECTOR_NAME
      || basename(saltPath) !== DEVICE_SALT_NAME
      || basename(identityPath) !== IDENTITY_NAME) {
    fail("ELECTRON_REAL_HISTORY_PROFILE_HANDOFF_INVALID");
  }
  const [index, collector] = await Promise.all([
    // Launch-time checks use SQLite's bounded one-error integrity form while
    // preparation retains the complete quick_check over each copied DB.
    validateCopiedDatabase(indexPath, "unified_index", { deep: false }),
    validateCopiedDatabase(collectorPath, "collector_state", { deep: false }),
  ]);
  if (index.schemaVersion !== receipt.nativeState.unifiedIndex.schemaVersion
      || collector.schemaVersion !== receipt.nativeState.collectorState.schemaVersion
      || index.structureDigest !== receipt.nativeState.unifiedIndex.structureDigest
      || collector.structureDigest !== receipt.nativeState.collectorState.structureDigest) {
    fail("ELECTRON_REAL_HISTORY_PROFILE_HANDOFF_INVALID");
  }
  const saltMetadata = await sourceFileMetadata(saltPath);
  if (saltMetadata.size !== DEVICE_SALT_BYTES) fail("ELECTRON_REAL_HISTORY_PROFILE_SALT_INVALID");
  await validateIdentityFile(identityPath);
  return Object.freeze({
    profile,
    roots,
    receipt,
    indexPath,
    collectorPath,
    saltPath,
    identityPath,
    qaReceiptPath: join(profile, QA_RECEIPT_NAME),
  });
}

async function prepareValidationDirectories(profile) {
  const names = [
    "user-data",
    join("user-data", "desktop-settings"),
    "home",
    "claude",
    "state",
    "config",
    "data",
    "cache",
    "runtime",
    "tmp",
    "identity",
  ];
  const result = {};
  for (const name of names) {
    const path = join(profile, name);
    await safeDirectory(path, { exact: true });
    result[name.replaceAll("/", "_")] = path;
  }
  return Object.freeze(result);
}

function parsedArgument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && typeof argv[index + 1] === "string"
    ? argv[index + 1]
    : null;
}

export function parseRealHistoryProfileArguments(argv = process.argv.slice(2)) {
  if (argv.includes("--help")) return Object.freeze({ help: true });
  const command = argv[0];
  if (!REAL_HISTORY_PROFILE_COMMANDS.includes(command)) {
    fail("ELECTRON_REAL_HISTORY_PROFILE_INPUT_INVALID");
  }
  const known = command === "prepare"
    ? new Set(["--source-state-root", "--profile", "--codex-home"])
    : new Set([
      "--app",
      "--profile",
      "--codex-home",
      "--artifact-sha256",
      "--source-revision",
      "--mode",
    ]);
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (!known.has(value)
        || seen.has(value)
        || typeof argv[index + 1] !== "string"
        || argv[index + 1].startsWith("--")) {
      fail("ELECTRON_REAL_HISTORY_PROFILE_INPUT_INVALID");
    }
    seen.add(value);
    index += 1;
  }
  if (command === "prepare") {
    const sourceStateRoot = absolutePath(parsedArgument(argv, "--source-state-root"));
    const profilePath = absolutePath(parsedArgument(argv, "--profile"));
    const codexHomePath = absolutePath(parsedArgument(argv, "--codex-home"));
    return Object.freeze({
      help: false,
      command,
      sourceStateRoot,
      profilePath,
      codexHomePath,
    });
  }
  const appPath = absolutePath(parsedArgument(argv, "--app"));
  const profilePath = absolutePath(parsedArgument(argv, "--profile"));
  const codexHomePath = absolutePath(parsedArgument(argv, "--codex-home"));
  const artifactSha256 = parsedArgument(argv, "--artifact-sha256");
  const sourceRevision = parsedArgument(argv, "--source-revision");
  const mode = parsedArgument(argv, "--mode") ?? "full";
  if (!SHA256_PATTERN.test(artifactSha256 ?? "")
      || !SOURCE_REVISION_PATTERN.test(sourceRevision ?? "")
      || !QA_MODES.includes(mode)) {
    fail("ELECTRON_REAL_HISTORY_PROFILE_INPUT_INVALID");
  }
  if (pathsOverlap(appPath, profilePath)
      || pathsOverlap(profilePath, codexHomePath)
      || pathsOverlap(appPath, codexHomePath)) {
    fail("ELECTRON_REAL_HISTORY_PROFILE_PATH_INVALID");
  }
  return Object.freeze({
    help: false,
    command,
    appPath,
    profilePath,
    codexHomePath,
    artifactSha256,
    sourceRevision,
    mode,
  });
}

async function launchRealHistoryProfile(options) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    fail("ELECTRON_REAL_HISTORY_PROFILE_MAC_ARM64_REQUIRED");
  }
  const profile = await validateRealHistoryProfile(options.profilePath);
  await safeDirectory(options.codexHomePath, { exact: false });
  const observedSha256 = await verifyPackagedArtifactIdentity(
    options.appPath,
    options.artifactSha256,
  );
  const qaScript = join(dirname(fileURLToPath(import.meta.url)), "qa-electron-macos-real-history.mjs");
  let child;
  try {
    child = spawn(process.execPath, [
      qaScript,
      "--app", options.appPath,
      "--profile", profile.profile,
      "--codex-home", options.codexHomePath,
      "--identity-file", profile.identityPath,
      "--artifact-sha256", observedSha256,
      "--source-revision", options.sourceRevision,
      "--mode", options.mode,
      "--receipt", profile.qaReceiptPath,
    ], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
      },
      stdio: "ignore",
    });
  } catch {
    fail("ELECTRON_REAL_HISTORY_PROFILE_LAUNCH_FAILED");
  }
  const exitCode = await new Promise((resolveExit) => {
    child.once("error", () => resolveExit(null));
    child.once("exit", (code) => resolveExit(Number.isSafeInteger(code) ? code : null));
  });
  let qaReceipt = null;
  try {
    qaReceipt = await readBoundedJson(profile.qaReceiptPath);
  } catch {
    qaReceipt = null;
  }
  return Object.freeze({
    status: exitCode === 0 && qaReceipt?.status === "passed" ? "passed" : "failed",
    schemaVersion: REAL_HISTORY_PROFILE_SCHEMA_VERSION,
    qaReceiptWritten: qaReceipt !== null,
    qaStatus: qaReceipt?.status === "passed" ? "passed" : "failed",
  });
}

async function launchInteractiveRealHistoryProfile(options) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    fail("ELECTRON_REAL_HISTORY_PROFILE_MAC_ARM64_REQUIRED");
  }
  const profile = await validateRealHistoryProfile(options.profilePath);
  await safeDirectory(options.codexHomePath, { exact: false });
  const observedSha256 = await verifyPackagedArtifactIdentity(
    options.appPath,
    options.artifactSha256,
  );
  const executable = join(options.appPath, "Contents", "MacOS", "TiboTattle Dev");
  let child;
  try {
    child = spawn(executable, [
      `--user-data-dir=${join(profile.profile, "user-data")}`,
      "--disable-gpu",
    ], {
      cwd: join(options.appPath, "Contents", "Resources"),
      env: interactiveEnvironment(profile, options.codexHomePath),
      stdio: "ignore",
    });
  } catch {
    fail("ELECTRON_REAL_HISTORY_PROFILE_LAUNCH_FAILED");
  }
  const exitCode = await new Promise((resolveExit) => {
    child.once("error", () => resolveExit(null));
    child.once("exit", (code) => resolveExit(Number.isSafeInteger(code) ? code : null));
  });
  return Object.freeze({
    status: exitCode === 0 ? "exited_cleanly" : "exited",
    schemaVersion: REAL_HISTORY_PROFILE_SCHEMA_VERSION,
    artifactVerified: observedSha256 === options.artifactSha256,
  });
}

function printHelp() {
  process.stdout.write([
    "Usage:",
    "  node scripts/electron-macos-real-history-profile.mjs prepare",
    "    --source-state-root <absolute native app-usagemonitor state root>",
    "    --profile <absolute durable private profile>",
    "    --codex-home <absolute caller-selected Codex home>",
    "  node scripts/electron-macos-real-history-profile.mjs launch",
    "    --app <absolute TiboTattle Dev.app>",
    "    --profile <absolute prepared profile>",
    "    --codex-home <absolute caller-selected Codex home>",
    "    --artifact-sha256 <lowercase app.asar SHA-256>",
    "    --source-revision <lowercase 40-hex source revision>",
    "    [--mode cancel|snapshot|full|relaunch]",
    "  node scripts/electron-macos-real-history-profile.mjs interactive",
    "    --app <absolute TiboTattle Dev.app>",
    "    --profile <absolute prepared profile>",
    "    --codex-home <absolute caller-selected Codex home>",
    "    --artifact-sha256 <lowercase app.asar SHA-256>",
    "    --source-revision <lowercase 40-hex source revision>",
    "",
    "The profile is persistent and private. This command never installs, signs,",
    "publishes, removes, or replaces an app or the native source state.",
  ].join("\n") + "\n");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const options = parseRealHistoryProfileArguments();
    if (options.help) {
      printHelp();
    } else {
      const result = options.command === "prepare"
        ? await prepareRealHistoryProfile({
          sourceStateRoot: options.sourceStateRoot,
          profilePath: options.profilePath,
          codexHomePath: options.codexHomePath,
        })
        : options.command === "launch"
          ? await launchRealHistoryProfile(options)
          : await launchInteractiveRealHistoryProfile(options);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      status: "failed",
      schemaVersion: REAL_HISTORY_PROFILE_SCHEMA_VERSION,
      code: typeof error?.code === "string"
        && /^ELECTRON_REAL_HISTORY_PROFILE_[A-Z0-9_]+$/u.test(error.code)
        ? error.code
        : "ELECTRON_REAL_HISTORY_PROFILE_FAILED",
    })}\n`);
    process.exitCode = 1;
  }
}
