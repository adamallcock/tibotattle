import { Worker } from "node:worker_threads";

import {
  readLocalUnifiedCompanionProjection,
} from "./local-unified-companion-source.js";
// Keep the worker entrypoint in the statically reviewed native runtime graph.
// Importing it on the main thread does not run the worker protocol.
import "./local-unified-companion-off-main-worker.js";

const PROJECTION_MODES = new Set(["full", "deferred"]);

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeErrorCode(value) {
  return typeof value === "string"
      && /^[a-z0-9][a-z0-9_-]{0,127}$/u.test(value)
    ? value
    : "local_unified_companion_projection_worker_failed";
}

function validateOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  if (typeof options.indexFile !== "string" || options.indexFile.length < 1) {
    throw new TypeError("indexFile must be a non-empty string");
  }
  if (options.operation === "work-usage") {
    if (typeof options.codexHome !== "string" || !Number.isSafeInteger(options.fromMs)
        || options.fromMs < 0 || !Number.isSafeInteger(options.toMs)
        || options.toMs < options.fromMs) throw new TypeError("invalid work usage interval");
    return { operation: "work-usage", indexFile: options.indexFile, codexHome: options.codexHome,
      fromMs: options.fromMs, toMs: options.toMs, scope: options.scope, secretFile: options.secretFile };
  }
  if (options.includeWorkUsage === true && typeof options.codexHome !== "string") {
    throw new TypeError("codexHome must be a string");
  }
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("nowMs must be a finite epoch timestamp");
  }
  const mode = options.mode ?? "full";
  if (!PROJECTION_MODES.has(mode)) {
    throw new TypeError("mode must be full or deferred");
  }
  return {
    indexFile: options.indexFile,
    nowMs,
    declaredSpeedBaselines: Array.isArray(options.declaredSpeedBaselines)
      ? options.declaredSpeedBaselines
      : [],
    mode,
    ...(options.includeWorkUsage === true ? { includeWorkUsage: true, codexHome: options.codexHome, secretFile: options.secretFile } : {}),
  };
}

export function shouldRunLocalUnifiedCompanionProjectionOffMain({
  platform = process.platform,
  mode = "full",
} = {}) {
  return platform === "darwin" && mode === "full";
}

/**
 * Keep the native companion control plane responsive while SQLite projects a
 * large published generation. Other platforms retain their qualified direct
 * reader, and deferred reads never pay worker startup cost.
 *
 * The worker is read-only, so an abort can terminate it immediately without
 * risking a partial publication or database mutation.
 */
