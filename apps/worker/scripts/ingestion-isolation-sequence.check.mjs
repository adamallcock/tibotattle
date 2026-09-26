// The ingestion-isolation stream is forward-only and its D1 ledgers record
// bare file names (d1-storage-wrangler.mjs migrate: the file and its
// `INSERT INTO d1_storage_migrations(name,sha256)` row in one submission).
// A renumbered, relabelled or edited file would therefore let a ledger row name
// SQL it never ran. This check pins the applied and authorized sequence, models
// the bare-name ledger rows the operator writes, and proves on the synthetic
// canonical D1 that main's empty-day rebuild (0012) runs before the GCP-line
// quarantine fence (0013) and v1.2 retained-history transfer (0014), whose
// triggers must survive it, and that participant erasure still cascades.
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { storageSha256 } from "./d1-storage-plan.mjs";
import { createSyntheticCanonicalD1 } from "./postgres-cutover-rehearsal.mjs";
import { TYPED_SCHEMA_INPUT_DIRECTORIES } from "./production-typed-schema.mjs";
import { TYPED_FORWARD_MIGRATIONS } from "./typed-forward-migration.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ISOLATION = "ingestion-isolation-migrations";
// d1-storage-wrangler.mjs refuses any other migration name.
const STORAGE_MIGRATION_NAME = /^\d{4}_[a-z0-9_-]+\.sql$/u;
const LEDGER_SCHEMA_SQL = "CREATE TABLE d1_storage_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64)) STRICT";

// 0001-0012 are GitHub main's files (0012 is the production empty-day hotfix,
// 906dea97); 0013 and 0014 are the GCP line's quarantine fence and v1.2
// retained-history transfer, renamed byte-identically from 0012/0013 after it.
// Later files may follow, contiguously, but these bytes and names never move.
export const PINNED_ISOLATION_SEQUENCE = Object.freeze([
  ["0001_separate_analytics_work.sql", "963fb96dafc03c9f93b911d7b676c9bc752d2763d53032b3a54b843fd725b4e0"],
  ["0002_v11_append_classification.sql", "fe52746cc0536f31641dcb62780a0e34d45044292f18478df082b534692ba436"],
  ["0003_v1_append_classification.sql", "85a33bdc4d719852a63410769b1e8ca7a600e2e2332b71edc5419e69d1a2d10a"],
  ["0004_v1_multidevice_source_update.sql", "65ade40d101d6dc9a8f3ba39970fd713b1e6e8e0933a9425c59c4315a5d27727"],
  ["0005_opt_out_retains_history.sql", "17e4d02f0fa738b1d6fb9389af1ee4a49a69e22837728568884bdb3212777747"],
  ["0006_usage_correction_facts.sql", "cbcac1caef1e854686752d0d025967b4a74102d1297253f31b2ac2ecb42f6d2d"],
  ["0007_usage_correction_admission.sql", "3893f350f4c76481a1a0fcc88fd8b5516ec8239fb100f21942c35105263f19ba"],
  ["0008_telemetry_v12.sql", "d5802b4a1d228c8b4388b5effe67cbf4e61605628eec00d54f0d1669c988c9e1"],
  ["0009_performance_reports.sql", "cfd43797151ea3d5a6740da9792be49bf897968094347cd6fbbb9a0cf6510825"],
  ["0010_accountless_v12_renewal.sql", "1400953fc3a0fbb26229b4d21c9f693133572c678ad6956c89bab85ec2534d56"],
  ["0011_v12_public_eligibility.sql", "580019549ec44faf23b6ea7112f4d3a4e8420284063a8dc7ed3a06ae52840d01"],
  ["0012_v12_empty_day_manifests.sql", "92298adaaa32c7a9c6630b641a188ad552efe545da5ca44e9ee349e9ba13c8ad"],
  ["0013_v12_quarantine_admission.sql", "01f7b2f75dcbe9de8d42fb194702504db39f7ea8dbc475e28d09604230152344"],
  ["0014_accountless_history_transfer_v12.sql", "73662adb122ff7abf9665d8778565056465a07d52e5234c8b0230fe740b62ef7"],
].map(([name, sha256]) => Object.freeze({ name, sha256 })));

