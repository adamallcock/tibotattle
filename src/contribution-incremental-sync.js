import { createHash } from "node:crypto";
import {
  TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
  telemetryV11RequiredConsent,
} from "@app-usagemonitor/telemetry-contract";

import {
  withContributionDeviceSecret,
} from "./contribution-device-capability.js";
import {
  buildTelemetryV1ChunkPlaintext,
  createTelemetryV1IndexReader,
  planTelemetryV1Upload,
  telemetryV1HistoryDigest,
  telemetryV1RequiredConsent,
} from "./contribution/telemetry-v1-chunks.js";
import {
  createTelemetryV1Envelope,
} from "./platform/telemetry-v1-envelope.js";
import {
  createOwnerOnlyAutomaticContributionStorageContext,
  createTelemetryV11Envelope,
} from "./platform/index.js";
import {
  createTelemetryV11Day,
  readTelemetryV11Capabilities,
  runTelemetryV11Sync,
  sanitizeTelemetryAttributionBinding,
  telemetryV11FieldInventory,
} from "./contribution/index.js";
import { createLocalUnifiedTelemetryV11Reader } from "./local-unified-contribution-attribution.js";
import {
  LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  openLocalUnifiedIndex,
  outcomeName,
  reasoningEffortName,
  readUnifiedIndexGenerationDescriptor,
} from "./local-unified-index.js";

// The telemetry-contribution-v1.0 sync engine: one bounded pass of the cursor
// protocol. Maintained route and contract inventories live in
// docs/reference/api-surface.md and docs/reference/schema-contracts.md.
// Strictly sequential, oldest day first, one envelope in flight.
//
// The service is authoritative for what it accepted; this engine re-derives
// the local truth per pass and never trusts a cached cursor: one cheap
// sync-state read answers the common case (history digest matches, upload
// only the tail), and any disagreement resolves through the day-granular
// manifest diff. Everything returned is a bounded typed figure — day counts,
// chunk counts, ISO days and fixed codes; no path, no content, no identifier
// beyond what the wire contract itself carries.

const RUN_SCHEMA_VERSION = "incremental-contribution-sync-run-v1.0";
// 2026-08-10 (owner-directed): the first full-history backfill is the pass
// that matters — at 60 chunks/pass an 84-day corpus took most of a day of
// pass overhead and retry ladders. 500 per pass lets a typical backfill
// finish in one or two passes while staying far inside the service's
// admission budgets (20k chunks/device/day launch week, 2k steady) and the
// absolute per-pass bound below.
const DEFAULT_MAXIMUM_CHUNKS_PER_PASS = 500;
const MAXIMUM_CHUNKS_PER_PASS = 2_000;
const MAX_RESPONSE_BYTES = 32_768;
const MAX_MANIFEST_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_WINDOWS_PER_PASS = 120;
const MANIFEST_WINDOW_DAYS = 31;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const MAXIMUM_RETRY_AFTER_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
// A single request must never outlive the pass. A connection that stalls
// mid-flight — a service redeploy that accepts the socket and sends headers,
// then never finishes the body (observed live 2026-08-12: a backfill froze at
// 56/88 with running:true for nine minutes after a transient 5xx) — would
// otherwise pin the pass on a fetch that never settles, with only the
// controller's minutes-long pass deadline as a backstop. Each request carries
// its own bounded deadline, composed with any caller abort, so a stall
// surfaces as a retryable service_unavailable within seconds rather than
// hanging the pass behind an in-flight read.
const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 60_000;
const MAXIMUM_REQUEST_TIMEOUT_MILLISECONDS = 5 * 60 * 1_000;
const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const DIGEST_HEX = /^[0-9a-f]{64}$/u;
const DEVICE_UPLOAD =
  /^um_device_upload_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/u;
const CHUNK_CONTRIBUTION_ID =
  /^chunk:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_V11_PROGRESS_BYTES = 1024 * 1024;
const V11_PROGRESS_KEYS = Object.freeze(["schemaVersion", "contextDigest", "previousGenerationId",
  "legacyFingerprint", "sourceFingerprint", "validatedDays", "fromDay", "throughDay", "days"]);

const ERROR_CODES = new Set([
  "invalid_configuration",
  "consent_invalid",
]);

// Pass-terminating conditions, all bounded and typed. `retryable` means the
// next scheduled pass may simply run again; `deviceUnavailable` mirrors the
// v0.1 queue's auto-pause trigger exactly.
const FAILURE_CODES = new Set([
  "admission_exhausted",
  "device_unavailable",
  "service_unavailable",
  "authorization_rejected",
  "upload_rejected",
  "consent_rejected",
  "revision_conflict",
  "response_invalid",
  "index_unavailable",
  "local_index_changed",
  "interrupted",
]);

export class ContributionIncrementalSyncError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown incremental sync error code");
    }
    super("Incremental contribution sync failed closed");
    this.name = "ContributionIncrementalSyncError";
    this.code = `contribution_incremental_sync_${code}`;
  }
}

function fail(code) {
  throw new ContributionIncrementalSyncError(code);
}

class PassFailure extends Error {
  constructor(code, {
    retryable = false,
    deviceUnavailable = false,
    retryAfterMilliseconds = null,
  } = {}) {
    if (!FAILURE_CODES.has(code)) {
      throw new TypeError("Unknown incremental sync failure code");
    }
    super(code);
    this.name = "PassFailure";
    this.failureCode = code;
    this.retryable = retryable;
    this.deviceUnavailable = deviceUnavailable;
    this.retryAfterMilliseconds = retryAfterMilliseconds;
  }
}

function interrupt(code, options = {}) {
  throw new PassFailure(code, options);
}

function canonicalOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("invalid_configuration");
  }
  const loopback = parsed.protocol === "http:"
    && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if ((parsed.protocol !== "https:" && !loopback)
      || parsed.username !== "" || parsed.password !== ""
      || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    fail("invalid_configuration");
  }
  return parsed.origin;
}

