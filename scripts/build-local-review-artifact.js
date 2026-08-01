#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import { extractEsmImports } from "./lib/esm-imports.mjs";
import { captureStableUtf8Source } from "./lib/captured-utf8-source.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIRECTORY = dirname(SCRIPT_FILE);
const ESM_IMPORT_HELPER = fileURLToPath(
  new URL("./lib/esm-imports.mjs", import.meta.url),
);
const CAPTURED_UTF8_SOURCE_HELPER = fileURLToPath(
  new URL("./lib/captured-utf8-source.mjs", import.meta.url),
);
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const ARTIFACT_VERSION = "0.1.0-alpha.1";
const ROOT_NAME = `usage-monitor-local-review-${ARTIFACT_VERSION}-darwin-arm64`;
const DEFAULT_BUILD_ROOT = join(REPOSITORY_ROOT, ".release-build");
const ENTRYPOINT = join(REPOSITORY_ROOT, "local-review", "cli.js");
const RELEASE_CONTRACT = join(
  REPOSITORY_ROOT,
  "local-review",
  "release-contract.json",
);
const PINNED_NODE = resolve(process.execPath);
const PINNED_NODE_LICENSE = resolve(dirname(PINNED_NODE), "..", "LICENSE");
const BUILD_ROOT_MARKER = ".usage-monitor-local-review-build-root-v0.1";
const BUILD_ROOT_MARKER_BYTES = "usage-monitor local-review generated build root v0.1\n";
const FORBIDDEN_BUILTINS = new Set([
  "node:http",
  "node:https",
  "node:http2",
  "node:net",
  "node:tls",
  "node:dns",
  "node:dgram",
]);
const EXPECTED_EXTERNAL_SPECIFIERS = Object.freeze([
  "@app-usagemonitor/identity-core",
  "@github/keytar",
  "ajv",
]);
const DYNAMIC_EXTERNAL_BY_FILE = Object.freeze({
  "src/platform/export-identity-keychain.js": "@github/keytar",
});
const PINNED_RUNTIME_PACKAGES = Object.freeze({
  "@app-usagemonitor/identity-core": Object.freeze({
    version: "0.1.0",
    license: "LicenseRef-Proprietary",
  }),
  "@github/keytar": Object.freeze({
    version: "7.10.6",
    license: "MIT",
  }),
  ajv: Object.freeze({
    version: "8.20.0",
    license: "MIT",
  }),
  "fast-deep-equal": Object.freeze({
    version: "3.1.3",
    license: "MIT",
  }),
  "fast-uri": Object.freeze({
    version: "3.1.4",
    license: "BSD-3-Clause",
  }),
  "json-schema-traverse": Object.freeze({
    version: "1.0.0",
    license: "MIT",
  }),
  "require-from-string": Object.freeze({
    version: "2.0.2",
    license: "MIT",
  }),
});
const IDENTITY_CORE_PACKAGE_NAME = "@app-usagemonitor/identity-core";
const IDENTITY_CORE_PACKAGE_ROOT = join(
  REPOSITORY_ROOT,
  "packages",
  "identity-core",
);
export const LOCAL_REVIEW_IDENTITY_CORE_RUNTIME_FILES = Object.freeze([
  "index.js",
  "package.json",
  "src/pseudonym.js",
]);
const FORBIDDEN_SOURCE_BASENAMES = [
  /^contribution-/,
  /^local-companion-/,
  /^passive-collector/,
  /^telemetry-contribution/,
  /^telemetry-prepared-set/,
];
const FORBIDDEN_SOURCE_PATHS = [
  /^src\/providers\/codex\/app-server(?:\.|\/|$)/u,
];
const SOURCE_PATTERNS = [
  /require(?:\.resolve)?\s*\(\s*["']([^"']+)["']\s*\)/g,
  /new\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*,?\s*\)/g,
];

function fail(message, code = "LOCAL_REVIEW_BUILD_FAILED") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(path) {
  return sha256(await readFile(path));
}

function repositoryRelative(path) {
  const value = relative(REPOSITORY_ROOT, path);
  if (value === "" || value === ".." || value.startsWith(`..${sep}`)) {
    fail("Dependency graph escaped the repository");
  }
  return value.split(sep).join("/");
}

function relativeWithin(root, path, label) {
  const value = relative(root, path);
  if (value === "" || value === ".." || value.startsWith(`..${sep}`)) {
    fail(`${label} escaped its reviewed root`);
  }
  return value.split(sep).join("/");
}

function validateIdentityCoreRuntimeCapture(capture) {
  if (capture === null || typeof capture !== "object"
      || capture.name !== IDENTITY_CORE_PACKAGE_NAME
      || capture.version
        !== PINNED_RUNTIME_PACKAGES[IDENTITY_CORE_PACKAGE_NAME].version
      || capture.inputDirectory !== "packages/identity-core"
      || !Array.isArray(capture.files)
      || capture.files.length !== LOCAL_REVIEW_IDENTITY_CORE_RUNTIME_FILES.length) {
    fail("Captured local-review identity-core closure is invalid");
  }
  for (const [index, file] of capture.files.entries()) {
    const relativeFile = LOCAL_REVIEW_IDENTITY_CORE_RUNTIME_FILES[index];
    const inputPath = `packages/identity-core/${relativeFile}`;
    if (file === null || typeof file !== "object"
        || file.relativeFile !== relativeFile
        || file.inputPath !== inputPath
        || typeof file.sourceText !== "string"
        || file.byteLength !== Buffer.byteLength(file.sourceText, "utf8")
        || file.sha256 !== sha256(Buffer.from(file.sourceText, "utf8"))) {
      fail(`Captured local-review identity-core file is invalid: ${relativeFile}`);
    }
  }
  return true;
}

