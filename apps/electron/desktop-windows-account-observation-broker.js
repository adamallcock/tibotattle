import {
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION,
  WindowsAccountObservationBrokerError,
  decodeWindowsAccountObservationBrokerSecret,
  encodeWindowsAccountObservationBrokerSecret,
  isWindowsAccountObservationCredentialBackend,
  isWindowsAccountObservationCredentialError,
} from "../../src/platform/index.js";

// This is a dormant composition seam. Only a later qualified Electron main
// composition may attach it to FD4; the companion never loads Keytar itself.
export const WINDOWS_ACCOUNT_OBSERVATION_BROKER_INTEGRATION_STATUS = "dormant";

const MAXIMUM_FRAME_BYTES = 4_096;
const MAXIMUM_PENDING = 32;
const OPERATIONS = new Set(["read", "create_if_missing"]);

function fail(code) {
  throw new WindowsAccountObservationBrokerError(code);
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
  if (!frame || typeof frame !== "object" || Array.isArray(frame)
      || frame.v !== WINDOWS_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION
      || frame.id !== nextId || !OPERATIONS.has(frame.op)) {
    return false;
  }
  const keys = frame.op === "read" ? ["v", "id", "op"] : ["v", "id", "op", "secret"];
  return Object.keys(frame).length === keys.length
    && keys.every((key) => Object.hasOwn(frame, key))
    && (frame.op !== "create_if_missing" || validSecret(frame.secret));
}

function disposeBackend(backend) {
  try { backend.close(); } catch { /* The private descriptor is already closed. */ }
}

/**
 * Serve only the fixed account-observation record to one supervisor-owned
 * companion. Mutations are serialized and journaled inside the main-owned
 * backend before Keytar is touched; no child request can select another
 * legacy capability, record name, native binding, or state path.
 */
export function attachDesktopWindowsAccountObservationBroker({
  stream,
  createBackend,
  isBackendError = isWindowsAccountObservationCredentialError,
} = {}) {
  if (!stream || typeof stream.on !== "function" || typeof stream.write !== "function"
      || typeof stream.destroy !== "function" || typeof createBackend !== "function"
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
  let received = "";
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
    received = "";
    pending.length = 0;
    stream.off?.("data", consume);
    try { stream.destroy(); } catch { /* The owned descriptor may already be closed. */ }
    closeBackendWhenIdle();
  }

  function response(id, value) {
    if (closed) return;
    try { stream.write(`${JSON.stringify({ id, ...value })}\n`); } catch { dispose(); }
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

  function consume(chunk) {
    if (closed) return;
    received += String(chunk);
    let end;
    while ((end = received.indexOf("\n")) !== -1 && !closed) {
      const line = received.slice(0, end);
      received = received.slice(end + 1);
      if (Buffer.byteLength(line, "utf8") + 1 > MAXIMUM_FRAME_BYTES) {
        dispose();
        return;
      }
      let request;
      try { request = JSON.parse(line); } catch { dispose(); return; }
      if (!Number.isSafeInteger(nextId) || !validRequest(request, nextId)
          || pending.length + Number(active) >= MAXIMUM_PENDING) {
        dispose();
        return;
      }
      nextId += 1;
      pending.push(request);
      void drain();
    }
    if (Buffer.byteLength(received, "utf8") > MAXIMUM_FRAME_BYTES) dispose();
  }

  stream.setEncoding?.("utf8");
  stream.on("data", consume);
  stream.on("error", dispose);
  stream.on("end", dispose);
  stream.on("close", dispose);
  return Object.freeze({ dispose });
}
