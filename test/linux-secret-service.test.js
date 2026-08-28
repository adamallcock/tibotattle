import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "../src/platform/export-identity-keychain.js";
import {
  createLinuxCredentialMutationLeaseContext,
  createLinuxCredentialMutationMutexContext,
} from "../src/platform/linux-credential-mutation-lease.js";
import {
  LINUX_SECRET_SERVICE_CAPABILITIES,
  LinuxSecretServiceError,
  classifyLinuxSecretServiceFailure,
  createLinuxSecretServiceBackend,
  linuxSecretServiceSessionPreflight,
} from "../src/platform/linux-secret-service.js";

const CAPABILITIES = [
  LINUX_SECRET_SERVICE_CAPABILITIES.exportIdentity,
  LINUX_SECRET_SERVICE_CAPABILITIES.accountObservation,
  LINUX_SECRET_SERVICE_CAPABILITIES.claudeSessionPseudonym,
  LINUX_SECRET_SERVICE_CAPABILITIES.contributionDevice,
];

function credentialKey(service, account) {
  return `${service}\u0000${account}`;
}

function memoryBinding(entries = []) {
  const values = new Map(entries.map(([capability, value]) => [
    credentialKey(capability.service, capability.account),
    value,
  ]));
  const calls = [];
  return {
    values,
    calls,
    async getPassword(service, account) {
      calls.push(["getPassword", service, account]);
      return values.get(credentialKey(service, account)) ?? null;
    },
    async setPassword(service, account, value) {
      calls.push(["setPassword", service, account, value]);
      values.set(credentialKey(service, account), value);
    },
    async deletePassword(service, account) {
      calls.push(["deletePassword", service, account]);
      return values.delete(credentialKey(service, account));
    },
  };
}

function backendOptions(binding, overrides = {}) {
  return {
    platform: "linux",
    architecture: "x64",
    binding,
    sessionProbe: () => "available",
    ...overrides,
  };
}

function serviceError(code) {
  return (error) => {
    assert.equal(error instanceof LinuxSecretServiceError, true);
    assert.equal(error.code, `linux_secret_service_${code}`);
    assert.equal(error.message, "Linux Secret Service backend failed");
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  };
}

async function mutate(backend, capability, operation, callback) {
  return backend.withOperationLease(
    capability,
    { operation },
    callback,
  );
}

test("Linux Secret Service owns exactly the four existing cross-platform capability objects", async () => {
  assert.deepEqual(Object.keys(LINUX_SECRET_SERVICE_CAPABILITIES), [
    "exportIdentity",
    "accountObservation",
    "claudeSessionPseudonym",
    "contributionDevice",
  ]);
  for (const [name, capability] of Object.entries(LINUX_SECRET_SERVICE_CAPABILITIES)) {
    assert.equal(capability, EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES[name]);
  }

  const backend = createLinuxSecretServiceBackend(backendOptions(memoryBinding()));
  for (const invalid of [
    { ...CAPABILITIES[0] },
    EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDeviceApp,
  ]) {
    await assert.rejects(backend.read(invalid), serviceError("invalid_capability"));
  }
  backend.close();
});

test("Linux Secret Service is gated to linux x64 and remains qualification-only", async () => {
  const binding = memoryBinding();
  for (const [platform, architecture, code] of [
    ["darwin", "arm64", "unsupported_platform"],
    ["win32", "x64", "unsupported_platform"],
    ["linux", "arm64", "unsupported_architecture"],
  ]) {
    assert.throws(
      () => createLinuxSecretServiceBackend({
        platform,
        architecture,
        binding,
      }),
      serviceError(code),
    );
  }

  const backend = createLinuxSecretServiceBackend(backendOptions(binding));
  assert.deepEqual(await backend.describe(CAPABILITIES[0]), {
    backend: "linux_secret_service",
    status: "qualification_only",
    platform: "linux",
    architecture: "x64",
    sessionBus: "required",
    bindingTarget: "linux-x64",
    bindingProvenanceVerified: false,
    crossProcessSafe: false,
    crashRecoveryComplete: false,
    productionSafe: false,
  });
  assert.equal(binding.calls.length, 0);
  assert.equal(backend.productionSafe, false);
  backend.close();
});

