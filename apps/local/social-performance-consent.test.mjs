import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startLocalCompanionServer } from "./server.js";

const ORIGIN = "https://telemetry.example";
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const METHODS = ["receipt", "tool_free"];
const CONSENT = {
  schemaVersion: "model-performance-daily-v1",
  fieldDictionaryVersion: "telemetry-performance-registry-2026-09-21.1",
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

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "social-performance-consent-"));
  const resourceRoot = join(root, "resources");
  const staticRoot = join(resourceRoot, "public");
  const stateRoot = join(root, "state");
  const codexHome = join(root, "codex");
  await Promise.all([
    mkdir(staticRoot, { recursive: true }),
    mkdir(codexHome, { recursive: true }),
  ]);
  let hostedAvailable = false;
  const app = await startLocalCompanionServer({
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
      readHostedCapability: async () => hostedAvailable ? hostedCapability() : null,
      readPreparedDay: async () => null,
      schedulerOptions: {
        backfillDays: 1,
        includeCurrentDay: false,
        setTimer: () => null,
        clearTimer: () => {},
      },
    },
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  await app.snapshotReady;
  return {
    app,
    setHostedAvailable(value) { hostedAvailable = value; },
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
