import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CUTOVER_FRESH_CHAIN_LAYOUT,
  CUTOVER_LEDGER_SQL,
  CUTOVER_RESTORE_BASE,
  CUTOVER_RESTORE_BASE_LAYOUT,
  CUTOVER_SCHEMA_SQL,
  CUTOVER_SEQUENCE_SQL,
  CutoverSourceError,
  aggregateQueries,
  assertOwnerDirectory,
  assertSelectOnly,
  buildExpectedLedger,
  canonicalJson,
  classifyExportStatement,
  createWranglerCutoverTransport,
  cutoverRoleInputsAt,
  guardCutoverTransport,
  openSealedSourceFromSeal,
  readCutoverInventory,
  readCutoverSeal,
  runCutoverSeal,
  splitSqlStatements,
  tableLayouts,
  validateCutoverInventory,
  wranglerExportArguments,
} from "./cutover-source-seal.mjs";
import {
  SYNTHETIC_BOOKMARKS,
  SYNTHETIC_D1,
  SYNTHETIC_DATABASE_NAMES,
  writeInventoryFixture,
} from "../postgres-test/fixtures/w2-seal/fence-fixtures.mjs";
import {
  createFakeWranglerProviderSpawn,
  headCommit,
  outputPathsOf,
  prepareSealWorld,
  sealWorld,
  writeFakeWranglerCli,
} from "../postgres-test/fixtures/w2-seal/seal-harness.mjs";
import { readIngestionRoleInputs } from "./d1-storage-role.mjs";
import {
  DEFAULT_INGESTION_LEDGERS,
  Q1_INGESTION_DUMP,
  RESTORE_INGESTION_LEDGERS,
  SYNTHETIC_SIGNED_URL,
  buildSyntheticIngestionD1,
  copyIngestionWithLedgers,
  createFakeCutoverTransport,
  privateDirectory,
} from "../postgres-test/fixtures/w2-seal/synthetic-sources.mjs";

// PT-2-lite seal acceptance. Local only: the transport and the Wrangler
// export are injected fakes over synthetic D1 files; nothing contacts a
// provider. Run: node --test ./scripts/cutover-source-seal.check.mjs

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT = headCommit(WORKER_ROOT);
let world;

const isCode = code => error => error instanceof CutoverSourceError && error.code === code;

async function listing(directory) {
  return (await readdir(directory)).sort();
}

async function filesContain(directory, needle) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isDirectory()) {
      if (await filesContain(path, needle)) return true;
      continue;
    }
    if (info.isFile() && (await readFile(path)).includes(needle)) return true;
  }
  return false;
}

before(async () => {
  world = await prepareSealWorld({ commit: COMMIT });
});

after(async () => {
  await world?.dispose();
});

test("the inventory admits exactly the ingestion and deletion-ledger D1s from an owner 0600 file", async () => {
  const valid = JSON.parse(await readFile(world.inventory.path, "utf8"));
  const inventory = validateCutoverInventory(valid);
  assert.deepEqual(Object.keys(inventory.sources).sort(), ["deletion-ledger", "ingestion"]);
  const analytics = structuredClone(valid);
  analytics.sources.push({ ...valid.sources[0], role: "analytics", binding: "ANALYTICS_DB", databaseId: SYNTHETIC_D1.analytics });
  assert.throws(() => validateCutoverInventory(analytics), isCode("CUTOVER_SOURCE_NOT_ALLOWED"));
  const legacy = structuredClone(valid);
  legacy.sources.push({ ...valid.sources[0], role: "legacy" });
  assert.throws(() => validateCutoverInventory(legacy), isCode("CUTOVER_SOURCE_NOT_ALLOWED"));
  const duplicate = structuredClone(valid);
  duplicate.sources.push(structuredClone(valid.sources[0]));
  assert.throws(() => validateCutoverInventory(duplicate), isCode("CUTOVER_SOURCE_NOT_ALLOWED"));
  const binding = structuredClone(valid);
  binding.sources[0].binding = "ANALYTICS_DB";
  assert.throws(() => validateCutoverInventory(binding), isCode("CUTOVER_INVENTORY_INVALID"));
  const uncovered = structuredClone(valid);
  uncovered.sources[0].ledgers = { d1_migrations: ["migrations"] };
  assert.throws(() => validateCutoverInventory(uncovered), isCode("CUTOVER_INVENTORY_INVALID"));
  const foreignDirectory = structuredClone(valid);
  foreignDirectory.sources[1].ledgers = { d1_migrations: ["analytics-migrations"] };
  assert.throws(() => validateCutoverInventory(foreignDirectory), isCode("CUTOVER_INVENTORY_INVALID"));
  const missing = structuredClone(valid);
  missing.sources.pop();
  assert.throws(() => validateCutoverInventory(missing), isCode("CUTOVER_INVENTORY_INVALID"));

  const loose = join(world.work, "inventory-loose.json");
  await writeFile(loose, JSON.stringify(valid), { mode: 0o644 });
  await chmod(loose, 0o644);
  await assert.rejects(readCutoverInventory(loose), isCode("CUTOVER_INVENTORY_UNSAFE"));
  assert.equal((await readCutoverInventory(world.inventory.path)).inventorySha256, inventory.inventorySha256);

  const guarded = guardCutoverTransport(createFakeCutoverTransport({ sources: world.remotePaths, bookmarks: SYNTHETIC_BOOKMARKS }),
    inventory);
  await assert.rejects(guarded.bookmark({ role: "ingestion", databaseId: SYNTHETIC_D1.analytics }),
    isCode("CUTOVER_SOURCE_NOT_ALLOWED"));
  await assert.rejects(guarded.query({ role: "analytics", databaseId: SYNTHETIC_D1.analytics }, CUTOVER_SCHEMA_SQL),
    isCode("CUTOVER_SOURCE_NOT_ALLOWED"));
});

