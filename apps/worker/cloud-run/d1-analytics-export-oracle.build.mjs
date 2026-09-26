#!/usr/bin/env node

/**
 * Operator-only build of the D1 analytics export oracle CLI (HX-4).
 *
 * The oracle is operator-local tooling and must never enter the Cloud Run
 * image. The image build copies the audited context
 * (scripts/cloud-run-build-context.mjs) and runs `npm run build`, which is
 * build.mjs over every entry it names. So the oracle is deliberately NOT a
 * build.mjs entry (the context does not contain the CLI or its adapter, and
 * esbuild would fail there), and none of this script, the CLI or the sealed
 * SQLite adapter is in the context. The operator runs this script from a full
 * checkout instead:
 *
 *   node ./d1-analytics-export-oracle.build.mjs           writes dist/d1-analytics-export-oracle.mjs
 *   node ./d1-analytics-export-oracle.build.mjs --check   bundles without writing
 *
 * dist/ is ignored and never copied into the image context; the HX-3 `oracle`
 * subcommand spawns the bundle from there. The CLI and its checks need
 * Node.js 24.10+ at run time (the sealed SQLite adapter refuses older ones).
 */

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
export const D1_ANALYTICS_EXPORT_ORACLE_BUNDLE = "d1-analytics-export-oracle";
export const D1_ANALYTICS_EXPORT_ORACLE_OUTDIR = resolve(ROOT, "dist");

/** The same esbuild settings as build.mjs, for this one operator entry. The
 * bundle must sit in a directory under this package (dist/ or below) so its
 * externals resolve from this package's node_modules. */
export function d1AnalyticsExportOracleBuildOptions(outdir = D1_ANALYTICS_EXPORT_ORACLE_OUTDIR) {
  return {
    entryPoints: { [D1_ANALYTICS_EXPORT_ORACLE_BUNDLE]: resolve(ROOT, "d1-analytics-export-oracle.mjs") },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outdir,
    entryNames: "[name]",
    outExtension: { ".js": ".mjs" },
    sourcemap: false,
    external: ["@google-cloud/cloud-sql-connector", "google-auth-library", "jsonc-parser", "pg"],
    logLevel: "silent",
  };
}

/** Bundle the CLI into `outdir`; returns the written path, or null for `write: false`. */
export async function buildD1AnalyticsExportOracle({ outdir = D1_ANALYTICS_EXPORT_ORACLE_OUTDIR, write = true } = {}) {
  if (write) await mkdir(outdir, { recursive: true });
  await build({ ...d1AnalyticsExportOracleBuildOptions(outdir), write });
  return write ? resolve(outdir, `${D1_ANALYTICS_EXPORT_ORACLE_BUNDLE}.mjs`) : null;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) {
    console.error(JSON.stringify({ status: "error", code: "ORACLE_BUILD_ARGUMENT_INVALID" }));
    process.exitCode = 1;
  } else if (args.includes("--check")) {
    await buildD1AnalyticsExportOracle({ write: false });
    console.log(JSON.stringify({ status: "ok", mode: "check", entries: [`${D1_ANALYTICS_EXPORT_ORACLE_BUNDLE}.mjs`] }));
  } else {
    await buildD1AnalyticsExportOracle();
    console.log(JSON.stringify({ status: "ok", mode: "build", outputs: [`dist/${D1_ANALYTICS_EXPORT_ORACLE_BUNDLE}.mjs`] }));
  }
}
