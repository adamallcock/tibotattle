import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { exportCompatibilityTuple } from "../src/export-contract.js";
import {
  assertValidExportSetManifest,
  EXPORT_SET_CONTRACT_VERSION,
  EXPORT_SET_CONTRACT_VERSION_V0_2,
  EXPORT_SET_MANIFEST_RECEIPT_VERSION,
  EXPORT_SET_MANIFEST_RECEIPT_VERSION_V0_2,
  EXPORT_SET_MANIFEST_SCHEMA_SHA256,
  EXPORT_SET_MANIFEST_SCHEMA_SHA256_V0_2,
  EXPORT_SET_MANIFEST_VERSION,
  EXPORT_SET_MANIFEST_VERSION_V0_2,
  EXPORT_SET_ORDER_VERSION,
  EXPORT_SET_PACKING_VERSION,
  EXPORT_SET_PACKING_VERSION_V0_1,
  EXPORT_SET_PACKING_VERSION_V0_2,
  exportSetChunkBasenames,
  exportSetChunkBundleBasename,
  exportSetManifestSchema,
  exportSetManifestSchemaV0_2,
  validateExportSetManifest,
} from "../src/export-set-schema.js";

function recordCounts(usageEvents, quotaSnapshots = 0, activityMarkers = 0) {
  return { usageEvents, quotaSnapshots, activityMarkers };
}

function manifest() {
  return {
    schemaVersion: EXPORT_SET_MANIFEST_VERSION_V0_2,
    manifestContract: {
      version: EXPORT_SET_CONTRACT_VERSION_V0_2,
      schemaSha256: EXPORT_SET_MANIFEST_SCHEMA_SHA256_V0_2,
    },
    compatibility: exportCompatibilityTuple(),
    exportSetId: `export-set:v1:${"a".repeat(64)}`,
    participantId: `participant:v1:${"b".repeat(64)}`,
    createdAt: "2026-07-24T13:00:00.000Z",
    coveredAt: { startAt: "2026-07-24T11:00:00.000Z", endAt: "2026-07-24T13:00:00.000Z" },
    sourceProviders: ["openai_codex"],
    clientPlatform: "macos",
    transportReady: false,
    completionStatus: "complete",
    compressionRuntime: {
      nodeVersion: "20.0.0",
      zlibVersion: "1.2.13",
    },
    sourcePlan: { sha256: "c".repeat(64), sourceFiles: 2, sourceBytes: 2000 },
    chunking: {
      orderingVersion: EXPORT_SET_ORDER_VERSION,
      packingVersion: EXPORT_SET_PACKING_VERSION,
      maximumRecordsPerChunk: 2,
      maximumCanonicalBundleBytes: 4096,
      maximumEncodedArtifactBytes: 4608,
    },
    totals: {
      recordCounts: recordCounts(2, 1),
      logicalRecordsSha256: "d".repeat(64),
      decodedBundleBytes: 3500,
      encodedArtifactBytes: 1900,
      receiptBytes: 1500,
    },
    chunks: [
      {
        index: 0,
        bundleId: `bundle:v1:${"e".repeat(64)}`,
        bundleSha256: "1".repeat(64),
        bundleBytes: 2000,
        contentEncoding: "gzip",
        compressionProfile: "gzip-level-6-v1",
        artifactSha256: "5".repeat(64),
        artifactBytes: 1000,
        receiptSha256: "2".repeat(64),
        receiptBytes: 700,
        recordStart: 0,
        recordEndExclusive: 2,
        recordCounts: recordCounts(2),
      },
      {
        index: 1,
        bundleId: `bundle:v1:${"f".repeat(64)}`,
        bundleSha256: "3".repeat(64),
        bundleBytes: 1500,
        contentEncoding: "gzip",
        compressionProfile: "gzip-level-6-v1",
        artifactSha256: "6".repeat(64),
        artifactBytes: 900,
        receiptSha256: "4".repeat(64),
        receiptBytes: 800,
        recordStart: 2,
        recordEndExclusive: 3,
        recordCounts: recordCounts(0, 1),
      },
    ],
  };
}

test("v0.2 current aliases bind the exact immutable compressed manifest schema", async () => {
  assert.equal(EXPORT_SET_MANIFEST_VERSION, EXPORT_SET_MANIFEST_VERSION_V0_2);
  assert.equal(EXPORT_SET_CONTRACT_VERSION, EXPORT_SET_CONTRACT_VERSION_V0_2);
  assert.equal(EXPORT_SET_MANIFEST_RECEIPT_VERSION, EXPORT_SET_MANIFEST_RECEIPT_VERSION_V0_2);
  assert.equal(EXPORT_SET_MANIFEST_SCHEMA_SHA256, EXPORT_SET_MANIFEST_SCHEMA_SHA256_V0_2);
  assert.equal(EXPORT_SET_PACKING_VERSION, EXPORT_SET_PACKING_VERSION_V0_2);
  assert.equal(EXPORT_SET_PACKING_VERSION_V0_1, "greedy-canonical-bundle-v1");
  assert.equal(EXPORT_SET_PACKING_VERSION_V0_2, "greedy-canonical-bundle-v1");
  assert.equal(EXPORT_SET_PACKING_VERSION_V0_2, EXPORT_SET_PACKING_VERSION_V0_1);
  assert.equal(exportSetManifestSchema, exportSetManifestSchemaV0_2);
  assert.equal(exportSetManifestSchema.$id, "https://app-usagemonitor.local/schemas/export-set-v0.2/manifest.schema.json");

  const bytes = await readFile(new URL("../schemas/export-set-v0.2/manifest.schema.json", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), EXPORT_SET_MANIFEST_SCHEMA_SHA256_V0_2);
});

