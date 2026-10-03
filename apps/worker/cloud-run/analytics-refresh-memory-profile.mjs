/** Local synthetic numeric diagnostics. Observed maxima are lower bounds, not allocation attribution. */
import { performance, PerformanceObserver } from "node:perf_hooks";
import { getHeapStatistics, getHeapSpaceStatistics } from "node:v8";

export const MEMORY_PHASE = Object.freeze({ start: 0, timer: 1, gcDelivered: 2, prePersist: 3, end: 4, checkpoint: 5 });
export const MEMORY_METRICS = Object.freeze(["heapUsed", "heapTotal", "external", "arrayBuffers", "totalPhysical", "usedHeap", "malloced", "peakMalloced", "processRss"]);
export const MEMORY_SPACES = Object.freeze(["read_only_space", "new_space", "old_space", "code_space", "shared_space", "new_large_object_space", "large_object_space", "code_large_object_space", "shared_large_object_space", "trusted_space", "trusted_large_object_space"]);
const finite = (value) => Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), Number.MAX_SAFE_INTEGER) : null;
const bound = (value, min, max, name) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`MEMORY_PROFILE_INVALID_${name}`);
  return value;
};
/** Disabled returns null before creating any timer, observer, or collecting stats.
 * adapters are for content-free synthetic tests. RSS belongs to the whole process;
 * arrayBuffers is a subset of external and must never be added to it.
 */
export function startNumericMemory({ enabled = false, isolateId = 0, role = "main", maxSamples = 64,
  intervalMs = 20, maxBytes = 65_536, adapters = {} } = {}) {
  if (!enabled) return null;
  bound(isolateId, 0, 65_535, "ID");
  bound(maxSamples, 2, 128, "SAMPLES");
  bound(intervalMs, 10, 60_000, "INTERVAL");
  bound(maxBytes, 16_384, 65_536, "BYTES");
  if (role !== "main" && role !== "worker") throw new Error("MEMORY_PROFILE_INVALID_ROLE");
  const clock = adapters.clock ?? (() => performance.now());
  const memory = adapters.memory ?? (() => process.memoryUsage());
  const heap = adapters.heap ?? getHeapStatistics;
  const spaces = adapters.spaces ?? getHeapSpaceStatistics;
  const schedule = adapters.schedule ?? setInterval;
  const cancel = adapters.cancel ?? clearInterval;
  const observe = adapters.observe ?? ((callback) => {
    const observer = new PerformanceObserver((list) => callback(list.getEntries()));
    observer.observe({ entryTypes: ["gc"] });
    return () => observer.disconnect();
  });
  const startedEpochMs = finite((adapters.wallClock ?? Date.now)());
  const started = clock();
  const rows = [];
  const peaks = MEMORY_METRICS.map(() => null);
  const spacePeaks = MEMORY_SPACES.map(() => [null, null, null, null]);
  let attempts = 0; let errors = 0; let dropped = 0; let last = null; let finished = null;
  let rssPeakSample = null;
  let maxGapMs = 0; let previousMs = null; let gcCount = 0; let gcDurationMs = 0;
  let observerAvailable = false; let disconnect = null; let timer = null;
  const sample = (phase = MEMORY_PHASE.checkpoint) => {
    if (finished !== null) return;
    if (!Number.isSafeInteger(phase) || phase < 0 || phase > 5) throw new Error("MEMORY_PROFILE_INVALID_PHASE");
    attempts += 1;
    try {
      const rawAtMs = finite(clock() - started);
      const atMs = rawAtMs === null ? null : Math.max(previousMs ?? 0, rawAtMs);
      const usage = memory(); const stats = heap();
      const metrics = [usage.heapUsed, usage.heapTotal, usage.external, usage.arrayBuffers,
        stats.total_physical_size, stats.used_heap_size, stats.malloced_memory, stats.peak_malloced_memory,
        role === "main" ? usage.rss : null].map(finite);
      const spaceRows = MEMORY_SPACES.map(() => [null, null, null, null]);
      for (const space of spaces()) {
        const id = MEMORY_SPACES.indexOf(space.space_name);
        if (id >= 0) spaceRows[id] = [space.space_size, space.space_used_size, space.space_available_size, space.physical_space_size].map(finite);
      }
      if (atMs !== null && previousMs !== null) maxGapMs = Math.max(maxGapMs, Math.max(0, atMs - previousMs));
      previousMs = atMs;
      metrics.forEach((value, id) => {
        if (value !== null && (peaks[id] === null || value > peaks[id][0])) peaks[id] = [value, atMs, phase];
      });
      spaceRows.forEach((values, id) => values.forEach((value, column) => {
        if (value !== null && (spacePeaks[id][column] === null || value > spacePeaks[id][column][0])) spacePeaks[id][column] = [value, atMs, phase];
      }));
      last = [atMs, phase, metrics, spaceRows];
      if (metrics[8] !== null && (rssPeakSample === null || metrics[8] > rssPeakSample[2][8])) rssPeakSample = last;
      // Reserve room for the final row; last and peaks remain current after saturation.
      if (rows.length < maxSamples - 1 || phase === MEMORY_PHASE.end) rows.push(last);
      else {
        dropped += 1;
        if (maxSamples > 2) { rows.splice(1, 1); rows.push(last); }
      }
    } catch { errors += 1; }
  };
  sample(MEMORY_PHASE.start);
  try {
    disconnect = observe((entries) => {
      if (finished !== null) return;
      for (const entry of entries) {
        if (Number.isFinite(entry.duration) && entry.duration >= 0) {
          gcCount = Math.min(gcCount + 1, Number.MAX_SAFE_INTEGER);
          gcDurationMs = Math.min(gcDurationMs + entry.duration, Number.MAX_SAFE_INTEGER);
        }
      }
      sample(MEMORY_PHASE.gcDelivered);
    });
    observerAvailable = true;
  } catch { errors += 1; }
  try { timer = schedule(() => sample(MEMORY_PHASE.timer), intervalMs); timer?.unref?.(); }
  catch { errors += 1; }
  return Object.freeze({ sample, finish() {
    if (finished !== null) return structuredClone(finished);
    if (timer !== null) cancel(timer);
    try { disconnect?.(); } catch { errors += 1; }
    sample(MEMORY_PHASE.end);
    finished = { schema: "analytics-refresh-numeric-memory-v1", isolateId, role, startedEpochMs,
      rssScope: role === "main" ? "process-wide" : "omitted", arrayBuffersSubsetOfExternal: true,
      sampling: { intervalMs, maxSamples, maxBytes, attempts, errors, dropped, maxGapMs,
        historyTruncated: dropped > 0, historyPolicy: "start-and-recent-with-reserved-end",
        phaseIdsAreSampleReasons: true, knownHeapSpacesOnly: true, completeTemporalCoverage: false,
        timerCallbacksCanBeBlocked: true, independentPeaksAreNotAdditive: true,
        timerAvailable: timer !== null, gcObserverAvailable: observerAvailable,
        gcBoundary: "after-asynchronous-delivery", peaks: "observed-lower-bounds" },
      gc: { count: gcCount, durationMs: finite(gcDurationMs) }, metricNames: MEMORY_METRICS,
      spaceNames: MEMORY_SPACES, rows, last, peaks, spacePeaks, rssPeakSample };
    // Bound the serialized receipt, including summaries; never truncate structured JSON.
    while (Buffer.byteLength(JSON.stringify(finished)) > maxBytes && rows.length > 2) {
      rows.splice(1, 1); finished.sampling.dropped += 1;
    }
    finished.sampling.historyTruncated = finished.sampling.dropped > 0;
    if (Buffer.byteLength(JSON.stringify(finished)) > maxBytes) throw new Error("MEMORY_PROFILE_BYTE_CAP");
    return structuredClone(finished);
  } });
}

