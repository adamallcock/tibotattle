import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import pg from "pg";
import { fileURLToPath } from "node:url";
import {
  createSealedSqliteErasureLedgerSource,
  POSTGRES_ERASURE_LEDGER_GCP_TEST_TARGET,
  runPostgresNamedGcpTestErasureLedgerTransfer,
  runPostgresErasureLedgerTransfer,
} from "../scripts/postgres-erasure-ledger-transfer.mjs";
import { applyPostgresMigrations, readPostgresMigrations } from "../scripts/postgres-migrations.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "5432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD ?? "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const WORKER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function terminal(sourceId, ownerDigest, suffix) {
  return JSON.stringify({
    sourceId,
    sequence: 4 + suffix,
    eventDigest: String(1 + suffix).repeat(64),
    ownerDigest,
    revision: 2 + suffix,
    kind: "owner-erased",
    objectDigest: String(3 + suffix).repeat(64),
    contentDigest: String(5 + suffix).repeat(64),
    authorityEpoch: 7 + suffix,
    publicAuthorityEpoch: 9 + suffix,
    recordedMs: 1_790_000_000_000 + suffix,
  });
}

async function makeSealedSource({ invalidSourceId = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-erasure-ledger-pg17-"));
  const path = join(await realpath(directory), "erasure-ledger.sqlite");
  const database = new DatabaseSync(path);
  const migrationNames = ["0001_deletion_tombstones.sql", "0002_identity_reenrollment_cooldown.sql",
    "0003_storage_erasure_jobs.sql"];
  try {
    database.exec("PRAGMA foreign_keys=ON");
    for (const name of migrationNames) {
      database.exec(await readFile(join(WORKER_ROOT, "deletion-ledger-migrations", name), "utf8"));
    }
    for (const [digest, day] of [["1".repeat(64), "01"], ["2".repeat(64), "02"]]) {
      database.prepare(`INSERT INTO deletion_tombstones
        (participant_digest,schema_version,deleted_at,retain_until)
        VALUES(?,'participant-deletion-tombstone-v0.1',?,?)`).run(
        digest, `2026-08-${day}T00:00:00.000Z`, `2026-09-${day}T00:00:00.000Z`);
    }
    database.prepare(`INSERT INTO identity_reenrollment_cooldowns
      (identity_cooldown_digest,schema_version,deleted_at,retain_until)
      VALUES(?,'identity-reenrollment-cooldown-v0.1',?,?)`).run(
      "3".repeat(64), "2026-08-01T00:00:00.000Z", "2026-08-15T00:00:00.000Z");
    const sourceId = invalidSourceId ? "bad source id" : "synthetic:codex";
    const owners = ["a".repeat(64), "b".repeat(64)];
    const insertJob = database.prepare(`INSERT INTO storage_erasure_jobs
      (participant_digest,source_id,owner_digest,source_namespace,state,terminal_json,completed_at,attempted_ms)
      VALUES(?,?,?,?,?,?,?,?)`);
    insertJob.run("1".repeat(64), sourceId, owners[0], "synthetic-namespace", "pending",
      terminal("synthetic:codex", owners[0], 1), null, 12n);
    insertJob.run("2".repeat(64), sourceId, owners[1], "synthetic-namespace", "complete",
      terminal("synthetic:codex", owners[1], 2), "2026-08-03T00:00:00.000Z", 18n);
  } finally {
    database.close();
  }
  await chmod(path, 0o400);
  const expectedSha256 = createHash("sha256").update(await readFile(path)).digest("hex");
  return { directory, path, expectedSha256 };
}

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  const [link, resolved] = await Promise.all([lstat(PG_TEST_SOCKET), realpath(PG_TEST_SOCKET)]);
  const metadata = await stat(resolved);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(resolved.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host: resolved, port: PG_TEST_PORT };
}

async function applyLedgerPrefix(pool, schema, temporaryDirectory, migrations) {
  const root = join(temporaryDirectory, "migrations-prefix");
  const ledger = join(root, "ledger");
  await mkdir(ledger, { recursive: true });
  for (const migration of migrations.slice(0, 5)) {
    await writeFile(join(ledger, migration.name), migration.sql, { mode: 0o600, flag: "wx" });
  }
  return applyPostgresMigrations({ role: "ledger", schema, pool, rootDirectory: root });
}