test("Linux Secret Service creates, reads, replaces, and deletes with caller-held leases", async () => {
  const binding = memoryBinding();
  const backend = createLinuxSecretServiceBackend(backendOptions(binding));
  const original = Buffer.alloc(32, 5);
  const replacement = Buffer.alloc(32, 7);

  await assert.rejects(
    backend.createIfMissing(CAPABILITIES[0], original),
    serviceError("mutation_lease_required"),
  );
  assert.equal(
    await mutate(backend, CAPABILITIES[0], "create", (lease) => (
      backend.createIfMissing(CAPABILITIES[0], original, lease)
    )),
    "created",
  );
  assert.equal(
    await mutate(backend, CAPABILITIES[0], "create", (lease) => (
      backend.createIfMissing(CAPABILITIES[0], Buffer.alloc(32, 9), lease)
    )),
    "existing",
  );
  assert.deepEqual(await backend.read(CAPABILITIES[0]), original);
  assert.equal(
    await mutate(backend, CAPABILITIES[0], "replace", (lease) => (
      backend.replaceExact(CAPABILITIES[0], Buffer.alloc(32, 3), replacement, lease)
    )),
    "conflict",
  );
  assert.equal(
    await mutate(backend, CAPABILITIES[0], "replace", (lease) => (
      backend.replaceExact(CAPABILITIES[0], original, replacement, lease)
    )),
    "replaced",
  );
  assert.equal(
    await mutate(backend, CAPABILITIES[0], "delete", (lease) => (
      backend.deleteExact(CAPABILITIES[0], original, lease)
    )),
    "conflict",
  );
  assert.equal(
    await mutate(backend, CAPABILITIES[0], "delete", (lease) => (
      backend.deleteExact(CAPABILITIES[0], replacement, lease)
    )),
    "deleted",
  );
  assert.equal(
    await mutate(backend, CAPABILITIES[0], "delete", (lease) => (
      backend.deleteExact(CAPABILITIES[0], replacement, lease)
    )),
    "missing",
  );
  assert.equal(await backend.read(CAPABILITIES[0]), null);

  // Inputs belong to the caller; app-owned copies are cleared in finally.
  assert.deepEqual(original, Buffer.alloc(32, 5));
  assert.deepEqual(replacement, Buffer.alloc(32, 7));
  backend.close();
});

test("Linux Secret Service keeps all four capabilities in separate fixed entries", async () => {
  const binding = memoryBinding();
  const backend = createLinuxSecretServiceBackend(backendOptions(binding));
  for (const [index, capability] of CAPABILITIES.entries()) {
    const secret = Buffer.alloc(32, 20 + index);
    assert.equal(
      await mutate(backend, capability, "create", (lease) => (
        backend.createIfMissing(capability, secret, lease)
      )),
      "created",
    );
  }
  assert.equal(binding.values.size, 4);
  for (const [index, capability] of CAPABILITIES.entries()) {
    assert.deepEqual(await backend.read(capability), Buffer.alloc(32, 20 + index));
  }
  backend.close();
});

test("Linux Secret Service requires exact opaque lease ownership and serializes contexts", async () => {
  const capability = CAPABILITIES[0];
  const binding = memoryBinding();
  const first = createLinuxSecretServiceBackend(backendOptions(binding));
  const second = createLinuxSecretServiceBackend(backendOptions(binding));
  let releaseFirst;
  const held = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let entered;
  const enteredPromise = new Promise((resolve) => {
    entered = resolve;
  });
  const firstOperation = first.withOperationLease(
    capability,
    { operation: "replace" },
    async (lease) => {
      entered(lease);
      await held;
    },
  );
  const firstLease = await enteredPromise;
  await assert.rejects(
    second.withOperationLease(capability, { operation: "replace" }, async () => {}),
    serviceError("mutation_lease_contended"),
  );
  await assert.rejects(
    first.deleteExact(capability, Buffer.alloc(32), firstLease),
    serviceError("mutation_lease_foreign"),
  );
  releaseFirst();
  await firstOperation;
  await second.withOperationLease(capability, { operation: "replace" }, async () => {});
  first.close();
  second.close();
});

