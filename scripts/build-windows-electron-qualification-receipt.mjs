#!/usr/bin/env node

/**
 * Build one content-free, exact-revision receipt for the Windows Electron
 * development artifact.
 *
 * The inputs are deliberately narrow.  The package verifier and the Windows
 * runtime smoke write aggregate JSON only; this script accepts those closed
 * shapes, checks that they agree with the selected revision/binding/cache
 * tuple, and writes a stable receipt.  It never reads or serializes a path,
 * username, environment, process id, command line, diagnostic stream, or
 * source payload.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_FILE = fileURLToPath(import.meta.url);

const RECEIPT_SCHEMA = "tibotattle-windows-electron-development-qualification-v1";
const RECEIPT_STATUS = "WINDOWS_ELECTRON_DEVELOPMENT_QUALIFICATION_PASSED";
const QUALIFICATION_STATUS = "WINDOWS_SECURITY_QUALIFICATION_PASSED";
const PACKAGE_STATUS = "ELECTRON_DEVELOPMENT_ARTIFACT_VERIFIED";
const RUNTIME_STATUS = "WINDOWS_ELECTRON_RUNTIME_SMOKE_PASSED";
const RUNTIME_AGGREGATE_STATUS = "passed";
const TARGET = "win32-x64";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;

const AGGREGATE_KEYS = Object.freeze(["bytes", "count", "sha256"]);
const PACKAGE_KEYS = Object.freeze([
  "artifact",
  "asar",
  "binding",
  "nativeFileCount",
  "staged",
  "status",
  "target",
  "unpacked",
]);
const PACKAGE_BINDING_KEYS = Object.freeze(["bytes", "sha256", "status"]);
const QUALIFICATION_KEYS = Object.freeze([
  "credentialTestFileCount",
  "filesystemTestFileCount",
  "failed",
  "passed",
  "skipped",
  "status",
  "testFileCount",
  "tests",
]);
// This is the closed aggregate emitted by scripts/smoke-electron-windows.mjs.
// Keep the source contract separate from the canonical receipt contract below
// so the receipt cannot accidentally retain a future diagnostic field.
const RUNTIME_KEYS = Object.freeze([
  "artifact",
  "cleanQuit",
  "contentFree",
  "dashboardReady",
  "dashboardCheckpoint",
  "dashboardRefreshProgress",
  "dashboardRefreshFailure",
  "credentialPersistence",
  "failureReason",
  "failureStage",
  "noOrphan",
  "relaunchPersistence",
  "secondInstanceRejected",
  "showHideTrayLifecycle",
  "statePersistence",
  "status",
  "syntheticRefresh",
  "target",
]);
const RUNTIME_CHECK_KEYS = Object.freeze([
  "cleanQuit",
  "credentialPersistence",
  "dashboardReady",
  "diagnostics",
  "launched",
  "noOrphanProcesses",
  "relaunchPersistence",
  "singleInstanceRejected",
  "statePersistence",
  "syntheticRefresh",
  "trayWindowLifecycle",
]);
const DASHBOARD_CHECKPOINT_ALLOWLIST = Object.freeze([
  "not_started",
  "debug_endpoint_ready",
  "target_poll_no_page",
  "target_poll_recovery_only",
  "target_poll_dashboard_candidate",
  "cdp_attach_failed",
  "frame_unavailable",
  "renderer_not_ready",
  "dashboard_ready",
  "startup_gate_released",
  "startup_refresh_request_observed",
  "startup_refresh_receipt_accepted",
  "startup_refresh_terminal_succeeded",
]);
const DASHBOARD_REFRESH_PROGRESS_ALLOWLIST = Object.freeze([
  Object.freeze({ stage: "none", detail: "none" }),
  Object.freeze({ stage: "collector", detail: "in_progress" }),
  Object.freeze({ stage: "collector", detail: "quick_result" }),
  Object.freeze({ stage: "indexing", detail: "archive_index" }),
]);
const UNIFIED_INDEX_FAILURE_CODE_ALLOWLIST = Object.freeze([
  "codex_rollout_compression_unsupported",
  "codex_rollout_filename_identity_mismatch",
  "codex_rollout_generation_ambiguous",
  "codex_rollout_lineage_invalid",
  "codex_rollout_content_invalid",
  "codex_rollout_tail_incomplete",
  "local_unified_index_aborted",
  "local_unified_index_directory_sync_failed",
  "local_unified_index_file_changed",
  "local_unified_index_file_invalid",
  "local_unified_index_generation_invalid",
  "local_unified_index_generation_mismatch",
  "local_unified_index_integrity_failed",
  "local_unified_index_journal_mode_refused",
  "local_unified_index_meta_invalid",
  "local_unified_index_missing",
  "local_unified_index_publication_durability_uncertain",
  "local_unified_index_schema_invalid",
  "local_unified_index_secondary_indexes_failed",
  "local_unified_index_secondary_indexes_missing",
  "local_unified_index_secret_invalid",
  "local_unified_index_secret_unavailable",
  "local_unified_index_unavailable",
  "local_unified_index_worker_failed",
  "local_unified_index_refresh_failed",
]);
const RECEIPT_KEYS = Object.freeze([
  "binding",
  "cacheMode",
  "mode",
  "packaged",
  "productionReadiness",
  "qualification",
  "revision",
  "runtime",
  "schemaVersion",
  "status",
  "target",
]);

export const FIXED_STATUS = Object.freeze({
  inputInvalid: "WINDOWS_ELECTRON_RECEIPT_INPUT_INVALID",
  inputMissing: "WINDOWS_ELECTRON_RECEIPT_INPUT_MISSING",
  outputInvalid: "WINDOWS_ELECTRON_RECEIPT_OUTPUT_INVALID",
  revisionInvalid: "WINDOWS_ELECTRON_RECEIPT_REVISION_INVALID",
  targetInvalid: "WINDOWS_ELECTRON_RECEIPT_TARGET_INVALID",
  cacheModeInvalid: "WINDOWS_ELECTRON_RECEIPT_CACHE_MODE_INVALID",
  bindingInvalid: "WINDOWS_ELECTRON_RECEIPT_BINDING_INVALID",
  qualificationInvalid: "WINDOWS_ELECTRON_RECEIPT_QUALIFICATION_INVALID",
  packageInvalid: "WINDOWS_ELECTRON_RECEIPT_PACKAGE_INVALID",
  runtimeInvalid: "WINDOWS_ELECTRON_RECEIPT_RUNTIME_INVALID",
  receiptInvalid: "WINDOWS_ELECTRON_RECEIPT_SHAPE_INVALID",
  passed: RECEIPT_STATUS,
});

const KNOWN_STATUSES = new Set(Object.values(FIXED_STATUS));

function fixedError(status) {
  const error = new Error(status);
  error.code = status;
  return error;
}

function fail(status) {
  throw fixedError(status);
}

function compareKeys(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function exactObjectKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort(compareKeys).join("\0")
      === [...keys].sort(compareKeys).join("\0");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareKeys)
      .map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function assertSafeCount(value, status) {
  if (!Number.isSafeInteger(value) || value < 0) fail(status);
}

function assertSha256(value, status) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(status);
}

function assertRevision(value, status = FIXED_STATUS.revisionInvalid) {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) fail(status);
  return value.toLowerCase();
}

function assertAggregate(value) {
  if (!exactObjectKeys(value, AGGREGATE_KEYS)) fail(FIXED_STATUS.packageInvalid);
  assertSafeCount(value.count, FIXED_STATUS.packageInvalid);
  assertSafeCount(value.bytes, FIXED_STATUS.packageInvalid);
  assertSha256(value.sha256, FIXED_STATUS.packageInvalid);
  return Object.freeze({
    bytes: value.bytes,
    count: value.count,
    sha256: value.sha256,
  });
}

function assertBinding(value, expected) {
  if (!exactObjectKeys(value, PACKAGE_BINDING_KEYS)
      || value.status !== "included_unverified") {
    fail(FIXED_STATUS.bindingInvalid);
  }
  assertSafeCount(value.bytes, FIXED_STATUS.bindingInvalid);
  assertSha256(value.sha256, FIXED_STATUS.bindingInvalid);
  if (value.bytes !== expected.bytes || value.sha256 !== expected.sha256) {
    fail(FIXED_STATUS.bindingInvalid);
  }
  return Object.freeze({
    bytes: value.bytes,
    sha256: value.sha256,
    status: value.status,
  });
}

/** Validate the aggregate-only output of verify-electron-development-artifact. */
export function validatePackagedEvidence(value, binding) {
  if (!exactObjectKeys(value, PACKAGE_KEYS)
      || value.status !== PACKAGE_STATUS
      || value.target !== TARGET
      || value.nativeFileCount !== 2) {
    fail(FIXED_STATUS.packageInvalid);
  }
  assertSafeCount(value.nativeFileCount, FIXED_STATUS.packageInvalid);
  const selectedBinding = assertBinding(value.binding, binding);
  return Object.freeze({
    artifact: assertAggregate(value.artifact),
    asar: assertAggregate(value.asar),
    binding: selectedBinding,
    nativeFileCount: value.nativeFileCount,
    staged: assertAggregate(value.staged),
    status: value.status,
    target: value.target,
    unpacked: assertAggregate(value.unpacked),
  });
}

