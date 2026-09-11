import { timingSafeEqual } from "node:crypto";

import {
  LINUX_ACCOUNT_OBSERVATION_BROKER_CAPABILITY,
  createLinuxAccountObservationBrokerBackendFromEnvironment,
} from "../../src/platform/index.js";

// Only fixed stage numbers cross the process boundary on failure. Native
// errors, record names and values never enter output or the diagnostic.
let failureExitCode = 34;

function sameSecret(left, right) {
  try {
    return Buffer.isBuffer(left)
      && Buffer.isBuffer(right)
      && left.byteLength === 32
      && right.byteLength === 32
      && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

async function run() {
  const backend = createLinuxAccountObservationBrokerBackendFromEnvironment();
  if (backend === null
      || process.env.USAGE_MONITOR_KEYCHAIN_BROKER_FD !== undefined
      || process.env.USAGE_MONITOR_LINUX_SECRET_SERVICE_BROKER_FD !== undefined
      || process.env.USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC !== undefined
      || process.env.USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_BROKER_FD !== undefined) {
    throw new Error("unavailable");
  }
  const candidate = Buffer.alloc(32, 93);
  let initial = null;
  let observed = null;
  try {
    // A reused isolated store is not a pass. The fixed root must be absent
    // before this qualification creates it, so repeated fixtures cannot
    // silently convert retained state into an "existing" success.
    failureExitCode = 31;
    initial = await backend.read(LINUX_ACCOUNT_OBSERVATION_BROKER_CAPABILITY);
    if (initial !== null) {
      throw new Error("unexpected existing record");
    }
    failureExitCode = 32;
    if (await backend.createIfMissing(
      LINUX_ACCOUNT_OBSERVATION_BROKER_CAPABILITY,
      candidate,
    ) !== "created") {
      throw new Error("create failed");
    }
    failureExitCode = 33;
    observed = await backend.read(LINUX_ACCOUNT_OBSERVATION_BROKER_CAPABILITY);
    if (!sameSecret(observed, candidate)) throw new Error("readback failed");
  } finally {
    if (Buffer.isBuffer(initial)) initial.fill(0);
    if (Buffer.isBuffer(observed)) observed.fill(0);
    candidate.fill(0);
  }
}

run().then(() => {
  process.stdout.write("USAGE_MONITOR_READY http://127.0.0.1:4545/\n");
  setInterval(() => {}, 1_000);
}).catch(() => {
  // The inherited Node IPC channel keeps Node's event loop referenced. A
  // failed qualification child must close immediately instead of consuming
  // the supervisor's startup timeout.
  process.exit(failureExitCode);
});
