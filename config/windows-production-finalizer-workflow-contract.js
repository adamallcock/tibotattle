import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Closed policy for the protected Windows production-finalizer preflight and
 * the future signed promotion workflow.
 *
 * The checked-in workflow implements only a provenance/build/preflight lane.
 * Signing promotion remains deliberately unimplemented and must stay
 * separate from this preflight posture.
 */

export const WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY_SCHEMA =
  "tibotattle-windows-production-finalizer-workflow-policy-v2";
export const WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY_STATUS =
  "preflight_implemented_signing_inactive";
export const WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_IMPLEMENTATION_STATUS =
  "signing_workflow_not_implemented";
export const WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POSTURE = Object.freeze({
  mode: "preflight_only",
  oidcPermission: "absent",
  azureLogin: "absent",
  signingInvocation: "absent",
  artifactUpload: "absent",
});
export const WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_PATH =
  ".github/workflows/windows-production-finalizer.yml";
export const WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_EVENT =
  "workflow_dispatch";
export const WINDOWS_PRODUCTION_FINALIZER_RUNNER = "windows-2025";
export const WINDOWS_PRODUCTION_FINALIZER_ENVIRONMENT =
  "windows-production-signing";
export const WINDOWS_PRODUCTION_FINALIZER_AZURE_CLIENT_ID =
  "b7f8b18a-4338-40cb-a53a-6a05499be330";
export const WINDOWS_PRODUCTION_FINALIZER_AZURE_TENANT_ID =
  "485c1020-7234-4307-88ee-67294114f087";
export const WINDOWS_PRODUCTION_FINALIZER_AZURE_SUBSCRIPTION_ID =
  "8f6118f5-3c88-433d-a2c2-9f4b2aef8b23";
export const WINDOWS_PRODUCTION_FINALIZER_AZURE_ACCOUNT_NAME =
  "tibotattlesigning";
export const WINDOWS_PRODUCTION_FINALIZER_AZURE_PROFILE_NAME =
  "tibotattle-windows-public";
export const WINDOWS_PRODUCTION_FINALIZER_AZURE_ENDPOINT =
  "https://eus.codesigning.azure.net/";
export const WINDOWS_PRODUCTION_FINALIZER_AZURE_PUBLISHER_NAME =
  "Adam Allcock";
export const WINDOWS_PRODUCTION_FINALIZER_AZURE_TIMESTAMP_URL =
  "http://timestamp.acs.microsoft.com";
export const WINDOWS_PRODUCTION_FINALIZER_AZURE_FEDERATED_ISSUER =
  "https://token.actions.githubusercontent.com";
export const WINDOWS_PRODUCTION_FINALIZER_AZURE_FEDERATED_AUDIENCE =
  "api://AzureADTokenExchange";
export const WINDOWS_PRODUCTION_FINALIZER_AZURE_GITHUB_ORG_ID = "92055994";
export const WINDOWS_PRODUCTION_FINALIZER_AZURE_GITHUB_REPOSITORY_ID =
  "1311335567";
export const WINDOWS_PRODUCTION_FINALIZER_AZURE_ROLE_NAME =
  "Artifact Signing Certificate Profile Signer";
export const WINDOWS_PRODUCTION_FINALIZER_AZURE_ROLE_SCOPE =
  "/subscriptions/8f6118f5-3c88-433d-a2c2-9f4b2aef8b23/resourceGroups/TiboTattle/providers/Microsoft.CodeSigning/codeSigningAccounts/tibotattlesigning/certificateProfiles/tibotattle-windows-public";
export const WINDOWS_PRODUCTION_FINALIZER_AZURE_FEDERATED_SUBJECT =
  "repo:adamallcock@92055994/tibotattle@1311335567:environment:windows-production-signing";
export const WINDOWS_PRODUCTION_FINALIZER_AZURE_REQUIRED_REVIEWER =
  "adamallcock";
export const WINDOWS_PRODUCTION_FINALIZER_ELECTRON_BUILDER_VERSION =
  "26.15.7";
export const WINDOWS_PRODUCTION_FINALIZER_TRUSTEDSIGNING_VERSION = "0.5.0";
export const WINDOWS_PRODUCTION_FINALIZER_AZURE_LOGIN_REFERENCE =
  "azure/login@f5d393ae46f8fde4be8b75f32e3fc50e654ad0ca";
export const WINDOWS_PRODUCTION_FINALIZER_CHECKOUT_REFERENCE =
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
export const WINDOWS_PRODUCTION_FINALIZER_SETUP_NODE_REFERENCE =
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
export const WINDOWS_PRODUCTION_FINALIZER_DOWNLOAD_ARTIFACT_REFERENCE =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
export const WINDOWS_PRODUCTION_FINALIZER_UPLOAD_ARTIFACT_REFERENCE =
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";

const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const ACTION_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SOURCE_RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const SOURCE_REF = "refs/heads/main";
const SOURCE_REF_PATTERN = /^refs\/heads\/main$/u;
const FULL_COMMIT_SHA_PATTERN_SOURCE = "^[0-9a-f]{40}$";
const SOURCE_RUN_ID_PATTERN_SOURCE = "^[1-9][0-9]{0,19}$";
const SOURCE_REVISION_PATTERN_SOURCE = "^[0-9a-f]{40}$";
const SOURCE_REPOSITORY = "adamallcock/tibotattle";
const SOURCE_WORKFLOW = ".github/workflows/windows-portability.yml";
const SOURCE_STATUS = "completed";
const SOURCE_CONCLUSION = "success";
const SOURCE_EVENT = "workflow_dispatch";
const SOURCE_RUN_ID_EXPRESSION = "${{ inputs.source_run_id }}";
const SOURCE_REVISION_EXPRESSION = "${{ inputs.source_revision }}";
const SOURCE_SELECTED_RUN_NORMALIZED_FIELD_SOURCES = Object.freeze({
  id: "sourceRun.id",
  head_sha: "sourceRun.head_sha",
  run_attempt: "sourceRun.run_attempt",
});
const SOURCE_SELECTED_RUN_INPUT_BINDINGS = Object.freeze({
  id: "sourceRun.id === Number(inputs.source_run_id)",
  head_sha: "sourceRun.head_sha === inputs.source_revision",
  run_attempt:
    "Number.isSafeInteger(sourceRun.run_attempt) && sourceRun.run_attempt >= 1",
});
const SOURCE_SELECTED_RUN_KEYS = Object.freeze([
  "normalizedFields",
  "inputBindings",
  "boundBeforeReceiptParse",
]);
const SOURCE_SELECTED_RUN_FIELD_KEYS = Object.freeze([
  "id",
  "head_sha",
  "run_attempt",
]);
const SOURCE_RUN_ATTEMPT_SOURCE = "sourceRun.run_attempt";
const SOURCE_ARTIFACT_ID_SOURCE =
  "github.rest.actions.getArtifact.artifact.id";
const SOURCE_ARTIFACT_DIGEST_SOURCE =
  "github.rest.actions.getArtifact.artifact.digest";
const SOURCE_ARTIFACT_NAME_SOURCE =
  "github.rest.actions.getArtifact.artifact.name";
const SOURCE_ARTIFACT_EXPIRED_SOURCE =
  "github.rest.actions.getArtifact.artifact.expired";
const SOURCE_ARTIFACT_SIZE_SOURCE =
  "github.rest.actions.getArtifact.artifact.size_in_bytes";
const SOURCE_ARTIFACT_WORKFLOW_RUN_ID_SOURCE =
  "github.rest.actions.getArtifact.artifact.workflow_run.id";
const SOURCE_ARTIFACT_WORKFLOW_RUN_HEAD_SHA_SOURCE =
  "github.rest.actions.getArtifact.artifact.workflow_run.head_sha";
