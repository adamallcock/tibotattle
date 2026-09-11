const MAXIMUM_PENDING = 32;
const SECRET_BYTES = 32;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAXIMUM_REQUEST_TIMEOUT_MS = 60_000;
const MAXIMUM_ID = 1_000_000_000;
const OPERATIONS = new Set(["read", "create_if_missing"]);

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
  return Number.isSafeInteger(value) && value > 0 && value <= MAXIMUM_ID;
}

function validProtocol(protocol) {
  try {
    return exact(protocol, ["schema", "requestKind", "responseKind", "version"])
      && [protocol.schema, protocol.requestKind, protocol.responseKind]
        .every((value) => typeof value === "string" && value.length > 0 && value.length <= 128)
      && Number.isSafeInteger(protocol.version) && protocol.version > 0;
  } catch {
    return false;
  }
}

function validErrorCodes(value) {
  try {
    return value instanceof Set
      && value.has("unavailable")
      && [...value].every((code) => typeof code === "string" && code.length > 0);
  } catch {
    return false;
  }
}

function normalizedErrorCode(code, accepted) {
  try {
    return accepted.has(code) ? code : "unavailable";
  } catch {
    return "unavailable";
  }
}

function validSecret(value, decodeSecret) {
  let decoded = null;
  try {
    decoded = decodeSecret(value);
    return Buffer.isBuffer(decoded) && decoded.byteLength === SECRET_BYTES;
  } catch {
    return false;
  } finally {
    decoded?.fill(0);
  }
}

function validOperation(operation, decodeSecret) {
  try {
    if (!record(operation) || !OPERATIONS.has(operation.op)) return false;
    const keys = operation.op === "read" ? ["op"] : ["op", "secret"];
    return exact(operation, keys)
      && (operation.op !== "create_if_missing" || validSecret(operation.secret, decodeSecret));
  } catch {
    return false;
  }
}

function isBrokerMessage(message, protocol) {
  try {
    return record(message) && message.schemaVersion === protocol.schema;
  } catch {
    return false;
  }
}

function validResponse(response, operation, expectedId, protocol, responseErrorCodes, decodeSecret) {
  if (!exact(response, ["schemaVersion", "kind", "v", "id", "ok", "secret"])
      && !exact(response, ["schemaVersion", "kind", "v", "id", "ok", "status"])
      && !exact(response, ["schemaVersion", "kind", "v", "id", "ok", "code"])) {
    return null;
  }
  if (response.schemaVersion !== protocol.schema
      || response.kind !== protocol.responseKind
      || response.v !== protocol.version
      || response.id !== expectedId || typeof response.ok !== "boolean") {
    return null;
  }
  if (response.ok === false) {
    return Object.keys(response).length === 6
      && typeof response.code === "string" && responseErrorCodes.has(response.code)
      ? Object.freeze({ ok: false, code: response.code })
      : null;
  }
  if (operation.op === "read") {
    if (Object.keys(response).length !== 6 || !Object.hasOwn(response, "secret")
        || (response.secret !== null && !validSecret(response.secret, decodeSecret))) {
      return null;
    }
    return Object.freeze({ ok: true, secret: response.secret });
  }
  return Object.keys(response).length === 6
    && typeof response.status === "string" && ["created", "existing"].includes(response.status)
    ? Object.freeze({ ok: true, status: response.status })
    : null;
}

