import Ajv from "ajv";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import {
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  EXPORT_RESOURCE_POLICY_VERSION,
} from "./export-resource-policy.js";
import {
  R7_RESOURCE_BENCHMARK_BOUNDARY_DIMENSIONS,
  R7_RESOURCE_BENCHMARK_FAILURE_CODE_BY_DIMENSION,
  R7_RESOURCE_BENCHMARK_LIMIT_KEY_BY_DIMENSION,
  R7_RESOURCE_BENCHMARK_OPERATION_NAMES,
  R7_RESOURCE_BENCHMARK_SELECTION_RULE_VERSION,
  R7_RESOURCE_BENCHMARK_UNIT_BY_DIMENSION,
} from "./r7-resource-benchmark-schema.js";
import { stableJson } from "./storage.js";

export const R7_RELEASE_EVIDENCE_RECEIPT_VERSION = "r7-release-evidence-receipt-v0.1";
export const R7_RELEASE_EVIDENCE_PROTOCOL_VERSION = "g1-r7-release-evidence-v0.1";
export const R7_RELEASE_EVIDENCE_POLICY_VERSION = EXPORT_RESOURCE_POLICY_VERSION;
export const R7_RELEASE_EVIDENCE_SELECTION_RULE_VERSION =
  R7_RESOURCE_BENCHMARK_SELECTION_RULE_VERSION;
export const R7_RELEASE_EVIDENCE_DETERMINISTIC_PROJECTION_VERSION =
  "g1-r7-release-deterministic-projection-v0.1";

export const R7_RELEASE_EVIDENCE_PROFILES = Object.freeze([
  "release_synthetic_semantics",
  "release_synthetic_pressure",
  "release_materialized_boundaries",
  "release_real_local_history",
  "release_decision",
]);
export const R7_RELEASE_EVIDENCE_OPERATION_NAMES = R7_RESOURCE_BENCHMARK_OPERATION_NAMES;
export const R7_RELEASE_EVIDENCE_DIMENSIONS = R7_RESOURCE_BENCHMARK_BOUNDARY_DIMENSIONS;
export const R7_RELEASE_EVIDENCE_UNIT_BY_DIMENSION = R7_RESOURCE_BENCHMARK_UNIT_BY_DIMENSION;
export const R7_RELEASE_EVIDENCE_LIMIT_KEY_BY_DIMENSION =
  R7_RESOURCE_BENCHMARK_LIMIT_KEY_BY_DIMENSION;
export const R7_RELEASE_EVIDENCE_FAILURE_CODE_BY_DIMENSION =
  R7_RESOURCE_BENCHMARK_FAILURE_CODE_BY_DIMENSION;
export const R7_RELEASE_EVIDENCE_DECISIONS = Object.freeze([
  "retain", "lower", "unresolved", "deferred",
]);

const schemaUrl = new URL(
  "../schemas/r7-release-evidence-v0.1/receipt.schema.json",
  import.meta.url,
);
const moduleUrl = new URL("./r7-release-evidence-schema.js", import.meta.url);
const policyUrl = new URL("./export-resource-policy.js", import.meta.url);
const schemaBytes = readFileSync(schemaUrl);
const moduleBytes = readFileSync(moduleUrl);
const policyBytes = readFileSync(policyUrl);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export const R7_RELEASE_EVIDENCE_RECEIPT_SCHEMA_SHA256 = sha256(schemaBytes);
export const R7_RELEASE_EVIDENCE_SCHEMA_MODULE_SHA256 = sha256(moduleBytes);
export const R7_RELEASE_EVIDENCE_RESOURCE_POLICY_SOURCE_SHA256 = sha256(policyBytes);
export const R7_RELEASE_EVIDENCE_RESOURCE_POLICY_VALUES_SHA256 = sha256(
  stableJson(DEFAULT_EXPORT_RESOURCE_LIMITS),
);

