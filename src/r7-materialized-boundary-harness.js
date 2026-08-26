import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLocalMetadataBundle } from "./metadata-exporter.js";
import { createLocalExportWorkspace } from "./export-set-controller.js";
import { materializeLocalExportSet } from "./export-set-materializer.js";
import { verifyLocalExportSet } from "./export-set-verifier.js";
import {
  compressExportBytes,
  decompressExportBytes,
  ExportCompressionError,
} from "./export-compression.js";
import {
  createExportResourceGuard,
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  EXPORT_RESOURCE_POLICY_VERSION,
  ExportResourceLimitError,
} from "./export-resource-policy.js";
import {
  createR7StructuralFixture,
  inspectR7StructuralFixture,
  R7_FIXTURE_CREATED_AT,
  R7_FIXTURE_END_AT,
  R7_FIXTURE_SECRET,
  R7_FIXTURE_START_AT,
} from "./r7-resource-benchmark-fixture.js";
import {
  R7_RESOURCE_BENCHMARK_BOUNDARY_DIMENSIONS,
  R7_RESOURCE_BENCHMARK_FAILURE_CODE_BY_DIMENSION,
  R7_RESOURCE_BENCHMARK_LIMIT_KEY_BY_DIMENSION,
  R7_RESOURCE_BENCHMARK_UNIT_BY_DIMENSION,
} from "./r7-resource-benchmark-schema.js";
import { cleanupR7OwnedTree, inventoryR7OwnedTree } from "./r7-resource-benchmark.js";

export const R7_MATERIALIZED_BOUNDARY_HARNESS_VERSION =
  "g1-r7-materialized-boundary-integration-v0.3";

const FIXED_BUNDLE_ID = `bundle:v1:${"6".repeat(64)}`;
const EXECUTED_STATUSES = new Set(["passed", "rejected"]);
const MATERIAL_LINE_BYTES = 64 * 1024;
const MATERIAL_PAYLOAD_BYTES = 8 * 1024 * 1024;

function fixedFailureCode(error) {
  if (error instanceof ExportResourceLimitError) return error.code;
  if (error instanceof ExportCompressionError) return error.code;
  return "benchmark_operation_failed";
}

async function execute(callback) {
  try {
    await callback();
    return { status: "passed", failureCode: "none" };
  } catch (error) {
    return { status: "rejected", failureCode: fixedFailureCode(error) };
  }
}

function unexecutedTrial(status, mode) {
  return {
    mode,
    configuredLimit: null,
    observedValue: null,
    status,
    failureCode: status === "not_run" ? "not_run_profile" : "none",
  };
}

function unexecutedSurface(status) {
  return {
    pathway: status,
    status,
    atLimit: unexecutedTrial(status, "at_limit"),
    plusOne: unexecutedTrial(status, "limit_plus_one"),
  };
}

async function measuredSurface({ dimension, pathway, observedValue, atLimit, plusOne }) {
  if (!Number.isSafeInteger(observedValue) || observedValue < 2) {
    throw new TypeError("A materialized boundary observation must be a safe integer of at least two");
  }
  const expectedCode = R7_RESOURCE_BENCHMARK_FAILURE_CODE_BY_DIMENSION[dimension];
  const at = await execute(atLimit);
  const above = await execute(plusOne);
  const status = at.status === "passed" && at.failureCode === "none"
    && above.status === "rejected" && above.failureCode === expectedCode
    ? "enforced"
    : "not_enforced";
  return {
    pathway,
    status,
    atLimit: {
      mode: "at_limit",
      configuredLimit: observedValue,
      observedValue,
      ...at,
    },
    plusOne: {
      mode: "limit_plus_one",
      configuredLimit: observedValue - 1,
      observedValue,
      ...above,
    },
  };
}

async function runtimeSurface({ dimension, pathway, configuredLimit, atLimit, plusOne }) {
  const expectedCode = R7_RESOURCE_BENCHMARK_FAILURE_CODE_BY_DIMENSION[dimension];
  const at = await execute(atLimit);
  const above = await execute(plusOne);
  const status = at.status === "passed" && at.failureCode === "none"
    && above.status === "rejected" && above.failureCode === expectedCode
    ? "enforced"
    : "not_enforced";
  return {
    pathway,
    status,
    atLimit: {
      mode: "at_limit",
      configuredLimit,
      observedValue: configuredLimit,
      ...at,
    },
    plusOne: {
      mode: "limit_plus_one",
      configuredLimit,
      observedValue: configuredLimit + 1,
      ...above,
    },
  };
}

function clockAt(value) {
  let first = true;
  return () => {
    if (first) {
      first = false;
      return 0;
    }
    return value;
  };
}

function totalRecords(recordCounts) {
  return Object.values(recordCounts).reduce((sum, count) => sum + count, 0);
}

