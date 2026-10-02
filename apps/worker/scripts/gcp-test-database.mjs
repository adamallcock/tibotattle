#!/usr/bin/env node

/**
 * Minimal Cloud SQL IAM qualification job for the PostgreSQL Worker backend.
 *
 * This file is intentionally host-only. It reads no passwords or service
 * account keys, uses the official Cloud SQL Connector with ADC/IAM auth, and
 * delegates canonical schema changes to postgres-migrations.mjs. It emits
 * closed, content-free results so connector/driver diagnostics never become
 * build or Cloud Run logs.
 *
 * The runtime role's grants are the one shared policy in
 * cloud-run/postgres-runtime-grants.mjs (table DML, read-only migration
 * history, and EXECUTE on exactly the runtime functions), applied and read
 * back in one transaction; this job adds no grant of its own. The job runs
 * only when this file is the entry point, so its functions can be imported
 * (gcp-test-database.check.mjs); the Cloud SQL connector is loaded only then.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  grantAndVerifyRuntimePrivileges,
  isRuntimeGrantError,
} from "../cloud-run/postgres-runtime-grants.mjs";
import {
  applyPostgresMigrations,
  buildPostgresMigrationManifest,
} from "./postgres-migrations.mjs";

const { Pool } = pg;
/** The shared grant policy reports this job's codes without a family prefix. */
export const GCP_TEST_DATABASE_GRANT_CODE_PREFIX = "";
const WORKER_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MIGRATION_ROOT = join(WORKER_ROOT, "postgres", "migrations");
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/u;
const INSTANCE_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/u;
const DATABASE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
const IAM_ROLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@_.-]{0,62}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const RESERVED_SCHEMAS = new Set(["pg_catalog", "pg_toast", "information_schema"]);
const HISTORY_TABLE = "_tibotattle_migration_history";
const DDL_PROBE_TABLE = "_tibotattle_runtime_ddl_probe";
const DEFAULT_SCHEMA = Object.freeze({
  primary: "tibotattle",
  ledger: "tibotattle_ledger",
});

export class JobError extends Error {
  constructor(code) {
    super(code);
    this.name = "JobError";
    this.code = code;
  }
}

function fail(code) {
  throw new JobError(code);
}

function envValue(name, { required = true, fallback } = {}) {
  const value = process.env[name];
  if (typeof value === "string" && value.length > 0) return value;
  if (!required && fallback !== undefined) return fallback;
  fail(`${name}_MISSING`);
}

function envAny(names, options = {}) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  if (options.required === false) return options.fallback;
  fail(`${names[0]}_MISSING`);
}

function validateSchema(value, label) {
  if (typeof value !== "string" || !SCHEMA_PATTERN.test(value)
      || RESERVED_SCHEMAS.has(value) || value.startsWith("pg_")) {
    fail(`${label}_INVALID`);
  }
  return value;
}

function validateDatabase(value, label) {
  if (typeof value !== "string" || !DATABASE_PATTERN.test(value)) {
    fail(`${label}_INVALID`);
  }
  return value;
}

function validateInstance(value, label) {
  if (typeof value !== "string" || !INSTANCE_PATTERN.test(value)) {
    fail(`${label}_INVALID`);
  }
  return value;
}

