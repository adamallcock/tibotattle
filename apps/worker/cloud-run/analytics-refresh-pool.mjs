/**
 * analytics-refresh compute workers, main side (K-PAR; memory and loads
 * reworked by K-PAR-MEM).
 *
 * createAnalyticsRefreshOwnerPool returns the AnalyticsV2OwnerPool that
 * computeAnalyticsV2 (src/analytics-v2/compute.ts) hands its admitted
 * effective owners to. Each owner runs computeAnalyticsV2Owner in a
 * worker_threads Worker of its own (dist/analytics-refresh-worker.mjs), so
 * owners spread across the task's vCPUs; the main thread keeps every database
 * read, the merge in owner-digest order, the output account and the write.
 *
 * Memory (K-PAR-MEM). The Workers share one pool of task memory, `poolBytes`,
 * which the Job derives from its task profile (the task memory less the main
 * heap and the native reserve; analytics-refresh.mjs analyticsRefreshResources):
 * - Each Worker's old-space limit (resourceLimits.maxOldGenerationSizeMb) is
 *   ANALYTICS_REFRESH_WORKER_HEAP_MODEL applied to its owner's memory
 *   estimate: estimate x heapFactor + heapReserveBytes, rounded up to a MiB,
 *   and never more than the pool less one Worker's overhead. The factor and
 *   reserve are calibrated on the production-shaped corpus (the K-PAR-MEM
 *   receipt); the estimate is resources.ts's deterministic memory model.
 * - Admission charges each running Worker its limit plus overheadBytes (the
 *   young generation, code space, the isolate and the messages in flight,
 *   which the old-space limit does not bound) against the pool, longest
 *   estimate first (ties by owner index): an owner starts only when its
 *   charge fits beside the running ones, and the first queued owner that does
 *   not fit holds the queue, so the order stays largest first. The charges of
 *   the Workers running at once never exceed the pool.
 * - Each Worker reports the heap limit its isolate got before it reads
 *   anything; a limit other than the one asked for (a process-wide V8 heap
 *   flag such as --max-old-space-size overrides resourceLimits for every
 *   isolate, in both directions) fails the run
 *   (ANALYTICS_V2_REFRESH_WORKER_HEAP_LIMIT_UNAPPLIED), because admission
 *   would then not bound the Workers' heaps. The K-CORE-A W = 4 out-of-memory
 *   was exactly that: the profile's --max-old-space-size=3072 capped every
 *   Worker at about 3 GiB, below the largest owner's heap.
 * - An owner that outgrows its limit (ERR_WORKER_OUT_OF_MEMORY) leaves no
 *   partial result: its Worker is gone and nothing of it was merged (a
 *   Worker's rows are sent once, with its result). It is computed again,
 *   once, ALONE with the whole pool as its limit, after the running Workers
 *   finish; the receipt counts these retries. Only an owner that outgrows the
 *   whole pool fails the run (ANALYTICS_V2_REFRESH_WORKER_OUT_OF_MEMORY), and
 *   then nothing is written.
 *
 * Loads (K-PAR-MEM). A Worker asks the main thread for each segment of its
 * owner. Up to `loadConcurrency` loads run at once, each on its own
 * connection of the run's snapshot read pool, so one owner's reads overlap
 * the others' compute; waiting loads are served largest owner first (the
 * critical path), so a large owner's reads never queue behind small ones. A
 * load's read calls also run concurrently on the snapshot connections, and
 * each is streamed to its Worker as it arrives ({type: "part", ordinal}, then
 * {type: "loaded"}), so the main heap holds the read calls in flight, never a
 * whole segment. The Worker merges the parts in ordinal order (the sequential
 * read order) into the same map an inline load returns.
 *
 * Progress: segment, scalar and model events are forwarded to the run's
 * checkpoint (the time guard); one that throws fails the run.
 *
 * Failure: any other Worker error, an exit without a result, a load failure
 * or a progress refusal rejects that owner and aborts the pool: every Worker
 * is terminated, queued owners are refused, and the run writes nothing. A
 * failure's code is closed and content-free.
 *
 * Determinism: an owner computation is a pure function of the run context,
 * the owner, its counts and the occurrences it loads (the same rows in the
 * same order, read from one snapshot); Workers share no state, and a retried
 * owner recomputes the same rows. The Job's parity rehearsals hold W = 1 and
 * W = 4 to the same bytes.
 */

