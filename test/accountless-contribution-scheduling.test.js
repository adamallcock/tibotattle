import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccountlessContributionScheduler } from "../src/application/index.js";
import { attachAccountlessParentChannel, createAccountlessChildChannel } from "../src/platform/index.js";
import { ensureContributionDeviceCapability } from "../src/contribution-device-capability.js";
import { createDesktopSharingCoordinator } from "../apps/electron/desktop-sharing.js";
import { createCompanionSupervisor } from "../apps/electron/companion-supervisor.js";
import { fileURLToPath } from "node:url";

const origin = "http://127.0.0.1:18765";
const ready = { available: true, current: true, enabled: true,
  policyVersion: "accountless-opt-out-v1", destinationOrigin: origin };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function timers() {
  const pending = new Map();
  let id = 0;
  return { pending, setTimer(fn, delay) { pending.set(++id, { fn, delay }); return id; },
    clearTimer(id) { pending.delete(id); } };
}
function channels() {
  const parent = new EventEmitter();
  const child = new EventEmitter();
  for (const [from, to] of [[parent, child], [child, parent]]) {
    from.connected = true;
    from.send = (message, callback) => { queueMicrotask(() => { to.emit("message", structuredClone(message)); callback?.(); }); };
  }
  return { parent, child };
}
function vault() {
  let secret = null;
  return {
    async read() { return secret === null ? null : Buffer.from(secret); },
    async createIfMissing(value) { if (secret !== null) return "existing"; secret = Buffer.from(value); return "created"; },
    async deleteExact(value) { if (secret?.equals(value)) { secret.fill(0); secret = null; return "deleted"; } return "mismatch"; },
  };
}

test("fresh default schedules once; durable opt-out stops and survives a restart", async () => {
  let text = null;
  const storage = { load: async () => text, save: async (value) => { text = value; } };
  let scheduler;
  const policy = createDesktopSharingCoordinator({ backend: storage, installationState: "fresh", destinationOrigin: origin,
    onAuthorizationChanged: () => scheduler?.preferenceChanged() });
  await policy.initialize();
  let calls = 0;
  const clock = timers();
  scheduler = createAccountlessContributionScheduler({ origin, readPreference: policy.readAuthorization,
    runner: async () => { calls++; return { status: "complete", chunksUploaded: 1 }; }, ...clock });
  scheduler.start();
  await Promise.all([scheduler.runNow(), scheduler.runNow()]);
  assert.equal(calls, 1);
  assert.equal(scheduler.inspect().state, "up_to_date");
  await policy.setEnabled(false);
  await scheduler.runNow();
  assert.equal(calls, 1);
  assert.equal(scheduler.inspect().state, "off");
  await scheduler.stop();
  const restored = createDesktopSharingCoordinator({ backend: storage, installationState: "fresh", destinationOrigin: origin });
  assert.equal((await restored.initialize()).enabled, false);
  const restarted = createAccountlessContributionScheduler({ origin, readPreference: restored.readAuthorization,
    runner: async () => { calls++; }, ...timers() });
  restarted.start();
  await restarted.runNow();
  assert.equal(calls, 1);
  await restarted.stop();
});

test("partial uploads keep remaining work explicit until the next bounded pass", async () => {
  const clock = timers();
  let pass = 0;
  const scheduler = createAccountlessContributionScheduler({ origin,
    readPreference: async () => ready,
    runner: async () => (++pass === 1
      ? { status: "partial", chunksUploaded: 1, hasMore: true }
      : { status: "complete", chunksUploaded: 0, hasMore: false }), ...clock });
  scheduler.start();
  await scheduler.runNow();
  assert.equal(scheduler.inspect().state, "pending");
  const accepted = scheduler.inspect().lastAcceptedAt;
  assert.ok(accepted);
  assert.ok([...clock.pending.values()].some((item) => item.delay === 60_000));
  await scheduler.runNow();
  assert.equal(scheduler.inspect().state, "up_to_date");
  assert.equal(scheduler.inspect().lastAcceptedAt, accepted);
  await scheduler.stop();
});

