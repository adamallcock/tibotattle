import { createD1TelemetryV1ContributionStore } from "./d1-telemetry-v1-contribution-store";
import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import { ApiError } from "./errors";
import {
  TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V1_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V1_PRIVACY_CONTRACT_VERSION,
  type TelemetryV1Chunk,
  type TelemetryV1Record,
  type TelemetryV1Stream,
} from "./telemetry-v1";

export const TELEMETRY_V1_STEADY_STATE_CHUNKS_PER_DAY = 2_000;
export const TELEMETRY_V1_LAUNCH_WEEK_CHUNKS_PER_DAY = 20_000;
export const TELEMETRY_V1_LAUNCH_WEEK_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
// Bounded scan guards. The admission budget bounds journal growth to at most
// 2,000 current chunks per device-day in steady state; these limits exist so
// a sync read can never become an unbounded table scan.
const MAX_SYNC_STATE_CHUNKS = 100_000;
const MAX_SYNC_MANIFEST_CHUNKS = 10_000;
export const MAX_SYNC_MANIFEST_RANGE_DAYS = 31;

export interface TelemetryV1ChunkRow {
  id: string;
  participant_id: string;
  device_id: string;
  stream: TelemetryV1Stream;
  chunk_day: string;
  chunk_seq: number;
  revision: number;
  chunk_digest: string;
  envelope_digest: string;
  parser_version: string;
  record_count: number;
  accepted_record_count: number;
  r2_key: string;
  device_upload_authorization_id: string;
  superseded_at: string | null;
  quarantine_deleted_at: string | null;
  created_at: string;
}

export interface TelemetryV1ChunkAdmission {
  schemaVersion: "telemetry-chunk-admission-v1.0";
  state: "available" | "exhausted";
  windowDay: string;
  budget: "launch_week" | "steady_state";
  acceptedChunks: number;
  remainingChunks: number;
  maximumChunks: number;
  retryAt: string;
}

export function telemetryV1ChunkId(row: TelemetryV1ChunkRow): string {
  return `${row.stream}:${row.chunk_day}:${row.chunk_seq}`;
}

export async function existingTelemetryV1ChunkByEnvelopeDigest(
  db: D1Database,
  participantId: string,
  envelopeDigest: string,
): Promise<TelemetryV1ChunkRow | null> {
  return db.prepare(
    `SELECT * FROM telemetry_v1_chunks
      WHERE participant_id = ? AND envelope_digest = ?`,
  ).bind(participantId, envelopeDigest).first<TelemetryV1ChunkRow>();
}

export async function currentTelemetryV1Chunk(
  db: D1Database,
  participantId: string,
  deviceId: string,
  stream: TelemetryV1Stream,
  chunkDay: string,
  chunkSeq: number,
): Promise<TelemetryV1ChunkRow | null> {
  return db.prepare(
    `SELECT * FROM telemetry_v1_chunks
      WHERE participant_id = ? AND device_id = ? AND stream = ?
        AND chunk_day = ? AND chunk_seq = ? AND superseded_at IS NULL`,
  ).bind(participantId, deviceId, stream, chunkDay, chunkSeq)
    .first<TelemetryV1ChunkRow>();
}

export async function telemetryV1DeviceForUploadAuthorization(
  db: D1Database,
  authorizationId: string,
): Promise<string | null> {
  const row = await db.prepare(
    `SELECT issued_by_device_id FROM device_upload_authorizations
      WHERE id = ?`,
  ).bind(authorizationId).first<{ issued_by_device_id: string }>();
  return row?.issued_by_device_id ?? null;
}

