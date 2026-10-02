#!/usr/bin/env node

import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Connector } from "@google-cloud/cloud-sql-connector";
import {
  closeCloudSqlResources,
  createIamPool,
  normalizeIamUser,
} from "./cloud-sql.mjs";
import { readPostgresMigrations } from "./postgres-migrations.mjs";
import {
  CLOUD_RUN_IAM_TEST_TARGET,
} from "./postgres-test-dispatch.mjs";
import {
  readPostgresCommunityDailyDaySourceEligibility,
} from "../src/postgres-community-daily-publisher.ts";

export { readPostgresCommunityDailyDaySourceEligibility };

export const POSTGRES_COMMUNITY_DAILY_ACTIVATION_JOBS = Object.freeze({
  prepare: "tibotattle-community-daily-prepare-test",
  restore: "tibotattle-community-daily-restore-test",
});
export const POSTGRES_COMMUNITY_DAILY_ACTIVATION_SERVICE_ACCOUNT =
  "tibotattle-test-runtime@tibotattle.iam.gserviceaccount.com";
export const POSTGRES_COMMUNITY_DAILY_ACTIVATION_IAM_USER =
  CLOUD_RUN_IAM_TEST_TARGET.postgres.iamUser;
export const POSTGRES_COMMUNITY_DAILY_ACTIVATION_DAY = "2026-09-25";
export const POSTGRES_COMMUNITY_DAILY_ACTIVATION_SOURCE_ID =
  "synthetic-community-source";
export const POSTGRES_COMMUNITY_DAILY_ACTIVATION_SOURCE_NAMESPACE =
  "synthetic-community-namespace";
export const POSTGRES_COMMUNITY_DAILY_ACTIVATION_TARGET =
  CLOUD_RUN_IAM_TEST_TARGET.postgres.primary;

const EXPECTED_MIGRATION_COUNT = 64;
const EXPECTED_MIGRATION_TAIL = "0064_append_only_residue.sql";
const METADATA_EMAIL_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email";
const EXECUTION_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const MIGRATION_PATTERN = /^\d{4}_[a-z][a-z0-9_-]*\.sql$/u;
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/u;
const OWNER_ID = "synthetic-social-owner";
const SESSION_ID = "synthetic-social-session";
const PAIRING_ID = "synthetic-social-pairing";
const DEVICE_ID = "synthetic-social-device";
const AUTHORIZATION_ID = "synthetic-social-upload-authorization";
const CHUNK_ID = "synthetic-social-usage-chunk";
const OBJECT_KEY = `synthetic/${CHUNK_ID}`;
const OCCURRENCE_ID = `event:v2:${"a".repeat(64)}`;
const BASELINE_CONTROLS = Object.freeze({
  singleton: 1,
  revision: 2,
  control_state: "degraded",
  enrollment_enabled: false,
  upload_registration_enabled: true,
  processing_enabled: true,
  publication_enabled: false,
  reason_code: "synthetic_v12_test_upload_only",
});
const ACTIVE_CONTROLS = Object.freeze({
  ...BASELINE_CONTROLS,
  revision: 3,
  control_state: "operational",
  publication_enabled: true,
  reason_code: "synthetic_daily_publication_test",
});
const RESTORED_CONTROLS = Object.freeze({
  ...BASELINE_CONTROLS,
  revision: 4,
});
const RETRY_ACTIVE_CONTROLS = Object.freeze({
  ...BASELINE_CONTROLS,
  revision: 5,
  control_state: "operational",
  publication_enabled: true,
  reason_code: "synthetic_daily_publication_test",
});
const RETRY_RESTORED_CONTROLS = Object.freeze({
  ...BASELINE_CONTROLS,
  revision: 6,
});

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function quotedSchema(schema) {
  if (typeof schema !== "string" || !SCHEMA_PATTERN.test(schema)
      || schema.startsWith("pg_") || schema === "information_schema") {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_SCHEMA_INVALID");
  }
  return `"${schema}"`;
}

function exactControlState(row, expected) {
  return row !== null && typeof row === "object"
    && row.singleton === expected.singleton
    && Number(row.revision) === expected.revision
    && row.control_state === expected.control_state
    && row.enrollment_enabled === expected.enrollment_enabled
    && row.upload_registration_enabled === expected.upload_registration_enabled
    && row.processing_enabled === expected.processing_enabled
    && row.publication_enabled === expected.publication_enabled
    && row.reason_code === expected.reason_code;
}

