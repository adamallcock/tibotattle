import test from "node:test";
import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  readCodexLocalRepositoryOrigins,
  readCodexLocalThreadAncestry,
  readCodexLocalThreadMetadata,
} from "../src/platform/index.js";
import { createWindowsSyntheticOwnedSource } from "../scripts/lib/windows-synthetic-source-owner.mjs";

const NATIVE_SKIP = process.platform === "win32" && process.arch === "x64"
  ? false : "native Windows x64 only";
const ROOT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const ORIGIN = "https://example.test/synthetic/project";

async function fixture(t, { wal = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-work-metadata-"));
  const home = join(directory, "Codex metadata Ω");
  await mkdir(home);
  const file = join(home, "state_5.sqlite");
  // Elevated runners can default to a group owner. Only these disposable
  // fixture files are created with the current-user token owner.
  createWindowsSyntheticOwnedSource(file, "");
  const database = new DatabaseSync(file);
  t.after(async () => {
    if (database.isOpen) database.close();
    await rm(directory, { recursive: true, force: true });
  });
  database.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, title TEXT, source TEXT, cwd TEXT, git_origin_url TEXT)");
  if (wal) {
    createWindowsSyntheticOwnedSource(`${file}-wal`, "");
    createWindowsSyntheticOwnedSource(`${file}-shm`, "");
    assert.equal(database.prepare("PRAGMA journal_mode=WAL").get().journal_mode, "wal");
  }
  const cwd = join(directory, "vanished project");
  const insert = database.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)");
  insert.run(ROOT, "Synthetic parent title", '"cli"', cwd, ORIGIN);
  insert.run(CHILD, "Synthetic child title", JSON.stringify({
    subagent: { thread_spawn: { parent_thread_id: ROOT, agent_nickname: "Synthetic worker" } },
  }), cwd, ORIGIN);
  return { home, file, database, cwd };
}

test("native Windows metadata reads ordinary owned files, title opt-in and explicit ancestry", { skip: NATIVE_SKIP }, async t => {
  const { home, file, database, cwd } = await fixture(t);
  database.close();
  const before = await readFile(file);
  const titles = await readCodexLocalThreadMetadata(home, [ROOT, CHILD], { allowTitleFallback: true });
  assert.equal(titles.get(ROOT)?.name, "Synthetic parent title");
  assert.equal(titles.get(CHILD)?.name, "Synthetic child title");
  assert.deepEqual(titles.get(CHILD)?.parent, { id: ROOT, name: "Synthetic parent title" });
  assert.equal((await readCodexLocalThreadMetadata(home, [ROOT])).get(ROOT)?.name, null);
  assert.equal((await readCodexLocalThreadAncestry(home, [CHILD])).get(CHILD), ROOT);
  assert.equal((await readCodexLocalRepositoryOrigins(home)).get(cwd), ORIGIN);
  createWindowsSyntheticOwnedSource(join(home, "session_index.jsonl"), `${JSON.stringify({
    id: CHILD, thread_name: "Saved synthetic task", updated_at: "2026-09-22T00:00:00Z",
  })}\n`);
  const saved = await readCodexLocalThreadMetadata(home, [CHILD], { allowTitleFallback: true });
  assert.equal(saved.get(CHILD)?.name, "Saved synthetic task");
  assert.deepEqual(await readFile(file), before, "metadata reads preserve the source database");
});

test("native Windows metadata sees committed WAL names and releases guards across repeated reads", { skip: NATIVE_SKIP }, async t => {
  const { home, file, database } = await fixture(t, { wal: true });
  const before = await readFile(file);
  const wal = await readFile(`${file}-wal`);
  for (let iteration = 0; iteration < 3; iteration++) {
    const result = await readCodexLocalThreadMetadata(home, [CHILD], { allowTitleFallback: true });
    assert.equal(result.get(CHILD)?.name, "Synthetic child title");
  }
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readFile(`${file}-wal`), wal);
  database.prepare("UPDATE threads SET title = ? WHERE id = ?").run("Updated synthetic title", CHILD);
  assert.equal((await readCodexLocalThreadMetadata(home, [CHILD], { allowTitleFallback: true })).get(CHILD)?.name,
    "Updated synthetic title");
});

test("native Windows metadata refuses hardlinked database and name index without leaking fallback titles", { skip: NATIVE_SKIP }, async t => {
  const { home, file, database } = await fixture(t);
  database.close();
  await link(file, join(home, "linked-state.sqlite"));
  const index = join(home, "session_index.jsonl");
  createWindowsSyntheticOwnedSource(index, `${JSON.stringify({
    id: ROOT, thread_name: "Rejected synthetic task", updated_at: "2026-09-22T00:00:00Z",
  })}\n`);
  await link(index, join(home, "linked-index.jsonl"));
  const result = await readCodexLocalThreadMetadata(home, [ROOT], { allowTitleFallback: true });
  assert.equal(result.get(ROOT)?.name ?? null, null);
  assert.equal((await readCodexLocalRepositoryOrigins(home)).size, 0);
});

test("native Windows metadata reads checkpointed WAL databases without creating source sidecars", { skip: NATIVE_SKIP }, async t => {
  const { home, file, database } = await fixture(t, { wal: true });
  database.close();
  for (const suffix of ["-wal", "-shm"]) await assert.rejects(lstat(`${file}${suffix}`), { code: "ENOENT" });
  const before = await readFile(file);
  const result = await readCodexLocalThreadMetadata(home, [CHILD], { allowTitleFallback: true });
  assert.equal(result.get(CHILD)?.name, "Synthetic child title");
  assert.deepEqual(await readFile(file), before);
  for (const suffix of ["-wal", "-shm"]) await assert.rejects(lstat(`${file}${suffix}`), { code: "ENOENT" });
});
