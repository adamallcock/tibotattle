import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkDependencyGraph, checkDependencyInputs, checkLocal, REMOVED_PACKAGES } from "../scripts/check-build-download-dependencies.mjs";

const rootRequire = createRequire(import.meta.url);
const builderRequire = createRequire(rootRequire.resolve("electron-builder/package.json"));
const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
const yaml = appBuilderRequire("js-yaml");
async function inputs() {
  return {
    lock: yaml.load(await readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8")),
    workspace: yaml.load(await readFile(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8")),
    manifest: JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")),
    patch: await readFile(new URL("../config/patches/app-builder-lib@26.15.7.patch", import.meta.url)),
  };
}

test("recursive committed and installed inventories exclude every retired dependency", async () => {
  const result = await checkDependencyGraph();
  assert.ok(result.lockedPackages > 0);
  assert.ok(result.installedPackages > 0);
  assert.deepEqual(result.removedPackages, ["got", "cacheable-request", "http-cache-semantics", "global-agent", "roarr", "sprintf-js"]);
  await checkLocal();
});

test("any version of a retired package in either recursive lock section is rejected", async () => {
  for (const name of REMOVED_PACKAGES) {
    for (const section of ["packages", "snapshots"]) {
      const input = await inputs();
      input.lock[section][`${name}@999.0.0`] = {};
      assert.throws(() => checkDependencyInputs(input), /Removed build dependency returned/, name + "/" + section);
    }
  }
});

test("missing inventories, downloader drift, mismatched locks and patch drift fail closed", async () => {
  for (const mutate of [
    value => { value.lock.packages = {}; },
    value => { value.lock.snapshots = {}; },
    value => { value.lock.packages["@electron/get@3.1.0"] = {}; },
    value => { value.manifest.devDependencies["electron-builder"] = "27.0.0-alpha.10"; },
    value => { delete value.workspace.overrides["app-builder-lib@26.15.7>@electron/get"]; },
    value => { value.lock.overrides["@electron/get@5.1.0>undici"] = "7.24.4"; },
    value => { value.patch = Buffer.from("different patch"); },
    value => { value.workspace.patchedDependencies["http-cache-semantics@4.2.0"] = "retired.patch"; },
  ]) {
    const input = await inputs(); mutate(input);
    assert.throws(() => checkDependencyInputs(input));
  }
});

test("a new root exception or ambiguous additional root lock is refused before dependency execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-build-dependency-guard-"));
  try {
    await writeFile(join(root, "pnpm-lock.yaml"), "synthetic");
    await writeFile(join(root, "osv-scanner.toml"), '[[IgnoredVulns]]\nid = "synthetic"\n');
    await assert.rejects(checkLocal(root), /Retired root dependency exception returned/);
    await writeFile(join(root, "package-lock.json"), "{}");
    await assert.rejects(checkLocal(root), /Additional root dependency lock/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dependency workflow keeps direct failure propagation and verifies source before scanning all locks", async () => {
  const workflow = await readFile(new URL("../.github/workflows/osv-scanner.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /--config|fail-on-vuln=false|continue-on-error|google\/osv-scanner-action|osv-reporter|GOTOOLCHAIN/);
  assert.match(workflow, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.ok(workflow.indexOf("node scripts/check-build-download-dependencies.mjs") < workflow.indexOf("name: Run scanner"));
  assert.match(workflow, /test\/electron-build-downloader.test.js/);
  assert.match(workflow, /test\/electron-windows-production-signing.test.js/);
  const scanner = workflow.slice(workflow.indexOf("      - name: Run scanner"));
  assert.match(scanner, /shell: bash/);
  assert.match(scanner, /set -euo pipefail/);
  assert.match(scanner, /https:\/\/github\.com\/google\/osv-scanner\/releases\/download\/v2\.5\.1\/osv-scanner_linux_amd64/);
  assert.match(scanner, /f9f25499a2c8cc367b3af45df2ea7eeca7fbccceab9c35079968f4b3652194be/);
  assert.match(scanner, /sha256sum --check --strict/);
  assert.ok(scanner.indexOf("sha256sum --check --strict") < scanner.indexOf('chmod 0700 "$scanner"'));
  assert.ok(scanner.indexOf('chmod 0700 "$scanner"') < scanner.indexOf('"$scanner" scan source --all-vulns --recursive ./'));
  assert.doesNotMatch(scanner, /\|\||set \+e|exit 0|continue-on-error|--config|--no-ignore/);
});
