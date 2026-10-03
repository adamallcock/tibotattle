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
  // Kernel 3: REFRESH-OPT's two vendored source patches (usage-row-evidence-
  // memo, daily-fold-trusted-state) and its read and native-path changes; the
  // same outputs, digest for digest, as kernel 2.
  "712f8bd8d777ac04077c6c76ad1dd4aa012f576c279974c0304ccf302bfc6773",
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

const named = (entries, identity) => entries.filter((entry) => entry.computeClosureSha256 === identity.computeClosureSha256
  && entry.vendorManifestSha256 === identity.vendorManifestSha256 && entry.methodVersion === "analytics-v2-method-v1");

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
    "apps/worker/src/telemetry-usage-reconciliation.ts", "apps/worker/src/typed-telemetry-codec.ts",
    "apps/worker/src/telemetry-v12-typed-codec.ts", "apps/worker/cloud-run/analytics-refresh-read.mjs",
    "apps/worker/cloud-run/analytics-refresh-worker.mjs", "packages/telemetry-contract/index.js",
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

test("a change to the community fold or the occurrence reader is a closure no entry names, and the build refuses it", async () => {
  const value = await registry();
  for (const module of ["compute-community.ts", "occurrence-source.ts", "owners.ts"]) {
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