test("Linux Secret Service enforces readback after every native mutation", async () => {
  const secret = Buffer.alloc(32, 31);
  const wrong = Buffer.alloc(32, 32).toString("base64url");

  const createBinding = memoryBinding();
  createBinding.getPassword = async () => {
    const wrote = createBinding.calls.some(([method]) => method === "setPassword");
    return wrote ? wrong : null;
  };
  const createBackend = createLinuxSecretServiceBackend(backendOptions(createBinding));
  await assert.rejects(
    mutate(createBackend, CAPABILITIES[0], "create", (lease) => (
      createBackend.createIfMissing(CAPABILITIES[0], secret, lease)
    )),
    serviceError("readback_mismatch"),
  );
  createBackend.close();

  const replaceBinding = memoryBinding([[CAPABILITIES[0], secret.toString("base64url")]]);
  let replaceReads = 0;
  replaceBinding.getPassword = async () => {
    replaceReads += 1;
    return replaceReads === 1 ? secret.toString("base64url") : wrong;
  };
  const replaceBackend = createLinuxSecretServiceBackend(backendOptions(replaceBinding));
  await assert.rejects(
    mutate(replaceBackend, CAPABILITIES[0], "replace", (lease) => (
      replaceBackend.replaceExact(CAPABILITIES[0], secret, Buffer.alloc(32, 33), lease)
    )),
    serviceError("readback_mismatch"),
  );
  replaceBackend.close();

  const deleteBinding = memoryBinding([[CAPABILITIES[0], secret.toString("base64url")]]);
  deleteBinding.deletePassword = async () => true;
  const deleteBackend = createLinuxSecretServiceBackend(backendOptions(deleteBinding));
  await assert.rejects(
    mutate(deleteBackend, CAPABILITIES[0], "delete", (lease) => (
      deleteBackend.deleteExact(CAPABILITIES[0], secret, lease)
    )),
    serviceError("readback_mismatch"),
  );
  deleteBackend.close();
});

test("Linux Secret Service fails closed for absent, unavailable, locked, and denied stores", async () => {
  for (const [status, code] of [
    ["absent", "session_unavailable"],
    ["unavailable", "store_unavailable"],
    ["locked", "locked"],
    ["denied", "denied"],
  ]) {
    const binding = memoryBinding();
    const backend = createLinuxSecretServiceBackend(backendOptions(binding, {
      sessionProbe: () => status,
    }));
    await assert.rejects(backend.read(CAPABILITIES[0]), serviceError(code));
    assert.equal(binding.calls.length, 0);
    backend.close();
  }
});

test("Linux Secret Service classifier uses stable codes and ignores localized messages", async () => {
  for (const [nativeCode, expected] of [
    ["LINUX_SECRET_SERVICE_LOCKED", "locked"],
    ["org.freedesktop.Secret.Error.IsLocked", "locked"],
    ["DBUS_ERROR_ACCESS_DENIED", "denied"],
    ["DBUS_ERROR_SERVICE_UNKNOWN", "unavailable"],
    ["UNKNOWN", "operation_failed"],
  ]) {
    assert.equal(classifyLinuxSecretServiceFailure({ code: nativeCode }), expected);
  }
  assert.equal(
    classifyLinuxSecretServiceFailure(new Error("DBUS_ERROR_ACCESS_DENIED")),
    "operation_failed",
  );

  const upstreamCanary = "SECRET-CANARY-native-localized-message";
  const binding = memoryBinding();
  binding.getPassword = async () => {
    const error = new Error(upstreamCanary);
    error.code = "LINUX_SECRET_SERVICE_DENIED";
    throw error;
  };
  const backend = createLinuxSecretServiceBackend(backendOptions(binding));
  await assert.rejects(backend.read(CAPABILITIES[0]), (error) => {
    serviceError("denied")(error);
    assert.equal(`${error.stack}\n${JSON.stringify(error)}`.includes(upstreamCanary), false);
    return true;
  });
  backend.close();
});

