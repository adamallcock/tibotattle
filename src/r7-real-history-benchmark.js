import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { homedir, tmpdir, totalmem } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { defaultClaudeStatusStateDirectory } from "./claude-statusline-storage.js";
import { defaultClaudeProjectsDirectory } from "./claude-transcript-export-source.js";
import {
  createExportSourcePlanBundle,
  resolveExportSourcePlanBundle,
  summarizeExportSourcePlanBundle,
} from "./export-source-plan-bundle.js";
import {
  createExportResourceGuard,
  DEFAULT_EXPORT_RESOURCE_LIMITS,
} from "./export-resource-policy.js";
import { runR7FilesystemHighWaterSampler } from "./r7-filesystem-high-water.js";
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
import {
  cleanupR7OwnedTree,
  inventoryR7OwnedTree,
  runR7BenchmarkWorker,
} from "./r7-resource-benchmark.js";
import {
  R7_WORKER_DEFAULT_MAXIMUM_STDIN_BYTES,
  R7_WORKER_MAXIMUM_STDIN_BYTES,
  R7_WORKER_MAXIMUM_TIMEOUT_MS,
} from "./r7-worker-watchdog.js";
import { stableJson } from "./storage.js";

export const R7_REAL_HISTORY_BENCHMARK_VERSION =
  "g1-r7-real-local-history-benchmark-v0.1";
export const R7_REAL_HISTORY_MAXIMUM_SOURCE_PLAN_BUNDLE_BYTES =
  R7_WORKER_MAXIMUM_STDIN_BYTES - R7_WORKER_DEFAULT_MAXIMUM_STDIN_BYTES;

export class R7RealHistoryEligibilityError extends Error {
  constructor() {
    super("R7 real-history profile is not runnable with the bounded private-plan transport");
    this.name = "R7RealHistoryEligibilityError";
    this.code = "r7_real_history_source_plan_input";
  }
}

const execFileAsync = promisify(execFile);
const FIXED_CHILD_ENVIRONMENT = Object.freeze({ LANG: "C", LC_ALL: "C", TZ: "UTC" });
const RUNTIME_QUERY = "JSON.stringify({version:process.versions.node,platform:process.platform,architecture:process.arch})";
const EXECUTED_OPERATIONS = Object.freeze([
  "source_scan",
  "export_set_materialize",
  "export_set_verify",
  "complete_set_delete",
]);
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeInterval(startAt, endAt) {
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (typeof startAt !== "string" || typeof endAt !== "string"
      || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs
      || new Date(startMs).toISOString() !== startAt
      || new Date(endMs).toISOString() !== endAt
      || endMs - startMs > DEFAULT_EXPORT_RESOURCE_LIMITS.maximumCoveredDurationMs) {
    throw new TypeError("R7 real-history interval must be an exact positive interval of at most 31 days");
  }
  return { startAt, endAt, startMs, endMs, coveredDurationMs: endMs - startMs };
}

function normalizeRuntimeExecutables(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2
      || value.some((path) => typeof path !== "string" || !isAbsolute(path)
        || path.length === 0 || path.includes("\0"))
      || new Set(value).size !== value.length) {
    throw new TypeError("R7 real-history runtimes must be one or two unique absolute executables");
  }
  return [...value];
}

function normalizeTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
      || timeoutMs > R7_WORKER_MAXIMUM_TIMEOUT_MS) {
    throw new TypeError("R7 real-history timeout is outside its fixed range");
  }
  return timeoutMs;
}

function runtimeVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error("R7 real-history child runtime version is unsupported");
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function runtimeClass(version) {
  if (version.major === 24 && version.minor === 14 && version.patch === 0) {
    return "pinned_candidate";
  }
  if (version.major === 26 && version.minor === 2 && version.patch === 0) {
    return "compatibility_crosscheck";
  }
  throw new Error("R7 real-history child runtime is not exactly release-qualified");
}

async function queryChildRuntime(runtimeExecutable) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(runtimeExecutable, ["-p", RUNTIME_QUERY], {
      cwd: process.cwd(),
      env: { ...FIXED_CHILD_ENVIRONMENT },
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 4_096,
      windowsHide: true,
    }));
  } catch {
    throw new Error("R7 real-history child runtime provenance query failed");
  }
  let value;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    throw new Error("R7 real-history child runtime provenance was invalid");
  }
  if (value?.platform !== "darwin" || value?.architecture !== "arm64") {
    throw new Error("R7 real-history child runtime is not macOS arm64");
  }
  const version = runtimeVersion(value.version);
  return {
    platform: value.platform,
    architecture: value.architecture,
    runtimeVersion: version,
    runtimeClass: runtimeClass(version),
  };
}

