import {
  PERFORMANCE_BUCKET_SCHEME_VERSION,
  PERFORMANCE_FIELD_DICTIONARY_VERSION,
  PERFORMANCE_MEASUREMENT_VERSION,
  PERFORMANCE_PRIVACY_CONTRACT_VERSION,
  PERFORMANCE_RECORD_SCHEMA_VERSION,
  canonicalTelemetryPerformanceJson,
  parseTelemetryPerformanceRecord,
} from "@app-usagemonitor/telemetry-contract";

/**
 * Performance is a separate, opt-in transport.  This module deliberately
 * receives projected daily records rather than a local reader: source
 * selection, overlap policy, and the usage contribution grant remain outside
 * this dialect.
 */
export const TELEMETRY_PERFORMANCE_REPORT_SCHEMA_VERSION =
  "telemetry-performance-report-v1";
export const TELEMETRY_PERFORMANCE_METHOD_VERSION =
  "performance-daily-histogram-v1";
export const TELEMETRY_PERFORMANCE_PRIVACY_CONTRACT_VERSION =
  PERFORMANCE_PRIVACY_CONTRACT_VERSION;
export const TELEMETRY_PERFORMANCE_CAPABILITIES_VERSION =
  "telemetry-performance-capabilities-v1";
export const TELEMETRY_PERFORMANCE_AUTHORIZATION_VERSION =
  "telemetry-performance-authorization-v1";
export const TELEMETRY_PERFORMANCE_SYNC_STATE_VERSION =
  "telemetry-performance-sync-state-v1";
export const TELEMETRY_PERFORMANCE_SCOPE = "model-performance-daily";
export const TELEMETRY_PERFORMANCE_SUPPORTED_SPEED_METHODS = Object.freeze([
  "receipt", "tool_free",
]);
export const MAX_TELEMETRY_PERFORMANCE_REPORT_RECORDS = 1_024;
export const MAX_TELEMETRY_PERFORMANCE_REPORT_BYTES = 1_250_000;
export const MAX_TELEMETRY_PERFORMANCE_RETRIES = 8;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const REPORT_KEYS = Object.freeze([
  "schemaVersion", "day", "reportRevision", "sourceGeneration", "sourceDigest",
  "sourceRevision", "methodVersion", "parserVersion", "fieldDictionaryVersion",
  "privacyContractVersion", "bucketSchemeVersion", "measurementVersion", "records",
]);
const CONSENT_KEYS = Object.freeze([
  "schemaVersion", "fieldDictionaryVersion", "privacyContractVersion", "scope",
]);
const AUTHORIZATION_KEYS = Object.freeze([
  "schemaVersion", "capabilityRevision", "authorityEpoch", "issuedAt", "expiresAt",
  "scope",
]);
const CAPABILITY_KEYS = Object.freeze([
  "schemaVersion", "lifecycle", "consentCurrent", "authorizationCurrent",
  "requiredConsent", "authorization", "supportedSpeedMethods",
]);
const STATE_KEYS = Object.freeze([
  "schemaVersion", "cursorDay", "lastAttemptAt", "lastOutcome", "nextAttemptAt",
  "paused", "pausedReason", "retryCount", "lastReportRevision",
]);
const OUTCOME_KEYS = Object.freeze(["at", "code", "status"]);

