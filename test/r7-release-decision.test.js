import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_EXPORT_RESOURCE_LIMITS } from "../src/export-resource-policy.js";
import {
  assertValidR7ReleaseEvidenceReceipt,
  computeR7ReleaseEvidenceReceiptSha256,
  R7_RELEASE_EVIDENCE_DETERMINISTIC_PROJECTION_VERSION,
  R7_RELEASE_EVIDENCE_DIMENSIONS,
  R7_RELEASE_EVIDENCE_FAILURE_CODE_BY_DIMENSION,
  R7_RELEASE_EVIDENCE_LIMIT_KEY_BY_DIMENSION,
  R7_RELEASE_EVIDENCE_OPERATION_NAMES,
  R7_RELEASE_EVIDENCE_POLICY_VERSION,
  R7_RELEASE_EVIDENCE_PROTOCOL_VERSION,
  R7_RELEASE_EVIDENCE_RECEIPT_SCHEMA_SHA256,
  R7_RELEASE_EVIDENCE_RECEIPT_VERSION,
  R7_RELEASE_EVIDENCE_RESOURCE_POLICY_SOURCE_SHA256,
  R7_RELEASE_EVIDENCE_RESOURCE_POLICY_VALUES_SHA256,
  R7_RELEASE_EVIDENCE_SCHEMA_MODULE_SHA256,
  R7_RELEASE_EVIDENCE_SELECTION_RULE_VERSION,
  R7_RELEASE_EVIDENCE_UNIT_BY_DIMENSION,
  R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_FILE_COUNT,
  R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_SHA256,
} from "../src/r7-release-evidence-schema.js";
import {
  buildR7ReleaseDecisionReceipt,
  buildR7ReleaseDecisionRows,
} from "../src/r7-release-decision.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function boundaryRows(identified = []) {
  const selected = new Set(identified);
  return R7_RELEASE_EVIDENCE_DIMENSIONS.map((dimension) => ({
    dimension,
    selectedLimit: DEFAULT_EXPORT_RESOURCE_LIMITS[
      R7_RELEASE_EVIDENCE_LIMIT_KEY_BY_DIMENSION[dimension]
    ],
    identification: selected.has(dimension) ? "identified" : "not_identified",
  }));
}

function materializedPair(identified = []) {
  const profileEvidence = {
    harnessMetrics: {
      parentElapsedMs: 100,
      externalPeakRssBytes: 100,
      childMaxRssBytes: 100,
      durablePeakRssBytes: 100,
      filesystem: { sampledHighWaterBytes: 100 },
    },
  };
  return {
    node24: { boundaries: boundaryRows(identified), profileEvidence },
    node26: { boundaries: boundaryRows(identified), profileEvidence },
  };
}

function realReceipt(multiplier) {
  return {
    profileEvidence: { coveredDurationMs: 1000 * multiplier },
    operations: [{
      metrics: {
        sourceFiles: 10 * multiplier,
        sourceBytes: 100 * multiplier,
        outputRecords: 20 * multiplier,
        decodedBytes: 200 * multiplier,
        encodedBytes: 150 * multiplier,
        parentElapsedMs: 30 * multiplier,
        externalPeakRssBytes: 300 * multiplier,
        childMaxRssBytes: 250 * multiplier,
        durablePeakRssBytes: 275 * multiplier,
      },
    }],
  };
}

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
  parentElapsedMs: 10,
  childCpuMs: 5,
  externalRssSampleCount: 2,
  externalPeakRssBytes: 1024,
  childMaxRssBytes: 1024,
  durablePeakRssBytes: 1024,
  sourceFiles: 10,
  sourceBytes: 1000,
  outputRecords: 20,
  decodedBytes: 2000,
  encodedBytes: 1500,
  filesystem: { beforeBytes: 0, sampledHighWaterBytes: 2048, afterBytes: 0 },
});

function comparisons(value = "matched") {
  return Object.fromEntries([
    "fixtureManifest", "sourcePlan", "logicalRecords", "chunkBoundaries",
    "canonicalArtifacts", "verifierResults", "fixedFailureCodes",
    "cleanupInventories", "preservationResults", "lifecycleProjection",
  ].map((key) => [key, value]));
}

