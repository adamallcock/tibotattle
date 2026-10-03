// Checks of the production-shaped synthetic corpus (MEAS-SYNTH): the roster
// reproduces OWN-3 exactly, every owner-day is exact and deterministic, the
// records are content-free and well placed, and the SQLite seal equals the
// JSON dump round trip it replaces. Node 22.13 or later; no database, no
// network. The pricer is a stand-in (record counts and placement do not depend
// on prices; seed-source.mjs prices with production's own pricer).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { buildJournalSqlite } from "../gcp-fastpath-rehearsal.mjs";
import { privacyScan, rebuildOracleSqlite } from "../gcp-fastpath-oracle-sqlite.mjs";
import { sourceContentDigest } from "../gcp-fastpath-dense-oracle/source-digest.mjs";
import { createProdShapeOwner, dayFormat, dayRange, OWN3_COUNTS, ownerDayPlan, PROD_SHAPE_MAX_DAY_USAGE,
  PROD_SHAPE_MIXED_SWITCH_DAY, PROD_SHAPE_ROSTER, PROD_SHAPE_THROUGH_DAY, PROD_SHAPE_WINDOW,
  prodShapeSummary } from "./prod-shape-corpus.mjs";
import { JOURNAL_OBJECTS, sealSqliteFromSqlite, writeJournalDump } from "./seal-sqlite.mjs";

const stubPricer = (event) => ({ coverageStatus: "fully_priced",
  costNanousd: 1 + event.components.inputUncachedTokens + event.components.outputTextTokens });
const owner = (key) => PROD_SHAPE_ROSTER.find((entry) => entry.key === key);

test("the roster reproduces OWN-3: 54 eligible owners, the routing mix and every window threshold", () => {
  const summary = prodShapeSummary(1);
  assert.equal(PROD_SHAPE_ROSTER.length, OWN3_COUNTS.eligibleOwners);
  assert.equal(new Set(PROD_SHAPE_ROSTER.map((entry) => entry.key)).size, PROD_SHAPE_ROSTER.length);
  const routing = {};
  for (const entry of PROD_SHAPE_ROSTER) routing[entry.routing] = (routing[entry.routing] ?? 0) + 1;
  assert.deepEqual(routing, { ...OWN3_COUNTS.routing });
  assert.equal(summary.filter((row) => row.windowUsage > 0).length, OWN3_COUNTS.windowOwners);
  for (const [threshold, [lo, hi]] of Object.entries(OWN3_COUNTS.windowOver)) {
    const n = Number(threshold);
    assert.equal(summary.filter((row) => Math.max(...Object.values(row.windowUsageByFormat)) > n).length, lo,
      `largest single format over ${threshold}`);
    assert.equal(summary.filter((row) => row.windowUsage > n).length, hi, `sum of formats over ${threshold}`);
  }
  assert.equal(Math.max(...summary.map((row) => row.windowUsage)), OWN3_COUNTS.maxWindowRows);
  // Only the mixed owner has two formats in the window, both under 60,000.
  const mixed = summary.find((row) => row.routing === "mixed");
  assert.ok(mixed.windowUsageByFormat.v11 > 0 && mixed.windowUsageByFormat.v12 > 0);
  assert.ok(mixed.windowUsage > 60_000 && Math.max(mixed.windowUsageByFormat.v11, mixed.windowUsageByFormat.v12) <= 60_000);
  // Owners with no window rows hold history only; the "none" owner holds nothing.
  for (const row of summary.filter((entry) => entry.windowUsage === 0)) {
    assert.ok(row.routing === "none" ? row.totalUsage === 0 : row.beforeWindowUsage > 0, row.key);
    if (row.lastDay !== null) assert.ok(row.lastDay < PROD_SHAPE_WINDOW.fromDay, row.key);
  }
});

test("every owner's plan is exact at any scale, capped per day, and the last day closes early", () => {
  for (const scale of [1, 0.25, 0.05]) {
    for (const entry of PROD_SHAPE_ROSTER) {
      const plan = ownerDayPlan(entry, scale);
      let window = 0, before = 0;
      for (const [day, n] of plan) {
        assert.ok(Number.isSafeInteger(n) && n > 0 && n <= PROD_SHAPE_MAX_DAY_USAGE, `${entry.key} ${day}`);
        if (day >= PROD_SHAPE_WINDOW.fromDay) window += n; else before += n;
        assert.ok(day <= PROD_SHAPE_THROUGH_DAY && (entry.firstDay === null || day >= entry.firstDay));
      }
      assert.equal(window, Math.round(entry.windowUsage * scale), `${entry.key} window at ${scale}`);
      assert.equal(before, Math.round(entry.preWindowUsage * scale), `${entry.key} history at ${scale}`);
    }
  }
  const largest = ownerDayPlan(owner("o01"));
  const windowDays = [...largest].filter(([day]) => day >= PROD_SHAPE_WINDOW.fromDay).map(([, n]) => n);
  assert.ok(largest.get(PROD_SHAPE_THROUGH_DAY) < windowDays.reduce((sum, n) => sum + n, 0) / windowDays.length);
});

