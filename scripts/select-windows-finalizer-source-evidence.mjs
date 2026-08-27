#!/usr/bin/env node

/**
 * Select the two direct qualification-receipt artifacts that a future
 * protected Windows finalizer may download.
 *
 * This module is deliberately offline.  It accepts bounded GitHub REST
 * response bytes supplied by a caller, hashes those bytes before parsing,
 * projects only the fields needed by the finalizer, and writes content-free
 * evidence documents under a fresh attempt directory.  It never downloads an
 * artifact and never accepts a receipt byte stream; the handoff verifier owns
 * that later raw-receipt digest-before-parse boundary.
 *
 * Node's fs/promises API does not expose openat-style directory descriptors.
 * The protected workflow must therefore grant this runner exclusive ownership
 * of the output root and prevent concurrent rename/replacement writers.  The
 * captured root/attempt identities and repeated checks detect replacement, but
 * cannot eliminate that kernel-level race themselves.
 */

import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  link,
  rename,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isProxy } from "node:util/types";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_FILE = fileURLToPath(import.meta.url);

export const WINDOWS_FINALIZER_SOURCE_EVIDENCE_SCHEMA =
  "tibotattle-windows-finalizer-source-evidence-selection-v1";
export const WINDOWS_FINALIZER_SOURCE_EVIDENCE_STATUS =
  "WINDOWS_FINALIZER_SOURCE_EVIDENCE_SELECTED";
export const WINDOWS_FINALIZER_SOURCE_EVIDENCE_REPOSITORY =
  "adamallcock/tibotattle";
export const WINDOWS_FINALIZER_SOURCE_EVIDENCE_WORKFLOW_PATH =
  ".github/workflows/windows-portability.yml";
export const WINDOWS_FINALIZER_SOURCE_EVIDENCE_EVENT = "workflow_dispatch";
export const WINDOWS_FINALIZER_SOURCE_EVIDENCE_REF = "refs/heads/main";
export const WINDOWS_FINALIZER_SOURCE_EVIDENCE_DOWNLOAD_ACTION =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
export const WINDOWS_FINALIZER_SOURCE_EVIDENCE_GITHUB_TOKEN =
  "${{ github.token }}";
export const WINDOWS_FINALIZER_SOURCE_EVIDENCE_ARTIFACT_EXPECTATION = "direct-v7";
export const WINDOWS_FINALIZER_SOURCE_EVIDENCE_WARM_DESTINATION =
  "${{ runner.temp }}/tibotattle-windows-production-finalizer-receipts/warm";
export const WINDOWS_FINALIZER_SOURCE_EVIDENCE_CLEAN_DESTINATION =
  "${{ runner.temp }}/tibotattle-windows-production-finalizer-receipts/clean";

export const WINDOWS_FINALIZER_SOURCE_EVIDENCE_RUN_METADATA_FILE =
  "run-metadata.json";
export const WINDOWS_FINALIZER_SOURCE_EVIDENCE_WARM_ARTIFACT_FILE =
  "warm-artifact.json";
export const WINDOWS_FINALIZER_SOURCE_EVIDENCE_CLEAN_ARTIFACT_FILE =
  "clean-artifact.json";
export const WINDOWS_FINALIZER_SOURCE_EVIDENCE_SELECTION_FILE =
  "selection-receipt.json";

