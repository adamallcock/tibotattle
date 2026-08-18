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
  "assertOwnerControlledDirectory",
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
  "inspectParticipantSecret",
  "keytarSignedBindingRequirement",
  "keytarSignedBindingVerificationArguments",
  "legacyWorkingDirectorySecretFile",
  "loadExportIdentityKeychainBinding",
  "loadOrCreateParticipantSecret",
  "localIsProxy",
  "localPlatformName",
  "lstatIfExists",
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
  "sha256Hex",
  "syncDirectory",
  "withParticipantSecretLease",
]);

test("platform adapters expose one exact reviewed public API", () => {
  assert.deepEqual(Object.keys(platform).sort(), [...PLATFORM_PUBLIC_EXPORTS]);
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