function normalizeIamRole(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label}_INVALID`);
  const withoutSuffix = value.endsWith(".gserviceaccount.com")
    ? value.slice(0, -".gserviceaccount.com".length)
    : value;
  if (!IAM_ROLE_PATTERN.test(withoutSuffix)
      || Buffer.byteLength(withoutSuffix, "utf8") > 63) {
    fail(`${label}_INVALID`);
  }
  return withoutSuffix;
}

function quoteIdentifier(value) {
  if (typeof value !== "string" || !SCHEMA_PATTERN.test(value)
      || RESERVED_SCHEMAS.has(value) || value.startsWith("pg_")) {
    fail("POSTGRES_IDENTIFIER_INVALID");
  }
  return `"${value}"`;
}

function parseCommand() {
  const command = process.argv[2] ?? "check";
  if (command === "--help" || command === "-h") {
    console.log("usage: gcp-test-database.mjs <check|migrate>");
    process.exit(0);
  }
  if (command !== "check" && command !== "migrate") fail("COMMAND_INVALID");
  return command;
}

function databaseConfig() {
  const primarySchema = validateSchema(
    process.env.PRIMARY_SCHEMA ?? DEFAULT_SCHEMA.primary,
    "PRIMARY_SCHEMA",
  );
  const ledgerSchema = validateSchema(
    process.env.LEDGER_SCHEMA ?? DEFAULT_SCHEMA.ledger,
    "LEDGER_SCHEMA",
  );
  if (primarySchema === ledgerSchema) fail("PRIMARY_LEDGER_SCHEMA_COLLISION");
  return Object.freeze({
    primary: Object.freeze({
      role: "primary",
      schema: primarySchema,
      database: validateDatabase(
        process.env.PRIMARY_DATABASE ?? "tibotattle",
        "PRIMARY_DATABASE",
      ),
      instanceConnectionName: validateInstance(
        envAny(["PRIMARY_INSTANCE_CONNECTION_NAME", "PRIMARY_INSTANCE"]),
        "PRIMARY_INSTANCE_CONNECTION_NAME",
      ),
      max: 3,
    }),
    ledger: Object.freeze({
      role: "ledger",
      schema: ledgerSchema,
      database: validateDatabase(
        process.env.LEDGER_DATABASE ?? "tibotattle_ledger",
        "LEDGER_DATABASE",
      ),
      instanceConnectionName: validateInstance(
        envAny(["LEDGER_INSTANCE_CONNECTION_NAME", "LEDGER_INSTANCE"]),
        "LEDGER_INSTANCE_CONNECTION_NAME",
      ),
      max: 2,
    }),
  });
}

function migrationSummary(roleResult, manifest) {
  const entries = manifest.roles[roleResult.role] ?? [];
  const latest = entries.at(-1);
  return Object.freeze({
    applied: roleResult.applied,
    expected: entries.length,
    latest: latest === undefined
      ? null
      : Object.freeze({
        version: latest.version,
        name: latest.name,
        sha256: latest.sha256,
      }),
    manifestSha256: manifest.sha256,
  });
}

async function sourceContentDigest() {
  const configured = process.env.SOURCE_CONTENT_DIGEST;
  if (configured !== undefined) {
    if (!DIGEST_PATTERN.test(configured)) fail("SOURCE_CONTENT_DIGEST_INVALID");
    return configured;
  }
  const path = process.env.SOURCE_CONTENT_DIGEST_FILE ?? "/app/SOURCE_CONTENT_DIGEST";
  try {
    const value = (await readFile(path, "utf8")).trim();
    return DIGEST_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

async function createIamPool(connector, database, user, { max } = {}) {
  let options;
  try {
    options = await connector.getOptions({
      instanceConnectionName: database.instanceConnectionName,
      authType: "IAM",
      ipType: "PUBLIC",
    });
  } catch {
    fail("CLOUD_SQL_CONNECTOR_OPTIONS_FAILED");
  }
  let pool;
  try {
    pool = new Pool({
      ...options,
      user,
      database: database.database,
      max: max ?? database.max,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      application_name: "tibotattle-gcp-test-database",
    });
    // pg emits idle-client errors outside a query promise. Keep the process
    // inside this job's closed error envelope and expose no driver detail.
    pool.on("error", () => {});
    await pool.query("SELECT 1 AS connected");
    return pool;
  } catch {
    try { await pool?.end(); } catch { /* sanitize the original connection failure */ }
    fail("POSTGRES_CONNECTION_FAILED");
  }
}

async function readMigrationMetadata(pool, database, manifest) {
  const schema = quoteIdentifier(database.schema);
  let result;
  try {
    result = await pool.query(
      `SELECT version, name, checksum_sha256
         FROM ${schema}.${quoteIdentifier(HISTORY_TABLE)}
        ORDER BY version`,
    );
  } catch {
    fail(`${database.role.toUpperCase()}_MIGRATION_METADATA_UNAVAILABLE`);
  }
  const expected = manifest.roles[database.role] ?? [];
  if (!Array.isArray(result.rows) || result.rows.length !== expected.length) {
    fail(`${database.role.toUpperCase()}_MIGRATION_METADATA_MISMATCH`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const actual = result.rows[index];
    const wanted = expected[index];
    if (actual?.version !== wanted.version
        || actual?.name !== wanted.name
        || actual?.checksum_sha256 !== wanted.sha256) {
      fail(`${database.role.toUpperCase()}_MIGRATION_METADATA_MISMATCH`);
    }
  }
  return Object.freeze({
    applied: result.rows.length,
    expected: expected.length,
    latest: expected.at(-1) === undefined
      ? null
      : Object.freeze({
        version: expected.at(-1).version,
        name: expected.at(-1).name,
        sha256: expected.at(-1).sha256,
      }),
    manifestSha256: manifest.sha256,
  });
}

async function readPrivilegeMetadata(pool, database, runtimeRole) {
  const schema = database.schema;
  const historyRelation = `${schema}.${HISTORY_TABLE}`;
  const dataTable = database.role === "primary"
    ? "telemetry_v1_chunks"
    : "storage_erasure_jobs";
  const dataRelation = `${schema}.${dataTable}`;
  let result;
  try {
    result = await pool.query(
      `SELECT
         to_regnamespace($2) IS NOT NULL AS schema_exists,
         to_regclass($3) IS NOT NULL AS data_table_exists,
         has_schema_privilege($1, $2, 'USAGE') AS schema_usage,
         has_schema_privilege($1, $2, 'CREATE') AS schema_create,
         has_table_privilege($1, $3, 'SELECT') AS data_select,
         has_table_privilege($1, $3, 'INSERT') AS data_insert,
         has_table_privilege($1, $3, 'UPDATE') AS data_update,
         has_table_privilege($1, $3, 'DELETE') AS data_delete,
         has_table_privilege($1, $4, 'SELECT') AS history_select,
         has_table_privilege($1, $4, 'INSERT') AS history_insert,
         has_table_privilege($1, $4, 'UPDATE') AS history_update,
         has_table_privilege($1, $4, 'DELETE') AS history_delete`,
      [runtimeRole, schema, dataRelation, historyRelation],
    );
  } catch {
    fail(`${database.role.toUpperCase()}_PRIVILEGE_METADATA_UNAVAILABLE`);
  }
  const row = result.rows[0];
  if (row?.schema_exists !== true || row?.data_table_exists !== true) {
    fail(`${database.role.toUpperCase()}_SCHEMA_UNAVAILABLE`);
  }
  return Object.freeze({
    role: "runtime",
    configuredUser: runtimeRole,
    schemaUsage: row.schema_usage === true,
    schemaCreate: row.schema_create === true,
    dataTable: Object.freeze({
      select: row.data_select === true,
      insert: row.data_insert === true,
      update: row.data_update === true,
      delete: row.data_delete === true,
    }),
    migrationTable: Object.freeze({
      select: row.history_select === true,
      insert: row.history_insert === true,
      update: row.history_update === true,
      delete: row.history_delete === true,
    }),
  });
}

async function proveRuntimeCannotCreateTables(pool, database) {
  const schema = quoteIdentifier(database.schema);
  const table = quoteIdentifier(DDL_PROBE_TABLE);
  let client;
  let transactionStarted = false;
  let rollbackNeeded = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;
    rollbackNeeded = true;
    await client.query("SET LOCAL statement_timeout='5000ms'");
    await client.query(`CREATE TABLE ${schema}.${table} (probe integer NOT NULL)`);
    await client.query("ROLLBACK");
    rollbackNeeded = false;
    return true;
  } catch (error) {
    if (rollbackNeeded) {
      try {
        await client.query("ROLLBACK");
      } catch {
        client.release(true);
        client = null;
        fail(`${database.role.toUpperCase()}_DDL_PROBE_ROLLBACK_FAILED`);
      }
    }
    if (error?.code === "42501") return false;
    fail(`${database.role.toUpperCase()}_DDL_PROBE_FAILED`);
  } finally {
    if (client !== null && client !== undefined) {
      try {
        client.release(false);
      } catch {
        fail(`${database.role.toUpperCase()}_DDL_PROBE_RELEASE_FAILED`);
      }
    }
  }
}

async function probeRuntimeDml(pool, database) {
  const schema = quoteIdentifier(database.schema);
  const dataTable = database.role === "primary"
    ? "telemetry_v1_chunks"
    : "storage_erasure_jobs";
  const updateColumn = database.role === "primary"
    ? "id"
    : "participant_digest";
  const table = `${schema}.${quoteIdentifier(dataTable)}`;
  let client;
  let transactionStarted = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SET LOCAL statement_timeout='5000ms'");
    // These statements affect zero rows, but PostgreSQL still checks the
    // caller's INSERT/UPDATE/DELETE privileges on the operational table.
    await client.query(`INSERT INTO ${table} SELECT * FROM ${table} WHERE false`);
    await client.query(`UPDATE ${table} SET ${quoteIdentifier(updateColumn)}=${quoteIdentifier(updateColumn)} WHERE false`);
    await client.query(`DELETE FROM ${table} WHERE false`);
    await client.query("ROLLBACK");
    transactionStarted = false;
    return true;
  } catch {
    if (transactionStarted) {
      try { await client.query("ROLLBACK"); } catch { /* discard below */ }
    }
    fail(`${database.role.toUpperCase()}_DML_PROBE_FAILED`);
  } finally {
    if (client !== null && client !== undefined) {
      try {
        client.release(transactionStarted);
      } catch {
        fail(`${database.role.toUpperCase()}_DML_PROBE_RELEASE_FAILED`);
      }
    }
  }
}

async function checkRuntimePool(pool, database, runtimeRole, manifest) {
  const metadata = await readMigrationMetadata(pool, database, manifest);
  const privileges = await readPrivilegeMetadata(pool, database, runtimeRole);
  if (!privileges.schemaUsage
      || privileges.schemaCreate
      || !privileges.dataTable.select
      || !privileges.dataTable.insert
      || !privileges.dataTable.update
      || !privileges.dataTable.delete
      || !privileges.migrationTable.select
      || privileges.migrationTable.insert
      || privileges.migrationTable.update
      || privileges.migrationTable.delete) {
    fail(`${database.role.toUpperCase()}_RUNTIME_PRIVILEGES_INVALID`);
  }
  const dmlProbe = await probeRuntimeDml(pool, database);
  const ddlAllowed = await proveRuntimeCannotCreateTables(pool, database);
  if (!dmlProbe || ddlAllowed) fail(`${database.role.toUpperCase()}_RUNTIME_PRIVILEGE_PROBE_FAILED`);
  return Object.freeze({
    database: database.database,
    schema: database.schema,
    migrations: metadata,
    privileges: Object.freeze({
      ...privileges,
      dmlProbe,
      ddlAllowed,
    }),
  });
}

async function inspectRuntimePrivileges(pool, database, runtimeRole, manifest) {
  const metadata = await readMigrationMetadata(pool, database, manifest);
  const privileges = await readPrivilegeMetadata(pool, database, runtimeRole);
  if (!privileges.schemaUsage
      || privileges.schemaCreate
      || !privileges.dataTable.select
      || !privileges.dataTable.insert
      || !privileges.dataTable.update
      || !privileges.dataTable.delete
      || !privileges.migrationTable.select
      || privileges.migrationTable.insert
      || privileges.migrationTable.update
      || privileges.migrationTable.delete) {
    fail(`${database.role.toUpperCase()}_RUNTIME_PRIVILEGES_INVALID`);
  }
  return Object.freeze({
    database: database.database,
    schema: database.schema,
    migrations: metadata,
    privileges: Object.freeze({
      ...privileges,
      dmlProbe: null,
      ddlAllowed: null,
      verification: "migrator_role_privilege_inspection",
    }),
  });
}

export async function ensureSchema(migratorPool, database, migratorRole) {
  const schema = quoteIdentifier(database.schema);
  let client;
  let transactionStarted = false;
  try {
    client = await migratorPool.connect();
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SET LOCAL statement_timeout='30000ms'");
    await client.query("SET LOCAL lock_timeout='5000ms'");
    const existing = await client.query(
      `SELECT pg_get_userbyid(nspowner) AS owner
         FROM pg_namespace
        WHERE nspname=$1`,
      [database.schema],
    );
    if (existing.rows.length === 0) {
      await client.query(`CREATE SCHEMA ${schema}`);
    } else if (existing.rows[0]?.owner !== migratorRole) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      fail(`${database.role.toUpperCase()}_SCHEMA_OWNER_UNEXPECTED`);
    }
    const owner = await client.query(
      `SELECT pg_get_userbyid(nspowner) AS owner
         FROM pg_namespace
        WHERE nspname=$1`,
      [database.schema],
    );
    if (owner.rows[0]?.owner !== migratorRole) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      fail(`${database.role.toUpperCase()}_SCHEMA_OWNER_UNEXPECTED`);
    }
    await client.query("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try { await client.query("ROLLBACK"); } catch { /* discard below */ }
    }
    if (error instanceof JobError) throw error;
    fail(`${database.role.toUpperCase()}_SCHEMA_CREATE_FAILED`);
  } finally {
    if (client !== null && client !== undefined) {
      try { client.release(transactionStarted); } catch { fail(`${database.role.toUpperCase()}_SCHEMA_RELEASE_FAILED`); }
    }
  }
}

/**
 * Apply the shared runtime-grant policy (cloud-run/postgres-runtime-grants.mjs)
 * to one role schema and read it back. Refusals keep this job's code family:
 * `<ROLE>_RUNTIME_GRANT_FAILED`, `<ROLE>_RUNTIME_PRIVILEGES_INVALID`, and so on.
 */
export async function grantRuntimePrivileges(migratorPool, database, runtimeRole) {
  try {
    await grantAndVerifyRuntimePrivileges(migratorPool, {
      role: database.role,
      schema: database.schema,
      runtimeRole,
      codePrefix: GCP_TEST_DATABASE_GRANT_CODE_PREFIX,
    });
  } catch (error) {
    if (isRuntimeGrantError(error)) fail(error.code);
    fail(`${String(database?.role).toUpperCase()}_RUNTIME_GRANT_FAILED`);
  }
}

async function run(command) {
  const databases = databaseConfig();
  const manifest = await buildPostgresMigrationManifest({ rootDirectory: MIGRATION_ROOT });
  const digest = await sourceContentDigest();
  const { Connector } = await import("@google-cloud/cloud-sql-connector");
  const connector = new Connector();
  const pools = [];
  try {
    if (command === "check") {
      const runtimeRole = normalizeIamRole(
        envAny(["POSTGRES_RUNTIME_IAM_USER", "RUNTIME_IAM_USER"]),
        "POSTGRES_RUNTIME_IAM_USER",
      );
      const primaryPool = await createIamPool(connector, databases.primary, runtimeRole, { max: 3 });
      pools.push(primaryPool);
      const ledgerPool = await createIamPool(connector, databases.ledger, runtimeRole, { max: 2 });
      pools.push(ledgerPool);
      const [primary, ledger] = await Promise.all([
        checkRuntimePool(primaryPool, databases.primary, runtimeRole, manifest),
        checkRuntimePool(ledgerPool, databases.ledger, runtimeRole, manifest),
      ]);
      return Object.freeze({
        status: "ok",
        mode: command,
        sourceContentDigest: digest,
        migrations: Object.freeze({
          primary: primary.migrations,
          ledger: ledger.migrations,
        }),
        databases: Object.freeze({
          primary: Object.freeze({
            schema: primary.schema,
            database: primary.database,
            privileges: primary.privileges,
          }),
          ledger: Object.freeze({
            schema: ledger.schema,
            database: ledger.database,
            privileges: ledger.privileges,
          }),
        }),
      });
    }

    const migratorRole = normalizeIamRole(
      envAny(["POSTGRES_MIGRATOR_IAM_USER", "MIGRATOR_IAM_USER"]),
      "POSTGRES_MIGRATOR_IAM_USER",
    );
    const runtimeRole = normalizeIamRole(
      envAny(["POSTGRES_RUNTIME_IAM_USER", "RUNTIME_IAM_USER"]),
      "POSTGRES_RUNTIME_IAM_USER",
    );
    const primaryMigratorPool = await createIamPool(
      connector,
      databases.primary,
      migratorRole,
      { max: 1 },
    );
    pools.push(primaryMigratorPool);
    const ledgerMigratorPool = await createIamPool(
      connector,
      databases.ledger,
      migratorRole,
      { max: 1 },
    );
    pools.push(ledgerMigratorPool);
    await ensureSchema(primaryMigratorPool, databases.primary, migratorRole);
    await ensureSchema(ledgerMigratorPool, databases.ledger, migratorRole);
    const primaryResult = await applyPostgresMigrations({
      role: "primary",
      schema: databases.primary.schema,
      pool: primaryMigratorPool,
      rootDirectory: MIGRATION_ROOT,
    });
    const ledgerResult = await applyPostgresMigrations({
      role: "ledger",
      schema: databases.ledger.schema,
      pool: ledgerMigratorPool,
      rootDirectory: MIGRATION_ROOT,
    });
    await grantRuntimePrivileges(primaryMigratorPool, databases.primary, runtimeRole);
    await grantRuntimePrivileges(ledgerMigratorPool, databases.ledger, runtimeRole);

    const [primary, ledger] = await Promise.all([
      inspectRuntimePrivileges(primaryMigratorPool, databases.primary, runtimeRole, manifest),
      inspectRuntimePrivileges(ledgerMigratorPool, databases.ledger, runtimeRole, manifest),
    ]);
    return Object.freeze({
      status: "ok",
      mode: command,
      sourceContentDigest: digest,
      migrations: Object.freeze({
        primary: migrationSummary(primaryResult, manifest),
        ledger: migrationSummary(ledgerResult, manifest),
      }),
      databases: Object.freeze({
        primary: Object.freeze({ schema: primary.schema, database: primary.database, privileges: primary.privileges }),
        ledger: Object.freeze({ schema: ledger.schema, database: ledger.database, privileges: ledger.privileges }),
      }),
    });
  } finally {
    let cleanupCode = null;
    for (let index = pools.length - 1; index >= 0; index -= 1) {
      try {
        await pools[index].end();
      } catch {
        cleanupCode ??= "POSTGRES_POOL_CLOSE_FAILED";
      }
    }
    try {
      await connector.close();
    } catch {
      cleanupCode ??= "CLOUD_SQL_CONNECTOR_CLOSE_FAILED";
    }
    if (cleanupCode !== null) fail(cleanupCode);
  }
}

function invokedDirectly() {
  return typeof process.argv[1] === "string"
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) {
  const command = parseCommand();
  try {
    const result = await run(command);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const code = error instanceof JobError && typeof error.code === "string"
      ? error.code
      : "GCP_TEST_DATABASE_FAILED";
    console.error(JSON.stringify({ status: "error", code }));
    process.exitCode = 1;
  }
}
