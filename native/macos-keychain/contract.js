/**
 * Closed JavaScript contract for the macOS app-owned Keychain adapter.
 *
 * This module deliberately neither resolves a native binary nor turns a source
 * build into signing or installed-artifact evidence. A production companion
 * owns resource resolution and its fixed-capability IPC wrapper.
 */

export const MACOS_KEYCHAIN_ADAPTER_CONTRACT_VERSION =
  "tibotattle-macos-keychain-v2";

// These four credentials remain the only capabilities that may cross the
// inherited companion pipe. Keep this list distinct from the adapter's full
// fixed list: accountless installation enrollment is main-process-only.
export const MACOS_KEYCHAIN_ADAPTER_BROKER_CAPABILITIES = Object.freeze([
  "export_identity",
  "account_observation",
  "claude_session_pseudonym",
  "contribution_device",
]);

// Startup validates only the credential paths which the current Electron
// composition activates: account observation and the contribution-device
// bridge. Export identity is a legacy, on-demand path and the Claude
// pseudonym is reserved for the optional Claude provider. Their read, store,
// and migration-required guards stay active when either path is requested;
// an export migration still requires the released native approval route.
// Accountless installation enrollment remains main-process-only and is
// deliberately checked only when sharing needs it.
export const MACOS_KEYCHAIN_ADAPTER_STARTUP_PREFLIGHT_CAPABILITIES = Object.freeze([
  "account_observation",
  "contribution_device",
]);

export const MACOS_KEYCHAIN_ADAPTER_ACCOUNTLESS_INSTALLATION_CAPABILITY =
  "accountless_installation";

export const MACOS_KEYCHAIN_ADAPTER_CAPABILITIES = Object.freeze([
  ...MACOS_KEYCHAIN_ADAPTER_BROKER_CAPABILITIES,
  MACOS_KEYCHAIN_ADAPTER_ACCOUNTLESS_INSTALLATION_CAPABILITY,
]);

export const MACOS_KEYCHAIN_ADAPTER_ITEM_STATUSES = Object.freeze([
  "absent",
  "present",
  "locked",
  "denied",
  "migration_required",
  "unknown",
]);

export const MACOS_KEYCHAIN_ADAPTER_STORE_STATUSES = Object.freeze([
  "stored",
  "locked",
  "denied",
  "migration_required",
  "unknown",
]);

export const MACOS_KEYCHAIN_ADAPTER_REMOVE_STATUSES = Object.freeze([
  "deleted",
  "absent",
  "locked",
  "denied",
  "unknown",
]);

export const MACOS_KEYCHAIN_ADAPTER_CREATE_IF_MISSING_STATUSES = Object.freeze([
  "created",
  "existing",
  "locked",
  "denied",
  "migration_required",
  "unknown",
]);

export const MACOS_KEYCHAIN_ADAPTER_DELETE_EXACT_STATUSES = Object.freeze([
  "deleted",
  "missing",
  "mismatch",
  "locked",
  "denied",
  "migration_required",
  "unknown",
]);

const ITEM_STATUSES = new Set(MACOS_KEYCHAIN_ADAPTER_ITEM_STATUSES);
const STORE_STATUSES = new Set(MACOS_KEYCHAIN_ADAPTER_STORE_STATUSES);
const REMOVE_STATUSES = new Set(MACOS_KEYCHAIN_ADAPTER_REMOVE_STATUSES);
const CREATE_IF_MISSING_STATUSES = new Set(
  MACOS_KEYCHAIN_ADAPTER_CREATE_IF_MISSING_STATUSES,
);
const DELETE_EXACT_STATUSES = new Set(
  MACOS_KEYCHAIN_ADAPTER_DELETE_EXACT_STATUSES,
);
const CAPABILITIES = new Set(MACOS_KEYCHAIN_ADAPTER_CAPABILITIES);
const BROKER_CAPABILITIES = new Set(MACOS_KEYCHAIN_ADAPTER_BROKER_CAPABILITIES);
const REQUIRED_KEYS = Object.freeze([
  "capabilities",
  "createIfMissing",
  "deleteExact",
  "contractVersion",
  "identityStatus",
  "inspect",
  "read",
  "remove",
  "store",
].sort());
const failures = new WeakSet();

export class MacOSKeychainAdapterContractError extends Error {
  constructor(code) {
    super("macOS Keychain adapter contract failed");
    this.name = "MacOSKeychainAdapterContractError";
    this.code = `macos_keychain_adapter_${code}`;
    failures.add(this);
  }
}

export function isMacOSKeychainAdapterContractError(error) {
  return Boolean(error
    && failures.has(error)
    && Object.getPrototypeOf(error) === MacOSKeychainAdapterContractError.prototype);
}

function fail(code) {
  throw new MacOSKeychainAdapterContractError(code);
}

function exactRecord(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return false;
  }
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length
    && keys.every((key) => actual.includes(key));
}

function exactKeys(value, keys) {
  let actual;
  try {
    actual = Object.keys(value).sort();
  } catch {
    return false;
  }
  return actual.length === keys.length
    && actual.every((key, index) => key === keys[index]);
}

function checkedCapability(value) {
  if (typeof value !== "string" || !CAPABILITIES.has(value)) {
    fail("invalid_capability");
  }
  return value;
}

function checkedBrokerCapability(value) {
  if (typeof value !== "string" || !BROKER_CAPABILITIES.has(value)) {
    fail("invalid_capability");
  }
  return value;
}