const SOURCE_RAW_RECEIPT_SHA256_SOURCE =
  "sha256(raw_receipt_bytes_before_json_parse)";
const SOURCE_RAW_ARTIFACT_METADATA_SHA256_SOURCE =
  "sha256(raw_artifact_metadata_bytes_before_json_parse)";
const SOURCE_ARTIFACT_DIGEST_PATTERN_SOURCE = "^sha256:[0-9a-f]{64}$";
const SOURCE_RECEIPT_SIZE_MINIMUM_EXCLUSIVE = 0;
const SOURCE_RECEIPT_SIZE_MAXIMUM_INCLUSIVE = 16_777_216;
const SOURCE_RECEIPT_SIZE_SOURCE =
  "raw_receipt_bytes_before_json_parse.byteLength";
const SOURCE_ARTIFACT_DIGEST_MATCH_SOURCE =
  "artifact.digest === 'sha256:' + sha256(raw_receipt_bytes_before_json_parse)";
const SOURCE_RECEIPT_SHA256_MATCH_SOURCE =
  "artifact.rawReceiptSha256 === sha256(raw_receipt_bytes_before_json_parse)";
const SOURCE_DIGESTS_CHECKED_BEFORE_PARSE = true;
const SOURCE_ARTIFACT_NAME_TEMPLATE =
  "tibotattle-windows-electron-qualification-${runId}-${runAttempt}-${revision}-${cacheMode}.json";
const SOURCE_UPLOAD_STEP_ID = "windows_qualification_receipt_raw_upload";
const SOURCE_UPLOAD_RAW_PATH =
  "${{ env.TIBOTATTLE_WINDOWS_QUALIFICATION_RECEIPT_RAW_PATH }}";
const SOURCE_UPLOAD_NAME =
  "${{ env.TIBOTATTLE_WINDOWS_QUALIFICATION_RECEIPT_BASENAME }}";
const SOURCE_UPLOAD_BASENAME_SOURCE =
  "TIBOTATTLE_WINDOWS_QUALIFICATION_RECEIPT_BASENAME";
const SOURCE_UPLOAD_WORKFLOW_BASENAME_TEMPLATE =
  "tibotattle-windows-electron-qualification-${{ github.run_id }}-${{ github.run_attempt }}-${{ github.sha }}-${{ matrix.cache-mode }}.json";
const SOURCE_UPLOAD_DIGEST_OUTPUT =
  "steps.windows_qualification_receipt_raw_upload.outputs['artifact-digest']";
const SOURCE_UPLOAD_DIGEST_PATTERN = "^[0-9a-f]{64}$";
const SOURCE_UPLOAD_DIGEST_FORMAT = "bare_sha256_hex";
const SOURCE_UPLOAD_DIGEST_EQUALITY_SOURCE =
  "upload_artifact_digest === sha256(raw_receipt_bytes_before_json_parse)";
const SOURCE_UPLOAD_DIGEST_VALIDATION_STEP_NAME =
  "Validate raw Windows x64 qualification receipt handoff";
const SOURCE_WORKFLOW_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SOURCE_ARTIFACT_DOWNLOAD_KEYS = Object.freeze([
  "cacheMode",
  "reference",
  "artifactIds",
  "artifactIdsSource",
  "repository",
  "runId",
  "githubToken",
  "digestMismatch",
  "path",
  "destinationMustBeAbsentBeforeDownload",
  "mergeMultiple",
  "skipDecompress",
]);
const SOURCE_ARTIFACT_DOWNLOADS = Object.freeze([
  {
    cacheMode: "warm",
    reference: WINDOWS_PRODUCTION_FINALIZER_DOWNLOAD_ARTIFACT_REFERENCE,
    artifactIds:
      "${{ steps.select_warm_receipt_artifact.outputs.artifact-id }}",
    artifactIdsSource: "selectedArtifacts.warm.id",
    repository: SOURCE_REPOSITORY,
    runId: SOURCE_RUN_ID_EXPRESSION,
    githubToken: "${{ github.token }}",
    digestMismatch: "error",
    path:
      "${{ runner.temp }}/tibotattle-windows-production-finalizer-receipts/warm",
    destinationMustBeAbsentBeforeDownload: true,
    mergeMultiple: false,
    skipDecompress: false,
  },
  {
    cacheMode: "clean",
    reference: WINDOWS_PRODUCTION_FINALIZER_DOWNLOAD_ARTIFACT_REFERENCE,
    artifactIds:
      "${{ steps.select_clean_receipt_artifact.outputs.artifact-id }}",
    artifactIdsSource: "selectedArtifacts.clean.id",
    repository: SOURCE_REPOSITORY,
    runId: SOURCE_RUN_ID_EXPRESSION,
    githubToken: "${{ github.token }}",
    digestMismatch: "error",
    path:
      "${{ runner.temp }}/tibotattle-windows-production-finalizer-receipts/clean",
    destinationMustBeAbsentBeforeDownload: true,
    mergeMultiple: false,
    skipDecompress: false,
  },
]);

