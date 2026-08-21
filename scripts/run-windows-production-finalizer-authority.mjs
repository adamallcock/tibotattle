#!/usr/bin/env node

/**
 * Offline driver for the Windows production-finalizer authority join.
 *
 * This file owns only bounded evidence I/O.  It never talks to GitHub, Azure,
 * TrustedSigning, electron-builder, or a Windows staging tree.  The three
 * raw subjects are passed unchanged to build-windows-production-finalizer-
 * authority.mjs, which hashes each subject before parsing it.  The closed
 * facts projection is checked against that result so a caller cannot replace
 * the filesystem, Keytar, signer, or native-module binding with a parallel
 * claim.
 *
 * Node's fs/promises API does not expose openat-style directory descriptors.
 * The protected workflow must therefore grant this driver exclusive ownership
 * of the evidence root and prevent concurrent rename/replacement writers.
 * The captured root identity and repeated lstat/realpath checks detect a
 * replacement, but they cannot eliminate that kernel-level race themselves.
 */

import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isProxy } from "node:util/types";
import { fileURLToPath } from "node:url";

import {
  buildWindowsProductionFinalizerAuthority,
  WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS,
} from "./build-windows-production-finalizer-authority.mjs";
import {
  validateWindowsPortabilityRunMetadata,
} from "./verify-windows-finalizer-qualification-handoff.mjs";
import {
  WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256,
} from "./windows-native-presign.mjs";
import {
  WINDOWS_PRODUCTION_AUTHORITY_NATIVE_MODULES,
  WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF,
  WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY,
  WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH,
  WINDOWS_PRODUCTION_AUTHORITY_SOURCE_WORKFLOW,
  serializeWindowsProductionAuthorityManifest,
} from "../src/platform/windows-production-authority-manifest.js";

export const WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_STATUS =
  "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_PASSED";

export const WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_FIXED_STATUS = Object.freeze({
  inputInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_INPUT_INVALID",
  inputMissing: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_INPUT_MISSING",
  optionsInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_OPTIONS_INVALID",
  optionsNoncanonical: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_OPTIONS_NONCANONICAL",
  evidenceRootInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_EVIDENCE_ROOT_INVALID",
  evidenceFileInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_EVIDENCE_FILE_INVALID",
  factsInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_FACTS_INVALID",
  handoffInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_HANDOFF_INVALID",
  handoffNoncanonical: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_HANDOFF_NONCANONICAL",
  presignInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_PRESIGN_INVALID",
  presignNoncanonical: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_PRESIGN_NONCANONICAL",
  packageInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_PACKAGE_INVALID",
  sourceRunInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_SOURCE_RUN_INVALID",
  sourceRunMismatch: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_SOURCE_RUN_MISMATCH",
  bindingMismatch: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_BINDING_MISMATCH",
  outputInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_OUTPUT_INVALID",
  outputExists: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_OUTPUT_EXISTS",
  authorityInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_AUTHORITY_INVALID",
  passed: WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_STATUS,
});

const STATUS = WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_FIXED_STATUS;
const SCRIPT_FILE = fileURLToPath(import.meta.url);

