/**
 * Test harness for staged PostgreSQL migrations (FC-10).
 *
 * Work items stage new DDL in
 * apps/worker/postgres/staged-migrations/<role>/<NNNN>_<name>.sql with a
 * plan-assigned number; the integrator later promotes each file into
 * postgres/migrations/<role>/. Until then a PG17 spec applies the stock
 * migrations through the production runner and the staged files through this
 * harness, each in one bounded transaction with the runner's statement and
 * lock timeouts and its per-transaction search_path, under the runner's
 * advisory lock. Staged SQL is not recorded in the migration history, and a
 * read-only before/after snapshot refuses any staged file that changes the
 * stock receipts, so they stay exactly what the runtime storage gates
 * expect. A spec names the staged files it needs;
 * once a named file has been promoted unchanged, it is already part of the
 * stock set and is skipped, so specs survive promotion without edits.
 *
 * Test-only: this module lives outside the Cloud Run build context and must
 * never be imported by product code.
 */

import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  POSTGRES_MIGRATION_ROLES,
  applyPostgresMigrations,
  migrationHistoryTable,
  readPostgresMigrations,
  renderPostgresSearchPath,
} from "../cloud-run/postgres-migrations.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILE_NAME = /^(\d{4})_([a-z][a-z0-9_-]*)\.sql$/u;
const MAX_MIGRATION_BYTES = 8 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const PRIVATE_SOCKET_DIRECTORY = /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u;

/** Canonical staged-migration root (FC-10). */
export const STAGED_MIGRATIONS_ROOT = join(WORKER_ROOT, "postgres", "staged-migrations");
/** Equal to cloud-run/postgres-migrations.mjs MIGRATION_TIMEOUT_MILLISECONDS; the spec pins it. */
export const STAGED_MIGRATION_STATEMENT_TIMEOUT_MILLISECONDS = 30_000;
/** Equal to cloud-run/postgres-migrations.mjs MIGRATION_LOCK_TIMEOUT_MILLISECONDS; the spec pins it. */
export const STAGED_MIGRATION_LOCK_TIMEOUT_MILLISECONDS = 5_000;

function fail(code, extra = {}) {
  throw Object.assign(new Error(code), { code, ...extra });
}

function assertRole(role) {
  if (!POSTGRES_MIGRATION_ROLES.includes(role)) fail("STAGED_MIGRATION_ROLE_INVALID");
}

function checksum(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * List one role's staged SQL files in ascending version order. A missing
 * role directory is an empty list. Symbolic links, hard links, non-regular
 * files, malformed names, duplicate versions and empty or oversized files are
 * refused, exactly as readPostgresMigrations refuses them for stock files.
 * Staged numbers need not be contiguous.
 */
export async function listStagedMigrations(role, {
  rootDirectory = STAGED_MIGRATIONS_ROOT,
} = {}) {
  assertRole(role);
  const directory = join(resolve(rootDirectory), role);
  let directoryStat;
  try {
    directoryStat = await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze([]);
    fail("STAGED_MIGRATION_DIRECTORY_UNAVAILABLE");
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    fail("STAGED_MIGRATION_PATH_UNSAFE");
  }
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    fail("STAGED_MIGRATION_DIRECTORY_UNAVAILABLE");
  }
  const selected = entries.filter((entry) => entry.name.endsWith(".sql"));
  if (selected.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    fail("STAGED_MIGRATION_PATH_UNSAFE");
  }
  const migrations = [];
  for (const entry of selected) {
    const match = FILE_NAME.exec(entry.name);
    if (!match) fail("STAGED_MIGRATION_NAME_INVALID");
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version) || version < 1) fail("STAGED_MIGRATION_VERSION_INVALID");
    const path = join(directory, entry.name);
    let fileStat;
    let sql;
    try {
      fileStat = await lstat(path);
      sql = await readFile(path, "utf8");
    } catch {
      fail("STAGED_MIGRATION_READ_FAILED");
    }
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1
        || fileStat.size > MAX_MIGRATION_BYTES) {
      fail("STAGED_MIGRATION_PATH_UNSAFE");
    }
    if (sql.trim().length === 0) fail("STAGED_MIGRATION_EMPTY");
    migrations.push(Object.freeze({
      role,
      version,
      name: entry.name,
      bytes: Buffer.byteLength(sql),
      sha256: checksum(sql),
      sql,
    }));
  }
  migrations.sort((left, right) => left.version - right.version
    || left.name.localeCompare(right.name));
  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index - 1].version === migrations[index].version) {
      fail("STAGED_MIGRATION_DUPLICATE");
    }
  }
  return Object.freeze(migrations);
}

