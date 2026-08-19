import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FIXED_STATUS,
  WINDOWS_SECURITY_QUALIFICATION_TEST_FILES,
  parseTapSummary,
  qualificationReceiptMetadata,
  qualificationTestFiles,
  readVerifiedBindingManifest,
} from "../scripts/windows-security-qualification.mjs";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("Windows security workflow is manual, pinned, read-only, and content-free", async () => {
  const workflow = await readFile(
    resolve(REPOSITORY_ROOT, ".github/workflows/windows-portability.yml"),
    "utf8",
  );
  const qualificationScript = await readFile(
    resolve(REPOSITORY_ROOT, "scripts/windows-security-qualification.mjs"),
    "utf8",
  );
  assert.match(workflow, /^on:\n  workflow_dispatch:/mu);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request):/mu);
  assert.match(workflow, /permissions:\n  contents: read\n/u);
  assert.match(workflow, /USAGE_MONITOR_WINDOWS_QUALIFICATION: "1"/u);
  assert.match(workflow, /TIBOTATTLE_WINDOWS_QUALIFICATION_STATE_ROOT/u);
  assert.match(workflow, /cache-mode:\n\s+- warm\n\s+- clean/u);
  assert.match(workflow, /matrix\.cache-mode == 'warm'/u);
  assert.doesNotMatch(workflow, /inputs\.clean-cache/u);
  assert.match(workflow, /pnpm test:portable/u);
  assert.match(workflow, /windows-security-qualification\.mjs/u);
  assert.match(workflow, /\$nodeGypScript rebuild --directory native\/windows-filesystem/u);
  assert.match(
    workflow,
    /-- -Dtibotattle_build_qualification=1/u,
  );
  assert.match(workflow, /windows_filesystem_qualification\.node/u);
  assert.match(workflow, /Move-Item -LiteralPath \$qualificationBindingPath -Destination \$qualificationDestination/u);
  assert.match(workflow, /TIBOTATTLE_WINDOWS_QUALIFICATION_BINDING_PATH=\$qualificationDestination/u);
  assert.match(workflow, /WINDOWS_FILESYSTEM_QUALIFICATION_BINDING_MOVE_FAILED/u);
  assert.match(workflow, /WINDOWS_FILESYSTEM_PRODUCTION_BUILD_EMITTED_QUALIFICATION/u);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /WINDOWS_QUALIFICATION_REVISION_MISMATCH/u);
  assert.match(workflow, /build-windows-filesystem-manifest\.mjs/u);
  assert.match(workflow, /TIBOTATTLE_WINDOWS_BINDING_SHA256/u);
  assert.match(workflow, /TIBOTATTLE_WINDOWS_BINDING_BYTES/u);
  assert.match(workflow, /TIBOTATTLE_QUALIFICATION_REVISION/u);
  assert.match(workflow, /WINDOWS_QUALIFICATION_NODE_VERSION_MISMATCH/u);
  assert.match(workflow, /WINDOWS_QUALIFICATION_PNPM_VERSION_MISMATCH/u);
  assert.match(workflow, /WINDOWS_QUALIFICATION_COREPACK_VERSION_MISMATCH/u);
  assert.match(workflow, /Get-Content -LiteralPath \$productionBuildLog -Tail 200/u);
  assert.match(workflow, /Get-Content -LiteralPath \$qualificationBuildLog -Tail 200/u);
  assert.match(workflow, /Get-Content -LiteralPath \$portableLog -Tail 240/u);
  assert.ok(
    workflow.indexOf("Run portable Windows qualification")
      < workflow.indexOf("Prepare disposable qualification state root"),
    "the disposable CODEX_HOME must not affect the ordinary portable lane",
  );
  assert.match(workflow, /pnpm install --frozen-lockfile --offline/u);
  assert.match(workflow, /--store-dir \$cleanStore/u);
  assert.match(workflow, /Canonical deferrals:/u);
  assert.match(workflow, /Credential mutex contract: windows-credential-mutex-v1/u);
  assert.match(workflow, /Credential audit file guard: windows-credential-audit-file-guard-v1/u);
  assert.match(workflow, /durable prepared\/settled\/recovered credential audit/u);
  assert.doesNotMatch(workflow, /Deferred: cross-process credential mutex/u);
  assert.match(workflow, /passed=\$\{?receipt|Result: \$result/u);

  const qualificationStep = workflow.indexOf(
    "- name: Run content-free Windows security qualification",
  );
  const revisionGate = workflow.indexOf(
    "- name: Reconfirm checked-out revision before Electron artifact work",
  );
  const stagingStep = workflow.indexOf(
    "- name: Stage exact Windows x64 Electron development inputs",
  );
  const packagingStep = workflow.indexOf(
    "- name: Build unsigned Windows x64 Electron directory artifact",
  );
  const verificationStep = workflow.indexOf(
    "- name: Verify Windows Electron development artifact",
  );
  const cleanupStep = workflow.indexOf(
    "- name: Remove generated Electron artifact tree before clean checkout gate",
  );
  const cleanCheckoutStep = workflow.indexOf(
    "- name: Confirm qualification and artifact work did not modify the checkout",
  );
  assert.ok(
    qualificationStep >= 0
      && qualificationStep < revisionGate
      && revisionGate < stagingStep
      && stagingStep < packagingStep
      && packagingStep < verificationStep
      && verificationStep < cleanupStep
      && cleanupStep < cleanCheckoutStep,
    "Electron artifact work must follow native qualification and precede the final clean-checkout gate",
  );
  assert.match(workflow, /WINDOWS_ELECTRON_REVISION_MISMATCH/u);
  assert.match(workflow, /WINDOWS_QUALIFICATION_REVISION_MISMATCH/u);
  assert.match(workflow, /\.release-build\/electron-dev\/windows-x64\/app/u);
  assert.match(workflow, /\.release-build\/electron-dev\/windows-x64\/artifacts/u);
  assert.match(workflow, /native\/windows-filesystem\/build\/Release\/windows_filesystem\.node/u);
  assert.match(workflow, /native\/windows-filesystem\/build\/Release\/windows_filesystem\.node\.manifest\.json/u);
  assert.match(workflow, /--target win32/u);
  assert.match(workflow, /--output \$stagedAppPath/u);
  assert.match(workflow, /--windows-binding \$windowsBindingPath/u);
  assert.match(workflow, /--windows-manifest \$windowsManifestPath/u);
  assert.match(workflow, /TIBOTATTLE_ELECTRON_TARGET = 'win32'/u);
  assert.match(workflow, /pnpm exec electron-builder --version/u);
  assert.match(workflow, /26\.15\.7/u);
  assert.match(workflow, /--config apps\/electron\/electron-builder\.config\.cjs/u);
  assert.match(workflow, /--win dir/u);
  assert.match(workflow, /--x64/u);
  assert.match(workflow, /--publish never/u);
  assert.match(workflow, /win-unpacked/u);
  assert.match(workflow, /resources\/app\.asar/u);
  assert.match(workflow, /resources\/app\.asar\.unpacked/u);
  assert.match(workflow, /--target win32-x64/u);
  assert.match(workflow, /--app \$env:TIBOTATTLE_ELECTRON_STAGED_APP_PATH/u);
  assert.match(workflow, /--asar \$env:TIBOTATTLE_ELECTRON_ASAR_PATH/u);
  assert.match(workflow, /--unpacked \$env:TIBOTATTLE_ELECTRON_UNPACKED_PATH/u);
  assert.match(workflow, /ELECTRON_DEVELOPMENT_ARTIFACT_VERIFIED/u);
  assert.match(workflow, /ELECTRON_ARTIFACT_EVIDENCE_NOT_CONTENT_FREE/u);
  assert.match(workflow, /SHA-256:/u);
  assert.match(workflow, /Runtime launch: not performed/u);
  assert.match(workflow, /Windows production readiness: not claimed/u);
  assert.match(workflow, /Signing, notarization, installer, updater, and publication: not performed/u);
  assert.match(workflow, /WINDOWS_ELECTRON_INSTALLER_OUTPUT_UNEXPECTED/u);
  assert.doesNotMatch(
    workflow.slice(stagingStep, cleanCheckoutStep),
    /(?:--publish\s+(?!never)|--nsis|--msi|--appx|--portable)/u,
  );
  assert.doesNotMatch(
    workflow.slice(verificationStep, cleanCheckoutStep),
    /(?:electron(?:\.exe)?\s+launch|Start-Process|child_process\.spawn|app\.quit)/iu,
  );
  assert.match(qualificationScript, /--test-reporter=tap/u);
  assert.match(qualificationScript, /GITHUB_ACTIONS/u);
  assert.doesNotMatch(workflow, /npm exec --yes|pnpm dlx/u);
  assert.match(workflow, /git diff --quiet/u);
  assert.match(workflow, /git diff --cached --quiet/u);
  assert.doesNotMatch(workflow, /git diff --exit-code/u);
  assert.doesNotMatch(workflow, /USAGE_MONITOR_TEST_LANE_REPORTER: spec/u);
  assert.doesNotMatch(workflow, /(?:icacls|Get-Acl|GetAccessControl|Write-Host)/iu);

  const actions = [...workflow.matchAll(/^\s+uses:\s+([^\s#]+)/gmu)]
    .map((match) => match[1]);
  assert.ok(actions.length > 0);
  assert.equal(actions.every((action) => /@[0-9a-f]{40}$/u.test(action)), true);
});

test("qualification selection is fail-closed away from native Windows", async () => {
  const selected = await qualificationTestFiles({
    platform: "darwin",
    architecture: "arm64",
  });
  assert.deepEqual(selected, {
    status: "unsupported",
    files: [],
    filesystemFiles: [],
    credentialFiles: [],
  });
  assert.equal(FIXED_STATUS.unsupported, "WINDOWS_SECURITY_QUALIFICATION_NATIVE_WINDOWS_REQUIRED");
});

test("qualification selection is the exact reviewed Windows test set", async () => {
  const selected = await qualificationTestFiles({
    platform: "win32",
    architecture: "x64",
  });
  assert.deepEqual(selected.files, WINDOWS_SECURITY_QUALIFICATION_TEST_FILES);
  assert.deepEqual(selected.files, [
    "test/windows-credential-manager-probe.test.js",
    "test/windows-credential-audit-file-guard.test.js",
    "test/windows-credential-manager.test.js",
    "test/windows-credential-mutex-native.test.js",
    "test/windows-credential-mutex.test.js",
    "test/windows-credential-operation-audit.test.js",
    "test/windows-credential-operation-lease.test.js",
    "test/windows-production-readiness.test.js",
    "test/windows-filesystem-loader.test.js",
    "test/windows-filesystem-manifest.test.js",
    "test/windows-filesystem-provenance.test.js",
    "test/windows-filesystem-native-contract.test.js",
    "test/windows-filesystem-security.test.js",
    "test/windows-security-consumer-composition.test.js",
    "test/windows-sqlite-state-session-native.test.js",
    "test/windows-path-contract.test.js",
    "test/windows-qualification-governance.test.js",
    "test/windows-skip-ledger.test.js",
    "test/windows-test-manifest.test.js",
  ]);
});

test("qualification receipts accept only fixed aggregate revision and cache metadata", () => {
  assert.deepEqual(
    qualificationReceiptMetadata({
      USAGE_MONITOR_WINDOWS_QUALIFICATION: "1",
      TIBOTATTLE_QUALIFICATION_REVISION: "A".repeat(40),
      TIBOTATTLE_QUALIFICATION_CACHE_MODE: "warm",
      GITHUB_ACTIONS: "true",
    }),
    {
      cacheMode: "warm",
      revision: "a".repeat(40),
    },
  );
  assert.throws(
    () => qualificationReceiptMetadata({
      USAGE_MONITOR_WINDOWS_QUALIFICATION: "1",
      TIBOTATTLE_QUALIFICATION_REVISION: "not-a-revision",
      TIBOTATTLE_QUALIFICATION_CACHE_MODE: "warm",
      GITHUB_ACTIONS: "true",
    }),
    (error) => error.code === FIXED_STATUS.revisionInvalid,
  );
  assert.throws(
    () => qualificationReceiptMetadata({
      USAGE_MONITOR_WINDOWS_QUALIFICATION: "1",
      TIBOTATTLE_QUALIFICATION_REVISION: "A".repeat(40),
      TIBOTATTLE_QUALIFICATION_CACHE_MODE: "other",
      GITHUB_ACTIONS: "true",
    }),
    (error) => error.code === FIXED_STATUS.cacheModeInvalid,
  );
  assert.throws(
    () => qualificationReceiptMetadata({
      USAGE_MONITOR_WINDOWS_QUALIFICATION: "1",
    }),
    (error) => error.code === FIXED_STATUS.revisionInvalid,
  );
  assert.throws(
    () => qualificationReceiptMetadata({
      USAGE_MONITOR_WINDOWS_QUALIFICATION: "1",
      TIBOTATTLE_QUALIFICATION_REVISION: "A".repeat(40),
      TIBOTATTLE_QUALIFICATION_CACHE_MODE: "clean",
    }),
    (error) => error.code === FIXED_STATUS.environmentInvalid,
  );
});

test("qualification manifest requires the exact unqualified development provenance", async () => {
  const baseManifest = {
    schemaVersion: "windows-filesystem-binding-manifest-v1",
    bindingFile: "windows_filesystem.node",
    platform: "win32",
    architecture: "x64",
    bytes: 1,
    sha256: "0".repeat(64),
    approvedPolicy: {
      productionSafe: false,
      pathWalkRaceSafe: false,
      credentialMutexSafe: true,
      credentialAuditFileGuardSafe: true,
      sqliteStateLeaseSafe: false,
    },
    nativeClaims: {
      credentialAuditFileGuardSafe: true,
      sqliteStateLeaseSafe: false,
    },
    credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
    sqliteStateLeaseContractVersion: "windows-sqlite-state-lease-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    bindingProvenance: {
      contractVersion: "windows-binding-provenance-v1",
      status: "unqualified",
      source: "unsigned-development-binding",
    },
  };
  const valid = await readVerifiedBindingManifest({
    readManifest: async () => JSON.stringify(baseManifest),
  });
  assert.deepEqual(valid, { bytes: 1, sha256: "0".repeat(64) });

  for (const bindingProvenance of [
    null,
    {},
    {
      contractVersion: "windows-binding-provenance-v2",
      status: "unqualified",
      source: "unsigned-development-binding",
    },
    {
      contractVersion: "windows-binding-provenance-v1",
      status: "authenticated",
      source: "unsigned-development-binding",
    },
    {
      contractVersion: "windows-binding-provenance-v1",
      status: "unqualified",
      source: "audited-signed-native-binding",
    },
    {
      contractVersion: "windows-binding-provenance-v1",
      status: "unqualified",
      source: "unsigned-development-binding",
      extra: "reject",
    },
  ]) {
    await assert.rejects(
      readVerifiedBindingManifest({
        readManifest: async () => JSON.stringify({ ...baseManifest, bindingProvenance }),
      }),
      (error) => error.code === FIXED_STATUS.manifestInvalid,
    );
  }
});

test("qualification TAP receipts reject skips and malformed summaries", () => {
  const clean = [
    "# tests 12",
    "# pass 12",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
  ].join("\n");
  assert.deepEqual(parseTapSummary(clean), {
    tests: 12,
    passed: 12,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    todo: 0,
  });
  assert.throws(
    () => parseTapSummary(clean.replace("# pass 12", "# pass 11").replace("# skipped 0", "# skipped 1")),
    (error) => error.code === FIXED_STATUS.unexpectedSkip,
  );
  assert.throws(
    () => parseTapSummary("# tests 1\n# pass 1"),
    (error) => error.code === FIXED_STATUS.resultInvalid,
  );
});
