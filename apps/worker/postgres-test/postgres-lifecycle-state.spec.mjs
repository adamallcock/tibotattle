import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations, renderPostgresSearchPath } from "../scripts/postgres-migrations.mjs";

/*
 * PostgreSQL 17 qualification for the staged lifecycle readiness state
 * (postgres/staged-migrations/primary/0049_lifecycle_readiness_state.sql) and
 * its shared readers (src/postgres-lifecycle-state.ts). Until the
 * staged-migration harness exists, each schema receives the stock primary
 * migrations and then the staged file in one transaction under the migration
 * runner's search path and timeouts. Every row is synthetic and content-free.
 */

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER || "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD || "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";
const SKIP = !PG_TEST_HOST && !PG_TEST_SOCKET;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGED_0049 = join(WORKER_ROOT, "postgres", "staged-migrations", "primary", "0049_lifecycle_readiness_state.sql");
const MODULE = "/src/postgres-lifecycle-state.ts";
const CLIENT_MODULE = "/src/postgres-client.ts";
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

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

const SOCKET_DIRECTORY = /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u;

/**
 * Loopback TCP, or a private socket directory named by PG_TEST_SOCKET or (as
 * the ledger-authority profile does) by PG_TEST_HOST.
 */
async function endpoint() {
  const socket = PG_TEST_SOCKET || (PG_TEST_HOST?.startsWith("/") ? PG_TEST_HOST : undefined);
  assert.ok(socket || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "lifecycle state tests require loopback or a private Unix socket");
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
  if (socket) {
    assert.match(socket, SOCKET_DIRECTORY);
    const link = await lstat(socket);
    const host = await realpath(socket);
    const metadata = await stat(host);
    assert.equal(link.isSymbolicLink(), false);
    assert.ok(host.startsWith("/private/tmp/tibotattle-pg-"));
    assert.equal(metadata.isDirectory(), true);
    assert.equal(metadata.mode & 0o077, 0);
    assert.equal(metadata.uid, process.getuid());
    return { host, port: PG_TEST_PORT, socket: true };
  }
  return { host: PG_TEST_HOST, port: PG_TEST_PORT, socket: false };
}

let sharedPool;
let sharedVite;
const loadedModules = new Map();

async function connection() {
  if (!sharedPool) {
    const { host, port, socket } = await endpoint();
    const pool = new pg.Pool({
      host, port, user: PG_TEST_USER, password: PG_TEST_PASSWORD, database: PG_TEST_DATABASE,
      ssl: false, max: 4, connectionTimeoutMillis: 5_000, application_name: "pg-lifecycle-state-test",
    });
    try {
      const server = await pool.query(
        "SELECT current_setting('server_version_num')::integer AS version, host(inet_server_addr()) AS address",
      );
      assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "lifecycle state is qualified on PostgreSQL 17");
      if (socket) assert.equal(server.rows[0].address, null);
      else assert.ok(["127.0.0.1", "::1"].includes(server.rows[0].address), "the server answers on loopback");
    } catch (error) {
      await pool.end();
      throw error;
    }
    sharedPool = pool;
  }
  return sharedPool;
}

