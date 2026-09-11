import { timingSafeEqual } from "node:crypto";

import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "./export-identity-keychain.js";
import {
  isLinuxCredentialMutationLeaseContext,
  isLinuxCredentialMutationLeaseError,
  createLinuxCredentialMutationLeaseContext,
} from "./linux-credential-mutation-lease.js";
import {
  isLinuxSecretServiceBindingError,
  linuxSecretServiceBindingEvidence,
  loadLinuxSecretServiceBinding,
  snapshotLinuxSecretServiceBinding,
} from "./linux-secret-service-binding.js";

const SECRET_BYTES = 32;
const STORED_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export const LINUX_SECRET_SERVICE_CAPABILITIES = Object.freeze({
  exportIdentity: EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity,
  accountObservation: EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation,
  claudeSessionPseudonym: EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.claudeSessionPseudonym,
  contributionDevice: EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice,
});

export const LINUX_SECRET_SERVICE_STATUS = Object.freeze({
  qualificationOnly: "qualification_only",
  sessionAvailable: "available",
  sessionAbsent: "absent",
  sessionUnavailable: "unavailable",
  storeLocked: "locked",
  storeDenied: "denied",
});

const ERROR_CODES = new Set([
  "unsupported_platform",
  "unsupported_architecture",
  "invalid_configuration",
  "binding_unavailable",
  "binding_path_invalid",
  "binding_integrity",
  "binding_mutated",
  "binding_invalid",
  "invalid_capability",
  "invalid_secret",
  "stored_value_invalid",
  "session_unavailable",
  "store_unavailable",
  "locked",
  "denied",
  "operation_failed",
  "readback_mismatch",
  "mutation_lease_invalid_configuration",
  "mutation_lease_invalid_capability",
  "mutation_lease_invalid_operation",
  "mutation_lease_required",
  "mutation_lease_contended",
  "mutation_lease_released",
  "mutation_lease_foreign",
  "mutation_lease_mutex_failed",
  "mutation_lease_recovery_required",
]);

const trustedErrors = new WeakSet();

export class LinuxSecretServiceError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Linux Secret Service error code");
    }
    super("Linux Secret Service backend failed");
    this.name = "LinuxSecretServiceError";
    this.code = `linux_secret_service_${code}`;
    trustedErrors.add(this);
  }
}

export function isLinuxSecretServiceError(error) {
  return Boolean(error
    && trustedErrors.has(error)
    && Object.getPrototypeOf(error) === LinuxSecretServiceError.prototype);
}

function fail(code) {
  throw new LinuxSecretServiceError(code);
}

function capabilityPair(capability) {
  if (capability === LINUX_SECRET_SERVICE_CAPABILITIES.exportIdentity) {
    return LINUX_SECRET_SERVICE_CAPABILITIES.exportIdentity;
  }
  if (capability === LINUX_SECRET_SERVICE_CAPABILITIES.accountObservation) {
    return LINUX_SECRET_SERVICE_CAPABILITIES.accountObservation;
  }
  if (capability === LINUX_SECRET_SERVICE_CAPABILITIES.claudeSessionPseudonym) {
    return LINUX_SECRET_SERVICE_CAPABILITIES.claudeSessionPseudonym;
  }
  if (capability === LINUX_SECRET_SERVICE_CAPABILITIES.contributionDevice) {
    return LINUX_SECRET_SERVICE_CAPABILITIES.contributionDevice;
  }
  fail("invalid_capability");
}

function copySecret(secret) {
  let valid = false;
  try {
    valid = Buffer.isBuffer(secret) && secret.byteLength === SECRET_BYTES;
  } catch {
    fail("invalid_secret");
  }
  if (!valid) fail("invalid_secret");
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
      // The fixed error below remains authoritative for hostile values.
    }
    fail(errorCode);
  }
  let decoded;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    fail(errorCode);
  }
  if (decoded.byteLength !== SECRET_BYTES || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    fail(errorCode);
  }
  return decoded;
}

function sameSecret(left, right) {
  return timingSafeEqual(left, right);
}

const LOCKED_CODES = new Set([
  "LINUX_SECRET_SERVICE_LOCKED",
  "SECRET_SERVICE_LOCKED",
  "COLLECTION_LOCKED",
  "org.freedesktop.Secret.Error.IsLocked",
]);
const DENIED_CODES = new Set([
  "LINUX_SECRET_SERVICE_DENIED",
  "SECRET_SERVICE_DENIED",
  "DBUS_ERROR_ACCESS_DENIED",
  "org.freedesktop.DBus.Error.AccessDenied",
  "EACCES",
  "EPERM",
]);
const UNAVAILABLE_CODES = new Set([
  "LINUX_SECRET_SERVICE_UNAVAILABLE",
  "SECRET_SERVICE_UNAVAILABLE",
  "DBUS_SESSION_BUS_UNAVAILABLE",
  "DBUS_ERROR_NO_SERVER",
  "DBUS_ERROR_SERVICE_UNKNOWN",
  "org.freedesktop.DBus.Error.NoServer",
  "org.freedesktop.DBus.Error.ServiceUnknown",
  "ENOENT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTCONN",
]);

