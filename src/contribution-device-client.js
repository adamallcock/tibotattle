import { randomUUID } from "node:crypto";

import {
  ensureContributionDeviceCapability,
  rotateContributionDeviceCredential,
  withContributionDeviceSecret,
} from "./contribution-device-capability.js";

const PAIRING_PATTERN = /^um_pair_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u;
const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SECRET_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const MAXIMUM_RESPONSE_BYTES = 16_384;

const ERROR_CODES = new Set([
  "invalid_configuration",
  "pairing_invalid",
  "service_unavailable",
  "pairing_rejected",
  "disconnect_rejected",
  "renewal_rejected",
  "response_invalid",
]);

export class ContributionDeviceClientError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) throw new TypeError("Unknown contribution device client error code");
    super("Contribution device client operation failed");
    this.name = "ContributionDeviceClientError";
    this.code = `contribution_device_client_${code}`;
  }
}

function fail(code) {
  throw new ContributionDeviceClientError(code);
}

function normalizePairingCode(value) {
  if (typeof value !== "string" || !PAIRING_PATTERN.test(value)) fail("pairing_invalid");
  return value;
}

async function boundedJsonResponse(response, rejectionCode = "pairing_rejected") {
  if (!(response instanceof Response)) fail("response_invalid");
  const cacheControl = response.headers.get("cache-control");
  const contentType = response.headers.get("content-type") ?? "";
  if (cacheControl !== "no-store" || !contentType.toLowerCase().startsWith("application/json")) {
    fail("response_invalid");
  }
  let text;
  try {
    text = await response.text();
  } catch {
    fail("service_unavailable");
  }
  if (Buffer.byteLength(text, "utf8") > MAXIMUM_RESPONSE_BYTES) fail("response_invalid");
  let payload;
  try {
    payload = text.length === 0 ? null : JSON.parse(text);
  } catch {
    fail("response_invalid");
  }
  if (!response.ok) fail(response.status >= 500 ? "service_unavailable" : rejectionCode);
  return payload;
}

function canonicalOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    fail("invalid_configuration");
  }
}

export async function claimContributionDevicePairing({
  origin,
  pairingCode,
  fetchImpl = globalThis.fetch,
  ensureCapability = ensureContributionDeviceCapability,
  capabilityOptions = {},
} = {}) {
  if (typeof fetchImpl !== "function" || typeof ensureCapability !== "function"
      || !capabilityOptions || typeof capabilityOptions !== "object"
      || Array.isArray(capabilityOptions)) {
    fail("invalid_configuration");
  }
  const selectedPairing = normalizePairingCode(pairingCode);
  const requestedOrigin = canonicalOrigin(origin);
  const capability = await ensureCapability({ ...capabilityOptions, origin });
  if (!capability || capability.origin !== requestedOrigin
      || typeof capability.deviceId !== "string"
      || !/^[0-9a-f-]{36}$/u.test(capability.deviceId)
      || typeof capability.deviceSecretHash !== "string"
      || !/^[0-9a-f]{64}$/u.test(capability.deviceSecretHash)) {
    fail("invalid_configuration");
  }

  let response;
  try {
    response = await fetchImpl(
      new URL("/api/v1/device-pairings/claim", capability.origin),
      {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Pairing ${selectedPairing}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          deviceId: capability.deviceId,
          deviceSecretHash: capability.deviceSecretHash,
        }),
      },
    );
  } catch {
    fail("service_unavailable");
  }
  const payload = await boundedJsonResponse(response);
  const keys = Object.keys(payload ?? {}).sort().join("\0");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || !["deviceId\0expiresAt\0state", "deviceId\0expiresAt\0scope\0state"].includes(keys)
      || payload.deviceId !== capability.deviceId
      || payload.state !== "active"
      || (payload.scope !== undefined && payload.scope !== "upload_registration")
      || !Number.isFinite(Date.parse(payload.expiresAt))) {
    fail("response_invalid");
  }
  return Object.freeze({
    status: "paired",
    origin: capability.origin,
    deviceId: capability.deviceId,
    scope: "upload_registration",
    expiresAt: new Date(payload.expiresAt).toISOString(),
  });
}

/**
 * Revoke this Mac's upload-only device authority at the contribution service.
 * The secret is leased only to this request and is never returned. Callers
 * must remove the local Keychain/state binding only after this resolves with
 * the same device id; that second, local operation intentionally lives in the
 * companion so a failed network request cannot orphan the user's authority.
 */
