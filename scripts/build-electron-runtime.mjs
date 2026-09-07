#!/usr/bin/env node

/**
 * Stage the smallest reviewed local companion tree that an Electron shell can
 * launch.  This is a runtime packager, not an Electron application builder:
 * it does not download Electron, sign an artifact, build a native binding, or
 * make a Windows production-safety claim.
 *
 * The source closure is deliberately shared with the existing macOS packager
 * so a new local companion import cannot silently escape this boundary.  The
 * output manifest contains only relative paths, byte counts, and SHA-256
 * digests; it never records a checkout path, account value, or file contents.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { constants as fileSystemConstants } from "node:fs";
import {
  cp,
  lstat as fsLstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  LOCAL_COMPANION_STATIC_FILES,
} from "../apps/local/static-assets.js";
import {
  MACOS_ACCOUNTING_RUNTIME_FILES,
  MACOS_IDENTITY_CORE_RUNTIME_FILES,
  MACOS_QUOTA_ANALYSIS_RUNTIME_FILES,
  MACOS_TELEMETRY_CONTRACT_RUNTIME_FILES,
  captureMacOSWorkspaceRuntimePackages,
  collectMacOSRuntimeGraph,
  collectMacOSWebModuleGraph,
  pinnedPackage,
  pinnedPackageTreeDigest,
} from "./build-macos-app.js";
import {
  canonicalElectronBuilderPackageJsonBytes,
  ELECTRON_BUILDER_PACKAGE_PROFILES,
  validateProductionDistributionMetadata,
} from "./lib/electron-builder-package-json.mjs";
import { extractEsmImports } from "./lib/esm-imports.mjs";
import { RELEASE_VERSION } from "../config/release-manifest.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const MANIFEST_FILE = "electron-runtime-manifest.json";
const MANIFEST_SCHEMA = "usage-monitor-electron-runtime-v0.1";
const MAXIMUM_BINDING_BYTES = 64 * 1024 * 1024;
const MAXIMUM_MANIFEST_BYTES = 1 * 1024 * 1024;
const DEFAULT_PACKAGING_PROFILE = "development";
const DEFAULT_TARGET = "darwin-arm64";
const STAGED_ELECTRON_MODULE_LINKAGE_TIMEOUT_MS = 10_000;
const ELECTRON_RUNTIME_ONLY_DYNAMIC_IMPORTS = new Set([
  "electron",
]);
const DARWIN_ARM64_TARGET = "darwin-arm64";
const DARWIN_X64_TARGET = "darwin-x64";
const WINDOWS_X64_TARGET = "win32-x64";
const LINUX_X64_TARGET = "linux-x64";
const WINDOWS_PLATFORM = "win32";
const TARGET_SPECS = Object.freeze({
  [DARWIN_ARM64_TARGET]: Object.freeze({
    platform: "darwin",
    architecture: "arm64",
    keytarArchitecture: "darwin-arm64",
  }),
  [DARWIN_X64_TARGET]: Object.freeze({
    platform: "darwin",
    architecture: "x64",
    keytarArchitecture: "darwin-x64",
  }),
  [WINDOWS_X64_TARGET]: Object.freeze({
    platform: "win32",
    architecture: "x64",
    keytarArchitecture: "win32-x64",
  }),
  [LINUX_X64_TARGET]: Object.freeze({
    platform: "linux",
    architecture: "x64",
    keytarArchitecture: "linux-x64",
  }),
});
const TARGET_ALIASES = Object.freeze({
  darwin: DARWIN_ARM64_TARGET,
  macos: DARWIN_ARM64_TARGET,
  macOS: DARWIN_ARM64_TARGET,
  "darwin-arm64": DARWIN_ARM64_TARGET,
  "darwin-x64": DARWIN_X64_TARGET,
  windows: WINDOWS_X64_TARGET,
  win: WINDOWS_X64_TARGET,
  win32: WINDOWS_X64_TARGET,
  "win32-x64": WINDOWS_X64_TARGET,
  linux: LINUX_X64_TARGET,
  "linux-x64": LINUX_X64_TARGET,
});
export const ELECTRON_TARGETS = TARGET_SPECS;
// Electron still owns this reviewed cross-platform credential binding. The
// native macOS app retired Keytar in PR #81, so its packager is deliberately
// no longer the authority for this dependency. Preserve the previously
// reviewed full-tree pin; a version match alone cannot authenticate bytes.
export const ELECTRON_KEYTAR_PACKAGE_PIN = Object.freeze({
  name: "@github/keytar",
  version: "7.10.6",
  treeDigest: "0a09b62fbf597c176747009631e671c0625530132a471b6a1aa47153edf131be",
});
export const ELECTRON_KEYTAR_PREBUILD_SHA256 = Object.freeze({
  "darwin-arm64": "855c21e1e702967230bd87f600d04c311b77f29150f3372d547e72882c58de6a",
  "darwin-x64": "5ce10f1f83f917fb555ff2ba43a80cab0f215d266cfdbd9bce5d6affa61c8aa1",
  "win32-x64": "b82625e7c713fd20b5cb57993e073076c87660652202893fad39d874d77169fc",
  "linux-x64": "e7894a1e1001764de29ff08d3dae418ccbaaf78889c5673d367e05df1682fc7c",
});
// electron-updater shares the Electron-shell dependency closure in every
// profile. Development still cannot activate it: production metadata and the
// packaged-app gate are checked before the wrapper accepts an updater object.
// Pin its complete JavaScript closure so a lockfile or semver range update
// cannot silently change the bytes available to the production path.
export const ELECTRON_UPDATER_RUNTIME_PACKAGE_PINS = Object.freeze({
  "electron-updater": Object.freeze({ version: "6.8.9", treeDigest: "a0af15bd47e92fc55adcb9090f1194123c0061b6e68ec05aeb8c870d11cd967d" }),
  "fs-extra": Object.freeze({ version: "10.1.0", treeDigest: "6f25f07c6627d8c90d74f98484d7826976b8466ec63214c9d8ad6de45ad7a2e1" }),
  "graceful-fs": Object.freeze({ version: "4.2.11", treeDigest: "50be26497cde8fa218ef0972211226e0875a2d92215503f359bbf1f5f74f7029" }),
  jsonfile: Object.freeze({ version: "6.2.1", treeDigest: "f1539bed75ece7992551b1a0455407ebf20c0db7c789c2fde48d240582bbe3bc" }),
  universalify: Object.freeze({ version: "2.0.1", treeDigest: "4a7ddf63a214114d9464731e81bc668a74ee6bf7aceb8727fe7fe40b7d96e770" }),
  "js-yaml": Object.freeze({ version: "4.3.2", treeDigest: "5f599dde104457d922f7a9f6407171ce24c7571a673821a147c3e080e0ea00ed" }),
  argparse: Object.freeze({ version: "2.0.1", treeDigest: "1444dc2abbede4a7da787c6bc5f76f5b1dee7da6bf4c439d65a9c7b1ca8b26e9" }),
  "lazy-val": Object.freeze({ version: "1.0.5", treeDigest: "c04e8c581f2ebe64f03e2285387903e9e262f6272c5c3b0a277bd130d59acb5c" }),
  "lodash.escaperegexp": Object.freeze({ version: "4.1.2", treeDigest: "fab738661a8b04c7d9031603b620d2ca44721f330c0a9034a450691dde772508" }),
  "lodash.isequal": Object.freeze({ version: "4.5.0", treeDigest: "61917e555449da3087c982b809f8692172bd0ba4fe4e5f4e622cd85bc5c82674" }),
  semver: Object.freeze({ version: "7.7.4", treeDigest: "544f5cd6a26320479db1d49616fc92e77d0ef314d8fbe1695e608a3b87dd4bf2" }),
  "tiny-typed-emitter": Object.freeze({ version: "2.1.0", treeDigest: "831a3e7981d9ee9cc57e53193d80874ddaa44b4dc56c5ee743d17f23ffaa7008" }),
  "builder-util-runtime": Object.freeze({ version: "9.7.0", treeDigest: "af3dc063ecb635713de7c3f6ba31dd6b12d81bdcb1ee801fcb120564356c5c65" }),
  debug: Object.freeze({ version: "4.4.3", treeDigest: "08a42db71c877d8571d319974cdc7be35cf7f2838401b4b85c9916c659bf8b0b" }),
  ms: Object.freeze({ version: "2.1.3", treeDigest: "1b61283cc0533e5f326e9459a3dae42765bd4567878e880df697c66ac24490fe" }),
  sax: Object.freeze({ version: "1.6.1", treeDigest: "616cded19b800467ab721b4c766a54829d701b975cee2e4e59e9844081b875cf" }),
});
const WINDOWS_BINDING_RELATIVE_PATH =
  "native/windows-filesystem/build/Release/windows_filesystem.node";
const WINDOWS_MANIFEST_RELATIVE_PATH =
  `${WINDOWS_BINDING_RELATIVE_PATH}.manifest.json`;
const NATIVE_PATH_MODULE = Object.freeze({
  isAbsolute,
  relative,
  resolve,
  sep,
});
export const ELECTRON_SHELL_RUNTIME_FILES = Object.freeze([
  "config/electron-production-distribution.cjs",
  "config/deployment-endpoints.js",
  "native/macos-keychain/contract.js",
  "apps/electron/companion-supervisor.js",
  "apps/electron/desktop-automatic-refresh-cadence.js",
  "apps/electron/desktop-command.js",
  "apps/electron/desktop-contract.js",
  "apps/electron/desktop-contribution-credential.js",
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
  "apps/electron/desktop-keychain-broker.js",
  "apps/electron/desktop-owned-downloads.js",
  "apps/electron/desktop-menu.js",
  "apps/electron/desktop-lifecycle.js",
  "apps/electron/desktop-macos-keychain.js",
  "apps/electron/desktop-native-migration.js",
  "apps/electron/desktop-native-migration-macos.js",
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
  "apps/electron/desktop-tray-popover.js",
  "apps/electron/desktop-tray-preferences.js",
  "apps/electron/desktop-status-monitor.js",
  "apps/electron/desktop-tray-status.js",
  "apps/electron/desktop-update-preferences.js",
  "apps/electron/desktop-updater.js",
  "apps/electron/errors.js",
  "apps/electron/loopback-policy.js",
  "apps/electron/main.js",
  "apps/electron/platform-gate.js",
  "apps/electron/preload.cjs",
  "apps/electron/recovery-preload.cjs",
  "apps/electron/tray-popover-preload.cjs",
  "apps/electron/recovery-window.js",
  "apps/electron/ready-line.js",
  "apps/electron/windows-qualification.js",
  "src/desktop-shell-status.js",
  "src/platform/windows-credential-manager-probe.js",
]);
// Existing outputs are authenticated against their own complete manifest and
// payload before replacement. Keep this stable identity subset separate from
// the current shell closure so adding a reviewed shell module does not make a
// previously valid generated output impossible to replace.
const ELECTRON_SHELL_IDENTITY_FILES = Object.freeze([
  "apps/electron/companion-supervisor.js",
  "apps/electron/desktop-lifecycle.js",
  "apps/electron/errors.js",
  "apps/electron/loopback-policy.js",
  "apps/electron/main.js",
  "apps/electron/platform-gate.js",
  "apps/electron/preload.cjs",
  "apps/electron/ready-line.js",
]);
const READ_ONLY_FLAG = fileSystemConstants.O_RDONLY ?? 0;
// Windows has no portable O_NOFOLLOW open contract. Its capture path performs
// an lstat/open/descriptor-and-path identity bracket instead; POSIX retains
// the kernel no-follow flag.
const NO_FOLLOW_FLAG = process.platform === "win32"
  ? 0
  : (fileSystemConstants.O_NOFOLLOW ?? 0);
const WINDOWS_BIGINT_STAT_OPTIONS = Object.freeze({ bigint: true });

function statOptionsForPlatform(platform) {
  return platform === "win32" ? WINDOWS_BIGINT_STAT_OPTIONS : undefined;
}

function lstatForRuntime(path) {
  const options = statOptionsForPlatform(process.platform);
  return options === undefined ? fsLstat(path) : fsLstat(path, options);
}

function statForRuntime(handle) {
  const options = statOptionsForPlatform(process.platform);
  return options === undefined ? handle.stat() : handle.stat(options);
}

export function electronRuntimeStatOptionsForTest(platform = process.platform) {
  return statOptionsForPlatform(platform);
}
const FORBIDDEN_PREFIXES = Object.freeze([
  ".git/",
  ".release-build/",
  ".release-deps/",
  ".release-repro/",
  ".usage-monitor/",
  "docs/",
  "exports/",
  "local-review/",
  "test/",
  "tests/",
]);

const FORBIDDEN_SEGMENTS = new Set([
  "credentials",
  "secrets",
  "quarantine",
  "uploads",
]);

const WORKSPACE_RUNTIME_PACKAGE_FILES = Object.freeze({
  "@app-usagemonitor/accounting": MACOS_ACCOUNTING_RUNTIME_FILES,
  "@app-usagemonitor/identity-core": MACOS_IDENTITY_CORE_RUNTIME_FILES,
  "@app-usagemonitor/quota-analysis": MACOS_QUOTA_ANALYSIS_RUNTIME_FILES,
  "@app-usagemonitor/telemetry-contract": MACOS_TELEMETRY_CONTRACT_RUNTIME_FILES,
});

const SOURCE_FILE_KIND = "companion_source";
const ELECTRON_SHELL_KIND = "electron_shell";
const WEB_FILE_KIND = "dashboard_asset";
const WORKSPACE_PACKAGE_KIND = "workspace_dependency";
const THIRD_PARTY_KIND = "third_party_dependency";
const NATIVE_KIND = "windows_native_binding";
const METADATA_KIND = "runtime_metadata";
const INVENTORY_KINDS = new Set([
  SOURCE_FILE_KIND,
  ELECTRON_SHELL_KIND,
  WEB_FILE_KIND,
  WORKSPACE_PACKAGE_KIND,
  THIRD_PARTY_KIND,
  NATIVE_KIND,
  METADATA_KIND,
]);

function comparePathBytes(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function failure(code, message) {
  const error = new Error(message);
  error.code = `ELECTRON_RUNTIME_${code}`;
  return error;
}

function fail(code, message) {
  throw failure(code, message);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort(comparePathBytes).map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeElectronTarget(value = DEFAULT_TARGET) {
  if (typeof value === "string" && Object.hasOwn(TARGET_ALIASES, value)) return TARGET_ALIASES[value];
  fail("INVALID_TARGET", "Unsupported Electron runtime target");
}

function normalizePackagingProfile(value = DEFAULT_PACKAGING_PROFILE) {
  if (typeof value !== "string" || !Object.hasOwn(ELECTRON_BUILDER_PACKAGE_PROFILES, value)) {
    fail("INVALID_PACKAGING_PROFILE", "Unsupported Electron packaging profile");
  }
  return value;
}

function normalizePackageVersion(value = RELEASE_VERSION, distributionMetadata) {
  const expectedVersion = distributionMetadata?.semanticVersion ?? RELEASE_VERSION;
  if (typeof value !== "string" || value !== expectedVersion) {
    fail("INVALID_PACKAGE_VERSION", "Electron packaging version does not match the reviewed release");
  }
  return value;
}

function normalizeRelativePath(value, label) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\\")
      || value.includes("\0")
      || isAbsolute(value)) {
    fail("INVALID_RELATIVE_PATH", `${label} is not a safe relative path`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    fail("INVALID_RELATIVE_PATH", `${label} is not a safe relative path`);
  }
  return parts.join("/");
}

async function assertNoSymlinkPathComponents(path, label = "path") {
  const selected = resolve(path);
  let current = selected;
  while (true) {
    let metadata;
    try {
      metadata = await lstatForRuntime(current);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
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
      fail("SYMLINK_PATH", `${label} contains a symbolic link: ${current}`);
    }
    if (!metadata.isDirectory() && current !== selected) {
      fail("UNSAFE_PATH", `${label} contains a non-directory component: ${current}`);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function pathIsInside(parent, child, pathModule = NATIVE_PATH_MODULE) {
  const suffix = pathModule.relative(
    pathModule.resolve(parent),
    pathModule.resolve(child),
  );
  return suffix === "" || (suffix !== ".."
    && !suffix.startsWith(`..${pathModule.sep}`)
    && !pathModule.isAbsolute(suffix));
}

function isRepositoryOutputPathInside(
  repository,
  selected,
  pathModule = NATIVE_PATH_MODULE,
) {
  const suffix = pathModule.relative(
    pathModule.resolve(repository),
    pathModule.resolve(selected),
  );
  return suffix !== "" && pathIsInside(repository, selected, pathModule);
}

export function electronRuntimeOutputIsInsideRepositoryForTest(
  repository,
  selected,
  platform = process.platform,
) {
  return isRepositoryOutputPathInside(
    repository,
    selected,
    platform === WINDOWS_PLATFORM ? win32 : NATIVE_PATH_MODULE,
  );
}

function assertReviewedRuntimePath(relativePath, label = "runtime path") {
  const selected = normalizeRelativePath(relativePath, label);
  const folded = selected.toLowerCase();
  if (FORBIDDEN_PREFIXES.some((prefix) => folded.startsWith(prefix.toLowerCase()))) {
    fail("FORBIDDEN_SOURCE", `${label} is outside the reviewed runtime: ${selected}`);
  }
  const segments = selected.split("/");
  if (segments.some((part) => FORBIDDEN_SEGMENTS.has(part.toLowerCase()))) {
    fail("PRIVATE_SOURCE", `${label} is private state: ${selected}`);
  }
  if (new Set(["package-lock.json", "pnpm-lock.yaml", ".npmrc"]).has(folded)
      || (folded.startsWith("native/windows-filesystem/build/")
        && folded !== WINDOWS_BINDING_RELATIVE_PATH.toLowerCase()
        && folded !== WINDOWS_MANIFEST_RELATIVE_PATH.toLowerCase())) {
    fail("FORBIDDEN_SOURCE", `${label} is not a runtime input: ${selected}`);
  }
  return selected;
}

async function writeRegularFile(destination, content, mode = 0o444) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  await writeFile(destination, content, { flag: "wx", mode });
}

async function writeCapturedFile(destination, bytes, mode = 0o444) {
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) {
    fail("CAPTURE_INVALID", "Captured runtime bytes are invalid");
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  await writeFile(destination, Buffer.from(bytes), { flag: "wx", mode });
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

function statSizeBigInt(metadata) {
  if (typeof metadata?.size === "bigint") {
    return metadata.size >= 0n ? metadata.size : null;
  }
  return Number.isSafeInteger(metadata?.size) && metadata.size >= 0
    ? BigInt(metadata.size)
    : null;
}

export function electronRuntimeStatFingerprintForTest(metadata) {
  return statFingerprint(metadata);
}

/**
 * Read one regular file through an opened descriptor. The descriptor is
 * opened with O_NOFOLLOW where the host supports it, and every read is
 * bracketed by descriptor stat calls. Windows uses a lstat-before/lstat-after
 * fallback plus the same descriptor identity check; the fallback never trusts
 * a path after bytes have been captured.
 */