function workspaceOptions(fixture, directory, resourceLimits = {}) {
  return {
    directory,
    startAt: R7_FIXTURE_START_AT,
    endAt: R7_FIXTURE_END_AT,
    createdAt: R7_FIXTURE_CREATED_AT,
    secret: R7_FIXTURE_SECRET,
    resourceLimits,
    ...fixture.paths,
  };
}

function fixedRuntimeGuard(options = {}) {
  return createExportResourceGuard({ clock: () => 0, rss: () => 1, ...options });
}

function seededBytes(length) {
  const bytes = Buffer.allocUnsafe(length);
  let state = 0x6d2b79f5;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

function exactAccountingLine(byteLength) {
  const prefix = Buffer.from(
    `{"timestamp":"${R7_FIXTURE_START_AT}","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0,"total_tokens":1},"last_token_usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0,"total_tokens":1}},"rate_limits":null},"padding":"`,
    "utf8",
  );
  const suffix = Buffer.from('"}', "utf8");
  const paddingBytes = byteLength - prefix.length - suffix.length;
  if (paddingBytes < 0) throw new TypeError("R7 material line length was too small");
  return Buffer.concat([prefix, Buffer.alloc(paddingBytes, 0x41), suffix], byteLength);
}

async function createLineHome(root, label, byteLength) {
  const home = join(root, label);
  const threadId = "70000000-0000-4000-8000-000000000098";
  await mkdir(join(home, "sessions"), { recursive: true, mode: 0o700 });
  await mkdir(join(home, "archived_sessions"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(home, "sessions", `rollout-2026-07-24T11-00-00-${threadId}.jsonl`),
    Buffer.concat([
      Buffer.from(`${JSON.stringify({
        timestamp: R7_FIXTURE_START_AT,
        type: "session_meta",
        payload: { id: threadId },
      })}\n`),
      exactAccountingLine(byteLength),
      Buffer.from("\n"),
    ]),
    { mode: 0o600 },
  );
  return home;
}

async function materialLongLineCase(root) {
  const atHome = await createLineHome(root, "material-line-at", MATERIAL_LINE_BYTES);
  const plusHome = await createLineHome(root, "material-line-plus", MATERIAL_LINE_BYTES + 1);
  const run = (codexHome) => buildLocalMetadataBundle({
    startAt: R7_FIXTURE_START_AT,
    endAt: R7_FIXTURE_END_AT,
    createdAt: R7_FIXTURE_CREATED_AT,
    codexHome,
    secret: R7_FIXTURE_SECRET,
    bundleId: FIXED_BUNDLE_ID,
    resourceLimits: { maximumLineBytes: MATERIAL_LINE_BYTES },
    resourceClock: () => 0,
    resourceRss: () => 1,
  });
  const atLimit = await execute(() => run(atHome));
  const plusOne = await execute(() => run(plusHome));
  return {
    lineBytes: MATERIAL_LINE_BYTES,
    linePlusOneBytes: MATERIAL_LINE_BYTES + 1,
    configuredLimit: MATERIAL_LINE_BYTES,
    atLimit,
    plusOne,
    producerPathway: "metadata_bundle_producer",
  };
}

async function materialArtifactCase({ root, label, payload, plusOnePayload }) {
  await mkdir(root, { mode: 0o700 });
  const maximumEncodedBytes = DEFAULT_EXPORT_RESOURCE_LIMITS.maximumEncodedArtifactBytes;
  const artifact = compressExportBytes(payload, {
    maximumDecodedBytes: MATERIAL_PAYLOAD_BYTES,
    maximumEncodedBytes,
  });
  const plusOneArtifact = compressExportBytes(plusOnePayload, {
    maximumDecodedBytes: MATERIAL_PAYLOAD_BYTES + 1,
    maximumEncodedBytes,
  });
  const artifactPath = join(root, `${label}.bundle.json.gz`);
  await writeFile(artifactPath, artifact, { mode: 0o600 });
  const stats = await lstat(artifactPath);
  const stored = await readFile(artifactPath);
  const decoded = decompressExportBytes(stored, {
    maximumEncodedBytes: stats.size,
    maximumDecodedBytes: MATERIAL_PAYLOAD_BYTES,
  });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
      || stats.size !== artifact.length || !decoded.equals(payload)) {
    throw new Error("R7 material artifact file control failed");
  }
  const producerDecodedPlusOne = await execute(() => compressExportBytes(plusOnePayload, {
    maximumDecodedBytes: MATERIAL_PAYLOAD_BYTES,
    maximumEncodedBytes,
  }));
  const producerEncodedPlusOne = await execute(() => compressExportBytes(payload, {
    maximumDecodedBytes: MATERIAL_PAYLOAD_BYTES,
    maximumEncodedBytes: artifact.length - 1,
  }));
  const verifierDecodedPlusOne = await execute(() => decompressExportBytes(plusOneArtifact, {
    maximumEncodedBytes: plusOneArtifact.length,
    maximumDecodedBytes: MATERIAL_PAYLOAD_BYTES,
  }));
  const verifierEncodedPlusOne = await execute(() => decompressExportBytes(artifact, {
    maximumEncodedBytes: artifact.length - 1,
    maximumDecodedBytes: MATERIAL_PAYLOAD_BYTES,
  }));
  return {
    decodedBytes: payload.length,
    decodedPlusOneBytes: plusOnePayload.length,
    encodedBytes: artifact.length,
    encodedPlusOneArtifactBytes: plusOneArtifact.length,
    producerStatus: "passed",
    verifierStatus: "passed",
    producerDecodedPlusOne,
    producerEncodedPlusOne,
    verifierDecodedPlusOne,
    verifierEncodedPlusOne,
    fileControlStatus: "passed",
  };
}

async function materialWorkspaceFileCase(root) {
  await mkdir(root, { mode: 0o700 });
  const atPath = join(root, "workspace-file-at.bin");
  const plusPath = join(root, "workspace-file-plus.bin");
  await writeFile(atPath, Buffer.alloc(MATERIAL_PAYLOAD_BYTES), { mode: 0o600 });
  await writeFile(plusPath, Buffer.alloc(MATERIAL_PAYLOAD_BYTES + 1), { mode: 0o600 });
  const atStats = await lstat(atPath);
  const plusStats = await lstat(plusPath);
  const atLimit = await execute(() => fixedRuntimeGuard({
    limits: { maximumWorkspaceBytes: MATERIAL_PAYLOAD_BYTES },
    scope: "export_set",
  }).observeWorkspace(atStats.size));
  const plusOne = await execute(() => fixedRuntimeGuard({
    limits: { maximumWorkspaceBytes: MATERIAL_PAYLOAD_BYTES },
    scope: "export_set",
  }).observeWorkspace(plusStats.size));
  return {
    bytes: atStats.size,
    plusOneBytes: plusStats.size,
    configuredLimit: MATERIAL_PAYLOAD_BYTES,
    atLimit,
    plusOne,
    pathway: "resource_guard_from_file_stats",
  };
}

async function literalCandidateTrial(dimension, { sqliteBatch = null } = {}) {
  const selectedLimit = DEFAULT_EXPORT_RESOURCE_LIMITS[
    R7_RESOURCE_BENCHMARK_LIMIT_KEY_BY_DIMENSION[dimension]
  ];
  if (dimension === "sqlite_batch_records") {
    if (!sqliteBatch
        || sqliteBatch.batchLimitRecords !== selectedLimit
        || sqliteBatch.recordsIndexed !== selectedLimit + 1
        || sqliteBatch.nonEmptyBatchCount !== 2
        || sqliteBatch.fullBatchCount !== 1
        || sqliteBatch.maximumBatchRecords !== selectedLimit
        || sqliteBatch.finalBatchRecords !== 1) {
      throw new Error("R7 SQLite rollover evidence did not match the selected batching policy");
    }
    return {
      dimension,
      unit: R7_RESOURCE_BENCHMARK_UNIT_BY_DIMENSION[dimension],
      selectedLimit,
      mode: "materialized_batch_rollover",
      receiptMode: "materialized",
      pathway: "export_set_verifier_sqlite_index",
      atLimit: {
        mode: "at_limit",
        configuredLimit: selectedLimit,
        observedValue: selectedLimit,
        status: "passed",
        failureCode: "none",
      },
      plusOne: {
        mode: "limit_plus_one",
        configuredLimit: selectedLimit,
        observedValue: selectedLimit + 1,
        status: "passed",
        failureCode: "none",
      },
      identification: "not_identified",
      reason: "operational_batch_rollover_not_rejection_ceiling",
    };
  }
  const scope = dimension.includes("export_set") || dimension === "workspace_bytes"
    ? "export_set"
    : "single_bundle";
  function run(value) {
    if (dimension === "elapsed_time") {
      return createExportResourceGuard({ scope, clock: clockAt(value), rss: () => 1 }).checkRuntime();
    }
    if (dimension === "rss") {
      return createExportResourceGuard({ scope, clock: () => 0, rss: () => value }).checkRuntime();
    }
    const guard = fixedRuntimeGuard({ scope });
    if (dimension === "covered_duration") guard.assertCoveredInterval(0, value);
    else if (dimension === "directory_entries") {
      for (let count = 0; count < value; count += 1) guard.observeDirectoryEntry();
    } else if (dimension === "source_files") guard.observeSourcePlan(value, 0);
    else if (dimension === "source_bytes") guard.observeSourcePlan(0, value);
    else if (dimension === "line_bytes") guard.observeLine(value);
    else if (dimension === "output_records_single_bundle"
        || dimension === "output_records_export_set") guard.observeOutputTotals(value, 0);
    else if (dimension === "expanded_record_bytes_single_bundle"
        || dimension === "expanded_record_bytes_export_set") guard.observeOutputTotals(0, value);
    else if (dimension === "canonical_bundle_bytes") guard.observeCanonicalBundle(value);
    else if (dimension === "encoded_artifact_bytes") guard.observeEncodedArtifact(value);
    else if (dimension === "export_set_decoded_bytes") guard.observeExportSetBytes(value, 0);
    else if (dimension === "export_set_encoded_bytes") guard.observeExportSetBytes(0, value);
    else if (dimension === "workspace_bytes") guard.observeWorkspace(value);
    else if (dimension === "manifest_bytes") guard.observeManifest(value);
    else if (dimension === "chunk_count") guard.observeChunkCount(value);
    else throw new Error("Unsupported R7 literal candidate dimension");
  }
  const atLimit = await execute(() => run(selectedLimit));
  const plusOne = await execute(() => run(selectedLimit + 1));
  return {
    dimension,
    unit: R7_RESOURCE_BENCHMARK_UNIT_BY_DIMENSION[dimension],
    selectedLimit,
    mode: "synthetic_boundary_only",
    receiptMode: "synthetic_counter",
    pathway: "export_resource_guard_counter",
    atLimit: {
      mode: "at_limit",
      configuredLimit: selectedLimit,
      observedValue: selectedLimit,
      ...atLimit,
    },
    plusOne: {
      mode: "limit_plus_one",
      configuredLimit: selectedLimit,
      observedValue: selectedLimit + 1,
      ...plusOne,
    },
    identification: "not_identified",
    reason: "counter_only_not_integrated",
  };
}

function sqliteUsage(totalInputTokens) {
  return {
    input_tokens: totalInputTokens,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: totalInputTokens,
  };
}

async function materializedSqliteBatchCase(root) {
  const selectedLimit = DEFAULT_EXPORT_RESOURCE_LIMITS.maximumSqliteBatchRecords;
  const recordCount = selectedLimit + 1;
  const home = join(root, "sqlite-home");
  const workspaceDirectory = join(root, "sqlite-workspace");
  const outputDirectory = join(root, "sqlite-output");
  await mkdir(join(home, "sessions"), { recursive: true, mode: 0o700 });
  await mkdir(join(home, "archived_sessions"), { recursive: true, mode: 0o700 });
  const startMs = Date.parse(R7_FIXTURE_START_AT);
  const lines = [
    JSON.stringify({
      timestamp: R7_FIXTURE_START_AT,
      type: "session_meta",
      payload: { id: "R7_SQLITE_BATCH_STRUCTURAL_FIXTURE" },
    }),
    JSON.stringify({
      timestamp: R7_FIXTURE_START_AT,
      type: "turn_context",
      payload: { model: "gpt-5.6-sol" },
    }),
  ];
  for (let index = 0; index < recordCount; index += 1) {
    lines.push(JSON.stringify({
      timestamp: new Date(startMs + index + 1).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: sqliteUsage(index + 1),
          last_token_usage: sqliteUsage(1),
        },
        rate_limits: null,
      },
    }));
  }
  await writeFile(
    join(home, "sessions", "rollout-2026-07-24T12-00-00-sqlite.jsonl"),
    `${lines.join("\n")}\n`,
    { mode: 0o600 },
  );
  await createLocalExportWorkspace({
    directory: workspaceDirectory,
    startAt: R7_FIXTURE_START_AT,
    endAt: R7_FIXTURE_END_AT,
    createdAt: R7_FIXTURE_CREATED_AT,
    codexHome: home,
    secret: R7_FIXTURE_SECRET,
    resourceClock: () => 0,
    resourceRss: () => 1,
  });
  const materialized = await materializeLocalExportSet({
    workspaceDirectory,
    outputDirectory,
    secret: R7_FIXTURE_SECRET,
    maximumRecordsPerChunk: selectedLimit,
  });
  if (totalRecords(materialized.manifest.totals.recordCounts) !== recordCount) {
    throw new Error("R7 SQLite structural fixture did not produce the prescribed record count");
  }
  const verified = await verifyLocalExportSet({
    directory: outputDirectory,
    verificationTemporaryRoot: root,
  });
  return {
    ...verified.verificationIndex,
    pathway: "export_set_verifier_sqlite_index",
    atBatchLimitStatus: "passed",
    plusOneRolloverStatus: "passed",
  };
}

