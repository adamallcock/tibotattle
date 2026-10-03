/**
 * K-STAMP: src/analytics-v2/kernel-registry.json is append-only and names the
 * code the build bundles.
 *
 * - Every entry is pinned here by the sha256 of its canonical JSON
 *   (REGISTRY_PINS): editing or removing an entry fails; appending one needs
 *   its pin added in the same change, which a reviewer sees.
 * - The newest entry names the current build: `node cloud-run/build.mjs
 *   --kernel-closure` reports the bundle's kernel identity (the compute-closure
 *   digest and the vendored manifest digest it stamps through esbuild
 *   defines), and some entry must name it, or the Job would refuse every run
 *   with ANALYTICS_V2_KERNEL_UNREGISTERED. A change to any module of the
 *   compute closure (comments included) therefore needs a new entry before it
 *   merges; the failure lists every closure input.
 * - The build itself refuses an identity no entry names
 *   (CLOUD_RUN_BUILD_KERNEL_UNREGISTERED, through the Job's own resolver), so
 *   the image build fails instead of deploying a Job that refuses every run;
 *   `--check` and the default build report the entry's id.
 * - The closure holds every module that decides a stored value (the compute
 *   core, the community fold, the readers and their codecs) and none of the
 *   I/O plumbing, and a change to the community fold or the occurrence
 *   reader is a closure no entry names.
 * - Each entry's production commit and price registry agree with the
 *   vendored kernels it names (MANIFEST.json, price-registry.js).
 * - The run-stamps migration seeds no kernel row: a kernel is registered
 *   by the run that first stamps with it, and the rows written before the
 *   migration keep no kernel (unattributed, never inferred).
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  ANALYTICS_KERNEL_CLOSURE_PLUMBING,
  ANALYTICS_KERNEL_FACADE_COMMIT_MASK,
  analyticsKernelFacadeComputeText,
  computeAnalyticsKernelIdentity,
  resolveAnalyticsKernelRegistryEntry,
} from "../cloud-run/analytics-kernel-closure.mjs";

const execFileAsync = promisify(execFile);
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_PATH = join(WORKER_ROOT, "src", "analytics-v2", "kernel-registry.json");
const VENDOR_ROOT = join(WORKER_ROOT, "vendor", "analytics-d43c8f92");
/** sha256 of each entry's canonical JSON, in id order. Append only. */
const REGISTRY_PINS = Object.freeze([
  "3de37fc69519e9db59e6d8c81a6920547e4292b6e0f493c8f4df6f68c4f21a8a",
  // Kernel 2: K-VENDOR2's export patch of buildPricingEvent and the entry
  // facade's pricing re-exports, met with K-CORE-A at the PROD-PREP merge.
  "f45bc8e89f659bcecfab40c37b81ae130de36ceff7831f0cc0b057328421daef",
  // Kernel 3: K-PERCARD's prepared-day price observer (price-attribution.ts in
  // compute-owner.ts, the ownerDayPrices output) and the transition proof
  // (price-transition.ts, a closure root). Daily, fit and model values are
  // unchanged; the price rows are new stored values. (Re-derived on the
  // K-PERCARD branch before any merge or durable stamped run, when its review
  // fixes changed price-transition.ts.)
  "c18c6dd6017885fcfaddf7df87ce6c80162737039f00dd208c4e83f4fed66f6f",
  // Kernel 4: the fast-path final line's merged closure. K-PERCARD's price
  // inputs (kernel 3) met E-OWNERSET's owner-set reader (owner-sets.ts, a
  // closure root) and its orchestration method analytics-v2-method-v2 at the
  // 733e143c merge.
  "5140704aab3e55affbbb63da08a043615f119936c093cae25afc4b7d6e9c53c6",
  // Kernel 5: EXCL-UNLINKED (owner decision round 19): an active exclusion
  // covering day D lifts an unlinked typed participant's block of D
  // (analytics-refresh-read.mjs, through owners.ts's re-export of
  // exclusions.ts's predicate). Values are unchanged; which days publish
  // changes only while such a participant exists. Side branches of the same
  // base also append a kernel 5: the integrator renumbers and re-derives.
  "1fa5ff30e17a11d79d4fc50648b8febcd31730676a1b285f678ffc6f5233a851",
]);
const ENTRY_KEYS = ["computeClosureSha256", "kernelId", "methodVersion", "priceRegistrySha256", "priceRegistryVersion",
  "productionCommit", "vendorManifestSha256"];