export async function captureLocalReviewIdentityCoreRuntime({
  packageRoot = IDENTITY_CORE_PACKAGE_ROOT,
  postOpenPreReadFailpoint = null,
  resolvePackageEntrypoint = null,
} = {}) {
  if (typeof packageRoot !== "string"
      || (postOpenPreReadFailpoint !== null
        && typeof postOpenPreReadFailpoint !== "function")
      || (resolvePackageEntrypoint !== null
        && typeof resolvePackageEntrypoint !== "function")) {
    fail("Local-review identity-core capture options are invalid");
  }
  const root = resolve(packageRoot);
  const rootMetadata = await lstat(root).catch((error) => {
    if (error?.code === "ENOENT") {
      fail("Local-review identity-core package root is not a regular directory");
    }
    throw error;
  });
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail("Local-review identity-core package root is not a regular directory");
  }
  const actualRoot = await realpath(root);
  const rootRequire = createRequire(join(REPOSITORY_ROOT, "package.json"));
  const resolveEntrypoint = resolvePackageEntrypoint
    ?? (() => rootRequire.resolve(IDENTITY_CORE_PACKAGE_NAME));
  const resolvedEntrypoint = await realpath(
    await resolveEntrypoint(IDENTITY_CORE_PACKAGE_NAME),
  );
  if (resolvedEntrypoint !== await realpath(join(actualRoot, "index.js"))) {
    fail("The local-review identity-core dependency resolved unexpectedly");
  }
  const files = [];
  for (const relativeFile of LOCAL_REVIEW_IDENTITY_CORE_RUNTIME_FILES) {
    const sourceFile = resolve(root, ...relativeFile.split("/"));
    relativeWithin(root, sourceFile, "Local-review identity-core runtime file");
    const failureMessage =
      `Local-review identity-core runtime source is not a stable regular UTF-8 file: ${relativeFile}`;
    const captured = await captureStableUtf8Source(sourceFile, {
      failureMessage,
      maximumBytes: 1024 * 1024,
      postOpenPreReadFailpoint,
    });
    const resolvedSourceFile = await realpath(sourceFile).catch(() => {
      fail(failureMessage);
    });
    relativeWithin(
      actualRoot,
      resolvedSourceFile,
      "Local-review identity-core runtime file",
    );
    files.push(Object.freeze({
      byteLength: captured.byteLength,
      inputPath: `packages/identity-core/${relativeFile}`,
      relativeFile,
      sha256: captured.sha256,
      sourceText: captured.sourceText,
    }));
  }
  let manifest;
  try {
    manifest = JSON.parse(files.find(({ relativeFile }) =>
      relativeFile === "package.json")?.sourceText ?? "");
  } catch {
    fail("Captured local-review identity-core package manifest is invalid");
  }
  if (manifest?.name !== IDENTITY_CORE_PACKAGE_NAME
      || manifest?.version
        !== PINNED_RUNTIME_PACKAGES[IDENTITY_CORE_PACKAGE_NAME].version) {
    fail("Pinned package mismatch for local-review identity-core");
  }
  const capture = Object.freeze({
    files: Object.freeze(files),
    inputDirectory: "packages/identity-core",
    license: PINNED_RUNTIME_PACKAGES[IDENTITY_CORE_PACKAGE_NAME].license,
    name: manifest.name,
    version: manifest.version,
  });
  validateIdentityCoreRuntimeCapture(capture);
  return capture;
}

function resolveRelativeSpecifier(fromFile, specifier) {
  const candidate = resolve(dirname(fromFile), specifier);
  if (extname(candidate)) return candidate;
  return `${candidate}.js`;
}

export function isForbiddenLocalReviewSource(relativeFile) {
  if (!relativeFile.startsWith("src/")) return false;
  return (
    FORBIDDEN_SOURCE_PATHS.some((pattern) => pattern.test(relativeFile))
    || FORBIDDEN_SOURCE_BASENAMES.some((pattern) => pattern.test(basename(relativeFile)))
  );
}

