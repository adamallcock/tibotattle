import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "./export-identity-keychain.js";

const OPERATIONS = new Set(["create", "replace", "delete"]);

export const LINUX_CREDENTIAL_CAPABILITY_OWNERS = Object.freeze({
  exportIdentity: "participant-identity",
  accountObservation: "account-observation",
  claudeSessionPseudonym: "claude-callback",
  contributionDevice: "contribution-device",
});

const CAPABILITY_RECORDS = new Map([
  [EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity, Object.freeze({
    id: 0,
    label: "export_identity",
    owner: LINUX_CREDENTIAL_CAPABILITY_OWNERS.exportIdentity,
  })],
  [EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation, Object.freeze({
    id: 1,
    label: "account_observation",
    owner: LINUX_CREDENTIAL_CAPABILITY_OWNERS.accountObservation,
  })],
  [EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.claudeSessionPseudonym, Object.freeze({
    id: 2,
    label: "claude_callback",
    owner: LINUX_CREDENTIAL_CAPABILITY_OWNERS.claudeSessionPseudonym,
  })],
  [EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice, Object.freeze({
    id: 3,
    label: "contribution_device",
    owner: LINUX_CREDENTIAL_CAPABILITY_OWNERS.contributionDevice,
  })],
]);

const ERROR_CODES = new Set([
  "unsupported_platform",
  "unsupported_architecture",
  "invalid_configuration",
  "invalid_capability",
  "invalid_operation",
  "required",
  "contended",
  "released",
  "foreign",
  "mutex_failed",
  "recovery_required",
]);

const trustedErrors = new WeakSet();
const trustedLeaseContexts = new WeakSet();
const trustedMutexContexts = new WeakSet();

// This registry closes concurrency inside one process even before a reviewed
// cross-process mutex is supplied. It is deliberately not represented as an
// interprocess or production-safety claim.
const ACTIVE_CAPABILITY_LEASES = new Map();

export class LinuxCredentialMutationLeaseError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Linux credential mutation lease error code");
    }
    super("Linux credential mutation lease failed");
    this.name = "LinuxCredentialMutationLeaseError";
    this.code = `linux_credential_mutation_lease_${code}`;
    trustedErrors.add(this);
  }
}

export function isLinuxCredentialMutationLeaseError(error) {
  return Boolean(error
    && trustedErrors.has(error)
    && Object.getPrototypeOf(error) === LinuxCredentialMutationLeaseError.prototype);
}

export function isLinuxCredentialMutationLeaseContext(context) {
  return Boolean(context && trustedLeaseContexts.has(context));
}

function fail(code) {
  throw new LinuxCredentialMutationLeaseError(code);
}

function capabilityRecord(capability) {
  let record;
  try {
    record = CAPABILITY_RECORDS.get(capability);
  } catch {
    fail("invalid_capability");
  }
  if (!record) fail("invalid_capability");
  return record;
}

function operationName(operation) {
  if (typeof operation !== "string" || !OPERATIONS.has(operation)) {
    fail("invalid_operation");
  }
  return operation;
}

function leaseOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("invalid_configuration");
  }
  let keys;
  let operation;
  try {
    keys = Object.keys(options);
    operation = options.operation;
  } catch {
    fail("invalid_configuration");
  }
  if (keys.length !== 1 || keys[0] !== "operation") {
    fail("invalid_configuration");
  }
  return operationName(operation);
}

/**
 * Brand an injected, reviewed cross-process mutex boundary. This module does
 * not implement a lockfile fallback: an O_EXCL file has insufficient stale-
 * owner and abrupt-death semantics for credential mutation.
 *
 * The native binding must synchronously return `{ lease, abandoned }`. An
 * abandoned owner fails closed as `recovery_required`; this foundation has no
 * durable prepared-operation journal from which it could safely infer the
 * prior mutation's result.
 */
