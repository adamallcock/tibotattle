import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

import { WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256 } from "../scripts/windows-native-presign.mjs";
import {
  WINDOWS_PRODUCTION_FINALIZER_AZURE_ACCOUNT_NAME,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_CLIENT_ID,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_ENDPOINT,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_PROFILE_NAME,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_PUBLISHER_NAME,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_SUBSCRIPTION_ID,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_TENANT_ID,
  WINDOWS_PRODUCTION_FINALIZER_AZURE_TIMESTAMP_URL,
  WINDOWS_PRODUCTION_FINALIZER_CHECKOUT_REFERENCE,
  WINDOWS_PRODUCTION_FINALIZER_DOWNLOAD_ARTIFACT_REFERENCE,
  WINDOWS_PRODUCTION_FINALIZER_SETUP_NODE_REFERENCE,
  WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY,
} from "../config/windows-production-finalizer-workflow-contract.js";

const WORKFLOW_PATH = ".github/workflows/windows-production-finalizer.yml";
const workflow = readFileSync(WORKFLOW_PATH, "utf8");

function mustInclude(fragment, message = fragment) {
  assert.ok(workflow.includes(fragment), `workflow must include ${message}`);
}

function mustNotInclude(fragment, message = fragment) {
  assert.equal(workflow.includes(fragment), false, `workflow must not include ${message}`);
}

function stepSection(name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, `workflow must include step ${name}`);
  const next = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, next < 0 ? workflow.length : next);
}

function stepOffset(name) {
  const marker = `      - name: ${name}\n`;
  const offset = workflow.indexOf(marker);
  assert.ok(offset >= 0, `workflow must include step ${name}`);
  return offset;
}

test("Windows finalizer is a protected manual preflight with no OIDC permission", () => {
  mustInclude("name: Windows production finalizer preflight");
  mustInclude("on:\n  workflow_dispatch:");
  for (const trigger of ["push:", "pull_request:", "schedule:", "workflow_call:", "workflow_run:"]) {
    mustNotInclude(trigger, `trigger ${trigger}`);
  }
  mustInclude("permissions:\n  contents: read\n  actions: read");
  mustInclude("runs-on: windows-2025");
  mustInclude("environment: windows-production-signing");
  mustInclude("group: windows-production-finalizer-${{ inputs.source_revision }}");
  mustInclude("cancel-in-progress: false");
  mustNotInclude("id-token:", "an OIDC permission before the signed workflow exists");
  mustNotInclude("azure/login", "an Azure login action");
  mustNotInclude("Invoke-TrustedSigning", "a signing invocation");
  mustNotInclude("windows-native-presign", "a native signing command");
  mustNotInclude("actions/upload-artifact", "artifact publication");
  mustNotInclude("electron-builder", "an Electron release-builder invocation");
  mustNotInclude("Set-AuthenticodeSignature", "Authenticode mutation");
  mustNotInclude("signtool", "Authenticode mutation");
  mustNotInclude("--publish", "publication flags");
});

test("checked-in workflow matches the closed preflight policy and immutable action pins", () => {
  assert.equal(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.workflowPosture.mode,
    "preflight_only",
  );
  assert.equal(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.workflowPosture.oidcPermission,
    "absent",
  );
  assert.equal(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.workflowPosture.azureLogin,
    "absent",
  );
  assert.equal(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.workflowPosture.signingInvocation,
    "absent",
  );
  assert.equal(
    WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.workflowPosture.artifactUpload,
    "absent",
  );
  mustInclude(WINDOWS_PRODUCTION_FINALIZER_CHECKOUT_REFERENCE);
  mustInclude(WINDOWS_PRODUCTION_FINALIZER_SETUP_NODE_REFERENCE);
  for (const download of WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY
    .sourceEvidence.artifacts.downloadArtifacts) {
    assert.equal(download.reference, WINDOWS_PRODUCTION_FINALIZER_DOWNLOAD_ARTIFACT_REFERENCE);
    assert.equal(
      (workflow.match(new RegExp(download.reference.replace("/", "\\/"), "gu")) ?? [])
        .length,
      2,
    );
  }
  const topPermissions = workflow.match(
    /^permissions:\n  contents: read\n  actions: read\n(?:  id-token:.+\n)?/mu,
  );
  assert.ok(topPermissions, "workflow permissions must be read-only without OIDC");
  assert.equal(topPermissions[0].includes("id-token:"), false);
  const jobSection = workflow.slice(workflow.indexOf("    permissions:\n"));
  assert.match(jobSection, /    permissions:\n      contents: read\n      actions: read\n/u);
  assert.equal(jobSection.includes("id-token:"), false);
});

