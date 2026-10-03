#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync as readFileSyncText } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import {
  checkOriginEdgeContract,
  assertMeasurementInstance,
  assertRefreshIdle,
  countMigrationsAtCommit,
  EDGE_PROXY_SOURCE,
  EDGE_TEST_PRODUCTION_SETTINGS,
  EDGE_TEST_UNMIRRORED_SETTINGS,
  edgeTestProductionEnv,
  ensureOriginBucketRuntimeBinding,
  executeJobCommand,
  executionCompleted,
  executionDescribeCommand,
  executionLogsCommand,
  expectedRefreshTask,
  FASTPATH_CORPORA,
  FASTPATH_MEASUREMENT,
  FASTPATH_TEST,
  jobDescribeCommand,
  jobExecutionsCommand,
  jobsListCommand,
  jobTaskSpec,
  main,
  measDatabaseCreateCommand,
  measDatabasesListCommand,
  measExecutionCancelCommand,
  measIamUserCreateCommand,
  measCreateFlags,
  measFlagsListCommand,
  measInstanceCreateCommand,
  measInstanceDeleteCommand,
  measInstanceDescribeCommand,
  measInstancesListCommand,
  measJobDeleteCommand,
  measurementInstanceMismatches,
  measurementInstancesListed,
  measUsersListCommand,
  migrateJobCommand,
  ORIGIN_BUCKET_RUNTIME_BINDING,
  originBucketBindingCommand,
  originBucketPolicyCommand,
  ORIGIN_TEST_CLOCK_ENV,
  originClockEnv,
  originInvokerCommand,
  originSourceEnv,
  primarySchemaOf,
  readExecutionLog,
  REFRESH_JOB_PROFILES,
  REFRESH_JOB_RESOURCES,
  REFRESH_TASK_TIMEOUT_ENV,
  REFRESH_TASK_TIMEOUT_MAXIMUM_SECONDS,
  refreshJobCommand,
  refreshTarget,
  refreshTaskMismatches,
  renderOriginService,
  runningExecutions,
  sqlOperationWaitCommand,
  REFRESH_PROFILE_SCHEMA,
  stepMeasCreate,
  stepMeasMetrics,
  stepMeasPgStat,
  stepMeasPgStatEnable,
  stepMeasTeardown,
  stepRefreshUncapped,
  stepsReadGolden,
  uncappedOutcome,
  validateOriginBucketPolicy,
  validateOriginPolicy,
} from "./gcp-fastpath-test-deploy.mjs";
import { readSeedGolden } from "./gcp-fastpath-seed.mjs";
import { DIGEST_ONLY_GOLDEN_SOURCE, withDigestOnlyGolden } from "../analytics-v2-test/fixtures/digest-only-golden.mjs";
import {
  analyticsV2TestClock,
  FASTPATH_MEASUREMENT_CLOUD_TARGET,
  FASTPATH_TEST_CLOUD_TARGET,
  fastpathMeasurementInstance,
  fastpathTestDatabaseConfig,
  isFastpathMeasurementInstanceConnectionName,
} from "../cloud-run/origin-fastpath-mode.mjs";
import {
  GCP_FASTPATH_REHEARSAL_REFRESH_HEAP_MIB,
  GCP_FASTPATH_REHEARSAL_REFRESH_SEMI_SPACE_MIB,
} from "./gcp-fastpath-rehearsal.mjs";
import { GCP_FASTPATH_SEED } from "./gcp-fastpath-seed.mjs";
import {
  ANALYTICS_REFRESH_PRODUCTION_JOB,
  ANALYTICS_REFRESH_TASK_MEMORY_CHECK,
  ANALYTICS_REFRESH_WORKER_HEAP_RESERVE_BYTES,
  analyticsRefreshResources,
  parseAnalyticsRefreshArguments,
  readAnalyticsRefreshProductionTarget,
  resolveAnalyticsRefreshDatabase,
} from "../cloud-run/analytics-refresh.mjs";
import { CLOUD_SQL_LOGGING_FLAGS, CLOUD_SQL_POSTURE, cloudSqlCreateArgs, databaseFlags,
  loadCommittedDesiredState } from "./gcp-ops-infra-manifest.mjs";
import { fastpathInstanceConnectionName } from "./gcp-fastpath-connection.mjs";

import { applyEdgeModeSnapshotDelta } from "./edge-mode-configuration.mjs";
import { createProductionLiveConfigSnapshot } from "./production-live-config.mjs";
import { EDGE_CAPTURE_MAX_AGE_MS, ROLLOUT_EDGE_LIVE_SCHEMA } from "./gcp-production-rollout.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = `${FASTPATH_TEST.imageRepository}@sha256:${"a".repeat(64)}`;
const PROOF = JSON.stringify({ bucket: FASTPATH_TEST.originBucket, bucketGeneration: "1",
  bucketMetageneration: "1", softDeleteRetentionDurationSeconds: "0" });
const SOURCE = Object.freeze({ sourceId: "synthetic-source", sourceNamespace: "synthetic-namespace" });

// ---------------------------------------------------------------------------
// D-BLOB: a synthetic EP-9 capture of the tracked production Worker in worker
// mode, whose DEPLOYMENT_SOURCE_COMMIT is this checkout's HEAD, so the
// contract blob at --commit=HEAD equals the live edge's.

const HEAD_COMMIT = spawnSync("git", ["-C", WORKER_ROOT, "rev-parse", "--verify", "HEAD"], { encoding: "utf8" })
  .stdout.trim();
const EDGE_FIXTURE = JSON.parse(await readFile(new URL("./fixtures/edge-mode-live-snapshot.synthetic.json",
  import.meta.url), "utf8"));
const TRACKED_WRANGLER = parseJsonc(await readFile(join(WORKER_ROOT, "wrangler.jsonc"), "utf8"));

function liveSnapshot(snapshot, overrides) {
  const value = { ...snapshot, ...overrides };
  const bindings = value.bindings.map((binding) => (binding.type === "d1" ? { ...binding, id: binding.database_id } : binding));
  return createProductionLiveConfigSnapshot({
    accountId: value.accountId,
    workerName: value.workerName,
    version: { id: value.versionId, resources: { script_runtime: value.runtime, bindings } },
    settings: { ...value.settings, compatibility_date: value.runtime.compatibility_date,
      compatibility_flags: value.runtime.compatibility_flags, usage_model: value.runtime.usage_model,
      limits: value.runtime.limits, cache_options: value.runtime.cache_options, bindings },
    schedules: { schedules: value.crons.map((cron) => ({ cron })) },
    subdomain: value.subdomain,
    routes: value.routes,
    domains: value.domains,
    namespaces: value.namespaces,
  });
}

/** The capture text: worker mode, one deployment at 100%, edge commit `edgeCommit`. */
function edgeCapture({ edgeCommit = HEAD_COMMIT, capturedAt = new Date().toISOString() } = {}) {
  const worker = applyEdgeModeSnapshotDelta({ snapshot: EDGE_FIXTURE, mode: "worker", trackedConfig: TRACKED_WRANGLER });
  const withCommit = liveSnapshot(worker, { bindings: worker.bindings.map((binding) =>
    (binding.name === "DEPLOYMENT_SOURCE_COMMIT" ? { ...binding, text: edgeCommit } : binding)) });
  const snapshot = liveSnapshot(withCommit, { versionId: "0e000000-0000-4000-8000-000000000201" });
  return JSON.stringify({ schema: ROLLOUT_EDGE_LIVE_SCHEMA, capturedAt, snapshot,
    deployment: { versions: [{ version_id: snapshot.versionId, percentage: 100 }] } });
}

/** A temporary capture file and the D-BLOB arguments that name it. */
async function edgeArguments(t, options) {
  const directory = await mkdtemp(join(tmpdir(), "fastpath-deploy-edge-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "edge-live.json");
  await writeFile(path, edgeCapture(options), { mode: 0o600 });
  return ["--commit=HEAD", `--edge-live=${path}`, "--edge-environment=production"];
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

test("every write command targets only fast-path resources in the tibotattle project", () => {
  const commands = [
    migrateJobCommand({ image: IMAGE, expectedCounts: { primary: 64 } }),
    refreshJobCommand({ image: IMAGE }),
    refreshJobCommand({ image: IMAGE, now: "2026-10-01T00:00:00Z" }),
    executeJobCommand(FASTPATH_TEST.migrateJob),
    executeJobCommand(FASTPATH_TEST.refreshJob),
    originInvokerCommand(),
  ];
  for (const command of commands) {
    assert.equal(command[0], "gcloud");
    assert.equal(command.includes("--project=tibotattle"), true);
    assert.equal(command.some((arg) => /^tibotattle-fastpath-test-/u.test(arg)), true);
    for (const name of FASTPATH_TEST.protectedServices) {
      assert.equal(command.some((arg) => arg.includes(name)), false);
    }
    assert.equal(command.some((arg) => /tibotattle_v12_a2|graph_benchmark|allUsers/u.test(arg)), false);
  }
  expectCode(() => executeJobCommand("tibotattle-test-database-migrate"),
    "FASTPATH_DEPLOY_TARGET_NOT_FASTPATH");
  expectCode(() => migrateJobCommand({ image: "us-east1-docker.pkg.dev/tibotattle/tibotattle-test/tibotattle-host:latest",
    expectedCounts: { primary: 64 } }), "FASTPATH_DEPLOY_IMAGE_DIGEST_REQUIRED");
  // Primary only: a counts record that still names the retired ledger role,
  // or lacks a positive primary count, is a stale caller.
  for (const expectedCounts of [{ primary: 64, ledger: 7 }, { ledger: 7 }, {}, { primary: 0 }, { primary: "64" },
    null, undefined]) {
    expectCode(() => migrateJobCommand({ image: IMAGE, expectedCounts }), "FASTPATH_DEPLOY_EXPECTED_COUNTS_INVALID");
  }
});

test("migrate and refresh Jobs carry the exact database targets, identities and sizes", () => {
  const migrate = migrateJobCommand({ image: IMAGE, expectedCounts: { primary: 64 } });
  const env = migrate.find((arg) => arg.startsWith("--set-env-vars="));
  for (const pair of [
    "PRIMARY_DATABASE=tibotattle_fastpath",
    "PRIMARY_SCHEMA=tibotattle_fastpath_20261001",
    "PRIMARY_EXPECTED_MIGRATIONS=64",
    "POSTGRES_MIGRATOR_IAM_USER=tibotattle-test-migrator@tibotattle.iam",
  ]) assert.equal(env.includes(pair), true, pair);
  // No ledger setting reaches a fast-path Job (decisions D2, D4 and D6).
  assert.doesNotMatch(env, /(?:^|[=,])LEDGER_/u);
  assert.equal(migrate.includes(`--service-account=${FASTPATH_TEST.migratorServiceAccount}`), true);
  assert.equal(migrate.includes("--args=dist/test-migrations.mjs,--profile=fastpath"), true);

  const plain = refreshJobCommand({ image: IMAGE });
  assert.equal(plain.includes(
    "--args=--max-old-space-size=6144,--max-semi-space-size=64,dist/analytics-refresh.mjs,--mode=full,"
    + "--schema=tibotattle_fastpath_20261001"), true);
  assert.equal(plain.some((arg) => arg.includes("ANALYTICS_V2_TEST_CLOCK")), false);
  const clocked = refreshJobCommand({ image: IMAGE, now: "2026-10-01T00:00:00Z", extraEnv: [["EXTRA_FLAG", "1"]] });
  assert.equal(clocked.some((arg) => arg.endsWith(",--now=2026-10-01T00:00:00Z")), true);
  assert.equal(clocked.some((arg) => arg.includes("ANALYTICS_V2_TEST_CLOCK=1") && arg.includes("EXTRA_FLAG=1")), true);
  // An 8 GiB task with a 6,144 MiB heap: the job's default budget plus its reserve.
  for (const flag of ["--cpu=2", "--memory=8Gi", "--task-timeout=7200s", "--max-retries=0",
    `--service-account=${FASTPATH_TEST.runtimeServiceAccount}`]) {
    assert.equal(clocked.includes(flag), true, flag);
  }
  const MIB = 1_048_576;
  // heap_size_limit is the old space plus three semi-spaces (Node.js 22.16.0).
  const heapLimit = (REFRESH_JOB_RESOURCES.heapMiB + 3 * REFRESH_JOB_RESOURCES.semiSpaceMiB) * MIB;
  assert.ok(analyticsRefreshResources({}, heapLimit, { execArgv: [`--max-old-space-size=${REFRESH_JOB_RESOURCES.heapMiB}`,
    `--max-semi-space-size=${REFRESH_JOB_RESOURCES.semiSpaceMiB}`] }).requiredHeapBytes
    <= REFRESH_JOB_RESOURCES.heapMiB * MIB, "the default budget plus reserve fits the Job's old-space size");
  assert.equal(GCP_FASTPATH_REHEARSAL_REFRESH_HEAP_MIB, REFRESH_JOB_RESOURCES.heapMiB, "the rehearsal runs the Job's heap");
  assert.equal(GCP_FASTPATH_REHEARSAL_REFRESH_SEMI_SPACE_MIB, REFRESH_JOB_RESOURCES.semiSpaceMiB,
    "the inline rehearsal runs the Job's semi-space");
  expectCode(() => refreshJobCommand({ image: IMAGE, now: "yesterday" }), "FASTPATH_DEPLOY_NOW_INVALID");
  expectCode(() => refreshJobCommand({ image: IMAGE, extraArgs: ["--a,b"] }), "FASTPATH_DEPLOY_ARGS_INVALID");
  expectCode(() => refreshJobCommand({ image: IMAGE, extraEnv: [["bad-key", "1"]] }), "FASTPATH_DEPLOY_ENV_INVALID");
});

/** V8's default heap limit for a 16 GiB task under Node 22.16.0 (measured: heap_size_limit without a flag). */
const V8_DEFAULT_HEAP_LIMIT_MIB = 4_144;

test("refresh profiles: the standard Job stays the default; the dense Jobs are 4 vCPU, 16 GiB with a fitting budget", () => {
  assert.equal(REFRESH_JOB_RESOURCES, REFRESH_JOB_PROFILES.standard);
  assert.deepEqual(Object.keys(REFRESH_JOB_PROFILES), ["standard", "dense", "dense-workers"]);
  assert.deepEqual(refreshJobCommand({ image: IMAGE }), refreshJobCommand({ image: IMAGE, profile: "standard" }));
  const dense = refreshJobCommand({ image: IMAGE, now: "2026-10-01T12:46:00Z", profile: "dense" });
  for (const flag of ["--cpu=4", "--memory=16Gi", "--task-timeout=86400s", "--max-retries=0"]) {
    assert.equal(dense.includes(flag), true, flag);
  }
  // The dense profile is the production profile: inline (no --workers), with
  // the production job's 64 MiB semi-space (owner decisions round 19, SEMI).
  assert.equal(dense.some((arg) => arg.startsWith(
    "--args=--max-old-space-size=12288,--max-semi-space-size=64,dist/analytics-refresh.mjs,")
    && !arg.includes("--workers")), true);
  // dense-workers runs the compute Workers (K-PAR): the same task and budget,
  // four Workers and NO heap flag, which would override the Workers' limits
  // (K-PAR-MEM; the Job refuses one with --workers > 1).
  const workers = refreshJobCommand({ image: IMAGE, now: "2026-10-01T12:46:00Z", profile: "dense-workers" });
  for (const flag of ["--cpu=4", "--memory=16Gi", "--task-timeout=86400s", "--max-retries=0"]) {
    assert.equal(workers.includes(flag), true, flag);
  }
  assert.equal(workers.some((arg) => arg.startsWith("--args=dist/analytics-refresh.mjs,")
    && arg.endsWith(",--workers=4")), true);
  assert.equal(workers.some((arg) => arg.includes("--max-old-space-size")), false);
  assert.equal(workers.some((arg) => arg.startsWith("--set-env-vars=")
    && arg.includes("ANALYTICS_V2_MEMORY_BUDGET_MIB=10752")), true);
  assert.equal(dense.some((arg) => arg.startsWith("--set-env-vars=") && arg.includes("ANALYTICS_V2_MEMORY_BUDGET_MIB=10752")
    && arg.includes("ANALYTICS_V2_TEST_CLOCK=1")), true);
  // An explicit --refresh-env still overrides the profile's budget.
  const overridden = refreshJobCommand({ image: IMAGE, profile: "dense",
    extraEnv: [["ANALYTICS_V2_MEMORY_BUDGET_MIB", "8192"]] });
  assert.equal(overridden.some((arg) => arg.includes("ANALYTICS_V2_MEMORY_BUDGET_MIB=8192")
    && !arg.includes("ANALYTICS_V2_MEMORY_BUDGET_MIB=10752")), true);
  const MIB = 1_048_576;
  for (const [name, profile] of Object.entries(REFRESH_JOB_PROFILES)) {
    const env = Object.fromEntries(profile.env);
    // The job's own start-up guard accepts the profile's heap for its budget...
    const taskMiB = Number.parseInt(profile.memory, 10) * 1024;
    // A profile without a heap flag runs at V8's default heap limit for the
    // task (about 4,144 MiB for 16 GiB under Node 22).
    const heapMiB = profile.heapMiB ?? V8_DEFAULT_HEAP_LIMIT_MIB - 48;
    assert.equal(profile.heapMiB === null, profile.workers > 1, `${name}: a heap flag only inline`);
    const resources = analyticsRefreshResources(env, (heapMiB + 48) * MIB,
      { workers: profile.workers, taskMemoryBytes: taskMiB * MIB });
    assert.ok(resources.requiredHeapBytes <= heapMiB * MIB, name);
    // ...and Cloud Run's memory holds the heap, the compute Workers' pool
    // (K-PAR-MEM: the task memory the heap and the native reserve leave; the
    // pool's admission keeps the Workers' heaps and overheads within it, and
    // it runs the budget's largest owner alone; inline the budget is inside
    // the heap) plus at least 1 GiB of native memory.
    const workerMiB = profile.workers > 1 ? resources.workerPool.poolBytes / MIB : 0;
    assert.ok(taskMiB - (heapMiB + 48) - workerMiB >= 1_024, name);
  }
  expectCode(() => refreshJobCommand({ image: IMAGE, profile: "huge" }), "FASTPATH_DEPLOY_REFRESH_PROFILE_INVALID");
});

test("the corpora name the seed's committed goldens and their default refresh profiles", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(FASTPATH_CORPORA).map(([name, corpus]) => [name, corpus.golden])),
    GCP_FASTPATH_SEED.corpora);
  assert.equal(FASTPATH_CORPORA.q1.golden, GCP_FASTPATH_SEED.defaultGolden);
  assert.deepEqual(Object.values(FASTPATH_CORPORA).map((corpus) => corpus.refreshProfile), ["standard", "dense"]);
});

