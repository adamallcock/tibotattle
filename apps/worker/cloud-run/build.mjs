#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const ENTRY = resolve(ROOT, "server.mjs");
const OAUTH_GATEWAY_ENTRY = resolve(ROOT, "oauth-gateway.mjs");
const SMOKE_ENTRY = resolve(ROOT, "synthetic-v12-smoke.mjs");
const MIGRATIONS_ENTRY = resolve(ROOT, "test-migrations.mjs");
const ACTIVATION_ENTRY = resolve(ROOT, "test-activation.mjs");
const CLEANUP_ENTRY = resolve(ROOT, "synthetic-v12-cleanup.mjs");
const DISCOVERY_ENTRY = resolve(ROOT, "synthetic-v12-discovery.mjs");
const COMMUNITY_GRAPH_BENCHMARK_ENTRY = resolve(ROOT, "postgres-community-graph-benchmark.mjs");
const COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_ENTRY = resolve(ROOT, "postgres-community-graph-readback-diagnostic.mjs");
const COMMUNITY_DAILY_TEST_ENTRY = resolve(ROOT, "postgres-community-daily-publish-test.mjs");
const COMMUNITY_DAILY_LIVE_SMOKE_ENTRY = resolve(ROOT, "postgres-community-daily-live-smoke.mjs");
const COMMUNITY_DAILY_PREPARE_ENTRY = resolve(ROOT, "postgres-community-daily-prepare-test.mjs");
const COMMUNITY_DAILY_RESTORE_ENTRY = resolve(ROOT, "postgres-community-daily-restore-test.mjs");
const ANALYTICS_REFRESH_ENTRY = resolve(ROOT, "analytics-refresh.mjs");
const PRODUCTION_MIGRATIONS_ENTRY = resolve(ROOT, "postgres-production-migrations.mjs");
const OUTDIR = resolve(ROOT, "dist");
// The vendored d43c8f92 kernels resolve @app-usagemonitor/* to the packages
// vendored beside them through vendor/analytics-d43c8f92/tsconfig.json
// `paths`, found by esbuild's per-directory tsconfig discovery. Passing a
// tsconfig or tsconfigRaw here would override that discovery and silently
// bundle this checkout's packages under the vendored kernels instead.
const VENDOR_ROOT = resolve(ROOT, "../vendor/analytics-d43c8f92");
const VENDORED_PACKAGES = resolve(VENDOR_ROOT, "packages");
const options = {
  entryPoints: {
    server: ENTRY,
    "oauth-gateway": OAUTH_GATEWAY_ENTRY,
    "synthetic-v12-smoke": SMOKE_ENTRY,
    "test-migrations": MIGRATIONS_ENTRY,
    "test-activation": ACTIVATION_ENTRY,
    "synthetic-v12-cleanup": CLEANUP_ENTRY,
    "synthetic-v12-discovery": DISCOVERY_ENTRY,
    "postgres-community-graph-benchmark": COMMUNITY_GRAPH_BENCHMARK_ENTRY,
    "postgres-community-graph-readback-diagnostic": COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_ENTRY,
    "postgres-community-daily-publish-test": COMMUNITY_DAILY_TEST_ENTRY,
    "postgres-community-daily-live-smoke": COMMUNITY_DAILY_LIVE_SMOKE_ENTRY,
    "postgres-community-daily-prepare-test": COMMUNITY_DAILY_PREPARE_ENTRY,
    "postgres-community-daily-restore-test": COMMUNITY_DAILY_RESTORE_ENTRY,
    "analytics-refresh": ANALYTICS_REFRESH_ENTRY,
    "production-migrations": PRODUCTION_MIGRATIONS_ENTRY,
  },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outdir: OUTDIR,
  entryNames: "[name]",
  outExtension: { ".js": ".mjs" },
  sourcemap: false,
  external: ["@google-cloud/cloud-sql-connector", "google-auth-library", "jsonc-parser", "pg"],
  logLevel: "silent",
  metafile: true,
};

/**
 * Refuse a bundle in which a vendored kernel file imports a workspace package
 * that did not resolve inside the vendor tree. Code outside the vendor tree
 * keeps this checkout's packages by design.
 */
function assertVendoredPackageResolution(metafile) {
  const cwd = process.cwd();
  const absolute = (path) => resolve(cwd, path);
  const insideVendor = (path) => absolute(path).startsWith(`${VENDOR_ROOT}${sep}`);
  let vendoredInputs = 0;
  for (const [path, input] of Object.entries(metafile.inputs)) {
    if (!insideVendor(path)) continue;
    vendoredInputs += 1;
    for (const imported of input.imports ?? []) {
      if (typeof imported.original !== "string" || !imported.original.startsWith("@app-usagemonitor/")) continue;
      if (imported.external || !absolute(imported.path).startsWith(`${VENDORED_PACKAGES}${sep}`)) {
        throw Object.assign(new Error("CLOUD_RUN_BUILD_VENDORED_PACKAGE_UNRESOLVED"), {
          code: "CLOUD_RUN_BUILD_VENDORED_PACKAGE_UNRESOLVED",
          input: relative(ROOT, absolute(path)),
          imported: imported.original,
        });
      }
    }
  }
  const refreshOutput = Object.entries(metafile.outputs)
    .find(([, output]) => output.entryPoint !== undefined && absolute(output.entryPoint) === ANALYTICS_REFRESH_ENTRY);
  if (refreshOutput === undefined
      || !Object.keys(refreshOutput[1].inputs).some((path) => insideVendor(path))) {
    throw Object.assign(new Error("CLOUD_RUN_BUILD_ANALYTICS_REFRESH_KERNELS_MISSING"), {
      code: "CLOUD_RUN_BUILD_ANALYTICS_REFRESH_KERNELS_MISSING",
    });
  }
  return vendoredInputs;
}
if (process.argv.includes("--check")) {
  const result = await build({ ...options, write: false });
  assertVendoredPackageResolution(result.metafile);
  console.log(JSON.stringify({
    status: "ok",
    mode: "check",
    entries: ["server.mjs", "oauth-gateway.mjs", "synthetic-v12-smoke.mjs", "test-migrations.mjs", "test-activation.mjs", "synthetic-v12-cleanup.mjs", "synthetic-v12-discovery.mjs", "postgres-community-graph-benchmark.mjs", "postgres-community-graph-readback-diagnostic.mjs", "postgres-community-daily-publish-test.mjs", "postgres-community-daily-live-smoke.mjs", "postgres-community-daily-prepare-test.mjs", "postgres-community-daily-restore-test.mjs", "analytics-refresh.mjs", "postgres-production-migrations.mjs"],
  }));
} else {
  await mkdir(OUTDIR, { recursive: true });
  const result = await build(options);
  assertVendoredPackageResolution(result.metafile);
  console.log(JSON.stringify({
    status: "ok",
    mode: "build",
    outputs: ["dist/server.mjs", "dist/oauth-gateway.mjs", "dist/synthetic-v12-smoke.mjs", "dist/test-migrations.mjs", "dist/test-activation.mjs", "dist/synthetic-v12-cleanup.mjs", "dist/synthetic-v12-discovery.mjs", "dist/postgres-community-graph-benchmark.mjs", "dist/postgres-community-graph-readback-diagnostic.mjs", "dist/postgres-community-daily-publish-test.mjs", "dist/postgres-community-daily-live-smoke.mjs", "dist/postgres-community-daily-prepare-test.mjs", "dist/postgres-community-daily-restore-test.mjs", "dist/analytics-refresh.mjs", "dist/production-migrations.mjs"],
  }));
}
