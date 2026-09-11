import {
  parentPort,
  workerData,
} from "node:worker_threads";

import "../../src/local-collector-projection-off-main.js";

parentPort.postMessage({
  type: "unrelated_worker_reply",
  value: workerData?.value === "unrelated",
});
parentPort.close();
