// Mechanical identity check for vendor/analytics-d43c8f92 and the copied
// kernel-parity specs. Run from apps/worker:
//   node scripts/vendor-analytics-kernels.check.mjs
// It needs the git object for d43c8f92 and fails closed without it. The
// identity arithmetic (git blob ids, export-token removal and the parity
// rewrite reversal) is implemented here independently of the generator; only
// the reviewed lists are shared, and the export patches are pinned below.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AUTHORED_FILES, EXPORT_PATCHES, MANIFEST_FILE, MANIFEST_SCHEMA, PARITY_HELPERS, PARITY_RELATIVE, PARITY_SPECS,
  SOURCE_COMMIT, VENDOR_RELATIVE, VENDORED_PACKAGES, WEB_ROOTS,
} from "./vendor-analytics-kernels.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_ROOT = resolve(WORKER_ROOT, VENDOR_RELATIVE);
const PARITY_ROOT = resolve(WORKER_ROOT, PARITY_RELATIVE);
const COMMIT = "d43c8f92a059d9c577776f7eca8a331eb305b8a6";
const TOKEN = "export ";
/** Pinned on purpose: changing the patch set must change this check too. */
const PINNED_EXPORT_PATCHES = [
  ["apps/worker/src/telemetry-usage-effective-reader.ts", 704, "reconciledAttribution", "function reconciledAttribution("],
  ["apps/worker/src/telemetry-usage-effective-reader.ts", 725, "reconcileGroups", "async function reconcileGroups("],
  ["apps/worker/src/telemetry-usage-effective-reader.ts", 999, "genericRecordJson", "function genericRecordJson("],
  ["apps/worker/src/telemetry-usage-effective-reader.ts", 1021, "genericOccurrence", "function genericOccurrence("],
  ["apps/worker/src/storage-community-daily.ts", 292, "publicInputs", "function publicInputs("],
].map(([path, line, symbol, original]) => ({ path, line, symbol, original }));
const PACKAGE_FILE = /^packages\/([a-z-]+)\/(package\.json|index\.js|index\.d\.ts|src\/.+)$/;

const manifest = JSON.parse(readFileSync(join(VENDOR_ROOT, MANIFEST_FILE), "utf8"));
const blobId = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (args) => execFileSync("git", args, { cwd: WORKER_ROOT, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });

/** `git rev-parse <commit>:<path>` for many paths in one call. */
function revParse(paths) {
  const out = git(["rev-parse", ...paths.map((path) => `${COMMIT}:${path}`)]).trim().split("\n");
  assert.equal(out.length, paths.length);
  return new Map(paths.map((path, index) => [path, out[index]]));
}

