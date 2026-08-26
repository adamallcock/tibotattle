import {
  WINDOWS_PRODUCTION_FINALIZER_AZURE_ACCOUNT_NAME,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_CLIENT_ID,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_ENDPOINT,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_PROFILE_NAME,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_PUBLISHER_NAME,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_SUBSCRIPTION_ID,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_TENANT_ID,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_TIMESTAMP_URL,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_LOGIN_REFERENCE,
  WINDOWS_PRODUCTION_FINALIZER_CHECKOUT_REFERENCE,
  WINDOWS_PRODUCTION_FINALIZER_DOWNLOAD_ARTIFACT_REFERENCE,
  WINDOWS_PRODUCTION_FINALIZER_ELECTRON_BUILDER_VERSION,
  WINDOWS_PRODUCTION_FINALIZER_ENVIRONMENT,
  WINDOWS_PRODUCTION_FINALIZER_RUNNER,
  WINDOWS_PRODUCTION_FINALIZER_SETUP_NODE_REFERENCE,
  WINDOWS_PRODUCTION_FINALIZER_TRUSTEDSIGNING_VERSION,
} from "./windows-production-finalizer-workflow-contract.js";

/**
 * Closed policy for the protected, manually-approved Windows signed-candidate
 * workflow.  The preflight workflow is intentionally a different file and
 * remains signing-inactive.  This contract describes the candidate-producing
 * lane only; it never authorizes publication, update feeds, or retention.
 *
 * The candidate lane has two isolated jobs. `prepare` has no protected
 * environment and no OIDC permission. It builds an unsigned staging tree and
 * exposes only a bounded, content-free canonical manifest plus its SHA-256 as
 * job outputs. `sign` independently rebuilds that tree, matches the carried
 * manifest before Azure login, and is the only job allowed to receive the
 * protected environment and `id-token: write`. GitHub Actions grants that
 * permission for the whole `sign` job, not only for the late login step; the
 * policy records that job-wide capability explicitly.
 */

export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_POLICY_SCHEMA =
  "tibotattle-windows-production-signed-finalizer-workflow-policy-v1";
export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_POLICY_STATUS =
  "signed_candidate_implemented_unpublished";
export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_PATH =
  ".github/workflows/windows-production-finalizer-signed.yml";
export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_EVENT =
  "workflow_dispatch";
export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_NAME =
  "Windows production finalizer signed candidate";
export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_SCRIPT =
  "scripts/build-windows-production-finalizer-preparation-handoff.mjs";
export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_MAXIMUM_BYTES =
  256 * 1024;
export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_MAXIMUM_BASE64_BYTES =
  384 * 1024;
// GitHub Actions serializes job outputs into environment variables for the
// dependent job. Keep every manifest chunk well below the Windows environment
// variable limit, including room for the output key and runner encoding.
export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_CHUNK_MAXIMUM_BYTES =
  24 * 1024;
export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_CHUNK_COUNT =
  Math.ceil(
    WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_MAXIMUM_BASE64_BYTES
      / WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_CHUNK_MAXIMUM_BYTES,
  );
export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_DISPATCH_CONTEXT = Object.freeze({
  refExpression: "${{ github.ref }}",
  shaExpression: "${{ github.sha }}",
  expectedRef: "refs/heads/main",
  shaMustEqual: "${{ inputs.source_revision }}",
  validatedBeforeCheckout: true,
});
export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_METADATA_BINDING = Object.freeze({
  ref: "TIBOTATTLE_VALIDATED_FINALIZER_REF",
  headSha: "TIBOTATTLE_VALIDATED_FINALIZER_SHA",
  crossCheckedAgainstContext: true,
});
export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_RUNNER =
  WINDOWS_PRODUCTION_FINALIZER_RUNNER;
export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_ENVIRONMENT =
  WINDOWS_PRODUCTION_FINALIZER_ENVIRONMENT;
export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_CONCURRENCY = Object.freeze({
  group: "windows-production-finalizer-signed-${{ inputs.source_revision }}",
  cancelInProgress: false,
});
export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_CONFIRMATION_INPUT =
  "production_confirmation";
