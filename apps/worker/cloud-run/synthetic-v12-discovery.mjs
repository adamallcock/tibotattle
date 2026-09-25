#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { Connector } from "@google-cloud/cloud-sql-connector";
import { withPostgresRead, quotePostgresIdentifier } from "../src/postgres-client.ts";
import {
  closeCloudSqlResources,
  createIamPool as createCloudSqlIamPool,
  normalizeIamUser,
} from "./cloud-sql.mjs";
import { buildPostgresMigrationManifest } from "./postgres-migrations.mjs";
import { CLOUD_RUN_IAM_TEST_TARGET } from "./postgres-test-dispatch.mjs";

export const SYNTHETIC_V12_DISCOVERY_JOB = "tibotattle-v12-synthetic-discovery";
export const SYNTHETIC_V12_DISCOVERY_SERVICE_ACCOUNT =
  "tibotattle-test-runtime@tibotattle.iam.gserviceaccount.com";
export const SYNTHETIC_V12_DISCOVERY_MIGRATION_ROOT = "/app/apps/worker/postgres/migrations";
export const SYNTHETIC_V12_DISCOVERY_PARTICIPANT_PREFIX = "synthetic-v12-smoke-";
export const SYNTHETIC_V12_DISCOVERY_TARGETS = Object.freeze({
  primary: CLOUD_RUN_IAM_TEST_TARGET.postgres.primary,
  ledger: CLOUD_RUN_IAM_TEST_TARGET.postgres.ledger,
  iamUser: CLOUD_RUN_IAM_TEST_TARGET.postgres.iamUser,
  project: CLOUD_RUN_IAM_TEST_TARGET.project,
  origin: CLOUD_RUN_IAM_TEST_TARGET.origin,
  service: CLOUD_RUN_IAM_TEST_TARGET.service,
  bucket: CLOUD_RUN_IAM_TEST_TARGET.gcsBucket,
});

const METADATA_EMAIL_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email";
const EXECUTION_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const MIGRATION_NAME_PATTERN = /^\d{4}_[a-z][a-z0-9_-]*\.sql$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/u;
const INSTANCE_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/u;
const DATABASE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
const PARTICIPANT_ID_PATTERN =
  /^synthetic-v12-smoke-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OWNER_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const V12_CHUNK_ID_PATTERN = /^chunk:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SYNTHETIC_OBJECT_KEY_PATTERN =
  /^telemetry\/v12-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_SYNTHETIC_PARTICIPANTS = 128;
const MAX_PARTICIPANT_TABLES = 256;
const APPLICATION_NAME = "tibotattle-synthetic-v12-discovery";

// Match cleanup's per-owner family envelope. Any new participant-scoped row
// type must be reviewed before discovery reports an owner as a cleanup target.
const ALLOWED_PARTICIPANT_TABLES = Object.freeze({
  attribution_enrollments: [0, 1],
  web_sessions: [1, 1],
  device_pairings: [1, 1],
  device_credentials: [1, 1],
  device_upload_authorizations: [0, 4],
  telemetry_v12_device_capabilities: [1, 1],
  storage_v11_owner_links: [1, 1],
  telemetry_v12_day_manifests: [0, 1],
  telemetry_v12_chunks: [0, 1],
  community_analytical_input_versions: [1, 1],
  input_versions: [0, 1],
  input_source_digests: [0, 1],
  current_queue: [0, 1],
  telemetry_transport_participant_floors: [0, 1],
  telemetry_transport_device_floors: [0, 1],
});

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function failFamilyCount(table, actual, bounds) {
  const code = "POSTGRES_SYNTHETIC_DISCOVERY_FAMILY_INVALID";
  if (!SCHEMA_PATTERN.test(table) || !Number.isSafeInteger(actual) || actual < 0
      || !Array.isArray(bounds) || bounds.length !== 2) fail(code);
  throw Object.assign(new Error(code), {
    code,
    safeFamily: Object.freeze({ table, actual, expectedMinimum: bounds[0], expectedMaximum: bounds[1] }),
  });
}

function preserveDiscoveryError(error) {
  return error instanceof Error
      && error.message === error.code
      && typeof error.code === "string"
      && /^(?:POSTGRES_SYNTHETIC|SYNTHETIC)_DISCOVERY_[A-Z0-9_]+$/u.test(error.code)
    ? error
    : null;
}

