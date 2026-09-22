import { ApiError } from "./errors";
import { participantDeletionDigest } from "./participant-erasure-ledger-contract";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";

export interface PostgresStorageErasureBindings {
  readonly primaryPool: PostgresPool;
  readonly ledgerPool: PostgresPool;
  readonly schemaOptions?: PostgresSchemaOptions;
  readonly sourceNamespace?: string;
  readonly statementTimeoutMilliseconds?: number;
  readonly lockTimeoutMilliseconds?: number;
}
const DEFAULT_NAMESPACE = "telemetry-v1";
const MAX_JOBS = 4;

function unavailable(): ApiError {
  return new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function ledgerUnavailable(): ApiError {
  return new ApiError(503, "DELETION_LEDGER_UNAVAILABLE");
}

function q(schema: string, table: string): string {
  return `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(table)}`;
}

function opts(bindings: PostgresStorageErasureBindings, operation: string) {
  return {
    operation,
    statementTimeoutMilliseconds: bindings.statementTimeoutMilliseconds ?? 10_000,
    lockTimeoutMilliseconds: bindings.lockTimeoutMilliseconds ?? 5_000,
    preserveSafeError: (error: unknown): Error | null => error instanceof ApiError ? error : null,
  };
}

function rows(result: { readonly rows: readonly Record<string, unknown>[] }): readonly Record<string, unknown>[] {
  if (!result || !Array.isArray(result.rows)) throw unavailable();
  return result.rows;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw unavailable();
  return value;
}

async function mutate<T>(
  bindings: PostgresStorageErasureBindings,
  operation: (client: PostgresClient, schema: string) => Promise<T>,
  label: string,
): Promise<T> {
  const schema = createPostgresSchemaConfig(bindings.schemaOptions);
  try {
    return await withPostgresMutation(bindings.primaryPool, (client) => operation(client, schema.primarySchema), opts(bindings, label));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unavailable();
  }
}

async function ledgerMutate<T>(
  bindings: PostgresStorageErasureBindings,
  operation: (client: PostgresClient, schema: string) => Promise<T>,
  label: string,
): Promise<T> {
  const schema = createPostgresSchemaConfig(bindings.schemaOptions);
  try {
    return await withPostgresMutation(bindings.ledgerPool, (client) => operation(client, schema.ledgerSchema), opts(bindings, label));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw ledgerUnavailable();
  }
}

async function ledgerRead<T>(
  bindings: PostgresStorageErasureBindings,
  operation: (client: PostgresClient, schema: string) => Promise<T>,
  label: string,
): Promise<T> {
  const schema = createPostgresSchemaConfig(bindings.schemaOptions);
  try {
    return await withPostgresRead(bindings.ledgerPool, (client) => operation(client, schema.ledgerSchema), opts(bindings, label));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw ledgerUnavailable();
  }
}

/** Record one pending owner-digest job after the independent tombstone commit. */
export async function preparePostgresStorageParticipantErasure(
  bindings: PostgresStorageErasureBindings,
  participantId: string,
): Promise<void> {
  if (typeof participantId !== "string" || participantId.length === 0) throw unavailable();
  const digest = await participantDeletionDigest(participantId);
  const namespace = bindings.sourceNamespace ?? DEFAULT_NAMESPACE;
  const ownership = await mutate(bindings, async (client, schema) => {
    const sourceResult = await client.query<{ source_id: string }>(
      `SELECT source_id FROM ${q(schema, "storage_source_state")}
        WHERE singleton=1`, []);
    const sourceRows = rows(sourceResult);
    if (sourceRows.length !== 1) throw unavailable();
    const sourceId = stringValue(sourceRows[0]?.source_id);
    const ownerResult = await client.query<{ owner_digest: string }>(
      `SELECT owner_digest FROM ${q(schema, "storage_v11_owner_links")}
        WHERE participant_id=$1 AND state IN ('active','withdrawn','erased')`, [participantId]);
    const ownerRows = rows(ownerResult);
    if (ownerRows.length !== 1) throw unavailable();
    return { sourceId, ownerDigest: stringValue(ownerRows[0]?.owner_digest) };
  }, "erasure.prepare.read_ownership");
  await ledgerMutate(bindings, async (client, schema) => {
    await client.query(`INSERT INTO ${q(schema, "storage_erasure_jobs")}
      (participant_digest,source_id,owner_digest,source_namespace,state,terminal_json,attempted_ms,completed_at)
      VALUES($1,$2,$3,$4,'pending',NULL,0,NULL)
      ON CONFLICT(participant_digest,source_id,owner_digest) DO UPDATE SET
        source_namespace=EXCLUDED.source_namespace,state='pending',terminal_json=NULL,completed_at=NULL`,
    [digest, ownership.sourceId, ownership.ownerDigest, namespace]);
  }, "erasure.prepare.write_jobs");
}

async function completeJob(
  bindings: PostgresStorageErasureBindings,
  job: { participant_digest: string; source_id: string; owner_digest: string; source_namespace: string },
): Promise<boolean> {
  return ledgerMutate(bindings, async (client, schema) => {
    const result = await client.query(`UPDATE ${q(schema, "storage_erasure_jobs")}
      SET state='complete',completed_at=clock_timestamp(),attempted_ms=attempted_ms+1
      WHERE participant_digest=$1 AND source_id=$2 AND owner_digest=$3
        AND source_namespace=$4 AND state='pending'`,
    [job.participant_digest, job.source_id, job.owner_digest, job.source_namespace]);
    return result.rowCount === 1;
  }, "erasure.complete_job");
}

async function ownerPayloadRemains(
  bindings: PostgresStorageErasureBindings,
  job: { source_id: string; owner_digest: string },
): Promise<boolean> {
  return mutate(bindings, async (client, schema) => {
    const ownerState = await client.query(`SELECT 1 FROM ${q(schema, "analytics_owner_state")}
      WHERE source_id=$1 AND owner_digest=$2 LIMIT 1`, [job.source_id, job.owner_digest]);
    if (rows(ownerState).length !== 0) return true;
    for (const table of [
      "analytics_prepared_source_rows", "analytics_prepared_source_heads",
      "analytics_analysis_work_parts", "analytics_analysis_work_heads",
    ]) {
      const result = await client.query(`SELECT 1 FROM ${q(schema, table)}
        WHERE source_id=$1 AND owner_digest=$2 LIMIT 1`, [job.source_id, job.owner_digest]);
      if (rows(result).length !== 0) return true;
    }
    const ownedPublication = await client.query(`SELECT 1
      FROM ${q(schema, "analytics_publication_owner_members")} m
      WHERE m.source_id=$1 AND m.owner_digest=$2 LIMIT 1`, [job.source_id, job.owner_digest]);
    if (rows(ownedPublication).length !== 0) return true;
    // A publication without owner membership cannot be safely attributed or
    // invalidated. Keep erasure pending rather than treating it as absent.
    const unscopedPublication = await client.query(`SELECT 1
      FROM ${q(schema, "analytics_publications")} p
      WHERE p.source_id=$1 AND NOT EXISTS (
        SELECT 1 FROM ${q(schema, "analytics_publication_owner_members")} m
         WHERE m.source_id=p.source_id AND m.day=p.day AND m.metric=p.metric
           AND m.generation=p.generation
      ) LIMIT 1`, [job.source_id]);
    if (rows(unscopedPublication).length !== 0) return true;
    const unscopedCapture = await client.query(`SELECT 1
      FROM ${q(schema, "analytics_publication_captures")} p
      WHERE p.source_id=$1 AND NOT EXISTS (
        SELECT 1 FROM ${q(schema, "analytics_publication_owner_members")} m
         WHERE m.source_id=p.source_id AND m.day=p.day AND m.metric=p.metric
           AND m.generation=p.generation
      ) LIMIT 1`, [job.source_id]);
    if (rows(unscopedCapture).length !== 0) return true;
    return false;
  }, "erasure.read_payload_absence");
}

/** One bounded retry page for the scheduled maintenance worker. */
export async function advancePostgresStorageErasureJobs(
  bindings: PostgresStorageErasureBindings,
  options: { readonly maxJobs?: number } = {},
): Promise<{ readonly completed: number; readonly pending: boolean }> {
  const maxJobs = options.maxJobs ?? 1;
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > MAX_JOBS) throw unavailable();
  const jobs = await ledgerRead(bindings, async (client, schema) => {
    const result = await client.query<Record<string, unknown>>(`SELECT participant_digest,source_id,
      owner_digest,source_namespace FROM ${q(schema, "storage_erasure_jobs")}
      WHERE state='pending' ORDER BY attempted_ms,participant_digest,owner_digest LIMIT $1`, [maxJobs]);
    return rows(result).map((row) => ({
      participant_digest: stringValue(row.participant_digest),
      source_id: stringValue(row.source_id),
      owner_digest: stringValue(row.owner_digest),
      source_namespace: stringValue(row.source_namespace),
    }));
  }, "erasure.read_jobs");
  let completed = 0;
  for (const job of jobs) {
    const remains = await ownerPayloadRemains(bindings, job);
    if (remains) continue;
    if (await completeJob(bindings, job)) completed += 1;
  }
  const pending = await ledgerRead(bindings, async (client, schema) => {
    const result = await client.query(`SELECT 1 FROM ${q(schema, "storage_erasure_jobs")}
      WHERE state='pending' LIMIT 1`);
    return rows(result).length !== 0;
  }, "erasure.read_pending");
  return { completed, pending };
}

