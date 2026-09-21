#!/usr/bin/env node

/**
 * Runtime-neutral source closure and dependency-capture primitives.
 *
 * This module deliberately contains no native build, signing, updater, or
 * distribution policy.  The macOS builder and Electron runtime packager use
 * the same exact inputs and verification algorithms, while each surface keeps
 * its own release policy at its composition root.
 */

import { createHash } from "node:crypto";
import { lstat, readFile, readlink, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import { RELEASE_VERSION } from "../../config/release-manifest.js";
import { captureStableUtf8Source } from "./captured-utf8-source.mjs";
import { extractEsmImports } from "./esm-imports.mjs";

const MODULE_FILE = fileURLToPath(import.meta.url);
export const RUNTIME_REPOSITORY_ROOT = resolve(dirname(MODULE_FILE), "../..");
const RUNTIME_ENTRYPOINT = join(
  RUNTIME_REPOSITORY_ROOT,
  "apps",
  "local",
  "server.js",
);
const RUNTIME_WEB_MODULE_ROOT = join(
  RUNTIME_REPOSITORY_ROOT,
  "apps",
  "web",
  "public",
);

export const RUNTIME_WEB_MODULE_ENTRYPOINTS = Object.freeze([
  "apps/web/public/app.js",
  "apps/web/public/desktop-shell.js",
  "apps/web/public/electron-tray-popup.js",
  "apps/web/public/electron-settings.js",
  "apps/web/public/electron-tray-settings.js",
  "apps/web/public/electron-tray-preferences.js",
]);

export const RUNTIME_ALLOWED_GENERATED_FILES = Object.freeze([
  "generated/telemetry-v0.1-compatibility.json",
  "generated/telemetry-v0.1-field-dictionary.json",
]);
const RUNTIME_ALLOWED_GENERATED_FILE_SET = new Set(
  RUNTIME_ALLOWED_GENERATED_FILES,
);

export const RUNTIME_EXPECTED_EXTERNAL_SPECIFIERS = Object.freeze([
  "@app-usagemonitor/accounting",
  "@app-usagemonitor/identity-core",
  "@app-usagemonitor/quota-analysis",
  "@app-usagemonitor/telemetry-contract",
  "ajv",
  "runcost/browser",
]);

export const RUNTIME_WORKSPACE_PACKAGE_EXTERNALS = Object.freeze({
  "@app-usagemonitor/accounting": Object.freeze(["runcost/browser"]),
});

export const RUNTIME_PINNED_PACKAGES = Object.freeze({
  "@app-usagemonitor/accounting": RELEASE_VERSION,
  "@app-usagemonitor/identity-core": RELEASE_VERSION,
  "@app-usagemonitor/quota-analysis": RELEASE_VERSION,
  "@app-usagemonitor/telemetry-contract": RELEASE_VERSION,
  ajv: "8.20.0",
  "fast-deep-equal": "3.1.3",
  "fast-uri": "3.1.6",
  "json-schema-traverse": "1.0.0",
  "require-from-string": "2.0.2",
  runcost: "0.2.1",
});

// A name/version match authenticates attacker-retainable metadata only.  Keep
// the deterministic tree digests beside the pins so every consumer verifies
// the installed bytes before staging them.
export const RUNTIME_PINNED_PACKAGE_TREE_DIGESTS = Object.freeze({
  ajv: "7fecaf9a9ff3f41dabc7f7d762c7fecb8384c38a3c0dd4e6da0f3b3ef04569ca",
  "fast-deep-equal":
    "6c98665ed0585630ce02fbf064e6ed854f8e6546cb1e534158dbfbc18e05aa85",
  "fast-uri": "d267bdc69f6805e4b6dcab9d48d543c490ee3022adb3f7e1ba02f542f70e25c8",
  "json-schema-traverse":
    "71ac31baf5e8476eb746605c96d1961a1e7474d4491828506602cbf17b5c5af6",
  "require-from-string":
    "9e1890ada44ec4673a9170d2b2d1210c80e57e225c3ac07011fafbe5a9694da7",
  runcost: "873e747570e3dfeced68ada15d5144734356a8fc084d2618cb4f73565bd6929b",
});

const TELEMETRY_CONTRACT_PACKAGE_NAME =
  "@app-usagemonitor/telemetry-contract";
const ACCOUNTING_PACKAGE_NAME = "@app-usagemonitor/accounting";
const QUOTA_ANALYSIS_PACKAGE_NAME = "@app-usagemonitor/quota-analysis";
const IDENTITY_CORE_PACKAGE_NAME = "@app-usagemonitor/identity-core";

export const RUNTIME_TELEMETRY_CONTRACT_FILES = Object.freeze([
  "index.js",
  "package.json",
  "src/admin-model-history.js",
  "src/constants.js",
  "src/envelope.js",
  "src/errors.js",
  "src/model-catalog-contract.js",
  "src/model-catalog.js",
  "src/primitives.js",
  "src/telemetry-v0.1.js",
  "src/telemetry-v0.2.js",
  "src/telemetry-v1.1-domain.js",
  "src/telemetry-v1.1-schemas.js",
  "src/telemetry-v1.1.js",
  "src/upload.js",
]);

export const RUNTIME_ACCOUNTING_FILES = Object.freeze([
  "index.js",
  "package.json",
  "src/cost-ledger.js",
  "src/local-api-pricing.js",
  "src/price-registry.js",
  "src/subscription-speed.js",
]);

export const RUNTIME_QUOTA_ANALYSIS_FILES = Object.freeze([
  "index.js",
  "package.json",
  "src/model-composition.js",
  "src/plan-attribution.js",
  "src/quota-calibration.js",
  "src/quota-pace-forecast.js",
  "src/quota-rolling.js",
  "src/quota-tracks.js",
  "src/quota-windows.js",
  "src/reset-events.js",
]);

export const RUNTIME_IDENTITY_CORE_FILES = Object.freeze([
  "index.js",
  "package.json",
  "src/pseudonym.js",
]);

const packageRoot = (name) => join(
  RUNTIME_REPOSITORY_ROOT,
  "packages",
  name.split("/").at(-1),
);

export const RUNTIME_WORKSPACE_PACKAGE_DEFINITIONS = Object.freeze([
  Object.freeze({
    inputDirectory: "packages/accounting",
    name: ACCOUNTING_PACKAGE_NAME,
    root: packageRoot(ACCOUNTING_PACKAGE_NAME),
    runtimeFiles: RUNTIME_ACCOUNTING_FILES,
    version: RUNTIME_PINNED_PACKAGES[ACCOUNTING_PACKAGE_NAME],
  }),
  Object.freeze({
    inputDirectory: "packages/identity-core",
    name: IDENTITY_CORE_PACKAGE_NAME,
    root: packageRoot(IDENTITY_CORE_PACKAGE_NAME),
    runtimeFiles: RUNTIME_IDENTITY_CORE_FILES,
    version: RUNTIME_PINNED_PACKAGES[IDENTITY_CORE_PACKAGE_NAME],
  }),
  Object.freeze({
    inputDirectory: "packages/quota-analysis",
    name: QUOTA_ANALYSIS_PACKAGE_NAME,
    root: packageRoot(QUOTA_ANALYSIS_PACKAGE_NAME),
    runtimeFiles: RUNTIME_QUOTA_ANALYSIS_FILES,
    version: RUNTIME_PINNED_PACKAGES[QUOTA_ANALYSIS_PACKAGE_NAME],
  }),
  Object.freeze({
    inputDirectory: "packages/telemetry-contract",
    name: TELEMETRY_CONTRACT_PACKAGE_NAME,
    root: packageRoot(TELEMETRY_CONTRACT_PACKAGE_NAME),
    runtimeFiles: RUNTIME_TELEMETRY_CONTRACT_FILES,
    version: RUNTIME_PINNED_PACKAGES[TELEMETRY_CONTRACT_PACKAGE_NAME],
  }),
]);

const SOURCE_PATTERNS = Object.freeze([
  /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu,
  /import\s*\(\s*["']([^"']+)["']\s*\)/gu,
  /require(?:\.resolve)?\s*\(\s*["']([^"']+)["']\s*\)/gu,
  /new\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*,?\s*\)/gu,
]);