async function captureRegularFile(path, label, { maximumBytes = null } = {}) {
  await assertNoSymlinkPathComponents(path, label);
  let handle;
  let usedWindowsFallback = false;
  let fallbackBeforeFingerprint = null;
  try {
    if (process.platform === "win32") {
      const beforePath = await lstatForRuntime(path);
      if (beforePath.isSymbolicLink() || !beforePath.isFile()) {
        fail("UNSAFE_INPUT", `${label} is not a regular file`);
      }
      fallbackBeforeFingerprint = statFingerprint(beforePath);
      handle = await open(path, READ_ONLY_FLAG);
      usedWindowsFallback = true;
    } else {
      try {
        handle = await open(path, READ_ONLY_FLAG | NO_FOLLOW_FLAG);
      } catch (error) {
        if (error?.code === "ENOENT") fail("MISSING_INPUT", `${label} is missing`);
        throw error;
      }
    }
    const before = await statForRuntime(handle);
    if (!before.isFile()) fail("UNSAFE_INPUT", `${label} is not a regular file`);
    const beforeSize = statSizeBigInt(before);
    if (beforeSize === null) fail("INPUT_CHANGED", `${label} has invalid size metadata`);
    if (maximumBytes !== null && beforeSize > BigInt(maximumBytes)) {
      fail("INPUT_TOO_LARGE", `${label} exceeds the safe size limit`);
    }
    if (fallbackBeforeFingerprint !== null
        && fallbackBeforeFingerprint !== statFingerprint(before)) {
      fail("INPUT_CHANGED", `${label} changed while it was captured`);
    }
    const bytes = await handle.readFile();
    const after = await statForRuntime(handle);
    const afterSize = statSizeBigInt(after);
    if (afterSize === null) fail("INPUT_CHANGED", `${label} has invalid size metadata`);
    if (maximumBytes !== null && afterSize > BigInt(maximumBytes)) {
      fail("INPUT_TOO_LARGE", `${label} exceeds the safe size limit`);
    }
    if (statFingerprint(before) !== statFingerprint(after)
        || afterSize !== BigInt(bytes.byteLength)) {
      fail("INPUT_CHANGED", `${label} changed while it was captured`);
    }
    if (usedWindowsFallback) {
      const afterPath = await lstatForRuntime(path);
      if (afterPath.isSymbolicLink()
          || statFingerprint(afterPath) !== statFingerprint(after)) {
        fail("INPUT_CHANGED", `${label} changed while it was captured`);
      }
    }
    return Object.freeze({
      bytes: Buffer.from(bytes),
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    });
  } catch (error) {
    if (error?.code === "ENOENT") fail("MISSING_INPUT", `${label} is missing`);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function walkFiles(root, current = root, { skipNestedNodeModules = false } = {}) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    comparePathBytes(left.name, right.name))) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      fail("UNSAFE_INPUT", `Symbolic links are not allowed in runtime inputs: ${entry.name}`);
    }
    if (entry.isDirectory()) {
      if (skipNestedNodeModules && entry.name === "node_modules") continue;
      files.push(...await walkFiles(root, path, { skipNestedNodeModules }));
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      fail("UNSAFE_INPUT", `Unsupported runtime input: ${entry.name}`);
    }
  }
  return files;
}