test("expected ledgers come from git objects at the commit with bare names and file digests", async () => {
  const inventory = await readCutoverInventory(world.inventory.path);
  const ledger = buildExpectedLedger({ source: inventory.sources.ingestion, commit: COMMIT });
  const wrangler = ledger.ledgers.d1_migrations.map(row => row.name);
  assert.deepEqual(wrangler, (await readdir(join(WORKER_ROOT, "migrations"))).filter(name => name.endsWith(".sql")).sort());
  const storage = ledger.ledgers.d1_storage_migrations;
  assert.ok(storage.length > 20);
  for (const row of storage) {
    assert.match(row.name, /^\d{4}_[a-z0-9_-]+\.sql$/u, "bare names only");
    const directory = DEFAULT_INGESTION_LEDGERS.d1_storage_migrations.find(candidate =>
      execFileSync("git", ["-C", WORKER_ROOT, "ls-tree", "--full-tree", "--name-only", `${COMMIT}:apps/worker/${candidate}`],
        { encoding: "utf8" }).split("\n").includes(row.name));
    const bytes = execFileSync("git", ["-C", WORKER_ROOT, "cat-file", "blob", `${COMMIT}:apps/worker/${directory}/${row.name}`]);
    assert.equal(row.sha256, createHash("sha256").update(bytes).digest("hex"));
  }
  assert.throws(() => buildExpectedLedger({ source: inventory.sources.ingestion, commit: "0".repeat(40) }),
    isCode("CUTOVER_EXPECTED_LEDGER_INVALID"));
  // At the Cloudflare production line (d43c8f92) the Q-1 oracle applied every
  // ingestion directory through one Wrangler ledger; the bare-name expected
  // ledger reproduces its 90 rows exactly. Skipped only where that commit
  // object is absent (a shallow clone).
  let present = true;
  try {
    execFileSync("git", ["-C", WORKER_ROOT, "cat-file", "-e", "d43c8f92a059d9c577776f7eca8a331eb305b8a6^{commit}"],
      { stdio: "ignore" });
  } catch {
    present = false;
  }
  if (present) {
    const q1 = buildExpectedLedger({ source: { role: "ingestion", ledgers: { d1_migrations: [
      "migrations", "typed-ingestion-migrations", "ingestion-bridge-migrations", "typed-v1-admission-migrations",
      "typed-v11-admission-migrations", "ingestion-isolation-migrations"] } },
    commit: "d43c8f92a059d9c577776f7eca8a331eb305b8a6" });
    const dump = JSON.parse(await readFile(Q1_INGESTION_DUMP, "utf8"));
    const rows = dump.tables.find(table => table.name === "d1_migrations").rows.map(row => row[1]);
    assert.deepEqual(q1.ledgers.d1_migrations.map(row => row.name), rows);
  }
});

test("remote reads are SELECT-only; a mutation never reaches the transport", async () => {
  const inventory = await readCutoverInventory(world.inventory.path);
  const database = new DatabaseSync(world.ingestionPath, { readOnly: true });
  const schema = database.prepare(CUTOVER_SCHEMA_SQL).all().map(row => ({ ...row }));
  database.close();
  for (const sql of [CUTOVER_SCHEMA_SQL, CUTOVER_SEQUENCE_SQL, ...Object.values(CUTOVER_LEDGER_SQL),
    ...aggregateQueries(tableLayouts(schema.filter(row => !row.name.startsWith("_cf_")))).slice(0, 3)]) {
    assert.equal(assertSelectOnly(sql), sql);
  }
  for (const sql of [
    "DELETE FROM participants",
    "INSERT INTO participants(id) VALUES ('x')",
    "UPDATE collection_controls SET revision = 2",
    "DROP TABLE participants",
    "ATTACH DATABASE 'x' AS y",
    "PRAGMA writable_schema = 1",
    "SELECT 1; DELETE FROM participants",
    "SELECT 1 -- trailing",
    "SELECT 1 /* x */",
    "WITH doomed AS (SELECT 1) DELETE FROM participants",
    "select 1",
    "SELECT load_extension('x')",
    "",
  ]) {
    assert.throws(() => assertSelectOnly(sql), isCode("CUTOVER_REMOTE_SQL_NOT_SELECT"), sql);
  }
  const calls = [];
  const guarded = guardCutoverTransport(createFakeCutoverTransport({ sources: world.remotePaths,
    bookmarks: SYNTHETIC_BOOKMARKS, calls }), inventory);
  await assert.rejects(guarded.query(inventory.sources.ingestion, "DELETE FROM participants"),
    isCode("CUTOVER_REMOTE_SQL_NOT_SELECT"));
  assert.deepEqual(calls, [], "the refused mutation never reached the transport");
  assert.throws(() => createWranglerCutoverTransport({ inventory, transportDirectory: world.work }),
    isCode("CUTOVER_REMOTE_NOT_AUTHORIZED"));
  assert.throws(() => createWranglerCutoverTransport({ inventory, transportDirectory: world.work, remote: true }),
    isCode("CUTOVER_REMOTE_NOT_AUTHORIZED"));
  const args = wranglerExportArguments({ cliPath: "/cli.js", source: inventory.sources.ingestion,
    configPath: "/config.json", outputPath: "/out.sql" });
  assert.deepEqual(args.slice(1, 5), ["d1", "export", inventory.sources.ingestion.databaseName, "--remote"]);
});

