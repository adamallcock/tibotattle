#!/usr/bin/env node

/**
 * Verify the offline handoff between the manual Windows portability canary and
 * a future protected Windows release finalizer.
 *
 * This module intentionally consumes only fixed, aggregate JSON.  It does not
 * call GitHub, inspect a checkout, open an artifact, or retain a workflow
 * path, source path, log, username, or diagnostic payload.  The receipt files
 * are the exact content-free receipts produced by
 * build-windows-electron-qualification-receipt.mjs; their raw-byte hashes are
 * checked against the direct artifact metadata before JSON parsing.
 */

import { constants as fsConstants } from "node:fs";
import { lstat, open, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_FILE = fileURLToPath(import.meta.url);

export const WINDOWS_FINALIZER_HANDOFF_SCHEMA =
  "tibotattle-windows-finalizer-qualification-handoff-v2";
export const WINDOWS_FINALIZER_HANDOFF_STATUS =
  "WINDOWS_FINALIZER_QUALIFICATION_HANDOFF_PASSED";
export const WINDOWS_ELECTRON_RECEIPT_SCHEMA =
  "tibotattle-windows-electron-development-qualification-v1";
export const WINDOWS_ELECTRON_RECEIPT_STATUS =
  "WINDOWS_ELECTRON_DEVELOPMENT_QUALIFICATION_PASSED";
export const WINDOWS_SECURITY_QUALIFICATION_STATUS =
  "WINDOWS_SECURITY_QUALIFICATION_PASSED";
export const WINDOWS_ELECTRON_RUNTIME_STATUS =
  "WINDOWS_ELECTRON_RUNTIME_SMOKE_PASSED";
export const WINDOWS_FINALIZER_TARGET = "win32-x64";
export const WINDOWS_FINALIZER_WORKFLOW_PATH =
  ".github/workflows/windows-portability.yml";
export const WINDOWS_FINALIZER_EVENT = "workflow_dispatch";
export const WINDOWS_FINALIZER_RUN_STATUS = "completed";
export const WINDOWS_FINALIZER_RUN_CONCLUSION = "success";
export const WINDOWS_FINALIZER_PRODUCTION_READINESS = "not_claimed";
export const WINDOWS_FINALIZER_MODE = "qualification_only";
export const WINDOWS_FINALIZER_EXPECTED_REPOSITORY =
  "adamallcock/tibotattle";
export const WINDOWS_FINALIZER_ARTIFACT_NAME_PREFIX =
  "tibotattle-windows-electron-qualification";

const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const REF_PATTERN = /^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u;
const ARTIFACT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MAXIMUM_INPUT_BYTES = 512 * 1024;
const MAXIMUM_READ_BYTES = MAXIMUM_INPUT_BYTES + 1;
const READ_CHUNK_BYTES = 64 * 1024;
const POSIX_NO_FOLLOW_FLAG = process.platform === "win32"
  ? 0
  : (fsConstants.O_NOFOLLOW ?? 0);
const POSIX_NON_BLOCKING_FLAG = process.platform === "win32"
  ? 0
  : (fsConstants.O_NONBLOCK ?? 0);
const READ_ONLY_FLAGS = fsConstants.O_RDONLY
  | POSIX_NO_FOLLOW_FLAG
  | POSIX_NON_BLOCKING_FLAG;

const RUN_METADATA_KEYS = Object.freeze([
  "conclusion",
  "databaseId",
  "event",
  "headSha",
  "runAttempt",
  "repository",
  "status",
  "workflowPath",
  "ref",
]);
const RAW_RUN_METADATA_KEYS = Object.freeze([
  "conclusion",
  "event",
  "head_sha",
  "id",
  "path",
  "repository",
  "run_attempt",
  "status",
]);
const RAW_RUN_REPOSITORY_KEYS = Object.freeze(["full_name"]);
const ARTIFACT_KEYS = Object.freeze([
  "digest",
  "expired",
  "id",
  "name",
  "size_in_bytes",
  "workflow_run",
]);
const ARTIFACT_WORKFLOW_RUN_KEYS = Object.freeze(["head_sha", "id"]);
const RECEIPT_PROVENANCE_KEYS = Object.freeze(["bytes", "runId", "sha256"]);
const HANDOFF_ARTIFACT_KEYS = Object.freeze([
  "digest",
  "headSha",
  "id",
  "name",
  "runId",
  "sizeInBytes",
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
const RECEIPT_BINDING_KEYS = Object.freeze(["bytes", "sha256"]);
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
const AGGREGATE_KEYS = Object.freeze(["bytes", "count", "sha256"]);
const PACKAGED_BINDING_KEYS = Object.freeze(["bytes", "sha256", "status"]);
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
const RUNTIME_KEYS = Object.freeze(["checks", "status", "target"]);
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
const HANDOFF_KEYS = Object.freeze([
  "productionReadiness",
  "receipts",
  "repository",
  "revision",
  "run",
  "schemaVersion",
  "status",
  "target",
]);
const HANDOFF_RUN_KEYS = Object.freeze([
  "conclusion",
  "databaseId",
  "event",
  "headSha",
  "ref",
  "runAttempt",
  "status",
]);
const HANDOFF_RECEIPT_KEYS = Object.freeze([
  "artifact",
  "binding",
  "cacheMode",
  "qualification",
  "receiptProvenance",
  "runtimeStatus",
  "status",
]);
const HANDOFF_QUALIFICATION_KEYS = Object.freeze([
  "failed",
  "passed",
  "skipped",
  "status",
  "tests",
]);

/** Fixed strings are safe to expose from an offline CI handoff. */
export const FIXED_STATUS = Object.freeze({
  passed: WINDOWS_FINALIZER_HANDOFF_STATUS,
  inputInvalid: "WINDOWS_FINALIZER_HANDOFF_INPUT_INVALID",
  inputMissing: "WINDOWS_FINALIZER_HANDOFF_INPUT_MISSING",
  outputInvalid: "WINDOWS_FINALIZER_HANDOFF_OUTPUT_INVALID",
  runInvalid: "WINDOWS_FINALIZER_HANDOFF_RUN_INVALID",
  repositoryInvalid: "WINDOWS_FINALIZER_HANDOFF_REPOSITORY_INVALID",
  revisionInvalid: "WINDOWS_FINALIZER_HANDOFF_REVISION_INVALID",
  receiptInvalid: "WINDOWS_FINALIZER_HANDOFF_RECEIPT_INVALID",
  bindingInvalid: "WINDOWS_FINALIZER_HANDOFF_BINDING_INVALID",
  cacheModeInvalid: "WINDOWS_FINALIZER_HANDOFF_CACHE_MODE_INVALID",
  duplicateCacheMode: "WINDOWS_FINALIZER_HANDOFF_DUPLICATE_CACHE_MODE",
  duplicateArtifactId: "WINDOWS_FINALIZER_HANDOFF_DUPLICATE_ARTIFACT_ID",
  receiptMismatch: "WINDOWS_FINALIZER_HANDOFF_RECEIPT_MISMATCH",
  artifactInvalid: "WINDOWS_FINALIZER_HANDOFF_ARTIFACT_INVALID",
  artifactMismatch: "WINDOWS_FINALIZER_HANDOFF_ARTIFACT_MISMATCH",
  numericInvalid: "WINDOWS_FINALIZER_HANDOFF_NUMERIC_INVALID",
  contentInvalid: "WINDOWS_FINALIZER_HANDOFF_CONTENT_INVALID",
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

function rejectIfProxy(value, status) {
  if (isProxy(value)) fail(status);
}

/**
 * Snapshot an object without evaluating accessors.  A JSON.parse result is a
 * normal data object; anything else is rejected before a property is read.
 * This also rejects inherited fields, symbols, revoked/hostile proxies, and
 * open schema data.  Returning the descriptor values prevents a later read
 * from reaching a getter on an object that changed after this check.
 */
function snapshotObject(value, keys, status) {
  rejectIfProxy(value, status);
  let ownKeys;
  let prototype;
  let descriptors;
  try {
    ownKeys = Reflect.ownKeys(value);
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(status);
  }
  if (value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || prototype !== Object.prototype
      || ownKeys.length !== keys.length
      || ownKeys.some((key) => typeof key !== "string")
      || keys.some((key) => !ownKeys.includes(key))) {
    fail(status);
  }
  const snapshot = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true) {
      fail(status);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

/**
 * Project the small, safe subset needed from a full GitHub REST object.
 *
 * GitHub returns many additional URLs, timestamps, actor objects, and other
 * fields on workflow runs and artifacts.  Those fields are deliberately not
 * retained in the handoff.  Descriptors are inspected without evaluating any
 * getter, and only the required own data properties are copied; the strict
 * normalized validators below still reject open schemas in their outputs.
 */
function projectObject(value, keys, status) {
  rejectIfProxy(value, status);
  let ownKeys;
  let prototype;
  let descriptors;
  try {
    ownKeys = Reflect.ownKeys(value);
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(status);
  }
  if (value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || prototype !== Object.prototype
      || ownKeys.some((key) => typeof key !== "string")) {
    fail(status);
  }
  const projection = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true) {
      fail(status);
    }
    projection[key] = descriptor.value;
  }
  return projection;
}

function snapshotSubset(value, keys, status) {
  if (value === undefined) return {};
  rejectIfProxy(value, status);
  let ownKeys;
  let prototype;
  let descriptors;
  try {
    ownKeys = Reflect.ownKeys(value);
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(status);
  }
  if (value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || prototype !== Object.prototype
      || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
    fail(status);
  }
  const snapshot = {};
  for (const key of ownKeys) {
    const descriptor = descriptors[key];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true) {
      fail(status);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function snapshotArray(value, length, status) {
  rejectIfProxy(value, status);
  let ownKeys;
  let descriptors;
  let prototype;
  try {
    ownKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    fail(status);
  }
  const expectedKeys = [
    ...Array.from({ length }, (_, index) => String(index)),
    "length",
  ];
  if (!Array.isArray(value)
      || prototype !== Array.prototype
      || ownKeys.length !== expectedKeys.length
      || ownKeys.some((key) => typeof key !== "string")
      || expectedKeys.some((key) => !ownKeys.includes(key))) {
    fail(status);
  }
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, "value")
      || lengthDescriptor.value !== length) {
    fail(status);
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true) {
      fail(status);
    }
    return descriptor.value;
  });
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function assertSafeInteger(value, status, { positive = false } = {}) {
  if (!Number.isSafeInteger(value)
      || Object.is(value, -0)
      || (positive ? value < 1 : value < 0)) {
    fail(status);
  }
  return value;
}

function assertRevision(value, status = FIXED_STATUS.revisionInvalid) {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) fail(status);
  return value.toLowerCase();
}

function assertRef(value, status = FIXED_STATUS.runInvalid) {
  if (typeof value !== "string"
      || !REF_PATTERN.test(value)
      || value.includes("//")
      || value.includes("/./")
      || value.includes("/../")) {
    fail(status);
  }
  return value;
}

function assertSha256(value, status = FIXED_STATUS.bindingInvalid) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(status);
  return value;
}

function assertRepository(value, expected = WINDOWS_FINALIZER_EXPECTED_REPOSITORY) {
  if (typeof expected !== "string"
      || !REPOSITORY_PATTERN.test(expected)
      || typeof value !== "string"
      || !REPOSITORY_PATTERN.test(value)
      || value !== expected) {
    fail(FIXED_STATUS.repositoryInvalid);
  }
  return value;
}

function expectedArtifactName(revision, cacheMode, runId, runAttempt) {
  return `${WINDOWS_FINALIZER_ARTIFACT_NAME_PREFIX}-${runId}-${runAttempt}-${revision}-${cacheMode}.json`;
}

/**
 * Validate the small projection of the GitHub Actions artifact API response
 * needed to bind one receipt to one exact workflow run.  The full artifact
 * archive is deliberately never opened here; its API digest is retained as
 * immutable provenance for the future finalizer.
 */
function validateArtifactProvenance(
  value,
  { cacheMode, receiptProvenance, revision, runAttempt, runId },
) {
  const source = projectObject(value, ARTIFACT_KEYS, FIXED_STATUS.artifactInvalid);
  const workflowRun = projectObject(
    source.workflow_run,
    ARTIFACT_WORKFLOW_RUN_KEYS,
    FIXED_STATUS.artifactInvalid,
  );
  assertSafeInteger(source.id, FIXED_STATUS.numericInvalid, { positive: true });
  assertSafeInteger(source.size_in_bytes, FIXED_STATUS.numericInvalid, { positive: true });
  if (typeof source.name !== "string"
      || typeof source.digest !== "string"
      || !ARTIFACT_DIGEST_PATTERN.test(source.digest)) {
    fail(FIXED_STATUS.artifactInvalid);
  }
  if (source.expired !== false
      || source.size_in_bytes !== receiptProvenance.bytes
      || source.name !== expectedArtifactName(revision, cacheMode, runId, runAttempt)
      || source.digest !== `sha256:${receiptProvenance.sha256}`) {
    fail(FIXED_STATUS.artifactMismatch);
  }
  assertSafeInteger(workflowRun.id, FIXED_STATUS.numericInvalid, { positive: true });
  const artifactRevision = assertRevision(
    workflowRun.head_sha,
    FIXED_STATUS.artifactInvalid,
  );
  if (workflowRun.id !== runId || artifactRevision !== revision) {
    fail(FIXED_STATUS.artifactMismatch);
  }
  return deepFreeze({
    digest: source.digest,
    headSha: artifactRevision,
    id: source.id,
    name: source.name,
    runId: workflowRun.id,
    sizeInBytes: source.size_in_bytes,
  });
}

function validateReceiptProvenance(value, { runId }) {
  const source = snapshotObject(
    value,
    RECEIPT_PROVENANCE_KEYS,
    FIXED_STATUS.artifactInvalid,
  );
  assertSafeInteger(source.bytes, FIXED_STATUS.numericInvalid, { positive: true });
  assertSafeInteger(source.runId, FIXED_STATUS.numericInvalid, { positive: true });
  assertSha256(source.sha256, FIXED_STATUS.artifactInvalid);
  if (source.runId !== runId) fail(FIXED_STATUS.artifactMismatch);
  return deepFreeze({
    bytes: source.bytes,
    runId: source.runId,
    sha256: source.sha256,
  });
}

function validateAggregate(value) {
  const source = snapshotObject(value, AGGREGATE_KEYS, FIXED_STATUS.receiptInvalid);
  assertSafeInteger(source.bytes, FIXED_STATUS.numericInvalid, { positive: true });
  assertSafeInteger(source.count, FIXED_STATUS.numericInvalid);
  assertSha256(source.sha256, FIXED_STATUS.receiptInvalid);
  return Object.freeze({
    bytes: source.bytes,
    count: source.count,
    sha256: source.sha256,
  });
}

function validateReceiptBinding(value, status) {
  const source = snapshotObject(value, RECEIPT_BINDING_KEYS, status);
  assertSafeInteger(source.bytes, FIXED_STATUS.numericInvalid, { positive: true });
  assertSha256(source.sha256, status);
  return Object.freeze({ bytes: source.bytes, sha256: source.sha256 });
}

function validatePackagedBinding(value, expected) {
  const source = snapshotObject(value, PACKAGED_BINDING_KEYS, FIXED_STATUS.receiptInvalid);
  assertSafeInteger(source.bytes, FIXED_STATUS.numericInvalid, { positive: true });
  assertSha256(source.sha256, FIXED_STATUS.receiptInvalid);
  if (source.status !== "included_unverified"
      || source.bytes !== expected.bytes
      || source.sha256 !== expected.sha256) {
    fail(FIXED_STATUS.bindingInvalid);
  }
  return Object.freeze({
    bytes: source.bytes,
    sha256: source.sha256,
    status: source.status,
  });
}

function validatePackaged(value, expectedBinding) {
  const source = snapshotObject(value, PACKAGE_KEYS, FIXED_STATUS.receiptInvalid);
  if (source.status !== "ELECTRON_DEVELOPMENT_ARTIFACT_VERIFIED"
      || source.target !== WINDOWS_FINALIZER_TARGET
      || source.nativeFileCount !== 2) {
    fail(FIXED_STATUS.receiptInvalid);
  }
  assertSafeInteger(source.nativeFileCount, FIXED_STATUS.numericInvalid, { positive: true });
  const binding = validatePackagedBinding(source.binding, expectedBinding);
  return Object.freeze({
    artifact: validateAggregate(source.artifact),
    asar: validateAggregate(source.asar),
    binding,
    nativeFileCount: source.nativeFileCount,
    staged: validateAggregate(source.staged),
    status: source.status,
    target: source.target,
    unpacked: validateAggregate(source.unpacked),
  });
}

function validateQualification(value) {
  const source = snapshotObject(value, QUALIFICATION_KEYS, FIXED_STATUS.receiptInvalid);
  if (source.status !== WINDOWS_SECURITY_QUALIFICATION_STATUS) {
    fail(FIXED_STATUS.receiptInvalid);
  }
  for (const key of QUALIFICATION_KEYS) {
    if (key !== "status") assertSafeInteger(source[key], FIXED_STATUS.numericInvalid);
  }
  if (source.testFileCount < 1
      || source.filesystemTestFileCount < 1
      || source.credentialTestFileCount < 1
      || source.tests < 1
      || source.passed !== source.tests
      || source.failed !== 0
      || source.skipped !== 0) {
    fail(FIXED_STATUS.receiptInvalid);
  }
  return Object.freeze({
    credentialTestFileCount: source.credentialTestFileCount,
    filesystemTestFileCount: source.filesystemTestFileCount,
    failed: source.failed,
    passed: source.passed,
    skipped: source.skipped,
    status: source.status,
    testFileCount: source.testFileCount,
    tests: source.tests,
  });
}

function validateRuntime(value) {
  const source = snapshotObject(value, RUNTIME_KEYS, FIXED_STATUS.receiptInvalid);
  const checks = snapshotObject(
    source.checks,
    RUNTIME_CHECK_KEYS,
    FIXED_STATUS.receiptInvalid,
  );
  if (source.status !== WINDOWS_ELECTRON_RUNTIME_STATUS
      || source.target !== WINDOWS_FINALIZER_TARGET
      || checks.diagnostics !== "content-free"
      || RUNTIME_CHECK_KEYS
        .filter((key) => key !== "diagnostics")
        .some((key) => checks[key] !== true)) {
    fail(FIXED_STATUS.receiptInvalid);
  }
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
    status: source.status,
    target: source.target,
  });
}

