import { Socket } from "node:net";

import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "./keychain-capabilities.js";

// This is a source-only child-side transport for a later Linux Electron
// composition root. It never loads a Secret Service binding: the Electron
// parent owns that binding and its mutation lease.
export const LINUX_SECRET_SERVICE_BROKER_INTEGRATION_STATUS = "dormant";
export const LINUX_SECRET_SERVICE_BROKER_FD_ENV =
  "USAGE_MONITOR_LINUX_SECRET_SERVICE_BROKER_FD";
export const LINUX_SECRET_SERVICE_BROKER_PROTOCOL_VERSION = 1;

export const LINUX_SECRET_SERVICE_BROKER_CAPABILITY_NAMES = Object.freeze({
  exportIdentity: "export_identity",
  accountObservation: "account_observation",
});

export const LINUX_SECRET_SERVICE_BROKER_CAPABILITIES = Object.freeze({
  exportIdentity: EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity,
  accountObservation: EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation,
});

const MAXIMUM_FRAME_BYTES = 4_096;
const MAXIMUM_PENDING = 32;
const SECRET_BYTES = 32;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MUTATION_OPERATIONS = new Set([
  "create_if_missing",
  "replace_exact",
  "delete_exact",
]);
const ERROR_CODES = new Set([
  "invalid_configuration",
  "unavailable",
  "locked",
  "denied",
  "recovery_required",
  "timeout",
  "protocol",
  "rejected",
]);
const RESPONSE_ERROR_CODES = new Set([
  "unavailable",
  "locked",
  "denied",
  "recovery_required",
]);
const trustedErrors = new WeakSet();

export class LinuxSecretServiceBrokerError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Linux Secret Service broker error code");
    }
    super("Linux Secret Service broker operation failed");
    this.name = "LinuxSecretServiceBrokerError";
    this.code = `linux_secret_service_broker_${code}`;
    trustedErrors.add(this);
  }
}

export function isLinuxSecretServiceBrokerError(error) {
  return Boolean(error
    && trustedErrors.has(error)
    && Object.getPrototypeOf(error) === LinuxSecretServiceBrokerError.prototype);
}

function fail(code) {
  throw new LinuxSecretServiceBrokerError(code);
}

function capabilityName(capability) {
  if (capability === LINUX_SECRET_SERVICE_BROKER_CAPABILITIES.exportIdentity) {
    return LINUX_SECRET_SERVICE_BROKER_CAPABILITY_NAMES.exportIdentity;
  }
  if (capability === LINUX_SECRET_SERVICE_BROKER_CAPABILITIES.accountObservation) {
    return LINUX_SECRET_SERVICE_BROKER_CAPABILITY_NAMES.accountObservation;
  }
  fail("invalid_configuration");
}

function validDescriptor(value) {
  return value === "4";
}

/**
 * Read only the Linux bridge announcement. A simultaneous macOS broker
 * announcement is malformed rather than a reason to select a fallback.
 */
export function linuxSecretServiceBrokerConfiguration(environment = process.env) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    fail("invalid_configuration");
  }
  let raw;
  let macBroker;
  try {
    raw = environment[LINUX_SECRET_SERVICE_BROKER_FD_ENV];
    macBroker = environment.USAGE_MONITOR_KEYCHAIN_BROKER_FD;
  } catch {
    fail("invalid_configuration");
  }
  if (raw === undefined || raw === null) return null;
  // A present but malformed announcement cannot fall back to any companion
  // credential path. Keep an unavailable binding so describe() is honest;
  // request() rejects before it can wrap an unconnected descriptor.
  return Object.freeze({
    fd: macBroker === undefined && validDescriptor(raw) ? 4 : null,
  });
}

/**
 * Canonically encode the existing Linux backend's 32-byte capability secret.
 * This uses the backend's byte contract rather than the legacy macOS wire's
 * 43-character string rule.
 */
