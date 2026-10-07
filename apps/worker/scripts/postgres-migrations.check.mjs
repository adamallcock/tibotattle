import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPostgresMigrationManifest,
  applyPostgresMigrations,
  migrationHistoryTable,
  POSTGRES_MIGRATION_ROLES,
  readPostgresMigrations,
  renderPostgresSearchPath,
} from "./postgres-migrations.mjs";

test("loads a contiguous primary-only migration manifest", async () => {
  const manifest = await buildPostgresMigrationManifest();
  const expectedPrimary = await readPostgresMigrations({ role: "primary" });
  assert.equal(manifest.schemaVersion, "tibotattle-postgres-migration-manifest-v2");
  assert.deepEqual(Object.keys(manifest.roles), ["primary"]);
  assert.deepEqual(POSTGRES_MIGRATION_ROLES, ["primary"]);
  assert.deepEqual(
    manifest.roles.primary.map(({ version, name }) => [version, name]),
    expectedPrimary.map(({ version, name }) => [version, name]),
  );
  assert.equal(manifest.roles.primary.at(-1).name, "0075_github_distribution_manifest_visibility.sql");
  for (const migration of manifest.roles.primary) {
    assert.match(migration.sha256, /^[0-9a-f]{64}$/u);
  }
  assert.match(manifest.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(migrationHistoryTable(), '"_tibotattle_migration_history"');
});

test("the retired ledger role is refused before any file or database read", async () => {
  await assert.rejects(
    readPostgresMigrations({ role: "ledger" }),
    error => error.code === "POSTGRES_MIGRATION_ROLE_INVALID",
  );
  let connected = false;
  const pool = { async connect() { connected = true; throw new Error("must not connect"); } };
  await assert.rejects(
    applyPostgresMigrations({ role: "ledger", schema: "tibotattle_ledger", pool }),
    error => error.code === "POSTGRES_MIGRATION_ROLE_INVALID",
  );
  assert.equal(connected, false);
  // A root that still carries a ledger directory builds a primary-only manifest.
  const root = await mkdtemp(join(tmpdir(), "tibotattle-postgres-migrations-ledger-"));
  await mkdir(join(root, "primary"));
  await mkdir(join(root, "ledger"));
  await writeFile(join(root, "primary", "0001_ok.sql"), "SELECT 1;\n");
  await writeFile(join(root, "ledger", "0001_ok.sql"), "SELECT 1;\n");
  const manifest = await buildPostgresMigrationManifest({ rootDirectory: root });
  assert.deepEqual(Object.keys(manifest.roles), ["primary"]);
});

test("renders only validated schema identifiers", () => {
  assert.equal(
    renderPostgresSearchPath("tibotattle_test_primary"),
    'SET LOCAL search_path TO "tibotattle_test_primary", pg_catalog',
  );
  for (const value of ["pg_catalog", "information_schema", "pg_temp_3", "tibotattle;DROP"]) {
    assert.throws(() => renderPostgresSearchPath(value), /POSTGRES_SCHEMA_INVALID/);
  }
});

test("rejects a migration gap before any application step", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-postgres-migrations-"));
  await mkdir(join(root, "primary"));
  await mkdir(join(root, "ledger"));
  await writeFile(join(root, "primary", "0002_gap.sql"), "SELECT 1;\n");
  await writeFile(join(root, "ledger", "0001_ok.sql"), "SELECT 1;\n");
  await assert.rejects(
    readPostgresMigrations({ role: "primary", rootDirectory: root }),
    /POSTGRES_MIGRATION_SEQUENCE_INVALID/,
  );
});

test("rejects unknown role and malformed file names without exposing paths", async () => {
  await assert.rejects(
    readPostgresMigrations({ role: "other" }),
    error => error.code === "POSTGRES_MIGRATION_ROLE_INVALID" && !error.message.includes("postgres/"),
  );
});

