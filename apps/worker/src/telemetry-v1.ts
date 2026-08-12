import {
  INCREMENTAL_TELEMETRY_FIELD_DICTIONARY_VERSION,
  INCREMENTAL_TELEMETRY_SCHEMA_VERSION,
  ONGOING_INCREMENTAL_TELEMETRY_CONSENT_VERSION,
} from "./constants";
import { ApiError } from "./errors";
import { TELEMETRY_PLAN_TYPES } from "./telemetry-validation";
import type { TelemetryEnvelope } from "./telemetry-validation";

/**
 * telemetry-contribution-v1.0: incremental full-history contribution chunks
 * (docs/design/2026-08-07-incremental-contribution-model.md).
 *
 * The v1.0 contract package freeze is a parallel deliverable; until it lands,
 * this module is the worker-side closed-schema authority for the chunk
 * plaintext. Every check fails closed with a content-free typed code.
 */
export const TELEMETRY_V1_ENVELOPE_SCHEMA_VERSION = "telemetry-envelope-v1.0";
export const TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION =
  INCREMENTAL_TELEMETRY_SCHEMA_VERSION;
// Required consent identifiers (design doc section 5). Drift forces client
// re-approval by construction because equality below is exact.
export const TELEMETRY_V1_FIELD_DICTIONARY_VERSION =
  INCREMENTAL_TELEMETRY_FIELD_DICTIONARY_VERSION;
export const TELEMETRY_V1_PRIVACY_CONTRACT_VERSION =
  ONGOING_INCREMENTAL_TELEMETRY_CONSENT_VERSION;

export const MAX_TELEMETRY_V1_CHUNK_RECORDS = 200;
export const MAX_TELEMETRY_V1_CHUNK_CANONICAL_BYTES = 1_250_000;

export type TelemetryV1Stream = "usage" | "quota" | "session";

export interface TelemetryV1Consent {
  telemetrySchemaVersion: string;
  fieldDictionaryVersion: string;
  privacyContractVersion: string;
}

export interface TelemetryV1UsageEvent {
  schemaVersion: "usage-event-v1.0";
  eventId: string;
  eventTime: string;
  sessionUuid: string;
  provider: string;
  modelId: string;
  speedMode: string;
  apiServiceTier: string;
  surface: string;
  billingSurface: string;
  reasoningEffort: string;
  agentScope: string;
  outcome: string;
  totalInputContextTokens: number | null;
  components: {
    inputUncachedTokens: number | null;
    inputCacheReadTokens: number | null;
    inputCacheWriteTokens: number | null;
    outputTextTokens: number | null;
    outputReasoningTokens: number | null;
    outputCombinedTokens: number | null;
  };
}

export interface TelemetryV1QuotaObservation {
  schemaVersion: "quota-observation-v1.0";
  observationId: string;
  observedTime: string;
  provider: string;
  planType: string;
  planVariant: string;
  limitId: string;
  slot: string;
  usedPercent: number;
  windowDurationMinutes: number;
  resetsAt: string;
}

export interface TelemetryV1SessionDimension {
  schemaVersion: "session-dimension-v1.0";
  sessionUuid: string;
  firstEventTime: string;
  provider: string;
  toolClassCounts: Record<string, number>;
}

export type TelemetryV1Record =
  | TelemetryV1UsageEvent
  | TelemetryV1QuotaObservation
  | TelemetryV1SessionDimension;

export interface TelemetryV1Chunk {
  schemaVersion: typeof TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION;
  stream: TelemetryV1Stream;
  chunkDay: string;
  chunkSeq: number;
  chunkId: string;
  chunkRevision: number;
  chunkDigest: string;
  parserVersion: string;
  consent: TelemetryV1Consent;
  records: TelemetryV1Record[];
}

const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const KEY_ID = /^key:[A-Za-z0-9._-]{1,64}$/u;
const CHUNK_ID =
  /^(usage|quota|session):(\d{4}-\d{2}-\d{2}):(0|[1-9]\d{0,4})$/u;
