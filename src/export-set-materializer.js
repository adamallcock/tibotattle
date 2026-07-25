import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadVerifiedLocalMetadataBundleBytes } from "./bundle-verifier.js";
import {
  compressExportBytes,
  decompressExportBytes,
  EXPORT_GZIP_PROFILE,
} from "./export-compression.js";
import { deriveExportPseudonym, deriveParticipantId } from "./export-identity.js";
import { verifyPrivacySafeBundle } from "./export-privacy.js";
import { DEFAULT_EXPORT_RESOURCE_LIMITS, createExportResourceGuard } from "./export-resource-policy.js";
import { assertValidExportRecord } from "./export-schema.js";
import { openExportWorkspace } from "./export-workspace.js";
import { withExportWorkspaceLease } from "./export-workspace-lock.js";
import {
  assertValidExportSetManifest,
  EXPORT_SET_CONTRACT_VERSION,
  EXPORT_SET_MANIFEST_RECEIPT_VERSION,
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
  "mixed_representation",
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

function compressChunkBundle(selected, maximumEncodedArtifactBytes) {
  const bundleContent = Buffer.from(selected.bundleText, "utf8");
  const artifactContent = compressExportBytes(bundleContent, {
    maximumDecodedBytes: selected.bundleBytes,
    maximumEncodedBytes: maximumEncodedArtifactBytes,
  });
  return {
    ...selected,
    artifactContent,
    artifactBytes: artifactContent.length,
  };
}

function deterministicSetId(secret, descriptor, logicalRecordsSha256, chunking) {
  const sourcePlan = combinedSourcePlanCommitment(descriptor);
  const subject = stableJson({
    identityVersion: "usage-export-set-id-v2",
    participantId: descriptor.participantId,
    createdAt: descriptor.createdAt,
    coveredAt: descriptor.coveredAt,
    compatibility: descriptor.compatibility,
    sourcePlanSha256: sourcePlan.sha256,
    logicalRecordsSha256,
    chunking,
  });
  return deriveExportPseudonym(secret, "export-set", sha256(subject));
}

/**
 * Bind every frozen workspace source into one domain-separated commitment.
 * The two independently hashed plans are framed as named fields, so equal
 * concatenations cannot collide across the Codex and supplemental domains.
 */
export function combinedSourcePlanCommitment(descriptor) {
  const codex = descriptor?.sourcePlan;
  const supplemental = descriptor?.supplementalSourcePlan;
  if (!codex || !supplemental
      || typeof codex.sourcePlanSha256 !== "string" || !/^[a-f0-9]{64}$/.test(codex.sourcePlanSha256)
      || typeof supplemental.supplementalSourcePlanSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(supplemental.supplementalSourcePlanSha256)
      || !Number.isSafeInteger(codex.sourceFiles) || codex.sourceFiles < 0
      || !Number.isSafeInteger(codex.sourceBytes) || codex.sourceBytes < 0
      || !Number.isSafeInteger(supplemental.sourceFiles) || supplemental.sourceFiles < 0
      || !Number.isSafeInteger(supplemental.sourceBytes) || supplemental.sourceBytes < 0) {
    fail("workspace_incomplete");
  }
  const sourceFiles = codex.sourceFiles + supplemental.sourceFiles;
  const sourceBytes = codex.sourceBytes + supplemental.sourceBytes;
  if (!Number.isSafeInteger(sourceFiles) || !Number.isSafeInteger(sourceBytes)) fail("workspace_incomplete");
  return {
    sha256: sha256(stableJson({
      identityVersion: "usage-export-combined-source-plan/v1",
      codexSourcePlanSha256: codex.sourcePlanSha256,
      supplementalSourcePlanSha256: supplemental.supplementalSourcePlanSha256,
    })),
    sourceFiles,
    sourceBytes,
  };
}

function deterministicBundleId(secret, exportSetId, index) {
  return deriveExportPseudonym(secret, "bundle", stableJson({
    identityVersion: "usage-export-set-chunk-id-v1",
    exportSetId,
    index,
  }));
}

function chooseLargestFittingPrefix({
  pool,
  descriptor,
  diagnostics,
  bundleId,
  maximumBytes,
  resourceGuard,
}) {
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

async function assertNoPlainChunkArtifacts(directory) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    fail("artifact_read");
  }
  if (entries.some((name) => /^chunk-\d{6}\.bundle\.json$/.test(name))) fail("mixed_representation");
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

async function readOwnerOnlyExistingBytes(path, maximumBytes) {
  let pathStats;
  try {
    pathStats = await lstat(path);
  } catch {
    fail("artifact_read");
  }
  if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink !== 1
      || pathStats.size < 1 || pathStats.size > maximumBytes
      || (typeof process.getuid === "function" && pathStats.uid !== process.getuid())
      || (process.platform !== "win32" && (pathStats.mode & 0o077) !== 0)) fail("artifact_read");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const descriptorStats = await handle.stat();
    if (!descriptorStats.isFile() || descriptorStats.nlink !== 1
        || descriptorStats.dev !== pathStats.dev || descriptorStats.ino !== pathStats.ino
        || descriptorStats.size !== pathStats.size) fail("artifact_read");
    const bytes = await handle.readFile();
    if (bytes.length !== descriptorStats.size) fail("artifact_read");
    return bytes;
  } catch (error) {
    if (error instanceof ExportSetError) throw error;
    fail("artifact_read");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function publishChunk({ outputDirectory, index, artifactContent, receipt, metadata, failpoint }) {
  const bundleFile = join(outputDirectory, exportSetChunkBundleBasename(index));
  const receiptFile = join(outputDirectory, exportSetChunkReceiptBasename(index));
  const bundleExists = await exists(bundleFile);
  const receiptExists = await exists(receiptFile);
  if (bundleExists !== receiptExists) fail("chunk_conflict");
  if (!bundleExists) {
    await writeOwnerOnlyPairNoClobber({
      firstPath: bundleFile,
      firstContent: artifactContent,
      secondPath: receiptFile,
      secondContent: stableJson(receipt),
    });
    await failpoint("after_chunk_publish", index);
  }
  const artifactBytes = await readOwnerOnlyExistingBytes(bundleFile, metadata.artifactBytes);
  const receiptBytes = await readOwnerOnlyExistingBytes(receiptFile, metadata.receiptBytes);
  if (artifactBytes.length !== metadata.artifactBytes
      || sha256(artifactBytes) !== metadata.artifactSha256
      || receiptBytes.length !== metadata.receiptBytes
      || sha256(receiptBytes) !== metadata.receiptSha256) fail("chunk_conflict");
  let bundleBytes;
  let verified;
  try {
    bundleBytes = decompressExportBytes(artifactBytes, {
      maximumEncodedBytes: metadata.artifactBytes,
      maximumDecodedBytes: metadata.bundleBytes,
    });
    if (bundleBytes.length !== metadata.bundleBytes || sha256(bundleBytes) !== metadata.bundleSha256) {
      fail("chunk_conflict");
    }
    verified = loadVerifiedLocalMetadataBundleBytes({ bundleBytes, receiptBytes });
  } catch (error) {
    if (error instanceof ExportSetError) throw error;
    fail("chunk_conflict");
  }
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
    schemaVersion: EXPORT_SET_MANIFEST_RECEIPT_VERSION,
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
  maximumEncodedArtifactBytes = DEFAULT_EXPORT_RESOURCE_LIMITS.maximumEncodedArtifactBytes,
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
  if (!Number.isSafeInteger(maximumEncodedArtifactBytes) || maximumEncodedArtifactBytes < 1
      || maximumEncodedArtifactBytes > DEFAULT_EXPORT_RESOURCE_LIMITS.maximumEncodedArtifactBytes) {
    throw new TypeError("maximumEncodedArtifactBytes exceeds the resource policy");
  }
  const output = resolve(outputDirectory);
  const workspace = await openExportWorkspace({ directory: workspaceDirectory });
  let resourceGuard = null;
  try {
    if (!workspace.isScanComplete() || workspace.isPoisoned()) fail("workspace_incomplete");
    const descriptor = workspace.getDescriptor();
    if (descriptor.participantId !== deriveParticipantId(secret)) fail("workspace_incomplete");
    if (maximumRecordsPerChunk > descriptor.resourceLimits.maximumOutputRecords
        || maximumCanonicalBundleBytes > descriptor.resourceLimits.maximumCanonicalBundleBytes
        || maximumEncodedArtifactBytes > descriptor.resourceLimits.maximumEncodedArtifactBytes) {
      throw new TypeError("Materialization limits exceed the workspace resource policy");
    }
    if (await exists(output)) {
      await recoverOwnerOnlyPairTransactions({ directory: output });
      await assertNoPlainChunkArtifacts(output);
    }
    workspace.beginInvocation();
    resourceGuard = createExportResourceGuard({
      scope: "export_set",
      limits: descriptor.resourceLimits,
      initialUsage: workspace.resourceUsage(),
    });
    const workspaceStatus = await workspace.status();
    resourceGuard.observeWorkspace(workspaceStatus.workspaceBytes);
    resourceGuard.observeOutputTotals(
      Object.values(workspaceStatus.recordCounts).reduce((sum, count) => sum + count, 0),
      workspaceStatus.expandedRecordBytes,
    );
    const logicalRecordsSha256 = computeWorkspaceLogicalRecordsSha256(workspace, resourceGuard);
    const combinedSourcePlan = combinedSourcePlanCommitment(descriptor);
    const chunking = {
      orderingVersion: EXPORT_SET_ORDERING_VERSION,
      packingVersion: EXPORT_SET_PACKING_VERSION,
      maximumRecordsPerChunk,
      maximumCanonicalBundleBytes,
      maximumEncodedArtifactBytes,
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
      decodedBundleBytes: 0,
      encodedArtifactBytes: 0,
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
      let selected;
      if (emptySet && carry.length === 0) {
        const emptyBundle = buildChunkBundle({ rows: [], descriptor, diagnostics, bundleId });
        // Preserve the decoded canonical ceiling as the first failure boundary.
        resourceGuard.observeCanonicalBundle(emptyBundle.bundleBytes);
        selected = compressChunkBundle(emptyBundle, maximumEncodedArtifactBytes);
      } else {
        selected = chooseLargestFittingPrefix({
            pool: carry,
            descriptor,
            diagnostics,
            bundleId,
            maximumBytes: maximumCanonicalBundleBytes,
            resourceGuard,
          });
        resourceGuard.observeCanonicalBundle(selected.bundleBytes);
        selected = compressChunkBundle(selected, maximumEncodedArtifactBytes);
      }
      // Enforce the encoded artifact ceiling before recording or publishing.
      resourceGuard.observeEncodedArtifact(selected.artifactBytes);
      resourceGuard.observeExportSetBytes(
        totals.decodedBundleBytes + selected.bundleBytes,
        totals.encodedArtifactBytes + selected.artifactBytes,
      );
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
        contentEncoding: EXPORT_GZIP_PROFILE.contentEncoding,
        compressionProfile: EXPORT_GZIP_PROFILE.profile,
        artifactSha256: sha256(selected.artifactContent),
        artifactBytes: selected.artifactBytes,
        receiptSha256: sha256(receiptText),
        receiptBytes: Buffer.byteLength(receiptText),
        recordStart: recordOffset,
        recordEndExclusive: recordOffset + selectedCount,
        recordCounts: structuredClone(selected.bundle.recordCounts),
      };
      workspace.recordChunk(chunkIndex, "planned", metadata);
      resourceGuard.observeWorkspace(await workspace.storageBytes());
      await failpoint("after_chunk_plan", chunkIndex);
      await publishChunk({
        outputDirectory: output,
        index: chunkIndex,
        artifactContent: selected.artifactContent,
        receipt,
        metadata,
        failpoint,
      });
      workspace.recordChunk(chunkIndex, "verified", metadata);
      resourceGuard.observeWorkspace(await workspace.storageBytes());
      await failpoint("after_chunk_verify", chunkIndex);
      chunks.push({
        index: metadata.index,
        bundleId: metadata.bundleId,
        bundleSha256: metadata.bundleSha256,
        bundleBytes: metadata.bundleBytes,
        contentEncoding: metadata.contentEncoding,
        compressionProfile: metadata.compressionProfile,
        artifactSha256: metadata.artifactSha256,
        artifactBytes: metadata.artifactBytes,
        receiptSha256: metadata.receiptSha256,
        receiptBytes: metadata.receiptBytes,
        recordStart: metadata.recordStart,
        recordEndExclusive: metadata.recordEndExclusive,
        recordCounts: metadata.recordCounts,
      });
      addCounts(totals.recordCounts, metadata.recordCounts);
      totals.decodedBundleBytes += metadata.bundleBytes;
      totals.encodedArtifactBytes += metadata.artifactBytes;
      totals.receiptBytes += metadata.receiptBytes;
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
      compressionRuntime: {
        nodeVersion: process.versions.node,
        zlibVersion: process.versions.zlib,
      },
      sourcePlan: {
        sha256: combinedSourcePlan.sha256,
        sourceFiles: combinedSourcePlan.sourceFiles,
        sourceBytes: combinedSourcePlan.sourceBytes,
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
    resourceGuard.observeWorkspace(await workspace.storageBytes());
    return {
      manifest,
      manifestReceipt: receipt,
      manifestFile,
      manifestReceiptFile,
      resourceUsage: resourceGuard.snapshot(),
    };
  } finally {
    let durableUsage = null;
    try {
      durableUsage = resourceGuard?.durableSnapshot() ?? null;
    } catch {
      // Preserve the invocation marker when the guard itself cannot produce a
      // valid terminal snapshot. The next resume will reserve crash time.
    }
    if (resourceGuard && durableUsage) workspace.finishInvocation({ resourceUsage: durableUsage });
    workspace.close();
  }
}

export async function materializeLocalExportSet(options = {}) {
  if (!options.workspaceDirectory) throw new Error("Export workspace directory is required");
  return withExportWorkspaceLease(options.workspaceDirectory, () => materializeLocalExportSetUnlocked(options));
}