test("Linux Secret Service rejects malformed values, secrets, and hostile boundaries content-free", async () => {
  const binding = memoryBinding([[CAPABILITIES[0], "not-a-secret"]]);
  const backend = createLinuxSecretServiceBackend(backendOptions(binding));
  await assert.rejects(
    backend.read(CAPABILITIES[0]),
    serviceError("stored_value_invalid"),
  );
  await assert.rejects(
    mutate(backend, CAPABILITIES[1], "create", (lease) => (
      backend.createIfMissing(CAPABILITIES[1], Buffer.alloc(31), lease)
    )),
    serviceError("invalid_secret"),
  );
  backend.close();

  const hostileBinding = new Proxy({}, {
    get() {
      throw new Error("HOSTILE-BINDING-CANARY");
    },
  });
  assert.throws(
    () => createLinuxSecretServiceBackend(backendOptions(hostileBinding)),
    serviceError("binding_invalid"),
  );
  const hostileOptions = new Proxy({}, {
    get() {
      throw new Error("HOSTILE-OPTIONS-CANARY");
    },
  });
  assert.throws(
    () => createLinuxSecretServiceBackend(hostileOptions),
    serviceError("invalid_configuration"),
  );
});

test("Linux Secret Service clears malformed native Buffers and consumes async classifiers", async () => {
  const malformed = Buffer.alloc(32, 71);
  const malformedBinding = memoryBinding();
  malformedBinding.getPassword = async () => malformed;
  const malformedBackend = createLinuxSecretServiceBackend(backendOptions(malformedBinding));
  await assert.rejects(
    malformedBackend.read(CAPABILITIES[0]),
    serviceError("stored_value_invalid"),
  );
  assert.deepEqual(malformed, Buffer.alloc(32));
  malformedBackend.close();

  const failingBinding = memoryBinding();
  failingBinding.getPassword = async () => {
    throw new Error("NATIVE-CANARY");
  };
  const classifierBackend = createLinuxSecretServiceBackend(backendOptions(failingBinding, {
    classifyFailure: async () => {
      throw new Error("CLASSIFIER-CANARY");
    },
  }));
  await assert.rejects(
    classifierBackend.read(CAPABILITIES[0]),
    serviceError("operation_failed"),
  );
  await new Promise((resolve) => setImmediate(resolve));
  classifierBackend.close();
});

test("Linux Secret Service snapshots injected native methods at construction", async () => {
  const binding = memoryBinding([[CAPABILITIES[0], Buffer.alloc(32, 44).toString("base64url")]]);
  const backend = createLinuxSecretServiceBackend(backendOptions(binding));
  binding.getPassword = async () => Buffer.alloc(32, 99).toString("base64url");
  assert.deepEqual(await backend.read(CAPABILITIES[0]), Buffer.alloc(32, 44));
  backend.close();
});

test("Linux session preflight reports only fixed presence states", () => {
  assert.equal(linuxSecretServiceSessionPreflight({}), "absent");
  assert.equal(linuxSecretServiceSessionPreflight({ DBUS_SESSION_BUS_ADDRESS: "" }), "absent");
  assert.equal(
    linuxSecretServiceSessionPreflight({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/synthetic" }),
    "available",
  );
  assert.equal(linuxSecretServiceSessionPreflight(new Proxy({}, {
    get() {
      throw new Error("ADDRESS-CANARY");
    },
  })), "unavailable");
});

test("Linux backend can carry a branded cross-process mutex without claiming crash recovery", async () => {
  const active = new Set();
  const mutexContext = createLinuxCredentialMutationMutexContext({
    platform: "linux",
    architecture: "x64",
    binding: {
      credentialMutexContractVersion: "linux-credential-mutex-v1",
      credentialMutexCrossProcessSafe: true,
      acquireCredentialMutex(capabilityId) {
        const lease = { capabilityId };
        active.add(capabilityId);
        return { lease, abandoned: false };
      },
      releaseCredentialMutex(lease) {
        active.delete(lease.capabilityId);
      },
    },
  });
  const operationLeaseContext = createLinuxCredentialMutationLeaseContext({ mutexContext });
  const backend = createLinuxSecretServiceBackend(backendOptions(memoryBinding(), {
    operationLeaseContext,
  }));
  assert.equal(backend.crossProcessSafe, true);
  assert.equal(backend.crashRecoveryComplete, false);
  assert.equal((await backend.describe(CAPABILITIES[0])).productionSafe, false);
  backend.close();
  operationLeaseContext.close();
});
