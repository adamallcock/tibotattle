/**
 * Test-only helper for specs that qualify one promoted PostgreSQL migration
 * against the state it meets (claude/gcp-fastpath-base promotion).
 *
 * Wave-1 specs applied the stock chain and then their staged file, so they
 * could shape pre-migration rows and prove what the file refuses or rewrites.
 * Once the integrator promoted those files unchanged into
 * postgres/migrations/<role>/, the stock chain contains the file under test
 * and everything after it. applyMigrationsBefore applies only the promoted
 * migrations strictly below one version, through the production runner
 * (recorded receipts, runner timeouts, advisory lock and per-transaction
 * search_path), from a private temporary copy of those exact bytes. The spec
 * then applies the promoted file itself, exactly as it applied the staged one.
 *
 * The named migration must be part of the promoted chain at that version, so
 * a renumbered, renamed or missing file fails loudly instead of qualifying a
 * different chain. Test-only: this module lives outside the Cloud Run build
 * context and must never be imported by product code.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyPostgresMigrations,
  readPostgresMigrations,
} from "../cloud-run/postgres-migrations.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Canonical promoted migration root, as the runner reads it by default. */
export const PROMOTED_MIGRATIONS_ROOT = join(WORKER_ROOT, "postgres", "migrations");

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

/** Absolute path of one promoted migration file. */
export function promotedMigrationPath(role, name) {
  return join(PROMOTED_MIGRATIONS_ROOT, role, name);
}

/**
 * Apply every promoted `role` migration whose version is below the named
 * migration's version, and return the runner result with the prefix and the
 * named migration. Only the temporary copy is removed afterwards.
 */
export async function applyMigrationsBefore({ role, schema, pool, name }) {
  const promoted = await readPostgresMigrations({ role });
  const target = promoted.find((migration) => migration.name === name);
  if (target === undefined) fail("PROMOTED_MIGRATION_NOT_FOUND");
  const prefix = promoted.filter((migration) => migration.version < target.version);
  if (prefix.length !== target.version - 1) fail("PROMOTED_MIGRATION_PREFIX_INVALID");
  const root = await mkdtemp(join(tmpdir(), "tibotattle-promoted-prefix-"));
  try {
    await mkdir(join(root, role), { mode: 0o700 });
    for (const migration of prefix) {
      await writeFile(join(root, role, migration.name), migration.sql, { flag: "wx", mode: 0o600 });
    }
    const result = await applyPostgresMigrations({ role, schema, pool, rootDirectory: root });
    if (result.applied !== prefix.length) fail("PROMOTED_MIGRATION_PREFIX_NOT_APPLIED");
    return Object.freeze({ ...result, prefix: Object.freeze([...prefix]), target });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