test("preference change aborts enrollment/upload before waiting for durable persistence", async () => {
  let preference = ready;
  let observed;
  let finish;
  const scheduler = createAccountlessContributionScheduler({ origin,
    readPreference: async () => preference,
    runner: ({ signal }) => { observed = signal; return new Promise((resolve) => { finish = resolve; }); }, ...timers() });
  scheduler.start();
  const pass = scheduler.runNow();
  await tick();
  preference = { ...ready, enabled: false };
  scheduler.preferenceChanged();
  assert.equal(observed.aborted, true);
  finish({ status: "complete", chunksUploaded: 1 });
  await pass;
  assert.equal(scheduler.inspect().state, "off", "a late completion cannot overwrite opt-out");
  await scheduler.stop();
});

test("offline retries are bounded and terminal revocation does not spin", async () => {
  const clock = timers();
  let calls = 0;
  const scheduler = createAccountlessContributionScheduler({ origin, readPreference: async () => ready,
    runner: async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("offline"), { retryable: true });
      return { status: "failed", failure: { deviceUnavailable: true, retryable: false } };
    }, ...clock });
  scheduler.start();
  await scheduler.runNow();
  assert.equal(scheduler.inspect().state, "retry_wait");
  assert.ok([...clock.pending.values()].some((item) => item.delay === 60_000));
  await scheduler.runNow();
  assert.ok([...clock.pending.values()].some((item) => item.delay === 120_000));
  await scheduler.runNow();
  assert.equal(scheduler.inspect().state, "paused");
  await scheduler.stop();
  assert.equal(clock.pending.size, 0);
});

test("owned process channel carries only the installation credential and rejects off-state reads", async () => {
  const { parent, child } = channels();
  let preference = ready;
  let invalidated = 0;
  const host = attachAccountlessParentChannel({ channel: parent, readPreference: async () => preference, backend: vault() });
  const client = createAccountlessChildChannel({ channel: child, onInvalidated: () => invalidated++ });
  const secret = randomBytes(32);
  assert.deepEqual(await client.readPreference(), ready);
  assert.equal(await client.backend.createIfMissing({}, secret), "created");
  assert.deepEqual(await client.backend.read({}), secret);
  preference = { ...ready, enabled: false };
  host.invalidate();
  await tick();
  assert.equal(invalidated, 1);
  await assert.rejects(client.backend.read({}), { code: "contribution_device_credential_unavailable" });
  assert.equal((await client.readPreference()).enabled, false);
  secret.fill(0);
  client.dispose();
  host.dispose();
});

test("private-channel read errors retain only explicit retryable credential availability", async () => {
  const assertRead = async (upstream, retryable) => {
    const { parent, child } = channels();
    const host = attachAccountlessParentChannel({ channel: parent,
      readPreference: async () => ready,
      backend: { async read() { throw upstream; } } });
    const client = createAccountlessChildChannel({ channel: child });
    try {
      await assert.rejects(client.backend.read({}), (error) => error?.code === "contribution_device_credential_unavailable"
        && error.retryable === retryable);
    } finally {
      client.dispose();
      host.dispose();
    }
  };
  await assertRead(Object.assign(new Error("temporary provider unavailable"), {
    code: "contribution_device_credential_unavailable", retryable: true,
  }), true);
  await assertRead(Object.assign(new Error("corrupt protected credential"), {
    code: "contribution_device_credential_unavailable", retryable: false,
  }), false);
  await assertRead(Object.assign(new Error("unrecognized backend failure"), {
    code: "unexpected_backend_failure", retryable: true,
  }), false);
});

test("a status update is accepted while a credential read is pending", async () => {
  const { parent, child } = channels();
  let finishRead;
  const seen = [];
  const host = attachAccountlessParentChannel({ channel: parent,
    readPreference: async () => ready,
    backend: { read: () => new Promise((resolve, reject) => { finishRead = { resolve, reject }; }) },
    onStatus: (value) => seen.push(value.state) });
  const client = createAccountlessChildChannel({ channel: child });
  try {
    const read = client.backend.read({});
    await tick();
    await client.reportStatus({ state: "retry_wait", lastAcceptedAt: null, nextAttemptAt: null });
    assert.deepEqual(seen, ["retry_wait"]);
    finishRead.reject(Object.assign(new Error("temporary provider unavailable"), {
      code: "contribution_device_credential_unavailable", retryable: true,
    }));
    await assert.rejects(read, (error) => error?.code === "contribution_device_credential_unavailable"
      && error.retryable === true);
  } finally {
    client.dispose();
    host.dispose();
  }
});

