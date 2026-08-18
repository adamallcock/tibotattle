import { timingSafeEqual } from "node:crypto";

import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "./export-identity-keychain.js";
import {
  loadAuditedWindowsCredentialBinding,
} from "./windows-credential-manager-probe.js";
import {
  createWindowsCredentialOperationLeaseContext,
  isWindowsCredentialOperationLeaseContext,
  isWindowsCredentialOperationLeaseError,
} from "./windows-credential-operation-lease.js";
import {
  createWindowsCredentialMutexContext,
} from "./windows-credential-mutex.js";
import {
  createWindowsCredentialOperationAuditStore,
  defaultWindowsCredentialOperationAuditFile,
} from "./windows-credential-operation-audit.js";

const SECRET_BYTES = 32;
const STORED_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const ERROR_CODES = new Set([
  "unsupported_platform",
  "unsupported_architecture",
  "invalid_configuration",
  "binding_unavailable",
  "binding_integrity",
  "invalid_capability",
  "invalid_secret",
  "stored_value_invalid",
  "operation_failed",
  "locked",
  "denied",
  "readback_mismatch",
  "operation_lease_invalid_configuration",
  "operation_lease_invalid_owner",
  "operation_lease_invalid_capability",
  "operation_lease_invalid_operation",
  "operation_lease_required",
  "operation_lease_contended",
  "operation_lease_released",
  "operation_lease_foreign",
  "operation_lease_audit_failed",
  "operation_lease_mutex_failed",
]);

export class WindowsCredentialManagerError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Windows Credential Manager error code");
    }
    super("Windows Credential Manager backend failed");
    this.name = "WindowsCredentialManagerError";
    this.code = `windows_credential_manager_${code}`;
  }
}

function fail(code) {
  throw new WindowsCredentialManagerError(code);
}

function validateBinding(binding) {
  let valid = false;
  try {
    valid = binding !== null && typeof binding === "object"
      && typeof binding.getPassword === "function"
      && typeof binding.setPassword === "function"
      && typeof binding.deletePassword === "function";
  } catch {
    // Collapse hostile or broken native bindings to one fixed configuration error.
  }
  if (!valid) fail("invalid_configuration");
  return binding;
}

function loaderErrorCode(error) {
  let code;
  try {
    code = error?.code;
  } catch {
    return "binding_unavailable";
  }
  const known = {
    WINDOWS_CREDENTIAL_MANAGER_UNSUPPORTED_PLATFORM: "unsupported_platform",
    WINDOWS_CREDENTIAL_MANAGER_UNSUPPORTED_ARCHITECTURE: "unsupported_architecture",
    WINDOWS_CREDENTIAL_MANAGER_INVALID_CONFIGURATION: "invalid_configuration",
    WINDOWS_CREDENTIAL_MANAGER_BINDING_UNAVAILABLE: "binding_unavailable",
    WINDOWS_CREDENTIAL_MANAGER_BINDING_INTEGRITY: "binding_integrity",
  };
  return known[code] ?? "binding_unavailable";
}

function copySecret(secret) {
  let valid = false;
  try {
    valid = Buffer.isBuffer(secret) && secret.byteLength === SECRET_BYTES;
  } catch {
    // A hostile injected Buffer/Proxy must not let its getter escape the
    // credential boundary or retain a caller-controlled error message.
    fail("invalid_secret");
  }
  if (!valid) {
    fail("invalid_secret");
  }
  try {
    return Buffer.from(secret);
  } catch {
    fail("invalid_secret");
  }
}

function decodeStoredSecret(value, errorCode = "stored_value_invalid") {
  if (typeof value !== "string" || !STORED_SECRET_PATTERN.test(value)) {
    try {
      if (Buffer.isBuffer(value)) value.fill(0);
    } catch {
      // The fixed error below is authoritative for hostile native values.
    }
    fail(errorCode);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== SECRET_BYTES || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    fail(errorCode);
  }
  return decoded;
}

function sameSecret(left, right) {
  return timingSafeEqual(left, right);
}

