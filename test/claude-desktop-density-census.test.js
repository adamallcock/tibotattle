import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  measureClaudeDesktopCandidateDensity,
  readClaudeDesktopSqliteComposition,
  summarizeClaudeDesktopCandidateDensity,
} from "../src/claude-desktop-density-census.js";
import { openClaudeDesktopLedgerPrototype } from "../src/claude-desktop-ledger-prototype.js";

const SECRET = Buffer.alloc(32, 83);
const START_AT = "2026-07-24T12:00:00.000Z";
const END_AT = "2026-07-24T13:00:00.000Z";

function transcriptRow(ordinal) {
  return {
    type: "assistant",
    timestamp: new Date(Date.parse(START_AT) + ordinal * 1_000).toISOString(),
    sessionId: "synthetic-session-density-private",
    isSidechain: false,
    message: {
      id: `synthetic-message-density-${ordinal}`,
      model: "synthetic-model-density-private",
      content: [],
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 30,
        output_tokens: ordinal,
      },
    },
  };
}

async function materializeSyntheticCorpus() {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-density-census-"));
  await chmod(root, 0o700);
  const metadataDirectory = join(root, "metadata");
  const projectsDirectory = join(root, "projects");
  const projectDirectory = join(projectsDirectory, "project");
  const marker = join(root, ".last-cleanup");
  await mkdir(metadataDirectory, { mode: 0o700 });
  await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(metadataDirectory, "local_density.json"), JSON.stringify({
    sessionId: "synthetic-session-density-private",
    cliSessionId: "synthetic-cli-density-private",
  }), { mode: 0o600 });
  const transcriptPath = join(projectDirectory, "synthetic-cli-density-private.jsonl");
  await writeFile(transcriptPath, `${[1, 2, 3, 4].map((ordinal) => (
    JSON.stringify(transcriptRow(ordinal))
  )).join("\n")}\n`, { mode: 0o600 });
  await writeFile(marker, "synthetic-marker\n", { mode: 0o600 });
  return {
    root,
    metadataDirectory,
    projectsDirectory,
    marker,
    transcriptPath,
  };
}

function claudeCandidate(value) {
  return {
    provider: "anthropic_claude_code",
    logicalKey: String(value).repeat(64).slice(0, 64),
    candidateKey: String(value + 1).repeat(64).slice(0, 64),
    sourceKey: "c".repeat(64),
    sourceGeneration: 1,
    observedAtMs: 1784894400000,
    modelKey: "d".repeat(64),
    inputUncachedTokens: 10,
    inputCacheReadTokens: 20,
    inputCacheWriteTokens: 30,
    outputTextTokens: null,
    outputReasoningTokens: null,
    outputCombinedTokens: 3,
    outputKind: "provider_reported_combined",
    parserVersion: "density-test-v1",
  };
}

test("density summary exposes aggregate percentiles and no row-shaped data", () => {
  const result = summarizeClaudeDesktopCandidateDensity({
    sourceRows: [
      { sourceBytes: 100, candidateCount: 1 },
      { sourceBytes: 200, candidateCount: 2 },
      { sourceBytes: 300, candidateCount: 3 },
      { sourceBytes: 400, candidateCount: 4 },
      { sourceBytes: 500, candidateCount: 5 },
    ],
  });

  assert.equal(result.status, "complete");
  assert.equal(result.totalSourceBytes, 1_500);
  assert.equal(result.totalCandidateCount, 15);
  assert.deepEqual(result.candidateCounts, {
    sampleCount: 5,
    min: 1,
    p50: 3,
    p90: 4.6,
    p95: 4.8,
    p99: 4.96,
    max: 5,
  });
  assert.equal(result.bytesPerCandidate.aggregate, 100);
  assert.equal(result.bytesPerCandidate.perSource.p50, 100);
  assert.equal(result.includesContent, false);
  assert.equal(result.includesPaths, false);
  assert.equal(result.includesIdentifiers, false);
  assert.equal(result.includesModelStrings, false);
  assert.equal(result.writesDurableArtifacts, false);
  assert.equal(JSON.stringify(result).includes("synthetic"), false);
});

