#!/usr/bin/env node

/**
 * Verify the bounded Authenticode evidence for one Windows production
 * artifact.
 *
 * This module deliberately separates the native probe boundary from the
 * evidence verifier.  `runWindowsProductionAuthenticodeProbe` may invoke
 * PowerShell and signtool only on a real Windows process.  Portable tests and
 * callers that have already captured native evidence inject a probe result;
 * the verifier never invokes a signer, opens a certificate store, contacts a
 * service, or retains raw PowerShell/signtool output.
 *
 * The inventory is closed around the release contract:
 * - the TiboTattle main executable;
 * - the frozen Electron 43.2.0 DLL allowlist;
 * - the generated uninstaller, which is deferred until the installed
 *   lifecycle because it is not a standalone pre-install subject;
 * - the final NSIS installer; and
 * - the two fixed native modules from windows-native-presign.mjs.
 *
 * The receipt contains only fixed identity fields and bounded aggregate
 * counts/digests.  Relative inventory paths are used only while validating
 * the injected evidence and are folded into the aggregate digest; absolute
 * checkout/runner paths, raw certificate Subjects/blobs, and raw diagnostics
 * are never emitted.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import { isProxy } from "node:util/types";
import {
  dirname,
  isAbsolute,
  resolve,
  join,
  relative,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY,
  WINDOWS_NATIVE_PRESIGN_MODULES,
  WINDOWS_NATIVE_PRESIGN_SCHEMA,
  WINDOWS_NATIVE_PRESIGN_STATUS,
  parseWindowsNativePresignReceipt,
  serializeWindowsNativePresignReceipt,
} from "./windows-native-presign.mjs";
import {
  WINDOWS_PRODUCTION_AUTHORITY_ARCHITECTURE,
  WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_SCHEMA,
  WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_STATUS,
  WINDOWS_PRODUCTION_AUTHORITY_PLATFORM,
  WINDOWS_PRODUCTION_AUTHORITY_PRODUCT,
  parseWindowsProductionAuthorityManifest,
  serializeWindowsProductionAuthorityManifest,
} from "../src/platform/windows-production-authority-manifest.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const WINDOWS_PRODUCTION_AUTHENTICODE_PRODUCT_NAME = "TiboTattle";
const WINDOWS_PRODUCTION_AUTHENTICODE_INSTALLER_NAME_TEMPLATE =
  "TiboTattle-{version}-Windows-x64.exe";

export const WINDOWS_PRODUCTION_AUTHENTICODE_PROBE_SCHEMA =
  "tibotattle-windows-production-authenticode-probe-v1";
export const WINDOWS_PRODUCTION_AUTHENTICODE_PROBE_STATUS =
  "WINDOWS_PRODUCTION_AUTHENTICODE_PROBE_CAPTURED";
export const WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_SCHEMA =
  "tibotattle-windows-production-authenticode-inventory-v1";
export const WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_STATUS =
  "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_VERIFIED";
export const WINDOWS_PRODUCTION_AUTHENTICODE_TARGET = "win32-x64";
export const WINDOWS_PRODUCTION_AUTHENTICODE_PRODUCTION_ROOT = resolve(
  REPOSITORY_ROOT,
  ".release-build/electron-production/windows-x64",
);
export const WINDOWS_PRODUCTION_AUTHENTICODE_ARTIFACTS_ROOT = join(
  WINDOWS_PRODUCTION_AUTHENTICODE_PRODUCTION_ROOT,
  "artifacts",
);
export const WINDOWS_PRODUCTION_AUTHENTICODE_EVIDENCE_ROOT = join(
  WINDOWS_PRODUCTION_AUTHENTICODE_PRODUCTION_ROOT,
  "evidence",
);
export const WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_FILE =
  "authenticode-inventory.json";
export const WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_PATH = join(
  WINDOWS_PRODUCTION_AUTHENTICODE_EVIDENCE_ROOT,
  WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_FILE,
);
export const WINDOWS_PRODUCTION_AUTHENTICODE_WIN_UNPACKED_ROOT = join(
  WINDOWS_PRODUCTION_AUTHENTICODE_ARTIFACTS_ROOT,
  "win-unpacked",
);
export const WINDOWS_PRODUCTION_AUTHENTICODE_MAIN_EXECUTABLE =
  `${WINDOWS_PRODUCTION_AUTHENTICODE_PRODUCT_NAME}.exe`;
export const WINDOWS_PRODUCTION_AUTHENTICODE_UNINSTALLER =
  `Uninstall ${WINDOWS_PRODUCTION_AUTHENTICODE_PRODUCT_NAME}.exe`;
// Keep this PE closure tied to the reviewed Electron runtime instead of
// allowing a future dependency update to silently widen or change it.
export const WINDOWS_PRODUCTION_AUTHENTICODE_ELECTRON_VERSION = "43.2.0";
export const WINDOWS_PRODUCTION_AUTHENTICODE_DLL_ALLOWLIST = Object.freeze([
  "d3dcompiler_47.dll",
  "ffmpeg.dll",
  "libEGL.dll",
  "libGLESv2.dll",
  "vk_swiftshader.dll",
  "vulkan-1.dll",
]);
export const WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER =
  WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.publisher;
export const WINDOWS_PRODUCTION_AUTHENTICODE_NATIVE_MODULES =
  Object.freeze(WINDOWS_NATIVE_PRESIGN_MODULES.map((module) => Object.freeze({
    name: module.name,
    path: module.packagedPath,
  })));

export const WINDOWS_PRODUCTION_AUTHENTICODE_FIXED_STATUS = Object.freeze({
  inputInvalid: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_INPUT_INVALID",
  inputMissing: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_INPUT_MISSING",
  rootsInvalid: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_ROOTS_INVALID",
  outOfRoot: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_OUT_OF_ROOT",
  platformRequired: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_NATIVE_WINDOWS_REQUIRED",
  probeInvalid: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_PROBE_INVALID",
  probeModeInvalid: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_PROBE_MODE_INVALID",
  architectureRequired: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_NATIVE_X64_REQUIRED",
  authorityInvalid: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_AUTHORITY_INVALID",
  authorityNoncanonical: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_AUTHORITY_NONCANONICAL",
  nativePresignInvalid: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_NATIVE_PRESIGN_INVALID",
  nativePresignNoncanonical: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_NATIVE_PRESIGN_NONCANONICAL",
  nativeBindingMismatch: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_NATIVE_BINDING_MISMATCH",
  optionsInvalid: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_OPTIONS_INVALID",
  rootReplaced: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_ROOT_REPLACED",
  outputExists: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_OUTPUT_EXISTS",
  signatureInvalid: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_SIGNATURE_INVALID",
  inventoryMismatch: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_MISMATCH",
  missingEntry: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_MISSING_ENTRY",
  extraEntry: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_EXTRA_ENTRY",
  caseCollision: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_CASE_COLLISION",
  linkRejected: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_LINK_REJECTED",
  pathLeak: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_PATH_LEAK",
  bindingMismatch: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_BINDING_MISMATCH",
  deferredInvalid: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_DEFERRED_GATE_INVALID",
  receiptInvalid: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_RECEIPT_INVALID",
  outputInvalid: "WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_OUTPUT_INVALID",
  passed: WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_STATUS,
});
export const FIXED_STATUS = WINDOWS_PRODUCTION_AUTHENTICODE_FIXED_STATUS;

const STATUS = WINDOWS_PRODUCTION_AUTHENTICODE_FIXED_STATUS;
const KNOWN_STATUSES = new Set(Object.values(STATUS));
const MAXIMUM_FILES = 256;
const MAXIMUM_PATH_BYTES = 1024;
const MAXIMUM_PROBE_BYTES = 8 * 1024;
const MAXIMUM_SUBJECT_BYTES = 4096;
const MAXIMUM_RECEIPT_BYTES = 64 * 1024;
const MAXIMUM_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
// Windows file IDs can exceed JavaScript's safe integer range. Keep dev/ino
// as BigInt while converting only bounded count fields used arithmetically.
const MAX_SAFE_STAT_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const PUBLISHER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .,&()=+_-]{0,255}$/u;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@ ._()'&+-]*$/u;
const RESERVED_DOS_BASENAMES = new Set([
  "AUX",
  "CON",
  "NUL",
  "PRN",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);
const PROBE_KEYS = Object.freeze([
  "policy",
  "publisher",
  "signtoolPaValid",
  "status",
  "subjectSha256",
  "subjectUtf8Bytes",
  "timestampPresent",
]);
const NATIVE_PROBE_KEYS = Object.freeze([
  ...PROBE_KEYS,
  "bytes",
  "sha256",
]);
const FILE_KEYS = Object.freeze([
  "authenticode",
  "bytes",
  "fileKind",
  "linkStatus",
  "path",
  "role",
  "sha256",
]);
const INSTALLER_KEYS = Object.freeze(["bytes", "sha256"]);
const EVIDENCE_KEYS = Object.freeze([
  "files",
  "installer",
  "packageVersion",
  "probeMode",
  "publisher",
  "revision",
  "schemaVersion",
  "status",
  "target",
]);
const RECEIPT_KEYS = Object.freeze([
  "deferred",
  "files",
  "installer",
  "inventory",
  "packageVersion",
  "probeMode",
  "publisher",
  "revision",
  "schemaVersion",
  "status",
  "target",
]);
const INVENTORY_KEYS = Object.freeze(["bytes", "count", "sha256", "signedCount"]);
const RECEIPT_FILE_KEYS = Object.freeze([
  "authenticode",
  "bytes",
  "path",
  "role",
  "sha256",
]);
const DEFERRED_KEYS = Object.freeze(["reason", "status"]);
const BUILD_KEYS = Object.freeze(["packageVersion", "publisher", "revision"]);
const PROBE_MODES = new Set(["injected", "native-windows"]);
const NATIVE_EVIDENCE = new WeakSet();
const NATIVE_RECEIPTS = new WeakSet();
const TEST_HOOK_KEYS = Object.freeze([
  "beforeTemporaryCreate",
  "beforeOutputPublish",
  "afterOutputPublish",
]);
const TEST_HOOKS = new Set(TEST_HOOK_KEYS);
const MAXIMUM_AUTHORITY_BYTES = 512 * 1024;
const MAXIMUM_NATIVE_PRESIGN_BYTES = 64 * 1024;
const EXPECTED_BINDING_KEYS = Object.freeze([
  "installerSha256",
  "packageVersion",
  "publisher",
  "revision",
]);

function windowsInstallerArtifactFileName(version) {
  return WINDOWS_PRODUCTION_AUTHENTICODE_INSTALLER_NAME_TEMPLATE.replace(
    "{version}",
    version,
  );
}

export class WindowsProductionAuthenticodeInventoryError extends Error {
  constructor(code) {
    super("Windows production Authenticode inventory verification failed");
    this.name = "WindowsProductionAuthenticodeInventoryError";
    this.code = code;
  }
}

function fail(code) {
  throw new WindowsProductionAuthenticodeInventoryError(code);
}

function rejectProxy(value, code = STATUS.inputInvalid) {
  try {
    if (isProxy(value)) fail(code);
  } catch {
    fail(code);
  }
}

function readRecord(value, keys, code = STATUS.inputInvalid) {
  rejectProxy(value, code);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code);
  }
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
  const expectedKeys = new Set(keys);
  if (prototype !== Object.prototype
      || ownKeys.length !== keys.length
      || ownKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key))) {
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

function readArray(value, code = STATUS.inputInvalid) {
  rejectProxy(value, code);
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(code);
  }
  let ownKeys;
  let descriptors;
  try {
    ownKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(code);
  }
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, "value")
      || lengthDescriptor.enumerable !== false
      || lengthDescriptor.get !== undefined
      || lengthDescriptor.set !== undefined
      || ownKeys.some((key) => typeof key !== "string")) {
    fail(code);
  }
  if (ownKeys.length !== value.length + 1 || value.length > MAXIMUM_FILES) {
    fail(code);
  }
  const selected = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
        || descriptor.get !== undefined
        || descriptor.set !== undefined) {
      fail(code);
    }
    selected.push(descriptor.value);
  }
  return selected;
}

function assertString(value, pattern, maximumBytes = 1024, code = STATUS.inputInvalid) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\0")
      || Buffer.byteLength(value, "utf8") > maximumBytes
      || (pattern && !pattern.test(value))) {
    fail(code);
  }
  return value;
}

function assertPositiveInteger(value, maximum = MAXIMUM_FILE_BYTES, code = STATUS.inputInvalid) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) fail(code);
  return value;
}

function assertDigest(value, code = STATUS.inputInvalid) {
  return assertString(value, SHA256_PATTERN, 64, code);
}

function assertRevision(value, code = STATUS.inputInvalid) {
  return assertString(value, REVISION_PATTERN, 40, code);
}

function assertVersion(value, code = STATUS.inputInvalid) {
  return assertString(value, VERSION_PATTERN, 32, code);
}

function assertPublisher(value, code = STATUS.inputInvalid) {
  return assertString(value, PUBLISHER_PATTERN, 256, code);
}

function comparePathBytes(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function pathKey(value) {
  return value.toLocaleLowerCase("en-US");
}

function assertRelativeInventoryPath(value, code = STATUS.pathLeak) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\\")
      || value.includes("\0")
      || value.startsWith("/")
      || WINDOWS_ABSOLUTE_PATH_PATTERN.test(value)
      || Buffer.byteLength(value, "utf8") > MAXIMUM_PATH_BYTES) {
    fail(code);
  }
  const parts = value.split("/");
  for (const part of parts) {
    const base = part.split(".", 1)[0].toUpperCase();
    if (part.length === 0
        || part === "."
        || part === ".."
        || part.endsWith(".")
        || part.endsWith(" ")
        || !SAFE_SEGMENT_PATTERN.test(part)
        || RESERVED_DOS_BASENAMES.has(base)) {
      fail(code);
    }
  }
  return value;
}

function assertAbsoluteProbePath(value, code = STATUS.probeInvalid) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\0")
      || Buffer.byteLength(value, "utf8") > MAXIMUM_PATH_BYTES
      || isUncPath(value)
      || (!isAbsolute(value) && !WINDOWS_ABSOLUTE_PATH_PATTERN.test(value))
      || value.endsWith("/")
      || value.endsWith("\\")) {
    fail(code);
  }
  return value;
}

function assertRole(value, code = STATUS.inventoryMismatch) {
  if (value !== "main-executable"
      && value !== "electron-dll"
      && value !== "uninstaller"
      && value !== "installer"
      && value !== "native-module") {
    fail(code);
  }
  return value;
}

function assertInstaller(value, code = STATUS.inputInvalid) {
  const source = readRecord(value, INSTALLER_KEYS, code);
  return Object.freeze({
    bytes: assertPositiveInteger(source.bytes, MAXIMUM_FILE_BYTES, code),
    sha256: assertDigest(source.sha256, code),
  });
}

function expectedRows(packageVersion) {
  const rows = [
    { role: "main-executable", path: WINDOWS_PRODUCTION_AUTHENTICODE_MAIN_EXECUTABLE },
    ...WINDOWS_PRODUCTION_AUTHENTICODE_DLL_ALLOWLIST.map((path) => ({
      role: "electron-dll",
      path,
    })),
    { role: "installer", path: windowsInstallerArtifactFileName(packageVersion) },
    ...WINDOWS_PRODUCTION_AUTHENTICODE_NATIVE_MODULES.map(({ path }) => ({
      role: "native-module",
      path,
    })),
  ];
  const seen = new Set();
  for (const row of rows) {
    const key = pathKey(row.path);
    if (seen.has(key)) fail(STATUS.caseCollision);
    seen.add(key);
  }
  return rows;
}

function expectedRowMap(packageVersion) {
  return new Map(expectedRows(packageVersion).map((row) => [row.path, row.role]));
}

function validateAuthenticode(
  value,
  expectedPublisher,
  code = STATUS.signatureInvalid,
  native = false,
) {
  const source = readRecord(value, native ? NATIVE_PROBE_KEYS : PROBE_KEYS, code);
  if (source.status !== "Valid"
      || source.publisher !== expectedPublisher
      || source.publisher !== WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER
      || source.timestampPresent !== true
      || source.policy !== "authenticode-pa"
      || source.signtoolPaValid !== true) {
    fail(code);
  }
  const subjectSha256 = assertDigest(source.subjectSha256, code);
  if (!Number.isSafeInteger(source.subjectUtf8Bytes)
      || source.subjectUtf8Bytes <= 0
      || source.subjectUtf8Bytes > MAXIMUM_SUBJECT_BYTES) {
    fail(code);
  }
  const normalized = {
    policy: "authenticode-pa",
    publisher: WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER,
    signtoolPaValid: true,
    status: "Valid",
    subjectSha256,
    subjectUtf8Bytes: source.subjectUtf8Bytes,
    timestampPresent: true,
  };
  if (native) {
    normalized.bytes = assertPositiveInteger(source.bytes, MAXIMUM_FILE_BYTES, code);
    normalized.sha256 = assertDigest(source.sha256, code);
  }
  return Object.freeze(normalized);
}

function projectReceiptAuthenticode(
  value,
  code = STATUS.receiptInvalid,
  native = false,
) {
  const source = readRecord(value, native ? NATIVE_PROBE_KEYS : PROBE_KEYS, code);
  const validated = validateAuthenticode(
    source,
    WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER,
    code,
    native,
  );
  return Object.freeze({
    policy: validated.policy,
    publisher: validated.publisher,
    signtoolPaValid: validated.signtoolPaValid,
    status: validated.status,
    subjectSha256: validated.subjectSha256,
    subjectUtf8Bytes: validated.subjectUtf8Bytes,
    timestampPresent: validated.timestampPresent,
  });
}

function validateExpectedBinding(value) {
  if (value === undefined) return undefined;
  const source = readRecord(value, EXPECTED_BINDING_KEYS, STATUS.bindingMismatch);
  return Object.freeze({
    installerSha256: assertDigest(source.installerSha256, STATUS.bindingMismatch),
    packageVersion: assertVersion(source.packageVersion, STATUS.bindingMismatch),
    publisher: assertPublisher(source.publisher, STATUS.bindingMismatch),
    revision: assertRevision(source.revision, STATUS.bindingMismatch),
  });
}

function inventoryDigest(rows) {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const row of [...rows].sort((left, right) => comparePathBytes(left.path, right.path))) {
    bytes += row.bytes;
    hash.update(`F\0${row.role}\0${row.path}\0${row.bytes}\0${row.sha256}\0`);
  }
  return Object.freeze({
    bytes,
    count: rows.length,
    sha256: hash.digest("hex"),
    signedCount: rows.length,
  });
}

/**
 * Return the closed PE inventory aggregate used by both the native
 * Authenticode receipt and the packaged-artifact receipt.  The producer
 * validates each row before calling this helper; keeping the digest function
 * here prevents the two receipt owners from drifting in their framing or
 * sort order.
 */
