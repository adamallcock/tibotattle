import { createHash } from "node:crypto";
import { createTelemetryEnvelope } from "../apps/web/public/lib.js";
import {
  withContributionDeviceSecret,
} from "./contribution-device-capability.js";
import {
  loadVerifiedPreparedContribution,
  verifyPreparedContributionSet,
} from "./telemetry-prepared-set.js";
import {
  TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
} from "./telemetry-contribution-builder.js";

const MAXIMUM_RESPONSE_BYTES = 32_768;
const CONTRIBUTION_ID =
  /^contribution:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DEVICE_UPLOAD =
  /^um_device_upload_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/u;

const ERROR_CODES = new Set([
  "invalid_configuration",
  "service_unavailable",
  "authorization_rejected",
  "upload_rejected",
  "response_invalid",
]);

export class ContributionDeviceSyncError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) throw new TypeError("Unknown contribution device sync error code");
    super("Contribution device sync failed");
    this.name = "ContributionDeviceSyncError";
    this.code = `contribution_device_sync_${code}`;
  }
}

function fail(code) {
  throw new ContributionDeviceSyncError(code);
}

async function readJson(response, rejectionCode) {
  if (!(response instanceof Response)) fail("response_invalid");
  if (response.headers.get("cache-control") !== "no-store"
      || !(response.headers.get("content-type") ?? "")
        .toLowerCase().startsWith("application/json")) {
    fail("response_invalid");
  }
  let text;
  try {
    text = await response.text();
  } catch {
    fail("service_unavailable");
  }
  if (Buffer.byteLength(text, "utf8") > MAXIMUM_RESPONSE_BYTES) {
    fail("response_invalid");
  }
  let payload;
  try {
    payload = text.length === 0 ? null : JSON.parse(text);
  } catch {
    fail("response_invalid");
  }
  if (!response.ok) {
    fail(response.status >= 500 ? "service_unavailable" : rejectionCode);
  }
  return payload;
}

async function requestJson(fetchImpl, url, options, rejectionCode) {
  let response;
  try {
    response = await fetchImpl(url, {
      credentials: "omit",
      redirect: "error",
      ...options,
    });
  } catch {
    fail("service_unavailable");
  }
  return readJson(response, rejectionCode);
}

function canonicalOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("invalid_configuration");
  }
  const loopback = parsed.protocol === "http:"
    && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if ((parsed.protocol !== "https:" && !loopback)
      || parsed.username !== "" || parsed.password !== ""
      || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    fail("invalid_configuration");
  }
  return parsed.origin;
}

export async function syncPreparedContributionSetOnce({
  directory,
  origin,
  backend,
  stateFile = undefined,
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  verifySet = verifyPreparedContributionSet,
  loadContribution = loadVerifiedPreparedContribution,
  withDeviceSecret = withContributionDeviceSecret,
  createEnvelope = createTelemetryEnvelope,
} = {}) {
  if (typeof directory !== "string" || typeof fetchImpl !== "function"
      || typeof verifySet !== "function" || typeof loadContribution !== "function"
      || typeof withDeviceSecret !== "function" || typeof createEnvelope !== "function"
      || !backend || typeof backend !== "object") {
    fail("invalid_configuration");
  }
  const selectedOrigin = canonicalOrigin(origin);
  const manifest = await verifySet({
    directory,
    builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
  });
  if (manifest?.eligibleSchemaVersion !== "telemetry-contribution-v0.1"
      || !Array.isArray(manifest.files) || manifest.files.length < 1) {
    fail("invalid_configuration");
  }

  const envelopeKey = await requestJson(
    fetchImpl,
    new URL("/api/v1/envelope-key", selectedOrigin),
    { headers: { Accept: "application/json" } },
    "authorization_rejected",
  );
  if (envelopeKey?.algorithm !== "RSA-OAEP-256"
      || typeof envelopeKey.keyId !== "string"
      || envelopeKey.keyId.length < 1
      || envelopeKey.keyId.length > 200
      || !envelopeKey.publicJwk || typeof envelopeKey.publicJwk !== "object") {
    fail("response_invalid");
  }

  const accepted = [];
  for (const entry of manifest.files) {
    const payload = await loadContribution({ directory, entry });
    const envelope = await createEnvelope({
      payload,
      publicJwk: envelopeKey.publicJwk,
      keyId: envelopeKey.keyId,
      cryptoImpl,
    });
    const serializedEnvelope = JSON.stringify(envelope);
    const contentLengthBytes = Buffer.byteLength(serializedEnvelope, "utf8");
    const envelopeDigest = createHash("sha256")
      .update(serializedEnvelope, "utf8")
      .digest("hex");
    const uploadAuthorization = await withDeviceSecret({
      backend,
      ...(stateFile === undefined ? {} : { stateFile }),
      expectedOrigin: selectedOrigin,
      operation: async (secret, binding) => {
        const deviceAuthorization =
          `um_device_${binding.deviceId}.${secret.toString("base64url")}`;
        const registration = await requestJson(
          fetchImpl,
          new URL("/api/v1/device/upload-authorizations", selectedOrigin),
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              Authorization: `Device ${deviceAuthorization}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              envelopeDigest,
              contentLengthBytes,
              contentType: "application/json",
            }),
          },
          "authorization_rejected",
        );
        if (typeof registration?.uploadAuthorization !== "string"
            || !DEVICE_UPLOAD.test(registration.uploadAuthorization)
            || !Number.isFinite(Date.parse(registration.expiresAt))) {
          fail("response_invalid");
        }
        return registration.uploadAuthorization;
      },
    });
    const receipt = await requestJson(
      fetchImpl,
      new URL("/api/v1/contributions", selectedOrigin),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Upload ${uploadAuthorization}`,
          "Content-Type": "application/json",
        },
        body: serializedEnvelope,
      },
      "upload_rejected",
    );
    if (typeof receipt?.contributionId !== "string"
        || !CONTRIBUTION_ID.test(receipt.contributionId)
        || typeof receipt.status !== "string"
        || receipt.status.length > 80) {
      fail("response_invalid");
    }
    accepted.push(Object.freeze({
      basename: entry.basename,
      contributionId: receipt.contributionId,
      status: receipt.status,
    }));
  }
  return Object.freeze({
    status: "succeeded",
    eligibleSchemaVersion: "telemetry-contribution-v0.1",
    preparedSetBatches: manifest.files.length,
    accepted: Object.freeze(accepted),
  });
}