export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_CONFIRMATION_VALUE =
  "I UNDERSTAND THIS SIGNS A WINDOWS CANDIDATE";
export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_AZURE_OIDC_AUDIENCE =
  "api://AzureADTokenExchange";
export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_CLEANUP_PASSED_STATUS =
  "WINDOWS_SIGNED_FINALIZER_CLEANUP_PASSED";
export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_CLEANUP_REQUIRED_STATUS =
  "WINDOWS_SIGNED_FINALIZER_CLEANUP_REQUIRED";

export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_ACTIONS = Object.freeze({
  checkout: WINDOWS_PRODUCTION_FINALIZER_CHECKOUT_REFERENCE,
  setupNode: WINDOWS_PRODUCTION_FINALIZER_SETUP_NODE_REFERENCE,
  downloadArtifact: WINDOWS_PRODUCTION_FINALIZER_DOWNLOAD_ARTIFACT_REFERENCE,
  azureLogin: WINDOWS_PRODUCTION_FINALIZER_AZURE_LOGIN_REFERENCE,
});

export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_AZURE = Object.freeze({
  clientId: WINDOWS_PRODUCTION_FINALIZER_AZURE_CLIENT_ID,
  tenantId: WINDOWS_PRODUCTION_FINALIZER_AZURE_TENANT_ID,
  subscriptionId: WINDOWS_PRODUCTION_FINALIZER_AZURE_SUBSCRIPTION_ID,
  accountName: WINDOWS_PRODUCTION_FINALIZER_AZURE_ACCOUNT_NAME,
  profileName: WINDOWS_PRODUCTION_FINALIZER_AZURE_PROFILE_NAME,
  endpoint: WINDOWS_PRODUCTION_FINALIZER_AZURE_ENDPOINT,
  publisher: WINDOWS_PRODUCTION_FINALIZER_AZURE_PUBLISHER_NAME,
  timestampUrl: WINDOWS_PRODUCTION_FINALIZER_AZURE_TIMESTAMP_URL,
});

export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_VERSIONS = Object.freeze({
  electronBuilder: WINDOWS_PRODUCTION_FINALIZER_ELECTRON_BUILDER_VERSION,
  trustedSigning: WINDOWS_PRODUCTION_FINALIZER_TRUSTEDSIGNING_VERSION,
  node: "26.2.0",
  corepack: "0.34.0",
  pnpm: "11.9.0",
});

export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_ROOTS = Object.freeze({
  production: ".release-build/electron-production/windows-x64",
  app: ".release-build/electron-production/windows-x64/app",
  evidence: ".release-build/electron-production/windows-x64/evidence",
  artifacts: ".release-build/electron-production/windows-x64/artifacts",
  attemptPrefix: "tibotattle-windows-production-finalizer-signed-",
  azureConfig: "azure-config",
});

export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_RECEIPTS = Object.freeze({
  selection: "selection-receipt.json",
  handoff: "windows-finalizer-handoff-v2.json",
  sourceRun: "source-run.json",
  package: "package.json",
  policy: "policy.json",
  finalizer: "finalizer.json",
  presignInput: "windows-native-presign-input.json",
  nativePresign: "windows-native-presign-${revision}.json",
  authorityInput: "authority-input.json",
  authority: "authority.json",
  ledger: "windows-signing-operation-ledger.json",
  packagedArtifact: "packaged-artifact-receipt.json",
  installer: "installer-receipt.json",
  final: "windows-production-finalizer-receipt.json",
  preparationHandoff: "windows-production-finalizer-preparation-handoff.json",
  certificateSubjectPreflight: "certificate-subject-preflight.json",
});

