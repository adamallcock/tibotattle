import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createIncrementalContributionSyncController } from "../../src/incremental-contribution.js";
import { LOCAL_COMPANION_SCHEMA_VERSION } from "../../src/local-companion-data.js";
import { startLocalCompanionServer } from "./server.js";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const PAIRING_CODE = `um_pair_${DEVICE_ID}.${"A".repeat(43)}`;
const DISCONNECT_RECEIPT = Object.freeze({
  status: "disconnected",
  deliveryPaused: true,
  localCredential: "deleted",
  localBinding: "removed",
});

function initialSettings(origin) {
  return {
    schemaVersion: "incremental-contribution-sync-settings-v1.0",
    consent: {
      consentedAt: "2026-08-03T00:00:00.000Z",
      destinationOrigin: origin,
      telemetrySchemaVersion: "telemetry-contribution-v1.0",
      fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0",
    },
    paused: true,
    pausedReason: "device_unavailable",
    retryCount: 3,
    lastAttemptAt: "2026-08-03T01:00:00.000Z",
    lastOutcome: {
      at: "2026-08-03T01:00:01.000Z", code: "partial_progress", status: "partial",
    },
    nextAttemptAt: null,
    progress: {
      daysTotal: 5, daysSynced: 2, daysPending: 3, chunksUploaded: 4,
      acknowledgedThroughDay: "2026-08-02",
    },
  };
}

function fakeController() {
  let state = {
    ...initialSettings("https://usage.example"),
    schemaVersion: "incremental-contribution-sync-status-v1.0",
    settingsAvailable: true,
    configured: true,
    running: false,
    consent: { approved: true, current: true, consentedAt: "2026-08-03T00:00:00.000Z" },
  };
  const calls = { pause: 0, resume: 0 };
  return {
    calls,
    async start() {},
    async stop() {},
    async inspect() { return structuredClone(state); },
    async approve() { return this.resume(); },
    async resume() {
      calls.resume += 1;
      state = { ...state, paused: false, pausedReason: null, nextAttemptAt: "2026-08-03T02:00:00.000Z" };
      return structuredClone(state);
    },
    async pauseForDeviceDisconnect() {
      calls.pause += 1;
      state = { ...state, paused: true, pausedReason: "device_disconnected", nextAttemptAt: null };
      return structuredClone(state);
    },
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "companion-disconnect-"));
  const resourceRoot = join(root, "resources");
  const stateRoot = join(root, "state");
  const staticRoot = join(resourceRoot, "public");
  const codexHome = join(root, "codex");
  const apps = [];
  t.after(async () => {
    await Promise.all(apps.map((app) => app.close()));
    await rm(root, { recursive: true });
  });
  await mkdir(staticRoot, { recursive: true });
  await mkdir(join(codexHome, "sessions"), { recursive: true, mode: 0o700 });
  await mkdir(join(stateRoot, "private"), { recursive: true, mode: 0o700 });
  return {
    stateRoot,
    settingsFile: join(stateRoot, "private", "incremental-contribution-sync-v1.json"),
    async start(overrides = {}) {
      const app = await startLocalCompanionServer({
        resourceRoot, stateRoot, staticRoot, codexHome,
        dataStore: {
          async initialize() {},
          async reload() {},
          getOverview() { return { schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION }; },
          getGradient() { return {}; },
          getWeekly() { return {}; },
          getQuality() { return {}; },
          getReports() { return { reports: [] }; },
        },
        refreshRunner: async () => ({}),
        contributionDeviceKeychainPromptProvider: () => "none",
        port: 0,
        ...overrides,
      });
      apps.push(app);
      await app.snapshotReady;
      return { ...app, base: `http://127.0.0.1:${app.port}` };
    },
  };
}

function post(base, operation, body) {
  return fetch(`${base}/api/local/contribution/${operation}`, {
    method: "POST",
    headers: {
      Origin: base,
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
    },
    body: JSON.stringify(body),
  });
}

function disconnect(base) {
  return post(base, "device-disconnect", { confirm: "disconnect_this_mac" });
}

