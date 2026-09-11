import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountObservationSecretError,
  createAccountObservationSecretLoader,
  createDevelopmentAccountObservationSecretLoader,
} from "../src/account-observation-secret.js";
import { selectProductionAccountObservationSecret } from "../src/account-observation-production.js";
import { EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES } from "../src/export-identity-keychain.js";
import {
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_ENV,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_SCHEMA,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_RESPONSE_KIND,
  createWindowsAccountObservationBrokerBackendFromEnvironment,
  createWindowsProductionReadinessAttestation,
} from "../src/platform/index.js";
import { run } from "../src/cli.js";
import { sanitizeCodexAccountSnapshotWithSecretLoader } from "../src/providers/codex/account.js";

const ACCOUNT_CAPABILITY = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation;

function operationLockContent(processId, createdAt) {
  return `${JSON.stringify({
    schemaVersion: "account-observation-operation-v1",
    processId,
    createdAt,
  })}\n`;
}

function memoryBackend(initial = null) {
  let stored = initial === null ? null : Buffer.from(initial);
  const calls = [];
  return {
    calls,
    async read(capability) {
      calls.push(["read", capability]);
      return stored === null ? null : Buffer.from(stored);
    },
    async createIfMissing(capability, candidate) {
      calls.push(["createIfMissing", capability, Buffer.from(candidate)]);
      if (stored !== null) return "existing";
      stored = Buffer.from(candidate);
      return "created";
    },
    stored() { return stored === null ? null : Buffer.from(stored); },
  };
}

function windowsObservationBrokerChannel(initial = null) {
  let stored = initial === null ? null : Buffer.from(initial);
  const operations = [];
  const channel = new EventEmitter();
  channel.connected = true;
  channel.send = (request, callback = undefined) => {
    operations.push(request.op);
    queueMicrotask(() => {
      const existed = stored !== null;
      if (request.op === "create_if_missing" && !existed) {
        stored = Buffer.from(request.secret, "base64url");
      }
      const response = request.op === "read"
        ? {
          schemaVersion: WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_SCHEMA,
          kind: WINDOWS_ACCOUNT_OBSERVATION_BROKER_RESPONSE_KIND,
          v: WINDOWS_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION,
          id: request.id,
          ok: true,
          secret: stored === null ? null : stored.toString("base64url"),
        }
        : {
          schemaVersion: WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_SCHEMA,
          kind: WINDOWS_ACCOUNT_OBSERVATION_BROKER_RESPONSE_KIND,
          v: WINDOWS_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION,
          id: request.id,
          ok: true,
          status: existed ? "existing" : "created",
        };
      channel.emit("message", response);
      callback?.(null);
    });
    return true;
  };
  return {
    channel,
    operations,
    dispose() {
      channel.connected = false;
      channel.emit("disconnect");
      stored?.fill(0);
    },
  };
}

test("account observation loader reads or creates only the distinct capability under its operation lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-usagemonitor-account-secret-"));
  const lock = join(root, "state", "account-operation.lock");
  const generated = Buffer.alloc(32, 71);
  const backend = memoryBackend();
  try {
    const load = createAccountObservationSecretLoader({
      backend,
      capability: ACCOUNT_CAPABILITY,
      operationLockFile: lock,
      generateSecret: () => Buffer.from(generated),
    });
    const first = await load();
    const second = await load();
    assert.deepEqual(first, generated);
    assert.deepEqual(second, generated);
    first.fill(0);
    assert.deepEqual(second, generated);
    assert.deepEqual(backend.stored(), generated);
    assert.equal(backend.calls.every(([, capability]) => capability === ACCOUNT_CAPABILITY), true);
    assert.equal(backend.calls.some(([, capability]) => capability === EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity), false);
    await assert.rejects(readFile(lock), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing-only account loader never generates or creates an upload identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "account-existing-only-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const stored of [null, Buffer.alloc(32, 6)]) {
    const backend = memoryBackend(stored);
    const operationLockFile = join(root, "account-operation.lock");
    const load = createAccountObservationSecretLoader({
      backend, capability: ACCOUNT_CAPABILITY, operationLockFile, createIfMissing: false,
      generateSecret: () => { assert.fail("an uploader must not generate an observation root"); },
    });
    const result = await load();
    assert.deepEqual(result, stored);
    assert.deepEqual(backend.calls, [["read", ACCOUNT_CAPABILITY]]);
    await assert.rejects(readFile(operationLockFile), { code: "ENOENT" });
    result?.fill(0);
  }
  const selection = selectProductionAccountObservationSecret({
    platform: "darwin", architecture: "arm64", createIfMissing: false,
    operationLockFile: join(root, "production-operation.lock"),
    createKeychainBackend: () => ({ async read() { return null; } }),
  });
  assert.equal(await selection.loadAccountObservationSecret(), null);
});

