import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FIXED_STATUS,
  WINDOWS_SECURITY_QUALIFICATION_TEST_FILES,
  formatQualificationFailureDiagnostic,
  parseTapSummary,
  parseTapFailureDiagnostic,
  readVerifiedBindingManifest,
  qualificationReceiptMetadata,
  qualificationTestFiles,
} from "../scripts/windows-security-qualification.mjs";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("Windows qualification requires the exact approved source-read capability", async () => {
  const manifest = {
    schemaVersion: "windows-filesystem-binding-manifest-v1",
    bindingFile: "windows_filesystem.node", platform: "win32", architecture: "x64",
    bytes: 1, sha256: "0".repeat(64),
    approvedPolicy: { productionSafe: false, pathWalkRaceSafe: false,
      credentialMutexSafe: true, credentialAuditFileGuardSafe: true },
    nativeClaims: { credentialAuditFileGuardSafe: true },
    credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    sourceRead: { contractVersion: "windows-source-read-v1", approved: true },
  };
  const read = value => readVerifiedBindingManifest({ readManifest: async () => JSON.stringify(value) });
  assert.deepEqual(await read(manifest), { bytes: 1, sha256: "0".repeat(64) });
  for (const sourceRead of [undefined, { ...manifest.sourceRead, approved: false },
    { ...manifest.sourceRead, contractVersion: "future" },
    { ...manifest.sourceRead, extra: false }]) {
    await assert.rejects(read({ ...manifest, sourceRead }), { code: FIXED_STATUS.manifestInvalid });
  }
});

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
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /fetch-depth: 0/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /WINDOWS_QUALIFICATION_REVISION_MISMATCH/u);
  assert.match(workflow, /build-windows-filesystem-manifest\.mjs/u);
  assert.match(workflow, /TIBOTATTLE_WINDOWS_BINDING_SHA256/u);
  assert.match(workflow, /TIBOTATTLE_WINDOWS_BINDING_BYTES/u);
  assert.match(workflow, /TIBOTATTLE_QUALIFICATION_REVISION/u);
  assert.match(workflow, /WINDOWS_QUALIFICATION_NODE_VERSION_MISMATCH/u);
  assert.match(workflow, /WINDOWS_QUALIFICATION_PNPM_VERSION_MISMATCH/u);
  assert.match(workflow, /WINDOWS_QUALIFICATION_COREPACK_VERSION_MISMATCH/u);
  assert.match(workflow, /Get-Content -LiteralPath \$buildLog -Tail 200/u);
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
    accountlessCredentialFiles: [],
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
    "test/model-performance.test.js",
    "test/windows-credential-manager-probe.test.js",
    "test/windows-credential-audit-file-guard.test.js",
    "test/windows-credential-manager.test.js",
    "test/windows-credential-mutex-native.test.js",
    "test/windows-accountless-installation-credential-native.test.js",
    "test/windows-credential-mutex.test.js",
    "test/windows-credential-operation-audit.test.js",
    "test/windows-credential-operation-lease.test.js",
    "test/windows-production-readiness.test.js",
    "test/windows-filesystem-loader.test.js",
    "test/windows-filesystem-manifest.test.js",
    "test/windows-filesystem-native-contract.test.js",
    "test/windows-filesystem-security.test.js",
    "test/windows-path-contract.test.js",
    "test/windows-qualification-governance.test.js",
    "test/windows-skip-ledger.test.js",
    "test/windows-test-manifest.test.js",
  ]);
  assert.deepEqual(selected.accountlessCredentialFiles, [
    "test/windows-accountless-installation-credential-native.test.js",
  ]);
  assert.equal(
    selected.credentialFiles.includes(
      "test/windows-accountless-installation-credential-native.test.js",
    ),
    true,
  );
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

