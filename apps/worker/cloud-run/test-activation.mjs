#!/usr/bin/env node

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connector } from "@google-cloud/cloud-sql-connector";
import { readPostgresMigrations } from "./postgres-migrations.mjs";
import {
  closeCloudSqlResources,
  createIamPool as createCloudSqlIamPool,
} from "./cloud-sql.mjs";
import { CLOUD_RUN_IAM_TEST_TARGET } from "./postgres-test-dispatch.mjs";

export const TEST_ACTIVATION_JOB = "tibotattle-v12-test-activate";
export const TEST_ACTIVATION_SERVICE_ACCOUNT =
  "tibotattle-test-migrator@tibotattle.iam.gserviceaccount.com";
export const TEST_ACTIVATION_IAM_USER = "tibotattle-test-migrator@tibotattle.iam";
export const TEST_ACTIVATION_MIGRATION_ROOT = "/app/apps/worker/postgres/migrations";
export const TEST_ACTIVATION_TARGET = CLOUD_RUN_IAM_TEST_TARGET.postgres.primary;

const TEST_ACTIVATION_PROJECT = CLOUD_RUN_IAM_TEST_TARGET.project;
const EXPECTED_MIGRATION_COUNT = 62;
const EXPECTED_MIGRATION_TAIL = "0062_telemetry_contribution_trigger_search_path.sql";
const METADATA_EMAIL_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email";
const EXECUTION_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const MIGRATION_NAME_PATTERN = /^\d{4}_[a-z][a-z0-9_-]*\.sql$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/u;
const MIGRATOR_APPLICATION_NAME = "tibotattle-test-v12-activation";
const TEST_COLLECTION_CONTROL_REASON = "synthetic_v12_test_upload_only";
const MIGRATION_HISTORY_TABLE = `"${TEST_ACTIVATION_TARGET.schema}"."_tibotattle_migration_history"`;
const TABLES = Object.freeze({
  legacyRuntime: `"${TEST_ACTIVATION_TARGET.schema}"."telemetry_v12_runtime"`,
  typedRuntime: `"${TEST_ACTIVATION_TARGET.schema}"."telemetry_v12_typed_runtime"`,
  collectionControls: `"${TEST_ACTIVATION_TARGET.schema}"."collection_controls"`,
});
const TYPED_RUNTIME_CONTRACT = Object.freeze({
  schema_version: "telemetry-contribution-v1.2",
  envelope_schema_version: "telemetry-envelope-v1.2",
  field_dictionary_version: "telemetry-v1.2-registry-2026-09-20.1",
  privacy_contract_version: "ongoing-privacy-safe-telemetry-v1.2",
  policy_revision: 1,
  max_day_chunks: 4096,
  max_chunk_records: 200,
  max_day_bytes: 64_000_000,
});
const STATE_DIAGNOSTIC_FIELDS = Object.freeze([
  "legacy.id",
  "legacy.state",
  "legacy.revision",
  "typed.id",
  "typed.schema_version",
  "typed.envelope_schema_version",
  "typed.field_dictionary_version",
  "typed.privacy_contract_version",
  "typed.state",
  "typed.policy_revision",
  "typed.max_day_chunks",
  "typed.max_chunk_records",
  "typed.max_day_bytes",
  "controls.singleton",
  "controls.revision",
  "controls.control_state",
  "controls.enrollment_enabled",
  "controls.upload_registration_enabled",
  "controls.processing_enabled",
  "controls.publication_enabled",
  "controls.reason_code",
]);
const STATE_DIAGNOSTIC_FIELD_SET = new Set(STATE_DIAGNOSTIC_FIELDS);
const LEGACY_RUNTIME_STATES = new Set(["staged", "active", "blocked"]);
const TYPED_RUNTIME_STATES = new Set(["staged", "active"]);
const COLLECTION_CONTROL_STATES = new Set(["operational", "degraded", "contained"]);
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function safeErrorCode(error, fallback = "POSTGRES_TEST_ACTIVATION_FAILED") {
  return typeof error?.code === "string"
      && /^(?:CLOUD_RUN|CLOUD_SQL|POSTGRES)_TEST_ACTIVATION_[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : fallback;
}

export function parseTestActivationConfig(env, attachedServiceAccountEmail) {
  if (env === null || typeof env !== "object"
      || env.CLOUD_RUN_JOB !== TEST_ACTIVATION_JOB
      || !EXECUTION_PATTERN.test(env.CLOUD_RUN_EXECUTION ?? "")
      || env.CLOUD_RUN_TASK_INDEX !== "0"
      || env.CLOUD_RUN_TASK_COUNT !== "1"
      || env.CLOUD_RUN_TASK_ATTEMPT !== "0"
      || env.GOOGLE_CLOUD_PROJECT !== TEST_ACTIVATION_PROJECT
      || env.K_SERVICE !== undefined) {
    fail("CLOUD_RUN_TEST_ACTIVATION_JOB_CONTEXT_INVALID");
  }
  if (env.POSTGRES_MIGRATOR_IAM_USER !== TEST_ACTIVATION_IAM_USER) {
    fail("POSTGRES_TEST_ACTIVATION_IAM_USER_INVALID");
  }
  if (env.PRIMARY_INSTANCE_CONNECTION_NAME !== TEST_ACTIVATION_TARGET.instanceConnectionName
      || env.PRIMARY_DATABASE !== TEST_ACTIVATION_TARGET.database
      || env.PRIMARY_SCHEMA !== TEST_ACTIVATION_TARGET.schema
      || !SCHEMA_PATTERN.test(env.PRIMARY_SCHEMA)) {
    fail("POSTGRES_TEST_ACTIVATION_TARGET_INVALID");
  }
  if (attachedServiceAccountEmail !== TEST_ACTIVATION_SERVICE_ACCOUNT) {
    fail("CLOUD_RUN_TEST_ACTIVATION_SERVICE_ACCOUNT_INVALID");
  }
  return Object.freeze({
    job: TEST_ACTIVATION_JOB,
    project: TEST_ACTIVATION_PROJECT,
    instanceConnectionName: TEST_ACTIVATION_TARGET.instanceConnectionName,
    database: TEST_ACTIVATION_TARGET.database,
    schema: TEST_ACTIVATION_TARGET.schema,
    iamUser: TEST_ACTIVATION_IAM_USER,
  });
}

export async function readAttachedTestActivationServiceAccount({
  fetchImpl = globalThis.fetch,
  timeoutMilliseconds = 3_000,
} = {}) {
  if (typeof fetchImpl !== "function"
      || !Number.isSafeInteger(timeoutMilliseconds)
      || timeoutMilliseconds < 1 || timeoutMilliseconds > 10_000) {
    fail("CLOUD_RUN_TEST_ACTIVATION_METADATA_UNAVAILABLE");
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
    fail("CLOUD_RUN_TEST_ACTIVATION_METADATA_UNAVAILABLE");
  }
  if (response?.status !== 200
      || response.headers?.get("Metadata-Flavor") !== "Google") {
    fail("CLOUD_RUN_TEST_ACTIVATION_METADATA_UNAVAILABLE");
  }
  let email;
  try { email = (await response.text()).trim(); } catch {
    fail("CLOUD_RUN_TEST_ACTIVATION_METADATA_UNAVAILABLE");
  }
  if (email !== TEST_ACTIVATION_SERVICE_ACCOUNT) {
    fail("CLOUD_RUN_TEST_ACTIVATION_SERVICE_ACCOUNT_INVALID");
  }
  return email;
}

function validatePrimaryMigrations(migrations) {
  if (!Array.isArray(migrations) || migrations.length !== EXPECTED_MIGRATION_COUNT) {
    fail("POSTGRES_TEST_ACTIVATION_MIGRATION_SOURCE_INVALID");
  }
  const expected = migrations.map((migration, index) => {
    if (migration === null || typeof migration !== "object"
        || migration.role !== "primary"
        || migration.version !== index + 1
        || !MIGRATION_NAME_PATTERN.test(migration.name ?? "")
        || typeof migration.sql !== "string"
        || !Number.isSafeInteger(migration.bytes)
        || Buffer.byteLength(migration.sql) !== migration.bytes
        || !SHA256_PATTERN.test(migration.sha256 ?? "")
        || createHash("sha256").update(migration.sql).digest("hex") !== migration.sha256) {
      fail("POSTGRES_TEST_ACTIVATION_MIGRATION_SOURCE_INVALID");
    }
    return Object.freeze({
      version: migration.version,
      name: migration.name,
      sha256: migration.sha256,
    });
  });
  if (expected.at(-1)?.name !== EXPECTED_MIGRATION_TAIL) {
    fail("POSTGRES_TEST_ACTIVATION_MIGRATION_SOURCE_INVALID");
  }
  return Object.freeze(expected);
}

function rowsFrom(result, code) {
  if (result === null || typeof result !== "object"
      || !Array.isArray(result.rows)
      || result.rowCount !== null && result.rowCount !== result.rows.length) {
    fail(code);
  }
  return result.rows;
}

async function queryRows(client, sql, code) {
  try { return rowsFrom(await client.query(sql), code); } catch (error) {
    if (typeof error?.code === "string"
        && /^POSTGRES_TEST_ACTIVATION_[A-Z0-9_]+$/u.test(error.code)) throw error;
    fail(code);
  }
}

async function verifyPostgres17(client) {
  const rows = await queryRows(
    client,
    "SELECT current_setting('server_version_num')::integer AS server_version_num",
    "POSTGRES_TEST_ACTIVATION_VERSION_READ_FAILED",
  );
  if (rows.length !== 1
      || Math.floor(Number(rows[0]?.server_version_num) / 10_000) !== 17) {
    fail("POSTGRES_TEST_ACTIVATION_VERSION_UNSUPPORTED");
  }
}

async function verifyMigrationReceipt(client, expected) {
  const rows = await queryRows(
    client,
    `SELECT version, name, checksum_sha256
       FROM ${MIGRATION_HISTORY_TABLE}
      ORDER BY version FOR SHARE`,
    "POSTGRES_TEST_ACTIVATION_MIGRATION_RECEIPT_READ_FAILED",
  );
  if (rows.length !== expected.length || rows.at(-1)?.version !== EXPECTED_MIGRATION_COUNT) {
    fail("POSTGRES_TEST_ACTIVATION_MIGRATION_RECEIPT_MISMATCH");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const actual = rows[index];
    const wanted = expected[index];
    if (actual?.version !== wanted.version
        || actual?.name !== wanted.name
        || actual?.checksum_sha256 !== wanted.sha256) {
      fail("POSTGRES_TEST_ACTIVATION_MIGRATION_RECEIPT_MISMATCH");
    }
  }
}

async function readActivationState(client) {
  const legacyRows = await queryRows(
    client,
    `SELECT id, state, revision FROM ${TABLES.legacyRuntime} WHERE id = 1 FOR UPDATE`,
    "POSTGRES_TEST_ACTIVATION_RUNTIME_READ_FAILED",
  );
  const typedRows = await queryRows(
    client,
    `SELECT id, schema_version, envelope_schema_version, field_dictionary_version,
            privacy_contract_version, state, policy_revision, max_day_chunks,
            max_chunk_records, max_day_bytes
       FROM ${TABLES.typedRuntime} WHERE id = 1 FOR UPDATE`,
    "POSTGRES_TEST_ACTIVATION_TYPED_RUNTIME_READ_FAILED",
  );
  const controlsRows = await queryRows(
    client,
    `SELECT singleton, revision, control_state, enrollment_enabled,
            upload_registration_enabled, processing_enabled, publication_enabled,
            reason_code
       FROM ${TABLES.collectionControls} WHERE singleton = 1 FOR UPDATE`,
    "POSTGRES_TEST_ACTIVATION_COLLECTION_CONTROLS_READ_FAILED",
  );
  if (legacyRows.length !== 1 || typedRows.length !== 1 || controlsRows.length !== 1) {
    fail("POSTGRES_TEST_ACTIVATION_STATE_MISSING");
  }
  return Object.freeze({ legacy: legacyRows[0], typed: typedRows[0], controls: controlsRows[0] });
}

function revisionIs(value, expected) {
  return value === expected || value === String(expected);
}

function stateMismatches(snapshot, expected) {
  const mismatches = [];
  for (const [field, actual, wanted, compare] of expected) {
    if (!(compare ?? Object.is)(actual, wanted)) mismatches.push(field);
  }
  return mismatches;
}

function stateExpectations(snapshot, expectedState) {
  const { legacy, typed, controls } = snapshot;
  if (expectedState === "staged") {
    return [
      ["legacy.state", legacy.state, "staged"],
      ["legacy.revision", legacy.revision, 0, revisionIs],
      ["typed.state", typed.state, "staged"],
      ["controls.control_state", controls.control_state, "contained"],
      ["controls.revision", controls.revision, 1, revisionIs],
      ["controls.enrollment_enabled", controls.enrollment_enabled, false],
      ["controls.upload_registration_enabled", controls.upload_registration_enabled, false],
      ["controls.processing_enabled", controls.processing_enabled, false],
      ["controls.publication_enabled", controls.publication_enabled, false],
      ["controls.reason_code", controls.reason_code, null],
    ];
  }
  if (expectedState === "legacy_active_operational") {
    // This exception accepts only the exact named test prestate, including the
    // historical reason code that was observed in the bounded live receipt.
    return [
      ["legacy.state", legacy.state, "active"],
      ["legacy.revision", legacy.revision, 1, revisionIs],
      ["typed.state", typed.state, "staged"],
      ["controls.control_state", controls.control_state, "operational"],
      ["controls.revision", controls.revision, 14, revisionIs],
      ["controls.enrollment_enabled", controls.enrollment_enabled, true],
      ["controls.upload_registration_enabled", controls.upload_registration_enabled, true],
      ["controls.processing_enabled", controls.processing_enabled, true],
      ["controls.publication_enabled", controls.publication_enabled, true],
      ["controls.reason_code", controls.reason_code, "maintenance"],
    ];
  }
  const revision = expectedState === "active_rev15" ? 15 : 2;
  return [
    ["legacy.state", legacy.state, "active"],
    ["legacy.revision", legacy.revision, 1, revisionIs],
    ["typed.state", typed.state, "active"],
    ["controls.control_state", controls.control_state, "degraded"],
    ["controls.revision", controls.revision, revision, revisionIs],
    ["controls.enrollment_enabled", controls.enrollment_enabled, false],
    ["controls.upload_registration_enabled", controls.upload_registration_enabled, true],
    ["controls.processing_enabled", controls.processing_enabled, true],
    ["controls.publication_enabled", controls.publication_enabled, false],
    ["controls.reason_code", controls.reason_code, TEST_COLLECTION_CONTROL_REASON],
  ];
}

function failState(fields, snapshot) {
  const stateMismatchFields = [...new Set(fields)]
    .filter((field) => STATE_DIAGNOSTIC_FIELD_SET.has(field));
  const error = Object.assign(new Error("POSTGRES_TEST_ACTIVATION_STATE_UNEXPECTED"), {
    code: "POSTGRES_TEST_ACTIVATION_STATE_UNEXPECTED",
    stateMismatchFields: Object.freeze(stateMismatchFields),
  });
  const stateSnapshot = normalizeActivationStateSnapshot(snapshot);
  if (stateSnapshot !== undefined) error.stateSnapshot = stateSnapshot;
  throw error;
}

function normalizeRevision(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/u.test(value)) return undefined;
  try {
    return BigInt(value) <= POSTGRES_BIGINT_MAX ? value : undefined;
  } catch {
    return undefined;
  }
}

