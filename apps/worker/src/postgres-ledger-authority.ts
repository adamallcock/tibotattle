import { ApiError } from "./errors";
import { participantDeletionDigest } from "./participant-deletion-digest";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresPool,
  type PostgresSchemaConfig,
} from "./postgres-client";

const TOMBSTONE_SCHEMA_VERSION = "participant-deletion-tombstone-v0.1";
const TOMBSTONE_RETENTION_MILLISECONDS = 400 * 24 * 60 * 60 * 1_000;

export interface PostgresDeletionTombstoneOptions {
  readonly schema?: PostgresSchemaConfig;
}

interface TombstoneStateRow {
  readonly retained: boolean;
  readonly pending_erasure_job: boolean;
}

interface TombstoneReceiptRow {
  readonly participant_digest: string;
  readonly retained: boolean;
}

function unavailable(): ApiError {
  return new ApiError(503, "DELETION_LEDGER_UNAVAILABLE");
}

function ledgerSchema(options: PostgresDeletionTombstoneOptions): string {
  const config = createPostgresSchemaConfig(options.schema ?? {});
  return quotePostgresIdentifier(config.ledgerSchema);
}

function table(schema: string, name: string): string {
  return `${schema}.${quotePostgresIdentifier(name)}`;
}

function canonicalInstant(epoch: number): string {
  if (typeof epoch !== "number" || !Number.isFinite(epoch)) throw unavailable();
  const value = new Date(epoch);
  if (!Number.isFinite(value.getTime())) throw unavailable();
  return value.toISOString();
}

async function safeParticipantDigest(participantId: string): Promise<string> {
  try {
    return await participantDeletionDigest(participantId);
  } catch {
    throw unavailable();
  }
}

function failClosed<T>(operation: () => Promise<T>): Promise<T> {
  return operation().catch(() => {
    throw unavailable();
  });
}

/**
 * Record a purpose-separated deletion digest in the independent ledger.
 * Replays preserve the original deletion time and only extend retention.
 */
export async function recordPostgresDeletionTombstone(
  ledgerPool: PostgresPool,
  participantId: string,
  nowEpoch = Date.now(),
  options: PostgresDeletionTombstoneOptions = {},
): Promise<void> {
  try {
    const participantDigest = await safeParticipantDigest(participantId);
    const deletedAt = canonicalInstant(nowEpoch);
    const retainUntil = canonicalInstant(nowEpoch + TOMBSTONE_RETENTION_MILLISECONDS);
    const schema = ledgerSchema(options);
    await withPostgresMutation(ledgerPool, async (client) => {
      await client.query(
        `INSERT INTO ${table(schema, "deletion_tombstones")} (
           participant_digest, schema_version, deleted_at, retain_until
         ) VALUES ($1,$2,$3::timestamptz,$4::timestamptz)
         ON CONFLICT (participant_digest) DO UPDATE SET
           retain_until = CASE
             WHEN EXCLUDED.retain_until > deletion_tombstones.retain_until
               THEN EXCLUDED.retain_until
             ELSE deletion_tombstones.retain_until
           END`,
        [participantDigest, TOMBSTONE_SCHEMA_VERSION, deletedAt, retainUntil],
      );
      const receipt = await client.query<TombstoneReceiptRow>(
        `SELECT participant_digest,
                retain_until >= $2::timestamptz AS retained
           FROM ${table(schema, "deletion_tombstones")}
          WHERE participant_digest = $1
          LIMIT 1`,
        [participantDigest, retainUntil],
      );
      const row = receipt.rows[0];
      if (receipt.rows.length !== 1 || !row
          || row.participant_digest !== participantDigest || row.retained !== true) {
        throw unavailable();
      }
    }, {
      operation: "deletion_tombstone.record",
      statementTimeoutMilliseconds: 10_000,
      lockTimeoutMilliseconds: 5_000,
    });
  } catch {
    throw unavailable();
  }
}

/**
 * A tombstone remains authoritative until its retention instant. Once expired,
 * a pending cross-store erasure job keeps it authoritative until that job is
 * complete. Reads stay bounded by the digest primary key and one job row.
 */
export async function hasPostgresDeletionTombstone(
  ledgerPool: PostgresPool,
  participantId: string,
  nowEpoch = Date.now(),
  options: PostgresDeletionTombstoneOptions = {},
): Promise<boolean> {
  try {
    const participantDigest = await safeParticipantDigest(participantId);
    const now = canonicalInstant(nowEpoch);
    const schema = ledgerSchema(options);
    return await failClosed(() => withPostgresRead(ledgerPool, async (client) => {
      const result = await client.query<TombstoneStateRow>(
        `SELECT tombstone.retain_until > $2::timestamptz AS retained,
                EXISTS (
                  SELECT 1
                    FROM ${table(schema, "storage_erasure_jobs")} job
                   WHERE job.participant_digest = tombstone.participant_digest
                     AND job.state = 'pending'
                   LIMIT 1
                ) AS pending_erasure_job
           FROM ${table(schema, "deletion_tombstones")} tombstone
          WHERE tombstone.participant_digest = $1
          LIMIT 1`,
        [participantDigest, now],
      );
      if (result.rows.length === 0) return false;
      if (result.rows.length !== 1 || typeof result.rows[0]?.retained !== "boolean"
          || typeof result.rows[0]?.pending_erasure_job !== "boolean") {
        throw unavailable();
      }
      const row = result.rows[0]!;
      return row.retained || row.pending_erasure_job;
    }, {
      operation: "deletion_tombstone.read",
      statementTimeoutMilliseconds: 10_000,
      lockTimeoutMilliseconds: 5_000,
    }));
  } catch {
    throw unavailable();
  }
}
