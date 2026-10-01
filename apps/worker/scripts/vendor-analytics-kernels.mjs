#!/usr/bin/env node
// Vendors the production analytics kernels at d43c8f92 into
// vendor/analytics-d43c8f92 so the GCP line runs exactly production's
// arithmetic, independently of its own src/ and workspace packages.
//
// The closure is computed, not listed: esbuild bundles entry.ts (the reviewed
// facade), the website normalizer and the copied d43c8f92 parity specs from a
// throwaway extraction of the commit, and its metafile names every runtime
// input. Each input is then written byte-for-byte from its git blob. The three
// workspace packages are vendored whole (package.json, index.js, index.d.ts and
// src/**). The only edits are the five `export ` tokens in EXPORT_PATCHES.
// Type-only imports are erased by esbuild and are deliberately not vendored.
//
// Usage (from apps/worker): node scripts/vendor-analytics-kernels.mjs
// Verify with:              node scripts/vendor-analytics-kernels.check.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SOURCE_COMMIT = "d43c8f92a059d9c577776f7eca8a331eb305b8a6";
export const MANIFEST_SCHEMA = "analytics-kernel-vendor-manifest-v1";
export const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const VENDOR_RELATIVE = "vendor/analytics-d43c8f92";
export const VENDOR_ROOT = resolve(WORKER_ROOT, VENDOR_RELATIVE);
export const PARITY_RELATIVE = "analytics-v2-test/kernel-parity";
export const PARITY_ROOT = resolve(WORKER_ROOT, PARITY_RELATIVE);
export const MANIFEST_FILE = "MANIFEST.json";
/** Reviewed, hand-written files in the vendor directory (not from d43c8f92). */
export const AUTHORED_FILES = Object.freeze(["entry.ts", "tsconfig.json"]);
export const VENDORED_PACKAGES = Object.freeze(["accounting", "quota-analysis", "telemetry-contract"]);
/** Browser modules vendored so tests can read production output the way the site does. */
export const WEB_ROOTS = Object.freeze(["apps/web/public/community-data.js"]);
/** d43c8f92 Worker specs copied as kernel-parity tests, imports rewritten to the vendor tree. */
export const PARITY_SPECS = Object.freeze([
  "analytics-shared-reducers.spec.ts",
  "effective-quota-day.spec.ts",
  "analytics-shared-input.spec.ts",
  "quota-analysis-v11-features.spec.ts",
  "v11-daily-projection-values.spec.ts",
  "admin-community-allowance.spec.ts",
  "public-allowance-breakdowns.spec.ts",
  "quota-endpoint-collapse.spec.ts",
  "quota-analysis-v1-shared-finish.spec.ts",
]);
export const PARITY_HELPERS = Object.freeze(["helpers/telemetry-v11.ts"]);
/** The only edits to vendored bytes: add `export ` at the start of these d43c8f92 lines. */
export const EXPORT_PATCHES = Object.freeze([
  { path: "apps/worker/src/telemetry-usage-effective-reader.ts", line: 704, symbol: "reconciledAttribution",
    original: "function reconciledAttribution(" },
  { path: "apps/worker/src/telemetry-usage-effective-reader.ts", line: 725, symbol: "reconcileGroups",
    original: "async function reconcileGroups(" },
  { path: "apps/worker/src/telemetry-usage-effective-reader.ts", line: 999, symbol: "genericRecordJson",
    original: "function genericRecordJson(" },
  { path: "apps/worker/src/telemetry-usage-effective-reader.ts", line: 1021, symbol: "genericOccurrence",
    original: "function genericOccurrence(" },
  { path: "apps/worker/src/storage-community-daily.ts", line: 292, symbol: "publicInputs",
    original: "function publicInputs(" },
].map((patch) => Object.freeze(patch)));
export const EXPORT_TOKEN = "export ";

const WORKER_SRC = "apps/worker/src";
const WORKER_TEST = "apps/worker/test";
const PACKAGE_RULE = /^packages\/([a-z-]+)\/(package\.json|index\.js|index\.d\.ts|src\/.+)$/;

export class VendorError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

/** Git's object id for a blob with these bytes. */
export function gitBlobSha(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: WORKER_ROOT, encoding: "utf8" }).trim();
}

