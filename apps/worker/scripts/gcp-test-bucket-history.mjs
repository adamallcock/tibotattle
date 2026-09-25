#!/usr/bin/env node

/**
 * Create a fresh, dedicated test bucket with soft delete explicitly disabled
 * and preserve a sanitized snapshot of its direct GCS create response as a
 * history-proof receipt.
 * Dry-run first. Add --apply only when ready to create the named test bucket.
 * This tool never inspects an existing bucket and never updates or deletes one.
 */

import { createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const GCP_TEST_BUCKET_HISTORY_TARGET = Object.freeze({
  project: "tibotattle",
  projectNumber: "806510610397",
  location: "US-EAST1",
  existingBucket: "tibotattle-gcs-test-app-20260922",
  bucketPrefix: "tibotattle-gcs-test-cleanup-",
});

export const GCP_TEST_BUCKET_HISTORY_API_ORIGIN = "https://storage.googleapis.com";
export const GCP_TEST_BUCKET_HISTORY_RECEIPT_SCHEMA =
  "gcs-erasure-bucket-history-receipt-v1";

const ACCESS_TOKEN_MAX_BYTES = 8_192;
const JSON_MAX_BYTES = 64 * 1_024;
const SIGNED_GENERATION_MAX = 9_223_372_036_854_775_807n;
const GENERATION_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/u;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validBucketName(value) {
  return typeof value === "string"
    && value.length >= 3 && value.length <= 63
    && /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(value);
}

function validateProvisionableBucket(value) {
  if (!validBucketName(value)
      || value === GCP_TEST_BUCKET_HISTORY_TARGET.existingBucket
      || !value.startsWith(GCP_TEST_BUCKET_HISTORY_TARGET.bucketPrefix)
      || value.length === GCP_TEST_BUCKET_HISTORY_TARGET.bucketPrefix.length) {
    fail("GCP_TEST_BUCKET_HISTORY_TARGET_INVALID");
  }
  return value;
}

export function parseGcpTestBucketHistoryArgs(argv) {
  if (!Array.isArray(argv) || argv[0] !== "create") {
    fail("GCP_TEST_BUCKET_HISTORY_COMMAND_INVALID");
  }
  const values = new Map();
  let apply = false;
  for (const argument of argv.slice(1)) {
    if (argument === "--apply") {
      if (apply) fail("GCP_TEST_BUCKET_HISTORY_ARGUMENT_INVALID");
      apply = true;
      continue;
    }
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator < 3) {
      fail("GCP_TEST_BUCKET_HISTORY_ARGUMENT_INVALID");
    }
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (!["--bucket", "--receipt-out"].includes(name)
        || value.length === 0 || values.has(name)) {
      fail("GCP_TEST_BUCKET_HISTORY_ARGUMENT_INVALID");
    }
    values.set(name, value);
  }
  const bucket = validateProvisionableBucket(values.get("--bucket"));
  const receiptPath = values.get("--receipt-out");
  if (apply && (typeof receiptPath !== "string" || !receiptPath.startsWith("/"))) {
    fail("GCP_TEST_BUCKET_HISTORY_RECEIPT_PATH_REQUIRED");
  }
  return Object.freeze({
    bucket,
    receiptPath: receiptPath === undefined ? null : resolve(receiptPath),
    apply,
  });
}

export function buildGcpTestBucketCreateRequest(bucket) {
  validateProvisionableBucket(bucket);
  return Object.freeze({
    name: bucket,
    location: GCP_TEST_BUCKET_HISTORY_TARGET.location,
    storageClass: "STANDARD",
    iamConfiguration: Object.freeze({
      uniformBucketLevelAccess: Object.freeze({ enabled: true }),
      publicAccessPrevention: "enforced",
    }),
    softDeletePolicy: Object.freeze({ retentionDurationSeconds: "0" }),
    versioning: Object.freeze({ enabled: false }),
  });
}

function decimalGeneration(value) {
  if (typeof value !== "string" || !GENERATION_PATTERN.test(value)) {
    fail("GCP_TEST_BUCKET_HISTORY_RESPONSE_INVALID");
  }
  let parsed;
  try { parsed = BigInt(value); } catch { fail("GCP_TEST_BUCKET_HISTORY_RESPONSE_INVALID"); }
  if (parsed < 1n || parsed > SIGNED_GENERATION_MAX) {
    fail("GCP_TEST_BUCKET_HISTORY_RESPONSE_INVALID");
  }
  return value;
}