const DIGEST_HEX = /^[0-9a-f]{64}$/u;
const BOUNDED_TOKEN = /^[A-Za-z0-9._:-]{1,64}$/u;
const OCCURRENCE_ID = /^[A-Za-z0-9._:-]{8,128}$/u;
const SESSION_UUID = /^[A-Za-z0-9._:-]{8,128}$/u;
const TOOL_CLASS_KEY = /^[a-zA-Z][A-Za-z0-9]{0,31}$/u;
const MAX_TOKEN_COMPONENT = 1_000_000_000_000;
// `provider` and `modelId` are bounded tokens rather than closed sets, like
// the seven sibling enums already are on this record. Holding a copy of the
// client's model registry here made the wire contract a second source of
// truth that drifted behind it and rejected real usage; vendors also ship new
// identities faster than a coordinated Worker deploy can admit them. Shape,
// length and character class are still enforced — an unrecognized identity is
// stored and left unpriced by server-pricing, never invented.
const PLAN_TYPES = new Set<string>(TELEMETRY_PLAN_TYPES);

function chunkInvalid(): never {
  throw new ApiError(400, "CHUNK_INVALID");
}

function exactKeys(value: unknown, keys: readonly string[]): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const present = Object.keys(value).sort();
  const expected = [...keys].sort();
  return present.length === expected.length
    && present.every((key, index) => key === expected[index]);
}

function isBase64Url(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === "string"
    && value.length >= minimum
    && value.length <= maximum
    && BASE64URL.test(value);
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function isBoundedToken(value: unknown): value is string {
  return typeof value === "string" && BOUNDED_TOKEN.test(value);
}

function isTokenComponent(value: unknown): value is number | null {
  return value === null
    || (typeof value === "number"
      && Number.isSafeInteger(value)
      && value >= 0
      && value <= MAX_TOKEN_COMPONENT);
}

function isUtcDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(epoch)
    && new Date(epoch).toISOString().slice(0, 10) === value;
}

/**
 * v1.0 chunk envelopes reuse the v0.1 envelope cryptography with a new
 * schema version, so the transport dispatcher can select the v1.0 path
 * without touching the deployed v0.1 branch. The field bounds mirror the
 * frozen v0.1 envelope contract.
 */
export function validateTelemetryV1Envelope(value: unknown): TelemetryEnvelope {
  if (
    !exactKeys(value, [
      "schemaVersion",
      "synthetic",
      "keyId",
      "wrappedKey",
      "iv",
      "ciphertext",
    ])
    || Reflect.get(value, "schemaVersion") !== TELEMETRY_V1_ENVELOPE_SCHEMA_VERSION
    || Reflect.get(value, "synthetic") !== false
    || typeof Reflect.get(value, "keyId") !== "string"
    || !KEY_ID.test(Reflect.get(value, "keyId") as string)
    || !isBase64Url(Reflect.get(value, "wrappedKey"), 342, 342)
    || !isBase64Url(Reflect.get(value, "iv"), 16, 16)
    || !isBase64Url(Reflect.get(value, "ciphertext"), 16, 2_000_000)
  ) {
    throw new ApiError(400, "ENVELOPE_INVALID");
  }
  return value as unknown as TelemetryEnvelope;
}

function parseUsageEvent(value: unknown): TelemetryV1UsageEvent {
  if (!exactKeys(value, [
    "schemaVersion", "eventId", "eventTime", "sessionUuid", "provider",
    "modelId", "speedMode", "apiServiceTier", "surface", "billingSurface",
    "reasoningEffort", "agentScope", "outcome", "totalInputContextTokens",
    "components",
  ])) chunkInvalid();
  const components = Reflect.get(value, "components");
  if (!exactKeys(components, [
    "inputUncachedTokens", "inputCacheReadTokens", "inputCacheWriteTokens",
    "outputTextTokens", "outputReasoningTokens", "outputCombinedTokens",
  ])) chunkInvalid();
  const record = value as TelemetryV1UsageEvent;
  if (record.schemaVersion !== "usage-event-v1.0"
      || typeof record.eventId !== "string"
      || !OCCURRENCE_ID.test(record.eventId)
      || !isCanonicalInstant(record.eventTime)
      || typeof record.sessionUuid !== "string"
      || !SESSION_UUID.test(record.sessionUuid)
      || !isBoundedToken(record.provider)
      || !isBoundedToken(record.modelId)
      || !isBoundedToken(record.speedMode)
      || !isBoundedToken(record.apiServiceTier)
      || !isBoundedToken(record.surface)
      || !isBoundedToken(record.billingSurface)
      || !isBoundedToken(record.reasoningEffort)
      || !isBoundedToken(record.agentScope)
      || !isBoundedToken(record.outcome)
      || !isTokenComponent(record.totalInputContextTokens)
      || !isTokenComponent(record.components.inputUncachedTokens)
      || !isTokenComponent(record.components.inputCacheReadTokens)
      || !isTokenComponent(record.components.inputCacheWriteTokens)
      || !isTokenComponent(record.components.outputTextTokens)
      || !isTokenComponent(record.components.outputReasoningTokens)
      || !isTokenComponent(record.components.outputCombinedTokens)) {
    chunkInvalid();
  }
  return record;
}

