import type { TelemetryV1Stream } from "./telemetry-v1";

/**
 * Provider-neutral current or replayable v1 contribution metadata. The read
 * port intentionally exposes no D1/R2 column names or provider row shape.
 */
export interface StoredTelemetryV1Chunk {
  id: string;
  participantId: string;
  deviceId: string;
  stream: TelemetryV1Stream;
  chunkDay: string;
  chunkSeq: number;
  revision: number;
  chunkDigest: string;
  recordCount: number;
  acceptedRecords: number;
  supersededAt: string | null;
}

export interface TelemetryV1ChunkIdentity {
  participantId: string;
  deviceId: string;
  stream: TelemetryV1Stream;
  chunkDay: string;
  chunkSeq: number;
}

export interface TelemetryV1ContributionReader {
  byEnvelope(
    participantId: string,
    envelopeDigest: string,
  ): Promise<StoredTelemetryV1Chunk | null>;
  current(
    identity: TelemetryV1ChunkIdentity,
  ): Promise<StoredTelemetryV1Chunk | null>;
  acknowledgedThroughDay(
    participantId: string,
    deviceId: string,
  ): Promise<string | null>;
}

export interface TelemetryV1ReplayReceipt {
  schemaVersion: "telemetry-chunk-receipt-v1.0";
  contributionId: string;
  chunkId: string;
  chunkRevision: number;
  status: "accepted" | "superseded";
  replayed: true;
  recordCounts: {
    declared: number;
    accepted: number;
  };
  acknowledgedThroughDay: string | null;
}

/**
 * Recover a write outcome by its participant-wide envelope identity before
 * falling back to the current identity. A correction can supersede a
 * committed row between COMMIT and this lookup, so current-only recovery could
 * mistake a historical row for an absent write and delete its retained object.
 * Reader failures propagate; callers must not treat an indeterminate read as
 * proof that cleanup is safe.
 */
export async function resolveTelemetryV1Replay(
  reader: TelemetryV1ContributionReader,
  envelopeDigest: string,
  identity: TelemetryV1ChunkIdentity,
  chunkDigest: string,
): Promise<StoredTelemetryV1Chunk | null> {
  const byEnvelope = await reader.byEnvelope(identity.participantId, envelopeDigest);
  if (byEnvelope !== null) return byEnvelope;
  const current = await reader.current(identity);
  return current !== null && current.chunkDigest === chunkDigest ? current : null;
}

/** Build the provider-neutral body shared by D1 and qualification readers. */
export async function buildTelemetryV1ReplayReceipt(
  reader: TelemetryV1ContributionReader,
  row: StoredTelemetryV1Chunk,
  deviceId: string,
): Promise<TelemetryV1ReplayReceipt> {
  const acknowledgedThroughDay = await reader.acknowledgedThroughDay(
    row.participantId,
    deviceId,
  );
  return {
    schemaVersion: "telemetry-chunk-receipt-v1.0",
    contributionId: row.id,
    chunkId: `${row.stream}:${row.chunkDay}:${row.chunkSeq}`,
    chunkRevision: row.revision,
    status: row.supersededAt === null ? "accepted" : "superseded",
    replayed: true,
    recordCounts: {
      declared: row.recordCount,
      accepted: row.acceptedRecords,
    },
    acknowledgedThroughDay,
  };
}
