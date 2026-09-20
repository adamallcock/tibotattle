import { readLocalWorkUsageSnapshot } from "./local-work-usage-source.js";
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
  if (data.persistent === true) {
    let cacheScope = null;
    let workUsageMetadataCache = new Map();
    let pending = Promise.resolve();
    port.on("message", (message) => {
      pending = pending.then(async () => {
        const requestId = message?.requestId;
        if (message?.type !== "read" || !Number.isSafeInteger(requestId)
            || message.options === null || typeof message.options !== "object") {
          port.postMessage({ type: "error", requestId,
            code: "local_unified_companion_projection_worker_protocol_invalid" });
          return;
        }
        const scope = JSON.stringify([message.options.indexFile,
          message.options.codexHome, message.options.secretFile]);
        if (scope !== cacheScope) {
          cacheScope = scope;
          workUsageMetadataCache = new Map();
        }
        try {
          const options = { ...message.options, workUsageMetadataCache };
          const result = await (options.operation === "work-usage"
            ? readLocalWorkUsageSnapshot(options)
            : readLocalUnifiedCompanionProjection(options));
          port.postMessage({ type: "result", requestId, result });
        } catch (error) {
          workUsageMetadataCache = new Map();
          port.postMessage({ type: "error", requestId, code: safeErrorCode(error) });
        }
      }).catch(() => {
        // A closed port or an uncloneable error response cannot be recovered.
        // Exiting makes the owner reject its active request with a fixed code.
        port.close();
      });
    });
    return;
  }
  try {
    const result = await (data.options.operation === "work-usage"
      ? readLocalWorkUsageSnapshot(data.options)
      : readLocalUnifiedCompanionProjection(data.options));
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
