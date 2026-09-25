#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connector } from "@google-cloud/cloud-sql-connector";
import {
  closeCloudSqlResources,
  createIamPool as createCloudSqlIamPool,
} from "./cloud-sql.mjs";

export const LEDGER_RECONCILIATION_DIAGNOSTIC_JOB =
  "tibotattle-test-ledger-reconciliation-diagnostic";
export const LEDGER_RECONCILIATION_DIAGNOSTIC_PROJECT = "tibotattle";
export const LEDGER_RECONCILIATION_DIAGNOSTIC_SERVICE_ACCOUNT =
  "tibotattle-test-migrator@tibotattle.iam.gserviceaccount.com";
// Keep the job's target self-contained: importing an executable entrypoint
// would run that entrypoint's CLI guard when esbuild bundles this Job.
export const LEDGER_RECONCILIATION_DIAGNOSTIC_TARGET = Object.freeze({
  instanceConnectionName: "tibotattle:us-east1:tibotattle-test-ledger-20260922",
  database: "tibotattle_ledger",
  schema: "tibotattle_ledger",
});
export const LEDGER_RECONCILIATION_DIAGNOSTIC_IAM_USER =
  "tibotattle-test-migrator@tibotattle.iam";

const METADATA_EMAIL_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email";
const EXECUTION_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/u;
const MIGRATOR_APPLICATION_NAME = "tibotattle-test-ledger-reconciliation-diagnostic";
const PREFLIGHT_QUERY = (schema) => `
  SELECT current_setting('server_version_num')::integer AS server_version_num,
         COALESCE((SELECT max(version) FROM ${schema}."_tibotattle_migration_history"), 0)::integer
           AS ledger_migration_version,
         (SELECT count(*)::text FROM ${schema}."_tibotattle_migration_history")
           AS ledger_migration_receipt_count,
         count(*)::text AS total_rows,
         count(*) FILTER (
           WHERE length(job.source_namespace) NOT BETWEEN 1 AND 256
         )::text AS invalid_source_namespace_count,
         count(*) FILTER (
           WHERE job.source_id !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
         )::text AS invalid_source_id_count,
         count(*) FILTER (
           WHERE job.terminal_json IS NOT NULL AND (
             length(job.terminal_json) > 65536
             OR NOT pg_input_is_valid(job.terminal_json, 'json')
           )
         )::text AS invalid_terminal_json_count,
         count(*) FILTER (
           WHERE job.state = 'complete' AND job.terminal_json IS NULL
         )::text AS complete_without_terminal_json_count,
         count(*) FILTER (
           WHERE NOT EXISTS (
             SELECT 1
               FROM ${schema}.deletion_tombstones AS tombstone
              WHERE tombstone.participant_digest = job.participant_digest
           )
         )::text AS missing_participant_tombstone_count
    FROM ${schema}.storage_erasure_jobs AS job
`;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function quoteSchema(value) {
  if (typeof value !== "string" || !SCHEMA_PATTERN.test(value)
      || value.startsWith("pg_") || value === "information_schema") {
    fail("POSTGRES_TEST_LEDGER_DIAGNOSTIC_SCHEMA_INVALID");
  }
  return `"${value}"`;
}

