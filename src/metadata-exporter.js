import { createHash } from "node:crypto";
import { platform } from "node:os";
import { resolve } from "node:path";

import {
  createLocalExportArtifactStorageContext,
  createLocalMetadataExportContext,
} from "./application/index.js";
import { exportCompatibilityTuple } from "./export-contract.js";
import {
  deriveAccountScopeId,
  deriveEventOccurrenceId,
  deriveMarkerOccurrenceId,
  deriveModelFingerprint,
  deriveParticipantId,
  deriveQuotaStateId,
  deriveSessionScopeId,
  deriveSnapshotObservationId,
  randomBundleId,
} from "./export-identity.js";
import {
  createLocalCodexLogPorts,
  createOwnerOnlyExportArtifactStorageContext,
  defaultActivityMarkerFile,
  sha256Hex,
} from "./platform/index.js";

function platformName() {
  if (platform() === "darwin") return "macos";
  if (platform() === "linux") return "linux";
  if (platform() === "win32") return "windows";
  return "other";
}

const artifactStorage = createLocalExportArtifactStorageContext({
  createStorage: createOwnerOnlyExportArtifactStorageContext,
  activityMarkerFile: defaultActivityMarkerFile,
});

const metadataExport = createLocalMetadataExportContext({
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
  exportCompatibilityTuple,
  platformName,
  randomBundleId,
  resolvePath: resolve,
  rss: () => process.memoryUsage().rss,
  sha256Hex,
  writeOwnerOnlyPairNoClobber:
    artifactStorage.writeOwnerOnlyPairNoClobber,
});

// Exact legacy composition shim. Public metadata operations are application
// owned; this file supplies Node and durable-storage ports only.
export const buildLocalMetadataBundle = metadataExport.buildLocalMetadataBundle;
export const renderMetadataExportPreview = metadataExport.renderMetadataExportPreview;
export const writeLocalMetadataBundle = metadataExport.writeLocalMetadataBundle;

export {
  quotaObservationIdentitySubject,
  quotaStateIdentitySubject,
  usageEventIdentitySubject,
} from "./export-safe-records.js";
