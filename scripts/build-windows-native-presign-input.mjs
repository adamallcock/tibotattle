#!/usr/bin/env node

/**
 * Build the closed input document consumed by windows-native-presign.mjs.
 *
 * This is an offline evidence join.  It never authenticates, signs, invokes
 * PowerShell, contacts a service, or accepts a caller-supplied Azure value.
 * The certificateSubjectSha256 value must be the owner-approved lowercase
 * digest independently checked by the protected Azure subject preflight; the
 * raw certificate Subject is never accepted here.
 * The only production staging and package roots are the reviewed constants;
 * tests may supply equivalent temporary roots through the explicit dependency
 * object used by the library entry point.
 */

import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
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
  WINDOWS_NATIVE_PRESIGN_RECEIPT_ROOT,
  WINDOWS_NATIVE_PRESIGN_STAGING_ROOT,
  validateWindowsNativePresignOptions,
} from "./windows-native-presign.mjs";
import {
  WINDOWS_FINALIZER_EXPECTED_REPOSITORY,
  WINDOWS_FINALIZER_HANDOFF_SCHEMA,
  validateWindowsFinalizerQualificationHandoff,
} from "./verify-windows-finalizer-qualification-handoff.mjs";
import {
  canonicalElectronBuilderPackageJsonBytes,
} from "./lib/electron-builder-package-json.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");

export const WINDOWS_NATIVE_PRESIGN_INPUT_SCHEMA =
  "tibotattle-windows-native-presign-input-v1";
export const WINDOWS_NATIVE_PRESIGN_INPUT_STATUS =
  "WINDOWS_NATIVE_PRESIGN_INPUT_BUILT";
export const WINDOWS_NATIVE_PRESIGN_INPUT_PACKAGE_JSON_PATH = join(
  REPOSITORY_ROOT,
  "package.json",
);
export const WINDOWS_NATIVE_PRESIGN_INPUT_RUNTIME_MANIFEST_PATH = join(
  WINDOWS_NATIVE_PRESIGN_STAGING_ROOT,
  "electron-runtime-manifest.json",
);

export const WINDOWS_NATIVE_PRESIGN_INPUT_FIXED_STATUS = Object.freeze({
  inputInvalid: "WINDOWS_NATIVE_PRESIGN_INPUT_BUILDER_INPUT_INVALID",
  inputMissing: "WINDOWS_NATIVE_PRESIGN_INPUT_BUILDER_INPUT_MISSING",
  duplicateJsonKey: "WINDOWS_NATIVE_PRESIGN_INPUT_BUILDER_DUPLICATE_JSON_KEY",
  jsonInvalid: "WINDOWS_NATIVE_PRESIGN_INPUT_BUILDER_JSON_INVALID",
  evidenceRootInvalid: "WINDOWS_NATIVE_PRESIGN_INPUT_BUILDER_EVIDENCE_ROOT_INVALID",
  stagingInvalid: "WINDOWS_NATIVE_PRESIGN_INPUT_BUILDER_STAGING_INVALID",
  handoffInvalid: "WINDOWS_NATIVE_PRESIGN_INPUT_BUILDER_HANDOFF_INVALID",
  handoffNoncanonical: "WINDOWS_NATIVE_PRESIGN_INPUT_BUILDER_HANDOFF_NONCANONICAL",
  packageInvalid: "WINDOWS_NATIVE_PRESIGN_INPUT_BUILDER_PACKAGE_INVALID",
  runtimeInvalid: "WINDOWS_NATIVE_PRESIGN_INPUT_BUILDER_RUNTIME_INVALID",
  nativeInvalid: "WINDOWS_NATIVE_PRESIGN_INPUT_BUILDER_NATIVE_INVALID",
  outputInvalid: "WINDOWS_NATIVE_PRESIGN_INPUT_BUILDER_OUTPUT_INVALID",
  outputExists: "WINDOWS_NATIVE_PRESIGN_INPUT_BUILDER_OUTPUT_EXISTS",
  attemptCleanupRequired:
    "WINDOWS_NATIVE_PRESIGN_INPUT_BUILDER_ATTEMPT_CLEANUP_REQUIRED",
  passed: WINDOWS_NATIVE_PRESIGN_INPUT_STATUS,
});

const STATUS = WINDOWS_NATIVE_PRESIGN_INPUT_FIXED_STATUS;
export const FIXED_STATUS = STATUS;
const KNOWN_STATUSES = new Set(Object.values(STATUS));
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const RUNTIME_MANIFEST_SCHEMA = "usage-monitor-electron-runtime-v0.1";
const WINDOWS_BINDING_PATH =
  "native/windows-filesystem/build/Release/windows_filesystem.node";
