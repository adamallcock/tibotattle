import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "./keychain-capabilities.js";
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
  "invalid_capability",
  "invalid_secret",
  "stored_value_invalid",
  "operation_failed",
  "recovery_required",
  "unavailable",
]);
const trustedErrors = new WeakSet();

export class LinuxAccountObservationCredentialError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Linux account observation credential error code");
    }
    super("Linux account observation credential backend failed");
    this.name = "LinuxAccountObservationCredentialError";
    this.code = `linux_account_observation_credential_${code}`;
    trustedErrors.add(this);
  }
}

export function isLinuxAccountObservationCredentialError(error) {
  return Boolean(error
    && trustedErrors.has(error)
    && Object.getPrototypeOf(error) === LinuxAccountObservationCredentialError.prototype);
}

function fail(code) {
  throw new LinuxAccountObservationCredentialError(code);
}

function assertCapability(capability) {
  if (capability !== EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation) {
    fail("invalid_capability");
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

function nativeFailure(error) {
  let code;
  try {
    code = error?.code;
  } catch {
    return "operation_failed";
  }
  if (code === "LINUX_ACCOUNT_OBSERVATION_CREDENTIAL_RECOVERY_REQUIRED") {
    return "recovery_required";
  }
  if (code === "LINUX_ACCOUNT_OBSERVATION_CREDENTIAL_UNAVAILABLE") {
    return "unavailable";
  }
  if (code === "LINUX_ACCOUNT_OBSERVATION_CREDENTIAL_INVALID_VALUE") {
    return "invalid_secret";
  }
  return "operation_failed";
}

function snapshotBinding(binding) {
  let read;
  let createIfMissing;
  let contractVersion;
  let crossProcessSafe;
  let sameNetworkNamespaceOnly;
  let durableMarker;
  let productionSafe;
  try {
    read = binding?.readAccountObservationCredential;
    createIfMissing = binding?.createAccountObservationCredentialIfMissing;
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
    });
  } catch {
    fail("binding_invalid");
  }
}

async function invoke(binding, operation, ...argumentsList) {
  try {
    return await binding[operation](...argumentsList);
  } catch (error) {
    if (isLinuxAccountObservationCredentialError(error)) throw error;
    fail(nativeFailure(error));
  }
}

/**
 * Fixed Linux adapter for the account-observation root. The native binding
 * receives neither a capability nor a pathname: this facade accepts only the
 * frozen account-observation token required by the shared loader and exposes
 * only read/create-if-missing. It remains `productionSafe: false` until a
 * later platform qualification changes an explicit composition root.
 */
export function createLinuxAccountObservationCredentialBackend(options = {}) {
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
    async read(capability) {
      assertCapability(capability);
      const stored = await invoke(native, "read");
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
    async createIfMissing(capability, value) {
      assertCapability(capability);
      const copied = copySecret(value);
      try {
        const status = await invoke(native, "createIfMissing", copied);
        if (status !== "created" && status !== "existing") fail("operation_failed");
        return status;
      } finally {
        copied.fill(0);
      }
    },
  });
}
