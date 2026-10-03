import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations, renderPostgresSearchPath } from "../scripts/postgres-migrations.mjs";

/*
 * PostgreSQL 17 qualification for the MP-2-lite lifecycle and
 * quarantine-reconciliation pass (src/postgres-lifecycle-pass.ts, OD-CR-4).
 *
 * Readiness is judged by WORKER_READINESS below: a verbatim port of the
 * d43c8f92 Worker handleReady computation for typed storage (src/index.ts
 * lifecycleReadiness and handleReady; BACKEND_LIFECYCLE_STALE_MILLISECONDS
 * from src/constants.ts) over the shared PostgreSQL readers. When the RD-2
 * builder (src/postgres-readiness.ts) is present in the checkout, every body
 * is also compared with buildPostgresReadinessBody, so the two can never
 * drift silently once they meet.
 *
 * Each test creates its own schema, prefixed c_maint_, applies the promoted
 * primary chain through the production runner and drops the schema
 * afterwards. Every row, key and object is synthetic and content-free.
 */

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER || "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD || "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";
const SKIP = !PG_TEST_HOST && !PG_TEST_SOCKET;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRIMARY_MIGRATIONS = join(WORKER_ROOT, "postgres", "migrations", "primary");
const READINESS_BUILDER = join(WORKER_ROOT, "src", "postgres-readiness.ts");
const SOCKET_DIRECTORY = /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u;
const STALE_AFTER = 2 * 60 * 60 * 1_000;
const SAFETY_WINDOW = 24 * 60 * 60 * 1_000;
/** The d43c8f92 Worker's QUARANTINE_RECONCILIATION_BATCH_SIZE: one batch per one-minute cron. */
const PAGE = 100;
const MINUTE = 60_000;
const BASE_CYCLE = Date.parse("2026-10-02T12:00:00.000Z");

/** The 0064 section (4) pins, verbatim from claude/gcp-fp-w3-simp 3a93c7d1 (OD-1). */
const RESIDUE_0064_RETENTION_PINS = `ALTER TABLE retention_state
  DROP CONSTRAINT retention_state_restored_participants_suppressed_check,
  ADD CONSTRAINT retention_state_restored_participants_suppressed_check
    CHECK (restored_participants_suppressed = 0),
  ADD CONSTRAINT retention_state_restore_replay_complete_check
    CHECK (restore_replay_complete);`;

