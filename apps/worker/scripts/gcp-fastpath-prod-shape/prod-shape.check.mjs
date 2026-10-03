// Checks of the production-shaped synthetic corpus (MEAS-SYNTH): the roster
// reproduces OWN-3 exactly, every owner-day is exact and deterministic, the
// records are content-free and well placed, and the SQLite seal equals the
// JSON dump round trip it replaces. Node 22.13 or later; no database, no
// network. The pricer is a stand-in (record counts and placement do not depend
// on prices; seed-source.mjs prices with production's own pricer).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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

// MEAS-SYNTH review (2026-10-03): the script's uncapped step called gcloud
// directly, outside the wrapper's guarded command builders and checks.
test("the cloud measurement script reaches the cloud only through the deploy wrapper's checked steps", () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), "run-cloud-measurement.sh");
  const code = readFileSync(path, "utf8").split("\n").filter((line) => !line.trimStart().startsWith("#"))
    .join("\n").replaceAll("\\\n", " ");
  assert.doesNotMatch(code, /(?:^|[\s;|&(`$])gcloud(?:\s|$)/mu, "no direct gcloud command");
  const steps = new Set([...code.matchAll(/(?:^|[\s;{])D ([a-z-]+)/gmu)].map(([, step]) => step));
  assert.deepEqual([...steps].sort(), ["build", "migrate", "protected", "refresh", "refresh-idle", "refresh-uncapped",
    "verify-database"]);
  // The guarded and the uncapped refresh render the same Job: refresh-uncapped reads it back against these flags.
  const call = (step) => code.split("\n").find((line) => line.trimStart().startsWith(`D ${step} `));
  for (const step of ["refresh", "refresh-uncapped"]) {
    for (const flag of ['--image="$IMG"', '--schema="$SCHEMA"', '--now="$NOW"', '"${GUARDED[@]}"']) {
      assert.equal(call(step).includes(flag), true, `${step} ${flag}`);
    }
  }
  assert.equal(call("refresh-uncapped").includes('--after-refresh="$OUT/refresh/refresh.json"'), true);
  assert.equal(call("refresh-uncapped").includes('--task-timeout-seconds="$UNCAPPED_TIMEOUT"'), true);
  // The uncapped run follows only a guarded run that made an execution and did not meet another lock.
  assert.match(code, /if \[\[ ! -f "\$OUT\/refresh\/refresh\.json" \]\]; then/u);
  assert.match(code, /if \[\[ "\$OUTCOME" == "LOCK_HELD" \]\]; then/u);
  const zsh = spawnSync("zsh", ["-n", path], { encoding: "utf8" });
  if (zsh.error?.code !== "ENOENT") assert.equal(zsh.status, 0, zsh.stderr);
});

// The production-tier measurement (MEAS-SYNTH, K-CORE-A round): its own
// disposable instance and Job, every remote call through the wrapper's
// checked steps, and the instance deleted on every exit.
test("the production-tier script reaches only its measurement instance, through the wrapper, and always tears down", () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), "run-prodtier-measurement.sh");
  const code = readFileSync(path, "utf8").split("\n").filter((line) => !line.trimStart().startsWith("#"))
    .join("\n").replaceAll("\\\n", " ");
  assert.doesNotMatch(code, /(?:^|[\s;|&(`$])gcloud(?:\s|$)/mu, "no direct gcloud command");
  const steps = new Set([...code.matchAll(/(?:^|[\s;{])D ([a-z-]+)/gmu)].map(([, step]) => step));
  assert.deepEqual([...steps].sort(), ["build", "meas-create", "meas-metrics", "meas-pgstat", "meas-pgstat-enable",
    "meas-teardown", "refresh", "refresh-uncapped"]);
  const lines = code.split("\n");
  // A long step is `child <stdout> <stderr|-> <command>` (or `sampled <label> ...`, the same with the
  // database sampler running): a background child the shell waits on.
  const CHILD = /^(?:child|sampled\s+\S+)\s+\S+\s+\S+\s+/u;
  const calls = (step) => lines.filter((line) => line.trimStart().replace(CHILD, "").startsWith(`D ${step} `));
  for (const step of ["meas-create", "meas-teardown", "refresh", "refresh-uncapped", "meas-pgstat-enable", "meas-pgstat",
    "meas-metrics"]) {
    assert.ok(calls(step).length > 0, step);
    for (const line of calls(step)) assert.equal(line.includes('--meas-instance="$INSTANCE"'), true, `${step} names the instance`);
  }
  for (const step of ["refresh", "refresh-uncapped"]) {
    for (const line of calls(step)) {
      for (const flag of ['--image="$IMG"', '--schema="$SCHEMA"', '--now="$NOW"', '--refresh-profile="$PROFILE"',
        '"${REFRESH_ENV[@]}"']) {
        assert.equal(line.includes(flag), true, `${step} ${flag}`);
      }
    }
  }
  // The profiled uncapped run is the default: the guarded execution is opt-in, and without it the Job is
  // deployed only (refresh --no-execute) for refresh-uncapped to follow. The CPU profiler is on by default.
  assert.match(code, /^GUARDED=\$\{MEAS_GUARDED:-0\}$/mu);
  assert.match(code, /^CPU_PROFILE=\$\{MEAS_CPU_PROFILE:-cpu\}$/mu);
  assert.equal(calls("refresh").filter((line) => line.includes("--no-execute")).length, 1);
  assert.match(code, /REFRESH_ENV\+=\(--refresh-env=ANALYTICS_V2_REFRESH_PROFILE=cpu\s+--refresh-env=ANALYTICS_V2_REFRESH_PROFILE_SAMPLE_US="\$CPU_SAMPLE_US"\s+--refresh-env=ANALYTICS_V2_REFRESH_PROFILE_SUMMARY_SECONDS="\$PROFILE_SUMMARY"\)/u);
  assert.match(code, /^PROFILE_SUMMARY=\$\{MEAS_PROFILE_SUMMARY_SECONDS:-600\}$/mu);
  // Database snapshots before, during (the sampler) and after; Cloud Monitoring after.
  for (const label of ['"$PROFILE-before"', '"$PROFILE-after"']) assert.ok(code.includes(`pgstat ${label}`), label);
  assert.match(code, /pgstat "\$1-during-\$\(printf %02d \$n\)"/u);
  assert.equal(calls("refresh-uncapped").every((line) => line.trimStart().startsWith("sampled ")), true);
  const seed = lines.find((line) => line.includes("gcp-fastpath-seed.mjs seed"));
  assert.equal(seed.includes('--meas-instance="$INSTANCE"'), true, "the seed dials the measurement instance only");
  // The teardown trap is set before the instance can exist, and runs on every exit.
  const trap = lines.findIndex((line) => line.trim() === "trap teardown EXIT");
  const create = lines.findIndex((line) => line.trimStart().replace(CHILD, "").startsWith("D meas-create "));
  assert.ok(trap > 0 && trap < create, "trap before meas-create");
  assert.ok(lines.findIndex((line) => line.trim() === "trap stop INT TERM HUP") > trap, "signals stop the child");
  // Every remote step after the trap, the seed, the database snapshots and the metrics read included, is a
  // waited child, so a signal tears down at once (the EXIT trap's own meas-teardown is the one foreground call).
  for (const line of [seed, ...["meas-create", "refresh", "refresh-uncapped", "meas-pgstat-enable", "meas-pgstat",
    "meas-metrics"].flatMap(calls)]) {
    assert.match(line.trimStart(), CHILD, line);
  }
  assert.match(code, /if \[\[ ! -f "\$RUN\/refresh\/refresh\.json" \]\]; then/u);
  assert.match(code, /if \[\[ "\$OUTCOME" == "LOCK_HELD" \]\]; then/u);
  // The instance name is evaluated once and kept for a manual teardown.
  assert.match(code, /^print -r -- "\$INSTANCE" > "\$OUT\/instance"$/mu);
  // Its own PID, so an early stop signals this shell only (never `pkill -f`, which also hits caffeinate).
  assert.match(code, /^print -r -- \$\$ > "\$OUT\/pid"$/mu);
  assert.doesNotMatch(code, /pkill/u);
  const zsh = spawnSync("zsh", ["-n", path], { encoding: "utf8" });
  if (zsh.error?.code !== "ENOENT") assert.equal(zsh.status, 0, zsh.stderr);
});