function fakeMigrationPool({
  history = [],
  historyTable = history.length > 0,
  failSql = null,
  metadataValid = true,
  userTables = [],
  lockAvailable = true,
  pauseSql = null,
} = {}) {
  const state = {
    history: history.map((row) => ({ ...row })),
    historyTable,
    metadataValid,
    userTables: [...userTables],
    lockAvailable,
    lockHeld: false,
    calls: [],
    releases: [],
    pending: null,
    entered: null,
    resume: null,
  };
  const entered = pauseSql === null ? null : new Promise((resolve) => { state.entered = resolve; });
  const resume = pauseSql === null ? null : new Promise((resolve) => { state.resume = resolve; });
  state.enteredPromise = entered;
  state.resumePromise = resume;
  const pool = {
    async connect() {
      return {
        async query(text, values = []) {
          state.calls.push({ text, values });
          if (text.startsWith("SELECT pg_try_advisory_lock")) {
            if (!state.lockAvailable || state.lockHeld) return { rows: [{ acquired: false }], rowCount: 1 };
            state.lockHeld = true;
            return { rows: [{ acquired: true }], rowCount: 1 };
          }
          if (text.startsWith("SELECT pg_advisory_unlock")) {
            const released = state.lockHeld;
            state.lockHeld = false;
            return { rows: [{ released }], rowCount: 1 };
          }
          if (text.startsWith("SELECT to_regnamespace")) {
            return { rows: [{ namespace: "tibotattle", history_table: state.historyTable ? "tibotattle._tibotattle_migration_history" : null }], rowCount: 1 };
          }
          if (text.startsWith("SELECT column_name, data_type")) {
            return {
              rows: state.metadataValid
                ? [
                  { column_name: "version", data_type: "integer", udt_name: "int4", is_nullable: "NO" },
                  { column_name: "name", data_type: "text", udt_name: "text", is_nullable: "NO" },
                  { column_name: "checksum_sha256", data_type: "text", udt_name: "text", is_nullable: "NO" },
                  { column_name: "applied_at", data_type: "timestamp with time zone", udt_name: "timestamptz", is_nullable: "NO" },
                ]
                : [{ column_name: "version", data_type: "text", udt_name: "text", is_nullable: "YES" }],
              rowCount: state.metadataValid ? 4 : 1,
            };
          }
          if (text.startsWith("SELECT pg_get_constraintdef")) {
            return { rows: state.metadataValid ? [{ definition: "PRIMARY KEY (version)" }] : [], rowCount: state.metadataValid ? 1 : 0 };
          }
          if (text.startsWith("SELECT table_name")) {
            return { rows: state.userTables.map((table_name) => ({ table_name })), rowCount: state.userTables.length };
          }
          if (text.startsWith("SELECT version, name, checksum_sha256")) {
            return { rows: state.history.map((row) => ({ ...row })), rowCount: state.history.length };
          }
          if (text === "BEGIN") {
            state.pending = { history: state.history.map((row) => ({ ...row })), historyTable: state.historyTable };
            return { rows: [], rowCount: null };
          }
          if (text === "ROLLBACK") {
            state.pending = null;
            return { rows: [], rowCount: null };
          }
          if (text === "COMMIT") {
            state.history = state.pending.history;
            state.historyTable = state.pending.historyTable;
            state.pending = null;
            return { rows: [], rowCount: null };
          }
          if (failSql !== null && text.includes(failSql)) throw new Error("provider detail must stay private");
          if (pauseSql !== null && text.includes(pauseSql)) {
            state.entered?.();
            await state.resumePromise;
          }
          if (text.startsWith("CREATE TABLE")) state.pending.historyTable = true;
          if (text.startsWith("INSERT INTO") && text.includes("_tibotattle_migration_history")) {
            state.pending.history.push({ version: values[0], name: values[1], checksum_sha256: values[2] });
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: null };
        },
        async release(discard = false) {
          state.releases.push(discard);
        },
      };
    },
  };
  return { pool, state };
}

test("applies each fragment with a checksum receipt and is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-postgres-migration-runner-"));
  await mkdir(join(root, "primary"));
  await writeFile(join(root, "primary", "0001_bootstrap.sql"), `CREATE TABLE _tibotattle_migration_history (
    version integer PRIMARY KEY CHECK (version > 0),
    name text NOT NULL,
    checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );\n`);
  await writeFile(join(root, "primary", "0002_feature.sql"), "CREATE TABLE feature_rows (id integer PRIMARY KEY);\n");
  const fixture = fakeMigrationPool();
  const first = await applyPostgresMigrations({
    role: "primary",
    schema: "tibotattle",
    pool: fixture.pool,
    rootDirectory: root,
  });
  assert.equal(first.applied, 2);
  assert.equal(fixture.state.history.length, 2);
  assert.deepEqual(fixture.state.releases, [false]);
  const callCount = fixture.state.calls.length;
  const second = await applyPostgresMigrations({
    role: "primary",
    schema: "tibotattle",
    pool: fixture.pool,
    rootDirectory: root,
  });
  assert.equal(second.applied, 2);
  assert.equal(fixture.state.calls.filter(({ text }) => text === "BEGIN").length, 6);
  assert.equal(fixture.state.calls.length > callCount, true);
  assert.deepEqual(fixture.state.releases, [false, false]);
});

