// Seal a seeded USAGE_MONITOR_DB SQLite for the importer chain WITHOUT the JSON
// dump round trip, which a production-scale source cannot take: the dense
// oracle's dump (dumpDatabase) and the rehearsal loader's rebuild
// (gcp-fastpath-oracle-sqlite.mjs rebuildOracleSqlite) hold the whole dump as
// one string, and V8 caps a string at about 512 MiB (the dense dump was
// 164 MB for 0.79 million rows; this corpus has about ten times as many).
//
// sealSqliteFromSqlite reproduces rebuildOracleSqlite's result directly from
// the seeded file: the same schema subset (every sqlite_master entry with SQL
// except `_cf_*` and `sqlite_*` objects), every table created first, its rows
// copied in the dump's row order (ORDER BY every column) with their exact
// storage classes, sqlite_sequence restored, then indexes, views and triggers
// (so no trigger fires on a restored row), a DELETE-journal file, the same
// integrity and quick checks, chmod 0444, and the same receipt fields
// (SEALED_SOURCE_TABLES, sealReady), with the file hashed by streaming.
//
// writeJournalDump writes the only part of the dump the ingestion-journal
// stage reads (gcp-fastpath-rehearsal.mjs buildJournalSqlite): the DDL of
// storage_source_state, storage_ingestion_changes and its owner cursor index,
// and the rows of the two tables, in the dump's cell encoding. It is small
// (one row per owner change), so the loader's JSON path takes it unchanged.
//
// Node 22.13 or later (node:sqlite). Local files only.
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SEALED_SOURCE_TABLES } from "../gcp-fastpath-oracle-sqlite.mjs";

/** The objects buildJournalSqlite projects (gcp-fastpath-rehearsal.mjs JOURNAL_OBJECTS). */
export const JOURNAL_OBJECTS = Object.freeze(["storage_source_state", "storage_ingestion_changes",
  "storage_ingestion_owner_cursor"]);
const JOURNAL_TABLES = Object.freeze(["storage_source_state", "storage_ingestion_changes"]);

const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;

/** SHA-256 of a file of any size, read in 8 MiB blocks. */
export function sha256File(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally { closeSync(fd); }
  return hash.digest("hex");
}

