import assert from "node:assert/strict";
import test from "node:test";

import {
  createLocalExportResourceContext,
} from "../src/application/index.js";
import {
  ExportResourceLimitError,
} from "../src/export/index.js";
import * as platform from "../src/platform/index.js";

const PLATFORM_PUBLIC_EXPORTS = Object.freeze([
  "CODEX_CONFIG_RETAINED_KEYS",
  "CODEX_CONFIG_SERVICE_TIER_STATUSES",
  "CONTRIBUTION_DEVICE_READER_CODE_IDENTIFIER",
  "CONTRIBUTION_DEVICE_READER_TEAM_IDENTIFIER",
  "ClaudeCallbackLifecycleError",
  "EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES",
  "ExportIdentityKeychainError",
  "KEYTAR_DARWIN_ARM64_SHA256",
  "KEYTAR_SIGNING_CODE_IDENTIFIER",
  "KEYTAR_SIGNING_TEAM_IDENTIFIER",
  "LOCAL_COLLECTOR_STATE_SESSION_BOUNDARY_CONTRACT_VERSION",
  "WINDOWS_BINDING_PROVENANCE_CONTRACT_VERSION",
  "WINDOWS_COMPANION_INSTANCE_MUTEX_CONTRACT_VERSION",
  "WINDOWS_CONTRIBUTION_SYNC_QUEUE_STORAGE_CONTRACT_VERSION",
  "WINDOWS_CONTRIBUTION_SYNC_QUEUE_STORAGE_PRODUCTION_SAFE",
  "WINDOWS_CONTRIBUTION_SYNC_QUEUE_STORAGE_READINESS",
  "WINDOWS_ELECTRON_QUALIFICATION_ENVIRONMENT_VALUE",
  "WINDOWS_ELECTRON_QUALIFICATION_ENVIRONMENT_VARIABLE",
  "WINDOWS_ELECTRON_QUALIFICATION_MODE_CONTRACT_VERSION",
  "WINDOWS_ELECTRON_QUALIFICATION_TEST_LANE",
  "WINDOWS_PREPARED_ARTIFACT_STORAGE_CONTRACT_VERSION",
  "WINDOWS_PREPARED_ARTIFACT_STORAGE_MAXIMUM_ARTIFACT_BYTES",
  "WINDOWS_PREPARED_ARTIFACT_STORAGE_MAXIMUM_CONTRIBUTION_BYTES",
  "WINDOWS_PREPARED_ARTIFACT_STORAGE_MAXIMUM_DIRECTORY_ENTRIES",
  "WINDOWS_PREPARED_ARTIFACT_STORAGE_PRODUCTION_SAFE",
  "WINDOWS_PREPARED_ARTIFACT_STORAGE_READINESS",
  "WINDOWS_PREPARED_ARTIFACT_STORAGE_SAFE",
  "WINDOWS_PRODUCTION_READINESS",
  "WINDOWS_PRODUCTION_READINESS_CONTRACT_VERSION",
  "WINDOWS_PRODUCTION_READINESS_FACTS",
  "WINDOWS_PROTECTED_STATE_STORE_CONTRACT_VERSION",
  "WINDOWS_PROTECTED_STATE_STORE_DEFAULT_MAX_BYTES",
  "WINDOWS_PROTECTED_STATE_STORE_LEASE_VERSION",
  "WINDOWS_PROTECTED_STATE_STORE_NATIVE_READ_BOUNDED",
  "WINDOWS_PROTECTED_STATE_STORE_ROOT_BINDING_SAFE",
  "WINDOWS_QUALIFICATION_MODE_ACCOUNTING_SOURCE_MODE",
  "WINDOWS_QUALIFICATION_MODE_CONTRACT_VERSION",
  "WINDOWS_QUALIFICATION_MODE_ENVIRONMENT_VALUE",
  "WINDOWS_QUALIFICATION_MODE_ENVIRONMENT_VARIABLE",
  "WINDOWS_QUALIFICATION_MODE_PRODUCTION_SAFE",
  "WINDOWS_QUALIFICATION_MODE_QUALIFICATION_ONLY",
  "WINDOWS_QUALIFICATION_MODE_TEST_LANE",
  "WINDOWS_QUALIFICATION_MODE_TEST_LANE_ENVIRONMENT_VARIABLE",
  "WINDOWS_REVIEW_PAIR_STORAGE_CONTRACT_VERSION",
  "WINDOWS_REVIEW_PAIR_STORAGE_MAXIMUM_BUNDLE_BYTES",
  "WINDOWS_REVIEW_PAIR_STORAGE_MAXIMUM_RECEIPT_BYTES",
  "WINDOWS_REVIEW_PAIR_STORAGE_PRODUCTION_SAFE",
  "WINDOWS_REVIEW_PAIR_STORAGE_READINESS",
  "WINDOWS_REVIEW_PAIR_STORAGE_SAFE",
  "WINDOWS_SQLITE_STATE_SESSION_PRODUCTION_SAFE",
  "WINDOWS_SQLITE_STATE_STAGING_CONTRACT_VERSION",
  "WINDOWS_SQLITE_STATE_STAGING_SAFE",
  "WindowsCompanionInstanceLeaseError",
  "WindowsPreparedArtifactStorageError",
  "WindowsProductionReadinessError",
  "WindowsProtectedStateStoreError",
  "WindowsQualificationModeError",
  "WindowsReviewPairStorageError",
  "WindowsSqliteStateStagingError",
  "assertOwnerControlledDirectory",
  "assertWindowsFilesystemProductionSafe",
  "assertWindowsProductionBackend",
  "assertWindowsProductionReadiness",
  "assertWindowsQualificationResourceAuthority",
  "buildClaudeCallbackRunnerInvocation",
  "contributionDeviceDurableAddArguments",
  "contributionDeviceReaderRequirement",
  "contributionDeviceReaderRequirementVerificationArguments",
  "createClaudeCallbackLifecycleContext",
  "createExportIdentityKeychainBackend",
  "createExportSetVerificationStorageContext",
  "createLocalCodexLogPorts",
  "createLocalContributionSyncQueueStorageContext",
  "createLocalExportSourcePorts",
  "createOwnerOnlyAutomaticContributionStorageContext",
  "createOwnerOnlyExportArtifactStorageContext",
  "createOwnerOnlyExportDeletionPreflightInspector",
  "createOwnerOnlyExportDeletionStorage",
  "createOwnerOnlyExportWorkspaceDiscardPreflight",
  "createOwnerOnlyExportWorkspaceDiscardStorage",
  "createOwnerOnlyExportWorkspaceLeaseContext",
  "createOwnerOnlyExportWorkspaceStorageContext",
  "createWindowsCompanionInstanceLeaseContext",
  "createWindowsContributionSyncQueuePreparedStoragePorts",
  "createWindowsFilesystemAdapter",
  "createWindowsPreparedArtifactStorageContext",
  "createWindowsProductionCapabilityBackend",
  "createWindowsProductionReadinessAttestation",
  "createWindowsProtectedStateStore",
  "createWindowsQualificationModeContext",
  "createWindowsQualificationStateSessionFactory",
  "createWindowsReviewPairStorageContext",
  "createWindowsSqliteStateSession",
  "createWindowsSqliteStateStaging",
  "currentLocalCollectorStateSessionBoundary",
  "defaultActivityMarkerFile",
  "defaultExportSecretFile",
  "defaultExportStateDirectory",
  "deleteExportIdentityKeychainItemByAttributes",
  "deriveAccountScopeId",
  "deriveEventId",
  "deriveEventOccurrenceId",
  "deriveExportPseudonym",
  "deriveExportPseudonymV2",
  "deriveMarkerId",
  "deriveMarkerOccurrenceId",
  "deriveModelFingerprint",
  "deriveParticipantId",
  "deriveQuotaStateId",
  "deriveSessionScopeId",
  "deriveSnapshotId",
  "deriveSnapshotObservationId",
  "encodeParticipantSecret",
  "exportIdentityKeychainAttributeDeleteArguments",
  "exportIdentityKeychainAttributeProbeArguments",
  "exportIdentityKeychainItemPresenceByAttributes",
  "inspectParticipantSecret",
  "isLocalCollectorStateWindowsBoundaryActive",
  "isWindowsCompanionInstanceLeaseContext",
  "isWindowsCompanionInstanceLeaseError",
  "isWindowsFilesystemAdapter",
  "isWindowsFilesystemIdentity",
  "isWindowsPreparedArtifactStorage",
  "isWindowsPreparedArtifactStorageError",
  "isWindowsProtectedStateStore",
  "isWindowsProtectedStateStoreError",
  "isWindowsQualificationModeContext",
  "isWindowsQualificationModeContextFor",
  "isWindowsQualificationModeError",
  "isWindowsReviewPairStorage",
  "isWindowsReviewPairStorageError",
  "isWindowsSqliteStateDatabase",
  "isWindowsSqliteStateSession",
  "isWindowsSqliteStateStaging",
  "keytarSignedBindingRequirement",
  "keytarSignedBindingVerificationArguments",
  "legacyWorkingDirectorySecretFile",
  "loadExportIdentityKeychainBinding",
  "loadOrCreateParticipantSecret",
  "localIsProxy",
  "localPlatformName",
  "lstatIfExists",
  "openLocalCollectorStateSessionBoundary",
  "participantSecretBackendRetirementFile",
  "participantSecretLegacyRetirementFile",
  "randomBundleId",
  "readBoundedDirectoryEntries",
  "readBoundedJsonLines",
  "readBoundedUtf8LineEntries",
  "readBoundedUtf8Lines",
  "readCodexConfigServiceTier",
  "readExportCompatibilityArtifactSet",
  "readOwnerOnlyLocalMetadataBundlePair",
  "rotateParticipantSecret",
  "selectClaudeCallbackRunner",
  "sha256Hex",
  "syncDirectory",
  "validateClaudeCallbackRunner",
  "withLocalCollectorStateSessionBoundary",
  "withParticipantSecretLease",
]);