function workloadSourcePaths() {
  const sourceDirectory = new URL("./", import.meta.url);
  const repositoryRoot = new URL("../", import.meta.url);
  const runtimeJsonPaths = [];
  const visitRuntimeJsonDirectory = (relativeDirectory) => {
    const entries = readdirSync(new URL(`${relativeDirectory}/`, repositoryRoot), {
      withFileTypes: true,
    }).sort((left, right) => (
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    ));
    for (const entry of entries) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) visitRuntimeJsonDirectory(relativePath);
      else if (entry.isFile() && entry.name.endsWith(".json")) runtimeJsonPaths.push(relativePath);
      else if (!entry.isFile()) {
        throw new TypeError("R7 workload schema tree contains an unsupported entry");
      }
    }
  };
  visitRuntimeJsonDirectory("contracts");
  visitRuntimeJsonDirectory("schemas");
  return [
    ...readdirSync(sourceDirectory)
      .filter((name) => name.endsWith(".js"))
      .sort()
      .map((name) => `src/${name}`),
    "scripts/r7-materialized-boundary-worker.js",
    "scripts/r7-resource-benchmark-worker.js",
    ...runtimeJsonPaths,
    "generated/telemetry-v0.1-compatibility.json",
    "generated/telemetry-v0.1-field-dictionary.json",
    "package.json",
    "pnpm-lock.yaml",
  ];
}

export const R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_PATHS = Object.freeze(
  workloadSourcePaths(),
);

export function computeR7ReleaseEvidenceWorkloadSourceProvenance({
  readSourceBytes,
} = {}) {
  const repositoryRoot = new URL("../", import.meta.url);
  const readBytes = readSourceBytes ?? ((relativePath) => (
    readFileSync(new URL(relativePath, repositoryRoot))
  ));
  if (typeof readBytes !== "function") {
    throw new TypeError("readSourceBytes must be a function when provided");
  }
  const digest = createHash("sha256");
  digest.update("app-usagemonitor/r7-release-workload-source-set/v1\0");
  for (const relativePath of R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_PATHS) {
    const bytes = Buffer.from(readBytes(relativePath));
    digest.update(relativePath);
    digest.update("\0");
    digest.update(String(bytes.length));
    digest.update("\0");
    digest.update(bytes);
  }
  return {
    sha256: digest.digest("hex"),
    fileCount: R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_PATHS.length,
  };
}

const currentWorkloadSource = computeR7ReleaseEvidenceWorkloadSourceProvenance();
export const R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_SHA256 = currentWorkloadSource.sha256;
export const R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_FILE_COUNT = currentWorkloadSource.fileCount;

const require = createRequire(import.meta.url);
export const r7ReleaseEvidenceReceiptSchema = require(
  "../schemas/r7-release-evidence-v0.1/receipt.schema.json",
);

const ajv = new Ajv({ allErrors: true, strict: true });
const validateSchema = ajv.compile(r7ReleaseEvidenceReceiptSchema);

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

export function r7ReleaseEvidenceReceiptHashProjection(receipt) {
  const { receiptSha256: _receiptSha256, ...projection } = receipt;
  return projection;
}

export function computeR7ReleaseEvidenceReceiptSha256(receipt) {
  return sha256(stableJson(r7ReleaseEvidenceReceiptHashProjection(receipt)));
}

function isAllZero(value) {
  if (typeof value === "number") return value === 0;
  if (!value || typeof value !== "object") return true;
  return Object.values(value).every(isAllZero);
}

