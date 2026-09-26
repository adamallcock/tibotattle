// Test-only typing seam for the real Node v1.2 client exercised against Worker HTTP.
import type { TelemetryV12Chunk, TelemetryV12Consent, TelemetryV12DayManifest, TelemetryV12Envelope } from "@app-usagemonitor/telemetry-contract";

export interface TelemetryV12ClientOptions {
  serverBaseUrl: string;
  deviceAuthorization: string;
  fetchImpl?: (url: URL, init: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
  clock?: () => number;
  requestTimeoutMs?: number;
}
export interface TelemetryV12SyncProgressStore {
  read(): unknown | Promise<unknown>;
  write(value: unknown): void | Promise<void>;
}
export interface TelemetryV12Publication {
  fingerprint: string;
  parserVersion: string;
}
export interface TelemetryV12SyncBaseOptions extends TelemetryV12ClientOptions {
  days: string[];
  readDay: (day: string, context: {
    binding: Readonly<{ destinationOrigin: string; enrollmentNamespace: string }>;
    activationTime: string | null;
  }) => unknown | Promise<unknown>;
  createEnvelope: (chunk: TelemetryV12Chunk) => TelemetryV12Envelope | Promise<TelemetryV12Envelope>;
  maxChunks?: number;
  maxDurationMs?: number;
  maxDays?: number;
  progressStore?: TelemetryV12SyncProgressStore | null;
  sourcePublication?: Readonly<TelemetryV12Publication> | null;
  preparePublication?: ((context: unknown) => TelemetryV12Publication | Promise<TelemetryV12Publication>) | null;
  revalidateProgress?: boolean;
}
export type TelemetryV12SyncOptions = TelemetryV12SyncBaseOptions & (
  | { consent: TelemetryV12Consent; authorization?: never }
  | { consent?: never; authorization: Readonly<{
      schemaVersion: "accountless-upload-owner-v1.2";
      policyVersion: "accountless-telemetry-v1.2-policy-v1";
      authorizationBasis: "accountless-policy-v1.2";
      telemetrySchemaVersion: "telemetry-contribution-v1.2";
    }>; laboratory?: boolean; rehearsal?: boolean; production?: boolean }
);
export interface TelemetryV12SyncRun {
  readonly schemaVersion: "incremental-contribution-sync-run-v1.0";
  readonly status: "complete" | "partial" | "failed";
  readonly daysTotal: number;
  readonly daysSynced: number;
  readonly daysPending: number;
  readonly chunksUploaded: number;
  readonly chunksSkipped: number;
  readonly recordsUploaded: number;
  readonly stagedDays: number;
  readonly acknowledgedThroughDay: string | null;
  readonly domainGenerationId: string | null;
  readonly orphanChunkIds: readonly string[];
  readonly failure: Readonly<{
    code: "admission_exhausted" | "device_unavailable" | "service_unavailable"
      | "authorization_rejected" | "upload_rejected" | "consent_rejected" | "revision_conflict"
      | "response_invalid" | "index_unavailable" | "local_index_changed" | "interrupted";
    retryable: boolean;
    deviceUnavailable: boolean;
    retryAfterMilliseconds: number | null;
  }> | null;
  readonly networkActivity: boolean;
}
export interface TelemetryV12Capabilities {
  readonly authorityKind: "social" | "accountless";
  readonly successor: Readonly<{ lifecycle: "accepted" | "staged" | "blocked"; authorizationCurrent: boolean }>;
}
export function readTelemetryV12Capabilities(options: TelemetryV12ClientOptions): Promise<TelemetryV12Capabilities>;
export function runTelemetryV12Sync(options: TelemetryV12SyncOptions): Promise<TelemetryV12SyncRun>;
export function createTelemetryV12Day(options: {
  day: string;
  parserVersion: string;
  activationTime?: string | null;
  recordsByStream: Readonly<Record<string, readonly unknown[]>>;
}): Readonly<{ manifest: TelemetryV12DayManifest; chunks: readonly TelemetryV12Chunk[] }>;
export function createTelemetryV12Envelope(options: {
  chunk: TelemetryV12Chunk;
  publicJwk: JsonWebKey;
  keyId: string;
}): Promise<TelemetryV12Envelope>;