/**
 * Validate one exact current Windows Electron development qualification
 * receipt.  The return value is a safe snapshot, not the caller's object.
 */
export function validateWindowsElectronQualificationReceipt(
  value,
  options,
) {
  const selectedOptions = snapshotSubset(
    options,
    ["revision", "expectedCacheMode"],
    FIXED_STATUS.inputInvalid,
  );
  const revision = selectedOptions.revision;
  const expectedCacheMode = selectedOptions.expectedCacheMode ?? null;
  const source = snapshotObject(value, RECEIPT_KEYS, FIXED_STATUS.receiptInvalid);
  if (source.schemaVersion !== WINDOWS_ELECTRON_RECEIPT_SCHEMA
      || source.status !== WINDOWS_ELECTRON_RECEIPT_STATUS
      || source.target !== WINDOWS_FINALIZER_TARGET
      || source.mode !== WINDOWS_FINALIZER_MODE
      || source.productionReadiness !== WINDOWS_FINALIZER_PRODUCTION_READINESS
      || (source.cacheMode !== "warm" && source.cacheMode !== "clean")) {
    fail(FIXED_STATUS.receiptInvalid);
  }
  if (expectedCacheMode !== null && source.cacheMode !== expectedCacheMode) {
    fail(FIXED_STATUS.cacheModeInvalid);
  }
  const selectedRevision = assertRevision(source.revision, FIXED_STATUS.receiptInvalid);
  if (revision !== undefined && selectedRevision !== assertRevision(revision)) {
    fail(FIXED_STATUS.receiptMismatch);
  }
  const binding = validateReceiptBinding(source.binding, FIXED_STATUS.bindingInvalid);
  const packaged = validatePackaged(source.packaged, binding);
  if (packaged.binding.bytes !== binding.bytes || packaged.binding.sha256 !== binding.sha256) {
    fail(FIXED_STATUS.bindingInvalid);
  }
  const qualification = validateQualification(source.qualification);
  const runtime = validateRuntime(source.runtime);
  return deepFreeze({
    binding,
    cacheMode: source.cacheMode,
    mode: source.mode,
    packaged,
    productionReadiness: source.productionReadiness,
    qualification,
    revision: selectedRevision,
    runtime,
    schemaVersion: source.schemaVersion,
    status: source.status,
    target: source.target,
  });
}