export async function readLocalUnifiedCompanionProjectionOffMain(
  options = {},
  {
    signal = null,
    platform = process.platform,
    WorkerClass = Worker,
  } = {},
) {
  const selected = validateOptions(options);
  if (signal !== null
      && (typeof signal !== "object"
        || typeof signal.aborted !== "boolean"
        || typeof signal.addEventListener !== "function")) {
    throw new TypeError("signal must be an AbortSignal or null");
  }
  if (typeof WorkerClass !== "function") {
    throw new TypeError("WorkerClass must be a constructor");
  }
  if (signal?.aborted === true) {
    throw fixedError("local_unified_companion_projection_aborted");
  }
  if (selected.operation !== "work-usage" && !shouldRunLocalUnifiedCompanionProjectionOffMain({
    platform,
    mode: selected.mode,
  })) {
    try {
      return await readLocalUnifiedCompanionProjection({ ...selected, signal });
    } catch (error) {
      if (signal?.aborted === true) {
        throw fixedError("local_unified_companion_projection_aborted");
      }
      throw error;
    }
  }

  let worker;
  try {
    worker = new WorkerClass(
      new URL("./local-unified-companion-off-main-worker.js", import.meta.url),
      { workerData: { options: selected }, execArgv: [] },
    );
  } catch {
    throw fixedError("local_unified_companion_projection_worker_failed");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let terminal = null;
    let exitObserved = false;

    const cleanup = () => {
      signal?.removeEventListener?.("abort", abort);
    };
    const finish = () => {
      if (settled || terminal === null || !exitObserved) return;
      settled = true;
      cleanup();
      if (terminal.error !== null) reject(terminal.error);
      else resolve(terminal.result);
    };
    const selectTerminal = ({ result = null, error = null } = {}) => {
      if (terminal !== null || settled) return;
      terminal = { result, error };
      finish();
    };
    const abort = () => {
      if (settled || terminal !== null) return;
      selectTerminal({
        error: fixedError("local_unified_companion_projection_aborted"),
      });
      Promise.resolve(worker.terminate()).catch(() => {
        // Exit remains the authoritative shutdown acknowledgement.
      });
    };

    signal?.addEventListener?.("abort", abort, { once: true });
    worker.on("message", (message) => {
      if (message?.type === "result") {
        selectTerminal({ result: message.result });
      } else if (message?.type === "error") {
        selectTerminal({ error: fixedError(safeErrorCode(message.code)) });
      }
    });
    worker.on("error", () => {
      selectTerminal({
        error: fixedError("local_unified_companion_projection_worker_failed"),
      });
    });
    worker.on("exit", (code) => {
      exitObserved = true;
      if (code !== 0 && terminal?.error === null) {
        terminal = {
          result: null,
          error: fixedError("local_unified_companion_projection_worker_failed"),
        };
      } else if (terminal === null) {
        selectTerminal({
          error: fixedError("local_unified_companion_projection_worker_failed"),
        });
      }
      finish();
    });
  });
}

/**
 * Retain one private metadata cache between reads, without retaining database
 * handles or transferring the cache to the control plane. Requests run serially;
 * cancellation of active worker work discards that worker and its cache.
 */