const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ARTIFACT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]{0,19}$/u;
const REF_PATTERN = /^refs\/heads\/main$/u;
const MAXIMUM_RAW_INPUT_BYTES = 512 * 1024;
const MAXIMUM_READ_BYTES = MAXIMUM_RAW_INPUT_BYTES + 1;
const MAXIMUM_ARTIFACT_COUNT = 256;
const MAXIMUM_RECEIPT_BYTES = 16_777_216;
const MAXIMUM_OUTPUT_BYTES = 512 * 1024;
const MAXIMUM_JSON_DEPTH = 64;
const MAXIMUM_JSON_NODES = 4096;
const READ_CHUNK_BYTES = 64 * 1024;
const ATTEMPT_DIRECTORY_NAME = ".tibotattle-source-evidence-attempt";
const TEST_OUTPUT_FAULT_POINTS = new Set([
  "after-stage",
  "after-publish",
  "replace-root-before-publish",
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

export const WINDOWS_FINALIZER_SOURCE_EVIDENCE_MAXIMUM_INPUT_BYTES =
  MAXIMUM_RAW_INPUT_BYTES;
export const WINDOWS_FINALIZER_SOURCE_EVIDENCE_MAXIMUM_ARTIFACT_COUNT =
  MAXIMUM_ARTIFACT_COUNT;
export const WINDOWS_FINALIZER_SOURCE_EVIDENCE_MAXIMUM_RECEIPT_BYTES =
  MAXIMUM_RECEIPT_BYTES;
export const WINDOWS_FINALIZER_SOURCE_EVIDENCE_MAXIMUM_JSON_DEPTH =
  MAXIMUM_JSON_DEPTH;

const RUN_REST_KEYS = Object.freeze([
  "conclusion",
  "event",
  "head_sha",
  "id",
  "path",
  "repository",
  "run_attempt",
  "status",
]);
const RUN_REPOSITORY_KEYS = Object.freeze(["full_name"]);
const ARTIFACT_LIST_KEYS = Object.freeze(["artifacts", "total_count"]);
const PAGINATION_AMBIGUITY_KEYS = Object.freeze([
  "continuation_token",
  "cursor",
  "has_more",
  "incomplete_results",
  "link",
  "next",
  "next_page",
  "page",
  "per_page",
]);
const ARTIFACT_REST_KEYS = Object.freeze([
  "digest",
  "expired",
  "id",
  "name",
  "size_in_bytes",
  "workflow_run",
]);
const ARTIFACT_WORKFLOW_RUN_KEYS = Object.freeze(["head_sha", "id"]);

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
const ARTIFACT_METADATA_KEYS = ARTIFACT_REST_KEYS;
const ARTIFACT_WORKFLOW_METADATA_KEYS = ARTIFACT_WORKFLOW_RUN_KEYS;

const PURE_INPUT_KEYS = Object.freeze([
  "artifactListBytes",
  "ref",
  "repository",
  "revision",
  "runId",
  "runMetadataBytes",
]);
const RUNNER_INPUT_KEYS = Object.freeze([
  "artifactListPath",
  "outputRoot",
  "ref",
  "repository",
  "revision",
  "runId",
  "runMetadataPath",
]);
const CLI_FLAG_NAMES = Object.freeze(new Map([
  ["--artifact-list", "artifactListPath"],
  ["--artifacts", "artifactListPath"],
  ["--output-root", "outputRoot"],
  ["--ref", "ref"],
  ["--repository", "repository"],
  ["--revision", "revision"],
  ["--run-id", "runId"],
  ["--run-metadata", "runMetadataPath"],
]));

const SELECTION_KEYS = Object.freeze([
  "artifacts",
  "download",
  "event",
  "rawMetadata",
  "ref",
  "repository",
  "receiptHandling",
  "revision",
  "runAttempt",
  "runId",
  "schemaVersion",
  "status",
  "workflowPath",
]);
const SELECTION_RAW_METADATA_KEYS = Object.freeze([
  "artifactListSha256",
  "runSha256",
]);
const SELECTION_ARTIFACTS_KEYS = Object.freeze(["warm", "clean"]);
const SELECTION_ARTIFACT_KEYS = Object.freeze([
  "digest",
  "id",
  "name",
  "sizeInBytes",
]);
const SELECTION_DOWNLOAD_KEYS = Object.freeze([
  "action",
  "artifactExpectation",
  "artifactIds",
  "destinationMustBeAbsentBeforeDownload",
  "destinations",
  "digestMismatch",
  "githubToken",
  "mergeMultiple",
  "repository",
  "runId",
]);
const SELECTION_DOWNLOAD_ARTIFACT_IDS_KEYS = Object.freeze(["warm", "clean"]);
const SELECTION_DOWNLOAD_DESTINATION_KEYS = Object.freeze(["warm", "clean"]);

export const WINDOWS_FINALIZER_SOURCE_EVIDENCE_FIXED_STATUS = Object.freeze({
  passed: WINDOWS_FINALIZER_SOURCE_EVIDENCE_STATUS,
  inputInvalid: "WINDOWS_FINALIZER_SOURCE_EVIDENCE_INPUT_INVALID",
  inputMissing: "WINDOWS_FINALIZER_SOURCE_EVIDENCE_INPUT_MISSING",
  duplicateFlag: "WINDOWS_FINALIZER_SOURCE_EVIDENCE_DUPLICATE_FLAG",
  duplicateJsonKey: "WINDOWS_FINALIZER_SOURCE_EVIDENCE_DUPLICATE_JSON_KEY",
  rawRunInvalid: "WINDOWS_FINALIZER_SOURCE_EVIDENCE_RAW_RUN_INVALID",
  rawArtifactListInvalid: "WINDOWS_FINALIZER_SOURCE_EVIDENCE_RAW_ARTIFACT_LIST_INVALID",
  runInvalid: "WINDOWS_FINALIZER_SOURCE_EVIDENCE_RUN_INVALID",
  runMismatch: "WINDOWS_FINALIZER_SOURCE_EVIDENCE_RUN_MISMATCH",
  artifactListInvalid: "WINDOWS_FINALIZER_SOURCE_EVIDENCE_ARTIFACT_LIST_INVALID",
  artifactListIncomplete: "WINDOWS_FINALIZER_SOURCE_EVIDENCE_ARTIFACT_LIST_INCOMPLETE",
  artifactInvalid: "WINDOWS_FINALIZER_SOURCE_EVIDENCE_ARTIFACT_INVALID",
  artifactMismatch: "WINDOWS_FINALIZER_SOURCE_EVIDENCE_ARTIFACT_MISMATCH",
  duplicateArtifact: "WINDOWS_FINALIZER_SOURCE_EVIDENCE_DUPLICATE_ARTIFACT",
  outputInvalid: "WINDOWS_FINALIZER_SOURCE_EVIDENCE_OUTPUT_INVALID",
  outputExists: "WINDOWS_FINALIZER_SOURCE_EVIDENCE_OUTPUT_EXISTS",
});

// Shorter names are intentionally exported as aliases for consumers that use
// the selector as a library rather than its full policy-oriented name.
export const FIXED_STATUS = WINDOWS_FINALIZER_SOURCE_EVIDENCE_FIXED_STATUS;
const KNOWN_STATUSES = new Set(Object.values(FIXED_STATUS));

export class WindowsFinalizerSourceEvidenceError extends Error {
  constructor(code) {
    super("Windows finalizer source evidence selection failed");
    this.name = "WindowsFinalizerSourceEvidenceError";
    this.code = code;
  }
}

function fail(code) {
  throw new WindowsFinalizerSourceEvidenceError(code);
}

function rejectProxy(value, code) {
  try {
    if (isProxy(value)) fail(code);
  } catch {
    fail(code);
  }
}

function descriptorsFor(value, code) {
  rejectProxy(value, code);
  try {
    return {
      prototype: Object.getPrototypeOf(value),
      keys: Reflect.ownKeys(value),
      descriptors: Object.getOwnPropertyDescriptors(value),
    };
  } catch {
    fail(code);
  }
}

/** Read exact data properties without evaluating getters or inherited values. */
function snapshotClosedRecord(value, keys, code) {
  const { prototype, keys: ownKeys, descriptors } = descriptorsFor(value, code);
  const expected = new Set(keys);
  if (value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || prototype !== Object.prototype
      || ownKeys.length !== keys.length
      || ownKeys.some((key) => typeof key !== "string" || !expected.has(key))) {
    fail(code);
  }
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.get !== undefined
        || descriptor.set !== undefined
        || descriptor.enumerable !== true) {
      fail(code);
    }
    result[key] = descriptor.value;
  }
  return result;
}

/** Project an open REST object while retaining only fixed data properties. */
function projectOpenRecord(value, keys, code) {
  const { prototype, keys: ownKeys, descriptors } = descriptorsFor(value, code);
  if (value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || prototype !== Object.prototype
      || ownKeys.some((key) => typeof key !== "string")) {
    fail(code);
  }
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.get !== undefined
        || descriptor.set !== undefined
        || descriptor.enumerable !== true) {
      fail(code);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function optionalDataProperty(value, key, code) {
  const { descriptors } = descriptorsFor(value, code);
  if (!Object.hasOwn(descriptors, key)) return undefined;
  const descriptor = descriptors[key];
  if (!descriptor
      || !Object.hasOwn(descriptor, "value")
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || descriptor.enumerable !== true) {
    fail(code);
  }
  return descriptor.value;
}

function snapshotOpenArray(value, code) {
  rejectProxy(value, code);
  let ownKeys;
  let descriptors;
  let prototype;
  try {
    ownKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    fail(code);
  }
  if (!Array.isArray(value) || prototype !== Array.prototype) fail(code);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, "value")
      || lengthDescriptor.get !== undefined
      || lengthDescriptor.set !== undefined
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.enumerable !== false
      || ownKeys.length !== lengthDescriptor.value + 1
      || ownKeys.some((key) => typeof key !== "string")) {
    fail(code);
  }
  const result = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.get !== undefined
        || descriptor.set !== undefined
        || descriptor.enumerable !== true) {
      fail(code);
    }
    result.push(descriptor.value);
  }
  if (ownKeys.some((key) => key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key))) {
    fail(code);
  }
  return result;
}

