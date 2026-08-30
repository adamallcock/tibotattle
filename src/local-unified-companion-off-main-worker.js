import {
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";

import {
  readLocalUnifiedCompanionProjection,
} from "./local-unified-companion-source.js";

function safeErrorCode(error) {
  return typeof error?.code === "string"
      && /^[a-z0-9][a-z0-9_-]{0,127}$/u.test(error.code)
    ? error.code
    : "local_unified_companion_projection_worker_failed";
}

/**
 * Read one immutable unified-index publication in a worker thread. The
 * projection is content-free and structured-cloneable; raw rows, paths and
 * database handles never cross back to the companion event loop.
 */
export async function runLocalUnifiedCompanionProjectionWorkerThread({
  port = parentPort,
  data = workerData,
} = {}) {
  if (port === null || data === null || typeof data !== "object") {
    const error = new Error("local_unified_companion_projection_worker_protocol_invalid");
    error.code = "local_unified_companion_projection_worker_protocol_invalid";
    throw error;
  }
  try {
    const result = await readLocalUnifiedCompanionProjection(data.options);
    port.postMessage({ type: "result", result });
  } catch (error) {
    port.postMessage({ type: "error", code: safeErrorCode(error) });
  } finally {
    port.close();
  }
}

if (!isMainThread) {
  await runLocalUnifiedCompanionProjectionWorkerThread();
}