test("dispatch inputs are required and fail closed to main and lowercase identities", () => {
  for (const input of ["source_run_id", "source_revision", "source_ref"]) {
    mustInclude(`      ${input}:`);
    const start = workflow.indexOf(`      ${input}:`);
    const nextInput = workflow.indexOf("\n      source_", start + 8);
    const end = nextInput >= 0 ? nextInput : workflow.indexOf("\n\npermissions:", start + 8);
    const section = workflow.slice(start, end < 0 ? undefined : end);
    assert.match(section, /required: true/u);
    assert.match(section, /type: string/u);
  }
  mustInclude("$env:SOURCE_RUN_ID -cnotmatch '^[1-9][0-9]{0,19}$'");
  mustInclude("$env:SOURCE_REVISION -cnotmatch '^[0-9a-f]{40}$'");
  mustInclude("$env:SOURCE_REF -cne 'refs/heads/main'");
  mustInclude("ref: ${{ inputs.source_revision }}");
  mustInclude("persist-credentials: false");
  mustInclude("fetch-depth: 1");
  mustInclude("git diff --quiet");
  mustInclude("git diff --cached --quiet");
  mustInclude("if ($LASTEXITCODE -ne 0)");
  assert.ok(
    workflow.indexOf("Verify package version after pinned Node setup")
      > workflow.indexOf("Install pinned Node.js"),
  );
  assert.ok(
    workflow.indexOf("Verify package version after pinned Node setup")
      > workflow.indexOf("Confirm forbidden credential and signing environment is absent"),
  );
});

