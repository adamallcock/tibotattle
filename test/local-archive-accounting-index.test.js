import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARCHIVE_INDEX_DEEP_READ_BUDGET_BYTES,
  ARCHIVE_INDEX_INITIAL_READ_BUDGET_BYTES,
  ARCHIVE_INDEX_MAX_DIRECTORY_ENTRIES,
  ARCHIVE_INDEX_MAX_ROLLOUT_FILES,
  ARCHIVE_INDEX_PASS_TIMEOUT_MS,
  ARCHIVE_INDEX_STORAGE_RESERVE_BYTES,
  inspectLocalArchiveAccountingIndex,
  refreshLocalArchiveAccountingIndex,
} from "../src/local-archive-accounting-index.js";

const CHUNK_BYTES = 4 * 1024 * 1024;
const PRIVATE_CANARY = "PRIVATE_ARCHIVE_INDEX_CANARY";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-archive-index-"));
  const codexHome = join(root, "codex-home");
  const sessions = join(codexHome, "sessions");
  await mkdir(sessions, { recursive: true });
  await mkdir(join(codexHome, "archived_sessions"), { recursive: true });
  const rollout = join(sessions, "rollout-2026-07-24T12-00-00-archive.jsonl");
  await writeFile(rollout, `${[
    JSON.stringify({
      timestamp: "2026-07-24T12:00:00.000Z",
      type: "session_meta",
      payload: { id: PRIVATE_CANARY },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:00:00.010Z",
      type: "turn_context",
      payload: { model: "gpt-5.6-sol" },
    }),
  ].join("\n")}\n`);
  await appendFile(rollout, `${JSON.stringify({
    timestamp: "2026-07-24T12:01:00.000Z",
    type: "synthetic_padding",
    payload: { padding: "x".repeat(1024) },
  })}\n`.repeat(8_000));
  return { root, codexHome };
}

