import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { DEFAULT_EXPORT_RESOURCE_LIMITS } from "./export-resource-policy.js";
import {
  assertValidR7ReleaseEvidenceReceipt,
  computeR7ReleaseEvidenceReceiptSha256,
  R7_RELEASE_EVIDENCE_DETERMINISTIC_PROJECTION_VERSION,
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
import {
  cleanupR7OwnedTree,
  inventoryR7OwnedTree,
} from "./r7-resource-benchmark.js";
import { runR7FilesystemHighWaterSampler } from "./r7-filesystem-high-water.js";
import { runR7WorkerWatchdog } from "./r7-worker-watchdog.js";
import { stableJson } from "./storage.js";
import { createR7StructuralFixture } from "./r7-resource-benchmark-fixture.js";

export const R7_MATERIALIZED_BOUNDARY_BENCHMARK_VERSION =
  "g1-r7-materialized-boundary-benchmark-v0.1";

const WORKER = new URL("../scripts/r7-materialized-boundary-worker.js", import.meta.url);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseR7MaterializedBoundaryWorkerResult(bytes) {
  let value;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new TypeError("Invalid R7 materialized boundary result");
  }
  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort().join("\0") : "";
  if (keys !== "evidence\0failureCode\0status") {
    throw new TypeError("Invalid R7 materialized boundary result");
  }
  if (value.status === "completed" && value.failureCode === "none"
      && value.evidence && typeof value.evidence === "object") {
    return { evidence: value.evidence, failureCode: null };
  }
  if (value.status === "failed" && value.failureCode === "harness_failed"
      && value.evidence === null) {
    return { evidence: null, failureCode: "harness_failed" };
  }
  throw new TypeError("Invalid R7 materialized boundary result");
}

async function runPass(root, fixturePaths, timeoutMs) {
  await mkdir(root, { mode: 0o700 });
  let parsed = null;
  let workerFailureCode = null;
  let watchdog = null;
  const filesystem = await runR7FilesystemHighWaterSampler({
    root,
    maximumElapsedMs: timeoutMs,
    allowedTransientSymlinkNames: [".app-usagemonitor-export.lock"],
    allowTransientOwnedHardlinks: true,
    async operation() {
      watchdog = await runR7WorkerWatchdog({
        runtimeExecutable: process.execPath,
        workerPath: WORKER.pathname,
        cwd: process.cwd(),
        input: JSON.stringify({ temporaryRoot: root, fixturePaths }),
        timeoutMs,
        maximumRssBytes: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumRssBytes,
        consumeStdout(bytes) {
          const value = parseR7MaterializedBoundaryWorkerResult(bytes);
          parsed = value.evidence;
          workerFailureCode = value.failureCode;
        },
      });
    },
  });
  if (filesystem.outcome === "completed" && watchdog?.outcome === "completed"
      && workerFailureCode !== null) {
    throw new Error(`R7 materialized boundary worker stopped: ${workerFailureCode}`);
  }
  if (filesystem.outcome !== "completed" || watchdog?.outcome !== "completed" || parsed === null) {
    throw new Error("R7 materialized boundary isolated run stopped");
  }
  const projectionSha256 = sha256(stableJson(parsed));
  return { evidence: parsed, watchdog, filesystem, projectionSha256 };
}

function compare(first, second) {
  return first === second ? "matched" : "mismatched";
}

function runtimeVersion() {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(process.versions.node);
  if (!match) throw new Error("R7 release runtime is unsupported");
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function runtimeClass(version) {
  if (version.major === 24 && version.minor === 14 && version.patch === 0) return "pinned_candidate";
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
    metrics: {
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
    },
  };
}

