#!/usr/bin/env node

/**
 * Build the closed options document consumed by the Windows production
 * finalizer authority driver.
 *
 * This module is deliberately an offline evidence join.  It does not log in,
 * contact GitHub or Azure, invoke TrustedSigning, upload anything, import the
 * release builder, or sign a file.  It reads only the already-selected source
 * evidence, the canonical qualification handoff and native pre-sign receipt,
 * exact checkout package bytes, and the staged runtime tree.  The output is
 * the existing driver's exact options shape; every fact in it is derived from
 * those subjects or the closed Azure policy constants.
 *
 * The driver consumes the generated document later.  This producer keeps the
 * staging and evidence roots separate and re-captures every source identity
 * before publishing, so a changed or replaced subject cannot silently become
 * the authority input.  Node has no openat-style portable directory API; the
 * protected Windows workflow must therefore retain exclusive ownership of
 * both roots for the whole operation.
 */

import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isProxy } from "node:util/types";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY,
  WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256,
  WINDOWS_NATIVE_PRESIGN_MODULES,
  WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY,
  WINDOWS_NATIVE_PRESIGN_SCHEMA,
  WINDOWS_NATIVE_PRESIGN_STATUS,
  WINDOWS_NATIVE_PRESIGN_TARGET,
  parseWindowsNativePresignReceipt,
  serializeWindowsNativePresignReceipt,
} from "./windows-native-presign.mjs";
import {
  WINDOWS_FINALIZER_EVENT,
  WINDOWS_FINALIZER_EXPECTED_REPOSITORY,
  WINDOWS_FINALIZER_HANDOFF_SCHEMA,
  WINDOWS_FINALIZER_PRODUCTION_READINESS,
  WINDOWS_FINALIZER_RUN_CONCLUSION,
  WINDOWS_FINALIZER_RUN_STATUS,
  WINDOWS_FINALIZER_TARGET,
  WINDOWS_FINALIZER_WORKFLOW_PATH,
  WINDOWS_FINALIZER_HANDOFF_STATUS,
  validateWindowsFinalizerQualificationHandoff,
} from "./verify-windows-finalizer-qualification-handoff.mjs";
import {
  WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_EVENT,
  WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_WORKFLOW,
  WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF,
  WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY,
  WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH,
  WINDOWS_PRODUCTION_AUTHORITY_SOURCE_WORKFLOW,
} from "../src/platform/windows-production-authority-manifest.js";
import {
  serializeWindowsFinalizerSourceEvidenceRunMetadata,
  serializeWindowsFinalizerSourceEvidenceSelection,
  validateWindowsFinalizerSourceEvidenceSelection,
} from "./select-windows-finalizer-source-evidence.mjs";
import { validateWindowsPortabilityRunMetadata } from
  "./verify-windows-finalizer-qualification-handoff.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");

export const WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_SCHEMA =
  "tibotattle-windows-production-finalizer-authority-input-v1";
export const WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_STATUS =
  "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILT";
export const WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_DRIVER_OUTPUT =
  "authority.json";

export const WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_FIXED_STATUS = Object.freeze({
  inputInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILDER_INPUT_INVALID",
  inputMissing: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILDER_INPUT_MISSING",
  duplicateJsonKey: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILDER_DUPLICATE_JSON_KEY",
  jsonInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILDER_JSON_INVALID",
  evidenceRootInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILDER_EVIDENCE_ROOT_INVALID",
  stagingRootInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILDER_STAGING_ROOT_INVALID",
  evidenceFileInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILDER_EVIDENCE_FILE_INVALID",
  selectionInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILDER_SELECTION_INVALID",
  selectionNoncanonical: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILDER_SELECTION_NONCANONICAL",
  handoffInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILDER_HANDOFF_INVALID",
  handoffNoncanonical: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILDER_HANDOFF_NONCANONICAL",
  sourceRunInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILDER_SOURCE_RUN_INVALID",
  sourceRunMismatch: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILDER_SOURCE_RUN_MISMATCH",
  packageInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILDER_PACKAGE_INVALID",
  stagingInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILDER_STAGING_INVALID",
  runtimeInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILDER_RUNTIME_INVALID",
  nativeInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILDER_NATIVE_INVALID",
  presignInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILDER_PRESIGN_INVALID",
  presignNoncanonical: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILDER_PRESIGN_NONCANONICAL",
  policyInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILDER_POLICY_INVALID",
  finalizerInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILDER_FINALIZER_INVALID",
  outputInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILDER_OUTPUT_INVALID",
  outputExists: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_BUILDER_OUTPUT_EXISTS",
  passed: WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_STATUS,
});

export const FIXED_STATUS = WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_FIXED_STATUS;
const STATUS = FIXED_STATUS;

