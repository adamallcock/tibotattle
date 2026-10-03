/**
 * analytics-refresh compute workers, main side (K-PAR).
 *
 * createAnalyticsRefreshOwnerPool returns the AnalyticsV2OwnerPool that
 * computeAnalyticsV2 (src/analytics-v2/compute.ts) hands its admitted
 * effective owners to. Each owner runs computeAnalyticsV2Owner in a
 * worker_threads Worker of its own (dist/analytics-refresh-worker.mjs), so
 * owners spread across the task's vCPUs; the main thread keeps every database
 * read, the merge in owner-digest order, the output account and the write.
 *
 * - Concurrency: at most `workers` owners at once, longest estimate first
 *   (ties by owner index). Each Worker's heap is limited to its owner's
 *   estimate plus ANALYTICS_REFRESH_WORKER_HEAP_RESERVE_BYTES
 *   (resourceLimits.maxOldGenerationSizeMb); an owner that outgrows it fails
 *   the run (out of memory), never silently. Admission: the limits of the
 *   owners running at once sum to at most the run's per-owner memory budget
 *   plus one reserve, so the Workers together never hold more than one inline
 *   owner could (its budget and the reserve), and an owner as large as the
 *   budget runs alone. The reserve is generous because the estimate is not a
 *   bound on the heap V8 uses: the dense rehearsal's largest owner (estimate
 *   1,517 MiB) sampled 2,275 MiB of used heap in its Worker.
 * - Reads: a Worker asks the main thread for each of its owner's segments;
 *   the main thread reads them through the run's snapshot read pool, one load
 *   at a time (the main heap holds one read chunk, as before), and posts the
 *   occurrences to the Worker (structured clone).
 * - Progress: segment, scalar and model events are forwarded to the run's
 *   checkpoint (the time guard); one that throws fails the run.
 * - Failure: any Worker error, exit without a result, load failure or
 *   progress refusal rejects that owner and aborts the pool: every Worker is
 *   terminated, queued owners are refused, and the run writes nothing. A
 *   failure's code is closed and content-free.
 *
 * Determinism: an owner computation is a pure function of the run context,
 * the owner, its counts and the occurrences it loads; Workers share no state.
 * The Job's parity rehearsals hold W = 1 and W = 4 to the same bytes.
 */

import { Worker } from "node:worker_threads";

const MIB = 1_024 * 1_024;
/** Heap a compute Worker gets beyond its owner's estimate (module code, kernels, garbage awaiting collection). */
export const ANALYTICS_REFRESH_WORKER_HEAP_RESERVE_BYTES = 1_024 * MIB;
/** Bounds of the Job's --workers flag. */
export const ANALYTICS_REFRESH_WORKER_BOUNDS = Object.freeze({ minimum: 1, maximum: 16 });
const SAFE_CODE = /^ANALYTICS_V2_[A-Z0-9_]+$/u;

function failure(code) {
  return Object.assign(new Error(code), { code });
}

/** The default Worker script: beside the bundled Job entry (dist/). */
export function defaultAnalyticsRefreshWorkerUrl() {
  return new URL("./analytics-refresh-worker.mjs", import.meta.url);
}

/**
 * @param {{
 *   workers: number,
 *   memoryBudgetBytes: number,
 *   workerUrl?: URL,
 *   createWorker?: (url: URL, options: object) => Worker,
 * }} options
 */
