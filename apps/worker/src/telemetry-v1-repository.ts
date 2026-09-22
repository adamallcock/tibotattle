import {
  createD1TelemetryV1ContributionStore,
  prepareD1TelemetryV1ChunkWrite,
  type D1TelemetryV1PreparedRecords,
} from "./d1-telemetry-v1-contribution-store";
import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import { ApiError } from "./errors";
import {
  snapshotTelemetryCorrectionWriteOperation,
  type TelemetryCorrectionWriteOperation,
} from "./telemetry-correction-ports";
import {
  TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V1_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V1_PRIVACY_CONTRACT_VERSION,
  type TelemetryV1Chunk,
  type TelemetryV1Record,
  type TelemetryV1Stream,
} from "./telemetry-v1";
import {
  buildTelemetryV1SyncAdmission,
  buildTelemetryV1SyncManifest,
  buildTelemetryV1SyncState,
  TELEMETRY_V1_LAUNCH_WEEK_CHUNKS_PER_DAY as SYNC_LAUNCH_WEEK_CHUNKS_PER_DAY,
  TELEMETRY_V1_LAUNCH_WEEK_MILLISECONDS as SYNC_LAUNCH_WEEK_MILLISECONDS,
  TELEMETRY_V1_STEADY_STATE_CHUNKS_PER_DAY as SYNC_STEADY_STATE_CHUNKS_PER_DAY,
  MAX_TELEMETRY_V1_SYNC_MANIFEST_RANGE_DAYS,
  MAX_TELEMETRY_V1_SYNC_MANIFEST_CHUNKS,
  MAX_TELEMETRY_V1_SYNC_STATE_CHUNKS,
  type TelemetryV1SyncChunkDigest,
  type TelemetryV1SyncManifest,
  type TelemetryV1SyncAdmission,
  type TelemetryV1SyncState,
} from "./telemetry-v1-sync-store";

// Compatibility exports retained for upload/admission callers while the
// calculation itself lives in the neutral sync port.
export const TELEMETRY_V1_STEADY_STATE_CHUNKS_PER_DAY = SYNC_STEADY_STATE_CHUNKS_PER_DAY;
export const TELEMETRY_V1_LAUNCH_WEEK_CHUNKS_PER_DAY = SYNC_LAUNCH_WEEK_CHUNKS_PER_DAY;
export const TELEMETRY_V1_LAUNCH_WEEK_MILLISECONDS = SYNC_LAUNCH_WEEK_MILLISECONDS;
// Compatibility export retained for existing route validation callers.
export const MAX_SYNC_MANIFEST_RANGE_DAYS = MAX_TELEMETRY_V1_SYNC_MANIFEST_RANGE_DAYS;

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

export type TelemetryV1ChunkAdmission = TelemetryV1SyncAdmission;

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
  return buildTelemetryV1SyncAdmission({
    acceptedChunks: row.accepted_count,
    deviceIssuedAt: row.device_issued_at,
  }, nowEpoch);
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
  /** Exact lease returned by the one-use upload claim. */
  uploadAuthorizationLeaseExpiresAt: string;
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
    uploadAuthorizationLeaseExpiresAt: uploadAuthorizationLeaseExpiresAt(insert),
    chunkId: insert.chunkRowId,
    objectKey: insert.r2Key,
    envelopeDigest: insert.envelopeDigest,
    chunk: insert.chunk,
    supersedes: insert.supersedes === null ? null : { id: insert.supersedes.id },
    createdAt: insert.createdAt,
  });
}

function uploadAuthorizationLeaseExpiresAt(insert: TelemetryV1ChunkInsert): string {
  const lease = Reflect.get(insert, "uploadAuthorizationLeaseExpiresAt");
  if (typeof lease !== "string" || lease.length === 0) {
    throw new ApiError(500, "INTERNAL_ERROR");
  }
  return lease;
}

