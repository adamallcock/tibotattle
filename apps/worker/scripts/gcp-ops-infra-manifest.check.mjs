/**
 * Offline check of the OPS-2 desired-state manifest: the closed validator,
 * the connection budget, the custom role parsed from the GCS store sources,
 * and the rendered service, IAM, jobs, scheduler and Cloud SQL flags. Every
 * desired state here is synthetic and content-free. Nothing calls gcloud:
 * PATH is blanked for this process, so an accidental spawn fails closed.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ANALYTICS_REFRESH_PRODUCTION_ENV,
  ANALYTICS_REFRESH_PRODUCTION_JOB,
  ANALYTICS_REFRESH_RESOURCE_ENV,
  analyticsRefreshResources,
  analyticsRefreshTaskTimeoutMs,
  parseAnalyticsRefreshArguments,
  readAnalyticsRefreshProductionTarget,
} from "../cloud-run/analytics-refresh.mjs";
import * as configuration from "../cloud-run/postgres-production-configuration.mjs";
import * as migrations from "../cloud-run/postgres-production-migrations.mjs";
import { CLOUD_RUN_IAM_TEST_TARGET } from "../cloud-run/postgres-test-dispatch.mjs";
import { GCP_PRIVATE_TEST_TARGET } from "./gcp-test-project.mjs";
import { FASTPATH_TEST, REFRESH_JOB_PROFILES } from "./gcp-fastpath-test-deploy.mjs";
import * as manifest from "./gcp-ops-infra-manifest.mjs";
import * as rollout from "./gcp-production-rollout.mjs";

process.env.PATH = "/nonexistent-gcloud-guard";

const SCRIPTS_ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(SCRIPTS_ROOT, "..");
const FIXTURE_PATH = join(SCRIPTS_ROOT, "fixtures/gcp-ops-infra/desired-state.synthetic.json");
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
const SERVICE_TEMPLATE = readFileSync(join(WORKER_ROOT, "cloud-run/production-service.template.yaml"), "utf8");
const IMAGE = Object.freeze({ imageDigest: "a".repeat(64), sourceCommit: "b".repeat(40) });
const UNMARKED_PROJECT = "example-ops-prod1";
const PARSED_PERMISSIONS = Object.freeze([
  "storage.buckets.get", "storage.objects.create", "storage.objects.delete",
  "storage.objects.get", "storage.objects.list",
]);

function fixture(mutate = () => {}) {
  const value = structuredClone(FIXTURE);
  mutate(value);
  return value;
}

/** The fixture with an unmarked (still synthetic, content-free) project. */
function unmarked(mutate = () => {}) {
  const value = JSON.parse(JSON.stringify(FIXTURE).replaceAll("synthetic-ops-project", UNMARKED_PROJECT));
  mutate(value);
  return value;
}

function stagingNames(value) {
  value.environment = "staging";
  value.artifactRegistry.repository = "synthetic-staging-images";
  value.serviceAccounts.builder.accountId = "synthetic-staging-builder";
  value.serviceAccounts.verifier.accountId = "synthetic-staging-verifier";
  value.cloudSql.instance = "synthetic-staging-primary";
  value.bucket.name = "synthetic-staging-quarantine";
  value.service.name = "synthetic-staging-origin";
  value.jobs["production-migrate"].name = "synthetic-staging-migrate";
  value.jobs["analytics-refresh"].name = "synthetic-staging-refresh";
  value.scheduler["analytics-refresh"].name = "synthetic-staging-trigger";
  for (const [name, secret] of Object.entries(value.secrets)) {
    secret.secretName = `tibotattle-staging-${name.toLowerCase().replaceAll("_", "-")}`;
  }
}

function refused(mutate, code, options) {
  assert.throws(() => manifest.validateDesiredState(fixture(mutate), options),
    (error) => error.code === code, code);
}

function readSourceWith(overrides) {
  return (path) => (Object.hasOwn(overrides, path) ? overrides[path] : readFileSync(join(WORKER_ROOT, path), "utf8"));
}

/**
 * The C-REFRESH binding: a rendered analytics-refresh job is the entry's own
 * ANALYTICS_REFRESH_PRODUCTION_JOB, every field it states, so a render cannot
 * drift from the time guard's deadline, the heap the budget was sized in, or
 * the closed env. The entry's production reader must accept the rendered env
 * as one task of this job, and its time guard must enforce the rendered
 * timeout.
 */
async function assertRefreshRenderIsProductionJob(job, desired) {
  const profile = ANALYTICS_REFRESH_PRODUCTION_JOB;
  const task = job.spec.template.spec.template.spec;
  const container = task.containers[0];
  const env = Object.fromEntries(container.env.map((entry) => [entry.name, entry.value]));
  assert.deepEqual(container.command, ["node"]);
  assert.deepEqual(container.args, [...profile.args]);
  assert.equal(container.args[0], `--max-old-space-size=${profile.heapMiB}`);
  assert.equal(container.args[1], profile.entry);
  assert.deepEqual(container.resources, { limits: { cpu: profile.cpu, memory: profile.memory } });
  assert.equal(task.timeoutSeconds, String(profile.taskTimeoutSeconds));
  assert.equal(task.maxRetries, profile.maxRetries);
  assert.equal(job.spec.template.spec.taskCount, profile.tasks);
  assert.equal(job.spec.template.spec.parallelism, profile.parallelism);
  assert.deepEqual([...profile.env], [...ANALYTICS_REFRESH_PRODUCTION_ENV]);
  assert.deepEqual(container.env.map((entry) => entry.name),
    [...profile.env, ...manifest.ANALYTICS_REFRESH_JOB_CONTRACT.provenanceEnv]);
  assert.equal(env.ANALYTICS_V2_MEMORY_BUDGET_MIB, String(profile.memoryBudgetMiB));
  const target = await readAnalyticsRefreshProductionTarget({ ...env, CLOUD_RUN_JOB: job.metadata.name,
    CLOUD_RUN_TASK_INDEX: "0", CLOUD_RUN_TASK_COUNT: "1", CLOUD_RUN_EXECUTION: `${job.metadata.name}-x1`,
    NODE_VERSION: "22.16.0" });
  assert.equal(target.target, desired.environment);
  assert.equal(target.schema, desired.cloudSql.schema);
  assert.equal(analyticsRefreshTaskTimeoutMs(env, target), Number(task.timeoutSeconds) * 1_000);
}

test("the synthetic fixture validates closed, frozen and marked synthetic", () => {
  const desired = manifest.validateDesiredState(fixture());
  assert.equal(Object.isFrozen(desired), true);
  assert.equal(Object.isFrozen(desired.serviceAccounts.runtime), true);
  assert.equal(desired.synthetic, true);
  assert.equal(manifest.isSyntheticProject(desired.project), true);
  assert.equal(desired.environment, "production");
  assert.equal(desired.serviceAccounts.runtime.email, "synthetic-runtime@synthetic-ops-project.iam.gserviceaccount.com");
  assert.equal(desired.cloudSql.runtimeIamUser, "synthetic-runtime@synthetic-ops-project.iam");
  assert.equal(desired.cloudSql.connectionName, "synthetic-ops-project:us-east1:synthetic-primary");
  assert.equal(desired.service.host, "synthetic-origin-100000000001.us-east1.run.app");
  assert.equal(desired.artifactRegistry.imageRepository,
    "us-east1-docker.pkg.dev/synthetic-ops-project/synthetic-images/synthetic-host");
  assert.deepEqual(desired.customRole.permissions, PARSED_PERMISSIONS);
  // Content-free: the fixture names no real project, account or secret value.
  const { schemaVersion: _schema, ...content } = FIXTURE;
  assert.doesNotMatch(JSON.stringify(content), /tibotattle-|@gmail|BEGIN PRIVATE KEY|"[A-Za-z0-9+/]{40,}={0,2}"/u);
  assert.equal(manifest.readDesiredStateFile(FIXTURE_PATH).project, "synthetic-ops-project");
});

test("the fast path renders exactly two jobs and one owner-cadenced scheduler trigger", () => {
  assert.deepEqual([...manifest.JOB_NAMES], ["production-migrate", "analytics-refresh"]);
  assert.deepEqual([...manifest.SCHEDULED_JOB_NAMES], ["analytics-refresh"]);
  assert.deepEqual(Object.keys(manifest.JOB_DEFINITIONS), [...manifest.JOB_NAMES]);
  for (const absent of ["maintenance", "analytics-delivery", "analytics-publication", "analytics-graph",
    "analytics-graph-day", "analytics-cache-retention", "restore-verify", "ops-runtime-probe", "ops-backup-audit"]) {
    assert.equal(manifest.JOB_NAMES.includes(absent), false, absent);
  }
  refused((value) => { value.jobs["analytics-delivery"] = { name: "synthetic-analytics-delivery", maxConnections: 2 }; },
    "JOB_NAMES_MISMATCH");
  refused((value) => { delete value.jobs["production-migrate"]; }, "JOB_NAMES_MISMATCH");
  refused((value) => {
    value.scheduler["production-migrate"] = { name: "synthetic-migrate-trigger", schedule: null, state: "PAUSED" };
  }, "SCHEDULER_JOBS_MISMATCH");
  // No default cadence (decision D3): null is "not decided", a bad cron is refused.
  assert.equal(manifest.validateDesiredState(fixture()).scheduler["analytics-refresh"].schedule, null);
  refused((value) => { delete value.scheduler["analytics-refresh"].schedule; },
    "DESIRED_STATE_KEY_MISSING:scheduler.analytics-refresh.schedule");
  for (const schedule of ["", "daily", "* * * *", "60 * * * *", "0 24 * * *", "0 3 * * 7", "0 3 0 * *",
    "*/0 * * * *", "0 3 * * * *", "0  3 * * *"]) {
    refused((value) => { value.scheduler["analytics-refresh"].schedule = schedule; },
      "SCHEDULER_CADENCE_INVALID:analytics-refresh");
  }
  for (const schedule of ["15 3 * * *", "*/30 * * * *", "0 1-5/2 * * 1-5", "0,30 4 1 1 0"]) {
    assert.equal(manifest.validateDesiredState(fixture((value) => {
      value.scheduler["analytics-refresh"].schedule = schedule;
    })).scheduler["analytics-refresh"].schedule, schedule);
  }
});

test("the trigger state is closed: PAUSED until OPS-3 resumes it, and never ENABLED without a cadence", () => {
  assert.deepEqual([...manifest.SCHEDULER_TRIGGER_STATES], ["PAUSED", "ENABLED"]);
  assert.equal(manifest.validateDesiredState(fixture()).scheduler["analytics-refresh"].state, "PAUSED");
  refused((value) => { delete value.scheduler["analytics-refresh"].state; },
    "DESIRED_STATE_KEY_MISSING:scheduler.analytics-refresh.state");
  for (const state of ["paused", "RUNNING", "DISABLED", "UPDATE_FAILED", null, true, ""]) {
    refused((value) => { value.scheduler["analytics-refresh"].state = state; },
      "DESIRED_STATE_VALUE_INVALID:scheduler.analytics-refresh.state");
  }
  // A trigger with no cadence has never been resumed.
  refused((value) => { value.scheduler["analytics-refresh"].state = "ENABLED"; },
    "SCHEDULER_STATE_INVALID:analytics-refresh");
  const resumed = manifest.validateDesiredState(fixture((value) => {
    value.scheduler["analytics-refresh"].schedule = "15 3 * * *";
    value.scheduler["analytics-refresh"].state = "ENABLED";
  }));
  assert.equal(resumed.scheduler["analytics-refresh"].state, "ENABLED");
  // The state is part of the desired state, so it changes the plan's identity.
  assert.notEqual(manifest.desiredStateDigest(resumed), manifest.desiredStateDigest(manifest.validateDesiredState(
    fixture((value) => { value.scheduler["analytics-refresh"].schedule = "15 3 * * *"; }))));
});

