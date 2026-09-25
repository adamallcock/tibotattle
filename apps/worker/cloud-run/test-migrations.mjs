#!/usr/bin/env node

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connector } from "@google-cloud/cloud-sql-connector";
import {
  applyPostgresMigrations,
  buildPostgresMigrationManifest,
} from "./postgres-migrations.mjs";
import {
  closeCloudSqlResources,
  createIamPool as createCloudSqlIamPool,
} from "./cloud-sql.mjs";

export const TEST_MIGRATIONS_JOB = "tibotattle-test-database-migrate";
export const GRAPH_BENCHMARK_MIGRATIONS_JOB = "tibotattle-public-graph-benchmark-migrate";
export const TEST_MIGRATIONS_PROJECT = "tibotattle";
export const TEST_MIGRATIONS_SERVICE_ACCOUNT =
  "tibotattle-test-migrator@tibotattle.iam.gserviceaccount.com";
export const TEST_MIGRATIONS_IAM_USER = "tibotattle-test-migrator@tibotattle.iam";
export const TEST_MIGRATIONS_RUNTIME_IAM_USER = "tibotattle-test-runtime@tibotattle.iam";
export const TEST_MIGRATIONS_ROOT = "/app/apps/worker/postgres/migrations";
export const TEST_MIGRATIONS_TARGETS = Object.freeze({
  primary: Object.freeze({
    instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
    database: "tibotattle",
    schema: "tibotattle_v12_a2_20260925",
    expectedMigrations: 41,
  }),
  ledger: Object.freeze({
    instanceConnectionName: "tibotattle:us-east1:tibotattle-test-ledger-20260922",
    database: "tibotattle_ledger",
    schema: "tibotattle_ledger_v12_a2_20260925",
    expectedMigrations: 6,
  }),
});
export const GRAPH_BENCHMARK_MIGRATION_TARGETS = Object.freeze([
  Object.freeze({
    name: "10k",
    instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
    database: "tibotattle",
    schema: "tibotattle_graph_benchmark_10k_20260925",
    expectedMigrations: 41,
  }),
  Object.freeze({
    name: "100k",
    instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
    database: "tibotattle",
    schema: "tibotattle_graph_benchmark_100k_20260925",
    expectedMigrations: 41,
  }),
  Object.freeze({
    name: "100k-insights",
    instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
    database: "tibotattle",
    schema: "tibotattle_graph_benchmark_100k_insights_20260925",
    expectedMigrations: 41,
  }),
  Object.freeze({
    name: "100k-paged",
    instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
    database: "tibotattle",
    schema: "tibotattle_graph_benchmark_100k_paged_20260925",
    expectedMigrations: 41,
  }),
  Object.freeze({
    name: "100k-readpaged",
    instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
    database: "tibotattle",
    schema: "tibotattle_graph_benchmark_100k_readpaged_20260925",
    expectedMigrations: 41,
  }),
  Object.freeze({
    name: "100k-readindexed",
    instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
    database: "tibotattle",
    schema: "tibotattle_graph_benchmark_100k_readindexed_20260925",
    expectedMigrations: 41,
  }),
  Object.freeze({
    name: "100k-batched",
    instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
    database: "tibotattle",
    schema: "tibotattle_graph_benchmark_100k_batched_20260925",
    expectedMigrations: 41,
  }),
]);

const A2_PROFILE = "a2";
export const GRAPH_BENCHMARK_MIGRATION_PROFILE = "community-graph-benchmark";
const GRAPH_BENCHMARK_PROFILE = GRAPH_BENCHMARK_MIGRATION_PROFILE;

