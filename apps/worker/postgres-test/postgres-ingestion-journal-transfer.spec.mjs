import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { gcpFastpathCloudTargetRefusal } from "../scripts/gcp-fastpath-cloud-target.mjs";
import {
  createSealedSqliteIngestionJournalSource,
  transferPostgresIngestionJournal,
} from "../scripts/postgres-ingestion-journal-transfer.mjs";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import {
  localFastpathTcpHost,
  localFastpathTcpPort,
  withLocalFastpathCloudDatabase,
} from "./fixtures/fastpath-cloud-database.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER || "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD || "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";
// Loopback TCP to the same cluster (inet_server_addr() is not NULL there), for
// the GCP fast-path cloud-target exception: PG_TEST_TCP_HOST (127.0.0.1, ::1
// or localhost; anything else is refused here) on PG_TEST_TCP_PORT, which
// defaults to PG_TEST_PORT. Unset, the second describe skips, so a
// socket-only cluster never dials TCP; the CI suite (scripts/ci-postgres-suite.mjs)
// passes both for its SOCKET pass. Plain process.env bindings, so the
// planner resolves the gate statically.
const PG_TEST_TCP_HOST = process.env.PG_TEST_TCP_HOST;
localFastpathTcpHost({ PG_TEST_TCP_HOST });
const PG_TEST_TCP_PORT = localFastpathTcpPort({ PG_TEST_TCP_PORT: process.env.PG_TEST_TCP_PORT }, PG_TEST_PORT);
const SOURCE_ID = "synthetic-ingestion-journal-source";

function digest(n) { return BigInt(n).toString(16).padStart(64, "0"); }

async function makeSealedSource() {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-ingestion-journal-pg17-"));
  const path = join(await realpath(directory), "journal.sqlite");
  const database = new DatabaseSync(path);
  const rows = [
    [1, "a", 1, "owner-active", 1, 1],
    [2, "a", 2, "source-updated", 1, 1],
    [3, "a", 3, "owner-withdrawn", 2, 2],
    [4, "b", 1, "owner-active", 1, 3],
    [5, "b", 2, "source-updated", 1, 3],
    [6, "b", 3, "owner-erased", 2, 4],
  ];
  try {
    database.exec(`
      CREATE TABLE storage_source_state(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),source_id TEXT NOT NULL UNIQUE,
        authority_epoch INTEGER NOT NULL DEFAULT 0 CHECK(authority_epoch>=0)
      ) STRICT;
      CREATE TABLE storage_ingestion_changes(
        sequence INTEGER PRIMARY KEY,event_digest TEXT NOT NULL UNIQUE,owner_digest TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>0),
        kind TEXT NOT NULL CHECK(kind IN('source-updated','owner-active','owner-withdrawn','owner-erased')),
        object_digest TEXT NOT NULL,content_digest TEXT NOT NULL CHECK(length(content_digest)=64),
        authority_epoch INTEGER NOT NULL CHECK(authority_epoch>0),
        public_authority_epoch INTEGER NOT NULL CHECK(public_authority_epoch>0),
        recorded_ms INTEGER NOT NULL CHECK(recorded_ms>=0),UNIQUE(owner_digest,revision)
      ) STRICT;
      CREATE INDEX storage_ingestion_owner_cursor ON storage_ingestion_changes(owner_digest,sequence);
    `);
    database.prepare("INSERT INTO storage_source_state(singleton,source_id,authority_epoch) VALUES(1,?,4)").run(SOURCE_ID);
    const insert = database.prepare(`INSERT INTO storage_ingestion_changes(
      sequence,event_digest,owner_digest,revision,kind,object_digest,content_digest,
      authority_epoch,public_authority_epoch,recorded_ms) VALUES(?,?,?,?,?,?,?,?,?,?)`);
    for (const [sequence, owner, revision, kind, authorityEpoch, publicEpoch] of rows) {
      insert.run(sequence, digest(sequence), owner.repeat(64), revision, kind, digest(sequence + 20), digest(sequence + 40),
        authorityEpoch, publicEpoch, 1_790_000_000_000 + sequence);
    }
  } finally {
    database.close();
  }
  await chmod(path, 0o400);
  const expectedSha256 = createHash("sha256").update(await readFile(path)).digest("hex");
  return {
    directory,
    path: await realpath(path),
    expectedSha256,
    source: await createSealedSqliteIngestionJournalSource({
      path: await realpath(path), expectedSha256, expectedSourceId: SOURCE_ID,
    }),
  };
}

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
  const link = await lstat(PG_TEST_SOCKET);
  const resolved = await realpath(PG_TEST_SOCKET);
  const metadata = await stat(resolved);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(resolved.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host: resolved, port: PG_TEST_PORT };
}

