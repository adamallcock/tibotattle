// Mechanical identity check for the vendored analytics-kernel tree (the one
// stable directory, vendor/analytics-d43c8f92, whatever commit it holds), its
// copied kernel-parity specs and the generated GCP-only vocabularies, and the
// negative tests for the generator's commit argument, symbol-located export
// patches, commit transitions and vocabulary derivation. Run from apps/worker:
//   node scripts/vendor-analytics-kernels.check.mjs
// It needs the git objects of the vendored commit and fails closed without
// them. The identity arithmetic (git blob ids, export-token removal, source
// patch reversal and the parity rewrite reversal) is implemented here
// independently of the generator; only the reviewed lists are shared. The
// d43c8f92 export patches are pinned below, both as the symbols the generator
// is given and as the lines the generator must find them on, and so are the
// source patches, by file, id, hunk count and digest of their exact texts; a
// tree holding another commit is checked against its own manifest. The generated type stubs are checked by re-emitting
// them, and by typechecking the app program plus one consumer of entry.ts with
// this checkout's tsc. A scratch regeneration of the committed commit must
// reproduce the committed tree and vocabularies byte for byte, and so must a
// round trip through another commit in the same stable directory.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyExportPatches, applySourcePatches, assertExportPatchesResolved, assertPatchSpecs, assertSourceCommit,
  assertSourcePatchSpecs, AUTHORED_FILES, buildManifest, filePatchKind, SOURCE_PATCHES,
  commitsNamedIn, EXPORT_PATCHES, foreignCommitsNamed, locateExportSymbol, main, MANIFEST_FILE, MANIFEST_SCHEMA, maskNonCode,
  PARITY_HELPERS, PARITY_SPECS, parseArguments, parseCommit, planExportPatches, reachableInputs, regenerateTypeStubs,
  reportAtCommit, resolveExportPatches, SOURCE_COMMIT, VendorError, vendorLayout, VENDORED_PACKAGES, verifyExportPatches,
  verifyVendoredTree, WEB_ROOTS, STABLE_PARITY_RELATIVE, STABLE_VENDOR_RELATIVE, vocabulariesOfTree, workerIndexAt,
} from "./vendor-analytics-kernels.mjs";
import {
  bundledConstructedReasons, changedVocabularies, communityDailyReadSchemaVersion, constructedReasons, interfaceMembers,
  REFUSAL_CLASSES, renderKernelVocabularies, VOCABULARY_RELATIVE, VOCABULARY_SCHEMA, VocabularyError,
} from "./analytics-kernel-vocabularies.mjs";

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
  ["apps/worker/src/quota-analysis-v1.ts", 735, "buildPricingEvent", "function buildPricingEvent("],
].map(([path, line, symbol, original]) => ({ path, line, symbol, original }));
/** The generator's patch list: symbols and declaration kinds, no line numbers. */
const PINNED_PATCH_SPECS = [
  ["apps/worker/src/telemetry-usage-effective-reader.ts", "reconciledAttribution", "function"],
  ["apps/worker/src/telemetry-usage-effective-reader.ts", "reconcileGroups", "async function"],
  ["apps/worker/src/telemetry-usage-effective-reader.ts", "genericRecordJson", "function"],
  ["apps/worker/src/telemetry-usage-effective-reader.ts", "genericOccurrence", "function"],
  ["apps/worker/src/storage-community-daily.ts", "publicInputs", "function"],
  ["apps/worker/src/quota-analysis-v1.ts", "buildPricingEvent", "function"],
].map(([path, symbol, declaration]) => ({ path, symbol, declaration }));
/**
 * Pinned on purpose, like the export patches: the reviewed source patches by
 * file, id, hunk count and sha256 of their exact [find, replace] texts.
 */
const PINNED_SOURCE_PATCHES = [
  ["apps/worker/src/quota-analysis-v11.ts", "usage-row-evidence-memo", 2,
    "1abf1f05fae29ce856a82adcd7538205ff6f4ad194466350c17a0096d15f1df3"],
  ["apps/worker/src/quota-analysis-v11.ts", "reduction-payload-bytes", 3,
    "72b182330015387e75cbebfe1cdd70371d34d2a8b968c2f9adc6a78226544a8e"],
  ["apps/worker/src/v11-daily-projection-values.ts", "daily-fold-trusted-state", 5,
    "50451d4c3f13fb38e6a007c1f2fb6a5b1b365256c188c321109fc2ccfb5c4441"],
  ["apps/worker/src/analytics-shared-reducers.ts", "daily-fold-trusted-state", 2,
    "4ff0cd7345ad201938d0196e3a2571ff522b3458fd89811ebf362649073c3c06"],
].map(([path, id, hunks, sha256]) => ({ path, id, hunks, sha256 }));
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

/** The source patches' recorded digest, computed here from their texts. */
const hunksDigest = (patch) => digest(Buffer.from(JSON.stringify(patch.hunks.map(({ find, replace }) => [find, replace])), "utf8"));
const occurrences = (text, part) => text.split(part).length - 1;

/**
 * Undoes exactly the recorded source patches of `path`: last hunk first, each
 * `replace` must occur exactly once and goes back to its `find`. The texts come
 * from the reviewed list and must match the recorded digest.
 */
function reverseSourcePatches(path, bytes, sourcePatches) {
  const recorded = sourcePatches.filter((patch) => patch.path === path);
  if (!recorded.length) return bytes;
  let text = bytes.toString("utf8");
  for (const record of [...recorded].reverse()) {
    const patch = SOURCE_PATCHES.find((candidate) => candidate.path === path && candidate.id === record.id);
    assert.ok(patch, `${path}: no reviewed source patch ${record.id}`);
    assert.equal(hunksDigest(patch), record.sha256, `${path}: ${record.id} texts differ from the recorded digest`);
    assert.equal(patch.hunks.length, record.hunks);
    for (const hunk of [...patch.hunks].reverse()) {
      assert.equal(occurrences(text, hunk.replace), 1, `${path}: ${record.id} replacement is not present exactly once`);
      text = text.replace(hunk.replace, () => hunk.find);
    }
  }
  return Buffer.from(text, "utf8");
}

/** A vendored tree under test: where it lives, its manifest and the patches it must record. */
function describeTree(layout, patches, sourcePatches) {
  const manifest = JSON.parse(readFileSync(join(layout.vendorRoot, MANIFEST_FILE), "utf8"));
  return { layout, manifest, patches, sourcePatches: sourcePatches ?? manifest.sourcePatches ?? [],
    commit: layout.commit, short: layout.short };
}

// ---------------------------------------------------------------------------
// Identity assertions, shared by the committed trees and by scratch regenerations
// ---------------------------------------------------------------------------

function assertManifestPins(tree) {
  const { manifest, patches, sourcePatches, commit } = tree;
  assert.equal(manifest.schemaVersion, MANIFEST_SCHEMA);
  assert.equal(manifest.sourceCommit, commit);
  assert.equal(git(["rev-parse", "--verify", `${commit}^{commit}`]).trim(), commit);
  assert.deepEqual(manifest.exportPatches, patches);
  assert.equal(manifest.counts.exportPatched, patches.length);
  assert.deepEqual(manifest.sourcePatches ?? [], sourcePatches);
  assert.equal(manifest.counts.sourcePatched ?? 0, sourcePatches.length);
  const patchedFiles = [...new Set(patches.map((patch) => patch.path))].sort();
  const sourceFiles = [...new Set(sourcePatches.map((patch) => patch.path))].sort();
  assert.ok(manifest.files.every((file) => file.patch === filePatchKind(patchedFiles.includes(file.path),
    sourceFiles.includes(file.path))), "every file's patch kind is the patches recorded for it");
  assert.deepEqual(manifest.files.filter((file) => file.patch.split("+").includes("export")).map((file) => file.path).sort(),
    patchedFiles);
  assert.deepEqual(manifest.files.filter((file) => file.patch.split("+").includes("source")).map((file) => file.path).sort(),
    sourceFiles);
  assert.equal(manifest.counts.sourcePatchedFiles ?? 0, sourceFiles.length);
}

