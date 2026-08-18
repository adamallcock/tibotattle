import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "../src/export-identity-keychain.js";
import {
  WindowsCredentialManagerError,
  createWindowsCredentialManagerBackend,
} from "../src/platform/windows-credential-manager.js";
import {
  WINDOWS_CREDENTIAL_CAPABILITY_OWNERS,
  createWindowsCredentialOperationLeaseContext,
} from "../src/platform/windows-credential-operation-lease.js";
import { createWindowsCredentialMutexContext } from "../src/platform/windows-credential-mutex.js";
import { createWindowsCredentialOperationAuditStore } from "../src/platform/windows-credential-operation-audit.js";

const EXPORT_CAPABILITY = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity;
const ACCOUNT_CAPABILITY = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation;
const CLAUDE_CAPABILITY = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.claudeSessionPseudonym;
const DEVICE_CAPABILITY = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice;

async function withMutationLease(backend, capability, operation, callback) {
  return backend.withOperationLease(
    capability,
    { operation },
    callback,
  );
}

function credentialKey(service, account) {
  return `${service}\u0000${account}`;
}

function encoded(fill) {
  return Buffer.alloc(32, fill).toString("base64url");
}

function memoryBinding(entries = []) {
  const values = new Map(entries.map(([capability, value]) => [
    credentialKey(capability.service, capability.account),
    value,
  ]));
  const calls = [];
  return {
    calls,
    values,
    async getPassword(service, account) {
      calls.push(["getPassword", service, account]);
      return values.get(credentialKey(service, account)) ?? null;
    },
    async setPassword(service, account, password) {
      calls.push(["setPassword", service, account, password]);
      values.set(credentialKey(service, account), password);
    },
    async deletePassword(service, account) {
      calls.push(["deletePassword", service, account]);
      return values.delete(credentialKey(service, account));
    },
  };
}

