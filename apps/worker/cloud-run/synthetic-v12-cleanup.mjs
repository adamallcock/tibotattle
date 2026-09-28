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
export const SYNTHETIC_V12_CLEANUP_ORPHAN_MARKER = SYNTHETIC_V12_CLEANUP_PARTICIPANT_PREFIX;
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
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_RECOVERY_WINDOW_MILLISECONDS = 60_000;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const V12_CHUNK_ID_PATTERN = /^chunk:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SYNTHETIC_OBJECT_KEY_PATTERN =
  /^telemetry\/v12-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EXPECTED_MIGRATION_SHAPES = Object.freeze({
  primary: Object.freeze({ count: 46, tail: "0046_owner_journal_authority.sql" }),
  ledger: Object.freeze({ count: 6, tail: "0006_erasure_ledger_transfer_receipts.sql" }),
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

function validateRecoveryTimestamp(value) {
  if (typeof value !== "string" || !UTC_TIMESTAMP_PATTERN.test(value)) {
    fail("SYNTHETIC_CLEANUP_RECOVERY_WINDOW_INVALID");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail("SYNTHETIC_CLEANUP_RECOVERY_WINDOW_INVALID");
  }
  return value;
}

function preserveRecoverySelectorError(error) {
  return typeof error?.code === "string"
      && error.code.startsWith("SYNTHETIC_CLEANUP_RECOVERY_")
    ? error
    : null;
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
  const rawParticipantId = env.SYNTHETIC_V12_CLEANUP_PARTICIPANT_ID;
  const rawCreatedAtFrom = env.SYNTHETIC_V12_CLEANUP_CREATED_AT_FROM;
  const rawCreatedAtTo = env.SYNTHETIC_V12_CLEANUP_CREATED_AT_TO;
  const rawOrphanMarker = env.SYNTHETIC_V12_CLEANUP_ORPHAN_MARKER;
  let participantId = null;
  let createdAtFrom = null;
  let createdAtTo = null;
  let orphanMarker = null;
  let selectorMode;
  if (rawParticipantId !== undefined && rawParticipantId !== "") {
    if (rawCreatedAtFrom !== undefined || rawCreatedAtTo !== undefined || rawOrphanMarker !== undefined) {
      fail("SYNTHETIC_CLEANUP_SELECTOR_CONFIGURATION_INVALID");
    }
    participantId = validateParticipantId(rawParticipantId);
    selectorMode = "explicit_participant_id";
  } else {
    if (rawCreatedAtFrom === undefined || rawCreatedAtTo === undefined) {
      fail("SYNTHETIC_CLEANUP_SELECTOR_CONFIGURATION_INVALID");
    }
    createdAtFrom = validateRecoveryTimestamp(rawCreatedAtFrom);
    createdAtTo = validateRecoveryTimestamp(rawCreatedAtTo);
    const duration = Date.parse(createdAtTo) - Date.parse(createdAtFrom);
    if (duration <= 0 || duration > MAX_RECOVERY_WINDOW_MILLISECONDS) {
      fail("SYNTHETIC_CLEANUP_RECOVERY_WINDOW_INVALID");
    }
    if (rawOrphanMarker !== undefined) {
      if (rawOrphanMarker !== SYNTHETIC_V12_CLEANUP_ORPHAN_MARKER) {
        fail("SYNTHETIC_CLEANUP_SELECTOR_CONFIGURATION_INVALID");
      }
      orphanMarker = SYNTHETIC_V12_CLEANUP_ORPHAN_MARKER;
      selectorMode = "bounded_smoke_orphan_window";
    } else {
      selectorMode = "bounded_created_at_window";
    }
  }
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
    selectorMode,
    createdAtFrom,
    createdAtTo,
    orphanMarker,
  });
}