function assertFilesMatchCommit(tree) {
  const { manifest, patches, sourcePatches, commit, layout } = tree;
  const expected = revParse(commit, manifest.files.map((file) => file.path));
  for (const file of manifest.files) {
    const bytes = readFileSync(join(layout.vendorRoot, file.path));
    assert.equal(digest(bytes), file.sha256, `${file.path} sha256 differs from the manifest`);
    const original = stripExportTokens(file.path, reverseSourcePatches(file.path, bytes, sourcePatches), patches);
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
// Whole-tree assertions: bundle, closure, stubs and tsc over a layout
// ---------------------------------------------------------------------------

const loadEsbuild = () => createRequire(join(WORKER_ROOT, "package.json"))("esbuild");

async function withScratchAsync(fn) {
  const dir = mkdtempSync(join(tmpdir(), "vendor-analytics-kernels-check-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A scratch out root. Bare packages resolve from <dir>/node_modules (a link to
 * this checkout's), so a tree under <dir>/out bundles and typechecks the way a
 * tree under apps/worker does.
 */
function withWorkspace(fn) {
  return withScratchAsync((dir) => {
    symlinkSync(join(WORKER_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
    const out = join(dir, "out");
    mkdirSync(out);
    return fn(out);
  });
}

/**
 * Every module esbuild parsed for one entry: the input graph walked over its
 * resolved imports. `outputs[].inputs` is not that: it omits a module that
 * tree-shaking removed although the files that import it still need it.
 */
function inputGraph(metafile, entryKey) {
  const seen = new Set([entryKey]);
  const pending = [entryKey];
  while (pending.length) {
    for (const edge of metafile.inputs[pending.pop()].imports) {
      if (edge.external || !(edge.path in metafile.inputs) || seen.has(edge.path)) continue;
      seen.add(edge.path);
      pending.push(edge.path);
    }
  }
  return [...seen].sort();
}

/** esbuild over the vendored tree itself: per entry, the input graph and the tree-shaken output inputs, relative to the out root. */
async function vendoredClosure(tree) {
  const { layout } = tree;
  // esbuild reports real paths; a temporary directory is often a symlink (macOS /var).
  const root = realpathSync(layout.outRoot);
  const parityRoot = join(root, layout.parityRelative);
  const entryPoints = { kernel: `${layout.vendorRelative}/entry.ts` };
  WEB_ROOTS.forEach((path, index) => { entryPoints[`web${index}`] = `${layout.vendorRelative}/${path}`; });
  PARITY_SPECS.forEach((spec, index) => { entryPoints[`parity${index}`] = `${layout.parityRelative}/${spec}`; });
  const vendoredPackage = (name) => join(root, layout.vendorRelative, "packages", name.slice("@app-usagemonitor/".length), "index.js");
  const result = await loadEsbuild().build({
    absWorkingDir: root, entryPoints, bundle: true, write: false, metafile: true, platform: "node",
    format: "esm", target: "node22", mainFields: ["module", "main"], outdir: join(root, ".vendor-closure-check"),
    logLevel: "silent",
    plugins: [{
      name: "vendor-closure-check",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (args.path.startsWith(".") || args.path.startsWith("/")) return undefined;
          if (args.path.startsWith("@app-usagemonitor/")) {
            // Vendor-internal importers must resolve through tsconfig.json paths
            // (what the plain esbuild CLI uses); parity specs mirror the Vitest plugin.
            if (args.importer.startsWith(`${parityRoot}${sep}`)) return { path: vendoredPackage(args.path) };
            return undefined;
          }
          return { path: args.path, external: true };
        });
      },
    }],
  });
  const byEntry = {};
  const outputInputs = {};
  for (const output of Object.values(result.metafile.outputs)) {
    const name = Object.entries(entryPoints).find(([, path]) => path === output.entryPoint)?.[0];
    if (!name) continue;
    byEntry[name] = inputGraph(result.metafile, output.entryPoint);
    outputInputs[name] = Object.keys(output.inputs);
  }
  return { byEntry, outputInputs };
}

async function assertVendoredClosure(tree) {
  const { layout, manifest } = tree;
  const { byEntry } = await vendoredClosure(tree);
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
}

async function assertFacadeBundlesAndPrepares(tree) {
  const { layout } = tree;
  const result = await loadEsbuild().build({
    absWorkingDir: realpathSync(layout.outRoot), entryPoints: [`${layout.vendorRelative}/entry.ts`], bundle: true, write: false,
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
    // The per-event pricing seam: the projection, the pricer and the compiled registry.
    assert.equal(kernels.buildPricingEvent({ components: {} }, "2026-09-30T00:00:00.000Z"), null, "no token observations price nothing");
    const event = kernels.buildPricingEvent({ provider: "openai_codex", modelId: "gpt-5.5", billingSurface: "subscription",
      speedMode: "standard", apiServiceTier: null, reasoningEffort: "medium",
      components: { inputUncachedTokens: 1000, inputCacheReadTokens: 0, inputCacheWriteTokens: 0, outputTextTokens: 100,
        outputReasoningTokens: 0, outputCombinedTokens: 100 } }, "2026-09-30T00:00:00.000Z");
    assert.equal(event.totalInputContextTokens, 1000);
    const priced = kernels.priceTelemetryUsageEvent(event);
    assert.ok(Number.isSafeInteger(priced.costNanousd) && priced.costNanousd >= 0);
    assert.match(kernels.APP_PRICE_REGISTRY_MANIFEST.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Array.isArray(kernels.APP_OFFICIAL_PRICE_CARDS) && kernels.APP_OFFICIAL_PRICE_CARDS.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function assertTypeStubs(tree) {
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
  const { frontier, stubs } = await regenerateTypeStubs(manifest, { outRoot: layout.outRoot });
  assert.deepEqual(frontier, manifest.typeStubs.map((stub) => stub.source));
  for (const stub of manifest.typeStubs) {
    assert.ok(stubs.get(stub.path)?.equals(readFileSync(join(layout.vendorRoot, stub.path))), `${stub.path} is not the emitted declaration`);
  }
}

function assertTscConsumer(tree) {
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
}

/**
 * entry.ts states which commit its files are copies of. It must say this tree's
 * own short id, and every commit it names (found independently of the
 * generator: after the word "commit", or a hex run of 7-40 digits that mixes
 * digits and letters) must be this tree's.
 */
function assertFacadeProvenance(tree) {
  const text = readFileSync(join(tree.layout.vendorRoot, "entry.ts"), "utf8");
  assert.ok(text.includes(tree.short), `${tree.short}/entry.ts does not state its own commit`);
  const named = new Set();
  for (const match of text.matchAll(/\b(commit\s+)?([0-9a-f]{7,40})\b/g)) {
    if (match[1] || (/\d/.test(match[2]) && /[a-f]/.test(match[2]))) named.add(match[2]);
  }
  for (const token of named) assert.ok(tree.commit.startsWith(token), `${tree.short}/entry.ts names commit ${token}`);
}

/**
 * The generated vocabulary module must be exactly what the tree gives, derived
 * again here from the files on disk and the commit's Worker entry.
 */
async function assertVocabulariesGenerated(tree) {
  const { layout, manifest } = tree;
  const derived = await vocabulariesOfTree({ layout, manifest, workerIndexText: workerIndexAt(WORKER_ROOT, tree.commit) });
  assert.equal(derived.sourceCommit, tree.commit);
  const committed = readFileSync(layout.vocabularyPath, "utf8");
  const rendered = renderKernelVocabularies(derived);
  assert.deepEqual(changedVocabularies(committed, rendered), [], `${layout.vocabularyRelative} drifted from the vendored kernels`);
  assert.equal(committed, rendered, `${layout.vocabularyRelative} is not the rendering of the vendored tree; regenerate it`);
  return derived;
}

// ---------------------------------------------------------------------------
// The committed tree: one stable directory, checked against its own commit
// ---------------------------------------------------------------------------

const DEFAULT_LAYOUT = vendorLayout();
const RECORDED = JSON.parse(readFileSync(join(DEFAULT_LAYOUT.vendorRoot, MANIFEST_FILE), "utf8"));
/** The commit the stable directory holds now: d43c8f92 today, the production commit after a re-vendor. */
const CURRENT = RECORDED.sourceCommit;
const CURRENT_LAYOUT = vendorLayout({ commit: CURRENT });
const committedTrees = [describeTree(CURRENT_LAYOUT, CURRENT === COMMIT ? PINNED_EXPORT_PATCHES : RECORDED.exportPatches,
  CURRENT === COMMIT ? PINNED_SOURCE_PATCHES : RECORDED.sourcePatches ?? [])];

test("the vendor root holds exactly the one stable tree, and the parity root exactly its specs", () => {
  assert.deepEqual(readdirSync(join(WORKER_ROOT, "vendor")).sort(), [STABLE_VENDOR_RELATIVE.split("/")[1]]);
  assert.deepEqual(readdirSync(join(WORKER_ROOT, "analytics-v2-test")).filter((name) => name.startsWith("kernel-parity")),
    [STABLE_PARITY_RELATIVE.split("/")[1]]);
});

for (const tree of committedTrees) {
  const isDefault = tree.commit === COMMIT;
  const title = (text) => (isDefault ? text : `[${tree.short}] ${text}`);

  test(title(isDefault ? "the manifest pins d43c8f92, exactly six export patches and the pinned source patches" : `the manifest pins ${tree.short} and its recorded export and source patches`), () => {
    assertManifestPins(tree);
    if (!isDefault) return;
    assert.equal(SOURCE_COMMIT, COMMIT);
    assert.deepEqual(EXPORT_PATCHES.map((patch) => ({ ...patch })), PINNED_PATCH_SPECS);
    assert.equal(tree.manifest.exportPatches.length, 6);
    assert.equal(tree.manifest.counts.exportPatched, 6);
    assert.equal(tree.manifest.counts.exportPatchedFiles, 3);
    assert.equal(tree.manifest.exportsAlreadyPresent, undefined);
    assert.deepEqual(SOURCE_PATCHES.map((patch) => ({ path: patch.path, id: patch.id, hunks: patch.hunks.length,
      sha256: hunksDigest(patch) })), PINNED_SOURCE_PATCHES);
    assert.equal(tree.manifest.counts.sourcePatched, PINNED_SOURCE_PATCHES.length);
    assert.equal(tree.manifest.counts.sourcePatchedFiles, new Set(PINNED_SOURCE_PATCHES.map((patch) => patch.path)).size);
  });

  test(title("the generated GCP-only vocabularies are exactly what the vendored tree gives"), async () => {
    const derived = await assertVocabulariesGenerated(tree);
    if (!isDefault) return;
    // Pinned at d43c8f92: the values the GCP copies and primary 0059 were written for.
    assert.equal(derived.modelDates, 70);
    assert.equal(derived.sharedAnalyticsRefusalReasons.length, 18);
    assert.deepEqual(derived.cacheRetentionRefusalReasons, ["session_limit_exceeded", "group_limit_exceeded"]);
    assert.equal(derived.cacheRetentionBandIds.length, 10);
    assert.deepEqual(derived.cacheBandCounters, ["adjacencies", "reused_more_than_half", "matched_or_exceeded", "unordered_ties",
      "excluded_insufficient_evidence", "excluded_context_contracted", "sessions"]);
    assert.equal(derived.communityDailyReadSchemaVersion, "community-daily-read-v1.0");
  });

  test(title(`every vendored file equals git rev-parse ${tree.short}:<path> after source-patch reversal and export-token removal`), () => {
    assertFilesMatchCommit(tree);
  });

  test(title("the vendor directory holds exactly the manifest files and the authored facade"), () => {
    assertDirectoryHoldsManifestFiles(tree);
  });

  test(title("the authored facade's provenance text names this tree's commit and no other"), () => {
    assertFacadeProvenance(tree);
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

  test(title("the manifest is exactly the runtime closure of the facade, the site normalizer and the parity specs"), async () => {
    await assertVendoredClosure(tree);
  });

  test(title("the facade bundles for Node and prepares an empty owner-day"), async () => {
    await assertFacadeBundlesAndPrepares(tree);
  });

  test(title(`type stubs are this tsc's declarations of the ${tree.short} modules vendored files name only for types`), async () => {
    await assertTypeStubs(tree);
  });

  test(title("a tsc-checked consumer can import the facade with this checkout's tsconfig"), () => {
    assertTscConsumer(tree);
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

test("the layout is stable: every commit vendors into the same directories", async () => {
  const other = "0123456789abcdef0123456789abcdef01234567";
  const layout = vendorLayout({ commit: other, outRoot: "/scratch/out" });
  assert.equal(layout.commit, other);
  assert.equal(layout.vendorRelative, "vendor/analytics-d43c8f92");
  assert.equal(layout.parityRelative, "analytics-v2-test/kernel-parity");
  assert.equal(layout.vocabularyRelative, "src/analytics-v2/kernel-vocabularies.generated.ts");
  assert.equal(layout.vendorRoot, "/scratch/out/vendor/analytics-d43c8f92");
  assert.equal(layout.vocabularyPath, "/scratch/out/src/analytics-v2/kernel-vocabularies.generated.ts");
  assert.equal(VOCABULARY_RELATIVE, layout.vocabularyRelative);
  for (const key of ["vendorRelative", "parityRelative", "vocabularyRelative"]) assert.equal(DEFAULT_LAYOUT[key], layout[key]);
  assert.equal(DEFAULT_LAYOUT.vendorRoot, join(WORKER_ROOT, "vendor/analytics-d43c8f92"));
  // The Vitest config names the same root, so no re-vendor edits it (the
  // path-literal test below covers every other consumer).
  const config = await import(pathToFileURL(join(WORKER_ROOT, "vitest.analytics-v2.config.mjs")).href);
  assert.equal(config.VENDORED_PACKAGE_ENTRIES["@app-usagemonitor/accounting"], join(DEFAULT_LAYOUT.vendorRoot, "packages/accounting/index.js"));
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

test("source patches name a Worker file, an id and non-empty distinct hunks, once per file", () => {
  const ok = { path: "apps/worker/src/a.ts", id: "a-patch", hunks: [{ find: "x", replace: "y" }] };
  assertSourcePatchSpecs([ok]);
  for (const bad of [{ ...ok, path: "apps/worker/test/a.ts" }, { ...ok, path: "apps/worker/src/../a.ts" },
    { ...ok, id: "Not An Id" }, { ...ok, hunks: [] }, { ...ok, hunks: [{ find: "", replace: "y" }] },
    { ...ok, hunks: [{ find: "x", replace: "x" }] }, { ...ok, hunks: [{ find: "x" }] }]) {
    assert.throws(() => assertSourcePatchSpecs([bad]), refusedWith("SOURCE_PATCH_SPEC_INVALID"));
  }
  assert.throws(() => assertSourcePatchSpecs([ok, ok]), refusedWith("SOURCE_PATCH_SPEC_INVALID"));
  assertSourcePatchSpecs([ok, { ...ok, path: "apps/worker/src/b.ts" }]);
});

test("a source patch applies only where each hunk matches exactly once, and only when it can be reversed", () => {
  const path = "apps/worker/src/a.ts";
  const patch = (hunks) => [{ path, id: "a-patch", hunks }];
  const bytes = Buffer.from("const a = 1;\nconst b = 2;\n");
  assert.equal(applySourcePatches(path, bytes, patch([{ find: "const b = 2;", replace: "const b = 3;" },
    { find: "a = 1", replace: "a = 4" }])).toString(), "const a = 4;\nconst b = 3;\n");
  assert.equal(applySourcePatches("apps/worker/src/other.ts", bytes, patch([{ find: "zzz", replace: "y" }])), bytes);
  assert.throws(() => applySourcePatches(path, bytes, patch([{ find: "const c", replace: "y" }])),
    refusedWith("SOURCE_PATCH_UNRESOLVED"));
  assert.throws(() => applySourcePatches(path, bytes, patch([{ find: "const ", replace: "let " }])),
    refusedWith("SOURCE_PATCH_UNRESOLVED"));
  // A replacement the file already holds elsewhere, or one a later hunk
  // rewrites, could not be undone unambiguously.
  assert.throws(() => applySourcePatches(path, bytes, patch([{ find: "const b = 2;", replace: "const a = 1;" }])),
    refusedWith("SOURCE_PATCH_NOT_REVERSIBLE"));
  assert.throws(() => applySourcePatches(path, bytes, patch([{ find: "a = 1", replace: "a = 4" },
    { find: "a = 4;", replace: "a = 5;" }])), refusedWith("SOURCE_PATCH_NOT_REVERSIBLE"));
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

test("a regex after an if, while or for header, or after a closing brace, is a regex; after any other `)` it is a division", () => {
  // The decoy sits inside a template literal; the real declaration is on the stated line.
  const decoy = "const t = `\nfunction foo() {}\n`;\n";
  const regexCases = [
    [`declare const c: boolean, s: string;\nif (c) /\`/.test(s);\nfunction foo() { return 1; }\n${decoy}`, 3],
    [`declare const c: boolean, s: string;\nwhile (c) /'/.test(s);\nfunction foo() { return 1; }\n${decoy}`, 3],
    [`declare const c: boolean, s: string;\nfor (const x of s) /"/.test(x);\nfunction foo() { return 1; }\n${decoy}`, 3],
    [`declare const c: boolean, s: string;\nfor await (const x of s) /\`/.test(x);\nfunction foo() { return 1; }\n${decoy}`, 3],
    ["declare const a: boolean, b: string;\nif (a) {}\n/\"/.test(b);\nfunction foo() {}\n", 4],
    ["if (a) {}\n/\"/.test(b);\nfunction foo() {}\n", 3],
  ];
  for (const [text, line] of regexCases) {
    const found = locate(text, "foo");
    assert.equal(found.status, "apply", text);
    assert.equal(found.line, line, text);
  }
  // Divisions stay divisions: read as regexes they would swallow a template's backtick and leave the file unclosed.
  for (const text of ["const r = (a) / 2 + `/`;\nfunction foo() {}\n", "const r = f(a) / 2 + `/`;\nfunction foo() {}\n",
    "const r = a[0] / 2 + `/`;\nfunction foo() {}\n", "const q = (a + b) / 2 / 3;\nfunction foo() {}\n",
    // A call that is only named like a keyword is not a header.
    "const r = a.if(b) / 2 + `/`;\nfunction foo() {}\n"]) {
    const found = locate(text, "foo");
    assert.equal(found.status, "apply", text);
    assert.equal(found.line, 2, text);
  }
});

test("the parser backstop accepts a patch whose declaration follows a regex the lexer had to read from context", async () => {
  const esbuild = loadEsbuild();
  const text = "declare const c: boolean, s: string;\nif (c) /`/.test(s);\nfunction foo() { return 1; }\nconst t = `\nfunction foo() {}\n`;\n";
  const plan = await planExportPatches({ patches: [{ ...patchFor("foo") }], readText: () => text, esbuild });
  assert.equal(plan[0].line, 3);
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

/** Every file a run writes under an out root: the vendor tree, the parity specs and the vocabulary module. */
function assertSameOutput(scratch, committed, label) {
  assertSameFiles(snapshot(scratch.vendorRoot), snapshot(committed.vendorRoot), `${label}: vendor tree`);
  assertSameFiles(snapshot(scratch.parityRoot), snapshot(committed.parityRoot), `${label}: parity specs`);
  assert.ok(readFileSync(scratch.vocabularyPath).equals(readFileSync(committed.vocabularyPath)), `${label}: ${scratch.vocabularyRelative} differs`);
}

test("regenerating the committed commit into a scratch directory reproduces the committed tree byte for byte", () => {
  withScratch((out) => {
    const run = runGenerator([`--commit=${CURRENT}`, `--out-root=${out}`, `--authored-from=${DEFAULT_LAYOUT.vendorRoot}`]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /"status":"ok"/);
    assert.equal(JSON.parse(run.stdout).replaced, undefined);
    const scratch = vendorLayout({ commit: CURRENT, outRoot: out });
    assertSameOutput(scratch, CURRENT_LAYOUT, "first run");
    assert.deepEqual(readdirSync(out).sort(), ["analytics-v2-test", "src", "vendor"]);
    assert.deepEqual(listFiles(join(out, "src")), [VOCABULARY_RELATIVE.slice("src/".length)]);
    // Without --commit the generator vendors d43c8f92, over its own previous output.
    if (CURRENT !== COMMIT) return;
    const again = runGenerator([`--out-root=${out}`]);
    assert.equal(again.status, 0, again.stderr);
    assertSameOutput(scratch, CURRENT_LAYOUT, "second run");
  });
});

/** A reviewed facade for another commit: d43c8f92's, with its provenance text pointed at that commit. */
function placeFacadeFor(layout) {
  mkdirSync(layout.vendorRoot, { recursive: true });
  writeFileSync(join(layout.vendorRoot, "entry.ts"),
    readFileSync(join(DEFAULT_LAYOUT.vendorRoot, "entry.ts"), "utf8").replaceAll(COMMIT.slice(0, 8), layout.short));
  writeFileSync(join(layout.vendorRoot, "tsconfig.json"), readFileSync(join(DEFAULT_LAYOUT.vendorRoot, "tsconfig.json")));
}

/**
 * A commit whose runtime closure differs from d43c8f92's: 25 commits earlier,
 * three Worker modules (analytics-delivery, d1-invocation-budget and
 * v11-storage-journal) are used for values only from code that tree-shaking
 * removes. A generator that took its closure from the bundle's outputs left them
 * out, wrote type stubs for them, and still printed ok for a tree that cannot be
 * bundled.
 */
const OTHER_COMMIT = git(["rev-parse", "--verify", `${COMMIT}~25`]).trim();
const TREE_SHAKEN_MODULES = ["analytics-delivery", "d1-invocation-budget", "v11-storage-journal"].map((name) => `apps/worker/src/${name}.ts`);

/** d43c8f92's facade with its provenance text pointed at `short`, or naming no commit when `short` is null. */
function facadeText(short) {
  const text = readFileSync(join(DEFAULT_LAYOUT.vendorRoot, "entry.ts"), "utf8");
  return short === null ? text.replaceAll(`commit ${COMMIT.slice(0, 8)}`, "the vendored commit").replaceAll(COMMIT.slice(0, 8), "the vendored commit")
    : text.replaceAll(COMMIT.slice(0, 8), short);
}

test("another commit replaces the one the stable directory holds only after its facade is reviewed, and passes every per-tree assertion", async () => {
  assert.notEqual(OTHER_COMMIT, COMMIT);
  assert.equal(CURRENT, COMMIT, "this test starts from the d43c8f92 tree; after a re-vendor, point it at the new commit's predecessor");
  await withWorkspace(async (out) => {
    const seeded = runGenerator([`--commit=${COMMIT}`, `--out-root=${out}`, `--authored-from=${DEFAULT_LAYOUT.vendorRoot}`]);
    assert.equal(seeded.status, 0, seeded.stderr);
    const layout = vendorLayout({ commit: OTHER_COMMIT, outRoot: out });
    const facade = join(layout.vendorRoot, "entry.ts");

    // The facade still names d43c8f92: its provenance would be false for the other commit.
    const before = snapshot(out);
    const stale = runGenerator([`--commit=${OTHER_COMMIT}`, `--out-root=${out}`]);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /^AUTHORED_PROVENANCE_MISMATCH: /);
    // A facade that names no commit at all is not a reviewed transition either.
    writeFileSync(facade, facadeText(null));
    assert.deepEqual(commitsNamedIn(readFileSync(facade, "utf8")), []);
    const unnamed = runGenerator([`--commit=${OTHER_COMMIT}`, `--out-root=${out}`]);
    assert.equal(unnamed.status, 1);
    assert.match(unnamed.stderr, new RegExp(`^VENDOR_TRANSITION_FACADE_UNREVIEWED: vendor/analytics-d43c8f92 holds ${COMMIT}`));
    writeFileSync(facade, readFileSync(join(DEFAULT_LAYOUT.vendorRoot, "entry.ts")));
    assertSameFiles(snapshot(out), before, "after refused transitions");

    // Reviewed: the facade names the other commit. It replaces d43c8f92 in place.
    writeFileSync(facade, facadeText(layout.short));
    const run = runGenerator([`--commit=${OTHER_COMMIT}`, `--out-root=${out}`]);
    assert.equal(run.status, 0, run.stderr);
    const logged = JSON.parse(run.stdout);
    assert.equal(logged.replaced, COMMIT);
    assert.deepEqual(logged.verified, { standaloneBundle: true, closureModules: logged.verified.closureModules, load: true, typecheck: true, vocabularies: true });
    assert.equal(layout.vendorRelative, DEFAULT_LAYOUT.vendorRelative);
    assert.equal(layout.parityRelative, DEFAULT_LAYOUT.parityRelative);
    assert.deepEqual(readdirSync(join(out, "vendor")), [STABLE_VENDOR_RELATIVE.split("/")[1]]);
    assert.deepEqual(readdirSync(join(out, "analytics-v2-test")), [STABLE_PARITY_RELATIVE.split("/")[1]]);
    const manifest = JSON.parse(readFileSync(join(layout.vendorRoot, MANIFEST_FILE), "utf8"));
    assert.equal(manifest.sourceCommit, OTHER_COMMIT);
    assert.deepEqual(manifest.exportPatches.map((patch) => patch.symbol), PINNED_PATCH_SPECS.map((spec) => spec.symbol));
    const tree = describeTree(layout, manifest.exportPatches);
    // The same assertions as every committed tree, over the regenerated one.
    assertManifestPins(tree);
    assertFilesMatchCommit(tree);
    assertDirectoryHoldsManifestFiles(tree);
    assertFacadeProvenance(tree);
    assertPackagesComplete(tree);
    assertParitySpecsRewritten(tree);
    assertNoCloudflareImports(tree);
    await assertVendoredClosure(tree);
    await assertFacadeBundlesAndPrepares(tree);
    await assertTypeStubs(tree);
    assertTscConsumer(tree);
    for (const entry of manifest.parityTests) assert.ok(entry.rewrite.to.includes(`${STABLE_VENDOR_RELATIVE}/`), entry.path);
    // The vocabularies were regenerated for the commit the tree now holds.
    await assertVocabulariesGenerated(tree);
    assert.match(readFileSync(layout.vocabularyPath, "utf8"), new RegExp(`SOURCE_COMMIT = "${OTHER_COMMIT}"`));
    assert.ok(readFileSync(join(layout.vendorRoot, "tsconfig.json")).equals(readFileSync(join(DEFAULT_LAYOUT.vendorRoot, "tsconfig.json"))));

    // The regression: those modules are in the closure as files, not stubs, and
    // they are exactly what an output-based closure misses at this commit.
    const vendored = new Set(manifest.files.map((file) => file.path));
    const stubbed = new Set(manifest.typeStubs.map((stub) => stub.source));
    for (const path of TREE_SHAKEN_MODULES) {
      assert.ok(vendored.has(path), `${path} must be vendored as a file`);
      assert.ok(!stubbed.has(path), `${path} must not be replaced by a type stub`);
    }
    const { byEntry, outputInputs } = await vendoredClosure(tree);
    const shaken = byEntry.kernel.filter((input) => !outputInputs.kernel.includes(input)).map((input) => input.slice(`${layout.vendorRelative}/`.length));
    assert.ok(TREE_SHAKEN_MODULES.every((path) => shaken.includes(path)), `expected ${TREE_SHAKEN_MODULES.join(", ")} to be parsed but not in the bundle's outputs; got ${shaken.join(", ")}`);
    // d43c8f92 itself keeps no such module, so this commit really does differ.
    const base = JSON.parse(readFileSync(join(DEFAULT_LAYOUT.vendorRoot, MANIFEST_FILE), "utf8"));
    assert.notDeepEqual(manifest.files.map((file) => file.path), base.files.map((file) => file.path));

    const first = snapshot(out);
    const again = runGenerator([`--commit=${OTHER_COMMIT}`, `--out-root=${out}`]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).replaced, undefined);
    assertSameFiles(snapshot(out), first, "second run");

    // And back: restoring d43c8f92's reviewed facade and vendoring d43c8f92 again
    // reproduces the committed tree, parity specs and vocabularies byte for byte,
    // with nothing left over from the other commit.
    writeFileSync(facade, readFileSync(join(DEFAULT_LAYOUT.vendorRoot, "entry.ts")));
    const back = runGenerator([`--commit=${COMMIT}`, `--out-root=${out}`]);
    assert.equal(back.status, 0, back.stderr);
    assert.equal(JSON.parse(back.stdout).replaced, OTHER_COMMIT);
    assertSameOutput(vendorLayout({ commit: COMMIT, outRoot: out }), DEFAULT_LAYOUT, "round trip");
  });
});

test("the generator never overwrites reviewed files, and never replaces a commit its facade does not name", () => {
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
    // The stable directory holds another commit, and the facade beside it names none.
    const dir = join(out, DEFAULT_LAYOUT.vendorRelative);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "entry.ts"), facadeText(null));
    writeFileSync(join(dir, "tsconfig.json"), readFileSync(join(DEFAULT_LAYOUT.vendorRoot, "tsconfig.json")));
    const foreign = { schemaVersion: MANIFEST_SCHEMA, sourceCommit: OTHER_COMMIT, files: [{ path: "apps/worker/src/keep.ts" }] };
    writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(foreign));
    mkdirSync(join(dir, "apps/worker/src"), { recursive: true });
    writeFileSync(join(dir, "apps/worker/src/keep.ts"), "keep\n");
    const before = snapshot(out);
    const run = runGenerator([`--out-root=${out}`]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, new RegExp(`^VENDOR_TRANSITION_FACADE_UNREVIEWED: vendor/analytics-d43c8f92 holds ${OTHER_COMMIT}`));
    assertSameFiles(snapshot(out), before, "after a refused transition");
    // A manifest of a schema this generator does not know is never replaced.
    writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify({ ...foreign, schemaVersion: "analytics-kernel-vendor-manifest-v0" }));
    writeFileSync(join(dir, "entry.ts"), readFileSync(join(DEFAULT_LAYOUT.vendorRoot, "entry.ts")));
    const unknown = runGenerator([`--out-root=${out}`]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /^MANIFEST_SCHEMA_UNKNOWN: /);
  });
});

// ---------------------------------------------------------------------------
// The closure is every parsed module, not the tree-shaken outputs
// ---------------------------------------------------------------------------

test("the closure keeps a module used only from dead code and drops a type-only import", async () => {
  await withScratchAsync(async (dir) => {
    writeFileSync(join(dir, "a.ts"), [
      "import { b } from \"./b\";", "import type { T } from \"./t\";", "import { U } from \"./u\";",
      "export function live(x: T): U { return x as unknown as U; }",
      "function dead() { return b(); }", "void dead;", "",
    ].join("\n"));
    writeFileSync(join(dir, "b.ts"), "export function b() { return 1; }\n");
    writeFileSync(join(dir, "t.ts"), "export type T = string;\n");
    writeFileSync(join(dir, "u.ts"), "export type U = number;\n");
    const result = await loadEsbuild().build({ absWorkingDir: realpathSync(dir), entryPoints: { a: "a.ts" }, bundle: true, write: false,
      metafile: true, format: "esm", outdir: "out", logLevel: "silent" });
    const [output] = Object.values(result.metafile.outputs);
    // The defect in one line: the output's inputs forget b.ts although a.ts imports it for a value.
    assert.deepEqual(Object.keys(output.inputs), ["a.ts"]);
    assert.deepEqual(reachableInputs(result.metafile, "a.ts"), ["a.ts", "b.ts"]);
    assert.throws(() => reachableInputs(result.metafile, "nowhere.ts"), refusedWith("CLOSURE_ENTRY_MISSING"));
  });
});

// ---------------------------------------------------------------------------
// The generator proves the tree on its own before it writes anything
// ---------------------------------------------------------------------------

/** One regeneration of d43c8f92 into a scratch workspace, copied per case. */
function withGeneratedBase(fn) {
  return withWorkspace(async (out) => {
    const run = runGenerator([`--commit=${COMMIT}`, `--out-root=${out}`, `--authored-from=${DEFAULT_LAYOUT.vendorRoot}`]);
    assert.equal(run.status, 0, run.stderr);
    return fn(out);
  });
}

test("the generator refuses a facade that re-exports a name its module no longer has, and keeps the existing output", async () => {
  await withGeneratedBase((out) => {
    const layout = vendorLayout({ commit: COMMIT, outRoot: out });
    const before = snapshot(out);
    const facade = join(layout.vendorRoot, "entry.ts");
    // esbuild bundles this without a word; only tsc reports the missing member.
    writeFileSync(facade, readFileSync(facade, "utf8").replace("  evaluateSharedCacheDay,\n", "  evaluateSharedCacheDay,\n  noSuchExportAnywhere,\n"));
    const run = runGenerator([`--commit=${COMMIT}`, `--out-root=${out}`]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /^VENDORED_TREE_TYPECHECK_FAILED: .*TS2305.*noSuchExportAnywhere/);
    assert.equal(run.stdout, "");
    writeFileSync(facade, readFileSync(join(DEFAULT_LAYOUT.vendorRoot, "entry.ts")));
    assertSameFiles(snapshot(out), before, "after a refused run");
  });
});

test("the standalone verifier refuses a written tree that cannot be bundled, loaded or typechecked", async () => {
  await withGeneratedBase(async (out) => {
    const base = vendorLayout({ commit: COMMIT, outRoot: out });
    const manifest = JSON.parse(readFileSync(join(base.vendorRoot, MANIFEST_FILE), "utf8"));
    const expectedReach = new Map(manifest.files.filter((file) => file.reach !== "package").map((file) => [file.path, file.reach]));
    const ambientTypes = join(dirname(out), "worker-configuration.d.ts");
    writeFileSync(ambientTypes, git(["show", `${COMMIT}:apps/worker/worker-configuration.d.ts`]));
    /** A copy of the generated tree that `change(layout)` may damage, then verified. */
    const verifying = async (change, options = {}) => {
      const copy = join(dirname(out), `case-${Math.random().toString(16).slice(2)}`);
      mkdirSync(copy);
      cpSync(out, copy, { recursive: true });
      const layout = vendorLayout({ commit: COMMIT, outRoot: copy });
      change?.(layout);
      return verifyVendoredTree({ layout, expectedReach, ambientTypes, ...options });
    };
    const rejects = (promise, code, pattern) => assert.rejects(promise, (error) => error instanceof VendorError && error.code === code
      && (pattern === undefined || pattern.test(error.message)), `${code} ${pattern ?? ""}`);

    const passed = await verifying();
    assert.ok(passed.closureModules >= expectedReach.size, "the closure covers every vendored non-package file");
    assert.ok(passed.exports > 0);

    // 1. A file the facade needs for a value is gone: the tree cannot be bundled.
    const needed = "apps/worker/src/d1-invocation-budget.ts";
    assert.ok(expectedReach.has(needed));
    await rejects(verifying((layout) => rmSync(join(layout.vendorRoot, needed))), "VENDORED_TREE_UNBUNDLABLE", /Could not resolve "\.\/d1-invocation-budget"/);
    // 2. The closure the files give differs from the one the extraction found.
    const fewer = new Map(expectedReach);
    fewer.delete(needed);
    await rejects(verifying(undefined, { expectedReach: fewer }), "VENDORED_CLOSURE_MISMATCH", /d1-invocation-budget/);
    await rejects(verifying(undefined, { expectedReach: new Map([...expectedReach, ["apps/worker/src/not-reached.ts", "kernel"]]) }),
      "VENDORED_CLOSURE_MISMATCH", /not-reached/);
    // 3. A module that bundles but throws when it loads.
    await rejects(verifying((layout) => {
      const file = join(layout.vendorRoot, "apps/worker/src/cache-retention-values.ts");
      writeFileSync(file, `${readFileSync(file, "utf8")}\nthrow new Error("boom at load");\n`);
    }), "VENDORED_TREE_UNLOADABLE", /boom at load/);
    // 4. A facade esbuild accepts and tsc does not.
    await rejects(verifying((layout) => {
      const file = join(layout.vendorRoot, "entry.ts");
      writeFileSync(file, `${readFileSync(file, "utf8")}\nexport { missingFromModule } from "./apps/worker/src/cache-retention-values";\n`);
    }), "VENDORED_TREE_TYPECHECK_FAILED", /missingFromModule/);
    // 5. No ambient Worker types to check against.
    await rejects(verifying(undefined, { ambientTypes: join(dirname(out), "absent.d.ts") }), "AMBIENT_TYPES_MISSING");
  });
});

// ---------------------------------------------------------------------------
// Provenance of the reviewed facade
// ---------------------------------------------------------------------------

test("the commits a facade names are found by the word commit or by a hex run that mixes digits and letters", () => {
  assert.deepEqual(commitsNamedIn("a byte copy of commit d43c8f92 (the production Worker)"), ["d43c8f92"]);
  assert.deepEqual(commitsNamedIn("commit DEADBEEF, and 0123456789abcdef0123456789abcdef01234567"),
    ["0123456789abcdef0123456789abcdef01234567", "deadbeef"]);
  // Words, plain numbers, short runs and longer digests are not commits.
  assert.deepEqual(commitsNamedIn("a facade for the decade, 20260930, 1234567, deadbeef, abc123 and fed3 ".concat("a".repeat(64))), []);
  assert.deepEqual(foreignCommitsNamed("commit d43c8f92 and 1234abcd", COMMIT), ["1234abcd"]);
  assert.deepEqual(foreignCommitsNamed("commit d43c8f9 and d43c8f92a059d9c577776f7eca8a331eb305b8a6", COMMIT), []);
  assert.deepEqual(foreignCommitsNamed("a facade that names no commit", COMMIT), []);
  // A short id of digits only is a number to the heuristic; a known source commit makes it a mention.
  assert.deepEqual(commitsNamedIn("copies of 22142599 and the date 20260930"), []);
  assert.deepEqual(foreignCommitsNamed("copies of 22142599 and the date 20260930", COMMIT, ["221425991741f8de63181749e4189a35ad7eaaef"]), ["22142599"]);
  assert.deepEqual(foreignCommitsNamed("copies of 22142599", "221425991741f8de63181749e4189a35ad7eaaef", ["221425991741f8de63181749e4189a35ad7eaaef"]), []);
});

test("a facade that names another commit is refused, whether seeded or already in place, and nothing is written", () => {
  withScratch((out) => {
    const seeded = runGenerator([`--commit=${OTHER_COMMIT}`, `--out-root=${out}`, `--authored-from=${DEFAULT_LAYOUT.vendorRoot}`]);
    assert.equal(seeded.status, 1);
    assert.match(seeded.stderr, new RegExp(`^AUTHORED_PROVENANCE_MISMATCH: .*names commit ${COMMIT.slice(0, 8)}, not ${OTHER_COMMIT.slice(0, 8)}`));
    assert.equal(seeded.stdout, "");
    assert.deepEqual(readdirSync(out), []);
    const layout = vendorLayout({ commit: OTHER_COMMIT, outRoot: out });
    mkdirSync(layout.vendorRoot, { recursive: true });
    for (const file of AUTHORED_FILES) writeFileSync(join(layout.vendorRoot, file), readFileSync(join(DEFAULT_LAYOUT.vendorRoot, file)));
    const before = snapshot(out);
    const placed = runGenerator([`--commit=${OTHER_COMMIT}`, `--out-root=${out}`]);
    assert.equal(placed.status, 1);
    assert.match(placed.stderr, /^AUTHORED_PROVENANCE_MISMATCH: /);
    assertSameFiles(snapshot(out), before, "after a refused facade");
  });
});

// ---------------------------------------------------------------------------
// The commit must be a commit: an annotated tag id is not
// ---------------------------------------------------------------------------

test("an annotated tag id and a tree id are refused as the source commit", () => {
  withScratch((dir) => {
    const run = (...args) => execFileSync("git", ["-c", "user.name=check", "-c", "user.email=check@example.invalid", "-c", "commit.gpgsign=false",
      "-c", "tag.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
    run("init", "-q");
    writeFileSync(join(dir, "file"), "synthetic\n");
    run("add", "file");
    run("commit", "-q", "-m", "synthetic");
    const commit = run("rev-parse", "HEAD");
    run("tag", "-a", "annotated", "-m", "synthetic");
    const tag = run("rev-parse", "annotated");
    const tree = run("rev-parse", "HEAD^{tree}");
    assert.ok(new Set([commit, tag, tree]).size === 3);
    assert.doesNotThrow(() => assertSourceCommit(dir, commit));
    for (const id of [tag, tree, "0".repeat(40)]) assert.throws(() => assertSourceCommit(dir, id), refusedWith("SOURCE_COMMIT_UNAVAILABLE"), id);
  });
});

// ---------------------------------------------------------------------------
// Consumers that name a vendored tree
// ---------------------------------------------------------------------------

test("every vendored-tree path named outside the trees names a tree that exists", () => {
  // Adopting another commit means editing these (the receipt lists them). This
  // cannot say which consumers a commit change must touch; it does catch one
  // that still names a tree that was renamed or removed.
  const repo = git(["rev-parse", "--show-toplevel"]).trim();
  const out = execFileSync("git", ["grep", "-I", "-o", "-h", "-E", "vendor/analytics-[0-9a-f]{8}|kernel-parity(-[0-9a-f]{8})?", "--", ".",
    ":(exclude)docs", ":(exclude)apps/worker/vendor", ":(exclude)apps/worker/analytics-v2-test/kernel-parity",
    ":(exclude)apps/worker/analytics-v2-test/kernel-parity-*", ":(exclude)apps/worker/scripts/vendor-analytics-kernels.mjs",
    ":(exclude)apps/worker/scripts/vendor-analytics-kernels.check.mjs"], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const named = [...new Set(out.split("\n").filter(Boolean))].sort();
  assert.ok(named.length > 0, "expected the analytics-v2 consumers to name the vendored tree");
  for (const literal of named) {
    const path = literal.startsWith("vendor/") ? join(WORKER_ROOT, literal) : join(WORKER_ROOT, "analytics-v2-test", literal);
    assert.ok(existsSync(path), `a tracked file names ${literal}, which does not exist; update it with the tree that replaced it`);
  }
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

test("the report resolves the patches at a commit, names drifted files, builds the tree on its own and writes nothing", async () => {
  const porcelain = () => git(["status", "--porcelain", "--untracked-files=all", "--", "."]);
  const before = porcelain();
  const reference = JSON.parse(readFileSync(join(DEFAULT_LAYOUT.vendorRoot, MANIFEST_FILE), "utf8"));
  const report = await reportAtCommit({ commit: COMMIT, reference, referenceDirectory: DEFAULT_LAYOUT.vendorRoot });
  assert.equal(report.ok, true);
  assert.equal(report.patchesOk, true);
  assert.deepEqual(report.patches.map(({ path, line, symbol, original }) => ({ path, line, symbol, original })), PINNED_EXPORT_PATCHES);
  assert.deepEqual(report.summary, { apply: 6 });
  assert.equal(report.verification.status, "passed");
  assert.deepEqual(report.sourcePatches, PINNED_SOURCE_PATCHES.map(({ path, id }) => ({ path, id, status: "apply" })));
  assert.deepEqual(report.drift.changed, []);
  assert.deepEqual(report.drift.removed, []);
  assert.equal(report.drift.identical, report.drift.checked);
  assert.deepEqual(report.facade, { entry: "entry.ts", modules: report.facade.modules, unresolved: [] });
  assert.deepEqual(report.provenance, { entry: "entry.ts", named: [COMMIT.slice(0, 8)], foreign: [] });
  assert.equal(report.generation.status, "passed");
  assert.equal(report.generation.counts.exportPatched, 6);
  // The same commit gives the committed vocabularies: nothing to port.
  assert.deepEqual(report.generation.vocabularies, { module: VOCABULARY_RELATIVE, changed: [] });
  // Against a reference whose recorded blobs are wrong the same commit reports every file as changed.
  const stale = { ...reference, files: reference.files.map((file) => ({ ...file, blob: "0".repeat(40) })), typeStubs: [], parityTests: [] };
  const drifted = await reportAtCommit({ commit: COMMIT, reference: stale });
  assert.equal(drifted.drift.changed.length, reference.files.length);
  assert.equal(drifted.facade, null);
  assert.equal(drifted.provenance, null);
  const run = runGenerator(["--report"]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).ok, true);
  const missing = runGenerator(["--report", `--reference=${join(tmpdir(), "no-such-manifest.json")}`]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^REFERENCE_MANIFEST_MISSING: /);
  assert.equal(typeof main, "function");
  assert.equal(porcelain(), before, "the report left files behind in the repository");
});

test("the report is never ok for a facade it cannot build with, one that names another commit, or one whose imports are gone", async () => {
  const reference = JSON.parse(readFileSync(join(DEFAULT_LAYOUT.vendorRoot, MANIFEST_FILE), "utf8"));
  // Another commit with d43c8f92's facade: everything builds, but the provenance text would be false there.
  const other = await reportAtCommit({ commit: OTHER_COMMIT, reference, referenceDirectory: DEFAULT_LAYOUT.vendorRoot });
  assert.equal(other.patchesOk, true);
  assert.equal(other.generation.status, "passed");
  assert.deepEqual(other.provenance.foreign, [COMMIT.slice(0, 8)]);
  assert.ok(Array.isArray(other.generation.vocabularies.changed));
  assert.equal(other.ok, false);
  // No reference directory: there is no facade to build with, so no answer.
  const bare = await reportAtCommit({ commit: COMMIT, reference });
  assert.equal(bare.patchesOk, true);
  assert.equal(bare.generation.status, "skipped");
  assert.equal(bare.ok, false);
  // A facade that imports a module the commit does not have.
  await withScratchAsync(async (dir) => {
    for (const file of AUTHORED_FILES) writeFileSync(join(dir, file), readFileSync(join(DEFAULT_LAYOUT.vendorRoot, file)));
    writeFileSync(join(dir, "entry.ts"), `${readFileSync(join(dir, "entry.ts"), "utf8")}\nexport { nothing } from "./apps/worker/src/no-such-module";\n`);
    const gone = await reportAtCommit({ commit: COMMIT, reference, referenceDirectory: dir });
    assert.deepEqual(gone.facade.unresolved, ["apps/worker/src/no-such-module"]);
    assert.equal(gone.generation.status, "skipped");
    assert.equal(gone.ok, false);
    // A facade the commit's files satisfy, with a rename the facade did not follow: the build says so.
    writeFileSync(join(dir, "entry.ts"), `${readFileSync(join(DEFAULT_LAYOUT.vendorRoot, "entry.ts"), "utf8")}\nexport { missingFromModule } from "./apps/worker/src/cache-retention-values";\n`);
    const renamed = await reportAtCommit({ commit: COMMIT, reference, referenceDirectory: dir });
    assert.deepEqual(renamed.facade.unresolved, []);
    assert.equal(renamed.generation.status, "refused");
    assert.equal(renamed.generation.code, "VENDORED_TREE_TYPECHECK_FAILED");
    assert.equal(renamed.ok, false);
  });
});

// ---------------------------------------------------------------------------
// The GCP-only vocabularies are derived, never listed
// ---------------------------------------------------------------------------

const refusedVocabulary = (code) => (error) => (error instanceof VocabularyError || error instanceof VendorError) && error.code === code;

test("refusal reasons are the plain literals a class is constructed with, and anything else refuses", () => {
  const defining = "apps/worker/src/defining.ts";
  const reasons = (text, path = "apps/worker/src/x.ts") => constructedReasons({ text, path, className: "Refused", definingPath: defining, maskNonCode });
  assert.deepEqual(reasons("throw new Refused('a_b');\nthrow new Refused(\"c\");\nif (x) throw new Refused( 'a_b' );\n"), ["a_b", "c"]);
  // Decoys in comments, strings and templates, and other classes, are not constructions.
  assert.deepEqual(reasons([
    "// throw new Refused('in_comment');", "/* new Refused('in_block') */", "const s = \"new Refused('in_string')\";",
    "const t = `new Refused('in_template')`;", "throw new NotRefused('other_class');", "throw new RefusedLater('prefix');", "",
  ].join("\n")), []);
  for (const bad of ["new Refused(reason);", "new Refused(`a`);", "new Refused('a' + b);", "new Refused('a', 1);",
    "new Refused('Not-A-Reason');", "new Refused();", "new Refused(\n  cond ? 'a' : 'b');", "new Refused;",
    "const f = (r) => new Refused(r);"]) {
    assert.throws(() => reasons(`${bad}\n`), refusedVocabulary("VOCABULARY_REASON_NOT_LITERAL"), bad);
  }
  assert.throws(() => reasons("class Mine extends Refused {}\nthrow new Mine('x');\n"), refusedVocabulary("VOCABULARY_REFUSAL_CLASS_EXTENDED"));

  // The forms a source may name the class in: a plain import (type-only too),
  // instanceof, and in the defining module its one declaration and a local export.
  assert.deepEqual(reasons([
    "import { other, Refused, type Kind } from './defining';", "import type { Refused } from './defining';",
    "if (error instanceof Refused) throw new Refused('kept');", "",
  ].join("\n")), ["kept"]);
  assert.deepEqual(reasons([
    "export class Refused extends Error {}", "function f() { throw new Refused('own'); }", "export { f, Refused };", "",
  ].join("\n"), defining), ["own"]);
  assert.throws(() => reasons("throw new Refused('x');\n", defining), refusedVocabulary("VOCABULARY_SOURCE_CHANGED"));
  assert.throws(() => reasons("export class Refused extends Error {}\nclass Refused2 {}\nexport class Refused extends Error {}\n", defining),
    refusedVocabulary("VOCABULARY_SOURCE_CHANGED"));
  assert.throws(() => reasons("class Refused extends Error {}\nthrow new Refused('x');\n"), refusedVocabulary("VOCABULARY_SOURCE_CHANGED"));

  // Anything that could construct the class under another name refuses rather than under-reports.
  for (const bad of [
    "import { Refused as U } from './defining';\nthrow new U('aliased_reason');",
    "import { other, Refused as U } from \"./defining\";\nthrow new U('aliased_reason');",
    "import { Thing as Refused } from './elsewhere';\nthrow new Refused('borrowed');",
    "import * as R from './defining';\nthrow new R.Refused('ns_reason');",
    "import * as R from './defining.ts';\nthrow new R['Refused']('computed_member');",
    "import Default, * as R from '../src/defining';\nR.thing();",
    "export * from './defining';",
    "export * as R from './defining';",
    "const m = await import('./defining');\nthrow new m.Refused('dynamic');",
    "const m = await import(name);",
    "const E = Refused;\nthrow new E('var_reason');",
    "throw Reflect.construct(Refused, ['reflected']);",
    "const table = { Refused };",
    "throw new errors.Refused('member');",
    "if (e instanceof Refused.prototype.constructor) {}",
    "export { Refused } from './defining';",
    "import { Refused } from './defining';\nexport { Refused };",
    "export { Refused as Other } from './defining';",
  ]) assert.throws(() => reasons(`${bad}\n`), refusedVocabulary("VOCABULARY_REFUSAL_CLASS_ALIASED"), bad);
  // A namespace or dynamic import of another module is not a route to the class.
  assert.deepEqual(reasons("import * as other from './other';\nconst m = await import('./elsewhere');\nthrow new Refused('ok');\n"), ["ok"]);
});

test("the reasons a bundle constructs are its plain literals, and a renamed class refuses", () => {
  const bundled = (text) => bundledConstructedReasons({ text, className: "Refused", maskNonCode });
  assert.deepEqual(bundled("var Refused = class extends Error {};\nfunction a() { throw new Refused(\"b_c\"); }\n// new Refused(\"dead\")\nthrow new Refused('a');\n"),
    ["b_c", "a"]);
  assert.throws(() => bundled("var Refused2 = class extends Error {};\nthrow new Refused2(\"hidden\");\n"), refusedVocabulary("VOCABULARY_PROBE_RENAMED"));
  assert.throws(() => bundled("throw new Refused(reason);\n"), refusedVocabulary("VOCABULARY_REASON_NOT_LITERAL"));
  assert.deepEqual(Object.keys(REFUSAL_CLASSES).sort(), ["cache", "shared"]);
  assert.deepEqual(REFUSAL_CLASSES.cache, { className: "CacheRetentionRefusedError", definingPath: "apps/worker/src/cache-retention-values.ts" });
  assert.deepEqual(REFUSAL_CLASSES.shared, { className: "SharedAnalyticsUnavailable", definingPath: "apps/worker/src/analytics-shared-reducers.ts" });
});

test("interface members are read in declaration order, and a member the rule cannot read refuses", () => {
  const members = (text) => interfaceMembers({ text, path: "x.ts", name: "C", maskNonCode });
  assert.deepEqual(members("export interface C {\n  readonly band: Id;\n  /** a { brace } in a comment */\n  readonly a: number;\n  b?: number;\n\n}\n"), ["band", "a", "b"]);
  for (const bad of [
    "interface C {\n  a(): number;\n}\n",
    "interface C {\n  a: { b: number };\n}\n",
    "interface C {\n  a: number | null;\n}\n",
    "interface C {\n  [key: string]: number;\n}\n",
    "interface C {\n  a: number;\n}\ninterface C {\n  b: number;\n}\n",
    "interface D {\n  a: number;\n}\n",
    "interface C {\n}\n",
  ]) assert.throws(() => members(bad), refusedVocabulary("VOCABULARY_SOURCE_CHANGED"), bad);
});

test("the community daily read version is the one schemaVersion literal of the Worker entry", () => {
  const version = (text) => communityDailyReadSchemaVersion({ text, path: "apps/worker/src/index.ts" });
  assert.equal(version("return json({\n  schemaVersion: \"community-daily-read-v1.0\",\n});\n"), "community-daily-read-v1.0");
  assert.equal(version("a({ schemaVersion: 'community-daily-read-v2.13' }); b({ schemaVersion: \"community-daily-read-v2.13\" });"), "community-daily-read-v2.13");
  for (const bad of [
    "a({ schemaVersion: \"community-daily-read-v1.0\" }); b({ schemaVersion: \"community-daily-read-v1.1\" });",
    "a({ schemaVersion: \"community-daily-read-v1.0\" }); const legacy = \"community-daily-read-v0.9\";",
    "a({ schemaVersion: \"community-daily-read-v1\" });",
    "a({ schemaVersion: \"community-daily-v1.0\" });",
  ]) assert.throws(() => version(bad), refusedVocabulary("VOCABULARY_SOURCE_CHANGED"), bad);
});

test("a kernel change to any vocabulary changes the derivation, and a change the rules cannot follow refuses", async () => {
  await withScratchAsync(async (dir) => {
    const index = workerIndexAt(WORKER_ROOT, CURRENT);
    const committed = readFileSync(CURRENT_LAYOUT.vocabularyPath, "utf8");
    /** A copy of the committed vendor tree, changed by `edit(path => text, (path, text) => void)`, then derived. */
    const derive = async (edit, workerIndexText = index) => {
      const out = join(dir, `case-${Math.random().toString(16).slice(2)}`);
      const layout = vendorLayout({ commit: CURRENT, outRoot: out });
      cpSync(CURRENT_LAYOUT.vendorRoot, layout.vendorRoot, { recursive: true });
      const read = (path) => readFileSync(join(layout.vendorRoot, path), "utf8");
      edit?.(read, (path, text) => writeFileSync(join(layout.vendorRoot, path), text));
      return vocabulariesOfTree({ layout, manifest: RECORDED, workerIndexText });
    };
    const reducers = "apps/worker/src/analytics-shared-reducers.ts";
    const cache = "apps/worker/src/cache-retention-values.ts";
    const events = "apps/worker/src/cache-retention-events.ts";
    const day = "apps/worker/src/cache-retention-day.ts";
    /** `text` with `from` replaced once; `from` must be there, so a moved anchor fails here rather than testing nothing. */
    const swap = (text, from, to) => {
      assert.ok(text.includes(from), `anchor not found: ${from}`);
      return text.replace(from, to);
    };

    // Unchanged files give the committed module.
    assert.equal(renderKernelVocabularies(await derive()), committed);
    // A new reason in the kernel is a new reason in the vocabulary, and the
    // difference names the one block a reviewer must port.
    const added = await derive((read, write) => write(reducers,
      `${read(reducers)}\nexport function probeOnly(): never { throw new SharedAnalyticsUnavailable('brand_new_reason'); }\n`));
    assert.equal(added.sharedAnalyticsRefusalReasons.at(-1), "brand_new_reason");
    assert.deepEqual(changedVocabularies(committed, renderKernelVocabularies(added)), ["KERNEL_SHARED_ANALYTICS_REFUSAL_REASONS"]);
    // The cache family's reducer and band shape.
    const band = await derive((read, write) => write(cache, read(cache)
      .replace("\"over_twenty_four_hours\" as const", "\"over_one_day\" as const")));
    assert.equal(band.cacheRetentionBandIds.at(-1), "over_one_day");
    assert.deepEqual(changedVocabularies(committed, renderKernelVocabularies(band)), ["KERNEL_CACHE_RETENTION_BAND_IDS"]);
    const dates = await derive((read, write) => write("apps/worker/src/admin-community-allowance.ts",
      read("apps/worker/src/admin-community-allowance.ts").replace(/export const ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS =\n\s*COMMUNITY_ALLOWANCE_RECONSTRUCTABLE_DAYS;/,
        "export const ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS =\n  COMMUNITY_ALLOWANCE_RECONSTRUCTABLE_DAYS + 7;")));
    assert.equal(dates.modelDates, 77);
    assert.deepEqual(changedVocabularies(committed, renderKernelVocabularies(dates)), ["KERNEL_MODEL_DATES"]);
    const version = await derive(undefined, index.replace("community-daily-read-v1.0", "community-daily-read-v1.1"));
    assert.deepEqual(changedVocabularies(committed, renderKernelVocabularies(version)), ["KERNEL_COMMUNITY_DAILY_READ_SCHEMA_VERSION"]);

    // The cache family is every construction the facade reaches, however many
    // modules away: a helper in another module that reduceCacheRetentionDay
    // calls adds its reason ...
    const transitive = await derive((read, write) => {
      write(events, `${swap(read(events),
        "import { validCacheRetentionToken, type CacheRetentionItem } from './cache-retention-values';",
        "import { CacheRetentionRefusedError, validCacheRetentionToken, type CacheRetentionItem } from './cache-retention-values';")}
export function probeTransitiveRefusal(): never { throw new CacheRetentionRefusedError("transitive_reason"); }\n`);
      write(cache, `import { probeTransitiveRefusal } from "./cache-retention-events";\n${swap(read(cache),
        "  const dayEndMs = dayStartMs + 86_400_000;\n  const previous = new Map<string, CacheRetentionEvent>();",
        "  if (eventsRead > 1_000_000_000_000) probeTransitiveRefusal();\n  const dayEndMs = dayStartMs + 86_400_000;\n  const previous = new Map<string, CacheRetentionEvent>();")}`);
    });
    assert.deepEqual(transitive.cacheRetentionRefusalReasons, ["transitive_reason", "session_limit_exceeded", "group_limit_exceeded"]);
    assert.deepEqual(changedVocabularies(committed, renderKernelVocabularies(transitive)), ["KERNEL_CACHE_RETENTION_REFUSAL_REASONS"]);
    // ... and so does a D1 day lane once the facade exposes it ...
    const exposed = await derive((read, write) => write("entry.ts", swap(read("entry.ts"),
      "export { cacheRetentionEventFromRecord, cacheRetentionSessionDigest } from",
      "export { cacheRetentionEventFromRecord, cacheRetentionSessionDigest, createCacheRetentionDayReader } from")));
    for (const reason of ["day_page_limit_exceeded", "usage_row_refused", "session_limit_exceeded", "group_limit_exceeded"]) {
      assert.ok(exposed.cacheRetentionRefusalReasons.includes(reason), reason);
    }
    assert.deepEqual(changedVocabularies(committed, renderKernelVocabularies(exposed)), ["KERNEL_CACHE_RETENTION_REFUSAL_REASONS"]);
    // ... while a construction nothing reachable calls is left out.
    const dead = await derive((read, write) => write(cache,
      `${read(cache)}\nfunction unreachableProbe(): never { throw new CacheRetentionRefusedError("dead_reason"); }\n`));
    assert.equal(renderKernelVocabularies(dead), committed);

    // Refusals: a dynamic reason, a refusal class reached under another name, a
    // counter the reducer does not emit, and a Worker entry with no single read version.
    await assert.rejects(derive((read, write) => write(reducers,
      `${read(reducers)}\nexport function probeOnly(reason: string): never { throw new SharedAnalyticsUnavailable(reason); }\n`)),
    refusedVocabulary("VOCABULARY_REASON_NOT_LITERAL"));
    await assert.rejects(derive((read, write) => write(day, swap(read(day),
      "  CacheRetentionRefusedError,\n  applyCacheRetentionReducerCarryPage,", "  CacheRetentionRefusedError as DayRefused,\n  applyCacheRetentionReducerCarryPage,"))),
    refusedVocabulary("VOCABULARY_REFUSAL_CLASS_ALIASED"));
    await assert.rejects(derive((read, write) => write(reducers,
      `${read(reducers)}\nconst Unavailable = SharedAnalyticsUnavailable;\nexport function probeOnly(): never { throw new Unavailable('local_alias'); }\n`)),
    refusedVocabulary("VOCABULARY_REFUSAL_CLASS_ALIASED"));
    // A construction in the bundle that no vendored source scan read (here, in
    // the facade itself, under an alias the bundler resolves) refuses too.
    await assert.rejects(derive((read, write) => write("entry.ts", `${read("entry.ts")}
import { CacheRetentionRefusedError as FacadeRefused } from "./apps/worker/src/cache-retention-values";
export function probeFacade(): never { throw new FacadeRefused("facade_reason"); }\n`)),
    refusedVocabulary("VOCABULARY_PROBE_DISAGREES"));
    await assert.rejects(derive((read, write) => write(cache, read(cache).replace(
      "  readonly excludedContextContracted: number;\n  readonly sessions: number;",
      "  readonly excludedContextContracted: number;\n  readonly excludedOther: number;\n  readonly sessions: number;"))),
    refusedVocabulary("VOCABULARY_COUNTERS_DISAGREE"));
    await assert.rejects(derive(undefined, index.replaceAll("community-daily-read-v1.0", "community-daily-read-v1")),
      refusedVocabulary("VOCABULARY_SOURCE_CHANGED"));
    await assert.rejects(derive(undefined, null), refusedVocabulary("VOCABULARY_SOURCE_MISSING"));
  });
});

test("the rendered module is deterministic and names its schema and commit", async () => {
  const derived = await vocabulariesOfTree({ layout: CURRENT_LAYOUT, manifest: RECORDED, workerIndexText: workerIndexAt(WORKER_ROOT, CURRENT) });
  const text = renderKernelVocabularies(derived);
  assert.equal(renderKernelVocabularies(JSON.parse(JSON.stringify(derived))), text);
  assert.ok(text.startsWith("// GENERATED FILE. Do not edit by hand.\n"));
  assert.ok(text.includes(`// Schema: ${VOCABULARY_SCHEMA}.`));
  assert.ok(text.includes(`export const KERNEL_VOCABULARIES_SOURCE_COMMIT = "${CURRENT}" as const;`));
  assert.ok(text.endsWith("\n") && !text.includes("\n\n\n") && !/[ \t]$/m.test(text));
  assert.throws(() => renderKernelVocabularies({ ...derived, schemaVersion: "other" }), refusedVocabulary("VOCABULARY_SCHEMA_UNKNOWN"));
});
