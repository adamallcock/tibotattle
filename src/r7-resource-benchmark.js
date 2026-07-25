import { createHash } from "node:crypto";
import { constants as filesystemConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManagedClaudeStatusLine,
  installClaudeCallback,
  uninstallClaudeCallback,
} from "./claude-callback-lifecycle.js";
import { createLocalExportWorkspace } from "./export-set-controller.js";
import { materializeLocalExportSet } from "./export-set-materializer.js";
import { planLocalExportDeletion } from "./export-deletion.js";
import { deleteLocalExport } from "./export-deletion-executor.js";
import { planLocalExportWorkspaceDiscard } from "./export-workspace-discard.js";
import { discardLocalExportWorkspace } from "./export-workspace-discard-executor.js";
import {
  createR7StructuralFixture,
  inspectR7StructuralFixture,
  R7_FIXTURE_CREATED_AT,
  R7_FIXTURE_END_AT,
  R7_FIXTURE_SECRET,
  R7_FIXTURE_START_AT,
  R7_FIXTURE_VERSION,
} from "./r7-resource-benchmark-fixture.js";
import { runR7ResourceBoundaryMatrix } from "./r7-resource-boundaries.js";
import {
  R7_WORKER_DEFAULT_MAXIMUM_STDIN_BYTES,
  R7_WORKER_MAXIMUM_STDIN_BYTES,
  R7_WORKER_RSS_SAMPLE_INTERVAL_MS,
  runR7WorkerWatchdog,
} from "./r7-worker-watchdog.js";
import {
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  readBoundedDirectoryEntries,
} from "./export-resource-policy.js";
import {
  assertValidR7ResourceBenchmarkReceipt,
  computeR7ResourceBenchmarkReceiptSha256,
  R7_RESOURCE_BENCHMARK_BOUNDARY_DIMENSIONS,
  R7_RESOURCE_BENCHMARK_DETERMINISTIC_PROJECTION_VERSION,
  R7_RESOURCE_BENCHMARK_FAILURE_CODE_BY_DIMENSION,
  R7_RESOURCE_BENCHMARK_OPERATION_NAMES,
  R7_RESOURCE_BENCHMARK_POLICY_VERSION,
  R7_RESOURCE_BENCHMARK_RECEIPT_SCHEMA_SHA256,
  R7_RESOURCE_BENCHMARK_RECEIPT_VERSION,
  R7_RESOURCE_BENCHMARK_UNIT_BY_DIMENSION,
} from "./r7-resource-benchmark-schema.js";
import { stableJson } from "./storage.js";

export const R7_BENCHMARK_PROTOCOL_VERSION = "g1-r7-resource-benchmark-v0.1";
export const R7_SELECTION_RULE_VERSION = "g1-r7-ceiling-selection-v0.1";
const WORKER = new URL("../scripts/r7-resource-benchmark-worker.js", import.meta.url);
const REPOSITORY_ROOT = new URL("../", import.meta.url);
const INTENTIONAL_CHECKPOINT = Symbol("r7-intentional-checkpoint");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256OwnedFile(path, expectedStat = null) {
  const before = expectedStat ?? await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error("R7 temporary inventory contained an unsupported entry");
  }
  const handle = await open(
    path,
    filesystemConstants.O_RDONLY | (filesystemConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1
        || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size) {
      throw new Error("R7 temporary file changed during inventory");
    }
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      highWaterMark: 64 * 1024,
    })) {
      digest.update(chunk);
    }
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1
        || after.dev !== opened.dev || after.ino !== opened.ino
        || after.size !== opened.size) {
      throw new Error("R7 temporary file changed during inventory");
    }
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

async function framedSourceSha256(urls) {
  const digest = createHash("sha256");
  digest.update("app-usagemonitor/r7-benchmark-source-set/v1\0");
  for (const url of urls) {
    const bytes = await readFile(url);
    digest.update(url.pathname.slice(REPOSITORY_ROOT.pathname.length));
    digest.update("\0");
    digest.update(String(bytes.length));
    digest.update("\0");
    digest.update(bytes);
  }
  return digest.digest("hex");
}

async function benchmarkImplementationUrls() {
  const sourceDirectory = new URL("./", import.meta.url);
  const sourceNames = await readBoundedDirectoryEntries(sourceDirectory, {
    maximumEntries: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumDirectoryEntries,
    sort: true,
  });
  return [
    ...sourceNames.filter((name) => name.endsWith(".js")).map((name) => new URL(name, sourceDirectory)),
    WORKER,
    new URL("../package.json", import.meta.url),
    new URL("../pnpm-lock.yaml", import.meta.url),
  ];
}