test("archive index applies the larger envelope through durable partial batches", async () => {
  assert.equal(ARCHIVE_INDEX_INITIAL_READ_BUDGET_BYTES, 128 * 1024 * 1024);
  assert.equal(ARCHIVE_INDEX_DEEP_READ_BUDGET_BYTES, 1.5 * 1024 * 1024 * 1024);
  assert.equal(ARCHIVE_INDEX_MAX_DIRECTORY_ENTRIES, 500_000);
  assert.equal(ARCHIVE_INDEX_MAX_ROLLOUT_FILES, 125_000);
  assert.equal(ARCHIVE_INDEX_PASS_TIMEOUT_MS, 5 * 60_000);
  assert.equal(ARCHIVE_INDEX_STORAGE_RESERVE_BYTES, 128 * 1024 * 1024);

  const { root, codexHome } = await fixture();
  const indexFile = join(root, "local-archive-accounting-index-v1.sqlite");
  const secretFile = join(root, "local-archive-accounting-index-secret-v1");
  try {
    const initial = await refreshLocalArchiveAccountingIndex({
      indexFile,
      secretFile,
      codexHome,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
      initialReadBudgetBytes: CHUNK_BYTES,
      deepReadBudgetBytes: 16 * 1024 * 1024,
      maximumDirectoryEntries: 500,
      maximumRolloutFiles: 100,
      workerCount: 1,
      chunkBytes: CHUNK_BYTES,
    });
    assert.equal(initial.status, "partial");
    assert.equal(initial.phase, "awaiting_resume");
    assert.equal(initial.readBudgetBytes, CHUNK_BYTES);
    assert.equal(initial.scanBytes, CHUNK_BYTES);
    const inspectedPartial = await inspectLocalArchiveAccountingIndex({
      indexFile,
    });
    assert.equal(inspectedPartial.status, "partial");
    assert.equal(inspectedPartial.phase, "idle");
    assert.equal(inspectedPartial.sourceCount, initial.sourceCount);
    assert.equal(inspectedPartial.indexedBytes, initial.indexedBytes);
    assert.equal(inspectedPartial.sourceBytes, initial.sourceBytes);

    const resumed = await refreshLocalArchiveAccountingIndex({
      indexFile,
      secretFile,
      codexHome,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
      initialReadBudgetBytes: CHUNK_BYTES,
      deepReadBudgetBytes: 16 * 1024 * 1024,
      maximumDirectoryEntries: 500,
      maximumRolloutFiles: 100,
      workerCount: 1,
      chunkBytes: CHUNK_BYTES,
    });
    assert.equal(resumed.status, "complete");
    assert.equal(resumed.phase, "complete");
    assert.equal(resumed.readBudgetBytes, 16 * 1024 * 1024);
    assert.equal(resumed.indexedSourceCount, 1);
    assert.equal(resumed.pendingSourceCount, 0);
    assert.equal(resumed.indexedBytes, resumed.sourceBytes);

    let filesystemStatCalls = 0;
    const reused = await refreshLocalArchiveAccountingIndex({
      indexFile,
      secretFile,
      codexHome,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
      initialReadBudgetBytes: CHUNK_BYTES,
      deepReadBudgetBytes: 16 * 1024 * 1024,
      maximumDirectoryEntries: 500,
      maximumRolloutFiles: 100,
      workerCount: 1,
      chunkBytes: CHUNK_BYTES,
      filesystemStats: async () => {
        filesystemStatCalls += 1;
        return { bsize: 4096, bavail: 1 };
      },
    });
    assert.equal(reused.status, "complete");
    assert.equal(reused.refreshStatus, "reused");
    assert.equal(filesystemStatCalls, 0);

    const bytes = await readFile(indexFile);
    assert.equal(bytes.includes(Buffer.from(PRIVATE_CANARY)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("first-pass discovery caps persist a partial archive state", async () => {
  const { root, codexHome } = await fixture();
  const indexFile = join(root, "local-archive-accounting-index-v1.sqlite");
  const secretFile = join(root, "local-archive-accounting-index-secret-v1");
  const observedAt = "2026-07-25T12:00:00.000Z";
  try {
    await writeFile(
      join(codexHome, "sessions", "rollout-2026-07-24T12-01-00-second.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "SECOND" } })}\n`,
    );
    const paused = await refreshLocalArchiveAccountingIndex({
      indexFile,
      secretFile,
      codexHome,
      now: () => Date.parse(observedAt),
      maximumDirectoryEntries: 500,
      maximumRolloutFiles: 1,
      workerCount: 1,
    });
    assert.equal(paused.status, "partial");
    assert.equal(paused.phase, "awaiting_resume");
    assert.equal(paused.errorCode, "archive_rollout_files");
    assert.equal(paused.readBudgetBytes, ARCHIVE_INDEX_INITIAL_READ_BUDGET_BYTES);
    assert.equal(paused.scanBytes, 0);
    const coverage = await inspectLocalArchiveAccountingIndex({ indexFile });
    assert.equal(coverage.status, "partial");
    assert.equal(coverage.phase, "idle");
    assert.equal(coverage.errorCode, "archive_rollout_files");
    assert.equal(coverage.generatedAt, observedAt);
    assert.deepEqual(coverage.coveredAt, {
      startAt: observedAt,
      endAt: observedAt,
    });
    assert.equal(coverage.sourceCount, 0);
    assert.equal(coverage.indexedSourceCount, 0);
    assert.equal(coverage.pendingSourceCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted archive refresh persists a resumable partial marker", async () => {
  const { root, codexHome } = await fixture();
  const indexFile = join(root, "local-archive-accounting-index-v1.sqlite");
  const secretFile = join(root, "local-archive-accounting-index-secret-v1");
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      refreshLocalArchiveAccountingIndex({
        indexFile,
        secretFile,
        codexHome,
        signal: controller.signal,
        now: () => Date.parse("2026-07-25T12:00:00.000Z"),
      }),
      (error) => error?.name === "AbortError",
    );
    const coverage = await inspectLocalArchiveAccountingIndex({ indexFile });
    assert.equal(coverage.status, "partial");
    assert.equal(coverage.errorCode, "archive_interrupted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive indexing pauses honestly before staging when local disk headroom is insufficient", async () => {
  const { root, codexHome } = await fixture();
  const indexFile = join(root, "local-archive-accounting-index-v1.sqlite");
  const secretFile = join(root, "local-archive-accounting-index-secret-v1");
  try {
    const paused = await refreshLocalArchiveAccountingIndex({
      indexFile,
      secretFile,
      codexHome,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
      filesystemStats: async () => ({ bsize: 4096, bavail: 1 }),
    });
    assert.equal(paused.status, "partial");
    assert.equal(paused.phase, "awaiting_resume");
    assert.equal(paused.errorCode, "archive_disk_space");
    assert.equal(paused.scanBytes, 0);
    const coverage = await inspectLocalArchiveAccountingIndex({ indexFile });
    assert.equal(coverage.status, "partial");
    assert.equal(coverage.errorCode, "archive_disk_space");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive indexing distinguishes unavailable disk measurements from low disk space", async () => {
  const { root, codexHome } = await fixture();
  const indexFile = join(root, "local-archive-accounting-index-v1.sqlite");
  const secretFile = join(root, "local-archive-accounting-index-secret-v1");
  try {
    const paused = await refreshLocalArchiveAccountingIndex({
      indexFile,
      secretFile,
      codexHome,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
      filesystemStats: async () => {
        throw new Error("test filesystem measurement failure");
      },
    });
    assert.equal(paused.status, "partial");
    assert.equal(paused.errorCode, "archive_storage_unavailable");
    assert.equal(paused.scanBytes, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