function parseConfig(env, attachedServiceAccountEmail, mode) {
  const target = POSTGRES_COMMUNITY_DAILY_ACTIVATION_TARGET;
  const action = mode === "retry-prepare" ? "prepare"
    : mode === "retry-restore" ? "restore" : mode;
  const expectedJob = POSTGRES_COMMUNITY_DAILY_ACTIVATION_JOBS[action];
  if (env === null || typeof env !== "object" || expectedJob === undefined
      || env.CLOUD_RUN_JOB !== expectedJob
      || !EXECUTION_PATTERN.test(env.CLOUD_RUN_EXECUTION ?? "")
      || env.CLOUD_RUN_TASK_INDEX !== "0"
      || env.CLOUD_RUN_TASK_COUNT !== "1"
      || env.CLOUD_RUN_TASK_ATTEMPT !== "0"
      || env.GOOGLE_CLOUD_PROJECT !== CLOUD_RUN_IAM_TEST_TARGET.project
      || env.K_SERVICE !== undefined) {
    fail("CLOUD_RUN_COMMUNITY_DAILY_ACTIVATION_JOB_CONTEXT_INVALID");
  }
  if (env.CLOUD_RUN_TEST_SERVICE !== CLOUD_RUN_IAM_TEST_TARGET.service
      || env.HOST_ORIGIN !== CLOUD_RUN_IAM_TEST_TARGET.origin) {
    fail("CLOUD_RUN_COMMUNITY_DAILY_ACTIVATION_SERVICE_INVALID");
  }
  let iamUser;
  try { iamUser = normalizeIamUser(env.POSTGRES_IAM_USER, "POSTGRES_IAM_USER"); } catch {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_IAM_USER_INVALID");
  }
  if (iamUser !== POSTGRES_COMMUNITY_DAILY_ACTIVATION_IAM_USER
      || env.PRIMARY_INSTANCE_CONNECTION_NAME !== target.instanceConnectionName
      || env.PRIMARY_DATABASE !== target.database
      || env.PRIMARY_SCHEMA !== target.schema
      || env.POSTGRES_SOURCE_ID !== POSTGRES_COMMUNITY_DAILY_ACTIVATION_SOURCE_ID
      || env.POSTGRES_SOURCE_NAMESPACE !== POSTGRES_COMMUNITY_DAILY_ACTIVATION_SOURCE_NAMESPACE
      || env.COMMUNITY_DAILY_SYNTHETIC_DAY !== POSTGRES_COMMUNITY_DAILY_ACTIVATION_DAY) {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_TARGET_INVALID");
  }
  if (attachedServiceAccountEmail !== POSTGRES_COMMUNITY_DAILY_ACTIVATION_SERVICE_ACCOUNT) {
    fail("CLOUD_RUN_COMMUNITY_DAILY_ACTIVATION_SERVICE_ACCOUNT_INVALID");
  }
  return Object.freeze({
    mode,
    action,
    retry: mode.startsWith("retry-"),
    job: expectedJob,
    project: CLOUD_RUN_IAM_TEST_TARGET.project,
    schema: target.schema,
    instanceConnectionName: target.instanceConnectionName,
    database: target.database,
    iamUser,
    sourceId: POSTGRES_COMMUNITY_DAILY_ACTIVATION_SOURCE_ID,
    sourceNamespace: POSTGRES_COMMUNITY_DAILY_ACTIVATION_SOURCE_NAMESPACE,
    day: POSTGRES_COMMUNITY_DAILY_ACTIVATION_DAY,
  });
}

export function parsePostgresCommunityDailyActivationConfig(
  env,
  attachedServiceAccountEmail,
  mode,
) {
  return parseConfig(env, attachedServiceAccountEmail, mode);
}

export async function readAttachedPostgresCommunityDailyActivationServiceAccount({
  fetchImpl = globalThis.fetch,
  timeoutMilliseconds = 3_000,
} = {}) {
  if (typeof fetchImpl !== "function" || !Number.isSafeInteger(timeoutMilliseconds)
      || timeoutMilliseconds < 1 || timeoutMilliseconds > 10_000) {
    fail("CLOUD_RUN_COMMUNITY_DAILY_ACTIVATION_METADATA_UNAVAILABLE");
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
    fail("CLOUD_RUN_COMMUNITY_DAILY_ACTIVATION_METADATA_UNAVAILABLE");
  }
  if (response?.status !== 200
      || response.headers?.get("Metadata-Flavor") !== "Google") {
    fail("CLOUD_RUN_COMMUNITY_DAILY_ACTIVATION_METADATA_UNAVAILABLE");
  }
  let email;
  try { email = (await response.text()).trim(); } catch {
    fail("CLOUD_RUN_COMMUNITY_DAILY_ACTIVATION_METADATA_UNAVAILABLE");
  }
  if (email !== POSTGRES_COMMUNITY_DAILY_ACTIVATION_SERVICE_ACCOUNT) {
    fail("CLOUD_RUN_COMMUNITY_DAILY_ACTIVATION_SERVICE_ACCOUNT_INVALID");
  }
  return email;
}

function migrationSummary(migrations) {
  if (!Array.isArray(migrations) || migrations.length !== EXPECTED_MIGRATION_COUNT) {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_MIGRATION_SOURCE_INVALID");
  }
  const expected = migrations.map((migration, index) => {
    if (migration === null || typeof migration !== "object"
        || migration.role !== "primary"
        || migration.version !== index + 1
        || !MIGRATION_PATTERN.test(migration.name ?? "")
        || typeof migration.sql !== "string"
        || Buffer.byteLength(migration.sql) !== migration.bytes
        || !/^[0-9a-f]{64}$/u.test(migration.sha256 ?? "")) {
      fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_MIGRATION_SOURCE_INVALID");
    }
    return Object.freeze({ version: migration.version, name: migration.name, sha256: migration.sha256 });
  });
  if (expected.at(-1)?.name !== EXPECTED_MIGRATION_TAIL) {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_MIGRATION_SOURCE_INVALID");
  }
  return Object.freeze(expected);
}

async function verifyPostgresAndMigrations(client, migrations, schemaName) {
  const schema = quotedSchema(schemaName);
  const migrationLock = await queryOne(client,
    "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
    [`tibotattle:primary:${schemaName}`],
    "POSTGRES_COMMUNITY_DAILY_ACTIVATION_MIGRATION_LOCK_READ_FAILED");
  if (migrationLock?.acquired !== true) {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_MIGRATION_BUSY");
  }
  let version;
  try {
    version = await client.query("SELECT current_setting('server_version_num')::integer AS server_version_num");
  } catch {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_VERSION_READ_FAILED");
  }
  if (!Array.isArray(version?.rows) || version.rows.length !== 1
      || Math.floor(Number(version.rows[0]?.server_version_num) / 10_000) !== 17) {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_VERSION_UNSUPPORTED");
  }
  let receipt;
  try {
    receipt = await client.query(
      `SELECT version,name,checksum_sha256
         FROM ${schema}._tibotattle_migration_history
        ORDER BY version`,
    );
  } catch {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_MIGRATION_RECEIPT_READ_FAILED");
  }
  if (!Array.isArray(receipt?.rows) || receipt.rows.length !== migrations.length) {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_MIGRATION_RECEIPT_MISMATCH");
  }
  for (let index = 0; index < migrations.length; index += 1) {
    const actual = receipt.rows[index];
    const expected = migrations[index];
    if (Number(actual?.version) !== expected.version || actual?.name !== expected.name
        || actual?.checksum_sha256 !== expected.sha256) {
      fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_MIGRATION_RECEIPT_MISMATCH");
    }
  }
}

async function queryOne(client, sql, params, code) {
  let result;
  try { result = await client.query(sql, params); } catch {
    fail(code);
  }
  if (!Array.isArray(result?.rows) || result.rows.length !== 1
      || result.rowCount !== null && result.rowCount !== 1) {
    fail(code);
  }
  return result.rows[0];
}

