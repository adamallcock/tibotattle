import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  applyPostgresMigrations,
  readPostgresMigrations,
} from "../cloud-run/postgres-migrations.mjs";
import {
  STAGED_MIGRATIONS_ROOT,
  STAGED_MIGRATION_LOCK_TIMEOUT_MILLISECONDS,
  STAGED_MIGRATION_STATEMENT_TIMEOUT_MILLISECONDS,
  applyStockAndStagedMigrations,
  listStagedMigrations,
  postgresTestEndpoint,
} from "./staged-migrations-harness.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STOCK_ROOT = join(WORKER_ROOT, "postgres", "migrations");
const HISTORY_COLUMNS = Object.freeze([
  { column_name: "version", data_type: "integer", udt_name: "int4", is_nullable: "NO" },
  { column_name: "name", data_type: "text", udt_name: "text", is_nullable: "NO" },
  { column_name: "checksum_sha256", data_type: "text", udt_name: "text", is_nullable: "NO" },
  { column_name: "applied_at", data_type: "timestamp with time zone", udt_name: "timestamptz", is_nullable: "NO" },
]);
const ENDPOINT = await postgresTestEndpoint();
const PG_SKIP = ENDPOINT === null
  ? "set PG_TEST_SOCKET (or PG_TEST_HOST) and PG_TEST_PORT for the local PostgreSQL 17 cluster"
  : false;