// MEAS-SYNTH review (2026-10-03): zsh runs a trap only once a FOREGROUND
// child exits, so a SIGTERM to the script during the uncapped run (up to the
// 48 h cap) left the instance running until the child ended. The script's own
// child/tree/stop functions, run here around a stand-in step that holds a
// grandchild, must tear down at once and leave no process behind.
test("the production-tier script's signal handling tears down at once and leaves no child running", async (t) => {
  if (spawnSync("zsh", ["-c", "true"]).error?.code === "ENOENT") return t.skip("zsh is not installed");
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "run-prodtier-measurement.sh"), "utf8");
  const definition = (name) => {
    const lines = source.split("\n");
    const start = lines.findIndex((line) => line.startsWith(`${name}() {`));
    assert.ok(start >= 0, name);
    if (lines[start].trimEnd().endsWith("}")) return lines[start];
    const end = lines.findIndex((line, index) => index > start && line === "}");
    return lines.slice(start, end + 1).join("\n");
  };
  const dir = mkdtempSync(join(tmpdir(), "prodtier-trap-"));
  const ownedFile = join(dir, "owned-pids");
  const samplerFile = join(dir, "sampler-started");
  const own = `printf '%s\\n' $$ >> '${ownedFile}'; /bin/sleep 30 & printf '%s\\n' $! >> '${ownedFile}'; wait`;
  writeFileSync(join(dir, "owned.sh"), own);
  writeFileSync(join(dir, "resistant.sh"), `trap '' TERM; ${own}`);
  const harness = ["set -u", "zmodload zsh/datetime", "T0=$EPOCHREALTIME", "TORN=0", "CHILD=0", "SAMPLER=0",
    definition("child").replace("CHILD=$!; wait", `CHILD=$!; print -r -- $CHILD >> '${ownedFile}'; wait`),
    definition("tree"), definition("terminate"), definition("stop"),
    "teardown() { [[ $TORN == 1 ]] && return; TORN=1; printf 'teardown %.1f\\n' $(( EPOCHREALTIME - T0 )); }",
    `D() { /bin/sh "${join(dir, "owned.sh")}"; }`,
    "trap teardown EXIT", "trap stop INT TERM HUP",
    `child "${join(dir, "step.log")}" - D x || exit 1`, "echo finished"].join("\n");
  const sampledHarness = harness.replace(`child "${join(dir, "step.log")}" - D x || exit 1`, [
    "PGSTAT_INTERVAL=0.1", `pgstat() { touch '${samplerFile}'; child /dev/null - /bin/sh "${join(dir, "owned.sh")}"; }`,
    definition("sampler"), definition("sampled"),
    `sampled lbl "${join(dir, "step.log")}" - D x || exit 1`].join("\n"));
  // Widen precisely the snapshot-to-signal race: a sampler whose sleeping
  // child was enumerated can finish sleeping and spawn its snapshot child
  // before tree() returns. Only this owned sampler is delayed, never global ps.
  const race = `pgrep() { local found n; found=$(command pgrep "$@" 2>/dev/null);
` +
    `  if [[ "$2" == "$SAMPLER" ]]; then
` +
    `    for n in {1..100}; do [[ -f '${samplerFile}' ]] && break; /bin/sleep 0.01; done
` +
    `  fi; print -r -- "$found"; }`;
  const finishingHarness = sampledHarness.replace(`D() { /bin/sh "${join(dir, "owned.sh")}"; }`, "D() { /bin/sleep 0.5; }");
  const rootResistantHarness = harness.replace(`D() { /bin/sh "${join(dir, "owned.sh")}"; }`,
    `D() { trap '' TERM; /bin/sh "${join(dir, "resistant.sh")}"; }`)
    .replace(`child "${join(dir, "step.log")}" - D x`, "child /dev/stdout /dev/stderr D x");
  const descendantResistantHarness = rootResistantHarness.replace("D() { trap '' TERM;", "D() {");
  const resistantCompletionHarness = finishingHarness.replace(
    `pgstat() { touch '${samplerFile}'; child /dev/null - /bin/sh "${join(dir, "owned.sh")}"; }`,
    `pgstat() { touch '${samplerFile}'; child /dev/stdout /dev/stderr /bin/sh "${join(dir, "resistant.sh")}"; }`);
  const captureFailureHarness = harness.replace("trap teardown EXIT", "pgrep() { return 2; }\ntrap teardown EXIT")
    .replace(`child "${join(dir, "step.log")}" - D x`, "child /dev/stdout /dev/stderr /bin/sleep 30");
  const captureCompletionFailureHarness = finishingHarness
    .replace(definition("sampler"), "sampler() { exec /bin/sleep 30; }")
    .replace("SAMPLER=$!", `SAMPLER=$!; print -r -- $SAMPLER >> '${ownedFile}'`)
    .replace("trap teardown EXIT", "pgrep() { return 2; }\ntrap teardown EXIT");
  const racingHarness = sampledHarness.replace("trap teardown EXIT", `${race}\ntrap teardown EXIT`);
  const ownedPids = () => existsSync(ownedFile) ? readFileSync(ownedFile, "utf8").trim().split(/\s+/u).map(Number) : [];
  const running = (pid) => {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) throw new Error(`process visibility refused: ${result.stderr}`);
    return result.status === 0 && result.stdout.trim() !== "" && !result.stdout.trim().startsWith("Z");
  };
  const delay = () => new Promise((wake) => setTimeout(wake, 20));
  const unrelated = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
  const unrelatedExit = new Promise(resolveExit => unrelated.on("exit", resolveExit));
  try {
    for (const [signal, script] of [["SIGTERM", harness], ["SIGINT", harness], ["SIGHUP", harness],
      ["SIGTERM", sampledHarness], ["SIGTERM", racingHarness], [null, finishingHarness],
      ["SIGTERM", rootResistantHarness], ["SIGTERM", descendantResistantHarness], [null, resistantCompletionHarness],
      ["SIGTERM", captureFailureHarness], [null, captureCompletionFailureHarness]]) {
      rmSync(ownedFile, { force: true });
      rmSync(samplerFile, { force: true });
      const shell = spawn("zsh", ["-c", script], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      shell.stdout.on("data", (chunk) => { output += chunk; });
      shell.stderr.on("data", (chunk) => { output += chunk; });
      const closed = new Promise((resolveClose) => shell.on("close", resolveClose));
      const exited = new Promise((resolveExit) => shell.on("exit", (code) => resolveExit(code)));
      try {
        assert.equal(running(unrelated.pid), true, "unrelated owned sentinel is visible");
        const started = Date.now();
        const captureFailed = script === captureFailureHarness || script === captureCompletionFailureHarness;
        const minimumPids = script === captureFailureHarness ? 1 : script === captureCompletionFailureHarness ? 2 : 3;
        while (ownedPids().length < minimumPids && Date.now() - started < 5_000) await delay();
        assert.equal(ownedPids().length >= minimumPids, true, "the exact owned step started");
        if (script === sampledHarness) {
          while (ownedPids().length < 6 && Date.now() - started < 5_000) await delay();
          assert.equal(ownedPids().length >= 6, true, "the exact owned sampler started");
        }
        // A refused ps read must fail this gate, never look like successful
        // cleanup. Prove visibility and group ownership while children live.
        for (const pid of ownedPids()) {
          assert.equal(running(pid), true, "exact owned child is visible before cleanup");
          const group = spawnSync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8" });
          assert.equal(group.status, 0, "owned process group is readable");
          assert.equal(Number(group.stdout.trim()), shell.pid, "owned child belongs to the isolated harness group");
        }
        const signalled = Date.now();
        if (signal !== null) shell.kill(signal);
        const code = await Promise.race([exited, new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error(`${signal}: teardown exceeded 5 seconds`)), 5_000);
          timer.unref();
        })]);
        assert.ok(Date.now() - signalled < 5_000, `${signal}: the shell exited at once`);
        assert.equal(code, script === captureCompletionFailureHarness ? 1 : signal === null ? 0 : 130, signal);
        assert.match(output, script === captureCompletionFailureHarness ? /^MEAS_LOCAL_PROCESS_CAPTURE_FAILED\nMEAS_LOCAL_PROCESS_CLEANUP_FAILED\nteardown \d+\.\d\n$/u
          : captureFailed ? /^MEAS_LOCAL_PROCESS_CAPTURE_FAILED\nteardown \d+\.\d\n$/u
          : signal === null ? /^finished\nteardown \d+\.\d\n$/u : /^teardown \d+\.\d\n$/u,
          `${signal}: teardown ran with the expected step outcome`);
        await Promise.race([closed, new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error("owned descendants retained output pipes")), 5_000);
          timer.unref();
        })]);
        assert.ok(Date.now() - signalled < 5_000, "exit and held output pipes close within the existing teardown bound");
        await new Promise((wake) => setTimeout(wake, 300));
        assert.deepEqual(ownedPids().filter(running), [], `${signal} ${script === racingHarness ? "racing sampler" : script === sampledHarness ? "active sampler" : "step"}: no orphaned exact-owned step or sampler`);
        assert.equal(running(unrelated.pid), true, "cleanup preserves an unrelated process group");
      } finally {
        // detached:true gives this one harness its own process group. Cleanup
        // targets only that exact group, including escaped descendants, never
        // command substrings or processes owned by another measurement.
        try { process.kill(-shell.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        await exited;
      }
    }
  } finally {
    try { unrelated.kill("SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    await unrelatedExit;
    rmSync(dir, { recursive: true, force: true });
  }

});

