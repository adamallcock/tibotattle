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
export const WINDOWS_SECURITY_QUALIFICATION_TEST_FILES = QUALIFICATION_TEST_FILES;
// Node's test runner executes multiple files in lexical order. Keep diagnostic
// file coordinates numeric and stable without exposing filenames or paths.
const QUALIFICATION_TAP_TEST_FILES = Object.freeze(
  [...QUALIFICATION_TEST_FILES].sort(),
);
const QUALIFICATION_TAP_FILE_ORDINALS = new Map(
  QUALIFICATION_TAP_TEST_FILES.map((file, index) => [
    file.slice("test/".length),
    index + 1,
  ]),
);
// The native SQLite publication callback exposes only these fixed phase names.
// Keep this list deliberately separate from the native binding so a malformed
// TAP diagnostic cannot turn an arbitrary property value into CI output.
export const WINDOWS_SQLITE_PUBLISH_STAGE_ALLOWLIST = Object.freeze([
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
// Prepared-directory diagnostics are intentionally separate from SQLite
// publication diagnostics. Only these fixed native phases may cross the
// qualification boundary; paths, names, SIDs, and native messages remain
// private to the child process.
export const WINDOWS_PREPARED_DIRECTORY_STAGE_ALLOWLIST = Object.freeze([
  "prepared_root_open",
  "prepared_root_validation",
  "prepared_child_open",
  "prepared_child_create",
  "prepared_dacl_update",
  "prepared_child_validation",
  "prepared_ancestor_validation",
  "prepared_final_validation",
]);
// Unified-index ingest diagnostics are deliberately coarse and separate from
// native filesystem publication details. Only these fixed phases may cross
// the qualification boundary; paths, SQL, messages, and arbitrary codes do
// not.
export const WINDOWS_UNIFIED_INDEX_PHASE_ALLOWLIST = Object.freeze([
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
// These are the finite native Failure/FromLastError classes that can cross
// the SQLite publication callback. The TAP diagnostic never accepts arbitrary
// error-like strings or host/runtime exception names.
export const WINDOWS_SQLITE_PUBLISH_ERROR_ALLOWLIST = Object.freeze([
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
export const WINDOWS_PREPARED_DIRECTORY_ERROR_ALLOWLIST = Object.freeze([
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

// This is a qualification-only diagnostic for a narrow node:sqlite failure
// seam.  Node's DatabaseSync native implementation publishes SQLite's
// extended result code as the numeric `errcode` property; only the primary
// low byte is used here.  Never inspect or forward `message`, `errstr`,
// `code`, SQL, paths, or any other property from the thrown object.
// SQLite's documented primary result codes are deliberately mapped one by
// one.  A few existing aggregate names are retained because they are useful
// for the qualification lane (for example, lock contention), but every
// documented primary value has a named category and therefore cannot silently
// collapse into OTHER.  The map is the only source of category values that
// may cross the content-free qualification boundary.
export const WINDOWS_SQLITE_PRIMARY_ERROR_CATEGORY_BY_CODE = Object.freeze({
  0: "SQLITE_OK",
  1: "SQLITE_ERROR",
  2: "SQLITE_INTERNAL",
  3: "SQLITE_PERM",
  4: "SQLITE_ABORT",
  5: "BUSY_LOCKED",
  6: "BUSY_LOCKED",
  7: "SQLITE_NOMEM",
  8: "READONLY",
  9: "SQLITE_INTERRUPT",
  10: "CANTOPEN_IOERR",
  11: "CORRUPT_NOTADB",
  12: "SQLITE_NOTFOUND",
  13: "SQLITE_FULL",
  14: "CANTOPEN_IOERR",
  15: "SQLITE_PROTOCOL",
  16: "SQLITE_EMPTY",
  17: "SQLITE_SCHEMA",
  18: "SQLITE_TOOBIG",
  19: "SQLITE_CONSTRAINT",
  20: "SQLITE_MISMATCH",
  21: "SQLITE_MISUSE",
  22: "SQLITE_NOLFS",
  23: "SQLITE_AUTH",
  24: "SQLITE_FORMAT",
  25: "SQLITE_RANGE",
  26: "CORRUPT_NOTADB",
  27: "SQLITE_NOTICE",
  28: "SQLITE_WARNING",
  100: "SQLITE_ROW",
  101: "SQLITE_DONE",
});
export const WINDOWS_SQLITE_ERROR_CATEGORY_ALLOWLIST = Object.freeze([
  ...new Set(Object.values(WINDOWS_SQLITE_PRIMARY_ERROR_CATEGORY_BY_CODE)),
  "OTHER",
  "UNAVAILABLE",
]);
const SQLITE_MAX_ERROR_CODE = 0x7fffffff;

/**
 * Map one numeric SQLite extended result code to a bounded diagnostic class.
 * Invalid, missing, or non-numeric values remain explicitly unavailable.
 */
export function classifyWindowsSqliteErrorCode(errcode) {
  if (!Number.isSafeInteger(errcode)
      || errcode < 0
      || errcode > SQLITE_MAX_ERROR_CODE) {
    return "UNAVAILABLE";
  }
  const primaryCode = errcode % 256;
  return Object.hasOwn(WINDOWS_SQLITE_PRIMARY_ERROR_CATEGORY_BY_CODE, primaryCode)
    ? WINDOWS_SQLITE_PRIMARY_ERROR_CATEGORY_BY_CODE[primaryCode]
    : "OTHER";
}

/**
 * Read only Node's documented/native numeric SQLite error field.  Requiring
 * an own property keeps an arbitrary prototype value from being treated as a
 * provenance-bearing Node SQLite result.  The returned value is always one
 * of WINDOWS_SQLITE_ERROR_CATEGORY_ALLOWLIST.
 */
export function classifyWindowsSqliteError(error) {
  try {
    if (error === null
        || (typeof error !== "object" && typeof error !== "function")
        || !Object.hasOwn(error, "errcode")) {
      return "UNAVAILABLE";
    }
    return classifyWindowsSqliteErrorCode(error.errcode);
  } catch {
    return "UNAVAILABLE";
  }
}
const QUALIFICATION_ENVIRONMENT = "USAGE_MONITOR_WINDOWS_QUALIFICATION";
const QUALIFICATION_REVISION_ENVIRONMENT = "TIBOTATTLE_QUALIFICATION_REVISION";
const QUALIFICATION_CACHE_MODE_ENVIRONMENT = "TIBOTATTLE_QUALIFICATION_CACHE_MODE";
const QUALIFICATION_RUN_TIMEOUT_MS = 30 * 60 * 1_000;
const QUALIFICATION_TERMINATION_TIMEOUT_MS = 10_000;
const QUALIFICATION_MAXIMUM_CAPTURE_BYTES = 5_000_000;
const MAXIMUM_FAILURE_METADATA_ITEMS = 64;

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
  return extractTapTestIndexes(output)[0] ?? null;
}

export function extractTapTestIndexes(output) {
  const indexes = [];
  if (typeof output !== "string") return Object.freeze(indexes);
  const seen = new Set();
  const pattern = /^not ok ([0-9]+) -(?:[ \t]|(?:\r?$))/gmu;
  for (const match of output.matchAll(pattern)) {
    const index = safeTapTestIndex(Number.parseInt(match[1], 10));
    if (index === null || seen.has(index)) continue;
    seen.add(index);
    indexes.push(index);
    if (indexes.length === MAXIMUM_FAILURE_METADATA_ITEMS) break;
  }
  return Object.freeze(indexes);
}

function safeTapLocation(line, column) {
  const safeLine = safeTapTestIndex(line);
  const safeColumn = safeTapTestIndex(column);
  return safeLine === null || safeColumn === null
    ? null
    : Object.freeze([safeLine, safeColumn]);
}

export function extractTapTestLocations(output) {
  const locations = [];
  if (typeof output !== "string") return Object.freeze(locations);
  const seen = new Set();
  const pattern = /(?:^|[\s("'`])(?:(?:file:\/\/\/|[A-Za-z]:[\\/]|[\\/])[^ \t\r\n"'`()\[\]{}]*[\\/])?test[\\/]windows-filesystem-security\.test\.js:(\d+):(\d+)(?=$|[^0-9])/gu;
  for (const line of output.split(/\r?\n/u)) {
    for (const match of line.matchAll(pattern)) {
      const location = safeTapLocation(
        Number.parseInt(match[1], 10),
        Number.parseInt(match[2], 10),
      );
      if (location === null) continue;
      const key = `${location[0]}:${location[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      locations.push(location);
      if (locations.length === MAXIMUM_FAILURE_METADATA_ITEMS) {
        return Object.freeze(locations);
      }
    }
  }
  return Object.freeze(locations);
}

/**
 * Extract numeric file/line/column triples only for the exact qualification
 * test set. The file ordinal is the one-based index in lexical execution
 * order; no test filename or path crosses the content-free boundary.
 */
export function extractTapQualificationTestLocations(output) {
  const locations = [];
  if (typeof output !== "string") return Object.freeze(locations);
  const seen = new Set();
  const escapedFiles = [...QUALIFICATION_TAP_FILE_ORDINALS.keys()]
    .map((file) => file.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  const pattern = new RegExp(
    `(?:^|[\\s(])(?:(?:file:\\/\\/\\/|[A-Za-z]:[\\\\/]|[\\\\/])[^ \\t\\r\\n\"'()\\[\\]{}]*[\\\\/])?test[\\\\/](${escapedFiles}):(\\d+):(\\d+)(?=$|[^0-9])`,
    "gu",
  );
  for (const line of output.split(/\r?\n/u)) {
    for (const match of line.matchAll(pattern)) {
      const fileOrdinal = QUALIFICATION_TAP_FILE_ORDINALS.get(match[1]) ?? null;
      const sourceLine = safeTapTestIndex(Number.parseInt(match[2], 10));
      const sourceColumn = safeTapTestIndex(Number.parseInt(match[3], 10));
      if (fileOrdinal === null || sourceLine === null || sourceColumn === null) continue;
      const key = `${fileOrdinal}:${sourceLine}:${sourceColumn}`;
      if (seen.has(key)) continue;
      seen.add(key);
      locations.push(Object.freeze([fileOrdinal, sourceLine, sourceColumn]));
      if (locations.length === MAXIMUM_FAILURE_METADATA_ITEMS) {
        return Object.freeze(locations);
      }
    }
  }
  return Object.freeze(locations);
}

function safeCapturedTapTestIndexes(value) {
  if (!Array.isArray(value) || value.length > MAXIMUM_FAILURE_METADATA_ITEMS) {
    return null;
  }
  const seen = new Set();
  const indexes = [];
  for (const valueIndex of value) {
    const index = safeTapTestIndex(valueIndex);
    if (index === null || seen.has(index)) return null;
    seen.add(index);
    indexes.push(index);
  }
  return indexes;
}

function safeCapturedTapTestLocations(value) {
  if (!Array.isArray(value) || value.length > MAXIMUM_FAILURE_METADATA_ITEMS) {
    return null;
  }
  const seen = new Set();
  const locations = [];
  for (const valueLocation of value) {
    if (!Array.isArray(valueLocation) || valueLocation.length !== 2) return null;
    const line = safeTapTestIndex(valueLocation[0]);
    const column = safeTapTestIndex(valueLocation[1]);
    if (line === null || column === null) return null;
    const key = `${line}:${column}`;
    if (seen.has(key)) return null;
    seen.add(key);
    locations.push([line, column]);
  }
  return locations;
}

function safeCapturedTapQualificationTestLocations(value) {
  if (!Array.isArray(value) || value.length > MAXIMUM_FAILURE_METADATA_ITEMS) {
    return null;
  }
  const seen = new Set();
  const locations = [];
  for (const valueLocation of value) {
    if (!Array.isArray(valueLocation) || valueLocation.length !== 3) return null;
    const fileOrdinal = safeTapTestIndex(valueLocation[0]);
    const line = safeTapTestIndex(valueLocation[1]);
    const column = safeTapTestIndex(valueLocation[2]);
    if (fileOrdinal === null
        || fileOrdinal > QUALIFICATION_TAP_TEST_FILES.length
        || line === null
        || column === null) return null;
    const key = `${fileOrdinal}:${line}:${column}`;
    if (seen.has(key)) return null;
    seen.add(key);
    locations.push([fileOrdinal, line, column]);
  }
  return locations;
}

function safeCapturedSqliteErrorCategories(value) {
  if (!Array.isArray(value) || value.length > MAXIMUM_FAILURE_METADATA_ITEMS) {
    return null;
  }
  const categories = [];
  const seen = new Set();
  try {
    for (const category of value) {
      if (!WINDOWS_SQLITE_ERROR_CATEGORY_ALLOWLIST.includes(category)
          || seen.has(category)) {
        return null;
      }
      seen.add(category);
      categories.push(category);
    }
  } catch {
    return null;
  }
  return Object.freeze(categories);
}

function safeCapturedUnifiedIndexStages(value) {
  if (!Array.isArray(value) || value.length > MAXIMUM_FAILURE_METADATA_ITEMS) {
    return null;
  }
  const stages = [];
  const seen = new Set();
  try {
    for (const stage of value) {
      if (!WINDOWS_UNIFIED_INDEX_PHASE_ALLOWLIST.includes(stage)
          || seen.has(stage)) {
        return null;
      }
      seen.add(stage);
      stages.push(stage);
    }
  } catch {
    return null;
  }
  return Object.freeze(stages);
}

function safeQualificationFailureStatus(error) {
  return error?.code && Object.values(FIXED_STATUS).includes(error.code)
    ? error.code
    : FIXED_STATUS.failed;
}

/**
 * Format a qualification failure without forwarding captured TAP content.
 *
 * The child process output is untrusted. Only the fixed status and validated,
 * bounded numeric TAP metadata are allowed to reach the CLI. Test names,
 * paths, messages, stacks, and arbitrary properties must remain private.
 */
export function formatWindowsSecurityQualificationFailure(error) {
  const status = safeQualificationFailureStatus(error);
  const testIndex = safeTapTestIndex(error?.testIndex) ?? "unavailable";
  const testIndexes = safeCapturedTapTestIndexes(error?.testIndexes);
  const testLocations = safeCapturedTapTestLocations(error?.testLocations);
  const testFileLocations = safeCapturedTapQualificationTestLocations(
    error?.testFileLocations,
  );
  const nativeErrors = Array.isArray(error?.nativeErrors)
    && error.nativeErrors.length <= MAXIMUM_FAILURE_METADATA_ITEMS
    && error.nativeErrors.every(
      (value, index, values) => WINDOWS_SQLITE_PUBLISH_ERROR_ALLOWLIST.includes(value)
        && values.indexOf(value) === index,
    )
    ? error.nativeErrors
    : null;
  const sqliteErrorCategories = safeCapturedSqliteErrorCategories(
    error?.sqliteErrorCategories,
  );
  const unifiedIndexStages = safeCapturedUnifiedIndexStages(
    error?.unifiedIndexStages,
  );
  const preparedStages = Array.isArray(error?.preparedStages)
    && error.preparedStages.length <= MAXIMUM_FAILURE_METADATA_ITEMS
    && error.preparedStages.every(
      (value, index, values) => WINDOWS_PREPARED_DIRECTORY_STAGE_ALLOWLIST.includes(value)
        && values.indexOf(value) === index,
    )
    ? error.preparedStages
    : null;
  const preparedErrors = Array.isArray(error?.preparedErrors)
    && error.preparedErrors.length <= MAXIMUM_FAILURE_METADATA_ITEMS
    && error.preparedErrors.every(
      (value, index, values) => WINDOWS_PREPARED_DIRECTORY_ERROR_ALLOWLIST.includes(value)
        && values.indexOf(value) === index,
    )
    ? error.preparedErrors
    : null;
  const preparedMetadata = (preparedStages !== null && preparedStages.length > 0)
    || (preparedErrors !== null && preparedErrors.length > 0)
    ? ` prepared_stages=${preparedStages !== null && preparedStages.length > 0
      ? preparedStages.join(",")
      : "unavailable"}`
      + ` prepared_errors=${preparedErrors !== null && preparedErrors.length > 0
        ? preparedErrors.join(",")
        : "unavailable"}`
    : "";
  const sqliteMetadata = sqliteErrorCategories !== null
      && sqliteErrorCategories.length > 0
    ? ` sqlite_error_categories=${sqliteErrorCategories.join(",")}`
    : "";
  const unifiedIndexMetadata = unifiedIndexStages !== null
      && unifiedIndexStages.length > 0
    ? ` unified_index_stages=${unifiedIndexStages.join(",")}`
    : "";
  return `${status} test_index=${testIndex}`
    + ` test_indexes=${testIndexes !== null && testIndexes.length > 0
      ? testIndexes.join(",")
      : "unavailable"}`
    + ` test_locations=${testLocations !== null && testLocations.length > 0
      ? testLocations.map(([line, column]) => `${line}:${column}`).join(";")
      : "unavailable"}`
    + ` test_file_locations=${testFileLocations !== null && testFileLocations.length > 0
      ? testFileLocations.map((location) => location.join(":")).join(";")
      : "unavailable"}`
    + ` native_errors=${nativeErrors !== null && nativeErrors.length > 0
      ? nativeErrors.join(",")
      : "unavailable"}`
    + sqliteMetadata
    + preparedMetadata
    + unifiedIndexMetadata;
}

/**
 * Extract only the fixed SQLite publication phase from a TAP diagnostic
 * property line. TAP output is untrusted test output: require the comment
 * marker, exact property name, and an allowlisted value, and retain no other
 * part of the line.
 */
export function extractTapPublishStages(output) {
  const stages = [];
  if (typeof output !== "string") return Object.freeze(stages);
  const seen = new Set();
  const allowlisted = new Set(WINDOWS_SQLITE_PUBLISH_STAGE_ALLOWLIST);
  const pattern = /^\s*#\s+windowsFilesystemStage\s*:\s*(['"]?)([a-z_]+)\1\s*$/gmu;
  for (const match of output.matchAll(pattern)) {
    const stage = match[2];
    if (!allowlisted.has(stage) || seen.has(stage)) continue;
    seen.add(stage);
    stages.push(stage);
    if (stages.length === MAXIMUM_FAILURE_METADATA_ITEMS) break;
  }
  return Object.freeze(stages);
}

// Keep the longer name available to callers that describe the native
// property rather than the SQLite operation; both names share one parser.
export const extractTapWindowsFilesystemPublishStages = extractTapPublishStages;

/**
 * Extract only fixed prepared-directory phases from TAP diagnostics.
 * Qualification output is untrusted; require an exact comment property and
 * retain only the finite operation vocabulary above.
 */
export function extractTapPreparedStages(output) {
  const stages = [];
  if (typeof output !== "string") return Object.freeze(stages);
  const seen = new Set();
  const allowlisted = new Set(WINDOWS_PREPARED_DIRECTORY_STAGE_ALLOWLIST);
  const pattern = /^\s*#\s+windowsFilesystemStage\s*:\s*(['"]?)([a-z_]+)\1\s*$/gmu;
  for (const match of output.matchAll(pattern)) {
    const stage = match[2];
    if (!allowlisted.has(stage) || seen.has(stage)) continue;
    seen.add(stage);
    stages.push(stage);
    if (stages.length === MAXIMUM_FAILURE_METADATA_ITEMS) break;
  }
  return Object.freeze(stages);
}

export const extractTapWindowsPreparedDirectoryStages = extractTapPreparedStages;

/**
 * Extract only fixed native error classes from TAP diagnostic property lines.
 * Do not parse TAP YAML, test names, stack frames, or arbitrary comments.
 */
export function extractTapPublishErrors(output) {
  const errors = [];
  if (typeof output !== "string") return Object.freeze(errors);
  const seen = new Set();
  const allowlisted = new Set(WINDOWS_SQLITE_PUBLISH_ERROR_ALLOWLIST);
  const pattern = /^\s*#\s+windowsFilesystemError\s*:\s*(['"]?)(WINDOWS_FILESYSTEM_[A-Z0-9_]+)\1\s*$/gmu;
  for (const match of output.matchAll(pattern)) {
    const errorCode = match[2];
    if (!allowlisted.has(errorCode) || seen.has(errorCode)) continue;
    seen.add(errorCode);
    errors.push(errorCode);
    if (errors.length === MAXIMUM_FAILURE_METADATA_ITEMS) break;
  }
  return Object.freeze(errors);
}

export const extractTapWindowsFilesystemPublishErrors = extractTapPublishErrors;

/**
 * Extract only fixed prepared-directory error classes from TAP diagnostics.
 * Messages, stacks, paths, and test names are never parsed or returned.
 */
export function extractTapPreparedErrors(output) {
  const errors = [];
  if (typeof output !== "string") return Object.freeze(errors);
  const seen = new Set();
  const allowlisted = new Set(WINDOWS_PREPARED_DIRECTORY_ERROR_ALLOWLIST);
  const pattern = /^\s*#\s+windowsFilesystemError\s*:\s*(['"]?)(WINDOWS_FILESYSTEM_[A-Z0-9_]+)\1\s*$/gmu;
  for (const match of output.matchAll(pattern)) {
    const errorCode = match[2];
    if (!allowlisted.has(errorCode) || seen.has(errorCode)) continue;
    seen.add(errorCode);
    errors.push(errorCode);
    if (errors.length === MAXIMUM_FAILURE_METADATA_ITEMS) break;
  }
  return Object.freeze(errors);
}

export const extractTapWindowsPreparedDirectoryErrors = extractTapPreparedErrors;

/**
 * Extract only allowlisted native filesystem error codes from Node TAP error
 * diagnostics. Messages, stacks, paths, and test names remain private.
 */
export function extractTapNativeErrors(output) {
  const errors = [];
  if (typeof output !== "string") return Object.freeze(errors);
  const seen = new Set();
  const allowlisted = new Set(WINDOWS_SQLITE_PUBLISH_ERROR_ALLOWLIST);
  const pattern = /^\s*#\s+code:\s*(['"]?)(WINDOWS_FILESYSTEM_[A-Z0-9_]+)\1\s*$/gmu;
  for (const match of output.matchAll(pattern)) {
    const errorCode = match[2];
    if (!allowlisted.has(errorCode) || seen.has(errorCode)) continue;
    seen.add(errorCode);
    errors.push(errorCode);
    if (errors.length === MAXIMUM_FAILURE_METADATA_ITEMS) break;
  }
  return Object.freeze(errors);
}

/**
 * Extract only the fixed SQLite error category emitted by the one
 * qualification-only diagnostic seam.  The line must be an exact TAP
 * diagnostic with one allowlisted value; no surrounding text is accepted.
 */
export function extractTapSqliteErrorCategories(output) {
  const categories = [];
  if (typeof output !== "string") return Object.freeze(categories);
  const seen = new Set();
  const escapedCategories = WINDOWS_SQLITE_ERROR_CATEGORY_ALLOWLIST
    .map((category) => category.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  const pattern = new RegExp(
    `^\\s*#\\s+windowsSqliteErrorCategory\\s*:\\s*(${escapedCategories})\\s*$`,
    "gmu",
  );
  for (const match of output.matchAll(pattern)) {
    const category = match[1];
    if (seen.has(category)) continue;
    seen.add(category);
    categories.push(category);
    if (categories.length === MAXIMUM_FAILURE_METADATA_ITEMS) break;
  }
  return Object.freeze(categories);
}

export const extractTapWindowsSqliteErrorCategories = extractTapSqliteErrorCategories;

/**
 * Extract only the fixed unified-index ingest phase from a TAP diagnostic.
 * Require an exact comment property and allowlisted value; no arbitrary
 * suffix, path, SQL, or error text is retained.
 */
export function extractTapUnifiedIndexStages(output) {
  const stages = [];
  if (typeof output !== "string") return Object.freeze(stages);
  const seen = new Set();
  const escapedStages = WINDOWS_UNIFIED_INDEX_PHASE_ALLOWLIST
    .map((stage) => stage.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  const pattern = new RegExp(
    `^\\s*#\\s+unifiedIndexStage\\s*:\\s*(${escapedStages})\\s*$`,
    "gmu",
  );
  for (const match of output.matchAll(pattern)) {
    const stage = match[1];
    if (seen.has(stage)) continue;
    seen.add(stage);
    stages.push(stage);
    if (stages.length === MAXIMUM_FAILURE_METADATA_ITEMS) break;
  }
  return Object.freeze(stages);
}

export const extractTapWindowsUnifiedIndexStages = extractTapUnifiedIndexStages;

function fixedFailureWithTapMetadata(output) {
  const error = fixedError(FIXED_STATUS.failed);
  error.testIndexes = extractTapTestIndexes(output);
  error.testLocations = extractTapTestLocations(output);
  error.testFileLocations = extractTapQualificationTestLocations(output);
  error.nativeErrors = extractTapNativeErrors(output);
  error.sqliteErrorCategories = extractTapSqliteErrorCategories(output);
  error.sqliteErrorCategory = error.sqliteErrorCategories[0] ?? null;
  error.testIndex = error.testIndexes[0] ?? null;
  error.publishStages = extractTapPublishStages(output);
  error.publishStage = error.publishStages[0] ?? null;
  error.publishErrors = extractTapPublishErrors(output);
  error.publishError = error.publishErrors[0] ?? null;
  error.preparedStages = extractTapPreparedStages(output);
  error.preparedStage = error.preparedStages[0] ?? null;
  error.preparedErrors = extractTapPreparedErrors(output);
  error.preparedError = error.preparedErrors[0] ?? null;
  error.unifiedIndexStages = extractTapUnifiedIndexStages(output);
  error.unifiedIndexStage = error.unifiedIndexStages[0] ?? null;
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
        settle(rejectRun, fixedFailureWithTapMetadata(stdout));
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
    console.error(formatWindowsSecurityQualificationFailure(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main();
}
