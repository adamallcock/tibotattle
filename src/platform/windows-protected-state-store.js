import { randomUUID } from "node:crypto";
import { win32 } from "node:path";

import {
  isWindowsFilesystemAdapter,
  isWindowsFilesystemAlreadyExists,
  isWindowsFilesystemIdentity,
  isWindowsFilesystemNotFound,
} from "./windows-filesystem.js";

/**
 * The small state-store boundary used by future Windows lifecycle consumers.
 *
 * This module deliberately has no Node filesystem fallback.  A caller must
 * provide the repository-branded adapter, and every operation is routed
 * through that adapter.  The adapter is currently unqualified for production
 * use; this store therefore makes no production-safety claim of its own.
 */
export const WINDOWS_PROTECTED_STATE_STORE_CONTRACT_VERSION =
  "windows-protected-state-store-v1";
export const WINDOWS_PROTECTED_STATE_STORE_LEASE_VERSION =
  "windows-protected-state-store-lease-v1";
// Keep the store's bound at or below the native adapter's authenticated
// read ceiling.  The native implementation currently rejects a larger
// request before allocating a result buffer.
export const WINDOWS_PROTECTED_STATE_STORE_DEFAULT_MAX_BYTES = 1024 * 1024;
// These are explicit readiness facts, not claims.  The current native
// adapter does not bind a root identity/handle to each child operation, and
// its read method can materialize more than this store's post-read bound.
export const WINDOWS_PROTECTED_STATE_STORE_ROOT_BINDING_SAFE = false;
export const WINDOWS_PROTECTED_STATE_STORE_NATIVE_READ_BOUNDED = false;

const MAX_PATH_LENGTH = 32_767;
const NO_ERROR = Symbol("no error");
const CONTEXTS = new WeakSet();
const ERRORS = new WeakSet();
const LEASES = new WeakSet();
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
  "missing",
  "already_exists",
  "identity_mismatch",
  "too_large",
  "unavailable",
  "contended",
  "lease_foreign",
  "lease_released",
  "lease_release_failed",
  "audit_failed",
  "stale_recovery_unavailable",
]);

export class WindowsProtectedStateStoreError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Windows protected state store error code");
    }
    super("Windows protected state store operation failed");
    this.name = "WindowsProtectedStateStoreError";
    this.code = `windows_protected_state_store_${code}`;
    ERRORS.add(this);
  }
}

export function isWindowsProtectedStateStoreError(error) {
  return Boolean(error
    && ERRORS.has(error)
    && Object.getPrototypeOf(error) === WindowsProtectedStateStoreError.prototype);
}

export function isWindowsProtectedStateStore(context) {
  return Boolean(context && CONTEXTS.has(context));
}

function fail(code) {
  throw new WindowsProtectedStateStoreError(code);
}

function validateConfiguration(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    fail("invalid_configuration");
  }
  const {
    adapter,
    rootPath,
    maxBytes = WINDOWS_PROTECTED_STATE_STORE_DEFAULT_MAX_BYTES,
    audit = null,
    idFactory = randomUUID,
  } = options;
  if (!isWindowsFilesystemAdapter(adapter)) fail("invalid_adapter");
  if (typeof audit !== "function" && audit !== null) fail("invalid_configuration");
  if (typeof idFactory !== "function") fail("invalid_configuration");
  if (!Number.isSafeInteger(maxBytes)
      || maxBytes < 1
      || maxBytes > WINDOWS_PROTECTED_STATE_STORE_DEFAULT_MAX_BYTES) {
    fail("invalid_configuration");
  }
  return { adapter, rootPath, maxBytes, audit, idFactory };
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
  const base = component.split(".", 1)[0].toUpperCase();
  return RESERVED_DEVICE_NAMES.has(base);
}