/** Require bounded analytical erasure completion after primary deletion. */
export async function requirePostgresStorageParticipantErasureComplete(
  bindings: PostgresStorageErasureBindings,
  participantId: string,
): Promise<void> {
  const digest = await participantDeletionDigest(participantId);
  const jobs = await ledgerRead(bindings, async (client, schema) => {
    const result = await client.query<Record<string, unknown>>(`SELECT state,source_id,owner_digest,
      source_namespace FROM ${q(schema, "storage_erasure_jobs")}
      WHERE participant_digest=$1 ORDER BY source_id,owner_digest LIMIT 201`, [digest]);
    return rows(result);
  }, "erasure.read_participant_jobs");
  if (jobs.length > 200) throw unavailable();
  if (jobs.some((job) => job.state !== "complete")) {
    await advancePostgresStorageErasureJobs(bindings, { maxJobs: 1 });
    const remaining = await ledgerRead(bindings, async (client, schema) => {
      const result = await client.query(`SELECT 1 FROM ${q(schema, "storage_erasure_jobs")}
        WHERE participant_digest=$1 AND state='pending' LIMIT 1`, [digest]);
      return rows(result).length !== 0;
    }, "erasure.read_participant_pending");
    if (remaining) throw unavailable();
  }
  for (const job of jobs) {
    if (job.state !== "complete") continue;
    if (await ownerPayloadRemains(bindings, {
      source_id: stringValue(job.source_id),
      owner_digest: stringValue(job.owner_digest),
    })) {
      await ledgerMutate(bindings, async (client, schema) => {
        await client.query(`UPDATE ${q(schema, "storage_erasure_jobs")}
          SET state='pending',completed_at=NULL
          WHERE participant_digest=$1 AND source_id=$2 AND owner_digest=$3 AND state='complete'`,
        [digest, job.source_id, job.owner_digest]);
      }, "erasure.reopen_restored_job");
      throw unavailable();
    }
  }
}
