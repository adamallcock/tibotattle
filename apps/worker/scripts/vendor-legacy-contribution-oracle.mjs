#!/usr/bin/env node
// Vendors the production code and D1 schema that the IN-3 legacy admission
// oracle runs (postgres-test/postgres-legacy-contribution-admission.spec.mjs)
// at d43c8f92, into postgres-test/fixtures/legacy-contribution-oracle-d43c8f92.
//
// The oracle proves that the PostgreSQL origin admits telemetry-envelope-v1.0
// and v0.1 contributions exactly as the d43c8f92 Worker did on D1. It used to
// load the Worker's sources, the D1 migration directories and the installed
// workspace packages from the live tree and refuse whenever any of them
// differed from its d43c8f92 blob. Any legitimate later change to those files
// (a price card, a contract addition) then broke the oracle without telling
// anything about the legacy path. The vendored copies keep the oracle's
// meaning fixed: it runs d43c8f92's bytes, in a module graph of its own,
// whatever the live tree holds.
//
// One module is deliberately NOT vendored: the server pricer
// (apps/worker/src/server-pricing.ts, with the accounting package it alone
// imports). Server repricing is the line's current pricing policy, not a
// legacy admission rule: the PostgreSQL legacy admission prices with the live
// pricer, exactly as every other admission path and the analytics reprice do,
// and the pricer moves with the price registry (v0.8 at d43c8f92). So the
// oracle runs d43c8f92's admission around the same live pricer (the "pricer
// seam"), and its claim is "the same rows for the same prices". The spec
// proves that the pricer is the only live code in the oracle graph.
//
// The closure is computed, not listed. esbuild bundles the oracle entry points
// from a throwaway extraction of the commit, aliasing the workspace packages
// to their extracted sources and leaving the pricer seam external, and its
// metafile names every module it parsed. Each module is written byte for byte
// from its git blob, and so is every D1 migration in the directories the
// oracle applies. The runtime modules (index.js and src/*.js) of each
// workspace package the closure reaches are vendored whole, as the Worker
// installed them, so the reviewed fixtures/legacy-contribution-oracle-blobs.json
// pins are cross-checked against vendored copies. Type-only imports are
// erased by esbuild and by Vite alike, so they are not vendored. The npm
// dependency the closure imports (jsonc-parser) stays external; MANIFEST.json
// records the version the commit's lockfile installed, and the spec refuses a
// different installed version. Any other bare import fails the derivation.
//
// Nothing is edited. Nothing real is written until the staged tree has been
// compared with the derivation and every byte matches its blob.
//
// Usage (from apps/worker):
//   node scripts/vendor-legacy-contribution-oracle.mjs           # write the vendored tree
//   node scripts/vendor-legacy-contribution-oracle.mjs --check   # re-derive and compare, write nothing
// Both need the commit's objects in the local repository; without them the
// run refuses with LEGACY_ORACLE_COMMIT_UNAVAILABLE. The spec itself needs no
// git history: it checks the vendored bytes against MANIFEST.json and the
// independently pinned fixtures/legacy-contribution-oracle-blobs.json.
// Verify with: node --test scripts/vendor-legacy-contribution-oracle.check.mjs

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ORACLE_COMMIT = "d43c8f92a059d9c577776f7eca8a331eb305b8a6";
export const MANIFEST_SCHEMA = "legacy-contribution-oracle-vendor-manifest-v1";
export const MANIFEST_FILE = "MANIFEST.json";
export const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Relative to apps/worker. The name records the vendored revision; it never moves. */
export const ORACLE_VENDOR_RELATIVE = "postgres-test/fixtures/legacy-contribution-oracle-d43c8f92";
const GENERATOR = "apps/worker/scripts/vendor-legacy-contribution-oracle.mjs";
const CHECK = "apps/worker/scripts/vendor-legacy-contribution-oracle.check.mjs";

/**
 * The Worker modules the spec runs as the oracle (repository paths at the
 * commit): the typed v1 and v0.1 admissions, their parsers, validators and
 * repositories, the transport policy, device receipts, the D1 storage-source
 * seed, the error rendering, and the synthetic envelope decryption.
 */
export const ORACLE_ENTRY_POINTS = Object.freeze([
  "apps/worker/src/analytics-delivery.ts",
  "apps/worker/src/crypto.ts",
  "apps/worker/src/device-auth.ts",
  "apps/worker/src/errors.ts",
  "apps/worker/src/telemetry-repository.ts",
  "apps/worker/src/telemetry-storage-mode.ts",
  "apps/worker/src/telemetry-transport-policy.ts",
  "apps/worker/src/telemetry-v1-repository.ts",
  "apps/worker/src/telemetry-v1.ts",
  "apps/worker/src/telemetry-validation.ts",
  "apps/worker/src/typed-v1-admission.ts",
]);