function canonicalRoot(rootPath) {
  if (typeof rootPath !== "string"
      || rootPath.length < 4
      || rootPath.length > MAX_PATH_LENGTH
      || rootPath.includes("\0")) {
    fail("invalid_root");
  }
  const rawComponents = rootPath.replaceAll("/", "\\").split("\\");
  if (rawComponents.some((component) => component === "." || component === "..")) {
    fail("invalid_root");
  }
  let normalized;
  try {
    normalized = win32.normalize(rootPath.replaceAll("/", "\\"));
  } catch {
    fail("invalid_root");
  }
  // The native boundary is intentionally local-drive-only.  In particular,
  // do not allow a UNC/share root to become an unexpected trust boundary.
  if (!win32.isAbsolute(normalized)
      || !/^(?:\\\\\?\\)?[A-Za-z]:\\/u.test(normalized)) {
    fail("invalid_root");
  }
  const parsed = win32.parse(normalized);
  if (parsed.root.length >= normalized.length) fail("invalid_root");
  const canonical = normalized.endsWith("\\") ? normalized.slice(0, -1) : normalized;
  const components = canonical.slice(parsed.root.length).split("\\");
  if (components.some((component) => invalidWindowsComponent(component))) {
    fail("invalid_root");
  }
  return canonical;
}

function splitRelativeName(name) {
  if (typeof name !== "string"
      || name.length < 1
      || name.length > MAX_PATH_LENGTH
      || name.includes("\0")
      || win32.isAbsolute(name)
      || /^[A-Za-z]:/u.test(name)
      || name.startsWith("\\\\")) {
    fail("invalid_path");
  }
  const normalizedSeparators = name.replaceAll("/", "\\");
  const components = normalizedSeparators.split("\\");
  if (components.length === 0 || components.some((component) => invalidWindowsComponent(component))) {
    fail("path_escape");
  }
  return components;
}

function canonicalRelativeName(name) {
  return splitRelativeName(name).join("\\");
}

function childPath(root, name) {
  const components = splitRelativeName(name);
  const candidate = win32.normalize(`${root}\\${components.join("\\")}`);
  const prefix = `${root}\\`.toLowerCase();
  if (!candidate.toLowerCase().startsWith(prefix)
      || candidate.length <= prefix.length
      || candidate.length > MAX_PATH_LENGTH) {
    fail("path_escape");
  }
  // A second component check protects against any normalization behavior
  // changing in a future Node release.
  const remainder = candidate.slice(root.length + 1).split("\\");
  if (remainder.some((component) => component === "" || component === "." || component === "..")) {
    fail("path_escape");
  }
  return candidate;
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
  if (!valid) fail("invalid_identity");
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

function validateSecurityMetadata(metadata, directory) {
  let valid = false;
  try {
    valid = metadata !== null
      && typeof metadata === "object"
      && !Array.isArray(metadata)
      && metadata.isDirectory === directory
      && metadata.isRegularFile === !directory
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

function mapAdapterError(error, operation) {
  if (isWindowsProtectedStateStoreError(error)) throw error;
  let code = null;
  try {
    code = error?.code;
  } catch {
    code = null;
  }
  if (isWindowsFilesystemNotFound(error)) fail("missing");
  if (isWindowsFilesystemAlreadyExists(error)) {
    fail(operation === "lease" ? "contended" : "already_exists");
  }
  if (code === "WINDOWS_FILESYSTEM_IDENTITY_MISMATCH") fail("identity_mismatch");
  if (code === "WINDOWS_FILESYSTEM_FILE_TOO_LARGE") fail("too_large");
  if (code === "WINDOWS_FILESYSTEM_REPARSE_POINT"
      || code === "WINDOWS_FILESYSTEM_HARD_LINK"
      || code === "WINDOWS_FILESYSTEM_SECURITY_POLICY") {
    fail("security_policy");
  }
  fail(operation === "release" ? "lease_release_failed" : "unavailable");
}

function toBoundedBytes(data, maxBytes) {
  if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
    fail("invalid_configuration");
  }
  if (data.byteLength > maxBytes) fail("too_large");
  return Buffer.from(data);
}

function stableJsonValue(value, seen = new WeakSet()) {
  if (value === null
      || typeof value === "string"
      || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_configuration");
    return value;
  }
  if (typeof value !== "object") fail("invalid_configuration");
  if (seen.has(value)) fail("invalid_configuration");
  seen.add(value);
  let result;
  try {
    if (Array.isArray(value)) {
      result = value.map((entry) => stableJsonValue(entry, seen));
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) fail("invalid_configuration");
      result = {};
      for (const key of Object.keys(value).sort()) {
        result[key] = stableJsonValue(value[key], seen);
      }
    }
  } catch (error) {
    if (isWindowsProtectedStateStoreError(error)) throw error;
    fail("invalid_configuration");
  } finally {
    seen.delete(value);
  }
  return result;
}

function stableJsonBytes(value, maxBytes) {
  let serialized;
  try {
    serialized = `${JSON.stringify(stableJsonValue(value))}\n`;
  } catch (error) {
    if (isWindowsProtectedStateStoreError(error)) throw error;
    fail("invalid_configuration");
  }
  return toBoundedBytes(Buffer.from(serialized, "utf8"), maxBytes);
}

function parseJson(bytes) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("unavailable");
  }
}