test("the local measurement runs the wrapper's dense profiles and summarises busy cores from ps samples", async () => {
  const { measureProfile, psSeconds, refreshArguments, utilisationSummary, OUTPUT_DIGEST_POLICY } =
    await import("./measure-local.mjs");
  assert.deepEqual({ ...measureProfile("dense") }, { name: "dense", cpu: 4, memoryGiB: 16, heapMiB: 12_288, semiSpaceMiB: 64,
    budgetMiB: 10_752, workers: 1, taskTimeoutSeconds: 86_400 });
  assert.deepEqual({ ...measureProfile("dense-workers") }, { name: "dense-workers", cpu: 4, memoryGiB: 16, heapMiB: null, semiSpaceMiB: null,
    budgetMiB: 10_752, workers: 4, taskTimeoutSeconds: 86_400 });
  assert.throws(() => measureProfile("standard"), (error) => error?.code === "MEAS_SYNTH_PROFILE_INVALID");
  assert.deepEqual(refreshArguments(measureProfile("dense-workers"), "s").filter((arg) => !arg.includes("/")),
    ["--mode=full", "--now=2026-10-01T12:46:00.000Z", "--schema=s", "--workers=4"]);
  assert.equal(refreshArguments(measureProfile("dense"), "s").some((arg) => arg.startsWith("--workers")), false);
  assert.deepEqual([psSeconds("0:01.50"), psSeconds("12:03.25"), psSeconds("1:02:03.50"), psSeconds("2-00:00:01"),
    psSeconds("x")], [1.5, 723.25, 3_723.5, 172_801, null]);
  const summary = utilisationSummary([{ atS: 0, cpuS: 0, rssKiB: 1024 }, { atS: 10, cpuS: 40, rssKiB: 4096 },
    { atS: 20, cpuS: 50, rssKiB: 2048 }, { atS: 30, cpuS: 50, rssKiB: 2048 }], { cores: 4 });
  assert.deepEqual(summary, { sampledWallS: 30, meanBusyCores: 1.67, utilisationOfCores: 0.417, cores: 4,
    wallShareByBusyCores: { 0: 0.333, 1: 0.333, 4: 0.333 }, peakRssMiB: 4 });
  assert.equal(utilisationSummary([{ atS: 0, cpuS: 0, rssKiB: 1 }], { cores: 4 }), null);
  assert.deepEqual(OUTPUT_DIGEST_POLICY.analytics_v2_price_cards, ["first_kernel_id"]);
  assert.deepEqual(OUTPUT_DIGEST_POLICY.analytics_v2_kernel_prices, ["kernel_id", "registered_at", "compute_sha256"]);
  assert.deepEqual(OUTPUT_DIGEST_POLICY.analytics_v2_transition_proofs, []);
});

