#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  grantAndVerifyTestRuntimePrivileges,
  parseTestMigrationsConfig,
  runTestMigrations,
  TEST_MIGRATIONS_IAM_USER,
  TEST_MIGRATIONS_JOB,
  TEST_MIGRATIONS_PROJECT,
  TEST_MIGRATIONS_ROOT,
  TEST_MIGRATIONS_RUNTIME_IAM_USER,
  TEST_MIGRATIONS_SERVICE_ACCOUNT,
  TEST_OPERATOR_ONLY_PRIMARY_FUNCTIONS,
  TEST_RUNTIME_PRIMARY_FUNCTIONS,
  functionSignature,
  restrictedFunctionsMatchPolicy,
} from "./test-migrations.mjs";
import { CLOUD_RUN_IAM_TEST_TARGET } from "./postgres-test-dispatch.mjs";

const EXECUTION = "tibotattle-test-database-migrate-20260924-abc12";
// The retired A2 primary target (owner decision OD-6): the shared test
// database and the A2 schema, now a refusal identity only.
const A2_TARGET = CLOUD_RUN_IAM_TEST_TARGET.postgres.primary;

/** The environment the retired A2 migrate Job ran with (no profile accepts it). */
function retiredA2Env(overrides = {}) {
  return {
    CLOUD_RUN_JOB: TEST_MIGRATIONS_JOB,
    CLOUD_RUN_EXECUTION: EXECUTION,
    CLOUD_RUN_TASK_INDEX: "0",
    CLOUD_RUN_TASK_COUNT: "1",
    CLOUD_RUN_TASK_ATTEMPT: "0",
    GOOGLE_CLOUD_PROJECT: TEST_MIGRATIONS_PROJECT,
    POSTGRES_MIGRATOR_IAM_USER: TEST_MIGRATIONS_IAM_USER,
    PRIMARY_DATABASE: A2_TARGET.database,
    PRIMARY_SCHEMA: A2_TARGET.schema,
    PRIMARY_INSTANCE_CONNECTION_NAME: A2_TARGET.instanceConnectionName,
    ...overrides,
  };
}

// The retired A2 ledger target (owner action OA-4), as a stale deployment
// would still set it. Every profile refuses any of these settings.
const RETIRED_LEDGER_SETTINGS = Object.freeze([
  { LEDGER_DATABASE: "tibotattle_ledger" },
  { LEDGER_SCHEMA: "tibotattle_ledger_v12_a2_20260925" },
  { LEDGER_INSTANCE_CONNECTION_NAME: "tibotattle:us-east1:tibotattle-test-ledger-20260922" },
  { LEDGER_EXPECTED_MIGRATIONS: "7" },
  { LEDGER_SCHEMA: "" },
]);

function validBenchmarkEnv(overrides = {}) {
  const env = retiredA2Env();
  delete env.PRIMARY_SCHEMA;
  Object.assign(env, {
    CLOUD_RUN_JOB: GRAPH_BENCHMARK_MIGRATIONS_JOB,
    PRIMARY_DATABASE: GRAPH_BENCHMARK_MIGRATION_TARGETS[0].database,
    PRIMARY_INSTANCE_CONNECTION_NAME: GRAPH_BENCHMARK_MIGRATION_TARGETS[0].instanceConnectionName,
  }, overrides);
  return env;
}