function normalizeActivationStateSnapshot(snapshot) {
  if (snapshot === null || typeof snapshot !== "object") return undefined;
  const { legacy, typed, controls } = snapshot;
  if (legacy === null || typeof legacy !== "object"
      || !LEGACY_RUNTIME_STATES.has(legacy.state)
      || typed === null || typeof typed !== "object"
      || !TYPED_RUNTIME_STATES.has(typed.state)
      || controls === null || typeof controls !== "object"
      || !COLLECTION_CONTROL_STATES.has(controls.control_state)
      || typeof controls.enrollment_enabled !== "boolean"
      || typeof controls.upload_registration_enabled !== "boolean"
      || typeof controls.processing_enabled !== "boolean"
      || typeof controls.publication_enabled !== "boolean") {
    return undefined;
  }
  const legacyRevision = normalizeRevision(legacy.revision);
  const controlsRevision = normalizeRevision(controls.revision);
  if (legacyRevision === undefined || controlsRevision === undefined) return undefined;
  return Object.freeze({
    legacy: Object.freeze({ state: legacy.state, revision: legacyRevision }),
    typed: Object.freeze({ state: typed.state }),
    controls: Object.freeze({
      control_state: controls.control_state,
      revision: controlsRevision,
      enrollment_enabled: controls.enrollment_enabled,
      upload_registration_enabled: controls.upload_registration_enabled,
      processing_enabled: controls.processing_enabled,
      publication_enabled: controls.publication_enabled,
    }),
  });
}

