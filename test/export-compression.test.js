import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  compressExportBytes,
  decompressExportBytes,
  EXPORT_GZIP_PROFILE,
} from "../src/export-compression.js";

const LIMITS = Object.freeze({
  maximumDecodedBytes: 1024 * 1024,
  maximumEncodedBytes: 1024 * 1024 + 1024,
});

test("gzip profile produces deterministic normalized binary artifacts", () => {
  const input = Buffer.from('{"canonical":"value","records":[1,2,3]}');
  const first = compressExportBytes(input, LIMITS);
  const second = compressExportBytes(new Uint8Array(input), LIMITS);
  assert.deepEqual(first, second);
  assert.equal(first.subarray(4, 8).equals(Buffer.alloc(4)), true);
  assert.equal(first[9], 0xff);
  assert.deepEqual(decompressExportBytes(first, LIMITS), input);
  assert.deepEqual(EXPORT_GZIP_PROFILE, {
    contentEncoding: "gzip",
    profile: "gzip-level-6-v1",
    level: 6,
    strategy: "default",
  });
});

test("a Node 20 zlib 1.2.13 artifact preserves semantic bytes without recompression", () => {
  const input = Buffer.from("The quick brown fox jumps over the lazy dog. ");
  const artifact = Buffer.from(
    "H4sIAAAAAAAA/wvJSFUoLM1MzlZIKsovz1NIy69QyCrNLShWyC9LLVIoAUrnJFZVKqTkp+spAAC8BeswLQAAAA==",
    "base64",
  );
  assert.equal(
    createHash("sha256").update(artifact).digest("hex"),
    "84a34efe6e2bbf5b3af957fcc93ed863a69c238d8ee2cd91cd1efa0e93170de2",
  );
  assert.deepEqual(decompressExportBytes(artifact, LIMITS), input);
  // Compressed bytes are authenticated stored representation, not a
  // cross-zlib semantic identity. Do not recompress to verify this fixture.
});

test("compression preserves arbitrary bytes including NUL and non-UTF8", () => {
  const input = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x00, 0x80]);
  const artifact = compressExportBytes(input, LIMITS);
  assert.deepEqual(decompressExportBytes(artifact, LIMITS), input);
});

test("compression rejects unsupported input and independent byte ceilings", () => {
  assert.throws(
    () => compressExportBytes("text is not an explicit byte sequence", LIMITS),
    (error) => error.code === "export_compression_input",
  );
  assert.throws(
    () => compressExportBytes(Buffer.alloc(10), { maximumDecodedBytes: 9, maximumEncodedBytes: 100 }),
    (error) => error.code === "export_compression_decoded_bytes",
  );
  assert.throws(
    () => compressExportBytes(Buffer.from("not very compressible"), {
      maximumDecodedBytes: 100,
      maximumEncodedBytes: 5,
    }),
    (error) => error.code === "export_compression_encoded_bytes",
  );
  const artifact = compressExportBytes(Buffer.from("bounded"), LIMITS);
  assert.throws(
    () => decompressExportBytes(artifact, { maximumEncodedBytes: artifact.length - 1, maximumDecodedBytes: 100 }),
    (error) => error.code === "export_compression_encoded_bytes",
  );
});

test("oversized byte inputs fail before the defensive copy", () => {
  const oversized = Buffer.alloc(64 * 1024);
  const originalFrom = Buffer.from;
  let oversizedCopies = 0;
  Buffer.from = function instrumentedFrom(value, ...rest) {
    if (value === oversized) oversizedCopies += 1;
    return originalFrom(value, ...rest);
  };
  try {
    assert.throws(
      () => compressExportBytes(oversized, { maximumDecodedBytes: 1, maximumEncodedBytes: 1 }),
      (error) => error.code === "export_compression_decoded_bytes",
    );
    assert.throws(
      () => decompressExportBytes(oversized, { maximumEncodedBytes: 1, maximumDecodedBytes: 1 }),
      (error) => error.code === "export_compression_encoded_bytes",
    );
    assert.equal(oversizedCopies, 0);
  } finally {
    Buffer.from = originalFrom;
  }
});

test("decompression bounds bombs and concatenated gzip members", () => {
  const bomb = compressExportBytes(Buffer.alloc(64 * 1024, 0x61), {
    maximumDecodedBytes: 64 * 1024,
    maximumEncodedBytes: 1024,
  });
  assert.throws(
    () => decompressExportBytes(bomb, { maximumEncodedBytes: 1024, maximumDecodedBytes: 1024 }),
    (error) => error.code === "export_compression_decoded_bytes",
  );

  const left = compressExportBytes(Buffer.alloc(700, 0x61), LIMITS);
  const right = compressExportBytes(Buffer.alloc(700, 0x62), LIMITS);
  const concatenated = Buffer.concat([left, right]);
  assert.throws(
    () => decompressExportBytes(concatenated, {
      maximumEncodedBytes: concatenated.length,
      maximumDecodedBytes: 1024,
    }),
    (error) => error.code === "export_compression_decoded_bytes",
  );
});

test("corrupt and truncated gzip artifacts fail with content-free codes", () => {
  const artifact = compressExportBytes(Buffer.from("private source content"), LIMITS);
  const corrupt = Buffer.from(artifact);
  corrupt[corrupt.length - 1] ^= 0xff;
  for (const candidate of [corrupt, artifact.subarray(0, artifact.length - 3)]) {
    assert.throws(
      () => decompressExportBytes(candidate, LIMITS),
      (error) => error.code === "export_compression_gzip"
        && !error.message.includes("private source content"),
    );
  }
});
