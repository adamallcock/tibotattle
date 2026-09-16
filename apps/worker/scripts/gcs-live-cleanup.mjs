#!/usr/bin/env node

import { constants, promises as fs } from "node:fs";
import { resolve } from "node:path";

const storageOrigin = "https://storage.googleapis.com";
const bucketPrefix = "tibotattle-gcs-test-";
const runIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;
const runPrefixPattern = /^gcs-test\/runs\/([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)$/u;
const receiptSchema = "gcs-live-smoke-receipt-v1";
const cleanupSchema = "gcs-live-cleanup-receipt-v1";
const maxTargets = 64;
const maxTokenLifetime = 3_600;
const maxReceiptBytes = 256 * 1024;
const maxGeneration = 9_223_372_036_854_775_807n;

function fail(code) { throw new Error(code); }

function usage() {
  console.log(`Usage: node apps/worker/scripts/gcs-live-cleanup.mjs --bucket <test-bucket> --run-prefix <gcs-test/runs/<run-id>> --receipt-file <receipt> [--execute --access-token-file <0600-file> --expires-at <epoch-seconds>]\n\nDefault mode is an exact dry run. Cleanup never deletes a bucket or prefix; --execute issues only generation-conditioned requests for created keys in the receipt.`);
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return null;
  const values = new Map();
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--execute") {
      if (execute) fail("DUPLICATE_ARGUMENT");
      execute = true;
      continue;
    }
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail("INVALID_ARGUMENTS");
    }
    if (values.has(key)) fail("DUPLICATE_ARGUMENT");
    values.set(key, value);
    index += 1;
  }
  const required = ["--bucket", "--run-prefix", "--receipt-file"];
  if (required.some((key) => !values.has(key))) fail("INVALID_ARGUMENTS");
  const allowed = new Set([
    ...required,
    ...(execute ? ["--access-token-file", "--expires-at"] : []),
  ]);
  if ([...values.keys()].some((key) => !allowed.has(key))) fail("INVALID_ARGUMENTS");
  if (execute && (!values.has("--access-token-file") || !values.has("--expires-at"))) {
    fail("INVALID_ARGUMENTS");
  }
  const bucket = values.get("--bucket");
  if (typeof bucket !== "string"
      || !bucket.startsWith(bucketPrefix)
      || bucket.length > 63
      || !/^tibotattle-gcs-test-[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(bucket)) {
    fail("INVALID_BUCKET");
  }
  const runPrefix = values.get("--run-prefix");
  const runMatch = typeof runPrefix === "string" ? runPrefix.match(runPrefixPattern) : null;
  if (!runMatch || !runIdPattern.test(runMatch[1])) fail("INVALID_RUN_PREFIX");
  const receiptFile = values.get("--receipt-file");
  if (typeof receiptFile !== "string" || receiptFile.length === 0) fail("INVALID_RECEIPT_FILE");
  let expiry;
  if (execute) {
    const expiresAt = values.get("--expires-at");
    if (!/^\d{1,12}$/u.test(expiresAt ?? "")) fail("INVALID_EXPIRY");
    expiry = Number(expiresAt);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(expiry) || expiry <= now || expiry - now > maxTokenLifetime) {
      fail("INVALID_EXPIRY");
    }
  }
  return {
    bucket,
    runPrefix,
    receiptFile: resolve(receiptFile),
    execute,
    ...(execute ? { tokenFile: resolve(values.get("--access-token-file")), expiry } : {}),
  };
}

