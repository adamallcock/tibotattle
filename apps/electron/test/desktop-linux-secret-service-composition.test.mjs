import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Duplex } from "node:stream";
import test from "node:test";

import {
  createCompanionSupervisor,
} from "../companion-supervisor.js";
import {
  attachDesktopLinuxAccountObservationBroker,
} from "../desktop-linux-account-observation-broker.js";
import {
  createLinuxProductionCredentialHandoverForTest,
  createLinuxQualificationSecretServiceHandover,
  createLinuxQualificationSecretServiceHandoverForTest,
  LINUX_SECRET_SERVICE_MAIN_COMPOSITION_STATUS,
} from "../desktop-linux-secret-service.js";
import {
  runLinuxAccountObservationQualificationSmoke,
  runLinuxSecretServiceQualificationSmoke,
} from "../linux-secret-service-qualification-smoke.js";
import {
  createLinuxQualificationSupervisorOptions,
} from "../main.js";
import {
  createLinuxQualificationContext,
} from "../linux-qualification.js";
import {
  createLinuxCredentialMutationLeaseContext,
  createLinuxCredentialMutationMutexContext,
} from "../../../src/platform/linux-credential-mutation-lease.js";
import {
  createLinuxAccountObservationCredentialBackend,
} from "../../../src/platform/linux-account-observation-credential.js";
import {
  LINUX_SECRET_SERVICE_CAPABILITIES,
  createLinuxSecretServiceBackend,
  isLinuxSecretServiceError,
} from "../../../src/platform/linux-secret-service.js";

const REVISION = "a".repeat(40);
const DIGEST = "b".repeat(64);
const CHILD_PATH = fileURLToPath(new URL(
  "../linux-secret-service-qualification-smoke-child.mjs",
  import.meta.url,
));
const ACCOUNT_OBSERVATION_CHILD_PATH = fileURLToPath(new URL(
  "../linux-account-observation-qualification-smoke-child.mjs",
  import.meta.url,
));

function context(overrides = {}) {
  return createLinuxQualificationContext({
    platform: "linux",
    architecture: "x64",
    sourceRevision: REVISION,
    distribution: "ubuntu-24.04",
    desktopProtocol: "x11",
    credentialStoreMode: "native-secret-service",
    subjectKind: "unpacked",
    artifactDigest: DIGEST,
    developmentOnly: true,
    ...overrides,
  });
}

function compositionError(error) {
  return error?.code === "electron_shell_electron_configuration_invalid"
    && error?.message === "Electron shell operation failed";
}

function syntheticNative({ abandoned = false, existingRecords = [] } = {}) {
  const values = new Map();
  const acquired = [];
  const released = [];
  const abandonedLeases = [];
  const secretCalls = [];
  let nextLease = 0;
  const mutexBinding = {
    credentialMutexContractVersion: "linux-credential-mutex-v1",
    credentialMutexCrossProcessSafe: true,
    credentialMutexSameNetworkNamespaceOnly: true,
    acquireCredentialMutex(capability) {
      if (!Number.isSafeInteger(capability) || ![0, 1].includes(capability)) {
        throw Object.assign(new Error("invalid capability"), {
          code: "LINUX_CREDENTIAL_MUTEX_INVALID_CAPABILITY",
        });
      }
      const lease = Object.freeze({ id: ++nextLease, capability });
      acquired.push(capability);
      return Object.freeze({ lease, abandoned });
    },
    releaseCredentialMutex(lease) {
      released.push(lease.capability);
    },
    abandonCredentialMutex(lease) {
      abandonedLeases.push(lease.capability);
    },
  };
  const secretServiceBinding = {
    async getPassword(service, account) {
      const key = `${service}\u0000${account}`;
      secretCalls.push(["read", key]);
      return values.get(key) ?? null;
    },
    async setPassword(service, account, value) {
      const key = `${service}\u0000${account}`;
      secretCalls.push(["write", key]);
      values.set(key, value);
    },
    async deletePassword(service, account) {
      const key = `${service}\u0000${account}`;
      secretCalls.push(["delete", key]);
      values.delete(key);
      return true;
    },
  };
  for (const [capability, secret] of existingRecords) {
    if (!Buffer.isBuffer(secret) || secret.byteLength !== 32
        || typeof capability?.service !== "string" || typeof capability?.account !== "string") {
      throw new TypeError("synthetic native fixture is invalid");
    }
    values.set(
      `${capability.service}\u0000${capability.account}`,
      Buffer.from(secret).toString("base64url"),
    );
  }
  return Object.freeze({
    mutexBinding,
    secretServiceBinding,
    acquired,
    released,
    abandonedLeases,
    secretCalls,
    values,
  });
}

