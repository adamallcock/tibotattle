import test from "node:test";
import assert from "node:assert/strict";
import {
  R7_MATERIALIZED_BOUNDARY_HARNESS_VERSION,
  runR7MaterializedBoundaryHarness,
} from "../src/r7-materialized-boundary-harness.js";
import {
  R7_RESOURCE_BENCHMARK_BOUNDARY_DIMENSIONS,
  R7_RESOURCE_BENCHMARK_FAILURE_CODE_BY_DIMENSION,
  R7_RESOURCE_BENCHMARK_LIMIT_KEY_BY_DIMENSION,
  R7_RESOURCE_BENCHMARK_UNIT_BY_DIMENSION,
} from "../src/r7-resource-benchmark-schema.js";
import {
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  EXPORT_RESOURCE_POLICY_VERSION,
} from "../src/export-resource-policy.js";

const PRODUCER_ENFORCED = new Set([
  "covered_duration",
  "directory_entries",
  "source_files",
  "source_bytes",
  "line_bytes",
  "output_records_single_bundle",
  "expanded_record_bytes_single_bundle",
  "canonical_bundle_bytes",
  "output_records_export_set",
  "expanded_record_bytes_export_set",
  "export_set_decoded_bytes",
  "export_set_encoded_bytes",
  "manifest_bytes",
  "chunk_count",
  "elapsed_time",
  "rss",
]);

const VERIFIER_ENFORCED = new Set([
  "covered_duration",
  "directory_entries",
  "source_files",
  "source_bytes",
  "output_records_export_set",
  "expanded_record_bytes_export_set",
  "canonical_bundle_bytes",
  "encoded_artifact_bytes",
  "export_set_decoded_bytes",
  "export_set_encoded_bytes",
  "workspace_bytes",
  "manifest_bytes",
  "chunk_count",
]);

function assertEnforcedSurface(surface, dimension, surfaceName) {
  assert.equal(surface.surface, surfaceName, dimension);
  assert.equal(surface.status, "enforced", `${dimension}:${surface.pathway}`);
  assert.equal(surface.atLimit.mode, "at_limit", dimension);
  assert.equal(surface.plusOne.mode, "limit_plus_one", dimension);
  assert.equal(surface.atLimit.status, "passed", dimension);
  assert.equal(surface.atLimit.failureCode, "none", dimension);
  assert.equal(surface.plusOne.status, "rejected", dimension);
  assert.equal(
    surface.plusOne.failureCode,
    R7_RESOURCE_BENCHMARK_FAILURE_CODE_BY_DIMENSION[dimension],
    dimension,
  );
  assert.equal(surface.atLimit.observedValue, surface.atLimit.configuredLimit, dimension);
  assert.equal(surface.plusOne.observedValue, surface.plusOne.configuredLimit + 1, dimension);
}

