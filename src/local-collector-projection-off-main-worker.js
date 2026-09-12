import {
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";

import {
  readLocalCollectorProjection,
} from "./local-collector-projection.js";

export const LOCAL_COLLECTOR_PROJECTION_WORKER_CONTRACT =
  "local-collector-projection-worker-v1";

const WORKER_ERROR = "local_collector_projection_worker_failed";
const PROPAGATED_ERROR_CODES = new Set([
  "collector_invalid_size",
  "collector_unavailable",
  "local_collector_state_corrupt",
  "local_collector_state_schema_invalid",
  "local_collector_state_unavailable",
]);

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeErrorCode(error) {
  return PROPAGATED_ERROR_CODES.has(error?.code) ? error.code : WORKER_ERROR;
}

function validWorkerOptions(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (Object.keys(value).sort().join("\0")
      !== "declaredSpeedBaselines\0nowMs\0stateFile\0summarizeUsageEvents") {
    return false;
  }
  return typeof value.stateFile === "string"
    && value.stateFile.length > 0
    && Number.isFinite(value.nowMs)
    && typeof value.summarizeUsageEvents === "boolean"
    && Array.isArray(value.declaredSpeedBaselines);
}

/**
 * Perform one collector projection without returning raw records or path data.
 * The parent validates the options before construction; malformed worker data
 * is still rejected here without copying it into an error message.
 */
export async function runLocalCollectorProjectionWorkerThread({
  port = parentPort,
  data = workerData,
} = {}) {
  if (port === null || data === null || typeof data !== "object"
      || Array.isArray(data) || data.options === null
      || typeof data.options !== "object" || Array.isArray(data.options)
      || Object.keys(data).sort().join("\0") !== "contract\0options"
      || data.contract !== LOCAL_COLLECTOR_PROJECTION_WORKER_CONTRACT
      || !validWorkerOptions(data.options)) {
    throw fixedError("local_collector_projection_worker_protocol_invalid");
  }
  try {
    const options = data.options;
    const result = await readLocalCollectorProjection(
      options.stateFile,
      options.nowMs,
      {
        summarizeUsageEvents: options.summarizeUsageEvents,
        declaredSpeedBaselines: options.declaredSpeedBaselines,
      },
    );
    port.postMessage({ type: "result", result });
  } catch (error) {
    port.postMessage({ type: "error", code: safeErrorCode(error) });
  } finally {
    port.close();
  }
}

if (!isMainThread
    && workerData?.contract === LOCAL_COLLECTOR_PROJECTION_WORKER_CONTRACT) {
  await runLocalCollectorProjectionWorkerThread();
}
