import { readTelemetryPerformanceRetryDays, runTelemetryPerformanceSync } from "../contribution/index.js";

const CAPABILITIES_PATH = "/api/v1/device/telemetry/performance/capabilities";
const REPORTS_PATH = "/api/v1/device/telemetry/performance/reports";

function invalid(message = "invalid_telemetry_performance_client") {
  throw new TypeError(message);
}

function transportError(code, response) {
  const error = new Error("Telemetry performance transport unavailable");
  error.code = `telemetry_performance_${code}`;
  const retryAfter = response?.headers?.get("retry-after");
  if (typeof retryAfter === "string" && retryAfter.length <= 128) error.retryAfter = retryAfter;
  return error;
}

function discardBody(response) {
  try { void response?.body?.cancel().catch(() => {}); } catch { /* best effort */ }
}

function checkResponse(response) {
  if (!(response instanceof Response) || response.redirected) {
    discardBody(response);
    throw transportError("response_invalid");
  }
  if (response.status === 401 || response.status === 403) {
    discardBody(response);
    throw transportError("authorization_rejected");
  }
}

async function readBoundedJson(response, signal, unavailableCode) {
  const declared = response.headers.get("content-length");
  if (response.headers.get("cache-control") !== "no-store"
      || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")
      || (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > 16_384))
      || !response.body) {
    discardBody(response);
    throw transportError("response_invalid");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  let complete = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw transportError(unavailableCode);
      let part;
      try { part = await reader.read(); }
      catch { throw transportError(unavailableCode); }
      if (signal.aborted) throw transportError(unavailableCode);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw transportError("response_invalid");
      bytes += part.value.byteLength;
      if (bytes > 16_384) throw transportError("response_invalid");
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    complete = true;
    return JSON.parse(text);
  } catch (error) {
    if (error?.code?.startsWith("telemetry_performance_")) throw error;
    throw transportError("response_invalid");
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

async function readCapability(response, signal) {
  checkResponse(response);
  if (response.status === 200) return readBoundedJson(response, signal, "capability_unavailable");
  discardBody(response);
  const transient = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
  throw transportError(transient ? "capability_unavailable" : "response_invalid", response);
}

function originUrl(value) {
  if (typeof value !== "string") invalid("invalid_telemetry_performance_origin");
  let parsed;
  try { parsed = new URL(value); } catch { invalid("invalid_telemetry_performance_origin"); }
  if (parsed.origin !== value || !["http:", "https:"].includes(parsed.protocol)) {
    invalid("invalid_telemetry_performance_origin");
  }
  return parsed;
}

/**
 * Production-shaped local transport ports for the independent performance
 * scheduler.  The source reader and owner-only state storage remain injected
 * by the desktop composition root; this client owns only the exact capability
 * and encrypted-report routes.
 */
export function createTelemetryPerformanceClient({
  origin,
  fetchImpl = globalThis.fetch,
  readAuthorization,
  readPreparedDay,
  readDeviceId = async () => null,
  readState = async () => null,
  readRetryState = readState,
  saveState = async () => {},
  publicJwk,
  keyId,
  createEnvelope,
  sync = runTelemetryPerformanceSync,
} = {}) {
  const base = originUrl(origin);
  if (typeof fetchImpl !== "function" || typeof readAuthorization !== "function"
      || typeof readPreparedDay !== "function" || typeof readDeviceId !== "function"
      || typeof readState !== "function"
      || typeof readRetryState !== "function" || typeof saveState !== "function" || typeof createEnvelope !== "function"
      || typeof sync !== "function") {
    invalid("invalid_telemetry_performance_client_configuration");
  }
  const route = path => new URL(path, base).toString();
  const authHeaders = async (deviceId) => {
    const authorization = await readAuthorization(deviceId);
    if (typeof authorization !== "string" || authorization.length < 1) {
      throw new Error("telemetry_performance_authorization_unavailable");
    }
    return { authorization };
  };
  const readCapabilities = async (deviceId) => {
    const signal = AbortSignal.timeout(15_000);
    const response = await fetchImpl(route(CAPABILITIES_PATH), {
      method: "GET", credentials: "omit", redirect: "error", cache: "no-store", signal,
      headers: await authHeaders(deviceId),
    });
    return readCapability(response, signal);
  };
  const send = async ({ envelope }, deviceId) => {
    const signal = AbortSignal.timeout(15_000);
    const response = await fetchImpl(route(REPORTS_PATH), {
      method: "POST", credentials: "omit", redirect: "error", cache: "no-store", signal,
      headers: { ...await authHeaders(deviceId), "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    checkResponse(response);
    const retryAfter = response.headers.get("retry-after");
    const result = { status: response.status,
      ...(retryAfter !== null && retryAfter.length <= 128 ? { retryAfter } : {}) };
    if (response.status === 202 || response.status === 409) {
      // A missing, malformed or interrupted body can never prove admission.
      // Only the closed rejection code leaves this transport boundary.
      let value = null;
      try { value = await readBoundedJson(response, signal, "service_unavailable"); }
      catch { /* The sync state machine paces an unconfirmed response. */ }
      if (response.status === 202) {
        const replayHeader = response.headers.get("idempotency-replayed");
        return { ...result, receipt: value,
          ...(replayHeader === null ? {} : { idempotencyReplayed: replayHeader === "true" }) };
      }
      const code = value?.error?.code;
      return code === "TELEMETRY_RECORD_INVALID" || code === "TELEMETRY_MANIFEST_CONFLICT"
        ? { ...result, errorCode: code } : result;
    }
    discardBody(response);
    return result;
  };
  let running = false;
  return Object.freeze({
    async readRetryDays({ nowEpoch }) {
      return readTelemetryPerformanceRetryDays(await readRetryState(await readDeviceId()), nowEpoch);
    },
    async runDay({
      day, nowEpoch, globalPaused = false, deviceConnected = true, resetRetryCount = true,
      onlyPending = false,
    } = {}) {
      if (running) invalid("telemetry_performance_attempt_in_progress");
      running = true;
      try {
        const deviceId = await readDeviceId();
        return await sync({
          day,
          nowEpoch,
          state: await readState(deviceId),
          globalPaused,
          deviceConnected,
          resetRetryCount,
          onlyPending,
          readCapabilities: () => readCapabilities(deviceId),
          prepareDay: ({ day: selectedDay }) => readPreparedDay({ day: selectedDay, nowEpoch }),
          createEnvelope: ({ report }) => createEnvelope({ report, publicJwk, keyId }),
          send: options => send(options, deviceId),
          saveState: async value => {
            if (deviceId !== null && await readDeviceId() !== deviceId) {
              throw transportError("device_binding_changed");
            }
            await saveState(value, deviceId);
          },
        });
      } finally {
        running = false;
      }
    },
  });
}
