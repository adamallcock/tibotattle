#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import http from "node:http";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  countMigrationsAtCommit,
  EDGE_PROXY_SOURCE,
  executeJobCommand,
  FASTPATH_TEST,
  migrateJobCommand,
  ORIGIN_TEST_CLOCK_ENV,
  originClockEnv,
  originInvokerCommand,
  primarySchemaOf,
  refreshJobCommand,
  renderOriginService,
  validateOriginPolicy,
} from "./gcp-fastpath-test-deploy.mjs";
import {
  analyticsV2TestClock,
  FASTPATH_TEST_CLOUD_TARGET,
  fastpathTestDatabaseConfig,
} from "../cloud-run/origin-fastpath-mode.mjs";
import {
  parseAnalyticsRefreshArguments,
  resolveAnalyticsRefreshDatabase,
} from "../cloud-run/analytics-refresh.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = `${FASTPATH_TEST.imageRepository}@sha256:${"a".repeat(64)}`;
const PROOF = JSON.stringify({ bucket: FASTPATH_TEST.originBucket, bucketGeneration: "1",
  bucketMetageneration: "1", softDeleteRetentionDurationSeconds: "0" });

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

test("every write command targets only fast-path resources in the tibotattle project", () => {
  const commands = [
    migrateJobCommand({ image: IMAGE, expectedCounts: { primary: 61, ledger: 7 } }),
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
    expectedCounts: { primary: 61, ledger: 7 } }), "FASTPATH_DEPLOY_IMAGE_DIGEST_REQUIRED");
  expectCode(() => migrateJobCommand({ image: IMAGE, expectedCounts: { primary: 61 } }),
    "FASTPATH_DEPLOY_EXPECTED_COUNTS_INVALID");
});

