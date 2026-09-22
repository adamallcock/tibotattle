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
  ParticipantErasureObjectPage,
  ParticipantErasureObjectSource,
} from "./participant-erasure-store";
import type { PostgresParticipantErasureStores } from "./postgres-participant-erasure-store";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaOptions,
  type PostgresQueryResult,
} from "./postgres-client";

/**
 * PostgreSQL owner-erasure composition for the numbered operational schema.
 * The older qualification adapter remains available for the historical
 * fixture schema; this adapter only names tables from primary 0002-0007 and
 * the independent ledger 0002-0003 fragments.
 */
export interface PostgresCanonicalParticipantErasureOptions {
  readonly schemaOptions?: PostgresSchemaOptions;
  readonly statementTimeoutMilliseconds?: number;
  readonly lockTimeoutMilliseconds?: number;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RESTORE_FENCE_PREFIX = "restore-replay:";
const OBJECT_PAGE_LIMIT = 100;
const DEFAULT_STATEMENT_TIMEOUT = 10_000;
const DEFAULT_LOCK_TIMEOUT = 5_000;

type SourceSpec = Readonly<{
  table: string;
  keyColumn: string;
  versionExpression: string;
}>;

const SOURCES: Readonly<Record<ParticipantErasureObjectSource, SourceSpec>> = Object.freeze({
  synthetic: { table: "contributions", keyColumn: "r2_key", versionExpression: "object_version" },
  telemetry: { table: "telemetry_contributions", keyColumn: "r2_key", versionExpression: "object_version" },
  telemetry_v1: { table: "telemetry_v1_chunks", keyColumn: "r2_key", versionExpression: "NULL::text" },
  telemetry_v11: { table: "telemetry_v11_chunks", keyColumn: "r2_key", versionExpression: "NULL::text" },
  telemetry_v12: { table: "telemetry_v12_chunks", keyColumn: "r2_key", versionExpression: "NULL::text" },
});

function unavailable(): ApiError {
  return new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function ledgerUnavailable(): ApiError {
  return new ApiError(503, "DELETION_LEDGER_UNAVAILABLE");
}

function conflict(code: "PARTICIPANT_DELETING" | "UPLOAD_IN_PROGRESS"): ApiError {
  return new ApiError(409, code);
}

function timeout(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 600_000) {
    throw new TypeError("invalid PostgreSQL timeout");
  }
  return result;
}

function q(schema: string, table: string): string {
  return `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(table)}`;
}

function resultRows<Row extends object>(result: PostgresQueryResult<Row>): readonly Row[] {
  if (!result || !Array.isArray(result.rows)) throw unavailable();
  return result.rows;
}

function rowCount(result: PostgresQueryResult): number {
  if (!Number.isSafeInteger(result.rowCount) || (result.rowCount as number) < 0) throw unavailable();
  return result.rowCount as number;
}

function integer(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^[0-9]+$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw unavailable();
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw unavailable();
  return value;
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return text(value);
}

function instant(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  throw unavailable();
}

function target(row: Record<string, unknown>): ParticipantErasureTarget {
  if ((row.state !== "active" && row.state !== "deleting")
      || (row.owner_kind !== "social" && row.owner_kind !== "accountless")) throw unavailable();
  return {
    state: row.state,
    deletionFence: optionalText(row.deletion_session_id),
    ownerKind: row.owner_kind,
    enrollmentDeviceId: optionalText(row.enrollment_device_id),
  };
}

function preserveDomainError(error: unknown): Error | null {
  return error instanceof ApiError ? error : null;
}

function optionsFor(
  operation: string,
  options: PostgresCanonicalParticipantErasureOptions,
): { readonly operation: string; readonly statementTimeoutMilliseconds: number; readonly lockTimeoutMilliseconds: number; readonly preserveSafeError: typeof preserveDomainError } {
  return {
    operation,
    statementTimeoutMilliseconds: timeout(options.statementTimeoutMilliseconds, DEFAULT_STATEMENT_TIMEOUT),
    lockTimeoutMilliseconds: timeout(options.lockTimeoutMilliseconds, DEFAULT_LOCK_TIMEOUT),
    preserveSafeError: preserveDomainError,
  };
}

async function read<T>(
  pool: PostgresPool,
  operation: (client: PostgresClient) => Promise<T>,
  options: PostgresCanonicalParticipantErasureOptions,
  label: string,
): Promise<T> {
  try {
    return await withPostgresRead(pool, operation, optionsFor(label, options));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unavailable();
  }
}

async function mutate<T>(
  pool: PostgresPool,
  operation: (client: PostgresClient) => Promise<T>,
  options: PostgresCanonicalParticipantErasureOptions,
  label: string,
): Promise<T> {
  try {
    return await withPostgresMutation(pool, operation, optionsFor(label, options));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unavailable();
  }
}

async function tablePresent(client: PostgresClient, schema: string, table: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS present",
    [`${schema}.${table}`],
  );
  const rows = resultRows(result);
  return rows.length === 1 && rows[0]?.present === true;
}