export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_STAGE_ORDER = Object.freeze([
  "prepare-validate-dispatch",
  "prepare-prove-source-before-checkout",
  "prepare-checkout-exact-source",
  "prepare-install-toolchain",
  "prepare-build-unsigned-stage",
  "prepare-validate-provenance-and-handoff",
  "prepare-output-bounded-manifest",
  "prepare-cleanup",
  "sign-validate-dispatch",
  "sign-prove-source-before-checkout",
  "sign-checkout-exact-source",
  "sign-install-toolchain",
  "sign-validate-signing-environment",
  "sign-create-fresh-roots",
  "sign-select-and-download-source-evidence",
  "sign-install-frozen-dependencies",
  "sign-build-production-binding",
  "sign-stage-electron-app",
  "sign-revalidate-preparation-handoff",
  "sign-seed-canonical-evidence",
  "sign-build-presign-input",
  "sign-trusted-signing-module",
  "sign-azure-login",
  "sign-certificate-subject-preflight",
  "sign-native-presign",
  "sign-build-authority-input",
  "sign-run-authority-driver",
  "sign-electron-builder-nsis-x64",
  "sign-packaged-artifact-verifier",
  "sign-native-authenticode-installer-aggregate",
  "sign-verify-unpublished-not-run",
  "sign-cleanup",
]);

export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_PERMISSIONS = Object.freeze({
  contents: "read",
  actions: "read",
});
export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARE_PERMISSIONS = Object.freeze({
  contents: "read",
  actions: "read",
});
export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_SIGN_PERMISSIONS = Object.freeze({
  contents: "read",
  actions: "read",
  "id-token": "write",
});

const FORBIDDEN_TRIGGERS = Object.freeze([
  "push",
  "pull_request",
  "schedule",
  "workflow_call",
  "workflow_run",
]);

const FORBIDDEN_PUBLICATION_TOKENS = Object.freeze([
  "actions/upload-artifact",
  "actions/cache",
  "gh release",
  "softprops/action-gh-release",
  "update feed",
  "update-feed",
  "publish update",
  "selector",
  "npm version",
  "pnpm version",
  "git tag",
]);

const FORBIDDEN_DIAGNOSTIC_TOKENS = Object.freeze([
  "actions/upload-artifact",
  "diagnostic upload",
  "raw diagnostic",
  "GITHUB_STEP_SUMMARY",
]);

const FORBIDDEN_CREDENTIAL_ENVIRONMENT = Object.freeze([
  "CSC_LINK",
  "WIN_CSC_LINK",
  "CSC_KEY_PASSWORD",
  "WIN_CSC_KEY_PASSWORD",
  "CSC_NAME",
  "CSC_IDENTITY_AUTO_DISCOVERY",
  "CSC_FOR_PULL_REQUEST",
  "CSC_CERTIFICATE_FILE",
  "CSC_CERTIFICATE_PASSWORD",
  "WIN_CERTIFICATE_FILE",
  "WIN_CERTIFICATE_PASSWORD",
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_SUBSCRIPTION_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_CLIENT_CERTIFICATE_PATH",
  "AZURE_CLIENT_CERTIFICATE_PASSWORD",
  "AZURE_USERNAME",
  "AZURE_PASSWORD",
  "AZURE_FEDERATED_TOKEN_FILE",
  "AZURE_CODE_SIGNING_ACCOUNT_NAME",
  "AZURE_CODE_SIGNING_PROFILE_NAME",
  "AZURE_CODE_SIGNING_ENDPOINT",
  "AZURE_CODE_SIGNING_PUBLISHER_NAME",
  "AZURE_CODE_SIGNING_TIMESTAMP_URL",
  "AZURE_CREDENTIALS",
  "ARM_CLIENT_ID",
  "ARM_TENANT_ID",
  "ARM_SUBSCRIPTION_ID",
  "ARM_CLIENT_SECRET",
  "ARM_CLIENT_CERTIFICATE_PATH",
  "ARM_CLIENT_CERTIFICATE_PASSWORD",
  "ARM_USERNAME",
  "ARM_PASSWORD",
  "ARM_FEDERATED_TOKEN_FILE",
  "TIBOTATTLE_WINDOWS_PFX_PATH",
]);

const FORBIDDEN_CREDENTIAL_PATTERNS = Object.freeze([
  "(?:^|_)(?:WIN_)?CSC(?:_|$)",
  "(?:^|_)(?:PFX|P12)(?:_|$)",
  "(?:^|_)(?:AZURE|ARM)_(?:CLIENT_SECRET|CLIENT_CERTIFICATE|FEDERATED_TOKEN)(?:_|$)",
]);