async function validateOutputDestination(output, repositoryRoot, replace) {
  if (typeof output !== "string" || output.length === 0 || !isAbsolute(output)) {
    fail("UNSAFE_OUTPUT", "Electron runtime output must be an absolute path");
  }
  const selected = resolve(output);
  const repository = resolve(repositoryRoot);
  const home = resolve(homedir());
  const repositoryRelativeOutput = relative(repository, selected)
    .split(sep).join("/");
  const outputIsInsideRepository = isRepositoryOutputPathInside(repository, selected);
  const outputIsReviewedArtifact = repositoryRelativeOutput.startsWith(
    ".release-build/",
  ) || repositoryRelativeOutput.startsWith(".release-repro/");
  await assertNoSymlinkPathComponents(selected, "Electron runtime output");
  if (selected === dirname(selected)
      || selected === resolve(sep)
      || selected === home
      || selected === repository
      || (outputIsInsideRepository && !outputIsReviewedArtifact)) {
    fail("UNSAFE_OUTPUT", "Electron runtime output is a broad or source directory");
  }
  const parent = dirname(selected);
  await mkdir(parent, { recursive: true, mode: 0o755 });
  await assertNoSymlinkPathComponents(selected, "Electron runtime output");
  const actualParent = await realpath(parent);
  const actualHome = await realpath(home).catch(() => home);
  const actualRepository = await realpath(repository).catch(() => repository);
  if (actualParent === resolve(sep)
      || actualParent === actualHome || actualParent === actualRepository) {
    fail("UNSAFE_OUTPUT", "Electron runtime output parent is too broad");
  }
  let metadata;
  try {
    metadata = await lstatForRuntime(selected);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (metadata?.isSymbolicLink()) {
    fail("UNSAFE_OUTPUT", "Electron runtime output cannot be a symbolic link");
  }
  if (metadata && !metadata.isDirectory()) {
    fail("UNSAFE_OUTPUT", "Electron runtime output must be a directory");
  }
  if (metadata && !replace) {
    fail("OUTPUT_EXISTS", "Electron runtime output exists; pass replace explicitly");
  }
  return Object.freeze({
    output: selected,
    parent: actualParent,
    repository: actualRepository,
    existed: Boolean(metadata),
  });
}

function outputPath(root, relativePath) {
  const selected = normalizeRelativePath(relativePath, "staged path");
  const resolved = resolve(root, ...selected.split("/"));
  if (!pathIsInside(root, resolved) || resolved === resolve(root)) {
    fail("UNSAFE_OUTPUT", `Staged path escapes the output: ${selected}`);
  }
  return resolved;
}

function failStagedElectronModuleLinkage() {
  fail("STAGED_MODULE_LINKAGE", "Electron shell module linkage is incomplete");
}

async function stagedElectronModuleFile(stagingRoot, candidate) {
  const root = resolve(stagingRoot);
  const selected = resolve(candidate);
  if (selected === root || !pathIsInside(root, selected)) {
    failStagedElectronModuleLinkage();
  }
  let metadata;
  try {
    metadata = await lstatForRuntime(selected);
  } catch {
    failStagedElectronModuleLinkage();
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    failStagedElectronModuleLinkage();
  }
  let realRoot;
  let realSelected;
  try {
    [realRoot, realSelected] = await Promise.all([realpath(root), realpath(selected)]);
  } catch {
    failStagedElectronModuleLinkage();
  }
  if (!pathIsInside(realRoot, realSelected)) failStagedElectronModuleLinkage();
  return selected;
}

function stagedBarePackageManifest(stagingRoot, specifier) {
  if (typeof specifier !== "string"
      || specifier.length === 0
      || specifier.includes("\\")
      || specifier.includes("\0")
      || specifier.startsWith("/")
      || specifier.startsWith(".")) {
    failStagedElectronModuleLinkage();
  }
  const segments = specifier.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    failStagedElectronModuleLinkage();
  }
  const packageSegments = specifier.startsWith("@") ? segments.slice(0, 2) : segments.slice(0, 1);
  if (packageSegments.length === 0 || packageSegments.some((segment) => segment.length === 0)) {
    failStagedElectronModuleLinkage();
  }
  return join(stagingRoot, "node_modules", ...packageSegments, "package.json");
}

