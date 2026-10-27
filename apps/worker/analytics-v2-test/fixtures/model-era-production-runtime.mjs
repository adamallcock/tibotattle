// The resource-bound cases qualify the same Node ESM graph as Cloud Run.
// Keep the ordinary source imports and independent pricer oracle unbound.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { cloudRunBuildPlugins, assertNodeHostAlias } from "../../cloud-run/node-host-build.mjs";
import { assertAnalyticsFastPricerBinding } from "../../cloud-run/analytics-fast-pricer-binding.mjs";
import { assertTelemetryByteBoundsBinding } from "../../cloud-run/telemetry-byte-bounds-binding.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENTRY = resolve(ROOT, "src/analytics-v2/model-era-composition.ts");
const EXPORTS = ["ANALYTICS_V2_PLAN_ERA_COMPOSITION_VERSION", "evaluateAnalyticsV2PlanEraComposition",
  "modelCompositionNeedsEraPartition"].sort();
const EXTERNALS = new Set(["node:buffer", "node:crypto", "node:util", "jsonc-parser"]);

/** The missing-binding option is solely the deliberate negative control. */
export async function loadProductionModelEraEvaluator({ omitFastPricer = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "analytics-model-era-production-"));
  try {
    const file = join(directory, "model-era.mjs");
    const plugins = cloudRunBuildPlugins(ROOT)
      .filter(plugin => !omitFastPricer || plugin.name !== "analytics-v2-fast-pricer");
    const result = await build({ entryPoints: [ENTRY], bundle: true, platform: "node", format: "esm",
      target: "node22", write: false, metafile: true, sourcemap: false, logLevel: "silent",
      absWorkingDir: ROOT, outfile: file,
      external: ["@google-cloud/cloud-sql-connector", "google-auth-library", "jsonc-parser", "pg"], plugins });
    // These guards inspect the actual resolved edges, not module-name presence.
    assertAnalyticsFastPricerBinding(result.metafile, ROOT);
    assertTelemetryByteBoundsBinding(result.metafile, { workerRoot: ROOT, cwd: ROOT, requiredEntries: [ENTRY] });
    assertNodeHostAlias(result.metafile, { workerRoot: ROOT, cwd: ROOT, requiredEntries: [ENTRY] });
    const consumer = resolve(ROOT, "vendor/analytics-d43c8f92/apps/worker/src/quota-analysis-v11.ts");
    const input = Object.entries(result.metafile.inputs).find(([path]) => resolve(ROOT, path) === consumer)?.[1];
    const cryptoEdge = input?.imports.find(edge => edge.original === "./crypto");
    assert.ok(cryptoEdge && !cryptoEdge.external
      && resolve(ROOT, cryptoEdge.path) === resolve(ROOT, "cloud-run/node-host-primitives.mjs"),
    "MODEL_ERA_NODE_HOST_BINDING_MISSING");
    const outputs = Object.values(result.metafile.outputs);
    assert.equal(outputs.length, 1);
    assert.equal(result.outputFiles.length, 1);
    assert.deepEqual([...outputs[0].exports].sort(), EXPORTS);
    for (const edge of outputs[0].imports) {
      assert.ok(edge.external && edge.kind === "import-statement" && EXTERNALS.has(edge.path),
        "MODEL_ERA_RUNTIME_EXTERNAL_ESCAPE");
    }
    // Cloud Run leaves jsonc-parser external; Node loads its CommonJS main.
    // Link only that exact installed package, never an ambient ancestor tree.
    const packageRoot = await realpath(resolve(ROOT, "node_modules/jsonc-parser"));
    const installed = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    const workerLock = JSON.parse(await readFile(resolve(ROOT, "package-lock.json"), "utf8"));
    const cloudLock = JSON.parse(await readFile(resolve(ROOT, "cloud-run/package-lock.json"), "utf8"));
    const worker = workerLock.packages["node_modules/jsonc-parser"];
    const cloud = cloudLock.packages["node_modules/jsonc-parser"];
    assert.equal(installed.name, "jsonc-parser");
    assert.deepEqual([worker.version, worker.resolved, worker.integrity], [cloud.version, cloud.resolved, cloud.integrity]);
    assert.equal(installed.version, worker.version);
    assert.equal(Object.keys(installed.dependencies ?? {}).length, 0);
    await mkdir(join(directory, "node_modules"));
    await symlink(packageRoot, join(directory, "node_modules/jsonc-parser"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(file, result.outputFiles[0].text);
    const module = await import(/* @vite-ignore */ pathToFileURL(file).href);
    assert.deepEqual(Object.keys(module).sort(), EXPORTS);
    return { evaluate: module.evaluateAnalyticsV2PlanEraComposition };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