function fail(message, code = "RUNTIME_CLOSURE_FAILED") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function surfaceLabel(value) {
  return typeof value === "string" && value.length > 0 ? value : "runtime";
}

export function repositoryRelative(path, repositoryRoot = RUNTIME_REPOSITORY_ROOT) {
  const selected = relative(resolve(repositoryRoot), path);
  if (selected === ""
      || selected === ".."
      || selected.startsWith(`..${sep}`)) {
    fail("A runtime dependency escaped the repository");
  }
  return selected.split(sep).join("/");
}

export function reviewedRelative(root, path, label) {
  const selected = relative(root, path);
  if (selected === ""
      || selected === ".."
      || selected.startsWith(`..${sep}`)) {
    fail(`${label} escaped its reviewed root`);
  }
  return selected.split(sep).join("/");
}

export function resolveReviewedInput(root, selected, label) {
  if (typeof selected !== "string"
      || selected.length === 0
      || selected.includes("\0")
      || selected.includes("\\")
      || selected.startsWith("/")) {
    fail(`${label} must be a repository-relative path`);
  }
  const resolved = resolve(root, ...selected.split("/"));
  reviewedRelative(root, resolved, label);
  return resolved;
}

export async function assertReviewedDirectory(root, path, label) {
  reviewedRelative(root, path, label);
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(`${label} is not a regular directory`);
  }
  const [actualRoot, actualPath] = await Promise.all([
    realpath(root),
    realpath(path),
  ]);
  reviewedRelative(actualRoot, actualPath, label);
}

