#!/usr/bin/env node

/**
 * Synthetic v1.2 smoke-owner cleanup Job for the named A2 test deployment.
 *
 * It removes exactly one synthetic smoke participant (SIMP-1, plan-v5): there
 * is no online erasure machinery, ledger, tombstone, cooldown, analytics
 * retirement or erasure receipt of its own. The order is the plan-v5 SIMP-1
 * brief's:
 *
 *   1. one bounded write transaction: lock the participant FOR UPDATE, apply
 *      the discovery rules to it (synthetic-v12-discovery.mjs
 *      readSyntheticV12CleanupTarget: exact synthetic tag, active social owner,
 *      the per-owner family envelope, no upload in progress), read its object
 *      keys and their pending registrations, then a plain
 *      DELETE FROM participants for that one id. The primary's 0029 BEFORE
 *      DELETE trigger marks the owner link erased and writes exactly one
 *      storage_owner_erasure_receipts row, which the same transaction reads
 *      back;
 *   2. after commit, delete each object through the quarantine store's delete
 *      primitive (a missing object counts as done);
 *   3. clear the matching pending_objects registrations.
 *
 * A run that stops between 1 and 2 leaves the objects registered and
 * unreferenced, which the scheduled pending-object reconciliation deletes
 * after its safety window; a rerun finds the participant absent and changes
 * nothing. A participant outside the synthetic rules is refused before any
 * write. A participant that redeemed an enrollment grant is refused by
 * primary 0063 (23514) and left untouched.
 *
 * The bucket-history proof requirement is unchanged pending owner decision
 * OD-2. Whether the A2 deployment runs this Job again is owner decision OD-6.
 */

import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Connector } from "@google-cloud/cloud-sql-connector";
import { createGcsErasureBucketHistoryProof } from "../src/gcs-erasure-object-store.ts";
import { createGcsQuarantineObjectStore } from "../src/gcs-quarantine-object-store.ts";
import { withPostgresMutation, withPostgresRead } from "../src/postgres-client.ts";
import {
  closeCloudSqlResources,
  createIamPool as createCloudSqlIamPool,
  createGoogleAccessTokenProvider,
  normalizeIamUser,
} from "./cloud-sql.mjs";
import { buildPostgresMigrationManifest } from "./postgres-migrations.mjs";
import { CLOUD_RUN_IAM_TEST_TARGET } from "./postgres-test-dispatch.mjs";
import { readSyntheticV12CleanupTarget } from "./synthetic-v12-discovery.mjs";

export const SYNTHETIC_V12_CLEANUP_JOB = "tibotattle-v12-synthetic-cleanup";
export const SYNTHETIC_V12_CLEANUP_SERVICE_ACCOUNT =
  "tibotattle-test-runtime@tibotattle.iam.gserviceaccount.com";
