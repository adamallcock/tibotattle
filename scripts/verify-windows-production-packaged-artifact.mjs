#!/usr/bin/env node

/**
 * Verify the read-only, post-builder Windows x64 application directory.
 *
 * The authority manifest is the only source of expected signed native rows.
 * The runtime manifest remains the source of the unsigned application
 * closure; this verifier overlays the authority's two signed `.node` rows on
 * that closure before comparing the staging tree and the ASAR/unpacked pair.
 * It does not inspect Authenticode, invoke a signer, inspect an installer, or
 * claim that an installed application works.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants as fileSystemConstants } from "node:fs";
import {
  link,
  lstat,
  open,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import {
  createRequire as createModuleRequire,
} from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isProxy } from "node:util/types";

import {
  WINDOWS_PRODUCTION_AUTHORITY_NATIVE_MODULES,
  WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH,
  parseWindowsProductionAuthorityManifest,
  serializeWindowsProductionAuthorityManifest,
} from "../src/platform/windows-production-authority-manifest.js";
import {
  WINDOWS_PRODUCTION_AUTHENTICODE_DLL_ALLOWLIST,
  WINDOWS_PRODUCTION_AUTHENTICODE_MAIN_EXECUTABLE,
  WINDOWS_PRODUCTION_AUTHENTICODE_NATIVE_MODULES,
  computeWindowsProductionAuthenticodeInventoryDigest,
} from "./verify-windows-production-authenticode-inventory.mjs";
import { windowsInstallerArtifactFileName } from "../config/windows-installer-contract.js";
import {
  transformElectronBuilderPackageJsonBytes,
} from "./lib/electron-builder-package-json.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const moduleRequire = createModuleRequire(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
export const WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_PRODUCTION_ROOT = resolve(
  REPOSITORY_ROOT,
  ".release-build/electron-production/windows-x64",
);
export const WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_STAGING_ROOT = join(
  WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_PRODUCTION_ROOT,
  "app",
);
export const WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_ARTIFACTS_ROOT = join(
  WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_PRODUCTION_ROOT,
  "artifacts",
);
export const WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_EVIDENCE_ROOT = join(
  WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_PRODUCTION_ROOT,
  "evidence",
);
export const WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_AUTHORITY_FILE = "authority.json";
export const WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_SIGNING_LEDGER_FILE =
  "windows-signing-operation-ledger.json";
export const WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_WIN_UNPACKED_ROOT = join(
  WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_ARTIFACTS_ROOT,
  "win-unpacked",
);
export const WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_RECEIPT_FILE =
  "packaged-artifact-receipt.json";
const MAXIMUM_RUNTIME_MANIFEST_BYTES = 1 * 1024 * 1024;
const MAXIMUM_NATIVE_BYTES = 64 * 1024 * 1024;
const MAXIMUM_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
const ARCHIVE_SNAPSHOT_CHUNK_BYTES = 1024 * 1024;
const RUNTIME_MANIFEST_SCHEMA = "usage-monitor-electron-runtime-v0.1";
const WINDOWS_BINDING_PATH =
  "native/windows-filesystem/build/Release/windows_filesystem.node";
const WINDOWS_BINDING_MANIFEST_PATH = `${WINDOWS_BINDING_PATH}.manifest.json`;
const NATIVE_MODULE_PATHS = new Set(
  WINDOWS_PRODUCTION_AUTHORITY_NATIVE_MODULES.map(({ packagedPath }) => packagedPath),
);
const INVENTORY_KINDS = new Set([
  "companion_source",
  "electron_shell",
  "dashboard_asset",
  "workspace_dependency",
  "third_party_dependency",
  "windows_native_binding",
  "runtime_metadata",
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const READ_ONLY_FLAG = fileSystemConstants.O_RDONLY ?? 0;
const NO_FOLLOW_FLAG = fileSystemConstants.O_NOFOLLOW ?? 0;
const UNSUPPORTED_NO_FOLLOW_CODES = new Set([
  "EINVAL",
  "ENOTSUP",
  "EOPNOTSUPP",
  "UNKNOWN",
]);

export const WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_STATUS =
  "WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_VERIFIED";
export const WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS = Object.freeze({
  authorityInvalid: "WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_AUTHORITY_INVALID",
  authorityNoncanonical: "WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_AUTHORITY_NONCANONICAL",
  inputInvalid: "WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_INPUT_INVALID",
  inputMissing: "WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_INPUT_MISSING",
  runtimeManifestInvalid: "WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_RUNTIME_MANIFEST_INVALID",
  stagedInventoryInvalid: "WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_STAGED_INVENTORY_INVALID",
  nativeMismatch: "WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_NATIVE_MISMATCH",
  archiveInvalid: "WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_ARCHIVE_INVALID",
  unpackedInvalid: "WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_UNPACKED_INVALID",
  inventoryMismatch: "WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_INVENTORY_MISMATCH",
  sidecarMismatch: "WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_SIDECAR_MISMATCH",
  rootsInvalid: "WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_ROOTS_INVALID",
  rootReplaced: "WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_ROOT_REPLACED",
  linkRejected: "WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_LINK_REJECTED",
  outputExists: "WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_OUTPUT_EXISTS",
  outputInvalid: "WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_OUTPUT_INVALID",
  receiptInvalid: "WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_RECEIPT_INVALID",
  receiptNoncanonical: "WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_RECEIPT_NONCANONICAL",
  passed: WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_STATUS,
});

const KNOWN_STATUSES = new Set(
  Object.values(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS),
);
const PACKAGE_JSON_PATH = "package.json";
const PACKAGED_RECEIPT_KEYS = Object.freeze([
  "asar",
  "authority",
  "ledger",
  "nativeFileCount",
  "peInventory",
  "staged",
  "status",
  "target",
  "unpacked",
]);
const PACKAGE_AGGREGATE_KEYS = Object.freeze(["bytes", "count", "sha256"]);
const PACKAGE_PE_INVENTORY_KEYS = Object.freeze([
  "bytes",
  "count",
  "sha256",
  "signedCount",
]);
const MAXIMUM_RECEIPT_BYTES = 64 * 1024;
const RECEIPT_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const VERIFICATION_OPTION_KEYS = Object.freeze([
  "authorityBytes",
  "signingLedgerBytes",
  "stagedPath",
  "winUnpackedPath",
  "asarPath",
  "unpackedPath",
]);

class WindowsProductionPackagedArtifactError extends Error {
  constructor(code) {
    super("Windows production packaged artifact verification failed");
    this.name = "WindowsProductionPackagedArtifactError";
    this.code = code;
  }
}

function fail(code) {
  throw new WindowsProductionPackagedArtifactError(code);
}

function comparePathBytes(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function inventoryDigest(rows) {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const row of [...rows].sort((left, right) => comparePathBytes(left.path, right.path))) {
    bytes += row.bytes;
    hash.update(`F\0${row.path}\0${row.bytes}\0${row.sha256}\0`);
  }
  return Object.freeze({ count: rows.length, bytes, sha256: hash.digest("hex") });
}

function payloadDigest(rows) {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const row of [...rows].sort((left, right) => comparePathBytes(left.path, right.path))) {
    bytes += row.bytes;
    hash.update(`F\0${row.path}\0${row.bytes}\0${row.sha256}\0${row.kind}\0`);
  }
  return Object.freeze({ bytes, sha256: hash.digest("hex") });
}

function normalizeRelativePath(value, status) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\\")
      || value.includes("\0")
      || isAbsolute(value)
      || /^[A-Za-z]:/u.test(value)) {
    fail(status);
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    fail(status);
  }
  return parts.join("/");
}

function normalizeInputPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inputInvalid);
  }
  try {
    return resolve(value);
  } catch {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inputInvalid);
  }
}

function pathIsInside(parent, child) {
  const suffix = relative(resolve(parent), resolve(child));
  return suffix === ""
    || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

async function assertNoSymlinkPathComponents(path, status) {
  const selected = resolve(path);
  let current = selected;
  while (true) {
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error?.code !== "ENOENT") fail(status);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
      continue;
    }
    if (metadata.isSymbolicLink()) {
      // macOS commonly exposes /var as a compatibility symlink to /private/var.
      if (process.platform === "darwin"
          && current === "/var"
          && await realpath(current) === "/private/var") {
        current = dirname(current);
        continue;
      }
      fail(status);
    }
    if (!metadata.isDirectory() && current !== selected) fail(status);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function assertContained(root, path, status) {
  try {
    const [rootRealpath, pathRealpath] = await Promise.all([
      realpath(root),
      realpath(path),
    ]);
    if (!pathIsInside(rootRealpath, pathRealpath)) fail(status);
  } catch {
    fail(status);
  }
}

async function assertDirectory(path, status) {
  await assertNoSymlinkPathComponents(path, status);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    fail(error?.code === "ENOENT"
      ? WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inputMissing
      : status);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(status);
  }
}

async function assertRegularFile(path, status) {
  await assertNoSymlinkPathComponents(path, status);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    fail(error?.code === "ENOENT"
      ? WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inputMissing
      : status);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    fail(status);
  }
}

/**
 * Bind the archive pair to the real electron-builder win-unpacked payload.
 *
 * This verifier qualifies only the application payload under
 * `<win-unpacked>/resources`; it does not qualify the outer NSIS installer.
 * All components are checked before realpath comparison so a relocated tree,
 * a symlinked resources directory, or an unrelated ASAR cannot be presented
 * as the post-builder subject.
 */
