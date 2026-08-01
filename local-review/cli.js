#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ClaudeCallbackCapabilityError,
  createClaudeCallbackCapabilityContext,
  createExportCompatibilityContext,
  createLocalExportArtifactStorageContext,
  createLocalExportDeletion,
  createLocalExportSourcePipelineContext,
  createLocalExportWorkspaceDiscard,
  createLocalExportSetMaterializationContext,
  createLocalExportSetVerificationContext,
  createLocalExportResourceContext,
  createLocalExportWorkspaceRuntimeContext,
  createLocalMetadataExportContext,
  createLocalMetadataBundleVerificationContext,
  selectProductionClaudeCallbackBackend,
  selectProductionParticipantIdentity,
} from "../src/application/local-review.js";
import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
  createClaudeCallbackLifecycleContext,
  createOwnerOnlyExportArtifactStorageContext,
  createOwnerOnlyExportDeletionPreflightInspector,
  createOwnerOnlyExportDeletionStorage,
  createOwnerOnlyExportWorkspaceLeaseContext,
  createOwnerOnlyExportWorkspaceStorageContext,
  createOwnerOnlyExportWorkspaceDiscardPreflight,
  createOwnerOnlyExportWorkspaceDiscardStorage,
  createExportIdentityKeychainBackend,
  createExportSetVerificationStorageContext,
  createLocalCodexLogPorts,
  createLocalExportSourcePorts,
  deriveAccountScopeId,
  deriveExportPseudonym,
  deriveEventOccurrenceId,
  deriveMarkerOccurrenceId,
  deriveModelFingerprint,
  deriveParticipantId,
  deriveQuotaStateId,
  deriveSessionScopeId,
  deriveSnapshotObservationId,
  defaultActivityMarkerFile,
  defaultExportSecretFile,
  inspectParticipantSecret,
  localIsProxy,
  readBoundedJsonLines,
  readBoundedDirectoryEntries,
  readExportCompatibilityArtifactSet,
  readOwnerOnlyLocalMetadataBundlePair,
  randomBundleId,
  rotateParticipantSecret,
  sha256Hex,
  withParticipantSecretLease,
} from "../src/platform/local-review.js";
import {
  installLocalReviewArtifact,
  planLocalReviewUninstall,
  uninstallLocalReviewArtifact,
  verifyLocalReviewArtifact,
} from "./install.js";
import { parseLocalReviewArgs } from "./arguments.js";
import {
  renderParticipantIdentityBackendMode,
  renderParticipantIdentityFileResidueState,
  renderParticipantIdentitySourceState,
} from "./identity-presentation.js";

export { parseLocalReviewArgs } from "./arguments.js";

export const LOCAL_REVIEW_CLI_VERSION = "0.1.0-alpha.1";

const SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ARTIFACT_ROOT = resolve(SOURCE_DIRECTORY, "..");
const DEFAULT_EXPORT_RESOURCE_CONTEXT = createLocalExportResourceContext({
  readBoundedJsonLines,
  clock: () => Date.now(),
  rss: () => process.memoryUsage().rss,
});
const DEFAULT_EXPORT_COMPATIBILITY = createExportCompatibilityContext({
  readExportCompatibilityArtifactSet,
  sha256Hex,
});
const DEFAULT_CLAUDE_CALLBACK_CAPABILITY =
  createClaudeCallbackCapabilityContext({
    capability:
      EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.claudeSessionPseudonym,
  });
const DEFAULT_CLAUDE_CALLBACK_LIFECYCLE =
  createClaudeCallbackLifecycleContext({
    ClaudeCallbackCapabilityError,
    ensureClaudeCallbackCapability:
      DEFAULT_CLAUDE_CALLBACK_CAPABILITY.ensureClaudeCallbackCapability,
    planClaudeCallbackCapabilityRemoval:
      DEFAULT_CLAUDE_CALLBACK_CAPABILITY.planClaudeCallbackCapabilityRemoval,
    removeClaudeCallbackCapability:
      DEFAULT_CLAUDE_CALLBACK_CAPABILITY.removeClaudeCallbackCapability,
    rotateClaudeCallbackCapability:
      DEFAULT_CLAUDE_CALLBACK_CAPABILITY.rotateClaudeCallbackCapability,
    runtimeScript: fileURLToPath(
      new URL("../src/claude-callback-runtime.js", import.meta.url),
    ),
  });
