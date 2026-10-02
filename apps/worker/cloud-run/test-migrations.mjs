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
import {
  ensureSchema as ensureRoleSchema,
  grantAndVerifyRuntimePrivileges as grantAndVerifyRoleRuntimePrivileges,
  OPERATOR_ONLY_PRIMARY_FUNCTIONS,
  readBackReceipts as readBackRoleReceipts,
  RUNTIME_PRIMARY_FUNCTIONS,
} from "./postgres-runtime-grants.mjs";

export { functionSignature, restrictedFunctionsMatchPolicy } from "./postgres-runtime-grants.mjs";

export const TEST_MIGRATIONS_JOB = "tibotattle-test-database-migrate";
export const GRAPH_BENCHMARK_MIGRATIONS_JOB = "tibotattle-public-graph-benchmark-migrate";
export const TEST_MIGRATIONS_PROJECT = "tibotattle";
export const TEST_MIGRATIONS_SERVICE_ACCOUNT =
  "tibotattle-test-migrator@tibotattle.iam.gserviceaccount.com";
export const TEST_MIGRATIONS_IAM_USER = "tibotattle-test-migrator@tibotattle.iam";
export const TEST_MIGRATIONS_RUNTIME_IAM_USER = "tibotattle-test-runtime@tibotattle.iam";
export const TEST_MIGRATIONS_ROOT = "/app/apps/worker/postgres/migrations";
// Primary only (LEAD-SIMP; decisions D2, D4 and D6): the canonical runner
// and manifest have no ledger role. The A2 ledger schema on the retired test
// ledger instance is no longer a target (owner action OA-4); whether the A2
// primary is migrated past 0063 is owner decision OD-6, and 0064 refuses a
// schema that still holds erasure residue.
export const TEST_MIGRATIONS_TARGETS = Object.freeze({
  primary: Object.freeze({
    instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
    database: "tibotattle",
    schema: "tibotattle_v12_a2_20260925",
    expectedMigrations: 64,
  }),
});
export const GRAPH_BENCHMARK_MIGRATION_TARGETS = Object.freeze([
  Object.freeze({
    name: "10k",
    instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
    database: "tibotattle",
    schema: "tibotattle_graph_benchmark_10k_20260925",
    expectedMigrations: 64,
  }),
  Object.freeze({
    name: "100k",
    instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
    database: "tibotattle",
    schema: "tibotattle_graph_benchmark_100k_20260925",
    expectedMigrations: 64,
  }),
  Object.freeze({
    name: "100k-insights",
    instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
    database: "tibotattle",
    schema: "tibotattle_graph_benchmark_100k_insights_20260925",
    expectedMigrations: 64,
  }),
  Object.freeze({
    name: "100k-paged",
    instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
    database: "tibotattle",
    schema: "tibotattle_graph_benchmark_100k_paged_20260925",
    expectedMigrations: 64,
  }),
  Object.freeze({
    name: "100k-readpaged",
    instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
    database: "tibotattle",
    schema: "tibotattle_graph_benchmark_100k_readpaged_20260925",
    expectedMigrations: 64,
  }),
  Object.freeze({
    name: "100k-readindexed",
    instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
    database: "tibotattle",
    schema: "tibotattle_graph_benchmark_100k_readindexed_20260925",
    expectedMigrations: 64,
  }),
  Object.freeze({
    name: "100k-batched",
    instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
    database: "tibotattle",
    schema: "tibotattle_graph_benchmark_100k_batched_20260925",
    expectedMigrations: 64,
  }),
]);

// The fast-path rehearsal target is a separate, disposable database on the
// test primary instance, so the database-scoped tibotattle_transfer control
// schema installed by primary 0056 never enters the shared `tibotattle` test
// database. The orphan ledger schema an earlier migrate created there is no
// longer a target. The expected count comes from the deploying checkout's
// migration directory (job environment) and must equal the image manifest;
// it is not pinned.
export const FASTPATH_MIGRATIONS_JOB = "tibotattle-fastpath-test-migrate";
export const FASTPATH_MIGRATION_PROFILE = "fastpath";
export const FASTPATH_MIGRATION_TARGETS = Object.freeze({
  primary: Object.freeze({
    instanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
    database: "tibotattle_fastpath",
    schema: "tibotattle_fastpath_20261001",
  }),
});
const EXPECTED_MIGRATION_COUNT_PATTERN = /^[1-9]\d{0,3}$/u;

