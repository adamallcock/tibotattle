import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { ExportResourceLimitError } from "./export-resource-policy.js";

const DEFAULT_MAXIMUM_LINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_HIGH_WATER_MARK = 256 * 1024;

export async function* readBoundedUtf8Lines(path, {
  maximumLineBytes = DEFAULT_MAXIMUM_LINE_BYTES,
  highWaterMark = DEFAULT_HIGH_WATER_MARK,
  resourceGuard = null,
  oversizedIrrelevantNeedles = [],
  maximumTotalBytes = Number.POSITIVE_INFINITY,
} = {}) {
  if (!Number.isSafeInteger(maximumLineBytes) || maximumLineBytes < 1) {
    throw new TypeError("maximumLineBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(highWaterMark) || highWaterMark < 1) {
    throw new TypeError("highWaterMark must be a positive safe integer");
  }
  if (maximumTotalBytes !== Number.POSITIVE_INFINITY
      && (!Number.isSafeInteger(maximumTotalBytes) || maximumTotalBytes < 1)) {
    throw new TypeError("maximumTotalBytes must be a positive safe integer or Infinity");
  }
  const input = createReadStream(path, { highWaterMark });
  let chunks = [];
  let lineBytes = 0;
  let oversized = false;
  let oversizedRelevant = false;
  let searchTail = Buffer.alloc(0);
  let totalBytes = 0;
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
        input.destroy();
        throw new ExportResourceLimitError("line_bytes");
      }
      oversized = true;
      for (const chunk of chunks) inspectRelevance(chunk);
      inspectRelevance(segment);
      chunks = [];
      return;
    }
    chunks.push(segment);
  }

  function completeLine() {
    if (oversized) {
      if (oversizedRelevant) throw new ExportResourceLimitError("line_bytes");
      resourceGuard?.observeLine(lineBytes, { oversizedIrrelevant: true });
      chunks = [];
      lineBytes = 0;
      oversized = false;
      oversizedRelevant = false;
      searchTail = Buffer.alloc(0);
      return null;
    }
    resourceGuard?.observeLine(lineBytes);
    const line = Buffer.concat(chunks, lineBytes).toString("utf8");
    chunks = [];
    lineBytes = 0;
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  }

  for await (const chunk of input) {
    resourceGuard?.checkRuntime();
    totalBytes += chunk.length;
    if (totalBytes > maximumTotalBytes) {
      input.destroy();
      throw new ExportResourceLimitError("source_bytes");
    }
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      append(chunk.subarray(start, index));
      yield completeLine();
      start = index + 1;
    }
    append(chunk.subarray(start));
  }
  if (lineBytes > 0) yield completeLine();
}

export async function readBoundedJsonLines(path, {
  maximumFileBytes,
  maximumLineBytes = DEFAULT_MAXIMUM_LINE_BYTES,
  maximumRecords,
  resourceGuard = null,
} = {}) {
  if (!Number.isSafeInteger(maximumFileBytes) || maximumFileBytes < 1
      || !Number.isSafeInteger(maximumRecords) || maximumRecords < 1) {
    throw new TypeError("Bounded JSONL file and record limits must be positive safe integers");
  }
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Local metadata input must be a regular file");
  if (stats.size > maximumFileBytes) throw new ExportResourceLimitError("source_bytes");
  resourceGuard?.observeSourceFile(stats.size);
  const records = [];
  for await (const line of readBoundedUtf8Lines(path, {
    maximumLineBytes,
    maximumTotalBytes: maximumFileBytes,
    resourceGuard,
  })) {
    if (!line.trim()) continue;
    if (records.length >= maximumRecords) throw new ExportResourceLimitError("output_records");
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error("Local metadata input contains invalid JSON");
    }
  }
  return records;
}