const INPUT_KEYS = Object.freeze([
  "evidenceRoot",
  "stagingRoot",
  "selection",
  "handoff",
  "nativePresign",
  "checkoutPackageJson",
  "sourceRunMetadata",
  "policy",
  "finalizerMetadata",
  "output",
]);
const DRIVER_KEYS = Object.freeze([
  "evidenceRoot",
  "output",
  "handoff",
  "nativePresign",
  "checkoutPackageJson",
  "sourceRunMetadata",
  "facts",
]);
const POLICY_KEYS = Object.freeze([
  "endpoint",
  "codeSigningAccountName",
  "certificateProfileName",
  "publisher",
  "timestampRfc3161",
]);
const FINALIZER_KEYS = Object.freeze([
  "event",
  "headSha",
  "ref",
  "repository",
  "run",
  "runAttempt",
  "workflow",
]);
const RUNTIME_KEYS = Object.freeze([
  "architecture",
  "dashboardRoot",
  "entrypoint",
  "files",
  "payload",
  "releaseVersion",
  "schemaVersion",
  "target",
  "windowsBinding",
]);
const RUNTIME_ROW_KEYS = Object.freeze(["bytes", "kind", "path", "sha256"]);
const RUNTIME_PAYLOAD_KEYS = Object.freeze(["bytes", "sha256"]);
const WINDOWS_BINDING_KEYS = Object.freeze([
  "binding",
  "included",
  "manifest",
  "status",
  "verified",
]);
const BINDING_KEYS = Object.freeze(["bytes", "sha256"]);
const RUNTIME_BINDING_KEYS = Object.freeze(["bytes", "path", "sha256"]);
const BINDING_MANIFEST_KEYS = Object.freeze(["path"]);
const PACKAGE_REQUIRED_KEYS = Object.freeze(["name", "private", "type", "version"]);
const PACKAGE_REQUIRED_NAME = "app-usagemonitor";
const PACKAGE_REQUIRED_TYPE = "module";
const RUNTIME_SCHEMA = "usage-monitor-electron-runtime-v0.1";
const RUNTIME_FILE = "electron-runtime-manifest.json";
const WINDOWS_BINDING_PATH = WINDOWS_NATIVE_PRESIGN_MODULES[0].packagedPath;
const WINDOWS_BINDING_MANIFEST_PATH = `${WINDOWS_BINDING_PATH}.manifest.json`;
const KEYTAR_PATH = WINDOWS_NATIVE_PRESIGN_MODULES[1].packagedPath;
const MAXIMUM_JSON_BYTES = 512 * 1024;
const MAXIMUM_PACKAGE_BYTES = 64 * 1024;
const MAXIMUM_RUNTIME_BYTES = 1 * 1024 * 1024;
const MAXIMUM_NATIVE_BYTES = 64 * 1024 * 1024;
const MAXIMUM_STAGING_BYTES = 512 * 1024 * 1024;
const MAXIMUM_STAGING_FILES = 10000;
const MAXIMUM_PATH_BYTES = 4096;
const MAXIMUM_FILENAME_BYTES = 255;
const MAXIMUM_JSON_DEPTH = 64;
const MAXIMUM_JSON_NODES = 4096;
const READ_CHUNK_BYTES = 64 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const PUBLISHER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .,&()=+_-]{0,255}$/u;
const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@._-]*$/u;
const RESERVED_DOS_BASENAMES = new Set([
  "AUX",
  "CON",
  "NUL",
  "PRN",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);
const POSIX_NO_FOLLOW_FLAG = process.platform === "win32"
  ? 0
  : (fsConstants.O_NOFOLLOW ?? 0);
const POSIX_NON_BLOCKING_FLAG = process.platform === "win32"
  ? 0
  : (fsConstants.O_NONBLOCK ?? 0);
const READ_ONLY_FLAGS = fsConstants.O_RDONLY
  | POSIX_NO_FOLLOW_FLAG
  | POSIX_NON_BLOCKING_FLAG;
const CLI_FLAGS = Object.freeze(new Map([
  ["--evidence-root", "evidenceRoot"],
  ["--staging-root", "stagingRoot"],
  ["--selection", "selection"],
  ["--handoff", "handoff"],
  ["--native-presign", "nativePresign"],
  ["--checkout-package-json", "checkoutPackageJson"],
  ["--source-run-metadata", "sourceRunMetadata"],
  ["--policy", "policy"],
  ["--finalizer-metadata", "finalizerMetadata"],
  ["--output", "output"],
]));
const TEST_FAULTS = new Set([
  "replace-evidence-before-temp",
  "replace-evidence-before-publication",
  "mutate-handoff-before-publication",
  "mutate-runtime-before-publication",
  "mutate-policy-before-publication",
  "replace-temp-before-cleanup",
]);

const BUILD_METADATA = new WeakMap();

export class WindowsProductionFinalizerAuthorityInputBuilderError extends Error {
  constructor(code) {
    super("Windows production finalizer authority input build failed");
    this.name = "WindowsProductionFinalizerAuthorityInputBuilderError";
    this.code = code;
  }
}

function fail(code) {
  throw new WindowsProductionFinalizerAuthorityInputBuilderError(code);
}

function rejectProxy(value, code = STATUS.inputInvalid) {
  try {
    if (isProxy(value)) fail(code);
  } catch {
    fail(code);
  }
}

function ownRecord(value, keys, code = STATUS.inputInvalid) {
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
        || descriptor.enumerable !== true
        || descriptor.get !== undefined
        || descriptor.set !== undefined) {
      fail(code);
    }
    selected[key] = descriptor.value;
  }
  return selected;
}

function ownArray(value, code = STATUS.inputInvalid) {
  rejectProxy(value, code);
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(code);
  let keys;
  let descriptors;
  try {
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(code);
  }
  if (keys.length !== value.length + 1
      || keys.some((key) => key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key))) {
    fail(code);
  }
  const length = descriptors.length;
  if (!length
      || !Object.hasOwn(length, "value")
      || length.value !== value.length
      || length.enumerable !== false
      || length.get !== undefined
      || length.set !== undefined) fail(code);
  return value.map((entry, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
        || descriptor.get !== undefined
        || descriptor.set !== undefined) fail(code);
    return descriptor.value;
  });
}

function assertString(value, pattern, code, maximumBytes = MAXIMUM_PATH_BYTES) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\0")
      || Buffer.byteLength(value, "utf8") > maximumBytes
      || !pattern.test(value)) fail(code);
  return value;
}

function assertSha256(value, code) {
  return assertString(value, SHA256_PATTERN, code, 64);
}

function assertRevision(value, code) {
  return assertString(value, REVISION_PATTERN, code, 40);
}

function assertVersion(value, code) {
  return assertString(value, VERSION_PATTERN, code, 32);
}

function assertPositiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}

function safeAbsolutePath(value, code = STATUS.inputInvalid) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\0")
      || Buffer.byteLength(value, "utf8") > MAXIMUM_PATH_BYTES
      || !isAbsolute(value)
      || resolve(value) !== value) fail(code);
  return value;
}

function safeChildFilename(value, code = STATUS.inputInvalid) {
  if (typeof value !== "string"
      || value.length === 0
      || value === "."
      || value === ".."
      || value.includes("\0")
      || value.includes("/")
      || value.includes("\\")
      || value.includes(":")
      || value.endsWith(".")
      || value.endsWith(" ")
      || Buffer.byteLength(value, "utf8") > MAXIMUM_FILENAME_BYTES
      || !SAFE_FILENAME_PATTERN.test(value)) fail(code);
  const base = value.split(".", 1)[0].toUpperCase();
  if (RESERVED_DOS_BASENAMES.has(base)) fail(code);
  return value;
}

function safeRelativePath(value, code = STATUS.runtimeInvalid) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\0")
      || value.includes("\\")
      || value.startsWith("/")
      || /^[A-Za-z]:/u.test(value)
      || Buffer.byteLength(value, "utf8") > MAXIMUM_PATH_BYTES) fail(code);
  const parts = value.split("/");
  if (parts.some((part) => {
    if (part.length === 0 || part === "." || part === "..") return true;
    try {
      safeChildFilename(part, code);
    } catch {
      return true;
    }
    return false;
  })) fail(code);
  return value;
}

function comparePathBytes(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(comparePathBytes)
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function samePath(left, right) {
  if (process.platform === "win32") return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function rootIdentity(metadata) {
  return Object.freeze({
    birthtimeNs: metadata.birthtimeNs ?? BigInt(Math.round(metadata.birthtimeMs * 1e6)),
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    uid: metadata.uid,
  });
}

function sameRootIdentity(left, right) {
  return left.birthtimeNs === right.birthtimeNs
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid;
}

function isWithinRoot(rootPath, candidatePath) {
  const comparableRoot = process.platform === "win32"
    ? rootPath.toLowerCase()
    : rootPath;
  const comparableCandidate = process.platform === "win32"
    ? candidatePath.toLowerCase()
    : candidatePath;
  const distance = relative(comparableRoot, comparableCandidate);
  const parentPrefix = process.platform === "win32" ? "\\" : "/";
  return distance === ""
    || (distance !== ".."
      && !distance.startsWith(`..${parentPrefix}`)
      && !isAbsolute(distance));
}

function assertRootsDisjoint(evidenceState, stagingState) {
  if (sameRootIdentity(evidenceState.identity, stagingState.identity)
      || isWithinRoot(evidenceState.canonicalPath, stagingState.canonicalPath)
      || isWithinRoot(stagingState.canonicalPath, evidenceState.canonicalPath)) {
    fail(STATUS.stagingRootInvalid);
  }
}

function assertOwnedDirectory(metadata, code) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(code);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && metadata.uid !== undefined && metadata.uid !== uid) fail(code);
  if (process.platform !== "win32" && (metadata.mode & 0o022) !== 0) fail(code);
}