export async function collectStaticGraph(entrypoint, {
  expectedExternalSpecifiers = EXPECTED_EXTERNAL_SPECIFIERS,
} = {}) {
  if (
    !Array.isArray(expectedExternalSpecifiers)
    || expectedExternalSpecifiers.some(
      (specifier) => typeof specifier !== "string",
    )
  ) {
    fail("expectedExternalSpecifiers must be an array of strings");
  }
  const expectedExternal = [...expectedExternalSpecifiers].sort();
  const pending = [entrypoint];
  const files = new Set();
  const external = new Set();
  const builtins = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (files.has(file)) continue;
    const relativeFile = repositoryRelative(file);
    if (isForbiddenLocalReviewSource(relativeFile)) {
      fail(`Forbidden local-review source module is reachable: ${relativeFile}`);
    }
    const bytes = await readFile(file);
    files.add(file);
    if (extname(file) !== ".js") continue;
    const source = bytes.toString("utf8");
    const dynamicExternal =
      DYNAMIC_EXTERNAL_BY_FILE[relativeFile];
    if (dynamicExternal) external.add(dynamicExternal);
    let esmImports;
    try {
      esmImports = await extractEsmImports(source, {
        sourceName: relativeFile,
      });
    } catch {
      fail(`Static dependency source is not valid ESM: ${relativeFile}`);
    }
    if (esmImports.some(({ specifier }) => specifier === null)) {
      fail(`Non-literal dynamic import is forbidden: ${relativeFile}`);
    }
    const specifiers = [
      ...esmImports.map(({ specifier }) => specifier),
    ];
    for (const pattern of SOURCE_PATTERNS) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
        specifiers.push(match[1]);
      }
    }
    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) {
        const resolved = resolveRelativeSpecifier(file, specifier);
        await stat(resolved).catch(() => fail(
          `Static dependency is missing: ${relativeFile} -> ${specifier}`,
        ));
        if (!files.has(resolved)) pending.push(resolved);
      } else if (specifier.startsWith("node:")) {
        builtins.add(specifier);
      } else {
        const root = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0];
        external.add(root === "runcost" ? "runcost/browser" : root);
      }
    }
  }
  for (const builtin of builtins) {
    if (FORBIDDEN_BUILTINS.has(builtin)) {
      fail(`Forbidden network builtin is reachable: ${builtin}`);
    }
  }
  const externalSpecifiers = [...external].sort();
  if (
    JSON.stringify(externalSpecifiers)
    !== JSON.stringify(expectedExternal)
  ) {
    fail(
      `Unexpected local-review dependency closure: ${
        externalSpecifiers.join(", ")
      }`,
    );
  }
  return {
    files: [...files].sort((left, right) =>
      repositoryRelative(left).localeCompare(repositoryRelative(right))),
    external: externalSpecifiers,
    builtins: [...builtins].sort(),
  };
}

async function copyFileWithMode(source, destination, mode = 0o600) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await cp(source, destination, {
    errorOnExist: true,
    force: false,
    preserveTimestamps: false,
  });
  await chmod(destination, mode);
}

async function writeGenerated(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, value, { mode, flag: "wx" });
  await chmod(path, mode);
}

export async function stageLocalReviewIdentityCoreRuntime(
  artifactRoot,
  capture,
) {
  validateIdentityCoreRuntimeCapture(capture);
  if (typeof artifactRoot !== "string") {
    fail("Local-review identity-core staging root is invalid");
  }
  const rows = [];
  for (const file of capture.files) {
    const relativePath = [
      "node_modules",
      ...capture.name.split("/"),
      ...file.relativeFile.split("/"),
    ].join("/");
    await writeGenerated(
      join(artifactRoot, ...relativePath.split("/")),
      file.sourceText,
    );
    rows.push(Object.freeze({
      bytes: file.byteLength,
      path: relativePath,
      sha256: file.sha256,
    }));
  }
  return Object.freeze(rows);
}

export function assertLocalReviewIdentityCoreRuntimeInventory(
  inventory,
  capture,
) {
  validateIdentityCoreRuntimeCapture(capture);
  if (!Array.isArray(inventory)) {
    fail("Local-review identity-core inventory is invalid");
  }
  const prefix = `node_modules/${capture.name}/`;
  const actual = inventory.filter(({ path }) => path?.startsWith(prefix));
  if (actual.length !== capture.files.length) {
    fail("Local-review identity-core inventory is incomplete");
  }
  const rows = new Map(actual.map((row) => [row.path, row]));
  if (rows.size !== actual.length) {
    fail("Local-review identity-core inventory contains duplicates");
  }
  for (const file of capture.files) {
    const path = `${prefix}${file.relativeFile}`;
    const row = rows.get(path);
    if (row?.bytes !== file.byteLength || row?.sha256 !== file.sha256) {
      fail(`Local-review identity-core inventory did not retain captured bytes: ${path}`);
    }
  }
  return true;
}

async function prepareBuildRoot(buildRoot) {
  const canonical = resolve(buildRoot);
  const repositoryRelativePath = relative(REPOSITORY_ROOT, canonical);
  const parts = repositoryRelativePath.split(sep);
  if (repositoryRelativePath === ""
      || repositoryRelativePath === ".."
      || repositoryRelativePath.startsWith(`..${sep}`)
      || ![".release-build", ".release-repro"].includes(parts[0])) {
    fail("Build output must be inside the repository's reserved .release-build or .release-repro tree");
  }
  const parent = dirname(canonical);
  const canonicalParent = await realpath(parent).catch((error) => {
    if (error.code === "ENOENT") {
      fail("Build output parent must already exist");
    }
    throw error;
  });
  if (canonicalParent !== parent) {
    fail("Build output parent must not traverse a symlink");
  }
  const marker = join(canonical, BUILD_ROOT_MARKER);
  let existing = false;
  try {
    const value = await lstat(canonical);
    if (!value.isDirectory() || value.isSymbolicLink()) {
      fail("Build output exists and is not a regular directory");
    }
    existing = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing) {
    if (await realpath(canonical) !== canonical) {
      fail("Build output directory must not traverse a symlink");
    }
    const markerStat = await lstat(marker).catch((error) => {
      if (error.code === "ENOENT") {
        fail("Refusing to replace an unmarked build output directory");
      }
      throw error;
    });
    if (!markerStat.isFile() || markerStat.isSymbolicLink()
        || await readFile(marker, "utf8") !== BUILD_ROOT_MARKER_BYTES) {
      fail("Refusing to replace a build output directory with an invalid marker");
    }
    await rm(canonical, { recursive: true, force: false });
  }
  await mkdir(canonical, { recursive: true, mode: 0o700 });
  await writeFile(marker, BUILD_ROOT_MARKER_BYTES, { mode: 0o600, flag: "wx" });
  return canonical;
}

