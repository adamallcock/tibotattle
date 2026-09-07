import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopLinuxAccountlessCredentialBackend,
} from "../desktop-linux-accountless-credential.js";

const SECRET = Buffer.alloc(32, 67);

function nativeError(code) {
  return Object.assign(new Error("native detail must not cross FD3"), { code });
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
      calls.push(["create", arguments.length]);
      if (stored !== null) return "existing";
      stored = Buffer.from(value);
      return "created";
    },
    deleteAccountlessInstallationCredentialExact(value) {
      calls.push(["delete", arguments.length]);
      if (stored === null) return "missing";
      if (!stored.equals(value)) return "mismatch";
      stored.fill(0);
      stored = null;
      return "deleted";
    },
    ...overrides,
  };
}

test("desktop Linux accountless adapter keeps a fixed 32-byte FD3 backend surface", async () => {
  const native = binding();
  const backend = createDesktopLinuxAccountlessCredentialBackend({
    platform: "linux",
    architecture: "x64",
    binding: native,
  });
  assert.deepEqual(Object.keys(backend).sort(), ["createIfMissing", "deleteExact", "read"]);
  assert.equal(await backend.read(), null);
  const supplied = Buffer.from(SECRET);
  assert.equal(await backend.createIfMissing(supplied), "created");
  assert.deepEqual(supplied, SECRET);
  const read = await backend.read();
  assert.deepEqual(read, SECRET);
  read.fill(0);
  assert.equal(await backend.deleteExact(Buffer.alloc(32, 3)), "mismatch");
  assert.equal(await backend.deleteExact(SECRET), "deleted");
  assert.deepEqual(native.calls, [
    ["read", 0],
    ["create", 1],
    ["read", 0],
    ["delete", 1],
    ["delete", 1],
  ]);
});

test("desktop Linux accountless adapter maps only fixed native failures", async () => {
  const recovery = createDesktopLinuxAccountlessCredentialBackend({
    platform: "linux",
    architecture: "x64",
    binding: binding({
      readAccountlessInstallationCredential() {
        throw nativeError("LINUX_ACCOUNTLESS_CREDENTIAL_RECOVERY_REQUIRED");
      },
    }),
  });
  await assert.rejects(recovery.read(), (error) => {
    assert.equal(error?.code, "contribution_device_credential_recovery_required");
    assert.equal(error?.retryable, false);
    assert.equal(error?.message, "Installation credential recovery is required");
    return true;
  });

  const unavailable = createDesktopLinuxAccountlessCredentialBackend({
    platform: "linux",
    architecture: "x64",
    binding: binding({
      createAccountlessInstallationCredentialIfMissing() {
        throw nativeError("LINUX_ACCOUNTLESS_CREDENTIAL_UNAVAILABLE");
      },
      deleteAccountlessInstallationCredentialExact() {
        throw nativeError("LINUX_ACCOUNTLESS_CREDENTIAL_UNAVAILABLE");
      },
    }),
  });
  await assert.rejects(unavailable.createIfMissing(SECRET), (error) => {
    assert.equal(error?.code, "contribution_device_credential_unavailable");
    assert.equal(error?.retryable, true);
    assert.equal(error?.knownNonMutation, true);
    return true;
  });
  await assert.rejects(unavailable.deleteExact(SECRET), (error) => {
    assert.equal(error?.code, "contribution_device_credential_unavailable");
    assert.equal(error?.retryable, true);
    assert.equal(error?.knownNonMutation, undefined);
    return true;
  });
});

test("desktop Linux accountless adapter rejects malformed values without a native call", async () => {
  const native = binding();
  const backend = createDesktopLinuxAccountlessCredentialBackend({
    platform: "linux",
    architecture: "x64",
    binding: native,
  });
  await assert.rejects(backend.createIfMissing(Buffer.alloc(31)), {
    code: "contribution_device_credential_unavailable",
  });
  await assert.rejects(backend.deleteExact("not-a-buffer"), {
    code: "contribution_device_credential_unavailable",
  });
  assert.deepEqual(native.calls, []);
});
