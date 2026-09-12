import {
  LINUX_SECRET_SERVICE_BROKER_CAPABILITIES,
  LINUX_SECRET_SERVICE_BROKER_CAPABILITY_NAMES,
  LINUX_SECRET_SERVICE_BROKER_PROTOCOL_VERSION,
  LinuxSecretServiceBrokerError,
  decodeLinuxSecretServiceBrokerSecret,
  encodeLinuxSecretServiceBrokerSecret,
} from "../../src/platform/linux-secret-service-broker.js";

// This bridge is deliberately dormant. No Electron composition root selects it
// until Linux's independent installed-artifact and desktop gates are qualified.
export const LINUX_SECRET_SERVICE_BROKER_INTEGRATION_STATUS = "dormant";

const MAXIMUM_FRAME_BYTES = 4_096;
const MAXIMUM_PENDING = 32;
const OPERATIONS = new Set([
  "read",
  "create_if_missing",
  "replace_exact",
  "delete_exact",
]);
const CAPABILITIES = new Set(
  Object.values(LINUX_SECRET_SERVICE_BROKER_CAPABILITY_NAMES),
);

function fail(code) {
  throw new LinuxSecretServiceBrokerError(code);
}

function capabilityForName(name) {
  if (name === LINUX_SECRET_SERVICE_BROKER_CAPABILITY_NAMES.exportIdentity) {
    return LINUX_SECRET_SERVICE_BROKER_CAPABILITIES.exportIdentity;
  }
  if (name === LINUX_SECRET_SERVICE_BROKER_CAPABILITY_NAMES.accountObservation) {
    return LINUX_SECRET_SERVICE_BROKER_CAPABILITIES.accountObservation;
  }
  fail("invalid_configuration");
}

function backendFailureCode(error, isBackendError) {
  let trusted = false;
  try { trusted = isBackendError(error) === true; } catch { trusted = false; }
  if (!trusted) return "unavailable";
  let code;
  try { code = error.code; } catch { return "unavailable"; }
  if (code === "linux_secret_service_locked") return "locked";
  if (code === "linux_secret_service_denied") return "denied";
  if (code === "linux_secret_service_mutation_lease_recovery_required") {
    return "recovery_required";
  }
  return "unavailable";
}

function snapshotLeaseOwningBackend(backend) {
  let valid = false;
  try {
    valid = backend !== null && typeof backend === "object"
      && ["read", "createIfMissing", "replaceExact", "deleteExact", "withOperationLease", "close"]
        .every((name) => typeof backend[name] === "function")
      && backend.crossProcessSafe === true
      && backend.crashRecoveryComplete === false
      && backend.productionSafe === false;
  } catch {
    valid = false;
  }
  if (!valid) fail("invalid_configuration");
  try {
    return Object.freeze({
      read: backend.read.bind(backend),
      createIfMissing: backend.createIfMissing.bind(backend),
      replaceExact: backend.replaceExact.bind(backend),
      deleteExact: backend.deleteExact.bind(backend),
      withOperationLease: backend.withOperationLease.bind(backend),
      close: backend.close.bind(backend),
    });
  } catch {
    fail("invalid_configuration");
  }
}

function validSecret(value) {
  try {
    const decoded = decodeLinuxSecretServiceBrokerSecret(value);
    decoded.fill(0);
    return true;
  } catch {
    return false;
  }
}

function validRequest(frame, nextId) {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)
      || frame.v !== LINUX_SECRET_SERVICE_BROKER_PROTOCOL_VERSION
      || frame.id !== nextId || !OPERATIONS.has(frame.op)
      || !CAPABILITIES.has(frame.capability)) {
    return false;
  }
  const keys = frame.op === "read"
    ? ["v", "id", "op", "capability"]
    : frame.op === "create_if_missing"
      ? ["v", "id", "op", "capability", "secret"]
      : frame.op === "replace_exact"
        ? ["v", "id", "op", "capability", "expected", "replacement"]
        : ["v", "id", "op", "capability", "expected"];
  if (Object.keys(frame).length !== keys.length
      || !keys.every((key) => Object.hasOwn(frame, key))) return false;
  return ["secret", "expected", "replacement"].every((key) => (
    !Object.hasOwn(frame, key) || validSecret(frame[key])
  ));
}

function mutationResult(operation, status) {
  const accepted = operation === "create_if_missing"
    ? new Set(["created", "existing"])
    : operation === "replace_exact"
      ? new Set(["replaced", "missing", "conflict"])
      : new Set(["deleted", "missing", "conflict"]);
  if (!accepted.has(status)) fail("unavailable");
  return status;
}

function disposeBackend(backend) {
  try { backend.close(); } catch { /* A closed pipe never exposes native detail. */ }
}

/**
 * Serve exactly two capability-level Linux Secret Service operations to one
 * supervisor-owned child. The factory is deliberately the actual lease-owning
 * Linux backend, never a generic get/set/delete adapter or a child-side load.
 */
export function attachDesktopLinuxSecretServiceBroker({
  stream,
  createBackend,
  isBackendError,
} = {}) {
  if (!stream || typeof stream.on !== "function" || typeof stream.write !== "function"
      || typeof stream.destroy !== "function" || typeof createBackend !== "function"
      || typeof isBackendError !== "function") {
    fail("invalid_configuration");
  }
  let selected;
  try {
    selected = snapshotLeaseOwningBackend(createBackend());
  } catch (error) {
    if (error instanceof LinuxSecretServiceBrokerError) throw error;
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
    try { stream.destroy(); } catch { /* The owned descriptor already closed. */ }
    closeBackendWhenIdle();
  }

  function response(id, value) {
    if (closed) return;
    try { stream.write(`${JSON.stringify({ id, ...value })}\n`); } catch { dispose(); }
  }

  async function execute(request) {
    const capability = capabilityForName(request.capability);
    if (request.op === "read") {
      let secret = null;
      try {
        secret = await selected.read(capability);
        return Object.freeze({ ok: true, secret: secret === null
          ? null : encodeLinuxSecretServiceBrokerSecret(secret) });
      } finally {
        if (Buffer.isBuffer(secret)) secret.fill(0);
      }
    }
    let first = null;
    let second = null;
    try {
      if (request.op === "create_if_missing") {
        first = decodeLinuxSecretServiceBrokerSecret(request.secret);
        const status = await selected.withOperationLease(
          capability,
          Object.freeze({ operation: "create" }),
          (lease) => selected.createIfMissing(capability, first, lease),
        );
        return Object.freeze({ ok: true, status: mutationResult(request.op, status) });
      }
      first = decodeLinuxSecretServiceBrokerSecret(request.expected);
      if (request.op === "replace_exact") {
        second = decodeLinuxSecretServiceBrokerSecret(request.replacement);
        const status = await selected.withOperationLease(
          capability,
          Object.freeze({ operation: "replace" }),
          (lease) => selected.replaceExact(capability, first, second, lease),
        );
        return Object.freeze({ ok: true, status: mutationResult(request.op, status) });
      }
      const status = await selected.withOperationLease(
        capability,
        Object.freeze({ operation: "delete" }),
        (lease) => selected.deleteExact(capability, first, lease),
      );
      return Object.freeze({ ok: true, status: mutationResult(request.op, status) });
    } finally {
      first?.fill(0);
      second?.fill(0);
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