function validFastpathEnv(overrides = {}) {
  return retiredA2Env({
    CLOUD_RUN_JOB: FASTPATH_MIGRATIONS_JOB,
    PRIMARY_DATABASE: FASTPATH_MIGRATION_TARGETS.primary.database,
    PRIMARY_SCHEMA: FASTPATH_MIGRATION_TARGETS.primary.schema,
    PRIMARY_INSTANCE_CONNECTION_NAME: FASTPATH_MIGRATION_TARGETS.primary.instanceConnectionName,
    PRIMARY_EXPECTED_MIGRATIONS: String(manifest.roles.primary.length),
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
  // Read-back rows the grants cannot change (e.g. a privilege held through
  // role membership), appended for every primary role schema.
  extraPrimaryRestrictedFunctions = [],
} = {}) {
  const schemaNames = {
    primary: [A2_TARGET.schema,
      ...(graphBenchmark ? GRAPH_BENCHMARK_MIGRATION_TARGETS.map(({ schema }) => schema) : [])],
    ...(fastpath
      ? { fastpath: Object.values(FASTPATH_MIGRATION_TARGETS).map(({ schema }) => schema) }
      : {}),
  };
  const allSchemas = Object.values(schemaNames).flat();
  const schemaReceipts = new Map(allSchemas.map((schema) => [schema, []]));
  const schemaOwners = new Map(allSchemas.map((schema) => [schema, null]));
  if (wrongPrimaryOwner) {
    schemaOwners.set(fastpath ? FASTPATH_MIGRATION_TARGETS.primary.schema : A2_TARGET.schema, "different-owner");
  }
  const state = Object.fromEntries([
    "primary",
    ...(fastpath ? ["fastpath"] : []),
  ].map((role) => [role, {
    schemaExists: false,
    owner: null,
    receipts: schemaReceipts.get(role === "fastpath" ? FASTPATH_MIGRATION_TARGETS.primary.schema : A2_TARGET.schema)
      ?? null,
    runtimePrivileges: {
      schemaUsage: false,
      schemaCreate: false,
      applicationTablesDml: false,
      sequencesAccess: false,
      historySelect: false,
      historyWrite: false,
      defaultTablesDml: false,
      defaultSequencesAccess: false,
    },
  }]));
  // Direct EXECUTE grants to the runtime role, per schema, as `name(args)`.
  const functionGrants = new Map(allSchemas.map((schema) => [schema, new Set()]));
  // The primary migrations' non-PUBLIC functions: the runtime ones and the operator-only ones.
  const restrictedPrimaryFunctions = [...TEST_RUNTIME_PRIMARY_FUNCTIONS, ...TEST_OPERATOR_ONLY_PRIMARY_FUNCTIONS]
    .map(functionSignature);
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
        : A2_TARGET.instanceConnectionName === options.instanceConnectionName ? "primary" : undefined;
      assert.ok(role);
      assert.equal(options.database, fastpath
        ? FASTPATH_MIGRATION_TARGETS.primary.database
        : A2_TARGET.database);
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
              if (sql.startsWith("REVOKE ALL ON ALL ROUTINES IN SCHEMA ")) {
                const schema = sql.match(/^REVOKE ALL ON ALL ROUTINES IN SCHEMA "([a-z0-9_]+)" FROM /u)?.[1];
                if (!functionGrants.has(schema)) functionGrants.set(schema, new Set());
                functionGrants.get(schema).clear();
                return { rows: [], rowCount: 0 };
              }
              if (sql.startsWith("GRANT EXECUTE ON FUNCTION ")) {
                const [, schema, name, args] = sql.match(
                  /^GRANT EXECUTE ON FUNCTION "([a-z0-9_]+)"\."([a-z0-9_]+)"\(([a-z, ]*)\) TO /u) ?? [];
                if (!restrictedPrimaryFunctions.includes(`${name}(${args})`)) {
                  throw new Error("unexpected fake function grant");
                }
                if (!functionGrants.has(schema)) functionGrants.set(schema, new Set());
                functionGrants.get(schema).add(`${name}(${args})`);
                return { rows: [], rowCount: 0 };
              }
              if (sql.includes("has_schema_privilege($1, $2, 'USAGE')")) {
                const actual = { ...privileges };
                if (corruptPrimaryPrivileges && (role === "primary" || role === "fastpath")) {
                  actual.schemaUsage = false;
                }
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
                    restricted_functions: restrictedPrimaryFunctions
                      .map((signature) => ({
                        signature,
                        runtime_execute: functionGrants.get(params[1])?.has(signature) === true,
                      })).concat(extraPrimaryRestrictedFunctions),
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

test("the a2 profile is retired (OD-6): no profile, 'a2' or the A2 Job and target is accepted", async () => {
  assert.equal(manifest.schemaVersion, "tibotattle-postgres-migration-manifest-v2");
  assert.deepEqual(Object.keys(manifest.roles), ["primary"]);
  assert.equal(manifest.roles.primary.length, 65);
  assert.deepEqual(Object.keys(FASTPATH_MIGRATION_TARGETS), ["primary"]);
  assert.equal(TEST_MIGRATIONS_RUNTIME_IAM_USER, "tibotattle-test-runtime@tibotattle.iam");
  // The A2 Job's name stays a refusal identity until owner action OA-4.
  assert.equal(TEST_MIGRATIONS_JOB, "tibotattle-test-database-migrate");
  for (const profile of [undefined, null, "", "a2", "A2", "default"]) {
    expectCode(() => parseTestMigrationsConfig(retiredA2Env(), TEST_MIGRATIONS_SERVICE_ACCOUNT, profile),
      "CLOUD_RUN_TEST_MIGRATIONS_PROFILE_INVALID");
    const harness = makeHarness(manifest);
    await assert.rejects(runTestMigrations({ env: retiredA2Env(), profile, dependencies: harness.dependencies }),
      (error) => error?.code === "CLOUD_RUN_TEST_MIGRATIONS_PROFILE_INVALID", String(profile));
    assert.equal(harness.metadataCount, 0);
    assert.equal(harness.manifestCount, 0);
    assert.equal(harness.connectorCount, 0);
    assert.equal(harness.events.length, 0);
  }
  // Under a live profile the A2 Job and the A2 target are refused.
  for (const profile of [GRAPH_BENCHMARK_MIGRATION_PROFILE, FASTPATH_MIGRATION_PROFILE]) {
    expectCode(() => parseTestMigrationsConfig(retiredA2Env(), TEST_MIGRATIONS_SERVICE_ACCOUNT, profile),
      "CLOUD_RUN_TEST_MIGRATIONS_JOB_CONTEXT_INVALID");
  }
  expectCode(() => parseTestMigrationsConfig(validFastpathEnv({ PRIMARY_DATABASE: A2_TARGET.database,
    PRIMARY_SCHEMA: A2_TARGET.schema }), TEST_MIGRATIONS_SERVICE_ACCOUNT, FASTPATH_MIGRATION_PROFILE),
  "POSTGRES_TEST_MIGRATIONS_FASTPATH_TARGET_INVALID");
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
    { PRIMARY_SCHEMA: A2_TARGET.schema },
    { PRIMARY_DATABASE: "production" },
    { PRIMARY_INSTANCE_CONNECTION_NAME: "other-project:us-east1:db" },
  ]) {
    expectCode(() => parseTestMigrationsConfig(
      validBenchmarkEnv(overrides), TEST_MIGRATIONS_SERVICE_ACCOUNT, GRAPH_BENCHMARK_MIGRATION_PROFILE,
    ), overrides.CLOUD_RUN_JOB !== undefined
      ? "CLOUD_RUN_TEST_MIGRATIONS_JOB_CONTEXT_INVALID"
      : "POSTGRES_TEST_MIGRATIONS_BENCHMARK_TARGET_INVALID");
  }
  for (const overrides of RETIRED_LEDGER_SETTINGS) {
    expectCode(() => parseTestMigrationsConfig(
      validBenchmarkEnv(overrides), TEST_MIGRATIONS_SERVICE_ACCOUNT, GRAPH_BENCHMARK_MIGRATION_PROFILE,
    ), "POSTGRES_TEST_MIGRATIONS_LEDGER_TARGET_RETIRED");
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
    ...RETIRED_LEDGER_SETTINGS,
  ]) {
    expectCode(
      () => parseTestMigrationsConfig(validFastpathEnv(overrides), TEST_MIGRATIONS_SERVICE_ACCOUNT,
        FASTPATH_MIGRATION_PROFILE),
      overrides.K_SERVICE !== undefined
        ? "CLOUD_RUN_TEST_MIGRATIONS_JOB_CONTEXT_INVALID"
        : overrides.POSTGRES_MIGRATOR_IAM_USER !== undefined
          ? "POSTGRES_TEST_MIGRATIONS_IAM_USER_INVALID"
          : overrides.PRIMARY_INSTANCE_CONNECTION_NAME !== undefined
            || overrides.PRIMARY_DATABASE !== undefined || overrides.PRIMARY_SCHEMA !== undefined
            ? "POSTGRES_TEST_MIGRATIONS_FASTPATH_TARGET_INVALID"
            : Object.keys(overrides).some((name) => name.startsWith("LEDGER_"))
              ? "POSTGRES_TEST_MIGRATIONS_LEDGER_TARGET_RETIRED"
              : "CLOUD_RUN_TEST_MIGRATIONS_JOB_CONTEXT_INVALID",
    );
  }
  expectCode(
    () => parseTestMigrationsConfig(validFastpathEnv(), "wrong@tibotattle.iam.gserviceaccount.com",
      FASTPATH_MIGRATION_PROFILE),
    "CLOUD_RUN_TEST_MIGRATIONS_SERVICE_ACCOUNT_INVALID",
  );
});

