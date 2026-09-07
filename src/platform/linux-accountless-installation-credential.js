import {
  loadLinuxCredentialMutexBinding,
} from "./linux-credential-mutex.js";

const SECRET_BYTES = 32;
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

export class LinuxAccountlessInstallationCredentialError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Linux accountless installation credential error code");
    }
    super("Linux accountless installation credential backend failed");
    this.name = "LinuxAccountlessInstallationCredentialError";
    this.code = `linux_accountless_installation_credential_${code}`;
    trustedErrors.add(this);
  }
}

export function isLinuxAccountlessInstallationCredentialError(error) {
  return Boolean(error
    && trustedErrors.has(error)
    && Object.getPrototypeOf(error)
      === LinuxAccountlessInstallationCredentialError.prototype);
}

function fail(code) {
  throw new LinuxAccountlessInstallationCredentialError(code);
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

function nativeFailure(error) {
  let code;
  try {
    code = error?.code;
  } catch {
    return "operation_failed";
  }
  if (code === "LINUX_ACCOUNTLESS_CREDENTIAL_RECOVERY_REQUIRED") {
    return "recovery_required";
  }
  if (code === "LINUX_ACCOUNTLESS_CREDENTIAL_UNAVAILABLE") {
    return "unavailable";
  }
  if (code === "LINUX_ACCOUNTLESS_CREDENTIAL_INVALID_VALUE") {
    return "invalid_secret";
  }
  return "operation_failed";
}

function snapshotBinding(binding) {
  let read;
  let createIfMissing;
  let deleteExact;
  let contractVersion;
  let crossProcessSafe;
  let sameNetworkNamespaceOnly;
  let durableMarker;
  let productionSafe;
  try {
    read = binding?.readAccountlessInstallationCredential;
    createIfMissing = binding?.createAccountlessInstallationCredentialIfMissing;
    deleteExact = binding?.deleteAccountlessInstallationCredentialExact;
    contractVersion = binding?.credentialMutexContractVersion;
    crossProcessSafe = binding?.credentialMutexCrossProcessSafe;
    sameNetworkNamespaceOnly = binding?.credentialMutexSameNetworkNamespaceOnly;
    durableMarker = binding?.credentialMutexDurableMarker;
    productionSafe = binding?.productionSafe;
  } catch {
    fail("binding_invalid");
  }
  if (typeof read !== "function"
      || typeof createIfMissing !== "function"
      || typeof deleteExact !== "function"
      || contractVersion !== "linux-credential-mutex-v1"
      || crossProcessSafe !== true
      || sameNetworkNamespaceOnly !== true
      || durableMarker !== true
      || productionSafe !== false) {
    fail("binding_invalid");
  }
  try {
    return Object.freeze({
      read: read.bind(binding),
      createIfMissing: createIfMissing.bind(binding),
      deleteExact: deleteExact.bind(binding),
    });
  } catch {
    fail("binding_invalid");
  }
}

function invoke(binding, operation, ...argumentsList) {
  try {
    const result = binding[operation](...argumentsList);
    if (result !== null
        && (typeof result === "object" || typeof result === "function")
        && typeof result.then === "function") {
      Promise.resolve(result).catch(() => {});
      fail("operation_failed");
    }
    return result;
  } catch (error) {
    if (isLinuxAccountlessInstallationCredentialError(error)) throw error;
    fail(nativeFailure(error));
  }
}

/**
 * Fixed, main-process-only Linux adapter for the distinct accountless upload
 * credential. It has no capability argument, no legacy FD4 route, no
 * safeStorage fallback, and remains `productionSafe: false` through the
 * native binding contract until a later platform qualification changes the
 * composition root.
 */
export function createLinuxAccountlessInstallationCredentialBackend(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("invalid_configuration");
  }
  let platform;
  let architecture;
  let binding;
  let loadBinding;
  try {
    ({
      platform = process.platform,
      architecture = process.arch,
      binding = undefined,
      loadBinding = loadLinuxCredentialMutexBinding,
    } = options);
  } catch {
    fail("invalid_configuration");
  }
  if (platform !== "linux") fail("unsupported_platform");
  if (architecture !== "x64") fail("unsupported_architecture");
  if (typeof loadBinding !== "function") fail("invalid_configuration");

  let selectedBinding = binding;
  if (selectedBinding === undefined) {
    try {
      selectedBinding = loadBinding({ platform, architecture });
    } catch {
      fail("binding_unavailable");
    }
  }
  const native = snapshotBinding(selectedBinding);

  return Object.freeze({
    async read() {
      const stored = invoke(native, "read");
      if (stored === null) return null;
      let result = null;
      try {
        result = copySecret(stored, "stored_value_invalid");
        return Buffer.from(result);
      } finally {
        result?.fill(0);
        try {
          if (Buffer.isBuffer(stored)) stored.fill(0);
        } catch {
          // The native result has already been copied or rejected.
        }
      }
    },
    async createIfMissing(value) {
      const copied = copySecret(value);
      try {
        const status = invoke(native, "createIfMissing", copied);
        if (status !== "created" && status !== "existing") fail("operation_failed");
        return status;
      } finally {
        copied.fill(0);
      }
    },
    async deleteExact(value) {
      const copied = copySecret(value);
      try {
        const status = invoke(native, "deleteExact", copied);
        if (!["deleted", "missing", "mismatch"].includes(status)) {
          fail("operation_failed");
        }
        return status;
      } finally {
        copied.fill(0);
      }
    },
  });
}