const WINDOWS_BINDING_MANIFEST_PATH = `${WINDOWS_BINDING_PATH}.manifest.json`;
const KEYTAR_PATH = "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node";
const RUNTIME_MANIFEST_FILE = "electron-runtime-manifest.json";
const MAXIMUM_HANDOFF_BYTES = 512 * 1024;
const MAXIMUM_PACKAGE_BYTES = 64 * 1024;
const MAXIMUM_RUNTIME_MANIFEST_BYTES = 1 * 1024 * 1024;
const MAXIMUM_NATIVE_BYTES = 64 * 1024 * 1024;
const MAXIMUM_STAGING_BYTES = 512 * 1024 * 1024;
const MAXIMUM_STAGING_FILES = 10000;
const MAXIMUM_JSON_DEPTH = 64;
const MAXIMUM_JSON_NODES = 4096;
const READ_CHUNK_BYTES = 64 * 1024;
const MAXIMUM_FILENAME_BYTES = 255;
const MAXIMUM_PATH_BYTES = 4096;
const POSIX_NO_FOLLOW_FLAG = process.platform === "win32"
  ? 0
  : (fsConstants.O_NOFOLLOW ?? 0);
const POSIX_NON_BLOCKING_FLAG = process.platform === "win32"
  ? 0
  : (fsConstants.O_NONBLOCK ?? 0);
const READ_ONLY_FLAGS = fsConstants.O_RDONLY
  | POSIX_NO_FOLLOW_FLAG
  | POSIX_NON_BLOCKING_FLAG;
// Windows file IDs can exceed JavaScript's safe integer range. Keep dev/ino
// as BigInt while converting only bounded count fields used arithmetically.
const MAX_SAFE_STAT_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

const BUILDER_OPTIONS_KEYS = Object.freeze([
  "evidenceRoot",
  "handoff",
  "output",
  "certificateSubjectSha256",
]);
const CLI_FLAGS = Object.freeze(new Map([
  ["--evidence-root", "evidenceRoot"],
  ["--handoff", "handoff"],
  ["--output", "output"],
  ["--certificate-subject-sha256", "certificateSubjectSha256"],
]));
const RESERVED_DOS_BASENAMES = new Set([
  "AUX",
  "CON",
  "NUL",
  "PRN",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);
const TEST_FAULT_POINTS = new Set([
  "after-temp-open",
  "after-temp-write",
  "after-temp-sync",
  "before-publish",
  "mutate-runtime-after-inventory",
  "mutate-runtime-before-publication",
  "replace-evidence-before-temp",
  "replace-evidence-before-publication",
]);

const BUILD_METADATA = new WeakMap();

export class WindowsNativePresignInputBuilderError extends Error {
  constructor(code, { requiresAttemptCleanup = false } = {}) {
    super("Windows native pre-sign input build failed");
    this.name = "WindowsNativePresignInputBuilderError";
    this.code = code;
    this.requiresAttemptCleanup = requiresAttemptCleanup;
  }
}

function fail(code, options) {
  throw new WindowsNativePresignInputBuilderError(code, options);
}

function rejectProxy(value, code = STATUS.inputInvalid) {
  try {
    if (isProxy(value)) fail(code);
  } catch {
    fail(code);
  }
}

function ownDataRecord(value, keys, code = STATUS.inputInvalid) {
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

function safeAbsolutePath(value, code = STATUS.inputInvalid) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\0")
      || Buffer.byteLength(value, "utf8") > MAXIMUM_PATH_BYTES
      || !isAbsolute(value)
      || resolve(value) !== value) {
    fail(code);
  }
  return value;
}