test("refuses checksum drift before applying a migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-postgres-migration-drift-"));
  await mkdir(join(root, "primary"));
  await writeFile(join(root, "primary", "0001_bootstrap.sql"), "CREATE TABLE feature_rows (id integer PRIMARY KEY);\n");
  const fixture = fakeMigrationPool({ history: [{ version: 1, name: "0001_bootstrap.sql", checksum_sha256: "0".repeat(64) }] });
  await assert.rejects(
    applyPostgresMigrations({ role: "primary", schema: "tibotattle", pool: fixture.pool, rootDirectory: root }),
    (error) => error.code === "POSTGRES_MIGRATION_CHECKSUM_DRIFT",
  );
  assert.equal(fixture.state.calls.filter(({ text }) => text === "BEGIN").length, 1);
  assert.deepEqual(fixture.state.releases, [true]);
});

test("refuses a migration lock held by a concurrent invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-postgres-migration-lock-"));
  await mkdir(join(root, "primary"));
  await writeFile(join(root, "primary", "0001_bootstrap.sql"), "CREATE TABLE feature_rows (id integer PRIMARY KEY);\n");
  const fixture = fakeMigrationPool({ pauseSql: "CREATE TABLE feature_rows" });
  const first = applyPostgresMigrations({ role: "primary", schema: "tibotattle", pool: fixture.pool, rootDirectory: root });
  await fixture.state.enteredPromise;
  await assert.rejects(
    applyPostgresMigrations({ role: "primary", schema: "tibotattle", pool: fixture.pool, rootDirectory: root }),
    (error) => error.code === "POSTGRES_MIGRATION_CONFLICT",
  );
  fixture.state.resume?.();
  assert.equal((await first).applied, 1);
  assert.equal(fixture.state.releases.filter(Boolean).length, 1);
});

test("rejects an unknown preexisting migration version", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-postgres-migration-version-"));
  await mkdir(join(root, "primary"));
  await writeFile(join(root, "primary", "0001_bootstrap.sql"), "SELECT 1;\n");
  const fixture = fakeMigrationPool({
    history: [{ version: 99, name: "unknown.sql", checksum_sha256: "0".repeat(64) }],
  });
  await assert.rejects(
    applyPostgresMigrations({ role: "primary", schema: "tibotattle", pool: fixture.pool, rootDirectory: root }),
    (error) => error.code === "POSTGRES_MIGRATION_VERSION_UNKNOWN",
  );
  assert.deepEqual(fixture.state.releases, [true]);
});

test("rejects incompatible legacy metadata and unrecorded schema state", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-postgres-migration-legacy-"));
  await mkdir(join(root, "primary"));
  await writeFile(join(root, "primary", "0001_bootstrap.sql"), "SELECT 1;\n");
  const incompatible = fakeMigrationPool({ historyTable: true, metadataValid: false });
  await assert.rejects(
    applyPostgresMigrations({ role: "primary", schema: "tibotattle", pool: incompatible.pool, rootDirectory: root }),
    (error) => error.code === "POSTGRES_MIGRATION_HISTORY_SCHEMA_INVALID",
  );
  const unrecorded = fakeMigrationPool({ historyTable: false, userTables: ["legacy_feature"] });
  await assert.rejects(
    applyPostgresMigrations({ role: "primary", schema: "tibotattle", pool: unrecorded.pool, rootDirectory: root }),
    (error) => error.code === "POSTGRES_MIGRATION_UNRECORDED_SCHEMA",
  );
});

test("rolls back a failed fragment and discards the client", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-postgres-migration-failure-"));
  await mkdir(join(root, "primary"));
  await writeFile(join(root, "primary", "0001_bootstrap.sql"), `CREATE TABLE _tibotattle_migration_history (
    version integer PRIMARY KEY CHECK (version > 0),
    name text NOT NULL,
    checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );\n`);
  await writeFile(join(root, "primary", "0002_broken.sql"), "SELECT broken_migration;\n");
  const fixture = fakeMigrationPool({ failSql: "broken_migration" });
  await assert.rejects(
    applyPostgresMigrations({ role: "primary", schema: "tibotattle", pool: fixture.pool, rootDirectory: root }),
    (error) => error.code === "POSTGRES_MIGRATION_APPLY_FAILED",
  );
  assert.equal(fixture.state.history.length, 1);
  assert.deepEqual(fixture.state.releases, [true]);
  assert.equal(fixture.state.calls.filter(({ text }) => text === "ROLLBACK").length, 1);
});
