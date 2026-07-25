import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { verifyPrivacySafeBundle } from "./export-privacy.js";
import { validateExportRecord } from "./export-schema.js";
import { stableJson } from "./storage.js";
import { DEFAULT_EXPORT_RESOURCE_LIMITS } from "./export-resource-policy.js";

const MAX_BUNDLE_BYTES = DEFAULT_EXPORT_RESOURCE_LIMITS.maximumCanonicalBundleBytes;
const MAX_RECEIPT_BYTES = 1024 * 1024;

export class BundleVerificationError extends Error {
  constructor(code) {
    super(`Bundle verification failed (${code})`);
    this.name = "BundleVerificationError";
    this.code = code;
  }
}

function fail(code) {
  throw new BundleVerificationError(code);
}

function assertOwnerOnlyRegular(stats, label, maximumBytes) {
  if (!stats.isFile() || stats.isSymbolicLink()) fail(`${label}_not_regular`);
  if (stats.nlink !== 1) fail(`${label}_link_count`);
  if (!Number.isSafeInteger(stats.size) || stats.size < 1 || stats.size > maximumBytes) fail(`${label}_size`);
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) fail(`${label}_owner`);
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) fail(`${label}_permissions`);
}

function assertOwnerControlledDirectory(stats) {
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail("parent_directory_type");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) fail("parent_directory_owner");
  if (process.platform !== "win32" && (stats.mode & 0o022) !== 0) fail("parent_directory_permissions");
}