test("v0.2 accepts the exact encoded and decoded artifact contract", () => {
  const value = manifest();
  assert.deepEqual(validateExportSetManifest(value), { valid: true, errors: [] });
  assert.equal(assertValidExportSetManifest(value), value);
});

test("v0.2 rejects pre-migration base64url-shaped identifiers", () => {
  const value = manifest();
  value.participantId = `participant:v1:${"A".repeat(43)}`;
  value.chunks[0].bundleId = `bundle:v1:${"B".repeat(43)}`;
  assert.equal(validateExportSetManifest(value).valid, false);
});

test("v0.2 records but does not require the verifier's compression runtime", () => {
  const value = manifest();
  value.compressionRuntime = {
    nodeVersion: "99.123.456-nightly+foreign",
    zlibVersion: "9.8.7-custom_build",
  };
  assert.deepEqual(validateExportSetManifest(value), { valid: true, errors: [] });
});

test("v0.2 rejects missing representation fields, legacy totals, and unknown fields", () => {
  for (const mutate of [
    (value) => { delete value.chunking.maximumEncodedArtifactBytes; },
    (value) => { delete value.compressionRuntime; },
    (value) => { delete value.compressionRuntime.nodeVersion; },
    (value) => { delete value.compressionRuntime.zlibVersion; },
    (value) => { value.compressionRuntime.privateRuntimePath = "/Users/private/node"; },
    (value) => { delete value.chunks[0].contentEncoding; },
    (value) => { delete value.chunks[0].compressionProfile; },
    (value) => { delete value.chunks[0].artifactSha256; },
    (value) => { delete value.chunks[0].artifactBytes; },
    (value) => { value.totals.bundleBytes = value.totals.decodedBundleBytes; },
    (value) => { value.chunks[0].privatePath = "/Users/private/work"; },
  ]) {
    const candidate = manifest();
    mutate(candidate);
    const result = validateExportSetManifest(candidate);
    assert.equal(result.valid, false);
    assert.equal(JSON.stringify(result.errors).includes("/Users/private/work"), false);
  }
});

test("v0.2 bounds compression provenance to content-free safe version strings", () => {
  for (const mutate of [
    (value) => { value.compressionRuntime.nodeVersion = ""; },
    (value) => { value.compressionRuntime.nodeVersion = "v20.0.0 (private build)"; },
    (value) => { value.compressionRuntime.nodeVersion = "2".repeat(65); },
    (value) => { value.compressionRuntime.zlibVersion = "1.3.1/private"; },
    (value) => { value.compressionRuntime.zlibVersion = "z".repeat(65); },
  ]) {
    const candidate = manifest();
    mutate(candidate);
    const result = validateExportSetManifest(candidate);
    assert.equal(result.valid, false);
    assert.equal(JSON.stringify(result.errors).includes("private"), false);
  }
});

test("v0.2 keeps decoded packing separate from compression and enforces independent chunk ceilings", () => {
  for (const mutate of [
    (value) => { value.chunking.packingVersion = "greedy-canonical-gzip-v2"; },
    (value) => { value.chunks[0].contentEncoding = "br"; },
    (value) => { value.chunks[0].compressionProfile = "gzip-level-9-v1"; },
    (value) => {
      value.chunks[0].bundleBytes = value.chunking.maximumCanonicalBundleBytes + 1;
      value.totals.decodedBundleBytes = value.chunks[0].bundleBytes + value.chunks[1].bundleBytes;
    },
    (value) => {
      value.chunks[0].artifactBytes = value.chunking.maximumEncodedArtifactBytes + 1;
      value.totals.encodedArtifactBytes = value.chunks[0].artifactBytes + value.chunks[1].artifactBytes;
    },
  ]) {
    const candidate = manifest();
    mutate(candidate);
    assert.equal(validateExportSetManifest(candidate).valid, false);
  }
});

test("v0.2 independently aggregates decoded artifacts, encoded artifacts, and receipts", () => {
  for (const field of ["decodedBundleBytes", "encodedArtifactBytes", "receiptBytes"]) {
    const candidate = manifest();
    candidate.totals[field] += 1;
    const result = validateExportSetManifest(candidate);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.path === `/totals/${field}`));
  }
});

test("v0.2 derives compressed basenames by default and rejects unsupported versions", () => {
  assert.equal(exportSetChunkBundleBasename(0), "chunk-000000.bundle.json.gz");
  assert.deepEqual(exportSetChunkBasenames(7), {
    bundle: "chunk-000007.bundle.json.gz",
    receipt: "chunk-000007.receipt.json",
  });
  assert.throws(
    () => exportSetChunkBundleBasename(0, "usage-export-set-manifest-v9.9"),
    RangeError,
  );
});
