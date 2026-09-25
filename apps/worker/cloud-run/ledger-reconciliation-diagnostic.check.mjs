#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";
import {
  LEDGER_RECONCILIATION_DIAGNOSTIC_IAM_USER,
  LEDGER_RECONCILIATION_DIAGNOSTIC_JOB,
  LEDGER_RECONCILIATION_DIAGNOSTIC_PROJECT,
  LEDGER_RECONCILIATION_DIAGNOSTIC_SERVICE_ACCOUNT,
  LEDGER_RECONCILIATION_DIAGNOSTIC_TARGET,
  parseLedgerReconciliationDiagnosticConfig,
  readAttachedLedgerDiagnosticServiceAccount,
  readLedgerErasureJobPreflight,
  runLedgerReconciliationDiagnostic,
} from "./ledger-reconciliation-diagnostic.mjs";

const EXECUTION = "tibotattle-test-ledger-reconciliation-diagnostic-00001-abc";

function validEnv(overrides = {}) {
  return {
    CLOUD_RUN_JOB: LEDGER_RECONCILIATION_DIAGNOSTIC_JOB,
    CLOUD_RUN_EXECUTION: EXECUTION,
    CLOUD_RUN_TASK_INDEX: "0",
    CLOUD_RUN_TASK_COUNT: "1",
    CLOUD_RUN_TASK_ATTEMPT: "0",
    GOOGLE_CLOUD_PROJECT: LEDGER_RECONCILIATION_DIAGNOSTIC_PROJECT,
    POSTGRES_MIGRATOR_IAM_USER: LEDGER_RECONCILIATION_DIAGNOSTIC_IAM_USER,
    LEDGER_INSTANCE_CONNECTION_NAME: LEDGER_RECONCILIATION_DIAGNOSTIC_TARGET.instanceConnectionName,
    LEDGER_DATABASE: LEDGER_RECONCILIATION_DIAGNOSTIC_TARGET.database,
    LEDGER_SCHEMA: LEDGER_RECONCILIATION_DIAGNOSTIC_TARGET.schema,
    ...overrides,
  };
}

function expectedRow(overrides = {}) {
  return {
    server_version_num: 170006,
    ledger_migration_version: 5,
    ledger_migration_receipt_count: "5",
    total_rows: "7",
    invalid_source_namespace_count: "1",
    invalid_source_id_count: "2",
    invalid_terminal_json_count: "3",
    complete_without_terminal_json_count: "4",
    missing_participant_tombstone_count: "5",
    ...overrides,
  };
}

