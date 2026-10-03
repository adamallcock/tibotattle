#!/usr/bin/env node

/**
 * Staging bucket birth with a committed proof (STG-PREP).
 *
 *   node scripts/gcp-staging-bucket-birth.mjs --environment=staging [--dry-run]
 *   node scripts/gcp-staging-bucket-birth.mjs --environment=staging --apply
 *        --authorize=bucket-birth:<project>:<bucket>
 *   node scripts/gcp-staging-bucket-birth.mjs --environment=staging --pin-only
 *   node scripts/gcp-staging-bucket-birth.mjs --environment=staging --verify
 *
 * The staging quarantine bucket is born by OPS-2's reviewed bucket birth
 * (gcp-ops-bucket-birth.mjs runBucketBirth: one insert that refuses an
 * existing bucket, with the proof posture, and a content-free receipt). This
 * flow fixes where that receipt lives and pins its proof:
 *
 * - the receipt goes to STAGING_BUCKET_BIRTH_RECEIPT_FILE
 *   (cloud-run/infra/staging.bucket-birth.receipt.json), reserved
 *   exclusively before the insert, so an existing receipt refuses the run
 *   with nothing inserted;
 * - after the insert, the receipt is verified against the committed staging
 *   desired state (verifyStagingBucketBirthReceipt) and its proof
 *   (generation and metageneration) is pinned at bucket.proof in
 *   cloud-run/infra/staging.desired-state.json (gcp-staging-desired-state.mjs);
 * - the main session then reviews and commits both files. OPS-2 apply refuses
 *   the estate until that proof is committed (APPLY_BUCKET_PROOF_UNPINNED),
 *   and OD-2 renders it into the staging service as
 *   GCS_QUARANTINE_BUCKET_HISTORY_PROOF.
 *
 * Dry run (the default) makes no call and writes nothing. --apply needs the
 * exact bucket-birth authorization. A failure after the insert reports
 * bucketInserted: true on stderr, with receiptWritten and receiptPrinted
 * saying where the proof is:
 * - receiptWritten: the receipt file exists and only the pin failed; rerun
 *   with --pin-only, which reads the committed receipt, verifies it and pins
 *   (a no-op when the same proof is already pinned);
 * - receiptPrinted: the receipt file could not be written, and stdout carries
 *   the receipt (status created_receipt_unwritten) to save, then --pin-only;
 * - neither: the bucket was born but no receipt exists (for example the
 *   readback missed it, or the create response was unreadable). The proof
 *   cannot be recovered with this tool: stop and ask the owner; never rerun
 *   --apply and never adopt the bucket.
 * --verify checks the receipt and the pinned proof agree, and changes
 * nothing. Staging only; production keeps the plain OPS-2 bucket-birth
 * command.
 */

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../src/canonical-json.ts";
import {
  GCP_OPS_BUCKET_BIRTH_RECEIPT_SCHEMA,
  bucketBirthAuthorization,
  bucketBirthRequest,
  runBucketBirth,
} from "./gcp-ops-bucket-birth.mjs";
import {
  BUCKET_POSTURE,
  GcpOpsInfraError,
  deepFreeze,
  fail,
  loadCommittedDesiredState,
  sha256Hex,
} from "./gcp-ops-infra-manifest.mjs";
import { defaultGcloudRunner } from "./gcp-ops-infra-operations.mjs";
import { pinStagingBucketProof, updateStagingDesiredState } from "./gcp-staging-desired-state.mjs";

const WORKER_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const STAGING_BUCKET_BIRTH_ENVIRONMENT = "staging";
/** Where the staging bucket-birth receipt is written and committed, relative to apps/worker. */
export const STAGING_BUCKET_BIRTH_RECEIPT_FILE = "cloud-run/infra/staging.bucket-birth.receipt.json";
export const STAGING_BUCKET_BIRTH_SCHEMA = "tibotattle-gcp-staging-bucket-birth-v1";

