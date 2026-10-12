/**
 * Bucket birth for the production quarantine bucket (OPS-2).
 *
 * One insert, with the posture gcp-test-bucket-history.mjs gives a proof
 * bucket: uniform bucket-level access, public access prevention enforced,
 * soft delete 0, no versioning, no lifecycle rule, no retention policy,
 * STANDARD storage, in the desired region. The receipt records the created
 * bucket's generation and metageneration; the owner pins that proof in the
 * desired state, and OPS-2 readback reports BUCKET_PROOF_STALE once the live
 * bucket moves from it. Owner decision OD-2 (2026-10-02): the service
 * reads that pinned proof as GCS_QUARANTINE_BUCKET_HISTORY_PROOF (rendered
 * from the desired state into EP-7's template), because the quarantine store
 * needs it on a bucket with soft delete disabled.
 *
 * Default is a dry run that makes no call. With apply and
 * --authorize=bucket-birth:<project>:<bucket>, it lists the project's buckets
 * through the guarded read-only runner and refuses an existing bucket, then
 * makes the one JSON API insert, which refuses an existing bucket with HTTP
 * 409 (BUCKET_BIRTH_BUCKET_EXISTS). It never updates, deletes or reads the
 * IAM policy of a bucket. The access token comes from the injected runner
 * (`gcloud auth print-access-token`), lives only in this call and never
 * reaches output, an error or the receipt.
 *
 * The insert is the one irreversible step, and a rerun refuses the bucket it
 * made, so the proof must survive whatever follows it. The --receipt-out file
 * is reserved (created exclusively, owner-only, never through a symlink)
 * before any call, so an existing or unwritable path refuses with nothing
 * inserted (BUCKET_BIRTH_RECEIPT_PATH_UNAVAILABLE). Every failure after the
 * insert carries `bucketInserted: true`, and a receipt write that fails
 * carries the content-free receipt itself, which the CLI prints on stdout.
 */

import { constants as fsConstants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { canonicalJson } from "../src/canonical-json.ts";
import {
  BUCKET_POSTURE,
  GcpOpsInfraError,
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
    // Canonical ISO milliseconds: the JSON API says "…18.035Z" while gcloud's
    // raw listing (the readback) says "…18.035000+00:00" for the same instant.
    timeCreated: new Date(Date.parse(value.timeCreated)).toISOString(),
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
    // Content-free diagnostics: snapshot field NAMES only, never values.
    const differingFields = Object.keys(created)
      .filter((key) => canonicalJson(created[key]) !== canonicalJson(readback[key])).sort();
    if (readback.bucketMetageneration !== "1" && !differingFields.includes("bucketMetageneration")) {
      differingFields.push("readbackMetagenerationNotOne");
    }
    throw Object.assign(new GcpOpsInfraError("BUCKET_BIRTH_READBACK_MISMATCH"),
      { differingFields: Object.freeze(differingFields) });
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

/**
 * Reserves the receipt file: created exclusively, owner-only and never through
 * a symlink, before anything irreversible. Returns { write(receipt), release() }:
 * write fills and syncs it once; release removes the still-empty reservation
 * when the run ends without a receipt. On a failed write the partial file from
 * this run is removed.
 */
export async function reserveBucketBirthReceipt(path) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("BUCKET_BIRTH_RECEIPT_PATH_INVALID");
  let handle;
  try {
    handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      | fsConstants.O_NOFOLLOW, 0o600);
  } catch {
    fail("BUCKET_BIRTH_RECEIPT_PATH_UNAVAILABLE");
  }
  let settled = false;
  const discardFile = async () => {
    try { await handle.close(); } catch { /* keep the original outcome */ }
    try { await unlink(path); } catch { /* only this run's own file */ }
  };
  return Object.freeze({
    async write(receipt) {
      if (settled) fail("BUCKET_BIRTH_RECEIPT_WRITE_FAILED");
      settled = true;
      try {
        await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
        await handle.sync();
        await handle.close();
      } catch {
        await discardFile();
        fail("BUCKET_BIRTH_RECEIPT_WRITE_FAILED");
      }
    },
    async release() {
      if (settled) return;
      settled = true;
      await discardFile();
    },
  });
}

/** Exclusive, owner-only receipt write; a partial file from this run is removed. */
export async function writeBucketBirthReceipt(path, receipt) {
  const reservation = await reserveBucketBirthReceipt(path);
  await reservation.write(receipt);
}

/** Marks a failure after the insert: the bucket exists, and a rerun refuses it. */
function afterInsert(error, receipt) {
  const code = error instanceof GcpOpsInfraError ? error.code : "BUCKET_BIRTH_FAILED_AFTER_INSERT";
  return Object.assign(new GcpOpsInfraError(code), {
    bucketInserted: true,
    ...(receipt === undefined ? {} : { receipt }),
    ...(Array.isArray(error?.differingFields) ? { differingFields: error.differingFields } : {}),
  });
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
  reserveReceipt = reserveBucketBirthReceipt,
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
  // Reserved before any call: a path that cannot take the receipt refuses
  // here, with nothing inserted.
  const reservation = receiptPath === null ? null : await reserveReceipt(receiptPath);
  let inserted;
  try {
    inserted = await insertBucket(desired, request, { runner, fetchImpl });
  } catch (error) {
    await reservation?.release();
    throw error;
  }
  let receipt;
  try {
    const readbackResponse = findBucket(inserted.read(inserted.listArgv), desired.bucket.name);
    if (readbackResponse === undefined) fail("BUCKET_BIRTH_READBACK_MISSING");
    receipt = createBucketBirthReceipt(desired, { createResponse: inserted.createResponse, readbackResponse });
  } catch (error) {
    await reservation?.release();
    throw afterInsert(error);
  }
  if (reservation !== null) {
    try {
      await reservation.write(receipt);
    } catch (error) {
      throw afterInsert(error, receipt);
    }
  }
  return deepFreeze({ status: "created", receipt });
}

/**
 * The listing refusal, the token and the one insert. Returns the parsed
 * create response; a failure before the insert succeeds throws as is, and
 * one after it (an unreadable create response) is marked as after the insert.
 */
async function insertBucket(desired, request, { runner, fetchImpl }) {
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
  let createResponse;
  try {
    createResponse = await boundedJson(response);
  } catch (error) {
    throw afterInsert(error);
  }
  return { read, listArgv, createResponse };
}
