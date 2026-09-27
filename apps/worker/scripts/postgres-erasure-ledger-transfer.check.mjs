import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  createSealedSqliteErasureLedgerSource,
  POSTGRES_ERASURE_LEDGER_GCP_TEST_TARGET,
  POSTGRES_ERASURE_LEDGER_SOURCE_COLUMNS,
  runPostgresErasureLedgerTransfer,
} from "./postgres-erasure-ledger-transfer.mjs";

const WORKER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = [
  "0001_deletion_tombstones.sql",
  "0002_identity_reenrollment_cooldown.sql",
  "0003_storage_erasure_jobs.sql",
];

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
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-erasure-ledger-source-"));
  const path = join(await realpath(directory), "erasure-ledger.sqlite");
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys=ON");
    for (const migration of MIGRATIONS) {
      database.exec(await readFile(join(WORKER_ROOT, "deletion-ledger-migrations", migration), "utf8"));
    }
    const tombstones = [
      ["1".repeat(64), "2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"],
      ["2".repeat(64), "2026-08-02T00:00:00.000Z", "2026-09-02T00:00:00.000Z"],
    ];
    const insertTombstone = database.prepare(`INSERT INTO deletion_tombstones
      (participant_digest,schema_version,deleted_at,retain_until)
      VALUES(?,'participant-deletion-tombstone-v0.1',?,?)`);
    for (const row of tombstones) insertTombstone.run(...row);
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

test("sealed D1 ledger pages preserve all three ledgers and retry-job proof", async () => {
  const fixture = await makeSealedSource();
  let source;
  try {
    source = await createSealedSqliteErasureLedgerSource(fixture);
    assert.equal(source.snapshot.kind, "sealed-d1-erasure-ledger-export");
    assert.equal(source.snapshot.artifactSha256, fixture.expectedSha256);

    const first = await source.listPage({ table: "deletion_tombstones", after: null, limit: 1 });
    const second = await source.listPage({ table: "deletion_tombstones", after: [first.rows[0].participant_digest], limit: 1 });
    assert.deepEqual(first.rows.map(row => row.participant_digest), ["1".repeat(64)]);
    assert.deepEqual(second.rows.map(row => row.participant_digest), ["2".repeat(64)]);
    assert.deepEqual((await source.listPage({ table: "deletion_tombstones", after: [second.rows[0].participant_digest], limit: 1 })).rows, []);
    const jobs = await source.listPage({ table: "storage_erasure_jobs", after: null, limit: 1 });
    assert.equal(jobs.rows[0].state, "pending");
    assert.ok(jobs.rows[0].terminal_json, "a retried pending job may retain its immutable terminal proof");
    assert.equal(jobs.rows[0].attempted_ms, "12");
    assert.equal(POSTGRES_ERASURE_LEDGER_SOURCE_COLUMNS.storage_erasure_jobs.includes("owner_digest"), true);
    assert.equal((await source.verifySnapshot()).artifactSha256, fixture.expectedSha256);
  } finally {
    source?.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("sealed source refuses invalid historical job scope and a changed artifact hash", async () => {
  const invalid = await makeSealedSource({ invalidSourceId: true });
  try {
    await assert.rejects(createSealedSqliteErasureLedgerSource(invalid), {
      code: "ERASURE_LEDGER_SOURCE_ROW_INVALID",
    });
  } finally {
    await rm(invalid.directory, { recursive: true, force: true });
  }

  const fixture = await makeSealedSource();
  try {
    await assert.rejects(createSealedSqliteErasureLedgerSource({
      ...fixture, expectedSha256: "f".repeat(64),
    }), { code: "ERASURE_LEDGER_SQLITE_SHA256_MISMATCH" });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("transfer entrypoint rejects caller-built sources, broad schemas, and unbounded pages", async () => {
  const source = {
    snapshot: { kind: "sealed-d1-erasure-ledger-export", immutable: true,
      artifactSha256: "a".repeat(64), snapshotId: `sha256:${"a".repeat(64)}` },
    async verifySnapshot() { return this.snapshot; },
    async listPage() { return { rows: [] }; },
  };
  await assert.rejects(runPostgresErasureLedgerTransfer({
    source, destinationPool: {}, targetSchema: "public", transferId: "synthetic-run",
  }), { code: "ERASURE_LEDGER_TARGET_SCHEMA_REQUIRED" });
  await assert.rejects(runPostgresErasureLedgerTransfer({
    source: {}, destinationPool: {}, targetSchema: "erasure_ledger_transfer_target_synthetic",
    transferId: "synthetic-run", pageSize: 201,
  }), { code: "ERASURE_LEDGER_PAGE_SIZE_INVALID" });
  await assert.rejects(runPostgresErasureLedgerTransfer({
    source, destinationPool: {}, targetSchema: "erasure_ledger_transfer_target_synthetic",
    transferId: "synthetic-run",
  }), { code: "ERASURE_LEDGER_SEALED_SOURCE_REQUIRED" });
});

test("named test target is refused by the disposable importer before PostgreSQL access", async () => {
  let targetCalls = 0;
  const destinationPool = {
    async query() { targetCalls += 1; throw new Error("unexpected target query"); },
    async connect() { targetCalls += 1; throw new Error("unexpected target connection"); },
  };
  assert.equal(POSTGRES_ERASURE_LEDGER_GCP_TEST_TARGET.mode, "gcp_named_test");
  await assert.rejects(runPostgresErasureLedgerTransfer({
    source: {},
    destinationPool,
    targetSchema: POSTGRES_ERASURE_LEDGER_GCP_TEST_TARGET.schema,
    transferId: "production-ledger-attempt",
  }), { code: "ERASURE_LEDGER_TARGET_SCHEMA_REQUIRED" });
  assert.equal(targetCalls, 0, "the named GCP test target cannot be reached through the disposable entrypoint");
});
