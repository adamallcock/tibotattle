import { createHash } from "node:crypto";
import {
  canonicalTelemetryV11Json,
  isTelemetryV11ConsentCurrent,
  parseTelemetryV11Chunk,
  parseTelemetryV11ChunkId,
  parseTelemetryV11DayManifest,
  parseTelemetryV11DomainManifest,
  telemetryV11DayManifestDigestInput,
  telemetryV11DomainManifestDigestInput,
  telemetryV11RecordAnchor,
  validateTelemetryV11Envelope,
  MAX_TELEMETRY_V11_DAY_CHUNKS,
  MAX_TELEMETRY_V11_DOMAIN_DAYS,
  TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V11_DOMAIN_MANIFEST_SCHEMA_VERSION,
} from "@app-usagemonitor/telemetry-contract";
import { sanitizeTelemetryAttributionBinding } from "./account-track.js";

// One foreground pass, one immutable day and one envelope in flight. The
// application injects an already-reviewed reader and a leased secret adapter;
// this module never opens the index, auth profile or platform secret store.
const RUN_VERSION = "incremental-contribution-sync-run-v1.0";
const PROGRESS_VERSION = "telemetry-v11-sync-progress-v1";
const DAY_MS = 86_400_000;
const MAX_RESPONSE_BYTES = 32_768;
const MAX_VECTOR_RESPONSE_BYTES = 1_250_000;
const MAX_DAY_BYTES = 64_000_000;
const MAX_RETRY_MS = 7 * DAY_MS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const DEVICE_AUTH = /^Device um_device_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/u;
const UPLOAD_AUTH = /^um_device_upload_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/u;
const FORMATS = Object.freeze({
  "telemetry-contribution-v0.1": 1, "telemetry-contribution-v0.2": 2,
  "telemetry-contribution-v1.0": 10, "telemetry-contribution-v1.1": 11,
});
const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const integer = (value, maximum = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const freeze = (value) => {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
const instant = (value) => typeof value === "string" && value.length === 24
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const dayValid = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)
  && instant(value + "T00:00:00.000Z");

class SyncFailure extends Error {
  constructor(code, { retryable = false, deviceUnavailable = false, retryAfterMilliseconds = null } = {}) {
    super("Attribution contribution sync stopped");
    this.name = "TelemetryV11SyncFailure";
    this.failureCode = code;
    this.retryable = retryable;
    this.deviceUnavailable = deviceUnavailable;
    this.retryAfterMilliseconds = retryAfterMilliseconds;
  }
}
class PassBudgetReached extends Error {}
const stop = (code, options) => { throw new SyncFailure(code, options); };
function invalidConfiguration() {
  const error = new TypeError("Attribution contribution configuration is invalid");
  error.code = "contribution_incremental_sync_invalid_configuration";
  throw error;
}

function configuration({ serverBaseUrl, deviceAuthorization, fetchImpl, signal, clock, requestTimeoutMs }) {
  let url;
  try { url = new URL(serverBaseUrl); } catch { invalidConfiguration(); }
  if (typeof serverBaseUrl !== "string" || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash
      || (url.protocol !== "https:" && !(url.protocol === "http:"
        && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      || typeof deviceAuthorization !== "string" || !DEVICE_AUTH.test(deviceAuthorization)
      || typeof fetchImpl !== "function" || typeof clock !== "function"
      || !integer(requestTimeoutMs, 300_000) || requestTimeoutMs < 1
      || (signal !== undefined && !(signal instanceof AbortSignal))) invalidConfiguration();
  return url.origin;
}

function retryAfter(response, now) {
  const value = response.headers.get("retry-after")?.trim() ?? "";
  if (value.length === 0 || value.length > 128) return null;
  let delay;
  if (/^\d+$/u.test(value)) delay = Number(value) * 1_000;
  else if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(value)) {
    delay = Math.max(0, Date.parse(value) - now);
  } else return null;
  return Number.isSafeInteger(delay) && delay >= 0 ? Math.min(MAX_RETRY_MS, delay) : null;
}

// Stream with a byte cap. Reading response.text() and measuring afterward
// would leave an unbounded network allocation before the check.
async function boundedBody(response, maximumBytes, signal) {
  if (!(response instanceof Response) || response.redirected
      || response.headers.get("cache-control") !== "no-store"
      || !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    stop("response_invalid");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) stop("response_invalid");
  if (!response.body) stop("response_invalid");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  let complete = false;
  const aborted = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", aborted, { once: true });
  try {
    while (true) {
      if (signal.aborted) stop("interrupted", { retryable: true });
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) stop("response_invalid");
      body += decoder.decode(next.value, { stream: true });
    }
    body += decoder.decode();
    complete = true;
    try { return JSON.parse(body); } catch { stop("response_invalid"); }
  } catch (error) {
    if (error instanceof SyncFailure) throw error;
    stop("response_invalid");
  } finally {
    signal.removeEventListener("abort", aborted);
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function classifyResponse(response, body, clock, deviceAuthorized) {
  const backend = body?.error?.code;
  if (["DEVICE_AUTH_INVALID", "PARTICIPANT_DELETING"].includes(backend)) {
    stop("device_unavailable", { deviceUnavailable: true });
  }
  if (backend === "TELEMETRY_CONSENT_INVALID" || backend === "TELEMETRY_TRANSPORT_BLOCKED") stop("consent_rejected");
  if (response.status === 429
      && ["CHUNK_ADMISSION_LIMIT_REACHED", "UPLOAD_ADMISSION_LIMIT_REACHED"].includes(backend)) {
    stop("admission_exhausted", { retryable: true, retryAfterMilliseconds: retryAfter(response, clock()) });
  }
  if (response.status === 409 && [
    "CHUNK_REVISION_CONFLICT", "TELEMETRY_MANIFEST_CONFLICT", "TELEMETRY_MANIFEST_INCOMPLETE",
    "TELEMETRY_COMPATIBILITY_PROOF_UNAVAILABLE",
  ].includes(backend)) stop("revision_conflict", { retryable: true });
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    stop("service_unavailable", { retryable: true, retryAfterMilliseconds: retryAfter(response, clock()) });
  }
  stop(deviceAuthorized ? "authorization_rejected" : "upload_rejected");
}

function transport(options, maxDurationMs) {
  const { fetchImpl, signal, clock, requestTimeoutMs, deviceAuthorization } = options;
  const origin = configuration(options);
  const start = clock();
  const wallStart = performance.now();
  if (!Number.isFinite(start)) invalidConfiguration();
  let last = start;
  let networkActivity = false;
  function remaining() {
    if (signal?.aborted) stop("interrupted", { retryable: true });
    const current = clock();
    if (!Number.isFinite(current) || current < last) stop("interrupted", { retryable: true });
    last = current;
    const left = Math.min(maxDurationMs - (current - start), maxDurationMs - (performance.now() - wallStart));
    if (left <= 0) throw new PassBudgetReached();
    return left;
  }
  async function bounded(operation, request = false) {
    const left = remaining();
    const limit = Math.max(1, Math.ceil(Math.min(left, request ? requestTimeoutMs : left)));
    const passDeadline = !request || left <= requestTimeoutMs;
    const controller = new AbortController();
    let timer;
    let abort;
    const interruption = new Promise((_, reject) => {
      abort = () => {
        reject(new SyncFailure("interrupted", { retryable: true }));
        controller.abort();
      };
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        reject(passDeadline ? new PassBudgetReached() : new SyncFailure("service_unavailable", { retryable: true }));
        controller.abort();
      }, limit);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), interruption]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controller.abort();
    }
  }
  async function request(path, { body, authorization = deviceAuthorization, maximumBytes = MAX_RESPONSE_BYTES } = {}) {
    return bounded(async (requestSignal) => {
      let response;
      try {
        response = await fetchImpl(new URL(path, origin), {
          method: body === undefined ? "GET" : "POST",
          headers: { accept: "application/json", authorization,
            ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
          credentials: "omit", redirect: "error", cache: "no-store", signal: requestSignal,
        });
        networkActivity = true;
      } catch {
        if (signal?.aborted) stop("interrupted", { retryable: true });
        stop("service_unavailable", { retryable: true });
      }
      const value = await boundedBody(response, maximumBytes, requestSignal);
      if (!response.ok) classifyResponse(response, value, clock, authorization === deviceAuthorization);
      return value;
    }, true);
  }
  return { origin, request, bounded, remaining, clock, networkActivity: () => networkActivity };
}

