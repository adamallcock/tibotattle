import { createHash } from "node:crypto";
import {
  withContributionDeviceSecret,
} from "./contribution-device-capability.js";
import {
  createTelemetryEnvelope,
} from "./platform/telemetry-envelope.js";
import {
  loadVerifiedPreparedContribution,
  verifyPreparedContributionSet,
} from "./telemetry-prepared-set.js";
import {
  TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
} from "./telemetry-contribution-builder.js";

const MAXIMUM_RESPONSE_BYTES = 32_768;
const MAXIMUM_RETRY_AFTER_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
const IMF_FIXDATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;
const CONTRIBUTION_ID =
  /^contribution:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DEVICE_UPLOAD =
  /^um_device_upload_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/u;

const ERROR_CODES = new Set([
  "invalid_configuration",
  "service_unavailable",
  "device_unavailable",
  "authorization_rejected",
  "upload_rejected",
  "response_invalid",
]);

export class ContributionDeviceSyncError extends Error {
  constructor(code, {
    retryable = false,
    deviceUnavailable = false,
    retryAfterMilliseconds = null,
    retryAfterExceedsMaximum = false,
  } = {}) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown contribution device sync error code");
    }
    super("Contribution device sync failed");
    this.name = "ContributionDeviceSyncError";
    this.code = `contribution_device_sync_${code}`;
    this.retryable = retryable;
    this.deviceUnavailable = deviceUnavailable;
    if (retryAfterMilliseconds !== null
        && (!Number.isSafeInteger(retryAfterMilliseconds)
          || retryAfterMilliseconds < 0
          || retryAfterMilliseconds > MAXIMUM_RETRY_AFTER_MILLISECONDS)) {
      throw new TypeError("Invalid contribution device retry delay");
    }
    this.retryAfterMilliseconds = retryAfterMilliseconds;
    if (typeof retryAfterExceedsMaximum !== "boolean") {
      throw new TypeError("Invalid contribution device retry horizon");
    }
    this.retryAfterExceedsMaximum = retryAfterExceedsMaximum;
  }
}

function fail(code, options = {}) {
  throw new ContributionDeviceSyncError(code, options);
}

function retryAfter(response, now = Date.now()) {
  const value = response.headers.get("retry-after")?.trim() ?? "";
  if (value.length === 0 || value.length > 128) {
    return { milliseconds: null, exceedsMaximum: false };
  }
  let milliseconds;
  if (/^\d+$/u.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds)) {
      return { milliseconds: null, exceedsMaximum: true };
    }
    milliseconds = seconds * 1_000;
  } else {
    // Do not hand arbitrary strings to Date.parse: browser-specific formats
    // such as "08/05/2026" are not HTTP Retry-After dates and could create a
    // surprising future deadline. HTTP-date is IMF-fixdate on the wire.
    if (!IMF_FIXDATE.test(value)) {
      return { milliseconds: null, exceedsMaximum: false };
    }
    const retryAt = Date.parse(value);
    if (!Number.isFinite(retryAt)) {
      return { milliseconds: null, exceedsMaximum: false };
    }
    milliseconds = Math.max(0, retryAt - now);
  }
  if (!Number.isSafeInteger(milliseconds)
      || milliseconds > MAXIMUM_RETRY_AFTER_MILLISECONDS) {
    // Do not silently shorten an advertised floor. The queue will pause and
    // require an explicit operator decision rather than retrying early.
    return { milliseconds: null, exceedsMaximum: true };
  }
  return { milliseconds, exceedsMaximum: false };
}

async function readJson(response, rejectionCode, {
  deviceAuthorization = false,
} = {}) {
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
    fail("service_unavailable", { retryable: true });
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
    if (response.status === 408 || response.status === 429
        || response.status >= 500) {
      const retry = retryAfter(response);
      fail("service_unavailable", {
        retryable: true,
        retryAfterMilliseconds: retry.milliseconds,
        retryAfterExceedsMaximum: retry.exceedsMaximum,
      });
    }
    const backendCode = payload?.error?.code;
    if (deviceAuthorization
        && ["DEVICE_AUTH_INVALID", "PARTICIPANT_DELETING"].includes(backendCode)) {
      fail("device_unavailable", { deviceUnavailable: true });
    }
    fail(rejectionCode);
  }
  return payload;
}

