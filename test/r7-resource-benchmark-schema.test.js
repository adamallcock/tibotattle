import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  EXPORT_RESOURCE_POLICY_VERSION,
} from "../src/export-resource-policy.js";
import {
  assertValidR7ResourceBenchmarkReceipt,
  computeR7ResourceBenchmarkReceiptSha256,
  R7_RESOURCE_BENCHMARK_BOUNDARY_DIMENSIONS,
  R7_RESOURCE_BENCHMARK_DETERMINISTIC_PROJECTION_VERSION,
  R7_RESOURCE_BENCHMARK_FAILURE_CODE_BY_DIMENSION,
  R7_RESOURCE_BENCHMARK_FAILURE_CODES,
  R7_RESOURCE_BENCHMARK_LIMIT_KEY_BY_DIMENSION,
  R7_RESOURCE_BENCHMARK_OPERATION_NAMES,
  R7_RESOURCE_BENCHMARK_OPERATION_STATUSES,
  R7_RESOURCE_BENCHMARK_POLICY_VERSION,
  R7_RESOURCE_BENCHMARK_PROTOCOL_VERSION,
  R7_RESOURCE_BENCHMARK_RECEIPT_SCHEMA_SHA256,
  R7_RESOURCE_BENCHMARK_RECEIPT_VERSION,
  R7_RESOURCE_BENCHMARK_SELECTION_RULE_VERSION,
  R7_RESOURCE_BENCHMARK_UNIT_BY_DIMENSION,
  r7ResourceBenchmarkReceiptHashProjection,
  r7ResourceBenchmarkReceiptSchema,
  validateR7ResourceBenchmarkReceipt,
} from "../src/r7-resource-benchmark-schema.js";

const ZERO_METRICS = Object.freeze({
  wallTimeMs: 0,
  parentElapsedMs: 0,
  cpuTimeMs: 0,
  peakRssBytes: 0,
  rssSampleCount: 0,
  rssSampleFailureCount: 0,
  directoryEntries: 0,
  sourceFiles: 0,
  sourceBytes: 0,
  physicalLines: 0,
  outputRecords: 0,
  expandedRecordBytes: 0,
  decodedBytes: 0,
  encodedBytes: 0,
  workspaceHighWaterBytes: 0,
  manifestBytes: 0,
  chunks: 0,
  affectedFiles: 0,
  affectedBytes: 0,
  durableElapsedMs: 0,
  durablePeakRssBytes: 0,
});

function seal(receipt) {
  receipt.receiptSha256 = computeR7ResourceBenchmarkReceiptSha256(receipt);
  return receipt;
}

function notRunBoundary(dimension) {
  const selectedLimit = DEFAULT_EXPORT_RESOURCE_LIMITS[
    R7_RESOURCE_BENCHMARK_LIMIT_KEY_BY_DIMENSION[dimension]
  ];
  return {
    dimension,
    mode: "not_identified",
    unit: R7_RESOURCE_BENCHMARK_UNIT_BY_DIMENSION[dimension],
    selectedLimit,
    atLimit: { value: selectedLimit, status: "not_run", failureCode: "not_run_profile" },
    plusOne: { value: selectedLimit + 1, status: "not_run", failureCode: "not_run_profile" },
    producer: { status: "not_run", failureCode: "not_run_profile" },
    verifier: { status: "not_run", failureCode: "not_run_profile" },
    identification: "not_run",
  };
}