const RECEIPT_KEYS = Object.freeze(["schemaVersion", "source", "project", "projectNumber", "bucket",
  "creationRequestSha256", "creationResponse", "creationResponseSha256", "proof"]);
const SNAPSHOT_KEYS = Object.freeze(["bucket", "projectNumber", "location", "storageClass", "timeCreated",
  "bucketGeneration", "bucketMetageneration", "softDeleteRetentionDurationSeconds", "uniformBucketLevelAccess",
  "publicAccessPrevention", "versioningEnabled"]);
const PROOF_KEYS = Object.freeze(["bucket", "bucketGeneration", "bucketMetageneration",
  "softDeleteRetentionDurationSeconds"]);
const GENERATION = /^[1-9][0-9]{0,18}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_RECEIPT_BYTES = 16 * 1024;

export function stagingBucketBirthReceiptPath() {
  return resolve(WORKER_ROOT, STAGING_BUCKET_BIRTH_RECEIPT_FILE);
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join() === [...keys].sort().join();
}

function requireStaging(desired) {
  if (desired?.environment !== STAGING_BUCKET_BIRTH_ENVIRONMENT) fail("STAGING_BUCKET_BIRTH_ENVIRONMENT_REFUSED");
  if (desired.synthetic) fail("BUCKET_BIRTH_SYNTHETIC_TARGET_REFUSED");
  return desired;
}

/**
 * Verifies a bucket-birth receipt against the staging desired state: the
 * receipt schema and closed keys, the project, project number and bucket,
 * the request digest of this desired state's insert, the response snapshot's
 * posture and its digest, a first metageneration, and a proof that repeats
 * the snapshot's generations. Returns { bucketGeneration, bucketMetageneration }.
 */
export function verifyStagingBucketBirthReceipt(receipt, desired) {
  requireStaging(desired);
  const invalid = () => fail("STAGING_BUCKET_BIRTH_RECEIPT_INVALID");
  if (!exactKeys(receipt, RECEIPT_KEYS) || receipt.schemaVersion !== GCP_OPS_BUCKET_BIRTH_RECEIPT_SCHEMA
      || receipt.source !== "storage.buckets.insert" || receipt.project !== desired.project
      || receipt.projectNumber !== desired.projectNumber || receipt.bucket !== desired.bucket.name
      || !SHA256.test(receipt.creationRequestSha256 ?? "") || !SHA256.test(receipt.creationResponseSha256 ?? "")) {
    invalid();
  }
  if (receipt.creationRequestSha256 !== sha256Hex(canonicalJson(bucketBirthRequest(desired).body))) {
    fail("STAGING_BUCKET_BIRTH_RECEIPT_REQUEST_MISMATCH");
  }
  const snapshot = receipt.creationResponse;
  if (!exactKeys(snapshot, SNAPSHOT_KEYS) || snapshot.bucket !== desired.bucket.name
      || snapshot.projectNumber !== desired.projectNumber || snapshot.location !== desired.bucket.location
      || snapshot.storageClass !== BUCKET_POSTURE.storageClass
      || typeof snapshot.timeCreated !== "string" || !Number.isFinite(Date.parse(snapshot.timeCreated))
      || typeof snapshot.bucketGeneration !== "string" || !GENERATION.test(snapshot.bucketGeneration)
      || snapshot.bucketMetageneration !== "1"
      || snapshot.softDeleteRetentionDurationSeconds !== BUCKET_POSTURE.softDeleteRetentionDurationSeconds
      || snapshot.uniformBucketLevelAccess !== true
      || snapshot.publicAccessPrevention !== BUCKET_POSTURE.publicAccessPrevention
      || snapshot.versioningEnabled !== false) {
    invalid();
  }
  if (receipt.creationResponseSha256 !== sha256Hex(canonicalJson(snapshot))) {
    fail("STAGING_BUCKET_BIRTH_RECEIPT_RESPONSE_MISMATCH");
  }
  const { proof } = receipt;
  if (!exactKeys(proof, PROOF_KEYS) || proof.bucket !== desired.bucket.name
      || proof.bucketGeneration !== snapshot.bucketGeneration
      || proof.bucketMetageneration !== snapshot.bucketMetageneration
      || proof.softDeleteRetentionDurationSeconds !== "0") {
    invalid();
  }
  return deepFreeze({ bucketGeneration: proof.bucketGeneration, bucketMetageneration: proof.bucketMetageneration });
}

