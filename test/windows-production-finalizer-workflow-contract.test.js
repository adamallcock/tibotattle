import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY,
  WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY,
  WINDOWS_NATIVE_PRESIGN_TRUSTEDSIGNING_EXCLUDED_CREDENTIALS,
} from "../scripts/windows-native-presign.mjs";

import {
  WINDOWS_PRODUCTION_FINALIZER_AZURE_LOGIN_REFERENCE,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_ACCOUNT_NAME,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_CLIENT_ID,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_ENDPOINT,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_FEDERATED_AUDIENCE,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_FEDERATED_ISSUER,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_FEDERATED_SUBJECT,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_GITHUB_ORG_ID,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_GITHUB_REPOSITORY_ID,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_PROFILE_NAME,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_PUBLISHER_NAME,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_REQUIRED_REVIEWER,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_ROLE_NAME,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_ROLE_SCOPE,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_SUBSCRIPTION_ID,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_TENANT_ID,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_TIMESTAMP_URL,
  WINDOWS_PRODUCTION_FINALIZER_CHECKOUT_REFERENCE,
  WINDOWS_PRODUCTION_FINALIZER_DOWNLOAD_ARTIFACT_REFERENCE,
  WINDOWS_PRODUCTION_FINALIZER_ENVIRONMENT,
  WINDOWS_PRODUCTION_FINALIZER_ELECTRON_BUILDER_VERSION,
  WINDOWS_PRODUCTION_FINALIZER_RUNNER,
  WINDOWS_PRODUCTION_FINALIZER_SETUP_NODE_REFERENCE,
  WINDOWS_PRODUCTION_FINALIZER_TRUSTEDSIGNING_VERSION,
  WINDOWS_PRODUCTION_FINALIZER_UPLOAD_ARTIFACT_REFERENCE,
  WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_EVENT,
  WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_IMPLEMENTATION_STATUS,
  WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_PATH,
  WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY,
  WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY_SCHEMA,
  WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY_STATUS,
  WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POSTURE,
  WindowsProductionFinalizerWorkflowPolicyError,
  isWindowsProductionFinalizerPinnedActionReference,
  validateWindowsProductionFinalizerActionReference,
  validateWindowsProductionFinalizerDispatchInputs,
  validateWindowsProductionFinalizerSourceWorkflowGovernance,
  validateWindowsProductionFinalizerWorkflowPolicy,
} from "../config/windows-production-finalizer-workflow-contract.js";

const INVALID_CODE = "windows_production_finalizer_workflow_policy_invalid";
const INVALID_MESSAGE = "Windows production finalizer workflow policy is invalid";
const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const RELEASE_CONFIG_PATH = fileURLToPath(
  new URL("../apps/electron/electron-builder.release.config.cjs", import.meta.url),
);

function loadReleaseAzureSignOptions() {
  const packageVersion = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).version;
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    const upperKey = key.toUpperCase();
    if (/(?:^|_)(?:WIN_)?CSC(?:_|$)/u.test(upperKey)
        || /(?:^|_)(?:PFX|P12)(?:_|$)/u.test(upperKey)
        || /^(?:AZURE|ARM)_/u.test(upperKey)
        || upperKey === "TIBOTATTLE_WINDOWS_PFX_PATH") {
      delete environment[key];
    }
  }
  Object.assign(environment, {
    TIBOTATTLE_ELECTRON_TARGET: "win32",
    TIBOTATTLE_ELECTRON_SIGNING_MODE: "azure-trusted-signing",
    TIBOTATTLE_ELECTRON_VERSION: packageVersion,
    TIBOTATTLE_ELECTRON_AZURE_PUBLISHER_NAME:
      WINDOWS_PRODUCTION_FINALIZER_AZURE_PUBLISHER_NAME,
    TIBOTATTLE_ELECTRON_AZURE_ENDPOINT:
      WINDOWS_PRODUCTION_FINALIZER_AZURE_ENDPOINT,
    TIBOTATTLE_ELECTRON_AZURE_CODE_SIGNING_ACCOUNT_NAME:
      WINDOWS_PRODUCTION_FINALIZER_AZURE_ACCOUNT_NAME,
    TIBOTATTLE_ELECTRON_AZURE_CERTIFICATE_PROFILE_NAME:
      WINDOWS_PRODUCTION_FINALIZER_AZURE_PROFILE_NAME,
  });
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      "const config = require(process.argv[1]); process.stdout.write(JSON.stringify(config.win.azureSignOptions));",
      RELEASE_CONFIG_PATH,
    ],
    { cwd: REPOSITORY_ROOT, env: environment, encoding: "utf8" },
  );
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

