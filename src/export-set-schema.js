import Ajv from "ajv";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export const EXPORT_SET_MANIFEST_VERSION_V0_1 = "usage-export-set-manifest-v0.1";
export const EXPORT_SET_MANIFEST_VERSION_V0_2 = "usage-export-set-manifest-v0.2";
export const EXPORT_SET_MANIFEST_VERSION = EXPORT_SET_MANIFEST_VERSION_V0_2;
export const EXPORT_SET_CONTRACT_VERSION_V0_1 = "export-set-contract-v0.1";
export const EXPORT_SET_CONTRACT_VERSION_V0_2 = "export-set-contract-v0.2";
export const EXPORT_SET_CONTRACT_VERSION = EXPORT_SET_CONTRACT_VERSION_V0_2;
export const EXPORT_SET_MANIFEST_RECEIPT_VERSION_V0_1 = "export-set-manifest-receipt-v0.1";
export const EXPORT_SET_MANIFEST_RECEIPT_VERSION_V0_2 = "export-set-manifest-receipt-v0.2";
export const EXPORT_SET_MANIFEST_RECEIPT_VERSION = EXPORT_SET_MANIFEST_RECEIPT_VERSION_V0_2;
export const EXPORT_SET_ORDER_VERSION = "record-family-time-id-v1";
export const EXPORT_SET_PACKING_VERSION_V0_1 = "greedy-canonical-bundle-v1";
export const EXPORT_SET_PACKING_VERSION_V0_2 = "greedy-canonical-bundle-v1";
export const EXPORT_SET_PACKING_VERSION = EXPORT_SET_PACKING_VERSION_V0_2;
export const EXPORT_SET_CHUNK_BASENAME_WIDTH = 6;
export const MAXIMUM_EXPORT_SET_CHUNKS = 512;

const manifestSchemaV0_1Url = new URL("../schemas/export-set-v0.1/manifest.schema.json", import.meta.url);
const manifestSchemaV0_2Url = new URL("../schemas/export-set-v0.2/manifest.schema.json", import.meta.url);
const manifestSchemaV0_1Bytes = readFileSync(manifestSchemaV0_1Url);
const manifestSchemaV0_2Bytes = readFileSync(manifestSchemaV0_2Url);
export const EXPORT_SET_MANIFEST_SCHEMA_SHA256_V0_1 = createHash("sha256")
  .update(manifestSchemaV0_1Bytes)
  .digest("hex");
export const EXPORT_SET_MANIFEST_SCHEMA_SHA256_V0_2 = createHash("sha256")
  .update(manifestSchemaV0_2Bytes)
  .digest("hex");
export const EXPORT_SET_MANIFEST_SCHEMA_SHA256 = EXPORT_SET_MANIFEST_SCHEMA_SHA256_V0_2;

const require = createRequire(import.meta.url);
const manifestSchemaV0_1 = require("../schemas/export-set-v0.1/manifest.schema.json");
const manifestSchemaV0_2 = require("../schemas/export-set-v0.2/manifest.schema.json");
const compatibilitySchema = require("../schemas/telemetry-v0.1/compatibility.schema.json");

const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addFormat("date-time", {
  type: "string",
  validate(value) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
    return Number.isFinite(Date.parse(value));
  },
});
ajv.addSchema(compatibilitySchema);
ajv.addSchema(manifestSchemaV0_1);
ajv.addSchema(manifestSchemaV0_2);
const validateSchemaByVersion = new Map([
  [EXPORT_SET_MANIFEST_VERSION_V0_1, ajv.getSchema(manifestSchemaV0_1.$id)],
  [EXPORT_SET_MANIFEST_VERSION_V0_2, ajv.getSchema(manifestSchemaV0_2.$id)],
]);
const schemaDigestByVersion = new Map([
  [EXPORT_SET_MANIFEST_VERSION_V0_1, EXPORT_SET_MANIFEST_SCHEMA_SHA256_V0_1],
  [EXPORT_SET_MANIFEST_VERSION_V0_2, EXPORT_SET_MANIFEST_SCHEMA_SHA256_V0_2],
]);
const packingVersionByManifestVersion = new Map([
  [EXPORT_SET_MANIFEST_VERSION_V0_1, EXPORT_SET_PACKING_VERSION_V0_1],
  [EXPORT_SET_MANIFEST_VERSION_V0_2, EXPORT_SET_PACKING_VERSION_V0_2],
]);