export const WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_POLICY = deepFreeze({
  schemaVersion: WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_POLICY_SCHEMA,
  status: WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_POLICY_STATUS,
  workflow: {
    name: WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_NAME,
    path: WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_PATH,
    event: WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_EVENT,
    forbiddenTriggers: FORBIDDEN_TRIGGERS,
    runner: WINDOWS_PRODUCTION_SIGNED_FINALIZER_RUNNER,
    environment: WINDOWS_PRODUCTION_SIGNED_FINALIZER_ENVIRONMENT,
    permissions: WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_PERMISSIONS,
    preparePermissions: WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARE_PERMISSIONS,
    signPermissions: WINDOWS_PRODUCTION_SIGNED_FINALIZER_SIGN_PERMISSIONS,
    concurrency: WINDOWS_PRODUCTION_SIGNED_FINALIZER_CONCURRENCY,
  },
  dispatch: {
    inputs: {
      source_run_id: { type: "string", required: true },
      source_revision: { type: "string", required: true },
      source_ref: { type: "string", required: true },
      [WINDOWS_PRODUCTION_SIGNED_FINALIZER_CONFIRMATION_INPUT]: {
        type: "string",
        required: true,
        exact: WINDOWS_PRODUCTION_SIGNED_FINALIZER_CONFIRMATION_VALUE,
      },
    },
    sourceRef: "refs/heads/main",
    sourceRevisionPattern: "^[0-9a-f]{40}$",
    sourceRunIdPattern: "^[1-9][0-9]{0,19}$",
    actualDispatchContext: WINDOWS_PRODUCTION_SIGNED_FINALIZER_DISPATCH_CONTEXT,
    finalizerMetadataBinding: WINDOWS_PRODUCTION_SIGNED_FINALIZER_METADATA_BINDING,
  },
  actions: WINDOWS_PRODUCTION_SIGNED_FINALIZER_ACTIONS,
  versions: WINDOWS_PRODUCTION_SIGNED_FINALIZER_VERSIONS,
  azure: {
    values: WINDOWS_PRODUCTION_SIGNED_FINALIZER_AZURE,
    oidcPermissionIsWorkflowWide: false,
    signingJobOidcPermissionIsJobWide: true,
    prepareJobCanMintOidcToken: false,
    signingJobCanMintOidcToken: true,
    azureCliSessionEstablishedLate: true,
    reviewedSourceTrustBoundary:
      "protected_environment_approval_plus_exact_source_provenance",
    variablesValidatedBeforeReleaseConfigImport: true,
    forbiddenEnvironment: FORBIDDEN_CREDENTIAL_ENVIRONMENT,
    forbiddenEnvironmentPatterns: FORBIDDEN_CREDENTIAL_PATTERNS,
    configDirectoryIsAttemptScoped: true,
    audience: WINDOWS_PRODUCTION_SIGNED_FINALIZER_AZURE_OIDC_AUDIENCE,
  },
  roots: WINDOWS_PRODUCTION_SIGNED_FINALIZER_ROOTS,
  receipts: WINDOWS_PRODUCTION_SIGNED_FINALIZER_RECEIPTS,
  stageOrder: WINDOWS_PRODUCTION_SIGNED_FINALIZER_STAGE_ORDER,
  execution: {
    jobCount: 2,
    artifactUpload: "absent",
    cache: "absent",
    preparationManifest: "bounded-base64-job-output-chunks",
    preparationManifestMaximumBytes: WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_MAXIMUM_BYTES,
    preparationManifestMaximumBase64Bytes:
      WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_MAXIMUM_BASE64_BYTES,
    preparationManifestChunkMaximumBytes:
      WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_CHUNK_MAXIMUM_BYTES,
    preparationManifestChunkCount:
      WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_CHUNK_COUNT,
    preparationManifestBinding: "authority-input-authority-manifest-final-receipt",
    noBinaryTransfer: true,
    jobBoundary: "prepare-needs-sign",
  },
  cleanup: {
    passedStatus: WINDOWS_PRODUCTION_SIGNED_FINALIZER_CLEANUP_PASSED_STATUS,
    requiredStatus: WINDOWS_PRODUCTION_SIGNED_FINALIZER_CLEANUP_REQUIRED_STATUS,
    rootsMustBeAbsoluteUnderFixedParent: true,
    rejectRootReparsePoint: true,
    rejectDescendantReparsePoint: true,
    rejectUnexpectedCanonicalSpelling: true,
    rejectReplacementMarkers: true,
    nativeReparseQualification: "required_before_production_claim",
  },
  posture: {
    publish: "never",
    artifactUpload: "absent",
    releasePublication: "absent",
    updateFeed: "absent",
    selector: "disabled",
    versionBump: "absent",
    retainSignedCandidate: "absent",
    installedLifecycle: "not_run",
    productionReady: false,
    finalReceiptContentFree: true,
  },
  forbiddenPublicationTokens: FORBIDDEN_PUBLICATION_TOKENS,
  forbiddenDiagnosticTokens: FORBIDDEN_DIAGNOSTIC_TOKENS,
  forbiddenCredentialEnvironment: FORBIDDEN_CREDENTIAL_ENVIRONMENT,
  forbiddenCredentialPatterns: FORBIDDEN_CREDENTIAL_PATTERNS,
});

