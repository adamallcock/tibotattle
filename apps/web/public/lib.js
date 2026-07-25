const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export const SYNTHETIC_SCHEMA_VERSION = "synthetic-contribution-v0.1";
export const ENVELOPE_SCHEMA_VERSION = "synthetic-envelope-v0.1";

export function buildSyntheticFixture() {
  return {
    schemaVersion: SYNTHETIC_SCHEMA_VERSION,
    synthetic: true,
    fixtureId: "codex-weekly-demo-v0.1",
    timeRange: {
      start: "2026-07-14T00:00:00.000Z",
      end: "2026-07-21T00:00:00.000Z"
    },
    quota: {
      windowMinutes: 10080,
      usedPercentBefore: 26,
      usedPercentAfter: 31,
      displayPrecision: 0
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
        unknownUnits: 1
      }
    },
    accounting: {
      estimatedApiCostUsd: "12.840000",
      pricedEventCoveragePercent: 100,
      unknownBillableUnits: 1,
      priceBasis: "current-api-price-sensitivity"
    }
  };
}

export function validateSyntheticFixture(fixture) {
  if (!fixture || fixture.synthetic !== true || fixture.schemaVersion !== SYNTHETIC_SCHEMA_VERSION) {
    throw new TypeError("Only the fixed synthetic fixture can be contributed.");
  }
  const canonical = JSON.stringify(buildSyntheticFixture());
  if (JSON.stringify(fixture) !== canonical) {
    throw new TypeError("The synthetic fixture must not be modified.");
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
    output += index + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 63] : "=";
    output += index + 2 < bytes.length ? BASE64_ALPHABET[triple & 63] : "=";
  }
  return output.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function createSyntheticEnvelope({ publicJwk, keyId, cryptoImpl = globalThis.crypto } = {}) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== "function") {
    throw new Error("Web Crypto is unavailable in this browser.");
  }
  if (!publicJwk || typeof keyId !== "string" || !/^key:[A-Za-z0-9._-]+$/.test(keyId)) {
    throw new TypeError("A public JWK and key ID are required.");
  }

  const fixture = buildSyntheticFixture();
  validateSyntheticFixture(fixture);

  const wrappingKey = await cryptoImpl.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"]
  );
  const payloadKey = await cryptoImpl.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(fixture));
  const ciphertext = await cryptoImpl.subtle.encrypt(
    { name: "AES-GCM", iv },
    payloadKey,
    plaintext
  );
  const rawPayloadKey = await cryptoImpl.subtle.exportKey("raw", payloadKey);
  const wrappedKey = await cryptoImpl.subtle.encrypt(
    { name: "RSA-OAEP" },
    wrappingKey,
    rawPayloadKey
  );

  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    synthetic: true,
    keyId,
    wrappedKey: bytesToBase64Url(new Uint8Array(wrappedKey)),
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext))
  };
}

export function formatTokenTotal(usage) {
  const total = usage.inputUncachedTokens
    + usage.inputCachedTokens
    + usage.outputTextTokens
    + usage.outputReasoningTokens;
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(total);
}

export function safeFilename(participantId) {
  const suffix = typeof participantId === "string"
    ? participantId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32)
    : "participant";
  return `usage-monitor-${suffix || "participant"}-export.json`;
}

export function safeApiError(payload, fallback) {
  const candidate = typeof payload?.error === "string"
    ? payload.error
    : payload?.error?.code;
  if (typeof candidate === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(candidate)) {
    return candidate.replace(/_/g, " ");
  }
  return fallback;
}