test("invalid context and wrong attached service account stop before connector or database access", async () => {
  const invalidContext = makeHarness(manifest, { fastpath: true });
  await assert.rejects(
    runTestMigrations({
      env: validFastpathEnv({ PRIMARY_DATABASE: "production" }),
      profile: FASTPATH_MIGRATION_PROFILE,
      dependencies: invalidContext.dependencies,
    }),
    (error) => error?.code === "POSTGRES_TEST_MIGRATIONS_FASTPATH_TARGET_INVALID",
  );
  assert.equal(invalidContext.metadataCount, 0);
  assert.equal(invalidContext.manifestCount, 0);
  assert.equal(invalidContext.connectorCount, 0);
  assert.equal(invalidContext.events.length, 0);

  const wrongIdentity = makeHarness(manifest, { fastpath: true });
  wrongIdentity.dependencies.readServiceAccountEmail = async () => {
    return "different@tibotattle.iam.gserviceaccount.com";
  };
  await assert.rejects(
    runTestMigrations({ env: validFastpathEnv(), profile: FASTPATH_MIGRATION_PROFILE,
      dependencies: wrongIdentity.dependencies }),
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

  // A stale ledger setting stops every profile before metadata or SQL.
  for (const [env, profile] of [
    [validBenchmarkEnv({ LEDGER_DATABASE: "tibotattle_ledger" }), GRAPH_BENCHMARK_MIGRATION_PROFILE],
    [validFastpathEnv({ LEDGER_EXPECTED_MIGRATIONS: "7" }), FASTPATH_MIGRATION_PROFILE],
  ]) {
    const stale = makeHarness(manifest, { fastpath: profile === FASTPATH_MIGRATION_PROFILE });
    await assert.rejects(runTestMigrations({ env, profile, dependencies: stale.dependencies }),
      (error) => error?.code === "POSTGRES_TEST_MIGRATIONS_LEDGER_TARGET_RETIRED");
    assert.equal(stale.metadataCount, 0);
    assert.equal(stale.manifestCount, 0);
    assert.equal(stale.connectorCount, 0);
    assert.equal(stale.events.length, 0);
  }
});

test("a v1 or dual-role manifest is refused before any database access", async () => {
  const withLedger = { ...manifest, roles: { ...manifest.roles, ledger: [] } };
  const v1 = { ...manifest, schemaVersion: "tibotattle-postgres-migration-manifest-v1" };
  for (const stale of [withLedger, v1]) {
    const harness = makeHarness(stale, { fastpath: true });
    await assert.rejects(runTestMigrations({ env: validFastpathEnv(), profile: FASTPATH_MIGRATION_PROFILE,
      dependencies: harness.dependencies }),
      (error) => error?.code === "POSTGRES_TEST_MIGRATIONS_MANIFEST_INVALID");
    assert.equal(harness.connectorCount, 0);
    assert.equal(harness.events.length, 0);
  }
});

test("the primary migrations are checksum-read back and repeated runs are idempotent", async () => {
  const harness = makeHarness(manifest, { fastpath: true });
  const run = () => runTestMigrations({ env: validFastpathEnv(), profile: FASTPATH_MIGRATION_PROFILE,
    dependencies: harness.dependencies });
  const first = await run();
  const second = await run();
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first.migrations), ["primary"]);
  assert.equal(first.migrations.primary.applied, 65);
  assert.equal(first.migrations.primary.latest.name, "0065_interim_public_read.sql");
  assert.match(first.migrations.primary.manifestSha256, /^[0-9a-f]{64}$/u);
  assert.equal(harness.schemaReceipts.get(FASTPATH_MIGRATION_TARGETS.primary.schema).length, 65);
  assert.equal(harness.poolCount, 2, "one primary pool per run, no ledger pool");
  assert.equal(harness.applyCalls, 2);
  assert.equal(harness.cleanupCalls, 2);
  assert.equal(harness.events.filter(({ sql }) => sql?.startsWith("CREATE SCHEMA")).length, 1);
  assert.equal(harness.events.filter(({ sql }) => sql?.startsWith("SELECT version, name, checksum_sha256")
    && sql.includes("_tibotattle_migration_history")).length, 2);
  const privilegeSql = harness.events
    .filter(({ sql }) => sql?.startsWith("GRANT ") || sql?.startsWith("REVOKE ")
      || sql?.startsWith("ALTER DEFAULT PRIVILEGES "))
    .map(({ sql }) => sql);
  for (const role of ["primary"]) {
    const schema = `"${FASTPATH_MIGRATION_TARGETS[role].schema}"`;
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
  const primarySchema = `"${FASTPATH_MIGRATION_TARGETS.primary.schema}"`;
  const functionGrantSql = privilegeSql.filter((sql) => sql.startsWith("GRANT EXECUTE ON FUNCTION "));
  assert.deepEqual(functionGrantSql, [1, 2].flatMap(() => TEST_RUNTIME_PRIMARY_FUNCTIONS.map(({ name, args }) =>
    `GRANT EXECUTE ON FUNCTION ${primarySchema}."${name}"(${args}) TO "${TEST_MIGRATIONS_RUNTIME_IAM_USER}"`)),
  "each run grants the primary runtime exactly its non-public request-path functions");
  for (const role of ["primary"]) {
    assert.equal(privilegeSql.filter((sql) => sql === `REVOKE ALL ON ALL ROUTINES IN SCHEMA "${
      FASTPATH_MIGRATION_TARGETS[role].schema}" FROM "${TEST_MIGRATIONS_RUNTIME_IAM_USER}"`).length, 2,
    `${role}: every run resets direct routine grants first`);
  }
  for (const { name } of TEST_OPERATOR_ONLY_PRIMARY_FUNCTIONS) {
    assert.equal(privilegeSql.some((sql) => sql.includes(name)), false, `${name} is never granted`);
  }
  assert.equal(harness.events.filter(({ sql }) => sql?.includes("has_schema_privilege($1, $2, 'USAGE')")).length, 2);
  assert.equal(privilegeSql.some((sql) => sql.includes('"tibotattle"')),
    false, "only the exact fast-path schema may receive grants");
  assert.equal(privilegeSql.some((sql) => sql.includes(`"${A2_TARGET.schema}"`)), false,
    "the retired A2 schema never receives grants");
});

