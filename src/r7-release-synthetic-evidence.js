import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import {
  createR7ReleaseWorkloadFixture,
  inspectR7ReleaseWorkloadFixture,
  R7_RELEASE_SYNTHETIC_PRESSURE_PARAMETERS,
  R7_RELEASE_SYNTHETIC_SEMANTICS_PARAMETERS,
  R7_RELEASE_WORKLOAD_END_AT,
  R7_RELEASE_WORKLOAD_LAYOUT,
  R7_RELEASE_WORKLOAD_START_AT,
} from "./r7-release-workload-fixture.js";
import {
  cleanupR7OwnedTree,
  inventoryR7OwnedTree,
  runR7BenchmarkWorker,
} from "./r7-resource-benchmark.js";
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
  DEFAULT_EXPORT_RESOURCE_LIMITS,
} from "./export-resource-policy.js";
import { stableJson } from "./storage.js";
import {
  buildManagedClaudeStatusLine,
  installClaudeCallback,
  uninstallClaudeCallback,
} from "./claude-callback-lifecycle.js";
import {
  localExportSetMaterialization,
  localExportSourcePipeline,
} from "./local-node-runtime.js";
import { EXPORT_SET_MANIFEST_BASENAME } from "./export/index.js";
import { planLocalExportDeletion } from "./export-deletion.js";
import { deleteLocalExport } from "./export-deletion-executor.js";
import { planLocalExportWorkspaceDiscard } from "./export-workspace-discard.js";
import { discardLocalExportWorkspace } from "./export-workspace-discard-executor.js";
import { decompressExportBytes } from "./export-compression.js";
import { loadVerifiedLocalMetadataBundleBytes } from "./bundle-verifier.js";
import { exportSetChunkBasenames } from "./export-set-schema.js";

export const R7_RELEASE_SYNTHETIC_EVIDENCE_VERSION =
  "g1-r7-release-synthetic-evidence-v0.1";

const { createLocalExportWorkspace } = localExportSourcePipeline.controller;
const { materializeLocalExportSet } = localExportSetMaterialization;

const SECRET_HEX = Buffer.alloc(32, 0x71).toString("hex");
const PROFILE_CONFIGURATION = Object.freeze({
  release_synthetic_semantics: Object.freeze({
    parameters: R7_RELEASE_SYNTHETIC_SEMANTICS_PARAMETERS,
    targetChunks: 16,
    requireExactTargetChunks: false,
  }),
  release_synthetic_pressure: Object.freeze({
    parameters: R7_RELEASE_SYNTHETIC_PRESSURE_PARAMETERS,
    targetChunks: 128,
    requireExactTargetChunks: true,
  }),
});

const INTENTIONAL_CHECKPOINT = Symbol("r7-release-intentional-checkpoint");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixturePaths(root) {
  return {
    codexHome: join(root, R7_RELEASE_WORKLOAD_LAYOUT.codexHome),
    collectorPath: join(root, R7_RELEASE_WORKLOAD_LAYOUT.collectorFile),
    claudeStateDirectory: join(root, R7_RELEASE_WORKLOAD_LAYOUT.claudeState),
    claudeProjectsDirectory: join(root, R7_RELEASE_WORKLOAD_LAYOUT.claudeProjects),
  };
}

function workerConfig(operation, fixture, extra = {}) {
  return {
    operation,
    secretHex: SECRET_HEX,
    ...fixturePaths(fixture),
    startAt: R7_RELEASE_WORKLOAD_START_AT,
    endAt: R7_RELEASE_WORKLOAD_END_AT,
    createdAt: R7_RELEASE_WORKLOAD_END_AT,
    resourceLimits: {},
    ...extra,
  };
}

function secret() {
  return Buffer.from(SECRET_HEX, "hex");
}

function workspaceOptions(fixture, directory, extra = {}) {
  return {
    directory,
    ...fixturePaths(fixture),
    startAt: R7_RELEASE_WORKLOAD_START_AT,
    endAt: R7_RELEASE_WORKLOAD_END_AT,
    createdAt: R7_RELEASE_WORKLOAD_END_AT,
    secret: secret(),
    activityMarkers: [],
    ...extra,
  };
}

