import { isProxy } from "node:util/types";

import {
  loadLinuxCredentialMutexBinding,
} from "./linux-credential-mutex.js";

const ERROR_CODES = new Set([
  "unsupported_platform",
  "unsupported_architecture",
  "invalid_configuration",
  "binding_unavailable",
  "binding_invalid",
  "state_invalid",
  "state_unavailable",
  "operation_failed",
]);
const OPTION_KEYS = new Set([
  "platform",
  "architecture",
  "binding",
  "loadBinding",
]);
const trustedErrors = new WeakSet();

export class LinuxCredentialStateError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Linux credential state error code");
    }
    super("Linux credential state preparation failed");
    this.name = "LinuxCredentialStateError";
    this.code = `linux_credential_state_${code}`;
    trustedErrors.add(this);
  }
}

export function isLinuxCredentialStateError(error) {
  return Boolean(error
    && trustedErrors.has(error)
    && Object.getPrototypeOf(error) === LinuxCredentialStateError.prototype);
}

function fail(code) {
  throw new LinuxCredentialStateError(code);
}

function readDataOptions(options) {
  if (isProxy(options)) return null;
  let descriptors;
  try {
    const prototype = Object.getPrototypeOf(options);
    if (prototype !== Object.prototype && prototype !== null) return null;
    descriptors = Object.getOwnPropertyDescriptors(options);
  } catch {
    return null;
  }
  const keys = Reflect.ownKeys(descriptors);
  if (!keys.every((key) => typeof key === "string" && OPTION_KEYS.has(key))) {
    return null;
  }
  if (!keys.every((key) => {
    const descriptor = descriptors[key];
    return descriptor !== undefined
      && Object.hasOwn(descriptor, "value")
      && !Object.hasOwn(descriptor, "get")
      && !Object.hasOwn(descriptor, "set");
  })) {
    return null;
  }
  return Object.freeze(Object.fromEntries(
    keys.map((key) => [key, descriptors[key].value]),
  ));
}

function nativeFailure(error) {
  let code;
  try {
    code = error?.code;
  } catch {
    return "operation_failed";
  }
  if (code === "LINUX_CREDENTIAL_MUTEX_STATE_INVALID") return "state_invalid";
  if (code === "LINUX_CREDENTIAL_MUTEX_STATE_UNAVAILABLE") return "state_unavailable";
  return "operation_failed";
}

function snapshotBinding(binding) {
  let prepare;
  let contractVersion;
  let crossProcessSafe;
  let sameNetworkNamespaceOnly;
  let durableMarker;
  let productionSafe;
  try {
    prepare = binding?.prepareLinuxCredentialState;
    contractVersion = binding?.credentialMutexContractVersion;
    crossProcessSafe = binding?.credentialMutexCrossProcessSafe;
    sameNetworkNamespaceOnly = binding?.credentialMutexSameNetworkNamespaceOnly;
    durableMarker = binding?.credentialMutexDurableMarker;
    productionSafe = binding?.productionSafe;
  } catch {
    fail("binding_invalid");
  }
  if (typeof prepare !== "function"
      || contractVersion !== "linux-credential-mutex-v1"
      || crossProcessSafe !== true
      || sameNetworkNamespaceOnly !== true
      || durableMarker !== true
      || productionSafe !== false) {
    fail("binding_invalid");
  }
  try {
    return Object.freeze({ prepare: prepare.bind(binding) });
  } catch {
    fail("binding_invalid");
  }
}

function invoke(native) {
  try {
    const result = native.prepare();
    if (result !== undefined
        || (result !== null
          && (typeof result === "object" || typeof result === "function")
          && typeof result.then === "function")) {
      fail("operation_failed");
    }
  } catch (error) {
    if (isLinuxCredentialStateError(error)) throw error;
    fail(nativeFailure(error));
  }
}

/**
 * Fixed, main-process-only preparation authority for the Linux credential
 * state tree. It has no pathname, credential, capability, or backend-choice
 * argument. The loaded native binding performs XDG resolution, safe creation,
 * and revalidation; this facade only verifies the fixed binding contract and
 * maps content-free native outcomes.
 */
export function prepareLinuxCredentialState(options = {}) {
  if (!options
      || typeof options !== "object"
      || Array.isArray(options)) {
    fail("invalid_configuration");
  }
  const values = readDataOptions(options);
  if (values === null) fail("invalid_configuration");
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
    } = values);
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
  invoke(snapshotBinding(selectedBinding));
}
