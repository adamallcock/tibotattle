import { sha256Hex } from "./crypto";
import { ApiError } from "./errors";
import { finishParticipantDeletion } from "./repository";
import { QUARANTINE_RETENTION_MILLISECONDS } from "./constants";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
export const DELETION_TOMBSTONE_RETENTION_MILLISECONDS = 400 * DAY_MILLISECONDS;

const SCAN_PAGE_SIZE = 1_000;
const QUARANTINE_DELETE_BATCH_SIZE = 100;
const MAX_RESTORE_SUPPRESSIONS_PER_PASS = 100;
const MAX_LIFECYCLE_ROWS = 100_000;
const DELETION_DIGEST_DOMAIN = "app-usagemonitor/deletion-tombstone/v1\0";

interface TombstoneRow {
  participant_digest: string;
  retain_until?: string;
}

interface ParticipantRow {
  id: string;
}

interface QuarantineObjectRow {
  source: "synthetic" | "telemetry";
  id: string;
  r2_key: string;
}

export interface LifecyclePassResult {
  quarantineCutoffAt: string;
  quarantineObjectsDeleted: number;
  quarantineRetentionComplete: boolean;
  restoredParticipantsSuppressed: number;
  restoreReplayComplete: boolean;
}

function canonicalInstant(epoch: number): string {
  return new Date(epoch).toISOString();
}

export async function participantDeletionDigest(
  participantId: string,
): Promise<string> {
  return sha256Hex(`${DELETION_DIGEST_DOMAIN}${participantId}`);
}

export async function recordDeletionTombstone(
  ledger: D1Database,
  participantId: string,
  nowEpoch = Date.now(),
): Promise<void> {
  const participantDigest = await participantDeletionDigest(participantId);
  const deletedAt = canonicalInstant(nowEpoch);
  const retainUntil = canonicalInstant(
    nowEpoch + DELETION_TOMBSTONE_RETENTION_MILLISECONDS,
  );
  await ledger.prepare(
    `INSERT INTO deletion_tombstones (
      participant_digest, schema_version, deleted_at, retain_until
    ) VALUES (?, 'participant-deletion-tombstone-v0.1', ?, ?)
    ON CONFLICT(participant_digest) DO UPDATE SET
      retain_until = CASE
        WHEN excluded.retain_until > deletion_tombstones.retain_until
          THEN excluded.retain_until
        ELSE deletion_tombstones.retain_until
      END`,
  ).bind(participantDigest, deletedAt, retainUntil).run();
  const row = await ledger.prepare(
    `SELECT participant_digest, retain_until
       FROM deletion_tombstones
      WHERE participant_digest = ?`,
  ).bind(participantDigest).first<TombstoneRow>();
  if (row?.participant_digest !== participantDigest
      || typeof row.retain_until !== "string"
      || row.retain_until < retainUntil) {
    throw new ApiError(503, "DELETION_LEDGER_UNAVAILABLE");
  }
}

export async function hasDeletionTombstone(
  ledger: D1Database,
  participantId: string,
): Promise<boolean> {
  const participantDigest = await participantDeletionDigest(participantId);
  const row = await ledger.prepare(
    `SELECT 1 AS present
       FROM deletion_tombstones
      WHERE participant_digest = ?`,
  ).bind(participantDigest).first<{ present: number }>();
  return row?.present === 1;
}

async function deletionDigests(
  ledger: D1Database,
): Promise<Set<string>> {
  const digests = new Set<string>();
  let cursor = "";
  while (digests.size <= MAX_LIFECYCLE_ROWS) {
    const page = await ledger.prepare(
      `SELECT participant_digest
         FROM deletion_tombstones
        WHERE participant_digest > ?
        ORDER BY participant_digest
        LIMIT ?`,
    ).bind(cursor, SCAN_PAGE_SIZE).all<TombstoneRow>();
    if (page.results.length === 0) return digests;
    for (const row of page.results) {
      digests.add(row.participant_digest);
      if (digests.size > MAX_LIFECYCLE_ROWS) {
        throw new ApiError(503, "LIFECYCLE_BOUNDS_EXCEEDED");
      }
      cursor = row.participant_digest;
    }
    if (page.results.length < SCAN_PAGE_SIZE) return digests;
  }
  throw new ApiError(503, "LIFECYCLE_BOUNDS_EXCEEDED");
}

async function participantQuarantineKeys(
  db: D1Database,
  participantId: string,
): Promise<string[]> {
  const result = await db.prepare(
    `SELECT r2_key FROM contributions WHERE participant_id = ?
     UNION ALL
     SELECT r2_key FROM telemetry_contributions WHERE participant_id = ?
     LIMIT 202`,
  ).bind(participantId, participantId).all<{ r2_key: string }>();
  if (result.results.length > 201) {
    throw new ApiError(503, "LIFECYCLE_BOUNDS_EXCEEDED");
  }
  return result.results.map((row) => row.r2_key);
}

async function suppressRestoredParticipant(
  db: D1Database,
  quarantine: R2Bucket,
  participantId: string,
): Promise<void> {
  await db.prepare(
    `UPDATE participants
        SET state = 'deleting',
            deletion_session_id = NULL
      WHERE id = ? AND state = 'active'`,
  ).bind(participantId).run();
  const keys = await participantQuarantineKeys(db, participantId);
  if (keys.length > 0) await quarantine.delete(keys);
  await finishParticipantDeletion(db, participantId);
}

