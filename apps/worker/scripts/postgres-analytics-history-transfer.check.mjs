import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createSealedSqliteAnalyticsHistorySource,
  transferPostgresAnalyticsHistoryState,
} from "./postgres-analytics-history-transfer.mjs";

function eventDigest(sequence, suffix) {
  return BigInt(sequence * 10 + suffix).toString(16).padStart(64, "0");
}

function analyticsSourceFixture() {
  const directory = mkdtemp(join(tmpdir(), "tibotattle-analytics-history-source-"));
  return directory;
}

async function makeSealedSource({ cursorSequence = 6, eventOverrides = {} } = {}) {
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
    database.prepare("INSERT INTO analytics_runtime_sources VALUES(?,?,1)").run(sourceId, "synthetic-analytics-namespace");
    database.prepare("INSERT INTO analytics_source_cursors VALUES(?,?,?)")
      .run(sourceId, BigInt(cursorSequence), 5n);
    const insertOwner = database.prepare("INSERT INTO analytics_owner_state VALUES(?,?,?,?,?)");
    for (const owner of owners) {
      insertOwner.run(sourceId, owner.digest, BigInt(owner.revision), BigInt(owner.authorityEpoch), owner.state);
    }
    const insertEvent = database.prepare(`INSERT INTO analytics_applied_events
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    events.forEach(([owner, kind, revision, authorityEpoch, validPublicAuthorityEpoch], index) => {
      const sequence = index + 1;
      const publicAuthorityEpoch = eventOverrides[sequence]?.publicAuthorityEpoch ?? validPublicAuthorityEpoch;
      const effectiveRevision = eventOverrides[sequence]?.revision ?? revision;
      const effectiveAuthorityEpoch = eventOverrides[sequence]?.authorityEpoch ?? authorityEpoch;
      insertEvent.run(sourceId, BigInt(sequence), eventDigest(sequence, 1), owner.digest, BigInt(effectiveRevision), kind,
        eventDigest(sequence, 2), eventDigest(sequence, 3), BigInt(effectiveAuthorityEpoch), BigInt(publicAuthorityEpoch),
        BigInt(1_790_000_000_000 + sequence));
    });
  } finally {
    database.close();
  }
  await chmod(path, 0o400);
  const expectedSha256 = createHash("sha256").update(await readFile(path)).digest("hex");
  return { directory, path: await realpath(path), expectedSha256 };
}

test("sealed analytics source pages only the exact owner-state and cursor subset", async () => {
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