test("benchmark profile applies 65 receipts and verifies runtime grants on every exact primary schema", async () => {
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
    GRAPH_BENCHMARK_MIGRATION_TARGETS.map(({ schema }) => [schema, 65]));
  assert.equal(harness.poolCount, 1, "both schemas use only the pinned primary database pool");
  assert.equal(harness.applyCalls, 7);
  assert.equal(harness.cleanupCalls, 1);
  assert.equal(harness.connectorCount, 1);
  assert.equal(harness.events.some(({ role }) => role === "ledger"), false);

  for (const { schema } of GRAPH_BENCHMARK_MIGRATION_TARGETS) {
    assert.equal(harness.schemaReceipts.get(schema).length, 65);
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
  const harness = makeHarness(manifest, { fastpath: true, corruptPrimaryPrivileges: true });
  await assert.rejects(
    runTestMigrations({ env: validFastpathEnv(), profile: FASTPATH_MIGRATION_PROFILE,
      dependencies: harness.dependencies }),
    (error) => error?.code === "POSTGRES_TEST_MIGRATIONS_PRIMARY_RUNTIME_PRIVILEGES_INVALID",
  );
  assert.equal(harness.applyCalls, 1);
  assert.equal(harness.cleanupCalls, 1);
  assert.equal(harness.events.some(({ sql }) => sql?.includes('"tibotattle"')),
    false, "a privilege readback failure must not touch retired schemas");
});

