import { join } from "node:path";
import {
  accountlessTransportOrigin,
  createAccountlessContributionScheduler,
  createTelemetryPerformanceClient,
  createTelemetryPerformanceScheduler,
  initialTelemetryPerformanceSyncState,
  parseTelemetryPerformanceSyncState,
} from "../../src/application/index.js";
import {
  createAccountlessChildChannel,
  createTelemetryPerformanceEnvelope,
} from "../../src/platform/index.js";
import { runAccountlessContributionSyncOnce } from "../../src/contribution-accountless-client.js";
import { withContributionDeviceSecret } from "../../src/contribution-device-capability.js";
import { readJsonIfExists, writeJsonOwnerOnlyAtomic } from "../../src/storage.js";

const PERFORMANCE_AUTHORIZATION = Object.freeze({
  schemaVersion: "accountless-performance-owner-v1",
  policyVersion: "accountless-telemetry-performance-policy-v1",
  authorizationBasis: "accountless-performance-policy-v1",
});
const PERFORMANCE_AUTHORIZATION_PATH = "/api/v1/accountless/telemetry-performance-authorization";
const PERFORMANCE_ENVELOPE_KEY_PATH = "/api/v1/envelope-key";
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function performanceError(code) {
  const error = new Error("Accountless performance authorization unavailable");
  error.code = code;
  return error;
}

function assertPerformancePreference(value, origin) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.available !== true || value.current !== true
      || value.enabled !== true
      || value.policyVersion !== "accountless-opt-out-v1"
      || value.destinationOrigin !== origin) {
    throw performanceError("telemetry_performance_authorization_rejected");
  }
}

function discardPerformanceBody(response) {
  try { void response?.body?.cancel().catch(() => {}); } catch { /* best effort */ }
}

