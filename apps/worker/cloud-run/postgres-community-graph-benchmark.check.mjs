import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { applyPostgresMigrations } from "./postgres-migrations.mjs";
import {
  POSTGRES_COMMUNITY_GRAPH_BENCHMARK_IAM_USER,
  POSTGRES_COMMUNITY_GRAPH_BENCHMARK_JOB,
  POSTGRES_COMMUNITY_GRAPH_BENCHMARK_MIGRATION_ROOT,
  POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES,
  POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROJECT,
  POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SCHEMA_OWNER,
  POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT,
  POSTGRES_COMMUNITY_GRAPH_BENCHMARK_TARGET,
  computePostgresCommunityGraphBenchmarkDigests,
  createPostgresCommunityGraphBenchmarkMetrics,
  parsePostgresCommunityGraphBenchmarkConfig,
  readAttachedCommunityGraphBenchmarkServiceAccount,
  readPostgresCommunityGraphBenchmarkMigrations,
  runPostgresCommunityGraphBenchmark,
  seedPostgresCommunityGraphBenchmark,
  validatePostgresCommunityGraphBenchmarkPreflight,
  verifyPostgresCommunityGraphBenchmarkMigrationReceipt,
} from "./dist/postgres-community-graph-benchmark.mjs";

const EXECUTION = "tibotattle-public-graph-benchmark-00001-abc";
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const EMPTY_TABLES = [
  "storage_source_state",
  "analytics_source_cursors",
  "storage_ingestion_changes",
  "participants",
  "analytics_owner_state",
  "storage_v11_owner_links",
  "input_versions",
  "analytics_owner_results",
  "analytics_publications",
  "analytics_publication_captures",
  "analytics_publication_owner_members",
  "analytics_publication_invalidations",
  "accountless_v12_device_authorizations",
  "community_daily_aggregates",
  "community_daily_allowance_publication_state",
  "community_daily_allowance_preview_cache",
];
const REQUIRED_PRIVILEGES = [
  ["participants", "INSERT"],
  ["analytics_owner_state", "INSERT"],
  ["storage_v11_owner_links", "INSERT"],
  ["input_versions", "INSERT"],
  ["analytics_owner_results", "INSERT"],
  ["storage_source_state", "INSERT"],
  ["analytics_source_cursors", "INSERT"],
  ["publication_state", "UPDATE"],
  ["collection_controls", "UPDATE"],
  ["telemetry_v12_runtime", "UPDATE"],
  ["telemetry_v12_typed_runtime", "UPDATE"],
  ...[
    "storage_source_state",
    "analytics_source_cursors",
    "storage_ingestion_changes",
    "participants",
    "analytics_owner_state",
    "storage_v11_owner_links",
    "input_versions",
    "analytics_owner_results",
    "analytics_publications",
    "analytics_publication_captures",
    "analytics_publication_owner_members",
    "analytics_publication_invalidations",
    "accountless_v12_device_authorizations",
    "publication_state",
    "collection_controls",
    "telemetry_v12_runtime",
    "telemetry_v12_typed_runtime",
    "community_daily_aggregates",
    "community_daily_allowance_publication_state",
    "community_daily_allowance_preview_cache",
  ].map((table) => [table, "SELECT"]),
  ["analytics_publication_captures", "INSERT"],
  ["analytics_publication_owner_members", "INSERT"],
  ["analytics_publications", "INSERT"],
  ["analytics_publications", "UPDATE"],
];

function validEnv(profileName = "10k", overrides = {}) {
  const profile = POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES[profileName];
  return {
    CLOUD_RUN_JOB: POSTGRES_COMMUNITY_GRAPH_BENCHMARK_JOB,
    CLOUD_RUN_EXECUTION: EXECUTION,
    CLOUD_RUN_TASK_INDEX: "0",
    CLOUD_RUN_TASK_COUNT: "1",
    CLOUD_RUN_TASK_ATTEMPT: "0",
    GOOGLE_CLOUD_PROJECT: POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROJECT,
    POSTGRES_GRAPH_BENCHMARK_PROFILE: profileName,
    PRIMARY_INSTANCE_CONNECTION_NAME: POSTGRES_COMMUNITY_GRAPH_BENCHMARK_TARGET.instanceConnectionName,
    PRIMARY_DATABASE: POSTGRES_COMMUNITY_GRAPH_BENCHMARK_TARGET.database,
    PRIMARY_SCHEMA: profile.schema,
    POSTGRES_IAM_USER: POSTGRES_COMMUNITY_GRAPH_BENCHMARK_IAM_USER,
    ...overrides,
  };
}

