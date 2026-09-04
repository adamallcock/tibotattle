#!/usr/bin/env node

/**
 * Verify an unsigned, directory-only Electron development artifact without
 * emitting its paths or file contents.
 *
 * The caller must provide all three physical artifact locations explicitly:
 * the staged app tree, app.asar, and app.asar.unpacked.  This is intentional:
 * a CI job must not accidentally verify a different local build.  The staged
 * runtime manifest is the source of truth for the reviewed file closure; the
 * verifier compares that closure byte-for-byte with the archive/unpacked
 * union and checks the target-specific native boundary.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { constants as fileSystemConstants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
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
  KEYTAR_WIN32_X64_SHA256,
} from "../src/platform/windows-credential-manager-probe.js";
import {
  transformElectronBuilderPackageJsonBytes,
} from "./lib/electron-builder-package-json.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);

const RUNTIME_MANIFEST_FILE = "electron-runtime-manifest.json";
const RUNTIME_MANIFEST_SCHEMA = "usage-monitor-electron-runtime-v0.1";
const WINDOWS_BINDING_PATH =
  "native/windows-filesystem/build/Release/windows_filesystem.node";
const WINDOWS_BINDING_MANIFEST_PATH = `${WINDOWS_BINDING_PATH}.manifest.json`;
const TARGETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    manifestTarget: "darwin",
    architecture: "arm64",
    keytar: "node_modules/@github/keytar/prebuilds/darwin-arm64/keytar.node",
  }),
  "win32-x64": Object.freeze({
    manifestTarget: "win32",
    architecture: "x64",
    keytar: "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node",
  }),
});
export const ELECTRON_SHELL_FILES = Object.freeze([
  "apps/electron/companion-supervisor.js",
  "apps/electron/desktop-command.js",
  "apps/electron/desktop-contract.js",
  "apps/electron/desktop-codex-roots.js",
  "apps/electron/desktop-deep-links.js",
  "apps/electron/desktop-diagnostics.js",
  "apps/electron/desktop-controller.js",
  "apps/electron/desktop-copy.js",
  "apps/electron/desktop-first-run.js",
  "apps/electron/desktop-first-run-login.js",
  "apps/electron/desktop-hosted-signin.js",
  "apps/electron/desktop-recovery-settings.js",
  "apps/electron/desktop-ipc.js",
  "apps/electron/desktop-owned-downloads.js",
  "apps/electron/desktop-menu.js",
  "apps/electron/desktop-lifecycle.js",
  "apps/electron/desktop-notification-coordinator.js",
  "apps/electron/desktop-notification-delivery.js",
  "apps/electron/desktop-notification-policy.js",
  "apps/electron/desktop-platform-services.js",
  "apps/electron/desktop-runtime.js",
  "apps/electron/desktop-settings-backends.js",
  "apps/electron/desktop-settings-store.js",
  "apps/electron/desktop-sharing.js",
  "apps/electron/desktop-sharing-installation.js",
  "apps/electron/desktop-tray.js",
  "apps/electron/desktop-status-monitor.js",
  "apps/electron/desktop-tray-status.js",
  "apps/electron/errors.js",
  "apps/electron/loopback-policy.js",
  "apps/electron/main.js",
  "apps/electron/platform-gate.js",
  "apps/electron/preload.cjs",
  "apps/electron/recovery-preload.cjs",
  "apps/electron/recovery-window.js",
  "apps/electron/ready-line.js",
  "apps/electron/windows-qualification.js",
  "config/deployment-endpoints.js",
  "src/desktop-shell-status.js",
  "src/platform/windows-credential-manager-probe.js",
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const INVENTORY_KINDS = new Set([
  "companion_source",
  "electron_shell",
  "dashboard_asset",
  "workspace_dependency",
  "third_party_dependency",
  "windows_native_binding",
  "runtime_metadata",
]);
const READ_ONLY_FLAG = fileSystemConstants.O_RDONLY ?? 0;
const NO_FOLLOW_FLAG = fileSystemConstants.O_NOFOLLOW ?? 0;
const UNSUPPORTED_NO_FOLLOW_CODES = new Set([
  "EINVAL",
  "ENOTSUP",
  "EOPNOTSUPP",
  "UNKNOWN",
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
const WINDOWS_NATIVE_CLAIM_KEYS = Object.freeze([
  "productionSafe",
  "pathWalkRaceSafe",
  "credentialMutexSafe",
  "companionInstanceMutexSafe",
  "credentialAuditFileGuardSafe",
  "sqliteStateLeaseSafe",
  "preparedArtifactSafe",
]);
const WINDOWS_APPROVED_POLICY_KEYS = WINDOWS_NATIVE_CLAIM_KEYS;
const MAXIMUM_WINDOWS_BINDING_BYTES = 64 * 1024 * 1024;

/** Fixed strings are safe to expose from CI logs and errors. */
export const FIXED_STATUS = Object.freeze({
  verified: "ELECTRON_DEVELOPMENT_ARTIFACT_VERIFIED",
  failed: "ELECTRON_DEVELOPMENT_ARTIFACT_FAILED",
  targetInvalid: "ELECTRON_DEVELOPMENT_ARTIFACT_TARGET_INVALID",
  inputInvalid: "ELECTRON_DEVELOPMENT_ARTIFACT_INPUT_INVALID",
  inputMissing: "ELECTRON_DEVELOPMENT_ARTIFACT_INPUT_MISSING",
  asarUnavailable: "ELECTRON_DEVELOPMENT_ARTIFACT_ASAR_UNAVAILABLE",
  stagedManifestInvalid: "ELECTRON_DEVELOPMENT_ARTIFACT_STAGED_MANIFEST_INVALID",
  stagedInventoryInvalid: "ELECTRON_DEVELOPMENT_ARTIFACT_STAGED_INVENTORY_INVALID",
  archiveInvalid: "ELECTRON_DEVELOPMENT_ARTIFACT_ARCHIVE_INVALID",
  inventoryMismatch: "ELECTRON_DEVELOPMENT_ARTIFACT_INVENTORY_MISMATCH",
  nativeInventoryInvalid: "ELECTRON_DEVELOPMENT_ARTIFACT_NATIVE_INVENTORY_INVALID",
  bindingInvalid: "ELECTRON_DEVELOPMENT_ARTIFACT_WINDOWS_BINDING_INVALID",
});