export function loadEsbuild() {
  return createRequire(join(WORKER_ROOT, "package.json"))("esbuild");
}

/** Repository paths of the parity sources at d43c8f92. */
export function paritySources() {
  return [...PARITY_SPECS, ...PARITY_HELPERS].map((rel) => ({ rel, source: `${WORKER_TEST}/${rel}` }));
}

/**
 * The quoted-specifier prefix that reaches d43c8f92 apps/worker/src from the
 * original test location, and the prefix that reaches the vendored copy from
 * the parity copy. The rewrite replaces only quoted occurrences of `from`.
 */
export function parityRewrite(rel) {
  const from = `${posix.relative(posix.dirname(`${WORKER_TEST}/${rel}`), WORKER_SRC)}/`;
  const to = `${posix.relative(posix.dirname(`apps/worker/${PARITY_RELATIVE}/${rel}`),
    `apps/worker/${VENDOR_RELATIVE}/${WORKER_SRC}`)}/`;
  return { from, to };
}

const QUOTES = ["'", "\""];

export function applyParityRewrite(text, { from, to }) {
  for (const q of QUOTES) {
    if (text.includes(`${q}${to}`)) throw new VendorError("PARITY_REWRITE_AMBIGUOUS", to);
  }
  let out = text;
  for (const q of QUOTES) out = out.split(`${q}${from}`).join(`${q}${to}`);
  for (const match of out.matchAll(/['"](\.\.\/[^'"]*)['"]/g)) {
    if (!match[1].startsWith(to)) throw new VendorError("PARITY_IMPORT_ESCAPES", match[1]);
  }
  return out;
}

export function reverseParityRewrite(text, { from, to }) {
  let out = text;
  for (const q of QUOTES) out = out.split(`${q}${to}`).join(`${q}${from}`);
  return out;
}

/** Adds the export tokens to one file's lines; throws unless each target line is exactly as recorded. */
export function applyExportPatches(path, bytes) {
  const patches = EXPORT_PATCHES.filter((patch) => patch.path === path);
  if (!patches.length) return bytes;
  const lines = bytes.toString("utf8").split("\n");
  for (const patch of patches) {
    const line = lines[patch.line - 1];
    if (typeof line !== "string" || !line.startsWith(patch.original)) {
      throw new VendorError("EXPORT_PATCH_TARGET_MOVED", `${path}:${patch.line} ${patch.symbol}`);
    }
    lines[patch.line - 1] = `${EXPORT_TOKEN}${line}`;
  }
  const out = Buffer.from(lines.join("\n"), "utf8");
  if (out.length !== bytes.length + EXPORT_TOKEN.length * patches.length) throw new VendorError("EXPORT_PATCH_NOT_MINIMAL", path);
  return out;
}

/** Removes exactly the recorded export tokens; throws if any recorded line lacks one. */
export function removeExportPatches(path, bytes) {
  const patches = EXPORT_PATCHES.filter((patch) => patch.path === path);
  if (!patches.length) return bytes;
  const lines = bytes.toString("utf8").split("\n");
  for (const patch of patches) {
    const line = lines[patch.line - 1];
    if (typeof line !== "string" || !line.startsWith(`${EXPORT_TOKEN}${patch.original}`)) {
      throw new VendorError("EXPORT_PATCH_MISSING", `${path}:${patch.line} ${patch.symbol}`);
    }
    lines[patch.line - 1] = line.slice(EXPORT_TOKEN.length);
  }
  return Buffer.from(lines.join("\n"), "utf8");
}

/** All blobs under these prefixes at SOURCE_COMMIT: Map<path, {mode, blob}>. */
function listTree(root, prefixes) {
  const out = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", SOURCE_COMMIT, "--", ...prefixes],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const tree = new Map();
  for (const record of out.toString("utf8").split("\0")) {
    if (!record) continue;
    const [meta, path] = record.split("\t");
    const [mode, type, blob] = meta.split(" ");
    if (type !== "blob") continue;
    if (mode !== "100644") throw new VendorError("UNSUPPORTED_MODE", `${mode} ${path}`);
    tree.set(path, { mode, blob });
  }
  return tree;
}

