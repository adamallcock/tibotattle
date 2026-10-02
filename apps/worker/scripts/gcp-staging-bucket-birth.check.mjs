/**
 * Offline check of the staging bucket-birth flow (STG-PREP) and of the
 * staging desired-state pins: a dry run that makes no call, one OPS-2 bucket
 * insert under its exact authorization with the receipt at its committed
 * path, a receipt verified against the committed staging desired state, and
 * a proof pinned by an exact, validated one-line edit. The runner and fetch
 * are synthetic and recorded; PATH is blanked, so no real gcloud can run.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../src/canonical-json.ts";
import * as birth from "./gcp-ops-bucket-birth.mjs";
import * as manifest from "./gcp-ops-infra-manifest.mjs";
import * as flow from "./gcp-staging-bucket-birth.mjs";
import * as pins from "./gcp-staging-desired-state.mjs";
import { bornBucket } from "./fixtures/gcp-ops-infra/fake-gcloud.mjs";
import { unpinnedStagingText } from "./fixtures/gcp-ops-infra/staging-unpinned.mjs";

process.env.PATH = "/nonexistent-gcloud-guard";

const SCRIPTS_ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(SCRIPTS_ROOT, "..");
const COMMITTED_STAGING_TEXT = readFileSync(join(WORKER_ROOT, "cloud-run/infra/staging.desired-state.json"), "utf8");
// The committed file before its pins, so these checks hold once the pins are committed too.
const STAGING_TEXT = unpinnedStagingText(COMMITTED_STAGING_TEXT);
const PRODUCTION_TEXT = readFileSync(join(WORKER_ROOT, "cloud-run/infra/production.desired-state.json"), "utf8");
const TOKEN = "synthetic-access-token-MARKER-51d0";
const GENERATION = "1759363200000001";
const AUTHORIZE = "bucket-birth:tibotattle:tibotattle-staging-quarantine";

function staging(mutate = () => {}) {
  const value = JSON.parse(STAGING_TEXT);
  mutate(value);
  return manifest.assertCommittedDesiredState(manifest.validateDesiredState(value));
}

function created(desired, extra = {}) {
  return bornBucket({ name: desired.bucket.name, location: desired.bucket.location, generation: GENERATION,
    extra: { projectNumber: desired.projectNumber, timeCreated: "2026-10-02T12:00:00.000Z",
      softDeletePolicy: { retentionDurationSeconds: "0" }, ...extra } });
}

function receiptFor(desired) {
  return JSON.parse(JSON.stringify(birth.createBucketBirthReceipt(desired, {
    createResponse: created(desired), readbackResponse: created(desired) })));
}

/** A recording gcloud runner and fetch: listings before and after the one insert, and a token. */
function harness(desired, { existing = false, readbackMissing = false, createBody } = {}) {
  const calls = [];
  const requests = [];
  let inserted = false;
  const runner = (argv) => {
    calls.push([...argv]);
    if (argv[0] === "auth" && argv[1] === "print-access-token") return { status: 0, stdout: `${TOKEN}\n` };
    if (argv.slice(0, 3).join(" ") === "storage buckets list") {
      return { status: 0, stdout: JSON.stringify((existing || inserted) && !readbackMissing ? [created(desired)] : []) };
    }
    return { status: 2, stdout: "" };
  };
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), method: init.method });
    inserted = true;
    return new Response(createBody ?? JSON.stringify(created(desired)), { status: 200 });
  };
  return { calls, requests, runner, fetchImpl };
}