export function computeWindowsProductionAuthenticodeInventoryDigest(rows) {
  if (!Array.isArray(rows)) fail(STATUS.inputInvalid);
  return inventoryDigest(rows);
}

function isUncPath(value) {
  return value.startsWith("\\\\") || value.startsWith("//");
}

function normalizeRootPath(value, platform) {
  const selected = resolve(value);
  return platform === "win32" ? selected.toLowerCase() : selected;
}

function normalizeStatInteger(value) {
  if (typeof value !== "bigint") return value;
  if (value < 0n || value > MAX_SAFE_STAT_INTEGER) return null;
  return Number(value);
}

function normalizeStats(stats) {
  if (process.platform !== "win32") return stats;
  return {
    dev: stats.dev,
    ino: stats.ino,
    nlink: normalizeStatInteger(stats.nlink),
    size: normalizeStatInteger(stats.size),
    isFile: () => stats.isFile(),
    isDirectory: () => stats.isDirectory(),
    isSymbolicLink: () => stats.isSymbolicLink(),
  };
}

async function lstatForIdentity(path) {
  return normalizeStats(await lstat(path, {
    bigint: process.platform === "win32",
  }));
}

async function statForIdentity(handle) {
  return normalizeStats(await handle.stat({
    bigint: process.platform === "win32",
  }));
}