test("qualification TAP failure diagnostics retain only bounded structural indexes", () => {
  const canary = "PRIVATE-TAP-TITLE C:\\Users\\PRIVATE\\secret.txt";
  const output = [
    "TAP version 13",
    `not ok 4 - ${canary}`,
    "  ---",
    "  duration_ms: 0.12",
    "  location: '/private/tmp/PRIVATE/test/model-performance.test.js:123:4'",
    "  failureType: 'testCodeFailure'",
    "  name: 'AssertionError'",
    "  stack: |-",
    "    Error: PRIVATE-STACK",
    "        at TestContext.<anonymous> (file:///D:/runner/PRIVATE/test/model-performance.test.js:321:9)",
    "  ...",
    "1..18",
  ].join("\n");
  const diagnostic = parseTapFailureDiagnostic(output);
  assert.deepEqual(diagnostic, {
    fileIndex: 1,
    testOrdinal: 4,
    sourceLine: 321,
    failureType: "testCodeFailure",
    errorName: "AssertionError",
  });
  const formatted = formatQualificationFailureDiagnostic(diagnostic);
  assert.equal(
    formatted,
    "file_index=1 test_ordinal=4 source_line=321 failure_type=testCodeFailure error_name=AssertionError",
  );
  assert.doesNotMatch(formatted, /PRIVATE|secret|Users|TAP/u);

  const fileOnly = parseTapFailureDiagnostic([
    "not ok 14 - PRIVATE-FILE-FAILURE",
    "  ---",
    "  location: 'C:\\\\runner\\\\_work\\\\repo\\\\test\\\\windows-filesystem-security.test.js:8:2'",
    "  failureType: 'PRIVATE-FAILURE-TYPE'",
    "  name: 'PRIVATE-ERROR-NAME'",
    "  ...",
  ].join("\n"));
  assert.deepEqual(fileOnly, {
    fileIndex: 14,
    testOrdinal: 14,
    sourceLine: null,
    failureType: null,
    errorName: null,
  });

  const unknown = parseTapFailureDiagnostic([
    "not ok 1 - PRIVATE-FAILURE",
    "  ---",
    "  location: 'C:\\Users\\PRIVATE\\unapproved.test.js:1:2'",
    "  ...",
  ].join("\n"));
  assert.deepEqual(unknown, {
    fileIndex: null,
    testOrdinal: 1,
    sourceLine: null,
    failureType: null,
    errorName: null,
  });
  const node26 = parseTapFailureDiagnostic([
    "not ok 15 - PRIVATE-CADENCE",
    "  ---",
    "  location: 'D:\\\\runner\\\\test\\\\model-performance.test.js:310:1'",
    "  stack: |-",
    "    AssertionError: PRIVATE-DETAIL",
    "    waitForSavedSnapshot (file:///D:/runner/test/model-performance.test.js:164:3)",
    "  ...",
  ].join("\n"));
  assert.equal(node26.fileIndex, 1);
  assert.equal(node26.sourceLine, 164);
  assert.deepEqual(
    parseTapFailureDiagnostic("not ok 3 - PRIVATE-WITHOUT-LOCATION\n  ..."),
    {
      fileIndex: null,
      testOrdinal: 3,
      sourceLine: null,
      failureType: null,
      errorName: null,
    },
  );
  assert.deepEqual(
    parseTapFailureDiagnostic([
      "not ok 2 - PRIVATE-MISMATCHED-FRAME",
      "  ---",
      "  location: 'file:///D:/runner/test/model-performance.test.js:10:2'",
      "  stack: |-",
      "        at TestContext.<anonymous> (file:///D:/runner/test/windows-filesystem-security.test.js:91:4)",
      "  ...",
    ].join("\n")),
    {
      fileIndex: 1,
      testOrdinal: 2,
      sourceLine: null,
      failureType: null,
      errorName: null,
    },
  );
  assert.equal(
    formatQualificationFailureDiagnostic({
      fileIndex: 999_999,
      testOrdinal: 1_000_000,
      sourceLine: 1_000_000,
      failureType: "PRIVATE-FAILURE-TYPE",
      errorName: "PRIVATE-ERROR-NAME",
      title: canary,
    }),
    "file_index=unavailable test_ordinal=unavailable source_line=unavailable failure_type=unavailable error_name=unavailable",
  );
});
