/**
 * Offline check of the OPS-2 bucket birth: a dry run by default, one insert
 * only under its exact authorization, refusal of an existing bucket (before
 * the insert from the listing, or from the insert's HTTP 409), a proof
 * receipt from the create response and an exact readback, and an access
 * token that never leaves the call. The runner and fetch are synthetic and
 * recorded; PATH is blanked, so no real gcloud can run.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as manifest from "./gcp-ops-infra-manifest.mjs";
import * as birth from "./gcp-ops-bucket-birth.mjs";
import { bornBucket } from "./fixtures/gcp-ops-infra/fake-gcloud.mjs";

process.env.PATH = "/nonexistent-gcloud-guard";

const SCRIPTS_ROOT = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(SCRIPTS_ROOT, "fixtures/gcp-ops-infra/desired-state.synthetic.json"), "utf8"));
const TOKEN = "synthetic-access-token-MARKER-7c2d";
const CREATED_AT = "2026-10-02T00:00:00.000Z";

function desiredState({ synthetic = false, proof = null } = {}) {
  let value = structuredClone(FIXTURE);
  if (!synthetic) value = JSON.parse(JSON.stringify(value).replaceAll("synthetic-ops-project", "example-ops-prod1"));
  value.bucket.proof = proof;
  return manifest.validateDesiredState(value);
}

function createdBucket(desired, extra = {}) {
  return bornBucket({ name: desired.bucket.name, location: desired.bucket.location,
    extra: { timeCreated: CREATED_AT, softDeletePolicy: { retentionDurationSeconds: "0" }, ...extra } });
}

/** A recording runner: bucket listings before and after the insert, and the token. */
function harness(desired, { existing = false, readback, token = TOKEN, response } = {}) {
  const calls = [];
  const requests = [];
  let inserted = false;
  const runner = (argv) => {
    calls.push([...argv]);
    if (argv[0] === "auth" && argv[1] === "print-access-token") return { status: 0, stdout: `${token}\n` };
    if (argv.slice(0, 3).join(" ") === "storage buckets list") {
      const buckets = existing || inserted ? [readback ?? createdBucket(desired)] : [];
      return { status: 0, stdout: JSON.stringify(buckets) };
    }
    return { status: 2, stdout: "" };
  };
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    inserted = true;
    if (response !== undefined) return response();
    return new Response(JSON.stringify(createdBucket(desired)), { status: 200 });
  };
  return { calls, requests, runner, fetchImpl };
}

test("the default is a dry run that makes no call and shows the one insert", async () => {
  const desired = desiredState({ synthetic: true });
  const run = harness(desired);
  const result = await birth.runBucketBirth(desired, { runner: run.runner, fetchImpl: run.fetchImpl });
  assert.equal(result.status, "dry_run");
  assert.equal(result.authorization, "bucket-birth:synthetic-ops-project:synthetic-ops-quarantine");
  assert.deepEqual(result.request, {
    method: "POST",
    url: "https://storage.googleapis.com/storage/v1/b?project=synthetic-ops-project",
    body: manifest.bucketInsertBody(desired),
  });
  assert.equal(result.request.body.softDeletePolicy.retentionDurationSeconds, "0");
  assert.equal(Object.hasOwn(result.request.body, "lifecycle"), false);
  assert.equal(run.calls.length, 0);
  assert.equal(run.requests.length, 0);
});

test("apply refuses the synthetic fixture, a wrong authorization and a pinned proof before any call", async () => {
  const cases = [
    [desiredState({ synthetic: true }), "bucket-birth:synthetic-ops-project:synthetic-ops-quarantine",
      "BUCKET_BIRTH_SYNTHETIC_TARGET_REFUSED"],
    [desiredState(), undefined, "BUCKET_BIRTH_AUTHORIZATION_MISMATCH"],
    [desiredState(), "bucket-birth:example-ops-prod1:other-bucket", "BUCKET_BIRTH_AUTHORIZATION_MISMATCH"],
    [desiredState(), "a".repeat(64), "BUCKET_BIRTH_AUTHORIZATION_MISMATCH"],
    [desiredState({ proof: { bucketGeneration: "1700000000000001", bucketMetageneration: "1" } }),
      "bucket-birth:example-ops-prod1:synthetic-ops-quarantine", "BUCKET_BIRTH_PROOF_ALREADY_PINNED"],
  ];
  for (const [desired, authorize, code] of cases) {
    const run = harness(desired);
    await assert.rejects(birth.runBucketBirth(desired, { apply: true, authorize, runner: run.runner,
      fetchImpl: run.fetchImpl }), { code }, code);
    assert.equal(run.calls.length, 0, code);
    assert.equal(run.requests.length, 0, code);
  }
  const desired = desiredState();
  await assert.rejects(birth.runBucketBirth(desired, { apply: true, authorize: birth.bucketBirthAuthorization(desired),
    receiptPath: "relative.json", runner: harness(desired).runner }), { code: "BUCKET_BIRTH_RECEIPT_PATH_INVALID" });
});

