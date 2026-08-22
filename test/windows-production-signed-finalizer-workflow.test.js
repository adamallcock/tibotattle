import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

import {
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_ACTIONS,
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_CONFIRMATION_INPUT,
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_CONFIRMATION_VALUE,
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_RECEIPTS,
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_STAGE_ORDER,
  WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_POLICY,
} from "../config/windows-production-signed-finalizer-workflow-contract.js";

const WORKFLOW_PATH = ".github/workflows/windows-production-finalizer-signed.yml";
const workflow = readFileSync(WORKFLOW_PATH, "utf8");

function mustInclude(fragment, message = fragment) {
  assert.equal(workflow.includes(fragment), true, `workflow must include ${message}`);
}

function mustNotInclude(fragment, message = fragment) {
  assert.equal(workflow.includes(fragment), false, `workflow must not include ${message}`);
}

function stepOffset(name) {
  const marker = `      - name: ${name}\n`;
  const offset = workflow.indexOf(marker);
  assert.ok(offset >= 0, `workflow must include step ${name}`);
  return offset;
}

function stepSection(name) {
  const marker = `      - name: ${name}\n`;
  const start = stepOffset(name);
  const end = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, end < 0 ? workflow.length : end);
}

test("signed finalizer is manual, protected, non-cancellable, and has exact permissions", () => {
  mustInclude("name: Windows production finalizer signed candidate");
  mustInclude("on:\n  workflow_dispatch:");
  for (const trigger of ["push:", "pull_request:", "schedule:", "workflow_call:", "workflow_run:"]) {
    mustNotInclude(`\n${trigger}`, `${trigger} trigger`);
  }
  mustInclude("permissions:\n  contents: read\n  actions: read\n  id-token: write");
  mustInclude("runs-on: windows-2025");
  mustInclude("environment: windows-production-signing");
  mustInclude("group: windows-production-finalizer-signed-${{ inputs.source_revision }}");
  mustInclude("cancel-in-progress: false");
  mustInclude(`      ${WINDOWS_PRODUCTION_SIGNED_FINALIZER_CONFIRMATION_INPUT}:`);
  mustInclude(WINDOWS_PRODUCTION_SIGNED_FINALIZER_CONFIRMATION_VALUE);
  assert.deepEqual(WINDOWS_PRODUCTION_SIGNED_FINALIZER_WORKFLOW_POLICY.workflow.permissions, {
    contents: "read",
    actions: "read",
    "id-token": "write",
  });
});

test("source provenance is proven before checkout and no target code runs before it", () => {
  const dispatch = stepOffset("Validate exact dispatch inputs and explicit confirmation");
  const provenance = stepOffset("Fetch and statically validate exact source provenance before checkout");
  const checkout = stepOffset("Check out the exact source revision");
  assert.ok(dispatch < provenance && provenance < checkout);
  const preCheckout = workflow.slice(dispatch, checkout);
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
  const provenanceSection = stepSection("Fetch and statically validate exact source provenance before checkout");
  assert.match(provenanceSection, /gh api --method GET --header 'Accept: application\/vnd\.github\+json'/u);
  assert.match(provenanceSection, /ConvertFrom-Json/u);
  assert.match(provenanceSection, /ReparsePoint/u);
  assert.match(provenanceSection, /sourceRun\.head_sha/u);
  assert.match(provenanceSection, /sourceRun\.conclusion -cne 'success'/u);
  assert.match(provenanceSection, /paginationPresent\.Count -ne 0/u);
});

test("all external actions are pinned to full commit SHAs", () => {
  for (const reference of Object.values(WINDOWS_PRODUCTION_SIGNED_FINALIZER_ACTIONS)) mustInclude(reference);
  for (const line of workflow.split("\n").filter((value) => value.trimStart().startsWith("uses:"))) {
    assert.match(line, /uses: [^@\s]+@[0-9a-f]{40}(?:\s|$)/u);
  }
  assert.equal(
    (workflow.match(/^\s+uses: actions\/download-artifact@[0-9a-f]{40}/gmu) ?? []).length,
    2,
  );
});

