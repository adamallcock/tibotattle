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

export const WINDOWS_ACCOUNT_OBSERVATION_BROKER_INTEGRATION_STATUS = "dormant";
export const WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_ENV =
  "USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC";
export const WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER = "1";
export const WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_SCHEMA =
  "windows-account-observation-broker-ipc-v1";
export const WINDOWS_ACCOUNT_OBSERVATION_BROKER_REQUEST_KIND = "request-v1";
export const WINDOWS_ACCOUNT_OBSERVATION_BROKER_RESPONSE_KIND = "response-v1";
export const WINDOWS_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION = 1;
export const WINDOWS_ACCOUNT_OBSERVATION_BROKER_CAPABILITY =
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation;

const LEGACY_FD_ENV = "USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_BROKER_FD";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const ERROR_CODES = new Set([
  "invalid_configuration",
  "unavailable",
  "locked",
  "denied",
  "recovery_required",
  "timeout",
  "protocol",
]);
const RESPONSE_ERROR_CODES = new Set([
  "unavailable",
  "locked",
  "denied",
  "recovery_required",
]);
const PROTOCOL = Object.freeze({
  schema: WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_SCHEMA,
  requestKind: WINDOWS_ACCOUNT_OBSERVATION_BROKER_REQUEST_KIND,
  responseKind: WINDOWS_ACCOUNT_OBSERVATION_BROKER_RESPONSE_KIND,
  version: WINDOWS_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION,
});
const trustedErrors = new WeakSet();
const trustedBackends = new WeakSet();

export class WindowsAccountObservationBrokerError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Windows account observation broker error code");
    }
    super("Windows account observation broker operation failed");
    this.name = "WindowsAccountObservationBrokerError";
    this.code = `windows_account_observation_broker_${code}`;
    trustedErrors.add(this);
  }
}

export function isWindowsAccountObservationBrokerError(error) {
  return Boolean(error
    && trustedErrors.has(error)
    && Object.getPrototypeOf(error) === WindowsAccountObservationBrokerError.prototype);
}

export function isWindowsAccountObservationBrokerBackend(backend) {
  return Boolean(backend
    && trustedBackends.has(backend)
    && Object.getPrototypeOf(backend) === Object.prototype);
}

function fail(code) {
  throw new WindowsAccountObservationBrokerError(code);
}

function createError(code) {
  return new WindowsAccountObservationBrokerError(code);
}

/**
 * Read only the explicit, inherited Node IPC announcement. The retired FD4
 * environment name and any other credential broker announcement are malformed;
 * neither can select a child-side native or socket fallback.
 */
export function windowsAccountObservationBrokerConfiguration(environment = process.env) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    fail("invalid_configuration");
  }
  let raw;
  let legacyFd;
  let macBroker;
  let linuxBroker;
  try {
    raw = environment[WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_ENV];
    legacyFd = environment[LEGACY_FD_ENV];
    macBroker = environment.USAGE_MONITOR_KEYCHAIN_BROKER_FD;
    linuxBroker = environment.USAGE_MONITOR_LINUX_SECRET_SERVICE_BROKER_FD;
  } catch {
    fail("invalid_configuration");
  }
  if (raw === undefined || raw === null) return null;
  return Object.freeze({
    ipc: raw === WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER
      && legacyFd === undefined && macBroker === undefined && linuxBroker === undefined,
  });
}

export function encodeWindowsAccountObservationBrokerSecret(value) {
  return encodeAccountObservationBrokerSecret(value, fail);
}

export function decodeWindowsAccountObservationBrokerSecret(value) {
  return decodeAccountObservationBrokerSecret(value, fail);
}

/** Internal channel predicate shared with the Electron-owned server wrapper. */
export function isWindowsAccountObservationBrokerIpcChannel(channel) {
  return isAccountObservationBrokerIpcChannel(channel);
}

/**
 * One bounded ordered request/response transport over the owning Node IPC
 * channel. It ignores other closed schemas so FD3 accountless traffic remains
 * independent, while malformed messages in this schema poison only this route.
 */
export function createWindowsAccountObservationBrokerTransport({
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
    decodeSecret: decodeWindowsAccountObservationBrokerSecret,
  });
}

/**
 * Internal server adapter for the Electron-owned Windows broker wrapper. It
 * preserves the fixed schema and error class while sharing only transport
 * mechanics with the Linux observation wrapper.
 */
export function attachWindowsAccountObservationBrokerIpcServer({
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
    encodeSecret: encodeWindowsAccountObservationBrokerSecret,
    decodeSecret: decodeWindowsAccountObservationBrokerSecret,
    mapBackendError,
    ...(disposeBackend === undefined ? {} : { disposeBackend }),
  });
}

function assertCapability(capability) {
  if (capability !== WINDOWS_ACCOUNT_OBSERVATION_BROKER_CAPABILITY) {
    fail("invalid_configuration");
  }
}

/** Fixed one-capability child-side backend. It never loads Keytar or native code. */
export function createWindowsAccountObservationBrokerBackend({
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
        backend: "windows_account_observation_broker",
        status: available ? "available" : "unavailable",
      });
    },
    async read(capability) {
      assertCapability(capability);
      if (!available) fail("unavailable");
      const response = await transport.request(Object.freeze({ op: "read" }));
      return response.secret === null ? null : decodeWindowsAccountObservationBrokerSecret(response.secret);
    },
    async createIfMissing(capability, secret) {
      assertCapability(capability);
      if (!available) fail("unavailable");
      return (await transport.request(Object.freeze({
        op: "create_if_missing",
        secret: encodeWindowsAccountObservationBrokerSecret(secret),
      }))).status;
    },
    available,
    parentAuthoritativeMutationLease: true,
  });
  trustedBackends.add(backend);
  return backend;
}

const sharedBackends = new WeakMap();

/** Discover only the explicit inherited Node IPC announcement, without FD fallback. */
export function createWindowsAccountObservationBrokerBackendFromEnvironment(
  environment = process.env,
  channel = process,
) {
  const configuration = windowsAccountObservationBrokerConfiguration(environment);
  if (configuration === null) return null;
  if (configuration.ipc !== true || !isAccountObservationBrokerIpcChannel(channel)) {
    return createWindowsAccountObservationBrokerBackend({
      transport: Object.freeze({ async request() { fail("unavailable"); } }),
      available: false,
    });
  }
  if (!sharedBackends.has(channel)) {
    sharedBackends.set(channel, createWindowsAccountObservationBrokerBackend({
      transport: createWindowsAccountObservationBrokerTransport({ channel }),
    }));
  }
  return sharedBackends.get(channel);
}