function capabilities(value, origin) {
  if (!exact(value, ["schemaVersion", "destinationOrigin", "enrollmentNamespace", "identityVersion",
    "minimumWriteRank", "policyRevision", "requiredConsent", "consentCurrent", "formats"])
      || value.schemaVersion !== "device-sync-capabilities-v1.1" || value.destinationOrigin !== origin
      || value.identityVersion !== "account-track-v2" || !Object.values(FORMATS).includes(value.minimumWriteRank)
      || !integer(value.policyRevision) || typeof value.consentCurrent !== "boolean"
      || !isTelemetryV11ConsentCurrent(value.requiredConsent)
      || !Array.isArray(value.formats) || value.formats.length !== 4
      || !sanitizeTelemetryAttributionBinding({ destinationOrigin: value.destinationOrigin,
        enrollmentNamespace: value.enrollmentNamespace })) stop("response_invalid");
  const seen = new Set();
  for (const format of value.formats) {
    if (!exact(format, ["schemaVersion", "rank", "lifecycle"])
        || !Object.hasOwn(FORMATS, format.schemaVersion) || FORMATS[format.schemaVersion] !== format.rank
        || !["accepted", "staged", "blocked"].includes(format.lifecycle)
        || seen.has(format.schemaVersion)) stop("response_invalid");
    seen.add(format.schemaVersion);
  }
  return freeze(JSON.parse(JSON.stringify(value)));
}
function requireConsent(capability) {
  const format = capability.formats.find((item) => item.schemaVersion === TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION);
  if (!capability.consentCurrent || format.lifecycle !== "accepted"
      || format.rank < capability.minimumWriteRank) stop("consent_rejected");
}

