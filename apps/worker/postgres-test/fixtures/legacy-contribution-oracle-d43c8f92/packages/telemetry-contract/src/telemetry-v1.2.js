import { TELEMETRY_PLAN_TYPES } from "./constants.js";
import { isTelemetryContractError, telemetryContractFailure } from "./errors.js";
import {
  assertTelemetryClientBounds,
  hasTelemetryExactKeys,
  isTelemetryInstant,
  isTelemetryRecord,
  telemetryPrivacyCanary,
} from "./primitives.js";

// Availability is not consent or permission to send. The hosted lifecycle
// starts staged and must be advanced through a separately authorized cutover.
export const TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION = "telemetry-contribution-v1.2";
export const TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION = "telemetry-envelope-v1.2";
export const TELEMETRY_V12_DAY_MANIFEST_SCHEMA_VERSION = "telemetry-day-manifest-v1.2";
export const TELEMETRY_V12_FIELD_DICTIONARY_VERSION = "telemetry-v1.2-registry-2026-09-20.1";
export const TELEMETRY_V12_PRIVACY_CONTRACT_VERSION = "ongoing-privacy-safe-telemetry-v1.2";
export const TELEMETRY_V12_CONTRACT_STATE = "staged";
export const MAX_TELEMETRY_V12_CHUNK_RECORDS = 200;
export const MAX_TELEMETRY_V12_CHUNK_CANONICAL_BYTES = 1_250_000;
export const MAX_TELEMETRY_V12_DAY_CHUNKS = 4_096;
export const MAX_TELEMETRY_V12_DAY_CANONICAL_BYTES = 64_000_000;
export const MAX_TELEMETRY_V12_TIE_ORDER =
  (MAX_TELEMETRY_V12_DAY_CHUNKS * MAX_TELEMETRY_V12_CHUNK_RECORDS) - 1;
// The envelope schema permits a two-million-character base64url ciphertext.
// This is the exact JSON byte ceiling for that ciphertext plus the largest
// permitted keyId and the fixed envelope punctuation/field names.
const MAX_TELEMETRY_V12_ENVELOPE_BYTES = 2_000_538;
export const TELEMETRY_V12_STREAMS = Object.freeze(["quota", "session", "usage"]);
export const TELEMETRY_V12_ACCOUNT_BASES = Object.freeze([
  "same_source", "provisional_marker", "unavailable",
]);
export const TELEMETRY_V12_PLAN_BASES = Object.freeze([
  "same_source_occurrence", "provisional_marker", "conflicted", "unavailable",
]);

const V12_DIGEST = /^[0-9a-f]{64}$/u;
const V12_TRACK = /^account-track:v2:[0-9a-f]{64}$/u;
const V12_ERA = /^plan-era:v1:[0-9a-f]{64}$/u;
const V12_TOKEN = /^[A-Za-z0-9._:-]{1,64}$/u;
const V12_OCCURRENCE = /^[A-Za-z0-9._:-]{8,128}$/u;
const V12_PARSER = /^[A-Za-z0-9._-]{1,64}$/u;
const V12_CHUNK = /^(quota|session|usage):(\d{4}-\d{2}-\d{2}):(0|[1-9]\d{0,4})$/u;
const V12_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const V12_COMPONENTS = Object.freeze([
  "inputUncachedTokens", "inputCacheReadTokens", "inputCacheWriteTokens",
  "outputTextTokens", "outputReasoningTokens", "outputCombinedTokens",
]);
const V12_ATTRIBUTION_KEYS = Object.freeze([
  "accountBasis", "accountTrackId", "planBasis", "planType", "planEraId",
]);
const V12_USAGE_KEYS = Object.freeze([
  "schemaVersion", "eventId", "eventTime", "sessionUuid", "provider",
  "modelId", "speedMode", "apiServiceTier", "surface", "billingSurface",
  "reasoningEffort", "agentScope", "outcome", "totalInputContextTokens",
  "components", "accountPlanAttribution", "boundaryFlags", "tieOrder",
  "cacheWriteTtl",
]);