function clonePolicy() {
  return structuredClone(WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY);
}

function expectInvalid(value) {
  assert.throws(
    () => validateWindowsProductionFinalizerWorkflowPolicy(value),
    (error) => error instanceof WindowsProductionFinalizerWorkflowPolicyError
      && error.code === INVALID_CODE
      && error.message === INVALID_MESSAGE,
  );
}

function assertDeepFrozen(value) {
  assert.equal(Object.isFrozen(value), true);
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) assertDeepFrozen(child);
  }
}

test("Windows finalizer policy distinguishes implemented preflight from inactive signing", () => {
  assertDeepFrozen(WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY);
  assert.equal(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.schemaVersion,
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY_SCHEMA,
  );
  assert.equal(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.status,
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY_STATUS,
  );
  assert.equal(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.workflowStatus,
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_IMPLEMENTATION_STATUS,
  );
  assert.deepEqual(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.workflowPosture,
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POSTURE,
  );
  assert.equal(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.workflowPath,
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_PATH,
  );
  assert.equal(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.trigger,
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_EVENT,
  );
  assert.deepEqual(WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.signingJob, {
    runsOn: WINDOWS_PRODUCTION_FINALIZER_RUNNER,
    environment: WINDOWS_PRODUCTION_FINALIZER_ENVIRONMENT,
    permissions: {
      contents: "read",
      actions: "read",
      "id-token": "write",
    },
  });
  assert.deepEqual(WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.concurrency, {
    group: "windows-production-finalizer-${{ inputs.source_revision }}",
    cancelInProgress: false,
  });
  assert.deepEqual(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.dispatch.inputs,
    {
      source_run_id: { type: "string", required: true },
      source_revision: { type: "string", required: true },
      source_ref: { type: "string", required: true },
    },
  );
  assert.deepEqual(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.checkout,
    {
      reference: WINDOWS_PRODUCTION_FINALIZER_CHECKOUT_REFERENCE,
      ref: "${{ inputs.source_revision }}",
      fetchDepth: 1,
      persistCredentials: false,
      verifyHead: true,
    },
  );
  assert.deepEqual(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.setupNode,
    { reference: WINDOWS_PRODUCTION_FINALIZER_SETUP_NODE_REFERENCE },
  );
  assert.deepEqual(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.sourceEvidence,
    {
      repository: "adamallcock/tibotattle",
      workflow: ".github/workflows/windows-portability.yml",
      status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
    ref: "refs/heads/main",
    selectedRun: {
      normalizedFields: {
        id: "sourceRun.id",
        head_sha: "sourceRun.head_sha",
        run_attempt: "sourceRun.run_attempt",
      },
      inputBindings: {
        id: "sourceRun.id === Number(inputs.source_run_id)",
        head_sha: "sourceRun.head_sha === inputs.source_revision",
        run_attempt:
          "Number.isSafeInteger(sourceRun.run_attempt) && sourceRun.run_attempt >= 1",
      },
      boundBeforeReceiptParse: true,
    },
    runId: "${{ inputs.source_run_id }}",
      runAttempt: "sourceRun.run_attempt",
      revision: "${{ inputs.source_revision }}",
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
        artifactNameTemplate:
          "tibotattle-windows-electron-qualification-${runId}-${runAttempt}-${revision}-${cacheMode}.json",
        artifactIdSource: "github.rest.actions.getArtifact.artifact.id",
        artifactDigestSource: "github.rest.actions.getArtifact.artifact.digest",
        artifactNameSource: "github.rest.actions.getArtifact.artifact.name",
        sourceUpload: {
          stepId: "windows_qualification_receipt_raw_upload",
          reference: WINDOWS_PRODUCTION_FINALIZER_UPLOAD_ARTIFACT_REFERENCE,
          archive: false,
          directSingleFile: true,
          path:
            "${{ env.TIBOTATTLE_WINDOWS_QUALIFICATION_RECEIPT_RAW_PATH }}",
          name:
            "${{ env.TIBOTATTLE_WINDOWS_QUALIFICATION_RECEIPT_BASENAME }}",
          basenameSource:
            "TIBOTATTLE_WINDOWS_QUALIFICATION_RECEIPT_BASENAME",
          basenameTemplate:
            "tibotattle-windows-electron-qualification-${runId}-${runAttempt}-${revision}-${cacheMode}.json",
          workflowBasenameTemplate:
            "tibotattle-windows-electron-qualification-${{ github.run_id }}-${{ github.run_attempt }}-${{ github.sha }}-${{ matrix.cache-mode }}.json",
          digestOutput:
            "steps.windows_qualification_receipt_raw_upload.outputs['artifact-digest']",
          digestPattern: "^[0-9a-f]{64}$",
          digestFormat: "bare_sha256_hex",
          digestEqualitySource:
            "upload_artifact_digest === sha256(raw_receipt_bytes_before_json_parse)",
          digestCheckedBeforePublication: true,
          digestValidationStepName:
            "Validate raw Windows x64 qualification receipt handoff",
        },
        artifactResponseFields: {
          id: "github.rest.actions.getArtifact.artifact.id",
          digest: "github.rest.actions.getArtifact.artifact.digest",
          name: "github.rest.actions.getArtifact.artifact.name",
          expired: "github.rest.actions.getArtifact.artifact.expired",
          size_in_bytes:
            "github.rest.actions.getArtifact.artifact.size_in_bytes",
          "workflow_run.id":
            "github.rest.actions.getArtifact.artifact.workflow_run.id",
          "workflow_run.head_sha":
            "github.rest.actions.getArtifact.artifact.workflow_run.head_sha",
        },
        downloadArtifacts: [
          {
            cacheMode: "warm",
            reference: WINDOWS_PRODUCTION_FINALIZER_DOWNLOAD_ARTIFACT_REFERENCE,
            artifactIds:
              "${{ steps.select_warm_receipt_artifact.outputs.artifact-id }}",
            artifactIdsSource: "selectedArtifacts.warm.id",
            repository: "adamallcock/tibotattle",
            runId: "${{ inputs.source_run_id }}",
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
            repository: "adamallcock/tibotattle",
            runId: "${{ inputs.source_run_id }}",
            githubToken: "${{ github.token }}",
            digestMismatch: "error",
            path:
              "${{ runner.temp }}/tibotattle-windows-production-finalizer-receipts/clean",
            destinationMustBeAbsentBeforeDownload: true,
            mergeMultiple: false,
            skipDecompress: false,
          },
        ],
        receiptValidation: {
          artifactDigestMatchSource:
            "artifact.digest === 'sha256:' + sha256(raw_receipt_bytes_before_json_parse)",
          artifactDigestPattern: "^sha256:[0-9a-f]{64}$",
          artifactDigestCheckedBeforeParse: true,
          rawReceiptSha256MatchSource:
            "artifact.rawReceiptSha256 === sha256(raw_receipt_bytes_before_json_parse)",
          rawReceiptSizeSource:
            "raw_receipt_bytes_before_json_parse.byteLength",
          rawReceiptSizeMinimumExclusive: 0,
          rawReceiptSizeMaximumInclusive: 16_777_216,
          rawReceiptBytesCheckedBeforeParse: true,
          artifactExpired: false,
        },
        rawArtifactMetadataSha256Source:
          "sha256(raw_artifact_metadata_bytes_before_json_parse)",
        rawReceiptSha256Source:
          "sha256(raw_receipt_bytes_before_json_parse)",
      },
    },
  );
  assert.equal(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.azure.login.reference,
    WINDOWS_PRODUCTION_FINALIZER_AZURE_LOGIN_REFERENCE,
  );
  assert.deepEqual(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.azure.login.with,
    {
      "client-id": "${{ vars.AZURE_CLIENT_ID }}",
      "tenant-id": "${{ vars.AZURE_TENANT_ID }}",
      "subscription-id": "${{ vars.AZURE_SUBSCRIPTION_ID }}",
      audience: "api://AzureADTokenExchange",
      "enable-AzPSSession": false,
    },
  );
  assert.deepEqual(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.azure.builderEnvironment,
    {
      TIBOTATTLE_ELECTRON_AZURE_CODE_SIGNING_ACCOUNT_NAME:
        "${{ vars.AZURE_CODE_SIGNING_ACCOUNT_NAME }}",
      TIBOTATTLE_ELECTRON_AZURE_CERTIFICATE_PROFILE_NAME:
        "${{ vars.AZURE_CODE_SIGNING_PROFILE_NAME }}",
      TIBOTATTLE_ELECTRON_AZURE_ENDPOINT:
        "${{ vars.AZURE_CODE_SIGNING_ENDPOINT }}",
      TIBOTATTLE_ELECTRON_AZURE_PUBLISHER_NAME:
        "${{ vars.AZURE_CODE_SIGNING_PUBLISHER_NAME }}",
    },
  );
  assert.deepEqual(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.azure.forbiddenBuilderEnvironment,
    [
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
    ],
  );
  assert.deepEqual(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.azure.forbiddenBuilderEnvironmentPatterns,
    [
      "(?:^|_)(?:WIN_)?CSC(?:_|$)",
      "(?:^|_)(?:PFX|P12)(?:_|$)",
      "(?:^|_)(?:AZURE|ARM)_(?:CLIENT_SECRET|CLIENT_CERTIFICATE|FEDERATED_TOKEN)(?:_|$)",
    ],
  );
  assert.deepEqual(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.azure.expectedIdentity,
    {
      clientId: WINDOWS_PRODUCTION_FINALIZER_AZURE_CLIENT_ID,
      tenantId: WINDOWS_PRODUCTION_FINALIZER_AZURE_TENANT_ID,
      subscriptionId: WINDOWS_PRODUCTION_FINALIZER_AZURE_SUBSCRIPTION_ID,
      codeSigningAccountName: WINDOWS_PRODUCTION_FINALIZER_AZURE_ACCOUNT_NAME,
      certificateProfileName: WINDOWS_PRODUCTION_FINALIZER_AZURE_PROFILE_NAME,
      endpoint: WINDOWS_PRODUCTION_FINALIZER_AZURE_ENDPOINT,
      publisherName: WINDOWS_PRODUCTION_FINALIZER_AZURE_PUBLISHER_NAME,
      timestampRfc3161: WINDOWS_PRODUCTION_FINALIZER_AZURE_TIMESTAMP_URL,
      environment: WINDOWS_PRODUCTION_FINALIZER_ENVIRONMENT,
    },
  );
  assert.deepEqual(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.azure.runtimePreflight,
    {
      requiredStatus: "WINDOWS_TRUSTEDSIGNING_PREFLIGHT_PASSED",
      moduleName: "TrustedSigning",
      requiredVersion: WINDOWS_PRODUCTION_FINALIZER_TRUSTEDSIGNING_VERSION,
      credentialMode: "azure-cli-only",
      excludedCredentials: [
        "ExcludeEnvironmentCredential",
        "ExcludeWorkloadIdentityCredential",
        "ExcludeManagedIdentityCredential",
        "ExcludeSharedTokenCacheCredential",
        "ExcludeVisualStudioCredential",
        "ExcludeVisualStudioCodeCredential",
        "ExcludeAzurePowerShellCredential",
        "ExcludeAzureDeveloperCliCredential",
        "ExcludeInteractiveBrowserCredential",
      ],
      timestampVariable: "AZURE_CODE_SIGNING_TIMESTAMP_URL",
      timestampExpected: WINDOWS_PRODUCTION_FINALIZER_AZURE_TIMESTAMP_URL,
      timestampValidation: "exact",
      forbiddenEnvironmentValidation: "complete_absence",
      validationBeforeBuilderImport: true,
    },
  );
  assert.deepEqual(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.azure.externalGovernance,
    {
      status: "supplied_configured_unexercised",
      operatorRecheckRequiredBeforeFirstSigning: true,
      issuer: WINDOWS_PRODUCTION_FINALIZER_AZURE_FEDERATED_ISSUER,
      audience: WINDOWS_PRODUCTION_FINALIZER_AZURE_FEDERATED_AUDIENCE,
      federatedSubject: WINDOWS_PRODUCTION_FINALIZER_AZURE_FEDERATED_SUBJECT,
      githubOrgId: WINDOWS_PRODUCTION_FINALIZER_AZURE_GITHUB_ORG_ID,
      githubRepositoryId: WINDOWS_PRODUCTION_FINALIZER_AZURE_GITHUB_REPOSITORY_ID,
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
    },
  );
  assert.deepEqual(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.azure.timestampValidation,
    {
      source: "${{ vars.AZURE_CODE_SIGNING_TIMESTAMP_URL }}",
      expected: "http://timestamp.acs.microsoft.com",
      mode: "validation_only",
    },
  );
  assert.equal(
    Object.hasOwn(
      WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.azure.builderEnvironment,
      "TIBOTATTLE_ELECTRON_AZURE_TIMESTAMP_URL",
    ),
    false,
  );
  assert.deepEqual(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.versions,
    {
      electronBuilder: WINDOWS_PRODUCTION_FINALIZER_ELECTRON_BUILDER_VERSION,
      trustedSigning: WINDOWS_PRODUCTION_FINALIZER_TRUSTEDSIGNING_VERSION,
    },
  );
  assert.equal(
    validateWindowsProductionFinalizerWorkflowPolicy(),
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY,
  );
  assert.equal(
    validateWindowsProductionFinalizerWorkflowPolicy(clonePolicy()).status,
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY_STATUS,
  );
});

