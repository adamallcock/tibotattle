import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "./export-identity-keychain.js";
import {
  createWindowsCredentialManagerBackend,
  WindowsCredentialManagerError,
} from "./windows-credential-manager.js";
import {
  createWindowsCredentialOperationLeaseContext,
  isWindowsCredentialOperationLeaseError,
} from "./windows-credential-operation-lease.js";
import {
  createWindowsCredentialMutexContext,
} from "./windows-credential-mutex.js";
import {
  createWindowsCredentialOperationAuditStore,
  defaultWindowsCredentialOperationAuditFile,
} from "./windows-credential-operation-audit.js";
import {
  createWindowsCredentialAuditFileGuardContext,
} from "./windows-credential-audit-file-guard.js";
import {
  isWindowsQualificationModeContextFor,
} from "./windows-qualification-mode.js";

const SECRET_BYTES = 32;
const trustedErrors = new WeakSet();
const trustedBackends = new WeakSet();
const QUALIFIED_PRODUCTION_OPTION_KEYS = Object.freeze([
  "adapter",
  "resourceRoot",
  "windowsQualificationModeContext",
]);
const QUALIFIED_TEST_OPTION_KEYS = Object.freeze([
  ...QUALIFIED_PRODUCTION_OPTION_KEYS,
  "architecture",
  "platform",
]);
const QUALIFIED_TEST_DEPENDENCY_KEYS = Object.freeze([
  "createAuditFileGuardContext",
  "createAuditStore",
  "createCredentialManagerBackend",
  "createLeaseContext",
  "createMutexContext",
  "defaultAuditFile",
  "isQualificationModeContextFor",
]);

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

function exactObject(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_configuration");
  }
  let actual;
  try {
    actual = Object.keys(value);
  } catch {
    fail("invalid_configuration");
  }
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    fail("invalid_configuration");
  }
  return value;
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

function closeQuietly(value) {
  try { value?.close?.(); } catch { /* Preserve the fixed constructor failure. */ }
}

function qualifiedFailureCode(error) {
  if (isWindowsCredentialOperationLeaseError(error)) return "recovery_required";
  return managerFailureCode(error);
}

function qualifiedModeContext({
  adapter,
  resourceRoot,
  windowsQualificationModeContext,
  isQualificationContextFor,
}) {
  let valid = false;
  try {
    valid = adapter !== null
      && (typeof adapter === "object" || typeof adapter === "function")
      && typeof resourceRoot === "string"
      && resourceRoot.length > 0
      && windowsQualificationModeContext !== null
      && typeof windowsQualificationModeContext === "object"
      && windowsQualificationModeContext.platform === "win32"
      && windowsQualificationModeContext.architecture === "x64"
      && windowsQualificationModeContext.qualificationOnly === true
      && windowsQualificationModeContext.productionSafe === false
      && typeof windowsQualificationModeContext.stateRoot === "string"
      && windowsQualificationModeContext.stateRoot.length > 0
      && typeof isQualificationContextFor === "function"
      && isQualificationContextFor({
        context: windowsQualificationModeContext,
        adapter,
        stateRoot: windowsQualificationModeContext.stateRoot,
        resourceRoot,
      }) === true;
  } catch {
    valid = false;
  }
  if (!valid) fail("unavailable");
  return windowsQualificationModeContext;
}

function validRecoveryReceipt(value) {
  try {
    return value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.keys(value).length === 3
      && Object.hasOwn(value, "complete")
      && Object.hasOwn(value, "recovered")
      && Object.hasOwn(value, "contended")
      && value.complete === true
      && Number.isSafeInteger(value.recovered)
      && value.recovered >= 0
      && value.contended === 0;
  } catch {
    return false;
  }
}

/**
 * The generic Credential Manager cannot own an explicitly injected lease
 * context. This narrow facade gives that context one clear owner: the fixed
 * account-observation backend. It exposes only the manager operations that
 * the existing fixed wrapper already snapshots, and it never forwards an
 * arbitrary credential capability or binding.
 */