/** Read-only, authenticated review preflight; it never grants consent. */
export async function readTelemetryV11Capabilities({
  serverBaseUrl, deviceAuthorization, fetchImpl = globalThis.fetch, signal,
  clock = Date.now, requestTimeoutMs = 30_000,
} = {}) {
  const client = transport({ serverBaseUrl, deviceAuthorization, fetchImpl, signal, clock, requestTimeoutMs }, requestTimeoutMs + 1);
  try { return capabilities(await client.request("/api/v1/device/sync-capabilities"), client.origin); }
  catch (error) {
    if (error instanceof SyncFailure) throw error;
    stop("service_unavailable", { retryable: true });
  }
}

function predecessor(value, clock) {
  if (!exact(value, ["schemaVersion", "token", "previousGenerationId", "legacyFingerprint", "fromDay", "throughDay", "expiresAt"])
      || value.schemaVersion !== "telemetry-domain-predecessor-v1.1"
      || !UUID.test(value.token ?? "") || !(value.previousGenerationId === null || UUID.test(value.previousGenerationId ?? ""))
      || !DIGEST.test(value.legacyFingerprint ?? "") || !dayValid(value.fromDay) || !dayValid(value.throughDay)
      || value.fromDay > value.throughDay || !instant(value.expiresAt)
      || Date.parse(value.expiresAt) <= clock()) stop("response_invalid");
  return freeze(value);
}

function snapshotDay(value, day) {
  try {
    if (!exact(value, ["manifest", "chunks"]) || !Array.isArray(value.chunks)
        || value.chunks.length > MAX_TELEMETRY_V11_DAY_CHUNKS) stop("index_unavailable", { retryable: true });
    const manifest = JSON.parse(canonicalTelemetryV11Json(parseTelemetryV11DayManifest(value.manifest)));
    if (manifest.day !== day || manifest.chunks.length !== value.chunks.length
        || hash(telemetryV11DayManifestDigestInput(manifest)) !== manifest.manifestDigest) stop("local_index_changed", { retryable: true });
    let byteCount = 0;
    const seen = { quota: new Set(), session: new Set(), usage: new Set() };
    const chunks = [];
    for (let i = 0; i < value.chunks.length; i += 1) {
      const serialized = canonicalTelemetryV11Json(parseTelemetryV11Chunk(value.chunks[i]));
      byteCount += Buffer.byteLength(serialized, "utf8");
      if (byteCount > MAX_DAY_BYTES) stop("index_unavailable");
      const chunk = JSON.parse(serialized);
      const expected = manifest.chunks[i];
      if (chunk.manifestDigest !== manifest.manifestDigest || chunk.parserVersion !== manifest.parserVersion
          || chunk.chunkId !== expected.chunkId || chunk.chunkDigest !== expected.chunkDigest
          || chunk.records.length !== expected.recordCount
          || hash(canonicalTelemetryV11Json(chunk.records)) !== chunk.chunkDigest) stop("local_index_changed", { retryable: true });
      const { stream } = parseTelemetryV11ChunkId(chunk.chunkId);
      for (const record of chunk.records) {
        const id = telemetryV11RecordAnchor(stream, record).occurrenceId;
        if (seen[stream].has(id)) stop("index_unavailable");
        seen[stream].add(id);
      }
      chunks.push(chunk);
    }
    return freeze({ manifest, chunks });
  } catch (error) {
    if (error instanceof SyncFailure) throw error;
    stop("index_unavailable", { retryable: true });
  }
}