export async function inventoryR7OwnedTree(root) {
  const rows = [];
  let entryCount = 0;
  async function walk(directory, prefix) {
    const names = await readBoundedDirectoryEntries(directory, {
      maximumEntries: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumDirectoryEntries,
      sort: true,
    });
    for (const name of names) {
      entryCount += 1;
      if (entryCount > DEFAULT_EXPORT_RESOURCE_LIMITS.maximumDirectoryEntries) {
        throw new Error("R7 temporary inventory exceeded its bounded entry count");
      }
      const relativeName = prefix ? `${prefix}/${name}` : name;
      const path = join(directory, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("R7 temporary inventory contained a symlink");
      if (stat.isDirectory()) {
        await walk(path, relativeName);
        rows.push({ kind: "directory", relativeName });
      } else if (stat.isFile() && stat.nlink === 1) {
        rows.push({
          kind: "file",
          relativeName,
          bytes: stat.size,
          dev: stat.dev,
          ino: stat.ino,
          sha256: await sha256OwnedFile(path, stat),
        });
      } else {
        throw new Error("R7 temporary inventory contained an unsupported entry");
      }
    }
  }
  await walk(root, "");
  const projection = rows.map(({
    kind,
    relativeName,
    bytes = null,
    dev = null,
    ino = null,
    sha256: digest = null,
  }) => ({
    kind,
    relativeName,
    bytes,
    dev,
    ino,
    sha256: digest,
  }));
  return {
    rows,
    entryCount,
    fileCount: rows.filter((row) => row.kind === "file").length,
    inventorySha256: sha256(stableJson(projection)),
    deterministicProjectionSha256: sha256(stableJson(projection.map(
      ({ kind, relativeName, bytes }) => ({ kind, relativeName, bytes }),
    ))),
  };
}

async function assertSameOwnedRoot(root, expectedIdentity) {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || stat.dev !== expectedIdentity.dev || stat.ino !== expectedIdentity.ino) {
    throw new Error("R7 temporary root identity changed");
  }
}

export async function cleanupR7OwnedTree(root, expected, expectedRootIdentity) {
  await assertSameOwnedRoot(root, expectedRootIdentity);
  const current = await inventoryR7OwnedTree(root);
  if (current.inventorySha256 !== expected.inventorySha256
      || current.entryCount !== expected.entryCount
      || current.fileCount !== expected.fileCount) {
    throw new Error("R7 temporary inventory changed before cleanup");
  }
  for (const row of current.rows) {
    await assertSameOwnedRoot(root, expectedRootIdentity);
    const path = join(root, ...row.relativeName.split("/"));
    if (row.kind === "file") {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== row.bytes
          || stat.dev !== row.dev || stat.ino !== row.ino
          || await sha256OwnedFile(path, stat) !== row.sha256) {
        throw new Error("R7 temporary file changed before cleanup");
      }
      await unlink(path);
    } else {
      if ((await readBoundedDirectoryEntries(path, { maximumEntries: 1 })).length !== 0) {
        throw new Error("R7 temporary directory was not empty during cleanup");
      }
      await rmdir(path);
    }
  }
  await assertSameOwnedRoot(root, expectedRootIdentity);
  await rmdir(root);
  try {
    await lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        inventorySha256: current.inventorySha256,
        entryCount: current.entryCount,
        fileCount: current.fileCount,
        exhausted: true,
      };
    }
    throw error;
  }
  throw new Error("R7 temporary inventory remained after cleanup");
}

function memoryBackend() {
  let value = null;
  return {
    async read() { return value && Buffer.from(value); },
    async createIfMissing(_capability, secret) {
      if (value) return "existing";
      value = Buffer.from(secret);
      return "created";
    },
    async replaceExact(_capability, expected, replacement) {
      if (!value) return "missing";
      if (!value.equals(expected)) return "conflict";
      value.fill(0);
      value = Buffer.from(replacement);
      return "replaced";
    },
    async deleteExact(_capability, expected) {
      if (!value) return "missing";
      if (!value.equals(expected)) return "conflict";
      value.fill(0);
      value = null;
      return "deleted";
    },
  };
}

function workerConfig(operation, fixture, extra = {}) {
  return {
    operation,
    secretHex: R7_FIXTURE_SECRET.toString("hex"),
    codexHome: fixture.paths.codexHome,
    collectorPath: fixture.paths.collectorPath,
    claudeStateDirectory: fixture.paths.claudeStateDirectory,
    claudeProjectsDirectory: fixture.paths.claudeProjectsDirectory,
    startAt: R7_FIXTURE_START_AT,
    endAt: R7_FIXTURE_END_AT,
    createdAt: R7_FIXTURE_CREATED_AT,
    resourceLimits: {},
    ...extra,
  };
}