const EXECUTION_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const MIGRATION_NAME_PATTERN = /^\d{4}_[a-z][a-z0-9_-]*\.sql$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const HISTORY_TABLE = "_tibotattle_migration_history";
const MIGRATOR_APPLICATION_NAME = "tibotattle-test-database-migrator";
const METADATA_EMAIL_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email";
const METADATA_TIMEOUT_MILLISECONDS = 3_000;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function safeErrorCode(error, fallback) {
  return typeof error?.code === "string"
    && /^(?:CLOUD_RUN|CLOUD_SQL|POSTGRES)_TEST_MIGRATIONS_[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : fallback;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalManifest(manifest) {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    roles: Object.fromEntries(Object.keys(TEST_MIGRATIONS_TARGETS).map((role) => [
      role,
      manifest.roles[role].map(({ version, name, bytes, sha256 }) => ({
        version,
        name,
        bytes,
        sha256,
      })),
    ])),
  });
}

function validateManifest(manifest) {
  if (manifest === null || typeof manifest !== "object"
      || manifest.schemaVersion !== "tibotattle-postgres-migration-manifest-v1"
      || !SHA256_PATTERN.test(manifest.sha256 ?? "")
      || manifest.roles === null || typeof manifest.roles !== "object"
      || Object.keys(manifest.roles).sort().join(",") !== "ledger,primary") {
    fail("POSTGRES_TEST_MIGRATIONS_MANIFEST_INVALID");
  }
  for (const [role, target] of Object.entries(TEST_MIGRATIONS_TARGETS)) {
    const migrations = manifest.roles[role];
    if (!Array.isArray(migrations) || migrations.length !== target.expectedMigrations) {
      fail("POSTGRES_TEST_MIGRATIONS_MANIFEST_INVALID");
    }
    for (let index = 0; index < migrations.length; index += 1) {
      const migration = migrations[index];
      if (migration === null || typeof migration !== "object"
          || migration.role !== role
          || migration.version !== index + 1
          || !MIGRATION_NAME_PATTERN.test(migration.name ?? "")
          || !Number.isSafeInteger(migration.bytes) || migration.bytes < 1
          || typeof migration.sql !== "string"
          || Buffer.byteLength(migration.sql) !== migration.bytes
          || hash(migration.sql) !== migration.sha256
          || !SHA256_PATTERN.test(migration.sha256 ?? "")) {
        fail("POSTGRES_TEST_MIGRATIONS_MANIFEST_INVALID");
      }
    }
  }
  if (hash(canonicalManifest(manifest)) !== manifest.sha256) {
    fail("POSTGRES_TEST_MIGRATIONS_MANIFEST_INVALID");
  }
  return manifest;
}

function expectedReceipts(manifest, role) {
  return manifest.roles[role].map(({ version, name, sha256 }) => ({ version, name, sha256 }));
}

function validateApplyResult(result, role, target, expected) {
  if (result === null || typeof result !== "object"
      || result.role !== role || result.schema !== target.schema
      || result.applied !== expected.length
      || !Array.isArray(result.migrations) || result.migrations.length !== expected.length) {
    fail(`POSTGRES_TEST_MIGRATIONS_${role.toUpperCase()}_APPLY_RECEIPT_INVALID`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const actual = result.migrations[index];
    const wanted = expected[index];
    if (actual?.version !== wanted.version
        || actual?.name !== wanted.name
        || actual?.sha256 !== wanted.sha256) {
      fail(`POSTGRES_TEST_MIGRATIONS_${role.toUpperCase()}_APPLY_RECEIPT_INVALID`);
    }
  }
}

function quoteSchema(schema) {
  // These are fixed constants, but retain a local guard before SQL rendering.
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(schema)) {
    fail("POSTGRES_TEST_MIGRATIONS_SCHEMA_INVALID");
  }
  return `"${schema}"`;
}

function quoteRole(role) {
  if (typeof role !== "string" || role !== TEST_MIGRATIONS_RUNTIME_IAM_USER) {
    fail("POSTGRES_TEST_MIGRATIONS_RUNTIME_ROLE_INVALID");
  }
  return `"${role.replaceAll('"', '""')}"`;
}