/** Reads the committed receipt file (never through a symlink, bounded). */
export function readStagingBucketBirthReceipt(path = stagingBucketBirthReceiptPath()) {
  let stat;
  try { stat = lstatSync(path); } catch { fail("STAGING_BUCKET_BIRTH_RECEIPT_MISSING"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > MAX_RECEIPT_BYTES) {
    fail("STAGING_BUCKET_BIRTH_RECEIPT_INVALID");
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fail("STAGING_BUCKET_BIRTH_RECEIPT_INVALID");
  }
}

function pinFromReceipt(receipt, desired, pinStore) {
  const proof = verifyStagingBucketBirthReceipt(receipt, desired);
  const pinned = updateStagingDesiredState((text) => pinStagingBucketProof(text, proof), pinStore);
  return { proof, pinned };
}

/** Dry run, apply, pin-only or verify; returns the content-free result. */
export async function runStagingBucketBirth(desired, {
  mode = "dry-run",
  authorize,
  runner = defaultGcloudRunner,
  fetchImpl = globalThis.fetch,
  receiptPath = stagingBucketBirthReceiptPath(),
  reserveReceipt,
  readReceipt = readStagingBucketBirthReceipt,
  pinStore,
} = {}) {
  requireStaging(desired);
  const receiptFile = STAGING_BUCKET_BIRTH_RECEIPT_FILE;
  if (mode === "dry-run") {
    const dry = await runBucketBirth(desired, { apply: false });
    return deepFreeze({
      schema: STAGING_BUCKET_BIRTH_SCHEMA,
      status: "dry_run",
      project: desired.project,
      bucket: desired.bucket.name,
      authorization: bucketBirthAuthorization(desired),
      request: dry.request,
      receiptFile,
      pin: "bucket.proof in cloud-run/infra/staging.desired-state.json",
      proofPinned: desired.bucket.proof !== null,
    });
  }
  if (mode === "verify") {
    const proof = verifyStagingBucketBirthReceipt(readReceipt(receiptPath), desired);
    const pinned = desired.bucket.proof;
    if (pinned === null) fail("STAGING_BUCKET_PROOF_UNPINNED");
    if (pinned.bucketGeneration !== proof.bucketGeneration || pinned.bucketMetageneration !== proof.bucketMetageneration) {
      fail("STAGING_BUCKET_PROOF_RECEIPT_MISMATCH");
    }
    return deepFreeze({ schema: STAGING_BUCKET_BIRTH_SCHEMA, status: "verified", bucket: desired.bucket.name,
      receiptFile, proof });
  }
  if (mode === "pin-only") {
    const { proof, pinned } = pinFromReceipt(readReceipt(receiptPath), desired, pinStore);
    return deepFreeze({ schema: STAGING_BUCKET_BIRTH_SCHEMA, status: pinned.changed ? "pinned" : "already_pinned",
      bucket: desired.bucket.name, receiptFile, proof, pinned });
  }
  if (mode !== "apply") fail("STAGING_BUCKET_BIRTH_MODE_INVALID");
  const created = await runBucketBirth(desired, {
    apply: true,
    authorize,
    receiptPath,
    runner,
    fetchImpl,
    ...(reserveReceipt === undefined ? {} : { reserveReceipt }),
  });
  try {
    const { proof, pinned } = pinFromReceipt(created.receipt, desired, pinStore);
    return deepFreeze({ schema: STAGING_BUCKET_BIRTH_SCHEMA, status: "created_and_pinned",
      bucket: desired.bucket.name, receiptFile, proof, pinned });
  } catch (error) {
    // The bucket exists and its receipt is written; only the pin is missing.
    throw Object.assign(new GcpOpsInfraError(error instanceof GcpOpsInfraError ? error.code
      : "STAGING_BUCKET_PROOF_PIN_FAILED"), { bucketInserted: true, receiptWritten: true });
  }
}

const MODES = Object.freeze({ "--dry-run": "dry-run", "--apply": "apply", "--pin-only": "pin-only", "--verify": "verify" });

/** Closed argument parsing. */
export function parseStagingBucketBirthArgs(argv) {
  if (!Array.isArray(argv)) fail("STAGING_BUCKET_BIRTH_ARGUMENT_INVALID");
  let environment = null;
  let authorize = null;
  let mode = null;
  for (const argument of argv) {
    if (typeof argument !== "string") fail("STAGING_BUCKET_BIRTH_ARGUMENT_INVALID");
    if (Object.hasOwn(MODES, argument)) {
      if (mode !== null) fail("STAGING_BUCKET_BIRTH_ARGUMENT_INVALID");
      mode = MODES[argument];
    } else if (argument.startsWith("--environment=") && environment === null) {
      environment = argument.slice("--environment=".length);
    } else if (argument.startsWith("--authorize=") && authorize === null && argument.length > "--authorize=".length) {
      authorize = argument.slice("--authorize=".length);
    } else {
      fail("STAGING_BUCKET_BIRTH_ARGUMENT_INVALID");
    }
  }
  if (environment !== STAGING_BUCKET_BIRTH_ENVIRONMENT) fail("STAGING_BUCKET_BIRTH_ENVIRONMENT_REFUSED");
  const resolved = mode ?? "dry-run";
  if ((resolved === "apply") !== (authorize !== null)) fail("BUCKET_BIRTH_AUTHORIZATION_MISMATCH");
  return deepFreeze({ mode: resolved, authorize });
}

/** CLI entry; returns the exit code. */
export async function main(argv = process.argv.slice(2), {
  loadDesired = () => loadCommittedDesiredState(STAGING_BUCKET_BIRTH_ENVIRONMENT),
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
  ...options
} = {}) {
  const print = (value) => stdout(`${JSON.stringify(value, null, 2)}\n`);
  try {
    const config = parseStagingBucketBirthArgs(argv);
    print(await runStagingBucketBirth(loadDesired(), { ...options, mode: config.mode,
      ...(config.authorize === null ? {} : { authorize: config.authorize }) }));
    return 0;
  } catch (error) {
    const code = error instanceof GcpOpsInfraError ? error.code : "STAGING_BUCKET_BIRTH_FAILED";
    const inserted = error?.bucketInserted === true;
    const written = inserted && error.receiptWritten === true;
    const printed = inserted && !written && error.receipt !== undefined;
    if (printed) {
      // The receipt file failed after the insert: never lose the proof.
      print({ status: "created_receipt_unwritten", receipt: error.receipt });
    }
    // After an insert, always say where the proof is; both false means it is lost.
    stderr(`${JSON.stringify({ status: "error", code,
      ...(inserted ? { bucketInserted: true, receiptWritten: written, receiptPrinted: printed } : {}),
      ...(written ? { receiptFile: STAGING_BUCKET_BIRTH_RECEIPT_FILE } : {}),
      // Snapshot field names only (content-free), for a readback mismatch.
      ...(Array.isArray(error?.differingFields) ? { differingFields: error.differingFields } : {}),
    })}\n`);
    return 1;
  }
}

/** Compares real paths, so a symlinked entry still runs main(). */
export function isCliEntry(argvPath, moduleUrl = import.meta.url) {
  if (typeof argvPath !== "string" || argvPath.length === 0) return false;
  try {
    return realpathSync(resolve(argvPath)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isCliEntry(process.argv[1])) {
  process.exitCode = await main();
}