export async function runR7BenchmarkWorker(config, {
  timeoutMs = 60_000,
  maximumStdinBytes,
  maximumRssBytes = DEFAULT_EXPORT_RESOURCE_LIMITS.maximumRssBytes,
  runtimeExecutable = process.execPath,
} = {}) {
  if (maximumStdinBytes !== undefined
      && (maximumStdinBytes !== R7_WORKER_MAXIMUM_STDIN_BYTES
        || config?.operation !== "source_scan"
        || !config?.sourcePlanBundle)) {
    throw new TypeError("R7 extended worker input is restricted to real source-plan scans");
  }
  const selectedMaximumStdinBytes = maximumStdinBytes
    ?? R7_WORKER_DEFAULT_MAXIMUM_STDIN_BYTES;
  let workerResult = null;
  const watchdog = await runR7WorkerWatchdog({
    runtimeExecutable,
    workerPath: WORKER.pathname,
    cwd: process.cwd(),
    input: JSON.stringify(config),
    timeoutMs,
    maximumRssBytes,
    maximumStdinBytes: selectedMaximumStdinBytes,
    requireLifetimePeakRss: true,
    consumeStdout(bytes) {
      const value = JSON.parse(bytes.toString("utf8"));
      if (value?.operation !== config.operation || !["completed", "failed"].includes(value?.status)
          || !Number.isSafeInteger(value?.peakRssBytes) || value.peakRssBytes < 1) {
        throw new TypeError("Invalid R7 operation worker result");
      }
      workerResult = value;
      return value.peakRssBytes;
    },
  });
  if (watchdog.outcome !== "completed" || workerResult === null) {
    throw new Error(`R7 operation worker stopped: ${watchdog.outcome}`);
  }
  return {
    ...workerResult,
    parentElapsedMs: watchdog.elapsedMs,
    externalPeakRssBytes: watchdog.peakRssBytes,
    rssSampleCount: watchdog.rssSampleCount,
    rssSampleFailureCount: watchdog.rssSampleFailureCount,
    watchdogStdoutBytes: watchdog.stdoutBytes,
    watchdogStderrBytes: watchdog.stderrBytes,
  };
}

function workspaceOptions(fixture, directory, extra = {}) {
  return {
    directory,
    startAt: R7_FIXTURE_START_AT,
    endAt: R7_FIXTURE_END_AT,
    createdAt: R7_FIXTURE_CREATED_AT,
    codexHome: fixture.paths.codexHome,
    collectorPath: fixture.paths.collectorPath,
    claudeStateDirectory: fixture.paths.claudeStateDirectory,
    claudeProjectsDirectory: fixture.paths.claudeProjectsDirectory,
    secret: R7_FIXTURE_SECRET,
    activityMarkers: [],
    ...extra,
  };
}

async function prepareIncompleteWorkspace(fixture, directory) {
  try {
    await createLocalExportWorkspace(workspaceOptions(fixture, directory, {
      async failpoint(stage) {
        if (stage === "after_record_batch") throw INTENTIONAL_CHECKPOINT;
      },
    }));
  } catch (error) {
    if (error === INTENTIONAL_CHECKPOINT) return;
    throw error;
  }
  throw new Error("R7 incomplete workspace fixture unexpectedly completed");
}

async function prepareInterruptedDeletion(fixture, workspaceDirectory, outputDirectory) {
  await createLocalExportWorkspace(workspaceOptions(fixture, workspaceDirectory));
  await materializeLocalExportSet({
    workspaceDirectory,
    outputDirectory,
    secret: R7_FIXTURE_SECRET,
    maximumRecordsPerChunk: 3,
  });
  const preview = await planLocalExportDeletion({ workspaceDirectory, outputDirectory });
  const interruption = new Error("r7 intentional deletion interruption");
  try {
    await deleteLocalExport({
      workspaceDirectory,
      outputDirectory,
      confirmationToken: preview.confirmationToken,
      async failpoint(stage) {
        if (stage === "after_journal_commit") throw interruption;
      },
    });
  } catch (error) {
    if (error === interruption) return;
    throw error;
  }
  throw new Error("R7 deletion recovery fixture unexpectedly completed");
}

async function prepareInterruptedDiscard(fixture, workspaceDirectory) {
  await prepareIncompleteWorkspace(fixture, workspaceDirectory);
  const preview = await planLocalExportWorkspaceDiscard({ workspaceDirectory });
  const interruption = new Error("r7 intentional discard interruption");
  try {
    await discardLocalExportWorkspace({
      workspaceDirectory,
      confirmationToken: preview.confirmationToken,
      async failpoint(stage) {
        if (stage === "after_journal_commit") throw interruption;
      },
    });
  } catch (error) {
    if (error === interruption) return;
    throw error;
  }
  throw new Error("R7 discard recovery fixture unexpectedly completed");
}