function memoryStore(text = STAGING_TEXT) {
  const store = { text, writes: 0 };
  store.readFile = () => store.text;
  store.writeFile = (next) => { store.text = next; store.writes += 1; };
  return store;
}

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "gcp-staging-bucket-birth-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("arguments are closed: staging only, a dry run by default, apply only with its authorization", () => {
  assert.deepEqual({ ...flow.parseStagingBucketBirthArgs(["--environment=staging"]) }, { mode: "dry-run", authorize: null });
  assert.deepEqual({ ...flow.parseStagingBucketBirthArgs(["--environment=staging", "--apply", `--authorize=${AUTHORIZE}`]) },
    { mode: "apply", authorize: AUTHORIZE });
  assert.equal(flow.parseStagingBucketBirthArgs(["--environment=staging", "--pin-only"]).mode, "pin-only");
  assert.equal(flow.parseStagingBucketBirthArgs(["--verify", "--environment=staging"]).mode, "verify");
  for (const [argv, code] of [
    [[], "STAGING_BUCKET_BIRTH_ENVIRONMENT_REFUSED"],
    [["--environment=production"], "STAGING_BUCKET_BIRTH_ENVIRONMENT_REFUSED"],
    [["--environment=staging", "--apply"], "BUCKET_BIRTH_AUTHORIZATION_MISMATCH"],
    [["--environment=staging", `--authorize=${AUTHORIZE}`], "BUCKET_BIRTH_AUTHORIZATION_MISMATCH"],
    [["--environment=staging", "--pin-only", `--authorize=${AUTHORIZE}`], "BUCKET_BIRTH_AUTHORIZATION_MISMATCH"],
    [["--environment=staging", "--apply", "--verify", `--authorize=${AUTHORIZE}`], "STAGING_BUCKET_BIRTH_ARGUMENT_INVALID"],
    [["--environment=staging", "--receipt-out=/tmp/x"], "STAGING_BUCKET_BIRTH_ARGUMENT_INVALID"],
    [["--environment=staging", "--authorize="], "STAGING_BUCKET_BIRTH_ARGUMENT_INVALID"],
  ]) {
    assert.throws(() => flow.parseStagingBucketBirthArgs(argv), { code }, argv.join(" "));
  }
});

test("the dry run makes no call and names the insert, the authorization and the committed receipt path", async () => {
  const desired = staging();
  const run = harness(desired);
  let out = "";
  const code = await flow.main(["--environment=staging"], { runner: run.runner, fetchImpl: run.fetchImpl,
    loadDesired: () => desired, stdout: (text) => { out += text; } });
  assert.equal(code, 0);
  assert.deepEqual([run.calls.length, run.requests.length], [0, 0]);
  const dry = JSON.parse(out);
  assert.equal(dry.status, "dry_run");
  assert.equal(dry.authorization, AUTHORIZE);
  assert.equal(dry.receiptFile, "cloud-run/infra/staging.bucket-birth.receipt.json");
  assert.deepEqual(dry.request.body, manifest.bucketInsertBody(desired));
  assert.equal(dry.request.body.location, "US-EAST1");
  assert.equal(dry.proofPinned, false);
  assert.equal(flow.stagingBucketBirthReceiptPath(), join(WORKER_ROOT, flow.STAGING_BUCKET_BIRTH_RECEIPT_FILE));
});

test("the committed staging proof and the committed receipt agree: both absent, or both present and equal", async () => {
  const committed = manifest.loadCommittedDesiredState("staging");
  if (!existsSync(flow.stagingBucketBirthReceiptPath())) {
    assert.equal(committed.bucket.proof, null, "a pinned proof needs its committed receipt");
    return;
  }
  const verified = await flow.runStagingBucketBirth(committed, { mode: "verify" });
  assert.equal(verified.status, "verified");
  assert.deepEqual(verified.proof, committed.bucket.proof);
});