/**
 * Resolve a spec's named staged files against the staged listing and the
 * stock set without touching PostgreSQL. A name already present in the
 * stock set was promoted and is skipped; the same name in both places, or a
 * staged version that collides with a stock version, is refused.
 */
async function resolveStagedSelection({ role, stagedFiles, rootDirectory, stagedRootDirectory }) {
  if (!Array.isArray(stagedFiles)
      || stagedFiles.some((name) => typeof name !== "string" || !FILE_NAME.test(name))
      || new Set(stagedFiles).size !== stagedFiles.length) {
    fail("STAGED_MIGRATION_SELECTION_INVALID");
  }
  const [stock, staged] = await Promise.all([
    readPostgresMigrations({
      role,
      ...(rootDirectory === undefined ? {} : { rootDirectory }),
    }),
    listStagedMigrations(role, { rootDirectory: stagedRootDirectory }),
  ]);
  const stockByName = new Map(stock.map((migration) => [migration.name, migration]));
  const stockByVersion = new Map(stock.map((migration) => [migration.version, migration]));
  const stagedByName = new Map(staged.map((migration) => [migration.name, migration]));
  const apply = [];
  const promoted = [];
  for (const name of stagedFiles) {
    const stagedMigration = stagedByName.get(name);
    const stockMigration = stockByName.get(name);
    if (stagedMigration !== undefined && stockMigration !== undefined) {
      fail("STAGED_MIGRATION_ALREADY_PROMOTED", { migration: name });
    }
    if (stockMigration !== undefined) {
      promoted.push(name);
      continue;
    }
    if (stagedMigration === undefined) fail("STAGED_MIGRATION_NOT_FOUND", { migration: name });
    if (stockByVersion.has(stagedMigration.version)) {
      fail("STAGED_MIGRATION_VERSION_CONFLICT", { migration: name });
    }
    apply.push(stagedMigration);
  }
  apply.sort((left, right) => left.version - right.version);
  return { apply, promoted: promoted.sort() };
}

async function stagedQuery(client, text, values, failureCode, migration) {
  try {
    return await client.query(text, values);
  } catch (cause) {
    fail(failureCode, { ...(migration === undefined ? {} : { migration }), cause });
  }
}

function receiptKey(row, withAppliedAt) {
  return JSON.stringify([
    row?.version,
    row?.name,
    row?.checksum_sha256,
    ...(withAppliedAt ? [row?.applied_at_epoch] : []),
  ]);
}

function sameReceipts(left, right) {
  return left.length === right.length && left.every((row, index) => row === right[index]);
}

/**
 * Read the stock receipts in a bounded read-only transaction. It never
 * applies or repairs anything; applied_at is compared as its epoch text so
 * the snapshot does not depend on session TimeZone or DateStyle.
 */
async function readStockReceipts(client, schema) {
  let transactionStarted = false;
  try {
    await stagedQuery(client, "BEGIN READ ONLY", undefined, "STAGED_MIGRATION_RECEIPTS_READ_FAILED");
    transactionStarted = true;
    await stagedQuery(
      client,
      `SET LOCAL statement_timeout='${STAGED_MIGRATION_STATEMENT_TIMEOUT_MILLISECONDS}ms'`,
      undefined,
      "STAGED_MIGRATION_RECEIPTS_READ_FAILED",
    );
    await stagedQuery(
      client,
      `SET LOCAL lock_timeout='${STAGED_MIGRATION_LOCK_TIMEOUT_MILLISECONDS}ms'`,
      undefined,
      "STAGED_MIGRATION_RECEIPTS_READ_FAILED",
    );
    // renderPostgresSearchPath has already validated schema as a plain
    // lower-case identifier, so quoting it here is exact.
    const result = await stagedQuery(
      client,
      `SELECT version, name, checksum_sha256,
              extract(epoch FROM applied_at)::text AS applied_at_epoch
         FROM "${schema}".${migrationHistoryTable()} ORDER BY version`,
      undefined,
      "STAGED_MIGRATION_RECEIPTS_READ_FAILED",
    );
    await stagedQuery(client, "COMMIT", undefined, "STAGED_MIGRATION_RECEIPTS_READ_FAILED");
    transactionStarted = false;
    if (result === null || typeof result !== "object" || !Array.isArray(result.rows)) {
      fail("STAGED_MIGRATION_RECEIPTS_READ_FAILED");
    }
    return Object.freeze([...result.rows]);
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The connection is discarded by the caller either way.
      }
    }
    throw error;
  }
}