function validatePendingName(name) {
  const basename = win32.basename(name);
  if (!(basename.endsWith(".pending") || basename.startsWith(".pending-"))) {
    fail("invalid_path");
  }
}

function safeAudit(audit, event) {
  if (audit === null) return;
  let result;
  try {
    result = audit(Object.freeze({
      version: WINDOWS_PROTECTED_STATE_STORE_CONTRACT_VERSION,
      ...event,
    }));
  } catch {
    fail("audit_failed");
  }
  if (result === false
      || (result !== null
        && (typeof result === "object" || typeof result === "function")
        && typeof result.then === "function")) {
    fail("audit_failed");
  }
}

function fixedErrorWithCause(code, cause) {
  const failure = new WindowsProtectedStateStoreError(code);
  try {
    Object.defineProperty(failure, "cause", {
      configurable: true,
      enumerable: false,
      value: cause,
      writable: false,
    });
  } catch {
    // Keep the fixed failure authoritative even when a hostile cause object
    // or runtime prevents attaching diagnostic context.
  }
  return failure;
}

function attachReleaseFailure(error, releaseFailure) {
  if (error === null
      || (typeof error !== "object" && typeof error !== "function")) return;
  try {
    const property = Object.hasOwn(error, "cause")
      ? "windowsProtectedStateStoreReleaseError"
      : "cause";
    Object.defineProperty(error, property, {
      configurable: true,
      enumerable: false,
      value: releaseFailure,
      writable: false,
    });
  } catch {
    // A frozen or otherwise hostile callback error keeps precedence without
    // accepting an unsafe mutation.
  }
}

function makeLeaseRecord(path, identity) {
  const lease = Object.freeze({
    version: WINDOWS_PROTECTED_STATE_STORE_LEASE_VERSION,
    path,
    identity,
  });
  LEASES.add(lease);
  return lease;
}

/**
 * Create a Windows-only protected state store over one branded adapter.
 *
 * The store has no stale-lock recovery.  The current inspect metadata has no
 * trustworthy creation/heartbeat timestamp, so removing an existing lock
 * would be an unsafe takeover.  A future native contract must add authenticated
 * owner metadata or a kernel lease before recovery can be enabled.
 */
