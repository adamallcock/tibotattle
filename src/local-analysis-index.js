import {
  createHmac,
  randomBytes,
} from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import {
  isValidQuotaWindowDuration,
} from "@app-usagemonitor/quota-analysis";
import {
  canonicalComponents,
  createLeadingRateLimitGate,
  deltaComponentPresence,
  discoverCodexRolloutInfos,
  sameUsage,
  subtractUsage,
} from "./codex-log-scan.js";
import { stableJson } from "./export/index.js";

export const LOCAL_ANALYSIS_INDEX_SCHEMA_VERSION =
  "local-analysis-index-v5";
// Bumped when extraction or index semantics change. v3 gated quota admission;
// v4 stops the chunk reader from rebuilding a record out of a reused buffer, so
// every index built before it is missing whichever records happened to straddle
// a read boundary; v5 keeps provider-reported quota duration in the leading
// window identity and refuses out-of-range cached quota facts.
export const LOCAL_ANALYSIS_INDEX_PARSER_VERSION =
  "parallel-jsonl-accounting-v5";

const INDEX_APPLICATION_ID = 0x554d4149;
const INDEX_USER_VERSION = 5;
const DEFAULT_CHUNK_BYTES = 64 * 1024 * 1024;
const MAXIMUM_WORKERS = 10;
const BOUNDARY_BYTES = 4 * 1024;
const COMPONENT_KEYS = Object.freeze([
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
]);
const DIAGNOSTIC_DEFAULTS = Object.freeze({
  filesScanned: 0,
  lineageParentsMissing: 0,
  malformedLines: 0,
  malformedTimestamps: 0,
  malformedUsageRecords: 0,
  tokenCountRecords: 0,
  snapshotKeysStored: 0,
  reassembledLineMismatches: 0,
  impossibleSnapshotSets: 0,
  missingRateLimitRecords: 0,
  malformedRateLimitRecords: 0,
  rateLimitSnapshots: 0,
  contradictedLeadingSnapshotsSkipped: 0,
  lastVsCumulativeMismatches: 0,
  duplicateSnapshotsSkipped: 0,
  replayedEventsSkipped: 0,
  forkReplayEventsSkipped: 0,
  unattributedForkReplayEventsSkipped: 0,
  replayedToolCallsSkipped: 0,
  lastOnlyEvents: 0,
  excludedRollouts: 0,
  malformedTaskEvents: 0,
  activeTaskRolloutsAtEnd: 0,
  tierSettingEvents: 0,
  malformedTierSettingEvents: 0,
  tierSettingCounts: {},
  rolloutsBySurface: {},
  rolloutsByThreadSource: {},
  rolloutsByAgentScope: {},
});
const COMPACT_SEQUENCE_VERSION = 1;
const SOURCE_INDEX_STATES = new Set(["pending", "complete"]);
const COVERAGE_BLOCK_REASONS = new Set([
  "directory_entries",
  "rollout_files",
  "interrupted",
  "timeout",
  "disk_space",
  "storage_unavailable",
]);

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validAbortSignal(signal) {
  return signal === null
    || (typeof signal === "object"
      && typeof signal.aborted === "boolean"
      && typeof signal.addEventListener === "function");
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = fixedError("local_analysis_index_aborted");
  error.name = "AbortError";
  throw error;
}

function hmac(secret, domain, subject) {
  const digest = createHmac("sha256", secret)
    .update(`app-usagemonitor/${domain}/v1\0`);
  digest.update(
    typeof subject === "string" || ArrayBuffer.isView(subject)
      ? subject
      : stableJson(subject),
  );
  return digest.digest("hex");
}

function appendVarint(target, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw fixedError("local_analysis_compact_value_invalid");
  }
  let remaining = value;
  while (remaining >= 0x80) {
    target.push((remaining % 0x80) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  target.push(remaining);
}

function readVarint(buffer, cursor) {
  let value = 0;
  let multiplier = 1;
  let offset = cursor;
  while (offset < buffer.length) {
    const byte = buffer[offset];
    value += (byte & 0x7f) * multiplier;
    if (!Number.isSafeInteger(value)) {
      throw fixedError("local_analysis_compact_value_invalid");
    }
    offset += 1;
    if ((byte & 0x80) === 0) return { value, offset };
    multiplier *= 0x80;
    if (!Number.isSafeInteger(multiplier)) {
      throw fixedError("local_analysis_compact_value_invalid");
    }
  }
  throw fixedError("local_analysis_compact_value_invalid");
}

function encodeSnapshotSet(keys) {
  const bytes = [COMPACT_SEQUENCE_VERSION];
  appendVarint(bytes, keys.size);
  for (const values of keys.values()) {
    bytes.push(values.length);
    for (const value of values) appendVarint(bytes, value);
  }
  return Buffer.from(bytes);
}

class SnapshotSet {
  constructor() {
    this.byComponentCount = {
      6: new Map(),
      12: new Map(),
    };
    this.size = 0;
  }

  *values() {
    for (const count of [6, 12]) {
      for (const bucket of this.byComponentCount[count].values()) {
        yield* bucket;
      }
    }
  }

  addValues(values) {
    if (![6, 12].includes(values.length)
        || values.some((value) => (
          !Number.isSafeInteger(value) || value < 0
        ))) {
      throw fixedError("local_analysis_snapshot_key_invalid");
    }
    const totalTokens = values[5];
    const map = this.byComponentCount[values.length];
    const bucket = map.get(totalTokens) ?? [];
    if (bucket.some((candidate) => (
      candidate.every((value, index) => value === values[index])
    ))) return false;
    bucket.push(values);
    map.set(totalTokens, bucket);
    this.size += 1;
    return true;
  }

  addRow(row) {
    if (row.has_total !== 1) return false;
    return this.addValues(snapshotValuesFromRow(row));
  }

  hasRow(row) {
    if (row.has_total !== 1) return false;
    const componentCount = row.has_last === 1 ? 12 : 6;
    const bucket = this.byComponentCount[componentCount]
      .get(Number(row.total_tokens));
    if (!bucket) return false;
    return bucket.some((candidate) => snapshotValuesEqualRow(
      candidate,
      row,
    ));
  }
}

function snapshotValuesFromRow(row) {
  const values = [
    Number(row.total_input),
    Number(row.total_cached_input),
    Number(row.total_cache_write),
    Number(row.total_output),
    Number(row.total_reasoning),
    Number(row.total_tokens),
  ];
  if (row.has_last === 1) {
    values.push(
      Number(row.last_input),
      Number(row.last_cached_input),
      Number(row.last_cache_write),
      Number(row.last_output),
      Number(row.last_reasoning),
      Number(row.last_tokens),
    );
  }
  return values;
}

function snapshotValuesEqualRow(values, row) {
  return values[0] === Number(row.total_input)
    && values[1] === Number(row.total_cached_input)
    && values[2] === Number(row.total_cache_write)
    && values[3] === Number(row.total_output)
    && values[4] === Number(row.total_reasoning)
    && values[5] === Number(row.total_tokens)
    && (values.length === 6
      || (
        values[6] === Number(row.last_input)
        && values[7] === Number(row.last_cached_input)
        && values[8] === Number(row.last_cache_write)
        && values[9] === Number(row.last_output)
        && values[10] === Number(row.last_reasoning)
        && values[11] === Number(row.last_tokens)
      ));
}

function decodeSnapshotSet(blob) {
  const buffer = Buffer.from(blob ?? []);
  if (buffer.length < 2 || buffer[0] !== COMPACT_SEQUENCE_VERSION) {
    throw fixedError("local_analysis_snapshot_blob_invalid");
  }
  let decoded = readVarint(buffer, 1);
  const count = decoded.value;
  let cursor = decoded.offset;
  const keys = new SnapshotSet();
  for (let index = 0; index < count; index += 1) {
    const componentCount = buffer[cursor];
    cursor += 1;
    if (![6, 12].includes(componentCount)) {
      throw fixedError("local_analysis_snapshot_blob_invalid");
    }
    const values = [];
    for (let component = 0; component < componentCount; component += 1) {
      decoded = readVarint(buffer, cursor);
      values.push(decoded.value);
      cursor = decoded.offset;
    }
    keys.addValues(values);
  }
  if (cursor !== buffer.length || keys.size !== count) {
    throw fixedError("local_analysis_snapshot_blob_invalid");
  }
  return keys;
}

function encodeTimestampSeries(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const bytes = [COMPACT_SEQUENCE_VERSION];
  appendVarint(bytes, ordered.length);
  let prior = 0;
  for (const value of ordered) {
    if (!Number.isSafeInteger(value) || value < prior) {
      throw fixedError("local_analysis_timestamp_series_invalid");
    }
    appendVarint(bytes, value - prior);
    prior = value;
  }
  return Buffer.from(bytes);
}

function decodeTimestampSeries(blob) {
  const buffer = Buffer.from(blob ?? []);
  if (buffer.length < 2 || buffer[0] !== COMPACT_SEQUENCE_VERSION) {
    throw fixedError("local_analysis_timestamp_series_invalid");
  }
  let decoded = readVarint(buffer, 1);
  const count = decoded.value;
  let cursor = decoded.offset;
  let prior = 0;
  const values = [];
  for (let index = 0; index < count; index += 1) {
    decoded = readVarint(buffer, cursor);
    prior += decoded.value;
    if (!Number.isSafeInteger(prior)) {
      throw fixedError("local_analysis_timestamp_series_invalid");
    }
    values.push(prior);
    cursor = decoded.offset;
  }
  if (cursor !== buffer.length) {
    throw fixedError("local_analysis_timestamp_series_invalid");
  }
  return values;
}

function sourceKey(secret, info) {
  return hmac(secret, "local-analysis-source", info.rolloutKey);
}

function sameIdentity(left, right) {
  return Number(left.dev) === Number(right.dev)
    && Number(left.ino) === Number(right.ino)
    && Math.trunc(Number(left.birthtimeMs))
      === Math.trunc(Number(right.birthtimeMs));
}

function exactSourceState(left, right) {
  return sameIdentity(left, right)
    && Number(left.fileSize) === Number(right.fileSize)
    && Number(left.prefixBytes) === Number(right.prefixBytes)
    && Number(left.mtimeMs) === Number(right.mtimeMs)
    && Number(left.ctimeMs) === Number(right.ctimeMs)
    // Millisecond timestamps can collide on a same-size rewrite. ctime is
    // kernel-managed, so its nanosecond value is the durable zero-byte reuse
    // boundary without retaining any source content.
    && left.ctimeNs === right.ctimeNs
    && left.boundaryHmac === right.boundaryHmac;
}

function assertOwnerFile(metadata, maximumBytes = 256) {
  if (!metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1
      || metadata.size < 32
      || metadata.size > maximumBytes
      || (typeof process.getuid === "function"
        && metadata.uid !== process.getuid())) {
    throw fixedError("local_analysis_index_secret_invalid");
  }
}

async function readOrCreateSecret(secretFile) {
  await mkdir(dirname(secretFile), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(
      secretFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(randomBytes(32));
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw fixedError("local_analysis_index_secret_unavailable");
    }
  }
  let metadata;
  try {
    metadata = await lstat(secretFile);
    assertOwnerFile(metadata);
    const secret = await readFile(secretFile);
    if (secret.length !== 32) {
      throw fixedError("local_analysis_index_secret_invalid");
    }
    await chmod(secretFile, 0o600);
    return secret;
  } catch (error) {
    if (typeof error?.code === "string"
        && error.code.startsWith("local_analysis_")) throw error;
    throw fixedError("local_analysis_index_secret_unavailable");
  }
}

async function completeLinePrefix(path, size) {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw fixedError("local_analysis_source_changed");
  }
  if (size === 0) return 0;
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const metadata = await handle.stat();
    if (!metadata.isFile()
        || metadata.isSymbolicLink()
        || metadata.nlink !== 1
        || metadata.size < size
        || (typeof process.getuid === "function"
          && metadata.uid !== process.getuid())) {
      throw fixedError("local_analysis_source_changed");
    }
    // Codex rollout files normally finish with a newline. Checking that one
    // byte first avoids a 256 KiB tail read for every already-well-formed
    // source during a resumable archive pass. The backward search below is
    // retained only for an actively written or otherwise unterminated file.
    const terminalByte = Buffer.allocUnsafe(1);
    const terminalRead = await handle.read(terminalByte, 0, 1, size - 1);
    if (terminalRead.bytesRead !== 1) {
      throw fixedError("local_analysis_source_changed");
    }
    if (terminalByte[0] === 0x0a) return size;
    const maximum = Math.min(size, 16 * 1024 * 1024);
    let end = size;
    while (end > size - maximum) {
      const start = Math.max(size - maximum, end - 256 * 1024);
      const buffer = Buffer.allocUnsafe(end - start);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        start,
      );
      if (bytesRead !== buffer.length) {
        throw fixedError("local_analysis_source_changed");
      }
      const newline = buffer.lastIndexOf(0x0a);
      if (newline !== -1) return start + newline + 1;
      end = start;
    }
    return 0;
  } catch (error) {
    if (typeof error?.code === "string"
        && error.code.startsWith("local_analysis_")) throw error;
    throw fixedError("local_analysis_source_unavailable");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function sourceBoundary(secret, path, prefixBytes) {
  const start = Math.max(0, prefixBytes - BOUNDARY_BYTES);
  const length = prefixBytes - start;
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const metadata = await handle.stat({ bigint: true });
    const fileSize = Number(metadata.size);
    if (!metadata.isFile()
        || metadata.isSymbolicLink()
        || Number(metadata.nlink) !== 1
        || !Number.isSafeInteger(fileSize)
        || fileSize < prefixBytes
        || (typeof process.getuid === "function"
          && Number(metadata.uid) !== process.getuid())
        || typeof metadata.ctimeNs !== "bigint"
        || metadata.ctimeNs < 0n) {
      throw fixedError("local_analysis_source_changed");
    }
    const buffer = Buffer.allocUnsafe(length);
    if (length > 0) {
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      if (bytesRead !== length) {
        throw fixedError("local_analysis_source_changed");
      }
    }
    return {
      boundaryStart: start,
      boundaryHmac: hmac(
        secret,
        "local-analysis-source-boundary",
        buffer,
      ),
      ctimeNs: metadata.ctimeNs.toString(),
    };
  } catch (error) {
    if (typeof error?.code === "string"
        && error.code.startsWith("local_analysis_")) throw error;
    throw fixedError("local_analysis_source_unavailable");
  } finally {
    await handle?.close().catch(() => {});
  }
}