/** Validate the inherited Node IPC channel used only by fixed observation brokers. */
export function isAccountObservationBrokerIpcChannel(channel) {
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

/** Canonically encode a fixed 32-byte account-observation root for Node IPC. */
export function encodeAccountObservationBrokerSecret(value, fail) {
  if (typeof fail !== "function" || !Buffer.isBuffer(value) || value.byteLength !== SECRET_BYTES) {
    fail?.("invalid_configuration");
    throw new TypeError("account-observation broker configuration is invalid");
  }
  const copied = Buffer.from(value);
  try {
    return copied.toString("base64url");
  } finally {
    copied.fill(0);
  }
}

/** Decode only the canonical 32-byte account-observation root representation. */
export function decodeAccountObservationBrokerSecret(value, fail) {
  if (typeof fail !== "function" || typeof value !== "string" || value.length !== 43) {
    fail?.("protocol");
    throw new TypeError("account-observation broker protocol is invalid");
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

/**
 * Fixed, bounded and ordered Node-IPC client transport for one
 * account-observation record. Platform wrappers provide their closed schema
 * and error class; this helper has no platform selection or native access.
 */
export function createAccountObservationBrokerIpcTransport({
  channel = null,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  protocol,
  errorCodes,
  responseErrorCodes,
  fail,
  createError,
  decodeSecret,
} = {}) {
  if (!isAccountObservationBrokerIpcChannel(channel)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAXIMUM_REQUEST_TIMEOUT_MS
      || !validProtocol(protocol) || !validErrorCodes(errorCodes)
      || !validErrorCodes(responseErrorCodes) || typeof fail !== "function"
      || typeof createError !== "function" || typeof decodeSecret !== "function") {
    fail?.("invalid_configuration");
    throw new TypeError("account-observation broker configuration is invalid");
  }
  let nextId = 1;
  let poisonedCode = null;
  const pending = [];

  function poison(code) {
    if (poisonedCode !== null) return;
    poisonedCode = normalizedErrorCode(code, errorCodes);
    try { channel.off("message", onMessage); } catch { /* Channel is already closing. */ }
    try { channel.off("disconnect", onDisconnect); } catch { /* Channel is already closing. */ }
    while (pending.length > 0) {
      const entry = pending.shift();
      clearTimeout(entry.timer);
      entry.reject(createError(poisonedCode));
    }
  }

  function onMessage(message) {
    if (poisonedCode !== null || !isBrokerMessage(message, protocol)) return;
    const entry = pending[0];
    const normalized = entry === undefined
      ? null
      : validResponse(message, entry.operation, entry.id, protocol, responseErrorCodes, decodeSecret);
    if (normalized === null) {
      poison("protocol");
      return;
    }
    pending.shift();
    clearTimeout(entry.timer);
    if (normalized.ok) entry.resolve(normalized);
    else entry.reject(createError(normalized.code));
  }

  function onDisconnect() {
    poison("unavailable");
  }

  channel.on("message", onMessage);
  channel.on("disconnect", onDisconnect);

  async function request(operation) {
    if (!validOperation(operation, decodeSecret)) fail("invalid_configuration");
    if (poisonedCode !== null) fail(poisonedCode);
    if (!validId(nextId) || pending.length >= MAXIMUM_PENDING) fail("unavailable");
    const id = nextId;
    const frame = Object.freeze({
      schemaVersion: protocol.schema,
      kind: protocol.requestKind,
      v: protocol.version,
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

/**
 * Fixed Node-IPC parent responder shared by platform-specific observation
 * brokers. The supplied backend has already been capability-restricted by
 * its wrapper; this helper cannot route any other capability or mutation.
 */
export function attachAccountObservationBrokerIpcServer({
  channel,
  backend,
  protocol,
  responseErrorCodes,
  fail,
  encodeSecret,
  decodeSecret,
  mapBackendError,
  disposeBackend = () => {},
} = {}) {
  if (!isAccountObservationBrokerIpcChannel(channel)
      || !backend || typeof backend !== "object"
      || typeof backend.read !== "function" || typeof backend.createIfMissing !== "function"
      || !validProtocol(protocol) || !validErrorCodes(responseErrorCodes)
      || typeof fail !== "function" || typeof encodeSecret !== "function"
      || typeof decodeSecret !== "function" || typeof mapBackendError !== "function"
      || typeof disposeBackend !== "function") {
    fail?.("invalid_configuration");
    throw new TypeError("account-observation broker configuration is invalid");
  }
  let closed = false;
  let backendClosed = false;
  let nextId = 1;
  let active = false;
  const pending = [];

  function closeBackendWhenIdle() {
    if (!closed || backendClosed || active) return;
    backendClosed = true;
    try { disposeBackend(backend); } catch { /* The owned channel is closing. */ }
  }

  function dispose() {
    if (closed) return;
    closed = true;
    pending.length = 0;
    try { channel.off("message", consume); } catch { /* Channel is already closing. */ }
    try { channel.off("disconnect", dispose); } catch { /* Channel is already closing. */ }
    closeBackendWhenIdle();
  }

  function send(message) {
    try {
      if (channel.connected === false) throw new Error("channel closed");
      channel.send(message, (error) => {
        if (error) dispose();
      });
    } catch {
      dispose();
    }
  }

  function response(id, value) {
    if (closed) return;
    send(Object.freeze({
      schemaVersion: protocol.schema,
      kind: protocol.responseKind,
      v: protocol.version,
      id,
      ...value,
    }));
  }

  async function execute(request) {
    if (request.op === "read") {
      let secret = null;
      try {
        secret = await backend.read();
        return Object.freeze({
          ok: true,
          secret: secret === null ? null : encodeSecret(secret),
        });
      } finally {
        if (Buffer.isBuffer(secret)) secret.fill(0);
      }
    }
    let secret = null;
    try {
      secret = decodeSecret(request.secret);
      const status = await backend.createIfMissing(secret);
      if (status !== "created" && status !== "existing") fail("unavailable");
      return Object.freeze({ ok: true, status });
    } finally {
      secret?.fill(0);
    }
  }

  async function drain() {
    if (active || closed) return;
    active = true;
    try {
      while (pending.length > 0 && !closed) {
        const request = pending.shift();
        let value;
        try {
          value = await execute(request);
        } catch (error) {
          value = Object.freeze({
            ok: false,
            code: normalizedErrorCode(mapBackendError(error), responseErrorCodes),
          });
        }
        response(request.id, value);
      }
    } finally {
      active = false;
      closeBackendWhenIdle();
    }
  }

  function validRequest(frame) {
    if (!record(frame)
        || frame.schemaVersion !== protocol.schema
        || frame.kind !== protocol.requestKind
        || frame.v !== protocol.version
        || frame.id !== nextId || !OPERATIONS.has(frame.op)) {
      return false;
    }
    const keys = frame.op === "read"
      ? ["schemaVersion", "kind", "v", "id", "op"]
      : ["schemaVersion", "kind", "v", "id", "op", "secret"];
    return exact(frame, keys)
      && (frame.op !== "create_if_missing" || validSecret(frame.secret, decodeSecret));
  }

  function consume(message) {
    if (closed || !isBrokerMessage(message, protocol)) return;
    if (!validId(nextId) || !validRequest(message)
        || pending.length + Number(active) >= MAXIMUM_PENDING) {
      dispose();
      return;
    }
    nextId += 1;
    pending.push(message);
    void drain();
  }

  channel.on("message", consume);
  channel.on("disconnect", dispose);
  return Object.freeze({ dispose });
}
