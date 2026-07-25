import Ajv from "ajv";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { stableJson } from "./storage.js";

export const R7_RESOURCE_BENCHMARK_RECEIPT_VERSION = "r7-resource-benchmark-receipt-v0.1";
export const R7_RESOURCE_BENCHMARK_PROTOCOL_VERSION = "g1-r7-resource-benchmark-v0.1";
export const R7_RESOURCE_BENCHMARK_POLICY_VERSION = "g1-r3-candidate-0.5";
export const R7_RESOURCE_BENCHMARK_SELECTION_RULE_VERSION = "g1-r7-ceiling-selection-v0.1";
export const R7_RESOURCE_BENCHMARK_DETERMINISTIC_PROJECTION_VERSION = "g1-r7-deterministic-projection-v0.1";

export const R7_RESOURCE_BENCHMARK_OPERATION_NAMES = Object.freeze([
  "source_scan",
  "checkpoint_resume",
  "export_set_materialize",
  "export_set_verify",
  "complete_set_delete",
  "complete_set_delete_recovery",
  "workspace_discard",
  "workspace_discard_recovery",
  "claude_callback_uninstall",
  "claude_callback_recovery",
]);

export const R7_RESOURCE_BENCHMARK_BOUNDARY_DIMENSIONS = Object.freeze([
  "covered_duration",
  "directory_entries",
  "source_files",
  "source_bytes",
  "line_bytes",
  "output_records_single_bundle",
  "expanded_record_bytes_single_bundle",
  "canonical_bundle_bytes",
  "encoded_artifact_bytes",
  "output_records_export_set",
  "expanded_record_bytes_export_set",
  "export_set_decoded_bytes",
  "export_set_encoded_bytes",
  "workspace_bytes",
  "sqlite_batch_records",
  "manifest_bytes",
  "chunk_count",
  "elapsed_time",
  "rss",
]);

export const R7_RESOURCE_BENCHMARK_OPERATION_STATUSES = Object.freeze([
  "completed",
  "rejected_at_limit",
  "interrupted_recovered",
  "not_run",
]);

export const R7_RESOURCE_BENCHMARK_FAILURE_CODES = Object.freeze([
  "none",
  "not_run_profile",
  "interruption_injected",
  "export_resource_covered_duration",
  "export_resource_directory_entries",
  "export_resource_source_files",
  "export_resource_source_bytes",
  "export_resource_line_bytes",
  "export_resource_output_records",
  "export_resource_expanded_record_bytes",
  "export_resource_canonical_bundle_bytes",
  "export_resource_encoded_artifact_bytes",
  "export_resource_export_set_decoded_bytes",
  "export_resource_export_set_encoded_bytes",
  "export_resource_workspace_bytes",
  "export_workspace_disk",
  "export_resource_manifest_bytes",
  "export_resource_chunk_count",
  "export_resource_elapsed_time",
  "export_resource_rss",
  "benchmark_fixture_invalid",
  "benchmark_operation_failed",
  "benchmark_verification_failed",
  "benchmark_recovery_failed",
  "benchmark_preservation_failed",
  "benchmark_unexpected_acceptance",
]);

const schemaUrl = new URL("../schemas/r7-resource-benchmark-v0.1/receipt.schema.json", import.meta.url);
const schemaBytes = readFileSync(schemaUrl);
export const R7_RESOURCE_BENCHMARK_RECEIPT_SCHEMA_SHA256 = createHash("sha256")
  .update(schemaBytes)
  .digest("hex");

const require = createRequire(import.meta.url);
export const r7ResourceBenchmarkReceiptSchema = require("../schemas/r7-resource-benchmark-v0.1/receipt.schema.json");

const ajv = new Ajv({ allErrors: true, strict: true });
const validateSchema = ajv.compile(r7ResourceBenchmarkReceiptSchema);