// A complete index already contains an HMAC of the source's terminal record.
// That HMAC is expensive to recompute for every unchanged source because
// finding the terminal newline may read up to 16 MiB. A nofollow metadata
// proof with matching identity, size, and kernel-managed nanosecond ctime
// proves that the stored record's validated contents have not changed.
// Anything that cannot satisfy that proof deliberately takes the ordinary
// prefix-and-boundary path below.
async function reuseUnchangedSourceProjection(info, prior) {
  if (prior === undefined
      || !sameIdentity(prior, info)
      || Number(prior.fileSize) !== Number(info.size)) {
    return null;
  }
  let handle;
  try {
    handle = await open(
      info.path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const metadata = await handle.stat({ bigint: true });
    // Node's BigIntStats birthtimeMs may truncate a sub-millisecond timestamp
    // differently from the ordinary Stats value persisted by discovery. Keep
    // the established ordinary-Stats identity comparison and use BigIntStats
    // only for the nanosecond ctime that it uniquely exposes.
    const identityMetadata = await handle.stat();
    const fileSize = Number(metadata.size);
    if (!metadata.isFile()
        || metadata.isSymbolicLink()
        || Number(metadata.nlink) !== 1
        || !Number.isSafeInteger(fileSize)
        || fileSize !== Number(info.size)
        || !sameIdentity(prior, identityMetadata)
        || typeof metadata.ctimeNs !== "bigint"
        || metadata.ctimeNs < 0n
        || metadata.ctimeNs.toString() !== prior.ctimeNs
        || (typeof process.getuid === "function"
          && Number(metadata.uid) !== process.getuid())) {
      return null;
    }
    return {
      info,
      sourceKey: prior.sourceKey,
      dev: info.dev,
      ino: info.ino,
      birthtimeMs: Math.trunc(info.birthtimeMs),
      fileSize: info.size,
      prefixBytes: prior.prefixBytes,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      boundaryStart: prior.boundaryStart,
      boundaryHmac: prior.boundaryHmac,
      ctimeNs: prior.ctimeNs,
    };
  } catch {
    // Keep the current full reader's error semantics for inaccessible or
    // racing files. This optimization is never allowed to weaken them.
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function mapWithConcurrency(values, concurrency, callback) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await callback(values[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, Math.max(1, values.length)) },
    () => worker(),
  ));
  return results;
}

async function projectSources(
  infos,
  secret,
  signal,
  existingByKey = new Map(),
) {
  let reusedCount = 0;
  const complete = await mapWithConcurrency(
    infos,
    32,
    async (info) => {
      throwIfAborted(signal);
      const sourceKeyValue = sourceKey(secret, info);
      const reused = await reuseUnchangedSourceProjection(
        info,
        existingByKey.get(sourceKeyValue),
      );
      if (reused !== null) {
        reusedCount += 1;
        return reused;
      }
      const prefixBytes = await completeLinePrefix(info.path, info.size);
      const boundary = await sourceBoundary(
        secret,
        info.path,
        prefixBytes,
      );
      return {
        info,
        sourceKey: sourceKeyValue,
        dev: info.dev,
        ino: info.ino,
        birthtimeMs: Math.trunc(info.birthtimeMs),
        fileSize: info.size,
        prefixBytes,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
        ...boundary,
      };
    },
  );
  const keyBySession = new Map();
  for (const source of complete) {
    if (typeof source.info.lineage?.sessionId === "string") {
      keyBySession.set(source.info.lineage.sessionId, source.sourceKey);
    }
  }
  const sources = complete.map((source, ordinal) => {
    const parentId = source.info.lineage?.parentId;
    const classification = source.info.lineage?.surfaceClassification ?? {};
    return {
      ...source,
      ordinal,
      parentSourceKey: typeof parentId === "string"
        ? (keyBySession.get(parentId) ?? null)
        : null,
      isFork: source.info.lineage?.isFork === true,
      parentMissing: source.info.lineage?.isFork === true
        && !keyBySession.has(parentId),
      surface: classification.surface ?? "unknown",
      threadSource: classification.threadSource ?? "unknown",
      agentScope: classification.agentScope ?? "unknown",
      lineageDisposition:
        classification.lineageDisposition ?? "unknown",
    };
  });
  return { sources, reusedCount };
}

function configureDatabase(
  database,
  { readOnly = false, staging = false } = {},
) {
  if (!readOnly) {
    database.exec(staging
      ? `
        PRAGMA journal_mode=OFF;
        PRAGMA synchronous=OFF;
        PRAGMA locking_mode=EXCLUSIVE;
      `
      : `
        PRAGMA journal_mode=DELETE;
        PRAGMA synchronous=FULL;
      `);
  }
  database.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA trusted_schema=OFF;
    PRAGMA temp_store=FILE;
    PRAGMA cache_size=-32768;
    PRAGMA mmap_size=0;
  `);
  database.enableDefensive?.(true);
}

async function syncPath(path) {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error?.code)) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function publishStagedIndex(stageFile, indexFile) {
  const publishedFile = `${indexFile}.publish-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await copyFile(stageFile, publishedFile);
    await chmod(publishedFile, 0o600);
    await syncPath(publishedFile);
    await rename(publishedFile, indexFile);
    await syncDirectory(dirname(indexFile));
    await chmod(indexFile, 0o600);
  } finally {
    await rm(publishedFile, { force: true }).catch(() => {});
  }
}

function initializeSchema(database) {
  database.exec(`
    PRAGMA application_id=${INDEX_APPLICATION_ID};
    PRAGMA user_version=${INDEX_USER_VERSION};
    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE sources (
      source_key TEXT PRIMARY KEY CHECK(length(source_key) = 64),
      parent_source_key TEXT REFERENCES sources(source_key)
        ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
      is_fork INTEGER NOT NULL CHECK(is_fork IN (0, 1)),
      parent_missing INTEGER NOT NULL CHECK(parent_missing IN (0, 1)),
      device INTEGER NOT NULL,
      inode INTEGER NOT NULL,
      birthtime_ms INTEGER NOT NULL,
      file_size INTEGER NOT NULL CHECK(file_size >= 0),
      prefix_bytes INTEGER NOT NULL CHECK(prefix_bytes >= 0),
      mtime_ms REAL NOT NULL,
      ctime_ms REAL NOT NULL,
      ctime_ns TEXT NOT NULL CHECK(length(ctime_ns) BETWEEN 1 AND 20),
      boundary_start INTEGER NOT NULL CHECK(boundary_start >= 0),
      boundary_hmac TEXT NOT NULL CHECK(length(boundary_hmac) = 64),
      surface TEXT NOT NULL,
      thread_source TEXT NOT NULL,
      agent_scope TEXT NOT NULL,
      lineage_disposition TEXT NOT NULL,
      current_model TEXT NOT NULL DEFAULT 'unknown',
      current_model_seen INTEGER NOT NULL DEFAULT 0
        CHECK(current_model_seen IN (0, 1)),
      previous_totals_json TEXT,
      previous_presence_json TEXT,
      scan_offset INTEGER NOT NULL DEFAULT 0 CHECK(scan_offset >= 0),
      index_state TEXT NOT NULL DEFAULT 'pending'
        CHECK(index_state IN ('pending', 'complete'))
    ) STRICT;
    CREATE INDEX sources_lineage ON sources(parent_source_key);
    CREATE TABLE source_snapshot_sets (
      source_key TEXT PRIMARY KEY REFERENCES sources(source_key)
        ON DELETE CASCADE,
      snapshot_blob BLOB NOT NULL
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE tier_events (
      source_key TEXT NOT NULL REFERENCES sources(source_key)
        ON DELETE CASCADE,
      source_offset INTEGER NOT NULL CHECK(source_offset >= 0),
      timestamp_ms INTEGER NOT NULL,
      speed TEXT NOT NULL,
      api_service_tier TEXT NOT NULL,
      PRIMARY KEY(source_key, source_offset)
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX tier_events_lookup
      ON tier_events(source_key, timestamp_ms, source_offset);
    CREATE TABLE usage_facts (
      source_key TEXT NOT NULL REFERENCES sources(source_key)
        ON DELETE CASCADE,
      source_offset INTEGER NOT NULL CHECK(source_offset >= 0),
      timestamp_ms INTEGER NOT NULL,
      observed_at TEXT NOT NULL,
      model TEXT NOT NULL,
      total_input_context_tokens INTEGER NOT NULL CHECK(total_input_context_tokens >= 0),
      input_uncached_tokens INTEGER NOT NULL CHECK(input_uncached_tokens >= 0),
      input_cache_read_tokens INTEGER NOT NULL CHECK(input_cache_read_tokens >= 0),
      input_cache_write_tokens INTEGER NOT NULL CHECK(input_cache_write_tokens >= 0),
      output_text_tokens INTEGER NOT NULL CHECK(output_text_tokens >= 0),
      output_reasoning_tokens INTEGER NOT NULL CHECK(output_reasoning_tokens >= 0),
      PRIMARY KEY(source_key, source_offset)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE quota_facts (
      source_key TEXT NOT NULL REFERENCES sources(source_key)
        ON DELETE CASCADE,
      source_offset INTEGER NOT NULL CHECK(source_offset >= 0),
      slot_order INTEGER NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      observed_at TEXT NOT NULL,
      provider TEXT NOT NULL,
      plan_type TEXT NOT NULL,
      limit_id TEXT NOT NULL,
      slot TEXT NOT NULL,
      used_percent REAL NOT NULL,
      window_duration_mins INTEGER NOT NULL,
      resets_at INTEGER NOT NULL,
      PRIMARY KEY(source_key, source_offset, slot_order)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE source_diagnostics (
      source_key TEXT NOT NULL REFERENCES sources(source_key)
        ON DELETE CASCADE,
      code TEXT NOT NULL,
      count INTEGER NOT NULL CHECK(count >= 0),
      PRIMARY KEY(source_key, code)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE diagnostic_series (
      source_key TEXT NOT NULL REFERENCES sources(source_key)
        ON DELETE CASCADE,
      code TEXT NOT NULL,
      timestamps_blob BLOB NOT NULL,
      PRIMARY KEY(source_key, code)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE projections (
      kind TEXT PRIMARY KEY,
      schema_version TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      value_json TEXT NOT NULL
    ) STRICT;
  `);
}

