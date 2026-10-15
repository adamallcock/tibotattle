#!/usr/bin/env node
// Dry run of the edge-mode deploy candidates on the production line, with no
// remote call.
//
// For each mode, the config a typed --edge-mode deploy installs: the typed
// render of EP-9's synthetic live snapshot (scripts/fixtures/
// edge-mode-live-snapshot.synthetic.json) with the EP-9 overlay applied, along
// the allowed path worker -> (edge secrets put) -> fenced -> gcp. Each config
// is bundled with `wrangler deploy --env production --dry-run --outdir`, so
// wrangler validates it and builds src/edge-entry.ts; nothing is uploaded, no
// account is read, and wrangler runs with PATH and HOME only, so no
// Cloudflare credential reaches it. The release assets directory is replaced
// by a one-file synthetic site in a private temporary directory.
//
// This is the production-line port of the GCP line's
// scripts/edge-e2e/edge-mode-dry-run.mjs (claude/gcp-fastpath-final). The E12
// harness stays on that line; this file inlines the two helpers it used from
// it (the wrangler environment and the bundle export reader), and pins the
// main-module exports of this line's index.ts.
//
// Prints one JSON line per mode: the overlay sha256, the entry, the mode var,
// the storage bindings, and the bundle's size and export names.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "jsonc-parser";
import {
  applyEdgeModeOverlay,
  applyEdgeModeSnapshotDelta,
  edgeModeOverlaySha256,
  serializeEdgeModeConfig,
} from "./edge-mode-configuration.mjs";
import { createProductionLiveConfigSnapshot, renderProductionLiveConfig } from "./production-live-config.mjs";

const execFileAsync = promisify(execFile);
export const EDGE_MODE_DRY_RUN_WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(EDGE_MODE_DRY_RUN_WORKER_ROOT, "scripts", "fixtures", "edge-mode-live-snapshot.synthetic.json");
const EDGE_SECRETS = Object.freeze([
  { name: "EDGE_CLIENT_KEY_SECRET", type: "secret_text" },
  { name: "EDGE_INVOKER_KEY_JSON", type: "secret_text" },
]);
/** A synthetic gcp plan: run.app origin, audience, invoker and release-guard D1, none real. */
export const EDGE_MODE_DRY_RUN_PLAN = Object.freeze({
  upstreamOrigin: "https://edge-e2e-origin-000000000000.us-east1.run.app",
  originAudience: "https://edge-e2e-origin-000000000000.us-east1.run.app",
  invokerServiceAccount: "edge-e2e-invoker@synthetic-edge-0.iam.gserviceaccount.com",
  releaseGuardDatabase: Object.freeze({ id: "77777777-7777-4777-8777-777777777777", name: "synthetic-release-guard" }),
});

/** The environment wrangler runs with: PATH and HOME only, metrics off. */
export function wranglerEnvironment(env = process.env) {
  return {
    PATH: env.PATH ?? "",
    HOME: env.HOME ?? "",
    WRANGLER_SEND_METRICS: "false",
    CI: "1",
  };
}

/** The names in the bundle's final `export { ... }` clause. */
export function bundleExportNames(source) {
  const match = /export\s*\{([^}]*)\}\s*;\s*(?:\/\/# sourceMappingURL=[^\n]*\s*)?$/u.exec(source);
  if (match === null) return [];
  return match[1].split(",").map((entry) => entry.trim()).filter(Boolean)
    .map((entry) => entry.split(/\s+as\s+/u).at(-1)).sort();
}

/** EP-9 check's inventoryOf: the provider inventory a snapshot was captured from. */
function inventoryOf(snapshot, bindings) {
  const inventoryBindings = bindings.map((binding) => binding.type === "d1"
    ? { ...binding, id: binding.database_id } : binding);
  return {
    accountId: snapshot.accountId,
    workerName: snapshot.workerName,
    version: { id: snapshot.versionId, resources: { script_runtime: snapshot.runtime, bindings: inventoryBindings } },
    settings: {
      ...snapshot.settings,
      compatibility_date: snapshot.runtime.compatibility_date,
      compatibility_flags: snapshot.runtime.compatibility_flags,
      usage_model: snapshot.runtime.usage_model,
      limits: snapshot.runtime.limits,
      cache_options: snapshot.runtime.cache_options,
      bindings: inventoryBindings,
    },
    schedules: { schedules: snapshot.crons.map((cron) => ({ cron })) },
    subdomain: snapshot.subdomain,
    routes: snapshot.routes,
    domains: snapshot.domains,
    namespaces: snapshot.namespaces,
  };
}

