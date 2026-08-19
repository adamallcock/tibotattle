import { win32 } from "node:path";

import {
  isWindowsFilesystemAdapter,
  isWindowsFilesystemIdentity,
} from "./windows-filesystem.js";

/**
 * Root-bound storage for Windows prepared contribution and review artifacts.
 *
 * This is intentionally only a coordinator around the repository-branded
 * native adapter.  It does not import node:fs, perform a fallback path walk,
 * or expose the adapter itself to callers.  The native binding remains
 * qualification-only, so this context never promotes its own readiness or
 * production-safety claim.
 */
export const WINDOWS_PREPARED_ARTIFACT_STORAGE_CONTRACT_VERSION =
  "windows-prepared-artifact-storage-v1";
export const WINDOWS_PREPARED_ARTIFACT_STORAGE_MAXIMUM_CONTRIBUTION_BYTES =
  1_310_720;
export const WINDOWS_PREPARED_ARTIFACT_STORAGE_MAXIMUM_ARTIFACT_BYTES =
  34 * 1024 * 1024;
export const WINDOWS_PREPARED_ARTIFACT_STORAGE_MAXIMUM_DIRECTORY_ENTRIES =
  256;
export const WINDOWS_PREPARED_ARTIFACT_STORAGE_PRODUCTION_SAFE = false;
export const WINDOWS_PREPARED_ARTIFACT_STORAGE_READINESS = false;
// Alias kept explicit because callers commonly need a single gate when
// composing the wider Windows capability set.
export const WINDOWS_PREPARED_ARTIFACT_STORAGE_SAFE = false;

const MAX_PATH_LENGTH = 32_767;
const CONTEXTS = new WeakSet();
const ERRORS = new WeakSet();
const RESERVED_DEVICE_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

const ERROR_CODES = new Set([
  "invalid_configuration",
  "invalid_adapter",
  "invalid_root",
  "invalid_path",
  "path_escape",
  "invalid_identity",
  "security_policy",
  "invalid_result",
  "root_unavailable",
  "missing",
  "already_exists",
  "identity_mismatch",
  "too_large",
  "directory_limit",
  "directory_not_empty",
  "unavailable",
]);

export class WindowsPreparedArtifactStorageError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Windows prepared artifact storage error code");
    }
    super("Windows prepared artifact storage operation failed");
    this.name = "WindowsPreparedArtifactStorageError";
    this.code = `windows_prepared_artifact_storage_${code}`;
    ERRORS.add(this);
  }
}

export function isWindowsPreparedArtifactStorageError(error) {
  try {
    return error instanceof WindowsPreparedArtifactStorageError
      && ERRORS.has(error)
      && Object.getPrototypeOf(error)
        === WindowsPreparedArtifactStorageError.prototype;
  } catch {
    return false;
  }
}

export function isWindowsPreparedArtifactStorage(context) {
  try {
    return context !== null
      && typeof context === "object"
      && CONTEXTS.has(context);
  } catch {
    return false;
  }
}

function fail(code) {
  throw new WindowsPreparedArtifactStorageError(code);
}

function mapNativeFailure(error, fallback) {
  if (isWindowsPreparedArtifactStorageError(error)) throw error;
  let code = null;
  try {
    code = error?.code;
  } catch {
    code = null;
  }
  if (code === "ENOENT" || code === "WINDOWS_FILESYSTEM_NOT_FOUND") {
    fail("missing");
  }
  if (code === "EEXIST" || code === "WINDOWS_FILESYSTEM_ALREADY_EXISTS") {
    fail("already_exists");
  }
  if (code === "WINDOWS_FILESYSTEM_IDENTITY_MISMATCH") {
    fail("identity_mismatch");
  }
  if (code === "WINDOWS_FILESYSTEM_REPARSE_POINT"
      || code === "WINDOWS_FILESYSTEM_HARD_LINK"
      || code === "WINDOWS_FILESYSTEM_SECURITY_POLICY") {
    fail("security_policy");
  }
  if (code === "WINDOWS_FILESYSTEM_PREPARED_DIRECTORY_NOT_EMPTY") {
    fail("directory_not_empty");
  }
  if (code === "WINDOWS_FILESYSTEM_PREPARED_DIRECTORY_LIMIT"
      || code === "WINDOWS_FILESYSTEM_INVALID_PREPARED_DIRECTORY_LIMIT") {
    fail("directory_limit");
  }
  if (code === "WINDOWS_FILESYSTEM_FILE_TOO_LARGE"
      || code === "WINDOWS_FILESYSTEM_PREPARED_FILE_TOO_LARGE"
      || code === "WINDOWS_FILESYSTEM_INVALID_PREPARED_MAXIMUM_BYTES") {
    fail("too_large");
  }
  if (code === "WINDOWS_FILESYSTEM_INVALID_RESULT") fail("invalid_result");
  if (code === "WINDOWS_FILESYSTEM_INVALID_IDENTITY") fail("invalid_result");
  if (code === "WINDOWS_FILESYSTEM_INVALID_PATH") fail("invalid_path");
  fail(fallback);
}

