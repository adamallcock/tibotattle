import {
  createWindowsAccountlessInstallationCredentialBackend,
  isWindowsAccountlessInstallationCredentialError,
} from "../../src/platform/windows-accountless-installation-credential.js";
import {
  isWindowsQualificationModeContextFor,
} from "../../src/platform/index.js";

const SECRET_BYTES = 32;
const WINDOWS_PLATFORM = "win32";
const WINDOWS_ARCHITECTURE = "x64";
const NATIVE_OPTION_KEYS = Object.freeze([
  "adapter",
  "architecture",
  "platform",
  "resourceRoot",
  "rootPath",
  "windowsQualificationModeContext",
]);

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

function assertSecret(value) {
  if (!Buffer.isBuffer(value) || value.byteLength !== SECRET_BYTES) throw failure();
  return value;
}

function exactObjectKeys(value, keys) {
  try {
    return value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
  } catch {
    return false;
  }
}

function assertNativeBackend(backend) {
  let valid = false;
  try {
    valid = backend !== null
      && typeof backend === "object"
      && !Array.isArray(backend)
      && ["read", "createIfMissing", "deleteExact"].every(
        (operation) => typeof backend[operation] === "function",
      );
  } catch {
    // Collapse a malformed native facade before it could enter FD3.
  }
  if (!valid) throw failure();
  return backend;
}

function mapFailure(error, isNativeError, { knownNonMutation = false } = {}) {
  let native = false;
  let code = "";
  try {
    native = isNativeError(error) === true;
    if (native) code = error.code;
  } catch {
    native = false;
  }
  if (!native) throw failure();
  if (code === "windows_accountless_installation_credential_recovery_required"
      || code === "windows_accountless_installation_credential_stored_value_invalid") {
    throw failure({ recoveryRequired: true });
  }
  if (code === "windows_accountless_installation_credential_unavailable") {
    throw failure({ retryable: true, knownNonMutation });
  }
  throw failure();
}

function assertConfiguration(options, isQualificationContextFor) {
  if (!exactObjectKeys(options, NATIVE_OPTION_KEYS)
      || typeof isQualificationContextFor !== "function") {
    throw failure();
  }
  const {
    platform,
    architecture,
    adapter,
    rootPath,
    windowsQualificationModeContext,
    resourceRoot,
  } = options;
  if (platform !== WINDOWS_PLATFORM || architecture !== WINDOWS_ARCHITECTURE) {
    throw failure();
  }
  let validContext = false;
  try {
    validContext = windowsQualificationModeContext?.qualificationOnly === true
      && windowsQualificationModeContext?.productionSafe === false
      && isQualificationContextFor({
        context: windowsQualificationModeContext,
        adapter,
        stateRoot: windowsQualificationModeContext.stateRoot,
        resourceRoot,
      }) === true;
  } catch {
    validContext = false;
  }
  if (!validContext) throw failure();
  return Object.freeze({
    platform,
    architecture,
    adapter,
    rootPath,
    windowsQualificationModeContext,
    resourceRoot,
  });
}

/**
 * Adapt the fixed Windows qualification-only native credential backend to the
 * existing private FD3 accountless channel. The caller must hold the branded
 * Windows qualification context; this module neither derives one from an
 * Electron context nor makes a production selection. It accepts no account,
 * record, capability, or renderer-controlled identifier.
 */
export function createDesktopWindowsAccountlessCredentialBackend(options = {}, {
  createNativeBackend = createWindowsAccountlessInstallationCredentialBackend,
  isNativeError = isWindowsAccountlessInstallationCredentialError,
  isQualificationContextFor = isWindowsQualificationModeContextFor,
} = {}) {
  const configuration = assertConfiguration(options, isQualificationContextFor);
  if (typeof createNativeBackend !== "function" || typeof isNativeError !== "function") {
    throw failure();
  }
  let backend;
  try {
    backend = assertNativeBackend(createNativeBackend(configuration));
  } catch (error) {
    mapFailure(error, isNativeError);
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
        mapFailure(error, isNativeError);
      }
    },
    async createIfMissing(value) {
      assertSecret(value);
      const copied = Buffer.from(value);
      try {
        const status = await backend.createIfMissing(copied);
        if (status !== "created" && status !== "existing") throw failure();
        return status;
      } catch (error) {
        mapFailure(error, isNativeError, { knownNonMutation: true });
      } finally {
        copied.fill(0);
      }
    },
    async deleteExact(value) {
      assertSecret(value);
      const copied = Buffer.from(value);
      try {
        const status = await backend.deleteExact(copied);
        if (!["deleted", "missing", "mismatch"].includes(status)) throw failure();
        return status;
      } catch (error) {
        mapFailure(error, isNativeError);
      } finally {
        copied.fill(0);
      }
    },
  });
}