// MEAS-SYNTH profiling: the local run's profiler options, the database delta
// and the run's summary over a partial receipt directory.
test("the local measurement passes the profiler's env and keeps only its summary lines", async () => {
  const { cpuProfileEnv, profileLines } = await import("./measure-local.mjs");
  assert.deepEqual(cpuProfileEnv(), {});
  assert.deepEqual(cpuProfileEnv({ cpuProfileUs: 5_000 }), { ANALYTICS_V2_REFRESH_PROFILE: "cpu",
    ANALYTICS_V2_REFRESH_PROFILE_SAMPLE_US: "5000" });
  assert.equal(cpuProfileEnv({ cpuProfileUs: 10_000, cpuProfileSummarySeconds: 10 })
    .ANALYTICS_V2_REFRESH_PROFILE_SUMMARY_SECONDS, "10");
  assert.equal(Object.hasOwn(cpuProfileEnv({ cpuProfileUs: 10_000 }), "ANALYTICS_V2_REFRESH_PROFILE_SUMMARY_SECONDS"), false);
  assert.deepEqual(cpuProfileEnv({ cpuProfileUs: 1_000, cpuProfileDir: "/abs/dir" }).ANALYTICS_V2_REFRESH_PROFILE_DIR,
    "/abs/dir");
  const stderr = ['{"profile":"analytics-refresh-profile-v1","sequence":0}', "not json",
    '{"status":"failed","code":"X"}', '{"profile":"analytics-refresh-profile-v1","sequence":1}', "  1 real"].join("\n");
  assert.deepEqual(profileLines(stderr).map(({ sequence }) => sequence), [0, 1]);
});

