import {
  loadLinuxCredentialMutexBinding,
} from "../../src/platform/linux-credential-mutex.js";

const mode = process.argv[2] ?? "once";
const capabilityId = Number.parseInt(process.argv[3] ?? "", 10);

function fixedFailure() {
  process.stdout.write("LINUX_CREDENTIAL_MUTEX_CHILD_FAILED\n");
  process.exitCode = 1;
}

try {
  const binding = loadLinuxCredentialMutexBinding();
  const result = binding.acquireCredentialMutex(capabilityId);
  if (mode === "hold") {
    process.stdout.write("LINUX_CREDENTIAL_MUTEX_CHILD_MARKED\n", () => {
      setInterval(() => {}, 1_000);
    });
  } else if (mode === "once") {
    try {
      process.stdout.write("LINUX_CREDENTIAL_MUTEX_CHILD_ACQUIRED\n");
    } finally {
      binding.releaseCredentialMutex(result.lease);
    }
  } else {
    binding.abandonCredentialMutex(result.lease);
    fixedFailure();
  }
} catch (error) {
  if (error?.code === "LINUX_CREDENTIAL_MUTEX_CONTENDED") {
    process.stdout.write("LINUX_CREDENTIAL_MUTEX_CHILD_CONTENDED\n");
    process.exitCode = 2;
  } else {
    fixedFailure();
  }
}
