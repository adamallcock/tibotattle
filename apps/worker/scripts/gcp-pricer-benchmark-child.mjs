import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { loadPricers } from "./gcp-pricer-perf-lib.mjs";

const [implementation, state, entrypoint, callsText, sampleFile] = process.argv.slice(2);
const calls = Number(callsText);
assert.ok(Number.isSafeInteger(calls) && calls > 0);
const sample = JSON.parse(await readFile(sampleFile, "utf8"));
const runtime = await loadPricers({ bound: implementation === "fast" });
try {
  const pricer = entrypoint === "record" ? runtime.module.priceChunkUsageRecord
    : implementation === "fast" ? runtime.module.createFastTelemetryUsagePricer() : runtime.module.priceTelemetryUsageEvent;
  const records = entrypoint === "record" ? sample.map((event) => [JSON.stringify(event.record), event.time]) : null;
  const events = entrypoint === "event" ? sample.map(({ record, time }) => runtime.module.buildPricingEvent(record, time)) : null;
  const call = entrypoint === "event" ? (i) => pricer(events[i % events.length])
    : (i) => pricer(...records[i % records.length]);
  if (state === "warm") for (let i = 0; i < 25_000; i += 1) call(i);
  global.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  console.log(JSON.stringify({ marker: "begin", heapBefore }));
  const cpuBefore = process.cpuUsage(), start = performance.now();
  let checksum = 0;
  for (let i = 0; i < calls; i += 1) { const result = call(i); checksum += result?.costNanousd ?? 0; }
  const wallUs = (performance.now() - start) * 1000;
  const cpu = process.cpuUsage(cpuBefore);
  const heapAfter = process.memoryUsage().heapUsed;
  console.log(JSON.stringify({ marker: "end", implementation, state, entrypoint, calls, checksum,
    wallUsPerCall: wallUs / calls, cpuUsPerCall: (cpu.user + cpu.system) / calls, heapAfter }));
} finally { await runtime.dispose(); }