function syntheticAccountObservationNative(existing = null) {
  let stored = existing === null ? null : Buffer.from(existing);
  const calls = [];
  const binding = Object.freeze({
    credentialMutexContractVersion: "linux-credential-mutex-v1",
    credentialMutexCrossProcessSafe: true,
    credentialMutexSameNetworkNamespaceOnly: true,
    credentialMutexDurableMarker: true,
    productionSafe: false,
    async readAccountObservationCredential() {
      calls.push("read");
      return stored === null ? null : Buffer.from(stored);
    },
    async createAccountObservationCredentialIfMissing(candidate) {
      assert.equal(Buffer.isBuffer(candidate), true);
      assert.equal(candidate.byteLength, 32);
      calls.push("create");
      if (stored !== null) return "existing";
      stored = Buffer.from(candidate);
      return "created";
    },
  });
  return Object.freeze({
    binding,
    calls,
    readStored() { return stored === null ? null : Buffer.from(stored); },
    dispose() {
      stored?.fill(0);
      stored = null;
    },
  });
}

function observationSupervisor(native, captureExit = null) {
  const backend = createLinuxAccountObservationCredentialBackend({
    platform: "linux",
    architecture: "x64",
    binding: native.binding,
  });
  return createCompanionSupervisor({
    command: process.execPath,
    args: [ACCOUNT_OBSERVATION_CHILD_PATH],
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000,
    ...(captureExit === null ? {} : {
      spawnChild(command, args, options) {
        const child = spawn(command, args, options);
        child.once("exit", (code) => { captureExit.value = code; });
        return child;
      },
    }),
    attachLinuxAccountObservationBroker(channel) {
      return attachDesktopLinuxAccountObservationBroker({
        channel,
        createBackend: () => backend,
      });
    },
  });
}

function handover(qualificationContext, native) {
  return createLinuxQualificationSecretServiceHandoverForTest({
    qualificationContext,
    platform: "linux",
    architecture: "x64",
    prepareState() {},
    createMutexContext: (options) => createLinuxCredentialMutationMutexContext({
      ...options,
      binding: native.mutexBinding,
    }),
    createLeaseContext: createLinuxCredentialMutationLeaseContext,
    createSecretServiceBackend: (options) => createLinuxSecretServiceBackend({
      ...options,
      binding: native.secretServiceBinding,
      sessionProbe: async () => "available",
    }),
    isSecretServiceError: isLinuxSecretServiceError,
  });
}

function recoveredChildSource() {
  const brokerUrl = new URL(
    "../../../src/platform/linux-secret-service-broker.js",
    import.meta.url,
  ).href;
  return `
    import assert from 'node:assert/strict';
    import {
      LINUX_SECRET_SERVICE_BROKER_CAPABILITIES,
      createLinuxSecretServiceBrokerBackendFromEnvironment,
    } from ${JSON.stringify(brokerUrl)};
    const backend = createLinuxSecretServiceBrokerBackendFromEnvironment();
    try {
      await backend.createIfMissing(
        LINUX_SECRET_SERVICE_BROKER_CAPABILITIES.exportIdentity,
        Buffer.alloc(32, 9),
      );
      assert.fail('abandoned lease must fail closed');
    } catch (error) {
      assert.equal(error?.code, 'linux_secret_service_broker_recovery_required');
    }
    process.stdout.write('USAGE_MONITOR_READY http://127.0.0.1:4545/\\n');
    setInterval(() => {}, 1_000);
  `;
}