async function captureOwnedRoot(path, code) {
  try {
    const metadata = await lstat(path);
    assertOwnedDirectory(metadata, code);
    const canonical = await realpath(path);
    const canonicalMetadata = await lstat(canonical);
    assertOwnedDirectory(canonicalMetadata, code);
    if (!samePath(canonical, path)
        || !sameRootIdentity(rootIdentity(metadata), rootIdentity(canonicalMetadata))) {
      fail(code);
    }
    return Object.freeze({
      canonicalPath: canonical,
      identity: rootIdentity(metadata),
      path,
    });
  } catch (error) {
    if (error instanceof WindowsProductionFinalizerAuthorityInputBuilderError) throw error;
    fail(code);
  }
}

async function assertOwnedRoot(state, code) {
  try {
    const metadata = await lstat(state.path);
    assertOwnedDirectory(metadata, code);
    if (!sameRootIdentity(state.identity, rootIdentity(metadata))) fail(code);
    const canonical = await realpath(state.path);
    if (!samePath(canonical, state.canonicalPath)) fail(code);
    const canonicalMetadata = await lstat(canonical);
    assertOwnedDirectory(canonicalMetadata, code);
    if (!sameRootIdentity(state.identity, rootIdentity(canonicalMetadata))) fail(code);
  } catch (error) {
    if (error instanceof WindowsProductionFinalizerAuthorityInputBuilderError) throw error;
    fail(code);
  }
}

function sameFileIdentity(left, right) {
  const birthLeft = left.birthtimeNs ?? BigInt(Math.round(left.birthtimeMs * 1e6));
  const birthRight = right.birthtimeNs ?? BigInt(Math.round(right.birthtimeMs * 1e6));
  const mtimeLeft = left.mtimeNs ?? BigInt(Math.round(left.mtimeMs * 1e6));
  const mtimeRight = right.mtimeNs ?? BigInt(Math.round(right.mtimeMs * 1e6));
  const ctimeLeft = left.ctimeNs ?? BigInt(Math.round(left.ctimeMs * 1e6));
  const ctimeRight = right.ctimeNs ?? BigInt(Math.round(right.ctimeMs * 1e6));
  return left.isFile()
    && right.isFile()
    && !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && birthLeft === birthRight
    && mtimeLeft === mtimeRight
    && ctimeLeft === ctimeRight;
}

function sameFileObjectIdentity(left, right) {
  const birthLeft = left.birthtimeNs ?? BigInt(Math.round(left.birthtimeMs * 1e6));
  const birthRight = right.birthtimeNs ?? BigInt(Math.round(right.birthtimeMs * 1e6));
  return left.isFile()
    && right.isFile()
    && !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino
    && birthLeft === birthRight;
}

function rootValidationCode(code) {
  return code === STATUS.stagingInvalid
    || code === STATUS.runtimeInvalid
    || code === STATUS.nativeInvalid
    ? STATUS.stagingRootInvalid
    : STATUS.evidenceRootInvalid;
}

async function captureRegularFile(path, maximumBytes, code, rootState = null) {
  let handle;
  try {
    if (rootState) await assertOwnedRoot(rootState, rootValidationCode(code));
    const before = await lstat(path);
    if (!before.isFile()
        || before.isSymbolicLink()
        || before.nlink !== 1
        || before.size <= 0
        || before.size > maximumBytes) fail(code);
    handle = await open(path, READ_ONLY_FLAGS);
    const opened = await handle.stat();
    if (!sameFileIdentity(before, opened) || opened.nlink !== 1) fail(code);
    const afterOpen = await lstat(path);
    if (!sameFileIdentity(before, afterOpen) || afterOpen.nlink !== 1) fail(code);
    const hash = createHash("sha256");
    const chunks = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maximumBytes + 1 - total));
      const result = await handle.read(chunk, 0, chunk.byteLength, null);
      if (!Number.isSafeInteger(result.bytesRead)
          || result.bytesRead < 0
          || result.bytesRead > chunk.byteLength) fail(code);
      if (result.bytesRead === 0) break;
      const selected = chunk.subarray(0, result.bytesRead);
      chunks.push(selected);
      hash.update(selected);
      total += result.bytesRead;
      if (total > maximumBytes) fail(code);
    }
    const finished = await handle.stat();
    const afterRead = await lstat(path);
    if (!sameFileObjectIdentity(opened, finished)
        || !sameFileIdentity(opened, afterRead)
        || finished.nlink !== 1
        || afterRead.nlink !== 1
        || total !== finished.size) fail(code);
    if (rootState) await assertOwnedRoot(rootState, rootValidationCode(code));
    return Object.freeze({
      bytes: Buffer.concat(chunks, total),
      identity: Object.freeze({
        birthtimeNs: finished.birthtimeNs ?? BigInt(Math.round(finished.birthtimeMs * 1e6)),
        ctimeNs: finished.ctimeNs ?? BigInt(Math.round(finished.ctimeMs * 1e6)),
        dev: finished.dev,
        ino: finished.ino,
        mtimeNs: finished.mtimeNs ?? BigInt(Math.round(finished.mtimeMs * 1e6)),
        size: finished.size,
      }),
      path,
      sha256: hash.digest("hex"),
      size: total,
    });
  } catch (error) {
    if (error instanceof WindowsProductionFinalizerAuthorityInputBuilderError) throw error;
    fail(code);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function recaptureFile(snapshot, maximumBytes, code, rootState = null) {
  const current = await captureRegularFile(snapshot.path, maximumBytes, code, rootState);
  if (!sameFileIdentity(
    { ...snapshot.identity, isFile: () => true, isSymbolicLink: () => false },
    { ...current.identity, isFile: () => true, isSymbolicLink: () => false },
  ) || current.sha256 !== snapshot.sha256 || current.size !== snapshot.size) {
    fail(code);
  }
  return current;
}

function scanJsonSyntax(text, invalidCode, duplicateCode) {
  let index = 0;
  let nodes = 0;
  const length = text.length;
  const whitespace = () => {
    while (index < length && /\s/u.test(text[index])) index += 1;
  };
  const string = () => {
    if (text[index] !== '"') fail(invalidCode);
    const start = index;
    index += 1;
    while (index < length) {
      const current = text[index];
      if (current === "\\") {
        index += 2;
        continue;
      }
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
  const value = (depth = 0) => {
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
        const key = string();
        if (keys.has(key)) fail(duplicateCode);
        keys.add(key);
        whitespace();
        if (text[index] !== ":") fail(invalidCode);
        index += 1;
        value(depth + 1);
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
        value(depth + 1);
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
      string();
      return;
    }
    if (text.startsWith("true", index)) {
      index += 4;
      return;
    }
    if (text.startsWith("false", index)) {
      index += 5;
      return;
    }
    if (text.startsWith("null", index)) {
      index += 4;
      return;
    }
    const number = text.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (!number) fail(invalidCode);
    index += number[0].length;
  };
  value();
  whitespace();
  if (index !== length) fail(invalidCode);
}

function parseJson(bytes, maximumBytes, invalidCode, duplicateCode = STATUS.duplicateJsonKey) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximumBytes) fail(invalidCode);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(invalidCode);
  }
  scanJsonSyntax(text, invalidCode, duplicateCode);
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail(invalidCode);
    return value;
  } catch (error) {
    if (error instanceof WindowsProductionFinalizerAuthorityInputBuilderError) throw error;
    fail(invalidCode);
  }
}

