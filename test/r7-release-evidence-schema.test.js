import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  EXPORT_RESOURCE_POLICY_VERSION,
} from "../src/export-resource-policy.js";
import {
  assertValidR7ReleaseEvidenceReceipt,
  computeR7ReleaseEvidenceWorkloadSourceProvenance,
  computeR7ReleaseEvidenceReceiptSha256,
  R7_RELEASE_EVIDENCE_DECISIONS,
  R7_RELEASE_EVIDENCE_DETERMINISTIC_PROJECTION_VERSION,
  R7_RELEASE_EVIDENCE_DIMENSIONS,
  R7_RELEASE_EVIDENCE_FAILURE_CODE_BY_DIMENSION,
  R7_RELEASE_EVIDENCE_LIMIT_KEY_BY_DIMENSION,
  R7_RELEASE_EVIDENCE_OPERATION_NAMES,
  R7_RELEASE_EVIDENCE_POLICY_VERSION,
  R7_RELEASE_EVIDENCE_PROFILES,
  R7_RELEASE_EVIDENCE_PROTOCOL_VERSION,
  R7_RELEASE_EVIDENCE_RECEIPT_SCHEMA_SHA256,
  R7_RELEASE_EVIDENCE_RECEIPT_VERSION,
  R7_RELEASE_EVIDENCE_RESOURCE_POLICY_SOURCE_SHA256,
  R7_RELEASE_EVIDENCE_RESOURCE_POLICY_VALUES_SHA256,
  R7_RELEASE_EVIDENCE_SCHEMA_MODULE_SHA256,
  R7_RELEASE_EVIDENCE_SELECTION_RULE_VERSION,
  R7_RELEASE_EVIDENCE_UNIT_BY_DIMENSION,
  R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_FILE_COUNT,
  R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_PATHS,
  R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_SHA256,
  r7ReleaseEvidenceReceiptHashProjection,
  r7ReleaseEvidenceReceiptSchema,
  validateR7ReleaseEvidenceReceipt,
} from "../src/r7-release-evidence-schema.js";

test("release provenance binds both executable R7 worker scripts", () => {
  assert.equal(
    R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_PATHS.includes(
      "scripts/r7-materialized-boundary-worker.js",
    ),
    true,
  );
  assert.equal(
    R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_PATHS.includes(
      "scripts/r7-resource-benchmark-worker.js",
    ),
    true,
  );
  assert.equal(
    R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_FILE_COUNT,
    R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_PATHS.length,
  );
  assert.equal(
    R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_PATHS.includes(
      "schemas/telemetry-v0.1/usage-event.schema.json",
    ),
    true,
  );
});

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const ZERO_METRICS = Object.freeze({
  runCount: 0,
  parentElapsedMs: 0,
  childCpuMs: 0,
  externalRssSampleCount: 0,
  externalRssSampleFailureCount: 0,
  externalPeakRssBytes: 0,
  childMaxRssBytes: 0,
  durablePeakRssBytes: 0,
  stdoutBytes: 0,
  stderrBytes: 0,
  sourceFiles: 0,
  sourceBytes: 0,
  outputRecords: 0,
  decodedBytes: 0,
  encodedBytes: 0,
  filesystem: { beforeBytes: 0, sampledHighWaterBytes: 0, afterBytes: 0 },
});

const EXECUTED_METRICS = Object.freeze({
  ...ZERO_METRICS,
  runCount: 2,
  parentElapsedMs: 2,
  childCpuMs: 1,
  externalRssSampleCount: 2,
  externalPeakRssBytes: 1,
  childMaxRssBytes: 1,
  durablePeakRssBytes: 1,
  sourceFiles: 1,
  sourceBytes: 1,
  filesystem: { beforeBytes: 0, sampledHighWaterBytes: 1, afterBytes: 0 },
});

function seal(receipt) {
  receipt.receiptSha256 = computeR7ReleaseEvidenceReceiptSha256(receipt);
  return receipt;
}

