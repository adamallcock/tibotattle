import assert from "node:assert/strict";
import test from "node:test";

import {
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_ACTIONS,
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_AZURE_OIDC_AUDIENCE,
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_CLEANUP_REQUIRED_STATUS,
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_CONFIRMATION_INPUT,
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_CONFIRMATION_VALUE,
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_DISPATCH_CONTEXT,
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_METADATA_BINDING,
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_MAXIMUM_BASE64_BYTES,
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_MAXIMUM_BYTES,
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_CHUNK_COUNT,
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_CHUNK_MAXIMUM_BYTES,
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_SCRIPT,
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARE_PERMISSIONS,
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_SIGN_PERMISSIONS,
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_PERMISSIONS,
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_POLICY,
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_POLICY_SCHEMA,
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_POLICY_STATUS,
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_PATH,
  WindowsProductionSignedFinalizerWorkflowPolicyError,
  validateWindowsProductionSignedFinalizerActionReference,
  validateWindowsProductionSignedFinalizerCleanupRoot,
  validateWindowsProductionSignedFinalizerWorkflowPolicy,
} from "../config/windows-production-signed-finalizer-workflow-contract.js";

function assertDeepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

test("signed finalizer policy is closed, frozen, and permanently unpublished", () => {
  const policy = WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_POLICY;
  assertDeepFrozen(policy);
  assert.equal(policy.schemaVersion, WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_POLICY_SCHEMA);
  assert.equal(policy.status, WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_POLICY_STATUS);
  assert.equal(policy.workflow.path, WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_PATH);
  assert.equal(policy.workflow.event, "workflow_dispatch");
  assert.equal(policy.workflow.runner, "windows-2025");
  assert.equal(policy.workflow.environment, "windows-production-signing");
  assert.deepEqual(policy.workflow.permissions, WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_PERMISSIONS);
  assert.deepEqual(policy.workflow.preparePermissions, WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARE_PERMISSIONS);
  assert.deepEqual(policy.workflow.signPermissions, WINDOWS_PRODUCTION_SIGNED_FINALIZER_SIGN_PERMISSIONS);
  assert.deepEqual(policy.workflow.concurrency, {
    group: "windows-production-finalizer-signed-${{ inputs.source_revision }}",
    cancelInProgress: false,
  });
  assert.deepEqual(Object.keys(policy.dispatch.inputs).sort(), [
    "production_confirmation",
    "source_ref",
    "source_revision",
    "source_run_id",
  ]);
  assert.equal(
    policy.dispatch.inputs[WINDOWS_PRODUCTION_SIGNED_FINALIZER_CONFIRMATION_INPUT].exact,
    WINDOWS_PRODUCTION_SIGNED_FINALIZER_CONFIRMATION_VALUE,
  );
  assert.deepEqual(
    policy.dispatch.actualDispatchContext,
    WINDOWS_PRODUCTION_SIGNED_FINALIZER_DISPATCH_CONTEXT,
  );
  assert.deepEqual(
    policy.dispatch.finalizerMetadataBinding,
    WINDOWS_PRODUCTION_SIGNED_FINALIZER_METADATA_BINDING,
  );
  assert.equal(policy.dispatch.actualDispatchContext.validatedBeforeCheckout, true);
  assert.equal(policy.dispatch.actualDispatchContext.expectedRef, "refs/heads/main");
  assert.equal(
    policy.dispatch.actualDispatchContext.shaMustEqual,
    "${{ inputs.source_revision }}",
  );
  assert.equal(
    policy.dispatch.finalizerMetadataBinding.crossCheckedAgainstContext,
    true,
  );
  assert.equal(policy.posture.publish, "never");
  assert.equal(policy.posture.artifactUpload, "absent");
  assert.equal(policy.posture.releasePublication, "absent");
  assert.equal(policy.posture.updateFeed, "absent");
  assert.equal(policy.posture.selector, "disabled");
  assert.equal(policy.posture.versionBump, "absent");
  assert.equal(policy.posture.retainSignedCandidate, "absent");
  assert.equal(policy.posture.productionReady, false);
  assert.equal(policy.posture.installedLifecycle, "not_run");
  assert.deepEqual(policy.stageOrder.slice(-5), [
    "sign-electron-builder-nsis-x64",
    "sign-packaged-artifact-verifier",
    "sign-native-authenticode-installer-aggregate",
    "sign-verify-unpublished-not-run",
    "sign-cleanup",
  ]);
  assert.equal(Object.hasOwn(policy.receipts, "authenticode"), false);
  assert.equal(policy.receipts.installer, "installer-receipt.json");
  assert.equal(policy.receipts.final, "windows-production-finalizer-receipt.json");
  assert.equal(policy.azure.oidcPermissionIsWorkflowWide, false);
  assert.equal(policy.azure.signingJobOidcPermissionIsJobWide, true);
  assert.equal(policy.azure.prepareJobCanMintOidcToken, false);
  assert.equal(policy.azure.signingJobCanMintOidcToken, true);
  assert.equal(policy.azure.azureCliSessionEstablishedLate, true);
  assert.equal(
    policy.azure.reviewedSourceTrustBoundary,
    "protected_environment_approval_plus_exact_source_provenance",
  );
  assert.equal(policy.azure.audience, WINDOWS_PRODUCTION_SIGNED_FINALIZER_AZURE_OIDC_AUDIENCE);
  assert.equal(policy.azure.variablesValidatedBeforeReleaseConfigImport, true);
  assert.equal(policy.azure.configDirectoryIsAttemptScoped, true);
  assert.deepEqual(policy.execution, {
    jobCount: 2,
    artifactUpload: "absent",
    cache: "absent",
    preparationManifest: "bounded-base64-job-output-chunks",
    preparationManifestMaximumBytes: WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_MAXIMUM_BYTES,
    preparationManifestMaximumBase64Bytes: WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_MAXIMUM_BASE64_BYTES,
    preparationManifestChunkMaximumBytes: WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_CHUNK_MAXIMUM_BYTES,
    preparationManifestChunkCount: WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_CHUNK_COUNT,
    preparationManifestBinding: "authority-input-authority-manifest-final-receipt",
    noBinaryTransfer: true,
    jobBoundary: "prepare-needs-sign",
  });
  assert.equal(WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_SCRIPT,
    "scripts/build-windows-production-finalizer-preparation-handoff.mjs");
  assert.equal(WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_CHUNK_MAXIMUM_BYTES, 24 * 1024);
  assert.equal(WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_CHUNK_COUNT, 16);
  assert.equal(policy.cleanup.requiredStatus, WINDOWS_PRODUCTION_SIGNED_FINALIZER_CLEANUP_REQUIRED_STATUS);
  assert.equal(validateWindowsProductionSignedFinalizerWorkflowPolicy(), policy);
});

