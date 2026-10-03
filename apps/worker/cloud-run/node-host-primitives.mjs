import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

// The Cloud Run Node host primitives (Wave 1A): node:crypto's synchronous
// SHA-256 and Buffer's hex encoder. The Cloud Run build resolves
// src/host-primitives.ts and the vendored d43c8f92 crypto.ts to this module
// (nodeHostAliasPlugin in node-host-build.mjs), so both sha256Hex
// implementations hash here instead of awaiting WebCrypto through libuv's
// shared thread pool. The bytes are WebCrypto's: a string is hashed as its
// UTF-8 encoding, which Node and TextEncoder both form per WHATWG (a lone
// surrogate becomes U+FFFD), and any other input as the bytes its view covers.
//
// Runtime only, and inside the analytics kernel compute closure: anything
// here can decide a stored digest. Build tooling lives in node-host-build.mjs
// and the server's timing-safe comparison in node-crypto-adapter.mjs, so an
// edit to either does not change the compute class.

function digestInput(value) {
  if (typeof value === "string" || ArrayBuffer.isView(value)) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("SHA256_INPUT_INVALID");
}

/** host-primitives.ts hostSha256: a fresh 32-byte Uint8Array (never a pooled Buffer view), as WebCrypto returns. */
export function hostSha256(value) {
  return new Uint8Array(createHash("sha256").update(digestInput(value)).digest());
}

/** host-primitives.ts hostSha256Hex: 64 lowercase hex digits from Buffer's encoder. */
export function hostSha256Hex(value) {
  return createHash("sha256").update(digestInput(value)).digest("hex");
}

/** host-primitives.ts hostBytesHex: lowercase hex of bytes[start, end), read in place. */
export function hostBytesHex(bytes, start, end) {
  return Buffer.from(bytes.buffer, bytes.byteOffset + start, end - start).toString("hex");
}

/**
 * The vendored d43c8f92 crypto.ts surface the kernels import (sha256,
 * sha256Hex), with its async signature: the value is already resolved, and a
 * synchronous failure becomes a rejection, as WebCrypto's would. A vendored
 * module importing any other name from ./crypto fails the bundle (esbuild:
 * no matching export), so nothing falls back silently.
 */
export async function sha256(value) {
  return hostSha256(value);
}

export async function sha256Hex(value) {
  return hostSha256Hex(value);
}