function retryAfter(response, now = Date.now()) {
  const value = response.headers.get("retry-after")?.trim() ?? "";
  if (value.length === 0 || value.length > 128) return null;
  let milliseconds;
  if (/^\d+$/u.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds)) return null;
    milliseconds = seconds * 1_000;
  } else {
    if (!IMF_FIXDATE.test(value)) return null;
    const retryAt = Date.parse(value);
    if (!Number.isFinite(retryAt)) return null;
    milliseconds = Math.max(0, retryAt - now);
  }
  return Number.isSafeInteger(milliseconds)
    && milliseconds <= MAXIMUM_RETRY_AFTER_MILLISECONDS
    ? milliseconds
    : MAXIMUM_RETRY_AFTER_MILLISECONDS;
}

async function readJson(response, {
  deviceAuthorized = false,
  maximumBytes = MAX_RESPONSE_BYTES,
} = {}) {
  if (!(response instanceof Response)) interrupt("response_invalid");
  if (response.headers.get("cache-control") !== "no-store"
      || !(response.headers.get("content-type") ?? "")
        .toLowerCase().startsWith("application/json")) {
    interrupt("response_invalid");
  }
  let text;
  try {
    text = await response.text();
  } catch {
    interrupt("service_unavailable", { retryable: true });
  }
  if (Buffer.byteLength(text, "utf8") > maximumBytes) {
    interrupt("response_invalid");
  }
  let payload;
  try {
    payload = text.length === 0 ? null : JSON.parse(text);
  } catch {
    interrupt("response_invalid");
  }
  if (response.ok) return payload;

  const backendCode = payload?.error?.code;
  if (deviceAuthorized
      && ["DEVICE_AUTH_INVALID", "PARTICIPANT_DELETING", "UPLOAD_AUTH_INVALID"]
        .includes(backendCode)) {
    interrupt("device_unavailable", { deviceUnavailable: true });
  }
  // Both admission limits mean the same thing to the client: the service is
  // deliberately pacing a burst (a full-history backfill requests one upload
  // authorization and posts one chunk per window, so either the per-minute
  // authorization budget on /upload-authorizations — UPLOAD_ADMISSION_LIMIT_
  // REACHED — or the chunk budget on /contributions — CHUNK_ADMISSION_LIMIT_
  // REACHED — trips first). Both must resume at the advertised Retry-After
  // window, NOT climb the exponential service-pressure ladder: admission_
  // exhausted settles "partial" and reschedules at the retry-after floor
  // without incrementing retryCount, whereas the generic 429/5xx bucket below
  // settles "failed" and escalates the backoff every pass — which would report
  // an ordinary rate-limit as a service failure and progressively stall the
  // backfill instead of draining it at a steady cadence.
  if (response.status === 429
      && (backendCode === "CHUNK_ADMISSION_LIMIT_REACHED"
        || backendCode === "UPLOAD_ADMISSION_LIMIT_REACHED")) {
    interrupt("admission_exhausted", {
      retryable: true,
      retryAfterMilliseconds: retryAfter(response),
    });
  }
  if (response.status === 409 && backendCode === "CHUNK_REVISION_CONFLICT") {
    interrupt("revision_conflict", { retryable: true });
  }
  if (backendCode === "TELEMETRY_CONSENT_INVALID") {
    interrupt("consent_rejected");
  }
  if (response.status === 408 || response.status === 429
      || response.status >= 500) {
    interrupt("service_unavailable", {
      retryable: true,
      retryAfterMilliseconds: retryAfter(response),
    });
  }
  interrupt(deviceAuthorized ? "authorization_rejected" : "upload_rejected");
}

async function requestJson(fetchImpl, url, options, classification = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      credentials: "omit",
      redirect: "error",
      ...options,
    });
  } catch {
    interrupt("service_unavailable", { retryable: true });
  }
  return readJson(response, classification);
}

