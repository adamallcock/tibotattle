import { runTelemetryPerformanceSync } from "../contribution/index.js";

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

async function readCapability(response, signal) {
  checkResponse(response);
  if (response.status !== 200) {
    discardBody(response);
    const transient = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
    throw transportError(transient ? "capability_unavailable" : "response_invalid", response);
  }
  const declared = response.headers.get("content-length");
  if (response.headers.get("cache-control") !== "no-store"
      || !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")
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
      if (signal.aborted) throw transportError("capability_unavailable");
      let part;
      try { part = await reader.read(); }
      catch { throw transportError("capability_unavailable"); }
      if (signal.aborted) throw transportError("capability_unavailable");
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
  readState = async () => null,
  saveState = async () => {},
  publicJwk,
  keyId,
  createEnvelope,
  sync = runTelemetryPerformanceSync,
} = {}) {
  const base = originUrl(origin);
  if (typeof fetchImpl !== "function" || typeof readAuthorization !== "function"
      || typeof readPreparedDay !== "function" || typeof readState !== "function"
      || typeof saveState !== "function" || typeof createEnvelope !== "function"
      || typeof sync !== "function") {
    invalid("invalid_telemetry_performance_client_configuration");
  }
  const route = path => new URL(path, base).toString();
  const authHeaders = async () => {
    const authorization = await readAuthorization();
    if (typeof authorization !== "string" || authorization.length < 1) {
      throw new Error("telemetry_performance_authorization_unavailable");
    }
    return { authorization };
  };
  const readCapabilities = async () => {
    const signal = AbortSignal.timeout(15_000);
    const response = await fetchImpl(route(CAPABILITIES_PATH), {
      method: "GET", credentials: "omit", redirect: "error", cache: "no-store", signal,
      headers: await authHeaders(),
    });
    return readCapability(response, signal);
  };
  const send = async ({ envelope }) => {
    const response = await fetchImpl(route(REPORTS_PATH), {
      method: "POST", credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
      headers: { ...await authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    checkResponse(response);
    discardBody(response);
    const retryAfter = response.headers.get("retry-after");
    return { status: response.status,
      ...(retryAfter !== null && retryAfter.length <= 128 ? { retryAfter } : {}) };
  };
  return Object.freeze({
    async runDay({ day, nowEpoch, globalPaused = false, deviceConnected = true, resetRetryCount = true } = {}) {
      return sync({
        day,
        nowEpoch,
        state: await readState(),
        globalPaused,
        deviceConnected,
        resetRetryCount,
        readCapabilities,
        prepareDay: ({ day: selectedDay }) => readPreparedDay({ day: selectedDay, nowEpoch }),
        createEnvelope: ({ report }) => createEnvelope({ report, publicJwk, keyId }),
        send,
        saveState,
      });
    },
  });
}
