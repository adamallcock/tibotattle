import type { TelemetryV1Chunk } from "./telemetry-v1";

/**
 * The validated, provider-neutral input to the v1 contribution transaction.
 *
 * The application has already authenticated the upload, validated the closed
 * chunk schema, checked its canonical digest and bounded record count, and
 * resolved the current predecessor before calling this store. The store is
 * still responsible for preserving the database-side authorization, consent,
 * admission, uniqueness, and trigger fences atomically with the write.
 *
 * `supersedes` is the current predecessor's opaque database identity. When it
 * is present, the input must describe the next revision of that current row;
 * this first extraction retains the application's predecessor validation.
 * The D1 graph marker checks that relationship for preservation, but absence of
 * that optional marker is not an admission refusal. This port is a trusted
 * application boundary, not a standalone untrusted-input validator.
 * Keeping only the identity avoids exposing a provider row shape here.
 */
export interface TelemetryV1ContributionWrite {
  participantId: string;
  deviceId: string;
  uploadAuthorizationId: string;
  chunkId: string;
  objectKey: string;
  envelopeDigest: string;
  chunk: TelemetryV1Chunk;
  supersedes: { id: string } | null;
  createdAt: string;
}

export interface TelemetryV1ContributionReceipt {
  acceptedRecords: number;
}

/**
 * One atomic contribution operation. Implementations must keep the chunk,
 * records, predecessor transition, graph-preservation marker, authorization
 * consumption, admission accounting, and trigger-driven projections in the
 * same transaction or equivalent durable atomic boundary.
 */
export interface TelemetryV1ContributionStore {
  insert(
    input: TelemetryV1ContributionWrite,
  ): Promise<TelemetryV1ContributionReceipt>;
}