/** cloud-run/build.mjs's options, as far as they decide the refresh bundles' import graph. */
const BUILD_OPTIONS = Object.freeze({ bundle: true, platform: "node", format: "esm", target: "node22",
  external: ["@google-cloud/cloud-sql-connector", "google-auth-library", "jsonc-parser", "pg"], logLevel: "silent" });

const canonical = (entry) => JSON.stringify(Object.fromEntries(ENTRY_KEYS.map((key) => [key, entry[key]])));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function registry() {
  return JSON.parse(await readFile(REGISTRY_PATH, "utf8"));
}

async function buildReport(flag) {
  const { stdout } = await execFileAsync(process.execPath, [join(WORKER_ROOT, "cloud-run", "build.mjs"), flag],
    { cwd: join(WORKER_ROOT, "cloud-run"), maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

const esbuild = () => createRequire(join(WORKER_ROOT, "cloud-run", "package.json"))("esbuild");

/** The closure identity under the build's own esbuild, with `read` substituted (a mutation). */
async function identityWith(read) {
  return computeAnalyticsKernelIdentity({ build: esbuild().build, options: BUILD_OPTIONS, vendorRoot: VENDOR_ROOT,
    cwd: join(WORKER_ROOT, "cloud-run"), ...(read === undefined ? {} : { read }) });
}

/** The registry entry the build resolves for `identity` (the build's own check). */
function entryFor(identity) {
  return resolveAnalyticsKernelRegistryEntry({ build: esbuild().build, options: BUILD_OPTIONS, identity,
    cwd: join(WORKER_ROOT, "cloud-run") });
}

/** The orchestration method the code declares (src/analytics-v2/kernel.ts ANALYTICS_V2_METHOD_VERSION). */
const METHOD_VERSION = (await readFile(join(WORKER_ROOT, "src", "analytics-v2", "kernel.ts"), "utf8"))
  .match(/export const ANALYTICS_V2_METHOD_VERSION = "(analytics-v2-method-v[1-9][0-9]{0,5})" as const;/u)?.[1];
assert.ok(METHOD_VERSION !== undefined, "kernel.ts declares ANALYTICS_V2_METHOD_VERSION");

const named = (entries, identity) => entries.filter((entry) => entry.computeClosureSha256 === identity.computeClosureSha256
  && entry.vendorManifestSha256 === identity.vendorManifestSha256 && entry.methodVersion === METHOD_VERSION);

test("the registry is closed, numbered 1..n and pinned entry by entry (append-only)", async () => {
  const value = await registry();
  assert.deepEqual(Object.keys(value).sort(), ["kernels", "rule", "schemaVersion"]);
  assert.equal(value.schemaVersion, "analytics-v2-kernel-registry-v1");
  assert.ok(Array.isArray(value.kernels) && value.kernels.length >= 1);
  assert.equal(value.kernels.length, REGISTRY_PINS.length,
    "every entry is pinned: append the new entry's pin with the entry");
  const identities = new Set();
  for (const [index, entry] of value.kernels.entries()) {
    assert.deepEqual(Object.keys(entry).sort(), ENTRY_KEYS);
    assert.equal(entry.kernelId, index + 1);
    assert.ok(entry.kernelId <= 32_767, "kernel_id is a PostgreSQL smallint");
    assert.match(entry.productionCommit, /^[0-9a-f]{40}$/u);
    for (const key of ["vendorManifestSha256", "computeClosureSha256", "priceRegistrySha256"]) {
      assert.match(entry[key], /^[0-9a-f]{64}$/u, key);
    }
    assert.match(entry.priceRegistryVersion, /^[A-Za-z0-9._:-]{1,64}$/u);
    assert.match(entry.methodVersion, /^analytics-v2-method-v[1-9][0-9]{0,5}$/u);
    assert.equal(sha256(canonical(entry)), REGISTRY_PINS[index], `entry ${entry.kernelId} was edited`);
    const identity = `${entry.vendorManifestSha256}:${entry.computeClosureSha256}:${entry.methodVersion}`;
    assert.equal(identities.has(identity), false, "two entries name the same code");
    identities.add(identity);
  }
});

test("an entry names the code this checkout builds, and its vendored kernels", async () => {
  const value = await registry();
  const report = await buildReport("--kernel-closure");
  assert.equal(report.status, "ok");
  assert.match(report.kernel.computeClosureSha256, /^[0-9a-f]{64}$/u);
  assert.ok(report.kernel.closureInputs > 50, "the closure holds the vendored kernels");
  const current = named(value.kernels, report.kernel);
  if (current.length !== 1) {
    assert.fail(`no kernel-registry.json entry names this build's compute closure ${report.kernel.computeClosureSha256}`
      + ` (${report.names.length} inputs): append one with its pin. The closure:\n${report.names.join("\n")}`);
  }
  assert.equal(current[0].kernelId, value.kernels.length, "the build is the newest kernel");
  // The build resolves the same entry through the Job's resolver and reports it.
  const checked = await buildReport("--check");
  assert.deepEqual(checked.kernel, { ...report.kernel, kernelId: current[0].kernelId });
  const manifestBytes = await readFile(join(VENDOR_ROOT, "MANIFEST.json"));
  assert.equal(sha256(manifestBytes), report.kernel.vendorManifestSha256);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const prices = await import(pathToFileURL(join(VENDOR_ROOT, "packages", "accounting", "src", "price-registry.js")).href);
  assert.equal(current[0].productionCommit, manifest.sourceCommit);
  assert.equal(current[0].priceRegistrySha256, prices.APP_PRICE_REGISTRY_SHA256);
  assert.equal(current[0].priceRegistryVersion, prices.APP_PRICE_REGISTRY_VERSION);
});

test("the closure holds every module that decides a stored value and no I/O plumbing", async () => {
  const report = await buildReport("--kernel-closure");
  const identity = await identityWith();
  // The check computes the build's own identity (same graph, same names).
  assert.equal(identity.computeClosureSha256, report.kernel.computeClosureSha256);
  assert.deepEqual([...identity.names], report.names);
  const names = new Set(report.names);
  for (const decides of [
    "apps/worker/src/analytics-v2/compute.ts", "apps/worker/src/analytics-v2/compute-owner.ts",
    "apps/worker/src/analytics-v2/compute-community.ts", "apps/worker/src/analytics-v2/native-path.ts",
    "apps/worker/src/analytics-v2/occurrence-source.ts", "apps/worker/src/analytics-v2/owners.ts",
    "apps/worker/src/analytics-v2/devices.ts", "apps/worker/src/analytics-v2/queued-days.ts",
    "apps/worker/src/analytics-v2/owner-sets.ts",
    "apps/worker/src/telemetry-usage-reconciliation.ts", "apps/worker/src/typed-telemetry-codec.ts",
    "apps/worker/src/telemetry-v12-typed-codec.ts", "apps/worker/cloud-run/analytics-refresh-read.mjs",
    "apps/worker/cloud-run/analytics-refresh-worker.mjs", "packages/telemetry-contract/index.js",
    // K-PERCARD: the price attribution decides analytics_v2_owner_day_price, the transition proof the stale sets.
    "apps/worker/src/analytics-v2/price-attribution.ts", "apps/worker/src/analytics-v2/price-transition.ts",
  ]) {
    assert.ok(names.has(decides), `${decides} decides stored values and is in the closure`);
  }
  assert.ok(report.names.some((name) => name.startsWith("apps/worker/vendor/analytics-d43c8f92/")));
  for (const plumbing of ANALYTICS_KERNEL_CLOSURE_PLUMBING) {
    assert.equal(names.has(plumbing), false, `${plumbing} is I/O plumbing`);
  }
  // Names never carry where an install put a module.
  assert.equal(report.names.some((name) => name.includes("node_modules")), false);
});

test("a change to the community fold, the occurrence reader or the owner-set reader is a closure no entry names, and the build refuses it", async () => {
  const value = await registry();
  for (const module of ["compute-community.ts", "occurrence-source.ts", "owners.ts", "owner-sets.ts"]) {
    const target = join(WORKER_ROOT, "src", "analytics-v2", module);
    const mutated = await identityWith(async (path, ...rest) => {
      const bytes = await readFile(path, ...rest);
      // One comment line appended: no behaviour changes, the class does.
      return path === target ? Buffer.concat([Buffer.from(bytes), Buffer.from("\n// mutation\n")]) : bytes;
    });
    assert.equal(named(value.kernels, mutated).length, 0, `${module} changed without a registry entry`);
    // The build's own check refuses it, naming the digests (an image build fails here).
    await assert.rejects(entryFor(mutated), { code: "CLOUD_RUN_BUILD_KERNEL_UNREGISTERED",
      computeClosureSha256: mutated.computeClosureSha256, vendorManifestSha256: mutated.vendorManifestSha256 });
  }
  // The unmutated identity resolves to the newest entry; a changed vendored
  // manifest alone is refused too.
  const identity = await identityWith();
  assert.equal((await entryFor(identity)).kernelId, value.kernels.length);
  await assert.rejects(entryFor({ ...identity, vendorManifestSha256: "0".repeat(64) }),
    { code: "CLOUD_RUN_BUILD_KERNEL_UNREGISTERED" });
  // A stale workspace package copy is refused rather than hashed.
  const copy = `${sep}node_modules${sep}@app-usagemonitor${sep}telemetry-contract${sep}index.js`;
  await assert.rejects(identityWith(async (path, ...rest) => {
    const bytes = await readFile(path, ...rest);
    return path.endsWith(copy) ? Buffer.concat([Buffer.from(bytes), Buffer.from("\n")]) : bytes;
  }), { code: "ANALYTICS_KERNEL_CLOSURE_WORKSPACE_COPY_STALE" });
});

const MANIFEST_FILE = join(VENDOR_ROOT, "MANIFEST.json");
const FACADE_FILE = join(VENDOR_ROOT, "entry.ts");
const PRICE_REGISTRY_FILE = join(VENDOR_ROOT, "packages", "accounting", "src", "price-registry.js");
/** A synthetic next production commit (40 hex digits), for re-vendor-shaped fixtures. */
const NEXT_COMMIT = createHash("sha1").update("analytics-v2-kernel-registry-check:next-commit").digest("hex");

/**
 * The identity of a re-vendor-shaped fixture, as scripts/vendor-analytics-kernels.mjs
 * would leave the vendored directory for `commit`: MANIFEST.json names it,
 * the reviewed facade's provenance text names it (the workflow refuses a
 * facade that names another), and `files` rewrites other vendored files'
 * text (path to function). `facade` edits the facade after that.
 */
async function revendoredIdentity({ commit, facade = (text) => text, files = {} }) {
  const current = JSON.parse(await readFile(MANIFEST_FILE, "utf8")).sourceCommit;
  return identityWith(async (path, ...rest) => {
    const bytes = await readFile(path, ...rest);
    const text = () => Buffer.from(bytes).toString("utf8");
    if (path === MANIFEST_FILE) {
      return Buffer.from(`${JSON.stringify({ ...JSON.parse(text()), sourceCommit: commit }, null, 2)}\n`, "utf8");
    }
    if (path === FACADE_FILE) {
      assert.ok(text().includes(current.slice(0, 8)), "the facade names its vendored commit");
      return Buffer.from(facade(text().replaceAll(current.slice(0, 8), commit.slice(0, 8))), "utf8");
    }
    return Object.hasOwn(files, path) ? Buffer.from(files[path](text()), "utf8") : bytes;
  });
}

test("the compute class is the closure without the vendored price registry and the facade's provenance commit (K-PERCARD)", async () => {
  const identity = await identityWith();
  const report = await buildReport("--kernel-closure");
  assert.match(identity.computeSha256, /^[0-9a-f]{64}$/u);
  assert.notEqual(identity.computeSha256, identity.computeClosureSha256);
  // The build stamps the same class it reports.
  assert.equal(report.kernel.computeSha256, identity.computeSha256);
  const prices = await import(pathToFileURL(PRICE_REGISTRY_FILE).href);
  const current = JSON.parse(await readFile(MANIFEST_FILE, "utf8")).sourceCommit;
  // A price change arrives only by re-vendoring a new production commit: a
  // new manifest, a facade whose provenance names the new commit, and here
  // only the price registry's content changed (its cards and digest). It is
  // a new kernel (closure and manifest move) with the same compute class, so
  // its transition can be compatible once the proof over the stored price
  // inputs holds.
  const repriced = await revendoredIdentity({ commit: NEXT_COMMIT, files: { [PRICE_REGISTRY_FILE]: (text) =>
    text.replace(prices.APP_PRICE_REGISTRY_SHA256, sha256("analytics-v2-kernel-registry-check:next-registry")) } });
  assert.notEqual(repriced.computeClosureSha256, identity.computeClosureSha256);
  assert.notEqual(repriced.vendorManifestSha256, identity.vendorManifestSha256);
  assert.equal(repriced.computeSha256, identity.computeSha256);
  // Re-vendoring alone (the same files from another commit) keeps the class too.
  const moved = await revendoredIdentity({ commit: NEXT_COMMIT });
  assert.notEqual(moved.computeClosureSha256, identity.computeClosureSha256);
  assert.equal(moved.computeSha256, identity.computeSha256);
  // Only the manifest's commit, named in a facade comment, is masked:
  // - a facade that still names the old commit (the workflow refuses it) is another class;
  const unreviewed = await revendoredIdentity({ commit: NEXT_COMMIT,
    facade: (text) => text.replaceAll(NEXT_COMMIT.slice(0, 8), current.slice(0, 8)) });
  assert.notEqual(unreviewed.computeSha256, identity.computeSha256);
  // - any other edit of the facade's text, comments included, is another class;
  const reworded = await revendoredIdentity({ commit: NEXT_COMMIT,
    facade: (text) => text.replace("The one import surface", "The single import surface") });
  assert.notEqual(reworded.computeSha256, identity.computeSha256);
  // - the commit named in code is not masked.
  const inCode = (commit) => revendoredIdentity({ commit,
    facade: (text) => `${text}export const VENDORED_SOURCE_COMMIT = "${commit.slice(0, 8)}";\n` });
  assert.notEqual((await inCode(NEXT_COMMIT)).computeSha256, (await inCode(current)).computeSha256);
  // Any other change to the closure (the pricer, the attribution, the compute core) moves the class too.
  const mutatedAt = (target) => identityWith(async (path, ...rest) => {
    const bytes = await readFile(path, ...rest);
    return path === target ? Buffer.concat([Buffer.from(bytes), Buffer.from("\n// mutation\n")]) : bytes;
  });
  for (const target of [join(VENDOR_ROOT, "apps", "worker", "src", "server-pricing.ts"),
    join(WORKER_ROOT, "src", "analytics-v2", "price-attribution.ts"), join(WORKER_ROOT, "src", "analytics-v2", "compute-owner.ts")]) {
    const mutated = await mutatedAt(target);
    assert.notEqual(mutated.computeClosureSha256, identity.computeClosureSha256, target);
    assert.notEqual(mutated.computeSha256, identity.computeSha256, target);
  }
});

test("the facade's compute text masks only the vendored commit, only in line comments", () => {
  const commit = NEXT_COMMIT;
  const text = [
    `// a byte copy of commit ${commit.slice(0, 8)} (${commit.slice(0, 12).toUpperCase()}, ${commit})`,
    `  // indented: ${commit.slice(0, 7)}; too short: ${commit.slice(0, 6)}; another: ${"f".repeat(8)}`,
    `export const SOURCE = "${commit.slice(0, 8)}"; // ${commit.slice(0, 8)}`,
  ].join("\n");
  const mask = ANALYTICS_KERNEL_FACADE_COMMIT_MASK;
  assert.equal(analyticsKernelFacadeComputeText(text, commit), [
    `// a byte copy of commit ${mask} (${mask}, ${mask})`,
    `  // indented: ${mask}; too short: ${commit.slice(0, 6)}; another: ${"f".repeat(8)}`,
    `export const SOURCE = "${commit.slice(0, 8)}"; // ${commit.slice(0, 8)}`,
  ].join("\n"));
  for (const invalid of [commit.slice(0, 39), commit.toUpperCase(), null]) {
    assert.throws(() => analyticsKernelFacadeComputeText(text, invalid), { code: "ANALYTICS_KERNEL_CLOSURE_FACADE_INVALID" });
  }
});

test("the closure refuses a kernel set without its price registry, or with an unreadable manifest or facade", async () => {
  // esbuild's own graph, with one vendored module taken out of it.
  const without = (target) => async (options) => {
    const result = await esbuild().build(options);
    const cwd = options.absWorkingDir;
    for (const [path, input] of Object.entries(result.metafile.inputs)) {
      if (resolve(cwd, path) === target) delete result.metafile.inputs[path];
      else input.imports = (input.imports ?? []).filter((imported) => imported.external || resolve(cwd, imported.path) !== target);
    }
    return result;
  };
  const identity = (build, read) => computeAnalyticsKernelIdentity({ build, options: BUILD_OPTIONS, vendorRoot: VENDOR_ROOT,
    cwd: join(WORKER_ROOT, "cloud-run"), ...(read === undefined ? {} : { read }) });
  // The price registry outside the closure would put the cards into the compute class.
  await assert.rejects(identity(without(PRICE_REGISTRY_FILE)), { code: "ANALYTICS_KERNEL_CLOSURE_PRICE_REGISTRY_MISSING" });
  // Every vendored module is reached through the facade, so a closure
  // without it has no kernels at all (ANALYTICS_KERNEL_CLOSURE_FACADE_MISSING
  // guards a graph that reaches them some other way).
  await assert.rejects(identity(without(FACADE_FILE)), { code: "ANALYTICS_KERNEL_CLOSURE_KERNELS_MISSING" });
  // The facade's provenance commit comes from the manifest: no commit, no class.
  for (const manifest of ["{", JSON.stringify({ sourceCommit: NEXT_COMMIT.slice(0, 12) }), JSON.stringify({})]) {
    await assert.rejects(identity(esbuild().build, async (path, ...rest) => (path === MANIFEST_FILE
      ? Buffer.from(manifest, "utf8") : readFile(path, ...rest))), { code: "ANALYTICS_KERNEL_CLOSURE_MANIFEST_INVALID" });
  }
  // A facade that is not text the mask can see in full is refused, not masked.
  await assert.rejects(identity(esbuild().build, async (path, ...rest) => (path === FACADE_FILE
    ? Buffer.concat([await readFile(path), Buffer.from([0xff, 0x0a])]) : readFile(path, ...rest))),
  { code: "ANALYTICS_KERNEL_CLOSURE_FACADE_INVALID" });
});

test("the run-stamps migration seeds no kernel and leaves earlier rows unattributed", async () => {
  const directory = join(WORKER_ROOT, "postgres", "staged-migrations", "primary");
  const promoted = join(WORKER_ROOT, "postgres", "migrations", "primary");
  const find = async (root) => (await readdir(root).catch(() => [])).find((name) => /^\d{4}_analytics_v2_run_stamps\.sql$/u.test(name));
  const staged = await find(directory);
  const name = staged ?? await find(promoted);
  assert.ok(name, "the run-stamps migration is staged or promoted");
  const sql = await readFile(join(staged ? directory : promoted, name), "utf8");
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+analytics_v2_kernels/iu, "kernels are registered by the run that stamps with them");
  assert.doesNotMatch(sql, /kernel_id\s+smallint\s+NOT\s+NULL\s+DEFAULT/iu, "no row is given a kernel it was not written by");
});
