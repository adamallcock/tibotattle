#!/usr/bin/env node
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createLocalExportWorkspace, resumeLocalExportWorkspace } from "../src/export-set-controller.js";
import { BundleVerificationError } from "../src/bundle-verifier.js";
import { ClaudeCallbackLifecycleError } from "../src/claude-callback-lifecycle.js";
import { ExportSourcePlanError } from "../src/export-source-plan.js";
import { ExportSourcePlanBundleError } from "../src/export-source-plan-bundle.js";
import { CodexCollectorExportSourceError } from "../src/codex-collector-export-source.js";
import { ClaudeStatusLedgerExportSourceError } from "../src/claude-statusline-export-source.js";
import { ClaudeTranscriptExportSourceError } from "../src/claude-transcript-export-source.js";
import { materializeLocalExportSet } from "../src/export-set-materializer.js";
import { ExportCompressionError } from "../src/export-compression.js";
import { ExportDeletionError, planLocalExportDeletion } from "../src/export-deletion.js";
import {
  deleteLocalExport,
  ExportDeletionExecutionError,
  recoverLocalExportDeletion,
} from "../src/export-deletion-executor.js";
import { ExportResourceLimitError } from "../src/export-resource-policy.js";
import { ExportSetError } from "../src/export-set-materializer.js";
import { ExportSetVerificationError, verifyLocalExportSet } from "../src/export-set-verifier.js";
import { ExportWorkspaceDiscardError, planLocalExportWorkspaceDiscard } from "../src/export-workspace-discard.js";
import {
  discardLocalExportWorkspace,
  ExportWorkspaceDiscardExecutionError,
  recoverLocalExportWorkspaceDiscard,
} from "../src/export-workspace-discard-executor.js";
import { ExportWorkspaceLockError } from "../src/export-workspace-lock.js";
import { ExportWorkspaceError } from "../src/export-workspace.js";
import {
  recoverClaudeCallbackLifecycle,
  uninstallClaudeCallback,
} from "../src/claude-callback-lifecycle.js";
import { stableJson } from "../src/storage.js";
import {
  R7_WORKER_DEFAULT_MAXIMUM_STDIN_BYTES,
  R7_WORKER_MAXIMUM_STDIN_BYTES,
} from "../src/r7-worker-watchdog.js";

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

export function fixedOperationFailureCode(error) {
  if (error instanceof ExportSourcePlanError
      || error instanceof ExportSourcePlanBundleError
      || error instanceof CodexCollectorExportSourceError
      || error instanceof ClaudeStatusLedgerExportSourceError
      || error instanceof ClaudeTranscriptExportSourceError) {
    return "source_integrity";
  }
  const systemCode = typeof error?.code === "string" ? error.code : "";
  if (new Set(["EACCES", "EEXIST", "EIO", "EMFILE", "ENFILE", "ENOENT", "ENOSPC", "EPERM"])
    .has(systemCode)) {
    return `system_${systemCode.toLowerCase()}`;
  }
  const fixedErrors = [
    BundleVerificationError,
    ClaudeCallbackLifecycleError,
    ExportCompressionError,
    ExportDeletionError,
    ExportDeletionExecutionError,
    ExportResourceLimitError,
    ExportSetError,
    ExportSetVerificationError,
    ExportWorkspaceDiscardError,
    ExportWorkspaceDiscardExecutionError,
    ExportWorkspaceError,
    ExportWorkspaceLockError,
  ];
  if (fixedErrors.some((ErrorClass) => error instanceof ErrorClass)
      && typeof error.code === "string" && /^[a-z0-9_]+$/u.test(error.code)) {
    return error.code;
  }
  const message = typeof error?.message === "string" ? error.message : "";
  if (message === "Canonical chunk byte accounting mismatch") {
    return "internal_canonical_chunk_accounting";
  }
  if (message === "Generated export compatibility manifest is stale") {
    return "internal_compatibility_manifest_stale";
  }
  const privacyMatch = /^Privacy verification failed closed \(([^;)]*)(?:; sensitive=([a-z_+]+))?\)$/u
    .exec(message);
  if (privacyMatch) {
    const allowed = new Set([
      "schema_allowlist",
      "compatibility_tuple",
      "forbidden_key_scan",
      "sensitive_string_scan",
      "record_count_consistency",
      "provider_adapter_compatibility",
      "source_value_canaries",
    ]);
    const failed = privacyMatch[1].split(", ");
    if (failed.length >= 1 && failed.every((code) => allowed.has(code))) {
      const sensitiveAllowed = new Set([
        "email_address",
        "web_url",
        "file_url",
        "absolute_user_path",
        "windows_user_path",
        "private_key",
        "bearer_token",
        "common_api_key",
      ]);
      const sensitive = privacyMatch[2]?.split("+") ?? [];
      if (sensitive.every((code) => sensitiveAllowed.has(code))) {
        const suffix = sensitive.length > 0 ? `_sensitive_${sensitive.join("_and_")}` : "";
        return `internal_bundle_privacy_${failed.join("_and_")}${suffix}`;
      }
    }
    return "internal_bundle_privacy_validation";
  }
  if (message.startsWith("Privacy export-set manifest failed validation (")) {
    return "internal_export_set_manifest_validation";
  }
  if (/^Privacy export [a-zA-Z]+ failed schema validation \(/u.test(message)) {
    return "internal_export_record_schema_validation";
  }
  if (message === "Export-set chunk index must be a zero-based integer below 512"
      || message === "Unsupported export-set manifest version") {
    return "internal_export_set_chunk_index";
  }
  if (typeof error?.stack === "string" && error.stack.includes("/src/storage.js:")) {
    return "storage_publication_invariant";
  }
  return "operation_failed";
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
    frozenPlanSha256: null,
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
    frozenPlanSha256: base.frozenPlanSha256 ?? null,
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
  const options = {
    directory: config.workspaceDirectory,
    secret,
    activityMarkers: [],
    resourceLimits: config.resourceLimits ?? {},
  };
  if (config.sourcePlanBundle) return { ...options, sourcePlanBundle: config.sourcePlanBundle };
  return {
    ...options,
    codexHome: config.codexHome,
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
        supplemental: value.descriptor.supplementalSourcePlan.supplementalSourcePlanSha256,
      })),
      frozenPlanSha256: config.sourcePlanBundle?.sourcePlanBundleSha256 ?? null,
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
        supplemental: value.descriptor.supplementalSourcePlan.supplementalSourcePlanSha256,
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
    const value = await verifyLocalExportSet({
      directory: config.outputDirectory,
      verificationTemporaryRoot: config.verificationTemporaryRoot,
    });
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
  } catch (error) {
    const cpu = process.cpuUsage(cpuStart);
    const wallTimeMicros = Number((process.hrtime.bigint() - startedAt) / 1_000n);
    return {
      operation: config.operation,
      status: "failed",
      failureCode: fixedOperationFailureCode(error),
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
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > R7_WORKER_MAXIMUM_STDIN_BYTES) {
      throw new RangeError("R7 benchmark worker input exceeded its fixed byte limit");
    }
    chunks.push(chunk);
  }
  const config = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (bytes > R7_WORKER_DEFAULT_MAXIMUM_STDIN_BYTES
      && (config?.operation !== "source_scan" || !config?.sourcePlanBundle)) {
    throw new RangeError("R7 benchmark worker extended input was not a real source-plan scan");
  }
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runR7WorkerOperation(await readStdin());
  process.stdout.write(stableJson(result));
}
