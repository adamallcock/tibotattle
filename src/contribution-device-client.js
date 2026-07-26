import { ensureContributionDeviceCapability } from "./contribution-device-capability.js";

const PAIRING_PATTERN = /^um_pair_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u;
const MAXIMUM_RESPONSE_BYTES = 16_384;

const ERROR_CODES = new Set([
  "invalid_configuration",
  "pairing_invalid",
  "service_unavailable",
  "pairing_rejected",
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

async function boundedJsonResponse(response) {
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
  if (!response.ok) fail(response.status >= 500 ? "service_unavailable" : "pairing_rejected");
  return payload;
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
  let requestedOrigin;
  try {
    requestedOrigin = new URL(origin).origin;
  } catch {
    fail("invalid_configuration");
  }
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