const KNOWN_STATUSES = new Set(Object.values(FIXED_STATUS));
const FAILURE_STATUSES = new Set(
  Object.values(FIXED_STATUS).filter((status) => status !== FIXED_STATUS.verified),
);

/**
 * Parse the verifier's failure stream without returning any caller-provided
 * text.  The CLI deliberately emits one fixed status token on stderr when it
 * rejects an artifact; callers which retain that stream must still treat it
 * as untrusted until it has passed this allowlist.
 */
export function parseFixedStatusOutput(value) {
  if (typeof value !== "string") return FIXED_STATUS.failed;
  const lines = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1 || !FAILURE_STATUSES.has(lines[0])) {
    return FIXED_STATUS.failed;
  }
  return lines[0];
}

function fixedError(status) {
  const error = new Error(status);
  error.code = status;
  return error;
}

function fail(status) {
  throw fixedError(status);
}

function comparePathBytes(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function exactObjectKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort(comparePathBytes))
      === JSON.stringify([...keys].sort(comparePathBytes));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(comparePathBytes)
      .map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeRelativePath(value, status) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\\")
      || value.includes("\0")
      || isAbsolute(value)) {
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
    fail(FIXED_STATUS.inputInvalid);
  }
  try {
    return resolve(value);
  } catch {
    fail(FIXED_STATUS.inputInvalid);
  }
}

function loadAsar() {
  try {
    // electron-builder already owns @electron/asar in this repository.  Use
    // its resolver rather than making the verifier add a second dependency.
    const builderEntry = require.resolve("electron-builder");
    const builderRequire = createRequire(builderEntry);
    const loaded = builderRequire("@electron/asar");
    return loaded?.default ?? loaded;
  } catch {
    fail(FIXED_STATUS.asarUnavailable);
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
  ].map((value) => String(value)).join("\0");
}

function isUnsupportedNoFollowError(error) {
  return UNSUPPORTED_NO_FOLLOW_CODES.has(error?.code);
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
      // macOS exposes /var as a compatibility symlink to /private/var.
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

async function assertRealpathContained(root, path, status) {
  let rootRealpath;
  let pathRealpath;
  try {
    [rootRealpath, pathRealpath] = await Promise.all([
      realpath(root),
      realpath(path),
    ]);
  } catch {
    fail(status);
  }
  if (!pathIsInside(rootRealpath, pathRealpath)) fail(status);
}

async function assertDirectory(path) {
  await assertNoSymlinkPathComponents(path, FIXED_STATUS.inputInvalid);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") fail(FIXED_STATUS.inputMissing);
    fail(FIXED_STATUS.inputInvalid);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(FIXED_STATUS.inputInvalid);
  }
}

async function assertRegularFile(path, missingStatus = FIXED_STATUS.inputMissing) {
  await assertNoSymlinkPathComponents(path, missingStatus);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") fail(missingStatus);
    fail(FIXED_STATUS.inputInvalid);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(FIXED_STATUS.inputInvalid);
  }
}

/**
 * Read a regular file from an opened descriptor. O_NOFOLLOW protects the
 * final component where supported; Windows falls back to lstat identity
 * checks when that flag is unavailable. Realpath containment is checked
 * before and after the descriptor-bound read for staged files. Ancestor
 * TOCTOU protection assumes the GitHub Actions checkout and artifact tree are
 * immutable and have no concurrent writer; this bounded verifier deliberately
 * does not implement a handle-relative directory walker.
 */
