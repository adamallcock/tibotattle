// Mechanical identity check for every vendored analytics-kernel tree
// (vendor/analytics-<commit>) and its copied kernel-parity specs, and the
// negative tests for the generator's commit argument and symbol-located export
// patches. Run from apps/worker:
//   node scripts/vendor-analytics-kernels.check.mjs
// It needs the git objects of each vendored commit and fails closed without
// them. The identity arithmetic (git blob ids, export-token removal and the
// parity rewrite reversal) is implemented here independently of the generator;
// only the reviewed lists are shared. The d43c8f92 export patches are pinned
// below, both as the symbols the generator is given and as the lines the
// generator must find them on. Other vendored commits are checked against
// their own manifests. The generated type stubs are checked by re-emitting
// them, and by typechecking the app program plus one consumer of entry.ts with
// this checkout's tsc. A scratch regeneration of d43c8f92 must reproduce the
// committed tree byte for byte.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyExportPatches, assertExportPatchesResolved, assertPatchSpecs, AUTHORED_FILES, buildManifest, EXPORT_PATCHES,
  locateExportSymbol, main, MANIFEST_FILE, MANIFEST_SCHEMA, maskNonCode, PARITY_HELPERS, PARITY_SPECS,
  parseArguments, parseCommit, planExportPatches, regenerateTypeStubs, reportAtCommit, resolveExportPatches, SOURCE_COMMIT,
  VendorError, vendorLayout, VENDORED_PACKAGES, verifyExportPatches, WEB_ROOTS,
} from "./vendor-analytics-kernels.mjs";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATOR = join(WORKER_ROOT, "scripts", "vendor-analytics-kernels.mjs");
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
/** The generator's patch list: symbols and declaration kinds, no line numbers. */
const PINNED_PATCH_SPECS = [
  ["apps/worker/src/telemetry-usage-effective-reader.ts", "reconciledAttribution", "function"],
  ["apps/worker/src/telemetry-usage-effective-reader.ts", "reconcileGroups", "async function"],
  ["apps/worker/src/telemetry-usage-effective-reader.ts", "genericRecordJson", "function"],
  ["apps/worker/src/telemetry-usage-effective-reader.ts", "genericOccurrence", "function"],
  ["apps/worker/src/storage-community-daily.ts", "publicInputs", "function"],
].map(([path, symbol, declaration]) => ({ path, symbol, declaration }));
const PACKAGE_FILE = /^packages\/([a-z-]+)\/(package\.json|index\.js|index\.d\.ts|src\/.+)$/;

const blobId = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (args) => execFileSync("git", args, { cwd: WORKER_ROOT, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });

/** `git rev-parse <commit>:<path>` for many paths in one call. */
function revParse(commit, paths) {
  const out = git(["rev-parse", ...paths.map((path) => `${commit}:${path}`)]).trim().split("\n");
  assert.equal(out.length, paths.length);
  return new Map(paths.map((path, index) => [path, out[index]]));
}