function deepFreeze(value, seen = new Set()) {
  if (value === null
      || typeof value !== "object"
      || ArrayBuffer.isView(value)
      || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function assertSafeInteger(value, code, { positive = false } = {}) {
  if (!Number.isSafeInteger(value)
      || Object.is(value, -0)
      || (positive ? value < 1 : value < 0)) {
    fail(code);
  }
  return value;
}

function assertRevision(value, code = FIXED_STATUS.inputInvalid) {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) fail(code);
  return value;
}

function assertRepository(value, code = FIXED_STATUS.inputInvalid) {
  if (typeof value !== "string"
      || !REPOSITORY_PATTERN.test(value)
      || value !== WINDOWS_FINALIZER_SOURCE_EVIDENCE_REPOSITORY) {
    fail(code);
  }
  return value;
}

function assertRef(value, code = FIXED_STATUS.inputInvalid) {
  if (typeof value !== "string" || !REF_PATTERN.test(value)) fail(code);
  return value;
}

function normalizeRunId(value, code = FIXED_STATUS.inputInvalid) {
  if (typeof value === "string") {
    if (!POSITIVE_DECIMAL_PATTERN.test(value)) fail(code);
    const number = Number(value);
    return assertSafeInteger(number, code, { positive: true });
  }
  return assertSafeInteger(value, code, { positive: true });
}

function normalizeRunAttempt(value, code = FIXED_STATUS.runInvalid) {
  return assertSafeInteger(value, code, { positive: true });
}

function assertRawPositiveId(value, code) {
  return assertSafeInteger(value, code, { positive: true });
}

function expectedArtifactName(runId, runAttempt, revision, mode) {
  return `tibotattle-windows-electron-qualification-${runId}-${runAttempt}-${revision}-${mode}.json`;
}

function normalizeWorkflowPath(value, code) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\0")) {
    fail(code);
  }
  const at = value.indexOf("@");
  if (at >= 0 && value.indexOf("@", at + 1) >= 0) fail(code);
  const path = at < 0 ? value : value.slice(0, at);
  const pathRef = at < 0 ? null : value.slice(at + 1);
  if (path !== WINDOWS_FINALIZER_SOURCE_EVIDENCE_WORKFLOW_PATH
      || (pathRef !== null && pathRef !== WINDOWS_FINALIZER_SOURCE_EVIDENCE_REF)) {
    fail(code);
  }
  return Object.freeze({ path, refBound: pathRef !== null });
}

function normalizePureInput(value) {
  const source = snapshotClosedRecord(value, PURE_INPUT_KEYS, FIXED_STATUS.inputInvalid);
  return deepFreeze({
    artifactListBytes: source.artifactListBytes,
    ref: assertRef(source.ref),
    repository: assertRepository(source.repository),
    revision: assertRevision(source.revision),
    runId: normalizeRunId(source.runId),
    runMetadataBytes: source.runMetadataBytes,
  });
}

/**
 * Convert a byte/string input to a detached Buffer, enforce its bound, and
 * compute its digest before any JSON parsing occurs.
 */
function hashRawJsonBytes(value, code) {
  rejectProxy(value, code);
  let bytes;
  try {
    if (Buffer.isBuffer(value)) {
      bytes = Buffer.from(value);
    } else if (value instanceof Uint8Array
        && Object.getPrototypeOf(value) === Uint8Array.prototype) {
      bytes = Buffer.from(value);
    } else if (typeof value === "string") {
      bytes = Buffer.from(value, "utf8");
    } else {
      fail(code);
    }
  } catch (error) {
    if (error instanceof WindowsFinalizerSourceEvidenceError) throw error;
    fail(code);
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_RAW_INPUT_BYTES) {
    fail(code);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(code);
  }
  return { bytes, sha256, text };
}

/** Scan JSON syntax to reject duplicate object keys before JSON.parse. */
function rejectDuplicateJsonKeys(text, invalidCode, duplicateCode) {
  let index = 0;
  const length = text.length;
  let nodes = 0;
  const skipWhitespace = () => {
    while (index < length && /[\t\n\r ]/u.test(text[index])) index += 1;
  };
  const parseString = () => {
    const start = index;
    if (text[index] !== '"') fail(invalidCode);
    index += 1;
    while (index < length) {
      const current = text[index];
      if (current === "\\") {
        index += 1;
        if (index >= length) fail(invalidCode);
        index += 1;
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
      if (current < " ") fail(invalidCode);
    }
    fail(invalidCode);
  };
  const parseValue = (depth = 0) => {
    nodes += 1;
    if (depth > MAXIMUM_JSON_DEPTH || nodes > MAXIMUM_JSON_NODES) {
      fail(invalidCode);
    }
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
        if (keys.has(key)) fail(duplicateCode);
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ":") fail(invalidCode);
        index += 1;
        parseValue(depth + 1);
        skipWhitespace();
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
        if (text[index] !== ",") fail(invalidCode);
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
    const number = text
      .slice(index)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (!number) fail(invalidCode);
    index += number[0].length;
  };
  parseValue();
  skipWhitespace();
  if (index !== length) fail(invalidCode);
}

function parseRawJson(value, code) {
  const raw = hashRawJsonBytes(value, code);
  try {
    rejectDuplicateJsonKeys(raw.text, code, FIXED_STATUS.duplicateJsonKey);
  } catch (error) {
    if (error instanceof WindowsFinalizerSourceEvidenceError) throw error;
    fail(code);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.text);
  } catch {
    fail(code);
  }
  if (parsed === null || typeof parsed !== "object") fail(code);
  return Object.freeze({
    byteLength: raw.bytes.byteLength,
    parsed,
    sha256: raw.sha256,
  });
}

function normalizeRunMetadata(value, expected) {
  const source = projectOpenRecord(value, RUN_REST_KEYS, FIXED_STATUS.runInvalid);
  const repository = projectOpenRecord(
    source.repository,
    RUN_REPOSITORY_KEYS,
    FIXED_STATUS.runInvalid,
  );
  assertRepository(repository.full_name, FIXED_STATUS.runInvalid);
  const runId = assertRawPositiveId(source.id, FIXED_STATUS.runInvalid);
  if (runId !== expected.runId) fail(FIXED_STATUS.runMismatch);
  const revision = assertRevision(source.head_sha, FIXED_STATUS.runInvalid);
  if (revision !== expected.revision) fail(FIXED_STATUS.runMismatch);
  if (source.event !== WINDOWS_FINALIZER_SOURCE_EVIDENCE_EVENT
      || source.status !== "completed"
      || source.conclusion !== "success") {
    fail(FIXED_STATUS.runInvalid);
  }
  const runAttempt = normalizeRunAttempt(source.run_attempt);
  const workflowPath = normalizeWorkflowPath(source.path, FIXED_STATUS.runInvalid);
  const headBranch = optionalDataProperty(value, "head_branch", FIXED_STATUS.runInvalid);
  if (headBranch !== undefined && headBranch !== "main") fail(FIXED_STATUS.runMismatch);
  // GitHub REST commonly returns a bare workflow filename.  Accept that
  // representation only when the same response binds the run to `main`; a
  // bare path without branch evidence is not source authority.
  if (!workflowPath.refBound && headBranch !== "main") fail(FIXED_STATUS.runInvalid);
  return deepFreeze({
    conclusion: source.conclusion,
    databaseId: runId,
    event: source.event,
    headSha: revision,
    ref: expected.ref,
    repository: repository.full_name,
    runAttempt,
    status: source.status,
    workflowPath: workflowPath.path,
  });
}

