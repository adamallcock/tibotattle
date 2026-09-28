#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const ENTRY = resolve(ROOT, "server.mjs");
const SMOKE_ENTRY = resolve(ROOT, "synthetic-v12-smoke.mjs");
const MIGRATIONS_ENTRY = resolve(ROOT, "test-migrations.mjs");
const ACTIVATION_ENTRY = resolve(ROOT, "test-activation.mjs");
const CLEANUP_ENTRY = resolve(ROOT, "synthetic-v12-cleanup.mjs");
const DISCOVERY_ENTRY = resolve(ROOT, "synthetic-v12-discovery.mjs");
const LEDGER_DIAGNOSTIC_ENTRY = resolve(ROOT, "ledger-reconciliation-diagnostic.mjs");
const OUTDIR = resolve(ROOT, "dist");
const options = {
  entryPoints: {
    server: ENTRY,
    "synthetic-v12-smoke": SMOKE_ENTRY,
    "test-migrations": MIGRATIONS_ENTRY,
    "test-activation": ACTIVATION_ENTRY,
    "synthetic-v12-cleanup": CLEANUP_ENTRY,
    "synthetic-v12-discovery": DISCOVERY_ENTRY,
    "ledger-reconciliation-diagnostic": LEDGER_DIAGNOSTIC_ENTRY,
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
};
if (process.argv.includes("--check")) {
  await build({ ...options, write: false });
  console.log(JSON.stringify({
    status: "ok",
    mode: "check",
    entries: ["server.mjs", "synthetic-v12-smoke.mjs", "test-migrations.mjs", "test-activation.mjs", "synthetic-v12-cleanup.mjs", "synthetic-v12-discovery.mjs", "ledger-reconciliation-diagnostic.mjs"],
  }));
} else {
  await mkdir(OUTDIR, { recursive: true });
  await build(options);
  console.log(JSON.stringify({
    status: "ok",
    mode: "build",
    outputs: ["dist/server.mjs", "dist/synthetic-v12-smoke.mjs", "dist/test-migrations.mjs", "dist/test-activation.mjs", "dist/synthetic-v12-cleanup.mjs", "dist/synthetic-v12-discovery.mjs", "dist/ledger-reconciliation-diagnostic.mjs"],
  }));
}