export function createLinuxCredentialMutationMutexContext(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("invalid_configuration");
  }
  let platform;
  let architecture;
  let binding;
  try {
    ({
      platform = process.platform,
      architecture = process.arch,
      binding,
    } = options);
  } catch {
    fail("invalid_configuration");
  }
  if (platform !== "linux") fail("unsupported_platform");
  if (architecture !== "x64") fail("unsupported_architecture");

  let acquireCredentialMutex;
  let releaseCredentialMutex;
  let contractVersion;
  let crossProcessSafe;
  try {
    acquireCredentialMutex = binding?.acquireCredentialMutex;
    releaseCredentialMutex = binding?.releaseCredentialMutex;
    contractVersion = binding?.credentialMutexContractVersion;
    crossProcessSafe = binding?.credentialMutexCrossProcessSafe;
  } catch {
    fail("invalid_configuration");
  }
  if (contractVersion !== "linux-credential-mutex-v1"
      || crossProcessSafe !== true
      || typeof acquireCredentialMutex !== "function"
      || typeof releaseCredentialMutex !== "function") {
    fail("invalid_configuration");
  }
  const acquireNative = acquireCredentialMutex.bind(binding);
  const releaseNative = releaseCredentialMutex.bind(binding);

  function acquire(capabilityId) {
    let outcome;
    try {
      outcome = acquireNative(capabilityId);
    } catch (error) {
      let code;
      try {
        code = error?.code;
      } catch {
        code = null;
      }
      if (code === "LINUX_CREDENTIAL_MUTEX_CONTENDED") fail("contended");
      fail("mutex_failed");
    }
    let lease;
    let abandoned;
    try {
      lease = outcome?.lease;
      abandoned = outcome?.abandoned;
      if (outcome !== null
          && (typeof outcome === "object" || typeof outcome === "function")
          && typeof outcome.then === "function") {
        Promise.resolve(outcome).catch(() => {});
        fail("invalid_configuration");
      }
    } catch (error) {
      if (isLinuxCredentialMutationLeaseError(error)) throw error;
      fail("mutex_failed");
    }
    if ((typeof lease !== "object" && typeof lease !== "function")
        || lease === null
        || typeof abandoned !== "boolean") {
      fail("mutex_failed");
    }
    if (abandoned) {
      try {
        release(lease);
      } catch {
        // The conservative recovery error remains authoritative.
      }
      fail("recovery_required");
    }
    return lease;
  }

  function release(lease) {
    let outcome;
    try {
      outcome = releaseNative(lease);
      if (outcome !== null
          && (typeof outcome === "object" || typeof outcome === "function")
          && typeof outcome.then === "function") {
        Promise.resolve(outcome).catch(() => {});
        fail("invalid_configuration");
      }
    } catch (error) {
      if (isLinuxCredentialMutationLeaseError(error)) throw error;
      fail("mutex_failed");
    }
  }

  const context = Object.freeze({
    acquire,
    release,
    crossProcessSafe: true,
    productionSafe: false,
  });
  trustedMutexContexts.add(context);
  return context;
}

/**
 * Create the caller-held lease authority for the four fixed capabilities.
 * Lease objects contain no visible authority fields; only WeakMap identity is
 * accepted, and each lease is bound to one context, capability owner, and
 * mutation operation.
 */
export function createLinuxCredentialMutationLeaseContext(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("invalid_configuration");
  }
  let mutexContext;
  try {
    ({ mutexContext = null } = options);
  } catch {
    fail("invalid_configuration");
  }
  if (mutexContext !== null && !trustedMutexContexts.has(mutexContext)) {
    fail("invalid_configuration");
  }

  const records = new WeakMap();
  let activeLeaseCount = 0;
  let closed = false;

  function assertOpen() {
    if (closed) fail("invalid_configuration");
  }

  function acquire(capability, optionsForLease) {
    assertOpen();
    const capabilityDetails = capabilityRecord(capability);
    const operation = leaseOptions(optionsForLease);
    const registryKey = `${capabilityDetails.owner}\u0000${capabilityDetails.label}`;
    if (ACTIVE_CAPABILITY_LEASES.has(registryKey)) fail("contended");

    let nativeLease = null;
    if (mutexContext !== null) {
      nativeLease = mutexContext.acquire(capabilityDetails.id);
    }

    const lease = Object.freeze(Object.create(null));
    const record = {
      capability,
      capabilityDetails,
      operation,
      registryKey,
      nativeLease,
      active: true,
    };
    records.set(lease, record);
    ACTIVE_CAPABILITY_LEASES.set(registryKey, record);
    activeLeaseCount += 1;
    return lease;
  }

  function recordFor(lease, capability, operation) {
    if (lease === undefined || lease === null) fail("required");
    operationName(operation);
    let record;
    try {
      record = records.get(lease);
    } catch {
      fail("foreign");
    }
    if (!record) fail("foreign");
    if (!record.active) fail("released");
    if (record.capability !== capability || record.operation !== operation) {
      fail("foreign");
    }
    return record;
  }

  function assertLease(lease, capability, operation) {
    assertOpen();
    recordFor(lease, capability, operation);
    return lease;
  }

  function release(lease) {
    assertOpen();
    let record;
    try {
      record = records.get(lease);
    } catch {
      fail("foreign");
    }
    if (!record) fail("foreign");
    if (!record.active) fail("released");

    // Keep the in-process registry poisoned until the native owner confirms
    // release. If that boundary fails, reopening the local gate could let a
    // second caller mutate while the cross-process mutex is still held or in
    // an unknown state. The same lease may be retried, but no new lease can be
    // acquired for this capability in the meantime.
    if (record.nativeLease !== null) {
      mutexContext.release(record.nativeLease);
    }
    record.active = false;
    activeLeaseCount -= 1;
    if (ACTIVE_CAPABILITY_LEASES.get(record.registryKey) === record) {
      ACTIVE_CAPABILITY_LEASES.delete(record.registryKey);
    }
  }

  async function withLease(capability, optionsForLease, callback) {
    if (typeof callback !== "function") fail("invalid_configuration");
    const lease = acquire(capability, optionsForLease);
    let callbackError = null;
    try {
      return await callback(lease);
    } catch (error) {
      callbackError = error;
      throw error;
    } finally {
      try {
        release(lease);
      } catch (error) {
        if (callbackError === null) throw error;
      }
    }
  }

  function close() {
    if (closed) return;
    if (activeLeaseCount !== 0) fail("invalid_configuration");
    closed = true;
  }

  const context = Object.freeze({
    acquire,
    assertLease,
    release,
    withLease,
    close,
    crossProcessSafe: mutexContext !== null,
    productionSafe: false,
  });
  trustedLeaseContexts.add(context);
  return context;
}
