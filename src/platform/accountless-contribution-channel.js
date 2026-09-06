// Platform adapter for private, inherited Node process IPC only. Never installed
// on Electron renderer IPC, an HTTP route, or a discoverable socket.
const SCHEMA = "accountless-process-v1";
const OPERATIONS = new Set(["preference", "read", "create", "delete", "status"]);
const STATES = new Set(["off", "unavailable", "uploading", "pending", "up_to_date", "retry_wait", "paused"]);
const SECRET = /^[A-Za-z0-9_-]{43}$/u;
const RETRYABLE_CREDENTIAL_UNAVAILABLE = "retryable_credential_unavailable";
const denied = () => Object.assign(new Error("Contribution channel unavailable"),
  { code: "contribution_device_credential_unavailable", retryable: false });
const temporarilyUnavailable = () => Object.assign(new Error("Contribution channel unavailable"),
  { code: "contribution_device_credential_unavailable", retryable: true });
// A dispatched create/delete request can race channel loss or a parent-side
// storage failure. Its result must not be treated as a known non-mutation:
// the public binding is retained so a later process can recover the exact
// protected value, or fail closed if no value was saved.
const mutationUncertain = () => Object.assign(new Error("Contribution channel mutation uncertain"),
  { code: "contribution_device_credential_mutation_uncertain", retryable: true });
