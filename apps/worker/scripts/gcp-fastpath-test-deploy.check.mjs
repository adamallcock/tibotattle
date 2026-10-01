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
  originInvokerCommand,
  refreshJobCommand,
  renderOriginService,
  validateOriginPolicy,
} from "./gcp-fastpath-test-deploy.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = `${FASTPATH_TEST.imageRepository}@sha256:${"a".repeat(64)}`;
const PROOF = JSON.stringify({ bucket: FASTPATH_TEST.originBucket, bucketGeneration: "1",
  bucketMetageneration: "1", softDeleteRetentionDurationSeconds: "0" });

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

test("every write command targets only fast-path resources in the tibotattle project", () => {
  const commands = [
    migrateJobCommand({ image: IMAGE, expectedCounts: { primary: 59, ledger: 7 } }),
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
    expectedCounts: { primary: 59, ledger: 7 } }), "FASTPATH_DEPLOY_IMAGE_DIGEST_REQUIRED");
  expectCode(() => migrateJobCommand({ image: IMAGE, expectedCounts: { primary: 59 } }),
    "FASTPATH_DEPLOY_EXPECTED_COUNTS_INVALID");
});

test("migrate and refresh Jobs carry the exact database targets, identities and sizes", () => {
  const migrate = migrateJobCommand({ image: IMAGE, expectedCounts: { primary: 59, ledger: 7 } });
  const env = migrate.find((arg) => arg.startsWith("--set-env-vars="));
  for (const pair of [
    "PRIMARY_DATABASE=tibotattle_fastpath", "LEDGER_DATABASE=tibotattle_fastpath",
    "PRIMARY_SCHEMA=tibotattle_fastpath_20261001", "LEDGER_SCHEMA=tibotattle_fastpath_ledger_20261001",
    "PRIMARY_EXPECTED_MIGRATIONS=59", "LEDGER_EXPECTED_MIGRATIONS=7",
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
    originEnv: [["ANALYTICS_V2_TEST_NOW", "2026-10-01T00:00:00Z"]] });
  assert.doesNotMatch(direct, /- name: edge\n/u);
  assert.match(direct, /name: HOST_ORIGIN\n {10}value: "https:\/\/tibotattle-fastpath-test-origin-806510610397\.us-east1\.run\.app"/u);
  assert.match(direct, /name: ANALYTICS_V2_TEST_NOW\n/u);
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
