import {
  canonicalTelemetryV12Json,
  parseTelemetryV12Record,
  type TelemetryPlanType,
  type TelemetryV12Attribution,
  type TelemetryV12Record,
  type TelemetryV12Stream,
  type TelemetryV12UsageEvent,
} from "@app-usagemonitor/telemetry-contract";
import { decodeTypedTelemetryId, encodeTypedTelemetryId, typedTelemetryDayNumber } from "./typed-telemetry-codec";
import { TypedTelemetryError } from "./typed-telemetry-codec";

const ACCOUNT_BASES = ["unavailable", "same_source", "provisional_marker"] as const;
const PLAN_BASES = ["unavailable", "same_source_occurrence", "provisional_marker", "conflicted"] as const;
const encoder = new TextEncoder();
export type TelemetryV12Blob = ArrayBuffer | Uint8Array | readonly number[];

export interface TelemetryV12TypedAttribution {
  accountBasis: number;
  accountTrack: ArrayBuffer;
  planBasis: number;
  planType: string;
  planEra: ArrayBuffer;
}

export interface TelemetryV12TypedUsage {
  sessionId: ArrayBuffer;
  model: string;
  speedMode: string;
  apiServiceTier: string;
  surface: string;
  billingSurface: string;
  reasoningEffort: string;
  agentScope: string;
  outcome: string;
  attribution: TelemetryV12TypedAttribution;
  totalInputContextTokens: number | null;
  inputUncachedTokens: number | null;
  inputCacheReadTokens: number | null;
  inputCacheWriteTokens: number | null;
  outputTextTokens: number | null;
  outputReasoningTokens: number | null;
  outputCombinedTokens: number | null;
  boundaryFlags: number | null;
  tieOrder: number | null;
  cacheWriteTtlFiveMinuteTokens: number | null;
  cacheWriteTtlOneHourTokens: number | null;
}

export interface TelemetryV12TypedQuota {
  planType: string;
  planVariant: string;
  limitId: string;
  slot: string;
  usedPercent: number | null;
  windowDurationMinutes: number | null;
  resetsAtMs: number | null;
  attribution: TelemetryV12TypedAttribution;
}

export interface TelemetryV12TypedRecordFields {
  stream: TelemetryV12Stream;
  occurrenceId: ArrayBuffer;
  observedAtMs: number;
  observedDay: number;
  provider: string;
  canonicalRecord: string;
  canonicalDigest: ArrayBuffer;
  usage: TelemetryV12TypedUsage | null;
  quota: TelemetryV12TypedQuota | null;
  tools: Record<string, number> | null;
}

export interface TelemetryV12TypedRecordRow {
  stream: TelemetryV12Stream;
  occurrence_id: TelemetryV12Blob;
  observed_at_ms: number;
  observed_day: number;
  provider: string;
  canonical_digest: TelemetryV12Blob;
  session_id?: TelemetryV12Blob | null;
  model?: string | null;
  speed_mode?: string | null;
  api_service_tier?: string | null;
  surface?: string | null;
  billing_surface?: string | null;
  reasoning_effort?: string | null;
  agent_scope?: string | null;
  outcome?: string | null;
  total_input_context_tokens?: number | null;
  input_uncached_tokens?: number | null;
  input_cache_read_tokens?: number | null;
  input_cache_write_tokens?: number | null;
  output_text_tokens?: number | null;
  output_reasoning_tokens?: number | null;
  output_combined_tokens?: number | null;
  boundary_flags?: number | null;
  tie_order?: number | null;
  cache_write_ttl_five_minute_tokens?: number | null;
  cache_write_ttl_one_hour_tokens?: number | null;
  plan_type?: string | null;
  plan_variant?: string | null;
  limit_id?: string | null;
  slot?: string | null;
  used_percent?: number | null;
  window_duration_minutes?: number | null;
  resets_at_ms?: number | null;
  account_basis?: number | null;
  account_track?: TelemetryV12Blob | null;
  plan_basis?: number | null;
  attribution_plan_type?: string | null;
  plan_era?: TelemetryV12Blob | null;
}