function notRunBoundary(dimension) {
  const selectedLimit = DEFAULT_EXPORT_RESOURCE_LIMITS[
    R7_RELEASE_EVIDENCE_LIMIT_KEY_BY_DIMENSION[dimension]
  ];
  return {
    dimension,
    unit: R7_RELEASE_EVIDENCE_UNIT_BY_DIMENSION[dimension],
    selectedLimit,
    mode: "not_identified",
    atLimit: { value: selectedLimit, status: "not_run", failureCode: "not_run_profile" },
    plusOne: { value: selectedLimit + 1, status: "not_run", failureCode: "not_run_profile" },
    producer: { status: "not_run", failureCode: "not_run_profile" },
    verifier: { status: "not_run", failureCode: "not_run_profile" },
    identification: "not_run",
  };
}

function operations(executed) {
  return R7_RELEASE_EVIDENCE_OPERATION_NAMES.map((name, index) => ({
    name,
    status: executed && index === 0 ? "completed" : "not_run",
    failureCode: executed && index === 0 ? "none" : "not_run_profile",
    projectionSha256: executed && index === 0 ? HASH_A : "not_run",
    metrics: structuredClone(executed && index === 0 ? EXECUTED_METRICS : ZERO_METRICS),
  }));
}

function comparisons(value) {
  return {
    fixtureManifest: value,
    sourcePlan: value,
    logicalRecords: value,
    chunkBoundaries: value,
    canonicalArtifacts: value,
    verifierResults: value,
    fixedFailureCodes: value,
    cleanupInventories: value,
    preservationResults: value,
    lifecycleProjection: value,
  };
}

function inputRuntimeReceipts() {
  return { node24Sha256: HASH_A, node26Sha256: HASH_B };
}

function decisionRow(dimension) {
  return {
    dimension,
    unit: R7_RELEASE_EVIDENCE_UNIT_BY_DIMENSION[dimension],
    candidateValue: DEFAULT_EXPORT_RESOURCE_LIMITS[
      R7_RELEASE_EVIDENCE_LIMIT_KEY_BY_DIMENSION[dimension]
    ],
    exactBoundaryValue: "not_identified",
    realHistoryValue: "not_identified",
    selectionBasis: "not_identified",
    decision: "unresolved",
    decidedValue: "not_set",
  };
}

function profileEvidence(profile) {
  if (profile === "release_synthetic_semantics") {
    return {
      kind: profile,
      fixtureManifestSha256: HASH_A,
      cases: {
        codexRoot: true,
        codexForkReplay: true,
        codexSubagentDelta: true,
        accountScoped: true,
        accountUnattributed: true,
        codexPrimaryWindow: true,
        codexSecondaryWindow: true,
        claudeRoot: true,
        claudeSubagent: true,
        claudeFallbackIteration: true,
        claudeUnknownModel: true,
        claudeFiveHourPresent: true,
        claudeFiveHourAbsent: true,
        claudeSevenDayPresent: true,
        claudeSevenDayAbsent: true,
      },
    };
  }
  if (profile === "release_synthetic_pressure") {
    return {
      kind: profile,
      fixtureManifestSha256: HASH_A,
      seed: 0x6d2b79f5,
      manySmallSourceFiles: 4096,
      denseRecords: 25000,
      targetChunks: 128,
      longLineBytes: 65536,
      longLinePlusOneBytes: 65537,
      compressiblePayloadBytes: 8388608,
      incompressiblePayloadBytes: 8388608,
    };
  }
  if (profile === "release_materialized_boundaries") {
    return {
      kind: profile,
      fixtureManifestSha256: HASH_A,
      literalCandidateAllocationRequired: false,
      harnessMetrics: structuredClone({ ...EXECUTED_METRICS, runCount: 2 }),
      materializedCases: {
        longLine: {
          lineBytes: 65536,
          linePlusOneBytes: 65537,
          configuredLimit: 65536,
          atLimitStatus: "passed",
          plusOneStatus: "rejected",
          plusOneFailureCode: "export_resource_line_bytes",
          producerPathway: "metadata_bundle_producer",
        },
        compressibleArtifact: materializedArtifact(1024),
        incompressibleArtifact: materializedArtifact(8389000),
        workspaceFile: {
          bytes: 8388608,
          plusOneBytes: 8388609,
          atLimitStatus: "passed",
          plusOneStatus: "rejected",
          plusOneFailureCode: "export_resource_workspace_bytes",
          pathway: "resource_guard_from_file_stats",
        },
      },
      sqliteBatch: { status: "not_run", reason: "no_injectable_sqlite_batch_seam" },
    };
  }
  if (profile === "release_real_local_history") {
    return {
      kind: profile,
      coveredDurationMs: 31 * 24 * 60 * 60 * 1000,
      frozenPlanPasses: 2,
      rawDurableCopyCreated: false,
      prefixMutationResult: "passed",
      codex: {
        sourceFiles: 1,
        sourceBytes: 1,
        completeLinePrefixBytes: 1,
      },
      claude: {
        sourceFiles: 1,
        sourceBytes: 1,
        completeLinePrefixBytes: 1,
      },
    };
  }
  return {
    kind: "release_decision",
    headroomBasisPoints: 2000,
    populationPercentileClaimed: false,
    singleMachineLimitation: true,
    promotionGates: {
      exactRuntimePairs: "passed",
      inputOutcomes: "open",
      lifecycleOperations: "open",
      determinism: "open",
      preservation: "open",
      privacy: "open",
      networkIsolation: "open",
      engineeringRounding: "open",
      ceilingSelection: "open",
    },
    inputReceipts: {
      syntheticSemantics: inputRuntimeReceipts(),
      syntheticPressure: inputRuntimeReceipts(),
      materializedBoundaries: inputRuntimeReceipts(),
      realLocalHistory: inputRuntimeReceipts(),
    },
    decisions: R7_RELEASE_EVIDENCE_DIMENSIONS.map(decisionRow),
  };
}