function ramBucket() {
  const gibibytes = totalmem() / (1024 ** 3);
  if (gibibytes <= 32) return "up_to_32_gib";
  if (gibibytes <= 64) return "33_to_64_gib";
  if (gibibytes <= 128) return "65_to_128_gib";
  return "over_128_gib";
}

function workerConfig(operation, secretHex, interval, extra = {}) {
  return {
    operation,
    secretHex,
    startAt: interval.startAt,
    endAt: interval.endAt,
    createdAt: interval.endAt,
    resourceLimits: {},
    ...extra,
  };
}

function sourceScanInputBytes(config) {
  return Buffer.byteLength(JSON.stringify(config), "utf8");
}

export function assertR7RealHistorySourcePlanEligibility(summary) {
  if (!summary || !Number.isSafeInteger(summary.canonicalBytes)
      || summary.canonicalBytes < 1) {
    throw new TypeError("R7 real-history source-plan summary is invalid");
  }
  if (summary.canonicalBytes > R7_REAL_HISTORY_MAXIMUM_SOURCE_PLAN_BUNDLE_BYTES) {
    throw new R7RealHistoryEligibilityError();
  }
  return summary;
}

function requireCompleted(operation) {
  if (operation?.status !== "completed") {
    const failureCode = typeof operation?.failureCode === "string"
      && /^(?:source_integrity|operation_failed|(?:bundle_verification|claude_callback_lifecycle|export|internal|storage|system)_[a-z0-9_]+)$/u
        .test(operation.failureCode)
      ? operation.failureCode
      : "invalid_worker_failure_code";
    throw new Error(`R7 real-history lifecycle operation failed: ${failureCode}`);
  }
  return operation;
}

function aggregateMeasuredOperation(operation, filesystem) {
  return {
    name: operation.operation,
    status: operation.status,
    failureCode: operation.failureCode,
    parentElapsedMs: operation.parentElapsedMs,
    childCpuMs: Math.ceil((operation.cpuUserMicros + operation.cpuSystemMicros) / 1_000),
    externalRssSampleCount: operation.rssSampleCount,
    externalRssSampleFailureCount: operation.rssSampleFailureCount,
    externalPeakRssBytes: operation.externalPeakRssBytes,
    childMaxRssBytes: operation.peakRssBytes,
    durablePeakRssBytes: operation.evidence.durablePeakRssBytes ?? 0,
    stdoutBytes: operation.watchdogStdoutBytes,
    stderrBytes: operation.watchdogStderrBytes,
    sourceFiles: operation.evidence.sourceFiles,
    sourceBytes: operation.evidence.sourceBytes,
    outputRecords: operation.evidence.outputRecords,
    decodedBytes: operation.evidence.decodedArtifactBytes,
    encodedBytes: operation.evidence.encodedArtifactBytes,
    projectionSha256: operation.evidence.operationEvidenceSha256,
    evidence: {
      sourcePlanSha256: operation.evidence.sourcePlanSha256,
      frozenPlanSha256: operation.evidence.frozenPlanSha256,
      logicalRecordsSha256: operation.evidence.logicalRecordsSha256,
      chunkBoundariesSha256: operation.evidence.chunkBoundariesSha256,
      canonicalArtifactsSha256: operation.evidence.canonicalArtifactsSha256,
      sourceLogsPreserved: operation.evidence.sourceLogsPreserved,
      identityStatePreserved: operation.evidence.identityStatePreserved,
      independentOutputPreserved: operation.evidence.independentOutputPreserved,
    },
    filesystem: {
      beforeBytes: filesystem.measurements.before.bytes,
      sampledHighWaterBytes: filesystem.measurements.highWater.bytes,
      afterBytes: filesystem.measurements.after.bytes,
    },
  };
}

