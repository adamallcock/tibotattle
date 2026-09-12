import {
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";

import {
  verifyLocalCollectorStateIntegrity,
} from "./local-collector-state.js";

export const LOCAL_COLLECTOR_STATE_INTEGRITY_WORKER_CONTRACT =
  "local-collector-state-integrity-worker-v1";

const WORKER_ERROR = "local_collector_state_integrity_worker_failed";
const PROPAGATED_ERROR_CODES = new Set([
  "local_collector_state_integrity_failed",
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

function validIdentity(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === "dev\0ino"
    && Number.isSafeInteger(value.dev)
    && value.dev >= 0
    && Number.isSafeInteger(value.ino)
    && value.ino >= 0;
}

function validWorkerOptions(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === "expectedIdentity\0stateFile"
    && typeof value.stateFile === "string"
    && value.stateFile.length > 0
    && validIdentity(value.expectedIdentity);
}

/**
 * Run a full state integrity scan without returning records, paths, metadata,
 * or SQLite diagnostics over the worker boundary.
 */
export async function runLocalCollectorStateIntegrityWorkerThread({
  port = parentPort,
  data = workerData,
} = {}) {
  if (port === null || data === null || typeof data !== "object"
      || Array.isArray(data) || data.options === null
      || typeof data.options !== "object" || Array.isArray(data.options)
      || Object.keys(data).sort().join("\0") !== "contract\0options"
      || data.contract !== LOCAL_COLLECTOR_STATE_INTEGRITY_WORKER_CONTRACT
      || !validWorkerOptions(data.options)) {
    throw fixedError("local_collector_state_integrity_worker_protocol_invalid");
  }
  try {
    await verifyLocalCollectorStateIntegrity(data.options);
    port.postMessage({ type: "result" });
  } catch (error) {
    port.postMessage({ type: "error", code: safeErrorCode(error) });
  } finally {
    port.close();
  }
}

if (!isMainThread
    && workerData?.contract === LOCAL_COLLECTOR_STATE_INTEGRITY_WORKER_CONTRACT) {
  await runLocalCollectorStateIntegrityWorkerThread();
}