/**
 * Default classification uses machine-readable error codes only. In
 * particular, it never parses keytar/libsecret error messages, which may be
 * localized or contain environment-specific details.
 */
export function classifyLinuxSecretServiceFailure(error) {
  let code;
  try {
    code = error?.code;
  } catch {
    return "operation_failed";
  }
  if (LOCKED_CODES.has(code)) return "locked";
  if (DENIED_CODES.has(code)) return "denied";
  if (UNAVAILABLE_CODES.has(code)) return "unavailable";
  return "operation_failed";
}

/**
 * Content-free preflight only. Presence of a session address is necessary,
 * not sufficient; the subsequent keytar operation is what proves that a
 * Secret Service implementation and collection are reachable.
 */
export function linuxSecretServiceSessionPreflight(environment = process.env) {
  let address;
  try {
    address = environment?.DBUS_SESSION_BUS_ADDRESS;
  } catch {
    return "unavailable";
  }
  return typeof address === "string" && address.trim().length > 0
    ? "available"
    : "absent";
}

function bindingErrorCode(error) {
  if (!isLinuxSecretServiceBindingError(error)) return "binding_unavailable";
  let code;
  try {
    code = error.code;
  } catch {
    return "binding_unavailable";
  }
  const prefix = "linux_secret_service_binding_";
  const suffix = typeof code === "string" && code.startsWith(prefix)
    ? code.slice(prefix.length)
    : "binding_unavailable";
  return ERROR_CODES.has(suffix) ? suffix : "binding_unavailable";
}

function leaseErrorCode(error) {
  if (!isLinuxCredentialMutationLeaseError(error)) {
    return "mutation_lease_foreign";
  }
  let code;
  try {
    code = error.code;
  } catch {
    return "mutation_lease_foreign";
  }
  const prefix = "linux_credential_mutation_lease_";
  const suffix = typeof code === "string" && code.startsWith(prefix)
    ? code.slice(prefix.length)
    : "foreign";
  const mapped = `mutation_lease_${suffix}`;
  return ERROR_CODES.has(mapped) ? mapped : "mutation_lease_foreign";
}

function validateLeaseContext(context) {
  let valid = false;
  try {
    valid = isLinuxCredentialMutationLeaseContext(context)
      && typeof context.acquire === "function"
      && typeof context.assertLease === "function"
      && typeof context.release === "function"
      && typeof context.withLease === "function"
      && typeof context.close === "function"
      && typeof context.crossProcessSafe === "boolean"
      && context.productionSafe === false;
  } catch {
    valid = false;
  }
  if (!valid) fail("mutation_lease_invalid_configuration");
  return context;
}

/**
 * Dormant Linux/x64 Secret Service credential backend. It deliberately is not
 * exported through the platform barrel or selected by a production
 * composition root. A future integration must supply a reviewed cross-process
 * mutex and native D-Bus qualification evidence before changing that state.
 */