function provenanceErrors(receipt) {
  const errors = [];
  const { runtimeProvenance: runtime, contractProvenance: contract } = receipt;
  const version = runtime.runtimeVersion;
  const pinned = version.major === 24 && version.minor === 14 && version.patch === 0;
  const crosscheck = version.major === 26 && version.minor === 2 && version.patch === 0;
  if ((runtime.runtimeClass === "pinned_candidate" && !pinned)
      || (runtime.runtimeClass === "compatibility_crosscheck" && !crosscheck)) {
    errors.push(invariant("/runtimeProvenance/runtimeClass", "qualified-runtime-class"));
  }
  const expected = {
    receiptSchemaSha256: R7_RELEASE_EVIDENCE_RECEIPT_SCHEMA_SHA256,
    schemaModuleSha256: R7_RELEASE_EVIDENCE_SCHEMA_MODULE_SHA256,
    resourcePolicySourceSha256: R7_RELEASE_EVIDENCE_RESOURCE_POLICY_SOURCE_SHA256,
    resourcePolicyValuesSha256: R7_RELEASE_EVIDENCE_RESOURCE_POLICY_VALUES_SHA256,
    workloadCodeSha256: R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_SHA256,
  };
  for (const [field, digest] of Object.entries(expected)) {
    if (contract[field] !== digest) {
      errors.push(invariant(`/contractProvenance/${field}`, `current-${field}`));
    }
  }
  if (contract.workloadCodeFileCount !== R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_FILE_COUNT) {
    errors.push(invariant(
      "/contractProvenance/workloadCodeFileCount",
      "current-workloadCodeFileCount",
    ));
  }
  return errors;
}

function operationErrors(receipt) {
  const errors = [];
  for (const [index, operation] of receipt.operations.entries()) {
    const path = `/operations/${index}`;
    if (operation.name !== R7_RELEASE_EVIDENCE_OPERATION_NAMES[index]) {
      errors.push(invariant(`${path}/name`, "canonical-operation-order"));
    }
    if (operation.status === "not_run") {
      if (operation.failureCode !== "not_run_profile" || operation.projectionSha256 !== "not_run") {
        errors.push(invariant(path, "not-run-operation-honesty"));
      }
      if (!isAllZero(operation.metrics)) {
        errors.push(invariant(`${path}/metrics`, "not-run-zero-metrics"));
      }
      continue;
    }
    if (operation.metrics.runCount < 1 || operation.projectionSha256 === "not_run") {
      errors.push(invariant(path, "executed-operation-evidence"));
    }
    if (["completed", "interrupted_recovered"].includes(operation.status)
        && operation.metrics.externalRssSampleCount < 1) {
      errors.push(invariant(`${path}/metrics/externalRssSampleCount`, "successful-operation-rss-sample"));
    }
    if (operation.status === "completed" && operation.failureCode !== "none") {
      errors.push(invariant(`${path}/failureCode`, "completed-operation-code"));
    }
    if (operation.status === "interrupted_recovered"
        && operation.failureCode !== "interruption_injected") {
      errors.push(invariant(`${path}/failureCode`, "recovered-operation-code"));
    }
    if (operation.status === "rejected_at_limit"
        && ["none", "not_run_profile", "not_applicable"].includes(operation.failureCode)) {
      errors.push(invariant(`${path}/failureCode`, "rejected-operation-code"));
    }
    const metrics = operation.metrics;
    if (metrics.stdoutBytes > runtimeLimit(receipt, "stdoutLimitBytes")
        || metrics.stderrBytes > runtimeLimit(receipt, "stderrLimitBytes")) {
      errors.push(invariant(`${path}/metrics`, "bounded-watchdog-metrics"));
    }
    const { beforeBytes, sampledHighWaterBytes, afterBytes } = metrics.filesystem;
    if (sampledHighWaterBytes < beforeBytes || sampledHighWaterBytes < afterBytes) {
      errors.push(invariant(`${path}/metrics/filesystem`, "filesystem-high-water"));
    }
  }
  if (!["release_decision", "release_materialized_boundaries"].includes(receipt.profile)
      && receipt.operations.every((operation) => operation.status === "not_run")) {
    errors.push(invariant("/operations", "release-profile-requires-execution"));
  }
  return errors;
}

function runtimeLimit(receipt, key) {
  return receipt.runtimeProvenance[key];
}

function isHonestNotRunBoundary(row) {
  return row.mode === "not_identified"
    && row.identification === "not_run"
    && row.atLimit.status === "not_run"
    && row.atLimit.failureCode === "not_run_profile"
    && row.plusOne.status === "not_run"
    && row.plusOne.failureCode === "not_run_profile"
    && row.producer.status === "not_run"
    && row.producer.failureCode === "not_run_profile"
    && row.verifier.status === "not_run"
    && row.verifier.failureCode === "not_run_profile";
}