// Names the GCP line used before a renumber. No file or ledger row may carry
// them again: the owner's bare-name readback must be able to prove that none
// was ever applied, and a reused name would make that proof ambiguous.
// Kept as number and stem so the retired basenames stay out of repository
// searches for live references to them.
export const RETIRED_ISOLATION_NAMES = Object.freeze([
  ["0010", "v12_quarantine_admission"],
  ["0011", "accountless_v12_renewal"],
  ["0012", "v12_quarantine_admission"],
  ["0013", "accountless_history_transfer_v12"],
].map(([number, stem]) => `${number}_${stem}.sql`));

const QUARANTINE_TRIGGER = Object.freeze({ table: "telemetry_v12_chunks", name: "telemetry_v12_chunk_quarantine_admission" });
const TRANSFER_TRIGGERS = Object.freeze(["grant", "head", "domain"].flatMap((kind) =>
  ["insert", "update", "delete"].map((event) => `accountless_history_transfer_v12_${kind}_${event}`)));
// Participant-keyed v1.2 tables; their children (domain days, records and
// typed record rows) are counted in full because the fixture has one owner.
const V12_OWNER_TABLES = Object.freeze([
  "telemetry_v12_device_capabilities", "telemetry_v12_day_manifests", "telemetry_v12_chunks",
  "telemetry_v12_domain_predecessors", "telemetry_v12_domains", "telemetry_v12_domain_heads",
]);
const V12_CHILD_TABLES = Object.freeze([
  "telemetry_v12_domain_days", "telemetry_v12_records", "telemetry_v12_usage", "telemetry_v12_quota",
  "telemetry_v12_session_tools",
]);