test("the export grammar and splitter are closed: triggers, quotes and comments split exactly", () => {
  const text = [
    "PRAGMA defer_foreign_keys=TRUE;",
    "CREATE TABLE t (a TEXT, b INTEGER);",
    "INSERT INTO \"t\" (\"a\",\"b\") VALUES('x;y ''quoted'' END;',1);",
    "-- a comment; with a semicolon\nINSERT INTO t VALUES('/* not a comment */',2);",
    "CREATE TRIGGER g AFTER INSERT ON t BEGIN UPDATE t SET b = CASE WHEN b > 1 THEN b ELSE 0 END; SELECT 1; END;",
    "CREATE VIEW v(a) AS SELECT a FROM t;",
  ].join("\n");
  const statements = [...splitSqlStatements([text.slice(0, 40), text.slice(40, 97), text.slice(97)])];
  assert.equal(statements.length, 6);
  assert.deepEqual(statements.map(statement => classifyExportStatement(statement).kind),
    ["ignore", "table", "data", "data", "deferred", "deferred"]);
  assert.match(statements[4], /SELECT 1; END;$/u);
  for (const [statement, code] of [
    ["CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB);", "CUTOVER_EXPORT_PROVIDER_TABLE"],
    ["INSERT INTO \"_cf_KV\" VALUES('k', X'00');", "CUTOVER_EXPORT_PROVIDER_TABLE"],
    ["DROP TABLE t;", "CUTOVER_EXPORT_STATEMENT_REFUSED"],
    ["ATTACH DATABASE '/tmp/x' AS other;", "CUTOVER_EXPORT_STATEMENT_REFUSED"],
    ["UPDATE t SET b = 1;", "CUTOVER_EXPORT_STATEMENT_REFUSED"],
    ["PRAGMA writable_schema=ON;", "CUTOVER_EXPORT_STATEMENT_REFUSED"],
    ["CREATE TABLE sqlite_stat1 (x);", "CUTOVER_EXPORT_STATEMENT_REFUSED"],
  ]) {
    assert.throws(() => classifyExportStatement(statement), isCode(code), statement);
  }
  assert.throws(() => [...splitSqlStatements(["INSERT INTO t VALUES('unterminated);"])],
    isCode("CUTOVER_EXPORT_STATEMENT_REFUSED"));
});

test("the owner directory is private and outside the repository and the scratchpad", async () => {
  const inside = join(WORKER_ROOT, ".w2-seal-owner-probe");
  await mkdir(inside, { mode: 0o700 });
  try {
    await chmod(inside, 0o700);
    await assert.rejects(assertOwnerDirectory(inside), isCode("CUTOVER_OWNER_DIRECTORY_UNSAFE"));
  } finally {
    await import("node:fs/promises").then(fs => fs.rm(inside, { recursive: true, force: true }));
  }
  const open = await privateDirectory("w2-seal-open-");
  await chmod(open, 0o755);
  await assert.rejects(assertOwnerDirectory(open), isCode("CUTOVER_OWNER_DIRECTORY_UNSAFE"));
  await assert.rejects(assertOwnerDirectory(open, { forbiddenRoots: [] }), isCode("CUTOVER_OWNER_DIRECTORY_UNSAFE"));
  const scratch = await privateDirectory("w2-seal-scratch-");
  await assert.rejects(assertOwnerDirectory(scratch, { forbiddenRoots: [dirname(scratch)] }),
    isCode("CUTOVER_OWNER_DIRECTORY_UNSAFE"));
  assert.equal(await assertOwnerDirectory(scratch), scratch);
});

test("dry run spawns nothing and reads nothing remote; execute needs remote and owner read-only", async () => {
  const dry = await sealWorld(world, { overrides: { execute: false } });
  const plan = await dry.run();
  assert.equal(plan.mode, "dry-run");
  assert.equal(dry.calls.length, 0);
  assert.equal(dry.observations.length, 0);
  assert.deepEqual(await listing(dry.out), []);
  for (const overrides of [{ remote: false }, { ownerReadOnly: false }]) {
    const refused = await sealWorld(world, { overrides });
    await assert.rejects(refused.run(), isCode("CUTOVER_REMOTE_NOT_AUTHORIZED"));
    assert.equal(refused.calls.length, 0);
    assert.equal(refused.observations.length, 0);
  }
});