function receipt() {
  return seal({
    schemaVersion: R7_RESOURCE_BENCHMARK_RECEIPT_VERSION,
    protocolVersion: R7_RESOURCE_BENCHMARK_PROTOCOL_VERSION,
    policyVersion: R7_RESOURCE_BENCHMARK_POLICY_VERSION,
    selectionRuleVersion: R7_RESOURCE_BENCHMARK_SELECTION_RULE_VERSION,
    profile: "smoke",
    classification: "synthetic_lifecycle",
    runtimeProvenance: {
      platform: "macos",
      architecture: "arm64",
      hardwareClass: "apple_silicon",
      runtimeFamily: "node",
      runtimeClass: "compatibility_crosscheck",
      runtimeVersion: { major: 26, minor: 2, patch: 0 },
      rssMeasurementMethod: "process_resource_usage_maxrss",
      rssSamplingIntervalMs: 0,
    },
    contractProvenance: {
      receiptSchemaSha256: R7_RESOURCE_BENCHMARK_RECEIPT_SCHEMA_SHA256,
      resourcePolicySourceSha256: "a".repeat(64),
      benchmarkSourceSha256: "b".repeat(64),
      benchmarkSourceFileCount: 1,
      fixtureVersion: "g1-r7-structural-fixture-v0.1",
      fixtureManifestSha256: "c".repeat(64),
    },
    operations: R7_RESOURCE_BENCHMARK_OPERATION_NAMES.map((name) => ({
      name,
      status: "not_run",
      failureCode: "not_run_profile",
      evidenceSha256: [],
      metrics: { ...ZERO_METRICS },
    })),
    boundaryEvidence: R7_RESOURCE_BENCHMARK_BOUNDARY_DIMENSIONS.map(notRunBoundary),
    determinismEvidence: {
      projectionVersion: R7_RESOURCE_BENCHMARK_DETERMINISTIC_PROJECTION_VERSION,
      status: "not_run",
      runCount: 0,
      runProjectionSha256es: [],
      checks: {
        fixtureManifest: "not_run",
        sourcePlan: "not_run",
        logicalRecords: "not_run",
        chunkBoundaries: "not_run",
        canonicalArtifacts: "not_run",
        lifecycleProjection: "not_run",
        fixedFailureCodes: "not_run",
        cleanupInventories: "not_run",
      },
    },
    sourceLogsPreserved: true,
    identityStatePreserved: true,
    independentOutputPreserved: true,
    callbackSettingsPreserved: true,
    prohibitedDataScan: true,
    networkActivity: "absent",
    secureErasureClaimed: false,
    transportReady: false,
    receiptSha256: "0".repeat(64),
  });
}

function assertRecursivelyClosed(node, path = "#") {
  if (!node || typeof node !== "object") return;
  if (node.type === "object") {
    assert.equal(node.additionalProperties, false, `${path} must be deny-unknown`);
  }
  for (const [key, child] of Object.entries(node)) {
    if (Array.isArray(child)) {
      child.forEach((value, index) => assertRecursivelyClosed(value, `${path}/${key}/${index}`));
    } else {
      assertRecursivelyClosed(child, `${path}/${key}`);
    }
  }
}

test("R7 receipt schema is immutable, recursively deny-unknown, and covers every policy limit", async () => {
  const bytes = await readFile(new URL("../schemas/r7-resource-benchmark-v0.1/receipt.schema.json", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), R7_RESOURCE_BENCHMARK_RECEIPT_SCHEMA_SHA256);
  assertRecursivelyClosed(r7ResourceBenchmarkReceiptSchema);

  assert.deepEqual(
    R7_RESOURCE_BENCHMARK_BOUNDARY_DIMENSIONS.map(
      (dimension) => R7_RESOURCE_BENCHMARK_LIMIT_KEY_BY_DIMENSION[dimension],
    ).sort(),
    Object.keys(DEFAULT_EXPORT_RESOURCE_LIMITS).sort(),
  );
  assert.equal(new Set(R7_RESOURCE_BENCHMARK_BOUNDARY_DIMENSIONS).size, 19);
  assert.equal(new Set(R7_RESOURCE_BENCHMARK_OPERATION_NAMES).size, 10);
  assert.equal(R7_RESOURCE_BENCHMARK_POLICY_VERSION, EXPORT_RESOURCE_POLICY_VERSION);
  assert.deepEqual(R7_RESOURCE_BENCHMARK_OPERATION_STATUSES, [
    "completed", "rejected_at_limit", "interrupted_recovered", "not_run",
  ]);
  assert.equal(R7_RESOURCE_BENCHMARK_FAILURE_CODES.includes("benchmark_operation_failed"), true);
});

test("a content-free smoke receipt validates with explicit not-run lifecycle and boundary rows", () => {
  const value = receipt();
  assert.deepEqual(validateR7ResourceBenchmarkReceipt(value), { valid: true, errors: [] });
  assert.equal(assertValidR7ResourceBenchmarkReceipt(value), value);
  assert.equal(value.operations.every((operation) => operation.status === "not_run"), true);
  assert.equal(value.boundaryEvidence.every((evidence) => evidence.atLimit.status === "not_run"), true);
});