async function readBoundedJson(response, maximumBytes = 16_384) {
  if (!(response instanceof Response) || response.redirected
      || response.headers.get("cache-control") !== "no-store"
      || !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")
      || !response.body) {
    discardPerformanceBody(response);
    throw performanceError("telemetry_performance_response_invalid");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
    discardPerformanceBody(response);
    throw performanceError("telemetry_performance_response_invalid");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  let complete = false;
  try {
    for (;;) {
      let part;
      try { part = await reader.read(); }
      catch { throw performanceError("telemetry_performance_capability_unavailable"); }
      if (part.done) break;
      bytes += part.value.byteLength;
      if (!(part.value instanceof Uint8Array) || bytes > maximumBytes) throw performanceError("telemetry_performance_response_invalid");
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    complete = true;
    return JSON.parse(text);
  } catch (error) {
    if (error?.code?.startsWith("telemetry_performance_")) throw error;
    throw performanceError("telemetry_performance_response_invalid");
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function performanceResponseFailure(response) {
  if (!(response instanceof Response) || response.redirected) {
    discardPerformanceBody(response);
    return performanceError("telemetry_performance_response_invalid");
  }
  if (response.ok) return null;
  discardPerformanceBody(response);
  const transient = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
  const error = performanceError(transient ? "telemetry_performance_capability_unavailable"
    : "telemetry_performance_authorization_rejected");
  const retryAfter = response.headers.get("retry-after");
  if (transient && retryAfter !== null && retryAfter.length <= 128) error.retryAfter = retryAfter;
  return error;
}

async function readPerformanceState(path) {
  try {
    const value = await readJsonIfExists(path, null);
    return value === null ? initialTelemetryPerformanceSyncState()
      : parseTelemetryPerformanceSyncState(value);
  } catch {
    // A corrupt private cursor cannot authorize a request or suppress a
    // server-side revision replacement. Rebuild the bounded cursor and let
    // the report revision/idempotency fence decide whether work is new.
    return initialTelemetryPerformanceSyncState();
  }
}

async function writePerformanceState(path, value) {
  const parsed = parseTelemetryPerformanceSyncState(value);
  await writeJsonOwnerOnlyAtomic(path, parsed);
}

function assertPerformanceEnvelopeKey(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.algorithm !== "RSA-OAEP-256"
      || typeof value.keyId !== "string" || !/^key:[A-Za-z0-9._-]{1,64}$/u.test(value.keyId)
      || !value.publicJwk || typeof value.publicJwk !== "object"
      || Array.isArray(value.publicJwk)) {
    throw performanceError("telemetry_performance_response_invalid");
  }
  return Object.freeze({ keyId: value.keyId, publicJwk: value.publicJwk });
}

function accountlessConfigurationError() {
  return new TypeError("Invalid accountless contribution configuration");
}

/**
 * Select the closed production companion profile. The environment can request
 * this profile, but only the inherited private channel supplies the protected
 * preference and installation credential it requires.
 */
export function selectLocalAccountlessProductionProfile({
  environment,
  channel = process,
} = {}) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw accountlessConfigurationError();
  }
  if (environment.USAGE_MONITOR_ACCOUNTLESS_MODE === undefined) return false;
  const origin = environment.USAGE_MONITOR_ACCOUNTLESS_ORIGIN;
  if (environment.USAGE_MONITOR_ACCOUNTLESS_MODE !== "production-v1"
      || Object.hasOwn(environment, "USAGE_MONITOR_TEST_LANE")
      || Object.hasOwn(environment, "USAGE_MONITOR_CENTRAL_ORIGIN")
      || accountlessTransportOrigin({ production: true, origin }) === null
      || typeof channel?.send !== "function" || channel.connected !== true) {
    throw accountlessConfigurationError();
  }
  return true;
}

/**
 * The packaged Dev rehearsal uses the same inherited private capability as
 * production, but its destination is the single reviewed staging Worker.
 * Neither a renderer nor a child environment can choose another hosted URL.
 */
export function selectLocalAccountlessHostedRehearsalProfile({
  environment,
  channel = process,
} = {}) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw accountlessConfigurationError();
  }
  if (environment.USAGE_MONITOR_ACCOUNTLESS_MODE === undefined) return false;
  const origin = environment.USAGE_MONITOR_ACCOUNTLESS_ORIGIN;
  if (environment.USAGE_MONITOR_ACCOUNTLESS_MODE !== "rehearsal-v1"
      || Object.hasOwn(environment, "USAGE_MONITOR_TEST_LANE")
      || Object.hasOwn(environment, "USAGE_MONITOR_CENTRAL_ORIGIN")
      || accountlessTransportOrigin({ rehearsal: true, origin }) === null
      || typeof channel?.send !== "function" || channel.connected !== true) {
    throw accountlessConfigurationError();
  }
  return true;
}