export function createLinuxSecretServiceBackend(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("invalid_configuration");
  }
  let platform;
  let architecture;
  let binding;
  let loadBinding;
  let sessionProbe;
  let classifyFailure;
  let operationLeaseContext;
  try {
    ({
      platform = process.platform,
      architecture = process.arch,
      binding = undefined,
      loadBinding = loadLinuxSecretServiceBinding,
      sessionProbe = () => linuxSecretServiceSessionPreflight(process.env),
      classifyFailure = classifyLinuxSecretServiceFailure,
      operationLeaseContext = undefined,
    } = options);
  } catch {
    fail("invalid_configuration");
  }
  if (platform !== "linux") fail("unsupported_platform");
  if (architecture !== "x64") fail("unsupported_architecture");
  if (typeof loadBinding !== "function"
      || typeof sessionProbe !== "function"
      || typeof classifyFailure !== "function") {
    fail("invalid_configuration");
  }

  let selectedBinding = binding;
  if (selectedBinding === undefined) {
    try {
      selectedBinding = loadBinding({ platform, architecture });
    } catch (error) {
      fail(bindingErrorCode(error));
    }
  }
  const bindingEvidence = linuxSecretServiceBindingEvidence(selectedBinding);
  let nativeBinding;
  try {
    nativeBinding = snapshotLinuxSecretServiceBinding(selectedBinding);
  } catch (error) {
    fail(bindingErrorCode(error));
  }

  const ownsLeaseContext = operationLeaseContext === undefined;
  let leaseContext;
  try {
    leaseContext = operationLeaseContext === undefined
      ? createLinuxCredentialMutationLeaseContext()
      : validateLeaseContext(operationLeaseContext);
  } catch (error) {
    if (isLinuxSecretServiceError(error)) throw error;
    fail(leaseErrorCode(error));
  }
  let disposed = false;

  function assertOpen() {
    if (disposed) fail("invalid_configuration");
  }

  function classifyNativeFailure(error) {
    let classification;
    try {
      classification = classifyFailure(error);
      if (classification !== null
          && (typeof classification === "object" || typeof classification === "function")
          && typeof classification.then === "function") {
        Promise.resolve(classification).catch(() => {});
        return "operation_failed";
      }
    } catch {
      return "operation_failed";
    }
    if (classification === "locked"
        || classification === "denied"
        || classification === "unavailable"
        || classification === "operation_failed") {
      return classification;
    }
    return "operation_failed";
  }

  async function requireSession() {
    let status;
    try {
      status = await sessionProbe();
    } catch (error) {
      const classification = classifyNativeFailure(error);
      if (classification === "locked") fail("locked");
      if (classification === "denied") fail("denied");
      if (classification === "unavailable") fail("store_unavailable");
      fail("operation_failed");
    }
    if (status === "available") return;
    if (status === "absent") fail("session_unavailable");
    if (status === "unavailable") fail("store_unavailable");
    if (status === "locked") fail("locked");
    if (status === "denied") fail("denied");
    fail("operation_failed");
  }

  async function invoke(method, ...args) {
    await requireSession();
    try {
      return await nativeBinding[method](...args);
    } catch (error) {
      const classification = classifyNativeFailure(error);
      if (classification === "locked") fail("locked");
      if (classification === "denied") fail("denied");
      if (classification === "unavailable") fail("store_unavailable");
      fail("operation_failed");
    }
  }

  async function describe(capability) {
    assertOpen();
    capabilityPair(capability);
    return Object.freeze({
      backend: "linux_secret_service",
      status: "qualification_only",
      platform: "linux",
      architecture: "x64",
      sessionBus: "required",
      bindingTarget: "linux-x64",
      bindingProvenanceVerified: bindingEvidence?.provenanceVerified === true,
      crossProcessSafe: leaseContext.crossProcessSafe,
      crashRecoveryComplete: false,
      productionSafe: false,
    });
  }

  async function withOperationLease(capability, operationOptions, callback) {
    assertOpen();
    if (typeof callback !== "function") {
      fail("mutation_lease_invalid_configuration");
    }
    try {
      return await leaseContext.withLease(capability, operationOptions, callback);
    } catch (error) {
      if (!isLinuxCredentialMutationLeaseError(error)) throw error;
      fail(leaseErrorCode(error));
    }
  }

  function assertMutationLease(capability, operation, lease) {
    try {
      if (leaseContext.assertLease(lease, capability, operation) !== lease) {
        fail("mutation_lease_foreign");
      }
    } catch (error) {
      if (isLinuxSecretServiceError(error)) throw error;
      fail(leaseErrorCode(error));
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
    assertMutationLease(capability, "create", lease);
    let generated = null;
    let existing = null;
    let readback = null;
    try {
      generated = copySecret(generatedSecret);
      existing = await readInternal(capability);
      if (existing !== null) return "existing";
      await invoke("setPassword", pair.service, pair.account, generated.toString("base64url"));
      readback = await readInternal(capability, "readback_mismatch");
      if (readback === null || !sameSecret(readback, generated)) {
        fail("readback_mismatch");
      }
      return "created";
    } finally {
      generated?.fill(0);
      existing?.fill(0);
      readback?.fill(0);
    }
  }

  async function replaceExact(capability, expectedSecret, replacementSecret, lease) {
    assertOpen();
    const pair = capabilityPair(capability);
    assertMutationLease(capability, "replace", lease);
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
      if (readback === null || !sameSecret(readback, replacement)) {
        fail("readback_mismatch");
      }
      return "replaced";
    } finally {
      expected?.fill(0);
      replacement?.fill(0);
      current?.fill(0);
      readback?.fill(0);
    }
  }

  async function deleteExact(capability, expectedSecret, lease) {
    assertOpen();
    const pair = capabilityPair(capability);
    assertMutationLease(capability, "delete", lease);
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
  }

  function close() {
    if (disposed) return;
    if (ownsLeaseContext) {
      try {
        leaseContext.close();
      } catch (error) {
        fail(leaseErrorCode(error));
      }
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
    close,
    crossProcessSafe: leaseContext.crossProcessSafe,
    crashRecoveryComplete: false,
    bindingProvenanceVerified: bindingEvidence?.provenanceVerified === true,
    productionSafe: false,
  });
}