function hasOwnKey(value, key, status) {
  rejectIfProxy(value, status);
  if (value === null || typeof value !== "object") fail(status);
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(status);
  }
  return Object.hasOwn(descriptors, key);
}

function normalizeWorkflowPath(path, headBranch, expectedRef, status) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    fail(status);
  }
  const separator = path.indexOf("@");
  const workflowPath = separator < 0 ? path : path.slice(0, separator);
  const pathRef = separator < 0 ? null : path.slice(separator + 1);
  if (workflowPath !== WINDOWS_FINALIZER_WORKFLOW_PATH
      || (separator >= 0 && !pathRef)) {
    fail(status);
  }
  if (pathRef !== null) assertRef(pathRef, status);

  let branchRef = null;
  if (headBranch !== undefined && headBranch !== null) {
    if (typeof headBranch !== "string" || headBranch.length === 0) fail(status);
    branchRef = assertRef(`refs/heads/${headBranch}`, status);
  }
  if (pathRef !== null && branchRef !== null && pathRef !== branchRef) {
    fail(FIXED_STATUS.receiptMismatch);
  }
  const selectedExpectedRef = expectedRef === undefined
    ? null
    : assertRef(expectedRef, FIXED_STATUS.inputInvalid);
  const sourceRef = pathRef ?? branchRef ?? selectedExpectedRef;
  if (sourceRef === null) fail(status);
  if (selectedExpectedRef !== null && sourceRef !== selectedExpectedRef) {
    fail(FIXED_STATUS.receiptMismatch);
  }
  return { workflowPath, ref: sourceRef };
}