function rowsFrom(result, code) {
  if (result === null || typeof result !== "object"
      || !Array.isArray(result.rows)
      || result.rowCount !== null && result.rowCount !== result.rows.length) {
    fail(code);
  }
  return result.rows;
}

async function ensureSchema(pool, role, target) {
  const schemaSql = quoteSchema(target.schema);
  let client;
  let transactionOpen = false;
  let discard = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout='30000ms'");
    await client.query("SET LOCAL lock_timeout='5000ms'");
    const currentRows = rowsFrom(await client.query(
      "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=$1",
      [target.schema],
    ), `POSTGRES_TEST_MIGRATIONS_${role.toUpperCase()}_SCHEMA_READ_FAILED`);
    if (currentRows.length > 1) {
      fail(`POSTGRES_TEST_MIGRATIONS_${role.toUpperCase()}_SCHEMA_READ_FAILED`);
    }
    if (currentRows.length === 0) {
      await client.query(`CREATE SCHEMA ${schemaSql}`);
    } else if (currentRows[0]?.owner !== TEST_MIGRATIONS_IAM_USER) {
      fail(`POSTGRES_TEST_MIGRATIONS_${role.toUpperCase()}_SCHEMA_OWNER_UNEXPECTED`);
    }
    const ownerRows = rowsFrom(await client.query(
      "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=$1",
      [target.schema],
    ), `POSTGRES_TEST_MIGRATIONS_${role.toUpperCase()}_SCHEMA_READ_FAILED`);
    if (ownerRows.length !== 1 || ownerRows[0]?.owner !== TEST_MIGRATIONS_IAM_USER) {
      fail(`POSTGRES_TEST_MIGRATIONS_${role.toUpperCase()}_SCHEMA_OWNER_UNEXPECTED`);
    }
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    discard = true;
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
        transactionOpen = false;
      } catch {
        fail(`POSTGRES_TEST_MIGRATIONS_${role.toUpperCase()}_SCHEMA_ROLLBACK_FAILED`);
      }
    }
    if (typeof error?.code === "string"
        && /^POSTGRES_TEST_MIGRATIONS_[A-Z0-9_]+$/u.test(error.code)) throw error;
    fail(`POSTGRES_TEST_MIGRATIONS_${role.toUpperCase()}_SCHEMA_SETUP_FAILED`);
  } finally {
    if (client !== undefined) {
      try {
        await client.release(discard || transactionOpen);
      } catch {
        fail(`POSTGRES_TEST_MIGRATIONS_${role.toUpperCase()}_SCHEMA_RELEASE_FAILED`);
      }
    }
  }
}