async function walkFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const output = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) fail(`Artifact contains a symlink: ${relative(root, path)}`);
    if (entry.isDirectory()) output.push(...await walkFiles(root, path));
    else if (entry.isFile()) output.push(path);
    else fail(`Artifact contains an unsupported file: ${relative(root, path)}`);
  }
  return output;
}

async function copyRuntimePackage({
  name,
  source,
  destinationRoot,
  include,
  stripSourceMapComments = false,
}) {
  const files = await walkFiles(source);
  for (const file of files) {
    const relativePath = relative(source, file).split(sep).join("/");
    if (!include(relativePath)) continue;
    const destination = join(destinationRoot, "node_modules", name, relativePath);
    let bytes = await readFile(file);
    if (stripSourceMapComments && relativePath.endsWith(".js")) {
      bytes = Buffer.from(bytes.toString("utf8").replace(
        /^\s*\/\/# sourceMappingURL=.*$/gm,
        "",
      ));
      await writeGenerated(destination, bytes);
    } else {
      await copyFileWithMode(file, destination);
    }
  }
}

function packageRuntimeFiles(relativePath) {
  const first = relativePath.split("/")[0];
  if (["test", "tests", "spec", "benchmark", ".github"].includes(first)) return false;
  if (relativePath.endsWith(".map")
      || relativePath.endsWith(".d.ts")
      || /^readme/i.test(basename(relativePath))) return false;
  return true;
}

async function readPinnedPackageMetadata(packagePath, expectedName) {
  let value;
  try {
    value = JSON.parse(await readFile(packagePath, "utf8"));
  } catch {
    fail(`Unable to read reviewed package metadata for ${expectedName}`);
  }
  const expected = PINNED_RUNTIME_PACKAGES[expectedName];
  if (
    !expected
    || value?.name !== expectedName
    || value?.version !== expected.version
  ) {
    fail(`Reviewed package identity changed for ${expectedName}`);
  }
  return Object.freeze({
    name: expectedName,
    version: expected.version,
    license: expected.license,
  });
}

async function copyThirdPartyDependencies(artifactRoot) {
  const rootRequire = createRequire(join(REPOSITORY_ROOT, "package.json"));
  const ajvPackage = rootRequire.resolve("ajv/package.json");
  const components = [
    await readPinnedPackageMetadata(ajvPackage, "ajv"),
  ];
  const ajvRoot = dirname(ajvPackage);
  await copyRuntimePackage({
    name: "ajv",
    source: ajvRoot,
    destinationRoot: artifactRoot,
    include: (path) =>
      (path === "package.json" || path === "LICENSE" || path.startsWith("dist/"))
        && !path.endsWith(".map")
        && !path.endsWith(".d.ts"),
    stripSourceMapComments: true,
  });

  const ajvRequire = createRequire(ajvPackage);
  const ajvDependencies = [
    "fast-deep-equal",
    "fast-uri",
    "json-schema-traverse",
    "require-from-string",
  ];
  for (const name of ajvDependencies) {
    const packagePath = ajvRequire.resolve(`${name}/package.json`);
    components.push(await readPinnedPackageMetadata(packagePath, name));
    const packageRoot = dirname(packagePath);
    await copyRuntimePackage({
      name,
      source: packageRoot,
      destinationRoot: artifactRoot,
      include: packageRuntimeFiles,
      stripSourceMapComments: true,
    });
  }

  const keytarPackage =
    rootRequire.resolve("@github/keytar/package.json");
  components.push(
    await readPinnedPackageMetadata(keytarPackage, "@github/keytar"),
  );
  const keytarRoot = dirname(keytarPackage);
  for (const relativePath of [
    "package.json",
    "LICENSE.md",
    "prebuilds/darwin-arm64/keytar.node",
  ]) {
    await copyFileWithMode(
      join(keytarRoot, relativePath),
      join(artifactRoot, "node_modules", "@github", "keytar", relativePath),
    );
  }

  return components.sort((left, right) =>
    left.name.localeCompare(right.name));
}

async function copyLicenses(artifactRoot, components) {
  const rootRequire = createRequire(join(REPOSITORY_ROOT, "package.json"));
  await copyFileWithMode(
    PINNED_NODE_LICENSE,
    join(artifactRoot, "LICENSES", "node-26.2.0.txt"),
    0o644,
  );
  await copyFileWithMode(
    join(dirname(rootRequire.resolve("@github/keytar/package.json")), "LICENSE.md"),
    join(artifactRoot, "LICENSES", "github-keytar-7.10.6.txt"),
    0o644,
  );
  for (const component of components.filter((item) =>
    item.name !== "@github/keytar"
      && item.name !== IDENTITY_CORE_PACKAGE_NAME)) {
    const packagePath = rootRequire.resolve(
      component.name === "ajv"
        ? "ajv/package.json"
        : createRequire(rootRequire.resolve("ajv/package.json"))
          .resolve(`${component.name}/package.json`),
    );
    const packageRoot = dirname(packagePath);
    const candidates = (await readdir(packageRoot))
      .filter((name) => /^licen[sc]e/i.test(name))
      .sort();
    if (candidates.length !== 1) {
      fail(`Expected one license file for ${component.name}`);
    }
    await copyFileWithMode(
      join(packageRoot, candidates[0]),
      join(
        artifactRoot,
        "LICENSES",
        `${component.name.replaceAll("/", "-")}-${component.version}.txt`,
      ),
      0o644,
    );
  }
  await writeGenerated(
    join(artifactRoot, "LICENSES", "app-usagemonitor-private-poc.txt"),
    "TiboTattle is distributed under the MIT license; see the repository LICENSE file.\n",
    0o644,
  );
}