function normalizeRawRunMetadata(value, expectedRepository, expectedRevision, expectedRef) {
  const keys = [...RAW_RUN_METADATA_KEYS];
  if (hasOwnKey(value, "head_branch", FIXED_STATUS.runInvalid)) {
    keys.push("head_branch");
  }
  const source = projectObject(value, keys, FIXED_STATUS.runInvalid);
  const repository = projectObject(
    source.repository,
    RAW_RUN_REPOSITORY_KEYS,
    FIXED_STATUS.repositoryInvalid,
  );
  assertRepository(repository.full_name, expectedRepository);
  assertSafeInteger(source.id, FIXED_STATUS.numericInvalid, { positive: true });
  assertSafeInteger(source.run_attempt, FIXED_STATUS.numericInvalid, { positive: true });
  const selectedRevision = assertRevision(source.head_sha, FIXED_STATUS.runInvalid);
  if (expectedRevision !== undefined
      && selectedRevision !== assertRevision(expectedRevision, FIXED_STATUS.runInvalid)) {
    fail(FIXED_STATUS.receiptMismatch);
  }
  if (source.event !== WINDOWS_FINALIZER_EVENT
      || source.status !== WINDOWS_FINALIZER_RUN_STATUS
      || source.conclusion !== WINDOWS_FINALIZER_RUN_CONCLUSION) {
    fail(FIXED_STATUS.runInvalid);
  }
  const path = normalizeWorkflowPath(
    source.path,
    source.head_branch,
    expectedRef,
    FIXED_STATUS.runInvalid,
  );
  return deepFreeze({
    conclusion: source.conclusion,
    databaseId: source.id,
    event: source.event,
    headSha: selectedRevision,
    ref: path.ref,
    repository: repository.full_name,
    runAttempt: source.run_attempt,
    status: source.status,
    workflowPath: path.workflowPath,
  });
}

