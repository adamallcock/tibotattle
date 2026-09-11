import { MACOS_KEYCHAIN_BROKER_CAPABILITY_NAMES } from "../../src/platform/index.js";

// This is the existing native companion's v2 protocol, served by Electron's
// own main process over a new private pipe. No renderer or network endpoint
// participates, and the old native application's socket is never reused.
const VERSION = 2;
const CAPABILITIES = new Set(Object.values(MACOS_KEYCHAIN_BROKER_CAPABILITY_NAMES));
const SECRET = /^[A-Za-z0-9_-]{43}$/u;
const MAX_FRAME_BYTES = 4096;
const MAX_PENDING = 32;

function validRequest(frame, nextId) {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)
      || frame.v !== VERSION || frame.id !== nextId
      || !CAPABILITIES.has(frame.capability)
      || !["get", "set", "delete"].includes(frame.op)) return false;
  const keys = frame.op === "set"
    ? ["v", "id", "op", "capability", "secret"]
    : ["v", "id", "op", "capability"];
  return Object.keys(frame).length === keys.length
    && keys.every((key) => Object.hasOwn(frame, key))
    && (frame.op !== "set" || (typeof frame.secret === "string" && SECRET.test(frame.secret)));
}

function wireError(error) {
  if (error?.code === "KEYCHAIN_LOCKED") return "locked";
  if (error?.code === "KEYCHAIN_DENIED") return "denied";
  if (error?.code === "KEYCHAIN_MIGRATION_REQUIRED") return "migration_required";
  return "unavailable";
}

/** Serve fixed logical credentials only to the supervisor's owned child. */
export function attachDesktopKeychainBroker({ stream, backend } = {}) {
  if (!stream || typeof stream.on !== "function" || typeof stream.write !== "function"
      || typeof stream.destroy !== "function" || !backend
      || ["get", "set", "delete"].some((name) => typeof backend[name] !== "function")) {
    throw new TypeError("desktop Keychain broker configuration is invalid");
  }
  let closed = false;
  let received = "";
  let nextId = 1;
  let active = false;
  const pending = [];

  function dispose() {
    if (closed) return;
    closed = true;
    received = "";
    pending.length = 0;
    stream.off?.("data", consume);
    // Keep the fixed error listener until the stream is destroyed: a late
    // transport error must not become an unhandled process exception.
    try { stream.destroy(); } catch { /* The channel is already unavailable. */ }
  }

  async function drain() {
    if (active || closed) return;
    active = true;
    try {
      while (pending.length > 0 && !closed) {
        const request = pending.shift();
        let response;
        try {
          if (request.op === "get") {
            const secret = await backend.get(request.capability);
            if (secret !== null && (typeof secret !== "string" || !SECRET.test(secret))) {
              throw new TypeError("desktop Keychain value is invalid");
            }
            response = { id: request.id, ok: true, secret };
          } else {
            await backend[request.op](request.capability, ...(request.op === "set" ? [request.secret] : []));
            response = { id: request.id, ok: true };
          }
        } catch (error) {
          response = { id: request.id, ok: false, code: wireError(error) };
        }
        if (closed) return;
        try { stream.write(`${JSON.stringify(response)}\n`); } catch { dispose(); }
      }
    } finally {
      active = false;
    }
  }

  function consume(chunk) {
    if (closed) return;
    received += String(chunk);
    if (Buffer.byteLength(received, "utf8") > MAX_FRAME_BYTES) return dispose();
    let end;
    while ((end = received.indexOf("\n")) !== -1 && !closed) {
      const line = received.slice(0, end);
      received = received.slice(end + 1);
      let request;
      try { request = JSON.parse(line); } catch { dispose(); return; }
      if (!Number.isSafeInteger(nextId) || !validRequest(request, nextId)
          || pending.length + Number(active) >= MAX_PENDING) {
        dispose();
        return;
      }
      nextId += 1;
      pending.push(request);
      void drain();
    }
  }

  stream.setEncoding?.("utf8");
  stream.on("data", consume);
  stream.on("error", dispose);
  stream.on("end", dispose);
  stream.on("close", dispose);
  return Object.freeze({ dispose });
}