test("the analytics-refresh job renders the production refresh-job contract in the dense profile", async () => {
  // The deferral is lifted: both jobs deploy, and OPS-10 moves both.
  assert.deepEqual({ ...manifest.DEFERRED_JOBS }, {});
  assert.deepEqual([...manifest.deployedJobNames()], ["production-migrate", "analytics-refresh"]);
  assert.deepEqual({ ...manifest.ANALYTICS_REFRESH_TASK_PROFILE }, { name: "dense", cpu: "4", memory: "16Gi",
    heapMiB: 12_288, memoryBudgetMiB: 10_752, timeoutSeconds: 14_400 });
  // It is the dense measurement profile (MEAS-3 runs it), field for field,
  // including the budget that profile sets, so the two cannot drift.
  const dense = REFRESH_JOB_PROFILES.dense;
  assert.deepEqual({ cpu: String(dense.cpu), memory: dense.memory, heapMiB: dense.heapMiB,
    timeoutSeconds: dense.taskTimeoutSeconds, env: dense.env.map((entry) => [...entry]) }, {
    cpu: manifest.ANALYTICS_REFRESH_TASK_PROFILE.cpu, memory: manifest.ANALYTICS_REFRESH_TASK_PROFILE.memory,
    heapMiB: manifest.ANALYTICS_REFRESH_TASK_PROFILE.heapMiB,
    timeoutSeconds: manifest.ANALYTICS_REFRESH_TASK_PROFILE.timeoutSeconds,
    env: [["ANALYTICS_V2_MEMORY_BUDGET_MIB", String(manifest.ANALYTICS_REFRESH_TASK_PROFILE.memoryBudgetMiB)]] });
  for (const value of [unmarked(), unmarked(stagingNames)]) {
    const desired = manifest.validateDesiredState(value);
    const job = manifest.renderJob(desired, "analytics-refresh", IMAGE);
    const task = job.spec.template.spec.template.spec;
    const container = task.containers[0];
    // node --max-old-space-size=<heap> dist/analytics-refresh.mjs --mode=full, nothing else.
    assert.deepEqual(container.command, ["node"]);
    assert.deepEqual(container.args, ["--max-old-space-size=12288", "dist/analytics-refresh.mjs", "--mode=full"]);
    assert.deepEqual(container.resources, { limits: { cpu: "4", memory: "16Gi" } });
    assert.equal(task.timeoutSeconds, "14400");
    assert.equal(task.serviceAccountName, desired.serviceAccounts.runtime.email);
    // The closed configuration env, plus OPS-10's provenance variable, and nothing a test run uses.
    const env = Object.fromEntries(container.env.map((entry) => [entry.name, entry.value]));
    assert.deepEqual(env, {
      ANALYTICS_REFRESH_TARGET: desired.environment,
      PRIMARY_INSTANCE_CONNECTION_NAME: desired.cloudSql.connectionName,
      PRIMARY_DATABASE: desired.cloudSql.database,
      PRIMARY_SCHEMA: desired.cloudSql.schema,
      POSTGRES_IAM_USER: desired.cloudSql.runtimeIamUser,
      ANALYTICS_V2_MEMORY_BUDGET_MIB: "10752",
      DEPLOYMENT_SOURCE_COMMIT: IMAGE.sourceCommit,
    });
    for (const refusedName of manifest.ANALYTICS_REFRESH_JOB_CONTRACT.refusedEnv) {
      assert.equal(Object.hasOwn(env, refusedName), false, refusedName);
    }
    for (const flag of manifest.ANALYTICS_REFRESH_JOB_CONTRACT.refusedArguments) {
      assert.equal(container.args.some((arg) => arg === flag || arg.startsWith(`${flag}=`)), false, flag);
    }
    // The entry's own parser accepts the arguments after the script under
    // this env, reads the schema from PRIMARY_SCHEMA and pins no clock.
    const parsed = parseAnalyticsRefreshArguments(container.args.slice(2), env);
    assert.equal(parsed.mode, "full");
    assert.equal(parsed.schema, desired.cloudSql.schema);
    assert.equal(parsed.nowMs, null);
    // Its resource gate admits the rendered budget under the profile's heap,
    // and refuses it under a heap one MiB short of budget plus reserve.
    const MIB = 1024 * 1024;
    const heap = manifest.ANALYTICS_REFRESH_TASK_PROFILE.heapMiB * MIB;
    const resources = analyticsRefreshResources(env, heap);
    assert.equal(resources.compute.memoryBudgetBytes, 10_752 * MIB);
    assert.ok(resources.requiredHeapBytes <= heap);
    assert.throws(() => analyticsRefreshResources(env, resources.requiredHeapBytes - MIB),
      { code: "ANALYTICS_V2_REFRESH_HEAP_INSUFFICIENT" });

    // The render IS the entry's production job (C-REFRESH), field for field.
    await assertRefreshRenderIsProductionJob(job, desired);
  }
  // The binding refuses a render that drifts from the production job in any field it states.
  {
    const desired = manifest.validateDesiredState(unmarked());
    const rendered = manifest.renderJob(desired, "analytics-refresh", IMAGE);
    const containerOf = (value) => value.spec.template.spec.template.spec.containers[0];
    for (const [label, mutate] of [
      ["timeout 3600", (value) => { value.spec.template.spec.template.spec.timeoutSeconds = "3600"; }],
      ["8Gi", (value) => { containerOf(value).resources.limits.memory = "8Gi"; }],
      ["2 vCPU", (value) => { containerOf(value).resources.limits.cpu = "2"; }],
      ["heap 6144", (value) => { containerOf(value).args[0] = "--max-old-space-size=6144"; }],
      ["retries", (value) => { value.spec.template.spec.template.spec.maxRetries = 3; }],
      ["two tasks", (value) => { value.spec.template.spec.taskCount = 2; }],
      ["budget", (value) => { containerOf(value).env.find((entry) => entry.name === "ANALYTICS_V2_MEMORY_BUDGET_MIB")
        .value = "4608"; }],
      ["extra env", (value) => { containerOf(value).env.push({ name: "PGOPTIONS", value: "-c x=y" }); }],
      ["missing env", (value) => { containerOf(value).env = containerOf(value).env
        .filter((entry) => entry.name !== "PRIMARY_SCHEMA"); }],
      ["schema flag", (value) => { containerOf(value).args.push("--schema=synthetic_primary"); }],
    ]) {
      const doctored = structuredClone(rendered);
      mutate(doctored);
      await assert.rejects(assertRefreshRenderIsProductionJob(doctored, desired), undefined, label);
    }
    await assertRefreshRenderIsProductionJob(structuredClone(rendered), desired);
  }
  assert.equal(ANALYTICS_REFRESH_RESOURCE_ENV.memoryBudgetMiB.name, "ANALYTICS_V2_MEMORY_BUDGET_MIB");
  // 16 GiB leaves room beyond the heap for native memory.
  assert.ok(manifest.ANALYTICS_REFRESH_TASK_PROFILE.heapMiB < 16 * 1024);
  // A render never resolves an env name it does not know.
  assert.throws(() => manifest.renderJob(manifest.validateDesiredState(fixture()), "analytics-delivery", IMAGE),
    { code: "JOB_NAME_UNKNOWN" });
});

test("the connection budget is for one instance with no ledger pool and refuses overflow", () => {
  assert.deepEqual(configuration.PRODUCTION_POOL_CONNECTIONS_PER_INSTANCE, { primary: 8 });
  const desired = manifest.validateDesiredState(fixture());
  // (4 + 4) x 8 + 4 + 1 + 3 + 10 = 82.
  assert.deepEqual({ ...desired.connectionBudget }, {
    perInstance: 8, instances: 8, serviceConnections: 64, jobBudget: 4, migration: 1,
    superuserReserved: 3, headroom: 10, total: 82, maxConnections: 100, fits: true,
  });
  assert.equal(manifest.validateDesiredState(fixture((value) => { value.cloudSql.maxConnections = 82; }))
    .connectionBudget.fits, true);
  refused((value) => { value.cloudSql.maxConnections = 81; }, "CONNECTION_BUDGET_EXCEEDED");
  refused((value) => { value.service.maxInstances = 6; value.service.rolloutOverlapInstances = 6; },
    "CONNECTION_BUDGET_EXCEEDED");
  refused((value) => { value.jobs["analytics-refresh"].maxConnections = 23; }, "CONNECTION_BUDGET_EXCEEDED");
  refused((value) => { value.service.rolloutOverlapInstances = 5; },
    "DESIRED_STATE_VALUE_INVALID:service.rolloutOverlapInstances");
  // The analytics job declares at least its own pool (cloud-run/analytics-refresh.mjs).
  assert.equal(manifest.analyticsRefreshPoolMax(), 4);
  refused((value) => { value.jobs["analytics-refresh"].maxConnections = 3; },
    "JOB_POOL_MAX_UNDERDECLARED:analytics-refresh");
  assert.throws(() => manifest.analyticsRefreshPoolMax({ readSource: () => "const POOL_MAX = maybe;" }),
    { code: "ANALYTICS_REFRESH_POOL_MAX_UNRESOLVED" });
});

test("one Cloud SQL instance: a second instance, a replica or HA is refused", () => {
  refused((value) => { value.cloudSql = [value.cloudSql, { ...value.cloudSql, instance: "synthetic-second" }]; },
    "CLOUD_SQL_SECOND_INSTANCE_FORBIDDEN");
  for (const key of ["replicas", "readReplicas", "failoverReplica", "secondaryInstance", "availabilityType",
    "instances", "highAvailability"]) {
    refused((value) => { value.cloudSql[key] = key === "availabilityType" ? "REGIONAL" : []; },
      "CLOUD_SQL_SECOND_INSTANCE_FORBIDDEN");
  }
  refused((value) => { value.cloudSqlSecondary = value.cloudSql; }, "DESIRED_STATE_KEY_UNKNOWN:desiredState.cloudSqlSecondary");
  const createArgs = manifest.cloudSqlCreateArgs(manifest.validateDesiredState(fixture()));
  assert.equal(createArgs.filter((arg) => arg === "create").length, 1);
  assert.equal(createArgs.some((arg) => /replica|REGIONAL|failover/iu.test(arg)), false);
});

test("any deletion-ledger or history-proof setting is refused", () => {
  for (const mutate of [
    (value) => { value.LEDGER_INSTANCE_CONNECTION_NAME = "synthetic-ops-project:us-east1:x"; },
    (value) => { value.cloudSql.ledgerInstance = "synthetic-second"; },
    (value) => { value.cloudSql.ledger = { instance: "synthetic-second" }; },
    (value) => { value.secrets.LEDGER_SCHEMA = { version: "1" }; },
    (value) => { value.bucket.historyProof = { bucketGeneration: "1" }; },
    (value) => { value.GCS_ERASURE_BUCKET_HISTORY_PROOF = "{}"; },
    (value) => { value.cloudSql.instance = "synthetic-ledger"; },
    (value) => { value.cloudSql.schema = "synthetic_ledger"; },
  ]) {
    assert.throws(() => manifest.validateDesiredState(fixture(mutate)),
      (error) => /^DESIRED_STATE_LEDGER_FORBIDDEN:/u.test(error.code), mutate.toString());
  }
});