function invalidWindowsComponent(component) {
  if (component.length === 0
      || component === "."
      || component === ".."
      || component.endsWith(".")
      || component.endsWith(" ")
      || /[<>:"|?*]/u.test(component)) {
    return true;
  }
  return RESERVED_DEVICE_NAMES.has(component.split(".", 1)[0].toUpperCase());
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
  let normalized;
  try {
    normalized = win32.normalize(raw);
  } catch {
    fail("invalid_root");
  }
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
  if (components.some(invalidWindowsComponent)) fail("invalid_root");
  return canonical;
}

function canonicalRelativeName(name) {
  if (typeof name !== "string"
      || name.length < 1
      || name.length > MAX_PATH_LENGTH
      || name.includes("\0")
      || win32.isAbsolute(name)
      || /^[A-Za-z]:/u.test(name)
      || name.startsWith("\\\\")) {
    fail("invalid_path");
  }
  const components = name.replaceAll("/", "\\").split("\\");
  if (components.some(invalidWindowsComponent)) fail("path_escape");
  const normalized = components.join("\\");
  if (normalized.length > MAX_PATH_LENGTH) fail("path_escape");
  return normalized;
}

function absoluteChildPath(root, relativeName) {
  const candidate = `${root}\\${relativeName}`;
  const prefix = `${root}\\`.toLowerCase();
  if (!candidate.toLowerCase().startsWith(prefix)
      || candidate.length <= prefix.length
      || candidate.length > MAX_PATH_LENGTH) {
    fail("path_escape");
  }
  return candidate;
}

function exactIdentity(value, code = "invalid_identity") {
  let valid = false;
  let snapshot;
  try {
    valid = isWindowsFilesystemIdentity(value)
      && value.linkCount === 1
      && Object.keys(value).sort().join("\0")
        === "fileId\0linkCount\0volumeSerialNumber";
    if (valid) {
      snapshot = {
        volumeSerialNumber: value.volumeSerialNumber,
        fileId: value.fileId,
        linkCount: 1,
      };
    }
  } catch {
    valid = false;
  }
  if (!valid || snapshot === undefined) fail(code);
  return Object.freeze(snapshot);
}

function sameIdentity(left, right) {
  return left.volumeSerialNumber === right.volumeSerialNumber
    && left.fileId === right.fileId
    && left.linkCount === right.linkCount;
}

function validateRootMetadata(metadata) {
  let valid = false;
  try {
    valid = metadata !== null
      && typeof metadata === "object"
      && !Array.isArray(metadata)
      && metadata.isDirectory === true
      && metadata.isRegularFile === false
      && metadata.isReparsePoint === false
      && metadata.ownerMatches === true
      && metadata.nullDacl === false
      && metadata.daclProtected === true
      && metadata.broadAccess === false
      && metadata.nonOwnerAllow === false
      && metadata.unrecognizedAce === false
      && metadata.finalPathResolved === true;
  } catch {
    valid = false;
  }
  if (!valid) fail("security_policy");
  return exactIdentity(metadata.identity);
}

function validateChildMetadata(metadata) {
  let valid = false;
  try {
    valid = metadata !== null
      && typeof metadata === "object"
      && !Array.isArray(metadata)
      && typeof metadata.isDirectory === "boolean"
      && typeof metadata.isRegularFile === "boolean"
      && metadata.isDirectory !== metadata.isRegularFile
      && metadata.isReparsePoint === false
      && metadata.ownerMatches === true
      && metadata.nullDacl === false
      && metadata.daclProtected === true
      && metadata.broadAccess === false
      && metadata.nonOwnerAllow === false
      && metadata.unrecognizedAce === false
      && metadata.finalPathResolved === true;
  } catch {
    valid = false;
  }
  if (!valid) fail("security_policy");
  const identity = exactIdentity(metadata.identity);
  return Object.freeze({
    identity,
    isDirectory: metadata.isDirectory,
    isRegularFile: metadata.isRegularFile,
    isReparsePoint: false,
    ownerMatches: true,
    nullDacl: false,
    daclProtected: true,
    broadAccess: false,
    nonOwnerAllow: false,
    unrecognizedAce: false,
    finalPathResolved: true,
  });
}

function boundedBytes(data, maximumBytes) {
  if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
    fail("invalid_result");
  }
  let normalized;
  try {
    normalized = Buffer.from(data);
  } catch {
    fail("invalid_result");
  }
  if (normalized.byteLength < 1 || normalized.byteLength > maximumBytes) {
    fail("too_large");
  }
  return normalized;
}

