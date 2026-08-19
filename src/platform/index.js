export {
  readBoundedJsonLines,
  readBoundedUtf8LineEntries,
  readBoundedUtf8Lines,
} from "./bounded-jsonl-reader.js";
export { readBoundedDirectoryEntries } from "./bounded-directory-reader.js";
export {
  CODEX_CONFIG_RETAINED_KEYS,
  CODEX_CONFIG_SERVICE_TIER_STATUSES,
  readCodexConfigServiceTier,
} from "./codex-config-service-tier.js";
export { createLocalCodexLogPorts } from "./local-codex-log-ports.js";
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
  assertWindowsFilesystemProductionSafe,
  createWindowsFilesystemAdapter,
  isWindowsFilesystemAdapter,
  isWindowsFilesystemIdentity,
} from "./windows-filesystem.js";
export {
  WINDOWS_PREPARED_ARTIFACT_STORAGE_CONTRACT_VERSION,
  WINDOWS_PREPARED_ARTIFACT_STORAGE_MAXIMUM_ARTIFACT_BYTES,
  WINDOWS_PREPARED_ARTIFACT_STORAGE_MAXIMUM_CONTRIBUTION_BYTES,
  WINDOWS_PREPARED_ARTIFACT_STORAGE_MAXIMUM_DIRECTORY_ENTRIES,
  WINDOWS_PREPARED_ARTIFACT_STORAGE_PRODUCTION_SAFE,
  WINDOWS_PREPARED_ARTIFACT_STORAGE_READINESS,
  WINDOWS_PREPARED_ARTIFACT_STORAGE_SAFE,
  WindowsPreparedArtifactStorageError,
  createWindowsPreparedArtifactStorageContext,
  isWindowsPreparedArtifactStorage,
  isWindowsPreparedArtifactStorageError,
} from "./windows-prepared-artifact-storage.js";
export {
  WINDOWS_PROTECTED_STATE_STORE_CONTRACT_VERSION,
  WINDOWS_PROTECTED_STATE_STORE_DEFAULT_MAX_BYTES,
  WINDOWS_PROTECTED_STATE_STORE_LEASE_VERSION,
  WINDOWS_PROTECTED_STATE_STORE_NATIVE_READ_BOUNDED,
  WINDOWS_PROTECTED_STATE_STORE_ROOT_BINDING_SAFE,
  WindowsProtectedStateStoreError,
  createWindowsProtectedStateStore,
  isWindowsProtectedStateStore,
  isWindowsProtectedStateStoreError,
} from "./windows-protected-state-store.js";
export {
  WINDOWS_SQLITE_STATE_SESSION_PRODUCTION_SAFE,
  createWindowsSqliteStateSession,
  isWindowsSqliteStateDatabase,
  isWindowsSqliteStateSession,
} from "./windows-sqlite-state-session.js";
export {
  WINDOWS_SQLITE_STATE_STAGING_CONTRACT_VERSION,
  WINDOWS_SQLITE_STATE_STAGING_SAFE,
  WindowsSqliteStateStagingError,
  createWindowsSqliteStateStaging,
  isWindowsSqliteStateStaging,
} from "./windows-sqlite-state-staging.js";
export {
  LOCAL_COLLECTOR_STATE_SESSION_BOUNDARY_CONTRACT_VERSION,
  currentLocalCollectorStateSessionBoundary,
  isLocalCollectorStateWindowsBoundaryActive,
  openLocalCollectorStateSessionBoundary,
  withLocalCollectorStateSessionBoundary,
} from "./local-collector-state-session.js";
export {
  CONTRIBUTION_DEVICE_READER_CODE_IDENTIFIER,
  CONTRIBUTION_DEVICE_READER_TEAM_IDENTIFIER,
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
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
  exportIdentityKeychainItemPresenceByAttributes,
  keytarSignedBindingRequirement,
  keytarSignedBindingVerificationArguments,
  loadExportIdentityKeychainBinding,
} from "./export-identity-keychain.js";
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
  buildClaudeCallbackRunnerInvocation,
  ClaudeCallbackLifecycleError,
  createClaudeCallbackLifecycleContext,
  selectClaudeCallbackRunner,
  validateClaudeCallbackRunner,
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
  WINDOWS_COMPANION_INSTANCE_MUTEX_CONTRACT_VERSION,
  WindowsCompanionInstanceLeaseError,
  createWindowsCompanionInstanceLeaseContext,
  isWindowsCompanionInstanceLeaseContext,
  isWindowsCompanionInstanceLeaseError,
} from "./windows-companion-instance-lease.js";
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
