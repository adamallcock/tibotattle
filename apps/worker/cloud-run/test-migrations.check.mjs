#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPostgresMigrationManifest,
  POSTGRES_MIGRATION_ROOT,
} from "./postgres-migrations.mjs";
import {
  parseTestMigrationsConfig,
  runTestMigrations,
  TEST_MIGRATIONS_IAM_USER,
  TEST_MIGRATIONS_JOB,
  TEST_MIGRATIONS_PROJECT,
  TEST_MIGRATIONS_ROOT,
  TEST_MIGRATIONS_SERVICE_ACCOUNT,
  TEST_MIGRATIONS_TARGETS,
} from "./test-migrations.mjs";

const EXECUTION = "tibotattle-test-database-migrate-20260924-abc12";

function validEnv(overrides = {}) {
  return {
    CLOUD_RUN_JOB: TEST_MIGRATIONS_JOB,
    CLOUD_RUN_EXECUTION: EXECUTION,
    CLOUD_RUN_TASK_INDEX: "0",
    CLOUD_RUN_TASK_COUNT: "1",
    CLOUD_RUN_TASK_ATTEMPT: "0",
    GOOGLE_CLOUD_PROJECT: TEST_MIGRATIONS_PROJECT,
    POSTGRES_MIGRATOR_IAM_USER: TEST_MIGRATIONS_IAM_USER,
    PRIMARY_DATABASE: TEST_MIGRATIONS_TARGETS.primary.database,
    PRIMARY_SCHEMA: TEST_MIGRATIONS_TARGETS.primary.schema,
    PRIMARY_INSTANCE_CONNECTION_NAME: TEST_MIGRATIONS_TARGETS.primary.instanceConnectionName,
    LEDGER_DATABASE: TEST_MIGRATIONS_TARGETS.ledger.database,
    LEDGER_SCHEMA: TEST_MIGRATIONS_TARGETS.ledger.schema,
    LEDGER_INSTANCE_CONNECTION_NAME: TEST_MIGRATIONS_TARGETS.ledger.instanceConnectionName,
    ...overrides,
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

function makeHarness(manifest, {
  wrongPrimaryOwner = false,
  corruptPrimaryReceipt = false,
} = {}) {
  const state = Object.fromEntries(Object.keys(TEST_MIGRATIONS_TARGETS).map((role) => [role, {
    schemaExists: wrongPrimaryOwner && role === "primary",
    owner: wrongPrimaryOwner && role === "primary" ? "different-owner" : null,
    receipts: [],
  }]));
  const events = [];
  const pools = {};
  let connectorCount = 0;
  let metadataCount = 0;
  let manifestCount = 0;
  let applyCalls = 0;
  let cleanupCalls = 0;
  const dependencies = {
    async readServiceAccountEmail() {
      metadataCount += 1;
      return TEST_MIGRATIONS_SERVICE_ACCOUNT;
    },
    createConnector() {
      connectorCount += 1;
      return { testConnector: true };
    },
    async buildManifest({ rootDirectory }) {
      manifestCount += 1;
      assert.equal(rootDirectory, TEST_MIGRATIONS_ROOT);
      return manifest;
    },
    async createPool(options) {
      const role = Object.entries(TEST_MIGRATIONS_TARGETS).find(([, target]) =>
        target.instanceConnectionName === options.instanceConnectionName)?.[0];
      assert.ok(role);
      assert.equal(options.database, TEST_MIGRATIONS_TARGETS[role].database);
      assert.equal(options.user, TEST_MIGRATIONS_IAM_USER);
      assert.equal(options.max, 1);
      assert.equal(options.applicationName, "tibotattle-test-database-migrator");
      const pool = {
        async connect() {
          events.push({ role, type: "connect" });
          return {
            async query(sql, params) {
              events.push({ role, type: "query", sql });
              if (sql === "BEGIN" || sql === "BEGIN READ ONLY"
                  || sql === "COMMIT" || sql === "ROLLBACK"
                  || sql.startsWith("SET LOCAL")) {
                return { rows: [], rowCount: 0 };
              }
              if (sql.includes("FROM pg_namespace")) {
                return state[role].schemaExists
                  ? { rows: [{ owner: state[role].owner }], rowCount: 1 }
                  : { rows: [], rowCount: 0 };
              }
              if (sql.startsWith("CREATE SCHEMA ")) {
                state[role].schemaExists = true;
                state[role].owner = TEST_MIGRATIONS_IAM_USER;
                return { rows: [], rowCount: 0 };
              }
              if (sql.includes(`."_tibotattle_migration_history"`)) {
                const rows = state[role].receipts.map(({ version, name, sha256 }) => ({
                  version,
                  name,
                  checksum_sha256: sha256,
                }));
                return { rows, rowCount: rows.length };
              }
              throw new Error("unexpected fake database query");
            },
            async release(discard = false) {
              events.push({ role, type: "release", discard });
            },
          };
        },
      };
      pools[role] = pool;
      return pool;
    },
    async applyMigrations({ role, schema, pool, rootDirectory }) {
      applyCalls += 1;
      assert.equal(pool, pools[role]);
      assert.equal(schema, TEST_MIGRATIONS_TARGETS[role].schema);
      assert.equal(rootDirectory, TEST_MIGRATIONS_ROOT);
      const expected = manifest.roles[role].map(({ version, name, sha256 }) => ({
        version,
        name,
        sha256,
      }));
      for (const receipt of expected.slice(state[role].receipts.length)) {
        state[role].receipts.push(receipt);
      }
      if (corruptPrimaryReceipt && role === "primary") {
        state[role].receipts[0] = { ...state[role].receipts[0], sha256: "f".repeat(64) };
      }
      return { role, schema, applied: expected.length, migrations: expected };
    },
    async closeResources({ pools: actualPools, connector }) {
      cleanupCalls += 1;
      assert.deepEqual(actualPools, Object.values(pools));
      assert.equal(connector?.testConnector, true);
    },
  };
  return {
    dependencies,
    state,
    events,
    get connectorCount() { return connectorCount; },
    get metadataCount() { return metadataCount; },
    get manifestCount() { return manifestCount; },
    get applyCalls() { return applyCalls; },
    get cleanupCalls() { return cleanupCalls; },
  };
}

const manifest = await buildPostgresMigrationManifest({ rootDirectory: POSTGRES_MIGRATION_ROOT });

test("configuration is pinned to the one-task tibotattle migration Job and exact DB targets", () => {
  const config = parseTestMigrationsConfig(validEnv(), TEST_MIGRATIONS_SERVICE_ACCOUNT);
  assert.equal(config.job, TEST_MIGRATIONS_JOB);
  assert.equal(config.project, TEST_MIGRATIONS_PROJECT);
  assert.equal(manifest.roles.primary.length, 36);
  assert.equal(manifest.roles.ledger.length, 6);
});

test("configuration rejects wrong job, task shape, project, IAM identity, instance, database, and schema", () => {
  for (const overrides of [
    { CLOUD_RUN_JOB: "another-job" },
    { CLOUD_RUN_EXECUTION: "" },
    { CLOUD_RUN_TASK_INDEX: "1" },
    { CLOUD_RUN_TASK_COUNT: "2" },
    { CLOUD_RUN_TASK_ATTEMPT: "1" },
    { GOOGLE_CLOUD_PROJECT: "another-project" },
    { K_SERVICE: "tibotattle-test-app" },
    { POSTGRES_MIGRATOR_IAM_USER: "other@other.iam" },
    { PRIMARY_INSTANCE_CONNECTION_NAME: "another-project:us-east1:db" },
    { PRIMARY_DATABASE: "production" },
    { PRIMARY_SCHEMA: "public" },
    { LEDGER_INSTANCE_CONNECTION_NAME: "another-project:us-east1:db" },
    { LEDGER_DATABASE: "production" },
    { LEDGER_SCHEMA: "public" },
  ]) {
    expectCode(
      () => parseTestMigrationsConfig(validEnv(overrides), TEST_MIGRATIONS_SERVICE_ACCOUNT),
      overrides.K_SERVICE !== undefined
        ? "CLOUD_RUN_TEST_MIGRATIONS_JOB_CONTEXT_INVALID"
        : overrides.POSTGRES_MIGRATOR_IAM_USER !== undefined
          ? "POSTGRES_TEST_MIGRATIONS_IAM_USER_INVALID"
          : overrides.PRIMARY_INSTANCE_CONNECTION_NAME !== undefined
            || overrides.PRIMARY_DATABASE !== undefined || overrides.PRIMARY_SCHEMA !== undefined
            ? "POSTGRES_TEST_MIGRATIONS_PRIMARY_TARGET_INVALID"
            : overrides.LEDGER_INSTANCE_CONNECTION_NAME !== undefined
              || overrides.LEDGER_DATABASE !== undefined || overrides.LEDGER_SCHEMA !== undefined
              ? "POSTGRES_TEST_MIGRATIONS_LEDGER_TARGET_INVALID"
              : "CLOUD_RUN_TEST_MIGRATIONS_JOB_CONTEXT_INVALID",
    );
  }
  expectCode(
    () => parseTestMigrationsConfig(validEnv(), "wrong@tibotattle.iam.gserviceaccount.com"),
    "CLOUD_RUN_TEST_MIGRATIONS_SERVICE_ACCOUNT_INVALID",
  );
});

test("invalid context and wrong attached service account stop before connector or database access", async () => {
  const invalidContext = makeHarness(manifest);
  await assert.rejects(
    runTestMigrations({
      env: validEnv({ PRIMARY_DATABASE: "production" }),
      dependencies: invalidContext.dependencies,
    }),
    (error) => error?.code === "POSTGRES_TEST_MIGRATIONS_PRIMARY_TARGET_INVALID",
  );
  assert.equal(invalidContext.metadataCount, 0);
  assert.equal(invalidContext.manifestCount, 0);
  assert.equal(invalidContext.connectorCount, 0);
  assert.equal(invalidContext.events.length, 0);

  const wrongIdentity = makeHarness(manifest);
  wrongIdentity.dependencies.readServiceAccountEmail = async () => {
    return "different@tibotattle.iam.gserviceaccount.com";
  };
  await assert.rejects(
    runTestMigrations({ env: validEnv(), dependencies: wrongIdentity.dependencies }),
    (error) => error?.code === "CLOUD_RUN_TEST_MIGRATIONS_SERVICE_ACCOUNT_INVALID",
  );
  assert.equal(wrongIdentity.connectorCount, 0);
  assert.equal(wrongIdentity.manifestCount, 0);
  assert.equal(wrongIdentity.events.length, 0);
});

test("primary and ledger migrations are checksum-read back and repeated runs are idempotent", async () => {
  const harness = makeHarness(manifest);
  const first = await runTestMigrations({ env: validEnv(), dependencies: harness.dependencies });
  const second = await runTestMigrations({ env: validEnv(), dependencies: harness.dependencies });
  assert.deepEqual(first, second);
  assert.equal(first.migrations.primary.applied, 36);
  assert.equal(first.migrations.ledger.applied, 6);
  assert.match(first.migrations.primary.manifestSha256, /^[0-9a-f]{64}$/u);
  assert.match(first.migrations.ledger.latest.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(harness.state.primary.receipts.length, 36);
  assert.equal(harness.state.ledger.receipts.length, 6);
  assert.equal(harness.applyCalls, 4);
  assert.equal(harness.cleanupCalls, 2);
  assert.equal(harness.events.filter(({ sql }) => sql?.startsWith("CREATE SCHEMA")).length, 2);
  assert.equal(harness.events.filter(({ sql }) => sql?.includes("_tibotattle_migration_history")).length, 4);
});

test("a pre-existing schema with unexpected owner refuses before applying migrations", async () => {
  const harness = makeHarness(manifest, { wrongPrimaryOwner: true });
  await assert.rejects(
    runTestMigrations({ env: validEnv(), dependencies: harness.dependencies }),
    (error) => error?.code === "POSTGRES_TEST_MIGRATIONS_PRIMARY_SCHEMA_OWNER_UNEXPECTED",
  );
  assert.equal(harness.applyCalls, 0);
  assert.equal(harness.cleanupCalls, 1);
});

test("a receipt checksum mismatch fails closed and still closes database resources", async () => {
  const harness = makeHarness(manifest, { corruptPrimaryReceipt: true });
  await assert.rejects(
    runTestMigrations({ env: validEnv(), dependencies: harness.dependencies }),
    (error) => error?.code === "POSTGRES_TEST_MIGRATIONS_PRIMARY_RECEIPT_MISMATCH",
  );
  assert.equal(harness.applyCalls, 1);
  assert.equal(harness.cleanupCalls, 1);
});