async function runMeasuredWorker(root, config, {
  runtimeExecutable,
  timeoutMs,
  sourceScan = false,
}) {
  let operation = null;
  if (sourceScan && sourceScanInputBytes(config) > R7_WORKER_MAXIMUM_STDIN_BYTES) {
    throw new RangeError("R7 real-history private source-plan input exceeds 32 MiB");
  }
  const filesystem = await runR7FilesystemHighWaterSampler({
    root,
    maximumElapsedMs: timeoutMs,
    allowedTransientSymlinkNames: [".app-usagemonitor-export.lock"],
    allowTransientOwnedHardlinks: true,
    async operation() {
      operation = await runR7BenchmarkWorker(config, {
        timeoutMs,
        runtimeExecutable,
        ...(sourceScan ? { maximumStdinBytes: R7_WORKER_MAXIMUM_STDIN_BYTES } : {}),
      });
    },
  });
  if (filesystem.outcome !== "completed") {
    throw new Error(`R7 real-history filesystem sampling stopped: ${filesystem.outcome}`);
  }
  return aggregateMeasuredOperation(requireCompleted(operation), filesystem);
}

function deterministicProjection(operation) {
  return {
    name: operation.name,
    status: operation.status,
    failureCode: operation.failureCode,
    projectionSha256: operation.projectionSha256,
    evidence: operation.evidence,
  };
}

async function runLifecyclePass(root, sourcePlanBundle, secretHex, interval, options) {
  await mkdir(root, { mode: 0o700 });
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("R7 real-history pass root was unsafe");
  }
  const rootIdentity = { dev: rootStats.dev, ino: rootStats.ino };
  const workspaceDirectory = join(root, "workspace");
  const outputDirectory = join(root, "output");
  const operations = [];
  operations.push(await runMeasuredWorker(root, workerConfig(
    "source_scan",
    secretHex,
    interval,
    { workspaceDirectory, sourcePlanBundle },
  ), { ...options, sourceScan: true }));
  operations.push(await runMeasuredWorker(root, workerConfig(
    "export_set_materialize",
    secretHex,
    interval,
    {
      workspaceDirectory,
      outputDirectory,
      maximumRecordsPerChunk: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumOutputRecords,
    },
  ), options));
  operations.push(await runMeasuredWorker(root, workerConfig(
    "export_set_verify",
    secretHex,
    interval,
    { outputDirectory, verificationTemporaryRoot: root },
  ), options));
  operations.push(await runMeasuredWorker(root, workerConfig(
    "complete_set_delete",
    secretHex,
    interval,
    { workspaceDirectory, outputDirectory },
  ), options));

  const sourceOperation = operationByName({ operations }, "source_scan");
  const deletionOperation = operationByName({ operations }, "complete_set_delete");
  if (sourceOperation.evidence.frozenPlanSha256 !== sourcePlanBundle.sourcePlanBundleSha256
      || operations.some((operation) => !/^[a-f0-9]{64}$/.test(operation.projectionSha256))
      || deletionOperation.evidence.sourceLogsPreserved !== true
      || deletionOperation.evidence.identityStatePreserved !== true
      || deletionOperation.evidence.independentOutputPreserved !== true) {
    throw new Error("R7 real-history lifecycle preservation evidence failed");
  }

  const cleanupInventory = await inventoryR7OwnedTree(root);
  const projectionSha256 = sha256(stableJson({
    operations: operations.map(deterministicProjection),
  }));
  const cleanup = await cleanupR7OwnedTree(root, cleanupInventory, rootIdentity);
  if (!cleanup.exhausted) throw new Error("R7 real-history pass cleanup was incomplete");
  return {
    operations,
    cleanupInventorySha256: cleanupInventory.deterministicProjectionSha256,
    projectionSha256,
  };
}

function comparison(left, right) {
  return typeof left === "string" && left === right ? "matched" : "mismatched";
}

function operationByName(pass, name) {
  return pass.operations.find((operation) => operation.name === name);
}

function comparisonHashes(pass, sourcePlanBundleSha256) {
  const source = operationByName(pass, "source_scan");
  const materialize = operationByName(pass, "export_set_materialize");
  const verify = operationByName(pass, "export_set_verify");
  return {
    fixtureManifest: sourcePlanBundleSha256,
    sourcePlan: source.evidence.sourcePlanSha256,
    logicalRecords: materialize.evidence.logicalRecordsSha256,
    chunkBoundaries: materialize.evidence.chunkBoundariesSha256,
    canonicalArtifacts: materialize.evidence.canonicalArtifactsSha256,
    verifierResults: verify.projectionSha256,
    fixedFailureCodes: sha256(stableJson(pass.operations.map(({ name, status, failureCode }) => ({
      name,
      status,
      failureCode,
    })))),
    cleanupInventories: pass.cleanupInventorySha256,
    preservationResults: sha256(stableJson({
      sourceLogsPreserved: true,
      identityStatePreserved: true,
      independentOutputPreserved: true,
      callbackSettingsPreserved: true,
    })),
    lifecycleProjection: pass.projectionSha256,
  };
}