export function encodeLinuxSecretServiceBrokerSecret(value) {
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

/** Decode the existing Linux backend's canonical 32-byte secret encoding. */
export function decodeLinuxSecretServiceBrokerSecret(value) {
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
  if (decoded.byteLength !== SECRET_BYTES
      || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    fail("protocol");
  }
  return decoded;
}

function defaultConnect({ fd }) {
  // The inherited descriptor is already one end of Electron's socketpair.
  // Constructing this socket never dials a path or network endpoint.
  if (fd !== 4) fail("invalid_configuration");
  return new Socket({ fd, readable: true, writable: true });
}

function validateResponse(response, operation, expectedId) {
  if (!response || typeof response !== "object" || Array.isArray(response)
      || response.id !== expectedId || typeof response.ok !== "boolean") {
    return null;
  }
  if (response.ok === false) {
    return Object.keys(response).length === 3
      && typeof response.code === "string"
      && RESPONSE_ERROR_CODES.has(response.code)
      ? Object.freeze({ ok: false, code: response.code })
      : null;
  }
  if (operation.op === "read") {
    if (Object.keys(response).length !== 3
        || !Object.hasOwn(response, "secret")
        || (response.secret !== null && typeof response.secret !== "string")) {
      return null;
    }
    if (response.secret !== null) {
      let decoded = null;
      try {
        decoded = decodeLinuxSecretServiceBrokerSecret(response.secret);
      } catch {
        return null;
      } finally {
        decoded?.fill(0);
      }
    }
    return Object.freeze({ ok: true, secret: response.secret });
  }
  const statuses = operation.op === "create_if_missing"
    ? new Set(["created", "existing"])
    : operation.op === "replace_exact"
      ? new Set(["replaced", "missing", "conflict"])
      : new Set(["deleted", "missing", "conflict"]);
  if (Object.keys(response).length !== 3
      || typeof response.status !== "string" || !statuses.has(response.status)) {
    return null;
  }
  return Object.freeze({ ok: true, status: response.status });
}

function validateOperation(operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)
      || !["read", ...MUTATION_OPERATIONS].includes(operation.op)
      || !Object.values(LINUX_SECRET_SERVICE_BROKER_CAPABILITY_NAMES)
        .includes(operation.capability)) {
    fail("invalid_configuration");
  }
  const expectedKeys = operation.op === "read"
    ? ["op", "capability"]
    : operation.op === "create_if_missing"
      ? ["op", "capability", "secret"]
      : operation.op === "replace_exact"
        ? ["op", "capability", "expected", "replacement"]
        : ["op", "capability", "expected"];
  if (Object.keys(operation).length !== expectedKeys.length
      || !expectedKeys.every((key) => Object.hasOwn(operation, key))) {
    fail("invalid_configuration");
  }
  for (const name of ["secret", "expected", "replacement"]) {
    if (Object.hasOwn(operation, name) && typeof operation[name] !== "string") {
      fail("invalid_configuration");
    }
  }
}

/**
 * One ordered request/response transport for one inherited descriptor. Any
 * malformed response, timeout, or socket failure poisons it permanently.
 */
