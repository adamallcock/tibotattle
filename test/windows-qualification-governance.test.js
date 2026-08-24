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
  WINDOWS_PREPARED_DIRECTORY_ERROR_ALLOWLIST,
  WINDOWS_PREPARED_DIRECTORY_STAGE_ALLOWLIST,
  WINDOWS_SQLITE_ERROR_CATEGORY_ALLOWLIST,
  WINDOWS_SQLITE_PRIMARY_ERROR_CATEGORY_BY_CODE,
  WINDOWS_SQLITE_PUBLISH_ERROR_ALLOWLIST,
  WINDOWS_SECURITY_QUALIFICATION_TEST_FILES,
  WINDOWS_SQLITE_PUBLISH_STAGE_ALLOWLIST,
  WINDOWS_UNIFIED_INDEX_PHASE_ALLOWLIST,
  classifyWindowsSqliteError,
  classifyWindowsSqliteErrorCode,
  extractTapPublishErrors,
  extractTapPublishStages,
  extractTapNativeErrors,
  extractTapPreparedErrors,
  extractTapPreparedStages,
  extractTapSqliteErrorCategories,
  extractTapUnifiedIndexStages,
  extractTapTestIndex,
  extractTapTestIndexes,
  extractTapTestLocations,
  extractTapQualificationTestLocations,
  formatWindowsSecurityQualificationFailure,
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
  const sqliteQualificationTest = await readFile(
    resolve(REPOSITORY_ROOT, "test/windows-sqlite-state-session-native.test.js"),
    "utf8",
  );
  const unifiedIndexQualificationTest = await readFile(
    resolve(REPOSITORY_ROOT, "test/windows-local-unified-index-native.test.js"),
    "utf8",
  );
  const portableDiagnosticScript = await readFile(
    resolve(REPOSITORY_ROOT, "scripts/run-windows-portable-diagnostic.mjs"),
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
  assert.match(workflow, /run-windows-portable-diagnostic\.mjs/u);
  assert.match(workflow, /windows-security-qualification\.mjs/u);
  assert.match(
    qualificationScript,
    /export function formatWindowsSecurityQualificationFailure/u,
  );
  assert.match(
    qualificationScript,
    /console\.error\(formatWindowsSecurityQualificationFailure\(error\)\)/u,
  );
  assert.match(qualificationScript, /WINDOWS_SQLITE_ERROR_CATEGORY_ALLOWLIST/u);
  assert.match(qualificationScript, /classifyWindowsSqliteErrorCode/u);
  assert.match(qualificationScript, /extractTapSqliteErrorCategories/u);
  assert.match(qualificationScript, /sqlite_error_categories=/u);
  assert.match(qualificationScript, /WINDOWS_UNIFIED_INDEX_PHASE_ALLOWLIST/u);
  assert.match(qualificationScript, /extractTapUnifiedIndexStages/u);
  assert.match(qualificationScript, /unified_index_stages=/u);
  assert.match(sqliteQualificationTest, /classifyWindowsSqliteError/u);
  assert.match(sqliteQualificationTest, /windowsSqliteErrorCategory/u);
  assert.match(unifiedIndexQualificationTest, /emitBoundedIngestFailureDiagnostic/u);
  assert.match(unifiedIndexQualificationTest, /windowsFilesystemStage/u);
  assert.match(unifiedIndexQualificationTest, /windowsFilesystemError/u);
  assert.match(unifiedIndexQualificationTest, /windowsUnifiedIndexStage/u);
  assert.match(unifiedIndexQualificationTest, /unifiedIndexStage/u);
  assert.match(sqliteQualificationTest, /USAGE_MONITOR_WINDOWS_QUALIFICATION/u);
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
  const diagnosticStep = workflow.slice(
    workflow.indexOf("- name: Run bounded Windows filesystem security diagnostic"),
    workflow.indexOf("- name: Run bounded per-file Windows portable diagnostic"),
  );
  assert.match(
    diagnosticStep,
    /node --input-type=module -e/u,
  );
  assert.match(diagnosticStep, /runNodeTests/u);
  assert.match(diagnosticStep, /test\/windows-filesystem-security\.test\.js/u);
  assert.match(diagnosticStep, /timeoutMs: 120_000/u);
  assert.match(diagnosticStep, /FIXED_STATUS/u);
  assert.match(diagnosticStep, /WINDOWS_FILESYSTEM_SECURITY_DIAGNOSTIC_PASSED/u);
  assert.match(diagnosticStep, /error\?\.code/u);
  assert.match(diagnosticStep, /Object\.values\(FIXED_STATUS\)\.includes\(error\.code\)/u);
  assert.match(diagnosticStep, /test_index=\$\{testIndex\}/u);
  assert.match(diagnosticStep, /test_indexes=\$\{testIndexes\.length/u);
  assert.match(diagnosticStep, /test_locations=\$\{testLocations\.length/u);
  assert.match(diagnosticStep, /WINDOWS_SQLITE_PUBLISH_STAGE_ALLOWLIST/u);
  assert.match(diagnosticStep, /WINDOWS_SQLITE_PUBLISH_ERROR_ALLOWLIST/u);
  assert.match(diagnosticStep, /WINDOWS_PREPARED_DIRECTORY_STAGE_ALLOWLIST/u);
  assert.match(diagnosticStep, /WINDOWS_PREPARED_DIRECTORY_ERROR_ALLOWLIST/u);
  assert.match(diagnosticStep, /publishStages\.length <= 64/u);
  assert.match(
    diagnosticStep,
    /publishStages\.every\(\(value\) => WINDOWS_SQLITE_PUBLISH_STAGE_ALLOWLIST\.includes\(value\)\)/u,
  );
  assert.match(diagnosticStep, /publish_stages=\$\{publishStages\.length/u);
  assert.match(diagnosticStep, /publishStages\.join\(","\)/u);
  assert.match(diagnosticStep, /publishErrors\.length <= 64/u);
  assert.match(
    diagnosticStep,
    /publishErrors\.every\(\(value\) => WINDOWS_SQLITE_PUBLISH_ERROR_ALLOWLIST\.includes\(value\)\)/u,
  );
  assert.match(diagnosticStep, /publish_errors=\$\{publishErrors\.length/u);
  assert.match(diagnosticStep, /publishErrors\.join\(","\)/u);
  assert.match(diagnosticStep, /preparedStages\.length <= 64/u);
  assert.match(
    diagnosticStep,
    /preparedStages\.every\(\(value\) => WINDOWS_PREPARED_DIRECTORY_STAGE_ALLOWLIST\.includes\(value\)\)/u,
  );
  assert.match(diagnosticStep, /prepared_stages=\$\{preparedStages\.length/u);
  assert.match(diagnosticStep, /preparedStages\.join\(","\)/u);
  assert.match(diagnosticStep, /preparedErrors\.length <= 64/u);
  assert.match(
    diagnosticStep,
    /preparedErrors\.every\(\(value\) => WINDOWS_PREPARED_DIRECTORY_ERROR_ALLOWLIST\.includes\(value\)\)/u,
  );
  assert.match(diagnosticStep, /prepared_errors=\$\{preparedErrors\.length/u);
  assert.match(diagnosticStep, /preparedErrors\.join\(","\)/u);
  assert.match(diagnosticStep, /Array\.isArray\(error\?\.testIndexes\)/u);
  assert.match(diagnosticStep, /Array\.isArray\(error\?\.testLocations\)/u);
  assert.match(diagnosticStep, /testIndexes\.length <= 64/u);
  assert.match(diagnosticStep, /testLocations\.length <= 64/u);
  assert.match(diagnosticStep, /testIndexes\.join\(","\)/u);
  assert.match(diagnosticStep, /testLocations\.map/u);
  assert.match(diagnosticStep, /"unavailable"/u);
  assert.match(diagnosticStep, /console\.error\(`\$\{status\} test_index=\$\{testIndex\} test_indexes=/u);
  assert.match(diagnosticStep, /process\.exitCode = 1/u);
  assert.doesNotMatch(diagnosticStep, /continue-on-error/u);
  assert.doesNotMatch(diagnosticStep, /Start-Process|taskkill|Get-Content|\/PID|process\.pid|error\.message|stdout|stderr/u);
  assert.ok(diagnosticStep.length > 0, "the bounded diagnostic must precede the official lane");
  const portableDiagnosticStep = workflow.slice(
    workflow.indexOf("- name: Run bounded per-file Windows portable diagnostic"),
    workflow.indexOf("- name: Run portable Windows qualification"),
  );
  assert.match(
    portableDiagnosticStep,
    /node \.\/scripts\/run-windows-portable-diagnostic\.mjs/u,
  );
  assert.match(portableDiagnosticStep, /if \(\$LASTEXITCODE -ne 0\)/u);
  assert.doesNotMatch(
    portableDiagnosticStep,
    /Start-Process|taskkill|portableTimeout|USAGE_MONITOR_TEST_LANE_REPORTER=tap/u,
  );
  assert.ok(portableDiagnosticStep.length > 0);
  const portableStep = workflow.slice(
    workflow.indexOf("- name: Run portable Windows qualification"),
    workflow.indexOf("- name: Prepare disposable qualification state root"),
  );
  assert.match(portableStep, /pnpm test:portable/u);
  assert.match(portableStep, /pnpm test:portable \*> \$portableLog/u);
  assert.match(portableStep, /if \(\$LASTEXITCODE -ne 0\)/u);
  assert.match(portableStep, /Get-Content -LiteralPath \$portableLog -Tail 240/u);
  assert.doesNotMatch(portableStep, /Start-Process|taskkill|portableTimeout|USAGE_MONITOR_TEST_LANE_REPORTER=tap/u);
  assert.ok(
    workflow.indexOf("Run bounded per-file Windows portable diagnostic")
      < workflow.indexOf("Run portable Windows qualification")
      && workflow.indexOf("Run portable Windows qualification")
      < workflow.indexOf("Prepare disposable qualification state root"),
    "the diagnostic and authoritative portable lanes must precede disposable qualification state",
  );
  assert.match(portableDiagnosticScript, /WINDOWS_PORTABLE_TEST_FILES/u);
  assert.match(portableDiagnosticScript, /WINDOWS_PORTABLE_TEST_TIMEOUT_MS = 60_000/u);
  assert.match(portableDiagnosticScript, /WINDOWS_PORTABLE_SUITE_TIMEOUT_MS = 5 \* 60 \* 1_000/u);
  assert.match(portableDiagnosticScript, /--test-concurrency=1/u);
  assert.match(portableDiagnosticScript, /stdio: \["ignore", "pipe", "ignore"\]/u);
  assert.match(portableDiagnosticScript, /taskkill\.exe/u);
  assert.match(portableDiagnosticScript, /"\/pid"/u);
  assert.match(portableDiagnosticScript, /"\/t"/u);
  assert.match(portableDiagnosticScript, /"\/f"/u);
  assert.match(portableDiagnosticScript, /WINDOWS_PORTABLE_DIAGNOSTIC_TEST_TIMED_OUT/u);
  assert.match(portableDiagnosticScript, /WINDOWS_PORTABLE_DIAGNOSTIC_SUITE_TIMED_OUT/u);
  assert.match(portableDiagnosticScript, /WINDOWS_PORTABLE_MAXIMUM_FAILURE_METADATA_ITEMS = 64/u);
  assert.match(portableDiagnosticScript, /WINDOWS_PORTABLE_MAXIMUM_PROGRESS_UNITS = 1_024/u);
  assert.match(portableDiagnosticScript, /observeProgressUnits/u);
  assert.match(portableDiagnosticScript, /failureUnitOrdinals/u);
  assert.match(portableDiagnosticScript, /stdout\.on\("data", onStdoutData\)/u);
  assert.match(portableDiagnosticScript, /stdout\.once\("error", onStdoutError\)/u);
  assert.match(portableDiagnosticScript, /stdout\.removeListener\("data", onStdoutData\)/u);
  assert.match(portableDiagnosticScript, /stdout\.removeListener\("error", onStdoutError\)/u);
  assert.match(portableDiagnosticScript, /progress_units=\$\{progress\}/u);
  assert.match(portableDiagnosticScript, /ORDINARY_TEST_FAILURE/u);
  assert.match(portableDiagnosticScript, /error\?\.\[ORDINARY_TEST_FAILURE\] !== true/u);
  assert.match(portableDiagnosticScript, /safeFailureLocation\(error\)/u);
  assert.match(portableDiagnosticScript, /WINDOWS_PORTABLE_TEST_FILES\[error\.ordinal - 1\] !== error\.file/u);
  assert.match(portableDiagnosticScript, /failure_count=\$\{aggregate\.failureCount\}/u);
  assert.match(portableDiagnosticScript, /file=\$\{failure\.file\}/u);
  assert.match(portableDiagnosticScript, /ordinal=\$\{failure\.ordinal\}/u);
  assert.match(portableDiagnosticScript, /elapsed_ms=\$\{safeFailureElapsed\(error\)\}/u);
  assert.doesNotMatch(
    portableDiagnosticScript,
    /error\.message|child\.stderr|child\.stdout\.(?:pipe|resume)|process\.(?:stdout|stderr)|Buffer\.concat|chunk\.toString/u,
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
  const rawReceiptPreparationStep = workflow.indexOf(
    "- name: Prepare exact raw Windows x64 qualification receipt handoff",
  );
  const rawReceiptUploadStep = workflow.indexOf(
    "- name: Retain raw Windows x64 qualification receipt handoff",
  );
  const rawReceiptValidationStep = workflow.indexOf(
    "- name: Validate raw Windows x64 qualification receipt handoff",
  );
  const blockedUploadStep = workflow.indexOf(
    "- name: Retain blocked unsigned Windows x64 development artifact",
  );
  const cleanupStep = workflow.indexOf(
    "- name: Remove generated Electron artifact tree before clean checkout gate",
  );
  const cleanCheckoutStep = workflow.indexOf(
    "- name: Confirm qualification and artifact work did not modify the checkout",
  );
  const failClosedStep = workflow.indexOf(
    "- name: Fail closed after retaining blocked development artifact",
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
      && uploadStep < rawReceiptPreparationStep
      && rawReceiptPreparationStep < rawReceiptUploadStep
      && rawReceiptUploadStep < rawReceiptValidationStep
      && rawReceiptValidationStep < blockedUploadStep
      && uploadStep < blockedUploadStep
      && blockedUploadStep < cleanupStep
      && verificationStep < cleanupStep
      && cleanupStep < cleanCheckoutStep,
    "Electron verification, runtime smoke, receipt, upload, cleanup, and final clean-checkout gate must remain ordered",
  );
  assert.match(workflow, /WINDOWS_ELECTRON_REVISION_MISMATCH/u);
  assert.match(workflow, /WINDOWS_QUALIFICATION_REVISION_MISMATCH/u);
  assert.ok(cleanCheckoutStep < failClosedStep);
  const nativeQualificationStep = workflow.slice(qualificationStep, revisionGate);
  assert.match(nativeQualificationStep, /id: native_security_qualification/u);
  assert.match(nativeQualificationStep, /continue-on-error: true/u);
  assert.match(nativeQualificationStep, /TIBOTATTLE_WINDOWS_SECURITY_QUALIFICATION_STATUS=failed/u);
  assert.match(nativeQualificationStep, /WINDOWS_SECURITY_QUALIFICATION_FAILED_DEVELOPMENT_CONTINUES/u);
  assert.match(nativeQualificationStep, /Production promotion: blocked/u);
  assert.match(workflow, /\.release-build\/electron-dev\/windows-x64\/app/u);
  assert.match(workflow, /\.release-build\/electron-dev\/windows-x64\/artifacts/u);
  assert.match(workflow, /native\/windows-filesystem\/build\/Release\/windows_filesystem\.node/u);
  assert.match(workflow, /native\/windows-filesystem\/build\/Release\/windows_filesystem\.node\.manifest\.json/u);
  assert.match(workflow, /--target win32/u);
  assert.match(workflow, /--profile development/u);
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
  assert.match(workflow, /parseFixedStatusOutput/u);
  assert.match(workflow, /TIBOTATTLE_ELECTRON_VERIFICATION_FAILURE_EVIDENCE_PATH/u);
  assert.match(workflow, /Executable retention: none; only the allowlisted status marker may be retained/u);
  assert.match(workflow, /ELECTRON_DEVELOPMENT_ARTIFACT_VERIFIED/u);
  assert.match(workflow, /id: electron_artifact_verification/u);
  assert.match(workflow, /ELECTRON_ARTIFACT_EVIDENCE_NOT_CONTENT_FREE/u);
  assert.match(workflow, /SHA-256:/u);
  assert.match(workflow, /Runtime qualification: deferred to the native Windows Electron smoke step/u);
  assert.match(workflow, /smoke-electron-windows\.mjs/u);
  assert.match(workflow, /id: electron_runtime_smoke/u);
  assert.match(workflow, /tibotattle-windows-electron-runtime-smoke\.stdout\.raw/u);
  assert.match(workflow, /tibotattle-windows-electron-runtime-smoke\.stderr\.raw/u);
  assert.match(workflow, /Remove-VerifiedRuntimeTransientOutput/u);
  assert.match(workflow, /WINDOWS_ELECTRON_RUNTIME_TRANSIENT_OUTPUT_DELETE_FAILED/u);
  assert.match(workflow, /foreach \(\$path in @\(\$runtimeStdoutPath, \$runtimeStderrPath, \$runtimeAggregatePath, \$runtimeDiagnosticPath\)\)/u);
  assert.match(workflow, /Test-Path -LiteralPath \$path -ErrorAction Stop/u);
  const electronVerifierBodyForDeletion = workflow.slice(verificationStep, runtimeStep);
  assert.match(electronVerifierBodyForDeletion, /function Fail-ClosedVerifierArtifact/u);
  assert.match(
    electronVerifierBodyForDeletion,
    /Remove-Item -LiteralPath \$verificationLog -Force -ErrorAction Stop/u,
  );
  assert.match(
    electronVerifierBodyForDeletion,
    /Test-Path -LiteralPath \$verificationLog -ErrorAction Stop/u,
  );
  assert.match(electronVerifierBodyForDeletion, /WINDOWS_ELECTRON_VERIFICATION_LOG_DELETE_FAILED/u);
  assert.match(electronVerifierBodyForDeletion, /Fail-ClosedVerifierArtifact/u);
  assert.match(electronVerifierBodyForDeletion, /ELECTRON_DEVELOPMENT_ARTIFACT_FAILED/u);
  assert.match(electronVerifierBodyForDeletion, /WINDOWS_ELECTRON_ARTIFACT_EVIDENCE_INVALID/u);
  assert.match(electronVerifierBodyForDeletion, /WINDOWS_ELECTRON_ARTIFACT_EVIDENCE_NOT_CONTENT_FREE/u);
  assert.match(electronVerifierBodyForDeletion, /WINDOWS_ELECTRON_ARTIFACT_INVENTORY_INVALID/u);
  assert.match(workflow, /runtime aggregate shape/u);
  assert.match(workflow, /runtime aggregate status/u);
  assert.match(workflow, /shutdownCheckpoint/u);
  assert.match(workflow, /runtimeShutdownCheckpoints/u);
  assert.match(workflow, /shutdownCheckpoint = 'not_started'/u);
  assert.match(workflow, /'shutdownCheckpoint'/u);
  assert.match(workflow, /'descendants_gone'/u);
  assert.match(
    workflow,
    /runtimeEvidence\.shutdownCheckpoint -isnot \[string\][\s\S]+?runtimeShutdownCheckpoints -notcontains \$runtimeEvidence\.shutdownCheckpoint/u,
    "runtime aggregate shutdown checkpoint must be a fixed enum",
  );
  assert.match(
    workflow,
    /runtimeEvidence\.shutdownCheckpoint -ne 'descendants_gone'/u,
    "passed runtime aggregate must prove descendants are gone",
  );
  assert.match(workflow, /runtimeFailureStages/u);
  assert.match(workflow, /runtimeFailureReasons/u);
  assert.match(workflow, /runtimeFallbackReasons/u);
  assert.match(workflow, /runtimeDiagnosticSchema/u);
  assert.match(workflow, /runtimeDiagnosticPhases/u);
  assert.match(workflow, /runtimeDiagnosticStatuses/u);
  assert.match(workflow, /runtimeDiagnosticExitClasses/u);
  assert.match(workflow, /TIBOTATTLE_ELECTRON_RUNTIME_SMOKE_DIAGNOSTIC_PATH = \$runtimeDiagnosticPath/u);
  assert.match(workflow, /runtime diagnostic shape/u);
  assert.match(workflow, /terminate_process_tree_started_unsealed/u);
  assert.match(workflow, /terminate_process_tree_finished_unsealed/u);
  assert.match(workflow, /post_terminate_cleanup_unsealed/u);
  assert.match(workflow, /cleanup_finished_unsealed/u);
  assert.match(workflow, /runtime diagnostic phase status/u);
  assert.match(workflow, /runtimeDiagnosticDecision\.status -ne 'sealed'/u);
  assert.match(workflow, /runtime diagnostic does not match aggregate status/u);
  assert.match(workflow, /runtime aggregate diagnostics/u);
  assert.match(workflow, /failureStage = 'control'/u);
  assert.match(workflow, /failureReason = 'output_read_failed'/u);
  for (const reason of [
    "aggregate_missing",
    "aggregate_invalid",
    "stderr_present",
    "output_read_failed",
    "entry_not_reached",
    "entry_unsealed",
    "run_smoke_unsealed",
    "terminate_process_tree_started_unsealed",
    "terminate_process_tree_finished_unsealed",
    "cleanup_unsealed",
    "post_terminate_cleanup_unsealed",
    "cleanup_finished_unsealed",
    "caught_failure_output_missing",
    "completed_output_missing",
    "diagnostic_invalid",
  ]) {
    assert.match(workflow, new RegExp(`'${reason}'`, "u"));
  }
  assert.match(workflow, /failureStage -ne 'none'/u);
  assert.match(workflow, /failureReason -ne 'none'/u);
  assert.match(workflow, /runtime aggregate check/u);
  assert.match(workflow, /No raw smoke output,?/u);
  assert.match(workflow, /TIBOTATTLE_ELECTRON_RUNTIME_SMOKE_EVIDENCE_PATH=\$runtimeEvidencePath/u);
  const runtimeStepBody = workflow.slice(runtimeStep, receiptStep);
  const normalizedRuntimeSummary = runtimeStepBody.slice(
    runtimeStepBody.indexOf("function Write-NormalizedRuntimeSummary"),
    runtimeStepBody.indexOf("[IO.File]::WriteAllText"),
  );
  assert.match(normalizedRuntimeSummary, /- Status: \$\(\$Evidence\.status\)/u);
  assert.match(normalizedRuntimeSummary, /- Failure stage: \$\(\$Evidence\.failureStage\)/u);
  assert.match(normalizedRuntimeSummary, /- Failure reason: \$\(\$Evidence\.failureReason\)/u);
  assert.match(
    normalizedRuntimeSummary,
    /- Dashboard checkpoint: \$\(\$Evidence\.dashboardCheckpoint\)/u,
  );
  const summaryWithoutCheckpoint = normalizedRuntimeSummary.replace(
    /\s*"- Dashboard checkpoint: \$\(\$Evidence\.dashboardCheckpoint\)" >> \$env:GITHUB_STEP_SUMMARY/u,
    "",
  );
  assert.doesNotMatch(summaryWithoutCheckpoint, /Target|Dashboard|path|command|process|stdout|stderr/iu);
  assert.match(
    runtimeStepBody,
    /Write-NormalizedRuntimeSummary -Evidence \$defaultRuntimeEvidence\s+Remove-VerifiedRuntimeTransientOutput/u,
  );
  assert.match(
    runtimeStepBody,
    /Write-NormalizedRuntimeSummary -Evidence \$runtimeEvidence\s+Remove-VerifiedRuntimeTransientOutput/u,
  );
  assert.match(
    runtimeStepBody,
    /node \.\/scripts\/smoke-electron-windows\.mjs 1> \$runtimeStdoutPath 2> \$runtimeStderrPath/u,
    "runtime console stdout and stderr must be captured separately",
  );
  assert.match(
    runtimeStepBody,
    /try \{\s+node \.\/scripts\/smoke-electron-windows\.mjs[\s\S]+?\} catch \{[\s\S]+?\$runtimeExitCode = 1/u,
    "runtime launch failures must continue into the closed classifier",
  );
  assert.match(
    runtimeStepBody,
    /TIBOTATTLE_ELECTRON_RUNTIME_SMOKE_OUTPUT_PATH = \$runtimeAggregatePath/u,
    "runtime aggregate must use an explicit file protocol",
  );
  const runtimeInvocation = runtimeStepBody.indexOf(
    "node ./scripts/smoke-electron-windows.mjs 1> $runtimeStdoutPath 2> $runtimeStderrPath",
  );
  const preflightCleanup = runtimeStepBody.lastIndexOf(
    "Remove-VerifiedRuntimeTransientOutput",
    runtimeInvocation,
  );
  assert.ok(
    preflightCleanup >= 0 && preflightCleanup < runtimeInvocation,
    "runtime transient outputs must be cleared before each smoke invocation",
  );
  assert.doesNotMatch(
    runtimeStepBody,
    /\*> \$runtime(?:Stdout|Stderr|Raw)Path/u,
    "runtime output must not be merged before parsing",
  );
  const aggregateParse = runtimeStepBody.indexOf(
    "$runtimeEvidence = $runtimeAggregate | ConvertFrom-Json",
  );
  const stderrGate = runtimeStepBody.indexOf("$stderrPresent = $false");
  assert.ok(aggregateParse >= 0 && stderrGate > aggregateParse, "aggregate must be parsed before stderr classification");
  const aggregateEmptyGate = runtimeStepBody.indexOf("[string]::IsNullOrEmpty($runtimeAggregate)");
  assert.ok(aggregateEmptyGate >= 0 && aggregateEmptyGate < aggregateParse, "empty aggregate must be classified before JSON parsing");
  assert.match(
    runtimeStepBody,
    /if \(\$stderrPresent -and \$runtimeEvidence\.status -eq 'passed'\)[\s\S]+?throw 'runtime stderr is present for passed output'/u,
    "stderr must reject passed output but preserve a valid failed aggregate",
  );
  assert.doesNotMatch(
    runtimeStepBody,
    /Get-Content -LiteralPath \$runtimeStderrPath/u,
    "stderr must never be parsed or retained",
  );
  const normalizedRuntimeEvidence = runtimeStepBody.indexOf(
    "$runtimeEvidence = $safeRuntimeEvidence | ConvertTo-Json -Compress | ConvertFrom-Json",
  );
  const cleanupAfterValidEvidence = runtimeStepBody.indexOf(
    "Remove-VerifiedRuntimeTransientOutput",
    normalizedRuntimeEvidence,
  );
  assert.ok(
    normalizedRuntimeEvidence >= 0 && cleanupAfterValidEvidence > normalizedRuntimeEvidence,
    "valid failed aggregates must be normalized before transient cleanup",
  );
  assert.ok(
    runtimeStepBody.indexOf("Write-NormalizedRuntimeSummary -Evidence $runtimeEvidence")
      < runtimeStepBody.indexOf("Write-Error 'WINDOWS_ELECTRON_RUNTIME_SMOKE_FAILED'"),
    "normalized runtime status must be summarized before runtime failure exits",
  );
  assert.match(
    runtimeStepBody,
    /Remove Windows Electron runtime transient output\n\s+if: \$\{\{ always\(\) \}\}[\s\S]+?runtime-smoke\.diagnostic\.json[\s\S]+?WINDOWS_ELECTRON_RUNTIME_TRANSIENT_OUTPUT_DELETE_FAILED/u,
    "an always step must remove every runtime transient after abnormal step exits",
  );
  assert.match(workflow, /WINDOWS_ELECTRON_VERIFICATION_LOG_DELETE_FAILED/u);
  assert.match(workflow, /Test-Path -LiteralPath \$verificationLog -ErrorAction Stop/u);
  assert.match(workflow, /WINDOWS_ELECTRON_RUNTIME_SMOKE_EVIDENCE_NOT_CONTENT_FREE/u);
  assert.match(workflow, /build-windows-electron-qualification-receipt\.mjs/u);
  assert.match(workflow, /TIBOTATTLE_ELECTRON_QUALIFICATION_RECEIPT_PATH/u);
  assert.match(workflow, /WINDOWS_ELECTRON_DEVELOPMENT_QUALIFICATION_PASSED/u);
  assert.match(
    workflow,
    /Create content-free Windows Electron qualification receipt\n\s+if: \$\{\{ success\(\) && steps\.native_security_qualification\.outcome == 'success' \}\}/u,
  );
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u);
  assert.match(
    workflow,
    /tibotattle-windows-x64-electron-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ github\.sha \}\}-\$\{\{ matrix\.cache-mode \}\}/u,
  );
  assert.match(
    workflow,
    /tibotattle-windows-electron-qualification-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ github\.sha \}\}-\$\{\{ matrix\.cache-mode \}\}\.json/u,
  );
  assert.match(workflow, /TIBOTATTLE_WINDOWS_QUALIFICATION_RECEIPT_BASENAME/u);
  assert.match(workflow, /GITHUB_RUN_ID/u);
  assert.match(workflow, /GITHUB_RUN_ATTEMPT/u);
  const currentBundleUpload = workflow.slice(uploadStep, rawReceiptPreparationStep);
  assert.match(currentBundleUpload, /path: \|/u);
  assert.match(currentBundleUpload, /TIBOTATTLE_ELECTRON_ARTIFACT_APP_PATH/u);
  assert.match(currentBundleUpload, /TIBOTATTLE_ELECTRON_QUALIFICATION_RECEIPT_PATH/u);
  assert.match(currentBundleUpload, /retention-days: 3/u);
  assert.doesNotMatch(currentBundleUpload, /archive:\s*false/u);
  assert.match(currentBundleUpload, /github\.run_id/u);
  assert.match(currentBundleUpload, /github\.run_attempt/u);
  const rawReceiptPreparation = workflow.slice(
    rawReceiptPreparationStep,
    rawReceiptUploadStep,
  );
  assert.match(
    rawReceiptPreparation,
    /if: \$\{\{ success\(\) && steps\.native_security_qualification\.outcome == 'success' \}\}/u,
  );
  assert.match(rawReceiptPreparation, /Copy-Item -LiteralPath \$receiptPath -Destination \$receiptRawPath/u);
  assert.match(rawReceiptPreparation, /PathType Leaf/u);
  assert.match(rawReceiptPreparation, /TIBOTATTLE_WINDOWS_QUALIFICATION_RECEIPT_RAW_PATH=/u);
  assert.match(rawReceiptPreparation, /TIBOTATTLE_WINDOWS_QUALIFICATION_RECEIPT_RAW_BASENAME=/u);
  assert.doesNotMatch(rawReceiptPreparation, /Write-Host|Write-Output/u);
  const rawReceiptUpload = workflow.slice(rawReceiptUploadStep, rawReceiptValidationStep);
  assert.match(rawReceiptUpload, /id: windows_qualification_receipt_raw_upload/u);
  assert.match(rawReceiptUpload, /uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u);
  assert.match(
    rawReceiptUpload,
    /name: \$\{\{ env\.TIBOTATTLE_WINDOWS_QUALIFICATION_RECEIPT_BASENAME \}\}/u,
  );
  assert.match(rawReceiptUpload, /path: \$\{\{ env\.TIBOTATTLE_WINDOWS_QUALIFICATION_RECEIPT_RAW_PATH \}\}/u);
  assert.match(rawReceiptUpload, /archive: false/u);
  assert.match(rawReceiptUpload, /if-no-files-found: error/u);
  assert.match(rawReceiptUpload, /retention-days: 30/u);
  assert.doesNotMatch(rawReceiptUpload, /path:\s*\|/u);
  assert.doesNotMatch(rawReceiptUpload, /always\(\)|!cancelled\(\)/u);
  const rawReceiptValidation = workflow.slice(
    rawReceiptValidationStep,
    blockedUploadStep,
  );
  assert.match(
    rawReceiptValidation,
    /if: \$\{\{ success\(\) && steps\.native_security_qualification\.outcome == 'success' \}\}/u,
  );
  assert.match(
    rawReceiptValidation,
    /steps\.windows_qualification_receipt_raw_upload\.outputs\['artifact-id'\]/u,
  );
  assert.match(
    rawReceiptValidation,
    /steps\.windows_qualification_receipt_raw_upload\.outputs\['artifact-digest'\]/u,
  );
  assert.match(rawReceiptValidation, /artifactId -cnotmatch '\^\[1-9\]\[0-9\]\*\$'/u);
  assert.match(rawReceiptValidation, /artifactDigest -cnotmatch '\^\[0-9a-f\]\{64\}\$'/u);
  assert.match(rawReceiptValidation, /Get-FileHash -LiteralPath \$receiptRawPath -Algorithm SHA256/u);
  assert.match(rawReceiptValidation, /localDigest.*ToLowerInvariant\(\)/u);
  assert.match(rawReceiptValidation, /expectedDigest = \$localDigest/u);
  assert.match(rawReceiptValidation, /artifactDigest -cne \$expectedDigest/u);
  assert.match(rawReceiptValidation, /WINDOWS_QUALIFICATION_RECEIPT_ARTIFACT_OUTPUT_INVALID/u);
  assert.match(rawReceiptValidation, /WINDOWS_QUALIFICATION_RECEIPT_ARTIFACT_DIGEST_MISMATCH/u);
  assert.doesNotMatch(rawReceiptValidation, /Write-Host|Write-Output/u);
  const rawReceiptSummary = rawReceiptValidation.slice(
    rawReceiptValidation.indexOf("### Raw Windows qualification receipt handoff"),
  );
  assert.doesNotMatch(rawReceiptSummary, /\$artifact(?:Id|Digest)|\$receiptRawPath|runner_temp|secret|token|password/iu);
  for (const suffix of [
    "verification-blocked",
    "runtime-blocked",
    "blocked-development",
  ]) {
    assert.match(
      workflow,
      new RegExp(
        `tibotattle-windows-x64-electron-\\$\\{\\{ github\\.run_id \\}\\}-\\$\\{\\{ github\\.run_attempt \\}\\}-\\$\\{\\{ github\\.sha \\}\\}-\\$\\{\\{ matrix\\.cache-mode \\}\\}-${suffix}`,
        "u",
      ),
    );
  }
  assert.match(workflow, /Retain blocked unsigned Windows x64 development artifact/u);
  const verificationFailureUpload = workflow.slice(
    workflow.indexOf("- name: Retain safe Windows Electron verifier failure evidence"),
    workflow.indexOf("- name: Retain blocked unsigned Windows x64 development artifact"),
  );
  assert.match(verificationFailureUpload, /steps\.electron_artifact_verification\.outcome == 'failure'/u);
  assert.match(
    verificationFailureUpload,
    /path: \$\{\{ env\.TIBOTATTLE_ELECTRON_VERIFICATION_FAILURE_EVIDENCE_PATH \}\}/u,
  );
  assert.doesNotMatch(verificationFailureUpload, /TIBOTATTLE_ELECTRON_ARTIFACT_APP_PATH/u);
  assert.doesNotMatch(verificationFailureUpload, /tibotattle-electron-verification\.json/u);
  const runtimeFailureUpload = workflow.slice(
    workflow.indexOf("- name: Retain safe Windows Electron runtime failure evidence"),
    workflow.indexOf("- name: Retain blocked unsigned Windows x64 development artifact"),
  );
  assert.match(runtimeFailureUpload, /steps\.electron_runtime_smoke\.outcome == 'failure'/u);
  assert.match(
    runtimeFailureUpload,
    /path: \$\{\{ env\.TIBOTATTLE_ELECTRON_RUNTIME_SMOKE_EVIDENCE_PATH \}\}/u,
  );
  assert.doesNotMatch(runtimeFailureUpload, /native_security_qualification/u);
  assert.doesNotMatch(runtimeFailureUpload, /tibotattle-windows-electron-runtime-smoke\.raw/u);
  assert.doesNotMatch(runtimeFailureUpload, /TIBOTATTLE_ELECTRON_ARTIFACT_APP_PATH/u);
  assert.match(
    workflow,
    /always\(\) && !cancelled\(\) && steps\.electron_artifact_verification\.outcome == 'success' && \(steps\.native_security_qualification\.outcome == 'failure' \|\| steps\.electron_runtime_smoke\.outcome == 'failure'\)/u,
  );
  const retainsBlockedDevelopmentArtifact = ({ artifact, native, runtime }) =>
    artifact === "success" && (native === "failure" || runtime === "failure");
  assert.equal(
    retainsBlockedDevelopmentArtifact({ artifact: "success", native: "failure", runtime: "failure" }),
    true,
    "both native and runtime failures must retain the verified development artifact",
  );
  assert.equal(
    retainsBlockedDevelopmentArtifact({ artifact: "success", native: "failure", runtime: "success" }),
    true,
  );
  assert.equal(
    retainsBlockedDevelopmentArtifact({ artifact: "success", native: "success", runtime: "failure" }),
    true,
  );
  assert.equal(
    retainsBlockedDevelopmentArtifact({ artifact: "success", native: "success", runtime: "success" }),
    false,
  );
  assert.equal(
    retainsBlockedDevelopmentArtifact({ artifact: "failure", native: "failure", runtime: "failure" }),
    false,
  );
  assert.doesNotMatch(
    workflow,
    /steps\.native_security_qualification\.outcome == 'failure' && steps\.electron_runtime_smoke\.outcome == 'success'\).*steps\.native_security_qualification\.outcome == 'success' && steps\.electron_runtime_smoke\.outcome == 'failure'/u,
  );
  const blockedUpload = workflow.slice(blockedUploadStep, cleanupStep);
  assert.match(blockedUpload, /TIBOTATTLE_ELECTRON_ARTIFACT_APP_PATH/u);
  assert.match(blockedUpload, /TIBOTATTLE_WINDOWS_SECURITY_QUALIFICATION_RESULT_PATH/u);
  assert.match(blockedUpload, /TIBOTATTLE_ELECTRON_VERIFICATION_EVIDENCE_PATH/u);
  assert.match(blockedUpload, /TIBOTATTLE_ELECTRON_RUNTIME_SMOKE_EVIDENCE_PATH/u);
  assert.match(workflow, /blocked-development/u);
  assert.match(workflow, /WINDOWS_SECURITY_QUALIFICATION_FAILED_ARTIFACT_RETAINED/u);
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
    "test/windows-fixed-state-storage.test.js",
    "test/windows-prepared-artifact-storage.test.js",
    "test/windows-review-pair-storage.test.js",
    "test/windows-contribution-sync-queue-storage.test.js",
    "test/windows-prepared-contribution.test.js",
    "test/windows-security-consumer-composition.test.js",
    "test/windows-sqlite-state-session-native.test.js",
    "test/windows-local-unified-index-native.test.js",
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

test("qualification failure indexing is top-level, numeric, and content-free", () => {
  const output = [
      "    not ok 4 - indented secret=should-not-escape",
      "not ok 7 - top-level secret=should-not-escape",
      "not ok 7 - duplicate secret=should-not-escape",
    ].join("\n");
  const indexes = extractTapTestIndexes(output);
  assert.deepEqual(indexes, [7]);
  assert.equal(Object.isFrozen(indexes), true);
  assert.equal(extractTapTestIndex(output), 7);
  assert.equal(extractTapTestIndex("not ok malformed - secret=should-not-escape"), null);
  assert.equal(extractTapTestIndex("not ok 0 - zero-is-not-an-ordinal"), null);
  assert.equal(extractTapTestIndex("not ok 9007199254740992 - unsafe"), null);
  assert.equal(extractTapTestIndex("not ok 8 -\r\n"), 8);
  assert.equal(extractTapTestIndex(null), null);
});

test("qualification CLI failure formatting is bounded, numeric, and content-free", () => {
  const failure = new Error("private failure message");
  failure.code = FIXED_STATUS.failed;
  failure.testIndex = 7;
  failure.testIndexes = Object.freeze([7, 12]);
  failure.testLocations = Object.freeze([
    Object.freeze([12, 5]),
    Object.freeze([20, 10]),
  ]);
  assert.equal(
    formatWindowsSecurityQualificationFailure(failure),
    "WINDOWS_SECURITY_QUALIFICATION_FAILED test_index=7 "
      + "test_indexes=7,12 test_locations=12:5;20:10 "
      + "test_file_locations=unavailable native_errors=unavailable",
  );

  const unsafe = new Error("secret message must not escape");
  unsafe.code = "PRIVATE_STATUS";
  unsafe.testIndex = Number.MAX_SAFE_INTEGER + 1;
  unsafe.testIndexes = Array.from({ length: 65 }, (_, index) => index + 1);
  unsafe.testLocations = [[1, 2], ["secret", 3]];
  const formattedUnsafe = formatWindowsSecurityQualificationFailure(unsafe);
  assert.equal(
    formattedUnsafe,
    "WINDOWS_SECURITY_QUALIFICATION_FAILED test_index=unavailable "
      + "test_indexes=unavailable test_locations=unavailable "
      + "test_file_locations=unavailable native_errors=unavailable",
  );
  assert.doesNotMatch(
    formattedUnsafe,
    /secret|private|message|windows-filesystem-security\.test\.js/iu,
  );

  const duplicate = new Error("duplicate metadata should not escape");
  duplicate.code = FIXED_STATUS.failed;
  duplicate.testIndex = 4;
  duplicate.testIndexes = [4, 4];
  duplicate.testLocations = [[8, 3], [8, 3]];
  assert.equal(
    formatWindowsSecurityQualificationFailure(duplicate),
    "WINDOWS_SECURITY_QUALIFICATION_FAILED test_index=4 "
      + "test_indexes=unavailable test_locations=unavailable "
      + "test_file_locations=unavailable native_errors=unavailable",
  );
});

test("qualification file locations use lexical numeric ordinals and never expose paths", () => {
  const locations = extractTapQualificationTestLocations([
    "at (file:///C:/repo/test/windows-credential-operation-audit.test.js:530:7) secret=hide",
    "at C:\\repo\\test\\windows-sqlite-state-session-native.test.js:301:11 name=hide",
    "at test/windows-credential-operation-audit.test.js:530:7 duplicate",
    "at test/not-qualified.test.js:1:1",
  ].join("\n"));
  const lexicalFiles = [...WINDOWS_SECURITY_QUALIFICATION_TEST_FILES].sort();
  assert.deepEqual(locations, [
    [lexicalFiles.indexOf("test/windows-credential-operation-audit.test.js") + 1, 530, 7],
    [lexicalFiles.indexOf("test/windows-sqlite-state-session-native.test.js") + 1, 301, 11],
  ]);
  assert.equal(Object.isFrozen(locations), true);
  assert.equal(Object.isFrozen(locations[0]), true);
  assert.doesNotMatch(JSON.stringify(locations), /credential|sqlite|secret|repo/iu);

  const failure = new Error("private");
  failure.code = FIXED_STATUS.failed;
  failure.testFileLocations = locations;
  assert.match(
    formatWindowsSecurityQualificationFailure(failure),
    /test_file_locations=\d+:530:7;\d+:301:11 native_errors=unavailable$/u,
  );
  failure.testFileLocations = [[lexicalFiles.length + 1, 1, 1]];
  assert.match(
    formatWindowsSecurityQualificationFailure(failure),
    /test_file_locations=unavailable native_errors=unavailable$/u,
  );
});

test("qualification native errors are fixed, allowlisted, and content-free", () => {
  const errors = extractTapNativeErrors([
    "#   code: 'WINDOWS_FILESYSTEM_ACCESS_DENIED'",
    "# code: WINDOWS_FILESYSTEM_OPERATION_FAILED",
    "# code: 'WINDOWS_FILESYSTEM_ACCESS_DENIED'",
    "# code: 'WINDOWS_FILESYSTEM_NOT_ALLOWLISTED'",
    "code: 'WINDOWS_FILESYSTEM_SECURITY_POLICY'",
    "# code: 'WINDOWS_FILESYSTEM_SECURITY_POLICY' secret=hide",
  ].join("\n"));
  assert.deepEqual(errors, [
    "WINDOWS_FILESYSTEM_ACCESS_DENIED",
    "WINDOWS_FILESYSTEM_OPERATION_FAILED",
  ]);
  assert.equal(Object.isFrozen(errors), true);
  assert.doesNotMatch(errors.join(" "), /secret|allowlisted|hide/iu);

  const failure = new Error("private");
  failure.code = FIXED_STATUS.failed;
  failure.nativeErrors = errors;
  assert.match(
    formatWindowsSecurityQualificationFailure(failure),
    /native_errors=WINDOWS_FILESYSTEM_ACCESS_DENIED,WINDOWS_FILESYSTEM_OPERATION_FAILED$/u,
  );
  failure.nativeErrors = ["WINDOWS_FILESYSTEM_ACCESS_DENIED", "private"];
  assert.match(
    formatWindowsSecurityQualificationFailure(failure),
    /native_errors=unavailable$/u,
  );
});

test("SQLite qualification error categories use every documented primary code and fixed TAP values", () => {
  const standardPrimaryCategories = new Map([
    [0, "SQLITE_OK"],
    [1, "SQLITE_ERROR"],
    [2, "SQLITE_INTERNAL"],
    [3, "SQLITE_PERM"],
    [4, "SQLITE_ABORT"],
    [5, "BUSY_LOCKED"],
    [6, "BUSY_LOCKED"],
    [7, "SQLITE_NOMEM"],
    [8, "READONLY"],
    [9, "SQLITE_INTERRUPT"],
    [10, "CANTOPEN_IOERR"],
    [11, "CORRUPT_NOTADB"],
    [12, "SQLITE_NOTFOUND"],
    [13, "SQLITE_FULL"],
    [14, "CANTOPEN_IOERR"],
    [15, "SQLITE_PROTOCOL"],
    [16, "SQLITE_EMPTY"],
    [17, "SQLITE_SCHEMA"],
    [18, "SQLITE_TOOBIG"],
    [19, "SQLITE_CONSTRAINT"],
    [20, "SQLITE_MISMATCH"],
    [21, "SQLITE_MISUSE"],
    [22, "SQLITE_NOLFS"],
    [23, "SQLITE_AUTH"],
    [24, "SQLITE_FORMAT"],
    [25, "SQLITE_RANGE"],
    [26, "CORRUPT_NOTADB"],
    [27, "SQLITE_NOTICE"],
    [28, "SQLITE_WARNING"],
    [100, "SQLITE_ROW"],
    [101, "SQLITE_DONE"],
  ]);
  assert.deepEqual(
    WINDOWS_SQLITE_PRIMARY_ERROR_CATEGORY_BY_CODE,
    Object.fromEntries(standardPrimaryCategories),
  );
  assert.equal(Object.isFrozen(WINDOWS_SQLITE_PRIMARY_ERROR_CATEGORY_BY_CODE), true);
  assert.deepEqual(WINDOWS_SQLITE_ERROR_CATEGORY_ALLOWLIST, [
    "SQLITE_OK",
    "SQLITE_ERROR",
    "SQLITE_INTERNAL",
    "SQLITE_PERM",
    "SQLITE_ABORT",
    "BUSY_LOCKED",
    "SQLITE_NOMEM",
    "READONLY",
    "SQLITE_INTERRUPT",
    "CANTOPEN_IOERR",
    "CORRUPT_NOTADB",
    "SQLITE_NOTFOUND",
    "SQLITE_FULL",
    "SQLITE_PROTOCOL",
    "SQLITE_EMPTY",
    "SQLITE_SCHEMA",
    "SQLITE_TOOBIG",
    "SQLITE_CONSTRAINT",
    "SQLITE_MISMATCH",
    "SQLITE_MISUSE",
    "SQLITE_NOLFS",
    "SQLITE_AUTH",
    "SQLITE_FORMAT",
    "SQLITE_RANGE",
    "SQLITE_NOTICE",
    "SQLITE_WARNING",
    "SQLITE_ROW",
    "SQLITE_DONE",
    "OTHER",
    "UNAVAILABLE",
  ]);
  assert.equal(Object.isFrozen(WINDOWS_SQLITE_ERROR_CATEGORY_ALLOWLIST), true);
  assert.equal(
    new Set(WINDOWS_SQLITE_ERROR_CATEGORY_ALLOWLIST).size,
    WINDOWS_SQLITE_ERROR_CATEGORY_ALLOWLIST.length,
  );

  for (const [primaryCode, expectedCategory] of standardPrimaryCategories) {
    assert.equal(classifyWindowsSqliteErrorCode(primaryCode), expectedCategory);
    assert.equal(
      classifyWindowsSqliteErrorCode(primaryCode + (0x12345 * 256)),
      expectedCategory,
      `extended SQLite code must retain only primary code ${primaryCode}`,
    );
    assert.notEqual(expectedCategory, "OTHER");
    assert.ok(WINDOWS_SQLITE_ERROR_CATEGORY_ALLOWLIST.includes(expectedCategory));
  }

  for (const unknownPrimaryCode of [29, 30, 42, 99, 102, 255]) {
    assert.equal(classifyWindowsSqliteErrorCode(unknownPrimaryCode), "OTHER");
    assert.equal(
      classifyWindowsSqliteErrorCode(unknownPrimaryCode + (0x12345 * 256)),
      "OTHER",
    );
  }
  for (const unavailableCode of [
    "14",
    -1,
    0x80000000,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1.5,
    14n,
    undefined,
    null,
  ]) {
    assert.equal(classifyWindowsSqliteErrorCode(unavailableCode), "UNAVAILABLE");
  }

  const numericOnlyError = {
    errcode: 14,
    code: "ERR_SQLITE_ERROR",
    errstr: "unable to open database file",
    message: "C:\\private\\secret\\state.sqlite SQL=CREATE TABLE hidden",
  };
  assert.equal(classifyWindowsSqliteError(numericOnlyError), "CANTOPEN_IOERR");
  assert.equal(
    classifyWindowsSqliteError(Object.create({ errcode: 14 })),
    "UNAVAILABLE",
  );
  assert.equal(
    classifyWindowsSqliteError({ errcode: "14", message: "secret" }),
    "UNAVAILABLE",
  );
  assert.equal(classifyWindowsSqliteError(null), "UNAVAILABLE");
  const throwingErrcode = {};
  Object.defineProperty(throwingErrcode, "errcode", {
    get() {
      throw new Error("C:\\private\\secret\\state.sqlite");
    },
  });
  assert.equal(classifyWindowsSqliteError(throwingErrcode), "UNAVAILABLE");

  const output = [
    "windowsSqliteErrorCategory: BUSY_LOCKED",
    "# windowsSqliteErrorCategory: BUSY_LOCKED",
    "# windowsSqliteErrorCategory: CANTOPEN_IOERR",
    "# windowsSqliteErrorCategory: 'READONLY'",
    "# windowsSqliteErrorCategory: READONLY path=C:\\private\\secret",
    "# windowsSqliteErrorCategory: CORRUPT_NOTADB secret=do-not-return",
    "# windowsSqliteErrorCategory: CORRUPT_NOTADB",
    "# windowsSqliteErrorCategory: SQLITE_SCHEMA",
    "# windowsSqliteErrorCategory: NOT_ALLOWLISTED",
    "# otherProperty: READONLY",
    "# windowsSqliteErrorCategory: UNAVAILABLE",
  ].join("\n");
  const categories = extractTapSqliteErrorCategories(output);
  assert.deepEqual(categories, [
    "BUSY_LOCKED",
    "CANTOPEN_IOERR",
    "CORRUPT_NOTADB",
    "SQLITE_SCHEMA",
    "UNAVAILABLE",
  ]);
  assert.equal(Object.isFrozen(categories), true);
  assert.doesNotMatch(categories.join(" "), /secret|private|path|NOT_ALLOWLISTED/iu);

  const failure = new Error("C:\\private\\secret\\state.sqlite SQL=SELECT hidden");
  failure.code = FIXED_STATUS.failed;
  failure.sqliteErrorCategories = categories;
  const formatted = formatWindowsSecurityQualificationFailure(failure);
  assert.match(
    formatted,
    /sqlite_error_categories=BUSY_LOCKED,CANTOPEN_IOERR,CORRUPT_NOTADB,SQLITE_SCHEMA,UNAVAILABLE$/u,
  );
  assert.doesNotMatch(formatted, /secret|private|state\.sqlite|SELECT|message/iu);

  failure.sqliteErrorCategories = ["BUSY_LOCKED", "secret=do-not-return"];
  const unsafeFormatted = formatWindowsSecurityQualificationFailure(failure);
  assert.doesNotMatch(unsafeFormatted, /sqlite_error_categories|secret|private|SELECT/iu);
});

test("prepared-directory diagnostics use the exact frozen stage allowlist", () => {
  assert.deepEqual(WINDOWS_PREPARED_DIRECTORY_STAGE_ALLOWLIST, [
    "prepared_root_open",
    "prepared_root_validation",
    "prepared_child_open",
    "prepared_child_create",
    "prepared_dacl_update",
    "prepared_child_validation",
    "prepared_ancestor_validation",
    "prepared_final_validation",
  ]);
  assert.equal(Object.isFrozen(WINDOWS_PREPARED_DIRECTORY_STAGE_ALLOWLIST), true);
  assert.equal(
    new Set(WINDOWS_PREPARED_DIRECTORY_STAGE_ALLOWLIST).size,
    WINDOWS_PREPARED_DIRECTORY_STAGE_ALLOWLIST.length,
  );
});

test("prepared-directory diagnostics use the exact frozen native-code allowlist", () => {
  assert.deepEqual(WINDOWS_PREPARED_DIRECTORY_ERROR_ALLOWLIST, [
    "WINDOWS_FILESYSTEM_INVALID_CONFIGURATION",
    "WINDOWS_FILESYSTEM_INVALID_PATH",
    "WINDOWS_FILESYSTEM_NOT_FOUND",
    "WINDOWS_FILESYSTEM_ALREADY_EXISTS",
    "WINDOWS_FILESYSTEM_ACCESS_DENIED",
    "WINDOWS_FILESYSTEM_REPARSE_POINT",
    "WINDOWS_FILESYSTEM_SECURITY_POLICY",
    "WINDOWS_FILESYSTEM_NOT_DIRECTORY",
    "WINDOWS_FILESYSTEM_IDENTITY_MISMATCH",
    "WINDOWS_FILESYSTEM_OPERATION_FAILED",
  ]);
  assert.equal(Object.isFrozen(WINDOWS_PREPARED_DIRECTORY_ERROR_ALLOWLIST), true);
  assert.equal(
    new Set(WINDOWS_PREPARED_DIRECTORY_ERROR_ALLOWLIST).size,
    WINDOWS_PREPARED_DIRECTORY_ERROR_ALLOWLIST.length,
  );
});

test("prepared-directory diagnostic parsers are TAP-only, fixed, deduplicated, bounded, and frozen", () => {
  const output = [
    "windowsFilesystemStage: prepared_child_create",
    "# windowsFilesystemStage: prepared_child_create",
    "# windowsFilesystemStage: 'prepared_final_validation'",
    "# windowsFilesystemStage: prepared_ancestor_validation",
    "# windowsFilesystemStage: prepared_unknown secret=do-not-return",
    "# windowsFilesystemStage: prepared_child_open secret=do-not-return",
    "# otherProperty: prepared_child_open",
    "# windowsFilesystemError: WINDOWS_FILESYSTEM_ACCESS_DENIED",
    "# windowsFilesystemError: 'WINDOWS_FILESYSTEM_OPERATION_FAILED'",
    "# windowsFilesystemError: WINDOWS_FILESYSTEM_ACCESS_DENIED",
    "# windowsFilesystemError: WINDOWS_FILESYSTEM_SQLITE_STATE_LEASE_SIDECAR_PRESENT",
    "# windowsFilesystemError: WINDOWS_FILESYSTEM_NOT_ALLOWLISTED",
    "# windowsFilesystemError: WINDOWS_FILESYSTEM_SECURITY_POLICY secret=do-not-return",
  ].join("\n");
  assert.deepEqual(extractTapPreparedStages(output), [
    "prepared_child_create",
    "prepared_final_validation",
    "prepared_ancestor_validation",
  ]);
  assert.deepEqual(extractTapPreparedErrors(output), [
    "WINDOWS_FILESYSTEM_ACCESS_DENIED",
    "WINDOWS_FILESYSTEM_OPERATION_FAILED",
  ]);
  assert.equal(Object.isFrozen(extractTapPreparedStages(output)), true);
  assert.equal(Object.isFrozen(extractTapPreparedErrors(output)), true);
  assert.doesNotMatch(
    JSON.stringify({ stages: extractTapPreparedStages(output), errors: extractTapPreparedErrors(output) }),
    /secret|unknown|allowlisted|otherProperty|sidecar/iu,
  );
  const repeatedStages = extractTapPreparedStages(
    Array.from(
      { length: 128 },
      (_, index) => `# windowsFilesystemStage: ${WINDOWS_PREPARED_DIRECTORY_STAGE_ALLOWLIST[index % 8]}`,
    ).join("\n"),
  );
  assert.deepEqual(repeatedStages, WINDOWS_PREPARED_DIRECTORY_STAGE_ALLOWLIST);
  assert.equal(repeatedStages.length <= 64, true);
  const repeatedErrors = extractTapPreparedErrors(
    Array.from(
      { length: 128 },
      (_, index) => `# windowsFilesystemError: ${WINDOWS_PREPARED_DIRECTORY_ERROR_ALLOWLIST[index % 10]}`,
    ).join("\n"),
  );
  assert.deepEqual(repeatedErrors, WINDOWS_PREPARED_DIRECTORY_ERROR_ALLOWLIST);
  assert.equal(repeatedErrors.length <= 64, true);
});

test("prepared-directory metadata remains fixed and content-free in qualification failures", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 4246;
  child.kill = () => true;
  const run = runNodeTests(["synthetic.test.js"], {
    cwd: REPOSITORY_ROOT,
    timeoutMs: 1_000,
    spawnProcess: () => child,
    terminateProcessTree: async () => true,
  });
  child.stdout.write([
    "TAP version 13",
    "not ok 11 - private prepared failure",
    "# windowsFilesystemStage: prepared_child_create",
    "# windowsFilesystemStage: prepared_final_validation",
    "# windowsFilesystemError: WINDOWS_FILESYSTEM_ACCESS_DENIED",
    "# windowsFilesystemError: WINDOWS_FILESYSTEM_OPERATION_FAILED",
    "# windowsFilesystemStage: prepared_private secret=hide",
  ].join("\n"));
  child.emit("close", 1);
  await assert.rejects(
    run,
    (error) => {
      assert.deepEqual(error.preparedStages, [
        "prepared_child_create",
        "prepared_final_validation",
      ]);
      assert.deepEqual(error.preparedErrors, [
        "WINDOWS_FILESYSTEM_ACCESS_DENIED",
        "WINDOWS_FILESYSTEM_OPERATION_FAILED",
      ]);
      assert.equal(error.preparedStage, "prepared_child_create");
      assert.equal(error.preparedError, "WINDOWS_FILESYSTEM_ACCESS_DENIED");
      assert.equal(Object.isFrozen(error.preparedStages), true);
      assert.equal(Object.isFrozen(error.preparedErrors), true);
      assert.match(
        formatWindowsSecurityQualificationFailure(error),
        /prepared_stages=prepared_child_create,prepared_final_validation prepared_errors=WINDOWS_FILESYSTEM_ACCESS_DENIED,WINDOWS_FILESYSTEM_OPERATION_FAILED$/u,
      );
      assert.doesNotMatch(
        formatWindowsSecurityQualificationFailure(error),
        /private|secret|hide/iu,
      );
      return true;
    },
  );
});

test("SQLite publish diagnostics use the exact frozen allowlist", () => {
  assert.deepEqual(WINDOWS_SQLITE_PUBLISH_STAGE_ALLOWLIST, [
    "publish_parse",
    "publish_stage_open",
    "publish_stage_preflight",
    "publish_target_open",
    "publish_target_preflight",
    "publish_stage_revalidate",
    "publish_target_revalidate",
    "publish_rename",
    "publish_stage_postvalidate",
    "publish_target_postopen",
    "publish_target_postvalidate",
  ]);
  assert.equal(WINDOWS_SQLITE_PUBLISH_STAGE_ALLOWLIST.length, 11);
  assert.equal(Object.isFrozen(WINDOWS_SQLITE_PUBLISH_STAGE_ALLOWLIST), true);
  assert.equal(
    new Set(WINDOWS_SQLITE_PUBLISH_STAGE_ALLOWLIST).size,
    WINDOWS_SQLITE_PUBLISH_STAGE_ALLOWLIST.length,
  );
});

test("SQLite publish error diagnostics use the exact frozen native-code allowlist", () => {
  assert.deepEqual(WINDOWS_SQLITE_PUBLISH_ERROR_ALLOWLIST, [
    "WINDOWS_FILESYSTEM_INVALID_CONFIGURATION",
    "WINDOWS_FILESYSTEM_INVALID_PATH",
    "WINDOWS_FILESYSTEM_NOT_FOUND",
    "WINDOWS_FILESYSTEM_ALREADY_EXISTS",
    "WINDOWS_FILESYSTEM_ACCESS_DENIED",
    "WINDOWS_FILESYSTEM_REPARSE_POINT",
    "WINDOWS_FILESYSTEM_HARD_LINK",
    "WINDOWS_FILESYSTEM_SECURITY_POLICY",
    "WINDOWS_FILESYSTEM_NOT_DIRECTORY",
    "WINDOWS_FILESYSTEM_NOT_REGULAR_FILE",
    "WINDOWS_FILESYSTEM_IDENTITY_MISMATCH",
    "WINDOWS_FILESYSTEM_OPERATION_FAILED",
    "WINDOWS_FILESYSTEM_SQLITE_STATE_LEASE_SIDECAR_PRESENT",
  ]);
  assert.equal(Object.isFrozen(WINDOWS_SQLITE_PUBLISH_ERROR_ALLOWLIST), true);
  assert.equal(
    new Set(WINDOWS_SQLITE_PUBLISH_ERROR_ALLOWLIST).size,
    WINDOWS_SQLITE_PUBLISH_ERROR_ALLOWLIST.length,
  );
});

test("SQLite publish diagnostic parser is TAP-only, allowlisted, deduplicated, bounded, and frozen", () => {
  const output = [
    "windowsFilesystemStage: publish_parse",
    "# windowsFilesystemStage: publish_stage_open",
    "# windowsFilesystemStage: 'publish_rename'",
    "# windowsFilesystemStage: publish_stage_open",
    "# windowsFilesystemStage: publish_target_postvalidate",
    "# windowsFilesystemStage: publish_not_allowlisted",
    "# windowsFilesystemStage: secret=do-not-return",
    "# otherProperty: publish_target_open",
    "# windowsFilesystemStage: publish_rename secret=do-not-return",
  ].join("\n");
  const stages = extractTapPublishStages(output);
  assert.deepEqual(stages, [
    "publish_stage_open",
    "publish_rename",
    "publish_target_postvalidate",
  ]);
  assert.equal(Object.isFrozen(stages), true);
  assert.equal(stages.length <= 64, true);
  assert.doesNotMatch(stages.join(" "), /secret|allowlisted|otherProperty/u);

  const repeated = extractTapPublishStages(
    Array.from(
      { length: 128 },
      (_, index) => `# windowsFilesystemStage: ${WINDOWS_SQLITE_PUBLISH_STAGE_ALLOWLIST[index % 11]}`,
    ).join("\n"),
  );
  assert.deepEqual(repeated, WINDOWS_SQLITE_PUBLISH_STAGE_ALLOWLIST);
  assert.equal(Object.isFrozen(repeated), true);
  assert.equal(repeated.length <= 64, true);
});

test("unified-index phase diagnostics are fixed, content-free, deduplicated, and frozen", () => {
  assert.deepEqual(WINDOWS_UNIFIED_INDEX_PHASE_ALLOWLIST, [
    "capability",
    "secret",
    "stage_prepare",
    "stage_create_or_clone",
    "session_open",
    "database_open_or_write",
    "close",
    "publish",
    "cleanup",
  ]);
  assert.equal(Object.isFrozen(WINDOWS_UNIFIED_INDEX_PHASE_ALLOWLIST), true);
  assert.equal(
    new Set(WINDOWS_UNIFIED_INDEX_PHASE_ALLOWLIST).size,
    WINDOWS_UNIFIED_INDEX_PHASE_ALLOWLIST.length,
  );
  const output = [
    "unifiedIndexStage: secret",
    "# unifiedIndexStage: capability",
    "# unifiedIndexStage: session_open",
    "# unifiedIndexStage: session_open",
    "# unifiedIndexStage: arbitrary secret",
    "# unifiedIndexStage: C:\\private\\secret\\state.sqlite",
    "# unifiedIndexStage: database_open_or_write SQL=hidden",
    "# otherProperty: cleanup",
  ].join("\n");
  const stages = extractTapUnifiedIndexStages(output);
  assert.deepEqual(stages, ["capability", "session_open"]);
  assert.equal(Object.isFrozen(stages), true);
  assert.doesNotMatch(stages.join(" "), /arbitrary|private|secret|SQL|hidden/u);
  const repeated = extractTapUnifiedIndexStages(
    Array.from(
      { length: 128 },
      (_, index) => `# unifiedIndexStage: ${WINDOWS_UNIFIED_INDEX_PHASE_ALLOWLIST[index % 9]}`,
    ).join("\n"),
  );
  assert.deepEqual(repeated, WINDOWS_UNIFIED_INDEX_PHASE_ALLOWLIST);
  assert.equal(repeated.length <= 64, true);
  assert.match(
    formatWindowsSecurityQualificationFailure({
      code: FIXED_STATUS.failed,
      unifiedIndexStages: ["capability", "session_open"],
    }),
    /unified_index_stages=capability,session_open$/u,
  );
  assert.doesNotMatch(
    formatWindowsSecurityQualificationFailure({
      code: FIXED_STATUS.failed,
      unifiedIndexStages: ["capability", "private-path"],
    }),
    /unified_index_stages/u,
  );
});

test("SQLite publish error parser is TAP-only, allowlisted, deduplicated, bounded, and frozen", () => {
  const output = [
    "windowsFilesystemError: WINDOWS_FILESYSTEM_ACCESS_DENIED",
    "# windowsFilesystemError: WINDOWS_FILESYSTEM_ACCESS_DENIED",
    "# windowsFilesystemError: 'WINDOWS_FILESYSTEM_OPERATION_FAILED'",
    "# windowsFilesystemError: WINDOWS_FILESYSTEM_ACCESS_DENIED",
    "# windowsFilesystemError: WINDOWS_FILESYSTEM_SQLITE_STATE_LEASE_SIDECAR_PRESENT",
    "# windowsFilesystemError: WINDOWS_FILESYSTEM_NOT_ALLOWLISTED",
    "# windowsFilesystemError: secret=do-not-return",
    "# otherProperty: WINDOWS_FILESYSTEM_HARD_LINK",
    "# windowsFilesystemError: WINDOWS_FILESYSTEM_ACCESS_DENIED secret=do-not-return",
  ].join("\n");
  const errors = extractTapPublishErrors(output);
  assert.deepEqual(errors, [
    "WINDOWS_FILESYSTEM_ACCESS_DENIED",
    "WINDOWS_FILESYSTEM_OPERATION_FAILED",
    "WINDOWS_FILESYSTEM_SQLITE_STATE_LEASE_SIDECAR_PRESENT",
  ]);
  assert.equal(Object.isFrozen(errors), true);
  assert.equal(errors.length <= 64, true);
  assert.doesNotMatch(errors.join(" "), /secret|allowlisted|otherProperty/u);

  const repeated = extractTapPublishErrors(
    Array.from(
      { length: 128 },
      (_, index) => `# windowsFilesystemError: ${WINDOWS_SQLITE_PUBLISH_ERROR_ALLOWLIST[index % WINDOWS_SQLITE_PUBLISH_ERROR_ALLOWLIST.length]}`,
    ).join("\n"),
  );
  assert.deepEqual(repeated, WINDOWS_SQLITE_PUBLISH_ERROR_ALLOWLIST);
  assert.equal(Object.isFrozen(repeated), true);
  assert.equal(repeated.length <= 64, true);
});

test("unified-index failure markers retain only fixed classes, codes, and stages", () => {
  const output = [
    "# windowsSqliteErrorCategory: BUSY_LOCKED",
    "# windowsFilesystemStage: publish_target_open",
    "# windowsFilesystemError: WINDOWS_FILESYSTEM_ACCESS_DENIED",
    "# unifiedIndexStage: database_open_or_write",
    "# windowsSqliteErrorCategory: C:\\private\\secret\\state.sqlite",
    "# windowsFilesystemStage: secret=do-not-return",
    "# windowsFilesystemError: private-message",
    "# windowsFilesystemError: WINDOWS_FILESYSTEM_ACCESS_DENIED SQL=hidden",
    "# unifiedIndexStage: private-message",
  ].join("\n");
  const categories = extractTapSqliteErrorCategories(output);
  const stages = extractTapPublishStages(output);
  const errors = extractTapPublishErrors(output);
  const unifiedIndexStages = extractTapUnifiedIndexStages(output);
  assert.deepEqual(categories, ["BUSY_LOCKED"]);
  assert.deepEqual(stages, ["publish_target_open"]);
  assert.deepEqual(errors, ["WINDOWS_FILESYSTEM_ACCESS_DENIED"]);
  assert.deepEqual(unifiedIndexStages, ["database_open_or_write"]);
  assert.doesNotMatch(
    JSON.stringify({ categories, stages, errors, unifiedIndexStages }),
    /private|secret|message|SQL|hidden|state\.sqlite/iu,
  );
});

test("qualification failure locations require the trusted test path and stay numeric", () => {
  const locations = extractTapTestLocations([
    "at (file:///C:/repo/test/windows-filesystem-security.test.js:770:5) secret=do-not-return",
    "at (test\\windows-filesystem-security.test.js:1162:34) name=do-not-return",
    "at (C:\\repo\\test\\windows-filesystem-security.test.js:30:40) path=do-not-return",
    "at test/windows-filesystem-security.test.js:770:5 duplicate",
    "secret=prefix/test/windows-filesystem-security.test.js:50:60",
    "at test/other-windows-filesystem-security.test.js:10:20",
    "at test/windows-filesystem-security.test.js:9007199254740992:4 unsafe",
    "at test/windows-filesystem-security.test.js:12:0 invalid",
  ].join("\n"));
  assert.deepEqual(locations, [[770, 5], [1162, 34], [30, 40]]);
  assert.equal(Object.isFrozen(locations), true);
  assert.equal(Object.isFrozen(locations[0]), true);
  assert.equal(locations.flat().every((value) => Number.isSafeInteger(value)), true);
  const cappedIndexes = extractTapTestIndexes(
    Array.from({ length: 70 }, (_, offset) => `not ok ${offset + 1} - secret=${offset}`).join("\n"),
  );
  const cappedLocations = extractTapTestLocations(
    Array.from(
      { length: 70 },
      (_, offset) => `at test/windows-filesystem-security.test.js:${offset + 1}:1 secret=${offset}`,
    ).join("\n"),
  );
  assert.equal(cappedIndexes.length, 64);
  assert.equal(cappedIndexes.at(-1), 64);
  assert.equal(Object.isFrozen(cappedIndexes), true);
  assert.equal(cappedLocations.length, 64);
  assert.deepEqual(cappedLocations.at(-1), [64, 1]);
  assert.equal(Object.isFrozen(cappedLocations), true);
});

test("qualification child failures attach only a safe index and never TAP content", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 4244;
  child.kill = () => true;
  const run = runNodeTests(["synthetic.test.js"], {
    cwd: REPOSITORY_ROOT,
    timeoutMs: 1_000,
    spawnProcess: () => child,
    terminateProcessTree: async () => true,
  });
  child.stdout.write([
    "TAP version 13",
    "    not ok 3 - indented secret=do-not-return",
    "not ok 9 - top-level secret=do-not-return",
    "at (file:///C:/repo/test/windows-filesystem-security.test.js:12:5) secret=do-not-return",
    "at test\\windows-filesystem-security.test.js:20:10 name=do-not-return",
    "# windowsFilesystemStage: publish_rename",
    "# windowsFilesystemStage: publish_target_postvalidate",
    "# windowsFilesystemStage: publish_rename",
    "# windowsFilesystemStage: secret=do-not-return",
    "# windowsFilesystemError: WINDOWS_FILESYSTEM_ACCESS_DENIED",
    "# windowsFilesystemError: WINDOWS_FILESYSTEM_OPERATION_FAILED",
    "# windowsFilesystemError: WINDOWS_FILESYSTEM_ACCESS_DENIED",
    "# windowsFilesystemError: secret=do-not-return",
    "# windowsSqliteErrorCategory: CANTOPEN_IOERR",
    "# windowsSqliteErrorCategory: CANTOPEN_IOERR secret=do-not-return",
    "# unifiedIndexStage: database_open_or_write",
    "# unifiedIndexStage: database_open_or_write",
    "# unifiedIndexStage: C:\\private\\secret\\state.sqlite",
  ].join("\n"));
  child.emit("close", 1);
  await assert.rejects(
    run,
    (error) => {
      assert.equal(error.code, FIXED_STATUS.failed);
      assert.equal(error.testIndex, 9);
      assert.deepEqual(error.testIndexes, [9]);
      assert.deepEqual(error.testLocations, [[12, 5], [20, 10]]);
      assert.deepEqual(error.testFileLocations, [[
        [...WINDOWS_SECURITY_QUALIFICATION_TEST_FILES]
          .sort()
          .indexOf("test/windows-filesystem-security.test.js") + 1,
        12,
        5,
      ], [
        [...WINDOWS_SECURITY_QUALIFICATION_TEST_FILES]
          .sort()
          .indexOf("test/windows-filesystem-security.test.js") + 1,
        20,
        10,
      ]]);
      assert.deepEqual(error.publishStages, [
        "publish_rename",
        "publish_target_postvalidate",
      ]);
      assert.equal(error.publishStage, "publish_rename");
      assert.deepEqual(error.publishErrors, [
        "WINDOWS_FILESYSTEM_ACCESS_DENIED",
        "WINDOWS_FILESYSTEM_OPERATION_FAILED",
      ]);
      assert.equal(error.publishError, "WINDOWS_FILESYSTEM_ACCESS_DENIED");
      assert.deepEqual(error.sqliteErrorCategories, ["CANTOPEN_IOERR"]);
      assert.equal(error.sqliteErrorCategory, "CANTOPEN_IOERR");
      assert.deepEqual(error.unifiedIndexStages, ["database_open_or_write"]);
      assert.equal(error.unifiedIndexStage, "database_open_or_write");
      assert.equal(Object.isFrozen(error.sqliteErrorCategories), true);
      assert.equal(Object.isFrozen(error.testIndexes), true);
      assert.equal(Object.isFrozen(error.testLocations), true);
      assert.equal(Object.isFrozen(error.testLocations[0]), true);
      assert.equal(Object.isFrozen(error.testFileLocations), true);
      assert.equal(Object.isFrozen(error.testFileLocations[0]), true);
      assert.equal(Object.isFrozen(error.publishStages), true);
      assert.equal(Object.isFrozen(error.publishErrors), true);
      assert.equal(Object.isFrozen(error.unifiedIndexStages), true);
      assert.equal(error.message, FIXED_STATUS.failed);
      assert.equal(Object.hasOwn(error, "stdout"), false);
      assert.equal(Object.hasOwn(error, "testName"), false);
      assert.doesNotMatch(error.message, /secret|top-level|indented/u);
      return true;
    },
  );
});

test("qualification child failures use a null index when TAP has no safe top-level ordinal", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 4245;
  child.kill = () => true;
  const run = runNodeTests(["synthetic.test.js"], {
    cwd: REPOSITORY_ROOT,
    timeoutMs: 1_000,
    spawnProcess: () => child,
    terminateProcessTree: async () => true,
  });
  child.stdout.write([
    "  not ok malformed secret=do-not-return",
    "at test/windows-filesystem-security.test.js:20:10",
    "# windowsFilesystemStage: publish_unknown secret=do-not-return",
    "# windowsFilesystemError: WINDOWS_FILESYSTEM_UNKNOWN secret=do-not-return",
  ].join("\n"));
  child.emit("close", 1);
  await assert.rejects(
    run,
    (error) => {
      assert.equal(error.code, FIXED_STATUS.failed);
      assert.equal(error.testIndex, null);
      assert.deepEqual(error.testIndexes, []);
      assert.deepEqual(error.testLocations, [[20, 10]]);
      assert.deepEqual(error.testFileLocations, [[
        [...WINDOWS_SECURITY_QUALIFICATION_TEST_FILES]
          .sort()
          .indexOf("test/windows-filesystem-security.test.js") + 1,
        20,
        10,
      ]]);
      assert.deepEqual(error.publishStages, []);
      assert.equal(error.publishStage, null);
      assert.deepEqual(error.publishErrors, []);
      assert.equal(error.publishError, null);
      assert.equal(Object.isFrozen(error.testIndexes), true);
      assert.equal(Object.isFrozen(error.testLocations), true);
      assert.equal(Object.isFrozen(error.publishStages), true);
      assert.equal(Object.isFrozen(error.publishErrors), true);
      assert.equal(error.message, FIXED_STATUS.failed);
      return true;
    },
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
      "files=23",
      "filesystem=10",
      "credentials=8",
      `revision=${revision}`,
      `cache=${cacheMode}`,
      `binding_bytes=${bindingBytes}`,
      `binding_sha256=${bindingSha256}`,
      "tests=38",
      "passed=38",
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
      dashboardCheckpoint: "startup_refresh_terminal_succeeded",
      dashboardRefreshProgress: { stage: "none", detail: "none" },
      dashboardRefreshFailure: { failedStep: "none", failureCode: "none" },
      failureReason: "none",
      failureStage: "none",
      noOrphan: true,
      relaunchPersistence: true,
      secondInstanceRejected: true,
      showHideTrayLifecycle: true,
      shutdownCheckpoint: "descendants_gone",
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
      passed: 38,
      skipped: 0,
      status: "WINDOWS_SECURITY_QUALIFICATION_PASSED",
      testFileCount: 23,
      tests: 38,
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
  for (const dashboardCheckpoint of [
    "not_started",
    "target_poll_recovery_only",
    "renderer_not_ready",
    "dashboard_ready",
    "startup_gate_released",
    "startup_refresh_request_observed",
    "startup_refresh_receipt_accepted",
    "unexpected",
  ]) {
    assert.throws(
      () => buildWindowsElectronQualificationReceipt({
        ...fixture,
        runtimeEvidence: {
          ...fixture.runtimeEvidence,
          dashboardCheckpoint,
        },
      }),
      (error) => error.code === WINDOWS_RECEIPT_STATUS.runtimeInvalid,
      `canonical receipts must require startup_refresh_terminal_succeeded, got ${dashboardCheckpoint}`,
    );
  }
  for (const shutdownCheckpoint of [
    "not_started",
    "started",
    "descendants_captured",
    "quit_acknowledged",
    "primary_exited",
    "monitor_settled",
    "unexpected",
    undefined,
  ]) {
    const runtimeEvidence = { ...fixture.runtimeEvidence };
    if (shutdownCheckpoint === undefined) {
      delete runtimeEvidence.shutdownCheckpoint;
    } else {
      runtimeEvidence.shutdownCheckpoint = shutdownCheckpoint;
    }
    assert.throws(
      () => buildWindowsElectronQualificationReceipt({
        ...fixture,
        runtimeEvidence,
      }),
      (error) => error.code === WINDOWS_RECEIPT_STATUS.runtimeInvalid,
      `canonical receipts must require descendants_gone shutdown completion, got ${shutdownCheckpoint}`,
    );
  }
  assert.throws(
    () => buildWindowsElectronQualificationReceipt({
      ...fixture,
      runtimeEvidence: {
        ...fixture.runtimeEvidence,
        status: "failed",
        failureReason: "child_exit",
        failureStage: "shutdown",
        shutdownCheckpoint: "monitor_settled",
      },
    }),
    (error) => error.code === WINDOWS_RECEIPT_STATUS.runtimeInvalid,
    "failed runtime evidence must never produce a canonical passed receipt",
  );
  assert.throws(
    () => buildWindowsElectronQualificationReceipt({
      ...fixture,
      runtimeEvidence: {
        ...fixture.runtimeEvidence,
        failureReason: "child_exit",
        failureStage: "control",
      },
    }),
    (error) => error.code === WINDOWS_RECEIPT_STATUS.runtimeInvalid,
  );
  for (const failureReason of [
    "aggregate_missing",
    "aggregate_invalid",
    "stderr_present",
    "output_read_failed",
  ]) {
    assert.throws(
      () => buildWindowsElectronQualificationReceipt({
        ...fixture,
        runtimeEvidence: {
          ...fixture.runtimeEvidence,
          status: "failed",
          failureReason,
          failureStage: "control",
        },
      }),
      (error) => error.code === WINDOWS_RECEIPT_STATUS.runtimeInvalid,
      `fallback reason ${failureReason} must not satisfy the canonical receipt gate`,
    );
  }
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
