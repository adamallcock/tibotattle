import { createHash } from "node:crypto";
import {
  canonicalTelemetryV12Json,
  MAX_TELEMETRY_V12_CHUNK_CANONICAL_BYTES,
  MAX_TELEMETRY_V12_CHUNK_RECORDS,
  MAX_TELEMETRY_V12_DAY_CANONICAL_BYTES,
  MAX_TELEMETRY_V12_DAY_CHUNKS,
  MAX_TELEMETRY_V12_TIE_ORDER,
  TELEMETRY_V12_ACCOUNT_BASES,
  TELEMETRY_V12_CONTRACT_STATE,
  TELEMETRY_V12_DAY_MANIFEST_SCHEMA_VERSION,
  TELEMETRY_V12_PLAN_BASES,
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  parseTelemetryV12Chunk,
  parseTelemetryV12DayManifest,
  parseTelemetryV12Record,
  telemetryV12DayManifestDigestInput,
  telemetryV12RequiredConsent,
  validateTelemetryV12DayUsageOrder,
} from "@app-usagemonitor/telemetry-contract";
import {
  createTelemetryV11Day,
} from "./telemetry-v11-chunks.js";

const V12_RECORD_KEYS = Object.freeze({
  usage: Object.freeze([
    "schemaVersion", "eventId", "eventTime", "sessionUuid", "provider", "modelId", "speedMode",
    "apiServiceTier", "surface", "billingSurface", "reasoningEffort", "agentScope",
    "outcome", "totalInputContextTokens", "components", "accountPlanAttribution",
    "boundaryFlags", "tieOrder", "cacheWriteTtl",
  ]),
  quota: Object.freeze([
    "schemaVersion", "observationId", "observedTime", "provider", "planType", "planVariant", "limitId",
    "slot", "usedPercent", "windowDurationMinutes", "resetsAt", "accountPlanAttribution",
  ]),
  session: Object.freeze([
    "schemaVersion", "sessionUuid", "firstEventTime", "provider", "toolClassCounts",
  ]),
});
const V12_RECORD_SCHEMAS = Object.freeze({
  usage: "usage-event-v1.2",
  quota: "quota-observation-v1.2",
  session: "session-dimension-v1.2",
});
const V12_USAGE_NULLABLE_FIELDS = Object.freeze([
  "boundaryFlags", "tieOrder", "cacheWriteTtl",
]);
const V12_CACHE_WRITE_TTL_KEYS = Object.freeze([
  "fiveMinuteTokens", "oneHourTokens",
]);

const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isTelemetryInstant(value) {
  // The cutoff is compared lexicographically with the source event strings.
  // Restrict it to the four-digit UTC wire form so extended ISO years cannot
  // sort before an otherwise later cutoff (for example +010000... versus 2026).
  if (typeof value !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function nonNegativeInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function invalid(message) {
  throw new TypeError(message);
}

function normalizeBoundaryFlags(evidence) {
  if (evidence === null) return null;
  if (typeof evidence !== "object" || Array.isArray(evidence)) {
    invalid("Telemetry v1.2 continuity evidence is invalid");
  }
  if (Object.hasOwn(evidence, "turnContextBefore")
      || Object.hasOwn(evidence, "compactionBefore")) {
    invalid("Telemetry v1.2 continuity evidence must use boundaryFlags");
  }
  if (Object.hasOwn(evidence, "boundaryFlags")) {
    const value = evidence.boundaryFlags;
    if (value !== null && !nonNegativeInteger(value, 3)) {
      invalid("Telemetry v1.2 boundary flags are invalid");
    }
    return value;
  }
  return null;
}

function normalizeTieOrder(evidence) {
  if (evidence === null) return null;
  if (typeof evidence !== "object" || Array.isArray(evidence)) {
    invalid("Telemetry v1.2 continuity evidence is invalid");
  }
  const value = Object.hasOwn(evidence, "tieOrder") ? evidence.tieOrder : null;
  if (value !== null && !nonNegativeInteger(value, MAX_TELEMETRY_V12_TIE_ORDER)) {
    invalid("Telemetry v1.2 tie order is invalid");
  }
  return value;
}

function normalizeCacheWriteTtl(value, aggregate) {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)
      || !V12_CACHE_WRITE_TTL_KEYS.every((key) => Object.hasOwn(value, key))
      || aggregate === null
      || !V12_CACHE_WRITE_TTL_KEYS.every((key) =>
        nonNegativeInteger(value[key], 1_000_000_000_000))) {
    invalid("Telemetry v1.2 cache-write TTL evidence is invalid");
  }
  if (value.fiveMinuteTokens + value.oneHourTokens !== aggregate) {
    invalid("Telemetry v1.2 cache-write TTL evidence does not reconcile");
  }
  return {
    fiveMinuteTokens: value.fiveMinuteTokens,
    oneHourTokens: value.oneHourTokens,
  };
}

