import { createHash, randomUUID } from "node:crypto";
import { win32 } from "node:path";

import {
  createLocalPreparedContributionContext,
} from "./local-prepared-contribution.js";

export const WINDOWS_PREPARED_CONTRIBUTION_CONTEXT_CONTRACT_VERSION =
  "windows-prepared-contribution-context-v1";
export const WINDOWS_PREPARED_CONTRIBUTION_CONTEXT_READINESS = false;
export const WINDOWS_PREPARED_CONTRIBUTION_CONTEXT_PRODUCTION_SAFE = false;

const CONTEXTS = new WeakSet();
const DIRECTORY_HANDLES = new WeakMap();
const MAX_PATH_LENGTH = 32_767;
const WINDOWS_STORAGE_ERROR_PREFIX =
  "windows_prepared_artifact_storage_";

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(createError, code) {
  const factory = requireFunction(createError, "createError");
  let error;
  try {
    error = Reflect.apply(factory, undefined, [code]);
  } catch {
    throw new TypeError("createError must return an Error");
  }
  if (!(error instanceof Error)) {
    throw new TypeError("createError must return an Error");
  }
  throw error;
}

function fixedContextError(code) {
  const error = new Error("Windows prepared contribution operation failed");
  error.code = `windows_prepared_contribution_${code}`;
  return error;
}

function storageErrorCode(error, isStorageError) {
  if (!brandedStorageError(error, isStorageError)) return null;
  if (typeof error.code !== "string"
      || !error.code.startsWith(WINDOWS_STORAGE_ERROR_PREFIX)) {
    return null;
  }
  return error.code.slice(WINDOWS_STORAGE_ERROR_PREFIX.length);
}

function brandedStorageError(error, isStorageError) {
  try {
    return Reflect.apply(isStorageError, undefined, [error]) === true;
  } catch {
    return false;
  }
}

function mapStorageError(error, createError, fallback, isStorageError) {
  const code = storageErrorCode(error, isStorageError);
  const mapped = {
    invalid_configuration: "directory_invalid",
    invalid_adapter: "directory_invalid",
    invalid_root: fallback,
    invalid_path: fallback,
    path_escape: fallback,
    invalid_identity: fallback,
    security_policy: fallback,
    invalid_result: fallback,
    root_unavailable: fallback,
    missing: fallback,
    already_exists: "publication_invalid",
    identity_mismatch: fallback,
    too_large: fallback,
    directory_limit: fallback,
    directory_not_empty: fallback,
    unavailable: fallback,
  }[code] ?? fallback;
  fail(createError, mapped);
}

function canonicalRoot(value) {
  if (typeof value !== "string"
      || value.length < 4
      || value.length > MAX_PATH_LENGTH
      || value.includes("\0")) {
    throw new TypeError("Windows prepared contribution storage root is invalid");
  }
  const raw = value.replaceAll("/", "\\");
  if (raw.split("\\").some((component) =>
    component === "." || component === "..")) {
    throw new TypeError("Windows prepared contribution storage root is invalid");
  }
  const normalized = win32.normalize(raw);
  if (!win32.isAbsolute(normalized)
      || !/^(?:\\\\\?\\)?[A-Za-z]:\\/u.test(normalized)) {
    throw new TypeError("Windows prepared contribution storage root is invalid");
  }
  const trimmed = normalized.endsWith("\\")
    ? normalized.slice(0, -1)
    : normalized;
  if (trimmed.length < 4) {
    throw new TypeError("Windows prepared contribution storage root is invalid");
  }
  return trimmed;
}

