import { createHash } from "node:crypto";

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
  LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  openLocalUnifiedIndex,
  outcomeName,
  reasoningEffortName,
} from "./local-unified-index.js";

// The telemetry-contribution-v1.0 sync engine: one bounded pass of the
// cursor protocol (docs/design/2026-08-07-incremental-contribution-model.md
// section 3). Strictly sequential, oldest day first, one envelope in flight.
//
// The service is authoritative for what it accepted; this engine re-derives
// the local truth per pass and never trusts a cached cursor: one cheap
// sync-state read answers the common case (history digest matches, upload
// only the tail), and any disagreement resolves through the day-granular
// manifest diff. Everything returned is a bounded typed figure — day counts,
// chunk counts, ISO days and fixed codes; no path, no content, no identifier
// beyond what the wire contract itself carries.

const RUN_SCHEMA_VERSION = "incremental-contribution-sync-run-v1.0";
const DEFAULT_MAXIMUM_CHUNKS_PER_PASS = 60;
const MAXIMUM_CHUNKS_PER_PASS = 2_000;
const MAX_RESPONSE_BYTES = 32_768;
const MAX_MANIFEST_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_WINDOWS_PER_PASS = 120;
const MANIFEST_WINDOW_DAYS = 31;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const MAXIMUM_RETRY_AFTER_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const DIGEST_HEX = /^[0-9a-f]{64}$/u;
const DEVICE_UPLOAD =
  /^um_device_upload_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/u;
const CHUNK_CONTRIBUTION_ID =
  /^chunk:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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
  if (response.status === 429
      && backendCode === "CHUNK_ADMISSION_LIMIT_REACHED") {
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
function deriveLocalDays(reader) {
  return reader.days().map((day) => {
    const derived = reader.deriveDay(day);
    return {
      day: derived.day,
      dayDigest: derived.dayDigest,
      chunks: derived.chunks.map((chunk) => ({
        stream: chunk.stream,
        chunkSeq: chunk.chunkSeq,
        chunkId: chunk.chunkId,
        chunkDigest: chunk.chunkDigest,
        recordCount: chunk.recordCount,
      })),
    };
  });
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

export async function runIncrementalContributionSyncOnce({
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

  const outcome = (failure) => {
    const pendingDays = new Set(remainingUploads.map((upload) => upload.day));
    return Object.freeze({
      schemaVersion: RUN_SCHEMA_VERSION,
      status: failure !== null
        ? "failed"
        : remainingUploads.length > 0 ? "partial" : "complete",
      daysTotal,
      daysSynced: Math.max(0, daysTotal - pendingDays.size),
      daysPending: pendingDays.size,
      chunksUploaded: counters.chunksUploaded,
      chunksSkipped: counters.chunksSkipped,
      recordsUploaded: counters.recordsUploaded,
      acknowledgedThroughDay,
      orphanChunkIds: Object.freeze([...orphanChunkIds]),
      failure,
      networkActivity: true,
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
    const localDays = deriveLocalDays(reader);
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
