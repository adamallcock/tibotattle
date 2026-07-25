import { constants, gzipSync, inflateRawSync } from "node:zlib";

export const EXPORT_GZIP_PROFILE = Object.freeze({
  contentEncoding: "gzip",
  profile: "gzip-level-6-v1",
  level: 6,
  strategy: "default",
});

const SAFE_COMPRESSION_CODES = new Set([
  "input",
  "encoded_bytes",
  "decoded_bytes",
  "gzip",
]);

export class ExportCompressionError extends Error {
  constructor(code) {
    if (!SAFE_COMPRESSION_CODES.has(code)) throw new TypeError("Unknown export-compression code");
    super(`Local export compression failed (${code})`);
    this.name = "ExportCompressionError";
    this.code = `export_compression_${code}`;
  }
}

function fail(code) {
  throw new ExportCompressionError(code);
}

function boundedMaximum(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function supportedBytes(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  fail("input");
}

function immutableBytes(value) {
  return Buffer.from(value);
}

function normalizeGzipHeader(artifact) {
  // Node's gzip writer emits no optional header fields. Normalize MTIME and OS
  // explicitly so the stored representation is stable across clock/platform
  // differences without changing the CRC-covered deflate payload.
  if (artifact.length < 18
      || artifact[0] !== 0x1f || artifact[1] !== 0x8b || artifact[2] !== 0x08
      || artifact[3] !== 0x00) fail("gzip");
  artifact.fill(0, 4, 8);
  artifact[9] = 0xff;
  return artifact;
}

const CRC32_TABLE = Object.freeze(Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  return crc >>> 0;
}));

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function assertNormalizedSingleMemberHeader(artifact) {
  if (artifact.length < 18
      || artifact[0] !== 0x1f || artifact[1] !== 0x8b || artifact[2] !== 0x08
      || artifact[3] !== 0x00
      || artifact[4] !== 0x00 || artifact[5] !== 0x00 || artifact[6] !== 0x00 || artifact[7] !== 0x00
      || artifact[8] !== 0x00 || artifact[9] !== 0xff) fail("gzip");
}

export function compressExportBytes(value, {
  maximumDecodedBytes,
  maximumEncodedBytes,
} = {}) {
  const decodedLimit = boundedMaximum(maximumDecodedBytes, "maximumDecodedBytes");
  const encodedLimit = boundedMaximum(maximumEncodedBytes, "maximumEncodedBytes");
  const source = supportedBytes(value);
  if (source.byteLength > decodedLimit) fail("decoded_bytes");
  const input = immutableBytes(source);
  let artifact;
  try {
    artifact = gzipSync(input, {
      level: EXPORT_GZIP_PROFILE.level,
      strategy: constants.Z_DEFAULT_STRATEGY,
    });
  } catch {
    fail("gzip");
  }
  normalizeGzipHeader(artifact);
  if (artifact.length > encodedLimit) fail("encoded_bytes");
  return artifact;
}

export function decompressExportBytes(value, {
  maximumEncodedBytes,
  maximumDecodedBytes,
} = {}) {
  const encodedLimit = boundedMaximum(maximumEncodedBytes, "maximumEncodedBytes");
  const decodedLimit = boundedMaximum(maximumDecodedBytes, "maximumDecodedBytes");
  const source = supportedBytes(value);
  if (source.byteLength > encodedLimit) fail("encoded_bytes");
  const artifact = immutableBytes(source);
  assertNormalizedSingleMemberHeader(artifact);
  let decoded;
  try {
    const inflated = inflateRawSync(artifact.subarray(10, artifact.length - 8), {
      info: true,
      maxOutputLength: decodedLimit,
    });
    decoded = inflated.buffer;
    const trailerOffset = 10 + inflated.engine.bytesWritten;
    if (trailerOffset + 8 !== artifact.length
        || artifact.readUInt32LE(trailerOffset) !== crc32(decoded)
        || artifact.readUInt32LE(trailerOffset + 4) !== (decoded.length >>> 0)) fail("gzip");
  } catch (error) {
    if (error instanceof ExportCompressionError) throw error;
    if (error?.code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|larger than/i.test(String(error?.message))) {
      fail("decoded_bytes");
    }
    fail("gzip");
  }
  if (decoded.length > decodedLimit) fail("decoded_bytes");
  return decoded;
}
