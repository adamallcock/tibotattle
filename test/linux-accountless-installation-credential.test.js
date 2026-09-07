import assert from "node:assert/strict";
import test from "node:test";

import {
  createLinuxAccountlessInstallationCredentialBackend,
  LinuxAccountlessInstallationCredentialError,
} from "../src/platform/linux-accountless-installation-credential.js";

const SECRET = Buffer.alloc(32, 31);

function nativeError(code) {
  return Object.assign(new Error("native detail must not escape"), { code });
}

function binding(overrides = {}) {
  let stored = null;
  const calls = [];
  return {
    calls,
    credentialMutexContractVersion: "linux-credential-mutex-v1",
    credentialMutexCrossProcessSafe: true,
    credentialMutexSameNetworkNamespaceOnly: true,
    credentialMutexDurableMarker: true,
    productionSafe: false,
    readAccountlessInstallationCredential() {
      calls.push(["read", arguments.length]);
      return stored === null ? null : Buffer.from(stored);
    },
    createAccountlessInstallationCredentialIfMissing(value) {
      calls.push(["create", arguments.length, Buffer.from(value)]);
      if (stored !== null) return "existing";
      stored = Buffer.from(value);
      return "created";
    },
    deleteAccountlessInstallationCredentialExact(value) {
      calls.push(["delete", arguments.length, Buffer.from(value)]);
      if (stored === null) return "missing";
      if (!stored.equals(value)) return "mismatch";
      stored.fill(0);
      stored = null;
      return "deleted";
    },
    ...overrides,
  };
}

function backendError(code) {
  return (error) => {
    assert.equal(error instanceof LinuxAccountlessInstallationCredentialError, true);
    assert.equal(error.code, `linux_accountless_installation_credential_${code}`);
    assert.equal(error.message, "Linux accountless installation credential backend failed");
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  };
}

test("Linux accountless credential has only fixed accountless operations and copies 32-byte values", async () => {
  const native = binding();
  const backend = createLinuxAccountlessInstallationCredentialBackend({
    platform: "linux",
    architecture: "x64",
    binding: native,
  });
  assert.deepEqual(Object.keys(backend).sort(), ["createIfMissing", "deleteExact", "read"]);
  assert.equal(await backend.read(), null);

  const supplied = Buffer.from(SECRET);
  assert.equal(await backend.createIfMissing(supplied), "created");
  assert.deepEqual(supplied, SECRET, "the native call receives an adapter-owned copy");
  const read = await backend.read();
  assert.deepEqual(read, SECRET);
  read.fill(0);
  assert.equal(await backend.createIfMissing(Buffer.alloc(32, 99)), "existing");
  assert.equal(await backend.deleteExact(Buffer.alloc(32, 17)), "mismatch");
  assert.equal(await backend.deleteExact(SECRET), "deleted");
  assert.equal(await backend.read(), null);

  assert.deepEqual(native.calls.map(([operation, count]) => [operation, count]), [
    ["read", 0],
    ["create", 1],
    ["read", 0],
    ["create", 1],
    ["delete", 1],
    ["delete", 1],
    ["read", 0],
  ]);
  for (const [, , value] of native.calls) value?.fill(0);
});

test("Linux accountless credential rejects unreviewed bindings and unsupported targets", () => {
  for (const [platform, architecture, code] of [
    ["darwin", "arm64", "unsupported_platform"],
    ["linux", "arm64", "unsupported_architecture"],
  ]) {
    assert.throws(
      () => createLinuxAccountlessInstallationCredentialBackend({
        platform,
        architecture,
        binding: binding(),
      }),
      backendError(code),
    );
  }
  assert.throws(
    () => createLinuxAccountlessInstallationCredentialBackend({
      platform: "linux",
      architecture: "x64",
      binding: binding({ productionSafe: true }),
    }),
    backendError("binding_invalid"),
  );
  assert.throws(
    () => createLinuxAccountlessInstallationCredentialBackend({
      platform: "linux",
      architecture: "x64",
      binding: binding({ createAccountlessInstallationCredentialIfMissing: null }),
    }),
    backendError("binding_invalid"),
  );
});

test("Linux accountless credential collapses native statuses to fixed errors", async () => {
  const recovery = createLinuxAccountlessInstallationCredentialBackend({
    platform: "linux",
    architecture: "x64",
    binding: binding({
      readAccountlessInstallationCredential() {
        throw nativeError("LINUX_ACCOUNTLESS_CREDENTIAL_RECOVERY_REQUIRED");
      },
    }),
  });
  await assert.rejects(recovery.read(), backendError("recovery_required"));

  const unavailable = createLinuxAccountlessInstallationCredentialBackend({
    platform: "linux",
    architecture: "x64",
    binding: binding({
      createAccountlessInstallationCredentialIfMissing() {
        throw nativeError("LINUX_ACCOUNTLESS_CREDENTIAL_UNAVAILABLE");
      },
    }),
  });
  await assert.rejects(unavailable.createIfMissing(SECRET), backendError("unavailable"));

  const invalidStored = createLinuxAccountlessInstallationCredentialBackend({
    platform: "linux",
    architecture: "x64",
    binding: binding({ readAccountlessInstallationCredential: () => Buffer.alloc(31) }),
  });
  await assert.rejects(invalidStored.read(), backendError("stored_value_invalid"));
  const asynchronousNative = createLinuxAccountlessInstallationCredentialBackend({
    platform: "linux",
    architecture: "x64",
    binding: binding({
      readAccountlessInstallationCredential: () => Promise.resolve(null),
    }),
  });
  await assert.rejects(asynchronousNative.read(), backendError("operation_failed"));
});