function assertCanonicalBytes(bytes, value, code, formatter = stableJson) {
  let serialized;
  try {
    serialized = formatter(value);
  } catch {
    fail(code);
  }
  if (serialized !== bytes.toString("utf8")) fail(code);
  return value;
}

function parsePackage(raw, code) {
  const packageJson = parseJson(raw.bytes, MAXIMUM_PACKAGE_BYTES, code);
  for (const key of PACKAGE_REQUIRED_KEYS) {
    if (!Object.hasOwn(packageJson, key)) fail(code);
  }
  if (packageJson.name !== PACKAGE_REQUIRED_NAME
      || packageJson.private !== true
      || packageJson.type !== PACKAGE_REQUIRED_TYPE) fail(code);
  return Object.freeze({
    name: PACKAGE_REQUIRED_NAME,
    version: assertVersion(packageJson.version, code),
  });
}

function digestPayload(rows) {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const row of rows) {
    bytes += row.bytes;
    hash.update(`F\0${row.path}\0${row.bytes}\0${row.sha256}\0${row.kind}\0`);
  }
  return { bytes, sha256: hash.digest("hex") };
}

function parseRuntime(raw, packageVersion) {
  const value = parseJson(raw.bytes, MAXIMUM_RUNTIME_BYTES, STATUS.runtimeInvalid);
  assertCanonicalBytes(raw.bytes, value, STATUS.runtimeInvalid);
  const source = ownRecord(value, RUNTIME_KEYS, STATUS.runtimeInvalid);
  if (source.architecture !== "x64"
      || source.dashboardRoot !== "apps/web/public"
      || source.entrypoint !== "apps/electron/main.js"
      || source.releaseVersion !== packageVersion
      || source.schemaVersion !== RUNTIME_SCHEMA
      || source.target !== "win32"
      || !Array.isArray(source.files)
      || source.files.length === 0
      || source.files.length > MAXIMUM_STAGING_FILES) fail(STATUS.runtimeInvalid);
  const rows = ownArray(source.files, STATUS.runtimeInvalid).map((rowValue) => {
    const row = ownRecord(rowValue, RUNTIME_ROW_KEYS, STATUS.runtimeInvalid);
    return Object.freeze({
      bytes: assertPositiveInteger(row.bytes, STATUS.runtimeInvalid),
      kind: assertString(row.kind, /^(?!$).+$/u, STATUS.runtimeInvalid, 128),
      path: safeRelativePath(row.path, STATUS.runtimeInvalid),
      sha256: assertSha256(row.sha256, STATUS.runtimeInvalid),
    });
  });
  const exact = new Set();
  const folded = new Set();
  let previous = null;
  for (const row of rows) {
    if (row.path === RUNTIME_FILE
        || exact.has(row.path)
        || folded.has(row.path.toLowerCase())
        || (previous !== null && comparePathBytes(previous, row.path) >= 0)) {
      fail(STATUS.runtimeInvalid);
    }
    exact.add(row.path);
    folded.add(row.path.toLowerCase());
    previous = row.path;
  }
  const payload = ownRecord(source.payload, RUNTIME_PAYLOAD_KEYS, STATUS.runtimeInvalid);
  const expectedPayload = digestPayload(rows);
  if (payload.bytes !== expectedPayload.bytes
      || payload.sha256 !== expectedPayload.sha256) fail(STATUS.runtimeInvalid);
  const windowsBinding = ownRecord(source.windowsBinding, WINDOWS_BINDING_KEYS, STATUS.runtimeInvalid);
  const binding = ownRecord(windowsBinding.binding, RUNTIME_BINDING_KEYS, STATUS.runtimeInvalid);
  const manifest = ownRecord(windowsBinding.manifest, BINDING_MANIFEST_KEYS, STATUS.runtimeInvalid);
  if (windowsBinding.included !== true
      || windowsBinding.status !== "included_unverified"
      || windowsBinding.verified !== false
      || binding.path !== WINDOWS_BINDING_PATH
      || manifest.path !== WINDOWS_BINDING_MANIFEST_PATH
      || binding.bytes <= 0
      || !SHA256_PATTERN.test(binding.sha256)) fail(STATUS.runtimeInvalid);
  const bindingRow = rows.find(({ path }) => path === WINDOWS_BINDING_PATH);
  if (!bindingRow || binding.bytes !== bindingRow.bytes || binding.sha256 !== bindingRow.sha256) {
    fail(STATUS.runtimeInvalid);
  }
  if (!exact.has(WINDOWS_BINDING_PATH)
      || !exact.has(WINDOWS_BINDING_MANIFEST_PATH)
      || !exact.has(KEYTAR_PATH)
      || rows.filter(({ path }) => path.toLowerCase().endsWith(".node")).length !== 2
      || rows.some(({ path }) => path.toLowerCase().endsWith(".node")
        && path !== WINDOWS_BINDING_PATH
        && path !== KEYTAR_PATH)) {
    fail(STATUS.runtimeInvalid);
  }
  return Object.freeze({
    binding: Object.freeze({ bytes: binding.bytes, sha256: binding.sha256 }),
    rows: Object.freeze(rows),
    value: source,
  });
}

async function inventoryStaging(rootState) {
  const rows = [];
  const exact = new Set();
  const folded = new Set();
  let totalBytes = 0;
  async function walk(current, prefix) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      fail(STATUS.stagingInvalid);
    }
    entries.sort((left, right) => comparePathBytes(left.name, right.name));
    for (const entry of entries) {
      safeChildFilename(entry.name, STATUS.stagingInvalid);
      const path = join(current, entry.name);
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      safeRelativePath(relativePath, STATUS.stagingInvalid);
      if (entry.isSymbolicLink()) fail(STATUS.stagingInvalid);
      if (entry.isDirectory()) {
        await walk(path, relativePath);
        continue;
      }
      if (!entry.isFile()) fail(STATUS.stagingInvalid);
      if (relativePath === RUNTIME_FILE) continue;
      if (rows.length >= MAXIMUM_STAGING_FILES) fail(STATUS.stagingInvalid);
      const captured = await captureRegularFile(
        path,
        MAXIMUM_NATIVE_BYTES,
        STATUS.stagingInvalid,
        rootState,
      );
      if (exact.has(relativePath) || folded.has(relativePath.toLowerCase())) {
        fail(STATUS.stagingInvalid);
      }
      exact.add(relativePath);
      folded.add(relativePath.toLowerCase());
      totalBytes += captured.size;
      if (totalBytes > MAXIMUM_STAGING_BYTES) fail(STATUS.stagingInvalid);
      rows.push({
        bytes: captured.size,
        path: relativePath,
        sha256: captured.sha256,
        snapshot: captured,
      });
    }
  }
  await walk(rootState.path, "");
  rows.sort((left, right) => comparePathBytes(left.path, right.path));
  return Object.freeze({ rows: Object.freeze(rows), totalBytes });
}

