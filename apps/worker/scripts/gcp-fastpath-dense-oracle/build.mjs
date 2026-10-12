// Build the dense production-code oracle bundle from d43c8f92's own source.
//
//   node apps/worker/scripts/gcp-fastpath-dense-oracle/build.mjs --work-dir <absolute dir outside the repo>
//
// 1. Materializes apps/worker and packages exactly as committed at d43c8f92
//    (`git archive`) into <work-dir>/src-d43c8f92, then proves every file of
//    apps/worker/src, apps/worker/test/{helpers,fixtures}, the nine migration
//    directories and packages/{accounting,quota-analysis,telemetry-contract}
//    hashes to the d43c8f92 blob (git hash-object). Production code is never
//    edited; the only added file is the re-export entry (entry.ts), placed at
//    apps/worker/test/gcp-fastpath-dense-oracle-entry.ts so its relative
//    imports reach d43c8f92's src/ and test/ directories.
// 2. Bundles that entry for Node with esbuild (format esm, inline source maps)
//    into <work-dir>/bundle/oracle-d43c8f92.mjs. The workspace packages resolve
//    to the materialized d43c8f92 packages; the three npm dependencies
//    (jsonc-parser, oauth4webapi, runcost) resolve from this worktree's
//    apps/worker/node_modules after their versions are checked against
//    d43c8f92's apps/worker/package-lock.json. `cloudflare:workers` and
//    `cloudflare:test` resolve to the Node stand-ins in ./shims.
// 3. Writes <work-dir>/bundle/BUILD.json: the commit, the verified blob count,
//    the dependency versions and the bundle's sha256.
//
// Local and synthetic only: nothing here reads a database or a network.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DENSE_ORACLE_SOURCE_COMMIT = "d43c8f92a059d9c577776f7eca8a331eb305b8a6";
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(HERE, "../..");
const REPO_ROOT = resolve(WORKER_ROOT, "../..");
const ENTRY_TARGET = "apps/worker/test/gcp-fastpath-dense-oracle-entry.ts";
/** Every path whose content the oracle runs, checked blob by blob. */
const VERIFIED_PREFIXES = Object.freeze([
  "apps/worker/src/", "apps/worker/test/helpers/", "apps/worker/test/fixtures/",
  "apps/worker/migrations/", "apps/worker/typed-ingestion-migrations/", "apps/worker/ingestion-bridge-migrations/",
  "apps/worker/typed-v1-admission-migrations/", "apps/worker/typed-v11-admission-migrations/",
  "apps/worker/ingestion-isolation-migrations/", "apps/worker/analytics-migrations/",
  "apps/worker/deletion-ledger-migrations/", "apps/worker/routing-migrations/",
  "apps/worker/wrangler.jsonc", "apps/worker/package-lock.json",
  "packages/accounting/", "packages/quota-analysis/", "packages/telemetry-contract/",
]);
const NPM_DEPENDENCIES = Object.freeze(["jsonc-parser", "oauth4webapi", "runcost"]);

const git = (...args) => execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

function fail(code, details = {}) {
  throw Object.assign(new Error(code), { code, details });
}

