import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "../src/export-identity-keychain.js";
import {
  WINDOWS_CREDENTIAL_CAPABILITY_OWNERS,
  WindowsCredentialOperationLeaseError,
  createWindowsCredentialOperationLeaseContext,
} from "../src/platform/windows-credential-operation-lease.js";
import {
  createWindowsCredentialMutexContext,
} from "../src/platform/windows-credential-mutex.js";
import {
  WINDOWS_CREDENTIAL_OPERATION_AUDIT_CAPABILITY_PAIRS,
  createWindowsCredentialOperationAuditStore,
} from "../src/platform/windows-credential-operation-audit.js";

const CAPABILITIES = [
  [
    EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity,
    WINDOWS_CREDENTIAL_CAPABILITY_OWNERS.exportIdentity,
  ],
  [
    EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation,
    WINDOWS_CREDENTIAL_CAPABILITY_OWNERS.accountObservation,
  ],
  [
    EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.claudeSessionPseudonym,
    WINDOWS_CREDENTIAL_CAPABILITY_OWNERS.claudeSessionPseudonym,
  ],
  [
    EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice,
    WINDOWS_CREDENTIAL_CAPABILITY_OWNERS.contributionDevice,
  ],
];

function leaseError(code) {
  return (error) => {
    assert.equal(error instanceof WindowsCredentialOperationLeaseError, true);
    assert.equal(error.code, `windows_credential_operation_lease_${code}`);
    assert.equal(error.message, "Windows Credential Manager operation lease failed");
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  };
}

function memoryMutexContext({ abandoned = false } = {}) {
  const active = new Set();
  let abandonedPending = abandoned;
  return createWindowsCredentialMutexContext({
    platform: "win32",
    architecture: "x64",
    binding: {
      credentialMutexContractVersion: "windows-credential-mutex-v1",
      credentialMutexSafe: true,
      acquireCredentialMutex(capabilityId) {
        if (abandonedPending) {
          abandonedPending = false;
          const error = new Error("abandoned");
          error.code = "WINDOWS_FILESYSTEM_CREDENTIAL_MUTEX_ABANDONED";
          throw error;
        }
        if (active.has(capabilityId)) {
          const error = new Error("contended");
          error.code = "WINDOWS_FILESYSTEM_CREDENTIAL_MUTEX_CONTENDED";
          throw error;
        }
        const lease = { capabilityId };
        active.add(capabilityId);
        return { lease, abandoned: false };
      },
      releaseCredentialMutex(lease) {
        active.delete(lease.capabilityId);
      },
    },
  });
}

test("Windows operation leases bind every owner to one exact capability and operation", () => {
  const context = createWindowsCredentialOperationLeaseContext({
    clock: () => 123,
    idFactory: () => "00000000-0000-4000-8000-000000000001",
  });
  for (const [capability, owner] of CAPABILITIES) {
    const lease = context.acquire(capability, { operation: "create" });
    assert.equal(lease.owner, owner);
    assert.equal(lease.operation, "create");
    assert.equal(context.crossProcessSafe, false);
    assert.equal(context.auditDurable, false);
    assert.equal(context.productionSafe, false);
    assert.equal(context.assertLease(lease, capability, "create"), lease);
    assert.throws(
      () => context.assertLease(lease, capability, "replace"),
      leaseError("foreign"),
    );
    context.release(lease, "completed");
  }
  const events = context.readAuditEvents();
  assert.equal(events.length, CAPABILITIES.length * 2);
  assert.equal(events.every((event) => event.at === 123), true);
});

test("Windows operation leases reject forged, contended, and released leases", () => {
  const [capability, owner] = CAPABILITIES[0];
  const first = createWindowsCredentialOperationLeaseContext();
  const second = createWindowsCredentialOperationLeaseContext();
  const lease = first.acquire(capability, { operation: "replace" });
  assert.throws(
    () => second.acquire(capability, { operation: "replace" }),
    leaseError("contended"),
  );
  assert.throws(
    () => first.assertLease({ ...lease }, capability, "replace"),
    leaseError("foreign"),
  );
  assert.throws(
    () => first.assertLease(lease, CAPABILITIES[1][0], "replace"),
    leaseError("foreign"),
  );
  first.release(lease, "aborted");
  assert.throws(
    () => first.assertLease(lease, capability, "replace"),
    leaseError("foreign"),
  );
  const reacquired = second.acquire(capability, { operation: "replace" });
  second.release(reacquired);
});