async function endpoint() {
  const socket = PG_TEST_SOCKET || (PG_TEST_HOST?.startsWith("/") ? PG_TEST_HOST : undefined);
  assert.ok(socket || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "lifecycle pass tests require loopback or a private Unix socket");
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
const loaded = new Map();

async function connection() {
  if (!sharedPool) {
    const { host, port, socket } = await endpoint();
    const pool = new pg.Pool({
      host, port, user: PG_TEST_USER, password: PG_TEST_PASSWORD, database: PG_TEST_DATABASE,
      ssl: false, max: 6, connectionTimeoutMillis: 5_000, application_name: "c-maint-lifecycle-pass-test",
    });
    pool.on("error", () => {});
    try {
      const server = await pool.query(
        "SELECT current_setting('server_version_num')::integer AS version, host(inet_server_addr()) AS address",
      );
      assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "the pass is qualified on PostgreSQL 17");
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
  if (!loaded.has(path)) loaded.set(path, await sharedVite.ssrLoadModule(path));
  return loaded.get(path);
}

after(async () => {
  if (sharedVite) await sharedVite.close();
  if (sharedPool) await sharedPool.end();
});

function quoted(schema) {
  assert.match(schema, /^c_maint_[a-z0-9_]{1,54}$/u);
  return `"${schema}"`;
}

/**
 * A pool whose clients run in a far-from-UTC session time zone, so every
 * instant the pass writes must carry its own offset. DateStyle stays ISO: the
 * pg driver (and so the reused reconciler's registered_at check) parses only
 * the ISO text form.
 */
function hostile(pool) {
  return {
    async connect() {
      const client = await pool.connect();
      await client.query("SET TimeZone='Pacific/Kiritimati'");
      return {
        query: (text, values) => client.query(text, values),
        async release(discard) {
          if (!discard) {
            try { await client.query("RESET ALL"); } catch { discard = true; }
          }
          client.release(discard);
        },
      };
    },
  };
}

/** Apply the 0064 retention pins unless the promoted chain already carries 0064. */
async function applyResiduePins(pool, schema) {
  const promoted = (await readdir(PRIMARY_MIGRATIONS)).some((name) => name.endsWith("_append_only_residue.sql"));
  if (promoted) return "promoted";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(renderPostgresSearchPath(schema));
    await client.query(RESIDUE_0064_RETENTION_PINS);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return "inline";
}

/**
 * Run `body` against a fresh schema migrated by the production runner to the
 * promoted head, which must equal the image manifest the pass checks.
 */
async function withSchema(body, { pins = false } = {}) {
  const pool = await connection();
  const { POSTGRES_RUNTIME_MIGRATIONS } = await workerModule("/src/postgres-runtime-schema.ts");
  const schema = `c_maint_lp_${randomBytes(6).toString("hex")}`;
  await pool.query(`CREATE SCHEMA ${quoted(schema)}`);
  try {
    const applied = await applyPostgresMigrations({ role: "primary", schema, pool });
    assert.equal(applied.applied, POSTGRES_RUNTIME_MIGRATIONS.primary.length,
      "the promoted chain is the image manifest the pass expects");
    const pinned = pins ? await applyResiduePins(pool, schema) : null;
    const table = (name) => {
      assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/u);
      return `${quoted(schema)}."${name}"`;
    };
    await body({ pool, schema, table, pinned, expected: POSTGRES_RUNTIME_MIGRATIONS.primary });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quoted(schema)} CASCADE`);
  }
}

function syntheticStore() {
  const objects = new Set();
  const calls = { head: 0, delete: 0 };
  let failDelete = false;
  return {
    objects,
    calls,
    failNextDelete() { failDelete = true; },
    async head(key) {
      calls.head += 1;
      return objects.has(key) ? { version: "synthetic-generation-1", size: 1 } : null;
    },
    async delete(key) {
      calls.delete += 1;
      if (failDelete) {
        failDelete = false;
        throw new Error("synthetic provider failure");
      }
      objects.delete(key);
    },
  };
}

/** The d43c8f92 Worker handleReady body for typed storage, from the PostgreSQL readers. */
function WORKER_READINESS(retention, reconciliation, nowEpoch) {
  let lifecycle;
  if (retention.state !== "completed") {
    lifecycle = { fresh: false, state: retention.state };
  } else {
    const completedEpoch = retention.lastCompletedAtMs === null ? Number.NaN : retention.lastCompletedAtMs;
    const fresh = Number.isFinite(completedEpoch)
      && completedEpoch <= nowEpoch
      && nowEpoch - completedEpoch <= STALE_AFTER;
    if (!fresh) lifecycle = { fresh: false, state: "stale" };
    else if (!retention.quarantineRetentionComplete || !retention.restoreReplayComplete) {
      lifecycle = { fresh: true, state: "incomplete" };
    } else lifecycle = { fresh: true, state: "ready" };
  }
  const maintenanceCycleMatched = retention.maintenanceRunAtIso !== null
    && reconciliation.maintenanceRunAtIso === retention.maintenanceRunAtIso;
  const reconciliationComplete = reconciliation.state === "completed"
    && reconciliation.reconciliationComplete
    && maintenanceCycleMatched;
  const ready = lifecycle.state === "ready" && reconciliationComplete;
  return {
    httpStatus: ready ? 200 : 503,
    body: {
      status: ready ? "ready" : "not_ready",
      checks: {
        lifecycle: lifecycle.state,
        lifecycleFresh: lifecycle.fresh,
        quarantineRetentionComplete: retention.quarantineRetentionComplete,
        restoreReplayComplete: retention.restoreReplayComplete,
        aggregateRebuildComplete: false,
        aggregateRebuildDelegated: true,
        maintenanceCycleMatched,
        quarantineReconciliation: reconciliation.state,
        quarantineReconciliationComplete: reconciliationComplete,
      },
      policy: { lifecycleStaleAfterMilliseconds: STALE_AFTER },
    },
  };
}

/** Read both rows in one read-only snapshot and judge them as the Worker would. */
async function readiness(pool, schema, nowEpoch) {
  const state = await workerModule("/src/postgres-lifecycle-state.ts");
  const client = await pool.connect();
  let retention;
  let reconciliation;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    retention = await state.readPostgresRetentionState(client, { primarySchema: schema });
    reconciliation = await state.readPostgresQuarantineReconciliationState(client, { primarySchema: schema });
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  assert.ok(retention && reconciliation, "a migrated origin has both singleton rows");
  const expected = WORKER_READINESS(retention, reconciliation, nowEpoch);
  if (existsSync(READINESS_BUILDER)) {
    const builder = await workerModule("/src/postgres-readiness.ts");
    const actual = builder.buildPostgresReadinessBody({ retention, reconciliation }, nowEpoch,
      { semantics: "worker-exact" });
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, "RD-2 builder matches the Worker port");
  }
  return expected;
}

/** Both singleton rows with their row versions: equal snapshots mean no write. */
async function snapshot(pool, table) {
  const rows = await pool.query(
    `SELECT 'retention' AS relation, xmin::text AS version, to_jsonb(r) AS row FROM ${table("retention_state")} r
     UNION ALL
     SELECT 'reconciliation', xmin::text, to_jsonb(q) FROM ${table("quarantine_reconciliation_state")} q
     ORDER BY 1`,
  );
  return rows.rows;
}

async function pendingCount(pool, table) {
  return (await pool.query(`SELECT count(*)::int AS count FROM ${table("pending_objects")}`)).rows[0].count;
}

async function seedPending(pool, table, store, count, registeredEpoch) {
  const ids = [];
  const keys = [];
  for (let index = 0; index < count; index += 1) {
    const key = `synthetic/c-maint/${randomUUID()}`;
    keys.push(key);
    ids.push(`synthetic-c-maint-${randomUUID()}`);
    store.objects.add(key);
  }
  await pool.query(
    `INSERT INTO ${table("pending_objects")}
       (contribution_id, object_key, object_kind, registered_at, reconciliation_state)
     SELECT seed.id, seed.key, 'synthetic', $3::timestamptz, 'registered'
       FROM unnest($1::text[], $2::text[]) AS seed(id, key)`,
    [ids, keys, new Date(registeredEpoch).toISOString()],
  );
  return keys;
}

/** One aged 'deleting' claim whose lease is stale: the next pass deletes its object. */
async function seedStaleClaim(pool, table, store, staleEpoch) {
  const key = `synthetic/c-maint/${randomUUID()}`;
  store.objects.add(key);
  await pool.query(
    `INSERT INTO ${table("pending_objects")}
       (contribution_id, object_key, object_kind, registered_at, reconciliation_state, reconciliation_lease_id)
     VALUES ($1, $2, 'synthetic', $3, 'deleting', $4)`,
    [`synthetic-c-maint-${randomUUID()}`, key, iso(staleEpoch),
      `pgq1:${String(staleEpoch).padStart(13, "0")}:${randomUUID().replaceAll("-", "")}`],
  );
  return key;
}

/** A synthetic store whose head() first runs `hook`: a point inside the reconciliation page. */
function storeWithHeadHook(hook) {
  const base = syntheticStore();
  return {
    objects: base.objects,
    calls: base.calls,
    async head(key) {
      await hook();
      return base.head(key);
    },
    delete: (key) => base.delete(key),
  };
}

async function lifecycleRunAt(pool, table) {
  return (await pool.query(
    `SELECT to_char(maintenance_run_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS run_at
       FROM ${table("retention_state")}`,
  )).rows[0].run_at;
}

async function reconciliationRow(pool, table) {
  return (await pool.query(
    `SELECT state, lease_id, failure_code, reconciliation_complete,
            registrations_examined::int AS examined, orphan_objects_deleted::int AS orphans,
            referenced_objects_preserved::int AS preserved,
            to_char(maintenance_run_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS run_at,
            to_char(cutoff_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS cutoff_at
       FROM ${table("quarantine_reconciliation_state")}`,
  )).rows[0];
}

const RESULT_KEYS = Object.freeze([
  "schemaVersion", "outcome", "code", "changed", "cycle", "lockAcquired", "lifecycleComplete",
  "lifecycleWritten", "quarantineRetentionComplete", "quarantineObjectsDeleted", "reconciliation",
  "quarantineReconciliationComplete", "maintenancePurges", "appendOnlyNotApplicable",
]);
/** The folded purges of a pass that found nothing to purge (MAINT-PURGE). */
const NOTHING_PURGED = Object.freeze({
  identity: { purged: 0, complete: true },
  deviceLifecycle: {
    pairingsRevoked: 0, devicesRevoked: 0, uploadsRevoked: 0, rotationsPurged: 0, pairingEventsPurged: 0,
    complete: true,
  },
  complete: true,
});
const NOT_APPLICABLE = Object.freeze({
  restoreReplayComplete: true, deletionTombstoneRetentionComplete: true, ownerErasureJobsComplete: true,
});

function iso(epoch) { return new Date(epoch).toISOString(); }

async function runPass({ pool, schema, expected }, cycleEpoch, overrides = {}) {
  const { runPostgresLifecyclePass } = await workerModule("/src/postgres-lifecycle-pass.ts");
  const result = await runPostgresLifecyclePass({
    pool: hostile(pool),
    objectStore: overrides.objectStore ?? syntheticStore(),
    schema: { primarySchema: schema },
    cycleEpoch,
    expectedPrimaryMigrations: overrides.expected ?? expected,
    clock: overrides.clock ?? (() => cycleEpoch + 1_500),
  });
  assert.deepEqual(Object.keys(result), RESULT_KEYS);
  assert.equal(result.schemaVersion, "postgres-lifecycle-pass-v1");
  assert.equal(result.cycle, iso(cycleEpoch));
  assert.equal(result.quarantineObjectsDeleted, 0);
  assert.deepEqual({ ...result.appendOnlyNotApplicable }, NOT_APPLICABLE, "OD-4 constants");
  assert.doesNotMatch(JSON.stringify(result), /synthetic\/c-maint|synthetic-c-maint/u, "content-free result");
  return result;
}

test("an empty origin reads not_ready until the first pass, then ready; a repeated pass changes nothing", {
  skip: SKIP, timeout: 180_000,
}, async () => withSchema(async (context) => {
  const { pool, schema, table } = context;
  const fresh = await readiness(pool, schema, BASE_CYCLE);
  assert.equal(fresh.httpStatus, 503);
  assert.deepEqual(fresh.body, {
    status: "not_ready",
    checks: {
      lifecycle: "never_run", lifecycleFresh: false, quarantineRetentionComplete: true,
      restoreReplayComplete: true, aggregateRebuildComplete: false, aggregateRebuildDelegated: true,
      maintenanceCycleMatched: false, quarantineReconciliation: "never_run",
      quarantineReconciliationComplete: false,
    },
    policy: { lifecycleStaleAfterMilliseconds: STALE_AFTER },
  });

  const first = await runPass(context, BASE_CYCLE);
  assert.equal(first.outcome, "complete");
  assert.equal(first.code, "LIFECYCLE_PASS_COMPLETE");
  assert.equal(first.changed, true);
  assert.equal(first.lockAcquired, true);
  assert.equal(first.lifecycleWritten, true);
  assert.equal(first.lifecycleComplete, true);
  assert.equal(first.quarantineRetentionComplete, true);
  assert.equal(first.quarantineReconciliationComplete, true);
  assert.deepEqual({ ...first.reconciliation }, {
    registrationsExamined: 0, deletionGraceStarted: 0, legacyLeasesAdopted: 0, orphanObjectsDeleted: 0,
    orphanObjectsAlreadyAbsent: 0, referencedObjectsPreserved: 0, candidatesDeferred: 0, hasMore: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(first.maintenancePurges)), NOTHING_PURGED);

  const ready = await readiness(pool, schema, BASE_CYCLE + 2_000);
  assert.equal(ready.httpStatus, 200);
  assert.deepEqual(ready.body.checks, {
    lifecycle: "ready", lifecycleFresh: true, quarantineRetentionComplete: true, restoreReplayComplete: true,
    aggregateRebuildComplete: false, aggregateRebuildDelegated: true, maintenanceCycleMatched: true,
    quarantineReconciliation: "completed", quarantineReconciliationComplete: true,
  });
  assert.equal(ready.body.status, "ready");

  const retention = (await pool.query(
    `SELECT state, schema_version, restore_replay_complete, restored_participants_suppressed::int AS suppressed,
            quarantine_retention_complete, quarantine_objects_deleted::int AS deleted,
            quarantine_cutoff_at IS NULL AS cutoff_null, lease_id, lease_expires_at, failure_code,
            to_char(last_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started,
            to_char(last_completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS completed,
            to_char(maintenance_run_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS run_at
       FROM ${table("retention_state")}`,
  )).rows[0];
  assert.deepEqual(retention, {
    state: "completed", schema_version: "backend-retention-v0.1", restore_replay_complete: true, suppressed: 0,
    quarantine_retention_complete: true, deleted: 0, cutoff_null: true, lease_id: null, lease_expires_at: null,
    failure_code: null, started: iso(BASE_CYCLE), completed: iso(BASE_CYCLE + 1_500), run_at: iso(BASE_CYCLE),
  });
  assert.deepEqual(await reconciliationRow(pool, table), {
    state: "completed", lease_id: null, failure_code: null, reconciliation_complete: true,
    examined: 0, orphans: 0, preserved: 0, run_at: iso(BASE_CYCLE), cutoff_at: iso(BASE_CYCLE - SAFETY_WINDOW),
  });

  // A retry of the same cycle (a Cloud Run task retry inside one minute)
  // commits nothing: both rows keep their row versions.
  const before = await snapshot(pool, table);
  const repeat = await runPass(context, BASE_CYCLE, { clock: () => BASE_CYCLE + 9_000 });
  assert.equal(repeat.outcome, "complete");
  assert.equal(repeat.code, "LIFECYCLE_CYCLE_ALREADY_COMPLETE");
  assert.equal(repeat.changed, false);
  assert.equal(repeat.lifecycleWritten, false);
  assert.equal(repeat.reconciliation, null);
  assert.equal(repeat.maintenancePurges, null, "a cycle already complete ran its purges with its first pass");
  assert.deepEqual(await snapshot(pool, table), before);

  // The next cycle moves both markers together and stays ready.
  const next = await runPass(context, BASE_CYCLE + MINUTE);
  assert.equal(next.code, "LIFECYCLE_PASS_COMPLETE");
  assert.equal(next.changed, true);
  const nextReady = await readiness(pool, schema, BASE_CYCLE + MINUTE + 2_000);
  assert.equal(nextReady.body.status, "ready");
  assert.equal((await reconciliationRow(pool, table)).run_at, iso(BASE_CYCLE + MINUTE));

  // Worker parity beyond the pass: two hours without one reads stale.
  const stale = await readiness(pool, schema, BASE_CYCLE + MINUTE + 1_500 + STALE_AFTER + 1);
  assert.equal(stale.httpStatus, 503);
  assert.equal(stale.body.checks.lifecycle, "stale");
  assert.equal(stale.body.checks.lifecycleFresh, false);
}));

test("a backlog of up to the Worker's batch of 100 completes in one pass, as one Worker cron does", {
  skip: SKIP, timeout: 240_000,
}, async () => withSchema(async (context) => {
  const { pool, schema, table } = context;
  const { POSTGRES_LIFECYCLE_PASS_RECONCILIATION_PAGE_SIZE } = await workerModule("/src/postgres-lifecycle-pass.ts");
  assert.equal(POSTGRES_LIFECYCLE_PASS_RECONCILIATION_PAGE_SIZE, PAGE);
  const store = syntheticStore();

  // 53 due registrations: the Worker completes them in one cron; so does the pass.
  await seedPending(pool, table, store, 53, BASE_CYCLE - 2 * SAFETY_WINDOW);
  const first = await runPass(context, BASE_CYCLE, { objectStore: store });
  assert.equal(first.outcome, "complete");
  assert.equal(first.code, "LIFECYCLE_PASS_COMPLETE");
  assert.equal(first.reconciliation.registrationsExamined, 53);
  assert.equal(first.reconciliation.deletionGraceStarted, 53);
  assert.equal(first.reconciliation.hasMore, false);
  assert.equal(first.quarantineReconciliationComplete, true);
  assert.equal(store.calls.head + store.calls.delete, 0, "the first pass makes no object call");
  const ready = await readiness(pool, schema, BASE_CYCLE + 2_000);
  assert.equal(ready.httpStatus, 200);
  assert.equal(ready.body.status, "ready");

  // Exactly the batch, 100 newly due registrations, also completes in one pass.
  const second = BASE_CYCLE + MINUTE;
  await seedPending(pool, table, store, PAGE, second - 2 * SAFETY_WINDOW);
  const full = await runPass(context, second, { objectStore: store });
  assert.equal(full.outcome, "complete");
  assert.equal(full.reconciliation.registrationsExamined, PAGE);
  assert.equal(full.reconciliation.deletionGraceStarted, PAGE);
  assert.equal(full.reconciliation.hasMore, false);
  assert.equal((await reconciliationRow(pool, table)).examined, PAGE, "a completed run starts its counters at 0");
  assert.equal((await readiness(pool, schema, second + 2_000)).body.status, "ready");

  // A safety window after each grace started, each set of claims is deleted in one pass.
  const firstDeletion = await runPass(context, BASE_CYCLE + SAFETY_WINDOW, { objectStore: store });
  assert.equal(firstDeletion.outcome, "complete");
  assert.equal(firstDeletion.reconciliation.orphanObjectsDeleted, 53);
  const secondDeletion = await runPass(context, second + SAFETY_WINDOW, { objectStore: store });
  assert.equal(secondDeletion.outcome, "complete");
  assert.equal(secondDeletion.reconciliation.orphanObjectsDeleted, PAGE);
  assert.equal(store.objects.size, 0);
  assert.equal(await pendingCount(pool, table), 0);
  assert.equal((await readiness(pool, schema, second + SAFETY_WINDOW + 2_000)).body.status, "ready");
}));

test("a backlog above the batch reads not_ready, resumes its counters and drains in later passes", {
  skip: SKIP, timeout: 240_000,
}, async () => withSchema(async (context) => {
  const { pool, schema, table } = context;
  const store = syntheticStore();
  const total = PAGE + 3;
  await seedPending(pool, table, store, total, BASE_CYCLE - 2 * SAFETY_WINDOW);

  // Pass 1: one batch starts the deletion grace of 100 registrations; 3 remain due.
  const first = await runPass(context, BASE_CYCLE, { objectStore: store });
  assert.equal(first.outcome, "partial");
  assert.equal(first.code, "QUARANTINE_RECONCILIATION_BACKLOG");
  assert.equal(first.reconciliation.registrationsExamined, PAGE);
  assert.equal(first.reconciliation.deletionGraceStarted, PAGE);
  assert.equal(first.reconciliation.hasMore, true);
  assert.equal(first.quarantineReconciliationComplete, false);
  assert.equal(store.calls.head + store.calls.delete, 0, "the first pass makes no object call");
  const backlog = await readiness(pool, schema, BASE_CYCLE + 2_000);
  assert.equal(backlog.httpStatus, 503);
  assert.equal(backlog.body.checks.lifecycle, "ready");
  assert.equal(backlog.body.checks.maintenanceCycleMatched, true);
  assert.equal(backlog.body.checks.quarantineReconciliation, "completed");
  assert.equal(backlog.body.checks.quarantineReconciliationComplete, false);
  assert.equal((await reconciliationRow(pool, table)).examined, PAGE);

  // A retry of an incomplete cycle continues the work instead of replaying it.
  const retry = await runPass(context, BASE_CYCLE, { objectStore: store });
  assert.equal(retry.outcome, "complete");
  assert.equal(retry.lifecycleWritten, false, "the lifecycle row already holds this cycle");
  assert.equal(retry.reconciliation.registrationsExamined, total - PAGE);
  const resumed = await reconciliationRow(pool, table);
  assert.equal(resumed.examined, total, "a resumed backlog keeps its cumulative counters");
  assert.equal(resumed.reconciliation_complete, true);
  assert.equal((await readiness(pool, schema, BASE_CYCLE + 3_000)).body.status, "ready");

  // After a full safety window the deleting claims are due: the first pass
  // deletes one batch and reads not_ready, the next minute's pass drains the
  // rest, and the fresh run starts its counters at 0.
  const later = BASE_CYCLE + 2 * SAFETY_WINDOW;
  const third = await runPass(context, later, { objectStore: store });
  assert.equal(third.outcome, "partial");
  assert.equal(third.reconciliation.orphanObjectsDeleted, PAGE);
  assert.equal((await reconciliationRow(pool, table)).examined, PAGE, "a new backlog starts from zero");
  assert.equal((await readiness(pool, schema, later + 2_000)).body.status, "not_ready");
  const fourth = await runPass(context, later + MINUTE, { objectStore: store });
  assert.equal(fourth.outcome, "complete");
  assert.equal(fourth.reconciliation.orphanObjectsDeleted, total - PAGE);
  const drained = await reconciliationRow(pool, table);
  assert.equal(drained.orphans, total);
  assert.equal(drained.examined, total);
  assert.equal(store.objects.size, 0);
  assert.equal(await pendingCount(pool, table), 0);
  assert.equal((await readiness(pool, schema, later + MINUTE + 2_000)).body.status, "ready");
}));

test("a killed pass's running row is taken over, and a storage failure is recorded then recovered", {
  skip: SKIP, timeout: 180_000,
}, async () => withSchema(async (context) => {
  const { pool, schema, table } = context;
  assert.equal((await runPass(context, BASE_CYCLE)).outcome, "complete");

  // A pass killed after taking the reconciliation row mid-backlog.
  await pool.query(
    `UPDATE ${table("quarantine_reconciliation_state")}
        SET state = 'running', lease_id = $1, maintenance_run_at = $2, last_started_at = $2,
            reconciliation_complete = false, registrations_examined = 7
      WHERE singleton = 1`,
    [`pglp1:${String(BASE_CYCLE + MINUTE).padStart(13, "0")}:${"0".repeat(32)}`, iso(BASE_CYCLE + MINUTE)],
  );
  const killed = await readiness(pool, schema, BASE_CYCLE + MINUTE + 1_000);
  assert.equal(killed.body.checks.quarantineReconciliation, "running");
  assert.equal(killed.body.status, "not_ready");
  const takeover = await runPass(context, BASE_CYCLE + 2 * MINUTE);
  assert.equal(takeover.outcome, "complete");
  const taken = await reconciliationRow(pool, table);
  assert.equal(taken.state, "completed");
  assert.equal(taken.lease_id, null);
  assert.equal(taken.examined, 7, "the interrupted backlog resumes its counters");
  assert.equal((await readiness(pool, schema, BASE_CYCLE + 2 * MINUTE + 2_000)).body.status, "ready");

  // A provider failure keeps the exact deleting claim and records the failure.
  const store = syntheticStore();
  const key = `synthetic/c-maint/${randomUUID()}`;
  store.objects.add(key);
  const staleEpoch = BASE_CYCLE - 3 * SAFETY_WINDOW;
  await pool.query(
    `INSERT INTO ${table("pending_objects")}
       (contribution_id, object_key, object_kind, registered_at, reconciliation_state, reconciliation_lease_id)
     VALUES ($1, $2, 'synthetic', $3, 'deleting', $4)`,
    [`synthetic-c-maint-${randomUUID()}`, key, iso(staleEpoch),
      `pgq1:${String(staleEpoch).padStart(13, "0")}:${randomUUID().replaceAll("-", "")}`],
  );
  store.failNextDelete();
  const failed = await runPass(context, BASE_CYCLE + 3 * MINUTE, { objectStore: store });
  assert.equal(failed.outcome, "failure");
  assert.equal(failed.code, "QUARANTINE_OBJECT_STORAGE_UNAVAILABLE");
  assert.equal(failed.lifecycleComplete, true);
  assert.equal(failed.changed, true);
  const recorded = await reconciliationRow(pool, table);
  assert.equal(recorded.state, "failed");
  assert.equal(recorded.failure_code, "QUARANTINE_RECONCILIATION_FAILED");
  assert.equal(recorded.lease_id, null);
  assert.equal(recorded.run_at, iso(BASE_CYCLE + 3 * MINUTE));
  const notReady = await readiness(pool, schema, BASE_CYCLE + 3 * MINUTE + 2_000);
  assert.equal(notReady.body.status, "not_ready");
  assert.equal(notReady.body.checks.quarantineReconciliation, "failed");
  assert.equal(await pendingCount(pool, table), 1, "the claim survives the failure");

  // The deleting claim was re-leased by the failed pass; once its safety
  // window passes, the next pass deletes the object and reads ready.
  const recoveredCycle = BASE_CYCLE + 3 * MINUTE + SAFETY_WINDOW + MINUTE;
  const recovered = await runPass(context, recoveredCycle, { objectStore: store });
  assert.equal(recovered.outcome, "complete");
  assert.equal(recovered.reconciliation.orphanObjectsDeleted, 1);
  assert.equal(store.objects.has(key), false);
  assert.equal(await pendingCount(pool, table), 0);
  assert.equal((await readiness(pool, schema, recoveredCycle + 2_000)).body.status, "ready");
}));

async function refusedWithoutWrite(context, cycleEpoch, code, overrides = {}) {
  const before = await snapshot(context.pool, context.table);
  const pendingBefore = await pendingCount(context.pool, context.table);
  const store = syntheticStore();
  const result = await runPass(context, cycleEpoch, { objectStore: store, ...overrides });
  assert.equal(result.outcome, "refused", code);
  assert.equal(result.code, code);
  assert.equal(result.changed, false);
  assert.equal(result.lifecycleWritten, false);
  assert.equal(result.reconciliation, null);
  assert.deepEqual(await snapshot(context.pool, context.table), before, `${code} leaves both rows unchanged`);
  assert.equal(await pendingCount(context.pool, context.table), pendingBefore);
  assert.equal(store.calls.head + store.calls.delete, 0);
  return result;
}

test("every pre-write conflict refuses with a closed code and writes nothing", {
  skip: SKIP, timeout: 240_000,
}, async () => withSchema(async (context) => {
  const { pool, table, schema, expected } = context;
  assert.equal((await runPass(context, BASE_CYCLE)).outcome, "complete");
  const retention = table("retention_state");
  const next = BASE_CYCLE + MINUTE;

  // The 0064 pins (restore replay and suppression), refused rather than repaired.
  // The promoted 0064 makes both pins CHECK constraints, so the database
  // refuses these states first. To prove the pass's own refusal (defense in
  // depth), the two constraints are lifted in this disposable schema only,
  // and restored exactly as 0064 defines them before the test continues.
  for (const assignment of ["restore_replay_complete = false", "restored_participants_suppressed = 2"]) {
    await assert.rejects(pool.query(`UPDATE ${retention} SET ${assignment}`),
      (error) => error?.code === "23514", assignment);
  }
  await pool.query(`ALTER TABLE ${retention}
    DROP CONSTRAINT retention_state_restore_replay_complete_check,
    DROP CONSTRAINT retention_state_restored_participants_suppressed_check`);
  await pool.query(`UPDATE ${retention} SET restore_replay_complete = false`);
  await refusedWithoutWrite(context, next, "LIFECYCLE_RESTORE_PIN_CONFLICT");
  await pool.query(`UPDATE ${retention} SET restore_replay_complete = true, restored_participants_suppressed = 2`);
  await refusedWithoutWrite(context, next, "LIFECYCLE_RESTORE_PIN_CONFLICT");
  await pool.query(`UPDATE ${retention} SET restored_participants_suppressed = 0`);
  await pool.query(`ALTER TABLE ${retention}
    ADD CONSTRAINT retention_state_restored_participants_suppressed_check
      CHECK (restored_participants_suppressed = 0),
    ADD CONSTRAINT retention_state_restore_replay_complete_check
      CHECK (restore_replay_complete)`);

  // A lease pair nothing on PostgreSQL writes.
  await pool.query(`UPDATE ${retention} SET lease_id = 'synthetic-foreign-lease', lease_expires_at = $1`,
    [iso(next + MINUTE)]);
  await refusedWithoutWrite(context, next, "LIFECYCLE_LEASE_CONFLICT");
  await pool.query(`UPDATE ${retention} SET lease_id = NULL, lease_expires_at = NULL`);

  // A cycle older than a stored marker.
  await refusedWithoutWrite(context, BASE_CYCLE - MINUTE, "LIFECYCLE_CYCLE_REGRESSED");

  // A value outside the closed reader contract.
  await pool.query(`UPDATE ${retention} SET last_started_at = 'infinity'`);
  await refusedWithoutWrite(context, next, "LIFECYCLE_STATE_SHAPE_INVALID");
  await pool.query(`UPDATE ${retention} SET last_started_at = $1`, [iso(BASE_CYCLE)]);

  // Receipt drift: an older schema, a newer schema and a different image.
  const history = table("_tibotattle_migration_history");
  const last = (await pool.query(`SELECT * FROM ${history} ORDER BY version DESC LIMIT 1`)).rows[0];
  await pool.query(`DELETE FROM ${history} WHERE version = $1`, [last.version]);
  await refusedWithoutWrite(context, next, "POSTGRES_SCHEMA_RECEIPT_MISMATCH");
  const columns = Object.keys(last);
  await pool.query(
    `INSERT INTO ${history} (${columns.map((name) => `"${name}"`).join(", ")})
     VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
    columns.map((name) => last[name]),
  );
  await refusedWithoutWrite(context, next, "POSTGRES_SCHEMA_RECEIPT_MISMATCH",
    { expected: expected.slice(0, -1) });
  await refusedWithoutWrite(context, next, "POSTGRES_SCHEMA_RECEIPT_MISMATCH",
    { expected: expected.map((entry, index) => (index === expected.length - 1
      ? { ...entry, sha256: "0".repeat(64) } : entry)) });

  // A missing singleton.
  const saved = (await pool.query(`SELECT * FROM ${table("quarantine_reconciliation_state")}`)).rows[0];
  await pool.query(`DELETE FROM ${table("quarantine_reconciliation_state")}`);
  await refusedWithoutWrite(context, next, "LIFECYCLE_STATE_MISSING");
  const savedColumns = Object.keys(saved);
  await pool.query(
    `INSERT INTO ${table("quarantine_reconciliation_state")} (${savedColumns.map((name) => `"${name}"`).join(", ")})
     VALUES (${savedColumns.map((_, index) => `$${index + 1}`).join(", ")})`,
    savedColumns.map((name) => saved[name]),
  );

  // Another maintenance run holds the shared lock: skipped, nothing written.
  const { POSTGRES_LIFECYCLE_PASS_LOCK_DOMAIN } = await workerModule("/src/postgres-lifecycle-pass.ts");
  const holder = await pool.connect();
  try {
    assert.equal((await holder.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [POSTGRES_LIFECYCLE_PASS_LOCK_DOMAIN])).rows[0].acquired, true);
    const before = await snapshot(pool, table);
    const skipped = await runPass(context, next);
    assert.equal(skipped.outcome, "skipped");
    assert.equal(skipped.code, "MAINTENANCE_IN_PROGRESS");
    assert.equal(skipped.lockAcquired, false);
    assert.equal(skipped.changed, false);
    assert.deepEqual(await snapshot(pool, table), before);
  } finally {
    await holder.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [POSTGRES_LIFECYCLE_PASS_LOCK_DOMAIN]);
    holder.release();
  }

  // With every conflict removed the same cycle completes.
  const healed = await runPass(context, next);
  assert.equal(healed.code, "LIFECYCLE_PASS_COMPLETE");
  assert.equal((await readiness(pool, schema, next + 2_000)).body.status, "ready");
}));

test("a CHECK violation refuses: in the lifecycle write nothing changes, while the lease is taken the lifecycle keeps the new cycle, after it the failure is recorded", {
  skip: SKIP, timeout: 180_000,
}, async () => withSchema(async (context) => {
  const { pool, table, schema } = context;
  assert.equal((await runPass(context, BASE_CYCLE)).outcome, "complete");
  const first = BASE_CYCLE + MINUTE;
  const second = BASE_CYCLE + 2 * MINUTE;

  // A constraint the lifecycle write violates (NOT VALID: the stored row stays legal).
  await pool.query(`ALTER TABLE ${table("retention_state")}
    ADD CONSTRAINT c_maint_synthetic_retention_conflict CHECK (maintenance_run_at <= $$${iso(BASE_CYCLE)}$$::timestamptz) NOT VALID`);
  await refusedWithoutWrite(context, first, "LIFECYCLE_STATE_CHECK_CONFLICT");
  await pool.query(`ALTER TABLE ${table("retention_state")} DROP CONSTRAINT c_maint_synthetic_retention_conflict`);

  // A constraint only the reconciliation lease violates. The lease is taken in
  // its own transaction after the lifecycle transaction committed, so the
  // lifecycle row keeps the new cycle and the reconciliation row is unchanged.
  await pool.query(`ALTER TABLE ${table("quarantine_reconciliation_state")}
    ADD CONSTRAINT c_maint_synthetic_lease_conflict CHECK (state <> 'running') NOT VALID`);
  const before = await snapshot(pool, table);
  const pendingBefore = await pendingCount(pool, table);
  const store = syntheticStore();
  const leaseRefused = await runPass(context, first, { objectStore: store });
  assert.equal(leaseRefused.outcome, "refused");
  assert.equal(leaseRefused.code, "LIFECYCLE_STATE_CHECK_CONFLICT");
  assert.equal(leaseRefused.changed, true, "the lifecycle row was written before the lease");
  assert.equal(leaseRefused.lifecycleWritten, true);
  assert.equal(leaseRefused.lifecycleComplete, true);
  assert.equal(leaseRefused.reconciliation, null);
  assert.equal(leaseRefused.quarantineReconciliationComplete, false);
  const after = await snapshot(pool, table);
  const relation = (rows, name) => rows.find((row) => row.relation === name);
  assert.deepEqual(relation(after, "reconciliation"), relation(before, "reconciliation"),
    "the reconciliation row keeps its row version");
  assert.notEqual(relation(after, "retention").version, relation(before, "retention").version);
  assert.equal(await lifecycleRunAt(pool, table), iso(first));
  assert.equal(await pendingCount(pool, table), pendingBefore);
  assert.equal(store.calls.head + store.calls.delete, 0);
  const unmatched = await readiness(pool, schema, first + 2_000);
  assert.equal(unmatched.httpStatus, 503);
  assert.equal(unmatched.body.checks.lifecycle, "ready");
  assert.equal(unmatched.body.checks.maintenanceCycleMatched, false, "the Worker reads the same unmatched cycle");
  assert.equal(unmatched.body.checks.quarantineReconciliation, "completed");
  assert.equal(unmatched.body.checks.quarantineReconciliationComplete, false);
  await pool.query(`ALTER TABLE ${table("quarantine_reconciliation_state")}
    DROP CONSTRAINT c_maint_synthetic_lease_conflict`);
  const leaseRetried = await runPass(context, first);
  assert.equal(leaseRetried.outcome, "complete");
  assert.equal(leaseRetried.lifecycleWritten, false, "a retry takes the lease only");
  assert.equal((await readiness(pool, schema, first + 3_000)).body.status, "ready");

  // A constraint only the reconciliation completion violates.
  await pool.query(`ALTER TABLE ${table("quarantine_reconciliation_state")}
    ADD CONSTRAINT c_maint_synthetic_reconciliation_conflict
      CHECK (state <> 'completed' OR maintenance_run_at <= $$${iso(first)}$$::timestamptz) NOT VALID`);
  const refused = await runPass(context, second);
  assert.equal(refused.outcome, "refused");
  assert.equal(refused.code, "LIFECYCLE_STATE_CHECK_CONFLICT");
  assert.equal(refused.lifecycleWritten, true);
  assert.equal(refused.changed, true);
  const recorded = await reconciliationRow(pool, table);
  assert.equal(recorded.state, "failed");
  assert.equal(recorded.failure_code, "QUARANTINE_RECONCILIATION_FAILED");
  assert.equal(recorded.lease_id, null);
  assert.equal((await readiness(pool, schema, second + 2_000)).body.status, "not_ready");
  await pool.query(`ALTER TABLE ${table("quarantine_reconciliation_state")}
    DROP CONSTRAINT c_maint_synthetic_reconciliation_conflict`);

  // Replay-safe: the same cycle, retried, finishes the reconciliation only.
  const retried = await runPass(context, second);
  assert.equal(retried.outcome, "complete");
  assert.equal(retried.lifecycleWritten, false);
  assert.equal((await readiness(pool, schema, second + 3_000)).body.status, "ready");
}));

test("the pass holds the migration runner's lock shared: a running migration skips it, a migration mid-pass is refused, and drift outside the runner leaves the row running", {
  skip: SKIP, timeout: 240_000,
}, async () => withSchema(async (context) => {
  const { pool, table, schema, expected } = context;
  assert.equal((await runPass(context, BASE_CYCLE)).outcome, "complete");
  const { POSTGRES_LIFECYCLE_PASS_MIGRATION_LOCK_PREFIX } = await workerModule("/src/postgres-lifecycle-pass.ts");
  const migrationKey = `${POSTGRES_LIFECYCLE_PASS_MIGRATION_LOCK_PREFIX}${schema}`;
  const history = table("_tibotattle_migration_history");
  const historyCount = async () => (await pool.query(`SELECT count(*)::int AS count FROM ${history}`)).rows[0].count;

  // (1) A migration run holds the runner's lock (the runner's own statement and
  // key): the pass is skipped and writes nothing.
  const runner = await pool.connect();
  try {
    assert.equal((await runner.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [migrationKey])).rows[0].acquired, true);
    const before = await snapshot(pool, table);
    const skipped = await runPass(context, BASE_CYCLE + MINUTE);
    assert.equal(skipped.outcome, "skipped");
    assert.equal(skipped.code, "MIGRATION_IN_PROGRESS");
    assert.equal(skipped.lockAcquired, false);
    assert.equal(skipped.changed, false);
    assert.deepEqual(await snapshot(pool, table), before);
  } finally {
    await runner.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [migrationKey]);
    runner.release();
  }

  // (2) The real runner, started while the pass is inside its reconciliation
  // page, refuses POSTGRES_MIGRATION_CONFLICT. The pass completes, and both
  // locks are released afterwards: the next pass and the runner both proceed.
  let attempted = null;
  const fenced = storeWithHeadHook(async () => {
    attempted = await applyPostgresMigrations({ role: "primary", schema, pool })
      .then(() => "applied", (error) => error?.code ?? "unknown");
  });
  const fencedKey = await seedStaleClaim(pool, table, fenced, BASE_CYCLE - 3 * SAFETY_WINDOW);
  const during = await runPass(context, BASE_CYCLE + 2 * MINUTE, { objectStore: fenced });
  assert.equal(attempted, "POSTGRES_MIGRATION_CONFLICT");
  assert.equal(during.outcome, "complete");
  assert.equal(during.lockAcquired, true);
  assert.equal(during.reconciliation.orphanObjectsDeleted, 1);
  assert.equal(fenced.objects.has(fencedKey), false);
  assert.equal(await historyCount(), expected.length);
  assert.equal((await readiness(pool, schema, BASE_CYCLE + 2 * MINUTE + 2_000)).body.status, "ready");
  const free = await applyPostgresMigrations({ role: "primary", schema, pool });
  assert.equal(free.applied, expected.length, "the runner takes its lock once the pass is done");

  // (3) A history edit outside the runner (out of contract) inside the page:
  // the page in flight finishes its object work, then the completion refuses
  // POSTGRES_SCHEMA_RECEIPT_MISMATCH and the failure record, which also proves
  // the receipt, writes nothing. The row stays running and reads not_ready.
  const last = (await pool.query(`SELECT * FROM ${history} ORDER BY version DESC LIMIT 1`)).rows[0];
  const drifting = storeWithHeadHook(async () => {
    await pool.query(`DELETE FROM ${history} WHERE version = $1`, [last.version]);
  });
  const driftKey = await seedStaleClaim(pool, table, drifting, BASE_CYCLE - 3 * SAFETY_WINDOW);
  const driftCycle = BASE_CYCLE + 3 * MINUTE;
  const drifted = await runPass(context, driftCycle, { objectStore: drifting });
  assert.equal(drifted.outcome, "refused");
  assert.equal(drifted.code, "POSTGRES_SCHEMA_RECEIPT_MISMATCH");
  assert.equal(drifted.changed, true);
  assert.equal(drifted.lifecycleWritten, true);
  assert.equal(drifting.objects.has(driftKey), false, "the page in flight completed its delete");
  const running = await reconciliationRow(pool, table);
  assert.equal(running.state, "running", "no failure was written against the drifted schema");
  assert.equal(running.failure_code, null);
  assert.match(running.lease_id, /^pglp1:[0-9]{13}:[0-9a-f]{32}$/u);
  assert.equal(running.run_at, iso(driftCycle));
  const notReady = await readiness(pool, schema, driftCycle + 2_000);
  assert.equal(notReady.body.status, "not_ready");
  assert.equal(notReady.body.checks.quarantineReconciliation, "running");

  // Restored, the next pass takes the running row over and reads ready.
  const columns = Object.keys(last);
  await pool.query(
    `INSERT INTO ${history} (${columns.map((name) => `"${name}"`).join(", ")})
     VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
    columns.map((name) => last[name]),
  );
  const recovered = await runPass(context, driftCycle + MINUTE);
  assert.equal(recovered.outcome, "complete");
  const taken = await reconciliationRow(pool, table);
  assert.equal(taken.state, "completed");
  assert.equal(taken.lease_id, null);
  assert.equal((await readiness(pool, schema, driftCycle + MINUTE + 2_000)).body.status, "ready");
}));

/** One sign-in handoff of each provider expiring at `expiresEpoch`, with synthetic states. */
async function seedHandoffs(pool, table, count, expiresEpoch, label) {
  const expires = iso(expiresEpoch);
  const created = iso(expiresEpoch - 10 * MINUTE);
  const states = Array.from({ length: count }, () => `synthetic-${label}-${randomUUID()}`);
  await pool.query(
    `INSERT INTO ${table("apple_signin_handoffs")} (state, nonce_hash, created_at, expires_at)
     SELECT seed.state, $2, $3::timestamptz, $4::timestamptz FROM unnest($1::text[]) AS seed(state)`,
    [states, "a".repeat(64), created, expires],
  );
  await pool.query(
    `INSERT INTO ${table("google_signin_handoffs")} (state, created_at, expires_at)
     SELECT seed.state, $2::timestamptz, $3::timestamptz FROM unnest($1::text[]) AS seed(state)`,
    [states, created, expires],
  );
}

async function handoffCount(pool, table) {
  return (await pool.query(
    `SELECT (SELECT count(*) FROM ${table("apple_signin_handoffs")})::int AS apple,
            (SELECT count(*) FROM ${table("google_signin_handoffs")})::int AS google`,
  )).rows[0];
}

/** One active social participant, a web session and one unused pairing expiring at `expiresEpoch`. */
async function seedPairing(pool, table, expiresEpoch) {
  const participant = `synthetic-c-maint-participant-${randomUUID()}`;
  const session = `synthetic-c-maint-session-${randomUUID()}`;
  const pairing = `synthetic-c-maint-pairing-${randomUUID()}`;
  await pool.query(
    `INSERT INTO ${table("participants")} (id, owner_kind, state, created_at)
     VALUES ($1, 'social', 'active', $2::timestamptz)`,
    [participant, iso(expiresEpoch - 2 * SAFETY_WINDOW)],
  );
  await pool.query(
    `INSERT INTO ${table("web_sessions")} (id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $5::timestamptz)`,
    [session, participant, randomBytes(32), randomBytes(32), iso(expiresEpoch - SAFETY_WINDOW),
      iso(expiresEpoch + 30 * SAFETY_WINDOW)],
  );
  await pool.query(
    `INSERT INTO ${table("device_pairings")} (
       id, participant_id, issued_by_session_id, secret_hash, consent_version,
       transport_consent_version, state, issued_at, expires_at
     ) VALUES ($1, $2, $3, $4, 'privacy-safe-telemetry-v0.1', 'privacy-safe-telemetry-v0.1', 'unused',
       $5::timestamptz, $6::timestamptz)`,
    [pairing, participant, session, randomBytes(32), iso(expiresEpoch - SAFETY_WINDOW), iso(expiresEpoch)],
  );
  return pairing;
}

async function pairingState(pool, table, id) {
  return (await pool.query(`SELECT state FROM ${table("device_pairings")} WHERE id = $1`, [id])).rows[0].state;
}

test("the pass folds the scheduled purges: bounded pages at the completion clock, live rows kept, a backlog drained, a replay purging nothing twice", {
  skip: SKIP, timeout: 240_000,
}, async () => withSchema(async (context) => {
  const { pool, schema, table } = context;
  const maintenance = await workerModule("/src/postgres-maintenance.ts");
  assert.equal(maintenance.POSTGRES_MAINTENANCE_IDENTITY_PAGE_SIZE, PAGE, "one handoff page per provider");
  const clock = BASE_CYCLE + 1_500;

  // 101 handoffs per provider expired before the first pass (one more than a
  // page), 1 expiring between the next cycle and that pass's completion clock
  // (the clock, not the cycle, is the cutoff, as the Worker purges at its
  // actual run time), and 1 still live. Sign-in windows: one past the 24 h
  // retention, one inside it for every pass below.
  const next = BASE_CYCLE + MINUTE;
  await seedHandoffs(pool, table, PAGE + 1, BASE_CYCLE - MINUTE, "expired");
  await seedHandoffs(pool, table, 1, next + 1_000, "late");
  await seedHandoffs(pool, table, 1, BASE_CYCLE + 10 * MINUTE, "live");
  await pool.query(
    `INSERT INTO ${table("sign_in_start_admission_windows")} (window_started_at, accepted_count, last_accepted_at)
     VALUES ($1::timestamptz, 1, $1::timestamptz), ($2::timestamptz, 1, $2::timestamptz)`,
    [iso(clock - SAFETY_WINDOW - MINUTE), iso(clock - SAFETY_WINDOW + 10 * MINUTE)],
  );
  const expiredPairing = await seedPairing(pool, table, BASE_CYCLE - MINUTE);
  const livePairing = await seedPairing(pool, table, BASE_CYCLE + SAFETY_WINDOW);

  const first = await runPass(context, BASE_CYCLE, { clock: () => clock });
  assert.equal(first.outcome, "partial");
  assert.equal(first.code, "MAINTENANCE_PURGE_BACKLOG");
  assert.equal(first.changed, true);
  assert.equal(first.lifecycleComplete, true);
  assert.equal(first.quarantineReconciliationComplete, true);
  // One page per provider (100 + 100) and the one aged sign-in window.
  assert.deepEqual(JSON.parse(JSON.stringify(first.maintenancePurges)), {
    identity: { purged: 2 * PAGE + 1, complete: false },
    deviceLifecycle: {
      pairingsRevoked: 1, devicesRevoked: 0, uploadsRevoked: 0, rotationsPurged: 0, pairingEventsPurged: 0,
      complete: true,
    },
    complete: false,
  });
  assert.equal(await pairingState(pool, table, expiredPairing), "revoked");
  assert.equal(await pairingState(pool, table, livePairing), "unused");
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table("sign_in_start_admission_windows")}`))
    .rows[0].count, 1, "the window inside the 24 h retention stays");
  assert.deepEqual(await handoffCount(pool, table), { apple: 3, google: 3 });
  // A purge backlog is housekeeping: readiness reads ready on the matched cycle.
  assert.equal((await readiness(pool, schema, clock + 500)).body.status, "ready");

  // A retry of the same cycle is the no-op: no singleton write, no purge.
  const repeat = await runPass(context, BASE_CYCLE, { clock: () => clock + 500 });
  assert.equal(repeat.code, "LIFECYCLE_CYCLE_ALREADY_COMPLETE");
  assert.equal(repeat.maintenancePurges, null);
  assert.deepEqual(await handoffCount(pool, table), { apple: 3, google: 3 });

  // The next cycle drains the backlog, with the late handoff due only by its
  // completion clock, and keeps every live row.
  const drained = await runPass(context, next, { clock: () => next + 1_500 });
  assert.equal(drained.outcome, "complete");
  assert.equal(drained.code, "LIFECYCLE_PASS_COMPLETE");
  assert.deepEqual(JSON.parse(JSON.stringify(drained.maintenancePurges)), {
    ...NOTHING_PURGED, identity: { purged: 4, complete: true },
  });
  assert.deepEqual(await handoffCount(pool, table), { apple: 1, google: 1 });
  assert.equal(await pairingState(pool, table, livePairing), "unused");

  // Replayed after everything due is gone, the purges change nothing.
  const replay = await runPass(context, next + MINUTE, { clock: () => next + MINUTE + 1_500 });
  assert.equal(replay.outcome, "complete");
  assert.deepEqual(JSON.parse(JSON.stringify(replay.maintenancePurges)), NOTHING_PURGED);
  assert.deepEqual(await handoffCount(pool, table), { apple: 1, google: 1 });
}));