async function prepareInterruptedCallback(root) {
  const callback = await prepareCallbackFixture(root);
  const interruption = new Error("r7 intentional callback interruption");
  try {
    await uninstallClaudeCallback({
      settingsFile: callback.settingsFile,
      lifecycleDirectory: callback.lifecycleDirectory,
      installedStatusLine: callback.installedStatusLine,
      async failpoint(stage) {
        if (stage === "after_uninstall_state_prepared") throw interruption;
      },
    });
  } catch (error) {
    if (error === interruption) return callback;
    throw error;
  }
  throw new Error("R7 callback recovery fixture unexpectedly completed");
}

async function prepareCallbackFixture(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const settingsDirectory = join(root, "claude-settings");
  const settingsFile = join(settingsDirectory, "settings.json");
  const lifecycleDirectory = join(root, "claude-lifecycle");
  await mkdir(settingsDirectory, { mode: 0o700 });
  const originalSettings = `${JSON.stringify({ theme: "dark" }, null, 2)}\n`;
  await writeFile(settingsFile, originalSettings, { mode: 0o600 });
  const installedStatusLine = buildManagedClaudeStatusLine({
    nodeExecutable: "/synthetic/node",
    runtimeScript: "/synthetic/callback.js",
  });
  const backend = memoryBackend();
  await installClaudeCallback({
    settingsFile,
    lifecycleDirectory,
    installedStatusLine,
    backend,
    generateSecret: () => Buffer.alloc(32, 0x74),
  });
  const installedCapability = await backend.read();
  if (!Buffer.isBuffer(installedCapability) || installedCapability.length !== 32) {
    throw new Error("R7 callback fixture did not retain its synthetic capability");
  }
  const installedCapabilitySha256 = sha256(installedCapability);
  installedCapability.fill(0);
  return {
    settingsFile,
    lifecycleDirectory,
    installedStatusLine,
    backend,
    originalSettingsSha256: sha256(originalSettings),
    installedCapabilitySha256,
  };
}

function deterministicOperationProjection(operation) {
  const {
    durableElapsedMs: _durableElapsedMs,
    durablePeakRssBytes: _durablePeakRssBytes,
    ...deterministicEvidence
  } = operation.evidence;
  return {
    operation: operation.operation,
    status: operation.status,
    failureCode: operation.failureCode,
    evidence: deterministicEvidence,
  };
}

