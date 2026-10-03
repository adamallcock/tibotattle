import { timingSafeEqual as nativeTimingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

function asBuffer(value) {
  if (!(value instanceof Uint8Array)) throw new TypeError("TIMING_SAFE_EQUAL_BYTES_INVALID");
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/**
 * Native Node implementation for the shared Worker timing-safe comparison.
 * The unequal-length path still compares the supplied bytes against an equal
 * length dummy buffer before returning false, so callers do not turn the
 * length check into an early content comparison.
 */
export function nodeTimingSafeEqual(left, right) {
  const leftBytes = asBuffer(left);
  const rightBytes = asBuffer(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    nativeTimingSafeEqual(leftBytes, Buffer.alloc(leftBytes.byteLength));
    return false;
  }
  return nativeTimingSafeEqual(leftBytes, rightBytes);
}

export function installNodeTimingSafeEqual(setter) {
  if (typeof setter !== "function") throw new TypeError("TIMING_SAFE_EQUAL_SETTER_INVALID");
  setter(nodeTimingSafeEqual);
}