const OPTION_KEYS = Object.freeze([
  "evidenceRoot",
  "output",
  "handoff",
  "nativePresign",
  "checkoutPackageJson",
  "sourceRunMetadata",
  "facts",
]);
const FACTS_KEYS = Object.freeze([
  "filesystemBinding",
  "keytarBinding",
  "signerPolicy",
  "nativeModules",
  "runtimeManifest",
  "finalizer",
]);
const BINDING_KEYS = Object.freeze(["bytes", "sha256"]);
const SIGNER_POLICY_KEYS = Object.freeze(["publisher", "match"]);
const RUNTIME_MANIFEST_KEYS = Object.freeze(["packagedPath", "bytes", "sha256"]);
const FINALIZER_KEYS = Object.freeze(["run", "runAttempt", "headSha"]);
const NATIVE_MODULE_KEYS = Object.freeze([
  "name",
  "packagedPath",
  "unsignedBytes",
  "signedBytes",
  "unsignedSha256",
  "signedSha256",
]);
const FLAG_KEYS = Object.freeze([
  "evidenceRoot",
  "output",
  "handoff",
  "nativePresign",
  "checkoutPackageJson",
  "sourceRunMetadata",
  "facts",
]);
const FLAG_NAMES = Object.freeze(new Map([
  ["--evidence-root", "evidenceRoot"],
  ["--output", "output"],
  ["--handoff", "handoff"],
  ["--native-presign", "nativePresign"],
  ["--checkout-package-json", "checkoutPackageJson"],
  ["--source-run-metadata", "sourceRunMetadata"],
  ["--facts", "facts"],
]));

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const PUBLISHER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .,&()=+_-]{0,255}$/u;
const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const MAXIMUM_OPTIONS_BYTES = 64 * 1024;
const MAXIMUM_FACTS_BYTES = 64 * 1024;
const MAXIMUM_HANDOFF_BYTES = 512 * 1024;
const MAXIMUM_PRESIGN_BYTES = 64 * 1024;
const MAXIMUM_PACKAGE_JSON_BYTES = 64 * 1024;
const MAXIMUM_SOURCE_RUN_BYTES = 512 * 1024;
const MAXIMUM_PATH_BYTES = 1024;
const MAXIMUM_FILENAME_BYTES = 128;
const MAXIMUM_JSON_DEPTH = 64;
const MAXIMUM_JSON_NODES = 4096;
const PORTABLE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DOS_RESERVED_BASENAMES = new Set([
  "AUX",
  "CON",
  "NUL",
  "PRN",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);
const TEST_OUTPUT_FAULT_POINTS = new Set([
  "after-temp-open",
  "after-temp-write",
  "after-temp-sync",
  "before-publish",
  "after-publish",
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

const EXPECTED_SOURCE_WORKFLOW = WINDOWS_PRODUCTION_AUTHORITY_SOURCE_WORKFLOW;
const EXPECTED_FINALIZER_REF = WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF;
const EXPECTED_RUNTIME_PATH = WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH;
const EXPECTED_NATIVE_MODULES = WINDOWS_PRODUCTION_AUTHORITY_NATIVE_MODULES;

const KNOWN_DRIVER_STATUSES = new Set(Object.values(STATUS));
const BUILDER_STATUS_TO_DRIVER_STATUS = Object.freeze([
  ["HANDOFF_NONCANONICAL", STATUS.handoffNoncanonical],
  ["HANDOFF_", STATUS.handoffInvalid],
  ["PRESIGN_NONCANONICAL", STATUS.presignNoncanonical],
  ["PRESIGN_", STATUS.presignInvalid],
  ["SOURCE_RUN_MISMATCH", STATUS.sourceRunMismatch],
  ["SOURCE_RUN_", STATUS.sourceRunInvalid],
  ["RUNTIME_", STATUS.factsInvalid],
  ["FINALIZER_", STATUS.factsInvalid],
  ["PUBLISHER_", STATUS.bindingMismatch],
  ["MODULE_", STATUS.bindingMismatch],
  ["AUTHORITY_", STATUS.authorityInvalid],
  ["INPUT_", STATUS.authorityInvalid],
]);

export class WindowsProductionFinalizerAuthorityDriverError extends Error {
  constructor(code) {
    super("Windows production finalizer authority driver failed");
    this.name = "WindowsProductionFinalizerAuthorityDriverError";
    this.code = code;
  }
}

function fail(code) {
  throw new WindowsProductionFinalizerAuthorityDriverError(code);
}

function isKnownStatus(value) {
  return typeof value === "string" && KNOWN_DRIVER_STATUSES.has(value);
}

function rejectProxy(value, code) {
  try {
    if (isProxy(value)) fail(code);
  } catch {
    fail(code);
  }
}

function snapshotRecord(value, keys, code) {
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
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
        || descriptor.get !== undefined
        || descriptor.set !== undefined) {
      fail(code);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function snapshotArray(value, length, code) {
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
  const expected = [
    ...Array.from({ length }, (_, index) => String(index)),
    "length",
  ];
  if (ownKeys.length !== expected.length
      || ownKeys.some((key) => typeof key !== "string" || !expected.includes(key))) {
    fail(code);
  }
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, "value")
      || lengthDescriptor.value !== length
      || lengthDescriptor.enumerable !== false
      || lengthDescriptor.get !== undefined
      || lengthDescriptor.set !== undefined) {
    fail(code);
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
        || descriptor.get !== undefined
        || descriptor.set !== undefined) {
      fail(code);
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

function assertString(value, pattern, code, maximumBytes = MAXIMUM_PATH_BYTES) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\0")
      || Buffer.byteLength(value, "utf8") > maximumBytes
      || !pattern.test(value)) {
    fail(code);
  }
  return value;
}

function assertSha256(value, code) {
  return assertString(value, SHA256_PATTERN, code, 64);
}

function assertRevision(value, code) {
  return assertString(value, REVISION_PATTERN, code, 40);
}

function assertPositiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}

function assertRelativeEvidencePath(value, code) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\0")
      || value.includes(":")
      || value.includes("\\")
      || value.includes("/")
      || isAbsolute(value)
      || Buffer.byteLength(value, "utf8") > MAXIMUM_FILENAME_BYTES
      || !PORTABLE_FILENAME_PATTERN.test(value)
      || value.endsWith(".")
      || value.endsWith(" ")) {
    fail(code);
  }
  const basename = value.split(".", 1)[0].toUpperCase();
  if (DOS_RESERVED_BASENAMES.has(basename)) fail(code);
  return value;
}

