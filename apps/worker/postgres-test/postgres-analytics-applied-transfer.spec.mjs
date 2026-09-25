import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  POSTGRES_ANALYTICS_APPLIED_RECEIPT_TABLE,
  transferPostgresAnalyticsAppliedReceipts,
} from "../scripts/postgres-analytics-applied-transfer.mjs";
import { createSealedSqliteAnalyticsHistorySource } from "../scripts/postgres-analytics-history-transfer.mjs";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER || "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD || "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";
const SOURCE_ID = "synthetic-analytics-applied-source";

function digest(value) { return BigInt(value).toString(16).padStart(64, "0"); }

async function makeSealedSource() {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-analytics-applied-pg17-"));
  const path = join(await realpath(directory), "analytics-source.sqlite");
  const database = new DatabaseSync(path);
  const ownerA = "a".repeat(64);
  const ownerB = "b".repeat(64);
  const events = [
    [ownerA, 1, "owner-active", 1, 1],
    [ownerA, 2, "source-updated", 1, 1],
    [ownerA, 3, "owner-withdrawn", 2, 2],
    [ownerB, 1, "owner-active", 1, 3],
    [ownerB, 2, "source-updated", 1, 3],
    [ownerB, 3, "owner-erased", 2, 4],
  ];
  try {
    database.exec(`
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
    database.prepare("INSERT INTO analytics_runtime_sources VALUES(?,?,1)")
      .run(SOURCE_ID, "synthetic-analytics-applied-namespace");
    database.prepare("INSERT INTO analytics_source_cursors VALUES(?,?,?)").run(SOURCE_ID, 6n, 4n);
    database.prepare("INSERT INTO analytics_owner_state VALUES(?,?,?,?,?)").run(SOURCE_ID, ownerA, 3n, 2n, "withdrawn");
    database.prepare("INSERT INTO analytics_owner_state VALUES(?,?,?,?,?)").run(SOURCE_ID, ownerB, 3n, 2n, "erased");
    const insert = database.prepare(`INSERT INTO analytics_applied_events(
      source_id,sequence,event_digest,owner_digest,revision,kind,object_digest,content_digest,
      authority_epoch,public_authority_epoch,recorded_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    events.forEach(([owner, revision, kind, authorityEpoch, publicAuthorityEpoch], index) => {
      const sequence = index + 1;
      insert.run(SOURCE_ID, BigInt(sequence), digest(sequence * 10 + 1), owner, BigInt(revision), kind,
        digest(sequence * 10 + 2), digest(sequence * 10 + 3), BigInt(authorityEpoch), BigInt(publicAuthorityEpoch),
        BigInt(1_790_000_000_000 + sequence));
    });
  } finally {
    database.close();
  }
  await chmod(path, 0o400);
  const sourceSnapshotSha256 = createHash("sha256").update(await readFile(path)).digest("hex");
  return {
    directory,
    path: await realpath(path),
    sourceSnapshotSha256,
    source: await createSealedSqliteAnalyticsHistorySource({ path: await realpath(path), expectedSha256: sourceSnapshotSha256 }),
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

describe.skipIf(!PG_TEST_SOCKET)("PostgreSQL 17 synthetic analytics applied receipt transfer", () => {
  let pool;

  beforeAll(async () => {
    pool = new pg.Pool({ ...(await localSocket()), user: PG_TEST_USER, password: PG_TEST_PASSWORD,
      database: PG_TEST_DATABASE, ssl: false, max: 2, connectionTimeoutMillis: 5_000,
      application_name: "pg-analytics-applied-transfer-test" });
    const locality = await pool.query("SELECT inet_server_addr() AS address,current_setting('server_version_num') AS version");
    assert.equal(locality.rows[0]?.address, null, "qualification requires the local Unix socket");
    assert.match(locality.rows[0]?.version ?? "", /^17\d+$/u, "test must run on PostgreSQL 17");
  }, 120_000);

  afterAll(async () => { if (pool) await pool.end(); });

  it("atomically checkpoints exact receipt tuples, resumes, and leaves application authority untouched", async () => {
    const schema = `analytics_applied_transfer_target_${randomBytes(6).toString("hex")}`;
    const quoted = `"${schema}"`;
    const table = name => `${quoted}."${name}"`;
    let schemaCreated = false;
    let fixture;
    const transferId = "synthetic-analytics-applied-pg17-resume";
    try {
      await pool.query(`CREATE SCHEMA ${quoted}`);
      schemaCreated = true;
      const migration = await applyPostgresMigrations({ role: "primary", schema, pool });
      expect(migration.applied).toBe(39);
      expect(migration.migrations.at(-1)?.name).toBe("0039_analytics_applied_projection_v1.sql");
      fixture = await makeSealedSource();

      await pool.query(`CREATE TABLE ${table(POSTGRES_ANALYTICS_APPLIED_RECEIPT_TABLE)} (
        source_id text NOT NULL CHECK (source_id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'),
        sequence bigint NOT NULL CHECK (sequence > 0),
        event_digest text NOT NULL CHECK (event_digest ~ '^[0-9a-f]{64}$'),
        owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
        revision bigint NOT NULL CHECK (revision > 0),
        kind text NOT NULL CHECK (kind IN ('source-updated','owner-active','owner-withdrawn','owner-erased')),
        object_digest text NOT NULL CHECK (object_digest ~ '^[0-9a-f]{64}$'),
        content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
        authority_epoch bigint NOT NULL CHECK (authority_epoch > 0),
        public_authority_epoch bigint NOT NULL CHECK (public_authority_epoch > 0),
        recorded_ms bigint NOT NULL CHECK (recorded_ms >= 0),
        PRIMARY KEY (source_id,sequence),UNIQUE (source_id,event_digest),
        CONSTRAINT synthetic_transfer_interrupt CHECK(sequence < 3)
      )`);
      await expect(transferPostgresAnalyticsAppliedReceipts({ source: fixture.source, destinationPool: pool,
        targetSchema: schema, transferId, pageSize: 2 }))
        .rejects.toMatchObject({ code: "ANALYTICS_APPLIED_PAGE_COMMIT_FAILED" });

      const partial = await pool.query(`SELECT count(*)::text AS rows,max(sequence)::text AS last_sequence
        FROM ${table(POSTGRES_ANALYTICS_APPLIED_RECEIPT_TABLE)}`);
      expect(partial.rows[0]).toEqual({ rows: "2", last_sequence: "2" });
      const checkpoint = await pool.query(`SELECT last_source_id,last_sequence::text AS last_sequence,
          row_count::text AS row_count,page_count,complete
        FROM ${table("_synthetic_analytics_applied_transfer_checkpoints_v1")} WHERE transfer_id=$1`, [transferId]);
      expect(checkpoint.rows).toEqual([{ last_source_id: SOURCE_ID, last_sequence: "2", row_count: "2", page_count: 1, complete: false }]);

      await pool.query(`ALTER TABLE ${table(POSTGRES_ANALYTICS_APPLIED_RECEIPT_TABLE)} DROP CONSTRAINT synthetic_transfer_interrupt`);
      const result = await transferPostgresAnalyticsAppliedReceipts({ source: fixture.source, destinationPool: pool,
        targetSchema: schema, transferId, pageSize: 2 });
      expect(result).toMatchObject({
        schema: "synthetic-analytics-applied-receipts-transfer-v1",
        status: "synthetic_analytics_applied_receipt_transfer_complete",
        targetSchema: schema,
        postgresMajor: 17,
        sourceSnapshotSha256: fixture.sourceSnapshotSha256,
        eventRows: "6",
        targetRows: "6",
        pageSize: 2,
        pagesCommitted: 2,
        rowsInserted: "4",
        resumed: true,
        mainAppliedEventsWritten: false,
        analyticsCursorAdvanced: false,
        ownerStateWritten: false,
        publicationActivated: false,
        projectionJsonFabricated: false,
      });
      expect(result.eventRowsSha256).toBe(result.targetRowsSha256);
      expect("sourceId" in result).toBe(false);
      expect("ownerDigest" in result).toBe(false);

      const rows = await pool.query(`SELECT source_id,sequence::text AS sequence,event_digest,owner_digest,
          revision::text AS revision,kind,object_digest,content_digest,authority_epoch::text AS authority_epoch,
          public_authority_epoch::text AS public_authority_epoch,recorded_ms::text AS recorded_ms
        FROM ${table(POSTGRES_ANALYTICS_APPLIED_RECEIPT_TABLE)} ORDER BY source_id COLLATE "C",sequence`);
      expect(rows.rows).toHaveLength(6);
      expect(rows.rows.map(row => [row.sequence, row.revision, row.kind, row.authority_epoch, row.public_authority_epoch])).toEqual([
        ["1", "1", "owner-active", "1", "1"], ["2", "2", "source-updated", "1", "1"],
        ["3", "3", "owner-withdrawn", "2", "2"], ["4", "1", "owner-active", "1", "3"],
        ["5", "2", "source-updated", "1", "3"], ["6", "3", "owner-erased", "2", "4"],
      ]);
      const untouched = await pool.query(`SELECT
          (SELECT count(*)::int FROM ${table("storage_source_state")}) AS source_state,
          (SELECT count(*)::int FROM ${table("analytics_applied_events")}) AS application_receipts,
          (SELECT count(*)::int FROM ${table("analytics_source_cursors")}) AS cursors,
          (SELECT count(*)::int FROM ${table("analytics_owner_state")}) AS owners,
          (SELECT count(*)::int FROM ${table("analytics_publication_captures")}) AS captures,
          (SELECT count(*)::int FROM ${table("analytics_publications")}) AS publications,
          (SELECT count(*)::int FROM ${table("analytics_publication_invalidations")}) AS invalidations,
          (SELECT count(*)::int FROM ${table("community_daily_aggregates")}) AS daily`);
      expect(untouched.rows[0]).toEqual({ source_state: 0, application_receipts: 0, cursors: 0, owners: 0,
        captures: 0, publications: 0, invalidations: 0, daily: 0 });

      const replay = await transferPostgresAnalyticsAppliedReceipts({ source: fixture.source, destinationPool: pool,
        targetSchema: schema, transferId, pageSize: 2 });
      expect(replay.status).toBe("already_complete");
      expect(replay.pagesCommitted).toBe(0);
      expect(replay.eventRowsSha256).toBe(result.targetRowsSha256);
      expect((await pool.query(`SELECT count(*)::int AS rows FROM ${table(POSTGRES_ANALYTICS_APPLIED_RECEIPT_TABLE)}`))
        .rows[0]?.rows).toBe(6);
    } finally {
      fixture?.source.close();
      if (fixture) await rm(fixture.directory, { recursive: true, force: true });
      if (schemaCreated) await pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => {});
    }
  }, 120_000);

  it("refuses a target where cursor authority already exists", async () => {
    const schema = `analytics_applied_transfer_target_${randomBytes(6).toString("hex")}`;
    const quoted = `"${schema}"`;
    let fixture;
    let schemaCreated = false;
    try {
      await pool.query(`CREATE SCHEMA ${quoted}`);
      schemaCreated = true;
      await applyPostgresMigrations({ role: "primary", schema, pool });
      fixture = await makeSealedSource();
      await pool.query(`INSERT INTO ${quoted}.analytics_source_cursors(source_id,sequence,authority_epoch)
        VALUES($1,0,0)`, [SOURCE_ID]);

      await expect(transferPostgresAnalyticsAppliedReceipts({ source: fixture.source, destinationPool: pool,
        targetSchema: schema, transferId: "synthetic-analytics-applied-refuse-authority", pageSize: 2 }))
        .rejects.toMatchObject({ code: "ANALYTICS_APPLIED_APP_STATE_NOT_EMPTY" });
      const staging = await pool.query("SELECT to_regclass($1) AS relation", [`${schema}.${POSTGRES_ANALYTICS_APPLIED_RECEIPT_TABLE}`]);
      expect(staging.rows[0]?.relation).toBeNull();
      expect((await pool.query(`SELECT count(*)::int AS count FROM ${quoted}.analytics_source_cursors`)).rows[0]?.count).toBe(1);
    } finally {
      fixture?.source.close();
      if (fixture) await rm(fixture.directory, { recursive: true, force: true });
      if (schemaCreated) await pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => {});
    }
  }, 120_000);
});
