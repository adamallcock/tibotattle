import {
  LINUX_ACCOUNT_OBSERVATION_BROKER_CAPABILITY,
  LINUX_ACCOUNT_OBSERVATION_BROKER_INTEGRATION_STATUS as PLATFORM_INTEGRATION_STATUS,
  LinuxAccountObservationBrokerError,
  attachLinuxAccountObservationBrokerIpcServer,
  isLinuxAccountObservationBrokerIpcChannel,
} from "../../src/platform/index.js";
import {
  isLinuxAccountObservationCredentialBackend,
  isLinuxAccountObservationCredentialError,
} from "../../src/platform/linux-account-observation-credential.js";

// The explicit Linux qualification composition attaches the fixed native
// facade to inherited Node IPC. Normal production selection remains closed.
export const LINUX_ACCOUNT_OBSERVATION_BROKER_INTEGRATION_STATUS = PLATFORM_INTEGRATION_STATUS;

function fail(code) {
  throw new LinuxAccountObservationBrokerError(code);
}

function backendFailureCode(error, isBackendError) {
  let trusted = false;
  try { trusted = isBackendError(error) === true; } catch { trusted = false; }
  if (!trusted) return "unavailable";
  let code;
  try { code = error.code; } catch { return "unavailable"; }
  return code === "linux_account_observation_credential_recovery_required"
    ? "recovery_required"
    : "unavailable";
}

function snapshotBackend(backend) {
  let valid = false;
  try {
    valid = isLinuxAccountObservationCredentialBackend(backend)
      && ["read", "createIfMissing"].every((method) => typeof backend[method] === "function")
      && Object.hasOwn(backend, "replaceExact") === false
      && Object.hasOwn(backend, "deleteExact") === false;
  } catch {
    valid = false;
  }
  if (!valid) fail("invalid_configuration");
  try {
    return Object.freeze({
      // The fixed native facade requires the frozen capability token. Binding
      // it here means no IPC frame can select a different credential route.
      read: () => backend.read(LINUX_ACCOUNT_OBSERVATION_BROKER_CAPABILITY),
      createIfMissing: (secret) => backend.createIfMissing(
        LINUX_ACCOUNT_OBSERVATION_BROKER_CAPABILITY,
        secret,
      ),
    });
  } catch {
    fail("invalid_configuration");
  }
}

/**
 * Serve only the fixed account-observation root to one supervisor-owned
 * companion over inherited Node IPC. The parent owns native access; no child
 * request can select a generic capability, state path, or mutation operation.
 */
export function attachDesktopLinuxAccountObservationBroker({
  channel,
  createBackend,
  isBackendError = isLinuxAccountObservationCredentialError,
} = {}) {
  if (!isLinuxAccountObservationBrokerIpcChannel(channel) || typeof createBackend !== "function"
      || typeof isBackendError !== "function") {
    fail("invalid_configuration");
  }
  let backend = null;
  let selected = null;
  try {
    backend = createBackend();
    selected = snapshotBackend(backend);
    return attachLinuxAccountObservationBrokerIpcServer({
      channel,
      backend: selected,
      mapBackendError: (error) => backendFailureCode(error, isBackendError),
    });
  } catch (error) {
    if (error instanceof LinuxAccountObservationBrokerError) throw error;
    fail(backendFailureCode(error, isBackendError));
  }
}
