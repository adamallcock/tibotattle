import { TELEMETRY_PLAN_TYPES } from "./constants.js";
import { isTelemetryContractError, telemetryContractFailure } from "./errors.js";
import {
  assertTelemetryClientBounds,
  hasTelemetryExactKeys,
  isTelemetryInstant,
  isTelemetryRecord,
  telemetryPrivacyCanary,
} from "./primitives.js";

// Code availability is not consent or permission to send. The hosted lifecycle
// starts staged and must be advanced through a separately authorized cutover.
export const TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION = "telemetry-contribution-v1.1";
export const TELEMETRY_V11_ENVELOPE_SCHEMA_VERSION = "telemetry-envelope-v1.1";
export const TELEMETRY_V11_DAY_MANIFEST_SCHEMA_VERSION = "telemetry-day-manifest-v1.1";
export const TELEMETRY_V11_FIELD_DICTIONARY_VERSION = "telemetry-v1.1-registry-2026-08-31.1";
export const TELEMETRY_V11_PRIVACY_CONTRACT_VERSION = "ongoing-privacy-safe-telemetry-v1.1";
export const TELEMETRY_V11_CONTRACT_STATE = "staged";
export const MAX_TELEMETRY_V11_CHUNK_RECORDS = 200;
export const MAX_TELEMETRY_V11_CHUNK_CANONICAL_BYTES = 1_250_000;
export const MAX_TELEMETRY_V11_DAY_CHUNKS = 4_096;
export const TELEMETRY_V11_STREAMS = Object.freeze(["quota", "session", "usage"]);
export const TELEMETRY_V11_ACCOUNT_BASES = Object.freeze([
  "same_source", "provisional_marker", "unavailable",
]);
export const TELEMETRY_V11_PLAN_BASES = Object.freeze([
  "same_source_occurrence", "provisional_marker", "conflicted", "unavailable",
]);

const DIGEST = /^[0-9a-f]{64}$/u;
const TRACK = /^account-track:v2:[0-9a-f]{64}$/u;
const ERA = /^plan-era:v1:[0-9a-f]{64}$/u;
const TOKEN = /^[A-Za-z0-9._:-]{1,64}$/u;
const OCCURRENCE = /^[A-Za-z0-9._:-]{8,128}$/u;
const PARSER = /^[A-Za-z0-9._-]{1,64}$/u;
const CHUNK = /^(quota|session|usage):(\d{4}-\d{2}-\d{2}):(0|[1-9]\d{0,4})$/u;
const COMPONENTS = Object.freeze([
  "inputUncachedTokens", "inputCacheReadTokens", "inputCacheWriteTokens",
  "outputTextTokens", "outputReasoningTokens", "outputCombinedTokens",
]);
const ATTRIBUTION_KEYS = Object.freeze([
  "accountBasis", "accountTrackId", "planBasis", "planType", "planEraId",
]);

function v11Invalid(detail = "v11_record_invalid") {
  telemetryContractFailure("TELEMETRY_RECORD_INVALID", detail);
}

