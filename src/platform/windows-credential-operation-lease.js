import { randomUUID } from "node:crypto";

import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "./export-identity-keychain.js";

const LEASE_VERSION = "windows-credential-operation-lease-v1";
const MAX_AUDIT_EVENTS = 256;
const OPERATION_NAMES = new Set(["create", "replace", "delete"]);
const MUTATION_RESULTS = new Set([
  "created",
  "existing",
  "replaced",
  "deleted",
  "missing",
  "conflict",
  "failed",
]);
const RELEASE_RESULTS = new Set(["released", "completed", "failed", "aborted"]);

// These are fixed, non-secret diagnostic labels. They are never accepted as
// caller authority: the exact frozen capability object selects the label.
export const WINDOWS_CREDENTIAL_CAPABILITY_OWNERS = Object.freeze({
  exportIdentity: "participant-identity",
  accountObservation: "account-observation",
  claudeSessionPseudonym: "claude-callback",
  contributionDevice: "contribution-device",
});

const OWNER_FOR_CAPABILITY = new Map([
  [EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity, WINDOWS_CREDENTIAL_CAPABILITY_OWNERS.exportIdentity],
  [EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation, WINDOWS_CREDENTIAL_CAPABILITY_OWNERS.accountObservation],
  [EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.claudeSessionPseudonym, WINDOWS_CREDENTIAL_CAPABILITY_OWNERS.claudeSessionPseudonym],
  [EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice, WINDOWS_CREDENTIAL_CAPABILITY_OWNERS.contributionDevice],
]);
const LABEL_FOR_CAPABILITY = new Map([
  [EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity, "export_identity"],
  [EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation, "account_observation"],
  [EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.claudeSessionPseudonym, "claude_callback"],
  [EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice, "contribution_device"],
]);

// A module-level registry prevents two backend instances in one process from
// concurrently mutating the same capability. It is intentionally not claimed
// to coordinate separate processes; the production Windows implementation must
// replace this with a named kernel primitive before selectors are enabled.
const ACTIVE_CAPABILITY_LEASES = new Map();

const trustedLeaseErrors = new WeakSet();
const trustedLeaseContexts = new WeakSet();

export class WindowsCredentialOperationLeaseError extends Error {
  constructor(code) {
    if (!new Set([
      "invalid_configuration",
      "invalid_owner",
      "invalid_capability",
      "invalid_operation",
      "required",
      "contended",
      "released",
      "foreign",
      "audit_failed",
    ]).has(code)) {
      throw new TypeError("Unknown Windows credential operation lease error code");
    }
    super("Windows Credential Manager operation lease failed");
    this.name = "WindowsCredentialOperationLeaseError";
    this.code = `windows_credential_operation_lease_${code}`;
    trustedLeaseErrors.add(this);
  }
}

export function isWindowsCredentialOperationLeaseError(error) {
  return Boolean(error && trustedLeaseErrors.has(error)
    && Object.getPrototypeOf(error) === WindowsCredentialOperationLeaseError.prototype);
}

export function isWindowsCredentialOperationLeaseContext(context) {
  return Boolean(context && trustedLeaseContexts.has(context));
}

function fail(code) {
  throw new WindowsCredentialOperationLeaseError(code);
}

function capabilityOwner(capability) {
  try {
    return OWNER_FOR_CAPABILITY.get(capability) ?? null;
  } catch {
    fail("invalid_capability");
  }
}

function capabilityLabel(capability) {
  let label;
  try {
    label = LABEL_FOR_CAPABILITY.get(capability) ?? null;
  } catch {
    fail("invalid_capability");
  }
  if (label === null) fail("invalid_capability");
  return label;
}

function validateOptions(options) {
  if (options === undefined) return {};
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    fail("invalid_configuration");
  }
  return options;
}

function validateOperation(operation) {
  if (typeof operation !== "string" || !OPERATION_NAMES.has(operation)) {
    fail("invalid_operation");
  }
  return operation;
}

function safeTimestamp(clock) {
  let value;
  try {
    value = clock();
  } catch {
    fail("invalid_configuration");
  }
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid_configuration");
  return value;
}

function cloneEvent(event) {
  return Object.freeze({ ...event });
}

/**
 * Create the in-process half of the Windows credential mutation lease.
 *
 * The lease is deliberately opaque: callers receive an object whose identity
 * is checked through a WeakMap, so copying its visible fields cannot forge a
 * lease. Every lease is bound to one fixed owner, one fixed capability, and
 * one operation. The audit callback receives only non-secret metadata.
 *
 * This is an integration seam, not the final cross-process lock. A real
 * Windows implementation must replace this qualification-only context with a
 * named mutex or equivalent kernel object. Its audit is synchronous,
 * in-memory, and explicitly non-durable.
 */
