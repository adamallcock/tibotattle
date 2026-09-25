import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildGcpTestBucketCreateRequest,
  createGcpTestBucketHistoryReceipt,
  GCP_TEST_BUCKET_HISTORY_TARGET,
  parseGcpTestBucketHistoryArgs,
  runGcpTestBucketHistoryProvision,
} from "./gcp-test-bucket-history.mjs";

const bucket = "tibotattle-gcs-test-cleanup-20260925-smoke";
const generation = "1790076862389741872";
const timeCreated = "2026-09-25T04:30:00.000Z";

function bucketResource(overrides = {}) {
  return {
    name: bucket,
    projectNumber: GCP_TEST_BUCKET_HISTORY_TARGET.projectNumber,
    generation,
    metageneration: "1",
    location: GCP_TEST_BUCKET_HISTORY_TARGET.location,
    timeCreated,
    iamConfiguration: { uniformBucketLevelAccess: { enabled: true } },
    publicAccessPrevention: "enforced",
    softDeletePolicy: { retentionDurationSeconds: "0" },
    versioning: { enabled: false },
    ...overrides,
  };
}

test("provisioning targets only a new dedicated test bucket and requires an explicit write flag", () => {
  assert.deepEqual(parseGcpTestBucketHistoryArgs([
    "create", `--bucket=${bucket}`,
  ]), { bucket, receiptPath: null, apply: false });
  assert.throws(() => parseGcpTestBucketHistoryArgs([
    "create", `--bucket=${GCP_TEST_BUCKET_HISTORY_TARGET.existingBucket}`,
  ]), /GCP_TEST_BUCKET_HISTORY_TARGET_INVALID/u);
  for (const invalid of [
    "production-bucket",
    "tibotattle-gcs-test-cleanup-",
    "tibotattle-gcs-test-cleanup-UPPER",
    "tibotattle-gcs-test-cleanup-" + "x".repeat(64),
  ]) {
    assert.throws(() => parseGcpTestBucketHistoryArgs(["create", `--bucket=${invalid}`]));
  }
  assert.throws(() => parseGcpTestBucketHistoryArgs([
    "create", `--bucket=${bucket}`, "--apply",
  ]), /GCP_TEST_BUCKET_HISTORY_RECEIPT_PATH_REQUIRED/u);
  assert.throws(() => parseGcpTestBucketHistoryArgs([
    "create", `--bucket=${bucket}`, "--apply", "--receipt-out=relative.json",
  ]), /GCP_TEST_BUCKET_HISTORY_RECEIPT_PATH_REQUIRED/u);
});

test("creation request starts with no data, no object versioning, and soft delete disabled", () => {
  assert.deepEqual(buildGcpTestBucketCreateRequest(bucket), {
    name: bucket,
    location: "US-EAST1",
    storageClass: "STANDARD",
    iamConfiguration: { uniformBucketLevelAccess: { enabled: true } },
    publicAccessPrevention: "enforced",
    softDeletePolicy: { retentionDurationSeconds: "0" },
    versioning: { enabled: false },
  });
});

test("history receipt preserves GCS 64-bit generations as exact decimal strings", () => {
  const request = buildGcpTestBucketCreateRequest(bucket);
  const receipt = createGcpTestBucketHistoryReceipt({
    bucket,
    createResponse: bucketResource(),
    // GCS may omit a disabled policy in readback; the request and create
    // response are retained, and the returned metadata generation must match.
    readbackResponse: bucketResource({ softDeletePolicy: undefined }),
    request,
  });
  assert.equal(receipt.proof.bucketGeneration, generation);
  assert.equal(receipt.proof.bucketMetageneration, "1");
  assert.equal(receipt.proof.softDeleteRetentionDurationSeconds, "0");
  assert.equal(receipt.creationResponseSha256.length, 64);
  assert.equal(receipt.creationRequestSha256.length, 64);
  assert.equal(receipt.schemaVersion, "gcs-erasure-bucket-history-receipt-v1");
  assert.equal(Object.isFrozen(receipt.proof), true);
});

test("receipt refuses a disabled policy that was not configured at creation or changed bucket metadata", () => {
  const request = buildGcpTestBucketCreateRequest(bucket);
  for (const [createResponse, readbackResponse] of [
    [bucketResource({ softDeletePolicy: { retentionDurationSeconds: "604800" } }), bucketResource()],
    [bucketResource(), bucketResource({ softDeletePolicy: { retentionDurationSeconds: "604800" } })],
    [bucketResource(), bucketResource({ metageneration: "2" })],
    [bucketResource(), bucketResource({ projectNumber: "123456789012" })],
    [bucketResource({ generation: 1 }), bucketResource()],
    [bucketResource({ versioning: { enabled: true } }), bucketResource()],
    [bucketResource({ publicAccessPrevention: "inherited" }), bucketResource()],
  ]) {
    assert.throws(() => createGcpTestBucketHistoryReceipt({
      bucket, createResponse, readbackResponse, request,
    }));
  }
});