function fakeMigrations() {
  return Array.from({ length: 46 }, (_, index) => ({
    version: index + 1,
    name: `${String(index + 1).padStart(4, "0")}_${index === 38
      ? "analytics_applied_projection_v1" : index === 39
        ? "historical_transport_headers" : index === 40
          ? "accountless_history_retention" : index === 41
            ? "accountless_history_retention_import" : index === 42
              ? "accountless_history_d1_import" : index === 43
                ? "accountless_import_claim_erasure" : index === 44
                  ? "accountless_v12_history_retention" : index === 45
                    ? "owner_journal_authority" : `test_${index + 1}`}.sql`,
    sha256: (index + 1).toString(16).padStart(64, "0"),
  }));
}

function migrationPool(rows, schema = POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES["10k"].schema) {
  const statements = [];
  let releases = 0;
  return {
    statements,
    get releases() { return releases; },
    async connect() {
      return {
        async query(sql) {
          statements.push(sql);
          if (sql.includes(`FROM ${JSON.stringify(schema)}.${JSON.stringify("_tibotattle_migration_history")}`)) {
            return { rows, rowCount: rows.length };
          }
          return { rows: [], rowCount: 0 };
        },
        release() { releases += 1; },
      };
    },
  };
}

function validPreflightRow() {
  const row = {
    database_name: "tibotattle",
    database_user: POSTGRES_COMMUNITY_GRAPH_BENCHMARK_IAM_USER,
    server_version_num: 170005,
    schema_owner: POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SCHEMA_OWNER,
    runtime_can_create_schema: false,
    runtime_can_use_schema: true,
    runtime_is_schema_owner_member: false,
    runtime_can_create_temp: true,
    migration_history_owner: POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SCHEMA_OWNER,
    runtime_can_read_migration_history: true,
    runtime_can_insert_migration_history: false,
    runtime_can_update_migration_history: false,
    runtime_can_delete_migration_history: false,
    publication_state: "ready",
    policy_revision: "1",
    collection_revision: "1",
    control_state: "contained",
    collection_flags_disabled: true,
    collection_reason_empty: true,
    telemetry_v12_state: "staged",
    telemetry_v12_revision: "0",
    telemetry_v12_typed_state: "staged",
    telemetry_v12_typed_policy_revision: "1",
  };
  for (const table of EMPTY_TABLES) row[`${table}_count`] = "0";
  for (const [table, privilege] of REQUIRED_PRIVILEGES) row[`${table}_${privilege.toLowerCase()}`] = true;
  return row;
}

