import {
  createTelemetryV12DomainPredecessor,
  activateTelemetryV12Domain,
  existingTelemetryV12StagedChunk,
  loadTelemetryV12ReadyDayVector,
  persistTelemetryV12StagedChunk,
  readTelemetryV12DayCandidates,
  readTelemetryV12DayChunkVector,
  registerTelemetryV12DayManifest,
  validateTelemetryV12StagedChunk,
} from "./telemetry-v12-repository";
import type { TelemetryTransportPrincipal } from "./telemetry-transport-policy";
import type { TelemetryV12TransportBackend } from "./telemetry-v12-backend";

/** D1 composition for the provider-neutral v1.2 transport facade. */
export function createD1TelemetryV12Backend(db: D1Database): TelemetryV12TransportBackend {
  return {
    validateChunk: validateTelemetryV12StagedChunk,
    registerDayManifest(principal, value, nowEpoch) {
      const captured = Object.freeze({ participantId: principal.participantId, deviceId: principal.deviceId });
      return registerTelemetryV12DayManifest(db, captured, value, nowEpoch);
    },
    async existingChunk(principal, value) {
      const captured = Object.freeze({ participantId: principal.participantId, deviceId: principal.deviceId });
      const chunk = await validateTelemetryV12StagedChunk(value);
      const row = await existingTelemetryV12StagedChunk(db, captured, chunk);
      return row;
    },
    persistChunk(principal, value, metadata, nowEpoch) {
      const captured = Object.freeze({ participantId: principal.participantId, deviceId: principal.deviceId });
      const capturedMetadata = Object.freeze({
        chunkRowId: metadata.chunkRowId,
        objectKey: metadata.objectKey,
        envelopeDigest: metadata.envelopeDigest,
        deviceUploadAuthorizationId: metadata.deviceUploadAuthorizationId,
        uploadAuthorizationLeaseExpiresAt: metadata.uploadAuthorizationLeaseExpiresAt,
      });
      return persistTelemetryV12StagedChunk(db, captured, value, capturedMetadata, nowEpoch);
    },
    readDayCandidates(principal, options) {
      const captured = Object.freeze({ participantId: principal.participantId, deviceId: principal.deviceId });
      const capturedOptions = Object.freeze({ fromDay: options.fromDay, toDay: options.toDay, limit: options.limit });
      return readTelemetryV12DayCandidates(db, captured, capturedOptions);
    },
    readDayChunkVector(principal, manifestId) {
      const captured = Object.freeze({ participantId: principal.participantId, deviceId: principal.deviceId });
      return readTelemetryV12DayChunkVector(db, captured, manifestId);
    },
    loadReadyDayVector(principal, vector) {
      const captured = Object.freeze({ participantId: principal.participantId, deviceId: principal.deviceId });
      const capturedVector = vector.map((item) => ({
        day: item.day, manifestId: item.manifestId, manifestDigest: item.manifestDigest,
      }));
      return loadTelemetryV12ReadyDayVector(db, captured, capturedVector);
    },
    createDomainPredecessor(principal, nowEpoch) {
      const captured: TelemetryTransportPrincipal = Object.freeze({
        participantId: principal.participantId, deviceId: principal.deviceId,
      });
      return createTelemetryV12DomainPredecessor(db, captured, nowEpoch);
    },
    activateDomain(principal, value, nowEpoch) {
      const captured = Object.freeze({ participantId: principal.participantId, deviceId: principal.deviceId });
      return activateTelemetryV12Domain(db, captured, value, nowEpoch);
    },
  };
}
