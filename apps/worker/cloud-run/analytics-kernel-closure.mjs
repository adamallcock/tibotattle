/**
 * The analytics-v2 kernel identity a build stamps into the refresh bundles
 * (K-STAMP). Build-time only: build.mjs computes it and passes it to esbuild
 * as two defines; nothing at runtime imports this module.
 *
 * - vendorManifestSha256: sha256 of the vendored kernels' MANIFEST.json bytes,
 *   which lists every vendored file's digest (the price registry included).
 * - computeClosureSha256: the compatibility class of the compute code, a
 *   sha256 over every input file of the compute Worker's closure
 *   (cloud-run/analytics-refresh-worker.mjs: compute-owner.ts and everything
 *   it bundles, vendored kernels and GCP-owned analytics-v2 modules alike),
 *   each as (repository-relative path, sha256 of its bytes), sorted by path.
 *   A change to any file in it, comments included, is a new class and needs a
 *   new src/analytics-v2/kernel-registry.json entry before a bundle built from
 *   it can stamp rows (the Job refuses ANALYTICS_V2_KERNEL_UNREGISTERED).
 *
 * Paths are relative to the repository root, so a local build and the image
 * build (/app/apps/worker/...) compute the same digests. A third-party module
 * the closure bundles (the vendored kernels' `runcost`) is named by package,
 * version and path inside the package, never by where the install put it
 * (apps/worker/node_modules locally, cloud-run/node_modules in the image).
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ANALYTICS_KERNEL_CLOSURE_VERSION = "analytics-v2-compute-closure-v1";
const CLOUD_RUN_ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(CLOUD_RUN_ROOT, "..");
const REPOSITORY_ROOT = resolve(WORKER_ROOT, "../..");
/** The compute Worker entry whose closure is the compute class. */
export const ANALYTICS_REFRESH_WORKER_ENTRY = resolve(CLOUD_RUN_ROOT, "analytics-refresh-worker.mjs");
/** The esbuild defines the identity is stamped through (src/analytics-v2/kernel.ts reads them). */
export const ANALYTICS_KERNEL_DEFINES = Object.freeze({
  computeClosureSha256: "__ANALYTICS_V2_COMPUTE_CLOSURE_SHA256__",
  vendorManifestSha256: "__ANALYTICS_V2_VENDOR_MANIFEST_SHA256__",
});

function fail(code, extra = {}) {
  throw Object.assign(new Error(code), { code, ...extra });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** `npm:<name>@<version>/<path in package>` for a file inside node_modules. */
async function packagePath(absolute) {
  const parts = absolute.split(sep);
  const at = parts.lastIndexOf("node_modules");
  const scoped = parts[at + 1]?.startsWith("@");
  const nameParts = parts.slice(at + 1, at + (scoped ? 3 : 2));
  if (nameParts.length !== (scoped ? 2 : 1) || nameParts.some((part) => !part)) fail("ANALYTICS_KERNEL_CLOSURE_PACKAGE_INVALID");
  const packageRoot = parts.slice(0, at + 1 + nameParts.length).join(sep);
  let version;
  try {
    version = JSON.parse(await readFile(`${packageRoot}${sep}package.json`, "utf8")).version;
  } catch {
    fail("ANALYTICS_KERNEL_CLOSURE_PACKAGE_INVALID");
  }
  if (typeof version !== "string" || !/^[0-9A-Za-z.+-]{1,64}$/u.test(version)) fail("ANALYTICS_KERNEL_CLOSURE_PACKAGE_INVALID");
  return `npm:${nameParts.join("/")}@${version}/${parts.slice(at + 1 + nameParts.length).join("/")}`;
}

/**
 * The identity of the kernels `build(options)` would bundle. `build` is
 * esbuild's; `options` are the cloud-run build options (bundle, platform,
 * externals); `vendorRoot` is the vendored kernel directory.
 */
export async function computeAnalyticsKernelIdentity({ build, options, vendorRoot, cwd = process.cwd() }) {
  if (typeof build !== "function" || options === null || typeof options !== "object" || typeof vendorRoot !== "string") {
    fail("ANALYTICS_KERNEL_CLOSURE_INVALID");
  }
  const { define: _define, entryPoints: _entryPoints, outdir: _outdir, entryNames: _entryNames, ...shared } = options;
  const result = await build({ ...shared, entryPoints: [ANALYTICS_REFRESH_WORKER_ENTRY], write: false, metafile: true,
    outdir: resolve(CLOUD_RUN_ROOT, "dist") });
  const inputs = [];
  for (const path of Object.keys(result.metafile.inputs)) {
    const absolute = resolve(cwd, path);
    const fromRoot = relative(REPOSITORY_ROOT, absolute);
    let name;
    if (absolute.split(sep).includes("node_modules")) name = await packagePath(absolute);
    else if (fromRoot.startsWith("..")) fail("ANALYTICS_KERNEL_CLOSURE_OUTSIDE_SOURCES");
    else name = fromRoot.split(sep).join("/");
    inputs.push([name, sha256(await readFile(absolute))]);
  }
  inputs.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const manifestPath = resolve(vendorRoot, "MANIFEST.json");
  if (!inputs.some(([path]) => resolve(REPOSITORY_ROOT, path).startsWith(`${resolve(vendorRoot)}${sep}`))) {
    fail("ANALYTICS_KERNEL_CLOSURE_KERNELS_MISSING");
  }
  return Object.freeze({
    computeClosureSha256: sha256(JSON.stringify([ANALYTICS_KERNEL_CLOSURE_VERSION, inputs])),
    vendorManifestSha256: sha256(await readFile(manifestPath)),
    inputs: inputs.length,
  });
}

/** The esbuild `define` map that stamps `identity` into a bundle. */
export function analyticsKernelDefines(identity) {
  return Object.freeze({
    [ANALYTICS_KERNEL_DEFINES.computeClosureSha256]: JSON.stringify(identity.computeClosureSha256),
    [ANALYTICS_KERNEL_DEFINES.vendorManifestSha256]: JSON.stringify(identity.vendorManifestSha256),
  });
}