export function safeActivationStateSnapshot(error) {
  if (error?.code !== "POSTGRES_TEST_ACTIVATION_STATE_UNEXPECTED") return undefined;
  try { return normalizeActivationStateSnapshot(error.stateSnapshot); } catch { return undefined; }
}

export function safeActivationStateMismatchFields(error) {
  if (error?.code !== "POSTGRES_TEST_ACTIVATION_STATE_UNEXPECTED"
      || !Array.isArray(error.stateMismatchFields)
      || error.stateMismatchFields.length < 1
      || error.stateMismatchFields.length > STATE_DIAGNOSTIC_FIELDS.length
      || error.stateMismatchFields.some((field) => !STATE_DIAGNOSTIC_FIELD_SET.has(field))) {
    return undefined;
  }
  return Object.freeze([...new Set(error.stateMismatchFields)]);
}

export function activationErrorReceipt(error) {
  const receipt = { status: "error", code: safeErrorCode(error) };
  const stateMismatchFields = safeActivationStateMismatchFields(error);
  if (stateMismatchFields !== undefined) receipt.stateMismatchFields = stateMismatchFields;
  const stateSnapshot = safeActivationStateSnapshot(error);
  if (stateSnapshot !== undefined) receipt.stateSnapshot = stateSnapshot;
  return Object.freeze(receipt);
}