export const R7_RESOURCE_BENCHMARK_FAILURE_CODE_BY_DIMENSION = Object.freeze({
  covered_duration: "export_resource_covered_duration",
  directory_entries: "export_resource_directory_entries",
  source_files: "export_resource_source_files",
  source_bytes: "export_resource_source_bytes",
  line_bytes: "export_resource_line_bytes",
  output_records_single_bundle: "export_resource_output_records",
  expanded_record_bytes_single_bundle: "export_resource_expanded_record_bytes",
  canonical_bundle_bytes: "export_resource_canonical_bundle_bytes",
  encoded_artifact_bytes: "export_resource_encoded_artifact_bytes",
  output_records_export_set: "export_resource_output_records",
  expanded_record_bytes_export_set: "export_resource_expanded_record_bytes",
  export_set_decoded_bytes: "export_resource_export_set_decoded_bytes",
  export_set_encoded_bytes: "export_resource_export_set_encoded_bytes",
  workspace_bytes: "export_resource_workspace_bytes",
  sqlite_batch_records: null,
  manifest_bytes: "export_resource_manifest_bytes",
  chunk_count: "export_resource_chunk_count",
  elapsed_time: "export_resource_elapsed_time",
  rss: "export_resource_rss",
});

export const R7_RESOURCE_BENCHMARK_UNIT_BY_DIMENSION = Object.freeze({
  covered_duration: "milliseconds",
  directory_entries: "entries",
  source_files: "files",
  source_bytes: "bytes",
  line_bytes: "bytes",
  output_records_single_bundle: "records",
  expanded_record_bytes_single_bundle: "bytes",
  canonical_bundle_bytes: "bytes",
  encoded_artifact_bytes: "bytes",
  output_records_export_set: "records",
  expanded_record_bytes_export_set: "bytes",
  export_set_decoded_bytes: "bytes",
  export_set_encoded_bytes: "bytes",
  workspace_bytes: "bytes",
  sqlite_batch_records: "records",
  manifest_bytes: "bytes",
  chunk_count: "chunks",
  elapsed_time: "milliseconds",
  rss: "bytes",
});

export const R7_RESOURCE_BENCHMARK_LIMIT_KEY_BY_DIMENSION = Object.freeze({
  covered_duration: "maximumCoveredDurationMs",
  directory_entries: "maximumDirectoryEntries",
  source_files: "maximumSourceFiles",
  source_bytes: "maximumSourceBytes",
  line_bytes: "maximumLineBytes",
  output_records_single_bundle: "maximumOutputRecords",
  expanded_record_bytes_single_bundle: "maximumExpandedRecordBytes",
  canonical_bundle_bytes: "maximumCanonicalBundleBytes",
  encoded_artifact_bytes: "maximumEncodedArtifactBytes",
  output_records_export_set: "maximumExportSetRecords",
  expanded_record_bytes_export_set: "maximumExportSetExpandedRecordBytes",
  export_set_decoded_bytes: "maximumExportSetDecodedBytes",
  export_set_encoded_bytes: "maximumExportSetEncodedBytes",
  workspace_bytes: "maximumWorkspaceBytes",
  sqlite_batch_records: "maximumSqliteBatchRecords",
  manifest_bytes: "maximumManifestBytes",
  chunk_count: "maximumChunks",
  elapsed_time: "maximumElapsedMs",
  rss: "maximumRssBytes",
});

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

export function r7ResourceBenchmarkReceiptHashProjection(receipt) {
  const { receiptSha256: _receiptSha256, ...projection } = receipt;
  return projection;
}

export function computeR7ResourceBenchmarkReceiptSha256(receipt) {
  return createHash("sha256")
    .update(stableJson(r7ResourceBenchmarkReceiptHashProjection(receipt)))
    .digest("hex");
}

function operationErrors(receipt) {
  const errors = [];
  for (const [index, operation] of receipt.operations.entries()) {
    if (operation.name !== R7_RESOURCE_BENCHMARK_OPERATION_NAMES[index]) {
      errors.push(invariant(`/operations/${index}/name`, "canonical-operation-order"));
    }
    const expectedFailureCode = operation.status === "completed"
      ? "none"
      : operation.status === "not_run"
        ? "not_run_profile"
        : operation.status === "interrupted_recovered"
          ? "interruption_injected"
          : null;
    if (expectedFailureCode !== null && operation.failureCode !== expectedFailureCode) {
      errors.push(invariant(`/operations/${index}/failureCode`, "operation-status-failure-code"));
    }
    if (operation.status === "rejected_at_limit"
        && !operation.failureCode.startsWith("export_resource_")
        && operation.failureCode !== "export_workspace_disk") {
      errors.push(invariant(`/operations/${index}/failureCode`, "rejection-resource-code"));
    }
    if (operation.status === "not_run"
        && Object.values(operation.metrics).some((metric) => metric !== 0)) {
      errors.push(invariant(`/operations/${index}/metrics`, "not-run-zero-metrics"));
    }
    const expectedEvidenceCount = operation.status === "not_run" ? 0 : 2;
    if (operation.evidenceSha256.length !== expectedEvidenceCount) {
      errors.push(invariant(`/operations/${index}/evidenceSha256`, "operation-evidence-count"));
    }
    if (receipt.determinismEvidence.status === "passed"
        && operation.evidenceSha256.length === 2
        && operation.evidenceSha256[0] !== operation.evidenceSha256[1]) {
      errors.push(invariant(`/operations/${index}/evidenceSha256`, "matched-operation-evidence"));
    }
  }
  return errors;
}

