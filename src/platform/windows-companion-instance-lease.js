import {
  createWindowsFilesystemAdapter,
  isWindowsFilesystemAdapter,
  WINDOWS_FILESYSTEM_COMPANION_INSTANCE_MUTEX_CONTRACT_VERSION,
} from "./windows-filesystem.js";

export const WINDOWS_COMPANION_INSTANCE_MUTEX_CONTRACT_VERSION =
  WINDOWS_FILESYSTEM_COMPANION_INSTANCE_MUTEX_CONTRACT_VERSION;

const CONTEXTS = new WeakSet();
const ERRORS = new WeakSet();
const ERROR_CODES = new Set([
  "invalid_configuration",
  "invalid_adapter",
  "contended",
  "security_policy",
  "unavailable",
  "release_failed",
  "foreign",
]);

export class WindowsCompanionInstanceLeaseError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Windows companion instance lease error code");
    }
    super("Windows companion instance lease operation failed");
    this.name = "WindowsCompanionInstanceLeaseError";
    this.code = `windows_companion_instance_lease_${code}`;
    ERRORS.add(this);
  }
}

export function isWindowsCompanionInstanceLeaseError(error) {
  return Boolean(error
    && ERRORS.has(error)
    && Object.getPrototypeOf(error) === WindowsCompanionInstanceLeaseError.prototype);
}

export function isWindowsCompanionInstanceLeaseContext(context) {
  return Boolean(context && CONTEXTS.has(context));
}

function fail(code) {
  throw new WindowsCompanionInstanceLeaseError(code);
}

function validateAdapter(adapter) {
  let valid = false;
  try {
    valid = isWindowsFilesystemAdapter(adapter)
      && typeof adapter.acquireCompanionInstanceMutex === "function"
      && typeof adapter.releaseCompanionInstanceMutex === "function"
      && adapter.companionInstanceMutexContractVersion
        === WINDOWS_COMPANION_INSTANCE_MUTEX_CONTRACT_VERSION;
  } catch {
    valid = false;
  }
  if (!valid) fail("invalid_adapter");
  return adapter;
}

function nativeErrorCode(error, operation) {
  let code;
  try {
    code = error?.code;
  } catch {
    return operation === "release" ? "release_failed" : "unavailable";
  }
  if (code === "WINDOWS_FILESYSTEM_COMPANION_INSTANCE_MUTEX_CONTENDED") {
    return "contended";
  }
  if (code === "WINDOWS_FILESYSTEM_SECURITY_POLICY") return "security_policy";
  if (code === "WINDOWS_FILESYSTEM_COMPANION_INSTANCE_MUTEX_FOREIGN") {
    return "foreign";
  }
  if (code === "WINDOWS_FILESYSTEM_COMPANION_INSTANCE_MUTEX_RELEASE_FAILED") {
    return "release_failed";
  }
  return operation === "release" ? "release_failed" : "unavailable";
}

/**
 * Create the only Windows single-companion lease boundary.
 *
 * The native adapter owns the fixed per-user mutex name and the ACL.  This
 * context intentionally accepts no name, path, PID, or user-controlled label;
 * callers receive only an opaque lease and the content-free abandoned bit.
 * The context remains development-only until native Windows qualification.
 */
export function createWindowsCompanionInstanceLeaseContext({
  platform = process.platform,
  architecture = process.arch,
  adapter = undefined,
  loadAdapter = createWindowsFilesystemAdapter,
} = {}) {
  if (platform !== "win32" || architecture !== "x64") fail("unavailable");
  if (typeof loadAdapter !== "function") fail("invalid_configuration");
  let nativeAdapter = adapter;
  if (nativeAdapter === undefined) {
    try {
      nativeAdapter = loadAdapter({ platform, architecture });
    } catch {
      fail("unavailable");
    }
  }
  const native = validateAdapter(nativeAdapter);
  const records = new WeakMap();

  function acquire() {
    let result;
    try {
      result = native.acquireCompanionInstanceMutex();
    } catch (error) {
      fail(nativeErrorCode(error, "acquire"));
    }
    let valid = false;
    try {
      valid = result !== null
        && typeof result === "object"
        && !Array.isArray(result)
        && Object.keys(result).sort().join("\0") === "abandoned"
        && typeof result.abandoned === "boolean"
    } catch {
      valid = false;
    }
    if (!valid) fail("unavailable");
    const lease = Object.freeze({ abandoned: result.abandoned });
    records.set(lease, {
      active: true,
      abandoned: result.abandoned,
      nativeLease: result,
    });
    return lease;
  }

  function recordFor(lease) {
    let record;
    try {
      record = records.get(lease);
    } catch {
      fail("foreign");
    }
    if (!record || !record.active) fail("foreign");
    return record;
  }

  function wasAbandoned(lease) {
    return recordFor(lease).abandoned;
  }

  function release(lease) {
    const record = recordFor(lease);
    try {
      native.releaseCompanionInstanceMutex(record.nativeLease);
    } catch (error) {
      // Native release failures invalidate the token.  A later call must not
      // attempt a second release against an already-mutated external.
      record.active = false;
      records.delete(lease);
      fail(nativeErrorCode(error, "release"));
    }
    record.active = false;
    records.delete(lease);
  }

  const context = Object.freeze({
    acquire,
    wasAbandoned,
    release,
    crossProcessSafe: true,
    productionSafe: false,
  });
  CONTEXTS.add(context);
  return context;
}
