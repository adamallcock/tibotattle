import { ApiError } from "./errors";
import {
  MAX_SYNTHETIC_CONTRIBUTIONS_PER_PARTICIPANT,
} from "./constants";
import {
  assertDeletionOwner,
  finishParticipantDeletion,
  listContributions,
  markParticipantDeleting,
  participantIdentityLinkKeyForDeletion,
} from "./repository";
import {
  hasDeletionTombstone,
  recordDeletionTombstone,
} from "./retention";
import { telemetryContributionCount } from "./telemetry-repository";
import { telemetryV1ChunkCount } from "./telemetry-v1-repository";
import { telemetryV11ChunkCount } from "./telemetry-v11-repository";
import {
  PARTICIPANT_ERASURE_OBJECT_BATCH_LIMIT,
  type ParticipantErasureObjectPage,
  type ParticipantErasureObjectSource,
} from "./erasure-object-store";
import type {
  ParticipantErasureCounts,
  ParticipantErasureLedgerStore,
  ParticipantErasurePrimaryStore,
  ParticipantErasureTarget,
} from "./participant-erasure-store";

type D1ParticipantErasureDatabase = Pick<D1Database, "prepare">;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ERASURE_ATTEMPT_LEASE_MILLISECONDS = 5 * 60 * 1_000;

const SOURCE_TABLES: Record<ParticipantErasureObjectSource, string> = {
  synthetic: "contributions",
  telemetry: "telemetry_contributions",
  telemetry_v1: "telemetry_v1_chunks",
  telemetry_v11: "telemetry_v11_chunks",
  telemetry_v12: "telemetry_v12_chunks",
};

function unavailable(): ApiError {
  return new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function rowCount(value: unknown): number {
  try {
    const meta = value !== null && typeof value === "object"
      ? Reflect.get(value, "meta")
      : null;
    const changes = meta !== null && typeof meta === "object"
      ? Reflect.get(meta, "changes")
      : undefined;
    if (!Number.isSafeInteger(changes) || (changes as number) < 0) throw unavailable();
    return changes as number;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unavailable();
  }
}

function sourcePage(
  database: D1ParticipantErasureDatabase,
  participantId: string,
  source: ParticipantErasureObjectSource,
  cursor: { readonly createdAt: string; readonly id: string } | null,
  limit: number,
): Promise<{ results: Array<{ id: string; r2_key: string; created_at: string }> }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PARTICIPANT_ERASURE_OBJECT_BATCH_LIMIT) {
    throw new TypeError("invalid participant erasure page limit");
  }
  const table = SOURCE_TABLES[source];
  if (cursor === null) {
    return database.prepare(
      `SELECT id, r2_key, created_at FROM ${table}
        WHERE participant_id = ? ORDER BY created_at, id LIMIT ?`,
    ).bind(participantId, limit).all<{ id: string; r2_key: string; created_at: string }>();
  }
  return database.prepare(
    `SELECT id, r2_key, created_at FROM ${table}
      WHERE participant_id = ?
        AND (created_at > ? OR (created_at = ? AND id > ?))
      ORDER BY created_at, id LIMIT ?`,
  ).bind(
    participantId,
    cursor.createdAt,
    cursor.createdAt,
    cursor.id,
    limit,
  ).all<{ id: string; r2_key: string; created_at: string }>();
}

function mapPage(
  source: ParticipantErasureObjectSource,
  rows: Array<{ id: string; r2_key: string; created_at: string }>,
  limit: number,
): ParticipantErasureObjectPage {
  for (const row of rows) {
    if (typeof row.id !== "string" || row.id.length === 0
        || typeof row.r2_key !== "string" || row.r2_key.length === 0
        || typeof row.created_at !== "string" || !Number.isFinite(Date.parse(row.created_at))) {
      throw unavailable();
    }
  }
  const last = rows.at(-1);
  return {
    objects: rows.map((row) => ({
      source,
      id: row.id,
      key: row.r2_key,
      createdAt: row.created_at,
      version: null,
    })),
    nextCursor: last !== undefined && rows.length === limit
      ? { createdAt: last.created_at, id: last.id }
      : null,
  };
}