function assertExpectedControls(row, expected, code) {
  if (!exactControlState(row, expected)) fail(code);
}

function controlsSelect(schema, lock = false) {
  return `SELECT singleton,revision,control_state,enrollment_enabled,
                 upload_registration_enabled,processing_enabled,publication_enabled,
                 reason_code
            FROM ${schema}.collection_controls
           WHERE singleton=1${lock ? " FOR UPDATE" : ""}`;
}

async function assertControlState(client, schema, expected, code, lock = false) {
  const row = await queryOne(client, controlsSelect(schema, lock), [], code);
  assertExpectedControls(row, expected, code);
  return row;
}

function checkFixtureConflict(row) {
  const expectedKeys = [
    "source_state_absent", "cursor_absent", "journal_empty", "applied_events_empty",
    "v1_admission_absent", "v11_admission_absent", "namespace_absent",
    "owner_absent", "session_absent", "pairing_absent", "device_absent",
    "authorization_absent", "pending_object_absent", "chunk_absent",
    "record_absent", "publication_absent",
  ];
  if (row === null || typeof row !== "object"
      || expectedKeys.some((key) => row[key] !== true)) {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_FIXTURE_CONFLICT");
  }
}

async function assertFixturePreconditions(client, schema, config) {
  const row = await queryOne(client, `
    SELECT
      NOT EXISTS (SELECT 1 FROM ${schema}.storage_source_state WHERE singleton=1) AS source_state_absent,
      NOT EXISTS (SELECT 1 FROM ${schema}.analytics_source_cursors WHERE source_id=$1) AS cursor_absent,
      NOT EXISTS (SELECT 1 FROM ${schema}.storage_ingestion_changes WHERE source_id=$1) AS journal_empty,
      NOT EXISTS (SELECT 1 FROM ${schema}.analytics_applied_events WHERE source_id=$1) AS applied_events_empty,
      NOT EXISTS (SELECT 1 FROM ${schema}.typed_v1_admission_state WHERE id=1 OR source_namespace=$2) AS v1_admission_absent,
      NOT EXISTS (SELECT 1 FROM ${schema}.typed_v11_admission_state WHERE id=1 OR source_namespace=$2) AS v11_admission_absent,
      NOT EXISTS (SELECT 1 FROM ${schema}.typed_telemetry_namespaces
        WHERE id=1 OR original_id=(decode('00','hex') || convert_to($2,'UTF8'))) AS namespace_absent,
      NOT EXISTS (SELECT 1 FROM ${schema}.participants WHERE id=$3) AS owner_absent,
      NOT EXISTS (SELECT 1 FROM ${schema}.web_sessions WHERE id=$4) AS session_absent,
      NOT EXISTS (SELECT 1 FROM ${schema}.device_pairings WHERE id=$5) AS pairing_absent,
      NOT EXISTS (SELECT 1 FROM ${schema}.device_credentials WHERE id=$6) AS device_absent,
      NOT EXISTS (SELECT 1 FROM ${schema}.device_upload_authorizations WHERE id=$7) AS authorization_absent,
      NOT EXISTS (SELECT 1 FROM ${schema}.pending_objects WHERE contribution_id=$8 OR object_key=$9) AS pending_object_absent,
      NOT EXISTS (SELECT 1 FROM ${schema}.telemetry_v1_chunks WHERE id=$8) AS chunk_absent,
      NOT EXISTS (SELECT 1 FROM ${schema}.telemetry_v1_records
        WHERE participant_id=$3 AND device_id=$6 AND stream='usage' AND occurrence_id=$10) AS record_absent,
      NOT EXISTS (SELECT 1 FROM ${schema}.community_daily_aggregates
        WHERE source_id=$1 AND day=$11::date) AS publication_absent`,
  [config.sourceId, config.sourceNamespace, OWNER_ID, SESSION_ID, PAIRING_ID,
    DEVICE_ID, AUTHORIZATION_ID, CHUNK_ID, OBJECT_KEY, OCCURRENCE_ID, config.day],
  "POSTGRES_COMMUNITY_DAILY_ACTIVATION_PRECONDITION_READ_FAILED");
  checkFixtureConflict(row);
  let policy = await queryOne(client,
    `SELECT singleton,publication_state,policy_revision FROM ${schema}.publication_state
      WHERE singleton=1 FOR SHARE`, [],
    "POSTGRES_COMMUNITY_DAILY_ACTIVATION_POLICY_READ_FAILED");
  if (Number(policy.singleton) !== 1 || Number(policy.policy_revision) !== 1
      || !["updating", "ready"].includes(policy.publication_state)) {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_POLICY_INVALID");
  }
  let eligibility;
  try {
    eligibility = await readPostgresCommunityDailyDaySourceEligibility(client, {
      day: config.day,
      schema: { primarySchema: config.schema },
    });
  } catch {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_SELECTION_READ_FAILED");
  }
  if (eligibility?.v1SelectedRecordsPresent !== false
      || eligibility?.v11SelectedRecordsPresent !== false) {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_SELECTED_DAY_CONFLICT");
  }
}

function syntheticUsageRecord(day) {
  const eventTime = `${day}T12:05:00.000Z`;
  return Object.freeze({
    schemaVersion: "usage-event-v1.0",
    eventId: OCCURRENCE_ID,
    eventTime,
    sessionUuid: "00000000-0000-4000-8000-000000000001",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    speedMode: "fast",
    apiServiceTier: "priority",
    surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription",
    reasoningEffort: "xhigh",
    agentScope: "root",
    outcome: "completed",
    totalInputContextTokens: null,
    components: Object.freeze({
      inputUncachedTokens: 100,
      inputCacheReadTokens: 900,
      inputCacheWriteTokens: 0,
      outputTextTokens: 50,
      outputReasoningTokens: 25,
      outputCombinedTokens: null,
    }),
  });
}