async function workerModule(path) {
  if (!sharedVite) {
    sharedVite = await createServer({
      root: WORKER_ROOT, configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "silent",
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

/** Apply the staged file exactly as the migration runner applies one file. */
async function applyStaged(pool, schema) {
  const sql = await readFile(STAGED_0049, "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='30000ms'");
    await client.query("SET LOCAL lock_timeout='5000ms'");
    await client.query(renderPostgresSearchPath(schema));
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run `body` against a fresh schema at the stock primary head. `beforeStaged`
 * shapes the pre-0049 row; 0049 is then applied unless `staged` is false.
 * Only schemas created here are dropped.
 */
async function withSchema(body, { staged = true, beforeStaged } = {}) {
  const pool = await connection();
  const schema = `lifecycle_state_${randomBytes(6).toString("hex")}`;
  const created = [schema];
  const table = (name, target = schema) => {
    assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/u);
    return `${quoted(target)}."${name}"`;
  };
  const scratch = async () => {
    const name = `${schema}_scratch`;
    await pool.query(`CREATE SCHEMA ${quoted(name)}`);
    created.push(name);
    return name;
  };
  await pool.query(`CREATE SCHEMA ${quoted(schema)}`);
  try {
    await applyPostgresMigrations({ role: "primary", schema, pool });
    const pre = await pool.query("SELECT to_regclass($1) AS relation", [`${quoted(schema)}.quarantine_reconciliation_state`]);
    assert.equal(pre.rows[0].relation, null, "the stock head has no reconciliation singleton");
    if (beforeStaged) await beforeStaged({ pool, schema, table });
    if (staged) await applyStaged(pool, schema);
    await body({ pool, schema, table, scratch });
  } finally {
    for (const name of created.reverse()) await pool.query(`DROP SCHEMA IF EXISTS ${quoted(name)} CASCADE`);
  }
}

/** Assert a CHECK, unique or primary-key refusal by SQLSTATE and constraint name. */
async function refuses(promise, code, constraint) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code, `expected ${code} from ${constraint}, got ${error?.code}`);
    assert.equal(error.constraint, constraint);
    return true;
  });
}