test("current-corpus census is read-only, counts only selected assistant candidates, and stays content-free", async () => {
  const value = await materializeSyntheticCorpus();
  try {
    const before = (await readdir(value.root)).sort();
    const result = await measureClaudeDesktopCandidateDensity({
      metadataDirectory: value.metadataDirectory,
      projectsDirectory: value.projectsDirectory,
      cleanupMarkerPath: value.marker,
      startAt: START_AT,
      endAt: END_AT,
      secret: SECRET,
    });
    const after = (await readdir(value.root)).sort();

    assert.deepEqual(after, before);
    assert.equal(result.status, "complete");
    assert.equal(result.sourceCount, 1);
    assert.equal(result.sourcesWithCandidates, 1);
    assert.equal(result.totalCandidateCount, 4);
    assert.equal(result.candidateCounts.max, 4);
    assert.equal(result.bytesPerCandidate.aggregate, result.totalSourceBytes / 4);
    assert.equal(result.sqlite.status, "not_requested");
    const serialized = JSON.stringify(result);
    for (const privateValue of [
      "synthetic-session-density-private",
      "synthetic-cli-density-private",
      "synthetic-message-density-",
      "synthetic-model-density-private",
      value.root,
    ]) {
      assert.equal(serialized.includes(privateValue), false, privateValue);
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("SQLite composition is read-only and folds unreviewed names into an aggregate", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-density-sqlite-"));
  await chmod(root, 0o700);
  const databasePath = join(root, "ledger.sqlite");
  try {
    const ledger = openClaudeDesktopLedgerPrototype(databasePath);
    ledger.mergeUsageCandidates([claudeCandidate(1)]);
    ledger.close();
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE \"private-model-string\" (value TEXT)");
    database.exec("INSERT INTO \"private-model-string\" VALUES ('private-content-string')");
    database.close();

    const result = readClaudeDesktopSqliteComposition(databasePath);
    assert.equal(result.status, "available");
    assert.ok(result.databaseFileBytes > 0);
    assert.ok(result.pageCount > 0);
    assert.ok(result.dbstatBytes > 0);
    assert.ok(result.components.some((row) => row.component === "usage_candidate" && row.bytes > 0));
    assert.ok(result.unreviewedComponentCount >= 1);
    assert.ok(result.unreviewedBytes > 0);
    assert.equal(JSON.stringify(result).includes("private-model-string"), false);
    assert.equal(JSON.stringify(result).includes("private-content-string"), false);
    assert.equal((await lstat(databasePath)).isFile(), true);
    assert.deepEqual((await readdir(root)).sort(), ["ledger.sqlite"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite census rejects symlinked database inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-density-symlink-"));
  await chmod(root, 0o700);
  const realPath = join(root, "real.sqlite");
  const linkPath = join(root, "link.sqlite");
  try {
    const ledger = openClaudeDesktopLedgerPrototype(realPath);
    ledger.close();
    await symlink(realPath, linkPath);
    assert.throws(
      () => readClaudeDesktopSqliteComposition(linkPath),
      (error) => error.code === "claude_desktop_density_census_sqlite_unsafe",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite composition cannot create a missing WAL shared-memory sidecar", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-density-wal-"));
  await chmod(root, 0o700);
  const databasePath = join(root, "wal.sqlite");
  let writer;
  try {
    writer = new DatabaseSync(databasePath);
    writer.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE usage_candidate(value INTEGER);
      INSERT INTO usage_candidate VALUES (1);
    `);
    await lstat(`${databasePath}-wal`);
    await rm(`${databasePath}-shm`, { force: true });
    await assert.rejects(lstat(`${databasePath}-shm`), { code: "ENOENT" });

    const result = readClaudeDesktopSqliteComposition(databasePath);
    assert.equal(result.status, "available");
    assert.equal(result.snapshotBasis, "immutable_main_database");
    assert.equal(result.includesUncheckpointedWal, false);
    assert.equal(result.sidecars.find((row) => row.component === "wal").present, true);
    await assert.rejects(lstat(`${databasePath}-shm`), { code: "ENOENT" });
  } finally {
    writer?.close();
    await rm(root, { recursive: true, force: true });
  }
});
