import {
  currentTelemetryV1Chunk,
  existingTelemetryV1ChunkByEnvelopeDigest,
  telemetryV1AcknowledgedThroughDay,
  type TelemetryV1ChunkRow,
} from "./telemetry-v1-repository";
import type {
  StoredTelemetryV1Chunk,
  TelemetryV1ChunkIdentity,
  TelemetryV1ContributionReader,
} from "./telemetry-v1-contribution-reader";

function storedChunk(row: TelemetryV1ChunkRow | null): StoredTelemetryV1Chunk | null {
  if (row === null) return null;
  return {
    id: row.id,
    participantId: row.participant_id,
    deviceId: row.device_id,
    stream: row.stream,
    chunkDay: row.chunk_day,
    chunkSeq: row.chunk_seq,
    revision: row.revision,
    chunkDigest: row.chunk_digest,
    recordCount: row.record_count,
    acceptedRecords: row.accepted_record_count,
    supersededAt: row.superseded_at,
  };
}

/** D1 composition for the provider-neutral telemetry v1 read port. */
export function createD1TelemetryV1ContributionReader(
  db: D1Database,
): TelemetryV1ContributionReader {
  return {
    async byEnvelope(participantId, envelopeDigest) {
      return storedChunk(await existingTelemetryV1ChunkByEnvelopeDigest(
        db,
        participantId,
        envelopeDigest,
      ));
    },
    async current(identity: TelemetryV1ChunkIdentity) {
      return storedChunk(await currentTelemetryV1Chunk(
        db,
        identity.participantId,
        identity.deviceId,
        identity.stream,
        identity.chunkDay,
        identity.chunkSeq,
      ));
    },
    acknowledgedThroughDay(participantId, deviceId) {
      return telemetryV1AcknowledgedThroughDay(db, participantId, deviceId);
    },
  };
}