test("origin service is private, references test secrets by name and keeps the origin on loopback", () => {
  const sidecar = renderOriginService({ image: IMAGE, bucketHistoryProof: PROOF });
  assert.match(sidecar, /name: tibotattle-fastpath-test-origin\n/u);
  assert.match(sidecar, /- name: edge\n/u);
  assert.match(sidecar, /containerPort: 8081\n/u);
  assert.match(sidecar, /name: HOST\n {10}value: "127\.0\.0\.1"/u);
  assert.match(sidecar, /name: HOST_ORIGIN\n {10}value: "http:\/\/127\.0\.0\.1:8080"/u);
  assert.match(sidecar, /args: \["PORT=8080", "node", "dist\/server\.mjs"\]/u);
  assert.doesNotMatch(sidecar, /name: PORT\n/u);
  assert.doesNotMatch(sidecar, /allUsers|allAuthenticatedUsers/u);
  for (const secret of Object.values(FASTPATH_TEST.originSecretRefs)) {
    assert.match(sidecar, new RegExp(`name: ${secret}\\n`, "u"));
  }
  assert.match(sidecar, /name: PRIMARY_DATABASE\n {10}value: "tibotattle_fastpath"/u);
  const direct = renderOriginService({ image: IMAGE, variant: "direct", bucketHistoryProof: PROOF,
    originEnv: originClockEnv([], "2026-10-01T00:00:00Z") });
  assert.doesNotMatch(direct, /- name: edge\n/u);
  assert.match(direct, /name: HOST_ORIGIN\n {10}value: "https:\/\/tibotattle-fastpath-test-origin-806510610397\.us-east1\.run\.app"/u);
  assert.match(direct, /name: ANALYTICS_V2_TEST_NOW_MS\n {10}value: "1790812800000"/u);
  expectCode(() => renderOriginService({ image: IMAGE, bucketHistoryProof: PROOF, originEnv: [["PORT", "1"]] }),
    "FASTPATH_DEPLOY_ENV_INVALID");
  expectCode(() => renderOriginService({ image: IMAGE, variant: "public", bucketHistoryProof: PROOF }),
    "FASTPATH_DEPLOY_ORIGIN_VARIANT_INVALID");
});

test("origin policy accepts only the journey service account as invoker", () => {
  const journey = `serviceAccount:${FASTPATH_TEST.journeyServiceAccount}`;
  assert.deepEqual(validateOriginPolicy({ bindings: [{ role: "roles/run.invoker", members: [journey] }] }).invokers,
    [journey]);
  expectCode(() => validateOriginPolicy({ bindings: [{ role: "roles/run.invoker", members: [journey, "allUsers"] }] }),
    "FASTPATH_DEPLOY_ORIGIN_PUBLIC_INVOKER");
  expectCode(() => validateOriginPolicy({ bindings: [{ role: "roles/run.viewer", members: ["allAuthenticatedUsers"] }] }),
    "FASTPATH_DEPLOY_ORIGIN_PUBLIC_INVOKER");
  expectCode(() => validateOriginPolicy({ bindings: [{ role: "roles/run.invoker",
    members: [journey, "user:someone@example.com"] }] }), "FASTPATH_DEPLOY_ORIGIN_INVOKER_UNEXPECTED");
  expectCode(() => validateOriginPolicy({}), "FASTPATH_DEPLOY_ORIGIN_INVOKER_UNEXPECTED");
});

