/**
 * Local checks for the MP-2-lite maintenance Job entry
 * (postgres-maintenance-job.mjs): the closed argument and environment
 * contract, the OD-2 history proof, the minute cycle, the composition with
 * injected synthetic dependencies (no database, no network), and the dist
 * build entry. Every value is synthetic. The PostgreSQL behaviour of the pass
 * is qualified by postgres-test/postgres-lifecycle-pass.spec.mjs.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createServer } from "vite";

const ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(ROOT, "..");

const vite = await createServer({
  root: WORKER_ROOT,
  configFile: false,
  logLevel: "silent",
  server: { middlewareMode: true, ws: false },
  appType: "custom",
});
const job = await vite.ssrLoadModule("/cloud-run/postgres-maintenance-job.mjs");
const configuration = await vite.ssrLoadModule("/cloud-run/postgres-production-configuration.mjs");
const pass = await vite.ssrLoadModule("/src/postgres-lifecycle-pass.ts");
const { CLOUD_RUN_IAM_TEST_TARGET } = await vite.ssrLoadModule("/cloud-run/cloud-run-iam-test-target.mjs");
after(async () => { await vite.close(); });

const IDENTITY_LINK_SECRET = "synthetic-identity-link-secret-value-0000000001";
const GITHUB_TOKEN = "synthetic-github-token-value-4";
const BUCKET = "synthetic-origin-quarantine";
const STAGING_BUCKET = "synthetic-staging-quarantine";

function proof(bucket, extra = {}) {
  return {
    bucket,
    bucketGeneration: "1700000000000001",
    bucketMetageneration: "1",
    softDeleteRetentionDurationSeconds: "0",
    ...extra,
  };
}

function productionJobEnv(overrides = {}) {
  return {
    CLOUD_RUN_JOB: "tibotattle-maintenance",
    DEPLOYMENT_SOURCE_COMMIT: "0123456789abcdef0123456789abcdef01234567",
    TELEMETRY_STORAGE_NAMESPACE: "synthetic-namespace",
    PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:origin-primary",
    PRIMARY_DATABASE: "origin_primary",
    PRIMARY_SCHEMA: "origin_primary",
    POSTGRES_IAM_USER: "origin-runtime@synthetic-project.iam",
    GCS_BUCKET_NAME: BUCKET,
    GCS_QUARANTINE_BUCKET_HISTORY_PROOF: JSON.stringify(proof(BUCKET)),
    POSTGRES_SCHEDULED_MAINTENANCE_ENABLED: "enabled",
    IDENTITY_LINK_SECRET,
    DISTRIBUTION_GITHUB_API_TOKEN: GITHUB_TOKEN,
    ...overrides,
  };
}

function stagingJobEnv(overrides = {}) {
  const env = {
    ...productionJobEnv(),
    CLOUD_RUN_JOB: "tibotattle-staging-maintenance",
    PUBLIC_ORIGIN: "https://staging.synthetic.example",
    ADMIN_HOST_ORIGIN: "https://admin.staging.synthetic.example",
    TELEMETRY_STORAGE_NAMESPACE: "synthetic-staging-namespace",
    PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:origin-staging-primary",
    GCS_BUCKET_NAME: STAGING_BUCKET,
    GCS_QUARANTINE_BUCKET_HISTORY_PROOF: JSON.stringify(proof(STAGING_BUCKET)),
    ACCESS_TEAM_DOMAIN: "synthetic.cloudflareaccess.com",
    ACCESS_AUD: "a".repeat(64),
    ACCESS_ADMIN_EMAIL: "owner@synthetic.example",
    IDENTITY_LINK_SECRET_VERSION: "staging-v1",
    GOOGLE_OIDC_CLIENT_ID: "123456789012-syntheticstaging.apps.googleusercontent.com",
    APPLE_SERVICES_ID: "example.synthetic.staging",
    APPLE_KEY_ID: "SYNTHKEY01",
    APPLE_TEAM_ID: "SYNTHTEAM1",
    ...overrides,
  };
  delete env.DISTRIBUTION_GITHUB_API_TOKEN;
  return env;
}

function without(env, ...names) {
  const copy = { ...env };
  for (const name of names) delete copy[name];
  return copy;
}

function code(expected) {
  return (error) => {
    assert.equal(error?.code, expected);
    assert.equal(error.message, expected);
    return true;
  };
}

test("arguments are closed: --help alone or exactly one known --profile", () => {
  assert.deepEqual({ ...job.parsePostgresMaintenanceJobArguments(["--help"]) }, { help: true, profile: null });
  for (const profile of job.POSTGRES_MAINTENANCE_JOB_PROFILES) {
    assert.deepEqual({ ...job.parsePostgresMaintenanceJobArguments([`--profile=${profile}`]) },
      { help: false, profile });
  }
  assert.deepEqual([...job.POSTGRES_MAINTENANCE_JOB_PROFILES], ["maintenance-job", "staging-maintenance-job"]);
  const refusals = [
    [[], "POSTGRES_MAINTENANCE_JOB_PROFILE_MISSING"],
    [["--profile=production"], "POSTGRES_MAINTENANCE_JOB_PROFILE_INVALID"],
    [["--profile=analytics-job"], "POSTGRES_MAINTENANCE_JOB_PROFILE_INVALID"],
    [["--profile="], "POSTGRES_MAINTENANCE_JOB_PROFILE_INVALID"],
    [["--profile=maintenance-job", "--profile=maintenance-job"], "POSTGRES_MAINTENANCE_JOB_ARGUMENTS_INVALID"],
    [["--profile=maintenance-job", "--scheduled"], "POSTGRES_MAINTENANCE_JOB_ARGUMENTS_INVALID"],
    [["--schema=origin_primary"], "POSTGRES_MAINTENANCE_JOB_ARGUMENTS_INVALID"],
    [["maintenance-job"], "POSTGRES_MAINTENANCE_JOB_ARGUMENTS_INVALID"],
    [["--help", "--profile=maintenance-job"], "POSTGRES_MAINTENANCE_JOB_ARGUMENTS_INVALID"],
    [["--profile", "maintenance-job"], "POSTGRES_MAINTENANCE_JOB_ARGUMENTS_INVALID"],
  ];
  for (const [argv, expected] of refusals) {
    assert.throws(() => job.parsePostgresMaintenanceJobArguments(argv), (error) => {
      assert.equal(error.code, expected, argv.join(" "));
      assert.equal(error.usage, true);
      return true;
    });
  }
  assert.throws(() => job.parsePostgresMaintenanceJobArguments("--help"),
    code("POSTGRES_MAINTENANCE_JOB_ARGUMENTS_INVALID"));
  assert.throws(() => job.parsePostgresMaintenanceJobArguments([1]),
    code("POSTGRES_MAINTENANCE_JOB_ARGUMENTS_INVALID"));
});

test("both profiles accept their synthetic environment and keep secrets out of the result", () => {
  const production = job.readPostgresMaintenanceJobConfiguration(productionJobEnv(), "maintenance-job");
  assert.deepEqual(Object.keys(production), ["profile", "plane", "primary", "iamUser", "bucket", "historyProof"]);
  assert.equal(production.plane, "production");
  assert.deepEqual({ ...production.primary }, {
    instanceConnectionName: "synthetic-project:us-east1:origin-primary",
    database: "origin_primary",
    schema: "origin_primary",
  });
  assert.equal(production.bucket, BUCKET);
  assert.deepEqual({ ...production.historyProof }, proof(BUCKET));
  assert.ok(Object.isFrozen(production));
  const text = JSON.stringify(production);
  assert.equal(text.includes(IDENTITY_LINK_SECRET), false);
  assert.equal(text.includes(GITHUB_TOKEN), false);

  const staging = job.readPostgresMaintenanceJobConfiguration(stagingJobEnv(), "staging-maintenance-job");
  assert.equal(staging.plane, "staging");
  assert.equal(staging.bucket, STAGING_BUCKET);

  assert.deepEqual({ ...staging.historyProof }, proof(STAGING_BUCKET));
});

test("the job's own refusals come first and hold even for empty values", () => {
  const cases = [
    [productionJobEnv({ HOST_MODE: "production" }), "POSTGRES_MAINTENANCE_JOB_HOST_MODE_FORBIDDEN"],
    [productionJobEnv({ HOST_MODE: "" }), "POSTGRES_MAINTENANCE_JOB_HOST_MODE_FORBIDDEN"],
    [productionJobEnv({ K_SERVICE: "tibotattle-origin" }), "POSTGRES_MAINTENANCE_JOB_CONTEXT_INVALID"],
    [productionJobEnv({ PG_TEST_SOCKET: "" }), "POSTGRES_MAINTENANCE_JOB_LOCAL_ENDPOINT_FORBIDDEN"],
    [productionJobEnv({ PG_TEST_HOST: "127.0.0.1" }), "POSTGRES_MAINTENANCE_JOB_LOCAL_ENDPOINT_FORBIDDEN"],
    [productionJobEnv({ POSTGRES_MAINTENANCE_JOB_PAGE_SIZE: "500" }), "POSTGRES_MAINTENANCE_JOB_TUNABLE_FORBIDDEN"],
    [without(productionJobEnv(), "CLOUD_RUN_JOB"), "POSTGRES_MAINTENANCE_JOB_CONTEXT_INVALID"],
    [productionJobEnv({ CLOUD_RUN_JOB: "" }), "POSTGRES_MAINTENANCE_JOB_CONTEXT_INVALID"],
  ];
  for (const [env, expected] of cases) {
    assert.throws(() => job.readPostgresMaintenanceJobConfiguration(env, "maintenance-job"), code(expected));
  }
  assert.throws(() => job.readPostgresMaintenanceJobConfiguration(null, "maintenance-job"),
    code("POSTGRES_MAINTENANCE_JOB_ENVIRONMENT_INVALID"));
  assert.throws(() => job.readPostgresMaintenanceJobConfiguration(productionJobEnv(), "production"),
    code("POSTGRES_MAINTENANCE_JOB_PROFILE_INVALID"));
});

test("the shared production configuration's refusals pass through unchanged", () => {
  const cases = [
    [without(productionJobEnv(), "POSTGRES_SCHEDULED_MAINTENANCE_ENABLED"), "POSTGRES_SCHEDULED_MAINTENANCE_DISABLED"],
    [productionJobEnv({ POSTGRES_SCHEDULED_MAINTENANCE_ENABLED: "true" }), "POSTGRES_SCHEDULED_MAINTENANCE_DISABLED"],
    [without(productionJobEnv(), "IDENTITY_LINK_SECRET"), "IDENTITY_LINK_SECRET_MISSING"],
    [without(productionJobEnv(), "PRIMARY_SCHEMA"), "PRIMARY_SCHEMA_MISSING"],
    [without(productionJobEnv(), "DEPLOYMENT_SOURCE_COMMIT"), "DEPLOYMENT_SOURCE_COMMIT_MISSING"],
    [productionJobEnv({ LEDGER_SCHEMA: "" }), "LEDGER_SCHEMA_FORBIDDEN"],
    [productionJobEnv({ LEDGER_ANYTHING: "x" }), "LEDGER_CONFIGURATION_FORBIDDEN"],
    [productionJobEnv({ GCS_ERASURE_BUCKET_HISTORY_PROOF: JSON.stringify(proof(BUCKET)) }),
      "GCS_ERASURE_BUCKET_HISTORY_PROOF_FORBIDDEN"],
    [productionJobEnv({ POSTGRES_TEST_HTTP_MODE: "fastpath-test" }), "POSTGRES_TEST_HTTP_MODE_FORBIDDEN"],
    [productionJobEnv({ POSTGRES_RATE_LIMIT_SECRET: "x".repeat(40) }), "POSTGRES_RATE_LIMIT_SECRET_PROFILE_FORBIDDEN"],
    [productionJobEnv({
      PRIMARY_INSTANCE_CONNECTION_NAME: CLOUD_RUN_IAM_TEST_TARGET.postgres.primary.instanceConnectionName,
    }), "PRIMARY_INSTANCE_CONNECTION_NAME_TEST_TARGET_FORBIDDEN"],
  ];
  for (const [env, expected] of cases) {
    assert.throws(() => job.readPostgresMaintenanceJobConfiguration(env, "maintenance-job"), code(expected));
  }
  // The staging profile refuses the production plane's own variable set.
  assert.throws(() => job.readPostgresMaintenanceJobConfiguration(productionJobEnv(), "staging-maintenance-job"),
    (error) => typeof error?.code === "string" && error.code.endsWith("_MISSING"));
});

test("the OD-2 quarantine history proof is CR-3's one parse: required, closed and bound to the bucket", () => {
  const name = "GCS_QUARANTINE_BUCKET_HISTORY_PROOF";
  // The job's proof is exactly CR-3's resources.bucketHistoryProof: one parser, one set of codes.
  const env = productionJobEnv();
  assert.deepEqual({ ...job.readPostgresMaintenanceJobConfiguration(env, "maintenance-job").historyProof },
    { ...configuration.readProductionConfiguration(env, "maintenance-job").resources.bucketHistoryProof });
  assert.equal("POSTGRES_MAINTENANCE_JOB_HISTORY_PROOF_VARIABLE" in job, false);
  assert.equal("readPostgresMaintenanceJobHistoryProof" in job, false);
  const cases = [
    [without(productionJobEnv(), name), `${name}_MISSING`],
    [productionJobEnv({ [name]: "" }), `${name}_MISSING`],
    [productionJobEnv({ [name]: "{not json" }), `${name}_INVALID`],
    [productionJobEnv({ [name]: "null" }), `${name}_INVALID`],
    [productionJobEnv({ [name]: JSON.stringify([proof(BUCKET)]) }), `${name}_INVALID`],
    [productionJobEnv({ [name]: JSON.stringify(proof(BUCKET, { softDeleteRetentionDurationSeconds: "604800" })) }),
      `${name}_INVALID`],
    [productionJobEnv({ [name]: JSON.stringify(proof(BUCKET, { bucketGeneration: "not-a-generation" })) }),
      `${name}_INVALID`],
    // A bucket mismatch is CR-3's _INVALID (there is no separate mismatch code).
    [productionJobEnv({ [name]: JSON.stringify(proof("synthetic-other-bucket")) }), `${name}_INVALID`],
    // The closed four-key record only, as OPS-2 renders it: a receipt wrapper
    // or an extra key is refused.
    [productionJobEnv({ [name]: JSON.stringify({ schemaVersion: "synthetic", proof: proof(BUCKET) }) }),
      `${name}_INVALID`],
    [productionJobEnv({ [name]: JSON.stringify(proof(BUCKET, { extra: "1" })) }), `${name}_INVALID`],
    [productionJobEnv({ [name]: JSON.stringify(proof(BUCKET, { bucketGeneration: "0" })) }), `${name}_INVALID`],
  ];
  for (const [env, expected] of cases) {
    assert.throws(() => job.readPostgresMaintenanceJobConfiguration(env, "maintenance-job"), code(expected));
  }
  // The staging profile binds the proof to the staging bucket the same way.
  assert.throws(() => job.readPostgresMaintenanceJobConfiguration(
    stagingJobEnv({ [name]: JSON.stringify(proof(BUCKET)) }), "staging-maintenance-job"), code(`${name}_INVALID`));
});

test("the cycle is the start of the UTC minute, and a bad clock is refused", () => {
  const minute = Date.parse("2026-10-02T12:34:00.000Z");
  assert.equal(job.postgresMaintenanceJobCycle(minute), minute);
  assert.equal(job.postgresMaintenanceJobCycle(minute + 59_999), minute);
  assert.equal(job.postgresMaintenanceJobCycle(minute + 60_000), minute + 60_000);
  for (const value of [-1, 1.5, Number.NaN, "1", null]) {
    assert.throws(() => job.postgresMaintenanceJobCycle(value), code("POSTGRES_MAINTENANCE_JOB_CLOCK_INVALID"));
  }
});

test("only closed uppercase codes reach the output", () => {
  assert.equal(job.safePostgresMaintenanceJobCode({ code: "PRIMARY_SCHEMA_MISSING" }), "PRIMARY_SCHEMA_MISSING");
  assert.equal(job.safePostgresMaintenanceJobCode(new Error("POSTGRES_CONNECTION_FAILED")), "POSTGRES_CONNECTION_FAILED");
  for (const error of [{ code: "relation secret does not exist" }, { code: "42501" }, new Error("boom"),
    new Error("PRIVATE_SESSION_PATH"), { message: "POSTGRES_CONNECTION_FAILED" }, null]) {
    assert.equal(job.safePostgresMaintenanceJobCode(error), "POSTGRES_MAINTENANCE_JOB_FAILED");
  }
});

/** A pool whose lock session reports the lock as held by another run. */
function lockHeldPool(events) {
  return {
    async connect() {
      events.push("connect");
      return {
        async query(text) {
          assert.match(text, /pg_try_advisory_lock/u);
          return { rows: [{ acquired: false }], rowCount: 1 };
        },
        release(discard) { events.push(`release:${discard}`); },
      };
    },
    async end() { events.push("pool.end"); },
  };
}