test("a seal rebuilds 0400 single files, keeps no dump or sidecar, and leaves no signed URL anywhere", async () => {
  const sealed = await sealWorld(world);
  const result = await sealed.run();
  assert.equal(result.mode, "sealed");
  const paths = outputPathsOf(sealed.out);
  assert.deepEqual(await listing(sealed.out),
    ["deletion-ledger.sealed.sqlite", "ingestion.sealed.sqlite", "seal-manifest.json"]);
  for (const path of [paths.manifest, paths.ingestion, paths.ledger]) {
    assert.equal((await lstat(path)).mode & 0o777, 0o400);
  }
  assert.equal(sealed.observations.length, 2);
  for (const observation of sealed.observations) {
    assert.equal(observation.remote, true);
    assert.deepEqual(observation.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(observation.outputMode, 0o600, "the .sql is 0600 when the child opens it");
    assert.equal(observation.writtenMode, 0o600, "and still 0600 once written");
    assert.ok(observation.logPath.startsWith(sealed.out));
  }
  assert.equal(await filesContain(sealed.out, Buffer.from("X-Amz-Signature")), false);
  assert.equal(JSON.stringify(result).includes("X-Amz"), false);
  assert.equal(JSON.stringify(result).includes(SYNTHETIC_SIGNED_URL), false);
  const manifestText = await readFile(paths.manifest, "utf8");
  assert.equal(manifestText.includes(world.fixture.ids.participant), false, "no participant id in the manifest");
  assert.equal(manifestText.includes(SYNTHETIC_D1.ingestion), false, "D1 ids appear only as digests");
  const { manifest } = result;
  const { sealId, ...body } = manifest;
  assert.equal(sealId, createHash("sha256").update(canonicalJson(body)).digest("hex"));
  assert.equal(manifest.schema, "tibotattle-cutover-seal-v1");
  assert.deepEqual(manifest.sources.map(source => source.role), ["ingestion", "deletion-ledger"]);
  assert.deepEqual(manifest.sources.map(source => source.bookmark),
    [SYNTHETIC_BOOKMARKS.ingestion, SYNTHETIC_BOOKMARKS["deletion-ledger"]]);
  for (const source of manifest.sources) {
    assert.equal(source.integrity, "ok");
    assert.ok(source.tables > 0 && source.rows > 0);
  }

  const seal = await readCutoverSeal({ manifestPath: paths.manifest, expectedSealId: sealId });
  const ingestion = await openSealedSourceFromSeal(seal, "ingestion");
  try {
    await ingestion.verify();
    const database = ingestion.database();
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(database.prepare("SELECT count(*) AS n FROM participants").get().n,
      new DatabaseSync(world.ingestionPath, { readOnly: true }).prepare("SELECT count(*) AS n FROM participants").get().n);
    assert.throws(() => database.exec("DELETE FROM participants"));
  } finally {
    ingestion.close();
  }
  await assert.rejects(readCutoverSeal({ manifestPath: paths.manifest, expectedSealId: "0".repeat(64) }),
    isCode("CUTOVER_SEAL_MANIFEST_INVALID"));
  await chmod(paths.ledger, 0o600);
  await writeFile(paths.ledger, Buffer.from("tampered"), { flag: "a" });
  await chmod(paths.ledger, 0o400);
  await assert.rejects(openSealedSourceFromSeal(seal, "deletion-ledger"), isCode("CUTOVER_SEALED_SOURCE_CHANGED"));
  await assert.rejects(openSealedSourceFromSeal(seal, "analytics"), isCode("CUTOVER_SOURCE_NOT_ALLOWED"));
  const rerun = await sealWorld(world, { overrides: { ownerDirectory: sealed.out } });
  await assert.rejects(rerun.run(), isCode("CUTOVER_OUTPUT_EXISTS"));
});

test("an injected echo of the signed URL into the export trips CUTOVER_SECRET_IN_OUTPUT and leaves nothing", async () => {
  const echoed = await sealWorld(world, { spawnOptions: { echoSignedUrl: true } });
  await assert.rejects(echoed.run(), isCode("CUTOVER_SECRET_IN_OUTPUT"));
  assert.deepEqual(await listing(echoed.out), []);
  const failed = await sealWorld(world, { spawnOptions: { exitStatus: 2 } });
  await assert.rejects(failed.run(), isCode("CUTOVER_EXPORT_FAILED"));
  assert.deepEqual(await listing(failed.out), []);
});

test("bookmark drift at B0 or B1 refuses the seal", async () => {
  const before = await sealWorld(world, { bookmarks: { ...SYNTHETIC_BOOKMARKS, ingestion: "00000001-11111111-00000043" } });
  await assert.rejects(before.run(), isCode("CUTOVER_SOURCE_BOOKMARK_DRIFT"));
  assert.equal(before.observations.length, 0, "B0 is checked before the export");
  const drifting = await sealWorld(world, { bookmarks: { ...SYNTHETIC_BOOKMARKS,
    ingestion: call => (call === 1 ? SYNTHETIC_BOOKMARKS.ingestion : "00000001-11111111-00000044") } });
  await assert.rejects(drifting.run(), isCode("CUTOVER_SOURCE_BOOKMARK_DRIFT"));
  assert.equal(drifting.observations.length, 1);
  assert.deepEqual(await listing(drifting.out), []);
});

test("aggregate, schema, sequence and ledger drift each refuse with their own code", async () => {
  const aggregates = await sealWorld(world, { tamper: (role, sql, rows) => (role === "ingestion" && sql.includes("count(*) AS n")
    ? rows.map(row => (row.t === "device_upload_authorizations" ? { ...row, n: row.n - 1 } : row)) : rows) });
  await assert.rejects(aggregates.run(), error => isCode("CUTOVER_AGGREGATE_MISMATCH")(error)
    && error.table === "device_upload_authorizations");
  const realTotal = await sealWorld(world, { tamper: (role, sql, rows) => (role === "ingestion" && sql.includes("count(*) AS n")
    ? rows.map(row => (row.t === "telemetry_v12_quota" ? { ...row, rsum: row.rsum + 0.5 } : row)) : rows) });
  await assert.rejects(realTotal.run(), isCode("CUTOVER_AGGREGATE_MISMATCH"));
  const keys = await sealWorld(world, { tamper: (role, sql, rows) => (role === "ingestion" && sql.includes("count(*) AS n")
    ? rows.map(row => (row.t === "participants" ? { ...row, kmax: "participant:zzzz" } : row)) : rows) });
  await assert.rejects(keys.run(), isCode("CUTOVER_AGGREGATE_MISMATCH"));
  const schema = await sealWorld(world, { tamper: (role, sql, rows) => (role === "ingestion" && sql === CUTOVER_SCHEMA_SQL
    ? rows.filter(row => row.name !== "admin_action_audit_recent") : rows) });
  await assert.rejects(schema.run(), isCode("CUTOVER_SCHEMA_MISMATCH"));
  const sequence = await sealWorld(world, { tamper: (role, sql, rows) => (role === "ingestion" && sql === CUTOVER_SEQUENCE_SQL
    ? rows.map(row => ({ ...row, seq: row.seq + 1 })) : rows) });
  await assert.rejects(sequence.run(), isCode("CUTOVER_SEQUENCE_MISMATCH"));
  const ledger = await sealWorld(world, { tamper: (role, sql, rows) => (role === "ingestion"
    && sql === CUTOVER_LEDGER_SQL.d1_storage_migrations ? rows.slice(1) : rows) });
  await assert.rejects(ledger.run(), isCode("CUTOVER_LEDGER_MISMATCH"));
  for (const run of [aggregates, schema, sequence, ledger]) assert.deepEqual(await listing(run.out), []);
});

test("canonical-form ledger names refuse with CUTOVER_LEDGER_NAME_NOT_BARE", async () => {
  const directory = await privateDirectory("w2-seal-canonical-");
  const canonical = await buildSyntheticIngestionD1({ directory, commit: COMMIT, ledgerNames: "canonical", plant: false });
  const remoteOnly = await sealWorld({ ...world, remotePaths: { ...world.remotePaths, ingestion: canonical.path } });
  await assert.rejects(remoteOnly.run(), isCode("CUTOVER_LEDGER_NAME_NOT_BARE"));
  const both = await sealWorld({ ...world, remotePaths: { ...world.remotePaths, ingestion: canonical.path },
    exportPaths: { ...world.exportPaths, "synthetic-ingestion": canonical.path } });
  await assert.rejects(both.run(), isCode("CUTOVER_LEDGER_NAME_NOT_BARE"));
  // A ledger layout the clean tree does not match (every directory in the
  // Wrangler ledger) refuses as a mismatch against the expected ledger.
  const inventory = await writeInventoryFixture({ directory, commit: COMMIT, name: "inventory-wrangler-only.json",
    ingestionLedgers: { d1_migrations: [...DEFAULT_INGESTION_LEDGERS.d1_migrations, ...DEFAULT_INGESTION_LEDGERS.d1_storage_migrations] } });
  const mismatch = await sealWorld({ ...world, inventory });
  await assert.rejects(mismatch.run(), isCode("CUTOVER_LEDGER_MISMATCH"));
});

test("provider tables: exact provider rows are excluded, unknown ones and provider rows in the export refuse", async () => {
  const providerRow = { type: "table", name: "_cf_KV", tbl_name: "_cf_KV",
    sql: "CREATE TABLE _cf_KV (\n        key TEXT PRIMARY KEY,\n        value BLOB\n      ) WITHOUT ROWID" };
  const excluded = await sealWorld(world, { tamper: (role, sql, rows) => (sql === CUTOVER_SCHEMA_SQL
    ? [...rows, providerRow] : rows) });
  assert.equal((await excluded.run()).mode, "sealed", "the pinned provider schema is outside the predicate");
  const unknown = await sealWorld(world, { tamper: (role, sql, rows) => (sql === CUTOVER_SCHEMA_SQL
    ? [...rows, { ...providerRow, name: "_cf_UNKNOWN", tbl_name: "_cf_UNKNOWN" }] : rows) });
  await assert.rejects(unknown.run(), isCode("CUTOVER_SCHEMA_PROVIDER_TABLE_UNKNOWN"));
  const exported = await sealWorld(world, { spawnOptions: { extra: ["CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB);"] } });
  await assert.rejects(exported.run(), isCode("CUTOVER_EXPORT_PROVIDER_TABLE"));
  const statement = await sealWorld(world, { spawnOptions: { extra: ["DROP TABLE participants;"] } });
  await assert.rejects(statement.run(), isCode("CUTOVER_EXPORT_STATEMENT_REFUSED"));
  for (const run of [unknown, exported, statement]) assert.deepEqual(await listing(run.out), []);
});

test("a D1 id outside the inventory is never sealed", async () => {
  const directory = await privateDirectory("w2-seal-foreign-");
  const inventory = await writeInventoryFixture({ directory, commit: COMMIT, mutate: value => {
    value.sources.push({ ...value.sources[0], role: "analytics", binding: "ANALYTICS_DB", databaseId: SYNTHETIC_D1.analytics });
  } });
  const foreign = await sealWorld({ ...world, inventory });
  await assert.rejects(foreign.run(), isCode("CUTOVER_SOURCE_NOT_ALLOWED"));
  assert.equal(foreign.calls.length, 0);
  assert.equal(foreign.observations.length, 0);
  await assert.rejects(runCutoverSeal({ ...foreign.options, inventoryPath: join(directory, "absent.json") }),
    isCode("CUTOVER_INVENTORY_UNSAFE"));
});

test("the default Wrangler transport removes its pinned configs: only the sealed files on success, nothing on failure", async () => {
  // The real transport and export code paths, driven by an injected spawn
  // and a synthetic CLI stand-in; no provider and no Wrangler is run.
  const cliPath = await writeFakeWranglerCli(await privateDirectory("w2-seal-cli-"));
  const defaultTransport = (spawnOptions = {}, overrides = {}) => {
    const calls = [];
    const run = sealWorld(world, { overrides: { transport: undefined, cliPath, environment: {},
      spawn: createFakeWranglerProviderSpawn(world, { calls, ...spawnOptions }), ...overrides } });
    return run.then(value => ({ ...value, calls }));
  };

  const sealed = await defaultTransport();
  const result = await sealed.run();
  assert.equal(result.mode, "sealed");
  assert.deepEqual(await listing(sealed.out),
    ["deletion-ledger.sealed.sqlite", "ingestion.sealed.sqlite", "seal-manifest.json"]);
  for (const role of ["ingestion", "deletion-ledger"]) {
    const remote = sealed.calls.filter(call => call.role === role);
    assert.ok(remote.some(call => call.kind === "bookmark") && remote.some(call => call.kind === "query"), role);
    assert.ok(remote.every(call => call.configMode === 0o600), `${role}: the pinned config is 0600 while in use`);
  }
  // Wrangler's JSON envelope yields exactly the facts the injected transport reads.
  const injected = await (await sealWorld(world)).run();
  for (const [index, source] of result.manifest.sources.entries()) {
    const other = injected.manifest.sources[index];
    assert.deepEqual([source.schemaSha256, source.aggregatesSha256, source.sequenceSha256, source.ledgerSha256],
      [other.schemaSha256, other.aggregatesSha256, other.sequenceSha256, other.ledgerSha256], source.role);
  }

  const failures = [
    // B0 drift: the transport has written the ingestion config, the seal nothing.
    { bookmarks: { ...SYNTHETIC_BOOKMARKS, ingestion: "00000001-11111111-00000043" }, code: "CUTOVER_SOURCE_BOOKMARK_DRIFT" },
    // B1 drift, after the export: both the seal's and the transport's artifacts exist.
    { bookmarks: { ...SYNTHETIC_BOOKMARKS, ingestion: call => (call === 1 ? SYNTHETIC_BOOKMARKS.ingestion
      : "00000001-11111111-00000044") }, code: "CUTOVER_SOURCE_BOOKMARK_DRIFT" },
    // The second source fails after the first was sealed.
    { bookmarks: { ...SYNTHETIC_BOOKMARKS, "deletion-ledger": "00000001-33333333-00000009" },
      code: "CUTOVER_SOURCE_BOOKMARK_DRIFT" },
  ];
  for (const failure of failures) {
    const failed = await defaultTransport({ bookmarks: failure.bookmarks });
    await assert.rejects(failed.run(), isCode(failure.code));
    assert.ok(failed.calls.some(call => call.kind === "bookmark"));
    assert.deepEqual(await listing(failed.out), [], "no config, dump, log or sealed file is left");
  }

  // A config this run did not write is never adopted or removed.
  const stale = await defaultTransport();
  await writeFile(join(stale.out, "ingestion.wrangler.json"), "{}\n", { mode: 0o600 });
  await assert.rejects(stale.run(), isCode("CUTOVER_OUTPUT_EXISTS"));
  assert.deepEqual(await listing(stale.out), ["ingestion.wrangler.json"]);
  assert.equal(stale.calls.length, 0);
});

test("createWranglerCutoverTransport disposes every pinned config it wrote", async () => {
  const inventory = await readCutoverInventory(world.inventory.path);
  const directory = await privateDirectory("w2-seal-transport-");
  const cliPath = await writeFakeWranglerCli(await privateDirectory("w2-seal-cli-"));
  const calls = [];
  const transport = createWranglerCutoverTransport({ inventory, transportDirectory: directory, cliPath, environment: {},
    spawn: createFakeWranglerProviderSpawn(world, { calls }), remote: true, ownerReadOnly: true });
  assert.equal(await transport.bookmark(inventory.sources.ingestion), SYNTHETIC_BOOKMARKS.ingestion);
  assert.equal(await transport.bookmark(inventory.sources["deletion-ledger"]), SYNTHETIC_BOOKMARKS["deletion-ledger"]);
  const rows = await transport.query(inventory.sources.ingestion, CUTOVER_SCHEMA_SQL);
  assert.ok(rows.length > 0);
  assert.deepEqual(await listing(directory), ["deletion-ledger.wrangler.json", "ingestion.wrangler.json"]);
  for (const name of await listing(directory)) assert.equal((await lstat(join(directory, name))).mode & 0o777, 0o600);
  await transport.dispose();
  assert.deepEqual(await listing(directory), []);
  await transport.dispose();
  assert.deepEqual(calls.map(call => call.kind), ["bookmark", "bookmark", "query"]);
});

// ---------------------------------------------------------------------------
// The restore-base ingestion layout (SEAL-RESTORE-BASE). Production ingestion
// carries the restore-era ledger: the generated 0001_restore_base.sql row plus
// the files applied after it. The layout is selected explicitly and accepts
// exactly that ledger.

const D43 = "d43c8f92a059d9c577776f7eca8a331eb305b8a6";
const commitPresent = (commit) => {
  try {
    execFileSync("git", ["-C", WORKER_ROOT, "cat-file", "-e", `${commit}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const restoreSource = { role: "ingestion", layout: CUTOVER_RESTORE_BASE_LAYOUT, ledgers: RESTORE_INGESTION_LEDGERS };
const blobSha256 = (commit, path) => createHash("sha256")
  .update(execFileSync("git", ["-C", WORKER_ROOT, "cat-file", "blob", `${commit}:apps/worker/${path}`])).digest("hex");
const restoreInventory = (value) => {
  value.sources[0].layout = CUTOVER_RESTORE_BASE_LAYOUT;
  value.sources[0].ledgers = structuredClone(RESTORE_INGESTION_LEDGERS);
};

/** A seal world whose ingestion D1 carries the given ledger layout and inventory. */
async function ledgerVariant({ name, ledgers, layout, storageRows, inventoryMutate }) {
  const directory = await privateDirectory("int-c-restore-");
  const path = await copyIngestionWithLedgers({ sourcePath: world.ingestionPath, directory, name: `${name}.sqlite`,
    commit: COMMIT, ledgers, layout, storageRows });
  const inventory = await writeInventoryFixture({ directory, commit: COMMIT, name: `${name}-inventory.json`,
    mutate: inventoryMutate ?? null });
  return sealWorld({ ...world, inventory, remotePaths: { ...world.remotePaths, ingestion: path },
    exportPaths: { ...world.exportPaths, [SYNTHETIC_DATABASE_NAMES.ingestion]: path } });
}

test("the restore-base layout is explicit, ingestion-only and names every ingestion directory under the storage ledger", async () => {
  const valid = JSON.parse(await readFile(world.inventory.path, "utf8"));
  const restore = structuredClone(valid);
  restoreInventory(restore);
  assert.equal(validateCutoverInventory(restore).sources.ingestion.layout, CUTOVER_RESTORE_BASE_LAYOUT);
  assert.equal(validateCutoverInventory(valid).sources.ingestion.layout, CUTOVER_FRESH_CHAIN_LAYOUT,
    "no layout is the fresh chain");
  const explicitFresh = structuredClone(valid);
  explicitFresh.sources[0].layout = CUTOVER_FRESH_CHAIN_LAYOUT;
  assert.equal(validateCutoverInventory(explicitFresh).sources.ingestion.layout, CUTOVER_FRESH_CHAIN_LAYOUT);
  const refused = [
    value => { value.sources[0].layout = "restore-base"; },
    value => { value.sources[0].layout = null; },
    value => { value.sources[0].layout = CUTOVER_RESTORE_BASE_LAYOUT; },
    value => { restoreInventory(value); value.sources[0].ledgers.d1_storage_migrations.reverse(); },
    value => { restoreInventory(value); value.sources[0].ledgers = { d1_migrations: [...RESTORE_INGESTION_LEDGERS.d1_storage_migrations] }; },
    value => { value.sources[1].layout = CUTOVER_RESTORE_BASE_LAYOUT; },
  ];
  for (const mutate of refused) {
    const candidate = structuredClone(valid);
    mutate(candidate);
    assert.throws(() => validateCutoverInventory(candidate), isCode("CUTOVER_INVENTORY_INVALID"));
  }
  // Analytics is still not a seal role under either layout.
  const analytics = structuredClone(restore);
  analytics.sources.push({ ...restore.sources[1], role: "analytics", binding: "ANALYTICS_DB", databaseId: SYNTHETIC_D1.analytics });
  assert.throws(() => validateCutoverInventory(analytics), isCode("CUTOVER_SOURCE_NOT_ALLOWED"));
  const analyticsRestore = structuredClone(restore);
  analyticsRestore.sources.push({ ...restore.sources[0], role: "analytics", binding: "ANALYTICS_DB",
    databaseId: SYNTHETIC_D1.analytics });
  assert.throws(() => validateCutoverInventory(analyticsRestore), isCode("CUTOVER_SOURCE_NOT_ALLOWED"));
  assert.throws(() => buildExpectedLedger({ source: { ...restoreSource, role: "analytics" }, commit: COMMIT }),
    isCode("CUTOVER_EXPECTED_LEDGER_INVALID"));
  assert.throws(() => buildExpectedLedger({ source: { role: "deletion-ledger", layout: CUTOVER_RESTORE_BASE_LAYOUT,
    ledgers: { d1_storage_migrations: ["deletion-ledger-migrations"] } }, commit: COMMIT }), isCode("CUTOVER_EXPECTED_LEDGER_INVALID"));
  assert.throws(() => buildExpectedLedger({ source: { ...restoreSource, ledgers: DEFAULT_INGESTION_LEDGERS }, commit: COMMIT }),
    isCode("CUTOVER_EXPECTED_LEDGER_INVALID"));
  // The fresh-chain expected ledger (and its digest) is unchanged by naming the layout.
  assert.equal(buildExpectedLedger({ source: { role: "ingestion", layout: CUTOVER_FRESH_CHAIN_LAYOUT,
    ledgers: DEFAULT_INGESTION_LEDGERS }, commit: COMMIT }).sha256,
  buildExpectedLedger({ source: { role: "ingestion", ledgers: DEFAULT_INGESTION_LEDGERS }, commit: COMMIT }).sha256);
});

test("the folded role inputs are recomputed from git objects exactly as the restore generator lists them", async () => {
  const dirty = execFileSync("git", ["-C", WORKER_ROOT, "status", "--porcelain=v1", "--untracked-files=all", "--",
    ...RESTORE_INGESTION_LEDGERS.d1_storage_migrations], { encoding: "utf8" });
  if (dirty === "") {
    const fromTree = await readIngestionRoleInputs(WORKER_ROOT, { allowUnfrozen: true });
    const fromGit = cutoverRoleInputsAt({ commit: COMMIT });
    assert.deepEqual(fromGit.migrations.map(row => ({ ...row })), fromTree.migrations);
    assert.equal(fromGit.inputSha256, fromTree.inputSha256, "the same digest as d1-storage-role.mjs inputSha256");
  }
  if (commitPresent(CUTOVER_RESTORE_BASE.generatorCommit)) {
    const folded = cutoverRoleInputsAt({ commit: CUTOVER_RESTORE_BASE.generatorCommit });
    assert.equal(folded.migrations.length, CUTOVER_RESTORE_BASE.roleInputCount);
    assert.equal(folded.inputSha256, CUTOVER_RESTORE_BASE.roleInputsSha256,
      "the qualification's role-inputs.json inputSha256");
  }
});

test("the restore-base expected ledger is the pinned base row plus exactly the unfolded tail", { skip: !commitPresent(CUTOVER_RESTORE_BASE.generatorCommit) }, async () => {
  const restore = buildExpectedLedger({ source: restoreSource, commit: COMMIT });
  assert.equal(restore.layout, CUTOVER_RESTORE_BASE_LAYOUT);
  assert.deepEqual(Object.keys(restore.ledgers), ["d1_storage_migrations"]);
  const rows = restore.ledgers.d1_storage_migrations;
  assert.deepEqual({ ...rows[0] }, { name: CUTOVER_RESTORE_BASE.name, sha256: CUTOVER_RESTORE_BASE.sha256 });
  const folded = cutoverRoleInputsAt({ commit: CUTOVER_RESTORE_BASE.generatorCommit }).migrations;
  const atCommit = cutoverRoleInputsAt({ commit: COMMIT }).migrations;
  const foldedKeys = new Set(folded.map(row => `${row.directory}/${row.name}/${row.sha256}`));
  const tail = atCommit.filter(row => !foldedKeys.has(`${row.directory}/${row.name}/${row.sha256}`));
  assert.deepEqual(rows.slice(1).map(row => ({ ...row })), tail.map(row => ({ name: row.name, sha256: row.sha256 })));
  assert.notEqual(restore.sha256, buildExpectedLedger({ source: { role: "ingestion", ledgers: RESTORE_INGESTION_LEDGERS },
    commit: COMMIT }).sha256, "the layout is bound into the expected-ledger digest");

  // At the production line the layout reproduces the 13-row live restore-era
  // ledger (names and git-blob digest prefixes from the wave 14 evidence).
  if (commitPresent(D43)) {
    const live = buildExpectedLedger({ source: restoreSource, commit: D43 }).ledgers.d1_storage_migrations
      .map(row => `${row.name}:${row.sha256.slice(0, 12)}`);
    assert.deepEqual(live, [
      "0001_restore_base.sql:396753809b96",
      "0061_accountless_history_retention.sql:0d6d9d233907",
      "0062_v1_acquisition_vocabulary.sql:50efab3fcea6",
      "0005_owner_occurrence_lookup.sql:970bf68dcf1d",
      "0004_v1_multidevice_source_update.sql:65ade40d101d",
      "0005_opt_out_retains_history.sql:17e4d02f0fa7",
      "0006_usage_correction_facts.sql:cbcac1caef1e",
      "0007_usage_correction_admission.sql:3893f350f4c7",
      "0008_telemetry_v12.sql:d5802b4a1d22",
      "0009_performance_reports.sql:cfd43797151e",
      "0010_accountless_v12_renewal.sql:1400953fc3a0",
      "0011_v12_public_eligibility.sql:580019549ec4",
      "0012_v12_empty_day_manifests.sql:92298adaaa32",
    ]);
  }

  // Fail closed on git facts that no longer describe the base.
  const realGit = (args, { repositoryRoot }) => execFileSync("git", ["-C", repositoryRoot, ...args],
    { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  const editing = (commit, path) => (args, options) => (args[0] === "cat-file" && args[1] === "blob"
    && args[2] === `${commit}:apps/worker/${path}` ? Buffer.concat([realGit(args, options), Buffer.from("\n")]) : realGit(args, options));
  const foldedFile = "typed-ingestion-migrations/0001_typed_telemetry.sql";
  assert.throws(() => buildExpectedLedger({ source: restoreSource, commit: COMMIT, git: editing(COMMIT, foldedFile) }),
    isCode("CUTOVER_EXPECTED_LEDGER_INVALID"), "a folded file edited after the base");
  assert.throws(() => buildExpectedLedger({ source: restoreSource, commit: COMMIT,
    git: editing(CUTOVER_RESTORE_BASE.generatorCommit, foldedFile) }), isCode("CUTOVER_EXPECTED_LEDGER_INVALID"),
  "role inputs that no longer hash to the qualification digest");
  const hiding = (args, options) => (args[0] === "ls-tree" && args.at(-1) === `${COMMIT}:apps/worker/migrations`
    ? Buffer.from(realGit(args, options).toString("utf8").split("\0").filter(name => name !== "0001_initial.sql").join("\0"))
    : realGit(args, options));
  assert.throws(() => buildExpectedLedger({ source: restoreSource, commit: COMMIT, git: hiding }),
    isCode("CUTOVER_EXPECTED_LEDGER_INVALID"), "a folded file removed after the base");
  const older = execFileSync("git", ["-C", WORKER_ROOT, "rev-parse", `${CUTOVER_RESTORE_BASE.generatorCommit}~1`],
    { encoding: "utf8" }).trim();
  assert.throws(() => buildExpectedLedger({ source: restoreSource, commit: older }),
    isCode("CUTOVER_EXPECTED_LEDGER_INVALID"), "a commit that predates the base generator");
});

test("the restore-base layout seals the restore-era ledger and refuses every other ledger", { skip: !commitPresent(CUTOVER_RESTORE_BASE.generatorCommit) }, async () => {
  const sealed = await ledgerVariant({ name: "restore", ledgers: RESTORE_INGESTION_LEDGERS, layout: CUTOVER_RESTORE_BASE_LAYOUT,
    inventoryMutate: restoreInventory });
  const result = await sealed.run();
  assert.equal(result.mode, "sealed");
  const ingestion = result.manifest.sources.find(source => source.role === "ingestion");
  assert.equal(ingestion.expectedLedgerSha256, buildExpectedLedger({ source: restoreSource, commit: COMMIT }).sha256);
  const ledgerSource = result.manifest.sources.find(source => source.role === "deletion-ledger");
  const fresh = await (await sealWorld(world)).run();
  assert.equal(ledgerSource.expectedLedgerSha256,
    fresh.manifest.sources.find(source => source.role === "deletion-ledger").expectedLedgerSha256,
    "the deletion ledger is unchanged");

  const tailRow = rows => rows.at(-1);
  const folded = { name: "0001_initial.sql", sha256: blobSha256(COMMIT, "migrations/0001_initial.sql") };
  const cases = [
    ["wrong-base", rows => rows.map((row, index) => (index === 0 ? { ...row, sha256: "0".repeat(64) } : row))],
    ["generated-base-at-d43", rows => rows.map((row, index) => (index === 0
      ? { ...row, sha256: "06484964df77a7187d7e9204e7b52d3855517d07c2d6c2d5b2b8be3376d35d38" } : row))],
    ["missing-tail", rows => rows.filter(row => row !== tailRow(rows))],
    ["extra-tail", rows => [...rows, { name: "9999_not_in_the_repository.sql", sha256: "1".repeat(64) }]],
    ["edited-tail", rows => rows.map(row => (row === tailRow(rows) ? { ...row, sha256: "2".repeat(64) } : row))],
    ["folded-reappears", rows => [...rows, folded]],
    ["no-base", rows => rows.slice(1)],
  ];
  for (const [name, storageRows] of cases) {
    const variant = await ledgerVariant({ name, ledgers: RESTORE_INGESTION_LEDGERS, layout: CUTOVER_RESTORE_BASE_LAYOUT,
      storageRows, inventoryMutate: restoreInventory });
    await assert.rejects(variant.run(), error => isCode("CUTOVER_LEDGER_MISMATCH")(error)
      && error.table === "d1_storage_migrations", name);
    assert.deepEqual(await listing(variant.out), [], `${name}: nothing is left`);
  }

  // The fresh-chain layout refuses a restore-era ledger, under either of its directory layouts.
  for (const [name, ingestionLedgers] of [["fresh-default", DEFAULT_INGESTION_LEDGERS], ["fresh-storage-only", RESTORE_INGESTION_LEDGERS]]) {
    const variant = await ledgerVariant({ name, ledgers: RESTORE_INGESTION_LEDGERS, layout: CUTOVER_RESTORE_BASE_LAYOUT,
      inventoryMutate: value => { value.sources[0].ledgers = structuredClone(ingestionLedgers); } });
    await assert.rejects(variant.run(), isCode("CUTOVER_LEDGER_MISMATCH"), name);
    assert.deepEqual(await listing(variant.out), []);
  }
  // The restore layout refuses a fresh-chain ledger, under either directory layout.
  for (const [name, ledgers] of [["restore-vs-default", DEFAULT_INGESTION_LEDGERS], ["restore-vs-storage-only", RESTORE_INGESTION_LEDGERS]]) {
    const variant = await ledgerVariant({ name, ledgers, inventoryMutate: restoreInventory });
    await assert.rejects(variant.run(), isCode("CUTOVER_LEDGER_MISMATCH"), name);
    assert.deepEqual(await listing(variant.out), []);
  }

  // Analytics is still refused as a role with the restore layout selected.
  const directory = await privateDirectory("int-c-analytics-");
  const inventory = await writeInventoryFixture({ directory, commit: COMMIT, mutate: value => {
    restoreInventory(value);
    value.sources.push({ ...value.sources[1], role: "analytics", binding: "ANALYTICS_DB", databaseId: SYNTHETIC_D1.analytics });
  } });
  const foreign = await sealWorld({ ...world, inventory });
  await assert.rejects(foreign.run(), isCode("CUTOVER_SOURCE_NOT_ALLOWED"));
  assert.equal(foreign.calls.length, 0);
});