/**
 * Validate and strictly normalize a narrow GitHub Actions workflow-run
 * response.  The raw form mirrors the selected fields from the REST API
 * (`id`, `head_sha`, `repository.full_name`, and so on); the legacy camelCase
 * projection remains accepted for callers that already performed this exact
 * projection.  Full REST objects are projected without evaluating or
 * retaining unknown URLs, logs, or diagnostic payloads; the normalized output
 * remains strict and content-free.
 */
export function validateWindowsPortabilityRunMetadata(
  value,
  options,
) {
  const selectedOptions = snapshotSubset(
    options,
    ["repository", "revision", "ref"],
    FIXED_STATUS.inputInvalid,
  );
  const repository = selectedOptions.repository ?? WINDOWS_FINALIZER_EXPECTED_REPOSITORY;
  const revision = selectedOptions.revision;
  const expectedRef = selectedOptions.ref;
  if (expectedRef !== undefined) assertRef(expectedRef, FIXED_STATUS.inputInvalid);

  if (hasOwnKey(value, "head_sha", FIXED_STATUS.runInvalid)) {
    return normalizeRawRunMetadata(value, repository, revision, expectedRef);
  }

  const source = snapshotObject(value, RUN_METADATA_KEYS, FIXED_STATUS.runInvalid);
  assertRepository(source.repository, repository);
  const selectedRevision = assertRevision(source.headSha, FIXED_STATUS.runInvalid);
  if (revision !== undefined && selectedRevision !== assertRevision(revision, FIXED_STATUS.runInvalid)) {
    fail(FIXED_STATUS.receiptMismatch);
  }
  assertSafeInteger(source.databaseId, FIXED_STATUS.numericInvalid, { positive: true });
  assertSafeInteger(source.runAttempt, FIXED_STATUS.numericInvalid, { positive: true });
  if (source.event !== WINDOWS_FINALIZER_EVENT
      || source.status !== WINDOWS_FINALIZER_RUN_STATUS
      || source.conclusion !== WINDOWS_FINALIZER_RUN_CONCLUSION) {
    fail(FIXED_STATUS.runInvalid);
  }
  const sourceRef = assertRef(source.ref, FIXED_STATUS.runInvalid);
  const path = normalizeWorkflowPath(
    source.workflowPath.includes("@")
      ? source.workflowPath
      : `${source.workflowPath}@${sourceRef}`,
    null,
    expectedRef ?? sourceRef,
    FIXED_STATUS.runInvalid,
  );
  if (sourceRef !== path.ref) fail(FIXED_STATUS.receiptMismatch);
  return deepFreeze({
    conclusion: source.conclusion,
    databaseId: source.databaseId,
    event: source.event,
    headSha: selectedRevision,
    ref: path.ref,
    repository: source.repository,
    runAttempt: source.runAttempt,
    status: source.status,
    workflowPath: path.workflowPath,
  });
}

