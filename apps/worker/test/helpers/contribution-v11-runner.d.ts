// Test-only typing seam for the real Node client exercised against Worker HTTP.
import type { TelemetryV11Chunk, TelemetryV11Consent, TelemetryV11Envelope } from "@app-usagemonitor/telemetry-contract";

export interface TelemetryV11Capabilities {
  readonly schemaVersion: "device-sync-capabilities-v1.1";
  readonly destinationOrigin: string;
  readonly enrollmentNamespace: string;
  readonly identityVersion: "account-track-v2";
  readonly minimumWriteRank: 1 | 2 | 10 | 11;
  readonly policyRevision: number;
  readonly requiredConsent: Readonly<TelemetryV11Consent>;
  readonly consentCurrent: boolean;
  readonly formats: readonly Readonly<{
    schemaVersion: "telemetry-contribution-v0.1" | "telemetry-contribution-v0.2"
      | "telemetry-contribution-v1.0" | "telemetry-contribution-v1.1";
    rank: 1 | 2 | 10 | 11;
    lifecycle: "accepted" | "staged" | "blocked";
  }>[];
}
export interface TelemetryV11ClientOptions {
  serverBaseUrl: string;
  deviceAuthorization: string;
  fetchImpl?: (url: URL, init: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
  clock?: () => number;
  requestTimeoutMs?: number;
}
export interface TelemetryV11SyncOptions extends TelemetryV11ClientOptions {
  consent: TelemetryV11Consent;
  days: string[];
  readDay: (day: string, context: {binding: Readonly<{destinationOrigin: string; enrollmentNamespace: string}>})
    => unknown | Promise<unknown>;
  createEnvelope: (chunk: TelemetryV11Chunk) => TelemetryV11Envelope | Promise<TelemetryV11Envelope>;
  maxChunks?: number;
  maxDurationMs?: number;
  maxDays?: number;
}
export interface TelemetryV11SyncRun {
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
export function readTelemetryV11Capabilities(options: TelemetryV11ClientOptions): Promise<TelemetryV11Capabilities>;
export function runTelemetryV11Sync(options: TelemetryV11SyncOptions): Promise<TelemetryV11SyncRun>;
