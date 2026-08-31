import { createHash } from "node:crypto";
import {
  canonicalTelemetryV11Json,
  parseTelemetryV11Attribution,
  parseTelemetryV11Record,
  parseTelemetryV11Chunk,
  parseTelemetryV11DayManifest,
  telemetryV11DayManifestDigestInput,
  telemetryV11RecordAnchor,
  telemetryV11RequiredConsent,
  TELEMETRY_PLAN_TYPES,
  TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V11_DAY_MANIFEST_SCHEMA_VERSION,
  TELEMETRY_V11_STREAMS,
  TELEMETRY_V11_ACCOUNT_BASES,
  TELEMETRY_V11_PLAN_BASES,
  MAX_TELEMETRY_V11_CHUNK_RECORDS,
  MAX_TELEMETRY_V11_DAY_CHUNKS,
} from "@app-usagemonitor/telemetry-contract";
import {
  deriveTelemetryAccountTrackIdV2,
  deriveTelemetryPlanEraIdV1,
  UNATTRIBUTED_ACCOUNT_TRACK_ID,
} from "./account-track.js";

const RECORD_KEYS = Object.freeze({
  usage: Object.freeze(["eventId", "eventTime", "sessionUuid", "provider", "modelId", "speedMode",
    "apiServiceTier", "surface", "billingSurface", "reasoningEffort", "agentScope", "outcome",
    "totalInputContextTokens", "components"]),
  quota: Object.freeze(["observationId", "observedTime", "provider", "planType", "planVariant",
    "limitId", "slot", "usedPercent", "windowDurationMinutes", "resetsAt"]),
  session: Object.freeze(["sessionUuid", "firstEventTime", "provider", "toolClassCounts"]),
});
const RECORD_SCHEMAS = Object.freeze({
  usage: "usage-event-v1.1", quota: "quota-observation-v1.1", session: "session-dimension-v1.1",
});

const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const deepFreeze = (value) => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

/** Exact bounded fields shown for the separate successor review/consent. */
export function telemetryV11FieldInventory() {
  const inventory = {
    schemaVersion: "telemetry-field-inventory-v1.1",
    consent: telemetryV11RequiredConsent(),
    fields: {
      usage: ["schemaVersion", ...RECORD_KEYS.usage, "accountPlanAttribution"],
      quota: ["schemaVersion", ...RECORD_KEYS.quota, "accountPlanAttribution"],
      session: ["schemaVersion", ...RECORD_KEYS.session],
      accountPlanAttribution: ["accountBasis", "accountTrackId", "planBasis", "planType", "planEraId"],
    },
    accountBases: [...TELEMETRY_V11_ACCOUNT_BASES],
    planBases: [...TELEMETRY_V11_PLAN_BASES],
    nullableQuotaMeasurements: ["usedPercent", "windowDurationMinutes", "resetsAt"],
  };
  return deepFreeze({ ...inventory, inventoryDigest: hash(canonicalTelemetryV11Json(inventory)) });
}

/** Only a captured, destination/enrollment-matched binding enables identity. */
export function deriveTelemetryV11Attribution(evidence = null, {
  accountObservationSecret = null, binding = null,
} = {}) {
  const knownPlan = typeof evidence?.planType === "string"
    && evidence.planType !== "unknown" && TELEMETRY_PLAN_TYPES.includes(evidence.planType)
    && ["same_source_occurrence", "provisional_marker"].includes(evidence?.planBasis);
  const captured = evidence?.observationBinding;
  const bindingMatches = binding !== null && captured !== null && captured !== undefined
    && typeof binding.destinationOrigin === "string" && typeof binding.enrollmentNamespace === "string"
    && captured.destinationOrigin === binding.destinationOrigin
    && captured.enrollmentNamespace === binding.enrollmentNamespace;
  const canDeriveAccount = bindingMatches
    && ["same_source", "provisional_marker"].includes(evidence?.accountBasis);
  const track = canDeriveAccount ? deriveTelemetryAccountTrackIdV2({
    accountScope: evidence.accountScope,
    accountObservationSecret,
    destinationOrigin: binding.destinationOrigin,
    enrollmentNamespace: binding.enrollmentNamespace,
  }) : UNATTRIBUTED_ACCOUNT_TRACK_ID;
  const accountTrackId = track === UNATTRIBUTED_ACCOUNT_TRACK_ID ? null : track;
  const planType = knownPlan ? evidence.planType : "unknown";
  const planEraId = knownPlan && bindingMatches ? deriveTelemetryPlanEraIdV1({
    accountTrackId: track, planType, eraStartOccurrenceId: evidence.eraStartOccurrenceId ?? null,
    accountObservationSecret, destinationOrigin: binding.destinationOrigin,
    enrollmentNamespace: binding.enrollmentNamespace,
  }) : null;
  return Object.freeze(parseTelemetryV11Attribution({
    accountBasis: accountTrackId === null ? "unavailable" : evidence.accountBasis,
    accountTrackId,
    planBasis: knownPlan ? evidence.planBasis : evidence?.planBasis === "conflicted" ? "conflicted" : "unavailable",
    planType,
    planEraId,
  }));
}