test("isolated 100k diagnostic profiles keep exact matched digests with distinct schemas", () => {
  assert.deepEqual(computePostgresCommunityGraphBenchmarkDigests("10k"), {
    workloadDigest: POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES["10k"].workloadDigest,
    sourceDigest: "dcab757ec3e6be58ca2a881586f9a73642ddb6e66e161445587369f288500056",
  });
  assert.deepEqual(computePostgresCommunityGraphBenchmarkDigests("100k"), {
    workloadDigest: POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES["100k"].workloadDigest,
    sourceDigest: POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES["100k"].sourceDigest,
  });
  const matched100k = POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES["100k"];
  const insights100k = POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES["100k-insights"];
  assert.deepEqual(computePostgresCommunityGraphBenchmarkDigests("100k-insights"), {
    workloadDigest: matched100k.workloadDigest,
    sourceDigest: matched100k.sourceDigest,
  });
  assert.deepEqual({
    members: insights100k.members,
    workloadDigest: insights100k.workloadDigest,
    sourceDigest: insights100k.sourceDigest,
    outputDigest: insights100k.outputDigest,
  }, {
    members: matched100k.members,
    workloadDigest: matched100k.workloadDigest,
    sourceDigest: matched100k.sourceDigest,
    outputDigest: matched100k.outputDigest,
  });
  assert.notEqual(insights100k.schema, matched100k.schema);
  assert.equal(insights100k.schema, "tibotattle_graph_benchmark_100k_insights_20260925");
  const paged100k = POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES["100k-paged"];
  assert.deepEqual(computePostgresCommunityGraphBenchmarkDigests("100k-paged"), {
    workloadDigest: matched100k.workloadDigest,
    sourceDigest: matched100k.sourceDigest,
  });
  assert.deepEqual({
    members: paged100k.members,
    workloadDigest: paged100k.workloadDigest,
    sourceDigest: paged100k.sourceDigest,
    outputDigest: paged100k.outputDigest,
  }, {
    members: matched100k.members,
    workloadDigest: matched100k.workloadDigest,
    sourceDigest: matched100k.sourceDigest,
    outputDigest: matched100k.outputDigest,
  });
  assert.notEqual(paged100k.schema, matched100k.schema);
  assert.notEqual(paged100k.schema, insights100k.schema);
  assert.equal(paged100k.schema, "tibotattle_graph_benchmark_100k_paged_20260925");
  const readpaged100k = POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES["100k-readpaged"];
  assert.deepEqual(computePostgresCommunityGraphBenchmarkDigests("100k-readpaged"), {
    workloadDigest: matched100k.workloadDigest,
    sourceDigest: matched100k.sourceDigest,
  });
  assert.deepEqual({
    members: readpaged100k.members,
    workloadDigest: readpaged100k.workloadDigest,
    sourceDigest: readpaged100k.sourceDigest,
    outputDigest: readpaged100k.outputDigest,
  }, {
    members: matched100k.members,
    workloadDigest: matched100k.workloadDigest,
    sourceDigest: matched100k.sourceDigest,
    outputDigest: matched100k.outputDigest,
  });
  assert.notEqual(readpaged100k.schema, matched100k.schema);
  assert.notEqual(readpaged100k.schema, paged100k.schema);
  assert.equal(readpaged100k.schema, "tibotattle_graph_benchmark_100k_readpaged_20260925");
  const readindexed100k = POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES["100k-readindexed"];
  assert.deepEqual(computePostgresCommunityGraphBenchmarkDigests("100k-readindexed"), {
    workloadDigest: matched100k.workloadDigest,
    sourceDigest: matched100k.sourceDigest,
  });
  assert.deepEqual({
    members: readindexed100k.members,
    workloadDigest: readindexed100k.workloadDigest,
    sourceDigest: readindexed100k.sourceDigest,
    outputDigest: readindexed100k.outputDigest,
  }, {
    members: matched100k.members,
    workloadDigest: matched100k.workloadDigest,
    sourceDigest: matched100k.sourceDigest,
    outputDigest: matched100k.outputDigest,
  });
  assert.notEqual(readindexed100k.schema, matched100k.schema);
  assert.notEqual(readindexed100k.schema, readpaged100k.schema);
  assert.equal(readindexed100k.schema, "tibotattle_graph_benchmark_100k_readindexed_20260925");
  const batched100k = POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES["100k-batched"];
  assert.deepEqual(computePostgresCommunityGraphBenchmarkDigests("100k-batched"), {
    workloadDigest: matched100k.workloadDigest,
    sourceDigest: matched100k.sourceDigest,
  });
  assert.deepEqual({
    members: batched100k.members,
    workloadDigest: batched100k.workloadDigest,
    sourceDigest: batched100k.sourceDigest,
    outputDigest: batched100k.outputDigest,
  }, {
    members: matched100k.members,
    workloadDigest: matched100k.workloadDigest,
    sourceDigest: matched100k.sourceDigest,
    outputDigest: matched100k.outputDigest,
  });
  assert.notEqual(batched100k.schema, matched100k.schema);
  assert.notEqual(batched100k.schema, readindexed100k.schema);
  assert.equal(batched100k.schema, "tibotattle_graph_benchmark_100k_batched_20260925");
  assert.equal(POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES["10k"].members, 10_000);
  assert.equal(POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES["100k"].members, 100_000);
});