function safePortableFilename(value, code = STATUS.inputInvalid) {
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
      || !/^[A-Za-z0-9@][A-Za-z0-9@._-]*$/u.test(value)) {
    fail(code);
  }
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
      || Buffer.byteLength(value, "utf8") > MAXIMUM_PATH_BYTES) {
    fail(code);
  }
  const parts = value.split("/");
  if (parts.some((part) => {
    if (part.length === 0 || part === "." || part === "..") return true;
    try {
      safePortableFilename(part, code);
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

function normalizeStatInteger(value) {
  if (typeof value === "bigint") {
    if (value < 0n || value > MAX_SAFE_STAT_INTEGER) return null;
    return Number(value);
  }
  return value;
}

function normalizeStats(stats) {
  if (process.platform !== "win32") return stats;
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: normalizeStatInteger(stats.mode),
    nlink: normalizeStatInteger(stats.nlink),
    uid: normalizeStatInteger(stats.uid),
    size: normalizeStatInteger(stats.size),
    birthtimeNs: stats.birthtimeNs,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    birthtimeMs: stats.birthtimeMs,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
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

function sameIdentity(left, right) {
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
    && left.nlink === 1
    && right.nlink === 1
    && left.dev === right.dev
    && left.ino === right.ino
    && birthLeft === birthRight
    && left.size === right.size
    && mtimeLeft === mtimeRight
    && ctimeLeft === ctimeRight;
}

function capturedFileIdentity(metadata) {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    nlink: metadata.nlink,
    size: metadata.size,
    birthtimeNs: metadata.birthtimeNs
      ?? BigInt(Math.round(metadata.birthtimeMs * 1e6)),
    mtimeNs: metadata.mtimeNs
      ?? BigInt(Math.round(metadata.mtimeMs * 1e6)),
    ctimeNs: metadata.ctimeNs
      ?? BigInt(Math.round(metadata.ctimeMs * 1e6)),
  });
}

function sameCapturedFile(left, right) {
  const leftIdentity = left.identity;
  const rightIdentity = right.identity;
  return left.size === right.size
    && left.sha256 === right.sha256
    && leftIdentity.dev === rightIdentity.dev
    && leftIdentity.ino === rightIdentity.ino
    && leftIdentity.nlink === rightIdentity.nlink
    && leftIdentity.birthtimeNs === rightIdentity.birthtimeNs
    && leftIdentity.mtimeNs === rightIdentity.mtimeNs
    && leftIdentity.ctimeNs === rightIdentity.ctimeNs
    && Buffer.from(left.bytes).equals(Buffer.from(right.bytes));
}

function decodeUtf8(bytes, code) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(code);
  }
}

function scanJsonSyntax(text, invalidCode, duplicateCode) {
  if (typeof text !== "string" || text.length === 0) fail(invalidCode);
  let index = 0;
  let nodes = 0;
  const length = text.length;
  const whitespace = () => {
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
  if (index !== length) fail(invalidCode);
}

function parseJsonBytes(bytes, { maximumBytes, invalidCode, duplicateCode }) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    fail(invalidCode);
  }
  const text = decodeUtf8(bytes, invalidCode);
  scanJsonSyntax(text, invalidCode, duplicateCode);
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(invalidCode);
    }
    return value;
  } catch (error) {
    if (error instanceof WindowsNativePresignInputBuilderError) throw error;
    fail(invalidCode);
  }
}

async function captureRegularFile(path, maximumBytes, code) {
  let handle;
  try {
    const before = await lstatForIdentity(path);
    if (!before.isFile()
        || before.isSymbolicLink()
        || before.nlink !== 1
        || before.size <= 0
        || before.size > maximumBytes) fail(code);
    handle = await open(path, READ_ONLY_FLAGS);
    const opened = await statForIdentity(handle);
    const afterOpen = await lstatForIdentity(path);
    if (!sameIdentity(before, opened) || !sameIdentity(before, afterOpen)) fail(code);
    const chunks = [];
    const hash = createHash("sha256");
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
    const finished = await statForIdentity(handle);
    const afterRead = await lstatForIdentity(path);
    if (!sameIdentity(opened, finished)
        || !sameIdentity(opened, afterRead)
        || total !== opened.size) fail(code);
    return Object.freeze({
      bytes: Buffer.concat(chunks, total),
      size: total,
      sha256: hash.digest("hex"),
      identity: capturedFileIdentity(opened),
    });
  } catch (error) {
    if (error instanceof WindowsNativePresignInputBuilderError) throw error;
    fail(code);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function rootIdentity(metadata) {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    uid: metadata.uid,
    mode: metadata.mode,
    birthtimeNs: metadata.birthtimeNs ?? BigInt(Math.round(metadata.birthtimeMs * 1e6)),
  });
}

function sameRootIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.mode === right.mode
    && left.birthtimeNs === right.birthtimeNs;
}

function assertPrivateOwnedDirectory(metadata, code) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(code);
  if (typeof process.getuid === "function"
      && metadata.uid !== undefined
      && metadata.uid !== process.getuid()) fail(code);
  if (process.platform !== "win32" && (metadata.mode & 0o022) !== 0) fail(code);
}

async function captureOwnedRoot(path, code) {
  try {
    const metadata = await lstatForIdentity(path);
    assertPrivateOwnedDirectory(metadata, code);
    const canonical = await realpath(path);
    const canonicalMetadata = await lstatForIdentity(canonical);
    assertPrivateOwnedDirectory(canonicalMetadata, code);
    if (canonical !== path || !sameRootIdentity(rootIdentity(metadata), rootIdentity(canonicalMetadata))) {
      fail(code);
    }
    return Object.freeze({ path, identity: rootIdentity(metadata) });
  } catch (error) {
    if (error instanceof WindowsNativePresignInputBuilderError) throw error;
    fail(code);
  }
}

async function assertOwnedRoot(state, code) {
  try {
    const current = await lstatForIdentity(state.path);
    assertPrivateOwnedDirectory(current, code);
    if (!sameRootIdentity(state.identity, rootIdentity(current))) fail(code);
    const canonical = await realpath(state.path);
    if (canonical !== state.path) fail(code);
  } catch (error) {
    if (error instanceof WindowsNativePresignInputBuilderError) throw error;
    fail(code);
  }
}

async function requireAbsent(path, existsCode, invalidCode) {
  try {
    await lstat(path);
    fail(existsCode);
  } catch (error) {
    if (error instanceof WindowsNativePresignInputBuilderError) throw error;
    if (error?.code !== "ENOENT") fail(invalidCode);
  }
}

