import test from "node:test";
import assert from "node:assert/strict";

import {
  syncPreparedContributionEntryOnce,
  syncPreparedContributionSetOnce,
} from "../src/contribution-device-sync.js";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const AUTH_ID = "22222222-2222-4222-8222-222222222222";
const CONTRIBUTION_ID = "33333333-3333-4333-8333-333333333333";

function response(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

test("foreground sync verifies a committed set and uses device authority only to register uploads", async () => {
  const calls = [];
  const manifest = {
    eligibleSchemaVersion: "telemetry-contribution-v0.1",
    files: [{
      basename: "telemetry-contribution-000001.json",
      sha256: "a".repeat(64),
      bytes: 123,
      recordCounts: { usageEvents: 1, quotaSnapshots: 0, activityMarkers: 0 },
    }],
  };
  const result = await syncPreparedContributionSetOnce({
    directory: "/private/prepared",
    origin: "https://usage.example/",
    backend: {},
    verifySet: async () => manifest,
    loadContribution: async () => ({
      schemaVersion: "telemetry-contribution-v0.1",
      synthetic: false,
    }),
    createEnvelope: async () => ({
      schemaVersion: "telemetry-envelope-v0.1",
      ciphertext: "safe",
    }),
    withDeviceSecret: async ({ expectedOrigin, operation }) => {
      assert.equal(expectedOrigin, "https://usage.example");
      return operation(Buffer.alloc(32, 7), {
        origin: expectedOrigin,
        deviceId: DEVICE_ID,
      });
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/envelope-key")) {
        return response({
          algorithm: "RSA-OAEP-256",
          keyId: "key:test",
          publicJwk: { kty: "RSA" },
        });
      }
      if (String(url).endsWith("/device/upload-authorizations")) {
        return response({
          uploadAuthorization: `um_device_upload_${AUTH_ID}.${"B".repeat(43)}`,
          expiresAt: "2026-07-26T13:00:00.000Z",
        }, 201);
      }
      return response({
        contributionId: `contribution:${CONTRIBUTION_ID}`,
        status: "accepted",
      }, 202);
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.preparedSetBatches, 1);
  assert.equal(result.accepted[0].contributionId, `contribution:${CONTRIBUTION_ID}`);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.credentials, "omit");
  assert.match(calls[1].options.headers.Authorization, /^Device um_device_/u);
  assert.equal(calls[1].options.body.includes("telemetry-contribution"), false);
  assert.match(calls[2].options.headers.Authorization, /^Upload um_device_upload_/u);
  assert.equal(calls.some(({ options }) => "Cookie" in (options.headers ?? {})), false);
});

test("disabled or uncommitted prepared sets cause zero network activity", async () => {
  let networkCalls = 0;
  await assert.rejects(
    syncPreparedContributionSetOnce({
      directory: "/private/prepared",
      origin: "https://usage.example",
      backend: {},
      verifySet: async () => {
        const error = new Error("not committed");
        error.code = "prepared_contribution_set_manifest_missing";
        throw error;
      },
      fetchImpl: async () => {
        networkCalls += 1;
      },
    }),
    (error) => error.code === "prepared_contribution_set_manifest_missing",
  );
  assert.equal(networkCalls, 0);
});

test("entry sync re-verifies the prepared file before fetching a key", async () => {
  let networkCalls = 0;
  await assert.rejects(
    syncPreparedContributionEntryOnce({
      directory: "/private/prepared",
      entry: {
        basename: "telemetry-contribution-000001.json",
        sha256: "a".repeat(64),
        bytes: 123,
        recordCounts: { usageEvents: 1, quotaSnapshots: 0, activityMarkers: 0 },
      },
      origin: "https://usage.example",
      backend: {},
      loadContribution: async () => {
        const error = new Error("substituted");
        error.code = "prepared_contribution_set_file_digest";
        throw error;
      },
      fetchImpl: async () => {
        networkCalls += 1;
      },
    }),
    (error) => error.code === "prepared_contribution_set_file_digest",
  );
  assert.equal(networkCalls, 0);
});

test("only transient HTTP failures are marked retryable", async () => {
  const entry = {
    basename: "telemetry-contribution-000001.json",
    sha256: "a".repeat(64),
    bytes: 123,
    recordCounts: { usageEvents: 1, quotaSnapshots: 0, activityMarkers: 0 },
  };
  await assert.rejects(
    syncPreparedContributionEntryOnce({
      directory: "/private/prepared",
      entry,
      origin: "https://usage.example",
      backend: {},
      loadContribution: async () => ({
        schemaVersion: "telemetry-contribution-v0.1",
        synthetic: false,
      }),
      fetchImpl: async () => response({
        error: { code: "BACKEND_STORAGE_UNAVAILABLE", requestId: "fixed" },
      }, 429, { "Retry-After": "60" }),
    }),
    (error) => error.code === "contribution_device_sync_service_unavailable"
      && error.retryable === true
      && error.deviceUnavailable === false
      && error.retryAfterMilliseconds === 60_000,
  );

  await assert.rejects(
    syncPreparedContributionEntryOnce({
      directory: "/private/prepared",
      entry,
      origin: "https://usage.example",
      backend: {},
      loadContribution: async () => ({
        schemaVersion: "telemetry-contribution-v0.1",
        synthetic: false,
      }),
      createEnvelope: async () => ({
        schemaVersion: "telemetry-envelope-v0.1",
        ciphertext: "safe",
      }),
      withDeviceSecret: async ({ expectedOrigin, operation }) => operation(
        Buffer.alloc(32, 7),
        { origin: expectedOrigin, deviceId: DEVICE_ID },
      ),
      fetchImpl: async (url) => {
        if (String(url).endsWith("/envelope-key")) {
          return response({
            algorithm: "RSA-OAEP-256",
            keyId: "key:test",
            publicJwk: { kty: "RSA" },
          });
        }
        return response({
          error: { code: "DEVICE_AUTH_INVALID", requestId: "fixed" },
        }, 401);
      },
    }),
    (error) => error.code === "contribution_device_sync_device_unavailable"
      && error.retryable === false
      && error.deviceUnavailable === true,
  );
});

test("Retry-After accepts IMF-fixdate and never silently shortens an over-horizon floor", async (t) => {
  const entry = {
    basename: "telemetry-contribution-000001.json",
    sha256: "a".repeat(64),
    bytes: 123,
    recordCounts: { usageEvents: 1, quotaSnapshots: 0, activityMarkers: 0 },
  };
  const fixedNow = Date.parse("2026-07-26T12:00:00.000Z");
  t.mock.method(Date, "now", () => fixedNow);
  const transient = (header) => syncPreparedContributionEntryOnce({
    directory: "/private/prepared",
    entry,
    origin: "https://usage.example",
    backend: {},
    loadContribution: async () => ({
      schemaVersion: "telemetry-contribution-v0.1",
      synthetic: false,
    }),
    fetchImpl: async () => response({ error: { code: "busy" } }, 429, {
      "Retry-After": header,
    }),
  });

  await assert.rejects(
    transient("Sun, 26 Jul 2026 12:01:00 GMT"),
    (error) => error.retryable === true
      && error.retryAfterMilliseconds === 60_000
      && error.retryAfterExceedsMaximum === false,
  );
  await assert.rejects(
    transient("08/05/2026"),
    (error) => error.retryable === true
      && error.retryAfterMilliseconds === null
      && error.retryAfterExceedsMaximum === false,
  );
  await assert.rejects(
    transient("604801"),
    (error) => error.retryable === true
      && error.retryAfterMilliseconds === null
      && error.retryAfterExceedsMaximum === true,
  );
});