async function runLifecyclePass(root, fixture, options) {
  await mkdir(root, { mode: 0o700 });
  const workspace = join(root, "workspace-complete");
  const output = join(root, "output-complete");
  const resumeWorkspace = join(root, "workspace-resume");
  const discardWorkspace = join(root, "workspace-discard");
  const deletionRecoveryWorkspace = join(root, "workspace-delete-recovery");
  const deletionRecoveryOutput = join(root, "output-delete-recovery");
  const discardRecoveryWorkspace = join(root, "workspace-discard-recovery");
  const operations = [];
  const identityStateFile = join(root, "synthetic-identity-state.bin");
  const independentOutputFile = join(root, "synthetic-independent-output.bin");
  await writeFile(identityStateFile, Buffer.alloc(64, 0x75), { mode: 0o600 });
  await writeFile(independentOutputFile, Buffer.alloc(96, 0x76), { mode: 0o600 });
  const identityStateSha256 = sha256(await readFile(identityStateFile));
  const independentOutputSha256 = sha256(await readFile(independentOutputFile));

  operations.push(await runR7BenchmarkWorker(workerConfig("source_scan", fixture, {
    workspaceDirectory: workspace,
  }), options));

  await prepareIncompleteWorkspace(fixture, resumeWorkspace);
  operations.push(await runR7BenchmarkWorker(workerConfig("checkpoint_resume", fixture, {
    workspaceDirectory: resumeWorkspace,
  }), options));

  operations.push(await runR7BenchmarkWorker(workerConfig("export_set_materialize", fixture, {
    workspaceDirectory: workspace,
    outputDirectory: output,
    maximumRecordsPerChunk: 3,
  }), options));
  operations.push(await runR7BenchmarkWorker(workerConfig("export_set_verify", fixture, {
    outputDirectory: output,
  }), options));

  await prepareIncompleteWorkspace(fixture, discardWorkspace);
  operations.push(await runR7BenchmarkWorker(workerConfig("workspace_discard", fixture, {
    workspaceDirectory: discardWorkspace,
  }), options));

  await prepareInterruptedDiscard(fixture, discardRecoveryWorkspace);
  operations.push(await runR7BenchmarkWorker(workerConfig("workspace_discard_recovery", fixture, {
    workspaceDirectory: discardRecoveryWorkspace,
  }), options));

  const callback = await prepareCallbackFixture(root);
  operations.push(await runR7BenchmarkWorker(workerConfig("claude_callback_uninstall", fixture, {
    settingsFile: callback.settingsFile,
    lifecycleDirectory: callback.lifecycleDirectory,
    installedStatusLine: callback.installedStatusLine,
  }), options));

  const recoveryCallback = await prepareInterruptedCallback(join(root, "callback-recovery"));
  operations.push(await runR7BenchmarkWorker(workerConfig("claude_callback_recovery", fixture, {
    settingsFile: recoveryCallback.settingsFile,
    lifecycleDirectory: recoveryCallback.lifecycleDirectory,
    installedStatusLine: recoveryCallback.installedStatusLine,
  }), options));

  await prepareInterruptedDeletion(fixture, deletionRecoveryWorkspace, deletionRecoveryOutput);
  operations.push(await runR7BenchmarkWorker(workerConfig("complete_set_delete_recovery", fixture, {
    workspaceDirectory: deletionRecoveryWorkspace,
    outputDirectory: deletionRecoveryOutput,
  }), options));

  operations.push(await runR7BenchmarkWorker(workerConfig("complete_set_delete", fixture, {
    workspaceDirectory: workspace,
    outputDirectory: output,
  }), options));

  const finalFixtureEvidence = await inspectR7StructuralFixture(fixture.paths);
  if (stableJson(finalFixtureEvidence) !== stableJson(fixture.evidence)) {
    throw new Error("R7 lifecycle changed a generated source fixture");
  }
  if (operations.some((operation) => operation.status !== "completed")) {
    throw new Error("R7 lifecycle operation failed");
  }
  const retainedCapability = await callback.backend.read();
  const retainedRecoveryCapability = await recoveryCallback.backend.read();
  const callbackSettingsPreserved = sha256(await readFile(callback.settingsFile))
      === callback.originalSettingsSha256
    && sha256(await readFile(recoveryCallback.settingsFile))
      === recoveryCallback.originalSettingsSha256;
  const identityStatePreserved = sha256(await readFile(identityStateFile)) === identityStateSha256
    && Buffer.isBuffer(retainedCapability)
    && sha256(retainedCapability) === callback.installedCapabilitySha256
    && Buffer.isBuffer(retainedRecoveryCapability)
    && sha256(retainedRecoveryCapability) === recoveryCallback.installedCapabilitySha256;
  retainedCapability?.fill(0);
  retainedRecoveryCapability?.fill(0);
  const independentOutputPreserved = sha256(await readFile(independentOutputFile)) === independentOutputSha256;
  if (!identityStatePreserved || !independentOutputPreserved || !callbackSettingsPreserved) {
    throw new Error("R7 lifecycle changed protected synthetic state");
  }
  const cleanupInventory = await inventoryR7OwnedTree(root);
  return {
    fixtureEvidence: fixture.evidence,
    fixturePreserved: true,
    identityStatePreserved,
    independentOutputPreserved,
    callbackSettingsPreserved,
    operations,
    cleanupInventorySha256: cleanupInventory.inventorySha256,
    cleanupInventoryProjectionSha256: cleanupInventory.deterministicProjectionSha256,
    cleanupInventoryEntryCount: cleanupInventory.entryCount,
    deterministicProjectionSha256: sha256(stableJson({
      fixtureEvidence: fixture.evidence,
      operations: operations.map(deterministicOperationProjection),
    })),
  };
}

function operationEvidence(pass, name, field) {
  return pass.operations.find((operation) => operation.operation === name)?.evidence?.[field] ?? null;
}

function compareCaptured(first, second) {
  if (typeof first !== "string" || typeof second !== "string") return "not_run";
  return first === second ? "matched" : "mismatched";
}

function fixedFailureCodeProjection(pass, boundaryMatrix) {
  return {
    operations: pass.operations.map(({ operation, status }) => ({
      operation,
      status: status === "completed" && operation.endsWith("_recovery")
        ? "interrupted_recovered" : status,
      failureCode: status === "completed" && operation.endsWith("_recovery")
        ? "interruption_injected" : status === "completed" ? "none" : "benchmark_operation_failed",
    })),
    boundaries: boundaryMatrix.rows.map((row) => ({
      dimension: row.dimension,
      atLimit: row.atLimit,
      plusOne: row.plusOne,
      failureCode: row.failureCode,
    })),
  };
}

