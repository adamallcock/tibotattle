import test from "node:test";
import assert from "node:assert/strict";

import {
  claimContributionDevicePairing,
  ContributionDeviceClientError,
  disconnectContributionDevice,
} from "../src/contribution-device-client.js";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const PAIRING = `um_pair_22222222-2222-4222-8222-222222222222.${"A".repeat(43)}`;

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}

test("pairing claim sends only the one-use capability and a device hash", async () => {
  const calls = [];
  const result = await claimContributionDevicePairing({
    origin: "https://usage.example",
    pairingCode: PAIRING,
    ensureCapability: async ({ origin }) => ({
      status: "created",
      origin,
      deviceId: DEVICE_ID,
      deviceSecretHash: "b".repeat(64),
    }),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        deviceId: DEVICE_ID,
        state: "active",
        scope: "upload_registration",
        expiresAt: "2026-08-25T12:00:00.000Z",
      }, 201);
    },
  });
  assert.deepEqual(result, {
    status: "paired",
    origin: "https://usage.example",
    deviceId: DEVICE_ID,
    scope: "upload_registration",
    expiresAt: "2026-08-25T12:00:00.000Z",
  });
  assert.equal(calls[0].url, "https://usage.example/api/v1/device-pairings/claim");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.headers.Authorization, `Pairing ${PAIRING}`);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    deviceId: DEVICE_ID,
    deviceSecretHash: "b".repeat(64),
  });
  assert.equal(calls[0].options.body.includes(PAIRING), false);
});

test("pairing client collapses rejection and malformed responses to fixed errors", async () => {
  const base = {
    origin: "https://usage.example",
    pairingCode: PAIRING,
    ensureCapability: async ({ origin }) => ({
      origin,
      deviceId: DEVICE_ID,
      deviceSecretHash: "b".repeat(64),
    }),
  };
  await assert.rejects(
    claimContributionDevicePairing({
      ...base,
      fetchImpl: async () => jsonResponse({ error: "private detail" }, 401),
    }),
    (error) => error instanceof ContributionDeviceClientError
      && error.code === "contribution_device_client_pairing_rejected",
  );
  await assert.rejects(
    claimContributionDevicePairing({
      ...base,
      fetchImpl: async () => new Response("not json", {
        status: 200,
        headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" },
      }),
    }),
    (error) => error instanceof ContributionDeviceClientError
      && error.code === "contribution_device_client_response_invalid",
  );
});

test("invalid pairing never creates a local capability or performs network activity", async () => {
  let capabilityCalls = 0;
  let networkCalls = 0;
  await assert.rejects(
    claimContributionDevicePairing({
      origin: "https://usage.example",
      pairingCode: "123456",
      ensureCapability: async () => {
        capabilityCalls += 1;
      },
      fetchImpl: async () => {
        networkCalls += 1;
      },
    }),
    (error) => error.code === "contribution_device_client_pairing_invalid",
  );
  assert.equal(capabilityCalls, 0);
  assert.equal(networkCalls, 0);
});

test("device disconnect leases the Keychain secret only to the revocation request", async () => {
  const calls = [];
  const secret = Buffer.alloc(32, 7);
  const result = await disconnectContributionDevice({
    origin: "https://usage.example",
    withDeviceSecret: async ({ expectedOrigin, operation }) => {
      assert.equal(expectedOrigin, "https://usage.example");
      return operation(secret, {
        origin: expectedOrigin,
        deviceId: DEVICE_ID,
        createdAt: "2026-08-04T00:00:00.000Z",
      });
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        schemaVersion: "device-disconnect-v0.1",
        disconnected: true,
        deviceId: DEVICE_ID,
      });
    },
  });
  assert.deepEqual(result, {
    status: "disconnected",
    origin: "https://usage.example",
    deviceId: DEVICE_ID,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://usage.example/api/v1/device/disconnect");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.headers.Authorization,
    `Device um_device_${DEVICE_ID}.${secret.toString("base64url")}`);
  assert.equal(Object.hasOwn(result, "secret"), false);
});

test("device disconnect rejects a malformed or rejected revocation response", async () => {
  const base = {
    origin: "https://usage.example",
    withDeviceSecret: async ({ operation }) => operation(Buffer.alloc(32, 1), {
      origin: "https://usage.example",
      deviceId: DEVICE_ID,
      createdAt: "2026-08-04T00:00:00.000Z",
    }),
  };
  await assert.rejects(
    disconnectContributionDevice({
      ...base,
      fetchImpl: async () => jsonResponse({ error: { code: "DEVICE_AUTH_INVALID" } }, 401),
    }),
    (error) => error instanceof ContributionDeviceClientError
      && error.code === "contribution_device_client_disconnect_rejected",
  );
  await assert.rejects(
    disconnectContributionDevice({
      ...base,
      fetchImpl: async () => jsonResponse({
        schemaVersion: "device-disconnect-v0.1",
        disconnected: true,
        deviceId: crypto.randomUUID(),
      }),
    }),
    (error) => error instanceof ContributionDeviceClientError
      && error.code === "contribution_device_client_response_invalid",
  );
});
