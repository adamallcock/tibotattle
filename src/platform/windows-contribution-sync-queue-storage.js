import { win32 } from "node:path";

import {
  isWindowsPreparedArtifactStorage,
  isWindowsPreparedArtifactStorageError,
} from "./windows-prepared-artifact-storage.js";

/**
 * Windows queue storage ports for prepared contribution artifacts.
 *
 * A queue does not get to choose its own native root. The caller supplies one
 * repository-branded prepared-artifact context rooted at the installation
 * state root; every prepared or review path must be a strict descendant of
 * that root and is converted to a root-relative child before the native
 * context is called. This prevents a database/path input from re-rooting the
 * native authority outside the installation state directory.
 *
 * The queue database itself is still opened by the Windows SQLite session in
 * local-contribution-sync-queue-storage.js. This module owns only the
 * prepared/review directory ports. No Node filesystem primitive is available
 * here, so a missing or forged context fails before a path is touched.
 */
export const WINDOWS_CONTRIBUTION_SYNC_QUEUE_STORAGE_CONTRACT_VERSION =
  "windows-contribution-sync-queue-storage-v1";
export const WINDOWS_CONTRIBUTION_SYNC_QUEUE_STORAGE_READINESS = false;
export const WINDOWS_CONTRIBUTION_SYNC_QUEUE_STORAGE_PRODUCTION_SAFE = false;

const MAX_PATH_LENGTH = 32_767;

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function captureErrorFactory(createError) {
  const factory = requireFunction(createError, "createError");
  return (code) => {
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
  };
}

function normalizedWindowsPath(value, code, fail) {
  if (typeof value !== "string"
      || value.length < 4
      || value.length > MAX_PATH_LENGTH
      || value.includes("\0")) {
    fail(code);
  }
  let normalized;
  try {
    normalized = win32.normalize(value.replaceAll("/", "\\"));
  } catch {
    fail(code);
  }
  if (!win32.isAbsolute(normalized)
      || !/^(?:\\\\\?\\)?[A-Za-z]:\\/u.test(normalized)) {
    fail(code);
  }
  const trimmed = normalized.endsWith("\\")
    ? normalized.slice(0, -1)
    : normalized;
  if (trimmed.length < 4) fail(code);
  return trimmed;
}

function sameWindowsPath(left, right) {
  try {
    return win32.normalize(left).toLowerCase()
      === win32.normalize(right).toLowerCase();
  } catch {
    return false;
  }
}

function sameIdentity(left, right) {
  return left?.volumeSerialNumber === right?.volumeSerialNumber
    && left?.fileId === right?.fileId
    && left?.linkCount === right?.linkCount;
}

function isMissingStorageError(error) {
  return isWindowsPreparedArtifactStorageError(error)
    && error.code.endsWith("_missing");
}

function mapStorageError(error, fallback, fail) {
  // Native details and prepared-storage error taxonomies do not cross the
  // queue boundary. The caller supplies the operation's fixed queue code.
  if (!isWindowsPreparedArtifactStorageError(error)) fail(fallback);
  fail(fallback);
}

function exactIdentity(value, fail, code) {
  if (value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || typeof value.volumeSerialNumber !== "string"
      || !/^[0-9a-f]+$/u.test(value.volumeSerialNumber)
      || typeof value.fileId !== "string"
      || !/^[0-9a-f]+$/u.test(value.fileId)
      || value.linkCount !== 1) {
    fail(code);
  }
  return Object.freeze({
    volumeSerialNumber: value.volumeSerialNumber,
    fileId: value.fileId,
    linkCount: 1,
  });
}

function validateStorageContext(storage, fail) {
  let branded = false;
  try {
    branded = isWindowsPreparedArtifactStorage(storage);
  } catch {
    branded = false;
  }
  if (branded !== true) fail("prepared_root_invalid");
  const rootPath = normalizedWindowsPath(
    storage.rootPath,
    "prepared_root_invalid",
    fail,
  );
  for (const name of [
    "ensureRoot",
    "ensureDirectory",
    "inspect",
    "enumerateDirectory",
    "readFile",
    "deleteFile",
    "removeDirectory",
  ]) {
    let method;
    try {
      method = storage[name];
    } catch {
      fail("prepared_root_invalid");
    }
    if (typeof method !== "function") fail("prepared_root_invalid");
  }
  let root;
  try {
    root = storage.ensureRoot();
  } catch (error) {
    mapStorageError(error, "prepared_root_invalid", fail);
  }
  if (root === null
      || typeof root !== "object"
      || Array.isArray(root)
      || !sameWindowsPath(root.path, rootPath)) {
    fail("prepared_root_invalid");
  }
  exactIdentity(root.identity, fail, "prepared_root_invalid");
  return Object.freeze({ storage, rootPath });
}