test("names of the test estate or a rehearsal are refused", () => {
  const target = GCP_PRIVATE_TEST_TARGET;
  const cases = [
    [(value) => { value.project = target.project; }, "DESIRED_STATE_TEST_TARGET_NAME:project"],
    [(value) => { value.bucket.name = target.gcsBucketName; }, "DESIRED_STATE_TEST_TARGET_NAME:plane:bucket.name"],
    [(value) => { value.service.name = target.service; }, "DESIRED_STATE_TEST_TARGET_NAME:plane:service.name"],
    [(value) => { value.cloudSql.instance = "tibotattle-test-primary-20260922"; },
      "DESIRED_STATE_TEST_TARGET_NAME:plane:cloudSql.instance"],
    [(value) => { value.cloudSql.schema = CLOUD_RUN_IAM_TEST_TARGET.postgres.primary.schema; },
      "DESIRED_STATE_TEST_TARGET_NAME:cloudSql.schema"],
    [(value) => { value.cloudSql.database = CLOUD_RUN_IAM_TEST_TARGET.postgres.primary.database; },
      "DESIRED_STATE_TEST_TARGET_NAME:cloudSql.database"],
    [(value) => { value.jobs["analytics-refresh"].name = FASTPATH_TEST.refreshJob; },
      "DESIRED_STATE_TEST_TARGET_NAME:plane:jobs.analytics-refresh.name"],
    [(value) => { value.jobs["production-migrate"].name = "tibotattle-test-database-migrate"; },
      "DESIRED_STATE_TEST_TARGET_NAME:plane:jobs.production-migrate.name"],
    [(value) => { value.serviceAccounts.runtime.accountId = "tibotattle-test-runtime"; },
      "DESIRED_STATE_TEST_TARGET_NAME:serviceAccounts.runtime.accountId"],
    [(value) => { value.service.audience = target.hostOrigin; }, "DESIRED_STATE_TEST_TARGET_NAME:service.audience"],
    [(value) => { value.cloudSql.schema = "typed_legacy_transfer_rehearsal_target_fastpath_00000000"; },
      "DESIRED_STATE_TEST_TARGET_NAME:cloudSql.schema"],
    [(value) => { value.service.name = "synthetic-origin-rehearsal-0a1b2c3d"; },
      "DESIRED_STATE_REHEARSAL_NAME:plane:service.name"],
    [(value) => { value.cloudSql.instance = "synthetic-primary-rehearsal-0a1b2c3db"; },
      "DESIRED_STATE_REHEARSAL_NAME:plane:cloudSql.instance"],
  ];
  for (const [mutate, code] of cases) refused(mutate, code);
  for (const value of [target.project, target.service, target.gcsBucketName, target.primarySchema,
    target.runtimeServiceAccount, "tibotattle-test-primary-20260922", "tibotattle-test-ledger-20260922"]) {
    assert.ok(manifest.TEST_TARGET_NAMES.includes(value), value);
  }
  // A location is not an identity: the test region stays usable.
  assert.equal(manifest.TEST_TARGET_NAMES.includes(target.region), false);
  assert.equal(manifest.validateDesiredState(fixture()).region, target.region);
});

test("the production and staging planes keep their markers apart", () => {
  refused((value) => { value.service.name = "synthetic-staging-origin"; },
    "DESIRED_STATE_STAGING_NAME_FORBIDDEN:service.name");
  const staging = (mutate) => fixture((value) => {
    stagingNames(value);
    mutate(value);
  });
  assert.equal(manifest.validateDesiredState(staging(() => {})).environment, "staging");
  assert.throws(() => manifest.validateDesiredState(staging((value) => { value.bucket.name = "synthetic-quarantine"; })),
    { code: "DESIRED_STATE_STAGING_MARKER_MISSING:bucket.name" });
  assert.throws(() => manifest.validateDesiredState(staging((value) => {
    value.jobs["production-migrate"].name = "synthetic-staging-production-migrate";
  })), { code: "DESIRED_STATE_PRODUCTION_NAME_FORBIDDEN:jobs.production-migrate.name" });
  // OPS-10 reads the image repository and the builder and verifier accounts as plane resources too.
  assert.throws(() => manifest.validateDesiredState(staging((value) => {
    value.serviceAccounts.builder.accountId = "synthetic-builder";
  })), { code: "DESIRED_STATE_STAGING_MARKER_MISSING:serviceAccounts.builder.accountId" });
  assert.throws(() => manifest.validateDesiredState(staging((value) => {
    value.serviceAccounts.verifier.accountId = "synthetic-verifier";
  })), { code: "DESIRED_STATE_STAGING_MARKER_MISSING:serviceAccounts.verifier.accountId" });
  assert.equal(manifest.validateDesiredState(staging((value) => { value.serviceAccounts.verifier = null; }))
    .serviceAccounts.verifier, null, "a staging plane without a verifier still validates");
  assert.throws(() => manifest.validateDesiredState(staging((value) => {
    value.artifactRegistry.repository = "synthetic-images";
  })), { code: "DESIRED_STATE_STAGING_MARKER_MISSING:artifactRegistry.imageRepository" });
  refused((value) => { value.serviceAccounts.builder.accountId = "synthetic-staging-builder"; },
    "DESIRED_STATE_STAGING_NAME_FORBIDDEN:serviceAccounts.builder.accountId");
  refused((value) => { value.serviceAccounts.verifier.accountId = "synthetic-staging-verifier"; },
    "DESIRED_STATE_STAGING_NAME_FORBIDDEN:serviceAccounts.verifier.accountId");
  refused((value) => { value.artifactRegistry.imageName = "staging-host"; },
    "DESIRED_STATE_STAGING_NAME_FORBIDDEN:artifactRegistry.imageRepository");
  // No plane resource carries a 'test' or 'rehearsal' token (OPS-10 refuses either).
  refused((value) => { value.service.name = "synthetic-test-origin"; }, "DESIRED_STATE_TEST_TOKEN_NAME:service.name");
  refused((value) => { value.artifactRegistry.repository = "test-images"; },
    "DESIRED_STATE_TEST_TOKEN_NAME:artifactRegistry.imageRepository");
  refused((value) => { value.bucket.name = "rehearsal-quarantine"; }, "DESIRED_STATE_REHEARSAL_NAME:plane:bucket.name");
});

test("Secret Manager containers are exactly CR-3's secret names, never an edge-only one", () => {
  const desired = manifest.validateDesiredState(fixture());
  assert.deepEqual(Object.keys(desired.secrets),
    [...configuration.REQUIRED_SECRET_NAMES, ...configuration.OPTIONAL_SECRET_NAMES]);
  for (const name of configuration.REQUIRED_SECRET_NAMES) {
    assert.equal(desired.secrets[name].required, true, name);
    // Removing a required container fails the CR-3 cross-check.
    refused((value) => { delete value.secrets[name]; }, `SECRET_CONTAINER_MISSING:${name}`);
  }
  refused((value) => { delete value.secrets.DISTRIBUTION_GITHUB_API_TOKEN; },
    "SECRET_CONTAINER_MISSING:DISTRIBUTION_GITHUB_API_TOKEN");
  for (const name of [...configuration.EDGE_ONLY_SECRET_NAMES, "EDGE_PROOF_SECRET", "EDGE_PROOF_SHA256",
    "SPARKLE_SIGNING_KEY"]) {
    refused((value) => { value.secrets[name] = { version: "1" }; }, `SECRET_EDGE_ONLY_FORBIDDEN:${name}`);
  }
  refused((value) => { value.secrets.SYNTHETIC_EXTRA = { version: "1" }; }, "SECRET_UNKNOWN:SYNTHETIC_EXTRA");
  for (const version of ["0", "latest", "01", 1, ""]) {
    refused((value) => { value.secrets.IDENTITY_LINK_SECRET.version = version; },
      "DESIRED_STATE_VALUE_INVALID:secrets.IDENTITY_LINK_SECRET.version");
  }
  // Containers only: the desired state holds a secret id and a version number, never a value.
  refused((value) => { value.secrets.IDENTITY_LINK_SECRET.value = "synthetic"; },
    "DESIRED_STATE_SECRET_VALUE_FORBIDDEN:desiredState.secrets.IDENTITY_LINK_SECRET.value");
  refused((value) => { delete value.secrets.IDENTITY_LINK_SECRET.secretName; },
    "DESIRED_STATE_KEY_MISSING:secrets.IDENTITY_LINK_SECRET.secretName");
  for (const secretName of ["", "bad name", "a/b", "x".repeat(256), 7]) {
    refused((value) => { value.secrets.IDENTITY_LINK_SECRET.secretName = secretName; },
      "DESIRED_STATE_VALUE_INVALID:secrets.IDENTITY_LINK_SECRET.secretName");
  }
  refused((value) => {
    value.secrets.IDENTITY_LINK_SECRET.secretName = "tibotattle-shared-secret";
    value.secrets.APPLE_PRIVATE_KEY.secretName = "tibotattle-shared-secret";
  }, "SECRET_NAMES_NOT_DISTINCT");
  // Secret ids are project-wide: a test-estate secret is never reused.
  refused((value) => { value.secrets.ENVELOPE_PRIVATE_JWK.secretName = "tibotattle-test-envelope-private-jwk-20260922"; },
    "DESIRED_STATE_TEST_TARGET_NAME:plane:secrets.ENVELOPE_PRIVATE_JWK.secretName");
});

test("service accounts hold exactly their reviewed project roles: no primitive role, none for the edge", () => {
  const desired = manifest.validateDesiredState(fixture());
  assert.deepEqual([...manifest.SERVICE_ACCOUNT_ROLES],
    ["runtime", "migrator", "scheduler", "builder", "edgeInvoker", "verifier"]);
  assert.deepEqual(desired.serviceAccounts.edgeInvoker.projectRoles, []);
  assert.deepEqual(desired.serviceAccounts.verifier.projectRoles, []);
  for (const role of manifest.PRIMITIVE_ROLES) {
    for (const account of ["runtime", "builder", "scheduler"]) {
      refused((value) => { value.serviceAccounts[account].projectRoles.push(role); },
        `IAM_PRIMITIVE_ROLE_FORBIDDEN:${account}`);
    }
  }
  for (const account of ["edgeInvoker", "verifier"]) {
    refused((value) => { value.serviceAccounts[account].projectRoles = ["roles/run.invoker"]; },
      `EDGE_INVOKER_PROJECT_ROLE_FORBIDDEN:${account}`);
  }
  refused((value) => { value.serviceAccounts.runtime.projectRoles.push("roles/storage.admin"); },
    "IAM_PROJECT_ROLES_MISMATCH:runtime");
  refused((value) => { value.serviceAccounts.migrator.projectRoles = ["roles/cloudsql.client"]; },
    "IAM_PROJECT_ROLES_MISMATCH:migrator");
  refused((value) => { value.serviceAccounts.scheduler.accountId = value.serviceAccounts.runtime.accountId; },
    "SERVICE_ACCOUNTS_NOT_DISTINCT");
  // The verifier is optional.
  assert.equal(manifest.validateDesiredState(fixture((value) => { value.serviceAccounts.verifier = null; }))
    .serviceAccounts.verifier, null);
  refused((value) => { value.serviceAccounts.edgeInvoker = null; }, "DESIRED_STATE_SHAPE_INVALID:serviceAccounts.edgeInvoker");
});