const TOP_LEVEL_KEYS = Object.freeze([
  "schemaVersion",
  "status",
  "workflowStatus",
  "workflowPosture",
  "workflowPath",
  "trigger",
  "signingJob",
  "concurrency",
  "dispatch",
  "actionPinning",
  "checkout",
  "setupNode",
  "sourceEvidence",
  "azure",
  "versions",
]);
const SIGNING_JOB_KEYS = Object.freeze([
  "runsOn",
  "environment",
  "permissions",
]);
const WORKFLOW_POSTURE_KEYS = Object.freeze([
  "mode",
  "oidcPermission",
  "azureLogin",
  "signingInvocation",
  "artifactUpload",
]);
const CONCURRENCY_KEYS = Object.freeze(["group", "cancelInProgress"]);
const PERMISSIONS_KEYS = Object.freeze(["contents", "actions", "id-token"]);
const DISPATCH_KEYS = Object.freeze(["event", "inputs", "validation"]);
const INPUT_NAMES = Object.freeze([
  "source_run_id",
  "source_revision",
  "source_ref",
]);
const INPUT_SHAPE_KEYS = Object.freeze(["type", "required"]);
const VALIDATION_KEYS = Object.freeze([
  "source_run_id",
  "source_revision",
  "source_ref",
]);
const VALIDATION_RUN_ID_KEYS = Object.freeze(["pattern", "maxLength"]);
const VALIDATION_REVISION_KEYS = Object.freeze(["pattern", "maxLength"]);
const VALIDATION_REF_KEYS = Object.freeze(["exact", "pattern", "maxLength"]);
const ACTION_PINNING_KEYS = Object.freeze([
  "externalActionsMustUseFullCommitSha",
  "fullCommitShaPattern",
]);
const CHECKOUT_KEYS = Object.freeze([
  "reference",
  "ref",
  "fetchDepth",
  "persistCredentials",
  "verifyHead",
]);
const SETUP_NODE_KEYS = Object.freeze(["reference"]);
const SOURCE_EVIDENCE_KEYS = Object.freeze([
  "repository",
  "workflow",
  "status",
  "conclusion",
  "event",
  "ref",
  "selectedRun",
  "runId",
  "runAttempt",
  "revision",
  "rawArtifactMetadataHashedBeforeParse",
  "rawReceiptBytesHashedBeforeParse",
  "artifacts",
]);
const SOURCE_ARTIFACT_KEYS = Object.freeze([
  "requiredCacheModes",
  "requiredFields",
  "artifactNameTemplate",
  "artifactIdSource",
  "artifactDigestSource",
  "artifactNameSource",
  "sourceUpload",
  "artifactResponseFields",
  "downloadArtifacts",
  "receiptValidation",
  "rawArtifactMetadataSha256Source",
  "rawReceiptSha256Source",
]);
const SOURCE_UPLOAD_KEYS = Object.freeze([
  "stepId",
  "reference",
  "archive",
  "directSingleFile",
  "path",
  "name",
  "basenameSource",
  "basenameTemplate",
  "workflowBasenameTemplate",
  "digestOutput",
  "digestPattern",
  "digestFormat",
  "digestEqualitySource",
  "digestCheckedBeforePublication",
  "digestValidationStepName",
]);
const SOURCE_ARTIFACT_RESPONSE_FIELD_KEYS = Object.freeze([
  "id",
  "digest",
  "name",
  "expired",
  "size_in_bytes",
  "workflow_run.id",
  "workflow_run.head_sha",
]);
const SOURCE_RECEIPT_VALIDATION_KEYS = Object.freeze([
  "artifactDigestMatchSource",
  "artifactDigestPattern",
  "artifactDigestCheckedBeforeParse",
  "rawReceiptSha256MatchSource",
  "rawReceiptSizeSource",
  "rawReceiptSizeMinimumExclusive",
  "rawReceiptSizeMaximumInclusive",
  "rawReceiptBytesCheckedBeforeParse",
  "artifactExpired",
]);
const AZURE_KEYS = Object.freeze([
  "source",
  "variables",
  "login",
  "builderEnvironment",
  "forbiddenBuilderEnvironment",
  "forbiddenBuilderEnvironmentPatterns",
  "timestampValidation",
  "expectedIdentity",
  "runtimePreflight",
  "externalGovernance",
]);
const AZURE_VARIABLE_KEYS = Object.freeze([
  "clientId",
  "tenantId",
  "subscriptionId",
  "codeSigningAccountName",
  "certificateProfileName",
  "endpoint",
  "publisherName",
]);
const AZURE_LOGIN_KEYS = Object.freeze(["reference", "with"]);
const AZURE_LOGIN_WITH_KEYS = Object.freeze([
  "client-id",
  "tenant-id",
  "subscription-id",
  "audience",
  "enable-AzPSSession",
]);
const BUILDER_ENVIRONMENT_KEYS = Object.freeze([
  "TIBOTATTLE_ELECTRON_AZURE_CODE_SIGNING_ACCOUNT_NAME",
  "TIBOTATTLE_ELECTRON_AZURE_CERTIFICATE_PROFILE_NAME",
  "TIBOTATTLE_ELECTRON_AZURE_ENDPOINT",
  "TIBOTATTLE_ELECTRON_AZURE_PUBLISHER_NAME",
]);
const TIMESTAMP_VALIDATION_KEYS = Object.freeze([
  "source",
  "expected",
  "mode",
]);
const EXPECTED_IDENTITY_KEYS = Object.freeze([
  "clientId",
  "tenantId",
  "subscriptionId",
  "codeSigningAccountName",
  "certificateProfileName",
  "endpoint",
  "publisherName",
  "timestampRfc3161",
  "environment",
]);
const RUNTIME_PREFLIGHT_KEYS = Object.freeze([
  "requiredStatus",
  "moduleName",
  "requiredVersion",
  "credentialMode",
  "excludedCredentials",
  "timestampVariable",
  "timestampExpected",
  "timestampValidation",
  "forbiddenEnvironmentValidation",
  "validationBeforeBuilderImport",
]);
const EXTERNAL_GOVERNANCE_KEYS = Object.freeze([
  "status",
  "operatorRecheckRequiredBeforeFirstSigning",
  "issuer",
  "audience",
  "federatedSubject",
  "githubOrgId",
  "githubRepositoryId",
  "role",
  "githubEnvironment",
  "federatedCredentials",
  "clientSecrets",
  "certificates",
  "authenticodeSubject",
  "activationStopConditions",
]);
const GOVERNANCE_ROLE_KEYS = Object.freeze(["name", "scope"]);
const GOVERNANCE_ENVIRONMENT_KEYS = Object.freeze([
  "name",
  "requiredReviewer",
  "preventSelfReview",
  "administratorBypass",
]);
const GOVERNANCE_COUNT_KEYS = Object.freeze(["expectedCount"]);
const AUTHENTICODE_SUBJECT_KEYS = Object.freeze([
  "status",
  "exactDistinguishedName",
  "requiredEvidence",
  "ownerApprovalRequired",
  "promotionBlocked",
]);
const VERSIONS_KEYS = Object.freeze(["electronBuilder", "trustedSigning"]);

const AZURE_VARIABLES = Object.freeze({
  clientId: "AZURE_CLIENT_ID",
  tenantId: "AZURE_TENANT_ID",
  subscriptionId: "AZURE_SUBSCRIPTION_ID",
  codeSigningAccountName: "AZURE_CODE_SIGNING_ACCOUNT_NAME",
  certificateProfileName: "AZURE_CODE_SIGNING_PROFILE_NAME",
  endpoint: "AZURE_CODE_SIGNING_ENDPOINT",
  publisherName: "AZURE_CODE_SIGNING_PUBLISHER_NAME",
});

const AZURE_LOGIN_WITH = Object.freeze({
  "client-id": "${{ vars.AZURE_CLIENT_ID }}",
  "tenant-id": "${{ vars.AZURE_TENANT_ID }}",
  "subscription-id": "${{ vars.AZURE_SUBSCRIPTION_ID }}",
  audience: WINDOWS_PRODUCTION_FINALIZER_AZURE_FEDERATED_AUDIENCE,
  "enable-AzPSSession": false,
});

const BUILDER_ENVIRONMENT = Object.freeze({
  TIBOTATTLE_ELECTRON_AZURE_CODE_SIGNING_ACCOUNT_NAME:
    "${{ vars.AZURE_CODE_SIGNING_ACCOUNT_NAME }}",
  TIBOTATTLE_ELECTRON_AZURE_CERTIFICATE_PROFILE_NAME:
    "${{ vars.AZURE_CODE_SIGNING_PROFILE_NAME }}",
  TIBOTATTLE_ELECTRON_AZURE_ENDPOINT:
    "${{ vars.AZURE_CODE_SIGNING_ENDPOINT }}",
  TIBOTATTLE_ELECTRON_AZURE_PUBLISHER_NAME:
    "${{ vars.AZURE_CODE_SIGNING_PUBLISHER_NAME }}",
});