function combinedHarnessMetrics(first, second) {
  return {
    runCount: 2,
    parentElapsedMs: Math.max(first.watchdog.elapsedMs, second.watchdog.elapsedMs),
    childCpuMs: 0,
    externalRssSampleCount: first.watchdog.rssSampleCount + second.watchdog.rssSampleCount,
    externalRssSampleFailureCount:
      first.watchdog.rssSampleFailureCount + second.watchdog.rssSampleFailureCount,
    externalPeakRssBytes: Math.max(first.watchdog.peakRssBytes, second.watchdog.peakRssBytes),
    childMaxRssBytes: 0,
    durablePeakRssBytes: 0,
    stdoutBytes: Math.max(first.watchdog.stdoutBytes, second.watchdog.stdoutBytes),
    stderrBytes: Math.max(first.watchdog.stderrBytes, second.watchdog.stderrBytes),
    sourceFiles: 0,
    sourceBytes: 0,
    outputRecords: 0,
    decodedBytes: 0,
    encodedBytes: 0,
    filesystem: {
      beforeBytes: Math.max(
        first.filesystem.measurements.before.bytes,
        second.filesystem.measurements.before.bytes,
      ),
      sampledHighWaterBytes: Math.max(
        first.filesystem.measurements.highWater.bytes,
        second.filesystem.measurements.highWater.bytes,
      ),
      afterBytes: Math.max(
        first.filesystem.measurements.after.bytes,
        second.filesystem.measurements.after.bytes,
      ),
    },
  };
}

function boundary(row) {
  const selectedLimit = DEFAULT_EXPORT_RESOURCE_LIMITS[
    R7_RELEASE_EVIDENCE_LIMIT_KEY_BY_DIMENSION[row.dimension]
  ];
  if (row.selectedLimit !== selectedLimit) {
    throw new Error("R7 literal candidate matrix does not match the selected policy");
  }
  const notRunSurface = { status: "not_run", failureCode: "not_run_profile" };
  const notRun = row.identification === "not_run";
  return {
    dimension: row.dimension,
    unit: R7_RELEASE_EVIDENCE_UNIT_BY_DIMENSION[row.dimension],
    selectedLimit,
    mode: notRun ? "not_identified" : row.receiptMode,
    atLimit: {
      value: selectedLimit,
      status: row.atLimit.status,
      failureCode: row.atLimit.failureCode,
    },
    plusOne: {
      value: selectedLimit + 1,
      status: row.plusOne.status,
      failureCode: row.plusOne.failureCode,
    },
    producer: notRunSurface,
    verifier: notRunSurface,
    identification: row.identification,
  };
}

function artifactEvidence(value) {
  return {
    decodedBytes: value.decodedBytes,
    encodedBytes: value.encodedBytes,
    producerStatus: value.producerStatus,
    verifierStatus: value.verifierStatus,
    decodedPlusOneStatus: value.producerDecodedPlusOne.status,
    decodedPlusOneFailureCode: value.producerDecodedPlusOne.failureCode,
    encodedPlusOneStatus: value.producerEncodedPlusOne.status,
    encodedPlusOneFailureCode: value.producerEncodedPlusOne.failureCode,
    fileControlStatus: value.fileControlStatus,
  };
}

function materializedEvidence(value) {
  return {
    longLine: {
      lineBytes: value.longLine.lineBytes,
      linePlusOneBytes: value.longLine.linePlusOneBytes,
      configuredLimit: value.longLine.configuredLimit,
      atLimitStatus: value.longLine.atLimit.status,
      plusOneStatus: value.longLine.plusOne.status,
      plusOneFailureCode: value.longLine.plusOne.failureCode,
      producerPathway: value.longLine.producerPathway,
    },
    compressibleArtifact: artifactEvidence(value.compressibleArtifact),
    incompressibleArtifact: artifactEvidence(value.incompressibleArtifact),
    workspaceFile: {
      bytes: value.workspaceFile.bytes,
      plusOneBytes: value.workspaceFile.plusOneBytes,
      atLimitStatus: value.workspaceFile.atLimit.status,
      plusOneStatus: value.workspaceFile.plusOne.status,
      plusOneFailureCode: value.workspaceFile.plusOne.failureCode,
      pathway: value.workspaceFile.pathway,
    },
  };
}

