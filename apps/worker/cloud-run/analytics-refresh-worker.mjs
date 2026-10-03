/**
 * analytics-refresh compute worker (K-PAR, build entry
 * "analytics-refresh-worker" -> dist/analytics-refresh-worker.mjs).
 *
 * One Worker computes one admitted effective owner with
 * computeAnalyticsV2Owner (src/analytics-v2/compute-owner.ts) and exits. It
 * has no database access, no environment and no argv: its inputs are the
 * workerData the main thread sends (the run context, the owner, its counts
 * and its estimate) and the segments it asks the main thread to load. It
 * posts:
 *   { type: "heap", limitBytes }      first: the isolate's heap_size_limit (the pool refuses a
 *                                     Worker whose limit is not the one it asked for);
 *   { type: "load", id, span }        one segment of its owner, read by the main thread,
 *                                     which answers with { type: "part", id, ordinal, stream,
 *                                     days } for each read call (K-PAR-MEM: streamed, so the
 *                                     main heap never holds the segment; calls may finish out
 *                                     of order, so the parts are merged in ordinal order) and then
 *                                     { type: "loaded", id }, or { type: "loadFailed", id };
 *   { type: "progress", event }       segment, scalar and model events (the time guard);
 *   { type: "result", emissions, computation, timings, gcCallbackHeapPeakBytes }  once, at the end
 *                                     (gcCallbackHeapPeakBytes: the largest heap sampled when a major-GC observer
 *                                     callback ran, or null when none ran; callbacks may be
 *                                     delayed, so this is not the peak post-GC live heap);
 *   { type: "failed", code }          a closed, content-free code, then exits.
 * Every output row and refusal is buffered in production order and sent with
 * the result; the main thread merges owners in digest order (compute.ts), so
 * the stored rows do not depend on which Worker finished first.
 *
 * The compute module is loaded through a literal dynamic import, so esbuild
 * bundles it into the dist entry; this source file is never run unbundled.
 */

import { constants as performanceConstants, PerformanceObserver } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import { parentPort, workerData } from "node:worker_threads";
import { mergeAnalyticsRefreshOccurrencePart } from "./analytics-refresh-read.mjs";

const SAFE_CODE = /^ANALYTICS_V2_[A-Z0-9_]+$/u;

function closedCode(error) {
  if (typeof error?.code === "string" && SAFE_CODE.test(error.code)) return error.code;
  // computeAnalyticsV2Owner's input refusals are TypeErrors whose message is
  // a closed code with a field path (ANALYTICS_V2_INPUT_INVALID:<path>).
  const message = typeof error?.message === "string" ? error.message : "";
  const prefix = /^(ANALYTICS_V2_[A-Z0-9_]+)(?::|$)/u.exec(message);
  return prefix ? prefix[1] : "ANALYTICS_V2_REFRESH_WORKER_FAILED";
}

async function run() {
  if (parentPort === null) throw Object.assign(new Error("ANALYTICS_V2_REFRESH_WORKER_CONTEXT_INVALID"),
    { code: "ANALYTICS_V2_REFRESH_WORKER_CONTEXT_INVALID" });
  // K-PAR-MEM: the heap limit this isolate actually got. A process-wide V8
  // heap flag (--max-old-space-size) overrides a Worker's resourceLimits in
  // both directions, so the pool checks this before the Worker reads anything.
  parentPort.postMessage({ type: "heap", limitBytes: getHeapStatistics().heap_size_limit });
  const { computeAnalyticsV2Owner } = await import("../src/analytics-v2/compute-owner.ts");
  const { task, context } = workerData ?? {};
  if (task === null || typeof task !== "object" || context === null || typeof context !== "object") {
    throw Object.assign(new Error("ANALYTICS_V2_REFRESH_WORKER_TASK_INVALID"),
      { code: "ANALYTICS_V2_REFRESH_WORKER_TASK_INVALID" });
  }
  // id -> the load being assembled: its parts are kept as they arrive and
  // merged in ordinal order, the sequential read order, when the load
  // completes (mergeAnalyticsRefreshOccurrencePart), so the map is the
  // inline load's.
  const loads = new Map();
  let nextId = 0;
  parentPort.on("message", (message) => {
    const pending = loads.get(message?.id);
    if (pending === undefined) return;
    switch (message.type) {
      case "part":
        if (!Number.isSafeInteger(message.ordinal) || message.ordinal < 0 || pending.parts.has(message.ordinal)) {
          loads.delete(message.id);
          pending.reject(Object.assign(new Error("ANALYTICS_V2_REFRESH_WORKER_PROTOCOL_INVALID"),
            { code: "ANALYTICS_V2_REFRESH_WORKER_PROTOCOL_INVALID" }));
          break;
        }
        pending.parts.set(message.ordinal, message);
        break;
      case "loaded": {
        loads.delete(message.id);
        try {
          const byDay = new Map();
          const ordinals = [...pending.parts.keys()].sort((left, right) => left - right);
          for (const ordinal of ordinals) {
            const part = pending.parts.get(ordinal);
            pending.parts.delete(ordinal);
            mergeAnalyticsRefreshOccurrencePart(byDay, part.stream, part.days);
          }
          pending.resolve(byDay);
        } catch (error) {
          pending.reject(error);
        }
        break;
      }
      case "loadFailed":
        // The main thread has the cause and fails the run; this Worker is terminated.
        loads.delete(message.id);
        pending.reject(Object.assign(new Error("ANALYTICS_V2_REFRESH_WORKER_LOAD_FAILED"),
          { code: "ANALYTICS_V2_REFRESH_WORKER_LOAD_FAILED" }));
        break;
      default:
        break;
    }
  });
  const load = (span) => new Promise((resolve, reject) => {
    const id = nextId++;
    loads.set(id, { parts: new Map(), resolve, reject });
    parentPort.postMessage({ type: "load", id, span: { fromDay: span.fromDay, throughDay: span.throughDay } });
  });
  // Operational metadata only (K-PAR-MEM): a major-GC observer samples
  // the heap when its callback runs. Delivery can be delayed by synchronous
  // compute, so this is not a post-GC live-heap peak. No decision reads it.
  let gcCallbackHeapPeakBytes = null;
  const collections = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.detail?.kind !== performanceConstants.NODE_PERFORMANCE_GC_MAJOR) continue;
      const used = getHeapStatistics().used_heap_size;
      if (gcCallbackHeapPeakBytes === null || used > gcCallbackHeapPeakBytes) gcCallbackHeapPeakBytes = used;
    }
  });
  collections.observe({ entryTypes: ["gc"] });
  const emissions = [];
  const timings = {};
  const computation = await computeAnalyticsV2Owner({
    context,
    owner: task.owner,
    evidence: new Map(task.evidence),
    load,
    // The next segment is read while this one is prepared (at most two held).
    prefetch: true,
    hooks: {
      emit: (emission) => { emissions.push(emission); },
      // The main thread holds the output account and stamps it on every
      // forwarded progress event.
      accountBytes: () => 0,
      progress: (event) => parentPort.postMessage({ type: "progress", event }),
      timed: async (phase, work) => {
        const started = performance.now();
        try { return await work(); } finally { timings[phase] = (timings[phase] ?? 0) + (performance.now() - started); }
      },
      memoryProbe: () => getHeapStatistics().used_heap_size,
    },
  });
  collections.disconnect();
  parentPort.postMessage({ type: "result", emissions, computation, timings, gcCallbackHeapPeakBytes });
}

try {
  await run();
} catch (error) {
  parentPort?.postMessage({ type: "failed", code: closedCode(error) });
}