test("server Retry-After remains the minimum delay after admission rejection", async () => {
  const clock = timers();
  const scheduler = createAccountlessContributionScheduler({ origin, readPreference: async () => ready,
    runner: async () => ({ status: "failed", failure: { retryable: true, retryAfterMilliseconds: 86_400_000 } }), ...clock });
  scheduler.start();
  await scheduler.runNow();
  assert.ok([...clock.pending.values()].some((timer) => timer.delay === 86_400_000));
  await scheduler.stop();
});

test("partial progress survives the private channel and a saved opt-out masks late status", async () => {
  let text = null;
  const coordinator = createDesktopSharingCoordinator({
    installationState: "fresh", destinationOrigin: origin,
    backend: { load: async () => text, save: async (value) => { text = value; } },
  });
  await coordinator.initialize();
  const { parent, child } = channels();
  const host = attachAccountlessParentChannel({ channel: parent,
    readPreference: coordinator.readAuthorization, backend: vault(),
    onStatus: coordinator.updateTransport });
  const client = createAccountlessChildChannel({ channel: child });
  try {
    await client.reportStatus({ state: "pending", lastAcceptedAt: null, nextAttemptAt: null });
    assert.equal((await coordinator.inspect()).transportStatus, "pending");
    await coordinator.setEnabled(false);
    await client.reportStatus({ state: "up_to_date", lastAcceptedAt: null, nextAttemptAt: null });
    assert.equal((await coordinator.inspect()).transportStatus, "off");
  } finally {
    client.dispose();
    host.dispose();
    coordinator.dispose();
  }
});

test("shutdown settles even when an injected runner ignores cancellation", async () => {
  let signal;
  const scheduler = createAccountlessContributionScheduler({ origin, readPreference: async () => ready,
    runner: (options) => { signal = options.signal; return new Promise(() => {}); }, ...timers() });
  scheduler.start();
  void scheduler.runNow();
  await tick();
  await scheduler.stop();
  assert.equal(signal.aborted, true);
  assert.equal(scheduler.inspect().state, "off");
});

test("malformed upload counts cannot manufacture a successful sharing timestamp", async () => {
  for (const chunksUploaded of ["1", -1, NaN, Infinity, 2001]) {
    const scheduler = createAccountlessContributionScheduler({ origin, readPreference: async () => ready,
      runner: async () => ({ status: "complete", chunksUploaded }), ...timers() });
    scheduler.start();
    await scheduler.runNow();
    assert.equal(scheduler.inspect().state, "retry_wait");
    assert.equal(scheduler.inspect().lastAcceptedAt, null);
    await scheduler.stop();
  }
});

test("opt-out fences a credential read whose result arrives after invalidation", async () => {
  const { parent, child } = channels();
  let finish;
  const host = attachAccountlessParentChannel({ channel: parent, readPreference: async () => ready,
    backend: { read: () => new Promise((resolve) => { finish = resolve; }) } });
  const client = createAccountlessChildChannel({ channel: child });
  const read = client.backend.read({});
  const denied = assert.rejects(read, { code: "contribution_device_credential_unavailable" });
  await tick();
  host.invalidate();
  await denied;
  const bytes = randomBytes(32);
  finish(bytes);
  await tick();
  assert.equal(bytes.every((value) => value === 0), true);
  client.dispose();
  host.dispose();
});

test("opt-out preserves the acknowledgement of an accepted local credential write", async () => {
  const { parent, child } = channels();
  let finish;
  let preference = ready;
  const host = attachAccountlessParentChannel({ channel: parent, readPreference: async () => preference,
    backend: { createIfMissing: () => new Promise((resolve) => { finish = resolve; }) } });
  const client = createAccountlessChildChannel({ channel: child });
  const operation = client.backend.createIfMissing({}, randomBytes(32));
  await tick();
  preference = { ...ready, enabled: false };
  host.invalidate();
  await tick();
  finish("created");
  assert.equal(await operation, "created");
  assert.equal((await client.readPreference()).enabled, false);
  client.dispose();
  host.dispose();
});

