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
const MAXIMUM_PENDING = 32;
const SECRET_BYTES = 32;
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

function record(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function exact(value, keys) {
  try {
    return record(value)
      && Object.keys(value).length === keys.length
      && keys.every((key) => Object.hasOwn(value, key));
  } catch {
    return false;
  }
}

function validId(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000;
}

function validIpcChannel(channel) {
  try {
    return record(channel)
      && channel.connected !== false
      && typeof channel.on === "function"
      && typeof channel.off === "function"
      && typeof channel.send === "function";
  } catch {
    return false;
  }
}

function isBrokerMessage(value) {
  try {
    return record(value)
      && value.schemaVersion === WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_SCHEMA;
  } catch {
    return false;
  }
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
  if (!Buffer.isBuffer(value) || value.byteLength !== SECRET_BYTES) {
    fail("invalid_configuration");
  }
  const copied = Buffer.from(value);
  try {
    return copied.toString("base64url");
  } finally {
    copied.fill(0);
  }
}

export function decodeWindowsAccountObservationBrokerSecret(value) {
  if (typeof value !== "string" || value.length !== 43) fail("protocol");
  let decoded;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    fail("protocol");
  }
  if (decoded.byteLength !== SECRET_BYTES || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    fail("protocol");
  }
  return decoded;
}

function validOperation(operation) {
  if (!record(operation)
      || (operation.op !== "read" && operation.op !== "create_if_missing")) {
    fail("invalid_configuration");
  }
  const expected = operation.op === "read" ? ["op"] : ["op", "secret"];
  if (!exact(operation, expected)
      || (operation.op === "create_if_missing" && typeof operation.secret !== "string")) {
    fail("invalid_configuration");
  }
}

function validateResponse(response, operation, expectedId) {
  if (!exact(response, ["schemaVersion", "kind", "v", "id", "ok", "secret"])
      && !exact(response, ["schemaVersion", "kind", "v", "id", "ok", "status"])
      && !exact(response, ["schemaVersion", "kind", "v", "id", "ok", "code"])) {
    return null;
  }
  if (response.schemaVersion !== WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_SCHEMA
      || response.kind !== WINDOWS_ACCOUNT_OBSERVATION_BROKER_RESPONSE_KIND
      || response.v !== WINDOWS_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION
      || response.id !== expectedId || typeof response.ok !== "boolean") {
    return null;
  }
  if (response.ok === false) {
    return Object.keys(response).length === 6
      && typeof response.code === "string" && RESPONSE_ERROR_CODES.has(response.code)
      ? Object.freeze({ ok: false, code: response.code })
      : null;
  }
  if (operation.op === "read") {
    if (Object.keys(response).length !== 6 || !Object.hasOwn(response, "secret")
        || (response.secret !== null && typeof response.secret !== "string")) return null;
    if (response.secret !== null) {
      let decoded = null;
      try { decoded = decodeWindowsAccountObservationBrokerSecret(response.secret); }
      catch { return null; }
      finally { decoded?.fill(0); }
    }
    return Object.freeze({ ok: true, secret: response.secret });
  }
  return Object.keys(response).length === 6
    && typeof response.status === "string" && ["created", "existing"].includes(response.status)
    ? Object.freeze({ ok: true, status: response.status })
    : null;
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
  if (!validIpcChannel(channel)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    fail("invalid_configuration");
  }
  let nextId = 1;
  let poisonedCode = null;
  const pending = [];

  function poison(code) {
    if (poisonedCode !== null) return;
    poisonedCode = ERROR_CODES.has(code) ? code : "unavailable";
    try { channel.off("message", onMessage); } catch { /* Channel is already closing. */ }
    try { channel.off("disconnect", onDisconnect); } catch { /* Channel is already closing. */ }
    while (pending.length > 0) {
      const entry = pending.shift();
      clearTimeout(entry.timer);
      entry.reject(new WindowsAccountObservationBrokerError(poisonedCode));
    }
  }

  function onMessage(message) {
    if (poisonedCode !== null || !isBrokerMessage(message)) return;
    const entry = pending[0];
    const normalized = entry === undefined ? null
      : validateResponse(message, entry.operation, entry.id);
    if (normalized === null) {
      poison("protocol");
      return;
    }
    pending.shift();
    clearTimeout(entry.timer);
    if (normalized.ok) entry.resolve(normalized);
    else entry.reject(new WindowsAccountObservationBrokerError(normalized.code));
  }

  function onDisconnect() {
    poison("unavailable");
  }

  channel.on("message", onMessage);
  channel.on("disconnect", onDisconnect);

  async function request(operation) {
    validOperation(operation);
    if (poisonedCode !== null) fail(poisonedCode);
    if (!validId(nextId) || pending.length >= MAXIMUM_PENDING) fail("unavailable");
    const id = nextId;
    const frame = Object.freeze({
      schemaVersion: WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_SCHEMA,
      kind: WINDOWS_ACCOUNT_OBSERVATION_BROKER_REQUEST_KIND,
      v: WINDOWS_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION,
      id,
      ...operation,
    });
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => poison("timeout"), timeoutMs);
      timer.unref?.();
      pending.push({ id, operation, resolve, reject, timer });
      try {
        if (channel.connected === false) throw new Error("channel closed");
        channel.send(frame, (error) => {
          if (error) poison("unavailable");
        });
      } catch {
        poison("unavailable");
      }
    });
  }

  return Object.freeze({
    request,
    dispose() { poison("unavailable"); },
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
  if (configuration.ipc !== true || !validIpcChannel(channel)) {
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
