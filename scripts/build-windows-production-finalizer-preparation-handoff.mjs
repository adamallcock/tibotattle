#!/usr/bin/env node

/**
 * Build and verify the content-free boundary between the unsigned Windows
 * preparation job and the protected signing job.
 *
 * The preparation job is allowed to see the checkout and the staged app.  It
 * emits only this closed manifest: source identities, bounded byte counts and
 * SHA-256 values, and a deterministic staged-tree digest.  The signing job
 * receives the manifest (and its digest) as job output and must re-capture the
 * exact staged tree before any Azure login or signing operation.
 *
 * This module never serializes file contents, paths outside the fixed
 * relative namespace, credentials, tokens, logs, or provider responses.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { isProxy } from "node:util/types";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256,
  WINDOWS_NATIVE_PRESIGN_MODULES,
} from "./windows-native-presign.mjs";
import {
  validateWindowsFinalizerQualificationHandoff,
} from "./verify-windows-finalizer-qualification-handoff.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");

export const WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_SCHEMA =
  "tibotattle-windows-production-finalizer-preparation-handoff-v1";
export const WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_STATUS =
  "WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_BUILT";
export const WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_TARGET =
  "win32-x64";
export const WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_REPOSITORY =
  "adamallcock/tibotattle";
export const WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_REF =
  "refs/heads/main";
export const WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_WORKFLOW =
  ".github/workflows/windows-portability.yml";
export const WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_PREPARATION_WORKFLOW =
  ".github/workflows/windows-production-finalizer-signed.yml";
export const WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_PACKAGE_PATH =
  "package.json";
export const WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_LOCKFILE_PATH =
  "pnpm-lock.yaml";
export const WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_BINDING_PATH =
  WINDOWS_NATIVE_PRESIGN_MODULES[0].packagedPath;
export const WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_KEYTAR_PATH =
  WINDOWS_NATIVE_PRESIGN_MODULES[1].packagedPath;

export const WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_FIXED_STATUS =
  Object.freeze({
    passed: WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_STATUS,
    inputInvalid: "WINDOWS_PRODUCTION_FINALIZER_PREPARATION_INPUT_INVALID",
    inputMissing: "WINDOWS_PRODUCTION_FINALIZER_PREPARATION_INPUT_MISSING",
    jsonInvalid: "WINDOWS_PRODUCTION_FINALIZER_PREPARATION_JSON_INVALID",
    noncanonical: "WINDOWS_PRODUCTION_FINALIZER_PREPARATION_NONCANONICAL",
    duplicateJsonKey: "WINDOWS_PRODUCTION_FINALIZER_PREPARATION_DUPLICATE_JSON_KEY",
    pathInvalid: "WINDOWS_PRODUCTION_FINALIZER_PREPARATION_PATH_INVALID",
    sourceInvalid: "WINDOWS_PRODUCTION_FINALIZER_PREPARATION_SOURCE_INVALID",
    qualificationInvalid: "WINDOWS_PRODUCTION_FINALIZER_PREPARATION_QUALIFICATION_INVALID",
    packageInvalid: "WINDOWS_PRODUCTION_FINALIZER_PREPARATION_PACKAGE_INVALID",
    lockfileInvalid: "WINDOWS_PRODUCTION_FINALIZER_PREPARATION_LOCKFILE_INVALID",
    stagedInvalid: "WINDOWS_PRODUCTION_FINALIZER_PREPARATION_STAGED_INVALID",
    nativeInvalid: "WINDOWS_PRODUCTION_FINALIZER_PREPARATION_NATIVE_INVALID",
    workflowInvalid: "WINDOWS_PRODUCTION_FINALIZER_PREPARATION_WORKFLOW_INVALID",
    mismatch: "WINDOWS_PRODUCTION_FINALIZER_PREPARATION_MISMATCH",
    stale: "WINDOWS_PRODUCTION_FINALIZER_PREPARATION_STALE",
    tampered: "WINDOWS_PRODUCTION_FINALIZER_PREPARATION_TAMPERED",
    oversized: "WINDOWS_PRODUCTION_FINALIZER_PREPARATION_OVERSIZED",
    outputInvalid: "WINDOWS_PRODUCTION_FINALIZER_PREPARATION_OUTPUT_INVALID",
    outputExists: "WINDOWS_PRODUCTION_FINALIZER_PREPARATION_OUTPUT_EXISTS",
  });
export const FIXED_STATUS =
  WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_FIXED_STATUS;

export const WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_MANIFEST_BYTES =
  256 * 1024;
export const WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_BASE64_BYTES =
  384 * 1024;
export const WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_FILE_BYTES =
  128 * 1024 * 1024;
export const WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_TREE_BYTES =
  512 * 1024 * 1024;
export const WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_FILES =
  20_000;
export const WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_PATH_BYTES =
  4_096;
export const WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_INPUT_BYTES =
  512 * 1024;

const MAXIMUM_JSON_DEPTH = 64;
const MAXIMUM_JSON_NODES = 4096;
const READ_CHUNK_BYTES = 64 * 1024;
// Node does not expose a portable Windows no-follow open flag. The handle and
// lstat identity checks close replacement/in-place drift for ordinary files;
// native Windows reparse-point qualification remains a separate gate.
const READ_ONLY_FLAGS = fsConstants.O_RDONLY
  | (process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0));
const STAT_OPTIONS = Object.freeze({ bigint: process.platform === "win32" });

const TARGET = WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_TARGET;
const REPOSITORY = WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_REPOSITORY;
const REF = WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_REF;
const SOURCE_WORKFLOW = WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_WORKFLOW;
const PREPARATION_WORKFLOW =
  WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_PREPARATION_WORKFLOW;
const PACKAGE_PATH = WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_PACKAGE_PATH;
const LOCKFILE_PATH = WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_LOCKFILE_PATH;
const BINDING_PATH = WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_BINDING_PATH;
const KEYTAR_PATH = WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_KEYTAR_PATH;
const QUALIFICATION_STATUS = "passed";
const SEMVER_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]{0,19}$/u;
const SAFE_PATH_SEGMENT_PATTERN = /^[^\u0000-\u001f\u007f]+$/u;
const SENSITIVE_PATH_PATTERN = /(?:^|[._-])(?:token|secret|credential|credentials|password|passwd|cookie|authorization|access[-_]?key|private[-_]?key)(?:$|[._-])/iu;
const RAW_LOG_PATH_PATTERN = /(?:\.log(?:\.[^/]*)?|\.log[0-9]*|\.jsonl|\.ndjson)$/iu;
const MANIFEST_KEYS = Object.freeze([
  "lockfile",
  "native",
  "package",
  "qualification",
  "repository",
  "schemaVersion",
  "source",
  "staged",
  "status",
  "target",
  "workflow",
]);
const SOURCE_KEYS = Object.freeze(["ref", "revision"]);
const QUALIFICATION_KEYS = Object.freeze([
  "binding",
  "receipts",
  "revision",
  "run",
  "runAttempt",
  "status",
  "workflow",
]);
const QUALIFICATION_RECEIPTS_KEYS = Object.freeze(["clean", "warm"]);
const QUALIFICATION_RECEIPT_KEYS = Object.freeze(["bytes", "sha256"]);
const PACKAGE_KEYS = Object.freeze(["bytes", "name", "path", "sha256", "version"]);
const FILE_KEYS = Object.freeze(["bytes", "path", "sha256"]);
const STAGED_KEYS = Object.freeze(["files", "tree"]);
const TREE_KEYS = Object.freeze(["bytes", "count", "sha256"]);
const NATIVE_KEYS = Object.freeze(["filesystemBinding", "keytar"]);
const WORKFLOW_KEYS = Object.freeze(["path", "ref", "revision", "run", "runAttempt"]);
const BUILD_INPUT_KEYS = Object.freeze([
  "lockfile",
  "native",
  "package",
  "qualification",
  "source",
  "staged",
  "workflow",
]);
const VERIFY_OPTIONS_KEYS = Object.freeze([
  "expected",
  "lockfileBytes",
  "packageJsonBytes",
  "stagedRoot",
]);
const EXPECTED_KEYS = Object.freeze([
  "packageVersion",
  "qualificationRun",
  "qualificationRunAttempt",
  "revision",
  "sourceRef",
  "sourceRunId",
  "sourceRunAttempt",
  "workflowRun",
  "workflowRunAttempt",
]);
const CLI_FIELDS = Object.freeze(new Map([
  ["--output", "output"],
  ["--source-handoff", "sourceHandoff"],
  ["--qualification-proof", "qualificationProof"],
  ["--staging-root", "stagingRoot"],
  ["--source-revision", "sourceRevision"],
  ["--source-ref", "sourceRef"],
  ["--source-run-id", "sourceRunId"],
  ["--source-run-attempt", "sourceRunAttempt"],
  ["--workflow-run-id", "workflowRunId"],
  ["--workflow-run-attempt", "workflowRunAttempt"],
  ["--manifest", "manifest"],
  ["--manifest-base64", "manifestBase64"],
  ["--expected-sha256", "expectedSha256"],
  ["--verify", "verify"],
  ["--package-json", "packageJson"],
  ["--lockfile", "lockfile"],
]));
const KNOWN_STATUSES = new Set(Object.values(FIXED_STATUS));

export class WindowsProductionFinalizerPreparationHandoffError extends Error {
  constructor(code) {
    super("Windows production finalizer preparation handoff failed");
    this.name = "WindowsProductionFinalizerPreparationHandoffError";
    this.code = code;
  }
}

function fail(code) {
  throw new WindowsProductionFinalizerPreparationHandoffError(code);
}

function rejectProxy(value, code = FIXED_STATUS.inputInvalid) {
  try {
    if (isProxy(value)) fail(code);
  } catch {
    fail(code);
  }
}

function snapshotRecord(value, keys, code = FIXED_STATUS.inputInvalid) {
  rejectProxy(value, code);
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  let prototype;
  let ownKeys;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(code);
  }
  const expected = new Set(keys);
  if (prototype !== Object.prototype
      || ownKeys.length !== keys.length
      || ownKeys.some((key) => typeof key !== "string" || !expected.has(key))) {
    fail(code);
  }
  const selected = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.get !== undefined
        || descriptor.set !== undefined
        || descriptor.enumerable !== true) {
      fail(code);
    }
    selected[key] = descriptor.value;
  }
  return selected;
}

function snapshotOptionalRecord(value, keys, code = FIXED_STATUS.inputInvalid) {
  rejectProxy(value, code);
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  let prototype;
  let ownKeys;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(code);
  }
  const expected = new Set(keys);
  if (prototype !== Object.prototype
      || ownKeys.some((key) => typeof key !== "string" || !expected.has(key))) {
    fail(code);
  }
  const selected = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined) {
      selected[key] = undefined;
      continue;
    }
    if (!Object.hasOwn(descriptor, "value")
        || descriptor.get !== undefined
        || descriptor.set !== undefined
        || descriptor.enumerable !== true) fail(code);
    selected[key] = descriptor.value;
  }
  return selected;
}

function snapshotArray(value, code = FIXED_STATUS.inputInvalid) {
  rejectProxy(value, code);
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(code);
  let ownKeys;
  let descriptors;
  try {
    ownKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(code);
  }
  if (ownKeys.length !== value.length + 1
      || ownKeys.some((key) => key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key))) {
    fail(code);
  }
  const output = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
        || descriptor.get !== undefined
        || descriptor.set !== undefined) fail(code);
    output.push(descriptor.value);
  }
  return output;
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
      .map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function assertString(value, code, { pattern, exact, max = 4096 } = {}) {
  if (typeof value !== "string"
      || value.length === 0
      || value.length > max
      || value.includes("\0")
      || (pattern && !pattern.test(value))
      || (exact !== undefined && value !== exact)) {
    fail(code);
  }
  return value;
}

function assertRevision(value, code = FIXED_STATUS.sourceInvalid) {
  return assertString(value, code, { pattern: REVISION_PATTERN, max: 40 });
}

function assertPositiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0 || Object.is(value, -0)) fail(code);
  return value;
}

function assertDigest(value, code) {
  return assertString(value, code, { pattern: SHA256_PATTERN, max: 64 });
}

function assertBoundedBytes(value, code, maximum = WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_FILE_BYTES) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) fail(code);
  return value;
}

function assertRelativePath(value, code = FIXED_STATUS.pathInvalid) {
  assertString(value, code, { max: WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_PATH_BYTES });
  if (isAbsolute(value)
      || value.startsWith("/")
      || value.startsWith("\\")
      || /^[A-Za-z]:/u.test(value)
      || value.includes("\\")
      || value.includes("//")
      || value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
      || !SAFE_PATH_SEGMENT_PATTERN.test(value)
      || SENSITIVE_PATH_PATTERN.test(value)
      || RAW_LOG_PATH_PATTERN.test(value)) {
    fail(code);
  }
  return value;
}

function assertFixedRepositoryPath(value, relativePath, code) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    fail(code);
  }
  const expected = resolve(REPOSITORY_ROOT, relativePath);
  const selected = process.platform === "win32" ? value.toLowerCase() : value;
  const normalizedExpected = process.platform === "win32" ? expected.toLowerCase() : expected;
  if (selected !== normalizedExpected) fail(code);
  return value;
}

function assertFileDigest(value, code, expectedPath) {
  const source = snapshotRecord(value, FILE_KEYS, code);
  const path = assertRelativePath(source.path, code);
  if (expectedPath !== undefined && path !== expectedPath) fail(code);
  return Object.freeze({
    bytes: assertBoundedBytes(source.bytes, code),
    path,
    sha256: assertDigest(source.sha256, code),
  });
}

function assertQualificationReceipt(value, code) {
  const source = snapshotRecord(value, QUALIFICATION_RECEIPT_KEYS, code);
  return Object.freeze({
    bytes: assertBoundedBytes(
      source.bytes,
      code,
      WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_INPUT_BYTES,
    ),
    sha256: assertDigest(source.sha256, code),
  });
}

function assertQualification(value) {
  const source = snapshotRecord(value, QUALIFICATION_KEYS, FIXED_STATUS.qualificationInvalid);
  const binding = assertFileDigest(
    source.binding,
    FIXED_STATUS.qualificationInvalid,
    BINDING_PATH,
  );
  const receipts = snapshotRecord(
    source.receipts,
    QUALIFICATION_RECEIPTS_KEYS,
    FIXED_STATUS.qualificationInvalid,
  );
  const selectedReceipts = {
    clean: assertQualificationReceipt(receipts.clean, FIXED_STATUS.qualificationInvalid),
    warm: assertQualificationReceipt(receipts.warm, FIXED_STATUS.qualificationInvalid),
  };
  if (selectedReceipts.clean.bytes === selectedReceipts.warm.bytes
      && selectedReceipts.clean.sha256 === selectedReceipts.warm.sha256) {
    fail(FIXED_STATUS.mismatch);
  }
  return Object.freeze({
    binding,
    receipts: Object.freeze(selectedReceipts),
    revision: assertRevision(source.revision, FIXED_STATUS.qualificationInvalid),
    run: assertPositiveInteger(source.run, FIXED_STATUS.qualificationInvalid),
    runAttempt: assertPositiveInteger(source.runAttempt, FIXED_STATUS.qualificationInvalid),
    status: assertString(source.status, FIXED_STATUS.qualificationInvalid, {
      exact: QUALIFICATION_STATUS,
      max: QUALIFICATION_STATUS.length,
    }),
    workflow: assertString(source.workflow, FIXED_STATUS.qualificationInvalid, {
      exact: SOURCE_WORKFLOW,
      max: SOURCE_WORKFLOW.length,
    }),
  });
}

function qualificationFromSourceHandoff(value, sourceRevision, sourceRef, sourceRunId) {
  let handoff;
  try {
    handoff = validateWindowsFinalizerQualificationHandoff(value, {
      repository: REPOSITORY,
      revision: sourceRevision,
      ref: sourceRef,
    });
  } catch {
    fail(FIXED_STATUS.qualificationInvalid);
  }
  if (handoff.run.databaseId !== sourceRunId
      || handoff.run.headSha !== sourceRevision
      || handoff.run.ref !== sourceRef) {
    fail(FIXED_STATUS.stale);
  }
  const byMode = new Map(handoff.receipts.map((receipt) => [receipt.cacheMode, receipt]));
  const warm = byMode.get("warm");
  const clean = byMode.get("clean");
  if (!warm || !clean) fail(FIXED_STATUS.qualificationInvalid);
  if (warm.binding.bytes !== clean.binding.bytes || warm.binding.sha256 !== clean.binding.sha256) {
    fail(FIXED_STATUS.mismatch);
  }
  return {
    binding: {
      bytes: warm.binding.bytes,
      path: BINDING_PATH,
      sha256: warm.binding.sha256,
    },
    receipts: {
      clean: { bytes: clean.receiptProvenance.bytes, sha256: clean.receiptProvenance.sha256 },
      warm: { bytes: warm.receiptProvenance.bytes, sha256: warm.receiptProvenance.sha256 },
    },
    revision: handoff.revision,
    run: handoff.run.databaseId,
    runAttempt: handoff.run.runAttempt,
    status: QUALIFICATION_STATUS,
    workflow: SOURCE_WORKFLOW,
  };
}

function assertPackage(value) {
  const source = snapshotRecord(value, PACKAGE_KEYS, FIXED_STATUS.packageInvalid);
  return Object.freeze({
    bytes: assertBoundedBytes(
      source.bytes,
      FIXED_STATUS.packageInvalid,
      WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_INPUT_BYTES,
    ),
    name: assertString(source.name, FIXED_STATUS.packageInvalid, {
      exact: "app-usagemonitor",
      max: 64,
    }),
    path: assertString(source.path, FIXED_STATUS.packageInvalid, {
      exact: PACKAGE_PATH,
      max: PACKAGE_PATH.length,
    }),
    sha256: assertDigest(source.sha256, FIXED_STATUS.packageInvalid),
    version: assertString(source.version, FIXED_STATUS.packageInvalid, {
      pattern: SEMVER_PATTERN,
      max: 32,
    }),
  });
}

function assertLockfile(value) {
  const row = assertFileDigest(value, FIXED_STATUS.lockfileInvalid, LOCKFILE_PATH);
  if (row.bytes > WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_INPUT_BYTES) {
    fail(FIXED_STATUS.oversized);
  }
  return row;
}

function compareRows(left, right) {
  return Buffer.from(left.path, "utf8").compare(Buffer.from(right.path, "utf8"));
}

function treeDigest(files) {
  const lines = files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}\n`).join("");
  return createHash("sha256").update(lines, "utf8").digest("hex");
}

function assertStaged(value) {
  const source = snapshotRecord(value, STAGED_KEYS, FIXED_STATUS.stagedInvalid);
  const rows = snapshotArray(source.files, FIXED_STATUS.stagedInvalid)
    .map((row) => assertFileDigest(row, FIXED_STATUS.stagedInvalid));
  if (rows.length === 0 || rows.length > WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_FILES) {
    fail(FIXED_STATUS.oversized);
  }
  const sorted = [...rows].sort(compareRows);
  if (rows.some((row, index) => row !== sorted[index])) fail(FIXED_STATUS.stagedInvalid);
  const paths = new Set(rows.map((row) => row.path));
  if (paths.size !== rows.length) fail(FIXED_STATUS.stagedInvalid);
  const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
  if (!Number.isSafeInteger(totalBytes)
      || totalBytes > WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_TREE_BYTES) {
    fail(FIXED_STATUS.oversized);
  }
  const tree = snapshotRecord(source.tree, TREE_KEYS, FIXED_STATUS.stagedInvalid);
  if (tree.count !== rows.length
      || tree.bytes !== totalBytes
      || tree.sha256 !== treeDigest(rows)) {
    fail(FIXED_STATUS.stagedInvalid);
  }
  return Object.freeze({
    files: Object.freeze(rows),
    tree: Object.freeze({
      bytes: totalBytes,
      count: rows.length,
      sha256: assertDigest(tree.sha256, FIXED_STATUS.stagedInvalid),
    }),
  });
}

function assertNative(value, staged) {
  const source = snapshotRecord(value, NATIVE_KEYS, FIXED_STATUS.nativeInvalid);
  const filesystemBinding = assertFileDigest(
    source.filesystemBinding,
    FIXED_STATUS.nativeInvalid,
    BINDING_PATH,
  );
  const keytar = assertFileDigest(source.keytar, FIXED_STATUS.nativeInvalid, KEYTAR_PATH);
  if (keytar.sha256 !== WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256) fail(FIXED_STATUS.nativeInvalid);
  const rows = new Map(staged.files.map((row) => [row.path, row]));
  const stagedBinding = rows.get(BINDING_PATH);
  const stagedKeytar = rows.get(KEYTAR_PATH);
  if (!stagedBinding
      || !stagedKeytar
      || stagedBinding.bytes !== filesystemBinding.bytes
      || stagedBinding.sha256 !== filesystemBinding.sha256
      || stagedKeytar.bytes !== keytar.bytes
      || stagedKeytar.sha256 !== keytar.sha256) {
    fail(FIXED_STATUS.mismatch);
  }
  return Object.freeze({ filesystemBinding, keytar });
}

function assertSource(value) {
  const source = snapshotRecord(value, SOURCE_KEYS, FIXED_STATUS.sourceInvalid);
  return Object.freeze({
    ref: assertString(source.ref, FIXED_STATUS.sourceInvalid, { exact: REF, max: REF.length }),
    revision: assertRevision(source.revision),
  });
}

function assertWorkflow(value) {
  const source = snapshotRecord(value, WORKFLOW_KEYS, FIXED_STATUS.workflowInvalid);
  return Object.freeze({
    path: assertString(source.path, FIXED_STATUS.workflowInvalid, {
      exact: PREPARATION_WORKFLOW,
      max: PREPARATION_WORKFLOW.length,
    }),
    ref: assertString(source.ref, FIXED_STATUS.workflowInvalid, { exact: REF, max: REF.length }),
    revision: assertRevision(source.revision, FIXED_STATUS.workflowInvalid),
    run: assertPositiveInteger(source.run, FIXED_STATUS.workflowInvalid),
    runAttempt: assertPositiveInteger(source.runAttempt, FIXED_STATUS.workflowInvalid),
  });
}

function assertManifest(value) {
  const source = snapshotRecord(value, MANIFEST_KEYS, FIXED_STATUS.inputInvalid);
  const selectedSource = assertSource(source.source);
  const selectedQualification = assertQualification(source.qualification);
  const selectedPackage = assertPackage(source.package);
  const selectedLockfile = assertLockfile(source.lockfile);
  const selectedStaged = assertStaged(source.staged);
  const selectedNative = assertNative(source.native, selectedStaged);
  const selectedWorkflow = assertWorkflow(source.workflow);
  if (source.schemaVersion !== WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_SCHEMA
      || source.status !== WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_STATUS
      || source.target !== TARGET
      || source.repository !== REPOSITORY) {
    fail(FIXED_STATUS.inputInvalid);
  }
  if (selectedQualification.revision !== selectedSource.revision
      || selectedQualification.binding.bytes !== selectedNative.filesystemBinding.bytes
      || selectedQualification.binding.sha256 !== selectedNative.filesystemBinding.sha256
      || selectedWorkflow.revision !== selectedSource.revision
      || selectedWorkflow.ref !== selectedSource.ref
      || selectedQualification.workflow !== SOURCE_WORKFLOW) {
    fail(FIXED_STATUS.mismatch);
  }
  return deepFreeze({
    lockfile: selectedLockfile,
    native: selectedNative,
    package: selectedPackage,
    qualification: selectedQualification,
    repository: REPOSITORY,
    schemaVersion: WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_SCHEMA,
    source: selectedSource,
    staged: selectedStaged,
    status: WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_STATUS,
    target: TARGET,
    workflow: selectedWorkflow,
  });
}

function assertBuildInput(value) {
  const source = snapshotRecord(value, BUILD_INPUT_KEYS, FIXED_STATUS.inputInvalid);
  const selectedSource = assertSource(source.source);
  const selectedQualification = assertQualification(source.qualification);
  const selectedPackage = assertPackage(source.package);
  const selectedLockfile = assertLockfile(source.lockfile);
  const stagedInput = snapshotRecord(source.staged, ["files"], FIXED_STATUS.stagedInvalid);
  const rows = snapshotArray(stagedInput.files, FIXED_STATUS.stagedInvalid)
    .map((row) => assertFileDigest(row, FIXED_STATUS.stagedInvalid));
  const selectedStaged = assertStaged({
    files: rows,
    tree: {
      bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
      count: rows.length,
      sha256: treeDigest(rows),
    },
  });
  const selectedNative = assertNative(source.native, selectedStaged);
  const selectedWorkflow = assertWorkflow(source.workflow);
  if (selectedQualification.revision !== selectedSource.revision
      || selectedQualification.binding.bytes !== selectedNative.filesystemBinding.bytes
      || selectedQualification.binding.sha256 !== selectedNative.filesystemBinding.sha256
      || selectedWorkflow.revision !== selectedSource.revision
      || selectedWorkflow.ref !== selectedSource.ref
      || selectedQualification.workflow !== SOURCE_WORKFLOW) {
    fail(FIXED_STATUS.mismatch);
  }
  return Object.freeze({
    lockfile: selectedLockfile,
    native: selectedNative,
    package: selectedPackage,
    qualification: selectedQualification,
    source: selectedSource,
    staged: selectedStaged,
    workflow: selectedWorkflow,
  });
}

export function validateWindowsProductionFinalizerPreparationHandoff(value) {
  return assertManifest(value);
}

export function buildWindowsProductionFinalizerPreparationHandoff(value) {
  const selected = assertBuildInput(value);
  return assertManifest({
    ...selected,
    schemaVersion: WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_SCHEMA,
    status: WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_STATUS,
    target: TARGET,
    repository: REPOSITORY,
  });
}

export function serializeWindowsProductionFinalizerPreparationHandoff(value) {
  const selected = assertManifest(value);
  const serialized = stableJson(selected);
  if (Buffer.byteLength(serialized, "utf8") > WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_MANIFEST_BYTES) {
    fail(FIXED_STATUS.oversized);
  }
  return serialized;
}

function bytesFromInput(value, code = FIXED_STATUS.jsonInvalid, maximum = WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_MANIFEST_BYTES) {
  if (!Buffer.isBuffer(value) && typeof value !== "string") fail(code);
  const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
  if (bytes.length === 0 || bytes.length > maximum) fail(FIXED_STATUS.oversized);
  return bytes;
}

function scanJsonSyntax(text, invalidCode, duplicateCode) {
  if (typeof text !== "string" || text.length === 0) fail(invalidCode);
  let index = 0;
  let nodes = 0;
  const whitespace = () => {
    while (index < text.length && /[\t\n\r ]/u.test(text[index])) index += 1;
  };
  const parseString = () => {
    const start = index;
    if (text[index] !== '"') fail(invalidCode);
    index += 1;
    while (index < text.length) {
      const current = text[index];
      if (current === "\\") {
        index += 1;
        if (index >= text.length) fail(invalidCode);
        index += text[index] === "u" ? 5 : 1;
        continue;
      }
      if (current < " ") fail(invalidCode);
      index += 1;
      if (current === '"') {
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          fail(invalidCode);
        }
      }
    }
    fail(invalidCode);
  };
  const parseValue = (depth = 0) => {
    nodes += 1;
    if (depth > MAXIMUM_JSON_DEPTH || nodes > MAXIMUM_JSON_NODES) fail(invalidCode);
    whitespace();
    const current = text[index];
    if (current === "{") {
      index += 1;
      whitespace();
      const keys = new Set();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      for (;;) {
        whitespace();
        const key = parseString();
        if (keys.has(key)) fail(duplicateCode);
        keys.add(key);
        whitespace();
        if (text[index] !== ":") fail(invalidCode);
        index += 1;
        parseValue(depth + 1);
        whitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") fail(invalidCode);
        index += 1;
      }
    }
    if (current === "[") {
      index += 1;
      whitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      for (;;) {
        parseValue(depth + 1);
        whitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") fail(invalidCode);
        index += 1;
      }
    }
    if (current === '"') {
      parseString();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    const number = text.slice(index).match(
      /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u,
    );
    if (!number) fail(invalidCode);
    index += number[0].length;
  };
  parseValue();
  whitespace();
  if (index !== text.length) fail(invalidCode);
}

function parseJsonText(text, {
  invalidCode,
  duplicateCode = FIXED_STATUS.duplicateJsonKey,
  canonical = false,
  canonicalCode = FIXED_STATUS.noncanonical,
} = {}) {
  scanJsonSyntax(text, invalidCode, duplicateCode);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(invalidCode);
  }
  if (canonical && stableJson(value) !== text) fail(canonicalCode);
  return value;
}

export function parseWindowsProductionFinalizerPreparationHandoff(value) {
  const bytes = bytesFromInput(value);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(FIXED_STATUS.jsonInvalid);
  }
  const selected = assertManifest(parseJsonText(text, {
    invalidCode: FIXED_STATUS.jsonInvalid,
    canonical: true,
  }));
  return selected;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function encodeWindowsProductionFinalizerPreparationHandoff(value) {
  const serialized = serializeWindowsProductionFinalizerPreparationHandoff(value);
  const bytes = Buffer.from(serialized, "utf8");
  const base64 = bytes.toString("base64");
  if (Buffer.byteLength(base64, "ascii") > WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_BASE64_BYTES) {
    fail(FIXED_STATUS.oversized);
  }
  return Object.freeze({
    base64,
    bytes: bytes.length,
    sha256: sha256(bytes),
  });
}

export function decodeWindowsProductionFinalizerPreparationHandoff(value, expectedSha256) {
  assertString(value, FIXED_STATUS.inputInvalid, { max: WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_BASE64_BYTES });
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    fail(FIXED_STATUS.inputInvalid);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_MANIFEST_BYTES) fail(FIXED_STATUS.oversized);
  const actualSha256 = sha256(bytes);
  if (expectedSha256 !== undefined && actualSha256 !== assertDigest(expectedSha256, FIXED_STATUS.mismatch)) {
    fail(FIXED_STATUS.mismatch);
  }
  return parseWindowsProductionFinalizerPreparationHandoff(bytes);
}

function normalizeExpected(value) {
  if (value === undefined || value === null) return null;
  const source = snapshotOptionalRecord(value, EXPECTED_KEYS, FIXED_STATUS.inputInvalid);
  const output = {};
  if (source.packageVersion !== null && source.packageVersion !== undefined) {
    output.packageVersion = assertString(source.packageVersion, FIXED_STATUS.stale, {
      pattern: SEMVER_PATTERN,
      max: 32,
    });
  }
  for (const [key, code] of [
    ["qualificationRun", FIXED_STATUS.stale],
    ["qualificationRunAttempt", FIXED_STATUS.stale],
    ["sourceRunId", FIXED_STATUS.stale],
    ["sourceRunAttempt", FIXED_STATUS.stale],
    ["workflowRun", FIXED_STATUS.stale],
    ["workflowRunAttempt", FIXED_STATUS.stale],
  ]) {
    if (source[key] !== null && source[key] !== undefined) {
      output[key] = assertPositiveInteger(source[key], code);
    }
  }
  if (source.revision !== null && source.revision !== undefined) output.revision = assertRevision(source.revision, FIXED_STATUS.stale);
  if (source.sourceRef !== null && source.sourceRef !== undefined) output.sourceRef = assertString(source.sourceRef, FIXED_STATUS.stale, { exact: REF, max: REF.length });
  return Object.freeze(output);
}

function assertExpected(manifest, expected) {
  const source = normalizeExpected(expected);
  if (!source) return;
  if (source.packageVersion !== undefined && manifest.package.version !== source.packageVersion) fail(FIXED_STATUS.stale);
  if (source.revision !== undefined && manifest.source.revision !== source.revision) fail(FIXED_STATUS.stale);
  if (source.sourceRef !== undefined && manifest.source.ref !== source.sourceRef) fail(FIXED_STATUS.stale);
  for (const [key, actual] of [
    ["qualificationRun", manifest.qualification.run],
    ["qualificationRunAttempt", manifest.qualification.runAttempt],
    ["sourceRunId", manifest.qualification.run],
    ["sourceRunAttempt", manifest.qualification.runAttempt],
    ["workflowRun", manifest.workflow.run],
    ["workflowRunAttempt", manifest.workflow.runAttempt],
  ]) {
    if (source[key] !== undefined && source[key] !== actual) fail(FIXED_STATUS.stale);
  }
}

function normalizeVerifyOptions(value = {}) {
  const source = snapshotOptionalRecord(value, VERIFY_OPTIONS_KEYS, FIXED_STATUS.inputInvalid);
  return Object.freeze({
    expected: normalizeExpected(source.expected),
    lockfileBytes: source.lockfileBytes,
    packageJsonBytes: source.packageJsonBytes,
    stagedRoot: source.stagedRoot,
  });
}

function sameFileIdentity(left, right) {
  const oneLink = (value) => value === 1 || value === 1n;
  const sameSize = left.size === right.size
    || (typeof left.size === "bigint" && left.size === BigInt(right.size))
    || (typeof right.size === "bigint" && BigInt(left.size) === right.size);
  const sameTimestamp = (name) => {
    const nanoseconds = `${name}Ns`;
    const milliseconds = `${name}Ms`;
    if (left[nanoseconds] !== undefined || right[nanoseconds] !== undefined) {
      return left[nanoseconds] === right[nanoseconds];
    }
    return left[milliseconds] === right[milliseconds];
  };
  return left.isFile()
    && right.isFile()
    && !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino
    && oneLink(left.nlink)
    && oneLink(right.nlink)
    && sameSize
    && sameTimestamp("birthtime")
    && sameTimestamp("mtime")
    && sameTimestamp("ctime");
}

async function captureRegularFile(path, code, maximum = WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_FILE_BYTES) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) fail(code);
  let before;
  try {
    before = await lstat(path, STAT_OPTIONS);
  } catch {
    fail(code);
  }
  if (!before.isFile() || before.isSymbolicLink() || ![1, 1n].includes(before.nlink) || before.size <= 0) fail(code);
  if (before.size > maximum) fail(FIXED_STATUS.oversized);
  let handle;
  try {
    handle = await open(path, READ_ONLY_FLAGS);
    const opened = await handle.stat(STAT_OPTIONS);
    let afterOpen;
    try {
      afterOpen = await lstat(path, STAT_OPTIONS);
    } catch {
      fail(FIXED_STATUS.tampered);
    }
    if (!sameFileIdentity(before, opened) || !sameFileIdentity(before, afterOpen)) {
      fail(FIXED_STATUS.tampered);
    }
    const chunks = [];
    const hash = createHash("sha256");
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maximum - total + 1));
      const result = await handle.read(chunk, 0, chunk.byteLength, null);
      if (!Number.isSafeInteger(result.bytesRead)
          || result.bytesRead < 0
          || result.bytesRead > chunk.byteLength) {
        fail(code);
      }
      if (result.bytesRead === 0) break;
      const selected = chunk.subarray(0, result.bytesRead);
      chunks.push(selected);
      hash.update(selected);
      total += result.bytesRead;
      if (total > maximum) fail(FIXED_STATUS.oversized);
    }
    const finished = await handle.stat(STAT_OPTIONS);
    let afterRead;
    try {
      afterRead = await lstat(path, STAT_OPTIONS);
    } catch {
      fail(FIXED_STATUS.tampered);
    }
    if (!sameFileIdentity(opened, finished)
        || !sameFileIdentity(opened, afterRead)
        || (typeof opened.size === "bigint" ? BigInt(total) !== opened.size : total !== opened.size)) {
      fail(FIXED_STATUS.tampered);
    }
    const bytes = Buffer.concat(chunks, total);
    return Object.freeze({ bytes, sha256: hash.digest("hex") });
  } catch (error) {
    if (error instanceof WindowsProductionFinalizerPreparationHandoffError) throw error;
    fail(code);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function captureTree(root) {
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root) fail(FIXED_STATUS.stagedInvalid);
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch {
    fail(FIXED_STATUS.stagedInvalid);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail(FIXED_STATUS.stagedInvalid);
  const rows = [];
  let totalBytes = 0;
  const visit = async (directory, prefix) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      fail(FIXED_STATUS.stagedInvalid);
    }
    entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      assertRelativePath(relativePath, FIXED_STATUS.stagedInvalid);
      if (entry.isSymbolicLink()) fail(FIXED_STATUS.stagedInvalid);
      if (entry.isDirectory()) {
        await visit(path, relativePath);
        continue;
      }
      if (!entry.isFile()) fail(FIXED_STATUS.stagedInvalid);
      const captured = await captureRegularFile(path, FIXED_STATUS.stagedInvalid);
      const row = Object.freeze({
        bytes: captured.bytes.length,
        path: relativePath,
        sha256: captured.sha256,
      });
      rows.push(row);
      totalBytes += row.bytes;
      if (rows.length > WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_FILES
          || totalBytes > WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_TREE_BYTES) fail(FIXED_STATUS.oversized);
    }
  };
  await visit(root, "");
  if (rows.length === 0) fail(FIXED_STATUS.stagedInvalid);
  rows.sort(compareRows);
  return Object.freeze({
    files: Object.freeze(rows),
    tree: Object.freeze({
      bytes: totalBytes,
      count: rows.length,
      sha256: treeDigest(rows),
    }),
  });
}

function packageMetadata(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(FIXED_STATUS.packageInvalid);
  }
  const value = parseJsonText(text, {
    invalidCode: FIXED_STATUS.packageInvalid,
  });
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || value.name !== "app-usagemonitor"
      || value.private !== true
      || value.type !== "module"
      || typeof value.version !== "string"
      || !SEMVER_PATTERN.test(value.version)) {
    fail(FIXED_STATUS.packageInvalid);
  }
  return Object.freeze({
    bytes: bytes.length,
    name: "app-usagemonitor",
    path: PACKAGE_PATH,
    sha256: sha256(bytes),
    version: value.version,
  });
}

export async function buildWindowsProductionFinalizerPreparationHandoffFromFiles({
  sourceHandoffPath = null,
  qualification: qualificationInput = null,
  stagingRoot,
  sourceRevision,
  sourceRef,
  sourceRunId,
  sourceRunAttempt = null,
  packageJsonPath = join(REPOSITORY_ROOT, "package.json"),
  lockfilePath = join(REPOSITORY_ROOT, "pnpm-lock.yaml"),
  workflowRunId = sourceRunId,
  workflowRunAttempt = 1,
} = {}) {
  if ((sourceHandoffPath !== null
      && (typeof sourceHandoffPath !== "string" || !isAbsolute(sourceHandoffPath)))
      || typeof stagingRoot !== "string" || !isAbsolute(stagingRoot)) fail(FIXED_STATUS.inputInvalid);
  const revision = assertRevision(sourceRevision, FIXED_STATUS.sourceInvalid);
  const ref = assertString(sourceRef, FIXED_STATUS.sourceInvalid, { exact: REF, max: REF.length });
  const runId = assertPositiveInteger(Number(sourceRunId), FIXED_STATUS.sourceInvalid);
  let qualification;
  if (sourceHandoffPath !== null) {
    const sourceBytes = await captureRegularFile(
      sourceHandoffPath,
      FIXED_STATUS.qualificationInvalid,
      WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_INPUT_BYTES,
    );
    let handoffText;
    try {
      handoffText = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes.bytes);
    } catch {
      fail(FIXED_STATUS.qualificationInvalid);
    }
    const handoff = parseJsonText(handoffText, {
      invalidCode: FIXED_STATUS.qualificationInvalid,
    });
    qualification = qualificationFromSourceHandoff(handoff, revision, ref, runId);
  } else {
    if (qualificationInput === null) fail(FIXED_STATUS.qualificationInvalid);
    qualification = assertQualification(qualificationInput);
    if (qualification.revision !== revision
        || qualification.run !== runId
        || qualification.workflow !== SOURCE_WORKFLOW
        || (sourceRunAttempt !== null && qualification.runAttempt !== Number(sourceRunAttempt))) {
      fail(FIXED_STATUS.stale);
    }
  }
  if (sourceRunAttempt !== null
      && qualification.runAttempt !== Number(sourceRunAttempt)) {
    fail(FIXED_STATUS.stale);
  }
  const packageBytes = await captureRegularFile(packageJsonPath, FIXED_STATUS.packageInvalid);
  const lockfileBytes = await captureRegularFile(lockfilePath, FIXED_STATUS.lockfileInvalid);
  const staged = await captureTree(stagingRoot);
  const nativeRows = {
    filesystemBinding: Object.freeze({
      bytes: staged.files.find((row) => row.path === BINDING_PATH)?.bytes,
      path: BINDING_PATH,
      sha256: staged.files.find((row) => row.path === BINDING_PATH)?.sha256,
    }),
    keytar: Object.freeze({
      bytes: staged.files.find((row) => row.path === KEYTAR_PATH)?.bytes,
      path: KEYTAR_PATH,
      sha256: staged.files.find((row) => row.path === KEYTAR_PATH)?.sha256,
    }),
  };
  const packageInfo = packageMetadata(packageBytes.bytes);
  return buildWindowsProductionFinalizerPreparationHandoff({
    lockfile: {
      bytes: lockfileBytes.bytes.length,
      path: LOCKFILE_PATH,
      sha256: lockfileBytes.sha256,
    },
    native: nativeRows,
    package: packageInfo,
    qualification,
    source: { ref, revision },
    staged: { files: staged.files },
    workflow: {
      path: PREPARATION_WORKFLOW,
      ref,
      revision,
      run: assertPositiveInteger(Number(workflowRunId), FIXED_STATUS.workflowInvalid),
      runAttempt: assertPositiveInteger(Number(workflowRunAttempt), FIXED_STATUS.workflowInvalid),
    },
  });
}

export async function verifyWindowsProductionFinalizerPreparationHandoff(value, options = {}) {
  const manifest = typeof value === "string" || Buffer.isBuffer(value)
    ? parseWindowsProductionFinalizerPreparationHandoff(value)
    : assertManifest(value);
  const normalized = normalizeVerifyOptions(options);
  assertExpected(manifest, normalized.expected);
  if (normalized.packageJsonBytes !== undefined) {
    const packageBytes = bytesFromInput(normalized.packageJsonBytes, FIXED_STATUS.packageInvalid, WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_INPUT_BYTES);
    const packageInfo = packageMetadata(packageBytes);
    if (packageInfo.sha256 !== manifest.package.sha256 || packageInfo.bytes !== manifest.package.bytes || packageInfo.version !== manifest.package.version) fail(FIXED_STATUS.tampered);
  }
  if (normalized.lockfileBytes !== undefined) {
    const lockfile = bytesFromInput(normalized.lockfileBytes, FIXED_STATUS.lockfileInvalid, WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_FILE_BYTES);
    if (sha256(lockfile) !== manifest.lockfile.sha256 || lockfile.length !== manifest.lockfile.bytes) fail(FIXED_STATUS.tampered);
  }
  if (normalized.stagedRoot !== undefined) {
    const actual = await captureTree(normalized.stagedRoot);
    if (stableJson(actual) !== stableJson(manifest.staged)) fail(FIXED_STATUS.tampered);
    const actualNative = assertNative(manifest.native, actual);
    if (actualNative.filesystemBinding.sha256 !== manifest.native.filesystemBinding.sha256
        || actualNative.keytar.sha256 !== manifest.native.keytar.sha256) fail(FIXED_STATUS.tampered);
  }
  return manifest;
}

export function parseWindowsProductionFinalizerPreparationHandoffArguments(argv) {
  if (!Array.isArray(argv)) fail(FIXED_STATUS.inputInvalid);
  const values = { verify: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--verify") {
      if (values.verify) fail(FIXED_STATUS.inputInvalid);
      values.verify = true;
      continue;
    }
    const field = CLI_FIELDS.get(flag);
    if (!field || field === "verify" || Object.hasOwn(values, field)) fail(FIXED_STATUS.inputInvalid);
    const next = argv[index + 1];
    if (typeof next !== "string" || next.length === 0 || next.startsWith("--")) fail(FIXED_STATUS.inputInvalid);
    values[field] = next;
    index += 1;
  }
  if (values.verify) {
    if ((!values.manifest && !values.manifestBase64)
        || !values.expectedSha256
        || !values.stagingRoot
        || !values.sourceRevision
        || !values.sourceRef
        || !values.sourceRunId
        || !values.sourceRunAttempt
        || !values.workflowRunId
        || !values.workflowRunAttempt
        || !values.packageJson
        || !values.lockfile) fail(FIXED_STATUS.inputMissing);
    if (values.manifest && values.manifestBase64) fail(FIXED_STATUS.inputInvalid);
    return Object.freeze(values);
  }
  if (!values.output || (!values.sourceHandoff && !values.qualificationProof)
      || !values.stagingRoot || !values.sourceRevision || !values.sourceRef || !values.sourceRunId) {
    fail(FIXED_STATUS.inputMissing);
  }
  return Object.freeze(values);
}

async function writeExclusive(path, bytes) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) fail(FIXED_STATUS.outputInvalid);
  try {
    await mkdir(dirname(path), { recursive: false });
  } catch (error) {
    if (error?.code !== "EEXIST") fail(FIXED_STATUS.outputInvalid);
  }
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (error?.code === "EEXIST") fail(FIXED_STATUS.outputExists);
    fail(FIXED_STATUS.outputInvalid);
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseWindowsProductionFinalizerPreparationHandoffArguments(argv);
    if (args.verify) {
      const raw = args.manifestBase64
        ? decodeWindowsProductionFinalizerPreparationHandoff(args.manifestBase64, args.expectedSha256)
        : parseWindowsProductionFinalizerPreparationHandoff(
          (await captureRegularFile(resolve(args.manifest), FIXED_STATUS.inputInvalid,
            WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_MANIFEST_BYTES)).bytes,
        );
      const stagingRoot = assertFixedRepositoryPath(
        resolve(args.stagingRoot),
        ".release-build/electron-production/windows-x64/app",
        FIXED_STATUS.stagedInvalid,
      );
      const packageJsonPath = assertFixedRepositoryPath(
        resolve(args.packageJson),
        PACKAGE_PATH,
        FIXED_STATUS.packageInvalid,
      );
      const lockfilePath = assertFixedRepositoryPath(
        resolve(args.lockfile),
        LOCKFILE_PATH,
        FIXED_STATUS.lockfileInvalid,
      );
      const [packageJson, lockfile] = await Promise.all([
        captureRegularFile(
          packageJsonPath,
          FIXED_STATUS.packageInvalid,
          WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_INPUT_BYTES,
        ),
        captureRegularFile(
          lockfilePath,
          FIXED_STATUS.lockfileInvalid,
          WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_FILE_BYTES,
        ),
      ]);
      const verified = await verifyWindowsProductionFinalizerPreparationHandoff(raw, {
        expected: {
          packageVersion: undefined,
          qualificationRun: Number(args.sourceRunId),
          qualificationRunAttempt: Number(args.sourceRunAttempt),
          revision: args.sourceRevision,
          sourceRef: args.sourceRef,
          sourceRunId: Number(args.sourceRunId),
          sourceRunAttempt: Number(args.sourceRunAttempt),
          workflowRun: Number(args.workflowRunId),
          workflowRunAttempt: Number(args.workflowRunAttempt),
        },
        lockfileBytes: lockfile.bytes,
        packageJsonBytes: packageJson.bytes,
        stagedRoot,
      });
      const encoded = encodeWindowsProductionFinalizerPreparationHandoff(verified);
      if (encoded.sha256 !== args.expectedSha256) fail(FIXED_STATUS.mismatch);
      process.stdout.write(`${stableJson({ bytes: encoded.bytes, sha256: encoded.sha256, status: FIXED_STATUS.passed })}`);
      return;
    }
    let qualification = null;
    if (args.qualificationProof) {
      let proofText;
      try {
        proofText = new TextDecoder("utf-8", { fatal: true }).decode(
          (await captureRegularFile(
            resolve(args.qualificationProof),
            FIXED_STATUS.qualificationInvalid,
            WINDOWS_PRODUCTION_FINALIZER_PREPARATION_HANDOFF_MAXIMUM_INPUT_BYTES,
          )).bytes,
        );
      } catch {
        fail(FIXED_STATUS.qualificationInvalid);
      }
      const proof = parseJsonText(proofText, {
        invalidCode: FIXED_STATUS.qualificationInvalid,
      });
      qualification = assertQualification(proof);
    }
    const manifest = await buildWindowsProductionFinalizerPreparationHandoffFromFiles({
      sourceHandoffPath: args.sourceHandoff ? resolve(args.sourceHandoff) : null,
      qualification,
      stagingRoot: resolve(args.stagingRoot),
      sourceRevision: args.sourceRevision,
      sourceRef: args.sourceRef,
      sourceRunId: Number(args.sourceRunId),
      sourceRunAttempt: args.sourceRunAttempt === undefined ? null : Number(args.sourceRunAttempt),
      packageJsonPath: args.packageJson ? resolve(args.packageJson) : join(REPOSITORY_ROOT, PACKAGE_PATH),
      lockfilePath: args.lockfile ? resolve(args.lockfile) : join(REPOSITORY_ROOT, LOCKFILE_PATH),
      workflowRunId: args.workflowRunId === undefined
        ? Number(process.env.GITHUB_RUN_ID ?? args.sourceRunId)
        : Number(args.workflowRunId),
      workflowRunAttempt: args.workflowRunAttempt === undefined
        ? Number(process.env.GITHUB_RUN_ATTEMPT ?? 1)
        : Number(args.workflowRunAttempt),
    });
    const serialized = serializeWindowsProductionFinalizerPreparationHandoff(manifest);
    await writeExclusive(resolve(args.output), Buffer.from(serialized, "utf8"));
    const encoded = encodeWindowsProductionFinalizerPreparationHandoff(manifest);
    process.stdout.write(stableJson({
      bytes: encoded.bytes,
      sha256: encoded.sha256,
      status: FIXED_STATUS.passed,
    }));
  } catch (error) {
    const status = KNOWN_STATUSES.has(error?.code) ? error.code : FIXED_STATUS.inputInvalid;
    process.stderr.write(`${status}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  await main();
}