export class WindowsProductionSignedFinalizerWorkflowPolicyError extends Error {
  constructor() {
    super("Windows production signed finalizer workflow policy is invalid");
    this.name = "WindowsProductionSignedFinalizerWorkflowPolicyError";
    this.code = "windows_production_signed_finalizer_workflow_policy_invalid";
  }
}

function fail() {
  throw new WindowsProductionSignedFinalizerWorkflowPolicyError();
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function exactRecord(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => !keys.includes(key))) fail();
}

export function validateWindowsProductionSignedFinalizerWorkflowPolicy(
  value = WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_POLICY,
) {
  if (value !== WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_POLICY) {
    fail();
  }
  if (!Object.isFrozen(value)) fail();
  if (value.workflow.permissions["id-token"] !== undefined
      || value.workflow.runner !== "windows-2025"
      || value.workflow.environment !== "windows-production-signing"
      || value.workflow.concurrency.cancelInProgress !== false
      || value.posture.publish !== "never"
      || value.posture.productionReady !== false
      || value.posture.installedLifecycle !== "not_run") fail();
  if (value.azure.oidcPermissionIsWorkflowWide !== false
      || value.azure.signingJobOidcPermissionIsJobWide !== true
      || value.azure.prepareJobCanMintOidcToken !== false
      || value.azure.signingJobCanMintOidcToken !== true
      || value.azure.azureCliSessionEstablishedLate !== true
      || value.azure.reviewedSourceTrustBoundary
        !== "protected_environment_approval_plus_exact_source_provenance"
      || value.azure.audience !== WINDOWS_PRODUCTION_SIGNED_FINALIZER_AZURE_OIDC_AUDIENCE
      || value.execution.jobCount !== 2
      || value.execution.artifactUpload !== "absent"
      || value.execution.cache !== "absent"
      || value.execution.preparationManifest !== "bounded-base64-job-output-chunks"
      || value.execution.preparationManifestMaximumBytes
        !== WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_MAXIMUM_BYTES
      || value.execution.preparationManifestMaximumBase64Bytes
        !== WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_MAXIMUM_BASE64_BYTES
      || value.execution.preparationManifestChunkMaximumBytes
        !== WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_CHUNK_MAXIMUM_BYTES
      || value.execution.preparationManifestChunkCount
        !== WINDOWS_PRODUCTION_SIGNED_FINALIZER_PREPARATION_CHUNK_COUNT
      || value.execution.preparationManifestBinding
        !== "authority-input-authority-manifest-final-receipt"
      || value.execution.noBinaryTransfer !== true
      || value.execution.jobBoundary !== "prepare-needs-sign"
      || value.cleanup.requiredStatus
        !== WINDOWS_PRODUCTION_SIGNED_FINALIZER_CLEANUP_REQUIRED_STATUS
      || value.cleanup.nativeReparseQualification
        !== "required_before_production_claim") fail();
  if (value.dispatch.inputs[WINDOWS_PRODUCTION_SIGNED_FINALIZER_CONFIRMATION_INPUT].exact
      !== WINDOWS_PRODUCTION_SIGNED_FINALIZER_CONFIRMATION_VALUE) fail();
  exactRecord(value.dispatch.actualDispatchContext, [
    "refExpression",
    "shaExpression",
    "expectedRef",
    "shaMustEqual",
    "validatedBeforeCheckout",
  ]);
  for (const [key, expected] of Object.entries(WINDOWS_PRODUCTION_SIGNED_FINALIZER_DISPATCH_CONTEXT)) {
    if (value.dispatch.actualDispatchContext[key] !== expected) fail();
  }
  exactRecord(value.dispatch.finalizerMetadataBinding, [
    "ref",
    "headSha",
    "crossCheckedAgainstContext",
  ]);
  for (const [key, expected] of Object.entries(WINDOWS_PRODUCTION_SIGNED_FINALIZER_METADATA_BINDING)) {
    if (value.dispatch.finalizerMetadataBinding[key] !== expected) fail();
  }
  exactRecord(value.dispatch.inputs, [
    "source_run_id",
    "source_revision",
    "source_ref",
    WINDOWS_PRODUCTION_SIGNED_FINALIZER_CONFIRMATION_INPUT,
  ]);
  exactRecord(value.workflow.permissions, ["contents", "actions"]);
  exactRecord(value.workflow.preparePermissions, ["contents", "actions"]);
  exactRecord(value.workflow.signPermissions, ["contents", "actions", "id-token"]);
  exactRecord(value.azure.values, [
    "clientId",
    "tenantId",
    "subscriptionId",
    "accountName",
    "profileName",
    "endpoint",
    "publisher",
    "timestampUrl",
  ]);
  exactRecord(value.execution, [
    "jobCount",
    "artifactUpload",
    "cache",
    "preparationManifest",
    "preparationManifestMaximumBytes",
    "preparationManifestMaximumBase64Bytes",
    "preparationManifestChunkMaximumBytes",
    "preparationManifestChunkCount",
    "preparationManifestBinding",
    "noBinaryTransfer",
    "jobBoundary",
  ]);
  exactRecord(value.cleanup, [
    "passedStatus",
    "requiredStatus",
    "rootsMustBeAbsoluteUnderFixedParent",
    "rejectRootReparsePoint",
    "rejectDescendantReparsePoint",
    "rejectUnexpectedCanonicalSpelling",
    "rejectReplacementMarkers",
    "nativeReparseQualification",
  ]);
  deepFreeze(value);
  return value;
}

