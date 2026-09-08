import { Socket } from "node:net";

import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "./keychain-capabilities.js";

export const WINDOWS_ACCOUNT_OBSERVATION_BROKER_INTEGRATION_STATUS = "dormant";
export const WINDOWS_ACCOUNT_OBSERVATION_BROKER_FD_ENV =
  "USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_BROKER_FD";
export const WINDOWS_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION = 1;
export const WINDOWS_ACCOUNT_OBSERVATION_BROKER_CAPABILITY =
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation;

const MAXIMUM_FRAME_BYTES = 4_096;
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

function validDescriptor(value) {
  return value === "4";
}

/**
 * Read only the explicit Windows FD4 announcement. A concurrent macOS/Linux
 * credential broker announcement is malformed, not an invitation to fall
 * back to a child-side loader or generic Credential Manager path.
 */
export function windowsAccountObservationBrokerConfiguration(environment = process.env) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    fail("invalid_configuration");
  }
  let raw;
  let macBroker;
  let linuxBroker;
  try {
    raw = environment[WINDOWS_ACCOUNT_OBSERVATION_BROKER_FD_ENV];
    macBroker = environment.USAGE_MONITOR_KEYCHAIN_BROKER_FD;
    linuxBroker = environment.USAGE_MONITOR_LINUX_SECRET_SERVICE_BROKER_FD;
  } catch {
    fail("invalid_configuration");
  }
  if (raw === undefined || raw === null) return null;
  return Object.freeze({
    fd: macBroker === undefined && linuxBroker === undefined && validDescriptor(raw) ? 4 : null,
  });
}

export function encodeWindowsAccountObservationBrokerSecret(value) {
  if (!Buffer.isBuffer(value) || value.byteLength !== SECRET_BYTES) {
    fail("invalid_configuration");
  }
  const copied = Buffer.from(value);
  try {
    const encoded = copied.toString("base64url");
    if (Buffer.byteLength(encoded, "utf8") > MAXIMUM_FRAME_BYTES) fail("invalid_configuration");
    return encoded;
  } finally {
    copied.fill(0);
  }
}

export function decodeWindowsAccountObservationBrokerSecret(value) {
  if (typeof value !== "string" || value.length < 1
      || Buffer.byteLength(value, "utf8") > MAXIMUM_FRAME_BYTES) {
    fail("protocol");
  }
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

function defaultConnect({ fd }) {
  if (fd !== 4) fail("invalid_configuration");
  return new Socket({ fd, readable: true, writable: true });
}

function validOperation(operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)
      || (operation.op !== "read" && operation.op !== "create_if_missing")) {
    fail("invalid_configuration");
  }
  const expected = operation.op === "read" ? ["op"] : ["op", "secret"];
  if (Object.keys(operation).length !== expected.length
      || !expected.every((key) => Object.hasOwn(operation, key))
      || (operation.op === "create_if_missing" && typeof operation.secret !== "string")) {
    fail("invalid_configuration");
  }
}

function validateResponse(response, operation, expectedId) {
  if (!response || typeof response !== "object" || Array.isArray(response)
      || response.id !== expectedId || typeof response.ok !== "boolean") {
    return null;
  }
  if (response.ok === false) {
    return Object.keys(response).length === 3
      && typeof response.code === "string" && RESPONSE_ERROR_CODES.has(response.code)
      ? Object.freeze({ ok: false, code: response.code })
      : null;
  }
  if (operation.op === "read") {
    if (Object.keys(response).length !== 3 || !Object.hasOwn(response, "secret")
        || (response.secret !== null && typeof response.secret !== "string")) return null;
    if (response.secret !== null) {
      let decoded = null;
      try { decoded = decodeWindowsAccountObservationBrokerSecret(response.secret); }
      catch { return null; }
      finally { decoded?.fill(0); }
    }
    return Object.freeze({ ok: true, secret: response.secret });
  }
  return Object.keys(response).length === 3
    && typeof response.status === "string" && ["created", "existing"].includes(response.status)
    ? Object.freeze({ ok: true, status: response.status })
    : null;
}