async function assertError(response, status, code) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), {
    schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION, error: { code },
  });
}

test("configured controllers must implement durable disconnect pause", async (t) => {
  const files = await fixture(t);
  const controller = fakeController();
  delete controller.pauseForDeviceDisconnect;
  await assert.rejects(files.start({ incrementalContributionController: controller }), {
    name: "TypeError", message: "incrementalContributionController is invalid",
  });
});

test("disconnect holds its guard through durable pause and credential receipt", async (t) => {
  const files = await fixture(t);
  const controller = fakeController();
  const pauseStarted = Promise.withResolvers();
  const releasePause = Promise.withResolvers();
  const remoteStarted = Promise.withResolvers();
  const releaseRemote = Promise.withResolvers();
  const pause = controller.pauseForDeviceDisconnect;
  controller.pauseForDeviceDisconnect = async () => {
    pauseStarted.resolve();
    await releasePause.promise;
    return pause();
  };
  let remoteCalls = 0;
  let pairingCalls = 0;
  const app = await files.start({
    incrementalContributionController: controller,
    contributionDeviceDisconnectRunner: async () => {
      remoteCalls += 1;
      remoteStarted.resolve();
      await releaseRemote.promise;
      return DISCONNECT_RECEIPT;
    },
    contributionDevicePairingProvider: async () => { pairingCalls += 1; },
  });
  let completed = false;
  const pending = disconnect(app.base).then((response) => {
    completed = true;
    return response;
  });
  try {
    await pauseStarted.promise;
    assert.equal(completed, false);
    assert.equal(remoteCalls, 0, "credential work must wait for durable pause");
    for (const [operation, body] of [
      ["device-disconnect", { confirm: "disconnect_this_mac" }],
      ["incremental-run", {}],
      ["incremental-approve", { reviewToken: "A".repeat(43) }],
      ["device-pair", { pairingCode: PAIRING_CODE }],
      ["device-credential-reset", { confirm: "reset_device_credential" }],
    ]) {
      await assertError(await post(app.base, operation, body), 409, "sync_in_progress");
    }
    assert.equal(controller.calls.resume, 0);
    assert.equal(pairingCalls, 0);
    releasePause.resolve();
    await remoteStarted.promise;
    await assertError(await disconnect(app.base), 409, "sync_in_progress");
    await assertError(await post(app.base, "incremental-run", {}), 409, "sync_in_progress");
    assert.equal(completed, false);
    releaseRemote.resolve();
    const result = await pending;
    assert.equal(result.status, 200);
    assert.equal((await result.json()).deliveryPaused, true);
    assert.equal(remoteCalls, 1);
    assert.equal((await controller.inspect()).pausedReason, "device_disconnected");
  } finally {
    releasePause.resolve();
    releaseRemote.resolve();
    await pending;
  }
});

test("a failed or invalid pause cannot revoke credentials or claim disconnect", async (t) => {
  const files = await fixture(t);
  const controller = fakeController();
  const pause = controller.pauseForDeviceDisconnect;
  let result = "throw";
  controller.pauseForDeviceDisconnect = async () => {
    if (result === "throw") throw new Error("private pause failure");
    return { ...await pause(), ...result };
  };
  let revocations = 0;
  const app = await files.start({
    incrementalContributionController: controller,
    contributionDeviceDisconnectRunner: async () => {
      revocations += 1;
      return DISCONNECT_RECEIPT;
    },
  });
  for (const invalid of [
    "throw", { schemaVersion: "wrong" }, { settingsAvailable: false },
    { paused: false }, { pausedReason: "device_unavailable" },
    { nextAttemptAt: "2026-08-03T02:00:00.000Z" },
  ]) {
    result = invalid;
    await assertError(await disconnect(app.base), 500, "contribution_device_disconnect_failed");
    assert.equal(revocations, 0);
  }
  result = {};
  assert.equal((await disconnect(app.base)).status, 200, "failed requests must release their guard for retry");
  assert.equal(revocations, 1);
});

