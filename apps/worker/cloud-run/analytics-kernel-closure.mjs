/**
 * The analytics-v2 kernel identity a build stamps into the refresh bundles
 * (K-STAMP). Build-time only: build.mjs computes it and passes it to esbuild
 * as two defines; nothing at runtime imports this module.
 *
 * - vendorManifestSha256: sha256 of the vendored kernels' MANIFEST.json bytes,
 *   which lists every vendored file's digest (the price registry included).
 * - computeClosureSha256: the compute class (owner decision round 7: the
 *   compatibility class includes the GCP compute closure), a sha256 over every
 *   module that decides a stored analytics_v2 value, each as (name, sha256 of
 *   its bytes), sorted by name. The modules are those the refresh Job and its
 *   compute Worker bundle that are reachable from ANALYTICS_KERNEL_CLOSURE_ROOTS
 *   (the A-1 readers with their decode and reconcile code, the A-2 compute
 *   core with the community fold, the Job's read and compute composition, the
 *   Worker shell, the vendored kernels and every module they import), walking
 *   esbuild's import graph without entering ANALYTICS_KERNEL_CLOSURE_PLUMBING
 *   (the Job shell, the Worker pool, the database client, the store and the
 *   kernel identity itself). A change to any module in it, comments included,
 *   is a new class and needs a new src/analytics-v2/kernel-registry.json entry
 *   before a bundle built from it can stamp rows (the Job refuses
 *   ANALYTICS_V2_KERNEL_UNREGISTERED). `node cloud-run/build.mjs
 *   --kernel-closure` prints the closure's names.
 *
 * Names are independent of where a build runs, so a local build and the image
 * build (/app/apps/worker/...) compute the same digest:
 * - a repository file is named by its repository-relative path;
 * - a workspace package (@app-usagemonitor/<name>) is named by its repository
 *   path, packages/<name>/<path>. The image installs it as a link to
 *   /app/packages/<name>, so esbuild reads the repository file; a checkout
 *   installs a copy under node_modules, which must equal the repository file
 *   byte for byte (ANALYTICS_KERNEL_CLOSURE_WORKSPACE_COPY_STALE otherwise:
 *   a stale copy would register a closure the image never builds);
 * - any other third-party module (the vendored kernels' `runcost`) is named
 *   by package, version and path inside the package, never by where the
 *   install put it (apps/worker/node_modules locally, cloud-run/node_modules
 *   in the image).
 *
 * The build refuses an identity no kernel-registry.json entry names
 * (resolveAnalyticsKernelRegistryEntry, CLOUD_RUN_BUILD_KERNEL_UNREGISTERED),
 * so an image built from unregistered code fails its build (the Dockerfile
 * runs `npm run build`) instead of deploying a Job that refuses every run.
 * Only `--kernel-closure` skips that check: it is how a new entry's digests
 * are found.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

export const ANALYTICS_KERNEL_CLOSURE_VERSION = "analytics-v2-compute-closure-v2";
const CLOUD_RUN_ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(CLOUD_RUN_ROOT, "..");
const REPOSITORY_ROOT = resolve(WORKER_ROOT, "../..");
/** The refresh Job entry (the read side and the inline compute path). */
export const ANALYTICS_REFRESH_JOB_ENTRY = resolve(CLOUD_RUN_ROOT, "analytics-refresh.mjs");
/** The compute Worker entry (K-PAR). */
export const ANALYTICS_REFRESH_WORKER_ENTRY = resolve(CLOUD_RUN_ROOT, "analytics-refresh-worker.mjs");
/**
 * The modules that decide stored analytics_v2 values (repository paths). The
 * closure is everything the two refresh bundles reach from these without
 * entering ANALYTICS_KERNEL_CLOSURE_PLUMBING.
 */