test("Linux main composition authenticates an L0 context before any native construction", async () => {
  assert.equal(LINUX_SECRET_SERVICE_MAIN_COMPOSITION_STATUS, "qualification_only");
  assert.deepEqual(createLinuxQualificationSupervisorOptions(), {});
  assert.throws(
    () => createLinuxQualificationSecretServiceHandover(),
    compositionError,
  );
  await assert.rejects(
    runLinuxAccountObservationQualificationSmoke(),
    (error) => error?.code === "linux_account_observation_qualification_smoke_failed"
      && error?.message === "Linux account-observation qualification smoke failed",
  );

  let factoryCalls = 0;
  const invalid = { ...context() };
  const options = {
    qualificationContext: invalid,
    platform: "linux",
    architecture: "x64",
    prepareState() { factoryCalls += 1; },
    createMutexContext() { factoryCalls += 1; return {}; },
    createLeaseContext() { factoryCalls += 1; return { close() {} }; },
    createSecretServiceBackend() { factoryCalls += 1; return {}; },
    isSecretServiceError() { return false; },
  };
  assert.throws(
    () => createLinuxQualificationSecretServiceHandoverForTest(options),
    compositionError,
  );
  assert.equal(factoryCalls, 0);
  assert.throws(
    () => createLinuxQualificationSupervisorOptions({ linuxQualificationContext: invalid }),
    compositionError,
  );

  const unsupported = context({ architecture: "arm64" });
  assert.throws(
    () => createLinuxQualificationSecretServiceHandoverForTest({
      ...options,
      qualificationContext: unsupported,
      architecture: "arm64",
    }),
    compositionError,
  );
  assert.equal(factoryCalls, 0);
});

test("Linux qualification smoke refuses a missing context before native load or child spawn", async () => {
  await assert.rejects(
    runLinuxSecretServiceQualificationSmoke(),
    (error) => error?.code === "linux_secret_service_qualification_smoke_failed"
      && error?.message === "Linux Secret Service qualification smoke failed",
  );
});

test("Linux qualification smoke refuses a non-isolated context before native load or child spawn", async () => {
  await assert.rejects(
    runLinuxSecretServiceQualificationSmoke({ qualificationContext: context() }),
    (error) => error?.code === "linux_secret_service_qualification_smoke_failed"
      && error?.message === "Linux Secret Service qualification smoke failed",
  );
  await assert.rejects(
    runLinuxAccountObservationQualificationSmoke({ qualificationContext: context() }),
    (error) => error?.code === "linux_account_observation_qualification_smoke_failed"
      && error?.message === "Linux account-observation qualification smoke failed",
  );
});

test("Linux dormant production handover carries only fixed FD3 and observation routes", async () => {
  const native = syntheticAccountObservationNative();
  const accountlessBackend = Object.freeze({
    async read() { return null; },
    async createIfMissing() { return "created"; },
    async deleteExact() { return "missing"; },
  });
  const accountlessOptions = Object.freeze({ legacyCredentialProbe: () => "absent" });
  const accountlessCalls = [];
  const handover = createLinuxProductionCredentialHandoverForTest({
    platform: "linux",
    architecture: "x64",
    createAccountlessCredentialBackend(options) {
      accountlessCalls.push(options);
      return accountlessBackend;
    },
    createAccountObservationCredentialBackend() {
      return createLinuxAccountObservationCredentialBackend({
        platform: "linux",
        architecture: "x64",
        binding: native.binding,
      });
    },
  });
  assert.deepEqual(Object.keys(handover).sort(), [
    "attachLinuxAccountObservationBroker",
    "createAccountlessCredentialBackend",
  ]);
  assert.equal(
    handover.createAccountlessCredentialBackend(accountlessOptions),
    accountlessBackend,
  );
  assert.deepEqual(accountlessCalls, [accountlessOptions]);

  const supervisor = createCompanionSupervisor({
    command: process.execPath,
    args: [ACCOUNT_OBSERVATION_CHILD_PATH],
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000,
    attachLinuxAccountObservationBroker:
      handover.attachLinuxAccountObservationBroker,
  });
  try {
    await supervisor.start();
    assert.deepEqual(native.calls, ["read", "create", "read"]);
  } finally {
    try { await supervisor.stop(); } finally { native.dispose(); }
  }
});

