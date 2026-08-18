import { isMainThread, parentPort, workerData } from "node:worker_threads";

import { createWindowsCredentialMutexContext } from "../../src/platform/windows-credential-mutex.js";
import { createWindowsCredentialOperationAuditStore } from "../../src/platform/windows-credential-operation-audit.js";
import { createWindowsCredentialOperationLeaseContext } from "../../src/platform/windows-credential-operation-lease.js";
import { EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES } from "../../src/export-identity-keychain.js";

const capabilityId = isMainThread
  ? Number.parseInt(process.argv[2] ?? "", 10)
  : workerData?.capabilityId;
const mode = isMainThread ? (process.argv[3] ?? "once") : (workerData?.mode ?? "once");
const context = createWindowsCredentialMutexContext();
if (mode === "crash-after-prepare") {
  const auditStore = createWindowsCredentialOperationAuditStore({
    filePath: process.argv[4],
  });
  const leaseContext = createWindowsCredentialOperationLeaseContext({
    mutexContext: context,
    auditStore,
    ownsAuditStore: true,
    idFactory: () => "00000000-0000-4000-8000-000000000201",
  });
  leaseContext.acquire(
    EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity,
    { operation: "replace" },
  );
  process.stdout.write("WINDOWS_CREDENTIAL_MUTEX_CHILD_PREPARED\n", () => {
    process.exit(17);
  });
} else {
  try {
    const lease = context.acquire(capabilityId);
    try {
      if (isMainThread) {
        process.stdout.write("WINDOWS_CREDENTIAL_MUTEX_CHILD_ACQUIRED\n");
      } else {
        parentPort.postMessage("WINDOWS_CREDENTIAL_MUTEX_CHILD_ACQUIRED");
      }
    } finally {
      context.release(lease);
    }
  } catch (error) {
    if (error?.code === "windows_credential_mutex_contended") {
      if (isMainThread) {
        process.stdout.write("WINDOWS_CREDENTIAL_MUTEX_CHILD_CONTENDED\n");
        process.exitCode = 2;
      } else {
        parentPort.postMessage("WINDOWS_CREDENTIAL_MUTEX_CHILD_CONTENDED");
      }
    } else {
      if (isMainThread) {
        process.stdout.write("WINDOWS_CREDENTIAL_MUTEX_CHILD_FAILED\n");
        process.exitCode = 1;
      } else {
        parentPort.postMessage("WINDOWS_CREDENTIAL_MUTEX_CHILD_FAILED");
      }
    }
  }
}
