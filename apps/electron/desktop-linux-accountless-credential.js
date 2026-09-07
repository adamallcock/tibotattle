import {
  createLinuxAccountlessInstallationCredentialBackend,
  isLinuxAccountlessInstallationCredentialError,
} from "../../src/platform/linux-accountless-installation-credential.js";

const SECRET_BYTES = 32;

function failure({ recoveryRequired = false, retryable = false, knownNonMutation = false } = {}) {
  const error = Object.assign(new Error(recoveryRequired
    ? "Installation credential recovery is required"
    : "Installation credential unavailable"), {
    code: recoveryRequired
      ? "contribution_device_credential_recovery_required"
      : "contribution_device_credential_unavailable",
    retryable: recoveryRequired ? false : retryable === true,
  });
  if (knownNonMutation) {
    Object.defineProperty(error, "knownNonMutation", { value: true });
  }
  return error;
}

function mapFailure(error, { knownNonMutation = false } = {}) {
  if (!isLinuxAccountlessInstallationCredentialError(error)) {
    throw failure({ recoveryRequired: true });
  }
  if (error.code
      === "linux_accountless_installation_credential_recovery_required"
      || error.code
        === "linux_accountless_installation_credential_stored_value_invalid") {
    throw failure({ recoveryRequired: true });
  }
  if (error.code === "linux_accountless_installation_credential_unavailable") {
    throw failure({ retryable: true, knownNonMutation });
  }
  throw failure();
}

function assertSecret(value) {
  if (!Buffer.isBuffer(value) || value.byteLength !== SECRET_BYTES) {
    throw failure();
  }
  return value;
}

/**
 * Adapt the fixed Linux native accountless record to the existing private
 * FD3 accountless channel. This deliberately has no FD4 capability argument;
 * desktop-runtime applies the old encrypted-record recovery wrapper before
 * the backend is handed to the owned companion.
 */
export function createDesktopLinuxAccountlessCredentialBackend(options = {}) {
  let backend;
  try {
    backend = createLinuxAccountlessInstallationCredentialBackend(options);
  } catch (error) {
    mapFailure(error);
  }
  return Object.freeze({
    async read() {
      try {
        const value = await backend.read();
        if (value === null) return null;
        try {
          assertSecret(value);
          return Buffer.from(value);
        } finally {
          value.fill(0);
        }
      } catch (error) {
        mapFailure(error);
      }
    },
    async createIfMissing(value) {
      assertSecret(value);
      try {
        const status = await backend.createIfMissing(value);
        if (status !== "created" && status !== "existing") throw failure();
        return status;
      } catch (error) {
        mapFailure(error, { knownNonMutation: true });
      }
    },
    async deleteExact(value) {
      assertSecret(value);
      try {
        const status = await backend.deleteExact(value);
        if (!["deleted", "missing", "mismatch"].includes(status)) throw failure();
        return status;
      } catch (error) {
        mapFailure(error);
      }
    },
  });
}