test("PG17 reconciles a sealed D1 erasure ledger with resumable, fail-closed parity", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const socket = await localSocket();
  const pool = new pg.Pool({ ...socket, user: PG_TEST_USER, password: PG_TEST_PASSWORD,
    database: PG_TEST_DATABASE, ssl: false, max: 4, connectionTimeoutMillis: 5_000 });
  const prefix = "erasure_ledger_transfer_target_";
  const goodSchema = `${prefix}${randomBytes(6).toString("hex")}`;
  const driftSchema = `${prefix}${randomBytes(6).toString("hex")}`;
  const invalidSchema = `erasure_ledger_preflight_${randomBytes(6).toString("hex")}`;
  const transferId = `synthetic-erasure-${randomUUID()}`;
  const badSourceTransferId = `synthetic-invalid-source-${randomUUID()}`;
  const driftTransferId = `synthetic-drift-${randomUUID()}`;
  let sourceFixture;
  let invalidSourceFixture;
  let source;
  let driftSource;
  let schemas = [];
  let temporaryDirectory;
  try {
    const locality = await pool.query("SELECT inet_server_addr() AS address,current_setting('server_version_num') AS version");
    assert.equal(locality.rows[0]?.address, null, "test database must use the local Unix socket");
    assert.match(locality.rows[0]?.version ?? "", /^17\d+$/u, "test must run on PostgreSQL 17");

    temporaryDirectory = await mkdtemp(join(tmpdir(), "tibotattle-erasure-ledger-migrations-"));
    const migrations = await readPostgresMigrations({ role: "ledger" });
    assert.equal(migrations.at(-1)?.name, "0006_erasure_ledger_transfer_receipts.sql");

    await pool.query(`CREATE SCHEMA "${invalidSchema}"`);
    schemas.push(invalidSchema);
    await applyLedgerPrefix(pool, invalidSchema, temporaryDirectory, migrations);
    const invalidTombstone = "d".repeat(64);
    await pool.query(`INSERT INTO "${invalidSchema}".deletion_tombstones
      (participant_digest,schema_version,deleted_at,retain_until)
      VALUES($1,'participant-deletion-tombstone-v0.1','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z')`,
    [invalidTombstone]);
    await assert.rejects(applyPostgresMigrations({ role: "ledger", schema: invalidSchema, pool }),
      error => error?.code === "POSTGRES_MIGRATION_APPLY_FAILED");
    const unchanged = await pool.query(`SELECT deleted_at,retain_until FROM "${invalidSchema}".deletion_tombstones
      WHERE participant_digest=$1`, [invalidTombstone]);
    assert.equal(unchanged.rows.length, 1);
    assert.equal(new Date(unchanged.rows[0].deleted_at).toISOString(), new Date(unchanged.rows[0].retain_until).toISOString());
    const failedHistory = await pool.query(`SELECT count(*)::int AS count FROM "${invalidSchema}"."_tibotattle_migration_history"`);
    assert.equal(failedHistory.rows[0].count, 5, "failed 0006 application must leave its transaction unapplied");
    const failedConstraint = await pool.query(`SELECT count(*)::int AS count FROM pg_constraint c
      JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname=$1 AND c.conname='deletion_tombstones_retention_strict_transfer_check'`, [invalidSchema]);
    assert.equal(failedConstraint.rows[0].count, 0, "failed preflight must not leave partial DDL");

    await pool.query(`CREATE SCHEMA "${goodSchema}"`);
    schemas.push(goodSchema);
    const applied = await applyPostgresMigrations({ role: "ledger", schema: goodSchema, pool });
    assert.equal(applied.applied, 6);
    sourceFixture = await makeSealedSource();
    source = await createSealedSqliteErasureLedgerSource(sourceFixture);

    invalidSourceFixture = await makeSealedSource({ invalidSourceId: true });
    await assert.rejects(createSealedSqliteErasureLedgerSource(invalidSourceFixture), {
      code: "ERASURE_LEDGER_SOURCE_ROW_INVALID",
    });
    const noInvalidRun = await pool.query(`SELECT count(*)::int AS count
      FROM "${goodSchema}".postgres_erasure_ledger_transfer_runs WHERE transfer_id=$1`, [badSourceTransferId]);
    assert.equal(noInvalidRun.rows[0].count, 0, "invalid source must fail before writing transfer state");

    const blockedParticipant = "2".repeat(64);
    await pool.query(`ALTER TABLE "${goodSchema}".postgres_erasure_ledger_transfer_jobs
      ADD CONSTRAINT synthetic_interruption CHECK (participant_digest <> '${blockedParticipant}')`);
    await assert.rejects(runPostgresErasureLedgerTransfer({ source, destinationPool: pool,
      targetSchema: goodSchema, transferId, pageSize: 1 }),
    error => error?.code === "ERASURE_LEDGER_PAGE_COMMIT_FAILED");
    const interrupted = await pool.query(`SELECT DISTINCT ON (table_name)
        table_name,checkpoint_no::text,row_count::text,complete
      FROM "${goodSchema}".postgres_erasure_ledger_transfer_checkpoints
      WHERE transfer_id=$1 ORDER BY table_name,checkpoint_no DESC`, [transferId]);
    assert.deepEqual(interrupted.rows, [
      { table_name: "deletion_tombstones", checkpoint_no: "3", row_count: "2", complete: true },
      { table_name: "identity_reenrollment_cooldowns", checkpoint_no: "2", row_count: "1", complete: true },
      { table_name: "storage_erasure_jobs", checkpoint_no: "1", row_count: "1", complete: false },
    ]);
    await pool.query(`ALTER TABLE "${goodSchema}".postgres_erasure_ledger_transfer_jobs
      DROP CONSTRAINT synthetic_interruption`);

    const result = await runPostgresErasureLedgerTransfer({ source, destinationPool: pool,
      targetSchema: goodSchema, transferId, pageSize: 1 });
    assert.equal(result.status, "historical_erasure_ledger_reconciled");
    assert.equal(result.pagesCommitted, 1);
    assert.equal(result.resumed, true);
    assert.equal(result.operationalRowsPromoted, true);
    assert.equal(result.capabilities.applicationLedgerRoutingChanged, false);
    assert.equal(result.capabilities.erasureRuntimeActivated, false);
    assert.equal(result.capabilities.productionCutoverAuthorized, false);
    assert.equal(result.tables.deletion_tombstones.sourceRows, 2);
    assert.equal(result.tables.identity_reenrollment_cooldowns.sourceRows, 1);
    assert.equal(result.tables.storage_erasure_jobs.sourceRows, 2);
    for (const table of Object.values(result.tables)) {
      assert.equal(table.sourceRows, table.targetRows);
      assert.equal(table.sourceSha256, table.targetSha256);
    }

    const run = await pool.query(`SELECT status,source_manifest_sha256,target_manifest_sha256
      FROM "${goodSchema}".postgres_erasure_ledger_transfer_runs WHERE transfer_id=$1`, [transferId]);
    assert.deepEqual(run.rows[0], { status: "complete", source_manifest_sha256: result.sourceManifestSha256,
      target_manifest_sha256: result.stagedManifestSha256 });
    const receiptCounts = await pool.query(`SELECT
      (SELECT count(*)::int FROM "${goodSchema}".postgres_erasure_ledger_transfer_checkpoints WHERE transfer_id=$1) AS checkpoints,
      (SELECT bool_and(complete) FROM (
        SELECT DISTINCT ON (table_name) complete
          FROM "${goodSchema}".postgres_erasure_ledger_transfer_checkpoints
         WHERE transfer_id=$1 ORDER BY table_name,checkpoint_no DESC
      ) latest) AS complete,
      (SELECT count(*)::int FROM "${goodSchema}".postgres_erasure_ledger_transfer_table_receipts WHERE transfer_id=$1) AS receipts`,
    [transferId]);
    assert.deepEqual(receiptCounts.rows[0], { checkpoints: 8, complete: true, receipts: 3 });

    const livePending = "1".repeat(64);
    await assert.rejects(pool.query(`DELETE FROM "${goodSchema}".deletion_tombstones WHERE participant_digest=$1`,
      [livePending]), error => error?.code === "P1005");
    await assert.rejects(pool.query(`UPDATE "${goodSchema}".storage_erasure_jobs SET attempted_ms=attempted_ms-1
      WHERE participant_digest=$1`, [livePending]), error => error?.code === "P1005");
    await assert.rejects(pool.query(`UPDATE "${goodSchema}".storage_erasure_jobs SET terminal_json='{}'
      WHERE participant_digest=$1`, [livePending]), error => error?.code === "P1005");
    await assert.rejects(pool.query(`DELETE FROM "${goodSchema}".postgres_erasure_ledger_transfer_checkpoints
      WHERE transfer_id=$1`, [transferId]), error => error?.code === "P1005");
    await assert.rejects(pool.query(`TRUNCATE "${goodSchema}".postgres_erasure_ledger_transfer_table_receipts`),
      error => error?.code === "P1005");
    await assert.rejects(pool.query(`UPDATE "${goodSchema}".postgres_erasure_ledger_transfer_table_receipts
      SET source_row_count=source_row_count+1 WHERE transfer_id=$1`, [transferId]), error => error?.code === "P1005");
    await assert.rejects(pool.query(`UPDATE "${goodSchema}".postgres_erasure_ledger_transfer_runs
      SET target_manifest_sha256=$2 WHERE transfer_id=$1`, [transferId, "a".repeat(64)]), error => error?.code === "P1005");
    await assert.rejects(pool.query(`INSERT INTO "${goodSchema}".postgres_erasure_ledger_transfer_tombstones
      (transfer_id,participant_digest,schema_version,deleted_at,retain_until)
      VALUES($1,$2,'participant-deletion-tombstone-v0.1','2026-08-01T00:00:00Z','2026-09-01T00:00:00Z')`,
    [transferId, "4".repeat(64)]), error => error?.code === "P1005");

    const completeJob = await pool.query(`SELECT participant_digest FROM "${goodSchema}".storage_erasure_jobs
      WHERE state='complete'`);
    const transaction = await pool.connect();
    try {
      await transaction.query("BEGIN");
      await transaction.query(`UPDATE "${goodSchema}".storage_erasure_jobs
        SET state='pending',completed_at=NULL,attempted_ms=attempted_ms+1 WHERE participant_digest=$1`,
      [completeJob.rows[0].participant_digest]);
      await transaction.query("ROLLBACK");
    } finally {
      transaction.release();
    }
    const stillComplete = await pool.query(`SELECT state,terminal_json IS NOT NULL AS has_terminal
      FROM "${goodSchema}".storage_erasure_jobs WHERE participant_digest=$1`, [completeJob.rows[0].participant_digest]);
    assert.deepEqual(stillComplete.rows[0], { state: "complete", has_terminal: true },
      "D1 permits a completed erasure job to reopen as pending while retaining its terminal proof");

    const resumed = await runPostgresErasureLedgerTransfer({ source, destinationPool: pool,
      targetSchema: goodSchema, transferId, pageSize: 1 });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.pagesCommitted, 0);
    assert.equal(resumed.operationalRowsPromoted, false);

    await pool.query(`CREATE SCHEMA "${driftSchema}"`);
    schemas.push(driftSchema);
    await applyPostgresMigrations({ role: "ledger", schema: driftSchema, pool });
    await pool.query(`INSERT INTO "${driftSchema}".deletion_tombstones
      (participant_digest,schema_version,deleted_at,retain_until)
      VALUES($1,'participant-deletion-tombstone-v0.1','2026-08-01T00:00:00Z','2026-09-01T00:00:00Z')`,
    ["9".repeat(64)]);
    driftSource = await createSealedSqliteErasureLedgerSource(sourceFixture);
    await assert.rejects(runPostgresErasureLedgerTransfer({ source: driftSource, destinationPool: pool,
      targetSchema: driftSchema, transferId: driftTransferId, pageSize: 2 }),
    error => error?.code === "ERASURE_LEDGER_EXISTING_TARGET_DRIFT");
    const drift = await pool.query(`SELECT participant_digest FROM "${driftSchema}".deletion_tombstones`);
    assert.deepEqual(drift.rows.map(row => row.participant_digest), ["9".repeat(64)]);
    const staged = await pool.query(`SELECT status FROM "${driftSchema}".postgres_erasure_ledger_transfer_runs
      WHERE transfer_id=$1`, [driftTransferId]);
    assert.equal(staged.rows[0].status, "staged", "target drift leaves an auditable staged run and does not overwrite rows");
  } finally {
    source?.close();
    driftSource?.close();
    if (sourceFixture) await rm(sourceFixture.directory, { recursive: true, force: true });
    if (invalidSourceFixture) await rm(invalidSourceFixture.directory, { recursive: true, force: true });
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    for (const schema of schemas.reverse()) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
  }
});
