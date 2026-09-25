import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createSealedSqliteAnalyticsHistorySource,
  POSTGRES_ANALYTICS_HISTORY_SOURCE_COLUMNS,
  scanSealedSqliteAnalyticsEventJournal,
  transferPostgresAnalyticsHistoryState,
} from "./postgres-analytics-history-transfer.mjs";

function eventDigest(sequence, suffix) {
  return BigInt(sequence * 10 + suffix).toString(16).padStart(64, "0");
}

function analyticsSourceFixture() {
  const directory = mkdtemp(join(tmpdir(), "tibotattle-analytics-history-source-"));
  return directory;
}

async function makeSealedSource({ cursorSequence = 6, eventOverrides = {}, missingEventColumn = null } = {}) {
  const directory = await analyticsSourceFixture();
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
  const eventColumnTypes = Object.freeze({
    source_id: "TEXT NOT NULL",
    sequence: "INTEGER NOT NULL",
    event_digest: "TEXT NOT NULL",
    owner_digest: "TEXT NOT NULL",
    revision: "INTEGER NOT NULL",
    kind: "TEXT NOT NULL",
    object_digest: "TEXT NOT NULL",
    content_digest: "TEXT NOT NULL",
    authority_epoch: "INTEGER NOT NULL",
    public_authority_epoch: "INTEGER NOT NULL",
    recorded_ms: "INTEGER NOT NULL",
  });
  const eventColumns = POSTGRES_ANALYTICS_HISTORY_SOURCE_COLUMNS.analytics_applied_events
    .filter(column => column !== missingEventColumn);
  try {
    database.exec(`
      CREATE TABLE analytics_runtime_sources(source_id TEXT PRIMARY KEY,source_namespace TEXT NOT NULL,contract_version INTEGER NOT NULL);
      CREATE TABLE analytics_source_cursors(source_id TEXT PRIMARY KEY,sequence INTEGER NOT NULL,authority_epoch INTEGER NOT NULL);
      CREATE TABLE analytics_owner_state(source_id TEXT NOT NULL,owner_digest TEXT NOT NULL,revision INTEGER NOT NULL,
        authority_epoch INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(source_id,owner_digest));
      `);
    database.exec(`CREATE TABLE analytics_applied_events(${eventColumns
      .map(column => `"${column}" ${eventColumnTypes[column]}`).join(",")},
      PRIMARY KEY(source_id,sequence),UNIQUE(source_id,event_digest));`);
    database.prepare("INSERT INTO analytics_runtime_sources VALUES(?,?,1)").run(sourceId, "synthetic-analytics-namespace");
    database.prepare("INSERT INTO analytics_source_cursors VALUES(?,?,?)")
      .run(sourceId, BigInt(cursorSequence), 5n);
    const insertOwner = database.prepare("INSERT INTO analytics_owner_state VALUES(?,?,?,?,?)");
    for (const owner of owners) {
      insertOwner.run(sourceId, owner.digest, BigInt(owner.revision), BigInt(owner.authorityEpoch), owner.state);
    }
    const insertEvent = database.prepare(`INSERT INTO analytics_applied_events(${eventColumns
      .map(column => `"${column}"`).join(",")}) VALUES(${eventColumns.map(() => "?").join(",")})`);
    events.forEach(([owner, kind, revision, authorityEpoch, validPublicAuthorityEpoch], index) => {
      const sequence = index + 1;
      const override = eventOverrides[sequence] ?? {};
      const values = {
        source_id: sourceId,
        sequence: BigInt(sequence),
        event_digest: override.eventDigest ?? eventDigest(sequence, 1),
        owner_digest: override.ownerDigest ?? owner.digest,
        revision: BigInt(override.revision ?? revision),
        kind: override.kind ?? kind,
        object_digest: override.objectDigest ?? eventDigest(sequence, 2),
        content_digest: override.contentDigest ?? eventDigest(sequence, 3),
        authority_epoch: BigInt(override.authorityEpoch ?? authorityEpoch),
        public_authority_epoch: BigInt(override.publicAuthorityEpoch ?? validPublicAuthorityEpoch),
        recorded_ms: BigInt(override.recordedMs ?? (1_790_000_000_000 + sequence)),
      };
      insertEvent.run(...eventColumns.map(column => values[column]));
    });
  } finally {
    database.close();
  }
  await chmod(path, 0o400);
  const expectedSha256 = createHash("sha256").update(await readFile(path)).digest("hex");
  return { directory, path: await realpath(path), expectedSha256 };
}

