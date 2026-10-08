import {
  canonicalTelemetryV11Json,
  parseTelemetryV11Record,
  parseTelemetryV12Record,
  REVIEWED_CODEX_MODEL_IDS,
  type TelemetryV11Record,
  type TelemetryV12Record,
} from "@app-usagemonitor/telemetry-contract";
import { sha256Hex } from "./crypto";
import { parseStrictJson } from "./strict-json";
import { encodeTypedTelemetryRecord, typedTelemetryCanonicalRecords } from "./typed-telemetry-codec";
import { telemetryV11LegacyProjection } from "./telemetry-v11-compatibility";
import { telemetryV12AnalyticalProjection } from "./telemetry-v12-compatibility";

/** Classification amendments are distinct from usage-total-correction-v1. */
export const POSTGRES_CLASSIFICATION_CORRECTION_METHOD = "classification-correction-v1" as const;
export const MAX_POSTGRES_CLASSIFICATION_RECORD_BYTES = 16_384;
export type PostgresClassificationFormat = 10 | 11 | 12;
export type PostgresClassificationStream = "usage" | "session";
export type PostgresClassificationKind = "usage-model" | "usage-provider" | "usage-model-provider" | "session-provider";

export class PostgresClassificationCorrectionError extends Error {
  readonly code = "POSTGRES_CLASSIFICATION_CORRECTION_INVALID";
  constructor() { super("POSTGRES_CLASSIFICATION_CORRECTION_INVALID"); }
}

export interface PostgresClassificationCorrection {
  readonly methodVersion: typeof POSTGRES_CLASSIFICATION_CORRECTION_METHOD;
  readonly kind: PostgresClassificationKind;
  readonly beforeDigest: string;
  readonly afterDigest: string;
  readonly invariantDigest: string;
  readonly beforeRecordJson: string;
  readonly afterRecordJson: string;
}

function fail(): never { throw new PostgresClassificationCorrectionError(); }

function parsedRecord(format: PostgresClassificationFormat, stream: PostgresClassificationStream,
  input: string): Record<string, unknown> {
  if (typeof input !== "string" || new TextEncoder().encode(input).byteLength > MAX_POSTGRES_CLASSIFICATION_RECORD_BYTES) fail();
  try {
    const value = parseStrictJson(input);
    if (format === 10) {
      const fields = encodeTypedTelemetryRecord("v1", value);
      if (fields.stream !== stream) fail();
      return typedTelemetryCanonicalRecords(fields).record as unknown as Record<string, unknown>;
    }
    if (format === 11) return parseTelemetryV11Record(stream, value) as unknown as Record<string, unknown>;
    if (format === 12) return parseTelemetryV12Record(stream, value) as unknown as Record<string, unknown>;
  } catch { fail(); }
  return fail();
}

/** Pure proof only. Caller independently proves immutable storage, authority,
 * current predecessor, whole-session scope and atomic activation. */
export async function preparePostgresClassificationCorrection(input: {
  readonly beforeFormat: PostgresClassificationFormat;
  readonly afterFormat: PostgresClassificationFormat;
  readonly stream: PostgresClassificationStream;
  readonly beforeRecordJson: string;
  readonly afterRecordJson: string;
}): Promise<PostgresClassificationCorrection | null> {
  if (!input || (input.stream !== "usage" && input.stream !== "session")
      || ![10, 11, 12].includes(input.beforeFormat) || ![10, 11, 12].includes(input.afterFormat)
      || input.beforeFormat > input.afterFormat) fail();
  const before = parsedRecord(input.beforeFormat, input.stream, input.beforeRecordJson);
  const after = parsedRecord(input.afterFormat, input.stream, input.afterRecordJson);
  let comparableAfter = after;
  if (input.beforeFormat < 12 && input.afterFormat === 12) {
    comparableAfter = parsedRecord(11, input.stream,
      telemetryV12AnalyticalProjection(input.stream, after as unknown as TelemetryV12Record));
  }
  if (input.beforeFormat === 10 && input.afterFormat > 10) {
    const projection = telemetryV11LegacyProjection(input.stream, comparableAfter as unknown as TelemetryV11Record);
    if (!projection) fail();
    comparableAfter = parsedRecord(10, input.stream, projection.canonicalRecord);
  }
  const providerChanged = before.provider !== comparableAfter.provider;
  const modelChanged = input.stream === "usage" && before.modelId !== comparableAfter.modelId;
  if (providerChanged && (before.provider !== "unknown" || comparableAfter.provider !== "openai_codex")) fail();
  if (providerChanged && input.stream === "usage" && comparableAfter.modelId !== "unknown"
      && (typeof comparableAfter.modelId !== "string"
        || !(REVIEWED_CODEX_MODEL_IDS as readonly string[]).includes(comparableAfter.modelId))) fail();
  if (modelChanged && (before.modelId !== "unknown" || comparableAfter.provider !== "openai_codex"
      || typeof comparableAfter.modelId !== "string"
      || !(REVIEWED_CODEX_MODEL_IDS as readonly string[]).includes(comparableAfter.modelId))) fail();
  const frozenBefore = { ...before };
  const frozenAfter = { ...comparableAfter };
  if (providerChanged) { frozenBefore.provider = null; frozenAfter.provider = null; }
  if (modelChanged) { frozenBefore.modelId = null; frozenAfter.modelId = null; }
  const frozenJson = canonicalTelemetryV11Json(frozenBefore);
  if (frozenJson !== canonicalTelemetryV11Json(frozenAfter)) fail();
  if (!providerChanged && !modelChanged) return null;
  const kind: PostgresClassificationKind = input.stream === "session" ? "session-provider"
    : modelChanged ? providerChanged ? "usage-model-provider" : "usage-model" : "usage-provider";
  const beforeRecordJson = canonicalTelemetryV11Json(before);
  const afterRecordJson = canonicalTelemetryV11Json(after);
  const [beforeDigest, afterDigest, invariantDigest] = await Promise.all([
    sha256Hex(beforeRecordJson), sha256Hex(afterRecordJson),
    sha256Hex(canonicalTelemetryV11Json([POSTGRES_CLASSIFICATION_CORRECTION_METHOD,
      input.beforeFormat, input.afterFormat, input.stream, kind, frozenBefore])),
  ]);
  return Object.freeze({ methodVersion: POSTGRES_CLASSIFICATION_CORRECTION_METHOD, kind,
    beforeDigest, afterDigest, invariantDigest, beforeRecordJson, afterRecordJson });
}
