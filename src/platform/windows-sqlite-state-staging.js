import { win32 } from "node:path";

import {
  isWindowsFilesystemAdapter,
  isWindowsFilesystemIdentity,
} from "./windows-filesystem.js";

/**
 * Root-bound SQLite staging and publication for the unified index.
 *
 * This is deliberately a small coordinator around the native adapter. It
 * does not copy bytes, open SQLite, or use Node's filesystem APIs. The native
 * methods hold the validated root and source/target handles through clone and
 * atomic replacement. `stagingSafe` remains false until the native Windows
 * qualification lane proves the supported OS/filesystem matrix.
 */
export const WINDOWS_SQLITE_STATE_STAGING_CONTRACT_VERSION =
  "windows-sqlite-state-staging-v1";
export const WINDOWS_SQLITE_STATE_STAGING_SAFE = false;

const CONTEXTS = new WeakSet();
const MAX_PATH_LENGTH = 32_767;
const RESERVED_DEVICE_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

const ERROR_CODES = new Set([
  "invalid_configuration",
  "invalid_adapter",
  "invalid_root",
  "invalid_database_name",
  "root_unavailable",
  "database_missing",
  "database_invalid",
  "stage_unavailable",
  "identity_mismatch",
  "publication_unavailable",
]);

export class WindowsSqliteStateStagingError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Windows SQLite staging error code");
    }
    super("Windows SQLite state staging operation failed");
    this.name = "WindowsSqliteStateStagingError";
    this.code = `windows_sqlite_state_staging_${code}`;
  }
}

function fail(code) {
  throw new WindowsSqliteStateStagingError(code);
}

