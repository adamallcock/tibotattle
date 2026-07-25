import { totalmem } from "node:os";
import { DEFAULT_EXPORT_RESOURCE_LIMITS } from "./export-resource-policy.js";
import {
  assertValidR7ReleaseEvidenceReceipt,
  computeR7ReleaseEvidenceReceiptSha256,
  R7_RELEASE_EVIDENCE_DETERMINISTIC_PROJECTION_VERSION,
  R7_RELEASE_EVIDENCE_DIMENSIONS,
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
} from "./r7-release-evidence-schema.js";

export const R7_RELEASE_DECISION_VERSION = "g1-r7-release-decision-v0.1";

const PROFILE_BY_INPUT = Object.freeze({
  syntheticSemantics: "release_synthetic_semantics",
  syntheticPressure: "release_synthetic_pressure",
  materializedBoundaries: "release_materialized_boundaries",
  realLocalHistory: "release_real_local_history",
});

const ZERO_OPERATION_METRICS = Object.freeze({
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
  filesystem: Object.freeze({ beforeBytes: 0, sampledHighWaterBytes: 0, afterBytes: 0 }),
});

function runtimeVersion() {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(process.versions.node);
  if (!match) throw new Error("R7 release runtime is unsupported");
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function runtimeClass(version) {
  if (version.major === 24 && version.minor === 14 && version.patch === 0) {
    return "pinned_candidate";
  }
  if (version.major === 26 && version.minor === 2 && version.patch === 0) {
    return "compatibility_crosscheck";
  }
  throw new Error("R7 release runtime is not exactly qualified");
}

function ramBucket() {
  const gibibytes = totalmem() / (1024 ** 3);
  if (gibibytes <= 32) return "up_to_32_gib";
  if (gibibytes <= 64) return "33_to_64_gib";
  if (gibibytes <= 128) return "65_to_128_gib";
  return "over_128_gib";
}

function zeroOperation(name) {
  return {
    name,
    status: "not_run",
    failureCode: "not_run_profile",
    projectionSha256: "not_run",
    metrics: structuredClone(ZERO_OPERATION_METRICS),
  };
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

function requireRuntimeReceipt(receipt, expectedProfile, expectedRuntimeClass) {
  assertValidR7ReleaseEvidenceReceipt(receipt);
  if (receipt.profile !== expectedProfile
      || receipt.runtimeProvenance.runtimeClass !== expectedRuntimeClass) {
    throw new TypeError("R7 release decision input receipt has the wrong profile or runtime");
  }
  return receipt;
}

function allInputReceipts(pairs) {
  return Object.values(pairs).flatMap(({ node24, node26 }) => [node24, node26]);
}

function outcomePassed(receipt) {
  return receipt.outcome === "passed";
}

function determinismPassed(receipt) {
  return receipt.determinism.status === "passed"
    && receipt.determinism.runCount === 2
    && receipt.determinism.runProjectionSha256es.length === 2
    && Object.values(receipt.determinism.comparisons).every((value) => value === "matched");
}

function preservationPassed(receipt) {
  const preservation = receipt.preservation;
  return preservation.sourceLogsPreserved === true
    && preservation.identityStatePreserved === true
    && preservation.independentOutputPreserved === true
    && preservation.callbackSettingsPreserved === true
    && preservation.cleanupExactInventory === "passed"
    && preservation.secureErasureClaimed === false;
}

function privacyPassed(receipt) {
  const privacy = receipt.privacy;
  return privacy.contentFree === true
    && privacy.rawContentRetained === false
    && privacy.pathsRetained === false
    && privacy.timestampsRetained === false
    && privacy.identifiersRetained === false
    && privacy.rowLevelDataRetained === false
    && privacy.privateRssSamplesRetained === false
    && privacy.arbitraryErrorsRetained === false
    && privacy.prohibitedDataScan === "passed";
}

function networkIsolationPassed(receipt) {
  return receipt.network.activity === "absent"
    && receipt.network.transportReady === false
    && receipt.network.externalParticipants === false;
}

function lifecycleOperationsPassed(receipt) {
  return receipt.operations.length === R7_RELEASE_EVIDENCE_OPERATION_NAMES.length
    && receipt.operations.every((operation, index) => (
      operation.name === R7_RELEASE_EVIDENCE_OPERATION_NAMES[index]
      && ["completed", "interrupted_recovered"].includes(operation.status)
    ));
}

function promotionGates(pairs) {
  const receipts = allInputReceipts(pairs);
  return {
    // Runtime qualification is validated receipt-by-receipt, but the privacy
    // contract retains no machine or run identifier proving paired execution.
    exactRuntimePairs: "open",
    inputOutcomes: receipts.every(outcomePassed) ? "passed" : "open",
    lifecycleOperations: receipts.every(lifecycleOperationsPassed) ? "passed" : "open",
    determinism: receipts.every(determinismPassed) ? "passed" : "open",
    preservation: receipts.every(preservationPassed) ? "passed" : "open",
    privacy: receipts.every(privacyPassed) ? "passed" : "open",
    networkIsolation: receipts.every(networkIsolationPassed) ? "passed" : "open",
    // The preregistration does not define the stable engineering rounding grid.
    // Do not turn measured history * 1.20 into a release ceiling by inventing one.
    engineeringRounding: "open",
  };
}

function normalizeInputPairs(inputReceiptPairs) {
  if (!inputReceiptPairs || typeof inputReceiptPairs !== "object") {
    throw new TypeError("R7 release decision input receipt pairs are required");
  }
  return Object.fromEntries(Object.entries(PROFILE_BY_INPUT).map(([key, profile]) => {
    const pair = inputReceiptPairs[key];
    if (!pair || typeof pair !== "object") {
      throw new TypeError("R7 release decision input receipt pair is missing");
    }
    return [key, {
      node24: requireRuntimeReceipt(pair.node24, profile, "pinned_candidate"),
      node26: requireRuntimeReceipt(pair.node26, profile, "compatibility_crosscheck"),
    }];
  }));
}

function materializedHeadroomPassed(pair) {
  // A 100 ms sampled filesystem lower bound cannot prove release headroom.
  // Keep boundary identification open until a producer-enforced maximum exists.
  void pair;
  return false;
}

function identifiedBoundary(pair, dimension) {
  if (!materializedHeadroomPassed(pair)) return "not_identified";
  const rows = [pair.node24, pair.node26].map((receipt) => (
    receipt.boundaries.find((row) => row.dimension === dimension)
  ));
  if (rows.some((row) => !row || row.identification !== "identified")) {
    return "not_identified";
  }
  return rows[0].selectedLimit === rows[1].selectedLimit
    ? rows[0].selectedLimit : "not_identified";
}

function maximumPositive(values) {
  const usable = values.filter((value) => Number.isSafeInteger(value) && value > 0);
  return usable.length > 0 ? Math.max(...usable) : "not_identified";
}

function realHistoryValue(pair, dimension) {
  const receipts = [pair.node24, pair.node26];
  if (dimension === "covered_duration") {
    return maximumPositive(receipts.map((receipt) => receipt.profileEvidence.coveredDurationMs));
  }
  const operations = receipts.flatMap((receipt) => receipt.operations);
  const fieldByDimension = {
    source_files: "sourceFiles",
    source_bytes: "sourceBytes",
    output_records_export_set: "outputRecords",
    export_set_decoded_bytes: "decodedBytes",
    export_set_encoded_bytes: "encodedBytes",
    elapsed_time: "parentElapsedMs",
  };
  if (dimension === "rss") {
    return maximumPositive(operations.flatMap(({ metrics }) => [
      metrics.externalPeakRssBytes,
      metrics.childMaxRssBytes,
      metrics.durablePeakRssBytes,
    ]));
  }
  const field = fieldByDimension[dimension];
  return field
    ? maximumPositive(operations.map(({ metrics }) => metrics[field]))
    : "not_identified";
}

export function buildR7ReleaseDecisionRows({
  materializedBoundaries,
  realLocalHistory,
  inputsPromotionReady = false,
}) {
  return R7_RELEASE_EVIDENCE_DIMENSIONS.map((dimension) => {
    const candidateValue = DEFAULT_EXPORT_RESOURCE_LIMITS[
      R7_RELEASE_EVIDENCE_LIMIT_KEY_BY_DIMENSION[dimension]
    ];
    const exactBoundaryValue = identifiedBoundary(materializedBoundaries, dimension);
    const observedRealHistoryValue = realHistoryValue(realLocalHistory, dimension);
    // The frozen rule is the lowest of candidate, exact materialized boundary,
    // and independently identified real history plus 20% headroom rounded down
    // to a stable engineering boundary. Real-history receipts do not yet carry
    // either per-dimension independence/stop evidence or a specified rounding
    // grid. Report observations, but fail closed instead of selecting a value.
    const stableEngineeringBoundary = "not_identified";
    const selectionInputsComplete = inputsPromotionReady
      && exactBoundaryValue !== "not_identified"
      && observedRealHistoryValue !== "not_identified"
      && stableEngineeringBoundary !== "not_identified";
    return {
      dimension,
      unit: R7_RELEASE_EVIDENCE_UNIT_BY_DIMENSION[dimension],
      candidateValue,
      exactBoundaryValue,
      realHistoryValue: observedRealHistoryValue,
      selectionBasis: selectionInputsComplete ? "candidate" : "not_identified",
      decision: selectionInputsComplete ? "retain" : "unresolved",
      decidedValue: selectionInputsComplete ? candidateValue : "not_set",
    };
  });
}

export function buildR7ReleaseDecisionReceipt({ inputReceiptPairs } = {}) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("R7 release receipts are qualified only for macOS arm64");
  }
  const pairs = normalizeInputPairs(inputReceiptPairs);
  const gates = promotionGates(pairs);
  const inputsPromotionReady = Object.entries(gates)
    .filter(([name]) => name !== "engineeringRounding")
    .every(([, status]) => status === "passed");
  const decisions = buildR7ReleaseDecisionRows({
    materializedBoundaries: pairs.materializedBoundaries,
    realLocalHistory: pairs.realLocalHistory,
    inputsPromotionReady,
  });
  gates.ceilingSelection = decisions.every(({ decision }) => ["retain", "lower"].includes(decision))
    ? "passed" : "open";
  const releaseReady = Object.values(gates).every((status) => status === "passed")
    && decisions.every(({ decision }) => ["retain", "lower"].includes(decision));
  const version = runtimeVersion();
  const receipt = {
    schemaVersion: R7_RELEASE_EVIDENCE_RECEIPT_VERSION,
    protocolVersion: R7_RELEASE_EVIDENCE_PROTOCOL_VERSION,
    policyVersion: R7_RELEASE_EVIDENCE_POLICY_VERSION,
    selectionRuleVersion: R7_RELEASE_EVIDENCE_SELECTION_RULE_VERSION,
    profile: "release_decision",
    outcome: releaseReady ? "release_ready" : "release_open",
    runtimeProvenance: {
      platform: "macos",
      architecture: "arm64",
      hardwareClass: "apple_silicon",
      ramBucket: ramBucket(),
      runtimeFamily: "node",
      runtimeClass: runtimeClass(version),
      runtimeVersion: version,
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
    operations: R7_RELEASE_EVIDENCE_OPERATION_NAMES.map(zeroOperation),
    boundaries: R7_RELEASE_EVIDENCE_DIMENSIONS.map(notRunBoundary),
    determinism: {
      projectionVersion: R7_RELEASE_EVIDENCE_DETERMINISTIC_PROJECTION_VERSION,
      status: "not_run",
      runCount: 0,
      runProjectionSha256es: [],
      comparisons: Object.fromEntries([
        "fixtureManifest", "sourcePlan", "logicalRecords", "chunkBoundaries",
        "canonicalArtifacts", "verifierResults", "fixedFailureCodes",
        "cleanupInventories", "preservationResults", "lifecycleProjection",
      ].map((key) => [key, "not_run"])),
    },
    preservation: {
      sourceLogsPreserved: true,
      identityStatePreserved: true,
      independentOutputPreserved: true,
      callbackSettingsPreserved: true,
      cleanupExactInventory: "not_run",
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
      activity: gates.networkIsolation === "passed" ? "absent" : "not_measured",
      transportReady: false,
      externalParticipants: false,
    },
    profileEvidence: {
      kind: "release_decision",
      headroomBasisPoints: 2000,
      populationPercentileClaimed: false,
      singleMachineLimitation: true,
      promotionGates: gates,
      inputReceipts: Object.fromEntries(Object.entries(pairs).map(([key, pair]) => [key, {
        node24Sha256: pair.node24.receiptSha256,
        node26Sha256: pair.node26.receiptSha256,
      }])),
      decisions,
    },
    receiptSha256: "0".repeat(64),
  };
  receipt.receiptSha256 = computeR7ReleaseEvidenceReceiptSha256(receipt);
  return assertValidR7ReleaseEvidenceReceipt(receipt);
}