const FORBIDDEN_BUILDER_ENVIRONMENT = Object.freeze([
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
  "AZURE_CREDENTIALS",
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
const FORBIDDEN_BUILDER_ENVIRONMENT_PATTERNS = Object.freeze([
  "(?:^|_)(?:WIN_)?CSC(?:_|$)",
  "(?:^|_)(?:PFX|P12)(?:_|$)",
  "(?:^|_)(?:AZURE|ARM)_(?:CLIENT_SECRET|CLIENT_CERTIFICATE|FEDERATED_TOKEN)(?:_|$)",
]);

const EXPECTED_IDENTITY = Object.freeze({
  clientId: WINDOWS_PRODUCTION_FINALIZER_AZURE_CLIENT_ID,
  tenantId: WINDOWS_PRODUCTION_FINALIZER_AZURE_TENANT_ID,
  subscriptionId: WINDOWS_PRODUCTION_FINALIZER_AZURE_SUBSCRIPTION_ID,
  codeSigningAccountName: WINDOWS_PRODUCTION_FINALIZER_AZURE_ACCOUNT_NAME,
  certificateProfileName: WINDOWS_PRODUCTION_FINALIZER_AZURE_PROFILE_NAME,
  endpoint: WINDOWS_PRODUCTION_FINALIZER_AZURE_ENDPOINT,
  publisherName: WINDOWS_PRODUCTION_FINALIZER_AZURE_PUBLISHER_NAME,
  timestampRfc3161: WINDOWS_PRODUCTION_FINALIZER_AZURE_TIMESTAMP_URL,
  environment: WINDOWS_PRODUCTION_FINALIZER_ENVIRONMENT,
});

const TRUSTEDSIGNING_EXCLUDED_CREDENTIALS = Object.freeze([
  "ExcludeEnvironmentCredential",
  "ExcludeWorkloadIdentityCredential",
  "ExcludeManagedIdentityCredential",
  "ExcludeSharedTokenCacheCredential",
  "ExcludeVisualStudioCredential",
  "ExcludeVisualStudioCodeCredential",
  "ExcludeAzurePowerShellCredential",
  "ExcludeAzureDeveloperCliCredential",
  "ExcludeInteractiveBrowserCredential",
]);

const RUNTIME_PREFLIGHT = Object.freeze({
  requiredStatus: "WINDOWS_TRUSTEDSIGNING_PREFLIGHT_PASSED",
  moduleName: "TrustedSigning",
  requiredVersion: WINDOWS_PRODUCTION_FINALIZER_TRUSTEDSIGNING_VERSION,
  credentialMode: "azure-cli-only",
  excludedCredentials: TRUSTEDSIGNING_EXCLUDED_CREDENTIALS,
  timestampVariable: "AZURE_CODE_SIGNING_TIMESTAMP_URL",
  timestampExpected: WINDOWS_PRODUCTION_FINALIZER_AZURE_TIMESTAMP_URL,
  timestampValidation: "exact",
  forbiddenEnvironmentValidation: "complete_absence",
  validationBeforeBuilderImport: true,
});

const EXTERNAL_GOVERNANCE = Object.freeze({
  status: "supplied_configured_unexercised",
  operatorRecheckRequiredBeforeFirstSigning: true,
  issuer: WINDOWS_PRODUCTION_FINALIZER_AZURE_FEDERATED_ISSUER,
  audience: WINDOWS_PRODUCTION_FINALIZER_AZURE_FEDERATED_AUDIENCE,
  federatedSubject: WINDOWS_PRODUCTION_FINALIZER_AZURE_FEDERATED_SUBJECT,
  githubOrgId: WINDOWS_PRODUCTION_FINALIZER_AZURE_GITHUB_ORG_ID,
  githubRepositoryId:
    WINDOWS_PRODUCTION_FINALIZER_AZURE_GITHUB_REPOSITORY_ID,
  role: {
    name: WINDOWS_PRODUCTION_FINALIZER_AZURE_ROLE_NAME,
    scope: WINDOWS_PRODUCTION_FINALIZER_AZURE_ROLE_SCOPE,
  },
  githubEnvironment: {
    name: WINDOWS_PRODUCTION_FINALIZER_ENVIRONMENT,
    requiredReviewer: WINDOWS_PRODUCTION_FINALIZER_AZURE_REQUIRED_REVIEWER,
    preventSelfReview: false,
    administratorBypass: false,
  },
  federatedCredentials: { expectedCount: 1 },
  clientSecrets: { expectedCount: 0 },
  certificates: { expectedCount: 0 },
  authenticodeSubject: {
    status: "not_supplied_unverified",
    exactDistinguishedName: null,
    requiredEvidence: "protected_native_preflight",
    ownerApprovalRequired: true,
    promotionBlocked: true,
  },
  activationStopConditions: [
    "operator_recheck_external_identity_and_governance_before_first_signing",
    "stop_if_external_identity_or_governance_differs_from_exact_contract",
    "stop_until_protected_native_preflight_records_and_owner_approves_exact_authenticode_subject",
    "do_not_treat_supplied_state_as_runtime_verified",
  ],
});

const TIMESTAMP_VALIDATION = Object.freeze({
  source: "${{ vars.AZURE_CODE_SIGNING_TIMESTAMP_URL }}",
  expected: WINDOWS_PRODUCTION_FINALIZER_AZURE_TIMESTAMP_URL,
  mode: "validation_only",
});

const ERROR_MESSAGE =
  "Windows production finalizer workflow policy is invalid";

export class WindowsProductionFinalizerWorkflowPolicyError extends Error {
  constructor() {
    super(ERROR_MESSAGE);
    this.name = "WindowsProductionFinalizerWorkflowPolicyError";
    this.code = "windows_production_finalizer_workflow_policy_invalid";
  }
}

function fail() {
  throw new WindowsProductionFinalizerWorkflowPolicyError();
}

function isPlainRecord(value) {
  try {
    return value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function readRecord(value, expectedKeys) {
  if (!isPlainRecord(value)) fail();
  let ownKeys;
  let descriptors;
  try {
    ownKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail();
  }
  if (ownKeys.some((key) => typeof key !== "string")) fail();
  const expected = new Set(expectedKeys);
  if (ownKeys.length !== expectedKeys.length
      || ownKeys.some((key) => !expected.has(key))) {
    fail();
  }
  const result = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.get !== undefined
        || descriptor.set !== undefined
        || descriptor.enumerable !== true) {
      fail();
    }
    result[key] = descriptor.value;
  }
  return result;
}

function readArray(value) {
  let isCanonicalArray = false;
  try {
    isCanonicalArray = Array.isArray(value)
      && Object.getPrototypeOf(value) === Array.prototype;
  } catch {
    isCanonicalArray = false;
  }
  if (!isCanonicalArray) {
    fail();
  }
  let ownKeys;
  let descriptors;
  try {
    ownKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail();
  }
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, "value")
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.enumerable !== false
      || lengthDescriptor.get !== undefined
      || lengthDescriptor.set !== undefined) {
    fail();
  }
  const selectedLength = lengthDescriptor.value;
  if (ownKeys.some((key) => typeof key !== "string")
      || ownKeys.length !== selectedLength + 1) {
    fail();
  }
  const result = [];
  for (let index = 0; index < selectedLength; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.get !== undefined
        || descriptor.set !== undefined
        || descriptor.enumerable !== true) {
      fail();
    }
    result.push(descriptor.value);
  }
  if (ownKeys.some((key) => key !== "length"
      && !/^(?:0|[1-9][0-9]*)$/u.test(key))) fail();
  return result;
}

function requireExact(actual, expected) {
  if (actual !== expected) fail();
}

function requireString(value, pattern, maximumLength = 256) {
  if (typeof value !== "string"
      || value.length === 0
      || value.length > maximumLength
      || value.includes("\0")
      || !pattern.test(value)) {
    fail();
  }
}

function validateDispatchDefinition(value) {
  const dispatch = readRecord(value, DISPATCH_KEYS);
  requireExact(dispatch.event, WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_EVENT);

  const inputs = readRecord(dispatch.inputs, INPUT_NAMES);
  for (const name of INPUT_NAMES) {
    const shape = readRecord(inputs[name], INPUT_SHAPE_KEYS);
    requireExact(shape.type, "string");
    requireExact(shape.required, true);
  }

  const validation = readRecord(dispatch.validation, VALIDATION_KEYS);
  const runId = readRecord(
    validation.source_run_id,
    VALIDATION_RUN_ID_KEYS,
  );
  requireExact(runId.pattern, SOURCE_RUN_ID_PATTERN_SOURCE);
  requireExact(runId.maxLength, 20);

  const revision = readRecord(
    validation.source_revision,
    VALIDATION_REVISION_KEYS,
  );
  requireExact(revision.pattern, SOURCE_REVISION_PATTERN_SOURCE);
  requireExact(revision.maxLength, 40);

  const sourceRef = readRecord(validation.source_ref, VALIDATION_REF_KEYS);
  requireExact(sourceRef.exact, SOURCE_REF);
  requireExact(sourceRef.pattern, SOURCE_REF_PATTERN.source);
  requireExact(sourceRef.maxLength, SOURCE_REF.length);
}

