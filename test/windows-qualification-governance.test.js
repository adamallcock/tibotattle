import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  FIXED_STATUS,
  WINDOWS_SECURITY_QUALIFICATION_TEST_FILES,
  parseTapSummary,
  qualificationReceiptMetadata,
  qualificationTestFiles,
  readVerifiedBindingManifest,
  runNodeTests,
} from "../scripts/windows-security-qualification.mjs";
import {
  FIXED_STATUS as WINDOWS_RECEIPT_STATUS,
  buildWindowsElectronQualificationReceipt,
  parseQualificationResult,
  validatePackagedEvidence,
  validateRuntimeEvidence,
} from "../scripts/build-windows-electron-qualification-receipt.mjs";

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
  const runtimeStep = workflow.indexOf(
    "- name: Run Windows Electron x64 runtime smoke",
  );
  const receiptStep = workflow.indexOf(
    "- name: Create content-free Windows Electron qualification receipt",
  );
  const uploadStep = workflow.indexOf(
    "- name: Retain exact Windows x64 development artifact and qualification receipt",
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
      && verificationStep < runtimeStep
      && runtimeStep < receiptStep
      && receiptStep < uploadStep
      && verificationStep < cleanupStep
      && cleanupStep < cleanCheckoutStep,
    "Electron verification, runtime smoke, receipt, upload, cleanup, and final clean-checkout gate must remain ordered",
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
  assert.match(workflow, /Runtime qualification: deferred to the native Windows Electron smoke step/u);
  assert.match(workflow, /smoke-electron-windows\.mjs/u);
  assert.match(workflow, /WINDOWS_ELECTRON_RUNTIME_SMOKE_EVIDENCE_NOT_CONTENT_FREE/u);
  assert.match(workflow, /build-windows-electron-qualification-receipt\.mjs/u);
  assert.match(workflow, /TIBOTATTLE_ELECTRON_QUALIFICATION_RECEIPT_PATH/u);
  assert.match(workflow, /WINDOWS_ELECTRON_DEVELOPMENT_QUALIFICATION_PASSED/u);
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u);
  assert.match(workflow, /tibotattle-windows-x64-electron-\$\{\{ github\.sha \}\}-\$\{\{ matrix\.cache-mode \}\}/u);
  assert.match(workflow, /if-no-files-found: error/u);
  assert.match(workflow, /retention-days: 3/u);
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
  assert.match(qualificationScript, /QUALIFICATION_RUN_TIMEOUT_MS/u);
  assert.match(qualificationScript, /QUALIFICATION_MAXIMUM_CAPTURE_BYTES/u);
  assert.match(qualificationScript, /captureStopped = true/u);
  assert.match(qualificationScript, /stdout = ""/u);
  assert.match(qualificationScript, /child\.stdout\.pause\(\)/u);
  assert.match(qualificationScript, /if \(terminationRequested\) return/u);
  assert.match(qualificationScript, /FIXED_STATUS\.terminationFailed/u);
  assert.match(
    qualificationScript,
    /if \(child\.exitCode !== null \|\| child\.signalCode !== null\) return false/u,
  );
  assert.match(
    qualificationScript,
    /Deliberately do not forward the test-only process injection seams/u,
  );
  assert.match(qualificationScript, /taskkill\.exe/u);
  assert.match(qualificationScript, /"\/t"/u);
  assert.match(qualificationScript, /"\/f"/u);
  assert.doesNotMatch(workflow, /npm exec --yes|pnpm dlx/u);
  assert.match(workflow, /git diff --quiet/u);
  assert.match(workflow, /git diff --cached --quiet/u);
  assert.doesNotMatch(workflow, /git diff --exit-code/u);
  assert.doesNotMatch(workflow, /USAGE_MONITOR_TEST_LANE_REPORTER: spec/u);
  assert.doesNotMatch(workflow, /(?:icacls|Get-Acl|GetAccessControl|Write-Host)/iu);
  assert.match(workflow, /- name: Remove generated Electron artifact tree before clean checkout gate\n\s+if: \$\{\{ always\(\) \}\}/u);
  assert.match(workflow, /- name: Confirm qualification and artifact work did not modify the checkout\n\s+if: \$\{\{ always\(\) \}\}/u);

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
  assert.equal(FIXED_STATUS.timedOut, "WINDOWS_SECURITY_QUALIFICATION_TIMED_OUT");
  assert.equal(
    FIXED_STATUS.terminationFailed,
    "WINDOWS_SECURITY_QUALIFICATION_TERMINATION_FAILED",
  );
});