function stripExportTokens(path, bytes) {
  const patches = PINNED_EXPORT_PATCHES.filter((patch) => patch.path === path);
  const lines = bytes.toString("utf8").split("\n");
  for (const patch of patches) {
    const line = lines[patch.line - 1];
    assert.ok(line?.startsWith(`${TOKEN}${patch.original}`), `${path}:${patch.line} lacks the ${patch.symbol} export token`);
    lines[patch.line - 1] = line.slice(TOKEN.length);
  }
  return Buffer.from(lines.join("\n"), "utf8");
}

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      assert.ok(entry.isDirectory() || entry.isFile(), `${path} is neither a file nor a directory`);
      if (entry.isDirectory()) walk(path); else out.push(relative(root, path).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

function quotedRewrite(text, from, to) {
  return ["'", "\""].reduce((value, quote) => value.split(`${quote}${from}`).join(`${quote}${to}`), text);
}

test("the manifest pins d43c8f92 and exactly five export patches", () => {
  assert.equal(SOURCE_COMMIT, COMMIT);
  assert.equal(manifest.schemaVersion, MANIFEST_SCHEMA);
  assert.equal(manifest.sourceCommit, COMMIT);
  assert.equal(git(["rev-parse", "--verify", `${COMMIT}^{commit}`]).trim(), COMMIT);
  assert.deepEqual(manifest.exportPatches, PINNED_EXPORT_PATCHES);
  assert.deepEqual(EXPORT_PATCHES.map((patch) => ({ ...patch })), PINNED_EXPORT_PATCHES);
  assert.equal(manifest.exportPatches.length, 5);
  assert.equal(manifest.counts.exportPatched, 5);
  const patchedFiles = [...new Set(PINNED_EXPORT_PATCHES.map((patch) => patch.path))].sort();
  assert.deepEqual(manifest.files.filter((file) => file.patch === "export").map((file) => file.path).sort(), patchedFiles);
  assert.ok(manifest.files.every((file) => file.patch === (patchedFiles.includes(file.path) ? "export" : "none")));
});

test("every vendored file equals git rev-parse d43c8f92:<path> after export-token removal", () => {
  const expected = revParse(manifest.files.map((file) => file.path));
  for (const file of manifest.files) {
    const bytes = readFileSync(join(VENDOR_ROOT, file.path));
    assert.equal(digest(bytes), file.sha256, `${file.path} sha256 differs from the manifest`);
    const original = stripExportTokens(file.path, bytes);
    if (file.patch === "export") {
      const patches = PINNED_EXPORT_PATCHES.filter((patch) => patch.path === file.path).length;
      assert.equal(bytes.length, original.length + TOKEN.length * patches, `${file.path} has edits beyond its export tokens`);
    }
    assert.equal(blobId(original), file.blob, `${file.path} differs from its manifest blob`);
    assert.equal(file.blob, expected.get(file.path), `${file.path} differs from d43c8f92`);
  }
});

test("the vendor directory holds exactly the manifest files and the authored facade", () => {
  assert.deepEqual(listFiles(VENDOR_ROOT),
    [...manifest.files.map((file) => file.path), ...AUTHORED_FILES, MANIFEST_FILE].sort());
  assert.deepEqual(manifest.authoredFiles, [...AUTHORED_FILES]);
  assert.equal(manifest.counts.files, manifest.files.length);
  assert.equal(new Set(manifest.files.map((file) => file.path)).size, manifest.files.length);
});

test("each vendored package is complete at d43c8f92", () => {
  const tree = git(["ls-tree", "-r", "--name-only", "--full-tree", COMMIT, "--",
    ...VENDORED_PACKAGES.map((pkg) => `packages/${pkg}`)]).trim().split("\n");
  const expected = tree.filter((path) => PACKAGE_FILE.test(path)).sort();
  assert.ok(expected.length > 0);
  for (const pkg of VENDORED_PACKAGES) {
    for (const file of ["package.json", "index.js", "index.d.ts"]) assert.ok(expected.includes(`packages/${pkg}/${file}`));
  }
  assert.deepEqual(manifest.files.filter((file) => file.reach === "package").map((file) => file.path).sort(), expected);
});

test("kernel-parity specs are d43c8f92 specs with only their src import prefix rewritten", () => {
  const sources = [...PARITY_SPECS, ...PARITY_HELPERS];
  assert.equal(PARITY_SPECS.length, 9);
  assert.deepEqual(manifest.parityTests.map((entry) => entry.source), sources.map((rel) => `apps/worker/test/${rel}`));
  assert.deepEqual(listFiles(PARITY_ROOT).map((rel) => `${PARITY_RELATIVE}/${rel}`),
    manifest.parityTests.map((entry) => entry.path).sort());
  const expected = revParse(manifest.parityTests.map((entry) => entry.source));
  for (const entry of manifest.parityTests) {
    const text = readFileSync(join(WORKER_ROOT, entry.path), "utf8");
    const { from, to } = entry.rewrite;
    assert.equal(resolve(dirname(join(WORKER_ROOT, entry.path)), to), join(VENDOR_ROOT, "apps/worker/src"));
    for (const match of text.matchAll(/['"](\.\.\/[^'"]*)['"]/g)) {
      assert.ok(match[1].startsWith(to), `${entry.path} reaches outside the vendor tree: ${match[1]}`);
    }
    const original = Buffer.from(quotedRewrite(text, to, from), "utf8");
    assert.equal(blobId(original), entry.blob, `${entry.path} has edits beyond its import prefix`);
    assert.equal(entry.blob, expected.get(entry.source), `${entry.source} differs from d43c8f92`);
  }
});

test("no vendored or parity file imports a cloudflare: module", () => {
  const offenders = [
    ...listFiles(VENDOR_ROOT).map((path) => join(VENDOR_ROOT, path)),
    ...listFiles(PARITY_ROOT).map((path) => join(PARITY_ROOT, path)),
  ].filter((path) => readFileSync(path, "utf8").includes("cloudflare:"));
  assert.deepEqual(offenders, []);
});

/** esbuild over the vendored tree itself: inputs per entry, relative to apps/worker. */
async function vendoredClosure() {
  const esbuild = createRequire(join(WORKER_ROOT, "package.json"))("esbuild");
  const entryPoints = { kernel: `${VENDOR_RELATIVE}/entry.ts` };
  WEB_ROOTS.forEach((path, index) => { entryPoints[`web${index}`] = `${VENDOR_RELATIVE}/${path}`; });
  PARITY_SPECS.forEach((spec, index) => { entryPoints[`parity${index}`] = `${PARITY_RELATIVE}/${spec}`; });
  const vendoredPackage = (name) => join(VENDOR_ROOT, "packages", name.slice("@app-usagemonitor/".length), "index.js");
  const result = await esbuild.build({
    absWorkingDir: WORKER_ROOT, entryPoints, bundle: true, write: false, metafile: true, platform: "node",
    format: "esm", target: "node22", mainFields: ["module", "main"], outdir: join(WORKER_ROOT, ".vendor-closure-check"),
    logLevel: "silent",
    plugins: [{
      name: "vendor-closure-check",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (args.path.startsWith(".") || args.path.startsWith("/")) return undefined;
          if (args.path.startsWith("@app-usagemonitor/")) {
            // Vendor-internal importers must resolve through tsconfig.json paths
            // (what the plain esbuild CLI uses); parity specs mirror the Vitest plugin.
            if (args.importer.startsWith(`${PARITY_ROOT}${sep}`)) return { path: vendoredPackage(args.path) };
            return undefined;
          }
          return { path: args.path, external: true };
        });
      },
    }],
  });
  const byEntry = {};
  for (const output of Object.values(result.metafile.outputs)) {
    const name = Object.entries(entryPoints).find(([, path]) => path === output.entryPoint)?.[0];
    if (name) byEntry[name] = Object.keys(output.inputs);
  }
  return byEntry;
}