export function createWindowsProtectedStateStore(options = {}) {
  const configuration = validateConfiguration(options);
  const {
    adapter,
    rootPath,
    maxBytes,
    audit,
    idFactory,
  } = configuration;
  const root = canonicalRoot(rootPath);
  const records = new WeakMap();
  let rootIdentity;

  function inspectRoot() {
    let metadata;
    try {
      metadata = adapter.inspectPath(root);
    } catch (error) {
      mapAdapterError(error, "inspect");
    }
    const identity = validateSecurityMetadata(metadata, true);
    if (rootIdentity !== undefined && !sameIdentity(identity, rootIdentity)) {
      fail("identity_mismatch");
    }
    if (rootIdentity === undefined) rootIdentity = identity;
    return identity;
  }

  function ensureProtectedDirectory() {
    try {
      adapter.ensureDirectory(root);
    } catch (error) {
      mapAdapterError(error, "ensure_directory");
    }
    inspectRoot();
    return rootIdentity;
  }

  function pathFor(name) {
    const relativeName = canonicalRelativeName(name);
    // Revalidate the expected root before each access.  The native protected
    // child primitive receives this exact identity and binds it to the child
    // operation; the readiness flag remains false until that behavior is
    // proven on Windows.
    const expectedRootIdentity = inspectRoot();
    return Object.freeze({
      path: childPath(root, relativeName),
      relativeName,
      rootIdentity: expectedRootIdentity,
    });
  }

  function read(name) {
    const reference = pathFor(name);
    let result;
    try {
      result = adapter.readProtectedChild(
        root,
        reference.rootIdentity,
        reference.relativeName,
        maxBytes,
      );
    } catch (error) {
      mapAdapterError(error, "read");
    }
    let data;
    try {
      data = toBoundedBytes(result?.data, maxBytes);
    } catch (error) {
      if (isWindowsProtectedStateStoreError(error)) throw error;
      fail("unavailable");
    }
    let identity;
    try {
      identity = exactIdentity(result?.identity);
    } catch (error) {
      if (isWindowsProtectedStateStoreError(error)) throw error;
      fail("unavailable");
    }
    return Object.freeze({ data, identity, path: reference.path });
  }

  function create(name, data) {
    const reference = pathFor(name);
    const bytes = toBoundedBytes(data, maxBytes);
    try {
      return Object.freeze({
        path: reference.path,
        identity: exactIdentity(adapter.createProtectedChild(
          root,
          reference.rootIdentity,
          reference.relativeName,
          bytes,
        )),
      });
    } catch (error) {
      mapAdapterError(error, "create");
    }
  }

  function replace(name, expectedIdentity, data) {
    const reference = pathFor(name);
    const expected = exactIdentity(expectedIdentity);
    const bytes = toBoundedBytes(data, maxBytes);
    try {
      return Object.freeze({
        path: reference.path,
        identity: exactIdentity(adapter.replaceProtectedChild(
          root,
          reference.rootIdentity,
          reference.relativeName,
          expected,
          bytes,
        )),
      });
    } catch (error) {
      mapAdapterError(error, "replace");
    }
  }

  function remove(name, expectedIdentity) {
    const reference = pathFor(name);
    const expected = exactIdentity(expectedIdentity);
    try {
      const result = adapter.deleteProtectedChild(
        root,
        reference.rootIdentity,
        reference.relativeName,
        expected,
      );
      if (result?.deleted !== true) fail("unavailable");
      return Object.freeze({
        deleted: true,
        path: reference.path,
        identity: exactIdentity(result.identity),
      });
    } catch (error) {
      mapAdapterError(error, "delete");
    }
  }

  function readJson(name) {
    const result = read(name);
    return Object.freeze({ ...result, value: parseJson(result.data) });
  }

  function createJson(name, value) {
    return create(name, stableJsonBytes(value, maxBytes));
  }

  function replaceJson(name, expectedIdentity, value) {
    return replace(name, expectedIdentity, stableJsonBytes(value, maxBytes));
  }

  function cleanupPending(name, expectedIdentity = undefined) {
    validatePendingName(name);
    let expected = expectedIdentity;
    if (expected === undefined) {
      try {
        expected = read(name).identity;
      } catch (error) {
        if (isWindowsProtectedStateStoreError(error)
            && error.code === "windows_protected_state_store_missing") {
          return Object.freeze({ deleted: false, path: childPath(root, canonicalRelativeName(name)) });
        }
        throw error;
      }
    }
    return remove(name, expected);
  }

  function acquireOperationLease(name) {
    const reference = pathFor(name);
    let candidateId;
    try {
      candidateId = idFactory();
    } catch {
      fail("invalid_configuration");
    }
    if (typeof candidateId !== "string" || candidateId.length < 1 || candidateId.length > 128) {
      fail("invalid_configuration");
    }
    const bytes = Buffer.from(`${WINDOWS_PROTECTED_STATE_STORE_LEASE_VERSION}:${candidateId}\n`, "utf8");
    let identity;
    try {
      identity = exactIdentity(adapter.createProtectedChild(
        root,
        reference.rootIdentity,
        reference.relativeName,
        bytes,
      ));
    } catch (error) {
      mapAdapterError(error, "lease");
    }
    const lease = makeLeaseRecord(reference.path, identity);
    const record = {
      active: true,
      identity,
      path: reference.path,
      relativeName: reference.relativeName,
      rootIdentity: reference.rootIdentity,
    };
    records.set(lease, record);
    try {
      safeAudit(audit, { event: "lease_acquired" });
    } catch (error) {
      // An audit failure must not strand the just-created exclusive lock.
      record.active = false;
      records.delete(lease);
      let cleanupFailed = false;
      try {
        const result = adapter.deleteProtectedChild(
          root,
          reference.rootIdentity,
          reference.relativeName,
          identity,
        );
        cleanupFailed = result?.deleted !== true;
      } catch {
        cleanupFailed = true;
      }
      if (cleanupFailed) {
        // A stranded lock is more severe than the original audit failure.
        // Keep the original fixed audit error as non-enumerable context when
        // the runtime permits it; never attempt stale takeover.
        throw fixedErrorWithCause("lease_release_failed", error);
      }
      throw error;
    }
    return lease;
  }

  function releaseOperationLease(lease) {
    if (!LEASES.has(lease)) fail("lease_foreign");
    const record = records.get(lease);
    if (!record) fail("lease_foreign");
    if (!record.active) fail("lease_released");
    try {
      const result = adapter.deleteProtectedChild(
        root,
        record.rootIdentity,
        record.relativeName,
        record.identity,
      );
      if (result?.deleted !== true) fail("lease_release_failed");
      // Mark inactive only after the exact identity-bound deletion succeeds.
      // A failed release remains retryable, while audit failure after this
      // point cannot cause a second delete.
      record.active = false;
      safeAudit(audit, { event: "lease_released" });
      return Object.freeze({ deleted: true, path: record.path, identity: record.identity });
    } catch (error) {
      if (isWindowsProtectedStateStoreError(error)) {
        if (error.code === "windows_protected_state_store_audit_failed") throw error;
        if (error.code === "windows_protected_state_store_lease_release_failed") throw error;
      }
      mapAdapterError(error, "release");
    }
  }

  async function withOperationLease(name, callback) {
    if (typeof callback !== "function") fail("invalid_configuration");
    const lease = acquireOperationLease(name);
    let callbackError = NO_ERROR;
    try {
      return await callback(lease);
    } catch (error) {
      callbackError = error;
      throw error;
    } finally {
      try {
        releaseOperationLease(lease);
      } catch (releaseError) {
        if (callbackError !== NO_ERROR) {
          attachReleaseFailure(callbackError, releaseError);
          throw callbackError;
        }
        throw releaseError;
      }
    }
  }

  const context = Object.freeze({
    contractVersion: WINDOWS_PROTECTED_STATE_STORE_CONTRACT_VERSION,
    rootPath: root,
    maxBytes,
    productionSafe: false,
    staleRecoveryAvailable: false,
    rootBindingSafe: WINDOWS_PROTECTED_STATE_STORE_ROOT_BINDING_SAFE,
    nativeReadBounded: WINDOWS_PROTECTED_STATE_STORE_NATIVE_READ_BOUNDED,
    ensureProtectedDirectory,
    read,
    create,
    replace,
    delete: remove,
    readJson,
    createJson,
    replaceJson,
    cleanupPending,
    acquireOperationLease,
    releaseOperationLease,
    withOperationLease,
    inspect(name) {
      const reference = pathFor(name);
      let metadata;
      try {
        metadata = adapter.inspectProtectedChild(
          root,
          reference.rootIdentity,
          reference.relativeName,
        );
      } catch (error) {
        mapAdapterError(error, "inspect");
      }
      const identity = validateSecurityMetadata(metadata, false);
      return Object.freeze({ ...metadata, identity, path: reference.path });
    },
  });
  CONTEXTS.add(context);
  ensureProtectedDirectory();
  return context;
}