function quoteSchema(value) {
  if (typeof value !== "string" || !SCHEMA_PATTERN.test(value)
      || value.startsWith("pg_") || value === "information_schema") {
    fail("SYNTHETIC_DISCOVERY_SCHEMA_INVALID");
  }
  return quotePostgresIdentifier(value);
}

function validateParticipantId(value) {
  if (typeof value !== "string" || !PARTICIPANT_ID_PATTERN.test(value)) {
    fail("SYNTHETIC_DISCOVERY_PARTICIPANT_TAG_INVALID");
  }
  return value;
}

function validateMigrationManifest(manifest) {
  for (const role of ["primary", "ledger"]) {
    const migrations = manifest?.roles?.[role];
    if (!Array.isArray(migrations) || migrations.length === 0 || migrations.length > 256) {
      fail("POSTGRES_SYNTHETIC_DISCOVERY_MIGRATION_SOURCE_INVALID");
    }
    for (let index = 0; index < migrations.length; index += 1) {
      const item = migrations[index];
      if (item?.role !== role || item.version !== index + 1
          || !MIGRATION_NAME_PATTERN.test(item.name ?? "")
          || !Number.isSafeInteger(item.bytes) || item.bytes < 1
          || typeof item.sql !== "string" || Buffer.byteLength(item.sql) !== item.bytes
          || !SHA256_PATTERN.test(item.sha256 ?? "")) {
        fail("POSTGRES_SYNTHETIC_DISCOVERY_MIGRATION_SOURCE_INVALID");
      }
    }
  }
  return manifest;
}

/** Reject wrong Job targets and fan-out before metadata or database access. */
export function parseSyntheticV12DiscoveryConfig(env) {
  if (env === null || typeof env !== "object"
      || env.CLOUD_RUN_JOB !== SYNTHETIC_V12_DISCOVERY_JOB
      || !EXECUTION_PATTERN.test(env.CLOUD_RUN_EXECUTION ?? "")
      || env.CLOUD_RUN_TASK_INDEX !== "0"
      || env.CLOUD_RUN_TASK_COUNT !== "1"
      || env.CLOUD_RUN_TASK_ATTEMPT !== "0"
      || env.GOOGLE_CLOUD_PROJECT !== SYNTHETIC_V12_DISCOVERY_TARGETS.project
      || env.K_SERVICE !== undefined) {
    fail("CLOUD_RUN_SYNTHETIC_DISCOVERY_JOB_CONTEXT_INVALID");
  }
  if (env.CLOUD_RUN_TEST_SERVICE !== SYNTHETIC_V12_DISCOVERY_TARGETS.service
      || env.HOST_ORIGIN !== SYNTHETIC_V12_DISCOVERY_TARGETS.origin) {
    fail("CLOUD_RUN_SYNTHETIC_DISCOVERY_SERVICE_INVALID");
  }
  if (normalizeIamUser(env.POSTGRES_IAM_USER, "POSTGRES_IAM_USER")
      !== SYNTHETIC_V12_DISCOVERY_TARGETS.iamUser) {
    fail("POSTGRES_SYNTHETIC_DISCOVERY_IAM_USER_INVALID");
  }

  const primary = SYNTHETIC_V12_DISCOVERY_TARGETS.primary;
  const ledger = SYNTHETIC_V12_DISCOVERY_TARGETS.ledger;
  if (env.PRIMARY_INSTANCE_CONNECTION_NAME !== primary.instanceConnectionName
      || env.PRIMARY_DATABASE !== primary.database || env.PRIMARY_SCHEMA !== primary.schema
      || env.LEDGER_INSTANCE_CONNECTION_NAME !== ledger.instanceConnectionName
      || env.LEDGER_DATABASE !== ledger.database || env.LEDGER_SCHEMA !== ledger.schema
      || !SCHEMA_PATTERN.test(env.PRIMARY_SCHEMA ?? "")
      || !SCHEMA_PATTERN.test(env.LEDGER_SCHEMA ?? "")
      || !INSTANCE_PATTERN.test(env.PRIMARY_INSTANCE_CONNECTION_NAME ?? "")
      || !INSTANCE_PATTERN.test(env.LEDGER_INSTANCE_CONNECTION_NAME ?? "")
      || !DATABASE_PATTERN.test(env.PRIMARY_DATABASE ?? "")
      || !DATABASE_PATTERN.test(env.LEDGER_DATABASE ?? "")) {
    fail("POSTGRES_SYNTHETIC_DISCOVERY_TARGET_INVALID");
  }
  if (env.GCS_BUCKET_NAME !== SYNTHETIC_V12_DISCOVERY_TARGETS.bucket) {
    fail("GCS_SYNTHETIC_DISCOVERY_BUCKET_INVALID");
  }
  return Object.freeze({
    job: SYNTHETIC_V12_DISCOVERY_JOB,
    execution: env.CLOUD_RUN_EXECUTION,
    project: SYNTHETIC_V12_DISCOVERY_TARGETS.project,
    service: SYNTHETIC_V12_DISCOVERY_TARGETS.service,
    origin: SYNTHETIC_V12_DISCOVERY_TARGETS.origin,
    primary,
    ledger,
    iamUser: SYNTHETIC_V12_DISCOVERY_TARGETS.iamUser,
    bucket: SYNTHETIC_V12_DISCOVERY_TARGETS.bucket,
  });
}

