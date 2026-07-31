// Exact legacy compatibility composition. Content, orchestration, and durable
// destination mechanics are respectively owned by export/, application/, and
// platform/. The historical seven bindings remain the only flat surface.
import {
  EXPORT_SET_MANIFEST_BASENAME,
  EXPORT_SET_MANIFEST_RECEIPT_BASENAME,
  EXPORT_SET_ORDERING_VERSION,
  ExportSetError,
  combinedSourcePlanCommitment,
  computeWorkspaceLogicalRecordsSha256,
  createExportSetMaterializationContract,
  EXPORT_GZIP_PROFILE,
  EXPORT_SET_CONTRACT_VERSION,
  EXPORT_SET_MANIFEST_SCHEMA_SHA256,
  EXPORT_SET_MANIFEST_VERSION,
  EXPORT_SET_PACKING_VERSION,
  createPrivacySafeBundleVerifier,
} from "./export/set-materialization-runtime.js";
import {
  createLocalExportArtifactStorageContext,
  createLocalMetadataBundleVerificationContext,
  createExportCompatibilityContext,
  createLocalExportResourceContext,
  createLocalExportSetMaterialization,
} from "./application/index.js";
import { openExportWorkspace } from "./export-workspace.js";
import { withExportWorkspaceLease } from "./export-workspace-lock.js";
import {
  createOwnerOnlyExportArtifactStorageContext,
  defaultActivityMarkerFile,
  deriveExportPseudonym,
  deriveParticipantId,
  readBoundedJsonLines,
  readExportCompatibilityArtifactSet,
  readOwnerOnlyLocalMetadataBundlePair,
  sha256Hex,
} from "./platform/index.js";

const compatibility = createExportCompatibilityContext({
  readExportCompatibilityArtifactSet,
  sha256Hex,
});
const bundleVerification = createLocalMetadataBundleVerificationContext({
  readOwnerOnlyLocalMetadataBundlePair,
  sha256Hex,
  compatibilityTuple: compatibility.exportCompatibilityTuple,
});

const materialization = createLocalExportSetMaterialization({
  contract: createExportSetMaterializationContract({
    deriveExportPseudonym,
    verifyPrivacySafeBundle: createPrivacySafeBundleVerifier({
      sha256Hex,
      compatibilityTuple: compatibility.exportCompatibilityTuple,
    }),
    loadVerifiedLocalMetadataBundleBytes: bundleVerification.loadVerifiedLocalMetadataBundleBytes,
  }),
  workspace: { openExportWorkspace, withExportWorkspaceLease },
  destination: createLocalExportArtifactStorageContext({
    createStorage: createOwnerOnlyExportArtifactStorageContext,
    activityMarkerFile: defaultActivityMarkerFile,
  }),
  identity: { deriveParticipantId },
  resource: createLocalExportResourceContext({
    readBoundedJsonLines,
    clock: () => Date.now(),
    rss: () => process.memoryUsage().rss,
  }),
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

export {
  EXPORT_SET_MANIFEST_BASENAME,
  EXPORT_SET_MANIFEST_RECEIPT_BASENAME,
  EXPORT_SET_ORDERING_VERSION,
  ExportSetError,
  combinedSourcePlanCommitment,
  computeWorkspaceLogicalRecordsSha256,
};
export const materializeLocalExportSet = materialization.materializeLocalExportSet;