async function mutateRuntimeManifestForTest(path, code) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    fail(code);
  }
  if (!bytes || bytes.byteLength === 0) fail(code);
  bytes[0] = bytes[0] === 0x7b ? 0x5b : bytes[0] ^ 0x01;
  try {
    await writeFile(path, bytes, { flag: "r+" });
  } catch {
    fail(code);
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

function assertOutside(parent, child, code) {
  const suffix = relative(resolve(parent), resolve(child));
  if (suffix === "" || (suffix !== ".." && !suffix.startsWith(".."))) fail(code);
}

function assertManifestKeys(value, keys, code) {
  const source = ownDataRecord(value, keys, code);
  return source;
}

function assertSha256(value, code) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(code);
  return value;
}

function assertPositiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}

function assertVersion(value, code) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) fail(code);
  return value;
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

function validatePackage(packageBytes, code) {
  const parsed = parseJsonBytes(packageBytes, {
    maximumBytes: MAXIMUM_PACKAGE_BYTES,
    invalidCode: code,
    duplicateCode: STATUS.duplicateJsonKey,
  });
  if (parsed.name !== "app-usagemonitor"
      || parsed.private !== true
      || parsed.type !== "module") fail(code);
  return Object.freeze({
    name: "app-usagemonitor",
    version: assertVersion(parsed.version, code),
  });
}

function validateRuntimeManifest(runtimeBytes, packageVersion) {
  const manifest = parseJsonBytes(runtimeBytes, {
    maximumBytes: MAXIMUM_RUNTIME_MANIFEST_BYTES,
    invalidCode: STATUS.runtimeInvalid,
    duplicateCode: STATUS.duplicateJsonKey,
  });
  if (stableJson(manifest) !== runtimeBytes.toString("utf8")) fail(STATUS.runtimeInvalid);
  const source = assertManifestKeys(manifest, [
    "architecture",
    "dashboardRoot",
    "entrypoint",
    "files",
    "payload",
    "releaseVersion",
    "schemaVersion",
    "target",
    "windowsBinding",
  ], STATUS.runtimeInvalid);
  if (source.schemaVersion !== RUNTIME_MANIFEST_SCHEMA
      || source.target !== "win32"
      || source.architecture !== "x64"
      || source.releaseVersion !== packageVersion
      || source.entrypoint !== "apps/electron/main.js"
      || source.dashboardRoot !== "apps/web/public"
      || !Array.isArray(source.files)
      || source.files.length === 0) fail(STATUS.runtimeInvalid);

  const rows = [];
  const exact = new Set();
  const folded = new Set();
  let previousPath = null;
  for (const value of source.files) {
    const row = assertManifestKeys(value, ["bytes", "kind", "path", "sha256"], STATUS.runtimeInvalid);
    const path = safeRelativePath(row.path, STATUS.runtimeInvalid);
    if (path === RUNTIME_MANIFEST_FILE
        || !Number.isSafeInteger(row.bytes)
        || row.bytes <= 0
        || typeof row.kind !== "string"
        || row.kind.length === 0
        || !assertSha256(row.sha256, STATUS.runtimeInvalid)
        || (previousPath !== null && comparePathBytes(previousPath, path) >= 0)
        || exact.has(path)
        || folded.has(path.toLowerCase())) fail(STATUS.runtimeInvalid);
    exact.add(path);
    folded.add(path.toLowerCase());
    previousPath = path;
    rows.push(Object.freeze({
      bytes: row.bytes,
      kind: row.kind,
      path,
      sha256: row.sha256,
    }));
  }
  if (rows.length > MAXIMUM_STAGING_FILES
      || !exact.has(WINDOWS_BINDING_PATH)
      || !exact.has(WINDOWS_BINDING_MANIFEST_PATH)
      || !exact.has(KEYTAR_PATH)
      || rows.filter(({ path }) => path.toLowerCase().endsWith(".node")).length !== 2
      || rows.some(({ path }) => path.toLowerCase().endsWith(".node")
        && path !== WINDOWS_BINDING_PATH
        && path !== KEYTAR_PATH)) {
    fail(STATUS.runtimeInvalid);
  }
  const payload = assertManifestKeys(source.payload, ["bytes", "sha256"], STATUS.runtimeInvalid);
  if (!Number.isSafeInteger(payload.bytes)
      || payload.bytes <= 0
      || !SHA256_PATTERN.test(payload.sha256)) fail(STATUS.runtimeInvalid);
  const expectedPayload = digestPayload(rows);
  if (payload.bytes !== expectedPayload.bytes || payload.sha256 !== expectedPayload.sha256) {
    fail(STATUS.runtimeInvalid);
  }
  const windowsBinding = assertManifestKeys(
    source.windowsBinding,
    ["binding", "included", "manifest", "status", "verified"],
    STATUS.runtimeInvalid,
  );
  const binding = assertManifestKeys(
    windowsBinding.binding,
    ["bytes", "path", "sha256"],
    STATUS.runtimeInvalid,
  );
  const sidecar = assertManifestKeys(windowsBinding.manifest, ["path"], STATUS.runtimeInvalid);
  if (windowsBinding.included !== true
      || windowsBinding.status !== "included_unverified"
      || windowsBinding.verified !== false
      || binding.path !== WINDOWS_BINDING_PATH
      || sidecar.path !== WINDOWS_BINDING_MANIFEST_PATH
      || !Number.isSafeInteger(binding.bytes)
      || binding.bytes <= 0
      || !SHA256_PATTERN.test(binding.sha256)) fail(STATUS.runtimeInvalid);
  const bindingRow = rows.find(({ path }) => path === WINDOWS_BINDING_PATH);
  if (binding.bytes !== bindingRow.bytes || binding.sha256 !== bindingRow.sha256) {
    fail(STATUS.runtimeInvalid);
  }
  return Object.freeze({ manifest: source, rows: Object.freeze(rows) });
}