function canonicalDirectoryPath(root, value) {
  if (typeof value !== "string"
      || value.length < 1
      || value.length > MAX_PATH_LENGTH
      || value.includes("\0")) {
    throw new TypeError("Windows prepared contribution directory is invalid");
  }
  const raw = value.replaceAll("/", "\\");
  if (raw.split("\\").some((component) =>
    component === "." || component === "..")) {
    throw new TypeError("Windows prepared contribution directory is invalid");
  }
  const normalized = win32.normalize(raw);
  const prefix = `${root}\\`.toLowerCase();
  if (normalized.toLowerCase() === root.toLowerCase()
      || !normalized.toLowerCase().startsWith(prefix)
      || normalized.length <= prefix.length
      || normalized.length > MAX_PATH_LENGTH) {
    throw new TypeError("Windows prepared contribution directory is invalid");
  }
  const relative = normalized.slice(prefix.length);
  if (relative.split("\\").some((component) =>
    component === "" || component === "." || component === "..")) {
    throw new TypeError("Windows prepared contribution directory is invalid");
  }
  return Object.freeze({
    absolute: normalized,
    relative,
  });
}

function handleFor(value, storage) {
  if (!isObject(value) || DIRECTORY_HANDLES.get(value) !== storage) {
    throw new TypeError("Windows prepared contribution directory handle is invalid");
  }
  return value;
}

function validateBasename(name) {
  if (typeof name !== "string"
      || name.length < 1
      || name.length > MAX_PATH_LENGTH
      || name.includes("\0")
      || name.includes("\\")
      || name.includes("/")
      || name === "."
      || name === "..") {
    throw new TypeError("Windows prepared contribution basename is invalid");
  }
  return name;
}

function fileRelativePath(directory, name, storage) {
  const handle = handleFor(directory, storage);
  const basename = validateBasename(name);
  const relative = win32.join(handle.relative, basename);
  if (!relative.toLowerCase().startsWith(`${handle.relative.toLowerCase()}\\`)) {
    throw new TypeError("Windows prepared contribution file path is invalid");
  }
  return relative;
}

function sameIdentity(left, right) {
  return isObject(left)
    && isObject(right)
    && left.volumeSerialNumber === right.volumeSerialNumber
    && left.fileId === right.fileId
    && left.linkCount === right.linkCount;
}

function defaultSha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function copyBytes(value, createError, code = "file_invalid") {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    fail(createError, code);
  }
  let bytes;
  try {
    bytes = new Uint8Array(value);
  } catch {
    fail(createError, code);
  }
  if (bytes.byteLength < 1) fail(createError, code);
  return bytes;
}

function validateStorageResult(result, createError, code) {
  if (!isObject(result)) fail(createError, code);
  return result;
}