/**
 * Prove the staged Electron entrypoint's static ESM graph stays inside the
 * staged runtime. This runs before the atomic publish, so a newly imported
 * source file or direct package cannot be masked by a checkout ancestor.
 * Electron itself remains an explicit runtime-only dynamic import.
 */
export async function assertStagedElectronShellModuleLinkage(
  stagingRoot,
) {
  if (typeof stagingRoot !== "string" || !isAbsolute(stagingRoot)) {
    failStagedElectronModuleLinkage();
  }
  const root = resolve(stagingRoot);
  let rootMetadata;
  try {
    rootMetadata = await lstatForRuntime(root);
  } catch {
    failStagedElectronModuleLinkage();
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    failStagedElectronModuleLinkage();
  }
  const pending = [await stagedElectronModuleFile(
    root,
    outputPath(root, "apps/electron/main.js"),
  )];
  const visited = new Set();
  while (pending.length > 0) {
    const importer = pending.pop();
    if (visited.has(importer)) continue;
    visited.add(importer);
    let source;
    let imports;
    try {
      source = await readFile(importer, "utf8");
      imports = await extractEsmImports(source, { sourceName: importer });
    } catch {
      failStagedElectronModuleLinkage();
    }
    for (const { kind, specifier } of imports) {
      if (kind === "dynamic-import" && specifier === null) failStagedElectronModuleLinkage();
      if (typeof specifier !== "string") failStagedElectronModuleLinkage();
      if (specifier.startsWith(".")) {
        pending.push(await stagedElectronModuleFile(
          root,
          resolve(dirname(importer), specifier),
        ));
      } else if (!specifier.startsWith("node:")
          && !(kind === "dynamic-import"
            && ELECTRON_RUNTIME_ONLY_DYNAMIC_IMPORTS.has(specifier))) {
        await stagedElectronModuleFile(root, stagedBarePackageManifest(root, specifier));
      }
    }
  }
  return Object.freeze([...visited]
    .map((path) => relative(root, path).split(sep).join("/"))
    .sort(comparePathBytes));
}

function stagedElectronModuleLinkageEnvironment(environment = process.env) {
  const selected = {};
  // Do not pass Node flags, Electron mode, credentials, or application state
  // into the import-only child. Windows retains only process-launch essentials.
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (typeof environment[key] === "string") selected[key] = environment[key];
  }
  return selected;
}

async function assertNoAncestorNodeModules(stagingRoot) {
  let current = dirname(resolve(stagingRoot));
  while (true) {
    try {
      await lstatForRuntime(join(current, "node_modules"));
      failStagedElectronModuleLinkage();
    } catch (error) {
      if (error?.code !== "ENOENT") {
        if (error?.code === "ELECTRON_RUNTIME_STAGED_MODULE_LINKAGE") throw error;
        failStagedElectronModuleLinkage();
      }
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function importStagedElectronMain(stagingRoot) {
  const entrypoint = pathToFileURL(join(stagingRoot, "apps/electron/main.js")).href;
  const source = `await import(${JSON.stringify(entrypoint)});`;
  let child;
  try {
    child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: stagingRoot,
      env: stagedElectronModuleLinkageEnvironment(),
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    failStagedElectronModuleLinkage();
  }
  const linked = await new Promise((resolveLinked) => {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, STAGED_ELECTRON_MODULE_LINKAGE_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timeout);
      resolveLinked(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveLinked(!timedOut && code === 0);
    });
  });
  if (linked !== true) failStagedElectronModuleLinkage();
}

/**
 * Link the staged Electron main process with plain Node from an external
 * temporary root. The entrypoint's Electron guard prevents a desktop launch;
 * no target-native binding is imported by this ESM-only check.
 */
export async function assertStagedElectronShellNodeLinkage(stagingRoot, options) {
  await assertStagedElectronShellModuleLinkage(stagingRoot, options);
  const isolatedParent = await mkdtemp(join(tmpdir(), "tibotattle-electron-linkage-"));
  const isolatedRuntime = join(isolatedParent, "app");
  try {
    await cp(stagingRoot, isolatedRuntime, {
      errorOnExist: true,
      force: false,
      recursive: true,
    });
    await assertNoAncestorNodeModules(isolatedRuntime);
    await importStagedElectronMain(isolatedRuntime);
  } catch (error) {
    if (error?.code === "ELECTRON_RUNTIME_STAGED_MODULE_LINKAGE") throw error;
    failStagedElectronModuleLinkage();
  } finally {
    await rm(isolatedParent, { force: true, recursive: true });
  }
}

async function stageRepositoryFile({ repositoryRoot, stagingRoot, relativePath, kind }) {
  const selected = assertReviewedRuntimePath(relativePath);
  const source = resolve(repositoryRoot, ...selected.split("/"));
  if (!pathIsInside(repositoryRoot, source)) {
    fail("UNSAFE_SOURCE", `Runtime source escapes the repository: ${selected}`);
  }
  const captured = await captureRegularFile(source, `runtime source ${selected}`);
  const destination = outputPath(stagingRoot, selected);
  await writeCapturedFile(destination, captured.bytes);
  return { kind, path: selected };
}

async function stageCapturedWorkspacePackages({ stagingRoot, captures, packageJsonOptions }) {
  const staged = [];
  for (const capture of captures) {
    const expectedFiles = WORKSPACE_RUNTIME_PACKAGE_FILES[capture.name];
    if (!expectedFiles
        || JSON.stringify(expectedFiles) !== JSON.stringify(
          capture.files.map(({ relativeFile }) => relativeFile),
        )) {
      fail("PACKAGE_CLOSURE", `Workspace dependency closure changed: ${capture.name}`);
    }
    for (const file of capture.files) {
      const relativePath = [
        "node_modules",
        ...capture.name.split("/"),
        ...file.relativeFile.split("/"),
      ].join("/");
      const destination = outputPath(stagingRoot, relativePath);
      await writeCapturedFile(
        destination,
        canonicalElectronBuilderPackageJsonBytes(
          relativePath,
          Buffer.from(file.sourceText, "utf8"),
          packageJsonOptions,
        ),
      );
      staged.push({ kind: WORKSPACE_PACKAGE_KIND, path: relativePath });
    }
  }
  return staged;
}

function packageRuntimeFile(relativePath) {
  const first = relativePath.split("/")[0];
  if ([
    ".github",
    "benchmark",
    "benchmarks",
    "example",
    "examples",
    "spec",
    "test",
    "tests",
  ].includes(first)) return false;
  if (relativePath.endsWith(".map")
      || relativePath.endsWith(".d.ts")
      || /^readme/i.test(basename(relativePath))) return false;
  return true;
}

async function stagePackageFiles({
  stagingRoot,
  name,
  packageRoot,
  include,
  packageJsonOptions,
}) {
  const sourceRoot = await realpath(packageRoot);
  const files = await walkFiles(sourceRoot, sourceRoot, {
    skipNestedNodeModules: true,
  });
  const staged = [];
  for (const source of files) {
    const relativeFile = relative(sourceRoot, source).split(sep).join("/");
    if (!include(relativeFile)) continue;
    const relativePath = [
      "node_modules",
      ...name.split("/"),
      ...relativeFile.split("/"),
    ].join("/");
    const captured = await captureRegularFile(source, `dependency ${relativePath}`);
    await writeCapturedFile(
      outputPath(stagingRoot, relativePath),
      canonicalElectronBuilderPackageJsonBytes(
        relativePath,
        captured.bytes,
        packageJsonOptions,
      ),
      /\.node$/u.test(relativeFile) ? 0o555 : 0o444,
    );
    staged.push({ kind: THIRD_PARTY_KIND, path: relativePath });
  }
  return staged;
}

export async function pinnedElectronKeytarPackage(packagePath) {
  const canonicalPath = await realpath(packagePath);
  const captured = await captureRegularFile(canonicalPath, "Electron Keytar manifest", {
    maximumBytes: MAXIMUM_MANIFEST_BYTES,
  });
  let manifest;
  try {
    manifest = JSON.parse(captured.bytes.toString("utf8"));
  } catch {
    fail("NATIVE_PACKAGE_MISMATCH", "Electron Keytar manifest is invalid");
  }
  const pin = ELECTRON_KEYTAR_PACKAGE_PIN;
  if (manifest?.name !== pin.name || manifest?.version !== pin.version) {
    fail("NATIVE_PACKAGE_MISMATCH", "Electron Keytar name or version is not pinned");
  }
  const treeDigest = await pinnedPackageTreeDigest(dirname(canonicalPath));
  if (treeDigest !== pin.treeDigest) {
    fail("NATIVE_PACKAGE_MISMATCH", "Electron Keytar tree does not match its reviewed pin");
  }
  return Object.freeze({
    name: pin.name,
    version: pin.version,
    license: manifest.license ?? null,
    treeDigest,
  });
}

async function pinnedElectronUpdaterRuntimePackage(name, packagePath) {
  const expected = ELECTRON_UPDATER_RUNTIME_PACKAGE_PINS[name];
  if (!expected) fail("UPDATER_PACKAGE_MISMATCH", "Updater runtime package is not reviewed");
  const canonicalPath = await realpath(packagePath);
  const captured = await captureRegularFile(canonicalPath, "Electron updater package manifest", {
    maximumBytes: MAXIMUM_MANIFEST_BYTES,
  });
  let manifest;
  try {
    manifest = JSON.parse(captured.bytes.toString("utf8"));
  } catch {
    fail("UPDATER_PACKAGE_MISMATCH", "Updater runtime package manifest is invalid");
  }
  const root = dirname(canonicalPath);
  const treeDigest = await pinnedPackageTreeDigest(root);
  if (manifest?.name !== name || manifest?.version !== expected.version
      || treeDigest !== expected.treeDigest) {
    fail("UPDATER_PACKAGE_MISMATCH", "Updater runtime package does not match its reviewed pin");
  }
  return Object.freeze({
    dependencies: Object.freeze(Object.keys(manifest.dependencies ?? {}).sort(comparePathBytes)),
    name,
    root,
    version: expected.version,
  });
}

async function resolveElectronUpdaterRuntimePackages(rootRequire) {
  const visited = new Map();
  async function visit(name, resolver) {
    const packagePath = resolver.resolve(`${name}/package.json`);
    const resolved = await pinnedElectronUpdaterRuntimePackage(name, packagePath);
    const previous = visited.get(name);
    if (previous !== undefined) {
      if (previous.root !== resolved.root) {
        fail("UPDATER_PACKAGE_MISMATCH", "Updater runtime resolves multiple package copies");
      }
      return;
    }
    visited.set(name, resolved);
    const packageRequire = createRequire(packagePath);
    for (const dependency of resolved.dependencies) await visit(dependency, packageRequire);
  }
  await visit("electron-updater", rootRequire);
  const actual = [...visited.keys()].sort(comparePathBytes);
  const expected = Object.keys(ELECTRON_UPDATER_RUNTIME_PACKAGE_PINS).sort(comparePathBytes);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail("UPDATER_PACKAGE_MISMATCH", "Updater runtime dependency closure changed");
  }
  return Object.freeze([...visited.values()].sort((left, right) => (
    comparePathBytes(left.name, right.name)
  )));
}