function validateStagedInventory(runtime, actual) {
  const expected = new Map(runtime.rows.map((row) => [row.path, row]));
  const actualMap = new Map(actual.rows.map((row) => [row.path, row]));
  if (expected.size !== actualMap.size) fail(STATUS.runtimeInvalid);
  for (const [path, row] of expected) {
    const selected = actualMap.get(path);
    if (!selected) {
      fail(STATUS.runtimeInvalid);
    }
    // The two fixed native files are intentionally changed by the preceding
    // native pre-sign stage.  Their unsigned rows remain in the runtime
    // manifest and are checked against the receipt/handoff below; every other
    // staged file must remain byte-identical to that manifest.
    const native = path === WINDOWS_BINDING_PATH || path === KEYTAR_PATH;
    if (!native && (selected.bytes !== row.bytes || selected.sha256 !== row.sha256)) {
      fail(STATUS.runtimeInvalid);
    }
  }
  return actualMap;
}

function validatePolicy(raw) {
  const value = parseJson(raw.bytes, MAXIMUM_JSON_BYTES, STATUS.policyInvalid);
  assertCanonicalBytes(raw.bytes, value, STATUS.policyInvalid);
  const source = ownRecord(value, POLICY_KEYS, STATUS.policyInvalid);
  if (source.endpoint !== WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.endpoint
      || source.codeSigningAccountName
        !== WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.codeSigningAccountName
      || source.certificateProfileName
        !== WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.certificateProfileName
      || source.publisher !== WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.publisher
      || source.timestampRfc3161 !== WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.timestampRfc3161) {
    fail(STATUS.policyInvalid);
  }
  return Object.freeze({
    endpoint: source.endpoint,
    codeSigningAccountName: source.codeSigningAccountName,
    certificateProfileName: source.certificateProfileName,
    publisher: source.publisher,
    timestampRfc3161: source.timestampRfc3161,
  });
}

function validateFinalizerMetadata(raw, revision, sourceRun) {
  const value = parseJson(raw.bytes, MAXIMUM_JSON_BYTES, STATUS.finalizerInvalid);
  assertCanonicalBytes(raw.bytes, value, STATUS.finalizerInvalid);
  const source = ownRecord(value, FINALIZER_KEYS, STATUS.finalizerInvalid);
  const headSha = assertRevision(source.headSha, STATUS.finalizerInvalid);
  const run = assertPositiveInteger(source.run, STATUS.finalizerInvalid);
  const runAttempt = assertPositiveInteger(source.runAttempt, STATUS.finalizerInvalid);
  if (source.event !== WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_EVENT
      || source.ref !== WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF
      || source.repository !== WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY
      || source.workflow !== WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_WORKFLOW
      || headSha !== revision
      || run === sourceRun) fail(STATUS.finalizerInvalid);
  return Object.freeze({
    headSha,
    run,
    runAttempt,
  });
}

function assertSelectionHandoffAlignment(selection, handoff) {
  if (selection.repository !== handoff.repository
      || selection.revision !== handoff.revision
      || selection.ref !== handoff.run.ref
      || selection.runId !== handoff.run.databaseId
      || selection.runAttempt !== handoff.run.runAttempt) {
    fail(STATUS.sourceRunMismatch);
  }
  for (const receipt of handoff.receipts) {
    const selected = selection.artifacts[receipt.cacheMode];
    if (!selected
        || selected.id !== receipt.artifact.id
        || selected.digest !== receipt.artifact.digest
        || selected.name !== receipt.artifact.name
        || selected.sizeInBytes !== receipt.artifact.sizeInBytes) {
      fail(STATUS.sourceRunMismatch);
    }
  }
}

function validateSelection(raw) {
  const value = parseJson(raw.bytes, MAXIMUM_JSON_BYTES, STATUS.selectionInvalid);
  let selected;
  try {
    selected = validateWindowsFinalizerSourceEvidenceSelection(value);
  } catch {
    fail(STATUS.selectionInvalid);
  }
  assertCanonicalBytes(
    raw.bytes,
    selected,
    STATUS.selectionNoncanonical,
    serializeWindowsFinalizerSourceEvidenceSelection,
  );
  return selected;
}

function validateSourceRun(raw, selection) {
  const value = parseJson(raw.bytes, MAXIMUM_JSON_BYTES, STATUS.sourceRunInvalid);
  let selected;
  try {
    selected = validateWindowsPortabilityRunMetadata(value, {
      ref: selection.ref,
      repository: selection.repository,
      revision: selection.revision,
    });
  } catch {
    fail(STATUS.sourceRunInvalid);
  }
  assertCanonicalBytes(
    raw.bytes,
    selected,
    STATUS.sourceRunInvalid,
    (candidate) => serializeWindowsFinalizerSourceEvidenceRunMetadata(candidate, {
      ref: selection.ref,
      repository: selection.repository,
      revision: selection.revision,
      runId: selection.runId,
    }),
  );
  if (selected.databaseId !== selection.runId
      || selected.runAttempt !== selection.runAttempt
      || selected.headSha !== selection.revision
      || selected.repository !== WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY
      || selected.workflowPath !== WINDOWS_PRODUCTION_AUTHORITY_SOURCE_WORKFLOW) {
    fail(STATUS.sourceRunMismatch);
  }
  return selected;
}

function validateHandoff(raw, selection) {
  const value = parseJson(raw.bytes, MAXIMUM_JSON_BYTES, STATUS.handoffInvalid);
  let selected;
  try {
    selected = validateWindowsFinalizerQualificationHandoff(value, {
      ref: selection.ref,
      repository: selection.repository,
      revision: selection.revision,
    });
  } catch {
    fail(STATUS.handoffInvalid);
  }
  if (selected.schemaVersion !== WINDOWS_FINALIZER_HANDOFF_SCHEMA
      || selected.status !== WINDOWS_FINALIZER_HANDOFF_STATUS
      || selected.target !== WINDOWS_FINALIZER_TARGET
      || selected.productionReadiness !== WINDOWS_FINALIZER_PRODUCTION_READINESS
      || selected.run.event !== WINDOWS_FINALIZER_EVENT
      || selected.run.status !== WINDOWS_FINALIZER_RUN_STATUS
      || selected.run.conclusion !== WINDOWS_FINALIZER_RUN_CONCLUSION) {
    fail(STATUS.handoffInvalid);
  }
  assertCanonicalBytes(raw.bytes, selected, STATUS.handoffNoncanonical, (candidate) =>
    `${JSON.stringify(candidate, null, 2)}\n`);
  return selected;
}

function buildDriverOptions({
  evidenceRoot,
  handoff,
  nativePresign,
  checkoutPackageJson,
  sourceRunMetadata,
  facts,
}) {
  return Object.freeze({
    evidenceRoot,
    output: WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_DRIVER_OUTPUT,
    handoff,
    nativePresign,
    checkoutPackageJson,
    sourceRunMetadata,
    facts: Object.freeze(facts),
  });
}

function validateInput(value) {
  const source = ownRecord(value, INPUT_KEYS, STATUS.inputInvalid);
  const evidenceRoot = safeAbsolutePath(source.evidenceRoot, STATUS.inputInvalid);
  const stagingRoot = safeAbsolutePath(source.stagingRoot, STATUS.inputInvalid);
  const paths = INPUT_KEYS
    .filter((key) => key !== "evidenceRoot" && key !== "stagingRoot" && key !== "output")
    .map((key) => safeChildFilename(source[key], STATUS.inputInvalid));
  const output = safeChildFilename(source.output, STATUS.inputInvalid);
  const folded = [...paths, output].map((path) => path.toLowerCase());
  if (new Set(folded).size !== folded.length) fail(STATUS.inputInvalid);
  return Object.freeze({
    checkoutPackageJson: paths[3],
    evidenceRoot,
    finalizerMetadata: paths[6],
    handoff: paths[1],
    nativePresign: paths[2],
    output,
    policy: paths[5],
    selection: paths[0],
    sourceRunMetadata: paths[4],
    stagingRoot,
  });
}