function materializedArtifact(encodedBytes) {
  return {
    decodedBytes: 8388608,
    encodedBytes,
    producerStatus: "passed",
    verifierStatus: "passed",
    decodedPlusOneStatus: "rejected",
    decodedPlusOneFailureCode: "export_compression_decoded_bytes",
    encodedPlusOneStatus: "rejected",
    encodedPlusOneFailureCode: "export_compression_encoded_bytes",
    fileControlStatus: "passed",
  };
}

function receipt(profile = "release_synthetic_semantics") {
  const decision = profile === "release_decision";
  return seal({
    schemaVersion: R7_RELEASE_EVIDENCE_RECEIPT_VERSION,
    protocolVersion: R7_RELEASE_EVIDENCE_PROTOCOL_VERSION,
    policyVersion: R7_RELEASE_EVIDENCE_POLICY_VERSION,
    selectionRuleVersion: R7_RELEASE_EVIDENCE_SELECTION_RULE_VERSION,
    profile,
    outcome: decision
      ? "release_open"
      : profile === "release_materialized_boundaries" ? "partial" : "passed",
    runtimeProvenance: {
      platform: "macos",
      architecture: "arm64",
      hardwareClass: "apple_silicon",
      ramBucket: "65_to_128_gib",
      runtimeFamily: "node",
      runtimeClass: "compatibility_crosscheck",
      runtimeVersion: { major: 26, minor: 2, patch: 0 },
      elapsedClock: "parent_monotonic",
      rssSampler: "parent_external_macos",
      rssSamplingIntervalMs: 100,
      stdoutLimitBytes: 262144,
      stderrLimitBytes: 262144,
      environmentClass: "fixed_locale_timezone_only",
    },
    contractProvenance: {
      receiptSchemaSha256: R7_RELEASE_EVIDENCE_RECEIPT_SCHEMA_SHA256,
      schemaModuleSha256: R7_RELEASE_EVIDENCE_SCHEMA_MODULE_SHA256,
      resourcePolicySourceSha256: R7_RELEASE_EVIDENCE_RESOURCE_POLICY_SOURCE_SHA256,
      resourcePolicyValuesSha256: R7_RELEASE_EVIDENCE_RESOURCE_POLICY_VALUES_SHA256,
      workloadCodeSha256: R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_SHA256,
      workloadCodeFileCount: R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_FILE_COUNT,
    },
    operations: operations(!decision),
    boundaries: R7_RELEASE_EVIDENCE_DIMENSIONS.map(notRunBoundary),
    determinism: decision ? {
      projectionVersion: R7_RELEASE_EVIDENCE_DETERMINISTIC_PROJECTION_VERSION,
      status: "not_run",
      runCount: 0,
      runProjectionSha256es: [],
      comparisons: comparisons("not_run"),
    } : {
      projectionVersion: R7_RELEASE_EVIDENCE_DETERMINISTIC_PROJECTION_VERSION,
      status: "passed",
      runCount: 2,
      runProjectionSha256es: [HASH_A, HASH_A],
      comparisons: comparisons("matched"),
    },
    preservation: {
      sourceLogsPreserved: true,
      identityStatePreserved: true,
      independentOutputPreserved: true,
      callbackSettingsPreserved: true,
      cleanupExactInventory: decision ? "not_run" : "passed",
      secureErasureClaimed: false,
    },
    privacy: {
      contentFree: true,
      rawContentRetained: false,
      pathsRetained: false,
      timestampsRetained: false,
      identifiersRetained: false,
      rowLevelDataRetained: false,
      privateRssSamplesRetained: false,
      arbitraryErrorsRetained: false,
      prohibitedDataScan: "passed",
    },
    network: {
      activity: "absent",
      transportReady: false,
      externalParticipants: false,
    },
    profileEvidence: profileEvidence(profile),
    receiptSha256: "0".repeat(64),
  });
}