async function inventoryStaging(root) {
  const exact = new Set();
  const folded = new Set();
  const rows = [];
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
      safePortableFilename(entry.name, STATUS.stagingInvalid);
      const path = join(current, entry.name);
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      safeRelativePath(relativePath, STATUS.stagingInvalid);
      if (entry.isSymbolicLink()) fail(STATUS.stagingInvalid);
      if (entry.isDirectory()) {
        await walk(path, relativePath);
        continue;
      }
      if (!entry.isFile()) fail(STATUS.stagingInvalid);
      if (relativePath === RUNTIME_MANIFEST_FILE) continue;
      if (rows.length >= MAXIMUM_STAGING_FILES) fail(STATUS.stagingInvalid);
      const captured = await captureRegularFile(path, MAXIMUM_NATIVE_BYTES, STATUS.stagingInvalid);
      const foldedPath = relativePath.toLowerCase();
      if (exact.has(relativePath) || folded.has(foldedPath)) fail(STATUS.stagingInvalid);
      exact.add(relativePath);
      folded.add(foldedPath);
      totalBytes += captured.size;
      if (totalBytes > MAXIMUM_STAGING_BYTES) fail(STATUS.stagingInvalid);
      rows.push({
        bytes: captured.size,
        path: relativePath,
        sha256: captured.sha256,
      });
    }
  }
  await walk(root, "");
  rows.sort((left, right) => comparePathBytes(left.path, right.path));
  return Object.freeze({ rows: Object.freeze(rows), totalBytes });
}

function validateStagedInventory(runtime, actual) {
  const expected = new Map(runtime.rows.map((row) => [row.path, row]));
  if (expected.size !== actual.rows.length) fail(STATUS.runtimeInvalid);
  const actualMap = new Map(actual.rows.map((row) => [row.path, row]));
  for (const row of runtime.rows) {
    const selected = actualMap.get(row.path);
    if (!selected
        || selected.bytes !== row.bytes
        || selected.sha256 !== row.sha256) fail(STATUS.runtimeInvalid);
  }
  for (const path of actualMap.keys()) {
    if (!expected.has(path)) fail(STATUS.runtimeInvalid);
  }
  return actualMap;
}

function validateHandoff(handoffBytes) {
  const handoff = parseJsonBytes(handoffBytes, {
    maximumBytes: MAXIMUM_HANDOFF_BYTES,
    invalidCode: STATUS.handoffInvalid,
    duplicateCode: STATUS.duplicateJsonKey,
  });
  if (handoff.schemaVersion !== WINDOWS_FINALIZER_HANDOFF_SCHEMA) {
    fail(STATUS.handoffInvalid);
  }
  let selected;
  try {
    selected = validateWindowsFinalizerQualificationHandoff(handoff, {
      repository: WINDOWS_FINALIZER_EXPECTED_REPOSITORY,
      revision: handoff.revision,
      ref: "refs/heads/main",
    });
  } catch {
    fail(STATUS.handoffInvalid);
  }
  if (stableJson(selected) !== handoffBytes.toString("utf8")) fail(STATUS.handoffNoncanonical);
  const warm = selected.receipts.find(({ cacheMode }) => cacheMode === "warm");
  const clean = selected.receipts.find(({ cacheMode }) => cacheMode === "clean");
  if (!warm || !clean
      || warm.binding.bytes !== clean.binding.bytes
      || warm.binding.sha256 !== clean.binding.sha256) fail(STATUS.handoffInvalid);
  return Object.freeze({
    revision: selected.revision,
    binding: Object.freeze({ ...warm.binding }),
  });
}

function buildInput({
  handoff,
  handoffSha256,
  packageVersion,
  stagingRoot,
  receiptRoot,
  binding,
  certificateSubjectSha256,
}) {
  const candidate = {
    stagingRoot,
    revision: handoff.revision,
    packageVersion,
    qualificationHandoffSha256: handoffSha256,
    filesystemBinding: binding,
    keytarSha256: WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256,
    certificateSubjectSha256,
    azure: {
      endpoint: WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.endpoint,
      codeSigningAccountName: WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.codeSigningAccountName,
      certificateProfileName: WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.certificateProfileName,
      publisher: WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.publisher,
    },
  };
  try {
    validateWindowsNativePresignOptions(candidate, {
      expectedStagingRoot: stagingRoot,
      expectedReceiptRoot: receiptRoot,
    });
  } catch {
    fail(STATUS.inputInvalid);
  }
  return Object.freeze(candidate);
}