function packageSpecifier(specifier) {
  if (specifier === "runcost/browser"
      || specifier.startsWith("runcost/")) return "runcost/browser";
  if (specifier === "@github/keytar"
      || specifier.startsWith("@github/keytar/")) return "@github/keytar";
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
}

async function resolveRelativeSpecifier(fromFile, specifier, {
  repositoryRoot,
  label,
}) {
  const candidate = resolve(dirname(fromFile), specifier);
  const candidates = extname(candidate)
    ? [candidate]
    : [candidate, `${candidate}.js`, join(candidate, "index.js")];
  for (const selected of candidates) {
    let metadata;
    try {
      metadata = await lstat(selected);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      fail(`${label} source dependency is a symbolic link: ${repositoryRelative(selected, repositoryRoot)}`);
    }
    if (metadata.isFile()) return selected;
  }
  fail(
    `Static ${label.toLowerCase()} dependency is missing: ${repositoryRelative(fromFile, repositoryRoot)} -> ${specifier}`,
  );
}

export function assertAllowedFirstPartyPath(path, {
  repositoryRoot = RUNTIME_REPOSITORY_ROOT,
  allowedGeneratedFiles = RUNTIME_ALLOWED_GENERATED_FILE_SET,
  surface = "runtime",
} = {}) {
  const selected = repositoryRelative(path, repositoryRoot);
  const forbiddenPrefixes = [
    ".git/",
    ".release-build/",
    ".release-repro/",
    ".usage-monitor/",
    "docs/",
    "exports/",
    "local-review/",
    "test/",
  ];
  if (forbiddenPrefixes.some((prefix) => selected.startsWith(prefix))) {
    fail(`Forbidden repository tree is reachable from the ${surface}: ${selected}`);
  }
  const generated = allowedGeneratedFiles instanceof Set
    ? allowedGeneratedFiles
    : new Set(allowedGeneratedFiles);
  if (selected.startsWith("generated/") && !generated.has(selected)) {
    fail(`Generated output is not an approved runtime contract: ${selected}`);
  }
  if (/(?:^|\/)(?:credentials?|secrets?|quarantine|reports?|uploads?)(?:\/|$)/iu
      .test(selected)) {
    fail(`Private or generated data path is reachable from the ${surface}: ${selected}`);
  }
  return selected;
}