function statIdentity(value) {
  if (typeof value === "bigint") return value >= 0n ? value.toString() : null;
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

function sameStatIdentity(left, right) {
  const leftIdentity = statIdentity(left);
  const rightIdentity = statIdentity(right);
  return leftIdentity !== null
    && rightIdentity !== null
    && leftIdentity === rightIdentity;
}

function pathIsInside(parent, child, platform) {
  const selectedParent = normalizeRootPath(parent, platform);
  const selectedChild = normalizeRootPath(child, platform);
  const suffix = relative(selectedParent, selectedChild);
  return suffix === ""
    || (suffix !== ".."
      && !suffix.startsWith(`..${selectedParent.includes("\\") ? "\\" : "/"}`)
      && !isAbsolute(suffix));
}

async function sealDirectoryRoot(path, platform, code = STATUS.rootsInvalid) {
  assertAbsoluteProbePath(path, code);
  if (isUncPath(path) || resolve(path) !== path) fail(code);
  await assertNoSymlinkPathComponents(path);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    fail(error?.code === "ENOENT" ? STATUS.inputMissing : code);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(code);
  }
  let canonical;
  try {
    canonical = await realpath(path);
  } catch {
    fail(code);
  }
  if (isUncPath(canonical)
      || normalizeRootPath(canonical, platform) !== normalizeRootPath(path, platform)) {
    fail(code);
  }
  return canonical;
}

async function selectProductionRoots({ platform = process.platform, testRoot, testOnly } = {}) {
  let productionRoot = WINDOWS_PRODUCTION_AUTHENTICODE_PRODUCTION_ROOT;
  if (testRoot !== undefined) {
    // Temporary roots are available only through the explicit test-only
    // dependency boundary. Production options never contain a root or a file
    // path; they can only reach these fixed release directories.
    if (testOnly !== true) fail(STATUS.rootsInvalid);
    productionRoot = assertAbsoluteProbePath(testRoot, STATUS.rootsInvalid);
  }
  const sealedProductionRoot = await sealDirectoryRoot(productionRoot, platform);
  const artifactsRoot = await sealDirectoryRoot(
    join(sealedProductionRoot, "artifacts"),
    platform,
  );
  const winUnpackedRoot = await sealDirectoryRoot(
    join(artifactsRoot, "win-unpacked"),
    platform,
  );
  if (!pathIsInside(sealedProductionRoot, artifactsRoot, platform)
      || !pathIsInside(artifactsRoot, winUnpackedRoot, platform)) {
    fail(STATUS.rootsInvalid);
  }
  return Object.freeze({
    productionRoot: sealedProductionRoot,
    artifactsRoot,
    winUnpackedRoot,
  });
}

function assertNativeWindowsX64() {
  if (process.platform !== "win32") fail(STATUS.platformRequired);
  if (process.arch !== "x64") fail(STATUS.architectureRequired);
}

async function captureDirectoryState(path, platform, code = STATUS.rootsInvalid) {
  const canonical = await sealDirectoryRoot(path, platform, code);
  let metadata;
  try {
    metadata = await lstatForIdentity(canonical);
  } catch {
    fail(code);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(code);
  return Object.freeze({
    path: canonical,
    platform,
    dev: metadata.dev,
    ino: metadata.ino,
  });
}

async function revalidateDirectoryState(state, code = STATUS.rootReplaced) {
  if (state === null || typeof state !== "object") fail(code);
  await assertNoSymlinkPathComponents(state.path);
  let metadata;
  let canonical;
  try {
    metadata = await lstatForIdentity(state.path);
    canonical = await realpath(state.path);
  } catch {
    fail(code);
  }
  if (!metadata.isDirectory()
      || metadata.isSymbolicLink()
      || normalizeRootPath(canonical, state.platform)
        !== normalizeRootPath(state.path, state.platform)
      || !sameStatIdentity(metadata.dev, state.dev)
      || !sameStatIdentity(metadata.ino, state.ino)) {
    fail(code);
  }
  return state;
}

async function selectProductionAuthenticodeRoots() {
  assertNativeWindowsX64();
  const roots = await selectProductionRoots({ platform: "win32" });
  const evidencePath = join(roots.productionRoot, "evidence");
  if (normalizeRootPath(evidencePath, "win32")
      !== normalizeRootPath(WINDOWS_PRODUCTION_AUTHENTICODE_EVIDENCE_ROOT, "win32")) {
    fail(STATUS.rootsInvalid);
  }
  const evidenceRoot = await sealDirectoryRoot(evidencePath, "win32");
  if (!pathIsInside(roots.productionRoot, evidenceRoot, "win32")) {
    fail(STATUS.rootsInvalid);
  }
  const [production, artifacts, winUnpacked, evidence] = await Promise.all([
    captureDirectoryState(roots.productionRoot, "win32"),
    captureDirectoryState(roots.artifactsRoot, "win32"),
    captureDirectoryState(roots.winUnpackedRoot, "win32"),
    captureDirectoryState(evidenceRoot, "win32"),
  ]);
  return Object.freeze({
    production,
    artifacts,
    winUnpacked,
    evidence,
  });
}

function validateCapturedRootState(value, platform) {
  const source = readRecord(
    value,
    ["dev", "ino", "path", "platform"],
    STATUS.rootsInvalid,
  );
  if (source.platform !== platform
      || typeof source.path !== "string"
      || statIdentity(source.dev) === null
      || statIdentity(source.ino) === null) {
    fail(STATUS.rootsInvalid);
  }
  return Object.freeze({
    dev: source.dev,
    ino: source.ino,
    path: source.path,
    platform: source.platform,
  });
}

function validateCapturedRootStates(value, platform) {
  rejectProxy(value, STATUS.rootsInvalid);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(STATUS.rootsInvalid);
  }
  const rootKeys = ["artifacts", "evidence", "production", "winUnpacked"];
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== rootKeys.length
      || ownKeys.some((key) => typeof key !== "string" || !rootKeys.includes(key))) {
    fail(STATUS.rootsInvalid);
  }
  const states = Object.freeze({
    production: validateCapturedRootState(value.production, platform),
    artifacts: validateCapturedRootState(value.artifacts, platform),
    winUnpacked: validateCapturedRootState(value.winUnpacked, platform),
    evidence: validateCapturedRootState(value.evidence, platform),
  });
  if (!pathIsInside(states.production.path, states.artifacts.path, platform)
      || !pathIsInside(states.artifacts.path, states.winUnpacked.path, platform)
      || !pathIsInside(states.production.path, states.evidence.path, platform)) {
    fail(STATUS.rootsInvalid);
  }
  return states;
}