/** One bounded ordered request/response transport over the inherited FD4. */
export function createWindowsAccountObservationBrokerTransport({
  fd = null,
  connect = defaultConnect,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  if ((fd !== null && fd !== 4) || typeof connect !== "function"
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    fail("invalid_configuration");
  }
  let socket = null;
  let received = "";
  let nextId = 1;
  let poisonedCode = null;
  const pending = [];

  function poison(code) {
    if (poisonedCode !== null) return;
    poisonedCode = ERROR_CODES.has(code) ? code : "unavailable";
    received = "";
    while (pending.length > 0) {
      const entry = pending.shift();
      clearTimeout(entry.timer);
      entry.reject(new WindowsAccountObservationBrokerError(poisonedCode));
    }
    try { socket?.destroy?.(); } catch { /* The inherited descriptor is gone. */ }
  }

  function consume(chunk) {
    if (poisonedCode !== null) return;
    received += String(chunk);
    let end;
    while ((end = received.indexOf("\n")) !== -1 && poisonedCode === null) {
      const line = received.slice(0, end);
      received = received.slice(end + 1);
      if (Buffer.byteLength(line, "utf8") + 1 > MAXIMUM_FRAME_BYTES) {
        poison("protocol");
        return;
      }
      let response;
      try { response = JSON.parse(line); } catch { poison("protocol"); return; }
      const entry = pending[0];
      const normalized = entry === undefined ? null
        : validateResponse(response, entry.operation, entry.id);
      if (normalized === null) { poison("protocol"); return; }
      pending.shift();
      clearTimeout(entry.timer);
      if (normalized.ok) entry.resolve(normalized);
      else entry.reject(new WindowsAccountObservationBrokerError(normalized.code));
    }
    if (Buffer.byteLength(received, "utf8") > MAXIMUM_FRAME_BYTES) poison("protocol");
  }

  function ensureSocket() {
    if (poisonedCode !== null) fail(poisonedCode);
    if (socket !== null) return socket;
    let created;
    try { created = connect({ fd }); } catch { poison("unavailable"); fail("unavailable"); }
    if (!created || typeof created.on !== "function" || typeof created.write !== "function") {
      poison("unavailable");
      fail("unavailable");
    }
    created.on("data", consume);
    created.on("error", () => poison("unavailable"));
    created.on("close", () => poison("unavailable"));
    created.on("end", () => poison("unavailable"));
    socket = created;
    return created;
  }

  async function request(operation) {
    validOperation(operation);
    if (fd !== 4) fail("invalid_configuration");
    if (poisonedCode !== null) fail(poisonedCode);
    if (!Number.isSafeInteger(nextId) || pending.length >= MAXIMUM_PENDING) fail("unavailable");
    const id = nextId;
    const frame = `${JSON.stringify({
      v: WINDOWS_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION,
      id,
      ...operation,
    })}\n`;
    if (Buffer.byteLength(frame, "utf8") > MAXIMUM_FRAME_BYTES) fail("invalid_configuration");
    const channel = ensureSocket();
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => poison("timeout"), timeoutMs);
      timer.unref?.();
      pending.push({ id, operation, resolve, reject, timer });
      try { channel.write(frame); } catch { poison("unavailable"); }
    });
  }

  function dispose() {
    poison("unavailable");
  }

  return Object.freeze({ request, dispose });
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

const sharedBackends = new Map();

/** Discover the explicit Windows FD4 announcement without any fallback path. */
export function createWindowsAccountObservationBrokerBackendFromEnvironment(
  environment = process.env,
) {
  const configuration = windowsAccountObservationBrokerConfiguration(environment);
  if (configuration === null) return null;
  const key = configuration.fd;
  if (!sharedBackends.has(key)) {
    sharedBackends.set(key, createWindowsAccountObservationBrokerBackend({
      transport: createWindowsAccountObservationBrokerTransport(configuration),
      available: configuration.fd !== null,
    }));
  }
  return sharedBackends.get(key);
}
