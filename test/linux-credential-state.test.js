import assert from "node:assert/strict";
import test from "node:test";

import {
  isLinuxCredentialStateError,
  LinuxCredentialStateError,
  prepareLinuxCredentialState,
} from "../src/platform/linux-credential-state.js";

function nativeError(code) {
  return Object.assign(new Error("synthetic native failure"), { code });
}

function binding(overrides = {}) {
  return {
    credentialMutexContractVersion: "linux-credential-mutex-v1",
    credentialMutexCrossProcessSafe: true,
    credentialMutexSameNetworkNamespaceOnly: true,
    credentialMutexDurableMarker: true,
    productionSafe: false,
    prepareLinuxCredentialState() {},
    ...overrides,
  };
}

function stateError(code) {
  return (error) => {
    assert.equal(error instanceof LinuxCredentialStateError, true);
    assert.equal(isLinuxCredentialStateError(error), true);
    assert.equal(error.code, `linux_credential_state_${code}`);
    assert.equal(error.message, "Linux credential state preparation failed");
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  };
}

test("Linux credential-state facade invokes only the zero-argument fixed native authority", () => {
  const calls = [];
  const selected = binding({
    prepareLinuxCredentialState(...argumentsList) {
      calls.push(argumentsList);
    },
  });
  assert.equal(
    prepareLinuxCredentialState({
      platform: "linux",
      architecture: "x64",
      binding: selected,
    }),
    undefined,
  );
  assert.deepEqual(calls, [[]]);
});

test("Linux credential-state facade gates platform, fixed binding, and pathname-free options", () => {
  let loaderCalls = 0;
  for (const [platform, architecture, code] of [
    ["darwin", "arm64", "unsupported_platform"],
    ["linux", "arm64", "unsupported_architecture"],
  ]) {
    assert.throws(
      () => prepareLinuxCredentialState({
        platform,
        architecture,
        loadBinding() {
          loaderCalls += 1;
          return binding();
        },
      }),
      stateError(code),
    );
  }
  assert.equal(loaderCalls, 0);
  assert.throws(
    () => prepareLinuxCredentialState({
      platform: "linux",
      architecture: "x64",
      binding: binding(),
      path: "/caller-selected-state",
    }),
    stateError("invalid_configuration"),
  );
  assert.throws(
    () => prepareLinuxCredentialState({
      platform: "linux",
      architecture: "x64",
      binding: binding(),
      stateBase: "/caller-selected-state",
    }),
    stateError("invalid_configuration"),
  );
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "platform", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "linux";
    },
  });
  assert.throws(
    () => prepareLinuxCredentialState(accessor),
    stateError("invalid_configuration"),
  );
  assert.equal(getterCalls, 0);
  assert.throws(
    () => prepareLinuxCredentialState(new Proxy({}, {})),
    stateError("invalid_configuration"),
  );
});

test("Linux credential-state facade calls the fixed loader and accepts only the closed native shape", () => {
  const calls = [];
  assert.equal(
    prepareLinuxCredentialState({
      platform: "linux",
      architecture: "x64",
      loadBinding(options) {
        calls.push(options);
        return binding();
      },
    }),
    undefined,
  );
  assert.deepEqual(calls, [{ platform: "linux", architecture: "x64" }]);

  for (const invalid of [
    binding({ prepareLinuxCredentialState: null }),
    binding({ credentialMutexDurableMarker: false }),
    binding({ productionSafe: true }),
  ]) {
    assert.throws(
      () => prepareLinuxCredentialState({
        platform: "linux",
        architecture: "x64",
        binding: invalid,
      }),
      stateError("binding_invalid"),
    );
  }
  assert.throws(
    () => prepareLinuxCredentialState({
      platform: "linux",
      architecture: "x64",
      loadBinding() {
        throw new Error("binding unavailable");
      },
    }),
    stateError("binding_unavailable"),
  );
});

test("Linux credential-state facade maps only fixed native outcomes and rejects asynchronous results", () => {
  for (const [nativeCode, code] of [
    ["LINUX_CREDENTIAL_MUTEX_STATE_INVALID", "state_invalid"],
    ["LINUX_CREDENTIAL_MUTEX_STATE_UNAVAILABLE", "state_unavailable"],
    ["untrusted_native_error", "operation_failed"],
  ]) {
    assert.throws(
      () => prepareLinuxCredentialState({
        platform: "linux",
        architecture: "x64",
        binding: binding({
          prepareLinuxCredentialState() {
            throw nativeError(nativeCode);
          },
        }),
      }),
      stateError(code),
    );
  }
  assert.throws(
    () => prepareLinuxCredentialState({
      platform: "linux",
      architecture: "x64",
      binding: binding({
        prepareLinuxCredentialState() {
          return Promise.resolve();
        },
      }),
    }),
    stateError("operation_failed"),
  );
});