const LOCKED_ERROR_CODES = new Set([
  "ERR_CREDENTIAL_MANAGER_LOCKED",
  "CREDENTIAL_MANAGER_LOCKED",
  "ERROR_LOCK_VIOLATION",
  33,
]);
const DENIED_ERROR_CODES = new Set([
  "ERR_CREDENTIAL_MANAGER_DENIED",
  "CREDENTIAL_MANAGER_DENIED",
  "ERROR_ACCESS_DENIED",
  "EACCES",
  "EPERM",
  5,
]);

function nativeFailureCode(error) {
  let code;
  try {
    code = error?.code;
  } catch {
    return "operation_failed";
  }
  if (LOCKED_ERROR_CODES.has(code)) return "locked";
  if (DENIED_ERROR_CODES.has(code)) return "denied";
  return "operation_failed";
}

function capabilityPair(capability) {
  if (capability === EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity) {
    return EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity;
  }
  if (capability === EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation) {
    return EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation;
  }
  if (capability === EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.claudeSessionPseudonym) {
    return EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.claudeSessionPseudonym;
  }
  if (capability === EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice) {
    return EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice;
  }
  fail("invalid_capability");
}

function leaseErrorCode(error) {
  if (!isWindowsCredentialOperationLeaseError(error)) {
    return "operation_lease_foreign";
  }
  let code;
  try {
    code = error.code;
  } catch {
    return "operation_lease_foreign";
  }
  const prefix = "windows_credential_operation_lease_";
  const suffix = typeof code === "string" && code.startsWith(prefix)
    ? code.slice(prefix.length)
    : "foreign";
  const mapped = `operation_lease_${suffix}`;
  return ERROR_CODES.has(mapped) ? mapped : "operation_lease_foreign";
}

function validateOperationLeaseContext(context) {
  let valid = false;
  try {
    valid = isWindowsCredentialOperationLeaseContext(context)
      && typeof context.acquire === "function"
      && typeof context.assertLease === "function"
      && typeof context.recordMutation === "function"
      && typeof context.release === "function"
      && typeof context.withLease === "function"
      && typeof context.readAuditEvents === "function"
      && typeof context.readDurableAuditRecords === "function"
      && typeof context.close === "function"
      && typeof context.crossProcessSafe === "boolean"
      && typeof context.auditDurable === "boolean"
      && context.productionSafe === false;
  } catch {
    // Hostile injected contexts are configuration failures, not native errors.
  }
  if (!valid) fail("operation_lease_invalid_configuration");
  return context;
}

/**
 * Create the Windows Credential Manager backend used by the four production
 * credential capabilities. The adapter deliberately has the same narrow
 * capability surface as the macOS Keychain backend: callers supply one of the
 * frozen capability objects above, never arbitrary service/account strings.
 *
 * This adapter does not claim compare-and-swap semantics. The participant,
 * account-observation, callback, and contribution callers must hold their
 * existing operation leases around create, replace, and delete transactions.
 */