test("source provenance is proven before checkout and no target code runs before that proof", () => {
  const dispatchOffset = stepOffset("Validate exact dispatch inputs");
  const provenanceOffset = stepOffset(
    "Fetch and statically validate exact source provenance before checkout",
  );
  const checkoutOffset = stepOffset("Check out the exact source revision");
  assert.ok(dispatchOffset < provenanceOffset);
  assert.ok(provenanceOffset < checkoutOffset);

  const preCheckout = workflow.slice(dispatchOffset, checkoutOffset);
  for (const pattern of [
    /\bnode(?:\.exe)?\b/iu,
    /\b(?:npm|pnpm)\b/iu,
    /(?:^|[\\/])scripts[\\/]/iu,
    /package\.json/iu,
    /(?:^|[\\/])config[\\/]/iu,
    /\b(?:Import|Get)-Module\b/iu,
  ]) {
    assert.doesNotMatch(preCheckout, pattern, `target code must not run before checkout: ${pattern}`);
  }

  const provenance = stepSection(
    "Fetch and statically validate exact source provenance before checkout",
  );
  assert.match(provenance, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(provenance, /ConvertFrom-Json/u);
  assert.match(provenance, /Get-Item -LiteralPath \$path -Force/u);
  assert.match(provenance, /\$metadata\.PSIsContainer -or/u);
  assert.doesNotMatch(provenance, /\b(?:node|npm|pnpm)\b/iu);
  assert.doesNotMatch(provenance, /(?:^|[\\/])scripts[\\/]/iu);
});

test("toolchain and action references are immutable", () => {
  mustInclude("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
  mustInclude("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020");
  assert.equal(
    (workflow.match(/actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/gu) ?? []).length,
    2,
  );
  for (const line of workflow.split("\n").filter((value) => value.trimStart().startsWith("uses:"))) {
    assert.match(line, /uses: [^@\s]+@[0-9a-f]{40}(?:\s|$)/u);
  }
  for (const version of ["node-version: 26.2.0", "corepack@0.34.0", "pnpm@11.9.0", "corepack --version"]) {
    mustInclude(version);
  }
  mustInclude("pnpm --version");
  mustInclude("pnpm install --frozen-lockfile");
});

test("source evidence is fetched content-free, bounded, and selected offline", () => {
  const provenance = stepSection(
    "Fetch and statically validate exact source provenance before checkout",
  );
  assert.equal((workflow.match(/^          GH_TOKEN: \$\{\{ github\.token \}\}$/gmu) ?? []).length, 1);
  assert.match(provenance, /gh api --method GET --header 'Accept: application\/vnd\.github\+json'/u);
  assert.match(provenance, /\/actions\/runs\/\$\(\$env:SOURCE_RUN_ID\)/u);
  assert.match(provenance, /\/actions\/runs\/\$\(\$env:SOURCE_RUN_ID\)\/artifacts\?per_page=100&page=1/u);
  for (const fragment of [
    "source-run.json",
    "source-artifact-list.json",
    "WINDOWS_FINALIZER_SOURCE_ROOT_EXISTS",
    "$metadata -isnot [System.IO.FileInfo]",
    "$metadata.PSIsContainer -or",
    "[System.IO.FileAttributes]::ReparsePoint",
    "$sourceRunId -cne $env:SOURCE_RUN_ID",
    "$sourcePath -ceq '.github/workflows/windows-portability.yml'",
    "$pathIsPortability",
    "$sourceRun.head_sha -cne $env:SOURCE_REVISION",
    "$sourceRepository -cne 'adamallcock/tibotattle'",
    "$sourceHeadBranch -cne 'main'",
    "$sourceRef -cne $env:SOURCE_REF",
    "$sourceRun.event -cne 'workflow_dispatch'",
    "$sourceRun.status -cne 'completed'",
    "$sourceRun.conclusion -cne 'success'",
    "$sourceRunAttempt -lt 1",
    "$sourceRunAttempt -gt 9007199254740991",
    "$artifactTotal -gt 100",
    "$artifactRows.Count -ne $artifactTotal",
    "$paginationPresent.Count -ne 0",
  ]) assert.match(provenance, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  mustInclude("scripts/select-windows-finalizer-source-evidence.mjs");
  mustInclude("--output-root $evidenceRoot");
  mustInclude("selection-receipt.json");
  mustInclude("$selection.download.artifactIds.warm");
  mustInclude("$selection.download.artifactIds.clean");
  mustInclude("$warmId -notmatch '^[1-9][0-9]{0,19}$'");
  mustInclude("$cleanId -notmatch '^[1-9][0-9]{0,19}$'");
  mustInclude("$warmId -ceq $cleanId");
  mustInclude("$env:GITHUB_OUTPUT");
});

test("warm and clean downloads use immutable direct-artifact controls", () => {
  assert.equal((workflow.match(/artifact-ids:/gu) ?? []).length, 2);
  assert.equal((workflow.match(/github-token: \$\{\{ github\.token \}\}/gu) ?? []).length, 2);
  assert.equal((workflow.match(/repository: adamallcock\/tibotattle/gu) ?? []).length, 2);
  assert.equal((workflow.match(/run-id: \$\{\{ inputs\.source_run_id \}\}/gu) ?? []).length, 2);
  assert.equal((workflow.match(/digest-mismatch: error/gu) ?? []).length, 2);
  assert.equal((workflow.match(/skip-decompress: false/gu) ?? []).length, 2);
  assert.equal((workflow.match(/merge-multiple: false/gu) ?? []).length, 2);
  mustInclude("/tibotattle-windows-production-finalizer-receipts/warm");
  mustInclude("/tibotattle-windows-production-finalizer-receipts/clean");
  mustInclude("Get-ReceiptPath $warmRoot 'warm'");
  mustInclude("Get-ReceiptPath $cleanRoot 'clean'");
  mustInclude("destinationMustBeAbsentBeforeDownload");
});

test("handoff, production binding, and staging gates are explicit", () => {
  const staging = stepSection("Verify exact staged runtime and native hashes");
  mustInclude("verify-windows-finalizer-qualification-handoff.mjs");
  for (const flag of [
    "--run-metadata",
    "--warm-receipt",
    "--clean-receipt",
    "--warm-artifact",
    "--clean-artifact",
    "--output $handoffPath",
  ]) mustInclude(flag);
  mustInclude("node $nodeGypScript rebuild --directory native/windows-filesystem");
  mustInclude("build-windows-filesystem-manifest.mjs");
  mustInclude(".release-build/electron-production/windows-x64/app");
  mustInclude("build-electron-app.mjs");
  mustInclude("--target win32");
  mustInclude("--windows-binding $env:TIBOTATTLE_WINDOWS_BINDING_PATH");
  mustInclude("--windows-manifest $env:TIBOTATTLE_WINDOWS_BINDING_MANIFEST_PATH");
  mustInclude("$runtime.windowsBinding.binding.bytes -ne $native.bytes");
  mustInclude("$runtime.windowsBinding.binding.sha256 -cne $native.sha256");
  mustInclude("$warmBinding.binding.sha256 -cne $native.sha256");
  mustInclude("$cleanBinding.binding.sha256 -cne $native.sha256");
  mustInclude("Get-FileHash -LiteralPath $env:TIBOTATTLE_WINDOWS_BINDING_PATH -Algorithm SHA256");
  mustInclude("$WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256 = 'b82625e7c713fd20b5cb57993e073076c87660652202893fad39d874d77169fc'");
  mustInclude("$stagedKeytarHash -cne $WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256");
  mustInclude("$keytarRows.Count -ne 1");
  mustInclude("$bindingRows.Count -ne 1");
  mustInclude("$runtime.releaseVersion -cne $env:TIBOTATTLE_PACKAGE_VERSION");
  mustNotInclude("tibotattle_build_qualification", "qualification native build flags");
  assert.match(
    staging,
    new RegExp(`\\$WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256 = '${WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256}'`, "u"),
  );
  assert.match(
    staging,
    new RegExp(`\\$stagedKeytarHash -cne \\$WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256`, "u"),
  );
  assert.match(staging, /\$keytarRows\.Count -ne 1/u);
  assert.match(staging, /\$bindingRows\.Count -ne 1/u);
});

test("credential checks and TrustedSigning preflight are read-only and ordered before cleanup", () => {
  const envGate = stepSection("Validate exact nonsecret signing environment before any config import");
  const forbiddenGate = stepSection("Confirm forbidden credential and signing environment is absent");
  const trustedSigningGate = stepSection("Install exact TrustedSigning module for read-only preflight");
  for (const name of [
    "AZURE_CLIENT_ID",
    "AZURE_TENANT_ID",
    "AZURE_SUBSCRIPTION_ID",
    "AZURE_CODE_SIGNING_ACCOUNT_NAME",
    "AZURE_CODE_SIGNING_PROFILE_NAME",
    "AZURE_CODE_SIGNING_ENDPOINT",
    "AZURE_CODE_SIGNING_PUBLISHER_NAME",
    "AZURE_CODE_SIGNING_TIMESTAMP_URL",
  ]) assert.match(envGate, new RegExp(`\\b${name}\\b`, "u"));
  for (const constant of [
    WINDOWS_PRODUCTION_FINALIZER_AZURE_CLIENT_ID,
    WINDOWS_PRODUCTION_FINALIZER_AZURE_TENANT_ID,
    WINDOWS_PRODUCTION_FINALIZER_AZURE_SUBSCRIPTION_ID,
    WINDOWS_PRODUCTION_FINALIZER_AZURE_ACCOUNT_NAME,
    WINDOWS_PRODUCTION_FINALIZER_AZURE_PROFILE_NAME,
    WINDOWS_PRODUCTION_FINALIZER_AZURE_ENDPOINT,
    WINDOWS_PRODUCTION_FINALIZER_AZURE_PUBLISHER_NAME,
    WINDOWS_PRODUCTION_FINALIZER_AZURE_TIMESTAMP_URL,
  ]) assert.ok(envGate.includes(constant), `exact identity must be scoped to env gate: ${constant}`);
  for (const name of WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.azure
    .forbiddenBuilderEnvironment) {
    assert.ok(forbiddenGate.includes(`'${name}'`), `forbidden environment must be denied: ${name}`);
  }
  for (const pattern of WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.azure
    .forbiddenBuilderEnvironmentPatterns) {
    assert.ok(forbiddenGate.includes(`'${pattern}'`), `forbidden pattern must be denied: ${pattern}`);
  }
  assert.match(
    trustedSigningGate,
    new RegExp(`Install-Module -Name TrustedSigning -RequiredVersion ${WINDOWS_PRODUCTION_FINALIZER_WORKFLOW_POLICY.azure.runtimePreflight.requiredVersion}`, "u"),
  );
  assert.match(trustedSigningGate, /verify-windows-trusted-signing-preflight\.mjs/u);
  const dependencyInstall = workflow.indexOf("Install locked dependencies");
  assert.ok(
    stepOffset("Validate exact nonsecret signing environment before any config import")
      < stepOffset("Confirm forbidden credential and signing environment is absent")
      && dependencyInstall > stepOffset("Confirm forbidden credential and signing environment is absent"),
  );
  assert.ok(
    stepOffset("Install exact TrustedSigning module for read-only preflight")
      > stepOffset("Confirm forbidden credential and signing environment is absent"),
  );
  mustInclude("Azure session: not created");
  mustInclude("Bytes signed: none");
  mustInclude("Artifact retained: none");
  mustInclude("Remove all preflight output and verify checkout remains clean");
});