function projectRecord(stream, source, schemaVersion) {
  const record = Object.fromEntries(V12_RECORD_KEYS[stream].map((key) => [key, source[key]]));
  record.schemaVersion = schemaVersion;
  return record;
}

function chunkRecords(stream, day, records, parserVersion, consent, chunks) {
  for (let index = 0; index < records.length; index += MAX_TELEMETRY_V12_CHUNK_RECORDS) {
    const slice = records.slice(index, index + MAX_TELEMETRY_V12_CHUNK_RECORDS);
    const canonical = canonicalTelemetryV12Json(slice);
    if (Buffer.byteLength(canonical, "utf8") > MAX_TELEMETRY_V12_CHUNK_CANONICAL_BYTES) {
      invalid("Telemetry v1.2 chunk exceeds its bound");
    }
    if (chunks.length >= MAX_TELEMETRY_V12_DAY_CHUNKS) {
      invalid("Telemetry v1.2 day exceeds its chunk bound");
    }
    chunks.push({
      schemaVersion: TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
      manifestDigest: "0".repeat(64),
      chunkId: `${stream}:${day}:${index / MAX_TELEMETRY_V12_CHUNK_RECORDS}`,
      chunkRevision: 1,
      chunkDigest: hash(canonical),
      parserVersion,
      consent,
      records: slice,
    });
  }
}

/** Exact bounded fields shown for the separate successor review/consent. */
export function telemetryV12FieldInventory() {
  const inventory = {
    schemaVersion: "telemetry-field-inventory-v1.2",
    contractState: TELEMETRY_V12_CONTRACT_STATE,
    consent: telemetryV12RequiredConsent(),
    fields: {
      usage: [...V12_RECORD_KEYS.usage],
      quota: [...V12_RECORD_KEYS.quota],
      session: [...V12_RECORD_KEYS.session],
      accountPlanAttribution: [
        "accountBasis", "accountTrackId", "planBasis", "planType", "planEraId",
      ],
    },
    accountBases: [...TELEMETRY_V12_ACCOUNT_BASES],
    planBases: [...TELEMETRY_V12_PLAN_BASES],
    nullableQuotaMeasurements: ["usedPercent", "windowDurationMinutes", "resetsAt"],
    nullableUsageFields: [...V12_USAGE_NULLABLE_FIELDS],
    boundaryFlags: {
      nullable: true,
      minimum: 0,
      maximum: 3,
      bit0: "turn_context_before",
      bit1: "compaction_before",
    },
    tieOrder: {
      nullable: true,
      minimum: 0,
      maximum: MAX_TELEMETRY_V12_TIE_ORDER,
      group: ["sessionUuid", "eventTime"],
      rankStart: 0,
    },
    cacheWriteTtl: {
      fields: [...V12_CACHE_WRITE_TTL_KEYS],
      aggregateField: "components.inputCacheWriteTokens",
      additive: false,
    },
  };
  return deepFreeze({
    ...inventory,
    inventoryDigest: hash(canonicalTelemetryV12Json(inventory)),
  });
}

/**
 * Pure, dormant v1.2 day projection. It consumes the reviewed v1.1 base
 * projection and creates a fresh v1.2 consent/manifest/chunk byte set. This
 * function does not persist activation, consult a client capability, or send
 * anything to a transport.
 */
