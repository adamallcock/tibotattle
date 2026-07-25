#!/usr/bin/env node
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createLocalExportWorkspace, resumeLocalExportWorkspace } from "../src/export-set-controller.js";
import { materializeLocalExportSet } from "../src/export-set-materializer.js";
import { verifyLocalExportSet } from "../src/export-set-verifier.js";
import { planLocalExportDeletion } from "../src/export-deletion.js";
import { deleteLocalExport, recoverLocalExportDeletion } from "../src/export-deletion-executor.js";
import { planLocalExportWorkspaceDiscard } from "../src/export-workspace-discard.js";
import {
  discardLocalExportWorkspace,
  recoverLocalExportWorkspaceDiscard,
} from "../src/export-workspace-discard-executor.js";
import {
  recoverClaudeCallbackLifecycle,
  uninstallClaudeCallback,
} from "../src/claude-callback-lifecycle.js";
import { stableJson } from "../src/storage.js";

const OPERATIONS = new Set([
  "source_scan",
  "checkpoint_resume",
  "export_set_materialize",
  "export_set_verify",
  "complete_set_delete",
  "complete_set_delete_recovery",
  "workspace_discard",
  "workspace_discard_recovery",
  "claude_callback_uninstall",
  "claude_callback_recovery",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function emptyEvidence() {
  return {
    sourceFiles: 0,
    sourceBytes: 0,
    directoryEntries: 0,
    physicalLines: 0,
    outputRecords: 0,
    expandedRecordBytes: 0,
    workspaceHighWaterBytes: 0,
    decodedArtifactBytes: 0,
    encodedArtifactBytes: 0,
    manifestBytes: 0,
    chunkCount: 0,
    affectedFiles: 0,
    affectedBytes: 0,
    durableElapsedMs: 0,
    durablePeakRssBytes: 0,
    sourcePlanSha256: null,
    logicalRecordsSha256: null,
    chunkBoundariesSha256: null,
    canonicalArtifactsSha256: null,
    operationEvidenceSha256: null,
    sourceLogsPreserved: null,
    identityStatePreserved: null,
    independentOutputPreserved: null,
  };
}

function resourceEvidence(resourceUsage, base = {}) {
  const counters = resourceUsage?.counters ?? {};
  return {
    ...emptyEvidence(),
    sourceFiles: safeInteger(counters.sourceFiles),
    sourceBytes: safeInteger(counters.sourceBytes),
    directoryEntries: safeInteger(counters.directoryEntries),
    physicalLines: safeInteger(counters.lines),
    outputRecords: safeInteger(counters.outputRecords),
    expandedRecordBytes: safeInteger(counters.expandedRecordBytes),
    workspaceHighWaterBytes: safeInteger(resourceUsage?.workspaceHighWaterBytes),
    decodedArtifactBytes: safeInteger(counters.exportSetDecodedBytes),
    encodedArtifactBytes: safeInteger(counters.exportSetEncodedBytes),
    manifestBytes: safeInteger(counters.manifestBytes),
    chunkCount: safeInteger(base.chunkCount),
    durableElapsedMs: safeInteger(resourceUsage?.cumulativeElapsedMs),
    durablePeakRssBytes: safeInteger(resourceUsage?.peakRssBytes),
    sourcePlanSha256: base.sourcePlanSha256 ?? null,
    logicalRecordsSha256: base.logicalRecordsSha256 ?? null,
    chunkBoundariesSha256: base.chunkBoundariesSha256 ?? null,
    canonicalArtifactsSha256: base.canonicalArtifactsSha256 ?? null,
    operationEvidenceSha256: base.operationEvidenceSha256 ?? null,
    sourceLogsPreserved: base.sourceLogsPreserved ?? null,
    identityStatePreserved: base.identityStatePreserved ?? null,
    independentOutputPreserved: base.independentOutputPreserved ?? null,
  };
}

function workspaceOptions(config, secret) {
  return {
    directory: config.workspaceDirectory,
    codexHome: config.codexHome,
    secret,
    activityMarkers: [],
    resourceLimits: config.resourceLimits ?? {},
    collectorPath: config.collectorPath,
    claudeStateDirectory: config.claudeStateDirectory,
    claudeProjectsDirectory: config.claudeProjectsDirectory,
  };
}

async function perform(config, secret) {
  if (config.operation === "source_scan") {
    const value = await createLocalExportWorkspace({
      ...workspaceOptions(config, secret),
      startAt: config.startAt,
      endAt: config.endAt,
      createdAt: config.createdAt,
    });
    return resourceEvidence(value.resourceUsage, {
      sourcePlanSha256: sha256(stableJson({
        codex: value.descriptor.sourcePlan.sourcePlanSha256,
        supplemental: value.descriptor.supplementalSourcePlan.sourcePlanSha256,
      })),
      operationEvidenceSha256: sha256(stableJson({
        recordCounts: value.status.recordCounts,
        scanComplete: value.status.scanComplete,
        sourceProviders: value.descriptor.sourceProviders,
      })),
    });
  }
  if (config.operation === "checkpoint_resume") {
    const value = await resumeLocalExportWorkspace(workspaceOptions(config, secret));
    return resourceEvidence(value.resourceUsage, {
      sourcePlanSha256: sha256(stableJson({
        codex: value.descriptor.sourcePlan.sourcePlanSha256,
        supplemental: value.descriptor.supplementalSourcePlan.sourcePlanSha256,
      })),
      operationEvidenceSha256: sha256(stableJson({
        recordCounts: value.status.recordCounts,
        scanComplete: value.status.scanComplete,
        sourceProviders: value.descriptor.sourceProviders,
      })),
    });
  }
  if (config.operation === "export_set_materialize") {
    const value = await materializeLocalExportSet({
      workspaceDirectory: config.workspaceDirectory,
      outputDirectory: config.outputDirectory,
      secret,
      maximumRecordsPerChunk: config.maximumRecordsPerChunk,
    });
    const manifest = value.manifest;
    return resourceEvidence(value.resourceUsage, {
      chunkCount: manifest.chunks.length,
      logicalRecordsSha256: manifest.totals.logicalRecordsSha256,
      chunkBoundariesSha256: sha256(stableJson(manifest.chunks.map((chunk) => ({
        index: chunk.index,
        recordCounts: chunk.recordCounts,
      })))),
      canonicalArtifactsSha256: sha256(stableJson(manifest.chunks.map((chunk) => ({
        index: chunk.index,
        bundleSha256: chunk.bundleSha256,
        artifactSha256: chunk.artifactSha256 ?? null,
        receiptSha256: chunk.receiptSha256,
      })))),
      operationEvidenceSha256: sha256(stableJson({
        schemaVersion: manifest.schemaVersion,
        recordCounts: manifest.totals.recordCounts,
        decodedBundleBytes: manifest.totals.decodedBundleBytes ?? manifest.totals.bundleBytes,
        encodedArtifactBytes: manifest.totals.encodedArtifactBytes ?? 0,
        receiptBytes: manifest.totals.receiptBytes,
        logicalRecordsSha256: manifest.totals.logicalRecordsSha256,
        chunks: manifest.chunks.map((chunk) => ({
          index: chunk.index,
          recordCounts: chunk.recordCounts,
          bundleSha256: chunk.bundleSha256,
          artifactSha256: chunk.artifactSha256 ?? null,
          receiptSha256: chunk.receiptSha256,
        })),
      })),
    });
  }
  if (config.operation === "export_set_verify") {
    const value = await verifyLocalExportSet({ directory: config.outputDirectory });
    return {
      ...emptyEvidence(),
      outputRecords: Object.values(value.recordCounts).reduce((sum, count) => sum + count, 0),
      decodedArtifactBytes: value.decodedBundleBytes,
      encodedArtifactBytes: value.encodedArtifactBytes,
      chunkCount: value.chunkCount,
      operationEvidenceSha256: sha256(stableJson(value)),
    };
  }
  if (config.operation === "complete_set_delete") {
    const preview = await planLocalExportDeletion({
      workspaceDirectory: config.workspaceDirectory,
      outputDirectory: config.outputDirectory,
    });
    const receipt = await deleteLocalExport({
      workspaceDirectory: config.workspaceDirectory,
      outputDirectory: config.outputDirectory,
      confirmationToken: preview.confirmationToken,
    });
    return {
      ...emptyEvidence(),
      operationEvidenceSha256: sha256(stableJson(receipt)),
      affectedFiles: receipt.deletedFileCount,
      affectedBytes: receipt.deletedBytes,
      sourceLogsPreserved: receipt.sourceLogsPreserved,
      identityStatePreserved: receipt.identityStatePreserved,
      independentOutputPreserved: true,
    };
  }
  if (config.operation === "workspace_discard") {
    const preview = await planLocalExportWorkspaceDiscard({ workspaceDirectory: config.workspaceDirectory });
    const receipt = await discardLocalExportWorkspace({
      workspaceDirectory: config.workspaceDirectory,
      confirmationToken: preview.confirmationToken,
    });
    return {
      ...emptyEvidence(),
      operationEvidenceSha256: sha256(stableJson(receipt)),
      affectedFiles: receipt.deletedFileCount,
      affectedBytes: receipt.deletedBytes,
      sourceLogsPreserved: receipt.sourceLogsPreserved,
      identityStatePreserved: receipt.identityStatePreserved,
      independentOutputPreserved: receipt.independentOutputPreserved,
    };
  }
  if (config.operation === "complete_set_delete_recovery") {
    const receipt = await recoverLocalExportDeletion({
      workspaceDirectory: config.workspaceDirectory,
      outputDirectory: config.outputDirectory,
    });
    return {
      ...emptyEvidence(),
      operationEvidenceSha256: sha256(stableJson(receipt)),
      affectedFiles: receipt.deletedFileCount,
      affectedBytes: receipt.deletedBytes,
      sourceLogsPreserved: receipt.sourceLogsPreserved,
      identityStatePreserved: receipt.identityStatePreserved,
      independentOutputPreserved: true,
    };
  }
  if (config.operation === "workspace_discard_recovery") {
    const receipt = await recoverLocalExportWorkspaceDiscard({
      workspaceDirectory: config.workspaceDirectory,
    });
    return {
      ...emptyEvidence(),
      operationEvidenceSha256: sha256(stableJson(receipt)),
      affectedFiles: receipt.deletedFileCount,
      affectedBytes: receipt.deletedBytes,
      sourceLogsPreserved: receipt.sourceLogsPreserved,
      identityStatePreserved: receipt.identityStatePreserved,
      independentOutputPreserved: receipt.independentOutputPreserved,
    };
  }
  if (config.operation === "claude_callback_uninstall") {
    const value = await uninstallClaudeCallback({
      settingsFile: config.settingsFile,
      lifecycleDirectory: config.lifecycleDirectory,
      installedStatusLine: config.installedStatusLine,
    });
    return {
      ...emptyEvidence(),
      operationEvidenceSha256: sha256(stableJson(value)),
      sourceLogsPreserved: true,
      identityStatePreserved: value.capabilityPreserved,
      independentOutputPreserved: true,
    };
  }
  if (config.operation === "claude_callback_recovery") {
    const value = await recoverClaudeCallbackLifecycle({
      settingsFile: config.settingsFile,
      lifecycleDirectory: config.lifecycleDirectory,
      installedStatusLine: config.installedStatusLine,
    });
    return {
      ...emptyEvidence(),
      operationEvidenceSha256: sha256(stableJson(value)),
      sourceLogsPreserved: true,
      identityStatePreserved: true,
      independentOutputPreserved: true,
    };
  }
  throw new TypeError("Unknown benchmark operation");
}

function normalizedPeakRssBytes() {
  const maxRssKiB = process.resourceUsage().maxRSS;
  return Number.isFinite(maxRssKiB) && maxRssKiB >= 0 ? Math.ceil(maxRssKiB * 1024) : 0;
}

export async function runR7WorkerOperation(config) {
  if (!config || typeof config !== "object" || !OPERATIONS.has(config.operation)
      || typeof config.secretHex !== "string" || !/^[0-9a-f]{64}$/.test(config.secretHex)) {
    throw new TypeError("Invalid benchmark worker configuration");
  }
  const secret = Buffer.from(config.secretHex, "hex");
  const startedAt = process.hrtime.bigint();
  const cpuStart = process.cpuUsage();
  try {
    const evidence = await perform(config, secret);
    const cpu = process.cpuUsage(cpuStart);
    const wallTimeMicros = Number((process.hrtime.bigint() - startedAt) / 1_000n);
    return {
      operation: config.operation,
      status: "completed",
      failureCode: null,
      wallTimeMicros: Math.max(0, wallTimeMicros),
      cpuUserMicros: safeInteger(cpu.user),
      cpuSystemMicros: safeInteger(cpu.system),
      peakRssBytes: normalizedPeakRssBytes(),
      evidence,
    };
  } catch {
    const cpu = process.cpuUsage(cpuStart);
    const wallTimeMicros = Number((process.hrtime.bigint() - startedAt) / 1_000n);
    return {
      operation: config.operation,
      status: "failed",
      failureCode: "operation_failed",
      wallTimeMicros: Math.max(0, wallTimeMicros),
      cpuUserMicros: safeInteger(cpu.user),
      cpuSystemMicros: safeInteger(cpu.system),
      peakRssBytes: normalizedPeakRssBytes(),
      evidence: emptyEvidence(),
    };
  } finally {
    secret.fill(0);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runR7WorkerOperation(await readStdin());
  process.stdout.write(stableJson(result));
}