const isMutation = (operation) => operation === "create" || operation === "delete";
const retryableCredentialFailure = (error) => {
  try {
    return error?.code === "contribution_device_credential_unavailable"
      && error?.retryable === true;
  } catch {
    return false;
  }
};
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, keys) { return record(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(","); }
function validId(value) { return Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000; }
function safeSend(channel, message) {
  if (channel.connected === false || typeof channel.send !== "function") throw temporarilyUnavailable();
  channel.send(message, () => {});
}
export function projectAccountlessProcessPreference(value) {
  return { available: value?.available === true, current: value?.current === true,
    enabled: value?.enabled === true, policyVersion: value?.policyVersion ?? null,
    destinationOrigin: value?.destinationOrigin ?? null };
}
export function projectAccountlessProcessStatus(value) {
  const timestamp = (item) => item === null || (typeof item === "string"
    && item.length === 24 && Number.isFinite(Date.parse(item))) ? item : null;
  return { state: STATES.has(value?.state) ? value.state : "unavailable",
    lastAcceptedAt: timestamp(value?.lastAcceptedAt ?? null),
    nextAttemptAt: timestamp(value?.nextAttemptAt ?? null) };
}
export function attachAccountlessParentChannel({ channel, readPreference, backend, onStatus = () => {} }) {
  let disposed = false;
  let generation = 0;
  let busy = false;
  const fences = new Map();
  const reply = (id, value, ok = true) => {
    if (disposed) return;
    try { safeSend(channel, { schemaVersion: SCHEMA, kind: "response", id, ok, value }); } catch { /* Child exited. */ }
  };
  const onMessage = async (message) => {
    if (!disposed && exact(message, ["schemaVersion", "kind", "generation"])
        && message.schemaVersion === SCHEMA && message.kind === "invalidated") {
      fences.get(message.generation)?.resolve();
      fences.delete(message.generation);
      return;
    }
    if (disposed || !exact(message, ["schemaVersion", "kind", "id", "operation", "value"])
        || message.schemaVersion !== SCHEMA || message.kind !== "request"
        || !validId(message.id) || !OPERATIONS.has(message.operation)) return;
    // Status is display-only and cannot authorize an operation. Accept it while
    // a protected credential read/write is pending so a transient failure is not
    // silently stuck at the prior state.
    if (message.operation === "status") {
      if (!exact(message.value, ["state", "lastAcceptedAt", "nextAttemptAt"])) { reply(message.id, null, false); return; }
      try { onStatus(projectAccountlessProcessStatus(message.value)); } catch { /* Presentation only. */ }
      reply(message.id, null);
      return;
    }
    if (busy) { reply(message.id, null, false); return; }
    busy = true;
    const epoch = generation;
    let bytes = null;
    let mutationStarted = false;
    try {
      const preference = projectAccountlessProcessPreference(await readPreference());
      if (disposed || generation !== epoch) throw denied();
      if (message.operation === "preference") {
        if (message.value !== null) throw denied();
        reply(message.id, preference);
        return;
      }
      if ((!preference.available || !preference.current || !preference.enabled)
          && message.operation !== "delete") throw denied();
      let result;
      if (message.operation === "read") {
        if (message.value !== null) throw denied();
        bytes = await backend.read();
        if (bytes !== null && (!Buffer.isBuffer(bytes) || bytes.length !== 32)) throw denied();
        result = bytes === null ? null : bytes.toString("base64url");
      } else {
        if (typeof message.value !== "string" || !SECRET.test(message.value)) throw denied();
        bytes = Buffer.from(message.value, "base64url");
        mutationStarted = true;
        result = message.operation === "create"
          ? await backend.createIfMissing(bytes) : await backend.deleteExact(bytes);
      }
      // Settle an accepted local mutation even if sharing was switched off
      // while storage was writing. Losing its acknowledgement would remove
      // the child's binding file while leaving a newly saved secret orphaned.
      // A credential read never receives this exception, and every outbound
      // network operation still needs a fresh enabled preference.
      if (disposed || (epoch !== generation && message.operation === "read")) throw denied();
      reply(message.id, result);
    } catch (error) {
      reply(message.id, mutationStarted ? "mutation_uncertain"
        : retryableCredentialFailure(error) ? RETRYABLE_CREDENTIAL_UNAVAILABLE : null, false);
    }
    finally { bytes?.fill(0); busy = false; }
  };
  channel.on("message", onMessage);
  return Object.freeze({
    invalidate() {
      generation += 1;
      const selected = generation;
      const pending = new Promise((resolve, reject) => {
        if (disposed || fences.size >= 8) { reject(denied()); return; }
        const timer = setTimeout(() => { fences.delete(selected); reject(denied()); }, 5000);
        timer.unref?.();
        fences.set(selected, { resolve: () => { clearTimeout(timer); resolve(); },
          reject: () => { clearTimeout(timer); reject(denied()); } });
        try { safeSend(channel, { schemaVersion: SCHEMA, kind: "invalidate", generation: selected }); }
        catch { fences.get(selected)?.reject(); fences.delete(selected); }
      });
      // Disposal and supervisor shutdown can signal without awaiting the UI
      // barrier. Attach a rejection observer while preserving it for callers.
      pending.catch(() => {});
      return pending;
    },
    dispose() {
      disposed = true;
      generation += 1;
      channel.off("message", onMessage);
      for (const fence of fences.values()) fence.reject();
      fences.clear();
    },
  });
}
export function createAccountlessChildChannel({ channel, onInvalidated = () => {}, timeoutMilliseconds = 15_000 }) {
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 60_000) throw denied();
  let disposed = false;
  let sequence = 0;
  const pending = new Map();
  const rejection = (request, { outcomeUncertain = false, retryable = false } = {}) => (
    outcomeUncertain && isMutation(request.operation) ? mutationUncertain()
      : retryable ? temporarilyUnavailable() : denied()
  );
  const rejectAll = (preserveMutations = false, options = {}) => {
    for (const [id, request] of pending) {
      if (preserveMutations && isMutation(request.operation)) continue;
      request.reject(rejection(request, options));
      pending.delete(id);
    }
  };
  const onMessage = (message) => {
    if (disposed || !record(message) || message.schemaVersion !== SCHEMA) return;
    if (exact(message, ["schemaVersion", "kind", "generation"]) && message.kind === "invalidate"
        && validId(message.generation)) {
      rejectAll(true);
      onInvalidated();
      // The callback synchronously aborts the active pass before acknowledging
      // the fence. A completed desktop opt-out therefore cannot race the old
      // child's preference-read -> send gap. Already dispatched HTTP requests
      // can still have reached the server; this is cancellation, not erasure.
      try { safeSend(channel, { schemaVersion: SCHEMA, kind: "invalidated", generation: message.generation }); }
      catch { onDisconnect(); }
      return;
    }
    if (!exact(message, ["schemaVersion", "kind", "id", "ok", "value"])
        || message.kind !== "response" || typeof message.ok !== "boolean") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.ok) request.resolve(message.value);
    else request.reject(rejection(request, {
      outcomeUncertain: message.value === "mutation_uncertain",
      retryable: message.value === RETRYABLE_CREDENTIAL_UNAVAILABLE,
    }));
  };
  const onDisconnect = () => {
    disposed = true;
    rejectAll(false, { outcomeUncertain: true, retryable: true });
    onInvalidated();
  };
  channel.on("message", onMessage);
  channel.on("disconnect", onDisconnect);
  const request = (operation, value = null) => new Promise((resolve, reject) => {
    if (disposed || pending.size >= 4 || sequence >= 1_000_000_000) { reject(temporarilyUnavailable()); return; }
    const id = ++sequence;
    const timer = setTimeout(() => {
      const pendingRequest = pending.get(id);
      pending.delete(id);
      reject(rejection(pendingRequest ?? { operation }, { outcomeUncertain: true, retryable: true }));
    }, timeoutMilliseconds);
    timer.unref?.();
    pending.set(id, { operation, resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (error) => { clearTimeout(timer); reject(error); } });
    try { safeSend(channel, { schemaVersion: SCHEMA, kind: "request", id, operation, value }); }
    catch {
      const pendingRequest = pending.get(id);
      // A known-disconnected channel cannot have accepted this request. A
      // synchronous send failure while still connected has no delivery proof,
      // so preserve a mutation binding and recover/fail closed on restart.
      pendingRequest?.reject(rejection(pendingRequest, {
        outcomeUncertain: channel.connected !== false,
        retryable: true,
      }));
      pending.delete(id);
    }
  });
  const encode = (value) => { if (!Buffer.isBuffer(value) || value.length !== 32) throw denied(); return value.toString("base64url"); };
  return Object.freeze({
    readPreference: async () => projectAccountlessProcessPreference(await request("preference")),
    backend: Object.freeze({
      async read() {
        const value = await request("read");
        if (value === null) return null;
        if (typeof value !== "string" || !SECRET.test(value)) throw denied();
        return Buffer.from(value, "base64url");
      },
      createIfMissing: (_capability, value) => request("create", encode(value)),
      deleteExact: (_capability, value) => request("delete", encode(value)),
    }),
    reportStatus: (value) => request("status", projectAccountlessProcessStatus(value)),
    dispose() {
      disposed = true;
      rejectAll(false, { outcomeUncertain: true, retryable: true });
      channel.off("message", onMessage);
      channel.off("disconnect", onDisconnect);
    },
  });
}