test("semantic receipt SHA-256 is stable JSON over the receipt without its self hash", () => {
  const value = receipt();
  const hash = value.receiptSha256;
  assert.equal(Object.hasOwn(r7ResourceBenchmarkReceiptHashProjection(value), "receiptSha256"), false);
  value.receiptSha256 = "f".repeat(64);
  assert.equal(computeR7ResourceBenchmarkReceiptSha256(value), hash);
  assert.ok(validateR7ResourceBenchmarkReceipt(value).errors.some(
    (error) => error.schemaPath === "#/x-invariant/semantic-receipt-sha256",
  ));

  value.receiptSha256 = hash;
  value.operations[0].metrics.wallTimeMs = 1;
  assert.notEqual(computeR7ResourceBenchmarkReceiptSha256(value), hash);
});

test("schema and AJV diagnostics reject nested paths, pseudonyms, arbitrary strings, and unknown fields safely", () => {
  const canary = "/Users/private/alice/account-pseudonym/session-123";
  const cases = [
    (value) => { value.workspacePath = canary; },
    (value) => { value.runtimeProvenance.hostname = canary; },
    (value) => { value.contractProvenance.participantId = canary; },
    (value) => { value.operations[0].error = canary; },
    (value) => { value.operations[0].metrics.sourcePath = canary; },
    (value) => { value.boundaryEvidence[0].accountPseudonym = canary; },
    (value) => { value.determinismEvidence.checks.details = canary; },
    (value) => { value.profile = canary; },
  ];
  for (const mutate of cases) {
    const value = receipt();
    mutate(value);
    const result = validateR7ResourceBenchmarkReceipt(value);
    assert.equal(result.valid, false);
    const diagnostics = JSON.stringify(result.errors);
    assert.equal(diagnostics.includes(canary), false);
    assert.equal(diagnostics.includes("account-pseudonym"), false);
    assert.deepEqual(
      Object.keys(result.errors[0]).sort(),
      ["keyword", "path", "schemaPath"],
    );
  }
});

test("operation status, canonical order, integer metrics, and fixed failure codes are semantic", () => {
  const completed = receipt();
  completed.operations[0].status = "completed";
  completed.operations[0].failureCode = "none";
  completed.operations[0].evidenceSha256 = ["d".repeat(64), "d".repeat(64)];
  completed.operations[0].metrics.wallTimeMs = 1;
  seal(completed);
  assert.equal(validateR7ResourceBenchmarkReceipt(completed).valid, true);

  const nonzeroNotRun = receipt();
  nonzeroNotRun.operations[0].metrics.sourceFiles = 1;
  seal(nonzeroNotRun);
  assert.ok(validateR7ResourceBenchmarkReceipt(nonzeroNotRun).errors.some(
    (error) => error.schemaPath === "#/x-invariant/not-run-zero-metrics",
  ));

  const wrongCode = receipt();
  wrongCode.operations[0].status = "completed";
  wrongCode.operations[0].failureCode = "benchmark_operation_failed";
  wrongCode.operations[0].evidenceSha256 = ["d".repeat(64), "d".repeat(64)];
  seal(wrongCode);
  assert.ok(validateR7ResourceBenchmarkReceipt(wrongCode).errors.some(
    (error) => error.schemaPath === "#/x-invariant/operation-status-failure-code",
  ));

  const reordered = receipt();
  [reordered.operations[0], reordered.operations[1]] = [reordered.operations[1], reordered.operations[0]];
  seal(reordered);
  assert.ok(validateR7ResourceBenchmarkReceipt(reordered).errors.some(
    (error) => error.schemaPath === "#/x-invariant/canonical-operation-order",
  ));

  const fractional = receipt();
  fractional.operations[0].metrics.cpuTimeMs = 0.5;
  seal(fractional);
  assert.equal(validateR7ResourceBenchmarkReceipt(fractional).valid, false);

  const unequalEvidence = receipt();
  unequalEvidence.operations[0].status = "completed";
  unequalEvidence.operations[0].failureCode = "none";
  unequalEvidence.operations[0].evidenceSha256 = ["d".repeat(64), "e".repeat(64)];
  unequalEvidence.determinismEvidence.status = "passed";
  unequalEvidence.determinismEvidence.runCount = 2;
  unequalEvidence.determinismEvidence.runProjectionSha256es = ["f".repeat(64), "f".repeat(64)];
  for (const key of Object.keys(unequalEvidence.determinismEvidence.checks)) {
    unequalEvidence.determinismEvidence.checks[key] = "matched";
  }
  seal(unequalEvidence);
  assert.ok(validateR7ResourceBenchmarkReceipt(unequalEvidence).errors.some(
    (error) => error.schemaPath === "#/x-invariant/matched-operation-evidence",
  ));

  const missingExternalSample = receipt();
  missingExternalSample.runtimeProvenance.rssMeasurementMethod = "external_sampling";
  missingExternalSample.runtimeProvenance.rssSamplingIntervalMs = 100;
  missingExternalSample.operations[0].status = "completed";
  missingExternalSample.operations[0].failureCode = "none";
  missingExternalSample.operations[0].evidenceSha256 = ["d".repeat(64), "d".repeat(64)];
  seal(missingExternalSample);
  assert.ok(validateR7ResourceBenchmarkReceipt(missingExternalSample).errors.some(
    (error) => error.schemaPath === "#/x-invariant/executed-external-rss-sample",
  ));

  const nonConservativeRss = receipt();
  nonConservativeRss.operations[0].metrics.peakRssBytes = 1;
  nonConservativeRss.operations[0].metrics.durablePeakRssBytes = 2;
  seal(nonConservativeRss);
  assert.ok(validateR7ResourceBenchmarkReceipt(nonConservativeRss).errors.some(
    (error) => error.schemaPath === "#/x-invariant/rss-conservative-maximum",
  ));
});