test("failed revocation and cleanup stay paused and never report a false success", async (t) => {
  const files = await fixture(t);
  const controller = fakeController();
  let failure = "remote";
  const app = await files.start({
    incrementalContributionController: controller,
    contributionDeviceDisconnectRunner: async () => {
      if (failure === "receipt") return { ...DISCONNECT_RECEIPT, localBinding: "retained" };
      if (failure === null) return DISCONNECT_RECEIPT;
      const error = new Error("private credential details");
      error.code = failure === "cleanup"
        ? "contribution_device_disconnect_cleanup_pending"
        : "contribution_device_client_disconnect_rejected";
      throw error;
    },
  });
  for (const [mode, status, code] of [
    ["remote", 502, "contribution_device_disconnect_failed"],
    ["cleanup", 409, "contribution_device_disconnect_cleanup_pending"],
    ["receipt", 500, "contribution_device_disconnect_failed"],
  ]) {
    failure = mode;
    await assertError(await disconnect(app.base), status, code);
    const paused = await controller.inspect();
    assert.equal(paused.pausedReason, "device_disconnected");
    assert.equal(paused.nextAttemptAt, null);
    assert.equal(paused.consent.current, true);
    assert.equal(paused.progress.chunksUploaded, 4);
  }
  failure = null;
  assert.equal((await disconnect(app.base)).status, 200);
  assert.equal(controller.calls.pause, 4);
});

test("disconnect refuses to race an already-started explicit reconnect", async (t) => {
  const files = await fixture(t);
  const controller = fakeController();
  const pairingStarted = Promise.withResolvers();
  const releasePairing = Promise.withResolvers();
  const app = await files.start({
    incrementalContributionController: controller,
    contributionDeviceDisconnectRunner: async () => DISCONNECT_RECEIPT,
    contributionDevicePairingProvider: async () => {
      pairingStarted.resolve();
      await releasePairing.promise;
      return { status: "paired", scope: "upload_registration", expiresAt: "2026-09-30T00:00:00.000Z" };
    },
  });
  const pairing = post(app.base, "device-pair", { pairingCode: PAIRING_CODE });
  try {
    await pairingStarted.promise;
    await assertError(await disconnect(app.base), 409, "sync_in_progress");
    assert.equal(controller.calls.pause, 0);
    releasePairing.resolve();
    assert.equal((await pairing).status, 200);
    assert.equal((await disconnect(app.base)).status, 200);
    assert.equal((await controller.inspect()).pausedReason, "device_disconnected");
  } finally {
    releasePairing.resolve();
    await pairing;
  }
});

test("a real settings file stays disconnected across companion restart until explicit pairing", async (t) => {
  const files = await fixture(t);
  const origin = "https://usage.example";
  const previous = initialSettings(origin);
  await writeFile(files.settingsFile, JSON.stringify(previous), { mode: 0o600 });
  let runs = 0;
  const runnerEntered = Promise.withResolvers();
  const newController = () => createIncrementalContributionSyncController({
    settingsFile: files.settingsFile,
    destinationOrigin: origin,
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
    ditherRandom: () => 0,
    runner: async () => {
      runs += 1;
      runnerEntered.resolve();
      return {
        schemaVersion: "incremental-contribution-sync-run-v1.0",
        status: "complete", daysTotal: 5, daysSynced: 5, daysPending: 0,
        chunksUploaded: 3, acknowledgedThroughDay: "2026-08-03", failure: null,
      };
    },
  });
  let controller = newController();
  let app = await files.start({
    incrementalContributionController: controller,
    contributionDeviceDisconnectRunner: async () => {
      assert.equal(JSON.parse(await readFile(files.settingsFile, "utf8")).pausedReason, "device_disconnected");
      return DISCONNECT_RECEIPT;
    },
  });
  assert.equal((await disconnect(app.base)).status, 200);
  const paused = { ...previous, pausedReason: "device_disconnected" };
  assert.deepEqual(JSON.parse(await readFile(files.settingsFile, "utf8")), paused);
  assert.equal((await lstat(files.settingsFile)).mode & 0o777, 0o600);
  await app.close();
  controller = newController();
  app = await files.start({
    incrementalContributionController: controller,
    contributionDevicePairingProvider: async () => ({
      status: "paired", scope: "upload_registration", expiresAt: "2026-09-30T00:00:00.000Z",
    }),
  });
  await controller.runDue();
  assert.equal(runs, 0);
  const status = await fetch(`${app.base}/api/local/contribution/incremental-status`).then((response) => response.json());
  assert.equal(status.paused, true);
  assert.equal(status.pausedReason, "device_disconnected");
  assert.equal(status.nextAttemptAt, null);
  assert.deepEqual(status.progress, previous.progress);
  assert.deepEqual(JSON.parse(await readFile(files.settingsFile, "utf8")), paused);
  assert.equal((await post(app.base, "device-pair", { pairingCode: PAIRING_CODE })).status, 200);
  await runnerEntered.promise;
  assert.equal(runs, 1);
  assert.equal((await controller.inspect()).paused, false);
});

