import test from "node:test";
import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  readCodexLocalRepositoryOrigins,
  readCodexLocalThreadAncestry,
  readCodexLocalThreadMetadata,
} from "../src/platform/index.js";
import { localCodexLogScanner } from "../src/local-node-runtime.js";
import { readCodexSelectedRolloutNames } from "../src/platform/local-codex-thread-store.js";
import { createWindowsSyntheticOwnedSource } from "../scripts/lib/windows-synthetic-source-owner.mjs";

const NATIVE_SKIP = process.platform === "darwin"
  || (process.platform === "win32" && process.arch === "x64")
  ? false : "native macOS or Windows x64 only";
const ROOT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const ORIGIN = "https://example.test/synthetic/project";

// Both hosts exercise their production filesystem adapter. Portable fake-binding
// tests complement this contract; they do not qualify the Windows kernel.
async function ownedSource(file, contents) {
  if (process.platform === "win32") createWindowsSyntheticOwnedSource(file, contents);
  else await writeFile(file, contents, { mode: 0o600, flag: "wx" });
}

function named(id, name, updatedAt = "2026-09-22T00:00:00Z") {
  return JSON.stringify({ id, thread_name: name, updated_at: updatedAt });
}

async function fixture(t, { wal = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-work-metadata-"));
  const home = join(directory, "Codex metadata Ω");
  await mkdir(home, { mode: 0o700 });
  const file = join(home, "state_5.sqlite");
  // Elevated runners can default to a group owner. Only these disposable
  // fixture files are created with the current-user token owner.
  await ownedSource(file, "");
  const database = new DatabaseSync(file);
  t.after(async () => {
    if (database.isOpen) database.close();
    await rm(directory, { recursive: true, force: true });
  });
  database.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, title TEXT, source TEXT, cwd TEXT, git_origin_url TEXT, name TEXT, thread_source TEXT, rollout_path TEXT)");
  if (wal) {
    await ownedSource(`${file}-wal`, "");
    await ownedSource(`${file}-shm`, "");
    assert.equal(database.prepare("PRAGMA journal_mode=WAL").get().journal_mode, "wal");
  }
  const cwd = join(directory, "vanished project");
  const insert = database.prepare("INSERT INTO threads(id, title, source, cwd, git_origin_url) VALUES (?, ?, ?, ?, ?)");
  insert.run(ROOT, "Synthetic parent title", '"cli"', cwd, ORIGIN);
  insert.run(CHILD, "Synthetic child title", JSON.stringify({
    subagent: { thread_spawn: { parent_thread_id: ROOT, agent_nickname: "Synthetic worker" } },
  }), cwd, ORIGIN);
  return { home, file, database, cwd };
}

test("native platform metadata reads ordinary owned files, title opt-in and explicit ancestry", { skip: NATIVE_SKIP }, async t => {
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
  await ownedSource(join(home, "session_index.jsonl"), `${JSON.stringify({
    id: CHILD, thread_name: "Saved synthetic task", updated_at: "2026-09-22T00:00:00Z",
  })}\n`);
  const saved = await readCodexLocalThreadMetadata(home, [CHILD], { allowTitleFallback: true });
  assert.equal(saved.get(CHILD)?.name, "Saved synthetic task");
  assert.deepEqual(await readFile(file), before, "metadata reads preserve the source database");
});