async function resolveThirdPartyPackages(
  repositoryRoot,
  target,
  { includeElectronUpdater = false } = {},
) {
  const rootRequire = createRequire(join(repositoryRoot, "package.json"));
  const ajvPackage = rootRequire.resolve("ajv/package.json");
  const ajvRoot = dirname(ajvPackage);
  const ajv = await pinnedPackage("ajv", ajvPackage);
  const ajvRequire = createRequire(ajvPackage);
  const transitive = [];
  for (const name of [
    "fast-deep-equal",
    "fast-uri",
    "json-schema-traverse",
    "require-from-string",
  ]) {
    const packagePath = ajvRequire.resolve(`${name}/package.json`);
    transitive.push({
      name,
      root: dirname(packagePath),
      pin: await pinnedPackage(name, packagePath),
    });
  }
  const runcostRoot = dirname(rootRequire.resolve("runcost/browser"));
  const runcostPackage = join(runcostRoot, "package.json");
  const runcost = await pinnedPackage("runcost", runcostPackage);
  const keytarPackage = rootRequire.resolve("@github/keytar/package.json");
  const keytarRoot = dirname(keytarPackage);
  const keytar = await pinnedElectronKeytarPackage(keytarPackage);
  const targetSpec = TARGET_SPECS[target];
  const keytarArchitecture = targetSpec.keytarArchitecture;
  const keytarPath = join(
    keytarRoot,
    "prebuilds",
    keytarArchitecture,
    "keytar.node",
  );
  const keytarPrebuild = await captureRegularFile(
    keytarPath,
    `Electron Keytar ${keytarArchitecture} prebuild`,
  );
  if (keytarPrebuild.sha256 !== ELECTRON_KEYTAR_PREBUILD_SHA256[keytarArchitecture]) {
    fail("NATIVE_PACKAGE_MISMATCH", "Electron Keytar prebuild bytes are not pinned");
  }
  const updater = includeElectronUpdater
    ? await resolveElectronUpdaterRuntimePackages(rootRequire)
    : Object.freeze([]);
  return Object.freeze({
    ajv: { name: "ajv", root: ajvRoot, pin: ajv },
    keytar: {
      name: "@github/keytar",
      root: keytarRoot,
      pin: keytar,
      keytarArchitecture,
      keytarPrebuildSha256: keytarPrebuild.sha256,
    },
    runcost: { name: "runcost", root: runcostRoot, pin: runcost },
    transitive: Object.freeze(transitive),
    updater,
  });
}

async function stageThirdPartyPackages({ stagingRoot, packages, packageJsonOptions }) {
  const staged = [];
  staged.push(...await stagePackageFiles({
    stagingRoot,
    name: packages.ajv.name,
    packageRoot: packages.ajv.root,
    packageJsonOptions,
    include: (path) => path === "package.json"
      || path === "LICENSE"
      || (path.startsWith("dist/") && (path.endsWith(".js") || path.endsWith(".json"))),
  }));
  for (const packageInfo of packages.transitive) {
    staged.push(...await stagePackageFiles({
      stagingRoot,
      name: packageInfo.name,
      packageRoot: packageInfo.root,
      packageJsonOptions,
      include: packageRuntimeFile,
    }));
  }
  staged.push(...await stagePackageFiles({
    stagingRoot,
    name: packages.runcost.name,
    packageRoot: packages.runcost.root,
    packageJsonOptions,
    include: (path) => path === "browser.js" || path === "package.json",
  }));
  const keytarArchitecture = packages.keytar.keytarArchitecture;
  staged.push(...await stagePackageFiles({
    stagingRoot,
    name: packages.keytar.name,
    packageRoot: packages.keytar.root,
    packageJsonOptions,
    include: (path) => path === "package.json"
      || path === "LICENSE.md"
      || path === `prebuilds/${keytarArchitecture}/keytar.node`,
  }));
  const keytarPrefix = "node_modules/@github/keytar/";
  const actualKeytarFiles = staged
    .map(({ path }) => path)
    .filter((path) => path.startsWith(keytarPrefix))
    .map((path) => path.slice(keytarPrefix.length))
    .sort(comparePathBytes);
  const expectedKeytarFiles = [
    "LICENSE.md",
    "package.json",
    `prebuilds/${keytarArchitecture}/keytar.node`,
  ].sort(comparePathBytes);
  if (JSON.stringify(actualKeytarFiles) !== JSON.stringify(expectedKeytarFiles)) {
    fail("PACKAGE_CLOSURE", "Keytar runtime must remain direct-native-only");
  }
  for (const packageInfo of packages.updater) {
    staged.push(...await stagePackageFiles({
      stagingRoot,
      name: packageInfo.name,
      packageRoot: packageInfo.root,
      packageJsonOptions,
      include: packageRuntimeFile,
    }));
  }
  return staged;
}

function defaultWindowsInput(relativePath) {
  return resolve(REPOSITORY_ROOT, ...relativePath.split("/"));
}