function normalizeArtifact(value, expected, mode) {
  const source = projectOpenRecord(value, ARTIFACT_REST_KEYS, FIXED_STATUS.artifactInvalid);
  const workflowRun = projectOpenRecord(
    source.workflow_run,
    ARTIFACT_WORKFLOW_RUN_KEYS,
    FIXED_STATUS.artifactInvalid,
  );
  const id = assertRawPositiveId(source.id, FIXED_STATUS.artifactInvalid);
  if (typeof source.name !== "string"
      || source.name !== expectedArtifactName(
        expected.runId,
        expected.runAttempt,
        expected.revision,
        mode,
      )) {
    fail(FIXED_STATUS.artifactMismatch);
  }
  if (source.expired !== false
      || !Number.isSafeInteger(source.size_in_bytes)
      || source.size_in_bytes <= 0
      || source.size_in_bytes > MAXIMUM_RECEIPT_BYTES
      || typeof source.digest !== "string"
      || !ARTIFACT_DIGEST_PATTERN.test(source.digest)) {
    fail(FIXED_STATUS.artifactInvalid);
  }
  const workflowRunId = assertRawPositiveId(workflowRun.id, FIXED_STATUS.artifactInvalid);
  const workflowRevision = assertRevision(
    workflowRun.head_sha,
    FIXED_STATUS.artifactInvalid,
  );
  if (workflowRunId !== expected.runId || workflowRevision !== expected.revision) {
    fail(FIXED_STATUS.artifactMismatch);
  }
  return deepFreeze({
    digest: source.digest,
    expired: false,
    id,
    name: source.name,
    size_in_bytes: source.size_in_bytes,
    workflow_run: {
      head_sha: workflowRevision,
      id: workflowRunId,
    },
  });
}

function normalizeArtifactList(value, expected) {
  const source = projectOpenRecord(
    value,
    ARTIFACT_LIST_KEYS,
    FIXED_STATUS.artifactListInvalid,
  );
  for (const key of PAGINATION_AMBIGUITY_KEYS) {
    const paginationValue = optionalDataProperty(
      value,
      key,
      FIXED_STATUS.artifactListInvalid,
    );
    if (paginationValue !== undefined) fail(FIXED_STATUS.artifactListIncomplete);
  }
  const totalCount = assertSafeInteger(
    source.total_count,
    FIXED_STATUS.artifactListInvalid,
  );
  if (totalCount > MAXIMUM_ARTIFACT_COUNT) fail(FIXED_STATUS.artifactListIncomplete);
  const artifacts = snapshotOpenArray(source.artifacts, FIXED_STATUS.artifactListInvalid);
  if (totalCount !== artifacts.length) fail(FIXED_STATUS.artifactListIncomplete);

  const selected = { warm: null, clean: null };
  const artifactIds = new Set();
  const expectedNamePrefix =
    `tibotattle-windows-electron-qualification-${expected.runId}-${expected.runAttempt}-${expected.revision}-`;
  for (const artifact of artifacts) {
    const projected = projectOpenRecord(
      artifact,
      ARTIFACT_REST_KEYS,
      FIXED_STATUS.artifactInvalid,
    );
    // Artifact IDs are the immutable download authority.  A duplicate ID in
    // an unrelated artifact is still ambiguous evidence and must not be
    // ignored merely because its name is outside the selected pair.
    const artifactId = assertRawPositiveId(projected.id, FIXED_STATUS.artifactInvalid);
    if (artifactIds.has(artifactId)) fail(FIXED_STATUS.duplicateArtifact);
    artifactIds.add(artifactId);
    const name = projected.name;
    const mode = name === expectedArtifactName(
      expected.runId,
      expected.runAttempt,
      expected.revision,
      "warm",
    )
      ? "warm"
      : name === expectedArtifactName(
        expected.runId,
        expected.runAttempt,
        expected.revision,
        "clean",
      )
        ? "clean"
        : null;
    // The full REST envelope is open: unrelated build/diagnostic artifacts
    // are ignored after their fixed properties have been safely projected.
    if (mode === null) {
      if (typeof name === "string" && name.startsWith(expectedNamePrefix)) {
        fail(FIXED_STATUS.artifactMismatch);
      }
      continue;
    }
    const selectedArtifact = normalizeArtifact(projected, expected, mode);
    if (selected[mode] !== null) fail(FIXED_STATUS.duplicateArtifact);
    selected[mode] = selectedArtifact;
  }
  if (selected.warm === null || selected.clean === null) {
    fail(FIXED_STATUS.artifactMismatch);
  }
  if (selected.warm.id === selected.clean.id) fail(FIXED_STATUS.duplicateArtifact);
  return deepFreeze(selected);
}

function buildSelectionReceipt({ artifacts, artifactListSha256, runMetadata, runSha256 }) {
  return deepFreeze({
    artifacts: {
      warm: {
        digest: artifacts.warm.digest,
        id: artifacts.warm.id,
        name: artifacts.warm.name,
        sizeInBytes: artifacts.warm.size_in_bytes,
      },
      clean: {
        digest: artifacts.clean.digest,
        id: artifacts.clean.id,
        name: artifacts.clean.name,
        sizeInBytes: artifacts.clean.size_in_bytes,
      },
    },
    download: {
      action: WINDOWS_FINALIZER_SOURCE_EVIDENCE_DOWNLOAD_ACTION,
      artifactExpectation: WINDOWS_FINALIZER_SOURCE_EVIDENCE_ARTIFACT_EXPECTATION,
      artifactIds: {
        warm: artifacts.warm.id,
        clean: artifacts.clean.id,
      },
      destinationMustBeAbsentBeforeDownload: true,
      destinations: {
        warm: WINDOWS_FINALIZER_SOURCE_EVIDENCE_WARM_DESTINATION,
        clean: WINDOWS_FINALIZER_SOURCE_EVIDENCE_CLEAN_DESTINATION,
      },
      digestMismatch: "error",
      githubToken: WINDOWS_FINALIZER_SOURCE_EVIDENCE_GITHUB_TOKEN,
      mergeMultiple: false,
      repository: runMetadata.repository,
      runId: runMetadata.databaseId,
    },
    event: runMetadata.event,
    rawMetadata: {
      artifactListSha256,
      runSha256,
    },
    ref: runMetadata.ref,
    repository: runMetadata.repository,
    receiptHandling: "deferred_to_handoff_verifier",
    revision: runMetadata.headSha,
    runAttempt: runMetadata.runAttempt,
    runId: runMetadata.databaseId,
    schemaVersion: WINDOWS_FINALIZER_SOURCE_EVIDENCE_SCHEMA,
    status: WINDOWS_FINALIZER_SOURCE_EVIDENCE_STATUS,
    workflowPath: runMetadata.workflowPath,
  });
}

/**
 * Select exactly one warm and one clean direct receipt from two raw REST
 * responses.  The return value is detached and deeply frozen, and contains no
 * receipt bytes or source filesystem paths.
 */
export function selectWindowsFinalizerSourceEvidence(value) {
  const input = normalizePureInput(value);
  const expected = {
    ref: input.ref,
    repository: input.repository,
    revision: input.revision,
    runAttempt: null,
    runId: input.runId,
  };
  const runRaw = parseRawJson(input.runMetadataBytes, FIXED_STATUS.rawRunInvalid);
  const runMetadata = normalizeRunMetadata(runRaw.parsed, expected);
  expected.runAttempt = runMetadata.runAttempt;
  const artifactRaw = parseRawJson(
    input.artifactListBytes,
    FIXED_STATUS.rawArtifactListInvalid,
  );
  const artifacts = normalizeArtifactList(artifactRaw.parsed, expected);
  const selectionReceipt = buildSelectionReceipt({
    artifacts,
    artifactListSha256: artifactRaw.sha256,
    runMetadata,
    runSha256: runRaw.sha256,
  });
  return deepFreeze({
    artifacts,
    runMetadata,
    selectionReceipt,
    status: WINDOWS_FINALIZER_SOURCE_EVIDENCE_STATUS,
  });
}