test("toolchain, credential gates, Azure login, and signing order are explicit", () => {
  for (const fragment of [
    "node-version: 26.2.0",
    "corepack@0.34.0",
    "pnpm@11.9.0",
    "pnpm install --frozen-lockfile",
    "Install-Module -Name TrustedSigning -RequiredVersion 0.5.0",
    "verify-windows-trusted-signing-preflight.mjs",
    "AZURE_CONFIG_DIR",
    "TIBOTATTLE_ELECTRON_SIGNING_MODE: azure-trusted-signing",
    "--config apps/electron/electron-builder.release.config.cjs",
    "--win nsis --x64 --publish never",
  ]) mustInclude(fragment);
  const envGate = stepOffset("Validate exact nonsecret signing environment before release config import");
  const forbiddenGate = stepOffset("Confirm forbidden credential environment is absent");
  const versionGate = stepOffset("Verify exact package version before production staging");
  const release = stepOffset("Build signed NSIS x64 candidate with electron-builder 26.15.7");
  const login = stepOffset("Establish Azure CLI session late after offline gates");
  const native = stepOffset("Native pre-sign fixed Windows modules");
  assert.ok(envGate < forbiddenGate && forbiddenGate < versionGate
    && versionGate < login && login < native && native < release);
  const versionSection = stepSection("Verify exact package version before production staging");
  assert.match(versionSection, /RELEASE_VERSION/u);
  assert.match(versionSection, /TIBOTATTLE_PACKAGE_VERSION=/u);
  assert.match(workflow, /--profile windows-production/u);
  assert.match(workflow, /--version \$env:TIBOTATTLE_PACKAGE_VERSION/u);
  assert.ok(workflow.indexOf("electron-builder.release.config.cjs") > forbiddenGate);
  const envSection = stepSection("Validate exact nonsecret signing environment before release config import");
  for (const value of [
    "b7f8b18a-4338-40cb-a53a-6a05499be330",
    "485c1020-7234-4307-88ee-67294114f087",
    "8f6118f5-3c88-433d-a2c2-9f4b2aef8b23",
    "tibotattlesigning",
    "tibotattle-windows-public",
    "https://eus.codesigning.azure.net/",
    "Adam Allcock",
    "http://timestamp.acs.microsoft.com",
  ]) assert.ok(envSection.includes(value), `exact Azure value must be checked: ${value}`);
  const loginSection = stepSection("Establish Azure CLI session late after offline gates");
  assert.match(loginSection, /azure\/login@f5d393ae46f8fde4be8b75f32e3fc50e654ad0ca/u);
  assert.match(loginSection, /audience: api:\/\/AzureADTokenExchange/u);
  assert.doesNotMatch(loginSection, /release-builder|electron-builder|Invoke-TrustedSigning/iu);
  assert.match(workflow, /id-token: write is job-wide after the protected environment review/u);
  assert.match(workflow, /Target code can mint an OIDC token/u);
  assert.doesNotMatch(workflow, /target code cannot mint|target code lacks token-mint/iu);
});

test("validated source revision is bound in every step that uses it", () => {
  const sourceRevisionUseSteps = [];
  const lines = workflow.split("\n");
  let currentStep = null;
  let currentSection = [];
  const finish = () => {
    if (currentStep !== null) {
      const section = currentSection.join("\n");
      if (section.includes("$env:SOURCE_REVISION")) {
        sourceRevisionUseSteps.push({ name: currentStep, section });
      }
    }
  };
  for (const line of lines) {
    const marker = line.match(/^      - name: (.+)$/u);
    if (marker) {
      finish();
      currentStep = marker[1];
      currentSection = [line];
    } else if (currentStep !== null) {
      currentSection.push(line);
    }
  }
  finish();
  assert.ok(sourceRevisionUseSteps.length > 0, "workflow must use SOURCE_REVISION in target steps");
  for (const { name, section } of sourceRevisionUseSteps) {
    assert.match(
      section,
      /SOURCE_REVISION:\s*\$\{\{\s*inputs\.source_revision\s*\}\}/u,
      `${name} must bind SOURCE_REVISION from the exact dispatch input`,
    );
  }
});

test("selected download policy and clean roots are gated before artifact downloads", () => {
  const gate = stepOffset("Verify exact selected download policy and absent roots");
  const firstDownload = workflow.indexOf("uses: actions/download-artifact@");
  assert.ok(firstDownload > gate, "download policy gate must precede actions/download-artifact");
  const gateSection = stepSection("Verify exact selected download policy and absent roots");
  for (const fragment of [
    "tibotattle-windows-production-finalizer-receipts/warm",
    "tibotattle-windows-production-finalizer-receipts/clean",
    "selection.download.action -cne 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c'",
    "selection.download.artifactExpectation -cne 'direct-v7'",
    "selection.download.githubToken -cne '${{ github.token }}'",
    "selection.download.destinationMustBeAbsentBeforeDownload -ne $true",
    "selection.download.digestMismatch -cne 'error'",
    "selection.download.mergeMultiple -ne $false",
  ]) assert.ok(gateSection.includes(fragment), `download gate must enforce ${fragment}`);
  assert.match(gateSection, /Test-Path -LiteralPath \$warmRoot/u);
  assert.match(gateSection, /Test-Path -LiteralPath \$cleanRoot/u);
  assert.match(
    gateSection,
    /if \(\(Test-Path -LiteralPath \$warmRoot\) -or \(Test-Path -LiteralPath \$cleanRoot\)\)/u,
  );
});