/** Resolve one exact synthetic owner inside a short, caller-pinned UTC window. */
export async function resolveSyntheticV12CleanupParticipantId({
  primaryPool,
  primarySchema,
  createdAtFrom,
  createdAtTo,
}) {
  if (primaryPool === null || typeof primaryPool?.connect !== "function") {
    fail("POSTGRES_SYNTHETIC_CLEANUP_SELECTOR_READ_FAILED");
  }
  const from = validateRecoveryTimestamp(createdAtFrom);
  const to = validateRecoveryTimestamp(createdAtTo);
  const duration = Date.parse(to) - Date.parse(from);
  if (duration <= 0 || duration > MAX_RECOVERY_WINDOW_MILLISECONDS) {
    fail("SYNTHETIC_CLEANUP_RECOVERY_WINDOW_INVALID");
  }
  const schemaSql = quoteSchema(primarySchema);
  try {
    return await withPostgresRead(primaryPool, async (client) => {
      const result = await client.query(
        `SELECT participant.id, participant.created_at
           FROM ${schemaSql}."participants" participant
          WHERE participant.id LIKE $1
            AND participant.owner_kind = 'social'
            AND participant.state = 'active'
            AND participant.identity_link_key IS NULL
            AND participant.created_at >= $2::timestamptz
            AND participant.created_at < $3::timestamptz
            AND (
              SELECT count(*)
                FROM ${schemaSql}."telemetry_v12_day_manifests" manifest
               WHERE manifest.participant_id = participant.id
            ) = 1
            AND (
              SELECT count(*)
                FROM ${schemaSql}."telemetry_v12_day_manifests" manifest
               WHERE manifest.participant_id = participant.id
                 AND manifest.state = 'staged'
                 AND manifest.expected_chunk_count = 1
            ) = 1
            AND NOT EXISTS (
              SELECT 1
                FROM ${schemaSql}."telemetry_v12_chunks" chunk
               WHERE chunk.participant_id = participant.id
            )
          ORDER BY participant.created_at, participant.id
          LIMIT 2`,
        [`${SYNTHETIC_V12_CLEANUP_PARTICIPANT_PREFIX}%`, from, to],
      );
      if (!Array.isArray(result?.rows) || result.rows.length !== 1) {
        fail("SYNTHETIC_CLEANUP_RECOVERY_CANDIDATE_NOT_UNIQUE");
      }
      const row = result.rows[0];
      let participantId;
      try { participantId = validateParticipantId(row?.id); } catch {
        fail("SYNTHETIC_CLEANUP_RECOVERY_CANDIDATE_INVALID");
      }
      const createdAt = row.created_at instanceof Date
        ? row.created_at.toISOString()
        : typeof row.created_at === "string" ? row.created_at : "";
      const observed = Date.parse(createdAt);
      if (!Number.isFinite(observed) || observed < Date.parse(from) || observed >= Date.parse(to)) {
        fail("SYNTHETIC_CLEANUP_RECOVERY_CANDIDATE_INVALID");
      }
      return participantId;
    }, {
      operation: "postgres.synthetic_cleanup.participant_selector",
      statementTimeoutMilliseconds: 10_000,
      lockTimeoutMilliseconds: 5_000,
      preserveSafeError: preserveRecoverySelectorError,
    });
  } catch (error) {
    if (typeof error?.code === "string"
        && error.code.startsWith("SYNTHETIC_CLEANUP_RECOVERY_")) throw error;
    fail("POSTGRES_SYNTHETIC_CLEANUP_SELECTOR_READ_FAILED");
  }
}

/**
 * Read-only, in-process recovery discovery for a single synthetic smoke owner.
 * The marker gates this stronger selector; the exact owner id is returned only
 * to the caller so the existing exact-owner eraser can run without copying an
 * identifier through Cloud Run logs or another Job.
 */