test("configuration pins one single-attempt primary test Job, schema and runtime identity", () => {
  const config = parsePostgresCommunityGraphBenchmarkConfig(
    validEnv(), POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT,
  );
  assert.equal(config.profile, "10k");
  assert.equal(config.schema, "tibotattle_graph_benchmark_10k_20260925");
  assert.equal(config.iamUser, POSTGRES_COMMUNITY_GRAPH_BENCHMARK_IAM_USER);
  const insightsConfig = parsePostgresCommunityGraphBenchmarkConfig(
    validEnv("100k-insights"), POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT,
  );
  assert.equal(insightsConfig.profile, "100k-insights");
  assert.equal(insightsConfig.members, 100_000);
  assert.equal(insightsConfig.schema, "tibotattle_graph_benchmark_100k_insights_20260925");
  assert.throws(() => parsePostgresCommunityGraphBenchmarkConfig(
    validEnv("100k-insights", { PRIMARY_SCHEMA: "tibotattle_graph_benchmark_100k_20260925" }),
    POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT,
  ), (error) => error?.code === "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_TARGET_INVALID");
  const pagedConfig = parsePostgresCommunityGraphBenchmarkConfig(
    validEnv("100k-paged"), POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT,
  );
  assert.equal(pagedConfig.profile, "100k-paged");
  assert.equal(pagedConfig.members, 100_000);
  assert.equal(pagedConfig.schema, "tibotattle_graph_benchmark_100k_paged_20260925");
  assert.throws(() => parsePostgresCommunityGraphBenchmarkConfig(
    validEnv("100k-paged", { PRIMARY_SCHEMA: "tibotattle_graph_benchmark_100k_20260925" }),
    POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT,
  ), (error) => error?.code === "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_TARGET_INVALID");
  const readpagedConfig = parsePostgresCommunityGraphBenchmarkConfig(
    validEnv("100k-readpaged"), POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT,
  );
  assert.equal(readpagedConfig.profile, "100k-readpaged");
  assert.equal(readpagedConfig.members, 100_000);
  assert.equal(readpagedConfig.schema, "tibotattle_graph_benchmark_100k_readpaged_20260925");
  assert.throws(() => parsePostgresCommunityGraphBenchmarkConfig(
    validEnv("100k-readpaged", { PRIMARY_SCHEMA: "tibotattle_graph_benchmark_100k_20260925" }),
    POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT,
  ), (error) => error?.code === "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_TARGET_INVALID");
  const readindexedConfig = parsePostgresCommunityGraphBenchmarkConfig(
    validEnv("100k-readindexed"), POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT,
  );
  assert.equal(readindexedConfig.profile, "100k-readindexed");
  assert.equal(readindexedConfig.members, 100_000);
  assert.equal(readindexedConfig.schema, "tibotattle_graph_benchmark_100k_readindexed_20260925");
  assert.throws(() => parsePostgresCommunityGraphBenchmarkConfig(
    validEnv("100k-readindexed", { PRIMARY_SCHEMA: "tibotattle_graph_benchmark_100k_20260925" }),
    POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT,
  ), (error) => error?.code === "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_TARGET_INVALID");
  const batchedConfig = parsePostgresCommunityGraphBenchmarkConfig(
    validEnv("100k-batched"), POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT,
  );
  assert.equal(batchedConfig.profile, "100k-batched");
  assert.equal(batchedConfig.members, 100_000);
  assert.equal(batchedConfig.schema, "tibotattle_graph_benchmark_100k_batched_20260925");
  assert.throws(() => parsePostgresCommunityGraphBenchmarkConfig(
    validEnv("100k-batched", { PRIMARY_SCHEMA: "tibotattle_graph_benchmark_100k_20260925" }),
    POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT,
  ), (error) => error?.code === "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_TARGET_INVALID");
  for (const overrides of [
    { CLOUD_RUN_JOB: "other-job" },
    { GOOGLE_CLOUD_PROJECT: "other-project" },
    { CLOUD_RUN_TASK_COUNT: "2" },
    { CLOUD_RUN_TASK_ATTEMPT: "1" },
    { K_SERVICE: "accidental-service" },
    { POSTGRES_GRAPH_BENCHMARK_PROFILE: "other" },
    { PRIMARY_INSTANCE_CONNECTION_NAME: "other:us-east1:db" },
    { PRIMARY_DATABASE: "production" },
    { PRIMARY_SCHEMA: "tibotattle" },
    { POSTGRES_IAM_USER: "other@tibotattle.iam" },
    { LEDGER_SCHEMA: "tibotattle_ledger" },
  ]) {
    assert.throws(() => parsePostgresCommunityGraphBenchmarkConfig(
      validEnv("10k", overrides), POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT,
    ));
  }
  assert.throws(() => parsePostgresCommunityGraphBenchmarkConfig(
    validEnv("100k"), "other@tibotattle.iam.gserviceaccount.com",
  ), (error) => error?.code === "CLOUD_RUN_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT_INVALID");
});