function mockPool(row = expectedRow()) {
  const statements = [];
  let releaseCount = 0;
  return {
    statements,
    get releaseCount() { return releaseCount; },
    async connect() {
      return {
        async query(sql, params) {
          statements.push({ sql, params });
          if (sql.trimStart().startsWith("SELECT current_setting")) {
            return { rows: [row], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release() { releaseCount += 1; },
      };
    },
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

test("configuration is pinned to the one test ledger Job and migrator identity", () => {
  const config = parseLedgerReconciliationDiagnosticConfig(
    validEnv(),
    LEDGER_RECONCILIATION_DIAGNOSTIC_SERVICE_ACCOUNT,
  );
  assert.equal(config.project, "tibotattle");
  assert.equal(config.database, "tibotattle_ledger");
  assert.equal(config.schema, '"tibotattle_ledger"');
  assert.equal(config.iamUser, LEDGER_RECONCILIATION_DIAGNOSTIC_IAM_USER);

  for (const overrides of [
    { CLOUD_RUN_JOB: "other-job" },
    { GOOGLE_CLOUD_PROJECT: "production" },
    { LEDGER_DATABASE: "production" },
    { LEDGER_SCHEMA: "other_schema" },
    { POSTGRES_MIGRATOR_IAM_USER: "other@tibotattle.iam" },
    { CLOUD_RUN_TASK_COUNT: "2" },
    { K_SERVICE: "tibotattle-test-app" },
  ]) {
    assert.throws(
      () => parseLedgerReconciliationDiagnosticConfig(
        validEnv(overrides), LEDGER_RECONCILIATION_DIAGNOSTIC_SERVICE_ACCOUNT,
      ),
    );
  }
  expectCode(
    () => parseLedgerReconciliationDiagnosticConfig(validEnv(), "other@tibotattle.iam.gserviceaccount.com"),
    "CLOUD_RUN_TEST_LEDGER_DIAGNOSTIC_SERVICE_ACCOUNT_INVALID",
  );
});

test("metadata identity read requires the Google metadata response marker", async () => {
  let request;
  const email = await readAttachedLedgerDiagnosticServiceAccount({
    async fetchImpl(url, options) {
      request = { url, options };
      return {
        status: 200,
        headers: { get: (name) => name === "Metadata-Flavor" ? "Google" : null },
        async text() { return LEDGER_RECONCILIATION_DIAGNOSTIC_SERVICE_ACCOUNT; },
      };
    },
  });
  assert.equal(email, LEDGER_RECONCILIATION_DIAGNOSTIC_SERVICE_ACCOUNT);
  assert.equal(request.options.headers["Metadata-Flavor"], "Google");
  await assert.rejects(
    readAttachedLedgerDiagnosticServiceAccount({
      async fetchImpl() {
        return { status: 200, headers: { get: () => null }, async text() {
          return LEDGER_RECONCILIATION_DIAGNOSTIC_SERVICE_ACCOUNT;
        } };
      },
    }),
    (error) => error?.code === "CLOUD_RUN_TEST_LEDGER_DIAGNOSTIC_METADATA_UNAVAILABLE",
  );
});

test("read-only aggregate reports every 0006 storage_erasure_jobs preflight predicate", async () => {
  const pool = mockPool();
  const counts = await readLedgerErasureJobPreflight(pool, "tibotattle_ledger");
  assert.deepEqual(counts, {
    ledgerMigrationVersion: 5,
    ledgerMigrationReceiptCount: 5,
    totalRows: 7,
    invalidSourceNamespace: 1,
    invalidSourceId: 2,
    invalidTerminalJson: 3,
    completeWithoutTerminalJson: 4,
    missingParticipantTombstone: 5,
  });
  assert.equal(pool.releaseCount, 1);
  assert.deepEqual(pool.statements.slice(0, 3).map(({ sql }) => sql), [
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "SET LOCAL statement_timeout = '15000ms'",
    "SET LOCAL lock_timeout = '1000ms'",
  ]);
  assert.equal(pool.statements.at(-1).sql, "COMMIT");
  const sql = pool.statements.find(({ sql: statement }) => statement.trimStart().startsWith("SELECT current_setting"))?.sql;
  assert.match(sql, /length\(job\.source_namespace\) NOT BETWEEN 1 AND 256/u);
  assert.match(sql, /job\.source_id !~ '\^\[A-Za-z0-9\]\[A-Za-z0-9:_-\]\{0,127\}\$'/u);
  assert.match(sql, /length\(job\.terminal_json\) > 65536/u);
  assert.match(sql, /NOT pg_input_is_valid\(job\.terminal_json, 'json'\)/u);
  assert.match(sql, /job\.state = 'complete' AND job\.terminal_json IS NULL/u);
  assert.match(sql, /WHERE NOT EXISTS \([\s\S]*tombstone\.participant_digest = job\.participant_digest/u);
  assert.match(sql, /count\(\*\)::text AS total_rows/u);
  assert.doesNotMatch(sql, /SELECT\s+job\.(?:participant_digest|source_id|owner_digest|terminal_json)/iu);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP)\b/iu);
});

test("the diagnostic stops read-only transaction on invalid counts and never exposes database details", async () => {
  const pool = mockPool(expectedRow({ invalid_source_id_count: "99999999999999999999" }));
  await assert.rejects(
    readLedgerErasureJobPreflight(pool, "tibotattle_ledger"),
    (error) => error?.code === "POSTGRES_TEST_LEDGER_DIAGNOSTIC_READBACK_INVALID",
  );
  assert.equal(pool.statements.at(-1).sql, "ROLLBACK");
  assert.equal(pool.releaseCount, 1);

  await assert.rejects(
    readLedgerErasureJobPreflight(mockPool(expectedRow({ server_version_num: 160000 })), "tibotattle_ledger"),
    (error) => error?.code === "POSTGRES_TEST_LEDGER_DIAGNOSTIC_POSTGRES_VERSION_UNSUPPORTED",
  );
});

test("runner rejects wrong environment before metadata, connector, or database access", async () => {
  let metadataCalls = 0;
  let connectorCalls = 0;
  await assert.rejects(
    runLedgerReconciliationDiagnostic({
      env: validEnv({ LEDGER_DATABASE: "production" }),
      dependencies: {
        async readServiceAccountEmail() { metadataCalls += 1; return LEDGER_RECONCILIATION_DIAGNOSTIC_SERVICE_ACCOUNT; },
        createConnector() { connectorCalls += 1; return {}; },
      },
    }),
    (error) => error?.code === "POSTGRES_TEST_LEDGER_DIAGNOSTIC_TARGET_INVALID",
  );
  assert.equal(metadataCalls, 0);
  assert.equal(connectorCalls, 0);
});

test("runner uses one pinned IAM pool and returns counts without row content", async () => {
  const pool = {};
  const closeCalls = [];
  const poolOptions = [];
  const result = await runLedgerReconciliationDiagnostic({
    env: validEnv(),
    dependencies: {
      async readServiceAccountEmail() { return LEDGER_RECONCILIATION_DIAGNOSTIC_SERVICE_ACCOUNT; },
      createConnector() { return { connector: true }; },
      async createPool(options) { poolOptions.push(options); return pool; },
      async readPreflight(actualPool, schema) {
        assert.equal(actualPool, pool);
        assert.equal(schema, '"tibotattle_ledger"');
        return {
          ledgerMigrationVersion: 5,
          ledgerMigrationReceiptCount: 5,
          totalRows: 7,
          invalidSourceNamespace: 1,
          invalidSourceId: 2,
          invalidTerminalJson: 3,
          completeWithoutTerminalJson: 4,
          missingParticipantTombstone: 5,
        };
      },
      async closeResources(resources) { closeCalls.push(resources); },
    },
  });
  assert.deepEqual(poolOptions, [{
    connector: { connector: true },
    instanceConnectionName: LEDGER_RECONCILIATION_DIAGNOSTIC_TARGET.instanceConnectionName,
    database: "tibotattle_ledger",
    user: LEDGER_RECONCILIATION_DIAGNOSTIC_IAM_USER,
    max: 1,
    applicationName: "tibotattle-test-ledger-reconciliation-diagnostic",
  }]);
  assert.equal(result.counts.ledgerMigrationVersion, 5);
  assert.equal(result.counts.ledgerMigrationReceiptCount, 5);
  assert.deepEqual(Object.keys(result).sort(), ["counts", "schemaVersion", "status"]);
  assert.deepEqual(Object.keys(result.counts).sort(), [
    "completeWithoutTerminalJson",
    "invalidSourceId",
    "invalidSourceNamespace",
    "invalidTerminalJson",
    "ledgerMigrationReceiptCount",
    "ledgerMigrationVersion",
    "missingParticipantTombstone",
    "totalRows",
  ].sort());
  assert.doesNotMatch(JSON.stringify(result), /terminal_json|digest|source_id|execution|tibotattle-test/u);
  assert.equal(closeCalls.length, 1);
  assert.equal(closeCalls[0].pools[0], pool);
});
