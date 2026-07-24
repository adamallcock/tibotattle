import Ajv from "ajv";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export const EXPORT_SET_MANIFEST_VERSION = "usage-export-set-manifest-v0.1";
export const EXPORT_SET_CONTRACT_VERSION = "export-set-contract-v0.1";
export const EXPORT_SET_ORDER_VERSION = "record-family-time-id-v1";
export const EXPORT_SET_PACKING_VERSION = "greedy-canonical-bundle-v1";
export const EXPORT_SET_CHUNK_BASENAME_WIDTH = 6;
export const MAXIMUM_EXPORT_SET_CHUNKS = 512;

const manifestSchemaUrl = new URL("../schemas/export-set-v0.1/manifest.schema.json", import.meta.url);
const manifestSchemaBytes = readFileSync(manifestSchemaUrl);
export const EXPORT_SET_MANIFEST_SCHEMA_SHA256 = createHash("sha256")
  .update(manifestSchemaBytes)
  .digest("hex");

const require = createRequire(import.meta.url);
const manifestSchema = require("../schemas/export-set-v0.1/manifest.schema.json");
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
ajv.addSchema(manifestSchema);
const validateSchema = ajv.getSchema(manifestSchema.$id);

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
  if (manifest.manifestContract.schemaSha256 !== EXPORT_SET_MANIFEST_SCHEMA_SHA256) {
    errors.push(invariant("/manifestContract/schemaSha256", "current-schema-digest"));
  }
  if (Date.parse(manifest.coveredAt.endAt) < Date.parse(manifest.coveredAt.startAt)) {
    errors.push(invariant("/coveredAt", "covered-at-order"));
  }

  const providerOrder = ["openai_codex", "anthropic_claude_code"];
  const canonicalProviders = providerOrder.filter((provider) => manifest.sourceProviders.includes(provider));
  if (canonicalProviders.some((provider, index) => manifest.sourceProviders[index] !== provider)) {
    errors.push(invariant("/sourceProviders", "source-provider-order"));
  }

  const totals = { usageEvents: 0, quotaSnapshots: 0, activityMarkers: 0 };
  let recordCursor = 0;
  let bundleBytes = 0;
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
    if (bundleIds.has(chunk.bundleId)) errors.push(invariant(`${path}/bundleId`, "unique-bundle-id"));
    bundleIds.add(chunk.bundleId);
    recordCursor = chunk.recordEndExclusive;
    totals.usageEvents += chunk.recordCounts.usageEvents;
    totals.quotaSnapshots += chunk.recordCounts.quotaSnapshots;
    totals.activityMarkers += chunk.recordCounts.activityMarkers;
    bundleBytes += chunk.bundleBytes;
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
  if (bundleBytes !== manifest.totals.bundleBytes) {
    errors.push(invariant("/totals/bundleBytes", "aggregate-bundle-bytes"));
  }
  if (receiptBytes !== manifest.totals.receiptBytes) {
    errors.push(invariant("/totals/receiptBytes", "aggregate-receipt-bytes"));
  }
  return errors.slice(0, 20);
}

export function validateExportSetManifest(value) {
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

export function exportSetChunkBundleBasename(index) {
  assertChunkIndex(index);
  return `chunk-${String(index).padStart(EXPORT_SET_CHUNK_BASENAME_WIDTH, "0")}.bundle.json`;
}

export function exportSetChunkReceiptBasename(index) {
  assertChunkIndex(index);
  return `chunk-${String(index).padStart(EXPORT_SET_CHUNK_BASENAME_WIDTH, "0")}.receipt.json`;
}

export function exportSetChunkBasenames(index) {
  return Object.freeze({
    bundle: exportSetChunkBundleBasename(index),
    receipt: exportSetChunkReceiptBasename(index),
  });
}

export { manifestSchema as exportSetManifestSchema };
