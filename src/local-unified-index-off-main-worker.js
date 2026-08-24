import { parentPort, workerData } from "node:worker_threads";

import {
  ingestLocalUnifiedIndexIncrement,
} from "./local-unified-index-ingest.js";

if (parentPort === null) {
  throw new Error("local unified index worker requires a parent port");
}

const abortController = new AbortController();
const progressWaiters = new Map();
let nextProgressId = 0;

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

function settleProgress(id, error = null) {
  const waiter = progressWaiters.get(id);
  if (waiter === undefined) return;
  progressWaiters.delete(id);
  if (error === null) waiter.resolve();
  else waiter.reject(error);
}

function reportProgress(value) {
  const id = ++nextProgressId;
  return new Promise((resolve, reject) => {
    progressWaiters.set(id, { resolve, reject });
    try {
      parentPort.postMessage({ type: "progress", id, value });
    } catch {
      settleProgress(id, fixedError("local_unified_index_progress_failed"));
    }
  });
}

parentPort.on("message", (message) => {
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
      fixedError(safeErrorCode(message, "local_unified_index_progress_failed")),
    );
  }
});

try {
  const result = await ingestLocalUnifiedIndexIncrement({
    ...workerData.options,
    signal: abortController.signal,
    onProgress: workerData.hasProgress ? reportProgress : null,
  });
  parentPort.postMessage({ type: "result", result });
} catch (error) {
  parentPort.postMessage({
    type: "error",
    code: safeErrorCode(error, "local_unified_index_worker_failed"),
  });
} finally {
  parentPort.close();
}