export async function collectRuntimeGraph({
  entrypoint = RUNTIME_ENTRYPOINT,
  repositoryRoot = RUNTIME_REPOSITORY_ROOT,
  allowedGeneratedFiles = RUNTIME_ALLOWED_GENERATED_FILE_SET,
  expectedExternalSpecifiers = RUNTIME_EXPECTED_EXTERNAL_SPECIFIERS,
  workspacePackageExternals = RUNTIME_WORKSPACE_PACKAGE_EXTERNALS,
  surface = "runtime",
} = {}) {
  const selectedRepositoryRoot = resolve(repositoryRoot);
  const pending = [resolve(entrypoint)];
  const files = new Set();
  const builtins = new Set();
  const external = new Set();
  const label = surfaceLabel(surface);
  while (pending.length > 0) {
    const file = pending.pop();
    if (files.has(file)) continue;
    assertAllowedFirstPartyPath(file, {
      repositoryRoot: selectedRepositoryRoot,
      allowedGeneratedFiles,
      surface: label,
    });
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail(`Runtime source is not a regular file: ${repositoryRelative(file, selectedRepositoryRoot)}`);
    }
    files.add(file);
    if (![".js", ".mjs"].includes(extname(file))) continue;
    const source = await readFile(file, "utf8");
    for (const sourcePattern of SOURCE_PATTERNS) {
      // RegExp instances with the global flag carry mutable lastIndex state.
      // Use a fresh scanner for each source so concurrent builds stay equal.
      const pattern = new RegExp(sourcePattern.source, sourcePattern.flags);
      for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
        const specifier = match[1];
        if (specifier.startsWith(".")) {
          const dependency = await resolveRelativeSpecifier(file, specifier, {
            repositoryRoot: selectedRepositoryRoot,
            label,
          });
          if (!files.has(dependency)) pending.push(dependency);
        } else if (specifier.startsWith("node:")) {
          builtins.add(specifier);
        } else {
          external.add(packageSpecifier(specifier));
        }
      }
    }
  }
  for (const packageName of [...external]) {
    for (const dependency of workspacePackageExternals[packageName] ?? []) {
      external.add(dependency);
    }
  }
  const externalSpecifiers = [...external].sort();
  if (JSON.stringify(externalSpecifiers)
      !== JSON.stringify([...expectedExternalSpecifiers].sort())) {
    fail(
      `Unexpected ${label.toLowerCase()} dependency closure: ${externalSpecifiers.join(", ")}`,
    );
  }
  const relativeFile = (file) => repositoryRelative(file, selectedRepositoryRoot);
  return Object.freeze({
    files: Object.freeze([...files].sort((left, right) =>
      relativeFile(left).localeCompare(relativeFile(right)))),
    relativeFiles: Object.freeze([...files].map(relativeFile).sort()),
    builtins: Object.freeze([...builtins].sort()),
    externalSpecifiers: Object.freeze(externalSpecifiers),
  });
}

async function webModuleSpecifiers(source, label) {
  let imports;
  try {
    imports = await extractEsmImports(source, { sourceName: label });
  } catch {
    fail(`Reviewed ${label} web module is not valid static ESM`);
  }
  if (imports.some(({ kind }) => kind === "dynamic-import")) {
    fail(`Dynamic import is not allowed in the reviewed ${label} web bundle`);
  }
  const specifiers = imports.map(({ specifier }) => specifier);
  if (specifiers.some((specifier) => typeof specifier !== "string")) {
    fail(`Reviewed ${label} web module parser returned invalid output`);
  }
  return [...new Set(specifiers)].sort();
}

async function reviewedRegularFile(path, {
  allowedRoot,
  label,
  repositoryRoot,
  surface,
}) {
  reviewedRelative(allowedRoot, path, label);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") fail(`Reviewed ${label} web module is missing`);
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`Reviewed ${label} web module is not a regular file`);
  }
  const [actualRoot, actualFile] = await Promise.all([
    realpath(allowedRoot),
    realpath(path),
  ]);
  reviewedRelative(actualRoot, actualFile, label);
  if (resolve(repositoryRoot) === RUNTIME_REPOSITORY_ROOT) {
    assertAllowedFirstPartyPath(path, { repositoryRoot, surface });
  }
}

