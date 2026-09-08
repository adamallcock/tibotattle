import {
  createLinuxCredentialMutationLeaseContext,
  createLinuxCredentialMutationMutexContext,
} from "../../src/platform/linux-credential-mutation-lease.js";
import { prepareLinuxCredentialState } from "../../src/platform/linux-credential-state.js";
import {
  createLinuxAccountObservationCredentialBackend,
} from "../../src/platform/linux-account-observation-credential.js";
import {
  createLinuxSecretServiceBackend,
  isLinuxSecretServiceError,
} from "../../src/platform/linux-secret-service.js";

import {
  attachDesktopLinuxSecretServiceBroker,
} from "./desktop-linux-secret-service-broker.js";
import {
  attachDesktopLinuxAccountObservationBroker,
} from "./desktop-linux-account-observation-broker.js";
import {
  createDesktopLinuxAccountlessCredentialBackend,
} from "./desktop-linux-accountless-credential.js";
import {
  assertLinuxNativeQualificationReceipt,
  createLinuxQualificationReceipt,
} from "./linux-qualification.js";
import { shellError } from "./errors.js";

// The generic Linux Secret Service broker is qualification-only. The distinct
// fixed-record handover below stays dormant until main selects an exact stable
// Linux production distribution; neither construction changes the platform
// gate.
export const LINUX_SECRET_SERVICE_MAIN_COMPOSITION_STATUS = "qualification_only";

const PRODUCTION_OPTION_KEYS = Object.freeze(["qualificationContext"]);
const LINUX_PRODUCTION_TEST_OPTION_KEYS = Object.freeze([
  "architecture",
  "createAccountlessCredentialBackend",
  "createAccountObservationCredentialBackend",
  "platform",
  "prepareState",
]);
const TEST_OPTION_KEYS = Object.freeze([
  "qualificationContext",
  "platform",
  "architecture",
  "prepareState",
  "createMutexContext",
  "createLeaseContext",
  "createSecretServiceBackend",
  "isSecretServiceError",
]);

function fail() {
  throw shellError("electron_configuration_invalid");
}

function exactOptions(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  let actual;
  try {
    actual = Object.keys(value);
  } catch {
    fail();
  }
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) fail();
  return value;
}

/**
 * A serializable receipt is deliberately insufficient here.  Creating one
 * from the context proves the object came from the qualification module's
 * private brand before any native loader is reached.
 */
function qualifiedLinuxContext(context) {
  try {
    return assertLinuxNativeQualificationReceipt(
      createLinuxQualificationReceipt(context),
    );
  } catch {
    fail();
  }
}

function closeQuietly(value) {
  try { value?.close?.(); } catch { /* Preserve the original construction failure. */ }
}

function wrapLeaseOwningBackend(backend, leaseContext) {
  let valid = false;
  try {
    valid = backend !== null && typeof backend === "object"
      && ["read", "createIfMissing", "replaceExact", "deleteExact", "withOperationLease", "close"]
        .every((name) => typeof backend[name] === "function")
      && backend.crossProcessSafe === true
      && backend.crashRecoveryComplete === false
      && backend.productionSafe === false
      && typeof leaseContext?.close === "function";
  } catch {
    valid = false;
  }
  if (!valid) fail();
  let closed = false;
  return Object.freeze({
    read: backend.read.bind(backend),
    createIfMissing: backend.createIfMissing.bind(backend),
    replaceExact: backend.replaceExact.bind(backend),
    deleteExact: backend.deleteExact.bind(backend),
    withOperationLease: backend.withOperationLease.bind(backend),
    get crossProcessSafe() { return true; },
    get crashRecoveryComplete() { return false; },
    get productionSafe() { return false; },
    close() {
      if (closed) return;
      closed = true;
      let failure = null;
      try {
        backend.close();
      } catch (error) {
        failure = error;
      }
      try {
        // createLinuxSecretServiceBackend intentionally leaves an injected
        // lease context open.  The Electron-owned broker is its lifetime
        // owner, so it must close that context after the backend drains.
        leaseContext.close();
      } catch (error) {
        if (failure === null) failure = error;
      }
      if (failure !== null) throw failure;
    },
  });
}