test("apply inserts once, writes the receipt and pins its proof by a one-line edit", async () => {
  const desired = staging();
  await withDirectory(async (directory) => {
    const receiptPath = join(directory, "staging.bucket-birth.receipt.json");
    const run = harness(desired);
    const store = memoryStore();
    const result = await flow.runStagingBucketBirth(desired, { mode: "apply", authorize: AUTHORIZE, receiptPath,
      runner: run.runner, fetchImpl: run.fetchImpl, pinStore: store });
    assert.equal(result.status, "created_and_pinned");
    assert.deepEqual(result.proof, { bucketGeneration: GENERATION, bucketMetageneration: "1" });
    assert.equal(run.requests.length, 1);
    assert.equal(run.requests[0].url, "https://storage.googleapis.com/storage/v1/b?project=tibotattle");
    // The receipt verifies against the committed desired state, and holds no token.
    const receiptText = await readFile(receiptPath, "utf8");
    assert.doesNotMatch(receiptText, /MARKER/u);
    assert.deepEqual(flow.verifyStagingBucketBirthReceipt(JSON.parse(receiptText), desired), result.proof);
    // Only the proof line moved, and the result validates as the committed staging file.
    const before = STAGING_TEXT.split("\n");
    const after = store.text.split("\n");
    assert.equal(after.length, before.length);
    const changed = after.filter((line, index) => line !== before[index]);
    assert.deepEqual(changed, [`    "proof": { "bucketGeneration": "${GENERATION}", "bucketMetageneration": "1" }`]);
    const pinned = pins.validateStagingDesiredStateText(store.text).desired;
    assert.deepEqual(pinned.bucket.proof, result.proof);
    assert.equal(manifest.serviceTemplateBlocker(pinned), "STAGING_ORIGIN_UNASSIGNED:stagingOrigin.accessAud");
    // --verify agrees; a rerun refuses at the reserved receipt, with no insert.
    const verified = await flow.runStagingBucketBirth(pinned, { mode: "verify", receiptPath });
    assert.equal(verified.status, "verified");
    const again = harness(desired);
    await assert.rejects(flow.runStagingBucketBirth(desired, { mode: "apply", authorize: AUTHORIZE, receiptPath,
      runner: again.runner, fetchImpl: again.fetchImpl, pinStore: memoryStore() }), { code: "BUCKET_BIRTH_RECEIPT_PATH_UNAVAILABLE" });
    assert.deepEqual([again.calls.length, again.requests.length], [0, 0]);
  });
});

test("apply refuses a wrong authorization, an existing bucket, a pinned proof and production, with no insert", async () => {
  const desired = staging();
  await withDirectory(async (directory) => {
    for (const [target, authorize, options, code] of [
      [desired, "bucket-birth:tibotattle:tibotattle-quarantine", {}, "BUCKET_BIRTH_AUTHORIZATION_MISMATCH"],
      [desired, AUTHORIZE, { existing: true }, "BUCKET_BIRTH_BUCKET_EXISTS"],
      [staging((value) => { value.bucket.proof = { bucketGeneration: GENERATION, bucketMetageneration: "1" }; }), AUTHORIZE, {},
        "BUCKET_BIRTH_PROOF_ALREADY_PINNED"],
    ]) {
      const run = harness(target, options);
      const receiptPath = join(directory, `${code}.json`);
      await assert.rejects(flow.runStagingBucketBirth(target, { mode: "apply", authorize, receiptPath, runner: run.runner,
        fetchImpl: run.fetchImpl, pinStore: memoryStore() }), { code }, code);
      assert.equal(run.requests.length, 0, code);
      assert.equal(existsSync(receiptPath), false, code);
    }
    const production = { ...desired, environment: "production" };
    await assert.rejects(flow.runStagingBucketBirth(production, { mode: "dry-run" }),
      { code: "STAGING_BUCKET_BIRTH_ENVIRONMENT_REFUSED" });
  });
});

test("a pin that fails after the insert keeps the receipt and says so; --pin-only finishes it", async () => {
  const desired = staging();
  await withDirectory(async (directory) => {
    const receiptPath = join(directory, "receipt.json");
    const run = harness(desired);
    // The file was edited by hand meanwhile: the pin refuses to move it.
    const store = memoryStore(STAGING_TEXT.replace("\"proof\": null",
      "\"proof\": { \"bucketGeneration\": \"9\", \"bucketMetageneration\": \"1\" }"));
    let err = "";
    const code = await flow.main(["--environment=staging", "--apply", `--authorize=${AUTHORIZE}`], {
      loadDesired: () => desired, runner: run.runner, fetchImpl: run.fetchImpl, receiptPath, pinStore: store,
      stdout: () => {}, stderr: (text) => { err += text; } });
    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(err), { status: "error", code: "STAGING_BUCKET_PROOF_ALREADY_PINNED", bucketInserted: true,
      receiptWritten: true, receiptPrinted: false, receiptFile: "cloud-run/infra/staging.bucket-birth.receipt.json" });
    assert.equal(store.writes, 0);
    assert.equal(existsSync(receiptPath), true);
    // With the hand edit reverted, --pin-only pins from the receipt, and a second run is a no-op.
    const fresh = memoryStore();
    const pinned = await flow.runStagingBucketBirth(desired, { mode: "pin-only", receiptPath, pinStore: fresh });
    assert.equal(pinned.status, "pinned");
    assert.equal(fresh.writes, 1);
    const repeat = await flow.runStagingBucketBirth(pins.validateStagingDesiredStateText(fresh.text).desired,
      { mode: "pin-only", receiptPath, pinStore: fresh });
    assert.equal(repeat.status, "already_pinned");
    assert.equal(fresh.writes, 1);
  });
});