function validateMaximumBytes(value, maximumBytes) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximumBytes) {
    fail("too_large");
  }
  return value;
}

function validateMaximumEntries(value, maximumEntries) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximumEntries) {
    fail("directory_limit");
  }
  return value;
}

function validateEntry(entry) {
  let valid = false;
  try {
    valid = entry !== null
      && typeof entry === "object"
      && !Array.isArray(entry)
      && typeof entry.name === "string"
      && entry.name.length > 0
      && !entry.name.includes("\\")
      && !entry.name.includes("/")
      && typeof entry.isDirectory === "boolean"
      && typeof entry.isRegularFile === "boolean"
      && entry.isDirectory !== entry.isRegularFile
      && entry.isReparsePoint === false;
  } catch {
    valid = false;
  }
  if (!valid) fail("invalid_result");
  let name;
  try {
    name = canonicalRelativeName(entry.name);
  } catch {
    fail("invalid_result");
  }
  if (name.includes("\\")) fail("invalid_result");
  const identity = exactIdentity(entry.identity, "invalid_result");
  return Object.freeze({
    name,
    identity,
    isDirectory: entry.isDirectory,
    isRegularFile: entry.isRegularFile,
    isReparsePoint: false,
  });
}

function validateSiblingPaths(source, target) {
  const sourceParts = source.split("\\");
  const targetParts = target.split("\\");
  if (sourceParts.length !== targetParts.length
      || sourceParts.length < 1
      || sourceParts.slice(0, -1).some(
        (component, index) => component.toLowerCase() !== targetParts[index].toLowerCase(),
      )
      || sourceParts.at(-1).toLowerCase() === targetParts.at(-1).toLowerCase()) {
    fail("invalid_path");
  }
}

function validateConfiguration(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    fail("invalid_configuration");
  }
  const {
    adapter,
    rootPath,
    maximumFileBytes = WINDOWS_PREPARED_ARTIFACT_STORAGE_MAXIMUM_CONTRIBUTION_BYTES,
    maximumDirectoryEntries = WINDOWS_PREPARED_ARTIFACT_STORAGE_MAXIMUM_DIRECTORY_ENTRIES,
  } = options;
  if (!isWindowsFilesystemAdapter(adapter)) fail("invalid_adapter");
  if (!Number.isSafeInteger(maximumFileBytes)
      || maximumFileBytes < 1
      || maximumFileBytes
        > WINDOWS_PREPARED_ARTIFACT_STORAGE_MAXIMUM_ARTIFACT_BYTES) {
    fail("invalid_configuration");
  }
  if (!Number.isSafeInteger(maximumDirectoryEntries)
      || maximumDirectoryEntries < 1
      || maximumDirectoryEntries
        > WINDOWS_PREPARED_ARTIFACT_STORAGE_MAXIMUM_DIRECTORY_ENTRIES) {
    fail("invalid_configuration");
  }
  return {
    adapter,
    root: canonicalRoot(rootPath),
    maximumFileBytes,
    maximumDirectoryEntries,
  };
}