function validateContext(env) {
  if (env === null || typeof env !== "object"
      || env.CLOUD_RUN_JOB !== LEDGER_RECONCILIATION_DIAGNOSTIC_JOB
      || !EXECUTION_PATTERN.test(env.CLOUD_RUN_EXECUTION ?? "")
      || env.CLOUD_RUN_TASK_INDEX !== "0"
      || env.CLOUD_RUN_TASK_COUNT !== "1"
      || env.CLOUD_RUN_TASK_ATTEMPT !== "0"
      || env.GOOGLE_CLOUD_PROJECT !== LEDGER_RECONCILIATION_DIAGNOSTIC_PROJECT
      || env.K_SERVICE !== undefined) {
    fail("CLOUD_RUN_TEST_LEDGER_DIAGNOSTIC_JOB_CONTEXT_INVALID");
  }
  if (env.POSTGRES_MIGRATOR_IAM_USER !== LEDGER_RECONCILIATION_DIAGNOSTIC_IAM_USER) {
    fail("POSTGRES_TEST_LEDGER_DIAGNOSTIC_IAM_USER_INVALID");
  }
  const target = LEDGER_RECONCILIATION_DIAGNOSTIC_TARGET;
  if (env.LEDGER_INSTANCE_CONNECTION_NAME !== target.instanceConnectionName
      || env.LEDGER_DATABASE !== target.database
      || env.LEDGER_SCHEMA !== target.schema) {
    fail("POSTGRES_TEST_LEDGER_DIAGNOSTIC_TARGET_INVALID");
  }
  return Object.freeze({
    job: LEDGER_RECONCILIATION_DIAGNOSTIC_JOB,
    execution: env.CLOUD_RUN_EXECUTION,
    project: LEDGER_RECONCILIATION_DIAGNOSTIC_PROJECT,
    instanceConnectionName: target.instanceConnectionName,
    database: target.database,
    schema: target.schema,
    iamUser: LEDGER_RECONCILIATION_DIAGNOSTIC_IAM_USER,
  });
}

export function parseLedgerReconciliationDiagnosticConfig(env, attachedServiceAccountEmail) {
  const config = validateContext(env);
  if (attachedServiceAccountEmail !== LEDGER_RECONCILIATION_DIAGNOSTIC_SERVICE_ACCOUNT) {
    fail("CLOUD_RUN_TEST_LEDGER_DIAGNOSTIC_SERVICE_ACCOUNT_INVALID");
  }
  return config;
}

export async function readAttachedLedgerDiagnosticServiceAccount({
  fetchImpl = globalThis.fetch,
  timeoutMilliseconds = 3_000,
} = {}) {
  if (typeof fetchImpl !== "function"
      || !Number.isSafeInteger(timeoutMilliseconds)
      || timeoutMilliseconds < 1 || timeoutMilliseconds > 10_000) {
    fail("CLOUD_RUN_TEST_LEDGER_DIAGNOSTIC_METADATA_UNAVAILABLE");
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
    fail("CLOUD_RUN_TEST_LEDGER_DIAGNOSTIC_METADATA_UNAVAILABLE");
  }
  if (response?.status !== 200
      || response.headers?.get("Metadata-Flavor") !== "Google") {
    fail("CLOUD_RUN_TEST_LEDGER_DIAGNOSTIC_METADATA_UNAVAILABLE");
  }
  let email;
  try { email = (await response.text()).trim(); } catch {
    fail("CLOUD_RUN_TEST_LEDGER_DIAGNOSTIC_METADATA_UNAVAILABLE");
  }
  if (email !== LEDGER_RECONCILIATION_DIAGNOSTIC_SERVICE_ACCOUNT) {
    fail("CLOUD_RUN_TEST_LEDGER_DIAGNOSTIC_SERVICE_ACCOUNT_INVALID");
  }
  return email;
}

function parseCount(value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    fail("POSTGRES_TEST_LEDGER_DIAGNOSTIC_READBACK_INVALID");
  }
  return number;
}

function parseReadback(result) {
  if (result === null || typeof result !== "object"
      || !Array.isArray(result.rows) || result.rows.length !== 1) {
    fail("POSTGRES_TEST_LEDGER_DIAGNOSTIC_READBACK_INVALID");
  }
  const row = result.rows[0];
  if (Math.floor(Number(row?.server_version_num) / 10_000) !== 17) {
    fail("POSTGRES_TEST_LEDGER_DIAGNOSTIC_POSTGRES_VERSION_UNSUPPORTED");
  }
  const ledgerMigrationVersion = parseCount(row.ledger_migration_version);
  const ledgerMigrationReceiptCount = parseCount(row.ledger_migration_receipt_count);
  if (ledgerMigrationVersion > 6 || ledgerMigrationReceiptCount > 6
      || ledgerMigrationVersion !== ledgerMigrationReceiptCount) {
    fail("POSTGRES_TEST_LEDGER_DIAGNOSTIC_MIGRATION_RECEIPT_INVALID");
  }
  return Object.freeze({
    ledgerMigrationVersion,
    ledgerMigrationReceiptCount,
    totalRows: parseCount(row.total_rows),
    invalidSourceNamespace: parseCount(row.invalid_source_namespace_count),
    invalidSourceId: parseCount(row.invalid_source_id_count),
    invalidTerminalJson: parseCount(row.invalid_terminal_json_count),
    completeWithoutTerminalJson: parseCount(row.complete_without_terminal_json_count),
    missingParticipantTombstone: parseCount(row.missing_participant_tombstone_count),
  });
}