export function serializeWindowsNativePresignInput(value, {
  expectedStagingRoot = WINDOWS_NATIVE_PRESIGN_STAGING_ROOT,
  expectedReceiptRoot = WINDOWS_NATIVE_PRESIGN_RECEIPT_ROOT,
} = {}) {
  try {
    validateWindowsNativePresignOptions(value, {
      expectedStagingRoot,
      expectedReceiptRoot,
    });
  } catch {
    fail(STATUS.inputInvalid);
  }
  const serialized = stableJson(value);
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_HANDOFF_BYTES) fail(STATUS.outputInvalid);
  return serialized;
}

export function validateWindowsNativePresignInputBuilderOptions(value) {
  const source = ownDataRecord(value, BUILDER_OPTIONS_KEYS, STATUS.inputInvalid);
  const evidenceRoot = safeAbsolutePath(source.evidenceRoot, STATUS.inputInvalid);
  const handoff = safePortableFilename(source.handoff, STATUS.inputInvalid);
  const output = safePortableFilename(source.output, STATUS.inputInvalid);
  if (typeof source.certificateSubjectSha256 !== "string"
      || !SHA256_PATTERN.test(source.certificateSubjectSha256)) {
    fail(STATUS.inputInvalid);
  }
  if (handoff.toLowerCase() === output.toLowerCase()) fail(STATUS.inputInvalid);
  return Object.freeze({
    evidenceRoot,
    handoff,
    output,
    certificateSubjectSha256: source.certificateSubjectSha256,
  });
}

function normalizeDependencies(dependencies = {}) {
  rejectProxy(dependencies, STATUS.inputInvalid);
  if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    fail(STATUS.inputInvalid);
  }
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(dependencies);
  } catch {
    fail(STATUS.inputInvalid);
  }
  const read = (key) => {
    const descriptor = descriptors[key];
    if (descriptor !== undefined
        && (!Object.hasOwn(descriptor, "value")
          || descriptor.get !== undefined
          || descriptor.set !== undefined
          || descriptor.enumerable !== true)) {
      fail(STATUS.inputInvalid);
    }
    return descriptor?.value;
  };
  const testOnlyFault = read("testOnlyFault");
  const expectedStagingRoot = safeAbsolutePath(
    read("expectedStagingRoot") ?? WINDOWS_NATIVE_PRESIGN_STAGING_ROOT,
    STATUS.inputInvalid,
  );
  const expectedReceiptRoot = safeAbsolutePath(
    read("expectedReceiptRoot") ?? WINDOWS_NATIVE_PRESIGN_RECEIPT_ROOT,
    STATUS.inputInvalid,
  );
  const expectedPackageJsonPath = safeAbsolutePath(
    read("expectedPackageJsonPath") ?? WINDOWS_NATIVE_PRESIGN_INPUT_PACKAGE_JSON_PATH,
    STATUS.inputInvalid,
  );
  assertOutside(expectedStagingRoot, expectedReceiptRoot, STATUS.evidenceRootInvalid);
  return Object.freeze({
    expectedStagingRoot,
    expectedReceiptRoot,
    expectedPackageJsonPath,
    testOnlyFault,
  });
}

/**
 * Read the reviewed offline subjects, bind them to the staged files, and
 * produce the exact options object accepted by windows-native-presign.mjs.
 */