function validateActionPinning(value) {
  const policy = readRecord(value, ACTION_PINNING_KEYS);
  requireExact(policy.externalActionsMustUseFullCommitSha, true);
  requireExact(policy.fullCommitShaPattern, FULL_COMMIT_SHA_PATTERN_SOURCE);
}

function validateCheckout(value) {
  const checkout = readRecord(value, CHECKOUT_KEYS);
  requireExact(
    checkout.reference,
    WINDOWS_PRODUCTION_FINALIZER_CHECKOUT_REFERENCE,
  );
  requireExact(checkout.ref, "${{ inputs.source_revision }}");
  requireExact(checkout.fetchDepth, 1);
  requireExact(checkout.persistCredentials, false);
  requireExact(checkout.verifyHead, true);
}

function validateSetupNode(value) {
  const setupNode = readRecord(value, SETUP_NODE_KEYS);
  requireExact(
    setupNode.reference,
    WINDOWS_PRODUCTION_FINALIZER_SETUP_NODE_REFERENCE,
  );
}

function validatePermissions(value) {
  const permissions = readRecord(value, PERMISSIONS_KEYS);
  requireExact(permissions.contents, "read");
  requireExact(permissions.actions, "read");
  requireExact(permissions["id-token"], "write");
}

function validateSigningJob(value) {
  const signingJob = readRecord(value, SIGNING_JOB_KEYS);
  requireExact(signingJob.runsOn, WINDOWS_PRODUCTION_FINALIZER_RUNNER);
  requireExact(signingJob.environment, WINDOWS_PRODUCTION_FINALIZER_ENVIRONMENT);
  validatePermissions(signingJob.permissions);
}

function validateWorkflowPosture(value) {
  const posture = readRecord(value, WORKFLOW_POSTURE_KEYS);
  for (const key of WORKFLOW_POSTURE_KEYS) {
    requireExact(posture[key], WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POSTURE[key]);
  }
}

function validateSelectedRun(value) {
  const selectedRun = readRecord(value, SOURCE_SELECTED_RUN_KEYS);
  const normalizedFields = readRecord(
    selectedRun.normalizedFields,
    SOURCE_SELECTED_RUN_FIELD_KEYS,
  );
  for (const [field, expected] of Object.entries(
    SOURCE_SELECTED_RUN_NORMALIZED_FIELD_SOURCES,
  )) {
    requireExact(normalizedFields[field], expected);
  }

  const inputBindings = readRecord(
    selectedRun.inputBindings,
    SOURCE_SELECTED_RUN_FIELD_KEYS,
  );
  for (const [field, expected] of Object.entries(SOURCE_SELECTED_RUN_INPUT_BINDINGS)) {
    requireExact(inputBindings[field], expected);
  }
  requireExact(selectedRun.boundBeforeReceiptParse, true);
}

function readSourceWorkflowText() {
  try {
    return readFileSync(
      resolve(SOURCE_WORKFLOW_ROOT, SOURCE_WORKFLOW),
      "utf8",
    );
  } catch {
    fail();
  }
}

function sourceWorkflowSection(workflow, startMarker, endMarker) {
  const start = workflow.indexOf(startMarker);
  const end = workflow.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0 || end <= start) fail();
  return { start, end, text: workflow.slice(start, end) };
}

export function validateWindowsProductionFinalizerSourceWorkflowGovernance(
  workflowText = readSourceWorkflowText(),
) {
  if (typeof workflowText !== "string") fail();

  const uploadStep = sourceWorkflowSection(
    workflowText,
    "      - name: Retain raw Windows x64 qualification receipt handoff",
    "\n      - name: Validate raw Windows x64 qualification receipt handoff",
  );
  const validationStep = sourceWorkflowSection(
    workflowText,
    `      - name: ${SOURCE_UPLOAD_DIGEST_VALIDATION_STEP_NAME}`,
    "\n      - name: Retain safe Windows Electron verifier failure evidence",
  );
  const basenameDeclaration =
    `TIBOTATTLE_WINDOWS_QUALIFICATION_RECEIPT_BASENAME: ${SOURCE_UPLOAD_WORKFLOW_BASENAME_TEMPLATE}`;

  if (!uploadStep.text.includes(`id: ${SOURCE_UPLOAD_STEP_ID}`)
      || !uploadStep.text.includes(
        `uses: ${WINDOWS_PRODUCTION_FINALIZER_UPLOAD_ARTIFACT_REFERENCE}`,
      )
      || !uploadStep.text.includes("archive: false")
      || !uploadStep.text.includes(`path: ${SOURCE_UPLOAD_RAW_PATH}`)
      || !uploadStep.text.includes(`name: ${SOURCE_UPLOAD_NAME}`)
      || uploadStep.text.includes("path: |")) {
    fail();
  }
  if (!workflowText.includes(basenameDeclaration)) fail();

  const digestOutput =
    `TIBOTATTLE_WINDOWS_QUALIFICATION_RECEIPT_ARTIFACT_DIGEST: \${{ ${SOURCE_UPLOAD_DIGEST_OUTPUT} }}`;
  if (!validationStep.text.includes(digestOutput)
      || !validationStep.text.includes(
        "artifactDigest -cnotmatch '^[0-9a-f]{64}$'",
      )
      || !validationStep.text.includes(
        "Get-FileHash -LiteralPath $receiptRawPath -Algorithm SHA256",
      )
      || !validationStep.text.includes(
        "$localDigest = (Get-FileHash -LiteralPath $receiptRawPath -Algorithm SHA256).Hash.ToLowerInvariant()",
      )
      || !validationStep.text.includes("$expectedDigest = $localDigest")
      || !validationStep.text.includes("artifactDigest -cne $expectedDigest")
      || validationStep.start <= uploadStep.start
      || validationStep.end > workflowText.indexOf(
        "\n      - name: Retain safe Windows Electron verifier failure evidence",
      )) {
    fail();
  }
  return true;
}

function validateSourceUpload(value) {
  const sourceUpload = readRecord(value, SOURCE_UPLOAD_KEYS);
  requireExact(sourceUpload.stepId, SOURCE_UPLOAD_STEP_ID);
  requireExact(
    sourceUpload.reference,
    WINDOWS_PRODUCTION_FINALIZER_UPLOAD_ARTIFACT_REFERENCE,
  );
  requireExact(sourceUpload.archive, false);
  requireExact(sourceUpload.directSingleFile, true);
  requireExact(sourceUpload.path, SOURCE_UPLOAD_RAW_PATH);
  requireExact(sourceUpload.name, SOURCE_UPLOAD_NAME);
  requireExact(sourceUpload.basenameSource, SOURCE_UPLOAD_BASENAME_SOURCE);
  requireExact(sourceUpload.basenameTemplate, SOURCE_ARTIFACT_NAME_TEMPLATE);
  requireExact(
    sourceUpload.workflowBasenameTemplate,
    SOURCE_UPLOAD_WORKFLOW_BASENAME_TEMPLATE,
  );
  requireExact(sourceUpload.digestOutput, SOURCE_UPLOAD_DIGEST_OUTPUT);
  requireExact(sourceUpload.digestPattern, SOURCE_UPLOAD_DIGEST_PATTERN);
  requireExact(sourceUpload.digestFormat, SOURCE_UPLOAD_DIGEST_FORMAT);
  requireExact(
    sourceUpload.digestEqualitySource,
    SOURCE_UPLOAD_DIGEST_EQUALITY_SOURCE,
  );
  requireExact(sourceUpload.digestCheckedBeforePublication, true);
  requireExact(
    sourceUpload.digestValidationStepName,
    SOURCE_UPLOAD_DIGEST_VALIDATION_STEP_NAME,
  );
  validateWindowsProductionFinalizerSourceWorkflowGovernance();
}