export function createLocalUnifiedCompanionProjectionReader({
  platform = process.platform,
  WorkerClass = Worker,
  idleTimeoutMs = 300_000,
  maxQueueSize = 64,
} = {}) {
  if (typeof WorkerClass !== "function") throw new TypeError("WorkerClass must be a constructor");
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1 || idleTimeoutMs > 300_000) {
    throw new TypeError("idleTimeoutMs must be between 1 and 300000");
  }
  if (!Number.isSafeInteger(maxQueueSize) || maxQueueSize < 1 || maxQueueSize > 64) {
    throw new TypeError("maxQueueSize must be between 1 and 64");
  }
  let worker = null;
  let workerConstructor = null;
  let active = null;
  let stopping = null;
  let idleTimer = null;
  let closed = false;
  let nextId = 0;
  let cacheScope = null;
  let workUsageMetadataCache = new Map();
  const queue = [];
  const error = (suffix) => fixedError(`local_unified_companion_projection_${suffix}`);
  const clearIdle = () => { clearTimeout(idleTimer); idleTimer = null; };
  const discardDirectCache = () => { cacheScope = null; workUsageMetadataCache = new Map(); };
  const settle = (job, result, failure) => {
    job.signal?.removeEventListener?.("abort", job.abort);
    if (failure) job.reject(failure);
    else job.resolve(result);
  };
  const waitForStop = (completion) => {
    const barrier = Promise.allSettled([stopping, completion]);
    stopping = barrier;
    void barrier.then(() => {
      if (stopping === barrier) stopping = null;
      pump();
    });
    return barrier;
  };
  const stopWorker = () => {
    clearIdle();
    if (!worker) return stopping ?? Promise.resolve();
    const retired = worker;
    worker = null;
    workerConstructor = null;
    // Termination may throw in an injected adapter; never leak a rejection.
    const termination = Promise.resolve().then(() => retired.terminate()).catch(() => {});
    return waitForStop(termination);
  };
  const finish = (job, result, failure) => {
    if (active !== job) return;
    active = null;
    settle(job, result, failure);
    pump();
  };
  const failWorker = (instance) => {
    if (worker !== instance) return;
    stopWorker();
    if (active?.offMain) finish(active, null, error("worker_failed"));
  };
  const pump = () => {
    if (closed || active || stopping) return;
    if (queue.length === 0) {
      worker?.unref?.();
      clearIdle();
      if (worker || cacheScope !== null) {
        idleTimer = setTimeout(() => { discardDirectCache(); stopWorker(); }, idleTimeoutMs);
        idleTimer.unref?.();
      }
      return;
    }
    clearIdle();
    const job = queue.shift();
    active = job;
    const offMain = job.options.operation === "work-usage"
      || shouldRunLocalUnifiedCompanionProjectionOffMain({ platform: job.platform, mode: job.options.mode });
    job.offMain = offMain;
    if (!offMain) {
      const scope = JSON.stringify([job.options.indexFile, job.options.codexHome, job.options.secretFile]);
      if (scope !== cacheScope) { cacheScope = scope; workUsageMetadataCache = new Map(); }
      job.directCompletion = readLocalUnifiedCompanionProjection({ ...job.options,
        signal: job.controller.signal, workUsageMetadataCache })
        .then((result) => finish(job, result, null), (failure) => {
          discardDirectCache();
          finish(job, null, job.controller.signal.aborted ? error("aborted") : failure);
        });
      return;
    }
    if (worker && workerConstructor !== job.WorkerClass) {
      active = null;
      queue.unshift(job);
      stopWorker();
      return;
    }
    try {
      if (!worker) {
        const instance = new job.WorkerClass(
          new URL("./local-unified-companion-off-main-worker.js", import.meta.url),
          { workerData: { persistent: true }, execArgv: [] },
        );
        worker = instance;
        workerConstructor = job.WorkerClass;
        instance.on("message", (message) => {
          if (worker !== instance || !active?.offMain) return;
          if (message?.requestId !== active.id || !["result", "error"].includes(message?.type)) {
            failWorker(instance);
            return;
          }
          finish(active, message.result, message.type === "error" ? fixedError(safeErrorCode(message.code)) : null);
        });
        instance.on("error", () => failWorker(instance));
        instance.on("messageerror", () => failWorker(instance));
        instance.on("exit", () => failWorker(instance));
      }
      worker.ref?.();
      worker.postMessage({ type: "read", requestId: job.id, options: job.options });
    } catch {
      stopWorker();
      finish(job, null, error("worker_failed"));
    }
  };
  const reader = async (options = {}, controls = {}) => {
    const selected = validateOptions(options);
    const signal = controls.signal ?? null;
    const constructor = controls.WorkerClass ?? WorkerClass;
    if (signal !== null && (typeof signal !== "object" || typeof signal.aborted !== "boolean"
        || typeof signal.addEventListener !== "function")) throw new TypeError("signal must be an AbortSignal or null");
    if (typeof constructor !== "function") throw new TypeError("WorkerClass must be a constructor");
    if (closed) throw error("reader_closed");
    if (signal?.aborted) throw error("aborted");
    if (queue.length >= maxQueueSize) throw error("queue_full");
    return new Promise((resolve, reject) => {
      const job = { id: ++nextId, options: selected, signal, WorkerClass: constructor,
        platform: controls.platform ?? platform, resolve, reject, abort: null,
        controller: new AbortController(), directCompletion: null };
      job.abort = () => {
        if (active === job) {
          job.controller.abort();
          discardDirectCache();
          stopWorker();
          if (job.directCompletion) waitForStop(job.directCompletion);
          finish(job, null, error("aborted"));
        } else {
          const index = queue.indexOf(job);
          if (index < 0) return;
          queue.splice(index, 1);
          settle(job, null, error("aborted"));
        }
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      queue.push(job);
      pump();
    });
  };
  reader.close = () => {
    closed = true;
    discardDirectCache();
    clearIdle();
    if (active) {
      const job = active;
      active = null;
      job.controller.abort();
      if (job.directCompletion) waitForStop(job.directCompletion);
      settle(job, null, error("reader_closed"));
    }
    for (const job of queue.splice(0)) settle(job, null, error("reader_closed"));
    return stopWorker();
  };
  return reader;
}
