#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Connector } from "@google-cloud/cloud-sql-connector";
import { GcsErasureObjectStore, createGcsErasureBucketHistoryProof } from "../src/gcs-erasure-object-store.ts";
import { eraseSyntheticPostgresV12Owner } from "../src/postgres-owner-erasure.ts";
import { withPostgresRead } from "../src/postgres-client.ts";
import {
  closeCloudSqlResources,
  createIamPool as createCloudSqlIamPool,
  createGoogleAccessTokenProvider,
  normalizeIamUser,
} from "./cloud-sql.mjs";
import { buildPostgresMigrationManifest } from "./postgres-migrations.mjs";
import { CLOUD_RUN_IAM_TEST_TARGET } from "./postgres-test-dispatch.mjs";

export const SYNTHETIC_V12_CLEANUP_JOB = "tibotattle-v12-synthetic-cleanup";
export const SYNTHETIC_V12_CLEANUP_SERVICE_ACCOUNT =
  "tibotattle-test-runtime@tibotattle.iam.gserviceaccount.com";
export const SYNTHETIC_V12_CLEANUP_MIGRATION_ROOT = "/app/apps/worker/postgres/migrations";
export const SYNTHETIC_V12_CLEANUP_PARTICIPANT_PREFIX = "synthetic-v12-smoke-";
export const SYNTHETIC_V12_CLEANUP_SERVICE = CLOUD_RUN_IAM_TEST_TARGET.service;
export const SYNTHETIC_V12_CLEANUP_TARGETS = Object.freeze({
  primary: CLOUD_RUN_IAM_TEST_TARGET.postgres.primary,
  ledger: CLOUD_RUN_IAM_TEST_TARGET.postgres.ledger,
  iamUser: CLOUD_RUN_IAM_TEST_TARGET.postgres.iamUser,
  project: CLOUD_RUN_IAM_TEST_TARGET.project,
  origin: CLOUD_RUN_IAM_TEST_TARGET.origin,
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
const EXPECTED_MIGRATION_SHAPES = Object.freeze({
  primary: Object.freeze({ count: 58, tail: "0058_owner_journal_emitter_head_precheck.sql" }),
  ledger: Object.freeze({ count: 7, tail: "0007_production_transfer_control.sql" }),
});
const APPLICATION_NAME = "tibotattle-synthetic-v12-cleanup";

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function quoteSchema(value) {
  if (typeof value !== "string" || !SCHEMA_PATTERN.test(value)
      || value.startsWith("pg_") || value === "information_schema") {
    fail("SYNTHETIC_CLEANUP_SCHEMA_INVALID");
  }
  return `"${value}"`;
}

function validateParticipantId(value) {
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  if (typeof value !== "string" || !value.startsWith(SYNTHETIC_V12_CLEANUP_PARTICIPANT_PREFIX)
      || !uuidV4.test(value.slice(SYNTHETIC_V12_CLEANUP_PARTICIPANT_PREFIX.length))) {
    fail("SYNTHETIC_CLEANUP_PARTICIPANT_INVALID");
  }
  return value;
}

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectedBucketCreateRequest(bucket) {
  return {
    name: bucket,
    location: "US-EAST1",
    storageClass: "STANDARD",
    iamConfiguration: {
      uniformBucketLevelAccess: { enabled: true },
      publicAccessPrevention: "enforced",
    },
    softDeletePolicy: { retentionDurationSeconds: "0" },
    versioning: { enabled: false },
  };
}

function validateBucketProof(value, expectedBucket) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { fail("SYNTHETIC_CLEANUP_BUCKET_PROOF_INVALID"); }
  try {
    if (!record(parsed)
        || parsed.schemaVersion !== "gcs-erasure-bucket-history-receipt-v1"
        || parsed.source !== "storage.buckets.insert"
        || parsed.project !== SYNTHETIC_V12_CLEANUP_TARGETS.project
        || parsed.projectNumber !== "806510610397"
        || !SHA256_PATTERN.test(parsed.creationRequestSha256 ?? "")
        || !SHA256_PATTERN.test(parsed.creationResponseSha256 ?? "")
        || parsed.creationRequestSha256 !== createHash("sha256")
          .update(JSON.stringify(expectedBucketCreateRequest(expectedBucket))).digest("hex")
        || !record(parsed.creationResponse)) {
      fail("SYNTHETIC_CLEANUP_BUCKET_PROOF_INVALID");
    }
    const response = parsed.creationResponse;
    const allowedFields = [
      "bucket", "projectNumber", "bucketGeneration", "bucketMetageneration", "location", "timeCreated",
      "softDeleteRetentionDurationSeconds", "iamConfiguration", "versioningEnabled",
    ].sort();
    if (Object.keys(response).sort().join("\n") !== allowedFields.join("\n")
        || response.bucket !== expectedBucket
        || response.projectNumber !== "806510610397"
        || response.bucketMetageneration !== "1"
        || response.location !== "US-EAST1"
        || response.softDeleteRetentionDurationSeconds !== "0"
        || !record(response.iamConfiguration)
        || Object.keys(response.iamConfiguration).sort().join("\n")
          !== "publicAccessPrevention\nuniformBucketLevelAccess"
        || response.iamConfiguration.publicAccessPrevention !== "enforced"
        || response.iamConfiguration.uniformBucketLevelAccess !== true
        || response.versioningEnabled !== false
        || typeof response.timeCreated !== "string"
        || !Number.isFinite(Date.parse(response.timeCreated))
        || createHash("sha256").update(JSON.stringify(response)).digest("hex")
          !== parsed.creationResponseSha256) {
      fail("SYNTHETIC_CLEANUP_BUCKET_PROOF_INVALID");
    }
    const proof = createGcsErasureBucketHistoryProof(parsed.proof);
    if (proof.bucket !== expectedBucket
        || proof.bucketGeneration !== response.bucketGeneration
        || proof.bucketMetageneration !== response.bucketMetageneration
        || proof.softDeleteRetentionDurationSeconds
          !== response.softDeleteRetentionDurationSeconds) {
      fail("SYNTHETIC_CLEANUP_BUCKET_PROOF_INVALID");
    }
    return proof;
  } catch {
    fail("SYNTHETIC_CLEANUP_BUCKET_PROOF_INVALID");
  }
}

/** Reject wrong targets and task fan-out before metadata, SQL, or GCS access. */
export function parseSyntheticV12CleanupConfig(env, attachedServiceAccountEmail) {
  if (env === null || typeof env !== "object"
      || env.CLOUD_RUN_JOB !== SYNTHETIC_V12_CLEANUP_JOB
      || !EXECUTION_PATTERN.test(env.CLOUD_RUN_EXECUTION ?? "")
      || env.CLOUD_RUN_TASK_INDEX !== "0"
      || env.CLOUD_RUN_TASK_COUNT !== "1"
      || env.CLOUD_RUN_TASK_ATTEMPT !== "0"
      || env.GOOGLE_CLOUD_PROJECT !== SYNTHETIC_V12_CLEANUP_TARGETS.project
      || env.K_SERVICE !== undefined) {
    fail("CLOUD_RUN_SYNTHETIC_CLEANUP_JOB_CONTEXT_INVALID");
  }
  if (env.CLOUD_RUN_TEST_SERVICE !== SYNTHETIC_V12_CLEANUP_SERVICE
      || env.HOST_ORIGIN !== SYNTHETIC_V12_CLEANUP_TARGETS.origin) {
    fail("CLOUD_RUN_SYNTHETIC_CLEANUP_SERVICE_INVALID");
  }
  if (attachedServiceAccountEmail !== SYNTHETIC_V12_CLEANUP_SERVICE_ACCOUNT) {
    fail("CLOUD_RUN_SYNTHETIC_CLEANUP_SERVICE_ACCOUNT_INVALID");
  }
  if (normalizeIamUser(env.POSTGRES_IAM_USER, "POSTGRES_IAM_USER")
      !== SYNTHETIC_V12_CLEANUP_TARGETS.iamUser) {
    fail("POSTGRES_SYNTHETIC_CLEANUP_IAM_USER_INVALID");
  }

  const primary = SYNTHETIC_V12_CLEANUP_TARGETS.primary;
  const ledger = SYNTHETIC_V12_CLEANUP_TARGETS.ledger;
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
    fail("POSTGRES_SYNTHETIC_CLEANUP_TARGET_INVALID");
  }
  if (env.GCS_BUCKET_NAME !== SYNTHETIC_V12_CLEANUP_TARGETS.bucket) {
    fail("GCS_SYNTHETIC_CLEANUP_BUCKET_INVALID");
  }
  const historyProof = validateBucketProof(env.GCS_ERASURE_BUCKET_HISTORY_PROOF, env.GCS_BUCKET_NAME);
  const participantId = validateParticipantId(env.SYNTHETIC_V12_CLEANUP_PARTICIPANT_ID);
  return Object.freeze({
    job: SYNTHETIC_V12_CLEANUP_JOB,
    execution: env.CLOUD_RUN_EXECUTION,
    project: SYNTHETIC_V12_CLEANUP_TARGETS.project,
    service: SYNTHETIC_V12_CLEANUP_SERVICE,
    origin: SYNTHETIC_V12_CLEANUP_TARGETS.origin,
    primary,
    ledger,
    iamUser: SYNTHETIC_V12_CLEANUP_TARGETS.iamUser,
    bucket: env.GCS_BUCKET_NAME,
    historyProof,
    participantId,
  });
}