function receiptBoundary(dimension, identified = false) {
  const selectedLimit = DEFAULT_EXPORT_RESOURCE_LIMITS[
    R7_RELEASE_EVIDENCE_LIMIT_KEY_BY_DIMENSION[dimension]
  ];
  if (identified) {
    const failureCode = R7_RELEASE_EVIDENCE_FAILURE_CODE_BY_DIMENSION[dimension];
    return {
      dimension,
      unit: R7_RELEASE_EVIDENCE_UNIT_BY_DIMENSION[dimension],
      selectedLimit,
      mode: "materialized",
      atLimit: { value: selectedLimit, status: "passed", failureCode: "none" },
      plusOne: { value: selectedLimit + 1, status: "rejected", failureCode },
      producer: { status: "enforced", failureCode },
      verifier: { status: "not_applicable", failureCode: "not_applicable" },
      identification: "identified",
    };
  }
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

function assembledProfileEvidence(profile) {
  if (profile === "release_synthetic_semantics") {
    return {
      kind: profile,
      fixtureManifestSha256: HASH_A,
      cases: Object.fromEntries([
        "codexRoot", "codexForkReplay", "codexSubagentDelta", "accountScoped",
        "accountUnattributed", "codexPrimaryWindow", "codexSecondaryWindow", "claudeRoot",
        "claudeSubagent", "claudeFallbackIteration", "claudeUnknownModel",
        "claudeFiveHourPresent", "claudeFiveHourAbsent", "claudeSevenDayPresent",
        "claudeSevenDayAbsent",
      ].map((name) => [name, true])),
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
      harnessMetrics: structuredClone(EXECUTED_METRICS),
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
  return {
    kind: profile,
    coveredDurationMs: 31 * 24 * 60 * 60 * 1000,
    frozenPlanPasses: 2,
    rawDurableCopyCreated: false,
    prefixMutationResult: "passed",
    codex: {
      sourceFiles: 10,
      sourceBytes: 1000,
      completeLinePrefixBytes: 1000,
    },
    claude: {
      sourceFiles: 10,
      sourceBytes: 1000,
      completeLinePrefixBytes: 1000,
    },
  };
}

function assembledReceipt(profile, runtimeClass, { outcome, network = "absent" } = {}) {
  const node24 = runtimeClass === "pinned_candidate";
  const materialized = profile === "release_materialized_boundaries";
  const receipt = {
    schemaVersion: R7_RELEASE_EVIDENCE_RECEIPT_VERSION,
    protocolVersion: R7_RELEASE_EVIDENCE_PROTOCOL_VERSION,
    policyVersion: R7_RELEASE_EVIDENCE_POLICY_VERSION,
    selectionRuleVersion: R7_RELEASE_EVIDENCE_SELECTION_RULE_VERSION,
    profile,
    outcome: outcome ?? (materialized ? "partial" : "passed"),
    runtimeProvenance: {
      platform: "macos",
      architecture: "arm64",
      hardwareClass: "apple_silicon",
      ramBucket: "65_to_128_gib",
      runtimeFamily: "node",
      runtimeClass,
      runtimeVersion: node24
        ? { major: 24, minor: 14, patch: 0 }
        : { major: 26, minor: 2, patch: 0 },
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
    operations: R7_RELEASE_EVIDENCE_OPERATION_NAMES.map((name, index) => ({
      name,
      status: index === 0 ? "completed" : "not_run",
      failureCode: index === 0 ? "none" : "not_run_profile",
      projectionSha256: index === 0 ? HASH_A : "not_run",
      metrics: structuredClone(index === 0 ? EXECUTED_METRICS : ZERO_METRICS),
    })),
    boundaries: R7_RELEASE_EVIDENCE_DIMENSIONS.map((dimension) => (
      receiptBoundary(dimension, materialized && dimension === "source_files")
    )),
    determinism: {
      projectionVersion: R7_RELEASE_EVIDENCE_DETERMINISTIC_PROJECTION_VERSION,
      status: "passed",
      runCount: 2,
      runProjectionSha256es: [HASH_A, HASH_A],
      comparisons: comparisons(),
    },
    preservation: {
      sourceLogsPreserved: true,
      identityStatePreserved: true,
      independentOutputPreserved: true,
      callbackSettingsPreserved: true,
      cleanupExactInventory: "passed",
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
    network: { activity: network, transportReady: false, externalParticipants: false },
    profileEvidence: assembledProfileEvidence(profile),
    receiptSha256: "0".repeat(64),
  };
  receipt.receiptSha256 = computeR7ReleaseEvidenceReceiptSha256(receipt);
  return assertValidR7ReleaseEvidenceReceipt(receipt);
}

const PROFILE_BY_PAIR = Object.freeze({
  syntheticSemantics: "release_synthetic_semantics",
  syntheticPressure: "release_synthetic_pressure",
  materializedBoundaries: "release_materialized_boundaries",
  realLocalHistory: "release_real_local_history",
});

function assembledPairs() {
  return Object.fromEntries(Object.entries(PROFILE_BY_PAIR).map(([key, profile]) => [key, {
    node24: assembledReceipt(profile, "pinned_candidate"),
    node26: assembledReceipt(profile, "compatibility_crosscheck"),
  }]));
}

function reseal(receipt) {
  receipt.receiptSha256 = computeR7ReleaseEvidenceReceiptSha256(receipt);
  return receipt;
}

test("R7 decision rows expose evidence but stay unresolved without a frozen rounding rule", () => {
  const rows = buildR7ReleaseDecisionRows({
    materializedBoundaries: materializedPair(["source_files"]),
    realLocalHistory: { node24: realReceipt(1), node26: realReceipt(2) },
    inputsPromotionReady: true,
  });
  const sourceFiles = rows.find(({ dimension }) => dimension === "source_files");
  assert.equal(sourceFiles.exactBoundaryValue, "not_identified");
  assert.equal(sourceFiles.decision, "unresolved");
  assert.equal(sourceFiles.selectionBasis, "not_identified");
  assert.equal(sourceFiles.decidedValue, "not_set");
  assert.equal(sourceFiles.realHistoryValue, 20);

  const sourceBytes = rows.find(({ dimension }) => dimension === "source_bytes");
  assert.equal(sourceBytes.decision, "unresolved");
  assert.equal(sourceBytes.selectionBasis, "not_identified");
  assert.equal(sourceBytes.decidedValue, "not_set");
  assert.equal(sourceBytes.realHistoryValue, 200);

  const directoryEntries = rows.find(({ dimension }) => dimension === "directory_entries");
  assert.equal(directoryEntries.decision, "unresolved");
  assert.equal(directoryEntries.realHistoryValue, "not_identified");
});

test("one-runtime boundary evidence remains unresolved", () => {
  const materializedBoundaries = materializedPair();
  materializedBoundaries.node24.boundaries = boundaryRows(["rss"]);
  const rows = buildR7ReleaseDecisionRows({
    materializedBoundaries,
    realLocalHistory: { node24: realReceipt(1), node26: realReceipt(2) },
  });
  const rss = rows.find(({ dimension }) => dimension === "rss");
  assert.equal(rss.exactBoundaryValue, "not_identified");
  assert.equal(rss.decision, "unresolved");
  assert.equal(rss.realHistoryValue, 600);
});

test("sampled filesystem lower bounds cannot establish twenty-percent resource headroom", () => {
  const materializedBoundaries = materializedPair(["source_files"]);
  materializedBoundaries.node26.profileEvidence = structuredClone(
    materializedBoundaries.node26.profileEvidence,
  );
  materializedBoundaries.node26.profileEvidence.harnessMetrics.parentElapsedMs =
    DEFAULT_EXPORT_RESOURCE_LIMITS.maximumElapsedMs;
  const rows = buildR7ReleaseDecisionRows({
    materializedBoundaries,
    realLocalHistory: { node24: realReceipt(1), node26: realReceipt(2) },
  });
  const sourceFiles = rows.find(({ dimension }) => dimension === "source_files");
  assert.equal(sourceFiles.exactBoundaryValue, "not_identified");
  assert.equal(sourceFiles.decision, "unresolved");
});

test("full valid runtime pairs assemble an open decision with every ceiling unresolved", () => {
  const decision = buildR7ReleaseDecisionReceipt({ inputReceiptPairs: assembledPairs() });
  assert.equal(decision.outcome, "release_open");
  assert.equal(decision.network.activity, "absent");
  assert.equal(decision.profileEvidence.promotionGates.exactRuntimePairs, "open");
  assert.equal(decision.profileEvidence.promotionGates.inputOutcomes, "open");
  assert.equal(decision.profileEvidence.promotionGates.lifecycleOperations, "open");
  assert.equal(decision.profileEvidence.promotionGates.engineeringRounding, "open");
  assert.equal(decision.profileEvidence.promotionGates.ceilingSelection, "open");
  assert.equal(
    decision.profileEvidence.decisions.every((row) => (
      row.decision === "unresolved"
      && row.selectionBasis === "not_identified"
      && row.decidedValue === "not_set"
    )),
    true,
  );
});

test("swapped, missing, and stale runtime receipts are rejected during assembly", () => {
  const swapped = assembledPairs();
  [swapped.syntheticSemantics.node24, swapped.syntheticSemantics.node26] =
    [swapped.syntheticSemantics.node26, swapped.syntheticSemantics.node24];
  assert.throws(
    () => buildR7ReleaseDecisionReceipt({ inputReceiptPairs: swapped }),
    /wrong profile or runtime/,
  );

  const missing = assembledPairs();
  delete missing.syntheticPressure.node26;
  assert.throws(
    () => buildR7ReleaseDecisionReceipt({ inputReceiptPairs: missing }),
    /Invalid R7 release evidence receipt|pair is missing/,
  );

  const stale = assembledPairs();
  stale.realLocalHistory.node24.contractProvenance.workloadCodeSha256 = HASH_B;
  reseal(stale.realLocalHistory.node24);
  assert.throws(
    () => buildR7ReleaseDecisionReceipt({ inputReceiptPairs: stale }),
    /Invalid R7 release evidence receipt/,
  );
});

test("partial or failed input outcomes can never promote a release", () => {
  for (const key of Object.keys(PROFILE_BY_PAIR)) {
    const partialPairs = assembledPairs();
    partialPairs[key].node26.outcome = "partial";
    reseal(partialPairs[key].node26);
    assertValidR7ReleaseEvidenceReceipt(partialPairs[key].node26);
    const partialDecision = buildR7ReleaseDecisionReceipt({ inputReceiptPairs: partialPairs });
    assert.equal(partialDecision.outcome, "release_open", `${key} partial`);
    assert.equal(partialDecision.profileEvidence.promotionGates.inputOutcomes, "open", key);
    assert.equal(
      partialDecision.profileEvidence.decisions.every(({ decision }) => decision === "unresolved"),
      true,
      key,
    );

    const failedPairs = assembledPairs();
    const failed = failedPairs[key].node26;
    failed.outcome = "failed";
    failed.determinism.status = "failed";
    failed.determinism.runProjectionSha256es = [HASH_A, HASH_B];
    failed.determinism.comparisons.lifecycleProjection = "mismatched";
    reseal(failed);
    assertValidR7ReleaseEvidenceReceipt(failed);
    const failedDecision = buildR7ReleaseDecisionReceipt({ inputReceiptPairs: failedPairs });
    assert.equal(failedDecision.outcome, "release_open", `${key} failed`);
    assert.equal(failedDecision.profileEvidence.promotionGates.inputOutcomes, "open", key);
    assert.equal(failedDecision.profileEvidence.promotionGates.determinism, "open", key);
  }
});

test("unmeasured network and incomplete preservation remain explicit open gates", () => {
  const pairs = assembledPairs();
  pairs.syntheticSemantics.node24.outcome = "partial";
  pairs.syntheticSemantics.node24.network.activity = "not_measured";
  pairs.syntheticSemantics.node24.preservation.cleanupExactInventory = "not_run";
  reseal(pairs.syntheticSemantics.node24);
  assertValidR7ReleaseEvidenceReceipt(pairs.syntheticSemantics.node24);

  const decision = buildR7ReleaseDecisionReceipt({ inputReceiptPairs: pairs });
  assert.equal(decision.outcome, "release_open");
  assert.equal(decision.network.activity, "not_measured");
  assert.equal(decision.profileEvidence.promotionGates.networkIsolation, "open");
  assert.equal(decision.profileEvidence.promotionGates.preservation, "open");
  assert.equal(
    decision.profileEvidence.decisions.every(({ decision: value }) => value === "unresolved"),
    true,
  );
});