function validateDatabase(database, { requireComplete = true } = {}) {
  const applicationId = Number(
    database.prepare("PRAGMA application_id").get().application_id,
  );
  const userVersion = Number(
    database.prepare("PRAGMA user_version").get().user_version,
  );
  if (applicationId !== INDEX_APPLICATION_ID
      || userVersion !== INDEX_USER_VERSION) {
    throw fixedError("local_analysis_index_schema_invalid");
  }
  const meta = Object.fromEntries(
    [...database.prepare("SELECT key, value FROM meta").iterate()]
      .map((row) => [row.key, row.value]),
  );
  if (meta.schema_version !== LOCAL_ANALYSIS_INDEX_SCHEMA_VERSION
      || meta.parser_version !== LOCAL_ANALYSIS_INDEX_PARSER_VERSION
      || !["partial", "complete"].includes(meta.status)
      || (requireComplete && meta.status !== "complete")) {
    throw fixedError("local_analysis_index_schema_invalid");
  }
  return meta;
}

function openExistingIndex(
  indexFile,
  { readOnly = true, staging = false, requireComplete = true } = {},
) {
  let database;
  try {
    database = new DatabaseSync(indexFile, {
      readOnly,
      timeout: 5_000,
    });
    configureDatabase(database, { readOnly, staging });
    const meta = validateDatabase(database, { requireComplete });
    return { database, meta };
  } catch (error) {
    if (database?.isOpen) database.close();
    if (typeof error?.code === "string"
        && error.code.startsWith("local_analysis_")) throw error;
    throw fixedError("local_analysis_index_unavailable");
  }
}

function createFreshIndex(indexFile) {
  const database = new DatabaseSync(indexFile, {
    readOnly: false,
    timeout: 5_000,
  });
  configureDatabase(database, { staging: true });
  initializeSchema(database);
  return database;
}

function readStoredSources(database) {
  return new Map([...database.prepare(`
    SELECT source_key, parent_source_key, ordinal, is_fork, parent_missing,
           device, inode, birthtime_ms, file_size, prefix_bytes, mtime_ms,
           ctime_ms, ctime_ns, boundary_start, boundary_hmac, surface, thread_source,
           agent_scope, lineage_disposition, current_model,
           current_model_seen, previous_totals_json, previous_presence_json,
           scan_offset, index_state
    FROM sources
  `).iterate()].map((row) => [row.source_key, {
    sourceKey: row.source_key,
    parentSourceKey: row.parent_source_key,
    ordinal: Number(row.ordinal),
    isFork: row.is_fork === 1,
    parentMissing: row.parent_missing === 1,
    dev: Number(row.device),
    ino: Number(row.inode),
    birthtimeMs: Number(row.birthtime_ms),
    fileSize: Number(row.file_size),
    prefixBytes: Number(row.prefix_bytes),
    mtimeMs: Number(row.mtime_ms),
    ctimeMs: Number(row.ctime_ms),
    ctimeNs: row.ctime_ns,
    boundaryStart: Number(row.boundary_start),
    boundaryHmac: row.boundary_hmac,
    surface: row.surface,
    threadSource: row.thread_source,
    agentScope: row.agent_scope,
    lineageDisposition: row.lineage_disposition,
    currentModel: row.current_model,
    currentModelSeen: row.current_model_seen === 1,
    previousTotals: row.previous_totals_json === null
      ? null
      : JSON.parse(row.previous_totals_json),
    previousPresence: row.previous_presence_json === null
      ? null
      : JSON.parse(row.previous_presence_json),
    scanOffset: Number(row.scan_offset),
    indexState: SOURCE_INDEX_STATES.has(row.index_state)
      ? row.index_state
      : "pending",
  }]));
}

function descendantsOf(keys, sources) {
  const invalid = new Set(keys);
  let changed = true;
  while (changed) {
    changed = false;
    for (const source of sources.values()) {
      if (source.parentSourceKey !== null
          && invalid.has(source.parentSourceKey)
          && !invalid.has(source.sourceKey)) {
        invalid.add(source.sourceKey);
        changed = true;
      }
    }
  }
  return invalid;
}

function createChunks(
  source,
  startByte,
  chunkBytes,
  maximumBytes = Number.POSITIVE_INFINITY,
) {
  const chunks = [];
  let scheduledBytes = 0;
  for (let start = startByte; start < source.prefixBytes;) {
    const length = Math.min(chunkBytes, source.prefixBytes - start);
    // A source must advance at least one bounded chunk or it would be unable
    // to make progress when its first readable chunk is larger than the
    // selected pass budget. Later chunks respect the budget exactly.
    if (scheduledBytes > 0 && scheduledBytes + length > maximumBytes) break;
    const end = Math.min(source.prefixBytes, start + chunkBytes);
    chunks.push({
      path: source.info.path,
      sourceKey: source.sourceKey,
      dev: source.dev,
      ino: source.ino,
      birthtimeMs: source.birthtimeMs,
      startByte: start,
      endByte: end,
    });
    scheduledBytes += end - start;
    start = end;
  }
  return chunks;
}

function taskSlices(tasks, maximumCommitBytes) {
  if (maximumCommitBytes === null || tasks.length === 0) {
    return [tasks];
  }
  const slices = [];
  let current = [];
  let currentBytes = 0;
  for (const task of tasks) {
    const bytes = task.endByte - task.startByte;
    if (current.length > 0 && currentBytes + bytes > maximumCommitBytes) {
      slices.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(task);
    currentBytes += bytes;
  }
  if (current.length > 0) slices.push(current);
  return slices;
}

function sourceEndOffsetsForTasks(tasks) {
  const offsets = new Map();
  for (const task of tasks) {
    offsets.set(
      task.sourceKey,
      Math.max(offsets.get(task.sourceKey) ?? 0, task.endByte),
    );
  }
  return offsets;
}

function validOptionalPositiveSafeInteger(value) {
  return value === null
    || (Number.isSafeInteger(value) && value >= 1);
}

// The shared leading-reading gate predates generic provider durations and uses
// provider/limit/slot as its opaque identity. Keep the duration in the local
// gate key until every caller has the duration-aware contract; the original
// entry remains the payload returned to the index projection.
function quotaGateIdentity(window) {
  return {
    ...window,
    slot: `${window.slot}\u0000${window.windowDurationMins}`,
  };
}

function createDurationAwareQuotaGate(settledWindows) {
  const gate = createLeadingRateLimitGate(
    settledWindows.map(quotaGateIdentity),
  );
  return {
    offer(window, timestampMs, entry) {
      return gate.offer(quotaGateIdentity(window), timestampMs, entry);
    },
    flush() {
      return gate.flush();
    },
  };
}

function validOptionalDiscoveryLimits(value) {
  return value === null
    || (value
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.keys(value).length === 2
      && Object.hasOwn(value, "maximumDirectoryEntries")
      && Object.hasOwn(value, "maximumRolloutFiles")
      && Number.isSafeInteger(value.maximumDirectoryEntries)
      && value.maximumDirectoryEntries >= 1
      && Number.isSafeInteger(value.maximumRolloutFiles)
      && value.maximumRolloutFiles >= 1);
}

function planIndexBatch({
  sources,
  existingByKey,
  resetKeys,
  appendKeys,
  maximumSourcesPerRefresh,
  maximumScanBytesPerRefresh,
  chunkBytes,
}) {
  const sourceLimit = maximumSourcesPerRefresh ?? Number.MAX_SAFE_INTEGER;
  const byteLimit = maximumScanBytesPerRefresh ?? Number.POSITIVE_INFINITY;
  const completeKeys = new Set();
  const needsScan = new Set();
  for (const source of sources) {
    const prior = existingByKey.get(source.sourceKey);
    const fullyIndexed = prior?.indexState === "complete"
      && prior.scanOffset >= source.prefixBytes;
    if (resetKeys.has(source.sourceKey)
        || appendKeys.has(source.sourceKey)
        || !fullyIndexed) {
      needsScan.add(source.sourceKey);
    } else {
      completeKeys.add(source.sourceKey);
    }
  }
  const tasks = [];
  const sourceEndOffsets = new Map();
  let scheduledSources = 0;
  let scheduledBytes = 0;
  for (const source of sources) {
    if (!needsScan.has(source.sourceKey)) continue;
    if (source.parentSourceKey !== null
        && !completeKeys.has(source.parentSourceKey)) {
      // A fork cannot be replay-safe until its parent snapshot set is fully
      // durable. Leave it pending rather than approximating its inherited
      // prefix from an incomplete parent.
      continue;
    }
    const prior = existingByKey.get(source.sourceKey);
    const startByte = resetKeys.has(source.sourceKey)
      ? 0
      : Math.min(prior?.scanOffset ?? 0, source.prefixBytes);
    if (startByte >= source.prefixBytes) {
      sourceEndOffsets.set(source.sourceKey, source.prefixBytes);
      completeKeys.add(source.sourceKey);
      continue;
    }
    if (scheduledSources >= sourceLimit) continue;
    const remaining = byteLimit - scheduledBytes;
    if (remaining <= 0 && tasks.length > 0) continue;
    const sourceTasks = createChunks(
      source,
      startByte,
      chunkBytes,
      Number.isFinite(remaining)
        ? Math.max(chunkBytes, remaining)
        : Number.POSITIVE_INFINITY,
    );
    if (sourceTasks.length === 0) continue;
    tasks.push(...sourceTasks);
    scheduledSources += 1;
    const endByte = sourceTasks.at(-1).endByte;
    sourceEndOffsets.set(source.sourceKey, endByte);
    scheduledBytes += endByte - startByte;
    if (endByte >= source.prefixBytes) completeKeys.add(source.sourceKey);
  }
  return {
    tasks,
    sourceEndOffsets,
    selectedKeys: new Set(sourceEndOffsets.keys()),
  };
}

function balancedAssignments(tasks, workerCount) {
  const bySource = new Map();
  for (const task of tasks) {
    const group = bySource.get(task.sourceKey) ?? {
      bytes: 0,
      tasks: [],
    };
    group.bytes += task.endByte - task.startByte;
    group.tasks.push(task);
    bySource.set(task.sourceKey, group);
  }
  const assignments = Array.from(
    { length: Math.min(workerCount, bySource.size) },
    () => ({ bytes: 0, tasks: [] }),
  );
  for (const group of [...bySource.values()].sort(
    (left, right) => right.bytes - left.bytes,
  )) {
    assignments.sort((left, right) => left.bytes - right.bytes);
    group.tasks.sort((left, right) => left.startByte - right.startByte);
    assignments[0].tasks.push(...group.tasks);
    assignments[0].bytes += group.bytes;
  }
  return assignments;
}

function runWorker(shardFile, tasks, signal) {
  return new Promise((resolveWorker, rejectWorker) => {
    throwIfAborted(signal);
    const worker = new Worker(
      new URL("./local-analysis-extract-worker.js", import.meta.url),
      {
        workerData: { shardFile, tasks },
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: 96,
          maxYoungGenerationSizeMb: 16,
          codeRangeSizeMb: 16,
          stackSizeMb: 2,
        },
      },
    );
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      worker.terminate().finally(() => {
        const error = fixedError("local_analysis_index_aborted");
        error.name = "AbortError";
        rejectWorker(error);
      });
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (message) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (message?.ok === true) resolveWorker(message.result);
      else rejectWorker(fixedError(
        typeof message?.code === "string"
          ? message.code
          : "local_analysis_worker_failed",
      ));
    });
    worker.once("error", () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      rejectWorker(fixedError("local_analysis_worker_failed"));
    });
    worker.once("exit", (code) => {
      if (settled || code === 0) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      rejectWorker(fixedError("local_analysis_worker_failed"));
    });
  });
}

