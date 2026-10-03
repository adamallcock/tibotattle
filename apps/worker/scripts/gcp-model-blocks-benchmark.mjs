/** Local synthetic-only block clone/cold-cache benchmark; never connects to a database. */
import { build } from "esbuild";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import { deserialize, serialize } from "node:v8";
import { cloudRunBuildPlugins } from "../cloud-run/node-host-build.mjs";
import { analyticsRefreshSerializationBound } from "../cloud-run/analytics-refresh-worker.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--synthetic-input") {
  throw new Error("Usage: node scripts/gcp-model-blocks-benchmark.mjs --synthetic-input <v8-serialized-owner-input.bin>");
}
// The local measurement adapter must supply the synthetic o01 owner input:
// {context,owner,evidence:Map,occurrences:Map,load:null}. No persisted artifact
// is created, and neither its source path nor any row content is printed.
if ((await stat(args[1])).size > 2048 * 1048576) throw new Error("MODEL_BLOCKS_BENCHMARK_INPUT_TOO_LARGE");
const input = deserialize(await readFile(args[1]));
if (!(input?.occurrences instanceof Map) || !(input?.evidence instanceof Map) || input.load !== null
    || !Array.isArray(input.context?.modelDates) || input.context.modelDates.length !== 70) {
  throw new Error("MODEL_BLOCKS_BENCHMARK_INPUT_INVALID");
}
const temp = await mkdtemp(join(tmpdir(), "tibotattle-model-blocks-benchmark-"));
try {
  const units = join(root, "src/analytics-v2/units.ts");
  const entry = join(temp, "entry.ts");
  await writeFile(entry, `export { computeAnalyticsV2Owner } from ${JSON.stringify(join(root, "src/analytics-v2/compute-owner.ts"))};
export { modelBlockPayload, partitionModelDates } from ${JSON.stringify(units)};`);
  const workerEntry = join(temp, "worker.ts");
  await writeFile(workerEntry, `
import { parentPort, workerData } from "node:worker_threads";
import { deserialize, getHeapStatistics } from "node:v8";
import { createHash } from "node:crypto";
import { evaluateModelBlock } from ${JSON.stringify(units)};
import { canonicalJson } from ${JSON.stringify(join(root, "src/canonical-json.ts"))};
parentPort!.once("message", async ({serialized}) => {
  try {
    const begin = performance.now(); const payload = deserialize(serialized); serialized = null;
    const deserializeMs = performance.now()-begin;
    globalThis.__modelBlockMemo = {d1AttributionMs:0,d1AttributionRows:0,d1PriceMs:0,d1PriceRows:0};
    const coldStart = performance.now(); const cold = await evaluateModelBlock(payload);
    const coldMs = performance.now()-coldStart;
    const coldHeapBytes = getHeapStatistics().used_heap_size;
    const coldMemo = {...globalThis.__modelBlockMemo};
    globalThis.__modelBlockMemo = {d1AttributionMs:0,d1AttributionRows:0,d1PriceMs:0,d1PriceRows:0};
    const warmStart = performance.now(); const warm = await evaluateModelBlock(payload);
    const warmMs = performance.now()-warmStart;
    const digest = (value) => createHash("sha256").update(canonicalJson(value)).digest("hex");
    if (cold.some((date) => "terminalError" in date) || digest(cold) !== digest(warm)) throw new Error("MODEL_BLOCKS_BENCHMARK_PARITY_FAILED");
    parentPort!.postMessage({ deserializeMs,coldMs,warmMs,coldMinusWarmMs:coldMs-warmMs,
      d1MemoRebuildMs:coldMemo.d1AttributionMs+coldMemo.d1PriceMs,d1Memo:coldMemo,d1WarmMemo:{...globalThis.__modelBlockMemo},
      quotaMemoRebuildMs:null,quotaMemoUnavailable:"separately owned quota memo timing boundary pending combined fold",
      memoTimingScope:"instrumented synchronous d1 cache-miss attribution+pricing; includes timer overhead",coldHeapBytes,
      sampledHeapPeakBytes:Math.max(coldHeapBytes,getHeapStatistics().used_heap_size),digest:digest(cold) });
  } catch { parentPort!.postMessage({failed:true}); }
});`);
  // Benchmark-only esbuild transform: time exactly the d1 cache-miss work,
  // never modify vendor files or the production Worker artifact. Refuse drift
  // rather than silently report a stale timing boundary.
  const memoTimingPlugin = {
    name: "model-blocks-benchmark-memo-timing",
    setup(builder) {
      builder.onLoad({ filter: /quota-analysis-v11\.ts$/ }, async ({ path }) => {
        const source = await readFile(path, "utf8");
        const memoStart = "  const record = parseStoredRecordJson(row.record_json);";
        const memoEnd = "  return memo;\n}\nfunction usageRowEvidencePrice";
        const priceStart = "  const priced = priceChunkUsageRecord(row.record_json, row.observed_at);";
        const priceEnd = "  return { ...priced, modelId: internUsageRowValue(usageRowModels, priced.modelId, priced.modelId) };\n}";
        const start = source.indexOf("function usageRowEvidenceMemo(row:");
        if (start < 0) throw new Error("MODEL_BLOCKS_BENCHMARK_MEMO_BOUNDARY_INVALID");
        const head = source.slice(0, start), tail = source.slice(start);
        for (const marker of [memoStart, memoEnd, priceStart, priceEnd]) {
          if (tail.split(marker).length !== 2) throw new Error("MODEL_BLOCKS_BENCHMARK_MEMO_BOUNDARY_INVALID");
        }
        const clockStart = "const benchmarkMemoStart = performance.now(); try {";
        const clockEnd = (kind) => `} finally { globalThis.__modelBlockMemo.${kind}Ms += performance.now() - benchmarkMemoStart; globalThis.__modelBlockMemo.${kind}Rows += 1; }`;
        const transformed = tail.replace(memoStart, `${clockStart}\n${memoStart}`)
          .replace(memoEnd, `  return memo;\n${clockEnd("d1Attribution")}\n}\nfunction usageRowEvidencePrice`)
          .replace(priceStart, `${clockStart}\n${priceStart}`)
          .replace(priceEnd, `  return { ...priced, modelId: internUsageRowValue(usageRowModels, priced.modelId, priced.modelId) };\n${clockEnd("d1Price")}\n}`);
        return { contents: head + transformed, loader: "ts" };
      });
    },
  };
  await build({ entryPoints: { entry, worker: workerEntry }, bundle: true, platform: "node", format: "esm", target: "node22",
    outdir: temp, outExtension: { ".js": ".mjs" }, plugins: [memoTimingPlugin, ...cloudRunBuildPlugins(root)], mainFields: ["module", "main"], logLevel: "silent" });
  const { computeAnalyticsV2Owner, partitionModelDates, modelBlockPayload } = await import(pathToFileURL(join(temp, "entry.mjs")));
  globalThis.__modelBlockMemo = { d1AttributionMs: 0, d1AttributionRows: 0, d1PriceMs: 0, d1PriceRows: 0 };
  let prepared;
  const capture = new Error("MODEL_BLOCKS_BENCHMARK_CAPTURE");
  try {
    await computeAnalyticsV2Owner({ ...input, hooks: { emit: () => {}, accountBytes: () => 0, progress: () => {},
      timed: async (_phase, work) => work(), modelBlocks: { size: 10, fanOut: "all", run: async (value) => {
        prepared = value; throw capture;
      } } } });
  } catch (error) { if (error !== capture) throw error; }
  if (!prepared) throw new Error("MODEL_BLOCKS_BENCHMARK_CAPTURE_FAILED");
  for (const size of [1, 5, 10, 14, 70]) {
    for (const [index, dates] of partitionModelDates(prepared.dates, size).entries()) {
      const payload = modelBlockPayload(prepared, dates);
      const boundBytes = analyticsRefreshSerializationBound(payload);
      const begin = performance.now();
      const serialized = serialize(payload);
      const serializeMs = performance.now() - begin;
      if (serialized.buffer.byteLength > boundBytes) throw new Error("MODEL_BLOCKS_BENCHMARK_BOUND_FAILED");
      const serializedBytes = serialized.byteLength;
      const worker = new Worker(pathToFileURL(join(temp, "worker.mjs")), { env: {}, argv: [],
        resourceLimits: { maxOldGenerationSizeMb: 8192, maxYoungGenerationSizeMb: 192 } });
      const usage = process.cpuUsage();
      try {
        const result = new Promise((resolve, reject) => {
          worker.once("message", resolve); worker.once("error", reject);
          worker.once("exit", () => reject(new Error("MODEL_BLOCKS_BENCHMARK_WORKER_EXITED")));
        });
        worker.postMessage({ serialized }, [serialized.buffer]);
        const measured = await result;
        if (measured.failed) throw new Error("MODEL_BLOCKS_BENCHMARK_WORKER_FAILED");
        const cpu = process.cpuUsage(usage);
        console.log(JSON.stringify({ size, blockIndex: index, dates: dates.length, serializedBytes, boundBytes,
          serializeMs, cloneMs: serializeMs + measured.deserializeMs, ...measured,
          processCpuUserMs: cpu.user / 1000, processCpuSystemMs: cpu.system / 1000,
          // process peak RSS includes retained parent preparation and all earlier
          // samples; it is not an isolated block peak.
          processPeakRssBytes: process.resourceUsage().maxRSS * 1024 }));
      } finally { await worker.terminate(); }
    }
  }
} finally { await rm(temp, { recursive: true, force: true }); }