function parseQuotaObservation(value: unknown): TelemetryV1QuotaObservation {
  if (!exactKeys(value, [
    "schemaVersion", "observationId", "observedTime", "provider", "planType",
    "planVariant", "limitId", "slot", "usedPercent", "windowDurationMinutes",
    "resetsAt",
  ])) chunkInvalid();
  const record = value as TelemetryV1QuotaObservation;
  if (record.schemaVersion !== "quota-observation-v1.0"
      || typeof record.observationId !== "string"
      || !OCCURRENCE_ID.test(record.observationId)
      || !isCanonicalInstant(record.observedTime)
      || !isBoundedToken(record.provider)
      || !PLAN_TYPES.has(record.planType)
      || !isBoundedToken(record.planVariant)
      || !isBoundedToken(record.limitId)
      || !isBoundedToken(record.slot)
      || typeof record.usedPercent !== "number"
      || !Number.isFinite(record.usedPercent)
      || record.usedPercent < 0
      || record.usedPercent > 100
      || !Number.isSafeInteger(record.windowDurationMinutes)
      || record.windowDurationMinutes < 1
      || record.windowDurationMinutes > 527_040
      || !isCanonicalInstant(record.resetsAt)) {
    chunkInvalid();
  }
  return record;
}

function parseSessionDimension(value: unknown): TelemetryV1SessionDimension {
  if (!exactKeys(value, [
    "schemaVersion", "sessionUuid", "firstEventTime", "provider",
    "toolClassCounts",
  ])) chunkInvalid();
  const record = value as TelemetryV1SessionDimension;
  if (record.schemaVersion !== "session-dimension-v1.0"
      || typeof record.sessionUuid !== "string"
      || !SESSION_UUID.test(record.sessionUuid)
      || !isCanonicalInstant(record.firstEventTime)
      || !isBoundedToken(record.provider)
      || typeof record.toolClassCounts !== "object"
      || record.toolClassCounts === null
      || Array.isArray(record.toolClassCounts)) {
    chunkInvalid();
  }
  const entries = Object.entries(record.toolClassCounts);
  if (entries.length < 1 || entries.length > 32) chunkInvalid();
  for (const [key, count] of entries) {
    if (!TOOL_CLASS_KEY.test(key)
        || !Number.isSafeInteger(count)
        || count < 0
        || count > 1_000_000_000) {
      chunkInvalid();
    }
  }
  return record;
}

function recordAnchor(
  stream: TelemetryV1Stream,
  record: TelemetryV1Record,
): { occurrenceId: string; observedAt: string } {
  if (stream === "usage") {
    const usage = record as TelemetryV1UsageEvent;
    return { occurrenceId: usage.eventId, observedAt: usage.eventTime };
  }
  if (stream === "quota") {
    const quota = record as TelemetryV1QuotaObservation;
    return { occurrenceId: quota.observationId, observedAt: quota.observedTime };
  }
  const session = record as TelemetryV1SessionDimension;
  return { occurrenceId: session.sessionUuid, observedAt: session.firstEventTime };
}

export function telemetryV1RecordAnchor(
  stream: TelemetryV1Stream,
  record: TelemetryV1Record,
): { occurrenceId: string; observedAt: string } {
  return recordAnchor(stream, record);
}