test("account observation operation lease rejects concurrent creation without persisting a secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-usagemonitor-account-concurrent-"));
  const lock = join(root, "state", "account-operation.lock");
  const secret = Buffer.alloc(32, 72);
  let releaseRead;
  let readStarted;
  const release = new Promise((resolve) => { releaseRead = resolve; });
  const started = new Promise((resolve) => { readStarted = resolve; });
  let firstRead = true;
  const backend = memoryBackend(secret);
  const baseRead = backend.read;
  backend.read = async (...args) => {
    if (firstRead) {
      firstRead = false;
      readStarted();
      await release;
    }
    return baseRead(...args);
  };
  try {
    const load = createAccountObservationSecretLoader({ backend, capability: ACCOUNT_CAPABILITY, operationLockFile: lock });
    const first = load();
    await started;
    const lockContents = await readFile(lock, "utf8");
    assert.equal(lockContents.includes(secret.toString("base64url")), false);
    await assert.rejects(
      load(),
      (error) => error instanceof AccountObservationSecretError
        && error.code === "account_observation_credential_locked"
        && error.message === "Account observation credential is unavailable",
    );
    releaseRead();
    assert.deepEqual(await first, secret);
    await assert.rejects(readFile(lock), { code: "ENOENT" });
  } finally {
    releaseRead?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("account observation operation lease recovers only a sufficiently old dead-owner crash residue", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-usagemonitor-account-stale-lock-"));
  const lock = join(root, "state", "account-operation.lock");
  const now = Date.parse("2026-07-25T12:00:00.000Z");
  const staleAt = new Date(now - 10_000).toISOString();
  const secret = Buffer.alloc(32, 87);
  try {
    await mkdir(join(root, "state"), { recursive: true, mode: 0o700 });
    await writeFile(lock, operationLockContent(999_999, staleAt), { mode: 0o600 });
    const load = createAccountObservationSecretLoader({
      backend: memoryBackend(secret),
      capability: ACCOUNT_CAPABILITY,
      operationLockFile: lock,
      clock: () => now,
      processExists: () => false,
      staleLockMilliseconds: 1_000,
    });
    assert.deepEqual(await load(), secret);
    await assert.rejects(readFile(lock), { code: "ENOENT" });

    await writeFile(lock, operationLockContent(999_999, new Date(now - 100).toISOString()), { mode: 0o600 });
    await assert.rejects(load(), (error) => error.code === "account_observation_credential_locked");
    assert.match(await readFile(lock, "utf8"), /account-observation-operation-v1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty and partial crash-before-write locks are bounded while recent and recovered when stale", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-usagemonitor-account-incomplete-lock-"));
  const state = join(root, "state");
  const lock = join(state, "account-operation.lock");
  const now = Date.parse("2026-07-25T12:00:00.000Z");
  const secret = Buffer.alloc(32, 90);
  const load = createAccountObservationSecretLoader({
    backend: memoryBackend(secret),
    capability: ACCOUNT_CAPABILITY,
    operationLockFile: lock,
    clock: () => now,
    processExists: () => false,
    staleLockMilliseconds: 1_000,
  });
  try {
    await mkdir(state, { recursive: true, mode: 0o700 });
    for (const incomplete of [
      "",
      '{"schemaVersion":"account-observation-operation-v1","processId":',
    ]) {
      await writeFile(lock, incomplete, { mode: 0o600 });
      await utimes(lock, new Date(now - 100), new Date(now - 100));
      await assert.rejects(load(), (error) => error.code === "account_observation_credential_locked");
      assert.equal(await readFile(lock, "utf8"), incomplete);

      await utimes(lock, new Date(now - 10_000), new Date(now - 10_000));
      assert.deepEqual(await load(), secret);
      await assert.rejects(readFile(lock), { code: "ENOENT" });
    }

    await writeFile(lock, "not-a-plausible-partial-lock", { mode: 0o600 });
    await utimes(lock, new Date(now - 10_000), new Date(now - 10_000));
    await assert.rejects(load(), (error) => error.code === "account_observation_credential_unavailable");
    assert.equal(await readFile(lock, "utf8"), "not-a-plausible-partial-lock");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale incomplete-lock recovery never removes a newly replaced active lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-usagemonitor-account-incomplete-replacement-"));
  const state = join(root, "state");
  const lock = join(state, "account-operation.lock");
  const staged = join(state, "active-replacement.lock");
  const now = Date.parse("2026-07-25T12:00:00.000Z");
  const active = operationLockContent(333_333, new Date(now).toISOString());
  let replaced = false;
  try {
    await mkdir(state, { recursive: true, mode: 0o700 });
    await writeFile(lock, "", { mode: 0o600 });
    await utimes(lock, new Date(now - 10_000), new Date(now - 10_000));
    await writeFile(staged, active, { mode: 0o600 });
    const load = createAccountObservationSecretLoader({
      backend: memoryBackend(Buffer.alloc(32, 91)),
      capability: ACCOUNT_CAPABILITY,
      operationLockFile: lock,
      clock: () => now,
      processExists: (pid) => pid === 333_333,
      staleLockMilliseconds: 1_000,
      async operationHook(point) {
        if (!replaced && point === "before-stale-lock-removal") {
          replaced = true;
          await rename(staged, lock);
        }
      },
    });
    await assert.rejects(load(), (error) => error.code === "account_observation_credential_locked");
    assert.equal(await readFile(lock, "utf8"), active);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("account observation stale-lock recovery does not remove a replacement or unsafe residue", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-usagemonitor-account-lock-replacement-"));
  const state = join(root, "state");
  const lock = join(state, "account-operation.lock");
  const staged = join(state, "replacement.lock");
  const now = Date.parse("2026-07-25T12:00:00.000Z");
  const staleAt = new Date(now - 10_000).toISOString();
  const replacement = operationLockContent(222_222, staleAt);
  try {
    await mkdir(state, { recursive: true, mode: 0o700 });
    await writeFile(lock, operationLockContent(111_111, staleAt), { mode: 0o600 });
    await writeFile(staged, replacement, { mode: 0o600 });
    let replaced = false;
    const load = createAccountObservationSecretLoader({
      backend: memoryBackend(Buffer.alloc(32, 88)),
      capability: ACCOUNT_CAPABILITY,
      operationLockFile: lock,
      clock: () => now,
      processExists: (pid) => pid === 222_222,
      staleLockMilliseconds: 1_000,
      async operationHook(point) {
        if (!replaced && point === "before-stale-lock-removal") {
          replaced = true;
          await rename(staged, lock);
        }
      },
    });
    await assert.rejects(load(), (error) => error.code === "account_observation_credential_locked");
    assert.equal(await readFile(lock, "utf8"), replacement);

    if (process.platform !== "win32") {
      await chmod(lock, 0o644);
      await assert.rejects(load(), (error) => error.code === "account_observation_credential_unavailable");
      assert.equal(await readFile(lock, "utf8"), replacement);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent stale-lock reapers cannot remove the newly elected active lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-usagemonitor-account-lock-election-"));
  const state = join(root, "state");
  const lock = join(state, "account-operation.lock");
  const now = Date.parse("2026-07-25T12:00:00.000Z");
  let releaseFirst;
  let signalStaleRemoved;
  let releaseSecond;
  let signalSecondAcquired;
  const firstMayContinue = new Promise((resolve) => { releaseFirst = resolve; });
  const staleRemoved = new Promise((resolve) => { signalStaleRemoved = resolve; });
  const secondMayContinue = new Promise((resolve) => { releaseSecond = resolve; });
  const secondAcquired = new Promise((resolve) => { signalSecondAcquired = resolve; });
  let staleRemovalHooks = 0;
  let acquisitionHooks = 0;
  const options = {
    backend: memoryBackend(Buffer.alloc(32, 89)),
    capability: ACCOUNT_CAPABILITY,
    operationLockFile: lock,
    clock: () => now,
    processExists: () => false,
    staleLockMilliseconds: 1_000,
    async operationHook(point) {
      if (point === "after-stale-lock-removal" && staleRemovalHooks++ === 0) {
        signalStaleRemoved();
        await firstMayContinue;
      }
      if (point === "after-operation-lock-acquired" && acquisitionHooks++ === 0) {
        signalSecondAcquired();
        await secondMayContinue;
      }
    },
  };
  try {
    await mkdir(state, { recursive: true, mode: 0o700 });
    await writeFile(lock, operationLockContent(999_999, new Date(now - 10_000).toISOString()), { mode: 0o600 });
    const first = createAccountObservationSecretLoader(options)();
    await staleRemoved;
    const second = createAccountObservationSecretLoader(options)();
    await secondAcquired;
    releaseFirst();
    await assert.rejects(first, (error) => error.code === "account_observation_credential_locked");
    assert.match(await readFile(lock, "utf8"), /account-observation-operation-v1/);
    releaseSecond();
    assert.deepEqual(await second, Buffer.alloc(32, 89));
    await assert.rejects(readFile(lock), { code: "ENOENT" });
  } finally {
    releaseFirst?.();
    releaseSecond?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("backend, malformed, and readback failures collapse to fixed content-free errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-usagemonitor-account-failure-"));
  const canary = "DO-NOT-LEAK-account-backend";
  try {
    for (const backend of [
      {
        async read() { throw new Error(canary); },
        async createIfMissing() { return "created"; },
      },
      {
        async read() { return new Uint8Array(32); },
        async createIfMissing() { return "created"; },
      },
      {
        reads: 0,
        async read() { this.reads += 1; return this.reads === 1 ? null : Buffer.alloc(32, 99); },
        async createIfMissing() { return "created"; },
      },
    ]) {
      const lock = join(root, `state-${Math.random().toString(16).slice(2)}`, "operation.lock");
      const load = createAccountObservationSecretLoader({
        backend,
        capability: ACCOUNT_CAPABILITY,
        operationLockFile: lock,
        generateSecret: () => Buffer.alloc(32, 73),
      });
      await assert.rejects(load(), (error) => {
        assert.equal(error instanceof AccountObservationSecretError, true);
        assert.equal(error.message, "Account observation credential is unavailable");
        assert.equal(`${error.stack}\n${JSON.stringify(error)}`.includes(canary), false);
        return true;
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed backend and generated buffers are erased before failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-usagemonitor-account-zeroize-"));
  const malformedStored = Buffer.alloc(31, 91);
  const malformedGenerated = Buffer.alloc(31, 92);
  try {
    const storedLoader = createAccountObservationSecretLoader({
      backend: {
        async read() { return malformedStored; },
        async createIfMissing() { return "created"; },
      },
      capability: ACCOUNT_CAPABILITY,
      operationLockFile: join(root, "stored.lock"),
    });
    await assert.rejects(
      storedLoader(),
      (error) => error.code === "account_observation_credential_unavailable",
    );
    assert.deepEqual(malformedStored, Buffer.alloc(31));

    const generatedLoader = createAccountObservationSecretLoader({
      backend: {
        async read() { return null; },
        async createIfMissing() { return "created"; },
      },
      capability: ACCOUNT_CAPABILITY,
      operationLockFile: join(root, "generated.lock"),
      generateSecret: () => malformedGenerated,
    });
    await assert.rejects(
      generatedLoader(),
      (error) => error.code === "account_observation_credential_unavailable",
    );
    assert.deepEqual(malformedGenerated, Buffer.alloc(31));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("locked and migration-required Keychain states remain distinct and content-free", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-usagemonitor-account-keychain-locked-"));
  const canary = "DO-NOT-LEAK-native-keychain-lock";
  try {
    for (const [upstreamCode, expectedCode] of [
      ["export_identity_keychain_locked", "account_observation_credential_locked"],
      [
        "export_identity_keychain_migration_required",
        "account_observation_credential_migration_required",
      ],
    ]) {
      const backend = {
        async read() {
          const error = new Error(canary);
          error.code = upstreamCode;
          throw error;
        },
        async createIfMissing() { return "created"; },
      };
      const load = createAccountObservationSecretLoader({
        backend,
        capability: ACCOUNT_CAPABILITY,
        operationLockFile: join(root, `${expectedCode}.lock`),
      });
      await assert.rejects(load(), (error) => {
        assert.equal(error.code, expectedCode);
        assert.equal(error.message, "Account observation credential is unavailable");
        assert.equal(`${error.stack}\n${JSON.stringify(error)}`.includes(canary), false);
        return true;
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const architecture of ["arm64", "x64"]) {
  test(`macOS ${architecture} account selection preserves the observation secret and rejects export identity`, async () => {
    const root = await mkdtemp(join(tmpdir(), "app-usagemonitor-account-production-"));
    const backend = memoryBackend(Buffer.alloc(32, 74));
    const prior = process.env.APP_USAGEMONITOR_ACCOUNT_HMAC_KEY;
    process.env.APP_USAGEMONITOR_ACCOUNT_HMAC_KEY = "legacy-environment-canary";
    try {
      const selected = selectProductionAccountObservationSecret({
        platform: "darwin",
        architecture,
        operationLockFile: join(root, "operation.lock"),
        createKeychainBackend: () => backend,
      });
      assert.equal(selected.mode, "macos_keychain_account_observation");
      assert.deepEqual(await selected.loadAccountObservationSecret(), Buffer.alloc(32, 74));
      assert.equal(backend.calls.every(([, capability]) => capability === ACCOUNT_CAPABILITY), true);

      assert.throws(
        () => selectProductionAccountObservationSecret({
          platform: "darwin",
          architecture,
          createKeychainBackend: () => backend,
          keychainCapability: EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity,
        }),
        (error) => error.code === "ACCOUNT_OBSERVATION_PRODUCTION_BACKEND_INVALID",
      );
    } finally {
      if (prior === undefined) delete process.env.APP_USAGEMONITOR_ACCOUNT_HMAC_KEY;
      else process.env.APP_USAGEMONITOR_ACCOUNT_HMAC_KEY = prior;
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("account selection rejects unknown macOS architectures before constructing a credential backend", () => {
  for (const architecture of ["ia32", "x86_64", "arm", "", null]) {
    let constructions = 0;
    assert.throws(() => selectProductionAccountObservationSecret({
      platform: "darwin",
      architecture,
      createKeychainBackend() { constructions += 1; },
    }), { code: "ACCOUNT_OBSERVATION_PRODUCTION_BACKEND_UNAVAILABLE" });
    assert.equal(constructions, 0);
  }
});

test("Intel account selection preserves a broker failure without legacy or file fallback", () => {
  let constructions = 0;
  const canary = "PRIVATE-INTEL-BROKER-FAILURE";
  assert.throws(() => selectProductionAccountObservationSecret({
    platform: "darwin",
    architecture: "x64",
    createKeychainBackend() {
      constructions += 1;
      throw new Error(canary);
    },
  }), (error) => error.code === "ACCOUNT_OBSERVATION_PRODUCTION_BACKEND_UNAVAILABLE"
    && !`${error.stack}\n${JSON.stringify(error)}`.includes(canary));
  assert.equal(constructions, 1);
});

test("Windows x64 account-observation production selection remains fail closed", () => {
  let constructions = 0;
  assert.throws(
    () => selectProductionAccountObservationSecret({
      platform: "win32",
      architecture: "x64",
      createKeychainBackend() {
        constructions += 1;
        return memoryBackend(Buffer.alloc(32, 76));
      },
    }),
    (error) => error.code === "ACCOUNT_OBSERVATION_PRODUCTION_BACKEND_UNAVAILABLE",
  );
  assert.equal(constructions, 0);
});

test("Windows native account selection remains available when the parent IPC factory is omitted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "windows-native-account-observation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const readiness = createWindowsProductionReadinessAttestation({
    qualifiedAt: "2026-09-08T00:00:00.000Z",
    qualificationReceipt: "windows-qualified-test-receipt",
    credentialMutexSafe: true,
    durableAuditSafe: true,
    protectedStatePathsSafe: true,
    authenticatedBindingSafe: true,
    bindingProvenance: {
      contractVersion: "windows-binding-provenance-v1",
      status: "qualified",
      source: "audited-signed-native-binding",
    },
  });
  let constructions = 0;
  const nativeBackend = {
    productionSafe: true,
    crossProcessSafe: true,
    auditDurable: true,
    auditFilesystemProtected: true,
    startupRecoveryComplete: true,
    bindingProvenanceAuthenticated: true,
    async read(capability) {
      assert.equal(capability, ACCOUNT_CAPABILITY);
      return Buffer.alloc(32, 77);
    },
    async createIfMissing() { return "existing"; },
    async replaceExact() { return "replaced"; },
    async deleteExact() { return "deleted"; },
    async withOperationLease(_capability, _operation, callback) { return callback({}); },
  };
  const selection = selectProductionAccountObservationSecret({
    platform: "win32",
    architecture: "x64",
    operationLockFile: join(root, "operation.lock"),
    createIfMissing: false,
    windowsReadiness: readiness,
    createWindowsBackend() {
      constructions += 1;
      return nativeBackend;
    },
  });
  assert.equal(selection.mode, "windows_credential_manager_account_observation");
  assert.deepEqual(await selection.loadAccountObservationSecret(), Buffer.alloc(32, 77));
  assert.equal(constructions, 1);
});

test("Windows parent IPC account selection reads an existing upload root without a child lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "windows-parent-ipc-account-observation-"));
  const lock = join(root, "child-operation.lock");
  const broker = windowsObservationBrokerChannel(Buffer.alloc(32, 83));
  t.after(() => {
    broker.dispose();
    return rm(root, { recursive: true, force: true });
  });
  let nativeConstructions = 0;
  let keychainConstructions = 0;
  const selection = selectProductionAccountObservationSecret({
    platform: "win32",
    architecture: "x64",
    operationLockFile: lock,
    createIfMissing: false,
    createWindowsBrokerBackend: () => createWindowsAccountObservationBrokerBackendFromEnvironment({
      [WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_ENV]: WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER,
    }, broker.channel),
    createWindowsBackend() { nativeConstructions += 1; throw new Error("native fallback"); },
    createKeychainBackend() { keychainConstructions += 1; throw new Error("Keychain fallback"); },
  });
  assert.equal(selection.mode, "windows_parent_ipc_account_observation");
  const observed = await selection.loadAccountObservationSecret();
  assert.deepEqual(observed, Buffer.alloc(32, 83));
  observed.fill(0);
  assert.deepEqual(broker.operations, ["read"]);
  assert.equal(nativeConstructions, 0);
  assert.equal(keychainConstructions, 0);
  await assert.rejects(readFile(lock), { code: "ENOENT" });
});

test("Windows parent IPC account selection preserves unknown absence and uses only parent-owned creation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "windows-parent-ipc-account-unknown-"));
  const lock = join(root, "child-operation.lock");
  const broker = windowsObservationBrokerChannel();
  t.after(() => {
    broker.dispose();
    return rm(root, { recursive: true, force: true });
  });
  const createWindowsBrokerBackend = () => createWindowsAccountObservationBrokerBackendFromEnvironment({
    [WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_ENV]: WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER,
  }, broker.channel);
  let nativeConstructions = 0;
  let keychainConstructions = 0;
  const nativeFallback = () => {
    nativeConstructions += 1;
    throw new Error("native fallback");
  };
  const unknown = selectProductionAccountObservationSecret({
    platform: "win32",
    architecture: "x64",
    operationLockFile: lock,
    createIfMissing: false,
    createWindowsBrokerBackend,
    createWindowsBackend: nativeFallback,
    createKeychainBackend() {
      keychainConstructions += 1;
      throw new Error("Keychain fallback");
    },
  });
  assert.equal(await unknown.loadAccountObservationSecret(), null);

  const creating = selectProductionAccountObservationSecret({
    platform: "win32",
    architecture: "x64",
    operationLockFile: lock,
    createWindowsBrokerBackend,
    createWindowsBackend: nativeFallback,
    createKeychainBackend() {
      keychainConstructions += 1;
      throw new Error("Keychain fallback");
    },
  });
  const created = await creating.loadAccountObservationSecret();
  assert.equal(Buffer.isBuffer(created), true);
  assert.equal(created.byteLength, 32);
  created.fill(0);
  assert.deepEqual(broker.operations, ["read", "read", "create_if_missing", "read"]);
  assert.equal(nativeConstructions, 0);
  assert.equal(keychainConstructions, 0);
  await assert.rejects(readFile(lock), { code: "ENOENT" });
});

test("Windows parent IPC account selection refuses absent, malformed, and untrusted brokers without fallback", async () => {
  const configurations = [
    () => null,
    () => createWindowsAccountObservationBrokerBackendFromEnvironment({
      [WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_ENV]: "other",
    }),
    () => createWindowsAccountObservationBrokerBackendFromEnvironment({
      [WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_ENV]: WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER,
      USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_BROKER_FD: "4",
    }),
    () => ({ async read() { return null; }, async createIfMissing() { return "created"; } }),
    () => { throw new Error("private parent IPC failure"); },
  ];
  for (const createWindowsBrokerBackend of configurations) {
    let nativeConstructions = 0;
    let keychainConstructions = 0;
    let selection = null;
    try {
      selection = selectProductionAccountObservationSecret({
        platform: "win32",
        architecture: "x64",
        createWindowsBrokerBackend,
        createWindowsBackend() { nativeConstructions += 1; throw new Error("native fallback"); },
        createKeychainBackend() { keychainConstructions += 1; throw new Error("Keychain fallback"); },
      });
    } catch (error) {
      assert.equal(error.code, "ACCOUNT_OBSERVATION_PRODUCTION_BACKEND_UNAVAILABLE");
      assert.equal(`${error.stack}\n${JSON.stringify(error)}`.includes("private parent IPC failure"), false);
    }
    if (selection !== null) {
      await assert.rejects(selection.loadAccountObservationSecret(), (error) =>
        error.code === "account_observation_credential_unavailable");
    }
    assert.equal(nativeConstructions, 0);
    assert.equal(keychainConstructions, 0);
  }
});

test("Linux account selection preserves generic broker compatibility and read-only absence", async () => {
  const root = await mkdtemp(join(tmpdir(), "linux-account-broker-selection-"));
  const backend = { ...memoryBackend(Buffer.alloc(32, 81)),
    replaceExact: async () => "replaced", deleteExact: async () => "deleted",
    describe: () => ({ backend: "linux_secret_service_broker", status: "available" }) };
  try {
    const selection = selectProductionAccountObservationSecret({
      platform: "linux", architecture: "x64", operationLockFile: join(root, "account.lock"),
      createLinuxBackend: () => backend, createIfMissing: false,
      createKeychainBackend: () => { throw new Error("Mac fallback must not run"); },
    });
    assert.equal(selection.mode, "linux_secret_service_broker_account_observation");
    const observed = await selection.loadAccountObservationSecret();
    assert.deepEqual(observed, Buffer.alloc(32, 81)); observed.fill(0);
    assert.equal(backend.calls.every(([, capability]) => capability === ACCOUNT_CAPABILITY), true);
    assert.equal(backend.calls.some(([operation]) => operation === "createIfMissing"), false);
    const absent = { ...backend, read: async () => null,
      createIfMissing: () => { throw new Error("Read-only selection cannot create"); } };
    const readOnly = selectProductionAccountObservationSecret({
      platform: "linux", architecture: "x64", operationLockFile: join(root, "absent.lock"),
      createLinuxBackend: () => absent, createIfMissing: false,
    });
    assert.equal(await readOnly.loadAccountObservationSecret(), null);
    const locked = selectProductionAccountObservationSecret({
      platform: "linux", architecture: "x64", operationLockFile: join(root, "locked.lock"),
      createLinuxBackend: () => ({ ...backend,
        read: async () => { throw Object.assign(new Error("private native message"), { code: "linux_secret_service_broker_locked" }); },
      }),
    });
    await assert.rejects(locked.loadAccountObservationSecret(), (error) =>
      error.code === "account_observation_credential_locked" && !error.stack.includes("private native message"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Linux account selection accepts the narrow observation backend contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "linux-account-narrow-selection-"));
  const narrow = memoryBackend();
  const existingOnlyCalls = [];
  const existingOnly = {
    async read(capability) {
      existingOnlyCalls.push(capability);
      return Buffer.alloc(32, 82);
    },
  };
  try {
    const creating = selectProductionAccountObservationSecret({
      platform: "linux", architecture: "x64", operationLockFile: join(root, "create.lock"),
      createLinuxBackend: () => narrow,
    });
    const created = await creating.loadAccountObservationSecret();
    assert.equal(created.byteLength, 32);
    created.fill(0);
    assert.deepEqual(narrow.calls.map(([operation, capability]) => [operation, capability]), [
      ["read", ACCOUNT_CAPABILITY],
      ["createIfMissing", ACCOUNT_CAPABILITY],
      ["read", ACCOUNT_CAPABILITY],
    ]);

    const existingOnlySelection = selectProductionAccountObservationSecret({
      platform: "linux", architecture: "x64", createIfMissing: false,
      operationLockFile: join(root, "existing-only.lock"),
      createLinuxBackend: () => existingOnly,
    });
    const existing = await existingOnlySelection.loadAccountObservationSecret();
    assert.deepEqual(existing, Buffer.alloc(32, 82));
    existing.fill(0);
    assert.deepEqual(existingOnlyCalls, [ACCOUNT_CAPABILITY]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Linux account selection refuses unsupported contracts, capabilities, and architectures before fallback", () => {
  for (const createLinuxBackend of [
    null,
    () => null,
    () => ({ get() {}, set() {}, delete() {} }),
    () => ({ async read() { return null; } }),
    () => ({ async createIfMissing() { return "created"; } }),
    () => { throw new Error("private-native-detail"); },
  ]) {
    assert.throws(() => selectProductionAccountObservationSecret({
      platform: "linux", architecture: "x64", createLinuxBackend,
    }), (error) => error.code === "ACCOUNT_OBSERVATION_PRODUCTION_BACKEND_UNAVAILABLE"
      && !error.stack.includes("private-native-detail"));
  }
  for (const keychainCapability of [EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity, {}]) {
    assert.throws(() => selectProductionAccountObservationSecret({
      platform: "linux", architecture: "x64", keychainCapability,
      createLinuxBackend: () => { throw new Error("Must refuse before construction"); },
    }), { code: "ACCOUNT_OBSERVATION_PRODUCTION_BACKEND_INVALID" });
  }
  for (const architecture of ["arm64", "ia32", "x86_64", "", null]) {
    let constructions = 0;
    assert.throws(() => selectProductionAccountObservationSecret({
      platform: "linux", architecture,
      createLinuxBackend() { constructions += 1; return memoryBackend(); },
    }), { code: "ACCOUNT_OBSERVATION_PRODUCTION_BACKEND_UNAVAILABLE" });
    assert.equal(constructions, 0);
  }
});

test("development account secret injection is explicit and returns disposable copies", async () => {
  const original = Buffer.alloc(32, 75);
  const load = createDevelopmentAccountObservationSecretLoader(original);
  original.fill(0);
  const first = await load();
  const second = await load();
  assert.notDeepEqual(first, original);
  assert.deepEqual(first, second);
  first.fill(0);
  assert.notDeepEqual(first, second);
});

function rawAccountSnapshot() {
  return {
    account: { account: { email: "private.owner@example.test", planType: "pro" } },
    rateLimits: { rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 123 },
      secondary: null,
      planType: "pro",
    } },
    accountUsage: { dailyUsageBuckets: [] },
  };
}

test("doctor, register, capture, and collector CLI paths share the injected production loader", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-usagemonitor-account-cli-"));
  const secret = Buffer.alloc(32, 77);
  let selections = 0;
  let credentialLoads = 0;
  const selectAccountObservationSecret = () => {
    selections += 1;
    return {
      mode: "test_injected",
      loadAccountObservationSecret: async () => {
        credentialLoads += 1;
        return Buffer.from(secret);
      },
    };
  };
  const dependencies = {
    selectAccountObservationSecret,
    inspectCodexBinaryDiagnostic: async () => ({
      schemaVersion: "codex-binary-diagnostic-v0.1",
      source: "chatgpt_bundled",
      versionStatus: "available",
      version: "0.149.1",
    }),
    readAccountSnapshot: async () => rawAccountSnapshot(),
    sanitizeAccountSnapshot: sanitizeCodexAccountSnapshotWithSecretLoader,
  };
  const lines = [];
  const originalLog = console.log;
  console.log = (...values) => { lines.push(values.join(" ")); };
  try {
    await run(["doctor"], dependencies);
    assert.match(lines.join("\n"), /Codex binary: ChatGPT bundled \(0\.149\.1\)/);
    assert.match(lines.join("\n"), /Account scope: available/);
    assert.equal(lines.join("\n").includes("private.owner"), false);
    assert.equal(lines.join("\n").includes(secret.toString("base64url")), false);

    lines.length = 0;
    let capturedScope;
    await run(["capture", "--data-file", join(root, "capture.jsonl")], {
      ...dependencies,
      async captureObservation(options) {
        const snapshot = await options.sanitizeSnapshot(rawAccountSnapshot(), "2026-07-23T00:00:00.000Z");
        capturedScope = snapshot.accountScope;
        return { schemaVersion: "test", kind: "test", windows: [], accountScope: snapshot.accountScope };
      },
    });
    assert.equal(capturedScope.status, "available");

    let collectorLoader;
    await run(["collect-once", "--state-file", join(root, "collector.sqlite")], {
      ...dependencies,
      async runCollectorOnceCommand(options) {
        collectorLoader = options.loadAccountObservationSecret;
        return {
          rolloutRecordsWritten: 0,
          refresh: { attempted: false, errorCode: null, recordWritten: false },
          stateFile: join(root, "collector.sqlite"),
        };
      },
    });
    assert.deepEqual(await collectorLoader(), secret);
    assert.equal(selections, 3);
    assert.ok(credentialLoads >= 3);
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor reports credential recovery states as distinct content-free codes", async () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (...values) => { lines.push(values.join(" ")); };
  try {
    for (const [code, expected] of [
      ["account_observation_credential_locked", "credential_locked"],
      [
        "account_observation_credential_migration_required",
        "credential_migration_required",
      ],
      ["account_observation_credential_unavailable", "credential_unavailable"],
    ]) {
      lines.length = 0;
      await run(["doctor"], {
        selectAccountObservationSecret: () => ({
          mode: "test_injected",
          async loadAccountObservationSecret() {
            const error = new Error("DO-NOT-LEAK-doctor-credential");
            error.code = code;
            throw error;
          },
        }),
        inspectCodexBinaryDiagnostic: async () => ({
          schemaVersion: "codex-binary-diagnostic-v0.1",
          source: "path",
          versionStatus: "unavailable",
          version: null,
        }),
        readAccountSnapshot: async () => rawAccountSnapshot(),
        sanitizeAccountSnapshot: sanitizeCodexAccountSnapshotWithSecretLoader,
      });
      assert.match(lines.join("\n"), new RegExp(`Account scope: unavailable \\(${expected}\\)`));
      assert.equal(lines.join("\n").includes("DO-NOT-LEAK"), false);
      assert.equal(lines.join("\n").includes("private.owner"), false);
    }
  } finally {
    console.log = originalLog;
  }
});
