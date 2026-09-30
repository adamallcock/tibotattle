import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startLocalCompanionServer } from "./server.js";
import { initialTelemetryPerformanceSyncState } from "../../src/application/index.js";

const ORIGIN = "https://telemetry.example";
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const METHODS = ["receipt", "tool_free"];
const CONSENT = {
  schemaVersion: "model-performance-daily-v1",
  fieldDictionaryVersion: "telemetry-performance-registry-2026-09-29.1",
  privacyContractVersion: "privacy-safe-model-performance-v1",
  scope: "model-performance-daily",
};

function dataStore() {
  return {
    async initialize() {},
    async reload() {},
    getOverview() { return {}; },
    getGradient() { return {}; },
    getWeekly() { return {}; },
    getWeeklyPaceOutlook() { return {}; },
    getQuality() { return {}; },
    getReports() { return { reports: [] }; },
  };
}

function controller() {
  return {
    async start() {},
    async stop() {},
    async inspect() { return null; },
    async approve() {},
    async resume() {},
    async pauseForDeviceDisconnect() { return {}; },
    async pauseForDeviceRepair() { return {}; },
    async resumeAfterDeviceRepair() {},
  };
}

function hostedCapability(now = Date.now()) {
  return {
    schemaVersion: "telemetry-performance-capabilities-v1",
    lifecycle: "accepted",
    consentCurrent: true,
    authorizationCurrent: true,
    supportedSpeedMethods: METHODS,
    requiredConsent: CONSENT,
    authorization: {
      schemaVersion: "telemetry-performance-authorization-v1",
      capabilityRevision: 1,
      authorityEpoch: 1,
      issuedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 60 * 60_000).toISOString(),
      scope: "model-performance-daily",
    },
  };
}

async function fixture(t, { initialSyncState = null, readHostedCapability } = {}) {
  const root = await mkdtemp(join(tmpdir(), "social-performance-consent-"));
  const resourceRoot = join(root, "resources");
  const staticRoot = join(resourceRoot, "public");
  const stateRoot = join(root, "state");
  const codexHome = join(root, "codex");
  await Promise.all([
    mkdir(staticRoot, { recursive: true }),
    mkdir(codexHome, { recursive: true }),
  ]);
  const syncStatePath = join(stateRoot, "private", "social-performance-sync-state-v1.json");
  if (initialSyncState !== null) {
    await mkdir(join(stateRoot, "private"), { recursive: true, mode: 0o700 });
    await writeFile(syncStatePath, JSON.stringify(initialSyncState), { mode: 0o600 });
  }
  let hostedAvailable = false;
  const startApp = () => startLocalCompanionServer({
    environment: { HOME: root },
    resourceRoot,
    staticRoot,
    stateRoot,
    codexHome,
    port: 0,
    dataStore: dataStore(),
    refreshRunner: async () => ({}),
    contributionServiceOrigin: ORIGIN,
    incrementalContributionController: controller(),
    socialPerformanceOptions: {
      readDeviceCapability: async () => ({ deviceId: DEVICE_ID }),
      readHostedCapability: readHostedCapability ?? (async () => hostedAvailable ? hostedCapability() : null),
      readPreparedDay: async () => null,
      schedulerOptions: {
        backfillDays: 1,
        includeCurrentDay: false,
        setTimer: () => null,
        clearTimer: () => {},
      },
    },
  });
  let app = await startApp();
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  await app.snapshotReady;
  return {
    get app() { return app; },
    setHostedAvailable(value) { hostedAvailable = value; },
    readSyncState: async () => JSON.parse(await readFile(syncStatePath, "utf8")),
    async restart() {
      await app.close();
      app = await startApp();
      await app.snapshotReady;
    },
  };
}

function localRequest(base, path, options = {}) {
  return fetch(`${base}${path}`, {
    ...options,
    headers: {
      Origin: base,
      "X-Usage-Monitor-Local": "1",
      ...(options.headers ?? {}),
    },
  });
}

