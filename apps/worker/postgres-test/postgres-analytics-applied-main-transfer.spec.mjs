import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  createSealedSqliteIngestionJournalSource,
  transferPostgresIngestionJournal,
} from "../scripts/postgres-ingestion-journal-transfer.mjs";
import {
  transferPostgresAnalyticsAppliedMain,
} from "../scripts/postgres-analytics-applied-main-transfer.mjs";
import { createSealedSqliteAnalyticsHistorySource } from "../scripts/postgres-analytics-history-transfer.mjs";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER || "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD || "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";
const SOURCE_ID = "synthetic-analytics-main-source";
const JOURNAL_TRANSFER_ID = "synthetic-ingestion-journal-main-sequence";
const APPLIED_TRANSFER_ID = "synthetic-analytics-applied-main-sequence";

function digest(value) { return BigInt(value).toString(16).padStart(64, "0"); }

const EVENTS = Object.freeze([
  Object.freeze({ owner: "a".repeat(64), sequence: 1, revision: 1, kind: "owner-active", authority: 1, publicAuthority: 1 }),
  Object.freeze({ owner: "a".repeat(64), sequence: 2, revision: 2, kind: "source-updated", authority: 1, publicAuthority: 1 }),
  Object.freeze({ owner: "a".repeat(64), sequence: 3, revision: 3, kind: "owner-withdrawn", authority: 2, publicAuthority: 2 }),
  Object.freeze({ owner: "b".repeat(64), sequence: 4, revision: 1, kind: "owner-active", authority: 1, publicAuthority: 3 }),
  Object.freeze({ owner: "b".repeat(64), sequence: 5, revision: 2, kind: "source-updated", authority: 1, publicAuthority: 3 }),
  Object.freeze({ owner: "b".repeat(64), sequence: 6, revision: 3, kind: "owner-erased", authority: 2, publicAuthority: 4 }),
]);

async function seal(path) {
  await chmod(path, 0o400);
  const expectedSha256 = createHash("sha256").update(await readFile(path)).digest("hex");
  return { path: await realpath(path), expectedSha256 };
}