function disabledSoftDeleteDuration(value) {
  if (value === undefined) return "0";
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || value.retentionDurationSeconds !== "0") {
    fail("GCP_TEST_BUCKET_HISTORY_RESPONSE_INVALID");
  }
  return "0";
}

function bucketSnapshot(value, expectedBucket) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || value.name !== expectedBucket
      || value.projectNumber !== GCP_TEST_BUCKET_HISTORY_TARGET.projectNumber
      || value.location !== GCP_TEST_BUCKET_HISTORY_TARGET.location
      || typeof value.timeCreated !== "string"
      || !Number.isFinite(Date.parse(value.timeCreated))
      || value.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true
      || value.iamConfiguration?.publicAccessPrevention !== "enforced"
      || (value.versioning !== undefined
        && (value.versioning === null || typeof value.versioning !== "object"
          || value.versioning.enabled !== false))
      || value.retentionPolicy !== undefined) {
    fail("GCP_TEST_BUCKET_HISTORY_RESPONSE_INVALID");
  }
  return Object.freeze({
    bucket: expectedBucket,
    projectNumber: value.projectNumber,
    bucketGeneration: decimalGeneration(value.generation),
    bucketMetageneration: decimalGeneration(value.metageneration),
    location: value.location,
    timeCreated: value.timeCreated,
    softDeleteRetentionDurationSeconds: disabledSoftDeleteDuration(value.softDeletePolicy),
    iamConfiguration: Object.freeze({
      uniformBucketLevelAccess: true,
      publicAccessPrevention: "enforced",
    }),
    versioningEnabled: false,
  });
}

/** Build a receipt only from the successful create response plus exact read-back. */
export function createGcpTestBucketHistoryReceipt({
  bucket,
  createResponse,
  readbackResponse,
  request,
}) {
  validateProvisionableBucket(bucket);
  const created = bucketSnapshot(createResponse, bucket);
  const readback = bucketSnapshot(readbackResponse, bucket);
  if (created.bucketGeneration !== readback.bucketGeneration
      || created.projectNumber !== readback.projectNumber
      || created.bucketMetageneration !== readback.bucketMetageneration
      || created.location !== readback.location
      || created.timeCreated !== readback.timeCreated
      || created.softDeleteRetentionDurationSeconds !== "0"
      || readback.softDeleteRetentionDurationSeconds !== "0"
      || readback.bucketMetageneration !== "1") {
    fail("GCP_TEST_BUCKET_HISTORY_READBACK_MISMATCH");
  }
  const expectedRequest = buildGcpTestBucketCreateRequest(bucket);
  if (JSON.stringify(request) !== JSON.stringify(expectedRequest)) {
    fail("GCP_TEST_BUCKET_HISTORY_REQUEST_MISMATCH");
  }
  return Object.freeze({
    schemaVersion: GCP_TEST_BUCKET_HISTORY_RECEIPT_SCHEMA,
    source: "storage.buckets.insert",
    project: GCP_TEST_BUCKET_HISTORY_TARGET.project,
    projectNumber: GCP_TEST_BUCKET_HISTORY_TARGET.projectNumber,
    creationRequestSha256: digest(JSON.stringify(expectedRequest)),
    creationResponse: created,
    creationResponseSha256: digest(JSON.stringify(created)),
    proof: Object.freeze({
      bucket,
      bucketGeneration: created.bucketGeneration,
      bucketMetageneration: created.bucketMetageneration,
      softDeleteRetentionDurationSeconds: "0",
    }),
  });
}