export const selectSourceEvidence = selectWindowsFinalizerSourceEvidence;

function validateNormalizedArtifact(value, mode, expected) {
  const source = snapshotClosedRecord(
    value,
    ARTIFACT_METADATA_KEYS,
    FIXED_STATUS.artifactInvalid,
  );
  const workflowRun = snapshotClosedRecord(
    source.workflow_run,
    ARTIFACT_WORKFLOW_METADATA_KEYS,
    FIXED_STATUS.artifactInvalid,
  );
  const normalized = normalizeArtifact(source, expected, mode);
  if (normalized.id !== source.id
      || normalized.digest !== source.digest
      || normalized.name !== source.name
      || normalized.size_in_bytes !== source.size_in_bytes
      || workflowRun.id !== source.workflow_run.id
      || workflowRun.head_sha !== source.workflow_run.head_sha) {
    fail(FIXED_STATUS.artifactInvalid);
  }
  return normalized;
}

function validateNormalizedRun(value, expected) {
  const source = snapshotClosedRecord(value, RUN_METADATA_KEYS, FIXED_STATUS.runInvalid);
  if (source.repository !== expected.repository
      || source.ref !== expected.ref
      || source.workflowPath !== WINDOWS_FINALIZER_SOURCE_EVIDENCE_WORKFLOW_PATH
      || source.event !== WINDOWS_FINALIZER_SOURCE_EVIDENCE_EVENT
      || source.status !== "completed"
      || source.conclusion !== "success"
      || source.headSha !== expected.revision) {
    fail(FIXED_STATUS.runMismatch);
  }
  const runId = assertRawPositiveId(source.databaseId, FIXED_STATUS.runInvalid);
  const runAttempt = normalizeRunAttempt(source.runAttempt, FIXED_STATUS.runInvalid);
  if (runId !== expected.runId) fail(FIXED_STATUS.runMismatch);
  return deepFreeze({
    conclusion: source.conclusion,
    databaseId: runId,
    event: source.event,
    headSha: source.headSha,
    ref: source.ref,
    repository: source.repository,
    runAttempt,
    status: source.status,
    workflowPath: source.workflowPath,
  });
}

/** Validate a generated selection receipt without trusting caller data. */
export function validateWindowsFinalizerSourceEvidenceSelection(value) {
  const source = snapshotClosedRecord(value, SELECTION_KEYS, FIXED_STATUS.inputInvalid);
  if (source.schemaVersion !== WINDOWS_FINALIZER_SOURCE_EVIDENCE_SCHEMA
      || source.status !== WINDOWS_FINALIZER_SOURCE_EVIDENCE_STATUS
      || source.workflowPath !== WINDOWS_FINALIZER_SOURCE_EVIDENCE_WORKFLOW_PATH
      || source.event !== WINDOWS_FINALIZER_SOURCE_EVIDENCE_EVENT
      || source.ref !== WINDOWS_FINALIZER_SOURCE_EVIDENCE_REF
      || source.repository !== WINDOWS_FINALIZER_SOURCE_EVIDENCE_REPOSITORY
      || source.receiptHandling !== "deferred_to_handoff_verifier") {
    fail(FIXED_STATUS.inputInvalid);
  }
  assertRevision(source.revision, FIXED_STATUS.inputInvalid);
  const runId = assertRawPositiveId(source.runId, FIXED_STATUS.inputInvalid);
  const runAttempt = normalizeRunAttempt(source.runAttempt, FIXED_STATUS.inputInvalid);
  const rawMetadata = snapshotClosedRecord(
    source.rawMetadata,
    SELECTION_RAW_METADATA_KEYS,
    FIXED_STATUS.inputInvalid,
  );
  if (typeof rawMetadata.runSha256 !== "string"
      || typeof rawMetadata.artifactListSha256 !== "string"
      || !SHA256_PATTERN.test(rawMetadata.runSha256)
      || !SHA256_PATTERN.test(rawMetadata.artifactListSha256)) {
    fail(FIXED_STATUS.inputInvalid);
  }
  const artifacts = snapshotClosedRecord(
    source.artifacts,
    SELECTION_ARTIFACTS_KEYS,
    FIXED_STATUS.inputInvalid,
  );
  const normalizedArtifacts = {};
  for (const mode of ["warm", "clean"]) {
    const artifact = snapshotClosedRecord(
      artifacts[mode],
      SELECTION_ARTIFACT_KEYS,
      FIXED_STATUS.inputInvalid,
    );
    const expectedName = expectedArtifactName(runId, runAttempt, source.revision, mode);
    if (artifact.name !== expectedName
        || typeof artifact.digest !== "string"
        || !ARTIFACT_DIGEST_PATTERN.test(artifact.digest)
        || !Number.isSafeInteger(artifact.sizeInBytes)
        || artifact.sizeInBytes <= 0
        || artifact.sizeInBytes > MAXIMUM_RECEIPT_BYTES) {
      fail(FIXED_STATUS.artifactMismatch);
    }
    const id = assertRawPositiveId(artifact.id, FIXED_STATUS.inputInvalid);
    normalizedArtifacts[mode] = {
      digest: artifact.digest,
      id,
      name: artifact.name,
      sizeInBytes: artifact.sizeInBytes,
    };
  }
  if (normalizedArtifacts.warm.id === normalizedArtifacts.clean.id) {
    fail(FIXED_STATUS.duplicateArtifact);
  }
  const download = snapshotClosedRecord(
    source.download,
    SELECTION_DOWNLOAD_KEYS,
    FIXED_STATUS.inputInvalid,
  );
  if (download.action !== WINDOWS_FINALIZER_SOURCE_EVIDENCE_DOWNLOAD_ACTION
      || download.artifactExpectation !== WINDOWS_FINALIZER_SOURCE_EVIDENCE_ARTIFACT_EXPECTATION
      || download.destinationMustBeAbsentBeforeDownload !== true
      || download.digestMismatch !== "error"
      || download.githubToken !== WINDOWS_FINALIZER_SOURCE_EVIDENCE_GITHUB_TOKEN
      || download.mergeMultiple !== false
      || download.repository !== source.repository
      || assertRawPositiveId(download.runId, FIXED_STATUS.inputInvalid) !== runId) {
    fail(FIXED_STATUS.inputInvalid);
  }
  const artifactIds = snapshotClosedRecord(
    download.artifactIds,
    SELECTION_DOWNLOAD_ARTIFACT_IDS_KEYS,
    FIXED_STATUS.inputInvalid,
  );
  if (assertRawPositiveId(artifactIds.warm, FIXED_STATUS.inputInvalid)
        !== normalizedArtifacts.warm.id
      || assertRawPositiveId(artifactIds.clean, FIXED_STATUS.inputInvalid)
        !== normalizedArtifacts.clean.id) {
    fail(FIXED_STATUS.artifactMismatch);
  }
  const destinations = snapshotClosedRecord(
    download.destinations,
    SELECTION_DOWNLOAD_DESTINATION_KEYS,
    FIXED_STATUS.inputInvalid,
  );
  if (destinations.warm !== WINDOWS_FINALIZER_SOURCE_EVIDENCE_WARM_DESTINATION
      || destinations.clean !== WINDOWS_FINALIZER_SOURCE_EVIDENCE_CLEAN_DESTINATION) {
    fail(FIXED_STATUS.inputInvalid);
  }
  return deepFreeze({
    artifacts: normalizedArtifacts,
    download: {
      action: download.action,
      artifactExpectation: download.artifactExpectation,
      artifactIds: {
        clean: normalizedArtifacts.clean.id,
        warm: normalizedArtifacts.warm.id,
      },
      destinationMustBeAbsentBeforeDownload: true,
      destinations: {
        clean: destinations.clean,
        warm: destinations.warm,
      },
      digestMismatch: download.digestMismatch,
      githubToken: download.githubToken,
      mergeMultiple: false,
      repository: download.repository,
      runId,
    },
    event: source.event,
    rawMetadata: {
      artifactListSha256: rawMetadata.artifactListSha256,
      runSha256: rawMetadata.runSha256,
    },
    ref: source.ref,
    repository: source.repository,
    receiptHandling: source.receiptHandling,
    revision: source.revision,
    runAttempt,
    runId,
    schemaVersion: source.schemaVersion,
    status: source.status,
    workflowPath: source.workflowPath,
  });
}