async function insertSyntheticFixture(client, schema, config) {
  const now = `${config.day}T12:00:00.000Z`;
  const expires = "2027-09-25T12:00:00.000Z";
  const secretHash = Buffer.alloc(32, 7);
  const csrfHash = Buffer.alloc(32, 8);
  const envelopeDigest = "b".repeat(64);
  const chunkDigest = "c".repeat(64);
  const record = syntheticUsageRecord(config.day);
  const statements = [
    [`INSERT INTO ${schema}.typed_telemetry_namespaces(id,original_id)
      VALUES (1,decode('00','hex') || convert_to($1,'UTF8'))`, [config.sourceNamespace]],
    [`INSERT INTO ${schema}.typed_v1_admission_state(
        id,source_namespace,namespace_id,runtime_contract_version,next_source_row_id)
      VALUES (1,$1,1,1,1)`, [config.sourceNamespace]],
    [`INSERT INTO ${schema}.typed_v11_admission_state(
        id,source_namespace,namespace_id,runtime_contract_version,next_source_row_id)
      VALUES (1,$1,1,1,1)`, [config.sourceNamespace]],
    [`INSERT INTO ${schema}.storage_source_state(singleton,source_id,authority_epoch)
      VALUES (1,$1,0)`, [config.sourceId]],
    [`INSERT INTO ${schema}.analytics_source_cursors(source_id,sequence,authority_epoch)
      VALUES ($1,0,0)`, [config.sourceId]],
    [`INSERT INTO ${schema}.participants(id,owner_kind,state,created_at)
      VALUES ($1,'social','active',$2::timestamptz)`, [OWNER_ID, now]],
    [`INSERT INTO ${schema}.web_sessions(
        id,participant_id,secret_hash,csrf_hash,issued_at,expires_at,last_used_at)
      VALUES ($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$5::timestamptz)`,
      [SESSION_ID, OWNER_ID, secretHash, csrfHash, now, expires]],
    [`INSERT INTO ${schema}.device_pairings(
        id,participant_id,issued_by_session_id,secret_hash,consent_version,
        transport_consent_version,state,issued_at,expires_at,consumed_at,claimed_device_id)
      VALUES ($1,$2,$3,$4,'synthetic-consent','synthetic-transport','consumed',
        $5::timestamptz,$6::timestamptz,$5::timestamptz,$7)`,
      [PAIRING_ID, OWNER_ID, SESSION_ID, secretHash, now, expires, DEVICE_ID]],
    [`INSERT INTO ${schema}.device_credentials(
        id,participant_id,paired_via_pairing_id,secret_hash,issued_at,expires_at,last_used_at)
      VALUES ($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$5::timestamptz)`,
      [DEVICE_ID, OWNER_ID, PAIRING_ID, secretHash, now, expires]],
    [`INSERT INTO ${schema}.device_upload_authorizations(
        id,participant_id,issued_by_device_id,secret_hash,envelope_digest,body_bytes,
        content_type,state,issued_at,expires_at,consumed_at)
      VALUES ($1,$2,$3,$4,$5,64,'application/json','consumed',
        $6::timestamptz,$7::timestamptz,$6::timestamptz)`,
      [AUTHORIZATION_ID, OWNER_ID, DEVICE_ID, secretHash, envelopeDigest, now, expires]],
    [`INSERT INTO ${schema}.pending_objects(contribution_id,object_key,object_kind)
      VALUES ($1,$2,'telemetry_v1')`, [CHUNK_ID, OBJECT_KEY]],
    [`INSERT INTO ${schema}.telemetry_v1_chunks(
        id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,chunk_digest,
        envelope_digest,parser_version,record_count,accepted_record_count,r2_key,
        device_upload_authorization_id,created_at)
      VALUES ($1,$2,$3,'usage',$4::date,0,1,$5,$6,'synthetic-daily-publication-v1',
        1,1,$7,$8,$9::timestamptz)`,
      [CHUNK_ID, OWNER_ID, DEVICE_ID, config.day, chunkDigest, envelopeDigest,
        OBJECT_KEY, AUTHORIZATION_ID, now]],
    [`INSERT INTO ${schema}.telemetry_v1_records(
        chunk_row_id,participant_id,device_id,stream,occurrence_id,observed_at,observed_day,
        provider,model_id,input_uncached_tokens,input_cache_read_tokens,input_cache_write_tokens,
        output_text_tokens,output_reasoning_tokens,output_combined_tokens,record_json)
      VALUES ($1,$2,$3,'usage',$4,$5::timestamptz,$6::date,$7,$8,100,900,0,50,25,NULL,$9::jsonb)`,
      [CHUNK_ID, OWNER_ID, DEVICE_ID, OCCURRENCE_ID, record.eventTime, config.day,
        record.provider, record.modelId, JSON.stringify(record)]],
  ];
  for (const [sql, values] of statements) {
    let result;
    try { result = await client.query(sql, values); } catch {
      fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_FIXTURE_INSERT_FAILED");
    }
    if (result?.rowCount !== 1) fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_FIXTURE_INSERT_FAILED");
  }
}

async function activatePublicationControls(client, schema) {
  let result;
  try {
    result = await client.query(
      `UPDATE ${schema}.collection_controls
          SET revision=3,control_state='operational',enrollment_enabled=false,
              upload_registration_enabled=true,processing_enabled=true,
              publication_enabled=true,reason_code='synthetic_daily_publication_test',
              updated_at=clock_timestamp()
        WHERE singleton=1 AND revision=2 AND control_state='degraded'
          AND enrollment_enabled=false AND upload_registration_enabled=true
          AND processing_enabled=true AND publication_enabled=false
          AND reason_code='synthetic_v12_test_upload_only'
        RETURNING singleton`,
    );
  } catch {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_CONTROLS_UPDATE_FAILED");
  }
  if (result?.rowCount !== 1 || result.rows?.length !== 1) {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_CONTROLS_UPDATE_FAILED");
  }
}

