import assert from "node:assert/strict";
import test from "node:test";

import {
  WindowsCredentialMutexError,
  createWindowsCredentialMutexContext,
  isWindowsCredentialMutexContext,
} from "../src/platform/windows-credential-mutex.js";

function memoryBinding() {
  const active = new Set();
  const released = new WeakSet();
  return {
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    credentialMutexSafe: true,
    active,
    acquireCredentialMutex(capabilityId) {
      if (active.has(capabilityId)) {
        const error = new Error("native detail");
        error.code = "WINDOWS_FILESYSTEM_CREDENTIAL_MUTEX_CONTENDED";
        throw error;
      }
      active.add(capabilityId);
      return { lease: { capabilityId }, abandoned: false };
    },
    releaseCredentialMutex(lease) {
      if (released.has(lease)) {
        const error = new Error("native detail");
        error.code = "WINDOWS_FILESYSTEM_CREDENTIAL_MUTEX_FOREIGN";
        throw error;
      }
      active.delete(lease.capabilityId);
      released.add(lease);
    },
  };
}

function assertMutexError(code) {
  return (error) => {
    assert.equal(error instanceof WindowsCredentialMutexError, true);
    assert.equal(error.code, `windows_credential_mutex_${code}`);
    assert.equal(error.message, "Windows credential mutex operation failed");
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  };
}

test("credential mutex context serializes each fixed capability independently", () => {
  const binding = memoryBinding();
  const context = createWindowsCredentialMutexContext({
    platform: "win32",
    architecture: "x64",
    binding,
  });
  assert.equal(isWindowsCredentialMutexContext(context), true);
  assert.equal(context.crossProcessSafe, true);
  assert.equal(context.productionSafe, false);

  const first = context.acquire(0);
  const independent = context.acquire(1);
  assert.throws(() => context.acquire(0), assertMutexError("contended"));
  assert.equal(context.wasAbandoned(first), false);
  context.release(first);
  const reacquired = context.acquire(0);
  context.release(reacquired);
  context.release(independent);
});

test("credential mutex context rejects invalid capabilities and foreign or released leases", () => {
  const context = createWindowsCredentialMutexContext({
    platform: "win32",
    architecture: "x64",
    binding: memoryBinding(),
  });
  for (const value of [-1, 4, "0", null, {}, Number.NaN]) {
    assert.throws(() => context.acquire(value), assertMutexError("invalid_capability"));
  }
  assert.throws(() => context.release({}), assertMutexError("foreign"));
  const lease = context.acquire(2);
  context.release(lease);
  assert.throws(() => context.release(lease), assertMutexError("foreign"));
});

test("credential mutex fails closed on an abandoned owner", () => {
  const binding = memoryBinding();
  binding.acquireCredentialMutex = () => {
    const error = new Error("native detail");
    error.code = "WINDOWS_FILESYSTEM_CREDENTIAL_MUTEX_ABANDONED";
    throw error;
  };
  const context = createWindowsCredentialMutexContext({
    platform: "win32",
    architecture: "x64",
    binding,
  });
  assert.throws(() => context.acquire(3), assertMutexError("abandoned"));
});

test("credential mutex collapses hostile native output and errors", () => {
  const binding = memoryBinding();
  const context = createWindowsCredentialMutexContext({
    platform: "win32",
    architecture: "x64",
    binding,
  });
  binding.acquireCredentialMutex = () => ({ lease: null, abandoned: false });
  assert.throws(() => context.acquire(0), assertMutexError("unavailable"));

  const canary = "DO-NOT-LEAK-native-mutex";
  binding.acquireCredentialMutex = () => {
    throw new Error(canary);
  };
  assert.throws(() => context.acquire(0), (error) => {
    assertMutexError("unavailable")(error);
    assert.equal(`${error.stack}\n${JSON.stringify(error)}`.includes(canary), false);
    return true;
  });
});

test("native credential mutex contract loads on Windows x64", {
  skip: process.platform !== "win32" || process.arch !== "x64",
}, () => {
  const context = createWindowsCredentialMutexContext();
  const lease = context.acquire(0);
  try {
    assert.equal(context.crossProcessSafe, true);
  } finally {
    context.release(lease);
  }
});