export async function resolveSyntheticV12CleanupSmokeOrphanParticipantId({
  primaryPool,
  primarySchema,
  orphanMarker,
  createdAtFrom,
  createdAtTo,
}) {
  if (primaryPool === null || typeof primaryPool?.connect !== "function") {
    fail("POSTGRES_SYNTHETIC_CLEANUP_SELECTOR_READ_FAILED");
  }
  if (orphanMarker !== SYNTHETIC_V12_CLEANUP_ORPHAN_MARKER) {
    fail("SYNTHETIC_CLEANUP_RECOVERY_MARKER_INVALID");
  }
  const from = validateRecoveryTimestamp(createdAtFrom);
  const to = validateRecoveryTimestamp(createdAtTo);
  const duration = Date.parse(to) - Date.parse(from);
  if (duration <= 0 || duration > MAX_RECOVERY_WINDOW_MILLISECONDS) {
    fail("SYNTHETIC_CLEANUP_RECOVERY_WINDOW_INVALID");
  }
  const schemaSql = quoteSchema(primarySchema);
  const invalid = (code) => fail(`SYNTHETIC_CLEANUP_RECOVERY_${code}`);
  try {
    return await withPostgresRead(primaryPool, async (client) => {
      // Include any synthetic-prefix row in the window, even if it has the
      // wrong owner family or state. Such a row must make the selection fail
      // closed rather than disappear from the ambiguity count.
      const candidateResult = await client.query(
        `SELECT participant.id, participant.created_at, participant.owner_kind,
                participant.state, participant.identity_link_key
           FROM ${schemaSql}."participants" participant
          WHERE left(participant.id, char_length($1)) = $1
            AND participant.created_at >= $2::timestamptz
            AND participant.created_at < $3::timestamptz
          ORDER BY participant.created_at, participant.id
          LIMIT 2`,
        [orphanMarker, from, to],
      );
      if (!Array.isArray(candidateResult?.rows) || candidateResult.rows.length !== 1) {
        invalid("CANDIDATE_NOT_UNIQUE");
      }
      const candidate = candidateResult.rows[0];
      let participantId;
      try { participantId = validateParticipantId(candidate?.id); } catch {
        invalid("CANDIDATE_INVALID");
      }
      const createdAt = candidate.created_at instanceof Date
        ? candidate.created_at.toISOString()
        : typeof candidate.created_at === "string" ? candidate.created_at : "";
      const observed = Date.parse(createdAt);
      if (!Number.isFinite(observed) || observed < Date.parse(from) || observed >= Date.parse(to)
          || candidate.owner_kind !== "social" || candidate.state !== "active"
          || candidate.identity_link_key !== null) {
        invalid("CANDIDATE_INVALID");
      }

      const manifestsResult = await client.query(
        `SELECT id, device_id, chunk_day::text AS chunk_day, expected_chunk_count, state
           FROM ${schemaSql}."telemetry_v12_day_manifests"
          WHERE participant_id = $1
          ORDER BY id
          LIMIT 2`,
        [participantId],
      );
      if (!Array.isArray(manifestsResult?.rows) || manifestsResult.rows.length !== 1) {
        invalid("MANIFEST_SHAPE_INVALID");
      }
      const manifest = manifestsResult.rows[0];
      if (!UUID_V4_PATTERN.test(manifest?.id ?? "")
          || !UUID_V4_PATTERN.test(manifest?.device_id ?? "")
          || typeof manifest?.chunk_day !== "string"
          || !/^\d{4}-\d{2}-\d{2}$/u.test(manifest.chunk_day)
          || Number(manifest.expected_chunk_count) !== 1) {
        invalid("MANIFEST_SHAPE_INVALID");
      }

      const chunksResult = await client.query(
        `SELECT id, manifest_id, participant_id, device_id, stream,
                chunk_day::text AS chunk_day, chunk_seq, r2_key
           FROM ${schemaSql}."telemetry_v12_chunks"
          WHERE participant_id = $1
          ORDER BY id
          LIMIT 2`,
        [participantId],
      );
      if (!Array.isArray(chunksResult?.rows) || chunksResult.rows.length > 1) {
        invalid("CHUNK_SHAPE_INVALID");
      }
      if (chunksResult.rows.length === 0) {
        if (manifest.state !== "staged") invalid("MANIFEST_SHAPE_INVALID");
      } else {
        const chunk = chunksResult.rows[0];
        if (!V12_CHUNK_ID_PATTERN.test(chunk?.id ?? "")
            || chunk?.manifest_id !== manifest.id || chunk?.participant_id !== participantId
            || chunk?.device_id !== manifest.device_id || chunk?.stream !== "usage"
            || chunk?.chunk_day !== manifest.chunk_day || Number(chunk?.chunk_seq) !== 0
            || typeof chunk?.r2_key !== "string"
            || !SYNTHETIC_OBJECT_KEY_PATTERN.test(chunk.r2_key)
            || manifest.state !== "ready") {
          invalid("CHUNK_SHAPE_INVALID");
        }
        const pendingResult = await client.query(
          `SELECT contribution_id, object_key, object_kind,
                  reconciliation_state, registration_token
             FROM ${schemaSql}."pending_objects"
            WHERE contribution_id = $1
            ORDER BY contribution_id
            LIMIT 2`,
          [chunk.id],
        );
        if (!Array.isArray(pendingResult?.rows) || pendingResult.rows.length !== 1) {
          invalid("REFERENCE_SHAPE_INVALID");
        }
        const pending = pendingResult.rows[0];
        if (pending?.contribution_id !== chunk.id || pending?.object_key !== chunk.r2_key
            || pending?.object_kind !== "telemetry_v12"
            || pending?.reconciliation_state !== "registered"
            || typeof pending?.registration_token !== "string"
            || !/^[0-9a-f]{32}$/u.test(pending.registration_token)) {
          invalid("REFERENCE_SHAPE_INVALID");
        }
      }

      const consumingResult = await client.query(
        `SELECT count(*)::text AS row_count
           FROM ${schemaSql}."device_upload_authorizations"
          WHERE participant_id = $1 AND state = 'consuming'`,
        [participantId],
      );
      if (!Array.isArray(consumingResult?.rows) || consumingResult.rows.length !== 1
          || Number(consumingResult.rows[0]?.row_count) !== 0) {
        invalid("UPLOAD_IN_PROGRESS");
      }

      // Exact-owner erasure refuses to complete when unrelated v1.2 pending
      // objects cannot be attributed to a stored chunk. Check this before it
      // writes its deletion fence or ledger receipt.
      const unattributedResult = await client.query(
        `SELECT 1 AS present
           FROM ${schemaSql}."pending_objects" pending
          WHERE pending.object_kind = 'telemetry_v12'
            AND NOT EXISTS (
              SELECT 1
                FROM ${schemaSql}."telemetry_v12_chunks" chunk
               WHERE chunk.id = pending.contribution_id
                 AND chunk.r2_key = pending.object_key
            )
          LIMIT 1`,
      );
      if (!Array.isArray(unattributedResult?.rows) || unattributedResult.rows.length > 0) {
        invalid("UNATTRIBUTED_REFERENCE_PRESENT");
      }
      return participantId;
    }, {
      operation: "postgres.synthetic_cleanup.smoke_orphan_selector",
      statementTimeoutMilliseconds: 10_000,
      lockTimeoutMilliseconds: 5_000,
      preserveSafeError: preserveRecoverySelectorError,
    });
  } catch (error) {
    if (typeof error?.code === "string"
        && error.code.startsWith("SYNTHETIC_CLEANUP_RECOVERY_")) throw error;
    fail("POSTGRES_SYNTHETIC_CLEANUP_SELECTOR_READ_FAILED");
  }
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

/** Execute a fixed one-owner cleanup with injectable cloud/SQL adapters. */
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
    const eraseOwner = dependencies.eraseOwner ?? eraseSyntheticPostgresV12Owner;
    let participantId;
    if (config.selectorMode === "explicit_participant_id") {
      participantId = config.participantId;
    } else if (config.selectorMode === "bounded_smoke_orphan_window") {
      participantId = await (dependencies.resolveSmokeOrphanParticipantId
        ?? resolveSyntheticV12CleanupSmokeOrphanParticipantId)({
        primaryPool,
        primarySchema: config.primary.schema,
        orphanMarker: config.orphanMarker,
        createdAtFrom: config.createdAtFrom,
        createdAtTo: config.createdAtTo,
      });
    } else {
      participantId = await (dependencies.resolveParticipantId
        ?? resolveSyntheticV12CleanupParticipantId)({
        primaryPool,
        primarySchema: config.primary.schema,
        createdAtFrom: config.createdAtFrom,
        createdAtTo: config.createdAtTo,
      });
    }
    const accessToken = await (dependencies.createAccessTokenProvider ?? createGoogleAccessTokenProvider)();
    const objectStore = await (dependencies.createObjectStore ?? (({ bucket, tokenProvider, historyProof }) =>
      new GcsErasureObjectStore(bucket, tokenProvider, globalThis.fetch, 30_000, historyProof)))({
      bucket: config.bucket,
      tokenProvider: accessToken,
      historyProof: config.historyProof,
    });
    const eraseOptions = {
      primaryPool,
      ledgerPool,
      objectStore,
      participantId,
      schema: { primarySchema: config.primary.schema, ledgerSchema: config.ledger.schema },
    };
    result = await eraseOwner(eraseOptions);
    if (config.selectorMode !== "explicit_participant_id") {
      const firstResult = result;
      if (firstResult.status === "incomplete") {
        result = await eraseOwner(eraseOptions);
        result = Object.freeze({
          ...result,
          attempts: 2,
          firstAttemptStatus: "incomplete",
          replayStatus: result.status,
        });
      } else {
        const replay = await eraseOwner(eraseOptions);
        if (replay.status !== "already_complete") {
          fail("SYNTHETIC_CLEANUP_RECOVERY_REPLAY_INVALID");
        }
        result = Object.freeze({
          ...firstResult,
          attempts: 2,
          replayStatus: replay.status,
        });
      }
    }
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
      ...(receipt.attempts === undefined ? {} : { attempts: receipt.attempts }),
      ...(receipt.replayStatus === undefined ? {} : { replayStatus: receipt.replayStatus }),
      ...(receipt.firstAttemptStatus === undefined ? {} : { firstAttemptStatus: receipt.firstAttemptStatus }),
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
