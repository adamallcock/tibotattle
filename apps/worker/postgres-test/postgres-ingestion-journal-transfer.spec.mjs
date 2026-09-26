import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  createSealedSqliteIngestionJournalSource,
  transferPostgresIngestionJournal,
} from "../scripts/postgres-ingestion-journal-transfer.mjs";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER || "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD || "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";
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
      expect(migration.applied).toBe(45);
      expect(migration.migrations.at(-1)?.name).toBe("0045_accountless_v12_history_retention.sql");
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
