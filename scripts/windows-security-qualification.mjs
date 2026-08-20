#!/usr/bin/env node

/**
 * Run the Windows security qualification with content-free output.
 *
 * The regular lane runner is intentionally verbose for local development. A
 * native security qualification must be safe to attach to an issue or a CI
 * receipt, so this wrapper captures the child test process and emits only
 * fixed status classes. The tests themselves use synthetic roots and
 * disposable credentials; no caller-owned state is selected here.
 */

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const BINDING_PROVENANCE_CONTRACT_VERSION = "windows-binding-provenance-v1";
const BINDING_PROVENANCE_STATUS = "unqualified";
const BINDING_PROVENANCE_SOURCE = "unsigned-development-binding";
const WINDOWS_REQUIRED_METHODS = Object.freeze([
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
]);
const WINDOWS_NATIVE_MANIFEST_KEYS = Object.freeze([
  "schemaVersion",
  "bindingFile",
  "platform",
  "architecture",
  "bytes",
  "sha256",
  "contractVersion",
  "securityContractVersion",
  "credentialAuditFileGuardContractVersion",
  "sqliteStateLeaseContractVersion",
  "credentialMutexContractVersion",
  "companionInstanceMutexContractVersion",
  "preparedArtifactContractVersion",
  "requiredMethods",
  "nativeClaims",
  "approvedPolicy",
  "bindingProvenance",
]);
const WINDOWS_NATIVE_CLAIM_KEYS = Object.freeze([
  "productionSafe",
  "pathWalkRaceSafe",
  "credentialMutexSafe",
  "companionInstanceMutexSafe",
  "credentialAuditFileGuardSafe",
  "sqliteStateLeaseSafe",
  "preparedArtifactSafe",
]);
const FILESYSTEM_SECURITY_TEST_FILE = /^windows-(?:filesystem|security)(?:-[a-z0-9-]+)?\.test\.(?:js|mjs)$/u;
const CREDENTIAL_TEST_FILE = /^windows-(?:credential|production-credential)(?:-[a-z0-9-]+)?\.test\.(?:js|mjs)$/u;
const QUALIFICATION_TEST_FILES = Object.freeze([
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
export const WINDOWS_SECURITY_QUALIFICATION_TEST_FILES = QUALIFICATION_TEST_FILES;
const QUALIFICATION_ENVIRONMENT = "USAGE_MONITOR_WINDOWS_QUALIFICATION";
const QUALIFICATION_REVISION_ENVIRONMENT = "TIBOTATTLE_QUALIFICATION_REVISION";
const QUALIFICATION_CACHE_MODE_ENVIRONMENT = "TIBOTATTLE_QUALIFICATION_CACHE_MODE";
const QUALIFICATION_RUN_TIMEOUT_MS = 30 * 60 * 1_000;
const QUALIFICATION_TERMINATION_TIMEOUT_MS = 10_000;
const QUALIFICATION_MAXIMUM_CAPTURE_BYTES = 5_000_000;

export const FIXED_STATUS = Object.freeze({
  passed: "WINDOWS_SECURITY_QUALIFICATION_PASSED",
  unsupported: "WINDOWS_SECURITY_QUALIFICATION_NATIVE_WINDOWS_REQUIRED",
  missingFilesystemTests: "WINDOWS_SECURITY_QUALIFICATION_FILESYSTEM_TESTS_MISSING",
  missingCredentialTests: "WINDOWS_SECURITY_QUALIFICATION_CREDENTIAL_TESTS_MISSING",
  failed: "WINDOWS_SECURITY_QUALIFICATION_FAILED",
  manifestMissing: "WINDOWS_SECURITY_QUALIFICATION_MANIFEST_MISSING",
  manifestInvalid: "WINDOWS_SECURITY_QUALIFICATION_MANIFEST_INVALID",
  revisionInvalid: "WINDOWS_SECURITY_QUALIFICATION_REVISION_INVALID",
  cacheModeInvalid: "WINDOWS_SECURITY_QUALIFICATION_CACHE_MODE_INVALID",
  environmentInvalid: "WINDOWS_SECURITY_QUALIFICATION_ENVIRONMENT_INVALID",
  resultInvalid: "WINDOWS_SECURITY_QUALIFICATION_RESULT_INVALID",
  unexpectedSkip: "WINDOWS_SECURITY_QUALIFICATION_UNEXPECTED_SKIP",
  timedOut: "WINDOWS_SECURITY_QUALIFICATION_TIMED_OUT",
  terminationFailed: "WINDOWS_SECURITY_QUALIFICATION_TERMINATION_FAILED",
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
  const bindingProvenance = manifest?.bindingProvenance;
  const exactKeys = (value, keys) => value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
  const exactBooleanClaims = (value) => exactKeys(value, WINDOWS_NATIVE_CLAIM_KEYS)
    && WINDOWS_NATIVE_CLAIM_KEYS.every((key) => typeof value[key] === "boolean");
  const valid = manifest
    && typeof manifest === "object"
    && !Array.isArray(manifest)
    && exactKeys(manifest, WINDOWS_NATIVE_MANIFEST_KEYS)
    && manifest.schemaVersion === "windows-filesystem-binding-manifest-v1"
    && manifest.bindingFile === "windows_filesystem.node"
    && manifest.platform === "win32"
    && manifest.architecture === "x64"
    && Number.isSafeInteger(manifest.bytes)
    && manifest.bytes > 0
    && typeof manifest.sha256 === "string"
    && /^[0-9a-f]{64}$/u.test(manifest.sha256)
    && manifest.contractVersion === "windows-filesystem-v1"
    && manifest.securityContractVersion === "windows-filesystem-security-v1"
    && manifest.approvedPolicy?.productionSafe === false
    && manifest.approvedPolicy?.pathWalkRaceSafe === false
    && manifest.approvedPolicy?.credentialMutexSafe === true
    && manifest.approvedPolicy?.companionInstanceMutexSafe === false
    && manifest.approvedPolicy?.credentialAuditFileGuardSafe === true
    && manifest.approvedPolicy?.sqliteStateLeaseSafe === false
    && manifest.approvedPolicy?.preparedArtifactSafe === false
    && manifest.nativeClaims?.credentialAuditFileGuardSafe === true
    && manifest.nativeClaims?.companionInstanceMutexSafe === false
    && manifest.nativeClaims?.sqliteStateLeaseSafe === false
    && manifest.credentialAuditFileGuardContractVersion
      === "windows-credential-audit-file-guard-v1"
    && manifest.credentialMutexContractVersion === "windows-credential-mutex-v1"
    && manifest.companionInstanceMutexContractVersion
      === "windows-companion-instance-mutex-v1"
    && manifest.sqliteStateLeaseContractVersion === "windows-sqlite-state-lease-v1"
    && manifest.preparedArtifactContractVersion === "windows-prepared-artifact-v1"
    && Array.isArray(manifest.requiredMethods)
    && manifest.requiredMethods.length === WINDOWS_REQUIRED_METHODS.length
    && manifest.requiredMethods.every((method, index) => method === WINDOWS_REQUIRED_METHODS[index])
    && exactBooleanClaims(manifest.nativeClaims)
    && exactBooleanClaims(manifest.approvedPolicy)
    && manifest.nativeClaims.productionSafe === false
    && manifest.nativeClaims.pathWalkRaceSafe === false
    && manifest.nativeClaims.credentialMutexSafe === true
    && manifest.nativeClaims.companionInstanceMutexSafe === false
    && manifest.nativeClaims.credentialAuditFileGuardSafe === true
    && manifest.nativeClaims.sqliteStateLeaseSafe === false
    && manifest.nativeClaims.preparedArtifactSafe === false
    && WINDOWS_NATIVE_CLAIM_KEYS.every((key) =>
      manifest.nativeClaims[key] === manifest.approvedPolicy[key])
    && bindingProvenance !== null
    && typeof bindingProvenance === "object"
    && !Array.isArray(bindingProvenance)
    && Object.keys(bindingProvenance).length === 3
    && bindingProvenance.contractVersion === BINDING_PROVENANCE_CONTRACT_VERSION
    && bindingProvenance.status === BINDING_PROVENANCE_STATUS
    && bindingProvenance.source === BINDING_PROVENANCE_SOURCE;
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
    });
  }

  const nativeFiles = QUALIFICATION_TEST_FILES;
  const filesystemFiles = Object.freeze(
    nativeFiles.filter((file) => FILESYSTEM_SECURITY_TEST_FILE.test(file.slice("test/".length))),
  );
  const credentialFiles = Object.freeze(
    nativeFiles.filter((file) => CREDENTIAL_TEST_FILE.test(file.slice("test/".length))),
  );
  if (filesystemFiles.length === 0) {
    throw fixedError(FIXED_STATUS.missingFilesystemTests);
  }
  if (credentialFiles.length === 0) {
    throw fixedError(FIXED_STATUS.missingCredentialTests);
  }

  // The portable lane runs separately in CI. This gate adds only the explicit
  // Windows test files, keeping native coverage isolated and deterministic.
  const files = nativeFiles;
  return Object.freeze({
    status: "ready",
    files,
    filesystemFiles,
    credentialFiles,
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

function safeTapTestIndex(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Extract only the ordinal from an unindented top-level TAP failure line.
 *
 * The captured output is untrusted test output. Keep the returned diagnostic
 * deliberately numeric: never retain or expose a TAP name, body, or detail.
 */
export function extractTapTestIndex(output) {
  if (typeof output !== "string") return null;
  const match = /^not ok ([0-9]+) -(?:[ \t]|(?:\r?$))/mu.exec(output);
  if (match === null) return null;
  return safeTapTestIndex(Number.parseInt(match[1], 10));
}

function fixedFailureWithTapTestIndex(output) {
  const error = fixedError(FIXED_STATUS.failed);
  error.testIndex = extractTapTestIndex(output);
  return error;
}

async function terminateChildProcessTree(child) {
  if (!child) return false;
  if (process.platform !== "win32" || !Number.isSafeInteger(child.pid)) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return child.kill("SIGKILL");
  }
  // Never invoke taskkill with a numeric PID after the owned root process has
  // exited. Windows may already have reassigned that PID; fail closed instead
  // of risking termination of an unrelated process. A future Job Object can
  // provide the stronger descendant identity required to recover this case.
  if (child.exitCode !== null || child.signalCode !== null) return false;
  const taskkillSucceeded = await new Promise((resolveTermination) => {
    let settled = false;
    const settle = (succeeded) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveTermination(succeeded);
    };
    const killer = spawn("taskkill.exe", [
      "/pid",
      String(child.pid),
      "/t",
      "/f",
    ], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    const timer = setTimeout(
      () => settle(false),
      QUALIFICATION_TERMINATION_TIMEOUT_MS,
    );
    killer.once("error", () => settle(false));
    killer.once("close", (code) => settle(code === 0));
  });
  if (taskkillSucceeded) return true;
  if (child.exitCode === null && child.signalCode === null) child.kill();
  // A failed taskkill cannot prove that descendants were removed, even when
  // the root process has already exited or a direct fallback kill succeeds.
  return false;
}

export function runNodeTests(files, {
  environment = process.env,
  cwd = REPOSITORY_ROOT,
  timeoutMs = QUALIFICATION_RUN_TIMEOUT_MS,
  maximumCaptureBytes = QUALIFICATION_MAXIMUM_CAPTURE_BYTES,
  spawnProcess = spawn,
  terminateProcessTree = terminateChildProcessTree,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
      || timeoutMs > QUALIFICATION_RUN_TIMEOUT_MS
      || !Number.isSafeInteger(maximumCaptureBytes)
      || maximumCaptureBytes < 1
      || maximumCaptureBytes > QUALIFICATION_MAXIMUM_CAPTURE_BYTES
      || typeof spawnProcess !== "function"
      || typeof terminateProcessTree !== "function") {
    return Promise.reject(fixedError(FIXED_STATUS.environmentInvalid));
  }
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnProcess(process.execPath, [
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
    // intended to be content-free. The fixed status below is the only output
    // this harness emits.
    let stdout = "";
    let captureStopped = false;
    let terminationRequested = false;
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const terminateWith = async (status) => {
      if (terminationRequested) return;
      terminationRequested = true;
      const terminated = await terminateProcessTree(child).catch(() => false);
      settle(
        rejectRun,
        fixedError(terminated ? status : FIXED_STATUS.terminationFailed),
      );
    };
    const timeout = setTimeout(() => {
      void terminateWith(FIXED_STATUS.timedOut);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (captureStopped) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > maximumCaptureBytes) {
        captureStopped = true;
        stdout = "";
        child.stdout.pause();
        void terminateWith(FIXED_STATUS.failed);
      }
    });
    child.stderr.resume();
    child.once("error", () => {
      if (terminationRequested) return;
      settle(rejectRun, fixedError(FIXED_STATUS.failed));
    });
    child.once("close", (code) => {
      if (terminationRequested) return;
      if (code === 0) {
        try {
          settle(resolveRun, parseTapSummary(stdout));
        } catch (error) {
          settle(rejectRun, error);
        }
      } else {
        settle(rejectRun, fixedFailureWithTapTestIndex(stdout));
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
  // Deliberately do not forward the test-only process injection seams exposed
  // by runNodeTests. The receipt-producing entrypoint always owns the real
  // Node child and real process-tree terminator.
  const testResult = await runNodeTests(selected.files, {
    environment,
    cwd: options.cwd ?? REPOSITORY_ROOT,
    timeoutMs: options.timeoutMs ?? QUALIFICATION_RUN_TIMEOUT_MS,
  });
  const durationMs = Date.now() - startedAt;
  return Object.freeze({
    status: "passed",
    testFileCount: selected.files.length,
    filesystemTestFileCount: selected.filesystemFiles.length,
    credentialTestFileCount: selected.credentialFiles.length,
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
    console.error(status);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main();
}