function canonicalRoot(rootPath) {
  if (typeof rootPath !== "string"
      || rootPath.length < 4
      || rootPath.length > MAX_PATH_LENGTH
      || rootPath.includes("\0")) {
    fail("invalid_root");
  }
  const raw = rootPath.replaceAll("/", "\\");
  if (raw.split("\\").some((component) => component === "." || component === "..")) {
    fail("invalid_root");
  }
  const normalized = win32.normalize(raw);
  if (!win32.isAbsolute(normalized)
      || !/^(?:\\\\\?\\)?[A-Za-z]:\\/u.test(normalized)) {
    fail("invalid_root");
  }
  const parsed = win32.parse(normalized);
  const canonical = normalized.endsWith("\\")
    ? normalized.slice(0, -1)
    : normalized;
  if (parsed.root.length >= canonical.length) fail("invalid_root");
  const components = canonical.slice(parsed.root.length).split("\\");
  if (components.some((component) => {
    if (component.length === 0
        || component === "."
        || component === ".."
        || component.endsWith(".")
        || component.endsWith(" ")
        || /[<>:"|?*]/u.test(component)) return true;
    return RESERVED_DEVICE_NAMES.has(component.split(".", 1)[0].toUpperCase());
  })) {
    fail("invalid_root");
  }
  return canonical;
}

function canonicalDatabaseName(databaseName) {
  if (typeof databaseName !== "string"
      || databaseName.length < 1
      || databaseName.length > MAX_PATH_LENGTH
      || databaseName.includes("\0")
      || databaseName.includes("\\")
      || databaseName.includes("/")
      || databaseName.endsWith(".")
      || databaseName.endsWith(" ")
      || /[<>:"|?*]/u.test(databaseName)
      || /(?:-journal|-wal|-shm)$/iu.test(databaseName)
      || RESERVED_DEVICE_NAMES.has(databaseName.split(".", 1)[0].toUpperCase())) {
    fail("invalid_database_name");
  }
  return databaseName;
}

function exactIdentity(value) {
  let valid = false;
  try {
    valid = isWindowsFilesystemIdentity(value)
      && value.linkCount === 1
      && Object.keys(value).sort().join("\0")
        === "fileId\0linkCount\0volumeSerialNumber";
  } catch {
    valid = false;
  }
  if (!valid) fail("database_invalid");
  return Object.freeze({
    volumeSerialNumber: value.volumeSerialNumber,
    fileId: value.fileId,
    linkCount: 1,
  });
}

function sameIdentity(left, right) {
  return left.volumeSerialNumber === right.volumeSerialNumber
    && left.fileId === right.fileId
    && left.linkCount === right.linkCount;
}

function mapNativeFailure(error, fallback) {
  if (error?.code === "WINDOWS_FILESYSTEM_NOT_FOUND") fail("database_missing");
  if (error?.code === "WINDOWS_FILESYSTEM_IDENTITY_MISMATCH"
      || error?.code === "WINDOWS_FILESYSTEM_HARD_LINK"
      || error?.code === "WINDOWS_FILESYSTEM_REPARSE_POINT") {
    fail("identity_mismatch");
  }
  fail(fallback);
}

function validateMetadata(result) {
  let valid = false;
  try {
    valid = result !== null
      && typeof result === "object"
      && result.isDirectory === false
      && result.isRegularFile === true
      && result.isReparsePoint === false
      && result.ownerMatches === true
      && result.nullDacl === false
      && result.daclProtected === true
      && result.broadAccess === false
      && result.nonOwnerAllow === false
      && result.unrecognizedAce === false
      && result.finalPathResolved === true;
  } catch {
    valid = false;
  }
  if (!valid) fail("database_invalid");
  return exactIdentity(result.identity);
}

function validateRootMetadata(result) {
  let valid = false;
  try {
    valid = result !== null
      && typeof result === "object"
      && result.isDirectory === true
      && result.isRegularFile === false
      && result.isReparsePoint === false
      && result.ownerMatches === true
      && result.nullDacl === false
      && result.daclProtected === true
      && result.broadAccess === false
      && result.nonOwnerAllow === false
      && result.unrecognizedAce === false
      && result.finalPathResolved === true;
  } catch {
    valid = false;
  }
  if (!valid) fail("root_unavailable");
  return exactIdentity(result.identity);
}

export function isWindowsSqliteStateStaging(value) {
  try {
    return value !== null
      && typeof value === "object"
      && CONTEXTS.has(value);
  } catch {
    return false;
  }
}

export function createWindowsSqliteStateStaging({ adapter, rootPath } = {}) {
  if (!isWindowsFilesystemAdapter(adapter)) fail("invalid_adapter");
  const root = canonicalRoot(rootPath);
  let rootIdentity;
  const stageIdentities = new Map();

  function inspectRoot() {
    let metadata;
    try {
      metadata = adapter.inspectPath(root);
    } catch (error) {
      mapNativeFailure(error, "root_unavailable");
    }
    const identity = validateRootMetadata(metadata);
    if (rootIdentity !== undefined && !sameIdentity(identity, rootIdentity)) {
      fail("identity_mismatch");
    }
    if (rootIdentity === undefined) rootIdentity = identity;
    return rootIdentity;
  }

  function inspect(name) {
    const childName = canonicalDatabaseName(name);
    const expectedRoot = inspectRoot();
    let metadata;
    try {
      metadata = adapter.inspectProtectedChild(root, expectedRoot, childName);
    } catch (error) {
      mapNativeFailure(error, "database_missing");
    }
    const identity = validateMetadata(metadata);
    const previous = stageIdentities.get(childName.toLowerCase());
    if (previous !== undefined && !sameIdentity(previous, identity)) {
      fail("identity_mismatch");
    }
    return identity;
  }

  function create(name) {
    const childName = canonicalDatabaseName(name);
    const expectedRoot = inspectRoot();
    let identity;
    try {
      identity = exactIdentity(adapter.createSqliteDatabase(
        root,
        expectedRoot,
        childName,
      ));
    } catch (error) {
      mapNativeFailure(error, "stage_unavailable");
    }
    stageIdentities.set(childName.toLowerCase(), identity);
    return identity;
  }

  function clone(sourceName, stageName) {
    const source = canonicalDatabaseName(sourceName);
    const stage = canonicalDatabaseName(stageName);
    if (source.toLowerCase() === stage.toLowerCase()) fail("invalid_database_name");
    const expectedRoot = inspectRoot();
    // Inspect before invoking the native clone so the expected source identity
    // is visible to this coordinator and any name swap is detected on the
    // second, handle-bound native open.
    const sourceIdentity = inspect(source);
    let result;
    try {
      result = adapter.cloneSqliteDatabase(root, expectedRoot, source, stage);
    } catch (error) {
      mapNativeFailure(error, "stage_unavailable");
    }
    if (!sameIdentity(sourceIdentity, exactIdentity(result.sourceIdentity))) {
      fail("identity_mismatch");
    }
    const stageIdentity = exactIdentity(result.stageIdentity);
    stageIdentities.set(stage.toLowerCase(), stageIdentity);
    return Object.freeze({ sourceIdentity, stageIdentity });
  }

  function publish(stageName, targetName, expectedTargetIdentity = null) {
    const stage = canonicalDatabaseName(stageName);
    const target = canonicalDatabaseName(targetName);
    if (stage.toLowerCase() === target.toLowerCase()) fail("invalid_database_name");
    const expectedRoot = inspectRoot();
    const expectedStage = stageIdentities.get(stage.toLowerCase()) ?? inspect(stage);
    const expectedTarget = expectedTargetIdentity === null
      ? null
      : exactIdentity(expectedTargetIdentity);
    if (expectedTarget === null) {
      try {
        inspect(target);
        fail("identity_mismatch");
      } catch (error) {
        if (!(error instanceof WindowsSqliteStateStagingError)
            || error.code !== "windows_sqlite_state_staging_database_missing") {
          throw error;
        }
      }
    }
    let result;
    try {
      result = adapter.publishSqliteDatabase(
        root,
        expectedRoot,
        stage,
        expectedStage,
        target,
        expectedTarget,
      );
    } catch (error) {
      mapNativeFailure(error, "publication_unavailable");
    }
    const publishedIdentity = exactIdentity(result.identity);
    stageIdentities.delete(stage.toLowerCase());
    stageIdentities.set(target.toLowerCase(), publishedIdentity);
    return Object.freeze({ published: true, identity: publishedIdentity });
  }

  function discard(name) {
    const childName = canonicalDatabaseName(name);
    const expectedRoot = inspectRoot();
    const expected = stageIdentities.get(childName.toLowerCase());
    if (expected === undefined) {
      try {
        inspect(childName);
      } catch (error) {
        if (error instanceof WindowsSqliteStateStagingError
            && error.code === "windows_sqlite_state_staging_database_missing") {
          return Object.freeze({ deleted: false });
        }
        throw error;
      }
    }
    const identity = expected ?? inspect(childName);
    try {
      const result = adapter.deleteProtectedChild(
        root,
        expectedRoot,
        childName,
        identity,
      );
      if (result?.deleted !== true) fail("stage_unavailable");
    } catch (error) {
      mapNativeFailure(error, "stage_unavailable");
    }
    stageIdentities.delete(childName.toLowerCase());
    return Object.freeze({ deleted: true });
  }

  const context = {
    contractVersion: WINDOWS_SQLITE_STATE_STAGING_CONTRACT_VERSION,
    rootPath: root,
    stagingSafe: WINDOWS_SQLITE_STATE_STAGING_SAFE,
    inspect,
    create,
    clone,
    publish,
    discard,
  };
  Object.freeze(context);
  CONTEXTS.add(context);
  return context;
}
