import {
  parseTelemetryV11Chunk,
  validateTelemetryV11Envelope,
  TELEMETRY_V11_ENVELOPE_SCHEMA_VERSION,
} from "@app-usagemonitor/telemetry-contract";

/** Same reviewed RSA-OAEP/AES-GCM construction; v1.0 bytes stay untouched. */
export async function createTelemetryV11Envelope({
  chunk, publicJwk, keyId, cryptoImpl = globalThis.crypto,
} = {}) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== "function") {
    throw new Error("Web Crypto is unavailable in this Node runtime.");
  }
  if (!publicJwk || typeof keyId !== "string" || !/^key:[A-Za-z0-9._-]{1,64}$/u.test(keyId)) {
    throw new TypeError("A public JWK and key ID are required.");
  }
  let plaintext;
  try { plaintext = new TextEncoder().encode(JSON.stringify(parseTelemetryV11Chunk(chunk))); }
  catch { throw new TypeError("Telemetry chunk serialization failed."); }
  let rawPayloadKey;
  try {
    const wrappingKey = await cryptoImpl.subtle.importKey("jwk", publicJwk,
      { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
    const payloadKey = await cryptoImpl.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
    const ciphertext = await cryptoImpl.subtle.encrypt({ name: "AES-GCM", iv }, payloadKey, plaintext);
    rawPayloadKey = new Uint8Array(await cryptoImpl.subtle.exportKey("raw", payloadKey));
    const wrappedKey = await cryptoImpl.subtle.encrypt({ name: "RSA-OAEP" }, wrappingKey, rawPayloadKey);
    return Object.freeze(validateTelemetryV11Envelope({
      schemaVersion: TELEMETRY_V11_ENVELOPE_SCHEMA_VERSION, synthetic: false, keyId,
      wrappedKey: Buffer.from(wrappedKey).toString("base64url"),
      iv: Buffer.from(iv).toString("base64url"), ciphertext: Buffer.from(ciphertext).toString("base64url"),
    }));
  } finally {
    plaintext.fill(0);
    rawPayloadKey?.fill(0);
  }
}