function invalid(): never {
  throw new TypedTelemetryError("TYPED_TELEMETRY_INVALID");
}

function bytes(value: TelemetryV12Blob | null | undefined): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return Uint8Array.from(value);
  }
  invalid();
}

function copyBytes(value: TelemetryV12Blob | null | undefined): ArrayBuffer {
  return Uint8Array.from(bytes(value)).buffer;
}

function blob(value: string | null): ArrayBuffer {
  return Uint8Array.from(value === null ? [] : encodeTypedTelemetryId(value)).buffer;
}

function requiredString(value: string | null | undefined): string {
  if (typeof value !== "string") invalid();
  return value;
}

function nullableNumber(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value)) invalid();
  return value;
}

function instant(ms: number): string {
  if (!Number.isSafeInteger(ms)) invalid();
  let value: string;
  try { value = new Date(ms).toISOString(); } catch { invalid(); }
  return value;
}

function attribution(value: TelemetryV12Attribution): TelemetryV12TypedAttribution {
  return {
    accountBasis: ACCOUNT_BASES.indexOf(value.accountBasis),
    accountTrack: blob(value.accountTrackId),
    planBasis: PLAN_BASES.indexOf(value.planBasis),
    planType: value.planType,
    planEra: blob(value.planEraId),
  };
}

function encodeRecord(stream: TelemetryV12Stream, value: unknown): TelemetryV12TypedRecordFields {
  const record = parseTelemetryV12Record(stream, JSON.parse(canonicalTelemetryV12Json(value))) as TelemetryV12Record;
  let occurrence: string;
  let observed: string;
  if (stream === "usage") {
    const row = record as TelemetryV12UsageEvent;
    occurrence = row.eventId; observed = row.eventTime;
  } else if (stream === "quota") {
    const row = record as Extract<TelemetryV12Record, {schemaVersion: "quota-observation-v1.2"}>;
    occurrence = row.observationId; observed = row.observedTime;
  } else {
    const row = record as Extract<TelemetryV12Record, {schemaVersion: "session-dimension-v1.2"}>;
    occurrence = row.sessionUuid; observed = row.firstEventTime;
  }
  const base = {
    stream,
    occurrenceId: blob(occurrence),
    observedAtMs: Date.parse(observed),
    observedDay: typedTelemetryDayNumber(observed.slice(0, 10)),
    provider: record.provider,
    canonicalRecord: canonicalTelemetryV12Json(record),
    canonicalDigest: new ArrayBuffer(0),
    usage: null,
    quota: null,
    tools: null,
  } as TelemetryV12TypedRecordFields;
  if (!Number.isSafeInteger(base.observedAtMs)) invalid();
  if (stream === "usage") {
    const row = record as TelemetryV12UsageEvent;
    base.usage = {
      sessionId: blob(row.sessionUuid), model: row.modelId, speedMode: row.speedMode,
      apiServiceTier: row.apiServiceTier, surface: row.surface, billingSurface: row.billingSurface,
      reasoningEffort: row.reasoningEffort, agentScope: row.agentScope, outcome: row.outcome,
      attribution: attribution(row.accountPlanAttribution),
      totalInputContextTokens: row.totalInputContextTokens,
      inputUncachedTokens: row.components.inputUncachedTokens,
      inputCacheReadTokens: row.components.inputCacheReadTokens,
      inputCacheWriteTokens: row.components.inputCacheWriteTokens,
      outputTextTokens: row.components.outputTextTokens,
      outputReasoningTokens: row.components.outputReasoningTokens,
      outputCombinedTokens: row.components.outputCombinedTokens,
      boundaryFlags: row.boundaryFlags, tieOrder: row.tieOrder,
      cacheWriteTtlFiveMinuteTokens: row.cacheWriteTtl?.fiveMinuteTokens ?? null,
      cacheWriteTtlOneHourTokens: row.cacheWriteTtl?.oneHourTokens ?? null,
    };
  } else if (stream === "quota") {
    const row = record as Extract<TelemetryV12Record, {schemaVersion: "quota-observation-v1.2"}>;
    base.quota = {
      planType: row.planType, planVariant: row.planVariant, limitId: row.limitId, slot: row.slot,
      usedPercent: row.usedPercent, windowDurationMinutes: row.windowDurationMinutes,
      resetsAtMs: row.resetsAt === null ? null : Date.parse(row.resetsAt),
      attribution: attribution(row.accountPlanAttribution),
    };
  } else {
    const row = record as Extract<TelemetryV12Record, {schemaVersion: "session-dimension-v1.2"}>;
    base.tools = { ...row.toolClassCounts };
  }
  return base;
}