test("the database delta ranks statements by server time and counts a new statement from zero", async () => {
  const { measPgStatDelta, measStatementText, measStatementFamily, measRoleClass } = await import("./meas-pgstat.mjs");
  const row = (queryid, calls, total, extra = {}) => ({ queryid, role: "runtime", toplevel: true, family: null,
    text: "SELECT $1", calls, total_exec_time: total, total_plan_time: 1, rows: calls, ...extra });
  const before = { label: "dense-before", takenAt: "t0", extension: { name: "pg_stat_statements" },
    statements: [row("1", 10, 100), row("2", 5, 50)], database: { blks_read: 10, numbackends: 3 },
    io: [{ backend_type: "client backend", object: "relation", context: "normal", reads: 4, op_bytes: 8192 }],
    wal: { wal_bytes: 100 } };
  const after = { label: "dense-after", takenAt: "t1", extension: { name: "pg_stat_statements" },
    statements: [row("1", 12, 130), row("2", 5, 50), row("3", 2, 900, { family: "occurrences.load" })],
    database: { blks_read: 25, numbackends: 1 },
    io: [{ backend_type: "client backend", object: "relation", context: "normal", reads: 10, op_bytes: 8192 }],
    wal: { wal_bytes: 160 } };
  const delta = measPgStatDelta(before, after);
  assert.deepEqual(delta.statements.map(({ queryid, calls, total_exec_time: ms }) => [queryid, calls, ms]),
    [["3", 2, 900], ["1", 2, 30]]);
  assert.deepEqual([delta.execMs, delta.statementsComparable, delta.database, delta.wal],
    [930, true, { blks_read: 15 }, { wal_bytes: 60 }]);
  assert.deepEqual(delta.io, [{ backend_type: "client backend", object: "relation", context: "normal", reads: 6 }]);
  assert.equal(measStatementText("SELECT 'a''b', $tag$x$tag$, E'\\n' FROM t WHERE c = 'cut"), "SELECT '?', '?', '?' FROM t WHERE c = '?'");
  assert.equal(measStatementText("<insufficient privilege>"), "(hidden)");
  assert.equal(measStatementText("x".repeat(500)).length, 240);
  assert.equal(measStatementFamily("/* analytics_v2:owners.list */ SELECT 1"), "owners.list");
  assert.equal(measStatementFamily("SELECT 1 /* analytics_v2:owners.list */"), null);
  assert.deepEqual(["m", "r", "cloudsqladmin", "postgres", "someone"].map((name) => measRoleClass(name,
    { migrator: "m", runtime: "r" })), ["migrator", "runtime", "cloudsqladmin", "postgres", "other"]);
});