async function inspectWindowsBindingPair({
  bindingPath,
  manifestPath,
}) {
  let bindingMetadata = null;
  let manifestMetadata = null;
  try {
    bindingMetadata = await lstatForRuntime(bindingPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    manifestMetadata = await lstatForRuntime(manifestPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!bindingMetadata && !manifestMetadata) {
    return Object.freeze({ included: false, status: "unavailable" });
  }
  if (!bindingMetadata || !manifestMetadata) {
    fail("WINDOWS_BINDING_PAIR", "Windows binding and manifest must be supplied together");
  }
  if (bindingMetadata.size <= 0 || bindingMetadata.size > MAXIMUM_BINDING_BYTES
      || manifestMetadata.size <= 0 || manifestMetadata.size > MAXIMUM_MANIFEST_BYTES) {
    fail("WINDOWS_BINDING_SIZE", "Windows binding or manifest is outside the safe size limit");
  }
  if (basename(bindingPath) !== "windows_filesystem.node"
      || basename(manifestPath) !== "windows_filesystem.node.manifest.json") {
    fail("WINDOWS_BINDING_NAME", "Windows binding pair has an unexpected name");
  }
  const capturedBinding = await captureRegularFile(
    bindingPath,
    "Windows production binding",
    { maximumBytes: MAXIMUM_BINDING_BYTES },
  );
  const capturedManifest = await captureRegularFile(
    manifestPath,
    "Windows binding manifest",
    { maximumBytes: MAXIMUM_MANIFEST_BYTES },
  );
  let manifest;
  try {
    manifest = JSON.parse(capturedManifest.bytes.toString("utf8"));
  } catch {
    fail("WINDOWS_BINDING_MANIFEST", "Windows binding manifest is not valid JSON");
  }
  const manifestText = JSON.stringify(manifest);
  if (manifestText.includes("/Users/")
      || manifestText.includes("\\Users\\")
      || /(?:^|["\\])(?:[A-Za-z]:[\\/]|\/)/u.test(manifestText)) {
    fail("WINDOWS_BINDING_MANIFEST", "Windows binding manifest contains a source path");
  }
  if (manifest?.bindingFile !== "windows_filesystem.node"
      || manifest?.platform !== WINDOWS_PLATFORM
      || manifest?.architecture !== "x64"
      || manifest?.bytes !== capturedBinding.byteLength
      || manifest?.sha256 !== capturedBinding.sha256) {
    fail("WINDOWS_BINDING_MANIFEST", "Windows binding manifest does not match its binding");
  }
  const relativeBinding = WINDOWS_BINDING_RELATIVE_PATH;
  const relativeManifest = WINDOWS_MANIFEST_RELATIVE_PATH;
  // The caller may provide a temporary native build outside this checkout for
  // packaging rehearsal. Only the fixed destination names enter the output
  // manifest, so the source path is never disclosed.
  return Object.freeze({
    included: true,
    status: "included_unverified",
    bindingPath,
    manifestPath,
    relativeBinding,
    relativeManifest,
    bindingBytes: capturedBinding.bytes,
    manifestBytes: capturedManifest.bytes,
    bytes: capturedBinding.byteLength,
    sha256: capturedBinding.sha256,
  });
}

async function stageWindowsBinding({ stagingRoot, pair }) {
  if (!pair.included) return [];
  await writeCapturedFile(
    outputPath(stagingRoot, pair.relativeBinding),
    pair.bindingBytes,
    0o555,
  );
  await writeCapturedFile(
    outputPath(stagingRoot, pair.relativeManifest),
    pair.manifestBytes,
  );
  return [
    { kind: NATIVE_KIND, path: pair.relativeBinding },
    { kind: NATIVE_KIND, path: pair.relativeManifest },
  ];
}

async function collectInventory(stagingRoot) {
  const files = await walkFiles(stagingRoot);
  const rows = [];
  for (const file of files) {
    const path = relative(stagingRoot, file).split(sep).join("/");
    if (path === MANIFEST_FILE) continue;
    assertReviewedRuntimePath(path, "staged runtime path");
    const captured = await captureRegularFile(file, "staged runtime file");
    let kind = SOURCE_FILE_KIND;
    if (ELECTRON_SHELL_RUNTIME_FILES.includes(path)) kind = ELECTRON_SHELL_KIND;
    else if (path.startsWith("apps/web/public/")) kind = WEB_FILE_KIND;
    else if (path.startsWith("node_modules/@app-usagemonitor/")) {
      kind = WORKSPACE_PACKAGE_KIND;
    } else if (path.startsWith("node_modules/")) kind = THIRD_PARTY_KIND;
    if (path === "package.json") kind = METADATA_KIND;
    if (path === WINDOWS_BINDING_RELATIVE_PATH
        || path === WINDOWS_MANIFEST_RELATIVE_PATH) kind = NATIVE_KIND;
    rows.push({
      bytes: captured.byteLength,
      kind,
      path,
      sha256: captured.sha256,
    });
  }
  rows.sort((left, right) => comparePathBytes(left.path, right.path));
  return rows;
}

function payloadDigest(rows) {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const row of rows) {
    bytes += row.bytes;
    hash.update(`F\0${row.path}\0${row.bytes}\0${row.sha256}\0${row.kind}\0`);
  }
  return Object.freeze({ bytes, sha256: hash.digest("hex") });
}

function exactObjectKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort(comparePathBytes))
      === JSON.stringify([...keys].sort(comparePathBytes));
}

function assertContentFreeValue(value, label = "manifest") {
  if (typeof value === "string") {
    if (value.includes("\0")
        || isAbsolute(value)
        || /^[A-Za-z]:[\\/]/u.test(value)
        || value.startsWith("\\\\")) {
      fail("MANIFEST_PRIVATE_DATA", `${label} contains an absolute path`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) assertContentFreeValue(child, label);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assertContentFreeValue(key, `${label} key`);
      assertContentFreeValue(child, `${label}.${key}`);
    }
  }
}

function assertManifestContentFree(manifest) {
  assertContentFreeValue(manifest);
  const serialized = stableJson(manifest);
  if (serialized.includes(REPOSITORY_ROOT)) {
    fail("MANIFEST_PRIVATE_DATA", "Electron runtime manifest contains a source path");
  }
  return serialized;
}

function validateRuntimeManifestShape(manifest, { expectedReleaseVersion = RELEASE_VERSION } = {}) {
  assertManifestContentFree(manifest);
  if (!exactObjectKeys(manifest, [
    "architecture", "dashboardRoot", "entrypoint", "files", "payload",
    "releaseVersion", "schemaVersion", "target", "windowsBinding",
  ])) {
    fail("EXISTING_OUTPUT_INVALID", "Runtime manifest has an unexpected schema");
  }
  const manifestTarget = Object.entries(TARGET_SPECS).find(([, spec]) => (
    spec.platform === manifest.target && spec.architecture === manifest.architecture
  ));
  if (manifest.schemaVersion !== MANIFEST_SCHEMA
      || manifest.releaseVersion !== expectedReleaseVersion
      || !["apps/local/server.js", "apps/electron/main.js"].includes(manifest.entrypoint)
      || manifest.dashboardRoot !== "apps/web/public"
      || manifestTarget === undefined) {
    fail("EXISTING_OUTPUT_INVALID", "Runtime manifest identity does not match this packager");
  }
  const [, manifestTargetSpec] = manifestTarget;
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail("EXISTING_OUTPUT_INVALID", "Runtime manifest inventory is missing");
  }
  let previousPath = null;
  const seenPaths = new Set();
  for (const file of manifest.files) {
    if (!exactObjectKeys(file, ["bytes", "kind", "path", "sha256"])) {
      fail("EXISTING_OUTPUT_INVALID", "Runtime manifest inventory row is malformed");
    }
    const path = assertReviewedRuntimePath(file.path, "runtime manifest inventory path");
    if (path === MANIFEST_FILE
        || (previousPath !== null && comparePathBytes(previousPath, path) >= 0)
        || seenPaths.has(path)
        || !Number.isSafeInteger(file.bytes)
        || file.bytes < 0
        || !INVENTORY_KINDS.has(file.kind)
        || !/^[0-9a-f]{64}$/u.test(file.sha256)) {
      fail("EXISTING_OUTPUT_INVALID", "Runtime manifest inventory is not canonical");
    }
    previousPath = path;
    seenPaths.add(path);
  }
  if (manifest.entrypoint === "apps/electron/main.js"
      && !ELECTRON_SHELL_IDENTITY_FILES.every((path) => seenPaths.has(path))) {
    fail("EXISTING_OUTPUT_INVALID", "Electron shell entrypoint has an incomplete shell closure");
  }
  if (!exactObjectKeys(manifest.payload, ["bytes", "sha256"])
      || !Number.isSafeInteger(manifest.payload.bytes)
      || manifest.payload.bytes < 0
      || !/^[0-9a-f]{64}$/u.test(manifest.payload.sha256)) {
    fail("EXISTING_OUTPUT_INVALID", "Runtime manifest payload is malformed");
  }
  const windowsBinding = manifest.windowsBinding;
  if (windowsBinding === null || typeof windowsBinding !== "object"
      || Array.isArray(windowsBinding)
      || typeof windowsBinding.included !== "boolean"
      || typeof windowsBinding.status !== "string"
      || windowsBinding.verified !== false) {
    fail("EXISTING_OUTPUT_INVALID", "Runtime Windows binding declaration is malformed");
  }
  if (!windowsBinding.included) {
    if (!exactObjectKeys(windowsBinding, ["included", "status", "verified"])
        || !["not_requested", "unavailable"].includes(windowsBinding.status)) {
      fail("EXISTING_OUTPUT_INVALID", "Runtime Windows binding declaration is invalid");
    }
  } else if (!exactObjectKeys(windowsBinding, [
    "binding", "included", "manifest", "status", "verified",
  ]) || windowsBinding.status !== "included_unverified"
      || !exactObjectKeys(windowsBinding.binding, ["bytes", "path", "sha256"])
      || !exactObjectKeys(windowsBinding.manifest, ["path"])
      || windowsBinding.binding.path !== WINDOWS_BINDING_RELATIVE_PATH
      || windowsBinding.manifest.path !== WINDOWS_MANIFEST_RELATIVE_PATH
      || !Number.isSafeInteger(windowsBinding.binding.bytes)
      || windowsBinding.binding.bytes <= 0
      || !/^[0-9a-f]{64}$/u.test(windowsBinding.binding.sha256)) {
    fail("EXISTING_OUTPUT_INVALID", "Runtime Windows binding declaration is invalid");
  }
  if (manifestTargetSpec.platform !== WINDOWS_PLATFORM
      && windowsBinding.included) {
    fail("EXISTING_OUTPUT_INVALID", "Non-Windows runtime cannot include a Windows binding");
  }
  return manifest;
}

