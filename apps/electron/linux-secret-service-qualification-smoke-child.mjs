import {
  LINUX_SECRET_SERVICE_BROKER_CAPABILITIES,
  createLinuxSecretServiceBrokerBackendFromEnvironment,
} from "../../src/platform/linux-secret-service-broker.js";

// Only fixed stage numbers cross the process boundary on failure. Native
// errors, record names and values never enter output or the diagnostic.
let failureExitCode = 26;

async function run() {
  const backend = createLinuxSecretServiceBrokerBackendFromEnvironment();
  if (backend === null || process.env.USAGE_MONITOR_KEYCHAIN_BROKER_FD !== undefined) {
    throw new Error("unavailable");
  }
  for (const [capability, firstByte, secondByte] of [
    [LINUX_SECRET_SERVICE_BROKER_CAPABILITIES.exportIdentity, 71, 72],
    [LINUX_SECRET_SERVICE_BROKER_CAPABILITIES.accountObservation, 81, 82],
  ]) {
    const first = Buffer.alloc(32, firstByte);
    const second = Buffer.alloc(32, secondByte);
    let observed = null;
    try {
      failureExitCode = 21;
      if (await backend.createIfMissing(capability, first) !== "created") throw new Error("failed");
      failureExitCode = 22;
      observed = await backend.read(capability);
      if (!Buffer.isBuffer(observed) || !observed.equals(first)) throw new Error("failed");
      observed.fill(0);
      observed = null;
      failureExitCode = 23;
      if (await backend.replaceExact(capability, first, second) !== "replaced") {
        throw new Error("failed");
      }
      failureExitCode = 24;
      if (await backend.deleteExact(capability, second) !== "deleted") throw new Error("failed");
      failureExitCode = 25;
      if (await backend.read(capability) !== null) throw new Error("failed");
    } finally {
      observed?.fill(0);
      first.fill(0);
      second.fill(0);
    }
  }
}

run().then(() => {
  process.stdout.write("USAGE_MONITOR_READY http://127.0.0.1:4545/\n");
  setInterval(() => {}, 1_000);
}).catch(() => {
  // The inherited FD4 socket keeps Node's event loop referenced. A failed
  // qualification child must close immediately instead of consuming the
  // supervisor's startup timeout.
  process.exit(failureExitCode);
});