const DEFAULT_BUNDLE_VERIFICATION =
  createLocalMetadataBundleVerificationContext({
    readOwnerOnlyLocalMetadataBundlePair,
    sha256Hex,
    compatibilityTuple:
      DEFAULT_EXPORT_COMPATIBILITY.exportCompatibilityTuple,
  });
const DEFAULT_EXPORT_SET_VERIFICATION =
  createLocalExportSetVerificationContext({
    storage: createExportSetVerificationStorageContext(),
    bundleVerification: DEFAULT_BUNDLE_VERIFICATION,
    exportCompatibilityTuple:
      DEFAULT_EXPORT_COMPATIBILITY.exportCompatibilityTuple,
    manifestBasename: "export-set-manifest.json",
    manifestReceiptBasename: "export-set-manifest.privacy-receipt.json",
  });
const DEFAULT_EXPORT_ARTIFACT_STORAGE =
  createLocalExportArtifactStorageContext({
    createStorage: createOwnerOnlyExportArtifactStorageContext,
    activityMarkerFile: defaultActivityMarkerFile,
  });
const DEFAULT_EXPORT_WORKSPACE_RUNTIME = createLocalExportWorkspaceRuntimeContext({
  createStorage: createOwnerOnlyExportWorkspaceStorageContext,
  createLease: createOwnerOnlyExportWorkspaceLeaseContext,
  sha256Hex,
  platformName: () => {
    if (process.platform === "darwin") return "macos";
    if (process.platform === "linux") return "linux";
    if (process.platform === "win32") return "windows";
    return "other";
  },
});
const DEFAULT_LOCAL_EXPORT_SET_CONTROLLER = createLocalExportSourcePipelineContext(
  localIsProxy,
  createLocalExportSourcePorts(),
  {
    exportCompatibilityTuple: DEFAULT_EXPORT_COMPATIBILITY.exportCompatibilityTuple,
    workspace: DEFAULT_EXPORT_WORKSPACE_RUNTIME,
  },
).controller;
const DEFAULT_EXPORT_DELETION = createLocalExportDeletion({
  verifyExportSet: DEFAULT_EXPORT_SET_VERIFICATION.verifyLocalExportSet,
  openExportWorkspace: DEFAULT_EXPORT_WORKSPACE_RUNTIME.openExportWorkspace,
  withExistingExportWorkspaceLease: DEFAULT_EXPORT_WORKSPACE_RUNTIME.withExistingExportWorkspaceLease,
  isTrustedExportWorkspaceLockError: DEFAULT_EXPORT_WORKSPACE_RUNTIME.isTrustedExportWorkspaceLockError,
  workspaceDatabaseBasename: DEFAULT_EXPORT_WORKSPACE_RUNTIME.EXPORT_WORKSPACE_DATABASE_BASENAME,
  createPreflightInspector: createOwnerOnlyExportDeletionPreflightInspector,
  createDeletionStorage: createOwnerOnlyExportDeletionStorage,
});
const DEFAULT_EXPORT_WORKSPACE_DISCARD = createLocalExportWorkspaceDiscard({
  workspaceDatabaseBasename: DEFAULT_EXPORT_WORKSPACE_RUNTIME.EXPORT_WORKSPACE_DATABASE_BASENAME,
  inspectExportWorkspaceDiscardState: DEFAULT_EXPORT_WORKSPACE_RUNTIME.inspectExportWorkspaceDiscardState,
  readBoundedDirectoryEntries,
  withExistingExportWorkspaceLease: DEFAULT_EXPORT_WORKSPACE_RUNTIME.withExistingExportWorkspaceLease,
  createPreflight: createOwnerOnlyExportWorkspaceDiscardPreflight,
  createStorage: createOwnerOnlyExportWorkspaceDiscardStorage,
});
const {
  planLocalExportWorkspaceDiscard,
  discardLocalExportWorkspace,
  recoverLocalExportWorkspaceDiscard,
} = DEFAULT_EXPORT_WORKSPACE_DISCARD;
const {
  planLocalExportDeletion,
  deleteLocalExport,
  recoverLocalExportDeletion,
} = DEFAULT_EXPORT_DELETION;
const DEFAULT_EXPORT_SET_MATERIALIZATION = createLocalExportSetMaterializationContext({
  workspace: DEFAULT_EXPORT_WORKSPACE_RUNTIME,
  destination: DEFAULT_EXPORT_ARTIFACT_STORAGE,
  identity: { deriveParticipantId, deriveExportPseudonym },
  resource: DEFAULT_EXPORT_RESOURCE_CONTEXT,
  bundleVerification: DEFAULT_BUNDLE_VERIFICATION,
  compatibilityTuple: DEFAULT_EXPORT_COMPATIBILITY.exportCompatibilityTuple,
  sha256Hex,
});
const DEFAULT_METADATA_EXPORT = createLocalMetadataExportContext({
  clock: () => Date.now(),
  codexLogPorts: createLocalCodexLogPorts(),
  createHash,
  deriveAccountScopeId,
  deriveEventOccurrenceId,
  deriveMarkerOccurrenceId,
  deriveModelFingerprint,
  deriveParticipantId,
  deriveQuotaStateId,
  deriveSessionScopeId,
  deriveSnapshotObservationId,
  exportCompatibilityTuple: DEFAULT_EXPORT_COMPATIBILITY.exportCompatibilityTuple,
  platformName: () => {
    if (process.platform === "darwin") return "macos";
    if (process.platform === "linux") return "linux";
    if (process.platform === "win32") return "windows";
    return "other";
  },
  randomBundleId,
  resolvePath: resolve,
  rss: () => process.memoryUsage().rss,
  sha256Hex,
  writeOwnerOnlyPairNoClobber:
    DEFAULT_EXPORT_ARTIFACT_STORAGE.writeOwnerOnlyPairNoClobber,
});

