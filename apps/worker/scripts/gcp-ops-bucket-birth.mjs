/**
 * Bucket birth for the production quarantine bucket (OPS-2).
 *
 * One insert, with the posture gcp-test-bucket-history.mjs gives a proof
 * bucket: uniform bucket-level access, public access prevention enforced,
 * soft delete 0, no versioning, no lifecycle rule, no retention policy,
 * STANDARD storage, in the desired region. The receipt records the created
 * bucket's generation and metageneration; the owner pins that proof in the
 * desired state, and OPS-2 readback reports BUCKET_PROOF_STALE once the live
 * bucket moves from it. The proof is infrastructure evidence only: the
 * runtime no longer consumes a bucket-history proof (SIMP-0).
 *
 * Default is a dry run that makes no call. With apply and
 * --authorize=bucket-birth:<project>:<bucket>, it lists the project's buckets
 * through the guarded read-only runner and refuses an existing bucket, then
 * makes the one JSON API insert, which refuses an existing bucket with HTTP
 * 409 (BUCKET_BIRTH_BUCKET_EXISTS). It never updates, deletes or reads the
 * IAM policy of a bucket. The access token comes from the injected runner
 * (`gcloud auth print-access-token`), lives only in this call and never
 * reaches output, an error or the receipt.
 */

import { constants as fsConstants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { canonicalJson } from "../src/canonical-json.ts";
import {
  BUCKET_POSTURE,
  bucketInsertBody,
  deepFreeze,
  fail,
  sha256Hex,
} from "./gcp-ops-infra-manifest.mjs";
import { defaultGcloudRunner, guardedGcloud } from "./gcp-ops-infra-operations.mjs";

export const GCP_OPS_BUCKET_BIRTH_RECEIPT_SCHEMA = "tibotattle-gcp-bucket-birth-v1";
export const GCS_JSON_API_ORIGIN = "https://storage.googleapis.com";

const TOKEN_MAX_BYTES = 8_192;
const JSON_MAX_BYTES = 64 * 1_024;
const GENERATION = /^[1-9][0-9]{0,18}$/u;
const MAX_GENERATION = 9_223_372_036_854_775_807n;

/** The exact --authorize value a bucket birth requires. */
export function bucketBirthAuthorization(desired) {
  return `bucket-birth:${desired.project}:${desired.bucket.name}`;
}

/** The one insert: its URL and body. */
export function bucketBirthRequest(desired) {
  const url = new URL("/storage/v1/b", GCS_JSON_API_ORIGIN);
  url.searchParams.set("project", desired.project);
  return deepFreeze({ method: "POST", url: url.href, body: bucketInsertBody(desired) });
}

function decimalGeneration(value) {
  if (typeof value !== "string" || !GENERATION.test(value) || BigInt(value) > MAX_GENERATION) {
    fail("BUCKET_BIRTH_RESPONSE_INVALID");
  }
  return value;
}

/** A content-free snapshot of a bucket resource that must carry the posture. */
export function bucketBirthSnapshot(value, desired) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || value.name !== desired.bucket.name
      || value.projectNumber !== desired.projectNumber
      || value.location !== desired.bucket.location
      || value.storageClass !== BUCKET_POSTURE.storageClass
      || typeof value.timeCreated !== "string" || !Number.isFinite(Date.parse(value.timeCreated))
      || value.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true
      || value.iamConfiguration?.publicAccessPrevention !== BUCKET_POSTURE.publicAccessPrevention
      || (value.versioning !== undefined && value.versioning?.enabled !== false)
      || (value.softDeletePolicy !== undefined
        && value.softDeletePolicy?.retentionDurationSeconds !== BUCKET_POSTURE.softDeleteRetentionDurationSeconds)
      || value.lifecycle !== undefined
      || value.retentionPolicy !== undefined) {
    fail("BUCKET_BIRTH_RESPONSE_INVALID");
  }
  return deepFreeze({
    bucket: value.name,
    projectNumber: value.projectNumber,
    location: value.location,
    storageClass: value.storageClass,
    timeCreated: value.timeCreated,
    bucketGeneration: decimalGeneration(value.generation),
    bucketMetageneration: decimalGeneration(value.metageneration),
    softDeleteRetentionDurationSeconds: "0",
    uniformBucketLevelAccess: true,
    publicAccessPrevention: BUCKET_POSTURE.publicAccessPrevention,
    versioningEnabled: false,
  });
}

/** The receipt, only from a successful insert and an exact readback. */
export function createBucketBirthReceipt(desired, { createResponse, readbackResponse }) {
  const created = bucketBirthSnapshot(createResponse, desired);
  const readback = bucketBirthSnapshot(readbackResponse, desired);
  if (canonicalJson(created) !== canonicalJson(readback) || readback.bucketMetageneration !== "1") {
    fail("BUCKET_BIRTH_READBACK_MISMATCH");
  }
  const request = bucketBirthRequest(desired);
  return deepFreeze({
    schemaVersion: GCP_OPS_BUCKET_BIRTH_RECEIPT_SCHEMA,
    source: "storage.buckets.insert",
    project: desired.project,
    projectNumber: desired.projectNumber,
    bucket: desired.bucket.name,
    creationRequestSha256: sha256Hex(canonicalJson(request.body)),
    creationResponse: created,
    creationResponseSha256: sha256Hex(canonicalJson(created)),
    proof: {
      bucket: desired.bucket.name,
      bucketGeneration: created.bucketGeneration,
      bucketMetageneration: created.bucketMetageneration,
      softDeleteRetentionDurationSeconds: "0",
    },
  });
}