/** Validate the fixed aggregate output of windows-security-qualification.mjs. */
export function parseQualificationResult(value, expected) {
  if (typeof value !== "string") fail(FIXED_STATUS.qualificationInvalid);
  const match = /^WINDOWS_SECURITY_QUALIFICATION_PASSED files=(\d+) filesystem=(\d+) credentials=(\d+) revision=([0-9a-f]{40}) cache=(warm|clean) binding_bytes=(\d+) binding_sha256=([0-9a-f]{64}) tests=(\d+) passed=(\d+) failed=(\d+) skipped=(\d+) duration_ms=(\d+)$/u
    .exec(value.trim());
  if (!match) fail(FIXED_STATUS.qualificationInvalid);
  const [
    ,
    testFileCount,
    filesystemTestFileCount,
    credentialTestFileCount,
    revision,
    cacheMode,
    bindingBytes,
    bindingSha256,
    tests,
    passed,
    failed,
    skipped,
  ] = match;
  const numbers = Object.fromEntries([
    ["testFileCount", testFileCount],
    ["filesystemTestFileCount", filesystemTestFileCount],
    ["credentialTestFileCount", credentialTestFileCount],
    ["bindingBytes", bindingBytes],
    ["tests", tests],
    ["passed", passed],
    ["failed", failed],
    ["skipped", skipped],
  ].map(([key, number]) => [key, Number(number)]));
  if (Object.values(numbers).some((number) => !Number.isSafeInteger(number) || number < 0)
      || numbers.testFileCount < 1
      || numbers.filesystemTestFileCount < 1
      || numbers.credentialTestFileCount < 1
      || numbers.tests < 1
      || numbers.passed !== numbers.tests
      || numbers.failed !== 0
      || numbers.skipped !== 0) {
    fail(FIXED_STATUS.qualificationInvalid);
  }
  const selectedRevision = assertRevision(revision, FIXED_STATUS.qualificationInvalid);
  if (selectedRevision !== expected.revision
      || cacheMode !== expected.cacheMode
      || numbers.bindingBytes !== expected.binding.bytes
      || bindingSha256 !== expected.binding.sha256) {
    fail(FIXED_STATUS.qualificationInvalid);
  }
  return Object.freeze({
    credentialTestFileCount: numbers.credentialTestFileCount,
    filesystemTestFileCount: numbers.filesystemTestFileCount,
    failed: numbers.failed,
    passed: numbers.passed,
    skipped: numbers.skipped,
    status: QUALIFICATION_STATUS,
    testFileCount: numbers.testFileCount,
    tests: numbers.tests,
  });
}