function checkedAccountlessInstallationCapability(value) {
  if (value !== MACOS_KEYCHAIN_ADAPTER_ACCOUNTLESS_INSTALLATION_CAPABILITY) {
    fail("invalid_capability");
  }
  return value;
}

function copiedSecret(value) {
  if (!Buffer.isBuffer(value) || value.length !== 32) {
    fail("invalid_secret");
  }
  return Buffer.from(value);
}

function checkedStatus(value, allowed) {
  if (typeof value !== "string" || !allowed.has(value)) {
    fail("invalid_response");
  }
  return value;
}

function checkedReadResponse(value) {
  if (!exactRecord(value, ["status", "value"])) fail("invalid_response");
  const status = checkedStatus(value.status, ITEM_STATUSES);
  if (status === "present") {
    if (!Buffer.isBuffer(value.value) || value.value.length !== 32) {
      fail("invalid_response");
    }
    const copied = Buffer.from(value.value);
    value.value.fill(0);
    return Object.freeze({ status, value: copied });
  }
  if (value.value !== null) fail("invalid_response");
  return Object.freeze({ status, value: null });
}

function invokeAsync(callback, args) {
  let response;
  try {
    response = callback(...args);
  } catch (error) {
    return Promise.reject(error);
  }
  if (response === null || (typeof response !== "object"
      && typeof response !== "function") || typeof response.then !== "function") {
    return Promise.reject(new MacOSKeychainAdapterContractError("non_async_response"));
  }
  return Promise.resolve(response);
}

function invokeCapabilityAsync(callback, capability) {
  try {
    return invokeAsync(callback, [checkedCapability(capability)]);
  } catch (error) {
    return Promise.reject(error);
  }
}

function invokeBrokerCapabilityAsync(callback, capability) {
  try {
    return invokeAsync(callback, [checkedBrokerCapability(capability)]);
  } catch (error) {
    return Promise.reject(error);
  }
}

function invokeAccountlessInstallationSecretAsync(callback, capability, secret) {
  let copied;
  let pending;
  try {
    copied = copiedSecret(secret);
    pending = invokeAsync(callback, [
      checkedAccountlessInstallationCapability(capability),
      copied,
    ]);
  } catch (error) {
    copied?.fill(0);
    return Promise.reject(error);
  }
  return pending.finally(() => copied.fill(0));
}

/**
 * Snapshot an already-loaded native adapter into a narrow, content-free facade.
 * All Keychain operations must remain Promise-based so the Electron main
 * thread cannot wait on lockdaemon or Security UI state.
 */
export function createMacOSKeychainAdapterFacade(binding) {
  if (!exactRecord(binding, REQUIRED_KEYS) || !exactKeys(binding, REQUIRED_KEYS)) {
    fail("invalid_binding");
  }
  if (binding.contractVersion !== MACOS_KEYCHAIN_ADAPTER_CONTRACT_VERSION
      || !Array.isArray(binding.capabilities)
      || binding.capabilities.length !== MACOS_KEYCHAIN_ADAPTER_CAPABILITIES.length
      || binding.capabilities.some((value, index) =>
        value !== MACOS_KEYCHAIN_ADAPTER_CAPABILITIES[index])) {
    fail("invalid_binding");
  }
  for (const name of REQUIRED_KEYS.filter((key) => key !== "contractVersion" && key !== "capabilities")) {
    if (typeof binding[name] !== "function") fail("invalid_binding");
  }

  const identityStatus = binding.identityStatus.bind(binding);
  const inspect = binding.inspect.bind(binding);
  const read = binding.read.bind(binding);
  const store = binding.store.bind(binding);
  const remove = binding.remove.bind(binding);
  const createIfMissing = binding.createIfMissing.bind(binding);
  const deleteExact = binding.deleteExact.bind(binding);

  return Object.freeze({
    identityStatus() {
      const status = identityStatus();
      if (status !== "valid" && status !== "invalid") fail("invalid_response");
      return status;
    },
    inspect(capability) {
      return invokeCapabilityAsync(inspect, capability)
        .then((response) => checkedStatus(response, ITEM_STATUSES));
    },
    read(capability) {
      return invokeCapabilityAsync(read, capability)
        .then(checkedReadResponse);
    },
    store(capability, secret) {
      let copied;
      let pending;
      try {
        const brokerCapability = checkedBrokerCapability(capability);
        copied = copiedSecret(secret);
        pending = invokeAsync(store, [brokerCapability, copied]);
      } catch (error) {
        if (copied !== undefined) copied.fill(0);
        return Promise.reject(error);
      }
      return pending
        .then((response) => checkedStatus(response, STORE_STATUSES))
        .finally(() => copied.fill(0));
    },
    remove(capability) {
      return invokeBrokerCapabilityAsync(remove, capability)
        .then((response) => checkedStatus(response, REMOVE_STATUSES));
    },
    createIfMissing(capability, secret) {
      return invokeAccountlessInstallationSecretAsync(
        createIfMissing,
        capability,
        secret,
      ).then((response) => checkedStatus(response, CREATE_IF_MISSING_STATUSES));
    },
    deleteExact(capability, secret) {
      return invokeAccountlessInstallationSecretAsync(
        deleteExact,
        capability,
        secret,
      ).then((response) => checkedStatus(response, DELETE_EXACT_STATUSES));
    },
  });
}