test("the composition opens one primary pool of two, injects the bound store and closes everything", async () => {
  const events = [];
  const minute = Date.parse("2026-10-02T12:34:00.000Z");
  let poolOptions;
  let storeArguments;
  const result = await job.runPostgresMaintenanceJob({
    argv: ["--profile=maintenance-job"],
    env: productionJobEnv(),
    now: () => minute + 12_345,
    dependencies: {
      createConnector() { events.push("connector"); return { async close() { events.push("connector.close"); } }; },
      async createIamPool(options) { poolOptions = options; return lockHeldPool(events); },
      async createAccessTokenProvider() { return async () => "synthetic-access-token"; },
      createObjectStore(...args) {
        storeArguments = args;
        return { async head() { throw new Error("unused"); }, async delete() { throw new Error("unused"); } };
      },
    },
  });
  assert.deepEqual(Object.keys(poolOptions).sort(),
    ["applicationName", "connector", "database", "instanceConnectionName", "max", "user"]);
  assert.equal(poolOptions.max, 2);
  assert.equal(poolOptions.applicationName, "tibotattle-maintenance-job");
  assert.equal(poolOptions.instanceConnectionName, "synthetic-project:us-east1:origin-primary");
  assert.equal(poolOptions.database, "origin_primary");
  assert.equal(storeArguments[0], BUCKET);
  assert.equal(typeof storeArguments[1], "function");
  assert.deepEqual({ ...storeArguments[2] }, proof(BUCKET));
  assert.equal(result.exitCode, 0);
  assert.deepEqual(Object.keys(result.receipt), ["schemaVersion", "entry", "profile", "status", "pass"]);
  assert.equal(result.receipt.schemaVersion, "postgres-maintenance-job-v1");
  assert.equal(result.receipt.entry, "postgres-maintenance-job");
  assert.equal(result.receipt.status, "skipped");
  assert.equal(result.receipt.pass.code, "MAINTENANCE_IN_PROGRESS");
  assert.equal(result.receipt.pass.cycle, "2026-10-02T12:34:00.000Z");
  assert.equal(result.receipt.pass.changed, false);
  assert.deepEqual({ ...result.receipt.pass.appendOnlyNotApplicable }, {
    restoreReplayComplete: true, deletionTombstoneRetentionComplete: true, ownerErasureJobsComplete: true,
  });
  assert.deepEqual(events, ["connector", "connect", "release:false", "pool.end", "connector.close"]);
  const text = JSON.stringify(result.receipt);
  assert.equal(text.includes(IDENTITY_LINK_SECRET), false);
  assert.equal(text.includes("synthetic-access-token"), false);
});