async function makeSources({ namespace = "synthetic-analytics-main-namespace", journalContentOverride = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-analytics-applied-main-pg17-"));
  const root = await realpath(directory);
  const appliedPath = join(root, "analytics-source.sqlite");
  const applied = new DatabaseSync(appliedPath);
  try {
    applied.exec(`
      CREATE TABLE analytics_runtime_sources(
        source_id TEXT PRIMARY KEY,source_namespace TEXT NOT NULL,contract_version INTEGER NOT NULL CHECK(contract_version=1)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE analytics_source_cursors(
        source_id TEXT PRIMARY KEY,sequence INTEGER NOT NULL DEFAULT 0 CHECK(sequence>=0),
        authority_epoch INTEGER NOT NULL DEFAULT 0 CHECK(authority_epoch>=0)
      ) STRICT;
      CREATE TABLE analytics_owner_state(
        source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
        authority_epoch INTEGER NOT NULL CHECK(authority_epoch>0),state TEXT NOT NULL CHECK(state IN('active','withdrawn','erased')),
        PRIMARY KEY(source_id,owner_digest)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE analytics_applied_events(
        source_id TEXT NOT NULL,sequence INTEGER NOT NULL,event_digest TEXT NOT NULL,owner_digest TEXT NOT NULL,
        revision INTEGER NOT NULL,kind TEXT NOT NULL,object_digest TEXT NOT NULL,content_digest TEXT NOT NULL,
        authority_epoch INTEGER NOT NULL,public_authority_epoch INTEGER NOT NULL,recorded_ms INTEGER NOT NULL,
        PRIMARY KEY(source_id,sequence),UNIQUE(source_id,event_digest)
      ) STRICT, WITHOUT ROWID;
    `);
    applied.prepare("INSERT INTO analytics_runtime_sources VALUES(?,?,1)").run(SOURCE_ID, namespace);
    applied.prepare("INSERT INTO analytics_source_cursors VALUES(?,?,?)").run(SOURCE_ID, 6n, 4n);
    applied.prepare("INSERT INTO analytics_owner_state VALUES(?,?,?,?,?)")
      .run(SOURCE_ID, "a".repeat(64), 3n, 2n, "withdrawn");
    applied.prepare("INSERT INTO analytics_owner_state VALUES(?,?,?,?,?)")
      .run(SOURCE_ID, "b".repeat(64), 3n, 2n, "erased");
    const insert = applied.prepare(`INSERT INTO analytics_applied_events(
      source_id,sequence,event_digest,owner_digest,revision,kind,object_digest,content_digest,
      authority_epoch,public_authority_epoch,recorded_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    for (const event of EVENTS) {
      const n = event.sequence;
      insert.run(SOURCE_ID, BigInt(n), digest(n * 10 + 1), event.owner, BigInt(event.revision), event.kind,
        digest(n * 10 + 2), digest(n * 10 + 3), BigInt(event.authority), BigInt(event.publicAuthority),
        BigInt(1_790_000_000_000 + n));
    }
  } finally { applied.close(); }

  const journalPath = join(root, "ingestion-journal.sqlite");
  const journal = new DatabaseSync(journalPath);
  try {
    journal.exec(`
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
    journal.prepare("INSERT INTO storage_source_state(singleton,source_id,authority_epoch) VALUES(1,?,4)").run(SOURCE_ID);
    const insert = journal.prepare(`INSERT INTO storage_ingestion_changes(
      sequence,event_digest,owner_digest,revision,kind,object_digest,content_digest,
      authority_epoch,public_authority_epoch,recorded_ms) VALUES(?,?,?,?,?,?,?,?,?,?)`);
    for (const event of EVENTS) {
      const n = event.sequence;
      insert.run(n, digest(n * 10 + 1), event.owner, event.revision, event.kind,
        digest(n * 10 + 2), journalContentOverride === n ? digest(999_000 + n) : digest(n * 10 + 3),
        event.authority, event.publicAuthority, 1_790_000_000_000 + n);
    }
  } finally { journal.close(); }

  const appliedSeal = await seal(appliedPath);
  const journalSeal = await seal(journalPath);
  return {
    directory,
    appliedSnapshotSha256: appliedSeal.expectedSha256,
    journalSnapshotSha256: journalSeal.expectedSha256,
    appliedSource: await createSealedSqliteAnalyticsHistorySource(appliedSeal),
    journalSource: await createSealedSqliteIngestionJournalSource({
      ...journalSeal,
      expectedSourceId: SOURCE_ID,
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

async function createTarget(pool) {
  const schema = `storage_journal_transfer_target_${randomBytes(6).toString("hex")}`;
  const quoted = `"${schema}"`;
  await pool.query(`CREATE SCHEMA ${quoted}`);
  const migration = await applyPostgresMigrations({ role: "primary", schema, pool });
  expect(migration.applied).toBe(42);
  expect(migration.migrations.at(-1)?.name).toBe("0042_accountless_history_retention_import.sql");
  return { schema, quoted, table: name => `${quoted}."${name}"` };
}

async function importJournal(pool, target, fixture, transferId = JOURNAL_TRANSFER_ID) {
  return transferPostgresIngestionJournal({ source: fixture.journalSource, destinationPool: pool,
    targetSchema: target.schema, transferId, pageSize: 2 });
}

async function closeFixture(fixture) {
  fixture?.appliedSource.close();
  fixture?.journalSource.close();
  if (fixture) await rm(fixture.directory, { recursive: true, force: true });
}

describe.skipIf(!PG_TEST_SOCKET)("PostgreSQL 17 exact analytics applied main-table transfer", () => {
  let pool;
  beforeAll(async () => {
    pool = new pg.Pool({ ...(await localSocket()), user: PG_TEST_USER, password: PG_TEST_PASSWORD,
      database: PG_TEST_DATABASE, ssl: false, max: 2, connectionTimeoutMillis: 5_000,
      application_name: "pg-analytics-applied-main-transfer-test" });
    const locality = await pool.query("SELECT inet_server_addr() AS address,current_setting('server_version_num') AS version");
    assert.equal(locality.rows[0]?.address, null);
    assert.match(locality.rows[0]?.version ?? "", /^17\d+$/u);
  }, 120_000);

  afterAll(async () => { if (pool) await pool.end(); });

  it("imports exact v1 tuples after journal parity, resumes safely, and leaves authority tables empty", async () => {
    let fixture;
    let target;
    try {
      fixture = await makeSources();
      target = await createTarget(pool);
      const journal = await importJournal(pool, target, fixture);
      expect(journal.status).toBe("synthetic_storage_ingestion_journal_transfer_complete");
      await pool.query(`ALTER TABLE ${target.table("analytics_applied_events")}
        ADD CONSTRAINT synthetic_main_transfer_interrupt CHECK(sequence < 3)`);
      await expect(transferPostgresAnalyticsAppliedMain({ source: fixture.appliedSource, destinationPool: pool,
        targetSchema: target.schema, transferId: APPLIED_TRANSFER_ID, journalTransferId: JOURNAL_TRANSFER_ID,
        pageSize: 2 })).rejects.toMatchObject({ code: "ANALYTICS_APPLIED_MAIN_PAGE_COMMIT_FAILED" });

      const partial = await pool.query(`SELECT count(*)::text AS rows,max(sequence)::text AS last_sequence,
          count(*) FILTER (WHERE projection_json IS NULL AND event_tuple_version=1)::text AS exact_v1
        FROM ${target.table("analytics_applied_events")}`);
      expect(partial.rows[0]).toEqual({ rows: "2", last_sequence: "2", exact_v1: "2" });
      const checkpoint = await pool.query(`SELECT row_count::text AS row_count,page_count,complete
        FROM ${target.table("_synthetic_analytics_applied_main_transfer_checkpoints_v1")} WHERE transfer_id=$1`,
      [APPLIED_TRANSFER_ID]);
      expect(checkpoint.rows).toEqual([{ row_count: "2", page_count: 1, complete: false }]);

      await pool.query(`ALTER TABLE ${target.table("analytics_applied_events")} DROP CONSTRAINT synthetic_main_transfer_interrupt`);
      const result = await transferPostgresAnalyticsAppliedMain({ source: fixture.appliedSource, destinationPool: pool,
        targetSchema: target.schema, transferId: APPLIED_TRANSFER_ID, journalTransferId: JOURNAL_TRANSFER_ID,
        pageSize: 2 });
      expect(result).toMatchObject({
        schema: "sealed-d1-applied-events-to-postgres-v1",
        status: "synthetic_analytics_applied_main_transfer_complete",
        targetSchema: target.schema,
        postgresMajor: 17,
        sourceSnapshotSha256: fixture.appliedSnapshotSha256,
        eventRows: "6",
        targetRows: "6",
        journalSnapshotSha256: fixture.journalSnapshotSha256,
        journalRows: "6",
        pageSize: 2,
        pagesCommitted: 2,
        rowsInserted: "4",
        resumed: true,
        mainAppliedEventsWritten: true,
        projectionJsonFabricated: false,
        analyticsCursorAdvanced: false,
        ownerStateWritten: false,
        publicationActivated: false,
        sourceNamespaceCrossArtifactCompared: false,
      });
      expect(result.eventRowsSha256).toBe(result.targetRowsSha256);
      expect(result.journalRowsSha256).toBe(result.eventRowsSha256);
      expect("sourceId" in result).toBe(false);
      expect("sourceNamespaceSha256" in result).toBe(false);

      const tuples = await pool.query(`SELECT source_id,sequence::text AS sequence,event_digest,owner_digest,
          authority_epoch::text AS authority_epoch,projection_json,event_tuple_version,
          revision::text AS revision,kind,object_digest,content_digest,
          public_authority_epoch::text AS public_authority_epoch,recorded_ms::text AS recorded_ms
        FROM ${target.table("analytics_applied_events")} ORDER BY source_id COLLATE "C",sequence`);
      expect(tuples.rows).toHaveLength(6);
      expect(tuples.rows.every(row => row.projection_json === null && row.event_tuple_version === 1)).toBe(true);
      expect(tuples.rows.map(row => [row.sequence, row.revision, row.kind, row.authority_epoch, row.public_authority_epoch])).toEqual([
        ["1", "1", "owner-active", "1", "1"], ["2", "2", "source-updated", "1", "1"],
        ["3", "3", "owner-withdrawn", "2", "2"], ["4", "1", "owner-active", "1", "3"],
        ["5", "2", "source-updated", "1", "3"], ["6", "3", "owner-erased", "2", "4"],
      ]);
      const untouched = await pool.query(`SELECT
          (SELECT count(*)::int FROM ${target.table("storage_source_state")}) AS source_state,
          (SELECT count(*)::int FROM ${target.table("storage_ingestion_changes")}) AS journal_rows,
          (SELECT count(*)::int FROM ${target.table("analytics_source_cursors")}) AS cursors,
          (SELECT count(*)::int FROM ${target.table("analytics_owner_state")}) AS owners,
          (SELECT count(*)::int FROM ${target.table("analytics_publication_captures")}) AS captures,
          (SELECT count(*)::int FROM ${target.table("analytics_publications")}) AS publications,
          (SELECT count(*)::int FROM ${target.table("analytics_publication_invalidations")}) AS invalidations,
          (SELECT count(*)::int FROM ${target.table("community_daily_aggregates")}) AS daily`);
      expect(untouched.rows[0]).toEqual({ source_state: 1, journal_rows: 6, cursors: 0, owners: 0,
        captures: 0, publications: 0, invalidations: 0, daily: 0 });
      const replay = await transferPostgresAnalyticsAppliedMain({ source: fixture.appliedSource, destinationPool: pool,
        targetSchema: target.schema, transferId: APPLIED_TRANSFER_ID, journalTransferId: JOURNAL_TRANSFER_ID,
        pageSize: 2 });
      expect(replay.status).toBe("already_complete");
      expect(replay.rowsInserted).toBe("0");
      expect((await pool.query(`SELECT count(*)::int AS rows FROM ${target.table("analytics_applied_events")}`))
        .rows[0]?.rows).toBe(6);

      const changedFixture = await makeSources({ namespace: "synthetic-analytics-main-namespace-changed" });
      try {
        await expect(transferPostgresAnalyticsAppliedMain({ source: changedFixture.appliedSource, destinationPool: pool,
          targetSchema: target.schema, transferId: APPLIED_TRANSFER_ID, journalTransferId: JOURNAL_TRANSFER_ID,
          pageSize: 2 })).rejects.toMatchObject({ code: "ANALYTICS_APPLIED_MAIN_TRANSFER_SOURCE_MISMATCH" });
        expect((await pool.query(`SELECT count(*)::int AS rows FROM ${target.table("analytics_applied_events")}`))
          .rows[0]?.rows).toBe(6);
      } finally { await closeFixture(changedFixture); }
    } finally {
      await closeFixture(fixture);
      if (target) await pool.query(`DROP SCHEMA IF EXISTS ${target.quoted} CASCADE`).catch(() => {});
    }
  }, 120_000);

  it("refuses an incomplete journal-transfer checkpoint before the main-table write", async () => {
    let fixture;
    let target;
    try {
      fixture = await makeSources();
      target = await createTarget(pool);
      await importJournal(pool, target, fixture);
      await pool.query(`UPDATE ${target.table("_storage_ingestion_journal_transfer_checkpoints_v1")}
        SET complete=false WHERE transfer_id=$1`, [JOURNAL_TRANSFER_ID]);
      await expect(transferPostgresAnalyticsAppliedMain({ source: fixture.appliedSource, destinationPool: pool,
        targetSchema: target.schema, transferId: APPLIED_TRANSFER_ID, journalTransferId: JOURNAL_TRANSFER_ID,
        pageSize: 2 })).rejects.toMatchObject({ code: "ANALYTICS_APPLIED_MAIN_JOURNAL_TRANSFER_MISMATCH" });
      expect((await pool.query(`SELECT count(*)::int AS rows FROM ${target.table("analytics_applied_events")}`))
        .rows[0]?.rows).toBe(0);
      const control = await pool.query("SELECT to_regclass($1) AS relation", [
        `${target.schema}._synthetic_analytics_applied_main_transfer_runs_v1`,
      ]);
      expect(control.rows[0]?.relation).toBeNull();
    } finally {
      await closeFixture(fixture);
      if (target) await pool.query(`DROP SCHEMA IF EXISTS ${target.quoted} CASCADE`).catch(() => {});
    }
  }, 120_000);

  it("refuses a journal receipt whose tuple digest does not match before creating a main-transfer run", async () => {
    let fixture;
    let target;
    try {
      fixture = await makeSources({ journalContentOverride: 3 });
      target = await createTarget(pool);
      await importJournal(pool, target, fixture);
      await expect(transferPostgresAnalyticsAppliedMain({ source: fixture.appliedSource, destinationPool: pool,
        targetSchema: target.schema, transferId: APPLIED_TRANSFER_ID, journalTransferId: JOURNAL_TRANSFER_ID,
        pageSize: 2 })).rejects.toMatchObject({ code: "ANALYTICS_APPLIED_MAIN_JOURNAL_TRANSFER_MISMATCH" });
      expect((await pool.query(`SELECT count(*)::int AS rows FROM ${target.table("analytics_applied_events")}`))
        .rows[0]?.rows).toBe(0);
      const control = await pool.query("SELECT to_regclass($1) AS relation", [
        `${target.schema}._synthetic_analytics_applied_main_transfer_runs_v1`,
      ]);
      expect(control.rows[0]?.relation).toBeNull();
    } finally {
      await closeFixture(fixture);
      if (target) await pool.query(`DROP SCHEMA IF EXISTS ${target.quoted} CASCADE`).catch(() => {});
    }
  }, 120_000);

  it("preserves and refuses legacy version-zero main receipts", async () => {
    let fixture;
    let target;
    try {
      fixture = await makeSources();
      target = await createTarget(pool);
      await importJournal(pool, target, fixture);
      await pool.query(`INSERT INTO ${target.table("analytics_applied_events")}
        (source_id,sequence,event_digest,owner_digest,authority_epoch,projection_json)
        VALUES($1,1,$2,$3,0,'legacy-v0-fixture')`, [SOURCE_ID, digest(808), "c".repeat(64)]);
      await expect(transferPostgresAnalyticsAppliedMain({ source: fixture.appliedSource, destinationPool: pool,
        targetSchema: target.schema, transferId: APPLIED_TRANSFER_ID, journalTransferId: JOURNAL_TRANSFER_ID,
        pageSize: 2 })).rejects.toMatchObject({ code: "ANALYTICS_APPLIED_MAIN_TARGET_NOT_EMPTY" });
      const legacy = await pool.query(`SELECT event_tuple_version,projection_json,revision
        FROM ${target.table("analytics_applied_events")}`);
      expect(legacy.rows).toEqual([{ event_tuple_version: 0, projection_json: "legacy-v0-fixture", revision: null }]);
    } finally {
      await closeFixture(fixture);
      if (target) await pool.query(`DROP SCHEMA IF EXISTS ${target.quoted} CASCADE`).catch(() => {});
    }
  }, 120_000);
});