function createHandover({
  qualificationContext,
  platform,
  architecture,
  prepareState,
  createMutexContext,
  createLeaseContext,
  createSecretServiceBackend,
  isSecretServiceError,
}) {
  const qualification = qualifiedLinuxContext(qualificationContext);
  if (platform !== qualification.platform || architecture !== qualification.architecture
      || typeof prepareState !== "function"
      || typeof createMutexContext !== "function"
      || typeof createLeaseContext !== "function"
      || typeof createSecretServiceBackend !== "function"
      || typeof isSecretServiceError !== "function") {
    fail();
  }

  function createBackend() {
    let leaseContext = null;
    let backend = null;
    try {
      prepareState({ platform, architecture });
      const mutexContext = createMutexContext({ platform, architecture });
      leaseContext = createLeaseContext({ mutexContext });
      backend = createSecretServiceBackend({
        platform,
        architecture,
        operationLeaseContext: leaseContext,
      });
      return wrapLeaseOwningBackend(backend, leaseContext);
    } catch (error) {
      closeQuietly(backend);
      closeQuietly(leaseContext);
      // Preserve trusted Linux backend failures for the fixed parent-to-child
      // mapping.  The broker still collapses any other failure to unavailable.
      throw error;
    }
  }

  return Object.freeze({
    attachLinuxSecretServiceBroker(stream) {
      return attachDesktopLinuxSecretServiceBroker({
        stream,
        createBackend,
        isBackendError: isSecretServiceError,
      });
    },
  });
}

function createLinuxProductionCredentialHandoverWithDependencies({
  platform,
  architecture,
  createAccountlessCredentialBackend,
  createAccountObservationCredentialBackend,
  prepareState,
}) {
  if (platform !== "linux" || architecture !== "x64"
      || typeof createAccountlessCredentialBackend !== "function"
      || typeof createAccountObservationCredentialBackend !== "function"
      || typeof prepareState !== "function") {
    fail();
  }
  // The native fixed-record operations require their owner-only state tree to
  // exist before their first read/create. Qualification previously prepared a
  // separate disposable HOME, which does not prepare a normal app's fresh
  // profile. Keep this in Electron's parent before either fixed production
  // backend is constructed; the child still receives only its narrow broker.
  const prepareCredentialState = () => prepareState({ platform, architecture });
  return Object.freeze({
    createAccountlessCredentialBackend(options) {
      prepareCredentialState();
      return createAccountlessCredentialBackend(options);
    },
    attachLinuxAccountObservationBroker(channel) {
      return attachDesktopLinuxAccountObservationBroker({
        channel,
        createBackend() {
          prepareCredentialState();
          return createAccountObservationCredentialBackend();
        },
      });
    },
  });
}

/**
 * Generic Secret Service construction stays qualification-only. Native loaders
 * run only when an authentic context matches this Linux/x64 process.
 */
export function createLinuxQualificationSecretServiceHandover(options = {}) {
  const source = exactOptions(options, PRODUCTION_OPTION_KEYS);
  return createHandover({
    qualificationContext: source.qualificationContext,
    platform: process.platform,
    architecture: process.arch,
    prepareState: prepareLinuxCredentialState,
    createMutexContext: createLinuxCredentialMutationMutexContext,
    createLeaseContext: createLinuxCredentialMutationLeaseContext,
    createSecretServiceBackend: createLinuxSecretServiceBackend,
    isSecretServiceError: isLinuxSecretServiceError,
  });
}

/** The fixed observation route shared by shell and packaged qualification. */
export function createLinuxQualificationAccountObservationHandover(options = {}) {
  const source = exactOptions(options, PRODUCTION_OPTION_KEYS);
  const receipt = qualifiedLinuxContext(source.qualificationContext);
  if (process.platform !== "linux" || process.arch !== "x64"
      || !["isolated-secret-service", "native-secret-service"]
        .includes(receipt.credentialStoreMode)) fail();
  return Object.freeze({
    attachLinuxAccountObservationBroker(channel) {
      return attachDesktopLinuxAccountObservationBroker({
        channel,
        createBackend: createLinuxAccountObservationCredentialBackend,
      });
    },
  });
}

/**
 * Main's exact packaged stable-linux selection is the only normal-runtime
 * caller. This composes the already-reviewed fixed FD3 installation adapter
 * with the fixed read/create account-observation IPC broker; it does not
 * select generic Secret Service capabilities or alter native safety claims.
 */
export function createLinuxProductionCredentialHandover() {
  return createLinuxProductionCredentialHandoverWithDependencies({
    platform: process.platform,
    architecture: process.arch,
    createAccountlessCredentialBackend: createDesktopLinuxAccountlessCredentialBackend,
    createAccountObservationCredentialBackend: createLinuxAccountObservationCredentialBackend,
    prepareState: prepareLinuxCredentialState,
  });
}

/** Explicit dependency seam for the fixed normal-Linux handover contract. */
export function createLinuxProductionCredentialHandoverForTest(options = {}) {
  return createLinuxProductionCredentialHandoverWithDependencies(
    exactOptions(options, LINUX_PRODUCTION_TEST_OPTION_KEYS),
  );
}

/**
 * Explicit dependency seam for plain-Node qualification contract tests. It
 * keeps the same context, capability, broker, and lease boundaries while
 * replacing only the native bindings with disposable synthetic ones.
 */
export function createLinuxQualificationSecretServiceHandoverForTest(options = {}) {
  const source = exactOptions(options, TEST_OPTION_KEYS);
  return createHandover(source);
}
