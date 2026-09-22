import { createReadStream } from "node:fs";
import { isCompressedRolloutSource, readCompressedRolloutBytes } from "./bounded-rollout-bytes.js";

// Bounded, content-free line reader for Codex rollout JSONL.
//
// Two measured facts shape this module.
//
// 1. The per-byte JavaScript newline loop it replaces was the read bottleneck.
//    `Buffer.prototype.indexOf` drops into a SIMD memchr, and over the local
//    42 GiB rollout corpus that alone was a 5.93x improvement (228.45s ->
//    38.52s).
// 2. Accounting records are usually small, but provider metadata and tool
//    envelopes can exceed the former 64 KiB limit. Retain at most 512 KiB per
//    line; callers can inspect structural headers without retaining the tail.
//    Huge compactions still use only a bounded top-level type/timestamp prefix.
//
// So a line longer than the cap never needs full buffering or parsing. Its
// tail is skipped without concatenation, which is what makes peak memory
// independent of rollout file size — a 15 GiB single file costs no more than a
// 1 MiB one.
//
// "Degrade, don't discard": when a line does exceed the cap, the prefix is
// still delivered with `partial: true` so a caller can classify it and report
// incomplete evidence. An oversized accounting record must not become a fully
// verified accounting source.
export const ROLLOUT_LINE_BYTES = 512 * 1024;

const NEWLINE = 0x0a;

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

/**
 * Read complete newline-delimited lines from `path` between `start` and `end`.
 *
 * `onLine(line, lineEndOffset, partial)` receives a `Buffer` view, not a
 * string. Callers may inspect structural headers as bytes, or decode complete
 * bounded records when full JSON member semantics are required. An oversized
 * suffix is never retained or decoded by this reader.
 *
 * The view handed to `onLine` is only valid for the duration of that call. It
 * may alias the read buffer, which is refilled on the next read.
 */
export async function forEachRolloutLine(path, {
  start = 0,
  end,
  onLine,
  maximumLineBytes = ROLLOUT_LINE_BYTES,
  highWaterMark = 256 * 1024,
  signal = null,
} = {}) {
  if (typeof onLine !== "function") {
    throw new TypeError("onLine must be a function");
  }
  if (!Number.isSafeInteger(start) || start < 0) {
    throw new TypeError("start must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(end) || end < 0) {
    throw new TypeError("end must be a non-negative safe integer");
  }
  positiveSafeInteger(maximumLineBytes, "maximumLineBytes");
  positiveSafeInteger(highWaterMark, "highWaterMark");

  const empty = {
    nextOffset: start,
    partialDeferred: false,
    oversizedLines: 0,
    completeLines: 0,
    aborted: signal?.aborted === true,
  };
  if (end <= start) return empty;

  const callerOwnedHandle = path && typeof path === "object"
    && typeof path.stat === "function" && typeof path.read === "function";
  const compressed = isCompressedRolloutSource(path);
  const input = callerOwnedHandle || compressed
    ? null
    : createReadStream(path, { start, end: end - 1, highWaterMark });
  const chunks = compressed ? readCompressedRolloutBytes(path, {
    start, end, highWaterMark, signal,
  }) : callerOwnedHandle ? {
    async *[Symbol.asyncIterator]() {
      const scratch = Buffer.allocUnsafe(highWaterMark);
      let position = start;
      while (position < end) {
        if (signal?.aborted) return;
        const length = Math.min(highWaterMark, end - position);
        const { bytesRead } = await path.read(
          scratch,
          0,
          length,
          position,
        );
        if (bytesRead === 0) return;
        position += bytesRead;
        // Complete-line callbacks finish before the iterator advances, and
        // `appendSegment` copies only an unterminated tail that must survive a
        // refill. Reuse this allocation without copying every scanned byte.
        yield scratch.subarray(0, bytesRead);
      }
    },
  } : input;

  // Carry state for a line that straddles a chunk boundary. `carry` holds only
  // the bytes below the cap; once `truncated` is set the rest of the line is
  // discarded as it streams past, so an 80 MiB record never allocates.
  let carry = [];
  let carryBytes = 0;
  let truncated = false;
  let absolutePosition = start;
  let nextOffset = start;
  let oversizedLines = 0;
  let completeLines = 0;
  let aborted = false;

  // Appends up to the cap. Returns nothing; over-cap state lives in
  // `truncated` so the discarded suffix costs a length check per segment.
  function appendSegment(segment) {
    if (segment.length === 0) return;
    if (truncated) return;
    const room = maximumLineBytes - carryBytes;
    if (segment.length > room) {
      if (room > 0) {
        carry.push(Buffer.from(segment.subarray(0, room)));
        carryBytes += room;
      }
      truncated = true;
      return;
    }
    // The tail of a chunk must be copied: the stream reuses its buffer, so a
    // view would silently become the *next* chunk's bytes before the line is
    // completed. Never "optimise" this back to a subarray.
    carry.push(Buffer.from(segment));
    carryBytes += segment.length;
  }

  function completeLine(segment) {
    if (carryBytes === 0 && !truncated) {
      // Fast path: the whole line arrived inside one chunk. Hand over a view.
      if (segment.length > maximumLineBytes) {
        truncated = true;
        return segment.subarray(0, maximumLineBytes);
      }
      return segment;
    }
    appendSegment(segment);
    return carry.length === 1 ? carry[0] : Buffer.concat(carry, carryBytes);
  }

  for await (const chunk of chunks) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    let from = 0;
    for (;;) {
      const newline = chunk.indexOf(NEWLINE, from);
      if (newline < 0) break;
      const line = completeLine(chunk.subarray(from, newline));
      const partial = truncated;
      const lineEndOffset = absolutePosition + newline + 1;
      carry = [];
      carryBytes = 0;
      truncated = false;
      completeLines += 1;
      if (partial) oversizedLines += 1;
      const pending = onLine(line, lineEndOffset, partial);
      if (pending !== null
          && (typeof pending === "object" || typeof pending === "function")) {
        if (pending instanceof Promise) {
          await pending;
        } else {
          // Avoid an await/Promise assimilation on the overwhelmingly common
          // synchronous callback path, while still preserving foreign
          // thenable behavior for asynchronous callers.
          const then = pending.then;
          if (typeof then === "function") {
            await {
              then(resolve, reject) {
                Reflect.apply(then, pending, [resolve, reject]);
              },
            };
          }
        }
      }
      nextOffset = lineEndOffset;
      from = newline + 1;
      if (signal?.aborted) {
        aborted = true;
        break;
      }
    }
    if (aborted) break;
    appendSegment(chunk.subarray(from));
    absolutePosition += chunk.length;
  }
  if (aborted) input?.destroy();

  return {
    nextOffset,
    partialDeferred: !aborted && absolutePosition > nextOffset,
    oversizedLines,
    completeLines,
    aborted,
  };
}
