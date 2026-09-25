import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import pg from "pg";
import { buildPostgresMigrationManifest, applyPostgresMigrations, readPostgresMigrations } from "../cloud-run/postgres-migrations.mjs";
import { reconcileUnprovenCompleteLedgerJobs } from "../cloud-run/ledger-preflight-reconcile.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "5432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD ?? "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";

function stableOperationId(participantDigest) {
  const source = participantDigest.slice(0, 32).split("");
  source[12] = "4";
  source[16] = ((Number.parseInt(source[16], 16) & 0x3) | 0x8).toString(16);
  const hex = source.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  const { lstat, realpath, stat } = await import("node:fs/promises");
  const [link, resolved] = await Promise.all([lstat(PG_TEST_SOCKET), realpath(PG_TEST_SOCKET)]);
  const metadata = await stat(resolved);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(resolved.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host: resolved, port: PG_TEST_PORT };
}

async function applyLedgerPrefix(pool, schema, directory, migrations) {
  const root = join(directory, "ledger-migrations-prefix");
  const ledger = join(root, "ledger");
  await mkdir(ledger, { recursive: true });
  for (const migration of migrations.slice(0, 5)) {
    await writeFile(join(ledger, migration.name), migration.sql, { mode: 0o600, flag: "wx" });
  }
  return applyPostgresMigrations({ role: "ledger", schema, pool, rootDirectory: root });
}

