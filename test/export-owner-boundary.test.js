import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { extractEsmImports } from "../scripts/lib/esm-imports.mjs";
import * as exportApi from "../src/export/index.js";
import * as compatibility from "../src/export/compatibility.js";
import * as deletionContract from "../src/export/deletion-contract.js";
import * as deletionSchema from "../src/export/deletion-schema.js";
import * as registries from "../src/export/registries.js";
import * as resourcePolicy from "../src/export/resource-policy.js";
import * as versions from "../src/export/versions.js";
import * as workspaceDiscardContract from "../src/export/workspace-discard-contract.js";
import * as workspaceDiscardSchema from "../src/export/workspace-discard-schema.js";
import * as legacyResourcePolicy from "../src/export-resource-policy.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_EXPORTS = Object.freeze([
  "ANTHROPIC_CLAUDE_MODEL_IDS",
  "EXPORT_DIAGNOSTIC_CODES",
  "OPENAI_CODEX_LIMIT_IDS",
  "OPENAI_CODEX_MODEL_IDS",
  // Spark is metered against its own subscription allowance, so the reviewed
  // registry names both its model and its limit identity explicitly.
  "OPENAI_CODEX_SPARK_LIMIT_ID",
  "OPENAI_CODEX_SPARK_MODEL_ID",
  "OPENAI_CODEX_UNPRICED_MODEL_IDS",
  "TELEMETRY_PROVIDER_IDS",
  "TELEMETRY_V01_REGISTRY_VERSION",
  "TELEMETRY_V01_REVIEWED_AT",
  // Codex-scoped model recognition and the priced / known-unpriced /
  // unrecognized vocabulary every display surface has to tell apart.
  "codexModelAllowanceTrack",
  "codexModelApiPriceEquivalentApplicable",
  "codexModelPricingStatus",
  "exportLimitProvider",
  "exportModelProvider",
  "exportRegistrySnapshot",
  "recognizedCodexModelId",
  "recognizedExportLimitId",
  "recognizedExportModelId",
]);
const VERSION_EXPORTS = Object.freeze([
  "CODEX_CHECKPOINT_SCAN_VERSION",
  "CODEX_LOG_SCAN_VERSION",
  "CODEX_METADATA_ADAPTER_VERSION",
  "EXPORTER_VERSION",
  "EXPORT_COMPATIBILITY_TUPLE_VERSION",
]);
const OWNER_ONLY_VERSION_EXPORTS = Object.freeze([
  "CODEX_COLLECTOR_CANDIDATE_VERSION",
  "EXPORT_CHECKPOINT_PARSER_VERSION",
]);
const CHECKPOINT_STATE_EXPORTS = Object.freeze([
  "createCodexCheckpointStateContext",
]);
const SAFE_RECORD_EXPORTS = Object.freeze([
  "createSafeRecordsContext",
]);
const BUNDLE_VERIFICATION_EXPORTS = Object.freeze([
  "assertValidExportRecord",
  "createPrivacySafeBundleVerifier",
]);
const COMPATIBILITY_EXPORTS = Object.freeze([
  "EXPORT_COMPATIBILITY_SCHEMA_NAMES",
  "buildExportCompatibilityTupleFromArtifacts",
  "currentExportCompatibilityTupleFromArtifacts",
]);
const CANONICAL_JSON_EXPORTS = Object.freeze([
  "stableJson",
]);
const COMPRESSION_EXPORTS = Object.freeze([
  "EXPORT_GZIP_PROFILE",
  "ExportCompressionError",
  "compressExportBytes",
  "decompressExportBytes",
]);
const EXPORT_SET_SCHEMA_EXPORTS = Object.freeze([
  "EXPORT_SET_CHUNK_BASENAME_WIDTH",
  "EXPORT_SET_CONTRACT_VERSION",
  "EXPORT_SET_CONTRACT_VERSION_V0_1",
  "EXPORT_SET_CONTRACT_VERSION_V0_2",
  "EXPORT_SET_MANIFEST_RECEIPT_VERSION",
  "EXPORT_SET_MANIFEST_RECEIPT_VERSION_V0_1",
  "EXPORT_SET_MANIFEST_RECEIPT_VERSION_V0_2",
  "EXPORT_SET_MANIFEST_SCHEMA_SHA256",
  "EXPORT_SET_MANIFEST_SCHEMA_SHA256_V0_1",
  "EXPORT_SET_MANIFEST_SCHEMA_SHA256_V0_2",
  "EXPORT_SET_MANIFEST_VERSION",
  "EXPORT_SET_MANIFEST_VERSION_V0_1",
  "EXPORT_SET_MANIFEST_VERSION_V0_2",
  "EXPORT_SET_ORDER_VERSION",
  "EXPORT_SET_PACKING_VERSION",
  "EXPORT_SET_PACKING_VERSION_V0_1",
  "EXPORT_SET_PACKING_VERSION_V0_2",
  "MAXIMUM_EXPORT_SET_CHUNKS",
  "assertValidExportSetManifest",
  "exportSetChunkBasenames",
  "exportSetChunkBundleBasename",
  "exportSetChunkReceiptBasename",
  "exportSetManifestSchema",
  "exportSetManifestSchemaV0_1",
  "exportSetManifestSchemaV0_2",
  "validateExportSetManifest",
]);
const EXPORT_SET_VERIFICATION_EXPORTS = Object.freeze([
  "ExportSetVerificationError",
  "createLocalExportSetVerifier",
]);
const RESOURCE_POLICY_EXPORTS = Object.freeze([
  "DEFAULT_EXPORT_RESOURCE_LIMITS",
  "EXPORT_RESOURCE_POLICY_VERSION",
  "ExportResourceLimitError",
  "createExportResourceGuard",
  "normalizeExportResourceLimits",
]);
const LEGACY_RESOURCE_POLICY_EXPORTS = Object.freeze([
  ...RESOURCE_POLICY_EXPORTS,
  "readBoundedDirectoryEntries",
]);
// EXPORT_RESOURCE_FAILURE_CODES names the resource bound behind
// export_too_large (#43). It is carried by the reviewed src/export/ facade
// only — src/export-resource-policy.js deliberately does not re-export it — so
// it must stay out of RESOURCE_POLICY_EXPORTS, which LEGACY_… spreads.
const REVIEWED_RESOURCE_POLICY_EXPORTS = Object.freeze([
  ...RESOURCE_POLICY_EXPORTS,
  "EXPORT_RESOURCE_FAILURE_CODES",
]);
const DELETION_OWNER_MODULES = Object.freeze([
  deletionContract,
  deletionSchema,
  workspaceDiscardContract,
  workspaceDiscardSchema,
]);
const DELETION_EXPORTS = Object.freeze(
  DELETION_OWNER_MODULES.flatMap((owner) => Object.keys(owner)),
);
const PRODUCTION_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const EXCLUDED_DIRECTORIES = new Set([
  ".release-build",
  ".release-deps",
  ".release-repro",
  ".wrangler",
  "__fixtures__",
  "__tests__",
  "build",
  "coverage",
  "dist",
  "fixtures",
  "node_modules",
  "scripts",
  "test",
  "tests",
  "tools",
]);
const NON_PRODUCTION_FILE_PATTERN =
  /\.(?:check|config|spec|test)\.(?:js|jsx|mjs|mts|ts|tsx)$/u;