test("boundary evidence binds exact values, plus one, units, producer/verifier codes, and identification", () => {
  const value = receipt();
  const evidence = value.boundaryEvidence[0];
  const expectedCode = R7_RESOURCE_BENCHMARK_FAILURE_CODE_BY_DIMENSION[evidence.dimension];
  evidence.mode = "materialized";
  evidence.atLimit = { value: evidence.selectedLimit, status: "passed", failureCode: "none" };
  evidence.plusOne = { value: evidence.selectedLimit + 1, status: "rejected", failureCode: expectedCode };
  evidence.producer = { status: "enforced", failureCode: expectedCode };
  evidence.verifier = { status: "not_applicable", failureCode: "none" };
  evidence.identification = "identified";
  seal(value);
  assert.equal(validateR7ResourceBenchmarkReceipt(value).valid, true);

  const counterRelabeledAsIntegrated = receipt();
  const counter = counterRelabeledAsIntegrated.boundaryEvidence[0];
  counter.mode = "synthetic_counter";
  counter.atLimit = { value: counter.selectedLimit, status: "passed", failureCode: "none" };
  counter.plusOne = {
    value: counter.selectedLimit + 1,
    status: "rejected",
    failureCode: R7_RESOURCE_BENCHMARK_FAILURE_CODE_BY_DIMENSION[counter.dimension],
  };
  counter.identification = "identified";
  seal(counterRelabeledAsIntegrated);
  assert.ok(validateR7ResourceBenchmarkReceipt(counterRelabeledAsIntegrated).errors.some(
    (error) => error.schemaPath === "#/x-invariant/identified-integrated-enforcement",
  ));

  for (const mutate of [
    (row) => { row.plusOne.value += 1; },
    (row) => { row.unit = "bytes"; },
    (row) => { row.plusOne.failureCode = "export_resource_rss"; },
    (row) => { row.producer.failureCode = "export_resource_rss"; },
    (row) => { row.atLimit.status = "rejected"; row.atLimit.failureCode = expectedCode; },
  ]) {
    const invalid = structuredClone(value);
    mutate(invalid.boundaryEvidence[0]);
    seal(invalid);
    assert.equal(validateR7ResourceBenchmarkReceipt(invalid).valid, false);
  }
});

test("two-run determinism is internally consistent and excludes runtime metrics through its fixed projection", () => {
  const value = receipt();
  value.determinismEvidence.status = "passed";
  value.determinismEvidence.runCount = 2;
  value.determinismEvidence.runProjectionSha256es = ["d".repeat(64), "d".repeat(64)];
  for (const key of Object.keys(value.determinismEvidence.checks)) {
    value.determinismEvidence.checks[key] = "matched";
  }
  seal(value);
  assert.equal(validateR7ResourceBenchmarkReceipt(value).valid, true);

  value.determinismEvidence.runProjectionSha256es[1] = "e".repeat(64);
  seal(value);
  assert.ok(validateR7ResourceBenchmarkReceipt(value).errors.some(
    (error) => error.schemaPath === "#/x-invariant/receipt-projection-hash-consistency",
  ));

  value.determinismEvidence.runProjectionSha256es[1] = "d".repeat(64);
  value.determinismEvidence.checks.canonicalArtifacts = "mismatched";
  seal(value);
  assert.ok(validateR7ResourceBenchmarkReceipt(value).errors.some(
    (error) => error.schemaPath === "#/x-invariant/determinism-summary",
  ));

  value.determinismEvidence.status = "failed";
  seal(value);
  assert.equal(validateR7ResourceBenchmarkReceipt(value).valid, true);
});

