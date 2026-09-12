import {
  canonicalTelemetryV11Json,
  parseTelemetryV11Record,
  type TelemetryV11Attribution,
  type TelemetryV11QuotaObservation,
  type TelemetryV11Record,
  type TelemetryV11SessionDimension,
  type TelemetryV11UsageEvent,
} from "@app-usagemonitor/telemetry-contract";
import {
  parseTelemetryV1Chunk,
  TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
  type TelemetryV1Record,
  type TelemetryV1Stream,
} from "./telemetry-v1";
import { telemetryV11LegacyProjection } from "./telemetry-v11-repository";

/** A storage format, not a new upload or consent contract. */
export type TypedTelemetryFormat = "v1" | "v11";
export type TypedTelemetryRecord = TelemetryV1Record | TelemetryV11Record;
export type TypedTelemetryErrorCode = "TYPED_TELEMETRY_INVALID" | "TYPED_TELEMETRY_CONFLICT"
  | "TYPED_TELEMETRY_LIMIT" | "TYPED_TELEMETRY_UNAVAILABLE";

export class TypedTelemetryError extends Error {
  constructor(readonly code: TypedTelemetryErrorCode) {
    super(code);
    this.name = "TypedTelemetryError";
  }
}

function invalid(): never { throw new TypedTelemetryError("TYPED_TELEMETRY_INVALID"); }

// Tags are a storage-version contract. Only exact lowercase forms compress;
// unfamiliar or differently cased admitted identifiers retain their UTF-8 bytes.
// They are reversible representations, never hashes or new source identities.
const ID_FORMS = [
  { prefix: "", bytes: 16, uuid: true },
  { prefix: "participant:", bytes: 16, uuid: true },
  { prefix: "device:", bytes: 16, uuid: true },
  { prefix: "v1:", bytes: 16, uuid: true },
  { prefix: "contribution:", bytes: 16, uuid: true },
  { prefix: "", bytes: 32, uuid: false },
  { prefix: "event:v2:", bytes: 32, uuid: false },
  { prefix: "quota-occurrence:v1:", bytes: 32, uuid: false },
  { prefix: "account-track:v2:", bytes: 32, uuid: false },
  { prefix: "plan-era:v1:", bytes: 32, uuid: false },
  { prefix: "chunk:", bytes: 16, uuid: true },
] as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const ID_TOKEN = /^[A-Za-z0-9._:-]{1,256}$/u;

export function encodeTypedTelemetryId(value: string): Uint8Array {
  if (typeof value !== "string" || !ID_TOKEN.test(value)) invalid();
  for (let index = 0; index < ID_FORMS.length; index += 1) {
    const form = ID_FORMS[index]!;
    if (!value.startsWith(form.prefix)) continue;
    const body = value.slice(form.prefix.length);
    if (!(form.uuid ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
      : /^[0-9a-f]{64}$/u).test(body)) continue;
    const hex = body.replaceAll("-", "");
    const bytes = new Uint8Array(form.bytes + 1);
    bytes[0] = index + 1;
    for (let offset = 0; offset < form.bytes; offset += 1) {
      bytes[offset + 1] = Number.parseInt(hex.slice(offset * 2, offset * 2 + 2), 16);
    }
    return bytes;
  }
  const raw = encoder.encode(value);
  const bytes = new Uint8Array(raw.length + 1);
  bytes.set(raw, 1);
  return bytes;
}

export function decodeTypedTelemetryId(value: Uint8Array): string {
  if (!(value instanceof Uint8Array) || value.byteLength < 2 || value.byteLength > 257) invalid();
  const tag = value[0]!;
  let result: string;
  if (tag === 0) {
    try { result = decoder.decode(value.subarray(1)); } catch { invalid(); }
  } else {
    const form = ID_FORMS[tag - 1];
    if (!form || value.byteLength !== form.bytes + 1) invalid();
    const hex = Array.from(value.subarray(1), (byte) => byte.toString(16).padStart(2, "0")).join("");
    result = form.prefix + (form.uuid
      ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
      : hex);
  }
  // Reject alternate byte spellings of the same ID, including a compressed ID
  // stored under the raw tag. Unique BLOB indexes then mean unique original IDs.
  const canonical = encodeTypedTelemetryId(result);
  if (canonical.length !== value.length || canonical.some((byte, index) => byte !== value[index])) invalid();
  return result;
}