function trialErrors(trial, path, expectedCode) {
  const errors = [];
  let allowedCode = null;
  if (trial.status === "passed") allowedCode = "none";
  if (trial.status === "not_run") allowedCode = "not_run_profile";
  if (trial.status === "rejected") allowedCode = expectedCode;
  if (allowedCode !== null && trial.failureCode !== allowedCode) {
    errors.push(invariant(`${path}/failureCode`, "boundary-status-failure-code"));
  }
  return errors;
}

function surfaceErrors(surface, path, expectedCode) {
  const errors = [];
  const allowedCode = surface.status === "enforced"
    ? expectedCode
    : surface.status === "not_enforced"
      ? "benchmark_unexpected_acceptance"
      : surface.status === "not_run"
        ? "not_run_profile"
        : "none";
  if (allowedCode === null && surface.status === "enforced") {
    errors.push(invariant(`${path}/status`, "dimension-has-no-independent-failure-code"));
  } else if (surface.failureCode !== allowedCode) {
    errors.push(invariant(`${path}/failureCode`, "surface-status-failure-code"));
  }
  return errors;
}

function boundaryErrors(receipt) {
  const errors = [];
  for (const [index, evidence] of receipt.boundaryEvidence.entries()) {
    const path = `/boundaryEvidence/${index}`;
    if (evidence.dimension !== R7_RESOURCE_BENCHMARK_BOUNDARY_DIMENSIONS[index]) {
      errors.push(invariant(`${path}/dimension`, "canonical-boundary-order"));
    }
    if (evidence.unit !== R7_RESOURCE_BENCHMARK_UNIT_BY_DIMENSION[evidence.dimension]) {
      errors.push(invariant(`${path}/unit`, "dimension-unit"));
    }
    if (evidence.atLimit.value !== evidence.selectedLimit) {
      errors.push(invariant(`${path}/atLimit/value`, "at-limit-value"));
    }
    if (evidence.plusOne.value !== evidence.selectedLimit + 1) {
      errors.push(invariant(`${path}/plusOne/value`, "plus-one-value"));
    }
    const expectedCode = R7_RESOURCE_BENCHMARK_FAILURE_CODE_BY_DIMENSION[evidence.dimension];
    errors.push(...trialErrors(evidence.atLimit, `${path}/atLimit`, expectedCode));
    errors.push(...trialErrors(evidence.plusOne, `${path}/plusOne`, expectedCode));
    errors.push(...surfaceErrors(evidence.producer, `${path}/producer`, expectedCode));
    errors.push(...surfaceErrors(evidence.verifier, `${path}/verifier`, expectedCode));

    if (evidence.mode === "not_identified" && evidence.identification === "identified") {
      errors.push(invariant(`${path}/identification`, "unidentified-mode-consistency"));
    }
    if (evidence.mode !== "not_identified" && evidence.identification === "not_run") {
      errors.push(invariant(`${path}/identification`, "executed-boundary-identification"));
    }
    if (evidence.identification === "identified"
        && (evidence.atLimit.status !== "passed" || evidence.plusOne.status !== "rejected")) {
      errors.push(invariant(`${path}/identification`, "identified-exact-boundary"));
    }
    if (evidence.identification === "identified"
        && (evidence.mode !== "materialized"
          || evidence.producer.status !== "enforced"
          || !["enforced", "not_applicable"].includes(evidence.verifier.status))) {
      errors.push(invariant(`${path}/identification`, "identified-integrated-enforcement"));
    }
  }
  return errors;
}

