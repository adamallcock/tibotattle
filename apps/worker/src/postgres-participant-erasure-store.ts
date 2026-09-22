import { MAX_SYNTHETIC_CONTRIBUTIONS_PER_PARTICIPANT } from "./constants";
import { ApiError } from "./errors";
import {
  DELETION_TOMBSTONE_RETENTION_MILLISECONDS,
  participantDeletionDigest,
} from "./participant-erasure-ledger-contract";
import type {
  ParticipantErasureCounts,
  ParticipantErasureLedgerStore,
  ParticipantErasurePrimaryStore,
  ParticipantErasureTarget,
} from "./participant-erasure-store";
import {
  PARTICIPANT_ERASURE_OBJECT_BATCH_LIMIT,
  type ParticipantErasureObjectPage,
  type ParticipantErasureObjectSource,
} from "./erasure-object-store";
import type {
  PostgresTelemetryV1Client,
  PostgresTelemetryV1Pool,
  PostgresTelemetryV1QueryResult,
} from "./postgres-telemetry-v1-contribution-store";

/**
 * Qualification-only PostgreSQL composition. The primary and ledger pools are
 * deliberately separate arguments: a PostgreSQL tombstone in the same
 * database as the participant row is not an independent restore authority.
 */
export interface PostgresParticipantErasureStores {
  readonly primary: ParticipantErasurePrimaryStore;
  readonly ledger: ParticipantErasureLedgerStore;
}

export interface PostgresParticipantErasureOptions {
  readonly primarySchema?: string;
  readonly ledgerSchema?: string;
  readonly statementTimeoutMilliseconds?: number;
  readonly lockTimeoutMilliseconds?: number;
}

const DEFAULT_PRIMARY_SCHEMA = "tibotattle_v1_test";
const DEFAULT_LEDGER_SCHEMA = "tibotattle_erasure_ledger_test";
const DEFAULT_STATEMENT_TIMEOUT_MILLISECONDS = 10_000;
const DEFAULT_LOCK_TIMEOUT_MILLISECONDS = 5_000;
const ERASURE_ATTEMPT_LEASE_MILLISECONDS = 5 * 60 * 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const SOURCE_TABLES: Record<ParticipantErasureObjectSource, {
  readonly table: string;
  readonly keyColumn: string;
  readonly versionColumn: string;
}> = {
  synthetic: { table: "contributions", keyColumn: "r2_key", versionColumn: "object_version" },
  telemetry: { table: "telemetry_contributions", keyColumn: "r2_key", versionColumn: "object_version" },
  // The canonical v1 qualification schema calls this table `chunks` and the
  // object column `object_key`; keep that mapping explicit at the boundary.
  telemetry_v1: { table: "chunks", keyColumn: "object_key", versionColumn: "object_version" },
  telemetry_v11: { table: "telemetry_v11_chunks", keyColumn: "r2_key", versionColumn: "object_version" },
  telemetry_v12: { table: "telemetry_v12_chunks", keyColumn: "r2_key", versionColumn: "object_version" },
};

function storageUnavailable(): ApiError {
  return new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function ledgerUnavailable(): ApiError {
  return new ApiError(503, "DELETION_LEDGER_UNAVAILABLE");
}

function identifier(value: string, label: string): string {
  if (typeof value !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) {
    throw new TypeError(`${label} must be a simple SQL identifier`);
  }
  return `"${value}"`;
}

function timeoutMilliseconds(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 300_000) {
    throw new TypeError("invalid PostgreSQL timeout");
  }
  return result;
}

function rowCount(result: PostgresTelemetryV1QueryResult): number {
  if (result === null
      || typeof result !== "object"
      || !Array.isArray(result.rows)
      || !Number.isSafeInteger(result.rowCount)
      || (result.rowCount as number) < 0) {
    throw storageUnavailable();
  }
  return result.rowCount as number;
}

function rows(result: PostgresTelemetryV1QueryResult): Record<string, unknown>[] {
  if (result === null || typeof result !== "object" || !Array.isArray(result.rows)) {
    throw storageUnavailable();
  }
  return result.rows;
}

function integer(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^[0-9]+$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw storageUnavailable();
}

function instant(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  throw storageUnavailable();
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) throw storageUnavailable();
  return value;
}

function knownError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

async function releaseClient(
  client: PostgresTelemetryV1Client,
  discard: boolean,
): Promise<boolean> {
  try {
    await client.release(discard);
    return true;
  } catch {
    return false;
  }
}