test("a purge failure runs after the lifecycle write and before the lease: readiness reads not_ready on the unmatched cycle, and a retry completes", {
  skip: SKIP, timeout: 180_000,
}, async () => withSchema(async (context) => {
  const { pool, schema, table } = context;
  await runPass(context, BASE_CYCLE);
  const next = BASE_CYCLE + MINUTE;
  await seedHandoffs(pool, table, 2, next - MINUTE, "expired");
  const before = await reconciliationRow(pool, table);

  // A purge that cannot reach its table (a schema change outside the reviewed
  // runner, which the receipt does not see) fails the pass after the lifecycle
  // row took the new cycle and before the reconciliation lease.
  await pool.query(`ALTER TABLE ${table("google_signin_handoffs")} RENAME TO google_signin_handoffs_moved`);
  let failed;
  try {
    failed = await runPass(context, next);
  } finally {
    await pool.query(`ALTER TABLE ${table("google_signin_handoffs_moved")} RENAME TO google_signin_handoffs`);
  }
  assert.equal(failed.outcome, "failure");
  assert.equal(failed.code, "POSTGRES_MAINTENANCE_UNAVAILABLE");
  assert.equal(failed.lockAcquired, true);
  assert.equal(failed.lifecycleWritten, true);
  assert.equal(failed.maintenancePurges, null);
  assert.equal(failed.reconciliation, null);
  assert.equal(await lifecycleRunAt(pool, table), iso(next));
  assert.deepEqual(await reconciliationRow(pool, table), before, "the reconciliation row is untouched");
  const notReady = await readiness(pool, schema, next + 2_000);
  assert.equal(notReady.httpStatus, 503);
  assert.equal(notReady.body.checks.maintenanceCycleMatched, false);
  assert.deepEqual(await handoffCount(pool, table), { apple: 0, google: 2 },
    "the Apple page committed before the Google page failed");

  // A retry of the same cycle takes no lifecycle write, purges, then reconciles.
  const retried = await runPass(context, next, { clock: () => next + 3_000 });
  assert.equal(retried.outcome, "complete");
  assert.equal(retried.lifecycleWritten, false);
  assert.equal(retried.maintenancePurges.identity.purged, 2);
  assert.equal((await readiness(pool, schema, next + 4_000)).body.status, "ready");
  assert.deepEqual(await handoffCount(pool, table), { apple: 0, google: 0 });
}));

