import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_IAM_USER,
  POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_JOB,
  POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_PROFILE,
  POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_SCHEMA,
  POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_SERVICE_ACCOUNT,
  POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_TARGET,
  parsePostgresCommunityGraphReadbackDiagnosticConfig,
  postgresCommunityGraphMemberReadbackPageSelect,
  readAttachedCommunityGraphReadbackDiagnosticServiceAccount,
  runPostgresCommunityGraphReadbackDiagnostic,
} from "./dist/postgres-community-graph-readback-diagnostic.mjs";

const EXECUTION = "tibotattle-public-graph-readback-diagnostic-00001-abc";
const SOURCE_ID = "synthetic-community-source";
const DAY = "2026-09-23";
const GENERATION = "a".repeat(64);
const MIGRATION_TAIL = "0058_owner_journal_emitter_head_precheck.sql";

function validEnv(overrides = {}) {
  return {
    CLOUD_RUN_JOB: POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_JOB,
    CLOUD_RUN_EXECUTION: EXECUTION,
    CLOUD_RUN_TASK_INDEX: "0",
    CLOUD_RUN_TASK_COUNT: "1",
    CLOUD_RUN_TASK_ATTEMPT: "0",
    GOOGLE_CLOUD_PROJECT: "tibotattle",
    POSTGRES_GRAPH_BENCHMARK_PROFILE: POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_PROFILE,
    PRIMARY_INSTANCE_CONNECTION_NAME: POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_TARGET.instanceConnectionName,
    PRIMARY_DATABASE: POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_TARGET.database,
    PRIMARY_SCHEMA: POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_SCHEMA,
    POSTGRES_IAM_USER: POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_IAM_USER,
    ...overrides,
  };
}

function fakeMigrations() {
  return Array.from({ length: 58 }, (_, index) => ({
    version: index + 1,
    name: `${String(index + 1).padStart(4, "0")}_${index === 38
      ? "analytics_applied_projection_v1" : index === 39
        ? "historical_transport_headers" : index === 40
          ? "accountless_history_retention" : index === 41
            ? "accountless_history_retention_import" : index === 42
              ? "accountless_history_d1_import" : index === 43
                ? "accountless_import_claim_erasure" : index === 44
                  ? "accountless_v12_history_retention" : index === 45
                    ? "owner_journal_authority" : index === 57
                      ? "owner_journal_emitter_head_precheck" : `test_${index + 1}`}.sql`,
    sha256: (index + 1).toString(16).padStart(64, "0"),
  }));
}

function explainDocument() {
  return [{
    Plan: {
      "Node Type": "Sort",
      "Plan Rows": 100_000,
      "Plan Width": 176,
      "Startup Cost": 1200.5,
      "Total Cost": 4500.25,
      "Sort Key": ["secret_owner_digest"],
      "Relation Name": "private_member_table",
      Plans: [{
        "Node Type": "Nested Loop",
        "Join Type": "Left",
        "Plan Rows": 100_000,
        "Plan Width": 176,
        "Startup Cost": 0.5,
        "Total Cost": 2000,
        Plans: [
          { "Node Type": "Index Scan", "Index Name": "private_index", "Plan Rows": 100_000,
            "Plan Width": 96, "Startup Cost": 0.2, "Total Cost": 800 },
          { "Node Type": "Index Only Scan", "Plan Rows": 1, "Plan Width": 80,
            "Startup Cost": 0.1, "Total Cost": 0.2 },
        ],
      }],
    },
  }];
}