async function withClient<T>(
  pool: PostgresTelemetryV1Pool,
  operation: (client: PostgresTelemetryV1Client) => Promise<T>,
  statementTimeout: number,
  lockTimeout: number,
  unavailableError: () => ApiError = storageUnavailable,
  readOnly = true,
): Promise<T> {
  return transaction(
    pool,
    operation,
    statementTimeout,
    lockTimeout,
    unavailableError,
    readOnly,
  );
}

async function transaction<T>(
  pool: PostgresTelemetryV1Pool,
  operation: (client: PostgresTelemetryV1Client) => Promise<T>,
  statementTimeout: number,
  lockTimeout: number,
  unavailableError: () => ApiError = storageUnavailable,
  readOnly = false,
): Promise<T> {
  let client: PostgresTelemetryV1Client;
  try {
    client = await pool.connect();
  } catch {
    throw unavailableError();
  }

  let commitAttempted = false;
  let value: T;
  try {
    await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
    await client.query(`SET LOCAL statement_timeout='${statementTimeout}ms'`);
    await client.query(`SET LOCAL lock_timeout='${lockTimeout}ms'`);
    value = await operation(client);
    // A COMMIT acknowledgement can be lost after the provider has committed;
    // destroy that connection and never retry the destructive operation.
    commitAttempted = true;
    await client.query("COMMIT");
  } catch (error) {
    let rollbackFailed = false;
    try {
      await client.query("ROLLBACK");
    } catch {
      rollbackFailed = true;
    }
    const discarded = commitAttempted || rollbackFailed;
    const released = await releaseClient(client, discarded);
    if (!released || discarded) throw unavailableError();
    if (knownError(error)) throw error;
    throw unavailableError();
  }
  if (!await releaseClient(client, false)) throw unavailableError();
  return value!;
}

function sourceTable(schema: string, source: ParticipantErasureObjectSource): string {
  return `${schema}."${SOURCE_TABLES[source].table}"`;
}

function targetFromRow(row: Record<string, unknown>): ParticipantErasureTarget {
  const state = row.state;
  const ownerKind = row.owner_kind;
  if ((state !== "active" && state !== "deleting")
      || (ownerKind !== "social" && ownerKind !== "accountless")) {
    throw storageUnavailable();
  }
  const deletionFence = optionalText(row.deletion_session_id);
  const enrollmentDeviceId = optionalText(row.enrollment_device_id);
  return {
    state,
    deletionFence,
    ownerKind,
    enrollmentDeviceId,
  };
}

function pageFromRows(
  source: ParticipantErasureObjectSource,
  resultRows: Record<string, unknown>[],
  limit: number,
): ParticipantErasureObjectPage {
  const objects = resultRows.map((row) => {
    const id = row.id;
    const key = row.r2_key;
    if (typeof id !== "string" || id.length === 0
        || typeof key !== "string" || key.length === 0) {
      throw storageUnavailable();
    }
    return {
      source,
      id,
      key,
      createdAt: instant(row.created_at),
      version: optionalText(row.object_version),
    };
  });
  const last = objects.at(-1);
  return {
    objects,
    nextCursor: last !== undefined && objects.length === limit
      ? { createdAt: last.createdAt, id: last.id }
      : null,
  };
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit)
      || limit < 1
      || limit > PARTICIPANT_ERASURE_OBJECT_BATCH_LIMIT) {
    throw new TypeError("invalid participant erasure page limit");
  }
}

function countFromResult(result: PostgresTelemetryV1QueryResult): number {
  const resultRows = rows(result);
  if (resultRows.length !== 1) throw storageUnavailable();
  return integer(resultRows[0]?.count);
}

function exactParticipantRow(result: PostgresTelemetryV1QueryResult): boolean {
  const resultRows = rows(result);
  return rowCount(result) === 1
    && resultRows.length === 1
    && resultRows[0]?.id !== undefined;
}