function safeValidationErrors(errors = []) {
  return errors.slice(0, 20).map((error) => ({
    path: error.instancePath || "/",
    keyword: error.keyword,
    schemaPath: error.schemaPath,
  }));
}

function invariant(path, name) {
  return { path, keyword: "invariant", schemaPath: `#/x-invariant/${name}` };
}

function recordCount(recordCounts) {
  return recordCounts.usageEvents + recordCounts.quotaSnapshots + recordCounts.activityMarkers;
}

function semanticErrors(manifest) {
  const errors = [];
  if (manifest.manifestContract.schemaSha256 !== schemaDigestByVersion.get(manifest.schemaVersion)) {
    errors.push(invariant("/manifestContract/schemaSha256", "current-schema-digest"));
  }
  if (Date.parse(manifest.coveredAt.endAt) < Date.parse(manifest.coveredAt.startAt)) {
    errors.push(invariant("/coveredAt", "covered-at-order"));
  }
  if (manifest.chunking.packingVersion !== packingVersionByManifestVersion.get(manifest.schemaVersion)) {
    errors.push(invariant("/chunking/packingVersion", "manifest-version-packing-version"));
  }

  const providerOrder = ["openai_codex", "anthropic_claude_code"];
  const canonicalProviders = providerOrder.filter((provider) => manifest.sourceProviders.includes(provider));
  if (canonicalProviders.some((provider, index) => manifest.sourceProviders[index] !== provider)) {
    errors.push(invariant("/sourceProviders", "source-provider-order"));
  }

  const totals = { usageEvents: 0, quotaSnapshots: 0, activityMarkers: 0 };
  let recordCursor = 0;
  let decodedBundleBytes = 0;
  let encodedArtifactBytes = 0;
  let receiptBytes = 0;
  const bundleIds = new Set();
  for (const [position, chunk] of manifest.chunks.entries()) {
    const path = `/chunks/${position}`;
    if (chunk.index !== position) errors.push(invariant(`${path}/index`, "chunk-index-order"));
    if (chunk.recordStart !== recordCursor) errors.push(invariant(`${path}/recordStart`, "contiguous-record-range"));
    const count = recordCount(chunk.recordCounts);
    const validEmptySetChunk = count === 0 && manifest.chunks.length === 1 && position === 0
      && recordCount(manifest.totals.recordCounts) === 0;
    if ((!validEmptySetChunk && count < 1) || chunk.recordEndExclusive !== chunk.recordStart + count) {
      errors.push(invariant(`${path}/recordEndExclusive`, "chunk-range-count"));
    }
    if (count > manifest.chunking.maximumRecordsPerChunk) {
      errors.push(invariant(`${path}/recordCounts`, "chunk-record-limit"));
    }
    if (chunk.bundleBytes > manifest.chunking.maximumCanonicalBundleBytes) {
      errors.push(invariant(`${path}/bundleBytes`, "chunk-bundle-limit"));
    }
    if (manifest.schemaVersion === EXPORT_SET_MANIFEST_VERSION_V0_2
        && chunk.artifactBytes > manifest.chunking.maximumEncodedArtifactBytes) {
      errors.push(invariant(`${path}/artifactBytes`, "chunk-artifact-limit"));
    }
    if (bundleIds.has(chunk.bundleId)) errors.push(invariant(`${path}/bundleId`, "unique-bundle-id"));
    bundleIds.add(chunk.bundleId);
    recordCursor = chunk.recordEndExclusive;
    totals.usageEvents += chunk.recordCounts.usageEvents;
    totals.quotaSnapshots += chunk.recordCounts.quotaSnapshots;
    totals.activityMarkers += chunk.recordCounts.activityMarkers;
    decodedBundleBytes += chunk.bundleBytes;
    if (manifest.schemaVersion === EXPORT_SET_MANIFEST_VERSION_V0_2) {
      encodedArtifactBytes += chunk.artifactBytes;
    }
    receiptBytes += chunk.receiptBytes;
  }

  for (const family of Object.keys(totals)) {
    if (totals[family] !== manifest.totals.recordCounts[family]) {
      errors.push(invariant(`/totals/recordCounts/${family}`, "aggregate-record-counts"));
    }
  }
  if (recordCursor !== recordCount(manifest.totals.recordCounts)) {
    errors.push(invariant("/totals/recordCounts", "aggregate-record-range"));
  }
  const decodedTotalPath = manifest.schemaVersion === EXPORT_SET_MANIFEST_VERSION_V0_2
    ? "/totals/decodedBundleBytes"
    : "/totals/bundleBytes";
  const declaredDecodedBundleBytes = manifest.schemaVersion === EXPORT_SET_MANIFEST_VERSION_V0_2
    ? manifest.totals.decodedBundleBytes
    : manifest.totals.bundleBytes;
  if (decodedBundleBytes !== declaredDecodedBundleBytes) {
    errors.push(invariant(decodedTotalPath, "aggregate-bundle-bytes"));
  }
  if (manifest.schemaVersion === EXPORT_SET_MANIFEST_VERSION_V0_2
      && encodedArtifactBytes !== manifest.totals.encodedArtifactBytes) {
    errors.push(invariant("/totals/encodedArtifactBytes", "aggregate-artifact-bytes"));
  }
  if (receiptBytes !== manifest.totals.receiptBytes) {
    errors.push(invariant("/totals/receiptBytes", "aggregate-receipt-bytes"));
  }
  return errors.slice(0, 20);
}

