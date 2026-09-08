import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "../src/platform/keychain-capabilities.js";
import {
  createLinuxAccountObservationCredentialBackend,
  LinuxAccountObservationCredentialError,
} from "../src/platform/linux-account-observation-credential.js";

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
    async readAccountObservationCredential() {
      calls.push(["read", arguments.length]);
      return stored === null ? null : Buffer.from(stored);
    },
    async createAccountObservationCredentialIfMissing(value) {
      calls.push(["create", arguments.length, Buffer.from(value)]);
      if (stored !== null) return "existing";
      stored = Buffer.from(value);
      return "created";
    },
    ...overrides,
  };
}

function backendError(code) {
  return (error) => {
    assert.equal(error instanceof LinuxAccountObservationCredentialError, true);
    assert.equal(error.code, `linux_account_observation_credential_${code}`);
    assert.equal(error.message, "Linux account observation credential backend failed");
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  };
}

function equalSecret(actual, expected) {
  assert.equal(Buffer.isBuffer(actual), true);
  assert.equal(actual.byteLength, 32);
  assert.equal(Buffer.compare(actual, expected), 0);
}

test("Linux account-observation credential has only fixed read/create operations", async () => {
  const native = binding();
  const backend = createLinuxAccountObservationCredentialBackend({
    platform: "linux",
    architecture: "x64",
    binding: native,
  });
  const capability = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation;
  assert.deepEqual(Object.keys(backend).sort(), ["createIfMissing", "read"]);
  assert.equal(Object.hasOwn(backend, "deleteExact"), false);
  assert.equal(Object.hasOwn(backend, "replace"), false);
  assert.equal(await backend.read(capability), null);

  const supplied = Buffer.from(SECRET);
  assert.equal(await backend.createIfMissing(capability, supplied), "created");
  equalSecret(supplied, SECRET);

  const read = await backend.read(capability);
  equalSecret(read, SECRET);
  read.fill(0);
  assert.equal(
    await backend.createIfMissing(capability, Buffer.alloc(32, 99)),
    "existing",
  );
  const retained = await backend.read(capability);
  equalSecret(retained, SECRET);
  retained.fill(0);

  assert.deepEqual(native.calls.map(([operation, count]) => [operation, count]), [
    ["read", 0],
    ["create", 1],
    ["read", 0],
    ["create", 1],
    ["read", 0],
  ]);
  for (const [, , value] of native.calls) value?.fill(0);
});

test("Linux account-observation credential rejects capability substitution before native access", async () => {
  const native = binding();
  const backend = createLinuxAccountObservationCredentialBackend({
    platform: "linux",
    architecture: "x64",
    binding: native,
  });
  const copiedCapability = {
    ...EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation,
  };
  await assert.rejects(backend.read(copiedCapability), backendError("invalid_capability"));
  await assert.rejects(
    backend.createIfMissing(
      EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity,
      Buffer.alloc(32, 44),
    ),
    backendError("invalid_capability"),
  );
  assert.equal(native.calls.length, 0);
});

test("Linux account-observation credential reads an existing root without issuing creation", async () => {
  const native = binding({
    async readAccountObservationCredential() {
      this.calls.push(["read", arguments.length]);
      return Buffer.from(SECRET);
    },
  });
  const backend = createLinuxAccountObservationCredentialBackend({
    platform: "linux",
    architecture: "x64",
    binding: native,
  });
  const stored = await backend.read(
    EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation,
  );
  equalSecret(stored, SECRET);
  stored.fill(0);
  assert.deepEqual(native.calls, [["read", 0]]);
});

test("Linux account-observation credential rejects unsupported targets and incomplete bindings", () => {
  for (const [platform, architecture, code] of [
    ["darwin", "arm64", "unsupported_platform"],
    ["linux", "arm64", "unsupported_architecture"],
  ]) {
    assert.throws(
      () => createLinuxAccountObservationCredentialBackend({
        platform,
        architecture,
        binding: binding(),
      }),
      backendError(code),
    );
  }
  assert.throws(
    () => createLinuxAccountObservationCredentialBackend({
      platform: "linux",
      architecture: "x64",
      binding: binding({ productionSafe: true }),
    }),
    backendError("binding_invalid"),
  );
  assert.throws(
    () => createLinuxAccountObservationCredentialBackend({
      platform: "linux",
      architecture: "x64",
      binding: binding({ createAccountObservationCredentialIfMissing: null }),
    }),
    backendError("binding_invalid"),
  );
});

test("Linux account-observation credential loads only the reviewed fixed binding contract", async () => {
  const native = binding();
  const calls = [];
  const backend = createLinuxAccountObservationCredentialBackend({
    platform: "linux",
    architecture: "x64",
    loadBinding(options) {
      calls.push(options);
      return native;
    },
  });
  assert.deepEqual(calls, [{ platform: "linux", architecture: "x64" }]);
  assert.equal(
    await backend.createIfMissing(
      EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation,
      Buffer.from(SECRET),
    ),
    "created",
  );
  for (const [, , value] of native.calls) value?.fill(0);
});