function comparePasses(first, second, sourcePlanBundleSha256) {
  const firstHashes = comparisonHashes(first, sourcePlanBundleSha256);
  const secondHashes = comparisonHashes(second, sourcePlanBundleSha256);
  const comparisons = Object.fromEntries(Object.keys(firstHashes).map((key) => [
    key,
    comparison(firstHashes[key], secondHashes[key]),
  ]));
  if (Object.values(comparisons).some((value) => value !== "matched")) {
    throw new Error("R7 real-history deterministic projections differed");
  }
  return {
    status: "passed",
    runProjectionSha256es: [first.projectionSha256, second.projectionSha256],
    comparisons,
  };
}

function assertContentFree(value, secretHex = null) {
  const serialized = stableJson(value);
  const prohibitedFragments = [
    "/Users/",
    "/home/",
    "/private/",
    "/tmp/",
    "sessionId",
    "eventId",
    "participantId",
    "accountPseudonym",
    "modelFingerprint",
    "workspaceDirectory",
    "outputDirectory",
  ];
  if (secretHex) prohibitedFragments.push(secretHex);
  if (prohibitedFragments.some((fragment) => serialized.includes(fragment))
      || /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(serialized)) {
    throw new Error("R7 real-history evidence privacy scan failed");
  }
}

/**
 * Freeze all four enabled local providers once, then run two fresh, isolated
 * lifecycle passes for every requested exact child runtime. The private bundle
 * and ephemeral secret stay in this process and bounded worker stdin only.
 */
export async function runR7RealHistoryEvidence({
  startAt,
  endAt,
  runtimeExecutables = [process.execPath],
  temporaryRoot = tmpdir(),
  timeoutMs = R7_WORKER_MAXIMUM_TIMEOUT_MS,
  codexHome = join(homedir(), ".codex"),
  // The current local collector is SQLite. This historical benchmark accepts
  // an explicitly supplied JSONL supplemental source when requested, but it
  // must not silently depend on the retired managed ledger path.
  collectorPath = null,
  claudeStateDirectory = defaultClaudeStatusStateDirectory(),
  claudeProjectsDirectory = defaultClaudeProjectsDirectory(),
  afterSourcePlanFreeze = async () => {},
} = {}) {
  const interval = normalizeInterval(startAt, endAt);
  const runtimes = normalizeRuntimeExecutables(runtimeExecutables);
  normalizeTimeout(timeoutMs);
  if (typeof temporaryRoot !== "string" || !isAbsolute(temporaryRoot)
      || typeof codexHome !== "string" || !isAbsolute(codexHome)
      || (collectorPath !== null
        && (typeof collectorPath !== "string" || !isAbsolute(collectorPath)))
      || typeof claudeStateDirectory !== "string" || !isAbsolute(claudeStateDirectory)
      || typeof claudeProjectsDirectory !== "string" || !isAbsolute(claudeProjectsDirectory)
      || typeof afterSourcePlanFreeze !== "function") {
    throw new TypeError("R7 real-history paths and freeze hook are invalid");
  }

  const secret = randomBytes(32);
  const secretHex = secret.toString("hex");
  let root = null;
  let rootIdentity = null;
  let evidence;
  try {
    const planningGuard = createExportResourceGuard({ scope: "export_set" });
    const sourcePlanBundle = await createExportSourcePlanBundle({
      ...interval,
      codexHome,
      collectorPath,
      claudeStateDirectory,
      claudeProjectsDirectory,
      secret,
      resourceGuard: planningGuard,
    });
    const sourcePlanSummary = assertR7RealHistorySourcePlanEligibility(
      summarizeExportSourcePlanBundle(sourcePlanBundle),
    );
    await afterSourcePlanFreeze();

    const rawRoot = await mkdtemp(join(temporaryRoot, "usage-monitor-r7-real-history-"));
    await chmod(rawRoot, 0o700);
    root = await realpath(rawRoot);
    const rootStats = await lstat(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error("R7 real-history task root was unsafe");
    }
    rootIdentity = { dev: rootStats.dev, ino: rootStats.ino };

    const runtimeEvidence = [];
    for (const [runtimeIndex, runtimeExecutable] of runtimes.entries()) {
      const provenance = await queryChildRuntime(runtimeExecutable);
      const runtimeRoot = join(root, `runtime-${runtimeIndex + 1}`);
      await mkdir(runtimeRoot, { mode: 0o700 });
      const first = await runLifecyclePass(
        join(runtimeRoot, "pass-1"),
        sourcePlanBundle,
        secretHex,
        interval,
        { runtimeExecutable, timeoutMs },
      );
      const second = await runLifecyclePass(
        join(runtimeRoot, "pass-2"),
        sourcePlanBundle,
        secretHex,
        interval,
        { runtimeExecutable, timeoutMs },
      );
      runtimeEvidence.push({
        provenance,
        passes: [first, second],
        determinism: comparePasses(first, second, sourcePlanBundle.sourcePlanBundleSha256),
      });
    }

    // Re-open and rehash every frozen prefix after all lifecycle passes. Appends
    // outside a frozen prefix remain valid; replacements or prefix mutations do not.
    await resolveExportSourcePlanBundle(sourcePlanBundle, {
      startAt: interval.startAt,
      endAt: interval.endAt,
      secret,
      resourceGuard: createExportResourceGuard({ scope: "export_set" }),
    });

    evidence = {
      version: R7_REAL_HISTORY_BENCHMARK_VERSION,
      coveredDurationMs: interval.coveredDurationMs,
      sourcePlanSummary,
      prefixMutationResult: "passed",
      runtimeEvidence,
      networkActivity: "not_measured",
      rawDurableCopyCreated: false,
    };
    assertContentFree(evidence, secretHex);
  } finally {
    secret.fill(0);
    if (root !== null && rootIdentity !== null) {
      const inventory = await inventoryR7OwnedTree(root);
      await cleanupR7OwnedTree(root, inventory, rootIdentity);
    }
  }
  assertContentFree(evidence, secretHex);
  return evidence;
}