function makeHarness({
  targetRow = undefined,
  migrations = fakeMigrations(),
  migrationReceiptRows = undefined,
  plan = explainDocument(),
} = {}) {
  const statements = [];
  const parameters = [];
  const target = targetRow ?? {
    database_name: "tibotattle",
    database_user: POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_IAM_USER,
    server_version_num: 170011,
    schema_owner: "tibotattle-test-migrator@tibotattle.iam",
    generation: GENERATION,
    cohort_digest: GENERATION,
    payload_sha256: "b".repeat(64),
    expected_members: "100000",
  };
  let checkouts = 0;
  let releases = 0;
  let closed = false;
  const pool = {
    async connect() {
      checkouts += 1;
      return {
        async query(sql, values) {
          statements.push(sql);
          parameters.push(values);
          if (sql.includes('"_tibotattle_migration_history"')) {
            return {
              rows: (migrationReceiptRows ?? migrations).map(({ version, name, sha256 }) => ({
                version, name, checksum_sha256: sha256,
              })),
            };
          }
          if (sql.includes("FROM pg_namespace namespace")) return { rows: [target] };
          if (sql.startsWith("EXPLAIN ")) return { rows: [{ "QUERY PLAN": plan }] };
          return { rows: [], rowCount: null };
        },
        release() { releases += 1; },
      };
    },
  };
  const dependencies = {
    async readServiceAccountEmail() { return POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_SERVICE_ACCOUNT; },
    createConnector() { return { getOptions() {} }; },
    async createPool(options) {
      assert.equal(options.instanceConnectionName, POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_TARGET.instanceConnectionName);
      assert.equal(options.database, "tibotattle");
      assert.equal(options.user, POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_IAM_USER);
      assert.equal(options.max, 1);
      return pool;
    },
    async readMigrations(options) {
      assert.deepEqual(options, {
        role: "primary",
        rootDirectory: "/app/apps/worker/postgres/migrations",
      });
      return migrations;
    },
    async closeResources({ pools, connector }) {
      assert.deepEqual(pools, [pool]);
      assert.ok(connector);
      closed = true;
    },
  };
  return {
    statements, parameters, dependencies,
    get checkouts() { return checkouts; },
    get releases() { return releases; },
    get closed() { return closed; },
  };
}

test("readback diagnostic accepts only the exact single-task isolated target", () => {
  assert.deepEqual(parsePostgresCommunityGraphReadbackDiagnosticConfig(
    validEnv(), POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_SERVICE_ACCOUNT,
  ), {
    job: POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_JOB,
    profile: "100k-readindexed",
    schema: "tibotattle_graph_benchmark_100k_readindexed_20260925",
    project: "tibotattle",
    serviceAccount: POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_SERVICE_ACCOUNT,
    iamUser: POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_IAM_USER,
    instanceConnectionName: POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_TARGET.instanceConnectionName,
    database: "tibotattle",
  });
  for (const overrides of [
    { CLOUD_RUN_JOB: "other-job" },
    { CLOUD_RUN_TASK_COUNT: "2" },
    { CLOUD_RUN_TASK_ATTEMPT: "1" },
    { GOOGLE_CLOUD_PROJECT: "other-project" },
    { K_SERVICE: "not-a-job" },
    { POSTGRES_GRAPH_BENCHMARK_PROFILE: "100k" },
    { PRIMARY_SCHEMA: "tibotattle" },
    { PRIMARY_DATABASE: "other" },
    { PRIMARY_INSTANCE_CONNECTION_NAME: "other:us-east1:instance" },
    { POSTGRES_IAM_USER: "other@tibotattle.iam" },
    { LEDGER_SCHEMA: "ledger" },
  ]) {
    assert.throws(() => parsePostgresCommunityGraphReadbackDiagnosticConfig(
      validEnv(overrides), POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_SERVICE_ACCOUNT,
    ));
  }
  assert.throws(() => parsePostgresCommunityGraphReadbackDiagnosticConfig(
    validEnv(), "tibotattle-test-migrator@tibotattle.iam.gserviceaccount.com",
  ), /CLOUD_RUN_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_SERVICE_ACCOUNT_INVALID/);
});

test("metadata identity requires the Google marker and exact diagnostic service account", async () => {
  const email = await readAttachedCommunityGraphReadbackDiagnosticServiceAccount({
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email");
      assert.equal(options.headers["Metadata-Flavor"], "Google");
      return new Response(POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_SERVICE_ACCOUNT, {
        status: 200,
        headers: { "Metadata-Flavor": "Google" },
      });
    },
  });
  assert.equal(email, POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_SERVICE_ACCOUNT);
  await assert.rejects(readAttachedCommunityGraphReadbackDiagnosticServiceAccount({
    fetchImpl: async () => new Response(POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_SERVICE_ACCOUNT, { status: 200 }),
  }), /CLOUD_RUN_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_METADATA_UNAVAILABLE/);
});