export function deriveTelemetryV11QuotaOccurrenceId({ sourceRecordDigest, limitId, slot } = {}) {
  if (typeof sourceRecordDigest !== "string" || !/^[0-9a-f]{64}$/u.test(sourceRecordDigest)
      || ![limitId, slot].every((value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,64}$/u.test(value))) {
    throw new TypeError("Quota occurrence evidence is invalid");
  }
  return `quota-occurrence:v1:${hash(JSON.stringify(["telemetry-quota-occurrence-v1", sourceRecordDigest, limitId, slot]))}`;
}

/**
 * Pure closed projection. The application supplies an occurrence-aware reader;
 * this module never opens a database, auth profile, secret store or network.
 * Usage eventId/sessionUuid remain v1-compatible. Quota observationId must come
 * from an exact source occurrence, not the old lossy timestamp/slot dedupe key.
 */
export function createTelemetryV11Day({
  day, recordsByStream, attributionForRecord = () => null,
  accountObservationSecret = null, binding = null, parserVersion,
  excluded = { usage: 0, quota: 0, session: 0 },
} = {}) {
  if (!recordsByStream || typeof recordsByStream !== "object" || Array.isArray(recordsByStream)
      || typeof attributionForRecord !== "function") throw new TypeError("Telemetry day source is invalid");
  const consent = telemetryV11RequiredConsent();
  const chunks = [];
  let canonicalBytes = 0;
  for (const stream of TELEMETRY_V11_STREAMS) {
    const source = recordsByStream[stream] ?? [];
    if (!Array.isArray(source) || source.length > MAX_TELEMETRY_V11_DAY_CHUNKS * MAX_TELEMETRY_V11_CHUNK_RECORDS) {
      throw new TypeError("Telemetry day source exceeds its bound");
    }
    const records = [];
    for (const base of source) {
      const record = Object.fromEntries(RECORD_KEYS[stream].map((key) => [key, base[key]]));
      record.schemaVersion = RECORD_SCHEMAS[stream];
      if (stream !== "session") {
        const evidence = attributionForRecord(stream, base);
        // Quota source evidence already carries its event-time plan. No such
        // fallback is allowed for usage, which requires the same-record join.
        let planEvidence = evidence;
        if (stream === "quota" && TELEMETRY_PLAN_TYPES.includes(base.planType) && base.planType !== "unknown"
            && evidence?.planBasis !== "conflicted") {
          const disagrees = evidence?.planType && evidence.planType !== "unknown"
            && evidence.planType !== base.planType;
          planEvidence = { ...evidence, planBasis: disagrees ? "conflicted" : "same_source_occurrence",
            planType: disagrees ? "unknown" : base.planType };
        }
        record.accountPlanAttribution = deriveTelemetryV11Attribution(planEvidence, { accountObservationSecret, binding });
        if (stream === "quota") record.planType = record.accountPlanAttribution.planType;
      }
      // Snapshot nested components before sorting/hashing; no caller-owned
      // object can change the reviewed immutable set after this call returns.
      const canonical = canonicalTelemetryV11Json(parseTelemetryV11Record(stream, record));
      canonicalBytes += Buffer.byteLength(canonical, "utf8") + 1;
      if (canonicalBytes > 64_000_000) throw new TypeError("Telemetry day source exceeds its bound");
      records.push(JSON.parse(canonical));
    }
    records.sort((left, right) => {
      const a = telemetryV11RecordAnchor(stream, left);
      const b = telemetryV11RecordAnchor(stream, right);
      return a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1
        : a.occurrenceId < b.occurrenceId ? -1 : a.occurrenceId > b.occurrenceId ? 1 : 0;
    });
    const seen = new Set();
    for (const record of records) {
      const anchor = telemetryV11RecordAnchor(stream, record);
      if (anchor.observedAt.slice(0, 10) !== day || seen.has(anchor.occurrenceId)) {
        throw new TypeError("Telemetry day occurrence is invalid");
      }
      seen.add(anchor.occurrenceId);
    }
    for (let index = 0; index < records.length; index += MAX_TELEMETRY_V11_CHUNK_RECORDS) {
      const slice = records.slice(index, index + MAX_TELEMETRY_V11_CHUNK_RECORDS);
      const canonical = canonicalTelemetryV11Json(slice);
      if (chunks.length >= MAX_TELEMETRY_V11_DAY_CHUNKS) {
        throw new TypeError("Telemetry day source exceeds its bound");
      }
      chunks.push({
        schemaVersion: TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
        manifestDigest: "0".repeat(64), chunkId: `${stream}:${day}:${index / MAX_TELEMETRY_V11_CHUNK_RECORDS}`,
        chunkRevision: 1, chunkDigest: hash(canonical), parserVersion, consent, records: slice,
      });
    }
  }
  const manifest = {
    schemaVersion: TELEMETRY_V11_DAY_MANIFEST_SCHEMA_VERSION, day, parserVersion, consent,
    chunks: chunks.map((chunk) => ({chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: chunk.records.length})),
    excluded: { quota: excluded.quota, session: excluded.session, usage: excluded.usage },
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = hash(telemetryV11DayManifestDigestInput(manifest));
  parseTelemetryV11DayManifest(manifest);
  for (const chunk of chunks) {
    chunk.manifestDigest = manifest.manifestDigest;
    parseTelemetryV11Chunk(chunk);
  }
  return deepFreeze({ manifest, chunks });
}