async function validateApplicationPayloadPaths({
  winUnpackedPath,
  asarPath,
  unpackedPath,
}) {
  const status = WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inputInvalid;
  const selectedWinUnpackedPath = normalizeInputPath(winUnpackedPath);
  const selectedAsarPath = normalizeInputPath(asarPath);
  const selectedUnpackedPath = normalizeInputPath(unpackedPath);
  const selectedResourcesPath = join(selectedWinUnpackedPath, "resources");

  await assertDirectory(selectedWinUnpackedPath, status);
  await assertDirectory(selectedResourcesPath, status);
  await assertRegularFile(selectedAsarPath, status);
  await assertDirectory(selectedUnpackedPath, status);

  try {
    const [rootRealpath, resourcesRealpath, asarRealpath, unpackedRealpath] =
      await Promise.all([
        realpath(selectedWinUnpackedPath),
        realpath(selectedResourcesPath),
        realpath(selectedAsarPath),
        realpath(selectedUnpackedPath),
      ]);
    const expectedAsarRealpath = resolve(resourcesRealpath, "app.asar");
    const expectedUnpackedRealpath = `${expectedAsarRealpath}.unpacked`;
    if (resolve(asarRealpath) !== expectedAsarRealpath
        || resolve(unpackedRealpath) !== expectedUnpackedRealpath
        || !pathIsInside(rootRealpath, resourcesRealpath)
        || !pathIsInside(rootRealpath, asarRealpath)
        || !pathIsInside(rootRealpath, unpackedRealpath)) {
      fail(status);
    }
    return Object.freeze({
      winUnpackedPath: selectedWinUnpackedPath,
      asarPath: selectedAsarPath,
      unpackedPath: selectedUnpackedPath,
    });
  } catch (error) {
    if (error instanceof WindowsProductionPackagedArtifactError) throw error;
    fail(status);
  }
}

function statFingerprint(metadata) {
  return [
    metadata.dev,
    metadata.ino,
    metadata.mode,
    metadata.size,
    metadata.mtimeMs,
    metadata.ctimeMs,
    metadata.nlink,
  ].map((value) => String(value)).join("\0");
}

function statIdentity(metadata) {
  return [metadata.dev, metadata.ino].map((value) => String(value)).join("\0");
}

function validateRegularMetadata(metadata, status, maximumBytes = null) {
  if (!metadata
      || !metadata.isFile()
      || metadata.isSymbolicLink?.()
      || metadata.nlink !== 1
      || !Number.isSafeInteger(metadata.size)
      || metadata.size < 0
      || (maximumBytes !== null && metadata.size > maximumBytes)) {
    fail(status);
  }
}

function unsupportedNoFollow(error) {
  return UNSUPPORTED_NO_FOLLOW_CODES.has(error?.code);
}

async function readRegularFile(path, status, root = null, maximumBytes = null) {
  let handle;
  let fallback = null;
  try {
    await assertNoSymlinkPathComponents(path, status);
    if (root !== null) {
      await assertNoSymlinkPathComponents(root, status);
      await assertContained(root, path, status);
    }
    try {
      handle = await open(path, READ_ONLY_FLAG | NO_FOLLOW_FLAG);
    } catch (error) {
      if (!(process.platform === "win32"
          && (NO_FOLLOW_FLAG === 0 || unsupportedNoFollow(error)))) {
        throw error;
      }
      const beforePath = await lstat(path);
      if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1) {
        fail(status);
      }
      fallback = statFingerprint(beforePath);
      handle = await open(path, READ_ONLY_FLAG);
    }
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink?.() || before.nlink !== 1) fail(status);
    if (maximumBytes !== null && before.size > maximumBytes) fail(status);
    if (fallback !== null && fallback !== statFingerprint(before)) fail(status);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || statFingerprint(before) !== statFingerprint(after)
        || after.size !== bytes.byteLength) fail(status);
    if (fallback !== null) {
      const afterPath = await lstat(path);
      if (!afterPath.isFile() || afterPath.isSymbolicLink() || afterPath.nlink !== 1
          || statFingerprint(afterPath) !== statFingerprint(after)) fail(status);
    }
    if (root !== null) await assertContained(root, path, status);
    return Buffer.from(bytes);
  } catch (error) {
    if (error instanceof WindowsProductionPackagedArtifactError) throw error;
    if (error?.code === "ENOENT") fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inputMissing);
    fail(status);
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Take a bounded, descriptor-backed snapshot of one ASAR file. The path and
 * descriptor are checked before and after the streaming digest so callers can
 * detect both replacement and in-place mutation around path-based ASAR APIs.
 */