export async function disconnectContributionDevice({
  origin,
  fetchImpl = globalThis.fetch,
  withDeviceSecret = withContributionDeviceSecret,
  capabilityOptions = {},
} = {}) {
  if (typeof fetchImpl !== "function" || typeof withDeviceSecret !== "function"
      || !capabilityOptions || typeof capabilityOptions !== "object"
      || Array.isArray(capabilityOptions)) {
    fail("invalid_configuration");
  }
  const requestedOrigin = canonicalOrigin(origin);
  const result = await withDeviceSecret({
    ...capabilityOptions,
    expectedOrigin: requestedOrigin,
    operation: async (secret, binding) => {
      if (!binding || binding.origin !== requestedOrigin
          || !DEVICE_ID_PATTERN.test(binding.deviceId)) {
        fail("invalid_configuration");
      }
      let response;
      try {
        response = await fetchImpl(
          new URL("/api/v1/device/disconnect", binding.origin),
          {
            method: "POST",
            credentials: "omit",
            redirect: "error",
            headers: {
              Accept: "application/json",
              Authorization:
                `Device um_device_${binding.deviceId}.${secret.toString("base64url")}`,
            },
          },
        );
      } catch {
        fail("service_unavailable");
      }
      const payload = await boundedJsonResponse(response, "disconnect_rejected");
      if (!payload || typeof payload !== "object" || Array.isArray(payload)
          || Object.keys(payload).sort().join("\0")
            !== "deviceId\0disconnected\0schemaVersion"
          || payload.schemaVersion !== "device-disconnect-v0.1"
          || payload.disconnected !== true
          || payload.deviceId !== binding.deviceId) {
        fail("response_invalid");
      }
      return Object.freeze({ deviceId: binding.deviceId });
    },
  });
  if (!result || typeof result !== "object" || !DEVICE_ID_PATTERN.test(result.deviceId)) {
    fail("response_invalid");
  }
  return Object.freeze({
    status: "disconnected",
    origin: requestedOrigin,
    deviceId: result.deviceId,
  });
}

/**
 * Silently renew this Mac's device-upload credential before it lapses — the
 * network half of the sign-in-once auto-renewal. It generates a fresh secret
 * locally, authenticates the rotation with the EXISTING credential (no browser
 * sign-in), and only rotates the Keychain value after the service confirms the
 * new secret committed for the same device. The returned expiry lets the caller
 * decide when the next renewal is due.
 */
export async function renewContributionDeviceCredential({
  origin,
  fetchImpl = globalThis.fetch,
  rotate = rotateContributionDeviceCredential,
  generateRotationAttemptId = randomUUID,
  capabilityOptions = {},
} = {}) {
  if (typeof fetchImpl !== "function" || typeof rotate !== "function"
      || typeof generateRotationAttemptId !== "function"
      || !capabilityOptions || typeof capabilityOptions !== "object"
      || Array.isArray(capabilityOptions)) {
    fail("invalid_configuration");
  }
  const requestedOrigin = canonicalOrigin(origin);
  let rotationAttemptId;
  try {
    rotationAttemptId = generateRotationAttemptId();
  } catch {
    fail("invalid_configuration");
  }
  if (typeof rotationAttemptId !== "string"
      || !UUID_V4_PATTERN.test(rotationAttemptId)) {
    fail("invalid_configuration");
  }

  const result = await rotate({
    ...capabilityOptions,
    expectedOrigin: requestedOrigin,
    performRemoteRotation: async ({
      origin: rotationOrigin,
      deviceId,
      currentSecret,
      nextDeviceSecretHash,
    }) => {
      if (rotationOrigin !== requestedOrigin
          || typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId)
          || !Buffer.isBuffer(currentSecret)
          || typeof nextDeviceSecretHash !== "string"
          || !SECRET_HASH_PATTERN.test(nextDeviceSecretHash)) {
        fail("invalid_configuration");
      }
      let response;
      try {
        response = await fetchImpl(
          new URL("/api/v1/device/credential/renew", requestedOrigin),
          {
            method: "POST",
            credentials: "omit",
            redirect: "error",
            headers: {
              Accept: "application/json",
              Authorization:
                `Device um_device_${deviceId}.${currentSecret.toString("base64url")}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ nextDeviceSecretHash, rotationAttemptId }),
          },
        );
      } catch {
        fail("service_unavailable");
      }
      const payload = await boundedJsonResponse(response, "renewal_rejected");
      if (!payload || typeof payload !== "object" || Array.isArray(payload)
          || payload.schemaVersion !== "device-credential-renewal-v1.0"
          || payload.deviceId !== deviceId
          || payload.state !== "active"
          || payload.scope !== "upload_registration"
          || payload.commit !== true
          || !Number.isSafeInteger(payload.credentialGeneration)
          || !Number.isFinite(Date.parse(payload.expiresAt))) {
        fail("response_invalid");
      }
      return Object.freeze({
        committed: true,
        expiresAt: new Date(payload.expiresAt).toISOString(),
      });
    },
  });
  if (!result || typeof result !== "object"
      || result.status !== "renewed"
      || !DEVICE_ID_PATTERN.test(result.deviceId ?? "")
      || !Number.isFinite(Date.parse(result.expiresAt))) {
    fail("response_invalid");
  }
  return Object.freeze({
    status: "renewed",
    origin: requestedOrigin,
    deviceId: result.deviceId,
    expiresAt: new Date(result.expiresAt).toISOString(),
  });
}