test("social performance approval requires the independent hosted capability", async (t) => {
  const fixtureValue = await fixture(t);
  const base = `http://127.0.0.1:${fixtureValue.app.port}`;
  const reviewResponse = await localRequest(base, "/api/local/performance/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(reviewResponse.status, 200);
  const review = await reviewResponse.json();

  const unavailable = await localRequest(base, "/api/local/performance/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      reviewToken: review.reviewToken,
      consent: review.consent,
      binding: review.binding,
      grantDeviceId: review.grantDeviceId,
    }),
  });
  assert.equal(unavailable.status, 409);
  assert.equal((await unavailable.json()).error.code, "performance_authorization_unavailable");

  fixtureValue.setHostedAvailable(true);
  const secondReviewResponse = await localRequest(base, "/api/local/performance/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const secondReview = await secondReviewResponse.json();
  const approved = await localRequest(base, "/api/local/performance/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      reviewToken: secondReview.reviewToken,
      consent: secondReview.consent,
      binding: secondReview.binding,
      grantDeviceId: secondReview.grantDeviceId,
    }),
  });
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).status, "approved");

  const status = await fetch(`${base}/api/local/performance/status`);
  assert.equal(status.status, 200);
  const statusPayload = await status.json();
  assert.deepEqual(statusPayload.supportedSpeedMethods, METHODS);
  assert.equal(statusPayload.consent.approved, true);
});

async function requestApproval(base) {
  const reviewed = await localRequest(base, "/api/local/performance/review", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(reviewed.status, 200);
  const review = await reviewed.json();
  return localRequest(base, "/api/local/performance/approve", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reviewToken: review.reviewToken, consent: review.consent,
      binding: review.binding, grantDeviceId: review.grantDeviceId }),
  });
}

test("renewed social approval durably resumes authorization failures without resetting progress", async t => {
  for (const reason of ["authorization_rejected", "response_invalid"]) {
    const previous = { ...initialTelemetryPerformanceSyncState(), cursorDay: "2026-09-28",
      lastReportRevision: "a".repeat(64), paused: true, pausedReason: reason, retryCount: 4 };
    const value = await fixture(t, { initialSyncState: previous });
    const base = `http://127.0.0.1:${value.app.port}`;
    const refused = await requestApproval(base);
    assert.equal(refused.status, 409);
    assert.deepEqual(await value.readSyncState(), previous, "absent current hosted proof cannot clear the pause");
    value.setHostedAvailable(true);
    const approved = await requestApproval(base);
    assert.equal(approved.status, 200);
    const resumed = await value.readSyncState();
    assert.deepEqual(resumed, { ...previous, paused: false, pausedReason: null, retryCount: 0 });
    await value.restart();
    assert.deepEqual(await value.readSyncState(), resumed);
    const status = await fetch(`http://127.0.0.1:${value.app.port}/api/local/performance/status`);
    assert.equal((await status.json()).consent.approved, true);
  }
});

test("social reapproval preserves disconnect and invalid-report pauses", async t => {
  for (const reason of ["global_paused", "device_disconnected", "report_invalid", "upload_rejected"]) {
    const previous = { ...initialTelemetryPerformanceSyncState(), paused: true, pausedReason: reason };
    const value = await fixture(t, { initialSyncState: previous });
    value.setHostedAvailable(true);
    assert.equal((await requestApproval(`http://127.0.0.1:${value.app.port}`)).status, 200);
    assert.deepEqual(await value.readSyncState(), previous);
  }
});

test("overlapping social approvals cannot replace an active approval writer", async t => {
  let release;
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const proof = new Promise(resolve => { release = resolve; });
  const value = await fixture(t, { readHostedCapability: async () => { entered(); return proof; } });
  const base = `http://127.0.0.1:${value.app.port}`;
  const first = requestApproval(base);
  await waiting;
  const second = await requestApproval(base);
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error.code, "performance_approval_in_progress");
  release(hostedCapability());
  assert.equal((await first).status, 200);
});