function wrapLeaseOwningQualifiedManager(manager, leaseContext) {
  const selected = snapshotManager(manager);
  let closed = false;
  return Object.freeze({
    read: selected.read,
    createIfMissing: selected.createIfMissing,
    withOperationLease: selected.withOperationLease,
    close() {
      if (closed) return;
      closed = true;
      try {
        // `createWindowsCredentialManagerBackend` rejects close() when it
        // was given an external lease, so closing it here would only mask the
        // lifetime error. The lease owns the audit store and file guard.
        leaseContext.close();
      } catch {
        throw new WindowsCredentialManagerError("operation_lease_audit_failed");
      }
    },
    crossProcessSafe: true,
    auditDurable: true,
    auditFilesystemProtected: true,
    startupRecoveryComplete: true,
    productionSafe: false,
  });
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
 * qualification composition may provide it. This injected constructor never
 * discovers a native binding, state root, or ambient credential route on its
 * own; the separate qualified constructor below verifies both authorities
 * before it composes the reviewed native factories internally.
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

function createQualifiedBackend({
  adapter,
  architecture,
  createAuditFileGuardContext,
  createAuditStore,
  createCredentialManagerBackend,
  createLeaseContext,
  createMutexContext,
  defaultAuditFile,
  isQualificationContextFor,
  platform,
  resourceRoot,
  windowsQualificationModeContext,
}) {
  if (platform !== "win32") fail("unsupported_platform");
  if (architecture !== "x64") fail("unsupported_architecture");
  if ([
    createAuditFileGuardContext,
    createAuditStore,
    createCredentialManagerBackend,
    createLeaseContext,
    createMutexContext,
    defaultAuditFile,
    isQualificationContextFor,
  ].some((value) => typeof value !== "function")) {
    fail("invalid_configuration");
  }
  const qualifiedContext = qualifiedModeContext({
    adapter,
    resourceRoot,
    windowsQualificationModeContext,
    isQualificationContextFor,
  });

  let auditStore = null;
  let leaseContext = null;
  try {
    const mutexContext = createMutexContext({ platform, architecture });
    const fileGuardContext = createAuditFileGuardContext({ platform, architecture });
    auditStore = createAuditStore({
      filePath: defaultAuditFile({
        platform,
        stateRoot: qualifiedContext.stateRoot,
      }),
      fileGuardContext,
    });
    const candidateLeaseContext = createLeaseContext({
      mutexContext,
      auditStore,
      ownsAuditStore: true,
    });
    if (candidateLeaseContext === null || typeof candidateLeaseContext !== "object"
        || typeof candidateLeaseContext.close !== "function"
        || typeof candidateLeaseContext.recoverPreparedOperations !== "function") {
      fail("unavailable");
    }
    leaseContext = candidateLeaseContext;
    // Once a lease context has been returned, it owns the audit store. Keep
    // explicit ownership only across the factory call so a constructor throw
    // cannot leave its durable database/file guards open.
    auditStore = null;
    const recovery = leaseContext?.recoverPreparedOperations?.();
    if (!validRecoveryReceipt(recovery)) fail("recovery_required");

    const qualifiedManager = createCredentialManagerBackend({
      platform,
      architecture,
      operationLeaseContext: leaseContext,
    });
    const manager = wrapLeaseOwningQualifiedManager(qualifiedManager, leaseContext);
    // The explicit fixed factory still performs its own trusted-manager
    // snapshot and retains the capability restriction in one place.
    return createWindowsAccountObservationCredentialBackend({
      platform,
      architecture,
      createCredentialManagerBackend: () => manager,
    });
  } catch (error) {
    // The generic manager's close method deliberately rejects external lease
    // ownership. The lease context is the one resource owner on every
    // constructor-failure path, including failed recovery and manager shape.
    closeQuietly(leaseContext);
    closeQuietly(auditStore);
    if (isWindowsAccountObservationCredentialError(error)) throw error;
    fail(qualifiedFailureCode(error));
  }
}

/**
 * Construct the fixed account-observation credential backend for an already
 * authenticated packaged Windows qualification run. This is intentionally
 * not a production selector: it uses the current native Windows process,
 * requires both branded qualification authorities, and remains
 * `productionSafe: false` end to end.
 *
 * No caller-controlled binding, state root, capability, service, account, or
 * generic manager factory is accepted. The generic manager remains an
 * implementation detail of this fixed platform facade.
 */
export function createQualifiedWindowsAccountObservationCredentialBackend(options = {}) {
  const source = exactObject(options, QUALIFIED_PRODUCTION_OPTION_KEYS);
  return createQualifiedBackend({
    adapter: source.adapter,
    architecture: process.arch,
    createAuditFileGuardContext: createWindowsCredentialAuditFileGuardContext,
    createAuditStore: createWindowsCredentialOperationAuditStore,
    createCredentialManagerBackend: createWindowsCredentialManagerBackend,
    createLeaseContext: createWindowsCredentialOperationLeaseContext,
    createMutexContext: createWindowsCredentialMutexContext,
    defaultAuditFile: defaultWindowsCredentialOperationAuditFile,
    isQualificationContextFor: isWindowsQualificationModeContextFor,
    platform: process.platform,
    resourceRoot: source.resourceRoot,
    windowsQualificationModeContext: source.windowsQualificationModeContext,
  });
}

/**
 * Plain-Node seam for qualification-contract tests. It mirrors the exact
 * production shape while replacing native factories with disposable
 * synthetic ones; application code must use the production constructor.
 */
export function createQualifiedWindowsAccountObservationCredentialBackendForTest(
  options = {},
  dependencies = {},
) {
  const source = exactObject(options, QUALIFIED_TEST_OPTION_KEYS);
  const factories = exactObject(dependencies, QUALIFIED_TEST_DEPENDENCY_KEYS);
  return createQualifiedBackend({
    adapter: source.adapter,
    architecture: source.architecture,
    createAuditFileGuardContext: factories.createAuditFileGuardContext,
    createAuditStore: factories.createAuditStore,
    createCredentialManagerBackend: factories.createCredentialManagerBackend,
    createLeaseContext: factories.createLeaseContext,
    createMutexContext: factories.createMutexContext,
    defaultAuditFile: factories.defaultAuditFile,
    isQualificationContextFor: factories.isQualificationModeContextFor,
    platform: source.platform,
    resourceRoot: source.resourceRoot,
    windowsQualificationModeContext: source.windowsQualificationModeContext,
  });
}
