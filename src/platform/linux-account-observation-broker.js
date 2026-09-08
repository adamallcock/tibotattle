import {
  attachAccountObservationBrokerIpcServer,
  createAccountObservationBrokerIpcTransport,
  decodeAccountObservationBrokerSecret,
  encodeAccountObservationBrokerSecret,
  isAccountObservationBrokerIpcChannel,
} from "./account-observation-broker-ipc.js";
import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "./keychain-capabilities.js";

// The explicit Linux qualification composition supplies the inherited Node IPC
// marker. Normal production selection remains closed. This never loads libsecret,
// Keytar, the generic Linux broker, or a native binding.
export const LINUX_ACCOUNT_OBSERVATION_BROKER_INTEGRATION_STATUS = "qualification_only";
export const LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_ENV =
  "USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_BROKER_IPC";
export const LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER = "1";
export const LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_SCHEMA =
  "linux-account-observation-broker-ipc-v1";
export const LINUX_ACCOUNT_OBSERVATION_BROKER_REQUEST_KIND = "request-v1";
export const LINUX_ACCOUNT_OBSERVATION_BROKER_RESPONSE_KIND = "response-v1";
export const LINUX_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION = 1;
export const LINUX_ACCOUNT_OBSERVATION_BROKER_CAPABILITY =
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const ERROR_CODES = new Set([
  "invalid_configuration",
  "unavailable",
  "recovery_required",
  "timeout",
  "protocol",
]);
const RESPONSE_ERROR_CODES = new Set([
  "unavailable",
  "recovery_required",
]);
const PROTOCOL = Object.freeze({
  schema: LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_SCHEMA,
  requestKind: LINUX_ACCOUNT_OBSERVATION_BROKER_REQUEST_KIND,
  responseKind: LINUX_ACCOUNT_OBSERVATION_BROKER_RESPONSE_KIND,
  version: LINUX_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION,
});
const trustedErrors = new WeakSet();
const trustedBackends = new WeakSet();

export class LinuxAccountObservationBrokerError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Linux account observation broker error code");
    }
    super("Linux account observation broker operation failed");
    this.name = "LinuxAccountObservationBrokerError";
    this.code = `linux_account_observation_broker_${code}`;
    trustedErrors.add(this);
  }
}

export function isLinuxAccountObservationBrokerError(error) {
  return Boolean(error
    && trustedErrors.has(error)
    && Object.getPrototypeOf(error) === LinuxAccountObservationBrokerError.prototype);
}

export function isLinuxAccountObservationBrokerBackend(backend) {
  return Boolean(backend
    && trustedBackends.has(backend)
    && Object.getPrototypeOf(backend) === Object.prototype);
}

function fail(code) {
  throw new LinuxAccountObservationBrokerError(code);
}

function createError(code) {
  return new LinuxAccountObservationBrokerError(code);
}

/**
 * Read only the explicit inherited Linux observation IPC announcement. A
 * generic Linux FD4, macOS FD4, or Windows observation announcement is a
 * malformed configuration; it cannot select any child-side fallback.
 */
export function linuxAccountObservationBrokerConfiguration(environment = process.env) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    fail("invalid_configuration");
  }
  let raw;
  let macBroker;
  let genericLinuxBroker;
  let windowsIpc;
  let windowsLegacyFd;
  try {
    raw = environment[LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_ENV];
    macBroker = environment.USAGE_MONITOR_KEYCHAIN_BROKER_FD;
    genericLinuxBroker = environment.USAGE_MONITOR_LINUX_SECRET_SERVICE_BROKER_FD;
    windowsIpc = environment.USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC;
    windowsLegacyFd = environment.USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_BROKER_FD;
  } catch {
    fail("invalid_configuration");
  }
  if (raw === undefined || raw === null) return null;
  return Object.freeze({
    ipc: raw === LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER
      && macBroker === undefined && genericLinuxBroker === undefined
      && windowsIpc === undefined && windowsLegacyFd === undefined,
  });
}