async function sourcePage(
  client: PostgresClient,
  schema: string,
  source: ParticipantErasureObjectSource,
  participantId: string,
  cursor: { readonly createdAt: string; readonly id: string } | null,
  limit: number,
): Promise<ParticipantErasureObjectPage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > OBJECT_PAGE_LIMIT) {
    throw new TypeError("invalid participant erasure page limit");
  }
  const spec = SOURCES[source];
  if (!await tablePresent(client, schema, spec.table)) {
    return { objects: [], nextCursor: null };
  }
  const table = q(schema, spec.table);
  const key = quotePostgresIdentifier(spec.keyColumn);
  const order = cursor === null
    ? "WHERE participant_id=$1 ORDER BY created_at,id LIMIT $2"
    : "WHERE participant_id=$1 AND (created_at>$2::timestamptz OR (created_at=$2::timestamptz AND id>$3)) ORDER BY created_at,id LIMIT $4";
  const values = cursor === null
    ? [participantId, limit]
    : [participantId, cursor.createdAt, cursor.id, limit];
  const result = await client.query<Record<string, unknown>>(
    `SELECT id,${key} AS object_key,created_at,${spec.versionExpression} AS object_version FROM ${table} ${order}`,
    values,
  );
  const rows = resultRows(result).map((row) => ({
    source,
    id: text(row.id),
    key: text(row.object_key),
    createdAt: instant(row.created_at),
    version: optionalText(row.object_version),
  }));
  const last = rows.at(-1);
  return {
    objects: rows,
    nextCursor: last !== undefined && rows.length === limit
      ? { createdAt: last.createdAt, id: last.id }
      : null,
  };
}

async function countSource(
  client: PostgresClient,
  schema: string,
  source: ParticipantErasureObjectSource,
  participantId: string,
): Promise<number> {
  const spec = SOURCES[source];
  if (!await tablePresent(client, schema, spec.table)) return 0;
  const result = await client.query<{ count: string | number }>(
    `SELECT COUNT(*)::text AS count FROM ${q(schema, spec.table)} WHERE participant_id=$1`,
    [participantId],
  );
  const rows = resultRows(result);
  if (rows.length !== 1) throw unavailable();
  return integer(rows[0]?.count);
}

async function deleteParticipantRows(
  client: PostgresClient,
  schema: string,
  participantId: string,
): Promise<void> {
  // Object registration is the canonical ingest journal. Delete its rows by
  // contribution id before deleting chunks; no second quarantine journal is
  // consulted by the erasure protocol.
  if (await tablePresent(client, schema, "pending_objects")) {
    await client.query(`DELETE FROM ${q(schema, "pending_objects")} WHERE contribution_id IN (
      SELECT id FROM ${q(schema, "telemetry_v1_chunks")} WHERE participant_id=$1
      UNION ALL SELECT id FROM ${q(schema, "telemetry_v11_chunks")} WHERE participant_id=$1
      UNION ALL SELECT id FROM ${q(schema, "telemetry_v12_chunks")} WHERE participant_id=$1
    )`, [participantId]);
  }

  const sourceTables = [
    "telemetry_v1_chunks", "telemetry_v11_chunks", "telemetry_v12_chunks",
    "storage_v11_event_sources",
    "telemetry_v1_day_manifests", "telemetry_v11_day_manifests", "telemetry_v12_day_manifests",
    "telemetry_v1_domain_heads", "telemetry_v11_domain_heads", "telemetry_v12_domain_heads",
    "telemetry_v1_domains", "telemetry_v11_domains", "telemetry_v12_domains",
    "telemetry_v1_domain_predecessors", "telemetry_v11_domain_predecessors", "telemetry_v12_domain_predecessors",
    "telemetry_v1_device_consents", "telemetry_v11_device_consents", "telemetry_v12_device_capabilities",
    "telemetry_v1_chunk_admission_windows", "telemetry_transport_participant_floors",
    "telemetry_transport_floor_rollbacks", "accountless_v11_device_authorizations",
    "accountless_v12_device_authorizations",
  ];
  for (const table of sourceTables) {
    if (await tablePresent(client, schema, table)) {
      await client.query(`DELETE FROM ${q(schema, table)} WHERE participant_id=$1`, [participantId]);
    }
  }

  for (const table of ["contributions", "telemetry_contributions", "legacy_sources"]) {
    if (await tablePresent(client, schema, table)) {
      await client.query(`DELETE FROM ${q(schema, table)} WHERE participant_id=$1`, [participantId]);
    }
  }
}

