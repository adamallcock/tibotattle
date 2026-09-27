import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import {
  applyStockAndStagedMigrations,
  postgresTestEndpoint,
} from "./staged-migrations-harness.mjs";

const WORKER_ROOT = new URL("..", import.meta.url).pathname;
const ENDPOINT = await postgresTestEndpoint();
const PG_SKIP = ENDPOINT === null
  ? "set PG_TEST_SOCKET (or PG_TEST_HOST) and PG_TEST_PORT for the local PostgreSQL 17 cluster"
  : false;
const STAGED_0049 = "0049_lifecycle_readiness_state.sql";
const LIFECYCLE_MODULE = "/src/postgres-lifecycle-state.ts";
const CLIENT_MODULE = "/src/postgres-client.ts";

const RETENTION_KEYS = Object.freeze([
  "state", "lastStartedAt", "lastCompletedAtMs", "maintenanceRunAtIso", "quarantineCutoffAt",
  "quarantineObjectsDeleted", "quarantineRetentionComplete", "restoredParticipantsSuppressed",
  "restoreReplayComplete", "failureCode",
]);
const RECONCILIATION_KEYS = Object.freeze([
  "state", "lastStartedAt", "lastCompletedAt", "maintenanceRunAtIso", "cutoffAt",
  "registrationsExamined", "orphanObjectsDeleted", "referencedObjectsPreserved",
  "reconciliationComplete", "failureCode",
]);
const FRESH_RETENTION = Object.freeze({
  state: "never_run", lastStartedAt: null, lastCompletedAtMs: null, maintenanceRunAtIso: null,
  quarantineCutoffAt: null, quarantineObjectsDeleted: 0, quarantineRetentionComplete: true,
  restoredParticipantsSuppressed: 0, restoreReplayComplete: true, failureCode: null,
});
const FRESH_RECONCILIATION = Object.freeze({
  state: "never_run", lastStartedAt: null, lastCompletedAt: null, maintenanceRunAtIso: null,
  cutoffAt: null, registrationsExamined: 0, orphanObjectsDeleted: 0, referencedObjectsPreserved: 0,
  reconciliationComplete: false, failureCode: null,
});

let sharedPool;
let sharedVite;
const loadedModules = new Map();

async function pool() {
  if (sharedPool) return sharedPool;
  if (ENDPOINT === null) throw new Error("PostgreSQL endpoint is unavailable");
  const nextPool = new pg.Pool({
    ...ENDPOINT,
    ssl: false,
    max: 4,
    connectionTimeoutMillis: 5_000,
    application_name: "pg-lifecycle-state-test",
  });
  try {
    const result = await nextPool.query(
      "SELECT current_setting('server_version_num')::integer AS version, host(inet_server_addr()) AS address",
    );
    assert.equal(Math.floor(result.rows[0].version / 10_000), 17,
      "lifecycle state qualification requires PostgreSQL 17");
    if (ENDPOINT.host.startsWith("/")) assert.equal(result.rows[0].address, null);
    else assert.ok(["127.0.0.1", "::1"].includes(result.rows[0].address));
  } catch (error) {
    await nextPool.end();
    throw error;
  }
  sharedPool = nextPool;
  return sharedPool;
}

async function workerModule(path) {
  if (!sharedVite) {
    sharedVite = await createServer({
      root: WORKER_ROOT,
      configFile: false,
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "silent",
    });
  }
  if (!loadedModules.has(path)) loadedModules.set(path, await sharedVite.ssrLoadModule(path));
  return loadedModules.get(path);
}

after(async () => {
  if (sharedVite) await sharedVite.close();
  if (sharedPool) await sharedPool.end();
});

function quoted(schema) {
  assert.match(schema, /^[a-z_][a-z0-9_]{0,62}$/u);
  return `"${schema}"`;
}