export async function readAttachedSyntheticCleanupServiceAccount({
  fetchImpl = globalThis.fetch,
  timeoutMilliseconds = 3_000,
} = {}) {
  if (typeof fetchImpl !== "function"
      || !Number.isSafeInteger(timeoutMilliseconds)
      || timeoutMilliseconds < 1 || timeoutMilliseconds > 10_000) {
    fail("CLOUD_RUN_SYNTHETIC_CLEANUP_METADATA_UNAVAILABLE");
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
    fail("CLOUD_RUN_SYNTHETIC_CLEANUP_METADATA_UNAVAILABLE");
  }
  if (response?.status !== 200
      || response.headers?.get("Metadata-Flavor") !== "Google") {
    fail("CLOUD_RUN_SYNTHETIC_CLEANUP_METADATA_UNAVAILABLE");
  }
  let email;
  try { email = (await response.text()).trim(); } catch {
    fail("CLOUD_RUN_SYNTHETIC_CLEANUP_METADATA_UNAVAILABLE");
  }
  if (email !== SYNTHETIC_V12_CLEANUP_SERVICE_ACCOUNT) {
    fail("CLOUD_RUN_SYNTHETIC_CLEANUP_SERVICE_ACCOUNT_INVALID");
  }
  return email;
}

function validateMigrations(manifest) {
  for (const [role, shape] of Object.entries(EXPECTED_MIGRATION_SHAPES)) {
    const entries = manifest?.roles?.[role];
    if (!Array.isArray(entries) || entries.length !== shape.count
        || entries.at(-1)?.name !== shape.tail) {
      fail("POSTGRES_SYNTHETIC_CLEANUP_MIGRATION_SOURCE_INVALID");
    }
    for (let index = 0; index < entries.length; index += 1) {
      const item = entries[index];
      if (item?.role !== role || item.version !== index + 1
          || !MIGRATION_NAME_PATTERN.test(item.name ?? "")
          || !Number.isSafeInteger(item.bytes) || item.bytes < 1
          || typeof item.sql !== "string" || Buffer.byteLength(item.sql) !== item.bytes
          || !SHA256_PATTERN.test(item.sha256 ?? "")) {
        fail("POSTGRES_SYNTHETIC_CLEANUP_MIGRATION_SOURCE_INVALID");
      }
    }
  }
  return manifest;
}