function nextUtcMidnight(nowEpoch: number): string {
  const next = new Date(nowEpoch);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

/**
 * Per-device daily admission: a circuit breaker against a resend-looping
 * client or a script running up the storage bill, deliberately generous to
 * both first sync (fits inside one launch-week budget day) and steady state
 * (20-40x headroom). The D1 trigger pair enforces the same bound atomically;
 * this read exists for typed refusals and the content-free receipt.
 */
export async function telemetryV1ChunkAdmission(
  db: D1Database,
  participantId: string,
  deviceId: string,
  nowEpoch = Date.now(),
): Promise<TelemetryV1ChunkAdmission> {
  if (!Number.isFinite(nowEpoch)) throw new ApiError(500, "INTERNAL_ERROR");
  const windowDay = new Date(nowEpoch).toISOString().slice(0, 10);
  const row = await db.prepare(
    `SELECT windows.accepted_count AS accepted_count,
            device.issued_at AS device_issued_at
       FROM device_credentials device
       LEFT JOIN telemetry_v1_chunk_admission_windows windows
         ON windows.participant_id = ?
        AND windows.device_id = device.id
        AND windows.window_day = ?
      WHERE device.id = ? AND device.participant_id = ?`,
  ).bind(participantId, windowDay, deviceId, participantId).first<{
    accepted_count: number | null;
    device_issued_at: string;
  }>();
  if (!row) throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  const issuedEpoch = Date.parse(row.device_issued_at);
  const launchWeek = Number.isFinite(issuedEpoch)
    && nowEpoch - issuedEpoch < TELEMETRY_V1_LAUNCH_WEEK_MILLISECONDS;
  const maximumChunks = launchWeek
    ? TELEMETRY_V1_LAUNCH_WEEK_CHUNKS_PER_DAY
    : TELEMETRY_V1_STEADY_STATE_CHUNKS_PER_DAY;
  const acceptedChunks = Math.max(
    0,
    Math.min(
      TELEMETRY_V1_LAUNCH_WEEK_CHUNKS_PER_DAY,
      Number(row.accepted_count ?? 0),
    ),
  );
  const remainingChunks = Math.max(0, maximumChunks - acceptedChunks);
  return {
    schemaVersion: "telemetry-chunk-admission-v1.0",
    state: remainingChunks > 0 ? "available" : "exhausted",
    windowDay,
    budget: launchWeek ? "launch_week" : "steady_state",
    acceptedChunks,
    remainingChunks,
    maximumChunks,
    retryAt: nextUtcMidnight(nowEpoch),
  };
}

export function telemetryV1ChunkAdmissionError(
  admission: TelemetryV1ChunkAdmission,
  nowEpoch = Date.now(),
): ApiError {
  const retryAtEpoch = Date.parse(admission.retryAt);
  const retryAfterSeconds = Number.isFinite(retryAtEpoch)
    ? Math.max(1, Math.ceil((retryAtEpoch - nowEpoch) / 1000))
    : 1;
  return new ApiError(429, "CHUNK_ADMISSION_LIMIT_REACHED", {
    publicDetails: { admission, retryAt: admission.retryAt },
    responseHeaders: { "retry-after": String(retryAfterSeconds) },
  });
}

export async function telemetryV1ChunkContentDigest(
  records: readonly TelemetryV1Record[],
): Promise<string> {
  return sha256Hex(canonicalJson(records));
}

export interface TelemetryV1ChunkInsert {
  participantId: string;
  deviceId: string;
  deviceUploadAuthorizationId: string;
  chunkRowId: string;
  r2Key: string;
  envelopeDigest: string;
  chunk: TelemetryV1Chunk;
  supersedes: TelemetryV1ChunkRow | null;
  createdAt: string;
}

/** Compatibility entrypoint for existing D1 repository callers. */
export async function insertTelemetryV1Chunk(
  db: D1Database,
  insert: TelemetryV1ChunkInsert,
): Promise<{ acceptedRecords: number }> {
  return createD1TelemetryV1ContributionStore(db).insert({
    participantId: insert.participantId,
    deviceId: insert.deviceId,
    uploadAuthorizationId: insert.deviceUploadAuthorizationId,
    chunkId: insert.chunkRowId,
    objectKey: insert.r2Key,
    envelopeDigest: insert.envelopeDigest,
    chunk: insert.chunk,
    supersedes: insert.supersedes === null ? null : { id: insert.supersedes.id },
    createdAt: insert.createdAt,
  });
}

/**
 * The consent-once record is written by the claim of a v1.0-consented
 * pairing (a session-authorized grant) and compared on every upload — a
 * missing or diverged grant refuses the chunk; an upload can never create
 * or repair the grant itself. Divergence from the required identifiers can
 * only appear across a worker upgrade, and then the correct behavior is the
 * same as client-side drift: refuse until the person re-approves.
 */
export async function telemetryV1DeviceConsentCurrent(
  db: D1Database,
  participantId: string,
  deviceId: string,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT telemetry_schema_version, field_dictionary_version,
            privacy_contract_version
       FROM telemetry_v1_device_consents
      WHERE participant_id = ? AND device_id = ?`,
  ).bind(participantId, deviceId).first<{
    telemetry_schema_version: string;
    field_dictionary_version: string;
    privacy_contract_version: string;
  }>();
  if (!row) return false;
  return row.telemetry_schema_version === TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION
    && row.field_dictionary_version === TELEMETRY_V1_FIELD_DICTIONARY_VERSION
    && row.privacy_contract_version === TELEMETRY_V1_PRIVACY_CONTRACT_VERSION;
}

export async function telemetryV1AcknowledgedThroughDay(
  db: D1Database,
  participantId: string,
  deviceId: string,
): Promise<string | null> {
  const row = await db.prepare(
    `SELECT MAX(chunk_day) AS through_day FROM telemetry_v1_chunks
      WHERE participant_id = ? AND device_id = ? AND superseded_at IS NULL`,
  ).bind(participantId, deviceId).first<{ through_day: string | null }>();
  return row?.through_day ?? null;
}

interface CurrentChunkDigestRow {
  chunk_day: string;
  stream: TelemetryV1Stream;
  chunk_seq: number;
  chunk_digest: string;
  revision: number;
  record_count: number;
}

async function currentChunkDigests(
  db: D1Database,
  participantId: string,
  deviceId: string,
  range: { fromDay: string; toDay: string } | null,
  maximumRows: number,
): Promise<CurrentChunkDigestRow[]> {
  const rangePredicate = range ? "AND chunk_day >= ? AND chunk_day <= ?" : "";
  const bindings = range
    ? [participantId, deviceId, range.fromDay, range.toDay, maximumRows + 1]
    : [participantId, deviceId, maximumRows + 1];
  const result = await db.prepare(
    `SELECT chunk_day, stream, chunk_seq, chunk_digest, revision, record_count
       FROM telemetry_v1_chunks
      WHERE participant_id = ? AND device_id = ? AND superseded_at IS NULL
        ${rangePredicate}
      ORDER BY chunk_day ASC, stream ASC, chunk_seq ASC
      LIMIT ?`,
  ).bind(...bindings).all<CurrentChunkDigestRow>();
  if (result.results.length > maximumRows) {
    throw new ApiError(503, "LIFECYCLE_BOUNDS_EXCEEDED");
  }
  return result.results;
}

/**
 * Day digest: SHA-256 over the concatenated current chunk digests of the day
 * ordered by (stream, seq); history digest: SHA-256 over the concatenated
 * day digests ordered by day. Both sides derive these from the same
 * deterministic partition, so equality proves the accepted range matches the
 * local index without transporting any content.
 */
async function dayDigests(
  rows: readonly CurrentChunkDigestRow[],
): Promise<Array<{
  day: string;
  dayDigest: string;
  chunks: CurrentChunkDigestRow[];
}>> {
  const byDay = new Map<string, CurrentChunkDigestRow[]>();
  for (const row of rows) {
    const day = byDay.get(row.chunk_day);
    if (day) day.push(row);
    else byDay.set(row.chunk_day, [row]);
  }
  const days = [...byDay.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  );
  return Promise.all(days.map(async ([day, chunks]) => ({
    day,
    dayDigest: await sha256Hex(
      chunks.map((chunk) => chunk.chunk_digest).join(""),
    ),
    chunks,
  })));
}

export interface TelemetryV1SyncState {
  schemaVersion: "device-sync-state-v1.0";
  contractVersion: typeof TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION;
  acknowledgedThroughDay: string | null;
  historyDigest: string | null;
  dayCount: number;
  chunkCount: number;
}

export async function telemetryV1SyncState(
  db: D1Database,
  participantId: string,
  deviceId: string,
): Promise<TelemetryV1SyncState> {
  const rows = await currentChunkDigests(
    db,
    participantId,
    deviceId,
    null,
    MAX_SYNC_STATE_CHUNKS,
  );
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

export async function telemetryV1SyncManifest(
  db: D1Database,
  participantId: string,
  deviceId: string,
  fromDay: string,
  toDay: string,
): Promise<TelemetryV1SyncManifest> {
  const rows = await currentChunkDigests(
    db,
    participantId,
    deviceId,
    { fromDay, toDay },
    MAX_SYNC_MANIFEST_CHUNKS,
  );
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
        chunkId: `${chunk.stream}:${chunk.chunk_day}:${chunk.chunk_seq}`,
        revision: chunk.revision,
        chunkDigest: chunk.chunk_digest,
        recordCount: chunk.record_count,
      })),
    })),
  };
}

export async function telemetryV1ChunkCount(
  db: D1Database,
  participantId: string,
): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS total FROM telemetry_v1_chunks WHERE participant_id = ?",
  ).bind(participantId).first<{ total: number }>();
  return row?.total ?? 0;
}

export async function telemetryV1ChunkR2KeyPage(
  db: D1Database,
  participantId: string,
  cursor: { createdAt: string; chunkRowId: string } | null = null,
  limit = 100,
): Promise<{
  rows: Array<{ id: string; r2Key: string; createdAt: string }>;
  nextCursor: { createdAt: string; chunkRowId: string } | null;
}> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(500, "INTERNAL_ERROR");
  }
  const result = cursor
    ? await db.prepare(
      `SELECT id, r2_key, created_at
         FROM telemetry_v1_chunks
        WHERE participant_id = ?
          AND (created_at > ? OR (created_at = ? AND id > ?))
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
    ).bind(
      participantId,
      cursor.createdAt,
      cursor.createdAt,
      cursor.chunkRowId,
      limit,
    ).all<{ id: string; r2_key: string; created_at: string }>()
    : await db.prepare(
      `SELECT id, r2_key, created_at
         FROM telemetry_v1_chunks
        WHERE participant_id = ?
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
    ).bind(participantId, limit).all<{
      id: string;
      r2_key: string;
      created_at: string;
    }>();
  const rows = result.results.map((row) => ({
    id: row.id,
    r2Key: row.r2_key,
    createdAt: row.created_at,
  }));
  const last = rows.at(-1);
  return {
    rows,
    nextCursor: last && rows.length === limit
      ? { createdAt: last.createdAt, chunkRowId: last.id }
      : null,
  };
}
