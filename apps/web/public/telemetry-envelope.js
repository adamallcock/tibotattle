import {
  TELEMETRY_ENVELOPE_SCHEMA_VERSION,
  validateContributionForUpload,
} from "./telemetry-shared.generated.js";

export const SYNTHETIC_SCHEMA_VERSION =
  "synthetic-contribution-v0.1";
export const ENVELOPE_SCHEMA_VERSION =
  "synthetic-envelope-v0.1";

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const SERIALIZATION_ERROR_MESSAGE =
  "Telemetry payload serialization failed.";

/**
 * Take the one and only plaintext snapshot at the public trust boundary.
 *
 * Do this before any asynchronous Web Crypto operation. Validation deliberately
 * receives the parsed JSON value rather than the caller-owned value, while the
 * encryption path receives only these private bytes. That prevents a caller
 * from changing a valid object after this function has started and before AES
 * sees it.
 */
function snapshotPayloadBytes(payload, validate) {
  let serialized;
  let snapshot;
  try {
    serialized = JSON.stringify(payload);
    if (typeof serialized !== "string") {
      throw new TypeError("Payload does not serialize to JSON.");
    }
    snapshot = JSON.parse(serialized);
  } catch {
    throw new TypeError(SERIALIZATION_ERROR_MESSAGE);
  }

  validate(snapshot);

  try {
    return new TextEncoder().encode(serialized);
  } catch {
    throw new TypeError(SERIALIZATION_ERROR_MESSAGE);
  }
}

export function buildSyntheticFixture() {
  return {
    schemaVersion: SYNTHETIC_SCHEMA_VERSION,
    synthetic: true,
    fixtureId: "codex-weekly-demo-v0.1",
    timeRange: {
      start: "2026-07-14T00:00:00.000Z",
      end: "2026-07-21T00:00:00.000Z",
    },
    quota: {
      windowMinutes: 10080,
      usedPercentBefore: 26,
      usedPercentAfter: 31,
      displayPrecision: 0,
    },
    usage: {
      modelId: "gpt-5.6-sol",
      subscriptionSpeed: "standard",
      apiTierAssumption: "standard",
      inputUncachedTokens: 150000,
      inputCachedTokens: 900000,
      outputTextTokens: 28000,
      outputReasoningTokens: 16000,
      providerToolUnits: {
        webSearchCalls: 2,
        unknownUnits: 1,
      },
    },
    accounting: {
      estimatedApiCostUsd: "12.840000",
      pricedEventCoveragePercent: 100,
      unknownBillableUnits: 1,
      priceBasis: "current-api-price-sensitivity",
    },
  };
}

export function validateSyntheticFixture(fixture) {
  if (
    !fixture
    || fixture.synthetic !== true
    || fixture.schemaVersion !== SYNTHETIC_SCHEMA_VERSION
  ) {
    throw new TypeError(
      "Only the fixed synthetic fixture can be contributed.",
    );
  }
  if (JSON.stringify(fixture) !== JSON.stringify(buildSyntheticFixture())) {
    throw new TypeError(
      "The synthetic fixture must not be modified.",
    );
  }
  return true;
}

export function bytesToBase64Url(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Expected Uint8Array.");
  }
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    output += BASE64_ALPHABET[(triple >> 18) & 63];
    output += BASE64_ALPHABET[(triple >> 12) & 63];
    output += index + 1 < bytes.length
      ? BASE64_ALPHABET[(triple >> 6) & 63]
      : "=";
    output += index + 2 < bytes.length
      ? BASE64_ALPHABET[triple & 63]
      : "=";
  }
  return output
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

export async function createSyntheticEnvelope({
  publicJwk,
  keyId,
  cryptoImpl = globalThis.crypto,
} = {}) {
  const fixture = buildSyntheticFixture();
  const plaintext = snapshotPayloadBytes(fixture, validateSyntheticFixture);
  return createEncryptedEnvelope({
    plaintext,
    publicJwk,
    keyId,
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    synthetic: true,
    cryptoImpl,
  });
}

export async function createTelemetryEnvelope({
  payload,
  publicJwk,
  keyId,
  cryptoImpl = globalThis.crypto,
} = {}) {
  const plaintext = snapshotPayloadBytes(
    payload,
    validateContributionForUpload,
  );
  return createEncryptedEnvelope({
    plaintext,
    publicJwk,
    keyId,
    schemaVersion: TELEMETRY_ENVELOPE_SCHEMA_VERSION,
    synthetic: false,
    cryptoImpl,
  });
}

async function createEncryptedEnvelope({
  plaintext,
  publicJwk,
  keyId,
  schemaVersion,
  synthetic,
  cryptoImpl,
}) {
  if (
    !cryptoImpl?.subtle
    || typeof cryptoImpl.getRandomValues !== "function"
  ) {
    throw new Error("Web Crypto is unavailable in this browser.");
  }
  if (
    !publicJwk
    || typeof keyId !== "string"
    || !/^key:[A-Za-z0-9._-]{1,64}$/u.test(keyId)
  ) {
    throw new TypeError("A public JWK and key ID are required.");
  }
  const wrappingKey = await cryptoImpl.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const payloadKey = await cryptoImpl.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
  const ciphertext = await cryptoImpl.subtle.encrypt(
    { name: "AES-GCM", iv },
    payloadKey,
    plaintext,
  );
  const rawPayloadKey = await cryptoImpl.subtle.exportKey(
    "raw",
    payloadKey,
  );
  const wrappedKey = await cryptoImpl.subtle.encrypt(
    { name: "RSA-OAEP" },
    wrappingKey,
    rawPayloadKey,
  );
  return {
    schemaVersion,
    synthetic,
    keyId,
    wrappedKey: bytesToBase64Url(new Uint8Array(wrappedKey)),
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
}