function createPrimaryStore(
  pool: PostgresTelemetryV1Pool,
  schema: string,
  statementTimeout: number,
  lockTimeout: number,
): ParticipantErasurePrimaryStore {
  const boundedRead = <T>(
    operation: (client: PostgresTelemetryV1Client) => Promise<T>,
  ): Promise<T> => withClient(
    pool,
    operation,
    statementTimeout,
    lockTimeout,
  );
  const boundedWrite = <T>(
    operation: (client: PostgresTelemetryV1Client) => Promise<T>,
  ): Promise<T> => withClient(
    pool,
    operation,
    statementTimeout,
    lockTimeout,
    storageUnavailable,
    false,
  );
  return {
    async readParticipant(participantId): Promise<ParticipantErasureTarget | null> {
      return boundedRead(async (client) => {
        const result = await client.query(
          `SELECT p.state, p.deletion_session_id, p.owner_kind,
                  o.enrollment_device_id
             FROM ${schema}."participants" p
             LEFT JOIN ${schema}."accountless_upload_owners" o
               ON o.participant_id = p.id AND o.state = 'active'
            WHERE p.id = $1`,
          [participantId],
        );
        const resultRows = rows(result);
        if (resultRows.length === 0) return null;
        if (resultRows.length !== 1) throw storageUnavailable();
        return targetFromRow(resultRows[0]!);
      });
    },

    async claimDeletion(participantId, target, operationId, nowEpoch): Promise<string> {
      if (!Number.isSafeInteger(nowEpoch)) throw new TypeError("invalid participant erasure time");
      if (target.state === "deleting") {
        if (target.deletionFence === null) throw new ApiError(409, "PARTICIPANT_DELETING");
        if (!UUID_PATTERN.test(target.deletionFence)) throw storageUnavailable();
      }
      return transaction(pool, async (client) => {
        if (target.state === "active") {
          const now = new Date(nowEpoch).toISOString();
          await client.query(
            `UPDATE ${schema}."authorizations"
                SET state = 'revoked', lease_expires_at = NULL
              WHERE participant_id = $2 AND state = 'consuming'
                AND lease_expires_at <= $1`,
            [now, participantId],
          );
          await client.query(
            `UPDATE ${schema}."device_upload_authorizations"
                SET state = 'revoked', revoked_at = $1,
                    consume_lease_expires_at = NULL
              WHERE participant_id = $2 AND state = 'consuming'
                AND consume_lease_expires_at <= $1`,
            [now, participantId],
          );
          const claimed = await client.query(
            `UPDATE ${schema}."participants"
                SET state = 'deleting', deletion_session_id = $1
              WHERE id = $2 AND state = 'active'
                AND NOT EXISTS (
                  SELECT 1 FROM ${schema}."authorizations"
                   WHERE participant_id = $2 AND state = 'consuming'
                )
                AND NOT EXISTS (
                  SELECT 1 FROM ${schema}."device_upload_authorizations"
                   WHERE participant_id = $2 AND state = 'consuming'
                )
              RETURNING id`,
            [operationId, participantId],
          );
          if (!exactParticipantRow(claimed)) {
            const consuming = await client.query(
              `SELECT (
                  (SELECT COUNT(*) FROM ${schema}."authorizations"
                    WHERE participant_id = $1 AND state = 'consuming')
                  +
                  (SELECT COUNT(*) FROM ${schema}."device_upload_authorizations"
                    WHERE participant_id = $1 AND state = 'consuming')
                )::text AS total`,
              [participantId],
            );
            const consumingRows = rows(consuming);
            if (consumingRows.length !== 1) throw storageUnavailable();
            const total = integer(consumingRows[0]?.total);
            throw new ApiError(409, total > 0 ? "UPLOAD_IN_PROGRESS" : "PARTICIPANT_DELETING");
          }
          // Preserve the D1 operation's credential/session revocations. The
          // generic workflow performs the final active-session revocation too.
          await client.query(
            `UPDATE ${schema}."web_sessions" SET state = 'revoked', revoked_at = $1
              WHERE participant_id = $2 AND id <> $3 AND state = 'active'
                AND EXISTS (SELECT 1 FROM ${schema}."participants"
                  WHERE id = $2 AND deletion_session_id = $3)`,
            [now, participantId, operationId],
          );
          await client.query(
            `UPDATE ${schema}."device_pairings" SET state = 'revoked', revoked_at = $1
              WHERE participant_id = $2 AND state = 'unused'
                AND EXISTS (SELECT 1 FROM ${schema}."participants"
                  WHERE id = $2 AND deletion_session_id = $3)`,
            [now, participantId, operationId],
          );
          await client.query(
            `UPDATE ${schema}."device_credentials" SET state = 'revoked', revoked_at = $1
              WHERE participant_id = $2 AND state = 'active'
                AND EXISTS (SELECT 1 FROM ${schema}."participants"
                  WHERE id = $2 AND deletion_session_id = $3)`,
            [now, participantId, operationId],
          );
          await client.query(
            `UPDATE ${schema}."device_upload_authorizations" SET state = 'revoked', revoked_at = $1
              WHERE participant_id = $2 AND state = 'unused'
                AND EXISTS (SELECT 1 FROM ${schema}."participants"
                  WHERE id = $2 AND deletion_session_id = $3)`,
            [now, participantId, operationId],
          );
          return operationId;
        }

        const previousFence = target.deletionFence;
        if (previousFence === null) throw new ApiError(409, "PARTICIPANT_DELETING");
        const claimed = await client.query(
          `UPDATE ${schema}."participants" SET deletion_session_id = $1
            WHERE id = $2 AND state = 'deleting' AND deletion_session_id = $3
              AND NOT EXISTS (
                SELECT 1 FROM ${schema}."admin_action_audit"
                 WHERE operation_id = $3 AND outcome = 'started' AND created_at > $4
              )
            RETURNING id`,
          [operationId, participantId, previousFence,
            new Date(nowEpoch - ERASURE_ATTEMPT_LEASE_MILLISECONDS).toISOString()],
        );
        if (!exactParticipantRow(claimed)) throw new ApiError(409, "PARTICIPANT_DELETING");
        return operationId;
      }, statementTimeout, lockTimeout);
    },

    assertOwner(participantId, deletionFence): Promise<void> {
      return boundedRead(async (client) => {
        const result = await client.query(
          `SELECT 1 AS allowed FROM ${schema}."participants"
            WHERE id = $1 AND state = 'deleting' AND deletion_session_id = $2`,
          [participantId, deletionFence],
        );
        const resultRows = rows(result);
        if (resultRows.length !== 1 || resultRows[0]?.allowed !== 1) {
          throw new ApiError(409, "PARTICIPANT_DELETING");
        }
      });
    },

    async revokeLegacySessions(participantId, deletionFence, nowEpoch): Promise<void> {
      await boundedWrite(async (client) => {
        const result = await client.query(
          `UPDATE ${schema}."web_sessions" SET state = 'revoked', revoked_at = $1
            WHERE participant_id = $2 AND state = 'active'
              AND EXISTS (SELECT 1 FROM ${schema}."participants"
                WHERE id = $2 AND state = 'deleting' AND deletion_session_id = $3)`,
          [new Date(nowEpoch).toISOString(), participantId, deletionFence],
        );
        rowCount(result);
      });
    },

    identityLinkKey(participantId, deletionFence): Promise<string | null> {
      return boundedRead(async (client) => {
        const result = await client.query(
          `SELECT identity_link_key FROM ${schema}."participants"
            WHERE id = $1 AND state = 'deleting' AND deletion_session_id = $2`,
          [participantId, deletionFence],
        );
        const resultRows = rows(result);
        if (resultRows.length === 0) throw new ApiError(409, "PARTICIPANT_DELETING");
        if (resultRows.length !== 1) throw storageUnavailable();
        return optionalText(resultRows[0]?.identity_link_key);
      });
    },

    async countObjects(participantId): Promise<ParticipantErasureCounts> {
      const count = async (source: ParticipantErasureObjectSource): Promise<number> =>
        boundedRead(async (client) => countFromResult(await client.query(
          `SELECT COUNT(*)::text AS count FROM ${sourceTable(schema, source)} WHERE participant_id = $1`,
          [participantId],
        )));
      const synthetic = await count("synthetic");
      if (synthetic > MAX_SYNTHETIC_CONTRIBUTIONS_PER_PARTICIPANT) {
        throw new ApiError(500, "INTERNAL_ERROR");
      }
      return {
        synthetic,
        telemetry: await count("telemetry"),
        telemetryV1: await count("telemetry_v1"),
        telemetryV11: await count("telemetry_v11"),
        // v1.2 remains staged in the legacy qualification schema. The
        // canonical adapter handles its operational chunk journal.
        telemetryV12: 0,
      };
    },

    async listObjectPage(participantId, source, cursor, limit): Promise<ParticipantErasureObjectPage> {
      assertLimit(limit);
      return boundedRead(async (client) => {
        const result = cursor === null
          ? await client.query(
            `SELECT id, ${SOURCE_TABLES[source].keyColumn} AS r2_key,
                    created_at, ${SOURCE_TABLES[source].versionColumn} AS object_version
               FROM ${sourceTable(schema, source)}
              WHERE participant_id = $1 ORDER BY created_at, id LIMIT $2`,
            [participantId, limit],
          )
          : await client.query(
            `SELECT id, ${SOURCE_TABLES[source].keyColumn} AS r2_key,
                    created_at, ${SOURCE_TABLES[source].versionColumn} AS object_version
               FROM ${sourceTable(schema, source)}
              WHERE participant_id = $1
                AND (created_at > $2::timestamptz
                  OR (created_at = $2::timestamptz AND id > $3))
              ORDER BY created_at, id LIMIT $4`,
            [participantId, cursor.createdAt, cursor.id, limit],
          );
        return pageFromRows(source, rows(result), limit);
      });
    },

    finish(participantId, deletionFence): Promise<void> {
      return transaction(pool, async (client) => {
        const owner = await client.query(
          `SELECT 1 AS allowed FROM ${schema}."participants"
            WHERE id = $1 AND state = 'deleting' AND deletion_session_id = $2
            FOR UPDATE`,
          [participantId, deletionFence],
        );
        const ownerRows = rows(owner);
        if (ownerRows.length !== 1 || ownerRows[0]?.allowed !== 1) {
          throw new ApiError(409, "PARTICIPANT_DELETING");
        }
        await client.query(
          `DELETE FROM ${schema}."records"
            WHERE participant_id = $1`,
          [participantId],
        );
        // Canonical v1 chunks own records and drive the analytical invalidation
        // triggers. Keep the participant alive until all source/projection
        // children that lack ON DELETE CASCADE have been removed.
        await client.query(
          `DELETE FROM ${schema}."pending_objects"
            WHERE contribution_id IN (
              SELECT id FROM ${schema}."chunks" WHERE participant_id = $1
            )`,
          [participantId],
        );
        await client.query(
          `DELETE FROM ${schema}."chunks" WHERE participant_id = $1`,
          [participantId],
        );
        await client.query(
          `DELETE FROM ${schema}."contributions" WHERE participant_id = $1`,
          [participantId],
        );
        await client.query(
          `DELETE FROM ${schema}."telemetry_contributions" WHERE participant_id = $1`,
          [participantId],
        );
        await client.query(
          `DELETE FROM ${schema}."telemetry_v11_chunks" WHERE participant_id = $1`,
          [participantId],
        );
        await client.query(
          `DELETE FROM ${schema}."legacy_sources" WHERE participant_id = $1`,
          [participantId],
        );
        await client.query(
          `DELETE FROM ${schema}."v11_domain_heads" WHERE participant_id = $1`,
          [participantId],
        );
        await client.query(
          `DELETE FROM ${schema}."prepared_source_days" WHERE participant_id = $1`,
          [participantId],
        );
        await client.query(
          `DELETE FROM ${schema}."input_versions" WHERE participant_id = $1`,
          [participantId],
        );
        await client.query(
          `DELETE FROM ${schema}."admission_windows" WHERE participant_id = $1`,
          [participantId],
        );
        await client.query(
          `DELETE FROM ${schema}."authorizations" WHERE participant_id = $1`,
          [participantId],
        );
        await client.query(
          `DELETE FROM ${schema}."device_upload_authorizations" WHERE participant_id = $1`,
          [participantId],
        );
        await client.query(
          `DELETE FROM ${schema}."device_pairings" WHERE participant_id = $1`,
          [participantId],
        );
        await client.query(
          `DELETE FROM ${schema}."device_credentials" WHERE participant_id = $1`,
          [participantId],
        );
        await client.query(
          `DELETE FROM ${schema}."consents" WHERE participant_id = $1`,
          [participantId],
        );
        await client.query(
          `DELETE FROM ${schema}."devices" WHERE participant_id = $1`,
          [participantId],
        );
        await client.query(
          `DELETE FROM ${schema}."accountless_upload_owners" WHERE participant_id = $1`,
          [participantId],
        );
        const result = await client.query(
          `DELETE FROM ${schema}."participants"
            WHERE id = $1 AND state = 'deleting' AND deletion_session_id = $2
            RETURNING id`,
          [participantId, deletionFence],
        );
        if (!exactParticipantRow(result)) throw new ApiError(409, "PARTICIPANT_DELETING");
      }, statementTimeout, lockTimeout);
    },
  };
}