export async function readAttachedSyntheticDiscoveryServiceAccount({
  fetchImpl = globalThis.fetch,
  timeoutMilliseconds = 3_000,
} = {}) {
  if (typeof fetchImpl !== "function"
      || !Number.isSafeInteger(timeoutMilliseconds)
      || timeoutMilliseconds < 1 || timeoutMilliseconds > 10_000) {
    fail("CLOUD_RUN_SYNTHETIC_DISCOVERY_METADATA_UNAVAILABLE");
  }
  let response;
  try {
    response = await fetchImpl(METADATA_EMAIL_URL, {
      method: "GET",
      headers: { "Metadata-Flavor": "Google" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
  } catch {
    fail("CLOUD_RUN_SYNTHETIC_DISCOVERY_METADATA_UNAVAILABLE");
  }
  if (response?.status !== 200
      || response.headers?.get("Metadata-Flavor") !== "Google") {
    fail("CLOUD_RUN_SYNTHETIC_DISCOVERY_METADATA_UNAVAILABLE");
  }
  let email;
  try { email = (await response.text()).trim(); } catch {
    fail("CLOUD_RUN_SYNTHETIC_DISCOVERY_METADATA_UNAVAILABLE");
  }
  if (email !== SYNTHETIC_V12_DISCOVERY_SERVICE_ACCOUNT) {
    fail("CLOUD_RUN_SYNTHETIC_DISCOVERY_SERVICE_ACCOUNT_INVALID");
  }
  return email;
}

function parseRows(result, code) {
  if (result === null || typeof result !== "object" || !Array.isArray(result.rows)) fail(code);
  return result.rows;
}

function parseCount(value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    fail("POSTGRES_SYNTHETIC_DISCOVERY_READBACK_INVALID");
  }
  return number;
}

function validateMigrationRows(rows, migrations) {
  if (!Array.isArray(rows) || rows.length !== migrations.length) {
    fail("POSTGRES_SYNTHETIC_DISCOVERY_MIGRATION_RECEIPT_MISMATCH");
  }
  for (let index = 0; index < migrations.length; index += 1) {
    const actual = rows[index];
    const expected = migrations[index];
    if (actual?.version !== expected.version || actual?.name !== expected.name
        || actual?.checksum_sha256 !== expected.sha256) {
      fail("POSTGRES_SYNTHETIC_DISCOVERY_MIGRATION_RECEIPT_MISMATCH");
    }
  }
}

async function readSnapshotStart(client) {
  const rows = parseRows(await client.query(
    `SELECT current_setting('server_version_num')::integer AS server_version_num,
            transaction_timestamp()::text AS observed_at`,
  ), "POSTGRES_SYNTHETIC_DISCOVERY_READBACK_INVALID");
  if (rows.length !== 1
      || Math.floor(Number(rows[0]?.server_version_num) / 10_000) !== 17
      || typeof rows[0]?.observed_at !== "string"
      || !Number.isFinite(Date.parse(rows[0].observed_at))) {
    fail("POSTGRES_SYNTHETIC_DISCOVERY_POSTGRES_VERSION_UNSUPPORTED");
  }
  return Object.freeze({ observedAt: new Date(rows[0].observed_at).toISOString() });
}

async function readMigrationReceipt(client, schema, migrations) {
  const table = `${quoteSchema(schema)}."_tibotattle_migration_history"`;
  const result = await client.query(
    `SELECT version, name, checksum_sha256 FROM ${table} ORDER BY version`,
  );
  validateMigrationRows(parseRows(result, "POSTGRES_SYNTHETIC_DISCOVERY_MIGRATION_RECEIPT_MISMATCH"), migrations);
}

async function readParticipantFamily(client, schema, participantId) {
  const catalog = parseRows(await client.query(
    `SELECT DISTINCT columns.table_name
       FROM information_schema.columns columns
       JOIN information_schema.tables tables
         ON tables.table_schema = columns.table_schema
        AND tables.table_name = columns.table_name
        AND tables.table_type = 'BASE TABLE'
      WHERE columns.table_schema = $1 AND columns.column_name = 'participant_id'
      ORDER BY columns.table_name`,
    [schema],
  ), "POSTGRES_SYNTHETIC_DISCOVERY_FAMILY_INVALID");
  if (catalog.length === 0 || catalog.length > MAX_PARTICIPANT_TABLES) {
    fail("POSTGRES_SYNTHETIC_DISCOVERY_FAMILY_INVALID");
  }
  const names = catalog.map((row) => row.table_name);
  if (names.some((name) => typeof name !== "string" || !SCHEMA_PATTERN.test(name))) {
    fail("POSTGRES_SYNTHETIC_DISCOVERY_FAMILY_INVALID");
  }
  const required = [
    "web_sessions", "device_pairings", "device_credentials",
    "device_upload_authorizations", "telemetry_v12_device_capabilities",
    "storage_v11_owner_links", "telemetry_v12_day_manifests", "telemetry_v12_chunks",
  ];
  if (required.some((name) => !names.includes(name))) {
    fail("POSTGRES_SYNTHETIC_DISCOVERY_FAMILY_INVALID");
  }
  const countsSql = names.map((name) =>
    `SELECT '${name}'::text AS table_name, count(*)::text AS row_count
       FROM ${quoteSchema(schema)}.${quotePostgresIdentifier(name)} WHERE participant_id = $1`,
  ).join(" UNION ALL ");
  const rows = parseRows(await client.query(countsSql, [participantId]), "POSTGRES_SYNTHETIC_DISCOVERY_FAMILY_INVALID");
  if (rows.length !== names.length) fail("POSTGRES_SYNTHETIC_DISCOVERY_FAMILY_INVALID");
  for (const row of rows) {
    const count = parseCount(row.row_count);
    const bounds = Object.hasOwn(ALLOWED_PARTICIPANT_TABLES, row.table_name)
      ? ALLOWED_PARTICIPANT_TABLES[row.table_name]
      : [0, 0];
    if (count < bounds[0] || count > bounds[1]) {
      failFamilyCount(row.table_name, count, bounds);
    }
  }
}

async function readOwnerReferences(client, schema, participant) {
  validateParticipantId(participant.id);
  if (participant.owner_kind !== "social" || participant.identity_link_key !== null
      || participant.state !== "active") {
    fail("SYNTHETIC_DISCOVERY_OWNER_STATE_UNEXPECTED");
  }
  await readParticipantFamily(client, schema, participant.id);

  const ownerRows = parseRows(await client.query(
    `SELECT owner_digest, state FROM ${quoteSchema(schema)}."storage_v11_owner_links"
      WHERE participant_id = $1`,
    [participant.id],
  ), "POSTGRES_SYNTHETIC_DISCOVERY_OWNER_LINK_INVALID");
  if (ownerRows.length !== 1 || !OWNER_DIGEST_PATTERN.test(ownerRows[0]?.owner_digest ?? "")
      || ownerRows[0]?.state !== "active") {
    fail("SYNTHETIC_DISCOVERY_OWNER_LINK_INVALID");
  }

  const consumingRows = parseRows(await client.query(
    `SELECT count(*)::text AS row_count FROM ${quoteSchema(schema)}."device_upload_authorizations"
      WHERE participant_id = $1 AND state = 'consuming'`,
    [participant.id],
  ), "POSTGRES_SYNTHETIC_DISCOVERY_AUTHORIZATION_INVALID");
  if (consumingRows.length !== 1 || parseCount(consumingRows[0]?.row_count) !== 0) {
    fail("SYNTHETIC_DISCOVERY_UPLOAD_IN_PROGRESS");
  }

  const manifests = parseRows(await client.query(
    `SELECT id, expected_chunk_count, state
       FROM ${quoteSchema(schema)}."telemetry_v12_day_manifests"
      WHERE participant_id = $1 ORDER BY id`,
    [participant.id],
  ), "POSTGRES_SYNTHETIC_DISCOVERY_MANIFEST_INVALID");
  const chunks = parseRows(await client.query(
    `SELECT id, manifest_id, participant_id, r2_key
       FROM ${quoteSchema(schema)}."telemetry_v12_chunks"
      WHERE participant_id = $1 ORDER BY id`,
    [participant.id],
  ), "POSTGRES_SYNTHETIC_DISCOVERY_CHUNK_INVALID");
  if (manifests.length > 1 || chunks.length > 1
      || manifests.length === 0 && chunks.length !== 0
      || chunks.length > 0 && manifests.length !== 1) {
    fail("SYNTHETIC_DISCOVERY_V12_FAMILY_UNSUPPORTED");
  }
  if (manifests.length === 1) {
    const expected = parseCount(manifests[0]?.expected_chunk_count);
    if (manifests[0]?.state !== "ready" || expected !== chunks.length) {
      fail("SYNTHETIC_DISCOVERY_V12_FAMILY_UNSUPPORTED");
    }
  }
  if (chunks.length === 1) {
    const chunk = chunks[0];
    if (!V12_CHUNK_ID_PATTERN.test(chunk?.id ?? "")
        || chunk?.manifest_id !== manifests[0]?.id
        || chunk?.participant_id !== participant.id
        || typeof chunk?.r2_key !== "string"
        || !SYNTHETIC_OBJECT_KEY_PATTERN.test(chunk.r2_key)) {
      fail("SYNTHETIC_DISCOVERY_V12_REFERENCE_INVALID");
    }
  }

  const pending = chunks.length === 0 ? [] : parseRows(await client.query(
    `SELECT contribution_id, object_key, object_kind, reconciliation_state
       FROM ${quoteSchema(schema)}."pending_objects"
      WHERE contribution_id = $1`,
    [chunks[0].id],
  ), "POSTGRES_SYNTHETIC_DISCOVERY_PENDING_REFERENCE_INVALID");
  if (pending.length !== chunks.length
      || pending.some((row) => row.contribution_id !== chunks[0]?.id
        || row.object_key !== chunks[0]?.r2_key
        || row.object_kind !== "telemetry_v12"
        || row.reconciliation_state !== "registered")) {
    fail("SYNTHETIC_DISCOVERY_PENDING_REFERENCE_INVALID");
  }
  return Object.freeze({
    owner: Object.freeze({
      participantId: participant.id,
      referencedGcsObjectCount: chunks.length,
      registeredPendingReferenceCount: pending.length,
    }),
    // Keep opaque provider keys in memory only so references shared between
    // synthetic owners cannot be mistaken for independently erasable data.
    objectKeys: Object.freeze(chunks.map((chunk) => chunk.r2_key)),
  });
}

/** Inventory only the synthetic v1.2 participant family inside one read-only snapshot. */
export async function readSyntheticV12PrimarySnapshot(pool, schema, migrations) {
  const quotedSchema = quoteSchema(schema);
  let snapshot;
  try {
    snapshot = await withPostgresRead(pool, async (client) => {
      const start = await readSnapshotStart(client);
      await readMigrationReceipt(client, schema, migrations);
      const participants = parseRows(await client.query(
        `SELECT id, state, owner_kind, identity_link_key
           FROM ${quotedSchema}."participants"
          WHERE left(id, length($1)) = $1 ORDER BY id LIMIT $2`,
        [SYNTHETIC_V12_DISCOVERY_PARTICIPANT_PREFIX, MAX_SYNTHETIC_PARTICIPANTS + 1],
      ), "POSTGRES_SYNTHETIC_DISCOVERY_PARTICIPANT_READ_FAILED");
      if (participants.length > MAX_SYNTHETIC_PARTICIPANTS) {
        fail("SYNTHETIC_DISCOVERY_PARTICIPANT_LIMIT_EXCEEDED");
      }
      for (const participant of participants) validateParticipantId(participant.id);

      const owners = [];
      const objectKeys = new Set();
      for (const participant of participants) {
        const inventory = await readOwnerReferences(client, schema, participant);
        for (const key of inventory.objectKeys) {
          if (objectKeys.has(key)) fail("SYNTHETIC_DISCOVERY_V12_REFERENCE_SHARED");
          objectKeys.add(key);
        }
        owners.push(inventory.owner);
      }
      const unattributableRows = parseRows(await client.query(
        `SELECT count(*)::text AS row_count
           FROM ${quotedSchema}."pending_objects" pending
          WHERE pending.object_kind = 'telemetry_v12'
            AND NOT EXISTS (
              SELECT 1 FROM ${quotedSchema}."telemetry_v12_chunks" chunk
               WHERE chunk.id = pending.contribution_id AND chunk.r2_key = pending.object_key
            )`,
      ), "POSTGRES_SYNTHETIC_DISCOVERY_PENDING_REFERENCE_INVALID");
      if (unattributableRows.length !== 1
          || parseCount(unattributableRows[0]?.row_count) !== 0) {
        fail("SYNTHETIC_DISCOVERY_PENDING_REFERENCE_UNATTRIBUTABLE");
      }
      const referencedGcsObjectCount = owners.reduce(
        (total, owner) => total + owner.referencedGcsObjectCount,
        0,
      );
      const registeredPendingReferenceCount = owners.reduce(
        (total, owner) => total + owner.registeredPendingReferenceCount,
        0,
      );
      if (referencedGcsObjectCount !== registeredPendingReferenceCount) {
        fail("SYNTHETIC_DISCOVERY_PENDING_REFERENCE_UNATTRIBUTABLE");
      }
      return Object.freeze({
        observedAt: start.observedAt,
        owners: Object.freeze(owners),
        referencedGcsObjectCount,
        registeredPendingReferenceCount,
        unattributablePendingReferenceCount: 0,
      });
    }, {
      operation: "postgres.synthetic_v12_discovery.primary_snapshot",
      statementTimeoutMilliseconds: 30_000,
      lockTimeoutMilliseconds: 5_000,
      preserveSafeError: preserveDiscoveryError,
    });
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("SYNTHETIC_DISCOVERY_")) throw error;
    if (typeof error?.code === "string" && error.code.startsWith("POSTGRES_SYNTHETIC_DISCOVERY_")) throw error;
    fail("POSTGRES_SYNTHETIC_DISCOVERY_READ_FAILED");
  }
  return snapshot;
}

/** Validate one separate read-only ledger migration snapshot. */
export async function readSyntheticV12LedgerSnapshot(pool, schema, migrations) {
  quoteSchema(schema);
  try {
    return await withPostgresRead(pool, async (client) => {
      const start = await readSnapshotStart(client);
      await readMigrationReceipt(client, schema, migrations);
      return Object.freeze({ observedAt: start.observedAt, migrationReceiptMatched: true });
    }, {
      operation: "postgres.synthetic_v12_discovery.ledger_snapshot",
      statementTimeoutMilliseconds: 10_000,
      lockTimeoutMilliseconds: 5_000,
      preserveSafeError: preserveDiscoveryError,
    });
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("SYNTHETIC_DISCOVERY_")) throw error;
    if (typeof error?.code === "string" && error.code.startsWith("POSTGRES_SYNTHETIC_DISCOVERY_")) throw error;
    fail("POSTGRES_SYNTHETIC_DISCOVERY_LEDGER_READ_FAILED");
  }
}