test("after the insert, stderr always says where the proof is: printed, or lost", async () => {
  const desired = staging();
  await withDirectory(async (directory) => {
    // The receipt file cannot be written: stdout carries the receipt to save, then --pin-only.
    const unwrittenPath = join(directory, "unwritten.json");
    const run = harness(desired);
    let out = "";
    let err = "";
    const reserveReceipt = async () => Object.freeze({
      async write() { throw new manifest.GcpOpsInfraError("BUCKET_BIRTH_RECEIPT_WRITE_FAILED"); },
      async release() {},
    });
    assert.equal(await flow.main(["--environment=staging", "--apply", `--authorize=${AUTHORIZE}`], {
      loadDesired: () => desired, runner: run.runner, fetchImpl: run.fetchImpl, receiptPath: unwrittenPath, reserveReceipt,
      pinStore: memoryStore(), stdout: (text) => { out += text; }, stderr: (text) => { err += text; } }), 1);
    assert.deepEqual(JSON.parse(err), { status: "error", code: "BUCKET_BIRTH_RECEIPT_WRITE_FAILED", bucketInserted: true,
      receiptWritten: false, receiptPrinted: true });
    const printed = JSON.parse(out);
    assert.equal(printed.status, "created_receipt_unwritten");
    assert.deepEqual(flow.verifyStagingBucketBirthReceipt(printed.receipt, desired),
      { bucketGeneration: GENERATION, bucketMetageneration: "1" });
    // The bucket was born but no receipt exists: both false, nothing on stdout, nothing to pin from.
    for (const [options, code] of [
      [{ readbackMissing: true }, "BUCKET_BIRTH_READBACK_MISSING"],
      [{ createBody: "{not json" }, "BUCKET_BIRTH_RESPONSE_INVALID"],
    ]) {
      const lostPath = join(directory, `${code}.json`);
      const lost = harness(desired, options);
      const store = memoryStore();
      let lostOut = "";
      let lostErr = "";
      assert.equal(await flow.main(["--environment=staging", "--apply", `--authorize=${AUTHORIZE}`], {
        loadDesired: () => desired, runner: lost.runner, fetchImpl: lost.fetchImpl, receiptPath: lostPath, pinStore: store,
        stdout: (text) => { lostOut += text; }, stderr: (text) => { lostErr += text; } }), 1, code);
      assert.equal(lost.requests.length, 1, code);
      assert.deepEqual(JSON.parse(lostErr), { status: "error", code, bucketInserted: true, receiptWritten: false,
        receiptPrinted: false }, code);
      assert.equal(lostOut, "", code);
      assert.equal(existsSync(lostPath), false, code);
      assert.equal(store.writes, 0, code);
      await assert.rejects(flow.runStagingBucketBirth(desired, { mode: "pin-only", receiptPath: lostPath, pinStore: store }),
        { code: "STAGING_BUCKET_BIRTH_RECEIPT_MISSING" }, code);
    }
  });
});

test("--verify needs the receipt and an equal pinned proof", async () => {
  const desired = staging();
  await withDirectory(async (directory) => {
    const receiptPath = join(directory, "receipt.json");
    await assert.rejects(flow.runStagingBucketBirth(desired, { mode: "verify", receiptPath }),
      { code: "STAGING_BUCKET_BIRTH_RECEIPT_MISSING" });
    await writeFile(receiptPath, JSON.stringify(receiptFor(desired)));
    await assert.rejects(flow.runStagingBucketBirth(desired, { mode: "verify", receiptPath }), { code: "STAGING_BUCKET_PROOF_UNPINNED" });
    const other = staging((value) => { value.bucket.proof = { bucketGeneration: "1759363200000002", bucketMetageneration: "1" }; });
    await assert.rejects(flow.runStagingBucketBirth(other, { mode: "verify", receiptPath }),
      { code: "STAGING_BUCKET_PROOF_RECEIPT_MISMATCH" });
    const link = join(directory, "link.json");
    await symlink(receiptPath, link);
    await assert.rejects(flow.runStagingBucketBirth(desired, { mode: "verify", receiptPath: link }),
      { code: "STAGING_BUCKET_BIRTH_RECEIPT_INVALID" });
  });
});