async function retentionRow(pool, table) {
  const result = await pool.query(
    `SELECT singleton, state, schema_version, quarantine_retention_complete, restore_replay_complete,
            quarantine_objects_deleted::text AS quarantine_objects_deleted,
            restored_participants_suppressed::text AS restored_participants_suppressed,
            last_started_at IS NULL AS started_null, last_completed_at IS NULL AS completed_null,
            maintenance_run_at IS NULL AS run_null, quarantine_cutoff_at IS NULL AS cutoff_null,
            lease_id, lease_expires_at IS NULL AS lease_expiry_null, failure_code
       FROM ${table("retention_state")}`,
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

/** Run `body` on one client inside BEGIN/COMMIT with a hostile session. */
async function inHostileTransaction(pool, body) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL TimeZone='Pacific/Kiritimati'");
    await client.query("SET LOCAL DateStyle='SQL, DMY'");
    const value = await body(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

test("0049 converts the idle seed to never_run with both flags true, then rejects idle", {
  skip: SKIP, timeout: 120_000,
}, async () => withSchema(async ({ pool, table }) => {
  assert.deepEqual(await retentionRow(pool, table), {
    singleton: 1, state: "never_run", schema_version: "backend-retention-v0.1",
    quarantine_retention_complete: true, restore_replay_complete: true,
    quarantine_objects_deleted: "0", restored_participants_suppressed: "0",
    started_null: true, completed_null: true, run_null: true, cutoff_null: true,
    lease_id: null, lease_expiry_null: true, failure_code: null,
  });
  await refuses(pool.query(`UPDATE ${table("retention_state")} SET state='idle'`),
    "23514", "retention_state_state_check");

  // A row rebuilt from defaults is the D1 seed (0010:38-54).
  await pool.query(`DELETE FROM ${table("retention_state")}`);
  await pool.query(`INSERT INTO ${table("retention_state")} (singleton) VALUES (1)`);
  const rebuilt = await retentionRow(pool, table);
  assert.equal(rebuilt.state, "never_run");
  assert.equal(rebuilt.schema_version, "backend-retention-v0.1");
  assert.equal(rebuilt.quarantine_retention_complete, true);
  assert.equal(rebuilt.restore_replay_complete, true);
}, {
  beforeStaged: async ({ pool, table }) => {
    const before = await pool.query(
      `SELECT state, quarantine_retention_complete, restore_replay_complete FROM ${table("retention_state")}`,
    );
    assert.deepEqual(before.rows, [{ state: "idle", quarantine_retention_complete: false, restore_replay_complete: false }],
      "the stock 0007 seed is idle with false flags");
  },
}));

test("0049 keeps a non-idle row's flags and aborts atomically on a row that breaks the contract", {
  skip: SKIP, timeout: 240_000,
}, async () => {
  await withSchema(async ({ pool, table }) => {
    const row = await retentionRow(pool, table);
    assert.equal(row.state, "completed");
    assert.equal(row.quarantine_retention_complete, false, "a completed row keeps its recorded flag");
    assert.equal(row.restore_replay_complete, false, "a completed row keeps its recorded flag");
    assert.equal(row.quarantine_objects_deleted, "3");
    assert.equal(row.restored_participants_suppressed, "2");
    assert.equal(row.completed_null, false);
  }, {
    beforeStaged: ({ pool, table }) => pool.query(
      `UPDATE ${table("retention_state")}
          SET state='completed', last_started_at='2026-09-24T10:00:00Z', last_completed_at='2026-09-24T10:05:00Z',
              quarantine_objects_deleted=3, restored_participants_suppressed=2`,
    ),
  });

  await withSchema(async ({ pool, table }) => {
    const row = await retentionRow(pool, table);
    assert.equal(row.state, "running");
    assert.equal(row.lease_id, "synthetic-maintenance-lease");
    assert.equal(row.quarantine_retention_complete, false);
    assert.equal(row.restore_replay_complete, true);
  }, {
    beforeStaged: ({ pool, table }) => pool.query(
      `UPDATE ${table("retention_state")}
          SET state='running', lease_id='synthetic-maintenance-lease',
              lease_expires_at='2026-09-24T10:20:00Z', restore_replay_complete=true`,
    ),
  });

  const contractBreaks = [
    ["failure_code='SYNTHETIC_OTHER_FAILURE'", "retention_state_failure_code_check"],
    ["lease_id='synthetic-orphan-lease'", "retention_state_lease_pair_check"],
    ["lease_expires_at='2026-09-24T10:20:00Z'", "retention_state_lease_pair_check"],
    ["quarantine_objects_deleted=-1", "retention_state_quarantine_objects_deleted_check"],
    ["restored_participants_suppressed=-1", "retention_state_restored_participants_suppressed_check"],
  ];
  for (const [assignment, constraint] of contractBreaks) {
    await withSchema(async ({ pool, schema, table }) => {
      await refuses(applyStaged(pool, schema), "23514", constraint);
      const after = await pool.query(
        `SELECT state, quarantine_retention_complete FROM ${table("retention_state")}`,
      );
      assert.deepEqual(after.rows, [{ state: "idle", quarantine_retention_complete: false }],
        "a refused 0049 leaves the stock row untouched");
      const relation = await pool.query("SELECT to_regclass($1) AS relation",
        [`${quoted(schema)}.quarantine_reconciliation_state`]);
      assert.equal(relation.rows[0].relation, null, "a refused 0049 creates nothing");
    }, {
      staged: false,
      beforeStaged: ({ pool, table }) => pool.query(`UPDATE ${table("retention_state")} SET ${assignment}`),
    });
  }
});

test("retention_state enforces the Worker failure, cycle, lease, counter and version contract", {
  skip: SKIP, timeout: 120_000,
}, async () => withSchema(async ({ pool, table }) => {
  const retention = table("retention_state");
  const update = (assignment) => pool.query(`UPDATE ${retention} SET ${assignment} WHERE singleton=1`);

  await refuses(update("state='paused'"), "23514", "retention_state_state_check");
  await refuses(update("failure_code='SYNTHETIC_OTHER_FAILURE'"), "23514", "retention_state_failure_code_check");
  await refuses(update("state='failed', failure_code='LIFECYCLE_PASS_FAILED', maintenance_run_at='2026-09-24T10:05:00Z'"),
    "23514", "retention_state_failed_cycle_check");
  await update("state='failed', failure_code='LIFECYCLE_PASS_FAILED', maintenance_run_at=NULL");
  await refuses(update("maintenance_run_at='2026-09-24T10:05:00Z'"), "23514", "retention_state_failed_cycle_check");

  // No completed-has-time constraint: readiness reports such a row as stale.
  await update("state='completed', failure_code=NULL, last_completed_at=NULL, maintenance_run_at='2026-09-24T10:05:00Z'");

  await refuses(update("lease_id='synthetic-maintenance-lease'"), "23514", "retention_state_lease_pair_check");
  await refuses(update("lease_expires_at='2026-09-24T10:20:00Z'"), "23514", "retention_state_lease_pair_check");
  await update("lease_id='synthetic-maintenance-lease', lease_expires_at='2026-09-24T10:20:00Z'");
  await refuses(update("lease_id=NULL"), "23514", "retention_state_lease_pair_check");
  await update("lease_id=NULL, lease_expires_at=NULL");

  await refuses(update("quarantine_objects_deleted=-1"), "23514", "retention_state_quarantine_objects_deleted_check");
  await refuses(update("restored_participants_suppressed=-1"), "23514",
    "retention_state_restored_participants_suppressed_check");
  await refuses(update("schema_version='backend-retention-v0.2'"), "23514", "retention_state_schema_version_check");
  await assert.rejects(update("schema_version=NULL"), (error) => error?.code === "23502");

  const final = await retentionRow(pool, table);
  assert.equal(final.state, "completed");
  assert.equal(final.completed_null, true);
  assert.equal(final.run_null, false);
}));

test("quarantine_reconciliation_state is one never_run singleton with a running-exact lease", {
  skip: SKIP, timeout: 120_000,
}, async () => withSchema(async ({ pool, schema, table }) => {
  const reconciliation = table("quarantine_reconciliation_state");
  const columns = await pool.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='quarantine_reconciliation_state'
      ORDER BY ordinal_position`,
    [schema],
  );
  assert.deepEqual(columns.rows.map(({ column_name, data_type, is_nullable }) => [column_name, data_type, is_nullable]), [
    ["singleton", "integer", "NO"],
    ["schema_version", "text", "NO"],
    ["state", "text", "NO"],
    ["last_started_at", "timestamp with time zone", "YES"],
    ["last_completed_at", "timestamp with time zone", "YES"],
    ["maintenance_run_at", "timestamp with time zone", "YES"],
    ["cutoff_at", "timestamp with time zone", "YES"],
    ["lease_id", "text", "YES"],
    ["registrations_examined", "bigint", "NO"],
    ["orphan_objects_deleted", "bigint", "NO"],
    ["referenced_objects_preserved", "bigint", "NO"],
    ["reconciliation_complete", "boolean", "NO"],
    ["failure_code", "text", "YES"],
  ], "D1 cursor columns are omitted");

  const seeded = await pool.query(
    `SELECT singleton, schema_version, state, last_started_at, last_completed_at, maintenance_run_at, cutoff_at,
            lease_id, registrations_examined::text AS registrations_examined,
            orphan_objects_deleted::text AS orphan_objects_deleted,
            referenced_objects_preserved::text AS referenced_objects_preserved,
            reconciliation_complete, failure_code
       FROM ${reconciliation}`,
  );
  assert.deepEqual(seeded.rows, [{
    singleton: 1, schema_version: "quarantine-reconciliation-v0.1", state: "never_run",
    last_started_at: null, last_completed_at: null, maintenance_run_at: null, cutoff_at: null, lease_id: null,
    registrations_examined: "0", orphan_objects_deleted: "0", referenced_objects_preserved: "0",
    reconciliation_complete: false, failure_code: null,
  }], "seeded exactly once");

  await refuses(pool.query(
    `INSERT INTO ${reconciliation} (singleton, schema_version) VALUES (1, 'quarantine-reconciliation-v0.1')`,
  ), "23505", "quarantine_reconciliation_state_pkey");
  await refuses(pool.query(
    `INSERT INTO ${reconciliation} (singleton, schema_version) VALUES (2, 'quarantine-reconciliation-v0.1')`,
  ), "23514", "quarantine_reconciliation_state_singleton_check");
  assert.equal((await pool.query(`SELECT count(*)::integer AS rows FROM ${reconciliation}`)).rows[0].rows, 1);

  const update = (assignment) => pool.query(`UPDATE ${reconciliation} SET ${assignment} WHERE singleton=1`);
  await refuses(update("state='running'"), "23514", "quarantine_reconciliation_state_lease_check");
  for (const state of ["never_run", "completed", "failed"]) {
    await refuses(update(`state='${state}', lease_id='synthetic-reconciliation-lease'`), "23514",
      "quarantine_reconciliation_state_lease_check");
  }
  await update("state='running', lease_id='synthetic-reconciliation-lease', last_started_at='2026-09-24T10:00:00Z'");
  await refuses(update("lease_id=NULL"), "23514", "quarantine_reconciliation_state_lease_check");
  await update("state='completed', lease_id=NULL, reconciliation_complete=true");

  await refuses(update("state='idle'"), "23514", "quarantine_reconciliation_state_state_check");
  await refuses(update("failure_code='LIFECYCLE_PASS_FAILED'"), "23514", "quarantine_reconciliation_state_failure_code_check");
  await update("state='failed', failure_code='QUARANTINE_RECONCILIATION_FAILED'");
  for (const [counter, constraint] of [
    ["registrations_examined", "quarantine_reconciliation_state_registrations_check"],
    ["orphan_objects_deleted", "quarantine_reconciliation_state_orphans_check"],
    ["referenced_objects_preserved", "quarantine_reconciliation_state_preserved_check"],
  ]) {
    await refuses(update(`${counter}=-1`), "23514", constraint);
  }
  await refuses(update("schema_version='quarantine-reconciliation-v0.2'"), "23514",
    "quarantine_reconciliation_state_schema_version_check");
}));

test("readers render ms-Z instants under a hostile session and return null for absent rows", {
  skip: SKIP, timeout: 120_000,
}, async () => withSchema(async ({ pool, schema, table }) => {
  const lifecycle = await workerModule(MODULE);
  const { withPostgresRead } = await workerModule(CLIENT_MODULE);
  const options = { primarySchema: schema, ledgerSchema: `${schema}_ledger` };

  // The fresh-deploy rows.
  const fresh = await inHostileTransaction(pool, async (client) => ({
    retention: await lifecycle.readPostgresRetentionState(client, options),
    reconciliation: await lifecycle.readPostgresQuarantineReconciliationState(client, options),
  }));
  assert.deepEqual(Object.keys(fresh.retention), RETENTION_KEYS);
  assert.deepEqual(fresh.retention, {
    state: "never_run", lastStartedAt: null, lastCompletedAtMs: null, maintenanceRunAtIso: null,
    quarantineCutoffAt: null, quarantineObjectsDeleted: 0, quarantineRetentionComplete: true,
    restoredParticipantsSuppressed: 0, restoreReplayComplete: true, failureCode: null,
  });
  assert.deepEqual(Object.keys(fresh.reconciliation), RECONCILIATION_KEYS);
  assert.deepEqual(fresh.reconciliation, {
    state: "never_run", lastStartedAt: null, lastCompletedAt: null, maintenanceRunAtIso: null,
    cutoffAt: null, registrationsExamined: 0, orphanObjectsDeleted: 0, referencedObjectsPreserved: 0,
    reconciliationComplete: false, failureCode: null,
  });
  assert.ok(Object.isFrozen(fresh.retention) && Object.isFrozen(fresh.reconciliation));
  assert.equal(lifecycle.maintenanceCyclesMatch(fresh.retention.maintenanceRunAtIso,
    fresh.reconciliation.maintenanceRunAtIso), false, "two absent markers never match");

  // Microsecond instants near a UTC day boundary; Kiritimati is UTC+14.
  await pool.query(
    `UPDATE ${table("retention_state")}
        SET state='completed', last_started_at='2026-09-24T23:50:00.000001Z',
            last_completed_at='2026-09-24T23:59:59.123456Z', maintenance_run_at='2026-09-24T23:59:59.123456Z',
            quarantine_cutoff_at='2026-09-23T23:59:59.999999Z', quarantine_objects_deleted=9007199254740991,
            restored_participants_suppressed=4, quarantine_retention_complete=false, restore_replay_complete=true`,
  );
  await pool.query(
    `UPDATE ${table("quarantine_reconciliation_state")}
        SET state='completed', last_started_at='2026-09-24T23:55:00.5Z', last_completed_at='2026-09-24T23:59:59.9999Z',
            maintenance_run_at='2026-09-24T23:59:59.123456Z', cutoff_at='2026-09-24T22:59:59.123456Z',
            registrations_examined=12, orphan_objects_deleted=5, referenced_objects_preserved=7,
            reconciliation_complete=true`,
  );
  const hostile = await inHostileTransaction(pool, async (client) => {
    const control = await client.query(`SELECT last_completed_at::text AS text FROM ${table("retention_state")}`);
    assert.doesNotMatch(control.rows[0].text, CANONICAL_INSTANT, "the session renders ::text in a non-ISO style");
    assert.match(control.rows[0].text, /\+14$/u);
    return {
      retention: await lifecycle.readPostgresRetentionState(client, options),
      reconciliation: await lifecycle.readPostgresQuarantineReconciliationState(client, options),
    };
  });
  assert.deepEqual(hostile.retention, {
    state: "completed",
    lastStartedAt: "2026-09-24T23:50:00.000Z",
    lastCompletedAtMs: Date.parse("2026-09-24T23:59:59.123Z"),
    maintenanceRunAtIso: "2026-09-24T23:59:59.123Z",
    quarantineCutoffAt: "2026-09-23T23:59:59.999Z",
    quarantineObjectsDeleted: Number.MAX_SAFE_INTEGER,
    quarantineRetentionComplete: false,
    restoredParticipantsSuppressed: 4,
    restoreReplayComplete: true,
    failureCode: null,
  });
  assert.deepEqual(hostile.reconciliation, {
    state: "completed",
    lastStartedAt: "2026-09-24T23:55:00.500Z",
    lastCompletedAt: "2026-09-24T23:59:59.999Z",
    maintenanceRunAtIso: "2026-09-24T23:59:59.123Z",
    cutoffAt: "2026-09-24T22:59:59.123Z",
    registrationsExamined: 12,
    orphanObjectsDeleted: 5,
    referencedObjectsPreserved: 7,
    reconciliationComplete: true,
    failureCode: null,
  });
  assert.equal(lifecycle.maintenanceCyclesMatch(hostile.retention.maintenanceRunAtIso,
    hostile.reconciliation.maintenanceRunAtIso), true);

  // The shared read boundary composes with the readers unchanged.
  const bounded = await withPostgresRead(pool, async (client) => ({
    retention: await lifecycle.readPostgresRetentionState(client, options),
    reconciliation: await lifecycle.readPostgresQuarantineReconciliationState(client, options),
  }), { operation: "lifecycle_state.test_read" });
  assert.deepEqual(bounded, hostile);

  // A one-millisecond cycle difference does not match.
  await pool.query(`UPDATE ${table("quarantine_reconciliation_state")} SET maintenance_run_at='2026-09-24T23:59:59.124Z'`);
  const shifted = await withPostgresRead(pool, (client) =>
    lifecycle.readPostgresQuarantineReconciliationState(client, options));
  assert.equal(shifted.maintenanceRunAtIso, "2026-09-24T23:59:59.124Z");
  assert.equal(lifecycle.maintenanceCyclesMatch(hostile.retention.maintenanceRunAtIso, shifted.maintenanceRunAtIso), false);

  // Absent rows read as null, never as a defaulted state.
  await pool.query(`DELETE FROM ${table("retention_state")}`);
  await pool.query(`DELETE FROM ${table("quarantine_reconciliation_state")}`);
  const absent = await inHostileTransaction(pool, async (client) => ({
    retention: await lifecycle.readPostgresRetentionState(client, options),
    reconciliation: await lifecycle.readPostgresQuarantineReconciliationState(client, options),
  }));
  assert.deepEqual(absent, { retention: null, reconciliation: null });
}));

test("readers throw StateShapeError for values outside the contract, including out-of-enum rows in an unchecked scratch copy", {
  skip: SKIP, timeout: 120_000,
}, async () => withSchema(async ({ pool, schema, table, scratch }) => {
  const lifecycle = await workerModule(MODULE);
  const live = { primarySchema: schema, ledgerSchema: `${schema}_ledger` };
  const read = (reader, options) => inHostileTransaction(pool, (client) => lifecycle[reader](client, options));
  const shapeError = (relation, field) => (error) => {
    assert.ok(error instanceof lifecycle.StateShapeError, `expected StateShapeError, got ${error?.name}`);
    assert.equal(error.name, "StateShapeError");
    assert.equal(error.code, "LIFECYCLE_STATE_SHAPE_INVALID");
    assert.equal(error.message, "LIFECYCLE_STATE_SHAPE_INVALID", "the message carries no stored value");
    assert.equal(error.relation, relation);
    assert.equal(error.field, field);
    return true;
  };

  // Values the live constraints admit but the readers must still refuse:
  // an unsafe counter and instants without a four-digit ISO form.
  const retention = table("retention_state");
  await pool.query(`UPDATE ${retention} SET quarantine_objects_deleted=9007199254740992`);
  await assert.rejects(read("readPostgresRetentionState", live),
    shapeError("retention_state", "quarantine_objects_deleted"));
  await pool.query(`UPDATE ${retention} SET quarantine_objects_deleted=0`);
  for (const value of ["infinity", "-infinity", "0044-03-15 12:00:00+00 BC", "10000-01-01 00:00:00+00"]) {
    await pool.query(`UPDATE ${retention} SET last_completed_at=$1::timestamptz`, [value]);
    await assert.rejects(read("readPostgresRetentionState", live), shapeError("retention_state", "last_completed_at"));
  }
  await pool.query(`UPDATE ${table("quarantine_reconciliation_state")} SET cutoff_at='infinity'`);
  await assert.rejects(read("readPostgresQuarantineReconciliationState", live),
    shapeError("quarantine_reconciliation_state", "cutoff_at"));

  // A scratch copy with no CHECK or key constraints admits rows the live
  // schema refuses.
  const copy = await scratch();
  for (const relation of ["retention_state", "quarantine_reconciliation_state"]) {
    await pool.query(`CREATE TABLE ${table(relation, copy)} (LIKE ${table(relation)} INCLUDING DEFAULTS)`);
  }
  const unchecked = await pool.query(
    `SELECT count(*)::integer AS constraints FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
      WHERE n.nspname=$1 AND c.contype IN ('c','p','u')`,
    [copy],
  );
  assert.equal(unchecked.rows[0].constraints, 0, "the scratch copy has no CHECK or key constraints");
  const scratchOptions = { primarySchema: copy, ledgerSchema: `${copy}_ledger` };
  const seedRetention = () => pool.query(
    `INSERT INTO ${table("retention_state", copy)} (singleton) VALUES (1)`,
  );
  const seedReconciliation = () => pool.query(
    `INSERT INTO ${table("quarantine_reconciliation_state", copy)} (singleton, schema_version)
     VALUES (1, 'quarantine-reconciliation-v0.1')`,
  );
  await seedRetention();
  await seedReconciliation();
  const baseline = await read("readPostgresRetentionState", scratchOptions);
  assert.equal(baseline.state, "never_run", "the unchecked copy reads normally before tampering");
  assert.equal((await read("readPostgresQuarantineReconciliationState", scratchOptions)).state, "never_run");

  const retentionCases = [
    ["state='idle'", "state"],
    ["state='NEVER_RUN'", "state"],
    ["schema_version='backend-retention-v0.0'", "schema_version"],
    ["failure_code='SYNTHETIC_OTHER_FAILURE'", "failure_code"],
    ["failure_code='QUARANTINE_RECONCILIATION_FAILED'", "failure_code"],
    ["restored_participants_suppressed=-1", "restored_participants_suppressed"],
  ];
  for (const [assignment, field] of retentionCases) {
    await pool.query(`DELETE FROM ${table("retention_state", copy)}`);
    await seedRetention();
    await pool.query(`UPDATE ${table("retention_state", copy)} SET ${assignment}`);
    await assert.rejects(read("readPostgresRetentionState", scratchOptions), shapeError("retention_state", field));
  }
  const reconciliationCases = [
    ["state='paused'", "state"],
    ["schema_version='quarantine-reconciliation-v0.2'", "schema_version"],
    ["failure_code='LIFECYCLE_PASS_FAILED'", "failure_code"],
    ["orphan_objects_deleted=-1", "orphan_objects_deleted"],
  ];
  for (const [assignment, field] of reconciliationCases) {
    await pool.query(`DELETE FROM ${table("quarantine_reconciliation_state", copy)}`);
    await seedReconciliation();
    await pool.query(`UPDATE ${table("quarantine_reconciliation_state", copy)} SET ${assignment}`);
    await assert.rejects(read("readPostgresQuarantineReconciliationState", scratchOptions),
      shapeError("quarantine_reconciliation_state", field));
  }

  // Without a primary key two singleton rows can exist; that is not a state.
  await pool.query(`DELETE FROM ${table("retention_state", copy)}`);
  await seedRetention();
  await seedRetention();
  await assert.rejects(read("readPostgresRetentionState", scratchOptions), shapeError("retention_state", "singleton"));
}));

test("maintenanceCyclesMatch requires two present, canonical and identical instants", {
  timeout: 60_000,
}, async () => {
  const { maintenanceCyclesMatch, readPostgresRetentionState, StateShapeError } = await workerModule(MODULE);
  const instant = "2026-09-24T23:59:59.123Z";
  assert.equal(maintenanceCyclesMatch(instant, instant), true);
  assert.equal(maintenanceCyclesMatch(instant, "2026-09-24T23:59:59.124Z"), false);
  assert.equal(maintenanceCyclesMatch(null, null), false);
  assert.equal(maintenanceCyclesMatch(undefined, undefined), false);
  assert.equal(maintenanceCyclesMatch(instant, null), false);
  assert.equal(maintenanceCyclesMatch(null, instant), false);
  for (const text of ["2026-09-24 23:59:59.123+00", "2026-09-24T23:59:59.123456Z", "2026-09-24T23:59:59Z",
    "24/09/2026 23:59:59.123 UTC", "2026-02-30T00:00:00.000Z", ""]) {
    assert.equal(maintenanceCyclesMatch(text, text), false, `non-canonical ${JSON.stringify(text)} never matches`);
  }

  // Driver-level shape defects are refused without PostgreSQL.
  const fake = (rows) => ({ async query() { return { rows, rowCount: rows?.length ?? null }; }, release() {} });
  const good = {
    schema_version: "backend-retention-v0.1", state: "never_run", last_started_at: null, last_completed_at: null,
    maintenance_run_at: null, quarantine_cutoff_at: null, quarantine_objects_deleted: "0",
    quarantine_retention_complete: true, restored_participants_suppressed: "0", restore_replay_complete: true,
    failure_code: null,
  };
  assert.equal((await readPostgresRetentionState(fake([good]))).state, "never_run");
  assert.equal(await readPostgresRetentionState(fake([])), null);
  const defects = [
    [{ ...good, quarantine_retention_complete: "t" }, "quarantine_retention_complete"],
    [{ ...good, quarantine_objects_deleted: 0 }, "quarantine_objects_deleted"],
    [{ ...good, quarantine_objects_deleted: "007" }, "quarantine_objects_deleted"],
    [{ ...good, quarantine_objects_deleted: "90071992547409910" }, "quarantine_objects_deleted"],
    [{ ...good, last_started_at: "out-of-range" }, "last_started_at"],
    [{ ...good, last_started_at: "2026-09-24 23:59:59.123+00" }, "last_started_at"],
    [{ ...good, last_completed_at: undefined }, "last_completed_at"],
    [{ ...good, state: undefined }, "state"],
  ];
  for (const [row, field] of defects) {
    await assert.rejects(readPostgresRetentionState(fake([row])), (error) =>
      error instanceof StateShapeError && error.field === field && error.relation === "retention_state");
  }
  await assert.rejects(readPostgresRetentionState(fake(undefined)), (error) =>
    error instanceof StateShapeError && error.field === "singleton");
  await assert.rejects(readPostgresRetentionState(fake([good, good])), (error) =>
    error instanceof StateShapeError && error.field === "singleton");
  await assert.rejects(readPostgresRetentionState(fake([good]), { primarySchema: "pg_catalog" }), TypeError);
});