function determinismErrors(receipt) {
  const { status, runCount, runProjectionSha256es, checks } = receipt.determinismEvidence;
  const values = Object.values(checks);
  if (status === "not_run") {
    if (runCount !== 0 || runProjectionSha256es.length !== 0
        || values.some((value) => value !== "not_run")) {
      return [invariant("/determinismEvidence", "not-run-determinism-consistency")];
    }
    return [];
  }
  const errors = [];
  if (runCount !== 2 || runProjectionSha256es.length !== 2) {
    errors.push(invariant("/determinismEvidence", "two-run-determinism"));
  }
  const hasMismatch = values.some((value) => value === "mismatched");
  const hasNotRun = values.some((value) => value === "not_run");
  if ((status === "passed" && (hasMismatch || hasNotRun))
      || (status === "partial" && (hasMismatch || !hasNotRun))
      || (status === "failed" && !hasMismatch)) {
    errors.push(invariant("/determinismEvidence/status", "determinism-summary"));
  }
  const projectionsMatch = runProjectionSha256es.length === 2
    && runProjectionSha256es[0] === runProjectionSha256es[1];
  if ((checks.lifecycleProjection === "matched" && !projectionsMatch)
      || (checks.lifecycleProjection === "mismatched" && projectionsMatch)) {
    errors.push(invariant(
      "/determinismEvidence/runProjectionSha256es",
      "receipt-projection-hash-consistency",
    ));
  }
  return errors;
}

function provenanceErrors(receipt) {
  const errors = [];
  const rss = receipt.runtimeProvenance;
  if ((rss.rssMeasurementMethod === "process_resource_usage_maxrss" && rss.rssSamplingIntervalMs !== 0)
      || (rss.rssMeasurementMethod === "external_sampling" && rss.rssSamplingIntervalMs < 1)) {
    errors.push(invariant("/runtimeProvenance/rssSamplingIntervalMs", "rss-method-interval"));
  }
  const version = rss.runtimeVersion;
  const pinned = version.major === 24 && version.minor === 14 && version.patch === 0;
  const crosscheck = version.major === 26 && version.minor === 2 && version.patch === 0;
  if ((rss.runtimeClass === "pinned_candidate" && !pinned)
      || (rss.runtimeClass === "compatibility_crosscheck" && !crosscheck)) {
    errors.push(invariant("/runtimeProvenance/runtimeClass", "qualified-runtime-class"));
  }
  if (receipt.contractProvenance.receiptSchemaSha256 !== R7_RESOURCE_BENCHMARK_RECEIPT_SCHEMA_SHA256) {
    errors.push(invariant("/contractProvenance/receiptSchemaSha256", "current-schema-digest"));
  }
  const fixtureApplicable = receipt.contractProvenance.fixtureVersion !== "not_applicable";
  if (fixtureApplicable !== (receipt.contractProvenance.fixtureManifestSha256 !== "not_applicable")) {
    errors.push(invariant("/contractProvenance", "fixture-version-manifest-pair"));
  }
  if (receipt.classification === "real_local_heavy_history" && fixtureApplicable) {
    errors.push(invariant("/contractProvenance/fixtureVersion", "real-history-has-no-fixture"));
  }
  if (receipt.classification !== "real_local_heavy_history" && !fixtureApplicable) {
    errors.push(invariant("/contractProvenance/fixtureVersion", "synthetic-requires-fixture"));
  }
  return errors;
}

function semanticErrors(receipt) {
  const errors = [
    ...provenanceErrors(receipt),
    ...operationErrors(receipt),
    ...boundaryErrors(receipt),
    ...determinismErrors(receipt),
  ];
  if (receipt.receiptSha256 !== computeR7ResourceBenchmarkReceiptSha256(receipt)) {
    errors.push(invariant("/receiptSha256", "semantic-receipt-sha256"));
  }
  return errors.slice(0, 20);
}

export function validateR7ResourceBenchmarkReceipt(receipt) {
  if (!validateSchema(receipt)) {
    return { valid: false, errors: safeValidationErrors(validateSchema.errors) };
  }
  const errors = semanticErrors(receipt);
  return { valid: errors.length === 0, errors };
}

export function assertValidR7ResourceBenchmarkReceipt(receipt) {
  const result = validateR7ResourceBenchmarkReceipt(receipt);
  if (!result.valid) {
    const error = new TypeError("Invalid R7 resource benchmark receipt");
    error.validationErrors = result.errors;
    throw error;
  }
  return receipt;
}