async function productionSourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await productionSourceFiles(path));
    } else if (
      entry.isFile()
      && PRODUCTION_EXTENSIONS.has(extname(entry.name))
      && !NON_PRODUCTION_FILE_PATTERN.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files.sort();
}

test("export compatibility metadata has one exact reviewed public API", () => {
  assert.deepEqual(
    Object.keys(exportApi).sort(),
    [
      ...REGISTRY_EXPORTS,
      ...REVIEWED_RESOURCE_POLICY_EXPORTS,
      ...VERSION_EXPORTS,
      ...OWNER_ONLY_VERSION_EXPORTS,
      ...CHECKPOINT_STATE_EXPORTS,
      ...SAFE_RECORD_EXPORTS,
      ...BUNDLE_VERIFICATION_EXPORTS,
      ...COMPATIBILITY_EXPORTS,
      ...CANONICAL_JSON_EXPORTS,
      ...COMPRESSION_EXPORTS,
      ...EXPORT_SET_SCHEMA_EXPORTS,
      ...EXPORT_SET_VERIFICATION_EXPORTS,
      ...DELETION_EXPORTS,
      "EXPORT_SOURCE_PLAN_VERSION",
      "ExportSourcePlanError",
      "summarizeExportSourcePlan",
      "createSourcePlanSummaryContract",
      "EXPORT_SUPPLEMENTAL_SOURCE_PLAN_VERSION",
      "SUPPLEMENTAL_SOURCE_KINDS",
      "ExportSupplementalSourcePlanError",
      "assertCanonicalSupplementalCursorJson",
      "createSupplementalSourcePlan",
      "createEmptySupplementalSourcePlan",
      "normalizeSupplementalSourcePlan",
      "summarizeSupplementalSourcePlan",
      "EXPORT_SET_MANIFEST_BASENAME",
      "EXPORT_SET_MANIFEST_RECEIPT_BASENAME",
      "EXPORT_SET_ORDERING_VERSION",
      "ExportSetError",
      "combinedSourcePlanCommitment",
      "computeWorkspaceLogicalRecordsSha256",
      "createExportSetMaterializationContract",
      "createExportWorkspaceContract",
    ].sort(),
  );
  assert.deepEqual(
    Object.keys(compatibility).sort(),
    [...COMPATIBILITY_EXPORTS].sort(),
  );
  assert.deepEqual(Object.keys(registries).sort(), [...REGISTRY_EXPORTS].sort());
  assert.deepEqual(
    Object.keys(versions).sort(),
    [...VERSION_EXPORTS, ...OWNER_ONLY_VERSION_EXPORTS].sort(),
  );
  assert.deepEqual(
    Object.keys(resourcePolicy).sort(),
    [...REVIEWED_RESOURCE_POLICY_EXPORTS].sort(),
  );
  assert.equal(Object.hasOwn(exportApi, "scanCodexLogEvents"), false);
  assert.equal(Object.hasOwn(exportApi, "subscriptionSpeedSensitivity"), false);
});