test("migrate and refresh Jobs carry the exact database targets, identities and sizes", () => {
  const migrate = migrateJobCommand({ image: IMAGE, expectedCounts: { primary: 61, ledger: 7 } });
  const env = migrate.find((arg) => arg.startsWith("--set-env-vars="));
  for (const pair of [
    "PRIMARY_DATABASE=tibotattle_fastpath", "LEDGER_DATABASE=tibotattle_fastpath",
    "PRIMARY_SCHEMA=tibotattle_fastpath_20261001", "LEDGER_SCHEMA=tibotattle_fastpath_ledger_20261001",
    "PRIMARY_EXPECTED_MIGRATIONS=61", "LEDGER_EXPECTED_MIGRATIONS=7",
    "POSTGRES_MIGRATOR_IAM_USER=tibotattle-test-migrator@tibotattle.iam",
  ]) assert.equal(env.includes(pair), true, pair);
  assert.equal(migrate.includes(`--service-account=${FASTPATH_TEST.migratorServiceAccount}`), true);
  assert.equal(migrate.includes("--args=dist/test-migrations.mjs,--profile=fastpath"), true);

  const plain = refreshJobCommand({ image: IMAGE });
  assert.equal(plain.includes("--args=dist/analytics-refresh.mjs,--mode=full,--schema=tibotattle_fastpath_20261001"), true);
  assert.equal(plain.some((arg) => arg.includes("ANALYTICS_V2_TEST_CLOCK")), false);
  const clocked = refreshJobCommand({ image: IMAGE, now: "2026-10-01T00:00:00Z", extraEnv: [["EXTRA_FLAG", "1"]] });
  assert.equal(clocked.some((arg) => arg.endsWith(",--now=2026-10-01T00:00:00Z")), true);
  assert.equal(clocked.some((arg) => arg.includes("ANALYTICS_V2_TEST_CLOCK=1") && arg.includes("EXTRA_FLAG=1")), true);
  for (const flag of ["--cpu=2", "--memory=4Gi", "--task-timeout=3600s", "--max-retries=0",
    `--service-account=${FASTPATH_TEST.runtimeServiceAccount}`]) {
    assert.equal(clocked.includes(flag), true, flag);
  }
  expectCode(() => refreshJobCommand({ image: IMAGE, now: "yesterday" }), "FASTPATH_DEPLOY_NOW_INVALID");
  expectCode(() => refreshJobCommand({ image: IMAGE, extraArgs: ["--a,b"] }), "FASTPATH_DEPLOY_ARGS_INVALID");
  expectCode(() => refreshJobCommand({ image: IMAGE, extraEnv: [["bad-key", "1"]] }), "FASTPATH_DEPLOY_ENV_INVALID");
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
    for (const role of ["primary", "ledger"]) {
      const files = (await readdir(resolve(WORKER_ROOT, "postgres/migrations", role)))
        .filter((name) => /^\d{4}_[a-z][a-z0-9_-]*\.sql$/u.test(name));
      assert.equal(counts[role], files.length);
    }
  }
  assert.equal(counts.primary > 0 && counts.ledger > 0, true);
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
  assert.equal(refresh.some((arg) => arg.includes(`LEDGER_SCHEMA=${FASTPATH_TEST.ledgerSchema}`)), true);
  const origin = renderOriginService({ image: IMAGE, bucketHistoryProof: PROOF, schema: seeded });
  assert.match(origin, new RegExp(`name: PRIMARY_SCHEMA\\n {10}value: "${seeded}"`, "u"));
  const migrate = migrateJobCommand({ image: IMAGE, expectedCounts: { primary: 61, ledger: 7 } });
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
  for (const key of ["project", "instanceConnectionName", "database", "primarySchema", "ledgerSchema"]) {
    assert.equal(FASTPATH_TEST[key], FASTPATH_TEST_CLOUD_TARGET[key], key);
  }
  assert.equal(FASTPATH_TEST.refreshJob, FASTPATH_TEST_CLOUD_TARGET.refreshJob);
  assert.equal(FASTPATH_TEST.originService, FASTPATH_TEST_CLOUD_TARGET.originService);
  assert.equal(FASTPATH_TEST.runtimeIamUser, FASTPATH_TEST_CLOUD_TARGET.iamUser);

  const now = "2026-10-01T12:00:00.000Z";
  const seeded = "typed_legacy_transfer_rehearsal_target_fastpath_0a1b2c3d";
  // Origin: the clock the deploy sets is the one the composition root reads.
  assert.equal(ORIGIN_TEST_CLOCK_ENV, "ANALYTICS_V2_TEST_NOW_MS");
  const yaml = renderOriginService({ image: IMAGE, bucketHistoryProof: PROOF, schema: seeded,
    originEnv: originClockEnv([], now) });
  const env = { ...originContainerEnv(yaml), K_SERVICE: FASTPATH_TEST.originService };
  assert.equal(env.POSTGRES_TEST_HTTP_MODE, "fastpath-test");
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(analyticsV2TestClock(env, env.POSTGRES_TEST_HTTP_MODE)(), Date.parse(now));
  assert.equal("ANALYTICS_V2_TEST_NOW" in env || "ANALYTICS_V2_TEST_CLOCK" in env, false);
  const database = fastpathTestDatabaseConfig(env);
  assert.deepEqual([database.primary.database, database.primary.schema, database.ledger.database,
    database.ledger.schema], ["tibotattle_fastpath", seeded, "tibotattle_fastpath", FASTPATH_TEST.ledgerSchema]);
  assert.equal(originClockEnv([[ORIGIN_TEST_CLOCK_ENV, "1"]], now).length, 1, "an explicit value wins");
  expectCode(() => originClockEnv([], "yesterday"), "FASTPATH_DEPLOY_NOW_INVALID");

  // Refresh: the Job's args and env parse, take the test clock and reach only tibotattle_fastpath.
  const command = refreshJobCommand({ image: IMAGE, now: "2026-10-01T12:00:00Z", schema: seeded });
  const args = command.find((arg) => arg.startsWith("--args=")).slice("--args=".length).split(",").slice(1);
  const jobEnv = { ...commandEnv(command), CLOUD_RUN_JOB: FASTPATH_TEST.refreshJob };
  const parsed = parseAnalyticsRefreshArguments(args, jobEnv);
  assert.equal(parsed.schema, seeded);
  assert.equal(parsed.nowMs, Date.parse(now));
  assert.deepEqual({ ...await resolveAnalyticsRefreshDatabase(jobEnv, { schema: parsed.schema }) }, {
    kind: "cloud-sql", instanceConnectionName: FASTPATH_TEST.instanceConnectionName,
    database: "tibotattle_fastpath", iamUser: FASTPATH_TEST.runtimeIamUser,
  });
});