test("dry run has no token or network side effects", async () => {
  let tokenCalls = 0;
  let fetchCalls = 0;
  const result = await runGcpTestBucketHistoryProvision({ bucket, apply: false }, {
    getAccessToken: async () => { tokenCalls += 1; return "unused"; },
    fetchImpl: async () => { fetchCalls += 1; throw new Error("must not fetch"); },
  });
  assert.equal(result.status, "dry_run");
  assert.equal(result.projectNumber, "806510610397");
  assert.equal(tokenCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("live mode creates the bucket, reads back the same incarnation, and writes only the receipt", async () => {
  const requests = [];
  let writtenPath;
  let writtenReceipt;
  const result = await runGcpTestBucketHistoryProvision({
    bucket,
    receiptPath: "/private/tmp/gcs-history-proof.json",
    apply: true,
  }, {
    async getAccessToken() { return "synthetic-access-token"; },
    async fetchImpl(url, options) {
      requests.push({ url: new URL(url), options });
      if (options.method === "POST") return new Response(JSON.stringify(bucketResource()));
      return new Response(JSON.stringify(bucketResource({ softDeletePolicy: undefined })));
    },
    async writeReceipt(path, receipt) {
      writtenPath = path;
      writtenReceipt = receipt;
    },
  });
  assert.equal(result.status, "created");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.origin, "https://storage.googleapis.com");
  assert.equal(requests[0].url.pathname, "/storage/v1/b");
  assert.equal(requests[0].url.searchParams.get("project"), "tibotattle");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.redirect, "manual");
  assert.deepEqual(JSON.parse(requests[0].options.body), buildGcpTestBucketCreateRequest(bucket));
  assert.equal(requests[0].options.headers.authorization, "Bearer synthetic-access-token");
  assert.equal(requests[1].url.pathname, `/storage/v1/b/${bucket}`);
  assert.equal(requests[1].options.method, "GET");
  assert.equal(writtenPath, "/private/tmp/gcs-history-proof.json");
  assert.deepEqual(writtenReceipt, result.receipt);
  assert.equal(writtenReceipt.proof.bucketGeneration, generation);
});

test("readback or create failures never write a history proof", async () => {
  let writes = 0;
  const base = {
    bucket,
    receiptPath: "/private/tmp/gcs-history-proof.json",
    apply: true,
  };
  await assert.rejects(runGcpTestBucketHistoryProvision(base, {
    async getAccessToken() { return "synthetic-access-token"; },
    async fetchImpl(url, options) {
      return options.method === "POST"
        ? new Response(JSON.stringify(bucketResource()))
        : new Response(JSON.stringify(bucketResource({ metageneration: "2" })));
    },
    async writeReceipt() { writes += 1; },
  }), /GCP_TEST_BUCKET_HISTORY_READBACK_MISMATCH/u);
  await assert.rejects(runGcpTestBucketHistoryProvision(base, {
    async getAccessToken() { return "synthetic-access-token"; },
    async fetchImpl() { return new Response("{}", { status: 409 }); },
    async writeReceipt() { writes += 1; },
  }), /GCP_TEST_BUCKET_HISTORY_CREATE_FAILED/u);
  assert.equal(writes, 0);
});

test("receipt output refuses to replace or remove a pre-existing file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gcs-history-receipt-test-"));
  const receiptPath = join(directory, "receipt.json");
  const existingReceipt = "keep the earlier receipt\n";
  try {
    await writeFile(receiptPath, existingReceipt, { flag: "wx", mode: 0o600 });
    await assert.rejects(runGcpTestBucketHistoryProvision({
      bucket,
      receiptPath,
      apply: true,
    }, {
      async getAccessToken() { return "synthetic-access-token"; },
      async fetchImpl(url, options) {
        return options.method === "POST"
          ? new Response(JSON.stringify(bucketResource()))
          : new Response(JSON.stringify(bucketResource({ softDeletePolicy: undefined })));
      },
    }), /GCP_TEST_BUCKET_HISTORY_RECEIPT_WRITE_FAILED/u);
    assert.equal(await readFile(receiptPath, "utf8"), existingReceipt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
