import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ROOT = join(WORKER_ROOT, "postgres", "migrations");
// Primary only (decisions D2, D4 and D6 of 2026-09-26). The frozen ledger
// fragments under postgres/migrations/ledger stay on disk, covered by the
// numbering check, until owner action OA-4 retires them; no runner, manifest,
// build context or image reads them, and role 'ledger' is
// POSTGRES_MIGRATION_ROLE_INVALID.
const ROLES = Object.freeze(["primary"]);
const FILE_NAME = /^(\d{4})_([a-z][a-z0-9_-]*)\.sql$/u;
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const RESERVED_SCHEMAS = new Set(["pg_catalog", "pg_toast", "information_schema"]);
const HISTORY_TABLE = '"_tibotattle_migration_history"';
const MIGRATION_TIMEOUT_MILLISECONDS = 30_000;
const MIGRATION_LOCK_TIMEOUT_MILLISECONDS = 5_000;
const HISTORY_TABLE_NAME = "_tibotattle_migration_history";
const HISTORY_COLUMNS = Object.freeze([
  Object.freeze({ column_name: "version", data_type: "integer", udt_name: "int4", is_nullable: "NO" }),
  Object.freeze({ column_name: "name", data_type: "text", udt_name: "text", is_nullable: "NO" }),
  Object.freeze({ column_name: "checksum_sha256", data_type: "text", udt_name: "text", is_nullable: "NO" }),
  Object.freeze({ column_name: "applied_at", data_type: "timestamp with time zone", udt_name: "timestamptz", is_nullable: "NO" }),
]);

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