function validateArtifactDownloads(value) {
  const downloads = readArray(value);
  if (downloads.length !== SOURCE_ARTIFACT_DOWNLOADS.length) fail();
  for (let index = 0; index < downloads.length; index += 1) {
    const downloadArtifact = readRecord(
      downloads[index],
      SOURCE_ARTIFACT_DOWNLOAD_KEYS,
    );
    const expected = SOURCE_ARTIFACT_DOWNLOADS[index];
    for (const key of SOURCE_ARTIFACT_DOWNLOAD_KEYS) {
      requireExact(downloadArtifact[key], expected[key]);
    }
    validateWindowsProductionFinalizerActionReference(downloadArtifact.reference);
  }
}

function validateSourceEvidence(value) {
  const source = readRecord(value, SOURCE_EVIDENCE_KEYS);
  requireExact(source.repository, SOURCE_REPOSITORY);
  requireExact(source.workflow, SOURCE_WORKFLOW);
  requireExact(source.status, SOURCE_STATUS);
  requireExact(source.conclusion, SOURCE_CONCLUSION);
  requireExact(source.event, SOURCE_EVENT);
  requireExact(source.ref, SOURCE_REF);
  validateSelectedRun(source.selectedRun);
  requireExact(source.runId, SOURCE_RUN_ID_EXPRESSION);
  requireExact(source.runAttempt, SOURCE_RUN_ATTEMPT_SOURCE);
  requireExact(source.revision, SOURCE_REVISION_EXPRESSION);
  requireExact(source.rawArtifactMetadataHashedBeforeParse, true);
  requireExact(source.rawReceiptBytesHashedBeforeParse, true);

  const artifacts = readRecord(source.artifacts, SOURCE_ARTIFACT_KEYS);
  const requiredCacheModes = readArray(artifacts.requiredCacheModes);
  if (requiredCacheModes.length !== 2
      || requiredCacheModes[0] !== "warm"
      || requiredCacheModes[1] !== "clean") {
    fail();
  }
  const requiredFields = readArray(artifacts.requiredFields);
  const expectedFields = [
    "id",
    "digest",
    "name",
    "expired",
    "size_in_bytes",
    "workflow_run.id",
    "workflow_run.head_sha",
    "rawReceiptSha256",
  ];
  if (requiredFields.length !== expectedFields.length
      || requiredFields.some((field, index) => field !== expectedFields[index])) {
    fail();
  }
  requireExact(artifacts.artifactNameTemplate, SOURCE_ARTIFACT_NAME_TEMPLATE);
  requireExact(artifacts.artifactIdSource, SOURCE_ARTIFACT_ID_SOURCE);
  requireExact(artifacts.artifactDigestSource, SOURCE_ARTIFACT_DIGEST_SOURCE);
  requireExact(artifacts.artifactNameSource, SOURCE_ARTIFACT_NAME_SOURCE);
  validateSourceUpload(artifacts.sourceUpload);

  const artifactResponseFields = readRecord(
    artifacts.artifactResponseFields,
    SOURCE_ARTIFACT_RESPONSE_FIELD_KEYS,
  );
  requireExact(artifactResponseFields.id, SOURCE_ARTIFACT_ID_SOURCE);
  requireExact(artifactResponseFields.digest, SOURCE_ARTIFACT_DIGEST_SOURCE);
  requireExact(artifactResponseFields.name, SOURCE_ARTIFACT_NAME_SOURCE);
  requireExact(artifactResponseFields.expired, SOURCE_ARTIFACT_EXPIRED_SOURCE);
  requireExact(
    artifactResponseFields.size_in_bytes,
    SOURCE_ARTIFACT_SIZE_SOURCE,
  );
  requireExact(
    artifactResponseFields["workflow_run.id"],
    SOURCE_ARTIFACT_WORKFLOW_RUN_ID_SOURCE,
  );
  requireExact(
    artifactResponseFields["workflow_run.head_sha"],
    SOURCE_ARTIFACT_WORKFLOW_RUN_HEAD_SHA_SOURCE,
  );
  validateArtifactDownloads(artifacts.downloadArtifacts);

  const receiptValidation = readRecord(
    artifacts.receiptValidation,
    SOURCE_RECEIPT_VALIDATION_KEYS,
  );
  requireExact(
    receiptValidation.artifactDigestMatchSource,
    SOURCE_ARTIFACT_DIGEST_MATCH_SOURCE,
  );
  requireExact(
    receiptValidation.artifactDigestPattern,
    SOURCE_ARTIFACT_DIGEST_PATTERN_SOURCE,
  );
  requireExact(
    receiptValidation.artifactDigestCheckedBeforeParse,
    SOURCE_DIGESTS_CHECKED_BEFORE_PARSE,
  );
  requireExact(
    receiptValidation.rawReceiptSha256MatchSource,
    SOURCE_RECEIPT_SHA256_MATCH_SOURCE,
  );
  requireExact(
    receiptValidation.rawReceiptSizeSource,
    SOURCE_RECEIPT_SIZE_SOURCE,
  );
  requireExact(
    receiptValidation.rawReceiptSizeMinimumExclusive,
    SOURCE_RECEIPT_SIZE_MINIMUM_EXCLUSIVE,
  );
  requireExact(
    receiptValidation.rawReceiptSizeMaximumInclusive,
    SOURCE_RECEIPT_SIZE_MAXIMUM_INCLUSIVE,
  );
  requireExact(
    receiptValidation.rawReceiptBytesCheckedBeforeParse,
    SOURCE_DIGESTS_CHECKED_BEFORE_PARSE,
  );
  requireExact(receiptValidation.artifactExpired, false);
  requireExact(
    artifacts.rawArtifactMetadataSha256Source,
    SOURCE_RAW_ARTIFACT_METADATA_SHA256_SOURCE,
  );
  requireExact(
    artifacts.rawReceiptSha256Source,
    SOURCE_RAW_RECEIPT_SHA256_SOURCE,
  );
}

function validateExpectedIdentity(value) {
  const identity = readRecord(value, EXPECTED_IDENTITY_KEYS);
  for (const [key, expected] of Object.entries(EXPECTED_IDENTITY)) {
    requireExact(identity[key], expected);
  }
}

function validateRuntimePreflight(value) {
  const preflight = readRecord(value, RUNTIME_PREFLIGHT_KEYS);
  requireExact(preflight.requiredStatus, RUNTIME_PREFLIGHT.requiredStatus);
  requireExact(preflight.moduleName, RUNTIME_PREFLIGHT.moduleName);
  requireExact(preflight.requiredVersion, RUNTIME_PREFLIGHT.requiredVersion);
  requireExact(preflight.credentialMode, RUNTIME_PREFLIGHT.credentialMode);
  const excluded = readArray(preflight.excludedCredentials);
  if (excluded.length !== RUNTIME_PREFLIGHT.excludedCredentials.length
      || excluded.some((valueAtIndex, index) =>
        valueAtIndex !== RUNTIME_PREFLIGHT.excludedCredentials[index])) {
    fail();
  }
  requireExact(preflight.timestampVariable, RUNTIME_PREFLIGHT.timestampVariable);
  requireExact(preflight.timestampExpected, RUNTIME_PREFLIGHT.timestampExpected);
  requireExact(preflight.timestampValidation, RUNTIME_PREFLIGHT.timestampValidation);
  requireExact(
    preflight.forbiddenEnvironmentValidation,
    RUNTIME_PREFLIGHT.forbiddenEnvironmentValidation,
  );
  requireExact(
    preflight.validationBeforeBuilderImport,
    RUNTIME_PREFLIGHT.validationBeforeBuilderImport,
  );
}

