import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadVerifiedLocalMetadataBundleFiles } from "./bundle-verifier.js";
import { deriveExportPseudonym, deriveParticipantId } from "./export-identity.js";
import { verifyPrivacySafeBundle } from "./export-privacy.js";
import { DEFAULT_EXPORT_RESOURCE_LIMITS, createExportResourceGuard, ExportResourceLimitError } from "./export-resource-policy.js";
import { assertValidExportRecord } from "./export-schema.js";
import { openExportWorkspace } from "./export-workspace.js";
import { withExportWorkspaceLease } from "./export-workspace-lock.js";
import {
  assertValidExportSetManifest,
  EXPORT_SET_CONTRACT_VERSION,
  EXPORT_SET_MANIFEST_SCHEMA_SHA256,
  EXPORT_SET_MANIFEST_VERSION,
  EXPORT_SET_ORDER_VERSION,
  EXPORT_SET_PACKING_VERSION,
  exportSetChunkBundleBasename,
  exportSetChunkReceiptBasename,
} from "./export-set-schema.js";
import {
  recoverOwnerOnlyPairTransactions,
  stableJson,
  writeOwnerOnlyPairNoClobber,
} from "./storage.js";

export const EXPORT_SET_ORDERING_VERSION = EXPORT_SET_ORDER_VERSION;

const SAFE_SET_CODES = new Set([
  "workspace_incomplete",
  "record_too_large",
  "chunk_conflict",
  "manifest_conflict",
  "artifact_read",
]);

export class ExportSetError extends Error {
  constructor(code) {
    if (!SAFE_SET_CODES.has(code)) throw new TypeError("Unknown export-set failure code");
    super(`Local export set failed (${code})`);
    this.name = "ExportSetError";
    this.code = `export_set_${code}`;
  }
}

function fail(code) {
  throw new ExportSetError(code);
}

export const EXPORT_SET_MANIFEST_BASENAME = "export-set-manifest.json";
export const EXPORT_SET_MANIFEST_RECEIPT_BASENAME = "export-set-manifest.privacy-receipt.json";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function lengthFrame(bytes) {
  const size = Buffer.allocUnsafe(8);
  size.writeBigUInt64BE(BigInt(bytes.length));
  return [size, bytes];
}

export function computeWorkspaceLogicalRecordsSha256(workspace, resourceGuard = null) {
  const digest = createHash("sha256");
  digest.update("app-usagemonitor/export-set-logical-records/v1\0");
  for (const row of workspace.iterateRecords()) {
    resourceGuard?.checkRuntime();
    const frame = Buffer.from(stableJson({ family: row.family, record: row.record }), "utf8");
    for (const part of lengthFrame(frame)) digest.update(part);
  }
  return digest.digest("hex");
}

function groupRecords(rows) {
  const groups = { usageEvents: [], quotaSnapshots: [], activityMarkers: [] };
  for (const row of rows) groups[row.family].push(row.record);
  return groups;
}

function recordCounts(records) {
  return {
    usageEvents: records.usageEvents.length,
    quotaSnapshots: records.quotaSnapshots.length,
    activityMarkers: records.activityMarkers.length,
  };
}

function addCounts(target, value) {
  for (const family of ["usageEvents", "quotaSnapshots", "activityMarkers"]) target[family] += value[family];
}

function buildChunkBundle({ rows, descriptor, diagnostics, bundleId }) {
  const records = groupRecords(rows);
  const bundle = {
    schemaVersion: "usage-metadata-bundle-v0.1",
    compatibility: structuredClone(descriptor.compatibility),
    bundleId,
    participantId: descriptor.participantId,
    createdAt: descriptor.createdAt,
    coveredAt: structuredClone(descriptor.coveredAt),
    sourceProviders: [...descriptor.sourceProviders],
    clientPlatform: descriptor.clientPlatform,
    transportReady: false,
    recordCounts: recordCounts(records),
    records,
    diagnostics: structuredClone(diagnostics),
  };
  assertValidExportRecord("bundle", bundle);
  const bundleText = stableJson(bundle);
  return { bundle, bundleText, bundleBytes: Buffer.byteLength(bundleText) };
}

function deterministicSetId(secret, descriptor, logicalRecordsSha256, chunking) {
  const subject = stableJson({
    identityVersion: "usage-export-set-id-v1",
    participantId: descriptor.participantId,
    createdAt: descriptor.createdAt,
    coveredAt: descriptor.coveredAt,
    compatibility: descriptor.compatibility,
    sourcePlanSha256: descriptor.sourcePlan.sourcePlanSha256,
    logicalRecordsSha256,
    chunking,
  });
  return deriveExportPseudonym(secret, "export-set", sha256(subject));
}