function descendantRelativePath(stateRoot, requested, code, fail) {
  const absolute = normalizedWindowsPath(requested, code, fail);
  const prefix = `${stateRoot}\\`.toLowerCase();
  if (!absolute.toLowerCase().startsWith(prefix)
      || absolute.length <= prefix.length) {
    fail(code);
  }
  const relative = absolute.slice(prefix.length);
  const parts = relative.split("\\");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    fail(code);
  }
  return Object.freeze({ absolute, relative });
}

function childRelativePath(rootRelative, name, code, fail) {
  if (typeof name !== "string"
      || name.length < 1
      || name.length > MAX_PATH_LENGTH
      || name.includes("\\")
      || name.includes("/")
      || name === "."
      || name === "..") {
    fail(code);
  }
  const relative = win32.join(rootRelative, name);
  if (!relative.toLowerCase().startsWith(`${rootRelative.toLowerCase()}\\`)) {
    fail(code);
  }
  return relative;
}

function validateEntry(entry, fail, code) {
  if (entry === null
      || typeof entry !== "object"
      || Array.isArray(entry)
      || typeof entry.name !== "string"
      || entry.name.length < 1
      || entry.name.includes("\\")
      || entry.name.includes("/")
      || typeof entry.isDirectory !== "boolean"
      || typeof entry.isRegularFile !== "boolean"
      || entry.isDirectory === entry.isRegularFile
      || entry.isReparsePoint !== false) {
    fail(code);
  }
  return Object.freeze({
    name: entry.name,
    identity: exactIdentity(entry.identity, fail, code),
    isDirectory: entry.isDirectory,
    isRegularFile: entry.isRegularFile,
    isReparsePoint: false,
  });
}

/**
 * Build the prepared-artifact ports expected by the application queue.
 * `storage` must be the one branded context rooted at the installation state
 * root. It is intentionally not a factory: queue paths cannot select a new
 * native root or a different filesystem identity.
 */
