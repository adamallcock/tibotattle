import { timingSafeEqual } from "node:crypto";

import {
  createWindowsFilesystemAdapter,
  isWindowsFilesystemAdapter,
} from "./windows-filesystem.js";
import {
  createWindowsProtectedStateStore,
  isWindowsProtectedStateStoreError,
  isWindowsQualificationProtectedStateStoreFor,
} from "./windows-protected-state-store.js";
import {
  isWindowsQualificationModeContextFor,
} from "./windows-qualification-mode.js";

const SECRET_BYTES = 32;
const STORE_MAXIMUM_BYTES = 128;
const RECORD_NAME = "accountless-installation-credential-v1.bin";
const JOURNAL_NAME = ".accountless-installation-credential-v1.journal";
const NORMAL_JOURNAL = Buffer.from(
  "windows-accountless-installation-credential-v1:normal\n",
  "utf8",
);
const ACTIVE_JOURNAL = Buffer.from(
  "windows-accountless-installation-credential-v1:active\n",
  "utf8",
);

const ERROR_CODES = new Set([
  "unsupported_platform",
  "unsupported_architecture",
  "invalid_configuration",
  "binding_unavailable",
  "binding_invalid",
  "invalid_secret",
  "stored_value_invalid",
  "operation_failed",
  "recovery_required",
  "unavailable",
]);
const trustedErrors = new WeakSet();

/**
 * The source implementation is intentionally qualification-only. A future
 * production selector must make a separate authenticated-binding and physical
 * Windows readiness decision; this fixed backend cannot self-promote it.
 */
export const WINDOWS_ACCOUNTLESS_INSTALLATION_CREDENTIAL_PRODUCTION_SAFE = false;
export const WINDOWS_ACCOUNTLESS_INSTALLATION_CREDENTIAL_CONTRACT_VERSION =
  "windows-accountless-installation-credential-v1";

export class WindowsAccountlessInstallationCredentialError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Windows accountless installation credential error code");
    }
    super("Windows accountless installation credential backend failed");
    this.name = "WindowsAccountlessInstallationCredentialError";
    this.code = `windows_accountless_installation_credential_${code}`;
    trustedErrors.add(this);
  }
}

export function isWindowsAccountlessInstallationCredentialError(error) {
  return Boolean(error
    && trustedErrors.has(error)
    && Object.getPrototypeOf(error)
      === WindowsAccountlessInstallationCredentialError.prototype);
}

function fail(code) {
  throw new WindowsAccountlessInstallationCredentialError(code);
}

function fixedCode(error) {
  try {
    return typeof error?.code === "string" ? error.code : "";
  } catch {
    return "";
  }
}

function copySecret(value, invalidCode = "invalid_secret") {
  let valid = false;
  try {
    valid = Buffer.isBuffer(value) && value.byteLength === SECRET_BYTES;
  } catch {
    fail(invalidCode);
  }
  if (!valid) fail(invalidCode);
  try {
    return Buffer.from(value);
  } catch {
    fail(invalidCode);
  }
}