async function assertPreparedReadback(client, schema, config, {
  expectedControls = ACTIVE_CONTROLS,
  expectedPublicationCount = 0,
} = {}) {
  const counts = await queryOne(client, `
    SELECT
      (SELECT count(*) FROM ${schema}.typed_telemetry_namespaces WHERE id=1) AS namespace_count,
      (SELECT count(*) FROM ${schema}.typed_v1_admission_state WHERE id=1 AND source_namespace=$1
        AND namespace_id=1 AND runtime_contract_version=1 AND next_source_row_id=1) AS v1_admission_count,
      (SELECT count(*) FROM ${schema}.typed_v11_admission_state WHERE id=1 AND source_namespace=$1
        AND namespace_id=1 AND runtime_contract_version=1 AND next_source_row_id=1) AS v11_admission_count,
      (SELECT count(*) FROM ${schema}.storage_source_state WHERE singleton=1 AND source_id=$2 AND authority_epoch=0) AS source_state_count,
      (SELECT count(*) FROM ${schema}.analytics_source_cursors WHERE source_id=$2 AND sequence=0 AND authority_epoch=0) AS cursor_count,
      (SELECT count(*) FROM ${schema}.participants WHERE id=$3 AND owner_kind='social' AND state='active') AS owner_count,
      (SELECT count(*) FROM ${schema}.web_sessions WHERE id=$4 AND participant_id=$3 AND state='active') AS session_count,
      (SELECT count(*) FROM ${schema}.device_pairings WHERE id=$5 AND participant_id=$3 AND state='consumed') AS pairing_count,
      (SELECT count(*) FROM ${schema}.device_credentials WHERE id=$6 AND participant_id=$3 AND state='active') AS device_count,
      (SELECT count(*) FROM ${schema}.device_upload_authorizations WHERE id=$7 AND participant_id=$3
        AND issued_by_device_id=$6 AND state='consumed') AS authorization_count,
      (SELECT count(*) FROM ${schema}.pending_objects WHERE contribution_id=$8 AND object_key=$9
        AND object_kind='telemetry_v1' AND reconciliation_state='registered') AS pending_object_count,
      (SELECT count(*) FROM ${schema}.telemetry_v1_chunks WHERE id=$8 AND participant_id=$3
        AND device_id=$6 AND stream='usage' AND chunk_day=$10::date AND record_count=1
        AND accepted_record_count=1 AND superseded_at IS NULL) AS chunk_count,
      (SELECT count(*) FROM ${schema}.telemetry_v1_records WHERE chunk_row_id=$8 AND participant_id=$3
        AND device_id=$6 AND stream='usage' AND occurrence_id=$11 AND observed_day=$10::date
        AND provider='openai_codex' AND model_id='gpt-5.6-sol'
        AND input_uncached_tokens=100 AND input_cache_read_tokens=900
        AND output_text_tokens=50 AND output_reasoning_tokens=25) AS record_count,
      (SELECT count(*) FROM ${schema}.community_daily_aggregates WHERE source_id=$2 AND day=$10::date) AS publication_count`,
  [config.sourceNamespace, config.sourceId, OWNER_ID, SESSION_ID, PAIRING_ID,
    DEVICE_ID, AUTHORIZATION_ID, CHUNK_ID, OBJECT_KEY, config.day, OCCURRENCE_ID],
  "POSTGRES_COMMUNITY_DAILY_ACTIVATION_READBACK_FAILED");
  const expectedCounts = [
    "namespace_count", "v1_admission_count", "v11_admission_count", "source_state_count",
    "cursor_count", "owner_count", "session_count", "pairing_count", "device_count",
    "authorization_count", "pending_object_count", "chunk_count", "record_count",
  ];
  if (expectedCounts.some((key) => Number(counts[key]) !== 1)
      || Number(counts.publication_count) !== expectedPublicationCount) {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_READBACK_INVALID");
  }
  const recordRows = await queryOne(client,
    `SELECT record_json FROM ${schema}.telemetry_v1_records
      WHERE chunk_row_id=$1 AND participant_id=$2 AND device_id=$3
        AND stream='usage' AND occurrence_id=$4`,
    [CHUNK_ID, OWNER_ID, DEVICE_ID, OCCURRENCE_ID],
    "POSTGRES_COMMUNITY_DAILY_ACTIVATION_READBACK_FAILED");
  let record = recordRows.record_json;
  if (typeof record === "string") {
    try { record = JSON.parse(record); } catch {
      fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_READBACK_INVALID");
    }
  }
  if (!isDeepStrictEqual(record, syntheticUsageRecord(config.day))) {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_READBACK_INVALID");
  }
  const eligibility = await readPostgresCommunityDailyDaySourceEligibility(client, {
    day: config.day,
    schema: { primarySchema: config.schema },
  }).catch(() => fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_READBACK_FAILED"));
  if (eligibility?.v1SelectedRecordsPresent !== true
      || eligibility?.v11SelectedRecordsPresent !== false) {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_READBACK_INVALID");
  }
  await assertControlState(client, schema, expectedControls,
    "POSTGRES_COMMUNITY_DAILY_ACTIVATION_READBACK_INVALID");
}

async function assertRetainedPublication(client, schema, config) {
  const fence = await queryOne(client, `
    SELECT source.source_id,source.authority_epoch AS source_epoch,
           cursor.sequence AS cursor_sequence,cursor.authority_epoch AS cursor_epoch,
           policy.singleton AS policy_singleton,policy.publication_state,
           policy.policy_revision,
           COALESCE((SELECT max(change.sequence) FROM ${schema}.storage_ingestion_changes change
             WHERE change.source_id=$1),0)::text AS latest_sequence,
           COALESCE((SELECT max(change.sequence) FROM ${schema}.storage_ingestion_changes change
             WHERE change.source_id=$1 AND change.kind IN ('owner-withdrawn','owner-erased')),0)::text
             AS terminal_sequence
      FROM ${schema}.storage_source_state source
      JOIN ${schema}.analytics_source_cursors cursor ON cursor.source_id=source.source_id
      JOIN ${schema}.publication_state policy ON policy.singleton=1
     WHERE source.singleton=1 AND source.source_id=$1 AND cursor.source_id=$1
     FOR SHARE OF source,cursor,policy`,
  [config.sourceId],
  "POSTGRES_COMMUNITY_DAILY_ACTIVATION_RETRY_FENCE_READ_FAILED");
  if (fence.source_id !== config.sourceId
      || Number(fence.source_epoch) !== 0
      || Number(fence.cursor_sequence) !== 0
      || Number(fence.cursor_epoch) !== 0
      || Number(fence.latest_sequence) !== 0
      || Number(fence.terminal_sequence) !== 0
      || Number(fence.policy_singleton) !== 1
      || Number(fence.policy_revision) !== 1
      || !["updating", "ready"].includes(fence.publication_state)) {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_RETRY_FENCE_INVALID");
  }

  let result;
  try {
    result = await client.query(
      `SELECT source_namespace,day::text AS day,revision,payload_json,payload_sha256,
              source_authority_epoch,source_cursor_sequence,policy_revision,
              collection_revision,release_state,(withdrawn_at IS NULL) AS not_withdrawn
         FROM ${schema}.community_daily_aggregates
        WHERE source_id=$1 AND day=$2::date
        ORDER BY revision FOR SHARE`,
      [config.sourceId, config.day],
    );
  } catch {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_RETRY_PUBLICATION_READ_FAILED");
  }
  if (result?.rowCount !== 1 || !Array.isArray(result.rows) || result.rows.length !== 1) {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_RETRY_PUBLICATION_INVALID");
  }
  const row = result.rows[0];
  if (row.source_namespace !== config.sourceNamespace || row.day !== config.day
      || Number(row.revision) !== 1 || Number(row.source_authority_epoch) !== 0
      || Number(row.source_cursor_sequence) !== 0 || Number(row.policy_revision) !== 1
      || Number(row.collection_revision) !== 3 || row.release_state !== "published"
      || row.not_withdrawn !== true || typeof row.payload_json !== "string"
      || !/^[0-9a-f]{64}$/u.test(row.payload_sha256 ?? "")) {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_RETRY_PUBLICATION_INVALID");
  }
  const digest = createHash("sha256").update(row.payload_json, "utf8").digest("hex");
  if (digest !== row.payload_sha256) {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_RETRY_PUBLICATION_INVALID");
  }
  let payload;
  try { payload = JSON.parse(row.payload_json); } catch {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_RETRY_PUBLICATION_INVALID");
  }
  const expectedTotals = {
    contributingParticipants: 1,
    contributingDevices: 1,
    usageEvents: 1,
    quotaObservations: 0,
    sessionDimensions: 0,
    inputUncachedTokens: 100,
    inputCacheReadTokens: 900,
    inputCacheWriteTokens: 0,
    outputTextTokens: 50,
    outputReasoningTokens: 25,
    outputCombinedTokens: 75,
  };
  const expectedCell = {
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    usageEvents: 1,
    inputUncachedTokens: 100,
    inputCacheReadTokens: 900,
    inputCacheWriteTokens: 0,
    outputTextTokens: 50,
    outputReasoningTokens: 25,
    outputCombinedTokens: 75,
  };
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)
      || payload.schemaVersion !== "community-daily-aggregate-v1.0"
      || payload.aggregateId !== `community-daily:${config.day}:r1`
      || payload.day !== config.day || payload.revision !== 1
      || payload.immutableRevision !== true
      || !isDeepStrictEqual(payload.totals, expectedTotals)
      || !Array.isArray(payload.cells) || payload.cells.length !== 1
      || !isDeepStrictEqual(payload.cells[0], expectedCell)) {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_RETRY_PUBLICATION_INVALID");
  }
}