export function classifyActivationState(snapshot) {
  const { legacy, typed, controls } = snapshot;
  const configurationMismatches = [];
  if (legacy.id !== 1) configurationMismatches.push("legacy.id");
  if (typed.id !== 1) configurationMismatches.push("typed.id");
  for (const [key, expected] of Object.entries(TYPED_RUNTIME_CONTRACT)) {
    if (typed[key] !== expected) configurationMismatches.push(`typed.${key}`);
  }
  if (controls.singleton !== 1) configurationMismatches.push("controls.singleton");
  if (configurationMismatches.length > 0) failState(configurationMismatches, snapshot);

  const stagedMismatches = stateMismatches(snapshot, stateExpectations(snapshot, "staged"));
  if (stagedMismatches.length === 0) return "staged";
  const recoveryMismatches = stateMismatches(
    snapshot,
    stateExpectations(snapshot, "legacy_active_operational"),
  );
  if (recoveryMismatches.length === 0) return "legacy_active_operational";
  const active2Mismatches = stateMismatches(snapshot, stateExpectations(snapshot, "active_rev2"));
  if (active2Mismatches.length === 0) return "active_rev2";
  const active15Mismatches = stateMismatches(snapshot, stateExpectations(snapshot, "active_rev15"));
  if (active15Mismatches.length === 0) return "active_rev15";
  const closest = [stagedMismatches, recoveryMismatches, active2Mismatches, active15Mismatches]
    .reduce((best, current) => current.length < best.length ? current : best);
  failState(closest, snapshot);
}