export function typedTelemetryDayNumber(value: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) invalid();
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== value) invalid();
  return milliseconds / 86_400_000;
}

export function typedTelemetryDayString(value: number): string {
  if (!Number.isSafeInteger(value)) invalid();
  let day: string;
  try { day = new Date(value * 86_400_000).toISOString().slice(0, 10); } catch { invalid(); }
  if (typedTelemetryDayNumber(day) !== value) invalid();
  return day;
}

function instant(value: number): string {
  if (!Number.isSafeInteger(value)) invalid();
  try { return new Date(value).toISOString(); } catch { invalid(); }
}

export interface TypedTelemetryUsageFields {
  sessionId: Uint8Array;
  modelId: string;
  speedMode: string;
  apiServiceTier: string;
  surface: string;
  billingSurface: string;
  reasoningEffort: string;
  agentScope: string;
  outcome: string;
  totalInputContextTokens: number | null;
  components: TelemetryV11UsageEvent["components"];
}

export interface TypedTelemetryQuotaFields {
  planType: string;
  planVariant: string;
  limitId: string;
  slot: string;
  usedPercent: number | null;
  windowDurationMinutes: number | null;
  resetsAtMs: number | null;
}

export interface TypedTelemetryFields {
  format: TypedTelemetryFormat;
  stream: TelemetryV1Stream;
  occurrenceId: Uint8Array;
  observedAtMs: number;
  provider: string;
  attribution: TelemetryV11Attribution | null;
  usage: TypedTelemetryUsageFields | null;
  quota: TypedTelemetryQuotaFields | null;
  tools: Record<string, number> | null;
}

function parseRecord(format: TypedTelemetryFormat, stream: TelemetryV1Stream, value: unknown): TypedTelemetryRecord {
  try {
    if (format === "v11") return parseTelemetryV11Record(stream, value);
    if (format !== "v1") invalid();
    // v1's maintained public parser is chunk-shaped. Its one-record wrapper
    // validates the unchanged frozen record contract; it does not grant consent,
    // admit an upload, or invent original chunk metadata.
    if (typeof value !== "object" || value === null) invalid();
    const time = Reflect.get(value, stream === "usage" ? "eventTime" : stream === "quota" ? "observedTime" : "firstEventTime");
    if (typeof time !== "string") invalid();
    const chunk = parseTelemetryV1Chunk({
      schemaVersion: TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
      chunkId: `${stream}:${time.slice(0, 10)}:0`, chunkRevision: 1, chunkDigest: "0".repeat(64),
      parserVersion: "typed-storage-validation-v1",
      consent: { telemetrySchemaVersion: "", fieldDictionaryVersion: "", privacyContractVersion: "" },
      records: [value],
    });
    return chunk.records[0]!;
  } catch { invalid(); }
}