test("the bucket keeps the proof posture: no lifecycle rule, in-region, pinned proof grammar", () => {
  for (const key of ["lifecycle", "lifecycleRules", "lifecycleRule"]) {
    refused((value) => { value.bucket[key] = [{ action: { type: "Delete" }, condition: { age: 30 } }]; },
      "BUCKET_LIFECYCLE_FORBIDDEN");
  }
  refused((value) => { value.bucket.softDeleteRetentionSeconds = "604800"; },
    "DESIRED_STATE_KEY_UNKNOWN:bucket.softDeleteRetentionSeconds");
  refused((value) => { value.bucket.location = "US"; }, "DESIRED_STATE_VALUE_INVALID:bucket.location");
  refused((value) => { value.bucket.location = "US-CENTRAL1"; }, "BUCKET_LOCATION_NOT_REGION");
  refused((value) => { value.bucket.proof.bucketGeneration = "0"; },
    "DESIRED_STATE_VALUE_INVALID:bucket.proof.bucketGeneration");
  refused((value) => { value.bucket.proof.bucketMetageneration = "9223372036854775808"; },
    "DESIRED_STATE_VALUE_INVALID:bucket.proof.bucketMetageneration");
  refused((value) => { value.bucket.proof.softDeleteRetentionDurationSeconds = "0"; },
    "DESIRED_STATE_KEY_UNKNOWN:bucket.proof.softDeleteRetentionDurationSeconds");
  assert.equal(manifest.validateDesiredState(fixture((value) => { value.bucket.proof = null; })).bucket.proof, null);
  const body = manifest.bucketInsertBody(manifest.validateDesiredState(fixture()));
  assert.deepEqual(body, {
    name: "synthetic-ops-quarantine",
    location: "US-EAST1",
    storageClass: "STANDARD",
    iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" },
    softDeletePolicy: { retentionDurationSeconds: "0" },
    versioning: { enabled: false },
  });
  assert.equal(Object.hasOwn(body, "lifecycle"), false);
});

test("the desired state is closed at every level", () => {
  refused((value) => { value.extra = true; }, "DESIRED_STATE_KEY_UNKNOWN:desiredState.extra");
  refused((value) => { delete value.region; }, "DESIRED_STATE_KEY_MISSING:desiredState.region");
  refused((value) => { value.service.minInstances = 0; }, "DESIRED_STATE_KEY_UNKNOWN:service.minInstances");
  refused((value) => { value.cloudSql.databaseVersion = "POSTGRES_16"; },
    "DESIRED_STATE_KEY_UNKNOWN:cloudSql.databaseVersion");
  refused((value) => { value.cloudSql.edition = "ENTERPRISE_PLUS"; }, "DESIRED_STATE_KEY_UNKNOWN:cloudSql.edition");
  refused((value) => { value.schemaVersion = "tibotattle-gcp-ops-infra-desired-state-v0"; }, "DESIRED_STATE_SCHEMA_INVALID");
  refused((value) => { value.environment = "test"; }, "DESIRED_STATE_VALUE_INVALID:desiredState.environment");
  refused((value) => { value.cloudSql.tier = "db-f1-micro"; }, "DESIRED_STATE_VALUE_INVALID:cloudSql.tier");
  refused((value) => { value.cloudSql.schema = "public"; }, "DESIRED_STATE_VALUE_INVALID:cloudSql.schema");
  refused((value) => { value.service.audience = "aud\"x"; }, "DESIRED_STATE_VALUE_INVALID:service.audience");
  refused((value) => { value.jobs["analytics-refresh"].name = value.service.name; }, "CLOUD_RUN_NAMES_NOT_DISTINCT");
  refused((value) => { value.customRole.id = "tibotattleStorageAdmin"; }, "CUSTOM_ROLE_ID_INVALID");
  assert.throws(() => manifest.validateDesiredState([]), { code: "DESIRED_STATE_SHAPE_INVALID:desiredState" });
});

test("the custom role holds storage.buckets.get plus exactly the GCS store's object calls, parsed from source", () => {
  assert.deepEqual(manifest.deriveQuarantineStorePermissions(), PARSED_PERMISSIONS);
  refused((value) => { value.customRole.permissions.pop(); }, "CUSTOM_ROLE_PERMISSIONS_MISMATCH");
  refused((value) => { value.customRole.permissions.push("storage.buckets.update"); }, "CUSTOM_ROLE_PERMISSIONS_MISMATCH");
  refused((value) => { value.customRole.permissions.push("storage.objects.get"); }, "CUSTOM_ROLE_PERMISSIONS_MISMATCH");
  const quarantine = readFileSync(join(WORKER_ROOT, manifest.GCS_STORE_ENTRY), "utf8");
  const erasure = readFileSync(join(WORKER_ROOT, "src/gcs-erasure-object-store.ts"), "utf8");
  const doctor = (source, from, to) => {
    assert.equal(source.split(from).length, 2, `expected one ${from}`);
    return source.replace(from, to);
  };
  const derive = (overrides) => manifest.deriveQuarantineStorePermissions({ readSource: readSourceWith(overrides) });
  // A new call the role table does not know is refused, never guessed.
  assert.throws(() => derive({ "src/gcs-erasure-object-store.ts": doctor(erasure,
    'method: "DELETE",', 'method: "PATCH",') }), { code: "GCS_STORE_OPERATION_UNMAPPED" });
  assert.throws(() => derive({ "src/gcs-erasure-object-store.ts": doctor(erasure,
    "return `/storage/v1/b/${encoded(bucket)}/o/${encoded(key)}`;",
    "return `/storage/v1/b/${encoded(bucket)}/o/${encoded(key)}/rewriteTo/b/x/o/y`;") }),
  { code: "GCS_STORE_OPERATION_UNMAPPED" });
  // A request whose URL cannot be traced, or a fetch outside request(), fails.
  assert.throws(() => derive({ [manifest.GCS_STORE_ENTRY]: doctor(quarantine,
    "await this.request(fixedUrl(objectPath(this.bucket, key)), {",
    "await this.request(someUrl(this.bucket, key), {") }), { code: "GCS_STORE_URL_UNRESOLVED" });
  assert.throws(() => derive({ [manifest.GCS_STORE_ENTRY]: `${quarantine}\nvoid fetch("https://storage.googleapis.com/x");\n` }),
    { code: "GCS_STORE_FETCH_UNACCOUNTED" });
  assert.throws(() => derive({ [manifest.GCS_STORE_ENTRY]: `${quarantine}\nconst stray = fixedUrl("/storage/v1/b");\n` }),
    { code: "GCS_STORE_URL_UNACCOUNTED" });
  // The delete primitive is followed through the import, not assumed.
  assert.throws(() => derive({ [manifest.GCS_STORE_ENTRY]: quarantine.replace("./gcs-erasure-object-store", "./gcs-other-store"),
    "src/gcs-other-store.ts": "export const nothing = 1;\n" }), { code: "GCS_STORE_DELETE_PRIMITIVE_MISSING" });
  // Without the history-proof bucket read the role still holds storage.buckets.get.
  const withoutBucketRead = derive({ "src/gcs-erasure-object-store.ts": doctor(erasure,
    "const url = fixedUrl(bucketPath(this.bucket));", "const url = fixedUrl(objectPath(this.bucket, \"x\"));") });
  assert.deepEqual(withoutBucketRead, PARSED_PERMISSIONS);
  // Dropping the delete call removes storage.objects.delete, and the fixture then mismatches.
  const noDelete = doctor(erasure, 'method: "DELETE",', 'method: "GET",');
  assert.deepEqual(derive({ "src/gcs-erasure-object-store.ts": noDelete }),
    PARSED_PERMISSIONS.filter((permission) => permission !== "storage.objects.delete"));
  refused(() => {}, "CUSTOM_ROLE_PERMISSIONS_MISMATCH",
    { readSource: readSourceWith({ "src/gcs-erasure-object-store.ts": noDelete }) });
});

test("the runtime's bucket access is a conditional project binding of the custom role, on the bucket only", () => {
  const desired = manifest.validateDesiredState(fixture());
  const bindings = manifest.desiredProjectBindings(desired);
  const custom = bindings.filter((binding) => binding.role === desired.customRole.name);
  assert.equal(custom.length, 1);
  assert.equal(custom[0].member, desired.serviceAccounts.runtime.member);
  assert.equal(desired.customRole.name, "projects/synthetic-ops-project/roles/tibotattleQuarantineStore");
  assert.deepEqual(custom[0].condition, {
    title: "tibotattle-quarantine-bucket",
    expression: "(resource.type == \"storage.googleapis.com/Bucket\" && resource.name == "
      + "\"projects/_/buckets/synthetic-ops-quarantine\") || (resource.type == \"storage.googleapis.com/Object\" "
      + "&& resource.name.startsWith(\"projects/_/buckets/synthetic-ops-quarantine/objects/\"))",
  });
  // One condition value for gcloud: no comma inside the expression.
  assert.equal(custom[0].condition.expression.includes(","), false);
  for (const binding of bindings.filter((entry) => entry !== custom[0])) assert.equal(binding.condition, null);
  for (const account of ["edgeInvoker", "verifier", "scheduler"]) {
    assert.equal(bindings.some((binding) => binding.member === desired.serviceAccounts[account].member), false, account);
  }
  assert.equal(bindings.some((binding) => /^roles\/storage\./u.test(binding.role)), false);
});

test("the IAM-private service renders from EP-7's template with no deletion-ledger setting", () => {
  const desired = manifest.validateDesiredState(fixture());
  const service = manifest.renderService(desired, IMAGE);
  const container = service.spec.template.spec.containers[0];
  assert.equal(service.metadata.annotations["run.googleapis.com/ingress"], "all");
  assert.equal(service.metadata.annotations["run.googleapis.com/invoker-iam-disabled"], "false");
  assert.deepEqual(JSON.parse(service.metadata.annotations["run.googleapis.com/custom-audiences"]),
    ["synthetic-edge-origin-audience"]);
  assert.equal(container.image, `${desired.artifactRegistry.imageRepository}@sha256:${"a".repeat(64)}`);
  const env = new Map(container.env.map((entry) => [entry.name, entry]));
  assert.equal(env.get("DEPLOYMENT_SOURCE_COMMIT").value, "b".repeat(40));
  assert.equal(env.get("PRIMARY_INSTANCE_CONNECTION_NAME").value, desired.cloudSql.connectionName);
  assert.equal(env.get("POSTGRES_IAM_USER").value, desired.cloudSql.runtimeIamUser);
  assert.equal(env.get("HOST_ORIGIN").value, "https://synthetic-origin-100000000001.us-east1.run.app");
  assert.equal(service.spec.template.metadata.annotations["autoscaling.knative.dev/maxScale"], "4");
  assert.equal([...env.keys()].some((name) => /LEDGER|ERASURE_BUCKET_HISTORY_PROOF/u.test(name)), false);
  // OD-2: the quarantine bucket's birth proof, rendered from the pinned
  // desired-state proof for exactly this bucket.
  assert.deepEqual(JSON.parse(env.get("GCS_QUARANTINE_BUCKET_HISTORY_PROOF").value), {
    bucket: desired.bucket.name,
    bucketGeneration: desired.bucket.proof.bucketGeneration,
    bucketMetageneration: desired.bucket.proof.bucketMetageneration,
    softDeleteRetentionDurationSeconds: "0",
  });
  assert.equal(env.get("GCS_QUARANTINE_BUCKET_HISTORY_PROOF").valueFrom, undefined);
  // An unborn bucket (no pinned proof) cannot render a service.
  assert.throws(() => manifest.renderService(manifest.validateDesiredState(fixture((value) => {
    value.bucket.proof = null;
  })), IMAGE), { code: "SERVICE_RENDER_BUCKET_PROOF_UNPINNED" });
  // The optional token's version is null: its entry is omitted.
  assert.equal(env.has("DISTRIBUTION_GITHUB_API_TOKEN"), false);
  const withToken = manifest.renderService(manifest.validateDesiredState(fixture((value) => {
    value.secrets.DISTRIBUTION_GITHUB_API_TOKEN.version = "3";
  })), IMAGE);
  assert.deepEqual(withToken.spec.template.spec.containers[0].env.find((entry) => entry.name
    === "DISTRIBUTION_GITHUB_API_TOKEN").valueFrom.secretKeyRef, { name: "DISTRIBUTION_GITHUB_API_TOKEN", key: "3" });
  // A required secret whose version is not pinned cannot render.
  assert.throws(() => manifest.renderService(manifest.validateDesiredState(fixture((value) => {
    value.secrets.APPLE_PRIVATE_KEY.version = null;
  })), IMAGE), { code: "SECRET_VERSION_UNPINNED:APPLE_PRIVATE_KEY" });
  for (const image of [{ ...IMAGE, imageDigest: "latest" }, { ...IMAGE, sourceCommit: "main" }]) {
    assert.throws(() => manifest.renderService(desired, image), (error) => /^SERVICE_RENDER_/u.test(error.code));
  }
});