test("a configuration refusal happens before any connector or pool exists", async () => {
  let created = 0;
  await assert.rejects(job.runPostgresMaintenanceJob({
    argv: ["--profile=maintenance-job"],
    env: productionJobEnv({ HOST_MODE: "production" }),
    dependencies: {
      createConnector() { created += 1; return { async close() {} }; },
      async createIamPool() { created += 1; throw new Error("unreachable"); },
    },
  }), code("POSTGRES_MAINTENANCE_JOB_HOST_MODE_FORBIDDEN"));
  assert.equal(created, 0);
  assert.deepEqual({ ...(await job.runPostgresMaintenanceJob({ argv: ["--help"], env: {} })) }, { status: "help" });
});

test("a pool failure still closes the connector and surfaces a closed code", async () => {
  const events = [];
  await assert.rejects(job.runPostgresMaintenanceJob({
    argv: ["--profile=maintenance-job"],
    env: productionJobEnv(),
    dependencies: {
      createConnector() { return { async close() { events.push("connector.close"); } }; },
      async createIamPool() { throw new Error("POSTGRES_CONNECTION_FAILED"); },
    },
  }), (error) => job.safePostgresMaintenanceJobCode(error) === "POSTGRES_CONNECTION_FAILED");
  assert.deepEqual(events, ["connector.close"]);
});