function deterministicBundleId(secret, exportSetId, index) {
  return deriveExportPseudonym(secret, "bundle", stableJson({
    identityVersion: "usage-export-set-chunk-id-v1",
    exportSetId,
    index,
  }));
}

function chooseLargestFittingPrefix({ pool, descriptor, diagnostics, bundleId, maximumBytes, resourceGuard }) {
  const empty = buildChunkBundle({ rows: [], descriptor, diagnostics, bundleId });
  const counts = { usageEvents: 0, quotaSnapshots: 0, activityMarkers: 0 };
  const embeddedBytes = { usageEvents: 0, quotaSnapshots: 0, activityMarkers: 0 };
  let selectedCount = 0;
  let selectedBytes = empty.bundleBytes;
  for (const [index, row] of pool.entries()) {
    resourceGuard?.checkRuntime();
    counts[row.family] += 1;
    embeddedBytes[row.family] += row.embeddedRecordBytes;
    const usageGrowth = counts.usageEvents === 0
      ? 0 : embeddedBytes.usageEvents + 6 + (2 * (counts.usageEvents - 1));
    const quotaGrowth = counts.quotaSnapshots === 0
      ? 0 : embeddedBytes.quotaSnapshots + 6 + (2 * (counts.quotaSnapshots - 1));
    const markerGrowth = counts.activityMarkers === 0
      ? 0 : embeddedBytes.activityMarkers + 6 + (2 * (counts.activityMarkers - 1));
    const arrayGrowth = usageGrowth + quotaGrowth + markerGrowth;
    const countDigitGrowth = String(counts.usageEvents).length
      + String(counts.quotaSnapshots).length
      + String(counts.activityMarkers).length - 3;
    const candidateBytes = empty.bundleBytes + arrayGrowth + countDigitGrowth;
    if (candidateBytes > maximumBytes) break;
    selectedCount = index + 1;
    selectedBytes = candidateBytes;
  }
  if (selectedCount === 0) fail("record_too_large");
  const selected = buildChunkBundle({
    rows: pool.slice(0, selectedCount),
    descriptor,
    diagnostics,
    bundleId,
  });
  if (selected.bundleBytes !== selectedBytes) {
    throw new Error("Canonical chunk byte accounting mismatch");
  }
  return { count: selectedCount, ...selected };
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function assertVerifiedChunk(verified, expected) {
  if (verified.bundle.bundleId !== expected.bundleId
      || verified.bundle.participantId !== expected.participantId
      || verified.bundle.createdAt !== expected.createdAt
      || stableJson(verified.bundle.coveredAt) !== stableJson(expected.coveredAt)
      || stableJson(verified.bundle.recordCounts) !== stableJson(expected.recordCounts)
      || verified.bundleSha256 !== expected.bundleSha256
      || verified.bundleBytes.length !== expected.bundleBytes
      || verified.receiptSha256 !== expected.receiptSha256
      || verified.receiptBytes.length !== expected.receiptBytes) fail("chunk_conflict");
}

async function publishChunk({ outputDirectory, index, bundle, bundleText, receipt, metadata, failpoint }) {
  const bundleFile = join(outputDirectory, exportSetChunkBundleBasename(index));
  const receiptFile = join(outputDirectory, exportSetChunkReceiptBasename(index));
  const bundleExists = await exists(bundleFile);
  const receiptExists = await exists(receiptFile);
  if (bundleExists !== receiptExists) fail("chunk_conflict");
  if (!bundleExists) {
    await writeOwnerOnlyPairNoClobber({
      firstPath: bundleFile,
      firstContent: bundleText,
      secondPath: receiptFile,
      secondContent: stableJson(receipt),
    });
    await failpoint("after_chunk_publish", index);
  }
  const verified = await loadVerifiedLocalMetadataBundleFiles({ bundleFile, receiptFile });
  assertVerifiedChunk(verified, metadata);
  return verified;
}

async function readCanonicalExisting(path, maximumBytes) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    fail("artifact_read");
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
      || stats.size < 1 || stats.size > maximumBytes
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) fail("artifact_read");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const descriptorStats = await handle.stat();
    if (descriptorStats.dev !== stats.dev || descriptorStats.ino !== stats.ino
        || descriptorStats.size !== stats.size || descriptorStats.nlink !== stats.nlink) fail("artifact_read");
    const text = await handle.readFile("utf8");
    const value = JSON.parse(text);
    if (stableJson(value) !== text) fail("artifact_read");
    return { value, text };
  } catch (error) {
    if (error instanceof ExportSetError) throw error;
    fail("artifact_read");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function manifestReceipt(manifestText) {
  return {
    schemaVersion: "export-set-manifest-receipt-v0.1",
    manifestSha256: sha256(manifestText),
    manifestBytes: Buffer.byteLength(manifestText),
    transportReady: false,
  };
}

async function materializeLocalExportSetUnlocked({
  workspaceDirectory,
  outputDirectory,
  secret,
  maximumRecordsPerChunk = DEFAULT_EXPORT_RESOURCE_LIMITS.maximumOutputRecords,
  maximumCanonicalBundleBytes = DEFAULT_EXPORT_RESOURCE_LIMITS.maximumCanonicalBundleBytes,
  failpoint = async () => {},
} = {}) {
  if (!secret) throw new Error("A participant export secret is required");
  if (!Number.isSafeInteger(maximumRecordsPerChunk) || maximumRecordsPerChunk < 1
      || maximumRecordsPerChunk > DEFAULT_EXPORT_RESOURCE_LIMITS.maximumOutputRecords) {
    throw new TypeError("maximumRecordsPerChunk exceeds the resource policy");
  }
  if (!Number.isSafeInteger(maximumCanonicalBundleBytes) || maximumCanonicalBundleBytes < 1
      || maximumCanonicalBundleBytes > DEFAULT_EXPORT_RESOURCE_LIMITS.maximumCanonicalBundleBytes) {
    throw new TypeError("maximumCanonicalBundleBytes exceeds the resource policy");
  }
  const output = resolve(outputDirectory);
  if (await exists(output)) await recoverOwnerOnlyPairTransactions({ directory: output });
  const workspace = await openExportWorkspace({ directory: workspaceDirectory });
  try {
    if (!workspace.isScanComplete() || workspace.isPoisoned()) fail("workspace_incomplete");
    const descriptor = workspace.getDescriptor();
    if (descriptor.participantId !== deriveParticipantId(secret)) {
      fail("workspace_incomplete");
    }
    const resourceGuard = createExportResourceGuard({ scope: "export_set" });
    const workspaceStatus = await workspace.status();
    resourceGuard.observeWorkspace(workspaceStatus.workspaceBytes);
    resourceGuard.observeOutputTotals(
      Object.values(workspaceStatus.recordCounts).reduce((sum, count) => sum + count, 0),
      workspaceStatus.expandedRecordBytes,
    );
    const logicalRecordsSha256 = computeWorkspaceLogicalRecordsSha256(workspace, resourceGuard);
    const chunking = {
      orderingVersion: EXPORT_SET_ORDERING_VERSION,
      packingVersion: EXPORT_SET_PACKING_VERSION,
      maximumRecordsPerChunk,
      maximumCanonicalBundleBytes,
    };
    const exportSetId = deterministicSetId(secret, descriptor, logicalRecordsSha256, chunking);
    const diagnostics = workspace.scanDiagnostics();
    const iterator = workspace.iterateRecords();
    let next = iterator.next();
    let carry = [];
    let carryBytes = 0;
    let recordOffset = 0;
    let chunkIndex = 0;
    const chunks = [];
    const totals = {
      recordCounts: { usageEvents: 0, quotaSnapshots: 0, activityMarkers: 0 },
      logicalRecordsSha256,
      bundleBytes: 0,
      receiptBytes: 0,
    };
    const emptySet = next.done;
    while (!next.done || carry.length > 0 || (emptySet && chunkIndex === 0)) {
      resourceGuard.observeChunkCount(chunkIndex + 1);
      while (!next.done && carry.length < maximumRecordsPerChunk && carryBytes <= maximumCanonicalBundleBytes) {
        carry.push(next.value);
        carryBytes += next.value.recordBytes;
        next = iterator.next();
      }
      const bundleId = deterministicBundleId(secret, exportSetId, chunkIndex);
      const selected = emptySet && carry.length === 0
        ? buildChunkBundle({ rows: [], descriptor, diagnostics, bundleId })
        : chooseLargestFittingPrefix({
            pool: carry,
            descriptor,
            diagnostics,
            bundleId,
            maximumBytes: maximumCanonicalBundleBytes,
            resourceGuard,
          });
      const selectedCount = emptySet && carry.length === 0 ? 0 : selected.count;
      const receipt = verifyPrivacySafeBundle(selected.bundle, { createdAt: descriptor.createdAt });
      const receiptText = stableJson(receipt);
      const metadata = {
        index: chunkIndex,
        bundleId,
        participantId: descriptor.participantId,
        createdAt: descriptor.createdAt,
        coveredAt: structuredClone(descriptor.coveredAt),
        bundleSha256: sha256(selected.bundleText),
        bundleBytes: selected.bundleBytes,
        receiptSha256: sha256(receiptText),
        receiptBytes: Buffer.byteLength(receiptText),
        recordStart: recordOffset,
        recordEndExclusive: recordOffset + selectedCount,
        recordCounts: structuredClone(selected.bundle.recordCounts),
      };
      workspace.recordChunk(chunkIndex, "planned", metadata);
      await failpoint("after_chunk_plan", chunkIndex);
      await publishChunk({
        outputDirectory: output,
        index: chunkIndex,
        bundle: selected.bundle,
        bundleText: selected.bundleText,
        receipt,
        metadata,
        failpoint,
      });
      workspace.recordChunk(chunkIndex, "verified", metadata);
      await failpoint("after_chunk_verify", chunkIndex);
      chunks.push({
        index: metadata.index,
        bundleId: metadata.bundleId,
        bundleSha256: metadata.bundleSha256,
        bundleBytes: metadata.bundleBytes,
        receiptSha256: metadata.receiptSha256,
        receiptBytes: metadata.receiptBytes,
        recordStart: metadata.recordStart,
        recordEndExclusive: metadata.recordEndExclusive,
        recordCounts: metadata.recordCounts,
      });
      addCounts(totals.recordCounts, metadata.recordCounts);
      totals.bundleBytes += metadata.bundleBytes;
      totals.receiptBytes += metadata.receiptBytes;
      resourceGuard.observeCanonicalBundle(metadata.bundleBytes);
      recordOffset += selectedCount;
      carry = carry.slice(selectedCount);
      carryBytes = carry.reduce((sum, row) => sum + row.recordBytes, 0);
      chunkIndex += 1;
      if (emptySet) break;
    }
    const manifest = {
      schemaVersion: EXPORT_SET_MANIFEST_VERSION,
      manifestContract: {
        version: EXPORT_SET_CONTRACT_VERSION,
        schemaSha256: EXPORT_SET_MANIFEST_SCHEMA_SHA256,
      },
      compatibility: structuredClone(descriptor.compatibility),
      exportSetId,
      participantId: descriptor.participantId,
      createdAt: descriptor.createdAt,
      coveredAt: structuredClone(descriptor.coveredAt),
      sourceProviders: [...descriptor.sourceProviders],
      clientPlatform: descriptor.clientPlatform,
      transportReady: false,
      completionStatus: "complete",
      sourcePlan: {
        sha256: descriptor.sourcePlan.sourcePlanSha256,
        sourceFiles: descriptor.sourcePlan.sourceFiles,
        sourceBytes: descriptor.sourcePlan.sourceBytes,
      },
      chunking,
      totals,
      chunks,
    };
    assertValidExportSetManifest(manifest);
    const manifestText = stableJson(manifest);
    resourceGuard.observeManifest(Buffer.byteLength(manifestText));
    const receipt = manifestReceipt(manifestText);
    const manifestFile = join(output, EXPORT_SET_MANIFEST_BASENAME);
    const manifestReceiptFile = join(output, EXPORT_SET_MANIFEST_RECEIPT_BASENAME);
    const existingManifest = await readCanonicalExisting(manifestFile, resourceGuard.limits.maximumManifestBytes);
    const existingReceipt = await readCanonicalExisting(manifestReceiptFile, 1024 * 1024);
    if (Boolean(existingManifest) !== Boolean(existingReceipt)) fail("manifest_conflict");
    if (existingManifest) {
      if (existingManifest.text !== manifestText || stableJson(existingReceipt.value) !== stableJson(receipt)) {
        fail("manifest_conflict");
      }
    } else {
      await writeOwnerOnlyPairNoClobber({
        firstPath: manifestFile,
        firstContent: manifestText,
        secondPath: manifestReceiptFile,
        secondContent: stableJson(receipt),
      });
      await failpoint("after_manifest_publish", null);
    }
    const manifestMetadata = {
      exportSetId,
      manifestSha256: receipt.manifestSha256,
      manifestBytes: receipt.manifestBytes,
      chunkCount: chunks.length,
    };
    workspace.markManifestComplete(manifestMetadata);
    return {
      manifest,
      manifestReceipt: receipt,
      manifestFile,
      manifestReceiptFile,
      resourceUsage: resourceGuard.snapshot(),
    };
  } finally {
    workspace.close();
  }
}

export async function materializeLocalExportSet(options = {}) {
  if (!options.workspaceDirectory) throw new Error("Export workspace directory is required");
  return withExportWorkspaceLease(options.workspaceDirectory, () => materializeLocalExportSetUnlocked(options));
}
