import type {
  TelemetryV11Chunk,
} from "@app-usagemonitor/telemetry-contract";
import type { TelemetryTransportPrincipal } from "./telemetry-transport-policy";

/**
 * The application-facing v1.1 transport boundary.  The route layer supplies
 * the already authenticated principal; implementations own the provider
 * transaction, transport policy recheck, replay fence, and bounded reads.
 * There is deliberately no provider row or prepared statement in this type.
 */
export interface TelemetryV11DayCandidate {
  readonly manifestId: string;
  readonly day: string;
  readonly manifestDigest: string;
  readonly state: "staged" | "ready";
  readonly expectedChunks: number;
}

export interface TelemetryV11StagedChunkRow {
  readonly id: string;
  readonly manifestId: string;
  readonly participantId: string;
  readonly deviceId: string;
  readonly chunkId: string;
  readonly chunkDigest: string;
  readonly recordCount: number;
  /** Provider-neutral object-store identity; adapters map it to r2_key. */
  readonly objectKey: string;
  readonly createdAt: string;
}

/**
 * The lease is the exact value returned by the one-use claim.  A writer must
 * pass it through unchanged; adapters must never reread a current lease as a
 * compatibility fallback.
 */
export interface TelemetryV11ChunkWriteMetadata {
  readonly chunkRowId: string;
  readonly objectKey: string;
  readonly envelopeDigest: string;
  readonly deviceUploadAuthorizationId: string;
  readonly uploadAuthorizationLeaseExpiresAt: string;
}

export interface TelemetryV11DayCandidateQuery {
  readonly fromDay: string;
  readonly toDay: string;
  readonly limit?: number;
}

export interface TelemetryV11ReadyDayReference {
  readonly day: string;
  readonly manifestId: string;
  readonly manifestDigest: string;
}

export interface TelemetryV11TransportBackend {
  registerDayManifest(
    principal: TelemetryTransportPrincipal,
    value: unknown,
    nowEpoch?: number,
  ): Promise<TelemetryV11DayCandidate>;

  existingChunk(
    principal: TelemetryTransportPrincipal,
    value: unknown,
  ): Promise<TelemetryV11StagedChunkRow | null>;

  persistChunk(
    principal: TelemetryTransportPrincipal,
    value: unknown,
    metadata: TelemetryV11ChunkWriteMetadata,
    nowEpoch?: number,
  ): Promise<{
    contributionId: string;
    manifestId: string;
    chunkId: string;
    replay: boolean;
  }>;

  readDayCandidates(
    principal: TelemetryTransportPrincipal,
    options: TelemetryV11DayCandidateQuery,
  ): Promise<{ candidates: TelemetryV11DayCandidate[]; bounded: boolean }>;

  readDayChunkVector(
    principal: TelemetryTransportPrincipal,
    manifestId: string,
  ): Promise<{ chunkId: string; chunkDigest: string; recordCount: number }[]>;

  loadReadyDayVector(
    principal: TelemetryTransportPrincipal,
    vector: readonly TelemetryV11ReadyDayReference[],
  ): Promise<TelemetryV11DayCandidate[]>;

  /** The validated chunk type is exported for composition and test helpers. */
  readonly validateChunk: (value: unknown) => Promise<TelemetryV11Chunk>;
}