async function activateRetryPublicationControls(client, schema) {
  let result;
  try {
    result = await client.query(
      `UPDATE ${schema}.collection_controls
          SET revision=5,control_state='operational',enrollment_enabled=false,
              upload_registration_enabled=true,processing_enabled=true,
              publication_enabled=true,reason_code='synthetic_daily_publication_test',
              updated_at=clock_timestamp()
        WHERE singleton=1 AND revision=4 AND control_state='degraded'
          AND enrollment_enabled=false AND upload_registration_enabled=true
          AND processing_enabled=true AND publication_enabled=false
          AND reason_code='synthetic_v12_test_upload_only'
        RETURNING singleton`,
    );
  } catch {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_RETRY_CONTROLS_UPDATE_FAILED");
  }
  if (result?.rowCount !== 1 || result.rows?.length !== 1) {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_RETRY_CONTROLS_UPDATE_FAILED");
  }
}

async function prepareTransaction(client, config, migrations) {
  const schema = quotedSchema(config.schema);
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
  let open = true;
  try {
    await client.query("SET LOCAL statement_timeout='30000ms'");
    await client.query("SET LOCAL lock_timeout='5000ms'");
    await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
    await verifyPostgresAndMigrations(client, migrations, config.schema);
    await assertControlState(client, schema, BASELINE_CONTROLS,
      "POSTGRES_COMMUNITY_DAILY_ACTIVATION_CONTROLS_BASELINE_MISMATCH", true);
    await assertFixturePreconditions(client, schema, config);
    await insertSyntheticFixture(client, schema, config);
    await activatePublicationControls(client, schema);
    await assertPreparedReadback(client, schema, config);
    await client.query("COMMIT");
    open = false;
    return Object.freeze({
      schemaVersion: "postgres-community-daily-activation-v1",
      status: "prepared",
      project: config.project,
      schema: config.schema,
      day: config.day,
      collectionControlsRevision: 3,
      fixture: "one_content_free_social_v1_usage_event",
    });
  } catch (error) {
    if (open) {
      try { await client.query("ROLLBACK"); } catch { /* safe code reported below */ }
    }
    throw error;
  }
}