function determinismEvidence(first, second, firstBoundaryMatrix, secondBoundaryMatrix) {
  const firstFailureCodesSha256 = sha256(stableJson(
    fixedFailureCodeProjection(first, firstBoundaryMatrix),
  ));
  const secondFailureCodesSha256 = sha256(stableJson(
    fixedFailureCodeProjection(second, secondBoundaryMatrix),
  ));
  const checks = {
    fixtureManifest: compareCaptured(
      first.fixtureEvidence.manifestSha256,
      second.fixtureEvidence.manifestSha256,
    ),
    sourcePlan: compareCaptured(
      operationEvidence(first, "source_scan", "sourcePlanSha256"),
      operationEvidence(second, "source_scan", "sourcePlanSha256"),
    ),
    logicalRecords: compareCaptured(
      operationEvidence(first, "export_set_materialize", "logicalRecordsSha256"),
      operationEvidence(second, "export_set_materialize", "logicalRecordsSha256"),
    ),
    chunkBoundaries: compareCaptured(
      operationEvidence(first, "export_set_materialize", "chunkBoundariesSha256"),
      operationEvidence(second, "export_set_materialize", "chunkBoundariesSha256"),
    ),
    canonicalArtifacts: compareCaptured(
      operationEvidence(first, "export_set_materialize", "canonicalArtifactsSha256"),
      operationEvidence(second, "export_set_materialize", "canonicalArtifactsSha256"),
    ),
    lifecycleProjection: compareCaptured(
      first.deterministicProjectionSha256,
      second.deterministicProjectionSha256,
    ),
    fixedFailureCodes: compareCaptured(firstFailureCodesSha256, secondFailureCodesSha256),
    cleanupInventories: compareCaptured(
      first.cleanupInventoryProjectionSha256,
      second.cleanupInventoryProjectionSha256,
    ),
  };
  const values = Object.values(checks);
  return {
    runCount: 2,
    passed: values.every((value) => value === "matched"),
    status: values.some((value) => value === "mismatched")
      ? "failed"
      : values.some((value) => value === "not_run") ? "partial" : "passed",
    checks,
    runProjectionSha256es: [
      first.deterministicProjectionSha256,
      second.deterministicProjectionSha256,
    ],
  };
}

export async function runR7SmokeEvidence({
  temporaryRoot = tmpdir(),
  timeoutMs = 60_000,
  cleanupFailpoint = async () => {},
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60_000) {
    throw new TypeError("R7 benchmark timeout must be a positive bounded integer");
  }
  if (typeof cleanupFailpoint !== "function") {
    throw new TypeError("R7 benchmark cleanup failpoint must be a function");
  }
  const createdPath = await mkdtemp(join(temporaryRoot, "usage-monitor-r7-"));
  await chmod(createdPath, 0o700);
  const created = await realpath(createdPath);
  const createdStat = await lstat(created);
  if (!createdStat.isDirectory() || createdStat.isSymbolicLink()) {
    throw new Error("R7 temporary root was not a real directory");
  }
  const createdIdentity = { dev: createdStat.dev, ino: createdStat.ino };
  const fixtureRoot = join(created, "fixture-source");
  const firstPassRoot = join(created, "deterministic-pass-1");
  const secondPassRoot = join(created, "deterministic-pass-2");
  let result;
  try {
    await mkdir(fixtureRoot, { mode: 0o700 });
    const fixture = await createR7StructuralFixture(fixtureRoot);
    const first = await runLifecyclePass(firstPassRoot, fixture, { timeoutMs });
    const second = await runLifecyclePass(secondPassRoot, fixture, { timeoutMs });
    const firstBoundaryMatrix = runR7ResourceBoundaryMatrix();
    const secondBoundaryMatrix = runR7ResourceBoundaryMatrix();
    const determinism = determinismEvidence(
      first,
      second,
      firstBoundaryMatrix,
      secondBoundaryMatrix,
    );
    result = {
      benchmarkProtocolVersion: R7_BENCHMARK_PROTOCOL_VERSION,
      selectionRuleVersion: R7_SELECTION_RULE_VERSION,
      fixtureVersion: R7_FIXTURE_VERSION,
      fixtureManifestSha256: first.fixtureEvidence.manifestSha256,
      first,
      second,
      boundaryMatrix: firstBoundaryMatrix,
      determinism,
    };
  } finally {
    await cleanupFailpoint(created);
    await assertSameOwnedRoot(created, createdIdentity);
    const inventory = await inventoryR7OwnedTree(created);
    const cleanup = await cleanupR7OwnedTree(created, inventory, createdIdentity);
    if (result) result.cleanup = cleanup;
  }
  return result;
}