test("the receipt verifier holds every field to the committed staging desired state", () => {
  const desired = staging();
  const good = receiptFor(desired);
  assert.deepEqual(flow.verifyStagingBucketBirthReceipt(good, desired), { bucketGeneration: GENERATION, bucketMetageneration: "1" });
  const reseal = (receipt) => {
    receipt.creationResponseSha256 = manifest.sha256Hex(canonicalJson(receipt.creationResponse));
    return receipt;
  };
  const cases = [
    [(receipt) => { receipt.schemaVersion = "tibotattle-gcp-bucket-birth-v2"; }, "STAGING_BUCKET_BIRTH_RECEIPT_INVALID"],
    [(receipt) => { receipt.project = "tibotattle-other"; }, "STAGING_BUCKET_BIRTH_RECEIPT_INVALID"],
    [(receipt) => { receipt.projectNumber = "100000000001"; }, "STAGING_BUCKET_BIRTH_RECEIPT_INVALID"],
    [(receipt) => { receipt.bucket = "tibotattle-staging-other"; }, "STAGING_BUCKET_BIRTH_RECEIPT_INVALID"],
    [(receipt) => { receipt.extra = "x"; }, "STAGING_BUCKET_BIRTH_RECEIPT_INVALID"],
    [(receipt) => { receipt.creationRequestSha256 = "0".repeat(64); }, "STAGING_BUCKET_BIRTH_RECEIPT_REQUEST_MISMATCH"],
    [(receipt) => { receipt.creationResponseSha256 = "0".repeat(64); }, "STAGING_BUCKET_BIRTH_RECEIPT_RESPONSE_MISMATCH"],
    [(receipt) => { receipt.creationResponse.bucketGeneration = "1759363200000002"; }, "STAGING_BUCKET_BIRTH_RECEIPT_RESPONSE_MISMATCH"],
    [(receipt) => { receipt.creationResponse.bucketMetageneration = "2"; reseal(receipt); }, "STAGING_BUCKET_BIRTH_RECEIPT_INVALID"],
    [(receipt) => { receipt.creationResponse.location = "US"; reseal(receipt); }, "STAGING_BUCKET_BIRTH_RECEIPT_INVALID"],
    [(receipt) => { receipt.creationResponse.versioningEnabled = true; reseal(receipt); }, "STAGING_BUCKET_BIRTH_RECEIPT_INVALID"],
    [(receipt) => { receipt.creationResponse.softDeleteRetentionDurationSeconds = "604800"; reseal(receipt); },
      "STAGING_BUCKET_BIRTH_RECEIPT_INVALID"],
    [(receipt) => { receipt.proof.bucketGeneration = "1759363200000002"; }, "STAGING_BUCKET_BIRTH_RECEIPT_INVALID"],
    [(receipt) => { receipt.proof.softDeleteRetentionDurationSeconds = "1"; }, "STAGING_BUCKET_BIRTH_RECEIPT_INVALID"],
    [(receipt) => { delete receipt.proof.bucket; }, "STAGING_BUCKET_BIRTH_RECEIPT_INVALID"],
  ];
  for (const [mutate, code] of cases) {
    const receipt = structuredClone(good);
    mutate(receipt);
    assert.throws(() => flow.verifyStagingBucketBirthReceipt(receipt, desired), { code }, code);
  }
  // A receipt for another desired state (another region) fails the request digest.
  const otherRegion = staging((value) => { value.region = "us-central1"; value.bucket.location = "US-CENTRAL1"; });
  assert.throws(() => flow.verifyStagingBucketBirthReceipt({ ...good }, otherRegion),
    { code: "STAGING_BUCKET_BIRTH_RECEIPT_REQUEST_MISMATCH" });
});

