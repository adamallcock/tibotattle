#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connector } from "@google-cloud/cloud-sql-connector";
import { encodeTypedTelemetryId } from "../src/typed-telemetry-codec.ts";
import {
  closeCloudSqlResources,
  createIamPool as createCloudSqlIamPool,
} from "./cloud-sql.mjs";
import { CLOUD_RUN_IAM_TEST_TARGET } from "./postgres-test-dispatch.mjs";

export const POSTGRES_SOURCE_PIN_DIAGNOSTIC_JOB = "tibotattle-v12-source-pin-diagnostic";
export const POSTGRES_SOURCE_PIN_DIAGNOSTIC_SCHEMA_VERSION = "postgres-v1-source-pin-readiness-v1";
export const POSTGRES_SOURCE_PIN_DIAGNOSTIC_SERVICE_ACCOUNT =
  "tibotattle-test-runtime@tibotattle.iam.gserviceaccount.com";
export const POSTGRES_SOURCE_PIN_DIAGNOSTIC_IAM_USER =
  CLOUD_RUN_IAM_TEST_TARGET.postgres.iamUser;
export const POSTGRES_SOURCE_PIN_DIAGNOSTIC_TARGET = Object.freeze({
  ...CLOUD_RUN_IAM_TEST_TARGET.postgres.primary,
  project: CLOUD_RUN_IAM_TEST_TARGET.project,
});

const SOURCE_NAMESPACE_ENV = "POSTGRES_SOURCE_NAMESPACE";
const EXECUTION_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const METADATA_EMAIL_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email";
const APPLICATION_NAME = "tibotattle-v12-source-pin-diagnostic";

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function quoteSchema(value) {
  if (typeof value !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/u.test(value)
      || value.startsWith("pg_") || value === "information_schema") {
    fail("POSTGRES_TEST_SOURCE_PIN_DIAGNOSTIC_SCHEMA_INVALID");
  }
  return `"${value}"`;
}

function qualifiedTable(schema, table) {
  return `${schema}."${table}"`;
}

export function parsePostgresSourcePinDiagnosticConfig(env, attachedServiceAccountEmail) {
  const target = POSTGRES_SOURCE_PIN_DIAGNOSTIC_TARGET;
  if (env === null || typeof env !== "object"
      || env.CLOUD_RUN_JOB !== POSTGRES_SOURCE_PIN_DIAGNOSTIC_JOB
      || !EXECUTION_PATTERN.test(env.CLOUD_RUN_EXECUTION ?? "")
      || env.CLOUD_RUN_TASK_INDEX !== "0"
      || env.CLOUD_RUN_TASK_COUNT !== "1"
      || env.CLOUD_RUN_TASK_ATTEMPT !== "0"
      || env.GOOGLE_CLOUD_PROJECT !== target.project
      || env.K_SERVICE !== undefined) {
    fail("CLOUD_RUN_TEST_SOURCE_PIN_DIAGNOSTIC_JOB_CONTEXT_INVALID");
  }
  if (env.POSTGRES_IAM_USER !== POSTGRES_SOURCE_PIN_DIAGNOSTIC_IAM_USER) {
    fail("POSTGRES_TEST_SOURCE_PIN_DIAGNOSTIC_IAM_USER_INVALID");
  }
  if (env.PRIMARY_INSTANCE_CONNECTION_NAME !== target.instanceConnectionName
      || env.PRIMARY_DATABASE !== target.database
      || env.PRIMARY_SCHEMA !== target.schema) {
    fail("POSTGRES_TEST_SOURCE_PIN_DIAGNOSTIC_TARGET_INVALID");
  }
  if (attachedServiceAccountEmail !== POSTGRES_SOURCE_PIN_DIAGNOSTIC_SERVICE_ACCOUNT) {
    fail("CLOUD_RUN_TEST_SOURCE_PIN_DIAGNOSTIC_SERVICE_ACCOUNT_INVALID");
  }
  const sourceNamespace = env[SOURCE_NAMESPACE_ENV];
  try {
    encodeTypedTelemetryId(sourceNamespace);
  } catch {
    fail("POSTGRES_TEST_SOURCE_PIN_DIAGNOSTIC_SOURCE_NAMESPACE_INVALID");
  }
  return Object.freeze({
    project: target.project,
    instanceConnectionName: target.instanceConnectionName,
    database: target.database,
    schema: target.schema,
    iamUser: POSTGRES_SOURCE_PIN_DIAGNOSTIC_IAM_USER,
    sourceNamespace,
  });
}

export async function readAttachedPostgresSourcePinDiagnosticServiceAccount({
  fetchImpl = globalThis.fetch,
  timeoutMilliseconds = 3_000,
} = {}) {
  if (typeof fetchImpl !== "function" || !Number.isSafeInteger(timeoutMilliseconds)
      || timeoutMilliseconds < 1 || timeoutMilliseconds > 10_000) {
    fail("CLOUD_RUN_TEST_SOURCE_PIN_DIAGNOSTIC_METADATA_UNAVAILABLE");
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
    fail("CLOUD_RUN_TEST_SOURCE_PIN_DIAGNOSTIC_METADATA_UNAVAILABLE");
  }
  if (response?.status !== 200 || response.headers?.get("Metadata-Flavor") !== "Google") {
    fail("CLOUD_RUN_TEST_SOURCE_PIN_DIAGNOSTIC_METADATA_UNAVAILABLE");
  }
  let email;
  try { email = (await response.text()).trim(); } catch {
    fail("CLOUD_RUN_TEST_SOURCE_PIN_DIAGNOSTIC_METADATA_UNAVAILABLE");
  }
  if (email !== POSTGRES_SOURCE_PIN_DIAGNOSTIC_SERVICE_ACCOUNT) {
    fail("CLOUD_RUN_TEST_SOURCE_PIN_DIAGNOSTIC_SERVICE_ACCOUNT_INVALID");
  }
  return email;
}