export async function collectWebModuleGraph({
  allowedRoot = RUNTIME_WEB_MODULE_ROOT,
  entrypoints = RUNTIME_WEB_MODULE_ENTRYPOINTS,
  repositoryRoot = RUNTIME_REPOSITORY_ROOT,
  capturedModuleSources = new Map(),
  surface = "runtime",
} = {}) {
  const selectedRepositoryRoot = resolve(repositoryRoot);
  const selectedAllowedRoot = resolve(allowedRoot);
  const label = surfaceLabel(surface);
  reviewedRelative(
    selectedRepositoryRoot,
    selectedAllowedRoot,
    `${label} web module root`,
  );
  await assertReviewedDirectory(
    selectedRepositoryRoot,
    selectedAllowedRoot,
    `${label} web module root`,
  );
  if (!Array.isArray(entrypoints) || entrypoints.length === 0) {
    fail(`At least one reviewed ${label} web module entrypoint is required`);
  }
  if (!(capturedModuleSources instanceof Map)) {
    fail("capturedModuleSources must be a Map when provided");
  }
  const pending = entrypoints.map((entrypoint) =>
    resolveReviewedInput(
      selectedRepositoryRoot,
      entrypoint,
      `${label} web module entrypoint`,
    ));
  const files = new Set();
  const modules = new Map();
  while (pending.length > 0) {
    const file = pending.pop();
    if (files.has(file)) continue;
    const relativeFile = reviewedRelative(
      selectedRepositoryRoot,
      file,
      `${label} web module`,
    );
    await reviewedRegularFile(file, {
      allowedRoot: selectedAllowedRoot,
      label: relativeFile,
      repositoryRoot: selectedRepositoryRoot,
      surface: label,
    });
    if (![".js", ".mjs"].includes(extname(file))) {
      fail(`Unsupported ${label} web module extension: ${relativeFile}`);
    }
    files.add(file);
    const captured = capturedModuleSources.get(file);
    let source;
    if (captured === undefined) {
      source = await readFile(file, "utf8");
    } else {
      if (captured === null || typeof captured !== "object"
          || typeof captured.sourceText !== "string"
          || typeof captured.sha256 !== "string"
          || !Number.isSafeInteger(captured.byteLength)
          || captured.byteLength < 0) {
        fail(`Captured ${label} web module record is invalid: ${relativeFile}`);
      }
      const capturedSha256 = createHash("sha256")
        .update(captured.sourceText, "utf8")
        .digest("hex");
      const capturedByteLength = Buffer.byteLength(captured.sourceText, "utf8");
      if (captured.sha256 !== capturedSha256
          || captured.byteLength !== capturedByteLength) {
        fail(`Captured ${label} web module record is inconsistent: ${relativeFile}`);
      }
      source = captured.sourceText;
    }
    modules.set(file, Object.freeze({
      file,
      relativeFile,
      sourceText: source,
      sha256: createHash("sha256").update(source, "utf8").digest("hex"),
      byteLength: Buffer.byteLength(source, "utf8"),
    }));
    for (const specifier of await webModuleSpecifiers(source, label)) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        fail(
          `${label} web modules may import only local relative modules: ${relativeFile} -> ${specifier}`,
        );
      }
      if (specifier.includes("\0")
          || specifier.includes("\\")
          || specifier.includes("?")
          || specifier.includes("#")) {
        fail(`Unsafe ${label} web module import: ${relativeFile} -> ${specifier}`);
      }
      const dependency = resolve(dirname(file), specifier);
      reviewedRelative(
        selectedAllowedRoot,
        dependency,
        `${label} web module import ${relativeFile} -> ${specifier}`,
      );
      if (![".js", ".mjs"].includes(extname(dependency))) {
        fail(
          `${label} web module imports must name a .js or .mjs file: ${relativeFile} -> ${specifier}`,
        );
      }
      if (!files.has(dependency)) pending.push(dependency);
    }
  }
  const sortedFiles = [...files].sort((left, right) =>
    reviewedRelative(selectedRepositoryRoot, left, `${label} web module`)
      .localeCompare(
        reviewedRelative(selectedRepositoryRoot, right, `${label} web module`),
      ));
  return Object.freeze({
    files: Object.freeze(sortedFiles),
    relativeFiles: Object.freeze(sortedFiles.map((file) =>
      reviewedRelative(selectedRepositoryRoot, file, `${label} web module`))),
    modules: Object.freeze(sortedFiles.map((file) => modules.get(file))),
  });
}