async function readRegularFile(
  path,
  missingStatus = FIXED_STATUS.inputMissing,
  containmentRoot = null,
) {
  let handle;
  let usedWindowsFallback = false;
  let fallbackBeforeFingerprint = null;
  try {
    await assertNoSymlinkPathComponents(path, missingStatus);
    if (containmentRoot !== null) {
      await assertNoSymlinkPathComponents(containmentRoot, missingStatus);
      await assertRealpathContained(containmentRoot, path, missingStatus);
    }
    try {
      handle = await open(path, READ_ONLY_FLAG | NO_FOLLOW_FLAG);
    } catch (error) {
      if (!(process.platform === "win32"
          && (NO_FOLLOW_FLAG === 0 || isUnsupportedNoFollowError(error)))) {
        if (error?.code === "ENOENT") fail(missingStatus);
        throw error;
      }
      let beforePath;
      try {
        beforePath = await lstat(path);
      } catch (pathError) {
        if (pathError?.code === "ENOENT") fail(missingStatus);
        throw pathError;
      }
      if (beforePath.isSymbolicLink() || !beforePath.isFile()) {
        fail(FIXED_STATUS.inputInvalid);
      }
      fallbackBeforeFingerprint = statFingerprint(beforePath);
      handle = await open(path, READ_ONLY_FLAG);
      usedWindowsFallback = true;
    }
    const before = await handle.stat();
    if (!before.isFile()) fail(FIXED_STATUS.inputInvalid);
    if (fallbackBeforeFingerprint !== null
        && fallbackBeforeFingerprint !== statFingerprint(before)) {
      fail(FIXED_STATUS.inputInvalid);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (statFingerprint(before) !== statFingerprint(after)
        || after.size !== bytes.byteLength) {
      fail(FIXED_STATUS.inputInvalid);
    }
    if (usedWindowsFallback) {
      let afterPath;
      try {
        afterPath = await lstat(path);
      } catch (pathError) {
        if (pathError?.code === "ENOENT") fail(missingStatus);
        throw pathError;
      }
      if (afterPath.isSymbolicLink()
          || statFingerprint(afterPath) !== statFingerprint(after)) {
        fail(FIXED_STATUS.inputInvalid);
      }
    }
    if (containmentRoot !== null) {
      await assertRealpathContained(containmentRoot, path, missingStatus);
    }
    return Buffer.from(bytes);
  } catch (error) {
    if (KNOWN_STATUSES.has(error?.code)) throw error;
    if (error?.code === "ENOENT") fail(missingStatus);
    fail(FIXED_STATUS.inputInvalid);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function walkFiles(root) {
  await assertNoSymlinkPathComponents(root, FIXED_STATUS.inputInvalid);
  const rows = [];

  async function walk(current, prefix) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      fail(FIXED_STATUS.inputInvalid);
    }
    entries.sort((left, right) => comparePathBytes(left.name, right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      const relativePath = prefix === ""
        ? entry.name
        : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) fail(FIXED_STATUS.inputInvalid);
      if (entry.isDirectory()) {
        await walk(path, relativePath);
        continue;
      }
      if (!entry.isFile()) fail(FIXED_STATUS.inputInvalid);
      const normalized = normalizeRelativePath(
        relativePath.split(sep).join("/"),
        FIXED_STATUS.stagedInventoryInvalid,
      );
      const bytes = await readRegularFile(
        path,
        FIXED_STATUS.stagedInventoryInvalid,
        root,
      );
      rows.push({
        bytes: bytes.byteLength,
        path: normalized,
        sha256: sha256(bytes),
      });
    }
  }

  await walk(root, "");
  rows.sort((left, right) => comparePathBytes(left.path, right.path));
  return rows;
}

function rowsByPath(rows) {
  const result = new Map();
  for (const row of rows) {
    if (result.has(row.path)) fail(FIXED_STATUS.inventoryMismatch);
    result.set(row.path, row);
  }
  return result;
}

function inventoryDigest(rows) {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const row of [...rows].sort((left, right) => comparePathBytes(left.path, right.path))) {
    bytes += row.bytes;
    hash.update(`F\0${row.path}\0${row.bytes}\0${row.sha256}\0`);
  }
  return Object.freeze({
    count: rows.length,
    bytes,
    sha256: hash.digest("hex"),
  });
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

function assertContentFree(value, status = FIXED_STATUS.stagedManifestInvalid) {
  if (typeof value === "string") {
    if (value.includes("\0")
        || isAbsolute(value)
        || /^[A-Za-z]:[\\/]/u.test(value)
        || value.startsWith("\\\\")) {
      fail(status);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) assertContentFree(child, status);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assertContentFree(key, status);
      assertContentFree(child, status);
    }
  }
}