test("native platform metadata sees committed WAL names and releases guards across repeated reads", { skip: NATIVE_SKIP }, async t => {
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

test("native platform metadata refuses hardlinked database and name index without leaking fallback titles", { skip: NATIVE_SKIP }, async t => {
  const { home, file, database } = await fixture(t);
  database.close();
  await link(file, join(home, "linked-state.sqlite"));
  const index = join(home, "session_index.jsonl");
  await ownedSource(index, `${JSON.stringify({
    id: ROOT, thread_name: "Rejected synthetic task", updated_at: "2026-09-22T00:00:00Z",
  })}\n`);
  await link(index, join(home, "linked-index.jsonl"));
  const result = await readCodexLocalThreadMetadata(home, [ROOT], { allowTitleFallback: true });
  assert.equal(result.get(ROOT)?.name ?? null, null);
  assert.equal((await readCodexLocalRepositoryOrigins(home)).size, 0);
});

test("native platform metadata reads checkpointed WAL databases without creating source sidecars", { skip: NATIVE_SKIP }, async t => {
  const { home, file, database } = await fixture(t, { wal: true });
  database.close();
  for (const suffix of ["-wal", "-shm"]) await assert.rejects(lstat(`${file}${suffix}`), { code: "ENOENT" });
  const before = await readFile(file);
  const result = await readCodexLocalThreadMetadata(home, [CHILD], { allowTitleFallback: true });
  assert.equal(result.get(CHILD)?.name, "Synthetic child title");
  assert.deepEqual(await readFile(file), before);
  for (const suffix of ["-wal", "-shm"]) await assert.rejects(lstat(`${file}${suffix}`), { code: "ENOENT" });
});

test("native platform names preserve precedence, timestamp ordering and live rename refresh", { skip: NATIVE_SKIP }, async t => {
  const { home, database } = await fixture(t);
  database.prepare("UPDATE threads SET name = ? WHERE id = ?").run("Explicit synthetic name", ROOT);
  database.close();
  assert.equal((await readCodexLocalThreadMetadata(home, [ROOT], { allowTitleFallback: true })).get(ROOT).name,
    "Explicit synthetic name");
  const index = join(home, "session_index.jsonl");
  await ownedSource(index, [
    named(ROOT, "Saved synthetic name", "2026-09-22T12:00:00Z"),
    named(ROOT, "Older appended name", "2026-09-22T11:00:00Z"),
    named(ROOT, "Invalid timestamp", "invalid"),
  ].join("\n") + "\n");
  assert.equal((await readCodexLocalThreadMetadata(home, [ROOT], { allowTitleFallback: true })).get(ROOT).name,
    "Saved synthetic name");
  await writeFile(index, `${named(ROOT, "Renamed synthetic task", "2026-09-22T13:00:00Z")}\n`);
  assert.equal((await readCodexLocalThreadMetadata(home, [CHILD])).get(CHILD).parent.name,
    "Renamed synthetic task", "parent navigation sees the latest saved name without restarting");
  await writeFile(index, `${named(ROOT, "Conflict one")}\n${named(ROOT, "Conflict two")}\n`);
  assert.equal((await readCodexLocalThreadMetadata(home, [ROOT], { allowTitleFallback: true })).get(ROOT).name,
    null, "conflicting saved names cannot expose either the explicit name or fallback title");
});

test("native platform title fallback is explicit and unknown or malformed metadata remains unavailable", { skip: NATIVE_SKIP }, async t => {
  const { home, database } = await fixture(t);
  database.prepare("UPDATE threads SET title = ?, source = ? WHERE id = ?")
    .run("  Synthetic\n title\t <b>literal</b>  ", JSON.stringify({ parent_thread_id: ROOT }), CHILD);
  database.close();
  const index = join(home, "session_index.jsonl");
  await ownedSource(index, [
    JSON.stringify({ id: CHILD, title: "Unknown field must not supply names", updated_at: "2026-09-22T00:00:00Z" }),
    named(CHILD, "invalid\nname"),
    "{malformed",
    named(CHILD, "Unpublished incomplete name"),
  ].join("\n"));
  const ordinary = await readCodexLocalThreadMetadata(home, [CHILD]);
  assert.deepEqual(ordinary.get(CHILD), { id: CHILD, name: null, nickname: null, parent: null });
  assert.equal((await readCodexLocalThreadMetadata(home, [CHILD], { allowTitleFallback: "true" })).get(CHILD).name, null);
  assert.equal((await readCodexLocalThreadMetadata(home, [CHILD], { forCacheDropLinks: true })).get(CHILD).name, null);
  assert.equal((await readCodexLocalThreadMetadata(home, [CHILD], { allowTitleFallback: true })).get(CHILD).name,
    "Synthetic title <b>literal</b>");
  assert.equal((await readCodexLocalThreadMetadata(home, ["invalid-thread-id"])).size, 0);
});

test("native platform nested workers and guardian navigation preserve title-free accounting", { skip: NATIVE_SKIP }, async t => {
  const { home, database } = await fixture(t);
  const grandchild = "33333333-3333-4333-8333-333333333333";
  const guardian = "44444444-4444-4444-8444-444444444444";
  const sessions = join(home, "sessions", "2026", "09", "22");
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  const rollout = join(sessions, `rollout-2026-09-22T00-00-00-${guardian}.jsonl`);
  const source = { subagent: { other: "guardian" } };
  await ownedSource(rollout, JSON.stringify({ type: "session_meta", payload: {
    id: guardian, parent_thread_id: ROOT, thread_source: "guardian_review", source,
    title: "Synthetic ignored header title",
  } }) + "\n");
  database.prepare("INSERT INTO threads(id, title, source) VALUES (?, ?, ?)")
    .run(grandchild, "Synthetic leaf title", JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: CHILD } } }));
  database.prepare("INSERT INTO threads(id, title, source, thread_source, rollout_path) VALUES (?, ?, ?, ?, ?)")
    .run(guardian, "Synthetic guardian title", JSON.stringify(source), "guardian_review", rollout);
  database.close();
  await ownedSource(join(home, "session_index.jsonl"), `${named(ROOT, "Saved parent task")}\n`);
  const before = await readFile(rollout);
  const display = await readCodexLocalThreadMetadata(home, [grandchild, guardian], { forCacheDropLinks: true });
  assert.deepEqual(display.get(grandchild), {
    id: grandchild, name: null, nickname: null, parent: { id: CHILD, name: null },
  });
  assert.deepEqual(display.get(guardian), {
    id: guardian, name: null, nickname: null, parent: { id: ROOT, name: "Saved parent task" }, origin: "auto_review",
  });
  assert.deepEqual([...await readCodexLocalThreadAncestry(home, [grandchild, guardian])],
    [[grandchild, ROOT], [guardian, guardian]]);
  assert.deepEqual(await readFile(rollout), before);
  // Accounting does not depend on the guardian's local-only navigation header.
  await rm(rollout);
  assert.deepEqual([...await readCodexLocalThreadAncestry(home, [grandchild, guardian])],
    [[grandchild, ROOT], [guardian, guardian]]);
  assert.equal((await readCodexLocalThreadMetadata(home, [guardian])).get(guardian).parent, null);
});