async function updateSingleton(client, sql, code) {
  let result;
  try { result = await client.query(sql); } catch { fail(code); }
  if (result === null || typeof result !== "object" || result.rowCount !== 1
      || !Array.isArray(result.rows) || result.rows.length !== 1) {
    fail(code);
  }
}

async function activateTransaction(pool, migrations) {
  let client;
  let transactionOpen = false;
  let discard = false;
  let result;
  let operationError;
  try {
    try { client = await pool.connect(); } catch {
      fail("POSTGRES_TEST_ACTIVATION_CONNECTION_FAILED");
    }
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      await client.query("SET LOCAL statement_timeout='30000ms'");
      await client.query("SET LOCAL lock_timeout='5000ms'");
      await verifyPostgres17(client);
      await verifyMigrationReceipt(client, migrations);
      const before = classifyActivationState(await readActivationState(client));
      if (before === "staged") {
        await updateSingleton(
          client,
          `UPDATE ${TABLES.legacyRuntime}
              SET state='active', revision=revision+1, changed_at=clock_timestamp()
            WHERE id=1 AND state='staged' AND revision=0
            RETURNING id`,
          "POSTGRES_TEST_ACTIVATION_LEGACY_RUNTIME_UPDATE_FAILED",
        );
        await updateSingleton(
          client,
          `UPDATE ${TABLES.typedRuntime}
              SET state='active', changed_at=clock_timestamp()
            WHERE id=1 AND state='staged' AND policy_revision=1
            RETURNING id`,
          "POSTGRES_TEST_ACTIVATION_TYPED_RUNTIME_UPDATE_FAILED",
        );
        await updateSingleton(
          client,
          `UPDATE ${TABLES.collectionControls}
              SET revision=revision+1, control_state='degraded',
                  enrollment_enabled=false, upload_registration_enabled=true,
                  processing_enabled=true, publication_enabled=false,
                  reason_code='${TEST_COLLECTION_CONTROL_REASON}',
                  updated_at=clock_timestamp()
            WHERE singleton=1 AND revision=1 AND control_state='contained'
              AND enrollment_enabled=false AND upload_registration_enabled=false
              AND processing_enabled=false AND publication_enabled=false
            RETURNING singleton`,
          "POSTGRES_TEST_ACTIVATION_COLLECTION_CONTROLS_UPDATE_FAILED",
        );
      } else if (before === "legacy_active_operational") {
        await updateSingleton(
          client,
          `UPDATE ${TABLES.typedRuntime}
              SET state='active', changed_at=clock_timestamp()
            WHERE id=1 AND state='staged' AND policy_revision=1
            RETURNING id`,
          "POSTGRES_TEST_ACTIVATION_TYPED_RUNTIME_UPDATE_FAILED",
        );
        await updateSingleton(
          client,
          `UPDATE ${TABLES.collectionControls}
              SET revision=revision+1, control_state='degraded',
                  enrollment_enabled=false, upload_registration_enabled=true,
                  processing_enabled=true, publication_enabled=false,
                  reason_code='${TEST_COLLECTION_CONTROL_REASON}',
                  updated_at=clock_timestamp()
            WHERE singleton=1 AND revision=14 AND control_state='operational'
              AND enrollment_enabled=true AND upload_registration_enabled=true
              AND processing_enabled=true AND publication_enabled=true
              AND reason_code='maintenance'
            RETURNING singleton`,
          "POSTGRES_TEST_ACTIVATION_COLLECTION_CONTROLS_UPDATE_FAILED",
        );
      }
      const expectedRevision = before === "legacy_active_operational" || before === "active_rev15"
        ? 15
        : 2;
      const expectedActiveState = expectedRevision === 15 ? "active_rev15" : "active_rev2";
      const after = classifyActivationState(await readActivationState(client));
      if (after !== expectedActiveState) fail("POSTGRES_TEST_ACTIVATION_READBACK_MISMATCH");
      await client.query("COMMIT");
      transactionOpen = false;
      result = Object.freeze({
        status: "ok",
        mode: "activate_v12_test",
        job: TEST_ACTIVATION_JOB,
        migrationReceipt: Object.freeze({ primaryVersion: EXPECTED_MIGRATION_COUNT }),
        changed: before === "staged" || before === "legacy_active_operational",
        runtimes: Object.freeze({ legacy: "active", typed: "active" }),
        collectionControls: Object.freeze({
          state: "degraded",
          revision: expectedRevision,
          enrollment: false,
          uploadRegistration: true,
          processing: true,
          publication: false,
        }),
      });
    } catch (error) {
      discard = true;
      if (transactionOpen) {
        try {
          await client.query("ROLLBACK");
          transactionOpen = false;
        } catch {
          fail("POSTGRES_TEST_ACTIVATION_ROLLBACK_FAILED");
        }
      }
      if (typeof error?.code === "string"
          && /^POSTGRES_TEST_ACTIVATION_[A-Z0-9_]+$/u.test(error.code)) throw error;
      fail("POSTGRES_TEST_ACTIVATION_TRANSACTION_FAILED");
    }
  } catch (error) {
    operationError = error;
  } finally {
    if (client !== undefined) {
      try { await client.release(discard || transactionOpen); } catch {
        operationError ??= new Error("POSTGRES_TEST_ACTIVATION_RELEASE_FAILED");
        operationError.code = "POSTGRES_TEST_ACTIVATION_RELEASE_FAILED";
      }
    }
  }
  if (operationError !== undefined) throw operationError;
  return result;
}