/**
 * Execute actual local producer and verifier pathways using only a synthetic
 * structural fixture. The returned projection is deliberately aggregate-only:
 * no paths, record identifiers, source text, artifact bytes, or error messages
 * are included.
 */
export async function runR7MaterializedBoundaryHarness({
  temporaryRoot = tmpdir(),
  fixturePaths = null,
} = {}) {
  const rawRoot = await mkdtemp(join(temporaryRoot, "usage-monitor-r7-boundaries-"));
  await chmod(rawRoot, 0o700);
  const root = await realpath(rawRoot);
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("R7 materialized boundary root was unsafe");
  }
  const rootIdentity = { dev: rootStats.dev, ino: rootStats.ino };
  let sequence = 0;
  const nextPath = (label) => join(root, `${String(sequence += 1).padStart(3, "0")}-${label}`);
  try {
    const fixture = fixturePaths === null
      ? await createR7StructuralFixture(root)
      : { paths: fixturePaths, evidence: await inspectR7StructuralFixture(fixturePaths) };
    // A second metadata-only frozen rollout makes the source-file boundary
    // observable at a positive small limit without introducing event content.
    if (fixturePaths === null) {
      await writeFile(
        join(
          fixture.paths.codexHome,
          "archived_sessions",
          "rollout-2026-07-24T11-00-00-70000000-0000-4000-8000-000000000099.jsonl",
        ),
        `${JSON.stringify({
          timestamp: R7_FIXTURE_START_AT,
          type: "session_meta",
          payload: { id: "70000000-0000-4000-8000-000000000099" },
        })}\n`,
        { mode: 0o600 },
      );
    }

    const metadataOptions = {
      startAt: R7_FIXTURE_START_AT,
      endAt: R7_FIXTURE_END_AT,
      createdAt: R7_FIXTURE_CREATED_AT,
      codexHome: fixture.paths.codexHome,
      secret: R7_FIXTURE_SECRET,
      bundleId: FIXED_BUNDLE_ID,
      resourceClock: () => 0,
      resourceRss: () => 1,
    };
    const metadataBaseline = await buildLocalMetadataBundle(metadataOptions);
    const metadataCounters = metadataBaseline.resourceUsage.counters;
    const sourceBytes = await readFile(join(
      fixture.paths.codexHome,
      "sessions",
      "rollout-2026-07-24T12-00-00-r7.jsonl",
    ));
    const relevantLineBytes = sourceBytes.toString("utf8").trimEnd().split("\n")
      .filter((line) => line.includes('"type":"token_count"'))
      .map((line) => Buffer.byteLength(line));
    const maximumRelevantLineBytes = Math.max(...relevantLineBytes);

    const baselineWorkspace = nextPath("baseline-workspace");
    const baselineOutput = nextPath("baseline-output");
    const workspaceBaseline = await createLocalExportWorkspace(
      workspaceOptions(fixture, baselineWorkspace),
    );
    const materializedBaseline = await materializeLocalExportSet({
      workspaceDirectory: baselineWorkspace,
      outputDirectory: baselineOutput,
      secret: R7_FIXTURE_SECRET,
      maximumRecordsPerChunk: 3,
    });
    await verifyLocalExportSet({ directory: baselineOutput, verificationTemporaryRoot: root });

    const manifest = materializedBaseline.manifest;
    const maximumBundleBytes = Math.max(...manifest.chunks.map((chunk) => chunk.bundleBytes));
    const maximumArtifactBytes = Math.max(...manifest.chunks.map((chunk) => chunk.artifactBytes));
    const outputEntries = 2 + (manifest.chunks.length * 2);
    const exportSetRecords = totalRecords(manifest.totals.recordCounts);

    const emptyHome = nextPath("empty-home");
    await mkdir(join(emptyHome, "sessions"), { recursive: true, mode: 0o700 });
    await mkdir(join(emptyHome, "archived_sessions"), { recursive: true, mode: 0o700 });
    const emptyWorkspaceOptions = (directory, resourceLimits = {}) => ({
      directory,
      startAt: R7_FIXTURE_START_AT,
      endAt: R7_FIXTURE_END_AT,
      createdAt: R7_FIXTURE_CREATED_AT,
      codexHome: emptyHome,
      secret: R7_FIXTURE_SECRET,
      resourceLimits,
    });
    const emptyBaselineWorkspace = nextPath("empty-baseline-workspace");
    const emptyBaselineOutput = nextPath("empty-baseline-output");
    await createLocalExportWorkspace(emptyWorkspaceOptions(emptyBaselineWorkspace));
    const emptyBaseline = await materializeLocalExportSet({
      workspaceDirectory: emptyBaselineWorkspace,
      outputDirectory: emptyBaselineOutput,
      secret: R7_FIXTURE_SECRET,
    });

    async function runMetadata(limitKey, limitValue, extra = {}) {
      return buildLocalMetadataBundle({
        ...metadataOptions,
        resourceLimits: { [limitKey]: limitValue },
        ...extra,
      });
    }

    async function runWorkspace(limitKey, limitValue) {
      return createLocalExportWorkspace(workspaceOptions(
        fixture,
        nextPath(`workspace-${limitKey}`),
        { [limitKey]: limitValue },
      ));
    }

    async function runEmptyMaterializer(limitKey, limitValue, materializerOption = {}) {
      const workspaceDirectory = nextPath(`empty-workspace-${limitKey}`);
      await createLocalExportWorkspace(emptyWorkspaceOptions(
        workspaceDirectory,
        { [limitKey]: limitValue },
      ));
      return materializeLocalExportSet({
        workspaceDirectory,
        outputDirectory: nextPath(`empty-output-${limitKey}`),
        secret: R7_FIXTURE_SECRET,
        ...materializerOption,
      });
    }

    async function runChunkMaterializer(limitValue) {
      const workspaceDirectory = nextPath("chunk-workspace");
      await createLocalExportWorkspace(workspaceOptions(
        fixture,
        workspaceDirectory,
        { maximumChunks: limitValue },
      ));
      return materializeLocalExportSet({
        workspaceDirectory,
        outputDirectory: nextPath("chunk-output"),
        secret: R7_FIXTURE_SECRET,
        maximumRecordsPerChunk: 3,
      });
    }

    async function runVerifier(limitKey, limitValue, extra = {}) {
      return verifyLocalExportSet({
        directory: baselineOutput,
        resourceLimits: { [limitKey]: limitValue },
        verificationTemporaryRoot: root,
        ...extra,
      });
    }

    const producer = new Map();
    const verifier = new Map();
    const metadataMeasurements = new Map([
      ["covered_duration", Date.parse(R7_FIXTURE_END_AT) - Date.parse(R7_FIXTURE_START_AT)],
      ["directory_entries", metadataCounters.directoryEntries],
      ["source_files", metadataCounters.sourceFiles],
      ["source_bytes", metadataCounters.sourceBytes],
      ["line_bytes", maximumRelevantLineBytes],
      ["output_records_single_bundle", metadataCounters.outputRecords],
      ["expanded_record_bytes_single_bundle", metadataCounters.expandedRecordBytes],
      ["canonical_bundle_bytes", metadataCounters.canonicalBundleBytes],
    ]);
    for (const [dimension, observedValue] of metadataMeasurements) {
      const limitKey = R7_RESOURCE_BENCHMARK_LIMIT_KEY_BY_DIMENSION[dimension];
      producer.set(dimension, await measuredSurface({
        dimension,
        pathway: "metadata_bundle_producer",
        observedValue,
        atLimit: () => runMetadata(limitKey, observedValue),
        plusOne: () => runMetadata(limitKey, observedValue - 1),
      }));
    }

    const workspaceMeasurements = new Map([
      ["output_records_export_set", exportSetRecords],
      ["expanded_record_bytes_export_set", workspaceBaseline.status.expandedRecordBytes],
    ]);
    for (const [dimension, observedValue] of workspaceMeasurements) {
      const limitKey = R7_RESOURCE_BENCHMARK_LIMIT_KEY_BY_DIMENSION[dimension];
      producer.set(dimension, await measuredSurface({
        dimension,
        pathway: "export_workspace_producer",
        observedValue,
        atLimit: () => runWorkspace(limitKey, observedValue),
        plusOne: () => runWorkspace(limitKey, observedValue - 1),
      }));
    }

    const emptyMaterializerMeasurements = new Map([
      ["export_set_decoded_bytes", emptyBaseline.manifest.totals.decodedBundleBytes],
      ["export_set_encoded_bytes", emptyBaseline.manifest.totals.encodedArtifactBytes],
      ["manifest_bytes", emptyBaseline.manifestReceipt.manifestBytes],
    ]);
    for (const [dimension, observedValue] of emptyMaterializerMeasurements) {
      const limitKey = R7_RESOURCE_BENCHMARK_LIMIT_KEY_BY_DIMENSION[dimension];
      producer.set(dimension, await measuredSurface({
        dimension,
        pathway: "export_set_materializer",
        observedValue,
        atLimit: () => runEmptyMaterializer(limitKey, observedValue),
        plusOne: () => runEmptyMaterializer(limitKey, observedValue - 1),
      }));
    }
    producer.set("chunk_count", await measuredSurface({
      dimension: "chunk_count",
      pathway: "export_set_materializer",
      observedValue: manifest.chunks.length,
      atLimit: () => runChunkMaterializer(manifest.chunks.length),
      plusOne: () => runChunkMaterializer(manifest.chunks.length - 1),
    }));
    producer.set("elapsed_time", await runtimeSurface({
      dimension: "elapsed_time",
      pathway: "metadata_bundle_producer",
      configuredLimit: 1,
      atLimit: () => buildLocalMetadataBundle({
        ...metadataOptions,
        resourceLimits: { maximumElapsedMs: 1 },
        resourceClock: clockAt(1),
      }),
      plusOne: () => buildLocalMetadataBundle({
        ...metadataOptions,
        resourceLimits: { maximumElapsedMs: 1 },
        resourceClock: clockAt(2),
      }),
    }));
    producer.set("rss", await runtimeSurface({
      dimension: "rss",
      pathway: "metadata_bundle_producer",
      configuredLimit: 1,
      atLimit: () => buildLocalMetadataBundle({
        ...metadataOptions,
        resourceLimits: { maximumRssBytes: 1 },
        resourceRss: () => 1,
      }),
      plusOne: () => buildLocalMetadataBundle({
        ...metadataOptions,
        resourceLimits: { maximumRssBytes: 1 },
        resourceRss: () => 2,
      }),
    }));

    const verifierMeasurements = new Map([
      ["covered_duration", Date.parse(R7_FIXTURE_END_AT) - Date.parse(R7_FIXTURE_START_AT)],
      ["directory_entries", outputEntries],
      ["source_files", manifest.sourcePlan.sourceFiles],
      ["source_bytes", manifest.sourcePlan.sourceBytes],
      ["output_records_export_set", exportSetRecords],
      ["expanded_record_bytes_export_set", workspaceBaseline.status.expandedRecordBytes],
      ["canonical_bundle_bytes", maximumBundleBytes],
      ["encoded_artifact_bytes", maximumArtifactBytes],
      ["export_set_decoded_bytes", manifest.totals.decodedBundleBytes],
      ["export_set_encoded_bytes", manifest.totals.encodedArtifactBytes],
      ["manifest_bytes", materializedBaseline.manifestReceipt.manifestBytes],
      ["chunk_count", manifest.chunks.length],
    ]);
    for (const [dimension, observedValue] of verifierMeasurements) {
      const limitKey = R7_RESOURCE_BENCHMARK_LIMIT_KEY_BY_DIMENSION[dimension];
      verifier.set(dimension, await measuredSurface({
        dimension,
        pathway: "export_set_verifier",
        observedValue,
        atLimit: () => runVerifier(limitKey, observedValue),
        plusOne: () => runVerifier(limitKey, observedValue - 1),
      }));
    }

    // The verifier's SQLite index is the only materialized workspace consumer.
    // Find its exact small fixture threshold through the public injected ceiling,
    // then independently execute value and value+1 evidence at that threshold.
    let lower = 1;
    let upper = DEFAULT_EXPORT_RESOURCE_LIMITS.maximumWorkspaceBytes;
    while (lower < upper) {
      const candidate = lower + Math.floor((upper - lower) / 2);
      const trial = await execute(() => runVerifier("maximumWorkspaceBytes", candidate, {
        maximumVerificationIndexBytes: candidate,
      }));
      if (trial.status === "passed") upper = candidate;
      else if (trial.failureCode === "export_resource_workspace_bytes") lower = candidate + 1;
      else throw new Error("Unexpected verifier workspace boundary result");
    }
    verifier.set("workspace_bytes", await measuredSurface({
      dimension: "workspace_bytes",
      pathway: "export_set_verifier",
      observedValue: lower,
      atLimit: () => runVerifier("maximumWorkspaceBytes", lower, {
        maximumVerificationIndexBytes: lower,
      }),
      plusOne: () => runVerifier("maximumWorkspaceBytes", lower - 1, {
        maximumVerificationIndexBytes: lower - 1,
      }),
    }));

    const materialCases = {
      longLine: await materialLongLineCase(nextPath("material-line-cases")),
      compressibleArtifact: await materialArtifactCase({
        root: nextPath("material-compressible-artifact"),
        label: "compressible",
        payload: Buffer.alloc(MATERIAL_PAYLOAD_BYTES, 0x41),
        plusOnePayload: Buffer.alloc(MATERIAL_PAYLOAD_BYTES + 1, 0x41),
      }),
      incompressibleArtifact: await materialArtifactCase({
        root: nextPath("material-incompressible-artifact"),
        label: "incompressible",
        payload: seededBytes(MATERIAL_PAYLOAD_BYTES),
        plusOnePayload: seededBytes(MATERIAL_PAYLOAD_BYTES + 1),
      }),
      workspaceFile: await materialWorkspaceFileCase(nextPath("material-workspace-file")),
    };
    const sqliteBatch = await materializedSqliteBatchCase(nextPath("material-sqlite-batch"));
    verifier.set("sqlite_batch_records", {
      pathway: sqliteBatch.pathway,
      status: "enforced",
      atLimit: {
        mode: "at_limit",
        configuredLimit: sqliteBatch.batchLimitRecords,
        observedValue: sqliteBatch.batchLimitRecords,
        status: sqliteBatch.atBatchLimitStatus,
        failureCode: "none",
      },
      plusOne: {
        mode: "limit_plus_one",
        configuredLimit: sqliteBatch.batchLimitRecords,
        observedValue: sqliteBatch.recordsIndexed,
        status: sqliteBatch.plusOneRolloverStatus,
        failureCode: "none",
      },
    });
    const expectedMaterialCodes = [
      [materialCases.longLine.plusOne, "export_resource_line_bytes"],
      [materialCases.compressibleArtifact.producerDecodedPlusOne, "export_compression_decoded_bytes"],
      [materialCases.compressibleArtifact.producerEncodedPlusOne, "export_compression_encoded_bytes"],
      [materialCases.compressibleArtifact.verifierDecodedPlusOne, "export_compression_decoded_bytes"],
      [materialCases.compressibleArtifact.verifierEncodedPlusOne, "export_compression_encoded_bytes"],
      [materialCases.incompressibleArtifact.producerDecodedPlusOne, "export_compression_decoded_bytes"],
      [materialCases.incompressibleArtifact.producerEncodedPlusOne, "export_compression_encoded_bytes"],
      [materialCases.incompressibleArtifact.verifierDecodedPlusOne, "export_compression_decoded_bytes"],
      [materialCases.incompressibleArtifact.verifierEncodedPlusOne, "export_compression_encoded_bytes"],
      [materialCases.workspaceFile.plusOne, "export_resource_workspace_bytes"],
    ];
    if (materialCases.longLine.atLimit.status !== "passed"
        || materialCases.workspaceFile.atLimit.status !== "passed"
        || expectedMaterialCodes.some(([trial, code]) => (
          trial.status !== "rejected" || trial.failureCode !== code
        ))) {
      throw new Error("R7 prescribed material boundary case failed");
    }

    const literalCandidateMatrix = [];
    for (const dimension of R7_RESOURCE_BENCHMARK_BOUNDARY_DIMENSIONS) {
      literalCandidateMatrix.push(await literalCandidateTrial(dimension, { sqliteBatch }));
    }
    const literalCandidateUnexpected = literalCandidateMatrix.filter((row) => {
      if (row.dimension === "sqlite_batch_records") {
        return row.atLimit.status !== "passed"
          || row.atLimit.failureCode !== "none"
          || row.plusOne.status !== "passed"
          || row.plusOne.failureCode !== "none";
      }
      if (row.identification === "not_run") return true;
      return row.atLimit.status !== "passed"
        || row.atLimit.failureCode !== "none"
        || row.plusOne.status !== "rejected"
        || row.plusOne.failureCode !== R7_RESOURCE_BENCHMARK_FAILURE_CODE_BY_DIMENSION[row.dimension];
    });

    const rows = R7_RESOURCE_BENCHMARK_BOUNDARY_DIMENSIONS.map((dimension) => {
      const producerEvidence = producer.get(dimension) ?? unexecutedSurface(
        dimension === "sqlite_batch_records" || dimension === "encoded_artifact_bytes"
          || dimension === "workspace_bytes" ? "not_run" : "not_applicable",
      );
      const verifierEvidence = verifier.get(dimension) ?? unexecutedSurface(
        dimension === "line_bytes" ? "not_applicable" : "not_run",
      );
      return {
        dimension,
        unit: R7_RESOURCE_BENCHMARK_UNIT_BY_DIMENSION[dimension],
        producer: { surface: "producer", ...producerEvidence },
        verifier: { surface: "verifier", ...verifierEvidence },
      };
    });
    const executedSurfaces = rows.flatMap((row) => [row.producer, row.verifier])
      .filter((surface) => EXECUTED_STATUSES.has(surface.atLimit.status));
    return {
      version: R7_MATERIALIZED_BOUNDARY_HARNESS_VERSION,
      resourcePolicyVersion: EXPORT_RESOURCE_POLICY_VERSION,
      classification: "synthetic_materialized_boundary_integration",
      fixtureManifestSha256: fixture.evidence.manifestSha256,
      contentIncluded: false,
      materialCases,
      sqliteBatch,
      literalCandidateMatrix,
      rows,
      summary: {
        dimensions: rows.length,
        enforcedProducerSurfaces: rows.filter((row) => row.producer.status === "enforced").length,
        enforcedVerifierSurfaces: rows.filter((row) => row.verifier.status === "enforced").length,
        executedSurfaces: executedSurfaces.length,
        unexpectedSurfaces: executedSurfaces.filter((surface) => surface.status !== "enforced").length,
        materialCases: 4,
        literalCandidateTrials: literalCandidateMatrix.filter(
          (row) => row.identification !== "not_run",
        ).length,
        literalCandidatesIdentified: 0,
        literalCandidateUnexpected: literalCandidateUnexpected.length,
        sqliteBatchStatus: "passed",
      },
    };
  } finally {
    const inventory = await inventoryR7OwnedTree(root);
    await cleanupR7OwnedTree(root, inventory, rootIdentity);
  }
}
