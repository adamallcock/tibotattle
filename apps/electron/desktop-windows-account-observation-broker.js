import {
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_INTEGRATION_STATUS as PLATFORM_INTEGRATION_STATUS,
  WindowsAccountObservationBrokerError,
  attachWindowsAccountObservationBrokerIpcServer,
  isWindowsAccountObservationBrokerIpcChannel,
} from "../../src/platform/index.js";
import {
  isWindowsAccountObservationCredentialBackend,
  isWindowsAccountObservationCredentialError,
} from "../../src/platform/windows-account-observation-credential.js";

// This is a dormant composition seam. Only a later qualified Electron main
// composition may attach it to owned Node IPC; the companion never loads Keytar.
export const WINDOWS_ACCOUNT_OBSERVATION_BROKER_INTEGRATION_STATUS = PLATFORM_INTEGRATION_STATUS;

function fail(code) {
  throw new WindowsAccountObservationBrokerError(code);
}

function backendFailureCode(error, isBackendError) {
  let trusted = false;
  try { trusted = isBackendError(error) === true; } catch { trusted = false; }
  if (!trusted) return "unavailable";
  let code;
  try { code = error.code; } catch { return "unavailable"; }
  if (code === "windows_account_observation_credential_locked") return "locked";
  if (code === "windows_account_observation_credential_denied") return "denied";
  if (code === "windows_account_observation_credential_recovery_required") {
    return "recovery_required";
  }
  return "unavailable";
}

function snapshotBackend(backend) {
  let valid = false;
  try {
    valid = isWindowsAccountObservationCredentialBackend(backend)
      && ["read", "createIfMissing", "close"].every((method) => typeof backend[method] === "function")
      && backend.crossProcessSafe === true
      && backend.auditDurable === true
      && backend.auditFilesystemProtected === true
      && backend.startupRecoveryComplete === true
      && backend.productionSafe === false;
  } catch {
    valid = false;
  }
  if (!valid) fail("invalid_configuration");
  try {
    return Object.freeze({
      read: backend.read.bind(backend),
      createIfMissing: backend.createIfMissing.bind(backend),
      close: backend.close.bind(backend),
    });
  } catch {
    fail("invalid_configuration");
  }
}

function disposeBackend(backend) {
  try { backend?.close?.(); } catch { /* The owned IPC channel is already closed. */ }
}

/**
 * Serve only the fixed account-observation record to one supervisor-owned
 * companion over Node IPC. Mutations are serialized and journaled inside the
 * main-owned backend before Keytar is touched; no child request can select
 * another legacy capability, record name, native binding, or state path.
 */
export function attachDesktopWindowsAccountObservationBroker({
  channel,
  createBackend,
  isBackendError = isWindowsAccountObservationCredentialError,
} = {}) {
  if (!isWindowsAccountObservationBrokerIpcChannel(channel) || typeof createBackend !== "function"
      || typeof isBackendError !== "function") {
    fail("invalid_configuration");
  }
  let backend = null;
  let selected = null;
  try {
    backend = createBackend();
    selected = snapshotBackend(backend);
    return attachWindowsAccountObservationBrokerIpcServer({
      channel,
      backend: selected,
      mapBackendError: (error) => backendFailureCode(error, isBackendError),
      disposeBackend,
    });
  } catch (error) {
    disposeBackend(selected ?? backend);
    if (error instanceof WindowsAccountObservationBrokerError) throw error;
    fail(backendFailureCode(error, isBackendError));
  }
}
