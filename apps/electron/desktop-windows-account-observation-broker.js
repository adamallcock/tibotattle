import {
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_SCHEMA,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_REQUEST_KIND,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_RESPONSE_KIND,
  WindowsAccountObservationBrokerError,
  decodeWindowsAccountObservationBrokerSecret,
  encodeWindowsAccountObservationBrokerSecret,
} from "../../src/platform/index.js";
import {
  isWindowsAccountObservationCredentialBackend,
  isWindowsAccountObservationCredentialError,
} from "../../src/platform/windows-account-observation-credential.js";

// This is a dormant composition seam. Only a later qualified Electron main
// composition may attach it to owned Node IPC; the companion never loads Keytar.
export const WINDOWS_ACCOUNT_OBSERVATION_BROKER_INTEGRATION_STATUS = "dormant";

const MAXIMUM_PENDING = 32;
const OPERATIONS = new Set(["read", "create_if_missing"]);

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

function validChannel(channel) {
  try {
    return record(channel)
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

function validId(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000;
}

function backendFailureCode(error, isBackendError) {
  let trusted = false;
  try { trusted = isBackendError(error) === true; } catch { trusted = false; }
  if (!trusted) return "unavailable";
  let code;
  try { code = error.code; } catch { return "unavailable"; }
  if (code === "windows_account_observation_credential_locked") return "locked";
  if (code === "windows_account_observation_credential_denied") return "denied";
  if (code === "windows_account_observation_credential_recovery_required") {
    return "recovery_required";
  }
  return "unavailable";
}

function snapshotBackend(backend) {
  let valid = false;
  try {
    valid = isWindowsAccountObservationCredentialBackend(backend)
      && ["read", "createIfMissing", "close"].every((method) => typeof backend[method] === "function")
      && backend.crossProcessSafe === true
      && backend.auditDurable === true
      && backend.auditFilesystemProtected === true
      && backend.startupRecoveryComplete === true
      && backend.productionSafe === false;
  } catch {
    valid = false;
  }
  if (!valid) fail("invalid_configuration");
  try {
    return Object.freeze({
      read: backend.read.bind(backend),
      createIfMissing: backend.createIfMissing.bind(backend),
      close: backend.close.bind(backend),
    });
  } catch {
    fail("invalid_configuration");
  }
}

function validSecret(value) {
  try {
    const decoded = decodeWindowsAccountObservationBrokerSecret(value);
    decoded.fill(0);
    return true;
  } catch {
    return false;
  }
}

function validRequest(frame, nextId) {
  if (!record(frame)
      || frame.schemaVersion !== WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_SCHEMA
      || frame.kind !== WINDOWS_ACCOUNT_OBSERVATION_BROKER_REQUEST_KIND
      || frame.v !== WINDOWS_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION
      || frame.id !== nextId || !OPERATIONS.has(frame.op)) {
    return false;
  }
  const keys = frame.op === "read"
    ? ["schemaVersion", "kind", "v", "id", "op"]
    : ["schemaVersion", "kind", "v", "id", "op", "secret"];
  return exact(frame, keys)
    && (frame.op !== "create_if_missing" || validSecret(frame.secret));
}

function disposeBackend(backend) {
  try { backend.close(); } catch { /* The owned IPC channel is already closed. */ }
}

function send(channel, message, onFailure) {
  try {
    if (channel.connected === false) throw new Error("channel closed");
    channel.send(message, (error) => {
      if (error) onFailure();
    });
  } catch {
    onFailure();
  }
}

/**
 * Serve only the fixed account-observation record to one supervisor-owned
 * companion over Node IPC. Mutations are serialized and journaled inside the
 * main-owned backend before Keytar is touched; no child request can select
 * another legacy capability, record name, native binding, or state path.
 */
export function attachDesktopWindowsAccountObservationBroker({
  channel,
  createBackend,
  isBackendError = isWindowsAccountObservationCredentialError,
} = {}) {
  if (!validChannel(channel) || typeof createBackend !== "function"
      || typeof isBackendError !== "function") {
    fail("invalid_configuration");
  }
  let backend = null;
  let selected;
  try {
    backend = createBackend();
    selected = snapshotBackend(backend);
  } catch (error) {
    disposeBackend(backend);
    if (error instanceof WindowsAccountObservationBrokerError) throw error;
    fail(backendFailureCode(error, isBackendError));
  }
  let closed = false;
  let backendClosed = false;
  let nextId = 1;
  let active = false;
  const pending = [];

  function closeBackendWhenIdle() {
    if (!closed || backendClosed || active) return;
    backendClosed = true;
    disposeBackend(selected);
  }

  function dispose() {
    if (closed) return;
    closed = true;
    pending.length = 0;
    try { channel.off("message", consume); } catch { /* Channel is already closing. */ }
    try { channel.off("disconnect", dispose); } catch { /* Channel is already closing. */ }
    closeBackendWhenIdle();
  }

  function response(id, value) {
    if (closed) return;
    send(channel, Object.freeze({
      schemaVersion: WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_SCHEMA,
      kind: WINDOWS_ACCOUNT_OBSERVATION_BROKER_RESPONSE_KIND,
      v: WINDOWS_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION,
      id,
      ...value,
    }), dispose);
  }

  async function execute(request) {
    if (request.op === "read") {
      let secret = null;
      try {
        secret = await selected.read();
        return Object.freeze({
          ok: true,
          secret: secret === null ? null : encodeWindowsAccountObservationBrokerSecret(secret),
        });
      } finally {
        if (Buffer.isBuffer(secret)) secret.fill(0);
      }
    }
    let secret = null;
    try {
      secret = decodeWindowsAccountObservationBrokerSecret(request.secret);
      const status = await selected.createIfMissing(secret);
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
          value = Object.freeze({ ok: false, code: backendFailureCode(error, isBackendError) });
        }
        response(request.id, value);
      }
    } finally {
      active = false;
      closeBackendWhenIdle();
    }
  }

  function consume(message) {
    if (closed || !isBrokerMessage(message)) return;
    if (!validId(nextId) || !validRequest(message, nextId)
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