export const SYNTHETIC_V12_CLEANUP_MIGRATION_ROOT = "/app/apps/worker/postgres/migrations";
export const SYNTHETIC_V12_CLEANUP_PARTICIPANT_PREFIX = "synthetic-v12-smoke-";
export const SYNTHETIC_V12_CLEANUP_SERVICE = CLOUD_RUN_IAM_TEST_TARGET.service;
export const SYNTHETIC_V12_CLEANUP_RECEIPT_SCHEMA = "synthetic-v12-owner-cleanup-receipt-v2";
export const SYNTHETIC_V12_CLEANUP_TARGETS = Object.freeze({
  primary: CLOUD_RUN_IAM_TEST_TARGET.postgres.primary,
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
  primary: Object.freeze({ count: 64, tail: "0064_append_only_residue.sql" }),
});
const APPLICATION_NAME = "tibotattle-synthetic-v12-cleanup";
const OBJECT_KEY_LIMIT = 1;
const PENDING_TOKEN_PATTERN = /^[0-9a-f]{32}$/u;
const TRANSACTION_LIMITS = Object.freeze({
  statementTimeoutMilliseconds: 10_000,
  lockTimeoutMilliseconds: 5_000,
});

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
  if (env.PRIMARY_INSTANCE_CONNECTION_NAME !== primary.instanceConnectionName
      || env.PRIMARY_DATABASE !== primary.database || env.PRIMARY_SCHEMA !== primary.schema
      || !SCHEMA_PATTERN.test(env.PRIMARY_SCHEMA ?? "")
      || !INSTANCE_PATTERN.test(env.PRIMARY_INSTANCE_CONNECTION_NAME ?? "")
      || !DATABASE_PATTERN.test(env.PRIMARY_DATABASE ?? "")
      || Object.keys(env).some((name) => name.startsWith("LEDGER_"))) {
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
  if (manifest === null || typeof manifest !== "object"
      || manifest.roles === null || typeof manifest.roles !== "object"
      || Object.keys(manifest.roles).join(",") !== Object.keys(EXPECTED_MIGRATION_SHAPES).join(",")) {
    fail("POSTGRES_SYNTHETIC_CLEANUP_MIGRATION_SOURCE_INVALID");
  }
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

/** Keep this Job's own closed codes and the discovery rule codes it reuses. */
function preserveCleanupError(error) {
  return error instanceof Error
      && error.message === error.code
      && typeof error.code === "string"
      && /^(?:POSTGRES_)?SYNTHETIC_(?:CLEANUP|DISCOVERY)_[A-Z0-9_]+$/u.test(error.code)
    ? error
    : null;
}

function rowsOf(result, code) {
  if (result === null || typeof result !== "object" || !Array.isArray(result.rows)) fail(code);
  return result.rows;
}

/**
 * Step 1: one bounded write transaction that locks, re-checks, reads the
 * object references and deletes the one participant. Returns null when the
 * participant is already absent (an idempotent rerun).
 */
async function deleteSyntheticParticipant(pool, schema, participantId) {
  const quoted = quoteSchema(schema);
  return withPostgresMutation(pool, async (client) => {
    const participants = rowsOf(await client.query(
      `SELECT id, state, owner_kind, identity_link_key
         FROM ${quoted}."participants" WHERE id = $1 FOR UPDATE`,
      [participantId],
    ), "POSTGRES_SYNTHETIC_CLEANUP_READBACK_INVALID");
    if (participants.length === 0) return null;
    if (participants.length !== 1) fail("POSTGRES_SYNTHETIC_CLEANUP_READBACK_INVALID");
    // The discovery rules, under this transaction's participant lock.
    const objectKeys = await readSyntheticV12CleanupTarget(client, schema, participants[0]);
    if (!Array.isArray(objectKeys) || objectKeys.length > OBJECT_KEY_LIMIT) {
      fail("SYNTHETIC_CLEANUP_OBJECT_REFERENCES_UNSUPPORTED");
    }
    const owners = rowsOf(await client.query(
      `SELECT owner_digest FROM ${quoted}."storage_v11_owner_links"
        WHERE participant_id = $1 AND state = 'active' FOR UPDATE`,
      [participantId],
    ), "POSTGRES_SYNTHETIC_CLEANUP_READBACK_INVALID");
    const ownerDigest = owners[0]?.owner_digest;
    if (owners.length !== 1 || !SHA256_PATTERN.test(ownerDigest ?? "")) {
      fail("SYNTHETIC_CLEANUP_OWNER_LINK_INVALID");
    }
    const registrations = objectKeys.length === 0 ? [] : rowsOf(await client.query(
      `SELECT contribution_id, object_key, registration_token
         FROM ${quoted}."pending_objects"
        WHERE object_key = $1 AND object_kind = 'telemetry_v12'
          AND reconciliation_state = 'registered'
        FOR UPDATE`,
      [objectKeys[0]],
    ), "POSTGRES_SYNTHETIC_CLEANUP_READBACK_INVALID");
    if (registrations.length !== objectKeys.length
        || registrations.some((row) => row?.object_key !== objectKeys[0]
          || typeof row?.contribution_id !== "string"
          || !PENDING_TOKEN_PATTERN.test(row?.registration_token ?? ""))) {
      fail("SYNTHETIC_CLEANUP_PENDING_REFERENCE_INVALID");
    }
    let deleted;
    try {
      deleted = await client.query(
        `DELETE FROM ${quoted}."participants" WHERE id = $1 AND state = 'active'`,
        [participantId],
      );
    } catch (error) {
      // Primary 0063 refuses the redeemed grant's SET NULL with 23514: the
      // participant redeemed an enrollment grant and is left untouched.
      if (error?.code === "23514") fail("SYNTHETIC_CLEANUP_PARTICIPANT_GRANT_REDEEMED");
      throw error;
    }
    if (deleted?.rowCount !== 1) fail("POSTGRES_SYNTHETIC_CLEANUP_DELETE_UNEXPECTED");
    // The 0029 trigger's receipt, written in this transaction.
    const receipts = rowsOf(await client.query(
      `SELECT count(*)::integer AS receipts
         FROM ${quoted}."storage_owner_erasure_receipts" WHERE owner_digest = $1`,
      [ownerDigest],
    ), "POSTGRES_SYNTHETIC_CLEANUP_READBACK_INVALID");
    if (receipts.length !== 1 || receipts[0]?.receipts !== 1) {
      fail("POSTGRES_SYNTHETIC_CLEANUP_ERASURE_RECEIPT_MISSING");
    }
    return Object.freeze({
      registrations: Object.freeze(registrations.map((row) => Object.freeze({
        contributionId: row.contribution_id,
        objectKey: row.object_key,
        registrationToken: row.registration_token,
      }))),
    });
  }, {
    ...TRANSACTION_LIMITS,
    operation: "postgres.synthetic_cleanup.delete_participant",
    preserveSafeError: preserveCleanupError,
  });
}

/** Step 3: clear the deleted objects' registrations; another reconciler may already have. */
async function clearRegistrations(pool, schema, registrations) {
  if (registrations.length === 0) return;
  const quoted = quoteSchema(schema);
  await withPostgresMutation(pool, async (client) => {
    for (const registration of registrations) {
      const cleared = await client.query(
        `DELETE FROM ${quoted}."pending_objects"
          WHERE contribution_id = $1 AND object_key = $2 AND registration_token = $3
            AND object_kind = 'telemetry_v12' AND reconciliation_state = 'registered'`,
        [registration.contributionId, registration.objectKey, registration.registrationToken],
      );
      if (cleared?.rowCount !== 0 && cleared?.rowCount !== 1) {
        fail("POSTGRES_SYNTHETIC_CLEANUP_PENDING_CLEAR_UNEXPECTED");
      }
    }
  }, {
    ...TRANSACTION_LIMITS,
    operation: "postgres.synthetic_cleanup.clear_registrations",
    preserveSafeError: preserveCleanupError,
  });
}

/**
 * Steps 1 to 3 for one participant on one primary pool and schema, with the
 * quarantine store's delete primitive. Returns {status: "complete",
 * objectsDeleted, erasureReceipts: 1}, {status: "absent", objectsDeleted: 0}
 * for an already removed participant, or {status: "incomplete", code} when
 * the participant is gone but an object or registration is left for the
 * pending-object reconciliation. Refusals throw a closed code before any
 * write.
 */
export async function cleanupSyntheticV12Participant({ pool, schema, participantId, objectStore } = {}) {
  validateParticipantId(participantId);
  quoteSchema(schema);
  if (pool === null || typeof pool !== "object" || typeof pool.connect !== "function"
      || objectStore === null || typeof objectStore !== "object"
      || typeof objectStore.delete !== "function") {
    fail("SYNTHETIC_CLEANUP_DEPENDENCIES_INVALID");
  }
  let deleted;
  try {
    deleted = await deleteSyntheticParticipant(pool, schema, participantId);
  } catch (error) {
    const safe = preserveCleanupError(error);
    if (safe !== null) throw safe;
    fail("POSTGRES_SYNTHETIC_CLEANUP_DELETE_FAILED");
  }
  if (deleted === null) return Object.freeze({ status: "absent", objectsDeleted: 0 });
  let objectsDeleted = 0;
  for (const registration of deleted.registrations) {
    try {
      await objectStore.delete(registration.objectKey);
    } catch {
      // The participant is gone; its registered, unreferenced objects stay
      // for the pending-object reconciliation.
      return Object.freeze({ status: "incomplete", code: "GCS_SYNTHETIC_CLEANUP_OBJECT_DELETE_DEFERRED" });
    }
    objectsDeleted += 1;
  }
  try {
    await clearRegistrations(pool, schema, deleted.registrations);
  } catch {
    return Object.freeze({ status: "incomplete", code: "POSTGRES_SYNTHETIC_CLEANUP_PENDING_CLEAR_DEFERRED" });
  }
  return Object.freeze({ status: "complete", objectsDeleted, erasureReceipts: 1 });
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
    await verifyPostgres17MigrationReceipt(primaryPool, config.primary, "primary", manifest.roles.primary);
    const accessToken = await (dependencies.createAccessTokenProvider ?? createGoogleAccessTokenProvider)();
    // OD-2: the quarantine store keeps the bucket-history proof it needs to
    // prove a missing object absent on a soft-delete-disabled bucket.
    const objectStore = await (dependencies.createObjectStore ?? (({ bucket, tokenProvider, historyProof }) =>
      createGcsQuarantineObjectStore(bucket, tokenProvider, globalThis.fetch, 30_000, historyProof)))({
      bucket: config.bucket,
      tokenProvider: accessToken,
      historyProof: config.historyProof,
    });
    result = await (dependencies.cleanupParticipant ?? cleanupSyntheticV12Participant)({
      pool: primaryPool,
      schema: config.primary.schema,
      participantId: config.participantId,
      objectStore,
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
      schemaVersion: SYNTHETIC_V12_CLEANUP_RECEIPT_SCHEMA,
      status: receipt.status,
      ...(receipt.status === "incomplete" ? { code: receipt.code } : { objectsDeleted: receipt.objectsDeleted }),
    }));
    if (receipt.status === "incomplete") process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({
      schemaVersion: SYNTHETIC_V12_CLEANUP_RECEIPT_SCHEMA,
      status: "error",
      code: safeCode(error),
    }));
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
