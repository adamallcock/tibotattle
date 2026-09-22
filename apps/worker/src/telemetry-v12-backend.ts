import type {
  TelemetryV12Chunk,
} from "@app-usagemonitor/telemetry-contract";
import type { TelemetryTransportPrincipal } from "./telemetry-transport-policy";

/** Application-facing hosted v1.2 transport boundary. */
export interface TelemetryV12DayCandidate {
  readonly manifestId: string;
  readonly day: string;
  readonly manifestDigest: string;
  readonly state: "staged" | "ready";
  readonly expectedChunks: number;
}

export interface TelemetryV12StagedChunkRow {
  readonly id: string;
  readonly manifestId: string;
  readonly participantId: string;
  readonly deviceId: string;
  readonly chunkId: string;
  readonly chunkDigest: string;
  readonly recordCount: number;
  /** Provider-neutral object-store identity. */
  readonly objectKey: string;
  readonly createdAt: string;
}

export interface TelemetryV12ChunkWriteMetadata {
  readonly chunkRowId: string;
  readonly objectKey: string;
  readonly envelopeDigest: string;
  readonly deviceUploadAuthorizationId: string;
  /** Exact lease returned by the one-use device upload claim. */
  readonly uploadAuthorizationLeaseExpiresAt: string;
}

export interface TelemetryV12DayCandidateQuery {
  readonly fromDay: string;
  readonly toDay: string;
  readonly limit?: number;
}

export interface TelemetryV12ReadyDayReference {
  readonly day: string;
  readonly manifestId: string;
  readonly manifestDigest: string;
}

export interface TelemetryV12DomainPredecessor {
  readonly schemaVersion: "telemetry-domain-predecessor-v1.2";
  readonly token: string;
  readonly previousGenerationId: string | null;
  readonly legacyFingerprint: string;
  readonly fromDay: string;
  readonly throughDay: string;
  readonly expiresAt: string;
}

export interface TelemetryV12DomainActivation {
  readonly schemaVersion: "telemetry-domain-activation-v1.2";
  readonly generationId: string;
  readonly manifestDigest: string;
  readonly fromDay: string;
  readonly throughDay: string;
  readonly replay: boolean;
}

export interface TelemetryV12TransportBackend {
  readonly validateChunk: (value: unknown) => Promise<TelemetryV12Chunk>;
  registerDayManifest(
    principal: TelemetryTransportPrincipal,
    value: unknown,
    nowEpoch?: number,
  ): Promise<TelemetryV12DayCandidate>;
  existingChunk(
    principal: TelemetryTransportPrincipal,
    value: unknown,
  ): Promise<TelemetryV12StagedChunkRow | null>;
  persistChunk(
    principal: TelemetryTransportPrincipal,
    value: unknown,
    metadata: TelemetryV12ChunkWriteMetadata,
    nowEpoch?: number,
  ): Promise<{
    contributionId: string;
    manifestId: string;
    chunkId: string;
    replay: boolean;
  }>;
  readDayCandidates(
    principal: TelemetryTransportPrincipal,
    options: TelemetryV12DayCandidateQuery,
  ): Promise<{ candidates: TelemetryV12DayCandidate[]; bounded: boolean }>;
  readDayChunkVector(
    principal: TelemetryTransportPrincipal,
    manifestId: string,
  ): Promise<{ chunkId: string; chunkDigest: string; recordCount: number }[]>;
  loadReadyDayVector(
    principal: TelemetryTransportPrincipal,
    vector: readonly TelemetryV12ReadyDayReference[],
  ): Promise<TelemetryV12DayCandidate[]>;
  createDomainPredecessor(
    principal: TelemetryTransportPrincipal,
    nowEpoch?: number,
  ): Promise<TelemetryV12DomainPredecessor>;
  activateDomain(
    principal: TelemetryTransportPrincipal,
    value: unknown,
    nowEpoch?: number,
  ): Promise<TelemetryV12DomainActivation>;
}