test("the rendered service env is a production configuration CR-3 accepts, with no ledger", () => {
  const desired = manifest.validateDesiredState(fixture());
  const service = manifest.renderService(desired, IMAGE);
  const env = { K_SERVICE: desired.service.name };
  for (const entry of service.spec.template.spec.containers[0].env) {
    if (entry.value !== undefined) env[entry.name] = entry.value;
  }
  // Secret values come from Secret Manager at run time; synthetic stand-ins here.
  const kid = "key:synthetic-ops-check";
  Object.assign(env, {
    IDENTITY_LINK_SECRET: "synthetic-identity-link-secret-value-0000000001",
    POSTGRES_RATE_LIMIT_SECRET: "synthetic-rate-limit-secret-value-00000000002",
    ENVELOPE_PUBLIC_JWK: JSON.stringify({ kty: "RSA", kid, n: "synthetic-modulus", e: "AQAB" }),
    ENVELOPE_PRIVATE_JWK: JSON.stringify({ kty: "RSA", kid, n: "synthetic-modulus", e: "AQAB", d: "synthetic-d" }),
    GOOGLE_OIDC_CLIENT_SECRET: "synthetic-google-client-secret-value",
    APPLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nc3ludGhldGlj\\n-----END PRIVATE KEY-----",
  });
  const config = configuration.readProductionConfiguration(env, "production");
  assert.deepEqual(config.resources, {
    primary: { instanceConnectionName: desired.cloudSql.connectionName, database: desired.cloudSql.database,
      schema: desired.cloudSql.schema },
    iamUser: desired.cloudSql.runtimeIamUser,
    bucket: desired.bucket.name,
    bucketHistoryProof: {
      bucket: desired.bucket.name,
      bucketGeneration: desired.bucket.proof.bucketGeneration,
      bucketMetageneration: desired.bucket.proof.bucketMetageneration,
      softDeleteRetentionDurationSeconds: "0",
    },
  });
  assert.equal(config.edge.invokerServiceAccount, desired.serviceAccounts.edgeInvoker.email);
  assert.deepEqual(config.edge.verifierServiceAccounts, [desired.serviceAccounts.verifier.email]);
  assert.equal(config.origins.host, `https://${desired.service.host}`);
  // An env rendered from a stale, ledger-carrying template is refused, not ignored.
  for (const [name, code] of [["LEDGER_SCHEMA", "LEDGER_SCHEMA_FORBIDDEN"],
    ["GCS_ERASURE_BUCKET_HISTORY_PROOF", "GCS_ERASURE_BUCKET_HISTORY_PROOF_FORBIDDEN"]]) {
    assert.throws(() => configuration.readProductionConfiguration({ ...env, [name]: "synthetic" }, "production"), { code });
  }
});

test("a doctored service template is refused by the renderer", () => {
  const desired = manifest.validateDesiredState(fixture());
  const values = manifest.serviceTemplateValues(desired, IMAGE);
  const render = (templateText, extra = {}) => manifest.renderServiceTemplateValues({ ...values, ...extra }, { templateText });
  assert.equal(render(SERVICE_TEMPLATE).kind, "Service");
  const doctor = (from, to) => {
    assert.equal(SERVICE_TEMPLATE.split(from).length, 2, from);
    return SERVICE_TEMPLATE.replace(from, to);
  };
  for (const templateText of [
    doctor("run.googleapis.com/ingress: all", "run.googleapis.com/ingress: internal"),
    doctor("run.googleapis.com/invoker-iam-disabled: 'false'", "run.googleapis.com/invoker-iam-disabled: 'true'"),
    doctor("            - name: HOST_MODE\n", "            - name: LEDGER_SCHEMA\n              value: 'x'\n"
      + "            - name: HOST_MODE\n"),
    doctor("            - name: HOST_MODE\n", "            - name: EDGE_INVOKER_KEY_JSON\n              value: 'x'\n"
      + "            - name: HOST_MODE\n"),
    doctor("                  name: IDENTITY_LINK_SECRET\n", "                  name: OTHER_SECRET\n"),
  ]) {
    assert.throws(() => render(templateText), { code: "SERVICE_RENDER_INVARIANT_BROKEN" });
  }
  assert.throws(() => render(SERVICE_TEMPLATE, { LEDGER_SCHEMA: "x" }), { code: "SERVICE_RENDER_UNUSED:LEDGER_SCHEMA" });
  assert.throws(() => render(SERVICE_TEMPLATE, { AUDIENCE: "x'y" }), { code: "SERVICE_RENDER_UNSAFE:AUDIENCE" });
  const { AUDIENCE: _audience, ...missing } = values;
  assert.throws(() => manifest.renderServiceTemplateValues(missing, { templateText: SERVICE_TEMPLATE }),
    { code: "SERVICE_RENDER_UNRESOLVED:AUDIENCE" });
  assert.throws(() => render("apiVersion: [unsupported]\n"), { code: "SERVICE_TEMPLATE_UNSUPPORTED" });
});

test("the edge-invoker IAM policy is run.invoker only, with no project role", () => {
  const desired = manifest.validateDesiredState(fixture());
  assert.deepEqual(manifest.renderEdgeIamPolicy(desired), {
    bindings: [{ role: "roles/run.invoker", members: [desired.serviceAccounts.edgeInvoker.member,
      desired.serviceAccounts.verifier.member] }],
    projectRoles: { [desired.serviceAccounts.edgeInvoker.member]: [], [desired.serviceAccounts.verifier.member]: [] },
  });
  const noVerifier = manifest.validateDesiredState(fixture((value) => { value.serviceAccounts.verifier = null; }));
  assert.deepEqual(manifest.renderEdgeIamPolicy(noVerifier).bindings,
    [{ role: "roles/run.invoker", members: [noVerifier.serviceAccounts.edgeInvoker.member] }]);
  const iam = readFileSync(join(WORKER_ROOT, "cloud-run/production-edge-iam.template.json"), "utf8");
  for (const doctored of [iam.replace("\"role\": \"roles/run.invoker\"", "\"role\": \"roles/run.admin\""),
    iam.replace("\"serviceAccount:${EDGE_INVOKER_SA}\": []", "\"serviceAccount:${EDGE_INVOKER_SA}\": [\"roles/viewer\"]")]) {
    assert.notEqual(doctored, iam);
    assert.throws(() => manifest.renderEdgeIamPolicy(desired, { templateText: doctored }), { code: "IAM_TEMPLATE_INVALID" });
  }
});

test("the two jobs render with their accounts, entries and bounds, the analytics entry built", () => {
  const desired = manifest.validateDesiredState(fixture());
  const migrate = manifest.renderJob(desired, "production-migrate", IMAGE);
  const refresh = manifest.renderJob(desired, "analytics-refresh", IMAGE);
  const task = (job) => job.spec.template.spec.template.spec;
  assert.equal(task(migrate).serviceAccountName, desired.serviceAccounts.migrator.email);
  assert.equal(task(refresh).serviceAccountName, desired.serviceAccounts.runtime.email);
  for (const job of [migrate, refresh]) {
    assert.equal(job.spec.template.spec.taskCount, 1);
    assert.equal(job.spec.template.spec.parallelism, 1);
    assert.equal(task(job).maxRetries, 0);
    assert.equal(task(job).containers[0].image, `${desired.artifactRegistry.imageRepository}@sha256:${"a".repeat(64)}`);
    assert.doesNotMatch(JSON.stringify(job), /LEDGER|HISTORY_PROOF/u);
  }
  assert.equal(task(migrate).timeoutSeconds, "1800");
  assert.deepEqual(task(refresh).containers[0].args, ["--max-old-space-size=12288", "dist/analytics-refresh.mjs",
    "--mode=full"]);
  // OPS-10's PRODUCTION_MIGRATION_JOB entry (its build output) and exactly
  // the env its validateProductionMigrationEnvironment reads.
  assert.deepEqual(task(migrate).containers[0].args, ["dist/production-migrations.mjs"]);
  const migrateEnv = Object.fromEntries(task(migrate).containers[0].env.map((entry) => [entry.name, entry.value]));
  assert.deepEqual(migrateEnv, {
    MIGRATION_ENVIRONMENT: "production",
    GOOGLE_CLOUD_PROJECT: "synthetic-ops-project",
    PRODUCTION_MIGRATOR_SERVICE_ACCOUNT: desired.serviceAccounts.migrator.email,
    POSTGRES_MIGRATOR_IAM_USER: desired.cloudSql.migratorIamUser,
    POSTGRES_RUNTIME_IAM_USER: desired.cloudSql.runtimeIamUser,
    ENVIRONMENT_PRIMARY_INSTANCE_CONNECTION_NAME: desired.cloudSql.connectionName,
    PRIMARY_INSTANCE_CONNECTION_NAME: desired.cloudSql.connectionName,
    PRIMARY_DATABASE: desired.cloudSql.database,
    PRIMARY_SCHEMA: desired.cloudSql.schema,
    DEPLOYMENT_SOURCE_COMMIT: "b".repeat(40),
  });
  const build = readFileSync(join(WORKER_ROOT, "cloud-run/build.mjs"), "utf8");
  assert.match(build, /"dist\/analytics-refresh\.mjs"/u);
  assert.throws(() => manifest.renderJob(desired, "analytics-delivery", IMAGE), { code: "JOB_NAME_UNKNOWN" });
  // The migration entry refuses a job whose name lacks the 'migrate' token or carries 'test'.
  for (const name of ["synthetic-production-schema", "synthetic-migrations", "synthetic-migrate2"]) {
    refused((value) => { value.jobs["production-migrate"].name = name; }, "JOB_NAME_INVALID:jobs.production-migrate.name");
  }
  refused((value) => { value.jobs["production-migrate"].name = "synthetic-test-migrate"; },
    "DESIRED_STATE_TEST_TOKEN_NAME:jobs.production-migrate.name");
});