export async function readRuntimePackageManifest(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function pinnedPackageTreeDigest(packageRoot) {
  const resolvedRoot = await realpath(packageRoot);
  const hash = createHash("sha256");
  async function walk(absolute, relativePath) {
    const entries = await readdir(absolute, { withFileTypes: true });
    entries.sort((left, right) => (
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    ));
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const childAbsolute = join(absolute, entry.name);
      const childRelative = relativePath === ""
        ? entry.name
        : `${relativePath}/${entry.name}`;
      const info = await lstat(childAbsolute);
      if (info.isSymbolicLink()) {
        hash.update(`L\0${childRelative}\0${await readlink(childAbsolute)}\0`);
      } else if (info.isDirectory()) {
        hash.update(`D\0${childRelative}\0`);
        await walk(childAbsolute, childRelative);
      } else if (info.isFile()) {
        const fileHash = createHash("sha256")
          .update(await readFile(childAbsolute))
          .digest("hex");
        hash.update(`F\0${childRelative}\0${info.size}\0${fileHash}\0`);
      } else {
        hash.update(`O\0${childRelative}\0`);
      }
    }
  }
  await walk(resolvedRoot, "");
  return hash.digest("hex");
}

export async function pinnedPackage(name, packagePath, {
  pinnedPackages = RUNTIME_PINNED_PACKAGES,
  pinnedTreeDigests = RUNTIME_PINNED_PACKAGE_TREE_DIGESTS,
} = {}) {
  const manifest = await readRuntimePackageManifest(packagePath);
  if (manifest.name !== name || manifest.version !== pinnedPackages[name]) {
    fail(`Pinned package mismatch for ${name}`);
  }
  const expectedDigest = pinnedTreeDigests[name];
  if (typeof expectedDigest !== "string") {
    fail(`Missing reviewed tree digest for pinned package ${name}`);
  }
  const treeDigest = await pinnedPackageTreeDigest(dirname(packagePath));
  if (treeDigest !== expectedDigest) {
    fail(`Pinned package tree digest mismatch for ${name}`);
  }
  return {
    name,
    version: manifest.version,
    license: manifest.license ?? null,
    treeDigest,
  };
}