test("qualification child timeout settles with the fixed timeout status", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 4242;
  child.kill = () => true;
  let finishTermination;
  const termination = new Promise((resolveTermination) => {
    finishTermination = resolveTermination;
  });
  const run = runNodeTests(["synthetic.test.js"], {
    cwd: REPOSITORY_ROOT,
    timeoutMs: 5,
    spawnProcess: () => child,
    terminateProcessTree: async () => termination,
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 15));
  child.emit("error", new Error("synthetic termination race"));
  finishTermination(true);
  await assert.rejects(
    run,
    (error) => error.code === FIXED_STATUS.timedOut,
  );
});

test("qualification capture overflow stops buffering and fails content-free", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 4243;
  child.kill = () => true;
  const run = runNodeTests(["synthetic.test.js"], {
    cwd: REPOSITORY_ROOT,
    timeoutMs: 1_000,
    maximumCaptureBytes: 16,
    spawnProcess: () => child,
    terminateProcessTree: async () => true,
  });
  child.stdout.write("x".repeat(17));
  await assert.rejects(
    run,
    (error) => error.code === FIXED_STATUS.failed,
  );
});

test("qualification selection is the exact reviewed Windows test set", async () => {
  const selected = await qualificationTestFiles({
    platform: "win32",
    architecture: "x64",
  });
  assert.deepEqual(selected.files, WINDOWS_SECURITY_QUALIFICATION_TEST_FILES);
  assert.deepEqual(selected.files, [
    "test/windows-qualification-mode.test.js",
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
    "test/windows-filesystem-companion-instance-lease.test.js",
    "test/windows-filesystem-security.test.js",
    "test/windows-filesystem-prepared-artifact-native.test.js",
    "test/windows-protected-state-store.test.js",
    "test/windows-sqlite-state-session-contract.test.js",
    "test/windows-fixed-state-storage.test.js",
    "test/windows-prepared-artifact-storage.test.js",
    "test/windows-review-pair-storage.test.js",
    "test/windows-contribution-sync-queue-storage.test.js",
    "test/windows-prepared-contribution.test.js",
    "test/local-collector-state-session.test.js",
    "test/windows-security-consumer-composition.test.js",
    "test/windows-sqlite-state-session-native.test.js",
    "test/claude-callback-windows-native.test.js",
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
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
    sqliteStateLeaseContractVersion: "windows-sqlite-state-lease-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    companionInstanceMutexContractVersion: "windows-companion-instance-mutex-v1",
    preparedArtifactContractVersion: "windows-prepared-artifact-v1",
    requiredMethods: [
      "inspectPath",
      "ensureDirectory",
      "readFile",
      "readFileBounded",
      "createFile",
      "deleteFile",
      "replaceFile",
      "inspectProtectedChild",
      "readProtectedChild",
      "createProtectedChild",
      "deleteProtectedChild",
      "replaceProtectedChild",
      "acquireSqliteStateLease",
      "releaseSqliteStateLease",
      "acquireCredentialAuditFileGuard",
      "releaseCredentialAuditFileGuard",
      "acquireCredentialMutex",
      "releaseCredentialMutex",
      "acquireCompanionInstanceMutex",
      "releaseCompanionInstanceMutex",
      "inspectPreparedChild",
      "ensurePreparedDirectory",
      "enumeratePreparedDirectory",
      "removePreparedDirectory",
      "renamePreparedDirectory",
      "createPreparedFile",
      "readPreparedFile",
      "deletePreparedFile",
      "publishPreparedFile",
    ],
    approvedPolicy: {
      productionSafe: false,
      pathWalkRaceSafe: false,
      credentialMutexSafe: true,
      companionInstanceMutexSafe: false,
      credentialAuditFileGuardSafe: true,
      sqliteStateLeaseSafe: false,
      preparedArtifactSafe: false,
    },
    nativeClaims: {
      productionSafe: false,
      pathWalkRaceSafe: false,
      credentialMutexSafe: true,
      credentialAuditFileGuardSafe: true,
      companionInstanceMutexSafe: false,
      sqliteStateLeaseSafe: false,
      preparedArtifactSafe: false,
    },
    credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
    sqliteStateLeaseContractVersion: "windows-sqlite-state-lease-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    companionInstanceMutexContractVersion: "windows-companion-instance-mutex-v1",
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

function windowsReceiptFixture({
  revision = "a".repeat(40),
  cacheMode = "warm",
  bindingBytes = 1234,
  bindingSha256 = "b".repeat(64),
} = {}) {
  const aggregate = {
    bytes: 4567,
    count: 89,
    sha256: "c".repeat(64),
  };
  const binding = {
    bytes: bindingBytes,
    sha256: bindingSha256,
  };
  return {
    revision,
    target: "win32-x64",
    cacheMode,
    bindingSha256,
    bindingBytes,
    qualificationResult: [
      "WINDOWS_SECURITY_QUALIFICATION_PASSED",
      "files=22",
      "filesystem=10",
      "credentials=8",
      `revision=${revision}`,
      `cache=${cacheMode}`,
      `binding_bytes=${bindingBytes}`,
      `binding_sha256=${bindingSha256}`,
      "tests=37",
      "passed=37",
      "failed=0",
      "skipped=0",
      "duration_ms=42",
    ].join(" "),
    packagedEvidence: {
      artifact: aggregate,
      asar: aggregate,
      binding: {
        ...binding,
        status: "included_unverified",
      },
      nativeFileCount: 2,
      staged: aggregate,
      status: "ELECTRON_DEVELOPMENT_ARTIFACT_VERIFIED",
      target: "win32-x64",
      unpacked: aggregate,
    },
    runtimeEvidence: {
      artifact: true,
      cleanQuit: true,
      contentFree: true,
      credentialPersistence: true,
      dashboardReady: true,
      noOrphan: true,
      relaunchPersistence: true,
      secondInstanceRejected: true,
      showHideTrayLifecycle: true,
      statePersistence: true,
      status: "passed",
      syntheticRefresh: true,
      target: "win32-x64",
    },
  };
}

test("Windows Electron qualification receipt is exact-revision and content-free", () => {
  const fixture = windowsReceiptFixture();
  const receipt = buildWindowsElectronQualificationReceipt(fixture);
  assert.deepEqual(receipt, {
    binding: {
      bytes: 1234,
      sha256: "b".repeat(64),
    },
    cacheMode: "warm",
    mode: "qualification_only",
    packaged: {
      artifact: { bytes: 4567, count: 89, sha256: "c".repeat(64) },
      asar: { bytes: 4567, count: 89, sha256: "c".repeat(64) },
      binding: {
        bytes: 1234,
        sha256: "b".repeat(64),
        status: "included_unverified",
      },
      nativeFileCount: 2,
      staged: { bytes: 4567, count: 89, sha256: "c".repeat(64) },
      status: "ELECTRON_DEVELOPMENT_ARTIFACT_VERIFIED",
      target: "win32-x64",
      unpacked: { bytes: 4567, count: 89, sha256: "c".repeat(64) },
    },
    productionReadiness: "not_claimed",
    qualification: {
      credentialTestFileCount: 8,
      filesystemTestFileCount: 10,
      failed: 0,
      passed: 37,
      skipped: 0,
      status: "WINDOWS_SECURITY_QUALIFICATION_PASSED",
      testFileCount: 22,
      tests: 37,
    },
    revision: "a".repeat(40),
    runtime: {
      checks: {
        cleanQuit: true,
        credentialPersistence: true,
        dashboardReady: true,
        diagnostics: "content-free",
        launched: true,
        noOrphanProcesses: true,
        relaunchPersistence: true,
        singleInstanceRejected: true,
        statePersistence: true,
        syntheticRefresh: true,
        trayWindowLifecycle: true,
      },
      status: "WINDOWS_ELECTRON_RUNTIME_SMOKE_PASSED",
      target: "win32-x64",
    },
    schemaVersion: "tibotattle-windows-electron-development-qualification-v1",
    status: "WINDOWS_ELECTRON_DEVELOPMENT_QUALIFICATION_PASSED",
    target: "win32-x64",
  });
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, /[A-Za-z]:[\\/]/u);
  assert.doesNotMatch(serialized, /\/Users\/|\/home\//u);
  assert.equal(serialized.includes("\\Users\\"), false);
  assert.doesNotMatch(serialized, /username|(?:password|secret|token|pid|process|env)(?:["':=]|$)/iu);
  assert.doesNotMatch(serialized, /(?:stdout|stderr|command|executable|diagnostic[^s])/iu);
});

test("Windows Electron qualification receipt rejects incomplete or mismatched evidence", () => {
  const fixture = windowsReceiptFixture();
  assert.deepEqual(
    validatePackagedEvidence(fixture.packagedEvidence, {
      bytes: fixture.bindingBytes,
      sha256: fixture.bindingSha256,
    }).binding,
    {
      bytes: fixture.bindingBytes,
      sha256: fixture.bindingSha256,
      status: "included_unverified",
    },
  );
  assert.deepEqual(
    parseQualificationResult(fixture.qualificationResult, {
      binding: { bytes: fixture.bindingBytes, sha256: fixture.bindingSha256 },
      cacheMode: fixture.cacheMode,
      revision: fixture.revision,
    }).status,
    "WINDOWS_SECURITY_QUALIFICATION_PASSED",
  );
  assert.deepEqual(
    validateRuntimeEvidence(fixture.runtimeEvidence).status,
    "WINDOWS_ELECTRON_RUNTIME_SMOKE_PASSED",
  );
  assert.throws(
    () => buildWindowsElectronQualificationReceipt({
      ...fixture,
      revision: "d".repeat(40),
    }),
    (error) => error.code === WINDOWS_RECEIPT_STATUS.qualificationInvalid,
  );
  assert.throws(
    () => buildWindowsElectronQualificationReceipt({
      ...fixture,
      runtimeEvidence: {
        ...fixture.runtimeEvidence,
        noOrphan: false,
      },
    }),
    (error) => error.code === WINDOWS_RECEIPT_STATUS.runtimeInvalid,
  );
  assert.throws(
    () => buildWindowsElectronQualificationReceipt({
      ...fixture,
      packagedEvidence: {
        ...fixture.packagedEvidence,
        appPath: "/Users/owner/private",
      },
    }),
    (error) => error.code === WINDOWS_RECEIPT_STATUS.packageInvalid,
  );
  assert.throws(
    () => buildWindowsElectronQualificationReceipt({
      ...fixture,
      qualificationResult: `${fixture.qualificationResult} username=owner`,
    }),
    (error) => error.code === WINDOWS_RECEIPT_STATUS.qualificationInvalid,
  );
});

test("Windows Electron qualification receipt CLI validates and writes its canonical receipt", async () => {
  const fixture = windowsReceiptFixture();
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-windows-receipt-"));
  const qualificationPath = join(directory, "qualification.txt");
  const packagedPath = join(directory, "packaged.json");
  const runtimePath = join(directory, "runtime.json");
  const outputPath = join(directory, "receipt.json");
  try {
    await Promise.all([
      writeFile(qualificationPath, `${fixture.qualificationResult}\n`),
      writeFile(packagedPath, `${JSON.stringify(fixture.packagedEvidence)}\n`),
      writeFile(runtimePath, `${JSON.stringify(fixture.runtimeEvidence)}\n`),
    ]);
    const result = spawnSync(process.execPath, [
      "scripts/build-windows-electron-qualification-receipt.mjs",
      "--output", outputPath,
      "--revision", fixture.revision,
      "--target", fixture.target,
      "--cache-mode", fixture.cacheMode,
      "--binding-sha256", fixture.bindingSha256,
      "--binding-bytes", String(fixture.bindingBytes),
      "--qualification-result", qualificationPath,
      "--packaged-evidence", packagedPath,
      "--runtime-evidence", runtimePath,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      cacheMode: fixture.cacheMode,
      revision: fixture.revision,
      status: "WINDOWS_ELECTRON_DEVELOPMENT_QUALIFICATION_PASSED",
      target: fixture.target,
    });
    const receipt = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(receipt.status, "WINDOWS_ELECTRON_DEVELOPMENT_QUALIFICATION_PASSED");
    assert.equal(receipt.runtime.status, "WINDOWS_ELECTRON_RUNTIME_SMOKE_PASSED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