/**
 * The runtime-grant policy lives in postgres-runtime-grants.mjs, shared with
 * the production migration job (OPS-10) and scripts/gcp-test-database.mjs.
 * These names are the same frozen values under their test-era export names.
 */
export const TEST_RUNTIME_PRIMARY_FUNCTIONS = RUNTIME_PRIMARY_FUNCTIONS;
export const TEST_OPERATOR_ONLY_PRIMARY_FUNCTIONS = OPERATOR_ONLY_PRIMARY_FUNCTIONS;

const A2_PROFILE = "a2";
export const GRAPH_BENCHMARK_MIGRATION_PROFILE = "community-graph-benchmark";
const GRAPH_BENCHMARK_PROFILE = GRAPH_BENCHMARK_MIGRATION_PROFILE;
const FASTPATH_PROFILE = FASTPATH_MIGRATION_PROFILE;

const EXECUTION_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const MIGRATION_NAME_PATTERN = /^\d{4}_[a-z][a-z0-9_-]*\.sql$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
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

/** The pinned primary migration count of the A2 and benchmark profiles. */
const PINNED_MIGRATION_COUNTS = Object.freeze(Object.fromEntries(
  Object.entries(TEST_MIGRATIONS_TARGETS).map(([role, target]) => [role, target.expectedMigrations]),
));

/**
 * Validate the image manifest's structure and digest. The A2 and benchmark
 * profiles pin each role's count (PINNED_MIGRATION_COUNTS); the fastpath
 * profile instead passes the counts the deploying commit's migration
 * directory holds, and a manifest that differs from them is refused with
 * POSTGRES_TEST_MIGRATIONS_FASTPATH_EXPECTED_COUNT_MISMATCH.
 */