function canonicalJson(value, validator) {
  const selected = validator(value);
  const serialized = `${JSON.stringify(selected, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_OUTPUT_BYTES) {
    fail(FIXED_STATUS.outputInvalid);
  }
  return serialized;
}

export function serializeWindowsFinalizerSourceEvidenceSelection(value) {
  return canonicalJson(
    value,
    validateWindowsFinalizerSourceEvidenceSelection,
  );
}

export function serializeWindowsFinalizerSourceEvidenceRunMetadata(value, expected) {
  const sourceExpected = snapshotClosedRecord(
    expected,
    ["ref", "repository", "revision", "runId"],
    FIXED_STATUS.inputInvalid,
  );
  const selected = validateNormalizedRun(value, {
    ref: assertRef(sourceExpected.ref),
    repository: assertRepository(sourceExpected.repository),
    revision: assertRevision(sourceExpected.revision),
    runId: normalizeRunId(sourceExpected.runId),
  });
  return canonicalJson(selected, () => selected);
}

export function serializeWindowsFinalizerSourceEvidenceArtifact(value, mode, expected) {
  if (mode !== "warm" && mode !== "clean") fail(FIXED_STATUS.inputInvalid);
  const sourceExpected = snapshotClosedRecord(
    expected,
    ["ref", "repository", "revision", "runAttempt", "runId"],
    FIXED_STATUS.inputInvalid,
  );
  const selected = validateNormalizedArtifact(value, mode, {
    ref: assertRef(sourceExpected.ref),
    repository: assertRepository(sourceExpected.repository),
    revision: assertRevision(sourceExpected.revision),
    runAttempt: normalizeRunAttempt(sourceExpected.runAttempt),
    runId: normalizeRunId(sourceExpected.runId),
  });
  return canonicalJson(selected, () => selected);
}

function normalizedExpectedInput(value) {
  return {
    ref: value.runMetadata.ref,
    repository: value.runMetadata.repository,
    revision: value.runMetadata.headSha,
    runAttempt: value.runMetadata.runAttempt,
    runId: value.runMetadata.databaseId,
  };
}

function serializeOutputDocuments(selected) {
  const expected = normalizedExpectedInput(selected);
  const selection = serializeWindowsFinalizerSourceEvidenceSelection(
    selected.selectionReceipt,
  );
  const runMetadata = serializeWindowsFinalizerSourceEvidenceRunMetadata(
    selected.runMetadata,
    {
      ref: expected.ref,
      repository: expected.repository,
      revision: expected.revision,
      runId: expected.runId,
    },
  );
  const warmArtifact = serializeWindowsFinalizerSourceEvidenceArtifact(
    selected.artifacts.warm,
    "warm",
    expected,
  );
  const cleanArtifact = serializeWindowsFinalizerSourceEvidenceArtifact(
    selected.artifacts.clean,
    "clean",
    expected,
  );
  return Object.freeze({
    cleanArtifact,
    runMetadata,
    selection,
    warmArtifact,
  });
}

function sameFileObjectIdentity(left, right) {
  const leftBirth = left.birthtimeNs ?? BigInt(Math.round(left.birthtimeMs * 1e6));
  const rightBirth = right.birthtimeNs ?? BigInt(Math.round(right.birthtimeMs * 1e6));
  return left.isFile()
    && right.isFile()
    && !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && left.nlink >= 1
    && right.nlink >= 1
    && left.dev === right.dev
    && left.ino === right.ino
    && leftBirth === rightBirth;
}

function sameFileIdentity(left, right) {
  const leftMtime = left.mtimeNs ?? BigInt(Math.round(left.mtimeMs * 1e6));
  const rightMtime = right.mtimeNs ?? BigInt(Math.round(right.mtimeMs * 1e6));
  const leftCtime = left.ctimeNs ?? BigInt(Math.round(left.ctimeMs * 1e6));
  const rightCtime = right.ctimeNs ?? BigInt(Math.round(right.ctimeMs * 1e6));
  return sameFileObjectIdentity(left, right)
    && left.size === right.size
    && leftMtime === rightMtime
    && leftCtime === rightCtime;
}

function sameIdentity(left, right) {
  return sameFileIdentity(left, right)
    && left.nlink === 1
    && right.nlink === 1;
}

async function readBoundedRegularFile(path, code) {
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile()
        || before.isSymbolicLink()
        || before.nlink !== 1
        || before.size <= 0
        || before.size > MAXIMUM_RAW_INPUT_BYTES) {
      fail(code);
    }
    handle = await open(path, READ_ONLY_FLAGS);
    const opened = await handle.stat();
    if (!sameIdentity(before, opened)) fail(code);
    const afterOpen = await lstat(path);
    if (!sameIdentity(before, afterOpen) || !sameIdentity(opened, afterOpen)) {
      fail(code);
    }
    const chunks = [];
    let total = 0;
    while (total < MAXIMUM_READ_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(
        READ_CHUNK_BYTES,
        MAXIMUM_READ_BYTES - total,
      ));
      const result = await handle.read(chunk, 0, chunk.byteLength, null);
      if (!Number.isSafeInteger(result.bytesRead)
          || result.bytesRead < 0
          || result.bytesRead > chunk.byteLength) {
        fail(code);
      }
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      total += result.bytesRead;
      if (total > MAXIMUM_RAW_INPUT_BYTES) fail(code);
    }
    const finished = await handle.stat();
    const afterRead = await lstat(path);
    if (!sameIdentity(opened, finished)
        || !sameIdentity(finished, afterRead)
        || finished.size !== total) {
      fail(code);
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof WindowsFinalizerSourceEvidenceError) throw error;
    fail(code);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function assertAbsolutePath(value, code) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\0")
      || !isAbsolute(value)
      || resolve(value) !== value) {
    fail(code);
  }
  return value;
}

async function safeRootMetadata(root) {
  try {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      fail(FIXED_STATUS.outputInvalid);
    }
    // `lstat(root)` rejects a symlink at the requested root itself.  Parent
    // aliases such as macOS /var -> /private/var are legitimate and are not a
    // path escape because the fixed output names are resolved beneath this
    // already-opened directory identity.
    await realpath(root);
    return metadata;
  } catch (error) {
    if (error instanceof WindowsFinalizerSourceEvidenceError) throw error;
    fail(FIXED_STATUS.outputInvalid);
  }
}

async function assertRootUnchanged(root, identity) {
  const current = await safeRootMetadata(root);
  if (!sameDirectoryIdentity(current, identity)) fail(FIXED_STATUS.outputInvalid);
}

function sameDirectoryIdentity(left, right) {
  return left.isDirectory()
    && right.isDirectory()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs;
}

async function assertFreshOutputRoot(root) {
  const metadata = await safeRootMetadata(root);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    fail(FIXED_STATUS.outputInvalid);
  }
  if (entries.length > 0) fail(FIXED_STATUS.outputExists);
  return metadata;
}

function outputDocuments() {
  return [
    WINDOWS_FINALIZER_SOURCE_EVIDENCE_RUN_METADATA_FILE,
    WINDOWS_FINALIZER_SOURCE_EVIDENCE_WARM_ARTIFACT_FILE,
    WINDOWS_FINALIZER_SOURCE_EVIDENCE_CLEAN_ARTIFACT_FILE,
    WINDOWS_FINALIZER_SOURCE_EVIDENCE_SELECTION_FILE,
  ];
}

function assertSafeChildPath(root, fileName) {
  const path = join(root, fileName);
  const relativePath = relative(root, path);
  if (relativePath !== fileName || isAbsolute(relativePath)) {
    fail(FIXED_STATUS.outputInvalid);
  }
  return path;
}

async function createAttemptDirectory(root, rootIdentity) {
  await assertRootUnchanged(root, rootIdentity);
  const path = assertSafeChildPath(root, ATTEMPT_DIRECTORY_NAME);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") fail(FIXED_STATUS.outputExists);
    fail(FIXED_STATUS.outputInvalid);
  }
  let identity;
  try {
    identity = await safeRootMetadata(path);
  } catch (error) {
    // A newly-created directory that cannot be re-opened by identity is not a
    // usable transactional attempt.  The caller's cleanup path will remove
    // it only if the captured ownership identity still matches.
    if (error instanceof WindowsFinalizerSourceEvidenceError) throw error;
    fail(FIXED_STATUS.outputInvalid);
  }
  const state = Object.freeze({
    identity,
    path,
    root,
    rootIdentity,
  });
  await assertAttemptUnchanged(state);
  return state;
}

async function assertAttemptUnchanged(state) {
  await assertRootUnchanged(state.root, state.rootIdentity);
  const current = await safeRootMetadata(state.path);
  if (!sameDirectoryIdentity(current, state.identity)) {
    fail(FIXED_STATUS.outputInvalid);
  }
}

async function assertAbsent(path) {
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || existing.isFile() || existing.isDirectory()) {
      fail(FIXED_STATUS.outputExists);
    }
    fail(FIXED_STATUS.outputInvalid);
  } catch (error) {
    if (error instanceof WindowsFinalizerSourceEvidenceError) throw error;
    if (error?.code !== "ENOENT") fail(FIXED_STATUS.outputInvalid);
  }
}

async function removeOwnedFile(directoryState, path, identity) {
  try {
    await assertAttemptUnchanged(directoryState);
    const current = await lstat(path);
    if (sameFileObjectIdentity(current, identity)) await unlink(path);
  } catch {
    // Cleanup never follows a replacement or removes an unowned path.  The
    // caller reports the original fixed status; a leftover attempt is safe to
    // diagnose and cannot be mistaken for a complete selection.
  }
}

async function writeStaged(directoryState, fileName, text, faultAt) {
  const outputPath = assertSafeChildPath(directoryState.path, fileName);
  await assertAttemptUnchanged(directoryState);
  await assertAbsent(outputPath);
  const temporaryPath = assertSafeChildPath(
    directoryState.path,
    `.${fileName}.${process.pid}.${randomUUID()}.tmp`,
  );
  const bytes = Buffer.from(text, "utf8");
  let handle;
  let temporaryIdentity = null;
  let temporaryRemoved = false;
  let stagedIdentity = null;
  try {
    await assertAttemptUnchanged(directoryState);
    handle = await open(temporaryPath, "wx", 0o600);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1) {
      fail(FIXED_STATUS.outputInvalid);
    }
    temporaryIdentity = opened;
    await handle.writeFile(bytes);
    await handle.sync();
    const finished = await handle.stat();
    if (!sameFileObjectIdentity(opened, finished) || finished.size !== bytes.byteLength) {
      fail(FIXED_STATUS.outputInvalid);
    }
    await handle.close();
    handle = null;
    injectOutputFault(faultAt, "after-stage");
    await assertAttemptUnchanged(directoryState);
    try {
      await link(temporaryPath, outputPath);
    } catch (error) {
      if (error?.code === "EEXIST") fail(FIXED_STATUS.outputExists);
      fail(FIXED_STATUS.outputInvalid);
    }
    const linked = await lstat(outputPath);
    if (!sameFileObjectIdentity(linked, temporaryIdentity)) fail(FIXED_STATUS.outputInvalid);
    stagedIdentity = linked;
    await unlink(temporaryPath);
    temporaryRemoved = true;
    const staged = await lstat(outputPath);
    if (!sameFileObjectIdentity(staged, temporaryIdentity)
        || staged.size !== bytes.byteLength) {
      fail(FIXED_STATUS.outputInvalid);
    }
    stagedIdentity = staged;
    await assertAttemptUnchanged(directoryState);
    const record = Object.freeze({ path: outputPath, identity: staged });
    stagedIdentity = null;
    return record;
  } catch (error) {
    if (error instanceof WindowsFinalizerSourceEvidenceError) throw error;
    fail(FIXED_STATUS.outputInvalid);
  } finally {
    await handle?.close().catch(() => {});
    if (!temporaryRemoved && temporaryIdentity) {
      await removeOwnedFile(directoryState, temporaryPath, temporaryIdentity);
    }
    if (stagedIdentity) {
      await removeOwnedFile(directoryState, outputPath, stagedIdentity);
    }
  }
}

async function publishStaged(rootState, attemptState, documents, faultAt, published) {
  for (const fileName of outputDocuments()) {
    await assertRootUnchanged(rootState.path, rootState.identity);
    await assertAttemptUnchanged(attemptState);
    const sourcePath = assertSafeChildPath(attemptState.path, fileName);
    const targetPath = assertSafeChildPath(rootState.path, fileName);
    const source = await lstat(sourcePath);
    if (!source.isFile() || source.isSymbolicLink() || source.nlink !== 1) {
      fail(FIXED_STATUS.outputInvalid);
    }
    await assertAbsent(targetPath);
    try {
      // Hard-link then unlink is the same no-replace publication boundary as
      // the authority driver.  A concurrent target cannot be overwritten.
      await link(sourcePath, targetPath);
    } catch (error) {
      if (error?.code === "EEXIST") fail(FIXED_STATUS.outputExists);
      fail(FIXED_STATUS.outputInvalid);
    }
    published.push({ identity: source, path: targetPath });
    const linked = await lstat(targetPath);
    if (!sameFileObjectIdentity(linked, source)) fail(FIXED_STATUS.outputInvalid);
    await unlink(sourcePath);
    const target = await lstat(targetPath);
    if (!sameFileObjectIdentity(target, source)
        || target.size !== Buffer.byteLength(documents[fileName], "utf8")) {
      fail(FIXED_STATUS.outputInvalid);
    }
    published[published.length - 1].identity = target;
    injectOutputFault(faultAt, "after-publish");
  }
  await assertRootUnchanged(rootState.path, rootState.identity);
  await assertAttemptUnchanged(attemptState);
  const remaining = await readdir(attemptState.path, { withFileTypes: true });
  if (remaining.length !== 0) fail(FIXED_STATUS.outputInvalid);
  try {
    await rmdir(attemptState.path);
  } catch {
    fail(FIXED_STATUS.outputInvalid);
  }
  return published;
}

async function cleanupAttempt(rootState, attemptState, staged, published) {
  if (attemptState) {
    for (const record of staged) {
      await removeOwnedFile(attemptState, record.path, record.identity);
    }
  }
  for (const record of published) {
    await removeOwnedFile(rootState, record.path, record.identity);
  }
  if (attemptState) {
    try {
      await assertAttemptUnchanged(attemptState);
      const remaining = await readdir(attemptState.path, { withFileTypes: true });
      if (remaining.length === 0) await rmdir(attemptState.path);
    } catch {
      // Never recursively remove an attempt directory after its identity or
      // parent root changes.  Node has no openat-style directory API; the
      // protected workflow must provide exclusive ownership of this root.
    }
  }
}

function injectOutputFault(faultAt, point) {
  if (faultAt === point) fail(FIXED_STATUS.outputInvalid);
}

function normalizeRunnerInput(value) {
  const source = snapshotClosedRecord(value, RUNNER_INPUT_KEYS, FIXED_STATUS.inputInvalid);
  return deepFreeze({
    artifactListPath: assertAbsolutePath(source.artifactListPath, FIXED_STATUS.inputInvalid),
    outputRoot: assertAbsolutePath(source.outputRoot, FIXED_STATUS.inputInvalid),
    ref: assertRef(source.ref, FIXED_STATUS.inputInvalid),
    repository: assertRepository(source.repository, FIXED_STATUS.inputInvalid),
    revision: assertRevision(source.revision, FIXED_STATUS.inputInvalid),
    runId: normalizeRunId(source.runId, FIXED_STATUS.inputInvalid),
    runMetadataPath: assertAbsolutePath(source.runMetadataPath, FIXED_STATUS.inputInvalid),
  });
}

/**
 * Read the two raw REST files, select evidence, and publish four files once.
 * The output root is caller-created and must be fresh.  A fixed child attempt
 * directory owns all staged documents; publication uses no-replace hard links,
 * and any failed attempt removes only files whose captured identities still
 * match.  This leaves either all four final files or an empty root.
 */
async function runWindowsFinalizerSourceEvidenceInternal(value, faultAt = null) {
  if (faultAt !== null && !TEST_OUTPUT_FAULT_POINTS.has(faultAt)) {
    fail(FIXED_STATUS.inputInvalid);
  }
  const input = normalizeRunnerInput(value);
  const rootIdentity = await assertFreshOutputRoot(input.outputRoot);
  const rootState = Object.freeze({
    identity: rootIdentity,
    path: input.outputRoot,
    root: input.outputRoot,
    rootIdentity,
  });
  const [runBytes, artifactListBytes] = await Promise.all([
    readBoundedRegularFile(input.runMetadataPath, FIXED_STATUS.rawRunInvalid),
    readBoundedRegularFile(input.artifactListPath, FIXED_STATUS.rawArtifactListInvalid),
  ]);
  const selected = selectWindowsFinalizerSourceEvidence({
    artifactListBytes,
    ref: input.ref,
    repository: input.repository,
    revision: input.revision,
    runId: input.runId,
    runMetadataBytes: runBytes,
  });
  const documents = serializeOutputDocuments(selected);
  const documentsByName = Object.freeze({
    [WINDOWS_FINALIZER_SOURCE_EVIDENCE_RUN_METADATA_FILE]: documents.runMetadata,
    [WINDOWS_FINALIZER_SOURCE_EVIDENCE_WARM_ARTIFACT_FILE]: documents.warmArtifact,
    [WINDOWS_FINALIZER_SOURCE_EVIDENCE_CLEAN_ARTIFACT_FILE]: documents.cleanArtifact,
    [WINDOWS_FINALIZER_SOURCE_EVIDENCE_SELECTION_FILE]: documents.selection,
  });
  let attemptState = null;
  const staged = [];
  const published = [];
  try {
    attemptState = await createAttemptDirectory(input.outputRoot, rootIdentity);
    for (const fileName of outputDocuments()) {
      const record = await writeStaged(
        attemptState,
        fileName,
        documentsByName[fileName],
        faultAt,
      );
      staged.push(record);
    }
    if (faultAt === "replace-root-before-publish") {
      const replacementPath = `${input.outputRoot}.replaced`;
      try {
        await rename(input.outputRoot, replacementPath);
        await mkdir(input.outputRoot, { mode: 0o700 });
      } catch {
        fail(FIXED_STATUS.outputInvalid);
      }
    }
    await publishStaged(
      rootState,
      attemptState,
      documentsByName,
      faultAt,
      published,
    );
  } catch (error) {
    await cleanupAttempt(rootState, attemptState, staged, published);
    if (error instanceof WindowsFinalizerSourceEvidenceError) throw error;
    fail(FIXED_STATUS.outputInvalid);
  }
  return Object.freeze({
    selectionReceipt: selected.selectionReceipt,
    status: WINDOWS_FINALIZER_SOURCE_EVIDENCE_STATUS,
  });
}

export async function runWindowsFinalizerSourceEvidence(value) {
  return runWindowsFinalizerSourceEvidenceInternal(value);
}

/** Test-only fault seam; production callers use the fixed public runner. */
export async function runWindowsFinalizerSourceEvidenceForTest(value, faultAt) {
  return runWindowsFinalizerSourceEvidenceInternal(value, faultAt ?? null);
}

export const run = runWindowsFinalizerSourceEvidence;

export function parseWindowsFinalizerSourceEvidenceArguments(argv) {
  if (!Array.isArray(argv)) fail(FIXED_STATUS.inputInvalid);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = CLI_FLAG_NAMES.get(flag);
    if (!key) fail(FIXED_STATUS.inputInvalid);
    if (values.has(key)) fail(FIXED_STATUS.duplicateFlag);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      fail(FIXED_STATUS.inputInvalid);
    }
    values.set(key, value);
    index += 1;
  }
  const missing = RUNNER_INPUT_KEYS.filter((key) => !values.has(key));
  if (missing.length > 0) fail(FIXED_STATUS.inputMissing);
  return Object.freeze(Object.fromEntries(
    RUNNER_INPUT_KEYS.map((key) => [key, values.get(key)]),
  ));
}

export const parseArguments = parseWindowsFinalizerSourceEvidenceArguments;

export async function main(argv = process.argv.slice(2)) {
  try {
    const argumentsValue = parseWindowsFinalizerSourceEvidenceArguments(argv);
    await runWindowsFinalizerSourceEvidence(argumentsValue);
    process.stdout.write(`${WINDOWS_FINALIZER_SOURCE_EVIDENCE_STATUS}\n`);
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