/** Build a checksum-bound source manifest of the primary schema. */
export async function buildPostgresMigrationManifest({
  rootDirectory = DEFAULT_ROOT,
} = {}) {
  const roles = Object.fromEntries(await Promise.all(
    ROLES.map(async role => [role, await readPostgresMigrations({ role, rootDirectory })]),
  ));
  const manifest = {
    schemaVersion: "tibotattle-postgres-migration-manifest-v2",
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

function migrationFailure(code) {
  fail(code);
}

function isMigrationFailure(error) {
  return error !== null
    && typeof error === "object"
    && typeof Reflect.get(error, "code") === "string"
    && Reflect.get(error, "code").startsWith("POSTGRES_MIGRATION");
}

async function migrationQuery(client, text, values, failureCode) {
  try {
    return await client.query(text, values);
  } catch {
    migrationFailure(failureCode);
  }
}

function resultRows(result, code) {
  if (result === null || typeof result !== "object"
      || !Array.isArray(result.rows)
      || result.rowCount !== null && result.rowCount !== result.rows.length) {
    migrationFailure(code);
  }
  return result.rows;
}

function historyRows(rows, migrations) {
  if (rows.length > migrations.length) migrationFailure("POSTGRES_MIGRATION_VERSION_UNKNOWN");
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const expected = migrations[index];
    if (row === null || typeof row !== "object" || expected === undefined
        || !Number.isSafeInteger(row.version)
        || row.version < 1
        || row.version > migrations.length
        || row.version !== index + 1) {
      migrationFailure("POSTGRES_MIGRATION_VERSION_UNKNOWN");
    }
    if (row.name !== expected.name || row.checksum_sha256 !== expected.sha256) {
      migrationFailure("POSTGRES_MIGRATION_CHECKSUM_DRIFT");
    }
  }
  return rows.length;
}

async function releaseMigrationClient(client, discard, state) {
  if (state.released) return;
  state.released = true;
  try {
    await client.release(discard);
  } catch {
    migrationFailure("POSTGRES_MIGRATION_RELEASE_FAILED");
  }
}

function validateHistoryTable(columns, constraints) {
  if (columns.length !== HISTORY_COLUMNS.length
      || columns.some((column, index) => {
        const expected = HISTORY_COLUMNS[index];
        return column === null || typeof column !== "object"
          || expected === undefined
          || column.column_name !== expected.column_name
          || column.data_type !== expected.data_type
          || column.udt_name !== expected.udt_name
          || column.is_nullable !== expected.is_nullable;
      })) {
    migrationFailure("POSTGRES_MIGRATION_HISTORY_SCHEMA_INVALID");
  }
  const hasVersionPrimaryKey = constraints.some((constraint) => {
    if (constraint === null || typeof constraint !== "object") return false;
    const definition = constraint.definition;
    return typeof definition === "string"
      && definition.replaceAll(/\s+/gu, " ").trim() === "PRIMARY KEY (version)";
  });
  if (!hasVersionPrimaryKey) migrationFailure("POSTGRES_MIGRATION_HISTORY_SCHEMA_INVALID");
}

/**
 * Read migration receipts through a bounded read transaction. The metadata
 * table is itself part of the migration contract: an existing table with a
 * legacy shape, or an existing schema with no receipts, fails closed before
 * CREATE TABLE IF NOT EXISTS can certify unrelated state.
 */
async function readMigrationHistory(
  client,
  schema,
  statementTimeoutMilliseconds,
  lockTimeoutMilliseconds,
) {
  let transactionStarted = false;
  let commitAttempted = false;
  try {
    await migrationQuery(client, "BEGIN", undefined, "POSTGRES_MIGRATION_HISTORY_READ_FAILED");
    transactionStarted = true;
    await migrationQuery(
      client,
      `SET LOCAL statement_timeout='${statementTimeoutMilliseconds}ms'`,
      undefined,
      "POSTGRES_MIGRATION_HISTORY_READ_FAILED",
    );
    await migrationQuery(
      client,
      `SET LOCAL lock_timeout='${lockTimeoutMilliseconds}ms'`,
      undefined,
      "POSTGRES_MIGRATION_HISTORY_READ_FAILED",
    );
    await migrationQuery(
      client,
      renderPostgresSearchPath(schema),
      undefined,
      "POSTGRES_MIGRATION_HISTORY_READ_FAILED",
    );
    const namespace = resultRows(await migrationQuery(
      client,
      "SELECT to_regnamespace($1) AS namespace, to_regclass($2) AS history_table",
      [schema, `${schema}.${HISTORY_TABLE_NAME}`],
      "POSTGRES_MIGRATION_HISTORY_READ_FAILED",
    ), "POSTGRES_MIGRATION_HISTORY_READ_FAILED")[0];
    if (namespace?.namespace === null || namespace?.namespace === undefined) {
      migrationFailure("POSTGRES_SCHEMA_UNAVAILABLE");
    }
    const historyTablePresent = namespace.history_table !== null
      && namespace.history_table !== undefined;
    if (historyTablePresent) {
      const columns = resultRows(await migrationQuery(
        client,
        `SELECT column_name, data_type, udt_name, is_nullable
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position`,
        [schema, HISTORY_TABLE_NAME],
        "POSTGRES_MIGRATION_HISTORY_READ_FAILED",
      ), "POSTGRES_MIGRATION_HISTORY_READ_FAILED");
      const constraints = resultRows(await migrationQuery(
        client,
        `SELECT pg_get_constraintdef(c.oid) AS definition
           FROM pg_constraint c
           JOIN pg_class rel ON rel.oid = c.conrelid
           JOIN pg_namespace ns ON ns.oid = rel.relnamespace
          WHERE ns.nspname = $1 AND rel.relname = $2 AND c.contype = 'p'`,
        [schema, HISTORY_TABLE_NAME],
        "POSTGRES_MIGRATION_HISTORY_READ_FAILED",
      ), "POSTGRES_MIGRATION_HISTORY_READ_FAILED");
      validateHistoryTable(columns, constraints);
    }
    const userTables = resultRows(await migrationQuery(
      client,
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE'
          AND table_name <> $2
        ORDER BY table_name`,
      [schema, HISTORY_TABLE_NAME],
      "POSTGRES_MIGRATION_HISTORY_READ_FAILED",
    ), "POSTGRES_MIGRATION_HISTORY_READ_FAILED");
    if (!historyTablePresent) {
      if (userTables.length > 0) migrationFailure("POSTGRES_MIGRATION_UNRECORDED_SCHEMA");
      commitAttempted = true;
      await migrationQuery(client, "COMMIT", undefined, "POSTGRES_MIGRATION_HISTORY_RESULT_UNCERTAIN");
      return [];
    }
    const history = resultRows(await migrationQuery(
      client,
      `SELECT version, name, checksum_sha256 FROM ${quoteIdentifier(schema)}.${HISTORY_TABLE}
        ORDER BY version`,
      undefined,
      "POSTGRES_MIGRATION_HISTORY_READ_FAILED",
    ), "POSTGRES_MIGRATION_HISTORY_READ_FAILED");
    if (history.length === 0 && userTables.length > 0) {
      migrationFailure("POSTGRES_MIGRATION_UNRECORDED_SCHEMA");
    }
    commitAttempted = true;
    await migrationQuery(client, "COMMIT", undefined, "POSTGRES_MIGRATION_HISTORY_RESULT_UNCERTAIN");
    return history;
  } catch (error) {
    if (transactionStarted && !commitAttempted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        migrationFailure("POSTGRES_MIGRATION_ROLLBACK_FAILED");
      }
    }
    if (isMigrationFailure(error)) throw error;
    migrationFailure(commitAttempted
      ? "POSTGRES_MIGRATION_HISTORY_RESULT_UNCERTAIN"
      : "POSTGRES_MIGRATION_HISTORY_READ_FAILED");
  }
}

/**
 * Apply one role's immutable, numbered fragments to a validated schema.
 *
 * The runner is intentionally host-side: it reads SQL files and receives a
 * structural pool, so the Worker bundle does not acquire a Node PostgreSQL
 * dependency. Each DDL fragment and its checksum receipt share one bounded
 * transaction. A failed or uncertain commit discards the connection and is
 * never retried automatically.
 */
export async function applyPostgresMigrations({
  role,
  schema,
  pool,
  rootDirectory = DEFAULT_ROOT,
  statementTimeoutMilliseconds = MIGRATION_TIMEOUT_MILLISECONDS,
  lockTimeoutMilliseconds = MIGRATION_LOCK_TIMEOUT_MILLISECONDS,
} = {}) {
  if (!ROLES.includes(role)) migrationFailure("POSTGRES_MIGRATION_ROLE_INVALID");
  schemaName(schema);
  if (pool === null || typeof pool !== "object" || typeof pool.connect !== "function") {
    migrationFailure("POSTGRES_MIGRATION_POOL_INVALID");
  }
  if (!Number.isSafeInteger(statementTimeoutMilliseconds)
      || statementTimeoutMilliseconds < 1 || statementTimeoutMilliseconds > 600_000
      || !Number.isSafeInteger(lockTimeoutMilliseconds)
      || lockTimeoutMilliseconds < 1 || lockTimeoutMilliseconds > 600_000) {
    migrationFailure("POSTGRES_MIGRATION_TIMEOUT_INVALID");
  }
  const migrations = await readPostgresMigrations({ role, rootDirectory });
  let client;
  try {
    client = await pool.connect();
  } catch {
    migrationFailure("POSTGRES_MIGRATION_CONNECT_FAILED");
  }
  const releaseState = { released: false };
  const lockKey = `tibotattle:${role}:${schema}`;
  let advisoryLockHeld = false;
  let history;
  try {
    const lock = resultRows(await migrationQuery(
      client,
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [lockKey],
      "POSTGRES_MIGRATION_LOCK_FAILED",
    ), "POSTGRES_MIGRATION_LOCK_FAILED")[0];
    if (lock?.acquired !== true) migrationFailure("POSTGRES_MIGRATION_CONFLICT");
    advisoryLockHeld = true;
    history = await readMigrationHistory(
      client,
      schema,
      statementTimeoutMilliseconds,
      lockTimeoutMilliseconds,
    );
    let applied = historyRows(history, migrations);
    for (let index = applied; index < migrations.length; index += 1) {
      const migration = migrations[index];
      let transactionStarted = false;
      let commitAttempted = false;
      try {
        await migrationQuery(client, "BEGIN", undefined, "POSTGRES_MIGRATION_APPLY_FAILED");
        transactionStarted = true;
        await migrationQuery(
          client,
          `SET LOCAL statement_timeout='${statementTimeoutMilliseconds}ms'`,
          undefined,
          "POSTGRES_MIGRATION_APPLY_FAILED",
        );
        await migrationQuery(
          client,
          `SET LOCAL lock_timeout='${lockTimeoutMilliseconds}ms'`,
          undefined,
          "POSTGRES_MIGRATION_APPLY_FAILED",
        );
        await migrationQuery(
          client,
          renderPostgresSearchPath(schema),
          undefined,
          "POSTGRES_MIGRATION_APPLY_FAILED",
        );
        await migrationQuery(client, migration.sql, undefined, "POSTGRES_MIGRATION_APPLY_FAILED");
        await migrationQuery(
          client,
          `INSERT INTO ${quoteIdentifier(schema)}.${HISTORY_TABLE}
             (version, name, checksum_sha256) VALUES ($1, $2, $3)`,
          [migration.version, migration.name, migration.sha256],
          "POSTGRES_MIGRATION_APPLY_FAILED",
        );
        commitAttempted = true;
        await migrationQuery(client, "COMMIT", undefined, "POSTGRES_MIGRATION_RESULT_UNCERTAIN");
      } catch (error) {
        if (transactionStarted && !commitAttempted) {
          try {
            await client.query("ROLLBACK");
          } catch {
            await releaseMigrationClient(client, true, releaseState);
            migrationFailure("POSTGRES_MIGRATION_ROLLBACK_FAILED");
          }
        }
        await releaseMigrationClient(client, true, releaseState);
        if (isMigrationFailure(error)) throw error;
        migrationFailure(commitAttempted
          ? "POSTGRES_MIGRATION_RESULT_UNCERTAIN"
          : "POSTGRES_MIGRATION_APPLY_FAILED");
      }
      applied += 1;
    }
    history = await readMigrationHistory(
      client,
      schema,
      statementTimeoutMilliseconds,
      lockTimeoutMilliseconds,
    );
    applied = historyRows(history, migrations);
    const unlocked = resultRows(await migrationQuery(
      client,
      "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released",
      [lockKey],
      "POSTGRES_MIGRATION_UNLOCK_FAILED",
    ), "POSTGRES_MIGRATION_UNLOCK_FAILED")[0];
    if (unlocked?.released !== true) migrationFailure("POSTGRES_MIGRATION_UNLOCK_FAILED");
    advisoryLockHeld = false;
    await releaseMigrationClient(client, false, releaseState);
    return Object.freeze({ role, schema, applied, migrations: Object.freeze([...migrations]) });
  } catch (error) {
    if (!releaseState.released) {
      await releaseMigrationClient(client, true, releaseState);
    }
    if (isMigrationFailure(error)) throw error;
    migrationFailure(advisoryLockHeld
      ? "POSTGRES_MIGRATION_RUN_FAILED"
      : "POSTGRES_MIGRATION_LOCK_FAILED");
  }
}

export function migrationHistoryTable() {
  return HISTORY_TABLE;
}

export const POSTGRES_MIGRATION_ROLES = ROLES;
export const POSTGRES_MIGRATION_ROOT = DEFAULT_ROOT;