test("an existing bucket is refused from the listing, with no token and no insert", async () => {
  const desired = desiredState();
  const run = harness(desired, { existing: true });
  await assert.rejects(birth.runBucketBirth(desired, { apply: true, authorize: birth.bucketBirthAuthorization(desired),
    runner: run.runner, fetchImpl: run.fetchImpl }), { code: "BUCKET_BIRTH_BUCKET_EXISTS" });
  assert.deepEqual(run.calls, [["storage", "buckets", "list", "--project=example-ops-prod1", "--raw", "--format=json"]]);
  assert.equal(run.requests.length, 0);
});

test("an insert answered 409 is refused as an existing bucket; other failures are named", async () => {
  const desired = desiredState();
  const authorize = birth.bucketBirthAuthorization(desired);
  const conflict = harness(desired, { response: () => new Response("{\"error\":{\"code\":409,\"message\":\"MARKER-9a0b\"}}",
    { status: 409 }) });
  await assert.rejects(birth.runBucketBirth(desired, { apply: true, authorize, runner: conflict.runner,
    fetchImpl: conflict.fetchImpl }), (error) => error.code === "BUCKET_BIRTH_BUCKET_EXISTS"
      && !error.message.includes("MARKER"));
  assert.equal(conflict.requests.length, 1);
  for (const [response, code] of [
    [() => new Response("{}", { status: 403 }), "BUCKET_BIRTH_CREATE_FAILED"],
    [() => new Response("{}", { status: 302, headers: { location: "https://example.invalid/" } }),
      "BUCKET_BIRTH_CREATE_FAILED"],
    [() => { throw new Error("MARKER network"); }, "BUCKET_BIRTH_REQUEST_FAILED"],
    [() => new Response("not json", { status: 200 }), "BUCKET_BIRTH_RESPONSE_INVALID"],
    [() => new Response(JSON.stringify(createdBucket(desired, { lifecycle: { rule: [] } })), { status: 200 }),
      "BUCKET_BIRTH_RESPONSE_INVALID"],
    [() => new Response(JSON.stringify(createdBucket(desired, { softDeletePolicy: { retentionDurationSeconds: "604800" } })),
      { status: 200 }), "BUCKET_BIRTH_RESPONSE_INVALID"],
  ]) {
    const run = harness(desired, { response });
    await assert.rejects(birth.runBucketBirth(desired, { apply: true, authorize, runner: run.runner,
      fetchImpl: run.fetchImpl }), (error) => error.code === code && !error.message.includes("MARKER"), code);
  }
  for (const token of ["", "two words", "x".repeat(8_193)]) {
    const run = harness(desired, { token });
    await assert.rejects(birth.runBucketBirth(desired, { apply: true, authorize, runner: run.runner,
      fetchImpl: run.fetchImpl }), { code: "BUCKET_BIRTH_AUTH_UNAVAILABLE" });
    assert.equal(run.requests.length, 0);
  }
});