const temporaryDirectories = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot(label) {
  const directory = await mkdtemp(join(tmpdir(), `tibotattle-staged-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeMigration(root, role, name, sql) {
  await mkdir(join(root, role), { recursive: true });
  const path = join(root, role, name);
  await writeFile(path, sql, { flag: "wx" });
  return path;
}

function rows(values) {
  return { rows: values, rowCount: values.length };
}

/**
 * A structural stand-in for pg.Pool that answers the runner's bookkeeping
 * queries and records every statement, so the stock runner and the harness
 * can be compared statement by statement without a database.
 */
function fakePool(schema, { failOn } = {}) {
  const transcript = [];
  const releases = [];
  const history = [];
  const lockKeys = [];
  let historyTable = false;
  let connects = 0;
  const client = {
    async query(text, values) {
      transcript.push(text);
      if (failOn !== undefined && text.includes(failOn)) {
        throw Object.assign(new Error("synthetic driver failure"), { code: "22012" });
      }
      if (text.includes("pg_try_advisory_lock")) {
        lockKeys.push(["lock", values[0]]);
        return rows([{ acquired: true }]);
      }
      if (text.includes("pg_advisory_unlock")) {
        lockKeys.push(["unlock", values[0]]);
        return rows([{ released: true }]);
      }
      const deleted = /^DELETE FROM _tibotattle_migration_history WHERE version = (\d+);\n$/u.exec(text);
      if (deleted) {
        const index = history.findIndex((row) => row.version === Number(deleted[1]));
        if (index >= 0) history.splice(index, 1);
        return { rows: [], rowCount: index >= 0 ? 1 : 0 };
      }
      const rewritten = /^UPDATE _tibotattle_migration_history SET checksum_sha256 = '([0-9a-f]{64})' WHERE version = (\d+);\n$/u
        .exec(text);
      if (rewritten) {
        const row = history.find((candidate) => candidate.version === Number(rewritten[2]));
        if (row !== undefined) row.checksum_sha256 = rewritten[1];
        return { rows: [], rowCount: row === undefined ? 0 : 1 };
      }
      if (text.includes("to_regnamespace")) {
        return rows([{ namespace: schema, history_table: historyTable ? "history" : null }]);
      }
      if (text.includes("information_schema.columns")) return rows(HISTORY_COLUMNS.map((column) => ({ ...column })));
      if (text.includes("pg_get_constraintdef")) return rows([{ definition: "PRIMARY KEY (version)" }]);
      if (text.includes("information_schema.tables")) return rows([]);
      if (text.includes("SELECT version, name, checksum_sha256")) return rows(history.map((row) => ({ ...row })));
      if (/INSERT INTO\s+"[^"]+"\."_tibotattle_migration_history"/u.test(text)) {
        history.push({
          version: values[0],
          name: values[1],
          checksum_sha256: values[2],
          applied_at_epoch: String(1_790_000_000 + values[0]),
        });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("CREATE TABLE IF NOT EXISTS _tibotattle_migration_history")) historyTable = true;
      return { rows: [], rowCount: null };
    },
    async release(discard) {
      releases.push(discard);
    },
  };
  return {
    pool: {
      async connect() {
        connects += 1;
        return client;
      },
    },
    transcript,
    releases,
    history,
    lockKeys,
    connects: () => connects,
  };
}

/** The six statements of the transaction that ran `sql`. */
function transactionAround(transcript, sql) {
  const index = transcript.indexOf(sql);
  assert.ok(index >= 4, "the migration SQL ran inside a transaction");
  return transcript.slice(index - 4, index + 2);
}

async function fakeStockRoot() {
  const root = await temporaryRoot("stock");
  const bootstrap = await readFile(join(STOCK_ROOT, "primary", "0001_schema_metadata.sql"), "utf8");
  await writeMigration(root, "primary", "0001_schema_metadata.sql", bootstrap);
  await writeMigration(root, "primary", "0002_stock_fixture.sql", "CREATE TABLE stock_fixture (id integer);\n");
  return root;
}

test("the canonical staged root is apps/worker/postgres/staged-migrations and absence is an empty list", async () => {
  assert.equal(STAGED_MIGRATIONS_ROOT, join(WORKER_ROOT, "postgres", "staged-migrations"));
  const root = await temporaryRoot("absent");
  assert.deepEqual(await listStagedMigrations("primary", { rootDirectory: root }), []);
  assert.deepEqual(await listStagedMigrations("ledger", { rootDirectory: join(root, "missing") }), []);
  await assert.rejects(listStagedMigrations("analytics", { rootDirectory: root }),
    { code: "STAGED_MIGRATION_ROLE_INVALID" });
});

test("listStagedMigrations returns non-contiguous files in ascending order with checksums", async () => {
  const root = await temporaryRoot("list");
  await writeMigration(root, "primary", "0099_late.sql", "SELECT 99;\n");
  await writeMigration(root, "primary", "0061_middle.sql", "SELECT 61;\n");
  await writeMigration(root, "primary", "0050_early.sql", "SELECT 50;\n");
  await writeFile(join(root, "primary", "README.md"), "notes\n");
  const listed = await listStagedMigrations("primary", { rootDirectory: root });
  assert.ok(Object.isFrozen(listed));
  assert.deepEqual(listed.map(({ version, name }) => [version, name]), [
    [50, "0050_early.sql"],
    [61, "0061_middle.sql"],
    [99, "0099_late.sql"],
  ]);
  assert.ok(listed.every((migration) => Object.isFrozen(migration)
    && migration.role === "primary" && /^[0-9a-f]{64}$/u.test(migration.sha256)
    && migration.bytes === Buffer.byteLength(migration.sql)));
});

test("listStagedMigrations refuses symbolic links, hard links and malformed files", async () => {
  const outside = await temporaryRoot("outside");
  const target = join(outside, "target.sql");
  await writeFile(target, "SELECT 1;\n");

  const symlinked = await temporaryRoot("symlink");
  await writeMigration(symlinked, "primary", "0099_real.sql", "SELECT 99;\n");
  await symlink(target, join(symlinked, "primary", "0100_linked.sql"));
  await assert.rejects(listStagedMigrations("primary", { rootDirectory: symlinked }),
    { code: "STAGED_MIGRATION_PATH_UNSAFE" });

  const hardLinked = await temporaryRoot("hardlink");
  await mkdir(join(hardLinked, "primary"));
  await link(target, join(hardLinked, "primary", "0099_hard.sql"));
  await assert.rejects(listStagedMigrations("primary", { rootDirectory: hardLinked }),
    { code: "STAGED_MIGRATION_PATH_UNSAFE" });

  const linkedDirectory = await temporaryRoot("dirlink");
  const realDirectory = await temporaryRoot("realdir");
  await writeFile(join(realDirectory, "0099_real.sql"), "SELECT 1;\n");
  await symlink(realDirectory, join(linkedDirectory, "primary"));
  await assert.rejects(listStagedMigrations("primary", { rootDirectory: linkedDirectory }),
    { code: "STAGED_MIGRATION_PATH_UNSAFE" });

  const nestedDirectory = await temporaryRoot("nested");
  await mkdir(join(nestedDirectory, "primary", "0099_directory.sql"), { recursive: true });
  await assert.rejects(listStagedMigrations("primary", { rootDirectory: nestedDirectory }),
    { code: "STAGED_MIGRATION_PATH_UNSAFE" });

  for (const [files, code] of [
    [[["99_short.sql", "SELECT 1;"]], "STAGED_MIGRATION_NAME_INVALID"],
    [[["0099_Upper.sql", "SELECT 1;"]], "STAGED_MIGRATION_NAME_INVALID"],
    [[["0000_zero.sql", "SELECT 1;"]], "STAGED_MIGRATION_VERSION_INVALID"],
    [[["0099_empty.sql", " \n"]], "STAGED_MIGRATION_EMPTY"],
    [[["0099_first.sql", "SELECT 1;"], ["0099_second.sql", "SELECT 2;"]], "STAGED_MIGRATION_DUPLICATE"],
  ]) {
    const root = await temporaryRoot("malformed");
    for (const [name, sql] of files) await writeMigration(root, "primary", name, sql);
    await assert.rejects(listStagedMigrations("primary", { rootDirectory: root }), { code });
  }
});

test("staged files run with exactly the stock runner's timeouts and search_path, without receipts", async () => {
  const schema = "harness_fake_parity";
  const stockRoot = await fakeStockRoot();
  const stockOnly = fakePool(schema);
  await applyPostgresMigrations({ role: "primary", schema, pool: stockOnly.pool, rootDirectory: stockRoot });
  const stockTransaction = transactionAround(stockOnly.transcript, "CREATE TABLE stock_fixture (id integer);\n");

  const stagedRoot = await temporaryRoot("parity");
  const stagedSql = "CREATE TABLE staged_fixture (id integer);\n";
  await writeMigration(stagedRoot, "primary", "0099_staged_fixture.sql", stagedSql);
  const harness = fakePool(schema);
  const result = await applyStockAndStagedMigrations({
    role: "primary",
    schema,
    pool: harness.pool,
    stagedFiles: ["0099_staged_fixture.sql"],
    rootDirectory: stockRoot,
    stagedRootDirectory: stagedRoot,
  });
  const stagedTransaction = transactionAround(harness.transcript, stagedSql);
  assert.deepEqual(stagedTransaction, [
    "BEGIN",
    `SET LOCAL statement_timeout='${STAGED_MIGRATION_STATEMENT_TIMEOUT_MILLISECONDS}ms'`,
    `SET LOCAL lock_timeout='${STAGED_MIGRATION_LOCK_TIMEOUT_MILLISECONDS}ms'`,
    `SET LOCAL search_path TO "${schema}", pg_catalog`,
    stagedSql,
    "COMMIT",
  ]);
  assert.deepEqual(stagedTransaction.slice(0, 4), stockTransaction.slice(0, 4),
    "BEGIN, statement_timeout, lock_timeout and search_path match the stock runner exactly");
  assert.equal(STAGED_MIGRATION_STATEMENT_TIMEOUT_MILLISECONDS, 30_000);
  assert.equal(STAGED_MIGRATION_LOCK_TIMEOUT_MILLISECONDS, 5_000);
  assert.deepEqual(harness.history.map((row) => row.version), [1, 2], "staged SQL writes no receipt");
  assert.deepEqual(harness.releases, [false, false], "stock run and staged run each release cleanly");
  assert.equal(harness.transcript.filter((text) => text === "CREATE TABLE stock_fixture (id integer);\n").length, 1,
    "the stock DDL runs once; the receipt check never re-applies it");
  const expectedKey = `tibotattle:primary:${schema}`;
  assert.deepEqual(stockOnly.lockKeys, [["lock", expectedKey], ["unlock", expectedKey]]);
  assert.deepEqual(harness.lockKeys, [
    ["lock", expectedKey], ["unlock", expectedKey],
    ["lock", expectedKey], ["unlock", expectedKey],
  ], "the staged phase takes and releases the stock runner's own advisory lock key");
  const snapshots = harness.transcript
    .map((text, index) => (text.includes("extract(epoch FROM applied_at)") ? index : -1))
    .filter((index) => index >= 0);
  assert.equal(snapshots.length, 2, "one receipt snapshot before and one after the staged files");
  for (const index of snapshots) {
    assert.equal(harness.transcript[index - 3], "BEGIN READ ONLY", "each snapshot is a read-only transaction");
  }
  assert.ok(snapshots[0] < harness.transcript.indexOf(stagedSql)
    && harness.transcript.indexOf(stagedSql) < snapshots[1]);
  assert.deepEqual(result, {
    role: "primary",
    schema,
    stockApplied: 2,
    staged: [{ version: 99, name: "0099_staged_fixture.sql", sha256: result.staged[0].sha256 }],
    promoted: [],
  });
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.staged) && Object.isFrozen(result.promoted));
});

test("staged selections are explicit, ordered by version, and refused before any connection", async () => {
  const schema = "harness_fake_selection";
  const stockRoot = await fakeStockRoot();
  const stagedRoot = await temporaryRoot("selection");
  await writeMigration(stagedRoot, "primary", "0099_late.sql", "CREATE TABLE late_fixture (id integer);\n");
  await writeMigration(stagedRoot, "primary", "0061_early.sql", "CREATE TABLE early_fixture (id integer);\n");
  const ordered = fakePool(schema);
  const result = await applyStockAndStagedMigrations({
    role: "primary",
    schema,
    pool: ordered.pool,
    stagedFiles: ["0099_late.sql", "0061_early.sql"],
    rootDirectory: stockRoot,
    stagedRootDirectory: stagedRoot,
  });
  assert.deepEqual(result.staged.map(({ version }) => version), [61, 99]);
  assert.ok(ordered.transcript.indexOf("CREATE TABLE early_fixture (id integer);\n")
    < ordered.transcript.indexOf("CREATE TABLE late_fixture (id integer);\n"));

  const onlyStock = fakePool(schema);
  const promoted = await applyStockAndStagedMigrations({
    role: "primary",
    schema,
    pool: onlyStock.pool,
    stagedFiles: ["0002_stock_fixture.sql"],
    rootDirectory: stockRoot,
    stagedRootDirectory: stagedRoot,
  });
  assert.deepEqual(promoted.promoted, ["0002_stock_fixture.sql"]);
  assert.deepEqual(promoted.staged, []);
  assert.equal(onlyStock.connects(), 1, "a promoted file needs only the stock runner");

  const bothPlaces = await temporaryRoot("both");
  await writeMigration(bothPlaces, "primary", "0002_stock_fixture.sql", "SELECT 2;\n");
  const conflicting = await temporaryRoot("conflict");
  await writeMigration(conflicting, "primary", "0002_other_fixture.sql", "SELECT 2;\n");
  for (const [stagedFiles, directory, code] of [
    [["0100_missing.sql"], stagedRoot, "STAGED_MIGRATION_NOT_FOUND"],
    [["0002_stock_fixture.sql"], bothPlaces, "STAGED_MIGRATION_ALREADY_PROMOTED"],
    [["0002_other_fixture.sql"], conflicting, "STAGED_MIGRATION_VERSION_CONFLICT"],
    [["0099_late.sql", "0099_late.sql"], stagedRoot, "STAGED_MIGRATION_SELECTION_INVALID"],
    [["../0099_late.sql"], stagedRoot, "STAGED_MIGRATION_SELECTION_INVALID"],
    [undefined, stagedRoot, "STAGED_MIGRATION_SELECTION_INVALID"],
    ["0099_late.sql", stagedRoot, "STAGED_MIGRATION_SELECTION_INVALID"],
  ]) {
    const refused = fakePool(schema);
    await assert.rejects(applyStockAndStagedMigrations({
      role: "primary",
      schema,
      pool: refused.pool,
      stagedFiles,
      rootDirectory: stockRoot,
      stagedRootDirectory: directory,
    }), { code });
    assert.equal(refused.connects(), 0, `${code} is decided before PostgreSQL is touched`);
  }
  const unsafe = fakePool(schema);
  await assert.rejects(applyStockAndStagedMigrations({
    role: "primary",
    schema: "Bad-Schema",
    pool: unsafe.pool,
    stagedFiles: [],
    rootDirectory: stockRoot,
    stagedRootDirectory: stagedRoot,
  }), { code: "POSTGRES_SCHEMA_INVALID" });
  await assert.rejects(applyStockAndStagedMigrations({
    role: "primary",
    schema,
    pool: {},
    stagedFiles: [],
    rootDirectory: stockRoot,
    stagedRootDirectory: stagedRoot,
  }), { code: "STAGED_MIGRATION_POOL_INVALID" });
  assert.equal(unsafe.connects(), 0);
});

test("a failing staged file rolls back, discards its connection and names the file", async () => {
  const schema = "harness_fake_failure";
  const stockRoot = await fakeStockRoot();
  const stagedRoot = await temporaryRoot("failure");
  await writeMigration(stagedRoot, "primary", "0099_failing.sql", "SELECT staged_failure_marker;\n");
  const failing = fakePool(schema, { failOn: "staged_failure_marker" });
  await assert.rejects(applyStockAndStagedMigrations({
    role: "primary",
    schema,
    pool: failing.pool,
    stagedFiles: ["0099_failing.sql"],
    rootDirectory: stockRoot,
    stagedRootDirectory: stagedRoot,
  }), (error) => {
    assert.equal(error.code, "STAGED_MIGRATION_APPLY_FAILED");
    assert.equal(error.migration, "0099_failing.sql");
    assert.equal(error.cause?.code, "22012");
    assert.equal(error.message, "STAGED_MIGRATION_APPLY_FAILED");
    return true;
  });
  const failedAt = failing.transcript.indexOf("SELECT staged_failure_marker;\n");
  assert.equal(failing.transcript[failedAt + 1], "ROLLBACK");
  assert.deepEqual(failing.releases, [false, true], "the staged connection is discarded");
});

test("a staged file that deletes or rewrites a stock receipt is refused without re-applying stock DDL", async () => {
  const schema = "harness_fake_receipts";
  const stockRoot = await fakeStockRoot();
  const stagedRoot = await temporaryRoot("receipts");
  await writeMigration(stagedRoot, "primary", "0098_delete_receipt.sql",
    "DELETE FROM _tibotattle_migration_history WHERE version = 2;\n");
  await writeMigration(stagedRoot, "primary", "0099_rewrite_receipt.sql",
    `UPDATE _tibotattle_migration_history SET checksum_sha256 = '${"0".repeat(64)}' WHERE version = 1;\n`);
  for (const stagedFile of ["0098_delete_receipt.sql", "0099_rewrite_receipt.sql"]) {
    const tampering = fakePool(schema);
    await assert.rejects(applyStockAndStagedMigrations({
      role: "primary",
      schema,
      pool: tampering.pool,
      stagedFiles: [stagedFile],
      rootDirectory: stockRoot,
      stagedRootDirectory: stagedRoot,
    }), { code: "STAGED_MIGRATION_STOCK_RECEIPTS_CHANGED" });
    assert.equal(tampering.transcript.filter((text) => text === "CREATE TABLE stock_fixture (id integer);\n").length, 1,
      `${stagedFile}: the stock DDL is not re-run to paper over the change`);
    assert.equal(tampering.connects(), 2, `${stagedFile}: no further runner connection after the staged phase`);
    assert.deepEqual(tampering.releases, [false, true], `${stagedFile}: the staged connection is discarded`);
  }
});

test("postgresTestEndpoint skips without PG_TEST_* and refuses non-local targets", async () => {
  assert.equal(await postgresTestEndpoint({}), null);
  assert.equal(await postgresTestEndpoint({ PG_TEST_PORT: "55433" }), null);
  assert.deepEqual(await postgresTestEndpoint({ PG_TEST_HOST: "127.0.0.1", PG_TEST_PORT: "55433" }),
    { host: "127.0.0.1", port: 55433, user: "postgres", database: "postgres" });
  for (const env of [
    { PG_TEST_HOST: "10.0.0.5" },
    { PG_TEST_HOST: "db.example.test" },
    { PG_TEST_SOCKET: "/tmp/socket" },
    { PG_TEST_SOCKET: "/private/tmp/other-pg/socket" },
    { PG_TEST_SOCKET: "/private/tmp/tibotattle-pg-absent-cluster/socket" },
    { PG_TEST_SOCKET: "/private/tmp/tibotattle-pg-absent-cluster/socket", PG_TEST_HOST: "127.0.0.1" },
    { PG_TEST_SOCKET: "/private/tmp/tibotattle-pg-absent-cluster/socket", PG_TEST_HOST: "10.0.0.5" },
  ]) {
    await assert.rejects(postgresTestEndpoint(env), { code: "POSTGRES_TEST_HOST_INVALID" });
  }
  await assert.rejects(postgresTestEndpoint({ PG_TEST_HOST: "127.0.0.1", PG_TEST_PORT: "0" }),
    { code: "POSTGRES_TEST_PORT_INVALID" });
  await assert.rejects(postgresTestEndpoint({ PG_TEST_HOST: "::1", PG_TEST_PORT: "port" }),
    { code: "POSTGRES_TEST_PORT_INVALID" });
});

/** Every relation name the PG17 cases' synthetic staged files can create. */
const SPEC_RELATION_NAMES = Object.freeze([
  "staged_harness_probe",
  "staged_first",
  "staged_first_pkey",
  "staged_second",
  "staged_tombstone_probe",
  "staged_partial",
  "staged_symlink_target",
  "staged_lock_probe",
  "staged_receipt_probe",
]);

async function publicSpecRelations(pool) {
  const result = await pool.query(
    `SELECT relation.relname::text AS name
       FROM pg_catalog.pg_class relation
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND relation.relname = ANY($1::text[])
      ORDER BY 1`,
    [SPEC_RELATION_NAMES],
  );
  return result.rows.map(({ name }) => name);
}

async function withPostgres(label, callback) {
  // The session search_path is pg_catalog alone, so unqualified DDL that
  // escapes the harness's SET LOCAL search_path fails (system catalog
  // modifications are refused) instead of landing in the shared cluster's
  // public schema, where this spec could not clean it up.
  const pool = new pg.Pool({
    ...ENDPOINT,
    ssl: false,
    max: 4,
    connectionTimeoutMillis: 5_000,
    application_name: `staged-harness-${label}`,
    options: "-c search_path=pg_catalog",
  });
  const created = [];
  try {
    const server = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "the harness is qualified on PostgreSQL 17");
    const sessionPath = await pool.query("SELECT current_setting('search_path') AS search_path");
    assert.equal(sessionPath.rows[0].search_path, "pg_catalog");
    const publicBefore = await publicSpecRelations(pool);
    const createSchema = async (prefix) => {
      const schema = `${prefix}_${randomBytes(5).toString("hex")}`;
      await pool.query(`CREATE SCHEMA "${schema}"`);
      created.push(schema);
      return schema;
    };
    await callback({ pool, createSchema });
    assert.deepEqual(await publicSpecRelations(pool), publicBefore,
      "no staged relation escaped into the public schema");
  } finally {
    for (const schema of created.reverse()) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await pool.end();
  }
}

test("PG17: stock primary plus a staged 0099 file apply into a fresh schema under its search_path", {
  skip: PG_SKIP,
  timeout: 180_000,
}, async () => {
  const stock = await readPostgresMigrations({ role: "primary" });
  const stagedRoot = await temporaryRoot("pg-probe");
  await writeMigration(stagedRoot, "primary", "0099_staged_harness_probe.sql", `
CREATE TABLE staged_harness_probe AS
SELECT current_schema() AS resolved_schema,
       current_setting('search_path') AS search_path,
       current_setting('statement_timeout') AS statement_timeout,
       current_setting('lock_timeout') AS lock_timeout,
       (SELECT count(*)::integer FROM _tibotattle_migration_history) AS stock_receipts,
       (SELECT count(*)::integer FROM participants) AS participants_visible;
`);
  await withPostgres("probe", async ({ pool, createSchema }) => {
    const schema = await createSchema("staged_harness");
    const result = await applyStockAndStagedMigrations({
      role: "primary",
      schema,
      pool,
      stagedFiles: ["0099_staged_harness_probe.sql"],
      stagedRootDirectory: stagedRoot,
    });
    assert.equal(result.stockApplied, stock.length);
    assert.deepEqual(result.staged.map(({ version, name }) => [version, name]),
      [[99, "0099_staged_harness_probe.sql"]]);
    const probe = await pool.query(`SELECT * FROM "${schema}".staged_harness_probe`);
    assert.equal(probe.rowCount, 1);
    const row = probe.rows[0];
    assert.equal(row.resolved_schema, schema);
    assert.match(row.search_path, new RegExp(`^"?${schema}"?, pg_catalog$`, "u"));
    assert.equal(row.statement_timeout, "30s");
    assert.equal(row.lock_timeout, "5s");
    assert.equal(row.stock_receipts, stock.length, "every stock migration ran before the staged file");
    assert.equal(row.participants_visible, 0);
    const location = await pool.query(
      "SELECT to_regclass($1) IS NOT NULL AS in_schema, to_regclass('public.staged_harness_probe') IS NOT NULL AS in_public",
      [`"${schema}".staged_harness_probe`],
    );
    assert.deepEqual(location.rows[0], { in_schema: true, in_public: false });
    const receipts = await pool.query(
      `SELECT count(*)::integer AS count, max(version) AS tail FROM "${schema}"._tibotattle_migration_history`,
    );
    assert.deepEqual(receipts.rows[0], { count: stock.length, tail: stock.length },
      "no receipt is written for a staged file");
    const reverified = await applyPostgresMigrations({ role: "primary", schema, pool });
    assert.equal(reverified.applied, stock.length);
  });
});

test("PG17: staged files apply in version order, fail atomically, and a symlink is refused before any DDL", {
  skip: PG_SKIP,
  timeout: 180_000,
}, async () => {
  const stock = await readPostgresMigrations({ role: "ledger" });
  const orderedRoot = await temporaryRoot("pg-order");
  await writeMigration(orderedRoot, "ledger", "0061_staged_first.sql",
    "CREATE TABLE staged_first (id integer PRIMARY KEY);\n");
  await writeMigration(orderedRoot, "ledger", "0099_staged_second.sql",
    "CREATE TABLE staged_second (id integer REFERENCES staged_first (id));\n"
    + "INSERT INTO staged_second (id) SELECT id FROM staged_first;\n"
    + "CREATE TABLE staged_tombstone_probe AS SELECT count(*)::integer AS tombstones FROM deletion_tombstones;\n");
  const failingRoot = await temporaryRoot("pg-failing");
  await writeMigration(failingRoot, "ledger", "0099_staged_failing.sql",
    "CREATE TABLE staged_partial (id integer);\nSELECT 1 / 0;\n");
  const outside = await temporaryRoot("pg-outside");
  await writeFile(join(outside, "target.sql"), "CREATE TABLE staged_symlink_target (id integer);\n");
  const symlinkRoot = await temporaryRoot("pg-symlink");
  await mkdir(join(symlinkRoot, "ledger"));
  await symlink(join(outside, "target.sql"), join(symlinkRoot, "ledger", "0099_staged_symlink.sql"));

  await withPostgres("ledger", async ({ pool, createSchema }) => {
    const ordered = await createSchema("staged_order");
    const result = await applyStockAndStagedMigrations({
      role: "ledger",
      schema: ordered,
      pool,
      stagedFiles: ["0099_staged_second.sql", "0061_staged_first.sql"],
      stagedRootDirectory: orderedRoot,
    });
    assert.equal(result.stockApplied, stock.length);
    assert.deepEqual(result.staged.map(({ version }) => version), [61, 99]);
    const tombstones = await pool.query(`SELECT tombstones FROM "${ordered}".staged_tombstone_probe`);
    assert.equal(tombstones.rows[0].tombstones, 0);

    const failing = await createSchema("staged_failing");
    await assert.rejects(applyStockAndStagedMigrations({
      role: "ledger",
      schema: failing,
      pool,
      stagedFiles: ["0099_staged_failing.sql"],
      stagedRootDirectory: failingRoot,
    }), (error) => error.code === "STAGED_MIGRATION_APPLY_FAILED"
      && error.migration === "0099_staged_failing.sql"
      && error.cause?.code === "22012");
    const partial = await pool.query("SELECT to_regclass($1) AS relation", [`"${failing}".staged_partial`]);
    assert.equal(partial.rows[0].relation, null, "the failed staged file left nothing behind");
    const intact = await applyPostgresMigrations({ role: "ledger", schema: failing, pool });
    assert.equal(intact.applied, stock.length);

    const refused = await createSchema("staged_symlink");
    await assert.rejects(applyStockAndStagedMigrations({
      role: "ledger",
      schema: refused,
      pool,
      stagedFiles: ["0099_staged_symlink.sql"],
      stagedRootDirectory: symlinkRoot,
    }), { code: "STAGED_MIGRATION_PATH_UNSAFE" });
    const untouched = await pool.query(
      "SELECT count(*)::integer AS count FROM information_schema.tables WHERE table_schema = $1",
      [refused],
    );
    assert.equal(untouched.rows[0].count, 0, "a refused selection leaves the schema empty");
  });
});

test("PG17: the staged phase holds the stock runner's advisory lock and refuses a concurrent holder", {
  skip: PG_SKIP,
  timeout: 180_000,
}, async () => {
  const stagedRoot = await temporaryRoot("pg-lock");
  await writeMigration(stagedRoot, "ledger", "0099_staged_lock_probe.sql",
    "CREATE TABLE staged_lock_probe (id integer);\n");
  await withPostgres("lock", async ({ pool, createSchema }) => {
    const holder = await pool.connect();
    const held = [];
    const take = async (lockKey) => {
      const result = await holder.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired", [lockKey]);
      assert.equal(result.rows[0].acquired, true);
      held.push(lockKey);
    };
    try {
      // A holder of the runner's key blocks the stock phase first.
      const before = await createSchema("staged_lock_before");
      await take(`tibotattle:ledger:${before}`);
      await assert.rejects(applyStockAndStagedMigrations({
        role: "ledger",
        schema: before,
        pool,
        stagedFiles: ["0099_staged_lock_probe.sql"],
        stagedRootDirectory: stagedRoot,
      }), { code: "POSTGRES_MIGRATION_CONFLICT" });

      // The same key taken between the stock and staged phases blocks the
      // staged phase alone: the harness uses the runner's key, not its own.
      const between = await createSchema("staged_lock_between");
      let connects = 0;
      const contended = {
        async connect() {
          connects += 1;
          if (connects === 2) await take(`tibotattle:ledger:${between}`);
          return pool.connect();
        },
      };
      await assert.rejects(applyStockAndStagedMigrations({
        role: "ledger",
        schema: between,
        pool: contended,
        stagedFiles: ["0099_staged_lock_probe.sql"],
        stagedRootDirectory: stagedRoot,
      }), { code: "STAGED_MIGRATION_CONFLICT" });
      assert.equal(connects, 2, "the stock runner and the staged phase each connected once");
      const probe = await pool.query("SELECT to_regclass($1) AS relation", [`"${between}".staged_lock_probe`]);
      assert.equal(probe.rows[0].relation, null, "no staged DDL ran without the lock");
      const stock = await readPostgresMigrations({ role: "ledger" });
      const receipts = await pool.query(
        `SELECT count(*)::integer AS count FROM "${between}"._tibotattle_migration_history`);
      assert.equal(receipts.rows[0].count, stock.length, "the stock phase completed before the refusal");
    } finally {
      for (const lockKey of held) {
        await holder.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
      }
      holder.release();
    }
  });
});

test("PG17: a staged file that changes a stock receipt is refused and stock DDL is not re-run", {
  skip: PG_SKIP,
  timeout: 180_000,
}, async () => {
  const stock = await readPostgresMigrations({ role: "primary" });
  const stagedRoot = await temporaryRoot("pg-receipts");
  await writeMigration(stagedRoot, "primary", "0098_staged_receipt_delete.sql",
    "CREATE TABLE staged_receipt_probe (id integer);\n"
    + "DELETE FROM _tibotattle_migration_history\n"
    + " WHERE version = (SELECT max(version) FROM _tibotattle_migration_history);\n");
  await writeMigration(stagedRoot, "primary", "0099_staged_receipt_touch.sql",
    "UPDATE _tibotattle_migration_history SET applied_at = applied_at + interval '1 second' WHERE version = 1;\n");
  await withPostgres("receipts", async ({ pool, createSchema }) => {
    const deleted = await createSchema("staged_receipt_delete");
    await assert.rejects(applyStockAndStagedMigrations({
      role: "primary",
      schema: deleted,
      pool,
      stagedFiles: ["0098_staged_receipt_delete.sql"],
      stagedRootDirectory: stagedRoot,
    }), { code: "STAGED_MIGRATION_STOCK_RECEIPTS_CHANGED" });
    const remaining = await pool.query(
      `SELECT count(*)::integer AS count, max(version) AS tail FROM "${deleted}"._tibotattle_migration_history`);
    assert.deepEqual(remaining.rows[0], { count: stock.length - 1, tail: stock.length - 1 },
      "the harness neither re-applied the stock tail nor restored its receipt");

    const touched = await createSchema("staged_receipt_touch");
    await assert.rejects(applyStockAndStagedMigrations({
      role: "primary",
      schema: touched,
      pool,
      stagedFiles: ["0099_staged_receipt_touch.sql"],
      stagedRootDirectory: stagedRoot,
    }), { code: "STAGED_MIGRATION_STOCK_RECEIPTS_CHANGED" });
  });
});
