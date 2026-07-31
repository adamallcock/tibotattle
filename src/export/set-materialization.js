import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import { compressExportBytes, decompressExportBytes, EXPORT_GZIP_PROFILE } from "./compression.js";
import { assertValidExportRecord } from "./schema.js";
import {
  assertValidExportSetManifest,
  EXPORT_SET_CONTRACT_VERSION,
  EXPORT_SET_MANIFEST_RECEIPT_VERSION,
  EXPORT_SET_MANIFEST_SCHEMA_SHA256,
  EXPORT_SET_MANIFEST_VERSION,
  EXPORT_SET_ORDER_VERSION,
  EXPORT_SET_PACKING_VERSION,
} from "./set-schema.js";
import { stableJson } from "./canonical-json.js";

export const EXPORT_SET_ORDERING_VERSION = EXPORT_SET_ORDER_VERSION;
export const EXPORT_SET_MANIFEST_BASENAME = "export-set-manifest.json";
export const EXPORT_SET_MANIFEST_RECEIPT_BASENAME = "export-set-manifest.privacy-receipt.json";

const SAFE_SET_CODES = new Set([
  "workspace_incomplete", "record_too_large", "chunk_conflict", "manifest_conflict",
  "artifact_read", "mixed_representation",
]);

export class ExportSetError extends Error {
  constructor(code) {
    if (!SAFE_SET_CODES.has(code)) throw new TypeError("Unknown export-set failure code");
    super(`Local export set failed (${code})`);
    this.name = "ExportSetError";
    this.code = `export_set_${code}`;
  }
}

function fail(code) { throw new ExportSetError(code); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
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

/** Bind the two frozen source plans as independently named commitment fields. */
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
      || !Number.isSafeInteger(supplemental.sourceBytes) || supplemental.sourceBytes < 0) fail("workspace_incomplete");
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

function groupRecords(rows) {
  const groups = { usageEvents: [], quotaSnapshots: [], activityMarkers: [] };
  for (const row of rows) groups[row.family].push(row.record);
  return groups;
}
function recordCounts(records) {
  return { usageEvents: records.usageEvents.length, quotaSnapshots: records.quotaSnapshots.length, activityMarkers: records.activityMarkers.length };
}

