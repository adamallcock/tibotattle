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
 *   { type: "load", id, span }        one segment of its owner, read by the main thread;
 *   { type: "progress", event }       segment, scalar and model events (the time guard);
 *   { type: "result", emissions, computation, timings }  once, at the end;
 *   { type: "failed", code }          a closed, content-free code, then exits.
 * Every output row and refusal is buffered in production order and sent with
 * the result; the main thread merges owners in digest order (compute.ts), so
 * the stored rows do not depend on which Worker finished first.
 *
 * The compute module is loaded through a literal dynamic import, so esbuild
 * bundles it into the dist entry; this source file is never run unbundled.
 */

import { getHeapStatistics } from "node:v8";
import { parentPort, workerData } from "node:worker_threads";

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
  const { computeAnalyticsV2Owner } = await import("../src/analytics-v2/compute-owner.ts");
  const { task, context } = workerData ?? {};
  if (task === null || typeof task !== "object" || context === null || typeof context !== "object") {
    throw Object.assign(new Error("ANALYTICS_V2_REFRESH_WORKER_TASK_INVALID"),
      { code: "ANALYTICS_V2_REFRESH_WORKER_TASK_INVALID" });
  }
  const loads = new Map();
  let nextId = 0;
  parentPort.on("message", (message) => {
    if (message?.type !== "loaded" || !loads.has(message.id)) return;
    const resolve = loads.get(message.id);
    loads.delete(message.id);
    resolve(message.days);
  });
  const load = (span) => new Promise((resolve) => {
    const id = nextId++;
    loads.set(id, resolve);
    parentPort.postMessage({ type: "load", id, span: { fromDay: span.fromDay, throughDay: span.throughDay } });
  });
  const emissions = [];
  const timings = {};
  const computation = await computeAnalyticsV2Owner({
    context,
    owner: task.owner,
    evidence: new Map(task.evidence),
    load,
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
  parentPort.postMessage({ type: "result", emissions, computation, timings });
}

try {
  await run();
} catch (error) {
  parentPort?.postMessage({ type: "failed", code: closedCode(error) });
}