async function collectDirectoryPaths(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const directories = [];
  for (const entry of entries.sort((left, right) =>
    comparePathBytes(left.name, right.name))) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      fail("EXISTING_OUTPUT_INVALID", "Runtime output contains a symbolic link");
    }
    if (!entry.isDirectory()) continue;
    directories.push(relative(root, path).split(sep).join("/"));
    directories.push(...await collectDirectoryPaths(root, path));
  }
  return directories;
}

function expectedDirectoryPaths(rows) {
  const expected = new Set();
  for (const row of rows) {
    const parts = row.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      expected.add(parts.slice(0, index).join("/"));
    }
  }
  return [...expected].sort(comparePathBytes);
}

async function validateExistingRuntime(
  output,
  expectedTarget = null,
  expectedReleaseVersion = RELEASE_VERSION,
) {
  await assertNoSymlinkPathComponents(output, "existing Electron runtime");
  let metadata;
  try {
    metadata = await lstatForRuntime(output);
  } catch (error) {
    if (error?.code === "ENOENT") fail("EXISTING_OUTPUT_INVALID", "Runtime output is missing");
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail("EXISTING_OUTPUT_INVALID", "Runtime output is not a directory");
  }
  let capturedManifest;
  try {
    capturedManifest = await captureRegularFile(
      join(output, MANIFEST_FILE),
      "existing Electron runtime manifest",
      { maximumBytes: MAXIMUM_MANIFEST_BYTES },
    );
  } catch (error) {
    if (error?.code?.startsWith("ELECTRON_RUNTIME_")) {
      fail("EXISTING_OUTPUT_INVALID", "Existing runtime manifest is unavailable");
    }
    throw error;
  }
  let manifest;
  try {
    manifest = JSON.parse(capturedManifest.bytes.toString("utf8"));
  } catch {
    fail("EXISTING_OUTPUT_INVALID", "Existing runtime manifest is not JSON");
  }
  validateRuntimeManifestShape(manifest, { expectedReleaseVersion });
  if (expectedTarget !== null) {
    const expectedSpec = TARGET_SPECS[expectedTarget];
    if (expectedSpec === undefined
        || manifest.target !== expectedSpec.platform
        || manifest.architecture !== expectedSpec.architecture) {
      fail("EXISTING_OUTPUT_INVALID", "Existing runtime target does not match destination");
    }
  }
  const inventory = await collectInventory(output);
  if (stableJson(inventory) !== stableJson(manifest.files)) {
    fail("EXISTING_OUTPUT_INVALID", "Existing runtime inventory does not match its files");
  }
  const directories = (await collectDirectoryPaths(output)).sort(comparePathBytes);
  if (JSON.stringify(directories) !== JSON.stringify(expectedDirectoryPaths(inventory))) {
    fail("EXISTING_OUTPUT_INVALID", "Existing runtime contains an unrecorded directory");
  }
  const payload = payloadDigest(inventory);
  if (stableJson(payload) !== stableJson(manifest.payload)) {
    fail("EXISTING_OUTPUT_INVALID", "Existing runtime payload does not match its contents");
  }
  return Object.freeze({ manifest, inventory });
}

/**
 * Validate a destination before staging. Exported so the Electron app's
 * eventual packager can reuse the same broad-path guard.
 */
export async function validateElectronRuntimeOutput({
  output,
  replace = false,
} = {}) {
  return validateOutputDestination(output, REPOSITORY_ROOT, replace);
}

/**
 * Stage the reviewed companion runtime. The returned manifest is also written
 * to `electron-runtime-manifest.json` inside the destination.
 */