export const ANALYTICS_KERNEL_CLOSURE_ROOTS = Object.freeze([
  // The compute Worker shell: one admitted owner (compute-owner.ts).
  "apps/worker/cloud-run/analytics-refresh-worker.mjs",
  // The Job's read and compute composition: publication days, the cache and
  // occurrence horizons, read spans, the exclusion mapping.
  "apps/worker/cloud-run/analytics-refresh-read.mjs",
  // A-2: the plan, the merge, the refusals, the community fold (compute-community.ts).
  "apps/worker/src/analytics-v2/compute.ts",
  // A-1: the occurrence reader with its decode and reconcile code.
  "apps/worker/src/analytics-v2/occurrence-source.ts",
  // A-1: the owner roster, the source routing and the community aggregate exclusions.
  "apps/worker/src/analytics-v2/owners.ts",
  // A-1: contributing devices and the queued days.
  "apps/worker/src/analytics-v2/devices.ts",
  "apps/worker/src/analytics-v2/queued-days.ts",
  // E-OWNERSET: the saved owner sets, stored contributions and frozen counts a fold reads.
  "apps/worker/src/analytics-v2/owner-sets.ts",
]);
/**
 * I/O plumbing (repository paths): never in the closure and never walked
 * through. Each must be in the refresh bundle, so a renamed module cannot
 * silently move into the closure or out of this list.
 */
export const ANALYTICS_KERNEL_CLOSURE_PLUMBING = Object.freeze([
  "apps/worker/cloud-run/analytics-refresh.mjs",
  "apps/worker/cloud-run/analytics-refresh-pool.mjs",
  "apps/worker/src/postgres-client.ts",
  "apps/worker/src/analytics-v2/store.ts",
  "apps/worker/src/analytics-v2/store-run.ts",
  "apps/worker/src/analytics-v2/store-derived.ts",
  "apps/worker/src/analytics-v2/store-publication.ts",
  "apps/worker/src/analytics-v2/kernel.ts",
  "apps/worker/src/analytics-v2/kernel-registry.json",
]);
/** The esbuild defines the identity is stamped through (src/analytics-v2/kernel.ts reads them). */
export const ANALYTICS_KERNEL_DEFINES = Object.freeze({
  computeClosureSha256: "__ANALYTICS_V2_COMPUTE_CLOSURE_SHA256__",
  vendorManifestSha256: "__ANALYTICS_V2_VENDOR_MANIFEST_SHA256__",
});
const WORKSPACE_SCOPE = "@app-usagemonitor";