function validateExpectedOptions(options) {
  if (options === undefined) fail(FIXED_STATUS.inputMissing);
  const source = snapshotObject(
    options,
    ["repository", "revision", "ref", "runMetadata", "receipts"],
    FIXED_STATUS.inputInvalid,
  );
  const repository = assertRepository(source.repository);
  const revision = assertRevision(source.revision);
  const ref = assertRef(source.ref, FIXED_STATUS.inputInvalid);
  const runMetadata = validateWindowsPortabilityRunMetadata(source.runMetadata, {
    repository,
    revision,
    ref,
  });
  const receiptEntries = snapshotArray(source.receipts, 2, FIXED_STATUS.receiptInvalid)
    .map((entry) => snapshotObject(
      entry,
      ["artifact", "receipt", "receiptProvenance"],
      FIXED_STATUS.receiptInvalid,
    ))
    .map((entry) => {
      const receipt = validateWindowsElectronQualificationReceipt(entry.receipt, { revision });
      const receiptProvenance = validateReceiptProvenance(entry.receiptProvenance, {
        runId: runMetadata.databaseId,
      });
      const artifact = validateArtifactProvenance(entry.artifact, {
        cacheMode: receipt.cacheMode,
        receiptProvenance,
        revision,
        runAttempt: runMetadata.runAttempt,
        runId: runMetadata.databaseId,
      });
      return { artifact, receipt, receiptProvenance };
    });
  const receipts = receiptEntries.map(({ receipt }) => receipt);
  const modes = receipts.map((receipt) => receipt.cacheMode);
  if (modes[0] === modes[1]) fail(FIXED_STATUS.duplicateCacheMode);
  if (!modes.includes("warm") || !modes.includes("clean")) {
    fail(FIXED_STATUS.cacheModeInvalid);
  }
  if (receiptEntries[0].artifact.id === receiptEntries[1].artifact.id) {
    fail(FIXED_STATUS.duplicateArtifactId);
  }
  const [first, second] = receipts;
  if (first.binding.bytes !== second.binding.bytes
      || first.binding.sha256 !== second.binding.sha256) {
    fail(FIXED_STATUS.receiptMismatch);
  }
  return { receiptEntries, repository, revision, ref, runMetadata, receipts };
}

function projectReceipt({ artifact, receipt, receiptProvenance }) {
  return {
    artifact: {
      digest: artifact.digest,
      headSha: artifact.headSha,
      id: artifact.id,
      name: artifact.name,
      runId: artifact.runId,
      sizeInBytes: artifact.sizeInBytes,
    },
    binding: {
      bytes: receipt.binding.bytes,
      sha256: receipt.binding.sha256,
    },
    cacheMode: receipt.cacheMode,
    qualification: {
      failed: receipt.qualification.failed,
      passed: receipt.qualification.passed,
      skipped: receipt.qualification.skipped,
      status: receipt.qualification.status,
      tests: receipt.qualification.tests,
    },
    receiptProvenance: {
      bytes: receiptProvenance.bytes,
      runId: receiptProvenance.runId,
      sha256: receiptProvenance.sha256,
    },
    runtimeStatus: receipt.runtime.status,
    status: receipt.status,
  };
}

/** Build a deep-frozen content-free prerequisite handoff. */
export function buildWindowsFinalizerQualificationHandoff(options) {
  const selected = validateExpectedOptions(options);
  return deepFreeze({
    productionReadiness: WINDOWS_FINALIZER_PRODUCTION_READINESS,
    receipts: selected.receiptEntries.map(projectReceipt),
    repository: selected.repository,
    revision: selected.revision,
    run: {
      conclusion: selected.runMetadata.conclusion,
      databaseId: selected.runMetadata.databaseId,
      event: selected.runMetadata.event,
      headSha: selected.runMetadata.headSha,
      ref: selected.runMetadata.ref,
      runAttempt: selected.runMetadata.runAttempt,
      status: selected.runMetadata.status,
    },
    schemaVersion: WINDOWS_FINALIZER_HANDOFF_SCHEMA,
    status: WINDOWS_FINALIZER_HANDOFF_STATUS,
    target: WINDOWS_FINALIZER_TARGET,
  });
}