test("one authorized insert yields the proof receipt, and the token never leaves the call", async () => {
  const desired = desiredState();
  const run = harness(desired);
  const written = [];
  const result = await birth.runBucketBirth(desired, {
    apply: true,
    authorize: birth.bucketBirthAuthorization(desired),
    receiptPath: "/synthetic/receipt.json",
    runner: run.runner,
    fetchImpl: run.fetchImpl,
    writeReceipt: async (path, receipt) => { written.push({ path, receipt }); },
  });
  assert.equal(result.status, "created");
  assert.equal(run.requests.length, 1);
  const [request] = run.requests;
  assert.equal(request.url, "https://storage.googleapis.com/storage/v1/b?project=example-ops-prod1");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.redirect, "manual");
  assert.equal(request.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(request.init.body), manifest.bucketInsertBody(desired));
  assert.deepEqual(run.calls, [
    ["storage", "buckets", "list", "--project=example-ops-prod1", "--raw", "--format=json"],
    ["auth", "print-access-token", "--project=example-ops-prod1"],
    ["storage", "buckets", "list", "--project=example-ops-prod1", "--raw", "--format=json"],
  ]);
  const { receipt } = result;
  assert.equal(receipt.schemaVersion, "tibotattle-gcp-bucket-birth-v1");
  assert.deepEqual(receipt.proof, {
    bucket: "synthetic-ops-quarantine",
    bucketGeneration: "1700000000000001",
    bucketMetageneration: "1",
    softDeleteRetentionDurationSeconds: "0",
  });
  assert.equal(receipt.creationResponse.timeCreated, CREATED_AT);
  assert.match(receipt.creationRequestSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(written, [{ path: "/synthetic/receipt.json", receipt }]);
  for (const value of [result, run.calls, written]) assert.equal(JSON.stringify(value).includes(TOKEN), false);
  // The receipt's proof is what the owner pins; with it the plan sees no stale proof.
  const pinned = desiredState({ proof: { bucketGeneration: receipt.proof.bucketGeneration,
    bucketMetageneration: receipt.proof.bucketMetageneration } });
  assert.deepEqual(pinned.bucket.proof, { bucketGeneration: "1700000000000001", bucketMetageneration: "1" });
});

test("a readback that differs from the insert is refused", async () => {
  const desired = desiredState();
  const authorize = birth.bucketBirthAuthorization(desired);
  for (const readback of [
    createdBucket(desired, { metageneration: "2" }),
    createdBucket(desired, { generation: "1700000000000009" }),
    createdBucket(desired, { timeCreated: "2026-10-02T00:00:01.000Z" }),
  ]) {
    const run = harness(desired, { readback });
    await assert.rejects(birth.runBucketBirth(desired, { apply: true, authorize, runner: run.runner,
      fetchImpl: run.fetchImpl }), { code: "BUCKET_BIRTH_READBACK_MISMATCH" });
  }
  assert.throws(() => birth.bucketBirthSnapshot({ ...createdBucket(desired), projectNumber: "200000000002" }, desired),
    { code: "BUCKET_BIRTH_RESPONSE_INVALID" });
  assert.throws(() => birth.bucketBirthSnapshot({ ...createdBucket(desired), retentionPolicy: { retentionPeriod: "1" } },
    desired), { code: "BUCKET_BIRTH_RESPONSE_INVALID" });
});

test("the receipt file is written once, owner-only, and never over an existing file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gcp-ops-bucket-birth-"));
  try {
    const path = join(directory, "receipt.json");
    const receipt = { schemaVersion: "tibotattle-gcp-bucket-birth-v1", proof: { bucketMetageneration: "1" } };
    await birth.writeBucketBirthReceipt(path, receipt);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), receipt);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(birth.writeBucketBirthReceipt(path, receipt), { code: "BUCKET_BIRTH_RECEIPT_WRITE_FAILED" });
    await assert.rejects(birth.writeBucketBirthReceipt("relative.json", receipt), { code: "BUCKET_BIRTH_RECEIPT_PATH_INVALID" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the module never updates, deletes or reads the IAM policy of a bucket", () => {
  const source = readFileSync(join(SCRIPTS_ROOT, "gcp-ops-bucket-birth.mjs"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
  assert.doesNotMatch(code, /"PATCH"|"PUT"|"DELETE"|iam-policy|setIamPolicy|getIamPolicy|spawnSync|execSync|shell:/u);
  // The request description and the one fetch: both a POST insert.
  assert.deepEqual([...code.matchAll(/method: "([A-Z]+)"/gu)].map((match) => match[1]), ["POST", "POST"]);
  assert.equal([...code.matchAll(/await fetchImpl\(/gu)].length, 1);
});