function v12Invalid(detail = "v12_record_invalid") {
  telemetryContractFailure("TELEMETRY_RECORD_INVALID", detail);
}

function v12Integer(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function v12Token(value, pattern = V12_TOKEN) {
  return typeof value === "string" && pattern.test(value);
}

function isTelemetryV12Instant(value) {
  return typeof value === "string"
    && V12_INSTANT.test(value)
    && isTelemetryInstant(value);
}

function v12UtcDay(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && isTelemetryV12Instant(`${value}T00:00:00.000Z`);
}

function v12Guard(value, operation, { manifest = false } = {}) {
  try {
    assertTelemetryClientBounds(value, {
      maxSerializedBytes: MAX_TELEMETRY_V12_CHUNK_CANONICAL_BYTES,
      maxDepth: 8,
      maxArrayItems: manifest
        ? MAX_TELEMETRY_V12_DAY_CHUNKS
        : MAX_TELEMETRY_V12_CHUNK_RECORDS,
    });
    if (telemetryPrivacyCanary(value)) {
      telemetryContractFailure("PRIVACY_CANARY_DETECTED", "v12_privacy_canary");
    }
    return operation();
  } catch (error) {
    if (isTelemetryContractError(error)) throw error;
    v12Invalid();
  }
}

function v12DayUsageGuard(value, operation) {
  try {
    assertTelemetryClientBounds(value, {
      maxSerializedBytes: MAX_TELEMETRY_V12_DAY_CANONICAL_BYTES,
      maxDepth: 8,
      maxArrayItems: MAX_TELEMETRY_V12_CHUNK_RECORDS
        * MAX_TELEMETRY_V12_DAY_CHUNKS,
    });
    if (telemetryPrivacyCanary(value)) {
      telemetryContractFailure("PRIVACY_CANARY_DETECTED", "v12_day_privacy_canary");
    }
    return operation();
  } catch (error) {
    if (isTelemetryContractError(error)) throw error;
    v12Invalid();
  }
}

export function telemetryV12RequiredConsent() {
  return Object.freeze({
    telemetrySchemaVersion: TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
    fieldDictionaryVersion: TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
    privacyContractVersion: TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
  });
}

export function isTelemetryV12ConsentCurrent(value) {
  return hasTelemetryExactKeys(value, [
    "telemetrySchemaVersion", "fieldDictionaryVersion", "privacyContractVersion",
  ]) && value.telemetrySchemaVersion === TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION
    && value.fieldDictionaryVersion === TELEMETRY_V12_FIELD_DICTIONARY_VERSION
    && value.privacyContractVersion === TELEMETRY_V12_PRIVACY_CONTRACT_VERSION;
}

function v12Attribution(value) {
  if (!hasTelemetryExactKeys(value, V12_ATTRIBUTION_KEYS)
      || !TELEMETRY_V12_ACCOUNT_BASES.includes(value.accountBasis)
      || !TELEMETRY_V12_PLAN_BASES.includes(value.planBasis)
      || !TELEMETRY_PLAN_TYPES.includes(value.planType)
      || (value.accountTrackId !== null && !v12Token(value.accountTrackId, V12_TRACK))
      || (value.planEraId !== null && !v12Token(value.planEraId, V12_ERA))) v12Invalid();
  if ((value.accountBasis === "unavailable") !== (value.accountTrackId === null)) v12Invalid();
  const unknownPlan = value.planBasis === "unavailable" || value.planBasis === "conflicted";
  if (unknownPlan !== (value.planType === "unknown")
      || (unknownPlan && value.planEraId !== null)) v12Invalid();
  return value;
}

export function parseTelemetryV12Attribution(value) {
  // Keep the v1.1 attribution proof rules byte-for-byte aligned while making
  // the v1.2 entry point independently available to callers and schemas.
  return v12Guard(value, () => v12Attribution(value));
}

function v12Components(value) {
  return hasTelemetryExactKeys(value, V12_COMPONENTS)
    && Object.values(value).every((item) => item === null || v12Integer(item, 1_000_000_000_000));
}

function v12CacheWriteTtl(value, aggregate) {
  if (value === null) return true;
  return hasTelemetryExactKeys(value, ["fiveMinuteTokens", "oneHourTokens"])
    && aggregate !== null
    && v12Integer(value.fiveMinuteTokens, 1_000_000_000_000)
    && v12Integer(value.oneHourTokens, 1_000_000_000_000)
    && value.fiveMinuteTokens + value.oneHourTokens === aggregate;
}

function v12Usage(value) {
  if (!hasTelemetryExactKeys(value, V12_USAGE_KEYS)
      || value.schemaVersion !== "usage-event-v1.2"
      || !v12Token(value.eventId, V12_OCCURRENCE)
      || !isTelemetryV12Instant(value.eventTime)
      || !v12Token(value.sessionUuid, V12_OCCURRENCE)
      || ![value.provider, value.modelId, value.speedMode, value.apiServiceTier,
        value.surface, value.billingSurface, value.reasoningEffort,
        value.agentScope, value.outcome].every((item) => v12Token(item))
      || !v12Components(value.components)
      || !(value.boundaryFlags === null || v12Integer(value.boundaryFlags, 3))
      || !(value.tieOrder === null || v12Integer(value.tieOrder, MAX_TELEMETRY_V12_TIE_ORDER))
      || ![value.totalInputContextTokens, ...Object.values(value.components)]
        .every((item) => item === null || v12Integer(item, 1_000_000_000_000))
      || !v12CacheWriteTtl(value.cacheWriteTtl, value.components.inputCacheWriteTokens)) v12Invalid();
  // Run the exact v1.1 attribution relation locally as well as through the
  // compatibility parser. It prevents future v1.1 helper changes from
  // silently broadening this successor's closed contract.
  v12Attribution(value.accountPlanAttribution);
  return value;
}

function v12Quota(value) {
  if (!hasTelemetryExactKeys(value, [
    "schemaVersion", "observationId", "observedTime", "provider", "planType",
    "planVariant", "limitId", "slot", "usedPercent", "windowDurationMinutes",
    "resetsAt", "accountPlanAttribution",
  ]) || value.schemaVersion !== "quota-observation-v1.2"
      || !v12Token(value.observationId, V12_OCCURRENCE)
      || !isTelemetryV12Instant(value.observedTime)
      || ![value.provider, value.planVariant, value.limitId, value.slot]
        .every((item) => v12Token(item))
      || !TELEMETRY_PLAN_TYPES.includes(value.planType)
      || (value.usedPercent !== null && (typeof value.usedPercent !== "number"
        || !Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100))
      || (value.windowDurationMinutes !== null
        && (!v12Integer(value.windowDurationMinutes, 527_040) || value.windowDurationMinutes < 1))
      || (value.resetsAt !== null && !isTelemetryV12Instant(value.resetsAt))) v12Invalid();
  v12Attribution(value.accountPlanAttribution);
  if (value.planType !== value.accountPlanAttribution.planType) v12Invalid();
  return value;
}

function v12Session(value) {
  if (!hasTelemetryExactKeys(value, [
    "schemaVersion", "sessionUuid", "firstEventTime", "provider", "toolClassCounts",
  ]) || value.schemaVersion !== "session-dimension-v1.2"
      || !v12Token(value.sessionUuid, V12_OCCURRENCE)
      || !isTelemetryV12Instant(value.firstEventTime)
      || !v12Token(value.provider) || !isTelemetryRecord(value.toolClassCounts)) v12Invalid();
  const entries = Object.entries(value.toolClassCounts);
  if (entries.length < 1 || entries.length > 32
      || entries.some(([key, count]) => !/^[a-zA-Z][A-Za-z0-9]{0,31}$/u.test(key)
        || !v12Integer(count, 1_000_000_000))) v12Invalid();
  return value;
}

export function telemetryV12RecordAnchor(stream, record) {
  if (stream === "usage") return { occurrenceId: record.eventId, observedAt: record.eventTime };
  if (stream === "quota") return { occurrenceId: record.observationId, observedAt: record.observedTime };
  if (stream === "session") return { occurrenceId: record.sessionUuid, observedAt: record.firstEventTime };
  v12Invalid();
}

export function parseTelemetryV12Record(stream, value) {
  return v12Guard(value, () => {
    if (stream === "usage") return v12Usage(value);
    if (stream === "quota") return v12Quota(value);
    if (stream === "session") return v12Session(value);
    v12Invalid();
  });
}

/**
 * Validate the usage-order proof over a complete UTC day before chunking.
 * Singleton timestamps carry rank zero when ranked; tied timestamps carry
 * either no rank at all or the complete contiguous rank set 0..n-1. This helper is
 * deliberately separate from chunk parsing because a tie group may cross a
 * 200-record chunk boundary.
 */
export function validateTelemetryV12DayUsageOrder(day, records) {
  return v12DayUsageGuard(records, () => {
    if (!v12UtcDay(day) || !Array.isArray(records)) v12Invalid("v12_day_usage_invalid");
    const seenEventIds = new Set();
    const groups = new Map();
    for (const record of records) {
      v12Usage(record);
      if (record.eventTime.slice(0, 10) !== day || seenEventIds.has(record.eventId)) {
        v12Invalid("v12_day_usage_invalid");
      }
      seenEventIds.add(record.eventId);
      const key = `${record.sessionUuid}\u0000${record.eventTime}`;
      const group = groups.get(key) ?? [];
      group.push(record.tieOrder);
      groups.set(key, group);
    }
    for (const ranks of groups.values()) {
      const allNull = ranks.every((rank) => rank === null);
      if (allNull) continue;
      if (ranks.some((rank) => rank === null)) v12Invalid("v12_day_usage_order_invalid");
      const sorted = [...ranks].sort((left, right) => left - right);
      if (sorted.some((rank, index) => rank !== index)) {
        v12Invalid("v12_day_usage_order_invalid");
      }
    }
    return records;
  });
}

export function parseTelemetryV12ChunkId(value) {
  const match = typeof value === "string" ? V12_CHUNK.exec(value) : null;
  if (!match || !v12UtcDay(match[2])) v12Invalid("v12_chunk_id_invalid");
  return { stream: match[1], day: match[2], seq: Number(match[3]) };
}

export function parseTelemetryV12Chunk(value) {
  return v12Guard(value, () => {
    if (!hasTelemetryExactKeys(value, [
      "schemaVersion", "manifestDigest", "chunkId", "chunkRevision", "chunkDigest",
      "parserVersion", "consent", "records",
    ]) || value.schemaVersion !== TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION
        || !v12Token(value.manifestDigest, V12_DIGEST)
        || !v12Token(value.chunkDigest, V12_DIGEST)
        || value.chunkRevision !== 1 || !v12Token(value.parserVersion, V12_PARSER)
        || !isTelemetryV12ConsentCurrent(value.consent)
        || !Array.isArray(value.records) || value.records.length < 1
        || value.records.length > MAX_TELEMETRY_V12_CHUNK_RECORDS) v12Invalid();
    const { stream, day } = parseTelemetryV12ChunkId(value.chunkId);
    const seen = new Set();
    for (const row of value.records) {
      const record = stream === "usage" ? v12Usage(row)
        : stream === "quota" ? v12Quota(row) : v12Session(row);
      const anchor = telemetryV12RecordAnchor(stream, record);
      if (anchor.observedAt.slice(0, 10) !== day || seen.has(anchor.occurrenceId)) v12Invalid();
      seen.add(anchor.occurrenceId);
    }
    return value;
  });
}

export function parseTelemetryV12DayManifest(value) {
  return v12Guard(value, () => {
    if (!hasTelemetryExactKeys(value, [
      "schemaVersion", "day", "parserVersion", "consent", "chunks", "excluded", "manifestDigest",
    ]) || value.schemaVersion !== TELEMETRY_V12_DAY_MANIFEST_SCHEMA_VERSION
        || !v12UtcDay(value.day) || !v12Token(value.parserVersion, V12_PARSER)
        || !isTelemetryV12ConsentCurrent(value.consent)
        || !v12Token(value.manifestDigest, V12_DIGEST)
        || !Array.isArray(value.chunks) || value.chunks.length > MAX_TELEMETRY_V12_DAY_CHUNKS
        || !hasTelemetryExactKeys(value.excluded, TELEMETRY_V12_STREAMS)
        || !Object.values(value.excluded).every((count) => v12Integer(count, 1_000_000_000))) v12Invalid();
    let previous = null;
    const nextSeq = { quota: 0, session: 0, usage: 0 };
    for (const chunk of value.chunks) {
      if (!hasTelemetryExactKeys(chunk, ["chunkId", "chunkDigest", "recordCount"])
          || !v12Token(chunk.chunkDigest, V12_DIGEST)
          || !v12Integer(chunk.recordCount, MAX_TELEMETRY_V12_CHUNK_RECORDS)
          || chunk.recordCount < 1) v12Invalid();
      const { stream, day, seq } = parseTelemetryV12ChunkId(chunk.chunkId);
      if (day !== value.day || seq !== nextSeq[stream]
          || (previous !== null && stream < previous)) v12Invalid();
      nextSeq[stream] += 1;
      previous = stream;
    }
    return value;
  }, { manifest: true });
}

// Caller validates first. Sorting uses UTF-16 code units, never a locale or
// provider timestamp; these bytes are common to Node, browsers and Workers.
export function canonicalTelemetryV12Json(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalTelemetryV12Json).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalTelemetryV12Json(value[key])}`).join(",")}}`;
}