async function readArchiveSnapshot(path) {
  const status = WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.archiveInvalid;
  let handle;
  let fallback = null;
  try {
    await assertNoSymlinkPathComponents(path, status);
    let pathBefore = await lstat(path);
    validateRegularMetadata(pathBefore, status, MAXIMUM_ARCHIVE_BYTES);
    const canonicalBefore = await realpath(path);
    try {
      handle = await open(path, READ_ONLY_FLAG | NO_FOLLOW_FLAG);
    } catch (error) {
      if (!(process.platform === "win32"
          && (NO_FOLLOW_FLAG === 0 || unsupportedNoFollow(error)))) {
        throw error;
      }
      pathBefore = await lstat(path);
      validateRegularMetadata(pathBefore, status, MAXIMUM_ARCHIVE_BYTES);
      fallback = statFingerprint(pathBefore);
      handle = await open(path, READ_ONLY_FLAG);
    }

    const descriptorBefore = await handle.stat();
    validateRegularMetadata(descriptorBefore, status, MAXIMUM_ARCHIVE_BYTES);
    if (statFingerprint(pathBefore) !== statFingerprint(descriptorBefore)
        || statIdentity(pathBefore) !== statIdentity(descriptorBefore)
        || (fallback !== null && fallback !== statFingerprint(descriptorBefore))) {
      fail(status);
    }

    const digest = createHash("sha256");
    let offset = 0;
    while (offset < descriptorBefore.size) {
      const remaining = descriptorBefore.size - offset;
      const chunk = Buffer.allocUnsafe(Math.min(ARCHIVE_SNAPSHOT_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, offset);
      if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0) fail(status);
      digest.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }

    const descriptorAfter = await handle.stat();
    const pathAfter = await lstat(path);
    const canonicalAfter = await realpath(path);
    validateRegularMetadata(descriptorAfter, status, MAXIMUM_ARCHIVE_BYTES);
    validateRegularMetadata(pathAfter, status, MAXIMUM_ARCHIVE_BYTES);
    if (statFingerprint(descriptorBefore) !== statFingerprint(descriptorAfter)
        || statFingerprint(pathBefore) !== statFingerprint(pathAfter)
        || statIdentity(descriptorBefore) !== statIdentity(descriptorAfter)
        || statIdentity(pathBefore) !== statIdentity(pathAfter)
        || statIdentity(descriptorAfter) !== statIdentity(pathAfter)
        || canonicalBefore !== canonicalAfter
        || descriptorAfter.size !== offset) {
      fail(status);
    }
    return Object.freeze({
      bytes: descriptorBefore.size,
      canonicalPath: canonicalBefore,
      fileIdentity: statIdentity(descriptorBefore),
      pathIdentity: statIdentity(pathBefore),
      sha256: digest.digest("hex"),
    });
  } catch (error) {
    if (error instanceof WindowsProductionPackagedArtifactError) throw error;
    fail(status);
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Require the two descriptor-backed archive snapshots to be identical. */
export function assertStableArchiveSnapshot(before, after) {
  const status = WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.archiveInvalid;
  try {
    if (before === null || typeof before !== "object"
        || after === null || typeof after !== "object"
        || before.bytes !== after.bytes
        || before.canonicalPath !== after.canonicalPath
        || before.fileIdentity !== after.fileIdentity
        || before.pathIdentity !== after.pathIdentity
        || before.sha256 !== after.sha256
        || !SHA256_PATTERN.test(before.sha256)
        || !SHA256_PATTERN.test(after.sha256)) {
      fail(status);
    }
  } catch (error) {
    if (error instanceof WindowsProductionPackagedArtifactError) throw error;
    fail(status);
  }
}

function assertUniqueInventoryPath(path, exact, folded, status) {
  if (exact.has(path) || folded.has(path.toLowerCase())) fail(status);
  exact.add(path);
  folded.add(path.toLowerCase());
}

async function walkFiles(root, status) {
  await assertNoSymlinkPathComponents(root, status);
  const rows = [];
  const exact = new Set();
  const folded = new Set();

  async function walk(current, prefix) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      fail(status);
    }
    entries.sort((left, right) => comparePathBytes(left.name, right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) fail(status);
      if (entry.isDirectory()) {
        const metadata = await lstat(path).catch(() => null);
        if (!metadata || !metadata.isDirectory() || metadata.isSymbolicLink()) fail(status);
        await walk(path, relativePath);
        continue;
      }
      if (!entry.isFile()) fail(status);
      const normalized = normalizeRelativePath(relativePath.split(sep).join("/"), status);
      assertUniqueInventoryPath(normalized, exact, folded, status);
      const metadata = await lstat(path).catch(() => null);
      if (!metadata || metadata.nlink !== 1) fail(status);
      const bytes = await readRegularFile(path, status, root);
      rows.push({ bytes: bytes.byteLength, path: normalized, sha256: sha256(bytes) });
    }
  }

  await walk(root, "");
  rows.sort((left, right) => comparePathBytes(left.path, right.path));
  return rows;
}

function rowsByPath(rows, status) {
  const result = new Map();
  const folded = new Set();
  for (const row of rows) {
    if (result.has(row.path) || folded.has(row.path.toLowerCase())) fail(status);
    result.set(row.path, row);
    folded.add(row.path.toLowerCase());
  }
  return result;
}

function parseJsonBytes(bytes, status) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    fail(status);
  }
}

function exactKeys(value, keys, status) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(status);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) fail(status);
}

function readPackagedRecord(value, keys, status) {
  try {
    if (value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || isProxy(value)
        || Object.getPrototypeOf(value) !== Object.prototype) {
      fail(status);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    const expected = new Set(keys);
    if (ownKeys.length !== keys.length
        || ownKeys.some((key) => typeof key !== "string" || !expected.has(key))) {
      fail(status);
    }
    const selected = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor
          || !Object.hasOwn(descriptor, "value")
          || descriptor.get !== undefined
          || descriptor.set !== undefined
          || descriptor.enumerable !== true) {
        fail(status);
      }
      selected[key] = descriptor.value;
    }
    return selected;
  } catch (error) {
    if (error instanceof WindowsProductionPackagedArtifactError) throw error;
    fail(status);
  }
}

function deepFreezePackaged(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreezePackaged(child);
    Object.freeze(value);
  }
  return value;
}

function scanPackagedReceiptJson(text, invalidStatus, duplicateStatus) {
  if (typeof text !== "string" || text.length === 0) fail(invalidStatus);
  let index = 0;
  let nodes = 0;
  const whitespace = () => {
    while (index < text.length && /[\t\n\r ]/u.test(text[index])) index += 1;
  };
  const parseString = () => {
    const start = index;
    if (text[index] !== '"') fail(invalidStatus);
    index += 1;
    while (index < text.length) {
      const current = text[index];
      if (current === "\\") {
        index += 2;
        if (index > text.length) fail(invalidStatus);
        continue;
      }
      if (current < " ") fail(invalidStatus);
      index += 1;
      if (current === '"') {
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          fail(invalidStatus);
        }
      }
    }
    fail(invalidStatus);
  };
  const parseValue = (depth = 0) => {
    nodes += 1;
    if (depth > 64 || nodes > 4096) fail(invalidStatus);
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
        if (keys.has(key)) fail(duplicateStatus);
        keys.add(key);
        whitespace();
        if (text[index] !== ":") fail(invalidStatus);
        index += 1;
        parseValue(depth + 1);
        whitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") fail(invalidStatus);
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
        if (text[index] !== ",") fail(invalidStatus);
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
    if (!number) fail(invalidStatus);
    index += number[0].length;
  };
  parseValue();
  whitespace();
  if (index !== text.length) fail(invalidStatus);
}