/** Validate a previously-built handoff without trusting caller-owned data. */
export function validateWindowsFinalizerQualificationHandoff(value, options) {
  const selectedOptions = snapshotSubset(
    options,
    ["repository", "revision", "ref"],
    FIXED_STATUS.inputInvalid,
  );
  const repository = selectedOptions.repository ?? WINDOWS_FINALIZER_EXPECTED_REPOSITORY;
  const revision = selectedOptions.revision;
  const expectedRef = selectedOptions.ref;
  if (expectedRef !== undefined) assertRef(expectedRef, FIXED_STATUS.inputInvalid);
  const source = snapshotObject(value, HANDOFF_KEYS, FIXED_STATUS.contentInvalid);
  if (source.schemaVersion !== WINDOWS_FINALIZER_HANDOFF_SCHEMA
      || source.status !== WINDOWS_FINALIZER_HANDOFF_STATUS
      || source.target !== WINDOWS_FINALIZER_TARGET
      || source.productionReadiness !== WINDOWS_FINALIZER_PRODUCTION_READINESS) {
    fail(FIXED_STATUS.contentInvalid);
  }
  const selectedRepository = assertRepository(source.repository, repository);
  const selectedRevision = assertRevision(source.revision, FIXED_STATUS.contentInvalid);
  if (revision !== undefined && selectedRevision !== assertRevision(revision, FIXED_STATUS.contentInvalid)) {
    fail(FIXED_STATUS.receiptMismatch);
  }
  const run = snapshotObject(source.run, HANDOFF_RUN_KEYS, FIXED_STATUS.contentInvalid);
  assertSafeInteger(run.databaseId, FIXED_STATUS.numericInvalid, { positive: true });
  assertSafeInteger(run.runAttempt, FIXED_STATUS.numericInvalid, { positive: true });
  const runRef = assertRef(run.ref, FIXED_STATUS.contentInvalid);
  if (expectedRef !== undefined && runRef !== expectedRef) {
    fail(FIXED_STATUS.receiptMismatch);
  }
  if (run.conclusion !== WINDOWS_FINALIZER_RUN_CONCLUSION
      || run.event !== WINDOWS_FINALIZER_EVENT
      || run.status !== WINDOWS_FINALIZER_RUN_STATUS
      || assertRevision(run.headSha, FIXED_STATUS.contentInvalid) !== selectedRevision) {
    fail(FIXED_STATUS.contentInvalid);
  }
  const receiptValues = snapshotArray(source.receipts, 2, FIXED_STATUS.contentInvalid)
    .map((receipt) => snapshotObject(receipt, HANDOFF_RECEIPT_KEYS, FIXED_STATUS.contentInvalid));
  const modes = receiptValues.map((receipt) => receipt.cacheMode);
  if (modes[0] === modes[1]) fail(FIXED_STATUS.duplicateCacheMode);
  if (!modes.includes("warm") || !modes.includes("clean")) fail(FIXED_STATUS.cacheModeInvalid);
  const projected = receiptValues.map((receipt) => ({
    artifact: snapshotObject(
      receipt.artifact,
      HANDOFF_ARTIFACT_KEYS,
      FIXED_STATUS.contentInvalid,
    ),
    binding: validateReceiptBinding(receipt.binding, FIXED_STATUS.contentInvalid),
    cacheMode: receipt.cacheMode,
    qualification: snapshotObject(
      receipt.qualification,
      HANDOFF_QUALIFICATION_KEYS,
      FIXED_STATUS.contentInvalid,
    ),
    receiptProvenance: snapshotObject(
      receipt.receiptProvenance,
      RECEIPT_PROVENANCE_KEYS,
      FIXED_STATUS.contentInvalid,
    ),
    runtimeStatus: receipt.runtimeStatus,
    status: receipt.status,
  }));
  for (const receipt of projected) {
    if ((receipt.cacheMode !== "warm" && receipt.cacheMode !== "clean")
        || receipt.status !== WINDOWS_ELECTRON_RECEIPT_STATUS
        || receipt.runtimeStatus !== WINDOWS_ELECTRON_RUNTIME_STATUS
        || receipt.qualification.status !== WINDOWS_SECURITY_QUALIFICATION_STATUS) {
      fail(FIXED_STATUS.contentInvalid);
    }
    const artifact = receipt.artifact;
    assertSafeInteger(artifact.id, FIXED_STATUS.numericInvalid, { positive: true });
    assertSafeInteger(artifact.runId, FIXED_STATUS.numericInvalid, { positive: true });
    assertRevision(artifact.headSha, FIXED_STATUS.contentInvalid);
    const receiptProvenance = snapshotObject(
      receipt.receiptProvenance,
      RECEIPT_PROVENANCE_KEYS,
      FIXED_STATUS.contentInvalid,
    );
    assertSafeInteger(receiptProvenance.bytes, FIXED_STATUS.numericInvalid, { positive: true });
    assertSafeInteger(receiptProvenance.runId, FIXED_STATUS.numericInvalid, { positive: true });
    assertSha256(receiptProvenance.sha256, FIXED_STATUS.contentInvalid);
    if (typeof artifact.name !== "string"
        || artifact.name !== expectedArtifactName(
          selectedRevision,
          receipt.cacheMode,
          run.databaseId,
          run.runAttempt,
        )
        || typeof artifact.digest !== "string"
        || !ARTIFACT_DIGEST_PATTERN.test(artifact.digest)
        || artifact.digest !== `sha256:${receiptProvenance.sha256}`
        || artifact.headSha !== selectedRevision
        || artifact.runId !== run.databaseId
        || artifact.sizeInBytes !== receiptProvenance.bytes
        || receiptProvenance.runId !== run.databaseId) {
      fail(FIXED_STATUS.artifactMismatch);
    }
    for (const key of ["failed", "passed", "skipped", "tests"]) {
      assertSafeInteger(receipt.qualification[key], FIXED_STATUS.numericInvalid);
    }
    if (receipt.qualification.tests < 1
        || receipt.qualification.passed !== receipt.qualification.tests
        || receipt.qualification.failed !== 0
        || receipt.qualification.skipped !== 0) {
      fail(FIXED_STATUS.contentInvalid);
    }
  }
  if (projected[0].artifact.id === projected[1].artifact.id) {
    fail(FIXED_STATUS.duplicateArtifactId);
  }
  if (projected[0].binding.bytes !== projected[1].binding.bytes
      || projected[0].binding.sha256 !== projected[1].binding.sha256) {
    fail(FIXED_STATUS.receiptMismatch);
  }
  return deepFreeze({
    productionReadiness: source.productionReadiness,
    receipts: projected,
    repository: selectedRepository,
    revision: selectedRevision,
    run: {
      conclusion: run.conclusion,
      databaseId: run.databaseId,
      event: run.event,
      headSha: selectedRevision,
      ref: runRef,
      runAttempt: run.runAttempt,
      status: run.status,
    },
    schemaVersion: source.schemaVersion,
    status: source.status,
    target: source.target,
  });
}

// Short aliases make the pure contract convenient to consume without making
// the more explicit public names above ambiguous.
export const validateRunMetadata = validateWindowsPortabilityRunMetadata;
export const validateQualificationReceipt = validateWindowsElectronQualificationReceipt;
export const buildFinalizerQualificationHandoff = buildWindowsFinalizerQualificationHandoff;

function readJson(text, status) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAXIMUM_INPUT_BYTES) {
    fail(status);
  }
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail(status);
    return value;
  } catch (error) {
    if (KNOWN_STATUSES.has(error?.code)) throw error;
    fail(status);
  }
}

function sameFileIdentity(left, right) {
  return left.isFile()
    && right.isFile()
    && !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs;
}