// Every mode requires the private inherited channel. Only Electron can supply
// the protected preference and credential; environment values grant neither.
export function createLocalAccountlessContribution({
  environment, stateRoot, indexFile, channel = process,
  readAccountMarkers, loadExistingAccountObservationSecret,
  runner = runAccountlessContributionSyncOnce, schedulerOptions = {},
  performanceOptions = null,
} = {}) {
  const selectedMode = environment?.USAGE_MONITOR_ACCOUNTLESS_MODE;
  const production = selectedMode === "rehearsal-v1" ? false
    : selectLocalAccountlessProductionProfile({ environment, channel });
  const rehearsal = selectedMode === "production-v1" ? false
    : selectLocalAccountlessHostedRehearsalProfile({ environment, channel });
  if (environment.USAGE_MONITOR_ACCOUNTLESS_ORIGIN === undefined) return null;
  const origin = environment.USAGE_MONITOR_ACCOUNTLESS_ORIGIN;
  const laboratory = environment.USAGE_MONITOR_TEST_LANE === "accountless-local-lab-v1";
  if (accountlessTransportOrigin({ laboratory, rehearsal, production, origin }) === null
      || environment.USAGE_MONITOR_CENTRAL_ORIGIN !== undefined
      || (laboratory && environment.USAGE_MONITOR_ACCOUNTLESS_MODE !== undefined)
      || typeof channel.send !== "function" || channel.connected !== true) {
    throw accountlessConfigurationError();
  }
  if (performanceOptions !== null
      && (!performanceOptions || typeof performanceOptions !== "object"
        || Array.isArray(performanceOptions)
        || typeof performanceOptions.readPreparedDay !== "function"
        || (performanceOptions.schedulerOptions !== undefined
          && (!performanceOptions.schedulerOptions
            || typeof performanceOptions.schedulerOptions !== "object"
            || Array.isArray(performanceOptions.schedulerOptions)))
        || (performanceOptions.fetchImpl !== undefined
          && typeof performanceOptions.fetchImpl !== "function")
        || (performanceOptions.createEnvelope !== undefined
          && typeof performanceOptions.createEnvelope !== "function")
        || (performanceOptions.stateFile !== undefined
          && (typeof performanceOptions.stateFile !== "string"
            || performanceOptions.stateFile.length < 1)))) {
    throw accountlessConfigurationError();
  }
  let scheduler;
  let performanceScheduler;
  let performanceGrantGeneration = 0;
  let performanceGrantedGeneration = -1;
  let performanceResumeRequested = false;
  const bridge = createAccountlessChildChannel({ channel,
    onInvalidated: () => {
      performanceGrantGeneration += 1;
      performanceGrantedGeneration = -1;
      performanceResumeRequested = true;
      scheduler?.preferenceChanged();
      performanceScheduler?.preferenceChanged();
    },
  });
  scheduler = createAccountlessContributionScheduler({
    ...schedulerOptions, origin,
    readPreference: bridge.readPreference,
    runner: ({ signal }) => runner({ laboratory, rehearsal, production, origin, indexFile,
      negotiateSuccessors: true,
      stateFile: join(stateRoot, "accountless-device-binding-v1.json"),
      progressFile: join(stateRoot, "private", "accountless-upload-progress-v1.json"),
      backend: bridge.backend, readPreference: bridge.readPreference, signal,
      readAccountMarkers, loadExistingAccountObservationSecret }),
    onStatus: (status) => { void bridge.reportStatus(status).catch(() => {}); },
  });
  if (performanceOptions !== null) {
    const fetchImpl = performanceOptions.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") throw accountlessConfigurationError();
    const createEnvelope = performanceOptions.createEnvelope
      ?? createTelemetryPerformanceEnvelope;
    const performanceStateFile = performanceOptions.stateFile
      ?? join(stateRoot, "private", "accountless-performance-sync-state-v1.json");
    const performanceFetch = async (...args) => {
      const preference = await bridge.readPreference();
      assertPerformancePreference(preference, origin);
      const [url, init = {}] = args;
      const response = await fetchImpl(url, { ...init, credentials: "omit", redirect: "error", cache: "no-store",
        signal: init.signal ?? AbortSignal.timeout(15_000) });
      // A preference transition may race the response. Do not let a stale
      // capability or envelope key authorize a subsequent operation.
      assertPerformancePreference(await bridge.readPreference(), origin);
      return response;
    };
    const withSecret = (operation) => withContributionDeviceSecret({
      backend: bridge.backend,
      stateFile: join(stateRoot, "accountless-device-binding-v1.json"),
      expectedOrigin: origin,
      operation,
    });
    const readAuthorization = async () => {
      const generation = performanceGrantGeneration;
      const preference = await bridge.readPreference();
      assertPerformancePreference(preference, origin);
      // The grant route is idempotent and is intentionally independent of
      // usage authorization. Re-prove it once per protected preference
      // generation so an accountless opt-out cannot leave a performance grant
      // as a hidden upload path, while one day pass does not create a grant
      // request for every capability/report lease.
      if (performanceGrantedGeneration !== generation) {
        const grant = await withSecret(async (secret, binding) => {
          try {
            if (!binding || !DEVICE_ID.test(binding.deviceId)) {
              throw performanceError("telemetry_performance_authorization_rejected");
            }
            const response = await performanceFetch(new URL(
              PERFORMANCE_AUTHORIZATION_PATH, origin,
            ), {
              method: "POST",
              cache: "no-store",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                Authorization: `Device um_device_${binding.deviceId}.${secret.toString("base64url")}`,
              },
              body: JSON.stringify(PERFORMANCE_AUTHORIZATION),
            });
            const failure = performanceResponseFailure(response);
            if (failure) return { failure };
            return Object.freeze({ status: response.status, payload: await readBoundedJson(response) });
          } catch (error) {
            // The secret lease intentionally sanitizes thrown callback errors.
            // Return only a typed, content-free transport failure through it.
            return { failure: error?.code?.startsWith("telemetry_performance_") ? error
              : performanceError("telemetry_performance_capability_unavailable") };
          }
        });
        if (generation !== performanceGrantGeneration) throw performanceError("telemetry_performance_authorization_rejected");
        if (grant?.failure) throw grant.failure;
        if (!grant || ![200, 201].includes(grant.status)) throw performanceError("telemetry_performance_authorization_rejected");
        if (!grant.payload || typeof grant.payload !== "object" || Array.isArray(grant.payload)
            || Object.keys(grant.payload).length !== Object.keys(PERFORMANCE_AUTHORIZATION).length
            || Object.entries(PERFORMANCE_AUTHORIZATION).some(([key, value]) => grant.payload[key] !== value)) {
          throw performanceError("telemetry_performance_response_invalid");
        }
        performanceGrantedGeneration = generation;
      }
      assertPerformancePreference(await bridge.readPreference(), origin);
      return withSecret(async (secret, binding) => (
        `Device um_device_${binding.deviceId}.${secret.toString("base64url")}`
      ));
    };
    const readEnvelopeKey = async () => {
      let response;
      try {
        response = await performanceFetch(new URL(PERFORMANCE_ENVELOPE_KEY_PATH, origin), {
          method: "GET", headers: { Accept: "application/json" },
        });
      } catch (error) {
        if (error?.code?.startsWith("telemetry_performance_")) throw error;
        throw performanceError("telemetry_performance_capability_unavailable");
      }
      const failure = performanceResponseFailure(response);
      if (failure) throw failure;
      if (response.status !== 200) throw performanceError("telemetry_performance_response_invalid");
      return assertPerformanceEnvelopeKey(await readBoundedJson(response));
    };
    const client = createTelemetryPerformanceClient({
      origin,
      fetchImpl: performanceFetch,
      readAuthorization,
      readPreparedDay: performanceOptions.readPreparedDay,
      readState: async () => {
        const state = await readPerformanceState(performanceStateFile);
        if (!performanceResumeRequested) return state;
        let preference = null;
        try { preference = await bridge.readPreference(); } catch { /* sync remains paused */ }
        if (preference?.enabled !== true) return state;
        performanceResumeRequested = false;
        if (state.paused && [
          "authorization_rejected", "device_disconnected", "global_paused",
          "retry_exhausted",
        ].includes(state.pausedReason)) return initialTelemetryPerformanceSyncState();
        return state;
      },
      saveState: (value) => writePerformanceState(performanceStateFile, value),
      createEnvelope: async ({ report }) => {
        const key = await readEnvelopeKey();
        return createEnvelope({ report, ...key });
      },
    });
    performanceScheduler = createTelemetryPerformanceScheduler({
      ...performanceOptions.schedulerOptions,
      runner: ({ day, nowEpoch, resetRetryCount }) => client.runDay({ day, nowEpoch, resetRetryCount }),
      backfillDays: performanceOptions.schedulerOptions?.backfillDays ?? 7,
      includeCurrentDay: performanceOptions.schedulerOptions?.includeCurrentDay ?? true,
    });
  }
  return Object.freeze({
    start() {
      const status = scheduler.start();
      performanceScheduler?.start();
      return status;
    },
    inspect: scheduler.inspect,
    inspectDiagnostics: scheduler.inspectDiagnostics,
    notifyIndexPublished: scheduler.notifyIndexPublished,
    runNow: scheduler.runNow,
    performanceInspect: () => performanceScheduler?.inspect() ?? Object.freeze({ state: "off", lastAcceptedAt: null, nextAttemptAt: null }),
    performanceRunNow: () => performanceScheduler?.runNow() ?? Promise.resolve(Object.freeze({ state: "off", lastAcceptedAt: null, nextAttemptAt: null })),
    async stop() {
      try {
        await performanceScheduler?.stop();
        await scheduler.stop();
      }
      finally { bridge.dispose(); }
    },
  });
}
