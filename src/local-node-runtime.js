import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { isProxy } from "node:util/types";

import {
  createExportCompatibilityContext,
  createLocalCodexLogScanner,
  createLocalContributionSyncQueueContext,
  createLocalExportArtifactStorageContext,
  createLocalExportDeletion,
  createLocalExportResourceContext,
  createLocalExportSetMaterialization,
  createLocalExportSetVerificationContext,
  createLocalExportSourcePipelineContext,
  createLocalExportWorkspaceDiscard,
  createLocalExportWorkspaceRuntimeContext,
  createLocalMetadataBundleVerificationContext,
  createLocalMetadataExportContext,
} from "./application/index.js";
import { syncPreparedContributionEntryOnce } from
  "./contribution-device-sync.js";
import {
  assertValidExportRecord,
  createCodexCheckpointStateContext,
  createExportResourceGuard as createPureExportResourceGuard,
  createSafeRecordsContext,
  stableJson,
} from "./export/index.js";
import {
  EXPORT_GZIP_PROFILE,
  EXPORT_SET_CONTRACT_VERSION,
  EXPORT_SET_MANIFEST_BASENAME,
  EXPORT_SET_MANIFEST_RECEIPT_BASENAME,
  EXPORT_SET_MANIFEST_SCHEMA_SHA256,
  EXPORT_SET_MANIFEST_VERSION,
  EXPORT_SET_ORDERING_VERSION,
  EXPORT_SET_PACKING_VERSION,
  createExportSetMaterializationContract,
  createPrivacySafeBundleVerifier,
} from "./export/set-materialization-runtime.js";
import {
  createExportSetVerificationStorageContext,
  createLocalCodexLogPorts,
  createLocalContributionSyncQueueStorageContext,
  createLocalExportSourcePorts,
  createOwnerOnlyExportArtifactStorageContext,
  createOwnerOnlyExportDeletionPreflightInspector,
  createOwnerOnlyExportDeletionStorage,
  createOwnerOnlyExportWorkspaceDiscardPreflight,
  createOwnerOnlyExportWorkspaceDiscardStorage,
  createOwnerOnlyExportWorkspaceLeaseContext,
  createOwnerOnlyExportWorkspaceStorageContext,
  defaultActivityMarkerFile,
  deriveAccountScopeId,
  deriveEventOccurrenceId,
  deriveExportPseudonym,
  deriveMarkerOccurrenceId,
  deriveModelFingerprint,
  deriveParticipantId,
  deriveQuotaStateId,
  deriveSessionScopeId,
  deriveSnapshotObservationId,
  localIsProxy,
  localPlatformName,
  randomBundleId,
  readBoundedDirectoryEntries,
  readBoundedJsonLines,
  readExportCompatibilityArtifactSet,
  readOwnerOnlyLocalMetadataBundlePair,
  sha256Hex,
} from "./platform/index.js";
import { validateClaudeStatusSnapshot } from
  "./providers/claude/statusline.js";
import {
  loadVerifiedPreparedContribution,
  verifyPreparedContributionSet,
} from "./telemetry-prepared-set.js";

/**
 * The single Node composition root for local source, export, and contribution
 * workflows. Domain/application owners stay runtime-neutral; this module
 * supplies concrete Node and owner-only platform ports once per process.
 *
 * Consumers import the named frozen contexts below. Historical flat modules
 * must not be recreated: their paths are permanent entries in the retired
 * production-source ledger.
 */

export const localCodexLogScanner = createLocalCodexLogScanner(
  createLocalCodexLogPorts(),
);

export const localCodexCheckpointState =
  createCodexCheckpointStateContext({ createHash, isProxy });

function createLocalExportResourceGuard(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return createPureExportResourceGuard(options);
  }
  return createPureExportResourceGuard({
    ...options,
    ...(Object.hasOwn(options, "clock") ? {} : {
      clock: () => Date.now(),
    }),
    ...(Object.hasOwn(options, "rss") ? {} : {
      rss: () => process.memoryUsage().rss,
    }),
  });
}

const exportCompatibility = createExportCompatibilityContext({
  readExportCompatibilityArtifactSet,
  sha256Hex,
});

export const localSafeRecords = createSafeRecordsContext({
  assertValidExportRecord,
  createHash,
  createExportResourceGuard: createLocalExportResourceGuard,
  deriveAccountScopeId,
  deriveEventOccurrenceId,
  deriveMarkerOccurrenceId,
  deriveModelFingerprint,
  deriveQuotaStateId,
  deriveSessionScopeId,
  deriveSnapshotObservationId,
  exportCompatibilityTuple: exportCompatibility.exportCompatibilityTuple,
  isProxy,
  scanCodexLogEvents: localCodexLogScanner.scanCodexLogEvents,
  stableJson,
  validateClaudeStatusSnapshot,
  ...localCodexCheckpointState,
});