async function extractTasks({
  tasks,
  workerCount,
  signal,
  tempParent,
}) {
  if (tasks.length === 0) {
    return {
      results: [],
      shardFiles: [],
      shardDirectory: null,
      extractWallMs: 0,
      mergeWallMs: 0,
    };
  }
  const shardDirectory = await mkdtemp(
    join(tempParent, ".local-analysis-shards-"),
  );
  await chmod(shardDirectory, 0o700);
  try {
    const extractStartedAt = performance.now();
    const assignments = balancedAssignments(tasks, workerCount);
    const shardFiles = assignments.map((_, index) => (
      join(shardDirectory, `shard-${index}.sqlite`)
    ));
    const results = await Promise.all(assignments.map(
      (assignment, index) => runWorker(
        shardFiles[index],
        assignment.tasks,
        signal,
      ),
    ));
    const extractWallMs = performance.now() - extractStartedAt;
    throwIfAborted(signal);
    return {
      results,
      shardFiles,
      shardDirectory,
      sourceShardIndexes: new Map(assignments.flatMap(
        (assignment, index) => [
          ...new Set(
            assignment.tasks.map((task) => task.sourceKey),
          ),
        ].map((sourceKeyValue) => [sourceKeyValue, index]),
      )),
      extractWallMs,
      mergeWallMs: 0,
    };
  } catch (error) {
    await rm(shardDirectory, { recursive: true, force: true });
    throw error;
  }
}

function attachExtractedShards(database, shardFiles) {
  const schemas = shardFiles.map((_, index) => `extract_${index}`);
  for (let index = 0; index < shardFiles.length; index += 1) {
    database.prepare(`ATTACH DATABASE ? AS ${schemas[index]}`)
      .run(shardFiles[index]);
  }
  return schemas;
}

function detachExtractedShards(database, schemas) {
  for (const schema of schemas) database.exec(`DETACH DATABASE ${schema}`);
}

function insertOrUpdateSources(database, sources) {
  const upsert = database.prepare(`
    INSERT INTO sources(
      source_key, parent_source_key, ordinal, is_fork, parent_missing,
      device, inode, birthtime_ms, file_size, prefix_bytes, mtime_ms,
      ctime_ms, ctime_ns, boundary_start, boundary_hmac, surface, thread_source,
      agent_scope, lineage_disposition
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key) DO UPDATE SET
      parent_source_key=excluded.parent_source_key,
      ordinal=excluded.ordinal,
      is_fork=excluded.is_fork,
      parent_missing=excluded.parent_missing,
      device=excluded.device,
      inode=excluded.inode,
      birthtime_ms=excluded.birthtime_ms,
      file_size=excluded.file_size,
      prefix_bytes=excluded.prefix_bytes,
      mtime_ms=excluded.mtime_ms,
      ctime_ms=excluded.ctime_ms,
      ctime_ns=excluded.ctime_ns,
      boundary_start=excluded.boundary_start,
      boundary_hmac=excluded.boundary_hmac,
      surface=excluded.surface,
      thread_source=excluded.thread_source,
      agent_scope=excluded.agent_scope,
      lineage_disposition=excluded.lineage_disposition
  `);
  for (const source of sources) {
    upsert.run(
      source.sourceKey,
      source.parentSourceKey,
      source.ordinal,
      source.isFork ? 1 : 0,
      source.parentMissing ? 1 : 0,
      source.dev,
      source.ino,
      source.birthtimeMs,
      source.fileSize,
      source.prefixBytes,
      source.mtimeMs,
      source.ctimeMs,
      source.ctimeNs,
      source.boundaryStart,
      source.boundaryHmac,
      source.surface,
      source.threadSource,
      source.agentScope,
      source.lineageDisposition,
    );
  }
}

function resetSources(database, keys) {
  const deleteUsage = database.prepare(
    "DELETE FROM usage_facts WHERE source_key = ?",
  );
  const deleteQuota = database.prepare(
    "DELETE FROM quota_facts WHERE source_key = ?",
  );
  const deleteSnapshots = database.prepare(
    "DELETE FROM source_snapshot_sets WHERE source_key = ?",
  );
  const deleteTier = database.prepare(
    "DELETE FROM tier_events WHERE source_key = ?",
  );
  const deleteDiagnostics = database.prepare(
    "DELETE FROM source_diagnostics WHERE source_key = ?",
  );
  const deleteDiagnosticEvents = database.prepare(
    "DELETE FROM diagnostic_series WHERE source_key = ?",
  );
  const resetState = database.prepare(`
    UPDATE sources SET current_model='unknown', current_model_seen=0,
      previous_totals_json=NULL, previous_presence_json=NULL,
      scan_offset=0, index_state='pending'
    WHERE source_key=?
  `);
  for (const key of keys) {
    deleteUsage.run(key);
    deleteQuota.run(key);
    deleteSnapshots.run(key);
    deleteTier.run(key);
    deleteDiagnostics.run(key);
    deleteDiagnosticEvents.run(key);
    resetState.run(key);
  }
}

function markSourcesPending(database, keys) {
  const markPending = database.prepare(`
    UPDATE sources SET index_state='pending'
    WHERE source_key=?
  `);
  for (const key of keys) markPending.run(key);
}

function markSourcesIndexed(database, completedOffsets) {
  const update = database.prepare(`
    UPDATE sources
    SET scan_offset = ?,
        index_state = CASE
          WHEN ? >= prefix_bytes THEN 'complete'
          ELSE 'pending'
        END
    WHERE source_key = ?
  `);
  for (const [sourceKeyValue, offset] of completedOffsets) {
    update.run(offset, offset, sourceKeyValue);
  }
}

function indexCoverage(database, sources) {
  const rows = Object.fromEntries(
    [...database.prepare(`
      SELECT index_state, COUNT(*) AS source_count,
             COALESCE(SUM(prefix_bytes), 0) AS source_bytes,
             COALESCE(SUM(scan_offset), 0) AS indexed_bytes
      FROM sources
      GROUP BY index_state
    `).iterate()].map((row) => [row.index_state, {
      sourceCount: Number(row.source_count),
      sourceBytes: Number(row.source_bytes),
      indexedBytes: Number(row.indexed_bytes),
    }]),
  );
  const complete = rows.complete ?? {
    sourceCount: 0,
    sourceBytes: 0,
    indexedBytes: 0,
  };
  const pending = rows.pending ?? {
    sourceCount: 0,
    sourceBytes: 0,
    indexedBytes: 0,
  };
  const sourceCount = sources.length;
  const sourceBytes = sources.reduce(
    (sum, source) => sum + source.prefixBytes,
    0,
  );
  const indexedBytes = complete.sourceBytes + pending.indexedBytes;
  return {
    status: pending.sourceCount === 0 ? "complete" : "partial",
    sourceCount,
    indexedSourceCount: complete.sourceCount,
    pendingSourceCount: pending.sourceCount,
    sourceBytes,
    indexedBytes: Math.min(sourceBytes, indexedBytes),
  };
}

function coverageFromMeta(meta, sourceCount, sourceBytes) {
  const value = (name) => Number(meta[name]);
  const indexedSourceCount = value("indexed_source_count");
  const pendingSourceCount = value("pending_source_count");
  const indexedBytes = value("indexed_bytes");
  const validCount = (count) => (
    Number.isSafeInteger(count) && count >= 0 && count <= sourceCount
  );
  const validBytes = Number.isSafeInteger(indexedBytes)
    && indexedBytes >= 0
    && indexedBytes <= sourceBytes;
  if (!validCount(indexedSourceCount)
      || !validCount(pendingSourceCount)
      || indexedSourceCount + pendingSourceCount !== sourceCount
      || !validBytes) {
    throw fixedError("local_analysis_index_schema_invalid");
  }
  const blockReason = meta.coverage_blocked_reason ?? "none";
  if (blockReason !== "none" && !COVERAGE_BLOCK_REASONS.has(blockReason)) {
    throw fixedError("local_analysis_index_schema_invalid");
  }
  const status = meta.status === "complete" && blockReason === "none"
    ? "complete"
    : "partial";
  if (blockReason === "none"
      && (status === "complete") !== (pendingSourceCount === 0)) {
    throw fixedError("local_analysis_index_schema_invalid");
  }
  return {
    status,
    sourceCount,
    indexedSourceCount,
    pendingSourceCount,
    sourceBytes,
    indexedBytes,
    ...(blockReason === "none" ? {} : { blockReason }),
  };
}

function presenceFromMask(mask) {
  return Object.fromEntries(COMPONENT_KEYS.map((key, index) => [
    key,
    Boolean(mask & (1 << index)),
  ]));
}

function usageFromRow(row, prefix) {
  return {
    input_tokens: Number(row[`${prefix}_input`]),
    cached_input_tokens: Number(row[`${prefix}_cached_input`]),
    cache_write_input_tokens: Number(row[`${prefix}_cache_write`]),
    output_tokens: Number(row[`${prefix}_output`]),
    reasoning_output_tokens: Number(row[`${prefix}_reasoning`]),
    total_tokens: Number(row[`${prefix}_tokens`]),
  };
}

function ancestorKeys(source, byKey) {
  const keys = [];
  const seen = new Set();
  let parentKey = source.parentSourceKey;
  while (parentKey !== null && !seen.has(parentKey)) {
    seen.add(parentKey);
    keys.push(parentKey);
    parentKey = byKey.get(parentKey)?.parentSourceKey ?? null;
  }
  return keys;
}

function inheritedSnapshots(database, source, byKey, cache) {
  const sets = [];
  const statement = database.prepare(`
    SELECT snapshot_blob FROM source_snapshot_sets WHERE source_key = ?
  `);
  for (const key of ancestorKeys(source, byKey)) {
    let snapshots = cache.get(key);
    if (!snapshots) {
      const row = statement.get(key);
      if (!row) continue;
      snapshots = decodeSnapshotSet(row.snapshot_blob);
      cache.set(key, snapshots);
    }
    sets.push(snapshots);
  }
  return {
    hasRow(row) {
      return sets.some((set) => set.hasRow(row));
    },
  };
}

