import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";

const DEFAULT_MAXIMUM_LINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_HIGH_WATER_MARK = 256 * 1024;

function defaultLimitError(code) {
  const error = new Error(`Bounded reader stopped at the ${code} resource limit`);
  error.name = "BoundedReaderResourceLimitError";
  error.code = `export_resource_${code}`;
  return error;
}

function validatedLimitErrorFactory(createLimitError) {
  if (typeof createLimitError !== "function") {
    throw new TypeError("createLimitError must be a function");
  }
  return createLimitError;
}

function validAbortSignal(signal) {
  return signal === null
    || (typeof signal === "object"
      && typeof signal.aborted === "boolean"
      && typeof signal.addEventListener === "function");
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Bounded JSONL read aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
}

export async function* readBoundedUtf8LineEntries(path, {
  maximumLineBytes = DEFAULT_MAXIMUM_LINE_BYTES,
  highWaterMark = DEFAULT_HIGH_WATER_MARK,
  resourceGuard = null,
  oversizedIrrelevantNeedles = [],
  maximumTotalBytes = Number.POSITIVE_INFINITY,
  startByte = 0,
  startLineOrdinal = 1,
  signal = null,
  createLimitError = defaultLimitError,
} = {}) {
  const limitError = validatedLimitErrorFactory(createLimitError);
  if (!Number.isSafeInteger(maximumLineBytes) || maximumLineBytes < 1) {
    throw new TypeError("maximumLineBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(highWaterMark) || highWaterMark < 1) {
    throw new TypeError("highWaterMark must be a positive safe integer");
  }
  if (maximumTotalBytes !== Number.POSITIVE_INFINITY
      && (!Number.isSafeInteger(maximumTotalBytes) || maximumTotalBytes < 0)) {
    throw new TypeError("maximumTotalBytes must be a non-negative safe integer or Infinity");
  }
  if (!Number.isSafeInteger(startByte) || startByte < 0
      || !Number.isSafeInteger(startLineOrdinal) || startLineOrdinal < 1
      || (maximumTotalBytes !== Number.POSITIVE_INFINITY && startByte > maximumTotalBytes)) {
    throw new TypeError("Line cursor must use a valid byte offset and positive line ordinal");
  }
  if (!validAbortSignal(signal)) {
    throw new TypeError("signal must be an AbortSignal or null");
  }
  throwIfAborted(signal);
  if (maximumTotalBytes === 0 || startByte === maximumTotalBytes) return;
  const callerOwnedHandle = path && typeof path === "object" && Number.isInteger(path.fd);
  const input = callerOwnedHandle ? null : createReadStream(path, {
    highWaterMark,
    ...(startByte !== 0 ? { start: startByte } : {}),
    ...(maximumTotalBytes === Number.POSITIVE_INFINITY ? {} : { end: maximumTotalBytes - 1 }),
  });
  // A ReadStream can destroy a supplied descriptor when async iteration
  // unwinds after a parser/resource exception, even when descriptor ownership
  // was intended to remain with the caller. Read caller-owned FileHandles
  // positionally so post-read integrity verification always retains its exact
  // descriptor and the original exception cannot be masked by EBADF.
  const chunksInput = callerOwnedHandle ? {
    async *[Symbol.asyncIterator]() {
      let position = startByte;
      while (position < maximumTotalBytes) {
        throwIfAborted(signal);
        const remaining = maximumTotalBytes === Number.POSITIVE_INFINITY
          ? highWaterMark
          : Math.min(highWaterMark, maximumTotalBytes - position);
        const buffer = Buffer.allocUnsafe(remaining);
        const { bytesRead } = await path.read(buffer, 0, remaining, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        yield bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
      }
    },
  } : input;
  let chunks = [];
  let lineBytes = 0;
  let oversized = false;
  let oversizedRelevant = false;
  let searchTail = Buffer.alloc(0);
  let absoluteOffset = startByte;
  let lineStartByte = startByte;
  let lineOrdinal = startLineOrdinal;
  const needles = oversizedIrrelevantNeedles.map((needle) => {
    if (typeof needle !== "string" || needle.length === 0 || needle.length > 256) {
      throw new TypeError("Oversized-line relevance needles must be bounded strings");
    }
    return Buffer.from(needle, "utf8");
  });
  const maximumNeedleBytes = needles.reduce((maximum, needle) => Math.max(maximum, needle.length), 0);

  function inspectRelevance(segment) {
    if (oversizedRelevant || needles.length === 0 || segment.length === 0) return;
    const searchable = searchTail.length === 0 ? segment : Buffer.concat([searchTail, segment]);
    oversizedRelevant = needles.some((needle) => searchable.indexOf(needle) !== -1);
    const tailBytes = Math.min(Math.max(0, maximumNeedleBytes - 1), searchable.length);
    searchTail = tailBytes === 0 ? Buffer.alloc(0) : Buffer.from(searchable.subarray(searchable.length - tailBytes));
  }

  function append(segment) {
    if (segment.length === 0) return;
    lineBytes += segment.length;
    if (oversized) {
      inspectRelevance(segment);
      return;
    }
    if (lineBytes > maximumLineBytes) {
      if (needles.length === 0) {
        input?.destroy();
        throw limitError("line_bytes");
      }
      oversized = true;
      for (const chunk of chunks) inspectRelevance(chunk);
      inspectRelevance(segment);
      chunks = [];
      return;
    }
    chunks.push(segment);
  }

  function completeLine(endByteExclusive) {
    const entry = { startByte: lineStartByte, endByteExclusive, lineOrdinal };
    lineStartByte = endByteExclusive;
    lineOrdinal += 1;
    if (oversized) {
      if (oversizedRelevant) throw limitError("line_bytes");
      resourceGuard?.observeLine(lineBytes, { oversizedIrrelevant: true });
      chunks = [];
      lineBytes = 0;
      oversized = false;
      oversizedRelevant = false;
      searchTail = Buffer.alloc(0);
      return { ...entry, line: null };
    }
    resourceGuard?.observeLine(lineBytes);
    const line = Buffer.concat(chunks, lineBytes).toString("utf8");
    chunks = [];
    lineBytes = 0;
    return { ...entry, line: line.endsWith("\r") ? line.slice(0, -1) : line };
  }

  for await (const chunk of chunksInput) {
    throwIfAborted(signal);
    resourceGuard?.checkRuntime();
    if (absoluteOffset + chunk.length > maximumTotalBytes) {
      input?.destroy();
      throw limitError("source_bytes");
    }
    let start = 0;
    let index = chunk.indexOf(0x0a, start);
    while (index !== -1) {
      throwIfAborted(signal);
      append(chunk.subarray(start, index));
      yield completeLine(absoluteOffset + index + 1);
      start = index + 1;
      index = chunk.indexOf(0x0a, start);
    }
    append(chunk.subarray(start));
    absoluteOffset += chunk.length;
  }
  if (lineBytes > 0) yield completeLine(absoluteOffset);
}

export async function* readBoundedUtf8Lines(path, options = {}) {
  for await (const entry of readBoundedUtf8LineEntries(path, options)) yield entry.line;
}

export async function readBoundedJsonLines(path, {
  maximumFileBytes,
  maximumLineBytes = DEFAULT_MAXIMUM_LINE_BYTES,
  maximumRecords,
  resourceGuard = null,
  signal = null,
  createLimitError = defaultLimitError,
} = {}) {
  const limitError = validatedLimitErrorFactory(createLimitError);
  if (!Number.isSafeInteger(maximumFileBytes) || maximumFileBytes < 1
      || !Number.isSafeInteger(maximumRecords) || maximumRecords < 1) {
    throw new TypeError("Bounded JSONL file and record limits must be positive safe integers");
  }
  if (!validAbortSignal(signal)) {
    throw new TypeError("signal must be an AbortSignal or null");
  }
  throwIfAborted(signal);
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Local metadata input must be a regular file");
  if (stats.size > maximumFileBytes) throw limitError("source_bytes");
  resourceGuard?.observeSourceFile(stats.size);
  const records = [];
  for await (const line of readBoundedUtf8Lines(path, {
    maximumLineBytes,
    maximumTotalBytes: maximumFileBytes,
    resourceGuard,
    signal,
    createLimitError: limitError,
  })) {
    throwIfAborted(signal);
    if (!line.trim()) continue;
    if (records.length >= maximumRecords) throw limitError("output_records");
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error("Local metadata input contains invalid JSON");
    }
  }
  return records;
}
