import {
  TELEMETRY_ENVELOPE_SCHEMA_VERSION,
  parseTelemetryEnvelope,
  validateContributionForUpload,
} from "@app-usagemonitor/telemetry-contract";

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const SERIALIZATION_ERROR_MESSAGE =
  "Telemetry payload serialization failed.";

/**
 * Snapshot caller data before the first await. The package validator receives
 * the parsed snapshot and the private encryption helper receives only the
 * resulting UTF-8 bytes, so no caller-owned object can change after preflight.
 */
function snapshotPayloadBytes(payload) {
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

  validateContributionForUpload(snapshot);

  try {
    return new TextEncoder().encode(serialized);
  } catch {
    throw new TypeError(SERIALIZATION_ERROR_MESSAGE);
  }
}

function bytesToBase64Url(bytes) {
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

/**
 * Encrypt an already privacy-stripped contribution for the upload boundary.
 *
 * Synthetic fixture behavior remains browser-only. The raw encryption helper
 * is deliberately private so every Node caller passes package validation.
 */
export async function createTelemetryEnvelope({
  payload,
  publicJwk,
  keyId,
  cryptoImpl = globalThis.crypto,
} = {}) {
  const plaintext = snapshotPayloadBytes(payload);
  return createEncryptedEnvelope({
    plaintext,
    publicJwk,
    keyId,
    cryptoImpl,
  });
}

async function createEncryptedEnvelope({
  plaintext,
  publicJwk,
  keyId,
  cryptoImpl,
}) {
  if (
    !cryptoImpl?.subtle
    || typeof cryptoImpl.getRandomValues !== "function"
  ) {
    throw new Error("Web Crypto is unavailable in this Node runtime.");
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

  return parseTelemetryEnvelope({
    schemaVersion: TELEMETRY_ENVELOPE_SCHEMA_VERSION,
    synthetic: false,
    keyId,
    wrappedKey: bytesToBase64Url(new Uint8Array(wrappedKey)),
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  });
}