/** The D1 migration directories the live ingestion D1 applied, in the oracle's apply order. */
export const ORACLE_D1_DIRECTORIES = Object.freeze([
  "migrations", "typed-ingestion-migrations", "ingestion-bridge-migrations",
  "typed-v11-admission-migrations", "typed-v1-admission-migrations",
  "ingestion-isolation-migrations",
]);
export const D1_MIGRATION_NAME = /^\d{4}_[a-z0-9_-]+\.sql$/u;

/**
 * Workspace package specifiers the vendored closure imports, and the vendored
 * entry each resolves to. (@app-usagemonitor/accounting is imported only by
 * the pricer seam, so it resolves from the live tree.)
 */
export const ORACLE_PACKAGE_ENTRIES = Object.freeze({
  "@app-usagemonitor/quota-analysis": "packages/quota-analysis/index.js",
  "@app-usagemonitor/telemetry-contract": "packages/telemetry-contract/index.js",
});

/**
 * Oracle modules resolved from the live tree instead of the commit (see the
 * header). Everything they import comes from the live tree too.
 */
export const ORACLE_LIVE_SEAMS = Object.freeze(["apps/worker/src/server-pricing.ts"]);

/** npm dependencies the closure imports; installed, not vendored. */
export const ORACLE_EXTERNAL_PACKAGES = Object.freeze(["jsonc-parser"]);

const EXTRACTED_ROOTS = Object.freeze([
  "apps/worker/src", "apps/worker/package-lock.json", "packages/quota-analysis", "packages/telemetry-contract", ...ORACLE_D1_DIRECTORIES.map((directory) => `apps/worker/${directory}`),
]);
const VENDORED_PATH = /^(?:apps\/worker\/src\/[a-z0-9-]+\.ts|apps\/worker\/[a-z0-9-]+\/\d{4}_[a-z0-9_-]+\.sql|packages\/(?:quota-analysis|telemetry-contract)\/(?:index\.js|src\/[a-z0-9.-]+\.js))$/u;

export class LegacyOracleVendorError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "LegacyOracleVendorError";
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new LegacyOracleVendorError(code, message);
};

export function gitBlobId(bytes) {
  const body = Buffer.from(bytes);
  return createHash("sha1").update(`blob ${body.byteLength}\0`).update(body).digest("hex");
}

function git(repositoryRoot, args, options = {}) {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: options.encoding ?? "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
}

function repositoryRootOf(workerRoot) {
  return resolve(workerRoot, "..", "..");
}

function requireCommit(repositoryRoot, commit) {
  try {
    const resolved = git(repositoryRoot, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]).trim();
    if (resolved !== commit) fail("LEGACY_ORACLE_COMMIT_UNAVAILABLE", `${commit} resolves to ${resolved}`);
  } catch (error) {
    if (error instanceof LegacyOracleVendorError) throw error;
    fail("LEGACY_ORACLE_COMMIT_UNAVAILABLE",
      `the local repository does not hold ${commit}; fetch it before vendoring or checking the oracle`);
  }
}

