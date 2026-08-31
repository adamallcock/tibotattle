import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "../src/platform/export-identity-keychain.js";
import {
  LINUX_CREDENTIAL_CAPABILITY_OWNERS,
  LinuxCredentialMutationLeaseError,
  createLinuxCredentialMutationLeaseContext,
  createLinuxCredentialMutationMutexContext,
} from "../src/platform/linux-credential-mutation-lease.js";

const CAPABILITIES = [
  [EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity, "participant-identity"],
  [EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation, "account-observation"],
  [EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.claudeSessionPseudonym, "claude-callback"],
  [EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice, "contribution-device"],
];

function leaseError(code) {
  return (error) => {
    assert.equal(error instanceof LinuxCredentialMutationLeaseError, true);
    assert.equal(error.code, `linux_credential_mutation_lease_${code}`);
    assert.equal(error.message, "Linux credential mutation lease failed");
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  };
}

function mutexBinding({ abandoned = false } = {}) {
  const active = new Set();
  const calls = [];
  return {
    calls,
    credentialMutexContractVersion: "linux-credential-mutex-v1",
    credentialMutexCrossProcessSafe: true,
    acquireCredentialMutex(capabilityId) {
      calls.push(["acquire", capabilityId]);
      if (active.has(capabilityId)) {
        const error = new Error("localized contention must not escape");
        error.code = "LINUX_CREDENTIAL_MUTEX_CONTENDED";
        throw error;
      }
      const lease = { capabilityId };
      active.add(capabilityId);
      return { lease, abandoned };
    },
    releaseCredentialMutex(lease) {
      calls.push(["release", lease.capabilityId]);
      active.delete(lease.capabilityId);
    },
  };
}

test("Linux mutation leases own exactly the four cross-platform capabilities", () => {
  assert.deepEqual(LINUX_CREDENTIAL_CAPABILITY_OWNERS, {
    exportIdentity: "participant-identity",
    accountObservation: "account-observation",
    claudeSessionPseudonym: "claude-callback",
    contributionDevice: "contribution-device",
  });
  const context = createLinuxCredentialMutationLeaseContext();
  for (const [capability] of CAPABILITIES) {
    const lease = context.acquire(capability, { operation: "create" });
    assert.deepEqual(Object.keys(lease), []);
    assert.equal(Object.getPrototypeOf(lease), null);
    assert.equal(context.assertLease(lease, capability, "create"), lease);
    context.release(lease);
  }
  for (const invalid of [
    { ...CAPABILITIES[0][0] },
    EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDeviceApp,
  ]) {
    assert.throws(
      () => context.acquire(invalid, { operation: "create" }),
      leaseError("invalid_capability"),
    );
  }
  context.close();
});

test("Linux mutation leases reject missing, forged, wrong-owner, and wrong-operation authority", () => {
  const [firstCapability] = CAPABILITIES[0];
  const [secondCapability] = CAPABILITIES[1];
  const first = createLinuxCredentialMutationLeaseContext();
  const second = createLinuxCredentialMutationLeaseContext();
  const lease = first.acquire(firstCapability, { operation: "replace" });
  assert.throws(
    () => first.assertLease(undefined, firstCapability, "replace"),
    leaseError("required"),
  );
  assert.throws(
    () => first.assertLease(Object.create(null), firstCapability, "replace"),
    leaseError("foreign"),
  );
  assert.throws(
    () => second.assertLease(lease, firstCapability, "replace"),
    leaseError("foreign"),
  );
  assert.throws(
    () => first.assertLease(lease, secondCapability, "replace"),
    leaseError("foreign"),
  );
  assert.throws(
    () => first.assertLease(lease, firstCapability, "delete"),
    leaseError("foreign"),
  );
  first.release(lease);
  assert.throws(
    () => first.assertLease(lease, firstCapability, "replace"),
    leaseError("released"),
  );
});

test("Linux mutation leases serialize a capability across contexts and release after failure", async () => {
  const [capability] = CAPABILITIES[2];
  const first = createLinuxCredentialMutationLeaseContext();
  const second = createLinuxCredentialMutationLeaseContext();
  const lease = first.acquire(capability, { operation: "delete" });
  assert.throws(
    () => second.acquire(capability, { operation: "delete" }),
    leaseError("contended"),
  );
  first.release(lease);

  await assert.rejects(
    second.withLease(capability, { operation: "delete" }, async () => {
      throw new Error("caller failure");
    }),
    /caller failure/u,
  );
  const reacquired = first.acquire(capability, { operation: "delete" });
  first.release(reacquired);
});