test("on a schema carrying the 0064 pins the pass keeps restore replay true and suppression 0", {
  skip: SKIP, timeout: 180_000,
}, async () => withSchema(async (context) => {
  const { pool, table, schema, pinned } = context;
  assert.ok(pinned === "inline" || pinned === "promoted");
  const constraints = (await pool.query(
    `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = $1::regclass
        AND conname IN ('retention_state_restore_replay_complete_check',
                        'retention_state_restored_participants_suppressed_check')
      ORDER BY conname`,
    [`${`"${schema}"`}.retention_state`],
  )).rows;
  assert.deepEqual(constraints, [
    { conname: "retention_state_restore_replay_complete_check", definition: "CHECK (restore_replay_complete)" },
    { conname: "retention_state_restored_participants_suppressed_check",
      definition: "CHECK ((restored_participants_suppressed = 0))" },
  ]);
  const first = await runPass(context, BASE_CYCLE);
  assert.equal(first.code, "LIFECYCLE_PASS_COMPLETE");
  assert.equal((await readiness(pool, schema, BASE_CYCLE + 2_000)).body.status, "ready");
  const row = (await pool.query(
    `SELECT restore_replay_complete, restored_participants_suppressed::int AS suppressed FROM ${table("retention_state")}`,
  )).rows[0];
  assert.deepEqual(row, { restore_replay_complete: true, suppressed: 0 });
  for (const assignment of ["restore_replay_complete = false", "restored_participants_suppressed = 1"]) {
    await assert.rejects(pool.query(`UPDATE ${table("retention_state")} SET ${assignment}`),
      (error) => error?.code === "23514");
  }
  const repeat = await runPass(context, BASE_CYCLE);
  assert.equal(repeat.code, "LIFECYCLE_CYCLE_ALREADY_COMPLETE");
  assert.equal(repeat.changed, false);
}, { pins: true }));

