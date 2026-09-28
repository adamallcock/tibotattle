#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const cliDirectory = await mkdtemp(join(tmpdir(), "postgres-source-pin-check-"));
const cliPath = join(cliDirectory, "postgres-source-pin-diagnostic.mjs");
await symlink(resolve(ROOT, "node_modules"), join(cliDirectory, "node_modules"), "dir");
await build({
  entryPoints: [resolve(ROOT, "postgres-source-pin-diagnostic.mjs")],
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: cliPath,
  logLevel: "silent",
});
test.after(async () => { await rm(cliDirectory, { recursive: true, force: true }); });

const {
  POSTGRES_SOURCE_PIN_DIAGNOSTIC_IAM_USER,
  POSTGRES_SOURCE_PIN_DIAGNOSTIC_JOB,
  POSTGRES_SOURCE_PIN_DIAGNOSTIC_SCHEMA_VERSION,
  POSTGRES_SOURCE_PIN_DIAGNOSTIC_SERVICE_ACCOUNT,
  POSTGRES_SOURCE_PIN_DIAGNOSTIC_TARGET,
  parsePostgresSourcePinDiagnosticConfig,
  readAttachedPostgresSourcePinDiagnosticServiceAccount,
  readPostgresSourcePinReadiness,
  runPostgresSourcePinDiagnostic,
} = await import(pathToFileURL(cliPath).href);

const EXECUTION = "tibotattle-v12-source-pin-diagnostic-00001-abc";
const SOURCE_NAMESPACE = "synthetic-community-namespace";

function validEnv(overrides = {}) {
  return {
    CLOUD_RUN_JOB: POSTGRES_SOURCE_PIN_DIAGNOSTIC_JOB,
    CLOUD_RUN_EXECUTION: EXECUTION,
    CLOUD_RUN_TASK_INDEX: "0",
    CLOUD_RUN_TASK_COUNT: "1",
    CLOUD_RUN_TASK_ATTEMPT: "0",
    GOOGLE_CLOUD_PROJECT: POSTGRES_SOURCE_PIN_DIAGNOSTIC_TARGET.project,
    POSTGRES_IAM_USER: POSTGRES_SOURCE_PIN_DIAGNOSTIC_IAM_USER,
    PRIMARY_INSTANCE_CONNECTION_NAME: POSTGRES_SOURCE_PIN_DIAGNOSTIC_TARGET.instanceConnectionName,
    PRIMARY_DATABASE: POSTGRES_SOURCE_PIN_DIAGNOSTIC_TARGET.database,
    PRIMARY_SCHEMA: POSTGRES_SOURCE_PIN_DIAGNOSTIC_TARGET.schema,
    POSTGRES_SOURCE_NAMESPACE: SOURCE_NAMESPACE,
    ...overrides,
  };
}