function createStoragePorts({ storage, root, uuid, isStorageError }) {
  function currentDirectoryHandle(handle, createError) {
    let inspected;
    try {
      inspected = storage.inspect(handle.relative);
    } catch (error) {
      mapStorageError(error, createError, "directory_invalid", isStorageError);
    }
    if (!inspected?.isDirectory
        || inspected.isReparsePoint !== false
        || !sameIdentity(inspected.identity, handle.identity)) {
      fail(createError, "directory_invalid");
    }
    return handle;
  }

  function canonicalDirectory(directory, { createError } = {}) {
    const failures = requireFunction(createError, "createError");
    if (isObject(directory) && DIRECTORY_HANDLES.get(directory) === storage) {
      return currentDirectoryHandle(directory, failures);
    }
    let selected;
    try {
      selected = canonicalDirectoryPath(root, directory);
    } catch {
      fail(failures, "directory_invalid");
    }
    let inspected;
    try {
      inspected = storage.inspect(selected.relative);
    } catch (error) {
      mapStorageError(error, failures, "directory_invalid", isStorageError);
    }
    if (!inspected?.isDirectory || inspected.isReparsePoint !== false) {
      fail(failures, "directory_invalid");
    }
    const handle = Object.freeze({
      absolute: selected.absolute,
      relative: selected.relative,
      identity: inspected.identity,
    });
    DIRECTORY_HANDLES.set(handle, storage);
    return handle;
  }

  function resolveDirectory(directory, createError) {
    if (isObject(directory) && DIRECTORY_HANDLES.get(directory) === storage) {
      return currentDirectoryHandle(directory, createError);
    }
    return canonicalDirectory(directory, { createError });
  }

  async function readOwnerOnlyFile({
    directory,
    name,
    maximumBytes,
    createError,
    missingCode = "file_missing",
    changedCode = "file_changed",
  } = {}) {
    const failures = requireFunction(createError, "createError");
    const handle = resolveDirectory(directory, failures);
    let result;
    try {
      result = storage.readFile(
        fileRelativePath(handle, name, storage),
        maximumBytes,
      );
    } catch (error) {
      const code = storageErrorCode(error, isStorageError);
      if (code === "missing") fail(failures, missingCode);
      if (code === "identity_mismatch") fail(failures, changedCode);
      mapStorageError(error, failures, changedCode, isStorageError);
    }
    const checked = validateStorageResult(result, failures, changedCode);
    const bytes = copyBytes(checked.data, failures, changedCode);
    if (checked.bytes !== bytes.byteLength) {
      bytes.fill(0);
      fail(failures, changedCode);
    }
    return bytes;
  }

  async function readDirectoryEntries({
    directory,
    maximumEntries,
    createError,
    code = "directory_invalid",
  } = {}) {
    const failures = requireFunction(createError, "createError");
    const handle = resolveDirectory(directory, failures);
    let entries;
    try {
      entries = storage.enumerateDirectory(handle.relative, maximumEntries);
    } catch {
      // Do not leak native or platform-specific diagnostics through this
      // reviewed application boundary.
      fail(failures, code);
    }
    if (!Array.isArray(entries) || entries.some((entry) =>
      !isObject(entry)
        || typeof entry.name !== "string"
        || entry.name.length < 1
        || entry.name.includes("\\")
        || entry.name.includes("/"))) {
      fail(failures, code);
    }
    return entries.map((entry) => entry.name);
  }

  async function publishOwnerOnlyFile({
    directory,
    name,
    content,
    maximumBytes,
    createError,
    failpoint = async () => {},
  } = {}) {
    const failures = requireFunction(createError, "createError");
    requireFunction(failpoint, "failpoint");
    const handle = resolveDirectory(directory, failures);
    const bytes = copyBytes(content, failures, "publication_invalid");
    if (bytes.byteLength > maximumBytes) {
      bytes.fill(0);
      fail(failures, "publication_invalid");
    }
    let result;
    try {
      result = storage.createFile(
        fileRelativePath(handle, name, storage),
        bytes,
      );
    } catch (error) {
      bytes.fill(0);
      mapStorageError(error, failures, "publication_invalid", isStorageError);
    }
    bytes.fill(0);
    const checked = validateStorageResult(result, failures, "publication_invalid");
    if (checked.bytes !== content.byteLength) {
      fail(failures, "publication_invalid");
    }
    await failpoint("after_file_sync");
    return Object.freeze({
      basename: name,
      bytes: checked.bytes,
    });
  }

  async function publishManifest({
    directory,
    manifestBasename,
    content,
    maximumBytes,
    createError,
    failpoint = async () => {},
  } = {}) {
    const failures = requireFunction(createError, "createError");
    requireFunction(failpoint, "failpoint");
    const handle = resolveDirectory(directory, failures);
    const bytes = copyBytes(content, failures, "publication_invalid");
    if (bytes.byteLength > maximumBytes) {
      bytes.fill(0);
      fail(failures, "publication_invalid");
    }
    let token;
    try {
      token = uuid();
    } catch {
      bytes.fill(0);
      fail(failures, "publication_invalid");
    }
    if (typeof token !== "string" || token.length < 1) {
      bytes.fill(0);
      fail(failures, "publication_invalid");
    }
    const stageName = `.prepared-contribution-set.${token}.stage`;
    let stage;
    try {
      stage = storage.createFile(
        fileRelativePath(handle, stageName, storage),
        bytes,
      );
    } catch (error) {
      bytes.fill(0);
      mapStorageError(error, failures, "publication_invalid", isStorageError);
    }
    bytes.fill(0);
    const checked = validateStorageResult(stage, failures, "publication_invalid");
    // Preserve the staged bytes when an interruption occurs.  A process crash
    // cannot run cleanup, so the outer attempt-directory state machine owns
    // removing abandoned staging evidence before a retry.  Until it does,
    // verification fails closed on the unexpected no-clobber stage entry.
    await failpoint("after_manifest_stage");
    try {
      const published = storage.publishFile(
        fileRelativePath(handle, stageName, storage),
        checked.identity,
        fileRelativePath(handle, manifestBasename, storage),
      );
      const committed = validateStorageResult(
        published,
        failures,
        "publication_invalid",
      );
      if (committed.published !== true
          || committed.identity?.fileId !== checked.identity?.fileId
          || committed.identity?.volumeSerialNumber
            !== checked.identity?.volumeSerialNumber
          || committed.identity?.linkCount !== checked.identity?.linkCount) {
        fail(failures, "publication_invalid");
      }
    } catch (error) {
      if (error instanceof Error
          && !brandedStorageError(error, isStorageError)) {
        throw error;
      }
      mapStorageError(error, failures, "publication_invalid", isStorageError);
    }
    await failpoint("after_manifest_commit");
    return Object.freeze({
      basename: manifestBasename,
      bytes: checked.bytes,
    });
  }

  return Object.freeze({
    canonicalDirectory,
    publishManifest,
    publishOwnerOnlyFile,
    readDirectoryEntries,
    readOwnerOnlyFile,
  });
}