/** The three candidate configs along worker -> fenced -> gcp. */
export async function edgeModeCandidates() {
  const trackedConfig = parse(await readFile(join(EDGE_MODE_DRY_RUN_WORKER_ROOT, "wrangler.jsonc"), "utf8"));
  const fixture = JSON.parse(await readFile(FIXTURE, "utf8"));
  const sourceCommit = "e12e12e12e12e12e12e12e12e12e12e12e12e12e";
  const candidate = (snapshot, mode, plan) => applyEdgeModeOverlay({
    renderedConfig: renderProductionLiveConfig({ trackedConfig, snapshot, sourceCommit }), mode, plan, trackedConfig,
  }).config;
  const worker = candidate(fixture, "worker");
  const withSecrets = createProductionLiveConfigSnapshot(inventoryOf(fixture, [...fixture.bindings, ...EDGE_SECRETS]));
  const workerLive = applyEdgeModeSnapshotDelta({ snapshot: withSecrets, mode: "worker", trackedConfig });
  const fenced = candidate(workerLive, "fenced");
  const fencedLive = applyEdgeModeSnapshotDelta({ snapshot: workerLive, mode: "fenced", trackedConfig });
  const gcp = candidate(fencedLive, "gcp", EDGE_MODE_DRY_RUN_PLAN);
  return { worker, fenced, gcp };
}