function dayCandidate(value, manifest) {
  if (!exact(value, ["manifestId", "day", "manifestDigest", "state", "expectedChunks", "stagedChunks"])
      || !UUID.test(value.manifestId ?? "") || value.day !== manifest.day || value.manifestDigest !== manifest.manifestDigest
      || !["staged", "ready"].includes(value.state) || value.expectedChunks !== manifest.chunks.length
      || !Array.isArray(value.stagedChunks) || value.stagedChunks.length > manifest.chunks.length) stop("response_invalid");
  const expected = new Map(manifest.chunks.map((chunk) => [chunk.chunkId, chunk]));
  const staged = new Set();
  for (const chunk of value.stagedChunks) {
    if (!exact(chunk, ["chunkId", "chunkDigest", "recordCount"]) || staged.has(chunk.chunkId)
        || chunk.chunkDigest !== expected.get(chunk.chunkId)?.chunkDigest
        || chunk.recordCount !== expected.get(chunk.chunkId)?.recordCount) stop("response_invalid");
    staged.add(chunk.chunkId);
  }
  if ((value.state === "ready") !== (staged.size === manifest.chunks.length)) stop("response_invalid");
  return { ...value, staged };
}

function chunkReceipt(value, chunk, candidate) {
  if (!exact(value, ["schemaVersion", "contributionId", "manifestId", "chunkId", "chunkRevision", "status", "replayed", "recordCounts"])
      || value.schemaVersion !== "telemetry-chunk-receipt-v1.1"
      || typeof value.contributionId !== "string" || !value.contributionId.startsWith("chunk:")
      || !UUID.test(value.contributionId.slice(6)) || value.manifestId !== candidate.manifestId
      || value.chunkId !== chunk.chunkId || value.chunkRevision !== 1 || value.status !== "staged"
      || typeof value.replayed !== "boolean" || !exact(value.recordCounts, ["declared", "accepted"])
      || value.recordCounts.declared !== chunk.records.length || value.recordCounts.accepted !== chunk.records.length) stop("response_invalid");
  return value;
}

function activation(value, manifest) {
  const commonKeys = ["schemaVersion", "generationId", "manifestDigest", "fromDay", "throughDay", "replay"];
  const unchanged = exact(value, [...commonKeys, "unchanged", "requestedManifestDigest"])
    && value.unchanged === true && value.replay === true && value.requestedManifestDigest === manifest.manifestDigest;
  if ((!exact(value, commonKeys) && !unchanged) || value.schemaVersion !== "telemetry-domain-activation-v1.1"
      || !UUID.test(value.generationId ?? "") || !DIGEST.test(value.manifestDigest ?? "")
      || (!unchanged && value.manifestDigest !== manifest.manifestDigest)
      || value.fromDay !== manifest.fromDay || value.throughDay !== manifest.throughDay
      || typeof value.replay !== "boolean") stop("response_invalid");
  return value;
}

function publicationSnapshot(value) {
  if (!exact(value, ["fingerprint", "parserVersion"])
      || typeof value.fingerprint !== "string" || !/^[A-Za-z0-9:_-]{1,256}$/u.test(value.fingerprint)
      || typeof value.parserVersion !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.parserVersion)) {
    invalidConfiguration();
  }
  return Object.freeze({ ...value });
}

// A journal is a retry cursor, not an acknowledgement. It holds only the
// immutable manifest identities already staged for an exact local publication.
// The root secret, upload authority and short-lived predecessor token never
// enter it. Every resumed vector still needs the server's full activation proof.
function progressContext(publication, capability, deviceAuthorization, consent) {
  const deviceId = deviceAuthorization.slice("Device um_device_".length,
    "Device um_device_".length + 36);
  return hash(canonicalTelemetryV11Json({
    schemaVersion: PROGRESS_VERSION,
    parserVersion: publication.parserVersion,
    destinationOrigin: capability.destinationOrigin,
    deviceId,
    enrollmentNamespace: capability.enrollmentNamespace,
    identityVersion: capability.identityVersion,
    policyRevision: capability.policyRevision,
    consent,
  }));
}