function assertRecursivelyClosed(node, path = "#") {
  if (!node || typeof node !== "object") return;
  if (node.type === "object") {
    assert.equal(node.additionalProperties, false, `${path} must deny unknown fields`);
  }
  for (const [key, child] of Object.entries(node)) {
    if (Array.isArray(child)) {
      child.forEach((value, index) => assertRecursivelyClosed(value, `${path}/${key}/${index}`));
    } else {
      assertRecursivelyClosed(child, `${path}/${key}`);
    }
  }
}

test("R7 release schema is recursively closed and reuses every canonical policy dimension", async () => {
  const bytes = await readFile(new URL(
    "../schemas/r7-release-evidence-v0.1/receipt.schema.json",
    import.meta.url,
  ));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), R7_RELEASE_EVIDENCE_RECEIPT_SCHEMA_SHA256);
  assertRecursivelyClosed(r7ReleaseEvidenceReceiptSchema);
  assert.equal(R7_RELEASE_EVIDENCE_POLICY_VERSION, EXPORT_RESOURCE_POLICY_VERSION);
  assert.deepEqual(R7_RELEASE_EVIDENCE_DECISIONS, ["retain", "lower", "unresolved", "deferred"]);
  assert.equal(new Set(R7_RELEASE_EVIDENCE_PROFILES).size, 5);
  assert.equal(new Set(R7_RELEASE_EVIDENCE_DIMENSIONS).size, 19);
  assert.deepEqual(
    R7_RELEASE_EVIDENCE_DIMENSIONS.map(
      (dimension) => R7_RELEASE_EVIDENCE_LIMIT_KEY_BY_DIMENSION[dimension],
    ).sort(),
    Object.keys(DEFAULT_EXPORT_RESOURCE_LIMITS).sort(),
  );
});

test("all five profiles validate separately and profile evidence can never be blended", () => {
  for (const profile of R7_RELEASE_EVIDENCE_PROFILES) {
    const value = receipt(profile);
    assert.deepEqual(validateR7ReleaseEvidenceReceipt(value), { valid: true, errors: [] });
    assert.equal(assertValidR7ReleaseEvidenceReceipt(value), value);
  }

  const mismatched = receipt("release_synthetic_pressure");
  mismatched.profileEvidence = profileEvidence("release_synthetic_semantics");
  seal(mismatched);
  assert.ok(validateR7ReleaseEvidenceReceipt(mismatched).errors.some(
    (error) => error.schemaPath === "#/x-invariant/profile-evidence-separation",
  ));

  const blendedDecision = receipt("release_synthetic_semantics");
  blendedDecision.profileEvidence.decisions = R7_RELEASE_EVIDENCE_DIMENSIONS.map(decisionRow);
  seal(blendedDecision);
  assert.equal(validateR7ReleaseEvidenceReceipt(blendedDecision).valid, false);
});