async function requestJson(
  fetchImpl,
  url,
  options,
  rejectionCode,
  classification = {},
) {
  let response;
  try {
    response = await fetchImpl(url, {
      credentials: "omit",
      redirect: "error",
      ...options,
    });
  } catch {
    fail("service_unavailable", { retryable: true });
  }
  return readJson(response, rejectionCode, classification);
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

/**
 * Upload exactly one already-manifested v0.1 batch. The local file is reopened
 * and fully verified before the first network request.
 */
export async function syncPreparedContributionEntryOnce({
  directory,
  entry,
  origin,
  backend,
  stateFile = undefined,
  signal = undefined,
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  platform = process.platform,
  loadContribution = undefined,
  withDeviceSecret = withContributionDeviceSecret,
  createEnvelope = createTelemetryEnvelope,
} = {}) {
  const selectedLoadContribution = platform === "win32"
    ? loadContribution
    : loadContribution ?? loadVerifiedPreparedContribution;
  if (typeof directory !== "string" || !entry || typeof entry !== "object"
      || typeof platform !== "string"
      || typeof fetchImpl !== "function"
      || typeof selectedLoadContribution !== "function"
      || typeof withDeviceSecret !== "function" || typeof createEnvelope !== "function"
      || !backend || typeof backend !== "object"
      || (signal !== undefined && !(signal instanceof AbortSignal))) {
    fail("invalid_configuration");
  }
  const selectedOrigin = canonicalOrigin(origin);

  const payload = await selectedLoadContribution({ directory, entry });
  const envelopeKey = await requestJson(
    fetchImpl,
    new URL("/api/v1/envelope-key", selectedOrigin),
    {
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    },
    "authorization_rejected",
  );
  if (envelopeKey?.algorithm !== "RSA-OAEP-256"
      || typeof envelopeKey.keyId !== "string"
      || envelopeKey.keyId.length < 1
      || envelopeKey.keyId.length > 200
      || !envelopeKey.publicJwk || typeof envelopeKey.publicJwk !== "object") {
    fail("response_invalid");
  }

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
  const registrationOutcome = await withDeviceSecret({
    backend,
    ...(stateFile === undefined ? {} : { stateFile }),
    expectedOrigin: selectedOrigin,
    operation: async (secret, binding) => {
      const deviceAuthorization =
        `um_device_${binding.deviceId}.${secret.toString("base64url")}`;
      try {
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
            ...(signal === undefined ? {} : { signal }),
          },
          "authorization_rejected",
          { deviceAuthorization: true },
        );
        if (typeof registration?.uploadAuthorization !== "string"
            || !DEVICE_UPLOAD.test(registration.uploadAuthorization)
            || !Number.isFinite(Date.parse(registration.expiresAt))) {
          fail("response_invalid");
        }
        return Object.freeze({
          ok: true,
          uploadAuthorization: registration.uploadAuthorization,
        });
      } catch (error) {
        if (!(error instanceof ContributionDeviceSyncError)) throw error;
        return Object.freeze({
          ok: false,
          code: error.code.replace("contribution_device_sync_", ""),
          retryable: error.retryable,
          deviceUnavailable: error.deviceUnavailable,
          retryAfterMilliseconds: error.retryAfterMilliseconds,
        });
      }
    },
  });
  if (registrationOutcome?.ok !== true) {
    if (!ERROR_CODES.has(registrationOutcome?.code)) fail("response_invalid");
    fail(registrationOutcome.code, {
      retryable: registrationOutcome.retryable === true,
      deviceUnavailable: registrationOutcome.deviceUnavailable === true,
      retryAfterMilliseconds: registrationOutcome.retryAfterMilliseconds ?? null,
    });
  }
  const uploadAuthorization = registrationOutcome.uploadAuthorization;
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
      ...(signal === undefined ? {} : { signal }),
    },
    "upload_rejected",
  );
  if (typeof receipt?.contributionId !== "string"
      || !CONTRIBUTION_ID.test(receipt.contributionId)
      || typeof receipt.status !== "string"
      || receipt.status.length > 80) {
    fail("response_invalid");
  }
  return Object.freeze({
    basename: entry.basename,
    contributionId: receipt.contributionId,
    status: receipt.status,
  });
}

export async function syncPreparedContributionSetOnce({
  directory,
  origin,
  backend,
  stateFile = undefined,
  signal = undefined,
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  platform = process.platform,
  verifySet = undefined,
  loadContribution = undefined,
  withDeviceSecret = withContributionDeviceSecret,
  createEnvelope = createTelemetryEnvelope,
} = {}) {
  const selectedVerifySet = platform === "win32"
    ? verifySet
    : verifySet ?? verifyPreparedContributionSet;
  const selectedLoadContribution = platform === "win32"
    ? loadContribution
    : loadContribution ?? loadVerifiedPreparedContribution;
  if (typeof directory !== "string" || typeof fetchImpl !== "function"
      || typeof selectedVerifySet !== "function"
      || typeof selectedLoadContribution !== "function"
      || typeof withDeviceSecret !== "function" || typeof createEnvelope !== "function"
      || !backend || typeof backend !== "object") {
    fail("invalid_configuration");
  }
  const selectedOrigin = canonicalOrigin(origin);
  const manifest = await selectedVerifySet({
    directory,
    builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
  });
  if (manifest?.eligibleSchemaVersion !== "telemetry-contribution-v0.1"
      || !Array.isArray(manifest.files) || manifest.files.length < 1) {
    fail("invalid_configuration");
  }

  const accepted = [];
  for (const entry of manifest.files) {
    accepted.push(await syncPreparedContributionEntryOnce({
      directory,
      entry,
      origin: selectedOrigin,
      backend,
      stateFile,
      signal,
      fetchImpl,
      cryptoImpl,
      platform,
      loadContribution: selectedLoadContribution,
      withDeviceSecret,
      createEnvelope,
    }));
  }
  return Object.freeze({
    status: "succeeded",
    eligibleSchemaVersion: "telemetry-contribution-v0.1",
    preparedSetBatches: manifest.files.length,
    accepted: Object.freeze(accepted),
  });
}
