import { randomUUID } from "node:crypto";

import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "./export-identity-keychain.js";
import {
  isWindowsCredentialMutexContext,
  isWindowsCredentialMutexError,
} from "./windows-credential-mutex.js";
import {
  isWindowsCredentialOperationAuditStore,
} from "./windows-credential-operation-audit.js";

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
const MUTEX_ID_FOR_CAPABILITY = new Map([
  [EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity, 0],
  [EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation, 1],
  [EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.claudeSessionPseudonym, 2],
  [EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice, 3],
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
      "mutex_failed",
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
 * This remains a qualification-only integration seam. When supplied, the
 * reviewed native context adds the fixed per-capability Win32 mutex and the
 * reviewed audit store adds durable prepared/settled/recovered records. The
 * small synchronous callback audit remains an optional in-memory diagnostic;
 * production stays disabled until the audit database path itself has native
 * ACL and reparse-point race protection.
 */
export function createWindowsCredentialOperationLeaseContext(options = {}) {
  const configuration = validateOptions(options);
  const {
    audit = null,
    clock = () => Date.now(),
    idFactory = randomUUID,
    mutexContext = null,
    auditStore = null,
    ownsAuditStore = false,
  } = configuration;
  if (audit !== null && typeof audit !== "function") fail("invalid_configuration");
  if (typeof clock !== "function" || typeof idFactory !== "function") fail("invalid_configuration");
  if (mutexContext !== null) {
    let valid = false;
    try {
      valid = isWindowsCredentialMutexContext(mutexContext)
        && typeof mutexContext.acquire === "function"
        && typeof mutexContext.wasAbandoned === "function"
        && typeof mutexContext.release === "function"
        && mutexContext.crossProcessSafe === true
        && mutexContext.productionSafe === false;
    } catch {
      valid = false;
    }
    if (!valid) fail("invalid_configuration");
  }
  if (auditStore !== null) {
    let valid = false;
    try {
      valid = isWindowsCredentialOperationAuditStore(auditStore)
        && typeof auditStore.prepare === "function"
        && typeof auditStore.settle === "function"
        && typeof auditStore.recover === "function"
        && typeof auditStore.read === "function"
        && typeof auditStore.readPending === "function";
    } catch {
      valid = false;
    }
    if (!valid || mutexContext === null) fail("invalid_configuration");
  }
  if (typeof ownsAuditStore !== "boolean"
      || (ownsAuditStore && auditStore === null)) fail("invalid_configuration");

  const leaseRecords = new WeakMap();
  const auditEvents = [];
  let activeLeaseCount = 0;
  let closed = false;

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
    if (closed) fail("invalid_configuration");
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

    let mutexLease = null;
    let abandoned = false;
    if (mutexContext !== null) {
      for (let attempt = 0; attempt < 2 && mutexLease === null; attempt += 1) {
        try {
          mutexLease = mutexContext.acquire(MUTEX_ID_FOR_CAPABILITY.get(capability));
        } catch (error) {
          if (isWindowsCredentialMutexError(error)
              && error.code === "windows_credential_mutex_abandoned"
              && attempt === 0) {
            abandoned = true;
            continue;
          }
          if (isWindowsCredentialMutexError(error)
              && error.code === "windows_credential_mutex_contended") {
            fail("contended");
          }
          fail("mutex_failed");
        }
      }
      if (mutexLease === null) fail("mutex_failed");
    }

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
      mutexLease,
      abandoned,
      durablePrepared: false,
      durableSettled: false,
      durableSettleFailed: false,
    };
    leaseRecords.set(lease, record);
    ACTIVE_CAPABILITY_LEASES.set(registryKey, record);
    activeLeaseCount += 1;
    try {
      if (auditStore !== null) {
        for (const pending of auditStore.readPending()) {
          if (pending.capability !== label) continue;
          auditStore.recover({
            leaseId: pending.leaseId,
            recoveryClass: "unknown_after_crash",
          });
        }
        auditStore.prepare({
          leaseId,
          owner,
          capability: label,
          operation,
        });
        record.durablePrepared = true;
      }
      emit({
        event: "acquired",
        leaseId,
        owner,
        capability: label,
        operation,
        ...(abandoned ? { recovery: "abandoned_owner" } : {}),
      });
    } catch (error) {
      const acquisitionError = isWindowsCredentialOperationLeaseError(error)
        ? error
        : new WindowsCredentialOperationLeaseError("audit_failed");
      if (record.durablePrepared && auditStore !== null) {
        try {
          auditStore.settle({
            leaseId,
            result: "failed",
            failureClass: "audit_failed",
          });
        } catch {
          // The next holder conservatively recovers this prepared row.
        }
      }
      record.active = false;
      activeLeaseCount -= 1;
      leaseRecords.delete(lease);
      if (ACTIVE_CAPABILITY_LEASES.get(registryKey) === record) {
        ACTIVE_CAPABILITY_LEASES.delete(registryKey);
      }
      if (mutexLease !== null) {
        try {
          mutexContext.release(mutexLease);
        } catch {
          // The acquisition error remains authoritative and content-free.
        }
      }
      throw acquisitionError;
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

  function recordMutation(lease, capability, operation, result, failureClass = null) {
    const record = recordFor(lease, capability, operation);
    if (typeof result !== "string" || !MUTATION_RESULTS.has(result)) {
      fail("invalid_configuration");
    }
    if (result !== "failed" && failureClass !== null) fail("invalid_configuration");
    if (auditStore !== null) {
      try {
        auditStore.settle({
          leaseId: record.leaseId,
          result,
          failureClass,
        });
        record.durableSettled = true;
      } catch {
        record.durableSettleFailed = true;
        fail("audit_failed");
      }
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
    let mutexError = null;
    try {
      if (record.durablePrepared
          && !record.durableSettled
          && !record.durableSettleFailed
          && auditStore !== null) {
        try {
          auditStore.settle({
            leaseId: record.leaseId,
            result: "failed",
            failureClass: "operation_failed",
          });
          record.durableSettled = true;
        } catch {
          record.durableSettleFailed = true;
        }
        auditError = new WindowsCredentialOperationLeaseError("audit_failed");
      }
      emit({
        event: "released",
        leaseId: record.leaseId,
        owner: record.owner,
        capability: record.capabilityLabel,
        operation: record.operation,
        result,
      });
    } catch (error) {
      if (auditError === null) auditError = error;
    } finally {
      record.active = false;
      activeLeaseCount -= 1;
      leaseRecords.delete(lease);
      if (ACTIVE_CAPABILITY_LEASES.get(record.registryKey) === record) {
        ACTIVE_CAPABILITY_LEASES.delete(record.registryKey);
      }
      if (record.mutexLease !== null) {
        try {
          mutexContext.release(record.mutexLease);
        } catch {
          mutexError = new WindowsCredentialOperationLeaseError("mutex_failed");
        }
      }
    }
    if (auditError !== null) throw auditError;
    if (mutexError !== null) throw mutexError;
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
    if (closed) fail("invalid_configuration");
    return Object.freeze(auditEvents.map((event) => cloneEvent(event)));
  }

  function readDurableAuditRecords() {
    if (closed) fail("invalid_configuration");
    if (auditStore === null) return Object.freeze([]);
    try {
      return auditStore.read();
    } catch {
      fail("audit_failed");
    }
  }

  function close() {
    if (closed) return;
    if (activeLeaseCount !== 0) fail("invalid_configuration");
    if (ownsAuditStore) {
      try {
        auditStore.close();
      } catch {
        fail("audit_failed");
      }
    }
    closed = true;
  }

  const context = Object.freeze({
    acquire,
    assertLease,
    recordMutation,
    release,
    withLease,
    readAuditEvents,
    readDurableAuditRecords,
    close,
    crossProcessSafe: mutexContext !== null,
    auditDurable: auditStore !== null,
    productionSafe: false,
  });
  trustedLeaseContexts.add(context);
  return context;
}