async function deriveChangedSources({
  database,
  sources,
  changedKeys,
  resetKeys,
  extractedSchemaBySource,
  workerResults,
  onUsage,
  onRateLimitSnapshot,
  projectionStartMs,
  projectionEndMs,
  signal,
}) {
  const byKey = new Map(sources.map((source) => [
    source.sourceKey,
    source,
  ]));
  const snapshotCache = new Map();
  let projectionSequence = 0;
  const invokeProjection = async (callback, value) => {
    const result = callback?.(value);
    if (result && typeof result.then === "function") await result;
  };
  const readSnapshotSet = database.prepare(`
    SELECT snapshot_blob FROM source_snapshot_sets WHERE source_key = ?
  `);
  const writeSnapshotSet = database.prepare(`
    INSERT INTO source_snapshot_sets(source_key, snapshot_blob)
    VALUES (?, ?)
    ON CONFLICT(source_key) DO UPDATE SET
      snapshot_blob=excluded.snapshot_blob
  `);
  const insertUsage = database.prepare(`
    INSERT OR REPLACE INTO usage_facts(
      source_key, source_offset, timestamp_ms, observed_at, model,
      total_input_context_tokens, input_uncached_tokens,
      input_cache_read_tokens, input_cache_write_tokens,
      output_text_tokens, output_reasoning_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertQuota = database.prepare(`
    INSERT OR REPLACE INTO quota_facts(
      source_key, source_offset, slot_order, timestamp_ms, observed_at,
      provider, plan_type, limit_id, slot, used_percent,
      window_duration_mins, resets_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const settledQuotaWindows = database.prepare(`
    SELECT DISTINCT provider, limit_id, slot, window_duration_mins
    FROM quota_facts
    WHERE source_key = ?
      AND window_duration_mins BETWEEN 1 AND 525600
      AND window_duration_mins = CAST(window_duration_mins AS INTEGER)
  `);
  const updateState = database.prepare(`
    UPDATE sources SET current_model=?, current_model_seen=?,
      previous_totals_json=?, previous_presence_json=?
    WHERE source_key=?
  `);
  const addSourceDiagnostic = database.prepare(`
    INSERT INTO source_diagnostics(source_key, code, count)
    VALUES (?, ?, ?)
    ON CONFLICT(source_key, code)
    DO UPDATE SET count = count + excluded.count
  `);
  // A measurement of the current state rather than a running tally.
  const setSourceDiagnostic = database.prepare(`
    INSERT INTO source_diagnostics(source_key, code, count)
    VALUES (?, ?, ?)
    ON CONFLICT(source_key, code)
    DO UPDATE SET count = excluded.count
  `);
  const readSourceDiagnostic = database.prepare(`
    SELECT count FROM source_diagnostics
    WHERE source_key = ? AND code = ?
  `);
  const readDiagnosticSeries = database.prepare(`
    SELECT code, timestamps_blob
    FROM diagnostic_series WHERE source_key = ?
  `);
  const writeDiagnosticSeries = database.prepare(`
    INSERT INTO diagnostic_series(source_key, code, timestamps_blob)
    VALUES (?, ?, ?)
    ON CONFLICT(source_key, code) DO UPDATE SET
      timestamps_blob=excluded.timestamps_blob
  `);
  const storedSourceState = database.prepare(`
    SELECT current_model, current_model_seen, previous_totals_json,
           previous_presence_json
    FROM sources WHERE source_key = ?
  `);
  const extractedStatements = new Map();
  const statementsForSource = (sourceKeyValue) => {
    const schema = extractedSchemaBySource.get(sourceKeyValue);
    if (schema === undefined) {
      throw fixedError("local_analysis_shard_source_missing");
    }
    let result = extractedStatements.get(schema);
    if (result) return result;
    result = {
      insertTier: database.prepare(`
        INSERT OR REPLACE INTO tier_events(
          source_key, source_offset, timestamp_ms, speed, api_service_tier
        ) SELECT source_key, source_offset, timestamp_ms, speed,
                 api_service_tier
          FROM ${schema}.tier_events WHERE source_key = ?
      `),
      modelAndTokens: database.prepare(`
        SELECT source_offset, kind, model, timestamp_ms, observed_at,
               explicit_model, has_explicit_model, has_total, has_last,
               total_presence, last_presence,
               total_input, total_cached_input, total_cache_write,
               total_output, total_reasoning, total_tokens,
               last_input, last_cached_input, last_cache_write,
               last_output, last_reasoning, last_tokens, rate_status
        FROM (
          SELECT source_offset, 0 AS kind, model,
                 NULL AS timestamp_ms, NULL AS observed_at,
                 NULL AS explicit_model, NULL AS has_explicit_model,
                 NULL AS has_total, NULL AS has_last,
                 NULL AS total_presence, NULL AS last_presence,
                 NULL AS total_input, NULL AS total_cached_input,
                 NULL AS total_cache_write, NULL AS total_output,
                 NULL AS total_reasoning, NULL AS total_tokens,
                 NULL AS last_input, NULL AS last_cached_input,
                 NULL AS last_cache_write, NULL AS last_output,
                 NULL AS last_reasoning, NULL AS last_tokens,
                 NULL AS rate_status
          FROM ${schema}.model_events WHERE source_key = ?
          UNION ALL
          SELECT source_offset, 1 AS kind, NULL AS model,
                 timestamp_ms, observed_at, explicit_model,
                 has_explicit_model, has_total, has_last,
                 total_presence, last_presence,
                 total_input, total_cached_input, total_cache_write,
                 total_output, total_reasoning, total_tokens,
                 last_input, last_cached_input, last_cache_write,
                 last_output, last_reasoning, last_tokens, rate_status
          FROM ${schema}.token_records WHERE source_key = ?
        ) ORDER BY source_offset, kind
      `),
      quotaForSource: database.prepare(`
        SELECT slot_order, provider, plan_type, limit_id, slot, used_percent,
               window_duration_mins, resets_at, source_offset
        FROM ${schema}.quota_records
        WHERE source_key = ?
          AND window_duration_mins BETWEEN 1 AND 525600
          AND window_duration_mins = CAST(window_duration_mins AS INTEGER)
        ORDER BY source_offset, slot_order
      `),
    };
    extractedStatements.set(schema, result);
    return result;
  };

  for (const result of workerResults) {
    for (const row of result.diagnostics) {
      addSourceDiagnostic.run(
        row.sourceKey,
        row.code,
        row.count,
      );
    }
  }

  for (const source of sources) {
    if (!changedKeys.has(source.sourceKey)) continue;
    throwIfAborted(signal);
    const extracted = statementsForSource(source.sourceKey);
    extracted.insertTier.run(source.sourceKey);
    const tierTimeline = [...database.prepare(`
      SELECT source_offset, timestamp_ms, speed, api_service_tier
      FROM tier_events
      WHERE source_key = ?
      ORDER BY timestamp_ms, source_offset
    `).iterate(source.sourceKey)].map((row) => ({
      sourceOffset: Number(row.source_offset),
      timestampMs: Number(row.timestamp_ms),
      speed: row.speed,
      apiServiceTier: row.api_service_tier,
    }));
    const stored = storedSourceState.get(source.sourceKey);
    let currentModel = resetKeys.has(source.sourceKey)
      ? "unknown"
      : stored.current_model;
    let currentModelSeen = resetKeys.has(source.sourceKey)
      ? false
      : stored.current_model_seen === 1;
    let previousTotals = resetKeys.has(source.sourceKey)
        || stored.previous_totals_json === null
      ? null
      : JSON.parse(stored.previous_totals_json);
    let previousPresence = resetKeys.has(source.sourceKey)
        || stored.previous_presence_json === null
      ? null
      : JSON.parse(stored.previous_presence_json);
    let previousTotalRow = null;
    let previousPresenceMask = null;
    const materializePreviousTotals = () => {
      if (previousTotalRow === null) return;
      previousTotals = usageFromRow(previousTotalRow, "total");
      previousPresence = presenceFromMask(previousPresenceMask);
      previousTotalRow = null;
      previousPresenceMask = null;
    };
    const inherited = source.parentSourceKey === null
      ? null
      : inheritedSnapshots(database, source, byKey, snapshotCache);
    const localSnapshots = resetKeys.has(source.sourceKey)
      ? new SnapshotSet()
      : decodeSnapshotSet(
        readSnapshotSet.get(source.sourceKey)?.snapshot_blob
          ?? encodeSnapshotSet(new SnapshotSet()),
      );
    const diagnosticSeries = new Map(
      resetKeys.has(source.sourceKey)
        ? []
        : [...readDiagnosticSeries.iterate(source.sourceKey)].map(
          (row) => [
            row.code,
            decodeTimestampSeries(row.timestamps_blob),
          ],
        ),
    );
    const addDiagnosticEvent = (code, timestampMs) => {
      const values = diagnosticSeries.get(code) ?? [];
      values.push(timestampMs);
      diagnosticSeries.set(code, values);
    };
    const quotaIterator = extracted.quotaForSource
      .iterate(source.sourceKey);
    let nextQuota = quotaIterator.next();
    // An appended source already committed its leading reading in an earlier
    // pass, so only a window this source has never recorded is still leading.
    const leadingQuotaGate = createDurationAwareQuotaGate(
      [...settledQuotaWindows.iterate(source.sourceKey)].map((row) => ({
        provider: row.provider,
        limitId: row.limit_id,
        slot: row.slot,
        windowDurationMins: Number(row.window_duration_mins),
      })),
    );
    const commitQuota = async (entry) => {
      insertQuota.run(
        source.sourceKey,
        entry.sourceOffset,
        entry.slotOrder,
        entry.timestampMs,
        entry.observedAt,
        entry.provider,
        entry.planType,
        entry.limitId,
        entry.slot,
        entry.usedPercent,
        entry.windowDurationMins,
        entry.resetsAt,
      );
      if (entry.timestampMs < projectionStartMs
          || entry.timestampMs > projectionEndMs) return;
      await invokeProjection(onRateLimitSnapshot, {
        timestamp: entry.observedAt,
        timestampMs: entry.timestampMs,
        sequence: projectionSequence++,
        window: {
          provider: entry.provider,
          planType: entry.planType,
          limitId: entry.limitId,
          slot: entry.slot,
          usedPercent: entry.usedPercent,
          windowDurationMins: entry.windowDurationMins,
          resetsAt: entry.resetsAt,
        },
        surfaceClassification: {
          surface: source.surface,
          threadSource: source.threadSource,
          agentScope: source.agentScope,
          lineageDisposition: source.lineageDisposition,
        },
        sourceRolloutOrdinal: source.ordinal,
        sourceRecordOrdinal: entry.sourceOffset,
      });
    };
    if (source.parentMissing && resetKeys.has(source.sourceKey)) {
      addSourceDiagnostic.run(
        source.sourceKey,
        "lineageParentsMissing",
        1,
      );
    }
    for (const row of extracted.modelAndTokens.iterate(
      source.sourceKey,
      source.sourceKey,
    )) {
      throwIfAborted(signal);
      if (row.kind === 0) {
        currentModel = row.model;
        currentModelSeen = true;
        continue;
      }
      if (source.isFork
          && inherited?.hasRow(row)) {
        if (row.has_total === 1) {
          previousTotals = null;
          previousPresence = null;
          previousTotalRow = row;
          previousPresenceMask = Number(row.total_presence);
        }
        addDiagnosticEvent(
          "forkReplayEventsSkipped",
          Number(row.timestamp_ms),
        );
        continue;
      }
      localSnapshots.addRow(row);
      if (source.isFork && !currentModelSeen) {
        if (row.has_total === 1) {
          previousTotals = null;
          previousPresence = null;
          previousTotalRow = row;
          previousPresenceMask = Number(row.total_presence);
        }
        addDiagnosticEvent(
          "unattributedForkReplayEventsSkipped",
          Number(row.timestamp_ms),
        );
        continue;
      }
      materializePreviousTotals();
      const total = row.has_total === 1
        ? usageFromRow(row, "total")
        : null;
      const last = row.has_last === 1
        ? usageFromRow(row, "last")
        : null;
      const totalPresence = presenceFromMask(
        Number(row.total_presence),
      );
      const lastPresence = presenceFromMask(
        Number(row.last_presence),
      );
      if (row.rate_status === "missing") {
        addDiagnosticEvent(
          "missingRateLimitRecords",
          Number(row.timestamp_ms),
        );
      } else if (row.rate_status === "malformed") {
        addDiagnosticEvent(
          "malformedRateLimitRecords",
          Number(row.timestamp_ms),
        );
      }
      if (row.observed_at !== null) {
        while (!nextQuota.done
            && Number(nextQuota.value.source_offset)
              < Number(row.source_offset)) {
          nextQuota = quotaIterator.next();
        }
        while (!nextQuota.done
            && Number(nextQuota.value.source_offset)
              === Number(row.source_offset)) {
          const quota = nextQuota.value;
          const windowDurationMins = Number(quota.window_duration_mins);
          if (!isValidQuotaWindowDuration(windowDurationMins)) {
            nextQuota = quotaIterator.next();
            continue;
          }
          const entry = {
            sourceOffset: Number(row.source_offset),
            slotOrder: Number(quota.slot_order),
            timestampMs: Number(row.timestamp_ms),
            observedAt: row.observed_at,
            provider: quota.provider,
            planType: quota.plan_type,
            limitId: quota.limit_id,
            slot: quota.slot,
            usedPercent: Number(quota.used_percent),
            windowDurationMins,
            resetsAt: Number(quota.resets_at),
          };
          const gated = leadingQuotaGate.offer(
            entry,
            entry.timestampMs,
            entry,
          );
          for (const withheld of gated.withheld) {
            addDiagnosticEvent(
              "contradictedLeadingSnapshotsSkipped",
              withheld.timestampMs,
            );
          }
          for (const released of gated.released) {
            await commitQuota(released);
          }
          nextQuota = quotaIterator.next();
        }
      }
      let usage = null;
      let usagePresence = null;
      if (total !== null) {
        const delta = subtractUsage(total, previousTotals);
        const deltaPresence = deltaComponentPresence(
          totalPresence,
          previousPresence,
        );
        const first = previousTotals === null;
        previousTotals = total;
        previousPresence = totalPresence;
        if (first) {
          usage = last ?? delta;
          usagePresence = last ? lastPresence : deltaPresence;
        } else if (delta.total_tokens > 0) {
          if (last !== null && sameUsage(last, delta)) {
            usage = last;
            usagePresence = lastPresence;
          } else {
            usage = delta;
            usagePresence = deltaPresence;
            if (last !== null) {
              addDiagnosticEvent(
                "lastVsCumulativeMismatches",
                Number(row.timestamp_ms),
              );
            }
          }
        } else if (last !== null && last.total_tokens > 0) {
          addDiagnosticEvent(
            "duplicateSnapshotsSkipped",
            Number(row.timestamp_ms),
          );
        }
      } else {
        usage = last;
        usagePresence = lastPresence;
        addDiagnosticEvent(
          "lastOnlyEvents",
          Number(row.timestamp_ms),
        );
      }
      if (usage === null
          || (usage.input_tokens === 0 && usage.output_tokens === 0)
          || row.observed_at === null) continue;
      const components = canonicalComponents(usage);
      const model = row.has_explicit_model === 1
        ? row.explicit_model
        : currentModel;
      insertUsage.run(
        source.sourceKey,
        row.source_offset,
        row.timestamp_ms,
        row.observed_at,
        model,
        0,
        components.input_uncached_tokens,
        components.input_cache_read_tokens,
        components.input_cache_write_tokens,
        components.output_text_tokens,
        components.output_reasoning_tokens,
      );
      const tier = tierAt(tierTimeline, Number(row.timestamp_ms));
      if (Number(row.timestamp_ms) >= projectionStartMs
          && Number(row.timestamp_ms) <= projectionEndMs) {
        await invokeProjection(onUsage, {
        timestamp: row.observed_at,
        timestampMs: Number(row.timestamp_ms),
        sequence: projectionSequence++,
        model,
        totalInputContextTokens: 0,
        components: {
          ...components,
        },
        tierSemantics: {
          billingSurface: "chatgpt_subscription",
          codexSpeedMode: tier?.speed ?? "unknown",
          apiServiceTier: tier?.apiServiceTier ?? "unknown",
          tierSource: tier
            ? "rollout_thread_settings"
            : "unobserved",
          tierObservedAt: tier === null
            ? null
            : new Date(tier.timestampMs).toISOString(),
        },
        surfaceClassification: {
          surface: source.surface,
          threadSource: source.threadSource,
          agentScope: source.agentScope,
          lineageDisposition: source.lineageDisposition,
        },
        sourceRolloutOrdinal: source.ordinal,
        sourceRecordOrdinal: Number(row.source_offset),
        });
      }
    }
    for (const released of leadingQuotaGate.flush()) {
      await commitQuota(released);
    }
    materializePreviousTotals();
    writeSnapshotSet.run(
      source.sourceKey,
      encodeSnapshotSet(localSnapshots),
    );
    // The set is a deduplicated view of this source's token_count records, so
    // it may hold fewer keys than records were seen but never more. Storing
    // both numbers is what makes a set that was written short auditable at
    // all: the encoding alone can only prove it decodes to what was encoded.
    const observedRecords = Number(
      readSourceDiagnostic.get(
        source.sourceKey,
        "tokenCountRecords",
      )?.count ?? 0,
    );
    setSourceDiagnostic.run(
      source.sourceKey,
      "snapshotKeysStored",
      localSnapshots.size,
    );
    if (localSnapshots.size > observedRecords) {
      addSourceDiagnostic.run(
        source.sourceKey,
        "impossibleSnapshotSets",
        1,
      );
    }
    snapshotCache.set(source.sourceKey, localSnapshots);
    for (const [code, timestamps] of diagnosticSeries) {
      writeDiagnosticSeries.run(
        source.sourceKey,
        code,
        encodeTimestampSeries(timestamps),
      );
    }
    updateState.run(
      currentModel,
      currentModelSeen ? 1 : 0,
      previousTotals === null ? null : stableJson(previousTotals),
      previousPresence === null ? null : stableJson(previousPresence),
      source.sourceKey,
    );
  }
}

function updateMeta(database, {
  startAt,
  endAt,
  generatedAt,
  coverage,
  sourceCount,
  sourceBytes,
  scanWallMs,
  scanBytes,
  workerCount,
  phaseWallMs,
}) {
  const set = database.prepare(`
    INSERT INTO meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `);
  for (const [key, value] of Object.entries({
    schema_version: LOCAL_ANALYSIS_INDEX_SCHEMA_VERSION,
    parser_version: LOCAL_ANALYSIS_INDEX_PARSER_VERSION,
    status: coverage.status,
    generated_at: generatedAt,
    covered_start_at: startAt,
    covered_end_at: endAt,
    source_count: String(sourceCount),
    source_bytes: String(sourceBytes),
    indexed_source_count: String(coverage.indexedSourceCount),
    pending_source_count: String(coverage.pendingSourceCount),
    indexed_bytes: String(coverage.indexedBytes),
    coverage_blocked_reason: "none",
    last_scan_wall_ms: String(scanWallMs),
    last_scan_bytes: String(scanBytes),
    last_worker_count: String(workerCount),
    last_phase_wall_ms: stableJson(phaseWallMs),
  })) set.run(key, value);
}

function classificationCounts(sources) {
  const bySurface = {};
  const byThreadSource = {};
  const byAgentScope = {};
  for (const source of sources) {
    bySurface[source.surface] = (bySurface[source.surface] ?? 0) + 1;
    byThreadSource[source.threadSource] =
      (byThreadSource[source.threadSource] ?? 0) + 1;
    byAgentScope[source.agentScope] =
      (byAgentScope[source.agentScope] ?? 0) + 1;
  }
  return { bySurface, byThreadSource, byAgentScope };
}

function diagnosticCount(
  database,
  code,
  startMs = null,
  endMs = null,
) {
  if (startMs === null || endMs === null) {
    const row = database.prepare(`
      SELECT COALESCE(SUM(count), 0) AS count
      FROM source_diagnostics WHERE code = ?
    `).get(code);
    return Number(row.count);
  }
  let count = 0;
  for (const row of database.prepare(`
    SELECT timestamps_blob FROM diagnostic_series WHERE code = ?
  `).iterate(code)) {
    const values = decodeTimestampSeries(row.timestamps_blob);
    let lower = 0;
    let upper = values.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (values[middle] < startMs) lower = middle + 1;
      else upper = middle;
    }
    const first = lower;
    upper = values.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (values[middle] <= endMs) lower = middle + 1;
      else upper = middle;
    }
    count += lower - first;
  }
  return count;
}