function assertAbsoluteEvidenceRoot(value, code) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\0")
      || !isAbsolute(value)
      || resolve(value) !== value
      || Buffer.byteLength(value, "utf8") > MAXIMUM_PATH_BYTES) {
    fail(code);
  }
  return value;
}

function assertVersion(value, code) {
  return assertString(value, VERSION_PATTERN, code, 32);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function sameStableValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function validateBinding(value, code) {
  const source = snapshotRecord(value, BINDING_KEYS, code);
  return Object.freeze({
    bytes: assertPositiveInteger(source.bytes, code),
    sha256: assertSha256(source.sha256, code),
  });
}

function validateFacts(value) {
  const source = snapshotRecord(value, FACTS_KEYS, STATUS.factsInvalid);
  const filesystemBinding = validateBinding(source.filesystemBinding, STATUS.factsInvalid);
  const keytarBinding = validateBinding(source.keytarBinding, STATUS.factsInvalid);
  if (keytarBinding.sha256 !== WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256) {
    fail(STATUS.factsInvalid);
  }

  const signerPolicy = snapshotRecord(
    source.signerPolicy,
    SIGNER_POLICY_KEYS,
    STATUS.factsInvalid,
  );
  if (typeof signerPolicy.publisher !== "string"
      || signerPolicy.publisher.length === 0
      || signerPolicy.publisher !== signerPolicy.publisher.trim()
      || !PUBLISHER_PATTERN.test(signerPolicy.publisher)
      || signerPolicy.match !== "exact") {
    fail(STATUS.factsInvalid);
  }

  const nativeModules = snapshotArray(
    source.nativeModules,
    EXPECTED_NATIVE_MODULES.length,
    STATUS.factsInvalid,
  ).map((value, index) => {
    const module = snapshotRecord(value, NATIVE_MODULE_KEYS, STATUS.factsInvalid);
    const expected = EXPECTED_NATIVE_MODULES[index];
    if (module.name !== expected.name || module.packagedPath !== expected.packagedPath) {
      fail(STATUS.factsInvalid);
    }
    const normalized = {
      name: module.name,
      packagedPath: module.packagedPath,
      unsignedBytes: assertPositiveInteger(module.unsignedBytes, STATUS.factsInvalid),
      signedBytes: assertPositiveInteger(module.signedBytes, STATUS.factsInvalid),
      unsignedSha256: assertSha256(module.unsignedSha256, STATUS.factsInvalid),
      signedSha256: assertSha256(module.signedSha256, STATUS.factsInvalid),
    };
    if (normalized.unsignedSha256 === normalized.signedSha256) fail(STATUS.factsInvalid);
    if (index === 1 && normalized.unsignedSha256 !== keytarBinding.sha256) {
      fail(STATUS.factsInvalid);
    }
    if (index === 0
        && (normalized.unsignedBytes !== filesystemBinding.bytes
          || normalized.unsignedSha256 !== filesystemBinding.sha256)) {
      fail(STATUS.factsInvalid);
    }
    return Object.freeze(normalized);
  });

  const runtimeManifest = snapshotRecord(
    source.runtimeManifest,
    RUNTIME_MANIFEST_KEYS,
    STATUS.factsInvalid,
  );
  if (runtimeManifest.packagedPath !== EXPECTED_RUNTIME_PATH) fail(STATUS.factsInvalid);
  const normalizedRuntime = Object.freeze({
    packagedPath: runtimeManifest.packagedPath,
    bytes: assertPositiveInteger(runtimeManifest.bytes, STATUS.factsInvalid),
    sha256: assertSha256(runtimeManifest.sha256, STATUS.factsInvalid),
  });

  const finalizer = snapshotRecord(source.finalizer, FINALIZER_KEYS, STATUS.factsInvalid);
  const normalizedFinalizer = Object.freeze({
    run: assertPositiveInteger(finalizer.run, STATUS.factsInvalid),
    runAttempt: assertPositiveInteger(finalizer.runAttempt, STATUS.factsInvalid),
    headSha: assertRevision(finalizer.headSha, STATUS.factsInvalid),
  });

  return Object.freeze({
    filesystemBinding,
    keytarBinding,
    signerPolicy: Object.freeze({
      publisher: signerPolicy.publisher,
      match: signerPolicy.match,
    }),
    nativeModules: Object.freeze(nativeModules),
    runtimeManifest: normalizedRuntime,
    finalizer: normalizedFinalizer,
  });
}

/** Validate and detach the closed options object used by the driver. */
export function validateWindowsProductionFinalizerAuthorityDriverOptions(value) {
  const source = snapshotRecord(value, OPTION_KEYS, STATUS.optionsInvalid);
  const evidenceRoot = assertAbsoluteEvidenceRoot(
    source.evidenceRoot,
    STATUS.optionsInvalid,
  );
  const output = assertRelativeEvidencePath(source.output, STATUS.optionsInvalid);
  const handoff = assertRelativeEvidencePath(source.handoff, STATUS.optionsInvalid);
  const nativePresign = assertRelativeEvidencePath(
    source.nativePresign,
    STATUS.optionsInvalid,
  );
  const checkoutPackageJson = assertRelativeEvidencePath(
    source.checkoutPackageJson,
    STATUS.optionsInvalid,
  );
  const sourceRunMetadata = assertRelativeEvidencePath(
    source.sourceRunMetadata,
    STATUS.optionsInvalid,
  );
  const paths = [output, handoff, nativePresign, checkoutPackageJson, sourceRunMetadata];
  const foldedPaths = paths.map((path) => path.toLowerCase());
  if (new Set(foldedPaths).size !== foldedPaths.length) fail(STATUS.optionsInvalid);
  return deepFreeze({
    evidenceRoot,
    output,
    handoff,
    nativePresign,
    checkoutPackageJson,
    sourceRunMetadata,
    facts: validateFacts(source.facts),
  });
}

function consumeJsonString(text, code) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") === 0) fail(code);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(code);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail(code);
  return parsed;
}