export async function buildWindowsNativePresignInput(value, dependencies = {}) {
  const options = validateWindowsNativePresignInputBuilderOptions(value);
  const roots = normalizeDependencies(dependencies);
  if (options.evidenceRoot !== roots.expectedReceiptRoot) fail(STATUS.evidenceRootInvalid);
  assertOutside(roots.expectedStagingRoot, options.evidenceRoot, STATUS.evidenceRootInvalid);
  const evidenceState = await captureOwnedRoot(options.evidenceRoot, STATUS.evidenceRootInvalid);
  const stagingState = await captureOwnedRoot(roots.expectedStagingRoot, STATUS.stagingInvalid);
  await requireAbsent(join(options.evidenceRoot, options.output), STATUS.outputExists, STATUS.outputInvalid);
  await requireAbsent(`${join(options.evidenceRoot, options.output)}.tmp`, STATUS.outputExists, STATUS.outputInvalid);
  await assertOwnedRoot(evidenceState, STATUS.evidenceRootInvalid);
  await assertOwnedRoot(stagingState, STATUS.stagingInvalid);

  const handoffPath = join(options.evidenceRoot, options.handoff);
  const outputPath = join(options.evidenceRoot, options.output);
  const handoffRaw = await captureRegularFile(handoffPath, MAXIMUM_HANDOFF_BYTES, STATUS.handoffInvalid);
  const packageRaw = await captureRegularFile(roots.expectedPackageJsonPath, MAXIMUM_PACKAGE_BYTES, STATUS.packageInvalid);
  const runtimePath = join(roots.expectedStagingRoot, RUNTIME_MANIFEST_FILE);
  const runtimeRaw = await captureRegularFile(runtimePath, MAXIMUM_RUNTIME_MANIFEST_BYTES, STATUS.runtimeInvalid);
  const handoff = validateHandoff(handoffRaw.bytes);
  const packageInfo = validatePackage(packageRaw.bytes, STATUS.packageInvalid);
  const runtimeVersion = parseJsonBytes(runtimeRaw.bytes, {
    maximumBytes: MAXIMUM_RUNTIME_MANIFEST_BYTES,
    invalidCode: STATUS.runtimeInvalid,
    duplicateCode: STATUS.duplicateJsonKey,
  });
  if (runtimeVersion.releaseVersion !== packageInfo.version) fail(STATUS.packageInvalid);
  const stagedPackagePath = join(roots.expectedStagingRoot, "package.json");
  const stagedPackageRaw = await captureRegularFile(stagedPackagePath, MAXIMUM_PACKAGE_BYTES, STATUS.stagingInvalid);
  const stagedPackage = validatePackage(stagedPackageRaw.bytes, STATUS.stagingInvalid);
  if (stagedPackage.version !== packageInfo.version) fail(STATUS.stagingInvalid);
  const expectedStagedPackage = canonicalElectronBuilderPackageJsonBytes(
    "package.json",
    stagedPackageRaw.bytes,
    {
      packageVersion: packageInfo.version,
      profile: "windows-production",
    },
  );
  if (!expectedStagedPackage.equals(stagedPackageRaw.bytes)) fail(STATUS.stagingInvalid);
  const runtime = validateRuntimeManifest(runtimeRaw.bytes, packageInfo.version);
  const actual = await inventoryStaging(roots.expectedStagingRoot);
  const actualMap = validateStagedInventory(runtime, actual);
  const bindingRow = actualMap.get(WINDOWS_BINDING_PATH);
  const keytarRow = actualMap.get(KEYTAR_PATH);
  if (!bindingRow
      || bindingRow.bytes !== handoff.binding.bytes
      || bindingRow.sha256 !== handoff.binding.sha256
      || !keytarRow
      || keytarRow.sha256 !== WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256) {
    fail(STATUS.nativeInvalid);
  }
  if (roots.testOnlyFault === "mutate-runtime-after-inventory") {
    await mutateRuntimeManifestForTest(runtimePath, STATUS.runtimeInvalid);
  }
  const runtimeAfterInventory = await captureRegularFile(
    runtimePath,
    MAXIMUM_RUNTIME_MANIFEST_BYTES,
    STATUS.runtimeInvalid,
  );
  if (!sameCapturedFile(runtimeRaw, runtimeAfterInventory)) fail(STATUS.runtimeInvalid);
  const input = buildInput({
    handoff,
    handoffSha256: handoffRaw.sha256,
    packageVersion: packageInfo.version,
    stagingRoot: roots.expectedStagingRoot,
    receiptRoot: roots.expectedReceiptRoot,
    binding: handoff.binding,
    certificateSubjectSha256: options.certificateSubjectSha256,
  });
  await assertOwnedRoot(evidenceState, STATUS.evidenceRootInvalid);
  await assertOwnedRoot(stagingState, STATUS.stagingInvalid);
  const result = Object.freeze({
    outputPath,
    input,
    status: WINDOWS_NATIVE_PRESIGN_INPUT_STATUS,
  });
  BUILD_METADATA.set(result, Object.freeze({
    evidenceState,
    stagingState,
    runtimePath,
    runtimeSnapshot: runtimeRaw,
  }));
  return result;
}