/** Removes exactly the recorded export tokens; each recorded line must carry its token. */
function stripExportTokens(path, bytes, patches) {
  const mine = patches.filter((patch) => patch.path === path);
  const lines = bytes.toString("utf8").split("\n");
  for (const patch of mine) {
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

/** A vendored tree under test: where it lives, its manifest and the patches it must record. */
function describeTree(layout, patches) {
  const manifest = JSON.parse(readFileSync(join(layout.vendorRoot, MANIFEST_FILE), "utf8"));
  return { layout, manifest, patches, commit: layout.commit, short: layout.short };
}

// ---------------------------------------------------------------------------
// Identity assertions, shared by the committed trees and by scratch regenerations
// ---------------------------------------------------------------------------

function assertManifestPins(tree) {
  const { manifest, patches, commit } = tree;
  assert.equal(manifest.schemaVersion, MANIFEST_SCHEMA);
  assert.equal(manifest.sourceCommit, commit);
  assert.equal(git(["rev-parse", "--verify", `${commit}^{commit}`]).trim(), commit);
  assert.deepEqual(manifest.exportPatches, patches);
  assert.equal(manifest.counts.exportPatched, patches.length);
  const patchedFiles = [...new Set(patches.map((patch) => patch.path))].sort();
  assert.deepEqual(manifest.files.filter((file) => file.patch === "export").map((file) => file.path).sort(), patchedFiles);
  assert.ok(manifest.files.every((file) => file.patch === (patchedFiles.includes(file.path) ? "export" : "none")));
}

function assertFilesMatchCommit(tree) {
  const { manifest, patches, commit, layout } = tree;
  const expected = revParse(commit, manifest.files.map((file) => file.path));
  for (const file of manifest.files) {
    const bytes = readFileSync(join(layout.vendorRoot, file.path));
    assert.equal(digest(bytes), file.sha256, `${file.path} sha256 differs from the manifest`);
    const original = stripExportTokens(file.path, bytes, patches);
    if (file.patch === "export") {
      const count = patches.filter((patch) => patch.path === file.path).length;
      assert.equal(bytes.length, original.length + TOKEN.length * count, `${file.path} has edits beyond its export tokens`);
    }
    assert.equal(blobId(original), file.blob, `${file.path} differs from its manifest blob`);
    assert.equal(file.blob, expected.get(file.path), `${file.path} differs from ${tree.short}`);
  }
}

function assertDirectoryHoldsManifestFiles(tree) {
  const { manifest, layout } = tree;
  assert.deepEqual(listFiles(layout.vendorRoot), [...manifest.files.map((file) => file.path),
    ...manifest.typeStubs.map((stub) => stub.path), ...AUTHORED_FILES, MANIFEST_FILE].sort());
  assert.deepEqual(manifest.authoredFiles, [...AUTHORED_FILES]);
  assert.equal(manifest.counts.files, manifest.files.length);
  assert.equal(new Set(manifest.files.map((file) => file.path)).size, manifest.files.length);
}

function assertPackagesComplete(tree) {
  const tracked = git(["ls-tree", "-r", "--name-only", "--full-tree", tree.commit, "--",
    ...VENDORED_PACKAGES.map((pkg) => `packages/${pkg}`)]).trim().split("\n");
  const expected = tracked.filter((path) => PACKAGE_FILE.test(path)).sort();
  assert.ok(expected.length > 0);
  for (const pkg of VENDORED_PACKAGES) {
    for (const file of ["package.json", "index.js", "index.d.ts"]) assert.ok(expected.includes(`packages/${pkg}/${file}`));
  }
  assert.deepEqual(tree.manifest.files.filter((file) => file.reach === "package").map((file) => file.path).sort(), expected);
}

function assertParitySpecsRewritten(tree) {
  const { manifest, commit, layout } = tree;
  const sources = [...PARITY_SPECS, ...PARITY_HELPERS];
  assert.equal(PARITY_SPECS.length, 9);
  assert.deepEqual(manifest.parityTests.map((entry) => entry.source), sources.map((rel) => `apps/worker/test/${rel}`));
  assert.deepEqual(listFiles(layout.parityRoot).map((rel) => `${layout.parityRelative}/${rel}`),
    manifest.parityTests.map((entry) => entry.path).sort());
  const expected = revParse(commit, manifest.parityTests.map((entry) => entry.source));
  for (const entry of manifest.parityTests) {
    const text = readFileSync(join(layout.outRoot, entry.path), "utf8");
    const { from, to } = entry.rewrite;
    assert.equal(resolve(dirname(join(layout.outRoot, entry.path)), to), join(layout.vendorRoot, "apps/worker/src"));
    for (const match of text.matchAll(/['"](\.\.\/[^'"]*)['"]/g)) {
      assert.ok(match[1].startsWith(to), `${entry.path} reaches outside the vendor tree: ${match[1]}`);
    }
    const original = Buffer.from(quotedRewrite(text, to, from), "utf8");
    assert.equal(blobId(original), entry.blob, `${entry.path} has edits beyond its import prefix`);
    assert.equal(entry.blob, expected.get(entry.source), `${entry.source} differs from ${tree.short}`);
  }
}

function assertNoCloudflareImports(tree) {
  const { layout } = tree;
  const offenders = [
    ...listFiles(layout.vendorRoot).map((path) => join(layout.vendorRoot, path)),
    ...listFiles(layout.parityRoot).map((path) => join(layout.parityRoot, path)),
  ].filter((path) => readFileSync(path, "utf8").includes("cloudflare:"));
  assert.deepEqual(offenders, []);
}

// ---------------------------------------------------------------------------
// Committed trees: d43c8f92 (pinned) and any other vendor/analytics-<8 hex>
// ---------------------------------------------------------------------------

const DEFAULT_LAYOUT = vendorLayout();
const committedTrees = [describeTree(DEFAULT_LAYOUT, PINNED_EXPORT_PATCHES)];
for (const name of readdirSync(join(WORKER_ROOT, "vendor")).filter((entry) => /^analytics-[0-9a-f]{8}$/.test(entry)).sort()) {
  if (name === DEFAULT_LAYOUT.vendorRelative.split("/")[1]) continue;
  const recorded = JSON.parse(readFileSync(join(WORKER_ROOT, "vendor", name, MANIFEST_FILE), "utf8"));
  assert.ok(recorded.sourceCommit?.startsWith(name.slice("analytics-".length)), `${name} holds ${recorded.sourceCommit}`);
  committedTrees.push(describeTree(vendorLayout({ commit: recorded.sourceCommit }), recorded.exportPatches));
}

for (const tree of committedTrees) {
  const isDefault = tree.commit === COMMIT;
  const title = (text) => (isDefault ? text : `[${tree.short}] ${text}`);

  test(title(isDefault ? "the manifest pins d43c8f92 and exactly five export patches" : `the manifest pins ${tree.short} and its recorded export patches`), () => {
    assertManifestPins(tree);
    if (!isDefault) return;
    assert.equal(SOURCE_COMMIT, COMMIT);
    assert.deepEqual(EXPORT_PATCHES.map((patch) => ({ ...patch })), PINNED_PATCH_SPECS);
    assert.equal(tree.manifest.exportPatches.length, 5);
    assert.equal(tree.manifest.counts.exportPatched, 5);
    assert.equal(tree.manifest.exportsAlreadyPresent, undefined);
  });

  test(title(`every vendored file equals git rev-parse ${tree.short}:<path> after export-token removal`), () => {
    assertFilesMatchCommit(tree);
  });

  test(title("the vendor directory holds exactly the manifest files and the authored facade"), () => {
    assertDirectoryHoldsManifestFiles(tree);
  });

  test(title(`each vendored package is complete at ${tree.short}`), () => {
    assertPackagesComplete(tree);
  });

  test(title(`kernel-parity specs are ${tree.short} specs with only their src import prefix rewritten`), () => {
    assertParitySpecsRewritten(tree);
  });

  test(title("no vendored or parity file imports a cloudflare: module"), () => {
    assertNoCloudflareImports(tree);
  });

  test(title("Vitest resolves the tree's workspace packages to the vendored copies"), async () => {
    // Without this, a vendored directory the Vitest config does not know would
    // silently run its kernels against this checkout's own packages.
    const config = await import(pathToFileURL(join(WORKER_ROOT, "vitest.analytics-v2.config.mjs")).href);
    const { layout } = tree;
    assert.ok(config.usesVendoredPackages(join(layout.vendorRoot, "entry.ts")),
      `vitest.analytics-v2.config.mjs does not map ${layout.vendorRelative}: add it to the vendored roots`);
    assert.ok(config.usesVendoredPackages(join(layout.vendorRoot, "apps/worker/src/storage-community-daily.ts")));
    assert.ok(config.usesVendoredPackages(join(layout.parityRoot, "effective-quota-day.spec.ts")),
      `vitest.analytics-v2.config.mjs does not map ${layout.parityRelative}: add it to the vendored roots`);
    for (const pkg of VENDORED_PACKAGES) {
      assert.equal(config.VENDORED_PACKAGE_ENTRIES[`@app-usagemonitor/${pkg}`], join(layout.vendorRoot, "packages", pkg, "index.js"),
        `@app-usagemonitor/${pkg} resolves outside ${layout.vendorRelative}`);
    }
  });

  /** esbuild over the vendored tree itself: inputs per entry, relative to apps/worker. */
  async function vendoredClosure() {
    const { layout } = tree;
    const esbuild = createRequire(join(WORKER_ROOT, "package.json"))("esbuild");
    const entryPoints = { kernel: `${layout.vendorRelative}/entry.ts` };
    WEB_ROOTS.forEach((path, index) => { entryPoints[`web${index}`] = `${layout.vendorRelative}/${path}`; });
    PARITY_SPECS.forEach((spec, index) => { entryPoints[`parity${index}`] = `${layout.parityRelative}/${spec}`; });
    const vendoredPackage = (name) => join(layout.vendorRoot, "packages", name.slice("@app-usagemonitor/".length), "index.js");
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
              if (args.importer.startsWith(`${layout.parityRoot}${sep}`)) return { path: vendoredPackage(args.path) };
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

  test(title("the manifest is exactly the runtime closure of the facade, the site normalizer and the parity specs"), async () => {
    const { layout, manifest } = tree;
    const byEntry = await vendoredClosure();
    const prefix = `${layout.vendorRelative}/`;
    const reachOf = (name) => (name === "kernel" ? "kernel" : name.startsWith("web") ? "web" : "parity");
    const reach = new Map();
    for (const name of ["kernel", ...Object.keys(byEntry).filter((key) => key !== "kernel").sort()]) {
      for (const input of byEntry[name]) {
        if (input.startsWith(`${layout.parityRelative}/`)) continue;
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

  test(title("the facade bundles for Node and prepares an empty owner-day"), async () => {
    const { layout } = tree;
    const esbuild = createRequire(join(WORKER_ROOT, "package.json"))("esbuild");
    const result = await esbuild.build({
      absWorkingDir: WORKER_ROOT, entryPoints: [`${layout.vendorRelative}/entry.ts`], bundle: true, write: false,
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

  test(title(`type stubs are this tsc's declarations of the ${tree.short} modules vendored files name only for types`), async () => {
    const { layout, manifest } = tree;
    assert.equal(manifest.counts.typeStubs, manifest.typeStubs.length);
    const vendored = new Set(manifest.files.map((file) => file.path));
    const expected = revParse(tree.commit, manifest.typeStubs.map((stub) => stub.source));
    for (const stub of manifest.typeStubs) {
      assert.equal(stub.path, stub.source.replace(/\.ts$/, ".d.ts"));
      assert.ok(stub.source.startsWith("apps/worker/src/") && !vendored.has(stub.source), `${stub.source} must be unvendored Worker source`);
      assert.equal(stub.sourceBlob, expected.get(stub.source), `${stub.source} differs from ${tree.short}`);
      assert.equal(digest(readFileSync(join(layout.vendorRoot, stub.path))), stub.sha256, `${stub.path} differs from the manifest`);
    }
    const { frontier, stubs } = await regenerateTypeStubs(manifest);
    assert.deepEqual(frontier, manifest.typeStubs.map((stub) => stub.source));
    for (const stub of manifest.typeStubs) {
      assert.ok(stubs.get(stub.path)?.equals(readFileSync(join(layout.vendorRoot, stub.path))), `${stub.path} is not the emitted declaration`);
    }
  });

  test(title("a tsc-checked consumer can import the facade with this checkout's tsconfig"), () => {
    // The probe extends apps/worker/tsconfig.json from inside apps/worker so the
    // program is exactly `npm run typecheck` plus one consumer of entry.ts.
    const dir = mkdtempSync(join(WORKER_ROOT, ".vendor-tsc-probe-"));
    try {
      writeFileSync(join(dir, "probe.ts"), [
        "import { prepareSharedAnalyticsDay, publicInputs, reconcileGroups, type SharedAnalyticsDay }",
        `  from ${JSON.stringify(relative(dir, join(tree.layout.vendorRoot, "entry")).split(sep).join("/"))};`,
        "export const probe: (day: string) => Promise<SharedAnalyticsDay> = (day) =>",
        "  prepareSharedAnalyticsDay({ day, ownerDigest: \"a\".repeat(64), usage: [], quota: [], session: [] });",
        "export const helpers = [publicInputs, reconcileGroups] as const;",
        "",
      ].join("\n"));
      // The whole app program plus the probe, as if the probe lived in src/. `types`
      // and `include` resolve from the project that uses them, so re-anchor them.
      const app = JSON.parse(readFileSync(join(WORKER_ROOT, "tsconfig.json"), "utf8"));
      const anchor = (entry) => relative(dir, resolve(WORKER_ROOT, entry)).split(sep).join("/");
      writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
        extends: "../tsconfig.json",
        compilerOptions: { noEmit: true,
          types: (app.compilerOptions.types ?? []).map((entry) => (entry.startsWith(".") ? anchor(entry) : entry)) },
        include: (app.include ?? []).map(anchor),
        files: ["probe.ts"],
      }));
      const result = spawnSync(join(WORKER_ROOT, "node_modules", ".bin", "tsc"), ["-p", dir, "--pretty", "false"],
        { cwd: WORKER_ROOT, encoding: "utf8" });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// The commit argument
// ---------------------------------------------------------------------------

function runGenerator(args) {
  return spawnSync(process.execPath, [GENERATOR, ...args], { cwd: WORKER_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function withScratch(fn) {
  const dir = mkdtempSync(join(tmpdir(), "vendor-analytics-kernels-check-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const refusedWith = (code) => (error) => error instanceof VendorError && error.code === code;

test("a production commit must be a full 40-hex commit id; abbreviations and refs are refused", () => {
  assert.equal(parseCommit(COMMIT), COMMIT);
  assert.equal(parseCommit(COMMIT.toUpperCase()), COMMIT);
  for (const bad of [COMMIT.slice(0, 8), COMMIT.slice(0, 39), `${COMMIT}0`, "HEAD", "origin/main", "refs/heads/main", `${COMMIT} `,
    ` ${COMMIT}`, `${COMMIT}\n`, `${COMMIT.slice(0, 39)}g`, "", undefined, null, 42]) {
    assert.throws(() => parseCommit(bad), refusedWith("COMMIT_NOT_FULL_SHA"), String(bad));
  }
  assert.throws(() => vendorLayout({ commit: "d43c8f92" }), refusedWith("COMMIT_NOT_FULL_SHA"));
});

test("the vendor directory is named by the commit and the parity directory keeps d43c8f92's name", () => {
  const other = "0123456789abcdef0123456789abcdef01234567";
  const layout = vendorLayout({ commit: other, outRoot: "/scratch/out" });
  assert.equal(layout.vendorRelative, "vendor/analytics-01234567");
  assert.equal(layout.parityRelative, "analytics-v2-test/kernel-parity-01234567");
  assert.equal(layout.vendorRoot, "/scratch/out/vendor/analytics-01234567");
  assert.equal(DEFAULT_LAYOUT.vendorRelative, "vendor/analytics-d43c8f92");
  assert.equal(DEFAULT_LAYOUT.parityRelative, "analytics-v2-test/kernel-parity");
  assert.equal(DEFAULT_LAYOUT.vendorRoot, join(WORKER_ROOT, "vendor/analytics-d43c8f92"));
});

test("arguments are parsed strictly", () => {
  assert.deepEqual(parseArguments([]), { commit: COMMIT, outRoot: undefined, authoredFrom: undefined, reference: undefined, report: false, help: false });
  const other = "0123456789ABCDEF0123456789abcdef01234567";
  assert.equal(parseArguments([`--commit=${other}`]).commit, other.toLowerCase());
  assert.deepEqual(parseArguments([`--commit=${COMMIT}`, "--out-root=/x", "--authored-from=/y"]),
    { commit: COMMIT, outRoot: "/x", authoredFrom: "/y", reference: undefined, report: false, help: false });
  assert.deepEqual(parseArguments(["--report", "--reference=/m.json"]).report, true);
  for (const bad of [["--commit"], ["--commit="], [`--commit=${COMMIT}`, `--commit=${COMMIT}`], ["--bogus"], ["--bogus=1"], [COMMIT], ["-c", COMMIT],
    ["--report=yes"], ["--help=1"], ["--out-root="], ["--report", "--out-root=/x"], ["--report", "--authored-from=/x"], ["--reference=/m.json"]]) {
    assert.throws(() => parseArguments(bad), refusedWith("USAGE"), bad.join(" "));
  }
  for (const bad of [["--commit=HEAD"], ["--commit=origin/main"], ["--commit=d43c8f92"]]) {
    assert.throws(() => parseArguments(bad), refusedWith("COMMIT_NOT_FULL_SHA"), bad.join(" "));
  }
});

test("the command line refuses a commit that is not a full id or not a commit here, and writes nothing", () => {
  withScratch((out) => {
    const tree = git(["rev-parse", `${COMMIT}^{tree}`]).trim();
    const cases = [
      [`--commit=${"0".repeat(40)}`, "SOURCE_COMMIT_UNAVAILABLE"],
      [`--commit=${tree}`, "SOURCE_COMMIT_UNAVAILABLE"],
      ["--commit=origin/main", "COMMIT_NOT_FULL_SHA"],
      ["--commit=d43c8f92", "COMMIT_NOT_FULL_SHA"],
      ["--commit=", "USAGE"],
    ];
    for (const [argument, code] of cases) {
      const run = runGenerator([argument, `--out-root=${out}`, `--authored-from=${DEFAULT_LAYOUT.vendorRoot}`]);
      assert.equal(run.status, 1, argument);
      assert.ok(run.stderr.startsWith(`${code}:`), `${argument}: ${run.stderr}`);
      assert.equal(run.stdout, "", argument);
    }
    assert.deepEqual(readdirSync(out), []);
  });
});

// ---------------------------------------------------------------------------
// Locating export patches by symbol
// ---------------------------------------------------------------------------

const patchFor = (symbol, declaration = "function") => ({ path: "apps/worker/src/x.ts", symbol, declaration });
const locate = (text, symbol, declaration) => locateExportSymbol(text, patchFor(symbol, declaration));
const statusOf = (text, symbol, declaration) => locate(text, symbol, declaration).status;

test("the patch list names symbols and kinds, never lines", () => {
  assert.deepEqual(EXPORT_PATCHES.map((patch) => ({ ...patch })), PINNED_PATCH_SPECS);
  assert.ok(EXPORT_PATCHES.every((patch) => Object.keys(patch).sort().join() === "declaration,path,symbol"));
  assert.throws(() => assertPatchSpecs([{ ...patchFor("a"), declaration: "let" }]), refusedWith("EXPORT_PATCH_SPEC_INVALID"));
  assert.throws(() => assertPatchSpecs([patchFor("not an identifier")]), refusedWith("EXPORT_PATCH_SPEC_INVALID"));
  assert.throws(() => assertPatchSpecs([{ ...patchFor("a"), path: "apps/worker/test/a.ts" }]), refusedWith("EXPORT_PATCH_SPEC_INVALID"));
  assert.throws(() => assertPatchSpecs([{ ...patchFor("a"), path: "apps/worker/src/../x.ts" }]), refusedWith("EXPORT_PATCH_SPEC_INVALID"));
  assert.throws(() => assertPatchSpecs([patchFor("a"), patchFor("a")]), refusedWith("EXPORT_PATCH_SPEC_INVALID"));
});

test("a function is found by symbol wherever it sits, and the line is derived", () => {
  const text = "import { a } from \"./a\";\n\nconst unrelated = 1;\n\nfunction foo(x: number) {\n  return x;\n}\n";
  const found = locate(text, "foo");
  assert.equal(found.status, "apply");
  assert.equal(found.line, 5);
  assert.equal(found.original, "function foo(");
  const moved = locate(`${"// padding\n".repeat(50)}${text}`, "foo");
  assert.equal(moved.line, 55);
  assert.equal(moved.original, found.original);
  const patched = applyExportPatches("apps/worker/src/x.ts", Buffer.from(text), [found]).toString("utf8");
  assert.equal(patched, text.replace("\nfunction foo(", "\nexport function foo("));
  assert.equal(patched.length, text.length + TOKEN.length);
  assert.equal(statusOf("async function bar(\n  a,\n) {}\n", "bar", "async function"), "apply");
  assert.equal(statusOf("function fooBar() {}\nfunction foo() {}\n", "foo"), "apply");
  assert.equal(locate("function fooBar() {}\nfunction foo() {}\n", "foo").line, 2);
});

test("real d43c8f92 sources resolve to their pinned lines after lines move", () => {
  for (const patch of PINNED_EXPORT_PATCHES) {
    const text = git(["show", `${COMMIT}:${patch.path}`]);
    const lines = text.split("\n");
    const declaration = new RegExp(`^(async )?function ${patch.symbol}\\b`);
    assert.deepEqual(lines.flatMap((line, index) => (declaration.test(line) ? [index + 1] : [])), [patch.line], `${patch.symbol} is declared once`);
    const found = locateExportSymbol(text, { path: patch.path, symbol: patch.symbol, declaration: PINNED_PATCH_SPECS.find((spec) => spec.symbol === patch.symbol).declaration });
    assert.equal(found.status, "apply");
    assert.equal(found.line, patch.line);
    assert.equal(found.original, patch.original);
    assert.equal(locateExportSymbol(`// moved\n\n\n${text}`, found).line, patch.line + 3);
  }
});

test("a const is a supported patch kind", () => {
  const found = locate("const LIMIT = 5;\nconst OTHER: number = 6;\n", "LIMIT", "const");
  assert.equal(found.status, "apply");
  assert.equal(found.original, "const LIMIT =");
  assert.equal(locate("const LIMIT = 5;\nconst OTHER: number = 6;\n", "OTHER", "const").original, "const OTHER:");
  const patched = applyExportPatches("apps/worker/src/x.ts", Buffer.from("const LIMIT = 5;\n"), [found]).toString("utf8");
  assert.equal(patched, "export const LIMIT = 5;\n");
  assert.equal(statusOf("const LIMIT = 5;\n", "LIMIT", "function"), "kind-changed");
  assert.equal(statusOf("function LIMIT() {}\n", "LIMIT", "const"), "kind-changed");
  assert.equal(statusOf("async function LIMIT() {}\n", "LIMIT", "function"), "kind-changed");
  assert.equal(statusOf("function LIMIT() {}\n", "LIMIT", "async function"), "kind-changed");
});

test("a missing symbol is refused", () => {
  assert.equal(statusOf("const a = 1;\n", "foo"), "missing");
  assert.equal(statusOf("", "foo"), "missing");
  assert.equal(statusOf("function foo2() {}\nfunction xfoo() {}\n", "foo"), "missing");
  assert.equal(statusOf("class A {\n  foo() {}\n}\nconst o = { foo() {} };\no.foo = function () {};\n", "foo"), "missing");
  assert.equal(statusOf("a.function foo();\n", "foo"), "missing");
  assert.equal(statusOf("export type foo = string;\ninterface foo2 {}\n", "foo"), "missing");
});

test("an ambiguous symbol is refused", () => {
  assert.equal(statusOf("function foo(a: string): void;\nfunction foo(a: number): void;\nfunction foo(a: unknown) {}\n", "foo"), "ambiguous");
  assert.equal(statusOf("function foo() {}\nfunction foo() {}\n", "foo"), "ambiguous");
  assert.equal(statusOf("function foo() {}\nconst x = function foo() {};\n", "foo"), "ambiguous");
  assert.equal(statusOf("function foo() {}\nfunction wrap() {\n  const foo = 1;\n  return foo;\n}\n", "foo"), "ambiguous");
  assert.equal(statusOf("const foo = 1;\nfunction foo() {}\n", "foo", "const"), "ambiguous");
  assert.match(locate("function foo() {}\n\nfunction foo() {}\n", "foo").detail, /lines 1, 3/);
});

test("a symbol that is not a column-0 declaration is refused", () => {
  assert.equal(statusOf("function outer() {\n  function foo() {}\n}\n", "foo"), "not-top-level");
  assert.equal(statusOf("if (x) {\n  const foo = 1;\n}\n", "foo", "const"), "not-top-level");
  assert.equal(statusOf("export default function foo() {}\n", "foo"), "not-top-level");
  assert.equal(statusOf("export default async function foo() {}\n", "foo", "async function"), "not-top-level");
  assert.equal(statusOf("declare function foo(): void;\n", "foo"), "not-top-level");
  assert.equal(statusOf("abstract class foo {}\n", "foo"), "not-top-level");
});

test("a symbol that cannot take an export token in place is refused", () => {
  for (const text of ["let foo = 1;\n", "var foo = 1;\n", "class foo {}\n", "enum foo { A }\n", "function* foo() {}\n", "namespace foo {}\n"]) {
    assert.equal(statusOf(text, "foo", "const"), "unsupported", text);
  }
});

test("a symbol an export clause already names is refused", () => {
  assert.equal(statusOf("function foo() {}\nexport { foo };\n", "foo"), "export-clause");
  assert.equal(statusOf("function foo() {}\nexport { foo as bar };\n", "foo"), "export-clause");
  assert.equal(statusOf("function foo() {}\nexport { other as foo };\n", "foo"), "export-clause");
  assert.equal(statusOf("export { foo } from \"./other\";\nfunction foo() {}\n", "foo"), "export-clause");
  assert.equal(statusOf("export * as foo from \"./other\";\nfunction foo() {}\n", "foo"), "export-clause");
  assert.equal(statusOf("function foo() {}\nexport { barfoo };\n", "foo"), "apply");
});

test("a symbol the commit already exports is left alone and reported", () => {
  assert.equal(statusOf("export function foo() {}\n", "foo"), "already-exported");
  assert.equal(statusOf("export async function foo() {}\n", "foo", "async function"), "already-exported");
  assert.equal(statusOf("export const foo = 1;\n", "foo", "const"), "already-exported");
  const resolutions = resolveExportPatches([patchFor("foo")], () => "export function foo() {}\n");
  const bytes = Buffer.from("export function foo() {}\n");
  assert.equal(applyExportPatches("apps/worker/src/x.ts", bytes, resolutions), bytes);
  assert.doesNotThrow(() => assertExportPatchesResolved(resolutions));
});

test("a symbol the commit already exports is recorded in the manifest and not counted as patched", async () => {
  const esbuild = createRequire(join(WORKER_ROOT, "package.json"))("esbuild");
  const path = "apps/worker/src/a.ts";
  const exportPlan = await planExportPatches({
    patches: [{ ...patchFor("foo"), path }, { ...patchFor("bar"), path }],
    readText: () => "export function foo() {}\nfunction bar() {}\n",
    esbuild,
  });
  assert.deepEqual(exportPlan.map((resolution) => resolution.status), ["already-exported", "apply"]);
  const input = { layout: DEFAULT_LAYOUT, closure: { esbuildVersion: "0", externals: [] }, typeStubs: [], parityTests: [],
    files: [{ path, blob: "b", sha256: "s", patch: "export", reach: "kernel" }] };
  const manifest = buildManifest({ ...input, exportPlan });
  assert.deepEqual(manifest.exportPatches, [{ path, line: 2, symbol: "bar", original: "function bar(" }]);
  assert.deepEqual(manifest.exportsAlreadyPresent, [{ path, line: 1, symbol: "foo" }]);
  assert.equal(manifest.counts.exportPatched, 1);
  const keys = Object.keys(manifest);
  assert.equal(keys.indexOf("exportsAlreadyPresent"), keys.indexOf("exportPatches") + 1);
  assert.equal("exportsAlreadyPresent" in buildManifest({ ...input, exportPlan: exportPlan.slice(1) }), false);
});

test("comments, strings, templates and regex literals never match", () => {
  const decoys = [
    "// function foo() {}",
    "/*",
    "function foo() {}",
    "*/",
    "const s = 'function foo() {}';",
    "const t = `",
    "function foo() {}",
    "`;",
    "const r = /function foo\\(/;",
    "const u = \"export function foo() {}\";",
    "",
  ].join("\n");
  assert.equal(statusOf(decoys, "foo"), "missing");
  const found = locate(`${decoys}function foo() {}\n`, "foo");
  assert.equal(found.status, "apply");
  assert.equal(found.line, 11);
  assert.equal(statusOf(`${decoys}// export { foo };\nconst c = "export { foo }";\n`, "foo"), "missing");
});

test("the lexer is not derailed by regex literals, division, nested templates or line continuations", () => {
  const apply = (text) => assert.equal(locate(text, "foo").status, "apply", text);
  apply("const r = /[\"'`]/;\nfunction foo() {}\n");
  apply("const q = a / b / c;\nconst r = d /* c */ / e;\nfunction foo() {}\n");
  apply("const t = `a ${ `b ${ { c: 1 }.c }` } d`;\nfunction foo() {}\n");
  apply("const t = `a ${ \"}\" } ${ '`' }`;\nfunction foo() {}\n");
  apply("const s = \"a \\\n b\";\nfunction foo() {}\n");
  apply("const s = 'it\\'s';\nfunction foo() {}\n");
  apply("const x = y\n  ? /a'b/.test(z)\n  : 0;\nfunction foo() {}\n");
  apply("function g() { return /`/.test(a); }\nfunction foo() {}\n");
  apply("const r = [/\\//, /[/]/];\nfunction foo() {}\n");
  const masked = maskNonCode("const a = 1; // c\nconst b = \"s\";\n");
  assert.equal(masked, "const a = 1;     \nconst b =    ;\n");
  assert.equal(maskNonCode("x = `a${b}c`;").length, "x = `a${b}c`;".length);
});

test("a source the lexer cannot close is refused", () => {
  for (const text of ["/* never closed\nfunction foo() {}\n", "const t = `open\nfunction foo() {}\n", "const s = \"open\nfunction foo() {}\n",
    "const t = `a ${ b \nfunction foo() {}\n"]) {
    assert.equal(statusOf(text, "foo"), "unlexable", text);
    assert.throws(() => maskNonCode(text), refusedWith("SOURCE_UNLEXABLE"));
  }
});

test("CRLF sources are patched at the right line and by exactly one token", () => {
  const text = "const a = 1;\r\n\r\nfunction foo() {\r\n  return a;\r\n}\r\n";
  const found = locate(text, "foo");
  assert.equal(found.status, "apply");
  assert.equal(found.line, 3);
  const patched = applyExportPatches("apps/worker/src/x.ts", Buffer.from(text), [found]);
  assert.equal(patched.toString("utf8"), text.replace("function foo", "export function foo"));
  assert.equal(patched.length, text.length + TOKEN.length);
});

test("several patches in one file are applied together without shifting each other", () => {
  const text = "function a() {}\nfunction b() {}\nasync function c() {}\nconst D = 1;\n";
  const resolutions = resolveExportPatches([patchFor("a"), patchFor("b"), patchFor("c", "async function"), patchFor("D", "const")], () => text);
  assert.deepEqual(resolutions.map((resolution) => resolution.status), ["apply", "apply", "apply", "apply"]);
  assert.equal(applyExportPatches("apps/worker/src/x.ts", Buffer.from(text), resolutions).toString("utf8"),
    "export function a() {}\nexport function b() {}\nexport async function c() {}\nexport const D = 1;\n");
});

test("an unresolved patch list is refused with the status of the first failure and the detail of all", () => {
  const files = { "apps/worker/src/a.ts": "function foo() {}\nfunction foo() {}\n", "apps/worker/src/b.ts": "const x = 1;\n" };
  const resolutions = resolveExportPatches([
    { path: "apps/worker/src/a.ts", symbol: "foo", declaration: "function" },
    { path: "apps/worker/src/b.ts", symbol: "bar", declaration: "function" },
    { path: "apps/worker/src/gone.ts", symbol: "baz", declaration: "function" },
  ], (path) => files[path]);
  assert.deepEqual(resolutions.map((resolution) => resolution.status), ["ambiguous", "missing", "file-missing"]);
  assert.throws(() => assertExportPatchesResolved(resolutions), (error) => error.code === "EXPORT_SYMBOL_AMBIGUOUS"
    && /a\.ts:foo ambiguous/.test(error.message) && /b\.ts:bar missing/.test(error.message) && /gone\.ts:baz file-missing/.test(error.message));
  assert.throws(() => assertExportPatchesResolved(resolutions.slice(1)), refusedWith("EXPORT_SYMBOL_MISSING"));
  assert.throws(() => assertExportPatchesResolved(resolutions.slice(2)), refusedWith("EXPORT_SYMBOL_FILE_MISSING"));
});

test("the parser confirms each patch adds exactly its own export", async () => {
  const esbuild = createRequire(join(WORKER_ROOT, "package.json"))("esbuild");
  const files = (map) => (path) => map[path];
  const good = { "apps/worker/src/a.ts": "import { x } from \"./x\";\nfunction foo() { return x; }\nexport const keep = 1;\n" };
  const plan = await planExportPatches({ patches: [patchFor("foo")].map((patch) => ({ ...patch, path: "apps/worker/src/a.ts" })),
    readText: files(good), esbuild });
  assert.equal(plan[0].status, "apply");
  // A const statement that declares two bindings would export both.
  const twin = { "apps/worker/src/a.ts": "const A = 1, B = 2;\nexport const keep = A + B;\n" };
  await assert.rejects(planExportPatches({ patches: [{ ...patchFor("A", "const"), path: "apps/worker/src/a.ts" }], readText: files(twin), esbuild }),
    (error) => error.code === "EXPORT_PATCH_VERIFY_FAILED" && /also exported B/.test(error.message));
  // A modifier on the previous line would make the patched file unparseable.
  const split = { "apps/worker/src/a.ts": "export\nfunction foo() {}\n" };
  await assert.rejects(planExportPatches({ patches: [{ ...patchFor("foo"), path: "apps/worker/src/a.ts" }], readText: files(split), esbuild }),
    refusedWith("EXPORT_PATCH_VERIFY_FAILED"));
  // The verifier itself refuses a patched text that exports nothing new or too much.
  const original = "function foo() {}\n";
  const resolutions = resolveExportPatches([{ ...patchFor("foo"), path: "apps/worker/src/a.ts" }], () => original);
  await assert.rejects(verifyExportPatches(esbuild, "apps/worker/src/a.ts", original, original, resolutions), refusedWith("EXPORT_PATCH_VERIFY_FAILED"));
  await assert.rejects(verifyExportPatches(esbuild, "apps/worker/src/a.ts", original, "export function foo() {}\nexport const extra = 1;\n", resolutions),
    (error) => /also exported extra/.test(error.message));
});

test("the lexer masks every d43c8f92 Worker source consistently with esbuild's parse", async () => {
  const esbuild = createRequire(join(WORKER_ROOT, "package.json"))("esbuild");
  const paths = git(["ls-tree", "-r", "--name-only", "--full-tree", COMMIT, "--", "apps/worker/src"]).trim().split("\n").filter((path) => path.endsWith(".ts"));
  assert.ok(paths.length > 100, "expected the Worker source tree");
  let checked = 0;
  for (const path of paths) {
    const text = git(["show", `${COMMIT}:${path}`]);
    const masked = maskNonCode(text);
    assert.equal(masked.length, text.length, path);
    assert.equal(masked.replace(/[^\r\n]/g, ""), text.replace(/[^\r\n]/g, ""), `${path} line structure`);
    const claimed = [...masked.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^export\s+const\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1] ?? m[2]);
    if (!claimed.length) continue;
    const built = await esbuild.build({
      stdin: { contents: text, loader: "ts", sourcefile: path, resolveDir: WORKER_ROOT },
      bundle: true, write: false, metafile: true, format: "esm", logLevel: "silent", tsconfigRaw: {},
      plugins: [{ name: "externals", setup(build) { build.onResolve({ filter: /.*/ }, (args) => (args.kind === "entry-point" ? undefined : { path: args.path, external: true })); } }],
    });
    const exported = new Set(Object.values(built.metafile.outputs).flatMap((output) => output.exports ?? []));
    for (const name of claimed) assert.ok(exported.has(name), `${path}: the lexer sees export ${name} that esbuild does not`);
    checked += 1;
  }
  assert.ok(checked > 50, `only ${checked} files exported anything`);
});

// ---------------------------------------------------------------------------
// Regenerating
// ---------------------------------------------------------------------------

function snapshot(root) {
  return new Map(listFiles(root).map((path) => [path, readFileSync(join(root, path))]));
}

function assertSameFiles(actual, expected, label) {
  assert.deepEqual([...actual.keys()], [...expected.keys()], `${label}: file set`);
  for (const [path, bytes] of expected) assert.ok(actual.get(path).equals(bytes), `${label}: ${path} differs`);
}

test("regenerating d43c8f92 into a scratch directory reproduces the committed tree byte for byte", () => {
  withScratch((out) => {
    const run = runGenerator([`--commit=${COMMIT}`, `--out-root=${out}`, `--authored-from=${DEFAULT_LAYOUT.vendorRoot}`]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /"status":"ok"/);
    const scratch = vendorLayout({ commit: COMMIT, outRoot: out });
    assertSameFiles(snapshot(scratch.vendorRoot), snapshot(DEFAULT_LAYOUT.vendorRoot), "vendor tree");
    assertSameFiles(snapshot(scratch.parityRoot), snapshot(DEFAULT_LAYOUT.parityRoot), "parity specs");
    assert.deepEqual(readdirSync(out).sort(), ["analytics-v2-test", "vendor"]);
    // Without --commit the generator does the same, over its own previous output.
    const again = runGenerator([`--out-root=${out}`]);
    assert.equal(again.status, 0, again.stderr);
    assertSameFiles(snapshot(scratch.vendorRoot), snapshot(DEFAULT_LAYOUT.vendorRoot), "vendor tree, second run");
    assertSameFiles(snapshot(scratch.parityRoot), snapshot(DEFAULT_LAYOUT.parityRoot), "parity specs, second run");
  });
});

test("another commit is vendored into its own directories, verified like d43c8f92, and regenerates identically", () => {
  const parent = git(["rev-parse", "--verify", `${COMMIT}^`]).trim();
  assert.notEqual(parent, COMMIT);
  withScratch((out) => {
    const run = runGenerator([`--commit=${parent}`, `--out-root=${out}`, `--authored-from=${DEFAULT_LAYOUT.vendorRoot}`]);
    assert.equal(run.status, 0, run.stderr);
    const layout = vendorLayout({ commit: parent, outRoot: out });
    assert.equal(layout.vendorRelative, `vendor/analytics-${parent.slice(0, 8)}`);
    assert.equal(layout.parityRelative, `analytics-v2-test/kernel-parity-${parent.slice(0, 8)}`);
    assert.deepEqual(readdirSync(join(out, "vendor")), [`analytics-${parent.slice(0, 8)}`]);
    assert.deepEqual(readdirSync(join(out, "analytics-v2-test")), [`kernel-parity-${parent.slice(0, 8)}`]);
    const manifest = JSON.parse(readFileSync(join(layout.vendorRoot, MANIFEST_FILE), "utf8"));
    assert.equal(manifest.sourceCommit, parent);
    assert.deepEqual(manifest.exportPatches.map((patch) => patch.symbol), PINNED_PATCH_SPECS.map((spec) => spec.symbol));
    const tree = describeTree(layout, manifest.exportPatches);
    assertManifestPins(tree);
    assertFilesMatchCommit(tree);
    assertDirectoryHoldsManifestFiles(tree);
    assertPackagesComplete(tree);
    assertParitySpecsRewritten(tree);
    assertNoCloudflareImports(tree);
    for (const entry of manifest.parityTests) assert.ok(entry.rewrite.to.includes(`vendor/analytics-${parent.slice(0, 8)}/`), entry.path);
    for (const file of AUTHORED_FILES) assert.ok(readFileSync(join(layout.vendorRoot, file)).equals(readFileSync(join(DEFAULT_LAYOUT.vendorRoot, file))));
    const first = snapshot(out);
    const again = runGenerator([`--commit=${parent}`, `--out-root=${out}`]);
    assert.equal(again.status, 0, again.stderr);
    assertSameFiles(snapshot(out), first, "second run");
  });
});

test("the generator never overwrites reviewed files or another commit's directory", () => {
  withScratch((out) => {
    const unseeded = runGenerator([`--out-root=${out}`]);
    assert.equal(unseeded.status, 1);
    assert.match(unseeded.stderr, /^AUTHORED_FILE_MISSING: /);
    const missingSource = runGenerator([`--out-root=${out}`, `--authored-from=${join(out, "nowhere")}`]);
    assert.match(missingSource.stderr, /^AUTHORED_FILE_MISSING: /);
    assert.deepEqual(readdirSync(out), []);
    assert.equal(runGenerator([`--out-root=${out}`, `--authored-from=${DEFAULT_LAYOUT.vendorRoot}`]).status, 0);
    const before = snapshot(out);
    const reseed = runGenerator([`--out-root=${out}`, `--authored-from=${DEFAULT_LAYOUT.vendorRoot}`]);
    assert.equal(reseed.status, 1);
    assert.match(reseed.stderr, /^AUTHORED_FILES_EXIST: /);
    assertSameFiles(snapshot(out), before, "after a refused reseed");
  });
  withScratch((out) => {
    const dir = join(out, DEFAULT_LAYOUT.vendorRelative);
    mkdirSync(dir, { recursive: true });
    for (const file of AUTHORED_FILES) writeFileSync(join(dir, file), readFileSync(join(DEFAULT_LAYOUT.vendorRoot, file)));
    const foreign = { schemaVersion: MANIFEST_SCHEMA, sourceCommit: `d43c8f92${"0".repeat(32)}`, files: [{ path: "apps/worker/src/keep.ts" }] };
    writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(foreign));
    mkdirSync(join(dir, "apps/worker/src"), { recursive: true });
    writeFileSync(join(dir, "apps/worker/src/keep.ts"), "keep\n");
    const before = snapshot(out);
    const run = runGenerator([`--out-root=${out}`]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /^VENDOR_DIR_COMMIT_MISMATCH: /);
    assertSameFiles(snapshot(out), before, "after a refused mismatch");
  });
});

test("the report resolves the patches at a commit, names drifted files and writes nothing", async () => {
  const reference = JSON.parse(readFileSync(join(DEFAULT_LAYOUT.vendorRoot, MANIFEST_FILE), "utf8"));
  const report = await reportAtCommit({ commit: COMMIT, reference, referenceDirectory: DEFAULT_LAYOUT.vendorRoot });
  assert.equal(report.ok, true);
  assert.equal(report.patchesOk, true);
  assert.deepEqual(report.patches.map(({ path, line, symbol, original }) => ({ path, line, symbol, original })), PINNED_EXPORT_PATCHES);
  assert.deepEqual(report.summary, { apply: 5 });
  assert.equal(report.verification.status, "passed");
  assert.deepEqual(report.drift.changed, []);
  assert.deepEqual(report.drift.removed, []);
  assert.equal(report.drift.identical, report.drift.checked);
  assert.deepEqual(report.facade, { entry: "entry.ts", modules: report.facade.modules, unresolved: [] });
  // Against a reference whose recorded blobs are wrong the same commit reports every file as changed.
  const stale = { ...reference, files: reference.files.map((file) => ({ ...file, blob: "0".repeat(40) })), typeStubs: [], parityTests: [] };
  const drifted = await reportAtCommit({ commit: COMMIT, reference: stale });
  assert.equal(drifted.drift.changed.length, reference.files.length);
  assert.equal(drifted.facade, null);
  const run = runGenerator(["--report"]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).ok, true);
  const missing = runGenerator(["--report", `--reference=${join(tmpdir(), "no-such-manifest.json")}`]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^REFERENCE_MANIFEST_MISSING: /);
  assert.equal(typeof main, "function");
});
