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
import { deserialize, getHeapStatistics, serialize } from "node:v8";
import { parentPort, workerData } from "node:worker_threads";
import { mergeAnalyticsRefreshOccurrencePart } from "./analytics-refresh-read.mjs";

/** Conservative pre-serialization bound for the closed plain-value model graph.
 * Includes strings at three bytes per UTF-16 unit, headers/keys and references;
 * repeated objects are counted once. The actual v8 bytes are checked before transfer.
 */
export function analyticsRefreshSerializationBound(value) {
  const seen = new WeakSet();
  const pending = [value];
  let bytes = 64;
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === "string") { bytes += 64 + item.length * 3; continue; }
    if (typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") {
      throw Object.assign(new Error("ANALYTICS_V2_REFRESH_BLOCK_PAYLOAD_BOUND_EXCEEDED"),
        { code: "ANALYTICS_V2_REFRESH_BLOCK_PAYLOAD_BOUND_EXCEEDED" });
    }
    if (item === null || typeof item !== "object") { bytes += 64; continue; }
    if (!(item instanceof Map) && !Array.isArray(item)
        && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw Object.assign(new Error("ANALYTICS_V2_REFRESH_BLOCK_PAYLOAD_BOUND_EXCEEDED"),
        { code: "ANALYTICS_V2_REFRESH_BLOCK_PAYLOAD_BOUND_EXCEEDED" });
    }
    if (seen.has(item)) { bytes += 64; continue; }
    seen.add(item);
    bytes += 64;
    if (item instanceof Map) for (const [key, value] of item) { bytes += 64; pending.push(key, value); }
    else if (Array.isArray(item)) for (const value of item) pending.push(value);
    else for (const [key, value] of Object.entries(item)) { bytes += 64 + key.length * 3; pending.push(value); }
    if (!Number.isSafeInteger(bytes)) throw Object.assign(new Error("ANALYTICS_V2_REFRESH_BLOCK_PAYLOAD_BOUND_EXCEEDED"),
      { code: "ANALYTICS_V2_REFRESH_BLOCK_PAYLOAD_BOUND_EXCEEDED" });
  }
  return Math.max(1_048_576, bytes);
}

const SAFE_CODE = /^ANALYTICS_V2_[A-Z0-9_]+$/u;

function closedCode(error) {
  if (typeof error?.code === "string" && SAFE_CODE.test(error.code)) return error.code;
  // computeAnalyticsV2Owner's input refusals are TypeErrors whose message is
  // a closed code with a field path (ANALYTICS_V2_INPUT_INVALID:<path>).
  const message = typeof error?.message === "string" ? error.message : "";
  const prefix = /^(ANALYTICS_V2_[A-Z0-9_]+)(?::|$)/u.exec(message);
  return prefix ? prefix[1] : "ANALYTICS_V2_REFRESH_WORKER_FAILED";
}