/** Read both database snapshots with the pinned IAM identity; this function has no object-store adapter. */
export async function runSyntheticV12Discovery({ env = process.env, dependencies = {} } = {}) {
  if (env === null || typeof env !== "object"
      || env.CLOUD_RUN_JOB !== SYNTHETIC_V12_DISCOVERY_JOB
      || !EXECUTION_PATTERN.test(env.CLOUD_RUN_EXECUTION ?? "")
      || env.CLOUD_RUN_TASK_INDEX !== "0" || env.CLOUD_RUN_TASK_COUNT !== "1"
      || env.CLOUD_RUN_TASK_ATTEMPT !== "0"
      || env.GOOGLE_CLOUD_PROJECT !== SYNTHETIC_V12_DISCOVERY_TARGETS.project
      || env.K_SERVICE !== undefined) {
    fail("CLOUD_RUN_SYNTHETIC_DISCOVERY_JOB_CONTEXT_INVALID");
  }
  const attachedServiceAccountEmail = await (dependencies.readServiceAccountEmail
    ?? readAttachedSyntheticDiscoveryServiceAccount)({ fetchImpl: dependencies.fetchImpl });
  if (attachedServiceAccountEmail !== SYNTHETIC_V12_DISCOVERY_SERVICE_ACCOUNT) {
    fail("CLOUD_RUN_SYNTHETIC_DISCOVERY_SERVICE_ACCOUNT_INVALID");
  }
  const config = parseSyntheticV12DiscoveryConfig(env);

  let manifest;
  try {
    manifest = validateMigrationManifest(await (dependencies.buildManifest ?? buildPostgresMigrationManifest)({
      rootDirectory: SYNTHETIC_V12_DISCOVERY_MIGRATION_ROOT,
    }));
  } catch (error) {
    if (typeof error?.code === "string"
        && error.code.startsWith("POSTGRES_SYNTHETIC_DISCOVERY_")) throw error;
    fail("POSTGRES_SYNTHETIC_DISCOVERY_MIGRATION_SOURCE_INVALID");
  }

  const connector = await (dependencies.createConnector ?? (() => new Connector()))();
  const pools = [];
  let operationError;
  let result;
  try {
    const createPool = dependencies.createPool ?? createCloudSqlIamPool;
    const primaryPool = await createPool({
      connector,
      instanceConnectionName: config.primary.instanceConnectionName,
      database: config.primary.database,
      user: config.iamUser,
      max: 1,
      applicationName: APPLICATION_NAME,
    });
    pools.push(primaryPool);
    const ledgerPool = await createPool({
      connector,
      instanceConnectionName: config.ledger.instanceConnectionName,
      database: config.ledger.database,
      user: config.iamUser,
      max: 1,
      applicationName: APPLICATION_NAME,
    });
    pools.push(ledgerPool);
    const primary = await (dependencies.readPrimarySnapshot ?? readSyntheticV12PrimarySnapshot)(
      primaryPool, config.primary.schema, manifest.roles.primary,
    );
    const ledger = await (dependencies.readLedgerSnapshot ?? readSyntheticV12LedgerSnapshot)(
      ledgerPool, config.ledger.schema, manifest.roles.ledger,
    );
    result = Object.freeze({
      schemaVersion: "synthetic-v12-owner-discovery-v1",
      status: "ready",
      primarySnapshotObservedAt: primary.observedAt,
      ledgerMigrationSnapshotObservedAt: ledger.observedAt,
      ownerCount: primary.owners.length,
      owners: primary.owners,
      referencedGcsObjectCount: primary.referencedGcsObjectCount,
      registeredPendingReferenceCount: primary.registeredPendingReferenceCount,
      unattributablePendingReferenceCount: primary.unattributablePendingReferenceCount,
    });
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await (dependencies.closeResources ?? closeCloudSqlResources)({ pools, connector });
    } catch {
      operationError ??= Object.assign(new Error("CLOUD_SQL_SYNTHETIC_DISCOVERY_CLOSE_FAILED"), {
        code: "CLOUD_SQL_SYNTHETIC_DISCOVERY_CLOSE_FAILED",
      });
    }
  }
  if (operationError) throw operationError;
  return result;
}

function safeCode(error) {
  return typeof error?.code === "string"
      && /^(?:CLOUD_RUN|CLOUD_SQL|GCS|POSTGRES|SYNTHETIC)_[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : "SYNTHETIC_DISCOVERY_FAILED";
}

async function main() {
  if (process.argv.length !== 2) fail("CLOUD_RUN_SYNTHETIC_DISCOVERY_ARGUMENTS_INVALID");
  try {
    const inventory = await runSyntheticV12Discovery();
    console.log(JSON.stringify(inventory));
  } catch (error) {
    console.error(JSON.stringify({
      schemaVersion: "synthetic-v12-owner-discovery-v1",
      status: "error",
      code: safeCode(error),
      ...(error?.code === "POSTGRES_SYNTHETIC_DISCOVERY_FAMILY_INVALID"
        && error?.safeFamily ? { safeFamily: error.safeFamily } : {}),
    }));
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