test("the pass rejects malformed options before any connection", async () => {
  let connects = 0;
  const pool = { async connect() { connects += 1; throw new Error("unreachable"); } };
  const store = { async head() { return null; }, async delete() {} };
  const manifest = [{ version: 1, name: "0001_schema_metadata.sql", sha256: "a".repeat(64) }];
  const valid = { pool, objectStore: store, cycleEpoch: 0, expectedPrimaryMigrations: manifest };
  const invalid = [
    null,
    { ...valid, pool: null },
    { ...valid, pool: {} },
    { ...valid, objectStore: { head() {} } },
    { ...valid, cycleEpoch: -1 },
    { ...valid, cycleEpoch: 1.5 },
    { ...valid, cycleEpoch: "0" },
    { ...valid, cycleEpoch: 10_000_000_000_000 },
    { ...valid, expectedPrimaryMigrations: [] },
    { ...valid, expectedPrimaryMigrations: [{ ...manifest[0], version: 2 }] },
    { ...valid, expectedPrimaryMigrations: [{ ...manifest[0], sha256: "A".repeat(64) }] },
    { ...valid, expectedPrimaryMigrations: [{ ...manifest[0], name: "../0001.sql" }] },
    { ...valid, clock: 5 },
    { ...valid, schema: { primarySchema: "Bad-Schema" } },
    { ...valid, schema: { primarySchema: "pg_catalog" } },
  ];
  for (const options of invalid) {
    await assert.rejects(pass.runPostgresLifecyclePass(options), code("POSTGRES_LIFECYCLE_PASS_OPTIONS_INVALID"));
  }
  assert.equal(connects, 0);
  // A pool that cannot connect is a failure result, never a thrown provider error.
  const failed = await pass.runPostgresLifecyclePass({ ...valid, cycleEpoch: Date.parse("2026-10-02T00:00:00.000Z") });
  assert.equal(failed.outcome, "failure");
  assert.equal(failed.code, "POSTGRES_MAINTENANCE_UNAVAILABLE");
  assert.equal(failed.lockAcquired, false);
  assert.equal(failed.changed, false);
  assert.equal(connects, 1);
});