test("sealed analytics source exposes separate exact event pages without widening the importer subset", async () => {
  const fixture = await makeSealedSource();
  let source;
  try {
    source = await createSealedSqliteAnalyticsHistorySource(fixture);
    const first = await source.listPage({ table: "analytics_owner_state", after: null, limit: 2 });
    const second = await source.listPage({ table: "analytics_owner_state", after: {
      sourceId: first.rows.at(-1).source_id,
      ownerDigest: first.rows.at(-1).owner_digest,
    }, limit: 2 });
    assert.deepEqual(first.rows.map(row => row.owner_digest), ["a".repeat(64), "b".repeat(64)]);
    assert.deepEqual(second.rows.map(row => row.owner_digest), ["c".repeat(64)]);
    assert.deepEqual((await source.listPage({ table: "analytics_source_cursors", after: null, limit: 2 }))
      .rows.map(row => [row.sequence, row.authority_epoch]), [["6", "5"]]);
    const firstEvents = await source.listPage({ table: "analytics_applied_events", after: null, limit: 2 });
    const nextEvents = await source.listPage({ table: "analytics_applied_events", after: {
      sourceId: firstEvents.rows.at(-1).source_id,
      sequence: firstEvents.rows.at(-1).sequence,
    }, limit: 2 });
    assert.deepEqual(firstEvents.rows.map(row => row.sequence), ["1", "2"]);
    assert.deepEqual(nextEvents.rows.map(row => row.sequence), ["3", "4"]);
    assert.deepEqual({ ...firstEvents.rows[0] }, {
      source_id: "synthetic-analytics-source",
      sequence: "1",
      event_digest: eventDigest(1, 1),
      owner_digest: "a".repeat(64),
      revision: "1",
      kind: "owner-active",
      object_digest: eventDigest(1, 2),
      content_digest: eventDigest(1, 3),
      authority_epoch: "1",
      public_authority_epoch: "1",
      recorded_ms: "1790000000001",
    });
    await assert.rejects(source.listPage({ table: "analytics_owner_state", after: {
      sourceId: "bad source id", ownerDigest: "a".repeat(64),
    }, limit: 2 }), { code: "ANALYTICS_HISTORY_SOURCE_ID_INVALID" });
    await assert.rejects(source.listPage({ table: "analytics_publications", after: null, limit: 2 }), {
      code: "ANALYTICS_HISTORY_TABLE_INVALID",
    });
    assert.equal((await source.verifySnapshot()).artifactSha256, fixture.expectedSha256);
  } finally {
    source?.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("sealed event export hashes every bounded keyset page without touching a target or source cursor", async () => {
  const fixture = await makeSealedSource();
  let source;
  try {
    source = await createSealedSqliteAnalyticsHistorySource(fixture);
    const rows = [];
    let after = null;
    for (;;) {
      const page = await source.listPage({ table: "analytics_applied_events", after, limit: 2 });
      assert.ok(page.rows.length <= 2);
      rows.push(...page.rows);
      if (page.rows.length < 2) break;
      after = { sourceId: page.rows.at(-1).source_id, sequence: page.rows.at(-1).sequence };
    }
    const rowHash = createHash("sha256");
    for (const row of rows) {
      rowHash.update(`${JSON.stringify(POSTGRES_ANALYTICS_HISTORY_SOURCE_COLUMNS.analytics_applied_events
        .map(column => row[column]))}\n`);
    }
    const receipt = await scanSealedSqliteAnalyticsEventJournal({ source, pageSize: 2 });
    assert.deepEqual(receipt, {
      schema: "sealed-sqlite-analytics-events-v1",
      sourceSnapshotSha256: fixture.expectedSha256,
      eventRows: "6",
      eventRowsSha256: rowHash.digest("hex"),
      pageSize: 2,
      pagesRead: 4,
      postgresWrites: 0,
      sourceCursorAdvanced: false,
    });
    assert.deepEqual((await source.listPage({ table: "analytics_source_cursors", after: null, limit: 2 }))
      .rows.map(row => [row.sequence, row.authority_epoch]), [["6", "5"]]);
  } finally {
    source?.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("sealed event export fails closed when the source event tuple is incomplete, invalid, or changed", async () => {
  const missing = await makeSealedSource({ missingEventColumn: "content_digest" });
  try {
    await assert.rejects(createSealedSqliteAnalyticsHistorySource(missing), {
      code: "ANALYTICS_HISTORY_SQLITE_LAYOUT_INVALID",
    });
  } finally {
    await rm(missing.directory, { recursive: true, force: true });
  }

  const malformed = await makeSealedSource({ eventOverrides: { 2: { contentDigest: "bad" } } });
  try {
    await assert.rejects(createSealedSqliteAnalyticsHistorySource(malformed), {
      code: "ANALYTICS_HISTORY_SOURCE_INTEGRITY_INVALID",
    });
  } finally {
    await rm(malformed.directory, { recursive: true, force: true });
  }

  const changed = await makeSealedSource();
  let source;
  try {
    source = await createSealedSqliteAnalyticsHistorySource(changed);
    await chmod(changed.path, 0o600);
    const mutable = new DatabaseSync(changed.path);
    try {
      mutable.prepare("UPDATE analytics_applied_events SET content_digest=? WHERE source_id=? AND sequence=1")
        .run(eventDigest(1, 9), "synthetic-analytics-source");
    } finally {
      mutable.close();
      await chmod(changed.path, 0o400);
    }
    await assert.rejects(scanSealedSqliteAnalyticsEventJournal({ source, pageSize: 2 }), {
      code: "ANALYTICS_HISTORY_SOURCE_CHANGED",
    });
  } finally {
    source?.close();
    await rm(changed.directory, { recursive: true, force: true });
  }
});

test("analytics source refuses a cursor that is not backed by its event history", async () => {
  const fixture = await makeSealedSource({ cursorSequence: 7 });
  try {
    await assert.rejects(createSealedSqliteAnalyticsHistorySource(fixture), {
      code: "ANALYTICS_HISTORY_SOURCE_INTEGRITY_INVALID",
    });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("analytics source refuses a non-monotonic source authority epoch in its journal", async () => {
  const fixture = await makeSealedSource({ eventOverrides: { 3: { publicAuthorityEpoch: 1 } } });
  try {
    await assert.rejects(createSealedSqliteAnalyticsHistorySource(fixture), {
      code: "ANALYTICS_HISTORY_SOURCE_INTEGRITY_INVALID",
    });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("analytics transfer refuses unsealed sources, oversized pages, and invalid schemas", async () => {
  const unsealed = {
    snapshot: { kind: "sealed-sqlite-rehearsal", immutable: true,
      artifactSha256: "a".repeat(64), snapshotId: `sha256:${"a".repeat(64)}` },
    async verifySnapshot() { return this.snapshot; },
    async listPage() { return { rows: [] }; },
  };
  await assert.rejects(transferPostgresAnalyticsHistoryState({
    source: unsealed, destinationPool: {}, targetSchema: "analytics_history_transfer_target_synthetic",
  }), { code: "ANALYTICS_HISTORY_SEALED_SOURCE_REQUIRED" });
  await assert.rejects(transferPostgresAnalyticsHistoryState({
    source: {}, destinationPool: {}, targetSchema: "analytics_history_transfer_target_synthetic", pageSize: 201,
  }), { code: "ANALYTICS_HISTORY_PAGE_SIZE_INVALID" });
  await assert.rejects(transferPostgresAnalyticsHistoryState({
    source: {}, destinationPool: {}, targetSchema: "public",
  }), { code: "ANALYTICS_HISTORY_TARGET_SCHEMA_REQUIRED" });
});