test("Linux dormant production handover rejects non-Linux, non-x64, and injected extras", () => {
  for (const overrides of [
    { platform: "darwin" },
    { architecture: "arm64" },
    { extra: true },
  ]) {
    let factoryCalls = 0;
    assert.throws(
      () => createLinuxProductionCredentialHandoverForTest({
        platform: "linux",
        architecture: "x64",
        createAccountlessCredentialBackend() { factoryCalls += 1; },
        createAccountObservationCredentialBackend() { factoryCalls += 1; },
        ...overrides,
      }),
      compositionError,
    );
    assert.equal(factoryCalls, 0);
  }
});

test("Linux observation qualification child starts absent and completes fixed read/create/readback over inherited IPC", async () => {
  const native = syntheticAccountObservationNative();
  const supervisor = observationSupervisor(native);
  const expected = Buffer.alloc(32, 93);
  let stored = null;
  try {
    await supervisor.start();
    stored = native.readStored();
    assert.equal(Buffer.isBuffer(stored), true);
    assert.equal(Buffer.compare(stored, expected), 0);
    assert.deepEqual(native.calls, ["read", "create", "read"]);
  } finally {
    stored?.fill(0);
    expected.fill(0);
    try { await supervisor.stop(); } finally { native.dispose(); }
  }
});

test("Linux observation qualification child refuses retained fixed state before creating", async () => {
  const existing = Buffer.alloc(32, 101);
  const native = syntheticAccountObservationNative(existing);
  const childExit = { value: null };
  const supervisor = observationSupervisor(native, childExit);
  let stored = null;
  try {
    await assert.rejects(
      supervisor.start(),
      (error) => error?.code === "electron_shell_companion_exit_before_ready",
    );
    await supervisor.stop();
    stored = native.readStored();
    assert.equal(childExit.value, 31);
    assert.equal(Buffer.isBuffer(stored), true);
    assert.equal(Buffer.compare(stored, existing), 0);
    assert.deepEqual(native.calls, ["read"]);
  } finally {
    existing.fill(0);
    stored?.fill(0);
    native.dispose();
  }
});

test("Linux handover closes its injected lease context when the owned FD4 stream ends", () => {
  let backendCloses = 0;
  let leaseCloses = 0;
  const setup = [];
  const h = createLinuxQualificationSecretServiceHandoverForTest({
    qualificationContext: context(),
    platform: "linux",
    architecture: "x64",
    prepareState(options) { assert.deepEqual(options, { platform: "linux", architecture: "x64" }); setup.push("state"); },
    createMutexContext: () => { setup.push("mutex"); return Object.freeze({}); },
    createLeaseContext: () => { setup.push("lease"); return Object.freeze({ close() { leaseCloses += 1; } }); },
    createSecretServiceBackend: () => Object.freeze({
      async read() { return null; },
      async createIfMissing() { return "created"; },
      async replaceExact() { return "replaced"; },
      async deleteExact() { return "deleted"; },
      async withOperationLease(_capability, _options, callback) {
        return callback(Object.freeze({}));
      },
      close() { backendCloses += 1; },
      crossProcessSafe: true,
      crashRecoveryComplete: false,
      productionSafe: false,
    }),
    isSecretServiceError: () => false,
  });
  const stream = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
  assert.deepEqual(setup, [], "native preparation is deferred until the owned channel attaches");
  const broker = h.attachLinuxSecretServiceBroker(stream);
  assert.deepEqual(setup, ["state", "mutex", "lease"]);
  broker.dispose();
  assert.equal(backendCloses, 1);
  assert.equal(leaseCloses, 1);
});