/** A block receives one transferred serialized payload. Row identity survives within it. */
async function runBlock() {
  const { port, task, context, payloadBoundBytes, resultBoundBytes } = workerData;
  parentPort.postMessage({ type: "heap", limitBytes: getHeapStatistics().heap_size_limit });
  // Keep the isolate alive until pool termination confirms its admission release.
  parentPort.on("message", () => {});
  const { evaluateModelBlock } = await import("../src/analytics-v2/units.ts");
  const receive = await new Promise((resolve) => port.once("message", resolve));
  const cloneStarted = performance.now();
  if (!receive?.serialized || receive.serialized.buffer.byteLength > payloadBoundBytes) {
    throw Object.assign(new Error("ANALYTICS_V2_REFRESH_BLOCK_PAYLOAD_BOUND_EXCEEDED"),
      { code: "ANALYTICS_V2_REFRESH_BLOCK_PAYLOAD_BOUND_EXCEEDED" });
  }
  const serializedBytes = receive.serialized.byteLength;
  const input = deserialize(receive.serialized);
  receive.serialized = null;
  const cloneMs = receive.cloneMs + performance.now() - cloneStarted;
  const dates = [];
  let heapPeakBytes = getHeapStatistics().used_heap_size;
  const evaluationStarted = performance.now();
  for (const day of input.dates) {
    parentPort.postMessage({ type: "progress", event: { kind: "model", index: context.modelDates.indexOf(day), accountBytes: 0 } });
    const [result] = await evaluateModelBlock({ ...input, dates: [day] });
    if ("terminalError" in result) result.terminalError = { code: closedCode(result.terminalError) };
    dates.push(result);
    heapPeakBytes = Math.max(heapPeakBytes, getHeapStatistics().used_heap_size);
    if ("terminalError" in result) break;
  }
  const evaluationMs = performance.now() - evaluationStarted;
  const resultValue = { dates, heapPeakBytes };
  if (analyticsRefreshSerializationBound(resultValue) > resultBoundBytes) {
    throw Object.assign(new Error("ANALYTICS_V2_REFRESH_BLOCK_PAYLOAD_BOUND_EXCEEDED"),
      { code: "ANALYTICS_V2_REFRESH_BLOCK_PAYLOAD_BOUND_EXCEEDED" });
  }
  const result = serialize(resultValue);
  if (result.buffer.byteLength > resultBoundBytes) {
    throw Object.assign(new Error("ANALYTICS_V2_REFRESH_BLOCK_PAYLOAD_BOUND_EXCEEDED"),
      { code: "ANALYTICS_V2_REFRESH_BLOCK_PAYLOAD_BOUND_EXCEEDED" });
  }
  port.postMessage({ serialized: result }, [result.buffer]);
  parentPort.postMessage({ type: "blockDone", serializedBytes, cloneMs, evaluationMs, heapPeakBytes });
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
  const grantRequests = new Map();
  const dispatched = new Map();
  let nextId = 0;
  parentPort.on("message", (message) => {
    if (message?.type === "blockGrants") {
      const request = grantRequests.get(message.id);
      if (request !== undefined) { grantRequests.delete(message.id); request.resolve(message.grants); }
      return;
    }
    if (message?.type === "blockReleased") {
      const block = dispatched.get(message.id);
      if (block !== undefined) { dispatched.delete(message.id); block.resolve(block.value); }
      return;
    }
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
  const runBlocks = async (input) => {
    const { partitionModelDates, modelBlockPayload, evaluateModelBlock } = await import("../src/analytics-v2/units.ts");
    const blocks = partitionModelDates(input.dates, workerData.modelBlockSize);
    const id = nextId++;
    const grants = await new Promise((resolve, reject) => {
      grantRequests.set(id, { resolve, reject });
      parentPort.postMessage({ type: "blockRequest", id, totalBlocks: blocks.length,
        blocks: blocks.slice(0, -1).map((dates, id) => {
          // Payload construction only copies map entries; rows stay shared in
          // the owner until all granted blocks have been posted synchronously.
          const payload = modelBlockPayload(input, dates);
          const quotaRows = [...payload.horizonQuota.values()].reduce((sum, rows) => sum + rows.length, 0);
          return { id, quotaRows, dateCount: dates.length, payloadBoundBytes: analyticsRefreshSerializationBound(payload) };
        }) });
    });
    const work = new Map();
    const keptDates = [];
    for (const [blockId, dates] of blocks.entries()) {
      const grant = grants.find((value) => value.id === blockId);
      if (grant?.port == null) { keptDates.push(...dates); continue; }
      const promise = new Promise((resolve, reject) => {
        const pending = { resolve, reject, value: undefined };
        dispatched.set(blockId, pending);
        grant.port.once("message", (message) => {
          try {
            if (!message?.serialized || message.serialized.buffer.byteLength > grant.resultBoundBytes) {
              throw Object.assign(new Error("ANALYTICS_V2_REFRESH_BLOCK_PAYLOAD_BOUND_EXCEEDED"),
                { code: "ANALYTICS_V2_REFRESH_BLOCK_PAYLOAD_BOUND_EXCEEDED" });
            }
            pending.value = deserialize(message.serialized);
            for (const result of pending.value.dates) if ("terminalError" in result) {
              const code = closedCode(result.terminalError);
              result.terminalError = Object.assign(new Error(code), { code });
            }
            // Return the consumed native result buffer to its child before
            // acknowledging. The parent view is detached immediately; native
            // ownership remains charged until that child's termination.
            grant.port.postMessage({ consumed: true, serialized: message.serialized }, [message.serialized.buffer]);
            grant.port.close();
            parentPort.postMessage({ type: "blockConsumed", id: blockId });
            // Resolve only after main confirms child termination; its slot,
            // heap and payload reservation remain charged until that point.
          } catch (error) { reject(error); }
        });
        const started = performance.now();
        const payload = modelBlockPayload(input, dates);
        const serialized = serialize(payload);
        if (serialized.buffer.byteLength > grant.payloadBoundBytes) {
          throw Object.assign(new Error("ANALYTICS_V2_REFRESH_BLOCK_PAYLOAD_BOUND_EXCEEDED"),
            { code: "ANALYTICS_V2_REFRESH_BLOCK_PAYLOAD_BOUND_EXCEEDED" });
        }
        grant.port.postMessage({ serialized, cloneMs: performance.now() - started }, [serialized.buffer]);
      });
      // A failure may arrive while owner-local dates run. Attach immediately.
      promise.catch(() => {});
      work.set(blockId, promise);
    }
    // Serialization and transfer are synchronous. All grants are posted before
    // removing days that neither the last nor any denied block still needs.
    const keep = new Set();
    for (const day of keptDates) {
      const payload = modelBlockPayload(input, [day]);
      for (const key of payload.dayDigests.keys()) keep.add(key);
    }
    for (const values of [input.prepared, input.dayDigests, input.horizonQuota]) {
      for (const day of values.keys()) if (!keep.has(day)) values.delete(day);
    }
    let heapPeakBytes = getHeapStatistics().used_heap_size;
    // Every denied block and the last block run in owner date order.
    for (const [blockId, dates] of blocks.entries()) if (!work.has(blockId)) {
      const results = [];
      for (const day of dates) {
        parentPort.postMessage({ type: "progress", event: { kind: "model", index: context.modelDates.indexOf(day), accountBytes: 0 } });
        const [result] = await evaluateModelBlock({ ...input, dates: [day] });
        results.push(result);
        heapPeakBytes = Math.max(heapPeakBytes, getHeapStatistics().used_heap_size);
        if ("terminalError" in result) break;
      }
      work.set(blockId, Promise.resolve({ dates: results, heapPeakBytes }));
    }
    const completed = await Promise.all(blocks.map((_, id) => work.get(id)));
    return { dates: completed.flatMap((block) => block.dates),
      heapPeakBytes: Math.max(heapPeakBytes, ...completed.map((block) => block.heapPeakBytes ?? 0)) };
  };
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
      modelBlocks: { size: workerData.modelBlockSize, fanOut: workerData.modelFanOut, run: runBlocks },
    },
  });
  collections.disconnect();
  parentPort.postMessage({ type: "result", emissions, computation, timings, gcCallbackHeapPeakBytes });
}

try {
  if (workerData?.block === true) await runBlock();
  else await run();
} catch (error) {
  parentPort?.postMessage({ type: "failed", code: closedCode(error) });
}