function maximum(first, second, field) {
  return Math.max(first[field], second[field]);
}

function releaseOperation(name, first, second) {
  if (!first || !second) {
    return {
      name,
      status: "not_run",
      failureCode: "not_run_profile",
      projectionSha256: "not_run",
      metrics: structuredClone(ZERO_OPERATION_METRICS),
    };
  }
  if (first.projectionSha256 !== second.projectionSha256) {
    throw new Error("R7 real-history operation projections differed");
  }
  return {
    name,
    status: "completed",
    failureCode: "none",
    projectionSha256: first.projectionSha256,
    metrics: {
      runCount: 2,
      parentElapsedMs: maximum(first, second, "parentElapsedMs"),
      childCpuMs: maximum(first, second, "childCpuMs"),
      externalRssSampleCount:
        first.externalRssSampleCount + second.externalRssSampleCount,
      externalRssSampleFailureCount:
        first.externalRssSampleFailureCount + second.externalRssSampleFailureCount,
      externalPeakRssBytes: maximum(first, second, "externalPeakRssBytes"),
      childMaxRssBytes: maximum(first, second, "childMaxRssBytes"),
      durablePeakRssBytes: maximum(first, second, "durablePeakRssBytes"),
      stdoutBytes: maximum(first, second, "stdoutBytes"),
      stderrBytes: maximum(first, second, "stderrBytes"),
      sourceFiles: maximum(first, second, "sourceFiles"),
      sourceBytes: maximum(first, second, "sourceBytes"),
      outputRecords: maximum(first, second, "outputRecords"),
      decodedBytes: maximum(first, second, "decodedBytes"),
      encodedBytes: maximum(first, second, "encodedBytes"),
      filesystem: {
        beforeBytes: maximum(first.filesystem, second.filesystem, "beforeBytes"),
        sampledHighWaterBytes: maximum(first.filesystem, second.filesystem, "sampledHighWaterBytes"),
        afterBytes: maximum(first.filesystem, second.filesystem, "afterBytes"),
      },
    },
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
    plusOne: {
      value: selectedLimit + 1,
      status: "not_run",
      failureCode: "not_run_profile",
    },
    producer: { status: "not_run", failureCode: "not_run_profile" },
    verifier: { status: "not_run", failureCode: "not_run_profile" },
    identification: "not_run",
  };
}