const SOURCE_PIN_QUERY = (schema) => `
  SELECT
    EXISTS (
      SELECT 1 FROM ${qualifiedTable(schema, "typed_v1_admission_state")} state
      JOIN ${qualifiedTable(schema, "typed_telemetry_namespaces")} namespace
        ON namespace.id = state.namespace_id AND namespace.original_id = $2
      WHERE state.id = 1 AND state.source_namespace = $1
        AND state.runtime_contract_version = 1
    ) AS v1_ready,
    EXISTS (
      SELECT 1 FROM ${qualifiedTable(schema, "typed_v11_admission_state")} state
      JOIN ${qualifiedTable(schema, "typed_telemetry_namespaces")} namespace
        ON namespace.id = state.namespace_id AND namespace.original_id = $2
      WHERE state.id = 1 AND state.source_namespace = $1
        AND state.runtime_contract_version = 1
    ) AS v11_ready
`;

function parseReadiness(result) {
  if (result === null || typeof result !== "object"
      || !Array.isArray(result.rows) || result.rows.length !== 1
      || typeof result.rows[0]?.v1_ready !== "boolean"
      || typeof result.rows[0]?.v11_ready !== "boolean") {
    fail("POSTGRES_TEST_SOURCE_PIN_DIAGNOSTIC_READBACK_INVALID");
  }
  return Object.freeze({
    schemaVersion: POSTGRES_SOURCE_PIN_DIAGNOSTIC_SCHEMA_VERSION,
    v1Ready: result.rows[0].v1_ready,
    v11Ready: result.rows[0].v11_ready,
    bothReady: result.rows[0].v1_ready && result.rows[0].v11_ready,
  });
}

/** Read the exact v1/v1.1 namespace-pin predicates used by the v1.2 reader. */
export async function readPostgresSourcePinReadiness(pool, { schema, sourceNamespace }) {
  const qualifiedSchema = quoteSchema(schema);
  let client;
  let transactionOpen = false;
  try {
    const encodedNamespace = Buffer.from(encodeTypedTelemetryId(sourceNamespace));
    client = await pool.connect();
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    const result = await client.query(SOURCE_PIN_QUERY(qualifiedSchema), [sourceNamespace, encodedNamespace]);
    const readiness = parseReadiness(result);
    await client.query("COMMIT");
    transactionOpen = false;
    return readiness;
  } catch (error) {
    if (transactionOpen) {
      try { await client.query("ROLLBACK"); } catch { /* retain static diagnostic */ }
    }
    if (typeof error?.code === "string"
        && /^POSTGRES_TEST_SOURCE_PIN_DIAGNOSTIC_[A-Z0-9_]+$/u.test(error.code)) {
      throw error;
    }
    fail("POSTGRES_TEST_SOURCE_PIN_DIAGNOSTIC_READ_FAILED");
  } finally {
    try { client?.release(); } catch { /* no database payload in close errors */ }
  }
}

function safeErrorCode(error) {
  return typeof error?.code === "string"
      && /^(?:CLOUD_RUN|CLOUD_SQL|POSTGRES)_TEST_SOURCE_PIN_DIAGNOSTIC_[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : "POSTGRES_TEST_SOURCE_PIN_DIAGNOSTIC_FAILED";
}

export async function runPostgresSourcePinDiagnostic({ env = process.env, dependencies = {} } = {}) {
  let connector;
  let pools = [];
  try {
    const attachedServiceAccountEmail = await (dependencies.readServiceAccount
      ?? readAttachedPostgresSourcePinDiagnosticServiceAccount)();
    const config = parsePostgresSourcePinDiagnosticConfig(env, attachedServiceAccountEmail);
    connector = dependencies.createConnector?.() ?? new Connector();
    const createPool = dependencies.createIamPool ?? createCloudSqlIamPool;
    const pool = await createPool({
      connector,
      instanceConnectionName: config.instanceConnectionName,
      database: config.database,
      user: config.iamUser,
      max: 1,
      applicationName: APPLICATION_NAME,
    });
    pools = [pool];
    const readiness = await readPostgresSourcePinReadiness(pool, config);
    await (dependencies.closeResources ?? closeCloudSqlResources)({ pools, connector });
    pools = [];
    connector = null;
    return readiness;
  } catch (error) {
    try { await (dependencies.closeResources ?? closeCloudSqlResources)({ pools, connector }); }
    catch { /* safe diagnostic is more useful than a close error */ }
    return Object.freeze({
      schemaVersion: POSTGRES_SOURCE_PIN_DIAGNOSTIC_SCHEMA_VERSION,
      errorCode: safeErrorCode(error),
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runPostgresSourcePinDiagnostic();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if ("errorCode" in result) process.exitCode = 1;
}