function mockPool(row = { v1_ready: true, v11_ready: false }) {
  const statements = [];
  let releaseCount = 0;
  return {
    statements,
    get releaseCount() { return releaseCount; },
    async connect() {
      return {
        async query(sql, params) {
          statements.push({ sql, params });
          if (sql.trimStart().startsWith("SELECT\n    EXISTS")) {
            return { rows: [row], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release() { releaseCount += 1; },
      };
    },
  };
}

test("configuration is pinned to the one test primary and runtime identity", () => {
  const config = parsePostgresSourcePinDiagnosticConfig(
    validEnv(), POSTGRES_SOURCE_PIN_DIAGNOSTIC_SERVICE_ACCOUNT,
  );
  assert.equal(config.project, "tibotattle");
  assert.equal(config.database, "tibotattle");
  assert.equal(config.schema, "tibotattle_v12_a2_20260925");
  assert.equal(config.iamUser, POSTGRES_SOURCE_PIN_DIAGNOSTIC_IAM_USER);
  assert.equal(config.sourceNamespace, SOURCE_NAMESPACE);

  for (const overrides of [
    { CLOUD_RUN_JOB: "other-job" },
    { CLOUD_RUN_EXECUTION: undefined },
    { GOOGLE_CLOUD_PROJECT: "production" },
    { PRIMARY_INSTANCE_CONNECTION_NAME: "production:us-east1:primary" },
    { PRIMARY_DATABASE: "production" },
    { PRIMARY_SCHEMA: "other_schema" },
    { POSTGRES_IAM_USER: "other@tibotattle.iam" },
    { CLOUD_RUN_TASK_COUNT: "2" },
    { CLOUD_RUN_TASK_ATTEMPT: "1" },
    { K_SERVICE: "tibotattle-test-app" },
    { POSTGRES_SOURCE_NAMESPACE: undefined },
    { POSTGRES_SOURCE_NAMESPACE: "invalid namespace" },
  ]) {
    assert.throws(
      () => parsePostgresSourcePinDiagnosticConfig(
        validEnv(overrides), POSTGRES_SOURCE_PIN_DIAGNOSTIC_SERVICE_ACCOUNT,
      ),
    );
  }
  assert.throws(() => parsePostgresSourcePinDiagnosticConfig(validEnv(), "other@tibotattle.iam"));
});

test("metadata identity read requires the Google metadata response marker", async () => {
  let request;
  const email = await readAttachedPostgresSourcePinDiagnosticServiceAccount({
    async fetchImpl(url, options) {
      request = { url, options };
      return {
        status: 200,
        headers: { get: (name) => name === "Metadata-Flavor" ? "Google" : null },
        async text() { return POSTGRES_SOURCE_PIN_DIAGNOSTIC_SERVICE_ACCOUNT; },
      };
    },
  });
  assert.equal(email, POSTGRES_SOURCE_PIN_DIAGNOSTIC_SERVICE_ACCOUNT);
  assert.equal(request.options.headers["Metadata-Flavor"], "Google");
  await assert.rejects(
    readAttachedPostgresSourcePinDiagnosticServiceAccount({
      async fetchImpl() {
        return { status: 200, headers: { get: () => null }, async text() {
          return POSTGRES_SOURCE_PIN_DIAGNOSTIC_SERVICE_ACCOUNT;
        } };
      },
    }),
    (error) => error?.code === "CLOUD_RUN_TEST_SOURCE_PIN_DIAGNOSTIC_METADATA_UNAVAILABLE",
  );
});

test("read-only query mirrors both v1 source pin predicates and returns only booleans", async () => {
  const pool = mockPool();
  const readiness = await readPostgresSourcePinReadiness(pool, {
    schema: POSTGRES_SOURCE_PIN_DIAGNOSTIC_TARGET.schema,
    sourceNamespace: SOURCE_NAMESPACE,
  });
  assert.deepEqual(readiness, {
    schemaVersion: POSTGRES_SOURCE_PIN_DIAGNOSTIC_SCHEMA_VERSION,
    v1Ready: true,
    v11Ready: false,
    bothReady: false,
  });
  assert.equal(pool.releaseCount, 1);
  assert.deepEqual(pool.statements.slice(0, 3).map(({ sql }) => sql), [
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "SET LOCAL statement_timeout = '5000ms'",
    "SET LOCAL lock_timeout = '1000ms'",
  ]);
  assert.equal(pool.statements.at(-1).sql, "COMMIT");
  const statement = pool.statements.find(({ sql }) => sql.trimStart().startsWith("SELECT\n    EXISTS"));
  assert.match(statement.sql, /typed_v1_admission_state/u);
  assert.match(statement.sql, /typed_v11_admission_state/u);
  assert.equal((statement.sql.match(/namespace\.original_id = \$2/gu) ?? []).length, 2);
  assert.equal((statement.sql.match(/state\.source_namespace = \$1/gu) ?? []).length, 2);
  assert.equal((statement.sql.match(/state\.runtime_contract_version = 1/gu) ?? []).length, 2);
  assert.deepEqual(statement.params[0], SOURCE_NAMESPACE);
  assert.deepEqual(statement.params[1], Buffer.concat([Buffer.from([0]), Buffer.from(SOURCE_NAMESPACE)]));
  assert.doesNotMatch(statement.sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/iu);
  assert.doesNotMatch(statement.sql, /SELECT\s+\*/iu);
  assert.doesNotMatch(JSON.stringify(readiness), new RegExp(SOURCE_NAMESPACE, "u"));
});

test("invalid readback rolls back and database details are replaced with a safe code", async () => {
  const pool = mockPool({ v1_ready: "true", v11_ready: false });
  await assert.rejects(
    readPostgresSourcePinReadiness(pool, {
      schema: POSTGRES_SOURCE_PIN_DIAGNOSTIC_TARGET.schema,
      sourceNamespace: SOURCE_NAMESPACE,
    }),
    (error) => error?.code === "POSTGRES_TEST_SOURCE_PIN_DIAGNOSTIC_READBACK_INVALID",
  );
  assert.equal(pool.statements.at(-1).sql, "ROLLBACK");
  assert.equal(pool.releaseCount, 1);

  const failedStatements = [];
  let closeCount = 0;
  const result = await runPostgresSourcePinDiagnostic({
    env: validEnv(),
    dependencies: {
      async readServiceAccount() { return POSTGRES_SOURCE_PIN_DIAGNOSTIC_SERVICE_ACCOUNT; },
      createIamPool: async () => ({
        async connect() {
          return {
            async query(sql) {
              failedStatements.push(sql);
              if (sql.trimStart().startsWith("SELECT\n    EXISTS")) {
                throw Object.assign(new Error("database row contains private detail"), { code: "42P01" });
              }
              return { rows: [], rowCount: 0 };
            },
            release() {},
          };
        },
      }),
      async closeResources() { closeCount += 1; },
    },
  });
  assert.deepEqual(result, {
    schemaVersion: POSTGRES_SOURCE_PIN_DIAGNOSTIC_SCHEMA_VERSION,
    errorCode: "POSTGRES_TEST_SOURCE_PIN_DIAGNOSTIC_READ_FAILED",
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /private detail|42P01|synthetic-community-namespace/u);
  assert.equal(failedStatements.at(-1), "ROLLBACK");
  assert.equal(closeCount, 1);
});

test("runner refuses unrelated job before creating connector or connecting to PostgreSQL", async () => {
  let called = false;
  const result = await runPostgresSourcePinDiagnostic({
    env: validEnv({ CLOUD_RUN_JOB: "other-job" }),
    dependencies: {
      async readServiceAccount() { return POSTGRES_SOURCE_PIN_DIAGNOSTIC_SERVICE_ACCOUNT; },
      createConnector() { called = true; throw new Error("must not connect"); },
    },
  });
  assert.deepEqual(result, {
    schemaVersion: POSTGRES_SOURCE_PIN_DIAGNOSTIC_SCHEMA_VERSION,
    errorCode: "CLOUD_RUN_TEST_SOURCE_PIN_DIAGNOSTIC_JOB_CONTEXT_INVALID",
  });
  assert.equal(called, false);
});