function createLedgerStore(
  pool: PostgresTelemetryV1Pool,
  schema: string,
  statementTimeout: number,
  lockTimeout: number,
): ParticipantErasureLedgerStore {
  const boundedRead = <T>(
    operation: (client: PostgresTelemetryV1Client) => Promise<T>,
  ): Promise<T> => withClient(
    pool,
    operation,
    statementTimeout,
    lockTimeout,
    ledgerUnavailable,
  );
  return {
    async hasTombstone(participantId, nowEpoch): Promise<boolean> {
      let digest: string;
      try {
        digest = await participantDeletionDigest(participantId);
      } catch {
        throw ledgerUnavailable();
      }
      return boundedRead(async (client) => {
        const result = await client.query(
          `SELECT retain_until FROM ${schema}."deletion_tombstones"
            WHERE participant_digest = $1 AND retain_until > $2::timestamptz`,
          [digest, new Date(nowEpoch)],
        );
        const resultRows = rows(result);
        if (resultRows.length === 0) return false;
        if (resultRows.length !== 1) throw ledgerUnavailable();
        if (!(resultRows[0]?.retain_until instanceof Date)
            && typeof resultRows[0]?.retain_until !== "string") {
          throw ledgerUnavailable();
        }
        return true;
      });
    },

    async recordTombstone(participantId, nowEpoch): Promise<void> {
      let digest: string;
      try {
        digest = await participantDeletionDigest(participantId);
      } catch {
        throw ledgerUnavailable();
      }
      const deletedAt = new Date(nowEpoch);
      const retainUntil = new Date(nowEpoch + DELETION_TOMBSTONE_RETENTION_MILLISECONDS);
      await transaction(pool, async (client) => {
        await client.query(
          `INSERT INTO ${schema}."deletion_tombstones"
              (participant_digest, schema_version, deleted_at, retain_until)
            VALUES ($1, 'participant-deletion-tombstone-v0.1', $2, $3)
            ON CONFLICT(participant_digest) DO UPDATE SET
              retain_until = GREATEST(${schema}."deletion_tombstones".retain_until, EXCLUDED.retain_until)`,
          [digest, deletedAt, retainUntil],
        );
        const result = await client.query(
          `SELECT participant_digest, retain_until
             FROM ${schema}."deletion_tombstones"
            WHERE participant_digest = $1`,
          [digest],
        );
        const resultRows = rows(result);
        if (resultRows.length !== 1 || resultRows[0]?.participant_digest !== digest) {
          throw ledgerUnavailable();
        }
        const actual = resultRows[0]?.retain_until;
        const actualEpoch = actual instanceof Date
          ? actual.getTime()
          : typeof actual === "string" ? Date.parse(actual) : Number.NaN;
        if (!Number.isFinite(actualEpoch) || actualEpoch < retainUntil.getTime()) {
          throw ledgerUnavailable();
        }
      }, statementTimeout, lockTimeout, ledgerUnavailable);
    },
  };
}