function validateManifest(manifest, { expectedCounts = PINNED_MIGRATION_COUNTS, countMismatchCode } = {}) {
  if (manifest === null || typeof manifest !== "object"
      || manifest.schemaVersion !== "tibotattle-postgres-migration-manifest-v2"
      || !SHA256_PATTERN.test(manifest.sha256 ?? "")
      || manifest.roles === null || typeof manifest.roles !== "object"
      || Object.keys(manifest.roles).join(",") !== "primary") {
    fail("POSTGRES_TEST_MIGRATIONS_MANIFEST_INVALID");
  }
  for (const role of Object.keys(TEST_MIGRATIONS_TARGETS)) {
    const migrations = manifest.roles[role];
    if (!Array.isArray(migrations)) fail("POSTGRES_TEST_MIGRATIONS_MANIFEST_INVALID");
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
  for (const role of Object.keys(TEST_MIGRATIONS_TARGETS)) {
    if (manifest.roles[role].length !== expectedCounts[role]) {
      fail(countMismatchCode ?? "POSTGRES_TEST_MIGRATIONS_MANIFEST_INVALID");
    }
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

const TEST_MIGRATIONS_CODE_PREFIX = "POSTGRES_TEST_MIGRATIONS_";

export async function ensureSchema(pool, role, target) {
  return ensureRoleSchema(pool, {
    role,
    schema: target.schema,
    ownerRole: TEST_MIGRATIONS_IAM_USER,
    codePrefix: TEST_MIGRATIONS_CODE_PREFIX,
  });
}

export async function grantAndVerifyRuntimePrivileges(pool, role, target) {
  return grantAndVerifyRoleRuntimePrivileges(pool, {
    role,
    schema: target.schema,
    runtimeRole: TEST_MIGRATIONS_RUNTIME_IAM_USER,
    codePrefix: TEST_MIGRATIONS_CODE_PREFIX,
  });
}

export async function readBackReceipts(pool, role, target, expected) {
  return readBackRoleReceipts(pool, {
    role,
    schema: target.schema,
    expected,
    codePrefix: TEST_MIGRATIONS_CODE_PREFIX,
  });
}

/**
 * Apply and read back the runtime role's exact grants on one migrated schema.
 * The fast-path seed reuses this policy for the rehearsal-target schema it
 * creates in the disposable fast-path database; it is not a second policy.
 */
export async function grantAndVerifyTestRuntimePrivileges(pool, role, schema) {
  if (role !== "primary") fail("POSTGRES_TEST_MIGRATIONS_ROLE_INVALID");
  return grantAndVerifyRuntimePrivileges(pool, role, { schema });
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
  if (profile === FASTPATH_PROFILE) {
    return Object.freeze(Object.entries(FASTPATH_MIGRATION_TARGETS).map(([role, target]) =>
      Object.freeze({ name: role, role, poolKey: "fastpath", target }),
    ));
  }
  fail("CLOUD_RUN_TEST_MIGRATIONS_PROFILE_INVALID");
}

function expectedJobForProfile(profile) {
  if (profile === A2_PROFILE) return TEST_MIGRATIONS_JOB;
  if (profile === FASTPATH_PROFILE) return FASTPATH_MIGRATIONS_JOB;
  return GRAPH_BENCHMARK_MIGRATIONS_JOB;
}

function fastpathExpectedCounts(env) {
  const counts = {};
  for (const role of Object.keys(FASTPATH_MIGRATION_TARGETS)) {
    const raw = env[`${role.toUpperCase()}_EXPECTED_MIGRATIONS`];
    if (!EXPECTED_MIGRATION_COUNT_PATTERN.test(raw ?? "")) {
      fail("POSTGRES_TEST_MIGRATIONS_FASTPATH_EXPECTED_COUNT_INVALID");
    }
    counts[role] = Number(raw);
  }
  return Object.freeze(counts);
}

/** Validate the exact profile target and one-task Cloud Run Job execution contract. */
function validateJobEnvironment(env, profile = A2_PROFILE) {
  const plans = migrationPlans(profile);
  const expectedJob = expectedJobForProfile(profile);
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
  // No profile has a ledger target any more: a LEDGER_ setting is a stale
  // deployment and is refused before any target is read.
  if (Object.keys(env).some((name) => name.startsWith("LEDGER_"))) {
    fail("POSTGRES_TEST_MIGRATIONS_LEDGER_TARGET_RETIRED");
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
  } else if (profile === FASTPATH_PROFILE) {
    for (const [role, target] of Object.entries(FASTPATH_MIGRATION_TARGETS)) {
      const prefix = role.toUpperCase();
      if (env[`${prefix}_DATABASE`] !== target.database
          || env[`${prefix}_SCHEMA`] !== target.schema
          || env[`${prefix}_INSTANCE_CONNECTION_NAME`] !== target.instanceConnectionName) {
        fail("POSTGRES_TEST_MIGRATIONS_FASTPATH_TARGET_INVALID");
      }
    }
  } else {
    const target = GRAPH_BENCHMARK_MIGRATION_TARGETS[0];
    if (env.PRIMARY_DATABASE !== target.database
        || env.PRIMARY_INSTANCE_CONNECTION_NAME !== target.instanceConnectionName
        || env.PRIMARY_SCHEMA !== undefined) {
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
    ...(profile === FASTPATH_PROFILE
      ? { targets: FASTPATH_MIGRATION_TARGETS, expectedCounts: fastpathExpectedCounts(env) }
      : {}),
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
  // A2 and the benchmark keep their pinned target counts; the fastpath profile
  // checks the image manifest against the deploying commit's counts instead.
  const countPolicy = profile === FASTPATH_PROFILE
    ? { expectedCounts: config.expectedCounts,
      countMismatchCode: "POSTGRES_TEST_MIGRATIONS_FASTPATH_EXPECTED_COUNT_MISMATCH" }
    : {};
  let manifest;
  try {
    manifest = validateManifest(await (dependencies.buildManifest ?? buildPostgresMigrationManifest)({
      rootDirectory: migrationRoot,
    }), countPolicy);
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
    // The first plan for a shared pool names its connect-failure code.
    const poolPlans = new Map();
    for (const { poolKey, role, target } of config.plans) {
      if (!poolPlans.has(poolKey)) poolPlans.set(poolKey, { role, target });
    }
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
    const migrations = profile === A2_PROFILE || profile === FASTPATH_PROFILE
      ? Object.freeze({
        primary: targetSummaries.primary,
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
      : profileArgument.length === 1 && profileArgument[0] === `--profile=${FASTPATH_PROFILE}`
        ? FASTPATH_PROFILE
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