function isUtcDay(value) {
  return typeof value === "string"
    && DAY_PATTERN.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`));
}

function validSyncState(value) {
  return value !== null
    && typeof value === "object"
    && value.schemaVersion === "device-sync-state-v1.0"
    && (value.acknowledgedThroughDay === null
      || isUtcDay(value.acknowledgedThroughDay))
    && (value.historyDigest === null || DIGEST_HEX.test(value.historyDigest ?? ""));
}

function admissionExhausted(value, nowEpoch) {
  if (value?.state !== "exhausted") return false;
  const retryAtEpoch = Date.parse(value.retryAt ?? "");
  const retryAfterMilliseconds = Number.isFinite(retryAtEpoch)
    ? Math.min(
      MAXIMUM_RETRY_AFTER_MILLISECONDS,
      Math.max(0, retryAtEpoch - nowEpoch),
    )
    : null;
  interrupt("admission_exhausted", { retryable: true, retryAfterMilliseconds });
}

function deviceCapabilityFailure(error) {
  return typeof error?.code === "string"
    && error.code.startsWith("contribution_device_");
}

function addDays(day, count) {
  const epoch = Date.parse(`${day}T00:00:00.000Z`) + count * DAY_MILLISECONDS;
  return new Date(epoch).toISOString().slice(0, 10);
}

/**
 * Derive digests for every indexed day without retaining records: chunk
 * metadata is kept, the records are dropped, and the day is re-derived when
 * (and only when) one of its chunks actually uploads. Determinism makes the
 * second derivation exact — a digest that no longer matches means the index
 * advanced mid-pass, which ends the pass rather than shipping mixed content.
 */
async function deriveLocalDays(reader) {
  const days = reader.days();
  const derivedDays = [];
  for (const day of days) {
    const derived = reader.deriveDay(day);
    derivedDays.push({
      day: derived.day,
      dayDigest: derived.dayDigest,
      chunks: derived.chunks.map((chunk) => ({
        stream: chunk.stream,
        chunkSeq: chunk.chunkSeq,
        chunkId: chunk.chunkId,
        chunkDigest: chunk.chunkDigest,
        recordCount: chunk.recordCount,
      })),
    });
    // One breath per derived day: a first full-history pass runs across the
    // whole corpus, and without this yield it starves the companion's event
    // loop for the entire derivation — dashboard, menu bar, and diagnostics
    // all read as dead while the pass runs (observed live 2026-08-10).
    await new Promise((resolveDay) => setImmediate(resolveDay));
  }
  return derivedDays;
}

function tailPlan(localDays, acknowledgedThroughDay) {
  const uploads = [];
  let skippedChunks = 0;
  for (const localDay of localDays) {
    if (acknowledgedThroughDay !== null
        && localDay.day <= acknowledgedThroughDay) {
      skippedChunks += localDay.chunks.length;
      continue;
    }
    for (const chunk of localDay.chunks) {
      uploads.push(Object.freeze({
        day: localDay.day,
        chunkId: chunk.chunkId,
        stream: chunk.stream,
        chunkSeq: chunk.chunkSeq,
        chunkDigest: chunk.chunkDigest,
        revision: 1,
      }));
    }
  }
  return Object.freeze({
    uploads: Object.freeze(uploads),
    skippedChunks,
    orphanChunkIds: Object.freeze([]),
  });
}

function explicitV11Consent(consent, origin) {
  const required = telemetryV11RequiredConsent();
  if (!consent || typeof consent !== "object" || Array.isArray(consent)
      || Object.keys(consent).length !== 4
      || consent.destinationOrigin !== origin
      || Object.entries(required).some(([key, value]) => consent[key] !== value)) {
    fail("consent_invalid");
  }
  return required;
}

function v11Publication(database) {
  const descriptor = readUnifiedIndexGenerationDescriptor(database);
  if (!descriptor || !["complete", "partial"].includes(descriptor.status)
      || database.prepare("SELECT 1 FROM index_generation WHERE id > ? AND status = 'in_progress' LIMIT 1")
        .get(descriptor.id)) interrupt("index_unavailable", { retryable: true });
  return Object.freeze({
    fingerprint: descriptor.fingerprint,
    parserVersion: descriptor.parserVersion ?? LOCAL_UNIFIED_INDEX_PARSER_VERSION,
    dataVersion: database.prepare("PRAGMA data_version").get().data_version,
    changes: database.prepare("SELECT total_changes() AS count").get().count,
  });
}

// This is a private resumability journal, not authority to upload or a record
// of acknowledged history. The domain runner revalidates its entire context
// against fresh capabilities/predecessor before using this staged prefix.
function closedV11Progress(value) {
  if (value === null) return null;
  const keys = (record, expected) => record !== null && typeof record === "object" && !Array.isArray(record)
    && Object.keys(record).sort().join("\0") === [...expected].sort().join("\0");
  const day = (value) => typeof value === "string" && DAY_PATTERN.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
  if (!keys(value, V11_PROGRESS_KEYS) || value.schemaVersion !== "telemetry-v11-sync-progress-v1"
      || [value.contextDigest, value.legacyFingerprint, value.sourceFingerprint]
        .some((value) => typeof value !== "string" || !DIGEST_HEX.test(value))
      || (value.previousGenerationId !== null && (typeof value.previousGenerationId !== "string" || !UUID_V4.test(value.previousGenerationId)))
      || !day(value.fromDay) || !day(value.throughDay) || value.fromDay > value.throughDay
      || !Array.isArray(value.days) || value.days.length > 4096
      || !Number.isSafeInteger(value.validatedDays) || value.validatedDays < 0
      || value.validatedDays > value.days.length) interrupt("index_unavailable", { retryable: true });
  const days = value.days.map((entry, index) => {
    if (!keys(entry, ["day", "manifestId", "manifestDigest"]) || !day(entry.day)
        || typeof entry.manifestId !== "string" || !UUID_V4.test(entry.manifestId)
        || typeof entry.manifestDigest !== "string" || !DIGEST_HEX.test(entry.manifestDigest)
        || entry.day > value.throughDay
        || Date.parse(`${entry.day}T00:00:00.000Z`) !== Date.parse(`${value.fromDay}T00:00:00.000Z`) + index * DAY_MILLISECONDS) {
      interrupt("index_unavailable", { retryable: true });
    }
    return { day: entry.day, manifestId: entry.manifestId, manifestDigest: entry.manifestDigest };
  });
  return { schemaVersion: value.schemaVersion, contextDigest: value.contextDigest,
    previousGenerationId: value.previousGenerationId, legacyFingerprint: value.legacyFingerprint,
    sourceFingerprint: value.sourceFingerprint, validatedDays: value.validatedDays,
    fromDay: value.fromDay, throughDay: value.throughDay, days };
}

function localV11ProgressStore({ file, preparation, signal, injected }) {
  const storage = injected === undefined ? createOwnerOnlyAutomaticContributionStorageContext({
    createError: () => new PassFailure("index_unavailable", { retryable: true }),
  }) : null;
  const guard = () => {
    if (signal?.aborted) interrupt("interrupted", { retryable: true });
    preparation.assertCurrent();
  };
  return Object.freeze({
    async read() {
      guard();
      let value;
      if (injected !== undefined) value = await injected.read();
      else {
        const text = await storage.readSettingsText({ settingsFile: file, maximumBytes: MAX_V11_PROGRESS_BYTES });
        try { value = text === null ? null : JSON.parse(text); }
        catch { interrupt("index_unavailable", { retryable: true }); }
      }
      guard();
      return closedV11Progress(value);
    },
    async write(value) {
      guard();
      const closed = closedV11Progress(value);
      const text = JSON.stringify(closed);
      if (Buffer.byteLength(text) > MAX_V11_PROGRESS_BYTES) interrupt("index_unavailable", { retryable: true });
      if (injected !== undefined) await injected.write(closed);
      else await storage.writeSettingsText({ settingsFile: file, text, maximumBytes: MAX_V11_PROGRESS_BYTES });
      guard();
    },
  });
}

async function createV11Preparation(database, {
  readAccountMarkers = async () => [],
  loadExistingAccountObservationSecret = async () => null,
} = {}) {
  const accountMarkers = await readAccountMarkers();
  const publication = v11Publication(database);
  const reader = createLocalUnifiedTelemetryV11Reader(database, {
    outcomeName, reasoningEffortName,
    fallbackParserVersion: LOCAL_UNIFIED_INDEX_PARSER_VERSION,
    accountMarkers,
  });
  // Staged projections also depend on whether captured marker evidence exists.
  // Losing the last marker must revalidate an earlier marker-bearing prefix,
  // even though the next pass no longer forces marker/root revalidation. Keep
  // the actual index publication separate for mutation fencing and review.
  const sourcePublication = Object.freeze({
    fingerprint: createHash("sha256").update(JSON.stringify([
      "telemetry-v11-local-projection-v1", publication.fingerprint, accountMarkers.length > 0,
    ])).digest("hex"),
    parserVersion: publication.parserVersion,
  });
  let root = null;
  let rootLoaded = false;
  let closed = false;
  const assertCurrent = () => {
    if (closed) interrupt("index_unavailable", { retryable: true });
    const current = v11Publication(database);
    if (current.fingerprint !== publication.fingerprint
        || current.dataVersion !== publication.dataVersion || current.changes !== publication.changes) {
      const error = new Error("Local contribution publication changed");
      error.code = "local_index_changed";
      throw error;
    }
  };
  const days = reader.days();
  assertCurrent();
  return Object.freeze({
    days: Object.freeze(days), publication, sourcePublication, assertCurrent,
    // A root becoming readable (or a new captured marker) may alter the
    // projection without changing indexed facts. Recheck saved day digests
    // under the current evidence; do not probe an identity just to resume.
    revalidateProgress: accountMarkers.length > 0,
    async readDay(day, { binding }) {
      assertCurrent();
      const hydrated = reader.readDay(day);
      // A historical plan does not need an account root. Only an already
      // captured matching marker can request an existing-only secret lease.
      // A missing/locked root retains useful history as account-unknown.
      const hasBoundMarker = ["usage", "quota"].some((stream) => hydrated.recordsByStream[stream].some((record) => {
        const evidence = hydrated.attributionForRecord(stream, record);
        const captured = sanitizeTelemetryAttributionBinding(evidence?.observationBinding);
        return evidence?.accountBasis === "provisional_marker" && captured !== null
          && captured.destinationOrigin === binding.destinationOrigin && captured.enrollmentNamespace === binding.enrollmentNamespace;
      }));
      if (!rootLoaded && hasBoundMarker) {
        rootLoaded = true;
        try {
          const loaded = await loadExistingAccountObservationSecret();
          if (Buffer.isBuffer(loaded) && loaded.length === 32 && !closed) root = loaded;
          else if (Buffer.isBuffer(loaded)) loaded.fill(0);
        } catch { /* Missing account identity is explicit, not an upload failure. */ }
      }
      assertCurrent();
      const result = createTelemetryV11Day({
        day, ...hydrated, binding, accountObservationSecret: root,
        parserVersion: publication.parserVersion,
      });
      assertCurrent();
      return result;
    },
    close() { closed = true; root?.fill(0); root = null; },
  });
}

function v11Failure(error, { daysTotal = 0, networkActivity = false } = {}) {
  const code = deviceCapabilityFailure(error) ? "device_unavailable"
    : error?.code === "local_index_changed" ? "local_index_changed"
      : FAILURE_CODES.has(error?.failureCode) ? error.failureCode : "index_unavailable";
  return Object.freeze({
    schemaVersion: RUN_SCHEMA_VERSION, status: "failed", daysTotal, daysSynced: 0,
    daysPending: daysTotal, chunksUploaded: 0, chunksSkipped: 0, recordsUploaded: 0,
    acknowledgedThroughDay: null, orphanChunkIds: Object.freeze([]), stagedDays: 0,
    domainGenerationId: null, networkActivity,
    failure: Object.freeze({ code,
      retryable: ["index_unavailable", "local_index_changed", "interrupted"].includes(code)
        || error?.retryable === true,
      deviceUnavailable: code === "device_unavailable" || error?.deviceUnavailable === true,
      retryAfterMilliseconds: error?.retryAfterMilliseconds ?? null }),
  });
}

/** The old uploader remains the default. A successor consent is never inferred. */
export async function runIncrementalContributionSyncOnce(options = {}) {
  if (options.consent?.telemetrySchemaVersion !== TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION) {
    return runTelemetryV1SyncOnce(options);
  }
  const {
    indexFile, origin, backend, stateFile, consent, signal, fetchImpl = globalThis.fetch,
    cryptoImpl = globalThis.crypto, withDeviceSecret = withContributionDeviceSecret,
    openIndex = openLocalUnifiedIndex, maximumChunks = DEFAULT_MAXIMUM_CHUNKS_PER_PASS,
    requestTimeoutMilliseconds = DEFAULT_REQUEST_TIMEOUT_MILLISECONDS,
    maximumDurationMilliseconds = 60_000, now = Date.now,
    createV11Envelope = createTelemetryV11Envelope,
    runV11Sync = runTelemetryV11Sync,
    readAccountMarkers = async () => [], loadExistingAccountObservationSecret = async () => null,
    onAttributionBinding = null,
    progressStore = undefined, progressFile = null,
  } = options;
  const selectedOrigin = canonicalOrigin(origin);
  const selectedConsent = explicitV11Consent(consent, selectedOrigin);
  if (typeof indexFile !== "string" || !indexFile || !backend || typeof backend !== "object"
      || [fetchImpl, withDeviceSecret, openIndex, now, createV11Envelope, runV11Sync,
        readAccountMarkers, loadExistingAccountObservationSecret].some((value) => typeof value !== "function")
      || (onAttributionBinding !== null && typeof onAttributionBinding !== "function")
      || (progressFile !== null && (typeof progressFile !== "string" || !progressFile))
      || (progressStore !== undefined && (!progressStore || typeof progressStore.read !== "function"
        || typeof progressStore.write !== "function"))
      || !Number.isSafeInteger(maximumChunks) || maximumChunks < 1 || maximumChunks > MAXIMUM_CHUNKS_PER_PASS
      || !Number.isSafeInteger(requestTimeoutMilliseconds) || requestTimeoutMilliseconds < 1_000
      || requestTimeoutMilliseconds > MAXIMUM_REQUEST_TIMEOUT_MILLISECONDS
      || !Number.isSafeInteger(maximumDurationMilliseconds) || maximumDurationMilliseconds < 1
      || maximumDurationMilliseconds > 300_000
      || (signal !== undefined && !(signal instanceof AbortSignal))) fail("invalid_configuration");
  let database = null;
  let preparation = null;
  let networkActivity = false;
  let localIndexChanged = false;
  const fetch = async (url, request) => {
    // In addition to each day read, fence the final activation request. A
    // mutable source replacement must never activate an older/newer mixture.
    try { preparation?.assertCurrent(); }
    catch (error) { localIndexChanged = true; throw error; }
    const response = await fetchImpl(url, request);
    networkActivity = true;
    return response;
  };
  try {
    database = openIndex(indexFile, { readOnly: true });
    preparation = await createV11Preparation(database, { readAccountMarkers, loadExistingAccountObservationSecret });
    const progress = localV11ProgressStore({ file: progressFile ?? `${indexFile}.telemetry-v11-progress.json`,
      preparation, signal, injected: progressStore });
    return await withDeviceSecret({ backend,
      ...(stateFile === undefined ? {} : { stateFile }), expectedOrigin: selectedOrigin,
      operation: async (secret, device) => {
        try {
          let envelopeKey = null;
          const result = await runV11Sync({
            serverBaseUrl: selectedOrigin,
            deviceAuthorization: `Device um_device_${device.deviceId}.${secret.toString("base64url")}`,
            consent: selectedConsent, days: preparation.days, fetchImpl: fetch, signal, clock: now,
            sourcePublication: preparation.sourcePublication,
            progressStore: progress,
            revalidateProgress: preparation.revalidateProgress,
            maxChunks: maximumChunks, maxDurationMs: maximumDurationMilliseconds,
            requestTimeoutMs: requestTimeoutMilliseconds,
            readDay: async (day, { binding }) => {
              onAttributionBinding?.(binding);
              try { return await preparation.readDay(day, { binding }); }
              catch (error) { if (error?.code === "local_index_changed") localIndexChanged = true; throw error; }
            },
            createEnvelope: async (chunk) => {
              try { preparation.assertCurrent(); }
              catch (error) { localIndexChanged = true; throw error; }
              if (envelopeKey === null) {
                const requestSignal = signal === undefined ? AbortSignal.timeout(requestTimeoutMilliseconds)
                  : AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMilliseconds)]);
                const response = await fetch(new URL("/api/v1/envelope-key", selectedOrigin), {
                  credentials: "omit", redirect: "error", signal: requestSignal,
                  headers: { Accept: "application/json" },
                });
                if (!(response instanceof Response) || !response.body) interrupt("response_invalid");
                const reader = response.body.getReader();
                const parts = [];
                let bytes = 0;
                try {
                  for (;;) {
                    const part = await reader.read();
                    if (part.done) break;
                    bytes += part.value.byteLength;
                    if (bytes > MAX_RESPONSE_BYTES) interrupt("response_invalid");
                    parts.push(part.value);
                  }
                } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
                envelopeKey = await readJson(new Response(Buffer.concat(parts), {
                  status: response.status, headers: response.headers,
                }));
                if (envelopeKey?.algorithm !== "RSA-OAEP-256"
                    || typeof envelopeKey.keyId !== "string" || !envelopeKey.keyId || envelopeKey.keyId.length > 200
                    || !envelopeKey.publicJwk || typeof envelopeKey.publicJwk !== "object") interrupt("response_invalid");
              }
              return createV11Envelope({ chunk, ...envelopeKey, cryptoImpl });
            },
          });
          if (localIndexChanged) return v11Failure({ code: "local_index_changed" }, {
            daysTotal: result.daysTotal, networkActivity,
          });
          return Object.freeze({ ...result, networkActivity: result.networkActivity || networkActivity });
        } catch (error) {
          // The device-secret lease intentionally collapses thrown callback
          // errors. Preserve only the bounded scheduling failure inside it.
          return v11Failure(error, { daysTotal: preparation.days.length, networkActivity });
        }
      },
    });
  } catch (error) {
    return v11Failure(error, { daysTotal: preparation?.days.length ?? 0, networkActivity });
  } finally { preparation?.close(); database?.close(); }
}

/** Read-only review material; its account binding stays inside the local service. */
export async function readIncrementalContributionV11Review({
  indexFile, origin, backend, stateFile, fetchImpl = globalThis.fetch,
  withDeviceSecret = withContributionDeviceSecret, openIndex = openLocalUnifiedIndex,
  readAccountMarkers = async () => [], loadExistingAccountObservationSecret = async () => null,
  signal, now = Date.now,
} = {}) {
  const selectedOrigin = canonicalOrigin(origin);
  return withDeviceSecret({ backend, ...(stateFile === undefined ? {} : { stateFile }),
    expectedOrigin: selectedOrigin,
    operation: async (secret, device) => {
      let database = null;
      let preparation = null;
      try {
        const capabilities = await readTelemetryV11Capabilities({
          serverBaseUrl: selectedOrigin,
          deviceAuthorization: `Device um_device_${device.deviceId}.${secret.toString("base64url")}`,
          fetchImpl, signal, clock: now,
        });
        if (!capabilities.formats.some((format) => format.schemaVersion === TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION
            && format.lifecycle === "accepted")) return Object.freeze({ status: "unavailable" });
        database = openIndex(indexFile, { readOnly: true });
        preparation = await createV11Preparation(database, { readAccountMarkers, loadExistingAccountObservationSecret });
        const binding = Object.freeze({ destinationOrigin: capabilities.destinationOrigin,
          enrollmentNamespace: capabilities.enrollmentNamespace });
        const day = preparation.days.at(-1) ?? null;
        if (day === null) return Object.freeze({ status: "index_unavailable" });
        const prepared = await preparation.readDay(day, { binding });
        const recordCounts = Object.fromEntries(["usage", "quota", "session"].map((stream) => [stream,
          prepared.chunks.filter((chunk) => chunk.chunkId.startsWith(`${stream}:${day}:`))
            .reduce((sum, chunk) => sum + chunk.records.length, 0)]));
        return Object.freeze({ status: "ready", capabilities, binding, grantDeviceId: device.deviceId,
          inventory: telemetryV11FieldInventory(),
          publicationFingerprint: preparation.publication.fingerprint,
          sample: Object.freeze({ day, manifestDigest: prepared.manifest.manifestDigest,
            recordCounts: Object.freeze(recordCounts) }),
        });
      } catch (error) {
        return Object.freeze({ status: "unavailable", code: v11Failure(error).failure.code });
      } finally { preparation?.close(); database?.close(); }
    },
  });
}

/** Capability discovery is a GET only; it cannot grant or upgrade consent. */
export async function readIncrementalContributionV11Capabilities({
  origin, backend, stateFile, fetchImpl = globalThis.fetch,
  withDeviceSecret = withContributionDeviceSecret, signal, now = Date.now,
} = {}) {
  const selectedOrigin = canonicalOrigin(origin);
  return withDeviceSecret({ backend, ...(stateFile === undefined ? {} : { stateFile }),
    expectedOrigin: selectedOrigin,
    operation: async (secret, device) => {
      try {
        return await readTelemetryV11Capabilities({
          serverBaseUrl: selectedOrigin,
          deviceAuthorization: `Device um_device_${device.deviceId}.${secret.toString("base64url")}`,
          fetchImpl, signal, clock: now,
        });
      } catch { return null; }
    },
  });
}

async function runTelemetryV1SyncOnce({
  indexFile,
  origin,
  backend,
  stateFile = undefined,
  consent = telemetryV1RequiredConsent(),
  signal = undefined,
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  withDeviceSecret = withContributionDeviceSecret,
  createEnvelope = createTelemetryV1Envelope,
  openIndex = openLocalUnifiedIndex,
  maximumChunks = DEFAULT_MAXIMUM_CHUNKS_PER_PASS,
  requestTimeoutMilliseconds = DEFAULT_REQUEST_TIMEOUT_MILLISECONDS,
  now = Date.now,
} = {}) {
  if (typeof indexFile !== "string" || indexFile.length < 1
      || !backend || typeof backend !== "object"
      || typeof fetchImpl !== "function"
      || typeof withDeviceSecret !== "function"
      || typeof createEnvelope !== "function"
      || typeof openIndex !== "function"
      || typeof now !== "function"
      || !Number.isSafeInteger(maximumChunks)
      || maximumChunks < 1
      || maximumChunks > MAXIMUM_CHUNKS_PER_PASS
      || !Number.isSafeInteger(requestTimeoutMilliseconds)
      || requestTimeoutMilliseconds < 1_000
      || requestTimeoutMilliseconds > MAXIMUM_REQUEST_TIMEOUT_MILLISECONDS
      || (signal !== undefined && !(signal instanceof AbortSignal))) {
    fail("invalid_configuration");
  }
  const selectedOrigin = canonicalOrigin(origin);
  const required = telemetryV1RequiredConsent();
  if (!consent || typeof consent !== "object"
      || consent.telemetrySchemaVersion !== required.telemetrySchemaVersion
      || consent.fieldDictionaryVersion !== required.fieldDictionaryVersion
      || consent.privacyContractVersion !== required.privacyContractVersion) {
    fail("consent_invalid");
  }
  const chunkConsent = Object.freeze({
    telemetrySchemaVersion: required.telemetrySchemaVersion,
    fieldDictionaryVersion: required.fieldDictionaryVersion,
    privacyContractVersion: required.privacyContractVersion,
  });

  const counters = {
    chunksUploaded: 0,
    chunksSkipped: 0,
    recordsUploaded: 0,
  };
  let daysTotal = 0;
  let remainingUploads = [];
  let orphanChunkIds = [];
  let acknowledgedThroughDay = null;
  // Both flags exist so a failed pass can never fabricate progress. A pass
  // that died before its first processed server response must not claim
  // network activity (the controller preserves the last honest progress on
  // networkActivity false), and a pass that died before an upload plan
  // exists must not read its empty pending set as "everything synced" —
  // that exact fabrication once overwrote a real 7/86 watermark with a
  // false 87/87 while the server had received nothing.
  let networkContacted = false;
  let uploadPlanEstablished = false;
  // Any resolved fetch — success or server rejection — is real network
  // activity; only a request that never resolved leaves the pass silent.
  const suppliedFetch = fetchImpl;
  fetchImpl = async (url, options = {}) => {
    // Compose the caller's abort (the controller's pass deadline) with a
    // fresh per-request deadline: whichever fires first aborts this fetch and
    // any in-flight body read, and requestJson maps the rejection to a
    // retryable service_unavailable. Without the per-request deadline a
    // stalled read never settles and the entire pass hangs behind it.
    const { signal: callerSignal, ...rest } = options;
    const deadlineSignal = AbortSignal.timeout(requestTimeoutMilliseconds);
    const requestSignal = callerSignal === undefined
      ? deadlineSignal
      : AbortSignal.any([callerSignal, deadlineSignal]);
    const response = await suppliedFetch(url, { ...rest, signal: requestSignal });
    networkContacted = true;
    return response;
  };

  const outcome = (failure) => {
    const pendingDays = new Set(remainingUploads.map((upload) => upload.day));
    const dayCountsKnown = uploadPlanEstablished || failure === null;
    return Object.freeze({
      schemaVersion: RUN_SCHEMA_VERSION,
      status: failure !== null
        ? "failed"
        : remainingUploads.length > 0 ? "partial" : "complete",
      daysTotal,
      daysSynced: dayCountsKnown ? Math.max(0, daysTotal - pendingDays.size) : 0,
      daysPending: dayCountsKnown ? pendingDays.size : daysTotal,
      chunksUploaded: counters.chunksUploaded,
      chunksSkipped: counters.chunksSkipped,
      recordsUploaded: counters.recordsUploaded,
      acknowledgedThroughDay,
      orphanChunkIds: Object.freeze([...orphanChunkIds]),
      failure,
      networkActivity: networkContacted,
    });
  };
  const failureOutcome = (error) => outcome(Object.freeze({
    code: error.failureCode,
    retryable: error.retryable === true,
    deviceUnavailable: error.deviceUnavailable === true,
    retryAfterMilliseconds: error.retryAfterMilliseconds ?? null,
  }));

  let database = null;
  try {
    try {
      database = openIndex(indexFile, { readOnly: true });
    } catch {
      // The unified index may simply not exist yet (first launch, or the
      // first build still running). Retryable: the next scheduled pass looks
      // again; nothing pauses.
      return failureOutcome(new PassFailure("index_unavailable", {
        retryable: true,
      }));
    }
    // The reader's index ports are composed here, at the root that owns the
    // unified index module: the contribution owner receives the row codecs by
    // injection and never imports legacy flat source itself.
    const reader = createTelemetryV1IndexReader(database, {
      outcomeName,
      reasoningEffortName,
      fallbackParserVersion: LOCAL_UNIFIED_INDEX_PARSER_VERSION,
    });
    const localDays = await deriveLocalDays(reader);
    daysTotal = localDays.length;

    const deviceHeaders = (secret, binding) => ({
      Accept: "application/json",
      Authorization:
        `Device um_device_${binding.deviceId}.${secret.toString("base64url")}`,
    });

    // Read phase: one short device-secret lease covers the sync-state read
    // and, only on disagreement, the day-ranged manifest windows.
    const readCursor = async () => {
      const cursorOutcome = await withDeviceSecret({
        backend,
        ...(stateFile === undefined ? {} : { stateFile }),
        expectedOrigin: selectedOrigin,
        operation: async (secret, binding) => {
          try {
            const state = await requestJson(
              fetchImpl,
              new URL("/api/v1/device/sync/state", selectedOrigin),
              {
                headers: deviceHeaders(secret, binding),
                ...(signal === undefined ? {} : { signal }),
              },
              { deviceAuthorized: true },
            );
            if (!validSyncState(state)) interrupt("response_invalid");
            admissionExhausted(state.admission, now());

            const accepted = localDays.filter((localDay) => (
              state.acknowledgedThroughDay !== null
              && localDay.day <= state.acknowledgedThroughDay
            ));
            const localHistoryDigest = telemetryV1HistoryDigest(accepted);
            if (state.historyDigest === localHistoryDigest) {
              return Object.freeze({
                ok: true,
                acknowledgedThroughDay: state.acknowledgedThroughDay,
                plan: tailPlan(localDays, state.acknowledgedThroughDay),
              });
            }

            // Disagreement: diff at day granularity across the whole local
            // span plus the service watermark, in bounded windows.
            const manifestDays = [];
            if (localDays.length > 0 || state.acknowledgedThroughDay !== null) {
              const firstDay = localDays[0]?.day
                ?? state.acknowledgedThroughDay;
              const lastLocal = localDays.at(-1)?.day ?? firstDay;
              const lastDay = state.acknowledgedThroughDay !== null
                && state.acknowledgedThroughDay > lastLocal
                ? state.acknowledgedThroughDay
                : lastLocal;
              let windows = 0;
              for (let fromDay = firstDay; fromDay <= lastDay;
                fromDay = addDays(fromDay, MANIFEST_WINDOW_DAYS)) {
                windows += 1;
                if (windows > MAX_MANIFEST_WINDOWS_PER_PASS) {
                  interrupt("response_invalid");
                }
                const toDayCandidate = addDays(
                  fromDay,
                  MANIFEST_WINDOW_DAYS - 1,
                );
                const toDay = toDayCandidate < lastDay
                  ? toDayCandidate
                  : lastDay;
                const manifest = await requestJson(
                  fetchImpl,
                  new URL(
                    `/api/v1/device/sync/manifest?fromDay=${fromDay}&toDay=${toDay}`,
                    selectedOrigin,
                  ),
                  {
                    headers: deviceHeaders(secret, binding),
                    ...(signal === undefined ? {} : { signal }),
                  },
                  {
                    deviceAuthorized: true,
                    maximumBytes: MAX_MANIFEST_RESPONSE_BYTES,
                  },
                );
                if (manifest?.schemaVersion !== "device-sync-manifest-v1.0"
                    || !Array.isArray(manifest.days)) {
                  interrupt("response_invalid");
                }
                manifestDays.push(...manifest.days);
              }
            }
            return Object.freeze({
              ok: true,
              acknowledgedThroughDay: state.acknowledgedThroughDay,
              manifestDays: Object.freeze(manifestDays),
            });
          } catch (error) {
            if (error instanceof PassFailure) {
              return Object.freeze({
                ok: false,
                code: error.failureCode,
                retryable: error.retryable,
                deviceUnavailable: error.deviceUnavailable,
                retryAfterMilliseconds: error.retryAfterMilliseconds,
              });
            }
            throw error;
          }
        },
      });
      if (cursorOutcome?.ok !== true) {
        if (!FAILURE_CODES.has(cursorOutcome?.code)) {
          interrupt("response_invalid");
        }
        interrupt(cursorOutcome.code, cursorOutcome);
      }
      acknowledgedThroughDay = cursorOutcome.acknowledgedThroughDay;
      if (cursorOutcome.plan !== undefined) return cursorOutcome.plan;
      return planTelemetryV1Upload({
        localDays,
        manifestDays: cursorOutcome.manifestDays,
      });
    };

    let plan;
    try {
      plan = await readCursor();
    } catch (error) {
      if (deviceCapabilityFailure(error)) {
        return failureOutcome(new PassFailure("device_unavailable", {
          deviceUnavailable: true,
        }));
      }
      if (error instanceof PassFailure) return failureOutcome(error);
      throw error;
    }
    counters.chunksSkipped = plan.skippedChunks;
    orphanChunkIds = [...plan.orphanChunkIds];
    remainingUploads = [...plan.uploads];
    uploadPlanEstablished = true;
    if (remainingUploads.length === 0) return outcome(null);

    let envelopeKey = null;
    let derivedDay = null;
    let conflictRefreshed = false;

    try {
      while (remainingUploads.length > 0
        && counters.chunksUploaded < maximumChunks) {
        if (signal?.aborted) interrupt("interrupted", { retryable: true });
        const upload = remainingUploads[0];

        if (envelopeKey === null) {
          const key = await requestJson(
            fetchImpl,
            new URL("/api/v1/envelope-key", selectedOrigin),
            {
              headers: { Accept: "application/json" },
              ...(signal === undefined ? {} : { signal }),
            },
          );
          if (key?.algorithm !== "RSA-OAEP-256"
              || typeof key.keyId !== "string"
              || key.keyId.length < 1
              || key.keyId.length > 200
              || !key.publicJwk || typeof key.publicJwk !== "object") {
            interrupt("response_invalid");
          }
          envelopeKey = key;
        }
        if (derivedDay?.day !== upload.day) {
          derivedDay = reader.deriveDay(upload.day);
        }
        const chunk = derivedDay.chunks.find(
          (candidate) => candidate.chunkId === upload.chunkId,
        );
        // A digest that moved since planning means the index advanced under
        // this pass. Stop; the next pass re-plans against the new truth.
        if (chunk === undefined || chunk.chunkDigest !== upload.chunkDigest) {
          interrupt("local_index_changed", { retryable: true });
        }
        const plaintext = buildTelemetryV1ChunkPlaintext({
          chunk,
          revision: upload.revision,
          consent: chunkConsent,
        });
        const envelope = await createEnvelope({
          chunk: plaintext,
          publicJwk: envelopeKey.publicJwk,
          keyId: envelopeKey.keyId,
          cryptoImpl,
        });
        const serializedEnvelope = JSON.stringify(envelope);
        const envelopeDigest = createHash("sha256")
          .update(serializedEnvelope, "utf8")
          .digest("hex");

        const registration = await withDeviceSecret({
          backend,
          ...(stateFile === undefined ? {} : { stateFile }),
          expectedOrigin: selectedOrigin,
          operation: async (secret, binding) => {
            try {
              const authorization = await requestJson(
                fetchImpl,
                new URL(
                  "/api/v1/device/upload-authorizations",
                  selectedOrigin,
                ),
                {
                  method: "POST",
                  headers: {
                    ...deviceHeaders(secret, binding),
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    envelopeDigest,
                    contentLengthBytes: Buffer.byteLength(
                      serializedEnvelope,
                      "utf8",
                    ),
                    contentType: "application/json",
                  }),
                  ...(signal === undefined ? {} : { signal }),
                },
                { deviceAuthorized: true },
              );
              if (typeof authorization?.uploadAuthorization !== "string"
                  || !DEVICE_UPLOAD.test(authorization.uploadAuthorization)
                  || !Number.isFinite(Date.parse(authorization.expiresAt))) {
                interrupt("response_invalid");
              }
              return Object.freeze({
                ok: true,
                uploadAuthorization: authorization.uploadAuthorization,
              });
            } catch (error) {
              if (error instanceof PassFailure) {
                return Object.freeze({
                  ok: false,
                  code: error.failureCode,
                  retryable: error.retryable,
                  deviceUnavailable: error.deviceUnavailable,
                  retryAfterMilliseconds: error.retryAfterMilliseconds,
                });
              }
              throw error;
            }
          },
        });
        if (registration?.ok !== true) {
          if (!FAILURE_CODES.has(registration?.code)) {
            interrupt("response_invalid");
          }
          interrupt(registration.code, registration);
        }

        let receipt;
        try {
          receipt = await requestJson(
            fetchImpl,
            new URL("/api/v1/contributions", selectedOrigin),
            {
              method: "POST",
              headers: {
                Accept: "application/json",
                Authorization: `Upload ${registration.uploadAuthorization}`,
                "Content-Type": "application/json",
              },
              body: serializedEnvelope,
              ...(signal === undefined ? {} : { signal }),
            },
          );
        } catch (error) {
          // A revision conflict means the journal and this plan disagree.
          // Re-read the cursor once per pass; a second conflict ends it.
          if (error instanceof PassFailure
              && error.failureCode === "revision_conflict"
              && !conflictRefreshed) {
            conflictRefreshed = true;
            const refreshed = await readCursor();
            counters.chunksSkipped += refreshed.skippedChunks;
            orphanChunkIds = [...refreshed.orphanChunkIds];
            remainingUploads = [...refreshed.uploads];
            derivedDay = null;
            continue;
          }
          throw error;
        }
        if (receipt?.schemaVersion !== "telemetry-chunk-receipt-v1.0"
            || receipt.chunkId !== upload.chunkId
            || !["accepted", "superseded"].includes(receipt.status)
            || !CHUNK_CONTRIBUTION_ID.test(receipt.contributionId ?? "")
            || (receipt.acknowledgedThroughDay !== null
              && !isUtcDay(receipt.acknowledgedThroughDay))) {
          interrupt("response_invalid");
        }
        remainingUploads.shift();
        counters.chunksUploaded += 1;
        counters.recordsUploaded += chunk.recordCount;
        acknowledgedThroughDay = receipt.acknowledgedThroughDay
          ?? acknowledgedThroughDay;
        if (receipt.admission?.state === "exhausted"
            && remainingUploads.length > 0) {
          admissionExhausted(receipt.admission, now());
        }
      }
    } catch (error) {
      if (deviceCapabilityFailure(error)) {
        return failureOutcome(new PassFailure("device_unavailable", {
          deviceUnavailable: true,
        }));
      }
      if (error instanceof PassFailure) return failureOutcome(error);
      throw error;
    }
    return outcome(null);
  } finally {
    database?.close();
  }
}