test("native platform repository hints preserve ambiguity and refuse invalid locations", { skip: NATIVE_SKIP }, async t => {
  const { home, database, cwd } = await fixture(t);
  database.prepare("UPDATE threads SET git_origin_url = ? WHERE id = ?")
    .run("https://example.test/other/project", CHILD);
  assert.equal((await readCodexLocalRepositoryOrigins(home)).get(cwd), null);
  database.prepare("UPDATE threads SET cwd = ?, git_origin_url = ? WHERE id = ?")
    .run("relative/project", ORIGIN, ROOT);
  database.prepare("UPDATE threads SET git_origin_url = ? WHERE id = ?")
    .run("file:///synthetic/project", CHILD);
  assert.deepEqual([...await readCodexLocalRepositoryOrigins(home)], [[cwd, null]]);
});

test("native platform selected heads resolve paginated replacement and inline child from the real thread store", { skip: NATIVE_SKIP }, async t => {
  const { home, database } = await fixture(t);
  const replacementId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const sessions = join(home, "sessions", "2026", "07", "30");
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  const originalName = `rollout-2026-07-30T10-00-00-${ROOT}.jsonl`;
  const replacementName = `rollout-2026-07-30T11-00-00-${ROOT}_${replacementId}.jsonl`;
  const childName = `rollout-2026-07-30T12-00-00-${CHILD}.jsonl`;
  const rows = [
    [originalName, { id: ROOT }],
    [replacementName, { id: ROOT, history_mode: "paginated" }],
    [childName, { id: CHILD, forked_from_id: ROOT }],
  ];
  for (const [name, payload] of rows) {
    const file = join(sessions, name);
    await ownedSource(file, JSON.stringify({ ordinal: 0, timestamp: "2026-07-30T12:00:00.000Z", type: "session_meta", payload }) + "\n");
    await utimes(file, new Date("2026-07-30T14:00:00.000Z"), new Date("2026-07-30T14:00:00.000Z"));
  }
  database.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(join(sessions, replacementName), ROOT);
  database.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(join(sessions, childName), CHILD);
  database.close();
  assert.deepEqual([...await readCodexSelectedRolloutNames(home)], [[ROOT, replacementName], [CHILD, childName]]);
  const infos = await localCodexLogScanner.discoverCodexRolloutInfos({
    codexHome: home,
    startAt: "2026-07-30T10:00:00.000Z",
    endAt: "2026-07-30T15:00:00.000Z",
  });
  assert.deepEqual(infos.map(info => info.path), rows.map(([name]) => join(sessions, name)));
  const replacement = infos.find(info => info.rolloutId === replacementId);
  assert.equal(replacement?.replacement, true);
  assert.equal(replacement?.selectedHead, true);
  assert.equal(replacement?.resolvedHead, true);
  assert.equal(replacement?.lineage.historyMode, "paginated");
  assert.equal(replacement?.lineage.historyBase, null);
  const receipt = localCodexLogScanner.codexRolloutDiscoveryReceipt(infos);
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.skippedSourceCount, 0);
  assert.deepEqual(receipt.quarantined, []);
});
