const KEY_ID = /^key:[A-Za-z0-9._-]{1,64}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const MAX_CIPHERTEXT = 2_000_000;

function ownObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, keys) {
  return ownObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function base64Url(value, minimum, maximum) {
  return typeof value === "string"
    && value.length >= minimum && value.length <= maximum && BASE64URL.test(value);
}

function invalid() {
  const error = new TypeError("Telemetry performance envelope is invalid");
  error.code = "TELEMETRY_PERFORMANCE_ENVELOPE_INVALID";
  throw error;
}

/** Validate the independent performance envelope without inspecting ciphertext. */
export function validateTelemetryPerformanceEnvelope(value) {
  if (!exact(value, ["schemaVersion", "synthetic", "keyId", "wrappedKey", "iv", "ciphertext"])
      || value.schemaVersion !== "telemetry-performance-envelope-v1"
      || value.synthetic !== false
      || !KEY_ID.test(value.keyId)
      || !base64Url(value.wrappedKey, 342, 342)
      || !base64Url(value.iv, 16, 16)
      || !base64Url(value.ciphertext, 16, MAX_CIPHERTEXT)) {
    invalid();
  }
  return value;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function snapshotReport(report) {
  if (!ownObject(report) || report.schemaVersion !== "telemetry-performance-report-v1") {
    invalid();
  }
  let serialized;
  try {
    serialized = JSON.stringify(report);
    if (typeof serialized !== "string") invalid();
  } catch {
    invalid();
  }
  return new TextEncoder().encode(serialized);
}

/**
 * Encrypt a prepared performance report with the same RSA-OAEP/AES-GCM
 * construction as the usage dialect, but under a separate schema version.
 * The report has already passed the closed performance projector; this
 * function never accepts a raw timing row or a usage contribution object.
 */
export async function createTelemetryPerformanceEnvelope({
  report,
  publicJwk,
  keyId,
  cryptoImpl = globalThis.crypto,
} = {}) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== "function") {
    throw new Error("Web Crypto is unavailable in this Node runtime.");
  }
  if (!publicJwk || typeof keyId !== "string" || !KEY_ID.test(keyId)) {
    throw new TypeError("A public JWK and key ID are required.");
  }
  const plaintext = snapshotReport(report);
  let rawPayloadKey;
  try {
    const wrappingKey = await cryptoImpl.subtle.importKey(
      "jwk", publicJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"],
    );
    const payloadKey = await cryptoImpl.subtle.generateKey(
      { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"],
    );
    const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
    const ciphertext = await cryptoImpl.subtle.encrypt({ name: "AES-GCM", iv }, payloadKey, plaintext);
    rawPayloadKey = new Uint8Array(await cryptoImpl.subtle.exportKey("raw", payloadKey));
    const wrappedKey = await cryptoImpl.subtle.encrypt({ name: "RSA-OAEP" }, wrappingKey, rawPayloadKey);
    return Object.freeze(validateTelemetryPerformanceEnvelope({
      schemaVersion: "telemetry-performance-envelope-v1",
      synthetic: false,
      keyId,
      wrappedKey: bytesToBase64Url(new Uint8Array(wrappedKey)),
      iv: bytesToBase64Url(iv),
      ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
    }));
  } finally {
    plaintext.fill(0);
    rawPayloadKey?.fill(0);
  }
}