function memoryBackend() {
  let value = null;
  return {
    async read() { return value && Buffer.from(value); },
    async createIfMissing(_capability, candidate) {
      if (value) return "existing";
      value = Buffer.from(candidate);
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
  throw new Error("R7 release checkpoint fixture unexpectedly completed");
}

async function prepareInterruptedDiscard(fixture, workspaceDirectory) {
  await prepareIncompleteWorkspace(fixture, workspaceDirectory);
  const preview = await planLocalExportWorkspaceDiscard({ workspaceDirectory });
  const interruption = new Error("r7 release discard interruption");
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
  throw new Error("R7 release discard recovery fixture unexpectedly completed");
}

async function prepareInterruptedDeletion(
  fixture,
  workspaceDirectory,
  outputDirectory,
  maximumRecordsPerChunk,
) {
  await createLocalExportWorkspace(workspaceOptions(fixture, workspaceDirectory));
  await materializeLocalExportSet({
    workspaceDirectory,
    outputDirectory,
    secret: secret(),
    maximumRecordsPerChunk,
  });
  const preview = await planLocalExportDeletion({ workspaceDirectory, outputDirectory });
  const interruption = new Error("r7 release deletion interruption");
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
  throw new Error("R7 release deletion recovery fixture unexpectedly completed");
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
    throw new Error("R7 release callback capability fixture was invalid");
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

async function prepareInterruptedCallback(root) {
  const callback = await prepareCallbackFixture(root);
  const interruption = new Error("r7 release callback interruption");
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
  throw new Error("R7 release callback recovery fixture unexpectedly completed");
}

function expectedLogicalOutcomeProjection(parameters) {
  const manySmallSubagents = Math.ceil(parameters.smallFileCount / 3);
  const denseSubagents = Math.ceil(parameters.denseRecordCount / 11);
  return {
    recordCounts: {
      usageEvents: 11 + parameters.smallFileCount + parameters.denseRecordCount,
      quotaSnapshots: 14,
      activityMarkers: 0,
    },
    codex: {
      usageEvents: 3,
      rootLikeEvents: 2,
      subagentEvents: 1,
      componentRows: [
        [80, 40, 0, 21, 9],
        [55, 35, 0, 18, 7],
        [40, 15, 0, 11, 4],
      ],
    },
    claude: {
      usageEvents: 8 + parameters.smallFileCount + parameters.denseRecordCount,
      rootEvents: 7
        + parameters.smallFileCount - manySmallSubagents
        + parameters.denseRecordCount - denseSubagents,
      subagentEvents: 1 + manySmallSubagents + denseSubagents,
      unrecognizedModels: 2,
      fallbackComponentRows: [
        [3, 5, 7, 2, 5, 11],
        [11, 17, 13, 8, 5, 23],
      ],
    },
    quota: {
      codexSnapshots: 10,
      collectorSnapshots: 4,
      collectorAccountScoped: 2,
      collectorUnattributed: 2,
      collectorPrimary: 2,
      collectorSecondary: 2,
      claudeSnapshots: 4,
      claudeFiveHour: 2,
      claudeSevenDay: 2,
    },
  };
}

function logicalOutcomeProjection(records) {
  const codexUsage = records.usageEvents.filter((row) => row.provider === "openai_codex");
  const claudeUsage = records.usageEvents.filter(
    (row) => row.provider === "anthropic_claude_code",
  );
  const codexQuota = records.quotaSnapshots.filter((row) => row.provider === "openai_codex");
  const collectorQuota = codexQuota.filter((row) => row.snapshotSource === "app_server_read");
  const claudeQuota = records.quotaSnapshots.filter(
    (row) => row.provider === "anthropic_claude_code",
  );
  const codexComponentRows = codexUsage.map((row) => [
    row.components.inputUncachedTokens,
    row.components.inputCacheReadTokens,
    row.components.inputCacheWriteTokens,
    row.components.outputTextTokens,
    row.components.outputReasoningTokens,
  ]).sort((left, right) => right[0] - left[0]);
  const fallbackComponentRows = claudeUsage
    .filter((row) => [11, 23].includes(row.components.outputCombinedTokens))
    .map((row) => [
      row.components.inputUncachedTokens,
      row.components.inputCacheReadTokens,
      row.components.inputCacheWriteTokens,
      row.components.inputCacheWrite5mTokens,
      row.components.inputCacheWrite1hTokens,
      row.components.outputCombinedTokens,
    ])
    .sort((left, right) => left[5] - right[5]);
  return {
    recordCounts: {
      usageEvents: records.usageEvents.length,
      quotaSnapshots: records.quotaSnapshots.length,
      activityMarkers: records.activityMarkers.length,
    },
    codex: {
      usageEvents: codexUsage.length,
      rootLikeEvents: codexUsage.filter(
        (row) => row.surface === "local_rollout_unclassified" && row.agentScope === "unknown",
      ).length,
      subagentEvents: codexUsage.filter(
        (row) => row.surface === "subagent" && row.agentScope === "subagent",
      ).length,
      componentRows: codexComponentRows,
    },
    claude: {
      usageEvents: claudeUsage.length,
      rootEvents: claudeUsage.filter((row) => row.agentScope === "root").length,
      subagentEvents: claudeUsage.filter((row) => row.agentScope === "subagent").length,
      unrecognizedModels: claudeUsage.filter(
        (row) => row.modelId === "unknown" && row.modelRecognition === "unrecognized",
      ).length,
      fallbackComponentRows,
    },
    quota: {
      codexSnapshots: codexQuota.length,
      collectorSnapshots: collectorQuota.length,
      collectorAccountScoped: collectorQuota.filter(
        (row) => row.accountScopeId !== "unattributed",
      ).length,
      collectorUnattributed: collectorQuota.filter(
        (row) => row.accountScopeId === "unattributed",
      ).length,
      collectorPrimary: collectorQuota.filter((row) => row.slot === "primary").length,
      collectorSecondary: collectorQuota.filter((row) => row.slot === "secondary").length,
      claudeSnapshots: claudeQuota.length,
      claudeFiveHour: claudeQuota.filter((row) => row.slot === "five_hour").length,
      claudeSevenDay: claudeQuota.filter((row) => row.slot === "seven_day").length,
    },
  };
}

async function inspectExportedLogicalOutcomes(outputDirectory, parameters) {
  const manifest = JSON.parse(await readFile(
    join(outputDirectory, EXPORT_SET_MANIFEST_BASENAME),
    "utf8",
  ));
  const records = { usageEvents: [], quotaSnapshots: [], activityMarkers: [] };
  for (const chunk of manifest.chunks) {
    const names = exportSetChunkBasenames(chunk.index);
    const artifactBytes = await readFile(join(outputDirectory, names.bundle));
    const bundleBytes = decompressExportBytes(artifactBytes, {
      maximumEncodedBytes: chunk.artifactBytes,
      maximumDecodedBytes: chunk.bundleBytes,
    });
    const receiptBytes = await readFile(join(outputDirectory, names.receipt));
    const verified = loadVerifiedLocalMetadataBundleBytes({ bundleBytes, receiptBytes });
    for (const family of Object.keys(records)) {
      records[family].push(...verified.bundle.records[family]);
    }
  }
  const actual = logicalOutcomeProjection(records);
  const expected = expectedLogicalOutcomeProjection(parameters);
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error("R7 release exported logical outcomes changed");
  }
  return {
    projectionSha256: sha256(stableJson(actual)),
    cases: {
      codexRoot: actual.codex.rootLikeEvents === 2,
      codexForkReplay: actual.codex.usageEvents === 3,
      codexSubagentDelta: actual.codex.subagentEvents === 1,
      accountScoped: actual.quota.collectorAccountScoped === 2,
      accountUnattributed: actual.quota.collectorUnattributed === 2,
      codexPrimaryWindow: actual.quota.collectorPrimary === 2,
      codexSecondaryWindow: actual.quota.collectorSecondary === 2,
      claudeRoot: actual.claude.rootEvents > 0,
      claudeSubagent: actual.claude.subagentEvents > 0,
      claudeFallbackIteration: actual.claude.fallbackComponentRows.length === 2,
      claudeUnknownModel: actual.claude.unrecognizedModels === 2,
      claudeFiveHourPresent: actual.quota.claudeFiveHour === 2,
      claudeFiveHourAbsent: actual.quota.claudeFiveHour < 4,
      claudeSevenDayPresent: actual.quota.claudeSevenDay === 2,
      claudeSevenDayAbsent: actual.quota.claudeSevenDay < 4,
    },
  };
}

function deterministicOperationProjection(operation) {
  const {
    durableElapsedMs: _durableElapsedMs,
    durablePeakRssBytes: _durablePeakRssBytes,
    ...evidence
  } = operation.evidence;
  return {
    operation: operation.operation,
    status: operation.status,
    failureCode: operation.failureCode,
    evidence,
  };
}

function aggregateOperation(operation, filesystem) {
  return {
    name: operation.operation,
    status: operation.status,
    failureCode: operation.failureCode,
    wallTimeMs: Math.ceil(operation.wallTimeMicros / 1_000),
    parentElapsedMs: operation.parentElapsedMs,
    cpuTimeMs: Math.ceil((operation.cpuUserMicros + operation.cpuSystemMicros) / 1_000),
    peakRssBytes: Math.max(
      operation.peakRssBytes,
      operation.externalPeakRssBytes,
      operation.evidence.durablePeakRssBytes ?? 0,
    ),
    rssSampleCount: operation.rssSampleCount,
    rssSampleFailureCount: operation.rssSampleFailureCount,
    externalPeakRssBytes: operation.externalPeakRssBytes,
    childMaxRssBytes: operation.peakRssBytes,
    stdoutBytes: operation.watchdogStdoutBytes,
    stderrBytes: operation.watchdogStderrBytes,
    directoryEntries: operation.evidence.directoryEntries,
    sourceFiles: operation.evidence.sourceFiles,
    sourceBytes: operation.evidence.sourceBytes,
    physicalLines: operation.evidence.physicalLines,
    outputRecords: operation.evidence.outputRecords,
    expandedRecordBytes: operation.evidence.expandedRecordBytes,
    decodedBytes: operation.evidence.decodedArtifactBytes,
    encodedBytes: operation.evidence.encodedArtifactBytes,
    workspaceHighWaterBytes: operation.evidence.workspaceHighWaterBytes,
    manifestBytes: operation.evidence.manifestBytes,
    chunks: operation.evidence.chunkCount,
    affectedFiles: operation.evidence.affectedFiles,
    affectedBytes: operation.evidence.affectedBytes,
    durableElapsedMs: operation.evidence.durableElapsedMs,
    durablePeakRssBytes: operation.evidence.durablePeakRssBytes,
    evidenceSha256: operation.evidence.operationEvidenceSha256,
    filesystem: {
      beforeBytes: filesystem.measurements.before.bytes,
      sampledHighWaterBytes: filesystem.measurements.highWater.bytes,
      afterBytes: filesystem.measurements.after.bytes,
    },
  };
}

function requireCompleted(operation) {
  if (operation.status !== "completed") {
    throw new Error(`R7 release synthetic operation failed: ${operation.operation}`);
  }
  return operation;
}

async function runMeasuredWorker(root, config, timeoutMs) {
  let operation = null;
  const filesystem = await runR7FilesystemHighWaterSampler({
    root,
    maximumElapsedMs: timeoutMs,
    allowedTransientSymlinkNames: [".app-usagemonitor-export.lock"],
    allowTransientOwnedHardlinks: true,
    async operation() {
      operation = await runR7BenchmarkWorker(config, { timeoutMs });
    },
  });
  if (filesystem.outcome !== "completed") {
    throw new Error(`R7 release synthetic filesystem sampling stopped: ${filesystem.outcome}`);
  }
  return {
    operation: requireCompleted(operation),
    filesystem,
  };
}

async function runPass(root, fixture, fixtureManifest, configuration, timeoutMs) {
  await mkdir(root, { mode: 0o700 });
  const workspaceDirectory = join(root, "workspace");
  const outputDirectory = join(root, "output");
  const resumeWorkspace = join(root, "workspace-resume");
  const discardWorkspace = join(root, "workspace-discard");
  const discardRecoveryWorkspace = join(root, "workspace-discard-recovery");
  const deletionRecoveryWorkspace = join(root, "workspace-delete-recovery");
  const deletionRecoveryOutput = join(root, "output-delete-recovery");
  const identityStateFile = join(root, "synthetic-identity-state.bin");
  const independentOutputFile = join(root, "synthetic-independent-output.bin");
  await writeFile(identityStateFile, Buffer.alloc(64, 0x75), { mode: 0o600 });
  await writeFile(independentOutputFile, Buffer.alloc(96, 0x76), { mode: 0o600 });
  const identityStateSha256 = sha256(await readFile(identityStateFile));
  const independentOutputSha256 = sha256(await readFile(independentOutputFile));
  const measured = [];
  measured.push(await runMeasuredWorker(root, workerConfig("source_scan", fixture, {
    workspaceDirectory,
  }), timeoutMs));
  await prepareIncompleteWorkspace(fixture, resumeWorkspace);
  measured.push(await runMeasuredWorker(root, workerConfig("checkpoint_resume", fixture, {
    workspaceDirectory: resumeWorkspace,
  }), timeoutMs));
  const outputRecords = measured[0].operation.evidence.outputRecords;
  const maximumRecordsPerChunk = Math.max(
    1,
    Math.ceil(outputRecords / configuration.targetChunks),
  );
  measured.push(await runMeasuredWorker(root, workerConfig("export_set_materialize", fixture, {
    workspaceDirectory,
    outputDirectory,
    maximumRecordsPerChunk,
  }), timeoutMs));
  measured.push(await runMeasuredWorker(root, workerConfig("export_set_verify", fixture, {
    outputDirectory,
    verificationTemporaryRoot: root,
  }), timeoutMs));
  const semanticOutcomes = await inspectExportedLogicalOutcomes(
    outputDirectory,
    fixtureManifest.parameters,
  );

  await prepareIncompleteWorkspace(fixture, discardWorkspace);
  measured.push(await runMeasuredWorker(root, workerConfig("workspace_discard", fixture, {
    workspaceDirectory: discardWorkspace,
  }), timeoutMs));

  await prepareInterruptedDiscard(fixture, discardRecoveryWorkspace);
  measured.push(await runMeasuredWorker(root, workerConfig("workspace_discard_recovery", fixture, {
    workspaceDirectory: discardRecoveryWorkspace,
  }), timeoutMs));

  const callback = await prepareCallbackFixture(join(root, "callback"));
  measured.push(await runMeasuredWorker(root, workerConfig("claude_callback_uninstall", fixture, {
    settingsFile: callback.settingsFile,
    lifecycleDirectory: callback.lifecycleDirectory,
    installedStatusLine: callback.installedStatusLine,
  }), timeoutMs));

  const recoveryCallback = await prepareInterruptedCallback(join(root, "callback-recovery"));
  measured.push(await runMeasuredWorker(root, workerConfig("claude_callback_recovery", fixture, {
    settingsFile: recoveryCallback.settingsFile,
    lifecycleDirectory: recoveryCallback.lifecycleDirectory,
    installedStatusLine: recoveryCallback.installedStatusLine,
  }), timeoutMs));

  await prepareInterruptedDeletion(
    fixture,
    deletionRecoveryWorkspace,
    deletionRecoveryOutput,
    maximumRecordsPerChunk,
  );
  measured.push(await runMeasuredWorker(root, workerConfig("complete_set_delete_recovery", fixture, {
    workspaceDirectory: deletionRecoveryWorkspace,
    outputDirectory: deletionRecoveryOutput,
  }), timeoutMs));

  measured.push(await runMeasuredWorker(root, workerConfig("complete_set_delete", fixture, {
    workspaceDirectory,
    outputDirectory,
  }), timeoutMs));
  const operations = measured.map((value) => value.operation);
  const operationNames = new Set(operations.map((operation) => operation.operation));
  if (operations.length !== R7_RELEASE_EVIDENCE_OPERATION_NAMES.length
      || operationNames.size !== R7_RELEASE_EVIDENCE_OPERATION_NAMES.length
      || R7_RELEASE_EVIDENCE_OPERATION_NAMES.some((name) => !operationNames.has(name))) {
    throw new Error("R7 release synthetic lifecycle operation coverage was incomplete");
  }
  const producedChunks = operations.find(
    (operation) => operation.operation === "export_set_materialize",
  ).evidence.chunkCount;
  if (configuration.requireExactTargetChunks
      && producedChunks !== configuration.targetChunks) {
    throw new Error("R7 release pressure chunk target was not materialized exactly");
  }
  const inspected = await inspectR7ReleaseWorkloadFixture(fixture, fixtureManifest.parameters);
  if (stableJson(inspected) !== stableJson(fixtureManifest)) {
    throw new Error("R7 release synthetic source fixture changed");
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
  const independentOutputPreserved = sha256(await readFile(independentOutputFile))
    === independentOutputSha256;
  if (!identityStatePreserved || !independentOutputPreserved || !callbackSettingsPreserved) {
    throw new Error("R7 release lifecycle changed protected synthetic state");
  }
  const preservation = {
    sourceLogsPreserved: true,
    identityStatePreserved,
    independentOutputPreserved,
    callbackSettingsPreserved,
  };
  const projection = {
    fixtureManifestSha256: fixtureManifest.manifestSha256,
    operations: operations.map(deterministicOperationProjection),
    semanticOutcomes,
    preservation,
  };
  const byName = new Map(operations.map((operation) => [operation.operation, operation]));
  const cleanupInventory = await inventoryR7OwnedTree(root);
  const comparisonHashes = {
    fixtureManifest: fixtureManifest.manifestSha256,
    sourcePlan: byName.get("source_scan").evidence.sourcePlanSha256,
    logicalRecords: byName.get("export_set_materialize").evidence.logicalRecordsSha256,
    chunkBoundaries: byName.get("export_set_materialize").evidence.chunkBoundariesSha256,
    canonicalArtifacts: byName.get("export_set_materialize").evidence.canonicalArtifactsSha256,
    verifierResults: byName.get("export_set_verify").evidence.operationEvidenceSha256,
    fixedFailureCodes: sha256(stableJson(operations.map(({ operation, status, failureCode }) => ({
      operation,
      status,
      failureCode,
    })))),
    cleanupInventories: cleanupInventory.deterministicProjectionSha256,
    preservationResults: sha256(stableJson(preservation)),
    lifecycleProjection: sha256(stableJson(projection)),
  };
  return {
    operations: measured.map(({ operation, filesystem }) => (
      aggregateOperation(operation, filesystem)
    )),
    maximumRecordsPerChunk,
    producedChunks,
    semanticOutcomes,
    preservation,
    deterministicProjectionSha256: comparisonHashes.lifecycleProjection,
    comparisonHashes,
  };
}

function comparisons(first, second) {
  return Object.fromEntries(Object.keys(first).map((key) => [
    key,
    first[key] === second[key] ? "matched" : "mismatched",
  ]));
}

function assertContentFree(value) {
  const serialized = stableJson(value);
  for (const prohibited of [
    "R7_RELEASE_SYNTHETIC_CONTENT_NEVER_EXPORT",
    "sessionId",
    "eventId",
    "accountPseudonym",
    "modelFingerprint",
    "/Users/",
    "/var/",
    "/tmp/",
  ]) {
    if (serialized.includes(prohibited)) {
      throw new Error("R7 release synthetic evidence privacy scan failed");
    }
  }
}

export async function runR7ReleaseSyntheticEvidence({
  profile,
  temporaryRoot = tmpdir(),
  timeoutMs = 10 * 60 * 1_000,
} = {}) {
  const configuration = PROFILE_CONFIGURATION[profile];
  if (!configuration) throw new TypeError("R7 release synthetic profile is unsupported");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60 * 1_000) {
    throw new TypeError("R7 release synthetic timeout is outside its fixed range");
  }
  const rawRoot = await mkdtemp(join(temporaryRoot, "usage-monitor-r7-release-"));
  await chmod(rawRoot, 0o700);
  const root = await realpath(rawRoot);
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("R7 release synthetic root was unsafe");
  }
  const rootIdentity = { dev: rootStats.dev, ino: rootStats.ino };
  const fixture = join(root, "source");
  let evidence;
  try {
    await mkdir(fixture, { mode: 0o700 });
    const fixtureManifest = await createR7ReleaseWorkloadFixture(
      fixture,
      configuration.parameters,
    );
    const first = await runPass(
      join(root, "pass-1"),
      fixture,
      fixtureManifest,
      configuration,
      timeoutMs,
    );
    const second = await runPass(
      join(root, "pass-2"),
      fixture,
      fixtureManifest,
      configuration,
      timeoutMs,
    );
    evidence = {
      version: R7_RELEASE_SYNTHETIC_EVIDENCE_VERSION,
      profile,
      fixtureVersion: fixtureManifest.fixtureVersion,
      fixtureManifestSha256: fixtureManifest.manifestSha256,
      parameters: fixtureManifest.parameters,
      coverage: fixtureManifest.coverage,
      totals: fixtureManifest.totals,
      passes: [first, second],
      determinism: {
        status: first.deterministicProjectionSha256 === second.deterministicProjectionSha256
          ? "passed" : "failed",
        runProjectionSha256es: [
          first.deterministicProjectionSha256,
          second.deterministicProjectionSha256,
        ],
        comparisons: comparisons(first.comparisonHashes, second.comparisonHashes),
      },
      semanticOutcomes: first.semanticOutcomes,
      sourceLogsPreserved: first.preservation.sourceLogsPreserved
        && second.preservation.sourceLogsPreserved,
      identityStatePreserved: first.preservation.identityStatePreserved
        && second.preservation.identityStatePreserved,
      independentOutputPreserved: first.preservation.independentOutputPreserved
        && second.preservation.independentOutputPreserved,
      callbackSettingsPreserved: first.preservation.callbackSettingsPreserved
        && second.preservation.callbackSettingsPreserved,
      networkActivity: "not_measured",
      transportReady: false,
      secureErasureClaimed: false,
      prohibitedDataScan: true,
    };
    if (evidence.determinism.status !== "passed") {
      throw new Error("R7 release synthetic deterministic projections differed");
    }
    assertContentFree(evidence);
  } finally {
    const inventory = await inventoryR7OwnedTree(root);
    const cleanup = await cleanupR7OwnedTree(root, inventory, rootIdentity);
    if (evidence) evidence.cleanup = cleanup;
  }
  assertContentFree(evidence);
  return evidence;
}

const ZERO_RELEASE_OPERATION_METRICS = Object.freeze({
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

function maximum(first, second, key) {
  return Math.max(first[key], second[key]);
}

function releaseOperation(name, first, second) {
  if (!first || !second) {
    return {
      name,
      status: "not_run",
      failureCode: "not_run_profile",
      projectionSha256: "not_run",
      metrics: structuredClone(ZERO_RELEASE_OPERATION_METRICS),
    };
  }
  if (first.evidenceSha256 !== second.evidenceSha256) {
    throw new Error("R7 release synthetic operation projections differed");
  }
  const recovered = name.endsWith("_recovery");
  return {
    name,
    status: recovered ? "interrupted_recovered" : "completed",
    failureCode: recovered ? "interruption_injected" : "none",
    projectionSha256: first.evidenceSha256,
    metrics: {
      runCount: 2,
      parentElapsedMs: maximum(first, second, "parentElapsedMs"),
      childCpuMs: maximum(first, second, "cpuTimeMs"),
      externalRssSampleCount: first.rssSampleCount + second.rssSampleCount,
      externalRssSampleFailureCount: first.rssSampleFailureCount + second.rssSampleFailureCount,
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
    plusOne: { value: selectedLimit + 1, status: "not_run", failureCode: "not_run_profile" },
    producer: { status: "not_run", failureCode: "not_run_profile" },
    verifier: { status: "not_run", failureCode: "not_run_profile" },
    identification: "not_run",
  };
}

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

function semanticProfileEvidence(evidence) {
  const cases = evidence.semanticOutcomes?.cases;
  if (!cases || Object.values(cases).some((value) => value !== true)) {
    throw new Error("R7 release semantic cases were not proven by exported outcomes");
  }
  return {
    kind: evidence.profile,
    fixtureManifestSha256: evidence.fixtureManifestSha256,
    cases: structuredClone(cases),
  };
}

function pressureProfileEvidence(evidence) {
  if (evidence.totals.files !== 4_096
      || evidence.coverage.totalSourceFiles !== 4_096
      || evidence.coverage.longLineCases !== 2
      || evidence.coverage.longLineBytes !== 64 * 1024
      || evidence.coverage.longLinePlusOneBytes !== (64 * 1024) + 1
      || evidence.parameters.compressiblePayloadBytes !== 8 * 1024 * 1024
      || evidence.parameters.incompressiblePayloadBytes !== 8 * 1024 * 1024
      || evidence.passes.some((pass) => pass.producedChunks !== 128)) {
    throw new Error("R7 release pressure claims were not materialized exactly");
  }
  return {
    kind: evidence.profile,
    fixtureManifestSha256: evidence.fixtureManifestSha256,
    seed: evidence.parameters.seed,
    manySmallSourceFiles: evidence.totals.files,
    denseRecords: evidence.parameters.denseRecordCount,
    targetChunks: 128,
    longLineBytes: evidence.parameters.longLineBytes,
    longLinePlusOneBytes: evidence.coverage.longLinePlusOneBytes,
    compressiblePayloadBytes: evidence.parameters.compressiblePayloadBytes,
    incompressiblePayloadBytes: evidence.parameters.incompressiblePayloadBytes,
  };
}

export async function buildR7ReleaseSyntheticReceipt(evidence) {
  if (!evidence || !PROFILE_CONFIGURATION[evidence.profile]) {
    throw new TypeError("R7 release synthetic evidence is invalid");
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("R7 release receipts are qualified only for macOS arm64");
  }
  const first = new Map(evidence.passes[0].operations.map((row) => [row.name, row]));
  const second = new Map(evidence.passes[1].operations.map((row) => [row.name, row]));
  const version = runtimeVersion();
  const receipt = {
    schemaVersion: R7_RELEASE_EVIDENCE_RECEIPT_VERSION,
    protocolVersion: R7_RELEASE_EVIDENCE_PROTOCOL_VERSION,
    policyVersion: R7_RELEASE_EVIDENCE_POLICY_VERSION,
    selectionRuleVersion: R7_RELEASE_EVIDENCE_SELECTION_RULE_VERSION,
    profile: evidence.profile,
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
    operations: R7_RELEASE_EVIDENCE_OPERATION_NAMES.map((name) => (
      releaseOperation(name, first.get(name), second.get(name))
    )),
    boundaries: R7_RELEASE_EVIDENCE_DIMENSIONS.map(notRunBoundary),
    determinism: {
      projectionVersion: R7_RELEASE_EVIDENCE_DETERMINISTIC_PROJECTION_VERSION,
      status: evidence.determinism.status,
      runCount: 2,
      runProjectionSha256es: evidence.determinism.runProjectionSha256es,
      comparisons: evidence.determinism.comparisons,
    },
    preservation: {
      sourceLogsPreserved: evidence.sourceLogsPreserved,
      identityStatePreserved: evidence.identityStatePreserved,
      independentOutputPreserved: evidence.independentOutputPreserved,
      callbackSettingsPreserved: evidence.callbackSettingsPreserved,
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
    profileEvidence: evidence.profile === "release_synthetic_semantics"
      ? semanticProfileEvidence(evidence) : pressureProfileEvidence(evidence),
    receiptSha256: "0".repeat(64),
  };
  assertContentFree(receipt);
  receipt.receiptSha256 = computeR7ReleaseEvidenceReceiptSha256(receipt);
  return assertValidR7ReleaseEvidenceReceipt(receipt);
}

export async function runR7ReleaseSyntheticBenchmark(options) {
  const evidence = await runR7ReleaseSyntheticEvidence(options);
  return buildR7ReleaseSyntheticReceipt(evidence);
}