test("a migration holding the fence skips the pass after the maintenance lock, which is released", async () => {
  const statements = [];
  const releases = [];
  const pool = {
    async connect() {
      return {
        async query(text, values) {
          statements.push([text, ...values]);
          if (/pg_try_advisory_lock_shared/u.test(text)) return { rows: [{ acquired: false }], rowCount: 1 };
          if (/pg_try_advisory_lock\(/u.test(text)) return { rows: [{ acquired: true }], rowCount: 1 };
          if (/pg_advisory_unlock\(/u.test(text)) return { rows: [{ released: true }], rowCount: 1 };
          throw new Error(`unexpected statement: ${text}`);
        },
        release(discard) { releases.push(discard); },
      };
    },
  };
  const result = await pass.runPostgresLifecyclePass({
    pool,
    objectStore: { async head() { throw new Error("unused"); }, async delete() { throw new Error("unused"); } },
    schema: { primarySchema: "origin_primary" },
    cycleEpoch: Date.parse("2026-10-02T12:34:00.000Z"),
    expectedPrimaryMigrations: [{ version: 1, name: "0001_schema_metadata.sql", sha256: "a".repeat(64) }],
  });
  assert.equal(result.outcome, "skipped");
  assert.equal(result.code, "MIGRATION_IN_PROGRESS");
  assert.equal(result.lockAcquired, false);
  assert.equal(result.changed, false);
  assert.deepEqual(statements, [
    ["SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired", "tibotattle/postgres-scheduled-maintenance/v1"],
    ["SELECT pg_try_advisory_lock_shared(hashtextextended($1, 0)) AS acquired", "tibotattle:primary:origin_primary"],
    ["SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released", "tibotattle/postgres-scheduled-maintenance/v1"],
  ]);
  assert.deepEqual(releases, [false]);
});

test("the pass result and code vocabularies are closed", () => {
  assert.deepEqual([...pass.POSTGRES_LIFECYCLE_PASS_OUTCOMES], ["complete", "partial", "skipped", "refused", "failure"]);
  assert.deepEqual(Object.keys(pass.POSTGRES_LIFECYCLE_PASS_CODES), [...pass.POSTGRES_LIFECYCLE_PASS_OUTCOMES]);
  assert.deepEqual([...pass.POSTGRES_LIFECYCLE_PASS_CODES.skipped], ["MAINTENANCE_IN_PROGRESS", "MIGRATION_IN_PROGRESS"]);
  assert.deepEqual([...pass.POSTGRES_LIFECYCLE_PASS_CODES.partial],
    ["QUARANTINE_RECONCILIATION_BACKLOG", "MAINTENANCE_PURGE_BACKLOG"], "MAINT-PURGE adds the purge backlog");
  assert.equal(pass.POSTGRES_LIFECYCLE_PASS_SAFETY_WINDOW_MILLISECONDS, 24 * 60 * 60 * 1_000);
  assert.equal(pass.POSTGRES_LIFECYCLE_PASS_LOCK_DOMAIN, "tibotattle/postgres-scheduled-maintenance/v1");
  assert.equal(pass.POSTGRES_LIFECYCLE_PASS_MIGRATION_LOCK_PREFIX, "tibotattle:primary:");
  assert.ok(Object.isFrozen(pass.POSTGRES_APPEND_ONLY_NOT_APPLICABLE));
});

test("throughput and schedule match the Worker: 100 registrations per execution, every minute", async () => {
  // The d43c8f92 Worker reconciles one batch of QUARANTINE_RECONCILIATION_BATCH_SIZE
  // per scheduled run, and every Worker environment's cron runs every minute.
  const worker = await readFile(join(WORKER_ROOT, "src", "quarantine-reconciliation.ts"), "utf8");
  const batch = /^const QUARANTINE_RECONCILIATION_BATCH_SIZE = (\d+);$/mu.exec(worker);
  assert.ok(batch, "the Worker's batch constant is present");
  assert.equal(pass.POSTGRES_LIFECYCLE_PASS_RECONCILIATION_PAGE_SIZE, Number(batch[1]));
  assert.equal(pass.POSTGRES_LIFECYCLE_PASS_RECONCILIATION_PAGE_SIZE, 100);
  const reconciler = await vite.ssrLoadModule("/src/postgres-quarantine-reconciliation.ts");
  assert.equal(pass.POSTGRES_LIFECYCLE_PASS_RECONCILIATION_PAGE_SIZE,
    reconciler.POSTGRES_PENDING_OBJECT_RECONCILIATION_BATCH_LIMIT, "the reconciler accepts the full batch");
  const wrangler = await readFile(join(WORKER_ROOT, "wrangler.jsonc"), "utf8");
  const crons = [...wrangler.matchAll(/"crons":\s*\[([^\]]*)\]/gu)].map((match) => match[1].trim());
  assert.ok(crons.length >= 3, "development, staging and production crons");
  assert.deepEqual(new Set(crons), new Set([JSON.stringify(job.POSTGRES_MAINTENANCE_JOB_SCHEDULE)]));
  assert.equal(job.POSTGRES_MAINTENANCE_JOB_SCHEDULE, "* * * * *");
  assert.match(job.POSTGRES_MAINTENANCE_JOB_USAGE, /every minute \(\* \* \* \* \*\)/u);
});

test("the image builds dist/postgres-maintenance-job.mjs and the bundle answers its contract", async () => {
  const buildSource = await readFile(join(ROOT, "build.mjs"), "utf8");
  assert.match(buildSource, /const MAINTENANCE_JOB_ENTRY = resolve\(ROOT, "postgres-maintenance-job\.mjs"\);/u);
  assert.match(buildSource, /"postgres-maintenance-job": MAINTENANCE_JOB_ENTRY,/u);
  assert.match(buildSource, /"dist\/postgres-maintenance-job\.mjs"/u);
  const dockerfile = await readFile(join(ROOT, "Dockerfile"), "utf8");
  assert.match(dockerfile, /&& test -s dist\/postgres-maintenance-job\.mjs &&/u);
  const context = await readFile(join(WORKER_ROOT, "scripts", "cloud-run-build-context.mjs"), "utf8");
  for (const name of ["postgres-maintenance-job.mjs", "postgres-production-configuration.mjs"]) {
    assert.ok(context.includes(`source: "cloud-run/${name}"`), name);
  }

  await mkdir(join(ROOT, "dist"), { recursive: true });
  const directory = await mkdtemp(join(ROOT, "dist", ".maintenance-job-check-"));
  try {
    const outfile = join(directory, "postgres-maintenance-job.mjs");
    await build({
      entryPoints: [join(ROOT, "postgres-maintenance-job.mjs")],
      bundle: true, platform: "node", format: "esm", target: "node22", outfile, logLevel: "silent",
      external: ["@google-cloud/cloud-sql-connector", "google-auth-library", "jsonc-parser", "pg"],
    });
    const bundle = await readFile(outfile, "utf8");
    assert.match(bundle, /postgres-lifecycle-pass-v1/u);
    assert.match(bundle, /tibotattle\/postgres-scheduled-maintenance\/v1/u);
    assert.doesNotMatch(bundle, /fastpath-test|POSTGRES_TEST_HTTP_COMMAND_UNSUPPORTED/u,
      "the job never bundles the request-serving host or its test modes");
    const run = (args, env = {}) => spawnSync(process.execPath, [outfile, ...args], {
      encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env }, timeout: 60_000,
    });
    const help = run(["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--profile=<maintenance-job\|staging-maintenance-job>/u);
    const missing = run([]);
    assert.equal(missing.status, 2);
    assert.deepEqual(JSON.parse(missing.stderr), {
      schemaVersion: "postgres-maintenance-job-v1",
      entry: "postgres-maintenance-job",
      status: "failed",
      code: "POSTGRES_MAINTENANCE_JOB_PROFILE_MISSING",
    });
    const local = run(["--profile=maintenance-job"]);
    assert.equal(local.status, 1);
    assert.equal(JSON.parse(local.stderr).code, "POSTGRES_MAINTENANCE_JOB_CONTEXT_INVALID");
    assert.equal(local.stdout, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