test("Azure identity and credential mode stay aligned across policy, builder, and presign", () => {
  const expectedIdentity =
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.azure.expectedIdentity;
  const nativeIdentity = WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY;
  assert.deepEqual(
    {
      account: nativeIdentity.codeSigningAccountName,
      profile: nativeIdentity.certificateProfileName,
      endpoint: nativeIdentity.endpoint,
      publisher: nativeIdentity.publisher,
      timestamp: nativeIdentity.timestampRfc3161,
    },
    {
      account: expectedIdentity.codeSigningAccountName,
      profile: expectedIdentity.certificateProfileName,
      endpoint: expectedIdentity.endpoint,
      publisher: expectedIdentity.publisherName,
      timestamp: expectedIdentity.timestampRfc3161,
    },
  );

  const releaseOptions = loadReleaseAzureSignOptions();
  assert.deepEqual(
    {
      account: releaseOptions.codeSigningAccountName,
      profile: releaseOptions.certificateProfileName,
      endpoint: releaseOptions.endpoint,
      publisher: releaseOptions.publisherName,
      timestamp: releaseOptions.timestampRfc3161,
    },
    {
      account: expectedIdentity.codeSigningAccountName,
      profile: expectedIdentity.certificateProfileName,
      endpoint: expectedIdentity.endpoint,
      publisher: expectedIdentity.publisherName,
      timestamp: expectedIdentity.timestampRfc3161,
    },
  );

  const exclusionNames =
    WINDOWS_NATIVE_PRESIGN_TRUSTEDSIGNING_EXCLUDED_CREDENTIALS;
  const expectedExclusions = Object.fromEntries(
    exclusionNames.map((name) => [name, true]),
  );
  assert.deepEqual(
    Object.fromEntries(exclusionNames.map((name) => [name, releaseOptions[name]])),
    expectedExclusions,
  );
  assert.equal(releaseOptions.ExcludeAzureCliCredential, undefined);
  assert.equal(
    WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY.trustedSigningCredentialMode,
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.azure.runtimePreflight.credentialMode,
  );
  assert.deepEqual(
    WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY.excludedCredentials,
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.azure.runtimePreflight
      .excludedCredentials,
  );

  const releaseSource = readFileSync(RELEASE_CONFIG_PATH, "utf8");
  for (const literal of [
    WINDOWS_PRODUCTION_FINALIZER_AZURE_ACCOUNT_NAME,
    WINDOWS_PRODUCTION_FINALIZER_AZURE_PROFILE_NAME,
    WINDOWS_PRODUCTION_FINALIZER_AZURE_ENDPOINT,
    WINDOWS_PRODUCTION_FINALIZER_AZURE_PUBLISHER_NAME,
    WINDOWS_PRODUCTION_FINALIZER_AZURE_TIMESTAMP_URL,
  ]) {
    assert.equal(releaseSource.includes(literal), true, `missing ${literal}`);
  }
});