test("rolloutTarget gives OPS-10 its closed target from the environment's committed desired state", () => {
  const files = new Map([
    [manifest.committedDesiredStatePath("production"), JSON.stringify(unmarked())],
    [manifest.committedDesiredStatePath("staging"), JSON.stringify(unmarked(stagingNames))],
  ]);
  const readFile = (target) => {
    if (!files.has(target)) throw new Error("synthetic: unexpected read");
    return files.get(target);
  };
  assert.deepEqual({ ...manifest.COMMITTED_DESIRED_STATE_FILES }, {
    production: "cloud-run/infra/production.desired-state.json",
    staging: "cloud-run/infra/staging.desired-state.json",
  });
  assert.equal(manifest.committedDesiredStatePath("staging"), join(WORKER_ROOT, "cloud-run/infra/staging.desired-state.json"));
  const target = manifest.rolloutTarget("production", { readFile });
  assert.deepEqual(Object.keys(target), [...manifest.ROLLOUT_TARGET_KEYS]);
  assert.deepEqual({ ...target, jobNames: [...target.jobNames] }, {
    environment: "production",
    project: UNMARKED_PROJECT,
    region: "us-east1",
    service: "synthetic-origin",
    migrationJob: "synthetic-production-migrate",
    // Both jobs deploy, so the rollout moves both.
    jobNames: ["synthetic-production-migrate", "synthetic-analytics-refresh"],
    primaryInstance: "synthetic-primary",
    imageRepository: `us-east1-docker.pkg.dev/${UNMARKED_PROJECT}/synthetic-images/synthetic-host`,
    builderServiceAccount: `synthetic-builder@${UNMARKED_PROJECT}.iam.gserviceaccount.com`,
    // The EP-6 verifier path roll reads /api/health through outside gcp mode.
    verifierServiceAccount: `synthetic-verifier@${UNMARKED_PROJECT}.iam.gserviceaccount.com`,
    originAudience: "synthetic-edge-origin-audience",
  });
  assert.equal(Object.isFrozen(target.jobNames), true);
  assert.equal(manifest.rolloutTarget("staging", { readFile }).service, "synthetic-staging-origin");
  const refusedWith = (environment, text, code) => {
    const reader = (path) => (path === manifest.committedDesiredStatePath(environment) ? text : readFile(path));
    assert.throws(() => manifest.rolloutTarget(environment, { readFile: reader }), { code }, `${environment} ${code}`);
  };
  assert.throws(() => manifest.rolloutTarget("test", { readFile }), { code: "GCP_INFRA_ENVIRONMENT_INVALID" });
  refusedWith("production", JSON.stringify(unmarked(stagingNames)), "GCP_INFRA_ENVIRONMENT_MISMATCH");
  refusedWith("staging", JSON.stringify(unmarked()), "GCP_INFRA_ENVIRONMENT_MISMATCH");
  refusedWith("production", "{", "DESIRED_STATE_UNREADABLE");
  // The shipped synthetic fixture is never a committed desired state, so never a rollout target.
  refusedWith("production", JSON.stringify(FIXTURE), "COMMITTED_DESIRED_STATE_SYNTHETIC");
  // A committed desired state names the verifier (OD-CR-7); a rollout also needs its operator.
  refusedWith("production", JSON.stringify(unmarked((value) => { value.serviceAccounts.verifier = null; })),
    "COMMITTED_DESIRED_STATE_VERIFIER_REQUIRED");
  refusedWith("production", JSON.stringify(unmarked((value) => { value.serviceAccounts.verifier.tokenCreators = null; })),
    "ROLLOUT_TARGET_VERIFIER_TOKEN_CREATOR_UNASSIGNED");
  assert.throws(() => manifest.rolloutTargetFromDesiredState(manifest.validateDesiredState(fixture())),
    { code: "ROLLOUT_TARGET_SYNTHETIC_REFUSED" });
  assert.throws(() => manifest.rolloutTargetFromDesiredState(manifest.validateDesiredState(unmarked((value) => {
    value.serviceAccounts.verifier = null;
  }))), { code: "ROLLOUT_TARGET_VERIFIER_REQUIRED" });
  // With no injected reader, the real committed files answer: staging waits
  // for its operator, production for OWN-5.
  assert.throws(() => manifest.rolloutTarget("staging"), { code: "ROLLOUT_TARGET_VERIFIER_TOKEN_CREATOR_UNASSIGNED" });
  assert.throws(() => manifest.rolloutTarget("production"), { code: "DESIRED_STATE_PLACEHOLDER_UNFILLED:project" });
});

test("OPS-10 accepts the rendered migration job and the rollout target (integrated; never skipped)", async () => {
  const job = migrations.PRODUCTION_MIGRATION_JOB;
  // Single-sourced: the manifest imports OPS-10's job, it does not mirror it.
  assert.deepEqual([...manifest.JOB_DEFINITIONS["production-migrate"].args], [job.entry]);
  assert.equal(manifest.JOB_DEFINITIONS["production-migrate"].account, job.serviceAccount);
  assert.equal(manifest.JOB_DEFINITIONS["production-migrate"].timeoutSeconds, job.taskTimeoutSeconds);
  assert.equal(manifest.JOB_DEFINITIONS["production-migrate"].env, job.env);
  assert.doesNotMatch(readFileSync(join(SCRIPTS_ROOT, "gcp-ops-infra-manifest.mjs"), "utf8"),
    /"PRODUCTION_MIGRATOR_SERVICE_ACCOUNT"/u, "the migrate env list is not restated in the manifest");
  assert.deepEqual([...rollout.ROLLOUT_TARGET_KEYS], [...manifest.ROLLOUT_TARGET_KEYS]);
  for (const value of [unmarked(), unmarked(stagingNames)]) {
    const desired = manifest.validateDesiredState(value);
    const rendered = manifest.renderJob(desired, "production-migrate", IMAGE);
    const task = rendered.spec.template.spec.template.spec;
    assert.equal(task.maxRetries, job.maxRetries);
    assert.equal(rendered.spec.template.spec.taskCount, job.tasks);
    assert.equal(rendered.spec.template.spec.parallelism, job.parallelism);
    const env = Object.fromEntries(task.containers[0].env.map((entry) => [entry.name, entry.value]));
    const config = migrations.validateProductionMigrationEnvironment({ ...env, CLOUD_RUN_JOB: rendered.metadata.name,
      CLOUD_RUN_EXECUTION: `${rendered.metadata.name}-abcde`, CLOUD_RUN_TASK_INDEX: "0", CLOUD_RUN_TASK_COUNT: "1",
      CLOUD_RUN_TASK_ATTEMPT: "0" });
    assert.equal(config.environment, desired.environment);
    assert.equal(config.target.kind, "environment");
    assert.equal(config.migratorServiceAccount, desired.serviceAccounts.migrator.email);
    const target = manifest.rolloutTargetFromDesiredState(desired);
    assert.deepEqual(rollout.validateRolloutTarget(target, desired.environment), target);
    assert.equal(target.migrationJob, rendered.metadata.name);
  }
});

test("the scheduler trigger posts to jobs:run in UTC, with no retry, and needs an owner cadence", () => {
  const desired = manifest.validateDesiredState(fixture());
  assert.throws(() => manifest.schedulerFlags(desired, "analytics-refresh"), { code: "SCHEDULER_CADENCE_UNSET" });
  const cadenced = manifest.validateDesiredState(fixture((value) => {
    value.scheduler["analytics-refresh"].schedule = "15 3 * * *";
  }));
  assert.deepEqual([...manifest.schedulerFlags(cadenced, "analytics-refresh")], [
    "--project=synthetic-ops-project",
    "--location=us-east1",
    "--schedule=15 3 * * *",
    "--time-zone=Etc/UTC",
    "--uri=https://run.googleapis.com/v2/projects/synthetic-ops-project/locations/us-east1/jobs/"
      + "synthetic-analytics-refresh:run",
    "--http-method=POST",
    `--oauth-service-account-email=${cadenced.serviceAccounts.scheduler.email}`,
    "--oauth-token-scope=https://www.googleapis.com/auth/cloud-platform",
    "--max-retry-attempts=0",
  ]);
});

test("the one Cloud SQL instance renders PostgreSQL 17 ENTERPRISE with OPS-1 backups and the logging flags", () => {
  const desired = manifest.validateDesiredState(fixture());
  const args = manifest.cloudSqlCreateArgs(desired);
  for (const expected of [
    "--database-version=POSTGRES_17", "--edition=ENTERPRISE", "--availability-type=ZONAL",
    "--storage-auto-increase", "--deletion-protection", "--assign-ip", "--connector-enforcement=REQUIRED",
    "--no-insights-config-query-insights-enabled", "--backup-start-time=07:00", "--retained-backups-count=30",
    "--retained-transaction-log-days=7", "--enable-point-in-time-recovery", "--backup-location=us-east1",
    "--final-backup", "--final-backup-retention-days=30", "--no-retain-backups-on-delete",
  ]) {
    assert.ok(args.includes(expected), expected);
  }
  assert.equal(args.some((arg) => arg.startsWith("--authorized-networks") || arg === "--no-assign-ip"
    || arg.startsWith("--root-password")), false);
  const flags = Object.fromEntries(manifest.databaseFlags(desired).map(({ name, value }) => [name, value]));
  assert.deepEqual(flags, {
    "cloudsql.iam_authentication": "on",
    log_error_verbosity: "terse",
    log_lock_waits: "off",
    log_min_duration_statement: "-1",
    log_min_error_statement: "panic",
    log_parameter_max_length: "0",
    log_parameter_max_length_on_error: "0",
    log_statement: "none",
    log_temp_files: "-1",
    max_connections: "100",
  });
  assert.equal(args.at(-1), manifest.databaseFlagsArgument(desired));
  assert.equal(manifest.databaseFlagsArgument(desired).split(",").length, 10);
});