/** Parse a bounded options/facts JSON text and reject duplicate object keys. */
export function parseWindowsProductionFinalizerAuthorityDriverJson(
  value,
  code = STATUS.optionsInvalid,
  maximumBytes = MAXIMUM_OPTIONS_BYTES,
) {
  if (!Buffer.isBuffer(value) && typeof value !== "string") fail(code);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (bytes.length === 0 || bytes.length > maximumBytes) fail(code);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(code);
  }
  // Canonical evidence documents are newline-terminated by their producers.
  // Options/facts are configuration rather than provenance subjects, so their
  // whitespace/order is accepted; duplicate keys are rejected by the small
  // structural scanner below before JSON.parse can collapse them.
  try {
    rejectDuplicateJsonKeys(text, code);
    return consumeJsonString(text, code);
  } catch (error) {
    if (error instanceof WindowsProductionFinalizerAuthorityDriverError) throw error;
    fail(code);
  }
}

function rejectDuplicateJsonKeys(text, code) {
  let index = 0;
  const length = text.length;
  let nodes = 0;
  const skipWhitespace = () => {
    while (index < length && /\s/u.test(text[index])) index += 1;
  };
  const parseString = () => {
    const start = index;
    if (text[index] !== '"') fail(code);
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
          fail(code);
        }
      }
    }
    fail(code);
  };
  const parseValue = (depth = 0) => {
    nodes += 1;
    if (depth > MAXIMUM_JSON_DEPTH || nodes > MAXIMUM_JSON_NODES) fail(code);
    skipWhitespace();
    const current = text[index];
    if (current === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      for (;;) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) fail(code);
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ":") fail(code);
        index += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") fail(code);
        index += 1;
      }
    }
    if (current === "[") {
      index += 1;
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      for (;;) {
        parseValue(depth + 1);
        skipWhitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") fail(code);
        index += 1;
      }
    }
    if (current === '"') {
      parseString();
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
    if (!number) fail(code);
    index += number[0].length;
  };
  parseValue();
  skipWhitespace();
  if (index !== length) fail(code);
}

function mapBuilderError(error) {
  if (error instanceof WindowsProductionFinalizerAuthorityDriverError) return error;
  const code = error?.code;
  if (typeof code === "string") {
    const selected = BUILDER_STATUS_TO_DRIVER_STATUS.find(([prefix]) => code.includes(prefix));
    if (selected) return new WindowsProductionFinalizerAuthorityDriverError(selected[1]);
  }
  return new WindowsProductionFinalizerAuthorityDriverError(STATUS.authorityInvalid);
}