test("the run summary reads a partial receipt directory: a killed run shows its database delta, and its profile from saved logs", async () => {
  const { summarizeProdtier } = await import("./summarize-prodtier.mjs");
  const dir = mkdtempSync(join(tmpdir(), "prodtier-summary-"));
  try {
    const write = (path, value) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), JSON.stringify(value));
    };
    const snapshot = (label, calls, sessions = []) => ({ label, takenAt: label, extension: { name: "pg_stat_statements" },
      statements: [{ queryid: "1", role: "runtime", toplevel: true, family: "occurrences.load", text: "SELECT $1",
        calls, total_exec_time: calls * 10 }], database: { blks_read: calls }, io: [], wal: {}, sessions });
    write("dense/refresh/refresh.json", { step: "refresh", executed: false, job: "j" });
    // Killed: refresh-uncapped never wrote its receipt, and no "after" snapshot was taken.
    write("pgstat/meas-pgstat-dense-before.json", snapshot("dense-before", 0));
    write("pgstat/meas-pgstat-dense-during-01.json", snapshot("dense-during-01", 5));
    write("pgstat/meas-pgstat-dense-during-02.json", snapshot("dense-during-02", 9,
      [{ role: "runtime", waitEvent: "DataFileRead", sessions: 1 }]));
    write("pgstat/meas-pgstat-dense-workers-during-01.json", snapshot("dense-workers-during-01", 99));
    const summary = summarizeProdtier(dir, ["dense"]);
    const dense = summary.runs.dense;
    assert.deepEqual(dense.guarded, { executed: false });
    assert.equal(dense.uncapped, null);
    assert.deepEqual(dense.snapshots, { before: true, during: 2, after: false });
    assert.deepEqual([dense.database.to.label, dense.database.execMs, dense.database.statements[0].calls],
      ["dense-during-02", 90, 9]);
    assert.deepEqual(dense.sessions.map(({ label }) => label), ["dense-before", "dense-during-01", "dense-during-02"]);
    assert.equal(dense.cloudMonitoring, null);
    assert.deepEqual([dense.profile.source, dense.profile.lines, dense.profile.last], [null, 0, null]);
    // With the uncapped receipt and its profile lines, the last line and the cadence are kept.
    const line = (sequence, reason) => ({ profile: "analytics-refresh-profile-v1", sequence, reason, phase: "compute",
      elapsedSeconds: sequence * 1800, progress: { ownersStarted: sequence }, memory: { heapUsedMiB: 1 },
      eventLoop: { utilization: 0.9 }, gc: { ms: 5 }, top: { self: [["(garbage collector)", 1, 1]] } });
    // Mid-run or after an operator stop, the lines exist only in Cloud Logging: a saved listing gives the
    // newest execution's lines, in order, without duplicates; other entries are ignored.
    const entry = (execution, timestamp, value, text = false) => ({ timestamp, labels: {
      "run.googleapis.com/execution_name": execution }, ...(text ? { textPayload: JSON.stringify(value) }
      : { jsonPayload: value }) });
    write("dense/profile-log.json", [
      entry("j-old", "2026-10-01T00:00:00Z", line(7, "exit")),
      entry("j-x", "2026-10-03T01:00:00Z", line(1, "interval")),
      entry("j-x", "2026-10-03T00:30:00Z", line(0, "interval"), true),
      entry("j-x", "2026-10-03T01:00:00Z", line(1, "interval")),
      entry("j-x", "2026-10-03T01:01:00Z", { status: "ok", state: "complete" }),
      { timestamp: "2026-10-03T01:02:00Z", textPayload: "Container called exit(143)." },
    ]);
    const logged = summarizeProdtier(dir, ["dense"]).runs.dense;
    assert.deepEqual([logged.profile.source, logged.profile.lines, logged.profile.loggedExecution,
      logged.profile.last.sequence], ["cloud-logging", 2, "j-x", 1]);
    assert.deepEqual(logged.profile.cadence.map(({ sequence }) => sequence), [0, 1]);
    write("dense/uncapped/refresh-uncapped.json", { step: "refresh-uncapped", execution: "j-x", durationSeconds: 3_600,
      outcome: "complete", statusLine: { status: "ok", state: "complete", timings: { read: 1 } },
      profiles: [line(0, "interval"), line(1, "exit")] });
    const full = summarizeProdtier(dir, ["dense"]).runs.dense;
    assert.deepEqual([full.uncapped.outcome, full.uncapped.state, full.profile.lines, full.profile.last.reason,
      full.profile.source], ["complete", "complete", 2, "exit", "receipt"]);
    assert.deepEqual(full.profile.cadence.map(({ sequence, elapsedSeconds }) => [sequence, elapsedSeconds]),
      [[0, 0], [1, 1800]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local measurement applies the selected explicit task timeout without inherited Worker heap flags", async () => {
  const { refreshEnv, measureProfile } = await import("./measure-local.mjs");
  const env = refreshEnv({ host: "/private/tmp/tibotattle-pg-synthetic/socket", port: 55531 }, "meas_synth_12345678", measureProfile("dense-workers"));
  assert.equal(env.ANALYTICS_V2_REFRESH_TASK_TIMEOUT_SECONDS, "86400");
  assert.equal(Object.hasOwn(env, "NODE_OPTIONS"), false);
  assert.equal(env.ANALYTICS_V2_MEMORY_BUDGET_MIB, "10752");
});

