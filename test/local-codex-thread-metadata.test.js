import assert from "node:assert/strict";
import test from "node:test";
import {
  chmod, link, mkdtemp, readFile, rm, symlink, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readCodexLocalThreadMetadata } from "../src/platform/index.js";

const ROOT = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";
const ABSENT = "33333333-3333-4333-8333-333333333333";
const PRIVATE_PROMPT_CANARY = "prompt-content-must-not-become-a-display-title";
const SOURCE = JSON.stringify({ subagent: { thread_spawn: {
  parent_thread_id: ROOT, depth: 1, agent_path: null,
  agent_nickname: "Synthetic worker", agent_role: "worker",
} } });

function named(id, name, updatedAt = "2026-08-30T10:00:00.000Z") {
  return JSON.stringify({ id, thread_name: name, updated_at: updatedAt });
}

async function fixture(t, { explicitName = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), "local-thread-metadata-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const databaseFile = join(home, "state_5.sqlite");
  const database = new DatabaseSync(databaseFile);
  database.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, title TEXT, source TEXT, thread_source TEXT,
    agent_nickname TEXT${explicitName ? ", name TEXT" : ""}) STRICT;`);
  const insert = database.prepare(`INSERT INTO threads(
    id, title, source, thread_source, agent_nickname${explicitName ? ", name" : ""})
    VALUES (?, ?, ?, ?, ?${explicitName ? ", ?" : ""})`);
  insert.run(ROOT, PRIVATE_PROMPT_CANARY, '"cli"', "user", null,
    ...(explicitName ? ["Explicit root name"] : []));
  insert.run(WORKER, PRIVATE_PROMPT_CANARY, SOURCE, "subagent", "Ada",
    ...(explicitName ? [null] : []));
  database.close();
  await chmod(databaseFile, 0o600);
  const namesFile = join(home, "session_index.jsonl");
  await writeFile(namesFile, `${named(ROOT, "Plan synthetic app")}\n`, { mode: 0o600 });
  return { home, databaseFile, namesFile };
}

test("selected metadata resolves display names and explicit worker parents without reading prompt titles", async (t) => {
  const { home, databaseFile, namesFile } = await fixture(t);
  const before = await Promise.all([readFile(databaseFile), readFile(namesFile)]);
  const result = await readCodexLocalThreadMetadata(home, [ROOT, WORKER, ABSENT]);
  assert.deepEqual([...result.values()], [
    { id: ROOT, name: "Plan synthetic app", nickname: null, parent: null },
    { id: WORKER, name: null, nickname: "Ada", parent: { id: ROOT, name: "Plan synthetic app" } },
    { id: ABSENT, name: null, nickname: null, parent: null },
  ]);
  assert.doesNotMatch(JSON.stringify([...result]), new RegExp(PRIVATE_PROMPT_CANARY, "u"));
  assert.deepEqual(await Promise.all([readFile(databaseFile), readFile(namesFile)]), before);
});

test("the newest valid display name wins independently of physical row order", async (t) => {
  const { home, namesFile } = await fixture(t, { explicitName: true });
  await writeFile(namesFile, [
    named(ROOT, "Newest selected name", "2026-08-30T12:00:00.000Z"),
    named(ROOT, "Older appended name", "2026-08-30T11:00:00.000Z"),
    named(ROOT, "not\na valid display name", "2026-08-30T13:00:00.000Z"),
    named(ROOT, "Invalid timestamp", "not-a-time"),
    "{malformed",
  ].join("\n") + "\n");
  const result = await readCodexLocalThreadMetadata(home, [ROOT]);
  assert.equal(result.get(ROOT).name, "Newest selected name");
});

test("equally current conflicting names are unavailable, not an arbitrary winner or a prompt fallback", async (t) => {
  const { home, namesFile } = await fixture(t, { explicitName: true });
  await writeFile(namesFile, `${named(ROOT, "One")}\n${named(ROOT, "Two")}\n`);
  assert.equal((await readCodexLocalThreadMetadata(home, [ROOT])).get(ROOT).name, null);
});

test("only complete JSONL entries supply display names and unknown fields never become names", async (t) => {
  const { home, namesFile } = await fixture(t);
  await writeFile(namesFile, [
    JSON.stringify({ id: ROOT, title: PRIVATE_PROMPT_CANARY, updated_at: "2026-08-30T14:00:00.000Z" }),
    named(WORKER, "<b>Plain text worker</b>"),
    named(ROOT, "Unpublished tail", "2026-08-30T15:00:00.000Z"),
  ].join("\n"));
  const result = await readCodexLocalThreadMetadata(home, [ROOT, WORKER]);
  assert.equal(result.get(ROOT).name, null);
  assert.equal(result.get(WORKER).name, "<b>Plain text worker</b>");
});

test("an explicit threads.name may supply a fallback but threads.title never does", async (t) => {
  const { home, namesFile } = await fixture(t, { explicitName: true });
  await rm(namesFile);
  const result = await readCodexLocalThreadMetadata(home, [ROOT, WORKER]);
  assert.equal(result.get(ROOT).name, "Explicit root name");
  assert.equal(result.get(WORKER).name, null);
  assert.equal(result.get(WORKER).parent.name, "Explicit root name");
});

test("source ancestry is strict and never inferred from a nickname, fork field, or thread_source", async (t) => {
  const { home, databaseFile } = await fixture(t);
  for (const source of [
    "not-json", JSON.stringify({ parent_thread_id: ROOT }),
    JSON.stringify({ forked_from_id: ROOT }),
    JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: WORKER } } }),
    JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "not-a-uuid" } } }),
  ]) {
    const database = new DatabaseSync(databaseFile);
    database.prepare("UPDATE threads SET source = ?, thread_source = ? WHERE id = ?")
      .run(source, SOURCE, WORKER);
    database.close();
    const result = await readCodexLocalThreadMetadata(home, [WORKER]);
    assert.equal(result.get(WORKER).parent, null);
    assert.equal(result.get(WORKER).nickname, "Ada");
  }
});

test("worker metadata supports a source nickname and a missing parent's name without inventing a title", async (t) => {
  const { home, databaseFile, namesFile } = await fixture(t);
  const database = new DatabaseSync(databaseFile);
  database.prepare("UPDATE threads SET agent_nickname = NULL WHERE id = ?").run(WORKER);
  database.close();
  await rm(namesFile);
  const result = await readCodexLocalThreadMetadata(home, [WORKER]);
  assert.equal(result.get(WORKER).nickname, "Synthetic worker");
  assert.deepEqual(result.get(WORKER).parent, { id: ROOT, name: null });
});

test("unsafe metadata links and writable modes are refused independently by store", async (t) => {
  const { home, databaseFile, namesFile } = await fixture(t);
  const linkedNames = join(home, "saved-names.jsonl");
  await writeFile(linkedNames, `${named(ROOT, "Must not follow this link")}\n`, { mode: 0o600 });
  await rm(namesFile);
  await symlink(linkedNames, namesFile);
  let result = await readCodexLocalThreadMetadata(home, [WORKER]);
  assert.equal(result.get(WORKER).parent.name, null);
  assert.equal(result.get(WORKER).parent.id, ROOT);
  await rm(namesFile);
  await link(linkedNames, namesFile);
  assert.equal((await readCodexLocalThreadMetadata(home, [ROOT])).get(ROOT).name, null);
  await rm(namesFile);
  await writeFile(namesFile, `${named(ROOT, "Safe root name")}\n`, { mode: 0o600 });
  await chmod(databaseFile, 0o622);
  result = await readCodexLocalThreadMetadata(home, [WORKER, ROOT]);
  assert.equal(result.get(WORKER).parent, null);
  assert.equal(result.get(ROOT).name, "Safe root name");
});

test("bounded metadata parsing fails closed on oversized lines, names, and unselected identities", async (t) => {
  const { home, databaseFile, namesFile } = await fixture(t);
  await writeFile(namesFile, `${named(ROOT, "x".repeat(513))}\n${named(ABSENT, "Unselected")}\n`);
  let result = await readCodexLocalThreadMetadata(home, [ROOT]);
  assert.equal(result.size, 1);
  assert.equal(result.get(ROOT).name, null);
  await writeFile(namesFile, `${named(ROOT, "Before oversized line")}\n${" ".repeat(65_537)}\n`);
  result = await readCodexLocalThreadMetadata(home, [ROOT]);
  assert.equal(result.get(ROOT).name, null);
  const database = new DatabaseSync(databaseFile);
  database.prepare("UPDATE threads SET source = ?, agent_nickname = ? WHERE id = ?")
    .run(" ".repeat(4_097), "a".repeat(81), WORKER);
  database.close();
  result = await readCodexLocalThreadMetadata(home, [WORKER]);
  assert.equal(result.get(WORKER).nickname, null);
  assert.equal(result.get(WORKER).parent, null);
  assert.equal((await readCodexLocalThreadMetadata(home, Array(161).fill(ROOT))).size, 0);
  assert.equal((await readCodexLocalThreadMetadata(home, ["not-a-uuid"])).size, 0);
});

test("embedded NUL cannot bypass SQL byte bounds for any selected metadata column", async (t) => {
  const { home, databaseFile, namesFile } = await fixture(t, { explicitName: true });
  await rm(namesFile);
  const oversized = `x\u0000${"y".repeat(32 * 1024)}`;
  const database = new DatabaseSync(databaseFile);
  database.prepare("UPDATE threads SET name = ?, agent_nickname = ?, source = ? WHERE id = ?")
    .run(oversized, oversized, oversized, WORKER);
  assert.equal(database.prepare("SELECT length(name) AS length FROM threads WHERE id = ?")
    .get(WORKER).length, 1, "SQLite's text length stops at the embedded NUL");
  database.close();

  const selected = [];
  const originalPrepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, "prepare", function (sql) {
    const statement = originalPrepare.call(this, sql);
    if (!sql.endsWith("FROM threads WHERE id = ?")) return statement;
    return { get(...parameters) {
      const row = statement.get(...parameters);
      if (row !== undefined) {
        // Observe SQLite's actual output before displayName/workerMetadata can
        // discard it; checking only the final DTO would miss the allocation.
        selected.push(Object.fromEntries(["name", "agent_nickname", "source"]
          .map((column) => [column, typeof row[column] === "string"
            ? row[column].length : row[column]])));
      }
      return row;
    } };
  });
  const result = await readCodexLocalThreadMetadata(home, [WORKER]);
  assert.deepEqual(selected, [{ name: null, agent_nickname: null, source: null }]);
  assert.deepEqual(result.get(WORKER), {
    id: WORKER, name: null, nickname: null, parent: null,
  });
});

test("SQL byte bounds retain multibyte names and source metadata within character limits", async (t) => {
  const { home, databaseFile, namesFile } = await fixture(t, { explicitName: true });
  await rm(namesFile);
  const rootName = "界".repeat(512);
  const workerName = "🚀".repeat(256);
  const nickname = "名".repeat(80);
  const source = JSON.stringify({
    subagent: { thread_spawn: { parent_thread_id: ROOT, agent_nickname: nickname } },
    ignored: "界".repeat(3_000),
  });
  assert.ok(source.length < 4_096 && Buffer.byteLength(source, "utf8") > 4_096);
  const database = new DatabaseSync(databaseFile);
  database.prepare("UPDATE threads SET name = ? WHERE id = ?").run(rootName, ROOT);
  database.prepare("UPDATE threads SET name = ?, agent_nickname = ?, source = ? WHERE id = ?")
    .run(workerName, nickname, source, WORKER);
  database.close();
  const result = await readCodexLocalThreadMetadata(home, [ROOT, WORKER]);
  assert.equal(result.get(ROOT).name, rootName);
  assert.deepEqual(result.get(WORKER), {
    id: WORKER, name: workerName, nickname, parent: { id: ROOT, name: rootName },
  });
});

test("Codex-home, database, and SQLite sidecar links cannot redirect display metadata reads", async (t) => {
  const { home, databaseFile, namesFile } = await fixture(t);
  const aliasHome = join(home, "alias-home");
  await symlink(home, aliasHome);
  assert.equal((await readCodexLocalThreadMetadata(aliasHome, [ROOT])).size, 0);
  const databaseBytes = await readFile(databaseFile);
  const realDatabase = join(home, "saved-state.sqlite");
  await writeFile(realDatabase, databaseBytes, { mode: 0o600 });
  await rm(databaseFile);
  await symlink(realDatabase, databaseFile);
  let result = await readCodexLocalThreadMetadata(home, [ROOT, WORKER]);
  assert.equal(result.get(ROOT).name, "Plan synthetic app", "the independent safe name index is still usable");
  assert.equal(result.get(WORKER).parent, null);
  await rm(databaseFile);
  await writeFile(databaseFile, databaseBytes, { mode: 0o600 });
  await symlink(namesFile, `${databaseFile}-wal`);
  result = await readCodexLocalThreadMetadata(home, [WORKER]);
  assert.equal(result.get(WORKER).parent, null);
  assert.equal(result.get(WORKER).nickname, null);
  assert.deepEqual(await readFile(databaseFile), databaseBytes);
});