async function deleteAnalyticsRows(
  client: PostgresClient,
  schema: string,
  sourceId: string,
  ownerDigest: string,
): Promise<void> {
  const owners = await client.query<{ owner_digest: string }>(
    `SELECT owner_digest FROM ${q(schema, "analytics_owner_state")}
      WHERE source_id=$1 AND owner_digest=$2 FOR UPDATE`,
    [sourceId, ownerDigest],
  );
  const ownerRows = resultRows(owners);
  for (const row of ownerRows) {
    const persistedOwnerDigest = text(row.owner_digest);
    for (const table of [
      "analytics_prepared_source_rows", "analytics_prepared_source_heads",
      "analytics_analysis_work_parts", "analytics_analysis_work_heads",
    ]) {
      await client.query(
        `DELETE FROM ${q(schema, table)} WHERE source_id=$1 AND owner_digest=$2`,
        [sourceId, persistedOwnerDigest],
      );
    }
  }
  // Publication membership is explicit. A publication with no membership
  // proof blocks erasure instead of being deleted broadly.
  const unscopedPublication = await client.query(`SELECT 1
    FROM ${q(schema, "analytics_publications")} p
    WHERE p.source_id=$1 AND NOT EXISTS (
      SELECT 1 FROM ${q(schema, "analytics_publication_owner_members")} m
       WHERE m.source_id=p.source_id AND m.day=p.day AND m.metric=p.metric
         AND m.generation=p.generation
    ) LIMIT 1`, [sourceId]);
  const unscopedCapture = await client.query(`SELECT 1
    FROM ${q(schema, "analytics_publication_captures")} p
    WHERE p.source_id=$1 AND NOT EXISTS (
      SELECT 1 FROM ${q(schema, "analytics_publication_owner_members")} m
       WHERE m.source_id=p.source_id AND m.day=p.day AND m.metric=p.metric
         AND m.generation=p.generation
    ) LIMIT 1`, [sourceId]);
  if (resultRows(unscopedPublication).length !== 0 || resultRows(unscopedCapture).length !== 0) {
    throw unavailable();
  }
  // Shared aggregate rows remain stored but are invalidated for the erased
  // owner. Physical deletion is guarded by the absence of every other owner
  // member for that same aggregate key.
  await client.query(`INSERT INTO ${q(schema, "analytics_publication_invalidations")}
    (source_id,day,metric,generation,owner_digest,reason,invalidated_at)
    SELECT source_id,day,metric,generation,$2,'owner-erased',clock_timestamp()
      FROM ${q(schema, "analytics_publication_owner_members")}
     WHERE source_id=$1 AND owner_digest=$2
    ON CONFLICT (source_id,day,metric,generation,owner_digest) DO NOTHING`, [sourceId, ownerDigest]);
  await client.query(`WITH doomed AS (
      SELECT m.source_id,m.day,m.metric,m.generation
        FROM ${q(schema, "analytics_publication_owner_members")} m
       WHERE m.source_id=$1 AND m.owner_digest=$2
         AND NOT EXISTS (
           SELECT 1 FROM ${q(schema, "analytics_publication_owner_members")} other
            WHERE other.source_id=m.source_id AND other.day=m.day
              AND other.metric=m.metric AND other.generation=m.generation
              AND other.owner_digest<>m.owner_digest
         )
    ) DELETE FROM ${q(schema, "analytics_publications")} p USING doomed d
       WHERE p.source_id=d.source_id AND p.day=d.day AND p.metric=d.metric
         AND p.generation=d.generation`, [sourceId, ownerDigest]);
  await client.query(`WITH doomed AS (
      SELECT m.source_id,m.day,m.metric,m.generation
        FROM ${q(schema, "analytics_publication_owner_members")} m
       WHERE m.source_id=$1 AND m.owner_digest=$2
         AND NOT EXISTS (
           SELECT 1 FROM ${q(schema, "analytics_publication_owner_members")} other
            WHERE other.source_id=m.source_id AND other.day=m.day
              AND other.metric=m.metric AND other.generation=m.generation
              AND other.owner_digest<>m.owner_digest
         )
    ) DELETE FROM ${q(schema, "analytics_publication_captures")} p USING doomed d
       WHERE p.source_id=d.source_id AND p.day=d.day AND p.metric=d.metric
         AND p.generation=d.generation`, [sourceId, ownerDigest]);
  await client.query(`DELETE FROM ${q(schema, "analytics_publication_owner_members")}
    WHERE source_id=$1 AND owner_digest=$2`, [sourceId, ownerDigest]);
  await client.query(`DELETE FROM ${q(schema, "analytics_owner_state")}
    WHERE source_id=$1 AND owner_digest=$2`, [sourceId, ownerDigest]);
  await client.query(`DELETE FROM ${q(schema, "storage_ingestion_changes")}
    WHERE source_id=$1 AND owner_digest=$2`, [sourceId, ownerDigest]);
  await client.query(`DELETE FROM ${q(schema, "analytics_applied_events")}
    WHERE source_id=$1 AND owner_digest=$2`, [sourceId, ownerDigest]);
}

