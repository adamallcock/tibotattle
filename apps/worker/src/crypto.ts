import { MAX_PLAINTEXT_BYTES } from "./constants";
import { ApiError } from "./errors";
import type { SyntheticEnvelope } from "./validation";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

interface PublicRsaJwk extends JsonWebKey {
  kty: "RSA";
  kid: string;
  n: string;
  e: string;
}

interface PrivateRsaJwk extends PublicRsaJwk {
  d: string;
}

function parseJwk(raw: string, privateKey: boolean): PublicRsaJwk | PrivateRsaJwk {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ApiError(500, "KEY_CONFIGURATION_INVALID");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(500, "KEY_CONFIGURATION_INVALID");
  }
  const jwk = value as JsonWebKey & Record<string, unknown>;
  if (jwk.kty !== "RSA"
    || typeof jwk.kid !== "string"
    || !/^key:[A-Za-z0-9._-]{1,64}$/.test(jwk.kid)
    || typeof jwk.n !== "string"
    || typeof jwk.e !== "string"
    || (privateKey && typeof jwk.d !== "string")
    || (!privateKey && typeof jwk.d === "string")) {
    throw new ApiError(500, "KEY_CONFIGURATION_INVALID");
  }
  const publicFields: PublicRsaJwk = {
    ...jwk,
    kty: "RSA",
    kid: jwk.kid,
    n: jwk.n,
    e: jwk.e,
  };
  return privateKey
    ? { ...publicFields, d: jwk.d }
    : publicFields;
}

export function publicEnvelopeKey(raw: string): {
  algorithm: "RSA-OAEP-256";
  keyId: string;
  publicJwk: PublicRsaJwk;
} {
  const publicJwk = parseJwk(raw, false);
  return {
    algorithm: "RSA-OAEP-256",
    keyId: publicJwk.kid,
    publicJwk: {
      alg: "RSA-OAEP-256",
      e: publicJwk.e,
      key_ops: ["encrypt"],
      kid: publicJwk.kid,
      kty: "RSA",
      n: publicJwk.n,
      use: "enc",
    },
  };
}

function decodeBase64Url(value: string): Uint8Array {
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new ApiError(400, "ENVELOPE_INVALID");
  }
}

export function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function randomSecret(byteLength = 32): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await sha256(value);
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashCapability(
  capability: "access" | "recovery",
  tokenId: string,
  secret: string,
): Promise<Uint8Array> {
  return sha256(`app-usagemonitor/${capability}/v1\0${tokenId}\0${secret}`);
}

export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    const dummy = new Uint8Array(left.byteLength);
    crypto.subtle.timingSafeEqual(left, dummy);
    return false;
  }
  return crypto.subtle.timingSafeEqual(left, right);
}

export async function decryptSyntheticEnvelope(
  envelope: SyntheticEnvelope,
  publicJwkRaw: string,
  privateJwkRaw: string,
): Promise<unknown> {
  const publicJwk = parseJwk(publicJwkRaw, false);
  const privateJwk = parseJwk(privateJwkRaw, true);
  if (envelope.keyId !== publicJwk.kid || privateJwk.kid !== publicJwk.kid) {
    throw new ApiError(400, "KEY_ID_INVALID");
  }

  let rsaKey: CryptoKey;
  try {
    rsaKey = await crypto.subtle.importKey(
      "jwk",
      privateJwk,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["decrypt"],
    );
  } catch {
    console.warn(JSON.stringify({ event: "envelope_decryption_failed", stage: "private_key_import" }));
    throw new ApiError(400, "DECRYPTION_FAILED");
  }

  let rawDataKey: ArrayBuffer;
  try {
    rawDataKey = await crypto.subtle.decrypt(
      { name: "RSA-OAEP" },
      rsaKey,
      decodeBase64Url(envelope.wrappedKey),
    );
  } catch {
    console.warn(JSON.stringify({ event: "envelope_decryption_failed", stage: "wrapped_key" }));
    throw new ApiError(400, "DECRYPTION_FAILED");
  }
  if (rawDataKey.byteLength !== 32) {
    console.warn(JSON.stringify({ event: "envelope_decryption_failed", stage: "data_key_length" }));
    throw new ApiError(400, "DECRYPTION_FAILED");
  }

  try {
    const aesKey = await crypto.subtle.importKey(
      "raw",
      rawDataKey,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decodeBase64Url(envelope.iv) },
      aesKey,
      decodeBase64Url(envelope.ciphertext),
    );
    if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
      throw new ApiError(413, "BODY_TOO_LARGE");
    }
    return JSON.parse(decoder.decode(plaintext)) as unknown;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.warn(JSON.stringify({ event: "envelope_decryption_failed", stage: "payload" }));
    throw new ApiError(400, "DECRYPTION_FAILED");
  }
}
