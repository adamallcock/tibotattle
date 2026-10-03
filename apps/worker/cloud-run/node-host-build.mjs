import { relative, resolve } from "node:path";

// Build-time composition of the Cloud Run Node host primitives (Wave 1A).
// Never bundled and never run in a served or refresh process: cloud-run/build.mjs,
// the kernel-registry check, host.check.mjs and the v0x admission scan import
// it so that every in-repo esbuild of the Cloud Run entries sees the import
// graph that ships. It is outside the analytics kernel compute closure, so an
// edit here does not change the compute class; what it resolves to
// (node-host-primitives.mjs) is inside it.

/** The files nodeHostAliasPlugin resolves to node-host-primitives.mjs (a build asserts neither remains in a bundle). */
export function nodeHostAliasedFiles(workerRoot) {
  if (typeof workerRoot !== "string" || workerRoot.length === 0) throw new TypeError("NODE_HOST_ALIAS_ROOT_INVALID");
  return Object.freeze([
    resolve(workerRoot, "src", "host-primitives.ts"),
    resolve(workerRoot, "vendor", "analytics-d43c8f92", "apps", "worker", "src", "crypto.ts"),
  ]);
}

/** The runtime module the aliased files resolve to. */
export function nodeHostPrimitivesModule(workerRoot) {
  if (typeof workerRoot !== "string" || workerRoot.length === 0) throw new TypeError("NODE_HOST_ALIAS_ROOT_INVALID");
  return resolve(workerRoot, "cloud-run", "node-host-primitives.mjs");
}

/**
 * The esbuild plugin that composes the Node host primitives into the Cloud
 * Run bundles. It resolves exactly the nodeHostAliasedFiles, from any
 * relative importer, to node-host-primitives.mjs. The vendored crypto.ts stays
 * byte-identical: it leaves the bundle, and the primitives module enters the
 * compute closure in its place (a new kernel id). An importer the filter does
 * not see (an absolute path, a `.js` specifier) leaves the replaced file in
 * the bundle, which assertNodeHostAlias refuses.
 *
 * Only ESM output is aliased. The kernel-registry resolver bundles
 * src/analytics-v2/kernel.ts as a self-contained IIFE and evaluates it in a
 * bare vm context with WebCrypto and no `require`; there the portable
 * default stays, and it computes the same digests.
 */
export function nodeHostAliasPlugin(workerRoot) {
  const aliased = new Set(nodeHostAliasedFiles(workerRoot));
  const primitives = nodeHostPrimitivesModule(workerRoot);
  return Object.freeze({
    name: "node-host-primitives",
    setup(build) {
      if (build.initialOptions.format !== "esm") return;
      // esbuild filters are Go regular expressions: no `u` flag.
      build.onResolve({ filter: /^\.{1,2}\/(?:.*\/)?(?:host-primitives|crypto)(?:\.ts)?$/ }, (args) => {
        const target = resolve(args.resolveDir, args.path);
        return aliased.has(target.endsWith(".ts") ? target : `${target}.ts`) ? { path: primitives } : undefined;
      });
    },
  });
}

/** The plugins of cloud-run/build.mjs, for every in-repo esbuild of the Cloud Run entries. */
export function cloudRunBuildPlugins(workerRoot) {
  return [nodeHostAliasPlugin(workerRoot)];
}

function refuse(code, detail) {
  throw Object.assign(new Error(code), { code, ...detail });
}

/**
 * Refuse a bundle that still holds a file the Node host alias replaces
 * (CLOUD_RUN_BUILD_NODE_HOST_ALIAS_ESCAPED), or in which a required entry
 * does not hash through node-host-primitives.mjs
 * (CLOUD_RUN_BUILD_NODE_HOST_ALIAS_MISSING): an importer that escaped the
 * alias would otherwise silently fall back to WebCrypto. `metafile` paths are
 * relative to `cwd` (esbuild's working directory); `requiredEntries` are
 * absolute entry-point paths.
 */
export function assertNodeHostAlias(metafile, { workerRoot, requiredEntries, cwd = process.cwd() }) {
  if (!Array.isArray(requiredEntries) || requiredEntries.length === 0) {
    throw new TypeError("NODE_HOST_ALIAS_REQUIRED_ENTRIES_INVALID");
  }
  const primitives = nodeHostPrimitivesModule(workerRoot);
  const absolute = (path) => resolve(cwd, path);
  const inputs = new Set(Object.keys(metafile?.inputs ?? {}).map(absolute));
  for (const file of nodeHostAliasedFiles(workerRoot)) {
    if (inputs.has(file)) {
      refuse("CLOUD_RUN_BUILD_NODE_HOST_ALIAS_ESCAPED", { input: relative(workerRoot, file) });
    }
  }
  const outputs = Object.values(metafile?.outputs ?? {});
  for (const entry of requiredEntries) {
    const output = outputs.find((candidate) => candidate.entryPoint !== undefined && absolute(candidate.entryPoint) === entry);
    if (output === undefined || !Object.keys(output.inputs ?? {}).some((path) => absolute(path) === primitives)) {
      refuse("CLOUD_RUN_BUILD_NODE_HOST_ALIAS_MISSING", { entry: relative(workerRoot, entry) });
    }
  }
}
