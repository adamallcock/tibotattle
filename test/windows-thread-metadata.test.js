import assert from "node:assert/strict";
import test from "node:test";
import { closeSync, fstatSync, openSync, readSync, writeFileSync, utimesSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readCodexSelectedRolloutNames, readCodexLocalThreadMetadata, readCodexLocalThreadAncestry,
  readCodexLocalRepositoryOrigins } from "../src/platform/local-codex-thread-store.js";

const ROOT = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";
const REVIEW = "33333333-3333-4333-8333-333333333333";
const PRIVATE = "synthetic-private-prompt-canary";

// Portable orchestration coverage only. Native owner/reparse/link and Windows
// kernel rename denial are exercised by work-usage-platform-parity.test.js.
async function fixture(t, { wal = false } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "windows-thread-metadata-")));
  const leases = new Map(), opened = [], reads = [];
  let db;
  t.after(async () => {
    // Windows refuses removal while the fixture's source handles or WAL writer
    // remain open. Keep cleanup in one hook with an explicit lifetime order.
    for (const { fd } of leases.values()) closeSync(fd);
    leases.clear();
    if (db?.isOpen) db.close();
    await rm(home, { recursive: true, force: true });
  });
  const path = join(home, "state_5.sqlite");
  db = new DatabaseSync(path);
  if (wal) db.exec("PRAGMA journal_mode=WAL");
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT,
    source TEXT, agent_nickname TEXT, thread_source TEXT, rollout_path TEXT,
    cwd TEXT, git_origin_url TEXT) STRICT`);
  const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run(ROOT, PRIVATE, "Synthetic root", null, null, "user", null, home,
    "https://github.com/example/synthetic.git");
  insert.run(WORKER, "Synthetic worker title", null,
    JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: ROOT, agent_nickname: "Ada" } } }),
    null, "subagent", null, null, null);
  const rollout = join(home, "sessions", "synthetic.jsonl");
  await mkdir(join(home, "sessions"));
  await writeFile(rollout, JSON.stringify({ type: "session_meta", payload: { id: REVIEW,
    parent_thread_id: ROOT, thread_source: "guardian_review", source: { subagent: { other: "guardian" } },
    ignored: PRIVATE } }) + "\n");
  insert.run(REVIEW, PRIVATE, null, JSON.stringify({ subagent: { other: "guardian" } }),
    null, "guardian_review", rollout, null, null);
  if (!wal) db.close();
  const index = join(home, "session_index.jsonl");
  await writeFile(index, JSON.stringify({ id: ROOT, thread_name: "Saved root name",
    updated_at: "2026-09-22T10:00:00Z" }) + "\n");
  // Deliberately unacceptable POSIX bits demonstrate that Windows never applies
  // Unix mode policy to native-authenticated inherited/default source ACLs.
  await chmod(home, 0o777); await chmod(path, 0o666); await chmod(index, 0o666);
  let refuse = null;
  const native = {
    openSourceFile(file) {
      if (refuse?.(file)) throw new Error("synthetic native security refusal");
      const lease = {}; leases.set(lease, { fd: openSync(file, "r"), file }); opened.push(file); return lease;
    },
    statSourceFile(lease) {
      const stats = fstatSync(leases.get(lease).fd);
      // Native source stats do not expose POSIX ownership or permissions.
      return { dev: String(stats.dev), ino: String(stats.ino), size: stats.size,
        nlink: 1, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
    },
    readSourceFile(lease, position, length) {
      assert.ok(length <= 65536); reads.push(length);
      const { fd } = leases.get(lease);
      const buffer = Buffer.alloc(length);
      return buffer.subarray(0, readSync(fd, buffer, 0, length, position));
    },
    closeSourceFile(lease) { closeSync(leases.get(lease).fd); leases.delete(lease); },
  };
  return { home, path, db, index, rollout, leases, opened, reads, native,
    options: { platform: "win32", loadWindowsBinding: () => native },
    refuse: value => { refuse = value; } };
}

function wrappedDatabase(factory) {
  return (path, options) => {
    assert.equal(options.readOnly, true);
    const db = new DatabaseSync(path, options);
    return factory(db);
  };
}

test("Windows source metadata preserves selected names, bounded title opt-in, ancestry and origins", async t => {
  const f = await fixture(t);
  const before = await Promise.all([readFile(f.path), readFile(f.index), readFile(f.rollout)]);
  const metadata = await readCodexLocalThreadMetadata(f.home, [ROOT, WORKER, REVIEW], f.options);
  assert.equal(metadata.get(ROOT).name, "Saved root name");
  assert.deepEqual(metadata.get(WORKER), { id: WORKER, name: null, nickname: "Ada",
    parent: { id: ROOT, name: "Saved root name" } });
  assert.deepEqual(metadata.get(REVIEW), { id: REVIEW, name: null, nickname: null,
    parent: { id: ROOT, name: "Saved root name" }, origin: "auto_review" });
  assert.doesNotMatch(JSON.stringify([...metadata]), new RegExp(PRIVATE));
  const optedIn = await readCodexLocalThreadMetadata(f.home, [WORKER], { ...f.options, allowTitleFallback: true });
  assert.equal(optedIn.get(WORKER).name, "Synthetic worker title");
  f.opened.length = 0;
  assert.deepEqual([...await readCodexLocalThreadAncestry(f.home, [WORKER, REVIEW], f.options)],
    [[WORKER, ROOT], [REVIEW, REVIEW]]);
  assert.ok(!f.opened.includes(f.index) && !f.opened.includes(f.rollout));
  assert.deepEqual([...await readCodexLocalRepositoryOrigins(f.home, f.options)],
    [[f.home, "https://github.com/example/synthetic"]]);
  assert.deepEqual(await Promise.all([readFile(f.path), readFile(f.index), readFile(f.rollout)]), before);
  assert.equal(f.leases.size, 0);
});

test("Windows live WAL main and sidecars remain leased through read-only SQLite close", async t => {
  const f = await fixture(t, { wal: true });
  const factory = wrappedDatabase(db => ({
    get isOpen() { return db.isOpen; }, exec: db.exec.bind(db), prepare: db.prepare.bind(db),
    close() {
      const held = new Set([...f.leases.values()].map(value => value.file));
      for (const file of [f.path, `${f.path}-wal`, `${f.path}-shm`]) assert.ok(held.has(file));
      db.close();
    },
  }));
  const result = await readCodexLocalThreadMetadata(f.home, [WORKER], { ...f.options, databaseFactory: factory });
  assert.equal(result.get(WORKER).parent.id, ROOT);
  assert.equal(f.leases.size, 0);
});

test("Windows closed WAL without sidecars reads committed names through immutable mode without writes", async t => {
  const f = await fixture(t, { wal: true });
  f.db.close();
  const result = await readCodexLocalThreadMetadata(f.home, [ROOT, WORKER], { ...f.options,
    allowTitleFallback: true, databaseFactory(path, options) {
      assert.match(path, /\?mode=ro&immutable=1$/u);
      return new DatabaseSync(path, options);
    } });
  assert.equal(result.get(ROOT).name, "Saved root name");
  assert.equal(result.get(WORKER).name, "Synthetic worker title");
  assert.equal(result.get(WORKER).parent.id, ROOT);
  await assert.rejects(readFile(`${f.path}-wal`), { code: "ENOENT" });
  await assert.rejects(readFile(`${f.path}-shm`), { code: "ENOENT" });
  assert.equal(f.leases.size, 0);
});

test("Windows missing binding fails closed for names and ancestry without a POSIX fallback", async t => {
  const f = await fixture(t);
  const options = { platform: "win32", loadWindowsBinding() { throw new Error("binding unavailable"); } };
  const result = await readCodexLocalThreadMetadata(f.home, [ROOT], options);
  assert.equal(result.get(ROOT).name, null);
  assert.equal((await readCodexLocalThreadAncestry(f.home, [WORKER], options)).get(WORKER), WORKER);
  assert.equal((await readCodexLocalRepositoryOrigins(f.home, options)).size, 0);
  assert.equal(await readCodexSelectedRolloutNames(f.home, options), null);
  assert.equal(f.leases.size, 0);
});

test("Windows native refusal of a database or sidecar releases partial leases and hides database metadata", async t => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = await fixture(t, { wal: true });
    f.refuse(file => file === `${f.path}${suffix}`);
    const result = await readCodexLocalThreadMetadata(f.home, [WORKER], f.options);
    assert.equal(result.get(WORKER).parent, null);
    assert.equal(await readCodexSelectedRolloutNames(f.home, f.options), null);
    assert.equal(f.leases.size, 0);
  }
});

test("Windows selected rollout heads share guarded live and closed database reads without titles", async t => {
  for (const wal of [false, true]) {
    const f = await fixture(t, { wal });
    const name = `rollout-2026-09-22T10-00-00-${ROOT}.jsonl`;
    const writer = wal ? f.db : new DatabaseSync(f.path);
    writer.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?")
      .run(join(f.home, "sessions", name), ROOT);
    if (!wal) writer.close();
    const factory = wrappedDatabase(db => ({
      get isOpen() { return db.isOpen; }, exec: db.exec.bind(db), prepare(sql) {
        assert.doesNotMatch(sql, /SELECT.*(?:title|cwd|source)/iu);
        return db.prepare(sql);
      },
      close() {
        assert.ok(f.leases.size >= (wal ? 3 : 1));
        db.close();
      },
    }));
    assert.deepEqual(await readCodexSelectedRolloutNames(f.home,
      { ...f.options, databaseFactory: factory }), new Map([[ROOT, name]]));
    assert.equal(f.leases.size, 0);
  }
});

test("Windows refused index and guardian sources cannot disclose their names or parent", async t => {
  const f = await fixture(t);
  f.refuse(file => file === f.index || file === f.rollout);
  const result = await readCodexLocalThreadMetadata(f.home, [ROOT, REVIEW], f.options);
  assert.equal(result.get(ROOT).name, "Synthetic root");
  assert.equal(result.get(REVIEW).parent, null);
  assert.equal(result.get(REVIEW).origin, "auto_review");
  assert.equal(f.leases.size, 0);
});

test("Windows database constructor and query failures close acquired leases", async t => {
  for (const failure of ["open", "query"]) {
    const f = await fixture(t);
    const factory = failure === "open" ? () => { throw new Error(PRIVATE); } : wrappedDatabase(db => ({
      get isOpen() { return db.isOpen; }, exec() { throw new Error(PRIVATE); }, close: db.close.bind(db),
    }));
    const result = await readCodexLocalThreadMetadata(f.home, [WORKER], { ...f.options, databaseFactory: factory });
    assert.equal(result.get(WORKER).parent, null);
    assert.equal(f.leases.size, 0);
  }
});

test("Windows new sidecar during the query refuses metadata before publishing", async t => {
  const f = await fixture(t);
  const factory = wrappedDatabase(db => ({
    get isOpen() { return db.isOpen; }, prepare: db.prepare.bind(db),
    exec(sql) { db.exec(sql); writeFileSync(`${f.path}-journal`, "synthetic sidecar"); },
    close: db.close.bind(db),
  }));
  const result = await readCodexLocalThreadMetadata(f.home, [WORKER], { ...f.options, databaseFactory: factory });
  assert.equal(result.get(WORKER).parent, null);
  assert.equal(f.leases.size, 0);
});

test("Windows immutable main state changes invalidate optional metadata", async t => {
  const f = await fixture(t);
  const factory = wrappedDatabase(db => ({
    get isOpen() { return db.isOpen; }, prepare: db.prepare.bind(db),
    exec(sql) { db.exec(sql); utimesSync(f.path, new Date(0), new Date(0)); },
    close: db.close.bind(db),
  }));
  const result = await readCodexLocalThreadMetadata(f.home, [WORKER], { ...f.options, databaseFactory: factory });
  assert.equal(result.get(WORKER).parent, null);
  assert.equal(f.leases.size, 0);
});

test("Windows close failure retains guards while SQLite is still open", async t => {
  const f = await fixture(t);
  let database;
  const factory = wrappedDatabase(db => {
    database = db;
    return { get isOpen() { return db.isOpen; }, prepare: db.prepare.bind(db), exec: db.exec.bind(db),
      close() { throw new Error(PRIVATE); } };
  });
  try {
    await assert.rejects(readCodexLocalThreadMetadata(f.home, [WORKER], { ...f.options, databaseFactory: factory }),
      { message: "local_metadata_unavailable" });
    assert.equal(database.isOpen, true);
    assert.ok(f.leases.size > 0);
    assert.equal((await readCodexLocalRepositoryOrigins(f.home, f.options)).size, 0,
      "an unresolved close prevents opening more metadata databases");
    assert.ok(f.leases.size > 0);
  } finally {
    database?.close();
    await readCodexLocalRepositoryOrigins(f.home, f.options);
  }
  assert.equal(f.leases.size, 0, "the next metadata attempt releases successfully closed pending connections");
});

test("Windows close failure after connection shutdown releases source guards", async t => {
  const f = await fixture(t);
  const factory = wrappedDatabase(db => ({ get isOpen() { return db.isOpen; },
    prepare: db.prepare.bind(db), exec: db.exec.bind(db),
    close() { db.close(); throw new Error("synthetic close failure"); },
  }));
  await assert.rejects(readCodexLocalThreadMetadata(f.home, [WORKER], { ...f.options, databaseFactory: factory }));
  assert.equal(f.leases.size, 0);
});


test("optional metadata bounds concurrent database connections and releases every reservation", async t => {
  const f = await fixture(t);
  let active = 0;
  let maximumActive = 0;
  const factory = wrappedDatabase(db => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    return { get isOpen() { return db.isOpen; }, prepare: db.prepare.bind(db), exec: db.exec.bind(db),
      close() { db.close(); active -= 1; } };
  });
  const results = await Promise.all(Array.from({ length: 80 }, () =>
    readCodexLocalRepositoryOrigins(f.home, { ...f.options, databaseFactory: factory })));
  assert.ok(results.some(result => result.size === 1));
  assert.ok(results.some(result => result.size === 0), "excess optional requests refuse instead of exhausting handles");
  assert.ok(maximumActive <= 64);
  assert.equal(active, 0);
  assert.equal(f.leases.size, 0);
  assert.equal((await readCodexLocalRepositoryOrigins(f.home, f.options)).size, 1);
});