async function readBoundedFile(path, status) {
  let handle;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()
        || metadata.isSymbolicLink()
        || metadata.size > MAXIMUM_INPUT_BYTES) {
      fail(status);
    }
    handle = await open(path, READ_ONLY_FLAGS);
    const opened = await handle.stat();
    if (!sameFileIdentity(metadata, opened)
        || opened.size !== metadata.size
        || opened.size > MAXIMUM_INPUT_BYTES) {
      fail(status);
    }
    // On platforms without O_NOFOLLOW, this second path identity check closes
    // the open-versus-lstat race for a symlink or replacement regular file.
    // Reads thereafter use the already-open handle, never the path.
    const afterOpen = await lstat(path);
    if (!sameFileIdentity(metadata, afterOpen)
        || !sameFileIdentity(opened, afterOpen)
        || afterOpen.size !== opened.size) {
      fail(status);
    }

    const chunks = [];
    let totalBytes = 0;
    while (totalBytes < MAXIMUM_READ_BYTES) {
      const chunkBytes = Math.min(READ_CHUNK_BYTES, MAXIMUM_READ_BYTES - totalBytes);
      const chunk = Buffer.allocUnsafe(chunkBytes);
      const result = await handle.read(chunk, 0, chunkBytes, null);
      if (!Number.isSafeInteger(result.bytesRead)
          || result.bytesRead < 0
          || result.bytesRead > chunkBytes) {
        fail(status);
      }
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      totalBytes += result.bytesRead;
      if (totalBytes > MAXIMUM_INPUT_BYTES) fail(status);
    }

    const finished = await handle.stat();
    if (!sameFileIdentity(opened, finished)
        || finished.size !== totalBytes
        || finished.size > MAXIMUM_INPUT_BYTES) {
      fail(status);
    }
    return Buffer.concat(chunks, totalBytes);
  } catch (error) {
    if (KNOWN_STATUSES.has(error?.code)) throw error;
    fail(status);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The bounded bytes and fixed validation result are already settled;
        // never expose a platform-specific close error to the caller.
      }
    }
  }
}

async function readJsonFile(path, status, { parse = true } = {}) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    fail(FIXED_STATUS.inputInvalid);
  }
  const bytes = await readBoundedFile(path, status);
  const provenance = Object.freeze({
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  if (!parse) {
    return Object.freeze({
      ...provenance,
      text: bytes.toString("utf8"),
    });
  }
  return readJson(bytes.toString("utf8"), status);
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) fail(FIXED_STATUS.inputInvalid);
  const values = {
    output: null,
    repository: null,
    revision: null,
    ref: null,
    runMetadata: null,
    warmReceipt: null,
    cleanReceipt: null,
    warmArtifact: null,
    cleanArtifact: null,
  };
  const fields = new Map([
    ["--output", "output"],
    ["--repository", "repository"],
    ["--revision", "revision"],
    ["--ref", "ref"],
    ["--run-metadata", "runMetadata"],
    ["--warm-receipt", "warmReceipt"],
    ["--clean-receipt", "cleanReceipt"],
    ["--warm-artifact", "warmArtifact"],
    ["--clean-artifact", "cleanArtifact"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const field = fields.get(argv[index]);
    if (!field || values[field] !== null) fail(FIXED_STATUS.inputInvalid);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      fail(FIXED_STATUS.inputInvalid);
    }
    values[field] = value;
    index += 1;
  }
  if (Object.values(values).some((value) => value === null)) fail(FIXED_STATUS.inputMissing);
  return Object.freeze(values);
}

export { parseArguments };

export async function main(argv = process.argv.slice(2)) {
  try {
    const argumentsValue = parseArguments(argv);
    const [runMetadata, warmArtifact, cleanArtifact] = await Promise.all([
      readJsonFile(argumentsValue.runMetadata, FIXED_STATUS.runInvalid),
      readJsonFile(argumentsValue.warmArtifact, FIXED_STATUS.artifactInvalid),
      readJsonFile(argumentsValue.cleanArtifact, FIXED_STATUS.artifactInvalid),
    ]);
    const normalizedRun = validateWindowsPortabilityRunMetadata(runMetadata, {
      repository: argumentsValue.repository,
      revision: argumentsValue.revision,
      ref: argumentsValue.ref,
    });
    const readReceiptAfterArtifactDigest = async (path, artifact, cacheMode) => {
      const raw = await readJsonFile(path, FIXED_STATUS.receiptInvalid, { parse: false });
      const receiptProvenance = {
        bytes: raw.bytes,
        runId: normalizedRun.databaseId,
        sha256: raw.sha256,
      };
      // The artifact API digest is compared with the exact bytes on disk
      // before JSON.parse is allowed to inspect the receipt payload.
      validateArtifactProvenance(artifact, {
        cacheMode,
        receiptProvenance,
        revision: argumentsValue.revision,
        runAttempt: normalizedRun.runAttempt,
        runId: normalizedRun.databaseId,
      });
      return {
        artifact,
        receipt: readJson(raw.text, FIXED_STATUS.receiptInvalid),
        receiptProvenance,
      };
    };
    const [warmReceipt, cleanReceipt] = await Promise.all([
      readReceiptAfterArtifactDigest(argumentsValue.warmReceipt, warmArtifact, "warm"),
      readReceiptAfterArtifactDigest(argumentsValue.cleanReceipt, cleanArtifact, "clean"),
    ]);
    const handoff = buildWindowsFinalizerQualificationHandoff({
      repository: argumentsValue.repository,
      revision: argumentsValue.revision,
      ref: argumentsValue.ref,
      runMetadata,
      receipts: [warmReceipt, cleanReceipt],
    });
    const outputPath = resolve(argumentsValue.output);
    try {
      await writeFile(outputPath, `${JSON.stringify(handoff, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      fail(FIXED_STATUS.outputInvalid);
    }
    process.stdout.write(`${JSON.stringify({
      cacheModes: handoff.receipts.map((receipt) => receipt.cacheMode).sort(),
      revision: handoff.revision,
      status: handoff.status,
      target: handoff.target,
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