function progressSnapshot(value, expected, revalidateProgress) {
  if (!exact(value, ["schemaVersion", "contextDigest", "sourceFingerprint", "validatedDays",
    "previousGenerationId", "legacyFingerprint", "fromDay", "throughDay", "days"])
      || value.schemaVersion !== PROGRESS_VERSION || value.contextDigest !== expected.contextDigest
      || !DIGEST.test(value.sourceFingerprint ?? "")
      || value.previousGenerationId !== expected.previousGenerationId
      || value.legacyFingerprint !== expected.legacyFingerprint
      || value.fromDay !== expected.fromDay || !dayValid(value.throughDay)
      || value.throughDay < value.fromDay || value.throughDay > expected.throughDay
      || !Array.isArray(value.days) || value.days.length > expected.count
      || value.days.length > (Date.parse(value.throughDay + "T00:00:00.000Z") - expected.first) / DAY_MS + 1
      || !integer(value.validatedDays, value.days.length)) return null;
  const days = [];
  for (let index = 0; index < value.days.length; index += 1) {
    const entry = value.days[index];
    if (!exact(entry, ["day", "manifestId", "manifestDigest"])
        || entry.day !== new Date(expected.first + index * DAY_MS).toISOString().slice(0, 10)
        || !UUID.test(entry.manifestId ?? "") || !DIGEST.test(entry.manifestDigest ?? "")) return null;
    days.push(Object.freeze({ ...entry }));
  }
  const reset = revalidateProgress || value.sourceFingerprint !== expected.sourceFingerprint
    || value.throughDay !== expected.throughDay;
  return { days, validatedDays: reset ? 0 : value.validatedDays, reset };
}

