#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = resolve(dirname(SCRIPT_FILE), "..");
export const REMOVED_PACKAGES = Object.freeze([
  "got", "cacheable-request", "http-cache-semantics", "global-agent", "roarr", "sprintf-js",
]);
const forbidden = new Set(REMOVED_PACKAGES);
const getOverride = "app-builder-lib@26.15.7>@electron/get";
const proxyOverride = "@electron/get@5.1.0>undici";
const rootLockNames = /^(?:pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?)$/;

function packageName(key) {
  return key.slice(0, key.indexOf("@", key.startsWith("@") ? 1 : 0));
}

export function checkDependencyInputs({ lock, workspace, manifest, patch }) {
  assert.equal(manifest.devDependencies["electron-builder"], "26.15.7", "Stable builder pin changed");
  assert.equal(workspace.overrides[getOverride], "5.1.0", "Reviewed get override missing");
  assert.equal(workspace.overrides[proxyOverride], "7.29.1", "Reviewed proxy dependency pin missing");
  assert.deepEqual(lock.overrides, workspace.overrides, "Lock and workspace overrides differ");
  assert.equal(workspace.patchedDependencies["app-builder-lib@26.15.7"], "config/patches/app-builder-lib@26.15.7.patch");
  assert.deepEqual(Object.keys(lock.patchedDependencies), ["app-builder-lib@26.15.7"], "Unexpected dependency patch");
  assert.deepEqual(Object.keys(workspace.patchedDependencies), ["app-builder-lib@26.15.7"], "Retired HTTP cache patch returned");
  assert.equal(lock.patchedDependencies["app-builder-lib@26.15.7"], createHash("sha256").update(patch).digest("hex"), "Builder patch hash drift");
  for (const section of [lock.packages, lock.snapshots]) {
    assert.ok(section && Object.keys(section).length > 0, "Missing recursive lock package inventory");
    for (const key of Object.keys(section)) {
      assert.ok(!forbidden.has(packageName(key)), "Removed build dependency returned: " + packageName(key));
      if (packageName(key) === "@electron/get") assert.equal(key, "@electron/get@5.1.0", "Unreviewed downloader version");
    }
  }
  assert.ok(lock.packages["@electron/get@5.1.0"], "Reviewed downloader missing from lock");
  return Object.keys(lock.packages).length;
}

export async function checkDependencyGraph(root = DEFAULT_ROOT) {
  const rootRequire = createRequire(join(root, "package.json"));
  const builderRequire = createRequire(rootRequire.resolve("electron-builder/package.json"));
  const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
  const yaml = appBuilderRequire("js-yaml");
  const lockedPackages = checkDependencyInputs({
    lock: yaml.load(await readFile(join(root, "pnpm-lock.yaml"), "utf8")),
    workspace: yaml.load(await readFile(join(root, "pnpm-workspace.yaml"), "utf8")),
    manifest: JSON.parse(await readFile(join(root, "package.json"), "utf8")),
    patch: await readFile(join(root, "config/patches/app-builder-lib@26.15.7.patch")),
  });
  const nodeModules = join(root, "node_modules");
  assert.equal(await realpath(nodeModules), nodeModules, "Dependencies must be installed inside this checkout");
  const store = join(nodeModules, ".pnpm");
  const manifests = new Set();
  for (const entry of await readdir(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const directory = join(store, entry.name, "node_modules");
    if (!existsSync(directory)) continue;
    for (const child of await readdir(directory)) {
      if (child.startsWith(".")) continue;
      const children = child.startsWith("@")
        ? (await readdir(join(directory, child))).map(name => join(directory, child, name))
        : [join(directory, child)];
      for (const packageDirectory of children) {
        const path = join(packageDirectory, "package.json");
        if (existsSync(path)) manifests.add(await realpath(path));
      }
    }
  }
  assert.ok(manifests.size > 0, "Installed dependency inventory is empty");
  let downloaderFound = false;
  for (const path of manifests) {
    const location = relative(nodeModules, path);
    assert.ok(!isAbsolute(location) && location !== ".." && !location.startsWith("../") && !location.startsWith("..\\"), "Installed package escaped this checkout");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    assert.ok(!forbidden.has(manifest.name), "Removed installed build dependency returned: " + manifest.name);
    if (manifest.name === "@electron/get") {
      assert.equal(manifest.version, "5.1.0", "Unreviewed installed downloader");
      downloaderFound = true;
    }
  }
  assert.ok(downloaderFound, "Reviewed installed downloader not found");
  return { lockedPackages, installedPackages: manifests.size, removedPackages: [...REMOVED_PACKAGES] };
}

export async function checkLocal(root = DEFAULT_ROOT) {
  assert.deepEqual((await readdir(root)).filter(name => rootLockNames.test(name)).sort(), ["pnpm-lock.yaml"], "Additional root dependency lock");
  assert.ok(!existsSync(join(root, "osv-scanner.toml")), "Retired root dependency exception returned");
  return checkDependencyGraph(root);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  try {
    const result = await checkLocal();
    console.log(`Build downloader dependency guard passed (${result.lockedPackages} locked, ${result.installedPackages} installed packages; six removed dependencies absent).`);
  } catch (error) {
    console.error("Build downloader dependency guard refused:", error.message);
    process.exitCode = 1;
  }
}