async function revalidateCapturedRootStates(states) {
  await Promise.all(Object.values(states).map((state) => revalidateDirectoryState(state)));
}

async function resolveSubjectPath(roots, row, platform) {
  const root = row.role === "installer" ? roots.artifactsRoot : roots.winUnpackedRoot;
  const candidate = resolve(root, row.path);
  if (!pathIsInside(root, candidate, platform)) fail(STATUS.outOfRoot);
  await assertNoSymlinkPathComponents(candidate);
  let canonical;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    fail(error?.code === "ENOENT" ? STATUS.inputMissing : STATUS.outOfRoot);
  }
  if (!pathIsInside(root, canonical, platform)) fail(STATUS.outOfRoot);
  return canonical;
}

function deferredGate() {
  return Object.freeze({
    reason: "uninstaller-authenticode-requires-installed-lifecycle",
    status: "deferred",
  });
}

function validateEvidence(value, expectedBinding) {
  const source = readRecord(value, EVIDENCE_KEYS);
  if (source.schemaVersion !== WINDOWS_PRODUCTION_AUTHENTICODE_PROBE_SCHEMA
      || source.status !== WINDOWS_PRODUCTION_AUTHENTICODE_PROBE_STATUS
      || source.target !== WINDOWS_PRODUCTION_AUTHENTICODE_TARGET) {
    fail(STATUS.inputInvalid);
  }
  if (typeof source.probeMode !== "string" || !PROBE_MODES.has(source.probeMode)) {
    fail(STATUS.probeModeInvalid);
  }
  if (source.probeMode === "native-windows" && !NATIVE_EVIDENCE.has(value)) {
    fail(STATUS.probeModeInvalid);
  }
  const revision = assertRevision(source.revision);
  const packageVersion = assertVersion(source.packageVersion);
  const publisher = assertPublisher(source.publisher);
  if (publisher !== WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER) fail(STATUS.inputInvalid);
  const expected = validateExpectedBinding(expectedBinding);
  if (expected !== undefined
      && (revision !== expected.revision
        || packageVersion !== expected.packageVersion
        || publisher !== expected.publisher)) {
    fail(STATUS.bindingMismatch);
  }
  const expectedMap = expectedRowMap(packageVersion);
  const expectedCaseMap = new Map(
    [...expectedMap.keys()].map((path) => [pathKey(path), path]),
  );
  const installer = assertInstaller(source.installer);
  const rows = readArray(source.files, STATUS.inventoryMismatch).map((valueAtIndex) => {
    const row = readRecord(valueAtIndex, FILE_KEYS, STATUS.inventoryMismatch);
    const role = assertRole(row.role);
    const path = assertRelativeInventoryPath(row.path);
    assertPositiveInteger(row.bytes, MAXIMUM_FILE_BYTES, STATUS.inventoryMismatch);
    assertDigest(row.sha256, STATUS.inventoryMismatch);
    if (row.fileKind !== "regular") fail(STATUS.linkRejected);
    if (row.linkStatus !== "none") fail(STATUS.linkRejected);
    const expectedRole = expectedMap.get(path);
    if (expectedRole === undefined) {
      if (expectedCaseMap.has(pathKey(path))) fail(STATUS.caseCollision);
      fail(STATUS.extraEntry);
    }
    if (expectedRole !== role) fail(STATUS.inventoryMismatch);
    const authenticode = validateAuthenticode(
      row.authenticode,
      publisher,
      STATUS.signatureInvalid,
      source.probeMode === "native-windows",
    );
    return {
      role,
      path,
      bytes: row.bytes,
      sha256: row.sha256,
      authenticode,
    };
  });
  if (rows.length > expectedMap.size) fail(STATUS.extraEntry);
  if (rows.length < expectedMap.size) fail(STATUS.missingEntry);
  const exactPaths = new Set();
  const caseInsensitivePaths = new Set();
  for (const row of rows) {
    if (exactPaths.has(row.path)) fail(STATUS.extraEntry);
    exactPaths.add(row.path);
    const key = pathKey(row.path);
    if (caseInsensitivePaths.has(key)) fail(STATUS.caseCollision);
    caseInsensitivePaths.add(key);
  }
  for (const path of expectedMap.keys()) {
    if (!exactPaths.has(path)) fail(STATUS.missingEntry);
  }
  const installerRow = rows.find((row) => row.role === "installer");
  if (!installerRow
      || installerRow.bytes !== installer.bytes
      || installerRow.sha256 !== installer.sha256) {
    fail(STATUS.bindingMismatch);
  }
  if (expected !== undefined && installer.sha256 !== expected.installerSha256) {
    fail(STATUS.bindingMismatch);
  }
  const aggregate = inventoryDigest(rows);
  return {
    revision,
    packageVersion,
    publisher,
    probeMode: source.probeMode,
    installer,
    rows,
    aggregate,
  };
}

