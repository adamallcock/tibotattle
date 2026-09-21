import assert from "node:assert/strict";
import test from "node:test";

import {
  CommunityClient,
  LocalCompanionClient,
  normalizeTelemetryPerformanceReview,
} from "../public/data-client.js";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const METHODS = ["receipt", "tool_free"];
const CONSENT = {
  schemaVersion: "model-performance-daily-v1",
  fieldDictionaryVersion: "telemetry-performance-registry-2026-09-21.1",
  privacyContractVersion: "privacy-safe-model-performance-v1",
  scope: "model-performance-daily",
};
const BINDING = {
  destinationOrigin: "https://telemetry.example",
  fieldDictionaryVersion: CONSENT.fieldDictionaryVersion,
  methodVersion: "performance-daily-histogram-v1",
  privacyContractVersion: CONSENT.privacyContractVersion,
  scope: CONSENT.scope,
  stream: CONSENT.scope,
  supportedSpeedMethods: METHODS,
};

function reviewPayload(overrides = {}) {
  return {
    schemaVersion: "local-telemetry-performance-review-v1",
    status: "ready",
    reviewToken: "r".repeat(43),
    consent: CONSENT,
    binding: BINDING,
    grantDeviceId: DEVICE_ID,
    sample: {
      status: "available",
      day: "2026-09-20",
      recordCount: null,
      content: false,
    },
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    includesCredentials: false,
    ...overrides,
  };
}

function response(value, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return value; },
  };
}

test("performance review rejects a legacy or mismatched speed-method declaration", () => {
  assert.ok(normalizeTelemetryPerformanceReview(reviewPayload()));
  assert.equal(normalizeTelemetryPerformanceReview(reviewPayload({
    binding: { ...BINDING, supportedSpeedMethods: ["receipt", "legacy"] },
  })), null);
  assert.equal(normalizeTelemetryPerformanceReview(reviewPayload({
    binding: { ...BINDING, supportedSpeedMethods: ["receipt"] },
  })), null);
});

test("local performance client keeps review, approval, and status on closed loopback routes", async () => {
  const payloads = {
    status: {
      schemaVersion: "local-telemetry-performance-status-v1",
      configured: true,
      destinationOrigin: "https://telemetry.example",
      supportedSpeedMethods: METHODS,
      consent: { approved: false, current: false, approvedAt: null },
      scheduler: { state: "off", lastAcceptedAt: null, nextAttemptAt: null },
    },
    review: reviewPayload(),
    approval: { schemaVersion: "local-telemetry-performance-consent-v1", status: "approved" },
  };
  const calls = [];
  const client = new LocalCompanionClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      const name = new URL(url, "http://127.0.0.1").pathname.split("/").at(-1);
      return response(payloads[name]);
    },
  });

  assert.equal((await client.telemetryPerformanceStatus()).configured, true);
  const review = await client.reviewTelemetryPerformance();
  await client.approveTelemetryPerformance(review);

  assert.deepEqual(calls.map(({ url }) => new URL(url, "http://127.0.0.1").pathname), [
    "/api/local/performance/status",
    "/api/local/performance/review",
    "/api/local/performance/approve",
  ]);
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.headers["X-Usage-Monitor-Local"], "1");
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    reviewToken: review.reviewToken,
    consent: review.consent,
    binding: review.binding,
    grantDeviceId: review.grantDeviceId,
  });
});

test("hosted performance grant is a separate CSRF-protected route", async () => {
  const calls = [];
  const client = new CommunityClient({
    getCsrfToken: () => "csrf-token",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return response({ status: "accepted" }, 201);
    },
  });
  const review = normalizeTelemetryPerformanceReview(reviewPayload());
  await client.grantTelemetryPerformanceContribution(review);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/v1/me/device-telemetry-performance-consents");
  assert.equal(calls[0].options.headers["X-Usage-Monitor-CSRF"], "csrf-token");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    deviceId: DEVICE_ID,
    consent: CONSENT,
    ongoingUpload: true,
  });
});
