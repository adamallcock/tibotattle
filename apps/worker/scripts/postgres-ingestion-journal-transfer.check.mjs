import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createSealedSqliteIngestionJournalSource,
  POSTGRES_INGESTION_JOURNAL_ROW_COLUMNS,
  scanSealedSqliteIngestionJournal,
} from "./postgres-ingestion-journal-transfer.mjs";

const SOURCE_ID = "synthetic-ingestion-journal-source";

function digest(n) { return BigInt(n).toString(16).padStart(64, "0"); }

function eventRows({ gapAt = 0, badDigestAt = 0 } = {}) {
  const specs = [
    ["a", 1, "owner-active", 1, 1],
    ["a", 2, "source-updated", 1, 1],
    ["a", 3, "owner-withdrawn", 2, 2],
    ["b", 1, "owner-active", 1, 3],
    ["b", 2, "source-updated", 1, 3],
    ["b", 3, "owner-erased", 2, 4],
  ];
  return specs.map(([owner, revision, kind, authorityEpoch, publicAuthorityEpoch], index) => ({
    sequence: index + 1 + (gapAt > 0 && index >= gapAt ? 1 : 0),
    event_digest: digest(index + 1),
    owner_digest: owner.repeat(64),
    revision,
    kind,
    object_digest: digest(index + 20),
    content_digest: badDigestAt === index + 1 ? "z".repeat(64) : digest(index + 40),
    authority_epoch: authorityEpoch,
    public_authority_epoch: publicAuthorityEpoch,
    recorded_ms: 1_790_000_000_000 + index,
  }));
}