function buildDiagnostics(database, sources, startMs, endMs) {
  const classification = classificationCounts(sources);
  const diagnostics = structuredClone(DIAGNOSTIC_DEFAULTS);
  diagnostics.filesScanned = sources.length;
  diagnostics.lineageParentsMissing = sources.filter(
    (source) => source.parentMissing,
  ).length;
  for (const code of [
    "malformedLines",
    "malformedTimestamps",
    "malformedUsageRecords",
    "tokenCountRecords",
    "snapshotKeysStored",
    "reassembledLineMismatches",
    "impossibleSnapshotSets",
    "tierSettingEvents",
    "malformedTierSettingEvents",
  ]) diagnostics[code] = diagnosticCount(database, code);
  for (const code of [
    "missingRateLimitRecords",
    "malformedRateLimitRecords",
    "contradictedLeadingSnapshotsSkipped",
    "lastVsCumulativeMismatches",
    "duplicateSnapshotsSkipped",
    "forkReplayEventsSkipped",
    "unattributedForkReplayEventsSkipped",
    "lastOnlyEvents",
  ]) diagnostics[code] = diagnosticCount(
    database,
    code,
    startMs,
    endMs,
  );
  diagnostics.rateLimitSnapshots = Number(database.prepare(`
    SELECT COUNT(*) AS count FROM quota_facts
    WHERE timestamp_ms >= ? AND timestamp_ms <= ?
  `).get(startMs, endMs).count);
  diagnostics.tierSettingCounts = {};
  for (const speed of ["standard", "fast", "flex", "batch", "unknown"]) {
    const count = diagnosticCount(
      database,
      `tierSettingCount:${speed}`,
    );
    if (count > 0) diagnostics.tierSettingCounts[speed] = count;
  }
  diagnostics.rolloutsBySurface = classification.bySurface;
  diagnostics.rolloutsByThreadSource = classification.byThreadSource;
  diagnostics.rolloutsByAgentScope = classification.byAgentScope;
  return diagnostics;
}

function tierTimelines(database) {
  const result = new Map();
  for (const row of database.prepare(`
    SELECT source_key, source_offset, timestamp_ms, speed, api_service_tier
    FROM tier_events
    ORDER BY source_key, timestamp_ms, source_offset
  `).iterate()) {
    const rows = result.get(row.source_key) ?? [];
    rows.push({
      sourceOffset: Number(row.source_offset),
      timestampMs: Number(row.timestamp_ms),
      speed: row.speed,
      apiServiceTier: row.api_service_tier,
    });
    result.set(row.source_key, rows);
  }
  return result;
}

function tierAt(timeline, timestampMs) {
  let lower = 0;
  let upper = timeline.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (timeline[middle].timestampMs <= timestampMs) lower = middle + 1;
    else upper = middle;
  }
  return lower === 0 ? null : timeline[lower - 1];
}

function readIndexScan(database, {
  sources,
  startAt,
  endAt,
  onUsage,
  onRateLimitSnapshot,
  signal,
}) {
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  const sourceMap = new Map(sources.map((source) => [
    source.sourceKey,
    source,
  ]));
  const timelines = tierTimelines(database);
  return (async () => {
    let sequence = 0;
    for (const row of database.prepare(`
      SELECT source_key, source_offset, timestamp_ms, observed_at, model,
             total_input_context_tokens, input_uncached_tokens,
             input_cache_read_tokens, input_cache_write_tokens,
             output_text_tokens, output_reasoning_tokens
      FROM usage_facts
      WHERE timestamp_ms >= ? AND timestamp_ms <= ?
      ORDER BY timestamp_ms, source_key, source_offset
    `).iterate(startMs, endMs)) {
      throwIfAborted(signal);
      const source = sourceMap.get(row.source_key);
      if (!source) continue;
      const tier = tierAt(
        timelines.get(row.source_key) ?? [],
        Number(row.timestamp_ms),
      );
      const usageResult = onUsage?.({
        timestamp: row.observed_at,
        timestampMs: Number(row.timestamp_ms),
        sequence: sequence++,
        model: row.model,
        totalInputContextTokens:
          Number(row.total_input_context_tokens),
        components: {
          input_uncached_tokens: Number(row.input_uncached_tokens),
          input_cache_read_tokens: Number(row.input_cache_read_tokens),
          input_cache_write_tokens: Number(row.input_cache_write_tokens),
          output_text_tokens: Number(row.output_text_tokens),
          output_reasoning_tokens: Number(row.output_reasoning_tokens),
        },
        tierSemantics: {
          billingSurface: "chatgpt_subscription",
          codexSpeedMode: tier?.speed ?? "unknown",
          apiServiceTier: tier?.apiServiceTier ?? "unknown",
          tierSource: tier
            ? "rollout_thread_settings"
            : "unobserved",
          tierObservedAt: tier === null
            ? null
            : new Date(tier.timestampMs).toISOString(),
        },
        surfaceClassification: {
          surface: source.surface,
          threadSource: source.threadSource,
          agentScope: source.agentScope,
          lineageDisposition: source.lineageDisposition,
        },
        sourceRolloutOrdinal: source.ordinal,
        sourceRecordOrdinal: Number(row.source_offset),
      });
      if (usageResult
          && typeof usageResult.then === "function") {
        await usageResult;
      }
    }
    for (const row of database.prepare(`
      SELECT source_key, source_offset, timestamp_ms, observed_at,
             provider, plan_type, limit_id, slot, used_percent,
             window_duration_mins, resets_at
      FROM quota_facts
      WHERE timestamp_ms >= ? AND timestamp_ms <= ?
        AND window_duration_mins BETWEEN 1 AND 525600
        AND window_duration_mins = CAST(window_duration_mins AS INTEGER)
      ORDER BY timestamp_ms, source_key, source_offset, slot_order
    `).iterate(startMs, endMs)) {
      throwIfAborted(signal);
      const source = sourceMap.get(row.source_key);
      if (!source) continue;
      const windowDurationMins = Number(row.window_duration_mins);
      if (!isValidQuotaWindowDuration(windowDurationMins)) continue;
      const quotaResult = onRateLimitSnapshot?.({
        timestamp: row.observed_at,
        timestampMs: Number(row.timestamp_ms),
        sequence: sequence++,
        window: {
          provider: row.provider,
          planType: row.plan_type,
          limitId: row.limit_id,
          slot: row.slot,
          usedPercent: Number(row.used_percent),
          windowDurationMins,
          resetsAt: Number(row.resets_at),
        },
        surfaceClassification: {
          surface: source.surface,
          threadSource: source.threadSource,
          agentScope: source.agentScope,
          lineageDisposition: source.lineageDisposition,
        },
        sourceRolloutOrdinal: source.ordinal,
        sourceRecordOrdinal: Number(row.source_offset),
      });
      if (quotaResult
          && typeof quotaResult.then === "function") {
        await quotaResult;
      }
    }
    return {
      parserVersion: LOCAL_ANALYSIS_INDEX_PARSER_VERSION,
      diagnostics: buildDiagnostics(
        database,
        sources,
        startMs,
        endMs,
      ),
      toolCallsByClass: {},
      toolObservationsBySource: {},
      serverBillableUnits: {},
    };
  })();
}

