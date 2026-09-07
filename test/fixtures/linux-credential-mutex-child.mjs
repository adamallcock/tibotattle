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
  if (mode === "accountless-read" || mode === "accountless-create") {
    try {
      if (mode === "accountless-read") {
        const value = binding.readAccountlessInstallationCredential();
        value?.fill?.(0);
      } else {
        binding.createAccountlessInstallationCredentialIfMissing(Buffer.alloc(32, 57));
      }
      fixedFailure();
    } catch (error) {
      if (error?.code === "LINUX_ACCOUNTLESS_CREDENTIAL_RECOVERY_REQUIRED") {
        process.stdout.write(
          mode === "accountless-read"
            ? "LINUX_ACCOUNTLESS_CREDENTIAL_CHILD_READ_RECOVERY_REQUIRED\n"
            : "LINUX_ACCOUNTLESS_CREDENTIAL_CHILD_CREATE_RECOVERY_REQUIRED\n",
        );
      } else {
        fixedFailure();
      }
    }
  } else {
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
  }
} catch (error) {
  if (error?.code === "LINUX_CREDENTIAL_MUTEX_CONTENDED") {
    process.stdout.write("LINUX_CREDENTIAL_MUTEX_CHILD_CONTENDED\n");
    process.exitCode = 2;
  } else {
    fixedFailure();
  }
}
