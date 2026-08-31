export {
  readBoundedJsonLines,
  readBoundedUtf8LineEntries,
  readBoundedUtf8Lines,
} from "./bounded-jsonl-reader.js";
export { readBoundedDirectoryEntries } from "./bounded-directory-reader.js";
export { createTelemetryV11Envelope } from "./telemetry-v11-envelope.js";
export {
  CODEX_CONFIG_RETAINED_KEYS,
  CODEX_CONFIG_SERVICE_TIER_STATUSES,
  readCodexConfigServiceTier,
} from "./codex-config-service-tier.js";
export { createLocalCodexLogPorts } from "./local-codex-log-ports.js";
export { readCodexLocalThreadMetadata } from "./local-codex-thread-store.js";
export {
  createLocalExportSourcePorts,
  localIsProxy,
  localPlatformName,
} from "./local-export-source-ports.js";
export {
  createLocalContributionSyncQueueStorageContext,
} from "./local-contribution-sync-queue-storage.js";
export {
  WINDOWS_BINDING_PROVENANCE_CONTRACT_VERSION,
  WINDOWS_PRODUCTION_READINESS,
  WINDOWS_PRODUCTION_READINESS_CONTRACT_VERSION,
  WINDOWS_PRODUCTION_READINESS_FACTS,
  WindowsProductionReadinessError,
  assertWindowsProductionBackend,
  assertWindowsProductionReadiness,
  createWindowsProductionCapabilityBackend,
  createWindowsProductionReadinessAttestation,
} from "./windows-production-readiness.js";
export {
  CONTRIBUTION_DEVICE_READER_CODE_IDENTIFIER,
  CONTRIBUTION_DEVICE_READER_TEAM_IDENTIFIER,
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
  MACOS_APP_KEYCHAIN_CAPABILITIES,
  ExportIdentityKeychainError,
  KEYTAR_DARWIN_ARM64_SHA256,
  KEYTAR_SIGNING_CODE_IDENTIFIER,
  KEYTAR_SIGNING_TEAM_IDENTIFIER,
  contributionDeviceDurableAddArguments,
  contributionDeviceReaderRequirement,
  contributionDeviceReaderRequirementVerificationArguments,
  createExportIdentityKeychainBackend,
  deleteExportIdentityKeychainItemByAttributes,
  exportIdentityKeychainAttributeDeleteArguments,
  exportIdentityKeychainAttributeProbeArguments,
  exportIdentityKeychainCapabilitiesForEnvironment,
  exportIdentityKeychainItemPresenceByAttributes,
  keytarSignedBindingRequirement,
  keytarSignedBindingVerificationArguments,
  loadExportIdentityKeychainBinding,
} from "./export-identity-keychain.js";
export {
  MACOS_KEYCHAIN_BROKER_CAPABILITY_NAMES,
  macOSKeychainBrokerCapabilityName,
} from "./keychain-capabilities.js";
// The contribution-device Keychain broker is deliberately absent: it lives at
// src/contribution-device-keychain-broker.js with the other contribution
// modules, not under this owner. This barrel is the reviewed platform-adapter
// public API, and everything reachable through it is in the local-review
// artifact's graph — which its source policy forbids any contribution-* module
// from entering (scripts/build-local-review-artifact.js,
// FORBIDDEN_SOURCE_BASENAMES). A platform-owned broker could only be reached
// through here, so the owner boundary and the review boundary would fight.
export {
  readOwnerOnlyLocalMetadataBundlePair,
  sha256Hex,
} from "./local-metadata-bundle-files.js";
export {
  readExportCompatibilityArtifactSet,
} from "./export-compatibility-artifacts.js";
export {
  ClaudeCallbackLifecycleError,
  createClaudeCallbackLifecycleContext,
} from "./claude-callback-lifecycle.js";
export {
  createExportSetVerificationStorageContext,
} from "./export-set-verification-storage.js";
export {
  createOwnerOnlyExportArtifactStorageContext,
} from "./owner-only-export-artifact-storage.js";
export {
  createOwnerOnlyAutomaticContributionStorageContext,
} from "./owner-only-automatic-contribution-storage.js";
export {
  createOwnerOnlyExportDeletionStorage,
} from "./owner-only-export-deletion-storage.js";
export {
  createOwnerOnlyExportDeletionPreflightInspector,
} from "./owner-only-export-deletion-preflight.js";
export {
  createOwnerOnlyExportWorkspaceDiscardPreflight,
} from "./owner-only-export-workspace-discard-preflight.js";
export {
  createOwnerOnlyExportWorkspaceDiscardStorage,
} from "./owner-only-export-workspace-discard-storage.js";
export {
  createOwnerOnlyExportWorkspaceStorageContext,
} from "./owner-only-export-workspace-storage.js";
export {
  createOwnerOnlyExportWorkspaceLeaseContext,
} from "./owner-only-export-workspace-lease.js";
export {
  defaultActivityMarkerFile,
} from "./local-state-paths.js";
export {
  assertOwnerControlledDirectory,
  lstatIfExists,
  syncDirectory,
} from "./owner-only-filesystem.js";
export {
  defaultExportSecretFile,
  defaultExportStateDirectory,
  deriveAccountScopeId,
  deriveEventId,
  deriveEventOccurrenceId,
  deriveExportPseudonym,
  deriveExportPseudonymV2,
  deriveMarkerId,
  deriveMarkerOccurrenceId,
  deriveModelFingerprint,
  deriveParticipantId,
  deriveQuotaStateId,
  deriveSessionScopeId,
  deriveSnapshotId,
  deriveSnapshotObservationId,
  encodeParticipantSecret,
  inspectParticipantSecret,
  legacyWorkingDirectorySecretFile,
  loadOrCreateParticipantSecret,
  participantSecretBackendRetirementFile,
  participantSecretLegacyRetirementFile,
  randomBundleId,
  rotateParticipantSecret,
  withParticipantSecretLease,
} from "./participant-identity.js";
