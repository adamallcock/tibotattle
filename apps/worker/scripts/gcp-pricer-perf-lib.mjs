import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { analyticsFastPricerPlugin, FAST_PRICER_MODULE } from "../cloud-run/analytics-fast-pricer-binding.mjs";

export const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const COMPONENT_KEYS = ["inputUncachedTokens", "inputCacheReadTokens", "inputCacheWriteTokens",
  "inputCacheWrite5mTokens", "inputCacheWrite1hTokens", "outputTextTokens", "outputReasoningTokens", "outputCombinedTokens"];
const PUBLIC_COMPONENTS = [COMPONENT_KEYS[0], COMPONENT_KEYS[1], COMPONENT_KEYS[2], ...COMPONENT_KEYS.slice(5)];

/** Always bundle an unbound oracle separately; a Vitest import alias is not an oracle. */
export async function loadPricers({ bound = false, instrument = false, registryFailure = false, planLimit = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "gcp-pricer-perf-"));
  try {
    const plugins = bound ? [analyticsFastPricerPlugin()] : [];
    if (instrument) plugins.push({ name: "pricer-binding-proof", setup(builder) {
      builder.onLoad({ filter: /fast-pricer\.ts$/ }, async ({ path }) => {
        assert.equal(path, FAST_PRICER_MODULE);
        const source = await readFile(path, "utf8");
        return { loader: "ts", resolveDir: dirname(path), contents: source.replace(
          "export { fastPriceTelemetryUsageEvent as priceTelemetryUsageEvent };",
          'export function priceTelemetryUsageEvent(row: TelemetryUsageEvent) { globalThis[Symbol.for("gcp-pricer-binding-proof")] = (globalThis[Symbol.for("gcp-pricer-binding-proof")] ?? 0) + 1; return fastPriceTelemetryUsageEvent(row); }') };
      });
    } });
    if (registryFailure || planLimit !== null) plugins.push({ name: "registry-construction-failure", setup(builder) {
      builder.onLoad({ filter: /fast-pricer\.ts$/ }, async ({ path }) => {
        assert.equal(path, FAST_PRICER_MODULE);
        let source = await readFile(path, "utf8");
        if (planLimit !== null) {
          assert.ok(Number.isSafeInteger(planLimit) && planLimit > 0);
          assert.ok(source.includes("const MAX_PLANS = 16_384;"));
          source = source.replace("const MAX_PLANS = 16_384;", `const MAX_PLANS = ${planLimit};`);
        }
        if (!registryFailure) return { loader: "ts", resolveDir: dirname(path), contents: source };
        const marker = "for (const card of APP_OFFICIAL_PRICE_CARDS)";
        assert.ok(source.includes(marker));
        return { loader: "ts", resolveDir: dirname(path), contents: source.replace(marker,
          `for (const card of (function* () {
            let index = 0;
            for (const item of APP_OFFICIAL_PRICE_CARDS) {
              if (index++ === 2 && !globalThis[Symbol.for("gcp-pricer-registry-failed")]) {
                globalThis[Symbol.for("gcp-pricer-registry-failed")] = true;
                throw new RangeError("synthetic registry construction failure");
              }
              yield item;
            }
          })())`) };
      });
    } });
    const result = await build({ stdin: { contents: `
      export * from "./vendor/analytics-d43c8f92/entry";
      export { TELEMETRY_MODEL_IDS } from "./vendor/analytics-d43c8f92/packages/telemetry-contract/index.js";
      export { priceChunkUsageRecord } from "./vendor/analytics-d43c8f92/apps/worker/src/quota-analysis-v1";
      export { createFastTelemetryUsagePricer, fastPriceTelemetryUsageEvent } from "./src/analytics-v2/fast-pricer";
    `, resolveDir: WORKER_ROOT, loader: "ts" }, bundle: true, format: "esm", platform: "node", target: "node22",
      mainFields: ["module", "main"], write: false, plugins, logLevel: "silent" });
    const file = join(directory, "pricers.mjs");
    await writeFile(file, result.outputFiles[0].text);
    const module = await import(pathToFileURL(file).href);
    return { module, dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

export function ordinaryEvent(overrides = {}) {
  return { schemaVersion: "usage-event-v0.1", eventTime: "2026-09-25T12:00:00.000Z",
    provider: "openai_codex", modelId: "gpt-5.6-sol", modelRecognition: "recognized", modelFingerprint: null,
    billingSurface: "chatgpt_subscription", speedMode: "standard", apiServiceTier: "unknown", reasoningEffort: "unknown",
    components: { inputUncachedTokens: 1500, inputCacheReadTokens: 500, inputCacheWriteTokens: 0,
      inputCacheWrite5mTokens: null, inputCacheWrite1hTokens: null, outputTextTokens: 150,
      outputReasoningTokens: 50, outputCombinedTokens: 200 }, totalInputContextTokens: 2000, ...overrides };
}

export function outcome(pricer, event) {
  try { return { json: JSON.stringify(pricer(event)) }; }
  catch (error) { return { errorClass: error.constructor.name, message: error.message }; }
}
export function assertSame(left, right, event, index) {
  const a = outcome(left, event), b = outcome(right, event);
  // Failure diagnostics are content-free: no input row, dictionary value or identifier is printed.
  assert.deepEqual(b, a, `pricer differential mismatch at synthetic case ${index}`);
  return a;
}

/** Read only a manifest-asserted synthetic corpus; project exactly buildPricingEvent's fields. */
export function* corpusRecords(corpusRoot, modulo = 1) {
  const database = new DatabaseSync(join(corpusRoot, "seed/sealed/usage-monitor-db.sqlite"), { readOnly: true });
  try {
    for (const [records, usage, format] of [["typed_telemetry_records", "typed_telemetry_usage", null],
      ["telemetry_v12_records", "telemetry_v12_usage", 12]]) {
      const query = `SELECT r.observed_at_ms AS at, ${format === null ? "r.format" : format} AS format,
        provider.value AS provider, model.value AS modelId, speed.value AS speedMode,
        tier.value AS apiServiceTier, billing.value AS billingSurface, effort.value AS reasoningEffort,
        u.total_input_context_tokens AS totalInputContextTokens,
        u.input_uncached_tokens AS c0, u.input_cache_read_tokens AS c1, u.input_cache_write_tokens AS c2,
        u.output_text_tokens AS c3, u.output_reasoning_tokens AS c4, u.output_combined_tokens AS c5
        FROM ${usage} u JOIN ${records} r ON r.id=u.record_id
        JOIN typed_telemetry_dictionary provider ON provider.id=r.provider_id
        JOIN typed_telemetry_dictionary model ON model.id=u.model_id
        JOIN typed_telemetry_dictionary speed ON speed.id=u.speed_mode_id
        JOIN typed_telemetry_dictionary tier ON tier.id=u.api_service_tier_id
        JOIN typed_telemetry_dictionary billing ON billing.id=u.billing_surface_id
        JOIN typed_telemetry_dictionary effort ON effort.id=u.reasoning_effort_id
        WHERE ${format === null ? "r.stream=1" : "r.stream='usage'"} ${modulo > 1 ? `AND (r.id % ${modulo})=0` : ""}`;
      for (const row of database.prepare(query).iterate()) {
        const components = {};
        for (let i = 0; i < PUBLIC_COMPONENTS.length; i += 1) components[PUBLIC_COMPONENTS[i]] = row[`c${i}`];
        yield { format: row.format, eventTime: new Date(row.at).toISOString(), record: {
          provider: row.provider, modelId: row.modelId, speedMode: row.speedMode,
          apiServiceTier: row.apiServiceTier, billingSurface: row.billingSurface, reasoningEffort: row.reasoningEffort,
          totalInputContextTokens: row.totalInputContextTokens, components,
        } };
      }
    }
  } finally { database.close(); }
}

export async function syntheticManifest(corpusRoot) {
  const manifest = JSON.parse(await readFile(join(corpusRoot, "seed/corpus-manifest.json"), "utf8"));
  assert.equal(manifest.corpus.synthetic, true, "only the explicitly synthetic corpus is authorized");
  return manifest;
}