test("the manifest is exactly the runtime closure of the facade, the site normalizer and the parity specs", async () => {
  const byEntry = await vendoredClosure();
  const prefix = `${VENDOR_RELATIVE}/`;
  const reachOf = (name) => (name === "kernel" ? "kernel" : name.startsWith("web") ? "web" : "parity");
  const reach = new Map();
  for (const name of ["kernel", ...Object.keys(byEntry).filter((key) => key !== "kernel").sort()]) {
    for (const input of byEntry[name]) {
      if (input.startsWith(`${PARITY_RELATIVE}/`)) continue;
      assert.ok(input.startsWith(prefix), `${name} reaches outside the vendor tree: ${input}`);
      const path = input.slice(prefix.length);
      if (path === "entry.ts") continue;
      if (PACKAGE_FILE.test(path)) {
        assert.ok(VENDORED_PACKAGES.includes(PACKAGE_FILE.exec(path)[1]), `${input} is not a vendored package`);
        continue;
      }
      if (!reach.has(path)) reach.set(path, reachOf(name));
    }
  }
  assert.ok(byEntry.kernel.some((input) => input.startsWith(`${prefix}packages/`)), "kernel resolved no vendored package");
  const closure = [...reach.entries()].map(([path, value]) => `${value} ${path}`).sort();
  const listed = manifest.files.filter((file) => file.reach !== "package").map((file) => `${file.reach} ${file.path}`).sort();
  assert.deepEqual(closure, listed);
});

test("the facade bundles for Node and prepares an empty owner-day", async () => {
  const esbuild = createRequire(join(WORKER_ROOT, "package.json"))("esbuild");
  const result = await esbuild.build({
    absWorkingDir: WORKER_ROOT, entryPoints: [`${VENDOR_RELATIVE}/entry.ts`], bundle: true, write: false,
    platform: "node", format: "esm", mainFields: ["module", "main"], logLevel: "silent", metafile: true,
  });
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(!inputs.some((input) => /node_modules\/@app-usagemonitor\//.test(input)), "bundle used non-vendored packages");
  const dir = mkdtempSync(join(tmpdir(), "vendor-analytics-kernels-check-"));
  try {
    const file = join(dir, "kernels.mjs");
    writeFileSync(file, result.outputFiles[0].contents);
    const kernels = await import(pathToFileURL(file).href);
    const day = await kernels.prepareSharedAnalyticsDay({ day: "2026-09-30", ownerDigest: "a".repeat(64),
      usage: [], quota: [], session: [] });
    assert.equal(day.day, "2026-09-30");
    assert.equal(day.daily.counts.usage + day.daily.counts.quota + day.daily.counts.session, 0);
    assert.equal(typeof kernels.publicInputs, "function");
    assert.equal(typeof kernels.reconcileGroups, "function");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