async function verifyPostgres17MigrationReceipt(pool, target, role, migrations) {
  const schemaSql = quoteSchema(target.schema);
  try {
    await withPostgresRead(pool, async (client) => {
      const version = await client.query(
        "SELECT current_setting('server_version_num')::integer AS server_version_num",
      );
      const versionRows = version.rows;
      if (!Array.isArray(versionRows) || versionRows.length !== 1
          || Math.floor(Number(versionRows[0]?.server_version_num) / 10_000) !== 17) {
        fail("POSTGRES_SYNTHETIC_CLEANUP_VERSION_UNSUPPORTED");
      }
      const rows = await client.query(
        `SELECT version, name, checksum_sha256
           FROM ${schemaSql}."_tibotattle_migration_history" ORDER BY version`,
      );
      if (!Array.isArray(rows.rows) || rows.rows.length !== migrations.length) {
        fail("POSTGRES_SYNTHETIC_CLEANUP_MIGRATION_RECEIPT_MISMATCH");
      }
      for (let index = 0; index < migrations.length; index += 1) {
        const actual = rows.rows[index];
        const expected = migrations[index];
        if (actual?.version !== expected.version || actual?.name !== expected.name
            || actual?.checksum_sha256 !== expected.sha256) {
          fail("POSTGRES_SYNTHETIC_CLEANUP_MIGRATION_RECEIPT_MISMATCH");
        }
      }
    }, {
      operation: `postgres.synthetic_cleanup.${role}_migration_readback`,
      statementTimeoutMilliseconds: 10_000,
      lockTimeoutMilliseconds: 5_000,
    });
  } catch (error) {
    if (typeof error?.code === "string"
        && error.code.startsWith("POSTGRES_SYNTHETIC_CLEANUP_")) throw error;
    fail("POSTGRES_SYNTHETIC_CLEANUP_MIGRATION_RECEIPT_READ_FAILED");
  }
}