test("signed workflow action references are exact full commit SHAs", () => {
  for (const reference of Object.values(WINDOWS_PRODUCTION_SIGNED_FINALIZER_ACTIONS)) {
    assert.equal(validateWindowsProductionSignedFinalizerActionReference(reference), reference);
    assert.match(reference, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/u);
  }
  assert.equal(
    WINDOWS_PRODUCTION_SIGNED_FINALIZER_ACTIONS.azureLogin,
    "azure/login@f5d393ae46f8fde4be8b75f32e3fc50e654ad0ca",
  );
});

test("the policy validator fails closed for a different object", () => {
  assert.throws(
    () => validateWindowsProductionSignedFinalizerWorkflowPolicy(
      structuredClone(WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_POLICY),
    ),
    (error) => error instanceof WindowsProductionSignedFinalizerWorkflowPolicyError
      && error.code === "windows_production_signed_finalizer_workflow_policy_invalid",
  );
});

test("portable cleanup seam accepts only exact resolved descendants without hazards", () => {
  const safe = {
    path: "/runner/_temp/tibotattle-attempt",
    parent: "/runner/_temp",
    canonical: "/runner/_temp/tibotattle-attempt",
    exists: true,
    reparse: false,
    descendantReparse: false,
    replacementMarker: false,
  };
  assert.equal(validateWindowsProductionSignedFinalizerCleanupRoot(safe), true);
  for (const drift of [
    { ...safe, canonical: "/runner/_temp/other" },
    { ...safe, path: "/runner/_temp" },
    { ...safe, path: "/outside/tibotattle-attempt" },
    { ...safe, reparse: true },
    { ...safe, descendantReparse: true },
    { ...safe, replacementMarker: true },
  ]) {
    assert.throws(
      () => validateWindowsProductionSignedFinalizerCleanupRoot(drift),
      (error) => error instanceof WindowsProductionSignedFinalizerWorkflowPolicyError,
    );
  }
  assert.equal(validateWindowsProductionSignedFinalizerCleanupRoot({
    ...safe,
    exists: false,
  }), true);
});