function buildChunkBundle({ rows, descriptor, diagnostics, bundleId }) {
  const records = groupRecords(rows);
  const bundle = {
    schemaVersion: "usage-metadata-bundle-v0.1", compatibility: structuredClone(descriptor.compatibility),
    bundleId, participantId: descriptor.participantId, createdAt: descriptor.createdAt,
    coveredAt: structuredClone(descriptor.coveredAt), sourceProviders: [...descriptor.sourceProviders],
    clientPlatform: descriptor.clientPlatform, transportReady: false, recordCounts: recordCounts(records), records,
    diagnostics: structuredClone(diagnostics),
  };
  assertValidExportRecord("bundle", bundle);
  const bundleText = stableJson(bundle);
  return { bundle, bundleText, bundleBytes: Buffer.byteLength(bundleText) };
}
function compressChunkBundle(selected, maximumEncodedArtifactBytes) {
  const artifactContent = compressExportBytes(Buffer.from(selected.bundleText, "utf8"), {
    maximumDecodedBytes: selected.bundleBytes, maximumEncodedBytes: maximumEncodedArtifactBytes,
  });
  return { ...selected, artifactContent, artifactBytes: artifactContent.length };
}
function deterministicSetId(derivePseudonym, secret, descriptor, logicalRecordsSha256, chunking) {
  const sourcePlan = combinedSourcePlanCommitment(descriptor);
  return derivePseudonym(secret, "export-set", sha256(stableJson({
    identityVersion: "usage-export-set-id-v2", participantId: descriptor.participantId,
    createdAt: descriptor.createdAt, coveredAt: descriptor.coveredAt, compatibility: descriptor.compatibility,
    sourcePlanSha256: sourcePlan.sha256, logicalRecordsSha256, chunking,
  })));
}
function deterministicBundleId(derivePseudonym, secret, exportSetId, index) {
  return derivePseudonym(secret, "bundle", stableJson({ identityVersion: "usage-export-set-chunk-id-v1", exportSetId, index }));
}
function chooseLargestFittingPrefix({ pool, descriptor, diagnostics, bundleId, maximumBytes, resourceGuard }) {
  const empty = buildChunkBundle({ rows: [], descriptor, diagnostics, bundleId });
  const counts = { usageEvents: 0, quotaSnapshots: 0, activityMarkers: 0 };
  const embeddedBytes = { usageEvents: 0, quotaSnapshots: 0, activityMarkers: 0 };
  let selectedCount = 0;
  let selectedBytes = empty.bundleBytes;
  for (const [index, row] of pool.entries()) {
    resourceGuard?.checkRuntime(); counts[row.family] += 1; embeddedBytes[row.family] += row.embeddedRecordBytes;
    const usageGrowth = counts.usageEvents === 0 ? 0 : embeddedBytes.usageEvents + 6 + (2 * (counts.usageEvents - 1));
    const quotaGrowth = counts.quotaSnapshots === 0 ? 0 : embeddedBytes.quotaSnapshots + 6 + (2 * (counts.quotaSnapshots - 1));
    const markerGrowth = counts.activityMarkers === 0 ? 0 : embeddedBytes.activityMarkers + 6 + (2 * (counts.activityMarkers - 1));
    const candidateBytes = empty.bundleBytes + usageGrowth + quotaGrowth + markerGrowth
      + String(counts.usageEvents).length + String(counts.quotaSnapshots).length + String(counts.activityMarkers).length - 3;
    if (candidateBytes > maximumBytes) break;
    selectedCount = index + 1; selectedBytes = candidateBytes;
  }
  if (selectedCount === 0) fail("record_too_large");
  const selected = buildChunkBundle({ rows: pool.slice(0, selectedCount), descriptor, diagnostics, bundleId });
  if (selected.bundleBytes !== selectedBytes) throw new Error("Canonical chunk byte accounting mismatch");
  return { count: selectedCount, ...selected };
}
function assertVerifiedChunk(verified, expected) {
  if (verified.bundle.bundleId !== expected.bundleId || verified.bundle.participantId !== expected.participantId
      || verified.bundle.createdAt !== expected.createdAt || stableJson(verified.bundle.coveredAt) !== stableJson(expected.coveredAt)
      || stableJson(verified.bundle.recordCounts) !== stableJson(expected.recordCounts)
      || verified.bundleSha256 !== expected.bundleSha256 || verified.bundleBytes.length !== expected.bundleBytes
      || verified.receiptSha256 !== expected.receiptSha256 || verified.receiptBytes.length !== expected.receiptBytes) fail("chunk_conflict");
}
function manifestReceipt(manifestText) {
  return { schemaVersion: EXPORT_SET_MANIFEST_RECEIPT_VERSION, manifestSha256: sha256(manifestText), manifestBytes: Buffer.byteLength(manifestText), transportReady: false };
}

/** Content-only contract. Durable workspace and artifact capabilities remain application concerns. */
export function createExportSetMaterializationContract(configuration = {}) {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration) || isProxy(configuration)) {
    throw new TypeError("Export set materialization contract configuration is invalid");
  }
  const ownCallable = (key) => {
    const descriptor = Object.getOwnPropertyDescriptor(configuration, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function" || isProxy(descriptor.value)) {
      throw new TypeError("Export set materialization contract configuration is invalid");
    }
    return descriptor.value;
  };
  const deriveExportPseudonym = ownCallable("deriveExportPseudonym");
  const verifyPrivacySafeBundle = ownCallable("verifyPrivacySafeBundle");
  const loadVerifiedLocalMetadataBundleBytes = ownCallable("loadVerifiedLocalMetadataBundleBytes");
  return Object.freeze({
    sha256, fail, stableJson, computeWorkspaceLogicalRecordsSha256, combinedSourcePlanCommitment,
    buildChunkBundle, compressChunkBundle,
    deterministicSetId: (secret, descriptor, logicalRecordsSha256, chunking) =>
      deterministicSetId(deriveExportPseudonym, secret, descriptor, logicalRecordsSha256, chunking),
    deterministicBundleId: (secret, exportSetId, index) =>
      deterministicBundleId(deriveExportPseudonym, secret, exportSetId, index),
    chooseLargestFittingPrefix, assertVerifiedChunk, manifestReceipt, loadVerifiedLocalMetadataBundleBytes,
    decompressExportBytes, verifyPrivacySafeBundle, assertValidExportSetManifest,
    EXPORT_GZIP_PROFILE, EXPORT_SET_PACKING_VERSION, EXPORT_SET_CONTRACT_VERSION,
    EXPORT_SET_MANIFEST_SCHEMA_SHA256, EXPORT_SET_MANIFEST_VERSION,
  });
}