export function createAnalyticsRefreshOwnerPool({ workers, memoryBudgetBytes, workerUrl, createWorker } = {}) {
  if (!Number.isSafeInteger(workers) || workers < ANALYTICS_REFRESH_WORKER_BOUNDS.minimum
      || workers > ANALYTICS_REFRESH_WORKER_BOUNDS.maximum
      || !Number.isSafeInteger(memoryBudgetBytes) || memoryBudgetBytes < 1) {
    throw failure("ANALYTICS_V2_REFRESH_WORKERS_INVALID");
  }
  const url = workerUrl ?? defaultAnalyticsRefreshWorkerUrl();
  const spawn = createWorker ?? ((target, options) => new Worker(target, options));
  /** Tasks waiting for admission, kept longest estimate first. */
  const queue = [];
  const running = new Set();
  const limitOf = (task) => task.estimateBytes + ANALYTICS_REFRESH_WORKER_HEAP_RESERVE_BYTES;
  const admissionBytes = memoryBudgetBytes + ANALYTICS_REFRESH_WORKER_HEAP_RESERVE_BYTES;
  let runningLimitBytes = 0;
  let aborted = false;
  /** One main-thread load at a time. */
  let loadChain = Promise.resolve();

  const admit = () => {
    if (aborted) return;
    while (queue.length > 0 && running.size < workers) {
      const next = queue[0];
      if (running.size > 0 && runningLimitBytes + limitOf(next.task) > admissionBytes) return;
      queue.shift();
      start(next);
    }
  };

  const settle = (entry, error, value) => {
    if (entry.settled) return;
    entry.settled = true;
    if (running.delete(entry)) runningLimitBytes -= limitOf(entry.task);
    if (entry.worker !== null) {
      const worker = entry.worker;
      entry.worker = null;
      worker.removeAllListeners("message");
      void worker.terminate().catch(() => {});
    }
    if (error === null) entry.resolve(value);
    else entry.reject(error);
    admit();
  };

  const fail = (entry, code) => {
    settle(entry, failure(code), null);
    void abort();
  };

  const start = (entry) => {
    running.add(entry);
    runningLimitBytes += limitOf(entry.task);
    try {
      entry.io.started();
    } catch (error) {
      settle(entry, error, null);
      void abort();
      return;
    }
    const heapMiB = Math.ceil(limitOf(entry.task) / MIB);
    let worker;
    try {
      worker = spawn(url, {
        workerData: { task: entry.task, context: entry.context },
        resourceLimits: { maxOldGenerationSizeMb: heapMiB },
        // The Worker inherits no environment and no argv: it reads neither.
        env: {},
        argv: [],
        stdout: false,
        stderr: false,
      });
    } catch {
      fail(entry, "ANALYTICS_V2_REFRESH_WORKER_START_FAILED");
      return;
    }
    entry.worker = worker;
    worker.on("message", (message) => {
      if (entry.settled || message === null || typeof message !== "object") return;
      switch (message.type) {
        case "load": {
          const id = message.id;
          const span = message.span;
          loadChain = loadChain.then(async () => {
            if (entry.settled) return;
            let days;
            try {
              days = await entry.io.load(Object.freeze({ fromDay: span?.fromDay, throughDay: span?.throughDay }));
            } catch (error) {
              settle(entry, error, null);
              void abort();
              return;
            }
            if (entry.worker === null) return;
            try {
              entry.worker.postMessage({ type: "loaded", id, days });
            } catch {
              fail(entry, "ANALYTICS_V2_REFRESH_WORKER_TRANSFER_FAILED");
            }
          });
          break;
        }
        case "progress":
          try {
            entry.io.progress(message.event);
          } catch (error) {
            settle(entry, error, null);
            void abort();
          }
          break;
        case "result":
          settle(entry, null, Object.freeze({ emissions: message.emissions, computation: message.computation,
            timings: message.timings }));
          break;
        case "failed":
          fail(entry, typeof message.code === "string" && SAFE_CODE.test(message.code)
            ? message.code : "ANALYTICS_V2_REFRESH_WORKER_FAILED");
          break;
        default:
          fail(entry, "ANALYTICS_V2_REFRESH_WORKER_PROTOCOL_INVALID");
      }
    });
    worker.on("error", (error) => {
      fail(entry, error?.code === "ERR_WORKER_OUT_OF_MEMORY"
        ? "ANALYTICS_V2_REFRESH_WORKER_OUT_OF_MEMORY" : "ANALYTICS_V2_REFRESH_WORKER_FAILED");
    });
    worker.on("exit", () => {
      if (!entry.settled) fail(entry, "ANALYTICS_V2_REFRESH_WORKER_EXITED");
    });
  };

  async function abort() {
    if (aborted) return;
    aborted = true;
    for (const entry of queue.splice(0)) {
      entry.settled = true;
      entry.reject(failure("ANALYTICS_V2_REFRESH_WORKER_ABORTED"));
    }
    const stopping = [];
    for (const entry of [...running]) {
      if (!entry.settled) {
        entry.settled = true;
        entry.reject(failure("ANALYTICS_V2_REFRESH_WORKER_ABORTED"));
      }
      running.delete(entry);
      if (entry.worker !== null) {
        const worker = entry.worker;
        entry.worker = null;
        worker.removeAllListeners("message");
        stopping.push(worker.terminate().catch(() => {}));
      }
    }
    runningLimitBytes = 0;
    await Promise.all(stopping);
  }

  return Object.freeze({
    workers,
    compute(task, context, io) {
      if (aborted) return Promise.reject(failure("ANALYTICS_V2_REFRESH_WORKER_ABORTED"));
      if (task === null || typeof task !== "object" || !Number.isSafeInteger(task.estimateBytes)
          || task.estimateBytes < 0 || task.estimateBytes > memoryBudgetBytes) {
        return Promise.reject(failure("ANALYTICS_V2_REFRESH_WORKER_TASK_INVALID"));
      }
      return new Promise((resolve, reject) => {
        const entry = { task, context, io, resolve, reject, worker: null, settled: false };
        let position = queue.findIndex((queued) => queued.task.estimateBytes < task.estimateBytes
          || (queued.task.estimateBytes === task.estimateBytes && queued.task.index > task.index));
        if (position < 0) position = queue.length;
        queue.splice(position, 0, entry);
        // Admission waits a turn so every owner the run submits at once is
        // queued (and so ordered longest first) before the first starts.
        queueMicrotask(admit);
      });
    },
    abort,
    /** Operational metadata: running Workers (spec use). */
    get running() { return running.size; },
  });
}