test("Linux mutation lease options and close fail closed", () => {
  const [capability] = CAPABILITIES[0];
  const context = createLinuxCredentialMutationLeaseContext();
  for (const options of [
    undefined,
    null,
    {},
    { operation: "read" },
    { operation: "create", owner: "forged" },
  ]) {
    assert.throws(
      () => context.acquire(capability, options),
      leaseError(options?.operation === "read"
        ? "invalid_operation"
        : "invalid_configuration"),
    );
  }
  const lease = context.acquire(capability, { operation: "create" });
  assert.throws(() => context.close(), leaseError("invalid_configuration"));
  context.release(lease);
  context.close();
  assert.throws(
    () => context.acquire(capability, { operation: "create" }),
    leaseError("invalid_configuration"),
  );
});

test("reviewed Linux mutex seam binds capability ids and reports cross-process safety", () => {
  const binding = mutexBinding();
  const mutexContext = createLinuxCredentialMutationMutexContext({
    platform: "linux",
    architecture: "x64",
    binding,
  });
  const context = createLinuxCredentialMutationLeaseContext({ mutexContext });
  assert.equal(context.crossProcessSafe, true);
  assert.equal(context.productionSafe, false);
  CAPABILITIES.forEach(([capability], capabilityId) => {
    const lease = context.acquire(capability, { operation: "replace" });
    context.release(lease);
    assert.deepEqual(binding.calls.slice(-2), [
      ["acquire", capabilityId],
      ["release", capabilityId],
    ]);
  });
});

test("Linux mutex seam rejects wrong platforms, duck types, and abandoned owners", () => {
  const binding = mutexBinding();
  assert.throws(
    () => createLinuxCredentialMutationMutexContext({
      platform: "darwin",
      architecture: "arm64",
      binding,
    }),
    leaseError("unsupported_platform"),
  );
  assert.throws(
    () => createLinuxCredentialMutationMutexContext({
      platform: "linux",
      architecture: "arm64",
      binding,
    }),
    leaseError("unsupported_architecture"),
  );
  assert.throws(
    () => createLinuxCredentialMutationLeaseContext({
      mutexContext: {
        acquire() {},
        release() {},
        crossProcessSafe: true,
      },
    }),
    leaseError("invalid_configuration"),
  );

  const abandonedBinding = mutexBinding({ abandoned: true });
  const context = createLinuxCredentialMutationLeaseContext({
    mutexContext: createLinuxCredentialMutationMutexContext({
      platform: "linux",
      architecture: "x64",
      binding: abandonedBinding,
    }),
  });
  assert.throws(
    () => context.acquire(CAPABILITIES[0][0], { operation: "replace" }),
    leaseError("recovery_required"),
  );
  assert.deepEqual(abandonedBinding.calls, [["acquire", 0], ["release", 0]]);
});

test("Linux mutex failures use stable codes and never parse native messages", () => {
  const binding = mutexBinding();
  binding.acquireCredentialMutex = () => {
    throw new Error("LINUX_CREDENTIAL_MUTEX_CONTENDED appears only in a message");
  };
  const context = createLinuxCredentialMutationLeaseContext({
    mutexContext: createLinuxCredentialMutationMutexContext({
      platform: "linux",
      architecture: "x64",
      binding,
    }),
  });
  assert.throws(
    () => context.acquire(CAPABILITIES[0][0], { operation: "delete" }),
    leaseError("mutex_failed"),
  );
});

test("a failed native mutex release keeps the capability poisoned", () => {
  const [capability] = CAPABILITIES[0];
  const binding = mutexBinding();
  const originalRelease = binding.releaseCredentialMutex;
  let failRelease = true;
  binding.releaseCredentialMutex = (lease) => {
    if (failRelease) {
      throw new Error("localized release failure must not escape");
    }
    originalRelease.call(binding, lease);
  };
  const context = createLinuxCredentialMutationLeaseContext({
    mutexContext: createLinuxCredentialMutationMutexContext({
      platform: "linux",
      architecture: "x64",
      binding,
    }),
  });
  const contender = createLinuxCredentialMutationLeaseContext();
  const lease = context.acquire(capability, { operation: "replace" });

  assert.throws(() => context.release(lease), leaseError("mutex_failed"));
  assert.throws(
    () => contender.acquire(capability, { operation: "replace" }),
    leaseError("contended"),
  );
  assert.throws(() => context.close(), leaseError("invalid_configuration"));

  failRelease = false;
  context.release(lease);
  const next = contender.acquire(capability, { operation: "replace" });
  contender.release(next);
  context.close();
  contender.close();
});
