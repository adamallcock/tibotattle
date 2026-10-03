#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import {
  countMigrationsAtCommit,
  EDGE_PROXY_SOURCE,
  EDGE_TEST_PRODUCTION_SETTINGS,
  EDGE_TEST_UNMIRRORED_SETTINGS,
  edgeTestProductionEnv,
  ensureOriginBucketRuntimeBinding,
  executeJobCommand,
  FASTPATH_CORPORA,
  FASTPATH_TEST,
  main,
  migrateJobCommand,
  ORIGIN_BUCKET_RUNTIME_BINDING,
  originBucketBindingCommand,
  originBucketPolicyCommand,
  ORIGIN_TEST_CLOCK_ENV,
  originClockEnv,
  originInvokerCommand,
  originSourceEnv,
  primarySchemaOf,
  REFRESH_JOB_PROFILES,
  REFRESH_JOB_RESOURCES,
  refreshJobCommand,
  renderOriginService,
  stepsReadGolden,
  validateOriginBucketPolicy,
  validateOriginPolicy,
} from "./gcp-fastpath-test-deploy.mjs";
import { readSeedGolden } from "./gcp-fastpath-seed.mjs";
import { DIGEST_ONLY_GOLDEN_SOURCE, withDigestOnlyGolden } from "../analytics-v2-test/fixtures/digest-only-golden.mjs";
import {
  analyticsV2TestClock,
  FASTPATH_TEST_CLOUD_TARGET,
  fastpathTestDatabaseConfig,
} from "../cloud-run/origin-fastpath-mode.mjs";
import { GCP_FASTPATH_REHEARSAL_REFRESH_HEAP_MIB } from "./gcp-fastpath-rehearsal.mjs";
import { GCP_FASTPATH_SEED } from "./gcp-fastpath-seed.mjs";
import {
  ANALYTICS_REFRESH_WORKER_HEAP_RESERVE_BYTES,
  analyticsRefreshResources,
  parseAnalyticsRefreshArguments,
  resolveAnalyticsRefreshDatabase,
} from "../cloud-run/analytics-refresh.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = `${FASTPATH_TEST.imageRepository}@sha256:${"a".repeat(64)}`;
const PROOF = JSON.stringify({ bucket: FASTPATH_TEST.originBucket, bucketGeneration: "1",
  bucketMetageneration: "1", softDeleteRetentionDurationSeconds: "0" });
const SOURCE = Object.freeze({ sourceId: "synthetic-source", sourceNamespace: "synthetic-namespace" });

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
    "--args=--max-old-space-size=6144,dist/analytics-refresh.mjs,--mode=full,--schema=tibotattle_fastpath_20261001"), true);
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
  const heapLimit = (REFRESH_JOB_RESOURCES.heapMiB + 48) * MIB;
  assert.ok(analyticsRefreshResources({}, heapLimit).requiredHeapBytes <= REFRESH_JOB_RESOURCES.heapMiB * MIB,
    "the default budget plus reserve fits the Job's old-space size");
  assert.equal(GCP_FASTPATH_REHEARSAL_REFRESH_HEAP_MIB, REFRESH_JOB_RESOURCES.heapMiB, "the rehearsal runs the Job's heap");
  expectCode(() => refreshJobCommand({ image: IMAGE, now: "yesterday" }), "FASTPATH_DEPLOY_NOW_INVALID");
  expectCode(() => refreshJobCommand({ image: IMAGE, extraArgs: ["--a,b"] }), "FASTPATH_DEPLOY_ARGS_INVALID");
  expectCode(() => refreshJobCommand({ image: IMAGE, extraEnv: [["bad-key", "1"]] }), "FASTPATH_DEPLOY_ENV_INVALID");
});