const ZERO_OPERATION_METRICS = Object.freeze({
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

function maximumMetric(first, second, key) {
  return Math.max(first?.[key] ?? 0, second?.[key] ?? 0);
}

function operationMetrics(first, second) {
  return {
    wallTimeMs: Math.ceil(Math.max(first.wallTimeMicros, second.wallTimeMicros) / 1_000),
    parentElapsedMs: Math.max(first.parentElapsedMs, second.parentElapsedMs),
    cpuTimeMs: Math.ceil(Math.max(
      first.cpuUserMicros + first.cpuSystemMicros,
      second.cpuUserMicros + second.cpuSystemMicros,
    ) / 1_000),
    peakRssBytes: Math.max(
      first.peakRssBytes,
      second.peakRssBytes,
      first.externalPeakRssBytes,
      second.externalPeakRssBytes,
      first.evidence.durablePeakRssBytes ?? 0,
      second.evidence.durablePeakRssBytes ?? 0,
    ),
    rssSampleCount: Math.max(first.rssSampleCount, second.rssSampleCount),
    rssSampleFailureCount: Math.max(
      first.rssSampleFailureCount,
      second.rssSampleFailureCount,
    ),
    durableElapsedMs: maximumMetric(first.evidence, second.evidence, "durableElapsedMs"),
    durablePeakRssBytes: maximumMetric(first.evidence, second.evidence, "durablePeakRssBytes"),
    directoryEntries: maximumMetric(first.evidence, second.evidence, "directoryEntries"),
    sourceFiles: maximumMetric(first.evidence, second.evidence, "sourceFiles"),
    sourceBytes: maximumMetric(first.evidence, second.evidence, "sourceBytes"),
    physicalLines: maximumMetric(first.evidence, second.evidence, "physicalLines"),
    outputRecords: maximumMetric(first.evidence, second.evidence, "outputRecords"),
    expandedRecordBytes: maximumMetric(first.evidence, second.evidence, "expandedRecordBytes"),
    decodedBytes: maximumMetric(first.evidence, second.evidence, "decodedArtifactBytes"),
    encodedBytes: maximumMetric(first.evidence, second.evidence, "encodedArtifactBytes"),
    workspaceHighWaterBytes: maximumMetric(first.evidence, second.evidence, "workspaceHighWaterBytes"),
    manifestBytes: maximumMetric(first.evidence, second.evidence, "manifestBytes"),
    chunks: maximumMetric(first.evidence, second.evidence, "chunkCount"),
    affectedFiles: maximumMetric(first.evidence, second.evidence, "affectedFiles"),
    affectedBytes: maximumMetric(first.evidence, second.evidence, "affectedBytes"),
  };
}

function receiptOperations(evidence) {
  const first = new Map(evidence.first.operations.map((operation) => [operation.operation, operation]));
  const second = new Map(evidence.second.operations.map((operation) => [operation.operation, operation]));
  return R7_RESOURCE_BENCHMARK_OPERATION_NAMES.map((name) => {
    if (!first.has(name) || !second.has(name)) {
      return {
        name,
        status: "not_run",
        failureCode: "not_run_profile",
        evidenceSha256: [],
        metrics: { ...ZERO_OPERATION_METRICS },
      };
    }
    const recovered = name.endsWith("_recovery");
    return {
      name,
      status: recovered ? "interrupted_recovered" : "completed",
      failureCode: recovered ? "interruption_injected" : "none",
      evidenceSha256: [
        first.get(name).evidence.operationEvidenceSha256,
        second.get(name).evidence.operationEvidenceSha256,
      ],
      metrics: operationMetrics(first.get(name), second.get(name)),
    };
  });
}

function trial(value, status, failureCode) {
  return {
    value,
    status,
    failureCode: status === "passed" ? "none"
      : status === "not_run" ? "not_run_profile" : failureCode,
  };
}

function surface(status, failureCode) {
  if (status === "passed") return { status: "enforced", failureCode };
  if (status === "not_applicable") return { status: "not_applicable", failureCode: "none" };
  return { status: "not_run", failureCode: "not_run_profile" };
}

function receiptBoundaryEvidence(matrix) {
  const byDimension = new Map(matrix.rows.map((row) => [row.dimension, row]));
  return R7_RESOURCE_BENCHMARK_BOUNDARY_DIMENSIONS.map((dimension) => {
    const row = byDimension.get(dimension);
    if (!row) throw new Error("R7 boundary matrix is incomplete");
    const failureCode = R7_RESOURCE_BENCHMARK_FAILURE_CODE_BY_DIMENSION[dimension];
    const notRun = row.atLimit === "not_run";
    return {
      dimension,
      mode: notRun ? "not_identified" : "synthetic_counter",
      unit: R7_RESOURCE_BENCHMARK_UNIT_BY_DIMENSION[dimension],
      selectedLimit: row.policyLimit,
      atLimit: trial(row.policyLimit, row.atLimit, failureCode),
      plusOne: trial(row.policyLimit + 1, row.plusOne, failureCode),
      producer: surface(row.producer, failureCode),
      verifier: surface(row.verifier, failureCode),
      identification: notRun ? "not_run" : "not_identified",
    };
  });
}

function runtimeVersion() {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(process.versions.node);
  if (!match) throw new Error("R7 runtime version is unsupported");
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function qualifiedRuntimeClass(version) {
  if (version.major === 24 && version.minor === 14 && version.patch === 0) {
    return "pinned_candidate";
  }
  if (version.major === 26 && version.minor === 2 && version.patch === 0) {
    return "compatibility_crosscheck";
  }
  throw new Error("R7 smoke receipt runtime is not exactly release-qualified");
}

function assertContentFreeReceipt(receipt) {
  const text = stableJson(receipt);
  const prohibited = [
    "R7_SYNTHETIC_CONTENT_CANARY_NEVER_EXPORT",
    "participantId",
    "accountPseudonym",
    "sessionId",
    "eventId",
    "modelFingerprint",
    "/Users/",
    "/home/",
    "workspace-complete",
    "codex-home",
    "claude-projects",
  ];
  if (prohibited.some((value) => text.includes(value))) {
    throw new Error("R7 benchmark receipt privacy scan failed");
  }
}

export async function buildR7SmokeReceipt(evidence) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("R7 smoke receipt is qualified only for macOS arm64");
  }
  const resourcePolicySourceSha256 = await framedSourceSha256([
    new URL("./export-resource-policy.js", import.meta.url),
  ]);
  const implementationUrls = await benchmarkImplementationUrls();
  const benchmarkSourceSha256 = await framedSourceSha256(implementationUrls);
  const version = runtimeVersion();
  const receipt = {
    schemaVersion: R7_RESOURCE_BENCHMARK_RECEIPT_VERSION,
    protocolVersion: R7_BENCHMARK_PROTOCOL_VERSION,
    policyVersion: R7_RESOURCE_BENCHMARK_POLICY_VERSION,
    selectionRuleVersion: R7_SELECTION_RULE_VERSION,
    profile: "smoke",
    classification: "synthetic_lifecycle",
    runtimeProvenance: {
      platform: "macos",
      architecture: "arm64",
      hardwareClass: "apple_silicon",
      runtimeFamily: "node",
      runtimeClass: qualifiedRuntimeClass(version),
      runtimeVersion: version,
      rssMeasurementMethod: "external_sampling",
      rssSamplingIntervalMs: R7_WORKER_RSS_SAMPLE_INTERVAL_MS,
    },
    contractProvenance: {
      receiptSchemaSha256: R7_RESOURCE_BENCHMARK_RECEIPT_SCHEMA_SHA256,
      resourcePolicySourceSha256,
      benchmarkSourceSha256,
      benchmarkSourceFileCount: implementationUrls.length,
      fixtureVersion: evidence.fixtureVersion,
      fixtureManifestSha256: evidence.fixtureManifestSha256,
    },
    operations: receiptOperations(evidence),
    boundaryEvidence: receiptBoundaryEvidence(evidence.boundaryMatrix),
    determinismEvidence: {
      projectionVersion: R7_RESOURCE_BENCHMARK_DETERMINISTIC_PROJECTION_VERSION,
      status: evidence.determinism.status,
      runCount: 2,
      runProjectionSha256es: evidence.determinism.runProjectionSha256es,
      checks: evidence.determinism.checks,
    },
    sourceLogsPreserved: evidence.first.fixturePreserved && evidence.second.fixturePreserved,
    identityStatePreserved: evidence.first.identityStatePreserved && evidence.second.identityStatePreserved,
    independentOutputPreserved: evidence.first.independentOutputPreserved
      && evidence.second.independentOutputPreserved,
    callbackSettingsPreserved: evidence.first.callbackSettingsPreserved
      && evidence.second.callbackSettingsPreserved,
    prohibitedDataScan: true,
    networkActivity: "not_measured",
    secureErasureClaimed: false,
    transportReady: false,
    receiptSha256: "0".repeat(64),
  };
  assertContentFreeReceipt(receipt);
  receipt.receiptSha256 = computeR7ResourceBenchmarkReceiptSha256(receipt);
  return assertValidR7ResourceBenchmarkReceipt(receipt);
}

export async function runR7SmokeBenchmark(options = {}) {
  return buildR7SmokeReceipt(await runR7SmokeEvidence(options));
}