function sameSourceProjection(sourceRun, authority) {
  const selected = authority.sourceQualification;
  return sourceRun.workflowPath === EXPECTED_SOURCE_WORKFLOW
    && sourceRun.repository === WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY
    && sourceRun.databaseId === selected.run
    && sourceRun.runAttempt === selected.runAttempt
    && sourceRun.ref === selected.ref
    && sourceRun.headSha === selected.revision
    && sourceRun.event === authority.finalizer.event
    && sourceRun.status === "completed"
    && sourceRun.conclusion === "success";
}

function sameFacts(authority, facts) {
  const nativeModules = authority.nativeModules;
  return sameStableValue(authority.sourceQualification.binding, facts.filesystemBinding)
    && sameStableValue({
      bytes: nativeModules[1]?.unsignedBytes,
      sha256: nativeModules[1]?.unsignedSha256,
    }, facts.keytarBinding)
    && sameStableValue(authority.signerPolicy, facts.signerPolicy)
    && sameStableValue(nativeModules, facts.nativeModules)
    && sameStableValue(authority.runtimeManifest, facts.runtimeManifest)
    && sameStableValue({
      run: authority.finalizer.run,
      runAttempt: authority.finalizer.runAttempt,
      headSha: authority.finalizer.headSha,
    }, facts.finalizer);
}

function sameFileIdentity(left, right) {
  return left.isFile()
    && right.isFile()
    && !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function rootIdentity(metadata) {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    birthtimeNs: metadata.birthtimeNs,
    uid: metadata.uid,
    mode: metadata.mode,
  };
}

function sameRootIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs
    && left.uid === right.uid
    && left.mode === right.mode;
}

function assertRunnerOwnedRootMetadata(metadata) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(STATUS.evidenceRootInvalid);
  const runnerUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (runnerUid !== null && metadata.uid !== undefined && metadata.uid !== runnerUid) {
    fail(STATUS.evidenceRootInvalid);
  }
  if (process.platform !== "win32" && (metadata.mode & 0o022) !== 0) {
    fail(STATUS.evidenceRootInvalid);
  }
}

async function captureEvidenceRoot(root) {
  try {
    const rootMetadata = await lstat(root);
    assertRunnerOwnedRootMetadata(rootMetadata);
    const canonicalRoot = await realpath(root);
    const canonicalMetadata = await lstat(canonicalRoot);
    assertRunnerOwnedRootMetadata(canonicalMetadata);
    if (!sameRootIdentity(rootMetadata, canonicalMetadata)) {
      fail(STATUS.evidenceRootInvalid);
    }
    return Object.freeze({
      path: root,
      canonicalPath: canonicalRoot,
      identity: Object.freeze(rootIdentity(rootMetadata)),
    });
  } catch (error) {
    if (error instanceof WindowsProductionFinalizerAuthorityDriverError) throw error;
    fail(STATUS.evidenceRootInvalid);
  }
}

async function assertEvidenceRoot(rootState) {
  try {
    const current = await lstat(rootState.path);
    assertRunnerOwnedRootMetadata(current);
    if (!sameRootIdentity(rootState.identity, rootIdentity(current))) {
      fail(STATUS.evidenceRootInvalid);
    }
    const canonical = await realpath(rootState.path);
    if (canonical !== rootState.canonicalPath) fail(STATUS.evidenceRootInvalid);
    const canonicalMetadata = await lstat(canonical);
    assertRunnerOwnedRootMetadata(canonicalMetadata);
    if (!sameRootIdentity(rootState.identity, rootIdentity(canonicalMetadata))) {
      fail(STATUS.evidenceRootInvalid);
    }
  } catch (error) {
    if (error instanceof WindowsProductionFinalizerAuthorityDriverError) throw error;
    fail(STATUS.evidenceRootInvalid);
  }
}

async function readBoundedRegularFile(
  path,
  maximumBytes,
  code = STATUS.evidenceFileInvalid,
  rootState = null,
) {
  let handle;
  try {
    if (rootState) await assertEvidenceRoot(rootState);
    const before = await lstat(path);
    if (!before.isFile()
        || before.isSymbolicLink()
        || before.nlink !== 1
        || before.size <= 0
        || before.size > maximumBytes) {
      fail(code);
    }
    handle = await open(path, READ_ONLY_FLAGS);
    if (rootState) await assertEvidenceRoot(rootState);
    const opened = await handle.stat();
    if (!sameFileIdentity(before, opened)
        || opened.nlink !== 1
        || opened.size !== before.size) fail(code);
    const afterOpen = await lstat(path);
    if (!sameFileIdentity(before, afterOpen)
        || !sameFileIdentity(opened, afterOpen)
        || afterOpen.nlink !== 1) {
      fail(code);
    }

    const chunks = [];
    let total = 0;
    while (total <= maximumBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes - total + 1));
      const result = await handle.read(chunk, 0, chunk.length, null);
      if (!Number.isSafeInteger(result.bytesRead)
          || result.bytesRead < 0
          || result.bytesRead > chunk.length) {
        fail(code);
      }
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      total += result.bytesRead;
      if (total > maximumBytes) fail(code);
    }
    const finished = await handle.stat();
    if (!sameFileIdentity(opened, finished)
        || finished.nlink !== 1
        || finished.size !== total) fail(code);
    const afterRead = await lstat(path);
    if (!sameFileIdentity(finished, afterRead)
        || afterRead.nlink !== 1
        || afterRead.size !== total) fail(code);
    if (rootState) await assertEvidenceRoot(rootState);
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof WindowsProductionFinalizerAuthorityDriverError) throw error;
    fail(code);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function decodeJsonBytes(bytes, code, maximumBytes = MAXIMUM_OPTIONS_BYTES) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(code);
  }
  return parseWindowsProductionFinalizerAuthorityDriverJson(bytes, code, maximumBytes);
}