async function makeSource({ extraTable = false, gapAt = 0, badDigestAt = 0 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-ingestion-journal-source-"));
  const path = join(await realpath(directory), "journal.sqlite");
  const database = new DatabaseSync(path);
  const rows = eventRows({ gapAt, badDigestAt });
  try {
    database.exec(`
      CREATE TABLE storage_source_state(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        source_id TEXT NOT NULL UNIQUE,
        authority_epoch INTEGER NOT NULL DEFAULT 0 CHECK(authority_epoch>=0)
      ) STRICT;
      CREATE TABLE storage_ingestion_changes(
        sequence INTEGER PRIMARY KEY,
        event_digest TEXT NOT NULL UNIQUE,
        owner_digest TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>0),
        kind TEXT NOT NULL CHECK(kind IN('source-updated','owner-active','owner-withdrawn','owner-erased')),
        object_digest TEXT NOT NULL,
        content_digest TEXT NOT NULL CHECK(length(content_digest)=64),
        authority_epoch INTEGER NOT NULL CHECK(authority_epoch>0),
        public_authority_epoch INTEGER NOT NULL CHECK(public_authority_epoch>0),
        recorded_ms INTEGER NOT NULL CHECK(recorded_ms>=0),
        UNIQUE(owner_digest,revision)
      ) STRICT;
      CREATE INDEX storage_ingestion_owner_cursor ON storage_ingestion_changes(owner_digest,sequence);
    `);
    if (extraTable) database.exec("CREATE TABLE unexpected_source_data(value TEXT) STRICT");
    database.prepare("INSERT INTO storage_source_state(singleton,source_id,authority_epoch) VALUES(1,?,4)").run(SOURCE_ID);
    const insert = database.prepare(`INSERT INTO storage_ingestion_changes(
      sequence,event_digest,owner_digest,revision,kind,object_digest,content_digest,
      authority_epoch,public_authority_epoch,recorded_ms) VALUES(?,?,?,?,?,?,?,?,?,?)`);
    for (const row of rows) insert.run(row.sequence, row.event_digest, row.owner_digest, row.revision, row.kind,
      row.object_digest, row.content_digest, row.authority_epoch, row.public_authority_epoch, row.recorded_ms);
  } finally {
    database.close();
  }
  await chmod(path, 0o400);
  const expectedSha256 = createHash("sha256").update(await readFile(path)).digest("hex");
  return { directory, path: await realpath(path), expectedSha256, rows };
}

test("sealed D1 storage journal scans bounded pages with exact source identity and a content-free digest", async () => {
  const fixture = await makeSource();
  let source;
  try {
    source = await createSealedSqliteIngestionJournalSource({ ...fixture, expectedSourceId: SOURCE_ID });
    const pages = [];
    let after = null;
    for (;;) {
      const page = await source.listPage({ after, limit: 2 });
      assert.ok(page.rows.length <= 2);
      pages.push(page.rows);
      if (page.rows.length < 2) break;
      after = page.rows.at(-1).sequence;
    }
    assert.deepEqual(pages.map(page => page.map(row => row.sequence)), [["1", "2"], ["3", "4"], ["5", "6"], []]);
    const hash = createHash("sha256");
    for (const page of pages) {
      for (const row of page) hash.update(`${JSON.stringify(POSTGRES_INGESTION_JOURNAL_ROW_COLUMNS.map(column => row[column]))}\n`);
    }
    const receipt = await scanSealedSqliteIngestionJournal({ source, pageSize: 2 });
    assert.deepEqual(receipt, {
      schema: "sealed-sqlite-d1-ingestion-journal-v1",
      sourceIdSha256: createHash("sha256").update(SOURCE_ID).digest("hex"),
      sourceSnapshotSha256: fixture.expectedSha256,
      sourceAuthorityEpoch: "4",
      eventRows: "6",
      eventRowsSha256: hash.digest("hex"),
      lastSequence: "6",
      pageSize: 2,
      pagesRead: 4,
      postgresWrites: 0,
      analyticsCursorAdvanced: false,
      ownerStateWritten: false,
      appliedReceiptsWritten: false,
    });
    assert.deepEqual(Object.keys(receipt).sort(), [
      "analyticsCursorAdvanced", "appliedReceiptsWritten", "eventRows", "eventRowsSha256", "lastSequence",
      "ownerStateWritten", "pageSize", "pagesRead", "postgresWrites", "schema", "sourceAuthorityEpoch",
      "sourceIdSha256", "sourceSnapshotSha256",
    ].sort());
  } finally {
    source?.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("sealed D1 storage journal refuses an unexpected source identity, widened schema, or bad tuple", async () => {
  const fixture = await makeSource();
  try {
    await assert.rejects(createSealedSqliteIngestionJournalSource({ ...fixture,
      expectedSourceId: "different-synthetic-source" }), { code: "INGESTION_JOURNAL_SOURCE_IDENTITY_MISMATCH" });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }

  const widened = await makeSource({ extraTable: true });
  try {
    await assert.rejects(createSealedSqliteIngestionJournalSource({ ...widened,
      expectedSourceId: SOURCE_ID }), { code: "INGESTION_JOURNAL_SQLITE_LAYOUT_INVALID" });
  } finally {
    await rm(widened.directory, { recursive: true, force: true });
  }

  const gap = await makeSource({ gapAt: 3 });
  try {
    await assert.rejects(createSealedSqliteIngestionJournalSource({ ...gap,
      expectedSourceId: SOURCE_ID }), { code: "INGESTION_JOURNAL_SOURCE_INTEGRITY_INVALID" });
  } finally {
    await rm(gap.directory, { recursive: true, force: true });
  }

  const malformed = await makeSource({ badDigestAt: 2 });
  try {
    await assert.rejects(createSealedSqliteIngestionJournalSource({ ...malformed,
      expectedSourceId: SOURCE_ID }), { code: "INGESTION_JOURNAL_SOURCE_INTEGRITY_INVALID" });
  } finally {
    await rm(malformed.directory, { recursive: true, force: true });
  }
});

test("sealed D1 storage journal detects source mutation and refuses writable artifacts", async () => {
  const fixture = await makeSource();
  let source;
  try {
    source = await createSealedSqliteIngestionJournalSource({ ...fixture, expectedSourceId: SOURCE_ID });
    const bytes = await readFile(fixture.path);
    bytes[bytes.length - 1] ^= 1;
    const replacement = `${fixture.path}.replacement`;
    await writeFile(replacement, bytes, { mode: 0o600 });
    await chmod(replacement, 0o400);
    await rename(replacement, fixture.path);
    await assert.rejects(source.verifySnapshot(), { code: "INGESTION_JOURNAL_SOURCE_CHANGED" });
  } finally {
    source?.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }

  const writable = await makeSource();
  try {
    await chmod(writable.path, 0o600);
    await assert.rejects(createSealedSqliteIngestionJournalSource({ ...writable,
      expectedSourceId: SOURCE_ID }), { code: "INGESTION_JOURNAL_SQLITE_UNSAFE" });
  } finally {
    await rm(writable.directory, { recursive: true, force: true });
  }
});