const sqlFiles = async (directory) => (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();

/** Every primary-role file as the operator's ledger row: bare name + SQL sha256. */
export async function readPrimaryLedgerRows(workerRoot = WORKER_ROOT) {
  const rows = [];
  for (const directory of TYPED_SCHEMA_INPUT_DIRECTORIES.primary) {
    for (const name of await sqlFiles(join(workerRoot, directory))) {
      const sql = await readFile(join(workerRoot, directory, name), "utf8");
      rows.push(Object.freeze({ directory, name, sha256: storageSha256(sql), sql }));
    }
  }
  return rows;
}

/** Throws unless the isolation stream is contiguous, unique and pinned. */
export async function assertIngestionIsolationSequence(workerRoot = WORKER_ROOT) {
  const rows = await readPrimaryLedgerRows(workerRoot);
  const seen = new Map();
  for (const row of rows) {
    assert.match(row.name, STORAGE_MIGRATION_NAME, `${row.directory}/${row.name} is not an operator migration name`);
    assert.ok(!RETIRED_ISOLATION_NAMES.includes(row.name), `${row.directory}/${row.name} reuses a retired isolation name`);
    const previous = seen.get(row.name);
    assert.equal(previous, undefined, `bare ledger name ${row.name} is shared by ${previous} and ${row.directory}`);
    seen.set(row.name, row.directory);
  }
  const isolation = rows.filter((row) => row.directory === ISOLATION);
  isolation.forEach((row, index) => {
    assert.equal(row.name.slice(0, 4), String(index + 1).padStart(4, "0"),
      `isolation migrations must be numbered contiguously from 0001 (at ${row.name})`);
  });
  assert.ok(isolation.length >= PINNED_ISOLATION_SEQUENCE.length, "a pinned isolation migration is missing");
  PINNED_ISOLATION_SEQUENCE.forEach((pin, index) => {
    assert.equal(isolation[index].name, pin.name, `isolation position ${index + 1} is not ${pin.name}`);
    assert.equal(isolation[index].sha256, pin.sha256, `${pin.name} bytes changed`);
  });
  return rows;
}

/** The activation gate reads d1_storage_migrations by bare name and sha256. */
export async function readActivationPrimaryPins(workerRoot = WORKER_ROOT) {
  const source = await readFile(join(workerRoot, "src/telemetry-runtime-activation.ts"), "utf8");
  const block = /^export const EXPECTED_PRIMARY_MIGRATIONS = Object\.freeze\(\[\n([\s\S]*?)\n\] as const\);$/mu.exec(source);
  assert.ok(block, "EXPECTED_PRIMARY_MIGRATIONS block not found");
  const pins = [...block[1].matchAll(/name: "([^"]+)",\s*sha256: "([a-f0-9]{64})",/gu)]
    .map(([, name, sha256]) => ({ name, sha256 }));
  assert.equal(pins.length, (block[1].match(/Object\.freeze\(\{/gu) ?? []).length, "unparsed activation pin");
  return pins;
}

/**
 * A D1 primary role rebuilt as production applies it: the Wrangler baseline
 * into d1_migrations, then each storage file together with its bare-name
 * d1_storage_migrations row in one submission.
 */
export async function buildBareNameLedgerModel(workerRoot = WORKER_ROOT) {
  const rows = await assertIngestionIsolationSequence(workerRoot);
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)");
    for (const row of rows) {
      database.exec("BEGIN");
      if (row.directory === "migrations") {
        database.exec(row.sql);
        database.prepare("INSERT INTO d1_migrations(name) VALUES (?)").run(row.name);
      } else {
        database.exec(`${LEDGER_SCHEMA_SQL.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")};\n${row.sql}\n`
          + `INSERT INTO d1_storage_migrations(name,sha256) VALUES('${row.name}','${row.sha256}');`);
      }
      database.exec("COMMIT");
    }
    return database;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    database.close();
    throw error;
  }
}

/**
 * The operator's ledger must satisfy the usage activation gate and the
 * forward operator exactly as each reads it: by bare name and SQL sha256.
 */
export async function assertLedgerPinsResolve(database, workerRoot = WORKER_ROOT) {
  const ledger = new Map(database.prepare("SELECT name, sha256 FROM d1_storage_migrations ORDER BY rowid").all()
    .map((row) => [row.name, row.sha256]));
  for (const retired of RETIRED_ISOLATION_NAMES) {
    assert.equal(ledger.has(retired), false, `ledger row ${retired} reuses a retired isolation name`);
    assert.equal(database.prepare("SELECT count(*) AS n FROM d1_migrations WHERE name = ?").get(retired).n, 0);
  }
  for (const pin of await readActivationPrimaryPins(workerRoot)) {
    assert.equal(ledger.get(pin.name), pin.sha256, `activation pin ${pin.name} does not match its ledger row`);
  }
  for (const pin of TYPED_FORWARD_MIGRATIONS.filter((migration) => migration.role === "primary")) {
    assert.equal(ledger.get(pin.name), pin.sha256, `forward-operator pin ${pin.name} does not match its ledger row`);
  }
  return [...ledger.keys()];
}

function triggersOn(database, tables) {
  return database.prepare(`SELECT name, tbl_name FROM sqlite_schema WHERE type = 'trigger'
      AND tbl_name IN (${tables.map(() => "?").join(",")}) ORDER BY name`).all(...tables)
    .map((row) => `${row.tbl_name}:${row.name}`);
}

/**
 * Every trigger a primary migration creates and no later file explicitly drops
 * must exist. A table rebuild drops its triggers silently, so this is what
 * catches a file ordered before main's 0012 rebuild. The isolation 0013 fence
 * and 0014 transfer triggers are also named, so a missing CREATE fails too.
 */
export function assertIsolationTriggersPresent(database, rows) {
  const expected = new Map();
  for (const row of rows) {
    for (const [, verb, name] of row.sql.matchAll(/\b(CREATE|DROP)\s+TRIGGER\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([A-Za-z0-9_]+)/giu)) {
      if (verb.toUpperCase() === "CREATE") expected.set(name, `${row.directory}/${row.name}`);
      else expected.delete(name);
    }
  }
  const present = new Map(database.prepare("SELECT name, tbl_name FROM sqlite_schema WHERE type = 'trigger'").all()
    .map((row) => [row.name, row.tbl_name]));
  assert.equal(present.get(QUARANTINE_TRIGGER.name), QUARANTINE_TRIGGER.table, "the isolation 0013 quarantine fence is missing");
  for (const name of TRANSFER_TRIGGERS) assert.ok(present.has(name), `isolation 0014 trigger ${name} is missing`);
  for (const [name, origin] of expected) assert.ok(present.has(name), `trigger ${name} from ${origin} is missing`);
  assert.equal(present.size, expected.size, "a trigger exists that no primary migration creates");
}

async function withDoctoredCopy(t, doctor) {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-isolation-sequence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of TYPED_SCHEMA_INPUT_DIRECTORIES.primary) {
    await cp(join(WORKER_ROOT, directory), join(root, directory), { recursive: true });
  }
  await cp(join(WORKER_ROOT, "src/telemetry-runtime-activation.ts"), join(root, "src/telemetry-runtime-activation.ts"));
  await doctor(root);
  return root;
}