test("a pre-existing schema with unexpected owner refuses before applying migrations", async () => {
  const harness = makeHarness(manifest, { fastpath: true, wrongPrimaryOwner: true });
  await assert.rejects(
    runTestMigrations({ env: validFastpathEnv(), profile: FASTPATH_MIGRATION_PROFILE,
      dependencies: harness.dependencies }),
    (error) => error?.code === "POSTGRES_TEST_MIGRATIONS_PRIMARY_SCHEMA_OWNER_UNEXPECTED",
  );
  assert.equal(harness.applyCalls, 0);
  assert.equal(harness.cleanupCalls, 1);
});

test("a receipt checksum mismatch fails closed and still closes database resources", async () => {
  const harness = makeHarness(manifest, { fastpath: true, corruptPrimaryReceipt: true });
  await assert.rejects(
    runTestMigrations({ env: validFastpathEnv(), profile: FASTPATH_MIGRATION_PROFILE,
      dependencies: harness.dependencies }),
    (error) => error?.code === "POSTGRES_TEST_MIGRATIONS_PRIMARY_RECEIPT_MISMATCH",
  );
  assert.equal(harness.applyCalls, 1);
  assert.equal(harness.cleanupCalls, 1);
});

test("fastpath profile pins a separate disposable database and its one primary schema", () => {
  const config = parseTestMigrationsConfig(
    validFastpathEnv(), TEST_MIGRATIONS_SERVICE_ACCOUNT, FASTPATH_MIGRATION_PROFILE,
  );
  assert.equal(config.job, FASTPATH_MIGRATIONS_JOB);
  assert.equal(config.profile, FASTPATH_MIGRATION_PROFILE);
  assert.deepEqual(config.plans.map(({ role, poolKey, target }) => [role, poolKey, target.schema]), [
    ["primary", "fastpath", "tibotattle_fastpath_20261001"],
  ]);
  assert.deepEqual(config.expectedCounts, {
    primary: manifest.roles.primary.length,
  });
  for (const target of Object.values(FASTPATH_MIGRATION_TARGETS)) {
    assert.equal(target.instanceConnectionName, A2_TARGET.instanceConnectionName);
    assert.equal(target.database, "tibotattle_fastpath");
    assert.notEqual(target.database, A2_TARGET.database,
      "the shared test database must never receive the fast-path control schema");
    assert.match(target.schema, /^tibotattle_fastpath_/u);
  }
  for (const overrides of [
    { PRIMARY_SCHEMA: A2_TARGET.schema },
    { PRIMARY_DATABASE: A2_TARGET.database },
  ]) {
    expectCode(() => parseTestMigrationsConfig(
      validFastpathEnv(overrides), TEST_MIGRATIONS_SERVICE_ACCOUNT, FASTPATH_MIGRATION_PROFILE,
    ), "POSTGRES_TEST_MIGRATIONS_FASTPATH_TARGET_INVALID");
  }
  for (const overrides of [
    ...RETIRED_LEDGER_SETTINGS,
    { LEDGER_SCHEMA: "tibotattle_fastpath_ledger_20261001" },
  ]) {
    expectCode(() => parseTestMigrationsConfig(
      validFastpathEnv(overrides), TEST_MIGRATIONS_SERVICE_ACCOUNT, FASTPATH_MIGRATION_PROFILE,
    ), "POSTGRES_TEST_MIGRATIONS_LEDGER_TARGET_RETIRED");
  }
  for (const overrides of [
    { PRIMARY_EXPECTED_MIGRATIONS: undefined },
    { PRIMARY_EXPECTED_MIGRATIONS: "0" },
    { PRIMARY_EXPECTED_MIGRATIONS: "58 " },
    { PRIMARY_EXPECTED_MIGRATIONS: "-7" },
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
    retiredA2Env(), TEST_MIGRATIONS_SERVICE_ACCOUNT, FASTPATH_MIGRATION_PROFILE,
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

/** The manifest with one synthetic primary migration appended, re-digested as the runner would. */
function manifestWithExtraPrimaryMigration(base) {
  const sql = "SELECT 1;\n";
  const extra = {
    ...base.roles.primary.at(-1),
    version: base.roles.primary.length + 1,
    name: `${String(base.roles.primary.length + 1).padStart(4, "0")}_synthetic_fastpath_probe.sql`,
    sql,
    bytes: Buffer.byteLength(sql),
    sha256: createHash("sha256").update(sql).digest("hex"),
  };
  const roles = { primary: [...base.roles.primary, extra] };
  const canonical = JSON.stringify({
    schemaVersion: base.schemaVersion,
    roles: Object.fromEntries(["primary"].map((role) => [role,
      roles[role].map(({ version, name, bytes, sha256 }) => ({ version, name, bytes, sha256 }))])),
  });
  return { ...base, roles, sha256: createHash("sha256").update(canonical).digest("hex") };
}

test("the benchmark stays pinned at its count while fastpath follows the deploying commit's counts", async () => {
  const grown = manifestWithExtraPrimaryMigration(manifest);
  assert.equal(grown.roles.primary.length, GRAPH_BENCHMARK_MIGRATION_TARGETS[0].expectedMigrations + 1);

  const benchmark = makeHarness(grown, { graphBenchmark: true });
  await assert.rejects(runTestMigrations({
    env: validBenchmarkEnv(), profile: GRAPH_BENCHMARK_MIGRATION_PROFILE, dependencies: benchmark.dependencies,
  }), (error) => error?.code === "POSTGRES_TEST_MIGRATIONS_MANIFEST_INVALID");
  assert.equal(benchmark.connectorCount, 0);

  const stale = makeHarness(grown, { fastpath: true });
  await assert.rejects(runTestMigrations({
    env: validFastpathEnv(), profile: FASTPATH_MIGRATION_PROFILE, dependencies: stale.dependencies,
  }), (error) => error?.code === "POSTGRES_TEST_MIGRATIONS_FASTPATH_EXPECTED_COUNT_MISMATCH",
  "counts from an older commit do not match a newer image");
  assert.equal(stale.connectorCount, 0);

  const fastpath = makeHarness(grown, { fastpath: true });
  const result = await runTestMigrations({
    env: validFastpathEnv({ PRIMARY_EXPECTED_MIGRATIONS: String(grown.roles.primary.length) }),
    profile: FASTPATH_MIGRATION_PROFILE,
    dependencies: fastpath.dependencies,
  });
  assert.equal(result.migrations.primary.applied, grown.roles.primary.length);
  assert.equal(result.migrations.primary.latest.name, grown.roles.primary.at(-1).name);
  assert.deepEqual(Object.keys(result.migrations), ["primary"]);
});

test("fastpath profile applies the primary schema through one pool and grants only its exact schema", async () => {
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
  assert.deepEqual(Object.keys(first.migrations), ["primary"]);
  assert.equal(first.migrations.primary.applied, manifest.roles.primary.length);
  assert.equal(harness.poolCount, 2, "one pool per run");
  assert.equal(harness.applyCalls, 2);
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
    + `"${FASTPATH_MIGRATION_TARGETS.primary.schema}".`)).length, 2 * TEST_RUNTIME_PRIMARY_FUNCTIONS.length,
  "only the primary role schema carries the runtime function grants");
  assert.equal(grantSql.filter((sql) => sql.startsWith("GRANT EXECUTE ON FUNCTION ")).length,
    2 * TEST_RUNTIME_PRIMARY_FUNCTIONS.length);
});

test("the exported runtime-grant routine applies the same policy to one named schema", async () => {
  const harness = makeHarness(manifest);
  const pool = await harness.dependencies.createPool({
    connector: { testConnector: true },
    instanceConnectionName: A2_TARGET.instanceConnectionName,
    database: A2_TARGET.database,
    user: TEST_MIGRATIONS_IAM_USER,
    max: 1,
    applicationName: "tibotattle-test-database-migrator",
  });
  const schema = "typed_legacy_transfer_rehearsal_target_fastpath_gcp";
  await grantAndVerifyTestRuntimePrivileges(pool, "primary", schema);
  const quoted = `"${schema}"`;
  const grants = harness.events.map(({ sql }) => sql ?? "")
    .filter((sql) => /^(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES)/u.test(sql));
  assert.equal(grants.length > 0 && grants.every((sql) => sql.includes(quoted)), true);
  for (const grant of [
    `GRANT EXECUTE ON FUNCTION ${quoted}."insert_telemetry_v1_contribution"(jsonb) TO "${TEST_MIGRATIONS_RUNTIME_IAM_USER}"`,
    `GRANT EXECUTE ON FUNCTION ${quoted}."storage_journal_append"(text, text, text, text, text) TO "${TEST_MIGRATIONS_RUNTIME_IAM_USER}"`,
    `GRANT EXECUTE ON FUNCTION ${quoted}."storage_owner_link_ensure"(text, text) TO "${TEST_MIGRATIONS_RUNTIME_IAM_USER}"`,
  ]) assert.equal(grants.includes(grant), true, grant);
  assert.equal(harness.events.some(({ sql, params }) =>
    sql?.includes("has_schema_privilege($1, $2, 'USAGE')") && params?.[1] === schema), true);
  for (const role of ["admin", "ledger"]) {
    await assert.rejects(grantAndVerifyTestRuntimePrivileges(pool, role, schema),
      (error) => error?.code === "POSTGRES_TEST_MIGRATIONS_ROLE_INVALID", role);
  }
  await assert.rejects(grantAndVerifyTestRuntimePrivileges(pool, "primary", "Bad-Schema"),
    (error) => error?.code === "POSTGRES_TEST_MIGRATIONS_PRIMARY_RUNTIME_GRANT_FAILED"
      || error?.code === "POSTGRES_TEST_MIGRATIONS_SCHEMA_INVALID");
});

// The live edge write tier (2026-10-01): the runtime role lacked EXECUTE on
// storage_journal_append and storage_owner_link_ensure, which 0046 revokes
// from PUBLIC, so POST /api/v1/me/telemetry-v12/domain-activate answered 503.
test("runtime function policy: exactly the request-path functions, never an operator entrypoint", () => {
  const signatures = TEST_RUNTIME_PRIMARY_FUNCTIONS.map(functionSignature);
  assert.deepEqual(signatures, ["insert_telemetry_v1_contribution(jsonb)",
    "storage_journal_append(text, text, text, text, text)", "storage_owner_link_ensure(text, text)"]);
  assert.deepEqual(TEST_OPERATOR_ONLY_PRIMARY_FUNCTIONS.map(functionSignature), ["storage_v11_bridge_backfill(integer)",
    "storage_v12_bridge_backfill(integer)", "typed_telemetry_restart_identities()"]);
  const row = (signature, runtimeExecute) => ({ signature, runtime_execute: runtimeExecute });
  const granted = [...signatures.map((signature) => row(signature, true)),
    ...TEST_OPERATOR_ONLY_PRIMARY_FUNCTIONS.map((fn) => row(functionSignature(fn), false))];
  assert.equal(restrictedFunctionsMatchPolicy("primary", granted), true);
  assert.equal(restrictedFunctionsMatchPolicy("primary", [...granted].reverse()), true, "order-insensitive");
  assert.equal(restrictedFunctionsMatchPolicy("ledger", []), false, "the retired ledger role never matches");
  const refused = {
    "the pre-fix grant (v1 admission only)": granted.map((entry) => entry.signature.startsWith("storage_journal_append")
      || entry.signature.startsWith("storage_owner_link_ensure") ? row(entry.signature, false) : entry),
    "an operator-only entrypoint executable": granted.map((entry) => entry.signature.startsWith("storage_v12_bridge_backfill")
      ? row(entry.signature, true) : entry),
    "an operator-only entrypoint missing or PUBLIC": granted.filter(({ signature }) =>
      !signature.startsWith("typed_telemetry_restart_identities")),
    "a runtime function missing or PUBLIC": granted.filter(({ signature }) => !signature.startsWith("storage_owner_link_ensure")),
    "any other non-public function executable": [...granted, row("synthetic_maintenance_backfill(integer)", true)],
    "a duplicate row": [...granted, granted[0]],
    "a malformed row": [...granted, { signature: "x()", runtime_execute: "true" }],
  };
  for (const [label, rows] of Object.entries(refused)) {
    assert.equal(restrictedFunctionsMatchPolicy("primary", rows), false, label);
  }
  assert.equal(restrictedFunctionsMatchPolicy("ledger", [row("insert_telemetry_v1_contribution(jsonb)", true)]), false);
  assert.equal(restrictedFunctionsMatchPolicy("primary", null), false);
});

test("a non-public function the runtime can still execute after the reset fails the migrate run closed", async () => {
  for (const extra of [
    { signature: "synthetic_maintenance_backfill(integer)", runtime_execute: true },
    { signature: "storage_v12_bridge_backfill(integer)", runtime_execute: true },
  ]) {
    const harness = makeHarness(manifest, { fastpath: true, extraPrimaryRestrictedFunctions: [extra] });
    await assert.rejects(runTestMigrations({ env: validFastpathEnv(), profile: FASTPATH_MIGRATION_PROFILE,
      dependencies: harness.dependencies }),
    (error) => error?.code === "POSTGRES_TEST_MIGRATIONS_PRIMARY_RUNTIME_PRIVILEGES_INVALID", extra.signature);
    assert.equal(harness.cleanupCalls, 1);
  }
});