test("metadata service-account read checks Google marker and exact attached identity", async () => {
  let request;
  const email = await readAttachedCommunityGraphBenchmarkServiceAccount({
    async fetchImpl(url, options) {
      request = { url, options };
      return {
        status: 200,
        headers: { get: (name) => name === "Metadata-Flavor" ? "Google" : null },
        async text() { return POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT; },
      };
    },
  });
  assert.equal(email, POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT);
  assert.equal(request.options.headers["Metadata-Flavor"], "Google");
  assert.equal(request.options.redirect, "error");
  await assert.rejects(readAttachedCommunityGraphBenchmarkServiceAccount({
    async fetchImpl() {
      return { status: 200, headers: { get: () => null }, async text() {
        return POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT;
      } };
    },
  }), (error) => error?.code === "CLOUD_RUN_COMMUNITY_GRAPH_BENCHMARK_METADATA_UNAVAILABLE");
});

test("database preflight requires PG17, migrator ownership, grants and a pristine profile schema", () => {
  const config = parsePostgresCommunityGraphBenchmarkConfig(
    validEnv(), POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT,
  );
  assert.deepEqual(validatePostgresCommunityGraphBenchmarkPreflight(validPreflightRow(), config), {
    pristine: true,
    serverMajor: 17,
  });
  for (const overrides of [
    { database_user: "other@tibotattle.iam" },
    { server_version_num: 160000 },
    { schema_owner: "tibotattle-test-runtime@tibotattle.iam" },
    { migration_history_owner: "tibotattle-test-runtime@tibotattle.iam" },
    { runtime_can_create_schema: true },
    { runtime_can_use_schema: false },
    { runtime_is_schema_owner_member: true },
    { runtime_can_create_temp: false },
    { runtime_can_read_migration_history: false },
    { runtime_can_insert_migration_history: true },
    { participants_count: "1" },
    { participants_insert: false },
    { analytics_publications_update: false },
    { control_state: "operational" },
  ]) {
    assert.throws(() => validatePostgresCommunityGraphBenchmarkPreflight(
      { ...validPreflightRow(), ...overrides }, config,
    ));
  }
});

test("migration receipt is compared row-for-row and fails closed on drift", async () => {
  const migrations = fakeMigrations();
  const rows = migrations.map(({ version, name, sha256 }) => ({
    version, name, checksum_sha256: sha256,
  }));
  const pool = migrationPool(rows);
  const receipt = await verifyPostgresCommunityGraphBenchmarkMigrationReceipt(
    pool, POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES["10k"].schema, migrations,
  );
  assert.equal(receipt.count, 46);
  assert.equal(receipt.tail, "0046_owner_journal_authority.sql");
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(pool.releases, 1);
  assert.ok(pool.statements.some((sql) => sql.includes('ORDER BY version')));

  const insightsSchema = POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES["100k-insights"].schema;
  const insightsPool = migrationPool(rows, insightsSchema);
  const insightsReceipt = await verifyPostgresCommunityGraphBenchmarkMigrationReceipt(
    insightsPool, insightsSchema, migrations,
  );
  assert.equal(insightsReceipt.count, 46);
  assert.equal(insightsReceipt.tail, "0046_owner_journal_authority.sql");
  assert.match(insightsReceipt.sha256, /^[a-f0-9]{64}$/u);

  const pagedSchema = POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES["100k-paged"].schema;
  const pagedPool = migrationPool(rows, pagedSchema);
  const pagedReceipt = await verifyPostgresCommunityGraphBenchmarkMigrationReceipt(
    pagedPool, pagedSchema, migrations,
  );
  assert.equal(pagedReceipt.count, 46);
  assert.equal(pagedReceipt.tail, "0046_owner_journal_authority.sql");
  const readpagedSchema = POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES["100k-readpaged"].schema;
  const readpagedPool = migrationPool(rows, readpagedSchema);
  const readpagedReceipt = await verifyPostgresCommunityGraphBenchmarkMigrationReceipt(
    readpagedPool, readpagedSchema, migrations,
  );
  assert.equal(readpagedReceipt.count, 46);
  assert.equal(readpagedReceipt.tail, "0046_owner_journal_authority.sql");
  assert.match(readpagedReceipt.sha256, /^[a-f0-9]{64}$/u);
  const readindexedSchema = POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES["100k-readindexed"].schema;
  const readindexedPool = migrationPool(rows, readindexedSchema);
  const readindexedReceipt = await verifyPostgresCommunityGraphBenchmarkMigrationReceipt(
    readindexedPool, readindexedSchema, migrations,
  );
  assert.equal(readindexedReceipt.count, 46);
  assert.equal(readindexedReceipt.tail, "0046_owner_journal_authority.sql");
  assert.match(readindexedReceipt.sha256, /^[a-f0-9]{64}$/u);
  const batchedSchema = POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES["100k-batched"].schema;
  const batchedPool = migrationPool(rows, batchedSchema);
  const batchedReceipt = await verifyPostgresCommunityGraphBenchmarkMigrationReceipt(
    batchedPool, batchedSchema, migrations,
  );
  assert.equal(batchedReceipt.count, 46);
  assert.equal(batchedReceipt.tail, "0046_owner_journal_authority.sql");
  assert.match(batchedReceipt.sha256, /^[a-f0-9]{64}$/u);
  assert.match(pagedReceipt.sha256, /^[a-f0-9]{64}$/u);

  const drifted = migrationPool(rows.map((row, index) => index === 4
    ? { ...row, checksum_sha256: "f".repeat(64) } : row));
  await assert.rejects(
    verifyPostgresCommunityGraphBenchmarkMigrationReceipt(
      drifted, POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES["10k"].schema, migrations,
    ),
    (error) => error?.code === "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_MIGRATION_RECEIPT_INVALID",
  );
});