async function retryPrepareTransaction(client, config, migrations) {
  const schema = quotedSchema(config.schema);
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
  let open = true;
  try {
    await client.query("SET LOCAL statement_timeout='30000ms'");
    await client.query("SET LOCAL lock_timeout='5000ms'");
    await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
    await verifyPostgresAndMigrations(client, migrations, config.schema);
    await assertControlState(client, schema, RESTORED_CONTROLS,
      "POSTGRES_COMMUNITY_DAILY_ACTIVATION_RETRY_CONTROLS_BASELINE_MISMATCH", true);
    await assertPreparedReadback(client, schema, config, {
      expectedControls: RESTORED_CONTROLS,
      expectedPublicationCount: 1,
    });
    await assertRetainedPublication(client, schema, config);
    await activateRetryPublicationControls(client, schema);
    await assertPreparedReadback(client, schema, config, {
      expectedControls: RETRY_ACTIVE_CONTROLS,
      expectedPublicationCount: 1,
    });
    await client.query("COMMIT");
    open = false;
    return Object.freeze({
      schemaVersion: "postgres-community-daily-retry-activation-v1",
      status: "retry_prepared",
      project: config.project,
      schema: config.schema,
      day: config.day,
      collectionControlsRevision: 5,
      retainedPublicationRevision: 1,
      fixtureInserted: false,
    });
  } catch (error) {
    if (open) {
      try { await client.query("ROLLBACK"); } catch { /* safe code reported below */ }
    }
    throw error;
  }
}

async function restoreTransaction(client, config, migrations) {
  const schema = quotedSchema(config.schema);
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
  let open = true;
  try {
    await client.query("SET LOCAL statement_timeout='30000ms'");
    await client.query("SET LOCAL lock_timeout='5000ms'");
    await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
    await verifyPostgresAndMigrations(client, migrations, config.schema);
    const current = await queryOne(client, controlsSelect(schema, true), [],
      "POSTGRES_COMMUNITY_DAILY_ACTIVATION_RESTORE_STATE_READ_FAILED");
    let status;
    if (exactControlState(current, RESTORED_CONTROLS)) {
      status = "already_restored";
    } else {
      assertExpectedControls(current, ACTIVE_CONTROLS,
        "POSTGRES_COMMUNITY_DAILY_ACTIVATION_RESTORE_STATE_MISMATCH");
      let updated;
      try {
        updated = await client.query(
          `UPDATE ${schema}.collection_controls
              SET revision=4,control_state='degraded',enrollment_enabled=false,
                  upload_registration_enabled=true,processing_enabled=true,
                  publication_enabled=false,reason_code='synthetic_v12_test_upload_only',
                  updated_at=clock_timestamp()
            WHERE singleton=1 AND revision=3 AND control_state='operational'
              AND enrollment_enabled=false AND upload_registration_enabled=true
              AND processing_enabled=true AND publication_enabled=true
              AND reason_code='synthetic_daily_publication_test'
            RETURNING singleton`,
        );
      } catch {
        fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_RESTORE_UPDATE_FAILED");
      }
      if (updated?.rowCount !== 1 || updated.rows?.length !== 1) {
        fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_RESTORE_UPDATE_FAILED");
      }
      await assertControlState(client, schema, RESTORED_CONTROLS,
        "POSTGRES_COMMUNITY_DAILY_ACTIVATION_RESTORE_READBACK_INVALID");
      status = "restored";
    }
    await client.query("COMMIT");
    open = false;
    return Object.freeze({
      schemaVersion: "postgres-community-daily-activation-v1",
      status,
      project: config.project,
      schema: config.schema,
      collectionControlsRevision: 4,
      publicationEnabled: false,
      enrollmentEnabled: false,
      fixtureRetained: true,
    });
  } catch (error) {
    if (open) {
      try { await client.query("ROLLBACK"); } catch { /* safe code reported below */ }
    }
    throw error;
  }
}

async function retryRestoreTransaction(client, config, migrations) {
  const schema = quotedSchema(config.schema);
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
  let open = true;
  try {
    await client.query("SET LOCAL statement_timeout='30000ms'");
    await client.query("SET LOCAL lock_timeout='5000ms'");
    await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
    await verifyPostgresAndMigrations(client, migrations, config.schema);
    const current = await queryOne(client, controlsSelect(schema, true), [],
      "POSTGRES_COMMUNITY_DAILY_ACTIVATION_RETRY_RESTORE_STATE_READ_FAILED");
    let status;
    if (exactControlState(current, RETRY_RESTORED_CONTROLS)) {
      status = "already_restored";
    } else {
      assertExpectedControls(current, RETRY_ACTIVE_CONTROLS,
        "POSTGRES_COMMUNITY_DAILY_ACTIVATION_RETRY_RESTORE_STATE_MISMATCH");
      let updated;
      try {
        updated = await client.query(
          `UPDATE ${schema}.collection_controls
              SET revision=6,control_state='degraded',enrollment_enabled=false,
                  upload_registration_enabled=true,processing_enabled=true,
                  publication_enabled=false,reason_code='synthetic_v12_test_upload_only',
                  updated_at=clock_timestamp()
            WHERE singleton=1 AND revision=5 AND control_state='operational'
              AND enrollment_enabled=false AND upload_registration_enabled=true
              AND processing_enabled=true AND publication_enabled=true
              AND reason_code='synthetic_daily_publication_test'
            RETURNING singleton`,
        );
      } catch {
        fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_RETRY_RESTORE_UPDATE_FAILED");
      }
      if (updated?.rowCount !== 1 || updated.rows?.length !== 1) {
        fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_RETRY_RESTORE_UPDATE_FAILED");
      }
      await assertControlState(client, schema, RETRY_RESTORED_CONTROLS,
        "POSTGRES_COMMUNITY_DAILY_ACTIVATION_RETRY_RESTORE_READBACK_INVALID");
      status = "restored";
    }
    await client.query("COMMIT");
    open = false;
    return Object.freeze({
      schemaVersion: "postgres-community-daily-retry-activation-v1",
      status,
      project: config.project,
      schema: config.schema,
      collectionControlsRevision: 6,
      publicationEnabled: false,
      enrollmentEnabled: false,
      fixtureRetained: true,
    });
  } catch (error) {
    if (open) {
      try { await client.query("ROLLBACK"); } catch { /* safe code reported below */ }
    }
    throw error;
  }
}

function disposableIntegrationConfig(config) {
  if (config === null || typeof config !== "object"
      || config.project !== CLOUD_RUN_IAM_TEST_TARGET.project
      || !/^a2_daily_activation_[a-f0-9]{12}$/u.test(config.schema ?? "")
      || config.day !== POSTGRES_COMMUNITY_DAILY_ACTIVATION_DAY
      || config.sourceId !== POSTGRES_COMMUNITY_DAILY_ACTIVATION_SOURCE_ID
      || config.sourceNamespace !== POSTGRES_COMMUNITY_DAILY_ACTIVATION_SOURCE_NAMESPACE) {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_TEST_SCHEMA_INVALID");
  }
  return Object.freeze({ ...config });
}

