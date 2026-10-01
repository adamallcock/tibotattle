#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPostgresMigrationManifest,
  POSTGRES_MIGRATION_ROOT,
} from "./postgres-migrations.mjs";
import {
  FASTPATH_MIGRATION_PROFILE,
  FASTPATH_MIGRATION_TARGETS,
  FASTPATH_MIGRATIONS_JOB,
  GRAPH_BENCHMARK_MIGRATION_PROFILE,
  GRAPH_BENCHMARK_MIGRATIONS_JOB,
  GRAPH_BENCHMARK_MIGRATION_TARGETS,
  parseTestMigrationsConfig,
  runTestMigrations,
  TEST_MIGRATIONS_IAM_USER,
  TEST_MIGRATIONS_JOB,
  TEST_MIGRATIONS_PROJECT,
  TEST_MIGRATIONS_ROOT,
  TEST_MIGRATIONS_RUNTIME_IAM_USER,
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

function validBenchmarkEnv(overrides = {}) {
  const env = validEnv();
  for (const key of [
    "PRIMARY_SCHEMA", "LEDGER_DATABASE", "LEDGER_SCHEMA", "LEDGER_INSTANCE_CONNECTION_NAME",
  ]) delete env[key];
  Object.assign(env, {
    CLOUD_RUN_JOB: GRAPH_BENCHMARK_MIGRATIONS_JOB,
    PRIMARY_DATABASE: GRAPH_BENCHMARK_MIGRATION_TARGETS[0].database,
    PRIMARY_INSTANCE_CONNECTION_NAME: GRAPH_BENCHMARK_MIGRATION_TARGETS[0].instanceConnectionName,
  }, overrides);
  return env;
}

function validFastpathEnv(overrides = {}) {
  return validEnv({
    CLOUD_RUN_JOB: FASTPATH_MIGRATIONS_JOB,
    PRIMARY_DATABASE: FASTPATH_MIGRATION_TARGETS.primary.database,
    PRIMARY_SCHEMA: FASTPATH_MIGRATION_TARGETS.primary.schema,
    PRIMARY_INSTANCE_CONNECTION_NAME: FASTPATH_MIGRATION_TARGETS.primary.instanceConnectionName,
    LEDGER_DATABASE: FASTPATH_MIGRATION_TARGETS.ledger.database,
    LEDGER_SCHEMA: FASTPATH_MIGRATION_TARGETS.ledger.schema,
    LEDGER_INSTANCE_CONNECTION_NAME: FASTPATH_MIGRATION_TARGETS.ledger.instanceConnectionName,
    PRIMARY_EXPECTED_MIGRATIONS: String(manifest.roles.primary.length),
    LEDGER_EXPECTED_MIGRATIONS: String(manifest.roles.ledger.length),
    ...overrides,
  });
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

function makeHarness(manifest, {
  wrongPrimaryOwner = false,
  corruptPrimaryReceipt = false,
  corruptPrimaryPrivileges = false,
  graphBenchmark = false,
  fastpath = false,
} = {}) {
  const schemaNames = {
    primary: [TEST_MIGRATIONS_TARGETS.primary.schema,
      ...(graphBenchmark ? GRAPH_BENCHMARK_MIGRATION_TARGETS.map(({ schema }) => schema) : [])],
    ledger: [TEST_MIGRATIONS_TARGETS.ledger.schema],
    ...(fastpath
      ? { fastpath: Object.values(FASTPATH_MIGRATION_TARGETS).map(({ schema }) => schema) }
      : {}),
  };
  const allSchemas = Object.values(schemaNames).flat();
  const schemaReceipts = new Map(allSchemas.map((schema) => [schema, []]));
  const schemaOwners = new Map(allSchemas.map((schema) => [schema, null]));
  if (wrongPrimaryOwner) {
    schemaOwners.set(TEST_MIGRATIONS_TARGETS.primary.schema, "different-owner");
  }
  const state = Object.fromEntries([
    ...Object.keys(TEST_MIGRATIONS_TARGETS),
    ...(fastpath ? ["fastpath"] : []),
  ].map((role) => [role, {
    schemaExists: false,
    owner: null,
    receipts: role === "fastpath" ? null : schemaReceipts.get(TEST_MIGRATIONS_TARGETS[role].schema),
    runtimePrivileges: {
      schemaUsage: false,
      schemaCreate: false,
      applicationTablesDml: false,
      sequencesAccess: false,
      historySelect: false,
      historyWrite: false,
      defaultTablesDml: false,
      defaultSequencesAccess: false,
      telemetryFunctionExecute: false,
    },
  }]));
  const events = [];
  const pools = {};
  let connectorCount = 0;
  let poolCount = 0;
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
      poolCount += 1;
      const role = fastpath
        ? "fastpath"
        : Object.entries(TEST_MIGRATIONS_TARGETS).find(([, target]) =>
          target.instanceConnectionName === options.instanceConnectionName)?.[0];
      assert.ok(role);
      assert.equal(options.database, fastpath
        ? FASTPATH_MIGRATION_TARGETS.primary.database
        : TEST_MIGRATIONS_TARGETS[role].database);
      if (fastpath) {
        assert.equal(options.instanceConnectionName,
          FASTPATH_MIGRATION_TARGETS.primary.instanceConnectionName);
      }
      assert.equal(options.user, TEST_MIGRATIONS_IAM_USER);
      assert.equal(options.max, 1);
      assert.equal(options.applicationName, "tibotattle-test-database-migrator");
      const pool = {
        async connect() {
          events.push({ role, type: "connect" });
          return {
            async query(sql, params) {
              events.push({ role, type: "query", sql, params });
              if (sql === "BEGIN" || sql === "BEGIN READ ONLY"
                  || sql === "COMMIT" || sql === "ROLLBACK"
                  || sql.startsWith("SET LOCAL")) {
                return { rows: [], rowCount: 0 };
              }
              const privileges = state[role].runtimePrivileges;
              if (sql.startsWith("REVOKE ALL ON SCHEMA ")) {
                privileges.schemaUsage = false;
                privileges.schemaCreate = false;
                return { rows: [], rowCount: 0 };
              }
              if (sql.startsWith("GRANT USAGE ON SCHEMA ")) {
                privileges.schemaUsage = true;
                return { rows: [], rowCount: 0 };
              }
              if (sql.startsWith("REVOKE ALL PRIVILEGES ON ALL TABLES ")) {
                privileges.applicationTablesDml = false;
                privileges.historySelect = false;
                privileges.historyWrite = false;
                return { rows: [], rowCount: 0 };
              }
              if (sql.startsWith("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES ")) {
                privileges.applicationTablesDml = true;
                privileges.historySelect = true;
                privileges.historyWrite = true;
                return { rows: [], rowCount: 0 };
              }
              if (sql.startsWith("REVOKE ALL PRIVILEGES ON ALL SEQUENCES ")) {
                privileges.sequencesAccess = false;
                return { rows: [], rowCount: 0 };
              }
              if (sql.startsWith("GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES ")) {
                privileges.sequencesAccess = true;
                return { rows: [], rowCount: 0 };
              }
              if (sql.startsWith("REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER")) {
                privileges.historyWrite = false;
                return { rows: [], rowCount: 0 };
              }
              if (sql.startsWith("ALTER DEFAULT PRIVILEGES IN SCHEMA ")
                  && sql.includes("REVOKE ALL ON TABLES")) {
                privileges.defaultTablesDml = false;
                return { rows: [], rowCount: 0 };
              }
              if (sql.startsWith("ALTER DEFAULT PRIVILEGES IN SCHEMA ")
                  && sql.includes("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES")) {
                privileges.defaultTablesDml = true;
                return { rows: [], rowCount: 0 };
              }
              if (sql.startsWith("ALTER DEFAULT PRIVILEGES IN SCHEMA ")
                  && sql.includes("REVOKE ALL ON SEQUENCES")) {
                privileges.defaultSequencesAccess = false;
                return { rows: [], rowCount: 0 };
              }
              if (sql.startsWith("ALTER DEFAULT PRIVILEGES IN SCHEMA ")
                  && sql.includes("GRANT USAGE, SELECT, UPDATE ON SEQUENCES")) {
                privileges.defaultSequencesAccess = true;
                return { rows: [], rowCount: 0 };
              }
              if (sql.startsWith("REVOKE ALL ON FUNCTION ")) {
                privileges.telemetryFunctionExecute = false;
                return { rows: [], rowCount: 0 };
              }
              if (sql.startsWith("GRANT EXECUTE ON FUNCTION ")) {
                privileges.telemetryFunctionExecute = true;
                return { rows: [], rowCount: 0 };
              }
              if (sql.includes("has_schema_privilege($1, $2, 'USAGE')")) {
                const actual = { ...privileges };
                if (corruptPrimaryPrivileges && role === "primary") actual.schemaUsage = false;
                return {
                  rows: [{
                    schema_usage: actual.schemaUsage,
                    schema_create: actual.schemaCreate,
                    application_tables_dml: actual.applicationTablesDml,
                    sequences_access: actual.sequencesAccess,
                    history_select: actual.historySelect,
                    history_insert: actual.historyWrite,
                    history_update: actual.historyWrite,
                    history_delete: actual.historyWrite,
                    default_tables_dml: actual.defaultTablesDml,
                    default_sequences_access: actual.defaultSequencesAccess,
                    no_global_table_defaults: true,
                    no_global_sequence_defaults: true,
                    telemetry_function_execute: role === "primary"
                      ? actual.telemetryFunctionExecute
                      : true,
                  }],
                  rowCount: 1,
                };
              }
              if (sql.includes("FROM pg_namespace")) {
                const owner = schemaOwners.get(params?.[0]);
                return owner !== null && owner !== undefined
                  ? { rows: [{ owner }], rowCount: 1 }
                  : { rows: [], rowCount: 0 };
              }
              if (sql.startsWith("CREATE SCHEMA ")) {
                const schema = sql.match(/^CREATE SCHEMA "([a-z0-9_]+)"$/u)?.[1];
                if (!schemaNames[role].includes(schema)) throw new Error("unexpected fake schema");
                schemaOwners.set(schema, TEST_MIGRATIONS_IAM_USER);
                return { rows: [], rowCount: 0 };
              }
              if (sql.includes(`."_tibotattle_migration_history"`)) {
                const schema = sql.match(/FROM "([a-z0-9_]+)"\."_tibotattle_migration_history"/u)?.[1];
                if (!schemaNames[role].includes(schema)) throw new Error("unexpected fake history schema");
                const rows = schemaReceipts.get(schema).map(({ version, name, sha256 }) => ({
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
      const poolRole = fastpath ? "fastpath" : role;
      assert.equal(pool, pools[poolRole]);
      assert.equal(schemaNames[poolRole].includes(schema), true);
      assert.equal(rootDirectory, TEST_MIGRATIONS_ROOT);
      const expected = manifest.roles[role].map(({ version, name, sha256 }) => ({
        version,
        name,
        sha256,
      }));
      const receipts = schemaReceipts.get(schema);
      for (const receipt of expected.slice(receipts.length)) {
        receipts.push(receipt);
      }
      if (corruptPrimaryReceipt && role === "primary") {
        receipts[0] = { ...receipts[0], sha256: "f".repeat(64) };
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
    get poolCount() { return poolCount; },
    get metadataCount() { return metadataCount; },
    get manifestCount() { return manifestCount; },
    get applyCalls() { return applyCalls; },
    get cleanupCalls() { return cleanupCalls; },
    schemaReceipts,
    schemaOwners,
  };
}

const manifest = await buildPostgresMigrationManifest({ rootDirectory: POSTGRES_MIGRATION_ROOT });

test("configuration is pinned to the one-task tibotattle migration Job and exact DB targets", () => {
  const config = parseTestMigrationsConfig(validEnv(), TEST_MIGRATIONS_SERVICE_ACCOUNT);
  assert.equal(config.job, TEST_MIGRATIONS_JOB);
  assert.equal(config.project, TEST_MIGRATIONS_PROJECT);
  assert.equal(manifest.roles.primary.length, 58);
  assert.equal(manifest.roles.ledger.length, 7);
  assert.equal(TEST_MIGRATIONS_TARGETS.primary.schema, "tibotattle_v12_a2_20260925");
  assert.equal(TEST_MIGRATIONS_TARGETS.ledger.schema, "tibotattle_ledger_v12_a2_20260925");
  assert.notEqual(TEST_MIGRATIONS_TARGETS.primary.schema, "tibotattle");
  assert.notEqual(TEST_MIGRATIONS_TARGETS.ledger.schema, "tibotattle_ledger");
  assert.equal(TEST_MIGRATIONS_RUNTIME_IAM_USER, "tibotattle-test-runtime@tibotattle.iam");
  expectCode(() => parseTestMigrationsConfig(
    validEnv({ PRIMARY_SCHEMA: GRAPH_BENCHMARK_MIGRATION_TARGETS[0].schema }),
    TEST_MIGRATIONS_SERVICE_ACCOUNT,
  ), "POSTGRES_TEST_MIGRATIONS_PRIMARY_TARGET_INVALID");
});

test("benchmark migrator profile pins all isolated primary-only schemas and rejects overrides", () => {
  const config = parseTestMigrationsConfig(
    validBenchmarkEnv(), TEST_MIGRATIONS_SERVICE_ACCOUNT, GRAPH_BENCHMARK_MIGRATION_PROFILE,
  );
  assert.equal(config.job, GRAPH_BENCHMARK_MIGRATIONS_JOB);
  assert.equal(config.profile, GRAPH_BENCHMARK_MIGRATION_PROFILE);
  assert.deepEqual(config.plans.map(({ role, target }) => [role, target.schema]), [
    ["primary", "tibotattle_graph_benchmark_10k_20260925"],
    ["primary", "tibotattle_graph_benchmark_100k_20260925"],
    ["primary", "tibotattle_graph_benchmark_100k_insights_20260925"],
    ["primary", "tibotattle_graph_benchmark_100k_paged_20260925"],
    ["primary", "tibotattle_graph_benchmark_100k_readpaged_20260925"],
    ["primary", "tibotattle_graph_benchmark_100k_readindexed_20260925"],
    ["primary", "tibotattle_graph_benchmark_100k_batched_20260925"],
  ]);
  for (const overrides of [
    { CLOUD_RUN_JOB: TEST_MIGRATIONS_JOB },
    { PRIMARY_SCHEMA: "public" },
    { PRIMARY_SCHEMA: TEST_MIGRATIONS_TARGETS.primary.schema },
    { PRIMARY_DATABASE: "production" },
    { PRIMARY_INSTANCE_CONNECTION_NAME: "other-project:us-east1:db" },
    { LEDGER_SCHEMA: TEST_MIGRATIONS_TARGETS.ledger.schema },
    { LEDGER_DATABASE: TEST_MIGRATIONS_TARGETS.ledger.database },
    { LEDGER_INSTANCE_CONNECTION_NAME: TEST_MIGRATIONS_TARGETS.ledger.instanceConnectionName },
  ]) {
    expectCode(() => parseTestMigrationsConfig(
      validBenchmarkEnv(overrides), TEST_MIGRATIONS_SERVICE_ACCOUNT, GRAPH_BENCHMARK_MIGRATION_PROFILE,
    ), overrides.CLOUD_RUN_JOB !== undefined
      ? "CLOUD_RUN_TEST_MIGRATIONS_JOB_CONTEXT_INVALID"
      : "POSTGRES_TEST_MIGRATIONS_BENCHMARK_TARGET_INVALID");
  }
  expectCode(() => parseTestMigrationsConfig(
    validBenchmarkEnv(), TEST_MIGRATIONS_SERVICE_ACCOUNT, "other-profile",
  ), "CLOUD_RUN_TEST_MIGRATIONS_PROFILE_INVALID");
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

  const invalidBenchmark = makeHarness(manifest, { graphBenchmark: true });
  await assert.rejects(runTestMigrations({
    env: validBenchmarkEnv({ PRIMARY_SCHEMA: "public" }),
    profile: GRAPH_BENCHMARK_MIGRATION_PROFILE,
    dependencies: invalidBenchmark.dependencies,
  }), (error) => error?.code === "POSTGRES_TEST_MIGRATIONS_BENCHMARK_TARGET_INVALID");
  assert.equal(invalidBenchmark.metadataCount, 0);
  assert.equal(invalidBenchmark.connectorCount, 0);
  assert.equal(invalidBenchmark.events.length, 0);
});

test("primary and ledger migrations are checksum-read back and repeated runs are idempotent", async () => {
  const harness = makeHarness(manifest);
  const first = await runTestMigrations({ env: validEnv(), dependencies: harness.dependencies });
  const second = await runTestMigrations({ env: validEnv(), dependencies: harness.dependencies });
  assert.deepEqual(first, second);
  assert.equal(first.migrations.primary.applied, 58);
  assert.equal(first.migrations.ledger.applied, 7);
  assert.match(first.migrations.primary.manifestSha256, /^[0-9a-f]{64}$/u);
  assert.match(first.migrations.ledger.latest.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(harness.state.primary.receipts.length, 58);
  assert.equal(harness.state.ledger.receipts.length, 7);
  assert.equal(harness.applyCalls, 4);
  assert.equal(harness.cleanupCalls, 2);
  assert.equal(harness.events.filter(({ sql }) => sql?.startsWith("CREATE SCHEMA")).length, 2);
  assert.equal(harness.events.filter(({ sql }) => sql?.startsWith("SELECT version, name, checksum_sha256")
    && sql.includes("_tibotattle_migration_history")).length, 4);
  const privilegeSql = harness.events
    .filter(({ sql }) => sql?.startsWith("GRANT ") || sql?.startsWith("REVOKE ")
      || sql?.startsWith("ALTER DEFAULT PRIVILEGES "))
    .map(({ sql }) => sql);
  for (const role of ["primary", "ledger"]) {
    const schema = `"${TEST_MIGRATIONS_TARGETS[role].schema}"`;
    assert.equal(privilegeSql.some((sql) => sql.includes(`SCHEMA ${schema}`)), true);
    assert.equal(privilegeSql.some((sql) => sql.includes(`IN SCHEMA ${schema}`)), true);
    assert.equal(privilegeSql.some((sql) => sql.includes("GRANT USAGE ON SCHEMA " + schema
      + ` TO "${TEST_MIGRATIONS_RUNTIME_IAM_USER}"`)), true);
    assert.equal(privilegeSql.some((sql) => sql.includes(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema}`,
    )), true);
    assert.equal(privilegeSql.some((sql) => sql.includes(
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema}`,
    )), true);
    assert.equal(privilegeSql.some((sql) => sql.includes(
      `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER\n         ON ${schema}."_tibotattle_migration_history"`,
    )), true);
  }
  assert.equal(privilegeSql.some((sql) => sql.startsWith("GRANT EXECUTE ON FUNCTION ")),
    true, "primary runtime must execute the intentionally non-public v1 admission function");
  assert.equal(privilegeSql.filter((sql) => sql.startsWith("GRANT EXECUTE ON FUNCTION ")).length, 2);
  assert.equal(harness.events.filter(({ sql }) => sql?.includes("has_schema_privilege($1, $2, 'USAGE')")).length, 4);
  assert.equal(privilegeSql.some((sql) => sql.includes('"tibotattle"')),
    false, "only the exact A2 schemas may receive grants");
});

test("benchmark profile applies 58 receipts and verifies runtime grants on every exact primary schema", async () => {
  const harness = makeHarness(manifest, { graphBenchmark: true });
  const result = await runTestMigrations({
    env: validBenchmarkEnv(),
    profile: GRAPH_BENCHMARK_MIGRATION_PROFILE,
    dependencies: harness.dependencies,
  });
  assert.equal(result.job, GRAPH_BENCHMARK_MIGRATIONS_JOB);
  assert.equal(result.profile, GRAPH_BENCHMARK_MIGRATION_PROFILE);
  assert.equal(result.migrations.primarySchemas.length, 7);
  assert.deepEqual(result.migrations.primarySchemas.map(({ schema, applied }) => [schema, applied]),
    GRAPH_BENCHMARK_MIGRATION_TARGETS.map(({ schema }) => [schema, 58]));
  assert.equal(harness.poolCount, 1, "both schemas use only the pinned primary database pool");
  assert.equal(harness.applyCalls, 7);
  assert.equal(harness.cleanupCalls, 1);
  assert.equal(harness.connectorCount, 1);
  assert.equal(harness.events.some(({ role }) => role === "ledger"), false);

  for (const { schema } of GRAPH_BENCHMARK_MIGRATION_TARGETS) {
    assert.equal(harness.schemaReceipts.get(schema).length, 58);
    assert.equal(harness.schemaOwners.get(schema), TEST_MIGRATIONS_IAM_USER);
    const quoted = `"${schema}"`;
    assert.equal(harness.events.some(({ sql }) => sql === `CREATE SCHEMA ${quoted}`), true);
    assert.equal(harness.events.some(({ sql }) => sql === `SELECT version, name, checksum_sha256
         FROM ${quoted}."_tibotattle_migration_history"
        ORDER BY version`), true, "every schema must read back its complete receipt chain");
    assert.equal(harness.events.some(({ sql }) => sql?.includes(
      `GRANT USAGE ON SCHEMA ${quoted} TO "${TEST_MIGRATIONS_RUNTIME_IAM_USER}"`,
    )), true);
    assert.equal(harness.events.some(({ sql }) => sql?.includes(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quoted}`,
    )), true);
    assert.equal(harness.events.some(({ sql }) => sql?.includes(
      `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER\n         ON ${quoted}."_tibotattle_migration_history"`,
    )), true, "runtime can read but cannot change migration receipts");
    assert.equal(harness.events.some(({ sql, params }) =>
      sql?.includes("has_schema_privilege($1, $2, 'USAGE')") && params?.[1] === schema,
    ), true, "runtime grant readback is scoped to the exact schema");
  }
});

test("runtime privilege readback fails closed when any required schema permission is missing", async () => {
  const harness = makeHarness(manifest, { corruptPrimaryPrivileges: true });
  await assert.rejects(
    runTestMigrations({ env: validEnv(), dependencies: harness.dependencies }),
    (error) => error?.code === "POSTGRES_TEST_MIGRATIONS_PRIMARY_RUNTIME_PRIVILEGES_INVALID",
  );
  assert.equal(harness.applyCalls, 1);
  assert.equal(harness.cleanupCalls, 1);
  assert.equal(harness.events.some(({ sql }) => sql?.includes('"tibotattle"')),
    false, "a privilege readback failure must not touch retired schemas");
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

test("fastpath profile pins a separate disposable database and both role schemas", () => {
  const config = parseTestMigrationsConfig(
    validFastpathEnv(), TEST_MIGRATIONS_SERVICE_ACCOUNT, FASTPATH_MIGRATION_PROFILE,
  );
  assert.equal(config.job, FASTPATH_MIGRATIONS_JOB);
  assert.equal(config.profile, FASTPATH_MIGRATION_PROFILE);
  assert.deepEqual(config.plans.map(({ role, poolKey, target }) => [role, poolKey, target.schema]), [
    ["primary", "fastpath", "tibotattle_fastpath_20261001"],
    ["ledger", "fastpath", "tibotattle_fastpath_ledger_20261001"],
  ]);
  assert.deepEqual(config.expectedCounts, {
    primary: manifest.roles.primary.length,
    ledger: manifest.roles.ledger.length,
  });
  for (const target of Object.values(FASTPATH_MIGRATION_TARGETS)) {
    assert.equal(target.instanceConnectionName, TEST_MIGRATIONS_TARGETS.primary.instanceConnectionName);
    assert.equal(target.database, "tibotattle_fastpath");
    assert.notEqual(target.database, TEST_MIGRATIONS_TARGETS.primary.database,
      "the shared test database must never receive the fast-path control schema");
    assert.match(target.schema, /^tibotattle_fastpath_/u);
  }
  for (const overrides of [
    { PRIMARY_SCHEMA: TEST_MIGRATIONS_TARGETS.primary.schema },
    { PRIMARY_DATABASE: TEST_MIGRATIONS_TARGETS.primary.database },
    { LEDGER_SCHEMA: TEST_MIGRATIONS_TARGETS.ledger.schema },
    { LEDGER_DATABASE: TEST_MIGRATIONS_TARGETS.ledger.database },
    { LEDGER_INSTANCE_CONNECTION_NAME: TEST_MIGRATIONS_TARGETS.ledger.instanceConnectionName },
  ]) {
    expectCode(() => parseTestMigrationsConfig(
      validFastpathEnv(overrides), TEST_MIGRATIONS_SERVICE_ACCOUNT, FASTPATH_MIGRATION_PROFILE,
    ), "POSTGRES_TEST_MIGRATIONS_FASTPATH_TARGET_INVALID");
  }
  for (const overrides of [
    { PRIMARY_EXPECTED_MIGRATIONS: undefined },
    { LEDGER_EXPECTED_MIGRATIONS: "0" },
    { PRIMARY_EXPECTED_MIGRATIONS: "58 " },
    { LEDGER_EXPECTED_MIGRATIONS: "-7" },
  ]) {
    expectCode(() => parseTestMigrationsConfig(
      validFastpathEnv(overrides), TEST_MIGRATIONS_SERVICE_ACCOUNT, FASTPATH_MIGRATION_PROFILE,
    ), "POSTGRES_TEST_MIGRATIONS_FASTPATH_EXPECTED_COUNT_INVALID");
  }
  expectCode(() => parseTestMigrationsConfig(
    validFastpathEnv({ CLOUD_RUN_JOB: TEST_MIGRATIONS_JOB }),
    TEST_MIGRATIONS_SERVICE_ACCOUNT, FASTPATH_MIGRATION_PROFILE,
  ), "CLOUD_RUN_TEST_MIGRATIONS_JOB_CONTEXT_INVALID");
  expectCode(() => parseTestMigrationsConfig(
    validEnv(), TEST_MIGRATIONS_SERVICE_ACCOUNT, FASTPATH_MIGRATION_PROFILE,
  ), "CLOUD_RUN_TEST_MIGRATIONS_JOB_CONTEXT_INVALID");
});

test("fastpath expected counts must equal the image manifest before any database access", async () => {
  const harness = makeHarness(manifest, { fastpath: true });
  await assert.rejects(runTestMigrations({
    env: validFastpathEnv({ PRIMARY_EXPECTED_MIGRATIONS: String(manifest.roles.primary.length + 1) }),
    profile: FASTPATH_MIGRATION_PROFILE,
    dependencies: harness.dependencies,
  }), (error) => error?.code === "POSTGRES_TEST_MIGRATIONS_FASTPATH_EXPECTED_COUNT_MISMATCH");
  assert.equal(harness.manifestCount, 1);
  assert.equal(harness.connectorCount, 0);
  assert.equal(harness.events.length, 0);
});

test("fastpath profile applies both roles through one pool and grants only its exact schemas", async () => {
  const harness = makeHarness(manifest, { fastpath: true });
  const first = await runTestMigrations({
    env: validFastpathEnv(), profile: FASTPATH_MIGRATION_PROFILE, dependencies: harness.dependencies,
  });
  const second = await runTestMigrations({
    env: validFastpathEnv(), profile: FASTPATH_MIGRATION_PROFILE, dependencies: harness.dependencies,
  });
  assert.deepEqual(first, second);
  assert.equal(first.job, FASTPATH_MIGRATIONS_JOB);
  assert.equal(first.profile, FASTPATH_MIGRATION_PROFILE);
  assert.equal(first.migrations.primary.schema, FASTPATH_MIGRATION_TARGETS.primary.schema);
  assert.equal(first.migrations.ledger.schema, FASTPATH_MIGRATION_TARGETS.ledger.schema);
  assert.equal(first.migrations.primary.applied, manifest.roles.primary.length);
  assert.equal(first.migrations.ledger.applied, manifest.roles.ledger.length);
  assert.equal(harness.poolCount, 2, "one pool per run, shared by both role schemas");
  assert.equal(harness.applyCalls, 4);
  assert.equal(harness.cleanupCalls, 2);
  for (const { schema } of Object.values(FASTPATH_MIGRATION_TARGETS)) {
    const quoted = `"${schema}"`;
    assert.equal(harness.schemaOwners.get(schema), TEST_MIGRATIONS_IAM_USER);
    assert.equal(harness.events.filter(({ sql }) => sql === `CREATE SCHEMA ${quoted}`).length, 1);
    assert.equal(harness.events.some(({ sql }) => sql?.includes(
      `GRANT USAGE ON SCHEMA ${quoted} TO "${TEST_MIGRATIONS_RUNTIME_IAM_USER}"`,
    )), true);
  }
  const grantSql = harness.events.map(({ sql }) => sql ?? "")
    .filter((sql) => /^(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES)/u.test(sql));
  assert.equal(grantSql.every((sql) => sql.includes('"tibotattle_fastpath_')), true,
    "fast-path grants never reach the shared A2 or benchmark schemas");
  assert.equal(grantSql.filter((sql) => sql.startsWith("GRANT EXECUTE ON FUNCTION "
    + `"${FASTPATH_MIGRATION_TARGETS.primary.schema}".`)).length, 2,
  "only the primary role schema carries the v1 admission function grant");
});