test("R7 materialized boundary harness executes content-free producer and verifier value/plus-one evidence", {
  timeout: 30_000,
}, async () => {
  const value = await runR7MaterializedBoundaryHarness();
  assert.equal(value.version, R7_MATERIALIZED_BOUNDARY_HARNESS_VERSION);
  assert.equal(value.resourcePolicyVersion, EXPORT_RESOURCE_POLICY_VERSION);
  assert.equal(value.classification, "synthetic_materialized_boundary_integration");
  assert.match(value.fixtureManifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(value.contentIncluded, false);
  assert.deepEqual(value.rows.map((row) => row.dimension), R7_RESOURCE_BENCHMARK_BOUNDARY_DIMENSIONS);
  assert.equal(new Set(value.rows.map((row) => row.dimension)).size, value.rows.length);

  for (const row of value.rows) {
    assert.equal(row.unit, R7_RESOURCE_BENCHMARK_UNIT_BY_DIMENSION[row.dimension]);
    assert.equal(row.producer.surface, "producer", row.dimension);
    assert.equal(row.verifier.surface, "verifier", row.dimension);
    if (PRODUCER_ENFORCED.has(row.dimension)) {
      assertEnforcedSurface(row.producer, row.dimension, "producer");
    } else {
      assert.ok(["not_run", "not_applicable"].includes(row.producer.status), row.dimension);
      assert.equal(row.producer.atLimit.mode, "at_limit", row.dimension);
      assert.equal(row.producer.plusOne.mode, "limit_plus_one", row.dimension);
    }
    if (VERIFIER_ENFORCED.has(row.dimension)) {
      assertEnforcedSurface(row.verifier, row.dimension, "verifier");
    } else {
      assert.ok(["not_run", "not_applicable"].includes(row.verifier.status), row.dimension);
      assert.equal(row.verifier.atLimit.mode, "at_limit", row.dimension);
      assert.equal(row.verifier.plusOne.mode, "limit_plus_one", row.dimension);
    }
  }

  assert.deepEqual(value.materialCases.longLine, {
    lineBytes: 64 * 1024,
    linePlusOneBytes: (64 * 1024) + 1,
    configuredLimit: 64 * 1024,
    atLimit: { status: "passed", failureCode: "none" },
    plusOne: { status: "rejected", failureCode: "export_resource_line_bytes" },
    producerPathway: "metadata_bundle_producer",
  });
  for (const artifact of [
    value.materialCases.compressibleArtifact,
    value.materialCases.incompressibleArtifact,
  ]) {
    assert.equal(artifact.decodedBytes, 8 * 1024 * 1024);
    assert.equal(artifact.decodedPlusOneBytes, (8 * 1024 * 1024) + 1);
    assert.equal(artifact.encodedBytes > 0, true);
    assert.equal(artifact.producerStatus, "passed");
    assert.equal(artifact.verifierStatus, "passed");
    assert.deepEqual(artifact.producerDecodedPlusOne, {
      status: "rejected",
      failureCode: "export_compression_decoded_bytes",
    });
    assert.deepEqual(artifact.producerEncodedPlusOne, {
      status: "rejected",
      failureCode: "export_compression_encoded_bytes",
    });
    assert.deepEqual(artifact.verifierDecodedPlusOne, {
      status: "rejected",
      failureCode: "export_compression_decoded_bytes",
    });
    assert.deepEqual(artifact.verifierEncodedPlusOne, {
      status: "rejected",
      failureCode: "export_compression_encoded_bytes",
    });
    assert.equal(artifact.fileControlStatus, "passed");
  }
  assert.equal(
    value.materialCases.compressibleArtifact.encodedBytes
      < value.materialCases.incompressibleArtifact.encodedBytes,
    true,
  );
  assert.deepEqual(value.materialCases.workspaceFile, {
    bytes: 8 * 1024 * 1024,
    plusOneBytes: (8 * 1024 * 1024) + 1,
    configuredLimit: 8 * 1024 * 1024,
    atLimit: { status: "passed", failureCode: "none" },
    plusOne: { status: "rejected", failureCode: "export_resource_workspace_bytes" },
    pathway: "resource_guard_from_file_stats",
  });

  assert.deepEqual(
    value.literalCandidateMatrix.map((row) => row.dimension),
    R7_RESOURCE_BENCHMARK_BOUNDARY_DIMENSIONS,
  );
  for (const row of value.literalCandidateMatrix) {
    const selected = DEFAULT_EXPORT_RESOURCE_LIMITS[
      R7_RESOURCE_BENCHMARK_LIMIT_KEY_BY_DIMENSION[row.dimension]
    ];
    assert.equal(row.selectedLimit, selected, row.dimension);
    assert.equal(row.identification === "identified", false, row.dimension);
    if (row.dimension === "sqlite_batch_records") {
      assert.equal(row.mode, "not_identified");
      assert.equal(row.identification, "not_run");
      assert.equal(row.reason, "no_injectable_sqlite_batch_seam");
      assert.equal(row.atLimit.status, "not_run");
      assert.equal(row.plusOne.status, "not_run");
      continue;
    }
    assert.equal(row.mode, "synthetic_boundary_only", row.dimension);
    assert.equal(row.receiptMode, "synthetic_counter", row.dimension);
    assert.equal(row.reason, "counter_only_not_integrated", row.dimension);
    assert.equal(row.atLimit.observedValue, selected, row.dimension);
    assert.equal(row.atLimit.status, "passed", row.dimension);
    assert.equal(row.atLimit.failureCode, "none", row.dimension);
    assert.equal(row.plusOne.observedValue, selected + 1, row.dimension);
    assert.equal(row.plusOne.status, "rejected", row.dimension);
    assert.equal(
      row.plusOne.failureCode,
      R7_RESOURCE_BENCHMARK_FAILURE_CODE_BY_DIMENSION[row.dimension],
      row.dimension,
    );
  }

  assert.deepEqual(value.summary, {
    dimensions: 19,
    enforcedProducerSurfaces: PRODUCER_ENFORCED.size,
    enforcedVerifierSurfaces: VERIFIER_ENFORCED.size,
    executedSurfaces: PRODUCER_ENFORCED.size + VERIFIER_ENFORCED.size,
    unexpectedSurfaces: 0,
    materialCases: 4,
    literalCandidateTrials: 18,
    literalCandidatesIdentified: 0,
    literalCandidateUnexpected: 0,
    sqliteBatchStatus: "not_run",
  });
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes("R7_SYNTHETIC_CONTENT_CANARY_NEVER_EXPORT"), false);
  assert.equal(serialized.includes("codex-home"), false);
  assert.equal(serialized.includes("claude-projects"), false);
  assert.equal(serialized.includes(process.env.USER ?? "__missing_user__"), false);
  assert.equal(serialized.includes("/var/"), false);
  assert.equal(serialized.includes("/tmp/"), false);
});