function memoryMutexContext() {
  const active = new Set();
  return createWindowsCredentialMutexContext({
    platform: "win32",
    architecture: "x64",
    binding: {
      credentialMutexContractVersion: "windows-credential-mutex-v1",
      credentialMutexSafe: true,
      acquireCredentialMutex(capabilityId) {
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

function assertCredentialError(code) {
  return (error) => {
    assert.equal(error instanceof WindowsCredentialManagerError, true);
    assert.equal(error.code, `windows_credential_manager_${code}`);
    assert.equal(error.message, "Windows Credential Manager backend failed");
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  };
}

test("Windows backend is gated to native Windows x64 and passes loader coordinates", () => {
  const binding = memoryBinding();
  const calls = [];
  const loaded = createWindowsCredentialManagerBackend({
    platform: "win32",
    architecture: "x64",
    loadBinding(options) {
      calls.push(options);
      return binding;
    },
  });
  assert.equal(typeof loaded.describe, "function");
  assert.deepEqual(calls, [{ platform: "win32", architecture: "x64" }]);
  assert.throws(
    () => createWindowsCredentialManagerBackend(null),
    assertCredentialError("invalid_configuration"),
  );

  for (const options of [
    { platform: "darwin", architecture: "arm64" },
    { platform: "linux", architecture: "x64" },
    { platform: "win32", architecture: "arm64" },
  ]) {
    assert.throws(
      () => createWindowsCredentialManagerBackend({ ...options, binding }),
      assertCredentialError(options.platform === "win32"
        ? "unsupported_architecture"
        : "unsupported_platform"),
    );
  }
});

test("Windows backend rejects duck-typed operation lease contexts", () => {
  const binding = memoryBinding();
  const forgedContext = {
    acquire() {},
    assertLease(lease) { return lease; },
    recordMutation() {},
    release() {},
    withLease() {},
    readAuditEvents() { return []; },
    crossProcessSafe: false,
    auditDurable: false,
    auditFilesystemProtected: false,
    startupRecoveryComplete: false,
    crossSessionSafe: false,
    bindingProvenanceAuthenticated: false,
    productionSafe: false,
  };
  assert.throws(
    () => createWindowsCredentialManagerBackend({
      platform: "win32",
      architecture: "x64",
      binding,
      operationLeaseContext: forgedContext,
    }),
    assertCredentialError("operation_lease_invalid_configuration"),
  );
});

test("Windows backend exposes only fixed capability pairs and no credential values", async () => {
  const binding = memoryBinding([[EXPORT_CAPABILITY, encoded(3)]]);
  const backend = createWindowsCredentialManagerBackend({
    platform: "win32",
    architecture: "x64",
    binding,
  });
  assert.deepEqual(await backend.describe(EXPORT_CAPABILITY), {
    backend: "windows_credential_manager",
    status: "qualification_only",
    productionSafe: false,
    crossProcessSafe: false,
    auditDurable: false,
    auditFilesystemProtected: false,
    startupRecoveryComplete: false,
    crossSessionSafe: false,
    bindingProvenanceAuthenticated: false,
  });
  assert.equal(binding.calls.length, 0);
  await assert.rejects(
    backend.describe({ ...EXPORT_CAPABILITY }),
    assertCredentialError("invalid_capability"),
  );
  assert.deepEqual(await backend.read(EXPORT_CAPABILITY), Buffer.alloc(32, 3));
  assert.equal(await backend.read(ACCOUNT_CAPABILITY), null);
});

test("Windows backend creates, replaces, and deletes exact 32-byte secrets with readback", async () => {
  const binding = memoryBinding();
  const backend = createWindowsCredentialManagerBackend({
    platform: "win32",
    architecture: "x64",
    binding,
  });
  const first = Buffer.alloc(32, 5);
  await assert.rejects(
    backend.createIfMissing(EXPORT_CAPABILITY, first),
    assertCredentialError("operation_lease_required"),
  );
  assert.equal(
    await withMutationLease(backend, EXPORT_CAPABILITY, "create", (lease) => (
      backend.createIfMissing(EXPORT_CAPABILITY, first, lease)
    )),
    "created",
  );
  assert.deepEqual(first, Buffer.alloc(32, 5));
  assert.equal(
    await withMutationLease(backend, EXPORT_CAPABILITY, "create", (lease) => (
      backend.createIfMissing(EXPORT_CAPABILITY, Buffer.alloc(32, 6), lease)
    )),
    "existing",
  );
  assert.equal(
    await withMutationLease(backend, EXPORT_CAPABILITY, "replace", (lease) => (
      backend.replaceExact(EXPORT_CAPABILITY, Buffer.alloc(32, 6), Buffer.alloc(32, 7), lease)
    )),
    "conflict",
  );
  assert.equal(
    await withMutationLease(backend, EXPORT_CAPABILITY, "replace", (lease) => (
      backend.replaceExact(EXPORT_CAPABILITY, first, Buffer.alloc(32, 7), lease)
    )),
    "replaced",
  );
  assert.deepEqual(await backend.read(EXPORT_CAPABILITY), Buffer.alloc(32, 7));
  assert.equal(
    await withMutationLease(backend, EXPORT_CAPABILITY, "delete", (lease) => (
      backend.deleteExact(EXPORT_CAPABILITY, Buffer.alloc(32, 6), lease)
    )),
    "conflict",
  );
  assert.equal(
    await withMutationLease(backend, EXPORT_CAPABILITY, "delete", (lease) => (
      backend.deleteExact(EXPORT_CAPABILITY, Buffer.alloc(32, 7), lease)
    )),
    "deleted",
  );
  assert.equal(
    await withMutationLease(backend, EXPORT_CAPABILITY, "delete", (lease) => (
      backend.deleteExact(EXPORT_CAPABILITY, Buffer.alloc(32, 7), lease)
    )),
    "missing",
  );
  assert.equal(await backend.read(EXPORT_CAPABILITY), null);
});

test("Windows backend keeps the four production credentials in separate entries", async () => {
  const binding = memoryBinding();
  const backend = createWindowsCredentialManagerBackend({
    platform: "win32",
    architecture: "x64",
    binding,
  });
  const capabilities = [
    [EXPORT_CAPABILITY, 11],
    [ACCOUNT_CAPABILITY, 12],
    [CLAUDE_CAPABILITY, 13],
    [DEVICE_CAPABILITY, 14],
  ];
  for (const [capability, fill] of capabilities) {
    assert.equal(
      await withMutationLease(backend, capability, "create", (lease) => (
        backend.createIfMissing(capability, Buffer.alloc(32, fill), lease)
      )),
      "created",
    );
  }
  for (const [capability, fill] of capabilities) {
    assert.deepEqual(await backend.read(capability), Buffer.alloc(32, fill));
  }
  assert.equal(binding.values.size, 4);
});

test("Windows backend rejects malformed stored values and collapses native failures", async () => {
  const secret = Buffer.alloc(32, 231);
  const secretCanary = secret.toString("base64url");
  const binding = memoryBinding([[EXPORT_CAPABILITY, "not-a-secret"]]);
  const backend = createWindowsCredentialManagerBackend({
    platform: "win32",
    architecture: "x64",
    binding,
  });
  await assert.rejects(
    backend.read(EXPORT_CAPABILITY),
    assertCredentialError("stored_value_invalid"),
  );

  const upstreamCanary = "DO-NOT-LEAK-windows-credential-manager";
  binding.getPassword = async (...args) => {
    const error = new Error(`${upstreamCanary}:${args.join(":")}`);
    error.code = "ERROR_ACCESS_DENIED";
    throw error;
  };
  await assert.rejects(backend.read(EXPORT_CAPABILITY), (error) => {
    assertCredentialError("denied")(error);
    const rendered = `${error.stack}\n${JSON.stringify(error)}`;
    for (const forbidden of [upstreamCanary, secretCanary, EXPORT_CAPABILITY.service, EXPORT_CAPABILITY.account]) {
      assert.equal(rendered.includes(forbidden), false);
    }
    return true;
  });
});

test("Windows backend zeroes malformed Buffer values returned by the native binding", async () => {
  const malformed = Buffer.alloc(32, 91);
  const binding = memoryBinding();
  binding.getPassword = async () => malformed;
  const backend = createWindowsCredentialManagerBackend({
    platform: "win32",
    architecture: "x64",
    binding,
  });
  await assert.rejects(
    backend.read(EXPORT_CAPABILITY),
    assertCredentialError("stored_value_invalid"),
  );
  assert.deepEqual(malformed, Buffer.alloc(32));
});

test("Windows backend collapses hostile secret-buffer getters without invoking native mutation", async () => {
  const binding = memoryBinding();
  const backend = createWindowsCredentialManagerBackend({
    platform: "win32",
    architecture: "x64",
    binding,
  });
  const canary = "DO-NOT-LEAK-secret-buffer-getter";
  const malformed = new Proxy(Buffer.alloc(32, 19), {
    get(target, property, receiver) {
      if (property === "byteLength") throw new Error(canary);
      return Reflect.get(target, property, receiver);
    },
  });
  await assert.rejects(withMutationLease(backend, EXPORT_CAPABILITY, "create", (lease) => (
    backend.createIfMissing(EXPORT_CAPABILITY, malformed, lease)
  )), (error) => {
    assertCredentialError("invalid_secret")(error);
    assert.equal(`${error.stack}\n${JSON.stringify(error)}`.includes(canary), false);
    return true;
  });
  assert.equal(binding.calls.some(([method]) => method === "setPassword"), false);
});

test("Windows backend records secret-free, capability-derived mutation audit events", async () => {
  const auditEvents = [];
  const backend = createWindowsCredentialManagerBackend({
    platform: "win32",
    architecture: "x64",
    binding: memoryBinding(),
    operationAudit(event) {
      auditEvents.push(event);
    },
  });
  const secret = Buffer.alloc(32, 17);
  assert.equal(
    await withMutationLease(backend, ACCOUNT_CAPABILITY, "create", (lease) => (
      backend.createIfMissing(ACCOUNT_CAPABILITY, secret, lease)
    )),
    "created",
  );
  assert.equal(auditEvents.length, 3);
  assert.deepEqual(auditEvents.map(({ event }) => event), ["acquired", "mutation", "released"]);
  for (const event of auditEvents) {
    assert.equal(event.owner, WINDOWS_CREDENTIAL_CAPABILITY_OWNERS.accountObservation);
    assert.equal(event.capability, "account_observation");
    assert.equal(JSON.stringify(event).includes(secret.toString("base64url")), false);
  }
  assert.deepEqual(backend.readAuditEvents(), auditEvents);
});

test("Windows backend durably prepares before native access and settles after readback", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-manager-audit-"));
  const auditStore = createWindowsCredentialOperationAuditStore({
    filePath: join(root, "private", "windows-credential-operation-audit-v1.sqlite"),
  });
  try {
    const binding = memoryBinding();
    const originalGetPassword = binding.getPassword.bind(binding);
    binding.getPassword = async (...args) => {
      assert.equal(auditStore.readPending().length, 1);
      return originalGetPassword(...args);
    };
    const operationLeaseContext = createWindowsCredentialOperationLeaseContext({
      mutexContext: memoryMutexContext(),
      auditStore,
    });
    const backend = createWindowsCredentialManagerBackend({
      platform: "win32",
      architecture: "x64",
      binding,
      operationLeaseContext,
    });
    const secret = Buffer.alloc(32, 27);
    assert.equal(
      await withMutationLease(backend, EXPORT_CAPABILITY, "create", (lease) => (
        backend.createIfMissing(EXPORT_CAPABILITY, secret, lease)
      )),
      "created",
    );
    assert.equal(backend.crossProcessSafe, true);
    assert.equal(backend.auditDurable, true);
    const records = backend.readDurableAuditRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].phase, "settled");
    assert.equal(records[0].result, "created");
    const serialized = JSON.stringify(records);
    for (const forbidden of [
      secret.toString("base64url"),
      EXPORT_CAPABILITY.service,
      EXPORT_CAPABILITY.account,
      root,
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    auditStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows backend rejects missing and forged leases before native mutation", async () => {
  const binding = memoryBinding();
  const backend = createWindowsCredentialManagerBackend({
    platform: "win32",
    architecture: "x64",
    binding,
  });
  const secret = Buffer.alloc(32, 23);
  await assert.rejects(
    backend.createIfMissing(EXPORT_CAPABILITY, secret),
    assertCredentialError("operation_lease_required"),
  );
  await assert.rejects(
    backend.createIfMissing(EXPORT_CAPABILITY, secret, {}),
    assertCredentialError("operation_lease_foreign"),
  );
  assert.equal(
    await withMutationLease(backend, EXPORT_CAPABILITY, "create", (releasedLease) => (
      backend.createIfMissing(EXPORT_CAPABILITY, secret, releasedLease)
    )),
    "created",
  );
  assert.equal(binding.calls.filter(([method]) => method === "setPassword").length, 1);
});

test("Windows backend closes owned lease resources only after active work finishes", async () => {
  const backend = createWindowsCredentialManagerBackend({
    platform: "win32",
    architecture: "x64",
    binding: memoryBinding(),
  });
  await withMutationLease(backend, EXPORT_CAPABILITY, "create", async (lease) => {
    assert.throws(
      () => backend.close(),
      assertCredentialError("operation_lease_invalid_configuration"),
    );
    assert.equal(
      await backend.createIfMissing(EXPORT_CAPABILITY, Buffer.alloc(32, 29), lease),
      "created",
    );
  });
  backend.close();
  backend.close();
  await assert.rejects(
    backend.read(EXPORT_CAPABILITY),
    assertCredentialError("invalid_configuration"),
  );
});

test("Windows backend collapses hostile lease options to a fixed configuration error", async () => {
  const backend = createWindowsCredentialManagerBackend({
    platform: "win32",
    architecture: "x64",
    binding: memoryBinding(),
  });
  const canary = "DO-NOT-LEAK-operation-options";
  const hostile = new Proxy({}, {
    ownKeys() {
      throw new Error(canary);
    },
  });
  await assert.rejects(
    backend.withOperationLease(EXPORT_CAPABILITY, hostile, async () => null),
    (error) => {
      assertCredentialError("operation_lease_invalid_configuration")(error);
      assert.equal(`${error.stack}\n${JSON.stringify(error)}`.includes(canary), false);
      return true;
    },
  );
});

test("Windows backend maps audited loader failures to fixed content-free errors", () => {
  const canary = "DO-NOT-LEAK-loader-detail";
  assert.throws(
    () => createWindowsCredentialManagerBackend({
      platform: "win32",
      architecture: "x64",
      loadBinding() {
        const error = new Error(canary);
        error.code = "WINDOWS_CREDENTIAL_MANAGER_BINDING_INTEGRITY";
        throw error;
      },
    }),
    (error) => {
      assertCredentialError("binding_integrity")(error);
      assert.equal(`${error.stack}\n${JSON.stringify(error)}`.includes(canary), false);
      return true;
    },
  );
});

test("native Windows x64 qualification adapter loads the audited binding without touching credentials", {
  skip: process.platform !== "win32" || process.arch !== "x64",
}, async () => {
  const backend = createWindowsCredentialManagerBackend();
  try {
    for (const capability of [
      EXPORT_CAPABILITY,
      ACCOUNT_CAPABILITY,
      CLAUDE_CAPABILITY,
      DEVICE_CAPABILITY,
    ]) {
      assert.deepEqual(await backend.describe(capability), {
        backend: "windows_credential_manager",
        status: "qualification_only",
        productionSafe: false,
        crossProcessSafe: true,
        auditDurable: true,
        auditFilesystemProtected: true,
        startupRecoveryComplete: true,
        crossSessionSafe: false,
        bindingProvenanceAuthenticated: false,
      });
    }
  } finally {
    backend.close();
  }
});

test("native qualification exercises and cleans all four fixed credential lifecycles", {
  skip: process.platform !== "win32"
    || process.arch !== "x64"
    || process.env.USAGE_MONITOR_WINDOWS_QUALIFICATION !== "1",
}, async () => {
  const firstBackend = createWindowsCredentialManagerBackend();
  const capabilities = [
    EXPORT_CAPABILITY,
    ACCOUNT_CAPABILITY,
    CLAUDE_CAPABILITY,
    DEVICE_CAPABILITY,
  ];
  try {
    for (let index = 0; index < capabilities.length; index += 1) {
      const capability = capabilities[index];
      const initial = await firstBackend.read(capability);
      assert.equal(initial, null);
      const created = Buffer.alloc(32, 31 + index);
      const replacement = Buffer.alloc(32, 63 + index);
      try {
        assert.equal(
          await withMutationLease(firstBackend, capability, "create", (lease) => (
            firstBackend.createIfMissing(capability, created, lease)
          )),
          "created",
        );
        assert.deepEqual(await firstBackend.read(capability), created);

      // Reconstructing the audited adapter models a process restart or upgrade
      // without changing the fixed service/account contract.
        const restartedBackend = createWindowsCredentialManagerBackend();
        try {
          assert.deepEqual(await restartedBackend.read(capability), created);
          assert.equal(
            await withMutationLease(restartedBackend, capability, "replace", (lease) => (
              restartedBackend.replaceExact(capability, created, replacement, lease)
            )),
            "replaced",
          );
        } finally {
          restartedBackend.close();
        }
        assert.deepEqual(await firstBackend.read(capability), replacement);
        assert.equal(
          await withMutationLease(firstBackend, capability, "delete", (lease) => (
            firstBackend.deleteExact(capability, replacement, lease)
          )),
          "deleted",
        );
        assert.equal(await firstBackend.read(capability), null);
      } finally {
        created.fill(0);
        replacement.fill(0);
        const residue = await firstBackend.read(capability);
        if (residue !== null) {
          try {
            assert.equal(
              await withMutationLease(firstBackend, capability, "delete", (lease) => (
                firstBackend.deleteExact(capability, residue, lease)
              )),
              "deleted",
            );
          } finally {
            residue.fill(0);
          }
        }
      }
    }
  } finally {
    firstBackend.close();
  }
});