export function defaultLocalAnalysisIndexPath(
  root = process.cwd(),
) {
  return resolve(
    root,
    ".usage-monitor",
    "local-analysis-index-v2.sqlite",
  );
}

export function defaultLocalAnalysisIndexSecretPath(indexFile) {
  return resolve(
    dirname(indexFile),
    "local-analysis-index-secret-v2",
  );
}

export async function refreshLocalAnalysisIndex({
  indexFile = defaultLocalAnalysisIndexPath(),
  secretFile = defaultLocalAnalysisIndexSecretPath(indexFile),
  codexHome,
  startAt,
  endAt,
  signal = null,
  workerCount = Math.min(
    MAXIMUM_WORKERS,
    Math.max(1, availableParallelism() - 2),
  ),
  chunkBytes = DEFAULT_CHUNK_BYTES,
  // Optional per-refresh limits let a first full-history index make durable
  // progress in bounded slices. They are deliberately opt-in: the existing
  // fixed-window caller keeps its one-generation atomic behavior.
  maximumSourcesPerRefresh = null,
  maximumScanBytesPerRefresh = null,
  maximumCommitBytes = null,
  discoveryLimits = null,
  onUsage = null,
  onRateLimitSnapshot = null,
  beforeStage = null,
} = {}) {
  if (typeof indexFile !== "string"
      || typeof secretFile !== "string"
      || typeof codexHome !== "string"
      || !Number.isFinite(Date.parse(startAt))
      || !Number.isFinite(Date.parse(endAt))
      || Date.parse(endAt) < Date.parse(startAt)
      || !validAbortSignal(signal)
      || !Number.isSafeInteger(workerCount)
      || workerCount < 1
      || workerCount > MAXIMUM_WORKERS
      || !Number.isSafeInteger(chunkBytes)
      || chunkBytes < 4 * 1024 * 1024
      || chunkBytes > 256 * 1024 * 1024
      || !validOptionalPositiveSafeInteger(maximumSourcesPerRefresh)
      || !validOptionalPositiveSafeInteger(maximumScanBytesPerRefresh)
      || !validOptionalPositiveSafeInteger(maximumCommitBytes)
      || !validOptionalDiscoveryLimits(discoveryLimits)
      || (onUsage !== null && typeof onUsage !== "function")
      || (onRateLimitSnapshot !== null
        && typeof onRateLimitSnapshot !== "function")
      || (beforeStage !== null && typeof beforeStage !== "function")) {
    throw new TypeError("Local analysis index options are invalid");
  }
  throwIfAborted(signal);
  const startedAt = performance.now();
  const phaseWallMs = {};
  await mkdir(dirname(indexFile), { recursive: true, mode: 0o700 });
  const secret = await readOrCreateSecret(secretFile);
  const discoveryStartedAt = performance.now();
  const infos = await discoverCodexRolloutInfos({
    codexHome,
    startAt,
    endAt,
    signal,
    discoveryLimits,
  });
  let existing = null;
  try {
    existing = openExistingIndex(indexFile, { requireComplete: false });
  } catch (error) {
    if (![
      "local_analysis_index_unavailable",
      "local_analysis_index_schema_invalid",
    ].includes(error?.code)) throw error;
  }
  const existingByKey = existing === null
    ? new Map()
    : readStoredSources(existing.database);
  existing?.database.close();
  const { sources, reusedCount: sourceProjectionReusedCount } =
    await projectSources(infos, secret, signal, existingByKey);
  phaseWallMs.discoveryProjection =
    performance.now() - discoveryStartedAt;
  const currentByKey = new Map(sources.map((source) => [
    source.sourceKey,
    source,
  ]));

  const removed = new Set(
    [...existingByKey.keys()].filter((key) => !currentByKey.has(key)),
  );
  const resetInitial = new Set();
  const append = new Set();
  for (const source of sources) {
    const prior = existingByKey.get(source.sourceKey);
    if (!prior) {
      resetInitial.add(source.sourceKey);
    } else if (exactSourceState(prior, source)) {
      // Reuse the complete durable prefix.
    } else if (sameIdentity(prior, source)
        // Appending must advance at least one observed byte boundary. A
        // same-size rewrite is never an append, even if its terminal boundary
        // happens to match the old prefix.
        && (source.prefixBytes > prior.prefixBytes
          || source.fileSize > prior.fileSize)
        && source.boundaryStart <= prior.prefixBytes
        && prior.boundaryHmac === (await sourceBoundary(
          secret,
          source.info.path,
          prior.prefixBytes,
        )).boundaryHmac) {
      append.add(source.sourceKey);
    } else {
      resetInitial.add(source.sourceKey);
    }
  }
  const combinedForInvalidation = new Map([
    ...existingByKey,
    ...currentByKey,
  ]);
  const resetKeys = descendantsOf(
    new Set([...removed, ...resetInitial]),
    combinedForInvalidation,
  );
  for (const key of resetKeys) append.delete(key);
  const changedKeys = new Set([
    ...[...resetKeys].filter((key) => currentByKey.has(key)),
    ...append,
  ]);
  // With a verified complete index and no changed, appended, or removed
  // sources, copying a potentially large SQLite file just to record a
  // zero-byte refresh provides no new durable fact. Leave the complete,
  // verified generation in place and return the same indexed result.
  const allSourcesAlreadyComplete = sources.every((source) => {
    const prior = existingByKey.get(source.sourceKey);
    return prior?.indexState === "complete"
      && prior.scanOffset >= source.prefixBytes;
  });
  if (existing !== null
      && existing.meta.status === "complete"
      && changedKeys.size === 0
      && removed.size === 0
      && allSourcesAlreadyComplete) {
    const sourceBytes = sources.reduce(
      (sum, source) => sum + source.prefixBytes,
      0,
    );
    return {
      status: "reused",
      indexFile,
      sources,
      sourceCount: sources.length,
      sourceBytes,
      coverage: {
        status: "complete",
        sourceCount: sources.length,
        indexedSourceCount: sources.length,
        pendingSourceCount: 0,
        sourceBytes,
        indexedBytes: sourceBytes,
      },
      scanBytes: 0,
      workerCount,
      sourceProjectionReusedCount,
      wallMs: performance.now() - startedAt,
      phaseWallMs,
      streamedScanResult: null,
    };
  }
  // Staging duplicates the current index. Let the archive orchestrator make a
  // conservative disk-headroom decision only after this no-op reuse path is
  // known to be inapplicable, so a complete unchanged archive is never
  // downgraded merely because a future deep budget would not currently fit.
  if (beforeStage !== null) await beforeStage();
  const stageFile = `${indexFile}.building-${process.pid}-${randomBytes(6).toString("hex")}`;
  let database;
  let scanBytes = 0;
  let workerResults = [];
  let shardDirectory = null;
  let attachedSchemas = [];
  let streamedScanResult = null;
  try {
    if (existing === null) {
      database = createFreshIndex(stageFile);
    } else {
      await copyFile(indexFile, stageFile);
      await chmod(stageFile, 0o600);
      database = openExistingIndex(stageFile, {
        readOnly: false,
        staging: true,
        requireComplete: false,
      }).database;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      const deleteSource = database.prepare(
        "DELETE FROM sources WHERE source_key = ?",
      );
      for (const key of removed) deleteSource.run(key);
      insertOrUpdateSources(database, sources);
      resetSources(
        database,
        [...resetKeys].filter((key) => currentByKey.has(key)),
      );
      markSourcesPending(database, append);
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }

    const batch = planIndexBatch({
      sources,
      existingByKey,
      resetKeys,
      appendKeys: append,
      maximumSourcesPerRefresh,
      maximumScanBytesPerRefresh,
      chunkBytes,
    });
    const { tasks } = batch;
    const sourceBytes = sources.reduce(
      (sum, source) => sum + source.prefixBytes,
      0,
    );
    const resetPending = new Set(resetKeys);
    const taskSourceKeys = new Set(tasks.map((task) => task.sourceKey));
    const noTaskOffsets = new Map(
      [...batch.sourceEndOffsets].filter(([key]) => !taskSourceKeys.has(key)),
    );
    const slices = taskSlices(tasks, maximumCommitBytes);
    let coverage = null;
    for (let sliceIndex = 0; sliceIndex < slices.length; sliceIndex += 1) {
      const slice = slices[sliceIndex];
      const completedOffsets = sourceEndOffsetsForTasks(slice);
      if (sliceIndex === 0) {
        for (const [key, offset] of noTaskOffsets) {
          completedOffsets.set(key, offset);
        }
      }
      const selectedKeys = new Set(completedOffsets.keys());
      scanBytes += slice.reduce(
        (sum, task) => sum + task.endByte - task.startByte,
        0,
      );
      if (slice.length > 0) {
        const extracted = await extractTasks({
          tasks: slice,
          workerCount,
          signal,
          tempParent: dirname(indexFile),
        });
        workerResults = extracted.results;
        shardDirectory = extracted.shardDirectory;
        phaseWallMs.extraction = (phaseWallMs.extraction ?? 0)
          + extracted.extractWallMs;
        phaseWallMs.shardMerge = (phaseWallMs.shardMerge ?? 0)
          + extracted.mergeWallMs;
        attachedSchemas = attachExtractedShards(
          database,
          extracted.shardFiles,
        );
        const extractedSchemaBySource = new Map(
          [...extracted.sourceShardIndexes].map(
            ([sourceKeyValue, index]) => [
              sourceKeyValue,
              attachedSchemas[index],
            ],
          ),
        );
        const resetForSlice = new Set(
          [...resetPending].filter((key) => selectedKeys.has(key)),
        );
        const derivationStartedAt = performance.now();
        database.exec("BEGIN IMMEDIATE");
        try {
          await deriveChangedSources({
            database,
            sources,
            changedKeys: selectedKeys,
            resetKeys: resetForSlice,
            extractedSchemaBySource,
            workerResults,
            onUsage: existing === null ? onUsage : null,
            onRateLimitSnapshot:
              existing === null ? onRateLimitSnapshot : null,
            projectionStartMs: Date.parse(startAt),
            projectionEndMs: Date.parse(endAt),
            signal,
          });
          markSourcesIndexed(database, completedOffsets);
          database.exec("COMMIT");
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          throw error;
        }
        for (const key of resetForSlice) resetPending.delete(key);
        phaseWallMs.derivation = (phaseWallMs.derivation ?? 0)
          + performance.now() - derivationStartedAt;
        detachExtractedShards(database, attachedSchemas);
        attachedSchemas = [];
        await rm(shardDirectory, { recursive: true, force: true });
        shardDirectory = null;
        const factIndexStartedAt = performance.now();
        database.exec(`
          CREATE INDEX IF NOT EXISTS usage_facts_time
            ON usage_facts(timestamp_ms, source_key, source_offset);
          CREATE INDEX IF NOT EXISTS quota_facts_time
            ON quota_facts(
              timestamp_ms, source_key, source_offset, slot_order
            );
        `);
        phaseWallMs.factIndexes = (phaseWallMs.factIndexes ?? 0)
          + performance.now() - factIndexStartedAt;
      } else if (completedOffsets.size > 0) {
        database.exec("BEGIN IMMEDIATE");
        try {
          markSourcesIndexed(database, completedOffsets);
          database.exec("COMMIT");
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          throw error;
        }
      }
      coverage = indexCoverage(database, sources);
      updateMeta(database, {
        startAt: new Date(startAt).toISOString(),
        endAt: new Date(endAt).toISOString(),
        generatedAt: new Date().toISOString(),
        coverage,
        sourceCount: sources.length,
        sourceBytes,
        scanWallMs: Math.round(performance.now() - startedAt),
        scanBytes,
        workerCount,
        phaseWallMs,
      });
      const finalizeStartedAt = performance.now();
      database.exec("PRAGMA optimize");
      const integrity = database.prepare("PRAGMA quick_check").get();
      if (integrity?.quick_check !== "ok") {
        throw fixedError("local_analysis_index_integrity_failed");
      }
      await syncPath(stageFile);
      await publishStagedIndex(stageFile, indexFile);
      phaseWallMs.finalize = (phaseWallMs.finalize ?? 0)
        + performance.now() - finalizeStartedAt;
    }
    if (coverage === null) {
      throw fixedError("local_analysis_index_coverage_unavailable");
    }
    if (existing === null && coverage.status === "complete") {
      streamedScanResult = {
        parserVersion: LOCAL_ANALYSIS_INDEX_PARSER_VERSION,
        diagnostics: buildDiagnostics(
          database,
          sources,
          Date.parse(startAt),
          Date.parse(endAt),
        ),
        toolCallsByClass: {},
        toolObservationsBySource: {},
        serverBillableUnits: {},
      };
    }
    database.close();
    database = null;
    return {
      status: existing === null
        ? "built"
        : changedKeys.size === 0
            && removed.size === 0
            && batch.selectedKeys.size === 0
          ? "reused"
          : "updated",
      indexFile,
      sources,
      sourceCount: sources.length,
      sourceBytes: sources.reduce(
        (sum, source) => sum + source.prefixBytes,
        0,
      ),
      coverage,
      scanBytes,
      workerCount,
      sourceProjectionReusedCount,
      wallMs: performance.now() - startedAt,
      phaseWallMs,
      streamedScanResult,
    };
  } catch (error) {
    if (database?.isOpen && attachedSchemas.length > 0) {
      try {
        detachExtractedShards(database, attachedSchemas);
      } catch {
        // The staging database is discarded after any failed derivation.
      }
    }
    if (database?.isOpen) database.close();
    if (error?.name === "AbortError"
        || (typeof error?.code === "string"
          && error.code.startsWith("local_analysis_"))) throw error;
    throw fixedError("local_analysis_index_failed");
  } finally {
    if (shardDirectory !== null) {
      await rm(shardDirectory, { recursive: true, force: true })
        .catch(() => {});
    }
    await rm(stageFile, { force: true }).catch(() => {});
  }
}