/** Run exactly the read-only row predicates from ledger migration 0006. */
export async function readLedgerErasureJobPreflight(pool, schema) {
  const qualifiedSchema = quoteSchema(schema);
  let client;
  let transactionOpen = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '15000ms'");
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    const result = await client.query(PREFLIGHT_QUERY(qualifiedSchema));
    const counts = parseReadback(result);
    await client.query("COMMIT");
    transactionOpen = false;
    return counts;
  } catch (error) {
    if (transactionOpen) {
      try { await client.query("ROLLBACK"); } catch { /* retain static diagnostic */ }
    }
    if (typeof error?.code === "string"
        && /^POSTGRES_TEST_LEDGER_DIAGNOSTIC_[A-Z0-9_]+$/u.test(error.code)) {
      throw error;
    }
    fail("POSTGRES_TEST_LEDGER_DIAGNOSTIC_READ_FAILED");
  } finally {
    try { client?.release(); } catch { /* no database payload in close errors */ }
  }
}

function safeErrorCode(error) {
  return typeof error?.code === "string"
      && /^(?:CLOUD_RUN|CLOUD_SQL|POSTGRES)_TEST_LEDGER_DIAGNOSTIC_[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : "POSTGRES_TEST_LEDGER_DIAGNOSTIC_FAILED";
}

export async function runLedgerReconciliationDiagnostic({ env = process.env, dependencies = {} } = {}) {
  // Validate all job-supplied settings before fetching metadata or opening SQL.
  validateContext(env);
  const attachedServiceAccountEmail = await (dependencies.readServiceAccountEmail
    ?? readAttachedLedgerDiagnosticServiceAccount)({ fetchImpl: dependencies.fetchImpl });
  const config = parseLedgerReconciliationDiagnosticConfig(env, attachedServiceAccountEmail);

  let connector;
  let pool;
  let result;
  let operationError;
  try {
    connector = await (dependencies.createConnector ?? (() => new Connector()))();
    pool = await (dependencies.createPool ?? createCloudSqlIamPool)({
      connector,
      instanceConnectionName: config.instanceConnectionName,
      database: config.database,
      user: config.iamUser,
      max: 1,
      applicationName: MIGRATOR_APPLICATION_NAME,
    });
    const counts = await (dependencies.readPreflight ?? readLedgerErasureJobPreflight)(
      pool,
      config.schema,
    );
    result = Object.freeze({
      schemaVersion: "erasure-ledger-reconciliation-diagnostic-v1",
      status: "ok",
      counts,
    });
  } catch (error) {
    operationError = new Error(safeErrorCode(error));
    operationError.code = safeErrorCode(error);
  }

  try {
    await (dependencies.closeResources ?? closeCloudSqlResources)({
      pools: pool === undefined ? [] : [pool],
      connector,
    });
  } catch {
    operationError ??= Object.assign(new Error("CLOUD_SQL_TEST_LEDGER_DIAGNOSTIC_CLEANUP_FAILED"), {
      code: "CLOUD_SQL_TEST_LEDGER_DIAGNOSTIC_CLEANUP_FAILED",
    });
  }
  if (operationError !== undefined) throw operationError;
  return result;
}

async function main() {
  if (process.argv.length !== 2) {
    console.error(JSON.stringify({ status: "error", code: "CLOUD_RUN_TEST_LEDGER_DIAGNOSTIC_ARGUMENTS_INVALID" }));
    process.exitCode = 1;
    return;
  }
  try {
    console.log(JSON.stringify(await runLedgerReconciliationDiagnostic()));
  } catch (error) {
    console.error(JSON.stringify({ status: "error", code: safeErrorCode(error) }));
    process.exitCode = 1;
  }
}

if (typeof process.argv[1] === "string"
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