export async function runTestActivation({ env = process.env, dependencies = {} } = {}) {
  if (env?.CLOUD_RUN_JOB !== TEST_ACTIVATION_JOB
      || !EXECUTION_PATTERN.test(env?.CLOUD_RUN_EXECUTION ?? "")
      || env?.CLOUD_RUN_TASK_INDEX !== "0"
      || env?.CLOUD_RUN_TASK_COUNT !== "1"
      || env?.CLOUD_RUN_TASK_ATTEMPT !== "0"
      || env?.GOOGLE_CLOUD_PROJECT !== TEST_ACTIVATION_PROJECT
      || env?.K_SERVICE !== undefined) {
    fail("CLOUD_RUN_TEST_ACTIVATION_JOB_CONTEXT_INVALID");
  }
  if (env?.POSTGRES_MIGRATOR_IAM_USER !== TEST_ACTIVATION_IAM_USER
      || env?.PRIMARY_INSTANCE_CONNECTION_NAME !== TEST_ACTIVATION_TARGET.instanceConnectionName
      || env?.PRIMARY_DATABASE !== TEST_ACTIVATION_TARGET.database
      || env?.PRIMARY_SCHEMA !== TEST_ACTIVATION_TARGET.schema) {
    fail("POSTGRES_TEST_ACTIVATION_TARGET_CONFIGURATION_INVALID");
  }
  const attachedEmail = await (dependencies.readServiceAccountEmail
    ?? readAttachedTestActivationServiceAccount)({ fetchImpl: dependencies.fetchImpl });
  const config = parseTestActivationConfig(env, attachedEmail);
  let migrations;
  try {
    migrations = validatePrimaryMigrations(await (dependencies.readPrimaryMigrations
      ?? readPostgresMigrations)({ role: "primary", rootDirectory: TEST_ACTIVATION_MIGRATION_ROOT }));
  } catch (error) {
    if (typeof error?.code === "string"
        && /^POSTGRES_TEST_ACTIVATION_[A-Z0-9_]+$/u.test(error.code)) throw error;
    fail("POSTGRES_TEST_ACTIVATION_MIGRATION_SOURCE_INVALID");
  }
  let connector;
  let pool;
  let result;
  let operationError;
  try {
    try { connector = (dependencies.createConnector ?? (() => new Connector()))(); } catch {
      fail("CLOUD_SQL_TEST_ACTIVATION_CONNECTOR_CREATE_FAILED");
    }
    try {
      pool = await (dependencies.createIamPool ?? createCloudSqlIamPool)({
        connector,
        instanceConnectionName: config.instanceConnectionName,
        database: config.database,
        user: config.iamUser,
        max: 1,
        applicationName: MIGRATOR_APPLICATION_NAME,
      });
    } catch {
      fail("CLOUD_SQL_TEST_ACTIVATION_CONNECTION_FAILED");
    }
    result = await activateTransaction(pool, migrations);
  } catch (error) {
    operationError = error;
  }
  try {
    await (dependencies.closeResources ?? closeCloudSqlResources)({
      pools: pool === undefined ? [] : [pool],
      connector,
    });
  } catch {
    operationError ??= new Error("CLOUD_SQL_TEST_ACTIVATION_CLEANUP_FAILED");
    operationError.code = "CLOUD_SQL_TEST_ACTIVATION_CLEANUP_FAILED";
  }
  if (operationError !== undefined) {
    const code = safeErrorCode(operationError);
    const error = Object.assign(new Error(code), { code });
    const stateMismatchFields = safeActivationStateMismatchFields(operationError);
    if (stateMismatchFields !== undefined) error.stateMismatchFields = stateMismatchFields;
    const stateSnapshot = safeActivationStateSnapshot(operationError);
    if (stateSnapshot !== undefined) error.stateSnapshot = stateSnapshot;
    throw error;
  }
  return result;
}

function invokedDirectly() {
  return typeof process.argv[1] === "string"
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) {
  if (process.argv.length !== 2) {
    console.error(JSON.stringify({ status: "error", code: "CLOUD_RUN_TEST_ACTIVATION_ARGUMENTS_INVALID" }));
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await runTestActivation()));
    } catch (error) {
      console.error(JSON.stringify(activationErrorReceipt(error)));
      process.exitCode = 1;
    }
  }
}