test("dispatch input values are exact and validated before a finalizer can use them", () => {
  const valid = {
    source_run_id: "123456789",
    source_revision: "a".repeat(40),
    source_ref: "refs/heads/main",
  };
  assert.deepEqual(validateWindowsProductionFinalizerDispatchInputs(valid), valid);

  for (const [key, value] of [
    ["source_run_id", "0"],
    ["source_run_id", "01"],
    ["source_run_id", "run-123"],
    ["source_revision", "A".repeat(40)],
    ["source_revision", "a".repeat(39)],
    ["source_revision", "a".repeat(41)],
    ["source_ref", "refs/tags/v0.1.16"],
    ["source_ref", "refs/heads/feature"],
  ]) {
    const invalid = { ...valid, [key]: value };
    assert.throws(
      () => validateWindowsProductionFinalizerDispatchInputs(invalid),
      (error) => error.code === INVALID_CODE && error.message === INVALID_MESSAGE,
    );
  }

  const open = { ...valid, unexpected: "value" };
  assert.throws(
    () => validateWindowsProductionFinalizerDispatchInputs(open),
    (error) => error.code === INVALID_CODE,
  );
});

test("external action references require a full lowercase commit SHA", () => {
  const valid = `actions/checkout@${"a".repeat(40)}`;
  assert.equal(isWindowsProductionFinalizerPinnedActionReference(valid), true);
  assert.equal(
    isWindowsProductionFinalizerPinnedActionReference(
      WINDOWS_PRODUCTION_FINALIZER_AZURE_LOGIN_REFERENCE,
    ),
    true,
  );
  assert.equal(
    validateWindowsProductionFinalizerActionReference(valid),
    valid,
  );

  for (const invalid of [
    "actions/checkout@v7",
    `actions/checkout@${"a".repeat(39)}`,
    `actions/checkout@${"A".repeat(40)}`,
    "azure/login@f5d393ae46f8fde4be8b75f32e3fc50e654ad0ca#v3.0.1",
    "./.github/actions/local-action",
    "actions checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ]) {
    assert.equal(isWindowsProductionFinalizerPinnedActionReference(invalid), false);
    assert.throws(
      () => validateWindowsProductionFinalizerActionReference(invalid),
      (error) => error.code === INVALID_CODE,
    );
  }
});

test("policy rejects widened, activated, ambient, or accessor-backed shapes", () => {
  const open = clonePolicy();
  open.unexpected = "secret-shaped-value";
  expectInvalid(open);

  const activated = clonePolicy();
  activated.status = "ready";
  expectInvalid(activated);

  const signingPosture = clonePolicy();
  signingPosture.workflowPosture.mode = "signed";
  expectInvalid(signingPosture);

  const oidcPosture = clonePolicy();
  oidcPosture.workflowPosture.oidcPermission = "write";
  expectInvalid(oidcPosture);

  const cancelling = clonePolicy();
  cancelling.concurrency.cancelInProgress = true;
  expectInvalid(cancelling);

  const widenedPermissions = clonePolicy();
  widenedPermissions.signingJob.permissions.packages = "write";
  expectInvalid(widenedPermissions);

  const ambient = clonePolicy();
  ambient.azure.builderEnvironment.AZURE_CLIENT_ID =
    "${{ vars.AZURE_CLIENT_ID }}";
  expectInvalid(ambient);

  const hardcodedLogin = clonePolicy();
  hardcodedLogin.azure.login.with["client-id"] = "client-id";
  expectInvalid(hardcodedLogin);

  const wrongIdentity = clonePolicy();
  wrongIdentity.azure.expectedIdentity.codeSigningAccountName = "another-account";
  expectInvalid(wrongIdentity);

  const wrongPreflight = clonePolicy();
  wrongPreflight.azure.runtimePreflight.validationBeforeBuilderImport = false;
  expectInvalid(wrongPreflight);

  const wrongGovernance = clonePolicy();
  wrongGovernance.azure.externalGovernance.operatorRecheckRequiredBeforeFirstSigning = false;
  expectInvalid(wrongGovernance);

  const suppliedSubject = clonePolicy();
  suppliedSubject.azure.externalGovernance.authenticodeSubject.exactDistinguishedName =
    "CN=Adam Allcock";
  expectInvalid(suppliedSubject);

  const sourceEvidence = clonePolicy();
  sourceEvidence.sourceEvidence.status = "in_progress";
  expectInvalid(sourceEvidence);

  const reversedArtifacts = clonePolicy();
  reversedArtifacts.sourceEvidence.artifacts.requiredCacheModes.reverse();
  expectInvalid(reversedArtifacts);

  for (const [field, value] of [
    ["expired", true],
    ["size_in_bytes", "1"],
    ["workflow_run.id", "github.rest.actions.getArtifact.artifact.id"],
    [
      "workflow_run.head_sha",
      "github.rest.actions.getArtifact.artifact.head_sha",
    ],
  ]) {
    const invalid = clonePolicy();
    invalid.sourceEvidence.artifacts.artifactResponseFields[field] = value;
    expectInvalid(invalid);
  }

  const unboundSourceRun = clonePolicy();
  unboundSourceRun.sourceEvidence.selectedRun.boundBeforeReceiptParse = false;
  expectInvalid(unboundSourceRun);

  const wrongReceiptDigestOrder = clonePolicy();
  wrongReceiptDigestOrder.sourceEvidence.artifacts.receiptValidation
    .artifactDigestCheckedBeforeParse = false;
  expectInvalid(wrongReceiptDigestOrder);

  const wrongDownloadScope = clonePolicy();
  wrongDownloadScope.sourceEvidence.artifacts.downloadArtifacts[0].runId =
    "${{ github.run_id }}";
  expectInvalid(wrongDownloadScope);

  const wrongDownloadDestination = clonePolicy();
  wrongDownloadDestination.sourceEvidence.artifacts.downloadArtifacts[1]
    .destinationMustBeAbsentBeforeDownload = false;
  expectInvalid(wrongDownloadDestination);

  const wrongDownloadDecompression = clonePolicy();
  wrongDownloadDecompression.sourceEvidence.artifacts.downloadArtifacts[0]
    .skipDecompress = true;
  expectInvalid(wrongDownloadDecompression);

  const wrongSourceUpload = clonePolicy();
  wrongSourceUpload.sourceEvidence.artifacts.sourceUpload.archive = true;
  expectInvalid(wrongSourceUpload);

  const proxyArray = clonePolicy();
  proxyArray.azure.forbiddenBuilderEnvironment = new Proxy(
    proxyArray.azure.forbiddenBuilderEnvironment,
    {
      get(target, property, receiver) {
        if (property === "length" || property === "map") {
          throw new Error("proxy-controlled array access");
        }
        return Reflect.get(target, property, receiver);
      },
    },
  );
  assert.equal(
    validateWindowsProductionFinalizerWorkflowPolicy(proxyArray),
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY,
  );

  const customMapArray = clonePolicy();
  customMapArray.azure.forbiddenBuilderEnvironment = new Proxy(
    customMapArray.azure.forbiddenBuilderEnvironment,
    {
      get(target, property, receiver) {
        if (property === "length") return 9999;
        if (property === "map") {
          return () => {
            throw new Error("custom proxy map must not run");
          };
        }
        return Reflect.get(target, property, receiver);
      },
    },
  );
  assert.equal(
    validateWindowsProductionFinalizerWorkflowPolicy(customMapArray),
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY,
  );

  const throwingGetter = clonePolicy();
  Object.defineProperty(throwingGetter, "status", {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error("secret-shaped-value");
    },
  });
  expectInvalid(throwingGetter);

  const symbolKey = clonePolicy();
  symbolKey[Symbol("unexpected")] = true;
  expectInvalid(symbolKey);

  expectInvalid(new Proxy(clonePolicy(), {
    getPrototypeOf() {
      throw new Error("secret-shaped-value");
    },
  }));

  assert.throws(
    () => validateWindowsProductionFinalizerWorkflowPolicy(throwingGetter),
    (error) => !error.message.includes("secret-shaped-value")
      && error.code === INVALID_CODE,
  );
});