function normalizeDependencies(dependencies = {}) {
  rejectProxy(dependencies, STATUS.inputInvalid);
  if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    fail(STATUS.inputInvalid);
  }
  let prototype;
  let ownKeys;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(dependencies);
    ownKeys = Reflect.ownKeys(dependencies);
    descriptors = Object.getOwnPropertyDescriptors(dependencies);
  } catch {
    fail(STATUS.inputInvalid);
  }
  if (prototype !== Object.prototype
      || ownKeys.some((key) => key !== "testOnlyFault")) {
    fail(STATUS.inputInvalid);
  }
  const descriptor = descriptors.testOnlyFault;
  if (descriptor !== undefined
      && (!Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
        || descriptor.get !== undefined
        || descriptor.set !== undefined)) fail(STATUS.inputInvalid);
  const fault = descriptor?.value ?? null;
  if (fault !== null && !TEST_FAULTS.has(fault)) fail(STATUS.inputInvalid);
  return Object.freeze({ testOnlyFault: fault });
}

function compareInputFile(snapshot, maximumBytes, code, rootState) {
  return recaptureFile(snapshot, maximumBytes, code, rootState);
}

/**
 * Derive the exact authority-driver options from the selected evidence and
 * staged signed native tree.  The caller cannot provide native rows or a
 * certificate subject; both are projected from the validated receipt/policy.
 */
export async function buildWindowsProductionFinalizerAuthorityInput(value, dependencies = {}) {
  const options = validateInput(value);
  const roots = normalizeDependencies(dependencies);
  const evidenceState = await captureOwnedRoot(options.evidenceRoot, STATUS.evidenceRootInvalid);
  const stagingState = await captureOwnedRoot(options.stagingRoot, STATUS.stagingRootInvalid);
  assertRootsDisjoint(evidenceState, stagingState);
  await assertOwnedRoot(evidenceState, STATUS.evidenceRootInvalid);
  await assertOwnedRoot(stagingState, STATUS.stagingRootInvalid);
  const evidencePath = (name) => join(options.evidenceRoot, name);
  const selectionRaw = await captureRegularFile(
    evidencePath(options.selection),
    MAXIMUM_JSON_BYTES,
    STATUS.selectionInvalid,
    evidenceState,
  );
  const handoffRaw = await captureRegularFile(
    evidencePath(options.handoff),
    MAXIMUM_JSON_BYTES,
    STATUS.handoffInvalid,
    evidenceState,
  );
  const nativePresignRaw = await captureRegularFile(
    evidencePath(options.nativePresign),
    MAXIMUM_JSON_BYTES,
    STATUS.presignInvalid,
    evidenceState,
  );
  const sourceRunRaw = await captureRegularFile(
    evidencePath(options.sourceRunMetadata),
    MAXIMUM_JSON_BYTES,
    STATUS.sourceRunInvalid,
    evidenceState,
  );
  const packageRaw = await captureRegularFile(
    evidencePath(options.checkoutPackageJson),
    MAXIMUM_PACKAGE_BYTES,
    STATUS.packageInvalid,
    evidenceState,
  );
  const policyRaw = await captureRegularFile(
    evidencePath(options.policy),
    MAXIMUM_JSON_BYTES,
    STATUS.policyInvalid,
    evidenceState,
  );
  const finalizerRaw = await captureRegularFile(
    evidencePath(options.finalizerMetadata),
    MAXIMUM_JSON_BYTES,
    STATUS.finalizerInvalid,
    evidenceState,
  );
  const runtimePath = join(options.stagingRoot, RUNTIME_FILE);
  const runtimeRaw = await captureRegularFile(
    runtimePath,
    MAXIMUM_RUNTIME_BYTES,
    STATUS.runtimeInvalid,
    stagingState,
  );
  const stagedPackageRaw = await captureRegularFile(
    join(options.stagingRoot, "package.json"),
    MAXIMUM_PACKAGE_BYTES,
    STATUS.stagingInvalid,
    stagingState,
  );
  const staged = await inventoryStaging(stagingState);

  const selection = validateSelection(selectionRaw);
  const sourceRun = validateSourceRun(sourceRunRaw, selection);
  const handoff = validateHandoff(handoffRaw, selection);
  assertSelectionHandoffAlignment(selection, handoff);
  const packageInfo = parsePackage(packageRaw, STATUS.packageInvalid);
  const stagedPackageInfo = parsePackage(stagedPackageRaw, STATUS.stagingInvalid);
  if (stagedPackageInfo.version !== packageInfo.version) fail(STATUS.packageInvalid);
  const runtime = parseRuntime(runtimeRaw, packageInfo.version);
  const actual = validateStagedInventory(runtime, staged);
  const bindingRow = actual.get(WINDOWS_BINDING_PATH);
  const bindingRuntimeRow = runtime.rows.find(({ path }) => path === WINDOWS_BINDING_PATH);
  const keytarRow = actual.get(KEYTAR_PATH);
  const keytarRuntimeRow = runtime.rows.find(({ path }) => path === KEYTAR_PATH);
  if (!bindingRow
      || !bindingRuntimeRow
      || bindingRuntimeRow.bytes !== runtime.binding.bytes
      || bindingRuntimeRow.sha256 !== runtime.binding.sha256
      || !keytarRow
      || !keytarRuntimeRow
      || keytarRuntimeRow.sha256 !== WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256) {
    fail(STATUS.nativeInvalid);
  }
  const warm = handoff.receipts.find(({ cacheMode }) => cacheMode === "warm");
  const clean = handoff.receipts.find(({ cacheMode }) => cacheMode === "clean");
  if (!warm || !clean
      || warm.binding.bytes !== runtime.binding.bytes
      || warm.binding.sha256 !== runtime.binding.sha256
      || clean.binding.bytes !== runtime.binding.bytes
      || clean.binding.sha256 !== runtime.binding.sha256) fail(STATUS.nativeInvalid);
  const policy = validatePolicy(policyRaw);
  const finalizer = validateFinalizerMetadata(
    finalizerRaw,
    handoff.revision,
    handoff.run.databaseId,
  );
  const handoffSha256 = handoffRaw.sha256;
  let presign;
  try {
    presign = parseWindowsNativePresignReceipt(
      nativePresignRaw.bytes.toString("utf8"),
      {
        filesystemBinding: runtime.binding,
        packageVersion: packageInfo.version,
        publisher: policy.publisher,
        qualificationHandoffSha256: handoffSha256,
        revision: handoff.revision,
      },
    );
  } catch {
    fail(STATUS.presignInvalid);
  }
  assertCanonicalBytes(
    nativePresignRaw.bytes,
    presign,
    STATUS.presignNoncanonical,
    serializeWindowsNativePresignReceipt,
  );
  if (presign.schemaVersion !== WINDOWS_NATIVE_PRESIGN_SCHEMA
      || presign.status !== WINDOWS_NATIVE_PRESIGN_STATUS
      || presign.target !== WINDOWS_NATIVE_PRESIGN_TARGET
      || stableJson(presign.signingRequestPolicy) !== stableJson(WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY)) {
    fail(STATUS.presignInvalid);
  }
  const nativeFacts = presign.modules.map((moduleValue, index) => {
    const { authenticode: _authenticode, ...module } = moduleValue;
    const expected = WINDOWS_NATIVE_PRESIGN_MODULES[index];
    const actualRow = actual.get(expected.packagedPath);
    if (!actualRow
        || actualRow.bytes !== module.signedBytes
        || actualRow.sha256 !== module.signedSha256
        || module.unsignedSha256 === module.signedSha256
        || moduleValue.authenticode?.publisher !== policy.publisher) {
      fail(STATUS.nativeInvalid);
    }
    return Object.freeze({ ...module });
  });
  const facts = Object.freeze({
    filesystemBinding: Object.freeze({ ...runtime.binding }),
    keytarBinding: Object.freeze({
      bytes: presign.modules[1].unsignedBytes,
      sha256: WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256,
    }),
    signerPolicy: Object.freeze({ publisher: policy.publisher, match: "exact" }),
    nativeModules: Object.freeze(nativeFacts),
    runtimeManifest: Object.freeze({
      packagedPath: WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH,
      bytes: runtimeRaw.size,
      sha256: runtimeRaw.sha256,
    }),
    finalizer: Object.freeze({
      run: finalizer.run,
      runAttempt: finalizer.runAttempt,
      headSha: finalizer.headSha,
    }),
  });
  const driverInput = buildDriverOptions({
    checkoutPackageJson: options.checkoutPackageJson,
    evidenceRoot: options.evidenceRoot,
    facts,
    handoff: options.handoff,
    nativePresign: options.nativePresign,
    sourceRunMetadata: options.sourceRunMetadata,
  });
  // Re-capture all evidence and every staged file before returning the
  // result.  writeWindows... repeats this immediately before publication.
  await assertOwnedRoot(evidenceState, STATUS.evidenceRootInvalid);
  await assertOwnedRoot(stagingState, STATUS.stagingRootInvalid);
  for (const [snapshot, maximum, code] of [
    [selectionRaw, MAXIMUM_JSON_BYTES, STATUS.selectionInvalid],
    [handoffRaw, MAXIMUM_JSON_BYTES, STATUS.handoffInvalid],
    [nativePresignRaw, MAXIMUM_JSON_BYTES, STATUS.presignInvalid],
    [sourceRunRaw, MAXIMUM_JSON_BYTES, STATUS.sourceRunInvalid],
    [packageRaw, MAXIMUM_PACKAGE_BYTES, STATUS.packageInvalid],
    [policyRaw, MAXIMUM_JSON_BYTES, STATUS.policyInvalid],
    [finalizerRaw, MAXIMUM_JSON_BYTES, STATUS.finalizerInvalid],
  ]) await compareInputFile(snapshot, maximum, code, evidenceState);
  await compareInputFile(runtimeRaw, MAXIMUM_RUNTIME_BYTES, STATUS.runtimeInvalid, stagingState);
  for (const row of staged.rows) {
    await compareInputFile(row.snapshot, MAXIMUM_NATIVE_BYTES, STATUS.stagingInvalid, stagingState);
  }
  const outputPath = join(options.evidenceRoot, options.output);
  await assertOutputAbsent(outputPath, evidenceState);
  await assertOutputAbsent(`${outputPath}.tmp`, evidenceState);
  const result = Object.freeze({
    input: driverInput,
    outputPath,
    status: WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_STATUS,
  });
  BUILD_METADATA.set(result, Object.freeze({
    evidenceState,
    fileSnapshots: Object.freeze([
      selectionRaw,
      handoffRaw,
      nativePresignRaw,
      sourceRunRaw,
      packageRaw,
      policyRaw,
      finalizerRaw,
      runtimeRaw,
      ...staged.rows.map(({ snapshot }) => snapshot),
    ]),
    stagingState,
  }));
  return result;
}