test("diagnostic explains the production read query in a bounded read-only plan and emits no identifiers", async () => {
  const harness = makeHarness();
  const receipt = await runPostgresCommunityGraphReadbackDiagnostic({
    env: validEnv(), dependencies: harness.dependencies,
  });
  const productionSelect = postgresCommunityGraphMemberReadbackPageSelect(
    POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_SCHEMA,
  );
  const explainStatementIndex = harness.statements.findIndex((sql) => sql.startsWith("EXPLAIN "));
  const explainSql = harness.statements[explainStatementIndex];
  assert.equal(explainSql,
    `EXPLAIN (FORMAT JSON, COSTS TRUE, VERBOSE FALSE, SETTINGS TRUE) ${productionSelect}`);
  assert.doesNotMatch(explainSql, /\bANALYZE\b/u);
  assert.ok(harness.statements.includes("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"));
  assert.ok(harness.statements.includes("SET LOCAL statement_timeout='15000ms'"));
  assert.deepEqual(harness.parameters[explainStatementIndex], [SOURCE_ID, DAY, GENERATION, "", 4_096]);
  assert.equal(harness.checkouts, 3);
  assert.equal(harness.releases, 3);
  assert.equal(harness.closed, true);
  assert.deepEqual(receipt, {
    schemaVersion: "postgres-community-graph-readback-explain-v1",
    status: "ok",
    profile: "100k-readindexed",
    memberCount: 100_000,
    migrationReceipt: { count: 58, tail: MIGRATION_TAIL },
    explainElapsedMilliseconds: receipt.explainElapsedMilliseconds,
    statementSha256: createHash("sha256").update(explainSql).digest("hex"),
    planSummary: {
      nodeCount: 4,
      sortNodeCount: 1,
      indexNodeCount: 2,
      root: {
        nodeType: "Sort",
        planRows: 100_000,
        planWidth: 176,
        startupCost: 1200.5,
        totalCost: 4500.25,
        children: [{
          nodeType: "Nested Loop",
          planRows: 100_000,
          planWidth: 176,
          startupCost: 0.5,
          totalCost: 2000,
          joinType: "Left",
          children: [
            { nodeType: "Index Scan", planRows: 100_000, planWidth: 96, startupCost: 0.2, totalCost: 800 },
            { nodeType: "Index Only Scan", planRows: 1, planWidth: 80, startupCost: 0.1, totalCost: 0.2 },
          ],
        }],
      },
    },
  });
  const output = JSON.stringify(receipt);
  for (const identifier of [
    POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_SCHEMA,
    SOURCE_ID,
    GENERATION,
    "private_member_table",
    "private_index",
    "Sort Key",
  ]) assert.equal(output.includes(identifier), false);
  assert.match(output, /"nodeType":"Sort"/u);
  assert.match(output, /"nodeType":"Index Scan"/u);
});

test("diagnostic fails closed before EXPLAIN on migration drift or wrong database identity", async () => {
  const changedMigrations = fakeMigrations();
  changedMigrations[37] = { ...changedMigrations[37], sha256: "f".repeat(64) };
  const migrationHarness = makeHarness({
    migrations: changedMigrations,
    migrationReceiptRows: fakeMigrations(),
  });
  await assert.rejects(runPostgresCommunityGraphReadbackDiagnostic({
    env: validEnv(), dependencies: migrationHarness.dependencies,
  }), /POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_MIGRATION_RECEIPT_INVALID/);
  assert.equal(migrationHarness.statements.some((sql) => sql.startsWith("EXPLAIN ")), false);
  assert.equal(migrationHarness.closed, true);

  const targetHarness = makeHarness({ targetRow: {
    database_name: "other",
    database_user: POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_IAM_USER,
    server_version_num: 170011,
    schema_owner: "tibotattle-test-migrator@tibotattle.iam",
    generation: GENERATION,
    cohort_digest: GENERATION,
    payload_sha256: "b".repeat(64),
    expected_members: "100000",
  } });
  await assert.rejects(runPostgresCommunityGraphReadbackDiagnostic({
    env: validEnv(), dependencies: targetHarness.dependencies,
  }), /POSTGRES_COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_TARGET_INVALID/);
  assert.equal(targetHarness.statements.some((sql) => sql.startsWith("EXPLAIN ")), false);
  assert.equal(targetHarness.closed, true);
});