test("pins are exact, validated, one line each, and never move an existing pin", () => {
  const secret = pins.pinStagingSecretVersions(STAGING_TEXT, { IDENTITY_LINK_SECRET: "4" });
  assert.equal(secret.changed, true);
  assert.notEqual(secret.desiredStateDigestBefore, secret.desiredStateDigestAfter);
  assert.equal(pins.validateStagingDesiredStateText(secret.text).desired.secrets.IDENTITY_LINK_SECRET.version, "4");
  assert.equal(pins.pinStagingSecretVersions(secret.text, { IDENTITY_LINK_SECRET: "4" }).changed, false);
  for (const [value, code] of [
    [{ IDENTITY_LINK_SECRET: "5" }, "STAGING_SECRET_VERSION_ALREADY_PINNED:IDENTITY_LINK_SECRET"],
    [{ OTHER_SECRET: "1" }, "STAGING_SECRET_UNKNOWN:OTHER_SECRET"],
    [{ APPLE_PRIVATE_KEY: "0" }, "STAGING_SECRET_VERSION_INVALID:APPLE_PRIVATE_KEY"],
    [{ APPLE_PRIVATE_KEY: 1 }, "STAGING_SECRET_VERSION_INVALID:APPLE_PRIVATE_KEY"],
    [{ APPLE_PRIVATE_KEY: "latest" }, "STAGING_SECRET_VERSION_INVALID:APPLE_PRIVATE_KEY"],
    [{}, "STAGING_SECRET_PINS_INVALID"],
  ]) {
    assert.throws(() => pins.pinStagingSecretVersions(secret.text, value), { code }, code);
  }
  for (const proof of [{ bucketGeneration: "0", bucketMetageneration: "1" }, { bucketGeneration: GENERATION },
    { bucketGeneration: GENERATION, bucketMetageneration: "1", bucket: "x" }, null]) {
    assert.throws(() => pins.pinStagingBucketProof(STAGING_TEXT, proof), { code: "STAGING_BUCKET_PROOF_INVALID" });
  }
  // A reformatted file is not edited blindly.
  const reformatted = JSON.stringify(JSON.parse(STAGING_TEXT), null, 4);
  assert.throws(() => pins.pinStagingSecretVersions(reformatted, { APPLE_PRIVATE_KEY: "1" }),
    { code: "STAGING_DESIRED_STATE_LAYOUT_UNEXPECTED:secrets.APPLE_PRIVATE_KEY" });
  // Only the committed staging file: never production, never the synthetic fixture.
  assert.throws(() => pins.pinStagingSecretVersions(PRODUCTION_TEXT, { APPLE_PRIVATE_KEY: "1" }),
    { code: "DESIRED_STATE_PLACEHOLDER_UNFILLED:project" });
  const fixture = readFileSync(join(SCRIPTS_ROOT, "fixtures/gcp-ops-infra/desired-state.synthetic.json"), "utf8");
  assert.throws(() => pins.pinStagingBucketProof(fixture, { bucketGeneration: GENERATION, bucketMetageneration: "1" }),
    { code: "GCP_INFRA_ENVIRONMENT_MISMATCH" });
});

test("the staging file is replaced atomically and never through a symlink", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "staging.desired-state.json");
    await writeFile(path, STAGING_TEXT);
    const next = pins.pinStagingSecretVersions(STAGING_TEXT, { APPLE_PRIVATE_KEY: "2" }).text;
    pins.writeStagingDesiredStateFile(next, path);
    assert.equal(await readFile(path, "utf8"), next);
    assert.deepEqual((await import("node:fs")).readdirSync(directory), ["staging.desired-state.json"]);
    const link = join(directory, "link.json");
    await symlink(path, link);
    assert.throws(() => pins.writeStagingDesiredStateFile(next, link), { code: "STAGING_DESIRED_STATE_UNREADABLE" });
    assert.throws(() => pins.readStagingDesiredStateFile(join(directory, "missing.json")), { code: "STAGING_DESIRED_STATE_UNREADABLE" });
  });
});