test("privacy and provenance claims are mandatory constants and fixture applicability is semantic", () => {
  for (const field of [
    "sourceLogsPreserved",
    "identityStatePreserved",
    "independentOutputPreserved",
    "callbackSettingsPreserved",
    "prohibitedDataScan",
  ]) {
    const value = receipt();
    value[field] = false;
    seal(value);
    assert.equal(validateR7ResourceBenchmarkReceipt(value).valid, false);
  }
  for (const [field, invalid] of [
    ["networkActivity", "present"],
    ["secureErasureClaimed", true],
    ["transportReady", true],
  ]) {
    const value = receipt();
    value[field] = invalid;
    seal(value);
    assert.equal(validateR7ResourceBenchmarkReceipt(value).valid, false);
  }

  const honestSmoke = receipt();
  honestSmoke.networkActivity = "not_measured";
  seal(honestSmoke);
  assert.equal(validateR7ResourceBenchmarkReceipt(honestSmoke).valid, true);

  const real = receipt();
  real.classification = "real_local_heavy_history";
  seal(real);
  assert.ok(validateR7ResourceBenchmarkReceipt(real).errors.some(
    (error) => error.schemaPath === "#/x-invariant/real-history-has-no-fixture",
  ));
  real.contractProvenance.fixtureVersion = "not_applicable";
  real.contractProvenance.fixtureManifestSha256 = "not_applicable";
  seal(real);
  assert.equal(validateR7ResourceBenchmarkReceipt(real).valid, true);

  const falsePinnedRuntime = receipt();
  falsePinnedRuntime.runtimeProvenance.runtimeClass = "pinned_candidate";
  seal(falsePinnedRuntime);
  assert.ok(validateR7ResourceBenchmarkReceipt(falsePinnedRuntime).errors.some(
    (error) => error.schemaPath === "#/x-invariant/qualified-runtime-class",
  ));

  const arbitraryNode24 = receipt();
  arbitraryNode24.runtimeProvenance.runtimeVersion = { major: 24, minor: 13, patch: 0 };
  arbitraryNode24.runtimeProvenance.runtimeClass = "pinned_candidate";
  seal(arbitraryNode24);
  assert.equal(validateR7ResourceBenchmarkReceipt(arbitraryNode24).valid, false);
});

test("assertion failure exposes only safe structured diagnostics", () => {
  const value = receipt();
  value.operations[0].metrics.userContent = "PRIVATE_CONTENT_CANARY";
  assert.throws(
    () => assertValidR7ResourceBenchmarkReceipt(value),
    (error) => {
      assert.equal(error.message, "Invalid R7 resource benchmark receipt");
      assert.equal(JSON.stringify(error.validationErrors).includes("PRIVATE_CONTENT_CANARY"), false);
      return true;
    },
  );
});

test("checked-in dual-runtime smoke receipts remain strict, self-hashed, and content-free", async () => {
  const fixtures = [
    ["../generated/r7-resource-benchmark-smoke-node24.14.0-v0.1.json", "pinned_candidate", 24, 14, 0],
    ["../generated/r7-resource-benchmark-smoke-node26.2.0-v0.1.json", "compatibility_crosscheck", 26, 2, 0],
  ];
  const sourceDigests = new Set();
  for (const [relativePath, runtimeClass, major, minor, patch] of fixtures) {
    const bytes = await readFile(new URL(relativePath, import.meta.url));
    const value = JSON.parse(bytes);
    assert.deepEqual(validateR7ResourceBenchmarkReceipt(value), { valid: true, errors: [] });
    assert.equal(value.runtimeProvenance.runtimeClass, runtimeClass);
    assert.deepEqual(value.runtimeProvenance.runtimeVersion, { major, minor, patch });
    assert.equal(value.determinismEvidence.status, "passed");
    assert.equal(value.boundaryEvidence.every((row) => row.identification !== "identified"), true);
    assert.equal(bytes.includes(Buffer.from("R7_SYNTHETIC_CONTENT_CANARY_NEVER_EXPORT")), false);
    assert.equal(bytes.includes(Buffer.from("/Users/")), false);
    assert.equal(bytes.includes(Buffer.from("accountPseudonym")), false);
    sourceDigests.add(value.contractProvenance.benchmarkSourceSha256);
  }
  assert.equal(sourceDigests.size, 1);
});