import { MessageChannel, Worker } from "node:worker_threads";

const MIB = 1_024 * 1_024;
/**
 * A Worker's heap from its owner's memory estimate (K-PAR-MEM), calibrated on
 * the production-shaped synthetic corpus (docs/receipts/2026-10-03-gcp-kpar-mem.md):
 * - heapFactor and heapReserveBytes: old-space limit = estimate x factor +
 *   reserve. Full-corpus measurements record sampled used heap and delayed
 *   major-GC callback samples, neither an exact post-GC live-heap peak. The
 *   reserve covers the isolate's kernels and garbage between collections;
 *   admission and the one alone retry enforce the bound independently of
 *   these operational samples;
 * - youngGenerationBytes: each Worker's young-generation cap
 *   (resourceLimits.maxYoungGenerationSizeMb). V8's default (48 MiB) made
 *   the largest owner's model phase spend about 29 % of its time in
 *   scavenges (2,083 in 30 s), a third of it with a 192 MiB cap in a
 *   synthetic check of the same allocation pattern;
 * - overheadBytes: what a Worker takes outside its old space (the young
 *   generation, code space, the isolate, queued messages), charged on top of
 *   the limit at admission.
 */
export const ANALYTICS_REFRESH_WORKER_HEAP_MODEL = Object.freeze({
  version: "analytics-refresh-worker-heap-v2",
  heapFactor: 1,
  heapReserveBytes: 256 * MIB,
  youngGenerationBytes: 192 * MIB,
  overheadBytes: 256 * MIB,
});
/** Bounds of the Job's --workers flag. */
export const ANALYTICS_REFRESH_WORKER_BOUNDS = Object.freeze({ minimum: 1, maximum: 16 });
/** Bounds of the pool's concurrent loads (the run's snapshot read connections). */
export const ANALYTICS_REFRESH_LOAD_CONCURRENCY_BOUNDS = Object.freeze({ minimum: 1, maximum: 8 });
const SAFE_CODE = /^ANALYTICS_V2_[A-Z0-9_]+$/u;
/** Thrown into a load whose Worker is gone, to stop its reads; never surfaced. */
const ATTEMPT_GONE = Symbol("analytics-refresh-worker-attempt-gone");

function failure(code) {
  return Object.assign(new Error(code), { code });
}

/** The default Worker script: beside the bundled Job entry (dist/). */
export function defaultAnalyticsRefreshWorkerUrl() {
  return new URL("./analytics-refresh-worker.mjs", import.meta.url);
}

/**
 * The old-space limit (bytes, whole MiB) a Worker gets for an owner of
 * `estimateBytes` within a pool of `poolBytes` (ANALYTICS_REFRESH_WORKER_HEAP_MODEL):
 * the modelled heap, at most the pool less one Worker's overhead.
 */
export function analyticsRefreshWorkerHeapLimitBytes(estimateBytes, poolBytes) {
  const model = ANALYTICS_REFRESH_WORKER_HEAP_MODEL;
  const wanted = Math.ceil((estimateBytes * model.heapFactor + model.heapReserveBytes) / MIB) * MIB;
  const most = Math.floor((poolBytes - model.overheadBytes) / MIB) * MIB;
  return Math.min(wanted, most);
}

/**
 * The smallest pool the Job accepts for a run that admits owners up to
 * `memoryBudgetBytes`: one whose whole-pool (alone) limit holds at least the
 * budget, so the largest owner the budget admits always has a Worker heap of
 * at least its estimate. A smaller owner gets its modelled limit; the largest
 * may get the whole pool instead (analyticsRefreshWorkerHeapLimitBytes).
 */
export function analyticsRefreshWorkerPoolMinimumBytes(memoryBudgetBytes) {
  return Math.ceil(memoryBudgetBytes / MIB) * MIB + ANALYTICS_REFRESH_WORKER_HEAP_MODEL.overheadBytes;
}

/**
 * @param {{
 *   workers: number,
 *   memoryBudgetBytes: number,
 *   poolBytes: number,
 *   loadConcurrency?: number,
 *   workerUrl?: URL,
 *   createWorker?: (url: URL, options: object) => Worker,
 * }} options
 */