function receiptFromValidatedEvidence(validated) {
  const roles = {
    electronDlls: WINDOWS_PRODUCTION_AUTHENTICODE_DLL_ALLOWLIST.length,
    installer: 1,
    mainExecutable: 1,
    nativeModules: WINDOWS_PRODUCTION_AUTHENTICODE_NATIVE_MODULES.length,
    uninstaller: 0,
  };
  return deepFreeze({
    schemaVersion: WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_SCHEMA,
    status: WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_STATUS,
    target: WINDOWS_PRODUCTION_AUTHENTICODE_TARGET,
    revision: validated.revision,
    packageVersion: validated.packageVersion,
    publisher: validated.publisher,
    probeMode: validated.probeMode,
    deferred: deferredGate(),
    installer: validated.installer,
    files: [...validated.rows]
      .sort((left, right) => comparePathBytes(left.path, right.path))
      .map(({ authenticode, bytes, path, role, sha256 }) => ({
        authenticode: projectReceiptAuthenticode(
          authenticode,
          STATUS.receiptInvalid,
          validated.probeMode === "native-windows",
        ),
        bytes,
        path,
        role,
        sha256,
      })),
    inventory: {
      bytes: validated.aggregate.bytes,
      count: validated.aggregate.count,
      sha256: validated.aggregate.sha256,
      signedCount: validated.aggregate.signedCount,
      roles,
    },
  });
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
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

function validateReceipt(value, expectedBinding) {
  const source = readRecord(value, RECEIPT_KEYS, STATUS.receiptInvalid);
  if (source.schemaVersion !== WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_SCHEMA
      || source.status !== WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_STATUS
      || source.target !== WINDOWS_PRODUCTION_AUTHENTICODE_TARGET) {
    fail(STATUS.receiptInvalid);
  }
  const revision = assertRevision(source.revision, STATUS.receiptInvalid);
  const packageVersion = assertVersion(source.packageVersion, STATUS.receiptInvalid);
  const publisher = assertPublisher(source.publisher, STATUS.receiptInvalid);
  if (publisher !== WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER) fail(STATUS.receiptInvalid);
  if (typeof source.probeMode !== "string" || !PROBE_MODES.has(source.probeMode)) {
    fail(STATUS.probeModeInvalid);
  }
  const expected = validateExpectedBinding(expectedBinding);
  if (expected !== undefined
      && (revision !== expected.revision
        || packageVersion !== expected.packageVersion
        || publisher !== expected.publisher)) {
    fail(STATUS.bindingMismatch);
  }
  const installer = assertInstaller(source.installer, STATUS.receiptInvalid);
  if (expected !== undefined && installer.sha256 !== expected.installerSha256) {
    fail(STATUS.bindingMismatch);
  }
  const deferredSource = readRecord(
    source.deferred,
    DEFERRED_KEYS,
    STATUS.deferredInvalid,
  );
  if (deferredSource.status !== "deferred"
      || deferredSource.reason !== "uninstaller-authenticode-requires-installed-lifecycle") {
    fail(STATUS.deferredInvalid);
  }
  const expectedMap = expectedRowMap(packageVersion);
  const expectedCaseMap = new Map(
    [...expectedMap.keys()].map((path) => [pathKey(path), path]),
  );
  const rows = readArray(source.files, STATUS.receiptInvalid).map((valueAtIndex) => {
    const row = readRecord(valueAtIndex, RECEIPT_FILE_KEYS, STATUS.receiptInvalid);
    const authenticode = projectReceiptAuthenticode(
      row.authenticode,
      STATUS.receiptInvalid,
    );
    const role = assertRole(row.role, STATUS.receiptInvalid);
    const path = assertRelativeInventoryPath(row.path, STATUS.pathLeak);
    const bytes = assertPositiveInteger(row.bytes, MAXIMUM_FILE_BYTES, STATUS.receiptInvalid);
    const sha256 = assertDigest(row.sha256, STATUS.receiptInvalid);
    const expectedRole = expectedMap.get(path);
    if (expectedRole === undefined) {
      if (expectedCaseMap.has(pathKey(path))) fail(STATUS.caseCollision);
      fail(STATUS.extraEntry);
    }
    if (expectedRole !== role) fail(STATUS.receiptInvalid);
    return { authenticode, bytes, path, role, sha256 };
  });
  if (rows.length > expectedMap.size) fail(STATUS.extraEntry);
  if (rows.length < expectedMap.size) fail(STATUS.missingEntry);
  const exactPaths = new Set();
  const caseInsensitivePaths = new Set();
  for (const row of rows) {
    if (exactPaths.has(row.path)) fail(STATUS.extraEntry);
    exactPaths.add(row.path);
    const key = pathKey(row.path);
    if (caseInsensitivePaths.has(key)) fail(STATUS.caseCollision);
    caseInsensitivePaths.add(key);
  }
  for (const path of expectedMap.keys()) {
    if (!exactPaths.has(path)) fail(STATUS.missingEntry);
  }
  const installerRow = rows.find((row) => row.role === "installer");
  if (!installerRow
      || installerRow.bytes !== installer.bytes
      || installerRow.sha256 !== installer.sha256) {
    fail(STATUS.receiptInvalid);
  }
  const canonicalRows = [...rows].sort((left, right) => comparePathBytes(left.path, right.path));
  if (rows.some((row, index) => row.path !== canonicalRows[index].path)) {
    fail(STATUS.receiptInvalid);
  }
  const recomputed = inventoryDigest(canonicalRows);
  const inventorySource = readRecord(source.inventory, [
    ...INVENTORY_KEYS,
    "roles",
  ], STATUS.receiptInvalid);
  const inventory = {
    bytes: assertPositiveInteger(inventorySource.bytes, MAXIMUM_FILE_BYTES * MAXIMUM_FILES, STATUS.receiptInvalid),
    count: assertPositiveInteger(inventorySource.count, MAXIMUM_FILES, STATUS.receiptInvalid),
    sha256: assertDigest(inventorySource.sha256, STATUS.receiptInvalid),
    signedCount: assertPositiveInteger(inventorySource.signedCount, MAXIMUM_FILES, STATUS.receiptInvalid),
  };
  if (inventory.signedCount !== inventory.count
      || inventory.count !== recomputed.count
      || inventory.bytes !== recomputed.bytes
      || inventory.sha256 !== recomputed.sha256) {
    fail(STATUS.receiptInvalid);
  }
  const roles = readRecord(inventorySource.roles, [
    "electronDlls",
    "installer",
    "mainExecutable",
    "nativeModules",
    "uninstaller",
  ], STATUS.receiptInvalid);
  for (const valueAtKey of Object.values(roles)) {
    if (!Number.isSafeInteger(valueAtKey) || valueAtKey < 0 || valueAtKey > MAXIMUM_FILES) {
      fail(STATUS.receiptInvalid);
    }
  }
  if (roles.mainExecutable !== 1
      || roles.installer !== 1
      || roles.uninstaller !== 0
      || roles.nativeModules !== WINDOWS_PRODUCTION_AUTHENTICODE_NATIVE_MODULES.length
      || roles.electronDlls !== WINDOWS_PRODUCTION_AUTHENTICODE_DLL_ALLOWLIST.length
      || inventory.count !== roles.mainExecutable
        + roles.electronDlls
        + roles.uninstaller
        + roles.installer
        + roles.nativeModules) {
    fail(STATUS.receiptInvalid);
  }
  return deepFreeze({
    schemaVersion: WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_SCHEMA,
    status: WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_STATUS,
    target: WINDOWS_PRODUCTION_AUTHENTICODE_TARGET,
    revision,
    packageVersion,
    publisher,
    probeMode: source.probeMode,
    deferred: {
      reason: deferredSource.reason,
      status: deferredSource.status,
    },
    installer,
    files: canonicalRows,
    inventory: {
      ...inventory,
      roles: { ...roles },
    },
  });
}

/**
 * Validate injected probe evidence and return the content-free receipt.
 * `expectedBinding` is optional for construction, but a finalizer should
 * always supply it when joining the receipt to its authority input.
 */
export function verifyWindowsProductionAuthenticodeInventory(value, expectedBinding) {
  const receipt = receiptFromValidatedEvidence(
    validateEvidence(value, expectedBinding),
  );
  if (receipt.probeMode === "native-windows") NATIVE_RECEIPTS.add(receipt);
  return receipt;
}

/**
 * Narrow production-composition boundary.  A canonical JSON string with
 * `probeMode: native-windows` is not sufficient evidence: only the receipt
 * object minted by the in-process native collector is branded in
 * `NATIVE_RECEIPTS`.  Callers receive the exact canonical bytes that must be
 * passed to downstream joins; they cannot brand parsed or forged JSON.
 */
export function assertNativeWindowsProductionAuthenticodeInventoryReceipt(receipt) {
  if (receipt?.probeMode !== "native-windows" || !NATIVE_RECEIPTS.has(receipt)) {
    fail(STATUS.probeModeInvalid);
  }
  const bytes = Buffer.from(
    serializeWindowsProductionAuthenticodeInventoryReceipt(receipt),
    "utf8",
  );
  return Object.freeze({ receipt, bytes });
}

export const validateWindowsProductionAuthenticodeInventoryEvidence =
  verifyWindowsProductionAuthenticodeInventory;

export function validateWindowsProductionAuthenticodeInventoryReceipt(
  value,
  expectedBinding,
) {
  return validateReceipt(value, expectedBinding);
}

export function serializeWindowsProductionAuthenticodeInventoryReceipt(value) {
  const selected = validateReceipt(value);
  const serialized = `${JSON.stringify(stableValue(selected))}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_RECEIPT_BYTES) {
    fail(STATUS.outputInvalid);
  }
  return serialized;
}

export function parseWindowsProductionAuthenticodeInventoryReceipt(
  value,
  expectedBinding,
) {
  if (typeof value !== "string"
      || value.length === 0
      || Buffer.byteLength(value, "utf8") > MAXIMUM_RECEIPT_BYTES) {
    fail(STATUS.receiptInvalid);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail(STATUS.receiptInvalid);
  }
  const selected = validateReceipt(parsed, expectedBinding);
  if (value !== serializeWindowsProductionAuthenticodeInventoryReceipt(selected)) {
    fail(STATUS.receiptInvalid);
  }
  return selected;
}

async function removeOwnedTemporary(path, identity) {
  try {
    const metadata = await lstatForIdentity(path);
    if (metadata.isFile()
        && (metadata.nlink === 1 || metadata.nlink === 2)
        && sameIdentity(metadata, identity)) {
      await unlink(path);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function writeInventoryReceiptOnce(rootState, receipt, hooks) {
  await revalidateDirectoryState(rootState);
  const bytes = Buffer.from(
    serializeWindowsProductionAuthenticodeInventoryReceipt(receipt),
    "utf8",
  );
  if (bytes.byteLength > MAXIMUM_RECEIPT_BYTES) fail(STATUS.outputInvalid);
  const outputPath = join(rootState.path, WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_FILE);
  const temporaryPath = join(
    rootState.path,
    `.${WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_FILE}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  let temporaryIdentity;
  try {
    if (hooks.beforeTemporaryCreate !== undefined) {
      await runTestHook(hooks, "beforeTemporaryCreate");
      await revalidateDirectoryState(rootState);
    }
    handle = await open(temporaryPath, "wx", 0o600);
    temporaryIdentity = await statForIdentity(handle);
    if (!temporaryIdentity.isFile() || temporaryIdentity.nlink !== 1) {
      fail(STATUS.outputInvalid);
    }
    await handle.writeFile(bytes);
    await handle.sync();
    await revalidateDirectoryState(rootState);
    const existing = await lstatForIdentity(outputPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      fail(STATUS.outputInvalid);
    });
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) {
        fail(STATUS.linkRejected);
      }
      fail(STATUS.outputExists);
    }
    await runTestHook(hooks, "beforeOutputPublish");
    await revalidateDirectoryState(rootState);
    try {
      await link(temporaryPath, outputPath);
    } catch (error) {
      if (error?.code === "EEXIST") fail(STATUS.outputExists);
      fail(STATUS.outputInvalid);
    }
    const linked = await lstatForIdentity(outputPath).catch(() => null);
    if (!linked
        || !linked.isFile()
        || linked.isSymbolicLink()
        || linked.nlink !== 2
        || linked.size !== bytes.byteLength
        || !sameIdentity(linked, temporaryIdentity)) {
      fail(STATUS.outputInvalid);
    }
    await runTestHook(hooks, "afterOutputPublish");
    await revalidateDirectoryState(rootState);
    await unlink(temporaryPath);
    temporaryIdentity = null;
    const final = await lstatForIdentity(outputPath).catch(() => null);
    if (!final
        || !final.isFile()
        || final.isSymbolicLink()
        || final.nlink !== 1
        || final.size !== bytes.byteLength) {
      fail(STATUS.outputInvalid);
    }
    return Object.freeze({
      bytes: final.size,
      path: outputPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } catch (error) {
    if (error instanceof WindowsProductionAuthenticodeInventoryError) throw error;
    fail(STATUS.outputInvalid);
  } finally {
    await handle?.close().catch(() => {});
    if (temporaryIdentity) {
      await removeOwnedTemporary(temporaryPath, temporaryIdentity);
    }
  }
}