function canonicalPrimaryStore(
  pool: PostgresPool,
  schema: string,
  options: PostgresCanonicalParticipantErasureOptions,
): ParticipantErasurePrimaryStore {
  return {
    readParticipant(participantId) {
      return read(pool, async (client) => {
        const result = await client.query<Record<string, unknown>>(`
          SELECT p.state,p.deletion_session_id,p.owner_kind,o.enrollment_device_id
            FROM ${q(schema, "participants")} p
            LEFT JOIN ${q(schema, "accountless_upload_owners")} o
              ON o.participant_id=p.id AND o.state='active'
           WHERE p.id=$1`, [participantId]);
        const rows = resultRows(result);
        if (rows.length === 0) return null;
        if (rows.length !== 1) throw unavailable();
        return target(rows[0]!);
      }, options, "erasure.primary.read_participant");
    },

    claimDeletion(participantId, current, operationId, nowEpoch) {
      if (!Number.isSafeInteger(nowEpoch) || !UUID_PATTERN.test(operationId)) {
        throw new TypeError("invalid participant erasure claim");
      }
      return mutate(pool, async (client) => {
        const now = new Date(nowEpoch).toISOString();
        if (current.state === "active") {
          await client.query(`UPDATE ${q(schema, "upload_authorizations")}
             SET state='revoked',revoked_at=$1,consume_lease_expires_at=NULL
           WHERE participant_id=$2 AND state='consuming' AND consume_lease_expires_at<=$1`, [now, participantId]);
          await client.query(`UPDATE ${q(schema, "device_upload_authorizations")}
             SET state='revoked',revoked_at=$1,consume_lease_expires_at=NULL
           WHERE participant_id=$2 AND state='consuming' AND consume_lease_expires_at<=$1`, [now, participantId]);
          const claimed = await client.query(`UPDATE ${q(schema, "participants")}
             SET state='deleting',deletion_session_id=$1
           WHERE id=$2 AND state='active'
             AND NOT EXISTS (SELECT 1 FROM ${q(schema, "upload_authorizations")} WHERE participant_id=$2 AND state='consuming')
             AND NOT EXISTS (SELECT 1 FROM ${q(schema, "device_upload_authorizations")} WHERE participant_id=$2 AND state='consuming')
           RETURNING id`, [operationId, participantId]);
          if (rowCount(claimed) !== 1) {
            const consuming = await client.query<{ total: string }>(`SELECT (
              (SELECT COUNT(*) FROM ${q(schema, "upload_authorizations")} WHERE participant_id=$1 AND state='consuming')+
              (SELECT COUNT(*) FROM ${q(schema, "device_upload_authorizations")} WHERE participant_id=$1 AND state='consuming')
            )::text AS total`, [participantId]);
            const rows = resultRows(consuming);
            if (rows.length !== 1) throw unavailable();
            throw conflict(integer(rows[0]?.total) > 0 ? "UPLOAD_IN_PROGRESS" : "PARTICIPANT_DELETING");
          }
        } else {
          if (!current.deletionFence) throw conflict("PARTICIPANT_DELETING");
          const claimed = await client.query(`UPDATE ${q(schema, "participants")}
             SET deletion_session_id=$1
           WHERE id=$2 AND state='deleting' AND deletion_session_id=$3
             AND NOT EXISTS (SELECT 1 FROM ${q(schema, "admin_action_audit")}
                              WHERE operation_id=$3 AND outcome='started' AND created_at>$4)
           RETURNING id`, [operationId, participantId, current.deletionFence,
            new Date(nowEpoch - 5 * 60 * 1_000).toISOString()]);
          if (rowCount(claimed) !== 1) throw conflict("PARTICIPANT_DELETING");
        }
        await client.query(`UPDATE ${q(schema, "web_sessions")} SET state='revoked',revoked_at=$1
          WHERE participant_id=$2 AND state='active'`, [now, participantId]);
        await client.query(`UPDATE ${q(schema, "device_pairings")} SET state='revoked',revoked_at=$1
          WHERE participant_id=$2 AND state='unused'`, [now, participantId]);
        await client.query(`UPDATE ${q(schema, "device_credentials")} SET state='revoked',revoked_at=$1
          WHERE participant_id=$2 AND state='active'`, [now, participantId]);
        await client.query(`UPDATE ${q(schema, "device_upload_authorizations")} SET state='revoked',revoked_at=$1
          WHERE participant_id=$2 AND state='unused'`, [now, participantId]);
        return operationId;
      }, options, "erasure.primary.claim_deletion");
    },

    assertOwner(participantId, deletionFence) {
      return read(pool, async (client) => {
        const result = await client.query(`SELECT 1 AS allowed FROM ${q(schema, "participants")}
          WHERE id=$1 AND state='deleting' AND deletion_session_id=$2`, [participantId, deletionFence]);
        if (resultRows(result).length !== 1) throw conflict("PARTICIPANT_DELETING");
      }, options, "erasure.primary.assert_owner");
    },

    revokeLegacySessions(participantId, deletionFence, nowEpoch) {
      if (!Number.isSafeInteger(nowEpoch)) throw new TypeError("invalid participant erasure time");
      return mutate(pool, async (client) => {
        const result = await client.query(`UPDATE ${q(schema, "web_sessions")}
          SET state='revoked',revoked_at=$1 WHERE participant_id=$2 AND state='active'
            AND EXISTS (SELECT 1 FROM ${q(schema, "participants")}
              WHERE id=$2 AND state='deleting' AND deletion_session_id=$3)`,
        [new Date(nowEpoch).toISOString(), participantId, deletionFence]);
        rowCount(result);
      }, options, "erasure.primary.revoke_sessions");
    },

    identityLinkKey(participantId, deletionFence) {
      return read(pool, async (client) => {
        const result = await client.query(`SELECT identity_link_key FROM ${q(schema, "participants")}
          WHERE id=$1 AND state='deleting' AND deletion_session_id=$2`, [participantId, deletionFence]);
        const rows = resultRows(result);
        if (rows.length === 0) throw conflict("PARTICIPANT_DELETING");
        if (rows.length !== 1) throw unavailable();
        return optionalText(rows[0]?.identity_link_key);
      }, options, "erasure.primary.identity_link_key");
    },

    countObjects(participantId) {
      return read(pool, async (client) => {
        const values = {
          synthetic: await countSource(client, schema, "synthetic", participantId),
          telemetry: await countSource(client, schema, "telemetry", participantId),
          telemetryV1: await countSource(client, schema, "telemetry_v1", participantId),
          telemetryV11: await countSource(client, schema, "telemetry_v11", participantId),
          telemetryV12: await countSource(client, schema, "telemetry_v12", participantId),
        } satisfies ParticipantErasureCounts;
        if (values.synthetic > MAX_SYNTHETIC_CONTRIBUTIONS_PER_PARTICIPANT) {
          throw new ApiError(500, "INTERNAL_ERROR");
        }
        return values;
      }, options, "erasure.primary.count_objects");
    },

    listObjectPage(participantId, source, cursor, limit) {
      return read(pool, (client) => sourcePage(client, schema, source, participantId, cursor, limit),
        options, "erasure.primary.list_objects");
    },

    finish(participantId, deletionFence) {
      return mutate(pool, async (client) => {
        const owner = await client.query(`SELECT 1 AS allowed FROM ${q(schema, "participants")}
          WHERE id=$1 AND state='deleting' AND deletion_session_id=$2 FOR UPDATE`,
        [participantId, deletionFence]);
        if (resultRows(owner).length !== 1) throw conflict("PARTICIPANT_DELETING");
        const ownership = await client.query<{ source_id: string; owner_digest: string }>(
          `SELECT source.source_id,link.owner_digest
             FROM ${q(schema, "storage_source_state")} source
             JOIN ${q(schema, "storage_v11_owner_links")} link ON link.participant_id=$1
            WHERE source.singleton=1`, [participantId]);
        const ownershipRows = resultRows(ownership);
        if (ownershipRows.length !== 1) throw unavailable();
        await deleteAnalyticsRows(
          client,
          schema,
          text(ownershipRows[0]?.source_id),
          text(ownershipRows[0]?.owner_digest),
        );
        await deleteParticipantRows(client, schema, participantId);
        for (const table of ["upload_authorizations", "device_upload_authorizations",
          "device_pairings", "device_credentials", "web_sessions"]) {
          await client.query(`DELETE FROM ${q(schema, table)} WHERE participant_id=$1`, [participantId]);
        }
        const result = await client.query(`DELETE FROM ${q(schema, "participants")}
          WHERE id=$1 AND state='deleting' AND deletion_session_id=$2 RETURNING id`,
        [participantId, deletionFence]);
        if (rowCount(result) !== 1) throw conflict("PARTICIPANT_DELETING");
      }, options, "erasure.primary.finish");
    },
  };
}