export function createWindowsContributionSyncQueuePreparedStoragePorts({
  createError,
  storage = null,
  maximumDirectoryEntries = 256,
} = {}) {
  const fail = captureErrorFactory(createError);
  if (!Number.isSafeInteger(maximumDirectoryEntries)
      || maximumDirectoryEntries < 1
      || maximumDirectoryEntries > 256) {
    throw new TypeError(
      "Windows contribution queue prepared storage configuration is invalid",
    );
  }
  const { storage: preparedStorage, rootPath: stateRoot } =
    validateStorageContext(storage, fail);
  const rootIdentities = new Map();

  function rootReference(directory, code) {
    return descendantRelativePath(stateRoot, directory, code, fail);
  }

  function assertRootDirectory(root, code) {
    let inspected;
    try {
      inspected = preparedStorage.inspect(root.relative);
    } catch (error) {
      mapStorageError(error, code, fail);
    }
    if (inspected?.isDirectory !== true
        || inspected.isRegularFile !== false
        || inspected.isReparsePoint !== false) {
      fail(code);
    }
    const identity = exactIdentity(inspected.identity, fail, code);
    const previous = rootIdentities.get(root.relative.toLowerCase());
    if (previous !== undefined && !sameIdentity(previous, identity)) {
      fail(code);
    }
    if (previous === undefined) {
      rootIdentities.set(root.relative.toLowerCase(), identity);
    }
    return Object.freeze({ ...root, identity });
  }

  async function canonicalPreparedRoot(directory) {
    const root = assertRootDirectory(
      rootReference(directory, "prepared_root_invalid"),
      "prepared_root_invalid",
    );
    return root.absolute;
  }

  async function manifestExists(directory, manifestName) {
    const root = assertRootDirectory(
      rootReference(directory, "prepared_root_invalid"),
      "prepared_root_invalid",
    );
    const child = childRelativePath(
      root.relative,
      manifestName,
      "prepared_root_invalid",
      fail,
    );
    let inspected;
    try {
      inspected = preparedStorage.inspect(child);
    } catch (error) {
      if (isMissingStorageError(error)) return false;
      mapStorageError(error, "prepared_root_invalid", fail);
    }
    return inspected?.isRegularFile === true
      && inspected.isDirectory === false
      && inspected.isReparsePoint === false;
  }

  async function readManifest(directory, manifestName, maximumBytes) {
    const root = assertRootDirectory(
      rootReference(directory, "prepared_root_invalid"),
      "prepared_root_invalid",
    );
    const child = childRelativePath(
      root.relative,
      manifestName,
      "prepared_root_invalid",
      fail,
    );
    let result;
    try {
      result = preparedStorage.readFile(child, maximumBytes);
    } catch (error) {
      mapStorageError(error, "prepared_root_invalid", fail);
    }
    if (result === null
        || typeof result !== "object"
        || result.data === undefined
        || result.bytes !== result.data.byteLength) {
      fail("prepared_root_invalid");
    }
    exactIdentity(result.identity, fail, "prepared_root_invalid");
    return Buffer.from(result.data);
  }

  async function preparedSetDirectories({ root, maximumEntries, matches }) {
    if (typeof matches !== "function"
        || !Number.isSafeInteger(maximumEntries)
        || maximumEntries < 1
        || maximumEntries > maximumDirectoryEntries) {
      fail("prepared_root_invalid");
    }
    const rootReferenceValue = assertRootDirectory(
      rootReference(root, "prepared_root_invalid"),
      "prepared_root_invalid",
    );
    let entries;
    try {
      entries = preparedStorage.enumerateDirectory(
        rootReferenceValue.relative,
        maximumEntries,
      );
    } catch (error) {
      mapStorageError(error, "prepared_root_invalid", fail);
    }
    if (!Array.isArray(entries) || entries.length > maximumEntries) {
      fail("prepared_root_invalid");
    }
    const result = [];
    for (const raw of entries) {
      const entry = validateEntry(raw, fail, "prepared_root_invalid");
      if (!entry.isDirectory) continue;
      let selected;
      try {
        selected = Reflect.apply(matches, undefined, [entry.name]);
      } catch {
        fail("prepared_root_invalid");
      }
      if (!selected) continue;
      result.push(Object.freeze({
        name: entry.name,
        directory: win32.join(rootReferenceValue.absolute, entry.name),
        identity: entry.identity,
      }));
    }
    return Object.freeze(result);
  }

  async function prepareRetentionRoot(directory) {
    const root = rootReference(directory, "retirement_invalid");
    let ensured;
    try {
      ensured = preparedStorage.ensureDirectory(root.relative);
    } catch (error) {
      mapStorageError(error, "retirement_invalid", fail);
    }
    exactIdentity(ensured, fail, "retirement_invalid");
    assertRootDirectory(root, "retirement_invalid");
    return root.absolute;
  }

  async function retireFlatDirectory({ root, name, maximumEntries }) {
    if (!Number.isSafeInteger(maximumEntries)
        || maximumEntries < 1
        || maximumEntries > maximumDirectoryEntries) {
      fail("retirement_invalid");
    }
    const rootReferenceValue = assertRootDirectory(
      rootReference(root, "retirement_invalid"),
      "retirement_invalid",
    );
    const directoryRelative = childRelativePath(
      rootReferenceValue.relative,
      name,
      "retirement_invalid",
      fail,
    );
    let directory;
    try {
      directory = preparedStorage.inspect(directoryRelative);
    } catch (error) {
      if (isMissingStorageError(error)) return false;
      mapStorageError(error, "retirement_invalid", fail);
    }
    if (directory?.isDirectory !== true
        || directory.isRegularFile !== false
        || directory.isReparsePoint !== false) {
      fail("retirement_invalid");
    }
    let entries;
    try {
      entries = preparedStorage.enumerateDirectory(
        directoryRelative,
        maximumEntries,
      );
    } catch (error) {
      mapStorageError(error, "retirement_invalid", fail);
    }
    if (!Array.isArray(entries) || entries.length > maximumEntries) {
      fail("retirement_invalid");
    }
    const files = entries.map((raw) =>
      validateEntry(raw, fail, "retirement_invalid"));
    if (files.some((entry) => !entry.isRegularFile
        || entry.isDirectory
        || entry.isReparsePoint)) {
      fail("retirement_invalid");
    }
    for (const entry of files) {
      const child = childRelativePath(
        directoryRelative,
        entry.name,
        "retirement_invalid",
        fail,
      );
      try {
        preparedStorage.deleteFile(child, entry.identity);
      } catch (error) {
        mapStorageError(error, "retirement_invalid", fail);
      }
    }
    try {
      preparedStorage.removeDirectory(directoryRelative, directory.identity);
    } catch (error) {
      if (isMissingStorageError(error)) return false;
      mapStorageError(error, "retirement_invalid", fail);
    }
    return true;
  }

  return Object.freeze({
    contractVersion:
      WINDOWS_CONTRIBUTION_SYNC_QUEUE_STORAGE_CONTRACT_VERSION,
    stateRoot,
    readiness: WINDOWS_CONTRIBUTION_SYNC_QUEUE_STORAGE_READINESS,
    productionSafe: WINDOWS_CONTRIBUTION_SYNC_QUEUE_STORAGE_PRODUCTION_SAFE,
    canonicalPreparedRoot,
    manifestExists,
    readManifest,
    preparedSetDirectories,
    prepareRetentionRoot,
    retireFlatDirectory,
  });
}
