// telemetry-envelope-v1.0: the v0.1 envelope cryptography verbatim — one
// AES-256-GCM payload key per envelope, wrapped with the service's RSA-OAEP
// public key — carrying a new schema version so the worker's transport
// dispatcher selects the v1.0 chunk path without touching the deployed v0.1
// branch. The plaintext here is a validated v1.0 chunk, so the v0.1 package
// validator is deliberately not consulted.
//
// The two version strings below are pinned wire-contract mirrors, exactly as
// the worker pins its own copies (apps/worker/src/telemetry-v1.ts): the
// platform transport owner may not import the contribution owner, and the
// cross-module tests that envelope a derived chunk fail on any drift between
// these bytes and the chunk derivation's
// (src/contribution/telemetry-v1-chunks.js).
const TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION = "telemetry-contribution-v1.0";
const TELEMETRY_V1_ENVELOPE_SCHEMA_VERSION = "telemetry-envelope-v1.0";

const SERIALIZATION_ERROR_MESSAGE = "Telemetry chunk serialization failed.";

function bytesToBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Snapshot the chunk plaintext before the first await, exactly as the v0.1
 * envelope does: no caller-owned object can change after preflight, and the
 * only bytes encrypted are the serialized snapshot's.
 */
function snapshotChunkBytes(chunk) {
  let serialized;
  let snapshot;
  try {
    serialized = JSON.stringify(chunk);
    if (typeof serialized !== "string") {
      throw new TypeError("Chunk does not serialize to JSON.");
    }
    snapshot = JSON.parse(serialized);
  } catch {
    throw new TypeError(SERIALIZATION_ERROR_MESSAGE);
  }
  if (snapshot?.schemaVersion !== TELEMETRY_V1_CONTRIBUTION_SCHEMA_VERSION) {
    throw new TypeError(SERIALIZATION_ERROR_MESSAGE);
  }
  try {
    return new TextEncoder().encode(serialized);
  } catch {
    throw new TypeError(SERIALIZATION_ERROR_MESSAGE);
  }
}

export async function createTelemetryV1Envelope({
  chunk,
  publicJwk,
  keyId,
  cryptoImpl = globalThis.crypto,
} = {}) {
  const plaintext = snapshotChunkBytes(chunk);
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== "function") {
    throw new Error("Web Crypto is unavailable in this Node runtime.");
  }
  if (!publicJwk
      || typeof keyId !== "string"
      || !/^key:[A-Za-z0-9._-]{1,64}$/u.test(keyId)) {
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
  const rawPayloadKey = await cryptoImpl.subtle.exportKey("raw", payloadKey);
  const wrappedKey = await cryptoImpl.subtle.encrypt(
    { name: "RSA-OAEP" },
    wrappingKey,
    rawPayloadKey,
  );

  return Object.freeze({
    schemaVersion: TELEMETRY_V1_ENVELOPE_SCHEMA_VERSION,
    synthetic: false,
    keyId,
    wrappedKey: bytesToBase64Url(new Uint8Array(wrappedKey)),
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  });
}