function canonicalLedgerStore(
  pool: PostgresPool,
  schema: string,
  options: PostgresCanonicalParticipantErasureOptions,
): ParticipantErasureLedgerStore {
  return {
    async hasTombstone(participantId, nowEpoch) {
      if (!Number.isSafeInteger(nowEpoch)) throw new TypeError("invalid participant erasure time");
      let digest: string;
      try { digest = await participantDeletionDigest(participantId); } catch { throw ledgerUnavailable(); }
      return read(pool, async (client) => {
        const result = await client.query(`SELECT 1 FROM ${q(schema, "deletion_tombstones")}
          WHERE participant_digest=$1 AND retain_until>$2::timestamptz LIMIT 1`,
        [digest, new Date(nowEpoch)]);
        return resultRows(result).length === 1;
      }, { ...options }, "erasure.ledger.has_tombstone").catch(() => { throw ledgerUnavailable(); });
    },

    async recordTombstone(participantId, nowEpoch) {
      if (!Number.isSafeInteger(nowEpoch)) throw new TypeError("invalid participant erasure time");
      let digest: string;
      try { digest = await participantDeletionDigest(participantId); } catch { throw ledgerUnavailable(); }
      const deletedAt = new Date(nowEpoch);
      const retainUntil = new Date(nowEpoch + DELETION_TOMBSTONE_RETENTION_MILLISECONDS);
      try {
        await mutate(pool, async (client) => {
          await client.query(`INSERT INTO ${q(schema, "deletion_tombstones")}
            (participant_digest,schema_version,deleted_at,retain_until)
            VALUES($1,'participant-deletion-tombstone-v0.1',$2,$3)
            ON CONFLICT(participant_digest) DO UPDATE SET retain_until=GREATEST(
              ${q(schema, "deletion_tombstones")}.retain_until,EXCLUDED.retain_until)`,
          [digest, deletedAt, retainUntil]);
          const result = await client.query(`SELECT participant_digest,retain_until
            FROM ${q(schema, "deletion_tombstones")} WHERE participant_digest=$1`, [digest]);
          const rows = resultRows(result);
          if (rows.length !== 1 || rows[0]?.participant_digest !== digest) throw ledgerUnavailable();
          const actual = rows[0]?.retain_until;
          const actualEpoch = actual instanceof Date ? actual.getTime() : Date.parse(String(actual));
          if (!Number.isFinite(actualEpoch) || actualEpoch < retainUntil.getTime()) throw ledgerUnavailable();
        }, options, "erasure.ledger.record_tombstone");
      } catch (error) {
        if (error instanceof ApiError && error.code === "DELETION_LEDGER_UNAVAILABLE") throw error;
        throw ledgerUnavailable();
      }
    },
  };
}

