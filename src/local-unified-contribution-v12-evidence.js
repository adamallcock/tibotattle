import {
  LOCAL_TELEMETRY_V12_EVIDENCE_LIMITS,
  createTelemetryV12LocalEvidenceAdapter,
} from "./local-unified-contribution-v12-evidence-adapter.js";

const RECORD_KEYS = Object.freeze(["eventId", "eventTime", "sessionUuid"]);
const FACT_KEYS = Object.freeze([
  "eventId", "sessionLocal", "sourceLocal", "sourceOffset", "sourceOrdinal",
  "parserVersion", "boundary",
]);
const HEX_DIGEST = /^[0-9a-f]{64}$/u;

function invalid(message = "Local telemetry v1.2 index evidence is invalid") {
  throw new TypeError(message);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function dataValues(value, keys) {
  if (!isPlainRecord(value)) return null;
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  const actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length
      || actual.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function recordValues(value) {
  if (!isPlainRecord(value)) invalid("Local telemetry v1.2 emitted record is invalid");
  const fields = {};
  for (const key of RECORD_KEYS) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
    catch { descriptor = undefined; }
    if (descriptor === undefined
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true) {
      invalid("Local telemetry v1.2 emitted record is invalid");
    }
    fields[key] = descriptor.value;
  }
  return fields;
}

function factValues(value) {
  const fields = dataValues(value, FACT_KEYS);
  if (fields === null) invalid("Local telemetry v1.2 index fact is invalid");
  if (typeof fields.eventId !== "string"
      || typeof fields.sessionLocal !== "string" && fields.sessionLocal !== null
      || typeof fields.sourceLocal !== "string" && fields.sourceLocal !== null
      || (fields.sessionLocal !== null && !HEX_DIGEST.test(fields.sessionLocal))
      || (fields.sourceLocal !== null && !HEX_DIGEST.test(fields.sourceLocal))
      || (fields.sourceOffset !== null && !Number.isSafeInteger(fields.sourceOffset))
      || (fields.sourceOrdinal !== null && !Number.isSafeInteger(fields.sourceOrdinal))
      || (fields.parserVersion !== null && typeof fields.parserVersion !== "string")) {
    invalid("Local telemetry v1.2 index fact is invalid");
  }
  return fields;
}

function placeholder(record) {
  return {
    eventId: record.eventId,
    eventTime: record.eventTime,
    sessionUuid: record.sessionUuid,
    sessionLocal: null,
    sourceLocal: null,
    sourceOffset: null,
    sourceOrdinal: null,
    parserVersion: null,
    boundary: null,
  };
}

/**
 * Join the final emitted v1/v1.1 usage identities to a content-free index
 * fact set. `records` must already be the prepared day's post-exclusion,
 * complete-page usage stream; this selector cannot infer later projection
 * exclusions from raw facts. The index reader owns the event-key SQL join and
 * passes `boundaryLookupComplete` only after that bounded query succeeds.
 * Missing facts therefore make all missing boundary relations unavailable
 * rather than silently becoming zero.
 */
export function createLocalUnifiedTelemetryV12EvidenceSelector({
  records,
  facts,
  boundaryLookupComplete = false,
  maxRows = LOCAL_TELEMETRY_V12_EVIDENCE_LIMITS.rows,
} = {}) {
  if (!Array.isArray(records) || !Array.isArray(facts)
      || !Number.isSafeInteger(maxRows) || maxRows < 1
      || maxRows > LOCAL_TELEMETRY_V12_EVIDENCE_LIMITS.rows
      || records.length > maxRows || facts.length > maxRows
      || typeof boundaryLookupComplete !== "boolean") {
    invalid("Local telemetry v1.2 index evidence exceeds its bound");
  }
  const emitted = records.map(recordValues);
  const byEventId = new Map();
  for (const value of facts.map(factValues)) {
    const group = byEventId.get(value.eventId) ?? [];
    group.push(value);
    byEventId.set(value.eventId, group);
  }
  const rows = [];
  let complete = boundaryLookupComplete;
  for (const record of emitted) {
    const matches = byEventId.get(record.eventId);
    if (matches === undefined || matches.length === 0) {
      complete = false;
      rows.push(placeholder(record));
      continue;
    }
    for (const fact of matches) {
      rows.push({
        eventId: record.eventId,
        eventTime: record.eventTime,
        sessionUuid: record.sessionUuid,
        sessionLocal: fact.sessionLocal,
        sourceLocal: fact.sourceLocal,
        sourceOffset: fact.sourceOffset,
        sourceOrdinal: fact.sourceOrdinal,
        parserVersion: fact.parserVersion,
        boundary: fact.boundary,
      });
    }
  }
  if (rows.length > maxRows) invalid("Local telemetry v1.2 index evidence exceeds its bound");
  const adapter = createTelemetryV12LocalEvidenceAdapter({
    rows,
    maxRows,
    boundaryLookupComplete: complete,
  });
  return Object.freeze({
    continuityForRecord: adapter.continuityForRecord,
    rowCount: emitted.length,
    indexFactCount: facts.length,
    boundaryLookupComplete: complete,
  });
}