test("Windows operation lease audit failures fail closed and do not strand the registry", () => {
  const [capability, owner] = CAPABILITIES[2];
  const context = createWindowsCredentialOperationLeaseContext({
    audit(event) {
      if (event.event === "acquired") return false;
      return true;
    },
  });
  assert.throws(
    () => context.acquire(capability, { operation: "delete" }),
    leaseError("audit_failed"),
  );
  const healthy = createWindowsCredentialOperationLeaseContext();
  const lease = healthy.acquire(capability, { operation: "delete" });
  healthy.release(lease, "completed");
});

test("Windows operation lease rejects asynchronous audit callbacks", () => {
  const [capability] = CAPABILITIES[2];
  const context = createWindowsCredentialOperationLeaseContext({
    audit: async () => true,
  });
  assert.throws(
    () => context.acquire(capability, { operation: "delete" }),
    leaseError("audit_failed"),
  );
  const healthy = createWindowsCredentialOperationLeaseContext();
  const lease = healthy.acquire(capability, { operation: "delete" });
  healthy.release(lease, "completed");
});

test("Windows operation lease consumes rejected asynchronous audit callbacks", async () => {
  const [capability] = CAPABILITIES[2];
  const context = createWindowsCredentialOperationLeaseContext({
    audit: async () => {
      throw new Error("ASYNC-AUDIT-CANARY");
    },
  });
  assert.throws(
    () => context.acquire(capability, { operation: "delete" }),
    leaseError("audit_failed"),
  );
  await new Promise((resolve) => setImmediate(resolve));
});

test("Windows operation lease withLease releases after success and failure", async () => {
  const [capability, owner] = CAPABILITIES[3];
  const context = createWindowsCredentialOperationLeaseContext();
  assert.equal(
    await context.withLease(capability, { operation: "create" }, async (lease) => {
      context.recordMutation(lease, capability, "create", "created");
      return "ok";
    }),
    "ok",
  );
  await assert.rejects(
    context.withLease(capability, { operation: "delete" }, async (lease) => {
      context.recordMutation(lease, capability, "delete", "failed");
      throw new Error("caller failure");
    }),
    /caller failure/u,
  );
  const events = context.readAuditEvents();
  assert.deepEqual(events.map(({ event }) => event), [
    "acquired", "mutation", "released",
    "acquired", "mutation", "released",
  ]);
});

test("Windows operation lease preserves a primary operation error when release audit fails", async () => {
  const [capability] = CAPABILITIES[0];
  const context = createWindowsCredentialOperationLeaseContext({
    audit(event) {
      return event.event !== "released";
    },
  });
  await assert.rejects(
    context.withLease(capability, { operation: "replace" }, async () => {
      throw new Error("primary operation failure");
    }),
    /primary operation failure/u,
  );
  const healthy = createWindowsCredentialOperationLeaseContext();
  const lease = healthy.acquire(capability, { operation: "replace" });
  healthy.release(lease);
});

test("Windows operation lease holds a branded cross-process mutex across the callback", async () => {
  const [capability] = CAPABILITIES[0];
  const context = createWindowsCredentialOperationLeaseContext({
    mutexContext: memoryMutexContext({ abandoned: true }),
  });
  assert.equal(context.crossProcessSafe, true);
  await context.withLease(capability, { operation: "replace" }, async (lease) => {
    assert.throws(
      () => createWindowsCredentialOperationLeaseContext({
        mutexContext: memoryMutexContext(),
      }).acquire(capability, { operation: "replace" }),
      leaseError("contended"),
    );
    context.recordMutation(lease, capability, "replace", "conflict");
  });
  assert.equal(
    context.readAuditEvents()[0].recovery,
    "abandoned_owner",
  );
});