describe.skipIf(!PG_TEST_SOCKET)("PostgreSQL 17 sealed ingestion journal transfer", () => {
  let pool;

  afterAll(async () => { if (pool) await pool.end(); });

  it("rolls back a failed page, resumes by checkpoint, and writes no analytics or owner state", async () => {
    const socket = await localSocket();
    pool = new pg.Pool({ ...socket, user: PG_TEST_USER, password: PG_TEST_PASSWORD,
      database: PG_TEST_DATABASE, ssl: false, max: 2, connectionTimeoutMillis: 5_000,
      application_name: "pg-ingestion-journal-transfer-test" });
    const locality = await pool.query("SELECT inet_server_addr() AS address,current_setting('server_version_num') AS version");
    assert.equal(locality.rows[0]?.address, null, "qualification requires the local Unix socket");
    assert.match(locality.rows[0]?.version ?? "", /^17\d+$/u, "test must run on PostgreSQL 17");
    const schema = `storage_journal_transfer_target_${randomBytes(6).toString("hex")}`;
    const quoted = `"${schema}"`;
    const table = name => `${quoted}."${name}"`;
    let schemaCreated = false;
    let fixture;
    const transferId = "synthetic-ingestion-journal-pg17-resume";
    try {
      await pool.query(`CREATE SCHEMA ${quoted}`);
      schemaCreated = true;
      const migration = await applyPostgresMigrations({ role: "primary", schema, pool });
      expect(migration.applied).toBe(65);
      expect(migration.migrations.at(-1)?.name).toBe("0065_interim_public_read.sql");
      fixture = await makeSealedSource();

      await pool.query(`ALTER TABLE ${table("storage_ingestion_changes")}
        ADD CONSTRAINT synthetic_transfer_interrupt CHECK(sequence < 3)`);
      await expect(transferPostgresIngestionJournal({ source: fixture.source, destinationPool: pool,
        targetSchema: schema, transferId, pageSize: 2 }))
        .rejects.toMatchObject({ code: "INGESTION_JOURNAL_PAGE_COMMIT_FAILED" });

      const afterRollback = await pool.query(`SELECT count(*)::text AS rows,max(sequence)::text AS last_sequence
        FROM ${table("storage_ingestion_changes")}`);
      expect(afterRollback.rows[0]).toEqual({ rows: "2", last_sequence: "2" });
      const checkpoint = await pool.query(`SELECT last_sequence::text AS last_sequence,row_count::text AS row_count,
          page_count,complete FROM ${table("_storage_ingestion_journal_transfer_checkpoints_v1")}
        WHERE transfer_id=$1`, [transferId]);
      expect(checkpoint.rows).toEqual([{ last_sequence: "2", row_count: "2", page_count: 1, complete: false }]);

      await pool.query(`ALTER TABLE ${table("storage_ingestion_changes")} DROP CONSTRAINT synthetic_transfer_interrupt`);
      const result = await transferPostgresIngestionJournal({ source: fixture.source, destinationPool: pool,
        targetSchema: schema, transferId, pageSize: 2 });
      expect(result).toMatchObject({
        schema: "sealed-d1-ingestion-journal-to-postgres-v1",
        status: "synthetic_storage_ingestion_journal_transfer_complete",
        targetSchema: schema,
        sourceSnapshotSha256: fixture.expectedSha256,
        eventRows: "6",
        targetRows: "6",
        pageSize: 2,
        postgresMajor: 17,
        pagesCommitted: 2,
        rowsInserted: "4",
        resumed: true,
        restartMode: "verify_checkpoint_and_resume_after_last_sequence",
        analyticsCursorAdvanced: false,
        ownerStateWritten: false,
        appliedReceiptsWritten: false,
      });
      expect(result.eventRowsSha256).toBe(result.targetRowsSha256);
      expect("sourceId" in result).toBe(false);

      const tuples = await pool.query(`SELECT source_id,sequence::text AS sequence,event_digest,owner_digest,
          owner_revision::text AS owner_revision,authority_epoch::text AS authority_epoch,event_tuple_version,
          revision::text AS revision,kind,object_digest,content_digest,
          public_authority_epoch::text AS public_authority_epoch,recorded_ms::text AS recorded_ms
        FROM ${table("storage_ingestion_changes")} ORDER BY sequence`);
      expect(tuples.rows).toHaveLength(6);
      expect(tuples.rows.map(row => [row.sequence, row.event_tuple_version, row.revision, row.owner_revision])).toEqual([
        ["1", 1, "1", "0"], ["2", 1, "2", "0"], ["3", 1, "3", "0"],
        ["4", 1, "1", "0"], ["5", 1, "2", "0"], ["6", 1, "3", "0"],
      ]);
      expect(tuples.rows.map(row => row.kind)).toEqual([
        "owner-active", "source-updated", "owner-withdrawn", "owner-active", "source-updated", "owner-erased",
      ]);
      const sourceState = await pool.query(`SELECT singleton,source_id,authority_epoch::text AS authority_epoch
        FROM ${table("storage_source_state")}`);
      expect(sourceState.rows).toEqual([{ singleton: 1, source_id: SOURCE_ID, authority_epoch: "4" }]);
      const forbiddenWrites = await pool.query(`SELECT
          (SELECT count(*)::int FROM ${table("analytics_source_cursors")} WHERE source_id=$1) AS cursors,
          (SELECT count(*)::int FROM ${table("analytics_owner_state")} WHERE source_id=$1) AS owners,
          (SELECT count(*)::int FROM ${table("analytics_applied_events")} WHERE source_id=$1) AS receipts,
          (SELECT count(*)::int FROM ${table("analytics_publication_invalidations")} WHERE source_id=$1) AS invalidations,
          (SELECT count(*)::int FROM ${table("community_daily_aggregates")} WHERE source_id=$1) AS daily`, [SOURCE_ID]);
      expect(forbiddenWrites.rows[0]).toEqual({ cursors: 0, owners: 0, receipts: 0, invalidations: 0, daily: 0 });

      const replay = await transferPostgresIngestionJournal({ source: fixture.source, destinationPool: pool,
        targetSchema: schema, transferId, pageSize: 2 });
      expect(replay.status).toBe("already_complete");
      expect(replay.pagesCommitted).toBe(0);
      expect(replay.eventRowsSha256).toBe(result.targetRowsSha256);
      expect((await pool.query(`SELECT count(*)::int AS rows FROM ${table("storage_ingestion_changes")}`)).rows[0]?.rows).toBe(6);
    } finally {
      fixture?.source.close();
      if (fixture) await rm(fixture.directory, { recursive: true, force: true });
      if (schemaCreated) await pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => {});
    }
  }, 120_000);
});