export function validateWindowsProductionSignedFinalizerActionReference(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/u.test(value)) {
    fail();
  }
  return value;
}

function normalizeCleanupPath(value) {
  return value.replaceAll("\\", "/").replace(/\/+$/u, "");
}

/**
 * Portable representation of the cleanup gate. The real workflow performs
 * the equivalent checks with PowerShell against the runner's filesystem;
 * this pure seam keeps the fail-closed boundary testable on macOS/Linux.
 */
export function validateWindowsProductionSignedFinalizerCleanupRoot(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const expectedKeys = [
    "path",
    "parent",
    "canonical",
    "exists",
    "reparse",
    "descendantReparse",
    "replacementMarker",
  ];
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length
      || keys.some((key) => !expectedKeys.includes(key))) fail();
  if (value.exists !== true) return true;
  for (const key of ["path", "parent", "canonical"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) fail();
  }
  const path = normalizeCleanupPath(value.path);
  const parent = normalizeCleanupPath(value.parent);
  const canonical = normalizeCleanupPath(value.canonical);
  const absolute = /^(?:[A-Za-z]:\/|\/)/u;
  if (!absolute.test(path) || !absolute.test(parent) || !absolute.test(canonical)
      || path !== canonical
      || path === parent
      || !path.startsWith(`${parent}/`)
      || value.reparse !== false
      || value.descendantReparse !== false
      || value.replacementMarker !== false) {
    fail();
  }
  return true;
}

validateWindowsProductionSignedFinalizerWorkflowPolicy();