function assertPackagedDigest(value, status) {
  const source = readPackagedRecord(value, ["bytes", "sha256"], status);
  if (!Number.isSafeInteger(source.bytes) || source.bytes <= 0
      || !RECEIPT_SHA256_PATTERN.test(source.sha256)) fail(status);
  return { bytes: source.bytes, sha256: source.sha256 };
}

function assertPackagedAggregate(value, status) {
  const source = readPackagedRecord(value, PACKAGE_AGGREGATE_KEYS, status);
  if (!Number.isSafeInteger(source.bytes) || source.bytes <= 0
      || !Number.isSafeInteger(source.count) || source.count <= 0
      || !RECEIPT_SHA256_PATTERN.test(source.sha256)) fail(status);
  return { bytes: source.bytes, count: source.count, sha256: source.sha256 };
}

function assertPackagedPeInventory(value, status) {
  const source = readPackagedRecord(value, PACKAGE_PE_INVENTORY_KEYS, status);
  if (!Number.isSafeInteger(source.bytes) || source.bytes <= 0
      || !Number.isSafeInteger(source.count) || source.count <= 0
      || !RECEIPT_SHA256_PATTERN.test(source.sha256)
      || !Number.isSafeInteger(source.signedCount)
      || source.signedCount !== source.count) {
    fail(status);
  }
  return {
    bytes: source.bytes,
    count: source.count,
    sha256: source.sha256,
    signedCount: source.signedCount,
  };
}

/**
 * Canonical content-free receipt contract for the packaged-artifact stage.
 * This lives beside the producer so the CLI, aggregate join, and portable
 * tests cannot silently drift into separate schemas.
 */
export function validateWindowsProductionPackagedArtifactReceipt(value) {
  const status = WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.receiptInvalid;
  const source = readPackagedRecord(value, PACKAGED_RECEIPT_KEYS, status);
  if (source.status !== WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_STATUS
      || source.target !== "win32-x64") fail(status);
  const selected = {
    status: source.status,
    target: source.target,
    authority: assertPackagedDigest(source.authority, status),
    ledger: assertPackagedDigest(source.ledger, status),
    peInventory: assertPackagedPeInventory(source.peInventory, status),
    staged: assertPackagedAggregate(source.staged, status),
    asar: assertPackagedAggregate(source.asar, status),
    unpacked: assertPackagedAggregate(source.unpacked, status),
    nativeFileCount: source.nativeFileCount,
  };
  if (!Number.isSafeInteger(selected.nativeFileCount)
      || selected.nativeFileCount <= 0
      || selected.nativeFileCount > 64
      || selected.nativeFileCount !== WINDOWS_PRODUCTION_AUTHORITY_NATIVE_MODULES.length) {
    fail(status);
  }
  return deepFreezePackaged(selected);
}