async function withSchema(body) {
  const database = await pool();
  const schema = `lifecycle_state_${randomBytes(6).toString("hex")}`;
  const created = [schema];
  const table = (name, target = schema) => {
    assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/u);
    return `${quoted(target)}."${name}"`;
  };
  const scratch = async () => {
    const name = `${schema}_scratch`;
    await database.query(`CREATE SCHEMA ${quoted(name)}`);
    created.push(name);
    return name;
  };
  await database.query(`CREATE SCHEMA ${quoted(schema)}`);
  try {
    await applyStockAndStagedMigrations({
      role: "primary",
      schema,
      pool: database,
      stagedFiles: [STAGED_0049],
    });
    await body({ pool: database, schema, table, scratch });
  } finally {
    for (const name of created.reverse()) {
      await database.query(`DROP SCHEMA IF EXISTS ${quoted(name)} CASCADE`);
    }
  }
}

async function inReadTransaction(database, body, { hostileSession = false } = {}) {
  const client = await database.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    if (hostileSession) {
      await client.query("SET LOCAL TimeZone='Pacific/Kiritimati'");
      await client.query("SET LOCAL DateStyle='SQL, DMY'");
    }
    const result = await body(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const fake = (rows) => ({
  async query() { return { rows, rowCount: Array.isArray(rows) ? rows.length : null }; },
  release() {},
});

const RETENTION_ROW = Object.freeze({
  schema_version: "backend-retention-v0.1",
  state: "never_run",
  last_started_at: null,
  last_completed_at: null,
  maintenance_run_at: null,
  quarantine_cutoff_at: null,
  quarantine_objects_deleted: "0",
  quarantine_retention_complete: true,
  restored_participants_suppressed: "0",
  restore_replay_complete: true,
  failure_code: null,
});
const RECONCILIATION_ROW = Object.freeze({
  schema_version: "quarantine-reconciliation-v0.1",
  state: "never_run",
  last_started_at: null,
  last_completed_at: null,
  maintenance_run_at: null,
  cutoff_at: null,
  registrations_examined: "0",
  orphan_objects_deleted: "0",
  referenced_objects_preserved: "0",
  reconciliation_complete: false,
  failure_code: null,
});

test("PostgreSQL lifecycle readers return runtime state under hostile session settings", {
  skip: PG_SKIP,
  timeout: 240_000,
}, async () => withSchema(async ({ pool: database, schema, table }) => {
  const lifecycle = await workerModule(LIFECYCLE_MODULE);
  const { withPostgresRead } = await workerModule(CLIENT_MODULE);
  const options = { primarySchema: schema, ledgerSchema: `${schema}_ledger` };
  const readBoth = () => inReadTransaction(database, async (client) => ({
    readOnly: (await client.query("SELECT current_setting('transaction_read_only') AS value")).rows[0].value,
    retention: await lifecycle.readPostgresRetentionState(client, options),
    reconciliation: await lifecycle.readPostgresQuarantineReconciliationState(client, options),
  }), { hostileSession: true });

  const fresh = await readBoth();
  assert.equal(fresh.readOnly, "on");
  assert.deepEqual(Object.keys(fresh.retention), RETENTION_KEYS);
  assert.deepEqual(fresh.retention, FRESH_RETENTION);
  assert.deepEqual(Object.keys(fresh.reconciliation), RECONCILIATION_KEYS);
  assert.deepEqual(fresh.reconciliation, FRESH_RECONCILIATION);
  assert.ok(Object.isFrozen(fresh.retention) && Object.isFrozen(fresh.reconciliation));
  assert.equal(lifecycle.maintenanceCyclesMatch(fresh.retention.maintenanceRunAtIso,
    fresh.reconciliation.maintenanceRunAtIso), false, "two absent markers never match");

  const cycle = "2026-09-24T23:58:00.456Z";
  await database.query(
    `UPDATE ${table("retention_state")}
        SET state='completed', last_started_at='2026-09-24T23:50:00.000001Z',
            last_completed_at='2026-09-24T23:59:59.123456Z', maintenance_run_at=$1,
            quarantine_cutoff_at='2026-09-23T23:59:59.999999Z', quarantine_objects_deleted=9007199254740991,
            restored_participants_suppressed=4, quarantine_retention_complete=false, restore_replay_complete=false`,
    [cycle],
  );
  await database.query(
    `UPDATE ${table("quarantine_reconciliation_state")}
        SET state='completed', last_started_at='2026-09-24T23:55:00.5Z',
            last_completed_at='2026-09-24T23:59:59.9999Z', maintenance_run_at=$1,
            cutoff_at='2026-09-24T22:59:59.123456Z', registrations_examined=12,
            orphan_objects_deleted=5, referenced_objects_preserved=7, reconciliation_complete=true`,
    [cycle],
  );

  const hostile = await inReadTransaction(database, async (client) => {
    const control = await client.query(`SELECT last_completed_at::text AS text FROM ${table("retention_state")}`);
    assert.doesNotMatch(control.rows[0].text, /^\d{4}-\d{2}-\d{2}T/u,
      "a control cast depends on hostile session DateStyle");
    return {
      retention: await lifecycle.readPostgresRetentionState(client, options),
      reconciliation: await lifecycle.readPostgresQuarantineReconciliationState(client, options),
    };
  }, { hostileSession: true });
  assert.deepEqual(hostile.retention, {
    state: "completed",
    lastStartedAt: "2026-09-24T23:50:00.000Z",
    lastCompletedAtMs: Date.parse("2026-09-24T23:59:59.123Z"),
    maintenanceRunAtIso: cycle,
    quarantineCutoffAt: "2026-09-23T23:59:59.999Z",
    quarantineObjectsDeleted: 9_007_199_254_740_991,
    quarantineRetentionComplete: false,
    restoredParticipantsSuppressed: 4,
    restoreReplayComplete: false,
    failureCode: null,
  });
  assert.deepEqual(hostile.reconciliation, {
    state: "completed",
    lastStartedAt: "2026-09-24T23:55:00.500Z",
    lastCompletedAt: "2026-09-24T23:59:59.999Z",
    maintenanceRunAtIso: cycle,
    cutoffAt: "2026-09-24T22:59:59.123Z",
    registrationsExamined: 12,
    orphanObjectsDeleted: 5,
    referencedObjectsPreserved: 7,
    reconciliationComplete: true,
    failureCode: null,
  });
  assert.equal(lifecycle.maintenanceCyclesMatch(hostile.retention.maintenanceRunAtIso,
    hostile.reconciliation.maintenanceRunAtIso), true);

  // These two columns are runtime observations. The readers return later
  // runtime writes exactly as stored, rather than restoring migration defaults.
  await database.query(
    `UPDATE ${table("retention_state")}
        SET state='running', lease_id='synthetic-maintenance-lease',
            lease_expires_at='2026-09-25T00:13:00Z', restored_participants_suppressed=0,
            restore_replay_complete=true`,
  );
  const running = await inReadTransaction(database, (client) =>
    lifecycle.readPostgresRetentionState(client, options));
  assert.equal(running.state, "running");
  assert.equal(running.restoredParticipantsSuppressed, 0);
  assert.equal(running.restoreReplayComplete, true);

  await database.query(
    `UPDATE ${table("retention_state")}
        SET state='failed', maintenance_run_at=NULL, failure_code='LIFECYCLE_PASS_FAILED',
            lease_id=NULL, lease_expires_at=NULL, restored_participants_suppressed=9,
            restore_replay_complete=false`,
  );
  await database.query(
    `UPDATE ${table("quarantine_reconciliation_state")}
        SET state='failed', lease_id=NULL, failure_code='QUARANTINE_RECONCILIATION_FAILED',
            reconciliation_complete=false`,
  );
  const failed = await inReadTransaction(database, async (client) => ({
    retention: await lifecycle.readPostgresRetentionState(client, options),
    reconciliation: await lifecycle.readPostgresQuarantineReconciliationState(client, options),
  }));
  assert.equal(failed.retention.state, "failed");
  assert.equal(failed.retention.maintenanceRunAtIso, null);
  assert.equal(failed.retention.failureCode, "LIFECYCLE_PASS_FAILED");
  assert.equal(failed.retention.restoredParticipantsSuppressed, 9);
  assert.equal(failed.retention.restoreReplayComplete, false);
  assert.equal(failed.reconciliation.failureCode, "QUARANTINE_RECONCILIATION_FAILED");
  assert.equal(lifecycle.maintenanceCyclesMatch(failed.retention.maintenanceRunAtIso,
    failed.reconciliation.maintenanceRunAtIso), false);

  await database.query(`DELETE FROM ${table("retention_state")}`);
  await database.query(`DELETE FROM ${table("quarantine_reconciliation_state")}`);
  const absent = await inReadTransaction(database, async (client) => ({
    retention: await lifecycle.readPostgresRetentionState(client, options),
    reconciliation: await lifecycle.readPostgresQuarantineReconciliationState(client, options),
  }));
  assert.deepEqual(absent, { retention: null, reconciliation: null });

  // The reviewed transaction helper also preserves the caller's read boundary.
  const bounded = await withPostgresRead(database, (client) =>
    lifecycle.readPostgresQuarantineReconciliationState(client, options), {
      operation: "lifecycle_state.test_read",
    });
  assert.equal(bounded, null);
}));

test("lifecycle readers reject malformed stored rows without exposing row values", {
  skip: PG_SKIP,
  timeout: 180_000,
}, async () => withSchema(async ({ pool: database, schema, table, scratch }) => {
  const lifecycle = await workerModule(LIFECYCLE_MODULE);
  const live = { primarySchema: schema, ledgerSchema: `${schema}_ledger` };
  const read = (reader, options) => inReadTransaction(database, (client) => lifecycle[reader](client, options));
  const shapeError = (relation, field) => (error) => {
    assert.ok(error instanceof lifecycle.StateShapeError, `expected StateShapeError, got ${error?.name}`);
    assert.equal(error.name, "StateShapeError");
    assert.equal(error.code, "LIFECYCLE_STATE_SHAPE_INVALID");
    assert.equal(error.message, "LIFECYCLE_STATE_SHAPE_INVALID", "message carries no stored value");
    assert.equal(error.relation, relation);
    assert.equal(error.field, field);
    return true;
  };

  // PostgreSQL can store these values even though JavaScript cannot represent
  // them safely; reads reject them rather than round or turn them into null.
  const retention = table("retention_state");
  await database.query(`UPDATE ${retention} SET quarantine_objects_deleted=9007199254740992`);
  await assert.rejects(read("readPostgresRetentionState", live),
    shapeError("retention_state", "quarantine_objects_deleted"));
  await database.query(`UPDATE ${retention} SET quarantine_objects_deleted=0`);
  for (const value of ["infinity", "-infinity", "0044-03-15 12:00:00+00 BC", "10000-01-01 00:00:00+00"]) {
    await database.query(`UPDATE ${retention} SET last_completed_at=$1::timestamptz`, [value]);
    await assert.rejects(read("readPostgresRetentionState", live),
      shapeError("retention_state", "last_completed_at"));
  }
  await database.query(`UPDATE ${retention} SET last_completed_at=NULL`);
  await database.query(`UPDATE ${table("quarantine_reconciliation_state")} SET cutoff_at='infinity'`);
  await assert.rejects(read("readPostgresQuarantineReconciliationState", live),
    shapeError("quarantine_reconciliation_state", "cutoff_at"));

  // A scratch copy carries column types/defaults but no CHECK, primary-key or
  // unique constraints, allowing the reader's closed contract to be exercised
  // independently of the migration's own fail-closed constraints.
  const copy = await scratch();
  for (const relation of ["retention_state", "quarantine_reconciliation_state"]) {
    await database.query(`CREATE TABLE ${table(relation, copy)} (LIKE ${table(relation)} INCLUDING DEFAULTS)`);
  }
  const constraints = await database.query(
    `SELECT count(*)::integer AS count FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
      WHERE n.nspname=$1 AND c.contype IN ('c','p','u')`,
    [copy],
  );
  assert.equal(constraints.rows[0].count, 0);
  const unchecked = { primarySchema: copy, ledgerSchema: `${copy}_ledger` };
  const seedRetention = () => database.query(
    `INSERT INTO ${table("retention_state", copy)} (singleton) VALUES (1)`,
  );
  const seedReconciliation = () => database.query(
    `INSERT INTO ${table("quarantine_reconciliation_state", copy)} (singleton, schema_version)
     VALUES (1, 'quarantine-reconciliation-v0.1')`,
  );
  await seedRetention();
  await seedReconciliation();
  assert.deepEqual(await read("readPostgresRetentionState", unchecked), FRESH_RETENTION);
  assert.deepEqual(await read("readPostgresQuarantineReconciliationState", unchecked), FRESH_RECONCILIATION);

  const retentionCases = [
    ["state='idle'", "state"],
    ["state='NEVER_RUN'", "state"],
    ["schema_version='backend-retention-v0.0'", "schema_version"],
    ["failure_code='SYNTHETIC_OTHER_FAILURE'", "failure_code"],
    ["failure_code='QUARANTINE_RECONCILIATION_FAILED'", "failure_code"],
    ["restored_participants_suppressed=-1", "restored_participants_suppressed"],
    ["maintenance_run_at='2026-09-24T23:59:59.123001Z'", "maintenance_run_at"],
  ];
  for (const [assignment, field] of retentionCases) {
    await database.query(`DELETE FROM ${table("retention_state", copy)}`);
    await seedRetention();
    await database.query(`UPDATE ${table("retention_state", copy)} SET ${assignment}`);
    await assert.rejects(read("readPostgresRetentionState", unchecked), shapeError("retention_state", field));
  }
  const reconciliationCases = [
    ["state='paused'", "state"],
    ["schema_version='quarantine-reconciliation-v0.2'", "schema_version"],
    ["failure_code='LIFECYCLE_PASS_FAILED'", "failure_code"],
    ["orphan_objects_deleted=-1", "orphan_objects_deleted"],
    ["maintenance_run_at='2026-09-24T23:59:59.123001Z'", "maintenance_run_at"],
  ];
  for (const [assignment, field] of reconciliationCases) {
    await database.query(`DELETE FROM ${table("quarantine_reconciliation_state", copy)}`);
    await seedReconciliation();
    await database.query(`UPDATE ${table("quarantine_reconciliation_state", copy)} SET ${assignment}`);
    await assert.rejects(read("readPostgresQuarantineReconciliationState", unchecked),
      shapeError("quarantine_reconciliation_state", field));
  }

  await database.query(`DELETE FROM ${table("retention_state", copy)}`);
  await seedRetention();
  await seedRetention();
  await assert.rejects(read("readPostgresRetentionState", unchecked), shapeError("retention_state", "singleton"));
  await database.query(`DELETE FROM ${table("retention_state", copy)}`);
  assert.equal(await read("readPostgresRetentionState", unchecked), null);
}));

test("maintenanceCyclesMatch accepts only two present canonical identical instants", async () => {
  const {
    maintenanceCyclesMatch,
    readPostgresRetentionState,
    readPostgresQuarantineReconciliationState,
    StateShapeError,
    POSTGRES_LIFECYCLE_RUN_STATES,
  } = await workerModule(LIFECYCLE_MODULE);
  assert.deepEqual(POSTGRES_LIFECYCLE_RUN_STATES, ["never_run", "running", "completed", "failed"]);
  assert.ok(Object.isFrozen(POSTGRES_LIFECYCLE_RUN_STATES));
  const instant = "2026-09-24T23:59:59.123Z";
  assert.equal(maintenanceCyclesMatch(instant, instant), true);
  assert.equal(maintenanceCyclesMatch(instant, "2026-09-24T23:59:59.124Z"), false);
  for (const [left, right] of [
    [null, null], [undefined, undefined], [instant, null], [null, instant],
    ["2026-09-24 23:59:59.123+00", "2026-09-24 23:59:59.123+00"],
    ["2026-09-24T23:59:59.123456Z", "2026-09-24T23:59:59.123456Z"],
    ["2026-09-24T23:59:59Z", "2026-09-24T23:59:59Z"],
    ["2026-02-30T00:00:00.000Z", "2026-02-30T00:00:00.000Z"],
    ["", ""],
  ]) assert.equal(maintenanceCyclesMatch(left, right), false);

  const error = (relation, field) => (value) => {
    assert.ok(value instanceof StateShapeError);
    assert.equal(value.message, "LIFECYCLE_STATE_SHAPE_INVALID");
    assert.equal(value.relation, relation);
    assert.equal(value.field, field);
    return true;
  };
  assert.equal((await readPostgresRetentionState(fake([RETENTION_ROW]))).state, "never_run");
  assert.equal(await readPostgresRetentionState(fake([])), null);
  assert.equal((await readPostgresQuarantineReconciliationState(fake([RECONCILIATION_ROW]))).state, "never_run");
  assert.equal(await readPostgresQuarantineReconciliationState(fake([])), null);
  for (const state of POSTGRES_LIFECYCLE_RUN_STATES) {
    assert.equal((await readPostgresRetentionState(fake([{ ...RETENTION_ROW, state }]))).state, state);
    assert.equal((await readPostgresQuarantineReconciliationState(fake([{ ...RECONCILIATION_ROW, state }]))).state, state);
  }
  assert.equal((await readPostgresRetentionState(fake([{
    ...RETENTION_ROW, state: "failed", failure_code: "LIFECYCLE_PASS_FAILED",
  }]))).failureCode, "LIFECYCLE_PASS_FAILED");
  assert.equal((await readPostgresQuarantineReconciliationState(fake([{
    ...RECONCILIATION_ROW, state: "failed", failure_code: "QUARANTINE_RECONCILIATION_FAILED",
  }]))).failureCode, "QUARANTINE_RECONCILIATION_FAILED");

  for (const [row, field] of [
    [{ ...RETENTION_ROW, state: "idle" }, "state"],
    [{ ...RETENTION_ROW, quarantine_retention_complete: "t" }, "quarantine_retention_complete"],
    [{ ...RETENTION_ROW, quarantine_objects_deleted: 0 }, "quarantine_objects_deleted"],
    [{ ...RETENTION_ROW, quarantine_objects_deleted: "007" }, "quarantine_objects_deleted"],
    [{ ...RETENTION_ROW, quarantine_objects_deleted: "9007199254740992" }, "quarantine_objects_deleted"],
    [{ ...RETENTION_ROW, restored_participants_suppressed: "-1" }, "restored_participants_suppressed"],
    [{ ...RETENTION_ROW, last_started_at: "out-of-range" }, "last_started_at"],
    [{ ...RETENTION_ROW, last_started_at: "2026-09-24 23:59:59.123+00" }, "last_started_at"],
    [{ ...RETENTION_ROW, last_completed_at: undefined }, "last_completed_at"],
  ]) await assert.rejects(readPostgresRetentionState(fake([row])), error("retention_state", field));
  await assert.rejects(readPostgresRetentionState(fake([RETENTION_ROW, RETENTION_ROW])),
    error("retention_state", "singleton"));
  await assert.rejects(readPostgresRetentionState(fake(null)), error("retention_state", "singleton"));

  for (const [row, field] of [
    [{ ...RECONCILIATION_ROW, state: "paused" }, "state"],
    [{ ...RECONCILIATION_ROW, schema_version: "quarantine-reconciliation-v0.2" }, "schema_version"],
    [{ ...RECONCILIATION_ROW, failure_code: "LIFECYCLE_PASS_FAILED" }, "failure_code"],
    [{ ...RECONCILIATION_ROW, registrations_examined: "9007199254740992" }, "registrations_examined"],
    [{ ...RECONCILIATION_ROW, referenced_objects_preserved: "01" }, "referenced_objects_preserved"],
    [{ ...RECONCILIATION_ROW, cutoff_at: "2026-02-30T00:00:00.000Z" }, "cutoff_at"],
  ]) await assert.rejects(readPostgresQuarantineReconciliationState(fake([row])),
    error("quarantine_reconciliation_state", field));

  await assert.rejects(readPostgresRetentionState(fake([RETENTION_ROW]), {
    primarySchema: "bad; DROP SCHEMA public;--", ledgerSchema: "lifecycle_ledger",
  }), { name: "TypeError", message: "invalid PostgreSQL schema configuration" });
});