test("source upload governance is cross-checked against the portability workflow", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/windows-portability.yml", import.meta.url),
    "utf8",
  );
  assert.equal(
    validateWindowsProductionFinalizerSourceWorkflowGovernance(workflow),
    true,
  );

  for (const driftedWorkflow of [
    workflow.replace("archive: false", "archive: true"),
    workflow.replace(
      "${{ matrix.cache-mode }}.json",
      "${{ matrix.platform }}.json",
    ),
    workflow.replace(
      "artifactDigest -cne $expectedDigest",
      "artifactDigest -cne $localDigest",
    ),
  ]) {
    assert.throws(
      () => validateWindowsProductionFinalizerSourceWorkflowGovernance(
        driftedWorkflow,
      ),
      (error) => error.code === INVALID_CODE && error.message === INVALID_MESSAGE,
    );
  }
});

test("policy denial surface stays aligned with the release builder guard", () => {
  const releaseConfig = readFileSync(
    new URL("../apps/electron/electron-builder.release.config.cjs", import.meta.url),
    "utf8",
  );
  for (const name of WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.azure
    .forbiddenBuilderEnvironment) {
    assert.equal(
      releaseConfig.includes(`"${name}"`),
      true,
      `release config must deny ${name}`,
    );
  }
  for (const pattern of WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.azure
    .forbiddenBuilderEnvironmentPatterns) {
    assert.equal(
      releaseConfig.includes(`/${pattern}/u`),
      true,
      `release config must deny pattern ${pattern}`,
    );
  }
});