export async function dryRunEdgeModes({ env = process.env } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "edge-mode-dry-run-"));
  try {
    const assets = join(directory, "assets");
    await mkdir(assets, { mode: 0o700 });
    await writeFile(join(assets, "index.html"), "<!doctype html><title>synthetic edge dry run</title>\n", { mode: 0o600 });
    const results = [];
    for (const [mode, config] of Object.entries(await edgeModeCandidates())) {
      const value = JSON.parse(serializeEdgeModeConfig(config));
      const production = value.env.production;
      production.main = join(EDGE_MODE_DRY_RUN_WORKER_ROOT, production.main);
      if (production.assets) production.assets.directory = assets;
      for (const database of production.d1_databases ?? []) {
        if (database.migrations_dir) database.migrations_dir = join(EDGE_MODE_DRY_RUN_WORKER_ROOT, database.migrations_dir);
      }
      const configPath = join(directory, `${mode}.json`);
      await writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      const outdir = join(directory, `out-${mode}`);
      await execFileAsync(join(EDGE_MODE_DRY_RUN_WORKER_ROOT, "node_modules", ".bin", "wrangler"),
        ["deploy", "--env", "production", "--dry-run", "--outdir", outdir, "--config", configPath],
        { cwd: EDGE_MODE_DRY_RUN_WORKER_ROOT, env: wranglerEnvironment(env), maxBuffer: 16 * 1024 * 1024, timeout: 300_000 });
      const source = await readFile(join(outdir, "edge-entry.js"), "utf8");
      results.push({
        mode,
        overlaySha256: edgeModeOverlaySha256({ mode, plan: mode === "gcp" ? EDGE_MODE_DRY_RUN_PLAN : undefined }),
        main: config.env.production.main,
        modeVar: production.vars?.EDGE_UPSTREAM_MODE ?? null,
        d1: (production.d1_databases ?? []).map((database) => database.binding).sort(),
        r2: (production.r2_buckets ?? []).map((bucket) => bucket.binding).sort(),
        ratelimits: (production.ratelimits ?? []).map((limit) => limit.name).sort(),
        durableObjects: (production.durable_objects?.bindings ?? []).map((binding) => binding.name).sort(),
        crons: production.triggers?.crons ?? null,
        bundleBytes: Buffer.byteLength(source),
        exports: bundleExportNames(source),
      });
    }
    return results;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const DATA_BINDINGS = Object.freeze(["ANALYTICS_DB", "DELETION_LEDGER", "QUARANTINE", "USAGE_MONITOR_DB"]);
const EDGE_RATE_LIMIT_BINDINGS = Object.freeze([
  "CLIENT_ATTEMPT_RATE_LIMIT", "ENROLLMENT_RATE_LIMIT", "PUBLIC_READ_RATE_LIMIT", "RECOVERY_RATE_LIMIT",
  "UPLOAD_INGRESS_CLIENT_RATE_LIMIT", "UPLOAD_INGRESS_REQUEST_RATE_LIMIT",
]);
const OPERATIONAL_RATE_LIMIT_BINDINGS = Object.freeze([
  "PUBLIC_PROBE_RATE_LIMIT", "PUBLIC_PROBE_CLIENT_RATE_LIMIT", "SPARKLE_APPCAST_GUARD_RATE_LIMIT",
]);
/**
 * The edge entry preserves index.ts's handler exports and the Cloudflare
 * UploadIngressBudget Durable Object class. workerd refuses a main module
 * whose named exports are not functions or handlers.
 */
export const MAIN_MODULE_EXPORTS = Object.freeze(["UploadIngressBudget", "contributionRequestPreflight", "default",
  "handleRequest", "isPostgresWorkerRequestPathSupported", "runScheduledMaintenance"]);

/** The properties each candidate must have; returns the violations. */
export function dryRunViolations(results) {
  const violations = [];
  for (const result of results) {
    if (result.main !== "src/edge-entry.ts") violations.push(`${result.mode}: main ${result.main}`);
    if (result.modeVar !== result.mode) violations.push(`${result.mode}: mode var ${result.modeVar}`);
    if (JSON.stringify(result.exports) !== JSON.stringify(MAIN_MODULE_EXPORTS)) {
      violations.push(`${result.mode}: main-module exports ${result.exports.join(",")}`);
    }
    if (EDGE_RATE_LIMIT_BINDINGS.some((name) => !result.ratelimits.includes(name))) {
      violations.push(`${result.mode}: an edge rate-limit binding is missing`);
    }
    if (OPERATIONAL_RATE_LIMIT_BINDINGS.some((name) => !result.ratelimits.includes(name))) {
      violations.push(`${result.mode}: an operational rate-limit binding is missing`);
    }
    if (!result.durableObjects.includes("UPLOAD_INGRESS_BUDGET")) {
      violations.push(`${result.mode}: the Durable Object binding is missing`);
    }
    const storage = [...result.d1, ...result.r2];
    if (result.mode === "gcp") {
      if (DATA_BINDINGS.some((name) => storage.includes(name))) violations.push("gcp: a data binding survives");
      if (!result.d1.includes("RELEASE_GUARD_DB") || !result.r2.includes("SPARKLE_RELEASES")) {
        violations.push("gcp: the release guard D1 or the Sparkle bucket is missing");
      }
      if (!Array.isArray(result.crons) || result.crons.length !== 0) violations.push("gcp: crons are not empty");
    } else {
      if (DATA_BINDINGS.some((name) => !storage.includes(name))) {
        violations.push(`${result.mode}: a data binding is missing`);
      }
      if (result.d1.includes("RELEASE_GUARD_DB")) violations.push(`${result.mode}: the release guard D1 is bound`);
    }
  }
  if (results.map((result) => result.mode).join() !== "worker,fenced,gcp") violations.push("modes");
  return violations;
}

if (process.argv[1] && process.argv[1].endsWith("edge-mode-dry-run.mjs")) {
  dryRunEdgeModes().then((results) => {
    for (const result of results) process.stdout.write(`${JSON.stringify(result)}\n`);
    const violations = dryRunViolations(results);
    if (violations.length > 0) {
      process.stderr.write(`${JSON.stringify({ status: "failed", violations })}\n`);
      process.exitCode = 1;
    }
  }, (error) => {
    process.stderr.write(`${JSON.stringify({ status: "error", code: error?.code ?? "EDGE_MODE_DRY_RUN_FAILED" })}\n`);
    process.exitCode = 1;
  });
}