/** Collect the branded native receipt without consulting a serialized output. */
async function collectNativeWindowsProductionAuthenticodeInventory() {
  assertNativeWindowsX64();
  const roots = await selectProductionAuthenticodeRoots();
  const authorityPath = join(roots.evidence.path, "authority.json");
  const authorityRaw = await readBoundedRawFile(
    authorityPath,
    roots.evidence,
    MAXIMUM_AUTHORITY_BYTES,
    STATUS.authorityInvalid,
  );
  const authority = parseCanonicalAuthority(authorityRaw);
  const nativePresignPath = join(
    roots.evidence.path,
    `windows-native-presign-${authority.sourceRevision}.json`,
  );
  const nativePresignRaw = await readBoundedRawFile(
    nativePresignPath,
    roots.evidence,
    MAXIMUM_NATIVE_PRESIGN_BYTES,
    STATUS.nativePresignInvalid,
  );
  const nativePresign = parseCanonicalNativePresign(nativePresignRaw, authority);
  validateNativeAuthorityBinding(authority, nativePresign);
  const evidence = await buildWindowsProductionAuthenticodeProbeEvidence({
    revision: authority.sourceRevision,
    packageVersion: authority.packageVersion,
    publisher: authority.signerPolicy.publisher,
  }, {
    platform: "win32",
    rootStates: roots,
  });
  if (evidence.probeMode !== "native-windows") fail(STATUS.probeModeInvalid);
  const receipt = verifyWindowsProductionAuthenticodeInventory(
    evidence,
    {
      installerSha256: evidence.installer.sha256,
      packageVersion: authority.packageVersion,
      publisher: authority.signerPolicy.publisher,
      revision: authority.sourceRevision,
    },
  );
  validateObservedNativeAuthorityBinding(authority, receipt);
  await Promise.all([
    revalidateDirectoryState(roots.production),
    revalidateDirectoryState(roots.artifacts),
    revalidateDirectoryState(roots.winUnpacked),
    revalidateDirectoryState(roots.evidence),
  ]);
  return Object.freeze({ roots, receipt });
}

/**
 * Compose a native receipt in-process for the finalizer.  This deliberately
 * does not read or publish `authenticode-inventory.json`; the returned object
 * is branded in `NATIVE_RECEIPTS` and must be passed through the narrow
 * assertion boundary before another stage can consume it.
 */
export async function collectWindowsProductionAuthenticodeInventoryForFinalizer(...args) {
  if (args.length !== 0) fail(STATUS.optionsInvalid);
  const { receipt } = await collectNativeWindowsProductionAuthenticodeInventory();
  return receipt;
}

/**
 * Produce and publish the only standalone production Authenticode inventory.
 * This entrypoint has no path, probe, or probe-mode arguments: every subject
 * is derived from the fixed production roots and the native PowerShell probe.
 */
export async function runWindowsProductionAuthenticodeInventory(...args) {
  if (args.length !== 0) fail(STATUS.optionsInvalid);
  const { roots, receipt } = await collectNativeWindowsProductionAuthenticodeInventory();
  await writeInventoryReceiptOnce(roots.evidence, receipt, {});
  return receipt;
}

/** Write only the fixed production evidence leaf on native Windows x64. */
export async function writeWindowsProductionAuthenticodeInventoryReceipt(receipt) {
  if (arguments.length !== 1) fail(STATUS.optionsInvalid);
  assertNativeWindowsX64();
  if (receipt?.probeMode !== "native-windows" || !NATIVE_RECEIPTS.has(receipt)) {
    fail(STATUS.probeModeInvalid);
  }
  const root = await captureDirectoryState(
    WINDOWS_PRODUCTION_AUTHENTICODE_EVIDENCE_ROOT,
    "win32",
  );
  return writeInventoryReceiptOnce(root, receipt, {});
}