function trialCodeErrors(trial, path, expectedCode, strictRejection = true) {
  const expected = trial.status === "passed"
    ? "none"
    : trial.status === "not_run"
      ? "not_run_profile"
      : strictRejection
        ? expectedCode
        : null;
  if (trial.status === "rejected" && !strictRejection
      && ["none", "not_run_profile", "not_applicable"].includes(trial.failureCode)) {
    return [invariant(`${path}/failureCode`, "unidentified-boundary-fixed-rejection")];
  }
  return expected !== null && trial.failureCode !== expected
    ? [invariant(`${path}/failureCode`, "boundary-trial-code")]
    : [];
}

function surfaceCodeErrors(surface, path, expectedCode) {
  const expected = surface.status === "enforced"
    ? expectedCode
    : surface.status === "not_run"
      ? "not_run_profile"
      : surface.status === "not_applicable"
        ? "not_applicable"
        : "verification_failed";
  return expected !== null && surface.failureCode !== expected
    ? [invariant(`${path}/failureCode`, "boundary-surface-code")]
    : [];
}

function boundaryErrors(receipt) {
  const errors = [];
  const materializedProfile = receipt.profile === "release_materialized_boundaries";
  for (const [index, row] of receipt.boundaries.entries()) {
    const path = `/boundaries/${index}`;
    if (row.dimension !== R7_RELEASE_EVIDENCE_DIMENSIONS[index]) {
      errors.push(invariant(`${path}/dimension`, "canonical-boundary-order"));
    }
    if (row.unit !== R7_RELEASE_EVIDENCE_UNIT_BY_DIMENSION[row.dimension]) {
      errors.push(invariant(`${path}/unit`, "dimension-unit"));
    }
    if (row.atLimit.value !== row.selectedLimit) {
      errors.push(invariant(`${path}/atLimit/value`, "at-limit-value"));
    }
    if (row.plusOne.value !== row.selectedLimit + 1) {
      errors.push(invariant(`${path}/plusOne/value`, "plus-one-value"));
    }
    if (!materializedProfile) {
      if (!isHonestNotRunBoundary(row)) {
        errors.push(invariant(path, "profile-boundary-separation"));
      }
      continue;
    }
    const expectedCode = R7_RELEASE_EVIDENCE_FAILURE_CODE_BY_DIMENSION[row.dimension];
    const strictRejection = row.identification === "identified";
    errors.push(...trialCodeErrors(row.atLimit, `${path}/atLimit`, expectedCode, strictRejection));
    errors.push(...trialCodeErrors(row.plusOne, `${path}/plusOne`, expectedCode, strictRejection));
    errors.push(...surfaceCodeErrors(row.producer, `${path}/producer`, expectedCode));
    errors.push(...surfaceCodeErrors(row.verifier, `${path}/verifier`, expectedCode));

    if (row.identification === "not_run" && !isHonestNotRunBoundary(row)) {
      errors.push(invariant(path, "not-run-boundary-honesty"));
    }
    if (row.identification === "identified"
        && (expectedCode === null
          || row.mode !== "materialized"
          || row.atLimit.status !== "passed"
          || row.plusOne.status !== "rejected"
          || row.producer.status !== "enforced"
          || !["enforced", "not_applicable"].includes(row.verifier.status))) {
      errors.push(invariant(path, "integrated-boundary-identification"));
    }
    if (row.mode === "synthetic_counter" && row.identification === "identified") {
      errors.push(invariant(`${path}/identification`, "counter-is-not-integrated"));
    }
    if (row.identification === "not_identified" && row.mode === "materialized"
        && row.atLimit.status === "passed" && row.plusOne.status === "rejected"
        && row.producer.status === "enforced"
        && ["enforced", "not_applicable"].includes(row.verifier.status)) {
      errors.push(invariant(`${path}/identification`, "completed-boundary-must-be-identified"));
    }
  }
  return errors;
}