/** Exercise the same reviewed preparation transaction only in a disposable local test schema. */
export async function preparePostgresCommunityDailyActivationInDisposableSchema({
  client,
  config,
  migrations,
} = {}) {
  if (client === null || typeof client?.query !== "function") {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_TEST_CLIENT_INVALID");
  }
  return prepareTransaction(client, disposableIntegrationConfig(config), migrationSummary(migrations));
}

/** Exercise the same independent restore transaction only in a disposable local test schema. */
export async function restorePostgresCommunityDailyActivationInDisposableSchema({
  client,
  config,
  migrations,
} = {}) {
  if (client === null || typeof client?.query !== "function") {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_TEST_CLIENT_INVALID");
  }
  return restoreTransaction(client, disposableIntegrationConfig(config), migrationSummary(migrations));
}

/** Exercise the retry prepare transaction only in a disposable local test schema. */
export async function preparePostgresCommunityDailyRetryActivationInDisposableSchema({
  client,
  config,
  migrations,
} = {}) {
  if (client === null || typeof client?.query !== "function") {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_TEST_CLIENT_INVALID");
  }
  return retryPrepareTransaction(client, disposableIntegrationConfig(config), migrationSummary(migrations));
}

/** Exercise the independent retry restore transaction only in a disposable local test schema. */
export async function restorePostgresCommunityDailyRetryActivationInDisposableSchema({
  client,
  config,
  migrations,
} = {}) {
  if (client === null || typeof client?.query !== "function") {
    fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_TEST_CLIENT_INVALID");
  }
  return retryRestoreTransaction(client, disposableIntegrationConfig(config), migrationSummary(migrations));
}

async function runActivation(mode, { env = process.env, dependencies = {} } = {}) {
  const readServiceAccount = dependencies.readServiceAccountEmail
    ?? readAttachedPostgresCommunityDailyActivationServiceAccount;
  const email = await readServiceAccount({ fetchImpl: dependencies.fetchImpl });
  const config = parseConfig(env, email, mode);
  const migrationRoot = dependencies.migrationRoot
    ?? "/app/apps/worker/postgres/migrations";
  const migrations = migrationSummary(await (dependencies.readMigrations ?? readPostgresMigrations)({
    role: "primary",
    rootDirectory: migrationRoot,
  }));
  let connector;
  let pool;
  let client;
  let result;
  let failure;
  try {
    connector = (dependencies.createConnector ?? (() => new Connector()))();
    pool = await (dependencies.createPool ?? createIamPool)({
      connector,
      instanceConnectionName: config.instanceConnectionName,
      database: config.database,
      user: config.iamUser,
      max: 1,
      applicationName: "tibotattle-community-daily-test-activation",
    });
    client = await pool.connect();
    if (mode === "prepare") result = await prepareTransaction(client, config, migrations);
    else if (mode === "restore") result = await restoreTransaction(client, config, migrations);
    else if (mode === "retry-prepare") result = await retryPrepareTransaction(client, config, migrations);
    else result = await retryRestoreTransaction(client, config, migrations);
  } catch (error) {
    failure = error;
  }
  let cleanupFailure;
  try {
    if (client !== undefined) await client.release();
  } catch {
    cleanupFailure = "POSTGRES_COMMUNITY_DAILY_ACTIVATION_CLIENT_CLOSE_FAILED";
  }
  try {
    await (dependencies.closeResources ?? closeCloudSqlResources)({
      pools: pool === undefined ? [] : [pool],
      connector,
    });
  } catch {
    cleanupFailure ??= "POSTGRES_COMMUNITY_DAILY_ACTIVATION_CLEANUP_FAILED";
  }
  if (failure !== undefined) throw failure;
  if (cleanupFailure !== undefined) fail(cleanupFailure);
  return result;
}

export async function preparePostgresCommunityDailyTestActivation(options = {}) {
  return runActivation("prepare", options);
}

export async function restorePostgresCommunityDailyTestActivation(options = {}) {
  return runActivation("restore", options);
}

export async function preparePostgresCommunityDailyRetryTestActivation(options = {}) {
  return runActivation("retry-prepare", options);
}

export async function restorePostgresCommunityDailyRetryTestActivation(options = {}) {
  return runActivation("retry-restore", options);
}

export function isPostgresCommunityDailyRetryActivationInvocation(args) {
  if (!Array.isArray(args)) fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_ARGUMENTS_INVALID");
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === "--retry-retained-a2-publication") return true;
  fail("POSTGRES_COMMUNITY_DAILY_ACTIVATION_ARGUMENTS_INVALID");
}

export function postgresCommunityDailyActivationErrorReceipt(error, mode) {
  const prefix = mode === "restore"
    ? "POSTGRES_COMMUNITY_DAILY_ACTIVATION_"
    : "POSTGRES_COMMUNITY_DAILY_ACTIVATION_";
  const cloudRunPrefix = "CLOUD_RUN_COMMUNITY_DAILY_ACTIVATION_";
  const code = typeof error?.code === "string"
      && (error.code.startsWith(prefix) || error.code.startsWith(cloudRunPrefix))
    ? error.code : "POSTGRES_COMMUNITY_DAILY_ACTIVATION_FAILED";
  return Object.freeze({
    schemaVersion: "postgres-community-daily-activation-v1",
    status: "failed",
    mode,
    code,
  });
}

async function main(mode) {
  try {
    const result = mode === "prepare"
      ? await preparePostgresCommunityDailyTestActivation()
      : await restorePostgresCommunityDailyTestActivation();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(postgresCommunityDailyActivationErrorReceipt(error, mode))}\n`);
    process.exitCode = 1;
  }
}

export async function runPostgresCommunityDailyActivationCli(mode, argvPath = process.argv[1]) {
  if (typeof argvPath === "string" && resolve(argvPath) === fileURLToPath(import.meta.url)) {
    await main(mode);
  }
}