export function createLinuxSecretServiceBrokerTransport({
  fd = null,
  connect = defaultConnect,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  if ((fd !== null && fd !== 4)
      || typeof connect !== "function"
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
    while (pending.length > 0) {
      const entry = pending.shift();
      clearTimeout(entry.timer);
      entry.reject(new LinuxSecretServiceBrokerError(poisonedCode));
    }
    try { socket?.destroy?.(); } catch { /* The descriptor is already gone. */ }
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
      const normalized = entry === undefined
        ? null
        : validateResponse(response, entry.operation, entry.id);
      if (normalized === null) { poison("protocol"); return; }
      pending.shift();
      clearTimeout(entry.timer);
      if (normalized.ok === false) {
        entry.reject(new LinuxSecretServiceBrokerError(normalized.code));
      } else {
        entry.resolve(normalized);
      }
    }
    if (Buffer.byteLength(received, "utf8") > MAXIMUM_FRAME_BYTES) {
      poison("protocol");
    }
  }

  function ensureSocket() {
    if (poisonedCode !== null) fail(poisonedCode);
    if (socket !== null) return socket;
    let created;
    try {
      created = connect({ fd });
    } catch {
      poison("unavailable");
      fail("unavailable");
    }
    if (!created || typeof created.on !== "function" || typeof created.write !== "function") {
      poison("unavailable");
      fail("unavailable");
    }
    created.on("data", consume);
    created.on("error", () => poison("unavailable"));
    created.on("close", () => poison("unavailable"));
    created.on("end", () => poison("unavailable"));
    // Keep the inherited private descriptor referenced while the companion is
    // using it. An unref here can let a just-started Node companion exit with
    // an unsettled request before the parent has a chance to answer it.
    socket = created;
    return created;
  }

  async function request(operation) {
    validateOperation(operation);
    if (fd !== 4) fail("invalid_configuration");
    if (poisonedCode !== null) fail(poisonedCode);
    if (!Number.isSafeInteger(nextId)) {
      fail("unavailable");
    }
    const id = nextId;
    const frame = `${JSON.stringify({
      v: LINUX_SECRET_SERVICE_BROKER_PROTOCOL_VERSION,
      id,
      ...operation,
    })}\n`;
    if (Buffer.byteLength(frame, "utf8") > MAXIMUM_FRAME_BYTES) fail("invalid_configuration");
    if (pending.length >= MAXIMUM_PENDING) fail("unavailable");
    const channel = ensureSocket();
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => poison("timeout"), timeoutMs);
      timer.unref?.();
      pending.push({ id, operation, resolve, reject, timer });
      try { channel.write(frame); } catch { poison("unavailable"); }
    });
  }

  return Object.freeze({ request });
}

function requestSecret(operation, capability, values) {
  const name = capabilityName(capability);
  const encoded = [];
  try {
    for (const value of values) encoded.push(encodeLinuxSecretServiceBrokerSecret(value));
    return Object.freeze({
      op: operation,
      capability: name,
      ...(operation === "create_if_missing" ? { secret: encoded[0] } : {}),
      ...(operation === "replace_exact"
        ? { expected: encoded[0], replacement: encoded[1] }
        : operation === "delete_exact" ? { expected: encoded[0] } : {}),
    });
  } finally {
    encoded.fill("");
  }
}

/** Fixed two-capability backend surface for the owned companion only. */
export function createLinuxSecretServiceBrokerBackend({
  transport,
  available = true,
} = {}) {
  if (!transport || typeof transport !== "object" || typeof transport.request !== "function") {
    fail("invalid_configuration");
  }
  if (typeof available !== "boolean") fail("invalid_configuration");
  return Object.freeze({
    async describe(capability) {
      capabilityName(capability);
      return Object.freeze({
        backend: "linux_secret_service_broker",
        status: available ? "available" : "unavailable",
      });
    },
    async read(capability) {
      const response = await transport.request(Object.freeze({
        op: "read",
        capability: capabilityName(capability),
      }));
      if (response.secret === null) return null;
      return decodeLinuxSecretServiceBrokerSecret(response.secret);
    },
    async createIfMissing(capability, secret) {
      const response = await transport.request(requestSecret("create_if_missing", capability, [secret]));
      return response.status;
    },
    async replaceExact(capability, expected, replacement) {
      const response = await transport.request(
        requestSecret("replace_exact", capability, [expected, replacement]),
      );
      return response.status;
    },
    async deleteExact(capability, expected) {
      const response = await transport.request(requestSecret("delete_exact", capability, [expected]));
      return response.status;
    },
  });
}

const sharedBackends = new Map();

/**
 * Discover the explicitly inherited Linux descriptor. Its absence means this
 * source-only transport is not configured; malformed presence never falls
 * back to a companion-side credential provider.
 */
export function createLinuxSecretServiceBrokerBackendFromEnvironment(
  environment = process.env,
) {
  const configuration = linuxSecretServiceBrokerConfiguration(environment);
  if (configuration === null) return null;
  const key = configuration.fd;
  if (!sharedBackends.has(key)) {
    sharedBackends.set(key, createLinuxSecretServiceBrokerBackend({
      transport: createLinuxSecretServiceBrokerTransport(configuration),
      available: configuration.fd !== null,
    }));
  }
  return sharedBackends.get(key);
}