/**
 * Fail-closed parse of the decrypted v1.0 chunk plaintext. The chunk is a
 * closed object; every record must belong to the chunk's stream and UTC day,
 * and occurrence ids must be unique within the chunk. Digest verification is
 * a separate step with its own typed code so a client can distinguish a
 * malformed chunk from a canonicalization drift.
 */
export function parseTelemetryV1Chunk(value: unknown): TelemetryV1Chunk {
  if (!exactKeys(value, [
    "schemaVersion", "chunkId", "chunkRevision", "chunkDigest",
    "parserVersion", "consent", "records",
  ])) chunkInvalid();
  const schemaVersion = Reflect.get(value, "schemaVersion");
  const chunkId = Reflect.get(value, "chunkId");
  const chunkRevision = Reflect.get(value, "chunkRevision");
  const chunkDigest = Reflect.get(value, "chunkDigest");
  const parserVersion = Reflect.get(value, "parserVersion");
  const consent = Reflect.get(value, "consent");
  const records = Reflect.get(value, "records");
  if (schemaVersion !== TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION
      || typeof chunkId !== "string"
      || typeof chunkDigest !== "string"
      || !DIGEST_HEX.test(chunkDigest)
      || !Number.isSafeInteger(chunkRevision)
      || (chunkRevision as number) < 1
      || (chunkRevision as number) > 1_000_000
      || typeof parserVersion !== "string"
      || !/^[A-Za-z0-9._-]{1,64}$/u.test(parserVersion)
      || !Array.isArray(records)
      || records.length < 1
      || records.length > MAX_TELEMETRY_V1_CHUNK_RECORDS) {
    chunkInvalid();
  }
  const chunkIdMatch = CHUNK_ID.exec(chunkId as string);
  if (!chunkIdMatch) chunkInvalid();
  const stream = chunkIdMatch[1] as TelemetryV1Stream;
  const chunkDay = chunkIdMatch[2]!;
  const chunkSeq = Number(chunkIdMatch[3]);
  if (!isUtcDay(chunkDay)) chunkInvalid();
  if (!exactKeys(consent, [
    "telemetrySchemaVersion", "fieldDictionaryVersion", "privacyContractVersion",
  ])
      || typeof Reflect.get(consent as object, "telemetrySchemaVersion") !== "string"
      || typeof Reflect.get(consent as object, "fieldDictionaryVersion") !== "string"
      || typeof Reflect.get(consent as object, "privacyContractVersion") !== "string") {
    chunkInvalid();
  }
  const parsedRecords: TelemetryV1Record[] = (records as unknown[]).map((row) => {
    if (stream === "usage") return parseUsageEvent(row);
    if (stream === "quota") return parseQuotaObservation(row);
    return parseSessionDimension(row);
  });
  const occurrenceIds = new Set<string>();
  for (const record of parsedRecords) {
    const anchor = recordAnchor(stream, record);
    if (anchor.observedAt.slice(0, 10) !== chunkDay) chunkInvalid();
    if (occurrenceIds.has(anchor.occurrenceId)) chunkInvalid();
    occurrenceIds.add(anchor.occurrenceId);
  }
  return {
    schemaVersion: TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
    stream,
    chunkDay,
    chunkSeq,
    chunkId: chunkId as string,
    chunkRevision: chunkRevision as number,
    chunkDigest: chunkDigest as string,
    parserVersion,
    consent: consent as TelemetryV1Consent,
    records: parsedRecords,
  };
}

/**
 * Consent-once gate: the declared consent must equal the currently required
 * v1.0 identifiers exactly. Any drift means the client-side consentCurrent
 * gate should have halted auto-upload; the server refuses rather than
 * degrades.
 */
export function assertTelemetryV1ConsentCurrent(
  consent: TelemetryV1Consent,
): void {
  if (consent.telemetrySchemaVersion !== TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION
      || consent.fieldDictionaryVersion !== TELEMETRY_V1_FIELD_DICTIONARY_VERSION
      || consent.privacyContractVersion !== TELEMETRY_V1_PRIVACY_CONTRACT_VERSION) {
    throw new ApiError(403, "TELEMETRY_CONSENT_INVALID");
  }
}