function assertContentFree(value) {
  const serialized = stableJson(value);
  for (const prohibited of [
    "R7_SYNTHETIC_CONTENT_CANARY_NEVER_EXPORT",
    "sessionId",
    "accountPseudonym",
    "modelFingerprint",
    "/Users/",
    "/var/",
    "/tmp/",
  ]) {
    if (serialized.includes(prohibited)) {
      throw new Error("R7 materialized boundary receipt privacy scan failed");
    }
  }
}

export async function runR7MaterializedBoundaryBenchmark({
  temporaryRoot = tmpdir(),
  timeoutMs = 10 * 60 * 1_000,
} = {}) {
  const rawRoot = await mkdtemp(join(temporaryRoot, "usage-monitor-r7-materialized-"));
  await chmod(rawRoot, 0o700);
  const root = await realpath(rawRoot);
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("R7 materialized benchmark root was unsafe");
  }
  const rootIdentity = { dev: rootStats.dev, ino: rootStats.ino };
  let receipt;
  try {
    const sourceRoot = join(root, "source");
    await mkdir(sourceRoot, { mode: 0o700 });
    const fixture = await createR7StructuralFixture(sourceRoot);
    await writeFile(
      join(
        fixture.paths.codexHome,
        "archived_sessions",
        "rollout-2026-07-24T11-00-00-empty.jsonl",
      ),
      "\n",
      { mode: 0o600 },
    );
    const first = await runPass(join(root, "pass-1"), fixture.paths, timeoutMs);
    const second = await runPass(join(root, "pass-2"), fixture.paths, timeoutMs);
    if (first.projectionSha256 !== second.projectionSha256) {
      throw new Error("R7 materialized boundary deterministic projections differed");
    }
    const version = runtimeVersion();
    const comparisons = {
      fixtureManifest: compare(
        first.evidence.fixtureManifestSha256,
        second.evidence.fixtureManifestSha256,
      ),
      sourcePlan: "not_run",
      logicalRecords: "not_run",
      chunkBoundaries: "not_run",
      canonicalArtifacts: "not_run",
      verifierResults: compare(first.projectionSha256, second.projectionSha256),
      fixedFailureCodes: compare(first.projectionSha256, second.projectionSha256),
      cleanupInventories: "matched",
      preservationResults: "matched",
      lifecycleProjection: compare(first.projectionSha256, second.projectionSha256),
    };
    receipt = {
      schemaVersion: R7_RELEASE_EVIDENCE_RECEIPT_VERSION,
      protocolVersion: R7_RELEASE_EVIDENCE_PROTOCOL_VERSION,
      policyVersion: R7_RELEASE_EVIDENCE_POLICY_VERSION,
      selectionRuleVersion: R7_RELEASE_EVIDENCE_SELECTION_RULE_VERSION,
      profile: "release_materialized_boundaries",
      outcome: "partial",
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
      boundaries: first.evidence.literalCandidateMatrix.map(boundary),
      determinism: {
        projectionVersion: R7_RELEASE_EVIDENCE_DETERMINISTIC_PROJECTION_VERSION,
        status: "partial",
        runCount: 2,
        runProjectionSha256es: [first.projectionSha256, second.projectionSha256],
        comparisons,
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
      network: { activity: "not_measured", transportReady: false, externalParticipants: false },
      profileEvidence: {
        kind: "release_materialized_boundaries",
        fixtureManifestSha256: first.evidence.fixtureManifestSha256,
        literalCandidateAllocationRequired: false,
        harnessMetrics: combinedHarnessMetrics(first, second),
        materializedCases: materializedEvidence(first.evidence.materialCases),
        sqliteBatch: {
          status: "not_run",
          reason: "no_injectable_sqlite_batch_seam",
        },
      },
      receiptSha256: "0".repeat(64),
    };
    assertContentFree(receipt);
    receipt.receiptSha256 = computeR7ReleaseEvidenceReceiptSha256(receipt);
    receipt = assertValidR7ReleaseEvidenceReceipt(receipt);
  } finally {
    const inventory = await inventoryR7OwnedTree(root);
    await cleanupR7OwnedTree(root, inventory, rootIdentity);
  }
  return receipt;
}