test("Linux state preparation refusal precedes mutex and credential construction", () => {
  let prepared = 0;
  const h = createLinuxQualificationSecretServiceHandoverForTest({
    qualificationContext: context(), platform: "linux", architecture: "x64",
    prepareState() { prepared += 1; throw new Error("private-state-path-canary"); },
    createMutexContext() { assert.fail("unsafe state must precede the mutex"); },
    createLeaseContext() { assert.fail("unsafe state must precede the lease"); },
    createSecretServiceBackend() { assert.fail("unsafe state must precede credentials"); },
    isSecretServiceError: () => false,
  });
  const stream = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
  try {
    assert.throws(() => h.attachLinuxSecretServiceBroker(stream));
    assert.equal(prepared, 1);
  } finally { stream.destroy(); }
});

test("Linux main composition carries the real qualified lease backend over inherited FD4", {
  skip: process.platform === "win32"
    ? "inherited socketpair descriptor requires POSIX coverage"
    : false,
}, async () => {
  const native = syntheticNative();
  const h = handover(context({ credentialStoreMode: "isolated-secret-service" }), native);
  const supervisor = createCompanionSupervisor({
    command: process.execPath,
    args: [CHILD_PATH],
    environment: {
      USAGE_MONITOR_KEYCHAIN_BROKER_FD: "99",
      USAGE_MONITOR_LINUX_SECRET_SERVICE_BROKER_FD: "88",
    },
    attachLinuxSecretServiceBroker: h.attachLinuxSecretServiceBroker,
  });
  try {
    await supervisor.start();
  } finally {
    await supervisor.stop();
  }
  assert.deepEqual(native.acquired, [0, 0, 0, 1, 1, 1]);
  assert.deepEqual(native.released, native.acquired);
  assert.deepEqual(native.abandonedLeases, []);
  assert.equal(native.values.size, 0);
  assert.equal(native.secretCalls.every(([, key]) => key.includes("\u0000")), true);
});

test("Linux main composition preserves an existing isolated record when the smoke child refuses it", {
  skip: process.platform === "win32"
    ? "inherited socketpair descriptor requires POSIX coverage"
    : false,
}, async () => {
  const existing = Buffer.alloc(32, 91);
  const encoded = existing.toString("base64url");
  const native = syntheticNative({
    existingRecords: [[LINUX_SECRET_SERVICE_CAPABILITIES.exportIdentity, existing]],
  });
  existing.fill(0);
  const h = handover(context({ credentialStoreMode: "isolated-secret-service" }), native);
  let childExitCode = null;
  const supervisor = createCompanionSupervisor({
    command: process.execPath,
    args: [CHILD_PATH],
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000,
    spawnChild(command, args, options) {
      const child = spawn(command, args, options);
      child.once("exit", (code) => { childExitCode = code; });
      return child;
    },
    attachLinuxSecretServiceBroker: h.attachLinuxSecretServiceBroker,
  });
  try {
    await assert.rejects(
      supervisor.start(),
      (error) => error?.code === "electron_shell_companion_exit_before_ready",
    );
  } finally {
    await supervisor.stop();
  }
  assert.deepEqual(native.acquired, [0]);
  assert.equal(childExitCode, 21, "the fixed create stage reports refusal without secret output");
  assert.deepEqual(native.released, [0]);
  assert.deepEqual(native.abandonedLeases, []);
  assert.deepEqual([...native.values.values()], [encoded]);
  assert.equal(native.secretCalls.every(([operation]) => operation === "read"), true);
});

test("Linux main composition preserves native abandoned-lease refusal over inherited FD4", {
  skip: process.platform === "win32"
    ? "inherited socketpair descriptor requires POSIX coverage"
    : false,
}, async () => {
  const native = syntheticNative({ abandoned: true });
  const h = handover(context(), native);
  const supervisor = createCompanionSupervisor({
    command: process.execPath,
    args: ["--input-type=module", "--eval", recoveredChildSource()],
    attachLinuxSecretServiceBroker: h.attachLinuxSecretServiceBroker,
  });
  try {
    await supervisor.start();
  } finally {
    await supervisor.stop();
  }
  assert.deepEqual(native.acquired, [0]);
  assert.deepEqual(native.released, []);
  assert.deepEqual(native.abandonedLeases, [0]);
  assert.equal(native.values.size, 0);
});
