import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "../src/export-identity-keychain.js";
import {
  WINDOWS_CREDENTIAL_CAPABILITY_OWNERS,
  WindowsCredentialOperationLeaseError,
  createWindowsCredentialOperationLeaseContext,
} from "../src/platform/windows-credential-operation-lease.js";

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