export function encodeLinuxAccountObservationBrokerSecret(value) {
  return encodeAccountObservationBrokerSecret(value, fail);
}

export function decodeLinuxAccountObservationBrokerSecret(value) {
  return decodeAccountObservationBrokerSecret(value, fail);
}

/** Internal channel predicate shared with the Electron-owned server wrapper. */
export function isLinuxAccountObservationBrokerIpcChannel(channel) {
  return isAccountObservationBrokerIpcChannel(channel);
}

/**
 * One bounded ordered request/response transport over the inherited Node IPC
 * channel. Other schemas, including FD3 accountless messages, are ignored.
 */
export function createLinuxAccountObservationBrokerTransport({
  channel = null,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  return createAccountObservationBrokerIpcTransport({
    channel,
    timeoutMs,
    protocol: PROTOCOL,
    errorCodes: ERROR_CODES,
    responseErrorCodes: RESPONSE_ERROR_CODES,
    fail,
    createError,
    decodeSecret: decodeLinuxAccountObservationBrokerSecret,
  });
}

/** Internal server adapter for the Electron-owned fixed Linux facade. */
export function attachLinuxAccountObservationBrokerIpcServer({
  channel,
  backend,
  mapBackendError,
  disposeBackend = undefined,
} = {}) {
  return attachAccountObservationBrokerIpcServer({
    channel,
    backend,
    protocol: PROTOCOL,
    responseErrorCodes: RESPONSE_ERROR_CODES,
    fail,
    encodeSecret: encodeLinuxAccountObservationBrokerSecret,
    decodeSecret: decodeLinuxAccountObservationBrokerSecret,
    mapBackendError,
    ...(disposeBackend === undefined ? {} : { disposeBackend }),
  });
}

function assertCapability(capability) {
  if (capability !== LINUX_ACCOUNT_OBSERVATION_BROKER_CAPABILITY) {
    fail("invalid_configuration");
  }
}

/** Fixed one-capability child-side backend. It never loads Secret Service code. */
export function createLinuxAccountObservationBrokerBackend({
  transport,
  available = true,
} = {}) {
  if (!transport || typeof transport !== "object" || typeof transport.request !== "function"
      || typeof available !== "boolean") {
    fail("invalid_configuration");
  }
  const backend = Object.freeze({
    async describe(capability) {
      assertCapability(capability);
      return Object.freeze({
        backend: "linux_account_observation_broker",
        status: available ? "available" : "unavailable",
      });
    },
    async read(capability) {
      assertCapability(capability);
      if (!available) fail("unavailable");
      const response = await transport.request(Object.freeze({ op: "read" }));
      return response.secret === null ? null : decodeLinuxAccountObservationBrokerSecret(response.secret);
    },
    async createIfMissing(capability, secret) {
      assertCapability(capability);
      if (!available) fail("unavailable");
      return (await transport.request(Object.freeze({
        op: "create_if_missing",
        secret: encodeLinuxAccountObservationBrokerSecret(secret),
      }))).status;
    },
    available,
  });
  trustedBackends.add(backend);
  return backend;
}

const sharedBackends = new WeakMap();

/** Discover only the explicit inherited Node IPC announcement, with no fallback. */
export function createLinuxAccountObservationBrokerBackendFromEnvironment(
  environment = process.env,
  channel = process,
) {
  const configuration = linuxAccountObservationBrokerConfiguration(environment);
  if (configuration === null) return null;
  if (configuration.ipc !== true || !isAccountObservationBrokerIpcChannel(channel)) {
    return createLinuxAccountObservationBrokerBackend({
      transport: Object.freeze({ async request() { fail("unavailable"); } }),
      available: false,
    });
  }
  if (!sharedBackends.has(channel)) {
    sharedBackends.set(channel, createLinuxAccountObservationBrokerBackend({
      transport: createLinuxAccountObservationBrokerTransport({ channel }),
    }));
  }
  return sharedBackends.get(channel);
}