test("legacy resource policy preserves its reviewed API and pure identities", () => {
  assert.deepEqual(
    Object.keys(legacyResourcePolicy).sort(),
    [...LEGACY_RESOURCE_POLICY_EXPORTS].sort(),
  );
  for (const name of [
    "DEFAULT_EXPORT_RESOURCE_LIMITS",
    "EXPORT_RESOURCE_POLICY_VERSION",
    "ExportResourceLimitError",
    "normalizeExportResourceLimits",
  ]) {
    assert.equal(legacyResourcePolicy[name], resourcePolicy[name]);
    assert.equal(exportApi[name], resourcePolicy[name]);
  }
  assert.equal(
    exportApi.createExportResourceGuard,
    resourcePolicy.createExportResourceGuard,
  );
});

test("the export public facade preserves the reviewed metadata APIs by identity", () => {
  assert.deepEqual(
    Object.keys(registries).sort(),
    [...REGISTRY_EXPORTS].sort(),
  );
  for (const name of REGISTRY_EXPORTS) {
    assert.equal(exportApi[name], registries[name]);
  }
  for (const name of VERSION_EXPORTS) {
    assert.equal(exportApi[name], versions[name]);
  }
  for (const name of OWNER_ONLY_VERSION_EXPORTS) {
    assert.equal(exportApi[name], versions[name]);
  }
  for (const name of COMPATIBILITY_EXPORTS) {
    assert.equal(exportApi[name], compatibility[name]);
  }
  for (const owner of DELETION_OWNER_MODULES) {
    for (const name of Object.keys(owner)) {
      assert.equal(exportApi[name], owner[name]);
    }
  }
  assert.deepEqual(
    exportApi.exportRegistrySnapshot(),
    registries.exportRegistrySnapshot(),
  );
});

test("production consumers enter export metadata only through its public facade", async () => {
  const violations = [];
  for (const root of ["apps", "local-review", "packages", "src"]) {
    for (const file of await productionSourceFiles(
      resolve(REPOSITORY_ROOT, root),
    )) {
      const relativeFile = file.slice(REPOSITORY_ROOT.length + 1);
      if (
        relativeFile === "src/export/index.js"
      ) {
        continue;
      }
      const source = await readFile(file, "utf8");
      for (const { specifier } of await extractEsmImports(source)) {
        if (
          typeof specifier === "string"
          && (
            /(?:^|\/)export-(?:registries|versions)(?:\.js)?$/u.test(
              specifier,
            )
            || /(?:^|\/)export\/(?:registries|versions)(?:\.js)?$/u.test(
              specifier,
            )
          )
        ) {
          violations.push({ file: relativeFile, specifier });
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});
