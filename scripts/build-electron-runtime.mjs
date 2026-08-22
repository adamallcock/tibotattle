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

import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { constants as fileSystemConstants } from "node:fs";
import {
  lstat as fsLstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

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
} from "./build-macos-app.js";
import { RELEASE_VERSION } from "../config/release-manifest.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const MANIFEST_FILE = "electron-runtime-manifest.json";
const MANIFEST_SCHEMA = "usage-monitor-electron-runtime-v0.1";
const MAXIMUM_BINDING_BYTES = 64 * 1024 * 1024;
const MAXIMUM_MANIFEST_BYTES = 1 * 1024 * 1024;
const DEFAULT_TARGET = "darwin";
const WINDOWS_TARGET = "win32";
const DARWIN_TARGET = "darwin";
const WINDOWS_BINDING_RELATIVE_PATH =
  "native/windows-filesystem/build/Release/windows_filesystem.node";
const WINDOWS_MANIFEST_RELATIVE_PATH =
  `${WINDOWS_BINDING_RELATIVE_PATH}.manifest.json`;
export const ELECTRON_SHELL_RUNTIME_FILES = Object.freeze([
  "apps/electron/companion-supervisor.js",
  "apps/electron/desktop-lifecycle.js",
  "apps/electron/errors.js",
  "apps/electron/loopback-policy.js",
  "apps/electron/main.js",
  "apps/electron/platform-gate.js",
  "apps/electron/preload.js",
  "apps/electron/ready-line.js",
  "apps/electron/windows-qualification.js",
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
  "apps/electron/preload.js",
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

function normalizeTarget(value = DEFAULT_TARGET) {
  if (value === "macos" || value === "macOS") return DARWIN_TARGET;
  if (value === "windows" || value === "win") return WINDOWS_TARGET;
  if (value === DARWIN_TARGET || value === WINDOWS_TARGET) return value;
  fail("INVALID_TARGET", `Unsupported Electron runtime target: ${value}`);
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

function pathIsInside(parent, child) {
  const suffix = relative(resolve(parent), resolve(child));
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`)
    && !isAbsolute(suffix));
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
  const outputIsInsideRepository = repositoryRelativeOutput !== ""
    && repositoryRelativeOutput !== ".."
    && !repositoryRelativeOutput.startsWith("../");
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

async function stageCapturedWorkspacePackages({ stagingRoot, captures }) {
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
      await writeCapturedFile(destination, Buffer.from(file.sourceText, "utf8"));
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

async function stagePackageFiles({ stagingRoot, name, packageRoot, include }) {
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
      captured.bytes,
      /\.node$/u.test(relativeFile) ? 0o555 : 0o444,
    );
    staged.push({ kind: THIRD_PARTY_KIND, path: relativePath });
  }
  return staged;
}

async function resolveThirdPartyPackages(repositoryRoot, target) {
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
  const keytar = await pinnedPackage("@github/keytar", keytarPackage);
  const keytarArchitecture = target === WINDOWS_TARGET
    ? "win32-x64"
    : "darwin-arm64";
  return Object.freeze({
    ajv: { name: "ajv", root: ajvRoot, pin: ajv },
    keytar: { name: "@github/keytar", root: keytarRoot, pin: keytar, keytarArchitecture },
    runcost: { name: "runcost", root: runcostRoot, pin: runcost },
    transitive: Object.freeze(transitive),
  });
}

async function stageThirdPartyPackages({ stagingRoot, packages }) {
  const staged = [];
  staged.push(...await stagePackageFiles({
    stagingRoot,
    name: packages.ajv.name,
    packageRoot: packages.ajv.root,
    include: (path) => path === "package.json"
      || path === "LICENSE"
      || (path.startsWith("dist/") && (path.endsWith(".js") || path.endsWith(".json"))),
  }));
  for (const packageInfo of packages.transitive) {
    staged.push(...await stagePackageFiles({
      stagingRoot,
      name: packageInfo.name,
      packageRoot: packageInfo.root,
      include: packageRuntimeFile,
    }));
  }
  staged.push(...await stagePackageFiles({
    stagingRoot,
    name: packages.runcost.name,
    packageRoot: packages.runcost.root,
    include: (path) => path === "browser.js" || path === "package.json",
  }));
  const keytarArchitecture = packages.keytar.keytarArchitecture;
  staged.push(...await stagePackageFiles({
    stagingRoot,
    name: packages.keytar.name,
    packageRoot: packages.keytar.root,
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
      || manifest?.platform !== WINDOWS_TARGET
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

function validateRuntimeManifestShape(manifest) {
  assertManifestContentFree(manifest);
  if (!exactObjectKeys(manifest, [
    "architecture", "dashboardRoot", "entrypoint", "files", "payload",
    "releaseVersion", "schemaVersion", "target", "windowsBinding",
  ])) {
    fail("EXISTING_OUTPUT_INVALID", "Runtime manifest has an unexpected schema");
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA
      || manifest.releaseVersion !== RELEASE_VERSION
      || !["apps/local/server.js", "apps/electron/main.js"].includes(manifest.entrypoint)
      || manifest.dashboardRoot !== "apps/web/public"
      || ![DARWIN_TARGET, WINDOWS_TARGET].includes(manifest.target)
      || manifest.architecture !== (manifest.target === WINDOWS_TARGET ? "x64" : "arm64")) {
    fail("EXISTING_OUTPUT_INVALID", "Runtime manifest identity does not match this packager");
  }
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

async function validateExistingRuntime(output) {
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
  validateRuntimeManifestShape(manifest);
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
} = {}) {
  if (typeof includeElectronShell !== "boolean") {
    fail("INVALID_SHELL_MODE", "includeElectronShell must be a boolean");
  }
  const selectedTarget = normalizeTarget(target);
  if (selectedTarget !== WINDOWS_TARGET
      && (windowsBindingPath || windowsManifestPath)) {
    fail("WINDOWS_BINDING_TARGET", "Windows binding arguments require the Windows target");
  }
  const destination = await validateOutputDestination(output, REPOSITORY_ROOT, replace);
  if (destination.existed) await validateExistingRuntime(destination.output);
  const temporaryRoot = await mkdtemp(join(
    destination.parent,
    `.${basename(destination.output)}.staging-`,
  ));
  let committed = false;
  try {
    const runtimeGraph = await collectMacOSRuntimeGraph();
    const webGraph = await collectMacOSWebModuleGraph();
    const staged = [];
    for (const relativePath of runtimeGraph.relativeFiles) {
      if (relativePath === "package.json") continue;
      staged.push(await stageRepositoryFile({
        repositoryRoot: REPOSITORY_ROOT,
        stagingRoot: temporaryRoot,
        relativePath,
        kind: SOURCE_FILE_KIND,
      }));
    }
    const webFiles = new Set([
      ...webGraph.relativeFiles,
      ...Object.values(LOCAL_COMPANION_STATIC_FILES).map(({ file }) =>
        `apps/web/public/${file}`),
    ]);
    for (const relativePath of [...webFiles].sort(comparePathBytes)) {
      staged.push(await stageRepositoryFile({
        repositoryRoot: REPOSITORY_ROOT,
        stagingRoot: temporaryRoot,
        relativePath,
        kind: WEB_FILE_KIND,
      }));
    }

    if (includeElectronShell) {
      for (const relativePath of ELECTRON_SHELL_RUNTIME_FILES) {
        staged.push(await stageRepositoryFile({
          repositoryRoot: REPOSITORY_ROOT,
          stagingRoot: temporaryRoot,
          relativePath,
          kind: ELECTRON_SHELL_KIND,
        }));
      }
    }

    const captures = await captureMacOSWorkspaceRuntimePackages();
    staged.push(...await stageCapturedWorkspacePackages({
      stagingRoot: temporaryRoot,
      captures,
    }));
    const packages = await resolveThirdPartyPackages(REPOSITORY_ROOT, selectedTarget);
    staged.push(...await stageThirdPartyPackages({
      stagingRoot: temporaryRoot,
      packages,
    }));

    await writeRegularFile(
      outputPath(temporaryRoot, "package.json"),
      stableJson({
        engines: { node: ">=22.13.0" },
        main: includeElectronShell ? "apps/electron/main.js" : "apps/local/server.js",
        name: "app-usagemonitor",
        private: true,
        type: "module",
        version: RELEASE_VERSION,
      }),
    );

    let windowsBinding;
    if (selectedTarget === WINDOWS_TARGET) {
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
      target: selectedTarget,
      architecture: selectedTarget === WINDOWS_TARGET ? "x64" : "arm64",
      releaseVersion: RELEASE_VERSION,
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
    if (destination.existed) await validateExistingRuntime(destination.output);
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
    if (!["--output", "--target", "--platform", "--windows-binding", "--windows-manifest"].includes(argument)) {
      fail("INVALID_ARGUMENT", `Unknown Electron runtime argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail("INVALID_ARGUMENT", `Missing value for ${argument}`);
    }
    index += 1;
    if (argument === "--output") parsed.output = value;
    else if (argument === "--target" || argument === "--platform") parsed.target = normalizeTarget(value);
    else if (argument === "--windows-binding") parsed.windowsBindingPath = value;
    else parsed.windowsManifestPath = value;
  }
  if (!parsed.output) fail("INVALID_ARGUMENT", "--output /absolute/path is required");
  if ((parsed.windowsBindingPath && !parsed.windowsManifestPath)
      || (!parsed.windowsBindingPath && parsed.windowsManifestPath)) {
    fail("WINDOWS_BINDING_PAIR", "Windows binding and manifest must be supplied together");
  }
  if (parsed.target !== WINDOWS_TARGET
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
      target: result.manifest.target,
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