export async function encodeTelemetryV12Record(
  stream: TelemetryV12Stream,
  value: unknown,
  digest: (canonical: string) => Promise<Uint8Array>,
): Promise<TelemetryV12TypedRecordFields> {
  const fields = encodeRecord(stream, value);
  fields.canonicalDigest = Uint8Array.from(await digest(fields.canonicalRecord)).buffer;
  return fields;
}

function decodeAttribution(row: TelemetryV12TypedRecordRow): TelemetryV12Attribution {
  const accountBasis = row.account_basis === null || row.account_basis === undefined
    ? undefined : ACCOUNT_BASES[row.account_basis];
  const planBasis = row.plan_basis === null || row.plan_basis === undefined
    ? undefined : PLAN_BASES[row.plan_basis];
  const planType = row.attribution_plan_type;
  if (!accountBasis || !planBasis || typeof planType !== "string") invalid();
  const accountTrack = bytes(row.account_track);
  const planEra = bytes(row.plan_era);
  return {
    accountBasis,
    accountTrackId: accountTrack.length === 0 ? null : decodeTypedTelemetryId(accountTrack),
    planBasis,
    planType: planType as TelemetryPlanType,
    planEraId: planEra.length === 0 ? null : decodeTypedTelemetryId(planEra),
  };
}