test("Windows operation lease recovers durable prepared rows before the next mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-lease-recovery-"));
  const auditStore = createWindowsCredentialOperationAuditStore({
    filePath: join(root, "private", "windows-credential-operation-audit-v1.sqlite"),
  });
  try {
    auditStore.prepare({
      leaseId: "00000000-0000-4000-8000-000000000099",
      owner: WINDOWS_CREDENTIAL_CAPABILITY_OWNERS.exportIdentity,
      capability: "export_identity",
      operation: "replace",
    });
    auditStore.prepare({
      leaseId: "00000000-0000-4000-8000-000000000098",
      owner: WINDOWS_CREDENTIAL_CAPABILITY_OWNERS.accountObservation,
      capability: "account_observation",
      operation: "delete",
    });
    const context = createWindowsCredentialOperationLeaseContext({
      mutexContext: memoryMutexContext(),
      auditStore,
      idFactory: () => "00000000-0000-4000-8000-000000000100",
    });
    const capability = CAPABILITIES[0][0];
    await context.withLease(capability, { operation: "create" }, async (lease) => {
      assert.equal(auditStore.readPending().length, 2);
      context.recordMutation(lease, capability, "create", "created");
    });
    const records = auditStore.read();
    assert.equal(records[0].phase, "recovered");
    assert.equal(records[0].recoveryClass, "unknown_after_crash");
    assert.equal(records[1].phase, "prepared");
    assert.equal(records[1].capability, "account_observation");
    assert.equal(records[2].phase, "settled");
    assert.equal(records[2].result, "created");
  } finally {
    auditStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows operation lease startup sweep recovers every capability under its mutex", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-lease-startup-"));
  const auditStore = createWindowsCredentialOperationAuditStore({
    filePath: join(root, "private", "windows-credential-operation-audit-v1.sqlite"),
  });
  try {
    for (let index = 0; index < WINDOWS_CREDENTIAL_OPERATION_AUDIT_CAPABILITY_PAIRS.length; index += 1) {
      const pair = WINDOWS_CREDENTIAL_OPERATION_AUDIT_CAPABILITY_PAIRS[index];
      auditStore.prepare({
        leaseId: `00000000-0000-4000-8000-${String(200 + index).padStart(12, "0")}`,
        owner: pair.owner,
        capability: pair.capability,
        operation: "replace",
      });
    }
    const context = createWindowsCredentialOperationLeaseContext({
      mutexContext: memoryMutexContext({ abandoned: true }),
      auditStore,
    });
    assert.equal(context.startupRecoveryComplete, false);
    assert.deepEqual(context.recoverPreparedOperations(), {
      complete: true,
      recovered: 4,
      contended: 0,
    });
    assert.equal(context.startupRecoveryComplete, true);
    assert.deepEqual(auditStore.readPending(), []);
    assert.equal(auditStore.read().every((row) => (
      row.phase === "recovered" && row.recoveryClass === "unknown_after_crash"
    )), true);
    assert.deepEqual(context.recoverPreparedOperations(), {
      complete: true,
      recovered: 0,
      contended: 0,
    });
  } finally {
    auditStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows operation lease validates its ID before acquiring the native mutex", () => {
  let nativeAcquisitions = 0;
  const mutexContext = createWindowsCredentialMutexContext({
    platform: "win32",
    architecture: "x64",
    binding: {
      credentialMutexContractVersion: "windows-credential-mutex-v1",
      credentialMutexSafe: true,
      acquireCredentialMutex() {
        nativeAcquisitions += 1;
        return { lease: {}, abandoned: false };
      },
      releaseCredentialMutex() {},
    },
  });
  const context = createWindowsCredentialOperationLeaseContext({
    mutexContext,
    idFactory() {
      throw new Error("DO-NOT-LEAK-id-factory");
    },
  });
  assert.throws(
    () => context.acquire(CAPABILITIES[0][0], { operation: "create" }),
    leaseError("invalid_configuration"),
  );
  assert.equal(nativeAcquisitions, 0);
});
