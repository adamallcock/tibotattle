import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "../src/export-identity-keychain.js";
import {
  WindowsCredentialManagerError,
} from "../src/platform/windows-credential-manager.js";
import {
  WINDOWS_ACCOUNT_OBSERVATION_CREDENTIAL_INTEGRATION_STATUS,
  WINDOWS_ACCOUNT_OBSERVATION_CREDENTIAL_PRODUCTION_SAFE,
  WindowsAccountObservationCredentialError,
  createWindowsAccountObservationCredentialBackend,
  isWindowsAccountObservationCredentialBackend,
} from "../src/platform/windows-account-observation-credential.js";

const ACCOUNT_CAPABILITY = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation;
const OTHER_CAPABILITY = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity;

function accountObservationError(code) {
  return (error) => {
    assert.equal(error instanceof WindowsAccountObservationCredentialError, true);
    assert.equal(error.code, `windows_account_observation_credential_${code}`);
    assert.equal(error.message, "Windows account observation credential is unavailable");
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  };
}

function createSyntheticManager({
  initial = null,
  readFailure = null,
  readValue = undefined,
  flags = {},
} = {}) {
  let stored = initial === null ? null : Buffer.from(initial);
  let closeCalls = 0;
  const calls = [];
  const leases = new WeakMap();
  const receivedCandidates = [];
  const rawReadValues = [];
  const manager = Object.freeze({
    crossProcessSafe: flags.crossProcessSafe ?? true,
    auditDurable: flags.auditDurable ?? true,
    auditFilesystemProtected: flags.auditFilesystemProtected ?? true,
    startupRecoveryComplete: flags.startupRecoveryComplete ?? true,
    productionSafe: flags.productionSafe ?? false,
    async read(capability) {
      calls.push(["read", capability]);
      if (readFailure !== null) throw readFailure;
      const value = readValue === undefined ? stored : readValue;
      if (value === null) return null;
      if (!Buffer.isBuffer(value)) return value;
      const copied = Buffer.from(value);
      rawReadValues.push(copied);
      return copied;
    },
    async withOperationLease(capability, options, callback) {
      calls.push(["lease", capability, options]);
      const lease = Object.freeze(Object.create(null));
      leases.set(lease, { capability, operation: options.operation });
      return callback(lease);
    },
    async createIfMissing(capability, candidate, lease) {
      calls.push(["create", capability, Buffer.from(candidate)]);
      receivedCandidates.push(candidate);
      assert.deepEqual(leases.get(lease), { capability, operation: "create" });
      if (stored !== null) return "existing";
      stored = Buffer.from(candidate);
      return "created";
    },
    close() {
      closeCalls += 1;
    },
  });
  return Object.freeze({
    manager,
    calls,
    receivedCandidates,
    rawReadValues,
    stored: () => stored === null ? null : Buffer.from(stored),
    get closeCalls() { return closeCalls; },
  });
}

function createBackend(synthetic) {
  const constructionCalls = [];
  const backend = createWindowsAccountObservationCredentialBackend({
    platform: "win32",
    architecture: "x64",
    createCredentialManagerBackend(options) {
      constructionCalls.push(options);
      return synthetic.manager;
    },
  });
  return { backend, constructionCalls };
}