/**
 * Compose the reviewed prepared-contribution application contract over one
 * branded Windows storage root.  `storage.rootPath` is the protected parent;
 * every supplied directory must be a direct or nested child beneath it.  The
 * native context owns root identity and all file operations; this module does
 * not import node:fs and never offers a POSIX fallback.
 */
export function createWindowsPreparedContributionContext({
  storage,
  isStorage,
  isStorageError,
  sha256Hex = defaultSha256Hex,
  uuid: configuredUuid = randomUUID,
} = {}) {
  const storageValidator = requireFunction(isStorage, "isStorage");
  const storageErrorValidator = requireFunction(
    isStorageError,
    "isStorageError",
  );
  let brandedStorage = false;
  try {
    brandedStorage = Reflect.apply(storageValidator, undefined, [storage]);
  } catch {
    brandedStorage = false;
  }
  if (brandedStorage !== true) {
    throw new TypeError("Windows prepared contribution storage is invalid");
  }
  const root = canonicalRoot(storage.rootPath);
  const digest = requireFunction(sha256Hex, "sha256Hex");
  const createUuid = requireFunction(configuredUuid, "uuid");
  const ports = createStoragePorts({
    storage,
    root,
    uuid: createUuid,
    isStorageError: storageErrorValidator,
  });
  const prepared = createLocalPreparedContributionContext({
    storage: ports,
    sha256Hex: digest,
  });

  function ensureDirectory(directory) {
    let selected;
    try {
      selected = canonicalDirectoryPath(root, directory);
    } catch {
      throw new TypeError("Windows prepared contribution directory is invalid");
    }
    let result;
    try {
      result = storage.ensureDirectory(selected.relative);
    } catch (error) {
      mapStorageError(
        error,
        (code) => fixedContextError(code),
        "directory_invalid",
        storageErrorValidator,
      );
    }
    if (!result?.identity) {
      throw fixedContextError("directory_invalid");
    }
    try {
      return ports.canonicalDirectory(selected.absolute, {
        createError: (code) => fixedContextError(code),
      });
    } catch (error) {
      if (error?.code?.startsWith("windows_prepared_contribution_")) {
        throw error;
      }
      throw fixedContextError("directory_invalid");
    }
  }

  const context = Object.freeze({
    contractVersion:
      WINDOWS_PREPARED_CONTRIBUTION_CONTEXT_CONTRACT_VERSION,
    rootPath: root,
    readiness: WINDOWS_PREPARED_CONTRIBUTION_CONTEXT_READINESS,
    productionSafe: WINDOWS_PREPARED_CONTRIBUTION_CONTEXT_PRODUCTION_SAFE,
    ensureDirectory,
    ...prepared,
  });
  CONTEXTS.add(context);
  return context;
}

export function isWindowsPreparedContributionContext(value) {
  try {
    return isObject(value) && CONTEXTS.has(value);
  } catch {
    return false;
  }
}