test("semantic self hash and current code, schema, and policy hashes are mandatory", () => {
  const value = receipt();
  const digest = value.receiptSha256;
  assert.equal(Object.hasOwn(r7ReleaseEvidenceReceiptHashProjection(value), "receiptSha256"), false);
  value.receiptSha256 = HASH_B;
  assert.equal(computeR7ReleaseEvidenceReceiptSha256(value), digest);
  assert.ok(validateR7ReleaseEvidenceReceipt(value).errors.some(
    (error) => error.schemaPath === "#/x-invariant/semantic-receipt-sha256",
  ));

  for (const field of [
    "receiptSchemaSha256",
    "schemaModuleSha256",
    "resourcePolicySourceSha256",
    "resourcePolicyValuesSha256",
    "workloadCodeSha256",
  ]) {
    const invalid = receipt();
    invalid.contractProvenance[field] = HASH_B;
    seal(invalid);
    assert.ok(validateR7ReleaseEvidenceReceipt(invalid).errors.some(
      (error) => error.path === `/contractProvenance/${field}`,
    ));
  }
});

test("changing a runtime-loaded non-receipt schema invalidates workload provenance", () => {
  const target = "schemas/telemetry-v0.1/usage-event.schema.json";
  const repositoryRoot = new URL("../", import.meta.url);
  const mutated = computeR7ReleaseEvidenceWorkloadSourceProvenance({
    readSourceBytes(relativePath) {
      const bytes = readFileSync(new URL(relativePath, repositoryRoot));
      return relativePath === target ? Buffer.concat([bytes, Buffer.from("\n")]) : bytes;
    },
  });
  assert.notEqual(mutated.sha256, R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_SHA256);
  assert.equal(mutated.fileCount, R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_FILE_COUNT);

  const invalid = receipt();
  invalid.contractProvenance.workloadCodeSha256 = mutated.sha256;
  seal(invalid);
  assert.ok(validateR7ReleaseEvidenceReceipt(invalid).errors.some(
    (error) => error.path === "/contractProvenance/workloadCodeSha256",
  ));
});

test("privacy, preservation, and network mutations fail closed", () => {
  const mutations = [
    (value) => { value.privacy.contentFree = false; },
    (value) => { value.privacy.rawContentRetained = true; },
    (value) => { value.privacy.pathsRetained = true; },
    (value) => { value.privacy.timestampsRetained = true; },
    (value) => { value.privacy.identifiersRetained = true; },
    (value) => { value.privacy.rowLevelDataRetained = true; },
    (value) => { value.preservation.sourceLogsPreserved = false; },
    (value) => { value.preservation.secureErasureClaimed = true; },
    (value) => { value.network.activity = "present"; },
    (value) => { value.network.transportReady = true; },
  ];
  for (const mutate of mutations) {
    const value = receipt();
    mutate(value);
    seal(value);
    assert.equal(validateR7ReleaseEvidenceReceipt(value).valid, false);
  }

  const unmeasuredPartial = receipt();
  unmeasuredPartial.network.activity = "not_measured";
  unmeasuredPartial.outcome = "partial";
  seal(unmeasuredPartial);
  assert.equal(validateR7ReleaseEvidenceReceipt(unmeasuredPartial).valid, true);

  const unmeasuredPassed = receipt();
  unmeasuredPassed.network.activity = "not_measured";
  seal(unmeasuredPassed);
  assert.ok(validateR7ReleaseEvidenceReceipt(unmeasuredPassed).errors.some(
    (error) => error.schemaPath === "#/x-invariant/unmeasured-network-cannot-pass",
  ));
});