function validateManifestRow(row, previousPath, seen) {
  if (!exactObjectKeys(row, ["bytes", "kind", "path", "sha256"])) {
    fail(FIXED_STATUS.stagedManifestInvalid);
  }
  const path = normalizeRelativePath(row.path, FIXED_STATUS.stagedManifestInvalid);
  if (path === RUNTIME_MANIFEST_FILE
      || seen.has(path)
      || (previousPath !== null && comparePathBytes(previousPath, path) >= 0)
      || !Number.isSafeInteger(row.bytes)
      || row.bytes < 0
      || !INVENTORY_KINDS.has(row.kind)
      || !SHA256_PATTERN.test(row.sha256)) {
    fail(FIXED_STATUS.stagedManifestInvalid);
  }
  return path;
}

function validateNativeManifestShape(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(FIXED_STATUS.bindingInvalid);
  }
  assertContentFree(value, FIXED_STATUS.bindingInvalid);
  const nativeClaims = value.nativeClaims;
  const approvedPolicy = value.approvedPolicy;
  const bindingProvenance = value.bindingProvenance;
  const exactBooleanShape = (candidate, keys) =>
    exactObjectKeys(candidate, keys)
      && keys.every((key) => typeof candidate[key] === "boolean");
  if (!exactObjectKeys(value, WINDOWS_NATIVE_MANIFEST_KEYS)
      || value.schemaVersion !== "windows-filesystem-binding-manifest-v1"
      || value.bindingFile !== "windows_filesystem.node"
      || value.platform !== "win32"
      || value.architecture !== "x64"
      || !Number.isSafeInteger(value.bytes)
      || value.bytes <= 0
      || value.bytes > MAXIMUM_WINDOWS_BINDING_BYTES
      || !SHA256_PATTERN.test(value.sha256)
      || value.contractVersion !== "windows-filesystem-v1"
      || value.securityContractVersion !== "windows-filesystem-security-v1"
      || value.credentialAuditFileGuardContractVersion
        !== "windows-credential-audit-file-guard-v1"
      || value.sqliteStateLeaseContractVersion !== "windows-sqlite-state-lease-v1"
      || value.credentialMutexContractVersion !== "windows-credential-mutex-v1"
      || value.companionInstanceMutexContractVersion
        !== "windows-companion-instance-mutex-v1"
      || value.preparedArtifactContractVersion
        !== "windows-prepared-artifact-v1"
      || !Array.isArray(value.requiredMethods)
      || value.requiredMethods.length !== WINDOWS_REQUIRED_METHODS.length
      || value.requiredMethods.some((method, index) => method !== WINDOWS_REQUIRED_METHODS[index])
      || !exactBooleanShape(nativeClaims, WINDOWS_NATIVE_CLAIM_KEYS)
      || !exactBooleanShape(approvedPolicy, WINDOWS_APPROVED_POLICY_KEYS)
      || nativeClaims.productionSafe !== false
      || nativeClaims.pathWalkRaceSafe !== false
      || nativeClaims.credentialMutexSafe !== true
      || nativeClaims.companionInstanceMutexSafe !== false
      || nativeClaims.credentialAuditFileGuardSafe !== true
      || nativeClaims.sqliteStateLeaseSafe !== false
      || nativeClaims.preparedArtifactSafe !== false
      || approvedPolicy.productionSafe !== false
      || approvedPolicy.pathWalkRaceSafe !== false
      || approvedPolicy.credentialMutexSafe !== true
      || approvedPolicy.companionInstanceMutexSafe !== false
      || approvedPolicy.credentialAuditFileGuardSafe !== true
      || approvedPolicy.sqliteStateLeaseSafe !== false
      || approvedPolicy.preparedArtifactSafe !== false
      || WINDOWS_NATIVE_CLAIM_KEYS.some((key) => nativeClaims[key] !== approvedPolicy[key])
      || !exactObjectKeys(bindingProvenance, ["contractVersion", "source", "status"])
      || bindingProvenance.contractVersion !== "windows-binding-provenance-v1"
      || bindingProvenance.status !== "unqualified"
      || bindingProvenance.source !== "unsigned-development-binding") {
    fail(FIXED_STATUS.bindingInvalid);
  }
  return value;
}