test("platform adapters expose one exact reviewed public API", () => {
  assert.deepEqual(Object.keys(platform).sort(), [...PLATFORM_PUBLIC_EXPORTS]);
  for (const privateWindowsAdapter of [
    "KEYTAR_WIN32_X64_SHA256",
    "createWindowsCredentialManagerBackend",
    "loadAuditedWindowsCredentialBinding",
    "loadWindowsFilesystemBinding",
    "runWindowsCredentialManagerProbe",
  ]) {
    assert.equal(Object.hasOwn(platform, privateWindowsAdapter), false);
  }
});

test("local export resource context injects runtime ports and fixed marker limits", async () => {
  const calls = [];
  const context = createLocalExportResourceContext({
    readBoundedJsonLines: async (path, options) => {
      calls.push({ path, options });
      return [{ source: "fixture" }];
    },
    clock: () => 10,
    rss: () => 20,
  });

  const guard = context.createGuard();
  assert.equal(guard.snapshot().peakRssBytes, 20);
  assert.deepEqual(
    await context.readActivityMarkers("/private/activity.jsonl", {
      resourceGuard: guard,
    }),
    [{ source: "fixture" }],
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/private/activity.jsonl");
  assert.equal(calls[0].options.maximumFileBytes, 32 * 1024 * 1024);
  assert.equal(calls[0].options.maximumLineBytes, 16 * 1024 * 1024);
  assert.equal(calls[0].options.maximumRecords, 100_000);
  assert.equal(calls[0].options.resourceGuard, guard);
  const error = calls[0].options.createLimitError("line_bytes");
  assert.equal(error instanceof ExportResourceLimitError, true);
  assert.equal(error.code, "export_resource_line_bytes");
});

test("pure resource guards require explicit runtime ports", () => {
  assert.throws(
    () => createLocalExportResourceContext({
      readBoundedJsonLines: async () => [],
      clock: null,
      rss: () => 0,
    }),
    /clock must be a function/,
  );
});