/**
 * Validate the Windows runtime smoke contract.  Every check is mandatory;
 * accepting a partial smoke result would turn a package receipt into an
 * unsupported runtime claim.
 */
export function validateRuntimeEvidence(value) {
  const progress = value?.dashboardRefreshProgress;
  const progressKeys = progress !== null
    && typeof progress === "object"
    && !Array.isArray(progress)
    ? Object.keys(progress).sort(compareKeys).join("\0")
    : null;
  const validProgress = progressKeys === "detail\0stage"
    && DASHBOARD_REFRESH_PROGRESS_ALLOWLIST.some(
      (candidate) => candidate.stage === progress.stage
        && candidate.detail === progress.detail,
    );
  const failure = value?.dashboardRefreshFailure;
  const failureKeys = failure !== null
    && typeof failure === "object"
    && !Array.isArray(failure)
    ? Object.keys(failure).sort(compareKeys).join("\0")
    : null;
  const validFailure = failureKeys === "failedStep\0failureCode"
    && ((failure.failedStep === "none" && failure.failureCode === "none")
      || (failure.failedStep === "unified_index"
        && (failure.failureCode === "unknown"
          || UNIFIED_INDEX_FAILURE_CODE_ALLOWLIST.includes(failure.failureCode))));
  if (!exactObjectKeys(value, RUNTIME_KEYS)
      || value.status !== RUNTIME_AGGREGATE_STATUS
      || value.target !== TARGET
      || value.contentFree !== true
      || value.failureStage !== "none"
      || value.failureReason !== "none"
      || !DASHBOARD_CHECKPOINT_ALLOWLIST.includes(value.dashboardCheckpoint)
      || value.dashboardCheckpoint !== "startup_refresh_terminal_succeeded"
      || !validProgress
      || !validFailure
      || failure.failedStep !== "none"
      || failure.failureCode !== "none"
      || RUNTIME_KEYS
        .filter((key) => !["status", "target", "contentFree", "failureStage", "failureReason", "dashboardCheckpoint", "dashboardRefreshProgress", "dashboardRefreshFailure"].includes(key))
        .some((key) => value[key] !== true)) {
    fail(FIXED_STATUS.runtimeInvalid);
  }
  // Startup progress is retained in the failed/safe runtime sidecar. A
  // passed canonical receipt only carries the boolean checks, so this
  // qualification-only diagnostic cannot expand the release receipt shape.
  return Object.freeze({
    checks: Object.freeze({
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
    }),
    status: RUNTIME_STATUS,
    target: TARGET,
  });
}