/** Reads blobs with one `git cat-file --batch`: Map<blob, Buffer>. */
function readBlobs(root, blobs) {
  const unique = [...new Set(blobs)];
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: root, input: `${unique.join("\n")}\n`, maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status !== 0) throw new VendorError("GIT_CAT_FILE_FAILED", result.stderr?.toString());
  const out = result.stdout;
  const map = new Map();
  let offset = 0;
  for (const blob of unique) {
    const newline = out.indexOf(0x0a, offset);
    const [sha, type, size] = out.subarray(offset, newline).toString("utf8").split(" ");
    if (sha !== blob || type !== "blob") throw new VendorError("GIT_CAT_FILE_FAILED", blob);
    const start = newline + 1;
    const bytes = Buffer.from(out.subarray(start, start + Number(size)));
    if (gitBlobSha(bytes) !== blob) throw new VendorError("GIT_BLOB_MISMATCH", blob);
    map.set(blob, bytes);
    offset = start + Number(size) + 1;
  }
  return map;
}

function writeFile(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

/**
 * Runs esbuild over a tree laid out like the vendor directory and returns the
 * runtime inputs of each named entry plus every bare import left external.
 * `@app-usagemonitor/*` must resolve through the tree's tsconfig.json paths;
 * any `cloudflare:` import fails the build.
 */
export async function computeRuntimeClosure({ esbuild, root, entryPoints }) {
  const externals = new Map();
  const cloudflare = [];
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints,
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    target: "node22",
    mainFields: ["module", "main"],
    outdir: join(root, ".closure-out"),
    logLevel: "silent",
    plugins: [{
      name: "vendor-closure-externals",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const spec = args.path;
          if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@app-usagemonitor/")) return undefined;
          if (spec.startsWith("cloudflare:")) cloudflare.push(`${args.importer} -> ${spec}`);
          const name = spec.startsWith("node:") ? spec : spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
          if (!externals.has(name)) externals.set(name, new Set());
          externals.get(name).add(args.importer);
          return { path: spec, external: true };
        });
      },
    }],
  });
  if (cloudflare.length) throw new VendorError("CLOUDFLARE_IMPORT_IN_CLOSURE", cloudflare.join(", "));
  const byEntry = {};
  for (const output of Object.values(result.metafile.outputs)) {
    if (!output.entryPoint) continue;
    const name = Object.entries(entryPoints).find(([, file]) => output.entryPoint === posix.normalize(file.split(sep).join("/")))?.[0];
    if (!name) throw new VendorError("CLOSURE_ENTRY_UNMAPPED", output.entryPoint);
    byEntry[name] = Object.keys(output.inputs).sort();
  }
  for (const name of Object.keys(entryPoints)) {
    if (!byEntry[name]) throw new VendorError("CLOSURE_ENTRY_MISSING", name);
  }
  return { byEntry, externals: [...externals.keys()].sort(), esbuildVersion: esbuild.version };
}

/** Entry points for a tree laid out like the vendor directory (paths relative to root). */
export function closureEntryPoints(parityPathFor) {
  const entries = { kernel: "entry.ts" };
  WEB_ROOTS.forEach((path, index) => { entries[`web${index}`] = path; });
  PARITY_SPECS.forEach((spec, index) => { entries[`parity${index}`] = parityPathFor(spec); });
  return entries;
}

/** Classifies closure inputs into vendored repository paths with their reach. */
export function classifyClosure(byEntry, { isParityInput }) {
  const reach = new Map();
  const mark = (path, value) => { if (!reach.has(path)) reach.set(path, value); };
  const order = ["kernel", ...Object.keys(byEntry).filter((name) => name.startsWith("web")),
    ...Object.keys(byEntry).filter((name) => name.startsWith("parity"))];
  for (const name of order) {
    const value = name === "kernel" ? "kernel" : name.startsWith("web") ? "web" : "parity";
    for (const input of byEntry[name]) {
      if (input === "entry.ts" || isParityInput(input)) continue;
      if (PACKAGE_RULE.test(input)) {
        const pkg = PACKAGE_RULE.exec(input)[1];
        if (!VENDORED_PACKAGES.includes(pkg)) throw new VendorError("UNVENDORED_PACKAGE_INPUT", input);
        continue;
      }
      if (!input.startsWith(`${WORKER_SRC}/`) && !input.startsWith("apps/web/public/")) {
        throw new VendorError("UNEXPECTED_CLOSURE_INPUT", input);
      }
      mark(input, value);
    }
  }
  return reach;
}

