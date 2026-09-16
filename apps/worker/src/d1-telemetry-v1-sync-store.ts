import {
  readTelemetryV1SyncChunkDigests,
} from "./telemetry-v1-repository";
import { telemetryV1ChunkAdmission } from "./telemetry-v1-repository";
import {
  buildTelemetryV1SyncManifest,
  buildTelemetryV1SyncState,
  MAX_TELEMETRY_V1_SYNC_MANIFEST_CHUNKS,
  MAX_TELEMETRY_V1_SYNC_STATE_CHUNKS,
} from "./telemetry-v1-sync-store";
import type { TelemetryV1SyncStore } from "./telemetry-v1-sync-store";

/** D1 composition for the provider-neutral device sync read port. */
export function createD1TelemetryV1SyncStore(
  db: D1Database,
): TelemetryV1SyncStore {
  return {
    async state(participantId, deviceId) {
      const rows = await readTelemetryV1SyncChunkDigests(
        db,
        participantId,
        deviceId,
        null,
        MAX_TELEMETRY_V1_SYNC_STATE_CHUNKS,
      );
      return buildTelemetryV1SyncState(rows);
    },
    async manifest(participantId, deviceId, fromDay, toDay) {
      const rows = await readTelemetryV1SyncChunkDigests(
        db,
        participantId,
        deviceId,
        { fromDay, toDay },
        MAX_TELEMETRY_V1_SYNC_MANIFEST_CHUNKS,
      );
      return buildTelemetryV1SyncManifest(rows, fromDay, toDay);
    },
    admission(participantId, deviceId, nowEpoch) {
      return telemetryV1ChunkAdmission(db, participantId, deviceId, nowEpoch);
    },
  };
}