test("local Worker profiling projection is explicit and paired with exact source", async () => {
  const { workerProfileEnv } = await import("./measure-local.mjs");
  assert.deepEqual(workerProfileEnv(), {});
  assert.throws(() => workerProfileEnv({ workerProfileDir: "/private/tmp/synthetic" }), { code: "MEAS_SYNTH_ARGUMENT_INVALID" });
  assert.throws(() => workerProfileEnv({ workerProfileDir: "relative", workerProfileSource: "a".repeat(40) }), { code: "MEAS_SYNTH_ARGUMENT_INVALID" });
  assert.deepEqual(workerProfileEnv({ workerProfileDir: "/private/tmp/synthetic", workerProfileSource: "a".repeat(40) }), {
    ANALYTICS_V2_LOCAL_WORKER_PROFILE_DIR: "/private/tmp/synthetic", ANALYTICS_V2_LOCAL_WORKER_PROFILE_SOURCE: "a".repeat(40) });
});

// Execute the maintained guarded/uncapped caller loop verbatim. Existing
// receipts must not turn failed local cleanup into a successful measurement;
// ordinary refresh refusal codes must still remain data.
test("real production-tier callers abort cleanup failures independently of refresh receipt outcomes", async () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "run-prodtier-measurement.sh"), "utf8");
  const definition = name => {
    const lines = source.split("\n"), start = lines.findIndex(line => line.startsWith(`${name}() {`));
    assert.ok(start >= 0, name);
    if (lines[start].trimEnd().endsWith("}")) return lines[start];
    return lines.slice(start, lines.findIndex((line, index) => index > start && line === "}") + 1).join("\n");
  };
  const start = source.lastIndexOf('for PROFILE in "${PROFILES[@]}"; do');
  const end = source.indexOf("\ndone", start) + "\ndone".length;
  assert.ok(start >= 0 && end > start, "the actual profile caller loop exists");
  const callers = source.slice(start, end);
  assert.match(callers, /sampled "\$PROFILE-guarded"/u);
  assert.match(callers, /sampled "\$PROFILE"/u);
  const root = mkdtempSync(join(tmpdir(), "prodtier-callers-"));
  try {
    for (const [name, guarded, failure] of [["guarded-failure", 1, true], ["uncapped-failure", 0, true],
      ["refusals-remain-data", 1, false]]) {
      const dir = join(root, name), pidsPath = join(dir, "sampler-pids");
      mkdirSync(dir, { mode: 0o700 });
      const script = ["set -u", "CHILD=0", "SAMPLER=0", `OUT='${dir}'`, `GUARDED=${guarded}`,
        "PROFILES=(dense)", "REFRESH_ENV=()", "INSTANCE=synthetic-measurement", "IMG=synthetic-image",
        "SCHEMA=synthetic", "NOW=2026-10-01T12:46:00.000Z", "UNCAPPED_TIMEOUT=172800",
        `NODE26='${process.execPath}'`, definition("child"), definition("tree"), definition("terminate"),
        definition("sampled").replace("SAMPLER=$!", `SAMPLER=$!; print -r -- $SAMPLER >> '${pidsPath}'`),
        // A synthetic long-lived sampler root; no unseen child is fabricated
        // when the deliberately refused enumeration is exercised.
        "sampler() { exec /bin/sleep 30; }", "step() { :; }", "pgstat() { :; }",
        "metrics() { print -r -- metrics-reached; }", "teardown() { print -r -- teardown; }", "trap teardown EXIT",
        failure ? "pgrep() { return 2; }" : "",
        `D() { local action=$1 arg destination=''; shift; for arg in "$@"; do
          [[ "$arg" == --out=* ]] && destination=\${arg#--out=}; done
          mkdir -p "$destination"; /bin/sleep 0.2
          if [[ "$action" == refresh ]]; then
            print -r -- '${failure ? '{"results":[{"status":"ok","state":"complete"}]}' : '{"results":[{"status":"failed","code":"TIME_GUARD_REACHED"}]}'}' > "$destination/refresh.json"
            return ${failure ? 0 : 7}
          fi
          print -r -- '{}' > "$destination/refresh-uncapped.json"
          return ${failure ? 0 : 9}
        }`, callers, "print -r -- continued"].join("\n");
      const shell = spawn("zsh", ["-c", script], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      shell.stdout.on("data", chunk => { output += chunk; });
      shell.stderr.on("data", chunk => { output += chunk; });
      const exit = new Promise(resolveExit => shell.on("exit", resolveExit));
      const close = new Promise(resolveClose => shell.on("close", resolveClose));
      try {
        const began = Date.now();
        while (!existsSync(pidsPath) && Date.now() - began < 5_000) await new Promise(resolveWait => setTimeout(resolveWait, 10));
        assert.ok(existsSync(pidsPath), `${name}: real caller started its sampler`);
        const first = Number(readFileSync(pidsPath, "utf8").trim().split(/\s+/u)[0]);
        const visible = spawnSync("ps", ["-p", String(first), "-o", "pgid="], { encoding: "utf8" });
        assert.equal(visible.status, 0, "actual sampler process is visible");
        assert.equal(Number(visible.stdout.trim()), shell.pid, "actual sampler belongs to the owned group");
        const timeout = new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error(`${name}: wrapper or held pipe exceeded 5 seconds`)), 5_000);
          timer.unref();
        });
        const code = await Promise.race([exit, timeout]);
        await Promise.race([close, timeout]);
        assert.equal(code, failure ? 1 : 0, name);
        assert.match(output, /teardown\n/u, "EXIT teardown ran");
        assert.ok(existsSync(join(dir, "dense", "refresh", "refresh.json")), "a refresh receipt existed");
        if (failure) {
          assert.match(output, /MEAS_LOCAL_PROCESS_CAPTURE_FAILED\nMEAS_LOCAL_PROCESS_CLEANUP_FAILED\n/u);
          assert.doesNotMatch(output, /continued|metrics-reached/u, "caller cannot qualify or continue after cleanup failure");
          if (!guarded) assert.ok(existsSync(join(dir, "dense", "uncapped", "refresh-uncapped.json")));
        } else {
          assert.match(output, /refresh dense rc=7 \(a guard refusal is data\)/u);
          assert.match(output, /uncapped dense rc=9/u);
          assert.match(output, /metrics-reached\ncontinued\nteardown\n/u);
        }
      } finally {
        try { process.kill(-shell.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        await exit;
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
