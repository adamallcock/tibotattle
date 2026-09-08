import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "./export-identity-keychain.js";
import {
  WindowsCredentialManagerError,
} from "./windows-credential-manager.js";

const SECRET_BYTES = 32;
const trustedErrors = new WeakSet();
const trustedBackends = new WeakSet();

export const WINDOWS_ACCOUNT_OBSERVATION_CREDENTIAL_INTEGRATION_STATUS = "qualification_only";
export const WINDOWS_ACCOUNT_OBSERVATION_CREDENTIAL_PRODUCTION_SAFE = false;

export class WindowsAccountObservationCredentialError extends Error {
  constructor(code) {
    if (!new Set([
      "unsupported_platform",
      "unsupported_architecture",
      "invalid_configuration",
      "unavailable",
      "locked",
      "denied",
      "recovery_required",
      "stored_value_invalid",
    ]).has(code)) {
      throw new TypeError("Unknown Windows account observation credential error code");
    }
    super("Windows account observation credential is unavailable");
    this.name = "WindowsAccountObservationCredentialError";
    this.code = `windows_account_observation_credential_${code}`;
    trustedErrors.add(this);
  }
}

export function isWindowsAccountObservationCredentialError(error) {
  return Boolean(error
    && trustedErrors.has(error)
    && Object.getPrototypeOf(error) === WindowsAccountObservationCredentialError.prototype);
}

export function isWindowsAccountObservationCredentialBackend(backend) {
  return Boolean(backend
    && trustedBackends.has(backend)
    && Object.getPrototypeOf(backend) === Object.prototype);
}

function fail(code) {
  throw new WindowsAccountObservationCredentialError(code);
}

function exactOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    fail("invalid_configuration");
  }
  let keys;
  try {
    keys = Object.keys(options);
  } catch {
    fail("invalid_configuration");
  }
  if (keys.some((key) => ![
    "platform",
    "architecture",
    "createCredentialManagerBackend",
  ].includes(key))) {
    fail("invalid_configuration");
  }
  return options;
}

function copySecret(value) {
  let valid = false;
  try {
    valid = Buffer.isBuffer(value) && value.byteLength === SECRET_BYTES;
  } catch {
    valid = false;
  }
  if (!valid) fail("stored_value_invalid");
  try {
    return Buffer.from(value);
  } catch {
    fail("stored_value_invalid");
  }
}

function copyCandidateSecret(value) {
  let valid = false;
  try {
    valid = Buffer.isBuffer(value) && value.byteLength === SECRET_BYTES;
  } catch {
    valid = false;
  }
  if (!valid) fail("invalid_configuration");
  try {
    return Buffer.from(value);
  } catch {
    fail("invalid_configuration");
  }
}

function managerFailureCode(error) {
  if (!(error instanceof WindowsCredentialManagerError)) return "unavailable";
  let code;
  try {
    code = error.code;
  } catch {
    return "unavailable";
  }
  const known = {
    windows_credential_manager_unsupported_platform: "unsupported_platform",
    windows_credential_manager_unsupported_architecture: "unsupported_architecture",
    windows_credential_manager_locked: "locked",
    windows_credential_manager_denied: "denied",
    windows_credential_manager_stored_value_invalid: "stored_value_invalid",
    windows_credential_manager_operation_lease_audit_failed: "recovery_required",
    windows_credential_manager_operation_lease_mutex_failed: "recovery_required",
  };
  return known[code] ?? "unavailable";
}

function disposeManager(manager) {
  try {
    if (manager !== null && typeof manager === "object" && typeof manager.close === "function") {
      manager.close();
    }
  } catch {
    // A failed qualification constructor must not expose private manager detail.
  }
}