test("fixed evidence producers run in order and publish no candidate", () => {
  const orderedSteps = [
    "Create fresh fixed production and attempt roots",
    "Select source evidence after checkout",
    "Install locked dependencies",
    "Build production Windows binding and manifest",
    "Stage fresh production Windows Electron app",
    "Seed canonical fixed evidence inputs without clobbering",
    "Build native pre-sign input offline",
    "Install and verify exact TrustedSigning module",
    "Establish Azure CLI session late after offline gates",
    "Native pre-sign fixed Windows modules",
    "Build authority input offline",
    "Run closed authority driver",
    "Build signed NSIS x64 candidate with electron-builder 26.15.7",
    "Verify fixed packaged artifact CLI",
    "Run native Authenticode, installer, and aggregate receipt CLI",
    "Verify aggregate receipt is unpublished and installed lifecycle is not_run",
  ];
  let previous = -1;
  for (const name of orderedSteps) {
    const current = stepOffset(name);
    assert.ok(current > previous, `${name} must be after the preceding stage`);
    previous = current;
  }
  for (const [key, leaf] of Object.entries(WINDOWS_PRODUCTION_SIGNED_FINALIZER_RECEIPTS)) {
    if (key === "nativePresign") continue;
    mustInclude(leaf, `fixed ${key} leaf`);
  }
  mustInclude("verify-windows-production-packaged-artifact.mjs");
  mustInclude("packaged-artifact-receipt.json");
  mustInclude("build-windows-production-finalizer-receipt.mjs");
  mustInclude("windows-production-finalizer-receipt.json");
  mustInclude("WINDOWS_SIGNED_FINALIZER_AGGREGATE_OUTPUT_PREEXISTS");
  mustInclude("WINDOWS_SIGNED_FINALIZER_SERIALIZED_AUTHENTICODE_UNEXPECTED");
  mustInclude("production.ready -ne $false");
  mustInclude("distribution -cne 'unpublished'");
  mustInclude("-cne 'not_run'");
  mustInclude("classes.node");
  mustInclude("classes.unexpected");
});

test("receipt steps do not redirect output and no diagnostic or release publication exists", () => {
  for (const name of [
    "Verify fixed packaged artifact CLI",
    "Run native Authenticode, installer, and aggregate receipt CLI",
  ]) {
    const section = stepSection(name);
    assert.doesNotMatch(section, /(?:^|\s)[12]?>>?\s*[^=]|\bOut-File\b|\bSet-Content\b/imu);
  }
  for (const token of [
    "actions/upload-artifact",
    "gh release",
    "softprops/action-gh-release",
    "update-feed",
    "update feed",
    "npm version",
    "pnpm version",
    "git tag",
  ]) mustNotInclude(token, `publication token ${token}`);
  mustNotInclude("GITHUB_STEP_SUMMARY", "raw diagnostic summary upload");
  mustNotInclude("selector", "selector enablement");
  mustInclude("--publish never");
});

test("native Authenticode and installer evidence are composed only inside the aggregate process", () => {
  mustNotInclude(
    "node ./scripts/verify-windows-production-authenticode-inventory.mjs",
    "standalone Authenticode CLI invocation",
  );
  mustNotInclude(
    "node ./scripts/verify-windows-production-installer.mjs",
    "standalone installer CLI invocation",
  );
  const aggregate = stepSection("Run native Authenticode, installer, and aggregate receipt CLI");
  assert.match(aggregate, /build-windows-production-finalizer-receipt\.mjs/u);
  assert.match(aggregate, /AGGREGATE_OUTPUT_PREEXISTS/u);
  assert.match(aggregate, /SERIALIZED_AUTHENTICODE_UNEXPECTED/u);
  assert.ok(
    aggregate.indexOf("AGGREGATE_OUTPUT_PREEXISTS")
      < aggregate.indexOf("build-windows-production-finalizer-receipt.mjs"),
    "pre-existing serialized leaves must be rejected before native collection",
  );
});

test("cleanup is unconditional, exact-root, and verifies a clean checkout", () => {
  const cleanup = stepSection("Remove exact attempt and signed candidate roots; verify clean checkout");
  assert.match(cleanup, /if: \$\{\{ always\(\) \}\}/u);
  for (const root of [
    ".release-build/electron-production/windows-x64",
    "native/windows-filesystem/build",
    "tibotattle-windows-production-signed-source",
    "tibotattle-windows-production-signed-source-evidence",
    "tibotattle-windows-production-finalizer-receipts",
    "azure-config",
  ]) assert.ok(cleanup.includes(root), `cleanup must remove ${root}`);
  assert.match(cleanup, /IsPathFullyQualified/u);
  assert.match(cleanup, /Resolve-Path/u);
  assert.match(cleanup, /ReparsePoint/u);
  assert.match(cleanup, /Get-ChildItem -LiteralPath \$target\.Path -Force -Recurse/u);
  assert.match(cleanup, /WINDOWS_SIGNED_FINALIZER_CLEANUP_REQUIRED/u);
  assert.match(cleanup, /\$unsafe -contains \$target\.Path/u);
  assert.match(cleanup, /native reparse\/race qualification remains/u);
  assert.match(cleanup, /Remove-Item -LiteralPath \$target\.Path -Recurse -Force/u);
  assert.match(cleanup, /WINDOWS_SIGNED_FINALIZER_CLEANUP_INCOMPLETE/u);
  assert.match(cleanup, /git diff --quiet/u);
  assert.match(cleanup, /git diff --cached --quiet/u);
  assert.match(cleanup, /git ls-files --others --exclude-standard/u);
});
