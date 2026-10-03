import assert from "node:assert/strict";
import { startNumericMemory, MEMORY_PHASE } from "./analytics-refresh-memory-profile.mjs";
let calls = 0;
assert.equal(startNumericMemory({ adapters: { memory() { calls += 1; } } }), null);
assert.equal(calls, 0);
let tick = 0; let timer; let gc; let canceled = 0; let disconnected = 0;
const adapters = {
  clock: () => tick,
  memory: () => ({ heapUsed: tick + 10, heapTotal: 100, external: 80, arrayBuffers: 50, rss: 200 }),
  heap: () => ({ total_physical_size: 110, used_heap_size: 90, malloced_memory: 4, peak_malloced_memory: 6 }),
  spaces: () => [{ space_name: "old_space", space_size: 100, space_used_size: 90, space_available_size: 10, physical_space_size: 100 }, { space_name: "private-unrecognized", space_size: 999 }],
  schedule: (callback) => { timer = callback; return 1; }, cancel: () => { canceled += 1; },
  observe: (callback) => { gc = callback; return () => { disconnected += 1; }; },
};
const profile = startNumericMemory({ enabled: true, adapters, maxSamples: 2, role: "worker", isolateId: 2 });
for (let i = 0; i < 500; i += 1) { tick += 100; timer(); }
gc([{ duration: 3 }, { duration: -1 }, { duration: Infinity }]);
profile.sample(MEMORY_PHASE.prePersist);
const result = profile.finish();
assert.equal(result.rows.length, 2);
assert.equal(result.rows[1][1], MEMORY_PHASE.end);
assert.equal(result.peaks[0][0], tick + 10);
assert.equal(result.peaks[8], null);
assert.equal(result.rssScope, "omitted");
assert.equal(result.gc.count, 1);
assert.equal(result.gc.durationMs, 3);
assert.equal(result.sampling.maxGapMs, 100);
assert.ok(result.sampling.dropped >= 500);
assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65_536);
assert.equal(JSON.stringify(result).includes("private-unrecognized"), false);
assert.equal(canceled, 1); assert.equal(disconnected, 1);
assert.deepEqual(profile.finish(), result);
result.rows.length = 0;
assert.equal(profile.finish().rows.length, 2);
const invalid = startNumericMemory({ enabled: true, adapters: { ...adapters,
  memory: () => ({ heapUsed: -1, heapTotal: NaN, external: Infinity, arrayBuffers: 1, rss: 123 }) }, role: "main" });
const invalidResult = invalid.finish();
assert.deepEqual(invalidResult.last[2].slice(0, 4), [null, null, null, 1]);
assert.equal(invalidResult.peaks[8][0], 123);
assert.equal(invalidResult.rssScope, "process-wide");
assert.equal(invalidResult.rssPeakSample[2][8], 123);
assert.equal(result.rssPeakSample, null);
assert.equal(result.sampling.historyTruncated, true);
assert.equal(result.sampling.completeTemporalCoverage, false);
assert.equal(result.sampling.independentPeaksAreNotAdditive, true);
assert.equal(result.arrayBuffersSubsetOfExternal, true);
assert.throws(() => startNumericMemory({ enabled: true, isolateId: "private" }), /INVALID_ID/u);
assert.throws(() => startNumericMemory({ enabled: true, maxSamples: 129 }), /INVALID_SAMPLES/u);
const failed = startNumericMemory({ enabled: true, adapters: { ...adapters, memory: () => { throw new Error("private"); } } });
assert.ok(failed.finish().sampling.errors >= 2);
assert.equal(JSON.stringify(failed.finish()).includes("private"), false);
console.log("analytics-refresh numeric memory checks passed");
const recent = startNumericMemory({ enabled: true, maxSamples: 4, adapters: { ...adapters, wallClock: () => 123_456 } });
for (let i = 0; i < 10; i += 1) { tick += 20; recent.sample(MEMORY_PHASE.checkpoint); }
const recentResult = recent.finish();
assert.equal(recentResult.startedEpochMs, 123_456);
assert.equal(recentResult.rows.length, 4);
assert.equal(recentResult.rows[0][1], MEMORY_PHASE.start);
assert.equal(recentResult.rows[2][0], recentResult.last[0]);
assert.ok(recentResult.rows[1][0] >= recentResult.last[0] - 20);
assert.equal(recentResult.rows[3][1], MEMORY_PHASE.end);
