/**
 * K-STAMP: src/analytics-v2/kernel-registry.json is append-only, names the
 * code the build bundles, and agrees with the staged migration's seed row.
 *
 * - Every entry is pinned here by the sha256 of its canonical JSON
 *   (REGISTRY_PINS): editing or removing an entry fails; appending one needs
 *   its pin added in the same change, which a reviewer sees.
 * - The newest entry names the current build: `node cloud-run/build.mjs
 *   --check` reports the bundle's kernel identity (the compute-closure digest
 *   and the vendored manifest digest it stamps through esbuild defines), and
 *   some entry must name it, or the Job would refuse every run with
 *   ANALYTICS_V2_KERNEL_UNREGISTERED. A change to any file of the compute
 *   closure (comments included) therefore needs a new entry before it merges.
 * - Each entry's production commit and price registry agree with the
 *   vendored kernels it names (MANIFEST.json, price-registry.js).
 * - The staged migration seeds exactly entry 1.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_PATH = join(WORKER_ROOT, "src", "analytics-v2", "kernel-registry.json");
const VENDOR_ROOT = join(WORKER_ROOT, "vendor", "analytics-d43c8f92");
/** sha256 of each entry's canonical JSON, in id order. Append only. */
const REGISTRY_PINS = Object.freeze([
  "f79d5e1240c54cbfc45349388d00c560c5a240870ac9af951afa03a395b5fe01",
]);
const ENTRY_KEYS = ["computeClosureSha256", "kernelId", "methodVersion", "priceRegistrySha256", "priceRegistryVersion",
  "productionCommit", "vendorManifestSha256"];

const canonical = (entry) => JSON.stringify(Object.fromEntries(ENTRY_KEYS.map((key) => [key, entry[key]])));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function registry() {
  return JSON.parse(await readFile(REGISTRY_PATH, "utf8"));
}

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
  const { stdout } = await execFileAsync(process.execPath, [join(WORKER_ROOT, "cloud-run", "build.mjs"), "--check"],
    { cwd: join(WORKER_ROOT, "cloud-run"), maxBuffer: 4 * 1024 * 1024 });
  const report = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(report.status, "ok");
  assert.match(report.kernel.computeClosureSha256, /^[0-9a-f]{64}$/u);
  assert.ok(report.kernel.closureInputs > 50, "the closure holds the vendored kernels");
  const current = value.kernels.filter((entry) => entry.computeClosureSha256 === report.kernel.computeClosureSha256
    && entry.vendorManifestSha256 === report.kernel.vendorManifestSha256
    && entry.methodVersion === "analytics-v2-method-v1");
  assert.equal(current.length, 1,
    `no kernel-registry.json entry names this build's compute closure ${report.kernel.computeClosureSha256}: append one`);
  assert.equal(current[0].kernelId, value.kernels.length, "the build is the newest kernel");
  const manifestBytes = await readFile(join(VENDOR_ROOT, "MANIFEST.json"));
  assert.equal(sha256(manifestBytes), report.kernel.vendorManifestSha256);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const prices = await import(pathToFileURL(join(VENDOR_ROOT, "packages", "accounting", "src", "price-registry.js")).href);
  assert.equal(current[0].productionCommit, manifest.sourceCommit);
  assert.equal(current[0].priceRegistrySha256, prices.APP_PRICE_REGISTRY_SHA256);
  assert.equal(current[0].priceRegistryVersion, prices.APP_PRICE_REGISTRY_VERSION);
});

test("the staged kernel-stamps migration seeds exactly registry entry 1", async () => {
  const value = await registry();
  const directory = join(WORKER_ROOT, "postgres", "staged-migrations", "primary");
  const promoted = join(WORKER_ROOT, "postgres", "migrations", "primary");
  const find = async (root) => (await readdir(root).catch(() => [])).find((name) => /^\d{4}_analytics_v2_kernel_stamps\.sql$/u.test(name));
  const name = await find(directory) ?? await find(promoted);
  assert.ok(name, "the kernel-stamps migration is staged or promoted");
  const sql = await readFile(join((await find(directory)) ? directory : promoted, name), "utf8");
  const seed = /INSERT INTO analytics_v2_kernels \(kernel_id, production_commit, vendor_manifest_sha256, compute_closure_sha256,\s+price_registry_sha256, price_registry_version, method_version, registered_at\)\s+VALUES \(1, '([0-9a-f]{40})',\s+'([0-9a-f]{64})',\s+'([0-9a-f]{64})',\s+'([0-9a-f]{64})',\s+'([^']+)', '([^']+)', '[^']+'\);/u.exec(sql);
  assert.ok(seed, "the seed row is present in its reviewed form");
  const [, commit, vendor, closure, priceSha, priceVersion, method] = seed;
  const first = value.kernels[0];
  assert.deepEqual({ commit, vendor, closure, priceSha, priceVersion, method }, {
    commit: first.productionCommit, vendor: first.vendorManifestSha256, closure: first.computeClosureSha256,
    priceSha: first.priceRegistrySha256, priceVersion: first.priceRegistryVersion, method: first.methodVersion });
});