export function serializeWindowsProductionPackagedArtifactReceipt(value) {
  const selected = validateWindowsProductionPackagedArtifactReceipt(value);
  const serialized = `${JSON.stringify(selected)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_RECEIPT_BYTES) {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.outputInvalid);
  }
  return serialized;
}

export function parseWindowsProductionPackagedArtifactReceipt(value) {
  if (!Buffer.isBuffer(value) && typeof value !== "string") {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.receiptInvalid);
  }
  const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_RECEIPT_BYTES) {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.receiptInvalid);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.receiptInvalid);
  }
  scanPackagedReceiptJson(
    text,
    WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.receiptInvalid,
    WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.receiptNoncanonical,
  );
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.receiptInvalid);
  }
  const selected = validateWindowsProductionPackagedArtifactReceipt(parsed);
  if (serializeWindowsProductionPackagedArtifactReceipt(selected) !== text) {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.receiptNoncanonical);
  }
  return selected;
}

function validateRuntimeManifest(manifest, authority) {
  const status = WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.runtimeManifestInvalid;
  exactKeys(manifest, [
    "architecture", "dashboardRoot", "entrypoint", "files", "payload",
    "releaseVersion", "schemaVersion", "target", "windowsBinding",
  ], status);
  if (manifest.schemaVersion !== RUNTIME_MANIFEST_SCHEMA
      || manifest.target !== "win32"
      || manifest.architecture !== "x64"
      || manifest.releaseVersion !== authority.packageVersion
      || manifest.entrypoint !== "apps/electron/main.js"
      || manifest.dashboardRoot !== "apps/web/public"
      || !Array.isArray(manifest.files)
      || manifest.files.length === 0) fail(status);
  exactKeys(manifest.payload, ["bytes", "sha256"], status);
  if (!Number.isSafeInteger(manifest.payload.bytes)
      || manifest.payload.bytes < 0
      || !SHA256_PATTERN.test(manifest.payload.sha256)) fail(status);

  const rows = [];
  const exact = new Set();
  const folded = new Set();
  let previousPath = null;
  for (const row of manifest.files) {
    exactKeys(row, ["bytes", "kind", "path", "sha256"], status);
    const path = normalizeRelativePath(row.path, status);
    if (path === WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH
        || !Number.isSafeInteger(row.bytes)
        || row.bytes < 0
        || row.bytes > MAXIMUM_NATIVE_BYTES * 2
        || !INVENTORY_KINDS.has(row.kind)
        || !SHA256_PATTERN.test(row.sha256)
        || (previousPath !== null && comparePathBytes(previousPath, path) >= 0)) fail(status);
    assertUniqueInventoryPath(path, exact, folded, status);
    previousPath = path;
    rows.push({ bytes: row.bytes, kind: row.kind, path, sha256: row.sha256 });
  }
  const runtimeMap = rowsByPath(rows, status);
  for (const nativePath of NATIVE_MODULE_PATHS) {
    if (!runtimeMap.has(nativePath)) fail(status);
  }
  const nativeRows = rows.filter(({ path }) => path.toLowerCase().endsWith(".node"));
  if (nativeRows.length !== NATIVE_MODULE_PATHS.size
      || nativeRows.some(({ path }) => !NATIVE_MODULE_PATHS.has(path))) fail(status);
  if (!runtimeMap.has(WINDOWS_BINDING_MANIFEST_PATH)) fail(status);

  exactKeys(manifest.windowsBinding, ["binding", "included", "manifest", "status", "verified"], status);
  exactKeys(manifest.windowsBinding.binding, ["bytes", "path", "sha256"], status);
  exactKeys(manifest.windowsBinding.manifest, ["path"], status);
  if (manifest.windowsBinding.included !== true
      || manifest.windowsBinding.status !== "included_unverified"
      || manifest.windowsBinding.verified !== false
      || manifest.windowsBinding.binding.path !== WINDOWS_BINDING_PATH
      || manifest.windowsBinding.manifest.path !== WINDOWS_BINDING_MANIFEST_PATH) fail(status);
  const bindingRow = runtimeMap.get(WINDOWS_BINDING_PATH);
  if (manifest.windowsBinding.binding.bytes !== bindingRow.bytes
      || manifest.windowsBinding.binding.sha256 !== bindingRow.sha256) fail(status);

  const payload = payloadDigest(rows);
  if (payload.bytes !== manifest.payload.bytes || payload.sha256 !== manifest.payload.sha256) {
    fail(status);
  }
  return Object.freeze({ manifest, rows, rowMap: runtimeMap });
}

function validateWindowsBindingSidecar(bytes, expectedBinding) {
  const status = WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.sidecarMismatch;
  const sidecar = parseJsonBytes(bytes, status);
  const keys = [
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
  ];
  exactKeys(sidecar, keys, status);
  const requiredMethods = [
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
  ];
  const claims = [
    "productionSafe",
    "pathWalkRaceSafe",
    "credentialMutexSafe",
    "companionInstanceMutexSafe",
    "credentialAuditFileGuardSafe",
    "sqliteStateLeaseSafe",
    "preparedArtifactSafe",
  ];
  const expectedClaims = {
    productionSafe: false,
    pathWalkRaceSafe: false,
    credentialMutexSafe: true,
    companionInstanceMutexSafe: false,
    credentialAuditFileGuardSafe: true,
    sqliteStateLeaseSafe: false,
    preparedArtifactSafe: false,
  };
  exactKeys(sidecar.nativeClaims, claims, status);
  exactKeys(sidecar.approvedPolicy, claims, status);
  exactKeys(sidecar.bindingProvenance, ["contractVersion", "source", "status"], status);
  if (sidecar.schemaVersion !== "windows-filesystem-binding-manifest-v1"
      || sidecar.bindingFile !== "windows_filesystem.node"
      || sidecar.platform !== "win32"
      || sidecar.architecture !== "x64"
      || sidecar.contractVersion !== "windows-filesystem-v1"
      || sidecar.securityContractVersion !== "windows-filesystem-security-v1"
      || sidecar.credentialAuditFileGuardContractVersion !== "windows-credential-audit-file-guard-v1"
      || sidecar.sqliteStateLeaseContractVersion !== "windows-sqlite-state-lease-v1"
      || sidecar.credentialMutexContractVersion !== "windows-credential-mutex-v1"
      || sidecar.companionInstanceMutexContractVersion !== "windows-companion-instance-mutex-v1"
      || sidecar.preparedArtifactContractVersion !== "windows-prepared-artifact-v1"
      || JSON.stringify(sidecar.requiredMethods) !== JSON.stringify(requiredMethods)
      || sidecar.bindingProvenance.contractVersion !== "windows-binding-provenance-v1"
      || sidecar.bindingProvenance.status !== "unqualified"
      || sidecar.bindingProvenance.source !== "unsigned-development-binding"
      || !Number.isSafeInteger(sidecar.bytes)
      || sidecar.bytes !== expectedBinding.bytes
      || sidecar.sha256 !== expectedBinding.sha256
      || claims.some((key) => sidecar.nativeClaims[key] !== expectedClaims[key]
        || sidecar.approvedPolicy[key] !== expectedClaims[key])) {
    fail(status);
  }
}

function loadAsar() {
  try {
    const builderEntry = moduleRequire.resolve("electron-builder");
    const builderRequire = createModuleRequire(builderEntry);
    const loaded = builderRequire("@electron/asar");
    return loaded?.default ?? loaded;
  } catch {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.archiveInvalid);
  }
}

export function normalizeArchivePath(raw) {
  const nativeSeparator = process.platform === "win32" ? "\\" : "/";
  const foreignSeparator = nativeSeparator === "/" ? "\\" : "/";
  if (typeof raw !== "string"
      || raw.length <= 1
      || raw.includes("\0")
      || raw.includes(foreignSeparator)
      || raw[0] !== nativeSeparator) {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.archiveInvalid);
  }
  const parts = raw.slice(1).split(nativeSeparator);
  if (parts.some((part) => part.length === 0 || part === "." || part === ".."
      || /^[A-Za-z]:/u.test(part))) fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.archiveInvalid);
  const normalized = parts.join("/");
  if (`${nativeSeparator}${parts.join(nativeSeparator)}` !== raw) {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.archiveInvalid);
  }
  return normalized;
}

function archiveDirectory(stat) {
  return stat !== null && typeof stat === "object" && !Array.isArray(stat)
    && stat.files !== undefined;
}

function archiveLookupPath(path) {
  return process.platform === "win32" ? path.replaceAll("/", "\\") : path;
}

export async function readArchive(asarPath, archiveAdapter = null) {
  const before = await readArchiveSnapshot(asarPath);
  let asar;
  try {
    asar = archiveAdapter ?? loadAsar();
    if (asar === null || typeof asar !== "object"
        || typeof asar.listPackage !== "function"
        || typeof asar.statFile !== "function"
        || typeof asar.extractFile !== "function") {
      fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.archiveInvalid);
    }
  } catch (error) {
    if (error instanceof WindowsProductionPackagedArtifactError) throw error;
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.archiveInvalid);
  }
  let listed;
  try {
    listed = asar.listPackage(asarPath);
  } catch {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.archiveInvalid);
  }
  if (!Array.isArray(listed)) fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.archiveInvalid);
  const rows = [];
  const markedUnpacked = new Set();
  const exact = new Set();
  const folded = new Set();
  for (const rawPath of listed) {
    const path = normalizeArchivePath(rawPath);
    assertUniqueInventoryPath(
      path,
      exact,
      folded,
      WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.archiveInvalid,
    );
    let stat;
    try {
      // @electron/asar 3.4.1 defaults statFile's followLinks argument to
      // true. Keep it false so an archive symlink cannot be mistaken for its
      // target; native Windows reparse-point qualification remains a separate
      // native-runner boundary and is not claimed by this portable verifier.
      stat = asar.statFile(asarPath, archiveLookupPath(path), false);
    } catch {
      fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.archiveInvalid);
    }
    if (archiveDirectory(stat)) continue;
    if (stat?.link !== undefined || !Number.isSafeInteger(stat?.size) || stat.size < 0) {
      fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.archiveInvalid);
    }
    if (stat.unpacked === true) {
      markedUnpacked.add(path);
      continue;
    }
    if (path.toLowerCase().endsWith(".node")) {
      // Native modules are executable only from app.asar.unpacked. An archive
      // payload `.node` is never an acceptable post-builder subject.
      fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.nativeMismatch);
    }
    let bytes;
    try {
      bytes = asar.extractFile(asarPath, archiveLookupPath(path), false);
    } catch {
      fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.archiveInvalid);
    }
    if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)
        || bytes.byteLength !== stat.size) fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.archiveInvalid);
    rows.push({ bytes: bytes.byteLength, path, sha256: sha256(bytes) });
  }
  rows.sort((left, right) => comparePathBytes(left.path, right.path));
  const after = await readArchiveSnapshot(asarPath);
  assertStableArchiveSnapshot(before, after);
  return { rows, markedUnpacked };
}

/**
 * Reproduce the closed package-json transform from the pinned
 * app-builder-lib 26.15.7 implementation. The root package receives only
 * this release's four extraMetadata fields; node_modules packages receive
 * only the builder cleanup above. No caller-supplied transform is accepted.
 */
export function transformedPackageJsonBytes(sourceBytes, {
  isMain,
  packageVersion,
} = {}) {
  if (!Buffer.isBuffer(sourceBytes)
      || typeof isMain !== "boolean"
      || (isMain && (typeof packageVersion !== "string" || packageVersion.length === 0))) {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inventoryMismatch);
  }
  return transformElectronBuilderPackageJsonBytes(
    isMain ? PACKAGE_JSON_PATH : "node_modules/__dependency__/package.json",
    sourceBytes,
    { packageVersion, profile: "windows-production" },
  );
}

function packageJsonTransformKind(path) {
  if (path === PACKAGE_JSON_PATH) return "main";
  if (path.startsWith("node_modules/") && path.endsWith("/package.json")) {
    return "dependency";
  }
  return null;
}

function authorityNativeRows(authority) {
  const status = WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.authorityInvalid;
  if (!Array.isArray(authority.nativeModules)
      || authority.nativeModules.length !== WINDOWS_PRODUCTION_AUTHORITY_NATIVE_MODULES.length) {
    fail(status);
  }
  const map = new Map();
  const folded = new Set();
  for (const [index, module] of authority.nativeModules.entries()) {
    const expected = WINDOWS_PRODUCTION_AUTHORITY_NATIVE_MODULES[index];
    if (module.name !== expected.name || module.packagedPath !== expected.packagedPath
        || map.has(module.packagedPath)
        || folded.has(module.packagedPath.toLowerCase())
        || !Number.isSafeInteger(module.unsignedBytes)
        || !Number.isSafeInteger(module.signedBytes)
        || module.unsignedBytes <= 0
        || module.signedBytes <= 0
        || module.unsignedBytes > MAXIMUM_NATIVE_BYTES
        || module.signedBytes > MAXIMUM_NATIVE_BYTES
        || !SHA256_PATTERN.test(module.unsignedSha256)
        || !SHA256_PATTERN.test(module.signedSha256)
        || module.unsignedSha256 === module.signedSha256) fail(status);
    map.set(module.packagedPath, module);
    folded.add(module.packagedPath.toLowerCase());
  }
  return map;
}

function overlayRuntimeRows(runtime, nativeRows) {
  const rows = runtime.rows.map((row) => {
    const native = nativeRows.get(row.path);
    if (native === undefined) return row;
    if (row.bytes !== native.unsignedBytes || row.sha256 !== native.unsignedSha256) {
      fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.nativeMismatch);
    }
    return {
      bytes: native.signedBytes,
      kind: row.kind,
      path: row.path,
      sha256: native.signedSha256,
    };
  });
  return rows;
}

function compareRows(actual, expected, status) {
  const actualMap = rowsByPath(actual, status);
  const expectedMap = rowsByPath(expected, status);
  if (actualMap.size !== expectedMap.size) fail(status);
  for (const [path, expectedRow] of expectedMap) {
    const actualRow = actualMap.get(path);
    if (!actualRow || actualRow.bytes !== expectedRow.bytes || actualRow.sha256 !== expectedRow.sha256) {
      fail(status);
    }
  }
}

async function comparePackagedRows({
  archive,
  markedUnpacked,
  unpacked,
  expectedRows,
  runtimeManifestRow,
  stagedPath,
  packageVersion,
}) {
  const nativeStatus = WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.nativeMismatch;
  const unpackedMap = rowsByPath(unpacked, nativeStatus);
  if (unpackedMap.size !== NATIVE_MODULE_PATHS.size
      || [...unpackedMap.keys()].some((path) => !NATIVE_MODULE_PATHS.has(path))) fail(nativeStatus);
  for (const path of NATIVE_MODULE_PATHS) {
    const expected = expectedRows.find((row) => row.path === path);
    const actual = unpackedMap.get(path);
    if (!expected || !actual || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      fail(nativeStatus);
    }
    if (!markedUnpacked.has(path)) fail(nativeStatus);
  }
  if (markedUnpacked.size !== NATIVE_MODULE_PATHS.size
      || [...markedUnpacked].some((path) => !NATIVE_MODULE_PATHS.has(path))) fail(nativeStatus);
  if ([...unpackedMap.keys()].some((path) => path === WINDOWS_BINDING_MANIFEST_PATH)) {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.sidecarMismatch);
  }

  const archiveMap = rowsByPath(archive, WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.archiveInvalid);
  const expectedArchive = [
    ...expectedRows.filter(({ path }) => !NATIVE_MODULE_PATHS.has(path)),
    runtimeManifestRow,
  ];
  const adjusted = [];
  for (const row of expectedArchive) {
    const transformKind = packageJsonTransformKind(row.path);
    if (transformKind === null) {
      adjusted.push({ row, expectedBytes: null });
      continue;
    }
    const sourceBytes = await readRegularFile(
      join(stagedPath, ...row.path.split("/")),
      WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inventoryMismatch,
      stagedPath,
    );
    const transformed = transformedPackageJsonBytes(sourceBytes, {
      isMain: transformKind === "main",
      packageVersion,
    });
    // Root package.json is always rewritten by extraMetadata. A dependency
    // package is rewritten only when app-builder-lib removes metadata; null
    // means the exact source bytes remain the permitted representation.
    adjusted.push({ row, expectedBytes: transformed ?? sourceBytes });
  }
  for (const { row, expectedBytes } of adjusted) {
    const actual = archiveMap.get(row.path);
    if (!actual) fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inventoryMismatch);
    const expectedBytesLength = expectedBytes?.byteLength ?? row.bytes;
    const expectedSha256 = expectedBytes === null ? row.sha256 : sha256(expectedBytes);
    if (actual.bytes !== expectedBytesLength || actual.sha256 !== expectedSha256) {
      fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inventoryMismatch);
    }
  }
  if (archiveMap.size !== expectedArchive.length) fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inventoryMismatch);
  if ([...archiveMap.keys()].some((path) => !expectedArchive.some((row) => row.path === path))) {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inventoryMismatch);
  }
}

function parseAuthority(value) {
  const status = WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.authorityInvalid;
  if (!(Buffer.isBuffer(value) || typeof value === "string") || value.length === 0) fail(status);
  const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
  if (bytes.byteLength > 512 * 1024) fail(status);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(status);
  }
  let authority;
  try {
    authority = parseWindowsProductionAuthorityManifest(text);
    if (serializeWindowsProductionAuthorityManifest(authority) !== text) {
      fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.authorityNoncanonical);
    }
  } catch (error) {
    if (error instanceof WindowsProductionPackagedArtifactError) throw error;
    fail(status);
  }
  return { authority, bytes };
}

function readVerificationOptions(value) {
  const status = WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inputInvalid;
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
      fail(status);
    }
    const prototype = Object.getPrototypeOf(value);
    const ownKeys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (prototype !== Object.prototype
        || ownKeys.length !== VERIFICATION_OPTION_KEYS.length
        || ownKeys.some((key) => typeof key !== "string"
          || !VERIFICATION_OPTION_KEYS.includes(key))) {
      fail(status);
    }
    const options = {};
    for (const key of VERIFICATION_OPTION_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value")
          || descriptor.get !== undefined || descriptor.set !== undefined) {
        fail(status);
      }
      options[key] = descriptor.value;
    }
    return options;
  } catch (error) {
    if (error instanceof WindowsProductionPackagedArtifactError) throw error;
    fail(status);
  }
}

/**
 * Verify one post-builder `win-unpacked` app directory and its ASAR pair.
 * The result contains only fixed statuses, counts, byte totals, and digests.
 */
export async function verifyWindowsProductionPackagedArtifact(options = {}) {
  try {
    const {
      authorityBytes,
      signingLedgerBytes,
      stagedPath,
      winUnpackedPath,
      asarPath,
      unpackedPath,
    } = readVerificationOptions(options);
    if (!Buffer.isBuffer(signingLedgerBytes)
        || signingLedgerBytes.byteLength === 0
        || signingLedgerBytes.byteLength > 64 * 1024) {
      fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inputInvalid);
    }
    const selectedAuthority = parseAuthority(authorityBytes);
    const authority = selectedAuthority.authority;
    const nativeRows = authorityNativeRows(authority);
    const selectedStagedPath = normalizeInputPath(stagedPath);
    await assertDirectory(selectedStagedPath, WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inputInvalid);
    const payloadPaths = await validateApplicationPayloadPaths({
      winUnpackedPath,
      asarPath,
      unpackedPath,
    });

    const runtimePath = join(selectedStagedPath, WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH);
    const runtimeBytes = await readRegularFile(
      runtimePath,
      WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.runtimeManifestInvalid,
      selectedStagedPath,
      MAXIMUM_RUNTIME_MANIFEST_BYTES,
    );
    if (runtimeBytes.byteLength !== authority.runtimeManifest.bytes
        || sha256(runtimeBytes) !== authority.runtimeManifest.sha256) {
      fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.runtimeManifestInvalid);
    }
    const runtime = validateRuntimeManifest(parseJsonBytes(
      runtimeBytes,
      WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.runtimeManifestInvalid,
    ), authority);
    const overlay = overlayRuntimeRows(runtime, nativeRows);
    const staged = await walkFiles(
      selectedStagedPath,
      WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.stagedInventoryInvalid,
    );
    const stagedMap = rowsByPath(
      staged,
      WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.stagedInventoryInvalid,
    );
    const stagedBinding = stagedMap.get(WINDOWS_BINDING_PATH);
    const stagedSidecar = stagedMap.get(WINDOWS_BINDING_MANIFEST_PATH);
    if (!stagedBinding || !stagedSidecar) {
      fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.sidecarMismatch);
    }
    validateWindowsBindingSidecar(
      await readRegularFile(
        join(selectedStagedPath, ...WINDOWS_BINDING_MANIFEST_PATH.split("/")),
        WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.sidecarMismatch,
        selectedStagedPath,
      ),
      runtime.rowMap.get(WINDOWS_BINDING_PATH),
    );
    const stagedExpected = [
      ...overlay,
      {
        bytes: runtimeBytes.byteLength,
        path: WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH,
        sha256: sha256(runtimeBytes),
      },
    ];
    compareRows(staged, stagedExpected, WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.stagedInventoryInvalid);

    const archiveResult = await readArchive(payloadPaths.asarPath);
    const unpacked = await walkFiles(
      payloadPaths.unpackedPath,
      WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.unpackedInvalid,
    );
    await comparePackagedRows({
      archive: archiveResult.rows,
      markedUnpacked: archiveResult.markedUnpacked,
      unpacked,
      expectedRows: overlay,
      runtimeManifestRow: {
        bytes: runtimeBytes.byteLength,
        path: WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH,
        sha256: sha256(runtimeBytes),
      },
      stagedPath: selectedStagedPath,
      packageVersion: authority.packageVersion,
    });

    const peRows = [];
    const expectedPeRows = [
      {
        role: "main-executable",
        path: WINDOWS_PRODUCTION_AUTHENTICODE_MAIN_EXECUTABLE,
      },
      ...WINDOWS_PRODUCTION_AUTHENTICODE_DLL_ALLOWLIST.map((path) => ({
        role: "electron-dll",
        path,
      })),
      {
        role: "installer",
        path: windowsInstallerArtifactFileName(authority.packageVersion),
      },
      ...WINDOWS_PRODUCTION_AUTHENTICODE_NATIVE_MODULES.map(({ path }) => ({
        role: "native-module",
        path,
      })),
    ];
    const artifactsRoot = dirname(payloadPaths.winUnpackedPath);
    await assertDirectory(artifactsRoot, WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inputInvalid);
    for (const expected of expectedPeRows) {
      const root = expected.role === "installer"
        ? artifactsRoot
        : payloadPaths.winUnpackedPath;
      const absolutePath = join(root, ...expected.path.split("/"));
      const bytes = await readRegularFile(
        absolutePath,
        WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inventoryMismatch,
        root,
        MAXIMUM_ARCHIVE_BYTES,
      );
      if (bytes.byteLength === 0) {
        fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inventoryMismatch);
      }
      peRows.push({
        bytes: bytes.byteLength,
        path: expected.path,
        role: expected.role,
        sha256: sha256(bytes),
      });
    }
    const peInventory = computeWindowsProductionAuthenticodeInventoryDigest(peRows);

    return Object.freeze({
      status: WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_STATUS,
      target: "win32-x64",
      authority: Object.freeze({
        bytes: selectedAuthority.bytes.byteLength,
        sha256: sha256(selectedAuthority.bytes),
      }),
      ledger: Object.freeze({
        bytes: signingLedgerBytes.byteLength,
        sha256: sha256(signingLedgerBytes),
      }),
      peInventory: Object.freeze({ ...peInventory }),
      staged: inventoryDigest(staged),
      asar: inventoryDigest(archiveResult.rows),
      unpacked: inventoryDigest(unpacked),
      nativeFileCount: NATIVE_MODULE_PATHS.size,
    });
  } catch (error) {
    if (error instanceof WindowsProductionPackagedArtifactError) throw error;
    throw new WindowsProductionPackagedArtifactError(
      WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inventoryMismatch,
    );
  }
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

async function captureEvidenceRoot(path, code = WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.rootsInvalid) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") || !isAbsolute(path)) {
    fail(code);
  }
  const selected = resolve(path);
  await assertNoSymlinkPathComponents(selected, code);
  let metadata;
  let canonical;
  try {
    metadata = await lstat(selected);
    canonical = await realpath(selected);
  } catch (error) {
    if (error?.code === "ENOENT") fail(code);
    fail(code);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== selected) {
    fail(code);
  }
  return Object.freeze({ path: selected, canonical, identity: metadata });
}

async function assertEvidenceRootState(state) {
  await assertNoSymlinkPathComponents(
    state.path,
    WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.rootReplaced,
  );
  let metadata;
  let canonical;
  try {
    metadata = await lstat(state.path);
    canonical = await realpath(state.path);
  } catch {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.rootReplaced);
  }
  if (!metadata.isDirectory()
      || metadata.isSymbolicLink()
      || canonical !== state.canonical
      || !sameIdentity(metadata, state.identity)) {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.rootReplaced);
  }
}

function readPackagedTestHooks(value) {
  if (value === undefined) return Object.freeze({});
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.outputInvalid);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (Object.getPrototypeOf(value) !== Object.prototype
      || keys.length !== 2
      || keys.some((key) => key !== "beforeOutputPublish" && key !== "afterOutputPublish")) {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.outputInvalid);
  }
  const selected = {};
  for (const key of ["beforeOutputPublish", "afterOutputPublish"]) {
    const descriptor = descriptors[key];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
        || (descriptor.value !== undefined && typeof descriptor.value !== "function")) {
      fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.outputInvalid);
    }
    selected[key] = descriptor.value;
  }
  return selected;
}

async function removeOwnedPackagedTemp(path, identity) {
  try {
    const metadata = await lstat(path);
    if (metadata.isFile()
        && (metadata.nlink === 1 || metadata.nlink === 2)
        && sameIdentity(metadata, identity)) {
      await unlink(path);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function writePackagedReceiptOnce(rootState, result, testHooks = {}) {
  const bytes = Buffer.from(
    serializeWindowsProductionPackagedArtifactReceipt(result),
    "utf8",
  );
  await assertEvidenceRootState(rootState);
  const outputPath = join(
    rootState.path,
    WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_RECEIPT_FILE,
  );
  if (!pathIsInside(rootState.path, outputPath)) {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.outputInvalid);
  }
  const temporaryPath = join(
    rootState.path,
    `.${WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_RECEIPT_FILE}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  let temporaryIdentity;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    temporaryIdentity = await handle.stat();
    if (!temporaryIdentity.isFile() || temporaryIdentity.nlink !== 1) {
      fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.outputInvalid);
    }
    await handle.writeFile(bytes);
    await handle.sync();
    await assertEvidenceRootState(rootState);
    const existing = await lstat(outputPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.outputInvalid);
    });
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) {
        fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.linkRejected);
      }
      fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.outputExists);
    }
    await testHooks.beforeOutputPublish?.();
    await assertEvidenceRootState(rootState);
    try {
      await link(temporaryPath, outputPath);
    } catch (error) {
      if (error?.code === "EEXIST") {
        fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.outputExists);
      }
      fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.outputInvalid);
    }
    const published = await lstat(outputPath);
    if (!published.isFile()
        || published.isSymbolicLink()
        || published.nlink !== 2
        || published.size !== bytes.byteLength
        || !sameIdentity(published, temporaryIdentity)) {
      fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.outputInvalid);
    }
    await testHooks.afterOutputPublish?.();
    await assertEvidenceRootState(rootState);
    await unlink(temporaryPath);
    temporaryIdentity = null;
    const final = await lstat(outputPath);
    if (!final.isFile() || final.isSymbolicLink() || final.nlink !== 1
        || final.size !== bytes.byteLength) {
      fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.outputInvalid);
    }
    return Object.freeze({
      bytes: final.size,
      path: outputPath,
      sha256: sha256(bytes),
    });
  } catch (error) {
    if (error instanceof WindowsProductionPackagedArtifactError) throw error;
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.outputInvalid);
  } finally {
    await handle?.close().catch(() => {});
    if (temporaryIdentity) await removeOwnedPackagedTemp(temporaryPath, temporaryIdentity);
  }
}