function determinismErrors(receipt) {
  const errors = [];
  const { status, runCount, runProjectionSha256es, comparisons } = receipt.determinism;
  const values = Object.values(comparisons);
  if (receipt.profile === "release_decision") {
    if (status !== "not_run" || runCount !== 0 || runProjectionSha256es.length !== 0
        || values.some((value) => value !== "not_run")) {
      errors.push(invariant("/determinism", "decision-does-not-blend-lifecycle"));
    }
    return errors;
  }
  if (runCount !== 2 || runProjectionSha256es.length !== 2 || status === "not_run") {
    errors.push(invariant("/determinism", "two-run-release-determinism"));
    return errors;
  }
  const mismatch = values.some((value) => value === "mismatched");
  const notRun = values.some((value) => value === "not_run");
  if ((status === "passed" && (mismatch || notRun))
      || (status === "partial" && (mismatch || !notRun))
      || (status === "failed" && !mismatch)) {
    errors.push(invariant("/determinism/status", "determinism-summary"));
  }
  const projectionsMatch = runProjectionSha256es[0] === runProjectionSha256es[1];
  if ((comparisons.lifecycleProjection === "matched" && !projectionsMatch)
      || (comparisons.lifecycleProjection === "mismatched" && projectionsMatch)) {
    errors.push(invariant(
      "/determinism/runProjectionSha256es",
      "determinism-projection-hash-consistency",
    ));
  }
  return errors;
}

function decisionErrors(receipt) {
  const errors = [];
  const decisionProfile = receipt.profile === "release_decision";
  if (receipt.profileEvidence.kind !== receipt.profile) {
    errors.push(invariant("/profileEvidence/kind", "profile-evidence-separation"));
    return errors;
  }
  if (!decisionProfile) {
    if (["release_ready", "release_open"].includes(receipt.outcome)) {
      errors.push(invariant("/outcome", "non-decision-outcome"));
    }
    if (receipt.profile === "release_materialized_boundaries") {
      const metrics = receipt.profileEvidence.harnessMetrics;
      if (metrics.runCount !== 2 || metrics.externalRssSampleCount < 1) {
        errors.push(invariant(
          "/profileEvidence/harnessMetrics",
          "materialized-harness-measured",
        ));
      }
      const cases = receipt.profileEvidence.materializedCases;
      if (cases.compressibleArtifact.encodedBytes < 1
          || cases.incompressibleArtifact.encodedBytes < 1) {
        errors.push(invariant(
          "/profileEvidence/materializedCases",
          "materialized-artifact-encoded-bytes-measured",
        ));
      }
      // The retained aggregate explicitly records that the SQLite batch seam
      // was not run. This profile therefore remains partial until a new schema
      // version can represent completed evidence for that gate.
      if (receipt.profileEvidence.sqliteBatch.status === "not_run"
          && receipt.outcome === "passed") {
        errors.push(invariant(
          "/outcome",
          "materialized-sqlite-gate-open",
        ));
      }
    }
    return errors;
  }
  if (!["release_ready", "release_open"].includes(receipt.outcome)) {
    errors.push(invariant("/outcome", "decision-outcome"));
  }
  if (receipt.operations.some((operation) => operation.status !== "not_run")) {
    errors.push(invariant("/operations", "decision-operation-separation"));
  }
  const gateStatuses = Object.values(receipt.profileEvidence.promotionGates);
  const hasOpenGate = gateStatuses.some((status) => status !== "passed");
  if (receipt.outcome === "release_ready" && hasOpenGate) {
    errors.push(invariant(
      "/profileEvidence/promotionGates",
      "release-ready-promotion-gates-complete",
    ));
  }
  if (receipt.outcome === "release_ready" && receipt.network.activity !== "absent") {
    errors.push(invariant("/network/activity", "release-ready-network-measured-absent"));
  }
  let hasOpenDecision = false;
  for (const [index, row] of receipt.profileEvidence.decisions.entries()) {
    const path = `/profileEvidence/decisions/${index}`;
    if (row.dimension !== R7_RELEASE_EVIDENCE_DIMENSIONS[index]) {
      errors.push(invariant(`${path}/dimension`, "canonical-decision-order"));
    }
    if (row.unit !== R7_RELEASE_EVIDENCE_UNIT_BY_DIMENSION[row.dimension]) {
      errors.push(invariant(`${path}/unit`, "decision-unit"));
    }
    const candidate = DEFAULT_EXPORT_RESOURCE_LIMITS[
      R7_RELEASE_EVIDENCE_LIMIT_KEY_BY_DIMENSION[row.dimension]
    ];
    if (row.candidateValue !== candidate) {
      errors.push(invariant(`${path}/candidateValue`, "current-policy-candidate"));
    }
    if (row.decision === "retain" && row.decidedValue !== row.candidateValue) {
      errors.push(invariant(`${path}/decidedValue`, "retain-candidate"));
    }
    if (row.decision === "lower"
        && (typeof row.decidedValue !== "number" || row.decidedValue >= row.candidateValue)) {
      errors.push(invariant(`${path}/decidedValue`, "lower-candidate"));
    }
    if (["unresolved", "deferred"].includes(row.decision)) {
      hasOpenDecision = true;
      if (row.decidedValue !== "not_set") {
        errors.push(invariant(`${path}/decidedValue`, "open-decision-has-no-value"));
      }
    }
    if (row.decision === "deferred" && row.selectionBasis !== "deferred") {
      errors.push(invariant(`${path}/selectionBasis`, "deferred-basis"));
    }
    if (row.decision === "unresolved" && row.selectionBasis !== "not_identified") {
      errors.push(invariant(`${path}/selectionBasis`, "unresolved-basis"));
    }
    if (row.selectionBasis === "exact_boundary" && row.exactBoundaryValue === "not_identified") {
      errors.push(invariant(`${path}/exactBoundaryValue`, "exact-boundary-basis"));
    }
    if (row.selectionBasis === "real_history" && row.realHistoryValue === "not_identified") {
      errors.push(invariant(`${path}/realHistoryValue`, "real-history-basis"));
    }
  }
  if ((receipt.outcome === "release_open") !== (hasOpenDecision || hasOpenGate)) {
    errors.push(invariant("/outcome", "decision-openness"));
  }
  return errors;
}