test("release_ready requires every promotion gate and measured absent network", () => {
  const ready = receipt("release_decision");
  ready.outcome = "release_ready";
  ready.profileEvidence.promotionGates = Object.fromEntries(
    Object.keys(ready.profileEvidence.promotionGates).map((name) => [name, "passed"]),
  );
  ready.profileEvidence.decisions = ready.profileEvidence.decisions.map((row) => ({
    ...row,
    exactBoundaryValue: row.candidateValue,
    realHistoryValue: row.candidateValue,
    selectionBasis: "candidate",
    decision: "retain",
    decidedValue: row.candidateValue,
  }));
  seal(ready);
  assert.deepEqual(validateR7ReleaseEvidenceReceipt(ready), { valid: true, errors: [] });

  const openGate = structuredClone(ready);
  openGate.profileEvidence.promotionGates.inputOutcomes = "open";
  seal(openGate);
  assert.ok(validateR7ReleaseEvidenceReceipt(openGate).errors.some(
    (error) => error.schemaPath === "#/x-invariant/release-ready-promotion-gates-complete",
  ));

  const unmeasured = structuredClone(ready);
  unmeasured.network.activity = "not_measured";
  seal(unmeasured);
  assert.ok(validateR7ReleaseEvidenceReceipt(unmeasured).errors.some(
    (error) => error.schemaPath === "#/x-invariant/release-ready-network-measured-absent",
  ));
});

test("boundary rows enforce canonical order, exact plus one, and producer/verifier honesty", () => {
  const value = receipt("release_materialized_boundaries");
  const row = value.boundaries[0];
  const code = R7_RELEASE_EVIDENCE_FAILURE_CODE_BY_DIMENSION[row.dimension];
  row.selectedLimit = 64;
  row.mode = "materialized";
  row.atLimit = { value: 64, status: "passed", failureCode: "none" };
  row.plusOne = { value: 65, status: "rejected", failureCode: code };
  row.producer = { status: "enforced", failureCode: code };
  row.verifier = { status: "not_applicable", failureCode: "not_applicable" };
  row.identification = "identified";
  seal(value);
  assert.equal(validateR7ReleaseEvidenceReceipt(value).valid, true);

  const wrongPlusOne = structuredClone(value);
  wrongPlusOne.boundaries[0].plusOne.value = 66;
  seal(wrongPlusOne);
  assert.ok(validateR7ReleaseEvidenceReceipt(wrongPlusOne).errors.some(
    (error) => error.schemaPath === "#/x-invariant/plus-one-value",
  ));

  const relabeledCounter = structuredClone(value);
  relabeledCounter.boundaries[0].mode = "synthetic_counter";
  seal(relabeledCounter);
  assert.ok(validateR7ReleaseEvidenceReceipt(relabeledCounter).errors.some(
    (error) => error.schemaPath === "#/x-invariant/integrated-boundary-identification",
  ));

  const boundaryInWrongProfile = receipt("release_synthetic_pressure");
  boundaryInWrongProfile.boundaries[0] = structuredClone(value.boundaries[0]);
  seal(boundaryInWrongProfile);
  assert.ok(validateR7ReleaseEvidenceReceipt(boundaryInWrongProfile).errors.some(
    (error) => error.schemaPath === "#/x-invariant/profile-boundary-separation",
  ));
});

test("materialized aggregate cases are exact, closed, and keep the unrun SQLite gate partial", () => {
  const value = receipt("release_materialized_boundaries");
  assert.equal(validateR7ReleaseEvidenceReceipt(value).valid, true);

  const mislabeledComplete = structuredClone(value);
  mislabeledComplete.outcome = "passed";
  seal(mislabeledComplete);
  assert.ok(validateR7ReleaseEvidenceReceipt(mislabeledComplete).errors.some(
    (error) => error.schemaPath === "#/x-invariant/materialized-sqlite-gate-open",
  ));

  const unknownDetail = structuredClone(value);
  unknownDetail.profileEvidence.materializedCases.longLine.path = "/private/source";
  seal(unknownDetail);
  assert.equal(validateR7ReleaseEvidenceReceipt(unknownDetail).valid, false);

  const unmeasuredEncodedBytes = structuredClone(value);
  unmeasuredEncodedBytes.profileEvidence.materializedCases.compressibleArtifact.encodedBytes = 0;
  seal(unmeasuredEncodedBytes);
  assert.ok(validateR7ReleaseEvidenceReceipt(unmeasuredEncodedBytes).errors.some(
    (error) => error.schemaPath === "#/x-invariant/materialized-artifact-encoded-bytes-measured",
  ));
});