export function decodeTelemetryV12Record(
  row: TelemetryV12TypedRecordRow,
  tools: Record<string, number> | null = null,
): TelemetryV12TypedRecordFields {
  const occurrence = decodeTypedTelemetryId(bytes(row.occurrence_id));
  const observed = instant(row.observed_at_ms);
  const fields: TelemetryV12TypedRecordFields = {
    stream: row.stream, occurrenceId: copyBytes(row.occurrence_id),
    observedAtMs: row.observed_at_ms, observedDay: row.observed_day, provider: requiredString(row.provider),
    canonicalRecord: "", canonicalDigest: copyBytes(row.canonical_digest), usage: null, quota: null, tools,
  };
  if (row.stream === "usage") {
    const usage = {
      schemaVersion: "usage-event-v1.2" as const, eventId: occurrence, eventTime: observed,
      sessionUuid: decodeTypedTelemetryId(bytes(row.session_id)), provider: fields.provider,
      modelId: requiredString(row.model), speedMode: requiredString(row.speed_mode),
      apiServiceTier: requiredString(row.api_service_tier), surface: requiredString(row.surface),
      billingSurface: requiredString(row.billing_surface), reasoningEffort: requiredString(row.reasoning_effort),
      agentScope: requiredString(row.agent_scope), outcome: requiredString(row.outcome),
      totalInputContextTokens: nullableNumber(row.total_input_context_tokens),
      components: {
        inputUncachedTokens: nullableNumber(row.input_uncached_tokens),
        inputCacheReadTokens: nullableNumber(row.input_cache_read_tokens),
        inputCacheWriteTokens: nullableNumber(row.input_cache_write_tokens),
        outputTextTokens: nullableNumber(row.output_text_tokens),
        outputReasoningTokens: nullableNumber(row.output_reasoning_tokens),
        outputCombinedTokens: nullableNumber(row.output_combined_tokens),
      },
      accountPlanAttribution: decodeAttribution(row),
      boundaryFlags: nullableNumber(row.boundary_flags) as TelemetryV12UsageEvent["boundaryFlags"],
      tieOrder: nullableNumber(row.tie_order),
      cacheWriteTtl: row.cache_write_ttl_five_minute_tokens === null
        || row.cache_write_ttl_five_minute_tokens === undefined ? null : {
          fiveMinuteTokens: row.cache_write_ttl_five_minute_tokens,
          oneHourTokens: requiredNumber(row.cache_write_ttl_one_hour_tokens),
        },
    };
    fields.usage = {
      sessionId: copyBytes(row.session_id), model: usage.modelId, speedMode: usage.speedMode,
      apiServiceTier: usage.apiServiceTier, surface: usage.surface, billingSurface: usage.billingSurface,
      reasoningEffort: usage.reasoningEffort, agentScope: usage.agentScope, outcome: usage.outcome,
      attribution: attribution(usage.accountPlanAttribution), totalInputContextTokens: usage.totalInputContextTokens,
      inputUncachedTokens: usage.components.inputUncachedTokens, inputCacheReadTokens: usage.components.inputCacheReadTokens,
      inputCacheWriteTokens: usage.components.inputCacheWriteTokens, outputTextTokens: usage.components.outputTextTokens,
      outputReasoningTokens: usage.components.outputReasoningTokens, outputCombinedTokens: usage.components.outputCombinedTokens,
      boundaryFlags: usage.boundaryFlags, tieOrder: usage.tieOrder,
      cacheWriteTtlFiveMinuteTokens: usage.cacheWriteTtl?.fiveMinuteTokens ?? null,
      cacheWriteTtlOneHourTokens: usage.cacheWriteTtl?.oneHourTokens ?? null,
    };
    parseTelemetryV12Record("usage", usage);
    fields.canonicalRecord = canonicalTelemetryV12Json(usage);
  } else if (row.stream === "quota") {
    const quota = {
      schemaVersion: "quota-observation-v1.2" as const, observationId: occurrence, observedTime: observed,
      provider: fields.provider, planType: requiredString(row.plan_type) as TelemetryPlanType,
      planVariant: requiredString(row.plan_variant), limitId: requiredString(row.limit_id), slot: requiredString(row.slot),
      usedPercent: row.used_percent ?? null, windowDurationMinutes: row.window_duration_minutes ?? null,
      resetsAt: row.resets_at_ms === null || row.resets_at_ms === undefined ? null : instant(row.resets_at_ms),
      accountPlanAttribution: decodeAttribution(row),
    };
    parseTelemetryV12Record("quota", quota);
    fields.quota = {
      planType: quota.planType, planVariant: quota.planVariant, limitId: quota.limitId, slot: quota.slot,
      usedPercent: quota.usedPercent, windowDurationMinutes: quota.windowDurationMinutes,
      resetsAtMs: row.resets_at_ms ?? null, attribution: attribution(quota.accountPlanAttribution),
    };
    fields.canonicalRecord = canonicalTelemetryV12Json(quota);
  } else {
    const session = {
      schemaVersion: "session-dimension-v1.2" as const, sessionUuid: occurrence, firstEventTime: observed,
      provider: fields.provider, toolClassCounts: tools ?? {},
    };
    parseTelemetryV12Record("session", session);
    fields.tools = { ...session.toolClassCounts };
    fields.canonicalRecord = canonicalTelemetryV12Json(session);
  }
  return fields;
}

function requiredNumber(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isSafeInteger(value)) invalid();
  return value;
}

export function typedTelemetryV12DictionaryLookup(value: string): { sql: string; values: (string | ArrayBuffer)[] } {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) invalid();
  return { sql: "(SELECT id FROM typed_telemetry_dictionary WHERE value = ?)", values: [value] };
}

export function typedTelemetryV12Id(value: string): ArrayBuffer {
  return blob(value);
}

export function telemetryV12DayNumber(value: string): number {
  return typedTelemetryDayNumber(value);
}

export function telemetryV12CanonicalBytes(value: unknown): number {
  return encoder.encode(canonicalTelemetryV12Json(value)).byteLength;
}