async function assertOutputAbsent(path, rootState) {
  await assertOwnedRoot(rootState, STATUS.evidenceRootInvalid);
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || metadata.isFile() || metadata.isDirectory()) {
      fail(STATUS.outputExists);
    }
    fail(STATUS.outputInvalid);
  } catch (error) {
    if (error instanceof WindowsProductionFinalizerAuthorityInputBuilderError) throw error;
    if (error?.code !== "ENOENT") fail(STATUS.outputInvalid);
  }
}

async function removeOwnedTemporaryFile(rootState, path, identity) {
  if (!identity) return;
  try {
    await assertOwnedRoot(rootState, STATUS.evidenceRootInvalid);
    const current = await lstat(path);
    if (!sameFileObjectIdentity(current, identity)) return;
    await unlink(path);
    await assertOwnedRoot(rootState, STATUS.evidenceRootInvalid);
  } catch {
    // Missing or replaced temporary paths are never removed by cleanup.
  }
}

async function replaceEvidenceRootForTest(path, code) {
  const replacement = `${path}.replaced`;
  try {
    await rename(path, replacement);
    await mkdir(path, { mode: 0o700 });
  } catch {
    fail(code);
  }
}

async function replaceTemporaryPathForTest(path) {
  try {
    await unlink(path);
    await writeFile(path, "raced temporary payload\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    fail(STATUS.outputInvalid);
  }
}

async function mutateFileForTest(snapshot, code) {
  try {
    const bytes = Buffer.from(snapshot.bytes);
    bytes[0] = bytes[0] === 0x7b ? 0x5b : bytes[0] ^ 0x01;
    const handle = await open(snapshot.path, "r+");
    await handle.write(bytes, 0, bytes.length, 0);
    await handle.close();
  } catch {
    fail(code);
  }
}

function serializeDriverOptions(value) {
  // The generated document must be directly accepted by the existing driver.
  // Its validator is intentionally duplicated here only as a shape check:
  // importing the driver would couple this producer to its I/O entrypoint.
  const source = ownRecord(value, DRIVER_KEYS, STATUS.outputInvalid);
  if (typeof source.evidenceRoot !== "string"
      || !isAbsolute(source.evidenceRoot)
      || resolve(source.evidenceRoot) !== source.evidenceRoot
      || source.output !== WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_DRIVER_OUTPUT) {
    fail(STATUS.outputInvalid);
  }
  safeChildFilename(source.handoff, STATUS.outputInvalid);
  safeChildFilename(source.nativePresign, STATUS.outputInvalid);
  safeChildFilename(source.checkoutPackageJson, STATUS.outputInvalid);
  safeChildFilename(source.sourceRunMetadata, STATUS.outputInvalid);
  ownRecord(source.facts, [
    "filesystemBinding",
    "keytarBinding",
    "signerPolicy",
    "nativeModules",
    "runtimeManifest",
    "finalizer",
  ], STATUS.outputInvalid);
  const serialized = stableJson(source);
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_JSON_BYTES) fail(STATUS.outputInvalid);
  return serialized;
}

export function validateWindowsProductionFinalizerAuthorityInputOptions(value) {
  return validateInput(value);
}

export function serializeWindowsProductionFinalizerAuthorityInput(value) {
  try {
    return serializeDriverOptions(value);
  } catch (error) {
    if (error instanceof WindowsProductionFinalizerAuthorityInputBuilderError) throw error;
    fail(STATUS.outputInvalid);
  }
}