/** Single closed schema authority for local numeric artifacts. Never includes offending values in errors. */
export function validateNumericMemoryReceipt(receipt) {
  const fail = () => { throw new Error("MEMORY_PROFILE_INVALID_RECEIPT"); };
  const check = (value) => { if (!value) fail(); };
  const integer = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) =>
    Number.isSafeInteger(value) && value >= minimum && value <= maximum;
  const nullable = (value) => value === null || integer(value);
  const keys = (value, expected) => {
    check(value !== null && typeof value === "object" && !Array.isArray(value));
    check(Object.keys(value).sort().join(",") === [...expected].sort().join(","));
  };
  const vector = (value, length, test) => {
    check(Array.isArray(value) && value.length === length);
    for (const item of value) check(test(item));
  };
  const row = (value) => {
    check(Array.isArray(value) && value.length === 4);
    check(nullable(value[0]) && integer(value[1], 0, 5));
    vector(value[2], MEMORY_METRICS.length, nullable);
    check(Array.isArray(value[3]) && value[3].length === MEMORY_SPACES.length);
    value[3].forEach((space) => vector(space, 4, nullable));
    if (receipt.role === "worker") check(value[2][8] === null);
  };
  const peak = (value) => {
    if (value === null) return;
    check(Array.isArray(value) && value.length === 3);
    check(integer(value[0]) && nullable(value[1]) && integer(value[2], 0, 5));
  };
  keys(receipt, ["schema", "isolateId", "role", "startedEpochMs", "rssScope", "arrayBuffersSubsetOfExternal",
    "sampling", "gc", "metricNames", "spaceNames", "rows", "last", "peaks", "spacePeaks", "rssPeakSample"]);
  check(receipt.schema === "analytics-refresh-numeric-memory-v1");
  check(integer(receipt.isolateId, 0, 65_535) && ["main", "worker"].includes(receipt.role));
  check(nullable(receipt.startedEpochMs));
  check(receipt.rssScope === (receipt.role === "main" ? "process-wide" : "omitted"));
  check(receipt.arrayBuffersSubsetOfExternal === true);
  check(JSON.stringify(receipt.metricNames) === JSON.stringify(MEMORY_METRICS));
  check(JSON.stringify(receipt.spaceNames) === JSON.stringify(MEMORY_SPACES));
  const sampling = receipt.sampling;
  keys(sampling, ["intervalMs", "maxSamples", "maxBytes", "attempts", "errors", "dropped", "maxGapMs",
    "historyTruncated", "historyPolicy", "phaseIdsAreSampleReasons", "knownHeapSpacesOnly", "completeTemporalCoverage",
    "timerCallbacksCanBeBlocked", "independentPeaksAreNotAdditive", "timerAvailable", "gcObserverAvailable", "gcBoundary", "peaks"]);
  check(integer(sampling.intervalMs, 10, 60_000) && integer(sampling.maxSamples, 2, 128));
  check(integer(sampling.maxBytes, 16_384, 65_536));
  for (const name of ["attempts", "errors", "dropped", "maxGapMs"]) check(integer(sampling[name]));
  check(sampling.attempts >= 2 && sampling.dropped <= sampling.attempts);
  check(sampling.historyTruncated === (sampling.dropped > 0));
  check(sampling.historyPolicy === "start-and-recent-with-reserved-end");
  for (const name of ["phaseIdsAreSampleReasons", "knownHeapSpacesOnly", "timerCallbacksCanBeBlocked", "independentPeaksAreNotAdditive"]) check(sampling[name] === true);
  check(sampling.completeTemporalCoverage === false);
  check(typeof sampling.timerAvailable === "boolean" && typeof sampling.gcObserverAvailable === "boolean");
  check(sampling.gcBoundary === "after-asynchronous-delivery" && sampling.peaks === "observed-lower-bounds");
  keys(receipt.gc, ["count", "durationMs"]);
  check(integer(receipt.gc.count) && nullable(receipt.gc.durationMs));
  check(Array.isArray(receipt.rows) && receipt.rows.length <= sampling.maxSamples);
  check(receipt.rows.length + sampling.dropped <= sampling.attempts);
  let previous = null;
  for (const item of receipt.rows) {
    row(item);
    if (item[0] !== null) { check(previous === null || item[0] >= previous); previous = item[0]; }
  }
  if (receipt.last !== null) {
    row(receipt.last);
    check(receipt.last[0] === null || previous === null || receipt.last[0] >= previous);
    if (receipt.rows.length > 0) check(JSON.stringify(receipt.rows.at(-1)) === JSON.stringify(receipt.last));
  } else check(receipt.rows.length === 0);
  check(Array.isArray(receipt.peaks) && receipt.peaks.length === MEMORY_METRICS.length);
  for (const item of receipt.peaks) peak(item);
  check(Array.isArray(receipt.spacePeaks) && receipt.spacePeaks.length === MEMORY_SPACES.length);
  for (const space of receipt.spacePeaks) { check(Array.isArray(space) && space.length === 4); for (const item of space) peak(item); }
  if (receipt.role === "worker") check(receipt.peaks[8] === null && receipt.rssPeakSample === null);
  if (receipt.rssPeakSample !== null) {
    row(receipt.rssPeakSample);
    check(receipt.role === "main" && receipt.peaks[8] !== null);
    check(JSON.stringify([receipt.rssPeakSample[2][8], receipt.rssPeakSample[0], receipt.rssPeakSample[1]]) === JSON.stringify(receipt.peaks[8]));
  } else check(receipt.peaks[8] === null);
  for (const item of [...receipt.rows, ...(receipt.last === null ? [] : [receipt.last])]) {
    item[2].forEach((value, id) => { if (value !== null) check(receipt.peaks[id] !== null && receipt.peaks[id][0] >= value); });
    item[3].forEach((space, id) => space.forEach((value, column) => {
      if (value !== null) check(receipt.spacePeaks[id][column] !== null && receipt.spacePeaks[id][column][0] >= value);
    }));
  }
  const lastTime = receipt.last?.[0] ?? null;
  const checkPeakTime = (value) => { if (value !== null && value[1] !== null && lastTime !== null) check(value[1] <= lastTime); };
  receipt.peaks.forEach(checkPeakTime);
  receipt.spacePeaks.forEach((space) => space.forEach(checkPeakTime));
  if (sampling.errors === 0) {
    check(receipt.rows.length >= 2 && receipt.rows[0][1] === MEMORY_PHASE.start && receipt.rows.at(-1)[1] === MEMORY_PHASE.end);
    check(receipt.rows.length + sampling.dropped === sampling.attempts);
  }
  check(Buffer.byteLength(JSON.stringify(receipt)) <= sampling.maxBytes);
  return receipt;
}