test("the largest owner holds about 2.52 million records over all history", () => {
  // Records per usage event, measured on a full-scale mid-sized owner, applied
  // to the largest owner's planned usage (seed-source.mjs records the exact count).
  const sample = createProdShapeOwner(owner("o20"), { pricer: stubPricer });
  let usage = 0, records = 0;
  for (const value of sample.days()) {
    usage += value.records.usage.length;
    records += value.records.usage.length + value.records.quota.length + value.records.session.length;
  }
  const largest = prodShapeSummary(1).find((row) => row.key === "o01");
  const estimate = largest.totalUsage * records / usage;
  assert.ok(Math.abs(estimate - OWN3_COUNTS.largestOwnerAllHistoryRecords) / OWN3_COUNTS.largestOwnerAllHistoryRecords < 0.05,
    `estimate ${Math.round(estimate)}`);
});

function ownerDigest(generated) {
  const hash = createHash("sha256");
  for (const value of generated.days()) hash.update(JSON.stringify(value)).update("\n");
  return hash.digest("hex");
}

test("owner-days are deterministic, exact, placed on their day and content-free", () => {
  const directory = mkdtempSync(join(tmpdir(), "prod-shape-check-"));
  try {
    for (const key of ["o11", "o17", "o21", "o35", "o48"]) {
      const entry = owner(key);
      const generated = createProdShapeOwner(entry, { pricer: stubPricer, scale: 0.05 });
      assert.equal(ownerDigest(generated), ownerDigest(createProdShapeOwner(entry, { pricer: stubPricer, scale: 0.05 })));
      const plan = generated.plan;
      const days = [...generated.days()];
      const planned = [...plan.keys()].sort();
      // A v1.1 or v1.2 domain is contiguous through the corpus day; v1 uploads only active days.
      assert.deepEqual(days.map((value) => value.day),
        entry.routing === "v1" ? planned : dayRange(planned[0], PROD_SHAPE_THROUGH_DAY), key);
      const eventIds = new Set();
      let usage = 0;
      for (const { day, format, records } of days) {
        assert.equal(format, dayFormat(entry, day));
        assert.equal(records.usage.length, plan.get(day) ?? 0, `${key} ${day}`);
        usage += records.usage.length;
        const suffix = format === "v12" ? "v1.2" : "v1.1";
        const closes = day === PROD_SHAPE_THROUGH_DAY ? `${day}T02:30:00.000Z` : `${day}T23:59:59.999Z`;
        for (const record of records.usage) {
          assert.equal(record.schemaVersion, `usage-event-${suffix}`);
          assert.ok(record.eventTime.startsWith(day) && record.eventTime <= closes);
          assert.ok(!eventIds.has(record.eventId));
          eventIds.add(record.eventId);
        }
        for (const record of records.quota) {
          assert.equal(record.schemaVersion, `quota-observation-${suffix}`);
          assert.ok(record.observedTime.startsWith(day) && record.observedTime <= closes);
          assert.ok(record.usedPercent >= 0 && record.usedPercent <= 100);
          assert.equal(record.planType, entry.planType);
        }
        for (const record of records.session) assert.equal(record.schemaVersion, `session-dimension-${suffix}`);
        const sorted = [...records.usage].sort((a, b) => a.eventTime < b.eventTime ? -1 : a.eventTime > b.eventTime ? 1
          : a.eventId < b.eventId ? -1 : 1);
        assert.deepEqual(records.usage.map((record) => record.eventId), sorted.map((record) => record.eventId));
      }
      assert.equal(usage, generated.spec.usageEvents);
      if (entry.routing === "mixed") {
        assert.ok(days.some((value) => value.format === "v12" && value.day === PROD_SHAPE_MIXED_SWITCH_DAY));
      }
      const path = join(directory, `${key}.json`);
      writeFileSync(path, JSON.stringify({ days }));
      const scan = privacyScan([path]);
      assert.equal(scan.ok, true, JSON.stringify(scan.findings.slice(0, 3)));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// A tiny SQLite exercising what the seal must carry: STRICT and rowid tables,
// AUTOINCREMENT (sqlite_sequence), blobs, integral reals, an index, a view, a
// trigger and a `_cf_` table the dump drops; plus the journal objects.
function tinySource(path) {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB);
    CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, weight REAL, raw BLOB);
    CREATE TABLE notes (item_id INTEGER NOT NULL, ordinal INTEGER NOT NULL, kind TEXT) STRICT;
    CREATE INDEX notes_by_item ON notes(item_id, ordinal);
    CREATE VIEW heavy_items AS SELECT id, label FROM items WHERE weight > 1;
    CREATE TABLE audit (item_id INTEGER, at INTEGER);
    CREATE TRIGGER items_audit AFTER INSERT ON items BEGIN INSERT INTO audit VALUES (NEW.id, 7); END;
    CREATE TABLE storage_source_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), source_id TEXT NOT NULL) STRICT;
    CREATE TABLE storage_ingestion_changes (sequence INTEGER PRIMARY KEY, owner_digest TEXT NOT NULL, kind TEXT NOT NULL) STRICT;
    CREATE INDEX storage_ingestion_owner_cursor ON storage_ingestion_changes(owner_digest, sequence);
    INSERT INTO _cf_KV VALUES ('k', x'00');
    INSERT INTO items (label, weight, raw) VALUES ('alpha', 2.0, x'0102'), ('beta', 0.5, NULL), ('gamma', 3, x'ff');
    DELETE FROM items WHERE label = 'beta';
    INSERT INTO notes VALUES (1, 2, 'b'), (1, 1, 'a'), (3, 1, NULL);
    INSERT INTO storage_source_state VALUES (1, 'synthetic-source');
    INSERT INTO storage_ingestion_changes VALUES (2, 'digest-b', 'owner_active'), (1, 'digest-a', 'owner_active');`);
  database.close();
}

/** The dense oracle's dump format (oracle.mjs dumpDatabase), written here for the comparison. */
function dumpOf(path, outPath) {
  const database = new DatabaseSync(path, { readOnly: true });
  const schema = database.prepare(`SELECT type,name,tbl_name AS "table",sql FROM sqlite_master WHERE sql IS NOT NULL
    ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END,name`).all()
    .filter((entry) => !entry.name.startsWith("_cf_") && !entry.name.startsWith("sqlite_"));
  const tables = [];
  for (const entry of schema.filter((item) => item.type === "table")) {
    const columns = database.prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid").all(entry.name).map((row) => row.name);
    const select = database.prepare(`SELECT ${columns.map((column) => `"${column}"`).join(",")},
      ${columns.map((column) => `typeof("${column}")`).join(",")} FROM "${entry.name}" ORDER BY ${columns.map((column) => `"${column}"`).join(",")}`);
    select.setReadBigInts(true);
    select.setReturnArrays(true);
    const rows = [...select.iterate()].map((raw) => columns.map((_, index) => {
      const value = raw[index], kind = raw[index + columns.length];
      if (kind === "blob") return { $blob: Buffer.from(value).toString("hex") };
      if (kind === "integer") return Number(value);
      if (kind === "real") return Number.isInteger(value) ? { $real: value } : value;
      return value;
    }));
    if (rows.length > 0) tables.push({ name: entry.name, rowCount: rows.length, sql: entry.sql, columns, rows });
  }
  const sqliteSequence = database.prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name").all()
    .map((row) => ({ name: row.name, seq: Number(row.seq) }));
  database.close();
  writeFileSync(outPath, JSON.stringify({ header: { synthetic: true }, schema, sqliteSequence, tables }));
}

const masterOf = (path) => {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      master: database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
      sequence: database.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()
        ? database.prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name").all() : null,
      journal: database.prepare("PRAGMA journal_mode").get().journal_mode,
    };
  } finally { database.close(); }
};

test("the SQLite seal equals the JSON dump round trip it replaces, and the journal-only dump loads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "prod-shape-seal-"));
  try {
    const source = join(directory, "seeded.sqlite");
    tinySource(source);
    dumpOf(source, join(directory, "dump.json"));
    const viaDump = rebuildOracleSqlite(join(directory, "dump.json"), join(directory, "via-dump.sqlite"));
    const viaSeal = sealSqliteFromSqlite(source, join(directory, "via-seal.sqlite"));
    assert.equal(sourceContentDigest(viaSeal.path), sourceContentDigest(viaDump.path));
    assert.deepEqual(masterOf(viaSeal.path), masterOf(viaDump.path));
    assert.deepEqual(viaSeal.tables, viaDump.tables);
    for (const field of ["integrityCheck", "quickCheck", "journalMode", "populatedTables", "declaredTables", "mode"]) {
      assert.deepEqual(viaSeal[field], viaDump[field], field);
    }
    assert.deepEqual(viaSeal.sealedSourceTables, viaDump.sealedSourceTables);
    assert.equal(viaSeal.sealReady, viaDump.sealReady);
    assert.throws(() => sealSqliteFromSqlite(source, join(directory, "via-seal.sqlite")), /PROD_SHAPE_SEAL_OUTPUT_EXISTS/u);

    const journal = writeJournalDump(source, join(directory, "journal.json"), { synthetic: true });
    assert.deepEqual(journal.rows, { storage_source_state: 1, storage_ingestion_changes: 2 });
    const fromJournal = await buildJournalSqlite(journal.path, join(directory, "journal-a.sqlite"));
    const fromDump = await buildJournalSqlite(join(directory, "dump.json"), join(directory, "journal-b.sqlite"));
    assert.equal(sourceContentDigest(fromJournal.path), sourceContentDigest(fromDump.path));
    assert.deepEqual(masterOf(fromJournal.path).master, masterOf(fromDump.path).master);
    assert.deepEqual(JOURNAL_OBJECTS, ["storage_source_state", "storage_ingestion_changes", "storage_ingestion_owner_cursor"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