async function directoryDigest(path) {
  const hash = createHash("sha256");
  const files = await walkFiles(path);
  for (const file of files) {
    const relativePath = relative(path, file).split(sep).join("/");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function componentPurl(component) {
  if (component.name === "node") {
    return "pkg:generic/node@26.2.0?arch=arm64&os=darwin";
  }
  const encodedName = component.name.startsWith("@")
    ? `${encodeURIComponent(component.name.split("/")[0])}/${component.name.split("/")[1]}`
    : component.name;
  return `pkg:npm/${encodedName}@${component.version}`;
}

async function writeSupplyChainArtifacts(artifactRoot, components, graph, sourceEpoch) {
  const componentRows = [];
  for (const component of [
    { name: "node", version: "26.2.0", license: "MIT" },
    ...components,
  ]) {
    const componentPath = component.name === "node"
      ? join(artifactRoot, "runtime", "bin")
      : join(artifactRoot, "node_modules", ...component.name.split("/"));
    componentRows.push({
      ...component,
      digest: await directoryDigest(componentPath),
      purl: componentPurl(component),
    });
  }
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:00000000-0000-5000-8000-${sha256(Buffer.from(ROOT_NAME)).slice(0, 12)}`,
    version: 1,
    metadata: {
      timestamp: new Date(sourceEpoch * 1000).toISOString(),
      component: {
        type: "application",
        name: "usage-monitor-local-review",
        version: ARTIFACT_VERSION,
      },
    },
    components: componentRows.map((component) => ({
      type: component.name === "node" ? "framework" : "library",
      name: component.name,
      version: component.version,
      purl: component.purl,
      hashes: [{ alg: "SHA-256", content: component.digest }],
      licenses: component.license.startsWith("LicenseRef-")
        ? [{ expression: component.license }]
        : [{ license: { id: component.license } }],
    })),
  };
  await writeGenerated(join(artifactRoot, "sbom.cdx.json"), stableJson(sbom), 0o644);
  await writeGenerated(
    join(artifactRoot, "licenses.json"),
    stableJson({
      schemaVersion: "usage-monitor-local-review-license-inventory-v0.1",
      components: componentRows.map(({ name, version, license, purl }) => ({
        name,
        version,
        license,
        purl,
      })),
      firstPartyLicense: "private_proof_of_concept_no_public_license",
    }),
    0o644,
  );
  return componentRows;
}

function git(command) {
  return execFileSync("git", command, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  }).trim();
}

export async function calculateLocalReviewSourceInputDigest({
  graph,
  identityCoreRuntime,
  readSource = readFile,
}) {
  validateIdentityCoreRuntimeCapture(identityCoreRuntime);
  if (graph === null || typeof graph !== "object"
      || !Array.isArray(graph.files)
      || typeof readSource !== "function") {
    fail("Local-review source digest inputs are invalid");
  }
  const hash = createHash("sha256");
  const inputs = [
    ...graph.files,
    RELEASE_CONTRACT,
    ESM_IMPORT_HELPER,
    CAPTURED_UTF8_SOURCE_HELPER,
    fileURLToPath(import.meta.url),
  ]
    .sort((left, right) => repositoryRelative(left).localeCompare(repositoryRelative(right)));
  for (const file of inputs) {
    hash.update(repositoryRelative(file));
    hash.update("\0");
    hash.update(await readSource(file));
    hash.update("\0");
  }
  for (const file of identityCoreRuntime.files) {
    hash.update(file.inputPath);
    hash.update("\0");
    hash.update(file.sourceText, "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function localReviewArtifactPackageMetadata(rootPackage) {
  if (
    !rootPackage
    || typeof rootPackage !== "object"
    || Array.isArray(rootPackage)
    || typeof rootPackage.name !== "string"
    || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/u
      .test(rootPackage.name)
    || typeof rootPackage.version !== "string"
    || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u
      .test(rootPackage.version)
    || rootPackage.private !== true
    || rootPackage.type !== "module"
  ) {
    fail("Root package identity is not a reviewed private ESM package");
  }
  return Object.freeze({
    name: rootPackage.name,
    version: rootPackage.version,
    private: true,
    type: "module",
    artifact: Object.freeze({
      name: "usage-monitor-local-review",
      version: ARTIFACT_VERSION,
      localOnly: true,
    }),
  });
}

async function privacyScan(artifactRoot) {
  const firstPartyFiles = (await walkFiles(artifactRoot)).filter((path) => {
    const value = relative(artifactRoot, path).split(sep).join("/");
    return value.startsWith("lib/")
      || value.startsWith("local-review/")
      || value.startsWith("contracts/")
      || value.startsWith("schemas/")
      || value.startsWith(
        "node_modules/@app-usagemonitor/identity-core/",
      )
      || value === "package.json";
  });
  const prohibited = [
    { code: "macos_user_path", pattern: /\/Users\/[^/\s"']+/ },
    { code: "macos_temporary_path", pattern: /\/(?:private\/)?var\/folders\// },
    { code: "owner_name", pattern: /adamallcock/i },
    { code: "email_address", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
    { code: "openai_secret", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
    { code: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  ];
  const hits = [];
  for (const file of firstPartyFiles) {
    const statValue = await lstat(file);
    if (statValue.size > 16 * 1024 * 1024) continue;
    const text = (await readFile(file)).toString("utf8");
    for (const rule of prohibited) {
      if (rule.pattern.test(text)) {
        hits.push({
          code: rule.code,
          path: relative(artifactRoot, file).split(sep).join("/"),
        });
      }
    }
  }
  const maps = (await walkFiles(artifactRoot))
    .map((path) => relative(artifactRoot, path).split(sep).join("/"))
    .filter((path) => path.endsWith(".map"));
  if (maps.length > 0) hits.push(...maps.map((path) => ({ code: "source_map", path })));
  if (hits.length > 0) fail(`Artifact privacy scan failed: ${JSON.stringify(hits)}`);
  return {
    schemaVersion: "usage-monitor-local-review-privacy-scan-v0.1",
    filesScanned: firstPartyFiles.length,
    prohibitedPatternHits: 0,
    sourceMapFiles: 0,
    result: "passed",
  };
}

function modeForArtifactPath(path) {
  if (path === "runtime/bin/node" || path.startsWith("bin/")) return 0o755;
  if (path.startsWith("LICENSES/")
      || path.startsWith("contracts/")
      || path.startsWith("schemas/")
      || ["README.txt", "sbom.cdx.json", "licenses.json", "provenance.json",
        "privacy-scan.json", "CHECKSUMS.sha256"].includes(path)) return 0o644;
  return 0o600;
}

function octal(value, width) {
  const text = value.toString(8);
  if (text.length + 1 > width) fail("Tar header numeric value overflow");
  return `${"0".repeat(width - text.length - 1)}${text}\0`;
}

function tarPathFields(path) {
  const bytes = Buffer.byteLength(path);
  if (bytes <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0;
    index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) {
      return { name, prefix };
    }
  }
  fail(`Tar path is too long: ${path}`);
}

function tarHeader(path, size, mode, mtime) {
  const header = Buffer.alloc(512, 0);
  const fields = tarPathFields(path);
  header.write(fields.name, 0, 100, "utf8");
  header.write(octal(mode, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii");
  header.write(octal(0, 8), 116, 8, "ascii");
  header.write(octal(size, 12), 124, 12, "ascii");
  header.write(octal(mtime, 12), 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "ascii");
  header.write("root", 297, 32, "ascii");
  header.write(fields.prefix, 345, 155, "utf8");
  const checksum = header.reduce((sum, value) => sum + value, 0);
  const checksumText = checksum.toString(8);
  if (checksumText.length > 6) fail("Tar header checksum overflow");
  header.write(`${checksumText.padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

async function writeDeterministicTar(artifactRoot, archivePath, sourceEpoch) {
  const files = await walkFiles(artifactRoot);
  const handle = await open(archivePath, "wx", 0o600);
  async function writeAll(bytes) {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.write(
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten < 1) {
        fail("Tar archive write made no progress");
      }
      offset += result.bytesWritten;
    }
  }
  try {
    for (const file of files) {
      const relativePath = relative(artifactRoot, file).split(sep).join("/");
      const bytes = await readFile(file);
      await writeAll(tarHeader(
        `${ROOT_NAME}/${relativePath}`,
        bytes.byteLength,
        modeForArtifactPath(relativePath),
        sourceEpoch,
      ));
      await writeAll(bytes);
      const remainder = bytes.byteLength % 512;
      if (remainder !== 0) await writeAll(Buffer.alloc(512 - remainder));
    }
    await writeAll(Buffer.alloc(1024));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function buildLocalReviewArtifact({ buildRoot, sourceEpoch }) {
  buildRoot = await prepareBuildRoot(buildRoot);
  const artifactRoot = join(buildRoot, ROOT_NAME);
  const archivePath = join(buildRoot, `${ROOT_NAME}.tar`);
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });

  const contract = JSON.parse(await readFile(RELEASE_CONTRACT, "utf8"));
  const rootPackage = JSON.parse(
    await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8"),
  );
  const artifactPackage =
    localReviewArtifactPackageMetadata(rootPackage);
  const nodeDigest = await sha256File(PINNED_NODE);
  const rootRequire = createRequire(join(REPOSITORY_ROOT, "package.json"));
  const keytarBinding = rootRequire.resolve(
    "@github/keytar/prebuilds/darwin-arm64/keytar.node",
  );
  const keytarDigest = await sha256File(keytarBinding);
  if (nodeDigest !== contract.runtime.binarySha256
      || keytarDigest !== contract.nativeDependencies[0].bindingSha256) {
    fail("Pinned runtime or Keychain binding digest changed");
  }

  const graph = await collectStaticGraph(ENTRYPOINT);
  const identityCoreRuntime = await captureLocalReviewIdentityCoreRuntime();
  for (const source of graph.files) {
    if (repositoryRelative(source) === "package.json") continue;
    await copyFileWithMode(
      source,
      join(artifactRoot, repositoryRelative(source)),
    );
  }
  await copyFileWithMode(
    RELEASE_CONTRACT,
    join(artifactRoot, "local-review", "release-contract.json"),
    0o644,
  );
  await copyFileWithMode(
    PINNED_NODE,
    join(artifactRoot, "runtime", "bin", "node"),
    0o755,
  );
  await stageLocalReviewIdentityCoreRuntime(
    artifactRoot,
    identityCoreRuntime,
  );
  const components = [
    {
      name: identityCoreRuntime.name,
      version: identityCoreRuntime.version,
      license: identityCoreRuntime.license,
    },
    ...await copyThirdPartyDependencies(artifactRoot),
  ].sort((left, right) => left.name.localeCompare(right.name));
  await copyLicenses(artifactRoot, components);

  const launcher = `#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
exec "$ROOT/runtime/bin/node" "$ROOT/local-review/cli.js" "$@"
`;
  await writeGenerated(
    join(artifactRoot, "bin", "usage-monitor-local"),
    launcher,
    0o755,
  );
  await writeGenerated(
    join(artifactRoot, "package.json"),
    stableJson(artifactPackage),
    0o644,
  );
  await writeGenerated(
    join(artifactRoot, "README.txt"),
    `TiboTattle local review ${ARTIFACT_VERSION}

This is an unsigned engineering candidate for macOS arm64.
It contains no upload, enrollment, pairing, backend, server, or updater.

Verify:
  ./bin/usage-monitor-local inspect-artifact

Check the local environment:
  ./bin/usage-monitor-local doctor

Install to an explicit absent target:
  ./bin/usage-monitor-local install --target "/absolute/path"

Ordinary uninstall preserves participant identity and does not claim secure erasure.
Signing, notarization, clean-machine verification, approved consent, and volunteer
authorization remain open release gates.
`,
    0o644,
  );

  const componentRows = await writeSupplyChainArtifacts(
    artifactRoot,
    components,
    graph,
    sourceEpoch,
  );
  const sourceDigest = await calculateLocalReviewSourceInputDigest({
    graph,
    identityCoreRuntime,
  });
  const provenance = {
    schemaVersion: "usage-monitor-local-review-provenance-v0.1",
    artifactVersion: ARTIFACT_VERSION,
    platform: { os: "darwin", architecture: "arm64" },
    source: {
      gitRevision: git(["rev-parse", "HEAD"]),
      workingTree: git(["status", "--porcelain"]).length === 0 ? "clean" : "dirty",
      inputSha256: sourceDigest,
    },
    build: {
      builder: "scripts/build-local-review-artifact.js",
      sourceDateEpoch: sourceEpoch,
      deterministicTar: true,
      networkRequired: false,
    },
    graph: {
      entrypoint: repositoryRelative(ENTRYPOINT),
      firstPartyFiles: graph.files.length,
      externalSpecifiers: graph.external,
      forbiddenNetworkBuiltins: [],
    },
    signing: {
      developerId: false,
      notarized: false,
    },
    claims: {
      localOnly: true,
      transportReady: false,
      externalParticipantsAuthorized: false,
      secureErasure: false,
    },
  };
  await writeGenerated(
    join(artifactRoot, "provenance.json"),
    stableJson(provenance),
    0o644,
  );
  const scan = await privacyScan(artifactRoot);
  await writeGenerated(
    join(artifactRoot, "privacy-scan.json"),
    stableJson(scan),
    0o644,
  );

  const inventoryFiles = (await walkFiles(artifactRoot))
    .filter((path) => basename(path) !== "artifact-manifest.json")
    .sort((left, right) =>
      relative(artifactRoot, left).localeCompare(relative(artifactRoot, right)));
  const inventory = [];
  for (const file of inventoryFiles) {
    const bytes = await readFile(file);
    const path = relative(artifactRoot, file).split(sep).join("/");
    inventory.push({
      path,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      mode: modeForArtifactPath(path),
    });
  }
  assertLocalReviewIdentityCoreRuntimeInventory(
    inventory,
    identityCoreRuntime,
  );
  const manifest = {
    schemaVersion: "usage-monitor-local-review-artifact-manifest-v0.1",
    artifactVersion: ARTIFACT_VERSION,
    platform: { os: "darwin", architecture: "arm64" },
    runtime: {
      name: "node",
      version: "26.2.0",
      binarySha256: nodeDigest,
    },
    nativeDependencies: [{
      name: "@github/keytar",
      version: "7.10.6",
      bindingSha256: keytarDigest,
    }],
    localOnly: true,
    transportReady: false,
    externalParticipantsAuthorized: false,
    inventory,
  };
  await writeGenerated(
    join(artifactRoot, "artifact-manifest.json"),
    stableJson(manifest),
  );
  const checksumLines = [
    ...inventory,
    {
      path: "artifact-manifest.json",
      sha256: await sha256File(join(artifactRoot, "artifact-manifest.json")),
    },
  ].sort((left, right) => left.path.localeCompare(right.path))
    .map((row) => `${row.sha256}  ${row.path}`)
    .join("\n");
  await writeGenerated(
    join(artifactRoot, "CHECKSUMS.sha256"),
    `${checksumLines}\n`,
    0o644,
  );

  // CHECKSUMS is deliberately outside the manifest inventory to avoid a
  // self-referential digest. Rebuild the manifest once with CHECKSUMS included.
  const checksumsBytes = await readFile(join(artifactRoot, "CHECKSUMS.sha256"));
  manifest.inventory.push({
    path: "CHECKSUMS.sha256",
    bytes: checksumsBytes.byteLength,
    sha256: sha256(checksumsBytes),
    mode: 0o644,
  });
  manifest.inventory.sort((left, right) => left.path.localeCompare(right.path));
  await rm(join(artifactRoot, "artifact-manifest.json"));
  await writeGenerated(
    join(artifactRoot, "artifact-manifest.json"),
    stableJson(manifest),
  );
  const finalChecksumRows = [
    ...manifest.inventory,
    {
      path: "artifact-manifest.json",
      sha256: await sha256File(join(artifactRoot, "artifact-manifest.json")),
    },
  ].sort((left, right) => left.path.localeCompare(right.path));
  await rm(join(artifactRoot, "CHECKSUMS.sha256"));
  await writeGenerated(
    join(artifactRoot, "CHECKSUMS.sha256"),
    `${finalChecksumRows.map((row) => `${row.sha256}  ${row.path}`).join("\n")}\n`,
    0o644,
  );
  // CHECKSUMS changed when the manifest hash changed. Bind its final bytes in
  // the manifest; its own line intentionally omits a checksum for itself.
  const finalChecksumsBytes = await readFile(join(artifactRoot, "CHECKSUMS.sha256"));
  const checksumInventory = manifest.inventory.find((row) =>
    row.path === "CHECKSUMS.sha256");
  checksumInventory.bytes = finalChecksumsBytes.byteLength;
  checksumInventory.sha256 = sha256(finalChecksumsBytes);
  await rm(join(artifactRoot, "artifact-manifest.json"));
  await writeGenerated(
    join(artifactRoot, "artifact-manifest.json"),
    stableJson(manifest),
  );

  // The closed manifest is authoritative. CHECKSUMS is a human-readable
  // projection and intentionally excludes both self and manifest to avoid a
  // circular fixed point.
  const projectedChecksums = manifest.inventory
    .filter((row) => row.path !== "CHECKSUMS.sha256")
    .map((row) => `${row.sha256}  ${row.path}`)
    .join("\n");
  await rm(join(artifactRoot, "CHECKSUMS.sha256"));
  await writeGenerated(
    join(artifactRoot, "CHECKSUMS.sha256"),
    `${projectedChecksums}\n`,
    0o644,
  );
  const projectedBytes = await readFile(join(artifactRoot, "CHECKSUMS.sha256"));
  checksumInventory.bytes = projectedBytes.byteLength;
  checksumInventory.sha256 = sha256(projectedBytes);
  await rm(join(artifactRoot, "artifact-manifest.json"));
  await writeGenerated(
    join(artifactRoot, "artifact-manifest.json"),
    stableJson(manifest),
  );

  await writeDeterministicTar(artifactRoot, archivePath, sourceEpoch);
  const archiveStat = await stat(archivePath);
  const receipt = {
    schemaVersion: "usage-monitor-local-review-build-receipt-v0.1",
    artifactVersion: ARTIFACT_VERSION,
    rootName: ROOT_NAME,
    archive: {
      basename: basename(archivePath),
      bytes: archiveStat.size,
      sha256: await sha256File(archivePath),
    },
    manifestSha256: await sha256File(join(artifactRoot, "artifact-manifest.json")),
    sourceInputSha256: sourceDigest,
    firstPartyGraphFiles: graph.files.length,
    components: componentRows.map(({ name, version, digest }) => ({
      name,
      version,
      sha256: digest,
    })),
    privacyScan: scan.result,
    signing: "unsigned",
    notarization: "not_notarized",
    externalParticipantsAuthorized: false,
  };
  await writeGenerated(
    join(buildRoot, `${ROOT_NAME}.build-receipt.json`),
    stableJson(receipt),
    0o600,
  );
  return { artifactRoot, archivePath, receipt };
}

function parseArgs(argv) {
  let buildRoot = DEFAULT_BUILD_ROOT;
  let sourceEpoch = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") {
      const value = argv[++index];
      if (!value) fail("--output requires a path");
      buildRoot = resolve(value);
    } else if (arg === "--source-date-epoch") {
      const value = Number(argv[++index]);
      if (!Number.isSafeInteger(value) || value < 0) {
        fail("--source-date-epoch requires a non-negative integer");
      }
      sourceEpoch = value;
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  if (sourceEpoch === null) {
    const environmentValue = process.env.SOURCE_DATE_EPOCH;
    sourceEpoch = environmentValue === undefined
      ? Number(git(["show", "-s", "--format=%ct", "HEAD"]))
      : Number(environmentValue);
  }
  if (!Number.isSafeInteger(sourceEpoch) || sourceEpoch < 0) {
    fail("SOURCE_DATE_EPOCH must be a non-negative integer");
  }
  return { buildRoot, sourceEpoch };
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  const options = parseArgs(process.argv.slice(2));
  buildLocalReviewArtifact(options).then(({
    artifactRoot,
    archivePath,
    receipt,
  }) => {
    console.log(`Artifact root: ${artifactRoot}`);
    console.log(`Archive: ${archivePath}`);
    console.log(`Archive SHA-256: ${receipt.archive.sha256}`);
    console.log(`Archive bytes: ${receipt.archive.bytes}`);
    console.log("Signing: unsigned; notarization: not notarized");
    console.log("External participants authorized: false");
  }).catch((error) => {
    console.error(`build-local-review-artifact: ${error.message}`);
    process.exitCode = 1;
  });
}