test("PG17 inspect is read-only and exact candidate reopens 15 jobs for ledger migration 0006", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const socket = await localSocket();
  const pool = new pg.Pool({ ...socket, user: PG_TEST_USER, password: PG_TEST_PASSWORD,
    database: PG_TEST_DATABASE, ssl: false, max: 4, connectionTimeoutMillis: 5_000 });
  const suffix = randomBytes(6).toString("hex");
  const primarySchema = `ledger_reconcile_primary_${suffix}`;
  const ledgerSchema = `ledger_reconcile_target_${suffix}`;
  let directory;
  try {
    const locality = await pool.query("SELECT inet_server_addr() AS address,current_setting('server_version_num') AS version");
    assert.equal(locality.rows[0]?.address, null, "test database must use the local Unix socket");
    assert.match(locality.rows[0]?.version ?? "", /^17\d+$/u, "test must run on PostgreSQL 17");
    await pool.query(`CREATE SCHEMA "${primarySchema}"`);
    await pool.query(`CREATE SCHEMA "${ledgerSchema}"`);
    await pool.query(`CREATE TABLE "${primarySchema}".storage_source_state (
      singleton integer PRIMARY KEY CHECK (singleton = 1), source_id text NOT NULL
    )`);
    await pool.query(`CREATE TABLE "${primarySchema}".typed_v1_admission_state (
      id integer PRIMARY KEY, runtime_contract_version integer NOT NULL, source_namespace text NOT NULL
    )`);
    await pool.query(`CREATE TABLE "${primarySchema}".typed_v11_admission_state (
      id integer PRIMARY KEY, runtime_contract_version integer NOT NULL, source_namespace text NOT NULL
    )`);
    await pool.query(`INSERT INTO "${primarySchema}".storage_source_state VALUES (1, 'synthetic:reconcile-test')`);

    directory = await mkdtemp(join(tmpdir(), "tibotattle-ledger-reconcile-pg17-"));
    const migrations = await readPostgresMigrations({ role: "ledger" });
    const manifest = await buildPostgresMigrationManifest();
    assert.equal(migrations.length, 6);
    assert.equal((await applyLedgerPrefix(pool, ledgerSchema, directory, migrations)).applied, 5);

    const rows = Array.from({ length: 15 }, (_, index) => ({
      participant: (index + 1).toString(16).padStart(2, "0").repeat(32),
      owner: (index + 101).toString(16).padStart(2, "0").repeat(32),
      completedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString(),
      attempted: 100 + index,
    }));
    for (const row of rows) {
      await pool.query(`INSERT INTO "${ledgerSchema}".deletion_tombstones
        (participant_digest,schema_version,deleted_at,retain_until)
        VALUES($1,'participant-deletion-tombstone-v0.1','2026-08-01T00:00:00Z','2026-10-01T00:00:00Z')`,
      [row.participant]);
      await pool.query(`INSERT INTO "${ledgerSchema}".storage_erasure_jobs
        (participant_digest,source_id,owner_digest,source_namespace,state,terminal_json,attempted_ms,completed_at)
        VALUES($1,'synthetic:reconcile-test',$2,'synthetic-reconcile-namespace','complete',NULL,$3,$4)`,
      [row.participant, row.owner, row.attempted, row.completedAt]);
      await pool.query(`INSERT INTO "${ledgerSchema}".participant_erasure_receipts
        (operation_id,participant_digest,outcome,details_json,created_at,completed_at)
        VALUES($1,$2,'completed',$3,'2026-09-01T00:00:00Z','2026-09-01T00:00:01Z')`,
      [stableOperationId(row.participant), row.participant, JSON.stringify({
        schemaVersion: "postgres-synthetic-owner-erasure-v1",
        phase: "completed",
        ownerDigest: row.owner,
        objectCount: 0,
      })]);
    }
    const primaryPool = new pg.Pool({ ...socket, user: PG_TEST_USER, password: PG_TEST_PASSWORD,
      database: PG_TEST_DATABASE, ssl: false, max: 1, connectionTimeoutMillis: 5_000 });
    const ledgerPool = new pg.Pool({ ...socket, user: PG_TEST_USER, password: PG_TEST_PASSWORD,
      database: PG_TEST_DATABASE, ssl: false, max: 1, connectionTimeoutMillis: 5_000 });
    try {
      const expectedLedgerMigrations = manifest.roles.ledger;
      const expectedSourcePinSha256 = createHash("sha256").update(JSON.stringify({
        sourceId: "synthetic:reconcile-test", namespace: "synthetic-reconcile-namespace",
      })).digest("hex");
      const options = { primaryPool, ledgerPool, primarySchema, ledgerSchema,
        expectedLedgerMigrations, expectedSourcePinSha256 };
      const beforeGeneration = await pool.query(`SELECT generation::text FROM "${ledgerSchema}".storage_erasure_ledger_generation`);
      assert.equal(beforeGeneration.rows[0]?.generation, "30");
      await assert.rejects(reconcileUnprovenCompleteLedgerJobs({
        ...options, expectedSourcePinSha256: "f".repeat(64), mode: "inspect",
      }), (error) => error?.code === "POSTGRES_TEST_LEDGER_RECONCILE_SOURCE_PIN_INVALID");
      await pool.query(`DELETE FROM "${primarySchema}".storage_source_state`);
      await assert.rejects(reconcileUnprovenCompleteLedgerJobs({ ...options, mode: "inspect" }),
        (error) => error?.code === "POSTGRES_TEST_LEDGER_RECONCILE_SOURCE_PIN_INVALID");
      await pool.query(`INSERT INTO "${primarySchema}".storage_source_state VALUES (1, 'synthetic:reconcile-test')`);
      const inspection = await reconcileUnprovenCompleteLedgerJobs({ ...options, mode: "inspect" });
      assert.equal(inspection.status, "inspection_only");
      assert.equal(inspection.mode, "prestate_qualified");
      assert.equal(inspection.jobsThatWouldReopen, 15);
      assert.equal(inspection.sourceIdNamespaceMatches, 15);
      assert.equal(inspection.syntheticOwnersProven, 15);
      assert.equal(inspection.sourcePinSha256, expectedSourcePinSha256);
      const unchanged = await pool.query(`SELECT count(*) FILTER (WHERE state='complete' AND terminal_json IS NULL)::int AS complete,
        count(*)::int AS total FROM "${ledgerSchema}".storage_erasure_jobs`);
      assert.deepEqual(unchanged.rows[0], { complete: 15, total: 15 });
      assert.equal((await pool.query(`SELECT generation::text FROM "${ledgerSchema}".storage_erasure_ledger_generation`)).rows[0]?.generation, "30");

      const applied = await reconcileUnprovenCompleteLedgerJobs({ ...options, mode: "apply" });
      assert.equal(applied.mode, "reconciled");
      assert.equal(applied.jobsReopened, 15);
      assert.equal(applied.terminalProofCreated, false);
      assert.equal(applied.tombstonesDeleted, 0);
      assert.notEqual(applied.prestateSha256, applied.poststateSha256);
      const after = await pool.query(`SELECT participant_digest, source_id, owner_digest, state,
        terminal_json, attempted_ms::text, completed_at
        FROM "${ledgerSchema}".storage_erasure_jobs
        ORDER BY participant_digest,source_id,owner_digest`);
      assert.equal(after.rows.length, 15);
      for (let index = 0; index < after.rows.length; index += 1) {
        const actual = after.rows[index];
        const expected = rows[index];
        assert.equal(actual.participant_digest, expected.participant);
        assert.equal(actual.owner_digest, expected.owner);
        assert.equal(actual.state, "pending");
        assert.equal(actual.terminal_json, null);
        assert.equal(actual.attempted_ms, String(expected.attempted));
        assert.equal(actual.completed_at, null);
      }
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM "${ledgerSchema}".deletion_tombstones`)).rows[0]?.count, 15);
      assert.equal((await pool.query(`SELECT generation::text FROM "${ledgerSchema}".storage_erasure_ledger_generation`)).rows[0]?.generation, "45");

      const migrated = await applyPostgresMigrations({ role: "ledger", schema: ledgerSchema, pool });
      assert.equal(migrated.applied, 6);
      const history = await pool.query(`SELECT count(*)::int AS count FROM "${ledgerSchema}"._tibotattle_migration_history`);
      assert.equal(history.rows[0]?.count, 6);
      await assert.rejects(pool.query(`DELETE FROM "${ledgerSchema}".deletion_tombstones
        WHERE participant_digest=$1`, [rows[0].participant]), (error) => error?.code === "P1005");
    } finally {
      await Promise.all([primaryPool.end(), ledgerPool.end()]);
    }
  } finally {
    try { await pool.query(`DROP SCHEMA IF EXISTS "${ledgerSchema}" CASCADE`); } catch {}
    try { await pool.query(`DROP SCHEMA IF EXISTS "${primarySchema}" CASCADE`); } catch {}
    await pool.end();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});