function validateRuntimeManifest(manifest, target) {
  const targetSpec = TARGETS[target];
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail(FIXED_STATUS.stagedManifestInvalid);
  }
  assertContentFree(manifest);
  if (!exactObjectKeys(manifest, [
    "architecture", "dashboardRoot", "entrypoint", "files", "payload",
    "releaseVersion", "schemaVersion", "target", "windowsBinding",
  ])
      || manifest.schemaVersion !== RUNTIME_MANIFEST_SCHEMA
      || manifest.target !== targetSpec.manifestTarget
      || manifest.architecture !== targetSpec.architecture
      || typeof manifest.releaseVersion !== "string"
      || manifest.releaseVersion.length === 0
      || manifest.entrypoint !== "apps/electron/main.js"
      || manifest.dashboardRoot !== "apps/web/public"
      || !Array.isArray(manifest.files)
      || manifest.files.length === 0
      || !exactObjectKeys(manifest.payload, ["bytes", "sha256"])
      || !Number.isSafeInteger(manifest.payload.bytes)
      || manifest.payload.bytes < 0
      || !SHA256_PATTERN.test(manifest.payload.sha256)) {
    fail(FIXED_STATUS.stagedManifestInvalid);
  }

  const rows = [];
  const seen = new Set();
  let previousPath = null;
  for (const row of manifest.files) {
    const path = validateManifestRow(row, previousPath, seen);
    previousPath = path;
    seen.add(path);
    rows.push({
      bytes: row.bytes,
      kind: row.kind,
      path,
      sha256: row.sha256,
    });
  }
  if (!ELECTRON_SHELL_FILES.every((path) => seen.has(path))
      || !seen.has("package.json")
      || seen.has("test")
      || [...seen].some((path) => /(^|\/)(?:docs?|tests?)(?:\/|$)/iu.test(path))) {
    fail(FIXED_STATUS.stagedManifestInvalid);
  }

  const windowsBinding = manifest.windowsBinding;
  if (target === "darwin-arm64") {
    if (!exactObjectKeys(windowsBinding, ["included", "status", "verified"])
        || windowsBinding.included !== false
        || windowsBinding.status !== "not_requested"
        || windowsBinding.verified !== false) {
      fail(FIXED_STATUS.stagedManifestInvalid);
    }
  } else if (!exactObjectKeys(windowsBinding, [
    "binding", "included", "manifest", "status", "verified",
  ])
      || windowsBinding.included !== true
      || windowsBinding.status !== "included_unverified"
      || windowsBinding.verified !== false
      || !exactObjectKeys(windowsBinding.binding, ["bytes", "path", "sha256"])
      || !exactObjectKeys(windowsBinding.manifest, ["path"])
      || windowsBinding.binding.path !== WINDOWS_BINDING_PATH
      || windowsBinding.manifest.path !== WINDOWS_BINDING_MANIFEST_PATH
      || !Number.isSafeInteger(windowsBinding.binding.bytes)
      || windowsBinding.binding.bytes <= 0
      || !SHA256_PATTERN.test(windowsBinding.binding.sha256)) {
    fail(FIXED_STATUS.stagedManifestInvalid);
  }
  return Object.freeze({ manifest, rows, rowMap: rowsByPath(rows) });
}

async function readStagedManifest(appPath) {
  const manifestPath = join(appPath, RUNTIME_MANIFEST_FILE);
  const bytes = await readRegularFile(
    manifestPath,
    FIXED_STATUS.stagedManifestInvalid,
    appPath,
  );
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(FIXED_STATUS.stagedManifestInvalid);
  }
  return Object.freeze({ bytes, manifest });
}

async function validateStagedTree(appPath, target) {
  const manifestFile = await readStagedManifest(appPath);
  const validated = validateRuntimeManifest(manifestFile.manifest, target);
  const actualRows = await walkFiles(appPath);
  const actualMap = rowsByPath(actualRows);
  if (!actualMap.has(RUNTIME_MANIFEST_FILE)) {
    fail(FIXED_STATUS.stagedInventoryInvalid);
  }
  const actualRuntimeRow = actualMap.get(RUNTIME_MANIFEST_FILE);
  if (actualRuntimeRow.bytes !== manifestFile.bytes.byteLength
      || actualRuntimeRow.sha256 !== sha256(manifestFile.bytes)) {
    fail(FIXED_STATUS.stagedInventoryInvalid);
  }
  const expectedPaths = new Set([...validated.rowMap.keys(), RUNTIME_MANIFEST_FILE]);
  if (actualMap.size !== expectedPaths.size
      || [...actualMap.keys()].some((path) => !expectedPaths.has(path))) {
    fail(FIXED_STATUS.stagedInventoryInvalid);
  }
  for (const row of validated.rows) {
    const actual = actualMap.get(row.path);
    if (!actual || actual.bytes !== row.bytes || actual.sha256 !== row.sha256) {
      fail(FIXED_STATUS.stagedInventoryInvalid);
    }
  }
  const payload = payloadDigest(validated.rows);
  if (stableJson(payload) !== stableJson(manifestFile.manifest.payload)) {
    fail(FIXED_STATUS.stagedManifestInvalid);
  }

  const packageBytes = await readRegularFile(
    join(appPath, "package.json"),
    FIXED_STATUS.stagedInventoryInvalid,
    appPath,
  );
  let packageJson;
  try {
    packageJson = JSON.parse(packageBytes.toString("utf8"));
  } catch {
    fail(FIXED_STATUS.stagedInventoryInvalid);
  }
  if (packageJson?.main !== "apps/electron/main.js") {
    fail(FIXED_STATUS.stagedInventoryInvalid);
  }
  return Object.freeze({
    manifest: manifestFile.manifest,
    manifestBytes: manifestFile.bytes,
    rows: actualRows,
    rowMap: actualMap,
    runtimeRows: validated.rows,
  });
}

