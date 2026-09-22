#!/usr/bin/env node

/**
 * Run the Windows security qualification with content-free output.
 *
 * The regular lane runner is intentionally verbose for local development. A
 * native security qualification must be safe to attach to an issue or a CI
 * receipt, so this wrapper captures the child test process and emits only
 * fixed status classes. The tests themselves use synthetic roots, synthetic
 * fixed accountless-record bytes, and disposable credential fixtures; no
 * caller-owned credential or state is selected here.
 */

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WINDOWS_SOURCE_READ_APPROVED,
  WINDOWS_SOURCE_READ_CONTRACT,
} from "../src/platform/windows-filesystem.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const BINDING_MANIFEST_PATH = join(
  REPOSITORY_ROOT,
  "native",
  "windows-filesystem",
  "build",
  "Release",
  "windows_filesystem.node.manifest.json",
);
const FILESYSTEM_SECURITY_TEST_FILE = /^windows-(?:filesystem|security)(?:-[a-z0-9-]+)?\.test\.(?:js|mjs)$/u;
const CREDENTIAL_TEST_FILE = /^windows-(?:credential|production-credential|accountless-installation-credential)(?:-[a-z0-9-]+)?\.test\.(?:js|mjs)$/u;
const ACCOUNTLESS_CREDENTIAL_TEST_FILE = /^windows-accountless-installation-credential(?:-[a-z0-9-]+)?\.test\.(?:js|mjs)$/u;
const QUALIFICATION_TEST_FILES = Object.freeze([
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
export const WINDOWS_SECURITY_QUALIFICATION_TEST_FILES = QUALIFICATION_TEST_FILES;
const QUALIFICATION_ENVIRONMENT = "USAGE_MONITOR_WINDOWS_QUALIFICATION";
const QUALIFICATION_REVISION_ENVIRONMENT = "TIBOTATTLE_QUALIFICATION_REVISION";
const QUALIFICATION_CACHE_MODE_ENVIRONMENT = "TIBOTATTLE_QUALIFICATION_CACHE_MODE";
const MAXIMUM_TAP_FAILURE_TEST_ORDINAL = 999_999;
const MAXIMUM_TAP_FAILURE_SOURCE_LINE = 999_999;
const QUALIFICATION_FAILURE_TYPES = new Set([
  "testCodeFailure",
  "unhandledRejection",
  "uncaughtException",
  "hookFailed",
]);
const QUALIFICATION_ERROR_NAMES = new Set(["AssertionError", "Error", "TypeError"]);
const QUALIFICATION_FILE_INDEX = new Map(
  QUALIFICATION_TEST_FILES.map((file, index) => [file, index + 1]),
);

export const FIXED_STATUS = Object.freeze({
  passed: "WINDOWS_SECURITY_QUALIFICATION_PASSED",
  unsupported: "WINDOWS_SECURITY_QUALIFICATION_NATIVE_WINDOWS_REQUIRED",
  missingFilesystemTests: "WINDOWS_SECURITY_QUALIFICATION_FILESYSTEM_TESTS_MISSING",
  missingCredentialTests: "WINDOWS_SECURITY_QUALIFICATION_CREDENTIAL_TESTS_MISSING",
  missingAccountlessCredentialTests: "WINDOWS_SECURITY_QUALIFICATION_ACCOUNTLESS_CREDENTIAL_TESTS_MISSING",
  failed: "WINDOWS_SECURITY_QUALIFICATION_FAILED",
  manifestMissing: "WINDOWS_SECURITY_QUALIFICATION_MANIFEST_MISSING",
  manifestInvalid: "WINDOWS_SECURITY_QUALIFICATION_MANIFEST_INVALID",
  revisionInvalid: "WINDOWS_SECURITY_QUALIFICATION_REVISION_INVALID",
  cacheModeInvalid: "WINDOWS_SECURITY_QUALIFICATION_CACHE_MODE_INVALID",
  environmentInvalid: "WINDOWS_SECURITY_QUALIFICATION_ENVIRONMENT_INVALID",
  resultInvalid: "WINDOWS_SECURITY_QUALIFICATION_RESULT_INVALID",
  unexpectedSkip: "WINDOWS_SECURITY_QUALIFICATION_UNEXPECTED_SKIP",
});

function fixedError(status) {
  const error = new Error(status);
  error.code = status;
  return error;
}

export async function readVerifiedBindingManifest({
  manifestPath = BINDING_MANIFEST_PATH,
  readManifest = readFile,
} = {}) {
  let manifest;
  try {
    manifest = JSON.parse(await readManifest(manifestPath, "utf8"));
  } catch {
    throw fixedError(FIXED_STATUS.manifestMissing);
  }
  const valid = manifest
    && typeof manifest === "object"
    && !Array.isArray(manifest)
    && manifest.schemaVersion === "windows-filesystem-binding-manifest-v1"
    && manifest.bindingFile === "windows_filesystem.node"
    && manifest.platform === "win32"
    && manifest.architecture === "x64"
    && Number.isSafeInteger(manifest.bytes)
    && manifest.bytes > 0
    && typeof manifest.sha256 === "string"
    && /^[0-9a-f]{64}$/u.test(manifest.sha256)
    && manifest.approvedPolicy?.productionSafe === false
    && manifest.approvedPolicy?.pathWalkRaceSafe === false
    && manifest.approvedPolicy?.credentialMutexSafe === true
    && manifest.approvedPolicy?.credentialAuditFileGuardSafe === true
    && manifest.nativeClaims?.credentialAuditFileGuardSafe === true
    && manifest.credentialAuditFileGuardContractVersion
      === "windows-credential-audit-file-guard-v1"
    && manifest.credentialMutexContractVersion === "windows-credential-mutex-v1"
    && manifest.sourceRead?.contractVersion === WINDOWS_SOURCE_READ_CONTRACT
    && manifest.sourceRead?.approved === WINDOWS_SOURCE_READ_APPROVED
    && Object.keys(manifest.sourceRead).sort().join(",") === "approved,contractVersion";
  if (!valid) throw fixedError(FIXED_STATUS.manifestInvalid);
  return Object.freeze({
    bytes: manifest.bytes,
    sha256: manifest.sha256,
  });
}

export function qualificationReceiptMetadata(environment) {
  const qualificationEnabled = environment?.[QUALIFICATION_ENVIRONMENT] === "1";
  const revision = environment?.[QUALIFICATION_REVISION_ENVIRONMENT] ?? null;
  if ((qualificationEnabled && revision === null)
      || (revision !== null && !/^[0-9a-f]{40}$/iu.test(revision))) {
    throw fixedError(FIXED_STATUS.revisionInvalid);
  }
  const cacheMode = environment?.[QUALIFICATION_CACHE_MODE_ENVIRONMENT] ?? null;
  if ((qualificationEnabled && cacheMode === null)
      || (cacheMode !== null && cacheMode !== "warm" && cacheMode !== "clean")) {
    throw fixedError(FIXED_STATUS.cacheModeInvalid);
  }
  if (qualificationEnabled && environment?.GITHUB_ACTIONS !== "true") {
    throw fixedError(FIXED_STATUS.environmentInvalid);
  }
  return Object.freeze({
    cacheMode,
    revision: revision?.toLowerCase() ?? null,
  });
}

export async function qualificationTestFiles({
  platform = process.platform,
  architecture = process.arch,
} = {}) {
  if (platform !== "win32" || architecture !== "x64") {
    return Object.freeze({
      status: "unsupported",
      files: Object.freeze([]),
      filesystemFiles: Object.freeze([]),
      credentialFiles: Object.freeze([]),
      accountlessCredentialFiles: Object.freeze([]),
    });
  }

  const nativeFiles = QUALIFICATION_TEST_FILES;
  const filesystemFiles = Object.freeze(
    nativeFiles.filter((file) => FILESYSTEM_SECURITY_TEST_FILE.test(file.slice("test/".length))),
  );
  const credentialFiles = Object.freeze(
    nativeFiles.filter((file) => CREDENTIAL_TEST_FILE.test(file.slice("test/".length))),
  );
  const accountlessCredentialFiles = Object.freeze(
    nativeFiles.filter((file) => ACCOUNTLESS_CREDENTIAL_TEST_FILE.test(file.slice("test/".length))),
  );
  if (filesystemFiles.length === 0) {
    throw fixedError(FIXED_STATUS.missingFilesystemTests);
  }
  if (credentialFiles.length === 0) {
    throw fixedError(FIXED_STATUS.missingCredentialTests);
  }
  if (accountlessCredentialFiles.length === 0) {
    throw fixedError(FIXED_STATUS.missingAccountlessCredentialTests);
  }

  // The portable lane runs separately in CI. This gate adds only the explicit
  // Windows test files, keeping native coverage isolated and deterministic.
  const files = nativeFiles;
  return Object.freeze({
    status: "ready",
    files,
    filesystemFiles,
    credentialFiles,
    accountlessCredentialFiles,
  });
}

export function parseTapSummary(output) {
  if (typeof output !== "string") throw fixedError(FIXED_STATUS.resultInvalid);
  const valueFor = (label) => {
    const matches = [...output.matchAll(new RegExp(`^# ${label} (\\d+)$`, "gmu"))];
    if (matches.length !== 1) throw fixedError(FIXED_STATUS.resultInvalid);
    return Number.parseInt(matches[0][1], 10);
  };
  const result = Object.freeze({
    tests: valueFor("tests"),
    passed: valueFor("pass"),
    failed: valueFor("fail"),
    skipped: valueFor("skipped"),
    cancelled: valueFor("cancelled"),
    todo: valueFor("todo"),
  });
  if (result.tests < 1
      || result.failed !== 0
      || result.cancelled !== 0
      || result.todo !== 0
      || result.passed + result.skipped !== result.tests) {
    throw fixedError(FIXED_STATUS.resultInvalid);
  }
  if (result.skipped !== 0) throw fixedError(FIXED_STATUS.unexpectedSkip);
  return result;
}

const QUALIFICATION_FAILURE_DIAGNOSTIC_FORMAT = /^file_index=(?:unavailable|[1-9]\d{0,2}) test_ordinal=(?:unavailable|[1-9]\d{0,5}) source_line=(?:unavailable|[1-9]\d{0,5}) failure_type=(?:unavailable|testCodeFailure|unhandledRejection|uncaughtException|hookFailed) error_name=(?:unavailable|AssertionError|Error|TypeError)$/u;
const TAP_FAILURE_RESULT = /^not ok ([1-9]\d{0,6})(?:\s+-[^\r\n]*)?$/u;
const TAP_RESULT = /^(?:ok|not ok) [1-9]\d{0,6}(?:\s+-[^\r\n]*)?$/u;
const TAP_LOCATION = /^ {2}location:\s+(['"])([^'"\r\n]{1,2048})\1$/u;
const TAP_STACK_HEADER = /^ {2}stack:\s*(?:[|>][-+]?\s*)?$/u;
const TAP_FAILURE_TYPE = /^ {2}failureType:\s+(['"])([^'"\r\n]{1,64})\1[ \t]*$/u;
const TAP_ERROR_NAME = /^ {2}name:\s+(['"])([^'"\r\n]{1,64})\1[ \t]*$/u;

function boundedTapFailureOrdinal(value) {
  const ordinal = Number.parseInt(value, 10);
  return Number.isSafeInteger(ordinal)
      && ordinal >= 1
      && ordinal <= MAXIMUM_TAP_FAILURE_TEST_ORDINAL
    ? ordinal
    : null;
}

function fileIndexFromTapLocation(location) {
  if (typeof location !== "string") return null;
  const normalized = location.replaceAll("\\", "/").replace(/\/{2,}/gu, "/");
  for (const [file, index] of QUALIFICATION_FILE_INDEX) {
    const marker = `/${file}:`;
    const markerIndex = normalized.lastIndexOf(marker);
    if (markerIndex < 0) continue;
    const lineAndColumn = normalized.slice(markerIndex + marker.length);
    if (/^\d{1,9}:\d{1,9}$/u.test(lineAndColumn)) return index;
  }
  return null;
}

function sourceLocationFromTapStackFrame(line) {
  if (typeof line !== "string" || !/^\s+at(?:\s|$)/u.test(line)) return null;
  const normalized = line.replaceAll("\\", "/").replace(/\/{2,}/gu, "/");
  for (const [file, index] of QUALIFICATION_FILE_INDEX) {
    const marker = `/${file}:`;
    const markerIndex = normalized.lastIndexOf(marker);
    if (markerIndex < 0) continue;
    const locationTail = normalized.slice(markerIndex + marker.length);
    const match = /^(\d{1,9}):(\d{1,9})\)?\s*$/u.exec(locationTail);
    if (!match) continue;
    const sourceLine = Number.parseInt(match[1], 10);
    return Number.isSafeInteger(sourceLine)
        && sourceLine >= 1
        && sourceLine <= MAXIMUM_TAP_FAILURE_SOURCE_LINE
      ? { fileIndex: index, sourceLine }
      : { fileIndex: index, sourceLine: null };
  }
  return null;
}

/**
 * Extract only bounded structural information from a failed, flat Node TAP
 * stream. The test ordinal is the first global TAP `not ok` ordinal. The file
 * index is one-based and refers to the fixed, reviewed qualification file
 * order above, recovered only from a matching YAML location suffix. Test
 * titles, arbitrary paths, and assertion output are deliberately ignored.
 */
export function parseTapFailureDiagnostic(output) {
  const empty = Object.freeze({
    fileIndex: null,
    testOrdinal: null,
    sourceLine: null,
    failureType: null,
    errorName: null,
  });
  if (typeof output !== "string" || output.length > 5_000_000) return empty;

  let failureOrdinal = null;
  let fileIndex = null;
  let sourceLine = null;
  let failureType = null;
  let errorName = null;
  let failureTypeSeen = false;
  let errorNameSeen = false;
  let failureBlock = false;
  let inStack = false;
  let sourceFrameSeen = false;
  for (const line of output.split(/\r?\n/u)) {
    if (!failureBlock) {
      const failure = TAP_FAILURE_RESULT.exec(line);
      if (!failure) continue;
      failureBlock = true;
      failureOrdinal = boundedTapFailureOrdinal(failure[1]);
      continue;
    }

    const location = TAP_LOCATION.exec(line);
    if (location) {
      fileIndex ??= fileIndexFromTapLocation(location[2]);
      continue;
    }
    if (TAP_STACK_HEADER.test(line)) {
      inStack = true;
      continue;
    }
    if (inStack) {
      if (line === "" || /^ {4,}/u.test(line)) {
        if (!sourceFrameSeen) {
          const frame = sourceLocationFromTapStackFrame(line);
          if (frame) {
            sourceFrameSeen = true;
            if (fileIndex === null || fileIndex === frame.fileIndex) {
              fileIndex ??= frame.fileIndex;
              sourceLine = frame.sourceLine;
            }
          }
        }
        continue;
      }
      inStack = false;
    }
    const failureTypeMatch = TAP_FAILURE_TYPE.exec(line);
    if (failureTypeMatch && !failureTypeSeen) {
      failureTypeSeen = true;
      failureType = QUALIFICATION_FAILURE_TYPES.has(failureTypeMatch[2])
        ? failureTypeMatch[2]
        : null;
      continue;
    }
    const errorNameMatch = TAP_ERROR_NAME.exec(line);
    if (errorNameMatch && !errorNameSeen) {
      errorNameSeen = true;
      errorName = QUALIFICATION_ERROR_NAMES.has(errorNameMatch[2])
        ? errorNameMatch[2]
        : null;
      continue;
    }
    // Do not scan into the next TAP result or a later test's YAML payload.
    if (TAP_RESULT.test(line) || /^\s+\.\.\.$/u.test(line)) break;
  }
  return failureBlock
    ? Object.freeze({ fileIndex, testOrdinal: failureOrdinal, sourceLine, failureType, errorName })
    : empty;
}

/** Format only the fixed, bounded fields permitted in a qualification receipt. */
export function formatQualificationFailureDiagnostic(value) {
  const fileIndex = Number.isSafeInteger(value?.fileIndex)
      && value.fileIndex >= 1
      && value.fileIndex <= QUALIFICATION_TEST_FILES.length
    ? value.fileIndex
    : null;
  const testOrdinal = Number.isSafeInteger(value?.testOrdinal)
      && value.testOrdinal >= 1
      && value.testOrdinal <= MAXIMUM_TAP_FAILURE_TEST_ORDINAL
    ? value.testOrdinal
    : null;
  const sourceLine = Number.isSafeInteger(value?.sourceLine)
      && value.sourceLine >= 1
      && value.sourceLine <= MAXIMUM_TAP_FAILURE_SOURCE_LINE
    ? value.sourceLine
    : null;
  const failureType = QUALIFICATION_FAILURE_TYPES.has(value?.failureType)
    ? value.failureType
    : null;
  const errorName = QUALIFICATION_ERROR_NAMES.has(value?.errorName)
    ? value.errorName
    : null;
  const formatted = `file_index=${fileIndex ?? "unavailable"} test_ordinal=${testOrdinal ?? "unavailable"} source_line=${sourceLine ?? "unavailable"} failure_type=${failureType ?? "unavailable"} error_name=${errorName ?? "unavailable"}`;
  return QUALIFICATION_FAILURE_DIAGNOSTIC_FORMAT.test(formatted)
    ? formatted
    : "file_index=unavailable test_ordinal=unavailable source_line=unavailable failure_type=unavailable error_name=unavailable";
}

function runNodeTests(files, {
  environment = process.env,
  cwd = REPOSITORY_ROOT,
} = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [
      "--test",
      "--test-concurrency=1",
      "--test-reporter=tap",
      ...files,
    ], {
      cwd,
      env: {
        ...environment,
        [QUALIFICATION_ENVIRONMENT]: "1",
        USAGE_MONITOR_TEST_LANE_REPORTER: "dot",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    // Do not forward stdout/stderr. A failing native assertion may include a
    // path, SID, account name, or secret-shaped value even when the test was
    // intended to be content-free. The fixed status and bounded structural
    // diagnostic below are the only output this harness emits.
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 5_000_000) child.kill();
    });
    child.stderr.resume();
    child.once("error", () => {
      const error = fixedError(FIXED_STATUS.failed);
      error.diagnostic = formatQualificationFailureDiagnostic(null);
      rejectRun(error);
    });
    child.once("close", (code) => {
      if (code === 0) {
        try {
          resolveRun(parseTapSummary(stdout));
        } catch (error) {
          rejectRun(error);
        }
      } else {
        const error = fixedError(FIXED_STATUS.failed);
        error.diagnostic = formatQualificationFailureDiagnostic(
          parseTapFailureDiagnostic(stdout),
        );
        rejectRun(error);
      }
    });
  });
}

export async function runWindowsSecurityQualification(options = {}) {
  const selected = await qualificationTestFiles(options);
  if (selected.status === "unsupported") {
    throw fixedError(FIXED_STATUS.unsupported);
  }
  const environment = options.environment ?? process.env;
  const metadata = qualificationReceiptMetadata(environment);
  const manifest = await readVerifiedBindingManifest(options);
  const startedAt = Date.now();
  const testResult = await runNodeTests(selected.files, options);
  const durationMs = Date.now() - startedAt;
  return Object.freeze({
    status: "passed",
    testFileCount: selected.files.length,
    filesystemTestFileCount: selected.filesystemFiles.length,
    credentialTestFileCount: selected.credentialFiles.length,
    accountlessCredentialTestFileCount: selected.accountlessCredentialFiles.length,
    revision: metadata.revision,
    cacheMode: metadata.cacheMode,
    bindingBytes: manifest.bytes,
    bindingSha256: manifest.sha256,
    ...testResult,
    durationMs,
  });
}

export async function main() {
  try {
    const receipt = await runWindowsSecurityQualification();
    // Counts and build identities are safe aggregate metadata; filenames and
    // test output are not. The workflow pins and verifies revision separately
    // for both warm and clean matrix jobs.
    console.log([
      FIXED_STATUS.passed,
      `files=${receipt.testFileCount}`,
      `filesystem=${receipt.filesystemTestFileCount}`,
      `credentials=${receipt.credentialTestFileCount}`,
      `accountless_credentials=${receipt.accountlessCredentialTestFileCount}`,
      `revision=${receipt.revision ?? "unavailable"}`,
      `cache=${receipt.cacheMode ?? "unavailable"}`,
      `binding_bytes=${receipt.bindingBytes}`,
      `binding_sha256=${receipt.bindingSha256}`,
      `tests=${receipt.tests}`,
      `passed=${receipt.passed}`,
      `failed=${receipt.failed}`,
      `skipped=${receipt.skipped}`,
      `duration_ms=${receipt.durationMs}`,
    ].join(" "));
  } catch (error) {
    const status = error?.code && Object.values(FIXED_STATUS).includes(error.code)
      ? error.code
      : FIXED_STATUS.failed;
    const diagnostic = error?.diagnostic;
    console.error([
      status,
      typeof diagnostic === "string"
        && QUALIFICATION_FAILURE_DIAGNOSTIC_FORMAT.test(diagnostic)
        ? diagnostic
        : null,
    ].filter(Boolean).join(" "));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main();
}