/** Write only the fixed production packaged-artifact receipt leaf. */
export async function writeWindowsProductionPackagedArtifactReceipt(result) {
  if (arguments.length !== 1) fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.outputInvalid);
  const root = await captureEvidenceRoot(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_EVIDENCE_ROOT);
  return writePackagedReceiptOnce(root, result);
}

/** Portable test seam for the packaged receipt's transactional writer. */
export async function writeWindowsProductionPackagedArtifactReceiptForTest(
  testRoot,
  result,
  testHooks = undefined,
) {
  if (arguments.length < 2 || arguments.length > 3 || typeof testRoot !== "string") {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.outputInvalid);
  }
  const hooks = readPackagedTestHooks(testHooks);
  const root = await captureEvidenceRoot(testRoot);
  return writePackagedReceiptOnce(root, result, hooks);
}

async function runClosedPackagedArtifact({
  productionRoot,
  stagingRoot,
  winUnpackedRoot,
  evidenceRoot,
}) {
  const production = await captureEvidenceRoot(productionRoot);
  const staging = await captureEvidenceRoot(stagingRoot);
  const artifacts = await captureEvidenceRoot(dirname(winUnpackedRoot));
  const winUnpacked = await captureEvidenceRoot(winUnpackedRoot);
  const evidence = await captureEvidenceRoot(evidenceRoot);
  for (const state of [staging, artifacts, winUnpacked, evidence]) {
    await assertContained(production.path, state.path, WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.rootsInvalid);
  }
  const authorityPath = join(evidence.path, WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_AUTHORITY_FILE);
  const authorityBytes = await readRegularFile(
    authorityPath,
    WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.authorityInvalid,
    evidence.path,
    512 * 1024,
  );
  const signingLedgerBytes = await readRegularFile(
    join(evidence.path, WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_SIGNING_LEDGER_FILE),
    WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inputInvalid,
    evidence.path,
    64 * 1024,
  );
  const resourcesPath = join(winUnpacked.path, "resources");
  const asarPath = join(resourcesPath, "app.asar");
  const unpackedPath = `${asarPath}.unpacked`;
  const result = await verifyWindowsProductionPackagedArtifact({
    authorityBytes,
    signingLedgerBytes,
    stagedPath: staging.path,
    winUnpackedPath: winUnpacked.path,
    asarPath,
    unpackedPath,
  });
  await Promise.all([
    assertEvidenceRootState(production),
    assertEvidenceRootState(staging),
    assertEvidenceRootState(artifacts),
    assertEvidenceRootState(winUnpacked),
    assertEvidenceRootState(evidence),
  ]);
  await writePackagedReceiptOnce(evidence, result);
  return result;
}