function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value, keys) {
  return plain(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function integer(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function instant(value) {
  return typeof value === "string"
    && value.length === 24
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function day(value) {
  return typeof value === "string"
    && DAY_PATTERN.test(value)
    && instant(`${value}T00:00:00.000Z`);
}

function freeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function fail(code) {
  const error = new TypeError("Telemetry performance sync failed closed");
  error.code = `telemetry_performance_${code}`;
  throw error;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plain(value)) {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) fail("crypto_unavailable");
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return [...digest].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function snapshotRecord(value) {
  // The package contract rejects accessors and unknown keys before this copy.
  // Canonical JSON gives the sync layer an ordinary immutable data tree and
  // ensures a caller cannot change report bytes after preparation.
  let serialized;
  try {
    serialized = canonicalTelemetryPerformanceJson(value);
    return JSON.parse(serialized);
  } catch {
    fail("record_invalid");
  }
}

function validateReportShape(value) {
  if (!exact(value, REPORT_KEYS)
      || value.schemaVersion !== TELEMETRY_PERFORMANCE_REPORT_SCHEMA_VERSION
      || !day(value.day)
      || !DIGEST_PATTERN.test(value.reportRevision)
      || !TOKEN_PATTERN.test(value.sourceGeneration)
      || !DIGEST_PATTERN.test(value.sourceDigest)
      || !integer(value.sourceRevision)
      || !TOKEN_PATTERN.test(value.methodVersion)
      || !TOKEN_PATTERN.test(value.parserVersion)
      || value.fieldDictionaryVersion !== PERFORMANCE_FIELD_DICTIONARY_VERSION
      || value.privacyContractVersion !== PERFORMANCE_PRIVACY_CONTRACT_VERSION
      || value.bucketSchemeVersion !== PERFORMANCE_BUCKET_SCHEME_VERSION
      || value.measurementVersion !== PERFORMANCE_MEASUREMENT_VERSION
      || !Array.isArray(value.records)
      || value.records.length > MAX_TELEMETRY_PERFORMANCE_REPORT_RECORDS) {
    fail("report_invalid");
  }
  const records = value.records.map((record) => {
    try {
      parseTelemetryPerformanceRecord(record);
    } catch {
      fail("record_invalid");
    }
    const snapshot = snapshotRecord(record);
    if (snapshot.day !== value.day) fail("report_day_mismatch");
    return snapshot;
  });
  const digests = records.map((record) => canonical(record));
  if (new Set(digests).size !== digests.length
      || digests.some((item, index) => index > 0 && digests[index - 1] > item)) {
    fail("report_order_invalid");
  }
  return records;
}

function reportBody({
  day: reportDay, sourceGeneration, sourceDigest, sourceRevision, methodVersion,
  parserVersion, records,
}) {
  return {
    schemaVersion: TELEMETRY_PERFORMANCE_REPORT_SCHEMA_VERSION,
    day: reportDay,
    sourceGeneration,
    sourceDigest,
    sourceRevision,
    methodVersion,
    parserVersion,
    fieldDictionaryVersion: PERFORMANCE_FIELD_DICTIONARY_VERSION,
    privacyContractVersion: PERFORMANCE_PRIVACY_CONTRACT_VERSION,
    bucketSchemeVersion: PERFORMANCE_BUCKET_SCHEME_VERSION,
    measurementVersion: PERFORMANCE_MEASUREMENT_VERSION,
    records,
  };
}

/**
 * Build the immutable daily report that is eligible for the independent
 * performance transport.  `sourceGeneration` and `sourceDigest` are opaque
 * facts supplied by the local timing store; this function never derives them
 * from a path, session, turn, or raw source row.
 */
export async function prepareTelemetryPerformanceDay({
  records,
  day: selectedDay = null,
  sourceGeneration,
  sourceDigest,
  sourceRevision,
  parserVersion,
  expectedReportRevision = null,
} = {}) {
  if (!Array.isArray(records)
      || !TOKEN_PATTERN.test(sourceGeneration)
      || !DIGEST_PATTERN.test(sourceDigest)
      || !integer(sourceRevision)
      || !TOKEN_PATTERN.test(parserVersion)
      || (selectedDay !== null && !day(selectedDay))) {
    fail("configuration_invalid");
  }
  const reportDay = selectedDay ?? records[0]?.day;
  if (!day(reportDay)) fail("configuration_invalid");
  const bodyRecords = validateReportShape({
    schemaVersion: TELEMETRY_PERFORMANCE_REPORT_SCHEMA_VERSION,
    day: reportDay,
    reportRevision: "0".repeat(64),
    sourceGeneration,
    sourceDigest,
    sourceRevision,
    methodVersion: TELEMETRY_PERFORMANCE_METHOD_VERSION,
    parserVersion,
    fieldDictionaryVersion: PERFORMANCE_FIELD_DICTIONARY_VERSION,
    privacyContractVersion: PERFORMANCE_PRIVACY_CONTRACT_VERSION,
    bucketSchemeVersion: PERFORMANCE_BUCKET_SCHEME_VERSION,
    measurementVersion: PERFORMANCE_MEASUREMENT_VERSION,
    records,
  });
  const body = reportBody({
    day: reportDay,
    sourceGeneration,
    sourceDigest,
    sourceRevision,
    methodVersion: TELEMETRY_PERFORMANCE_METHOD_VERSION,
    parserVersion,
    records: bodyRecords,
  });
  const reportRevision = await sha256Hex(canonical(body));
  if (expectedReportRevision !== null && expectedReportRevision !== reportRevision) {
    fail("report_revision_mismatch");
  }
  const report = { ...body, reportRevision };
  const bytes = new TextEncoder().encode(canonical(report)).byteLength;
  if (bytes < 1 || bytes > MAX_TELEMETRY_PERFORMANCE_REPORT_BYTES) {
    fail("report_too_large");
  }
  return freeze(report);
}

export function initialTelemetryPerformanceSyncState() {
  return freeze({
    schemaVersion: TELEMETRY_PERFORMANCE_SYNC_STATE_VERSION,
    cursorDay: null,
    lastAttemptAt: null,
    lastOutcome: null,
    nextAttemptAt: null,
    paused: false,
    pausedReason: null,
    retryCount: 0,
    lastReportRevision: null,
  });
}

function normalizedState(value) {
  if (value === null || value === undefined) return initialTelemetryPerformanceSyncState();
  if (!exact(value, STATE_KEYS)
      || value.schemaVersion !== TELEMETRY_PERFORMANCE_SYNC_STATE_VERSION
      || (value.cursorDay !== null && !day(value.cursorDay))
      || (value.lastAttemptAt !== null && !instant(value.lastAttemptAt))
      || (value.nextAttemptAt !== null && !instant(value.nextAttemptAt))
      || (value.lastReportRevision !== null && !DIGEST_PATTERN.test(value.lastReportRevision))
      || typeof value.paused !== "boolean"
      || (value.pausedReason !== null && !TOKEN_PATTERN.test(value.pausedReason))
      || !integer(value.retryCount, MAX_TELEMETRY_PERFORMANCE_RETRIES)
      || (value.lastOutcome !== null
        && (!exact(value.lastOutcome, OUTCOME_KEYS)
          || !instant(value.lastOutcome.at)
          || !TOKEN_PATTERN.test(value.lastOutcome.code)
          || !["succeeded", "retry", "paused"].includes(value.lastOutcome.status)))) {
    fail("state_invalid");
  }
  return freeze({ ...value, lastOutcome: value.lastOutcome === null ? null : { ...value.lastOutcome } });
}

export function parseTelemetryPerformanceSyncState(value) {
  return normalizedState(value);
}

function capability(value, nowEpoch) {
  if (!exact(value, CAPABILITY_KEYS)
      || value.schemaVersion !== TELEMETRY_PERFORMANCE_CAPABILITIES_VERSION
      || !["accepted", "staged", "blocked"].includes(value.lifecycle)
      || typeof value.consentCurrent !== "boolean"
      || typeof value.authorizationCurrent !== "boolean"
      || !Array.isArray(value.supportedSpeedMethods)
      || value.supportedSpeedMethods.length !== TELEMETRY_PERFORMANCE_SUPPORTED_SPEED_METHODS.length
      || value.supportedSpeedMethods.some((method, index) => method !== TELEMETRY_PERFORMANCE_SUPPORTED_SPEED_METHODS[index])
      || !exact(value.requiredConsent, CONSENT_KEYS)
      || value.requiredConsent.schemaVersion !== PERFORMANCE_RECORD_SCHEMA_VERSION
      || value.requiredConsent.fieldDictionaryVersion !== PERFORMANCE_FIELD_DICTIONARY_VERSION
      || value.requiredConsent.privacyContractVersion !== PERFORMANCE_PRIVACY_CONTRACT_VERSION
      || value.requiredConsent.scope !== TELEMETRY_PERFORMANCE_SCOPE
      || !exact(value.authorization, AUTHORIZATION_KEYS)
      || value.authorization.schemaVersion !== TELEMETRY_PERFORMANCE_AUTHORIZATION_VERSION
      || !integer(value.authorization.capabilityRevision, 2_147_483_647)
      || value.authorization.capabilityRevision < 1
      || !integer(value.authorization.authorityEpoch, 2_147_483_647)
      || value.authorization.authorityEpoch < 1
      || !instant(value.authorization.issuedAt)
      || !instant(value.authorization.expiresAt)
      || Date.parse(value.authorization.expiresAt) <= nowEpoch
      || value.authorization.scope !== TELEMETRY_PERFORMANCE_SCOPE) {
    fail("capability_invalid");
  }
  if (value.lifecycle !== "accepted" || !value.consentCurrent || !value.authorizationCurrent) {
    fail("authorization_rejected");
  }
  return freeze(value);
}

function outcomeState(state, nowEpoch, code, status, patch = {}) {
  const at = new Date(nowEpoch).toISOString();
  const next = {
    ...state,
    ...patch,
    lastAttemptAt: at,
    lastOutcome: { at, code, status },
  };
  return freeze(next);
}

function retryDelay(retryCount) {
  return Math.min(3_600_000, 5_000 * (2 ** Math.min(retryCount, 10)));
}

function responseStatus(value) {
  if (Number.isSafeInteger(value)) return value;
  if (value && Number.isSafeInteger(value.status)) return value.status;
  return null;
}

/**
 * Execute one bounded performance report attempt.  State persistence is
 * injected so the app can use its owner-only storage and tests can use an
 * in-memory adapter.  The caller supplies the independent capability and
 * envelope request functions; no usage grant or usage scheduler is consulted.
 */
export async function runTelemetryPerformanceSync({
  day: selectedDay,
  state: suppliedState = null,
  nowEpoch = Date.now(),
  globalPaused = false,
  deviceConnected = true,
  readCapabilities,
  prepareDay,
  createEnvelope,
  send,
  saveState = async () => {},
} = {}) {
  if (!day(selectedDay) || !integer(nowEpoch) || nowEpoch < 0
      || typeof readCapabilities !== "function"
      || typeof prepareDay !== "function"
      || typeof createEnvelope !== "function"
      || typeof send !== "function"
      || typeof saveState !== "function") {
    fail("configuration_invalid");
  }
  let state = normalizedState(suppliedState);
  if (globalPaused) {
    state = outcomeState(state, nowEpoch, "global_paused", "paused", {
      paused: true, pausedReason: "global_paused", nextAttemptAt: null,
    });
    await saveState(state);
    return Object.freeze({ state, status: "paused", reportRevision: null });
  }
  if (!deviceConnected) {
    state = outcomeState(state, nowEpoch, "device_disconnected", "paused", {
      paused: true, pausedReason: "device_disconnected", nextAttemptAt: null,
    });
    await saveState(state);
    return Object.freeze({ state, status: "paused", reportRevision: null });
  }
  if (state.paused || (state.nextAttemptAt !== null && Date.parse(state.nextAttemptAt) > nowEpoch)) {
    return Object.freeze({ state, status: "paused", reportRevision: null });
  }

  let cap;
  try {
    cap = capability(await readCapabilities(), nowEpoch);
  } catch (error) {
    const code = error?.code === "telemetry_performance_authorization_rejected"
      ? "authorization_rejected" : "capability_unavailable";
    if (code === "authorization_rejected") {
      state = outcomeState(state, nowEpoch, code, "paused", {
        paused: true, pausedReason: code, nextAttemptAt: null,
      });
      await saveState(state);
      return Object.freeze({ state, status: "paused", reportRevision: null });
    }
    const retryCount = Math.min(MAX_TELEMETRY_PERFORMANCE_RETRIES, state.retryCount + 1);
    state = outcomeState(state, nowEpoch, code, retryCount >= MAX_TELEMETRY_PERFORMANCE_RETRIES ? "paused" : "retry", {
      retryCount,
      paused: retryCount >= MAX_TELEMETRY_PERFORMANCE_RETRIES,
      pausedReason: retryCount >= MAX_TELEMETRY_PERFORMANCE_RETRIES ? "retry_exhausted" : null,
      nextAttemptAt: new Date(nowEpoch + retryDelay(retryCount)).toISOString(),
    });
    await saveState(state);
    return Object.freeze({ state, status: state.paused ? "paused" : "retry", reportRevision: null });
  }

  let report;
  try {
    report = await prepareDay({ day: selectedDay, capability: cap });
    validateReportShape(report);
  } catch {
    state = outcomeState(state, nowEpoch, "report_invalid", "paused", {
      paused: true, pausedReason: "report_invalid", nextAttemptAt: null,
    });
    await saveState(state);
    return Object.freeze({ state, status: "paused", reportRevision: null });
  }
  const envelope = await createEnvelope({ report, authorization: cap.authorization });
  let response;
  try {
    response = await send({ envelope, authorization: cap.authorization, report });
  } catch {
    response = { status: 503 };
  }
  const status = responseStatus(response);
  if ((status !== null && status >= 200 && status < 300)
      || status === 409) {
    state = outcomeState(state, nowEpoch, status === 409 ? "idempotent" : "accepted", "succeeded", {
      cursorDay: selectedDay,
      lastReportRevision: report.reportRevision,
      retryCount: 0,
      nextAttemptAt: null,
      paused: false,
      pausedReason: null,
    });
    await saveState(state);
    return Object.freeze({ state, status: "succeeded", reportRevision: report.reportRevision });
  }
  if (status === 401 || status === 403) {
    state = outcomeState(state, nowEpoch, "authorization_rejected", "paused", {
      paused: true, pausedReason: "authorization_rejected", nextAttemptAt: null,
    });
    await saveState(state);
    return Object.freeze({ state, status: "paused", reportRevision: report.reportRevision });
  }
  if (status === 408 || status === 425 || status === 429 || (status !== null && status >= 500)
      || status === null) {
    const retryCount = Math.min(MAX_TELEMETRY_PERFORMANCE_RETRIES, state.retryCount + 1);
    const exhausted = retryCount >= MAX_TELEMETRY_PERFORMANCE_RETRIES;
    state = outcomeState(state, nowEpoch, "service_unavailable", exhausted ? "paused" : "retry", {
      retryCount,
      paused: exhausted,
      pausedReason: exhausted ? "retry_exhausted" : null,
      nextAttemptAt: new Date(nowEpoch + retryDelay(retryCount)).toISOString(),
    });
    await saveState(state);
    return Object.freeze({ state, status: exhausted ? "paused" : "retry", reportRevision: report.reportRevision });
  }
  state = outcomeState(state, nowEpoch, "upload_rejected", "paused", {
    paused: true, pausedReason: "upload_rejected", nextAttemptAt: null,
  });
  await saveState(state);
  return Object.freeze({ state, status: "paused", reportRevision: report.reportRevision });
}