test("the manifest stays pure: no child process, network or process environment", () => {
  const source = readFileSync(join(SCRIPTS_ROOT, "gcp-ops-infra-manifest.mjs"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
  assert.doesNotMatch(code, /child_process|spawnSync|\bfetch\(|node:net|node:https?/u);
  // The desired state comes from the committed files only: no variable names a path.
  assert.equal([...code.matchAll(/process\.env/gu)].length, 0);
  assert.doesNotMatch(source, /GCP_INFRA_DESIRED_STATE_(?:PRODUCTION|STAGING)/u);
  assert.match(code, /export function rolloutTarget\(environment, \{ readFile, readSource \} = \{\}\) \{/u);
  assert.doesNotMatch(source, /postgres-ledger-authority/u);
  assert.match(source, /not Terraform/u);
});

// ---------------------------------------------------------------------------
// The committed desired states (owner decision 2026-10-02)

const COMMITTED = Object.freeze({
  production: readFileSync(join(WORKER_ROOT, "cloud-run/infra/production.desired-state.json"), "utf8"),
  staging: readFileSync(join(WORKER_ROOT, "cloud-run/infra/staging.desired-state.json"), "utf8"),
});
const OWN5_FILL = Object.freeze({ project: UNMARKED_PROJECT, projectNumber: "100000000002", region: "us-east1" });

function committed(environment, mutate = () => {}) {
  const value = JSON.parse(COMMITTED[environment]);
  mutate(value);
  return value;
}

/** The committed production file with OWN-5's placeholders filled by synthetic values. */
function filledProduction(mutate = () => {}) {
  return committed("production", (value) => {
    Object.assign(value, OWN5_FILL);
    value.bucket.location = "US-EAST1";
    mutate(value);
  });
}

function nullPaths(value, path = "") {
  if (value === null) return [path];
  if (Array.isArray(value)) return value.flatMap((entry, index) => nullPaths(entry, `${path}[${index}]`));
  if (typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => nullPaths(entry, path === "" ? key : `${path}.${key}`));
  }
  return [];
}

function planeIdentifiers(desired) {
  return [desired.artifactRegistry.imageRepository, desired.cloudSql.instance, desired.cloudSql.database,
    desired.cloudSql.schema, desired.bucket.name, desired.service.name, desired.service.audience,
    ...Object.values(desired.serviceAccounts).filter(Boolean).map((account) => account.accountId),
    ...Object.values(desired.jobs).map((job) => job.name), ...Object.values(desired.scheduler).map((trigger) => trigger.name),
    ...Object.values(desired.secrets).map((secret) => secret.secretName)];
}

test("the committed staging desired state loads: a new plane in the shared GCP test project", async () => {
  const desired = manifest.loadCommittedDesiredState("staging");
  assert.equal(desired.environment, "staging");
  assert.equal(desired.projectTenancy, "shared");
  assert.equal(desired.project, GCP_PRIVATE_TEST_TARGET.project);
  assert.equal(desired.synthetic, false);
  assert.deepEqual(manifest.unfilledPlaceholders(JSON.parse(COMMITTED.staging)), []);
  // New resources only: nothing the test estate (tibotattle-test-app, the
  // OAuth gateway, the test databases, jobs, secrets and buckets) uses.
  for (const name of planeIdentifiers(desired)) {
    assert.equal(manifest.TEST_TARGET_NAMES.includes(name), false, name);
    assert.equal(manifest.TEST_TARGET_PREFIXES.some((prefix) => name.startsWith(prefix)), false, name);
    assert.equal(/(?:^|[^a-z0-9])test(?:[^a-z0-9]|$)/iu.test(name), false, name);
  }
  for (const name of [desired.cloudSql.instance, desired.bucket.name, desired.service.name, desired.artifactRegistry.repository,
    ...Object.values(desired.jobs).map((job) => job.name), ...Object.values(desired.secrets).map((secret) => secret.secretName)]) {
    assert.match(name, /(?:^|-)staging(?:-|$)/u, name);
  }
  // The verifier exists; its operator, the namespace, the cadence and the secret versions wait for the owner.
  assert.equal(desired.serviceAccounts.verifier.accountId, "tibotattle-staging-verifier");
  assert.equal(desired.serviceAccounts.verifier.tokenCreators, null);
  assert.deepEqual(desired.scheduler["analytics-refresh"], {
    name: "tibotattle-staging-analytics-refresh-trigger", schedule: null, state: "PAUSED" });
  assert.equal(desired.service.telemetryStorageNamespace, null);
  assert.equal(desired.bucket.proof, null);
  assert.ok(Object.values(desired.secrets).every((secret) => secret.version === null));
  assert.equal(desired.connectionBudget.fits, true);
  // Its service waits for a staging template; everything else renders.
  assert.equal(manifest.serviceRenderBlocker(desired), "STAGING_SERVICE_TEMPLATE_UNAVAILABLE");
  assert.throws(() => manifest.renderService(desired, IMAGE), { code: "STAGING_SERVICE_TEMPLATE_UNAVAILABLE" });
  for (const job of manifest.JOB_NAMES) assert.equal(manifest.renderJob(desired, job, IMAGE).kind, "Job");
  // Its refresh job is the entry's production job, and the entry accepts its staging names.
  await assertRefreshRenderIsProductionJob(manifest.renderJob(desired, "analytics-refresh", IMAGE), desired);
});

test("the committed production desired state is refused until OWN-5 fills its placeholders", async () => {
  const raw = JSON.parse(COMMITTED.production);
  assert.deepEqual([...manifest.OWNER_PLACEHOLDER_PATHS], ["project", "projectNumber", "region", "bucket.location"]);
  assert.deepEqual([...manifest.unfilledPlaceholders(raw)], [...manifest.OWNER_PLACEHOLDER_PATHS]);
  // Every null in the file is a placeholder or a value that waits for the owner.
  assert.deepEqual(nullPaths(raw).sort(), [
    "bucket.location", "bucket.proof", "project", "projectNumber", "region", "scheduler.analytics-refresh.schedule",
    ...Object.keys(raw.secrets).map((name) => `secrets.${name}.version`),
    "service.telemetryStorageNamespace", "serviceAccounts.verifier.tokenCreators",
  ].sort());
  assert.throws(() => manifest.loadCommittedDesiredState("production"),
    { code: "DESIRED_STATE_PLACEHOLDER_UNFILLED:project" });
  // Each placeholder refuses on its own, in the validator, whatever reads the file.
  for (const path of manifest.OWNER_PLACEHOLDER_PATHS) {
    const value = filledProduction((filled) => {
      if (path === "bucket.location") filled.bucket.location = null;
      else filled[path] = null;
    });
    assert.throws(() => manifest.validateDesiredState(value), { code: `DESIRED_STATE_PLACEHOLDER_UNFILLED:${path}` }, path);
  }
  // A staging file cannot hide behind a placeholder either.
  assert.throws(() => manifest.validateDesiredState(committed("staging", (value) => { value.region = null; })),
    { code: "DESIRED_STATE_PLACEHOLDER_UNFILLED:region" });
  // Filled, it validates under the committed-file policy: dedicated, no test
  // or staging name, and every name its own.
  const desired = manifest.assertCommittedDesiredState(manifest.validateDesiredState(filledProduction()));
  assert.equal(desired.projectTenancy, "dedicated");
  assert.equal(desired.serviceAccounts.verifier.accountId, "tibotattle-verifier");
  assert.equal(manifest.serviceRenderBlocker(desired), "TELEMETRY_STORAGE_NAMESPACE_UNASSIGNED");
  assert.throws(() => manifest.rolloutTargetFromDesiredState(desired), { code: "ROLLOUT_TARGET_VERIFIER_TOKEN_CREATOR_UNASSIGNED" });
  // Its refresh job is the entry's production job, and the entry accepts its production names.
  await assertRefreshRenderIsProductionJob(manifest.renderJob(desired, "analytics-refresh", IMAGE), desired);
  // Production and staging share no resource name.
  const staging = new Set(planeIdentifiers(manifest.loadCommittedDesiredState("staging")));
  for (const name of planeIdentifiers(desired)) {
    if (/^[A-Z_]+$/u.test(name)) continue; // production secret ids are the variable names; staging's are marked
    assert.equal(staging.has(name), false, name);
  }
});

test("committed files refuse test names, shared tenancy and staging names in production", () => {
  const cases = [
    // The GCP test project is a staging host only.
    [(value) => { value.project = GCP_PRIVATE_TEST_TARGET.project; }, "DESIRED_STATE_TEST_TARGET_NAME:project"],
    [(value) => { value.projectTenancy = "shared"; }, "PROJECT_TENANCY_SHARED_FORBIDDEN:production"],
    [(value) => { value.projectTenancy = "pooled"; }, "DESIRED_STATE_VALUE_INVALID:desiredState.projectTenancy"],
    [(value) => { value.service.name = GCP_PRIVATE_TEST_TARGET.service; }, "DESIRED_STATE_TEST_TARGET_NAME:plane:service.name"],
    [(value) => { value.cloudSql.instance = "tibotattle-test-primary-20260922"; },
      "DESIRED_STATE_TEST_TARGET_NAME:plane:cloudSql.instance"],
    [(value) => { value.cloudSql.database = "tibotattle_fastpath"; }, "DESIRED_STATE_TEST_TARGET_NAME:cloudSql.database"],
    [(value) => { value.jobs["analytics-refresh"].name = FASTPATH_TEST.refreshJob; },
      "DESIRED_STATE_TEST_TARGET_NAME:plane:jobs.analytics-refresh.name"],
    [(value) => { value.serviceAccounts.runtime.accountId = "tibotattle-test-runtime"; },
      "DESIRED_STATE_TEST_TARGET_NAME:serviceAccounts.runtime.accountId"],
    [(value) => { value.secrets.ENVELOPE_PUBLIC_JWK.secretName = "tibotattle-test-envelope-public-jwk-20260922"; },
      "DESIRED_STATE_TEST_TARGET_NAME:plane:secrets.ENVELOPE_PUBLIC_JWK.secretName"],
    [(value) => { value.bucket.name = "tibotattle-test-quarantine"; }, "DESIRED_STATE_TEST_TARGET_NAME:plane:bucket.name"],
    [(value) => { value.cloudSql.schema = "tibotattle_rehearsal_primary"; }, "DESIRED_STATE_REHEARSAL_NAME:cloudSql.schema"],
    [(value) => { value.service.name = "tibotattle-staging-origin"; }, "DESIRED_STATE_STAGING_NAME_FORBIDDEN:service.name"],
    [(value) => { value.secrets.APPLE_PRIVATE_KEY.secretName = "tibotattle-staging-apple-private-key"; },
      "DESIRED_STATE_STAGING_NAME_FORBIDDEN:secrets.APPLE_PRIVATE_KEY.secretName"],
  ];
  for (const [mutate, code] of cases) {
    assert.throws(() => manifest.validateDesiredState(filledProduction(mutate)), { code }, code);
  }
  // Staging keeps its marker everywhere, never the production token, and never a test name.
  for (const [mutate, code] of [
    [(value) => { value.secrets.IDENTITY_LINK_SECRET.secretName = "IDENTITY_LINK_SECRET"; },
      "SECRET_ID_FORM_INVALID:secrets.IDENTITY_LINK_SECRET.secretName"],
    [(value) => { value.secrets.IDENTITY_LINK_SECRET.secretName = "synthetic-staging-identity-link"; },
      "SECRET_ID_FORM_INVALID:secrets.IDENTITY_LINK_SECRET.secretName"],
    [(value) => { value.cloudSql.instance = "tibotattle-staging-production-primary"; },
      "DESIRED_STATE_PRODUCTION_NAME_FORBIDDEN:cloudSql.instance"],
    [(value) => { value.service.name = "tibotattle-test-app"; }, "DESIRED_STATE_TEST_TARGET_NAME:plane:service.name"],
    // The test estate's image repository, whole or as a test-token repository.
    [(value) => { value.artifactRegistry.repository = "tibotattle-test"; },
      "DESIRED_STATE_TEST_TARGET_NAME:artifactRegistry.imageRepository"],
    [(value) => { value.artifactRegistry.repository = "tibotattle-test"; value.artifactRegistry.imageName = "staging-host"; },
      "DESIRED_STATE_TEST_TOKEN_NAME:artifactRegistry.imageRepository"],
    [(value) => { value.serviceAccounts.migrator.accountId = "tibotattle-test-migrator"; },
      "DESIRED_STATE_TEST_TARGET_NAME:serviceAccounts.migrator.accountId"],
  ]) {
    assert.throws(() => manifest.validateDesiredState(committed("staging", mutate)), { code }, code);
  }
  // A staging plane may also be dedicated; only production is barred from sharing.
  assert.equal(manifest.validateDesiredState(unmarked((value) => {
    stagingNames(value);
    value.projectTenancy = "dedicated";
  })).projectTenancy, "dedicated");
});

test("committed files refuse secret material anywhere, before any shape check", () => {
  const pem = "-----BEGIN PRIVATE KEY-----\\nc3ludGhldGlj\\n-----END PRIVATE KEY-----";
  const jwk = JSON.stringify({ kty: "RSA", n: "synthetic", e: "AQAB", d: "synthetic" });
  for (const [environment, mutate, path] of [
    ["staging", (value) => { value.secrets.IDENTITY_LINK_SECRET.value = "synthetic-secret"; },
      "desiredState.secrets.IDENTITY_LINK_SECRET.value"],
    ["staging", (value) => { value.secrets.ENVELOPE_PRIVATE_JWK.jwk = { kty: "RSA" }; },
      "desiredState.secrets.ENVELOPE_PRIVATE_JWK.jwk"],
    ["staging", (value) => { value.secrets.APPLE_PRIVATE_KEY.privateKey = pem; },
      "desiredState.secrets.APPLE_PRIVATE_KEY.privateKey"],
    ["staging", (value) => { value.serviceAccounts.edgeInvoker.keyJson = "{}"; },
      "desiredState.serviceAccounts.edgeInvoker.keyJson"],
    ["staging", (value) => { value.password = "x"; }, "desiredState.password"],
    ["staging", (value) => { value.service.audience = pem; }, "desiredState.service.audience"],
    ["staging", (value) => { value.service.audience = jwk; }, "desiredState.service.audience"],
    ["staging", (value) => { value.secrets.GOOGLE_OIDC_CLIENT_SECRET.secretName = `AIza${"Sy".repeat(17)}x`; },
      "desiredState.secrets.GOOGLE_OIDC_CLIENT_SECRET.secretName"],
    ["staging", (value) => { value.secrets.DISTRIBUTION_GITHUB_API_TOKEN.secretName = `ghp_${"aB3".repeat(12)}`; },
      "desiredState.secrets.DISTRIBUTION_GITHUB_API_TOKEN.secretName"],
    ["staging", (value) => { value.secrets.POSTGRES_RATE_LIMIT_SECRET.secretName = "Q2xhdWRlU3ludGhldGljU2VjcmV0VmFsdWUxMjM0"; },
      "desiredState.secrets.POSTGRES_RATE_LIMIT_SECRET.secretName"],
    ["staging", (value) => { value.service.telemetryStorageNamespace = "x".repeat(257); },
      "desiredState.service.telemetryStorageNamespace"],
    ["production", (value) => { value.secrets.IDENTITY_LINK_SECRET.version = "synthetic-value"; value.token = "t"; },
      "desiredState.token"],
  ]) {
    const value = environment === "production" ? filledProduction(mutate) : committed(environment, mutate);
    assert.throws(() => manifest.validateDesiredState(value), { code: `DESIRED_STATE_SECRET_VALUE_FORBIDDEN:${path}` }, path);
  }
  // Identifiers are not mistaken for secrets.
  assert.equal(manifest.validateDesiredState(committed("staging", (value) => {
    value.service.audience = "tibotattle-staging-edge-origin-audience-with-a-long-lowercase-name";
  })).service.audience.length > 32, true);
  assert.ok(manifest.SECRET_VALUE_KEYS.includes("value"));
});

test("committed files close each secret id to its plane's form, so a pasted value is never an id", () => {
  // Synthetic stand-ins for the shapes the secret-material scan cannot tell
  // from an identifier: lowercase hex, uppercase hex, lowercase base64url and
  // a mixed-case token shorter than the scan's 32 characters.
  const pasted = [
    "0f1e2d3c4b5a6978".repeat(4),
    "0F1E2D3C4B5A6978".repeat(4),
    "c3ludghldglj_c2vjcmv0-dmfsdwu0zm9ylxrlc3q",
    "Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4wX".slice(0, 31),
  ];
  const code = "SECRET_ID_FORM_INVALID:secrets.IDENTITY_LINK_SECRET.secretName";
  for (const value of pasted) {
    assert.throws(() => manifest.validateDesiredState(filledProduction((desired) => {
      desired.secrets.IDENTITY_LINK_SECRET.secretName = value;
    })), { code }, `production ${value}`);
    assert.throws(() => manifest.validateDesiredState(committed("staging", (desired) => {
      desired.secrets.IDENTITY_LINK_SECRET.secretName = value;
    })), { code }, `staging ${value}`);
  }
  // Production: the variable name EP-7's template uses, or a tibotattle- id;
  // never another variable's name, a foreign prefix or upper-case words.
  for (const value of ["APPLE_PRIVATE_KEY", "IDENTITY_LINK", "identity-link-secret", "Tibotattle-identity-link",
    "tibotattle_identity_link", "tibotattle-", "tibotattle--identity"]) {
    assert.throws(() => manifest.validateDesiredState(filledProduction((desired) => {
      desired.secrets.IDENTITY_LINK_SECRET.secretName = value;
    })), { code }, `production ${value}`);
  }
  assert.equal(manifest.validateDesiredState(filledProduction((desired) => {
    desired.secrets.IDENTITY_LINK_SECRET.secretName = "tibotattle-identity-link";
  })).secrets.IDENTITY_LINK_SECRET.secretName, "tibotattle-identity-link");
  // Staging: only tibotattle-staging- ids.
  for (const value of ["tibotattle-identity-link", "staging-identity-link", "tibotattle-staging-"]) {
    assert.throws(() => manifest.validateDesiredState(committed("staging", (desired) => {
      desired.secrets.IDENTITY_LINK_SECRET.secretName = value;
    })), { code }, `staging ${value}`);
  }
  // The committed ids are in their forms, and the JSON Schema states the
  // union of both forms per variable and refuses every pasted value.
  const schema = JSON.parse(readFileSync(join(WORKER_ROOT, manifest.DESIRED_STATE_JSON_SCHEMA_FILE), "utf8"));
  const production = JSON.parse(COMMITTED.production);
  const staging = JSON.parse(COMMITTED.staging);
  assert.equal(manifest.STAGING_SECRET_ID.source.startsWith("^tibotattle-staging-"), true);
  for (const [name, node] of Object.entries(schema.properties.secrets.properties)) {
    const secretName = node.properties.secretName;
    assert.equal(secretName.pattern, `^(?:${name}|${manifest.PLANE_SECRET_ID.source.slice(1, -1)})$`, name);
    assert.equal(secretName.maxLength, 255, name);
    const pattern = new RegExp(secretName.pattern, "u");
    assert.equal(production.secrets[name].secretName, name, name);
    assert.equal(manifest.STAGING_SECRET_ID.test(staging.secrets[name].secretName), true, name);
    assert.equal(pattern.test(staging.secrets[name].secretName), true, name);
    for (const value of pasted) assert.equal(pattern.test(value), false, `${name} ${value}`);
  }
});

test("the verifier's token creators are the operator's principals only, closed and normalized", () => {
  const desired = manifest.validateDesiredState(fixture((value) => {
    value.serviceAccounts.verifier.tokenCreators = ["user:operator@example.com", "group:ops@example.com"];
  }));
  assert.deepEqual(desired.serviceAccounts.verifier.tokenCreators, ["group:ops@example.com", "user:operator@example.com"]);
  assert.equal(manifest.TOKEN_CREATOR_ROLE, "roles/iam.serviceAccountTokenCreator");
  for (const tokenCreators of [[], ["allUsers"], ["allAuthenticatedUsers"], ["domain:example.com"],
    ["user:operator"], ["operator@example.com"], ["user:a@example.com", "user:a@example.com"],
    ["user:a@example.com", "user:b@example.com", "user:c@example.com", "user:d@example.com", "user:e@example.com"],
    "user:operator@example.com", [7]]) {
    refused((value) => { value.serviceAccounts.verifier.tokenCreators = tokenCreators; },
      "DESIRED_STATE_VALUE_INVALID:serviceAccounts.verifier.tokenCreators");
  }
  refused((value) => { delete value.serviceAccounts.verifier.tokenCreators; },
    "DESIRED_STATE_KEY_MISSING:serviceAccounts.verifier.tokenCreators");
  // Only the verifier carries the key, and no account of the plane may mint its tokens.
  refused((value) => { value.serviceAccounts.edgeInvoker.tokenCreators = null; },
    "DESIRED_STATE_KEY_UNKNOWN:serviceAccounts.edgeInvoker.tokenCreators");
  refused((value) => {
    value.serviceAccounts.verifier.tokenCreators = ["serviceAccount:synthetic-runtime@synthetic-ops-project.iam.gserviceaccount.com"];
  }, "VERIFIER_TOKEN_CREATOR_MANAGED_ACCOUNT_FORBIDDEN");
});

test("the committed JSON Schema has exactly the validator's closed key sets", () => {
  const schema = JSON.parse(readFileSync(join(WORKER_ROOT, manifest.DESIRED_STATE_JSON_SCHEMA_FILE), "utf8"));
  const closed = (node, keys, label) => {
    assert.equal(node.type, "object", label);
    assert.equal(node.additionalProperties, false, label);
    assert.deepEqual(Object.keys(node.properties), [...keys], label);
    assert.deepEqual(node.required, [...keys], label);
  };
  const variant = (node) => node.oneOf?.find((entry) => entry.type === "object") ?? node;
  const shape = manifest.DESIRED_STATE_SHAPE;
  closed(schema, shape.desiredState, "desiredState");
  assert.equal(schema.properties.schemaVersion.const, manifest.GCP_OPS_INFRA_DESIRED_STATE_SCHEMA);
  assert.deepEqual(schema.properties.environment.enum, [...manifest.GCP_OPS_INFRA_ENVIRONMENTS]);
  assert.deepEqual(schema.properties.projectTenancy.enum, [...manifest.PROJECT_TENANCIES]);
  closed(schema.properties.artifactRegistry, shape.artifactRegistry, "artifactRegistry");
  closed(schema.properties.serviceAccounts, manifest.SERVICE_ACCOUNT_ROLES, "serviceAccounts");
  for (const role of manifest.SERVICE_ACCOUNT_ROLES) {
    closed(variant(schema.properties.serviceAccounts.properties[role]),
      role === "verifier" ? shape.verifier : shape.serviceAccount, role);
  }
  closed(schema.properties.customRole, shape.customRole, "customRole");
  assert.equal(schema.properties.customRole.properties.id.const, manifest.QUARANTINE_STORE_ROLE_ID);
  closed(schema.properties.secrets, [...configuration.REQUIRED_SECRET_NAMES, ...configuration.OPTIONAL_SECRET_NAMES], "secrets");
  for (const secret of Object.values(schema.properties.secrets.properties)) closed(secret, shape.secret, "secret");
  closed(schema.properties.cloudSql, shape.cloudSql, "cloudSql");
  closed(schema.properties.bucket, shape.bucket, "bucket");
  closed(variant(schema.properties.bucket.properties.proof), shape.bucketProof, "bucket.proof");
  closed(schema.properties.service, shape.service, "service");
  closed(schema.properties.jobs, manifest.JOB_NAMES, "jobs");
  for (const job of manifest.JOB_NAMES) closed(schema.properties.jobs.properties[job], shape.job, job);
  closed(schema.properties.scheduler, manifest.SCHEDULED_JOB_NAMES, "scheduler");
  for (const job of manifest.SCHEDULED_JOB_NAMES) {
    closed(schema.properties.scheduler.properties[job], shape.trigger, job);
    assert.deepEqual(schema.properties.scheduler.properties[job].properties.state.enum, [...manifest.SCHEDULER_TRIGGER_STATES]);
  }
  // Exactly the owner placeholders, and the values that wait for the owner, admit null.
  for (const path of manifest.OWNER_PLACEHOLDER_PATHS) {
    const [head, tail] = path.split(".");
    const node = tail === undefined ? schema.properties[head] : schema.properties[head].properties[tail];
    assert.deepEqual(node.type, ["string", "null"], path);
  }
  // The committed files and the fixture carry the validator's schema version.
  for (const text of [COMMITTED.production, COMMITTED.staging, JSON.stringify(FIXTURE)]) {
    assert.equal(JSON.parse(text).schemaVersion, manifest.GCP_OPS_INFRA_DESIRED_STATE_SCHEMA);
  }
});

test("the service render names each secret by its Secret Manager id and waits for its template and namespace", () => {
  const renamed = manifest.validateDesiredState(unmarked((value) => {
    value.secrets.IDENTITY_LINK_SECRET.secretName = "tibotattle-identity-link";
    value.secrets.DISTRIBUTION_GITHUB_API_TOKEN.version = "2";
  }));
  const env = manifest.renderService(renamed, IMAGE).spec.template.spec.containers[0].env;
  const reference = (name) => env.find((entry) => entry.name === name).valueFrom.secretKeyRef;
  assert.deepEqual(reference("IDENTITY_LINK_SECRET"), { name: "tibotattle-identity-link", key: "1" });
  assert.deepEqual(reference("APPLE_PRIVATE_KEY"), { name: "APPLE_PRIVATE_KEY", key: "1" });
  assert.deepEqual(reference("DISTRIBUTION_GITHUB_API_TOKEN"), { name: "DISTRIBUTION_GITHUB_API_TOKEN", key: "2" });
  // EP-7's own render (the template's variable names) is unchanged.
  const values = manifest.serviceTemplateValues(renamed, IMAGE);
  assert.equal(manifest.renderServiceTemplateValues(values).spec.template.spec.containers[0].env
    .find((entry) => entry.name === "IDENTITY_LINK_SECRET").valueFrom.secretKeyRef.name, "IDENTITY_LINK_SECRET");
  const noNamespace = manifest.validateDesiredState(unmarked((value) => { value.service.telemetryStorageNamespace = null; }));
  assert.throws(() => manifest.renderService(noNamespace, IMAGE), { code: "TELEMETRY_STORAGE_NAMESPACE_UNASSIGNED" });
  const staging = manifest.validateDesiredState(unmarked(stagingNames));
  assert.throws(() => manifest.renderService(staging, IMAGE), { code: "STAGING_SERVICE_TEMPLATE_UNAVAILABLE" });
  assert.deepEqual({ ...manifest.SERVICE_TEMPLATE_UNAVAILABLE }, { staging: "STAGING_SERVICE_TEMPLATE_UNAVAILABLE" });
});