export function telemetryV12DayManifestDigestInput(value) {
  const { manifestDigest: _digest, ...body } = parseTelemetryV12DayManifest(value);
  return canonicalTelemetryV12Json(body);
}

export function validateTelemetryV12Envelope(value) {
  try {
    // Envelopes carry a larger encrypted payload than a contribution chunk.
    // Validate descriptors before any property read so hidden fields and
    // accessors cannot bypass the closed envelope contract or run getters.
    assertTelemetryClientBounds(value, {
      maxSerializedBytes: MAX_TELEMETRY_V12_ENVELOPE_BYTES,
      maxDepth: 2,
      maxArrayItems: 1,
    });
    // The ciphertext is opaque base64url. Do not run plaintext privacy canary
    // matching over it: an allowed ciphertext may contain a canary-looking
    // substring by chance. Descriptor checks and the exact key set protect the
    // envelope boundary; content canaries run after decryption on plaintext.
    if (!hasTelemetryExactKeys(value, [
      "schemaVersion", "synthetic", "keyId", "wrappedKey", "iv", "ciphertext",
    ]) || value.schemaVersion !== TELEMETRY_V12_ENVELOPE_SCHEMA_VERSION
        || value.synthetic !== false
        || !v12Token(value.keyId, /^key:[A-Za-z0-9._-]{1,64}$/u)
        || !v12Token(value.wrappedKey, /^[A-Za-z0-9_-]{342}$/u)
        || !v12Token(value.iv, /^[A-Za-z0-9_-]{16}$/u)
        || !v12Token(value.ciphertext, /^[A-Za-z0-9_-]{16,2000000}$/u)) {
      telemetryContractFailure("ENVELOPE_INVALID", "v12_envelope_invalid");
    }
    return value;
  } catch {
    telemetryContractFailure("ENVELOPE_INVALID", "v12_envelope_invalid");
  }
}