function networkErrors(receipt) {
  if (receipt.network.activity === "not_measured"
      && ["passed", "release_ready"].includes(receipt.outcome)) {
    return [invariant("/outcome", "unmeasured-network-cannot-pass")];
  }
  return [];
}

function completedOutcomeErrors(receipt) {
  if (receipt.outcome !== "passed") return [];
  const errors = [];
  if (receipt.determinism.status !== "passed") {
    errors.push(invariant("/determinism/status", "passed-outcome-requires-determinism"));
  }
  if (receipt.preservation.cleanupExactInventory !== "passed") {
    errors.push(invariant(
      "/preservation/cleanupExactInventory",
      "passed-outcome-requires-preservation",
    ));
  }
  if (receipt.network.activity !== "absent") {
    errors.push(invariant("/network/activity", "passed-outcome-requires-network-isolation"));
  }
  return errors;
}

function semanticErrors(receipt) {
  const errors = [
    ...provenanceErrors(receipt),
    ...operationErrors(receipt),
    ...boundaryErrors(receipt),
    ...determinismErrors(receipt),
    ...decisionErrors(receipt),
    ...networkErrors(receipt),
    ...completedOutcomeErrors(receipt),
  ];
  if (receipt.receiptSha256 !== computeR7ReleaseEvidenceReceiptSha256(receipt)) {
    errors.push(invariant("/receiptSha256", "semantic-receipt-sha256"));
  }
  return errors.slice(0, 20);
}

export function validateR7ReleaseEvidenceReceipt(receipt) {
  if (!validateSchema(receipt)) {
    return { valid: false, errors: safeValidationErrors(validateSchema.errors) };
  }
  const errors = semanticErrors(receipt);
  return { valid: errors.length === 0, errors };
}

export function assertValidR7ReleaseEvidenceReceipt(receipt) {
  const result = validateR7ReleaseEvidenceReceipt(receipt);
  if (!result.valid) {
    const error = new TypeError("Invalid R7 release evidence receipt");
    error.validationErrors = result.errors;
    throw error;
  }
  return receipt;
}