/**
 * Canonicalize one path returned by @electron/asar's listFiles implementation.
 *
 * listFiles starts at `/` and uses node:path.join for every child.  That means
 * its rooted output uses `/` on POSIX and `\\` on Windows.  The verifier keeps
 * inventory keys platform-neutral, but must not silently accept a path that
 * the library itself could not have emitted for the selected platform.
 */
export function normalizeArchivePath(raw, platform = process.platform) {
  const nativeSeparator = platform === "win32" ? "\\" : "/";
  const foreignSeparator = nativeSeparator === "/" ? "\\" : "/";
  if (typeof raw !== "string"
      || raw.length <= 1
      || raw.includes("\0")
      || raw[0] !== nativeSeparator
      || raw.includes(foreignSeparator)) {
    fail(FIXED_STATUS.archiveInvalid);
  }

  const parts = raw.slice(1).split(nativeSeparator);
  if (parts.some((part) => part.length === 0
      || part === "."
      || part === ".."
      // A drive-relative or drive-absolute component is never an ASAR entry.
      || /^[A-Za-z]:/u.test(part))) {
    fail(FIXED_STATUS.archiveInvalid);
  }

  // Keep this explicit equality as a guard against accepting an alternate
  // spelling that path normalization would otherwise collapse.
  if (`${nativeSeparator}${parts.join(nativeSeparator)}` !== raw) {
    fail(FIXED_STATUS.archiveInvalid);
  }
  return parts.join("/");
}

function archiveLookupPath(canonicalPath, platform = process.platform) {
  return platform === "win32"
    ? canonicalPath.replaceAll("/", "\\")
    : canonicalPath;
}

function isArchiveDirectory(stat) {
  return stat !== null
    && typeof stat === "object"
    && !Array.isArray(stat)
    && stat.files !== undefined;
}

async function readArchive(asarPath) {
  const asar = loadAsar();
  let listed;
  try {
    listed = asar.listPackage(asarPath);
  } catch {
    fail(FIXED_STATUS.archiveInvalid);
  }
  if (!Array.isArray(listed)) fail(FIXED_STATUS.archiveInvalid);
  const rows = [];
  const markedUnpacked = new Set();
  const seen = new Set();
  for (const rawPath of listed) {
    const path = normalizeArchivePath(rawPath);
    const lookupPath = archiveLookupPath(path);
    if (seen.has(path)) fail(FIXED_STATUS.archiveInvalid);
    let stat;
    try {
      stat = asar.statFile(asarPath, lookupPath);
    } catch {
      fail(FIXED_STATUS.archiveInvalid);
    }
    if (isArchiveDirectory(stat)) continue;
    if (stat?.link !== undefined
        || !Number.isSafeInteger(stat?.size)
        || stat.size < 0) {
      fail(FIXED_STATUS.archiveInvalid);
    }
    // electron-builder records asarUnpack entries in the archive header with
    // `unpacked: true`. They are represented by the physical
    // app.asar.unpacked tree, not by app.asar's byte payload. Validate their
    // path and size above, then let the unpacked inventory verify their bytes.
    if (stat.unpacked === true) {
      markedUnpacked.add(path);
      seen.add(path);
      continue;
    }
    let bytes;
    try {
      bytes = asar.extractFile(asarPath, lookupPath);
    } catch {
      fail(FIXED_STATUS.archiveInvalid);
    }
    if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)
        || bytes.byteLength !== stat.size) {
      fail(FIXED_STATUS.archiveInvalid);
    }
    seen.add(path);
    rows.push({
      bytes: bytes.byteLength,
      path,
      sha256: sha256(bytes),
    });
  }
  rows.sort((left, right) => comparePathBytes(left.path, right.path));
  return Object.freeze({
    markedUnpacked,
    rows,
  });
}

function expectedNativePaths(target) {
  const targetSpec = TARGETS[target];
  return new Set([
    targetSpec.keytar,
    ...(target === "win32-x64" ? [WINDOWS_BINDING_PATH] : []),
  ]);
}

/**
 * The Windows development artifact may only ship the audited keytar
 * prebuild. The staged inventory has already been read and hashed from the
 * exact app tree, so checking its row here covers both the staged source and
 * (via compareArtifactToStaged) the archive/unpacked union without reading or
 * logging credential-binding bytes a second time. The existing bindingInvalid
 * status intentionally covers any native binding integrity failure.
 */
function validateWindowsKeytar({ target, staged }) {
  if (target !== "win32-x64") return;
  const keytarRow = staged.rowMap.get(TARGETS[target].keytar);
  if (!keytarRow || keytarRow.sha256 !== KEYTAR_WIN32_X64_SHA256) {
    fail(FIXED_STATUS.bindingInvalid);
  }
}