async function releaseClient(client, discard, state) {
  if (state.released) return;
  state.released = true;
  try {
    await client.release(discard);
  } catch (cause) {
    fail("STAGED_MIGRATION_RELEASE_FAILED", { cause });
  }
}

/**
 * Apply the stock migrations for `role` with applyPostgresMigrations, then
 * each named staged file in ascending version order. Every staged file runs in
 * its own transaction:
 *   BEGIN; SET LOCAL statement_timeout; SET LOCAL lock_timeout;
 *   renderPostgresSearchPath(schema); <sql>; COMMIT
 * under the runner's advisory lock for this role and schema (the same key,
 * so a concurrent runner on that schema is refused rather than interleaved).
 * A failed staged file is rolled back, its connection discarded, and the
 * error carries the file name and the driver error as `cause` for the test
 * author. Staged SQL is not recorded as a migration receipt. The stock
 * receipts are snapshotted read-only once the lock is held (they must match
 * the stock set the runner just verified) and again after the last staged
 * file; any difference is STAGED_MIGRATION_STOCK_RECEIPTS_CHANGED. Nothing
 * is re-applied or repaired. Use a fresh schema per call: staged SQL is not
 * idempotent unless its author made it so.
 */
export async function applyStockAndStagedMigrations({
  role,
  schema,
  pool,
  stagedFiles,
  rootDirectory,
  stagedRootDirectory = STAGED_MIGRATIONS_ROOT,
} = {}) {
  assertRole(role);
  if (pool === null || typeof pool !== "object" || typeof pool.connect !== "function") {
    fail("STAGED_MIGRATION_POOL_INVALID");
  }
  const searchPath = renderPostgresSearchPath(schema);
  const { apply, promoted } = await resolveStagedSelection({
    role,
    stagedFiles,
    rootDirectory,
    stagedRootDirectory,
  });
  const stock = await applyPostgresMigrations({
    role,
    schema,
    pool,
    ...(rootDirectory === undefined ? {} : { rootDirectory }),
  });
  if (apply.length > 0) {
    let client;
    try {
      client = await pool.connect();
    } catch (cause) {
      fail("STAGED_MIGRATION_CONNECT_FAILED", { cause });
    }
    const releaseState = { released: false };
    const lockKey = `tibotattle:${role}:${schema}`;
    try {
      const lock = await stagedQuery(
        client,
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [lockKey],
        "STAGED_MIGRATION_LOCK_FAILED",
      );
      if (lock?.rows?.[0]?.acquired !== true) fail("STAGED_MIGRATION_CONFLICT");
      const receiptsBefore = await readStockReceipts(client, schema);
      if (!sameReceipts(
        receiptsBefore.map((row) => receiptKey(row, false)),
        stock.migrations.map(({ version, name, sha256 }) =>
          receiptKey({ version, name, checksum_sha256: sha256 }, false)),
      )) {
        fail("STAGED_MIGRATION_STOCK_RECEIPTS_CHANGED");
      }
      for (const migration of apply) {
        let transactionStarted = false;
        let commitAttempted = false;
        try {
          await stagedQuery(client, "BEGIN", undefined, "STAGED_MIGRATION_APPLY_FAILED", migration.name);
          transactionStarted = true;
          await stagedQuery(
            client,
            `SET LOCAL statement_timeout='${STAGED_MIGRATION_STATEMENT_TIMEOUT_MILLISECONDS}ms'`,
            undefined,
            "STAGED_MIGRATION_APPLY_FAILED",
            migration.name,
          );
          await stagedQuery(
            client,
            `SET LOCAL lock_timeout='${STAGED_MIGRATION_LOCK_TIMEOUT_MILLISECONDS}ms'`,
            undefined,
            "STAGED_MIGRATION_APPLY_FAILED",
            migration.name,
          );
          await stagedQuery(client, searchPath, undefined, "STAGED_MIGRATION_APPLY_FAILED", migration.name);
          await stagedQuery(client, migration.sql, undefined, "STAGED_MIGRATION_APPLY_FAILED", migration.name);
          commitAttempted = true;
          await stagedQuery(client, "COMMIT", undefined, "STAGED_MIGRATION_RESULT_UNCERTAIN", migration.name);
        } catch (error) {
          if (transactionStarted && !commitAttempted) {
            try {
              await client.query("ROLLBACK");
            } catch {
              // The connection is discarded below either way.
            }
          }
          try {
            await releaseClient(client, true, releaseState);
          } catch {
            // Preserve the staged file's own failure.
          }
          throw error;
        }
      }
      const receiptsAfter = await readStockReceipts(client, schema);
      if (!sameReceipts(
        receiptsBefore.map((row) => receiptKey(row, true)),
        receiptsAfter.map((row) => receiptKey(row, true)),
      )) {
        fail("STAGED_MIGRATION_STOCK_RECEIPTS_CHANGED");
      }
      const unlock = await stagedQuery(
        client,
        "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released",
        [lockKey],
        "STAGED_MIGRATION_UNLOCK_FAILED",
      );
      if (unlock?.rows?.[0]?.released !== true) fail("STAGED_MIGRATION_UNLOCK_FAILED");
      await releaseClient(client, false, releaseState);
    } catch (error) {
      if (!releaseState.released) {
        try {
          await releaseClient(client, true, releaseState);
        } catch {
          // Preserve the original staged-migration failure.
        }
      }
      throw error;
    }
  }
  return Object.freeze({
    role,
    schema,
    stockApplied: stock.applied,
    staged: Object.freeze(apply.map(({ version, name, sha256 }) =>
      Object.freeze({ version, name, sha256 }))),
    promoted: Object.freeze(promoted),
  });
}

