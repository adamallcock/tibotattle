import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { countSqlParameters, openSealedSqliteD1 } from "./sealed-sqlite-d1-adapter.mjs";

async function withDatabase(run, { setup = "", readOnly = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tibotattle-sealed-d1-adapter-")));
  const path = join(directory, "scratch.sqlite");
  try {
    const seed = new DatabaseSync(path);
    seed.exec(`CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE, weight REAL, body BLOB) STRICT;
      CREATE TABLE audit(n INTEGER NOT NULL) STRICT;
      CREATE TRIGGER items_audit AFTER INSERT ON items BEGIN INSERT INTO audit VALUES(NEW.id); INSERT INTO audit VALUES(NEW.id); END;
      ${setup}`);
    seed.close();
    const handle = openSealedSqliteD1(path, { readOnly });
    try {
      await run(handle.database, { path, directory });
    } finally {
      handle.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const rows = async (db, sql = "SELECT id,label FROM items ORDER BY id") => (await db.prepare(sql).all()).results;

test("bind, first, all, run and raw follow the D1 statement contract", async () => {
  await withDatabase(async (db) => {
    const insert = db.prepare("INSERT INTO items(id,label,weight,body) VALUES(?,?,?,?)");
    const first = insert.bind(1, "alpha", 1.5, new Uint8Array([1, 2, 3]));
    // bind returns a new statement; the unbound statement is unchanged.
    assert.notEqual(first, insert);
    const result = await first.run();
    assert.equal(result.success, true);
    assert.deepEqual(result.results, []);
    assert.equal(result.meta.changes, 1, "trigger rows are not counted as the statement's own changes");
    assert.equal(result.meta.last_row_id, 1);
    assert.equal(result.meta.changed_db, true);
    assert.ok(Number.isSafeInteger(result.meta.size_after) && result.meta.size_after > 0);
    await insert.bind(2, "beta", null, null).run();
    assert.deepEqual(await db.prepare("SELECT * FROM items WHERE id=?").bind(1).first(),
      { id: 1, label: "alpha", weight: 1.5, body: [1, 2, 3] }, "BLOBs read back as byte arrays, as D1 returns them");
    assert.equal(await db.prepare("SELECT label FROM items WHERE id=?").bind(2).first("label"), "beta");
    assert.equal(await db.prepare("SELECT label FROM items WHERE id=?").bind(9).first(), null);
    assert.equal(await db.prepare("SELECT label FROM items WHERE id=?").bind(9).first("label"), null);
    await assert.rejects(db.prepare("SELECT label FROM items WHERE id=?").bind(1).first("missing"),
      { code: "ADAPTER_COLUMN_NOT_FOUND" });
    assert.deepEqual((await db.prepare("SELECT id,label FROM items ORDER BY id").all()).results,
      [{ id: 1, label: "alpha" }, { id: 2, label: "beta" }]);
    assert.deepEqual(await db.prepare("SELECT id,label FROM items ORDER BY id").raw(), [[1, "alpha"], [2, "beta"]]);
    assert.deepEqual(await db.prepare("SELECT id,label FROM items ORDER BY id").raw({ columnNames: true }),
      [["id", "label"], [1, "alpha"], [2, "beta"]]);
    const read = await db.prepare("SELECT count(*) AS n FROM items").run();
    assert.deepEqual(read.results, [{ n: 2 }]);
    assert.equal(read.meta.changes, 0);
    const noop = await db.prepare("UPDATE items SET label=label WHERE id=?").bind(99).run();
    assert.equal(noop.meta.changes, 0);
    // Numbered and anonymous parameters bind by SQLite index, as D1 binds.
    assert.deepEqual(await db.prepare("SELECT ?2 AS a,?1 AS b,?2 AS c").bind("x", "y").first(), { a: "y", b: "x", c: "y" });
    assert.deepEqual(await db.prepare("SELECT ?2 AS a,? AS b").bind("x", "y", "z").first(), { a: "y", b: "z" });
    // Booleans bind as integers.
    assert.deepEqual(await db.prepare("SELECT typeof(?) AS t,? AS v").bind(true, false).first(), { t: "integer", v: 0 });
  });
});

test("integral numbers bind as INTEGER, as D1 binds them", async () => {
  await withDatabase(async (db) => {
    assert.deepEqual(await db.prepare("SELECT typeof(?) AS i,typeof(?) AS r,typeof(?) AS s").bind(1, 1.25, "1").first(),
      { i: "integer", r: "real", s: "text" });
    assert.equal(await db.prepare("SELECT json_object('x',?,'y',?) AS j").bind(1, 0.5).first("j"), '{"x":1,"y":0.5}');
  });
});

test("the parameter count must match exactly and unsupported values are refused", async () => {
  await withDatabase(async (db) => {
    await assert.rejects(db.prepare("SELECT ? AS a,? AS b").bind(1).first(), { code: "ADAPTER_PARAMETER_COUNT" });
    await assert.rejects(db.prepare("SELECT ? AS a").bind(1, 2).first(), { code: "ADAPTER_PARAMETER_COUNT" });
    await assert.rejects(db.prepare("SELECT ? AS a").bind(undefined).first(), { code: "ADAPTER_TYPE_UNSUPPORTED" });
    await assert.rejects(db.prepare("SELECT ? AS a").bind(1n).first(), { code: "ADAPTER_TYPE_UNSUPPORTED" });
    await assert.rejects(db.prepare("SELECT ? AS a").bind({}).first(), { code: "ADAPTER_TYPE_UNSUPPORTED" });
    await assert.rejects(db.prepare("SELECT ? AS a").bind(Number.NaN).first(), { code: "ADAPTER_TYPE_UNSUPPORTED" });
    // Literals, identifiers and comments never count as parameters.
    assert.equal(countSqlParameters("SELECT '?' AS \"?\", [?], `?` -- ?\n /* ? */ FROM t WHERE a=? AND b=?3 AND c=?"), 4);
    assert.equal(await db.prepare("SELECT '?' AS q,? AS a -- ?\n").bind("v").first("a"), "v");
  });
});

test("an integer beyond the safe range throws instead of losing precision", async () => {
  await withDatabase(async (db) => {
    await assert.rejects(db.prepare("SELECT 9007199254740993 AS n").first(), { code: "ADAPTER_INTEGER_UNSAFE" });
    await assert.rejects(db.prepare("SELECT -9007199254740993 AS n").first(), { code: "ADAPTER_INTEGER_UNSAFE" });
    await assert.rejects(db.prepare("SELECT ? AS n").bind(2 ** 53).first(), { code: "ADAPTER_INTEGER_UNSAFE" });
    assert.equal(await db.prepare("SELECT 9007199254740991 AS n").first("n"), Number.MAX_SAFE_INTEGER);
    assert.equal(await db.prepare("SELECT ? AS n").bind(Number.MAX_SAFE_INTEGER).first("n"), Number.MAX_SAFE_INTEGER);
  });
});

test("a batch is one transaction: a failing third statement rolls back the first two", async () => {
  await withDatabase(async (db) => {
    const insert = (id, label) => db.prepare("INSERT INTO items(id,label) VALUES(?,?)").bind(id, label);
    await assert.rejects(db.batch([insert(1, "one"), insert(2, "two"), insert(3, "one")]), /UNIQUE constraint failed/u);
    assert.deepEqual(await rows(db), []);
    assert.deepEqual(await rows(db, "SELECT n FROM audit"), [], "trigger writes roll back with the batch");
    const results = await db.batch([insert(1, "one"), insert(2, "two"), db.prepare("SELECT count(*) AS n FROM items")]);
    assert.equal(results.length, 3);
    assert.deepEqual(results.map((result) => result.meta.changes), [1, 1, 0]);
    assert.deepEqual(results[2].results, [{ n: 2 }]);
    // Trigger failures abort the whole batch too.
    await db.exec("CREATE TRIGGER items_guard BEFORE INSERT ON items WHEN NEW.label='refused' BEGIN SELECT RAISE(ABORT,'synthetic_guard'); END");
    await assert.rejects(db.batch([insert(3, "three"), insert(4, "refused")]), /synthetic_guard/u);
    assert.deepEqual(await rows(db), [{ id: 1, label: "one" }, { id: 2, label: "two" }]);
    await assert.rejects(db.batch([]), { code: "ADAPTER_BATCH_EMPTY" });
  });
});

test("a statement of another binding is refused in a batch", async () => {
  await withDatabase(async (db, { directory }) => {
    const otherPath = join(directory, "other.sqlite");
    new DatabaseSync(otherPath).close();
    const other = openSealedSqliteD1(otherPath);
    try {
      await assert.rejects(db.batch([other.database.prepare("SELECT 1")]), { code: "ADAPTER_FOREIGN_STATEMENT" });
    } finally {
      other.close();
    }
  });
});

test("readOnly refuses INSERT, UPDATE, DELETE and DDL before they run", async () => {
  await withDatabase(async (db) => {
    assert.deepEqual(await rows(db), [{ id: 1, label: "seeded" }]);
    await assert.rejects(db.prepare("INSERT INTO items(id,label) VALUES(?,?)").bind(2, "x").run(), { code: "ADAPTER_READ_ONLY" });
    await assert.rejects(db.prepare("UPDATE items SET label='y'").run(), { code: "ADAPTER_READ_ONLY" });
    await assert.rejects(db.prepare("DELETE FROM items").run(), { code: "ADAPTER_READ_ONLY" });
    await assert.rejects(db.exec("CREATE TABLE z(a)"), { code: "ADAPTER_READ_ONLY" });
    await assert.rejects(db.batch([db.prepare("SELECT 1 AS a"), db.prepare("DELETE FROM items")]), { code: "ADAPTER_READ_ONLY" });
    assert.deepEqual(await rows(db), [{ id: 1, label: "seeded" }]);
    assert.deepEqual((await db.batch([db.prepare("SELECT count(*) AS n FROM items")]))[0].results, [{ n: 1 }]);
  }, { setup: "INSERT INTO items(id,label) VALUES(1,'seeded');", readOnly: true });
});

test("json_each and json_extract behave as the Worker SQL expects", async () => {
  await withDatabase(async (db) => {
    const ids = JSON.stringify(["b", "a", "c"]);
    assert.deepEqual((await db.prepare("SELECT value FROM json_each(?) ORDER BY value").bind(ids).all()).results
      .map((row) => row.value), ["a", "b", "c"]);
    assert.deepEqual(await db.prepare("SELECT count(*) AS n FROM json_each(?) WHERE value NOT IN(SELECT value FROM json_each(?))")
      .bind(ids, JSON.stringify(["a"])).first(), { n: 2 });
    const authority = JSON.stringify({ sourceId: "synthetic", publicAuthorityEpoch: 7, ratio: 0.5, nested: { flag: true } });
    assert.deepEqual(await db.prepare(`SELECT json_extract(?1,'$.sourceId') AS s,json_extract(?1,'$.publicAuthorityEpoch') AS e,
      typeof(json_extract(?1,'$.publicAuthorityEpoch')) AS t,json_extract(?1,'$.ratio') AS r,json_extract(?1,'$.missing') AS m,
      json_extract(?1,'$.nested') AS n,json_extract(?1,'$.nested.flag') AS f,
      COALESCE(json_extract(?1,'$.missing'),-1)<? AS below,json_extract(?1,'$.sourceId') IS NOT ? AS differs`)
      .bind(authority, 3, "synthetic").first(), { s: "synthetic", e: 7, t: "integer", r: 0.5, m: null,
      n: '{"flag":true}', f: 1, below: 1, differs: 0 });
    assert.deepEqual(await db.prepare("SELECT json_extract(value,'$.ownerDigest') AS d FROM json_each(?)")
      .bind(JSON.stringify([{ ownerDigest: "0".repeat(64) }])).first(), { d: "0".repeat(64) });
    assert.equal(await db.prepare("SELECT json_valid(?) AS v").bind("{").first("v"), 0);
  });
});

test("the adapter opens only the path it is given", async () => {
  await withDatabase(async (db, { directory, path }) => {
    await assert.rejects(db.exec(`ATTACH DATABASE '${join(directory, "other.sqlite")}' AS other`), { code: "ADAPTER_ATTACH_REFUSED" });
    await assert.rejects(db.prepare("ATTACH DATABASE ? AS other").bind(join(directory, "x.sqlite")).run(),
      { code: "ADAPTER_ATTACH_REFUSED" });
    await assert.rejects(db.prepare("SELECT load_extension('x') AS a").first(), /not authorized/u);
    assert.throws(() => openSealedSqliteD1("relative.sqlite"), { code: "ADAPTER_PATH_INVALID" });
    assert.throws(() => openSealedSqliteD1(join(directory, "missing.sqlite")), { code: "ADAPTER_PATH_INVALID" });
    const link = join(directory, "link.sqlite");
    await symlink(path, link);
    assert.throws(() => openSealedSqliteD1(link), { code: "ADAPTER_PATH_INVALID" });
    assert.throws(() => openSealedSqliteD1(path, { create: true }), { code: "ADAPTER_PATH_INVALID" });
    assert.throws(() => openSealedSqliteD1(path, { create: true, readOnly: true }), { code: "ADAPTER_PATH_INVALID" });
    const notSqlite = join(directory, "plain.txt");
    await writeFile(notSqlite, "not a database");
    await chmod(notSqlite, 0o600);
    assert.throws(() => openSealedSqliteD1(notSqlite), { code: "ADAPTER_DATABASE_INVALID" });
    const created = openSealedSqliteD1(join(directory, "created.sqlite"), { create: true });
    assert.deepEqual(await created.database.prepare("SELECT 1 AS one").first(), { one: 1 });
    created.close();
  });
});

test("a closed binding refuses further work and statements survive Proxy wrapping", async () => {
  await withDatabase(async (db, { path }) => {
    // The Worker meters D1 through Proxies that return a different `prepare`.
    const wrapped = new Proxy(db, { get(target, key) {
      if (key === "prepare") return (sql) => target.prepare(sql);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    assert.deepEqual(await wrapped.prepare("SELECT 2 AS two").first(), { two: 2 });
    const statement = wrapped.prepare("SELECT 3 AS three");
    const proxied = new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    assert.deepEqual(await proxied.first(), { three: 3 });
    const handle = openSealedSqliteD1(path);
    handle.close();
    assert.throws(() => handle.database.prepare("SELECT 1"), { code: "ADAPTER_CLOSED" });
  });
});