async function read0600Json(file, tooLargeCode) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600
        || stat.nlink !== 1 || stat.size < 1 || stat.size > maxReceiptBytes
        || (process.getuid && stat.uid !== process.getuid())) fail(tooLargeCode);
    const buffer = Buffer.alloc(maxReceiptBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const finalStat = await handle.stat();
    if (bytesRead > maxReceiptBytes || finalStat.size !== stat.size || finalStat.size > maxReceiptBytes) {
      fail(tooLargeCode);
    }
    return JSON.parse(buffer.toString("utf8", 0, bytesRead));
  } catch (error) {
    if (error?.message === tooLargeCode) throw error;
    fail(error?.code === "ENOENT" ? "RECEIPT_UNAVAILABLE" : "RECEIPT_INVALID");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readTokenFile(file) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600
        || stat.nlink !== 1 || stat.size < 1 || stat.size > 4096
        || (process.getuid && stat.uid !== process.getuid())) fail("TOKEN_FILE_PERMISSIONS");
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) fail("TOKEN_FILE_PERMISSIONS");
    const token = buffer.toString("utf8", 0, bytesRead).replace(/\r?\n$/u, "");
    if (token.length === 0 || /[\u0000-\u001f\u007f\s]/u.test(token)) fail("INVALID_ACCESS_TOKEN");
    return token;
  } catch (error) {
    if (/^[A-Z0-9_]+$/u.test(error?.message ?? "")) throw error;
    fail("TOKEN_FILE_UNAVAILABLE");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function ownKeys(value) {
  return Object.keys(value ?? {}).sort().join("\0");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function knownSmokeKey(key, runPrefix) {
  if (typeof key !== "string" || key.length > 1_024) return false;
  const escapedPrefix = escapeRegExp(runPrefix);
  return new RegExp(
    `^${escapedPrefix}/(?:appcast\\.xml|releases/[0-9]+\\.[0-9]+\\.[0-9]+/[a-f0-9]{64}/TiboTattle\\.dmg|scratch/(?:replace|race)\\.bin)$`,
    "u",
  ).test(key);
}

function validGeneration(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/u.test(value)) return false;
  try {
    return BigInt(value) <= maxGeneration;
  } catch {
    return false;
  }
}

function validateReceipt(value, args) {
  const expectedKeys = "attemptedKeys\0bucket\0createdKeys\0generations\0runId\0runPrefix\0schemaVersion\0status\0transportEvents";
  if (value?.schemaVersion !== receiptSchema
      || value.status !== "passed"
      || ownKeys(value) !== expectedKeys
      || value.bucket !== args.bucket
      || value.runPrefix !== args.runPrefix
      || typeof value.runId !== "string"
      || !runIdPattern.test(value.runId)
      || `${"gcs-test/runs"}/${value.runId}` !== value.runPrefix
      || !Array.isArray(value.attemptedKeys)
      || !Array.isArray(value.createdKeys)
      || !value.generations || typeof value.generations !== "object" || Array.isArray(value.generations)
      || !Array.isArray(value.transportEvents)) {
    fail(value?.status !== "passed" ? "RECEIPT_STATUS_UNSAFE" : "RECEIPT_INVALID");
  }
  if (value.attemptedKeys.length > maxTargets || value.createdKeys.length > maxTargets) {
    fail("RECEIPT_TARGET_LIMIT");
  }
  if (value.attemptedKeys.length !== value.createdKeys.length) {
    fail("RECEIPT_ATTEMPT_UNCERTAIN");
  }
  const attempted = new Set();
  for (const key of value.attemptedKeys) {
    if (!knownSmokeKey(key, args.runPrefix) || attempted.has(key)) {
      fail("RECEIPT_TARGET_UNKNOWN");
    }
    attempted.add(key);
  }
  const created = new Set();
  for (const key of value.createdKeys) {
    if (!attempted.has(key) || created.has(key)) fail("RECEIPT_TARGET_UNKNOWN");
    created.add(key);
  }
  const generationKeys = Object.keys(value.generations);
  if (generationKeys.length !== created.size || generationKeys.some((key) => !created.has(key))) {
    fail("RECEIPT_GENERATION_INVALID");
  }
  const targets = [];
  for (const key of value.createdKeys) {
    const generation = value.generations[key];
    if (!validGeneration(generation)) {
      fail("RECEIPT_GENERATION_INVALID");
    }
    targets.push({ key, generation });
  }
  return Object.freeze({
    schemaVersion: cleanupSchema,
    status: "dry-run",
    bucket: args.bucket,
    runPrefix: args.runPrefix,
    targets,
    physicalErasure: "unproven",
  });
}

function objectUrl(bucket, key, generation) {
  return `${storageOrigin}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}?ifGenerationMatch=${encodeURIComponent(generation)}`;
}

async function executeCleanup(args, dryRun) {
  if (dryRun.targets.length === 0) return { ...dryRun, status: "nothing-to-delete" };
  const token = await readTokenFile(args.tokenFile);
  const outcomes = [];
  for (const target of dryRun.targets) {
    if (Math.floor(Date.now() / 1000) >= args.expiry) {
      return {
        ...dryRun,
        status: "uncertain",
        code: "TOKEN_EXPIRED",
        physicalErasure: "unproven",
        outcomes,
      };
    }
    const response = await fetch(objectUrl(args.bucket, target.key, target.generation), {
      method: "DELETE",
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (response === null) {
      outcomes.push({ ...target, status: "unknown" });
      return {
        ...dryRun,
        code: "DELETE_OUTCOME_UNCERTAIN",
        status: "uncertain",
        physicalErasure: "unproven",
        outcomes,
      };
    }
    if (response.status !== 204 && response.status !== 404) {
      outcomes.push({ ...target, status: "unknown", httpStatus: response.status });
      return {
        ...dryRun,
        code: "DELETE_OUTCOME_UNCERTAIN",
        status: "uncertain",
        physicalErasure: "unproven",
        outcomes,
      };
    }
    outcomes.push({ ...target, status: response.status === 204 ? "delete-requested" : "already-absent" });
  }
  return {
    ...dryRun,
    status: "delete-requested",
    physicalErasure: "unproven",
    outcomes,
  };
}

async function main(args) {
  const receipt = await read0600Json(args.receiptFile, "RECEIPT_INVALID");
  const dryRun = validateReceipt(receipt, args);
  if (!args.execute) return dryRun;
  return executeCleanup(args, dryRun);
}

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
  if (parsed === null) {
    usage();
  } else {
    const result = await main(parsed);
    console.log(JSON.stringify(result));
    if (result.status === "uncertain") process.exitCode = 1;
  }
} catch (error) {
  const code = typeof error?.message === "string" && /^[A-Z0-9_]+$/u.test(error.message)
    ? error.message : "CLEANUP_FAILED";
  console.error(JSON.stringify({ status: "failed", code, targets: [] }));
  process.exitCode = 1;
}