test("bundled migration loader pins the image migration directory", async () => {
  let options;
  const migrations = await readPostgresCommunityGraphBenchmarkMigrations({
    async readMigrations(actual) { options = actual; return fakeMigrations(); },
  });
  assert.equal(migrations.length, 46);
  assert.deepEqual(options, {
    role: "primary",
    rootDirectory: POSTGRES_COMMUNITY_GRAPH_BENCHMARK_MIGRATION_ROOT,
  });
  assert.equal(POSTGRES_COMMUNITY_GRAPH_BENCHMARK_MIGRATION_ROOT,
    "/app/apps/worker/postgres/migrations");
});

test("query receipt metrics count pages and connections without retaining SQL or row content", async () => {
  let releaseCount = 0;
  const rawPool = {
    totalCount: 1,
    async connect() {
      return {
        async query(sql) {
          if (sql.includes(".analytics_publication_owner_members member")
              && sql.includes("member.owner_digest > $4::text")) {
            return { rows: [{ synthetic: "x" }], rowCount: 1 };
          }
          if (sql.includes("WITH graph_result_page AS MATERIALIZED")) {
            return { rows: [{ updated_count: "1", inserted_count: "1" }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release() { releaseCount += 1; },
      };
    },
  };
  const metrics = createPostgresCommunityGraphBenchmarkMetrics(rawPool);
  metrics.setPhase("readback");
  const client = await metrics.pool.connect();
  await client.query(`WITH page AS MATERIALIZED (
    SELECT member.owner_digest FROM synthetic.analytics_publication_owner_members member
    WHERE member.owner_digest > $4::text ORDER BY member.owner_digest LIMIT $5::integer
  ) SELECT page.owner_digest FROM page`);
  metrics.setPhase("publish");
  await client.query(`WITH graph_result_page AS MATERIALIZED (SELECT 'digest' AS owner_digest),
    updated_members AS (UPDATE pg_temp.pg_community_graph_members SET result_sha256='hash'
      FROM graph_result_page WHERE true RETURNING owner_digest),
    inserted_capacities AS (INSERT INTO pg_temp.pg_community_graph_capacities(owner_digest, model_id, capacity)
      SELECT owner_digest, 'model', 1 FROM graph_result_page RETURNING owner_digest)
    SELECT (SELECT count(*) FROM updated_members), (SELECT count(*) FROM inserted_capacities)`);
  await client.query(`WITH page AS MATERIALIZED (SELECT 'synthetic'::text AS owner_digest),
    inserted AS (INSERT INTO synthetic.analytics_publication_owner_members(owner_digest)
      SELECT owner_digest FROM page ON CONFLICT DO NOTHING RETURNING owner_digest)
    SELECT count(*) FROM inserted`);
  client.release();
  const snapshot = metrics.snapshot();
  assert.equal(releaseCount, 1);
  assert.equal(snapshot.queryCalls, 3);
  assert.equal(snapshot.rowsRead, 2);
  assert.equal(snapshot.pages.publicationMemberReadPages, 1);
  assert.equal(snapshot.pages.publicationMemberWriteQueries, 1);
  assert.equal(snapshot.pages.resultPageApplyQueries, 1);
  assert.equal(snapshot.queries["publish.result_page_apply"].calls, 1);
  assert.equal(snapshot.queries["publish.publication_member_write"].calls, 1);
  assert.equal(snapshot.connections.poolCheckouts, 1);
  assert.equal(snapshot.connections.maxCheckedOut, 1);
  assert.equal(snapshot.connections.checkedOutAtEnd, 0);
  assert.equal(snapshot.connections.poolTotalCreated, 1);
  assert.ok(!JSON.stringify(snapshot).includes("synthetic_cursor"));
  assert.ok(!JSON.stringify(snapshot).includes('"x"'));
});

test("invalid benchmark target is rejected before metadata, connector or database use", async () => {
  let metadataCalls = 0;
  let connectorCalls = 0;
  await assert.rejects(runPostgresCommunityGraphBenchmark({
    env: validEnv("10k", { PRIMARY_SCHEMA: "tibotattle" }),
    dependencies: {
      async readServiceAccountEmail() { metadataCalls += 1; return POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT; },
      createConnector() { connectorCalls += 1; return {}; },
    },
  }), (error) => error?.code === "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_TARGET_INVALID");
  assert.equal(metadataCalls, 1);
  assert.equal(connectorCalls, 0);
});

test("benchmark failures expose only a bounded phase and safe code", async () => {
  await assert.rejects(runPostgresCommunityGraphBenchmark({
    env: validEnv(),
    dependencies: {
      async readServiceAccountEmail() { return POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT; },
      createConnector() { return { getOptions() {} }; },
      async createPool() { throw new Error("provider detail must not escape"); },
      async closeResources() {},
    },
  }), (error) => {
    assert.equal(error?.code, "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_FAILED");
    assert.equal(error?.phase, "connection");
    assert.equal(error?.message, "POSTGRES_COMMUNITY_GRAPH_BENCHMARK_FAILED");
    return !String(error).includes("provider detail");
  });
});

test("PG17 synthetic seed relies on the participant input-version trigger", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65535);
  const link = await lstat(PG_TEST_SOCKET);
  const host = await realpath(PG_TEST_SOCKET);
  const metadata = await stat(host);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(host.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());

  const pool = new pg.Pool({
    host,
    port: PG_TEST_PORT,
    user: process.env.PG_TEST_USER || "postgres",
    password: process.env.PG_TEST_PASSWORD || "synthetic-local-only",
    database: process.env.PG_TEST_DATABASE || "postgres",
    application_name: "pg-community-graph-benchmark-seed-check",
    ssl: false,
    max: 2,
    connectionTimeoutMillis: 5_000,
  });
  const locality = await pool.query("SELECT inet_server_addr() AS address, version() AS version");
  assert.equal(locality.rows[0]?.address, null, "qualification requires a local Unix socket");
  assert.match(locality.rows[0]?.version ?? "", /^PostgreSQL 17\./u);

  const schema = `benchmark_seed_${randomBytes(6).toString("hex")}`;
  const sqlSchema = `"${schema}"`;
  try {
    await pool.query(`CREATE SCHEMA ${sqlSchema}`);
    await applyPostgresMigrations({ role: "primary", schema, pool });
    const parsed = parsePostgresCommunityGraphBenchmarkConfig(
      validEnv(), POSTGRES_COMMUNITY_GRAPH_BENCHMARK_SERVICE_ACCOUNT,
    );
    const localSeedConfig = Object.freeze({ ...parsed, schema });
    const seedPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, values) {
            if (typeof sql === "string" && sql.includes("current_database() AS database_name")) {
              return { rows: [validPreflightRow()], rowCount: 1 };
            }
            return client.query(sql, values);
          },
          release: client.release.bind(client),
        };
      },
    };
    await seedPostgresCommunityGraphBenchmark(seedPool, localSeedConfig);
    const counts = await pool.query(`SELECT
      (SELECT count(*)::int FROM ${sqlSchema}.participants) AS participants,
      (SELECT count(*)::int FROM ${sqlSchema}.input_versions) AS input_versions,
      (SELECT count(*)::int FROM ${sqlSchema}.input_versions WHERE revision<>0) AS changed_input_versions`);
    assert.deepEqual(counts.rows[0], {
      participants: 10_000,
      input_versions: 10_000,
      changed_input_versions: 0,
    });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${sqlSchema} CASCADE`);
    await pool.end();
  }
});
