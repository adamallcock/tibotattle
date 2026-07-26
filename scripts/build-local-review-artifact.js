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

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
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
const PINNED_RUNCOST_LICENSE = join(
  REPOSITORY_ROOT,
  "third_party_licenses",
  "runcost-0.2.0.txt",
);
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
const ALLOWED_EXTERNAL_SPECIFIERS = new Set(["ajv", "runcost/browser"]);
const FORBIDDEN_SOURCE_BASENAMES = [
  /^contribution-/,
  /^local-companion-/,
  /^passive-collector/,
  /^codex-app-server/,
  /^telemetry-contribution/,
  /^telemetry-prepared-set/,
];
const SOURCE_PATTERNS = [
  /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
  /import\s*\(\s*["']([^"']+)["']\s*\)/g,
  /require(?:\.resolve)?\s*\(\s*["']([^"']+)["']\s*\)/g,
  /new\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
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

function resolveRelativeSpecifier(fromFile, specifier) {
  const candidate = resolve(dirname(fromFile), specifier);
  if (extname(candidate)) return candidate;
  return `${candidate}.js`;
}

async function collectStaticGraph(entrypoint) {
  const pending = [entrypoint];
  const files = new Set();
  const external = new Set();
  const builtins = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (files.has(file)) continue;
    const relativeFile = repositoryRelative(file);
    if (relativeFile.startsWith("src/")
        && FORBIDDEN_SOURCE_BASENAMES.some((pattern) => pattern.test(basename(file)))) {
      fail(`Forbidden local-review source module is reachable: ${relativeFile}`);
    }
    const bytes = await readFile(file);
    files.add(file);
    if (extname(file) !== ".js") continue;
    const source = bytes.toString("utf8");
    for (const pattern of SOURCE_PATTERNS) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
        const specifier = match[1];
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
  }
  for (const builtin of builtins) {
    if (FORBIDDEN_BUILTINS.has(builtin)) {
      fail(`Forbidden network builtin is reachable: ${builtin}`);
    }
  }
  for (const specifier of external) {
    if (!ALLOWED_EXTERNAL_SPECIFIERS.has(specifier)) {
      fail(`Undeclared third-party dependency is reachable: ${specifier}`);
    }
  }
  return {
    files: [...files].sort((left, right) =>
      repositoryRelative(left).localeCompare(repositoryRelative(right))),
    external: [...external].sort(),
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

async function copyThirdPartyDependencies(artifactRoot) {
  const rootRequire = createRequire(join(REPOSITORY_ROOT, "package.json"));
  const ajvPackage = rootRequire.resolve("ajv/package.json");
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
    const packageRoot = dirname(ajvRequire.resolve(`${name}/package.json`));
    await copyRuntimePackage({
      name,
      source: packageRoot,
      destinationRoot: artifactRoot,
      include: packageRuntimeFiles,
      stripSourceMapComments: true,
    });
  }

  const runcostRoot = dirname(rootRequire.resolve("runcost/browser"));
  for (const relativePath of ["browser.js", "package.json"]) {
    await copyFileWithMode(
      join(runcostRoot, relativePath),
      join(artifactRoot, "node_modules", "runcost", relativePath),
    );
  }

  const keytarRoot = dirname(rootRequire.resolve("@github/keytar/package.json"));
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

  return [
    { name: "ajv", version: "8.20.0", license: "MIT" },
    { name: "fast-deep-equal", version: "3.1.3", license: "MIT" },
    { name: "fast-uri", version: "3.1.4", license: "BSD-3-Clause" },
    { name: "json-schema-traverse", version: "1.0.0", license: "MIT" },
    { name: "require-from-string", version: "2.0.2", license: "MIT" },
    { name: "runcost", version: "0.2.0", license: "MIT" },
    { name: "@github/keytar", version: "7.10.6", license: "MIT" },
  ];
}

async function copyLicenses(artifactRoot, components) {
  const rootRequire = createRequire(join(REPOSITORY_ROOT, "package.json"));
  await copyFileWithMode(
    PINNED_NODE_LICENSE,
    join(artifactRoot, "LICENSES", "node-26.2.0.txt"),
    0o644,
  );
  await copyFileWithMode(
    PINNED_RUNCOST_LICENSE,
    join(artifactRoot, "LICENSES", "runcost-0.2.0.txt"),
    0o644,
  );
  await copyFileWithMode(
    join(dirname(rootRequire.resolve("@github/keytar/package.json")), "LICENSE.md"),
    join(artifactRoot, "LICENSES", "github-keytar-7.10.6.txt"),
    0o644,
  );
  for (const component of components.filter((item) =>
    !["runcost", "@github/keytar"].includes(item.name))) {
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
    "App Usage Monitor is a private proof of concept. No public source-code license is granted by this artifact.\n",
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
      licenses: [{ license: { id: component.license } }],
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

async function sourceInputDigest(graph) {
  const hash = createHash("sha256");
  const inputs = [
    ...graph.files,
    RELEASE_CONTRACT,
    PINNED_RUNCOST_LICENSE,
    fileURLToPath(import.meta.url),
  ]
    .sort((left, right) => repositoryRelative(left).localeCompare(repositoryRelative(right)));
  for (const file of inputs) {
    hash.update(repositoryRelative(file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function privacyScan(artifactRoot) {
  const firstPartyFiles = (await walkFiles(artifactRoot)).filter((path) => {
    const value = relative(artifactRoot, path).split(sep).join("/");
    return value.startsWith("lib/")
      || value.startsWith("local-review/")
      || value.startsWith("contracts/")
      || value.startsWith("schemas/")
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

async function build({ buildRoot, sourceEpoch }) {
  buildRoot = await prepareBuildRoot(buildRoot);
  const artifactRoot = join(buildRoot, ROOT_NAME);
  const archivePath = join(buildRoot, `${ROOT_NAME}.tar`);
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });

  const contract = JSON.parse(await readFile(RELEASE_CONTRACT, "utf8"));
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
  const components = await copyThirdPartyDependencies(artifactRoot);
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
    stableJson({
      name: "app-usagemonitor",
      version: "0.0.1",
      private: true,
      type: "module",
      artifact: {
        name: "usage-monitor-local-review",
        version: ARTIFACT_VERSION,
        localOnly: true,
      },
    }),
    0o644,
  );
  await writeGenerated(
    join(artifactRoot, "README.txt"),
    `Usage Monitor local review ${ARTIFACT_VERSION}

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
  const sourceDigest = await sourceInputDigest(graph);
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

const options = parseArgs(process.argv.slice(2));
build(options).then(({ artifactRoot, archivePath, receipt }) => {
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
