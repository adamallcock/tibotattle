import { createHash } from "node:crypto";

export const MAXIMUM_WINDOWS_NATIVE_UNSIGNED_CONTENT_BYTES = 128 * 1024 * 1024;

function fail() {
  const error = new Error("Windows native unsigned content is invalid");
  error.code = "WINDOWS_NATIVE_UNSIGNED_CONTENT_INVALID";
  throw error;
}

/**
 * Hash a Windows PE while excluding only fields Authenticode is allowed to
 * rewrite: the checksum, security-directory entry, and appended certificate.
 * A malformed PE, an oversized file, or an embedded certificate is refused.
 */
export function windowsNativeUnsignedContentDigest(bytes) {
  if (!Buffer.isBuffer(bytes)
      || bytes.length < 256
      || bytes.length > MAXIMUM_WINDOWS_NATIVE_UNSIGNED_CONTENT_BYTES
      || bytes.readUInt16LE(0) !== 0x5a4d) {
    fail();
  }
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 64 || pe + 24 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550
      || bytes.readUInt16LE(pe + 4) !== 0x8664) {
    fail();
  }
  const optional = pe + 24;
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const directory = optional + 112;
  if (optionalSize < 152
      || optional + optionalSize > bytes.length
      || bytes.readUInt16LE(optional) !== 0x20b
      || bytes.readUInt32LE(optional + 108) < 5) {
    fail();
  }
  const security = directory + 32;
  const certificateOffset = bytes.readUInt32LE(security);
  const certificateSize = bytes.readUInt32LE(security + 4);
  let end = bytes.length;
  if (certificateOffset !== 0 || certificateSize !== 0) {
    if (certificateOffset < optional + optionalSize
        || certificateOffset % 8 !== 0
        || certificateSize < 8
        || certificateSize % 8 !== 0
        || certificateOffset + certificateSize !== bytes.length) {
      fail();
    }
    end = certificateOffset;
  }
  const unsigned = Buffer.from(bytes.subarray(0, end));
  unsigned.fill(0, optional + 64, optional + 68);
  unsigned.fill(0, security, security + 8);
  return createHash("sha256").update(unsigned).digest("hex");
}