async function readOwnerOnlyArtifact(path, label, maximumBytes) {
  let pathStats;
  try {
    pathStats = await lstat(path);
  } catch {
    fail(`${label}_missing`);
  }
  assertOwnerOnlyRegular(pathStats, label, maximumBytes);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const descriptorStats = await handle.stat();
    assertOwnerOnlyRegular(descriptorStats, label, maximumBytes);
    if (descriptorStats.dev !== pathStats.dev || descriptorStats.ino !== pathStats.ino) fail(`${label}_changed_during_open`);
    const bytes = await handle.readFile();
    if (bytes.length !== descriptorStats.size) fail(`${label}_changed_during_read`);
    return bytes;
  } catch (error) {
    if (error instanceof BundleVerificationError) throw error;
    fail(`${label}_read`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parseCanonicalJson(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label}_json`);
  }
  if (stableJson(value) !== bytes.toString("utf8")) fail(`${label}_not_canonical`);
  return value;
}

function assertByteSequence(value, label, maximumBytes) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) fail(`${label}_input`);
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 1 || value.byteLength > maximumBytes) {
    fail(`${label}_size`);
  }
  return Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function ordered(records, timeField, idField) {
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];
    const previousTime = Date.parse(previous[timeField]);
    const currentTime = Date.parse(current[timeField]);
    if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime) || previousTime > currentTime) return false;
    if (previousTime === currentTime && previous[idField] >= current[idField]) return false;
  }
  return true;
}

function hasUniqueIds(records, field) {
  return new Set(records.map((record) => record[field])).size === records.length;
}

function assertBundleSemantics(bundle) {
  const start = Date.parse(bundle.coveredAt.startAt);
  const end = Date.parse(bundle.coveredAt.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) fail("bundle_time_bounds");
  const totalRecords = bundle.recordCounts.usageEvents
    + bundle.recordCounts.quotaSnapshots
    + bundle.recordCounts.activityMarkers;
  if (totalRecords > DEFAULT_EXPORT_RESOURCE_LIMITS.maximumOutputRecords) fail("bundle_record_limit");
  const groups = [
    [bundle.records.usageEvents, "eventTime", "eventId"],
    [bundle.records.quotaSnapshots, "observedTime", "snapshotId"],
    [bundle.records.activityMarkers, "observedTime", "markerId"],
  ];
  for (const [records, timeField, idField] of groups) {
    if (!hasUniqueIds(records, idField)) fail("bundle_duplicate_ids");
    if (!ordered(records, timeField, idField)) fail("bundle_record_order");
    if (records.some((record) => {
      const time = Date.parse(record[timeField]);
      return !Number.isFinite(time) || time < start || time > end;
    })) fail("bundle_record_out_of_bounds");
  }
  for (const snapshot of bundle.records.quotaSnapshots) {
    const observed = Date.parse(snapshot.observedTime);
    const received = Date.parse(snapshot.receivedTime);
    if (!Number.isFinite(received) || received < start || received > end) fail("bundle_record_out_of_bounds");
    if (received < observed) fail("bundle_received_before_observed");
  }
  const declared = new Set(bundle.sourceProviders);
  const observed = [
    ...bundle.records.usageEvents.map((record) => record.provider),
    ...bundle.records.quotaSnapshots.map((record) => record.provider),
  ];
  if (observed.some((provider) => !declared.has(provider))) fail("bundle_provider_declaration");
}

export function loadVerifiedLocalMetadataBundleBytes({ bundleBytes, receiptBytes } = {}) {
  const canonicalReceiptBytes = assertByteSequence(receiptBytes, "receipt", MAX_RECEIPT_BYTES);
  const canonicalBundleBytes = assertByteSequence(bundleBytes, "bundle", MAX_BUNDLE_BYTES);
  const receipt = parseCanonicalJson(canonicalReceiptBytes, "receipt");
  if (!validateExportRecord("privacyReceipt", receipt).valid) fail("receipt_schema");
  if (receipt.bundleBytes > MAX_BUNDLE_BYTES) fail("receipt_bundle_size");
  if (canonicalBundleBytes.length !== receipt.bundleBytes) fail("bundle_digest");
  const bundle = parseCanonicalJson(canonicalBundleBytes, "bundle");
  if (!validateExportRecord("bundle", bundle).valid) fail("bundle_schema");
  assertBundleSemantics(bundle);
  if (receipt.createdAt !== bundle.createdAt) fail("receipt_created_at");

  let expectedReceipt;
  try {
    expectedReceipt = verifyPrivacySafeBundle(bundle, { createdAt: receipt.createdAt });
  } catch {
    fail("privacy_gate");
  }
  if (stableJson(expectedReceipt) !== stableJson(receipt)) fail("receipt_mismatch");
  const bundleSha256 = createHash("sha256").update(canonicalBundleBytes).digest("hex");
  if (bundleSha256 !== receipt.bundleSha256 || canonicalBundleBytes.length !== receipt.bundleBytes) fail("bundle_digest");

  const summary = {
    verdict: "passed",
    schemaVersion: bundle.schemaVersion,
    contractFamily: bundle.compatibility.contract.family,
    contractStatus: bundle.compatibility.contract.status,
    exporterVersion: bundle.compatibility.implementation.exporterVersion,
    bundleBytes: canonicalBundleBytes.length,
    recordCounts: structuredClone(bundle.recordCounts),
    transportReady: bundle.transportReady,
  };
  return {
    summary,
    bundle,
    receipt,
    bundleBytes: canonicalBundleBytes,
    receiptBytes: canonicalReceiptBytes,
    bundleSha256,
    receiptSha256: createHash("sha256").update(canonicalReceiptBytes).digest("hex"),
  };
}

export async function loadVerifiedLocalMetadataBundleFiles({ bundleFile, receiptFile } = {}) {
  if (!bundleFile || !receiptFile) fail("paths_required");
  const bundlePath = resolve(bundleFile);
  const receiptPath = resolve(receiptFile);
  if (bundlePath === receiptPath) fail("paths_not_distinct");
  let canonicalBundlePath;
  let canonicalReceiptPath;
  try {
    const bundleParent = await realpath(dirname(bundlePath));
    const receiptParent = await realpath(dirname(receiptPath));
    if (bundleParent !== receiptParent) fail("paths_not_adjacent");
    assertOwnerControlledDirectory(await lstat(bundleParent));
    canonicalBundlePath = join(bundleParent, basename(bundlePath));
    canonicalReceiptPath = join(receiptParent, basename(receiptPath));
  } catch (error) {
    if (error instanceof BundleVerificationError) throw error;
    fail("parent_directory");
  }

  const receiptBytes = await readOwnerOnlyArtifact(canonicalReceiptPath, "receipt", MAX_RECEIPT_BYTES);
  const bundleBytes = await readOwnerOnlyArtifact(canonicalBundlePath, "bundle", MAX_BUNDLE_BYTES);
  return loadVerifiedLocalMetadataBundleBytes({ bundleBytes, receiptBytes });
}

export async function verifyLocalMetadataBundleFiles(files = {}) {
  return (await loadVerifiedLocalMetadataBundleFiles(files)).summary;
}