function validateCanonicalRuntimeEvidence(value) {
  if (!exactObjectKeys(value, ["checks", "status", "target"])
      || value.status !== RUNTIME_STATUS
      || value.target !== TARGET
      || !exactObjectKeys(value.checks, RUNTIME_CHECK_KEYS)
      || value.checks.diagnostics !== "content-free"
      || RUNTIME_CHECK_KEYS
        .filter((key) => key !== "diagnostics")
        .some((key) => value.checks[key] !== true)) {
    fail(FIXED_STATUS.receiptInvalid);
  }
  return value;
}

function readJson(text, status) {
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail(status);
    return value;
  } catch (error) {
    if (KNOWN_STATUSES.has(error?.code)) throw error;
    fail(status);
  }
}

async function readJsonFile(path, status) {
  if (typeof path !== "string" || path.length === 0) fail(FIXED_STATUS.inputInvalid);
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    fail(status);
  }
  return readJson(contents, status);
}

function normalizeInputs({
  revision,
  target,
  cacheMode,
  bindingSha256,
  bindingBytes,
  qualificationResult,
  packagedEvidence,
  runtimeEvidence,
} = {}) {
  if (target !== TARGET) fail(FIXED_STATUS.targetInvalid);
  if (cacheMode !== "warm" && cacheMode !== "clean") fail(FIXED_STATUS.cacheModeInvalid);
  const selectedRevision = assertRevision(revision);
  const selectedBindingBytes = Number(bindingBytes);
  if (!Number.isSafeInteger(selectedBindingBytes) || selectedBindingBytes < 1) {
    fail(FIXED_STATUS.bindingInvalid);
  }
  assertSha256(bindingSha256, FIXED_STATUS.bindingInvalid);
  const binding = Object.freeze({ bytes: selectedBindingBytes, sha256: bindingSha256 });
  const packaged = validatePackagedEvidence(packagedEvidence, binding);
  const qualification = parseQualificationResult(qualificationResult, {
    binding,
    cacheMode,
    revision: selectedRevision,
  });
  const runtime = validateRuntimeEvidence(runtimeEvidence);
  return Object.freeze({
    binding,
    cacheMode,
    packaged,
    qualification,
    revision: selectedRevision,
    runtime,
    target: TARGET,
  });
}

/** Build a stable content-free receipt from already parsed evidence. */
export function buildWindowsElectronQualificationReceipt(inputs) {
  const selected = normalizeInputs(inputs);
  return Object.freeze({
    binding: selected.binding,
    cacheMode: selected.cacheMode,
    mode: "qualification_only",
    packaged: selected.packaged,
    productionReadiness: "not_claimed",
    qualification: selected.qualification,
    revision: selected.revision,
    runtime: selected.runtime,
    schemaVersion: RECEIPT_SCHEMA,
    status: RECEIPT_STATUS,
    target: selected.target,
  });
}