export function createWindowsCredentialManagerBackend(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("invalid_configuration");
  }
  const {
    platform = process.platform,
    architecture = process.arch,
    binding = undefined,
    loadBinding = loadAuditedWindowsCredentialBinding,
    operationLeaseContext = undefined,
    operationAudit = null,
  } = options;
  if (platform !== "win32") fail("unsupported_platform");
  if (architecture !== "x64") fail("unsupported_architecture");
  if (typeof loadBinding !== "function") fail("invalid_configuration");
  if (operationAudit !== null && typeof operationAudit !== "function") {
    fail("operation_lease_invalid_configuration");
  }

  let selectedBinding = binding;
  if (selectedBinding === undefined) {
    try {
      selectedBinding = loadBinding({ platform, architecture });
    } catch (error) {
      if (error instanceof WindowsCredentialManagerError) throw error;
      fail(loaderErrorCode(error));
    }
  }
  const nativeBinding = validateBinding(selectedBinding);

  const ownsLeaseContext = operationLeaseContext === undefined;
  let leaseContext;
  if (operationLeaseContext === undefined) {
    let ownedAuditStore = null;
    try {
      const injectedNativeBoundary = Object.hasOwn(options, "binding")
        || Object.hasOwn(options, "loadBinding");
      const nativeGuarded = !injectedNativeBoundary
        && platform === process.platform
        && architecture === process.arch;
      let mutexContext = null;
      let auditStore = null;
      if (nativeGuarded) {
        try {
          mutexContext = createWindowsCredentialMutexContext({ platform, architecture });
        } catch {
          fail("operation_lease_mutex_failed");
        }
        try {
          const qualificationStateRoot = process.env.GITHUB_ACTIONS === "true"
            && process.env.USAGE_MONITOR_WINDOWS_QUALIFICATION === "1"
            && typeof process.env.TIBOTATTLE_WINDOWS_QUALIFICATION_STATE_ROOT === "string"
            && process.env.TIBOTATTLE_WINDOWS_QUALIFICATION_STATE_ROOT.length > 0
            ? process.env.TIBOTATTLE_WINDOWS_QUALIFICATION_STATE_ROOT
            : null;
          auditStore = createWindowsCredentialOperationAuditStore({
            filePath: defaultWindowsCredentialOperationAuditFile({
              platform,
              stateRoot: qualificationStateRoot,
            }),
          });
          ownedAuditStore = auditStore;
        } catch {
          fail("operation_lease_audit_failed");
        }
      }
      leaseContext = createWindowsCredentialOperationLeaseContext({
        audit: operationAudit,
        mutexContext,
        auditStore,
        ownsAuditStore: auditStore !== null,
      });
    } catch (error) {
      try {
        ownedAuditStore?.close();
      } catch {
        // The fixed construction failure below remains authoritative.
      }
      if (error instanceof WindowsCredentialManagerError) throw error;
      if (isWindowsCredentialOperationLeaseError(error)) {
        fail(leaseErrorCode(error));
      }
      fail("operation_lease_invalid_configuration");
    }
  } else {
    leaseContext = validateOperationLeaseContext(operationLeaseContext);
  }
  let disposed = false;

  function assertOpen() {
    if (disposed) fail("invalid_configuration");
  }

  async function invoke(method, ...args) {
    try {
      return await nativeBinding[method](...args);
    } catch (error) {
      fail(nativeFailureCode(error));
    }
  }

  async function describe(capability) {
    assertOpen();
    capabilityPair(capability);
    return Object.freeze({
      backend: "windows_credential_manager",
      status: "qualification_only",
      productionSafe: false,
      crossProcessSafe: leaseContext.crossProcessSafe,
      auditDurable: leaseContext.auditDurable,
    });
  }

  async function withOperationLease(capability, operationOptions, callback) {
    assertOpen();
    if (typeof callback !== "function") fail("operation_lease_invalid_configuration");
    try {
      return await leaseContext.withLease(capability, operationOptions, callback);
    } catch (error) {
      if (!isWindowsCredentialOperationLeaseError(error)) throw error;
      fail(leaseErrorCode(error));
    }
  }

  function assertMutationLease(capability, operation, lease) {
    try {
      if (leaseContext.assertLease(lease, capability, operation) !== lease) {
        fail("operation_lease_foreign");
      }
    } catch (error) {
      fail(leaseErrorCode(error));
    }
  }

  async function runMutation(capability, operation, lease, callback) {
    assertMutationLease(capability, operation, lease);
    let outcome = "failed";
    let operationError = null;
    try {
      outcome = await callback();
      return outcome;
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        let failureClass = null;
        if (outcome === "failed") {
          const code = operationError instanceof WindowsCredentialManagerError
            ? operationError.code
            : null;
          failureClass = code === "windows_credential_manager_locked"
            ? "locked"
            : code === "windows_credential_manager_denied"
              ? "denied"
              : code === "windows_credential_manager_readback_mismatch"
                ? "readback_mismatch"
                : "operation_failed";
        }
        leaseContext.recordMutation(
          lease,
          capability,
          operation,
          outcome,
          failureClass,
        );
      } catch (error) {
        // Preserve the native/mutation error if the operation was already
        // failing. A successful mutation must surface an audit failure rather
        // than claim a clean completion without a corresponding event.
        if (operationError === null) fail(leaseErrorCode(error));
      }
    }
  }

  function readAuditEvents() {
    assertOpen();
    try {
      return leaseContext.readAuditEvents();
    } catch {
      fail("operation_lease_invalid_configuration");
    }
  }

  function readDurableAuditRecords() {
    assertOpen();
    try {
      return leaseContext.readDurableAuditRecords();
    } catch (error) {
      if (isWindowsCredentialOperationLeaseError(error)) fail(leaseErrorCode(error));
      fail("operation_lease_audit_failed");
    }
  }

  async function readInternal(capability, invalidCode = "stored_value_invalid") {
    const pair = capabilityPair(capability);
    const stored = await invoke("getPassword", pair.service, pair.account);
    if (stored === null) return null;
    return decodeStoredSecret(stored, invalidCode);
  }

  async function read(capability) {
    assertOpen();
    let secret = null;
    try {
      secret = await readInternal(capability);
      return secret === null ? null : Buffer.from(secret);
    } finally {
      secret?.fill(0);
    }
  }

  async function createIfMissing(capability, generatedSecret, lease) {
    assertOpen();
    const pair = capabilityPair(capability);
    return runMutation(capability, "create", lease, async () => {
      let generated = null;
      let existing = null;
      let readback = null;
      try {
        generated = copySecret(generatedSecret);
        existing = await readInternal(capability);
        if (existing !== null) return "existing";
        await invoke("setPassword", pair.service, pair.account, generated.toString("base64url"));
        readback = await readInternal(capability, "readback_mismatch");
        if (readback === null || !sameSecret(readback, generated)) fail("readback_mismatch");
        return "created";
      } finally {
        generated?.fill(0);
        existing?.fill(0);
        readback?.fill(0);
      }
    });
  }

  async function replaceExact(capability, expectedSecret, replacementSecret, lease) {
    assertOpen();
    const pair = capabilityPair(capability);
    return runMutation(capability, "replace", lease, async () => {
      let expected = null;
      let replacement = null;
      let current = null;
      let readback = null;
      try {
        expected = copySecret(expectedSecret);
        replacement = copySecret(replacementSecret);
        current = await readInternal(capability);
        if (current === null) return "missing";
        if (!sameSecret(current, expected)) return "conflict";
        await invoke("setPassword", pair.service, pair.account, replacement.toString("base64url"));
        readback = await readInternal(capability, "readback_mismatch");
        if (readback === null || !sameSecret(readback, replacement)) fail("readback_mismatch");
        return "replaced";
      } finally {
        expected?.fill(0);
        replacement?.fill(0);
        current?.fill(0);
        readback?.fill(0);
      }
    });
  }

  async function deleteExact(capability, expectedSecret, lease) {
    assertOpen();
    const pair = capabilityPair(capability);
    return runMutation(capability, "delete", lease, async () => {
      let expected = null;
      let current = null;
      let readback = null;
      try {
        expected = copySecret(expectedSecret);
        current = await readInternal(capability);
        if (current === null) return "missing";
        if (!sameSecret(current, expected)) return "conflict";
        await invoke("deletePassword", pair.service, pair.account);
        readback = await readInternal(capability, "readback_mismatch");
        if (readback !== null) fail("readback_mismatch");
        return "deleted";
      } finally {
        expected?.fill(0);
        current?.fill(0);
        readback?.fill(0);
      }
    });
  }

  function close() {
    if (disposed) return;
    if (!ownsLeaseContext) fail("invalid_configuration");
    try {
      leaseContext.close();
    } catch (error) {
      if (isWindowsCredentialOperationLeaseError(error)) fail(leaseErrorCode(error));
      fail("operation_lease_invalid_configuration");
    }
    disposed = true;
  }

  return Object.freeze({
    read,
    createIfMissing,
    replaceExact,
    deleteExact,
    describe,
    withOperationLease,
    readAuditEvents,
    readDurableAuditRecords,
    close,
    crossProcessSafe: leaseContext.crossProcessSafe,
    auditDurable: leaseContext.auditDurable,
    productionSafe: false,
  });
}
