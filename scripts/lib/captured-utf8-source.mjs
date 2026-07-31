import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { TextDecoder } from "node:util";

const DEFAULT_MAXIMUM_BYTES = 1024 * 1024;

function fixedFailure(message) {
  const error = new Error(message);
  error.code = "CAPTURED_UTF8_SOURCE_INVALID";
  return error;
}

function isSingleRegularFile(metadata, maximumBytes) {
  return metadata.isFile()
    && !metadata.isSymbolicLink()
    && metadata.nlink === 1n
    && metadata.size >= 0n
    && metadata.size <= BigInt(maximumBytes);
}

function hasStableIdentity(metadata) {
  return typeof metadata.dev === "bigint"
    && typeof metadata.ino === "bigint"
    && metadata.ino !== 0n;
}

function sameIdentity(left, right) {
  return hasStableIdentity(left)
    && hasStableIdentity(right)
    && left.dev === right.dev
    && left.ino === right.ino;
}

function sameStableMetadata(left, right) {
  return sameIdentity(left, right)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function readExactBounded(handle, expectedSize) {
  const bytes = Buffer.alloc(expectedSize);
  let offset = 0;
  while (offset < expectedSize) {
    const length = Math.min(64 * 1024, expectedSize - offset);
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      length,
      offset,
    );
    if (bytesRead < 1) throw new Error();
    offset += bytesRead;
  }
  const probe = Buffer.alloc(1);
  const { bytesRead: probeBytesRead } = await handle.read(
    probe,
    0,
    1,
    expectedSize,
  );
  if (probeBytesRead !== 0) throw new Error();
  return bytes;
}

/**
 * Capture one reviewed UTF-8 source through a stable open descriptor.
 *
 * The failpoint is intentionally zero-argument: it can coordinate a test-only
 * pathname swap, but cannot inspect a path, descriptor, metadata, or bytes.
 */
export async function captureStableUtf8Source(path, {
  failureMessage = "Reviewed UTF-8 source capture failed",
  maximumBytes = DEFAULT_MAXIMUM_BYTES,
  postOpenPreReadFailpoint = null,
} = {}) {
  if (typeof path !== "string"
      || path.length === 0
      || typeof failureMessage !== "string"
      || failureMessage.length === 0
      || !Number.isSafeInteger(maximumBytes)
      || maximumBytes < 1
      || (postOpenPreReadFailpoint !== null
        && typeof postOpenPreReadFailpoint !== "function")) {
    throw fixedFailure("Reviewed UTF-8 source capture options are invalid");
  }

  let handle = null;
  let result = null;
  let failed = false;
  try {
    try {
      const prePath = await lstat(path, { bigint: true });
      if (!isSingleRegularFile(prePath, maximumBytes)) throw new Error();

      handle = await open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const preHandle = await handle.stat({ bigint: true });
      if (!isSingleRegularFile(preHandle, maximumBytes)
          || !sameStableMetadata(prePath, preHandle)) {
        throw new Error();
      }

      if (postOpenPreReadFailpoint !== null) {
        await postOpenPreReadFailpoint();
      }
      const expectedSize = Number(preHandle.size);
      const bytes = await readExactBounded(handle, expectedSize);
      const postHandle = await handle.stat({ bigint: true });
      const postPath = await lstat(path, { bigint: true });
      if (!isSingleRegularFile(postHandle, maximumBytes)
          || !isSingleRegularFile(postPath, maximumBytes)
          || !sameStableMetadata(preHandle, postHandle)
          || !sameStableMetadata(postHandle, postPath)
          || BigInt(bytes.byteLength) !== postHandle.size) {
        throw new Error();
      }

      const sourceText = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
      if (!Buffer.from(sourceText, "utf8").equals(bytes)) {
        throw new Error();
      }
      result = Object.freeze({
        byteLength: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sourceText,
      });
    } catch {
      failed = true;
    }
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        failed = true;
      }
    }
  }
  if (failed || result === null) throw fixedFailure(failureMessage);
  return result;
}