/** Blob ids of every extracted file at the commit, by repository path. */
function commitBlobs(repositoryRoot, commit) {
  const listing = git(repositoryRoot, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", ...EXTRACTED_ROOTS]);
  const blobs = new Map();
  for (const entry of listing.split("\0").filter(Boolean)) {
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/su.exec(entry);
    if (!match) fail("LEGACY_ORACLE_TREE_INVALID", "unexpected ls-tree entry");
    const [, mode, type, blob, path] = match;
    if (type !== "blob" || mode === "120000") fail("LEGACY_ORACLE_TREE_INVALID", `${path} is not a regular file`);
    blobs.set(path, blob);
  }
  return blobs;
}

/** Extract the roots the commit holds (git archive refuses a pathspec that matches nothing). */
function extract(repositoryRoot, commit, blobs, directory) {
  const present = EXTRACTED_ROOTS.filter((root) => [...blobs.keys()]
    .some((path) => path === root || path.startsWith(`${root}/`)));
  if (present.length === 0) fail("LEGACY_ORACLE_TREE_INVALID", "the commit holds none of the oracle's roots");
  const archive = git(repositoryRoot, ["archive", "--format=tar", commit, "--", ...present], { encoding: "buffer" });
  execFileSync("tar", ["-x", "-f", "-", "-C", directory], { input: archive, stdio: ["pipe", "ignore", "pipe"] });
}

function loadEsbuild(workerRoot) {
  return createRequire(join(workerRoot, "package.json"))("esbuild");
}

/** Leaves each relative import of a live seam module external, so the closure stops there. */
function liveSeamPlugin(root) {
  const seams = new Set(ORACLE_LIVE_SEAMS.map((seam) => join(root, seam)));
  return {
    name: "legacy-oracle-live-seams",
    setup(build) {
      build.onResolve({ filter: /^\.\.?\// }, ({ path, resolveDir }) => {
        const target = resolve(resolveDir, path);
        return seams.has(target) || seams.has(`${target}.ts`) ? { path, external: true } : undefined;
      });
    },
  };
}

/** Every module esbuild parses for the entry points, as repository paths under root. */
export async function moduleClosure({ esbuild, root }) {
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: ORACLE_ENTRY_POINTS.map((entry) => join(root, entry)),
    bundle: true,
    write: false,
    metafile: true,
    platform: "neutral",
    format: "esm",
    mainFields: ["module", "main"],
    outdir: join(root, ".legacy-oracle-out"),
    logLevel: "silent",
    alias: Object.fromEntries(Object.entries(ORACLE_PACKAGE_ENTRIES)
      .map(([specifier, entry]) => [specifier, join(root, entry)])),
    external: ["node:*", "cloudflare:*", ...ORACLE_EXTERNAL_PACKAGES.flatMap((name) => [name, `${name}/*`])],
    plugins: [liveSeamPlugin(root)],
  }).catch((error) => fail("LEGACY_ORACLE_CLOSURE_UNRESOLVED",
    (error?.errors ?? []).map((entry) => entry.text).join("; ") || "esbuild could not bundle the entry points"));
  const modules = Object.keys(result.metafile.inputs).map((input) => input.split(sep).join("/")).sort();
  for (const path of modules) {
    if (!VENDORED_PATH.test(path)) fail("LEGACY_ORACLE_CLOSURE_UNEXPECTED", `${path} is outside the vendored layout`);
  }
  for (const entry of ORACLE_ENTRY_POINTS) {
    if (!modules.includes(entry)) fail("LEGACY_ORACLE_CLOSURE_UNEXPECTED", `${entry} is not in its own closure`);
  }
  for (const seam of ORACLE_LIVE_SEAMS) {
    if (modules.includes(seam)) fail("LEGACY_ORACLE_CLOSURE_UNEXPECTED", `${seam} is a live seam but was vendored`);
  }
  return modules;
}

/** Runtime modules of the vendored workspace packages: index.js and src/*.js. */
const PACKAGE_MODULE = /^packages\/(?:quota-analysis|telemetry-contract)\/(?:index\.js|src\/[a-z0-9.-]+\.js)$/u;

/** Every runtime module of each package the closure reaches. */
function packageModules(blobs, modules) {
  const reached = new Set(modules.filter((module) => module.startsWith("packages/"))
    .map((module) => module.split("/").slice(0, 2).join("/")));
  return [...blobs.keys()].filter((path) => PACKAGE_MODULE.test(path)
    && reached.has(path.split("/").slice(0, 2).join("/"))).sort();
}

function d1Migrations(blobs) {
  return [...blobs.keys()].filter((path) => {
    const [apps, worker, directory, name, ...rest] = path.split("/");
    return apps === "apps" && worker === "worker" && rest.length === 0
      && ORACLE_D1_DIRECTORIES.includes(directory) && D1_MIGRATION_NAME.test(name ?? "");
  }).sort();
}

function lockedVersions(root) {
  const lockPath = join(root, "apps/worker/package-lock.json");
  if (!existsSync(lockPath)) fail("LEGACY_ORACLE_EXTERNAL_UNLOCKED", "the commit has no Worker lockfile");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  return Object.fromEntries(ORACLE_EXTERNAL_PACKAGES.map((name) => {
    const version = lock.packages?.[`node_modules/${name}`]?.version;
    if (typeof version !== "string" || version.length === 0) {
      fail("LEGACY_ORACLE_EXTERNAL_UNLOCKED", `${name} has no locked version at the commit`);
    }
    return [name, version];
  }));
}

export function renderManifest({ commit, files, externals }) {
  return `${JSON.stringify({
    schemaVersion: MANIFEST_SCHEMA,
    sourceCommit: commit,
    generator: GENERATOR,
    check: CHECK,
    note: "Byte-for-byte copies of the d43c8f92 Worker modules, workspace package modules and D1 migrations the IN-3 legacy admission oracle runs; liveSeams resolve from the live tree. Generated; never edit by hand.",
    entryPoints: ORACLE_ENTRY_POINTS,
    liveSeams: ORACLE_LIVE_SEAMS,
    d1Directories: ORACLE_D1_DIRECTORIES,
    packageEntries: ORACLE_PACKAGE_ENTRIES,
    externals,
    files,
  }, null, 2)}\n`;
}

