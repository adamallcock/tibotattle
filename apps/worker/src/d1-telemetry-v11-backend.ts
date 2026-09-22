import {
  existingTelemetryV11StagedChunk,
  persistTelemetryV11StagedChunk,
  readTelemetryV11DayCandidates,
  readTelemetryV11DayChunkVector,
  loadTelemetryV11ReadyDayVector,
  registerTelemetryV11DayManifest,
  validateTelemetryV11StagedChunk,
} from "./telemetry-v11-repository";
import type { TelemetryTransportPrincipal } from "./telemetry-transport-policy";
import type {
  TelemetryV11TransportBackend,
  TelemetryV11ChunkWriteMetadata,
} from "./telemetry-v11-backend";

/** D1 composition for the provider-neutral v1.1 route facade. */
export function createD1TelemetryV11Backend(db: D1Database): TelemetryV11TransportBackend {
  return {
    validateChunk: validateTelemetryV11StagedChunk,
    registerDayManifest(
      principal: TelemetryTransportPrincipal,
      value: unknown,
      nowEpoch?: number,
    ) {
      const captured = Object.freeze({ participantId: principal.participantId, deviceId: principal.deviceId });
      return registerTelemetryV11DayManifest(db, captured, value, nowEpoch);
    },
    async existingChunk(principal, value) {
      const captured = Object.freeze({ participantId: principal.participantId, deviceId: principal.deviceId });
      const chunk = await validateTelemetryV11StagedChunk(value);
      const row = await existingTelemetryV11StagedChunk(db, captured, chunk);
      return row === null ? null : {
        id: row.id,
        manifestId: row.manifest_id,
        participantId: row.participant_id,
        deviceId: row.device_id,
        chunkId: row.chunk_id,
        chunkDigest: row.chunk_digest,
        recordCount: row.record_count,
        objectKey: row.r2_key,
        createdAt: row.created_at,
      };
    },
    persistChunk(
      principal: TelemetryTransportPrincipal,
      value: unknown,
      metadata: TelemetryV11ChunkWriteMetadata,
      nowEpoch?: number,
    ) {
      const captured = Object.freeze({ participantId: principal.participantId, deviceId: principal.deviceId });
      const capturedMetadata = Object.freeze({
        chunkRowId: metadata.chunkRowId,
        objectKey: metadata.objectKey,
        envelopeDigest: metadata.envelopeDigest,
        deviceUploadAuthorizationId: metadata.deviceUploadAuthorizationId,
        uploadAuthorizationLeaseExpiresAt: metadata.uploadAuthorizationLeaseExpiresAt,
      });
      return persistTelemetryV11StagedChunk(db, captured, value, {
        ...capturedMetadata,
        r2Key: capturedMetadata.objectKey,
      }, nowEpoch);
    },
    readDayCandidates(principal, options) {
      const captured = Object.freeze({ participantId: principal.participantId, deviceId: principal.deviceId });
      const capturedOptions = Object.freeze({ fromDay: options.fromDay, toDay: options.toDay, limit: options.limit });
      return readTelemetryV11DayCandidates(db, captured, capturedOptions);
    },
    readDayChunkVector(principal, manifestId) {
      const captured = Object.freeze({ participantId: principal.participantId, deviceId: principal.deviceId });
      return readTelemetryV11DayChunkVector(db, captured, manifestId);
    },
    loadReadyDayVector(principal, vector) {
      const captured = Object.freeze({ participantId: principal.participantId, deviceId: principal.deviceId });
      const capturedVector = vector.map((item) => ({
        day: item.day, manifestId: item.manifestId, manifestDigest: item.manifestDigest,
      }));
      return loadTelemetryV11ReadyDayVector(db, captured, capturedVector);
    },
  };
}
