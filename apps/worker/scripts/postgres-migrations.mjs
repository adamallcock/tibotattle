import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ROOT = join(WORKER_ROOT, "postgres", "migrations");
const ROLES = Object.freeze(["primary", "ledger"]);
const FILE_NAME = /^(\d{4})_([a-z][a-z0-9_-]*)\.sql$/u;
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const RESERVED_SCHEMAS = new Set(["pg_catalog", "pg_toast", "information_schema"]);
const HISTORY_TABLE = '"_tibotattle_migration_history"';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function schemaName(value) {
  if (typeof value !== "string" || !SCHEMA_NAME.test(value)
      || RESERVED_SCHEMAS.has(value) || value.startsWith("pg_")) {
    fail("POSTGRES_SCHEMA_INVALID");
  }
  return value;
}

function quoteIdentifier(value) {
  const name = schemaName(value);
  return `"${name}"`;
}

function checksum(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalManifest(value) {
  return JSON.stringify({
    schemaVersion: value.schemaVersion,
    roles: Object.fromEntries(ROLES.map(role => [role, value.roles[role].map(({ version, name, bytes, sha256 }) => ({ version, name, bytes, sha256 }))])),
  });
}

/**
 * Read one role's numbered SQL fragments. This operation is source-only: it
 * never connects to PostgreSQL or applies a migration.
 */
export async function readPostgresMigrations({
  role,
  rootDirectory = DEFAULT_ROOT,
} = {}) {
  if (!ROLES.includes(role)) fail("POSTGRES_MIGRATION_ROLE_INVALID");
  const directory = join(resolve(rootDirectory), role);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    fail("POSTGRES_MIGRATION_DIRECTORY_UNAVAILABLE");
  }
  const selected = entries.filter(entry => entry.name.endsWith(".sql"));
  if (selected.some(entry => !entry.isFile() || entry.isSymbolicLink())) {
    fail("POSTGRES_MIGRATION_PATH_UNSAFE");
  }
  selected.sort((left, right) => left.name.localeCompare(right.name));
  const migrations = [];
  for (const entry of selected) {
    const match = FILE_NAME.exec(entry.name);
    if (!match) fail("POSTGRES_MIGRATION_NAME_INVALID");
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version) || version < 1) fail("POSTGRES_MIGRATION_VERSION_INVALID");
    const path = join(directory, entry.name);
    let stat;
    let sql;
    try {
      stat = await lstat(path);
      sql = await readFile(path, "utf8");
    } catch {
      fail("POSTGRES_MIGRATION_READ_FAILED");
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) {
      fail("POSTGRES_MIGRATION_PATH_UNSAFE");
    }
    if (sql.trim().length === 0) fail("POSTGRES_MIGRATION_EMPTY");
    const prior = migrations.at(-1);
    if (prior !== undefined && prior.version === version) fail("POSTGRES_MIGRATION_DUPLICATE");
    migrations.push(Object.freeze({
      role,
      version,
      name: entry.name,
      bytes: Buffer.byteLength(sql),
      sha256: checksum(sql),
      sql,
    }));
  }
  for (let index = 0; index < migrations.length; index += 1) {
    if (migrations[index].version !== index + 1) fail("POSTGRES_MIGRATION_SEQUENCE_INVALID");
  }
  return Object.freeze(migrations);
}

/** Build a checksum-bound source manifest for both independent schemas. */
export async function buildPostgresMigrationManifest({
  rootDirectory = DEFAULT_ROOT,
} = {}) {
  const roles = Object.fromEntries(await Promise.all(
    ROLES.map(async role => [role, await readPostgresMigrations({ role, rootDirectory })]),
  ));
  const manifest = {
    schemaVersion: "tibotattle-postgres-migration-manifest-v1",
    roles,
  };
  return Object.freeze({
    ...manifest,
    sha256: checksum(canonicalManifest(manifest)),
  });
}

/**
 * Render the per-transaction search-path guard used by the host migration
 * runner. It is deliberately an identifier, never a caller-provided SQL
 * fragment. The caller must still run the returned statement inside BEGIN.
 */
export function renderPostgresSearchPath(schema) {
  return `SET LOCAL search_path TO ${quoteIdentifier(schema)}, pg_catalog`;
}

export function migrationHistoryTable() {
  return HISTORY_TABLE;
}

export const POSTGRES_MIGRATION_ROLES = ROLES;
export const POSTGRES_MIGRATION_ROOT = DEFAULT_ROOT;