async function responseJson(response) {
  if (!(response instanceof Response) || response.body === null) {
    fail("GCP_TEST_BUCKET_HISTORY_RESPONSE_INVALID");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      if (!(step.value instanceof Uint8Array)) fail("GCP_TEST_BUCKET_HISTORY_RESPONSE_INVALID");
      size += step.value.byteLength;
      if (size > JSON_MAX_BYTES) fail("GCP_TEST_BUCKET_HISTORY_RESPONSE_INVALID");
      chunks.push(step.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch {
    fail("GCP_TEST_BUCKET_HISTORY_RESPONSE_INVALID");
  }
}

function accessTokenFromGcloud(spawn = spawnSync) {
  const result = spawn("gcloud", [
    "auth", "print-access-token", `--project=${GCP_TEST_BUCKET_HISTORY_TARGET.project}`,
  ], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: ACCESS_TOKEN_MAX_BYTES + 1_024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0
      || typeof result.stdout !== "string"
      || result.stdout.length === 0 || result.stdout.length > ACCESS_TOKEN_MAX_BYTES) {
    fail("GCP_TEST_BUCKET_HISTORY_AUTH_UNAVAILABLE");
  }
  const token = result.stdout.trim();
  if (token.length === 0 || /\s/u.test(token)) {
    fail("GCP_TEST_BUCKET_HISTORY_AUTH_UNAVAILABLE");
  }
  return token;
}

async function writeReceiptExclusive(path, receipt) {
  const target = resolve(path);
  let handle;
  let created = false;
  try {
    handle = await open(target, "wx", 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch {
    try { await handle?.close(); } catch { /* retain the original safe error */ }
    if (created) {
      try { await unlink(target); } catch { /* only remove this run's partial receipt */ }
    }
    fail("GCP_TEST_BUCKET_HISTORY_RECEIPT_WRITE_FAILED");
  }
}

function bucketUrls(bucket) {
  const url = new URL("/storage/v1/b", GCP_TEST_BUCKET_HISTORY_API_ORIGIN);
  url.searchParams.set("project", GCP_TEST_BUCKET_HISTORY_TARGET.project);
  const readback = new URL(
    `/storage/v1/b/${encodeURIComponent(bucket)}`,
    GCP_TEST_BUCKET_HISTORY_API_ORIGIN,
  );
  readback.searchParams.set(
    "fields",
    "projectNumber,name,generation,metageneration,location,timeCreated,softDeletePolicy(retentionDurationSeconds),iamConfiguration(uniformBucketLevelAccess(enabled),publicAccessPrevention),versioning(enabled),retentionPolicy",
  );
  return { create: url, readback };
}

async function requestBucket({ fetchImpl, token, url, method, body }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    fail("GCP_TEST_BUCKET_HISTORY_REQUEST_FAILED");
  }
  if (!(response instanceof Response) || response.status !== 200) {
    try { await response?.body?.cancel(); } catch { /* avoid exposing provider payload */ }
    fail(method === "POST"
      ? "GCP_TEST_BUCKET_HISTORY_CREATE_FAILED"
      : "GCP_TEST_BUCKET_HISTORY_READBACK_FAILED");
  }
  return responseJson(response);
}

export async function runGcpTestBucketHistoryProvision(config, dependencies = {}) {
  const { bucket, receiptPath, apply } = config ?? {};
  validateProvisionableBucket(bucket);
  if (!apply) {
    return Object.freeze({
      status: "dry_run",
      project: GCP_TEST_BUCKET_HISTORY_TARGET.project,
      projectNumber: GCP_TEST_BUCKET_HISTORY_TARGET.projectNumber,
      bucket,
      location: GCP_TEST_BUCKET_HISTORY_TARGET.location,
      request: buildGcpTestBucketCreateRequest(bucket),
    });
  }
  if (typeof receiptPath !== "string" || !receiptPath.startsWith("/")) {
    fail("GCP_TEST_BUCKET_HISTORY_RECEIPT_PATH_REQUIRED");
  }
  const token = await (dependencies.getAccessToken ?? accessTokenFromGcloud)();
  if (typeof token !== "string" || token.length === 0
      || token.length > ACCESS_TOKEN_MAX_BYTES || /\s/u.test(token)) {
    fail("GCP_TEST_BUCKET_HISTORY_AUTH_UNAVAILABLE");
  }
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") fail("GCP_TEST_BUCKET_HISTORY_REQUEST_FAILED");
  const request = buildGcpTestBucketCreateRequest(bucket);
  const urls = bucketUrls(bucket);
  const createResponse = await requestBucket({
    fetchImpl, token, url: urls.create, method: "POST", body: request,
  });
  const readbackResponse = await requestBucket({
    fetchImpl, token, url: urls.readback, method: "GET",
  });
  const receipt = createGcpTestBucketHistoryReceipt({
    bucket, createResponse, readbackResponse, request,
  });
  await (dependencies.writeReceipt ?? writeReceiptExclusive)(receiptPath, receipt);
  return Object.freeze({ status: "created", receipt });
}

function safeCode(error) {
  return typeof error?.code === "string"
      && /^GCP_TEST_BUCKET_HISTORY_[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : "GCP_TEST_BUCKET_HISTORY_FAILED";
}

async function main() {
  try {
    const config = parseGcpTestBucketHistoryArgs(process.argv.slice(2));
    const result = await runGcpTestBucketHistoryProvision(config);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ status: "error", code: safeCode(error) }));
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