function runtimeProvenance(provenance) {
  return {
    platform: "macos",
    architecture: "arm64",
    hardwareClass: "apple_silicon",
    ramBucket: ramBucket(),
    runtimeFamily: "node",
    runtimeClass: provenance.runtimeClass,
    runtimeVersion: provenance.runtimeVersion,
    elapsedClock: "parent_monotonic",
    rssSampler: "parent_external_macos",
    rssSamplingIntervalMs: 100,
    stdoutLimitBytes: 262_144,
    stderrLimitBytes: 262_144,
    environmentClass: "fixed_locale_timezone_only",
  };
}

/** Build one independently valid, content-free receipt for each child runtime. */
export function buildR7RealHistoryReceipts(evidence) {
  if (!evidence || evidence.version !== R7_REAL_HISTORY_BENCHMARK_VERSION
      || !Array.isArray(evidence.runtimeEvidence) || evidence.runtimeEvidence.length < 1) {
    throw new TypeError("R7 real-history evidence is invalid");
  }
  const receipts = evidence.runtimeEvidence.map((runtime) => {
    const first = new Map(runtime.passes[0].operations.map((row) => [row.name, row]));
    const second = new Map(runtime.passes[1].operations.map((row) => [row.name, row]));
    const receipt = {
      schemaVersion: R7_RELEASE_EVIDENCE_RECEIPT_VERSION,
      protocolVersion: R7_RELEASE_EVIDENCE_PROTOCOL_VERSION,
      policyVersion: R7_RELEASE_EVIDENCE_POLICY_VERSION,
      selectionRuleVersion: R7_RELEASE_EVIDENCE_SELECTION_RULE_VERSION,
      profile: "release_real_local_history",
      outcome: "partial",
      runtimeProvenance: runtimeProvenance(runtime.provenance),
      contractProvenance: {
        receiptSchemaSha256: R7_RELEASE_EVIDENCE_RECEIPT_SCHEMA_SHA256,
        schemaModuleSha256: R7_RELEASE_EVIDENCE_SCHEMA_MODULE_SHA256,
        resourcePolicySourceSha256: R7_RELEASE_EVIDENCE_RESOURCE_POLICY_SOURCE_SHA256,
        resourcePolicyValuesSha256: R7_RELEASE_EVIDENCE_RESOURCE_POLICY_VALUES_SHA256,
        workloadCodeSha256: R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_SHA256,
        workloadCodeFileCount: R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_FILE_COUNT,
      },
      operations: R7_RELEASE_EVIDENCE_OPERATION_NAMES.map((name) => (
        releaseOperation(name, first.get(name), second.get(name))
      )),
      boundaries: R7_RELEASE_EVIDENCE_DIMENSIONS.map(notRunBoundary),
      determinism: {
        projectionVersion: R7_RELEASE_EVIDENCE_DETERMINISTIC_PROJECTION_VERSION,
        status: runtime.determinism.status,
        runCount: 2,
        runProjectionSha256es: runtime.determinism.runProjectionSha256es,
        comparisons: runtime.determinism.comparisons,
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
      network: {
        activity: "not_measured",
        transportReady: false,
        externalParticipants: false,
      },
      profileEvidence: {
        kind: "release_real_local_history",
        coveredDurationMs: evidence.coveredDurationMs,
        frozenPlanPasses: 2,
        rawDurableCopyCreated: false,
        prefixMutationResult: evidence.prefixMutationResult,
        codex: evidence.sourcePlanSummary.codex,
        claude: evidence.sourcePlanSummary.claude,
      },
      receiptSha256: "0".repeat(64),
    };
    if (receipt.operations.filter((row) => row.status === "completed").length
          !== EXECUTED_OPERATIONS.length
        || receipt.boundaries.some((row) => row.identification !== "not_run")) {
      throw new Error("R7 real-history receipt coverage was not canonical");
    }
    assertContentFree(receipt);
    receipt.receiptSha256 = computeR7ReleaseEvidenceReceiptSha256(receipt);
    return assertValidR7ReleaseEvidenceReceipt(receipt);
  });
  assertContentFree(receipts);
  return receipts;
}

export async function runR7RealHistoryBenchmark(options) {
  return buildR7RealHistoryReceipts(await runR7RealHistoryEvidence(options));
}