/** Execute a fixed one-owner test cleanup with injectable cloud/SQL adapters. */
export async function runSyntheticV12Cleanup({ env = process.env, dependencies = {} } = {}) {
  if (env === null || typeof env !== "object"
      || env.CLOUD_RUN_JOB !== SYNTHETIC_V12_CLEANUP_JOB
      || !EXECUTION_PATTERN.test(env.CLOUD_RUN_EXECUTION ?? "")
      || env.CLOUD_RUN_TASK_INDEX !== "0" || env.CLOUD_RUN_TASK_COUNT !== "1"
      || env.CLOUD_RUN_TASK_ATTEMPT !== "0"
      || env.GOOGLE_CLOUD_PROJECT !== SYNTHETIC_V12_CLEANUP_TARGETS.project
      || env.K_SERVICE !== undefined) {
    fail("CLOUD_RUN_SYNTHETIC_CLEANUP_JOB_CONTEXT_INVALID");
  }
  const attachedServiceAccountEmail = await (dependencies.readServiceAccountEmail
    ?? readAttachedSyntheticCleanupServiceAccount)({ fetchImpl: dependencies.fetchImpl });
  const config = parseSyntheticV12CleanupConfig(env, attachedServiceAccountEmail);

  let manifest;
  try {
    manifest = validateMigrations(await (dependencies.buildManifest ?? buildPostgresMigrationManifest)({
      rootDirectory: SYNTHETIC_V12_CLEANUP_MIGRATION_ROOT,
    }));
  } catch (error) {
    if (typeof error?.code === "string"
        && error.code.startsWith("POSTGRES_SYNTHETIC_CLEANUP_")) throw error;
    fail("POSTGRES_SYNTHETIC_CLEANUP_MIGRATION_SOURCE_INVALID");
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
      max: 2,
      applicationName: APPLICATION_NAME,
    });
    pools.push(primaryPool);
    const ledgerPool = await createPool({
      connector,
      instanceConnectionName: config.ledger.instanceConnectionName,
      database: config.ledger.database,
      user: config.iamUser,
      max: 2,
      applicationName: APPLICATION_NAME,
    });
    pools.push(ledgerPool);
    await Promise.all([
      verifyPostgres17MigrationReceipt(primaryPool, config.primary, "primary", manifest.roles.primary),
      verifyPostgres17MigrationReceipt(ledgerPool, config.ledger, "ledger", manifest.roles.ledger),
    ]);
    const accessToken = await (dependencies.createAccessTokenProvider ?? createGoogleAccessTokenProvider)();
    const objectStore = await (dependencies.createObjectStore ?? (({ bucket, tokenProvider, historyProof }) =>
      new GcsErasureObjectStore(bucket, tokenProvider, globalThis.fetch, 30_000, historyProof)))({
      bucket: config.bucket,
      tokenProvider: accessToken,
      historyProof: config.historyProof,
    });
    result = await (dependencies.eraseOwner ?? eraseSyntheticPostgresV12Owner)({
      primaryPool,
      ledgerPool,
      objectStore,
      participantId: config.participantId,
      schema: { primarySchema: config.primary.schema, ledgerSchema: config.ledger.schema },
    });
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await (dependencies.closeResources ?? closeCloudSqlResources)({ pools, connector });
    } catch {
      operationError ??= Object.assign(new Error("CLOUD_SQL_SYNTHETIC_CLEANUP_CLOSE_FAILED"), {
        code: "CLOUD_SQL_SYNTHETIC_CLEANUP_CLOSE_FAILED",
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
    : "SYNTHETIC_CLEANUP_FAILED";
}

async function main() {
  if (process.argv.length !== 2) fail("CLOUD_RUN_SYNTHETIC_CLEANUP_ARGUMENTS_INVALID");
  try {
    const receipt = await runSyntheticV12Cleanup();
    console.log(JSON.stringify({
      schemaVersion: "synthetic-v12-owner-cleanup-receipt-v1",
      status: receipt.status,
      ...(receipt.status === "incomplete" ? { code: receipt.code } : { objectsDeleted: receipt.objectsDeleted }),
    }));
    if (receipt.status === "incomplete") process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({
      schemaVersion: "synthetic-v12-owner-cleanup-receipt-v1",
      status: "error",
      code: safeCode(error),
    }));
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
