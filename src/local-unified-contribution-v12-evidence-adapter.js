// Local-only v1.2 evidence adapter. The input is an already-derived,
// content-free view of the unified index; this module never opens a database,
// reads rollout files, or persists a policy decision.
import { isLocalUnifiedIndexBoundaryParserVersion } from
  "./local-unified-index.js";

const MAX_LOCAL_TELEMETRY_V12_EVIDENCE_ROWS = 250_000;
export const LOCAL_TELEMETRY_V12_EVIDENCE_LIMITS = Object.freeze({
  rows: MAX_LOCAL_TELEMETRY_V12_EVIDENCE_ROWS,
});

const TOKEN = /^[A-Za-z0-9._:-]{8,128}$/u;
const HEX_DIGEST = /^[0-9a-f]{64}$/u;
const PARSER = /^[A-Za-z0-9._-]{1,64}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ROW_KEYS = Object.freeze([
  "eventId", "eventTime", "sessionUuid", "sessionLocal", "sourceLocal",
  "sourceOffset", "sourceOrdinal", "parserVersion", "boundary",
]);
const BOUNDARY_KEYS = Object.freeze([
  "parserVersion", "sessionLocal", "turnContextBefore", "compactionBefore",
  "compactedAtMs",
]);

function invalid(message = "Local telemetry v1.2 evidence is invalid") {
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

// Descriptor inspection keeps an accidental getter, hidden field, or proxy
// from becoming a source read. The adapter consumes only ordinary data rows.
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

function dataField(value, key) {
  if (!isPlainRecord(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined
      && Object.hasOwn(descriptor, "value")
      && descriptor.enumerable === true
      ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeInteger(value, { nullable = false } = {}) {
  if (value === undefined) return undefined;
  if (value === null && nullable) return null;
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeInstant(value) {
  if (typeof value !== "string" || !INSTANT.test(value)) return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value ? value : null;
}

function parserFamily(value) {
  if (!isLocalUnifiedIndexBoundaryParserVersion(value)) return null;
  return value.startsWith("unified-rollout-typed-v15") ? "v15" : "v16";
}

export function isTelemetryV12BoundaryParserVersion(value) {
  return isLocalUnifiedIndexBoundaryParserVersion(value);
}

function normalizeBoundary(value) {
  if (value === null) return null;
  const fields = dataValues(value, BOUNDARY_KEYS);
  if (fields === null) return undefined;
  const parserVersion = typeof fields.parserVersion === "string"
    && PARSER.test(fields.parserVersion) ? fields.parserVersion : null;
  const sessionLocal = fields.sessionLocal === null
    || (typeof fields.sessionLocal === "string" && HEX_DIGEST.test(fields.sessionLocal))
    ? fields.sessionLocal : undefined;
  const turnContextBefore = safeInteger(fields.turnContextBefore);
  const compactionBefore = safeInteger(fields.compactionBefore);
  const compactedAtMs = safeInteger(fields.compactedAtMs, { nullable: true });
  if (sessionLocal === undefined || turnContextBefore === undefined
      || compactionBefore === undefined
      || turnContextBefore > 1 || compactionBefore > 1 || compactedAtMs === undefined
      || (compactionBefore === 1) !== (compactedAtMs !== null)) return undefined;
  return Object.freeze({
    parserVersion,
    sessionLocal,
    turnContextBefore,
    compactionBefore,
    compactedAtMs,
  });
}

function normalizeRow(value) {
  const fields = dataValues(value, ROW_KEYS);
  if (fields === null) return null;
  const eventId = typeof fields.eventId === "string" && TOKEN.test(fields.eventId)
    ? fields.eventId : null;
  const eventTime = safeInstant(fields.eventTime);
  const sessionUuid = typeof fields.sessionUuid === "string" && TOKEN.test(fields.sessionUuid)
    ? fields.sessionUuid : null;
  const sessionLocal = fields.sessionLocal === null
    || (typeof fields.sessionLocal === "string" && HEX_DIGEST.test(fields.sessionLocal))
    ? fields.sessionLocal : undefined;
  const sourceLocal = fields.sourceLocal === null
    || (typeof fields.sourceLocal === "string" && HEX_DIGEST.test(fields.sourceLocal))
    ? fields.sourceLocal : undefined;
  const sourceOffset = safeInteger(fields.sourceOffset, { nullable: true });
  const sourceOrdinal = safeInteger(fields.sourceOrdinal, { nullable: true });
  const parserVersion = fields.parserVersion === null
    || (typeof fields.parserVersion === "string" && PARSER.test(fields.parserVersion))
    ? fields.parserVersion : undefined;
  const boundary = normalizeBoundary(fields.boundary);
  if (eventId === null || eventTime === null || sessionUuid === null
      || sessionLocal === undefined || sourceLocal === undefined
      || sourceOffset === undefined || sourceOrdinal === undefined
      || parserVersion === undefined || boundary === undefined) return null;
  return {
    eventId, eventTime, sessionUuid, sessionLocal, sourceLocal,
    sourceOffset, sourceOrdinal, parserVersion, boundary,
    parserFamily: parserFamily(parserVersion),
    ambiguous: false,
    boundaryFlags: null,
    tieOrder: null,
  };
}

function markGroupsAmbiguous(entries, keyFor) {
  const groups = new Map();
  for (const entry of entries) {
    const key = keyFor(entry);
    if (key === null) continue;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const entry of group) entry.ambiguous = true;
  }
}

function markConflictingGroups(entries, keyFor, valueFor) {
  const groups = new Map();
  for (const entry of entries) {
    const key = keyFor(entry);
    const value = valueFor(entry);
    if (key === null || value === null) continue;
    const group = groups.get(key) ?? { entries: [], values: new Set() };
    group.entries.push(entry);
    group.values.add(value);
    groups.set(key, group);
  }
  for (const { entries: groupEntries, values } of groups.values()) {
    if (values.size < 2) continue;
    for (const entry of groupEntries) entry.ambiguous = true;
  }
}

function orderKey(entry) {
  if (entry.sourceLocal === null || entry.sourceOffset === null
      || entry.sourceOrdinal === null) return null;
  return `${entry.sourceLocal}:${entry.sourceOffset}`;
}

function tieKey(entry) {
  return `${entry.sessionUuid}\u0000${entry.eventTime}`;
}

function deriveBoundaryFlags(entry) {
  if (entry.ambiguous || entry.parserFamily === null) return null;
  if (entry.boundary === null) return 0;
  const boundaryFamily = parserFamily(entry.boundary.parserVersion);
  if (boundaryFamily === null || boundaryFamily !== entry.parserFamily
      || entry.boundary.sessionLocal === null
      || entry.boundary.sessionLocal !== entry.sessionLocal) return null;
  return entry.boundary.turnContextBefore | (entry.boundary.compactionBefore << 1);
}

function deriveTieOrders(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = tieKey(entry);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const families = new Set(group.map((entry) => entry.parserFamily));
    const sources = new Set(group.map((entry) => entry.sourceLocal));
    const sessions = new Set(group.map((entry) => entry.sessionLocal));
    const eligible = families.size === 1 && !families.has(null)
      && sources.size === 1 && !sources.has(null)
      && sessions.size === 1 && !sessions.has(null)
      && group.every((entry) => !entry.ambiguous
        && entry.sourceOffset !== null && entry.sourceOrdinal !== null);
    if (!eligible) continue;
    const sourceOrdinal = group[0].sourceOrdinal;
    if (group.some((entry) => entry.sourceOrdinal !== sourceOrdinal)) continue;
    const ordered = [...group].sort((left, right) => (
      left.sourceOffset - right.sourceOffset || left.eventId.localeCompare(right.eventId)
    ));
    if (ordered.some((entry, index) => entry.sourceOffset === null
        || (index > 0 && entry.sourceOffset === ordered[index - 1].sourceOffset))) continue;
    ordered.forEach((entry, index) => { entry.tieOrder = index; });
  }
}

/**
 * Build the local-only continuity/order callback consumed by dormant v1.2
 * preparation. Rows are selected index facts, never source payloads. A
 * missing boundary relation is the reviewed negative (mask zero); malformed,
 * stale, conflicting or unqualified evidence stays null. Callers must set
 * boundaryLookupComplete only when the event-key boundary join completed; a
 * null boundary from an incomplete lookup is unavailable evidence, not proof
 * of mask zero.
 */
export function createTelemetryV12LocalEvidenceAdapter({
  rows,
  maxRows = MAX_LOCAL_TELEMETRY_V12_EVIDENCE_ROWS,
  boundaryLookupComplete = false,
} = {}) {
  if (!Array.isArray(rows) || !Number.isSafeInteger(maxRows)
      || maxRows < 1 || maxRows > MAX_LOCAL_TELEMETRY_V12_EVIDENCE_ROWS
      || rows.length > maxRows || typeof boundaryLookupComplete !== "boolean") {
    invalid("Local telemetry v1.2 evidence exceeds its bound");
  }
  const entries = rows.map(normalizeRow);
  if (entries.some((entry) => entry === null)) {
    invalid("Local telemetry v1.2 evidence row is invalid");
  }

  // Stable event identity and physical coordinates are both replay fences.
  // A duplicate is never resolved by input order or by choosing one payload.
  markGroupsAmbiguous(entries, (entry) => entry.eventId);
  markGroupsAmbiguous(entries, orderKey);
  markConflictingGroups(
    entries,
    (entry) => entry.sourceLocal,
    (entry) => entry.sourceOrdinal,
  );
  markConflictingGroups(
    entries,
    (entry) => entry.sourceOrdinal,
    (entry) => entry.sourceLocal,
  );
  for (const entry of entries) {
    entry.boundaryFlags = entry.boundary === null && !boundaryLookupComplete
      ? null : deriveBoundaryFlags(entry);
  }
  deriveTieOrders(entries);

  const byEventId = new Map();
  for (const entry of entries) {
    const matches = byEventId.get(entry.eventId) ?? [];
    matches.push(entry);
    byEventId.set(entry.eventId, matches);
  }
  const continuityForRecord = (stream, record) => {
    if (stream !== "usage" || !isPlainRecord(record)) return null;
    const eventId = dataField(record, "eventId");
    const eventTime = dataField(record, "eventTime");
    const sessionUuid = dataField(record, "sessionUuid");
    const matches = byEventId.get(eventId);
    if (matches === undefined || matches.length !== 1) return null;
    const [entry] = matches;
    if (entry.ambiguous || eventTime !== entry.eventTime
        || sessionUuid !== entry.sessionUuid) return null;
    return Object.freeze({
      boundaryFlags: entry.boundaryFlags,
      tieOrder: entry.tieOrder,
    });
  };
  return Object.freeze({
    continuityForRecord,
    rowCount: entries.length,
  });
}