function integer(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function token(value, pattern = TOKEN) {
  return typeof value === "string" && pattern.test(value);
}

function utcDay(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && isTelemetryInstant(`${value}T00:00:00.000Z`);
}

function guard(value, operation, { manifest = false } = {}) {
  try {
    assertTelemetryClientBounds(value, {
      maxSerializedBytes: MAX_TELEMETRY_V11_CHUNK_CANONICAL_BYTES,
      maxDepth: 8,
      maxArrayItems: manifest ? MAX_TELEMETRY_V11_DAY_CHUNKS : MAX_TELEMETRY_V11_CHUNK_RECORDS,
    });
    if (telemetryPrivacyCanary(value)) {
      telemetryContractFailure("PRIVACY_CANARY_DETECTED", "v11_privacy_canary");
    }
    return operation();
  } catch (error) {
    if (isTelemetryContractError(error)) throw error;
    v11Invalid();
  }
}

export function telemetryV11RequiredConsent() {
  return Object.freeze({
    telemetrySchemaVersion: TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
    fieldDictionaryVersion: TELEMETRY_V11_FIELD_DICTIONARY_VERSION,
    privacyContractVersion: TELEMETRY_V11_PRIVACY_CONTRACT_VERSION,
  });
}

export function isTelemetryV11ConsentCurrent(value) {
  return hasTelemetryExactKeys(value, [
    "telemetrySchemaVersion", "fieldDictionaryVersion", "privacyContractVersion",
  ]) && value.telemetrySchemaVersion === TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION
    && value.fieldDictionaryVersion === TELEMETRY_V11_FIELD_DICTIONARY_VERSION
    && value.privacyContractVersion === TELEMETRY_V11_PRIVACY_CONTRACT_VERSION;
}

function attribution(value) {
  if (!hasTelemetryExactKeys(value, ATTRIBUTION_KEYS)
      || !TELEMETRY_V11_ACCOUNT_BASES.includes(value.accountBasis)
      || !TELEMETRY_V11_PLAN_BASES.includes(value.planBasis)
      || !TELEMETRY_PLAN_TYPES.includes(value.planType)
      || (value.accountTrackId !== null && !token(value.accountTrackId, TRACK))
      || (value.planEraId !== null && !token(value.planEraId, ERA))) v11Invalid();
  // Plan proof is independent of account proof. This is deliberately valid:
  // same-source Plus evidence, unknown account, no defensible continuity era.
  if ((value.accountBasis === "unavailable") !== (value.accountTrackId === null)) v11Invalid();
  const unknownPlan = value.planBasis === "unavailable" || value.planBasis === "conflicted";
  if (unknownPlan !== (value.planType === "unknown")
      || (unknownPlan && value.planEraId !== null)) v11Invalid();
  return value;
}

export function parseTelemetryV11Attribution(value) {
  return guard(value, () => attribution(value));
}

function usage(value) {
  if (!hasTelemetryExactKeys(value, [
    "schemaVersion", "eventId", "eventTime", "sessionUuid", "provider",
    "modelId", "speedMode", "apiServiceTier", "surface", "billingSurface",
    "reasoningEffort", "agentScope", "outcome", "totalInputContextTokens",
    "components", "accountPlanAttribution",
  ]) || value.schemaVersion !== "usage-event-v1.1"
      || !token(value.eventId, OCCURRENCE)
      || !isTelemetryInstant(value.eventTime)
      || !token(value.sessionUuid, OCCURRENCE)
      || ![value.provider, value.modelId, value.speedMode, value.apiServiceTier,
        value.surface, value.billingSurface, value.reasoningEffort,
        value.agentScope, value.outcome].every((item) => token(item))
      || !hasTelemetryExactKeys(value.components, COMPONENTS)
      || ![value.totalInputContextTokens, ...Object.values(value.components)]
        .every((item) => item === null || integer(item, 1_000_000_000_000))) v11Invalid();
  attribution(value.accountPlanAttribution);
  return value;
}

function quota(value) {
  if (!hasTelemetryExactKeys(value, [
    "schemaVersion", "observationId", "observedTime", "provider", "planType",
    "planVariant", "limitId", "slot", "usedPercent", "windowDurationMinutes",
    "resetsAt", "accountPlanAttribution",
  ]) || value.schemaVersion !== "quota-observation-v1.1"
      || !token(value.observationId, OCCURRENCE)
      || !isTelemetryInstant(value.observedTime)
      || ![value.provider, value.planVariant, value.limitId, value.slot]
        .every((item) => token(item))
      || !TELEMETRY_PLAN_TYPES.includes(value.planType)
      || (value.usedPercent !== null && (typeof value.usedPercent !== "number" || !Number.isFinite(value.usedPercent)
        || value.usedPercent < 0 || value.usedPercent > 100))
      || (value.windowDurationMinutes !== null && (!integer(value.windowDurationMinutes, 527_040) || value.windowDurationMinutes < 1))
      || (value.resetsAt !== null && !isTelemetryInstant(value.resetsAt))) v11Invalid();
  attribution(value.accountPlanAttribution);
  if (value.planType !== value.accountPlanAttribution.planType) v11Invalid();
  return value;
}

function session(value) {
  if (!hasTelemetryExactKeys(value, [
    "schemaVersion", "sessionUuid", "firstEventTime", "provider", "toolClassCounts",
  ]) || value.schemaVersion !== "session-dimension-v1.1"
      || !token(value.sessionUuid, OCCURRENCE)
      || !isTelemetryInstant(value.firstEventTime)
      || !token(value.provider) || !isTelemetryRecord(value.toolClassCounts)) v11Invalid();
  const entries = Object.entries(value.toolClassCounts);
  if (entries.length < 1 || entries.length > 32
      || entries.some(([key, count]) => !/^[a-zA-Z][A-Za-z0-9]{0,31}$/u.test(key)
        || !integer(count, 1_000_000_000))) v11Invalid();
  return value;
}

export function telemetryV11RecordAnchor(stream, record) {
  if (stream === "usage") return { occurrenceId: record.eventId, observedAt: record.eventTime };
  if (stream === "quota") return { occurrenceId: record.observationId, observedAt: record.observedTime };
  if (stream === "session") return { occurrenceId: record.sessionUuid, observedAt: record.firstEventTime };
  v11Invalid();
}

export function parseTelemetryV11Record(stream, value) {
  return guard(value, () => {
    if (stream === "usage") return usage(value);
    if (stream === "quota") return quota(value);
    if (stream === "session") return session(value);
    v11Invalid();
  });
}

export function parseTelemetryV11ChunkId(value) {
  const match = typeof value === "string" ? CHUNK.exec(value) : null;
  if (!match || !utcDay(match[2])) v11Invalid("v11_chunk_id_invalid");
  return { stream: match[1], day: match[2], seq: Number(match[3]) };
}

export function parseTelemetryV11Chunk(value) {
  return guard(value, () => {
    if (!hasTelemetryExactKeys(value, [
      "schemaVersion", "manifestDigest", "chunkId", "chunkRevision", "chunkDigest",
      "parserVersion", "consent", "records",
    ]) || value.schemaVersion !== TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION
        || !token(value.manifestDigest, DIGEST) || !token(value.chunkDigest, DIGEST)
        || value.chunkRevision !== 1 || !token(value.parserVersion, PARSER)
        || !isTelemetryV11ConsentCurrent(value.consent)
        || !Array.isArray(value.records) || value.records.length < 1
        || value.records.length > MAX_TELEMETRY_V11_CHUNK_RECORDS) v11Invalid();
    const { stream, day } = parseTelemetryV11ChunkId(value.chunkId);
    const seen = new Set();
    for (const row of value.records) {
      const record = stream === "usage" ? usage(row) : stream === "quota" ? quota(row) : session(row);
      const anchor = telemetryV11RecordAnchor(stream, record);
      if (anchor.observedAt.slice(0, 10) !== day || seen.has(anchor.occurrenceId)) v11Invalid();
      seen.add(anchor.occurrenceId);
    }
    return value;
  });
}

export function parseTelemetryV11DayManifest(value) {
  return guard(value, () => {
    if (!hasTelemetryExactKeys(value, [
      "schemaVersion", "day", "parserVersion", "consent", "chunks", "excluded", "manifestDigest",
    ]) || value.schemaVersion !== TELEMETRY_V11_DAY_MANIFEST_SCHEMA_VERSION
        || !utcDay(value.day) || !token(value.parserVersion, PARSER)
        || !isTelemetryV11ConsentCurrent(value.consent)
        || !token(value.manifestDigest, DIGEST)
        || !Array.isArray(value.chunks) || value.chunks.length > MAX_TELEMETRY_V11_DAY_CHUNKS
        || !hasTelemetryExactKeys(value.excluded, TELEMETRY_V11_STREAMS)
        || !Object.values(value.excluded).every((count) => integer(count, 1_000_000_000))) v11Invalid();
    let previous = null;
    const nextSeq = { quota: 0, session: 0, usage: 0 };
    for (const chunk of value.chunks) {
      if (!hasTelemetryExactKeys(chunk, ["chunkId", "chunkDigest", "recordCount"])
          || !token(chunk.chunkDigest, DIGEST)
          || !integer(chunk.recordCount, MAX_TELEMETRY_V11_CHUNK_RECORDS)
          || chunk.recordCount < 1) v11Invalid();
      const { stream, day, seq } = parseTelemetryV11ChunkId(chunk.chunkId);
      if (day !== value.day || seq !== nextSeq[stream]
          || (previous !== null && stream < previous)) v11Invalid();
      nextSeq[stream] += 1;
      previous = stream;
    }
    return value;
  }, { manifest: true });
}

// Caller validates first. Sorting uses UTF-16 code units, never a locale or
// provider timestamp; these bytes are common to Node, browsers and Workers.
export function canonicalTelemetryV11Json(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalTelemetryV11Json).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalTelemetryV11Json(value[key])}`).join(",")}}`;
}

export function telemetryV11DayManifestDigestInput(value) {
  const { manifestDigest: _digest, ...body } = parseTelemetryV11DayManifest(value);
  return canonicalTelemetryV11Json(body);
}

export function validateTelemetryV11Envelope(value) {
  try {
    if (!hasTelemetryExactKeys(value, [
      "schemaVersion", "synthetic", "keyId", "wrappedKey", "iv", "ciphertext",
    ]) || value.schemaVersion !== TELEMETRY_V11_ENVELOPE_SCHEMA_VERSION
        || value.synthetic !== false || !token(value.keyId, /^key:[A-Za-z0-9._-]{1,64}$/u)
        || !token(value.wrappedKey, /^[A-Za-z0-9_-]{342}$/u)
        || !token(value.iv, /^[A-Za-z0-9_-]{16}$/u)
        || !token(value.ciphertext, /^[A-Za-z0-9_-]{16,2000000}$/u)) {
      telemetryContractFailure("ENVELOPE_INVALID", "v11_envelope_invalid");
    }
    return value;
  } catch {
    telemetryContractFailure("ENVELOPE_INVALID", "v11_envelope_invalid");
  }
}