export function createWindowsCredentialOperationLeaseContext(options = {}) {
  const configuration = validateOptions(options);
  const {
    audit = null,
    clock = () => Date.now(),
    idFactory = randomUUID,
  } = configuration;
  if (audit !== null && typeof audit !== "function") fail("invalid_configuration");
  if (typeof clock !== "function" || typeof idFactory !== "function") fail("invalid_configuration");

  const leaseRecords = new WeakMap();
  const auditEvents = [];

  function emit(event) {
    const safeEvent = cloneEvent({
      version: LEASE_VERSION,
      at: safeTimestamp(clock),
      ...event,
    });
    if (audit !== null) {
      let result;
      try {
        result = audit(safeEvent);
      } catch {
        fail("audit_failed");
      }
      if (result === false) fail("audit_failed");
      try {
        if (result !== null
          && (typeof result === "object" || typeof result === "function")
          && typeof result.then === "function") {
          Promise.resolve(result).catch(() => {});
          fail("audit_failed");
        }
      } catch (error) {
        if (isWindowsCredentialOperationLeaseError(error)) throw error;
        fail("audit_failed");
      }
    }
    auditEvents.push(safeEvent);
    if (auditEvents.length > MAX_AUDIT_EVENTS) auditEvents.shift();
    return safeEvent;
  }

  function makeLeaseId() {
    let value;
    try {
      value = idFactory();
    } catch {
      fail("invalid_configuration");
    }
    if (typeof value !== "string" || !/^[0-9a-f-]{36}$/iu.test(value)) {
      fail("invalid_configuration");
    }
    return value;
  }

  function acquire(capability, optionsForLease = {}) {
    const configurationForLease = validateOptions(optionsForLease);
    let optionKeys;
    let requestedOperation;
    try {
      optionKeys = Object.keys(configurationForLease);
      requestedOperation = configurationForLease.operation;
    } catch {
      fail("invalid_configuration");
    }
    if (optionKeys.length !== 1 || optionKeys[0] !== "operation") {
      fail("invalid_configuration");
    }
    const owner = capabilityOwner(capability);
    if (owner === null) fail("invalid_capability");
    const operation = validateOperation(requestedOperation);
    const label = capabilityLabel(capability);
    const registryKey = `${owner}\u0000${label}`;
    if (ACTIVE_CAPABILITY_LEASES.has(registryKey)) fail("contended");

    const leaseId = makeLeaseId();
    const lease = Object.freeze({
      version: LEASE_VERSION,
      leaseId,
      owner,
      operation,
    });
    const record = {
      capability,
      capabilityLabel: label,
      owner,
      operation,
      registryKey,
      leaseId,
      active: true,
    };
    leaseRecords.set(lease, record);
    ACTIVE_CAPABILITY_LEASES.set(registryKey, record);
    try {
      emit({ event: "acquired", leaseId, owner, capability: label, operation });
    } catch (error) {
      record.active = false;
      leaseRecords.delete(lease);
      if (ACTIVE_CAPABILITY_LEASES.get(registryKey) === record) {
        ACTIVE_CAPABILITY_LEASES.delete(registryKey);
      }
      throw error;
    }
    return lease;
  }

  function recordFor(lease, capability, operation) {
    let record;
    try {
      record = leaseRecords.get(lease);
    } catch {
      fail("foreign");
    }
    if (!record) fail("foreign");
    if (!record.active) fail("released");
    if (record.capability !== capability) fail("foreign");
    if (record.operation !== operation) fail("foreign");
    return record;
  }

  function assertLease(lease, capability, operation) {
    if (lease === undefined || lease === null) fail("required");
    validateOperation(operation);
    recordFor(lease, capability, operation);
    return lease;
  }

  function recordMutation(lease, capability, operation, result) {
    const record = recordFor(lease, capability, operation);
    if (typeof result !== "string" || !MUTATION_RESULTS.has(result)) {
      fail("invalid_configuration");
    }
    emit({
      event: "mutation",
      leaseId: record.leaseId,
      owner: record.owner,
      capability: record.capabilityLabel,
      operation: record.operation,
      result,
    });
  }

  function release(lease, result = "released") {
    let record;
    try {
      record = leaseRecords.get(lease);
    } catch {
      fail("foreign");
    }
    if (!record) fail("foreign");
    if (!record.active) fail("released");
    if (typeof result !== "string" || !RELEASE_RESULTS.has(result)) {
      fail("invalid_configuration");
    }
    let auditError = null;
    try {
      emit({
        event: "released",
        leaseId: record.leaseId,
        owner: record.owner,
        capability: record.capabilityLabel,
        operation: record.operation,
        result,
      });
    } catch (error) {
      auditError = error;
    } finally {
      record.active = false;
      leaseRecords.delete(lease);
      if (ACTIVE_CAPABILITY_LEASES.get(record.registryKey) === record) {
        ACTIVE_CAPABILITY_LEASES.delete(record.registryKey);
      }
    }
    if (auditError !== null) throw auditError;
  }

  async function withLease(capability, optionsForLease, callback) {
    if (typeof callback !== "function") fail("invalid_configuration");
    const lease = acquire(capability, optionsForLease);
    let result = "completed";
    let operationError = null;
    try {
      return await callback(lease);
    } catch (error) {
      result = "failed";
      operationError = error;
      throw error;
    } finally {
      try {
        release(lease, result);
      } catch (error) {
        if (operationError === null) throw error;
      }
    }
  }

  function readAuditEvents() {
    return Object.freeze(auditEvents.map((event) => cloneEvent(event)));
  }

  const context = Object.freeze({
    acquire,
    assertLease,
    recordMutation,
    release,
    withLease,
    readAuditEvents,
    crossProcessSafe: false,
    auditDurable: false,
    productionSafe: false,
  });
  trustedLeaseContexts.add(context);
  return context;
}
