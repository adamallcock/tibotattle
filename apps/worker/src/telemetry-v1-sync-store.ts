import { sha256Hex } from "./content-digest";
import { ApiError } from "./errors";
import {
  TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
  type TelemetryV1Stream,
} from "./telemetry-v1";

export const MAX_TELEMETRY_V1_SYNC_STATE_CHUNKS = 100_000;
export const MAX_TELEMETRY_V1_SYNC_MANIFEST_CHUNKS = 10_000;
export const MAX_TELEMETRY_V1_SYNC_MANIFEST_RANGE_DAYS = 31;
export const TELEMETRY_V1_STEADY_STATE_CHUNKS_PER_DAY = 2_000;
export const TELEMETRY_V1_LAUNCH_WEEK_CHUNKS_PER_DAY = 20_000;
export const TELEMETRY_V1_LAUNCH_WEEK_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

/** Current-row metadata needed to construct the v1 cursor responses. */
export interface TelemetryV1SyncChunkDigest {
  chunkDay: string;
  stream: TelemetryV1Stream;
  chunkSeq: number;
  chunkDigest: string;
  revision: number;
  recordCount: number;
}

export interface TelemetryV1SyncState {
  schemaVersion: "device-sync-state-v1.0";
  contractVersion: typeof TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION;
  acknowledgedThroughDay: string | null;
  historyDigest: string | null;
  dayCount: number;
  chunkCount: number;
}

export interface TelemetryV1SyncManifest {
  schemaVersion: "device-sync-manifest-v1.0";
  contractVersion: typeof TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION;
  fromDay: string;
  toDay: string;
  days: Array<{
    day: string;
    dayDigest: string;
    chunks: Array<{
      chunkId: string;
      revision: number;
      chunkDigest: string;
      recordCount: number;
    }>;
  }>;
}

/**
 * Provider-neutral daily admission receipt returned alongside sync state.
 * The D1 and PostgreSQL adapters share this calculation so moving the read
 * path cannot silently change launch-week or steady-state limits.
 */
export interface TelemetryV1SyncAdmission {
  schemaVersion: "telemetry-chunk-admission-v1.0";
  state: "available" | "exhausted";
  windowDay: string;
  budget: "launch_week" | "steady_state";
  acceptedChunks: number;
  remainingChunks: number;
  maximumChunks: number;
  retryAt: string;
}

export interface TelemetryV1SyncAdmissionSnapshot {
  acceptedChunks: number | null;
  deviceIssuedAt: string;
}

export interface TelemetryV1SyncStore {
  state(participantId: string, deviceId: string): Promise<TelemetryV1SyncState>;
  manifest(
    participantId: string,
    deviceId: string,
    fromDay: string,
    toDay: string,
  ): Promise<TelemetryV1SyncManifest>;
  admission(
    participantId: string,
    deviceId: string,
    nowEpoch?: number,
  ): Promise<TelemetryV1SyncAdmission>;
}

/** Keep the exact UTC window boundary used by the legacy D1 repository. */
export function telemetryV1SyncAdmissionWindowDay(nowEpoch: number): string {
  if (!Number.isFinite(nowEpoch)) throw new ApiError(500, "INTERNAL_ERROR");
  try {
    return new Date(nowEpoch).toISOString().slice(0, 10);
  } catch {
    throw new ApiError(500, "INTERNAL_ERROR");
  }
}

function nextUtcMidnight(nowEpoch: number): string {
  const next = new Date(nowEpoch);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

/**
 * Build the content-free admission receipt from a provider-neutral snapshot.
 * The database adapters validate their own row types before calling this
 * helper; the arithmetic and date semantics intentionally match D1.
 */
export function buildTelemetryV1SyncAdmission(
  snapshot: TelemetryV1SyncAdmissionSnapshot,
  nowEpoch = Date.now(),
): TelemetryV1SyncAdmission {
  const windowDay = telemetryV1SyncAdmissionWindowDay(nowEpoch);
  const issuedEpoch = Date.parse(snapshot.deviceIssuedAt);
  const launchWeek = Number.isFinite(issuedEpoch)
    && nowEpoch - issuedEpoch < TELEMETRY_V1_LAUNCH_WEEK_MILLISECONDS;
  const maximumChunks = launchWeek
    ? TELEMETRY_V1_LAUNCH_WEEK_CHUNKS_PER_DAY
    : TELEMETRY_V1_STEADY_STATE_CHUNKS_PER_DAY;
  const acceptedChunks = Math.max(
    0,
    Math.min(
      TELEMETRY_V1_LAUNCH_WEEK_CHUNKS_PER_DAY,
      Number(snapshot.acceptedChunks ?? 0),
    ),
  );
  const remainingChunks = Math.max(0, maximumChunks - acceptedChunks);
  let retryAt: string;
  try {
    retryAt = nextUtcMidnight(nowEpoch);
  } catch {
    throw new ApiError(500, "INTERNAL_ERROR");
  }
  return {
    schemaVersion: "telemetry-chunk-admission-v1.0",
    state: remainingChunks > 0 ? "available" : "exhausted",
    windowDay,
    budget: launchWeek ? "launch_week" : "steady_state",
    acceptedChunks,
    remainingChunks,
    maximumChunks,
    retryAt,
  };
}

interface TelemetryV1SyncDayDigest {
  day: string;
  dayDigest: string;
  chunks: TelemetryV1SyncChunkDigest[];
}

/**
 * Shared digest construction for D1 and PostgreSQL. Adapters must supply
 * current rows in `(chunkDay, stream, chunkSeq)` order, matching the existing
 * D1 query; no provider-specific row shape crosses this boundary.
 */
async function dayDigests(
  rows: readonly TelemetryV1SyncChunkDigest[],
): Promise<TelemetryV1SyncDayDigest[]> {
  const byDay = new Map<string, TelemetryV1SyncChunkDigest[]>();
  for (const row of rows) {
    const day = byDay.get(row.chunkDay);
    if (day) day.push(row);
    else byDay.set(row.chunkDay, [row]);
  }
  const days = [...byDay.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  );
  return Promise.all(days.map(async ([day, chunks]) => ({
    day,
    dayDigest: await sha256Hex(
      chunks.map((chunk) => chunk.chunkDigest).join(""),
    ),
    chunks,
  })));
}

export async function buildTelemetryV1SyncState(
  rows: readonly TelemetryV1SyncChunkDigest[],
): Promise<TelemetryV1SyncState> {
  const days = await dayDigests(rows);
  return {
    schemaVersion: "device-sync-state-v1.0",
    contractVersion: TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
    acknowledgedThroughDay: days.at(-1)?.day ?? null,
    historyDigest: days.length === 0
      ? null
      : await sha256Hex(days.map((day) => day.dayDigest).join("")),
    dayCount: days.length,
    chunkCount: rows.length,
  };
}

export async function buildTelemetryV1SyncManifest(
  rows: readonly TelemetryV1SyncChunkDigest[],
  fromDay: string,
  toDay: string,
): Promise<TelemetryV1SyncManifest> {
  const days = await dayDigests(rows);
  return {
    schemaVersion: "device-sync-manifest-v1.0",
    contractVersion: TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
    fromDay,
    toDay,
    days: days.map((day) => ({
      day: day.day,
      dayDigest: day.dayDigest,
      chunks: day.chunks.map((chunk) => ({
        chunkId: `${chunk.stream}:${chunk.chunkDay}:${chunk.chunkSeq}`,
        revision: chunk.revision,
        chunkDigest: chunk.chunkDigest,
        recordCount: chunk.recordCount,
      })),
    })),
  };
}
