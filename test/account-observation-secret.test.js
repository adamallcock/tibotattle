import test from "node:test";
import assert from "node:assert/strict";
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

test("a locked Keychain backend remains distinct without exposing its native error", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-usagemonitor-account-keychain-locked-"));
  const canary = "DO-NOT-LEAK-native-keychain-lock";
  const backend = {
    async read() {
      const error = new Error(canary);
      error.code = "export_identity_keychain_locked";
      throw error;
    },
    async createIfMissing() { return "created"; },
  };
  try {
    const load = createAccountObservationSecretLoader({
      backend,
      capability: ACCOUNT_CAPABILITY,
      operationLockFile: join(root, "operation.lock"),
    });
    await assert.rejects(load(), (error) => {
      assert.equal(error.code, "account_observation_credential_locked");
      assert.equal(error.message, "Account observation credential is unavailable");
      assert.equal(`${error.stack}\n${JSON.stringify(error)}`.includes(canary), false);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production selection cannot reuse export identity and never reads the legacy environment variable", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-usagemonitor-account-production-"));
  const backend = memoryBackend(Buffer.alloc(32, 74));
  const prior = process.env.APP_USAGEMONITOR_ACCOUNT_HMAC_KEY;
  process.env.APP_USAGEMONITOR_ACCOUNT_HMAC_KEY = "legacy-environment-canary";
  try {
    const selected = selectProductionAccountObservationSecret({
      platform: "darwin",
      architecture: "arm64",
      operationLockFile: join(root, "operation.lock"),
      createKeychainBackend: () => backend,
    });
    assert.equal(selected.mode, "macos_keychain_account_observation");
    assert.deepEqual(await selected.loadAccountObservationSecret(), Buffer.alloc(32, 74));
    assert.equal(backend.calls.every(([, capability]) => capability === ACCOUNT_CAPABILITY), true);

    assert.throws(
      () => selectProductionAccountObservationSecret({
        platform: "darwin",
        architecture: "arm64",
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
    readAccountSnapshot: async () => rawAccountSnapshot(),
    sanitizeAccountSnapshot: sanitizeCodexAccountSnapshotWithSecretLoader,
  };
  const lines = [];
  const originalLog = console.log;
  console.log = (...values) => { lines.push(values.join(" ")); };
  try {
    await run(["doctor"], dependencies);
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

test("doctor reports locked and unavailable account credentials as distinct content-free states", async () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (...values) => { lines.push(values.join(" ")); };
  try {
    for (const [code, expected] of [
      ["account_observation_credential_locked", "credential_locked"],
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
