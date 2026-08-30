import {
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";

import {
  ingestLocalUnifiedIndexIncrement,
} from "./local-unified-index-ingest.js";

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeErrorCode(error, fallback) {
  const code = error?.code;
  return typeof code === "string"
      && /^[a-z0-9][a-z0-9_-]{0,127}$/u.test(code)
    ? code
    : fallback;
}

/**
 * Worker-side protocol for one staged unified-index attempt. This module is
 * also imported by the parent so the static macOS runtime graph includes the
 * worker entrypoint; importing it on the main thread has no side effects.
 */
export async function runLocalUnifiedIndexOffMainWorkerThread({
  port = parentPort,
  data = workerData,
} = {}) {
  if (port === null || data === null || typeof data !== "object") {
    throw fixedError("local_unified_index_worker_protocol_invalid");
  }
  const abortController = new AbortController();
  const progressWaiters = new Map();
  let nextProgressId = 0;

  const settleProgress = (id, error = null) => {
    const waiter = progressWaiters.get(id);
    if (waiter === undefined) return;
    progressWaiters.delete(id);
    if (error === null) waiter.resolve();
    else waiter.reject(error);
  };
  const reportProgress = (value) => {
    const id = ++nextProgressId;
    return new Promise((resolve, reject) => {
      progressWaiters.set(id, { resolve, reject });
      try {
        port.postMessage({ type: "progress", id, value });
      } catch {
        settleProgress(id, fixedError("local_unified_index_progress_failed"));
      }
    });
  };

  port.on("message", (message) => {
    if (message?.type === "abort") {
      abortController.abort();
      for (const id of progressWaiters.keys()) {
        settleProgress(id, fixedError("local_unified_index_aborted"));
      }
      return;
    }
    if (message?.type === "progress_ack") {
      settleProgress(message.id);
      return;
    }
    if (message?.type === "progress_error") {
      settleProgress(
        message.id,
        fixedError(safeErrorCode(
          message,
          "local_unified_index_progress_failed",
        )),
      );
    }
  });

  try {
    const result = await ingestLocalUnifiedIndexIncrement({
      ...data.options,
      signal: abortController.signal,
      onProgress: data.hasProgress === true ? reportProgress : null,
    });
    port.postMessage({ type: "result", result });
  } catch (error) {
    port.postMessage({
      type: "error",
      code: safeErrorCode(error, "local_unified_index_worker_failed"),
    });
  } finally {
    port.close();
  }
}

if (!isMainThread) {
  await runLocalUnifiedIndexOffMainWorkerThread();
}