test("the isolation stream is contiguous, byte-pinned and free of retired names", async () => {
  const rows = await assertIngestionIsolationSequence();
  const isolation = rows.filter((row) => row.directory === ISOLATION).map((row) => row.name);
  assert.deepEqual(isolation.slice(11, 14), [
    "0012_v12_empty_day_manifests.sql",
    "0013_v12_quarantine_admission.sql",
    "0014_accountless_history_transfer_v12.sql",
  ]);
});

test("bare-name ledger rows resolve every activation and forward-operator pin", async (t) => {
  const database = await buildBareNameLedgerModel();
  t.after(() => database.close());
  const ordered = await assertLedgerPinsResolve(database);
  const hotfix = ordered.indexOf("0012_v12_empty_day_manifests.sql");
  assert.equal(ordered.indexOf("0011_v12_public_eligibility.sql"), hotfix - 1);
  assert.equal(ordered.indexOf("0013_v12_quarantine_admission.sql"), hotfix + 1);
  assert.equal(ordered.indexOf("0014_accountless_history_transfer_v12.sql"), hotfix + 2);
  assert.ok((await readActivationPrimaryPins()).some((pin) => pin.name === "0013_v12_quarantine_admission.sql"));
  assertIsolationTriggersPresent(database, await readPrimaryLedgerRows());
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("the synthetic canonical D1 runs 0012, 0013, 0014 in order and keeps every trigger", async (t) => {
  const database = await createSyntheticCanonicalD1();
  t.after(() => database.close());
  const applied = database.prepare(`SELECT name FROM d1_storage_migrations
      WHERE name LIKE '${ISOLATION}/%' ORDER BY rowid`).all().map((row) => row.name.slice(ISOLATION.length + 1));
  assert.deepEqual(applied.slice(0, PINNED_ISOLATION_SEQUENCE.length), PINNED_ISOLATION_SEQUENCE.map((pin) => pin.name));
  assertIsolationTriggersPresent(database, await readPrimaryLedgerRows());
  assert.deepEqual(triggersOn(database, ["telemetry_v12_domains", "telemetry_v12_domain_heads"]).filter((name) =>
    name.includes(":accountless_history_transfer_v12_")).length, 6);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("participant erasure cascades through the rebuilt v1.2 tables in 0008's order", async (t) => {
  const database = await createSyntheticCanonicalD1();
  t.after(() => database.close());
  const participant = "cutover-synthetic-participant";
  assert.equal(database.prepare("SELECT count(*) AS n FROM participants").get().n, 1);
  const owned = () => [
    ...V12_OWNER_TABLES.map((table) =>
      database.prepare(`SELECT count(*) AS n FROM ${table} WHERE participant_id = ?`).get(participant).n),
    ...V12_CHILD_TABLES.map((table) => database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n),
  ];
  assert.ok(owned().every((count) => count >= 1), "the fixture must hold a full v1.2 domain");
  assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(database.prepare("DELETE FROM participants WHERE id = ?").run(participant).changes, 1);
  assert.deepEqual(owned(), [...V12_OWNER_TABLES, ...V12_CHILD_TABLES].map(() => 0));
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("the cascade proof detects a rebuild that creates the head table before its domain table", async (t) => {
  const database = await createSyntheticCanonicalD1();
  t.after(() => database.close());
  const tables = ["telemetry_v12_domain_heads", "telemetry_v12_domain_days", "telemetry_v12_domains"];
  const saved = new Map(tables.map((table) => [table, {
    sql: database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table).sql,
    rows: database.prepare(`SELECT * FROM ${table}`).all(),
  }]));
  database.exec("PRAGMA foreign_keys=OFF");
  for (const table of tables) database.exec(`DROP TABLE ${table}`);
  for (const table of ["telemetry_v12_domain_heads", "telemetry_v12_domains", "telemetry_v12_domain_days"]) {
    const { sql, rows } = saved.get(table);
    database.exec(sql);
    for (const row of rows) {
      const columns = Object.keys(row);
      database.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
        .run(...Object.values(row));
    }
  }
  database.exec("PRAGMA foreign_keys=ON");
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.throws(() => database.prepare("DELETE FROM participants WHERE id = ?").run("cutover-synthetic-participant"),
    /FOREIGN KEY constraint failed/u);
});

test("a doctored copy with the pre-renumber layout fails", async (t) => {
  const root = await withDoctoredCopy(t, async (copy) => {
    await rename(join(copy, ISOLATION, "0013_v12_quarantine_admission.sql"), join(copy, ISOLATION, RETIRED_ISOLATION_NAMES[2]));
    await rename(join(copy, ISOLATION, "0014_accountless_history_transfer_v12.sql"), join(copy, ISOLATION, RETIRED_ISOLATION_NAMES[3]));
  });
  await assert.rejects(assertIngestionIsolationSequence(root), /retired isolation name/u);
});

test("a doctored copy with an edited hotfix byte fails", async (t) => {
  const root = await withDoctoredCopy(t, async (copy) => {
    const file = join(copy, ISOLATION, "0012_v12_empty_day_manifests.sql");
    await writeFile(file, `${await readFile(file, "utf8")}\n`);
  });
  await assert.rejects(assertIngestionIsolationSequence(root), /0012_v12_empty_day_manifests\.sql bytes changed/u);
});

test("a doctored copy with a numbering gap fails", async (t) => {
  const root = await withDoctoredCopy(t, async (copy) => {
    await rename(join(copy, ISOLATION, "0014_accountless_history_transfer_v12.sql"), join(copy, ISOLATION, "0015_accountless_history_transfer_v12.sql"));
  });
  await assert.rejects(assertIngestionIsolationSequence(root), /numbered contiguously/u);
});

test("a doctored copy whose bare name collides across directories fails", async (t) => {
  const root = await withDoctoredCopy(t, async (copy) => {
    await cp(join(copy, ISOLATION, "0001_separate_analytics_work.sql"), join(copy, "typed-v1-admission-migrations", "0001_separate_analytics_work.sql"));
  });
  await assert.rejects(assertIngestionIsolationSequence(root), /bare ledger name 0001_separate_analytics_work\.sql/u);
});

test("a doctored copy whose activation pin keeps the old fence name fails", async (t) => {
  const root = await withDoctoredCopy(t, async (copy) => {
    const file = join(copy, "src/telemetry-runtime-activation.ts");
    const source = await readFile(file, "utf8");
    assert.ok(source.includes('name: "0013_v12_quarantine_admission.sql"'));
    await writeFile(file, source.replace('name: "0013_v12_quarantine_admission.sql"', `name: "${RETIRED_ISOLATION_NAMES[2]}"`));
  });
  const database = await buildBareNameLedgerModel(root);
  t.after(() => database.close());
  await assert.rejects(assertLedgerPinsResolve(database, root),
    new RegExp(`activation pin ${RETIRED_ISOLATION_NAMES[2].replace(".", "\\.")} does not match its ledger row`, "u"));
});

test("a doctored copy that applies the GCP files before the hotfix loses the 0014 triggers", async (t) => {
  const root = await withDoctoredCopy(t, async (copy) => {
    // Model an application order where main's rebuild runs last: it drops the
    // tables that carry the transfer triggers, so they must be re-created.
    await rename(join(copy, ISOLATION, "0012_v12_empty_day_manifests.sql"), join(copy, ISOLATION, "0015_v12_empty_day_manifests.sql"));
  });
  await assert.rejects(assertIngestionIsolationSequence(root), /numbered contiguously/u);
  const rows = await readPrimaryLedgerRows(root);
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  for (const row of rows) database.exec(row.sql);
  assert.throws(() => assertIsolationTriggersPresent(database, rows),
    /isolation 0014 trigger accountless_history_transfer_v12_head_insert is missing/u);
});
