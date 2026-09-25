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
const LEDGER_RECONCILE_ENTRY = resolve(ROOT, "ledger-preflight-reconcile.mjs");
const COMMUNITY_GRAPH_BENCHMARK_ENTRY = resolve(ROOT, "postgres-community-graph-benchmark.mjs");
const COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_ENTRY = resolve(ROOT, "postgres-community-graph-readback-diagnostic.mjs");
const COMMUNITY_DAILY_TEST_ENTRY = resolve(ROOT, "postgres-community-daily-publish-test.mjs");
const COMMUNITY_DAILY_LIVE_SMOKE_ENTRY = resolve(ROOT, "postgres-community-daily-live-smoke.mjs");
const COMMUNITY_DAILY_PREPARE_ENTRY = resolve(ROOT, "postgres-community-daily-prepare-test.mjs");
const COMMUNITY_DAILY_RESTORE_ENTRY = resolve(ROOT, "postgres-community-daily-restore-test.mjs");
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
    "ledger-preflight-reconcile": LEDGER_RECONCILE_ENTRY,
    "postgres-community-graph-benchmark": COMMUNITY_GRAPH_BENCHMARK_ENTRY,
    "postgres-community-graph-readback-diagnostic": COMMUNITY_GRAPH_READBACK_DIAGNOSTIC_ENTRY,
    "postgres-community-daily-publish-test": COMMUNITY_DAILY_TEST_ENTRY,
    "postgres-community-daily-live-smoke": COMMUNITY_DAILY_LIVE_SMOKE_ENTRY,
    "postgres-community-daily-prepare-test": COMMUNITY_DAILY_PREPARE_ENTRY,
    "postgres-community-daily-restore-test": COMMUNITY_DAILY_RESTORE_ENTRY,
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
    entries: ["server.mjs", "synthetic-v12-smoke.mjs", "test-migrations.mjs", "test-activation.mjs", "synthetic-v12-cleanup.mjs", "synthetic-v12-discovery.mjs", "ledger-reconciliation-diagnostic.mjs", "ledger-preflight-reconcile.mjs", "postgres-community-graph-benchmark.mjs", "postgres-community-graph-readback-diagnostic.mjs", "postgres-community-daily-publish-test.mjs", "postgres-community-daily-live-smoke.mjs", "postgres-community-daily-prepare-test.mjs", "postgres-community-daily-restore-test.mjs"],
  }));
} else {
  await mkdir(OUTDIR, { recursive: true });
  await build(options);
  console.log(JSON.stringify({
    status: "ok",
    mode: "build",
    outputs: ["dist/server.mjs", "dist/synthetic-v12-smoke.mjs", "dist/test-migrations.mjs", "dist/test-activation.mjs", "dist/synthetic-v12-cleanup.mjs", "dist/synthetic-v12-discovery.mjs", "dist/ledger-reconciliation-diagnostic.mjs", "dist/ledger-preflight-reconcile.mjs", "dist/postgres-community-graph-benchmark.mjs", "dist/postgres-community-graph-readback-diagnostic.mjs", "dist/postgres-community-daily-publish-test.mjs", "dist/postgres-community-daily-live-smoke.mjs", "dist/postgres-community-daily-prepare-test.mjs", "dist/postgres-community-daily-restore-test.mjs"],
  }));
}