function snapshotManager(manager) {
  let valid = false;
  try {
    valid = manager !== null
      && typeof manager === "object"
      && ["read", "createIfMissing", "withOperationLease", "close"].every(
        (name) => typeof manager[name] === "function",
      )
      && manager.crossProcessSafe === true
      && manager.auditDurable === true
      && manager.auditFilesystemProtected === true
      && manager.startupRecoveryComplete === true
      && manager.productionSafe === false;
  } catch {
    valid = false;
  }
  if (!valid) fail("unavailable");
  try {
    return Object.freeze({
      read: manager.read.bind(manager),
      createIfMissing: manager.createIfMissing.bind(manager),
      withOperationLease: manager.withOperationLease.bind(manager),
      close: manager.close.bind(manager),
    });
  } catch {
    fail("unavailable");
  }
}

/**
 * Fixed main-process adapter for the legacy account-observation record only.
 * It intentionally reuses the audited manager's ID-1 mutex and durable
 * prepared/settled/recovered journal, while exposing neither generic manager
 * capabilities nor raw Credential Manager service/account inputs. The
 * manager constructor is explicit: only a later app-owned, branded
 * qualification composition may provide it. This module never discovers a
 * native binding, state root, or ambient credential route on its own.
 */
export function createWindowsAccountObservationCredentialBackend(options = {}) {
  const configuration = exactOptions(options);
  const {
    platform = process.platform,
    architecture = process.arch,
    createCredentialManagerBackend = null,
  } = configuration;
  if (platform !== "win32") fail("unsupported_platform");
  if (architecture !== "x64") fail("unsupported_architecture");
  if (typeof createCredentialManagerBackend !== "function") fail("invalid_configuration");

  let manager = null;
  let selected;
  try {
    manager = createCredentialManagerBackend({ platform, architecture });
    selected = snapshotManager(manager);
  } catch (error) {
    disposeManager(manager);
    if (isWindowsAccountObservationCredentialError(error)) throw error;
    fail(managerFailureCode(error));
  }
  let closed = false;

  function assertOpen() {
    if (closed) fail("unavailable");
  }

  async function read() {
    assertOpen();
    let observed = null;
    try {
      observed = await selected.read(EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation);
      if (observed === null) return null;
      const copied = copySecret(observed);
      observed.fill(0);
      observed = null;
      return copied;
    } catch (error) {
      if (isWindowsAccountObservationCredentialError(error)) throw error;
      fail(managerFailureCode(error));
    } finally {
      if (Buffer.isBuffer(observed)) observed.fill(0);
    }
  }

  async function createIfMissing(secret) {
    assertOpen();
    const copied = copyCandidateSecret(secret);
    try {
      const status = await selected.withOperationLease(
        EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation,
        Object.freeze({ operation: "create" }),
        (lease) => selected.createIfMissing(
          EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation,
          copied,
          lease,
        ),
      );
      if (status !== "created" && status !== "existing") fail("unavailable");
      return status;
    } catch (error) {
      if (isWindowsAccountObservationCredentialError(error)) throw error;
      fail(managerFailureCode(error));
    } finally {
      copied.fill(0);
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    try { selected.close(); } catch (error) { fail(managerFailureCode(error)); }
  }

  const backend = Object.freeze({
    read,
    createIfMissing,
    close,
    async describe() {
      assertOpen();
      return Object.freeze({
        backend: "windows_account_observation_credential",
        status: WINDOWS_ACCOUNT_OBSERVATION_CREDENTIAL_INTEGRATION_STATUS,
        productionSafe: WINDOWS_ACCOUNT_OBSERVATION_CREDENTIAL_PRODUCTION_SAFE,
        crossProcessSafe: true,
        auditDurable: true,
        auditFilesystemProtected: true,
        startupRecoveryComplete: true,
      });
    },
    crossProcessSafe: true,
    auditDurable: true,
    auditFilesystemProtected: true,
    startupRecoveryComplete: true,
    productionSafe: WINDOWS_ACCOUNT_OBSERVATION_CREDENTIAL_PRODUCTION_SAFE,
  });
  trustedBackends.add(backend);
  return backend;
}
