import {
  MAX_TELEMETRY_V12_CHUNK_RECORDS,
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
} from "@app-usagemonitor/telemetry-contract";
import { ApiError } from "./errors";
import {
  decodeTelemetryV12Record,
  persistTelemetryV12StagedChunk,
  registerTelemetryV12DayManifest,
  validateTelemetryV12StagedChunk,
  type TelemetryV12DayCandidate,
  type TelemetryV12StagedChunkRow,
} from "./telemetry-v12-repository";
import type { TelemetryTransportPrincipal } from "./telemetry-transport-policy";

/** Metadata retained by the v1.2 typed source journal. */
export interface TypedV12ChunkMetadata {
  chunkRowId: string;
  r2Key: string;
  envelopeDigest: string;
  deviceUploadAuthorizationId: string;
}

export interface TypedV12StagedChunkResult {
  contributionId: string;
  manifestId: string;
  chunkId: string;
  replay: boolean;
}

/**
 * The v1.2 source journal is independently qualified from the v1/v1.1 typed
 * allocators.  This guard makes a missing or mismatched forward-only runtime
 * fail closed before the first write, while keeping the legacy storage mode
 * untouched.
 */
export async function initializeTypedV12Admission(db: D1Database): Promise<void> {
  const runtime = await db.prepare(
    `SELECT schema_version, envelope_schema_version, field_dictionary_version,
            privacy_contract_version, state, max_chunk_records
       FROM telemetry_v12_runtime WHERE id = 1`,
  ).first<{
    schema_version: string; envelope_schema_version: string; field_dictionary_version: string;
    privacy_contract_version: string; state: "staged" | "active"; max_chunk_records: number;
  }>();
  if (!runtime
      || runtime.schema_version !== TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION
      || runtime.envelope_schema_version !== "telemetry-envelope-v1.2"
      || runtime.field_dictionary_version !== TELEMETRY_V12_FIELD_DICTIONARY_VERSION
      || runtime.privacy_contract_version !== TELEMETRY_V12_PRIVACY_CONTRACT_VERSION
      || runtime.max_chunk_records !== MAX_TELEMETRY_V12_CHUNK_RECORDS) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
}

export async function persistTypedV12StagedChunk(
  db: D1Database,
  principal: TelemetryTransportPrincipal,
  value: unknown,
  metadata: TypedV12ChunkMetadata,
  nowEpoch = Date.now(),
): Promise<TypedV12StagedChunkResult> {
  if (typeof metadata.chunkRowId !== "string" || !/^chunk:[0-9a-f-]{36}$/u.test(metadata.chunkRowId)
      || typeof metadata.r2Key !== "string" || metadata.r2Key.length < 1 || metadata.r2Key.length > 1024
      || !/^[0-9a-f]{64}$/u.test(metadata.envelopeDigest)
      || typeof metadata.deviceUploadAuthorizationId !== "string"
      || metadata.deviceUploadAuthorizationId.length < 1 || metadata.deviceUploadAuthorizationId.length > 256) {
    throw new ApiError(400, "CHUNK_INVALID");
  }
  return persistTelemetryV12StagedChunk(db, principal, value, metadata, nowEpoch);
}

export {
  decodeTelemetryV12Record,
  registerTelemetryV12DayManifest,
  validateTelemetryV12StagedChunk,
};
export type {
  TelemetryV12DayCandidate,
  TelemetryV12StagedChunkRow,
  TelemetryV12TypedAttribution,
  TelemetryV12Blob,
  TelemetryV12TypedQuota,
  TelemetryV12TypedRecordFields,
  TelemetryV12TypedRecordRow,
  TelemetryV12TypedUsage,
} from "./telemetry-v12-repository";