function validateExternalGovernance(value) {
  const governance = readRecord(value, EXTERNAL_GOVERNANCE_KEYS);
  for (const key of [
    "status",
    "operatorRecheckRequiredBeforeFirstSigning",
    "issuer",
    "audience",
    "federatedSubject",
    "githubOrgId",
    "githubRepositoryId",
  ]) {
    requireExact(governance[key], EXTERNAL_GOVERNANCE[key]);
  }

  const role = readRecord(governance.role, GOVERNANCE_ROLE_KEYS);
  requireExact(role.name, EXTERNAL_GOVERNANCE.role.name);
  requireExact(role.scope, EXTERNAL_GOVERNANCE.role.scope);

  const githubEnvironment = readRecord(
    governance.githubEnvironment,
    GOVERNANCE_ENVIRONMENT_KEYS,
  );
  for (const key of GOVERNANCE_ENVIRONMENT_KEYS) {
    requireExact(githubEnvironment[key], EXTERNAL_GOVERNANCE.githubEnvironment[key]);
  }

  for (const key of ["federatedCredentials", "clientSecrets", "certificates"]) {
    const counts = readRecord(governance[key], GOVERNANCE_COUNT_KEYS);
    requireExact(counts.expectedCount, EXTERNAL_GOVERNANCE[key].expectedCount);
  }

  const authenticodeSubject = readRecord(
    governance.authenticodeSubject,
    AUTHENTICODE_SUBJECT_KEYS,
  );
  for (const key of AUTHENTICODE_SUBJECT_KEYS) {
    requireExact(
      authenticodeSubject[key],
      EXTERNAL_GOVERNANCE.authenticodeSubject[key],
    );
  }

  const stopConditions = readArray(governance.activationStopConditions);
  if (stopConditions.length !== EXTERNAL_GOVERNANCE.activationStopConditions.length
      || stopConditions.some((valueAtIndex, index) =>
        valueAtIndex !== EXTERNAL_GOVERNANCE.activationStopConditions[index])) {
    fail();
  }
}

function validateAzure(value) {
  const azure = readRecord(value, AZURE_KEYS);
  requireExact(azure.source, "github_environment_variables");

  const variables = readRecord(azure.variables, AZURE_VARIABLE_KEYS);
  for (const [key, expected] of Object.entries(AZURE_VARIABLES)) {
    requireExact(variables[key], expected);
  }

  const login = readRecord(azure.login, AZURE_LOGIN_KEYS);
  requireExact(login.reference, WINDOWS_PRODUCTION_FINALIZER_AZURE_LOGIN_REFERENCE);
  const loginWith = readRecord(login.with, AZURE_LOGIN_WITH_KEYS);
  for (const [key, expected] of Object.entries(AZURE_LOGIN_WITH)) {
    requireExact(loginWith[key], expected);
  }

  const builderEnvironment = readRecord(
    azure.builderEnvironment,
    BUILDER_ENVIRONMENT_KEYS,
  );
  for (const [key, expected] of Object.entries(BUILDER_ENVIRONMENT)) {
    requireExact(builderEnvironment[key], expected);
  }

  const forbidden = readArray(azure.forbiddenBuilderEnvironment);
  if (forbidden.length !== FORBIDDEN_BUILDER_ENVIRONMENT.length
      || forbidden.some((valueAtIndex, index) =>
        valueAtIndex !== FORBIDDEN_BUILDER_ENVIRONMENT[index])) {
    fail();
  }
  const forbiddenPatterns = readArray(
    azure.forbiddenBuilderEnvironmentPatterns,
  );
  if (forbiddenPatterns.length !== FORBIDDEN_BUILDER_ENVIRONMENT_PATTERNS.length
      || forbiddenPatterns.some((valueAtIndex, index) =>
        valueAtIndex !== FORBIDDEN_BUILDER_ENVIRONMENT_PATTERNS[index])) {
    fail();
  }
  if (Object.keys(builderEnvironment).some((key) => forbidden.includes(key))) {
    fail();
  }

  const timestampValidation = readRecord(
    azure.timestampValidation,
    TIMESTAMP_VALIDATION_KEYS,
  );
  requireExact(
    timestampValidation.source,
    TIMESTAMP_VALIDATION.source,
  );
  requireExact(
    timestampValidation.expected,
    TIMESTAMP_VALIDATION.expected,
  );
  requireExact(timestampValidation.mode, TIMESTAMP_VALIDATION.mode);
  validateExpectedIdentity(azure.expectedIdentity);
  validateRuntimePreflight(azure.runtimePreflight);
  validateExternalGovernance(azure.externalGovernance);
}

function validateVersions(value) {
  const versions = readRecord(value, VERSIONS_KEYS);
  requireExact(
    versions.electronBuilder,
    WINDOWS_PRODUCTION_FINALIZER_ELECTRON_BUILDER_VERSION,
  );
  requireExact(
    versions.trustedSigning,
    WINDOWS_PRODUCTION_FINALIZER_TRUSTEDSIGNING_VERSION,
  );
}

function validatePolicyShape(value) {
  const policy = readRecord(value, TOP_LEVEL_KEYS);
  requireExact(
    policy.schemaVersion,
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY_SCHEMA,
  );
  requireExact(
    policy.status,
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY_STATUS,
  );
  requireExact(
    policy.workflowStatus,
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_IMPLEMENTATION_STATUS,
  );
  validateWorkflowPosture(policy.workflowPosture);
  requireExact(policy.workflowPath, WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_PATH);
  requireExact(policy.trigger, WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_EVENT);
  validateSigningJob(policy.signingJob);

  const concurrency = readRecord(policy.concurrency, CONCURRENCY_KEYS);
  requireExact(
    concurrency.group,
    "windows-production-finalizer-${{ inputs.source_revision }}",
  );
  requireExact(concurrency.cancelInProgress, false);

  validateDispatchDefinition(policy.dispatch);
  validateActionPinning(policy.actionPinning);
  validateCheckout(policy.checkout);
  validateSetupNode(policy.setupNode);
  validateSourceEvidence(policy.sourceEvidence);
  validateAzure(policy.azure);
  validateVersions(policy.versions);
  return policy;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Reflect.ownKeys(value)) deepFreeze(value[child]);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