function assertReceiptShape(value) {
  if (!exactObjectKeys(value, RECEIPT_KEYS)
      || value.schemaVersion !== RECEIPT_SCHEMA
      || value.status !== RECEIPT_STATUS
      || value.target !== TARGET
      || value.mode !== "qualification_only"
      || value.productionReadiness !== "not_claimed"
      || (value.cacheMode !== "warm" && value.cacheMode !== "clean")) {
    fail(FIXED_STATUS.receiptInvalid);
  }
  assertRevision(value.revision, FIXED_STATUS.receiptInvalid);
  if (!exactObjectKeys(value.binding, ["bytes", "sha256"])) fail(FIXED_STATUS.receiptInvalid);
  assertSafeCount(value.binding.bytes, FIXED_STATUS.receiptInvalid);
  assertSha256(value.binding.sha256, FIXED_STATUS.receiptInvalid);
  validatePackagedEvidence(value.packaged, value.binding);
  // The qualification fields are already reduced to fixed integers/status.
  if (!exactObjectKeys(value.qualification, QUALIFICATION_KEYS)
      || value.qualification.status !== QUALIFICATION_STATUS) {
    fail(FIXED_STATUS.receiptInvalid);
  }
  for (const key of QUALIFICATION_KEYS) {
    if (key === "status") continue;
    assertSafeCount(value.qualification[key], FIXED_STATUS.receiptInvalid);
  }
  if (value.qualification.failed !== 0
      || value.qualification.skipped !== 0
      || value.qualification.passed !== value.qualification.tests) {
    fail(FIXED_STATUS.receiptInvalid);
  }
  validateCanonicalRuntimeEvidence(value.runtime);
  return value;
}

export function parseArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  const parsed = {
    output: null,
    revision: null,
    target: null,
    cacheMode: null,
    bindingSha256: null,
    bindingBytes: null,
    qualificationResult: null,
    packagedEvidence: null,
    runtimeEvidence: null,
  };
  const fields = new Map([
    ["--output", "output"],
    ["--revision", "revision"],
    ["--target", "target"],
    ["--cache-mode", "cacheMode"],
    ["--binding-sha256", "bindingSha256"],
    ["--binding-bytes", "bindingBytes"],
    ["--qualification-result", "qualificationResult"],
    ["--packaged-evidence", "packagedEvidence"],
    ["--runtime-evidence", "runtimeEvidence"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const field = fields.get(argv[index]);
    if (!field || parsed[field] !== null) fail(FIXED_STATUS.inputInvalid);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      fail(FIXED_STATUS.inputInvalid);
    }
    parsed[field] = value;
    index += 1;
  }
  if (Object.values(parsed).some((value) => value === null)) fail(FIXED_STATUS.inputMissing);
  return Object.freeze(parsed);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const argumentsValue = parseArguments(argv);
    const [packagedEvidence, runtimeEvidence, qualificationResult] = await Promise.all([
      readJsonFile(argumentsValue.packagedEvidence, FIXED_STATUS.packageInvalid),
      readJsonFile(argumentsValue.runtimeEvidence, FIXED_STATUS.runtimeInvalid),
      readFile(argumentsValue.qualificationResult, "utf8").catch(() => {
        fail(FIXED_STATUS.qualificationInvalid);
      }),
    ]);
    const receipt = buildWindowsElectronQualificationReceipt({
      ...argumentsValue,
      packagedEvidence,
      qualificationResult,
      runtimeEvidence,
    });
    assertReceiptShape(receipt);
    const outputPath = resolve(argumentsValue.output);
    try {
      await writeFile(outputPath, stableJson(receipt), { flag: "wx", mode: 0o600 });
    } catch {
      fail(FIXED_STATUS.outputInvalid);
    }
    process.stdout.write(`${JSON.stringify({
      cacheMode: receipt.cacheMode,
      revision: receipt.revision,
      status: receipt.status,
      target: receipt.target,
    })}\n`);
  } catch (error) {
    const status = KNOWN_STATUSES.has(error?.code)
      ? error.code
      : FIXED_STATUS.inputInvalid;
    process.stderr.write(`${status}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  await main();
}