function validateCheckoutPackageJsonBytes(bytes) {
  // Preserve the raw-subject hash-before-parse ordering even though the pure
  // builder repeats the hash as its authoritative provenance operation.
  createHash("sha256").update(bytes).digest("hex");
  parseWindowsProductionFinalizerAuthorityDriverJson(
    bytes,
    STATUS.packageInvalid,
    MAXIMUM_PACKAGE_JSON_BYTES,
  );
}

async function readEvidence(rootState, filename, maximumBytes, code) {
  await assertEvidenceRoot(rootState);
  const path = join(rootState.path, filename);
  return readBoundedRegularFile(path, maximumBytes, code, rootState);
}

async function ensureOutputTarget(rootState, filename) {
  await assertEvidenceRoot(rootState);
  const outputPath = join(rootState.path, filename);
  try {
    const existing = await lstat(outputPath);
    if (existing.isSymbolicLink() || existing.isFile() || existing.isDirectory()) {
      fail(STATUS.outputExists);
    }
    fail(STATUS.outputInvalid);
  } catch (error) {
    if (error instanceof WindowsProductionFinalizerAuthorityDriverError) throw error;
    if (error?.code !== "ENOENT") fail(STATUS.outputInvalid);
  }
  return outputPath;
}

async function syncDirectory(rootState) {
  // Node cannot open a directory handle for fsync on Windows. The temp file
  // itself is flushed; protected Windows execution must retain this explicit
  // platform durability boundary alongside the root identity gate.
  if (process.platform === "win32") return;
  let handle;
  try {
    await assertEvidenceRoot(rootState);
    handle = await open(rootState.path, fsConstants.O_RDONLY);
    await handle.sync();
    await assertEvidenceRoot(rootState);
  } catch {
    fail(STATUS.outputInvalid);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function injectOutputFault(faultAt, point) {
  if (faultAt === point) fail(STATUS.outputInvalid);
}

async function removeOwnedTemp(rootState, tempPath, tempIdentity) {
  try {
    await assertEvidenceRoot(rootState);
    const current = await lstat(tempPath);
    if (sameFileIdentity(current, tempIdentity)) {
      await unlink(tempPath);
      await assertEvidenceRoot(rootState);
    }
  } catch {
    // A missing or replaced temp path is never removed by this cleanup path.
  }
}

async function writeOnce(rootState, filename, bytes, faultAt = null) {
  const outputPath = await ensureOutputTarget(rootState, filename);
  const temporaryPath = join(
    rootState.path,
    `.${filename}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  let temporaryIdentity = null;
  let published = false;
  try {
    await assertEvidenceRoot(rootState);
    handle = await open(temporaryPath, "wx", 0o600);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1) {
      fail(STATUS.outputInvalid);
    }
    temporaryIdentity = opened;
    injectOutputFault(faultAt, "after-temp-open");
    await handle.writeFile(bytes);
    await handle.sync();
    injectOutputFault(faultAt, "after-temp-sync");
    await assertEvidenceRoot(rootState);
    const finished = await handle.stat();
    if (!sameFileIdentity(opened, finished)
        || !finished.isFile()
        || finished.nlink !== 1
        || finished.size !== bytes.length) {
      fail(STATUS.outputInvalid);
    }
    injectOutputFault(faultAt, "after-temp-write");
    await handle.close();
    handle = null;
    await assertEvidenceRoot(rootState);
    injectOutputFault(faultAt, "before-publish");
    try {
      await link(temporaryPath, outputPath);
      published = true;
    } catch (error) {
      if (error?.code === "EEXIST") fail(STATUS.outputExists);
      fail(STATUS.outputInvalid);
    }
    injectOutputFault(faultAt, "after-publish");
    await syncDirectory(rootState);
    await removeOwnedTemp(rootState, temporaryPath, temporaryIdentity);
    await syncDirectory(rootState);
    await assertEvidenceRoot(rootState);
    const target = await lstat(outputPath);
    if (!sameFileIdentity(target, temporaryIdentity)
        || target.isSymbolicLink()
        || target.nlink !== 1
        || target.size !== bytes.length) {
      fail(STATUS.outputInvalid);
    }
  } catch (error) {
    if (error instanceof WindowsProductionFinalizerAuthorityDriverError) throw error;
    fail(STATUS.outputInvalid);
  } finally {
    await handle?.close().catch(() => {});
    if (temporaryIdentity && (!published || handle === null)) {
      await removeOwnedTemp(rootState, temporaryPath, temporaryIdentity);
    }
  }
}

/** Test-only output seam; production run paths never accept a fault selector. */
export async function writeWindowsProductionFinalizerAuthorityOutputForTest(
  evidenceRoot,
  filename,
  bytes,
  faultAt = null,
) {
  if (!TEST_OUTPUT_FAULT_POINTS.has(faultAt)) {
    if (faultAt !== null) fail(STATUS.inputInvalid);
  }
  const root = assertAbsoluteEvidenceRoot(evidenceRoot, STATUS.inputInvalid);
  const output = assertRelativeEvidencePath(filename, STATUS.inputInvalid);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) fail(STATUS.inputInvalid);
  const rootState = await captureEvidenceRoot(root);
  await writeOnce(rootState, output, bytes, faultAt);
}

function sourceProjectionMatches(sourceRun, authority) {
  try {
    const projection = validateWindowsPortabilityRunMetadata(sourceRun, {
      repository: WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY,
      revision: authority.sourceRevision,
      ref: EXPECTED_FINALIZER_REF,
    });
    return sameSourceProjection(projection, authority);
  } catch {
    return false;
  }
}

/**
 * Build and publish one authority manifest under an existing evidence root.
 * The return value is content-free with respect to the source REST object and
 * filesystem paths; callers receive the validated manifest for local tests.
 */
export async function runWindowsProductionFinalizerAuthority(
  value,
  ...unexpectedArguments
) {
  if (unexpectedArguments.length > 0) fail(STATUS.inputInvalid);
  const options = validateWindowsProductionFinalizerAuthorityDriverOptions(value);
  const rootState = await captureEvidenceRoot(options.evidenceRoot);
  const [handoffBytes, nativePresignBytes, checkoutPackageJsonBytes, sourceRunBytes] =
    await Promise.all([
      readEvidence(rootState, options.handoff, MAXIMUM_HANDOFF_BYTES, STATUS.handoffInvalid),
      readEvidence(rootState, options.nativePresign, MAXIMUM_PRESIGN_BYTES, STATUS.presignInvalid),
      readEvidence(rootState, options.checkoutPackageJson, MAXIMUM_PACKAGE_JSON_BYTES, STATUS.packageInvalid),
      readEvidence(rootState, options.sourceRunMetadata, MAXIMUM_SOURCE_RUN_BYTES, STATUS.sourceRunInvalid),
    ]);
  const sourceRun = decodeJsonBytes(
    sourceRunBytes,
    STATUS.sourceRunInvalid,
    MAXIMUM_SOURCE_RUN_BYTES,
  );
  validateCheckoutPackageJsonBytes(checkoutPackageJsonBytes);
  await assertEvidenceRoot(rootState);

  let authority;
  try {
    authority = buildWindowsProductionFinalizerAuthority({
      handoffBytes,
      nativePresignBytes,
      sourceRunMetadata: sourceRun,
      checkoutPackageJsonBytes,
      publisher: options.facts.signerPolicy.publisher,
      runtimeManifest: options.facts.runtimeManifest,
      finalizer: options.facts.finalizer,
    });
  } catch (error) {
    throw mapBuilderError(error);
  }
  await assertEvidenceRoot(rootState);
  if (!sourceProjectionMatches(sourceRun, authority)) fail(STATUS.sourceRunMismatch);
  try {
    if (!sameFacts(authority, options.facts)) fail(STATUS.bindingMismatch);
  } catch (error) {
    if (error instanceof WindowsProductionFinalizerAuthorityDriverError) throw error;
    fail(STATUS.authorityInvalid);
  }

  let serialized;
  try {
    serialized = serializeWindowsProductionAuthorityManifest(authority);
  } catch {
    fail(STATUS.authorityInvalid);
  }
  if (typeof serialized !== "string" || !serialized.endsWith("\n")) {
    fail(STATUS.authorityInvalid);
  }
  await writeOnce(rootState, options.output, Buffer.from(serialized, "utf8"));
  await assertEvidenceRoot(rootState);
  return Object.freeze({
    status: WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_STATUS,
    authority,
  });
}

/** Parse either --options or the complete fixed evidence-file flag vector. */
export function parseWindowsProductionFinalizerAuthorityDriverArguments(argv) {
  if (!Array.isArray(argv)) fail(STATUS.inputInvalid);
  if (argv.length === 0) fail(STATUS.inputMissing);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--options") {
      if (argv.length !== 2 || values.size !== 0) fail(STATUS.inputInvalid);
      const path = argv[index + 1];
      if (typeof path !== "string" || path.length === 0 || path.startsWith("--")) {
        fail(STATUS.inputInvalid);
      }
      values.set("options", path);
      index += 1;
      continue;
    }
    const key = FLAG_NAMES.get(flag);
    if (!key || values.has(key)) fail(STATUS.inputInvalid);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      fail(STATUS.inputInvalid);
    }
    values.set(key, value);
    index += 1;
  }
  if (values.has("options")) return Object.freeze({ mode: "options", path: values.get("options") });
  if (values.size !== FLAG_KEYS.length) fail(STATUS.inputMissing);
  return Object.freeze({
    mode: "flags",
    values: Object.freeze(Object.fromEntries(FLAG_KEYS.map((key) => [key, values.get(key)]))),
  });
}

export const parseArguments = parseWindowsProductionFinalizerAuthorityDriverArguments;
export const validateOptions = validateWindowsProductionFinalizerAuthorityDriverOptions;
export const run = runWindowsProductionFinalizerAuthority;

async function optionsFromArguments(parsed) {
  if (parsed.mode === "options") {
    if (!isAbsolute(parsed.path) || resolve(parsed.path) !== parsed.path) fail(STATUS.inputInvalid);
    const bytes = await readBoundedRegularFile(parsed.path, MAXIMUM_OPTIONS_BYTES, STATUS.optionsInvalid);
    const value = parseWindowsProductionFinalizerAuthorityDriverJson(bytes, STATUS.optionsInvalid);
    return validateWindowsProductionFinalizerAuthorityDriverOptions(value);
  }
  const values = parsed.values;
  const evidenceRoot = assertAbsoluteEvidenceRoot(values.evidenceRoot, STATUS.inputInvalid);
  const factsPath = assertRelativeEvidencePath(values.facts, STATUS.inputInvalid);
  const fixedPaths = [
    factsPath,
    assertRelativeEvidencePath(values.output, STATUS.inputInvalid),
    assertRelativeEvidencePath(values.handoff, STATUS.inputInvalid),
    assertRelativeEvidencePath(values.nativePresign, STATUS.inputInvalid),
    assertRelativeEvidencePath(values.checkoutPackageJson, STATUS.inputInvalid),
    assertRelativeEvidencePath(values.sourceRunMetadata, STATUS.inputInvalid),
  ];
  const foldedFixedPaths = fixedPaths.map((path) => path.toLowerCase());
  if (new Set(foldedFixedPaths).size !== foldedFixedPaths.length) fail(STATUS.inputInvalid);
  const rootState = await captureEvidenceRoot(evidenceRoot);
  const factsBytes = await readEvidence(rootState, factsPath, MAXIMUM_FACTS_BYTES, STATUS.factsInvalid);
  await assertEvidenceRoot(rootState);
  const facts = parseWindowsProductionFinalizerAuthorityDriverJson(factsBytes, STATUS.factsInvalid);
  return validateWindowsProductionFinalizerAuthorityDriverOptions({
    evidenceRoot,
    output: values.output,
    handoff: values.handoff,
    nativePresign: values.nativePresign,
    checkoutPackageJson: values.checkoutPackageJson,
    sourceRunMetadata: values.sourceRunMetadata,
    facts,
  });
}

export async function runWindowsProductionFinalizerAuthorityArguments(argv) {
  const parsed = parseWindowsProductionFinalizerAuthorityDriverArguments(argv);
  const options = await optionsFromArguments(parsed);
  return runWindowsProductionFinalizerAuthority(options);
}

export const runArguments = runWindowsProductionFinalizerAuthorityArguments;

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await runWindowsProductionFinalizerAuthorityArguments(argv);
    process.stdout.write(`${result.status}\n`);
    return result;
  } catch (error) {
    const status = isKnownStatus(error?.code) ? error.code : STATUS.inputInvalid;
    process.stderr.write(`${status}\n`);
    process.exitCode = 1;
    return null;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  await main();
}