async function grantAndVerifyRuntimePrivileges(pool, role, target) {
  const schema = quoteSchema(target.schema);
  const runtimeRole = quoteRole(TEST_MIGRATIONS_RUNTIME_IAM_USER);
  const historyTable = `"${HISTORY_TABLE}"`;
  const tableRelation = `${target.schema}.${HISTORY_TABLE}`;
  const functionRelation = `${target.schema}.insert_telemetry_v1_contribution(jsonb)`;
  let client;
  let transactionOpen = false;
  let discard = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout='30000ms'");
    await client.query("SET LOCAL lock_timeout='5000ms'");

    // The A2 schemas are isolated to this test environment. Reset only direct
    // grants on these exact schemas, then grant the runtime role only the
    // privileges exercised by the application. Migration history remains
    // read-only to runtime.
    await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM ${runtimeRole}`);
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM ${runtimeRole}`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${runtimeRole}`,
    );
    await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${runtimeRole}`);
    await client.query(
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${runtimeRole}`,
    );
    await client.query(
      `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
         ON ${schema}.${historyTable} FROM ${runtimeRole}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
         REVOKE ALL ON TABLES FROM ${runtimeRole}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtimeRole}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
         REVOKE ALL ON SEQUENCES FROM ${runtimeRole}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
         GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${runtimeRole}`,
    );
    if (role === "primary") {
      await client.query(
        `REVOKE ALL ON FUNCTION ${schema}."insert_telemetry_v1_contribution"(jsonb) FROM ${runtimeRole}`,
      );
      await client.query(
        `GRANT EXECUTE ON FUNCTION ${schema}."insert_telemetry_v1_contribution"(jsonb) TO ${runtimeRole}`,
      );
    }

    const rows = rowsFrom(await client.query(
      `SELECT
         has_schema_privilege($1, $2, 'USAGE') AS schema_usage,
         has_schema_privilege($1, $2, 'CREATE') AS schema_create,
         (SELECT count(*) > 0 AND COALESCE(bool_and(
             has_table_privilege($1, rel.oid, 'SELECT')
             AND has_table_privilege($1, rel.oid, 'INSERT')
             AND has_table_privilege($1, rel.oid, 'UPDATE')
             AND has_table_privilege($1, rel.oid, 'DELETE')
           ), false)
            FROM pg_class rel
            JOIN pg_namespace ns ON ns.oid = rel.relnamespace
           WHERE ns.nspname = $2 AND rel.relkind IN ('r', 'p', 'v', 'm', 'f')
             AND rel.relname <> $6) AS application_tables_dml,
         (SELECT COALESCE(bool_and(
             has_sequence_privilege($1, rel.oid, 'USAGE')
             AND has_sequence_privilege($1, rel.oid, 'SELECT')
             AND has_sequence_privilege($1, rel.oid, 'UPDATE')
           ), true)
            FROM pg_class rel
            JOIN pg_namespace ns ON ns.oid = rel.relnamespace
           WHERE ns.nspname = $2 AND rel.relkind = 'S') AS sequences_access,
         has_table_privilege($1, $3, 'SELECT') AS history_select,
         has_table_privilege($1, $3, 'INSERT') AS history_insert,
         has_table_privilege($1, $3, 'UPDATE') AS history_update,
         has_table_privilege($1, $3, 'DELETE') AS history_delete,
         (SELECT count(*) = 4
                 AND array_agg(acl.privilege_type ORDER BY acl.privilege_type)
                   = ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[]
                 AND bool_and(NOT acl.is_grantable)
            FROM pg_default_acl defaults
            CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
           WHERE defaults.defaclobjtype = 'r'
             AND defaults.defaclnamespace = to_regnamespace($2)
             AND pg_get_userbyid(defaults.defaclrole) = current_user
             AND pg_get_userbyid(acl.grantee) = $1) AS default_tables_dml,
         (SELECT count(*) = 3
                 AND array_agg(acl.privilege_type ORDER BY acl.privilege_type)
                   = ARRAY['SELECT', 'UPDATE', 'USAGE']::text[]
                 AND bool_and(NOT acl.is_grantable)
            FROM pg_default_acl defaults
            CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
           WHERE defaults.defaclobjtype = 'S'
             AND defaults.defaclnamespace = to_regnamespace($2)
             AND pg_get_userbyid(defaults.defaclrole) = current_user
             AND pg_get_userbyid(acl.grantee) = $1) AS default_sequences_access,
         (SELECT count(*) = 0
            FROM pg_default_acl defaults
            CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
           WHERE defaults.defaclobjtype = 'r'
             AND defaults.defaclnamespace = 0
             AND pg_get_userbyid(defaults.defaclrole) = current_user
             AND pg_get_userbyid(acl.grantee) = $1) AS no_global_table_defaults,
         (SELECT count(*) = 0
            FROM pg_default_acl defaults
            CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
           WHERE defaults.defaclobjtype = 'S'
             AND defaults.defaclnamespace = 0
             AND pg_get_userbyid(defaults.defaclrole) = current_user
             AND pg_get_userbyid(acl.grantee) = $1) AS no_global_sequence_defaults,
         CASE WHEN $4
           THEN has_function_privilege($1, $5, 'EXECUTE')
           ELSE true
         END AS telemetry_function_execute`,
      [
        TEST_MIGRATIONS_RUNTIME_IAM_USER,
        target.schema,
        tableRelation,
        role === "primary",
        functionRelation,
        HISTORY_TABLE,
      ],
    ), `POSTGRES_TEST_MIGRATIONS_${role.toUpperCase()}_RUNTIME_PRIVILEGES_READ_FAILED`);
    const actual = rows[0];
    if (rows.length !== 1
        || actual?.schema_usage !== true
        || actual?.schema_create !== false
        || actual?.application_tables_dml !== true
        || actual?.sequences_access !== true
        || actual?.history_select !== true
        || actual?.history_insert !== false
        || actual?.history_update !== false
        || actual?.history_delete !== false
        || actual?.default_tables_dml !== true
        || actual?.default_sequences_access !== true
        || actual?.no_global_table_defaults !== true
        || actual?.no_global_sequence_defaults !== true
        || actual?.telemetry_function_execute !== true) {
      fail(`POSTGRES_TEST_MIGRATIONS_${role.toUpperCase()}_RUNTIME_PRIVILEGES_INVALID`);
    }
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    discard = true;
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
        transactionOpen = false;
      } catch {
        fail(`POSTGRES_TEST_MIGRATIONS_${role.toUpperCase()}_RUNTIME_PRIVILEGES_ROLLBACK_FAILED`);
      }
    }
    if (typeof error?.code === "string"
        && /^POSTGRES_TEST_MIGRATIONS_[A-Z0-9_]+$/u.test(error.code)) throw error;
    fail(`POSTGRES_TEST_MIGRATIONS_${role.toUpperCase()}_RUNTIME_GRANT_FAILED`);
  } finally {
    if (client !== undefined) {
      try {
        await client.release(discard || transactionOpen);
      } catch {
        fail(`POSTGRES_TEST_MIGRATIONS_${role.toUpperCase()}_RUNTIME_PRIVILEGES_RELEASE_FAILED`);
      }
    }
  }
}

async function readBackReceipts(pool, role, target, expected) {
  let client;
  let transactionOpen = false;
  let discard = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN READ ONLY");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout='30000ms'");
    await client.query("SET LOCAL lock_timeout='5000ms'");
    const receiptRows = rowsFrom(await client.query(
      `SELECT version, name, checksum_sha256
         FROM ${quoteSchema(target.schema)}."${HISTORY_TABLE}"
        ORDER BY version`,
    ), `POSTGRES_TEST_MIGRATIONS_${role.toUpperCase()}_RECEIPT_READ_FAILED`);
    if (receiptRows.length !== expected.length) {
      fail(`POSTGRES_TEST_MIGRATIONS_${role.toUpperCase()}_RECEIPT_MISMATCH`);
    }
    for (let index = 0; index < expected.length; index += 1) {
      const actual = receiptRows[index];
      const wanted = expected[index];
      if (actual?.version !== wanted.version
          || actual?.name !== wanted.name
          || actual?.checksum_sha256 !== wanted.sha256) {
        fail(`POSTGRES_TEST_MIGRATIONS_${role.toUpperCase()}_RECEIPT_MISMATCH`);
      }
    }
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    discard = true;
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
        transactionOpen = false;
      } catch {
        fail(`POSTGRES_TEST_MIGRATIONS_${role.toUpperCase()}_RECEIPT_ROLLBACK_FAILED`);
      }
    }
    if (typeof error?.code === "string"
        && /^POSTGRES_TEST_MIGRATIONS_[A-Z0-9_]+$/u.test(error.code)) throw error;
    fail(`POSTGRES_TEST_MIGRATIONS_${role.toUpperCase()}_RECEIPT_READ_FAILED`);
  } finally {
    if (client !== undefined) {
      try {
        await client.release(discard || transactionOpen);
      } catch {
        fail(`POSTGRES_TEST_MIGRATIONS_${role.toUpperCase()}_RECEIPT_RELEASE_FAILED`);
      }
    }
  }
}

/** Fetch the attached service account identity from the Cloud Run metadata server. */
export async function readAttachedServiceAccountEmail({
  fetchImpl = globalThis.fetch,
  timeoutMilliseconds = METADATA_TIMEOUT_MILLISECONDS,
} = {}) {
  if (typeof fetchImpl !== "function"
      || !Number.isSafeInteger(timeoutMilliseconds)
      || timeoutMilliseconds < 1 || timeoutMilliseconds > 10_000) {
    fail("CLOUD_RUN_TEST_MIGRATIONS_METADATA_UNAVAILABLE");
  }
  let response;
  try {
    response = await fetchImpl(METADATA_EMAIL_URL, {
      method: "GET",
      headers: { "Metadata-Flavor": "Google" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
  } catch {
    fail("CLOUD_RUN_TEST_MIGRATIONS_METADATA_UNAVAILABLE");
  }
  if (response?.status !== 200
      || response.headers?.get("Metadata-Flavor") !== "Google") {
    fail("CLOUD_RUN_TEST_MIGRATIONS_METADATA_UNAVAILABLE");
  }
  let email;
  try { email = (await response.text()).trim(); } catch {
    fail("CLOUD_RUN_TEST_MIGRATIONS_METADATA_UNAVAILABLE");
  }
  if (email !== TEST_MIGRATIONS_SERVICE_ACCOUNT) {
    fail("CLOUD_RUN_TEST_MIGRATIONS_SERVICE_ACCOUNT_INVALID");
  }
  return email;
}

function migrationPlans(profile) {
  if (profile === A2_PROFILE) {
    return Object.freeze(Object.entries(TEST_MIGRATIONS_TARGETS).map(([role, target]) =>
      Object.freeze({ name: role, role, poolKey: role, target }),
    ));
  }
  if (profile === GRAPH_BENCHMARK_PROFILE) {
    return Object.freeze(GRAPH_BENCHMARK_MIGRATION_TARGETS.map((target) =>
      Object.freeze({ name: target.name, role: "primary", poolKey: "primary", target }),
    ));
  }
  fail("CLOUD_RUN_TEST_MIGRATIONS_PROFILE_INVALID");
}

/** Validate the exact profile target and one-task Cloud Run Job execution contract. */
function validateJobEnvironment(env, profile = A2_PROFILE) {
  const plans = migrationPlans(profile);
  const expectedJob = profile === A2_PROFILE
    ? TEST_MIGRATIONS_JOB
    : GRAPH_BENCHMARK_MIGRATIONS_JOB;
  if (env === null || typeof env !== "object"
      || env.CLOUD_RUN_JOB !== expectedJob
      || !EXECUTION_PATTERN.test(env.CLOUD_RUN_EXECUTION ?? "")
      || env.CLOUD_RUN_TASK_INDEX !== "0"
      || env.CLOUD_RUN_TASK_COUNT !== "1"
      || env.CLOUD_RUN_TASK_ATTEMPT !== "0"
      || env.GOOGLE_CLOUD_PROJECT !== TEST_MIGRATIONS_PROJECT
      || env.K_SERVICE !== undefined) {
    fail("CLOUD_RUN_TEST_MIGRATIONS_JOB_CONTEXT_INVALID");
  }
  if (env.POSTGRES_MIGRATOR_IAM_USER !== TEST_MIGRATIONS_IAM_USER) {
    fail("POSTGRES_TEST_MIGRATIONS_IAM_USER_INVALID");
  }
  if (profile === A2_PROFILE) {
    for (const [role, target] of Object.entries(TEST_MIGRATIONS_TARGETS)) {
      const prefix = role.toUpperCase();
      if (env[`${prefix}_DATABASE`] !== target.database
          || env[`${prefix}_SCHEMA`] !== target.schema
          || env[`${prefix}_INSTANCE_CONNECTION_NAME`] !== target.instanceConnectionName) {
        fail(`POSTGRES_TEST_MIGRATIONS_${prefix}_TARGET_INVALID`);
      }
    }
  } else {
    const target = GRAPH_BENCHMARK_MIGRATION_TARGETS[0];
    if (env.PRIMARY_DATABASE !== target.database
        || env.PRIMARY_INSTANCE_CONNECTION_NAME !== target.instanceConnectionName
        || env.PRIMARY_SCHEMA !== undefined
        || env.LEDGER_DATABASE !== undefined
        || env.LEDGER_SCHEMA !== undefined
        || env.LEDGER_INSTANCE_CONNECTION_NAME !== undefined) {
      fail("POSTGRES_TEST_MIGRATIONS_BENCHMARK_TARGET_INVALID");
    }
  }
  return Object.freeze({
    job: expectedJob,
    profile,
    execution: env.CLOUD_RUN_EXECUTION,
    project: TEST_MIGRATIONS_PROJECT,
    serviceAccount: TEST_MIGRATIONS_SERVICE_ACCOUNT,
    migratorIamUser: TEST_MIGRATIONS_IAM_USER,
    ...(profile === A2_PROFILE ? { targets: TEST_MIGRATIONS_TARGETS } : {}),
    plans,
  });
}

export function parseTestMigrationsConfig(env, attachedServiceAccountEmail, profile = A2_PROFILE) {
  const config = validateJobEnvironment(env, profile);
  if (attachedServiceAccountEmail !== TEST_MIGRATIONS_SERVICE_ACCOUNT) {
    fail("CLOUD_RUN_TEST_MIGRATIONS_SERVICE_ACCOUNT_INVALID");
  }
  return config;
}

function migrationSummary(role, manifest) {
  const entries = manifest.roles[role];
  const latest = entries.at(-1);
  return Object.freeze({
    applied: entries.length,
    expected: entries.length,
    latest: Object.freeze({
      version: latest.version,
      name: latest.name,
      sha256: latest.sha256,
    }),
    manifestSha256: manifest.sha256,
  });
}

/** Apply the one pinned test migration set; repeated invocations converge through the canonical runner. */
export async function runTestMigrations({
  env = process.env,
  dependencies = {},
  profile = A2_PROFILE,
} = {}) {
  // Reject wrong jobs and targets before metadata credentials or SQL clients are touched.
  validateJobEnvironment(env, profile);
  return runConfiguredTestMigrations({ env, dependencies, profile });
}

async function runConfiguredTestMigrations({ env, dependencies, profile }) {
  // Validate the non-identity portion separately to avoid accepting an
  // environment-provided service-account value as proof of the attached identity.
  const attachedServiceAccountEmail = await (dependencies.readServiceAccountEmail
    ?? readAttachedServiceAccountEmail)({ fetchImpl: dependencies.fetchImpl });
  const config = parseTestMigrationsConfig(env, attachedServiceAccountEmail, profile);
  const migrationRoot = TEST_MIGRATIONS_ROOT;
  let manifest;
  try {
    manifest = validateManifest(await (dependencies.buildManifest ?? buildPostgresMigrationManifest)({
      rootDirectory: migrationRoot,
    }));
  } catch (error) {
    if (typeof error?.code === "string"
        && /^POSTGRES_TEST_MIGRATIONS_[A-Z0-9_]+$/u.test(error.code)) throw error;
    fail("POSTGRES_TEST_MIGRATIONS_MANIFEST_INVALID");
  }

  const connectorFactory = dependencies.createConnector ?? (() => new Connector());
  const createPool = dependencies.createPool ?? createCloudSqlIamPool;
  const applyMigrations = dependencies.applyMigrations ?? applyPostgresMigrations;
  const closeResources = dependencies.closeResources ?? closeCloudSqlResources;
  let connector;
  const pools = {};
  let result;
  let operationError;
  try {
    try {
      connector = connectorFactory();
    } catch {
      fail("CLOUD_SQL_TEST_MIGRATIONS_CONNECTOR_CREATE_FAILED");
    }
    const poolPlans = new Map(config.plans.map(({ poolKey, role, target }) => [poolKey, { role, target }]));
    for (const [poolKey, { role, target }] of poolPlans) {
      try {
        pools[poolKey] = await createPool({
          connector,
          instanceConnectionName: target.instanceConnectionName,
          database: target.database,
          user: TEST_MIGRATIONS_IAM_USER,
          max: 1,
          applicationName: MIGRATOR_APPLICATION_NAME,
        });
      } catch {
        fail(`CLOUD_SQL_TEST_MIGRATIONS_${role.toUpperCase()}_CONNECT_FAILED`);
      }
    }
    for (const { poolKey, role, target } of config.plans) {
      await ensureSchema(pools[poolKey], role, target);
    }
    const targetSummaries = {};
    for (const { name, poolKey, role, target } of config.plans) {
      const expected = expectedReceipts(manifest, role);
      let applied;
      try {
        applied = await applyMigrations({
          role,
          schema: target.schema,
          pool: pools[poolKey],
          rootDirectory: migrationRoot,
        });
      } catch (error) {
        const code = safeErrorCode(error, `POSTGRES_TEST_MIGRATIONS_${role.toUpperCase()}_APPLY_FAILED`);
        fail(code);
      }
      validateApplyResult(applied, role, target, expected);
      await readBackReceipts(pools[poolKey], role, target, expected);
      await grantAndVerifyRuntimePrivileges(pools[poolKey], role, target);
      targetSummaries[name] = profile === A2_PROFILE
        ? migrationSummary(role, manifest)
        : Object.freeze({ schema: target.schema, ...migrationSummary(role, manifest) });
    }
    const migrations = profile === A2_PROFILE
      ? Object.freeze({
        primary: targetSummaries.primary,
        ledger: targetSummaries.ledger,
      })
      : Object.freeze({
        primarySchemas: Object.freeze(config.plans.map(({ name }) => targetSummaries[name])),
      });
    result = Object.freeze({
      status: "ok",
      mode: "migrate",
      job: config.job,
      ...(profile === A2_PROFILE ? {} : { profile }),
      execution: config.execution,
      project: config.project,
      migrations,
    });
  } catch (error) {
    operationError = error;
  }

  let cleanupError;
  try {
    await closeResources({ pools: Object.values(pools), connector });
  } catch {
    cleanupError = new Error("CLOUD_SQL_TEST_MIGRATIONS_CLEANUP_FAILED");
    cleanupError.code = "CLOUD_SQL_TEST_MIGRATIONS_CLEANUP_FAILED";
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  return result;
}

function invokedDirectly() {
  return typeof process.argv[1] === "string"
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) {
  const profileArgument = process.argv.slice(2);
  const profile = profileArgument.length === 0
    ? A2_PROFILE
    : profileArgument.length === 1 && profileArgument[0] === `--profile=${GRAPH_BENCHMARK_PROFILE}`
      ? GRAPH_BENCHMARK_PROFILE
      : null;
  if (profile === null) {
    console.error(JSON.stringify({ status: "error", code: "CLOUD_RUN_TEST_MIGRATIONS_ARGUMENTS_INVALID" }));
    process.exitCode = 1;
  } else {
    try {
      const result = await runTestMigrations({ profile });
      console.log(JSON.stringify(result));
    } catch (error) {
      const code = safeErrorCode(error, "POSTGRES_TEST_MIGRATIONS_FAILED");
      console.error(JSON.stringify({ status: "error", code }));
      process.exitCode = 1;
    }
  }
}