/** Portable test seam for transactional/no-clobber output qualification. */
export async function writeWindowsProductionAuthenticodeInventoryReceiptForTest(
  testRoot,
  receipt,
  hooks = undefined,
) {
  if (arguments.length < 2 || arguments.length > 3
      || typeof testRoot !== "string") {
    fail(STATUS.optionsInvalid);
  }
  const selectedHooks = readTestHooks(hooks);
  const root = await captureDirectoryState(testRoot, process.platform);
  return writeInventoryReceiptOnce(root, receipt, selectedHooks);
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * Build the only native signature probe used by the finalizer.  The command
 * intentionally projects the certificate SimpleName, a SHA-256 digest of the
 * exact UTF-8 Subject text, and timestamp presence; it never serializes
 * SignerCertificate, a distinguished subject, or tool diagnostics.
 */
export function buildWindowsProductionAuthenticodeProbeCommand(path) {
  const selectedPath = assertAbsoluteProbePath(path);
  const literal = powershellLiteral(selectedPath);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$target = [System.IO.Path]::GetFullPath(${literal})`,
    "$current = $target",
    "$parentCheck = $true",
    "while ($parentCheck) { $item = Get-Item -LiteralPath $current -Force; if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse-point' }; $parent = [System.IO.Path]::GetDirectoryName($current); if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) { $parentCheck = $false } else { $current = $parent } }",
    "$stream = [System.IO.File]::Open($target, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)",
    "try { $bytes = $stream.Length; $stream.Position = 0; $hasher = [System.Security.Cryptography.SHA256]::Create(); try { $sha256 = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $hasher.Dispose() }; $signature = Get-AuthenticodeSignature -LiteralPath $target; $publisher = if ($null -eq $signature.SignerCertificate) { '' } else { $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) }; $subject = if ($null -eq $signature.SignerCertificate) { '' } else { $signature.SignerCertificate.Subject }; $subjectBytes = [System.Text.Encoding]::UTF8.GetBytes($subject); if ($subjectBytes.Length -le 0 -or $subjectBytes.Length -gt 4096) { throw 'invalid-subject' }; $subjectHasher = [System.Security.Cryptography.SHA256]::Create(); try { $subjectSha256 = [BitConverter]::ToString($subjectHasher.ComputeHash($subjectBytes)).Replace('-', '').ToLowerInvariant() } finally { $subjectHasher.Dispose() }; & signtool.exe verify /pa /all $target *> $null; $signtoolValid = ($LASTEXITCODE -eq 0); [ordered]@{ bytes = [int64]$bytes; policy = 'authenticode-pa'; publisher = $publisher; sha256 = $sha256; signtoolPaValid = $signtoolValid; status = $signature.Status.ToString(); subjectSha256 = $subjectSha256; subjectUtf8Bytes = [int64]$subjectBytes.Length; timestampPresent = ($null -ne $signature.TimeStamperCertificate) } | ConvertTo-Json -Compress } finally { $stream.Dispose() }",
  ].join("; ");
}

function parseProbeOutput(stdout) {
  if (typeof stdout !== "string"
      || stdout.length === 0
      || Buffer.byteLength(stdout, "utf8") > MAXIMUM_PROBE_BYTES) {
    fail(STATUS.probeInvalid);
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout.replace(/^\uFEFF/u, "").trim());
  } catch {
    fail(STATUS.probeInvalid);
  }
  return validateAuthenticode(
    parsed,
    WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER,
    STATUS.probeInvalid,
    true,
  );
}

/**
 * Invoke PowerShell/signtool only on native Windows.  Tests may inject a
 * spawn function while explicitly selecting `platform: "win32"`; that is an
 * injected probe and does not establish native qualification.
 */
export function runWindowsProductionAuthenticodeProbe(path, options = {}) {
  const {
    platform = process.platform,
    spawn = spawnSync,
  } = options ?? {};
  const injectedSpawn = spawn !== spawnSync;
  if (platform !== "win32"
      || (!injectedSpawn && process.platform !== "win32")) {
    fail(STATUS.platformRequired);
  }
  if (typeof spawn !== "function") fail(STATUS.probeInvalid);
  const selectedPath = assertAbsoluteProbePath(path);
  let child;
  try {
    child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-OutputFormat",
        "Text",
        "-Command",
        buildWindowsProductionAuthenticodeProbeCommand(selectedPath),
      ],
      {
        encoding: "utf8",
        timeout: 120_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    fail(STATUS.probeInvalid);
  }
  if (child?.error || child?.status !== 0) fail(STATUS.probeInvalid);
  return parseProbeOutput(child.stdout);
}

function sameIdentity(left, right) {
  return sameStatIdentity(left.dev, right.dev)
    && sameStatIdentity(left.ino, right.ino);
}

function readOnlyFlags(platform) {
  return fsConstants.O_RDONLY
    | (platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0));
}

async function assertNoSymlinkPathComponents(path) {
  let current = resolve(path);
  while (true) {
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error?.code !== "ENOENT") fail(STATUS.linkRejected);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
      continue;
    }
    if (metadata.isSymbolicLink()) {
      if (process.platform === "darwin"
          && current === "/var"
          && await realpath(current) === "/private/var") {
        current = dirname(current);
        continue;
      }
      fail(STATUS.linkRejected);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function captureRegularFile(path, platform = process.platform) {
  assertAbsoluteProbePath(path, STATUS.probeInvalid);
  await assertNoSymlinkPathComponents(path);
  let before;
  try {
    before = await lstatForIdentity(path);
  } catch (error) {
    fail(error?.code === "ENOENT" ? STATUS.inputMissing : STATUS.probeInvalid);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    fail(STATUS.linkRejected);
  }
  if (before.size <= 0 || before.size > MAXIMUM_FILE_BYTES) fail(STATUS.probeInvalid);
  let handle;
  try {
    handle = await open(path, readOnlyFlags(platform));
    const opened = await statForIdentity(handle);
    if (!opened.isFile()
        || opened.nlink !== 1
        || opened.size !== before.size
        || !sameIdentity(before, opened)) {
      fail(STATUS.linkRejected);
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, bytes);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > MAXIMUM_FILE_BYTES) fail(STATUS.probeInvalid);
      hash.update(chunk.subarray(0, bytesRead));
    }
    const after = await statForIdentity(handle);
    if (bytes !== opened.size
        || after.size !== opened.size
        || after.nlink !== 1
        || !sameIdentity(opened, after)) {
      fail(STATUS.probeInvalid);
    }
    return Object.freeze({
      bytes,
      fileKind: "regular",
      linkStatus: "none",
      sha256: hash.digest("hex"),
    });
  } catch (error) {
    if (error instanceof WindowsProductionAuthenticodeInventoryError) throw error;
    fail(STATUS.probeInvalid);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function validateBuildOptions(value) {
  const source = readRecord(value, BUILD_KEYS);
  const revision = assertRevision(source.revision);
  const packageVersion = assertVersion(source.packageVersion);
  const publisher = assertPublisher(source.publisher);
  if (publisher !== WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER) fail(STATUS.inputInvalid);
  return Object.freeze({ revision, packageVersion, publisher });
}

function validateCapturedFile(value) {
  const source = readRecord(value, ["bytes", "fileKind", "linkStatus", "sha256"], STATUS.probeInvalid);
  return Object.freeze({
    bytes: assertPositiveInteger(source.bytes, MAXIMUM_FILE_BYTES, STATUS.probeInvalid),
    fileKind: source.fileKind,
    linkStatus: source.linkStatus,
    sha256: assertDigest(source.sha256, STATUS.probeInvalid),
  });
}

async function readBoundedRawFile(path, rootState, maximum, code) {
  assertAbsoluteProbePath(path, code);
  if (!pathIsInside(rootState.path, path, rootState.platform)) fail(STATUS.outOfRoot);
  await assertNoSymlinkPathComponents(path);
  let before;
  try {
    before = await lstatForIdentity(path);
  } catch (error) {
    fail(error?.code === "ENOENT" ? STATUS.inputMissing : code);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    fail(STATUS.linkRejected);
  }
  if (before.size <= 0 || before.size > maximum) fail(code);
  let handle;
  try {
    handle = await open(path, readOnlyFlags(rootState.platform));
    const opened = await statForIdentity(handle);
    if (!opened.isFile()
        || opened.nlink !== 1
        || opened.size !== before.size
        || !sameIdentity(before, opened)) {
      fail(STATUS.linkRejected);
    }
    const hash = createHash("sha256");
    const chunks = [];
    let bytesReadTotal = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(
        READ_CHUNK_BYTES,
        maximum + 1 - bytesReadTotal,
      ));
      const { bytesRead } = await handle.read(
        chunk,
        0,
        chunk.length,
        bytesReadTotal,
      );
      if (bytesRead === 0) break;
      bytesReadTotal += bytesRead;
      if (bytesReadTotal > maximum) fail(code);
      const selected = chunk.subarray(0, bytesRead);
      chunks.push(selected);
      hash.update(selected);
    }
    const after = await statForIdentity(handle);
    const finalPath = await lstatForIdentity(path).catch(() => null);
    if (bytesReadTotal !== opened.size
        || !after.isFile()
        || after.nlink !== 1
        || after.size !== opened.size
        || !sameIdentity(opened, after)
        || !finalPath
        || !finalPath.isFile()
        || finalPath.isSymbolicLink()
        || finalPath.nlink !== 1
        || !sameIdentity(opened, finalPath)) {
      fail(STATUS.rootReplaced);
    }
    await revalidateDirectoryState(rootState);
    return Object.freeze({
      bytes: Buffer.concat(chunks, bytesReadTotal),
      sha256: hash.digest("hex"),
    });
  } catch (error) {
    if (error instanceof WindowsProductionAuthenticodeInventoryError) throw error;
    fail(code);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function decodeUtf8(bytes, code) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(code);
  }
}

function parseCanonicalAuthority(raw) {
  const text = decodeUtf8(raw.bytes, STATUS.authorityInvalid);
  let authority;
  try {
    authority = parseWindowsProductionAuthorityManifest(text);
  } catch {
    fail(STATUS.authorityInvalid);
  }
  let canonical;
  try {
    canonical = serializeWindowsProductionAuthorityManifest(authority);
  } catch {
    fail(STATUS.authorityInvalid);
  }
  if (canonical !== text) fail(STATUS.authorityNoncanonical);
  if (authority.schemaVersion !== WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_SCHEMA
      || authority.status !== WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_STATUS
      || authority.product !== WINDOWS_PRODUCTION_AUTHORITY_PRODUCT
      || authority.platform !== WINDOWS_PRODUCTION_AUTHORITY_PLATFORM
      || authority.architecture !== WINDOWS_PRODUCTION_AUTHORITY_ARCHITECTURE
      || authority.signerPolicy.publisher !== WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER) {
    fail(STATUS.authorityInvalid);
  }
  return authority;
}

function parseCanonicalNativePresign(raw, authority) {
  const text = decodeUtf8(raw.bytes, STATUS.nativePresignInvalid);
  let receipt;
  try {
    receipt = parseWindowsNativePresignReceipt(text);
  } catch {
    fail(STATUS.nativePresignInvalid);
  }
  let canonical;
  try {
    canonical = serializeWindowsNativePresignReceipt(receipt);
  } catch {
    fail(STATUS.nativePresignInvalid);
  }
  if (canonical !== text) fail(STATUS.nativePresignNoncanonical);
  if (receipt.schemaVersion !== WINDOWS_NATIVE_PRESIGN_SCHEMA
      || receipt.status !== WINDOWS_NATIVE_PRESIGN_STATUS
      || receipt.target !== WINDOWS_PRODUCTION_AUTHENTICODE_TARGET
      || receipt.revision !== authority.sourceRevision
      || receipt.packageVersion !== authority.packageVersion) {
    fail(STATUS.nativePresignInvalid);
  }
  if (raw.sha256 !== authority.nativePresign.receiptSha256) {
    fail(STATUS.nativeBindingMismatch);
  }
  return receipt;
}

function validateNativeAuthorityBinding(authority, receipt) {
  const expected = new Map(
    authority.nativeModules.map((module) => [module.packagedPath, module]),
  );
  const observed = new Map(
    receipt.modules.map((module) => [module.packagedPath, module]),
  );
  if (expected.size !== WINDOWS_PRODUCTION_AUTHENTICODE_NATIVE_MODULES.length
      || observed.size !== expected.size) {
    fail(STATUS.nativeBindingMismatch);
  }
  for (const [path, module] of expected) {
    const selected = observed.get(path);
    if (!selected
        || selected.name !== module.name
        || selected.signedBytes !== module.signedBytes
        || selected.signedSha256 !== module.signedSha256) {
      fail(STATUS.nativeBindingMismatch);
    }
  }
}

function validateObservedNativeAuthorityBinding(authority, receipt) {
  const expected = new Map(
    authority.nativeModules.map((module) => [module.packagedPath, module]),
  );
  for (const row of receipt.files.filter(({ role }) => role === "native-module")) {
    const module = expected.get(row.path);
    if (!module
        || row.bytes !== module.signedBytes
        || row.sha256 !== module.signedSha256) {
      fail(STATUS.nativeBindingMismatch);
    }
  }
}

function readTestHooks(value) {
  if (value === undefined) return Object.freeze({});
  rejectProxy(value, STATUS.optionsInvalid);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(STATUS.optionsInvalid);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !TEST_HOOKS.has(key))) {
    fail(STATUS.optionsInvalid);
  }
  const selected = {};
  for (const key of TEST_HOOK_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
        || descriptor.get !== undefined
        || descriptor.set !== undefined
        || typeof descriptor.value !== "function") {
      fail(STATUS.optionsInvalid);
    }
    selected[key] = descriptor.value;
  }
  return Object.freeze(selected);
}

async function runTestHook(hooks, name) {
  const hook = hooks?.[name];
  if (hook === undefined) return;
  try {
    await hook();
  } catch {
    fail(STATUS.outputInvalid);
  }
}

/**
 * Collect closed probe evidence from explicit paths.  This helper is useful
 * to the native finalizer, while its `captureFile` and `probe` dependencies
 * make portable tests deterministic and incapable of claiming native proof.
 */
export async function buildWindowsProductionAuthenticodeProbeEvidence(
  value,
  dependencies = {},
) {
  const {
    platform = process.platform,
    captureFile = (path) => captureRegularFile(path, platform),
    probe,
    rootStates,
    testOnly,
    testRoot,
  } = dependencies ?? {};
  const options = validateBuildOptions(value);
  const capturedStates = rootStates === undefined
    ? null
    : validateCapturedRootStates(rootStates, platform);
  const roots = capturedStates === null
    ? await selectProductionRoots({ platform, testOnly, testRoot })
    : {
      productionRoot: capturedStates.production.path,
      artifactsRoot: capturedStates.artifacts.path,
      winUnpackedRoot: capturedStates.winUnpacked.path,
    };
  const revalidateRoots = capturedStates === null
    ? async () => {}
    : () => revalidateCapturedRootStates(capturedStates);
  const selectedProbe = probe
    ?? (platform === "win32"
      ? (path) => runWindowsProductionAuthenticodeProbe(path, { platform })
      : null);
  if (typeof captureFile !== "function" || typeof selectedProbe !== "function") {
    if (platform !== "win32" && probe === undefined) fail(STATUS.platformRequired);
    fail(STATUS.probeInvalid);
  }
  const files = [];
  const probeMode = probe === undefined
    && platform === "win32"
    && process.platform === "win32"
    ? "native-windows"
    : "injected";
  for (const expected of expectedRows(options.packageVersion)) {
    let captured;
    let authenticode;
    try {
      await revalidateRoots();
      const absolutePath = await resolveSubjectPath(roots, expected, platform);
      await revalidateRoots();
      const beforeProbe = validateCapturedFile(
        await captureFile(absolutePath),
      );
      await revalidateRoots();
      const nativeProbe = probeMode === "native-windows";
      const rawProbe = await selectedProbe(absolutePath);
      await revalidateRoots();
      authenticode = validateAuthenticode(
        rawProbe,
        options.publisher,
        STATUS.signatureInvalid,
        nativeProbe,
      );
      const afterProbe = validateCapturedFile(
        await captureFile(absolutePath),
      );
      await revalidateRoots();
      if (beforeProbe.bytes !== afterProbe.bytes
          || beforeProbe.sha256 !== afterProbe.sha256
          || beforeProbe.fileKind !== afterProbe.fileKind
          || beforeProbe.linkStatus !== afterProbe.linkStatus) {
        fail(STATUS.probeInvalid);
      }
      if (nativeProbe
          && (authenticode.bytes !== afterProbe.bytes
            || authenticode.sha256 !== afterProbe.sha256)) {
        fail(STATUS.probeInvalid);
      }
      captured = afterProbe;
    } catch (error) {
      if (error instanceof WindowsProductionAuthenticodeInventoryError) throw error;
      fail(STATUS.probeInvalid);
    }
    files.push({
      role: expected.role,
      path: expected.path,
      bytes: captured.bytes,
      sha256: captured.sha256,
      fileKind: captured.fileKind,
      linkStatus: captured.linkStatus,
      authenticode,
    });
  }
  await revalidateRoots();
  const evidence = {
    schemaVersion: WINDOWS_PRODUCTION_AUTHENTICODE_PROBE_SCHEMA,
    status: WINDOWS_PRODUCTION_AUTHENTICODE_PROBE_STATUS,
    target: WINDOWS_PRODUCTION_AUTHENTICODE_TARGET,
    revision: options.revision,
    packageVersion: options.packageVersion,
    publisher: options.publisher,
    probeMode,
    installer: (() => {
      const installer = files.find((row) => row.role === "installer");
      return { bytes: installer.bytes, sha256: installer.sha256 };
    })(),
    files,
  };
  if (probeMode === "native-windows") NATIVE_EVIDENCE.add(evidence);
  // Validate once more after collection so the returned evidence is closed
  // and exact before a caller can hand it to the finalizer.
  validateEvidence(evidence);
  return deepFreeze(evidence);
}

export async function buildWindowsProductionAuthenticodeInventory(
  value,
  dependencies,
  expectedBinding,
) {
  const evidence = await buildWindowsProductionAuthenticodeProbeEvidence(
    value,
    dependencies,
  );
  return verifyWindowsProductionAuthenticodeInventory(evidence, expectedBinding);
}

export const buildWindowsProductionAuthenticodeInventoryReceipt =
  buildWindowsProductionAuthenticodeInventory;

export function fixedStatus(error) {
  return error instanceof WindowsProductionAuthenticodeInventoryError
      && KNOWN_STATUSES.has(error.code)
    ? error.code
    : STATUS.inputInvalid;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    if (!Array.isArray(argv) || argv.length !== 0) fail(STATUS.optionsInvalid);
    await runWindowsProductionAuthenticodeInventory();
    process.stdout.write(`${WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_STATUS}\n`);
  } catch (error) {
    process.stdout.write(`${fixedStatus(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  await main();
}