export function validateCapturedWorkspaceRuntimePackages(packages, {
  surface = "runtime",
} = {}) {
  const label = surface === "macOS" ? "macOS" : "runtime";
  if (!Array.isArray(packages) || packages.length === 0) {
    fail(`Captured ${label} workspace runtime packages are invalid`);
  }
  const packageNames = new Set();
  const inputPaths = new Set();
  for (const packageCapture of packages) {
    if (packageCapture === null || typeof packageCapture !== "object"
        || typeof packageCapture.name !== "string"
        || !/^@[a-z0-9._-]+\/[a-z0-9._-]+$/u.test(packageCapture.name)
        || typeof packageCapture.version !== "string"
        || typeof packageCapture.inputDirectory !== "string"
        || packageCapture.inputDirectory.startsWith("/")
        || packageCapture.inputDirectory.includes("\\")
        || packageCapture.inputDirectory.split("/").some((part) =>
          part === "" || part === "." || part === "..")
        || !Array.isArray(packageCapture.files)
        || packageCapture.files.length === 0) {
      fail(`Captured ${label} workspace runtime package is invalid`);
    }
    if (packageNames.has(packageCapture.name)) {
      fail(`Duplicate captured ${label} workspace package: ${packageCapture.name}`);
    }
    packageNames.add(packageCapture.name);
    const relativeFiles = new Set();
    for (const file of packageCapture.files) {
      if (file === null || typeof file !== "object"
          || typeof file.relativeFile !== "string"
          || file.relativeFile.length === 0
          || file.relativeFile.startsWith("/")
          || file.relativeFile.includes("\\")
          || file.relativeFile.split("/").some((part) =>
            part === "" || part === "." || part === "..")
          || typeof file.inputPath !== "string"
          || file.inputPath.startsWith("/")
          || file.inputPath.includes("\\")
          || file.inputPath.split("/").some((part) =>
            part === "" || part === "." || part === "..")
          || typeof file.sourceText !== "string"
          || typeof file.sha256 !== "string"
          || !Number.isSafeInteger(file.byteLength)
          || file.byteLength < 0) {
        fail(`Captured ${label} workspace package file is invalid: ${packageCapture.name}`);
      }
      if (relativeFiles.has(file.relativeFile)) {
        fail(`Duplicate captured ${label} workspace package file: ${file.relativeFile}`);
      }
      relativeFiles.add(file.relativeFile);
      const expectedInputPath = [
        packageCapture.inputDirectory,
        file.relativeFile,
      ].join("/");
      if (file.inputPath !== expectedInputPath) {
        fail(`Captured ${label} workspace package input is inconsistent: ${file.inputPath}`);
      }
      if (inputPaths.has(file.inputPath)) {
        fail(`Duplicate captured ${label} workspace input: ${file.inputPath}`);
      }
      inputPaths.add(file.inputPath);
      const byteLength = Buffer.byteLength(file.sourceText, "utf8");
      const sha256 = createHash("sha256")
        .update(file.sourceText, "utf8")
        .digest("hex");
      if (file.byteLength !== byteLength || file.sha256 !== sha256) {
        fail(`Captured ${label} workspace package file is inconsistent: ${file.inputPath}`);
      }
    }
  }
  return true;
}

export function assertWorkspaceRuntimePackageCaptures(packages, {
  packageDefinitions = RUNTIME_WORKSPACE_PACKAGE_DEFINITIONS,
  surface = "runtime",
} = {}) {
  const label = surface === "macOS" ? "macOS" : "runtime";
  validateCapturedWorkspaceRuntimePackages(packages, { surface });
  const expected = new Map(packageDefinitions.map((definition) => [
    definition.name,
    definition,
  ]));
  if (packages.length !== expected.size) {
    fail(`The ${label} workspace package closure is incomplete`);
  }
  for (const packageCapture of packages) {
    const definition = expected.get(packageCapture.name);
    if (!definition || packageCapture.version !== definition.version
        || packageCapture.inputDirectory !== definition.inputDirectory) {
      fail(`Unexpected captured ${label} workspace package: ${packageCapture.name}`);
    }
    if (JSON.stringify(packageCapture.files.map(({ relativeFile }) => relativeFile))
        !== JSON.stringify(definition.runtimeFiles)) {
      fail(`Captured ${label} workspace package closure changed: ${packageCapture.name}`);
    }
  }
  return true;
}