test("a lost create acknowledgement retains the binding and restart recovers the exact credential", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "accountless-channel-"));
  const stateFile = join(root, "accountless-device-binding-v1.json");
  let saved = null;
  let creates = 0;
  let beginCreate;
  let finishCreate;
  const started = new Promise((resolve) => { beginCreate = resolve; });
  const finish = new Promise((resolve) => { finishCreate = resolve; });
  const { parent, child } = channels();
  const host = attachAccountlessParentChannel({ channel: parent, readPreference: async () => ready,
    backend: {
      async read() { return saved === null ? null : Buffer.from(saved); },
      async createIfMissing(value) {
        creates += 1;
        beginCreate();
        await finish;
        saved = Buffer.from(value);
        return "created";
      },
      async deleteExact() { return "missing"; },
    } });
  const first = createAccountlessChildChannel({ channel: child, timeoutMilliseconds: 25 });
  t.after(async () => {
    saved?.fill(0);
    first.dispose();
    host.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const initial = ensureContributionDeviceCapability({
    backend: first.backend,
    origin,
    stateFile,
    generateDeviceId: () => "11111111-1111-4111-8111-111111111111",
    generateSecret: () => Buffer.alloc(32, 7),
    clock: () => Date.parse("2026-09-05T00:00:00.000Z"),
  });
  await started;
  await assert.rejects(initial, (error) => {
    assert.equal(error.code, "contribution_device_credential_mutation_uncertain");
    assert.equal(error.message, "Contribution device capability operation failed");
    return true;
  });
  await stat(stateFile);
  finishCreate();
  await tick();
  await tick();

  first.dispose();
  const restarted = createAccountlessChildChannel({ channel: child, timeoutMilliseconds: 25 });
  t.after(() => restarted.dispose());
  const recovered = await ensureContributionDeviceCapability({
    backend: restarted.backend,
    origin,
    stateFile,
    generateDeviceId: () => assert.fail("restart must not enroll a second credential"),
    generateSecret: () => assert.fail("restart must not generate a second secret"),
  });
  assert.equal(recovered.status, "existing");
  assert.equal(recovered.deviceId, "11111111-1111-4111-8111-111111111111");
  assert.equal(creates, 1);
});