/** Materialize and verify d43c8f92; returns the tree root and the verified file count. */
export function materializeD43c8f92(workDir) {
  const tree = join(workDir, "src-d43c8f92");
  if (git("rev-parse", `${DENSE_ORACLE_SOURCE_COMMIT}^{commit}`).trim() !== DENSE_ORACLE_SOURCE_COMMIT) {
    fail("DENSE_ORACLE_SOURCE_COMMIT_MISSING");
  }
  if (!existsSync(join(tree, "apps/worker/src"))) {
    mkdirSync(tree, { recursive: true });
    const archive = execFileSync("git", ["-C", REPO_ROOT, "archive", DENSE_ORACLE_SOURCE_COMMIT, "apps/worker", "packages"],
      { maxBuffer: 1024 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", tree], { input: archive });
  }
  const listing = git("ls-tree", "-r", DENSE_ORACLE_SOURCE_COMMIT, "--", "apps/worker", "packages")
    .trim().split("\n").map((line) => {
      const [meta, path] = line.split("\t");
      const [, type, blob] = meta.split(" ");
      return { type, blob, path };
    }).filter((entry) => entry.type === "blob" && VERIFIED_PREFIXES.some((prefix) => entry.path.startsWith(prefix)));
  if (listing.length < 300) fail("DENSE_ORACLE_SOURCE_LISTING_SHORT", { files: listing.length });
  const hashed = execFileSync("git", ["hash-object", "--no-filters", "--stdin-paths"], {
    input: listing.map((entry) => join(tree, entry.path)).join("\n"), encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  }).trim().split("\n");
  const mismatched = listing.filter((entry, index) => hashed[index] !== entry.blob).map((entry) => entry.path);
  if (mismatched.length > 0) fail("DENSE_ORACLE_SOURCE_BLOB_MISMATCH", { mismatched: mismatched.slice(0, 20) });
  return { tree, verifiedFiles: listing.length,
    listingSha256: createHash("sha256").update(listing.map((entry) => `${entry.blob} ${entry.path}`).join("\n")).digest("hex") };
}

/** The d43c8f92 lockfile versions of the bundled npm dependencies, checked against node_modules. */
function dependencyVersions(tree, nodeModules) {
  const lock = JSON.parse(readFileSync(join(tree, "apps/worker/package-lock.json"), "utf8"));
  const versions = {};
  for (const name of NPM_DEPENDENCIES) {
    const locked = lock.packages?.[`node_modules/${name}`]?.version;
    const installed = JSON.parse(readFileSync(join(nodeModules, name, "package.json"), "utf8")).version;
    if (typeof locked !== "string" || locked !== installed) {
      fail("DENSE_ORACLE_DEPENDENCY_VERSION_MISMATCH", { name, locked, installed });
    }
    versions[name] = installed;
  }
  return versions;
}

export async function buildDenseOracle({ workDir }) {
  if (typeof workDir !== "string" || !isAbsolute(workDir)) fail("DENSE_ORACLE_WORK_DIR_INVALID");
  if (!relative(REPO_ROOT, workDir).startsWith("..")) fail("DENSE_ORACLE_WORK_DIR_INSIDE_REPOSITORY");
  mkdirSync(workDir, { recursive: true });
  const { tree, verifiedFiles, listingSha256 } = materializeD43c8f92(workDir);
  copyFileSync(join(HERE, "entry.ts"), join(tree, ENTRY_TARGET));
  const nodeModules = join(WORKER_ROOT, "node_modules");
  const versions = dependencyVersions(tree, nodeModules);
  const { build, version: esbuildVersion } = await import(join(nodeModules, "esbuild/lib/main.js"));
  const outdir = join(workDir, "bundle");
  mkdirSync(outdir, { recursive: true });
  const outfile = join(outdir, "oracle-d43c8f92.mjs");
  const shims = {
    "cloudflare:workers": join(HERE, "shims/cloudflare-workers.mjs"),
    "cloudflare:test": join(HERE, "shims/cloudflare-test.mjs"),
  };
  await build({
    entryPoints: [join(tree, ENTRY_TARGET)],
    bundle: true, platform: "node", format: "esm", target: "node24",
    outfile, sourcemap: "inline", logLevel: "silent", legalComments: "none",
    alias: Object.fromEntries(["accounting", "quota-analysis", "telemetry-contract"]
      .map((name) => [`@app-usagemonitor/${name}`, join(tree, "packages", name)])),
    nodePaths: [nodeModules],
    // Resolve npm packages as Wrangler does for workerd (ESM/browser builds).
    conditions: ["workerd", "worker", "browser"], mainFields: ["browser", "module", "main"],
    plugins: [{
      name: "cloudflare-shims",
      setup(builder) {
        builder.onResolve({ filter: /^cloudflare:(workers|test)$/ }, (args) => ({ path: shims[args.path] }));
      },
    }],
  });
  const bundleSha256 = createHash("sha256").update(readFileSync(outfile)).digest("hex");
  const receipt = {
    schemaVersion: "gcp-fastpath-dense-oracle-build-v1",
    sourceCommit: DENSE_ORACLE_SOURCE_COMMIT, verifiedFiles, listingSha256,
    entry: { path: ENTRY_TARGET, sha256: createHash("sha256").update(readFileSync(join(HERE, "entry.ts"))).digest("hex") },
    esbuildVersion, dependencies: versions, bundle: { path: outfile, sha256: bundleSha256 },
  };
  writeFileSync(join(outdir, "BUILD.json"), `${JSON.stringify(receipt, null, 1)}\n`);
  return { ...receipt, tree };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const index = args.indexOf("--work-dir");
  try {
    const receipt = await buildDenseOracle({ workDir: index < 0 ? undefined : resolve(args[index + 1] ?? "") });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error.code ?? "DENSE_ORACLE_BUILD_FAILED", message: error.message,
      details: error.details ?? null })}\n`);
    process.exitCode = 1;
  }
}
