import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import pg from "pg";
import { createSealedSqliteIngestionJournalSource } from "../scripts/postgres-ingestion-journal-transfer.mjs";
import {
  createSealedSqliteAnalyticsHistorySource,
  transferPostgresAnalyticsHistoryBootstrap,
  transferPostgresAnalyticsHistoryState,
} from "../scripts/postgres-analytics-history-transfer.mjs";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "5432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD ?? "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";

function eventDigest(sequence, suffix) {
  return BigInt(sequence * 10 + suffix).toString(16).padStart(64, "0");
}

async function makeSealedSource({ namespace = "synthetic-analytics-namespace", journalContentOverride = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-analytics-history-pg17-"));
  const path = join(await realpath(directory), "analytics-source.sqlite");
  const database = new DatabaseSync(path);
  const sourceId = "synthetic-analytics-source";
  const owners = [
    { digest: "a".repeat(64), revision: 2, authorityEpoch: 1, state: "active" },
    { digest: "b".repeat(64), revision: 2, authorityEpoch: 2, state: "withdrawn" },
    { digest: "c".repeat(64), revision: 2, authorityEpoch: 2, state: "erased" },
  ];
  const events = [
    [owners[0], "owner-active", 1, 1, 1],
    [owners[0], "source-updated", 2, 1, 1],
    [owners[1], "owner-active", 1, 1, 2],
    [owners[1], "owner-withdrawn", 2, 2, 3],
    [owners[2], "owner-active", 1, 1, 4],
    [owners[2], "owner-erased", 2, 2, 5],
  ];
  try {
    database.exec(`
      CREATE TABLE analytics_runtime_sources(source_id TEXT PRIMARY KEY,source_namespace TEXT NOT NULL,contract_version INTEGER NOT NULL);
      CREATE TABLE analytics_source_cursors(source_id TEXT PRIMARY KEY,sequence INTEGER NOT NULL,authority_epoch INTEGER NOT NULL);
      CREATE TABLE analytics_owner_state(source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,revision INTEGER NOT NULL,
        authority_epoch INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(source_id,owner_digest));
      CREATE TABLE analytics_applied_events(source_id TEXT NOT NULL,sequence INTEGER NOT NULL,event_digest TEXT NOT NULL,
        owner_digest TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,object_digest TEXT NOT NULL,
        content_digest TEXT NOT NULL,authority_epoch INTEGER NOT NULL,public_authority_epoch INTEGER NOT NULL,
        recorded_ms INTEGER NOT NULL,PRIMARY KEY(source_id,sequence),UNIQUE(source_id,event_digest));`);
    database.prepare("INSERT INTO analytics_runtime_sources VALUES(?,?,1)").run(sourceId, namespace);
    database.prepare("INSERT INTO analytics_source_cursors VALUES(?,?,?)").run(sourceId, 6n, 5n);
    const insertOwner = database.prepare("INSERT INTO analytics_owner_state VALUES(?,?,?,?,?)");
    for (const owner of owners) {
      insertOwner.run(sourceId, owner.digest, BigInt(owner.revision), BigInt(owner.authorityEpoch), owner.state);
    }
    const insertEvent = database.prepare("INSERT INTO analytics_applied_events VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    events.forEach(([owner, kind, revision, authorityEpoch, publicAuthorityEpoch], index) => {
      const sequence = index + 1;
      insertEvent.run(sourceId, BigInt(sequence), eventDigest(sequence, 1), owner.digest, BigInt(revision), kind,
        eventDigest(sequence, 2), eventDigest(sequence, 3), BigInt(authorityEpoch), BigInt(publicAuthorityEpoch),
        BigInt(1_790_000_000_000 + sequence));
    });
  } finally {
    database.close();
  }
  await chmod(path, 0o400);
  const expectedSha256 = createHash("sha256").update(await readFile(path)).digest("hex");
  const source = await createSealedSqliteAnalyticsHistorySource({ path: await realpath(path), expectedSha256 });

  const journalPath = join(await realpath(directory), "ingestion-journal.sqlite");
  const journalDatabase = new DatabaseSync(journalPath);
  try {
    journalDatabase.exec(`
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
    journalDatabase.prepare("INSERT INTO storage_source_state(singleton,source_id,authority_epoch) VALUES(1,?,5)")
      .run(sourceId);
    const insert = journalDatabase.prepare(`INSERT INTO storage_ingestion_changes(
      sequence,event_digest,owner_digest,revision,kind,object_digest,content_digest,
      authority_epoch,public_authority_epoch,recorded_ms) VALUES(?,?,?,?,?,?,?,?,?,?)`);
    events.forEach(([owner, kind, revision, authorityEpoch, publicAuthorityEpoch], index) => {
      const sequence = index + 1;
      insert.run(sequence, eventDigest(sequence, 1), owner.digest, revision, kind, eventDigest(sequence, 2),
        journalContentOverride === sequence ? eventDigest(sequence, 9) : eventDigest(sequence, 3),
        authorityEpoch, publicAuthorityEpoch, 1_790_000_000_000 + sequence);
    });
  } finally { journalDatabase.close(); }
  await chmod(journalPath, 0o400);
  const expectedJournalSha256 = createHash("sha256").update(await readFile(journalPath)).digest("hex");
  const journalSource = await createSealedSqliteIngestionJournalSource({ path: await realpath(journalPath),
    expectedSha256: expectedJournalSha256, expectedSourceId: sourceId });
  return { directory, source, journalSource };
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

test("PG17 stages only exact analytics state/cursors behind contained controls", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const socket = await localSocket();
  const pool = new pg.Pool({ ...socket, user: PG_TEST_USER, password: PG_TEST_PASSWORD,
    database: PG_TEST_DATABASE, ssl: false, max: 4, connectionTimeoutMillis: 5_000 });
  const schema = `analytics_history_transfer_target_${randomBytes(6).toString("hex")}`;
  let schemaCreated = false;
  let fixture;
  try {
    const locality = await pool.query("SELECT inet_server_addr() AS address,current_setting('server_version_num') AS version");
    assert.equal(locality.rows[0]?.address, null, "test database must use the local Unix socket");
    assert.match(locality.rows[0]?.version ?? "", /^17\d+$/u, "test must run on PostgreSQL 17");
    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const applied = await applyPostgresMigrations({ role: "primary", schema, pool });
    assert.equal(applied.applied, applied.migrations.length);
    const table = name => `"${schema}"."${name}"`;
    const controls = async () => (await pool.query(`SELECT control_state,enrollment_enabled,
      upload_registration_enabled,processing_enabled,publication_enabled
      FROM ${table("collection_controls")} WHERE singleton=1`)).rows[0];
    assert.deepEqual(await controls(), {
      control_state: "contained", enrollment_enabled: false, upload_registration_enabled: false,
      processing_enabled: false, publication_enabled: false,
    });
    fixture = await makeSealedSource();

    await pool.query(`UPDATE ${table("collection_controls")} SET control_state='operational',
      processing_enabled=true,publication_enabled=true WHERE singleton=1`);
    await assert.rejects(transferPostgresAnalyticsHistoryState({ source: fixture.source,
      destinationPool: pool, targetSchema: schema, pageSize: 1 }),
    error => error?.code === "ANALYTICS_HISTORY_TARGET_NOT_CONTAINED");
    const refusedRows = await pool.query(`SELECT
      (SELECT count(*)::int FROM ${table("analytics_owner_state")}) AS owners,
      (SELECT count(*)::int FROM ${table("analytics_source_cursors")}) AS cursors`);
    assert.deepEqual(refusedRows.rows[0], { owners: 0, cursors: 0 });
    await pool.query(`UPDATE ${table("collection_controls")} SET control_state='contained',
      processing_enabled=false,publication_enabled=false WHERE singleton=1`);

    const blockedDigest = "c".repeat(64);
    await pool.query(`ALTER TABLE ${table("analytics_owner_state")}
      ADD CONSTRAINT synthetic_interruption CHECK(owner_digest <> '${blockedDigest}')`);
    await assert.rejects(transferPostgresAnalyticsHistoryState({ source: fixture.source,
      destinationPool: pool, targetSchema: schema, pageSize: 1 }),
    error => error?.code === "ANALYTICS_HISTORY_PAGE_COMMIT_FAILED");
    const interrupted = await pool.query(`SELECT count(*)::int AS owners FROM ${table("analytics_owner_state")}`);
    assert.equal(interrupted.rows[0]?.owners, 2, "earlier owner-state pages remain committed for idempotent resume");
    const cursorBeforeResume = await pool.query(`SELECT count(*)::int AS cursors FROM ${table("analytics_source_cursors")}`);
    assert.equal(cursorBeforeResume.rows[0]?.cursors, 0, "cursor copy starts only after the owner state pages");
    await pool.query(`ALTER TABLE ${table("analytics_owner_state")} DROP CONSTRAINT synthetic_interruption`);

    const result = await transferPostgresAnalyticsHistoryState({ source: fixture.source,
      destinationPool: pool, targetSchema: schema, pageSize: 1 });
    assert.equal(result.status, "partial_analytics_state_cursor_stage_complete");
    assert.equal(result.fullAnalyticsTransfer, false);
    assert.equal(result.limitations.appliedEventJournalTransferred, false);
    assert.equal(result.limitations.historicalPublicationRowsTransferred, false);
    assert.equal(result.limitations.analyticsContinuityQualified, false);
    assert.equal(result.limitations.readerEnabled, false);
    assert.equal(result.limitations.publicationEnabled, false);
    assert.equal(result.limitations.productionCutoverAuthorized, false);
    assert.equal(result.tables.analytics_owner_state.sourceRows, "3");
    assert.equal(result.tables.analytics_owner_state.sourceRows, result.tables.analytics_owner_state.targetRows);
    assert.equal(result.tables.analytics_owner_state.sourceSha256, result.tables.analytics_owner_state.targetSha256);
    assert.equal(result.tables.analytics_source_cursors.sourceRows, "1");
    assert.equal(result.tables.analytics_source_cursors.sourceRows, result.tables.analytics_source_cursors.targetRows);
    assert.equal(result.tables.analytics_source_cursors.sourceSha256, result.tables.analytics_source_cursors.targetSha256);
    assert.equal((await controls()).publication_enabled, false);

    const stateRows = await pool.query(`SELECT owner_digest,revision::text,authority_epoch::text,state
      FROM ${table("analytics_owner_state")} ORDER BY owner_digest COLLATE "C"`);
    assert.deepEqual(stateRows.rows.map(row => [row.owner_digest, row.revision, row.authority_epoch, row.state]), [
      ["a".repeat(64), "2", "1", "active"],
      ["b".repeat(64), "2", "2", "withdrawn"],
      ["c".repeat(64), "2", "2", "erased"],
    ]);
    const cursor = await pool.query(`SELECT source_id,sequence::text,authority_epoch::text
      FROM ${table("analytics_source_cursors")}`);
    assert.deepEqual(cursor.rows, [{ source_id: "synthetic-analytics-source", sequence: "6", authority_epoch: "5" }]);
    const omitted = await pool.query(`SELECT
      (SELECT count(*)::int FROM ${table("analytics_applied_events")}) AS events,
      (SELECT count(*)::int FROM ${table("analytics_owner_results")}) AS results,
      (SELECT count(*)::int FROM ${table("analytics_publications")}) AS publications,
      (SELECT count(*)::int FROM ${table("analytics_publication_owner_members")}) AS members`);
    assert.deepEqual(omitted.rows[0], { events: 0, results: 0, publications: 0, members: 0 });

    await pool.query(`UPDATE ${table("analytics_owner_state")} SET revision=3
      WHERE owner_digest=$1`, ["a".repeat(64)]);
    await assert.rejects(transferPostgresAnalyticsHistoryState({ source: fixture.source,
      destinationPool: pool, targetSchema: schema, pageSize: 2 }),
    error => error?.code === "ANALYTICS_HISTORY_DESTINATION_ROW_MISMATCH");
  } finally {
    fixture?.source.close();
    fixture?.journalSource.close();
    if (fixture) await rm(fixture.directory, { recursive: true, force: true });
    if (schemaCreated) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
  }
});

test("PG17 combined sealed analytics bootstrap resumes both event and owner-state pages with exact pins", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const socket = await localSocket();
  const pool = new pg.Pool({ ...socket, user: PG_TEST_USER, password: PG_TEST_PASSWORD,
    database: PG_TEST_DATABASE, ssl: false, max: 3, connectionTimeoutMillis: 5_000,
    application_name: "pg-analytics-history-bootstrap-test" });
  const schema = `storage_journal_transfer_target_${randomBytes(6).toString("hex")}`;
  const quoted = `"${schema}"`;
  const table = name => `${quoted}."${name}"`;
  let fixture;
  let schemaCreated = false;
  try {
    const locality = await pool.query("SELECT inet_server_addr() AS address,current_setting('server_version_num') AS version");
    assert.equal(locality.rows[0]?.address, null, "test database must use the local Unix socket");
    assert.match(locality.rows[0]?.version ?? "", /^17\d+$/u, "test must run on PostgreSQL 17");
    await pool.query(`CREATE SCHEMA ${quoted}`);
    schemaCreated = true;
    const migration = await applyPostgresMigrations({ role: "primary", schema, pool });
    assert.equal(migration.applied, migration.migrations.length);
    fixture = await makeSealedSource();
    const bootstrap = () => transferPostgresAnalyticsHistoryBootstrap({ source: fixture.source,
      journalSource: fixture.journalSource, destinationPool: pool, targetSchema: schema,
      transferId: "synthetic-analytics-applied-main-history-bootstrap",
      journalTransferId: "synthetic-ingestion-journal-history-bootstrap", pageSize: 1 });

    await pool.query(`ALTER TABLE ${table("analytics_applied_events")}
      ADD CONSTRAINT synthetic_bootstrap_event_interrupt CHECK(sequence < 3)`);
    await assert.rejects(bootstrap(), error => error?.code === "ANALYTICS_APPLIED_MAIN_PAGE_COMMIT_FAILED");
    const interruptedEvents = await pool.query(`SELECT
      (SELECT count(*)::int FROM ${table("storage_ingestion_changes")}) AS journal_rows,
      (SELECT count(*)::int FROM ${table("analytics_applied_events")}) AS event_rows,
      (SELECT count(*)::int FROM ${table("analytics_owner_state")}) AS owner_rows,
      (SELECT count(*)::int FROM ${table("analytics_source_cursors")}) AS cursor_rows`);
    assert.deepEqual(interruptedEvents.rows[0], { journal_rows: 6, event_rows: 2, owner_rows: 0, cursor_rows: 0 });

    await pool.query(`ALTER TABLE ${table("analytics_applied_events")}
      DROP CONSTRAINT synthetic_bootstrap_event_interrupt`);
    await pool.query(`ALTER TABLE ${table("analytics_owner_state")}
      ADD CONSTRAINT synthetic_bootstrap_owner_interrupt CHECK(owner_digest <> '${"c".repeat(64)}')`);
    await assert.rejects(bootstrap(), error => error?.code === "ANALYTICS_HISTORY_PAGE_COMMIT_FAILED");
    const interruptedOwners = await pool.query(`SELECT
      (SELECT count(*)::int FROM ${table("storage_ingestion_changes")}) AS journal_rows,
      (SELECT count(*)::int FROM ${table("analytics_applied_events")}) AS event_rows,
      (SELECT count(*)::int FROM ${table("analytics_owner_state")}) AS owner_rows,
      (SELECT count(*)::int FROM ${table("analytics_source_cursors")}) AS cursor_rows,
      (SELECT status FROM ${table("_synthetic_analytics_applied_main_transfer_runs_v1")}
        WHERE transfer_id='synthetic-analytics-applied-main-history-bootstrap') AS applied_status`);
    assert.deepEqual(interruptedOwners.rows[0], {
      journal_rows: 6, event_rows: 6, owner_rows: 2, cursor_rows: 0, applied_status: "complete",
    });

    await pool.query(`ALTER TABLE ${table("analytics_owner_state")}
      DROP CONSTRAINT synthetic_bootstrap_owner_interrupt`);
    const result = await bootstrap();
    assert.equal(result.schema, "sealed-analytics-owner-state-and-applied-events-bootstrap-v1");
    assert.equal(result.status, "partial_analytics_bootstrap_complete");
    assert.equal(result.eventRows, "6");
    assert.equal(result.journalRows, "6");
    assert.equal(result.eventRowsSha256, result.journalRowsSha256);
    assert.equal(result.sourceNamespaceSha256.length, 64);
    assert.equal(result.resumed, true);
    assert.equal(result.fullAnalyticsTransfer, false);
    assert.equal(result.analyticsContinuityQualified, false);
    assert.equal(result.readerEnabled, false);
    assert.equal(result.publicationEnabled, false);
    assert.equal(result.productionCutoverAuthorized, false);
    assert.equal(result.limitations.appliedEventJournalTransferred, true);
    assert.equal(result.tables.analytics_owner_state.sourceRows, "3");
    assert.equal(result.tables.analytics_source_cursors.sourceRows, "1");

    const replay = await bootstrap();
    assert.equal(replay.status, "partial_analytics_bootstrap_complete");
    assert.equal(replay.rowsInserted, "0");
    assert.equal(replay.eventRowsSha256, result.eventRowsSha256);
    assert.equal(replay.tables.analytics_owner_state.targetSha256,
      replay.tables.analytics_owner_state.sourceSha256);

    const mismatchedJournal = await makeSealedSource({ journalContentOverride: 3 });
    try {
      await assert.rejects(transferPostgresAnalyticsHistoryBootstrap({ source: fixture.source,
        journalSource: mismatchedJournal.journalSource, destinationPool: pool, targetSchema: schema,
        transferId: "synthetic-analytics-applied-main-history-bootstrap",
        journalTransferId: "synthetic-ingestion-journal-history-bootstrap", pageSize: 1 }),
      error => error?.code === "ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED");
    } finally {
      mismatchedJournal.source.close();
      mismatchedJournal.journalSource.close();
      await rm(mismatchedJournal.directory, { recursive: true, force: true });
    }

    const changedNamespace = await makeSealedSource({ namespace: "synthetic-analytics-namespace-changed" });
    try {
      await assert.rejects(transferPostgresAnalyticsHistoryBootstrap({ source: changedNamespace.source,
        journalSource: fixture.journalSource, destinationPool: pool, targetSchema: schema,
        transferId: "synthetic-analytics-applied-main-history-bootstrap",
        journalTransferId: "synthetic-ingestion-journal-history-bootstrap", pageSize: 1 }),
      error => error?.code === "ANALYTICS_HISTORY_APPLIED_EVENT_TRANSFER_NOT_QUALIFIED");
    } finally {
      changedNamespace.source.close();
      changedNamespace.journalSource.close();
      await rm(changedNamespace.directory, { recursive: true, force: true });
    }

    await pool.query(`UPDATE ${table("analytics_owner_state")} SET revision=3 WHERE owner_digest=$1`, ["a".repeat(64)]);
    await assert.rejects(bootstrap(), error => error?.code === "ANALYTICS_HISTORY_DESTINATION_ROW_MISMATCH");
    const counts = await pool.query(`SELECT
      (SELECT count(*)::int FROM ${table("storage_ingestion_changes")}) AS journal_rows,
      (SELECT count(*)::int FROM ${table("analytics_applied_events")}) AS event_rows,
      (SELECT count(*)::int FROM ${table("analytics_owner_state")}) AS owner_rows,
      (SELECT count(*)::int FROM ${table("analytics_source_cursors")}) AS cursor_rows`);
    assert.deepEqual(counts.rows[0], { journal_rows: 6, event_rows: 6, owner_rows: 3, cursor_rows: 1 },
      "a foreign state row must be rejected before further writes");
  } finally {
    fixture?.source.close();
    fixture?.journalSource.close();
    if (fixture) await rm(fixture.directory, { recursive: true, force: true });
    if (schemaCreated) await pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => {});
    await pool.end();
  }
}, 120_000);