test("the real disconnector preserves retry state and pauses both queues after remote revocation", async (t) => {
  const files = await fixture(t);
  let rejectRemote = true;
  let failCleanup = true;
  let remoteCalls = 0;
  const upstream = createServer((_request, response) => {
    remoteCalls += 1;
    response.writeHead(rejectRemote ? 503 : 200, {
      "Content-Type": "application/json", "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(rejectRemote
      ? { error: { code: "SERVICE_UNAVAILABLE" } }
      : { schemaVersion: "device-disconnect-v0.1", disconnected: true, deviceId: DEVICE_ID }));
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const previous = initialSettings(origin);
  const bindingFile = join(files.stateRoot, "contribution-device-binding-v1.json");
  const binding = `${JSON.stringify({
    schemaVersion: "contribution-device-binding-v1", origin, deviceId: DEVICE_ID,
    createdAt: "2026-08-03T00:00:00.000Z",
  })}\n`;
  await writeFile(bindingFile, binding, { mode: 0o600 });
  await writeFile(files.settingsFile, JSON.stringify(previous), { mode: 0o600 });
  let stored = Buffer.alloc(32, 7);
  const backend = {
    async read() { return stored === null ? null : Buffer.from(stored); },
    async createIfMissing() { return "existing"; },
    async deleteExact(_capability, expected) {
      if (failCleanup) throw new Error("synthetic exact credential deletion failure");
      assert.deepEqual(stored, expected);
      stored.fill(0);
      stored = null;
      return "deleted";
    },
  };
  const app = await files.start({
    contributionServiceOrigin: origin,
    contributionDeviceBackendFactory: () => backend,
  });
  await assertError(await disconnect(app.base), 502, "contribution_device_disconnect_failed");
  assert.equal(remoteCalls, 1);
  assert.equal(await readFile(bindingFile, "utf8"), binding);
  assert.deepEqual(stored, Buffer.alloc(32, 7));
  const paused = { ...previous, pausedReason: "device_disconnected" };
  assert.deepEqual(JSON.parse(await readFile(files.settingsFile, "utf8")), paused);
  rejectRemote = false;
  await assertError(await disconnect(app.base), 409, "contribution_device_disconnect_cleanup_pending");
  assert.equal(remoteCalls, 2);
  assert.equal(await readFile(bindingFile, "utf8"), binding);
  assert.deepEqual(stored, Buffer.alloc(32, 7));
  assert.deepEqual(JSON.parse(await readFile(files.settingsFile, "utf8")), paused);
  const queue = await fetch(`${app.base}/api/local/contribution/sync-status`).then((response) => response.json());
  assert.equal(queue.paused, true);
  failCleanup = false;
  const disconnected = await disconnect(app.base);
  assert.equal(disconnected.status, 200);
  assert.deepEqual(await disconnected.json(), {
    schemaVersion: "local-contribution-device-disconnect-v0.1", ...DISCONNECT_RECEIPT,
    includesIdentifiers: false, includesCredentials: false, hostedDataDeleted: false,
  });
  assert.equal(stored, null);
  await assert.rejects(lstat(bindingFile), { code: "ENOENT" });
  assert.equal(remoteCalls, 3);
  assert.deepEqual(JSON.parse(await readFile(files.settingsFile, "utf8")), paused);
});