export async function captureWorkspaceRuntimePackages({
  packageDefinitions = RUNTIME_WORKSPACE_PACKAGE_DEFINITIONS,
  repositoryRoot = RUNTIME_REPOSITORY_ROOT,
  pinnedPackages = RUNTIME_PINNED_PACKAGES,
  surface = "runtime",
  postOpenPreReadFailpoint = null,
  resolvePackageEntrypoint = null,
} = {}) {
  const label = surface === "macOS" ? "macOS" : "runtime";
  if (!Array.isArray(packageDefinitions) || packageDefinitions.length === 0
      || (postOpenPreReadFailpoint !== null
        && typeof postOpenPreReadFailpoint !== "function")
      || (resolvePackageEntrypoint !== null
        && typeof resolvePackageEntrypoint !== "function")) {
    fail(`${label} workspace runtime package capture options are invalid`);
  }
  const selectedRepositoryRoot = resolve(repositoryRoot);
  const rootRequire = createRequire(join(selectedRepositoryRoot, "package.json"));
  const resolveEntrypoint = resolvePackageEntrypoint
    ?? ((name) => rootRequire.resolve(name));
  const captures = [];
  for (const definition of packageDefinitions) {
    if (definition === null || typeof definition !== "object"
        || typeof definition.name !== "string"
        || typeof definition.version !== "string"
        || typeof definition.root !== "string"
        || typeof definition.inputDirectory !== "string"
        || definition.inputDirectory.startsWith("/")
        || definition.inputDirectory.includes("\\")
        || definition.inputDirectory.split("/").some((part) =>
          part === "" || part === "." || part === "..")
        || !Array.isArray(definition.runtimeFiles)
        || definition.runtimeFiles.length === 0) {
      fail(`${label} workspace runtime package definition is invalid`);
    }
    const root = resolve(definition.root);
    const rootMetadata = await lstat(root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      fail(`${label} workspace package root is not a regular directory: ${definition.name}`);
    }
    const actualRoot = await realpath(root);
    const expectedEntrypoint = join(actualRoot, "index.js");
    if (await realpath(await resolveEntrypoint(definition.name))
        !== await realpath(expectedEntrypoint)) {
      fail(`The ${definition.name} workspace dependency resolved unexpectedly`);
    }
    const files = [];
    const relativeFiles = new Set();
    for (const relativeFile of definition.runtimeFiles) {
      if (typeof relativeFile !== "string" || relativeFile.length === 0
          || relativeFile.startsWith("/") || relativeFile.includes("\\")
          || relativeFile.includes("\0") || relativeFiles.has(relativeFile)) {
        fail(`Invalid ${label} workspace package runtime file: ${definition.name}`);
      }
      relativeFiles.add(relativeFile);
      const sourceFile = resolve(root, ...relativeFile.split("/"));
      reviewedRelative(root, sourceFile, `${definition.name} runtime file`);
      const failureMessage =
        `${label} workspace package runtime source is not a stable regular UTF-8 file: ${relativeFile}`;
      const captured = await captureStableUtf8Source(sourceFile, {
        failureMessage,
        maximumBytes: 1024 * 1024,
        postOpenPreReadFailpoint,
      });
      const resolvedSourceFile = await realpath(sourceFile).catch(() => {
        fail(failureMessage);
      });
      reviewedRelative(actualRoot, resolvedSourceFile, `${definition.name} runtime file`);
      files.push(Object.freeze({
        byteLength: captured.byteLength,
        inputPath: join(definition.inputDirectory, relativeFile)
          .split(sep).join("/"),
        relativeFile,
        sha256: captured.sha256,
        sourceText: captured.sourceText,
      }));
    }
    const manifestFile = files.find(({ relativeFile }) => relativeFile === "package.json");
    let manifest;
    try {
      manifest = JSON.parse(manifestFile?.sourceText ?? "");
    } catch {
      fail(`Captured ${label} package manifest is invalid: ${definition.name}`);
    }
    if (manifest.name !== definition.name
        || manifest.version !== definition.version
        || definition.version !== pinnedPackages[definition.name]) {
      fail(`Pinned ${label} package mismatch for ${definition.name}`);
    }
    captures.push(Object.freeze({
      files: Object.freeze(files),
      inputDirectory: definition.inputDirectory,
      license: manifest.license ?? null,
      name: definition.name,
      version: manifest.version,
    }));
  }
  captures.sort((left, right) => left.name.localeCompare(right.name));
  validateCapturedWorkspaceRuntimePackages(captures, { surface });
  return Object.freeze(captures);
}

export const runtimeClosureForTest = Object.freeze({
  sourcePatterns: SOURCE_PATTERNS,
  allowedGeneratedFiles: RUNTIME_ALLOWED_GENERATED_FILES,
});
