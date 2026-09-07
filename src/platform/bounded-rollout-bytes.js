import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { createHash } from "node:crypto";

// These are hard safety ceilings, independent of each consumer's narrower
// line, source, and runtime budgets. No decompressed content is written to disk.
export const COMPRESSED_ROLLOUT_LIMITS = Object.freeze({
  maximumCompressedBytes: 2 * 1024 ** 3,
  maximumDecompressedBytes: 16 * 1024 ** 3,
  maximumExpansionRatio: 4096,
  minimumExpansionAllowance: 64 * 1024 ** 2,
  maximumRuntimeMs: 120_000,
  maximumWindowLog: 27,
});

export function supportsCompressedRollouts() {
  // Namespace access keeps import compatible with Node 22.13, whose zlib
  // module predates Zstd. Unsupported runtimes retain explicit partial coverage.
  return typeof zlib.createZstdDecompress === "function";
}

export function isCompressedRolloutSource(source) {
  return typeof source === "string"
    ? source.endsWith(".jsonl.zst")
    : source?.compression === "zstd";
}

export function compressedRolloutHandle(handle) {
  return Object.freeze({
    compression: "zstd",
    fd: handle.fd,
    read: (...args) => handle.read(...args),
    stat: (...args) => handle.stat(...args),
    close: () => handle.close(),
  });
}

function readError(code) {
  const error = new Error("Compressed Codex rollout could not be read safely");
  error.name = "CompressedRolloutReadError";
  error.code = code;
  if (code === "codex_rollout_source_changed") error.retryable = true;
  return error;
}

function abortIfNeeded(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Compressed Codex rollout read aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
}

function samePhysicalState(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs && left.birthtimeMs === right.birthtimeMs;
}

function assertRegularOwned(stats) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())) {
    throw readError("codex_rollout_source_changed");
  }
}

// Native Zstd on supported Node versions can finish successfully for truncated
// input (including returning no output). Independently validate frame/block
// boundaries; never infer completeness merely from the decoder ending. This
// tracks at most 18 header bytes and skips block bodies without retaining them.
class ZstdFrameBoundaries {
  constructor(maximumOutputBytes, maximumWindowLog, createLimitError) {
    this.maximumOutputBytes = BigInt(maximumOutputBytes);
    this.maximumWindowBytes = 2 ** maximumWindowLog;
    this.createLimitError = createLimitError;
    this.header = Buffer.alloc(18);
    this.headerBytes = 0;
    this.state = "magic";
    this.needed = 4;
    this.skipBytes = 0;
    this.frames = 0;
    this.checksum = false;
    this.lastBlock = false;
  }

  next(state, needed) {
    this.state = state;
    this.needed = needed;
    this.headerBytes = 0;
  }

  blockEnded() {
    if (!this.lastBlock) this.next("block", 3);
    else if (this.checksum) this.next("checksum", 4);
    else this.next("magic", 4);
  }