export function createAnalyticsRefreshOwnerPool({ workers, memoryBudgetBytes, poolBytes, loadConcurrency = 1, workerUrl,
  createWorker, modelBlockSize = 10, modelFanOut = "auto" } = {}) {
  const model = ANALYTICS_REFRESH_WORKER_HEAP_MODEL;
  if (!Number.isSafeInteger(modelBlockSize) || modelBlockSize < 1 || modelBlockSize > 70
      || !["auto", "all", "off"].includes(modelFanOut)
      || !Number.isSafeInteger(workers) || workers < ANALYTICS_REFRESH_WORKER_BOUNDS.minimum
      || workers > ANALYTICS_REFRESH_WORKER_BOUNDS.maximum
      || !Number.isSafeInteger(memoryBudgetBytes) || memoryBudgetBytes < 1
      || !Number.isSafeInteger(poolBytes) || poolBytes < model.overheadBytes + model.heapReserveBytes
      || !Number.isSafeInteger(loadConcurrency) || loadConcurrency < ANALYTICS_REFRESH_LOAD_CONCURRENCY_BOUNDS.minimum
      || loadConcurrency > ANALYTICS_REFRESH_LOAD_CONCURRENCY_BOUNDS.maximum) {
    throw failure("ANALYTICS_V2_REFRESH_WORKERS_INVALID");
  }
  const url = workerUrl ?? defaultAnalyticsRefreshWorkerUrl();
  const spawn = createWorker ?? ((target, options) => new Worker(target, options));
  /** The limit an owner retried alone gets: the whole pool less one overhead. */
  const aloneLimitBytes = Math.floor((poolBytes - model.overheadBytes) / MIB) * MIB;
  /** Owners waiting for admission, longest estimate first; a retried owner goes to the front. */
  const queue = [];
  const running = new Set();
  let chargedBytes = 0;
  let aborted = false;
  let aborting;
  const stopping = new Set();
  const stats = { started: 0, retriedAlone: 0, peakRunning: 0, peakChargedBytes: 0, peakLoads: 0,
    modelBlockedOwners: 0, modelBlocksPerOwner: [], blockMeasurements: [], blockGrantsRequested: 0, blockGrantsGranted: 0,
    blockGrantsRefused: 0, blockSerializedBytes: 0, blockCloneMs: 0, blockEvaluationMs: 0,
    blockHeapPeakBytes: null,
    largestGcCallbackHeapBytes: null, largestGcCallbackHeapShareOfLimit: null };
  /**
   * Loads waiting for a read slot: the largest owner's first (it is the run's
   * critical path), then in request order.
   */
  const loadQueue = [];
  const activeLoads = new Set();
  let loadsRunning = 0;

  const limitOf = (entry) => (entry.alone ? aloneLimitBytes
    : analyticsRefreshWorkerHeapLimitBytes(entry.blockEstimateBytes ?? entry.task.estimateBytes, poolBytes));
  const chargeOf = (entry) => limitOf(entry) + model.overheadBytes + (entry.payloadReserveBytes ?? 0);

  const admit = () => {
    if (aborted) return;
    while (queue.length > 0 && running.size < workers) {
      const next = queue[0];
      if (running.size > 0 && (next.alone || chargedBytes + chargeOf(next) > poolBytes)) return;
      queue.shift();
      start(next);
    }
  };

  const pumpLoads = () => {
    while (!aborted && loadsRunning < loadConcurrency && loadQueue.length > 0) {
      const { job } = loadQueue.shift();
      loadsRunning += 1;
      stats.peakLoads = Math.max(stats.peakLoads, loadsRunning);
      const loading = Promise.resolve().then(job).finally(() => {
        activeLoads.delete(loading);
        loadsRunning -= 1;
        pumpLoads();
      });
      activeLoads.add(loading);
      void loading.catch(() => {});
    }
  };

  const release = (entry) => {
    if (entry.stopping !== null) return entry.stopping;
    const worker = entry.worker;
    entry.worker = null;
    entry.grantPort?.close();
    entry.grantPort = null;
    if (worker !== null) worker.removeAllListeners("message");
    // Keep the isolate's admission charge and slot until its termination is
    // confirmed. A result message arrives before the isolate has exited.
    const chargeBytes = entry.chargeBytes;
    const stopped = Promise.resolve().then(() => worker?.terminate()).then(() => {
      if (running.delete(entry)) chargedBytes -= chargeBytes;
      if (entry.parent !== undefined) {
        entry.parent.children.delete(entry);
        if (entry.parent.worker !== null && !entry.parent.blockFailure && !entry.parent.settled) {
          try { entry.parent.worker.postMessage({ type: "blockReleased", id: entry.blockId }); }
          catch { fail(entry.parent, "ANALYTICS_V2_REFRESH_WORKER_TRANSFER_FAILED"); }
        }
      }
      admit();
    });
    entry.stopping = stopped;
    stopping.add(stopped);
    void stopped.then(() => stopping.delete(stopped), () => {});
    return stopped;
  };

  const settle = (entry, error, value) => {
    if (entry.settled) return;
    entry.settled = true;
    // Preserve the first failure before abort rejects the other owners. A
    // successful result waits for exit, while a failure still awaits pool
    // termination through the Job's finally/abort path.
    if (error !== null) entry.reject(error);
    void release(entry).then(() => {
      if (error === null) entry.resolve(value);
    }, () => {
      entry.reject(failure("ANALYTICS_V2_REFRESH_WORKER_TERMINATION_FAILED"));
      void abort().catch(() => {});
    });
  };

  const fail = (entry, code) => {
    settle(entry, failure(code), null);
    void abort().catch(() => {});
  };

  /** The owner outgrew its limit: retry it once, alone, with the whole pool; otherwise fail the run. */
  const outOfMemory = (entry) => {
    if (entry.settled) return;
    if (entry.alone || limitOf(entry) >= aloneLimitBytes || aborted) {
      fail(entry, "ANALYTICS_V2_REFRESH_WORKER_OUT_OF_MEMORY");
      return;
    }
    void release(entry).catch(() => {
      if (!entry.settled) {
        entry.settled = true;
        entry.reject(failure("ANALYTICS_V2_REFRESH_WORKER_TERMINATION_FAILED"));
      }
      void abort().catch(() => {});
    });
    entry.alone = true;
    entry.attempt += 1;
    stats.retriedAlone += 1;
    queue.unshift(entry);
    admit();
  };

  // New children are stopped before delegating to the unchanged owner's OOM
  // retry. Retiring children keep their slots/charge until release confirms exit.
  const familyOutOfMemory = (entry) => {
    if (entry.settled || entry.blockFailure) return;
    if (entry.children.size === 0) { outOfMemory(entry); return; }
    entry.blockFailure = true;
    void Promise.all([...entry.children].map(release)).then(() => outOfMemory(entry), () => {
      fail(entry, "ANALYTICS_V2_REFRESH_WORKER_TERMINATION_FAILED");
    });
  };

  /** No-wait grants: reserve sizing/clone memory BEFORE the sender serializes. */
  const grantBlocks = (parent, message) => {
    if (!Array.isArray(message.blocks) || message.blocks.length > 69
        || !Number.isSafeInteger(message.totalBlocks) || message.totalBlocks < 1 || message.totalBlocks > 70
        || message.blocks.length !== message.totalBlocks - 1 || parent.blocksRequested) {
      fail(parent, "ANALYTICS_V2_REFRESH_WORKER_PROTOCOL_INVALID"); return;
    }
    parent.blocksRequested = true;
    stats.modelBlockedOwners += 1;
    stats.modelBlocksPerOwner.push({ ownerIndex: parent.task.index, blocks: message.totalBlocks });
    const grants = [];
    const transfers = [];
    const quotaRows = parent.task.evidence.reduce((sum, [, counts]) => sum + counts.quota, 0);
    for (const block of message.blocks) {
      stats.blockGrantsRequested += 1;
      if (!Number.isSafeInteger(block.id) || block.id < 0 || !Number.isSafeInteger(block.quotaRows)
          || block.quotaRows < 0 || block.quotaRows > quotaRows
          || !Number.isSafeInteger(block.dateCount) || block.dateCount < 1 || block.dateCount > 70
          || !Number.isSafeInteger(block.payloadBoundBytes) || block.payloadBoundBytes < MIB
          || grants.some((grant) => grant.id === block.id)) {
        fail(parent, "ANALYTICS_V2_REFRESH_WORKER_PROTOCOL_INVALID"); return;
      }
      // Full owner estimate is deliberately conservative until isolated block
      // peaks qualify tighter sizes. The measured quota memo (379.53 B/row)
      // gets an additional 512 B/row. Neither changes resources.ts verdicts.
      const payloadBoundBytes = block.payloadBoundBytes;
      // A date's reduction checkpoint is bounded at 8 MiB. Reserve that full
      // envelope for every returned date, independent of input density.
      const resultBoundBytes = block.dateCount * 8 * MIB;
      const child = { task: parent.task, context: parent.context, parent, blockId: block.id,
        blockEstimateBytes: parent.task.estimateBytes + block.quotaRows * 512,
        payloadReserveBytes: payloadBoundBytes * 2 + resultBoundBytes * 2, payloadBoundBytes, resultBoundBytes,
        worker: null, grantPort: null, settled: false, alone: false, attempt: parent.attempt, chargeBytes: 0, stopping: null,
        resolve: () => {}, reject: () => {}, resultSent: false, consumed: false };
      // Every denial is immediate; it never enters the owner admission queue.
      if (parent.alone || [...running].some((entry) => entry.alone) || running.size >= workers
          || chargedBytes + chargeOf(child) > poolBytes) {
        stats.blockGrantsRefused += 1;
        grants.push({ id: block.id, port: null }); continue;
      }
      const { port1, port2 } = new MessageChannel();
      child.grantPort = port1;
      parent.children.add(child);
      running.add(child);
      child.chargeBytes = chargeOf(child);
      chargedBytes += child.chargeBytes;
      stats.blockGrantsGranted += 1;
      stats.peakRunning = Math.max(stats.peakRunning, running.size);
      stats.peakChargedBytes = Math.max(stats.peakChargedBytes, chargedBytes);
      let worker;
      try {
        worker = spawn(url, { workerData: { block: true, port: port2, task: parent.task,
          context: parent.context, payloadBoundBytes, resultBoundBytes }, transferList: [port2],
          resourceLimits: { maxOldGenerationSizeMb: limitOf(child) / MIB,
            maxYoungGenerationSizeMb: model.youngGenerationBytes / MIB },
          env: {}, argv: [], stdout: false, stderr: false });
      } catch {
        port1.close(); port2.close(); fail(parent, "ANALYTICS_V2_REFRESH_WORKER_START_FAILED"); return;
      }
      child.worker = worker;
      const attempt = parent.attempt;
      const current = () => !aborted && !parent.settled && !parent.blockFailure
        && parent.attempt === attempt && child.worker === worker;
      worker.on("message", (event) => {
        if (!current()) return;
        if (event?.type === "heap") {
          if (!Number.isSafeInteger(event.limitBytes) || event.limitBytes < limitOf(child)
              || event.limitBytes > limitOf(child) + model.overheadBytes) {
            fail(parent, "ANALYTICS_V2_REFRESH_WORKER_HEAP_LIMIT_UNAPPLIED");
          }
        } else if (event?.type === "progress") {
          try { parent.io.progress(event.event); }
          catch (error) { settle(parent, error, null); void abort().catch(() => {}); }
        } else if (event?.type === "blockDone") {
          if (child.resultSent || !Number.isSafeInteger(event.serializedBytes) || event.serializedBytes < 0
              || event.serializedBytes > child.payloadBoundBytes
              || !Number.isFinite(event.cloneMs) || event.cloneMs < 0
              || !Number.isFinite(event.evaluationMs) || event.evaluationMs < 0
              || !(event.heapPeakBytes === null || (Number.isSafeInteger(event.heapPeakBytes) && event.heapPeakBytes >= 0))) {
            fail(parent, "ANALYTICS_V2_REFRESH_WORKER_PROTOCOL_INVALID"); return;
          }
          child.resultSent = true;
          stats.blockSerializedBytes += event.serializedBytes;
          stats.blockCloneMs += event.cloneMs;
          stats.blockEvaluationMs += event.evaluationMs;
          if (event.heapPeakBytes !== null) stats.blockHeapPeakBytes = Math.max(stats.blockHeapPeakBytes ?? 0, event.heapPeakBytes);
          stats.blockMeasurements.push({ ownerIndex: parent.task.index, blockIndex: child.blockId,
            serializedBytes: event.serializedBytes, cloneMs: event.cloneMs, evaluationMs: event.evaluationMs,
            heapPeakBytes: event.heapPeakBytes ?? null, memoRebuildMs: null });
          if (child.consumed) void release(child).catch(() => fail(parent, "ANALYTICS_V2_REFRESH_WORKER_TERMINATION_FAILED"));
        } else if (event?.type === "failed") {
          fail(parent, typeof event.code === "string" && SAFE_CODE.test(event.code)
            ? event.code : "ANALYTICS_V2_REFRESH_WORKER_FAILED");
        } else fail(parent, "ANALYTICS_V2_REFRESH_WORKER_PROTOCOL_INVALID");
      });
      worker.on("error", (error) => {
        if (!current()) return;
        if (error?.code === "ERR_WORKER_OUT_OF_MEMORY") familyOutOfMemory(parent);
        else fail(parent, "ANALYTICS_V2_REFRESH_WORKER_FAILED");
      });
      worker.on("exit", () => { if (current()) fail(parent, "ANALYTICS_V2_REFRESH_WORKER_EXITED"); });
      grants.push({ id: block.id, port: port1, payloadBoundBytes, resultBoundBytes });
      transfers.push(port1);
    }
    try {
      parent.worker.postMessage({ type: "blockGrants", id: message.id, grants }, transfers);
      for (const child of parent.children) child.grantPort = null;
    }
    catch { fail(parent, "ANALYTICS_V2_REFRESH_WORKER_TRANSFER_FAILED"); }
  };

  const start = (entry) => {
    entry.stopping = null;
    entry.blockFailure = false;
    entry.blocksRequested = false;
    running.add(entry);
    entry.chargeBytes = chargeOf(entry);
    chargedBytes += entry.chargeBytes;
    stats.started += 1;
    stats.peakRunning = Math.max(stats.peakRunning, running.size);
    stats.peakChargedBytes = Math.max(stats.peakChargedBytes, chargedBytes);
    try {
      entry.io.started();
    } catch (error) {
      settle(entry, error, null);
      void abort().catch(() => {});
      return;
    }
    let worker;
    try {
      worker = spawn(url, {
        workerData: { task: entry.task, context: entry.context,
          modelBlockSize, modelFanOut: entry.alone ? "off" : modelFanOut },
        resourceLimits: { maxOldGenerationSizeMb: limitOf(entry) / MIB,
          maxYoungGenerationSizeMb: model.youngGenerationBytes / MIB },
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
    const attempt = entry.attempt;
    const current = () => !entry.settled && !entry.blockFailure && entry.attempt === attempt && entry.worker === worker;
    worker.on("message", (message) => {
      if (!current() || message === null || typeof message !== "object") return;
      switch (message.type) {
        case "blockRequest":
          grantBlocks(entry, message); break;
        case "blockConsumed": {
          const child = [...entry.children].find((value) => value.blockId === message.id);
          if (child === undefined || child.consumed) { fail(entry, "ANALYTICS_V2_REFRESH_WORKER_PROTOCOL_INVALID"); break; }
          child.consumed = true;
          if (child.resultSent) void release(child).catch(() => fail(entry, "ANALYTICS_V2_REFRESH_WORKER_TERMINATION_FAILED"));
          break;
        }
        case "load": {
          const id = message.id;
          const span = Object.freeze({ fromDay: message.span?.fromDay, throughDay: message.span?.throughDay });
          const job = async () => {
            if (!current()) return;
            try {
              await entry.io.load(span, (stream, days, ordinal) => {
                if (!current()) throw ATTEMPT_GONE;
                worker.postMessage({ type: "part", id, ordinal, stream, days });
              });
            } catch (error) {
              if (error === ATTEMPT_GONE || !current()) return;
              if (error?.name === "DataCloneError") {
                fail(entry, "ANALYTICS_V2_REFRESH_WORKER_TRANSFER_FAILED");
                return;
              }
              settle(entry, error, null);
              void abort().catch(() => {});
              return;
            }
            if (!current()) return;
            try {
              worker.postMessage({ type: "loaded", id });
            } catch {
              fail(entry, "ANALYTICS_V2_REFRESH_WORKER_TRANSFER_FAILED");
            }
          };
          const queued = { job, estimateBytes: entry.task.estimateBytes, index: entry.task.index };
          let position = loadQueue.findIndex((other) => other.estimateBytes < queued.estimateBytes
            || (other.estimateBytes === queued.estimateBytes && other.index > queued.index));
          if (position < 0) position = loadQueue.length;
          loadQueue.splice(position, 0, queued);
          pumpLoads();
          break;
        }
        case "heap": {
          // V8 sizes heap_size_limit as the old-space limit plus the young
          // generation, so it must lie in [limit, limit + overhead]. Anything
          // else means a process-wide heap flag overrode resourceLimits: the
          // admission would not bound the Workers' heaps, so the run stops.
          const limit = limitOf(entry);
          if (!Number.isSafeInteger(message.limitBytes) || message.limitBytes < limit
              || message.limitBytes > limit + model.overheadBytes) {
            fail(entry, "ANALYTICS_V2_REFRESH_WORKER_HEAP_LIMIT_UNAPPLIED");
          }
          break;
        }
        case "progress":
          try {
            entry.io.progress(message.event);
          } catch (error) {
            settle(entry, error, null);
            void abort().catch(() => {});
          }
          break;
        case "result":
          if (entry.children.size > 0) { fail(entry, "ANALYTICS_V2_REFRESH_WORKER_PROTOCOL_INVALID"); break; }
          if (Number.isSafeInteger(message.gcCallbackHeapPeakBytes) && message.gcCallbackHeapPeakBytes >= 0) {
            stats.largestGcCallbackHeapBytes = Math.max(stats.largestGcCallbackHeapBytes ?? 0, message.gcCallbackHeapPeakBytes);
            stats.largestGcCallbackHeapShareOfLimit = Math.max(stats.largestGcCallbackHeapShareOfLimit ?? 0,
              message.gcCallbackHeapPeakBytes / limitOf(entry));
          }
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
      if (!current()) return;
      if (error?.code === "ERR_WORKER_OUT_OF_MEMORY") familyOutOfMemory(entry);
      else fail(entry, "ANALYTICS_V2_REFRESH_WORKER_FAILED");
    });
    worker.on("exit", () => {
      if (current()) fail(entry, "ANALYTICS_V2_REFRESH_WORKER_EXITED");
    });
  };

  function abort() {
    if (aborting !== undefined) return aborting;
    aborted = true;
    loadQueue.splice(0);
    for (const entry of queue.splice(0)) {
      entry.settled = true;
      entry.reject(failure("ANALYTICS_V2_REFRESH_WORKER_ABORTED"));
    }
    for (const entry of [...running]) {
      if (!entry.settled) {
        entry.settled = true;
        entry.reject(failure("ANALYTICS_V2_REFRESH_WORKER_ABORTED"));
      }
      release(entry);
    }
    // Includes Workers already detached by settle or an OOM retry.
    aborting = Promise.allSettled([...stopping, ...activeLoads]).then((results) => {
      if (results.some((result) => result.status === "rejected")) {
        throw failure("ANALYTICS_V2_REFRESH_WORKER_TERMINATION_FAILED");
      }
    });
    return aborting;
  }

  return Object.freeze({
    workers,
    poolBytes,
    loadConcurrency,
    compute(task, context, io) {
      if (aborted) return Promise.reject(failure("ANALYTICS_V2_REFRESH_WORKER_ABORTED"));
      if (task === null || typeof task !== "object" || !Number.isSafeInteger(task.estimateBytes)
          || task.estimateBytes < 0 || task.estimateBytes > memoryBudgetBytes) {
        return Promise.reject(failure("ANALYTICS_V2_REFRESH_WORKER_TASK_INVALID"));
      }
      return new Promise((resolve, reject) => {
        const entry = { task, context, io, resolve, reject, worker: null, settled: false, alone: false, attempt: 0,
          chargeBytes: 0, stopping: null, children: new Set(), blockFailure: false, blocksRequested: false };
        let position = queue.findIndex((queued) => !queued.alone && (queued.task.estimateBytes < task.estimateBytes
          || (queued.task.estimateBytes === task.estimateBytes && queued.task.index > task.index)));
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
    /** Content-free operational counts for the receipt. */
    stats: () => Object.freeze({ ...stats, modelBlocksPerOwner: Object.freeze([...stats.modelBlocksPerOwner]),
      blockMeasurements: Object.freeze([...stats.blockMeasurements].sort((a, b) => a.ownerIndex - b.ownerIndex || a.blockIndex - b.blockIndex)) }),
  });
}