/** Explicit v1.1 consent is required before even the first authenticated read. */
export async function runTelemetryV11Sync({
  serverBaseUrl, deviceAuthorization, consent, days, readDay, createEnvelope,
  fetchImpl = globalThis.fetch, signal, clock = Date.now,
  maxChunks = 500, maxDurationMs = 60_000, requestTimeoutMs = 30_000,
  maxDays = MAX_TELEMETRY_V11_DOMAIN_DAYS,
  progressStore = null, sourcePublication = null, revalidateProgress = false,
} = {}) {
  if (!isTelemetryV11ConsentCurrent(consent)) {
    const error = new TypeError("Explicit attribution contribution consent is required");
    error.code = "contribution_incremental_sync_consent_invalid";
    throw error;
  }
  if (!integer(maxChunks, 2_000) || maxChunks < 1 || !integer(maxDurationMs, 300_000) || maxDurationMs < 1
      || !integer(maxDays, MAX_TELEMETRY_V11_DOMAIN_DAYS) || maxDays < 1
      || !Array.isArray(days) || days.length > maxDays || typeof readDay !== "function" || typeof createEnvelope !== "function"
      || days.some((day, index) => !dayValid(day) || (index > 0 && day <= days[index - 1]))) invalidConfiguration();
  if (typeof revalidateProgress !== "boolean" || (progressStore !== null && (!plain(progressStore)
      || typeof progressStore.read !== "function" || typeof progressStore.write !== "function"))) invalidConfiguration();
  const publication = progressStore === null ? null : publicationSnapshot(sourcePublication);
  const localDays = [...days];
  const client = transport({ serverBaseUrl, deviceAuthorization, fetchImpl, signal, clock, requestTimeoutMs }, maxDurationMs);
  let daysTotal = localDays.length;
  let stagedDays = 0;
  let chunksUploaded = 0;
  let chunksSkipped = 0;
  let recordsUploaded = 0;
  let active = null;
  async function progressOperation(operation) {
    try { return await client.bounded(operation); }
    catch (error) {
      if (error instanceof SyncFailure || error instanceof PassBudgetReached) throw error;
      stop("index_unavailable", { retryable: true });
    }
  }
  function outcome(error = null) {
    const failure = error instanceof SyncFailure ? Object.freeze({
      code: error.failureCode, retryable: error.retryable, deviceUnavailable: error.deviceUnavailable,
      retryAfterMilliseconds: error.retryAfterMilliseconds,
    }) : null;
    return Object.freeze({
      schemaVersion: RUN_VERSION,
      status: active ? "complete" : failure && failure.code !== "admission_exhausted" && failure.code !== "interrupted" ? "failed" : "partial",
      daysTotal, daysSynced: active ? daysTotal : 0, daysPending: active ? 0 : daysTotal,
      chunksUploaded, chunksSkipped, recordsUploaded, stagedDays,
      acknowledgedThroughDay: active?.throughDay ?? null, domainGenerationId: active?.generationId ?? null,
      orphanChunkIds: Object.freeze([]), failure, networkActivity: client.networkActivity(),
    });
  }
  try {
    const capability = capabilities(await client.request("/api/v1/device/sync-capabilities"), client.origin);
    requireConsent(capability);
    const binding = Object.freeze({ destinationOrigin: capability.destinationOrigin, enrollmentNamespace: capability.enrollmentNamespace });
    let before = predecessor(await client.request("/api/v1/me/telemetry-v11/domain-predecessor", { body: {} }), clock);
    const fromDay = localDays.length ? [before.fromDay, localDays[0]].sort()[0] : before.fromDay;
    const throughDay = localDays.length ? [before.throughDay, localDays.at(-1)].sort().at(-1) : before.throughDay;
    const first = Date.parse(fromDay + "T00:00:00.000Z");
    const count = (Date.parse(throughDay + "T00:00:00.000Z") - first) / DAY_MS + 1;
    if (!integer(count, maxDays) || count < 1) stop("index_unavailable");
    daysTotal = count;
    const scope = progressStore === null ? null : {
      contextDigest: progressContext(publication, capability, deviceAuthorization, consent),
      sourceFingerprint: hash(publication.fingerprint),
      previousGenerationId: before.previousGenerationId, legacyFingerprint: before.legacyFingerprint,
      fromDay, throughDay, count, first,
    };
    let vector = [];
    let validatedDays = 0;
    async function saveProgress() {
      if (progressStore === null) return;
      const saved = freeze({ schemaVersion: PROGRESS_VERSION,
        contextDigest: scope.contextDigest, sourceFingerprint: scope.sourceFingerprint, validatedDays,
        previousGenerationId: scope.previousGenerationId, legacyFingerprint: scope.legacyFingerprint,
        fromDay, throughDay, days: vector.map((entry) => ({ ...entry })),
      });
      await progressOperation(() => progressStore.write(saved));
    }
    if (progressStore !== null) {
      const saved = await progressOperation(() => progressStore.read());
      const resumed = progressSnapshot(saved, scope, revalidateProgress);
      if (resumed !== null) {
        vector = resumed.days;
        validatedDays = resumed.validatedDays;
        if (resumed.reset) await saveProgress();
      } else if (saved !== null) await progressOperation(() => progressStore.write(null));
    }
    async function prepareDay(day) {
      let prepared;
      try { prepared = snapshotDay(await client.bounded(() => readDay(day, { binding })), day); }
      catch (error) {
        if (error instanceof SyncFailure || error instanceof PassBudgetReached) throw error;
        stop(error?.code === "local_index_changed" ? "local_index_changed" : "index_unavailable", { retryable: true });
      }
      if (publication !== null && prepared.manifest.parserVersion !== publication.parserVersion) {
        stop("local_index_changed", { retryable: true });
      }
      return prepared;
    }
    stagedDays = validatedDays;
    let changedDay = null;
    // An ordinary append may publish a new generation between passes while
    // leaving years of earlier days identical. Verify those manifests locally
    // under the NEW pinned reader; do not repeat their network round trips.
    // Revalidation itself checkpoints, so a stable generation can span passes.
    for (let i = validatedDays; i < vector.length; i += 1) {
      const prepared = await prepareDay(vector[i].day);
      if (prepared.manifest.manifestDigest !== vector[i].manifestDigest) {
        vector = vector.slice(0, i);
        validatedDays = i;
        stagedDays = i;
        changedDay = prepared;
        await saveProgress();
        break;
      }
      validatedDays += 1;
      stagedDays = validatedDays;
      await saveProgress();
      await client.bounded(() => new Promise((resolve) => setImmediate(resolve)));
    }
    for (let i = vector.length; i < count; i += 1) {
      client.remaining();
      const day = new Date(first + i * DAY_MS).toISOString().slice(0, 10);
      const prepared = changedDay ?? await prepareDay(day);
      changedDay = null;
      const candidate = dayCandidate(await client.request("/api/v1/device/telemetry/v1.1/day-manifests",
        { body: prepared.manifest, maximumBytes: MAX_VECTOR_RESPONSE_BYTES }), prepared.manifest);
      for (const chunk of prepared.chunks) {
        if (candidate.staged.has(chunk.chunkId)) { chunksSkipped += 1; continue; }
        if (chunksUploaded >= maxChunks) return outcome();
        client.remaining();
        let body;
        try {
          const envelope = await client.bounded(() => createEnvelope(chunk));
          body = JSON.stringify(validateTelemetryV11Envelope(envelope));
        } catch (error) {
          if (error instanceof SyncFailure || error instanceof PassBudgetReached) throw error;
          stop("index_unavailable", { retryable: true });
        }
        const authorization = await client.request("/api/v1/device/upload-authorizations", { body: {
          envelopeDigest: hash(body), contentLengthBytes: Buffer.byteLength(body, "utf8"),
          contentType: "application/json", telemetrySchemaVersion: TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
        } });
        if (!exact(authorization, ["uploadAuthorization", "expiresAt"])
            || !UPLOAD_AUTH.test(authorization.uploadAuthorization ?? "")
            || !instant(authorization.expiresAt) || Date.parse(authorization.expiresAt) <= clock()) stop("response_invalid");
        chunkReceipt(await client.request("/api/v1/contributions", {
          body, authorization: "Upload " + authorization.uploadAuthorization,
        }), chunk, candidate);
        chunksUploaded += 1;
        recordsUploaded += chunk.records.length;
      }
      stagedDays += 1;
      vector.push({ day, manifestId: candidate.manifestId, manifestDigest: prepared.manifest.manifestDigest });
      validatedDays = vector.length;
      await saveProgress();
      // Yield between days without retaining their records; the local
      // companion must remain responsive while historical projection runs.
      await client.bounded(() => new Promise((resolve) => setImmediate(resolve)));
    }
    const after = capabilities(await client.request("/api/v1/device/sync-capabilities"), client.origin);
    requireConsent(after);
    if (after.enrollmentNamespace !== capability.enrollmentNamespace
        || after.policyRevision !== capability.policyRevision) stop("revision_conflict", { retryable: true });
    // A resumed prefix is trusted only for the pinned predecessor, not merely
    // for its date range. Re-read that state before the atomic server proof;
    // this also renews the short-lived token without persisting a capability.
    if (progressStore !== null || Date.parse(before.expiresAt) <= clock() + requestTimeoutMs) {
      const renewed = predecessor(await client.request("/api/v1/me/telemetry-v11/domain-predecessor", { body: {} }), clock);
      if (renewed.previousGenerationId !== before.previousGenerationId || renewed.legacyFingerprint !== before.legacyFingerprint
          || renewed.fromDay < fromDay || renewed.throughDay > throughDay) stop("revision_conflict", { retryable: true });
      before = renewed;
    }
    const manifest = {
      schemaVersion: TELEMETRY_V11_DOMAIN_MANIFEST_SCHEMA_VERSION, fromDay, throughDay,
      predecessor: { token: before.token, previousGenerationId: before.previousGenerationId, legacyFingerprint: before.legacyFingerprint },
      days: vector, manifestDigest: "0".repeat(64),
    };
    manifest.manifestDigest = hash(telemetryV11DomainManifestDigestInput(manifest));
    parseTelemetryV11DomainManifest(manifest);
    active = activation(await client.request("/api/v1/me/telemetry-v11/domain-activate", { body: manifest }), manifest);
    if (progressStore !== null) {
      // The verified server receipt is authoritative even if cleanup fails.
      // A leftover cursor has the old predecessor and cannot acknowledge a
      // different generation on the next pass.
      try { await progressOperation(() => progressStore.write(null)); } catch { /* Recover on the next pass. */ }
    }
    return outcome();
  } catch (error) {
    if (progressStore !== null && error instanceof SyncFailure
        && ["local_index_changed", "revision_conflict"].includes(error.failureCode)) {
      try { await progressOperation(() => progressStore.write(null)); } catch { /* The next read revalidates its scope. */ }
    }
    if (error instanceof PassBudgetReached || error instanceof SyncFailure) return outcome(error);
    return outcome(new SyncFailure("response_invalid"));
  }
}