// Archive orchestration records only a fixed reason when discovery or a
// deadline prevents a fresh completeness check. This deliberately does not
// store a path, source name, exception message, or any raw source detail.
// The next successful refresh clears the marker through updateMeta().
export async function markLocalAnalysisIndexCoveragePartial({
  indexFile = defaultLocalAnalysisIndexPath(),
  reason,
  observedAt = new Date().toISOString(),
} = {}) {
  const observedAtMs = typeof observedAt === "string"
    ? Date.parse(observedAt)
    : Number.NaN;
  if (typeof indexFile !== "string"
      || indexFile.length < 1
      || !COVERAGE_BLOCK_REASONS.has(reason)
      || typeof observedAt !== "string"
      || !Number.isFinite(observedAtMs)
      || new Date(observedAtMs).toISOString() !== observedAt) {
    throw new TypeError("Local analysis coverage marker is invalid");
  }
  let database;
  let initialMarkerFile = null;
  let missing = false;
  try {
    await lstat(indexFile);
  } catch (metadataError) {
    if (metadataError?.code === "ENOENT") missing = true;
    else throw metadataError;
  }
  try {
    if (!missing) {
      ({ database } = openExistingIndex(indexFile, {
        readOnly: false,
        requireComplete: false,
      }));
    } else {
      // A first discovery can reach a safety cap before there is enough source
      // metadata to build an ordinary index. Persist a zero-source partial
      // marker in that precise case, so the UI can distinguish it from no
      // attempted archive indexing. Do not replace a present unreadable or
      // incompatible index: it remains a separate fail-closed condition.
      await mkdir(dirname(indexFile), { recursive: true, mode: 0o700 });
      initialMarkerFile = `${indexFile}.coverage-${process.pid}-${randomBytes(6).toString("hex")}`;
      database = createFreshIndex(initialMarkerFile);
      database.exec("BEGIN IMMEDIATE");
      try {
        updateMeta(database, {
          startAt: observedAt,
          endAt: observedAt,
          generatedAt: observedAt,
          coverage: {
            status: "partial",
            sourceCount: 0,
            indexedSourceCount: 0,
            pendingSourceCount: 0,
            sourceBytes: 0,
            indexedBytes: 0,
          },
          sourceCount: 0,
          sourceBytes: 0,
          scanWallMs: 0,
          scanBytes: 0,
          workerCount: 0,
          phaseWallMs: {},
        });
        database.exec("COMMIT");
      } catch (initialError) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw initialError;
      }
    }
    const set = database.prepare(`
      INSERT INTO meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `);
    database.exec("BEGIN IMMEDIATE");
    try {
      set.run("status", "partial");
      set.run("coverage_blocked_reason", reason);
      set.run("coverage_blocked_at", observedAt);
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    if (initialMarkerFile !== null) {
      await rm(initialMarkerFile, { force: true }).catch(() => {});
    }
    throw error;
  } finally {
    if (database?.isOpen) database.close();
  }
  if (initialMarkerFile === null) {
    await syncPath(indexFile);
  } else {
    try {
      await syncPath(initialMarkerFile);
      await publishStagedIndex(initialMarkerFile, indexFile);
    } finally {
      await rm(initialMarkerFile, { force: true }).catch(() => {});
    }
  }
  return { status: "partial", blockReason: reason };
}

export function createIndexedCodexLogScan({
  indexFile = defaultLocalAnalysisIndexPath(),
  secretFile = defaultLocalAnalysisIndexSecretPath(indexFile),
  workerCount,
  chunkBytes,
} = {}) {
  return async function scanIndexedCodexLogs({
    codexHome,
    startAt,
    endAt,
    onUsage,
    onRateLimitSnapshot,
    signal = null,
  } = {}) {
    const refreshed = await refreshLocalAnalysisIndex({
      indexFile,
      secretFile,
      codexHome,
      startAt,
      endAt,
      signal,
      onUsage,
      onRateLimitSnapshot,
      ...(workerCount === undefined ? {} : { workerCount }),
      ...(chunkBytes === undefined ? {} : { chunkBytes }),
    });
    if (refreshed.streamedScanResult !== null) {
      return refreshed.streamedScanResult;
    }
    const { database } = openExistingIndex(indexFile);
    try {
      return await readIndexScan(database, {
        sources: refreshed.sources,
        startAt,
        endAt,
        onUsage,
        onRateLimitSnapshot,
        signal,
      });
    } finally {
      database.close();
    }
  };
}

export async function writeLocalAnalysisIndexProjection({
  indexFile = defaultLocalAnalysisIndexPath(),
  kind = "replay_safe_accounting",
  schemaVersion,
  generatedAt,
  value,
} = {}) {
  if (typeof kind !== "string"
      || !/^[a-z][a-z0-9_]{0,63}$/u.test(kind)
      || typeof schemaVersion !== "string"
      || typeof generatedAt !== "string"
      || new Date(generatedAt).toISOString() !== generatedAt
      || !value
      || typeof value !== "object") {
    throw new TypeError("Local analysis projection is invalid");
  }
  const { database } = openExistingIndex(indexFile, { readOnly: false });
  try {
    database.prepare(`
      INSERT INTO projections(
        kind, schema_version, generated_at, value_json
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(kind) DO UPDATE SET
        schema_version=excluded.schema_version,
        generated_at=excluded.generated_at,
        value_json=excluded.value_json
    `).run(
      kind,
      schemaVersion,
      generatedAt,
      stableJson(value),
    );
  } finally {
    database.close();
  }
}

export async function readLocalAnalysisIndexProjection({
  indexFile = defaultLocalAnalysisIndexPath(),
  kind = "replay_safe_accounting",
  schemaVersion,
} = {}) {
  if (typeof kind !== "string" || typeof schemaVersion !== "string") {
    throw new TypeError("Local analysis projection request is invalid");
  }
  let opened;
  try {
    opened = openExistingIndex(indexFile);
    const row = opened.database.prepare(`
      SELECT schema_version, generated_at, value_json
      FROM projections WHERE kind = ?
    `).get(kind);
    if (!row || row.schema_version !== schemaVersion) {
      return { status: "unavailable", value: null };
    }
    return {
      status: "available",
      generatedAt: row.generated_at,
      value: JSON.parse(row.value_json),
    };
  } catch {
    return { status: "unavailable", value: null };
  } finally {
    opened?.database.close();
  }
}

export async function inspectLocalAnalysisIndex({
  indexFile = defaultLocalAnalysisIndexPath(),
} = {}) {
  const { database, meta } = openExistingIndex(indexFile, {
    requireComplete: false,
  });
  try {
    const sourceCount = Number(
      database.prepare("SELECT COUNT(*) AS count FROM sources").get().count,
    );
    const usageFacts = Number(
      database.prepare(
        "SELECT COUNT(*) AS count FROM usage_facts",
      ).get().count,
    );
    const quotaFacts = Number(
      database.prepare(
        "SELECT COUNT(*) AS count FROM quota_facts",
      ).get().count,
    );
    const snapshotKeys = Number(
      [...database.prepare(
        "SELECT snapshot_blob FROM source_snapshot_sets",
      ).iterate()].reduce(
        (sum, row) => sum + decodeSnapshotSet(row.snapshot_blob).size,
        0,
      ),
    );
    // Reported next to the key count so an incomplete set is visible: keys can
    // only ever be fewer than the records they were deduplicated from.
    const tokenCountRecords = Number(database.prepare(`
      SELECT COALESCE(SUM(count), 0) AS count
      FROM source_diagnostics WHERE code = 'tokenCountRecords'
    `).get().count);
    const reassembledLineMismatches = Number(database.prepare(`
      SELECT COALESCE(SUM(count), 0) AS count
      FROM source_diagnostics WHERE code = 'reassembledLineMismatches'
    `).get().count);
    const metadata = await stat(indexFile);
    const sourceBytes = Number(database.prepare(
      "SELECT COALESCE(SUM(prefix_bytes), 0) AS bytes FROM sources",
    ).get().bytes);
    const coverage = coverageFromMeta(meta, sourceCount, sourceBytes);
    return {
      schemaVersion: meta.schema_version,
      parserVersion: meta.parser_version,
      generatedAt: meta.generated_at,
      coveredAt: {
        startAt: meta.covered_start_at,
        endAt: meta.covered_end_at,
      },
      coverage,
      sourceCount,
      usageFacts,
      quotaFacts,
      snapshotKeys,
      tokenCountRecords,
      reassembledLineMismatches,
      indexBytes: metadata.size,
      lastScan: {
        wallMs: Number(meta.last_scan_wall_ms),
        bytes: Number(meta.last_scan_bytes),
        workers: Number(meta.last_worker_count),
        phases: JSON.parse(meta.last_phase_wall_ms ?? "{}"),
      },
      privacy: {
        sourcePathsStored: false,
        filenamesStored: false,
        rawIdentifiersStored: false,
        rawJsonStored: false,
      },
    };
  } finally {
    database.close();
  }
}