test("the maintenance Job entry composes the pass against the image manifest and turns an empty origin ready", {
  skip: SKIP, timeout: 180_000,
}, async () => withSchema(async ({ pool, schema }) => {
  const job = await workerModule("/cloud-run/postgres-maintenance-job.mjs");
  const { host, port } = await endpoint();
  const bucket = "synthetic-c-maint-quarantine";
  const proof = {
    bucket, bucketGeneration: "1700000000000001", bucketMetageneration: "1", softDeleteRetentionDurationSeconds: "0",
  };
  const env = {
    CLOUD_RUN_JOB: "tibotattle-maintenance",
    DEPLOYMENT_SOURCE_COMMIT: "0123456789abcdef0123456789abcdef01234567",
    TELEMETRY_STORAGE_NAMESPACE: "synthetic-namespace",
    PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:origin-primary",
    PRIMARY_DATABASE: "origin_primary",
    PRIMARY_SCHEMA: schema,
    POSTGRES_IAM_USER: "origin-runtime@synthetic-project.iam",
    GCS_BUCKET_NAME: bucket,
    // OD-2: the closed proof record itself, as OPS-2 renders it (CR-3 parses it).
    GCS_QUARANTINE_BUCKET_HISTORY_PROOF: JSON.stringify(proof),
    POSTGRES_SCHEDULED_MAINTENANCE_ENABLED: "enabled",
    IDENTITY_LINK_SECRET: "synthetic-identity-link-secret-value-0000000001",
  };
  const minute = BASE_CYCLE + 7 * MINUTE;
  const events = [];
  let jobPool;
  const result = await job.runPostgresMaintenanceJob({
    argv: ["--profile=maintenance-job"],
    env,
    now: () => minute + 4_321,
    dependencies: {
      createConnector() { return { async close() { events.push("connector.close"); } }; },
      async createIamPool(options) {
        assert.equal(options.max, 2);
        assert.equal(options.database, "origin_primary");
        jobPool = new pg.Pool({
          host, port, user: PG_TEST_USER, password: PG_TEST_PASSWORD, database: PG_TEST_DATABASE,
          ssl: false, max: options.max, application_name: options.applicationName,
        });
        const end = jobPool.end.bind(jobPool);
        jobPool.end = async () => { events.push("pool.end"); await end(); };
        return jobPool;
      },
      async createAccessTokenProvider() { return async () => "synthetic-access-token"; },
      createObjectStore(storeBucket, _token, storeProof) {
        assert.equal(storeBucket, bucket);
        assert.deepEqual({ ...storeProof }, proof);
        return syntheticStore();
      },
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.receipt.status, "complete");
  assert.equal(result.receipt.pass.code, "LIFECYCLE_PASS_COMPLETE");
  assert.equal(result.receipt.pass.cycle, iso(minute));
  assert.deepEqual(events, ["pool.end", "connector.close"]);
  assert.doesNotMatch(JSON.stringify(result.receipt), /synthetic-identity-link-secret|synthetic-access-token/u);
  const ready = await readiness(pool, schema, minute + 5_000);
  assert.equal(ready.httpStatus, 200);
  assert.equal(ready.body.status, "ready");
}));