/** Paths this generator may own inside the vendor directory. */
export function isVendoredPath(path) {
  return !path.split("/").includes("..")
    && (path.startsWith(`${WORKER_SRC}/`) || path.startsWith("apps/web/public/")
      || (PACKAGE_RULE.test(path) && VENDORED_PACKAGES.includes(PACKAGE_RULE.exec(path)[1])));
}

function readManifest() {
  const path = join(VENDOR_ROOT, MANIFEST_FILE);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function removeEmptyDirectories(dir) {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return;
  for (const entry of readdirSync(dir)) removeEmptyDirectories(join(dir, entry));
  if (!readdirSync(dir).length) rmdirSync(dir);
}

/** Deletes only the files a previous manifest says this generator wrote. */
function removePreviousOutput(previous) {
  if (!previous) return;
  if (previous.schemaVersion !== MANIFEST_SCHEMA) throw new VendorError("MANIFEST_SCHEMA_UNKNOWN", previous.schemaVersion);
  // Resolve and validate every target before deleting any of them.
  const targets = [];
  for (const file of previous.files ?? []) {
    const target = resolve(VENDOR_ROOT, file.path);
    if (!target.startsWith(`${VENDOR_ROOT}${sep}`) || !isVendoredPath(file.path)) {
      throw new VendorError("MANIFEST_PATH_UNEXPECTED", file.path);
    }
    targets.push(target);
  }
  for (const test of previous.parityTests ?? []) {
    const target = resolve(WORKER_ROOT, test.path);
    if (!target.startsWith(`${PARITY_ROOT}${sep}`)) throw new VendorError("MANIFEST_PATH_UNEXPECTED", test.path);
    targets.push(target);
  }
  for (const target of targets) if (existsSync(target)) unlinkSync(target);
  for (const top of ["apps", "packages"]) removeEmptyDirectories(join(VENDOR_ROOT, top));
  removeEmptyDirectories(PARITY_ROOT);
}

export async function vendorAnalyticsKernels({ log = console.log } = {}) {
  const root = repoRoot();
  const resolved = execFileSync("git", ["rev-parse", "--verify", `${SOURCE_COMMIT}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
  if (resolved !== SOURCE_COMMIT) throw new VendorError("SOURCE_COMMIT_UNAVAILABLE", SOURCE_COMMIT);
  for (const file of AUTHORED_FILES) {
    if (!existsSync(join(VENDOR_ROOT, file))) throw new VendorError("AUTHORED_FILE_MISSING", file);
  }

  // 1. A throwaway extraction of the commit, laid out like the vendor directory.
  const tree = listTree(root, [WORKER_SRC, "apps/web/public",
    ...VENDORED_PACKAGES.map((pkg) => `packages/${pkg}`), ...paritySources().map(({ source }) => source)]);
  for (const { source } of paritySources()) if (!tree.has(source)) throw new VendorError("PARITY_SOURCE_MISSING", source);
  const extractable = [...tree.keys()].filter((path) => path.startsWith(`${WORKER_SRC}/`) || PACKAGE_RULE.test(path)
    || (path.startsWith("apps/web/public/") && path.endsWith(".js")) || path.startsWith(`${WORKER_TEST}/`));
  const blobs = readBlobs(root, extractable.map((path) => tree.get(path).blob));
  const scratch = mkdtempSync(join(tmpdir(), "vendor-analytics-kernels-"));
  try {
    for (const path of extractable) writeFile(join(scratch, path), applyExportPatches(path, blobs.get(tree.get(path).blob)));
    for (const file of AUTHORED_FILES) writeFile(join(scratch, file), readFileSync(join(VENDOR_ROOT, file)));

    // 2. Runtime closure from the facade, the website normalizer and the parity specs.
    const esbuild = loadEsbuild();
    const parityInputs = new Set(paritySources().map(({ source }) => source));
    const closure = await computeRuntimeClosure({ esbuild, root: scratch,
      entryPoints: closureEntryPoints((spec) => `${WORKER_TEST}/${spec}`) });
    for (const inputs of Object.values(closure.byEntry)) {
      for (const input of inputs) {
        if (input.startsWith(`${WORKER_TEST}/`) && !parityInputs.has(input)) throw new VendorError("UNLISTED_PARITY_HELPER", input);
      }
    }
    const reach = classifyClosure(closure.byEntry, { isParityInput: (input) => parityInputs.has(input) });

    // 3. Files: the closure plus the whole of each vendored package.
    const files = [];
    for (const path of [...tree.keys()].sort()) {
      const pkg = PACKAGE_RULE.exec(path);
      const value = pkg && VENDORED_PACKAGES.includes(pkg[1]) ? "package" : reach.get(path);
      if (!value) continue;
      const original = blobs.get(tree.get(path).blob);
      const vendored = applyExportPatches(path, original);
      files.push({ path, blob: tree.get(path).blob, sha256: sha256(vendored),
        patch: EXPORT_PATCHES.some((patch) => patch.path === path) ? "export" : "none", reach: value, bytes: vendored });
    }
    for (const path of reach.keys()) if (!files.some((file) => file.path === path)) throw new VendorError("CLOSURE_INPUT_NOT_IN_TREE", path);

    const parityTests = paritySources().map(({ rel, source }) => {
      const rewrite = parityRewrite(rel);
      const original = blobs.get(tree.get(source).blob);
      const text = applyParityRewrite(original.toString("utf8"), rewrite);
      if (reverseParityRewrite(text, rewrite) !== original.toString("utf8")) throw new VendorError("PARITY_REWRITE_IRREVERSIBLE", source);
      return { path: `${PARITY_RELATIVE}/${rel}`, source, blob: tree.get(source).blob, rewrite, bytes: Buffer.from(text, "utf8") };
    });

    // 4. Replace previous output, then write.
    removePreviousOutput(readManifest());
    for (const file of files) writeFile(join(VENDOR_ROOT, file.path), file.bytes);
    for (const test of parityTests) writeFile(join(WORKER_ROOT, test.path), test.bytes);
    const manifest = {
      schemaVersion: MANIFEST_SCHEMA,
      sourceCommit: SOURCE_COMMIT,
      generator: "apps/worker/scripts/vendor-analytics-kernels.mjs",
      check: "apps/worker/scripts/vendor-analytics-kernels.check.mjs",
      authoredFiles: [...AUTHORED_FILES],
      closure: {
        tool: "esbuild-metafile",
        esbuildVersion: closure.esbuildVersion,
        entryPoints: Object.values(closureEntryPoints((spec) => `${WORKER_TEST}/${spec}`)),
        packageRule: "packages/{accounting,quota-analysis,telemetry-contract}/{package.json,index.js,index.d.ts,src/**}",
        typeOnlyImports: "erased by esbuild and not vendored",
        externals: closure.externals,
      },
      exportPatches: EXPORT_PATCHES.map(({ path, line, symbol, original }) => ({ path, line, symbol, original })),
      counts: {
        files: files.length,
        kernel: files.filter((file) => file.reach === "kernel").length,
        web: files.filter((file) => file.reach === "web").length,
        parity: files.filter((file) => file.reach === "parity").length,
        package: files.filter((file) => file.reach === "package").length,
        exportPatched: EXPORT_PATCHES.length,
        exportPatchedFiles: files.filter((file) => file.patch === "export").length,
        parityTests: parityTests.length,
      },
      files: files.map(({ path, blob, sha256: digest, patch, reach: value }) => ({ path, blob, sha256: digest, patch, reach: value })),
      parityTests: parityTests.map(({ path, source, blob, rewrite }) => ({ path, source, blob, rewrite })),
    };
    writeFileSync(join(VENDOR_ROOT, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    log(JSON.stringify({ status: "ok", sourceCommit: SOURCE_COMMIT, ...manifest.counts, externals: closure.externals }));
    return manifest;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await vendorAnalyticsKernels();
  } catch (error) {
    console.error(error instanceof VendorError ? error.message : error);
    process.exitCode = 1;
  }
}