export async function writeWindowsProductionFinalizerAuthorityInput(value, dependencies = {}) {
  const selected = await buildWindowsProductionFinalizerAuthorityInput(value, dependencies);
  const roots = normalizeDependencies(dependencies);
  const metadata = BUILD_METADATA.get(selected);
  if (!metadata) fail(STATUS.outputInvalid);
  const serialized = serializeWindowsProductionFinalizerAuthorityInput(selected.input);
  const temporaryPath = `${selected.outputPath}.tmp`;
  let handle;
  let temporaryIdentity = null;
  try {
    if (roots.testOnlyFault === "replace-evidence-before-temp") {
      await replaceEvidenceRootForTest(metadata.evidenceState.path, STATUS.evidenceRootInvalid);
    }
    await assertOwnedRoot(metadata.evidenceState, STATUS.evidenceRootInvalid);
    await assertOwnedRoot(metadata.stagingState, STATUS.stagingRootInvalid);
    for (const snapshot of metadata.fileSnapshots) {
      const maximum = snapshot.path.endsWith(RUNTIME_FILE)
        ? MAXIMUM_RUNTIME_BYTES
        : snapshot.path.endsWith(".node") || snapshot.path.endsWith(".node.manifest.json")
          ? MAXIMUM_NATIVE_BYTES
          : snapshot.size > MAXIMUM_PACKAGE_BYTES
            ? MAXIMUM_JSON_BYTES
            : Math.max(MAXIMUM_PACKAGE_BYTES, snapshot.size);
      const code = snapshot.path.startsWith(metadata.stagingState.path)
        ? STATUS.stagingInvalid
        : STATUS.evidenceFileInvalid;
      await compareInputFile(snapshot, maximum, code, code === STATUS.stagingInvalid
        ? metadata.stagingState
        : metadata.evidenceState);
    }
    if (roots.testOnlyFault === "mutate-handoff-before-publication") {
      await mutateFileForTest(metadata.fileSnapshots[1], STATUS.handoffInvalid);
    }
    if (roots.testOnlyFault === "mutate-runtime-before-publication") {
      const runtime = metadata.fileSnapshots.find((snapshot) => snapshot.path.endsWith(RUNTIME_FILE));
      await mutateFileForTest(runtime, STATUS.runtimeInvalid);
    }
    if (roots.testOnlyFault === "mutate-policy-before-publication") {
      const policy = metadata.fileSnapshots.find((snapshot) => snapshot.path.endsWith("policy.json"));
      await mutateFileForTest(policy, STATUS.policyInvalid);
    }
    if (roots.testOnlyFault === "mutate-handoff-before-publication") {
      await compareInputFile(
        metadata.fileSnapshots[1],
        MAXIMUM_JSON_BYTES,
        STATUS.handoffInvalid,
        metadata.evidenceState,
      );
    }
    if (roots.testOnlyFault === "mutate-runtime-before-publication") {
      const runtime = metadata.fileSnapshots.find((snapshot) => snapshot.path.endsWith(RUNTIME_FILE));
      await compareInputFile(runtime, MAXIMUM_RUNTIME_BYTES, STATUS.runtimeInvalid, metadata.stagingState);
    }
    if (roots.testOnlyFault === "mutate-policy-before-publication") {
      const policy = metadata.fileSnapshots.find((snapshot) => snapshot.path.endsWith("policy.json"));
      await compareInputFile(policy, MAXIMUM_JSON_BYTES, STATUS.policyInvalid, metadata.evidenceState);
    }
    if (roots.testOnlyFault === "replace-evidence-before-publication") {
      await replaceEvidenceRootForTest(metadata.evidenceState.path, STATUS.evidenceRootInvalid);
    }
    await assertOwnedRoot(metadata.evidenceState, STATUS.evidenceRootInvalid);
    await assertOwnedRoot(metadata.stagingState, STATUS.stagingRootInvalid);
    await assertOutputAbsent(selected.outputPath, metadata.evidenceState);
    await assertOutputAbsent(temporaryPath, metadata.evidenceState);
    handle = await open(temporaryPath, "wx", 0o600);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1) fail(STATUS.outputInvalid);
    temporaryIdentity = opened;
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    const finished = await handle.stat();
    if (!sameFileObjectIdentity(opened, finished)
        || finished.nlink !== 1
        || finished.size !== Buffer.byteLength(serialized, "utf8")) fail(STATUS.outputInvalid);
    await handle.close();
    handle = null;
    await assertOwnedRoot(metadata.evidenceState, STATUS.evidenceRootInvalid);
    await assertOutputAbsent(selected.outputPath, metadata.evidenceState);
    try {
      await link(temporaryPath, selected.outputPath);
    } catch (error) {
      if (error?.code === "EEXIST") fail(STATUS.outputExists);
      fail(STATUS.outputInvalid);
    }
    if (roots.testOnlyFault === "replace-temp-before-cleanup") {
      await replaceTemporaryPathForTest(temporaryPath);
    }
    const output = await lstat(selected.outputPath);
    if (!sameFileObjectIdentity(output, temporaryIdentity) || output.isSymbolicLink()) {
      fail(STATUS.outputInvalid);
    }
    await removeOwnedTemporaryFile(
      metadata.evidenceState,
      temporaryPath,
      temporaryIdentity,
    );
    await assertOwnedRoot(metadata.evidenceState, STATUS.evidenceRootInvalid);
  } catch (error) {
    if (error instanceof WindowsProductionFinalizerAuthorityInputBuilderError) throw error;
    fail(STATUS.outputInvalid);
  } finally {
    await handle?.close().catch(() => {});
    await removeOwnedTemporaryFile(
      metadata.evidenceState,
      temporaryPath,
      temporaryIdentity,
    );
  }
  return selected;
}

export async function runWindowsProductionFinalizerAuthorityInput(value, dependencies = {}) {
  return writeWindowsProductionFinalizerAuthorityInput(value, dependencies);
}

export function parseWindowsProductionFinalizerAuthorityInputArguments(argv) {
  if (!Array.isArray(argv)) fail(STATUS.inputInvalid);
  if (argv.length === 2 && argv[0] === "--options") {
    if (typeof argv[1] !== "string" || argv[1].startsWith("--")) fail(STATUS.inputInvalid);
    return Object.freeze({ mode: "options", path: safeAbsolutePath(argv[1], STATUS.inputInvalid) });
  }
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = CLI_FLAGS.get(argv[index]);
    if (!key || Object.hasOwn(values, key)) fail(STATUS.inputInvalid);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) fail(STATUS.inputInvalid);
    values[key] = value;
    index += 1;
  }
  if (Object.keys(values).length !== INPUT_KEYS.length) fail(STATUS.inputMissing);
  return Object.freeze({ mode: "values", values: validateInput(values) });
}

async function readOptionsFile(path) {
  const raw = await captureRegularFile(path, MAXIMUM_JSON_BYTES, STATUS.inputInvalid);
  return parseJson(raw.bytes, MAXIMUM_JSON_BYTES, STATUS.inputInvalid);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parseWindowsProductionFinalizerAuthorityInputArguments(argv);
    const value = parsed.mode === "options" ? validateInput(await readOptionsFile(parsed.path)) : parsed.values;
    await writeWindowsProductionFinalizerAuthorityInput(value);
    process.stdout.write(`${WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_STATUS}\n`);
  } catch (error) {
    const known = new Set(Object.values(STATUS));
    const status = known.has(error?.code) ? error.code : STATUS.inputInvalid;
    process.stderr.write(`${status}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  await main();
}
