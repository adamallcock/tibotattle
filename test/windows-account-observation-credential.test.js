import assert from "node:assert/strict";
import test from "node:test";
import { win32 } from "node:path";

import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "../src/export-identity-keychain.js";
import {
  WindowsCredentialManagerError,
} from "../src/platform/windows-credential-manager.js";
import { defaultWindowsCredentialOperationAuditFile } from "../src/platform/windows-credential-operation-audit.js";
import { createWindowsCredentialAuditFileGuardContext } from "../src/platform/windows-credential-audit-file-guard.js";
import {
  WINDOWS_ACCOUNT_OBSERVATION_CREDENTIAL_INTEGRATION_STATUS,
  WINDOWS_ACCOUNT_OBSERVATION_CREDENTIAL_PRODUCTION_SAFE,
  WindowsAccountObservationCredentialError,
  createQualifiedWindowsAccountObservationCredentialBackend,
  createQualifiedWindowsAccountObservationCredentialBackendForTest,
  createWindowsNormalCandidateAccountObservationCredentialBackend,
  createWindowsNormalCandidateAccountObservationCredentialBackendForTest,
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

function qualificationContext() {
  return Object.freeze({
    platform: "win32",
    architecture: "x64",
    qualificationOnly: true,
    productionSafe: false,
    stateRoot: "C:\\qualification\\state",
  });
}

function qualifiedBackendFixture({
  manager = createSyntheticManager(),
  context = qualificationContext(),
  contextValid = true,
  recovery = Object.freeze({ complete: true, recovered: 0, contended: 0 }),
  managerFailure = null,
  leaseFailure = null,
} = {}) {
  const calls = [];
  let leaseCloses = 0;
  let auditStoreCloses = 0;
  let leaseContext = null;
  const adapter = Object.freeze({ kind: "synthetic-windows-adapter" });
  const factories = Object.freeze({
    createMutexContext(options) {
      calls.push(["mutex", options]);
      return Object.freeze({ kind: "mutex" });
    },
    createAuditFileGuardContext(options) {
      calls.push(["guard", options]);
      return Object.freeze({ kind: "guard" });
    },
    defaultAuditFile(options) {
      calls.push(["file", options]);
      return defaultWindowsCredentialOperationAuditFile(options);
    },
    createAuditStore(options) {
      calls.push(["store", options]);
      return Object.freeze({
        kind: "audit",
        close() { auditStoreCloses += 1; },
      });
    },
    createLeaseContext(options) {
      calls.push(["lease", options]);
      if (leaseFailure !== null) throw leaseFailure;
      const ownedAuditStore = options.auditStore;
      leaseContext = Object.freeze({
        recoverPreparedOperations() {
          calls.push(["recover"]);
          return recovery;
        },
        close() {
          leaseCloses += 1;
          ownedAuditStore.close();
        },
      });
      return leaseContext;
    },
    createCredentialManagerBackend(options) {
      calls.push(["manager", options]);
      if (managerFailure !== null) throw managerFailure;
      return manager.manager;
    },
    isQualificationModeContextFor(options) {
      calls.push(["context", options]);
      return contextValid;
    },
  });
  const options = Object.freeze({
    platform: "win32",
    architecture: "x64",
    adapter,
    resourceRoot: "C:\\qualification\\resources",
    windowsQualificationModeContext: context,
  });
  return Object.freeze({
    adapter,
    calls,
    context,
    factories,
    manager,
    options,
    get leaseCloses() { return leaseCloses; },
    get auditStoreCloses() { return auditStoreCloses; },
    get leaseContext() { return leaseContext; },
  });
}

function normalCandidateBackendFixture({
  manager = createSyntheticManager(),
  adapterFacts = {},
  recovery = Object.freeze({ complete: true, recovered: 0, contended: 0 }),
  managerFailure = null,
  leaseFailure = null,
} = {}) {
  const calls = [];
  let leaseCloses = 0;
  let auditStoreCloses = 0;
  let leaseContext = null;
  const adapter = Object.freeze({
    productionSafe: adapterFacts.productionSafe ?? false,
    pathWalkRaceSafe: adapterFacts.pathWalkRaceSafe ?? false,
    credentialMutexSafe: adapterFacts.credentialMutexSafe ?? true,
    credentialAuditFileGuardSafe: adapterFacts.credentialAuditFileGuardSafe ?? true,
  });
  const factories = Object.freeze({
    createAdapter(options) {
      calls.push(["adapter", options]);
      return adapter;
    },
    isFilesystemAdapter(value) {
      calls.push(["adapter-brand", value]);
      return value === adapter;
    },
    createMutexContext(options) {
      calls.push(["mutex", options]);
      return Object.freeze({ kind: "mutex" });
    },
    createAuditFileGuardContext(options) {
      calls.push(["guard", options]);
      return Object.freeze({ kind: "guard" });
    },
    defaultAuditFile(options) {
      calls.push(["file", options]);
      return defaultWindowsCredentialOperationAuditFile(options);
    },
    createAuditStore(options) {
      calls.push(["store", options]);
      return Object.freeze({
        kind: "audit",
        close() { auditStoreCloses += 1; },
      });
    },
    createLeaseContext(options) {
      calls.push(["lease", options]);
      if (leaseFailure !== null) throw leaseFailure;
      const ownedAuditStore = options.auditStore;
      leaseContext = Object.freeze({
        recoverPreparedOperations() {
          calls.push(["recover"]);
          return recovery;
        },
        close() {
          leaseCloses += 1;
          ownedAuditStore.close();
        },
      });
      return leaseContext;
    },
    createCredentialManagerBackend(options) {
      calls.push(["manager", options]);
      if (managerFailure !== null) throw managerFailure;
      return manager.manager;
    },
  });
  return Object.freeze({
    adapter,
    calls,
    factories,
    manager,
    options: Object.freeze({ platform: "win32", architecture: "x64" }),
    get leaseCloses() { return leaseCloses; },
    get auditStoreCloses() { return auditStoreCloses; },
    get leaseContext() { return leaseContext; },
  });
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

test("qualified Windows account-observation construction keeps the generic manager private behind the fixed lease-owning facade", async () => {
  const fixture = qualifiedBackendFixture();
  const backend = createQualifiedWindowsAccountObservationCredentialBackendForTest(
    fixture.options,
    fixture.factories,
  );
  const candidate = Buffer.alloc(32, 81);
  try {
    assert.equal(await backend.read(), null);
    assert.equal(await backend.createIfMissing(candidate), "created");
    const observed = await backend.read();
    assert.deepEqual(observed, candidate);
    observed.fill(0);
  } finally {
    candidate.fill(0);
    backend.close();
  }
  assert.deepEqual(fixture.calls.map(([name]) => name), [
    "context", "mutex", "guard", "file", "store", "lease", "recover", "manager",
  ]);
  assert.deepEqual(fixture.calls[0][1], {
    context: fixture.context,
    adapter: fixture.adapter,
    stateRoot: "C:\\qualification\\state",
    resourceRoot: "C:\\qualification\\resources",
  });
  assert.deepEqual(fixture.calls[2][1], { platform: "win32", architecture: "x64" });
  assert.deepEqual(fixture.calls[3][1], {
    platform: "win32",
    stateRoot: "C:\\qualification\\state\\account-observation-fd4-v1",
  });
  assert.deepEqual(fixture.calls[6], ["recover"]);
  assert.deepEqual(Object.keys(fixture.calls[7][1]).sort(), [
    "architecture", "operationLeaseContext", "platform",
  ]);
  assert.equal(fixture.calls[7][1].platform, "win32");
  assert.equal(fixture.calls[7][1].architecture, "x64");
  assert.equal(fixture.calls[7][1].operationLeaseContext, fixture.leaseContext);
  assert.equal(fixture.leaseCloses, 1);
  assert.equal(fixture.auditStoreCloses, 1);
  // The generic manager cannot close an injected lease. The fixed facade owns
  // the lease instead, so a close cannot accidentally call the generic path.
  assert.equal(fixture.manager.closeCalls, 0);
  assert.equal(fixture.manager.calls.every(([, capability]) => capability === ACCOUNT_CAPABILITY), true);
});

test("normal-candidate Windows account-observation construction reuses the fixed audited manager assembly without a qualification context", async () => {
  const fixture = normalCandidateBackendFixture();
  const backend = createWindowsNormalCandidateAccountObservationCredentialBackendForTest(
    fixture.options,
    fixture.factories,
  );
  const candidate = Buffer.alloc(32, 109);
  try {
    assert.equal(await backend.read(), null);
    assert.equal(await backend.createIfMissing(candidate), "created");
    const observed = await backend.read();
    assert.deepEqual(observed, candidate);
    observed.fill(0);
    assert.deepEqual(await backend.describe(), {
      backend: "windows_account_observation_credential",
      status: WINDOWS_ACCOUNT_OBSERVATION_CREDENTIAL_INTEGRATION_STATUS,
      productionSafe: false,
      crossProcessSafe: true,
      auditDurable: true,
      auditFilesystemProtected: true,
      startupRecoveryComplete: true,
    });
  } finally {
    candidate.fill(0);
    backend.close();
  }
  assert.deepEqual(fixture.calls.map(([name]) => name), [
    "adapter", "adapter-brand", "mutex", "guard", "file", "store", "lease", "recover", "manager",
  ]);
  assert.deepEqual(fixture.calls[0][1], { platform: "win32", architecture: "x64" });
  assert.equal(fixture.calls[1][1], fixture.adapter);
  assert.deepEqual(fixture.calls[4][1], { platform: "win32" },
    "a normal candidate cannot select a qualification or caller-owned audit root");
  assert.deepEqual(Object.keys(fixture.calls[8][1]).sort(), [
    "architecture", "operationLeaseContext", "platform",
  ]);
  assert.equal(fixture.calls[8][1].operationLeaseContext, fixture.leaseContext);
  assert.equal(fixture.leaseCloses, 1);
  assert.equal(fixture.auditStoreCloses, 1);
  assert.equal(fixture.manager.closeCalls, 0);
  assert.equal(fixture.manager.calls.every(([, capability]) => capability === ACCOUNT_CAPABILITY), true);
});

test("normal-candidate observation construction refuses unreviewed adapter facts and caller-selected native controls", () => {
  for (const adapterFacts of [
    { productionSafe: true },
    { pathWalkRaceSafe: true },
    { credentialMutexSafe: false },
    { credentialAuditFileGuardSafe: false },
  ]) {
    const fixture = normalCandidateBackendFixture({ adapterFacts });
    assert.throws(
      () => createWindowsNormalCandidateAccountObservationCredentialBackendForTest(
        fixture.options,
        fixture.factories,
      ),
      accountObservationError("unavailable"),
    );
    assert.deepEqual(fixture.calls.map(([name]) => name), ["adapter", "adapter-brand"]);
    assert.equal(fixture.leaseCloses, 0);
  }
  for (const [options, expected] of [
    [{ platform: "win32", architecture: "arm64" }, "unsupported_architecture"],
    [{ platform: "linux", architecture: "x64" }, "unsupported_platform"],
  ]) {
    const fixture = normalCandidateBackendFixture();
    assert.throws(
      () => createWindowsNormalCandidateAccountObservationCredentialBackendForTest(options, fixture.factories),
      accountObservationError(expected),
    );
    assert.deepEqual(fixture.calls, []);
  }
  assert.throws(
    () => createWindowsNormalCandidateAccountObservationCredentialBackend({
      binding: Object.freeze({}),
    }),
    accountObservationError("invalid_configuration"),
  );
  assert.throws(
    () => createWindowsNormalCandidateAccountObservationCredentialBackendForTest({
      platform: "win32",
      architecture: "x64",
      stateRoot: "C:\\caller-controlled",
    }, normalCandidateBackendFixture().factories),
    accountObservationError("invalid_configuration"),
  );
});

test("normal-candidate observation constructor keeps durable ownership on failure", () => {
  const failedLease = normalCandidateBackendFixture({
    leaseFailure: new Error("WINDOWS-NORMAL-CANDIDATE-LEASE-CANARY"),
  });
  assert.throws(
    () => createWindowsNormalCandidateAccountObservationCredentialBackendForTest(
      failedLease.options,
      failedLease.factories,
    ),
    accountObservationError("unavailable"),
  );
  assert.deepEqual(failedLease.calls.map(([name]) => name), [
    "adapter", "adapter-brand", "mutex", "guard", "file", "store", "lease",
  ]);
  assert.equal(failedLease.leaseCloses, 0);
  assert.equal(failedLease.auditStoreCloses, 1);

  const failedManager = normalCandidateBackendFixture({
    managerFailure: new Error("WINDOWS-NORMAL-CANDIDATE-MANAGER-CANARY"),
  });
  assert.throws(
    () => createWindowsNormalCandidateAccountObservationCredentialBackendForTest(
      failedManager.options,
      failedManager.factories,
    ),
    accountObservationError("unavailable"),
  );
  assert.equal(failedManager.leaseCloses, 1);
  assert.equal(failedManager.auditStoreCloses, 1);
});

test("qualified observation audit creates a protected child instead of reclassifying the launcher's inherited-ACL state container", () => {
  const fixture = qualifiedBackendFixture();
  const stateRoot = fixture.context.stateRoot;
  const ensured = [];
  const createdFiles = [];
  const identity = Object.freeze({ volumeSerialNumber: "0".repeat(16), fileId: "0".repeat(32), linkCount: 1 });
  const guard = createWindowsCredentialAuditFileGuardContext({
    platform: "win32", architecture: "x64",
    binding: {
      credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
      credentialAuditFileGuardSafe: true,
      ensureDirectory(path) {
        // A real launcher directory inherits its parent's ACL; native
        // EnsureDirectory rejects it as the final protected directory.
        if (path === stateRoot) throw Object.assign(new Error("ordinary inherited ACL"), { code: "WINDOWS_FILESYSTEM_SECURITY_POLICY" });
        ensured.push(path);
      },
      createFile(path) { createdFiles.push(path); },
      acquireCredentialAuditFileGuard() { return { guard: {}, identity }; },
      releaseCredentialAuditFileGuard() {},
    },
  });
  const backend = createQualifiedWindowsAccountObservationCredentialBackendForTest(fixture.options, {
    ...fixture.factories,
    createAuditFileGuardContext: () => guard,
    createAuditStore({ filePath, fileGuardContext }) {
      const lease = fileGuardContext.acquire(filePath);
      return { close() { fileGuardContext.release(lease); } };
    },
  });
  backend.close();
  const privateRoot = win32.join(stateRoot, "account-observation-fd4-v1");
  assert.deepEqual(ensured, [privateRoot, win32.join(privateRoot, "private")]);
  const auditPath = win32.join(privateRoot, "private", "windows-credential-operation-audit-v1.sqlite");
  assert.deepEqual(createdFiles, [auditPath, `${auditPath}-journal`]);
});

test("qualified Windows account-observation construction authenticates context and recovery before native factories", () => {
  const invalidContext = qualifiedBackendFixture({ contextValid: false });
  assert.throws(
    () => createQualifiedWindowsAccountObservationCredentialBackendForTest(
      invalidContext.options,
      invalidContext.factories,
    ),
    accountObservationError("unavailable"),
  );
  assert.deepEqual(invalidContext.calls.map(([name]) => name), ["context"]);
  assert.equal(invalidContext.leaseCloses, 0);

  const incompleteRecovery = qualifiedBackendFixture({
    recovery: Object.freeze({ complete: false, recovered: 0, contended: 1 }),
  });
  assert.throws(
    () => createQualifiedWindowsAccountObservationCredentialBackendForTest(
      incompleteRecovery.options,
      incompleteRecovery.factories,
    ),
    accountObservationError("recovery_required"),
  );
  assert.deepEqual(incompleteRecovery.calls.map(([name]) => name), [
    "context", "mutex", "guard", "file", "store", "lease", "recover",
  ]);
  assert.equal(incompleteRecovery.leaseCloses, 1);

  const failedLease = qualifiedBackendFixture({
    leaseFailure: new Error("WINDOWS-QUALIFIED-LEASE-PRIVATE-CANARY"),
  });
  assert.throws(
    () => createQualifiedWindowsAccountObservationCredentialBackendForTest(
      failedLease.options,
      failedLease.factories,
    ),
    accountObservationError("unavailable"),
  );
  assert.deepEqual(failedLease.calls.map(([name]) => name), [
    "context", "mutex", "guard", "file", "store", "lease",
  ]);
  assert.equal(failedLease.leaseCloses, 0);
  assert.equal(failedLease.auditStoreCloses, 1,
    "a durable audit store is closed if lease construction never takes ownership");

  const privateCanary = "WINDOWS-QUALIFIED-MANAGER-PRIVATE-CANARY";
  const failedManager = qualifiedBackendFixture({ managerFailure: new Error(privateCanary) });
  assert.throws(
    () => createQualifiedWindowsAccountObservationCredentialBackendForTest(
      failedManager.options,
      failedManager.factories,
    ),
    (error) => {
      assert.equal(accountObservationError("unavailable")(error), true);
      assert.equal(`${error.stack}\n${JSON.stringify(error)}`.includes(privateCanary), false);
      return true;
    },
  );
  assert.equal(failedManager.leaseCloses, 1);
});

test("production qualified constructor never accepts a synthetic platform or manager seam", () => {
  const expected = process.platform === "win32" && process.arch === "x64"
    ? "unavailable"
    : process.platform === "win32" ? "unsupported_architecture" : "unsupported_platform";
  assert.throws(
    () => createQualifiedWindowsAccountObservationCredentialBackend({
      adapter: Object.freeze({}),
      resourceRoot: "C:\\qualification\\resources",
      windowsQualificationModeContext: Object.freeze({}),
    }),
    accountObservationError(expected),
  );
});