test("operation aggregates bind parent elapsed, external RSS, and filesystem before-high-after", () => {
  const value = receipt();
  assert.equal(validateR7ReleaseEvidenceReceipt(value).valid, true);

  for (const mutate of [
    (operation) => { operation.metrics.externalRssSampleCount = 0; },
    (operation) => { operation.metrics.stdoutBytes = 262145; },
    (operation) => { operation.metrics.filesystem.afterBytes = 2; },
  ]) {
    const invalid = receipt();
    mutate(invalid.operations[0]);
    seal(invalid);
    assert.equal(validateR7ReleaseEvidenceReceipt(invalid).valid, false);
  }

  const dishonestNotRun = receipt();
  dishonestNotRun.operations[1].metrics.parentElapsedMs = 1;
  seal(dishonestNotRun);
  assert.ok(validateR7ReleaseEvidenceReceipt(dishonestNotRun).errors.some(
    (error) => error.schemaPath === "#/x-invariant/not-run-zero-metrics",
  ));
});

test("decision rows are canonical and implement retain, lower, unresolved, and deferred semantics", () => {
  const value = receipt("release_decision");
  const rows = value.profileEvidence.decisions;
  rows[0] = {
    ...rows[0],
    exactBoundaryValue: rows[0].candidateValue,
    selectionBasis: "candidate",
    decision: "retain",
    decidedValue: rows[0].candidateValue,
  };
  rows[1] = {
    ...rows[1],
    exactBoundaryValue: rows[1].candidateValue - 1,
    selectionBasis: "exact_boundary",
    decision: "lower",
    decidedValue: rows[1].candidateValue - 1,
  };
  rows[2] = {
    ...rows[2],
    selectionBasis: "deferred",
    decision: "deferred",
  };
  seal(value);
  assert.equal(validateR7ReleaseEvidenceReceipt(value).valid, true);

  const raise = structuredClone(value);
  raise.profileEvidence.decisions[1].decidedValue = raise.profileEvidence.decisions[1].candidateValue + 1;
  seal(raise);
  assert.ok(validateR7ReleaseEvidenceReceipt(raise).errors.some(
    (error) => error.schemaPath === "#/x-invariant/lower-candidate",
  ));

  const reordered = structuredClone(value);
  [reordered.profileEvidence.decisions[0], reordered.profileEvidence.decisions[1]] =
    [reordered.profileEvidence.decisions[1], reordered.profileEvidence.decisions[0]];
  seal(reordered);
  assert.ok(validateR7ReleaseEvidenceReceipt(reordered).errors.some(
    (error) => error.schemaPath === "#/x-invariant/canonical-decision-order",
  ));
});

test("arbitrary paths, timestamps, identifiers, errors, and unknown fields are unrepresentable", () => {
  const canary = "/Users/private/alice/session-123/2026-07-25T12:00:00Z";
  const mutations = [
    (value) => { value.path = canary; },
    (value) => { value.runtimeProvenance.hostname = canary; },
    (value) => { value.contractProvenance.branch = canary; },
    (value) => { value.operations[0].error = canary; },
    (value) => { value.operations[0].metrics.pid = canary; },
    (value) => { value.boundaries[0].accountId = canary; },
    (value) => { value.determinism.comparisons.details = canary; },
    (value) => { value.profile = canary; },
  ];
  for (const mutate of mutations) {
    const value = receipt();
    mutate(value);
    const result = validateR7ReleaseEvidenceReceipt(value);
    assert.equal(result.valid, false);
    const diagnostics = JSON.stringify(result.errors);
    assert.equal(diagnostics.includes(canary), false);
    assert.equal(diagnostics.includes("session-123"), false);
    assert.deepEqual(Object.keys(result.errors[0]).sort(), ["keyword", "path", "schemaPath"]);
  }
});