export async function replayDeletionTombstones(
  db: D1Database,
  ledger: D1Database,
  quarantine: R2Bucket,
): Promise<{
  suppressed: number;
  complete: boolean;
}> {
  const digests = await deletionDigests(ledger);
  if (digests.size === 0) return { suppressed: 0, complete: true };

  let cursor = "";
  let seen = 0;
  let suppressed = 0;
  while (seen <= MAX_LIFECYCLE_ROWS) {
    const page = await db.prepare(
      `SELECT id FROM participants
        WHERE id > ?
        ORDER BY id
        LIMIT ?`,
    ).bind(cursor, SCAN_PAGE_SIZE).all<ParticipantRow>();
    if (page.results.length === 0) {
      return { suppressed, complete: true };
    }
    for (const participant of page.results) {
      seen += 1;
      if (seen > MAX_LIFECYCLE_ROWS) {
        throw new ApiError(503, "LIFECYCLE_BOUNDS_EXCEEDED");
      }
      cursor = participant.id;
      const digest = await participantDeletionDigest(participant.id);
      if (!digests.has(digest)) continue;
      if (suppressed >= MAX_RESTORE_SUPPRESSIONS_PER_PASS) {
        return { suppressed, complete: false };
      }
      await suppressRestoredParticipant(db, quarantine, participant.id);
      suppressed += 1;
    }
    if (page.results.length < SCAN_PAGE_SIZE) {
      return { suppressed, complete: true };
    }
  }
  throw new ApiError(503, "LIFECYCLE_BOUNDS_EXCEEDED");
}

async function dueQuarantineObjects(
  db: D1Database,
  cutoffAt: string,
): Promise<QuarantineObjectRow[]> {
  const result = await db.prepare(
    `SELECT 'synthetic' AS source, id, r2_key
       FROM contributions
      WHERE quarantine_deleted_at IS NULL AND created_at <= ?
     UNION ALL
     SELECT 'telemetry' AS source, id, r2_key
       FROM telemetry_contributions
      WHERE quarantine_deleted_at IS NULL AND created_at <= ?
     ORDER BY id
     LIMIT ?`,
  ).bind(cutoffAt, cutoffAt, QUARANTINE_DELETE_BATCH_SIZE + 1)
    .all<QuarantineObjectRow>();
  return result.results;
}

async function deleteDueQuarantineObjects(
  db: D1Database,
  quarantine: R2Bucket,
  cutoffAt: string,
): Promise<{
  deleted: number;
  complete: boolean;
}> {
  const due = await dueQuarantineObjects(db, cutoffAt);
  if (due.length === 0) return { deleted: 0, complete: true };
  const batch = due.slice(0, QUARANTINE_DELETE_BATCH_SIZE);
  await quarantine.delete(batch.map((row) => row.r2_key));
  const deletedAt = new Date().toISOString();
  const updates = batch.map((row) => db.prepare(
    `UPDATE ${row.source === "synthetic"
      ? "contributions"
      : "telemetry_contributions"}
        SET quarantine_deleted_at = ?
      WHERE id = ? AND quarantine_deleted_at IS NULL`,
  ).bind(deletedAt, row.id));
  const results = await db.batch(updates);
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new ApiError(503, "LIFECYCLE_STATE_CONFLICT");
  }
  return {
    deleted: batch.length,
    complete: due.length <= QUARANTINE_DELETE_BATCH_SIZE,
  };
}

export async function runBackendLifecycle(
  db: D1Database,
  ledger: D1Database,
  quarantine: R2Bucket,
  nowEpoch = Date.now(),
): Promise<LifecyclePassResult> {
  const startedAt = canonicalInstant(nowEpoch);
  const quarantineCutoffAt = canonicalInstant(
    nowEpoch - QUARANTINE_RETENTION_MILLISECONDS,
  );
  await db.prepare(
    `UPDATE retention_state
        SET state = 'running',
            last_started_at = ?,
            failure_code = NULL
      WHERE singleton = 1`,
  ).bind(startedAt).run();
  try {
    const restoreReplay = await replayDeletionTombstones(
      db,
      ledger,
      quarantine,
    );
    const quarantineRetention = await deleteDueQuarantineObjects(
      db,
      quarantine,
      quarantineCutoffAt,
    );
    const completedAt = new Date().toISOString();
    await db.prepare(
      `UPDATE retention_state
          SET state = 'completed',
              last_completed_at = ?,
              quarantine_cutoff_at = ?,
              quarantine_objects_deleted = ?,
              quarantine_retention_complete = ?,
              restored_participants_suppressed = ?,
              restore_replay_complete = ?,
              failure_code = NULL
        WHERE singleton = 1`,
    ).bind(
      completedAt,
      quarantineCutoffAt,
      quarantineRetention.deleted,
      Number(quarantineRetention.complete),
      restoreReplay.suppressed,
      Number(restoreReplay.complete),
    ).run();
    return {
      quarantineCutoffAt,
      quarantineObjectsDeleted: quarantineRetention.deleted,
      quarantineRetentionComplete: quarantineRetention.complete,
      restoredParticipantsSuppressed: restoreReplay.suppressed,
      restoreReplayComplete: restoreReplay.complete,
    };
  } catch (error) {
    await db.prepare(
      `UPDATE retention_state
          SET state = 'failed',
              failure_code = 'LIFECYCLE_PASS_FAILED'
        WHERE singleton = 1`,
    ).run();
    throw error;
  }
}
