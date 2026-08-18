import { loadWindowsFilesystemBinding } from "./windows-filesystem.js";

const CAPABILITY_IDS = new Set([0, 1, 2, 3]);
const trustedContexts = new WeakSet();
const trustedErrors = new WeakSet();

export class WindowsCredentialMutexError extends Error {
  constructor(code) {
    if (!new Set([
      "invalid_configuration",
      "invalid_capability",
      "contended",
      "abandoned",
      "security_policy",
      "unavailable",
      "release_failed",
      "foreign",
    ]).has(code)) {
      throw new TypeError("Unknown Windows credential mutex error code");
    }
    super("Windows credential mutex operation failed");
    this.name = "WindowsCredentialMutexError";
    this.code = `windows_credential_mutex_${code}`;
    trustedErrors.add(this);
  }
}

export function isWindowsCredentialMutexError(error) {
  return Boolean(error
    && trustedErrors.has(error)
    && Object.getPrototypeOf(error) === WindowsCredentialMutexError.prototype);
}

export function isWindowsCredentialMutexContext(context) {
  return Boolean(context && trustedContexts.has(context));
}

function fail(code) {
  throw new WindowsCredentialMutexError(code);
}

function validateBinding(binding) {
  let valid = false;
  try {
    valid = binding !== null
      && typeof binding === "object"
      && typeof binding.acquireCredentialMutex === "function"
      && typeof binding.releaseCredentialMutex === "function"
      && binding.credentialMutexContractVersion === "windows-credential-mutex-v1"
      && binding.credentialMutexSafe === true;
  } catch {
    // Hostile injected/native bindings collapse to one fixed boundary error.
  }
  if (!valid) fail("invalid_configuration");
  return binding;
}

function nativeErrorCode(error, operation) {
  let code;
  try {
    code = error?.code;
  } catch {
    return operation === "release" ? "release_failed" : "unavailable";
  }
  if (code === "WINDOWS_FILESYSTEM_CREDENTIAL_MUTEX_INVALID_CAPABILITY") {
    return "invalid_capability";
  }
  if (code === "WINDOWS_FILESYSTEM_CREDENTIAL_MUTEX_CONTENDED") return "contended";
  if (code === "WINDOWS_FILESYSTEM_CREDENTIAL_MUTEX_ABANDONED") return "abandoned";
  if (code === "WINDOWS_FILESYSTEM_SECURITY_POLICY") return "security_policy";
  if (code === "WINDOWS_FILESYSTEM_CREDENTIAL_MUTEX_FOREIGN") return "foreign";
  if (code === "WINDOWS_FILESYSTEM_CREDENTIAL_MUTEX_RELEASE_FAILED") {
    return "release_failed";
  }
  return operation === "release" ? "release_failed" : "unavailable";
}

export function createWindowsCredentialMutexContext({
  platform = process.platform,
  architecture = process.arch,
  binding = undefined,
  loadBinding = loadWindowsFilesystemBinding,
} = {}) {
  if (platform !== "win32" || architecture !== "x64") fail("unavailable");
  if (typeof loadBinding !== "function") fail("invalid_configuration");
  let nativeBinding = binding;
  if (nativeBinding === undefined) {
    try {
      nativeBinding = loadBinding({ platform, architecture });
    } catch {
      fail("unavailable");
    }
  }
  const native = validateBinding(nativeBinding);
  const records = new WeakMap();

  function acquire(capabilityId) {
    if (!Number.isSafeInteger(capabilityId) || !CAPABILITY_IDS.has(capabilityId)) {
      fail("invalid_capability");
    }
    let result;
    try {
      result = native.acquireCredentialMutex(capabilityId);
    } catch (error) {
      fail(nativeErrorCode(error, "acquire"));
    }
    let valid = false;
    try {
      valid = result !== null
        && typeof result === "object"
        && !Array.isArray(result)
        && Object.keys(result).sort().join("\0") === "abandoned\0lease"
        && result.abandoned === false
        && result.lease !== null
        && (typeof result.lease === "object" || typeof result.lease === "function");
    } catch {
      valid = false;
    }
    if (!valid) fail("unavailable");
    const lease = Object.freeze({ abandoned: result.abandoned });
    records.set(lease, {
      active: true,
      capabilityId,
      nativeLease: result.lease,
      abandoned: result.abandoned,
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
      native.releaseCredentialMutex(record.nativeLease);
    } catch (error) {
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
  trustedContexts.add(context);
  return context;
}