function accessToken(runner, project) {
  let result;
  try {
    result = runner(["auth", "print-access-token", `--project=${project}`]);
  } catch {
    fail("BUCKET_BIRTH_AUTH_UNAVAILABLE");
  }
  const token = typeof result?.stdout === "string" ? result.stdout.trim() : "";
  if (result?.status !== 0 || token.length === 0 || token.length > TOKEN_MAX_BYTES || /\s/u.test(token)) {
    fail("BUCKET_BIRTH_AUTH_UNAVAILABLE");
  }
  return token;
}

async function boundedJson(response) {
  if (!(response instanceof Response) || response.body === null) fail("BUCKET_BIRTH_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      size += step.value.byteLength;
      if (size > JSON_MAX_BYTES) fail("BUCKET_BIRTH_RESPONSE_INVALID");
      chunks.push(step.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return fail("BUCKET_BIRTH_RESPONSE_INVALID");
  }
}

async function discard(response) {
  try { await response?.body?.cancel(); } catch { /* never surface provider payloads */ }
}

/** Exclusive, owner-only receipt write; a partial file from this run is removed. */
export async function writeBucketBirthReceipt(path, receipt) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("BUCKET_BIRTH_RECEIPT_PATH_INVALID");
  let handle;
  let created = false;
  try {
    handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      | fsConstants.O_NOFOLLOW, 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch {
    try { await handle?.close(); } catch { /* keep the original refusal */ }
    if (created) {
      try { await unlink(path); } catch { /* only this run's partial file */ }
    }
    fail("BUCKET_BIRTH_RECEIPT_WRITE_FAILED");
  }
}

function findBucket(list, name) {
  if (!Array.isArray(list)) fail("BUCKET_BIRTH_LIST_INVALID");
  return list.find((bucket) => bucket !== null && typeof bucket === "object" && bucket.name === name);
}

/**
 * Dry run unless `apply` is true. Applying needs the exact authorization,
 * refuses the synthetic fixture and a desired state that already pins a
 * proof, and refuses any existing bucket of that name without inserting.
 */
export async function runBucketBirth(desired, {
  apply = false,
  authorize,
  receiptPath = null,
  runner = defaultGcloudRunner,
  fetchImpl = globalThis.fetch,
  writeReceipt = writeBucketBirthReceipt,
} = {}) {
  const request = bucketBirthRequest(desired);
  if (!apply) {
    return deepFreeze({
      status: "dry_run",
      project: desired.project,
      bucket: desired.bucket.name,
      authorization: bucketBirthAuthorization(desired),
      request,
    });
  }
  if (desired.synthetic) fail("BUCKET_BIRTH_SYNTHETIC_TARGET_REFUSED");
  if (authorize !== bucketBirthAuthorization(desired)) fail("BUCKET_BIRTH_AUTHORIZATION_MISMATCH");
  if (desired.bucket.proof !== null) fail("BUCKET_BIRTH_PROOF_ALREADY_PINNED");
  if (receiptPath !== null && (typeof receiptPath !== "string" || !isAbsolute(receiptPath))) {
    fail("BUCKET_BIRTH_RECEIPT_PATH_INVALID");
  }
  const read = guardedGcloud(runner, { mode: "read", project: desired.project });
  const listArgv = ["storage", "buckets", "list", `--project=${desired.project}`, "--raw", "--format=json"];
  if (findBucket(read(listArgv), desired.bucket.name) !== undefined) fail("BUCKET_BIRTH_BUCKET_EXISTS");
  if (typeof fetchImpl !== "function") fail("BUCKET_BIRTH_REQUEST_FAILED");
  const token = accessToken(runner, desired.project);
  let response;
  try {
    response = await fetchImpl(request.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(request.body),
    });
  } catch {
    fail("BUCKET_BIRTH_REQUEST_FAILED");
  }
  if (response?.status === 409) {
    await discard(response);
    fail("BUCKET_BIRTH_BUCKET_EXISTS");
  }
  if (!(response instanceof Response) || response.status !== 200) {
    await discard(response);
    fail("BUCKET_BIRTH_CREATE_FAILED");
  }
  const createResponse = await boundedJson(response);
  const readbackResponse = findBucket(read(listArgv), desired.bucket.name);
  if (readbackResponse === undefined) fail("BUCKET_BIRTH_READBACK_MISSING");
  const receipt = createBucketBirthReceipt(desired, { createResponse, readbackResponse });
  if (receiptPath !== null) await writeReceipt(receiptPath, receipt);
  return deepFreeze({ status: "created", receipt });
}