async function privateSocketDirectory(directory) {
  if (!PRIVATE_SOCKET_DIRECTORY.test(directory)) fail("POSTGRES_TEST_HOST_INVALID");
  let link;
  let real;
  let metadata;
  try {
    link = await lstat(directory);
    real = await realpath(directory);
    metadata = await stat(real);
  } catch {
    fail("POSTGRES_TEST_HOST_INVALID");
  }
  if (link.isSymbolicLink() || !metadata.isDirectory()
      || !real.startsWith("/private/tmp/tibotattle-pg-")
      || (metadata.mode & 0o077) !== 0
      || metadata.uid !== process.getuid()) {
    fail("POSTGRES_TEST_HOST_INVALID");
  }
  return real;
}

/**
 * The local PG17 endpoint for specs, or null when neither PG_TEST_SOCKET nor
 * PG_TEST_HOST is set (the spec then skips). PG_TEST_SOCKET must be a private
 * /private/tmp/tibotattle-pg-* socket directory owned by this user;
 * PG_TEST_HOST is a loopback name or such a socket directory. Any other
 * value throws rather than skipping, so misconfiguration never looks green.
 * When both are set, both are validated and the socket wins.
 */
export async function postgresTestEndpoint(env = process.env) {
  const socket = env.PG_TEST_SOCKET || undefined;
  const host = env.PG_TEST_HOST || undefined;
  if (socket === undefined && host === undefined) return null;
  const port = Number(env.PG_TEST_PORT ?? "55432");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) fail("POSTGRES_TEST_PORT_INVALID");
  const hostTarget = host === undefined || LOOPBACK_HOSTS.has(host)
    ? host
    : await privateSocketDirectory(host);
  const socketTarget = socket === undefined ? undefined : await privateSocketDirectory(socket);
  return Object.freeze({
    host: socketTarget ?? hostTarget,
    port,
    user: env.PG_TEST_USER || "postgres",
    database: env.PG_TEST_DATABASE || "postgres",
    ...(env.PG_TEST_PASSWORD ? { password: env.PG_TEST_PASSWORD } : {}),
  });
}

/**
 * Spec fixtures that write analytics_v2 rows by hand (not through the
 * refresh store) write them as kernel 1 on the compiled baseline manifest.
 * Once K-STAMP's migration (analytics_v2_kernel_stamps) is in a schema, its
 * stamp columns have no default; this gives them a schema-local default of
 * 1 so such fixtures need not name the stamp. A no-op on a schema without
 * the migration. Test-only, like the rest of this module.
 */
export async function defaultAnalyticsV2FixtureStamps(pool, schema) {
  const present = await pool.query("SELECT to_regclass($1) IS NOT NULL AS present",
    [`${renderQuotedSchema(schema)}.analytics_v2_kernels`]);
  if (present.rows[0]?.present !== true) return false;
  for (const table of ["analytics_v2_runs", "analytics_v2_owner_day", "analytics_v2_cache_bands",
    "analytics_v2_owner_fits", "analytics_v2_owner_model_dates", "analytics_v2_published_daily",
    "analytics_v2_preview"]) {
    await pool.query(`ALTER TABLE ${renderQuotedSchema(schema)}.${table}
      ALTER COLUMN kernel_id SET DEFAULT 1, ALTER COLUMN manifest_version SET DEFAULT 1`);
  }
  return true;
}

function renderQuotedSchema(schema) {
  if (typeof schema !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/u.test(schema)) fail("STAGED_MIGRATION_SCHEMA_INVALID");
  return `"${schema}"`;
}