function fail(code, extra = {}) {
  throw Object.assign(new Error(code), { code, ...extra });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The package an absolute node_modules path belongs to: its name parts and the path inside it. */
function packageOf(absolute) {
  const parts = absolute.split(sep);
  const at = parts.lastIndexOf("node_modules");
  const scoped = parts[at + 1]?.startsWith("@");
  const nameParts = parts.slice(at + 1, at + (scoped ? 3 : 2));
  if (nameParts.length !== (scoped ? 2 : 1) || nameParts.some((part) => !part)) fail("ANALYTICS_KERNEL_CLOSURE_PACKAGE_INVALID");
  const inside = parts.slice(at + 1 + nameParts.length);
  if (inside.length === 0) fail("ANALYTICS_KERNEL_CLOSURE_PACKAGE_INVALID");
  return { nameParts, root: parts.slice(0, at + 1 + nameParts.length).join(sep), inside };
}

/**
 * The closure name of one bundled input and the digest of the bytes it is
 * hashed by (see the module comment). `read` is fs readFile (a check may
 * substitute it).
 */
async function closureEntry(absolute, read) {
  if (!absolute.split(sep).includes("node_modules")) {
    const fromRoot = relative(REPOSITORY_ROOT, absolute);
    if (fromRoot.startsWith("..")) fail("ANALYTICS_KERNEL_CLOSURE_OUTSIDE_SOURCES");
    return [fromRoot.split(sep).join("/"), sha256(await read(absolute))];
  }
  const { nameParts, root, inside } = packageOf(absolute);
  if (nameParts[0] === WORKSPACE_SCOPE) {
    // A workspace package copy: named and verified as the repository file.
    const input = `${nameParts.join("/")}/${inside.join("/")}`;
    let copy;
    let source;
    try {
      [copy, source] = await Promise.all([read(absolute), read(resolve(REPOSITORY_ROOT, "packages", nameParts[1], ...inside))]);
    } catch {
      fail("ANALYTICS_KERNEL_CLOSURE_WORKSPACE_COPY_STALE", { input });
    }
    if (!Buffer.from(copy).equals(Buffer.from(source))) fail("ANALYTICS_KERNEL_CLOSURE_WORKSPACE_COPY_STALE", { input });
    return [["packages", nameParts[1], ...inside].join("/"), sha256(source)];
  }
  let version;
  try {
    version = JSON.parse(await read(`${root}${sep}package.json`, "utf8")).version;
  } catch {
    fail("ANALYTICS_KERNEL_CLOSURE_PACKAGE_INVALID");
  }
  if (typeof version !== "string" || !/^[0-9A-Za-z.+-]{1,64}$/u.test(version)) fail("ANALYTICS_KERNEL_CLOSURE_PACKAGE_INVALID");
  return [`npm:${nameParts.join("/")}@${version}/${inside.join("/")}`, sha256(await read(absolute))];
}

/**
 * The identity of the kernels `build(options)` would bundle into the refresh
 * Job and its compute Worker. `build` is esbuild's; `options` are the
 * cloud-run build options (bundle, platform, externals); `vendorRoot` is the
 * vendored kernel directory. Returns the two digests and the closure's names
 * in hash order (`names`; `inputs` is their count).
 */
export async function computeAnalyticsKernelIdentity({ build, options, vendorRoot, cwd = process.cwd(),
  read = readFile }) {
  if (typeof build !== "function" || options === null || typeof options !== "object" || typeof vendorRoot !== "string"
      || typeof read !== "function") {
    fail("ANALYTICS_KERNEL_CLOSURE_INVALID");
  }
  const { define: _define, entryPoints: _entryPoints, outdir: _outdir, entryNames: _entryNames, ...shared } = options;
  // The metafile's paths are relative to esbuild's working directory: `cwd`.
  const result = await build({ ...shared, absWorkingDir: cwd,
    entryPoints: [ANALYTICS_REFRESH_JOB_ENTRY, ANALYTICS_REFRESH_WORKER_ENTRY], write: false, metafile: true,
    outdir: resolve(CLOUD_RUN_ROOT, "dist") });
  const graph = new Map();
  for (const [path, input] of Object.entries(result.metafile.inputs)) {
    graph.set(resolve(cwd, path), (input.imports ?? []).filter((imported) => !imported.external)
      .map((imported) => resolve(cwd, imported.path)));
  }
  const fromRepository = (path) => resolve(REPOSITORY_ROOT, ...path.split("/"));
  const plumbing = new Set(ANALYTICS_KERNEL_CLOSURE_PLUMBING.map(fromRepository));
  for (const path of plumbing) {
    if (!graph.has(path)) fail("ANALYTICS_KERNEL_CLOSURE_PLUMBING_MISSING", { path: relative(REPOSITORY_ROOT, path) });
  }
  const roots = ANALYTICS_KERNEL_CLOSURE_ROOTS.map(fromRepository);
  for (const path of roots) {
    if (!graph.has(path)) fail("ANALYTICS_KERNEL_CLOSURE_ROOT_MISSING", { path: relative(REPOSITORY_ROOT, path) });
  }
  const reached = new Set();
  const stack = [...roots];
  while (stack.length > 0) {
    const path = stack.pop();
    if (reached.has(path) || plumbing.has(path)) continue;
    if (!graph.has(path)) fail("ANALYTICS_KERNEL_CLOSURE_INVALID");
    reached.add(path);
    stack.push(...graph.get(path));
  }
  if (![...reached].some((path) => path.startsWith(`${resolve(vendorRoot)}${sep}`))) {
    fail("ANALYTICS_KERNEL_CLOSURE_KERNELS_MISSING");
  }
  // A workspace package reached both through a checkout's copy and through
  // its repository path is one module (the image links it, so it bundles it
  // once): equal entries collapse, and one name with two digests is refused.
  const byName = new Map();
  for (const path of reached) {
    const [name, digest] = await closureEntry(path, read);
    if (byName.has(name) && byName.get(name) !== digest) fail("ANALYTICS_KERNEL_CLOSURE_NAME_COLLISION", { name });
    byName.set(name, digest);
  }
  const inputs = [...byName].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.freeze({
    computeClosureSha256: sha256(JSON.stringify([ANALYTICS_KERNEL_CLOSURE_VERSION, inputs])),
    vendorManifestSha256: sha256(await read(resolve(vendorRoot, "MANIFEST.json"))),
    inputs: inputs.length,
    names: Object.freeze(inputs.map(([name]) => name)),
  });
}

/** The esbuild `define` map that stamps `identity` into a bundle. */
export function analyticsKernelDefines(identity) {
  return Object.freeze({
    [ANALYTICS_KERNEL_DEFINES.computeClosureSha256]: JSON.stringify(identity.computeClosureSha256),
    [ANALYTICS_KERNEL_DEFINES.vendorManifestSha256]: JSON.stringify(identity.vendorManifestSha256),
  });
}

/** The module that resolves a bundle's identity to its registry entry (the Job's own resolver). */
export const ANALYTICS_KERNEL_REGISTRY_MODULE = resolve(WORKER_ROOT, "src", "analytics-v2", "kernel.ts");

/**
 * The kernel-registry.json entry naming `identity`, resolved exactly as the
 * refresh Job resolves its bundle: src/analytics-v2/kernel.ts and the
 * registry are bundled with `identity`'s defines (analyticsKernelDefines) and
 * resolveAnalyticsV2Kernel(analyticsV2BundledKernelIdentity()) runs on that
 * bundle, so the method version is the code's own. The bundle (this
 * repository's kernel.ts and its imports, nothing else) is evaluated in a
 * fresh context holding only the globals it needs, never imported.
 * Refuses CLOUD_RUN_BUILD_KERNEL_UNREGISTERED, carrying the two digests,
 * when no entry names it, and CLOUD_RUN_BUILD_KERNEL_REGISTRY_INVALID for a
 * malformed registry. `build` and `options` are as for
 * computeAnalyticsKernelIdentity.
 */
export async function resolveAnalyticsKernelRegistryEntry({ build, options, identity, cwd = process.cwd() }) {
  if (typeof build !== "function" || options === null || typeof options !== "object" || identity === null
      || typeof identity !== "object" || typeof identity.computeClosureSha256 !== "string"
      || typeof identity.vendorManifestSha256 !== "string") {
    fail("ANALYTICS_KERNEL_CLOSURE_INVALID");
  }
  const { define: _define, entryPoints: _entryPoints, outdir: _outdir, entryNames: _entryNames,
    outExtension: _outExtension, metafile: _metafile, external: _external, ...shared } = options;
  // Self-contained (no externals; packages' ESM entries, which make no
  // dynamic require) and one script, so it loads nothing at run time.
  const result = await build({ ...shared, absWorkingDir: cwd, entryPoints: [ANALYTICS_KERNEL_REGISTRY_MODULE],
    write: false, external: [], mainFields: ["module", "main"], format: "iife", globalName: "analyticsV2Kernel",
    define: analyticsKernelDefines(identity) });
  if (!Array.isArray(result.outputFiles) || result.outputFiles.length !== 1) fail("ANALYTICS_KERNEL_CLOSURE_INVALID");
  const context = { TextEncoder, TextDecoder, crypto: globalThis.crypto };
  new Script(result.outputFiles[0].text, { filename: "analytics-v2-kernel-registry.js" }).runInNewContext(context);
  const kernel = context.analyticsV2Kernel;
  if (typeof kernel?.resolveAnalyticsV2Kernel !== "function"
      || typeof kernel?.analyticsV2BundledKernelIdentity !== "function") {
    fail("ANALYTICS_KERNEL_CLOSURE_INVALID");
  }
  try {
    return kernel.resolveAnalyticsV2Kernel(kernel.analyticsV2BundledKernelIdentity());
  } catch (error) {
    if (error?.code === "ANALYTICS_V2_KERNEL_UNREGISTERED") {
      fail("CLOUD_RUN_BUILD_KERNEL_UNREGISTERED", { computeClosureSha256: identity.computeClosureSha256,
        vendorManifestSha256: identity.vendorManifestSha256 });
    }
    if (error?.code === "ANALYTICS_V2_KERNEL_REGISTRY_INVALID") fail("CLOUD_RUN_BUILD_KERNEL_REGISTRY_INVALID");
    throw error;
  }
}