/** D1 composition for the provider-neutral owner-erasure primary store. */
export function createD1ParticipantErasureStore(
  database: D1ParticipantErasureDatabase,
): ParticipantErasurePrimaryStore {
  return {
    async readParticipant(participantId): Promise<ParticipantErasureTarget | null> {
      try {
        const row = await database.prepare(
          `SELECT participant.state,
                  participant.deletion_session_id,
                  participant.owner_kind,
                  owner.enrollment_device_id
             FROM participants participant
             LEFT JOIN accountless_upload_owners owner
               ON owner.participant_id = participant.id AND owner.state = 'active'
            WHERE participant.id = ?`,
        ).bind(participantId).first<{
          state: string;
          deletion_session_id: string | null;
          owner_kind: "social" | "accountless";
          enrollment_device_id: string | null;
        }>();
        if (row === null) return null;
        if ((row.state !== "active" && row.state !== "deleting")
            || (row.owner_kind !== "social" && row.owner_kind !== "accountless")
            || (row.deletion_session_id !== null && typeof row.deletion_session_id !== "string")) {
          throw unavailable();
        }
        return {
          state: row.state,
          deletionFence: row.deletion_session_id,
          ownerKind: row.owner_kind,
          enrollmentDeviceId: row.enrollment_device_id,
        };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw unavailable();
      }
    },

    async claimDeletion(participantId, target, operationId, nowEpoch): Promise<string> {
      if (target.state === "active") {
        await markParticipantDeleting(database as D1Database, participantId, operationId);
        return operationId;
      }
      if (target.deletionFence === null) throw new ApiError(409, "PARTICIPANT_DELETING");
      if (!UUID_PATTERN.test(target.deletionFence)) throw unavailable();
      const result = await database.prepare(
        `UPDATE participants SET deletion_session_id = ?
          WHERE id = ? AND state = 'deleting' AND deletion_session_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM admin_action_audit
               WHERE operation_id = ? AND outcome = 'started' AND created_at > ?
            )`,
      ).bind(
        operationId,
        participantId,
        target.deletionFence,
        target.deletionFence,
        new Date(nowEpoch - ERASURE_ATTEMPT_LEASE_MILLISECONDS).toISOString(),
      ).run();
      if (rowCount(result) !== 1) throw new ApiError(409, "PARTICIPANT_DELETING");
      return operationId;
    },

    assertOwner(participantId, deletionFence) {
      return assertDeletionOwner(database as D1Database, participantId, deletionFence);
    },

    async revokeLegacySessions(participantId, deletionFence, nowEpoch): Promise<void> {
      const result = await database.prepare(
        `UPDATE web_sessions SET state = 'revoked', revoked_at = ?
          WHERE participant_id = ? AND state = 'active'
            AND EXISTS (
              SELECT 1 FROM participants
               WHERE id = ? AND state = 'deleting' AND deletion_session_id = ?
            )`,
      ).bind(
        new Date(nowEpoch).toISOString(),
        participantId,
        participantId,
        deletionFence,
      ).run();
      rowCount(result);
    },

    identityLinkKey(participantId, deletionFence) {
      return participantIdentityLinkKeyForDeletion(
        database as D1Database,
        participantId,
        deletionFence,
      );
    },

    async countObjects(participantId): Promise<ParticipantErasureCounts> {
      const contributions = await listContributions(database as D1Database, participantId);
      if (contributions.length > MAX_SYNTHETIC_CONTRIBUTIONS_PER_PARTICIPANT) {
        throw new ApiError(500, "INTERNAL_ERROR");
      }
      return {
        synthetic: contributions.length,
        telemetry: await telemetryContributionCount(database as D1Database, participantId),
        telemetryV1: await telemetryV1ChunkCount(database as D1Database, participantId),
        telemetryV11: await telemetryV11ChunkCount(database as D1Database, participantId),
        telemetryV12: await database.prepare(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table' AND name='telemetry_v12_chunks'",
        ).first<{ count: number }>().then(async (present) => present?.count === 1
          ? Number((await database.prepare(
            "SELECT COUNT(*) AS count FROM telemetry_v12_chunks WHERE participant_id = ?",
          ).bind(participantId).first<{ count: number }>())?.count ?? 0)
          : 0),
      };
    },

    async listObjectPage(participantId, source, cursor, limit): Promise<ParticipantErasureObjectPage> {
      const result = await sourcePage(database, participantId, source, cursor, limit);
      return mapPage(source, result.results, limit);
    },

    finish(participantId, deletionFence) {
      return finishParticipantDeletion(database as D1Database, participantId, deletionFence);
    },
  };
}

/** The independent D1 deletion ledger remains a separate authority binding. */
export function createD1ParticipantErasureLedger(
  ledger: D1Database,
): ParticipantErasureLedgerStore {
  return {
    hasTombstone(participantId, nowEpoch) {
      return hasDeletionTombstone(ledger, participantId, nowEpoch);
    },
    recordTombstone(participantId, nowEpoch) {
      return recordDeletionTombstone(ledger, participantId, nowEpoch);
    },
  };
}