export function createWindowsPreparedArtifactStorageContext(options = {}) {
  const {
    adapter,
    root,
    maximumFileBytes,
    maximumDirectoryEntries,
  } = validateConfiguration(options);
  let rootIdentity;

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

  function ensureRoot() {
    let ensured;
    try {
      ensured = exactIdentity(adapter.ensureDirectory(root));
    } catch (error) {
      mapNativeFailure(error, "root_unavailable");
    }
    const observed = inspectRoot();
    if (!sameIdentity(ensured, observed)) fail("identity_mismatch");
    return Object.freeze({ path: root, identity: observed });
  }

  function reference(name) {
    const relativeName = canonicalRelativeName(name);
    const expectedRoot = inspectRoot();
    return Object.freeze({
      path: absoluteChildPath(root, relativeName),
      relativeName,
      rootIdentity: expectedRoot,
    });
  }

  function inspect(name) {
    const selected = reference(name);
    let metadata;
    try {
      metadata = adapter.inspectPreparedChild(
        root,
        selected.rootIdentity,
        selected.relativeName,
      );
    } catch (error) {
      mapNativeFailure(error, "unavailable");
    }
    return Object.freeze({
      ...validateChildMetadata(metadata),
      path: selected.path,
      relativePath: selected.relativeName,
    });
  }

  function ensureDirectory(name) {
    const selected = reference(name);
    let identity;
    try {
      identity = exactIdentity(adapter.ensurePreparedDirectory(
        root,
        selected.rootIdentity,
        selected.relativeName,
      ));
    } catch (error) {
      mapNativeFailure(error, "unavailable");
    }
    return Object.freeze({
      path: selected.path,
      relativePath: selected.relativeName,
      identity,
    });
  }

  function enumerateDirectory(name, maximumEntries = maximumDirectoryEntries) {
    const selected = reference(name);
    const limit = validateMaximumEntries(maximumEntries, maximumDirectoryEntries);
    let entries;
    try {
      entries = adapter.enumeratePreparedDirectory(
        root,
        selected.rootIdentity,
        selected.relativeName,
        limit,
      );
    } catch (error) {
      mapNativeFailure(error, "unavailable");
    }
    if (!Array.isArray(entries) || entries.length > limit) fail("invalid_result");
    const names = new Set();
    const normalized = entries.map((entry) => {
      const value = validateEntry(entry);
      const key = value.name.toLowerCase();
      if (names.has(key)) fail("invalid_result");
      names.add(key);
      return value;
    });
    return Object.freeze(normalized);
  }

  function createFile(name, data) {
    const selected = reference(name);
    const bytes = boundedBytes(data, maximumFileBytes);
    let identity;
    try {
      identity = exactIdentity(adapter.createPreparedFile(
        root,
        selected.rootIdentity,
        selected.relativeName,
        bytes,
      ));
    } catch (error) {
      mapNativeFailure(error, "unavailable");
    }
    return Object.freeze({
      path: selected.path,
      relativePath: selected.relativeName,
      bytes: bytes.byteLength,
      identity,
    });
  }

  function readFile(name, maximumBytes = maximumFileBytes) {
    const selected = reference(name);
    const limit = validateMaximumBytes(maximumBytes, maximumFileBytes);
    let result;
    try {
      result = adapter.readPreparedFile(
        root,
        selected.rootIdentity,
        selected.relativeName,
        limit,
      );
    } catch (error) {
      mapNativeFailure(error, "unavailable");
    }
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      fail("invalid_result");
    }
    const data = boundedBytes(result.data, limit);
    const identity = exactIdentity(result.identity, "invalid_result");
    return Object.freeze({
      data,
      bytes: data.byteLength,
      identity,
      path: selected.path,
      relativePath: selected.relativeName,
    });
  }

  function deleteFile(name, expectedIdentity) {
    const selected = reference(name);
    const expected = exactIdentity(expectedIdentity);
    let result;
    try {
      result = adapter.deletePreparedFile(
        root,
        selected.rootIdentity,
        selected.relativeName,
        expected,
      );
    } catch (error) {
      mapNativeFailure(error, "unavailable");
    }
    if (result === null
        || typeof result !== "object"
        || Array.isArray(result)
        || result.deleted !== true) {
      fail("invalid_result");
    }
    const identity = exactIdentity(result.identity, "invalid_result");
    if (!sameIdentity(identity, expected)) fail("identity_mismatch");
    return Object.freeze({
      deleted: true,
      path: selected.path,
      relativePath: selected.relativeName,
      identity,
    });
  }

  function removeDirectory(name, expectedIdentity) {
    const selected = reference(name);
    const expected = exactIdentity(expectedIdentity);
    let result;
    try {
      result = adapter.removePreparedDirectory(
        root,
        selected.rootIdentity,
        selected.relativeName,
        expected,
      );
    } catch (error) {
      mapNativeFailure(error, "unavailable");
    }
    if (result === null
        || typeof result !== "object"
        || Array.isArray(result)
        || result.removed !== true) {
      fail("invalid_result");
    }
    const identity = exactIdentity(result.identity, "invalid_result");
    if (!sameIdentity(identity, expected)) fail("identity_mismatch");
    return Object.freeze({
      removed: true,
      path: selected.path,
      relativePath: selected.relativeName,
      identity,
    });
  }

  function renameDirectory(sourceName, expectedSourceIdentity, targetName) {
    const source = reference(sourceName);
    const target = reference(targetName);
    validateSiblingPaths(source.relativeName, target.relativeName);
    const expectedSource = exactIdentity(expectedSourceIdentity);
    let result;
    try {
      result = adapter.renamePreparedDirectory(
        root,
        source.rootIdentity,
        source.relativeName,
        expectedSource,
        target.relativeName,
      );
    } catch (error) {
      mapNativeFailure(error, "unavailable");
    }
    if (result === null
        || typeof result !== "object"
        || Array.isArray(result)
        || result.renamed !== true) {
      fail("invalid_result");
    }
    const identity = exactIdentity(result.identity, "invalid_result");
    if (!sameIdentity(identity, expectedSource)) fail("identity_mismatch");
    return Object.freeze({
      renamed: true,
      path: target.path,
      relativePath: target.relativeName,
      identity,
    });
  }

  function publishFile(stageName, expectedStageIdentity, targetName) {
    const stage = reference(stageName);
    const target = reference(targetName);
    validateSiblingPaths(stage.relativeName, target.relativeName);
    const expectedStage = exactIdentity(expectedStageIdentity);
    let result;
    try {
      result = adapter.publishPreparedFile(
        root,
        stage.rootIdentity,
        stage.relativeName,
        expectedStage,
        target.relativeName,
      );
    } catch (error) {
      mapNativeFailure(error, "unavailable");
    }
    if (result === null
        || typeof result !== "object"
        || Array.isArray(result)
        || result.published !== true) {
      fail("invalid_result");
    }
    const identity = exactIdentity(result.identity, "invalid_result");
    if (!sameIdentity(identity, expectedStage)) fail("identity_mismatch");
    return Object.freeze({
      published: true,
      path: target.path,
      relativePath: target.relativeName,
      identity,
    });
  }

  const context = Object.freeze({
    contractVersion: WINDOWS_PREPARED_ARTIFACT_STORAGE_CONTRACT_VERSION,
    rootPath: root,
    maximumFileBytes,
    maximumDirectoryEntries,
    productionSafe: WINDOWS_PREPARED_ARTIFACT_STORAGE_PRODUCTION_SAFE,
    readiness: WINDOWS_PREPARED_ARTIFACT_STORAGE_READINESS,
    preparedArtifactSafe: WINDOWS_PREPARED_ARTIFACT_STORAGE_SAFE,
    inspect,
    ensureRoot,
    ensureDirectory,
    enumerateDirectory,
    createFile,
    readFile,
    deleteFile,
    removeDirectory,
    renameDirectory,
    publishFile,
  });
  CONTEXTS.add(context);
  ensureRoot();
  return context;
}
