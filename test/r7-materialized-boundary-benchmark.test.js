import test from "node:test";
import assert from "node:assert/strict";
import {
  parseR7MaterializedBoundaryWorkerResult,
  runR7MaterializedBoundaryBenchmark,
} from "../src/r7-materialized-boundary-benchmark.js";
import { runR7MaterializedBoundaryWorker } from "../scripts/r7-materialized-boundary-worker.js";
import { validateR7ReleaseEvidenceReceipt } from "../src/r7-release-evidence-schema.js";
import { R7_RESOURCE_BENCHMARK_FAILURE_CODE_BY_DIMENSION } from "../src/r7-resource-benchmark-schema.js";

test("R7 materialized boundary benchmark emits measured, deterministic, honest partial evidence", {
  timeout: 30_000,
}, async () => {
  const receipt = await runR7MaterializedBoundaryBenchmark();
  assert.deepEqual(validateR7ReleaseEvidenceReceipt(receipt), { valid: true, errors: [] });
  assert.equal(receipt.profile, "release_materialized_boundaries");
  assert.equal(receipt.outcome, "partial");
  assert.equal(receipt.operations.every((row) => row.status === "not_run"), true);
  assert.equal(receipt.profileEvidence.harnessMetrics.runCount, 2);
  assert.equal(receipt.profileEvidence.harnessMetrics.externalRssSampleCount > 0, true);
  assert.equal(receipt.boundaries.filter((row) => row.mode === "materialized").length, 1);
  assert.equal(receipt.boundaries.filter((row) => row.mode === "synthetic_counter").length, 18);
  assert.equal(receipt.boundaries.filter((row) => row.identification === "identified").length, 0);
  for (const row of receipt.boundaries) {
    if (row.dimension === "sqlite_batch_records") {
      assert.equal(row.mode, "materialized");
      assert.equal(row.identification, "not_identified");
      assert.equal(row.atLimit.status, "passed");
      assert.equal(row.atLimit.failureCode, "none");
      assert.equal(row.plusOne.status, "passed");
      assert.equal(row.plusOne.failureCode, "none");
      assert.deepEqual(row.producer, {
        status: "not_applicable",
        failureCode: "not_applicable",
      });
      assert.deepEqual(row.verifier, {
        status: "enforced",
        failureCode: "none",
      });
      continue;
    }
    assert.equal(row.producer.status, "not_run", row.dimension);
    assert.equal(row.verifier.status, "not_run", row.dimension);
    assert.equal(row.identification, "not_identified", row.dimension);
    assert.equal(row.atLimit.value, row.selectedLimit, row.dimension);
    assert.equal(row.atLimit.status, "passed", row.dimension);
    assert.equal(row.atLimit.failureCode, "none", row.dimension);
    assert.equal(row.plusOne.value, row.selectedLimit + 1, row.dimension);
    assert.equal(row.plusOne.status, "rejected", row.dimension);
    assert.equal(
      row.plusOne.failureCode,
      R7_RESOURCE_BENCHMARK_FAILURE_CODE_BY_DIMENSION[row.dimension],
      row.dimension,
    );
  }
  assert.deepEqual(receipt.profileEvidence.materializedCases.longLine, {
    lineBytes: 64 * 1024,
    linePlusOneBytes: (64 * 1024) + 1,
    configuredLimit: 64 * 1024,
    atLimitStatus: "passed",
    plusOneStatus: "rejected",
    plusOneFailureCode: "export_resource_line_bytes",
    producerPathway: "metadata_bundle_producer",
  });
  for (const artifact of [
    receipt.profileEvidence.materializedCases.compressibleArtifact,
    receipt.profileEvidence.materializedCases.incompressibleArtifact,
  ]) {
    assert.equal(artifact.decodedBytes, 8 * 1024 * 1024);
    assert.equal(artifact.encodedBytes > 0, true);
    assert.equal(artifact.producerStatus, "passed");
    assert.equal(artifact.verifierStatus, "passed");
    assert.equal(artifact.decodedPlusOneStatus, "rejected");
    assert.equal(artifact.decodedPlusOneFailureCode, "export_compression_decoded_bytes");
    assert.equal(artifact.encodedPlusOneStatus, "rejected");
    assert.equal(artifact.encodedPlusOneFailureCode, "export_compression_encoded_bytes");
    assert.equal(artifact.fileControlStatus, "passed");
  }
  assert.deepEqual(receipt.profileEvidence.materializedCases.workspaceFile, {
    bytes: 8 * 1024 * 1024,
    plusOneBytes: (8 * 1024 * 1024) + 1,
    atLimitStatus: "passed",
    plusOneStatus: "rejected",
    plusOneFailureCode: "export_resource_workspace_bytes",
    pathway: "resource_guard_from_file_stats",
  });
  assert.deepEqual(receipt.profileEvidence.sqliteBatch, {
    batchLimitRecords: 1_000,
    recordsIndexed: 1_001,
    nonEmptyBatchCount: 2,
    fullBatchCount: 1,
    maximumBatchRecords: 1_000,
    finalBatchRecords: 1,
    pathway: "export_set_verifier_sqlite_index",
    atBatchLimitStatus: "passed",
    plusOneRolloverStatus: "passed",
  });
  assert.equal(receipt.determinism.status, "partial");
  assert.equal(receipt.network.activity, "not_measured");
});

test("materialized boundary worker emits only a fixed content-free failure code", async () => {
  const config = {};
  Object.defineProperty(config, "temporaryRoot", {
    get() { throw new Error("NEVER_RENDER_THIS"); },
  });
  const result = await runR7MaterializedBoundaryWorker(config);
  assert.deepEqual(result, {
    status: "failed",
    failureCode: "harness_failed",
    evidence: null,
  });
  assert.equal(JSON.stringify(result).includes("NEVER_RENDER_THIS"), false);
  assert.deepEqual(
    parseR7MaterializedBoundaryWorkerResult(Buffer.from(JSON.stringify(result))),
    { evidence: null, failureCode: "harness_failed" },
  );
  assert.throws(
    () => parseR7MaterializedBoundaryWorkerResult(
      Buffer.from('{"status":"failed","failureCode":"NEVER_RENDER_THIS","evidence":null}'),
    ),
    (error) => error.message === "Invalid R7 materialized boundary result"
      && error.message.includes("NEVER_RENDER_THIS") === false,
  );
});