export async function buildElectronRuntime({
  output,
  target = DEFAULT_TARGET,
  replace = false,
  windowsBindingPath,
  windowsManifestPath,
  includeElectronShell = false,
  packagingProfile = DEFAULT_PACKAGING_PROFILE,
  packageVersion = RELEASE_VERSION,
  distributionMetadata,
} = {}) {
  if (typeof includeElectronShell !== "boolean") {
    fail("INVALID_SHELL_MODE", "includeElectronShell must be a boolean");
  }
  const selectedTarget = normalizeElectronTarget(target);
  const selectedTargetSpec = TARGET_SPECS[selectedTarget];
  const selectedPackagingProfile = normalizePackagingProfile(packagingProfile);
  // The production profile is paired with the protected Windows release
  // config: it may never silently label a companion-only or macOS tree.
  if (selectedPackagingProfile === "windows-production"
      && (selectedTarget !== WINDOWS_X64_TARGET || !includeElectronShell)) {
    fail(
      "PACKAGING_PROFILE_TARGET",
      "The Windows production profile requires a Windows Electron shell build",
    );
  }
  let selectedDistributionMetadata;
  if (selectedPackagingProfile === "production") {
    if (!includeElectronShell) {
      fail(
        "PACKAGING_PROFILE_TARGET",
        "The production profile requires an Electron shell build",
      );
    }
    try {
      selectedDistributionMetadata = validateProductionDistributionMetadata(distributionMetadata);
    } catch {
      fail("PRODUCTION_DISTRIBUTION", "Production distribution metadata is invalid");
    }
    const metadataTarget = selectedDistributionMetadata.target;
    if (metadataTarget !== selectedTarget) {
      fail("PRODUCTION_DISTRIBUTION", "Production distribution target does not match staging");
    }
  } else if (distributionMetadata !== undefined) {
    fail("PRODUCTION_DISTRIBUTION", "Distribution metadata requires the production profile");
  }
  const selectedPackageVersion = normalizePackageVersion(
    packageVersion,
    selectedDistributionMetadata,
  );
  const packageJsonOptions = includeElectronShell
    ? Object.freeze({
      ...(selectedDistributionMetadata
        ? { distributionMetadata: selectedDistributionMetadata }
        : {}),
      packageVersion: selectedPackageVersion,
      profile: selectedPackagingProfile,
    })
    : undefined;
  if (selectedTarget !== WINDOWS_X64_TARGET
      && (windowsBindingPath || windowsManifestPath)) {
    fail("WINDOWS_BINDING_TARGET", "Windows binding arguments require the Windows target");
  }
  const destination = await validateOutputDestination(output, REPOSITORY_ROOT, replace);
  if (destination.existed) {
    await validateExistingRuntime(destination.output, selectedTarget, selectedPackageVersion);
  }
  const temporaryRoot = await mkdtemp(join(
    destination.parent,
    `.${basename(destination.output)}.staging-`,
  ));
  let committed = false;
  try {
    const runtimeGraph = await collectMacOSRuntimeGraph();
    const webGraph = await collectMacOSWebModuleGraph();
    const staged = [];
    const stagedRepositoryPaths = new Set();
    const stageUniqueRepositoryFile = async (options) => {
      const selected = normalizeRelativePath(options.relativePath, "staged path");
      if (stagedRepositoryPaths.has(selected)) return null;
      const result = await stageRepositoryFile({
        ...options,
        relativePath: selected,
      });
      stagedRepositoryPaths.add(selected);
      return result;
    };
    for (const relativePath of runtimeGraph.relativeFiles) {
      if (relativePath === "package.json") continue;
      const result = await stageUniqueRepositoryFile({
        repositoryRoot: REPOSITORY_ROOT,
        stagingRoot: temporaryRoot,
        relativePath,
        kind: SOURCE_FILE_KIND,
      });
      if (result) staged.push(result);
    }
    const webFiles = new Set([
      ...webGraph.relativeFiles,
      ...Object.values(LOCAL_COMPANION_STATIC_FILES).map(({ file }) =>
        `apps/web/public/${file}`),
    ]);
    for (const relativePath of [...webFiles].sort(comparePathBytes)) {
      const result = await stageUniqueRepositoryFile({
        repositoryRoot: REPOSITORY_ROOT,
        stagingRoot: temporaryRoot,
        relativePath,
        kind: WEB_FILE_KIND,
      });
      if (result) staged.push(result);
    }

    if (includeElectronShell) {
      for (const relativePath of ELECTRON_SHELL_RUNTIME_FILES) {
        const result = await stageUniqueRepositoryFile({
          repositoryRoot: REPOSITORY_ROOT,
          stagingRoot: temporaryRoot,
          relativePath,
          kind: ELECTRON_SHELL_KIND,
        });
        if (result) staged.push(result);
      }
    }

    const captures = await captureMacOSWorkspaceRuntimePackages();
    staged.push(...await stageCapturedWorkspacePackages({
      stagingRoot: temporaryRoot,
      captures,
      packageJsonOptions,
    }));
    const packages = await resolveThirdPartyPackages(REPOSITORY_ROOT, selectedTarget, {
      includeElectronUpdater: includeElectronShell,
    });
    staged.push(...await stageThirdPartyPackages({
      stagingRoot: temporaryRoot,
      packages,
      packageJsonOptions,
    }));

    const rootPackageBytes = Buffer.from(stableJson({
      engines: { node: ">=22.13.0" },
      main: includeElectronShell ? "apps/electron/main.js" : "apps/local/server.js",
      name: "app-usagemonitor",
      private: true,
      type: "module",
      version: selectedPackageVersion,
    }), "utf8");
    await writeRegularFile(
      outputPath(temporaryRoot, "package.json"),
      canonicalElectronBuilderPackageJsonBytes(
        "package.json",
        rootPackageBytes,
        packageJsonOptions,
      ),
    );

    let windowsBinding;
    if (selectedTarget === WINDOWS_X64_TARGET) {
      const bindingPath = windowsBindingPath
        ? resolve(windowsBindingPath)
        : defaultWindowsInput(WINDOWS_BINDING_RELATIVE_PATH);
      const manifestPath = windowsManifestPath
        ? resolve(windowsManifestPath)
        : `${bindingPath}.manifest.json`;
      windowsBinding = await inspectWindowsBindingPair({
        bindingPath,
        manifestPath,
      });
      staged.push(...await stageWindowsBinding({
        stagingRoot: temporaryRoot,
        pair: windowsBinding,
      }));
    } else {
      windowsBinding = Object.freeze({
        included: false,
        status: "not_requested",
      });
    }

    if (includeElectronShell) {
      await assertStagedElectronShellNodeLinkage(temporaryRoot);
    }

    const inventory = await collectInventory(temporaryRoot);
    if (windowsBinding.included) {
      const stagedBinding = inventory.find(
        ({ path }) => path === windowsBinding.relativeBinding,
      );
      if (!stagedBinding
          || stagedBinding.bytes !== windowsBinding.bytes
          || stagedBinding.sha256 !== windowsBinding.sha256) {
        fail(
          "WINDOWS_BINDING_STAGING_MISMATCH",
          "Staged Windows binding does not match the captured input",
        );
      }
    }
    const payload = payloadDigest(inventory);
    const manifest = Object.freeze({
      schemaVersion: MANIFEST_SCHEMA,
      target: selectedTargetSpec.platform,
      architecture: selectedTargetSpec.architecture,
      releaseVersion: selectedPackageVersion,
      entrypoint: includeElectronShell ? "apps/electron/main.js" : "apps/local/server.js",
      dashboardRoot: "apps/web/public",
      files: inventory,
      payload,
      windowsBinding: Object.freeze({
        included: windowsBinding.included,
        status: windowsBinding.status,
        verified: false,
        ...(windowsBinding.included
          ? {
            binding: {
              bytes: windowsBinding.bytes,
              path: windowsBinding.relativeBinding,
              sha256: windowsBinding.sha256,
            },
            manifest: { path: windowsBinding.relativeManifest },
          }
          : {}),
      }),
    });
    await writeRegularFile(
      outputPath(temporaryRoot, MANIFEST_FILE),
      assertManifestContentFree(manifest),
    );

    // Re-check the exact output parent and existing artifact immediately
    // before the rename. This catches a symlink swap or foreign-directory
    // replacement while the new tree was being staged.
    await assertNoSymlinkPathComponents(destination.output, "Electron runtime output");
    const commitParent = await realpath(dirname(destination.output));
    const stagingParent = await realpath(dirname(temporaryRoot));
    if (commitParent !== destination.parent || stagingParent !== destination.parent) {
      fail("UNSAFE_OUTPUT", "Electron runtime containment changed before commit");
    }
    const commitDestination = await validateOutputDestination(
      destination.output,
      REPOSITORY_ROOT,
      replace,
    );
    if (commitDestination.existed !== destination.existed
        || commitDestination.parent !== destination.parent) {
      fail("UNSAFE_OUTPUT", "Electron runtime destination changed before commit");
    }
    if (destination.existed) {
      await validateExistingRuntime(destination.output, selectedTarget, selectedPackageVersion);
    }
    else {
      let currentMetadata;
      try {
        currentMetadata = await lstatForRuntime(destination.output);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (currentMetadata) fail("OUTPUT_EXISTS", "Electron runtime output appeared before commit");
    }

    if (destination.existed) {
      const backup = join(
        destination.parent,
        `.${basename(destination.output)}.previous-${randomUUID()}`,
      );
      await rename(destination.output, backup);
      try {
        await rename(temporaryRoot, destination.output);
        committed = true;
        await rm(backup, { recursive: true, force: true });
      } catch (error) {
        await rename(backup, destination.output).catch(() => {});
        throw error;
      }
    } else {
      await rename(temporaryRoot, destination.output);
      committed = true;
    }
    return Object.freeze({
      output: destination.output,
      manifestPath: join(destination.output, MANIFEST_FILE),
      manifest,
      stagedFiles: staged.length,
    });
  } finally {
    if (!committed) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function parseElectronRuntimeArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  const parsed = {
    output: null,
    target: DEFAULT_TARGET,
    replace: false,
    windowsBindingPath: null,
    windowsManifestPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--replace") {
      parsed.replace = true;
      continue;
    }
    if (!["--output", "--target", "--platform", "--windows-binding", "--windows-manifest",
      "--profile", "--version"].includes(argument)) {
      fail("INVALID_ARGUMENT", `Unknown Electron runtime argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail("INVALID_ARGUMENT", `Missing value for ${argument}`);
    }
    index += 1;
    if (argument === "--output") parsed.output = value;
    else if (argument === "--target" || argument === "--platform") {
      parsed.target = normalizeElectronTarget(value);
    }
    else if (argument === "--windows-binding") parsed.windowsBindingPath = value;
    else if (argument === "--profile") parsed.packagingProfile = normalizePackagingProfile(value);
    else if (argument === "--version") parsed.packageVersion = value;
    else parsed.windowsManifestPath = value;
  }
  if (!parsed.output) fail("INVALID_ARGUMENT", "--output /absolute/path is required");
  if ((parsed.windowsBindingPath && !parsed.windowsManifestPath)
      || (!parsed.windowsBindingPath && parsed.windowsManifestPath)) {
    fail("WINDOWS_BINDING_PAIR", "Windows binding and manifest must be supplied together");
  }
  if (parsed.target !== WINDOWS_X64_TARGET
      && (parsed.windowsBindingPath || parsed.windowsManifestPath)) {
    fail("WINDOWS_BINDING_TARGET", "Windows binding arguments require the Windows target");
  }
  return Object.freeze(parsed);
}

async function main(argv) {
  try {
    const parsed = parseElectronRuntimeArguments(argv);
    const result = await buildElectronRuntime(parsed);
    process.stdout.write(`${JSON.stringify({
      output: result.output,
      manifest: result.manifestPath,
      target: parsed.target,
      platform: result.manifest.target,
      architecture: result.manifest.architecture,
      files: result.manifest.files.length,
      payloadBytes: result.manifest.payload.bytes,
      payloadSha256: result.manifest.payload.sha256,
      windowsBinding: result.manifest.windowsBinding,
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  await main(process.argv.slice(2));
}
