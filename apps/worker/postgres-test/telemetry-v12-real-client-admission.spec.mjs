import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createTelemetryV12RealClientHarness } from "./telemetry-v12-real-client-harness.mjs";

const CAPABILITIES_PATH = "/api/v1/device/sync-capabilities-v1.2";
const ACTIVATION_PATH = "/api/v1/me/telemetry-v12/domain-activate";
const CLIENT_IP = "198.51.100.27";

function requestHeaders(authorization) {
  return {
    "cf-connecting-ip": CLIENT_IP,
    ...(authorization === undefined ? {} : { authorization }),
  };
}

function daysFrom(firstDay, count) {
  const start = Date.parse(firstDay + "T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10));
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

test("malformed and missing device bearers exhaust the production attempt budget at six without blocking a good bearer", async () => {
  const harness = await createTelemetryV12RealClientHarness({ label: "attempt-budget" });
  try {
    for (const authorization of [
      undefined,
      "Device malformed",
      undefined,
      "Bearer not-a-device-token",
      "Device um_device_not-a-uuid.secret",
    ]) {
      const response = await harness.request(CAPABILITIES_PATH, {
        headers: requestHeaders(authorization),
      });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.code, "DEVICE_AUTH_INVALID");
    }
    assert.equal(harness.queryCounters.authenticationQueries, 0,
      "missing and malformed bearers must be rejected before database authentication");

    const sixthAttempt = await harness.request(CAPABILITIES_PATH, {
      headers: requestHeaders("Device malformed"),
    });
    assert.equal(sixthAttempt.status, 429);
    assert.equal(sixthAttempt.headers.get("retry-after"), "60");
    assert.equal((await sixthAttempt.json()).error.code, "ATTEMPT_LIMIT_REACHED");
    assert.equal(harness.queryCounters.authenticationQueries, 0);

    const valid = await harness.request(CAPABILITIES_PATH, {
      headers: requestHeaders(harness.authorization),
    });
    assert.equal(valid.status, 200);
    assert.ok(harness.queryCounters.authenticationQueries > 0,
      "a valid bearer remains usable after the unauthenticated attempt bucket is exhausted");
  } finally {
    await harness.cleanup();
  }
});

test("the eleventh well-formed unknown bearer is rejected at the 10-per-minute client budget before database authentication", async () => {
  const harness = await createTelemetryV12RealClientHarness({
    label: "unknown-bearer-budget",
    // The default attempt budget of five would independently block invalid
    // unknown credentials before the 10-per-minute credential budget is
    // reached; raise only that unrelated test limiter to isolate the target.
    limits: { DEVICE_SYNC_CLIENT: 10, CLIENT_ATTEMPT: 20 },
  });
  try {
    const unknownAuthorization = harness.authorization.replace(harness.deviceId, randomUUID());
    assert.notEqual(unknownAuthorization, harness.authorization);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await harness.request(CAPABILITIES_PATH, {
        headers: requestHeaders(unknownAuthorization),
      });
      assert.equal(response.status, 401, `unknown bearer attempt ${attempt + 1}`);
      assert.equal((await response.json()).error.code, "DEVICE_AUTH_INVALID");
    }
    assert.ok(harness.queryCounters.authenticationQueries >= 10,
      "the first ten well-formed unknown bearers must reach credential verification");

    // Isolate the eleventh request so this assertion proves that client-budget
    // rejection happens before any credential query, despite the first ten
    // requests having legitimately queried PostgreSQL.
    harness.resetQueryCounters();
    const eleventh = await harness.request(CAPABILITIES_PATH, {
      headers: requestHeaders(unknownAuthorization),
    });
    assert.equal(eleventh.status, 429);
    assert.equal(eleventh.headers.get("retry-after"), "60");
    assert.equal((await eleventh.json()).error.code, "DEVICE_SYNC_LIMIT_REACHED");
    assert.equal(harness.queryCounters.authenticationQueries, 0,
      "an over-budget well-formed bearer must not trigger database authentication");
  } finally {
    await harness.cleanup();
  }
});

test("the participant 10-per-minute budget returns a retryable real-client result with a 60-second delay", async () => {
  const harness = await createTelemetryV12RealClientHarness({ label: "participant-budget" });
  try {
    harness.setLimit("DEVICE_SYNC_PRINCIPAL", 10);
    const today = Date.parse(todayUtc() + "T00:00:00.000Z");
    const firstDay = new Date(today - 6 * 86_400_000).toISOString().slice(0, 10);
    const { result, exchanges } = await harness.runClient({ days: daysFrom(firstDay, 7) });

    assert.equal(result.status, "failed");
    assert.deepEqual(result.failure, {
      code: "service_unavailable",
      retryable: true,
      deviceUnavailable: false,
      retryAfterMilliseconds: 60_000,
    });
    assert.equal(exchanges.at(-1)?.status, 429);
    assert.equal(exchanges.at(-1)?.body?.error?.code, "DEVICE_SYNC_LIMIT_REACHED");
  } finally {
    await harness.cleanup();
  }
});

test("a NOT VALID domain CHECK returns a paced storage refusal, then the real client succeeds after repair", async () => {
  const harness = await createTelemetryV12RealClientHarness({ label: "domain-constraint-retry" });
  try {
    const day = todayUtc();
    await harness.addDomainCheckConstraint();
    const first = await harness.runClient({ days: [day] });

    assert.equal(first.result.status, "failed");
    assert.deepEqual(first.result.failure, {
      code: "service_unavailable",
      retryable: true,
      deviceUnavailable: false,
      retryAfterMilliseconds: 3_600_000,
    });
    const refusal = first.exchanges.at(-1);
    assert.equal(refusal?.path, ACTIVATION_PATH);
    assert.equal(refusal?.status, 503);
    assert.deepEqual(Object.keys(refusal?.body ?? {}).sort(), ["error"]);
    assert.deepEqual(Object.keys(refusal?.body?.error ?? {}).sort(), ["code", "requestId"]);
    assert.equal(refusal?.body?.error?.code, "TELEMETRY_STORAGE_CONSTRAINT");
    assert.equal(JSON.stringify(refusal?.body).includes("v12_real_client_invalid_domain"), false,
      "database constraint details must not escape in the public error");

    await harness.dropDomainCheckConstraint();
    const retry = await harness.runClient({ days: [day] });
    assert.equal(retry.result.status, "complete");
    assert.equal(retry.result.failure, null);
    assert.equal(retry.result.daysSynced, 1);
    const counts = await harness.counts();
    assert.equal(counts.telemetry_v12_domains, 1);
    assert.equal(counts.head?.revision, 1);
    assert.equal(counts.storage_v12_event_sources, 1,
      "retry reuses the chunk staged before the paced activation refusal");
  } finally {
    await harness.cleanup();
  }
});