function sameSecret(left, right) {
  try {
    return Buffer.isBuffer(left)
      && Buffer.isBuffer(right)
      && left.byteLength === SECRET_BYTES
      && right.byteLength === SECRET_BYTES
      && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function exactResultKeys(value, keys) {
  try {
    const observed = Object.keys(value);
    return value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && observed.length === keys.length
      && keys.every((key) => observed.includes(key));
  } catch {
    return false;
  }
}

function snapshotNativeMutex(adapter) {
  let valid = false;
  try {
    valid = isWindowsFilesystemAdapter(adapter)
      && adapter.productionSafe === false
      && adapter.pathWalkRaceSafe === false
      && typeof adapter.acquireAccountlessInstallationCredentialMutex === "function"
      && typeof adapter.releaseAccountlessInstallationCredentialMutex === "function";
  } catch {
    valid = false;
  }
  if (!valid) fail("binding_invalid");
  try {
    return Object.freeze({
      acquire: adapter.acquireAccountlessInstallationCredentialMutex.bind(adapter),
      release: adapter.releaseAccountlessInstallationCredentialMutex.bind(adapter),
    });
  } catch {
    fail("binding_invalid");
  }
}

function stateStoreFailure(error) {
  if (!isWindowsProtectedStateStoreError(error)) return "unavailable";
  const code = fixedCode(error);
  if (code === "windows_protected_state_store_missing") return "missing";
  if (code === "windows_protected_state_store_security_policy"
      || code === "windows_protected_state_store_too_large"
      || code === "windows_protected_state_store_identity_mismatch") {
    return "invalid";
  }
  return "unavailable";
}

function mutexFailure(error, operation) {
  const code = fixedCode(error);
  if (code === "WINDOWS_FILESYSTEM_ACCOUNTLESS_INSTALLATION_CREDENTIAL_MUTEX_CONTENDED") {
    return "unavailable";
  }
  if (operation === "release"
      || code === "WINDOWS_FILESYSTEM_ACCOUNTLESS_INSTALLATION_CREDENTIAL_MUTEX_FOREIGN"
      || code === "WINDOWS_FILESYSTEM_ACCOUNTLESS_INSTALLATION_CREDENTIAL_MUTEX_RELEASE_FAILED") {
    return "recovery_required";
  }
  return "unavailable";
}

function readFixedRecord(store) {
  let result;
  try {
    result = store.read(RECORD_NAME);
  } catch (error) {
    const state = stateStoreFailure(error);
    return Object.freeze({ state });
  }
  let value = null;
  try {
    value = Buffer.from(result.data);
    if (value.byteLength !== SECRET_BYTES) {
      value.fill(0);
      return Object.freeze({ state: "invalid" });
    }
    return Object.freeze({
      state: "present",
      identity: result.identity,
      value,
    });
  } catch {
    value?.fill(0);
    return Object.freeze({ state: "invalid" });
  } finally {
    try {
      result?.data?.fill(0);
    } catch {
      // The copied value or fixed invalid state is authoritative.
    }
  }
}

function readJournal(store) {
  let result;
  try {
    result = store.read(JOURNAL_NAME);
  } catch (error) {
    return Object.freeze({ state: stateStoreFailure(error) });
  }
  let state = "invalid";
  let identity = null;
  try {
    const data = Buffer.from(result.data);
    if (data.equals(NORMAL_JOURNAL)) state = "normal";
    if (data.equals(ACTIVE_JOURNAL)) state = "active";
    identity = result.identity;
    data.fill(0);
  } catch {
    state = "invalid";
  } finally {
    try {
      result?.data?.fill(0);
    } catch {
      // The fixed journal state is authoritative.
    }
  }
  return Object.freeze({ state, identity });
}

function writeJournalState(store, prior, state) {
  const bytes = state === "normal" ? NORMAL_JOURNAL : ACTIVE_JOURNAL;
  try {
    if (prior.state === "missing") {
      store.create(JOURNAL_NAME, bytes);
    } else {
      store.replace(JOURNAL_NAME, prior.identity, bytes);
    }
  } catch {
    return null;
  }
  const verified = readJournal(store);
  return verified.state === state ? verified : null;
}

function latchRecovery(store, journal) {
  if (journal?.state === "active") return true;
  const latched = writeJournalState(store, journal ?? { state: "missing" }, "active");
  return latched?.state === "active";
}

function failRecovery(store, journal) {
  // Report restart-persistent recovery only after the active marker was
  // actually retained. A failed marker write is still an unsafe operation,
  // but must not falsely promise a durable recovery fence to a fresh process.
  if (latchRecovery(store, journal)) fail("recovery_required");
  fail("operation_failed");
}

/**
 * Establish the durable normal marker before the first fixed record exists.
 * If a record precedes that marker, or either marker is malformed/active, the
 * backend preserves recovery rather than accepting an unbound identity.
 */
function requireNormalJournal(store) {
  const journal = readJournal(store);
  if (journal.state === "normal") return journal;
  if (journal.state === "active" || journal.state === "invalid") {
    failRecovery(store, journal);
  }
  if (journal.state === "unavailable") fail("unavailable");

  const before = readFixedRecord(store);
  if (before.state === "unavailable") fail("unavailable");
  if (before.state !== "missing") {
    before.value?.fill(0);
    failRecovery(store, journal);
  }
  const initialized = writeJournalState(store, journal, "normal");
  if (initialized === null) {
    // No credential mutation was attempted. A retry can safely establish the
    // marker later; an ambiguous journal write never clears an active marker.
    fail("unavailable");
  }
  const after = readFixedRecord(store);
  if (after.state === "missing") return initialized;
  if (after.state === "unavailable") fail("unavailable");
  after.value?.fill(0);
  failRecovery(store, initialized);
}

function acquireNativeLease(native) {
  let result;
  try {
    result = native.acquire();
  } catch (error) {
    fail(mutexFailure(error, "acquire"));
  }
  let valid = false;
  try {
    valid = exactResultKeys(result, ["abandoned", "lease"])
      && typeof result.abandoned === "boolean"
      && result.lease !== null
      && (typeof result.lease === "object" || typeof result.lease === "function");
  } catch {
    valid = false;
  }
  if (!valid) fail("operation_failed");
  return result;
}

function runWithNativeLease(store, native, operation) {
  const acquisition = acquireNativeLease(native);
  let thrown = null;
  try {
    if (acquisition.abandoned) {
      const journal = readJournal(store);
      if (latchRecovery(store, journal)) fail("recovery_required");
      // The kernel abandonment has been observed, but without a retained
      // active journal we cannot claim a fresh process is durably fenced.
      fail("operation_failed");
    }
    return operation();
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
    try {
      native.release(acquisition.lease);
    } catch {
      // The native release path may have closed the kernel handle before it
      // reports failure. Re-read and latch the fixed journal through its
      // handle-bound identity before reporting restart-persistent recovery.
      // If that write cannot be verified, return a non-persistent operation
      // failure rather than claiming a fresh process is fenced.
      if (isWindowsAccountlessInstallationCredentialError(thrown)
          && thrown.code.endsWith("_recovery_required")) {
        throw thrown;
      }
      const journal = readJournal(store);
      if (latchRecovery(store, journal)) fail("recovery_required");
      fail("operation_failed");
    }
  }
}

function validateConfiguration(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    fail("invalid_configuration");
  }
  let configuration;
  try {
    configuration = {
      platform: options.platform ?? process.platform,
      architecture: options.architecture ?? process.arch,
      adapter: options.adapter,
      createAdapter: options.createAdapter ?? createWindowsFilesystemAdapter,
      rootPath: options.rootPath,
      windowsQualificationModeContext: options.windowsQualificationModeContext ?? null,
      resourceRoot: options.resourceRoot ?? null,
    };
  } catch {
    fail("invalid_configuration");
  }
  if (configuration.platform !== "win32") fail("unsupported_platform");
  if (configuration.architecture !== "x64") fail("unsupported_architecture");
  if (typeof configuration.createAdapter !== "function"
      || typeof configuration.rootPath !== "string"
      || configuration.rootPath.length === 0) {
    fail("invalid_configuration");
  }
  return configuration;
}

/**
 * Create the fixed, main-process-only Windows accountless upload credential
 * backend. Its credential operations expose no capability or path argument,
 * never use Keytar or Electron safeStorage, and remain qualification-only
 * (`productionSafe: false`) until a later Windows release gate supplies
 * separate evidence.
 */
export function createWindowsAccountlessInstallationCredentialBackend(options = {}) {
  const configuration = validateConfiguration(options);
  let adapter = configuration.adapter;
  if (adapter === undefined) {
    try {
      adapter = configuration.createAdapter({
        platform: configuration.platform,
        architecture: configuration.architecture,
      });
    } catch {
      fail("binding_unavailable");
    }
  }
  const native = snapshotNativeMutex(adapter);

  const context = configuration.windowsQualificationModeContext;
  if (context !== null) {
    let valid = false;
    try {
      valid = configuration.resourceRoot !== null
        && isWindowsQualificationModeContextFor({
          context,
          adapter,
          stateRoot: context.stateRoot,
          resourceRoot: configuration.resourceRoot,
        });
    } catch {
      valid = false;
    }
    if (!valid) fail("invalid_configuration");
  }

  let store;
  try {
    store = createWindowsProtectedStateStore({
      adapter,
      rootPath: configuration.rootPath,
      maxBytes: STORE_MAXIMUM_BYTES,
      windowsQualificationModeContext: context,
      resourceRoot: configuration.resourceRoot,
    });
  } catch (error) {
    if (isWindowsProtectedStateStoreError(error)) {
      const code = fixedCode(error);
      if (code === "windows_protected_state_store_invalid_configuration"
          || code === "windows_protected_state_store_invalid_root"
          || code === "windows_protected_state_store_invalid_adapter") {
        fail("invalid_configuration");
      }
    }
    fail("unavailable");
  }
  if (context !== null) {
    let valid = false;
    try {
      valid = isWindowsQualificationProtectedStateStoreFor({
        store,
        context,
        adapter,
        path: store.rootPath,
        stateRoot: context.stateRoot,
        resourceRoot: configuration.resourceRoot,
      });
    } catch {
      valid = false;
    }
    if (!valid) fail("invalid_configuration");
  }

  return Object.freeze({
    async read() {
      return runWithNativeLease(store, native, () => {
        const journal = requireNormalJournal(store);
        const record = readFixedRecord(store);
        if (record.state === "missing") return null;
        if (record.state === "unavailable") fail("unavailable");
        if (record.state !== "present") failRecovery(store, journal);
        try {
          return Buffer.from(record.value);
        } finally {
          record.value.fill(0);
        }
      });
    },
    async createIfMissing(value) {
      const candidate = copySecret(value);
      try {
        return runWithNativeLease(store, native, () => {
          const journal = requireNormalJournal(store);
          const current = readFixedRecord(store);
          if (current.state === "present") {
            current.value.fill(0);
            return "existing";
          }
          if (current.state === "unavailable") fail("unavailable");
          if (current.state !== "missing") failRecovery(store, journal);

          const active = writeJournalState(store, journal, "active");
          if (active === null) failRecovery(store, journal);
          try {
            store.create(RECORD_NAME, candidate);
          } catch {
            // The native create may have published and flushed a record before
            // reporting failure. Preserve the active journal for recovery.
            failRecovery(store, active);
          }
          const readback = readFixedRecord(store);
          const exact = readback.state === "present" && sameSecret(readback.value, candidate);
          readback.value?.fill(0);
          if (!exact) failRecovery(store, active);
          if (writeJournalState(store, active, "normal") === null) {
            failRecovery(store, active);
          }
          return "created";
        });
      } finally {
        candidate.fill(0);
      }
    },
    async deleteExact(value) {
      const expected = copySecret(value);
      try {
        return runWithNativeLease(store, native, () => {
          const journal = requireNormalJournal(store);
          const current = readFixedRecord(store);
          if (current.state === "missing") return "missing";
          if (current.state === "unavailable") fail("unavailable");
          if (current.state !== "present") failRecovery(store, journal);
          const matches = sameSecret(current.value, expected);
          current.value.fill(0);
          if (!matches) return "mismatch";

          const active = writeJournalState(store, journal, "active");
          if (active === null) failRecovery(store, journal);
          try {
            store.delete(RECORD_NAME, current.identity);
          } catch {
            // An identity mismatch or post-delete failure cannot prove whether
            // the owner credential was removed, so recovery remains latched.
            failRecovery(store, active);
          }
          const readback = readFixedRecord(store);
          if (readback.state !== "missing") {
            readback.value?.fill(0);
            failRecovery(store, active);
          }
          if (writeJournalState(store, active, "normal") === null) {
            failRecovery(store, active);
          }
          return "deleted";
        });
      } finally {
        expected.fill(0);
      }
    },
  });
}
