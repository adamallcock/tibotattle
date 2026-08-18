import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import {
  createWindowsCredentialMutexContext,
} from "../src/platform/windows-credential-mutex.js";
import { createWindowsCredentialOperationAuditStore } from "../src/platform/windows-credential-operation-audit.js";
import { createWindowsCredentialOperationLeaseContext } from "../src/platform/windows-credential-operation-lease.js";
import { EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES } from "../src/export-identity-keychain.js";

const CHILD = fileURLToPath(new URL(
  "./fixtures/windows-credential-mutex-child.mjs",
  import.meta.url,
));

function runChild(capabilityId) {
  return spawnSync(process.execPath, [CHILD, String(capabilityId)], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
}

function runWorker(capabilityId) {
  return new Promise((resolveWorker, rejectWorker) => {
    const worker = new Worker(CHILD, {
      workerData: { capabilityId, mode: "once" },
    });
    let result = null;
    worker.once("message", (message) => {
      result = message;
    });
    worker.once("error", rejectWorker);
    worker.once("exit", (code) => {
      if (code !== 0 || result === null) {
        rejectWorker(new Error("WINDOWS_CREDENTIAL_MUTEX_WORKER_FAILED"));
        return;
      }
      resolveWorker(result);
    });
  });
}

test("native named mutex serializes separate Windows processes per capability", {
  skip: process.platform !== "win32" || process.arch !== "x64",
}, () => {
  const context = createWindowsCredentialMutexContext();
  const lease = context.acquire(0);
  try {
    const contended = runChild(0);
    assert.equal(contended.status, 2);
    assert.equal(contended.stdout.trim(), "WINDOWS_CREDENTIAL_MUTEX_CHILD_CONTENDED");
    assert.equal(contended.stderr, "");

    const independent = runChild(1);
    assert.equal(independent.status, 0);
    assert.equal(independent.stdout.trim(), "WINDOWS_CREDENTIAL_MUTEX_CHILD_ACQUIRED");
    assert.equal(independent.stderr, "");
  } finally {
    context.release(lease);
  }

  const reacquired = runChild(0);
  assert.equal(reacquired.status, 0);
  assert.equal(reacquired.stdout.trim(), "WINDOWS_CREDENTIAL_MUTEX_CHILD_ACQUIRED");
  assert.equal(reacquired.stderr, "");
});

test("native mutex registry remains safe across Node worker threads", {
  skip: process.platform !== "win32" || process.arch !== "x64",
}, async () => {
  const context = createWindowsCredentialMutexContext();
  const lease = context.acquire(0);
  try {
    assert.equal(
      await runWorker(0),
      "WINDOWS_CREDENTIAL_MUTEX_CHILD_CONTENDED",
    );
    assert.equal(
      await runWorker(1),
      "WINDOWS_CREDENTIAL_MUTEX_CHILD_ACQUIRED",
    );
    const stress = await Promise.all(
      Array.from({ length: 16 }, () => runWorker(1)),
    );
    assert.equal(
      stress.every((result) => result === "WINDOWS_CREDENTIAL_MUTEX_CHILD_ACQUIRED"
        || result === "WINDOWS_CREDENTIAL_MUTEX_CHILD_CONTENDED"),
      true,
    );
  } finally {
    context.release(lease);
  }
});

test("native lease recovers a durable prepared row after abrupt process termination", {
  skip: process.platform !== "win32" || process.arch !== "x64",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-mutex-crash-"));
  const filePath = join(root, "private", "windows-credential-operation-audit-v1.sqlite");
  try {
    const crashed = spawnSync(process.execPath, [
      CHILD,
      "0",
      "crash-after-prepare",
      filePath,
    ], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    assert.equal(crashed.status, 17);
    assert.equal(crashed.stdout.trim(), "WINDOWS_CREDENTIAL_MUTEX_CHILD_PREPARED");
    assert.equal(crashed.stderr, "");

    const auditStore = createWindowsCredentialOperationAuditStore({ filePath });
    const leaseContext = createWindowsCredentialOperationLeaseContext({
      mutexContext: createWindowsCredentialMutexContext(),
      auditStore,
      ownsAuditStore: true,
      idFactory: () => "00000000-0000-4000-8000-000000000202",
    });
    const capability = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity;
    await leaseContext.withLease(capability, { operation: "replace" }, async (lease) => {
      leaseContext.recordMutation(lease, capability, "replace", "conflict");
    });
    const records = leaseContext.readDurableAuditRecords();
    assert.equal(records[0].phase, "recovered");
    assert.equal(records[0].recoveryClass, "unknown_after_crash");
    assert.equal(records[1].phase, "settled");
    assert.equal(records[1].result, "conflict");
    leaseContext.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
