import { runTelemetryPerformanceSync } from "../contribution/index.js";

const CAPABILITIES_PATH = "/api/v1/device/telemetry/performance/capabilities";
const REPORTS_PATH = "/api/v1/device/telemetry/performance/reports";

function invalid(message = "invalid_telemetry_performance_client") {
  throw new TypeError(message);
}

function responseStatus(response) {
  return Number.isSafeInteger(response?.status) ? response.status : null;
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
    const response = await fetchImpl(route(CAPABILITIES_PATH), {
      method: "GET",
      headers: await authHeaders(),
    });
    if (!response || typeof response.json !== "function") return { status: responseStatus(response) };
    if (responseStatus(response) !== 200) return { status: responseStatus(response) };
    return response.json();
  };
  const send = async ({ envelope }) => {
    const response = await fetchImpl(route(REPORTS_PATH), {
      method: "POST",
      headers: { ...await authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    return { status: responseStatus(response) };
  };
  return Object.freeze({
    async runDay({ day, nowEpoch, globalPaused = false, deviceConnected = true } = {}) {
      return sync({
        day,
        nowEpoch,
        state: await readState(),
        globalPaused,
        deviceConnected,
        readCapabilities,
        prepareDay: ({ day: selectedDay }) => readPreparedDay({ day: selectedDay, nowEpoch }),
        createEnvelope: ({ report }) => createEnvelope({ report, publicJwk, keyId }),
        send,
        saveState,
      });
    },
  });
}