/** The dump's kept schema entries (dumpDatabase's filter), tables first, then index, view, trigger. */
function keptSchema(database) {
  return database.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END,name`)
    .all().filter((entry) => !entry.name.startsWith("_cf_") && !entry.name.startsWith("sqlite_"));
}

/**
 * Rebuild `sourcePath` into the new file `outPath` (which must not exist) and
 * seal it. Returns rebuildOracleSqlite's receipt fields plus the row counts.
 */
export function sealSqliteFromSqlite(sourcePath, outPath, { seal = true } = {}) {
  const out = resolve(outPath);
  if (existsSync(out)) throw new Error("PROD_SHAPE_SEAL_OUTPUT_EXISTS");
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const schema = keptSchema(source);
  const tables = schema.filter((entry) => entry.type === "table");
  const sequences = source.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()
    ? source.prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name").all() : [];
  const expected = new Map();
  for (const table of tables) {
    const n = Number(source.prepare(`SELECT COUNT(*) AS n FROM ${quote(table.name)}`).get().n);
    if (n > 0) expected.set(table.name, n);
  }
  source.close();
  const database = new DatabaseSync(out);
  try {
    database.exec("PRAGMA journal_mode=DELETE");
    database.exec("PRAGMA foreign_keys=OFF");
    database.exec("PRAGMA cache_size=-2097152");
    database.prepare("ATTACH DATABASE ? AS seeded").run(resolve(sourcePath));
    database.exec("BEGIN");
    for (const table of tables) database.exec(table.sql);
    for (const name of expected.keys()) {
      const columns = database.prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid").all(name)
        .map((row) => quote(row.name));
      database.exec(`INSERT INTO main.${quote(name)} (${columns.join(",")}) SELECT ${columns.join(",")}
        FROM seeded.${quote(name)} ORDER BY ${columns.join(",")}`);
    }
    if (sequences.length > 0 && database.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()) {
      database.exec("DELETE FROM sqlite_sequence");
      const upsert = database.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)");
      for (const { name, seq } of sequences) upsert.run(name, seq);
    }
    for (const kind of ["index", "view", "trigger"]) {
      for (const entry of schema.filter((item) => item.type === kind)) database.exec(entry.sql);
    }
    database.exec("COMMIT");
    database.exec("DETACH DATABASE seeded");
    for (const [name, count] of expected) {
      const actual = Number(database.prepare(`SELECT COUNT(*) AS n FROM ${quote(name)}`).get().n);
      if (actual !== count) throw new Error(`PROD_SHAPE_SEAL_ROW_COUNT_MISMATCH:${name}`);
    }
    const integrity = database.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check);
    const quick = database.prepare("PRAGMA quick_check(1)").get().quick_check;
    const journalMode = database.prepare("PRAGMA journal_mode").get().journal_mode;
    const allTables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    database.close();
    const missingSealedTables = SEALED_SOURCE_TABLES.filter((name) => !allTables.has(name));
    if (seal) chmodSync(out, 0o444);
    const stat = lstatSync(out);
    const sha256 = sha256File(out);
    const path = realpathSync(out);
    return {
      schemaVersion: "gcp-fastpath-prod-shape-seal-receipt-v1",
      source: { rebuiltFrom: "seeded USAGE_MONITOR_DB SQLite (no JSON dump)" },
      path, bytes: stat.size, sha256, expectedSha256: sha256,
      integrityCheck: integrity.length === 1 ? integrity[0] : integrity,
      quickCheck: quick, journalMode,
      sidecars: ["-wal", "-shm", "-journal"].filter((suffix) => existsSync(out + suffix)),
      mode: (stat.mode & 0o777).toString(8).padStart(4, "0"),
      tables: Object.fromEntries([...expected.entries()].sort(([a], [b]) => a.localeCompare(b))),
      populatedTables: expected.size, declaredTables: allTables.size,
      rows: [...expected.values()].reduce((sum, count) => sum + count, 0),
      schemaSha256: createHash("sha256").update(JSON.stringify(schema.map(({ type, name, tbl_name: table, sql }) =>
        ({ type, name, table, sql })))).digest("hex"),
      sealedSourceTables: { required: SEALED_SOURCE_TABLES.length, missing: missingSealedTables },
      sealedSource: { path, expectedSha256: sha256 },
      sealReady: integrity.length === 1 && integrity[0] === "ok" && quick === "ok" && journalMode !== "wal"
        && (stat.mode & 0o222) === 0 && stat.nlink === 1 && missingSealedTables.length === 0 && isAbsolute(path),
    };
  } catch (error) {
    try { database.close(); } catch { /* already closed */ }
    throw error;
  }
}

/** One cell in the dump's encoding (oracle.mjs dumpDatabase). */
function dumpCell(value, kind) {
  if (kind === "blob") return { $blob: Buffer.from(value).toString("hex") };
  if (kind === "integer") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error("PROD_SHAPE_JOURNAL_INTEGER_UNSAFE");
    }
    return Number(value);
  }
  if (kind === "real") return Number.isInteger(value) ? { $real: value } : value;
  return value;
}

/**
 * Write the journal-only dump buildJournalSqlite reads: `schema` holds the
 * three JOURNAL_OBJECTS entries, `tables` the rows of storage_source_state and
 * storage_ingestion_changes in the dump's row order and encoding.
 */
export function writeJournalDump(sourcePath, outPath, header) {
  const database = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const schema = keptSchema(database).filter((entry) => JOURNAL_OBJECTS.includes(entry.name))
      .map(({ type, name, tbl_name: table, sql }) => ({ type, name, table, sql }));
    for (const name of JOURNAL_OBJECTS) {
      if (!schema.some((entry) => entry.name === name)) throw new Error(`PROD_SHAPE_JOURNAL_DDL_MISSING:${name}`);
    }
    const tables = JOURNAL_TABLES.map((name) => {
      const columns = database.prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid").all(name).map((row) => row.name);
      const select = database.prepare(`SELECT ${columns.map(quote).join(",")},${columns.map((column) => `typeof(${quote(column)})`)
        .join(",")} FROM ${quote(name)} ORDER BY ${columns.map(quote).join(",")}`);
      select.setReadBigInts(true);
      select.setReturnArrays(true);
      const rows = [];
      for (const raw of select.iterate()) rows.push(columns.map((_, index) => dumpCell(raw[index], raw[index + columns.length])));
      return { name, rowCount: rows.length, columns, rows };
    });
    const text = `${JSON.stringify({ header: { ...header, scope: "ingestion-journal-only" }, schema, sqliteSequence: [], tables })}\n`;
    writeFileSync(outPath, text, { mode: 0o600 });
    return { path: realpathSync(outPath), bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
      rows: Object.fromEntries(tables.map((table) => [table.name, table.rowCount])) };
  } finally { database.close(); }
}