test("refresh profiles: the standard Job stays the default; the dense Jobs are 4 vCPU, 16 GiB with a fitting budget", () => {
  assert.equal(REFRESH_JOB_RESOURCES, REFRESH_JOB_PROFILES.standard);
  assert.deepEqual(Object.keys(REFRESH_JOB_PROFILES), ["standard", "dense", "dense-workers"]);
  assert.deepEqual(refreshJobCommand({ image: IMAGE }), refreshJobCommand({ image: IMAGE, profile: "standard" }));
  const dense = refreshJobCommand({ image: IMAGE, now: "2026-10-01T12:46:00Z", profile: "dense" });
  for (const flag of ["--cpu=4", "--memory=16Gi", "--task-timeout=14400s", "--max-retries=0"]) {
    assert.equal(dense.includes(flag), true, flag);
  }
  // The dense profile is the production profile: inline (no --workers).
  assert.equal(dense.some((arg) => arg.startsWith("--args=--max-old-space-size=12288,dist/analytics-refresh.mjs,")
    && !arg.includes("--workers")), true);
  // dense-workers is the MEAS-3 measurement of the compute Workers (K-PAR):
  // the same task and budget, a 3,072 MiB main heap and four Workers.
  const workers = refreshJobCommand({ image: IMAGE, now: "2026-10-01T12:46:00Z", profile: "dense-workers" });
  for (const flag of ["--cpu=4", "--memory=16Gi", "--task-timeout=14400s", "--max-retries=0"]) {
    assert.equal(workers.includes(flag), true, flag);
  }
  assert.equal(workers.some((arg) => arg.startsWith("--args=--max-old-space-size=3072,dist/analytics-refresh.mjs,")
    && arg.endsWith(",--workers=4")), true);
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
    const resources = analyticsRefreshResources(env, (profile.heapMiB + 48) * MIB, { workers: profile.workers });
    assert.ok(resources.requiredHeapBytes <= profile.heapMiB * MIB, name);
    // ...and Cloud Run's memory holds the heap, the compute Workers' heap
    // limits (K-PAR: together at most the budget plus one reserve; inline the
    // budget is inside the heap) plus at least 1 GiB of native memory.
    const workerMiB = profile.workers > 1
      ? resources.compute.memoryBudgetBytes / MIB + ANALYTICS_REFRESH_WORKER_HEAP_RESERVE_BYTES / MIB : 0;
    assert.ok(Number.parseInt(profile.memory, 10) * 1024 - profile.heapMiB - workerMiB >= 1_024, name);
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
  // node's own flag (the heap) comes before the script; the job parses what follows it.
  const nodeArgs = command.find((arg) => arg.startsWith("--args=")).slice("--args=".length).split(",");
  assert.deepEqual(nodeArgs.slice(0, 2), ["--max-old-space-size=6144", "dist/analytics-refresh.mjs"]);
  const args = nodeArgs.slice(2);
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
    ACCOUNTLESS_OWNERSHIP_MODE: "enabled", SIGN_IN_START_MAX_PER_MINUTE: production.SIGN_IN_START_MAX_PER_MINUTE });
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

test("a dry-run origin step prints the bucket binding before the origin is deployed and writes nothing remote", async () => {
  const out = await mkdtemp(join(tmpdir(), "fastpath-deploy-dry-"));
  const printed = [];
  const { error: printError, log: printLog } = console;
  console.error = (line) => printed.push(String(line));
  console.log = () => {};
  try {
    const report = await main(["origin", "--dry-run", `--image=${IMAGE}`, `--schema=${FASTPATH_TEST.primarySchema}`,
      `--out=${out}`]);
    assert.deepEqual({ ...report.steps[0].bucketBinding }, { role: CLEANUP_ROLE, member: RUNTIME_MEMBER,
      conditionTitle: "TiboTattleFastpathTelemetry", added: false });
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

test("an origin-only run over a seeded schema renders the source of the --dump a digest-only golden pins", async () => {
  await withDigestOnlyGolden(async ({ golden, dump }) => {
    const out = await mkdtemp(join(tmpdir(), "fastpath-deploy-dump-"));
    try {
      const argv = ["origin", "--dry-run", `--image=${IMAGE}`, `--golden=${golden}`, `--schema=${SEEDED}`,
        `--out=${out}`];
      const refused = await capturedMain(argv);
      assert.equal(refused.error?.code, "GCP_FASTPATH_SEED_DUMP_REQUIRED");
      assert.deepEqual(refused.printed, []);
      const { report, error } = await capturedMain([...argv, `--dump=${dump}`]);
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