// Electron's virtual-ASAR contract intentionally separates the executable
// native module from its content-free sidecar: the .node is unpacked so the
// loader can execute it, while the adjacent JSON manifest remains readable
// through the virtual app.asar path. Keep this arrangement unless the actual
// runtime/package contract changes and is reviewed with it.
function validateNativeBoundary({
  target,
  staged,
  archive,
  archiveMarkedUnpacked,
  unpacked,
  manifest,
}) {
  const expected = expectedNativePaths(target);
  const stagedNative = staged.runtimeRows
    .filter(({ path }) => path.toLowerCase().endsWith(".node"))
    .map(({ path }) => path);
  if (new Set(stagedNative).size !== expected.size
      || stagedNative.some((path) => !expected.has(path))) {
    fail(FIXED_STATUS.nativeInventoryInvalid);
  }

  const archiveNative = archive
    .filter(({ path }) => path.toLowerCase().endsWith(".node"));
  const unpackedNative = unpacked
    .filter(({ path }) => path.toLowerCase().endsWith(".node"));
  if (unpacked.length !== expected.size
      || unpacked.some(({ path }) => !expected.has(path))) {
    fail(FIXED_STATUS.nativeInventoryInvalid);
  }
  const physicalUnpackedPaths = new Set(unpacked.map(({ path }) => path));
  if (archiveMarkedUnpacked.size !== physicalUnpackedPaths.size
      || [...archiveMarkedUnpacked].some((path) => !physicalUnpackedPaths.has(path))) {
    fail(FIXED_STATUS.nativeInventoryInvalid);
  }
  for (const path of expected) {
    if (!archiveMarkedUnpacked.has(path)) {
      fail(FIXED_STATUS.nativeInventoryInvalid);
    }
  }
  const actualNative = [...archiveNative, ...unpackedNative];
  if (actualNative.length !== expected.size
      || actualNative.some(({ path }) => !expected.has(path))) {
    fail(FIXED_STATUS.nativeInventoryInvalid);
  }
  const archiveMap = rowsByPath(archive);
  const unpackedMap = rowsByPath(unpacked);
  for (const path of expected) {
    if (archiveMap.has(path) || !unpackedMap.has(path)) {
      fail(FIXED_STATUS.nativeInventoryInvalid);
    }
  }
  if (target === "darwin-arm64") {
    if (manifest.windowsBinding.included !== false) {
      fail(FIXED_STATUS.nativeInventoryInvalid);
    }
  } else {
    // The sidecar is intentionally not an unpacked native file: it must stay
    // in app.asar so the Electron runtime can read it through its virtual
    // adjacent path while the .node remains executable from app.asar.unpacked.
    if (!archiveMap.has(WINDOWS_BINDING_MANIFEST_PATH)
        || unpackedMap.has(WINDOWS_BINDING_MANIFEST_PATH)) {
      fail(FIXED_STATUS.nativeInventoryInvalid);
    }
    if (manifest.windowsBinding.binding.sha256
        !== staged.rowMap.get(WINDOWS_BINDING_PATH)?.sha256) {
      fail(FIXED_STATUS.bindingInvalid);
    }
  }
}

async function validateWindowsBinding({ appPath, staged }) {
  const bindingRow = staged.rowMap.get(WINDOWS_BINDING_PATH);
  const sidecarRow = staged.rowMap.get(WINDOWS_BINDING_MANIFEST_PATH);
  if (!bindingRow || !sidecarRow) fail(FIXED_STATUS.bindingInvalid);
  const bindingBytes = await readRegularFile(
    join(appPath, ...WINDOWS_BINDING_PATH.split("/")),
    FIXED_STATUS.bindingInvalid,
    appPath,
  );
  const sidecarBytes = await readRegularFile(
    join(appPath, ...WINDOWS_BINDING_MANIFEST_PATH.split("/")),
    FIXED_STATUS.bindingInvalid,
    appPath,
  );
  if (bindingBytes.byteLength !== bindingRow.bytes
      || sha256(bindingBytes) !== bindingRow.sha256
      || sidecarBytes.byteLength !== sidecarRow.bytes
      || sha256(sidecarBytes) !== sidecarRow.sha256) {
    fail(FIXED_STATUS.bindingInvalid);
  }
  let sidecar;
  try {
    sidecar = JSON.parse(sidecarBytes.toString("utf8"));
  } catch {
    fail(FIXED_STATUS.bindingInvalid);
  }
  validateNativeManifestShape(sidecar);
  if (sidecar.bytes !== bindingBytes.byteLength
      || sidecar.sha256 !== sha256(bindingBytes)) {
    fail(FIXED_STATUS.bindingInvalid);
  }
  const runtimeBinding = staged.manifest.windowsBinding.binding;
  if (runtimeBinding.bytes !== bindingBytes.byteLength
      || runtimeBinding.sha256 !== sha256(bindingBytes)) {
    fail(FIXED_STATUS.bindingInvalid);
  }
  return Object.freeze({ bytes: bindingBytes.byteLength, sha256: sha256(bindingBytes) });
}