export function createTelemetryV12Day({
  day,
  recordsByStream,
  attributionForRecord = () => null,
  accountObservationSecret = null,
  binding = null,
  parserVersion,
  excluded = { usage: 0, quota: 0, session: 0 },
  activationTime = null,
  continuityForRecord = () => null,
  cacheWriteTtlForRecord = () => null,
} = {}) {
  if (!recordsByStream || typeof recordsByStream !== "object" || Array.isArray(recordsByStream)
      || typeof attributionForRecord !== "function"
      || typeof continuityForRecord !== "function"
      || typeof cacheWriteTtlForRecord !== "function") {
    invalid("Telemetry v1.2 day source is invalid");
  }
  if (activationTime !== null && !isTelemetryInstant(activationTime)) {
    invalid("Telemetry v1.2 activation time is invalid");
  }

  // The v1.1 builder remains the reviewed owner/account/plan projection. Its
  // result is immutable and closed, so v1.2 cannot accidentally widen v1.1
  // records or reuse its consent as permission for the successor.
  const predecessor = createTelemetryV11Day({
    day,
    recordsByStream,
    attributionForRecord,
    accountObservationSecret,
    binding,
    parserVersion,
    excluded,
  });
  const sourceUsage = new Map();
  for (const source of recordsByStream.usage ?? []) {
    if (source && typeof source === "object" && typeof source.eventId === "string") {
      sourceUsage.set(source.eventId, source);
    }
  }

  const usage = [];
  const quota = [];
  const session = [];
  let dayCanonicalBytes = 0;
  const appendRecord = (target, record) => {
    dayCanonicalBytes += Buffer.byteLength(canonicalTelemetryV12Json(record), "utf8");
    if (dayCanonicalBytes > MAX_TELEMETRY_V12_DAY_CANONICAL_BYTES) {
      invalid("Telemetry v1.2 day exceeds its byte bound");
    }
    target.push(record);
  };
  for (const chunk of predecessor.chunks) {
    const stream = chunk.chunkId.slice(0, chunk.chunkId.indexOf(":"));
    const target = stream === "usage" ? usage : stream === "quota" ? quota : session;
    for (const base of chunk.records) {
      const source = stream === "usage" ? sourceUsage.get(base.eventId) ?? base : base;
      if (stream !== "usage") {
        appendRecord(target, projectRecord(stream, base, V12_RECORD_SCHEMAS[stream]));
        continue;
      }
      const postActivation = activationTime !== null && base.eventTime >= activationTime;
      let continuity = null;
      const ttl = cacheWriteTtlForRecord(source);
      if (postActivation) {
        continuity = continuityForRecord(stream, source);
      }
      const record = projectRecord("usage", base, V12_RECORD_SCHEMAS.usage);
      record.boundaryFlags = postActivation ? normalizeBoundaryFlags(continuity) : null;
      record.tieOrder = postActivation ? normalizeTieOrder(continuity) : null;
      record.cacheWriteTtl = normalizeCacheWriteTtl(
        ttl, base.components.inputCacheWriteTokens,
      );
      appendRecord(target, record);
    }
  }

  // This validation runs before chunking. A group sharing one timestamp may
  // straddle a 200-record chunk boundary and must still be checked as one set.
  const dayCanonical = canonicalTelemetryV12Json({ quota, session, usage });
  if (Buffer.byteLength(dayCanonical, "utf8") > MAX_TELEMETRY_V12_DAY_CANONICAL_BYTES) {
    invalid("Telemetry v1.2 day exceeds its byte bound");
  }
  validateTelemetryV12DayUsageOrder(day, usage);
  for (const record of usage) parseTelemetryV12Record("usage", record);
  for (const record of quota) parseTelemetryV12Record("quota", record);
  for (const record of session) parseTelemetryV12Record("session", record);

  const consent = telemetryV12RequiredConsent();
  const chunks = [];
  chunkRecords("quota", day, quota, parserVersion, consent, chunks);
  chunkRecords("session", day, session, parserVersion, consent, chunks);
  chunkRecords("usage", day, usage, parserVersion, consent, chunks);
  const manifest = {
    schemaVersion: TELEMETRY_V12_DAY_MANIFEST_SCHEMA_VERSION,
    day,
    parserVersion,
    consent,
    chunks: chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      chunkDigest: chunk.chunkDigest,
      recordCount: chunk.records.length,
    })),
    excluded: {
      quota: excluded.quota,
      session: excluded.session,
      usage: excluded.usage,
    },
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = hash(telemetryV12DayManifestDigestInput(manifest));
  parseTelemetryV12DayManifest(manifest);
  for (const chunk of chunks) {
    chunk.manifestDigest = manifest.manifestDigest;
    parseTelemetryV12Chunk(chunk);
  }
  return deepFreeze({ manifest, chunks });
}