export function encodeTypedTelemetryRecord(format: TypedTelemetryFormat, value: unknown): TypedTelemetryFields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const schema = Reflect.get(value, "schemaVersion");
  const stream = schema === "usage-event-v1.0" || schema === "usage-event-v1.1" ? "usage"
    : schema === "quota-observation-v1.0" || schema === "quota-observation-v1.1" ? "quota"
      : schema === "session-dimension-v1.0" || schema === "session-dimension-v1.1" ? "session" : null;
  if (!stream) invalid();
  // Snapshot canonical bytes so caller mutation cannot alter an asynchronously
  // prepared batch after validation (including nested components/tool counts).
  const record = JSON.parse(canonicalTelemetryV11Json(parseRecord(format, stream, value))) as TypedTelemetryRecord;
  let occurrence: string;
  let time: string;
  let usage: TypedTelemetryUsageFields | null = null;
  let quota: TypedTelemetryQuotaFields | null = null;
  let tools: Record<string, number> | null = null;
  if (stream === "usage") {
    const row = record as TelemetryV11UsageEvent;
    occurrence = row.eventId; time = row.eventTime;
    usage = { sessionId: encodeTypedTelemetryId(row.sessionUuid), modelId: row.modelId, speedMode: row.speedMode,
      apiServiceTier: row.apiServiceTier, surface: row.surface, billingSurface: row.billingSurface,
      reasoningEffort: row.reasoningEffort, agentScope: row.agentScope, outcome: row.outcome,
      totalInputContextTokens: row.totalInputContextTokens, components: { ...row.components } };
  } else if (stream === "quota") {
    const row = record as TelemetryV11QuotaObservation;
    occurrence = row.observationId; time = row.observedTime;
    quota = { planType: row.planType, planVariant: row.planVariant, limitId: row.limitId,
      slot: row.slot, usedPercent: row.usedPercent, windowDurationMinutes: row.windowDurationMinutes,
      resetsAtMs: row.resetsAt === null ? null : Date.parse(row.resetsAt) };
  } else {
    const row = record as TelemetryV11SessionDimension;
    occurrence = row.sessionUuid; time = row.firstEventTime; tools = { ...row.toolClassCounts };
  }
  return { format, stream, occurrenceId: encodeTypedTelemetryId(occurrence), observedAtMs: Date.parse(time),
    provider: record.provider, attribution: "accountPlanAttribution" in record ? { ...record.accountPlanAttribution } : null,
    usage, quota, tools };
}

export function decodeTypedTelemetryRecord(fields: TypedTelemetryFields): TypedTelemetryRecord {
  const occurrenceId = decodeTypedTelemetryId(fields.occurrenceId);
  const time = instant(fields.observedAtMs);
  const version = fields.format === "v1" ? "1.0" : fields.format === "v11" ? "1.1" : invalid();
  const attribution = fields.format === "v11" && fields.stream !== "session"
    ? { accountPlanAttribution: fields.attribution } : {};
  if ((fields.format === "v1" || fields.stream === "session") && fields.attribution !== null) invalid();
  let value: unknown;
  if (fields.stream === "usage") {
    if (!fields.usage || fields.quota !== null || fields.tools !== null) invalid();
    const { sessionId, ...usage } = fields.usage;
    value = { schemaVersion: `usage-event-v${version}`, eventId: occurrenceId, eventTime: time,
      sessionUuid: decodeTypedTelemetryId(sessionId), provider: fields.provider, ...usage, ...attribution };
  } else if (fields.stream === "quota") {
    if (!fields.quota || fields.usage !== null || fields.tools !== null) invalid();
    const { resetsAtMs, ...quota } = fields.quota;
    value = { schemaVersion: `quota-observation-v${version}`, observationId: occurrenceId, observedTime: time,
      provider: fields.provider, ...quota, resetsAt: resetsAtMs === null ? null : instant(resetsAtMs), ...attribution };
  } else if (fields.stream === "session") {
    if (!fields.tools || fields.usage !== null || fields.quota !== null) invalid();
    value = { schemaVersion: `session-dimension-v${version}`, sessionUuid: occurrenceId,
      firstEventTime: time, provider: fields.provider, toolClassCounts: fields.tools };
  } else invalid();
  return parseRecord(fields.format, fields.stream, value);
}

export function typedTelemetryCanonicalRecords(fields: TypedTelemetryFields): {
  record: TypedTelemetryRecord;
  canonicalRecord: string;
  legacy: { occurrenceId: string; canonicalRecord: string } | null;
} {
  const record = decodeTypedTelemetryRecord(fields);
  const canonicalRecord = canonicalTelemetryV11Json(record);
  return { record, canonicalRecord, legacy: fields.format === "v11"
    ? telemetryV11LegacyProjection(fields.stream, record as TelemetryV11Record)
    : { occurrenceId: decodeTypedTelemetryId(fields.occurrenceId), canonicalRecord } };
}