test("an uncertain create that never saves remains bound and fails closed without another enrollment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "accountless-channel-"));
  const stateFile = join(root, "accountless-device-binding-v1.json");
  let creates = 0;
  let beginCreate;
  let finishCreate;
  const started = new Promise((resolve) => { beginCreate = resolve; });
  const finish = new Promise((resolve) => { finishCreate = resolve; });
  const { parent, child } = channels();
  const host = attachAccountlessParentChannel({ channel: parent, readPreference: async () => ready,
    backend: {
      async read() { return null; },
      async createIfMissing() {
        creates += 1;
        beginCreate();
        await finish;
        throw new Error("storage unavailable");
      },
      async deleteExact() { return "missing"; },
    } });
  const first = createAccountlessChildChannel({ channel: child, timeoutMilliseconds: 25 });
  t.after(async () => {
    first.dispose();
    host.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const initial = ensureContributionDeviceCapability({
    backend: first.backend,
    origin,
    stateFile,
    generateDeviceId: () => "22222222-2222-4222-8222-222222222222",
    generateSecret: () => Buffer.alloc(32, 8),
    clock: () => Date.parse("2026-09-05T00:00:00.000Z"),
  });
  await started;
  await assert.rejects(initial, { code: "contribution_device_credential_mutation_uncertain" });
  await stat(stateFile);
  finishCreate();
  await tick();
  await tick();

  first.dispose();
  const restarted = createAccountlessChildChannel({ channel: child, timeoutMilliseconds: 25 });
  t.after(() => restarted.dispose());
  await assert.rejects(ensureContributionDeviceCapability({
    backend: restarted.backend,
    origin,
    stateFile,
    generateDeviceId: () => assert.fail("restart must not enroll a second credential"),
    generateSecret: () => assert.fail("restart must not generate a second secret"),
  }), { code: "contribution_device_credential_missing" });
  assert.equal(creates, 1);
});

test("a disconnected dispatched credential write has a fixed uncertain outcome", async () => {
  let beginCreate;
  let finishCreate;
  const started = new Promise((resolve) => { beginCreate = resolve; });
  const finish = new Promise((resolve) => { finishCreate = resolve; });
  const { parent, child } = channels();
  const host = attachAccountlessParentChannel({ channel: parent, readPreference: async () => ready,
    backend: {
      async createIfMissing() { beginCreate(); await finish; return "created"; },
      async read() { return null; },
      async deleteExact() { return "missing"; },
    } });
  const client = createAccountlessChildChannel({ channel: child });
  const secret = randomBytes(32);
  try {
    const operation = client.backend.createIfMissing({}, secret);
    await started;
    child.connected = false;
    parent.connected = false;
    child.emit("disconnect");
    await assert.rejects(operation, (error) => {
      assert.equal(error.code, "contribution_device_credential_mutation_uncertain");
      assert.equal(error.message, "Contribution channel mutation uncertain");
      return true;
    });
    finishCreate();
    await tick();
  } finally {
    secret.fill(0);
    client.dispose();
    host.dispose();
  }
});

test("pending-notice and unavailable policies never invoke an uploader", async () => {
  let calls = 0;
  for (const value of [{ ...ready, enabled: false }, { ...ready, current: false }, { ...ready, available: false }]) {
    const scheduler = createAccountlessContributionScheduler({ origin, readPreference: async () => value,
      runner: async () => { calls++; }, ...timers() });
    scheduler.start();
    await scheduler.runNow();
    await scheduler.stop();
  }
  assert.equal(calls, 0);
});

test("real owned child process receives opt-out cancellation without a renderer or HTTP capability", async () => {
  let preference = ready;
  const seen = [];
  const backend = vault();
  await backend.createIfMissing(randomBytes(32));
  const supervisor = createCompanionSupervisor({
    command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/accountless-process-child.mjs", import.meta.url))],
    environment: {},
    attachPrivateChannel: (channel) => attachAccountlessParentChannel({ channel,
      readPreference: async () => preference, backend, onStatus: (value) => seen.push(value.state) }),
  });
  await supervisor.start();
  try {
    const waitFor = async (state) => {
      const deadline = Date.now() + 3000;
      while (!seen.includes(state) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(seen.includes(state), `expected ${state}`);
    };
    await waitFor("uploading");
    preference = { ...ready, enabled: false };
    await supervisor.invalidatePrivateChannel();
    await waitFor("off");
    assert.equal(seen.includes("up_to_date"), false);
  } finally { await supervisor.stop(); }
  assert.equal(supervisor.state.state, "stopped");
});

test("desktop opt-out is durable before waiting for the child cancellation acknowledgement", async () => {
  let text = null;
  let acknowledge;
  const policy = createDesktopSharingCoordinator({ installationState: "fresh", destinationOrigin: origin,
    backend: { load: async () => text, save: async (value) => { text = value; } },
    onAuthorizationChanged: () => new Promise((resolve) => { acknowledge = resolve; }),
  });
  await policy.initialize();
  let completed = false;
  const choice = policy.setEnabled(false).then(() => { completed = true; });
  await tick();
  assert.equal(JSON.parse(text).enabled, false);
  assert.equal(completed, false);
  acknowledge();
  await choice;
  assert.equal(completed, true);
  acknowledge();
});

test("a broken cancellation channel cannot roll back a saved opt-out", async () => {
  let text = null;
  const policy = createDesktopSharingCoordinator({ installationState: "fresh", destinationOrigin: origin,
    backend: { load: async () => text, save: async (value) => { text = value; } },
    onAuthorizationChanged: () => { throw new Error("child unavailable"); },
  });
  await policy.initialize();
  await assert.rejects(policy.setEnabled(false), { code: "desktop_sharing_unavailable" });
  assert.equal(JSON.parse(text).enabled, false);
  assert.equal((await policy.inspect()).enabled, false);
});