/** Canonical owner-erasure adapter used by the PostgreSQL Worker backend. */
export function createPostgresParticipantErasureStores(
  primaryPool: PostgresPool,
  ledgerPool: PostgresPool,
  options: PostgresCanonicalParticipantErasureOptions = {},
): PostgresParticipantErasureStores {
  const schemas = createPostgresSchemaConfig(options.schemaOptions);
  return {
    primary: canonicalPrimaryStore(primaryPool, schemas.primarySchema, options),
    ledger: canonicalLedgerStore(ledgerPool, schemas.ledgerSchema, options),
  };
}

export interface PostgresRestoreSuppressionGate {
  /** Check the independent ledger, suppress a restored primary, then report readiness. */
  check(participantId: string, nowEpoch?: number): Promise<
    "clear" | "not_found" | "suppressed" | "already_suppressed"
  >;
  /** Throws before any participant read/upload is admitted. */
  assertReady(participantId: string, nowEpoch?: number): Promise<void>;
}

/**
 * Startup/readiness fence for a primary restore. A primary snapshot can carry
 * an old active participant and admission marker; the independent ledger is
 * consulted first and remains authoritative. Any ledger failure is closed.
 */
export function createPostgresRestoreSuppressionGate(
  primaryPool: PostgresPool,
  ledgerPool: PostgresPool,
  options: PostgresCanonicalParticipantErasureOptions = {},
): PostgresRestoreSuppressionGate {
  const schemas = createPostgresSchemaConfig(options.schemaOptions);
  const primarySchema = schemas.primarySchema;
  const ledgerSchema = schemas.ledgerSchema;

  async function check(participantId: string, nowEpoch = Date.now()): Promise<
    "clear" | "not_found" | "suppressed" | "already_suppressed"
  > {
    if (typeof participantId !== "string" || participantId.length === 0
        || !Number.isSafeInteger(nowEpoch)) throw new TypeError("invalid restore readiness input");
    let digest: string;
    try { digest = await participantDeletionDigest(participantId); } catch { throw ledgerUnavailable(); }
    let tombstone: { retain_until: Date | string } | null;
    try {
      tombstone = await withPostgresRead(ledgerPool, async (client) => {
        const result = await client.query<{ retain_until: Date | string }>(
          `SELECT retain_until FROM ${q(ledgerSchema, "deletion_tombstones")}
            WHERE participant_digest=$1 LIMIT 1`, [digest]);
        const rows = resultRows(result);
        return rows.length === 0 ? null : rows.length === 1 ? rows[0]! : (() => { throw ledgerUnavailable(); })();
      }, optionsFor("restore_gate.ledger.read", options));
    } catch (error) {
      if (error instanceof ApiError && error.code === "DELETION_LEDGER_UNAVAILABLE") throw error;
      throw ledgerUnavailable();
    }
    if (tombstone === null) return "clear";
    const expires = tombstone.retain_until instanceof Date
      ? tombstone.retain_until.getTime()
      : Date.parse(tombstone.retain_until);
    if (!Number.isFinite(expires) || expires <= nowEpoch) return "clear";
    const fence = `${RESTORE_FENCE_PREFIX}${digest}`;
    let status: "not_found" | "suppressed" | "already_suppressed";
    try {
      status = await withPostgresMutation(primaryPool, async (client) => {
        const result = await client.query<Record<string, unknown>>(
          `SELECT state,deletion_session_id FROM ${q(primarySchema, "participants")}
            WHERE id=$1 FOR UPDATE`, [participantId]);
        const rows = resultRows(result);
        if (rows.length === 0) return "not_found";
        if (rows.length !== 1) throw unavailable();
        const state = rows[0]?.state;
        const existingFence = optionalText(rows[0]?.deletion_session_id);
        if (state !== "active" && !(state === "deleting" && existingFence === fence)) {
          throw unavailable();
        }
        const alreadySuppressed = state === "deleting" && existingFence === fence;
        const ownership = await client.query<{ source_id: string; owner_digest: string }>(
          `SELECT source.source_id,link.owner_digest
             FROM ${q(primarySchema, "storage_source_state")} source
             JOIN ${q(primarySchema, "storage_v11_owner_links")} link ON link.participant_id=$1
            WHERE source.singleton=1`, [participantId]);
        const ownershipRows = resultRows(ownership);
        if (ownershipRows.length !== 1) throw unavailable();
        const sourceId = text(ownershipRows[0]?.source_id);
        const ownerDigest = text(ownershipRows[0]?.owner_digest);
        if (!alreadySuppressed) {
          await client.query(`UPDATE ${q(primarySchema, "participants")}
            SET state='deleting',deletion_session_id=$1 WHERE id=$2 AND state='active'`, [fence, participantId]);
        }
        const now = new Date(nowEpoch).toISOString();
        if (!alreadySuppressed) {
          for (const table of ["upload_authorizations", "device_upload_authorizations", "web_sessions",
            "device_pairings", "device_credentials"]) {
            await client.query(`UPDATE ${q(primarySchema, table)} SET state='revoked',revoked_at=$1
              WHERE participant_id=$2 AND state IN ('active','unused','consuming')`, [now, participantId]);
          }
        }
        for (const table of ["telemetry_v1_chunk_admission_windows", "telemetry_v1_device_consents",
          "telemetry_v11_device_consents", "telemetry_v12_device_capabilities"]) {
          if (await tablePresent(client, primarySchema, table)) {
            await client.query(`DELETE FROM ${q(primarySchema, table)} WHERE participant_id=$1`, [participantId]);
          }
        }
        const unscopedPublication = await client.query(`SELECT 1
          FROM ${q(primarySchema, "analytics_publications")} p
          WHERE p.source_id=$1 AND NOT EXISTS (
            SELECT 1 FROM ${q(primarySchema, "analytics_publication_owner_members")} m
             WHERE m.source_id=p.source_id AND m.day=p.day AND m.metric=p.metric
               AND m.generation=p.generation
          ) LIMIT 1`, [sourceId]);
        const unscopedCapture = await client.query(`SELECT 1
          FROM ${q(primarySchema, "analytics_publication_captures")} p
          WHERE p.source_id=$1 AND NOT EXISTS (
            SELECT 1 FROM ${q(primarySchema, "analytics_publication_owner_members")} m
             WHERE m.source_id=p.source_id AND m.day=p.day AND m.metric=p.metric
               AND m.generation=p.generation
          ) LIMIT 1`, [sourceId]);
        if (resultRows(unscopedPublication).length !== 0 || resultRows(unscopedCapture).length !== 0) {
          throw unavailable();
        }
        await client.query(`UPDATE ${q(primarySchema, "analytics_owner_state")}
          SET state='erased' WHERE source_id=$1 AND owner_digest=$2`, [sourceId, ownerDigest]);
        await client.query(`UPDATE ${q(primarySchema, "storage_v11_owner_links")}
          SET state='erased' WHERE participant_id=$1 AND owner_digest=$2`, [participantId, ownerDigest]);
        await client.query(`UPDATE ${q(primarySchema, "analytics_analysis_work_heads")}
          SET state='discarding',claim_token=NULL,lease_expires_ms=NULL
          WHERE source_id=$1 AND owner_digest=$2 AND state NOT IN ('retired','discarding')`, [sourceId, ownerDigest]);
        await client.query(`INSERT INTO ${q(primarySchema, "analytics_publication_invalidations")}
          (source_id,day,metric,generation,owner_digest,reason,invalidated_at)
          SELECT source_id,day,metric,generation,$2,'owner-erased',clock_timestamp()
            FROM ${q(primarySchema, "analytics_publication_owner_members")}
           WHERE source_id=$1 AND owner_digest=$2
          ON CONFLICT (source_id,day,metric,generation,owner_digest) DO NOTHING`, [sourceId, ownerDigest]);
        return alreadySuppressed ? "already_suppressed" : "suppressed";
      }, optionsFor("restore_gate.primary.suppress", options));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw unavailable();
    }
    try {
      const restoreDigest = await participantDeletionDigest(`${participantId}:${expires}`);
      await withPostgresMutation(ledgerPool, async (client) => {
        await client.query(`INSERT INTO ${q(ledgerSchema, "restore_suppression_receipts")}
          (receipt_id,participant_digest,restore_digest,suppressed_at)
          VALUES($1,$2,$3,$4) ON CONFLICT(participant_digest,restore_digest) DO NOTHING`,
        [`${digest}:${restoreDigest}`, digest, restoreDigest, new Date(nowEpoch)]);
      }, optionsFor("restore_gate.ledger.receipt", options));
    } catch {
      throw ledgerUnavailable();
    }
    return status;
  }

  return Object.freeze({
    check,
    async assertReady(participantId: string, nowEpoch = Date.now()): Promise<void> {
      const status = await check(participantId, nowEpoch);
      if (status === "suppressed" || status === "already_suppressed") {
        throw new ApiError(409, "PARTICIPANT_DELETING");
      }
    },
  });
}
