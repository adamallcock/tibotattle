import assert from "node:assert/strict";
import test from "node:test";
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
  validatePostgresCommunityGraphBenchmarkPreflight,
  verifyPostgresCommunityGraphBenchmarkMigrationReceipt,
} from "./dist/postgres-community-graph-benchmark.mjs";

const EXECUTION = "tibotattle-public-graph-benchmark-00001-abc";
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
  return Array.from({ length: 37 }, (_, index) => ({
    version: index + 1,
    name: `${String(index + 1).padStart(4, "0")}_${index === 36 ? "community_daily_publications" : `test_${index + 1}`}.sql`,
    sha256: (index + 1).toString(16).padStart(64, "0"),
  }));
}

function migrationPool(rows) {
  const statements = [];
  let releases = 0;
  return {
    statements,
    get releases() { return releases; },
    async connect() {
      return {
        async query(sql) {
          statements.push(sql);
          if (sql.includes("FROM \"tibotattle_graph_benchmark_10k_20260925\".\"_tibotattle_migration_history\"")) {
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

test("both synthetic profiles keep the exact matched local workload and source digests", () => {
  assert.deepEqual(computePostgresCommunityGraphBenchmarkDigests("10k"), {
    workloadDigest: POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES["10k"].workloadDigest,
    sourceDigest: "dcab757ec3e6be58ca2a881586f9a73642ddb6e66e161445587369f288500056",
  });
  assert.deepEqual(computePostgresCommunityGraphBenchmarkDigests("100k"), {
    workloadDigest: POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES["100k"].workloadDigest,
    sourceDigest: POSTGRES_COMMUNITY_GRAPH_BENCHMARK_PROFILES["100k"].sourceDigest,
  });
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
  assert.equal(receipt.count, 37);
  assert.equal(receipt.tail, "0037_community_daily_publications.sql");
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(pool.releases, 1);
  assert.ok(pool.statements.some((sql) => sql.includes('ORDER BY version')));

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
  assert.equal(migrations.length, 37);
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
          if (sql.startsWith("FETCH FORWARD")) return { rows: [{ synthetic: "x" }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
        release() { releaseCount += 1; },
      };
    },
  };
  const metrics = createPostgresCommunityGraphBenchmarkMetrics(rawPool);
  metrics.setPhase("readback");
  const client = await metrics.pool.connect();
  await client.query("FETCH FORWARD 4096 FROM synthetic_cursor");
  client.release();
  const snapshot = metrics.snapshot();
  assert.equal(releaseCount, 1);
  assert.equal(snapshot.queryCalls, 1);
  assert.equal(snapshot.rowsRead, 1);
  assert.equal(snapshot.pages.publicationMemberReadPages, 1);
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
