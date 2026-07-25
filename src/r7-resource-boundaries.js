import {
  createExportResourceGuard,
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  EXPORT_RESOURCE_POLICY_VERSION,
  ExportResourceLimitError,
} from "./export-resource-policy.js";

export const R7_BOUNDARY_MATRIX_VERSION = "g1-r7-boundary-matrix-v0.1";

function expectLimit(callback, expectedCode) {
  try {
    callback();
  } catch (error) {
    if (error instanceof ExportResourceLimitError && error.code === expectedCode) return "rejected";
    throw error;
  }
  throw new Error("R7 boundary plus-one case did not reject");
}

function row(dimension, policyLimit, atLimit, plusOne, failureCode, {
  producer = "not_run",
  verifier = "not_run",
  identificationStatus = "synthetic_boundary_only",
} = {}) {
  return {
    dimension,
    policyLimit,
    atLimit,
    plusOne,
    failureCode,
    producer,
    verifier,
    identificationStatus,
  };
}

function baseGuard(scope = "export_set", options = {}) {
  return createExportResourceGuard({ scope, ...options });
}

function atAndAbove({ dimension, limit, expectedCode, at, above, options = {} }) {
  const first = baseGuard(options.scope, options.atOptions);
  at(first, limit);
  const second = baseGuard(options.scope, options.aboveOptions);
  const plusOne = expectLimit(() => above(second, limit + 1), expectedCode);
  return row(dimension, limit, "passed", plusOne, expectedCode, options.evidence);
}