export async function writeWindowsNativePresignInput(value, dependencies = {}) {
  const selected = await buildWindowsNativePresignInput(value, dependencies);
  const roots = normalizeDependencies(dependencies);
  const metadata = BUILD_METADATA.get(selected);
  if (!metadata) fail(STATUS.outputInvalid);
  const serialized = serializeWindowsNativePresignInput(selected.input, {
    expectedStagingRoot: roots.expectedStagingRoot,
    expectedReceiptRoot: roots.expectedReceiptRoot,
  });
  const temporaryPath = `${selected.outputPath}.tmp`;
  let handle;
  let temporaryCreated = false;
  let published = false;
  const fault = roots.testOnlyFault;
  if (fault !== undefined && !TEST_FAULT_POINTS.has(fault)) fail(STATUS.inputInvalid);
  try {
    if (fault === "replace-evidence-before-temp") {
      await replaceEvidenceRootForTest(metadata.evidenceState.path, STATUS.evidenceRootInvalid);
    }
    await assertOwnedRoot(metadata.stagingState, STATUS.stagingInvalid);
    const runtimeBeforePublication = await captureRegularFile(
      metadata.runtimePath,
      MAXIMUM_RUNTIME_MANIFEST_BYTES,
      STATUS.runtimeInvalid,
    );
    if (!sameCapturedFile(metadata.runtimeSnapshot, runtimeBeforePublication)) {
      fail(STATUS.runtimeInvalid);
    }
    await assertOwnedRoot(metadata.evidenceState, STATUS.evidenceRootInvalid);
    await assertOwnedRoot(metadata.stagingState, STATUS.stagingInvalid);
    handle = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    if (fault === "after-temp-open") fail(STATUS.outputInvalid);
    await handle.writeFile(serialized, "utf8");
    if (fault === "after-temp-write") fail(STATUS.outputInvalid);
    await handle.sync();
    if (fault === "after-temp-sync") fail(STATUS.outputInvalid);
    await handle.close();
    handle = null;
    if (fault === "mutate-runtime-before-publication") {
      await mutateRuntimeManifestForTest(metadata.runtimePath, STATUS.runtimeInvalid);
    }
    if (fault === "replace-evidence-before-publication") {
      await replaceEvidenceRootForTest(metadata.evidenceState.path, STATUS.evidenceRootInvalid);
    }
    const runtimeAtPublication = await captureRegularFile(
      metadata.runtimePath,
      MAXIMUM_RUNTIME_MANIFEST_BYTES,
      STATUS.runtimeInvalid,
    );
    if (!sameCapturedFile(metadata.runtimeSnapshot, runtimeAtPublication)) {
      fail(STATUS.runtimeInvalid);
    }
    await assertOwnedRoot(metadata.evidenceState, STATUS.evidenceRootInvalid);
    await assertOwnedRoot(metadata.stagingState, STATUS.stagingInvalid);
    if (fault === "before-publish") fail(STATUS.outputInvalid);
    await link(temporaryPath, selected.outputPath);
    published = true;
    await unlink(temporaryPath);
    temporaryCreated = false;
  } catch (error) {
    if (error?.code === "EEXIST" && !published) fail(STATUS.outputExists);
    if (error instanceof WindowsNativePresignInputBuilderError) {
      if (temporaryCreated
          && !published
          && error.code === STATUS.evidenceRootInvalid) {
        fail(STATUS.attemptCleanupRequired, { requiresAttemptCleanup: true });
      }
      throw error;
    }
    fail(STATUS.outputInvalid);
  } finally {
    await handle?.close().catch(() => {});
    if (temporaryCreated && !published) await unlink(temporaryPath).catch(() => {});
  }
  return selected;
}

function parseOptionsJson(bytes) {
  return parseJsonBytes(bytes, {
    maximumBytes: 64 * 1024,
    invalidCode: STATUS.inputInvalid,
    duplicateCode: STATUS.duplicateJsonKey,
  });
}

export function parseWindowsNativePresignInputBuilderArguments(argv) {
  if (!Array.isArray(argv)) fail(STATUS.inputInvalid);
  const selected = {
    evidenceRoot: null,
    handoff: null,
    output: null,
    certificateSubjectSha256: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const field = CLI_FLAGS.get(argv[index]);
    if (!field || selected[field] !== null) fail(STATUS.inputInvalid);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) fail(STATUS.inputInvalid);
    selected[field] = value;
    index += 1;
  }
  if (Object.values(selected).some((value) => value === null)) fail(STATUS.inputMissing);
  return validateWindowsNativePresignInputBuilderOptions(selected);
}

async function readInputOptionsFile(path) {
  safeAbsolutePath(path, STATUS.inputInvalid);
  const raw = await captureRegularFile(path, 64 * 1024, STATUS.inputInvalid);
  return parseOptionsJson(raw.bytes);
}

export async function runWindowsNativePresignInputBuilder(value, dependencies = {}) {
  return writeWindowsNativePresignInput(value, dependencies);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    if (argv[0] === "--options") {
      if (argv.length !== 2 || typeof argv[1] !== "string") fail(STATUS.inputInvalid);
      const optionsPath = safeAbsolutePath(argv[1], STATUS.inputInvalid);
      const rawOptions = await readInputOptionsFile(optionsPath);
      const options = validateWindowsNativePresignInputBuilderOptions(rawOptions);
      if (dirname(optionsPath) !== options.evidenceRoot) fail(STATUS.inputInvalid);
      await writeWindowsNativePresignInput(options);
    } else {
      const options = parseWindowsNativePresignInputBuilderArguments(argv);
      await writeWindowsNativePresignInput(options);
    }
    process.stdout.write(`${WINDOWS_NATIVE_PRESIGN_INPUT_STATUS}\n`);
  } catch (error) {
    const status = error instanceof WindowsNativePresignInputBuilderError
      && KNOWN_STATUSES.has(error.code)
      ? error.code
      : STATUS.inputInvalid;
    process.stdout.write(`${status}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  await main();
}