const exportArtifactStorage = createLocalExportArtifactStorageContext({
  createStorage: createOwnerOnlyExportArtifactStorageContext,
  activityMarkerFile: defaultActivityMarkerFile,
});

export const localMetadataExport = createLocalMetadataExportContext({
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
  exportCompatibilityTuple: exportCompatibility.exportCompatibilityTuple,
  platformName: localPlatformName,
  randomBundleId,
  resolvePath: resolve,
  rss: () => process.memoryUsage().rss,
  sha256Hex,
  writeOwnerOnlyPairNoClobber:
    exportArtifactStorage.writeOwnerOnlyPairNoClobber,
});

export const localExportWorkspace = createLocalExportWorkspaceRuntimeContext({
  createStorage: createOwnerOnlyExportWorkspaceStorageContext,
  createLease: createOwnerOnlyExportWorkspaceLeaseContext,
  sha256Hex,
  platformName: localPlatformName,
});

export const localMetadataBundleVerification =
  createLocalMetadataBundleVerificationContext({
    readOwnerOnlyLocalMetadataBundlePair,
    sha256Hex,
    compatibilityTuple: exportCompatibility.exportCompatibilityTuple,
  });

const exportResource = createLocalExportResourceContext({
  readBoundedJsonLines,
  clock: () => Date.now(),
  rss: () => process.memoryUsage().rss,
});

export const localExportSetMaterialization =
  createLocalExportSetMaterialization({
    contract: createExportSetMaterializationContract({
      deriveExportPseudonym,
      verifyPrivacySafeBundle: createPrivacySafeBundleVerifier({
        sha256Hex,
        compatibilityTuple: exportCompatibility.exportCompatibilityTuple,
      }),
      loadVerifiedLocalMetadataBundleBytes:
        localMetadataBundleVerification.loadVerifiedLocalMetadataBundleBytes,
    }),
    workspace: localExportWorkspace,
    destination: exportArtifactStorage,
    identity: { deriveParticipantId },
    resource: exportResource,
    constants: {
      EXPORT_SET_ORDERING_VERSION,
      EXPORT_SET_PACKING_VERSION,
      EXPORT_SET_MANIFEST_BASENAME,
      EXPORT_SET_MANIFEST_RECEIPT_BASENAME,
      EXPORT_GZIP_PROFILE,
      EXPORT_SET_CONTRACT_VERSION,
      EXPORT_SET_MANIFEST_SCHEMA_SHA256,
      EXPORT_SET_MANIFEST_VERSION,
    },
  });

export const localExportSetVerification =
  createLocalExportSetVerificationContext({
    storage: createExportSetVerificationStorageContext(),
    bundleVerification: localMetadataBundleVerification,
    exportCompatibilityTuple:
      exportCompatibility.exportCompatibilityTuple,
    manifestBasename: EXPORT_SET_MANIFEST_BASENAME,
    manifestReceiptBasename: EXPORT_SET_MANIFEST_RECEIPT_BASENAME,
  });

export const localExportDeletion = createLocalExportDeletion({
  verifyExportSet: localExportSetVerification.verifyLocalExportSet,
  openExportWorkspace: localExportWorkspace.openExportWorkspace,
  withExistingExportWorkspaceLease:
    localExportWorkspace.withExistingExportWorkspaceLease,
  isTrustedExportWorkspaceLockError:
    localExportWorkspace.isTrustedExportWorkspaceLockError,
  workspaceDatabaseBasename:
    localExportWorkspace.EXPORT_WORKSPACE_DATABASE_BASENAME,
  createPreflightInspector: createOwnerOnlyExportDeletionPreflightInspector,
  createDeletionStorage: createOwnerOnlyExportDeletionStorage,
});

export const localExportWorkspaceDiscard =
  createLocalExportWorkspaceDiscard({
    workspaceDatabaseBasename:
      localExportWorkspace.EXPORT_WORKSPACE_DATABASE_BASENAME,
    inspectExportWorkspaceDiscardState:
      localExportWorkspace.inspectExportWorkspaceDiscardState,
    readBoundedDirectoryEntries,
    withExistingExportWorkspaceLease:
      localExportWorkspace.withExistingExportWorkspaceLease,
    createPreflight: createOwnerOnlyExportWorkspaceDiscardPreflight,
    createStorage: createOwnerOnlyExportWorkspaceDiscardStorage,
  });

export const localExportSourcePipeline =
  createLocalExportSourcePipelineContext(
    localIsProxy,
    createLocalExportSourcePorts(),
    {
      exportCompatibilityTuple:
        exportCompatibility.exportCompatibilityTuple,
      workspace: localExportWorkspace,
    },
  );

export const localContributionSyncQueue =
  createLocalContributionSyncQueueContext({
    createStorage: createLocalContributionSyncQueueStorageContext,
    resolvePath: resolve,
    verifyPreparedSet: verifyPreparedContributionSet,
    loadPreparedContribution: loadVerifiedPreparedContribution,
    syncPreparedEntry: syncPreparedContributionEntryOnce,
  });