/**
 * Build the untrusted qualification candidate. It is intentionally not wired
 * into the Worker entrypoint: callers must preserve the existing Access-owner
 * and CSRF route gate before invoking the neutral workflow.
 */
export function createExperimentalPostgresParticipantErasureStores(
  primaryPool: PostgresTelemetryV1Pool,
  ledgerPool: PostgresTelemetryV1Pool,
  options: PostgresParticipantErasureOptions = {},
): PostgresParticipantErasureStores {
  const primarySchema = identifier(options.primarySchema ?? DEFAULT_PRIMARY_SCHEMA, "primarySchema");
  const ledgerSchema = identifier(options.ledgerSchema ?? DEFAULT_LEDGER_SCHEMA, "ledgerSchema");
  const statementTimeout = timeoutMilliseconds(
    options.statementTimeoutMilliseconds,
    DEFAULT_STATEMENT_TIMEOUT_MILLISECONDS,
  );
  const lockTimeout = timeoutMilliseconds(
    options.lockTimeoutMilliseconds,
    DEFAULT_LOCK_TIMEOUT_MILLISECONDS,
  );
  return {
    primary: createPrimaryStore(primaryPool, primarySchema, statementTimeout, lockTimeout),
    ledger: createLedgerStore(ledgerPool, ledgerSchema, statementTimeout, lockTimeout),
  };
}