export const WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY = deepFreeze({
  schemaVersion: WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY_SCHEMA,
  status: WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY_STATUS,
  workflowStatus: WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_IMPLEMENTATION_STATUS,
  workflowPosture: WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POSTURE,
  workflowPath: WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_PATH,
  trigger: WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_EVENT,
  signingJob: {
    runsOn: WINDOWS_PRODUCTION_FINALIZER_RUNNER,
    environment: WINDOWS_PRODUCTION_FINALIZER_ENVIRONMENT,
    permissions: {
      contents: "read",
      actions: "read",
      "id-token": "write",
    },
  },
  concurrency: {
    group: "windows-production-finalizer-${{ inputs.source_revision }}",
    cancelInProgress: false,
  },
  dispatch: {
    event: WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_EVENT,
    inputs: {
      source_run_id: { type: "string", required: true },
      source_revision: { type: "string", required: true },
      source_ref: { type: "string", required: true },
    },
    validation: {
      source_run_id: {
        pattern: SOURCE_RUN_ID_PATTERN_SOURCE,
        maxLength: 20,
      },
      source_revision: {
        pattern: SOURCE_REVISION_PATTERN_SOURCE,
        maxLength: 40,
      },
      source_ref: {
        exact: SOURCE_REF,
        pattern: SOURCE_REF_PATTERN.source,
        maxLength: SOURCE_REF.length,
      },
    },
  },
  actionPinning: {
    externalActionsMustUseFullCommitSha: true,
    fullCommitShaPattern: FULL_COMMIT_SHA_PATTERN_SOURCE,
  },
  checkout: {
    reference: WINDOWS_PRODUCTION_FINALIZER_CHECKOUT_REFERENCE,
    ref: "${{ inputs.source_revision }}",
    fetchDepth: 1,
    persistCredentials: false,
    verifyHead: true,
  },
  setupNode: {
    reference: WINDOWS_PRODUCTION_FINALIZER_SETUP_NODE_REFERENCE,
  },
  sourceEvidence: {
    repository: SOURCE_REPOSITORY,
    workflow: SOURCE_WORKFLOW,
    status: SOURCE_STATUS,
    conclusion: SOURCE_CONCLUSION,
    event: SOURCE_EVENT,
    ref: SOURCE_REF,
    selectedRun: {
      normalizedFields: SOURCE_SELECTED_RUN_NORMALIZED_FIELD_SOURCES,
      inputBindings: SOURCE_SELECTED_RUN_INPUT_BINDINGS,
      boundBeforeReceiptParse: true,
    },
    runId: SOURCE_RUN_ID_EXPRESSION,
    runAttempt: SOURCE_RUN_ATTEMPT_SOURCE,
    revision: SOURCE_REVISION_EXPRESSION,
    rawArtifactMetadataHashedBeforeParse: true,
    rawReceiptBytesHashedBeforeParse: true,
    artifacts: {
      requiredCacheModes: ["warm", "clean"],
      requiredFields: [
        "id",
        "digest",
        "name",
        "expired",
        "size_in_bytes",
        "workflow_run.id",
        "workflow_run.head_sha",
        "rawReceiptSha256",
      ],
      artifactNameTemplate: SOURCE_ARTIFACT_NAME_TEMPLATE,
      artifactIdSource: SOURCE_ARTIFACT_ID_SOURCE,
      artifactDigestSource: SOURCE_ARTIFACT_DIGEST_SOURCE,
      artifactNameSource: SOURCE_ARTIFACT_NAME_SOURCE,
      sourceUpload: {
        stepId: SOURCE_UPLOAD_STEP_ID,
        reference: WINDOWS_PRODUCTION_FINALIZER_UPLOAD_ARTIFACT_REFERENCE,
        archive: false,
        directSingleFile: true,
        path: SOURCE_UPLOAD_RAW_PATH,
        name: SOURCE_UPLOAD_NAME,
        basenameSource: SOURCE_UPLOAD_BASENAME_SOURCE,
        basenameTemplate: SOURCE_ARTIFACT_NAME_TEMPLATE,
        workflowBasenameTemplate: SOURCE_UPLOAD_WORKFLOW_BASENAME_TEMPLATE,
        digestOutput: SOURCE_UPLOAD_DIGEST_OUTPUT,
        digestPattern: SOURCE_UPLOAD_DIGEST_PATTERN,
        digestFormat: SOURCE_UPLOAD_DIGEST_FORMAT,
        digestEqualitySource: SOURCE_UPLOAD_DIGEST_EQUALITY_SOURCE,
        digestCheckedBeforePublication: true,
        digestValidationStepName: SOURCE_UPLOAD_DIGEST_VALIDATION_STEP_NAME,
      },
      artifactResponseFields: {
        id: SOURCE_ARTIFACT_ID_SOURCE,
        digest: SOURCE_ARTIFACT_DIGEST_SOURCE,
        name: SOURCE_ARTIFACT_NAME_SOURCE,
        expired: SOURCE_ARTIFACT_EXPIRED_SOURCE,
        size_in_bytes: SOURCE_ARTIFACT_SIZE_SOURCE,
        "workflow_run.id": SOURCE_ARTIFACT_WORKFLOW_RUN_ID_SOURCE,
        "workflow_run.head_sha": SOURCE_ARTIFACT_WORKFLOW_RUN_HEAD_SHA_SOURCE,
      },
      downloadArtifacts: SOURCE_ARTIFACT_DOWNLOADS,
      receiptValidation: {
        artifactDigestMatchSource: SOURCE_ARTIFACT_DIGEST_MATCH_SOURCE,
        artifactDigestPattern: SOURCE_ARTIFACT_DIGEST_PATTERN_SOURCE,
        artifactDigestCheckedBeforeParse: SOURCE_DIGESTS_CHECKED_BEFORE_PARSE,
        rawReceiptSha256MatchSource: SOURCE_RECEIPT_SHA256_MATCH_SOURCE,
        rawReceiptSizeSource: SOURCE_RECEIPT_SIZE_SOURCE,
        rawReceiptSizeMinimumExclusive: SOURCE_RECEIPT_SIZE_MINIMUM_EXCLUSIVE,
        rawReceiptSizeMaximumInclusive: SOURCE_RECEIPT_SIZE_MAXIMUM_INCLUSIVE,
        rawReceiptBytesCheckedBeforeParse: SOURCE_DIGESTS_CHECKED_BEFORE_PARSE,
        artifactExpired: false,
      },
      rawArtifactMetadataSha256Source:
        SOURCE_RAW_ARTIFACT_METADATA_SHA256_SOURCE,
      rawReceiptSha256Source: SOURCE_RAW_RECEIPT_SHA256_SOURCE,
    },
  },
  azure: {
    source: "github_environment_variables",
    variables: AZURE_VARIABLES,
    login: {
      reference: WINDOWS_PRODUCTION_FINALIZER_AZURE_LOGIN_REFERENCE,
      with: AZURE_LOGIN_WITH,
    },
    builderEnvironment: BUILDER_ENVIRONMENT,
    forbiddenBuilderEnvironment: FORBIDDEN_BUILDER_ENVIRONMENT,
    forbiddenBuilderEnvironmentPatterns:
      FORBIDDEN_BUILDER_ENVIRONMENT_PATTERNS,
    timestampValidation: TIMESTAMP_VALIDATION,
    expectedIdentity: EXPECTED_IDENTITY,
    runtimePreflight: RUNTIME_PREFLIGHT,
    externalGovernance: EXTERNAL_GOVERNANCE,
  },
  versions: {
    electronBuilder: WINDOWS_PRODUCTION_FINALIZER_ELECTRON_BUILDER_VERSION,
    trustedSigning: WINDOWS_PRODUCTION_FINALIZER_TRUSTEDSIGNING_VERSION,
  },
});

export function validateWindowsProductionFinalizerWorkflowPolicy(
  value = WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY,
) {
  validatePolicyShape(value);
  return WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY;
}

export function isWindowsProductionFinalizerPinnedActionReference(value) {
  if (typeof value !== "string") return false;
  const at = value.lastIndexOf("@");
  if (at < 1 || at === value.length - 1) return false;
  const action = value.slice(0, at);
  const revision = value.slice(at + 1);
  return ACTION_NAME_PATTERN.test(action) && FULL_COMMIT_SHA_PATTERN.test(revision);
}

export function validateWindowsProductionFinalizerActionReference(value) {
  if (!isWindowsProductionFinalizerPinnedActionReference(value)) fail();
  return value;
}

export function validateWindowsProductionFinalizerDispatchInputs(value) {
  const inputs = readRecord(value, INPUT_NAMES);
  requireString(inputs.source_run_id, SOURCE_RUN_ID_PATTERN, 20);
  requireString(inputs.source_revision, SOURCE_REVISION_PATTERN, 40);
  requireString(inputs.source_ref, SOURCE_REF_PATTERN, SOURCE_REF.length);
  requireExact(inputs.source_ref, SOURCE_REF);
  return inputs;
}

validatePolicyShape(WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY);
