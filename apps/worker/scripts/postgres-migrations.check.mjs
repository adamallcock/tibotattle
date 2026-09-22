import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPostgresMigrationManifest,
  migrationHistoryTable,
  readPostgresMigrations,
  renderPostgresSearchPath,
} from "./postgres-migrations.mjs";

test("loads contiguous primary and independent ledger migration manifests", async () => {
  const manifest = await buildPostgresMigrationManifest();
  assert.equal(manifest.schemaVersion, "tibotattle-postgres-migration-manifest-v1");
  assert.deepEqual(Object.keys(manifest.roles).sort(), ["ledger", "primary"]);
  for (const role of ["primary", "ledger"]) {
    assert.equal(manifest.roles[role].length, 1);
    assert.equal(manifest.roles[role][0].version, 1);
    assert.match(manifest.roles[role][0].sha256, /^[0-9a-f]{64}$/u);
  }
  assert.match(manifest.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(migrationHistoryTable(), '"_tibotattle_migration_history"');
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