test("Linux account-observation credential collapses native failures and invalid values", async () => {
  const recovery = createLinuxAccountObservationCredentialBackend({
    platform: "linux",
    architecture: "x64",
    binding: binding({
      readAccountObservationCredential() {
        throw nativeError("LINUX_ACCOUNT_OBSERVATION_CREDENTIAL_RECOVERY_REQUIRED");
      },
    }),
  });
  await assert.rejects(
    recovery.read(EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation),
    backendError("recovery_required"),
  );

  const unavailable = createLinuxAccountObservationCredentialBackend({
    platform: "linux",
    architecture: "x64",
    binding: binding({
      createAccountObservationCredentialIfMissing() {
        throw nativeError("LINUX_ACCOUNT_OBSERVATION_CREDENTIAL_UNAVAILABLE");
      },
    }),
  });
  await assert.rejects(
    unavailable.createIfMissing(
      EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation,
      SECRET,
    ),
    backendError("unavailable"),
  );

  const invalidStored = createLinuxAccountObservationCredentialBackend({
    platform: "linux",
    architecture: "x64",
    binding: binding({ readAccountObservationCredential: async () => Buffer.alloc(31) }),
  });
  await assert.rejects(
    invalidStored.read(EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation),
    backendError("stored_value_invalid"),
  );

  const invalidStatus = createLinuxAccountObservationCredentialBackend({
    platform: "linux",
    architecture: "x64",
    binding: binding({
      createAccountObservationCredentialIfMissing: async () => "replaced",
    }),
  });
  await assert.rejects(
    invalidStatus.createIfMissing(
      EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation,
      SECRET,
    ),
    backendError("operation_failed"),
  );

  const invalidCandidate = createLinuxAccountObservationCredentialBackend({
    platform: "linux",
    architecture: "x64",
    binding: binding(),
  });
  await assert.rejects(
    invalidCandidate.createIfMissing(
      EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation,
      Buffer.alloc(31),
    ),
    backendError("invalid_secret"),
  );
});

test("Linux account-observation qualification metadata is fixed, isolated, and non-enumerable", async () => {
  const previousIsolated = process.env.TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED;
  const previousNativeTest = process.env.USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_NATIVE_TEST;
  process.env.USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_NATIVE_TEST = "1";
  try {
    delete process.env.TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED;
    const outsideLaneNativeError = nativeError(
      "LINUX_ACCOUNT_OBSERVATION_CREDENTIAL_UNAVAILABLE",
    );
    Object.defineProperty(outsideLaneNativeError, "qualificationPhase", {
      configurable: false,
      enumerable: false,
      value: "COLLECTION_NULL",
      writable: false,
    });
    const outsideLane = createLinuxAccountObservationCredentialBackend({
      platform: "linux",
      architecture: "x64",
      binding: binding({
        createAccountObservationCredentialIfMissing() {
          throw outsideLaneNativeError;
        },
      }),
    });
    await assert.rejects(
      outsideLane.createIfMissing(
        EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation,
        SECRET,
      ),
      (error) => {
        assert.equal(error.code, "linux_account_observation_credential_unavailable");
        assert.equal(Object.hasOwn(error, "qualificationPhase"), false);
        return true;
      },
    );

    process.env.TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED = "1";
    const phasedNativeError = nativeError(
      "LINUX_ACCOUNT_OBSERVATION_CREDENTIAL_UNAVAILABLE",
    );
    Object.defineProperty(phasedNativeError, "qualificationPhase", {
      configurable: false,
      enumerable: false,
      value: "COLLECTION_NULL",
      writable: false,
    });
    const phased = createLinuxAccountObservationCredentialBackend({
      platform: "linux",
      architecture: "x64",
      binding: binding({
        createAccountObservationCredentialIfMissing() {
          throw phasedNativeError;
        },
      }),
    });
    await assert.rejects(
      phased.createIfMissing(
        EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation,
        SECRET,
      ),
      (error) => {
        assert.equal(error.code, "linux_account_observation_credential_unavailable");
        assert.equal(error.qualificationPhase, "COLLECTION_NULL");
        assert.equal(Object.keys(error).includes("qualificationPhase"), false);
        return true;
      },
    );

    const rejectedMetadata = nativeError(
      "LINUX_ACCOUNT_OBSERVATION_CREDENTIAL_UNAVAILABLE",
    );
    Object.defineProperty(rejectedMetadata, "qualificationPhase", {
      configurable: false,
      enumerable: false,
      value: "private_native_detail",
      writable: false,
    });
    const unphased = createLinuxAccountObservationCredentialBackend({
      platform: "linux",
      architecture: "x64",
      binding: binding({
        createAccountObservationCredentialIfMissing() {
          throw rejectedMetadata;
        },
      }),
    });
    await assert.rejects(
      unphased.createIfMissing(
        EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation,
        SECRET,
      ),
      (error) => {
        assert.equal(error.code, "linux_account_observation_credential_unavailable");
        assert.equal(Object.hasOwn(error, "qualificationPhase"), false);
        return true;
      },
    );
  } finally {
    if (previousIsolated === undefined) delete process.env.TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED;
    else process.env.TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED = previousIsolated;
    if (previousNativeTest === undefined) {
      delete process.env.USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_NATIVE_TEST;
    } else {
      process.env.USAGE_MONITOR_LINUX_ACCOUNT_OBSERVATION_NATIVE_TEST = previousNativeTest;
    }
  }
});