/** Compatibility entrypoint backed by the canonical D1 contribution adapter. */
export function prepareTelemetryV1ChunkWrite(
  db: D1Database,
  insert: TelemetryV1ChunkInsert,
  records?: D1TelemetryV1PreparedRecords,
): { statements: D1PreparedStatement[]; chunkStatementIndex: number } {
  return prepareD1TelemetryV1ChunkWrite(db, {
    participantId: insert.participantId,
    deviceId: insert.deviceId,
    uploadAuthorizationId: insert.deviceUploadAuthorizationId,
    uploadAuthorizationLeaseExpiresAt: uploadAuthorizationLeaseExpiresAt(insert),
    chunkId: insert.chunkRowId,
    objectKey: insert.r2Key,
    envelopeDigest: insert.envelopeDigest,
    chunk: insert.chunk,
    supersedes: insert.supersedes === null ? null : { id: insert.supersedes.id },
    createdAt: insert.createdAt,
  }, records);
}

/**
 * Compile the provider-neutral correction operation into the canonical D1 v1
 * transaction.  The operation remains free of D1 types; this adapter is the
 * only layer that exposes prepared statements to the existing batch callers.
 */
export function prepareTelemetryV1CorrectionWrite(
  db: D1Database,
  operation: TelemetryCorrectionWriteOperation,
  records?: D1TelemetryV1PreparedRecords,
): { statements: D1PreparedStatement[]; chunkStatementIndex: number } {
  const snapshot = snapshotTelemetryCorrectionWriteOperation(operation);
  return prepareD1TelemetryV1ChunkWrite(db, {
    participantId: snapshot.participantId,
    deviceId: snapshot.deviceId,
    uploadAuthorizationId: snapshot.claim.uploadAuthorizationId,
    uploadAuthorizationLeaseExpiresAt: snapshot.claim.leaseExpiresAt,
    chunkId: snapshot.replacement.chunkId,
    objectKey: snapshot.replacement.objectKey,
    envelopeDigest: snapshot.replacement.envelopeDigest,
    chunk: snapshot.replacement.chunk,
    supersedes: { id: snapshot.predecessor.chunkId },
    createdAt: snapshot.replacement.createdAt,
  }, records);
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

/** Read current v1 chunk metadata in the stable sync cursor order. */
interface CurrentChunkDigestRow {
  chunk_day: string;
  stream: TelemetryV1Stream;
  chunk_seq: number;
  chunk_digest: string;
  revision: number;
  record_count: number;
}

export async function readTelemetryV1SyncChunkDigests(
  db: D1Database,
  participantId: string,
  deviceId: string,
  range: { fromDay: string; toDay: string } | null,
  maximumRows: number,
): Promise<TelemetryV1SyncChunkDigest[]> {
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
  return result.results.map((row) => ({
    chunkDay: row.chunk_day,
    stream: row.stream,
    chunkSeq: row.chunk_seq,
    chunkDigest: row.chunk_digest,
    revision: row.revision,
    recordCount: row.record_count,
  }));
}

export type { TelemetryV1SyncManifest, TelemetryV1SyncState } from "./telemetry-v1-sync-store";

export async function telemetryV1SyncState(
  db: D1Database,
  participantId: string,
  deviceId: string,
): Promise<TelemetryV1SyncState> {
  const rows = await readTelemetryV1SyncChunkDigests(
    db,
    participantId,
    deviceId,
    null,
    MAX_TELEMETRY_V1_SYNC_STATE_CHUNKS,
  );
  return buildTelemetryV1SyncState(rows);
}

export async function telemetryV1SyncManifest(
  db: D1Database,
  participantId: string,
  deviceId: string,
  fromDay: string,
  toDay: string,
): Promise<TelemetryV1SyncManifest> {
  const rows = await readTelemetryV1SyncChunkDigests(
    db,
    participantId,
    deviceId,
    { fromDay, toDay },
    MAX_TELEMETRY_V1_SYNC_MANIFEST_CHUNKS,
  );
  return buildTelemetryV1SyncManifest(rows, fromDay, toDay);
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
