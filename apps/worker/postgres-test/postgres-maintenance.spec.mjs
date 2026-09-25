import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SAFETY_WINDOW = 24 * 60 * 60 * 1_000;

async function localEndpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "maintenance tests require a loopback host or a private Unix socket");
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65535);
  if (PG_TEST_SOCKET) {
    assert.match(PG_TEST_SOCKET, /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
    const link = await lstat(PG_TEST_SOCKET);
    const host = await realpath(PG_TEST_SOCKET);
    const metadata = await stat(host);
    assert.equal(link.isSymbolicLink(), false);
    assert.ok(host.startsWith("/private/tmp/tibotattle-pg-"));
    assert.equal(metadata.isDirectory(), true);
    assert.equal(metadata.mode & 0o077, 0);
    assert.equal(metadata.uid, process.getuid());
    return { host, port: PG_TEST_PORT, socket: true };
  }
  if (PG_TEST_HOST) return { host: PG_TEST_HOST, port: PG_TEST_PORT, socket: false };
  return null;
}

function q(schema, table) { return `"${schema}"."${table}"`; }

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

test("PostgreSQL scheduled slice purges expired identity state, fences orphan cleanup, and refuses false lifecycle readiness", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 120_000,
}, async () => {
  const endpoint = await localEndpoint();
  const pool = new pg.Pool({
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 8,
    connectionTimeoutMillis: 3_000,
  });
  const suffix = randomBytes(6).toString("hex");
  const primarySchema = `maintenance_primary_${suffix}`;
  const ledgerSchema = `maintenance_ledger_${suffix}`;
  const options = { schema: { primarySchema, ledgerSchema } };
  let primaryCreated = false;
  let ledgerCreated = false;
  let vite;
  try {
    const server = await pool.query(
      "SELECT current_setting('server_version_num')::integer AS version, inet_server_addr()::text AS address",
    );
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17,
      "this qualification requires PostgreSQL 17");
    if (endpoint.socket) assert.equal(server.rows[0].address, null);
    else assert.ok(["127.0.0.1", "::1"].includes(server.rows[0].address));

    await pool.query(`CREATE SCHEMA "${primarySchema}"`);
    primaryCreated = true;
    await pool.query(`CREATE SCHEMA "${ledgerSchema}"`);
    ledgerCreated = true;
    assert.equal((await applyPostgresMigrations({ role: "primary", schema: primarySchema, pool })).applied, 43);
    assert.equal((await applyPostgresMigrations({ role: "ledger", schema: ledgerSchema, pool })).applied, 6);

    vite = await createServer({
      root: WORKER_ROOT,
      configFile: false,
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "silent",
    });
    const maintenance = await vite.ssrLoadModule("/src/postgres-maintenance.ts");
    const store = syntheticStore();
    const nowEpoch = Date.now();
    const now = new Date(nowEpoch).toISOString();
    const expired = new Date(nowEpoch - 60_000).toISOString();
    const future = new Date(nowEpoch + 60 * 60_000).toISOString();

    await pool.query(
      `INSERT INTO ${q(primarySchema, "apple_signin_handoffs")}
       (state,nonce_hash,created_at,expires_at) VALUES ($1,$2,$3,$4),($5,$2,$6,$7)`,
      [`expired-apple-${suffix}`, "a".repeat(64), expired, expired,
        `live-apple-${suffix}`, now, future],
    );
    await pool.query(
      `INSERT INTO ${q(primarySchema, "google_signin_handoffs")}
       (state,created_at,expires_at) VALUES ($1,$2,$3),($4,$2,$5)`,
      [`expired-google-${suffix}`, expired, expired, `live-google-${suffix}`, future],
    );
    await pool.query(
      `INSERT INTO ${q(primarySchema, "identity_reenrollment_cooldowns")}
       (identity_cooldown_digest,created_at,expires_at) VALUES ($1,$2,$3)`,
      ["1".repeat(64), expired, expired],
    );
    await pool.query(
      `INSERT INTO ${q(primarySchema, "sign_in_start_admission_windows")}
       (window_started_at,accepted_count,last_accepted_at) VALUES ($1,1,$1),($2,1,$2)`,
      [new Date(nowEpoch - 48 * 60 * 60_000).toISOString(),
        new Date(nowEpoch - 23 * 60 * 60_000).toISOString()],
    );
    await pool.query(
      `INSERT INTO ${q(ledgerSchema, "identity_reenrollment_cooldowns")}
       (identity_cooldown_digest,schema_version,deleted_at,retain_until)
       VALUES ($1,'identity-reenrollment-cooldown-v0.1',$2,$3)`,
      ["2".repeat(64), new Date(nowEpoch - 31 * 24 * 60 * 60_000).toISOString(), expired],
    );
    const tombstoneDigest = "d".repeat(64);
    const ownerDigest = "e".repeat(64);
    const tombstoneDeleted = new Date(nowEpoch - 600 * 24 * 60 * 60_000).toISOString();
    const tombstoneRetain = new Date(nowEpoch - 100 * 24 * 60 * 60_000).toISOString();
    await pool.query(
      `INSERT INTO ${q(ledgerSchema, "deletion_tombstones")}
       (participant_digest,schema_version,deleted_at,retain_until)
       VALUES ($1,'participant-deletion-tombstone-v0.1',$2,$3)`,
      [tombstoneDigest, tombstoneDeleted, tombstoneRetain],
    );
    await pool.query(
      `INSERT INTO ${q(ledgerSchema, "storage_erasure_jobs")}
       (participant_digest,source_id,owner_digest,source_namespace,state,terminal_json,attempted_ms,completed_at)
       VALUES ($1,'synthetic:maintenance',$2,'synthetic-maintenance','complete','{}',0,$3)`,
      [tombstoneDigest, ownerDigest, expired],
    );

    const orphanId = `synthetic-maintenance-${randomUUID()}`;
    const orphanKey = `synthetic/maintenance/${randomUUID()}`;
    store.objects.add(orphanKey);
    await pool.query(
      `INSERT INTO ${q(primarySchema, "pending_objects")}
       (contribution_id,object_key,object_kind,registered_at,reconciliation_state)
       VALUES ($1,$2,'synthetic',$3,'registered')`,
      [orphanId, orphanKey, new Date(nowEpoch - 3 * SAFETY_WINDOW).toISOString()],
    );

    // A second caller cannot enter while the exact primary-database session
    // lock is held; the expired identity row stays untouched on this pass.
    const lockHolder = await pool.connect();
    try {
      const lock = await lockHolder.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
        [maintenance.POSTGRES_SCHEDULED_MAINTENANCE_LOCK_DOMAIN],
      );
      assert.equal(lock.rows[0]?.acquired, true);
      const skipped = await maintenance.runPostgresScheduledMaintenance({
        primaryPool: pool,
        ledgerPool: pool,
        objectStore: store,
        ...options,
        nowEpoch,
      });
      assert.equal(skipped.outcome, "skipped");
      assert.equal(skipped.code, "MAINTENANCE_IN_PROGRESS");
      assert.equal((await pool.query(
        `SELECT 1 FROM ${q(primarySchema, "apple_signin_handoffs")} WHERE state=$1`,
        [`expired-apple-${suffix}`],
      )).rows.length, 1);
    } finally {
      await lockHolder.query(
        "SELECT pg_advisory_unlock(hashtextextended($1,0))",
        [maintenance.POSTGRES_SCHEDULED_MAINTENANCE_LOCK_DOMAIN],
      );
      lockHolder.release();
    }

    const first = await maintenance.runPostgresScheduledMaintenance({
      primaryPool: pool,
      ledgerPool: pool,
      objectStore: store,
      ...options,
      nowEpoch,
    });
    assert.equal(first.outcome, "partial");
    assert.equal(first.code, "POSTGRES_MAINTENANCE_INCOMPLETE_UNSUPPORTED_PHASES");
    assert.equal(first.complete, false);
    assert.equal(first.leaseAcquired, true);
    assert.equal(first.identityPurge.primary.purged, 4);
    assert.equal(first.identityPurge.ledger.purged, 1);
    assert.equal(first.identityPurge.complete, true);
    assert.equal(first.objectReconciliation?.deletionGraceStarted, 1);
    assert.equal(first.objectReconciliationComplete, true);
    assert.equal(first.deviceLifecycleComplete, true);
    assert.deepEqual(first.deviceLifecycle, {
      pairingsRevoked: 0,
      devicesRevoked: 0,
      uploadsRevoked: 0,
      rotationsPurged: 0,
      pairingEventsPurged: 0,
      complete: true,
    });
    assert.equal(first.ownerErasureJobsComplete, false);
    assert.equal(first.restoreReplayComplete, false);
    assert.equal(first.telemetryRetentionComplete, false);
    assert.equal(first.deletionTombstoneRetentionComplete, false);
    assert.equal(first.analyticsMaintenanceComplete, false);
    assert.equal(store.calls.delete, 0, "first reconciliation pass must only start the deletion grace period");
    assert.equal((await pool.query(
      `SELECT reconciliation_state FROM ${q(primarySchema, "pending_objects")} WHERE contribution_id=$1`,
      [orphanId],
    )).rows[0]?.reconciliation_state, "deleting");
    assert.equal((await pool.query(
      `SELECT 1 FROM ${q(primarySchema, "apple_signin_handoffs")} WHERE state=$1`,
      [`live-apple-${suffix}`],
    )).rows.length, 1);
    assert.equal((await pool.query(
      `SELECT count(*)::int AS count FROM ${q(primarySchema, "sign_in_start_admission_windows")}`,
    )).rows[0]?.count, 1, "the 23-hour admission window remains inside the 24-hour retention period");
    assert.equal((await pool.query(
      `SELECT 1 FROM ${q(ledgerSchema, "deletion_tombstones")} WHERE participant_digest=$1`,
      [tombstoneDigest],
    )).rows.length, 1, "expired tombstone stays until restore replay can be implemented and verified");
    assert.equal(JSON.stringify(first).includes(orphanKey), false, "maintenance receipts must not expose object keys");

    const second = await maintenance.runPostgresScheduledMaintenance({
      primaryPool: pool,
      ledgerPool: pool,
      objectStore: store,
      ...options,
      nowEpoch: nowEpoch + SAFETY_WINDOW + 1,
    });
    assert.equal(second.outcome, "partial");
    assert.equal(second.code, "POSTGRES_MAINTENANCE_INCOMPLETE_UNSUPPORTED_PHASES");
    assert.equal(store.calls.delete, 1);
    assert.equal(store.objects.has(orphanKey), false);
    assert.equal((await pool.query(
      `SELECT 1 FROM ${q(primarySchema, "pending_objects")} WHERE contribution_id=$1`,
      [orphanId],
    )).rows.length, 0);

    // A failed external delete retains its exact deleting journal entry so the
    // next scheduled pass can inspect the object again after the safety window.
    const retryId = `synthetic-maintenance-${randomUUID()}`;
    const retryKey = `synthetic/maintenance/${randomUUID()}`;
    const staleEpoch = nowEpoch - 3 * SAFETY_WINDOW;
    const staleLease = `pgq1:${String(staleEpoch).padStart(13, "0")}:${randomUUID().replaceAll("-", "")}`;
    store.objects.add(retryKey);
    store.failNextDelete();
    await pool.query(
      `INSERT INTO ${q(primarySchema, "pending_objects")}
       (contribution_id,object_key,object_kind,registered_at,reconciliation_state,reconciliation_lease_id)
       VALUES ($1,$2,'synthetic',$3,'deleting',$4)`,
      [retryId, retryKey, new Date(staleEpoch).toISOString(), staleLease],
    );
    const failed = await maintenance.runPostgresScheduledMaintenance({
      primaryPool: pool,
      ledgerPool: pool,
      objectStore: store,
      ...options,
      nowEpoch,
    });
    assert.equal(failed.outcome, "failure");
    assert.equal(failed.code, "QUARANTINE_OBJECT_STORAGE_UNAVAILABLE");
    assert.equal(failed.leaseAcquired, true);
    const retry = await pool.query(
      `SELECT reconciliation_state,reconciliation_lease_id FROM ${q(primarySchema, "pending_objects")}
        WHERE contribution_id=$1`,
      [retryId],
    );
    assert.equal(retry.rows[0]?.reconciliation_state, "deleting");
    assert.notEqual(retry.rows[0]?.reconciliation_lease_id, null);
    const retried = await maintenance.runPostgresScheduledMaintenance({
      primaryPool: pool,
      ledgerPool: pool,
      objectStore: store,
      ...options,
      nowEpoch: nowEpoch + 2 * SAFETY_WINDOW + 2,
    });
    assert.equal(retried.outcome, "partial", "the failed job released its session lock for a later retry");
    assert.equal(retried.objectReconciliation?.orphanObjectsDeleted, 1);
    assert.equal(store.objects.has(retryKey), false);
    assert.equal((await pool.query(
      `SELECT 1 FROM ${q(primarySchema, "pending_objects")} WHERE contribution_id=$1`,
      [retryId],
    )).rows.length, 0);
  } finally {
    await vite?.close();
    if (ledgerCreated) await pool.query(`DROP SCHEMA IF EXISTS "${ledgerSchema}" CASCADE`);
    if (primaryCreated) await pool.query(`DROP SCHEMA IF EXISTS "${primarySchema}" CASCADE`);
    await pool.end();
  }
});