test("Windows account-observation wrapper limits the generic manager to the fixed legacy observation capability", async () => {
  const synthetic = createSyntheticManager();
  const { backend, constructionCalls } = createBackend(synthetic);
  const candidate = Buffer.alloc(32, 71);
  try {
    assert.equal(isWindowsAccountObservationCredentialBackend(backend), true);
    assert.equal(await backend.read(), null);
    assert.equal(await backend.createIfMissing(candidate), "created");
    assert.equal(await backend.createIfMissing(candidate), "existing");
    const observed = await backend.read();
    assert.deepEqual(observed, candidate);
    observed.fill(0);
    assert.deepEqual(await backend.describe(), {
      backend: "windows_account_observation_credential",
      status: WINDOWS_ACCOUNT_OBSERVATION_CREDENTIAL_INTEGRATION_STATUS,
      productionSafe: WINDOWS_ACCOUNT_OBSERVATION_CREDENTIAL_PRODUCTION_SAFE,
      crossProcessSafe: true,
      auditDurable: true,
      auditFilesystemProtected: true,
      startupRecoveryComplete: true,
    });
    assert.deepEqual(constructionCalls, [{ platform: "win32", architecture: "x64" }]);
    assert.equal(synthetic.calls.every(([, capability]) => capability === ACCOUNT_CAPABILITY), true);
    assert.equal(synthetic.calls.some(([, capability]) => capability === OTHER_CAPABILITY), false);
    assert.deepEqual(
      synthetic.calls.map(([operation, capability, details]) => [
        operation,
        capability === ACCOUNT_CAPABILITY ? "account_observation" : "unexpected",
        operation === "lease" ? details.operation : null,
      ]),
      [
        ["read", "account_observation", null],
        ["lease", "account_observation", "create"],
        ["create", "account_observation", null],
        ["lease", "account_observation", "create"],
        ["create", "account_observation", null],
        ["read", "account_observation", null],
      ],
    );
    assert.deepEqual(synthetic.stored(), candidate);
    assert.equal(synthetic.receivedCandidates.every((value) => value.every((byte) => byte === 0)), true);
    assert.equal(synthetic.rawReadValues.every((value) => value.every((byte) => byte === 0)), true);
  } finally {
    candidate.fill(0);
    backend.close();
  }
  assert.equal(synthetic.closeCalls, 1);
});

test("Windows account-observation wrapper requires an explicit qualified manager factory", () => {
  assert.throws(
    () => createWindowsAccountObservationCredentialBackend({
      platform: "win32",
      architecture: "x64",
    }),
    accountObservationError("invalid_configuration"),
  );
  for (const flags of [
    { crossProcessSafe: false },
    { auditDurable: false },
    { auditFilesystemProtected: false },
    { startupRecoveryComplete: false },
    { productionSafe: true },
  ]) {
    const synthetic = createSyntheticManager({ flags });
    assert.throws(
      () => createBackend(synthetic),
      accountObservationError("unavailable"),
    );
    assert.equal(synthetic.closeCalls, 1);
  }
  for (const [platform, architecture, code] of [
    ["darwin", "arm64", "unsupported_platform"],
    ["linux", "x64", "unsupported_platform"],
    ["win32", "arm64", "unsupported_architecture"],
  ]) {
    assert.throws(
      () => createWindowsAccountObservationCredentialBackend({
        platform,
        architecture,
        createCredentialManagerBackend: () => createSyntheticManager().manager,
      }),
      accountObservationError(code),
    );
  }
});

test("Windows account-observation wrapper maps only fixed manager errors and never treats bad stored data as a candidate", async () => {
  const locked = new WindowsCredentialManagerError("locked");
  const lockedSynthetic = createSyntheticManager({ readFailure: locked });
  const { backend: lockedBackend } = createBackend(lockedSynthetic);
  await assert.rejects(lockedBackend.read(), accountObservationError("locked"));
  lockedBackend.close();

  const unavailableSynthetic = createSyntheticManager({
    readFailure: Object.assign(new Error("private manager canary"), { code: "private_canary" }),
  });
  const { backend: unavailableBackend } = createBackend(unavailableSynthetic);
  await assert.rejects(unavailableBackend.read(), accountObservationError("unavailable"));
  unavailableBackend.close();

  const invalidStored = createSyntheticManager({ readValue: Buffer.alloc(31, 2) });
  const { backend: invalidStoredBackend } = createBackend(invalidStored);
  await assert.rejects(invalidStoredBackend.read(), accountObservationError("stored_value_invalid"));
  invalidStoredBackend.close();

  const privateCanary = "WINDOWS-CREDENTIAL-PRIVATE-CANARY";
  const hostileStored = createSyntheticManager({
    readValue: { fill() { throw new Error(privateCanary); } },
  });
  const { backend: hostileStoredBackend } = createBackend(hostileStored);
  await assert.rejects(hostileStoredBackend.read(), (error) => {
    assert.equal(accountObservationError("stored_value_invalid")(error), true);
    assert.equal(`${error.stack}\n${JSON.stringify(error)}`.includes(privateCanary), false);
    return true;
  });
  hostileStoredBackend.close();

  const synthetic = createSyntheticManager();
  const { backend } = createBackend(synthetic);
  await assert.rejects(backend.createIfMissing(Buffer.alloc(31, 3)), accountObservationError("invalid_configuration"));
  backend.close();
});