/**
 * Test-only closed-root seam. Production CLI callers cannot redirect any
 * subject; tests may provide an isolated fixture with the same fixed layout.
 */
export async function runWindowsProductionPackagedArtifactForTest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inputInvalid);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  const expected = ["productionRoot", "stagingRoot", "winUnpackedRoot", "evidenceRoot"];
  if (Object.getPrototypeOf(value) !== Object.prototype
      || keys.length !== expected.length
      || keys.some((key) => !expected.includes(key))) {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inputInvalid);
  }
  const selected = {};
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true || typeof descriptor.value !== "string") {
      fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inputInvalid);
    }
    selected[key] = resolve(descriptor.value);
  }
  return runClosedPackagedArtifact(selected);
}

export function parseArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  const parsed = {
    authority: null,
    stagedPath: null,
    winUnpackedPath: null,
    asarPath: null,
    unpackedPath: null,
  };
  const fields = new Map([
    ["--authority", "authority"],
    ["--staged", "stagedPath"],
    ["--win-unpacked", "winUnpackedPath"],
    ["--asar", "asarPath"],
    ["--unpacked", "unpackedPath"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const field = fields.get(argv[index]);
    const value = argv[index + 1];
    if (!field
        || parsed[field] !== null
        || typeof value !== "string"
        || value.length === 0
        || value.startsWith("--")) {
      fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inputInvalid);
    }
    parsed[field] = value;
    index += 1;
  }
  if (!parsed.authority
      || !parsed.stagedPath
      || !parsed.winUnpackedPath
      || !parsed.asarPath
      || !parsed.unpackedPath) {
    fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inputInvalid);
  }
  return Object.freeze(parsed);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    if (!Array.isArray(argv) || argv.length !== 0) {
      fail(WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inputInvalid);
    }
    await runClosedPackagedArtifact({
      productionRoot: WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_PRODUCTION_ROOT,
      stagingRoot: WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_STAGING_ROOT,
      winUnpackedRoot: WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_WIN_UNPACKED_ROOT,
      evidenceRoot: WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_EVIDENCE_ROOT,
    });
    process.stdout.write(`${WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_STATUS}\n`);
  } catch (error) {
    const status = KNOWN_STATUSES.has(error?.code)
      ? error.code
      : WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.inventoryMismatch;
    process.stderr.write(`${status}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  await main();
}