/** Derive the vendored tree for the commit: { files: [{ path, blob }], externals, manifest }. */
export async function deriveOracleVendor({ workerRoot = WORKER_ROOT, commit = ORACLE_COMMIT, esbuild } = {}) {
  const repositoryRoot = repositoryRootOf(workerRoot);
  requireCommit(repositoryRoot, commit);
  const blobs = commitBlobs(repositoryRoot, commit);
  // esbuild reports real paths; macOS's tmpdir is a symlink.
  const extraction = realpathSync(mkdtempSync(join(tmpdir(), "tibotattle-legacy-oracle-")));
  try {
    extract(repositoryRoot, commit, blobs, extraction);
    // esbuild is this checkout's tool, whatever tree is being vendored.
    const modules = await moduleClosure({ esbuild: esbuild ?? loadEsbuild(WORKER_ROOT), root: extraction });
    const packages = packageModules(blobs, modules);
    for (const path of modules.filter((module) => module.startsWith("packages/"))) {
      if (!packages.includes(path)) fail("LEGACY_ORACLE_CLOSURE_UNEXPECTED", `${path} is not a package runtime module`);
    }
    const paths = [...new Set([...modules, ...packages, ...d1Migrations(blobs)])].sort();
    for (const entry of Object.values(ORACLE_PACKAGE_ENTRIES)) {
      if (!paths.includes(entry)) fail("LEGACY_ORACLE_CLOSURE_UNEXPECTED", `${entry} is aliased but not vendored`);
    }
    const files = paths.map((path) => {
      const blob = blobs.get(path);
      if (blob === undefined) fail("LEGACY_ORACLE_TREE_INVALID", `${path} has no blob at the commit`);
      const bytes = readFileSync(join(extraction, path));
      if (gitBlobId(bytes) !== blob) fail("LEGACY_ORACLE_TREE_INVALID", `${path} does not hash to its blob`);
      return { path, blob, bytes };
    });
    const externals = lockedVersions(extraction);
    return {
      files,
      externals,
      manifest: renderManifest({ commit, files: files.map(({ path, blob }) => ({ path, blob })), externals }),
    };
  } finally {
    rmSync(extraction, { recursive: true, force: true });
  }
}

function listTree(directory, base = directory, found = []) {
  if (!existsSync(directory)) return found;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) listTree(path, base, found);
    else found.push(relative(base, path).split(sep).join(posix.sep));
  }
  return found.sort();
}

/** Differences between a derived tree and the files on disk (empty when they are identical). */
export function compareOracleVendor(derived, vendorRoot) {
  const expected = new Map([[MANIFEST_FILE, Buffer.from(derived.manifest)],
    ...derived.files.map(({ path, bytes }) => [path, bytes])]);
  const actual = listTree(vendorRoot);
  const drift = [];
  for (const path of actual) {
    if (!expected.has(path)) drift.push(`unexpected ${path}`);
  }
  for (const [path, bytes] of expected) {
    if (!actual.includes(path)) drift.push(`missing ${path}`);
    else if (!readFileSync(join(vendorRoot, path)).equals(bytes)) drift.push(`differs ${path}`);
  }
  return drift.sort();
}

/** Stage the derived tree, prove it byte-identical, then replace the vendor directory. */
export function writeOracleVendor(derived, vendorRoot) {
  const staging = `${vendorRoot}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  try {
    for (const { path, bytes } of derived.files) {
      mkdirSync(dirname(join(staging, path)), { recursive: true });
      writeFileSync(join(staging, path), bytes);
    }
    writeFileSync(join(staging, MANIFEST_FILE), derived.manifest);
    const drift = compareOracleVendor(derived, staging);
    if (drift.length > 0) fail("LEGACY_ORACLE_STAGING_INVALID", drift.join("; "));
    rmSync(vendorRoot, { recursive: true, force: true });
    renameSync(staging, vendorRoot);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function main(argv) {
  const known = new Set(["--check"]);
  const unknown = argv.filter((argument) => !known.has(argument));
  if (unknown.length > 0) fail("LEGACY_ORACLE_USAGE", `unknown argument ${unknown[0]}`);
  const vendorRoot = join(WORKER_ROOT, ORACLE_VENDOR_RELATIVE);
  const derived = await deriveOracleVendor();
  if (argv.includes("--check")) {
    const drift = compareOracleVendor(derived, vendorRoot);
    if (drift.length > 0) fail("LEGACY_ORACLE_VENDOR_DRIFT", drift.join("; "));
    console.log(`Legacy oracle vendor is current: ${derived.files.length} files at ${ORACLE_COMMIT}.`);
    return;
  }
  writeOracleVendor(derived, vendorRoot);
  console.log(`Vendored ${derived.files.length} legacy oracle files at ${ORACLE_COMMIT}.`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof LegacyOracleVendorError ? error.message : String(error?.stack ?? error));
    process.exitCode = 1;
  });
}