  push(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.skipBytes > 0) {
        const length = Math.min(this.skipBytes, chunk.length - offset);
        this.skipBytes -= length;
        offset += length;
        if (this.skipBytes === 0) {
          if (this.state === "body") this.blockEnded();
          else this.next("magic", 4);
        }
        continue;
      }
      const length = Math.min(this.needed - this.headerBytes, chunk.length - offset);
      chunk.copy(this.header, this.headerBytes, offset, offset + length);
      this.headerBytes += length;
      offset += length;
      if (this.headerBytes !== this.needed) continue;
      if (this.state === "magic") {
        const magic = this.header.readUInt32LE(0);
        if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) this.next("skippable", 4);
        else if (magic === 0xfd2fb528) this.next("descriptor", 1);
        else throw readError("codex_rollout_content_invalid");
      } else if (this.state === "descriptor") {
        const descriptor = this.header[0];
        if ((descriptor & 8) !== 0) throw readError("codex_rollout_content_invalid");
        this.checksum = (descriptor & 4) !== 0;
        const singleSegment = (descriptor & 32) !== 0;
        this.singleSegment = singleSegment;
        this.contentSizeBytes = [singleSegment ? 1 : 0, 2, 4, 8][descriptor >> 6];
        this.contentSizeOffset = (singleSegment ? 0 : 1) + [0, 1, 2, 4][descriptor & 3];
        this.next("frameHeader", this.contentSizeOffset + this.contentSizeBytes);
        if (this.needed === 0) this.next("block", 3);
      } else if (this.state === "frameHeader") {
        if (!this.singleSegment) {
          const descriptor = this.header[0];
          const windowBase = 2 ** (10 + (descriptor >> 3));
          if (windowBase + (windowBase / 8) * (descriptor & 7) > this.maximumWindowBytes) {
            throw this.createLimitError("source_bytes");
          }
        }
        if (this.contentSizeBytes > 0) {
          let size = 0n;
          for (let index = this.contentSizeBytes - 1; index >= 0; index -= 1) {
            size = size * 256n + BigInt(this.header[this.contentSizeOffset + index]);
          }
          if (this.contentSizeBytes === 2) size += 256n;
          if (size > this.maximumOutputBytes
              || (this.singleSegment && size > BigInt(this.maximumWindowBytes))) {
            throw this.createLimitError("source_bytes");
          }
        }
        this.next("block", 3);
      } else if (this.state === "block") {
        const header = this.header.readUIntLE(0, 3);
        const type = (header >> 1) & 3;
        const size = header >>> 3;
        if (type === 3 || size > 128 * 1024) throw readError("codex_rollout_content_invalid");
        this.lastBlock = (header & 1) !== 0;
        if (this.lastBlock) this.frames += 1;
        this.state = "body";
        this.skipBytes = type === 1 ? 1 : size;
        if (this.skipBytes === 0) this.blockEnded();
      } else if (this.state === "checksum") {
        this.next("magic", 4);
      } else if (this.state === "skippable") {
        this.skipBytes = this.header.readUInt32LE(0);
        this.state = "skipBody";
        if (this.skipBytes === 0) this.next("magic", 4);
      }
    }
  }

  finish() {
    if (this.frames < 1 || this.state !== "magic" || this.headerBytes !== 0) {
      throw readError("codex_rollout_content_invalid");
    }
  }
}

/** Yield decompressed bytes at logical offsets; descriptor ownership is retained.
 * Bounded prefix readers may stop early. A reader consumed to EOF validates all
 * frames, checksums and the immutable physical source before it succeeds.
 */