function createLocalReviewClaudeCallbackBackend() {
  return selectProductionClaudeCallbackBackend({
    platform: process.platform,
    architecture: process.arch,
    createBackend: createExportIdentityKeychainBackend,
  });
}

function selectLocalReviewParticipantIdentity({
  explicitSecretFile = null,
} = {}) {
  const keychainCapability =
    EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity;
  return selectProductionParticipantIdentity({
    explicitSecretFile,
    environmentSecret: process.env.APP_USAGEMONITOR_EXPORT_SECRET,
    platform: process.platform,
    architecture: process.arch,
    appStateSecretFile: defaultExportSecretFile(),
    createKeychainBackend: createExportIdentityKeychainBackend,
    keychainCapability,
    allowedKeychainCapability: keychainCapability,
  });
}

function usage() {
  console.log(`TiboTattle local review ${LOCAL_REVIEW_CLI_VERSION}

Local-only commands:
  usage-monitor-local doctor
  usage-monitor-local inspect-artifact [--artifact-root PATH]
  usage-monitor-local inspect-export --since ISO --until ISO [--codex-home PATH] [--activity-file PATH] [--secret-file PATH]
  usage-monitor-local export-local --since ISO --until ISO --output PATH [--receipt PATH] [--codex-home PATH] [--activity-file PATH] [--secret-file PATH]
  usage-monitor-local verify-bundle --input PATH [--receipt PATH]
  usage-monitor-local export-set --workspace PATH --directory PATH [--resume] [--since ISO --until ISO] [--codex-home PATH] [--collector-file PATH] [--claude-status | --claude-state-dir PATH] [--claude-usage] [--claude-projects-dir PATH] [--activity-file PATH] [--secret-file PATH] [--max-records-per-chunk N] [--max-bundle-bytes N] [--max-artifact-bytes N]
  usage-monitor-local inspect-export-workspace --workspace PATH
  usage-monitor-local verify-export-set --directory PATH
  usage-monitor-local recover-exports --directory PATH
  usage-monitor-local delete-local-export --workspace PATH --directory PATH [--confirm-deletion TOKEN]
  usage-monitor-local recover-local-export-deletion --workspace PATH --directory PATH
  usage-monitor-local discard-export-workspace --workspace PATH [--confirm-discard TOKEN]
  usage-monitor-local recover-export-workspace-discard --workspace PATH
  usage-monitor-local rotate-local-identity [--secret-file PATH] [--confirm]
  usage-monitor-local inspect-claude-callback
  usage-monitor-local install-claude-callback
  usage-monitor-local uninstall-claude-callback
  usage-monitor-local recover-claude-callback
  usage-monitor-local rotate-claude-callback-identity [--confirm]
  usage-monitor-local remove-claude-callback-identity [--confirm-removal TOKEN]
  usage-monitor-local install --target ABSOLUTE_PATH [--artifact-root PATH]
  usage-monitor-local uninstall --target ABSOLUTE_PATH [--confirm-uninstall TOKEN]

This build contains no enrollment, pairing, upload, queue, backend, web-server,
remote-configuration, notification, or automatic-update command.`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function printIdentityInspection(selection, inspection) {
  console.log(`Storage backend: ${renderParticipantIdentityBackendMode(selection.mode)}`);
  console.log(`Identity source: ${renderParticipantIdentitySourceState(inspection)}`);
  console.log(`Rotatable: ${inspection.rotatable === true}`);
  if (selection.mode === "macos_keychain") {
    console.log(`Owner-file secret residue: ${renderParticipantIdentityFileResidueState(inspection.ownerFileState)}`);
    console.log(`Legacy-file secret residue: ${renderParticipantIdentityFileResidueState(inspection.legacyState)}`);
  }
}

export async function runLocalReview(
  argv = process.argv.slice(2),
  {
    artifactRoot = DEFAULT_ARTIFACT_ROOT,
    selectParticipantIdentity = selectLocalReviewParticipantIdentity,
    inspectIdentity = inspectParticipantSecret,
    rotateIdentity = rotateParticipantSecret,
    withIdentityLease = withParticipantSecretLease,
    createClaudeCallbackBackend =
      createLocalReviewClaudeCallbackBackend,
    readClaudeCallbackCredential =
      DEFAULT_CLAUDE_CALLBACK_CAPABILITY.readClaudeCallbackCapability,
    inspectClaudeCallback =
      DEFAULT_CLAUDE_CALLBACK_LIFECYCLE.inspectClaudeCallbackLifecycle,
    installClaudeCallbackCommand =
      DEFAULT_CLAUDE_CALLBACK_LIFECYCLE.installClaudeCallback,
    uninstallClaudeCallbackCommand =
      DEFAULT_CLAUDE_CALLBACK_LIFECYCLE.uninstallClaudeCallback,
    recoverClaudeCallbackCommand =
      DEFAULT_CLAUDE_CALLBACK_LIFECYCLE.recoverClaudeCallbackLifecycle,
    rotateClaudeCallbackCommand =
      DEFAULT_CLAUDE_CALLBACK_LIFECYCLE.rotateManagedClaudeCallbackCapability,
    planClaudeCallbackRemoval =
      DEFAULT_CLAUDE_CALLBACK_LIFECYCLE.planManagedClaudeCallbackCapabilityRemoval,
    removeClaudeCallbackCredential =
      DEFAULT_CLAUDE_CALLBACK_LIFECYCLE.removeManagedClaudeCallbackCapability,
    exportResourceContext = DEFAULT_EXPORT_RESOURCE_CONTEXT,
    bundleVerification = DEFAULT_BUNDLE_VERIFICATION,
    verifyExportSet =
      DEFAULT_EXPORT_SET_VERIFICATION.verifyLocalExportSet,
    exportSetController = DEFAULT_LOCAL_EXPORT_SET_CONTROLLER,
  } = {},
) {
  const {
    createLocalExportWorkspace,
    inspectLocalExportWorkspace,
    resumeLocalExportWorkspace,
  } = exportSetController;
  const args = parseLocalReviewArgs(argv);
  const selectedArtifactRoot = args.artifactRoot ?? artifactRoot;

  if (["help", "--help", "-h"].includes(args.command)) {
    usage();
    return;
  }
  if (args.command === "inspect-artifact") {
    const verified = await verifyLocalReviewArtifact({
      artifactRoot: selectedArtifactRoot,
    });
    console.log("Local review artifact verification: passed");
    console.log(`Version: ${verified.artifactVersion}`);
    console.log(`Files: ${verified.fileCount}; bytes: ${verified.payloadBytes}`);
    console.log(`Manifest SHA-256: ${verified.manifestSha256}`);
    console.log("Local only: true; transport ready: false");
    return;
  }
  if (args.command === "install") {
    if (!args.target) throw new Error("install requires --target ABSOLUTE_PATH");
    const result = await installLocalReviewArtifact({
      artifactRoot: selectedArtifactRoot,
      target: args.target,
    });
    console.log(`Local review artifact: ${result.status}`);
    console.log(`Version: ${result.artifactVersion}; files: ${result.installedFiles}`);
    console.log(`Target: ${result.target}`);
    console.log("No global launcher or background service installed");
    console.log("Participant identity state changed: false; network activity: none");
    return;
  }
  if (args.command === "uninstall") {
    if (!args.target) throw new Error("uninstall requires --target ABSOLUTE_PATH");
    if (!args.confirmUninstallToken) {
      const planned = await planLocalReviewUninstall({ target: args.target });
      console.log(`Local review uninstall preflight: ${planned.status}`);
      console.log(`Files: ${planned.fileCount}; bytes: ${planned.totalBytes}`);
      console.log(`Confirmation token: ${planned.confirmationToken}`);
      console.log("No files changed; rerun with --confirm-uninstall TOKEN");
      console.log("Participant identity preserved: true; secure erasure: not claimed");
      return;
    }
    const result = await uninstallLocalReviewArtifact({
      target: args.target,
      confirmationToken: args.confirmUninstallToken,
    });
    console.log(`Local review artifact: ${result.status}`);
    console.log(`Files deleted: ${result.deletedFiles}`);
    console.log("Participant identity preserved: true; secure erasure: not claimed");
    console.log("Network activity: none");
    return;
  }
  if (args.command === "doctor") {
    if (process.platform !== "darwin" || process.arch !== "arm64") {
      throw new Error("This local-review release supports macOS arm64 only");
    }
    const runtimeMatches = process.version === "v26.2.0";
    const selection = selectParticipantIdentity({
      explicitSecretFile: args.exportSecretFile,
    });
    const identity = await inspectIdentity(selection.identityOptions);
    console.log(`TiboTattle local review: ${LOCAL_REVIEW_CLI_VERSION}`);
    console.log(`Platform: ${process.platform}-${process.arch}`);
    console.log(`Runtime: ${process.version} (${runtimeMatches ? "pinned" : "unexpected"})`);
    console.log(`Codex local data: ${await exists(join(homedir(), ".codex", "sessions")) ? "available" : "not_found"}`);
    console.log(`Claude local data: ${await exists(join(homedir(), ".claude", "projects")) ? "available" : "not_found"}`);
    printIdentityInspection(selection, identity);
    console.log("Upload, enrollment, pairing, queue, server, updater: absent");
    console.log("Network required: false");
    if (!runtimeMatches) throw new Error("Unexpected Node runtime; use the bundled launcher");
    return;
  }
  if (args.command === "verify-bundle") {
    if (!args.inputFile) throw new Error("verify-bundle requires --input");
    const verified = await bundleVerification.verifyLocalMetadataBundleFiles({
      bundleFile: args.inputFile,
      receiptFile: args.receiptFile ?? `${args.inputFile}.privacy-receipt.json`,
    });
    console.log("Local metadata bundle verification: passed");
    console.log(`Contract: ${verified.contractFamily} (${verified.contractStatus}); exporter ${verified.exporterVersion}`);
    console.log(`Records: ${verified.recordCounts.usageEvents} usage, ${verified.recordCounts.quotaSnapshots} quota, ${verified.recordCounts.activityMarkers} markers`);
    console.log(`Bundle bytes: ${verified.bundleBytes}; upload disabled: ${verified.transportReady === false}`);
    return;
  }
  if (args.command === "verify-export-set") {
    if (!args.directory) throw new Error("verify-export-set requires --directory");
    const verified = await verifyExportSet({ directory: args.directory });
    console.log("Local metadata export-set verification: passed");
    console.log(`Contract: ${verified.schemaVersion} (${verified.contractStatus})`);
    console.log(`Chunks: ${verified.chunkCount}`);
    console.log(`Records: ${verified.recordCounts.usageEvents} usage, ${verified.recordCounts.quotaSnapshots} quota, ${verified.recordCounts.activityMarkers} markers`);
    console.log(`Bundle bytes: ${verified.bundleBytes}; upload disabled: ${verified.transportReady === false}`);
    return;
  }
  if (args.command === "inspect-export-workspace") {
    if (!args.workspaceDirectory) {
      throw new Error("inspect-export-workspace requires --workspace");
    }
    const inspected = await inspectLocalExportWorkspace({
      directory: args.workspaceDirectory,
    });
    console.log("Local metadata export workspace");
    console.log(`Status: ${inspected.poisoned
      ? "poisoned_source_integrity"
      : inspected.scanComplete ? "scan_complete" : "incomplete"}`);
    console.log(`Coverage: ${inspected.coveredAt.startAt} to ${inspected.coveredAt.endAt}`);
    console.log(`Providers: ${inspected.sourceProviders.join(", ")}`);
    console.log(`Records: ${inspected.recordCounts.usageEvents} usage, ${inspected.recordCounts.quotaSnapshots} quota, ${inspected.recordCounts.activityMarkers} markers`);
    console.log(`Workspace bytes: ${inspected.workspaceBytes}; upload disabled: true`);
    return;
  }
  if (args.command === "export-set") {
    if (!args.workspaceDirectory || !args.directory) {
      throw new Error("export-set requires --workspace and --directory");
    }
    if (!args.resume && (!args.startAt || !args.endAt)) {
      throw new Error("export-set creation requires --since and --until");
    }
    if (args.resume && (args.startAt || args.endAt)) {
      throw new Error("export-set --resume uses the workspace interval; omit --since and --until");
    }
    const activityMarkers = await exportResourceContext.readActivityMarkers(
      args.activityFile ?? DEFAULT_EXPORT_ARTIFACT_STORAGE.defaultActivityMarkerFile(),
    );
    const selection = selectParticipantIdentity({
      explicitSecretFile: args.exportSecretFile,
    });
    await withIdentityLease(selection.identityOptions, async (identity) => {
      const shared = {
        directory: args.workspaceDirectory,
        codexHome: args.codexHome ?? undefined,
        secret: identity.secret,
        activityMarkers,
        collectorPath: args.collectorFile,
        claudeStateDirectory: args.claudeStateDirectory,
        enableClaudeStatus: args.claudeStatus,
        claudeProjectsDirectory: args.claudeProjectsDirectory,
        enableClaudeUsage: args.claudeUsage,
      };
      const workspaceResult = args.resume
        ? await resumeLocalExportWorkspace(shared)
        : await createLocalExportWorkspace({
            ...shared,
            startAt: args.startAt,
            endAt: args.endAt,
          });
      const materialized = await DEFAULT_EXPORT_SET_MATERIALIZATION.materializeLocalExportSet({
        workspaceDirectory: args.workspaceDirectory,
        outputDirectory: args.directory,
        secret: identity.secret,
        ...(args.maximumRecordsPerChunk === null
          ? {}
          : { maximumRecordsPerChunk: args.maximumRecordsPerChunk }),
        ...(args.maximumCanonicalBundleBytes === null
          ? {}
          : { maximumCanonicalBundleBytes: args.maximumCanonicalBundleBytes }),
        ...(args.maximumEncodedArtifactBytes === null
          ? {}
          : { maximumEncodedArtifactBytes: args.maximumEncodedArtifactBytes }),
      });
      console.log("Local metadata export set: complete");
      console.log(`Workspace status: ${workspaceResult.status.scanComplete ? "scan_complete" : "incomplete"}`);
      console.log(`Chunks: ${materialized.manifest.chunks.length}`);
      console.log(`Records: ${materialized.manifest.totals.recordCounts.usageEvents} usage, ${materialized.manifest.totals.recordCounts.quotaSnapshots} quota, ${materialized.manifest.totals.recordCounts.activityMarkers} markers`);
      console.log(`Artifact bytes: ${materialized.manifest.totals.encodedArtifactBytes}; decoded bundle bytes: ${materialized.manifest.totals.decodedBundleBytes}`);
      console.log("Upload: disabled (transportReady=false)");
    });
    return;
  }
  if (args.command === "recover-exports") {
    if (!args.directory) throw new Error("recover-exports requires --directory");
    const result = await DEFAULT_EXPORT_ARTIFACT_STORAGE.recoverOwnerOnlyPairTransactions({
      directory: args.directory,
    });
    console.log(`Local export recovery: ${result.recovered} recovered of ${result.transactionsFound} transaction(s)`);
    console.log("Upload remains disabled");
    return;
  }
  if (args.command === "delete-local-export") {
    if (!args.workspaceDirectory || !args.directory) {
      throw new Error("delete-local-export requires --workspace and --directory");
    }
    if (!args.confirmDeletionToken) {
      const planned = await planLocalExportDeletion({
        workspaceDirectory: args.workspaceDirectory,
        outputDirectory: args.directory,
      });
      console.log(`Local export deletion preflight: ${planned.readiness}`);
      console.log(`Files: ${planned.fileCounts.totalFiles}; bytes: ${planned.byteCounts.totalBytes}`);
      console.log(`Confirmation token: ${planned.confirmationToken}`);
      console.log("No files changed; rerun with --confirm-deletion TOKEN");
      console.log("Source logs and local identity state preserved; secure erasure not claimed");
      return;
    }
    const receipt = await deleteLocalExport({
      workspaceDirectory: args.workspaceDirectory,
      outputDirectory: args.directory,
      confirmationToken: args.confirmDeletionToken,
    });
    console.log("Local export deletion: complete");
    console.log(`Files deleted: ${receipt.deletedFileCount}; bytes: ${receipt.deletedBytes}`);
    console.log("Source logs and local identity state preserved; secure erasure not claimed");
    return;
  }
  if (args.command === "recover-local-export-deletion") {
    if (!args.workspaceDirectory || !args.directory) {
      throw new Error("recover-local-export-deletion requires --workspace and --directory");
    }
    const receipt = await recoverLocalExportDeletion({
      workspaceDirectory: args.workspaceDirectory,
      outputDirectory: args.directory,
    });
    console.log("Local export deletion recovery: complete");
    console.log(`Files in committed inventory: ${receipt.deletedFileCount}; bytes: ${receipt.deletedBytes}`);
    console.log("Source logs and local identity state preserved; secure erasure not claimed");
    return;
  }
  if (args.command === "discard-export-workspace") {
    if (!args.workspaceDirectory) {
      throw new Error("discard-export-workspace requires --workspace");
    }
    if (args.directory) {
      throw new Error("discard-export-workspace accepts --workspace only");
    }
    if (!args.confirmDiscardToken) {
      const planned = await planLocalExportWorkspaceDiscard({
        workspaceDirectory: args.workspaceDirectory,
      });
      console.log(`Local export workspace discard preflight: ${planned.readiness}`);
      console.log(`Eligibility: ${planned.eligibility}`);
      console.log(`Files: ${planned.fileCounts.totalFiles}; bytes: ${planned.byteCounts.totalBytes}`);
      console.log(`Confirmation token: ${planned.confirmationToken}`);
      console.log("No files changed; rerun with --confirm-discard TOKEN");
      console.log("Source logs, identity, and independent outputs preserved");
      return;
    }
    const receipt = await discardLocalExportWorkspace({
      workspaceDirectory: args.workspaceDirectory,
      confirmationToken: args.confirmDiscardToken,
    });
    console.log("Local export workspace discard: complete");
    console.log(`Files deleted: ${receipt.deletedFileCount}; bytes: ${receipt.deletedBytes}`);
    console.log("Source logs, identity, and independent outputs preserved");
    return;
  }
  if (args.command === "recover-export-workspace-discard") {
    if (!args.workspaceDirectory) {
      throw new Error("recover-export-workspace-discard requires --workspace");
    }
    const receipt = await recoverLocalExportWorkspaceDiscard({
      workspaceDirectory: args.workspaceDirectory,
    });
    console.log("Local export workspace discard recovery: complete");
    console.log(`Files in committed inventory: ${receipt.deletedFileCount}; bytes: ${receipt.deletedBytes}`);
    console.log("Source logs, identity, and independent outputs preserved");
    return;
  }
  if (args.command === "rotate-local-identity") {
    const selection = selectParticipantIdentity({
      explicitSecretFile: args.exportSecretFile,
    });
    if (!args.confirm) {
      const inspection = await inspectIdentity(selection.identityOptions);
      console.log("Local export identity rotation preflight");
      printIdentityInspection(selection, inspection);
      console.log("No state changed; rerun with --confirm to break future export linkability");
      return;
    }
    const rotated = await rotateIdentity({
      ...selection.identityOptions,
      confirmRotation: true,
    });
    console.log("Local export identity rotation: completed");
    console.log(`Storage backend: ${renderParticipantIdentityBackendMode(selection.mode)}`);
    console.log("Future export pseudonyms changed: true; existing bundles changed: false");
    console.log(`Secure storage erasure guaranteed: ${rotated.secureErasure}`);
    return;
  }
  if (args.command === "inspect-export" || args.command === "export-local") {
    if (!args.startAt || !args.endAt) {
      throw new Error(`${args.command} requires --since and --until`);
    }
    if (args.command === "export-local" && !args.outputFile) {
      throw new Error("export-local requires --output");
    }
    const guard = exportResourceContext.createGuard();
    guard.assertCoveredInterval(Date.parse(args.startAt), Date.parse(args.endAt));
    const activityMarkers = await exportResourceContext.readActivityMarkers(
      args.activityFile ?? DEFAULT_EXPORT_ARTIFACT_STORAGE.defaultActivityMarkerFile(),
      {
        resourceGuard: guard,
      },
    );
    const selection = selectParticipantIdentity({
      explicitSecretFile: args.exportSecretFile,
    });
    await withIdentityLease(selection.identityOptions, async (identity) => {
      const result = await DEFAULT_METADATA_EXPORT.buildLocalMetadataBundle({
        startAt: args.startAt,
        endAt: args.endAt,
        codexHome: args.codexHome ?? undefined,
        secret: identity.secret,
        activityMarkers,
        resourceGuard: guard,
      });
      console.log(DEFAULT_METADATA_EXPORT.renderMetadataExportPreview(result));
      if (args.command === "inspect-export") return;
      const receiptFile = args.receiptFile
        ?? `${args.outputFile}.privacy-receipt.json`;
      const written = await DEFAULT_METADATA_EXPORT.writeLocalMetadataBundle({
        ...result,
        outputFile: args.outputFile,
        receiptFile,
      });
      console.log(`Bundle: ${written.outputFile}`);
      console.log(`Privacy receipt: ${written.receiptFile}`);
    });
    return;
  }
  if (args.command === "inspect-claude-callback") {
    const inspected = await inspectClaudeCallback();
    const backend = createClaudeCallbackBackend();
    let secret = null;
    try {
      secret = await readClaudeCallbackCredential({ backend });
      console.log("Claude callback inspection");
      console.log(`Lifecycle: ${inspected.status}`);
      console.log(`Session-pseudonym capability: ${secret === null ? "missing" : "available"}`);
      console.log("Existing status-line command: private (never displayed)");
      console.log("Network activity: none");
    } finally {
      secret?.fill(0);
    }
    return;
  }
  if (args.command === "install-claude-callback") {
    const result = await installClaudeCallbackCommand({
      backend: createClaudeCallbackBackend(),
    });
    console.log(`Claude callback installation: ${result.status}`);
    console.log(`Session-pseudonym capability: ${result.capability}`);
    console.log("Existing supported status line retained privately for exact restoration");
    console.log("Network activity: none");
    return;
  }
  if (args.command === "uninstall-claude-callback") {
    const result = await uninstallClaudeCallbackCommand();
    console.log(`Claude callback uninstallation: ${result.status}`);
    console.log(`Session-pseudonym capability preserved: ${result.capabilityPreserved}`);
    console.log("Network activity: none");
    return;
  }
  if (args.command === "recover-claude-callback") {
    const result = await recoverClaudeCallbackCommand();
    console.log(`Claude callback recovery: ${result.status}`);
    console.log(`Lifecycle phase: ${result.recovered}`);
    console.log("Network activity: none");
    return;
  }
  if (args.command === "rotate-claude-callback-identity") {
    const backend = createClaudeCallbackBackend();
    if (!args.confirm) {
      let secret = null;
      try {
        secret = await readClaudeCallbackCredential({ backend });
        console.log(`Claude callback identity rotation preflight: ${secret === null ? "missing" : "ready"}`);
        console.log("No state changed; rerun with --confirm");
      } finally {
        secret?.fill(0);
      }
      return;
    }
    const result = await rotateClaudeCallbackCommand({
      backend,
      confirm: true,
    });
    console.log(`Claude callback identity rotation: ${result.status}`);
    console.log("Future session pseudonyms changed: true; existing snapshots changed: false");
    console.log("Network activity: none");
    return;
  }
  if (args.command === "remove-claude-callback-identity") {
    const backend = createClaudeCallbackBackend();
    if (!args.confirmRemovalToken) {
      const planned = await planClaudeCallbackRemoval({ backend });
      console.log(`Claude callback identity removal preflight: ${planned.status}`);
      if (planned.confirmationToken !== null) {
        console.log(`Confirmation token: ${planned.confirmationToken}`);
        console.log("No state changed; rerun with --confirm-removal TOKEN");
      }
      console.log("Callback must be uninstalled first; secure erasure not claimed");
      return;
    }
    const result = await removeClaudeCallbackCredential({
      backend,
      providedToken: args.confirmRemovalToken,
    });
    console.log(`Claude callback identity removal: ${result.status}`);
    console.log(`Secure erasure guaranteed: ${result.secureErasure}`);
    console.log("Network activity: none");
    return;
  }
  throw new Error(`Unknown local-review command: ${args.command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLocalReview().catch((error) => {
    console.error(`usage-monitor-local: ${error.message}`);
    process.exitCode = 1;
  });
}