export function runR7ResourceBoundaryMatrix() {
  const limits = DEFAULT_EXPORT_RESOURCE_LIMITS;
  const rows = [];
  rows.push(atAndAbove({
    dimension: "covered_duration",
    limit: limits.maximumCoveredDurationMs,
    expectedCode: "export_resource_covered_duration",
    at: (guard, value) => guard.assertCoveredInterval(0, value),
    above: (guard, value) => guard.assertCoveredInterval(0, value),
  }));

  {
    const at = baseGuard();
    for (let index = 0; index < limits.maximumDirectoryEntries; index += 1) at.observeDirectoryEntry();
    const above = baseGuard();
    for (let index = 0; index < limits.maximumDirectoryEntries; index += 1) above.observeDirectoryEntry();
    const plusOne = expectLimit(
      () => above.observeDirectoryEntry(),
      "export_resource_directory_entries",
    );
    rows.push(row(
      "directory_entries",
      limits.maximumDirectoryEntries,
      "passed",
      plusOne,
      "export_resource_directory_entries",
    ));
  }

  rows.push(atAndAbove({
    dimension: "source_files",
    limit: limits.maximumSourceFiles,
    expectedCode: "export_resource_source_files",
    at: (guard, value) => guard.observeSourcePlan(value, 0),
    above: (guard, value) => guard.observeSourcePlan(value, 0),
  }));
  rows.push(atAndAbove({
    dimension: "source_bytes",
    limit: limits.maximumSourceBytes,
    expectedCode: "export_resource_source_bytes",
    at: (guard, value) => guard.observeSourcePlan(0, value),
    above: (guard, value) => guard.observeSourcePlan(0, value),
  }));
  rows.push(atAndAbove({
    dimension: "line_bytes",
    limit: limits.maximumLineBytes,
    expectedCode: "export_resource_line_bytes",
    at: (guard, value) => guard.observeLine(value),
    above: (guard, value) => guard.observeLine(value),
  }));
  rows.push(atAndAbove({
    dimension: "output_records_single_bundle",
    limit: limits.maximumOutputRecords,
    expectedCode: "export_resource_output_records",
    at: (guard, value) => guard.observeOutputTotals(value, 0),
    above: (guard, value) => guard.observeOutputTotals(value, 0),
    options: { scope: "single_bundle" },
  }));
  rows.push(atAndAbove({
    dimension: "expanded_record_bytes_single_bundle",
    limit: limits.maximumExpandedRecordBytes,
    expectedCode: "export_resource_expanded_record_bytes",
    at: (guard, value) => guard.observeOutputTotals(0, value),
    above: (guard, value) => guard.observeOutputTotals(0, value),
    options: { scope: "single_bundle" },
  }));
  rows.push(atAndAbove({
    dimension: "canonical_bundle_bytes",
    limit: limits.maximumCanonicalBundleBytes,
    expectedCode: "export_resource_canonical_bundle_bytes",
    at: (guard, value) => guard.observeCanonicalBundle(value),
    above: (guard, value) => guard.observeCanonicalBundle(value),
  }));
  rows.push(atAndAbove({
    dimension: "encoded_artifact_bytes",
    limit: limits.maximumEncodedArtifactBytes,
    expectedCode: "export_resource_encoded_artifact_bytes",
    at: (guard, value) => guard.observeEncodedArtifact(value),
    above: (guard, value) => guard.observeEncodedArtifact(value),
    options: { evidence: { identificationStatus: "not_identified" } },
  }));
  rows.push(atAndAbove({
    dimension: "output_records_export_set",
    limit: limits.maximumExportSetRecords,
    expectedCode: "export_resource_output_records",
    at: (guard, value) => guard.observeOutputTotals(value, 0),
    above: (guard, value) => guard.observeOutputTotals(value, 0),
  }));
  rows.push(atAndAbove({
    dimension: "expanded_record_bytes_export_set",
    limit: limits.maximumExportSetExpandedRecordBytes,
    expectedCode: "export_resource_expanded_record_bytes",
    at: (guard, value) => guard.observeOutputTotals(0, value),
    above: (guard, value) => guard.observeOutputTotals(0, value),
  }));
  rows.push(atAndAbove({
    dimension: "export_set_decoded_bytes",
    limit: limits.maximumExportSetDecodedBytes,
    expectedCode: "export_resource_export_set_decoded_bytes",
    at: (guard, value) => guard.observeExportSetBytes(value, 0),
    above: (guard, value) => guard.observeExportSetBytes(value, 0),
  }));
  rows.push(atAndAbove({
    dimension: "export_set_encoded_bytes",
    limit: limits.maximumExportSetEncodedBytes,
    expectedCode: "export_resource_export_set_encoded_bytes",
    at: (guard, value) => guard.observeExportSetBytes(0, value),
    above: (guard, value) => guard.observeExportSetBytes(0, value),
  }));
  rows.push(atAndAbove({
    dimension: "workspace_bytes",
    limit: limits.maximumWorkspaceBytes,
    expectedCode: "export_resource_workspace_bytes",
    at: (guard, value) => guard.observeWorkspace(value),
    above: (guard, value) => guard.observeWorkspace(value),
    options: { evidence: { identificationStatus: "not_identified" } },
  }));

  rows.push(row(
    "sqlite_batch_records",
    limits.maximumSqliteBatchRecords,
    "not_run",
    "not_run",
    null,
    { producer: "not_run", identificationStatus: "not_identified" },
  ));
  rows.push(atAndAbove({
    dimension: "manifest_bytes",
    limit: limits.maximumManifestBytes,
    expectedCode: "export_resource_manifest_bytes",
    at: (guard, value) => guard.observeManifest(value),
    above: (guard, value) => guard.observeManifest(value),
  }));
  rows.push(atAndAbove({
    dimension: "chunk_count",
    limit: limits.maximumChunks,
    expectedCode: "export_resource_chunk_count",
    at: (guard, value) => guard.observeChunkCount(value),
    above: (guard, value) => guard.observeChunkCount(value),
  }));

  {
    let current = 0;
    const at = baseGuard("export_set", { clock: () => current, rss: () => 0 });
    current = limits.maximumElapsedMs;
    at.checkRuntime();
    current = 0;
    const above = baseGuard("export_set", { clock: () => current, rss: () => 0 });
    current = limits.maximumElapsedMs + 1;
    const plusOne = expectLimit(() => above.checkRuntime(), "export_resource_elapsed_time");
    rows.push(row("elapsed_time", limits.maximumElapsedMs, "passed", plusOne, "export_resource_elapsed_time"));
  }

  {
    const at = baseGuard("export_set", { clock: () => 0, rss: () => limits.maximumRssBytes });
    at.checkRuntime();
    const above = baseGuard("export_set", { clock: () => 0, rss: () => limits.maximumRssBytes + 1 });
    const plusOne = expectLimit(() => above.checkRuntime(), "export_resource_rss");
    rows.push(row("rss", limits.maximumRssBytes, "passed", plusOne, "export_resource_rss"));
  }

  return {
    version: R7_BOUNDARY_MATRIX_VERSION,
    resourcePolicyVersion: EXPORT_RESOURCE_POLICY_VERSION,
    rows,
  };
}