async function compareArtifactToStaged({ appPath, staged, archive, unpacked }) {
  const artifactRows = [...archive, ...unpacked];
  const artifactMap = rowsByPath(artifactRows);
  const expected = new Set(staged.rows.map(({ path }) => path));
  if (artifactMap.size !== expected.size
      || [...artifactMap.keys()].some((path) => !expected.has(path))) {
    fail(FIXED_STATUS.inventoryMismatch);
  }
  for (const row of staged.rows) {
    const artifact = artifactMap.get(row.path);
    if (!artifact) {
      fail(FIXED_STATUS.inventoryMismatch);
    }
    if (artifact.bytes === row.bytes && artifact.sha256 === row.sha256) continue;
    const sourceBytes = await readRegularFile(
      join(appPath, ...row.path.split("/")),
      FIXED_STATUS.stagedInventoryInvalid,
      appPath,
    );
    const transformed = transformElectronBuilderPackageJsonBytes(row.path, sourceBytes, {
      packageVersion: staged.manifest.releaseVersion,
      profile: "development",
    });
    if (transformed === null
        || transformed.byteLength !== artifact.bytes
        || sha256(transformed) !== artifact.sha256) {
      fail(FIXED_STATUS.inventoryMismatch);
    }
  }
  return artifactRows;
}

function summarizeBinding(target, binding) {
  if (target === "darwin-arm64") {
    return Object.freeze({ status: "not_applicable", bytes: 0, sha256: "0".repeat(64) });
  }
  return Object.freeze({
    status: "included_unverified",
    bytes: binding.bytes,
    sha256: binding.sha256,
  });
}

/**
 * Verify one exact staged app and one exact packaged archive/unpacked pair.
 * The returned object contains aggregate counts, byte totals, digests, and
 * fixed status values only; it never returns a caller-provided path.
 */
export async function verifyElectronDevelopmentArtifact({
  target,
  appPath,
  asarPath,
  unpackedPath,
} = {}) {
  if (!Object.hasOwn(TARGETS, target)) fail(FIXED_STATUS.targetInvalid);
  const selectedAppPath = normalizeInputPath(appPath);
  const selectedAsarPath = normalizeInputPath(asarPath);
  const selectedUnpackedPath = normalizeInputPath(unpackedPath);
  try {
    await assertDirectory(selectedAppPath);
    await assertRegularFile(selectedAsarPath);
    await assertDirectory(selectedUnpackedPath);
    const staged = await validateStagedTree(selectedAppPath, target);
    const archiveResult = await readArchive(selectedAsarPath);
    const archive = archiveResult.rows;
    const unpacked = await walkFiles(selectedUnpackedPath);
    const binding = target === "win32-x64"
      ? await validateWindowsBinding({ appPath: selectedAppPath, staged })
      : null;
    validateWindowsKeytar({ target, staged });
    validateNativeBoundary({
      target,
      staged,
      archive,
      archiveMarkedUnpacked: archiveResult.markedUnpacked,
      unpacked,
      manifest: staged.manifest,
    });
    const artifact = await compareArtifactToStaged({
      appPath: selectedAppPath,
      staged,
      archive,
      unpacked,
    });
    return Object.freeze({
      status: FIXED_STATUS.verified,
      target,
      staged: inventoryDigest(staged.rows),
      asar: inventoryDigest(archive),
      unpacked: inventoryDigest(unpacked),
      artifact: inventoryDigest(artifact),
      nativeFileCount: expectedNativePaths(target).size,
      binding: summarizeBinding(target, binding),
    });
  } catch (error) {
    if (KNOWN_STATUSES.has(error?.code)) throw error;
    throw fixedError(FIXED_STATUS.failed);
  }
}

export function parseArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  const parsed = {
    target: null,
    appPath: null,
    asarPath: null,
    unpackedPath: null,
  };
  const fields = new Map([
    ["--target", "target"],
    ["--app", "appPath"],
    ["--asar", "asarPath"],
    ["--unpacked", "unpackedPath"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const field = fields.get(argument);
    if (!field) fail(FIXED_STATUS.inputInvalid);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      fail(FIXED_STATUS.inputInvalid);
    }
    parsed[field] = value;
    index += 1;
  }
  if (!parsed.target || !parsed.appPath || !parsed.asarPath || !parsed.unpackedPath) {
    fail(FIXED_STATUS.inputInvalid);
  }
  return Object.freeze(parsed);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await verifyElectronDevelopmentArtifact(parseArguments(argv));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const status = KNOWN_STATUSES.has(error?.code)
      ? error.code
      : FIXED_STATUS.failed;
    process.stderr.write(`${status}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  await main();
}