export function validateExportSetManifest(value) {
  const validateSchema = validateSchemaByVersion.get(value?.schemaVersion)
    ?? validateSchemaByVersion.get(EXPORT_SET_MANIFEST_VERSION);
  const valid = validateSchema(value);
  if (!valid) return { valid: false, errors: safeValidationErrors(validateSchema.errors) };
  const errors = semanticErrors(value);
  return { valid: errors.length === 0, errors };
}

export function assertValidExportSetManifest(value) {
  const result = validateExportSetManifest(value);
  if (!result.valid) {
    const summary = result.errors.map((error) => `${error.path}:${error.keyword}`).join(", ");
    throw new Error(`Privacy export-set manifest failed validation (${summary})`);
  }
  return value;
}

function assertChunkIndex(index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= MAXIMUM_EXPORT_SET_CHUNKS) {
    throw new RangeError("Export-set chunk index must be a zero-based integer below 512");
  }
}

export function exportSetChunkBundleBasename(index, schemaVersion = EXPORT_SET_MANIFEST_VERSION) {
  assertChunkIndex(index);
  if (!validateSchemaByVersion.has(schemaVersion)) {
    throw new RangeError("Unsupported export-set manifest version");
  }
  const suffix = schemaVersion === EXPORT_SET_MANIFEST_VERSION_V0_2 ? ".bundle.json.gz" : ".bundle.json";
  return `chunk-${String(index).padStart(EXPORT_SET_CHUNK_BASENAME_WIDTH, "0")}${suffix}`;
}

export function exportSetChunkReceiptBasename(index) {
  assertChunkIndex(index);
  return `chunk-${String(index).padStart(EXPORT_SET_CHUNK_BASENAME_WIDTH, "0")}.receipt.json`;
}

export function exportSetChunkBasenames(index, schemaVersion = EXPORT_SET_MANIFEST_VERSION) {
  return Object.freeze({
    bundle: exportSetChunkBundleBasename(index, schemaVersion),
    receipt: exportSetChunkReceiptBasename(index),
  });
}

export {
  manifestSchemaV0_1 as exportSetManifestSchemaV0_1,
  manifestSchemaV0_2 as exportSetManifestSchemaV0_2,
  manifestSchemaV0_2 as exportSetManifestSchema,
};
