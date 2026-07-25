import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { exportCompatibilityTuple } from "../src/export-contract.js";
import { exportSchemas } from "../src/export-schema.js";
import {
  assertValidExportSetManifest,
  EXPORT_SET_CONTRACT_VERSION_V0_1,
  EXPORT_SET_MANIFEST_SCHEMA_SHA256_V0_1,
  EXPORT_SET_MANIFEST_VERSION_V0_1,
  EXPORT_SET_ORDER_VERSION,
  EXPORT_SET_PACKING_VERSION_V0_1,
  exportSetChunkBasenames,
  exportSetChunkBundleBasename,
  exportSetChunkReceiptBasename,
  exportSetManifestSchemaV0_1,
  validateExportSetManifest,
} from "../src/export-set-schema.js";

function recordCounts(usageEvents, quotaSnapshots = 0, activityMarkers = 0) {
  return { usageEvents, quotaSnapshots, activityMarkers };
}

function manifest() {
  return {
    schemaVersion: EXPORT_SET_MANIFEST_VERSION_V0_1,
    manifestContract: {
      version: EXPORT_SET_CONTRACT_VERSION_V0_1,
      schemaSha256: EXPORT_SET_MANIFEST_SCHEMA_SHA256_V0_1,
    },
    compatibility: exportCompatibilityTuple(),
    exportSetId: `export-set:v1:${"A".repeat(43)}`,
    participantId: `participant:v1:${"B".repeat(43)}`,
    createdAt: "2026-07-24T13:00:00.000Z",
    coveredAt: { startAt: "2026-07-24T11:00:00.000Z", endAt: "2026-07-24T13:00:00.000Z" },
    sourceProviders: ["openai_codex"],
    clientPlatform: "macos",
    transportReady: false,
    completionStatus: "complete",
    sourcePlan: { sha256: "c".repeat(64), sourceFiles: 2, sourceBytes: 2000 },
    chunking: {
      orderingVersion: EXPORT_SET_ORDER_VERSION,
      packingVersion: EXPORT_SET_PACKING_VERSION_V0_1,
      maximumRecordsPerChunk: 2,
      maximumCanonicalBundleBytes: 4096,
    },
    totals: {
      recordCounts: recordCounts(2, 1),
      logicalRecordsSha256: "d".repeat(64),
      bundleBytes: 3500,
      receiptBytes: 1500,
    },
    chunks: [
      {
        index: 0,
        bundleId: `bundle:v1:${"E".repeat(43)}`,
        bundleSha256: "1".repeat(64),
        bundleBytes: 2000,
        receiptSha256: "2".repeat(64),
        receiptBytes: 700,
        recordStart: 0,
        recordEndExclusive: 2,
        recordCounts: recordCounts(2),
      },
      {
        index: 1,
        bundleId: `bundle:v1:${"F".repeat(43)}`,
        bundleSha256: "3".repeat(64),
        bundleBytes: 1500,
        receiptSha256: "4".repeat(64),
        receiptBytes: 800,
        recordStart: 2,
        recordEndExclusive: 3,
        recordCounts: recordCounts(0, 1),
      },
    ],
  };
}

test("standalone strict export-set manifest accepts an exact complete local set", () => {
  const value = manifest();
  assert.deepEqual(validateExportSetManifest(value), { valid: true, errors: [] });
  assert.equal(assertValidExportSetManifest(value), value);
  assert.equal(exportSetManifestSchemaV0_1.$id, "https://app-usagemonitor.local/schemas/export-set-v0.1/manifest.schema.json");
  assert.equal(Object.hasOwn(exportSchemas, "exportSetManifest"), false);
});

test("manifest contract binds the exact current standalone schema bytes", async () => {
  const bytes = await readFile(new URL("../schemas/export-set-v0.1/manifest.schema.json", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), EXPORT_SET_MANIFEST_SCHEMA_SHA256_V0_1);
  const stale = manifest();
  stale.manifestContract.schemaSha256 = "0".repeat(64);
  const result = validateExportSetManifest(stale);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [{
    path: "/manifestContract/schemaSha256",
    keyword: "invariant",
    schemaPath: "#/x-invariant/current-schema-digest",
  }]);
});

test("strict shape rejects nested unknown fields without reflecting their values", () => {
  const contaminated = manifest();
  contaminated.chunks[0].sourcePath = "/Users/private/private-project";
  const result = validateExportSetManifest(contaminated);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.keyword === "additionalProperties"));
  assert.equal(JSON.stringify(result.errors).includes("private-project"), false);
});

test("semantic validation enforces ordered contiguous ranges, packing ceilings, and exact totals", () => {
  for (const mutate of [
    (value) => { value.chunks[1].index = 0; },
    (value) => { value.chunks[1].recordStart = 1; },
    (value) => { value.chunks[1].recordEndExclusive = 4; },
    (value) => { value.chunks[0].recordCounts.usageEvents = 3; },
    (value) => { value.chunks[0].bundleBytes = 4097; value.totals.bundleBytes = 5597; },
    (value) => { value.chunks[1].bundleId = value.chunks[0].bundleId; },
    (value) => { value.totals.recordCounts.usageEvents = 1; },
    (value) => { value.totals.bundleBytes += 1; },
    (value) => { value.totals.receiptBytes += 1; },
    (value) => { value.coveredAt.endAt = "2026-07-24T10:00:00.000Z"; },
    (value) => { value.sourceProviders = ["anthropic_claude_code", "openai_codex"]; },
  ]) {
    const candidate = manifest();
    mutate(candidate);
    assert.equal(validateExportSetManifest(candidate).valid, false);
  }
});

test("an empty complete set still has one independently verifiable zero-record chunk", () => {
  const empty = manifest();
  empty.totals.recordCounts = recordCounts(0);
  empty.totals.bundleBytes = 1200;
  empty.totals.receiptBytes = 700;
  empty.chunks = [{
    ...empty.chunks[0],
    bundleBytes: 1200,
    receiptBytes: 700,
    recordStart: 0,
    recordEndExclusive: 0,
    recordCounts: recordCounts(0),
  }];
  assert.equal(validateExportSetManifest(empty).valid, true);
});

test("fixed six-digit basenames are derived only from bounded zero-based indices", () => {
  assert.equal(exportSetChunkBundleBasename(0, EXPORT_SET_MANIFEST_VERSION_V0_1), "chunk-000000.bundle.json");
  assert.equal(exportSetChunkReceiptBasename(511), "chunk-000511.receipt.json");
  assert.deepEqual(exportSetChunkBasenames(7, EXPORT_SET_MANIFEST_VERSION_V0_1), {
    bundle: "chunk-000007.bundle.json",
    receipt: "chunk-000007.receipt.json",
  });
  for (const invalid of [-1, 1.5, 512, Number.NaN, "1"]) {
    assert.throws(() => exportSetChunkBundleBasename(invalid, EXPORT_SET_MANIFEST_VERSION_V0_1), RangeError);
    assert.throws(() => exportSetChunkReceiptBasename(invalid), RangeError);
  }
});