describe.skipIf(!PG_TEST_SOCKET || !PG_TEST_TCP_HOST)(
  "PostgreSQL 17 ingestion journal transfer into the GCP fast-path cloud target (local TCP stand-in)", () => {
    it("admits a non-local session only with cloudFastpathTarget, in tibotattle_fastpath, for a fast-path target, "
      + "without a superuser; everything else keeps the local-socket refusal", async () => {
      const socket = await localSocket();
      const admin = { ...socket, user: PG_TEST_USER, password: PG_TEST_PASSWORD, database: PG_TEST_DATABASE, ssl: false };
      let fixture;
      try {
        fixture = await makeSealedSource();
        await withLocalFastpathCloudDatabase({ admin, tcpHost: PG_TEST_TCP_HOST, port: PG_TEST_TCP_PORT },
          async ({ database, roles, tcpPool }) => {
            expect(database).toBe("tibotattle_fastpath");
            const migrator = tcpPool({ user: roles.migrator, max: 2 });
            const superuser = tcpPool({ user: PG_TEST_USER, max: 2 });
            const elsewhere = tcpPool({ user: roles.migrator, database: PG_TEST_DATABASE, max: 2 });
            const session = await migrator.query(`SELECT inet_server_addr() IS NOT NULL AS tcp,
                current_database()::text AS db, rolsuper, rolcreaterole
              FROM pg_catalog.pg_roles WHERE rolname = session_user`);
            expect(session.rows[0]).toEqual({ tcp: true, db: "tibotattle_fastpath", rolsuper: false, rolcreaterole: true });

            const schema = `typed_legacy_transfer_rehearsal_target_fastpath_${randomBytes(4).toString("hex")}`;
            await migrator.query(`CREATE SCHEMA "${schema}"`);
            const migration = await applyPostgresMigrations({ role: "primary", schema, pool: migrator });
            expect(migration.applied).toBe(65);
            const table = name => `"${schema}"."${name}"`;
            const transferId = "synthetic-ingestion-journal-cloud-fastpath";
            const attempt = (pool, options = {}) => transferPostgresIngestionJournal({ source: fixture.source,
              destinationPool: pool, targetSchema: schema, transferId, pageSize: 2, ...options });
            const refusal = async (pool, target = schema) => {
              const client = await pool.connect();
              try { return await gcpFastpathCloudTargetRefusal(client, target); } finally { client.release(); }
            };

            // (a) The cloud-shaped session without the option keeps the original refusal.
            await expect(attempt(migrator)).rejects.toMatchObject({ code: "INGESTION_JOURNAL_LOCAL_POSTGRES_17_REQUIRED" });
            await expect(attempt(migrator, { cloudFastpathTarget: "true" }))
              .rejects.toMatchObject({ code: "INGESTION_JOURNAL_LOCAL_POSTGRES_17_REQUIRED" });
            // (b) The option in any other database is refused.
            expect(await refusal(elsewhere)).toBe("database");
            await expect(attempt(elsewhere, { cloudFastpathTarget: true }))
              .rejects.toMatchObject({ code: "INGESTION_JOURNAL_LOCAL_POSTGRES_17_REQUIRED" });
            // (d) A superuser is never the cloud target, even with the option.
            expect(await refusal(superuser)).toBe("superuser");
            await expect(attempt(superuser, { cloudFastpathTarget: true }))
              .rejects.toMatchObject({ code: "INGESTION_JOURNAL_LOCAL_POSTGRES_17_REQUIRED" });
            // The journal's own disposable prefix is not a cloud target, and the
            // disposable-schema guard still refuses a non-rehearsal schema first.
            const ownPrefix = `storage_journal_transfer_target_${randomBytes(4).toString("hex")}`;
            expect(await refusal(migrator, ownPrefix)).toBe("schema");
            await expect(transferPostgresIngestionJournal({ source: fixture.source, destinationPool: migrator,
              targetSchema: ownPrefix, transferId, pageSize: 2, cloudFastpathTarget: true }))
              .rejects.toMatchObject({ code: "INGESTION_JOURNAL_LOCAL_POSTGRES_17_REQUIRED" });
            await expect(transferPostgresIngestionJournal({ source: fixture.source, destinationPool: migrator,
              targetSchema: "public", transferId, pageSize: 2, cloudFastpathTarget: true }))
              .rejects.toMatchObject({ code: "INGESTION_JOURNAL_DISPOSABLE_SCHEMA_REQUIRED" });
            // Every refusal came before a write.
            const untouched = await migrator.query(`SELECT to_regclass($1) IS NULL AS no_runs,
                (SELECT count(*)::int FROM ${table("storage_ingestion_changes")}) AS journal,
                (SELECT count(*)::int FROM ${table("storage_source_state")}) AS states`,
            [`"${schema}"."_storage_ingestion_journal_transfer_runs_v1"`]);
            expect(untouched.rows[0]).toEqual({ no_runs: true, journal: 0, states: 0 });

            // (c) The option, tibotattle_fastpath, the fast-path prefix and a
            // non-superuser: the whole journal imports and replays as complete.
            expect(await refusal(migrator)).toBeNull();
            const result = await attempt(migrator, { cloudFastpathTarget: true });
            expect(result).toMatchObject({
              status: "synthetic_storage_ingestion_journal_transfer_complete",
              targetSchema: schema,
              sourceSnapshotSha256: fixture.expectedSha256,
              eventRows: "6",
              targetRows: "6",
              postgresMajor: 17,
              pagesCommitted: 3,
              rowsInserted: "6",
              resumed: false,
              analyticsCursorAdvanced: false,
              ownerStateWritten: false,
              appliedReceiptsWritten: false,
            });
            expect(result.eventRowsSha256).toBe(result.targetRowsSha256);
            const imported = await migrator.query(`SELECT count(*)::int AS rows, max(sequence)::text AS last_sequence
              FROM ${table("storage_ingestion_changes")}`);
            expect(imported.rows[0]).toEqual({ rows: 6, last_sequence: "6" });
            const replay = await attempt(migrator, { cloudFastpathTarget: true });
            expect(replay.status).toBe("already_complete");
            expect(replay.eventRowsSha256).toBe(result.targetRowsSha256);
            // The superuser is still refused after the import, and wrote nothing.
            await expect(attempt(superuser, { cloudFastpathTarget: true }))
              .rejects.toMatchObject({ code: "INGESTION_JOURNAL_LOCAL_POSTGRES_17_REQUIRED" });
            expect((await migrator.query(`SELECT count(*)::int AS rows FROM ${table("storage_ingestion_changes")}`))
              .rows[0]?.rows).toBe(6);
          });
      } finally {
        fixture?.source.close();
        if (fixture) await rm(fixture.directory, { recursive: true, force: true });
      }
    }, 180_000);
  });