export async function* readCompressedRolloutBytes(source, {
  start = 0,
  end = Number.POSITIVE_INFINITY,
  highWaterMark = 256 * 1024,
  signal = null,
  resourceGuard = null,
  limits = COMPRESSED_ROLLOUT_LIMITS,
  createLimitError = (code) => readError(`export_resource_${code}`),
} = {}) {
  if (!Number.isSafeInteger(start) || start < 0
      || (end !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(end) || end < start))
      || !Number.isSafeInteger(highWaterMark) || highWaterMark < 1
      || highWaterMark > 1024 * 1024) {
    throw new TypeError("Compressed rollout byte range is invalid");
  }
  if (typeof createLimitError !== "function") throw new TypeError("Compressed rollout error factory is invalid");
  for (const key of Object.keys(COMPRESSED_ROLLOUT_LIMITS)) {
    if (!Number.isSafeInteger(limits?.[key]) || limits[key] < 1
        || limits[key] > COMPRESSED_ROLLOUT_LIMITS[key]) {
      throw new TypeError("Compressed rollout limits are invalid");
    }
  }
  abortIfNeeded(signal);
  if (!supportsCompressedRollouts()) throw readError("codex_rollout_compression_unsupported");
  const owned = typeof source === "string";
  let handle;
  let input;
  let decoder;
  let pumping;
  let pumpError = null;
  const startedAt = performance.now();
  function check() {
    abortIfNeeded(signal);
    resourceGuard?.checkRuntime();
    if (performance.now() - startedAt > limits.maximumRuntimeMs) {
      throw createLimitError("elapsed_time");
    }
  }
  try {
    handle = owned
      ? await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      : source;
    const before = await handle.stat();
    assertRegularOwned(before);
    if (owned && !samePhysicalState(before, await lstat(source))) {
      throw readError("codex_rollout_source_changed");
    }
    if (before.size > limits.maximumCompressedBytes) throw createLimitError("source_bytes");
    const expansionBound = Math.min(limits.maximumDecompressedBytes,
      Math.max(limits.minimumExpansionAllowance, before.size * limits.maximumExpansionRatio));
    const frameBoundaries = new ZstdFrameBoundaries(expansionBound, limits.maximumWindowLog, createLimitError);
    input = Readable.from((async function* () {
      let offset = 0;
      while (offset < before.size) {
        check();
        // A stream may retain the chunk after write(), so unlike positional
        // line readers this buffer must not be reused for the next read.
        const buffer = Buffer.allocUnsafe(Math.min(highWaterMark, before.size - offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (bytesRead !== buffer.length) throw readError("codex_rollout_source_changed");
        offset += bytesRead;
        frameBoundaries.push(buffer);
        yield buffer;
      }
      frameBoundaries.finish();
    })(), { highWaterMark: 1, objectMode: false });
    decoder = zlib.createZstdDecompress({
      chunkSize: Math.max(64, highWaterMark),
      highWaterMark,
      params: { [zlib.constants.ZSTD_d_windowLogMax]: limits.maximumWindowLog },
    });
    // Capture immediately: malformed input can reject while the consumer is
    // paused at a yielded chunk. Never emit unhandled rejections or raw errors.
    pumping = pipeline(input, decoder, ...(signal ? [{ signal }] : []))
      .catch((error) => { pumpError = error; });
    let offset = 0;
    for await (const chunk of decoder) {
      check();
      const next = offset + chunk.length;
      if (next > expansionBound) throw createLimitError("source_bytes");
      if (next > start && offset < end) {
        yield chunk.subarray(Math.max(0, start - offset), Math.min(chunk.length, end - offset));
      }
      offset = next;
    }
    await pumping;
    if (pumpError) throw pumpError;
    check();
    const after = await handle.stat();
    assertRegularOwned(after);
    if (!samePhysicalState(before, after)
        || (owned && !samePhysicalState(after, await lstat(source)))) {
      throw readError("codex_rollout_source_changed");
    }
  } catch (error) {
    if (error?.name === "AbortError"
        || error?.name === "CompressedRolloutReadError"
        || (typeof error?.code === "string" && error.code.startsWith("export_resource_"))) throw error;
    throw readError("codex_rollout_content_invalid");
  } finally {
    input?.destroy();
    decoder?.destroy();
    await pumping;
    if (owned) await handle?.close().catch(() => {});
  }
}

export async function inspectCompressedRollout(source, {
  maximumPrefixBytes = 1024 * 1024,
  ...options
} = {}) {
  if (!Number.isSafeInteger(maximumPrefixBytes) || maximumPrefixBytes < 1
      || maximumPrefixBytes > 1024 * 1024) throw new TypeError("Compressed rollout prefix limit is invalid");
  const digest = createHash("sha256");
  const prefix = [];
  let size = 0;
  let prefixBytes = 0;
  let lastByte = null;
  for await (const chunk of readCompressedRolloutBytes(source, options)) {
    digest.update(chunk);
    size += chunk.length;
    lastByte = chunk[chunk.length - 1] ?? lastByte;
    if (prefixBytes < maximumPrefixBytes) {
      const part = chunk.subarray(0, maximumPrefixBytes - prefixBytes);
      prefix.push(Buffer.from(part));
      prefixBytes += part.length;
    }
  }
  return { size, sha256: digest.digest("hex"), lastByte,
    prefix: Buffer.concat(prefix, prefixBytes) };
}
