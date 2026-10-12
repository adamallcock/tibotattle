// E12 local end-to-end: build the edge Worker bundle without uploading it.
//
// Runs `wrangler deploy --dry-run --outdir <mkdtemp>` with
// scripts/edge-e2e/wrangler.edge-e2e.jsonc (main ../../src/edge-entry.ts, the
// checked-in compatibility date and flags, no account, route or binding), so
// the module workerd runs in the end-to-end test is the module the edge would
// deploy. Wrangler runs with metrics off and with every CLOUDFLARE_* and
// WRANGLER_* credential variable removed from its environment; --dry-run never
// uploads, and nothing here can reach an account.
//
// `main` builds another entry with the same settings (the checked-in
// wrangler.jsonc main, for the worker-mode byte-identity rows). `edgeTree`
// (EDGE_E2E_EDGE_TREE) builds the edge from another checkout, such as an
// edge-port worktree, and refuses unless that tree's
// src/edge-origin-contract.ts is byte-identical to this one's (EP-10's
// contract-blob rule).

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "jsonc-parser";

const execFileAsync = promisify(execFile);
export const EDGE_E2E_WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const EDGE_E2E_CONFIG = join(EDGE_E2E_WORKER_ROOT, "scripts", "edge-e2e", "wrangler.edge-e2e.jsonc");
export const EDGE_ENTRY_MAIN = "src/edge-entry.ts";
export const CONTRACT_PATH = "src/edge-origin-contract.ts";
const WRANGLER_TIMEOUT_MS = 300_000;

function bundleError(code, details = {}) {
  return Object.assign(new Error(code), { code, details });
}

/** The environment wrangler runs with: PATH and HOME only, metrics off. */
export function wranglerEnvironment(env = process.env) {
  return {
    PATH: env.PATH ?? "",
    HOME: env.HOME ?? "",
    WRANGLER_SEND_METRICS: "false",
    CI: "1",
  };
}

/** The e2e config's compatibility settings and the checked-in wrangler.jsonc's, for the drift check. */
export async function readCompatibility(workerRoot = EDGE_E2E_WORKER_ROOT) {
  const e2e = parse(await readFile(EDGE_E2E_CONFIG, "utf8"));
  const checkedIn = parse(await readFile(join(workerRoot, "wrangler.jsonc"), "utf8"));
  return {
    e2e: { date: e2e.compatibility_date, flags: e2e.compatibility_flags, main: e2e.main },
    checkedIn: { date: checkedIn.compatibility_date, flags: checkedIn.compatibility_flags, main: checkedIn.main },
  };
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** The names in the bundle's final `export { ... }` clause. */
export function bundleExportNames(source) {
  const match = /export\s*\{([^}]*)\}\s*;\s*(?:\/\/# sourceMappingURL=[^\n]*\s*)?$/u.exec(source);
  if (match === null) return [];
  return match[1].split(",").map((entry) => entry.trim()).filter(Boolean)
    .map((entry) => entry.split(/\s+as\s+/u).at(-1)).sort();
}

/**
 * Builds one bundle and returns {directory, modulePath, main, sha256,
 * contractSha256, exports, cleanup}. The caller disposes it with cleanup().
 */
export async function buildEdgeBundle({
  workerRoot = EDGE_E2E_WORKER_ROOT,
  edgeTree = null,
  main = EDGE_ENTRY_MAIN,
  env = process.env,
} = {}) {
  const tree = edgeTree === null ? workerRoot : resolve(edgeTree);
  if (!existsSync(join(tree, main))) throw bundleError("EDGE_BUNDLE_MAIN_MISSING", { main });
  const contractSha256 = await sha256File(join(workerRoot, CONTRACT_PATH));
  if (tree !== workerRoot) {
    const edgeContract = await sha256File(join(tree, CONTRACT_PATH));
    if (edgeContract !== contractSha256) throw bundleError("EDGE_BUNDLE_CONTRACT_DRIFT");
  }
  const directory = await realpath(await mkdtemp(join(tmpdir(), "edge-e2e-bundle-")));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const config = parse(await readFile(EDGE_E2E_CONFIG, "utf8"));
    config.main = join(tree, main);
    const configPath = join(directory, "wrangler.json");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const outdir = join(directory, "out");
    const wrangler = join(workerRoot, "node_modules", ".bin", "wrangler");
    try {
      await execFileAsync(wrangler, ["deploy", "--dry-run", "--outdir", outdir, "--config", configPath], {
        cwd: tree,
        env: wranglerEnvironment(env),
        timeout: WRANGLER_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      throw bundleError("EDGE_BUNDLE_BUILD_FAILED", { exitCode: error?.code ?? null });
    }
    const entryName = main.split("/").at(-1).replace(/\.ts$/u, ".js");
    const modulePath = join(outdir, entryName);
    if (!existsSync(modulePath)) throw bundleError("EDGE_BUNDLE_OUTPUT_MISSING", { entryName });
    const source = await readFile(modulePath, "utf8");
    return Object.freeze({
      directory: outdir,
      modulePath,
      main,
      tree,
      sha256: createHash("sha256").update(source).digest("hex"),
      bytes: Buffer.byteLength(source),
      contractSha256,
      exports: Object.freeze(bundleExportNames(source)),
      cleanup,
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
}