test("expected migration counts are read from the commit tree, not pinned", async () => {
  const head = spawnSync("git", ["-C", WORKER_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const counts = countMigrationsAtCommit(head);
  const dirty = spawnSync("git", ["-C", WORKER_ROOT, "status", "--porcelain", "--", "postgres/migrations"],
    { encoding: "utf8" }).stdout.trim();
  if (dirty === "") {
    const files = (await readdir(resolve(WORKER_ROOT, "postgres/migrations", "primary")))
      .filter((name) => /^\d{4}_[a-z][a-z0-9_-]*\.sql$/u.test(name));
    assert.equal(counts.primary, files.length);
  }
  assert.deepEqual(Object.keys(counts), ["primary"], "no ledger role is counted");
  assert.equal(counts.primary > 0, true);
});

test("edge forwards only allowlisted GETs to the loopback origin and strips IAM headers", async () => {
  const seen = [];
  const origin = http.createServer((request, response) => {
    seen.push(request.headers);
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{\"ok\":true}");
  });
  await new Promise((done) => origin.listen(0, "127.0.0.1", done));
  const originPort = origin.address().port;
  const edgePort = originPort + 1;
  const edge = spawn(process.execPath, ["--input-type=module", "--eval", EDGE_PROXY_SOURCE], {
    env: { PATH: process.env.PATH, PORT: String(edgePort), ORIGIN_PORT: String(originPort),
      EDGE_GET_PATHS: FASTPATH_TEST.edgeGetPaths.join(",") },
    stdio: "ignore",
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50 && !ready; attempt += 1) {
      await new Promise((done) => setTimeout(done, 100));
      ready = await fetch(`http://127.0.0.1:${edgePort}/api/health`).then(() => true, () => false);
    }
    assert.equal(ready, true);
    const headers = { authorization: "Bearer a", "x-serverless-authorization": "Bearer b",
      "x-forwarded-for": "192.0.2.1", "x-tibotattle-host-kind": "edge" };
    const daily = await fetch(`http://127.0.0.1:${edgePort}/api/v1/community/daily?from=2026-04-15&to=2026-10-01`,
      { headers });
    assert.equal(daily.status, 200);
    const closed = await fetch(`http://127.0.0.1:${edgePort}/api/v1/session`, { headers });
    assert.equal(closed.status, 404);
    const post = await fetch(`http://127.0.0.1:${edgePort}/api/health`, { method: "POST", body: "x" });
    assert.equal(post.status, 404);
    const forwarded = seen.at(-1);
    assert.equal(forwarded.host, `127.0.0.1:${originPort}`);
    assert.equal(forwarded.authorization, undefined);
    assert.equal(forwarded["x-serverless-authorization"], undefined);
    assert.equal(forwarded["x-forwarded-for"], undefined);
    assert.equal(forwarded["x-tibotattle-host-kind"], "edge");
  } finally {
    edge.kill();
    origin.close();
  }
});

test("refresh and origin follow an explicit seeded rehearsal schema; migrate stays pinned", () => {
  const seeded = "typed_legacy_transfer_rehearsal_target_fastpath_0a1b2c3d";
  const refresh = refreshJobCommand({ image: IMAGE, schema: seeded });
  assert.equal(refresh.some((arg) => arg.includes(`--schema=${seeded}`)), true);
  assert.equal(refresh.some((arg) => arg.includes(`PRIMARY_SCHEMA=${seeded}`)), true);
  assert.equal(refresh.some((arg) => /LEDGER_/u.test(arg)), false, "no ledger setting reaches the refresh Job");
  const origin = renderOriginService({ image: IMAGE, bucketHistoryProof: PROOF, schema: seeded, sourceIdentity: SOURCE });
  assert.match(origin, new RegExp(`name: PRIMARY_SCHEMA\\n {10}value: "${seeded}"`, "u"));
  const migrate = migrateJobCommand({ image: IMAGE, expectedCounts: { primary: 64 } });
  assert.equal(migrate.some((arg) => arg.includes(`PRIMARY_SCHEMA=${FASTPATH_TEST.primarySchema}`)), true);
  assert.equal(primarySchemaOf(undefined), FASTPATH_TEST.primarySchema);
  for (const bad of ["tibotattle_v12_a2_20260925", "tibotattle", "typed_legacy_transfer_rehearsal_target_x",
    "typed_legacy_transfer_rehearsal_fp_483245ad_98936d54", "typed_legacy_transfer_rehearsal_target_fp_483245ad_98936d54",
    "typed_legacy_transfer_rehearsal_target_fastpath_0A1B2C3D", "public"]) {
    expectCode(() => primarySchemaOf(bad), "FASTPATH_DEPLOY_SCHEMA_INVALID");
    expectCode(() => refreshJobCommand({ image: IMAGE, schema: bad }), "FASTPATH_DEPLOY_SCHEMA_INVALID");
  }
});

/** --set-env-vars=K=V,... of one gcloud command, as an object. */
function commandEnv(command) {
  const flag = command.find((arg) => arg.startsWith("--set-env-vars="));
  return Object.fromEntries(flag.slice("--set-env-vars=".length).split(",").map((pair) => {
    const split = pair.indexOf("=");
    return [pair.slice(0, split), pair.slice(split + 1)];
  }));
}

/** The origin container's plain env values from the rendered service YAML. */
function originContainerEnv(yaml) {
  const origin = yaml.slice(yaml.indexOf("      - name: origin\n"));
  return Object.fromEntries([...origin.matchAll(/ {8}- name: ([A-Z0-9_]+)\n {10}value: ("(?:[^"\\]|\\.)*")/gu)]
    .map(([, key, value]) => [key, JSON.parse(value)]));
}

test("the deploy script and the composition roots agree on the clock, database, schemas and Cloud Run target", async () => {
  for (const key of ["project", "instanceConnectionName", "database", "primarySchema"]) {
    assert.equal(FASTPATH_TEST[key], FASTPATH_TEST_CLOUD_TARGET[key], key);
  }
  assert.equal(FASTPATH_TEST.refreshJob, FASTPATH_TEST_CLOUD_TARGET.refreshJob);
  assert.equal(FASTPATH_TEST.originService, FASTPATH_TEST_CLOUD_TARGET.originService);
  assert.equal(FASTPATH_TEST.runtimeIamUser, FASTPATH_TEST_CLOUD_TARGET.iamUser);

  const now = "2026-10-01T12:00:00.000Z";
  const seeded = "typed_legacy_transfer_rehearsal_target_fastpath_0a1b2c3d";
  // Origin: the clock the deploy sets is the one the composition root reads.
  assert.equal(ORIGIN_TEST_CLOCK_ENV, "ANALYTICS_V2_TEST_NOW_MS");
  const yaml = renderOriginService({ image: IMAGE, bucketHistoryProof: PROOF, schema: seeded, sourceIdentity: SOURCE,
    originEnv: originClockEnv([], now) });
  const env = { ...originContainerEnv(yaml), K_SERVICE: FASTPATH_TEST.originService };
  assert.equal(env.POSTGRES_TEST_HTTP_MODE, "fastpath-test");
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(analyticsV2TestClock(env, env.POSTGRES_TEST_HTTP_MODE)(), Date.parse(now));
  assert.equal("ANALYTICS_V2_TEST_NOW" in env || "ANALYTICS_V2_TEST_CLOCK" in env, false);
  const database = fastpathTestDatabaseConfig(env);
  assert.deepEqual(Object.keys(database), ["primary"]);
  assert.deepEqual([database.primary.database, database.primary.schema], ["tibotattle_fastpath", seeded]);
  // OD-2: the origin takes the quarantine bucket's proof under its own name.
  assert.equal(env.GCS_QUARANTINE_BUCKET_HISTORY_PROOF, PROOF);
  assert.equal(Object.hasOwn(env, "GCS_ERASURE_BUCKET_HISTORY_PROOF"), false);
  assert.equal(originClockEnv([[ORIGIN_TEST_CLOCK_ENV, "1"]], now).length, 1, "an explicit value wins");
  expectCode(() => originClockEnv([], "yesterday"), "FASTPATH_DEPLOY_NOW_INVALID");

  // Refresh: the Job's args and env parse, take the test clock and reach only tibotattle_fastpath.
  const command = refreshJobCommand({ image: IMAGE, now: "2026-10-01T12:00:00Z", schema: seeded });
  // node's own flags (the heap and the semi-space) come before the script; the job parses what follows it.
  const nodeArgs = command.find((arg) => arg.startsWith("--args=")).slice("--args=".length).split(",");
  assert.deepEqual(nodeArgs.slice(0, 3), ["--max-old-space-size=6144", "--max-semi-space-size=64",
    "dist/analytics-refresh.mjs"]);
  const args = nodeArgs.slice(3);
  const jobEnv = { ...commandEnv(command), CLOUD_RUN_JOB: FASTPATH_TEST.refreshJob };
  const parsed = parseAnalyticsRefreshArguments(args, jobEnv);
  assert.equal(parsed.schema, seeded);
  assert.equal(parsed.nowMs, Date.parse(now));
  assert.deepEqual({ ...await resolveAnalyticsRefreshDatabase(jobEnv, { schema: parsed.schema }) }, {
    kind: "cloud-sql", instanceConnectionName: FASTPATH_TEST.instanceConnectionName,
    database: "tibotattle_fastpath", iamUser: FASTPATH_TEST.runtimeIamUser,
  });
});

const SEEDED = "typed_legacy_transfer_rehearsal_target_fastpath_cd40451d";
const EDGE_TEST_ENV = Object.freeze([["EDGE_ORIGIN_MODE", "edge-test"], ["EDGE_ORIGIN_AUDIENCE", FASTPATH_TEST.originUrl],
  ["EDGE_INVOKER_SERVICE_ACCOUNT", FASTPATH_TEST.journeyServiceAccount]]);

// The live write tier's 503 at GET /api/v1/device/sync-capabilities-v1.2
// (2026-10-01, revision 00008): the origin over a seeded schema ran with the
// composition's default source (canonical-v1-primary / telemetry-v1), while
// the schema pins the golden's, so every typed route answered 503
// BACKEND_STORAGE_UNAVAILABLE without logging.
test("an origin over a seeded schema is configured with the source the golden pins, or does not render", async () => {
  expectCode(() => renderOriginService({ image: IMAGE, bucketHistoryProof: PROOF, schema: SEEDED }),
    "FASTPATH_DEPLOY_SOURCE_IDENTITY_REQUIRED");
  expectCode(() => renderOriginService({ image: IMAGE, bucketHistoryProof: PROOF, schema: SEEDED, originEnv: EDGE_TEST_ENV }),
    "FASTPATH_DEPLOY_SOURCE_IDENTITY_REQUIRED");
  const golden = await readSeedGolden();
  // The Q-1 golden's USAGE_MONITOR_DB pins one source for storage and both typed formats.
  const dump = JSON.parse(await readFile(golden.dumpPath, "utf8"));
  const cell = (table, column) => {
    const entry = dump.tables.find(({ name }) => name === table);
    return entry.rows[0][entry.columns.indexOf(column)];
  };
  assert.deepEqual({ ...golden.sourceIdentity }, {
    sourceId: cell("storage_source_state", "source_id"),
    sourceNamespace: cell("typed_v1_admission_state", "source_namespace"),
  });
  assert.equal(cell("typed_v11_admission_state", "source_namespace"), golden.sourceIdentity.sourceNamespace);
  for (const variant of ["sidecar", "direct"]) {
    const env = originContainerEnv(renderOriginService({ image: IMAGE, variant, bucketHistoryProof: PROOF, schema: SEEDED,
      sourceIdentity: golden.sourceIdentity, originEnv: variant === "direct" ? EDGE_TEST_ENV : [] }));
    assert.equal(env.POSTGRES_SOURCE_ID, golden.sourceIdentity.sourceId, variant);
    assert.equal(env.POSTGRES_SOURCE_NAMESPACE, golden.sourceIdentity.sourceNamespace, variant);
  }
  // An explicit pair satisfies (and overrides) it; the pinned migrate-Job schema keeps the default source.
  const explicit = originContainerEnv(renderOriginService({ image: IMAGE, bucketHistoryProof: PROOF, schema: SEEDED,
    originEnv: originSourceEnv(SOURCE) }));
  assert.deepEqual([explicit.POSTGRES_SOURCE_ID, explicit.POSTGRES_SOURCE_NAMESPACE], [SOURCE.sourceId, SOURCE.sourceNamespace]);
  const pinned = originContainerEnv(renderOriginService({ image: IMAGE, bucketHistoryProof: PROOF }));
  assert.equal("POSTGRES_SOURCE_ID" in pinned || "POSTGRES_SOURCE_NAMESPACE" in pinned, false);
  for (const bad of [{}, { sourceId: "a,b", sourceNamespace: "n" }, { sourceId: "s", sourceNamespace: "" },
    { sourceId: "s", sourceNamespace: "n\nx" }, { sourceId: "s".repeat(201), sourceNamespace: "n" }]) {
    expectCode(() => renderOriginService({ image: IMAGE, bucketHistoryProof: PROOF, schema: SEEDED, sourceIdentity: bad }),
      "FASTPATH_DEPLOY_SOURCE_IDENTITY_INVALID");
  }
});

/** The names cloud-run/server.mjs's fastpath-test originAdmissionEnv reads from the environment. */
async function originAdmissionEnvNames() {
  const source = await readFile(resolve(WORKER_ROOT, "cloud-run/server.mjs"), "utf8");
  const start = source.indexOf("const originAdmissionEnv = {");
  assert.ok(start > 0, "server.mjs composes originAdmissionEnv");
  const block = source.slice(start, source.indexOf("};", start));
  return [...block.matchAll(/optional\("([A-Z0-9_]+)"/gu)].map(([, name]) => name).sort();
}

test("an edge-test origin runs the participant routes at wrangler.jsonc env.production's settings", async () => {
  const production = parseJsonc(await readFile(resolve(WORKER_ROOT, "wrangler.jsonc"), "utf8")).env.production.vars;
  const expected = Object.fromEntries(EDGE_TEST_PRODUCTION_SETTINGS.map((name) => [name, production[name]]));
  assert.deepEqual(expected, { ENROLLMENT_MODE: "open", ACCOUNTLESS_ENROLLMENT_MODE: "enabled",
    ACCOUNTLESS_OWNERSHIP_MODE: "enabled", SIGN_IN_START_MAX_PER_MINUTE: production.SIGN_IN_START_MAX_PER_MINUTE,
    PUBLIC_ANALYTICS_MODE: "enabled", UPLOAD_INGRESS_MAX_CONCURRENT: "64", UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE: "1200",
    UPLOAD_INGRESS_BURST: "1200", UPLOAD_INGRESS_LEASE_SECONDS: "90", UPLOAD_INGRESS_BODY_TOTAL_SECONDS: "60",
    UPLOAD_INGRESS_BODY_IDLE_SECONDS: "15" });
  assert.deepEqual(Object.fromEntries(edgeTestProductionEnv()), expected);
  // Every setting the origin's admission env reads is mirrored or deliberately not.
  assert.deepEqual(await originAdmissionEnvNames(),
    [...EDGE_TEST_PRODUCTION_SETTINGS, ...Object.keys(EDGE_TEST_UNMIRRORED_SETTINGS)].sort());
  for (const variant of ["direct", "sidecar"]) {
    const edgeTest = originContainerEnv(renderOriginService({ image: IMAGE, variant, bucketHistoryProof: PROOF,
      schema: SEEDED, sourceIdentity: SOURCE, originEnv: EDGE_TEST_ENV }));
    for (const [name, value] of Object.entries(expected)) assert.equal(edgeTest[name], value, `${variant} ${name}`);
    assert.equal(edgeTest.ENVIRONMENT, "synthetic-development");
  }
  // Without edge-test the composition's closed defaults stay; an explicit value always wins.
  const plain = originContainerEnv(renderOriginService({ image: IMAGE, bucketHistoryProof: PROOF }));
  for (const name of EDGE_TEST_PRODUCTION_SETTINGS) assert.equal(name in plain, false, name);
  const overridden = originContainerEnv(renderOriginService({ image: IMAGE, bucketHistoryProof: PROOF,
    originEnv: [...EDGE_TEST_ENV, ["ENROLLMENT_MODE", "disabled"]] }));
  assert.equal(overridden.ENROLLMENT_MODE, "disabled");
  assert.equal(overridden.ACCOUNTLESS_ENROLLMENT_MODE, "enabled");
  expectCode(() => edgeTestProductionEnv('{"env":{"production":{"vars":{"ENROLLMENT_MODE":"open"}}}}'),
    "FASTPATH_DEPLOY_PRODUCTION_CONFIG_INVALID");
  expectCode(() => edgeTestProductionEnv("{"), "FASTPATH_DEPLOY_PRODUCTION_CONFIG_INVALID");
});

// The live edge write tier (2026-10-01): the runtime service account held the
// cleanup-storage role only on the A2 bucket, so POST /api/v1/contributions
// answered 503 BACKEND_STORAGE_UNAVAILABLE until this binding was added by hand.
const LIVE_BUCKET_CONDITION_EXPRESSION = '(resource.type == "storage.googleapis.com/Bucket" && resource.name == '
  + '"projects/_/buckets/tibotattle-fastpath-test-20261001") || (resource.type == "storage.googleapis.com/Object" '
  + '&& resource.name.startsWith("projects/_/buckets/tibotattle-fastpath-test-20261001/objects/telemetry/"))';
const RUNTIME_MEMBER = "serviceAccount:tibotattle-test-runtime@tibotattle.iam.gserviceaccount.com";
const CLEANUP_ROLE = "projects/tibotattle/roles/tibotattleTestCleanupStorage";
// A new uniform-access bucket's project convenience bindings, which the guard leaves alone.
const CONVENIENCE_BINDINGS = Object.freeze([
  Object.freeze({ role: "roles/storage.legacyBucketOwner", members: ["projectEditor:tibotattle", "projectOwner:tibotattle"] }),
  Object.freeze({ role: "roles/storage.legacyBucketReader", members: ["projectViewer:tibotattle"] }),
]);
const EXPECTED_BINDING = Object.freeze({ role: CLEANUP_ROLE, members: [RUNTIME_MEMBER],
  condition: { title: "TiboTattleFastpathTelemetry", expression: LIVE_BUCKET_CONDITION_EXPRESSION } });

/** --name=value of one argv, or undefined. */
function flagValue(command, name) {
  const arg = command.find((value) => value.startsWith(`--${name}=`));
  return arg?.slice(name.length + 3);
}

/** A runner over one scripted bucket policy; add-iam-policy-binding parses --condition as gcloud's ArgDict does. */
function bucketRunner(initial, { dropAdd = false } = {}) {
  const policy = structuredClone(initial);
  const commands = [];
  return {
    dryRun: false,
    commands,
    policy,
    json(command) {
      commands.push(command);
      assert.deepEqual(command.slice(0, 4), ["gcloud", "storage", "buckets", "get-iam-policy"]);
      return structuredClone(policy);
    },
    exec(command) {
      commands.push(command);
      assert.deepEqual(command.slice(0, 4), ["gcloud", "storage", "buckets", "add-iam-policy-binding"]);
      // ArgDict: split on ',', then each key=value on its first '='.
      const condition = Object.fromEntries(flagValue(command, "condition").split(",").map((pair) => {
        const split = pair.indexOf("=");
        return [pair.slice(0, split), pair.slice(split + 1)];
      }));
      if (!dropAdd) {
        policy.bindings.push({ role: flagValue(command, "role"), members: [flagValue(command, "member")], condition });
      }
      return { status: 0, stdout: "{}", stderr: "" };
    },
  };
}

test("the origin bucket binding renders exactly the live grant, in the test project, as one gcloud call", () => {
  assert.deepEqual({ ...ORIGIN_BUCKET_RUNTIME_BINDING, condition: { ...ORIGIN_BUCKET_RUNTIME_BINDING.condition } }, {
    role: CLEANUP_ROLE, member: RUNTIME_MEMBER,
    condition: { title: "TiboTattleFastpathTelemetry", expression: LIVE_BUCKET_CONDITION_EXPRESSION },
  });
  assert.deepEqual(originBucketBindingCommand(), [
    "gcloud", "storage", "buckets", "add-iam-policy-binding", "gs://tibotattle-fastpath-test-20261001",
    "--project=tibotattle", `--member=${RUNTIME_MEMBER}`, `--role=${CLEANUP_ROLE}`,
    `--condition=expression=${LIVE_BUCKET_CONDITION_EXPRESSION},title=TiboTattleFastpathTelemetry`, "--format=json",
  ]);
  assert.equal(LIVE_BUCKET_CONDITION_EXPRESSION.includes(","), false, "the expression survives gcloud's ',' split");
  assert.deepEqual(originBucketPolicyCommand(), ["gcloud", "storage", "buckets", "get-iam-policy",
    "gs://tibotattle-fastpath-test-20261001", "--project=tibotattle", "--format=json"]);
});

test("ensuring the bucket binding adds it once, reads it back, and is idempotent", () => {
  const runner = bucketRunner({ version: 1, bindings: [...CONVENIENCE_BINDINGS] });
  assert.deepEqual({ ...ensureOriginBucketRuntimeBinding(runner) }, { role: CLEANUP_ROLE, member: RUNTIME_MEMBER,
    conditionTitle: "TiboTattleFastpathTelemetry", added: true });
  assert.deepEqual(runner.commands.map((command) => command[3]),
    ["get-iam-policy", "add-iam-policy-binding", "get-iam-policy"]);
  assert.deepEqual(runner.policy.bindings.at(-1), EXPECTED_BINDING, "the rendered call yields exactly the live binding");
  const again = bucketRunner(runner.policy);
  assert.equal(ensureOriginBucketRuntimeBinding(again).added, false);
  assert.deepEqual(again.commands.map((command) => command[3]), ["get-iam-policy", "get-iam-policy"],
    "a present binding is read twice and never written");
  // An add that does not land is refused at the read-back.
  assert.throws(() => ensureOriginBucketRuntimeBinding(bucketRunner({ bindings: [] }, { dropAdd: true })),
    (error) => error?.code === "FASTPATH_DEPLOY_ORIGIN_BUCKET_BINDING_MISSING");
});

test("any other runtime binding or a public member on the bucket is refused before a write", () => {
  const variants = {
    "the role without a condition": { role: CLEANUP_ROLE, members: [RUNTIME_MEMBER] },
    "another expression": { ...EXPECTED_BINDING,
      condition: { title: "TiboTattleFastpathTelemetry", expression: 'resource.name.startsWith("projects/_/buckets/")' } },
    "another title": { ...EXPECTED_BINDING, condition: { ...EXPECTED_BINDING.condition, title: "Other" } },
    "another role": { ...EXPECTED_BINDING, role: "roles/storage.objectAdmin" },
    "an extra member in the binding": { ...EXPECTED_BINDING, members: [RUNTIME_MEMBER, "serviceAccount:other@tibotattle.iam.gserviceaccount.com"] },
  };
  for (const [label, binding] of Object.entries(variants)) {
    const runner = bucketRunner({ bindings: [...CONVENIENCE_BINDINGS, binding] });
    assert.throws(() => ensureOriginBucketRuntimeBinding(runner),
      (error) => error?.code === "FASTPATH_DEPLOY_ORIGIN_BUCKET_BINDING_UNEXPECTED", label);
    assert.equal(runner.commands.some((command) => command[3] === "add-iam-policy-binding"), false, label);
  }
  const extra = bucketRunner({ bindings: [EXPECTED_BINDING, { role: "roles/storage.objectViewer", members: [RUNTIME_MEMBER] }] });
  assert.throws(() => ensureOriginBucketRuntimeBinding(extra),
    (error) => error?.code === "FASTPATH_DEPLOY_ORIGIN_BUCKET_BINDING_UNEXPECTED", "a second runtime binding");
  for (const member of ["allUsers", "allAuthenticatedUsers"]) {
    const open = bucketRunner({ bindings: [EXPECTED_BINDING, { role: "roles/storage.objectViewer", members: [member] }] });
    assert.throws(() => ensureOriginBucketRuntimeBinding(open),
      (error) => error?.code === "FASTPATH_DEPLOY_ORIGIN_BUCKET_PUBLIC", member);
  }
  assert.equal(validateOriginBucketPolicy({ bindings: [...CONVENIENCE_BINDINGS] }), false);
  assert.equal(validateOriginBucketPolicy({ bindings: [...CONVENIENCE_BINDINGS, EXPECTED_BINDING] },
    { requirePresent: true }), true);
  assert.throws(() => validateOriginBucketPolicy({}, { requirePresent: true }),
    (error) => error?.code === "FASTPATH_DEPLOY_ORIGIN_BUCKET_BINDING_MISSING");
});

test("a dry-run origin step prints the bucket binding before the origin is deployed and writes nothing remote", async (t) => {
  const edge = await edgeArguments(t);
  const out = await mkdtemp(join(tmpdir(), "fastpath-deploy-dry-"));
  const printed = [];
  const { error: printError, log: printLog } = console;
  console.error = (line) => printed.push(String(line));
  console.log = () => {};
  try {
    const report = await main(["origin", "--dry-run", `--image=${IMAGE}`, `--schema=${FASTPATH_TEST.primarySchema}`,
      `--out=${out}`, ...edge]);
    assert.deepEqual({ ...report.steps[0].bucketBinding }, { role: CLEANUP_ROLE, member: RUNTIME_MEMBER,
      conditionTitle: "TiboTattleFastpathTelemetry", added: false });
    assert.deepEqual({ ...report.steps[0].edgeContract }, { environment: "production", mode: "worker",
      edgeCommit: HEAD_COMMIT, capturedAt: report.steps[0].edgeContract.capturedAt, originCommit: HEAD_COMMIT,
      contractBlob: spawnSync("git", ["-C", WORKER_ROOT, "rev-parse", "HEAD:apps/worker/src/edge-origin-contract.ts"],
        { encoding: "utf8" }).stdout.trim() });
  } finally {
    console.error = printError;
    console.log = printLog;
    await rm(out, { recursive: true, force: true });
  }
  assert.equal(printed.every((line) => line.startsWith("[dry-run] ")), true);
  const index = (fragment) => printed.findIndex((line) => line.includes(fragment));
  const binding = index("gcloud storage buckets add-iam-policy-binding gs://tibotattle-fastpath-test-20261001");
  assert.ok(binding > index("gcloud storage buckets get-iam-policy"), "read before the binding");
  assert.ok(printed.findLastIndex((line) => line.includes("gcloud storage buckets get-iam-policy")) > binding,
    "read back after it");
  assert.ok(binding < index("gcloud run services replace"), "the binding precedes the origin deploy");
  assert.equal(printed[binding].includes(`--role=${CLEANUP_ROLE}`) && printed[binding].includes(RUNTIME_MEMBER)
    && printed[binding].includes(LIVE_BUCKET_CONDITION_EXPRESSION), true);
});

/** main() with the console captured: the dry-run lines it printed, and its report or refusal. */
async function capturedMain(argv) {
  const printed = [];
  const { error: printError, log: printLog } = console;
  console.error = (line) => printed.push(String(line));
  console.log = () => {};
  try {
    return { printed, report: await main(argv) };
  } catch (error) {
    return { printed, error };
  } finally {
    console.error = printError;
    console.log = printLog;
  }
}

// (2026-10-02 merge review): an origin-only run over a seeded schema with
// --corpus=dense and no --dump created the bucket and added the runtime
// binding, then refused; `all` built, created the database and migrated first.
test("a digest-only golden without --dump is refused before any remote command; other steps do not read it", async () => {
  const out = await mkdtemp(join(tmpdir(), "fastpath-deploy-dump-"));
  try {
    for (const argv of [
      ["origin", "--dry-run", `--image=${IMAGE}`, "--corpus=dense", `--schema=${SEEDED}`],
      ["seed", "--dry-run", "--commit=HEAD", "--corpus=dense"],
      ["all", "--dry-run", "--commit=HEAD", `--image=${IMAGE}`, "--corpus=dense"],
      ["all", "--dry-run", "--commit=HEAD", `--image=${IMAGE}`, "--corpus=dense", "--skip=seed", `--schema=${SEEDED}`],
    ]) {
      const { printed, error } = await capturedMain([...argv, `--out=${out}`]);
      assert.equal(error?.code, "GCP_FASTPATH_SEED_DUMP_REQUIRED", argv.join(" "));
      assert.deepEqual(printed, [], `${argv.join(" ")}: no command precedes the refusal`);
    }
    assert.equal(stepsReadGolden(["seed"], {}), true);
    assert.equal(stepsReadGolden(["origin"], { schema: SEEDED }), true);
    assert.equal(stepsReadGolden(["origin"], {}), false, "the pinned primary schema keeps the default source");
    assert.equal(stepsReadGolden(["build", "migrate", "refresh", "verify"], { schema: SEEDED }), false);
    const refresh = await capturedMain(["refresh", "--dry-run", `--image=${IMAGE}`, "--corpus=dense", `--out=${out}`]);
    assert.equal(refresh.error, undefined);
    assert.equal(refresh.report.steps[0].profile, "dense");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("an origin-only run over a seeded schema renders the source of the --dump a digest-only golden pins", async (t) => {
  const edge = await edgeArguments(t);
  await withDigestOnlyGolden(async ({ golden, dump }) => {
    const out = await mkdtemp(join(tmpdir(), "fastpath-deploy-dump-"));
    try {
      const argv = ["origin", "--dry-run", `--image=${IMAGE}`, `--golden=${golden}`, `--schema=${SEEDED}`,
        `--out=${out}`];
      const refused = await capturedMain(argv);
      assert.equal(refused.error?.code, "GCP_FASTPATH_SEED_DUMP_REQUIRED");
      assert.deepEqual(refused.printed, []);
      const { report, error } = await capturedMain([...argv, `--dump=${dump}`, ...edge]);
      assert.equal(error, undefined);
      const [origin] = report.steps;
      assert.deepEqual({ ...origin.sourceIdentity }, { ...DIGEST_ONLY_GOLDEN_SOURCE });
      const env = originContainerEnv(await readFile(origin.yamlPath, "utf8"));
      assert.deepEqual([env.POSTGRES_SOURCE_ID, env.POSTGRES_SOURCE_NAMESPACE],
        [DIGEST_ONLY_GOLDEN_SOURCE.sourceId, DIGEST_ONLY_GOLDEN_SOURCE.sourceNamespace]);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});

test("D-BLOB: the origin step refuses before any remote command without a fresh, verified, matching edge capture",
  async (t) => {
    const out = await mkdtemp(join(tmpdir(), "fastpath-deploy-blob-"));
    t.after(() => rm(out, { recursive: true, force: true }));
    const base = ["origin", "--dry-run", `--image=${IMAGE}`, `--schema=${FASTPATH_TEST.primarySchema}`, `--out=${out}`];
    const edge = await edgeArguments(t);
    const refusals = [
      [base, "FASTPATH_DEPLOY_EDGE_LIVE_REQUIRED"],
      [[...base, edge[1], edge[2]], "FASTPATH_DEPLOY_ORIGIN_COMMIT_REQUIRED"],
      [[...base, edge[0], edge[1]], "FASTPATH_DEPLOY_EDGE_LIVE_REQUIRED"],
      [[...base, ...edge.slice(0, 2), "--edge-environment=staging"], "ROLLOUT_EDGE_LIVE_TARGET_MISMATCH"],
      [[...base, ...await edgeArguments(t, { capturedAt: new Date(Date.now() - EDGE_CAPTURE_MAX_AGE_MS - 60_000)
        .toISOString() })], "ROLLOUT_EDGE_LIVE_STALE"],
      [[...base, edge[0], `--edge-live=${join(out, "absent.json")}`, edge[2]], "ROLLOUT_EDGE_LIVE_REQUIRED"],
      [["all", "--dry-run", `--image=${IMAGE}`, `--schema=${FASTPATH_TEST.primarySchema}`, `--out=${out}`, "--commit=HEAD"],
        "FASTPATH_DEPLOY_EDGE_LIVE_REQUIRED"],
    ];
    for (const [argv, code] of refusals) {
      const { printed, error } = await capturedMain(argv);
      assert.equal(error?.code, code, argv.join(" "));
      assert.deepEqual(printed, [], `${code}: no command precedes the refusal`);
    }
    for (const argument of ["--edge-live=relative.json", "--edge-environment=test"]) {
      const { error } = await capturedMain([...base, argument]);
      assert.equal(error?.code, "FASTPATH_DEPLOY_ARGUMENT_INVALID", argument);
    }
    // The blob comparison itself, against a synthetic edge commit: another
    // blob there, or none (a pre-edge Worker), refuses; the same blob passes.
    const record = await checkOriginEdgeContract({ edgeLive: edge[1].slice("--edge-live=".length),
      edgeEnvironment: "production", commit: "HEAD" });
    assert.equal(record.originCommit, HEAD_COMMIT);
    const EDGE_COMMIT = "3".repeat(40);
    const synthetic = await edgeArguments(t, { edgeCommit: EDGE_COMMIT });
    const options = { edgeLive: synthetic[1].slice("--edge-live=".length), edgeEnvironment: "production", commit: "HEAD" };
    for (const edgeBlob of ["b".repeat(40), null]) {
      await assert.rejects(checkOriginEdgeContract(options, {
        readBlob: (commit) => (commit === HEAD_COMMIT ? record.contractBlob : edgeBlob),
      }), (error) => error?.code === "EDGE_CONTRACT_DRIFT", String(edgeBlob));
    }
    assert.equal((await checkOriginEdgeContract(options, {
      readBlob: (commit) => (commit === HEAD_COMMIT || commit === EDGE_COMMIT ? record.contractBlob : null),
    })).edgeCommit, EDGE_COMMIT);
    const { error } = await capturedMain([...base, ...synthetic]);
    assert.equal(error?.code, "EDGE_CONTRACT_DRIFT", "an edge commit this checkout lacks never matches");
  });
// MEAS-SYNTH review (2026-10-03): the production-scale measurement's uncapped
// execution ran a raw `gcloud run jobs execute` whatever the guarded deploy
// did, kept no receipt when the execution failed, and could not tell a
// LOCK_HELD no-op from a refresh. It is now this step.
const REFRESH_JOB = FASTPATH_TEST.refreshJob;
const MEAS_NOW = "2026-10-01T12:46:00.000Z";
const GUARD_ENV = Object.freeze([[REFRESH_TASK_TIMEOUT_ENV, "14400"]]);
const UNCAPPED = 172_800;
const NO_WAIT = Object.freeze({ sleep: async () => {}, wallClock: () => Date.parse("2026-10-04T00:00:00.000Z") });
const FAILED = Symbol("gcloud failed");

function denseTask(overrides = {}) {
  return { ...expectedRefreshTask({ image: IMAGE, now: MEAS_NOW, schema: SEEDED, extraEnv: GUARD_ENV,
    profile: "dense" }), ...overrides };
}

/** A Job or an execution as `run jobs describe` / `run jobs executions describe --format=json` render it (v1). */
function taskResource(kind, task, extra = {}) {
  const taskSpec = { containers: [{ image: task.image, command: task.command, args: task.args,
    env: Object.entries(task.env).map(([name, value]) => ({ name, value })),
    resources: { limits: { cpu: task.cpu, memory: task.memory } } }],
  maxRetries: 0, timeoutSeconds: String(task.timeoutSeconds), serviceAccountName: FASTPATH_TEST.runtimeServiceAccount };
  const spec = kind === "Job" ? { template: { spec: { parallelism: 1, taskCount: 1, template: { spec: taskSpec } } } }
    : { parallelism: 1, taskCount: 1, template: { spec: taskSpec } };
  return { apiVersion: "run.googleapis.com/v1", kind, ...extra, spec };
}

function uncappedExecution(name, { created, start, end, succeeded = true, running = false }) {
  const task = denseTask({ env: { ...denseTask().env, [REFRESH_TASK_TIMEOUT_ENV]: String(UNCAPPED) },
    timeoutSeconds: UNCAPPED });
  return taskResource("Execution", task, {
    metadata: { name, creationTimestamp: created },
    status: { startTime: start, ...(running ? {} : { completionTime: end }),
      succeededCount: running || !succeeded ? 0 : 1, failedCount: running || succeeded ? 0 : 1,
      conditions: [{ type: "Completed", status: running ? "Unknown" : succeeded ? "True" : "False" }] },
  });
}

const kindOf = (command) => (command[1] === "logging" ? "logging read"
  : command.slice(1, command[3] === "executions" ? 5 : 4).join(" "));

/** A Runner stand-in: answers every gcloud call from `answer(command, nthOfItsKind)`; spawns nothing. */
function scriptedRunner(answer, { dryRun = false } = {}) {
  return {
    dryRun, commands: [], receipts: {},
    print(command) { this.commands.push(command); },
    exec(command) { this.commands.push(command); return { status: 0, stdout: "", stderr: "", dry: dryRun }; },
    json(command, options = {}) {
      this.commands.push(command);
      const value = answer(command, this.commands.filter((seen) => kindOf(seen) === kindOf(command)).length);
      if (value === FAILED) {
        if (options.allowFailure) return null;
        throw Object.assign(new Error("FASTPATH_DEPLOY_COMMAND_FAILED"), { code: "FASTPATH_DEPLOY_COMMAND_FAILED" });
      }
      return value === undefined ? (options.placeholderJson ?? null) : structuredClone(value);
    },
    async receipt(name, value) { this.receipts[name] = structuredClone(value); return `/receipts/${name}`; },
  };
}

/** The guarded refresh's refresh.json (a DEADLINE_PROJECTED refusal by default) and refresh-uncapped's options. */
async function uncappedOptions(dir, guarded = {}) {
  const afterRefresh = join(dir, "refresh.json");
  await writeFile(afterRefresh, JSON.stringify({ step: "refresh", image: IMAGE, schema: SEEDED, now: MEAS_NOW,
    profile: "dense", job: REFRESH_JOB, execution: `${REFRESH_JOB}-g7h2k`, succeeded: false, durationSeconds: 6_900,
    results: [{ status: "failed", code: "ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED", phase: "compute" }], ...guarded }));
  return { refreshProfile: "dense", schema: SEEDED, now: MEAS_NOW, refreshEnv: [...GUARD_ENV], refreshArgs: [],
    taskTimeoutSeconds: UNCAPPED, afterRefresh };
}

/** The idle listing and the Job read-back, then `rest` for everything after them. */
function readyRunner(rest, { job = taskResource("Job", denseTask()) } = {}) {
  return scriptedRunner((command, nth) => {
    const kind = kindOf(command);
    if (kind === "run jobs executions list" && nth === 1) return [];
    if (kind === "run jobs describe") return job;
    return rest(kind, nth, command);
  });
}

test("execution overrides and the refresh reads target only the fast-path refresh Job in tibotattle", () => {
  assert.deepEqual(executeJobCommand(REFRESH_JOB), ["gcloud", "run", "jobs", "execute", REFRESH_JOB,
    "--project=tibotattle", "--region=us-east1", "--wait", "--format=json"], "no overrides: unchanged");
  const uncapped = executeJobCommand(REFRESH_JOB, { taskTimeoutSeconds: UNCAPPED,
    env: [[REFRESH_TASK_TIMEOUT_ENV, String(UNCAPPED)]] });
  assert.deepEqual(uncapped, ["gcloud", "run", "jobs", "execute", REFRESH_JOB, "--project=tibotattle",
    "--region=us-east1", `--task-timeout=${UNCAPPED}s`, `--update-env-vars=${REFRESH_TASK_TIMEOUT_ENV}=${UNCAPPED}`,
    "--wait", "--format=json"]);
  for (const taskTimeoutSeconds of [0, 59, 1.5, REFRESH_TASK_TIMEOUT_MAXIMUM_SECONDS + 1, "86400"]) {
    expectCode(() => executeJobCommand(REFRESH_JOB, { taskTimeoutSeconds }), "FASTPATH_DEPLOY_TASK_TIMEOUT_INVALID");
  }
  expectCode(() => executeJobCommand(REFRESH_JOB, { env: [["bad-key", "1"]] }), "FASTPATH_DEPLOY_ENV_INVALID");
  const execution = `${REFRESH_JOB}-ab12c`;
  const reads = [jobExecutionsCommand(REFRESH_JOB), jobExecutionsCommand(REFRESH_JOB, { limit: 1 }),
    jobDescribeCommand(REFRESH_JOB), executionDescribeCommand(REFRESH_JOB, execution),
    executionLogsCommand(REFRESH_JOB, execution), executionLogsCommand(REFRESH_JOB, execution,
      { since: "2026-10-04T00:00:00.000Z" })];
  for (const command of [uncapped, ...reads]) {
    assert.equal(command[0], "gcloud");
    assert.equal(command.includes("--project=tibotattle"), true);
    assert.equal(command.some((arg) => arg.includes(REFRESH_JOB)), true);
    for (const name of FASTPATH_TEST.protectedServices) assert.equal(command.some((arg) => arg.includes(name)), false);
  }
  assert.deepEqual(reads[1].slice(0, 6), ["gcloud", "run", "jobs", "executions", "list", `--job=${REFRESH_JOB}`]);
  assert.equal(reads[1].includes("--limit=1"), true);
  // Without a bound the log read looks back two hours; with one it covers a run of any length.
  assert.equal(reads[4].includes("--freshness=2h"), true);
  assert.equal(reads[5].includes("--freshness=2h"), false);
  assert.match(reads[5][3], /AND timestamp>="2026-10-04T00:00:00\.000Z"$/u);
  for (const job of ["tibotattle-test-app", "tibotattle-test-database-migrate"]) {
    for (const build of [() => jobExecutionsCommand(job), () => jobDescribeCommand(job),
      () => executeJobCommand(job, { taskTimeoutSeconds: UNCAPPED })]) {
      expectCode(build, "FASTPATH_DEPLOY_TARGET_NOT_FASTPATH");
    }
  }
  for (const other of ["tibotattle-test-app-ab12c", `${FASTPATH_TEST.migrateJob}-ab12c`, `${REFRESH_JOB}-AB`, ""]) {
    expectCode(() => executionDescribeCommand(REFRESH_JOB, other), "FASTPATH_DEPLOY_EXECUTION_INVALID");
    expectCode(() => executionLogsCommand(REFRESH_JOB, other), "FASTPATH_DEPLOY_EXECUTION_INVALID");
  }
  expectCode(() => executionLogsCommand(REFRESH_JOB, execution, { since: "yesterday" }),
    "FASTPATH_DEPLOY_ARGUMENT_INVALID");
});

test("running executions, task read-backs and uncapped outcomes are classified from the rendered resources", () => {
  const at = { created: "2026-10-04T00:00:05Z", start: "2026-10-04T00:00:20Z", end: "2026-10-04T10:00:20Z" };
  const running = uncappedExecution(`${REFRESH_JOB}-r1abc`, { ...at, running: true });
  const done = uncappedExecution(`${REFRESH_JOB}-d1abc`, at);
  const failed = uncappedExecution(`${REFRESH_JOB}-f1abc`, { ...at, succeeded: false });
  assert.equal(executionCompleted(running), false);
  assert.equal(executionCompleted(done), true);
  assert.equal(executionCompleted(failed), true);
  assert.equal(executionCompleted({ status: { completionTime: at.end } }), true, "no conditions: the completion time");
  assert.equal(executionCompleted({ status: {} }), false);
  assert.deepEqual(runningExecutions([done, running, failed, { metadata: { name: "x" }, status: {} }]),
    [`${REFRESH_JOB}-r1abc`, "x"]);
  assert.throws(() => runningExecutions(null), (error) => error?.code === "FASTPATH_DEPLOY_JSON_INVALID");
  assert.throws(() => assertRefreshIdle(scriptedRunner(() => [running])),
    (error) => error?.code === "FASTPATH_DEPLOY_REFRESH_EXECUTION_RUNNING" && error.message.endsWith(`${REFRESH_JOB}-r1abc`));
  assert.equal(assertRefreshIdle(scriptedRunner(() => [done, failed])).running, 0);

  // The read-back equals what refreshJobCommand deploys, in both shapes.
  const expected = denseTask();
  assert.deepEqual(expected.args, ["--max-old-space-size=12288", "dist/analytics-refresh.mjs", "--mode=full",
    `--schema=${SEEDED}`, `--now=${MEAS_NOW}`]);
  assert.equal(expected.env[REFRESH_TASK_TIMEOUT_ENV], "14400");
  assert.equal(expected.env.PRIMARY_SCHEMA, SEEDED);
  assert.deepEqual([expected.cpu, expected.memory, expected.timeoutSeconds], ["4", "16Gi", 14_400]);
  const job = taskResource("Job", expected);
  assert.deepEqual(jobTaskSpec(job), expected);
  assert.deepEqual(refreshTaskMismatches(jobTaskSpec(job), expected), []);
  const { kind: _kind, ...unlabelled } = job;
  assert.deepEqual(jobTaskSpec(unlabelled), expected, "an unlabelled Job is read by its shape");
  assert.deepEqual(jobTaskSpec(taskResource("Execution", expected)), expected);
  assert.deepEqual(refreshTaskMismatches(jobTaskSpec(taskResource("Job", { ...expected, cpu: "4000m" })), expected), []);
  assert.deepEqual(refreshTaskMismatches(jobTaskSpec(taskResource("Job", { ...expected,
    env: { ...expected.env, EXTRA: "1" }, timeoutSeconds: 7_200 })), expected), ["env", "timeoutSeconds"]);
  assert.equal(jobTaskSpec({ kind: "Job", spec: { template: { spec: { template: { spec: { containers: [] } } } } } }), null);
  assert.deepEqual(refreshTaskMismatches(null, expected), ["task"]);

  const outcome = (input) => uncappedOutcome({ completed: true, succeeded: false, statusLine: null,
    durationSeconds: 1_000, taskTimeoutSeconds: UNCAPPED, ...input });
  assert.deepEqual(outcome({ completed: false }), { outcome: "unfinished", code: null });
  assert.deepEqual(outcome({ succeeded: true, statusLine: { status: "ok", state: "complete" } }),
    { outcome: "complete", code: null });
  assert.deepEqual(outcome({ succeeded: true, statusLine: { status: "ok", state: "LOCK_HELD" } }),
    { outcome: "lock-held", code: null });
  assert.deepEqual(outcome({ statusLine: { status: "failed", code: "ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED" } }),
    { outcome: "failed", code: "ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED" });
  assert.deepEqual(outcome({ durationSeconds: UNCAPPED }), { outcome: "killed-at-task-timeout", code: null });
  assert.deepEqual(outcome({}), { outcome: "failed-without-status-line", code: null });
  assert.deepEqual(outcome({ succeeded: true }), { outcome: "succeeded-without-status-line", code: null });
});

test("refresh-uncapped refuses a missing, mismatched or LOCK_HELD guarded refresh before any remote command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fastpath-uncapped-"));
  try {
    const mismatch = "FASTPATH_DEPLOY_UNCAPPED_AFTER_REFRESH_MISMATCH";
    const cases = [
      [{}, { afterRefresh: join(dir, "absent.json") }, "FASTPATH_DEPLOY_UNCAPPED_AFTER_REFRESH_INVALID"],
      [{ image: `${FASTPATH_TEST.imageRepository}@sha256:${"b".repeat(64)}` }, {}, mismatch],
      [{ schema: "typed_legacy_transfer_rehearsal_target_fastpath_00000000" }, {}, mismatch],
      [{ now: null }, {}, mismatch],
      [{ profile: "standard" }, {}, mismatch],
      // The deploy wrapper writes refresh.json only after the deploy; a receipt without an execution is refused.
      [{ execution: null }, {}, mismatch],
      [{ step: "migrate" }, {}, mismatch],
      [{ succeeded: true, results: [{ status: "ok", state: "LOCK_HELD" }] }, {}, "FASTPATH_DEPLOY_REFRESH_LOCK_HELD"],
      [{}, { taskTimeoutSeconds: 14_400 }, "FASTPATH_DEPLOY_TASK_TIMEOUT_INVALID"],
      [{}, { taskTimeoutSeconds: REFRESH_TASK_TIMEOUT_MAXIMUM_SECONDS + 1 }, "FASTPATH_DEPLOY_TASK_TIMEOUT_INVALID"],
      [{}, { taskTimeoutSeconds: undefined }, "FASTPATH_DEPLOY_TASK_TIMEOUT_INVALID"],
      [{}, { schema: undefined }, "FASTPATH_DEPLOY_ARGUMENT_INVALID"],
      [{}, { afterRefresh: undefined }, "FASTPATH_DEPLOY_ARGUMENT_INVALID"],
    ];
    for (const [guarded, overrides, code] of cases) {
      const runner = scriptedRunner((command) => assert.fail(`no remote command: ${kindOf(command)}`));
      const options = { ...await uncappedOptions(dir, guarded), ...overrides };
      await assert.rejects(stepRefreshUncapped(runner, options, IMAGE, NO_WAIT), (error) => error?.code === code,
        JSON.stringify({ guarded, overrides }));
      assert.deepEqual(runner.commands, [], JSON.stringify({ guarded, overrides }));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refresh-uncapped refuses while a refresh runs, or when the Job does not read back as the guarded one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fastpath-uncapped-"));
  try {
    const options = await uncappedOptions(dir);
    const busy = scriptedRunner((command) => (kindOf(command) === "run jobs executions list"
      ? [uncappedExecution(`${REFRESH_JOB}-r1abc`, { created: "2026-10-03T22:00:00Z", start: "2026-10-03T22:00:10Z",
        running: true })] : assert.fail(kindOf(command))));
    await assert.rejects(stepRefreshUncapped(busy, options, IMAGE, NO_WAIT),
      (error) => error?.code === "FASTPATH_DEPLOY_REFRESH_EXECUTION_RUNNING");
    assert.deepEqual(busy.commands.map(kindOf), ["run jobs executions list"]);
    const expected = denseTask();
    const variants = {
      image: { ...expected, image: `${FASTPATH_TEST.imageRepository}@sha256:${"c".repeat(64)}` },
      args: { ...expected, args: expected.args.map((arg) => (arg.startsWith("--schema=")
        ? `--schema=${FASTPATH_TEST.primarySchema}` : arg)) },
      env: { ...expected, env: { ...expected.env, [REFRESH_TASK_TIMEOUT_ENV]: "7200" } },
      memory: { ...expected, memory: "8Gi" },
      timeoutSeconds: { ...expected, timeoutSeconds: 7_200 },
    };
    for (const [field, task] of Object.entries(variants)) {
      const runner = readyRunner((kind) => assert.fail(`${field}: ${kind}`), { job: taskResource("Job", task) });
      await assert.rejects(stepRefreshUncapped(runner, options, IMAGE, NO_WAIT),
        (error) => error?.code === "FASTPATH_DEPLOY_UNCAPPED_JOB_MISMATCH" && error.message.endsWith(`: ${field}`), field);
      assert.deepEqual(runner.commands.map(kindOf), ["run jobs executions list", "run jobs describe"], field);
    }
    const unreadable = readyRunner((kind) => assert.fail(kind), { job: {} });
    await assert.rejects(stepRefreshUncapped(unreadable, options, IMAGE, NO_WAIT),
      (error) => error?.code === "FASTPATH_DEPLOY_UNCAPPED_JOB_MISMATCH" && error.message.endsWith(": task"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refresh-uncapped times one execution to its end and keeps its status, status line and log read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fastpath-uncapped-"));
  try {
    const options = await uncappedOptions(dir);
    const name = `${REFRESH_JOB}-u5xyz`;
    const done = uncappedExecution(name, { created: "2026-10-04T00:00:05.123456Z", start: "2026-10-04T00:00:20Z",
      end: "2026-10-04T15:00:20Z" });
    const line = { schemaVersion: "analytics-refresh-receipt-v1", status: "ok", state: "complete",
      timings: { read: 1 }, timeGuard: { taskTimeoutSeconds: UNCAPPED, plannedSeconds: 10_998 } };
    const runner = readyRunner((kind, nth) => {
      if (kind === "run jobs execute") return done;
      // Ingestion lag: the first read has no status line yet.
      if (kind === "logging read") {
        return nth === 1 ? [] : [{ timestamp: "2026-10-04T15:00:19Z", jsonPayload: line },
          { timestamp: "2026-10-04T00:00:21Z", severity: "INFO", textPayload: "Container started" }];
      }
      return assert.fail(kind);
    });
    const receipt = await stepRefreshUncapped(runner, options, IMAGE, NO_WAIT);
    assert.deepEqual(runner.commands.map(kindOf), ["run jobs executions list", "run jobs describe",
      "run jobs execute", "logging read", "logging read"]);
    const execute = runner.commands[2];
    assert.deepEqual(execute, executeJobCommand(REFRESH_JOB, { taskTimeoutSeconds: UNCAPPED,
      env: [[REFRESH_TASK_TIMEOUT_ENV, String(UNCAPPED)]] }));
    assert.equal(execute.some((arg) => /^--(?:image|args|set-env-vars|cpu|memory)=/u.test(arg)), false,
      "execution-level overrides only");
    assert.match(runner.commands[3][3], /timestamp>="2026-10-03T23:59:05\.123Z"$/u, "since the execution was created");
    assert.equal(runner.commands[3].includes("--freshness=2h"), false);
    assert.equal(receipt.outcome, "complete");
    assert.equal(receipt.execution, name);
    assert.equal(receipt.durationSeconds, 54_000);
    assert.deepEqual(receipt.statusLine, line);
    assert.deepEqual(receipt.systemMessages, [{ timestamp: "2026-10-04T00:00:21Z", severity: "INFO",
      text: "Container started" }]);
    assert.deepEqual(receipt.executionMismatches, []);
    assert.deepEqual([receipt.status.startTime, receipt.status.completionTime, receipt.status.failedCount],
      ["2026-10-04T00:00:20Z", "2026-10-04T15:00:20Z", 0]);
    assert.equal(receipt.afterRefresh.statusLine.code, "ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED");
    assert.deepEqual(runner.receipts["refresh-uncapped.json"].durationSeconds, 54_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refresh-uncapped keeps a receipt for every failed outcome and fails the step", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fastpath-uncapped-"));
  try {
    const options = await uncappedOptions(dir);
    const at = { created: "2026-10-04T00:00:05Z", start: "2026-10-04T00:00:20Z" };

    // `execute --wait` loses the execution: the newest one is taken because it
    // is this one, polled to its end, and its refusal recorded.
    const name = `${REFRESH_JOB}-f2abc`;
    const refusal = { status: "failed", code: "ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED", phase: "compute",
      deadline: { taskTimeoutSeconds: UNCAPPED, elapsedSeconds: 70_000, ownersStarted: 3, ownersPlanned: 53 } };
    const lost = readyRunner((kind, nth) => {
      if (kind === "run jobs execute") return FAILED;
      if (kind === "run jobs executions list") return [uncappedExecution(name, { ...at, running: true })];
      if (kind === "run jobs executions describe") {
        return nth === 1 ? uncappedExecution(name, { ...at, running: true })
          : uncappedExecution(name, { ...at, end: "2026-10-04T20:00:00Z", succeeded: false });
      }
      if (kind === "logging read") return [{ timestamp: "2026-10-04T19:59:59Z", jsonPayload: refusal }];
      return assert.fail(kind);
    });
    await assert.rejects(stepRefreshUncapped(lost, options, IMAGE, NO_WAIT),
      (error) => error?.code === "FASTPATH_DEPLOY_REFRESH_FAILED"
        && error.message.endsWith("failed ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED"));
    assert.deepEqual(lost.commands.map(kindOf), ["run jobs executions list", "run jobs describe", "run jobs execute",
      "run jobs executions list", "run jobs executions describe", "run jobs executions describe", "logging read"]);
    assert.equal(lost.commands[3].includes("--limit=1"), true);
    const lostReceipt = lost.receipts["refresh-uncapped.json"];
    assert.deepEqual([lostReceipt.execution, lostReceipt.completed, lostReceipt.outcome, lostReceipt.code],
      [name, true, "failed", "ANALYTICS_V2_REFRESH_DEADLINE_PROJECTED"]);
    assert.deepEqual([lostReceipt.status.failedCount, lostReceipt.durationSeconds], [1, 71_980]);
    assert.deepEqual(lostReceipt.statusLine.deadline, refusal.deadline);

    // Killed at the task timeout: no status line, Cloud Run's own messages kept.
    const killedName = `${REFRESH_JOB}-k3abc`;
    const killed = readyRunner((kind) => {
      if (kind === "run jobs execute") {
        return uncappedExecution(killedName, { ...at, end: "2026-10-06T00:00:20Z", succeeded: false });
      }
      if (kind === "logging read") {
        return [{ timestamp: "2026-10-06T00:00:19Z", severity: "ERROR", textPayload: "Task timed out." }];
      }
      return assert.fail(kind);
    });
    await assert.rejects(stepRefreshUncapped(killed, options, IMAGE, { ...NO_WAIT, logAttempts: 3 }),
      (error) => error?.code === "FASTPATH_DEPLOY_REFRESH_FAILED" && error.message.endsWith("killed-at-task-timeout"));
    const killedReceipt = killed.receipts["refresh-uncapped.json"];
    assert.equal(killedReceipt.durationSeconds, UNCAPPED);
    assert.deepEqual(killedReceipt.systemMessages.map(({ text }) => text), ["Task timed out."]);
    assert.equal(killed.commands.filter((command) => kindOf(command) === "logging read").length, 3,
      "the log is read until its attempts run out");

    // A LOCK_HELD execution did nothing.
    const held = readyRunner((kind) => {
      if (kind === "run jobs execute") {
        return uncappedExecution(`${REFRESH_JOB}-l4abc`, { ...at, end: "2026-10-04T00:01:00Z" });
      }
      if (kind === "logging read") return [{ timestamp: "2026-10-04T00:00:59Z", jsonPayload: { status: "ok", state: "LOCK_HELD" } }];
      return assert.fail(kind);
    });
    await assert.rejects(stepRefreshUncapped(held, options, IMAGE, NO_WAIT),
      (error) => error?.code === "FASTPATH_DEPLOY_REFRESH_LOCK_HELD");
    assert.equal(held.receipts["refresh-uncapped.json"].outcome, "lock-held");

    // The newest execution predates the request, or runs another task: it is not this one.
    for (const stranger of [
      uncappedExecution(`${REFRESH_JOB}-o5abc`, { created: "2026-10-03T20:00:00Z", start: "2026-10-03T20:00:10Z",
        end: "2026-10-03T21:00:00Z" }),
      taskResource("Execution", { ...denseTask(), image: `${FASTPATH_TEST.imageRepository}@sha256:${"d".repeat(64)}` },
        { metadata: { name: `${REFRESH_JOB}-o6abc`, creationTimestamp: "2026-10-04T00:00:05Z" }, status: {} }),
    ]) {
      const absent = readyRunner((kind) => {
        if (kind === "run jobs execute") return FAILED;
        if (kind === "run jobs executions list") return [stranger];
        return assert.fail(kind);
      });
      await assert.rejects(stepRefreshUncapped(absent, options, IMAGE, NO_WAIT),
        (error) => error?.code === "FASTPATH_DEPLOY_UNCAPPED_EXECUTION_ABSENT");
      assert.equal(absent.receipts["refresh-uncapped.json"].execution, null);
    }

    // A transient read failure while polling is retried; a describe that never answers ends the wait honestly.
    const silentName = `${REFRESH_JOB}-s7abc`;
    const silent = readyRunner((kind) => {
      if (kind === "run jobs execute") return FAILED;
      if (kind === "run jobs executions list") return [uncappedExecution(silentName, { ...at, running: true })];
      if (kind === "run jobs executions describe") return FAILED;
      if (kind === "logging read") return [];
      return assert.fail(kind);
    });
    await assert.rejects(stepRefreshUncapped(silent, options, IMAGE, { ...NO_WAIT, maxPollFailures: 4, logAttempts: 1 }),
      (error) => error?.code === "FASTPATH_DEPLOY_UNCAPPED_EXECUTION_UNFINISHED");
    assert.equal(silent.commands.filter((command) => kindOf(command) === "run jobs executions describe").length, 4);
    assert.deepEqual([silent.receipts["refresh-uncapped.json"].completed,
      silent.receipts["refresh-uncapped.json"].outcome], [false, "unfinished"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readExecutionLog orders status lines oldest first and waits out ingestion lag", async () => {
  const execution = `${REFRESH_JOB}-ab12c`;
  let reads = 0;
  const runner = scriptedRunner(() => {
    reads += 1;
    return reads < 3 ? [] : [{ timestamp: "2026-10-04T02:00:00Z", jsonPayload: { status: "ok", n: 2 } },
      { timestamp: "2026-10-04T01:00:00Z", textPayload: JSON.stringify({ status: "ok", n: 1 }) },
      { timestamp: "2026-10-04T00:30:00Z", textPayload: "x".repeat(600) }];
  });
  const sleeps = [];
  const log = await readExecutionLog(runner, REFRESH_JOB, execution, { attempts: 5, intervalMs: 7,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); } });
  assert.deepEqual(log.lines.map(({ n }) => n), [1, 2]);
  assert.deepEqual(log.systemMessages.map(({ text }) => text.length), [500]);
  assert.deepEqual(sleeps, [7, 7]);
  const empty = await readExecutionLog(scriptedRunner(() => []), REFRESH_JOB, execution,
    { attempts: 2, sleep: async () => {} });
  assert.deepEqual(empty, { lines: [], systemMessages: [], profiles: [] });
});

test("a dry-run refresh-uncapped prints only reads and the one execution, never a deploy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fastpath-uncapped-"));
  try {
    const { afterRefresh } = await uncappedOptions(dir);
    const argv = ["refresh-uncapped", "--dry-run", `--image=${IMAGE}`, `--schema=${SEEDED}`, `--now=${MEAS_NOW}`,
      "--refresh-profile=dense", `--refresh-env=${REFRESH_TASK_TIMEOUT_ENV}=14400`, `--task-timeout-seconds=${UNCAPPED}`,
      `--after-refresh=${afterRefresh}`, `--out=${dir}`];
    const { printed, report, error } = await capturedMain(argv);
    assert.equal(error, undefined);
    assert.equal(report.steps[0].dryRun, true);
    assert.equal(printed.every((line) => line.startsWith("[dry-run] gcloud ")), true);
    const order = ["gcloud run jobs executions list", "gcloud run jobs describe", "gcloud run jobs execute",
      "gcloud run jobs executions describe", "gcloud logging read"];
    assert.deepEqual(printed.map((line) => order.findIndex((prefix) => line.slice(10).startsWith(prefix))),
      [0, 1, 2, 3, 4]);
    assert.equal(printed[2].includes(`--task-timeout=${UNCAPPED}s`)
      && printed[2].includes(`--update-env-vars=${REFRESH_TASK_TIMEOUT_ENV}=${UNCAPPED}`), true);
    assert.equal(printed.some((line) => line.includes("jobs deploy")), false);
    const refused = await capturedMain(argv.map((arg) => (arg.startsWith("--task-timeout-seconds=")
      ? "--task-timeout-seconds=14400" : arg)));
    assert.equal(refused.error?.code, "FASTPATH_DEPLOY_TASK_TIMEOUT_INVALID");
    assert.deepEqual(refused.printed, []);
    for (const value of ["0", "1.5", "-1", "abc"]) {
      const invalid = await capturedMain([...argv.slice(0, -1), `--task-timeout-seconds=${value}`, `--out=${dir}`]);
      assert.equal(invalid.error?.code, "FASTPATH_DEPLOY_TASK_TIMEOUT_INVALID", value);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * main() in a child process whose PATH resolves `gcloud` to a stand-in that
 * answers from `answers` (by command kind) and logs every call. The real
 * gcloud is never reachable: the probe below must reach the stand-in first.
 */
async function withFakeGcloud(answers, run) {
  const dir = await mkdtemp(join(tmpdir(), "fastpath-fake-gcloud-"));
  try {
    const fake = join(dir, "fake-gcloud.mjs");
    await writeFile(fake, `import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--fake-probe") { process.stdout.write("fake-gcloud"); process.exit(0); }
appendFileSync(${JSON.stringify(join(dir, "calls.jsonl"))}, JSON.stringify(args) + "\\n");
const kind = args[0] === "logging" ? "logging read" : args.slice(0, args[2] === "executions" ? 4 : 3).join(" ");
const answer = JSON.parse(readFileSync(${JSON.stringify(join(dir, "answers.json"))}, "utf8"))[kind];
if (answer === undefined) { process.stderr.write("unexpected " + kind); process.exit(3); }
process.stdout.write(answer.stdout ?? ""); process.exit(answer.status ?? 0);
`);
    await writeFile(join(dir, "answers.json"), JSON.stringify(answers));
    await writeFile(join(dir, "gcloud"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`);
    await chmod(join(dir, "gcloud"), 0o755);
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
    const probe = spawnSync("gcloud", ["--fake-probe"], { env, encoding: "utf8" });
    assert.equal(probe.stdout, "fake-gcloud", "the stand-in shadows any real gcloud");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
const { main } = await import(${JSON.stringify(join(WORKER_ROOT, "scripts/gcp-fastpath-test-deploy.mjs"))});
try { await main(JSON.parse(process.argv[1])); console.error("RESULT " + JSON.stringify({ ok: true })); }
catch (error) { console.error("RESULT " + JSON.stringify({ code: error?.code ?? null })); }`, JSON.stringify(run.argv(dir))],
    { env, encoding: "utf8", cwd: WORKER_ROOT });
    const result = JSON.parse(child.stderr.split("\n").find((line) => line.startsWith("RESULT ")).slice(7));
    const calls = (await readFile(join(dir, "calls.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean)
      .map((line) => JSON.parse(line));
    return await run.check({ result, calls, dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the refresh step refuses to deploy over a running execution and fails a LOCK_HELD execution", async () => {
  const refreshArgv = (dir) => ["refresh", `--image=${IMAGE}`, `--schema=${SEEDED}`, `--now=${MEAS_NOW}`,
    "--refresh-profile=dense", `--out=${join(dir, "out")}`];
  const at = { created: "2026-10-04T00:00:05Z", start: "2026-10-04T00:00:20Z", end: "2026-10-04T00:01:00Z" };
  await withFakeGcloud({
    "run jobs executions list": { stdout: JSON.stringify([uncappedExecution(`${REFRESH_JOB}-r1abc`,
      { ...at, running: true })]) },
  }, {
    argv: refreshArgv,
    check({ result, calls }) {
      assert.equal(result.code, "FASTPATH_DEPLOY_REFRESH_EXECUTION_RUNNING");
      assert.deepEqual(calls.map((args) => kindOf(["gcloud", ...args])), ["run jobs executions list"],
        "nothing is deployed");
    },
  });
  await withFakeGcloud({
    "run jobs executions list": { stdout: "[]" },
    "run jobs deploy": { stdout: "" },
    "run jobs execute": { stdout: JSON.stringify(uncappedExecution(`${REFRESH_JOB}-l4abc`, at)) },
    "logging read": { stdout: JSON.stringify([{ timestamp: at.end, jsonPayload: { status: "ok", state: "LOCK_HELD" } }]) },
  }, {
    argv: refreshArgv,
    async check({ result, calls, dir }) {
      assert.equal(result.code, "FASTPATH_DEPLOY_REFRESH_LOCK_HELD");
      assert.deepEqual(calls.map((args) => kindOf(["gcloud", ...args])),
        ["run jobs executions list", "run jobs deploy", "run jobs execute", "logging read"]);
      const receipt = JSON.parse(await readFile(join(dir, "out", "refresh.json"), "utf8"));
      assert.deepEqual([receipt.succeeded, receipt.results.at(-1).state], [true, "LOCK_HELD"]);
    },
  });
});

// ---------------------------------------------------------------------------
// The disposable production-tier measurement estate (MEAS-SYNTH).

const MEAS = "tibotattle-meas-prodtier-20261003";
const MEAS_CONNECTION = `tibotattle:us-east1:${MEAS}`;
const MEAS_JOB = FASTPATH_MEASUREMENT.refreshJob;
const FOREIGN_INSTANCE_NAMES = Object.freeze(["tibotattle-primary", "tibotattle-staging-primary",
  "tibotattle-test-primary-20260922", "tibotattle-meas-prodtier-20261332", "tibotattle-meas-prodtier-20250101",
  "tibotattle-meas-prodtier-2026100", "tibotattle-meas-prodtier-20261003-b", "Tibotattle-meas-prodtier-20261003",
  " tibotattle-meas-prodtier-20261003", "tibotattle-meas-prodtier-", "", null, undefined]);

/** A Cloud SQL instance as `sql instances describe --format=json` renders the one meas-create builds. */
function measInstanceResource(overrides = {}, settingsOverrides = {}) {
  return {
    name: MEAS, project: "tibotattle", region: "us-east1", databaseVersion: "POSTGRES_17", state: "RUNNABLE",
    settings: { tier: "db-custom-4-16384", edition: "ENTERPRISE", availabilityType: "ZONAL", dataDiskType: "PD_SSD",
      connectorEnforcement: "REQUIRED", ipConfiguration: { ipv4Enabled: true, authorizedNetworks: [] },
      databaseFlags: [...FASTPATH_MEASUREMENT.databaseFlags, ...FASTPATH_MEASUREMENT.diagnosticFlags]
        .map(([name, value]) => ({ name, value })),
      insightsConfig: { queryInsightsEnabled: true, queryPlansPerMinute: 5, queryStringLength: 4500,
        recordApplicationTags: false, recordClientAddress: false },
      userLabels: { ...FASTPATH_MEASUREMENT.labels }, deletionProtectionEnabled: false, ...settingsOverrides },
    ...overrides,
  };
}

const sqlKind = (command) => (command[1] === "sql" ? command.slice(1, 4).join(" ") : kindOf(command));
/** Another instance and Job of the test project, as listings render them: never a measurement resource. */
const OTHER_INSTANCE = Object.freeze({ name: FASTPATH_TEST.instance, project: "tibotattle", region: "us-east1",
  settings: { userLabels: { app: "tibotattle", environment: "test" } } });
const OTHER_JOB = Object.freeze({ metadata: { name: FASTPATH_TEST.refreshJob } });

/** A Runner stand-in whose exec and json both answer from `answer(kind, nth, command)`; FAILED fails the call. */
function measRunner(answer) {
  const runner = {
    dryRun: false, commands: [], receipts: {},
    print(command) { this.commands.push(command); },
    call(command, options) {
      this.commands.push(command);
      const kind = sqlKind(command);
      const value = answer(kind, this.commands.filter((seen) => sqlKind(seen) === kind).length, command);
      if (value === FAILED) {
        if (options.allowFailure) return { status: 1, stdout: "", stderr: "" };
        throw Object.assign(new Error("FASTPATH_DEPLOY_COMMAND_FAILED"), { code: "FASTPATH_DEPLOY_COMMAND_FAILED" });
      }
      return { status: 0, stdout: value === undefined ? "" : JSON.stringify(value), stderr: "" };
    },
    exec(command, options = {}) { return this.call(command, options); },
    json(command, options = {}) {
      const result = this.call(command, options);
      return result.status !== 0 || result.stdout === "" ? null : JSON.parse(result.stdout);
    },
    async receipt(name, value) { this.receipts[name] = structuredClone(value); return `/receipts/${name}`; },
  };
  return runner;
}

test("measurement names: only tibotattle-meas-prodtier-<YYYYMMDD>; production, staging and test names are refused", () => {
  assert.deepEqual({ ...fastpathMeasurementInstance(MEAS) }, { instance: MEAS, instanceConnectionName: MEAS_CONNECTION });
  assert.equal(isFastpathMeasurementInstanceConnectionName(MEAS_CONNECTION), true);
  for (const value of [FASTPATH_TEST.instanceConnectionName, `tibotattle:us-central1:${MEAS}`, `other:us-east1:${MEAS}`,
    `${MEAS_CONNECTION}:x`, MEAS]) {
    assert.equal(isFastpathMeasurementInstanceConnectionName(value), false, value);
  }
  const production = JSON.parse(readFileSyncText(join(WORKER_ROOT, "cloud-run/infra/production.desired-state.json")));
  const staging = loadCommittedDesiredState("staging");
  for (const name of [...FOREIGN_INSTANCE_NAMES, production.cloudSql.instance, staging.cloudSql.instance]) {
    assert.equal(fastpathMeasurementInstance(name), null, String(name));
    for (const build of [assertMeasurementInstance, measInstanceDescribeCommand, measInstanceCreateCommand,
      measInstanceDeleteCommand, measDatabasesListCommand, measDatabaseCreateCommand, measUsersListCommand,
      (instance) => measIamUserCreateCommand(instance, FASTPATH_MEASUREMENT.iamServiceAccounts[0]),
      // Without a measurement instance (null, undefined) these target the fast-path test Job.
      ...(name === null || name === undefined ? [] : [(instance) => refreshTarget({ measInstance: instance }),
        (instance) => refreshJobCommand({ image: IMAGE, schema: SEEDED, measInstance: instance })])]) {
      expectCode(() => build(name), "FASTPATH_DEPLOY_MEAS_INSTANCE_INVALID");
    }
    assert.throws(() => fastpathInstanceConnectionName(name ?? "x"),
      (error) => error?.code === "GCP_FASTPATH_CONNECTION_INSTANCE_INVALID", String(name));
  }
  assert.equal(fastpathInstanceConnectionName(undefined), FASTPATH_TEST.instanceConnectionName);
  assert.equal(refreshTarget({ measInstance: null }).job, FASTPATH_TEST.refreshJob);
  assert.equal(fastpathInstanceConnectionName(MEAS), MEAS_CONNECTION);
  expectCode(() => measIamUserCreateCommand(MEAS, "someone@tibotattle.iam.gserviceaccount.com"),
    "FASTPATH_DEPLOY_ARGUMENT_INVALID");
  for (const operation of ["", "a b", "x".repeat(101), "../x", undefined]) {
    expectCode(() => sqlOperationWaitCommand(operation), "FASTPATH_DEPLOY_ARGUMENT_INVALID");
  }
  // Every measurement command: gcloud, the test project, this instance or the measurement Job, nothing else.
  const commands = [measInstanceDescribeCommand(MEAS), measInstanceCreateCommand(MEAS), measInstanceDeleteCommand(MEAS),
    measDatabasesListCommand(MEAS), measDatabaseCreateCommand(MEAS), measUsersListCommand(MEAS),
    ...FASTPATH_MEASUREMENT.iamServiceAccounts.map((account) => measIamUserCreateCommand(MEAS, account)),
    sqlOperationWaitCommand("0a1b2c3d-op"), measJobDeleteCommand(), measExecutionCancelCommand(`${MEAS_JOB}-ab12c`),
    measInstancesListCommand(), jobsListCommand()];
  for (const command of commands) {
    assert.equal(command[0], "gcloud");
    assert.equal(command.filter((arg) => arg.startsWith("--project=")).join(), "--project=tibotattle");
    const named = command.filter((arg) => /tibotattle-(?:meas|fastpath|test|primary|staging)/u.test(arg)
      && !arg.startsWith("--labels=") && !arg.includes("@tibotattle.iam"));
    for (const arg of named) assert.ok(arg === MEAS || arg === `--instance=${MEAS}` || arg.startsWith(MEAS_JOB), arg);
  }
  assert.deepEqual(measInstanceDeleteCommand(MEAS), ["gcloud", "sql", "instances", "delete", MEAS, "--project=tibotattle",
    "--async", "--quiet", "--format=json"]);
  // The presence reads list the test project only, read-only.
  assert.deepEqual(measInstancesListCommand(), ["gcloud", "sql", "instances", "list", "--project=tibotattle", "--format=json"]);
  assert.deepEqual(jobsListCommand(), ["gcloud", "run", "jobs", "list", "--project=tibotattle", "--region=us-east1",
    "--format=json"]);
  assert.deepEqual(measJobDeleteCommand(), ["gcloud", "run", "jobs", "delete", MEAS_JOB, "--project=tibotattle",
    "--region=us-east1", "--quiet"]);
  expectCode(() => measExecutionCancelCommand(`${REFRESH_JOB}-ab12c`), "FASTPATH_DEPLOY_EXECUTION_INVALID");
  assert.equal(FASTPATH_MEASUREMENT.refreshJob, FASTPATH_MEASUREMENT_CLOUD_TARGET.refreshJob);
  assert.equal(MEAS_JOB.startsWith("tibotattle-fastpath-"), true, "the wrapper's fast-path name rule holds");
});

test("the measurement instance is production's shape: tier, storage, posture and flags mirror C-INFRA", () => {
  const production = JSON.parse(readFileSyncText(join(WORKER_ROOT, "cloud-run/infra/production.desired-state.json")));
  const m = FASTPATH_MEASUREMENT;
  assert.deepEqual([m.tier, m.storageSizeGb, m.maxConnections],
    [production.cloudSql.tier, production.cloudSql.storageSizeGb, production.cloudSql.maxConnections]);
  assert.deepEqual([m.databaseVersion, m.edition, m.availabilityType],
    [CLOUD_SQL_POSTURE.databaseVersion, CLOUD_SQL_POSTURE.edition, CLOUD_SQL_POSTURE.availabilityType]);
  assert.deepEqual(m.databaseFlags.map(([name, value]) => ({ name, value })),
    databaseFlags({ cloudSql: { maxConnections: production.cloudSql.maxConnections } }).map((flag) => ({ ...flag })));
  assert.equal(Object.keys(CLOUD_SQL_LOGGING_FLAGS).length + 1, m.databaseFlags.length);
  assert.equal(CLOUD_SQL_POSTURE.connectorEnforcement, "REQUIRED");
  assert.deepEqual(CLOUD_SQL_POSTURE.authorizedNetworks, []);
  // The create command equals C-INFRA's instance command on every shared flag;
  // it differs only where a disposable instance must.
  const create = measInstanceCreateCommand(MEAS).slice(1);
  const reference = cloudSqlCreateArgs({ ...loadCommittedDesiredState("staging"),
    cloudSql: { ...loadCommittedDesiredState("staging").cloudSql, tier: production.cloudSql.tier,
      storageSizeGb: production.cloudSql.storageSizeGb, maxConnections: production.cloudSql.maxConnections } });
  const shared = (args) => args.filter((arg) => /^--(?:database-version|edition|tier|availability-type|storage-type|storage-size|storage-auto-increase|assign-ip|connector-enforcement)\b/u.test(arg));
  assert.deepEqual(shared(create), shared([...reference]));
  assert.equal(shared(create).length, 9);
  // Flags: production's, plus the profiling diagnostics, nothing else.
  const flagsOf = (args) => args.find((arg) => arg.startsWith("--database-flags=")).slice("--database-flags=".length)
    .split(",").sort();
  const productionFlags = flagsOf([...reference]);
  const diagnostics = m.diagnosticFlags.map(([name, value]) => `${name}=${value}`);
  assert.deepEqual(flagsOf(create), [...productionFlags, ...diagnostics].sort());
  assert.deepEqual(diagnostics, ["pg_stat_statements.track=all", "track_io_timing=on"]);
  // Query Insights: production keeps it off; the measurement instance turns it on, without client
  // addresses or application tags (a stated divergence for the profile).
  assert.equal(reference.includes("--no-insights-config-query-insights-enabled"), true);
  const own = create.filter((arg) => !shared([arg]).length && !arg.startsWith("--database-flags=")
    && !["sql", "instances", "create", MEAS].includes(arg));
  assert.deepEqual(own, ["--project=tibotattle", "--region=us-east1", "--no-deletion-protection", "--no-backup",
    "--insights-config-query-insights-enabled", "--insights-config-query-plans-per-minute=5",
    "--insights-config-query-string-length=4500", "--no-insights-config-record-application-tags",
    "--no-insights-config-record-client-address",
    "--labels=app=tibotattle,environment=test,managed-by=claude-fastpath,purpose=meas-prodtier", "--async",
    "--format=json"]);
  assert.equal(create.some((arg) => /authorized-networks|--no-assign-ip|--network=|--deletion-protection$/u.test(arg)), false);
  // A read-back is checked field by field; a foreign label set is visible as such.
  assert.deepEqual(measurementInstanceMismatches(measInstanceResource(), MEAS), []);
  assert.deepEqual(measurementInstanceMismatches(measInstanceResource({}, {
    ipConfiguration: { ipv4Enabled: true, authorizedNetworks: [{ value: "0.0.0.0/0" }] },
    connectorEnforcement: "NOT_REQUIRED", tier: "db-g1-small" }), MEAS), ["tier", "authorizedNetworks", "connectorEnforcement"]);
  assert.deepEqual(measurementInstanceMismatches(measInstanceResource({}, { userLabels: {} }), MEAS), ["labels"]);
  assert.deepEqual(measurementInstanceMismatches(measInstanceResource({}, {
    databaseFlags: [...FASTPATH_MEASUREMENT.databaseFlags, ...FASTPATH_MEASUREMENT.diagnosticFlags]
      .map(([name, value]) => ({ name, value })).concat([{ name: "log_statement", value: "all" }]) }), MEAS),
  ["databaseFlags"]);
  // The profiling diagnostics: required flags, an optional flag only at its value, and Query Insights.
  assert.deepEqual(measurementInstanceMismatches(measInstanceResource({}, {
    databaseFlags: FASTPATH_MEASUREMENT.databaseFlags.map(([name, value]) => ({ name, value })) }), MEAS),
  ["diagnosticFlags"]);
  assert.deepEqual(measurementInstanceMismatches(measInstanceResource({}, {
    databaseFlags: [...FASTPATH_MEASUREMENT.databaseFlags, ...FASTPATH_MEASUREMENT.diagnosticFlags,
      ...FASTPATH_MEASUREMENT.optionalDiagnosticFlags].map(([name, value]) => ({ name, value })) }), MEAS), []);
  assert.deepEqual(measurementInstanceMismatches(measInstanceResource({}, {
    databaseFlags: [...FASTPATH_MEASUREMENT.databaseFlags, ...FASTPATH_MEASUREMENT.diagnosticFlags]
      .map(([name, value]) => ({ name, value })).concat([{ name: "cloudsql.enable_pg_stat_statements", value: "off" }]) }),
  MEAS), ["diagnosticFlags"]);
  for (const insightsConfig of [undefined, { queryInsightsEnabled: false }, { queryInsightsEnabled: true,
    queryPlansPerMinute: 5, queryStringLength: 4500, recordClientAddress: true }]) {
    assert.deepEqual(measurementInstanceMismatches(measInstanceResource({}, { insightsConfig }), MEAS), ["queryInsights"]);
  }
});

test("meas-create's flags: a listing must name every mirrored and required flag; optional ones only when listed", () => {
  const m = FASTPATH_MEASUREMENT;
  assert.deepEqual(measFlagsListCommand(), ["gcloud", "sql", "flags", "list", "--database-version=POSTGRES_17",
    "--project=tibotattle", "--format=json"]);
  const names = (pairs) => pairs.map(([name]) => ({ name }));
  const without = measCreateFlags(names([...m.databaseFlags, ...m.diagnosticFlags]));
  assert.deepEqual(without.optionalApplied, []);
  assert.deepEqual(without.optionalUnlisted, ["cloudsql.enable_pg_stat_statements"]);
  assert.deepEqual(without.flags.map(([name]) => name), [...m.databaseFlags, ...m.diagnosticFlags].map(([name]) => name)
    .sort());
  const withOptional = measCreateFlags(names([...m.databaseFlags, ...m.diagnosticFlags, ...m.optionalDiagnosticFlags,
    ["unrelated_flag"]]));
  assert.deepEqual(withOptional.optionalApplied, ["cloudsql.enable_pg_stat_statements"]);
  assert.equal(measInstanceCreateCommand(MEAS, withOptional.flags).find((arg) => arg.startsWith("--database-flags="))
    .includes("cloudsql.enable_pg_stat_statements=on"), true);
  for (const missing of ["track_io_timing", "pg_stat_statements.track", "cloudsql.iam_authentication"]) {
    expectCode(() => measCreateFlags(names([...m.databaseFlags, ...m.diagnosticFlags])
      .filter(({ name }) => name !== missing)), "FASTPATH_DEPLOY_MEAS_FLAG_UNSUPPORTED");
  }
  expectCode(() => measCreateFlags({ flags: [] }), "FASTPATH_DEPLOY_JSON_INVALID");
  // The create command takes only a set measCreateFlags can return.
  for (const flags of [m.databaseFlags, [...m.databaseFlags, ...m.diagnosticFlags, ["log_statement", "all"]],
    [...m.databaseFlags, ["track_io_timing", "off"], ["pg_stat_statements.track", "all"]]]) {
    expectCode(() => measInstanceCreateCommand(MEAS, flags), "FASTPATH_DEPLOY_ARGUMENT_INVALID");
  }
});

test("meas-create builds the instance once, waits, reads it back, and refuses an instance it did not build", async () => {
  let created = false;
  const listing = [...FASTPATH_MEASUREMENT.databaseFlags, ...FASTPATH_MEASUREMENT.diagnosticFlags]
    .map(([name]) => ({ name }));
  const fresh = measRunner((kind) => {
    if (kind === "sql instances list") return [OTHER_INSTANCE];
    if (kind === "sql flags list") return listing;
    if (kind === "sql instances describe") return created ? measInstanceResource() : assert.fail("describe before create");
    if (kind === "sql instances create") { created = true; return { name: "op-create-1" }; }
    if (kind === "sql operations wait") return undefined;
    if (kind === "sql databases list") return [{ name: "postgres" }];
    if (kind === "sql databases create") return undefined;
    if (kind === "sql users list") return [{ name: "postgres", type: "BUILT_IN" }];
    if (kind === "sql users create") return undefined;
    return assert.fail(kind);
  });
  let clock = 0;
  const receipt = await stepMeasCreate(fresh, { measInstance: MEAS }, { wallClock: () => (clock += 450_000) });
  assert.deepEqual(fresh.commands.map(sqlKind), ["sql instances list", "sql flags list", "sql instances create",
    "sql operations wait", "sql instances describe", "sql databases list", "sql databases create", "sql users list",
    "sql users create", "sql users create"]);
  assert.deepEqual(fresh.commands[0], measInstancesListCommand());
  assert.deepEqual(fresh.commands[1], measFlagsListCommand());
  assert.deepEqual(fresh.commands[2], measInstanceCreateCommand(MEAS));
  assert.deepEqual(fresh.commands[3], sqlOperationWaitCommand("op-create-1"));
  assert.deepEqual(receipt.optionalFlagsUnlisted, ["cloudsql.enable_pg_stat_statements"]);
  assert.equal(receipt.databaseFlags.includes("track_io_timing=on"), true);
  assert.deepEqual(fresh.commands.slice(-2), FASTPATH_MEASUREMENT.iamServiceAccounts
    .map((account) => measIamUserCreateCommand(MEAS, account)));
  assert.deepEqual([receipt.existed, receipt.createSeconds, receipt.state, receipt.mismatches, receipt.databaseCreated],
    [false, 450, "RUNNABLE", [], true]);
  assert.deepEqual(receipt.usersCreated, ["tibotattle-test-migrator@tibotattle.iam", "tibotattle-test-runtime@tibotattle.iam"]);

  // Re-run over its own instance: reads only.
  const again = measRunner((kind) => ({
    "sql instances list": [OTHER_INSTANCE, measInstanceResource()],
    "sql instances describe": measInstanceResource(),
    "sql databases list": [{ name: FASTPATH_MEASUREMENT.database }],
    "sql users list": FASTPATH_MEASUREMENT.iamServiceAccounts.map((account) => ({
      name: account.replace(/\.gserviceaccount\.com$/u, ""), type: "CLOUD_IAM_SERVICE_ACCOUNT" })),
  })[kind] ?? assert.fail(kind));
  const reread = await stepMeasCreate(again, { measInstance: MEAS });
  assert.equal(reread.existed, true);
  assert.deepEqual(again.commands.map(sqlKind), ["sql instances list", "sql instances describe", "sql instances describe",
    "sql databases list", "sql users list"]);

  // A listing that fails (expired credentials, network, permission) is not "absent": nothing is created.
  for (const unread of [FAILED, undefined, { items: [] }, [{ state: "RUNNABLE" }]]) {
    const blind = measRunner((kind) => (kind === "sql instances list" ? unread : assert.fail(kind)));
    await assert.rejects(stepMeasCreate(blind, { measInstance: MEAS }),
      (error) => ["FASTPATH_DEPLOY_COMMAND_FAILED", "FASTPATH_DEPLOY_JSON_INVALID"].includes(error?.code), String(unread));
    assert.deepEqual(blind.commands.map(sqlKind), ["sql instances list"]);
  }

  // Someone else's instance of that name, or a built-in user of the identity's name: refused, nothing written.
  const foreign = measRunner((kind) => ({
    "sql instances list": [measInstanceResource({}, { userLabels: { app: "other" } })],
    "sql instances describe": measInstanceResource({}, { userLabels: { app: "other" } }),
  })[kind] ?? assert.fail(kind));
  await assert.rejects(stepMeasCreate(foreign, { measInstance: MEAS }),
    (error) => error?.code === "FASTPATH_DEPLOY_MEAS_INSTANCE_FOREIGN");
  const impostor = measRunner((kind) => ({
    "sql instances list": [measInstanceResource()],
    "sql instances describe": measInstanceResource(), "sql databases list": [{ name: FASTPATH_MEASUREMENT.database }],
    "sql users list": [{ name: "tibotattle-test-migrator@tibotattle.iam", type: "BUILT_IN" }],
  })[kind] ?? assert.fail(kind));
  await assert.rejects(stepMeasCreate(impostor, { measInstance: MEAS }),
    (error) => error?.code === "FASTPATH_DEPLOY_MEAS_USER_UNEXPECTED");
  assert.equal(impostor.commands.some((command) => sqlKind(command) === "sql users create"), false);

  // A created instance that reads back with another shape stops before the database and users.
  let made = false;
  const drifted = measRunner((kind) => {
    if (kind === "sql instances list") return [];
    if (kind === "sql flags list") return listing;
    if (kind === "sql instances describe") return made ? measInstanceResource({}, { connectorEnforcement: "NOT_REQUIRED" }) : FAILED;
    if (kind === "sql instances create") { made = true; return { name: "op-create-2" }; }
    if (kind === "sql operations wait") return undefined;
    return assert.fail(kind);
  });
  await assert.rejects(stepMeasCreate(drifted, { measInstance: MEAS }),
    (error) => error?.code === "FASTPATH_DEPLOY_MEAS_INSTANCE_UNEXPECTED" && error.message.endsWith("RUNNABLE,connectorEnforcement"));
  assert.deepEqual(drifted.receipts["meas-create.json"].mismatches, ["connectorEnforcement"]);

  // A version whose listing lacks a required diagnostic flag: refused before any write.
  const unsupported = measRunner((kind) => {
    if (kind === "sql instances list") return [];
    if (kind === "sql flags list") return listing.filter(({ name }) => name !== "track_io_timing");
    return assert.fail(kind);
  });
  await assert.rejects(stepMeasCreate(unsupported, { measInstance: MEAS }),
    (error) => error?.code === "FASTPATH_DEPLOY_MEAS_FLAG_UNSUPPORTED" && error.message.endsWith("track_io_timing"));
  assert.deepEqual(unsupported.commands.map(sqlKind), ["sql instances list", "sql flags list"]);
});

test("meas-teardown cancels and deletes the Job, deletes only an instance it built, and is idempotent", async () => {
  const running = uncappedExecution(`${MEAS_JOB}-r1abc`, { created: "2026-10-04T00:00:05Z", start: "2026-10-04T00:00:20Z",
    running: true });
  let gone = false;
  let jobGone = false;
  const full = measRunner((kind) => {
    if (kind === "run jobs list") return jobGone ? [OTHER_JOB] : [OTHER_JOB, { metadata: { name: MEAS_JOB } }];
    if (kind === "run jobs executions list") return [running];
    if (kind === "run jobs executions cancel") return undefined;
    if (kind === "run jobs delete") { jobGone = true; return undefined; }
    if (kind === "sql instances list") return gone ? [OTHER_INSTANCE] : [OTHER_INSTANCE, measInstanceResource()];
    if (kind === "sql instances describe") return gone ? FAILED : measInstanceResource();
    if (kind === "sql instances delete") { gone = true; return { name: "op-delete-1" }; }
    if (kind === "sql operations wait") return undefined;
    return assert.fail(kind);
  });
  const receipt = await stepMeasTeardown(full, { measInstance: MEAS });
  assert.deepEqual(full.commands.map(sqlKind), ["run jobs list", "run jobs executions list",
    "run jobs executions cancel", "run jobs delete", "sql instances list", "sql instances describe",
    "sql instances delete", "sql operations wait", "run jobs list", "sql instances list"]);
  assert.deepEqual(full.commands[0], jobsListCommand());
  assert.deepEqual(full.commands[2], measExecutionCancelCommand(`${MEAS_JOB}-r1abc`));
  assert.deepEqual(full.commands[4], measInstancesListCommand());
  assert.deepEqual(full.commands[6], measInstanceDeleteCommand(MEAS));
  assert.deepEqual(full.commands[7], sqlOperationWaitCommand("op-delete-1"));
  assert.deepEqual([receipt.jobPresent, receipt.instancePresent, receipt.cancelled, receipt.jobDeleted,
    receipt.instanceDeleted, receipt.jobAbsent, receipt.instanceAbsent, receipt.remainingMeasurementInstances,
    receipt.errors], [true, true, [`${MEAS_JOB}-r1abc`], true, true, true, true, [], []]);

  // Nothing left: reads only, success.
  const empty = measRunner((kind) => (kind === "run jobs list" ? [OTHER_JOB]
    : kind === "sql instances list" ? [OTHER_INSTANCE] : assert.fail(kind)));
  const none = await stepMeasTeardown(empty, { measInstance: MEAS });
  assert.deepEqual([none.jobPresent, none.instancePresent, none.jobDeleted, none.instanceDeleted, none.jobAbsent,
    none.instanceAbsent, none.remainingMeasurementInstances], [false, false, false, false, true, true, []]);
  assert.deepEqual(empty.commands.map(sqlKind), ["run jobs list", "sql instances list", "run jobs list", "sql instances list"]);

  // An instance of that name this wrapper did not build is never deleted.
  const foreign = measRunner((kind) => ({
    "run jobs list": [], "sql instances list": [measInstanceResource({}, { userLabels: {} })],
    "sql instances describe": measInstanceResource({}, { userLabels: {} }),
  })[kind] ?? assert.fail(kind));
  await assert.rejects(stepMeasTeardown(foreign, { measInstance: MEAS }),
    (error) => error?.code === "FASTPATH_DEPLOY_MEAS_INSTANCE_FOREIGN");
  assert.equal(foreign.commands.some((command) => sqlKind(command) === "sql instances delete"), false);

  // A Job that cannot be deleted does not keep the instance alive; the step still fails.
  let deleted = false;
  const stuck = measRunner((kind) => {
    if (kind === "run jobs list") return [{ metadata: { name: MEAS_JOB } }];
    if (kind === "run jobs executions list") return [];
    if (kind === "run jobs delete") return FAILED;
    if (kind === "sql instances list") return deleted ? [] : [measInstanceResource()];
    if (kind === "sql instances describe") return measInstanceResource();
    if (kind === "sql instances delete") { deleted = true; return { name: "op-delete-2" }; }
    if (kind === "sql operations wait") return undefined;
    return assert.fail(kind);
  });
  await assert.rejects(stepMeasTeardown(stuck, { measInstance: MEAS }),
    (error) => error?.code === "FASTPATH_DEPLOY_MEAS_TEARDOWN_INCOMPLETE" && error.message.includes("job absent false"));
  assert.equal(deleted, true);
  assert.deepEqual(stuck.receipts["meas-teardown.json"].errors, ["job:FASTPATH_DEPLOY_COMMAND_FAILED"]);
  assert.equal(stuck.receipts["meas-teardown.json"].instanceAbsent, true);
});

// MEAS-SYNTH review (2026-10-03): teardown took a failed describe for
// "absent", so with expired credentials after a 13-20 h run it deleted
// nothing, reported both absent and exited 0, leaving the prod-tier instance
// running. Absence now comes only from listings that succeeded.
test("meas-teardown never reports success when its reads fail, and names any measurement instance left running", async () => {
  // Every gcloud call fails (reauthentication required, network, quota): nothing is deleted, and the step fails.
  const blind = measRunner(() => FAILED);
  await assert.rejects(stepMeasTeardown(blind, { measInstance: MEAS }),
    (error) => error?.code === "FASTPATH_DEPLOY_MEAS_TEARDOWN_INCOMPLETE"
      && error.message.includes("job absent null, instance absent null, measurement instances remaining unread"));
  const unread = blind.receipts["meas-teardown.json"];
  assert.deepEqual([unread.jobPresent, unread.instancePresent, unread.jobDeleted, unread.instanceDeleted, unread.jobAbsent,
    unread.instanceAbsent, unread.remainingMeasurementInstances], [null, null, false, false, null, null, null]);
  assert.deepEqual(unread.errors, ["job:FASTPATH_DEPLOY_COMMAND_FAILED", "instance:FASTPATH_DEPLOY_COMMAND_FAILED",
    "job-readback:FASTPATH_DEPLOY_COMMAND_FAILED", "instance-readback:FASTPATH_DEPLOY_COMMAND_FAILED"]);
  assert.deepEqual(blind.commands.map(sqlKind), ["run jobs list", "sql instances list", "run jobs list", "sql instances list"]);

  // Only the describe of a listed instance fails: it is not deleted, and the step fails.
  const halfBlind = measRunner((kind) => ({ "run jobs list": [], "sql instances list": [measInstanceResource()],
    "sql instances describe": FAILED })[kind] ?? assert.fail(kind));
  await assert.rejects(stepMeasTeardown(halfBlind, { measInstance: MEAS }),
    (error) => error?.code === "FASTPATH_DEPLOY_MEAS_TEARDOWN_INCOMPLETE" && error.message.includes("instance absent false"));
  assert.equal(halfBlind.commands.some((command) => sqlKind(command) === "sql instances delete"), false);
  assert.deepEqual(halfBlind.receipts["meas-teardown.json"].remainingMeasurementInstances, [MEAS]);

  // An unreadable listing is not an empty one.
  for (const listing of [undefined, { items: [] }, [{ state: "RUNNABLE" }]]) {
    const odd = measRunner((kind) => (kind === "run jobs list" ? [] : kind === "sql instances list" ? listing
      : assert.fail(kind)));
    await assert.rejects(stepMeasTeardown(odd, { measInstance: MEAS }),
      (error) => error?.code === "FASTPATH_DEPLOY_MEAS_TEARDOWN_INCOMPLETE" && error.message.includes("instance absent null"),
      JSON.stringify(listing));
    assert.deepEqual(odd.receipts["meas-teardown.json"].errors, ["instance:FASTPATH_DEPLOY_JSON_INVALID",
      "instance-readback:FASTPATH_DEPLOY_JSON_INVALID"], JSON.stringify(listing));
    assert.equal(odd.commands.some((command) => sqlKind(command) === "sql instances delete"), false);
  }
  const oddJobs = measRunner((kind) => (kind === "run jobs list" ? [{ spec: {} }] : kind === "sql instances list" ? []
    : assert.fail(kind)));
  await assert.rejects(stepMeasTeardown(oddJobs, { measInstance: MEAS }),
    (error) => error?.code === "FASTPATH_DEPLOY_MEAS_TEARDOWN_INCOMPLETE" && error.message.includes("job absent null"));
  assert.equal(oddJobs.commands.some((command) => sqlKind(command) === "run jobs delete"), false);

  // The named instance never existed (a `date` re-evaluated after midnight), but another
  // measurement instance is running: it is named, never deleted by this call, and the step fails.
  const yesterday = "tibotattle-meas-prodtier-20261002";
  const unlabelled = "tibotattle-meas-prodtier-20261001";
  const drift = measRunner((kind) => ({ "run jobs list": [OTHER_JOB],
    "sql instances list": [OTHER_INSTANCE, measInstanceResource({ name: yesterday }),
      measInstanceResource({ name: unlabelled }, { userLabels: {} }),
      { ...OTHER_INSTANCE, name: "someone-elses-instance", settings: { userLabels: { purpose: "meas-prodtier" } } }],
  })[kind] ?? assert.fail(kind));
  await assert.rejects(stepMeasTeardown(drift, { measInstance: MEAS }),
    (error) => error?.code === "FASTPATH_DEPLOY_MEAS_TEARDOWN_INCOMPLETE"
      && error.message.includes(`measurement instances remaining someone-elses-instance ${unlabelled} ${yesterday}`));
  const drifted = drift.receipts["meas-teardown.json"];
  assert.deepEqual([drifted.instancePresent, drifted.instanceAbsent, drifted.errors], [false, true, []]);
  assert.deepEqual(drifted.remainingMeasurementInstances, ["someone-elses-instance", unlabelled, yesterday]);
  assert.equal(drift.commands.some((command) => ["sql instances describe", "sql instances delete"].includes(sqlKind(command))),
    false);
  assert.deepEqual(measurementInstancesListed([OTHER_INSTANCE]), []);

  // A dry run prints the deletions as if both existed, and reads nothing back.
  const dry = { ...measRunner(() => assert.fail("no remote command in a dry run")), dryRun: true };
  dry.json = function json(command, options = {}) { this.commands.push(command); return options.placeholderJson ?? null; };
  dry.exec = function exec(command, { placeholder = "" } = {}) { this.commands.push(command); return { status: 0, stdout: placeholder, dry: true }; };
  const printed = await stepMeasTeardown(dry, { measInstance: MEAS });
  assert.deepEqual(dry.commands.map(sqlKind), ["run jobs list", "run jobs executions list", "run jobs delete",
    "sql instances list", "sql instances describe", "sql instances delete", "sql operations wait"]);
  assert.deepEqual([printed.jobAbsent, printed.instanceAbsent, printed.errors], [null, null, []]);
});

test("refresh-idle reads the measurement Job's presence from a listing; a failed read is not absence", () => {
  const listing = (jobs) => scriptedRunner((command) => (kindOf(command) === "run jobs list" ? jobs
    : kindOf(command) === "run jobs executions list" ? [] : assert.fail(kindOf(command))));
  const absent = listing([{ metadata: { name: REFRESH_JOB } }]);
  assert.deepEqual({ ...assertRefreshIdle(absent, { job: MEAS_JOB }) }, { step: "refresh-idle", job: MEAS_JOB, running: 0,
    absent: true });
  assert.deepEqual(absent.commands, [jobsListCommand()]);
  const present = listing([{ metadata: { name: MEAS_JOB } }]);
  assert.equal(assertRefreshIdle(present, { job: MEAS_JOB }).running, 0);
  assert.deepEqual(present.commands.map(kindOf), ["run jobs list", "run jobs executions list"]);
  // v2 resource names are read too.
  assert.equal(assertRefreshIdle(listing([{ name: `projects/tibotattle/locations/us-east1/jobs/${MEAS_JOB}` }]),
    { job: MEAS_JOB }).absent, undefined);
  expectCode(() => assertRefreshIdle(listing(FAILED), { job: MEAS_JOB }), "FASTPATH_DEPLOY_COMMAND_FAILED");
  expectCode(() => assertRefreshIdle(listing({ jobs: [] }), { job: MEAS_JOB }), "FASTPATH_DEPLOY_JSON_INVALID");
  expectCode(() => assertRefreshIdle(listing([{}]), { job: MEAS_JOB }), "FASTPATH_DEPLOY_JSON_INVALID");
  const running = uncappedExecution(`${MEAS_JOB}-r9xyz`, { created: "2026-10-04T00:00:05Z", start: "2026-10-04T00:00:20Z",
    running: true });
  const busy = scriptedRunner((command) => (kindOf(command) === "run jobs list" ? [{ metadata: { name: MEAS_JOB } }]
    : [running]));
  expectCode(() => assertRefreshIdle(busy, { job: MEAS_JOB }), "FASTPATH_DEPLOY_REFRESH_EXECUTION_RUNNING");
});

test("a measurement refresh deploys the measurement Job on its instance, which the Job alone accepts", async () => {
  const command = refreshJobCommand({ image: IMAGE, now: MEAS_NOW, schema: SEEDED, extraEnv: GUARD_ENV,
    profile: "dense", measInstance: MEAS });
  assert.equal(command[4], MEAS_JOB);
  const task = expectedRefreshTask({ image: IMAGE, now: MEAS_NOW, schema: SEEDED, extraEnv: GUARD_ENV,
    profile: "dense", measInstance: MEAS });
  const shared = denseTask();
  assert.deepEqual({ ...task, env: { ...task.env, PRIMARY_INSTANCE_CONNECTION_NAME: null } },
    { ...shared, env: { ...shared.env, PRIMARY_INSTANCE_CONNECTION_NAME: null } }, "only the instance differs");
  assert.equal(task.env.PRIMARY_INSTANCE_CONNECTION_NAME, MEAS_CONNECTION);
  expectCode(() => refreshJobCommand({ image: IMAGE, schema: FASTPATH_TEST.primarySchema, measInstance: MEAS }),
    "FASTPATH_DEPLOY_SCHEMA_INVALID");
  // The Job's own target check, with the env the wrapper renders.
  const env = { ...task.env, CLOUD_RUN_JOB: MEAS_JOB };
  assert.deepEqual({ ...await resolveAnalyticsRefreshDatabase(env, { schema: SEEDED }) }, { kind: "cloud-sql",
    instanceConnectionName: MEAS_CONNECTION, database: "tibotattle_fastpath", iamUser: FASTPATH_TEST.runtimeIamUser });
  const forbidden = (overrides, schema = SEEDED) => assert.rejects(
    resolveAnalyticsRefreshDatabase({ ...env, ...overrides }, { schema }),
    (error) => error?.code === "ANALYTICS_V2_REFRESH_TARGET_FORBIDDEN", JSON.stringify({ overrides, schema }));
  await forbidden({}, FASTPATH_TEST.primarySchema);
  await forbidden({}, "tibotattle_fastpath_other");
  for (const instance of [FASTPATH_TEST.instanceConnectionName, "tibotattle:us-east1:tibotattle-primary",
    "tibotattle:us-east1:tibotattle-meas-prodtier-20261332", `tibotattle:us-central1:${MEAS}`]) {
    await forbidden({ PRIMARY_INSTANCE_CONNECTION_NAME: instance });
  }
  await forbidden({ PRIMARY_DATABASE: "tibotattle" });
  await forbidden({ POSTGRES_IAM_USER: "someone-else@tibotattle.iam" });
  // The fast-path test Job never reaches a measurement instance.
  await forbidden({ CLOUD_RUN_JOB: FASTPATH_TEST.refreshJob });
  // A production or staging target naming any measurement resource is refused.
  const production = { ANALYTICS_REFRESH_TARGET: "production", CLOUD_RUN_JOB: "tibotattle-analytics-refresh",
    CLOUD_RUN_TASK_INDEX: "0", CLOUD_RUN_TASK_COUNT: "1",
    PRIMARY_INSTANCE_CONNECTION_NAME: "example-ops-prod1:us-east1:tibotattle-primary", PRIMARY_DATABASE: "tibotattle_primary",
    PRIMARY_SCHEMA: "tibotattle_primary", POSTGRES_IAM_USER: "tibotattle-runtime@example-ops-prod1.iam",
    ANALYTICS_V2_MEMORY_BUDGET_MIB: "10752" };
  assert.equal((await readAnalyticsRefreshProductionTarget(production)).target, "production");
  for (const [name, value] of [["PRIMARY_INSTANCE_CONNECTION_NAME", MEAS_CONNECTION],
    ["PRIMARY_INSTANCE_CONNECTION_NAME", "example-ops-prod1:us-east1:tibotattle-meas-prodtier-20261003"],
    ["PRIMARY_INSTANCE_CONNECTION_NAME", "example-ops-prod1:us-east1:tibotattle-meas-prodtier-x"],
    ["PRIMARY_INSTANCE_CONNECTION_NAME", "example-ops-prod1:us-east1:primary-meas"],
    ["CLOUD_RUN_JOB", MEAS_JOB]]) {
    await assert.rejects(readAnalyticsRefreshProductionTarget({ ...production, [name]: value }),
      (error) => error?.code === "ANALYTICS_V2_REFRESH_TEST_TARGET_FORBIDDEN" && error.field === name, value);
  }
});

test("refresh-uncapped on a measurement instance follows only that instance's guarded refresh", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fastpath-uncapped-"));
  try {
    const measTask = expectedRefreshTask({ image: IMAGE, now: MEAS_NOW, schema: SEEDED, extraEnv: GUARD_ENV,
      profile: "dense", measInstance: MEAS });
    const guarded = { job: MEAS_JOB, measInstance: MEAS, execution: `${MEAS_JOB}-g7h2k` };
    for (const [overrides, field] of [[{ measInstance: null }, "measInstance"], [{ job: REFRESH_JOB }, "job"],
      [{ measInstance: "tibotattle-meas-prodtier-20261004" }, "measInstance"]]) {
      const runner = scriptedRunner((command) => assert.fail(`no remote command: ${kindOf(command)}`));
      const options = { ...await uncappedOptions(dir, { ...guarded, ...overrides }), measInstance: MEAS };
      await assert.rejects(stepRefreshUncapped(runner, options, IMAGE, NO_WAIT),
        (error) => error?.code === "FASTPATH_DEPLOY_UNCAPPED_AFTER_REFRESH_MISMATCH" && error.message.includes(field),
        JSON.stringify(overrides));
    }
    // The fast-path Job's guarded refresh does not admit a measurement uncapped run, nor the reverse.
    const runner = scriptedRunner((command) => assert.fail(`no remote command: ${kindOf(command)}`));
    await assert.rejects(stepRefreshUncapped(runner, { ...await uncappedOptions(dir), measInstance: MEAS }, IMAGE, NO_WAIT),
      (error) => error?.code === "FASTPATH_DEPLOY_UNCAPPED_AFTER_REFRESH_MISMATCH");
    await assert.rejects(stepRefreshUncapped(runner, await uncappedOptions(dir, guarded), IMAGE, NO_WAIT),
      (error) => error?.code === "FASTPATH_DEPLOY_UNCAPPED_AFTER_REFRESH_MISMATCH");
    // Matching: reads the measurement Job, executes it with overrides only, and reads its execution.
    const name = `${MEAS_JOB}-u5xyz`;
    const execution = taskResource("Execution", { ...measTask, env: { ...measTask.env, [REFRESH_TASK_TIMEOUT_ENV]: String(UNCAPPED) },
      timeoutSeconds: UNCAPPED }, { metadata: { name, creationTimestamp: "2026-10-04T00:00:05Z" },
      status: { startTime: "2026-10-04T00:00:20Z", completionTime: "2026-10-04T05:00:20Z", succeededCount: 1, failedCount: 0,
        conditions: [{ type: "Completed", status: "True" }] } });
    const ok = scriptedRunner((command, nth) => {
      const kind = kindOf(command);
      if (kind === "run jobs list") return [{ metadata: { name: MEAS_JOB } }];
      if (kind === "run jobs describe") return taskResource("Job", measTask);
      if (kind === "run jobs executions list" && nth === 1) return [];
      if (kind === "run jobs execute") return execution;
      if (kind === "logging read") return [{ timestamp: "2026-10-04T05:00:19Z", jsonPayload: { status: "ok", state: "complete" } }];
      return assert.fail(kind);
    });
    const receipt = await stepRefreshUncapped(ok, { ...await uncappedOptions(dir, guarded), measInstance: MEAS }, IMAGE, NO_WAIT);
    assert.deepEqual([receipt.outcome, receipt.job, receipt.measInstance, receipt.durationSeconds],
      ["complete", MEAS_JOB, MEAS, 18_000]);
    for (const command of ok.commands) {
      assert.equal(command.some((arg) => arg.includes(REFRESH_JOB)), false, "never the shared fast-path Job");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--meas-instance applies to the measurement steps only, and the meas steps require it", async () => {
  const run = async (argv) => {
    try { await main([...argv, "--dry-run", `--out=${join(tmpdir(), "fastpath-meas-args")}`]); return null; } catch (error) { return error.code; }
  };
  for (const step of ["migrate", "seed", "origin", "build", "all", "verify-database", "database"]) {
    assert.equal(await run([step, `--meas-instance=${MEAS}`]), "FASTPATH_DEPLOY_ARGUMENT_INVALID", step);
  }
  for (const step of ["meas-create", "meas-teardown"]) {
    assert.equal(await run([step]), "FASTPATH_DEPLOY_ARGUMENT_INVALID", step);
    assert.equal(await run([step, "--meas-instance=tibotattle-primary"]), "FASTPATH_DEPLOY_MEAS_INSTANCE_INVALID", step);
  }
});

// ---------------------------------------------------------------------------
// MEAS-SYNTH profiling: the profiled uncapped run, the database snapshots and
// the Cloud Monitoring read.

test("the profiler's summary lines are collected apart from status lines; the schema matches the Job's", async () => {
  const { ANALYTICS_REFRESH_PROFILE_SCHEMA } = await import("../cloud-run/analytics-refresh-profile.mjs");
  assert.equal(REFRESH_PROFILE_SCHEMA, ANALYTICS_REFRESH_PROFILE_SCHEMA);
  const profile = (sequence, reason) => ({ profile: REFRESH_PROFILE_SCHEMA, sequence, reason, phase: "compute" });
  const runner = scriptedRunner(() => [
    { timestamp: "2026-10-04T03:00:01Z", jsonPayload: { status: "ok", state: "complete" } },
    { timestamp: "2026-10-04T03:00:00Z", jsonPayload: profile(1, "exit") },
    { timestamp: "2026-10-04T00:30:00Z", textPayload: JSON.stringify(profile(0, "interval")) },
    { timestamp: "2026-10-04T00:00:01Z", jsonPayload: { profile: "something-else", sequence: 9 } },
  ]);
  const log = await readExecutionLog(runner, REFRESH_JOB, `${REFRESH_JOB}-ab12c`, { attempts: 1 });
  assert.deepEqual(log.lines, [{ status: "ok", state: "complete" }]);
  assert.deepEqual(log.profiles.map(({ sequence, reason }) => [sequence, reason]), [[0, "interval"], [1, "exit"]]);
});

test("the profiled run needs no guarded execution: refresh --no-execute deploys, refresh-uncapped follows it", async () => {
  const deployedOnly = (dir) => ["refresh", `--image=${IMAGE}`, `--schema=${SEEDED}`, `--now=${MEAS_NOW}`,
    "--refresh-profile=dense", `--meas-instance=${MEAS}`, "--no-execute",
    "--refresh-env=ANALYTICS_V2_REFRESH_PROFILE=cpu", `--out=${join(dir, "out")}`];
  await withFakeGcloud({
    "run jobs list": { stdout: "[]" },
    "run jobs deploy": { stdout: "" },
  }, {
    argv: deployedOnly,
    async check({ result, calls, dir }) {
      assert.deepEqual(result, { ok: true });
      assert.deepEqual(calls.map((args) => kindOf(["gcloud", ...args])), ["run jobs list", "run jobs deploy"],
        "deployed, never executed");
      const deploy = calls[1];
      assert.equal(deploy[3], MEAS_JOB);
      assert.equal(deploy.find((arg) => arg.startsWith("--set-env-vars=")).includes("ANALYTICS_V2_REFRESH_PROFILE=cpu"),
        true);
      const receipt = JSON.parse(await readFile(join(dir, "out", "refresh.json"), "utf8"));
      assert.deepEqual([receipt.step, receipt.executed, receipt.job, receipt.measInstance], ["refresh", false, MEAS_JOB,
        MEAS]);
    },
  });
  const dir = await mkdtemp(join(tmpdir(), "fastpath-uncapped-"));
  try {
    const env = [...GUARD_ENV, ["ANALYTICS_V2_REFRESH_PROFILE", "cpu"]];
    const measTask = expectedRefreshTask({ image: IMAGE, now: MEAS_NOW, schema: SEEDED, extraEnv: env,
      profile: "dense", measInstance: MEAS });
    const guarded = { job: MEAS_JOB, measInstance: MEAS, executed: false, execution: undefined, succeeded: undefined,
      durationSeconds: undefined, results: undefined };
    const options = { ...await uncappedOptions(dir, guarded), measInstance: MEAS, refreshEnv: env };
    const name = `${MEAS_JOB}-p9xyz`;
    const execution = taskResource("Execution", { ...measTask, env: { ...measTask.env,
      [REFRESH_TASK_TIMEOUT_ENV]: String(UNCAPPED) }, timeoutSeconds: UNCAPPED },
    { metadata: { name, creationTimestamp: "2026-10-04T00:00:05Z" },
      status: { startTime: "2026-10-04T00:00:20Z", completionTime: "2026-10-04T12:00:20Z", succeededCount: 1,
        failedCount: 0, conditions: [{ type: "Completed", status: "True" }] } });
    const ok = scriptedRunner((command, nth) => {
      const kind = kindOf(command);
      if (kind === "run jobs list") return [{ metadata: { name: MEAS_JOB } }];
      if (kind === "run jobs describe") return taskResource("Job", measTask);
      if (kind === "run jobs executions list" && nth === 1) return [];
      if (kind === "run jobs execute") return execution;
      if (kind === "logging read") {
        return [{ timestamp: "2026-10-04T12:00:19Z", jsonPayload: { status: "ok", state: "complete" } },
          { timestamp: "2026-10-04T12:00:18Z", jsonPayload: { profile: REFRESH_PROFILE_SCHEMA, sequence: 24,
            reason: "exit" } }];
      }
      return assert.fail(kind);
    });
    const receipt = await stepRefreshUncapped(ok, options, IMAGE, NO_WAIT);
    assert.deepEqual([receipt.outcome, receipt.afterRefresh.executed, receipt.afterRefresh.execution,
      receipt.durationSeconds], ["complete", false, null, 43_200]);
    assert.deepEqual(receipt.profiles.map(({ sequence }) => sequence), [24]);
    // A deployed-only receipt that names an execution is a contradiction only the executed flag settles;
    // one with neither is still refused.
    const neither = scriptedRunner((command) => assert.fail(`no remote command: ${kindOf(command)}`));
    await assert.rejects(stepRefreshUncapped(neither, { ...await uncappedOptions(dir, { ...guarded, executed: undefined }),
      measInstance: MEAS, refreshEnv: env }, IMAGE, NO_WAIT),
    (error) => error?.code === "FASTPATH_DEPLOY_UNCAPPED_AFTER_REFRESH_MISMATCH" && error.message.endsWith("execution"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A pg client stand-in for the snapshot: records every statement, answers from `answer(text)`. */
function snapshotClient(answer) {
  const sent = [];
  return {
    sent,
    async query(text, values) {
      sent.push(text.replace(/\s+/gu, " ").trim());
      const value = answer(text, values);
      if (value instanceof Error) throw value;
      return { rows: value ?? [] };
    },
    release() {},
  };
}

function snapshotPool(client, calls) {
  return async (options, as, applicationName) => {
    calls.push({ instance: options.measInstance, as, applicationName });
    return { pool: { connect: async () => client, query: (text) => client.query(text) },
      async close() { calls.push("closed"); } };
  };
}

test("meas-pgstat reads one content-free snapshot in a read-only transaction and writes nothing", async () => {
  const statement = (query, role, total) => ({ role, queryid: "-7351234567890", toplevel: true, query,
    figures: { calls: 3, total_exec_time: total, rows: 9, shared_blks_read: 4, shared_blk_read_time: 1.5, userid: 10 } });
  const client = snapshotClient((text) => {
    if (/FROM pg_settings/u.test(text)) return [{ name: "track_io_timing", setting: "on", unit: null }];
    if (/FROM pg_extension/u.test(text)) return [{ extversion: "1.11" }];
    if (/FROM pg_stat_statements/u.test(text)) {
      return [
        statement("/* analytics_v2:occurrences.load */ SELECT x FROM t WHERE owner = $1 AND note = 'person@example.com'",
          FASTPATH_TEST.runtimeIamUser, 900),
        statement("INSERT INTO t VALUES ($$secret body$$, E'it''s')", FASTPATH_TEST.migratorIamUser, 50),
        statement("<insufficient privilege>", "someone-else", 10),
      ];
    }
    if (/FROM pg_stat_database/u.test(text)) return [{ row: { blks_read: 7, blks_hit: 70, datname: "x", stats_reset: "t" } }];
    if (/FROM pg_stat_io/u.test(text)) return [{ row: { backend_type: "client backend", object: "relation",
      context: "normal", reads: 5, read_time: 2.5, op_bytes: 8192 } }];
    if (/to_regclass/u.test(text)) return [{ present: true }];
    if (/FROM pg_stat_activity/u.test(text)) return [{ role: FASTPATH_TEST.runtimeIamUser,
      application_name: "tibotattle-analytics-refresh", backend_type: "client backend", state: "active",
      wait_event_type: "IO", wait_event: "DataFileRead", sessions: 1 }, { role: "x", application_name: "psql 'private'",
      backend_type: "client backend", state: "idle", wait_event_type: null, wait_event: null, sessions: 2 }];
    return [];
  });
  const calls = [];
  const runner = measRunner(() => assert.fail("no gcloud"));
  const result = await stepMeasPgStat(runner, { measInstance: MEAS, label: "during-03", as: "migrator" },
    { createPool: snapshotPool(client, calls) });
  assert.deepEqual(calls, [{ instance: MEAS, as: "migrator", applicationName: "tibotattle-meas-pgstat" }, "closed"]);
  assert.equal(client.sent[0], "BEGIN READ ONLY");
  assert.equal(client.sent.at(-1), "ROLLBACK");
  for (const text of client.sent) {
    assert.match(text, /^(?:BEGIN READ ONLY|ROLLBACK|SET LOCAL statement_timeout|SAVEPOINT|RELEASE SAVEPOINT|SELECT )/u, text);
  }
  const receipt = runner.receipts["meas-pgstat-during-03.json"];
  assert.equal(result.path, "/receipts/meas-pgstat-during-03.json");
  const text = JSON.stringify(receipt);
  for (const leaked of ["person@example.com", "secret body", "it''s", "private", FASTPATH_TEST.runtimeIamUser,
    FASTPATH_TEST.migratorIamUser, "someone-else"]) {
    assert.equal(text.includes(leaked), false, leaked);
  }
  assert.deepEqual(receipt.statements.map(({ role, family, text: statementText }) => [role, family, statementText]), [
    ["runtime", "occurrences.load", "/* analytics_v2:occurrences.load */ SELECT x FROM t WHERE owner = $1 AND note = '?'"],
    ["migrator", null, "INSERT INTO t VALUES ('?', '?')"],
    ["other", null, "(hidden)"],
  ]);
  assert.deepEqual([receipt.statementsTotal, receipt.hiddenStatements, receipt.statements[0].shared_blk_read_time],
    [3, 1, 1.5]);
  assert.equal(Object.hasOwn(receipt.statements[0], "userid"), false);
  assert.deepEqual(receipt.database, { blks_read: 7, blks_hit: 70 });
  assert.deepEqual(receipt.sessions.map(({ role, application, waitEvent }) => [role, application, waitEvent]),
    [["other", "other", null], ["runtime", "tibotattle-analytics-refresh", "DataFileRead"]]);
  // A label is required and closed.
  for (const argv of [["meas-pgstat", `--meas-instance=${MEAS}`], ["meas-pgstat", `--meas-instance=${MEAS}`, "--label=A B"],
    ["meas-pgstat", `--meas-instance=${MEAS}`, "--label=x", "--as=postgres"]]) {
    await assert.rejects(main([...argv, "--dry-run", `--out=${join(tmpdir(), "fastpath-meas-args")}`]),
      (error) => error?.code === "FASTPATH_DEPLOY_ARGUMENT_INVALID", argv.join(" "));
  }
});

test("meas-pgstat-enable creates the extension on the measurement database only and fails when it cannot", async () => {
  const ok = snapshotClient((text) => (/FROM pg_extension/u.test(text) ? [{ extversion: "1.11" }] : []));
  const calls = [];
  const runner = measRunner(() => assert.fail("no gcloud"));
  const receipt = await stepMeasPgStatEnable(runner, { measInstance: MEAS }, { createPool: snapshotPool(ok, calls) });
  assert.deepEqual([receipt.extension, receipt.reset], ["1.11", true]);
  assert.deepEqual(ok.sent, ["SET statement_timeout = '60s'", "CREATE EXTENSION IF NOT EXISTS pg_stat_statements",
    "SELECT extversion FROM pg_extension WHERE extname = 'pg_stat_statements'", "SELECT pg_stat_statements_reset()"]);
  assert.deepEqual(calls[0], { instance: MEAS, as: "migrator", applicationName: "tibotattle-meas-pgstat" });
  const denied = snapshotClient((text) => (/CREATE EXTENSION/u.test(text)
    ? Object.assign(new Error("permission denied"), { code: "42501" }) : []));
  const failing = measRunner(() => assert.fail("no gcloud"));
  await assert.rejects(stepMeasPgStatEnable(failing, { measInstance: MEAS }, { createPool: snapshotPool(denied, []) }),
    (error) => error?.code === "FASTPATH_DEPLOY_MEAS_PGSTAT_UNAVAILABLE" && error.message.endsWith("42501"));
  assert.deepEqual(failing.receipts["meas-pgstat-enable.json"].sqlState, "42501");
  await assert.rejects(stepMeasPgStatEnable(failing, { measInstance: "tibotattle-primary" }),
    (error) => error?.code === "FASTPATH_DEPLOY_MEAS_INSTANCE_INVALID");
});

test("meas-metrics reads only the measurement Job's and instance's series in the test project, GET only", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    const metric = new URL(url).searchParams.get("filter");
    if (metric.includes("memory/utilizations")) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ timeSeries: [{
      resource: { type: "cloud_run_job", labels: { job_name: MEAS_JOB, location: "us-east1", instance_id: "abc123" } },
      metric: { labels: { state: "active" } },
      points: [{ interval: { endTime: "2026-10-04T00:02:00Z" }, value: { doubleValue: 0.5 } },
        { interval: { endTime: "2026-10-04T00:01:00Z" }, value: { distributionValue: { mean: 0.25 } } },
        { interval: { endTime: "2026-10-04T00:03:00Z" }, value: { int64Value: "1" } }] }] }) };
  };
  const runner = measRunner(() => assert.fail("no gcloud"));
  const result = await stepMeasMetrics(runner, { measInstance: MEAS, since: "2026-10-04T00:00:00Z",
    until: "2026-10-04T13:00:00Z" }, { token: () => "test-token-value", fetchImpl });
  assert.ok(requests.length >= 8);
  for (const { url, init } of requests) {
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, "https://monitoring.googleapis.com/v3/projects/tibotattle/timeSeries");
    assert.equal(init.method, "GET");
    assert.equal(init.headers.authorization, "Bearer test-token-value");
    const filter = parsed.searchParams.get("filter");
    assert.ok(filter.includes(`resource.labels.job_name = "${MEAS_JOB}"`)
      || filter.includes(`resource.labels.database_id = "tibotattle:${MEAS}"`), filter);
    assert.equal(url.includes("test-token-value"), false);
  }
  const receipt = runner.receipts["meas-metrics.json"];
  assert.equal(JSON.stringify(receipt).includes("test-token-value"), false);
  const cpu = receipt.metrics.find(({ metric, aligner }) => metric === "job-cpu-utilization" && aligner === "ALIGN_MEAN");
  assert.deepEqual([cpu.httpStatus, cpu.series[0].points, cpu.series[0].mean, cpu.series[0].max, cpu.series[0].first],
    [200, 3, 0.5833, 1, "2026-10-04T00:01:00Z"]);
  assert.deepEqual(cpu.series[0].resource, { job_name: MEAS_JOB, location: "us-east1" }, "only closed labels are kept");
  assert.equal(receipt.metrics.find(({ metric }) => metric === "job-memory-utilization").httpStatus, 404);
  assert.equal(result.metrics.length, requests.length);
  for (const argv of [["meas-metrics", `--meas-instance=${MEAS}`], ["meas-metrics", `--meas-instance=${MEAS}`,
    "--since=2026-10-04T00:00:00Z"], ["meas-metrics", `--meas-instance=${MEAS}`, "--since=yesterday",
    "--until=2026-10-04T00:00:00Z"]]) {
    await assert.rejects(main([...argv, "--dry-run", `--out=${join(tmpdir(), "fastpath-meas-args")}`]),
      (error) => error?.code === "FASTPATH_DEPLOY_ARGUMENT_INVALID", argv.join(" "));
  }
  await assert.rejects(stepMeasMetrics(runner, { measInstance: MEAS, since: "2026-10-04T13:00:00Z",
    until: "2026-10-04T00:00:00Z" }, { token: () => "t", fetchImpl }), (error) => error?.code === "MEAS_METRICS_WINDOW_INVALID");
});
