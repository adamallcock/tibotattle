import { constants } from "node:fs";
import { chmod, open } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalRateLimitWindows,
  normalizeTokenUsage,
  tokenComponentPresence,
} from "./codex-log-scan.js";
import { recognizedExportModelId } from "./export/index.js";
import { normalizeProviderTier } from "./providers/codex/logs.js";

const COMPONENT_KEYS = Object.freeze([
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
]);
const TOKEN_NEEDLE = Buffer.from('"type":"token_count"');
const MODEL_NEEDLE = Buffer.from('"type":"turn_context"');
const TIER_NEEDLE = Buffer.from('"type":"thread_settings_applied"');
const RELEVANT_NEEDLES = Object.freeze([
  TOKEN_NEEDLE,
  MODEL_NEEDLE,
  TIER_NEEDLE,
]);
const READ_BUFFER_BYTES = 4 * 1024 * 1024;
const MAXIMUM_LINE_BYTES = 16 * 1024 * 1024;
const OVERSIZED_CLASSIFICATION_BYTES = 64 * 1024;
const WITNESS_BYTES = 16;

function fixedFailure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeModel(value) {
  return recognizedExportModelId(value) ?? "unknown";
}

function presenceMask(value) {
  const presence = tokenComponentPresence(value);
  let mask = 0;
  for (let index = 0; index < COMPONENT_KEYS.length; index += 1) {
    if (presence[COMPONENT_KEYS[index]]) mask |= 1 << index;
  }
  return mask;
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") return null;
  const timestampMs = Date.parse(value);
  if (!Number.isFinite(timestampMs)) return null;
  const canonical = new Date(timestampMs).toISOString();
  return canonical === value ? canonical : null;
}

function relevantLine(line) {
  return RELEVANT_NEEDLES.some((needle) => line.includes(needle));
}

// A few bytes taken from each end of a segment while it is still the bytes we
// read, kept apart from the segment itself so the segment cannot vouch for its
// own contents. A carry that a later read overwrote is overwritten from its
// first byte, because every read fills the buffer from offset zero.
function segmentWitness(offset, segment) {
  const headBytes = Math.min(WITNESS_BYTES, segment.length);
  return {
    offset,
    length: segment.length,
    head: Buffer.from(segment.subarray(0, headBytes)),
    tail: Buffer.from(
      segment.subarray(Math.max(0, segment.length - WITNESS_BYTES)),
    ),
  };
}

function witnessHolds(line, witness) {
  const end = witness.offset + witness.length;
  return end <= line.length
    && line.subarray(
      witness.offset,
      witness.offset + witness.head.length,
    ).equals(witness.head)
    && line.subarray(end - witness.tail.length, end).equals(witness.tail);
}

function oversizedRecordRelevant(prefix) {
  const text = prefix.toString("utf8");
  const firstType = text.indexOf('"type":"');
  if (firstType === -1) return true;
  const valueStart = firstType + '"type":"'.length;
  const valueEnd = text.indexOf('"', valueStart);
  if (valueEnd === -1) return true;
  const topLevelType = text.slice(valueStart, valueEnd);
  if (topLevelType === "turn_context") return true;
  if (topLevelType !== "event_msg") return false;
  const payloadType = text.indexOf('"type":"', valueEnd + 1);
  if (payloadType === -1) return true;
  const payloadStart = payloadType + '"type":"'.length;
  const payloadEnd = text.indexOf('"', payloadStart);
  if (payloadEnd === -1) return true;
  return [
    "thread_settings_applied",
    "token_count",
  ].includes(text.slice(payloadStart, payloadEnd));
}

function sameIdentity(stats, task) {
  return (!Number.isSafeInteger(task.dev) || stats.dev === task.dev)
    && (!Number.isSafeInteger(task.ino) || stats.ino === task.ino)
    && (!Number.isFinite(task.birthtimeMs)
      || Math.trunc(stats.birthtimeMs) === Math.trunc(task.birthtimeMs));
}

function assertSafeStats(stats, task) {
  if (!stats.isFile()
      || stats.isSymbolicLink()
      || stats.nlink !== 1
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || !sameIdentity(stats, task)
      || stats.size < task.endByte) {
    throw fixedFailure("local_analysis_source_changed");
  }
}

function configureShard(database) {
  database.exec(`
    PRAGMA journal_mode=OFF;
    PRAGMA synchronous=OFF;
    PRAGMA temp_store=FILE;
    PRAGMA cache_size=-4096;
    PRAGMA mmap_size=0;
    PRAGMA trusted_schema=OFF;
    PRAGMA foreign_keys=ON;
    CREATE TABLE model_events (
      source_key TEXT NOT NULL,
      source_offset INTEGER NOT NULL,
      model TEXT NOT NULL,
      PRIMARY KEY(source_key, source_offset)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE tier_events (
      source_key TEXT NOT NULL,
      source_offset INTEGER NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      speed TEXT NOT NULL,
      api_service_tier TEXT NOT NULL,
      PRIMARY KEY(source_key, source_offset)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE token_records (
      source_key TEXT NOT NULL,
      source_offset INTEGER NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      observed_at TEXT,
      explicit_model TEXT NOT NULL,
      has_explicit_model INTEGER NOT NULL CHECK(has_explicit_model IN (0, 1)),
      has_total INTEGER NOT NULL CHECK(has_total IN (0, 1)),
      has_last INTEGER NOT NULL CHECK(has_last IN (0, 1)),
      total_presence INTEGER NOT NULL,
      last_presence INTEGER NOT NULL,
      total_input INTEGER NOT NULL,
      total_cached_input INTEGER NOT NULL,
      total_cache_write INTEGER NOT NULL,
      total_output INTEGER NOT NULL,
      total_reasoning INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      last_input INTEGER NOT NULL,
      last_cached_input INTEGER NOT NULL,
      last_cache_write INTEGER NOT NULL,
      last_output INTEGER NOT NULL,
      last_reasoning INTEGER NOT NULL,
      last_tokens INTEGER NOT NULL,
      rate_status TEXT NOT NULL
        CHECK(rate_status IN ('missing', 'malformed', 'valid')),
      PRIMARY KEY(source_key, source_offset)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE quota_records (
      source_key TEXT NOT NULL,
      source_offset INTEGER NOT NULL,
      slot_order INTEGER NOT NULL,
      provider TEXT NOT NULL,
      plan_type TEXT NOT NULL,
      limit_id TEXT NOT NULL,
      slot TEXT NOT NULL,
      used_percent REAL NOT NULL,
      window_duration_mins INTEGER NOT NULL,
      resets_at INTEGER NOT NULL,
      PRIMARY KEY(source_key, source_offset, slot_order)
    ) STRICT, WITHOUT ROWID;
  `);
}

function statements(database) {
  return {
    model: database.prepare(`
      INSERT INTO model_events(source_key, source_offset, model)
      VALUES (?, ?, ?)
    `),
    tier: database.prepare(`
      INSERT INTO tier_events(
        source_key, source_offset, timestamp_ms, speed, api_service_tier
      ) VALUES (?, ?, ?, ?, ?)
    `),
    token: database.prepare(`
      INSERT INTO token_records(
        source_key, source_offset, timestamp_ms, observed_at,
        explicit_model, has_explicit_model, has_total, has_last,
        total_presence, last_presence,
        total_input, total_cached_input, total_cache_write,
        total_output, total_reasoning, total_tokens,
        last_input, last_cached_input, last_cache_write,
        last_output, last_reasoning, last_tokens, rate_status
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?
      )
    `),
    quota: database.prepare(`
      INSERT INTO quota_records(
        source_key, source_offset, slot_order, provider, plan_type,
        limit_id, slot, used_percent, window_duration_mins, resets_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
  };
}

function addDiagnostic(diagnostics, sourceKey, code, count = 1) {
  const key = `${sourceKey}\0${code}`;
  diagnostics.set(key, (diagnostics.get(key) ?? 0) + count);
}

function componentValues(value) {
  return COMPONENT_KEYS.map((key) => value?.[key] ?? 0);
}

function processRecord(line, sourceOffset, task, prepared, diagnostics) {
  let record;
  try {
    record = JSON.parse(line.toString("utf8"));
  } catch {
    addDiagnostic(diagnostics, task.sourceKey, "malformedLines");
    return;
  }
  const timestampMs = Date.parse(record?.timestamp);
  if (!Number.isFinite(timestampMs)) {
    addDiagnostic(diagnostics, task.sourceKey, "malformedTimestamps");
    return;
  }

  if (record.type === "turn_context") {
    if (typeof record.payload?.model === "string") {
      prepared.model.run(
        task.sourceKey,
        sourceOffset,
        safeModel(record.payload.model),
      );
    }
    return;
  }

  if (record.type === "event_msg"
      && record.payload?.type === "thread_settings_applied") {
    const rawTier = record.payload?.thread_settings?.service_tier;
    if (rawTier !== null && typeof rawTier !== "string") {
      addDiagnostic(
        diagnostics,
        task.sourceKey,
        "malformedTierSettingEvents",
      );
      return;
    }
    const tier = normalizeProviderTier(rawTier, {
      billingSurface: "chatgpt_subscription",
      tierSource: "rollout_thread_settings",
      tierObservedAt: canonicalTimestamp(record.timestamp),
    });
    prepared.tier.run(
      task.sourceKey,
      sourceOffset,
      Math.trunc(timestampMs),
      tier.codexSpeedMode,
      tier.apiServiceTier,
    );
    addDiagnostic(diagnostics, task.sourceKey, "tierSettingEvents");
    addDiagnostic(
      diagnostics,
      task.sourceKey,
      `tierSettingCount:${tier.codexSpeedMode}`,
    );
    return;
  }

  if (record.type !== "event_msg"
      || record.payload?.type !== "token_count") return;
  const info = record.payload?.info;
  const totalRaw = info?.total_token_usage;
  const lastRaw = info?.last_token_usage;
  const total = normalizeTokenUsage(totalRaw);
  const last = normalizeTokenUsage(lastRaw);
  if ((totalRaw && !total) || (lastRaw && !last)) {
    addDiagnostic(diagnostics, task.sourceKey, "malformedUsageRecords");
  }
  const windows = canonicalRateLimitWindows(record.payload?.rate_limits);
  const rateStatus = record.payload?.rate_limits === null
      || record.payload?.rate_limits === undefined
    ? "missing"
    : windows.length === 0
      ? "malformed"
      : "valid";
  const explicitModel = record.payload?.model ?? info?.model;
  const hasExplicitModel = typeof explicitModel === "string";
  prepared.token.run(
    task.sourceKey,
    sourceOffset,
    Math.trunc(timestampMs),
    canonicalTimestamp(record.timestamp),
    hasExplicitModel ? safeModel(explicitModel) : "unknown",
    hasExplicitModel ? 1 : 0,
    total === null ? 0 : 1,
    last === null ? 0 : 1,
    presenceMask(totalRaw),
    presenceMask(lastRaw),
    ...componentValues(total),
    ...componentValues(last),
    rateStatus,
  );
  // The observation count the index pairs with the number of distinct
  // cumulative-token keys it stores: keys can only ever be fewer.
  addDiagnostic(diagnostics, task.sourceKey, "tokenCountRecords");
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];
    prepared.quota.run(
      task.sourceKey,
      sourceOffset,
      index,
      window.provider,
      window.planType,
      window.limitId,
      window.slot,
      window.usedPercent,
      window.windowDurationMins,
      window.resetsAt,
    );
  }
}

async function alignedStart(handle, task) {
  if (task.startByte === 0) return 0;
  const prior = Buffer.allocUnsafe(1);
  const result = await handle.read(prior, 0, 1, task.startByte - 1);
  if (result.bytesRead !== 1) {
    throw fixedFailure("local_analysis_source_changed");
  }
  if (prior[0] === 0x0a) return task.startByte;
  const buffer = Buffer.allocUnsafe(Math.min(
    READ_BUFFER_BYTES,
    task.endByte - task.startByte,
  ));
  let position = task.startByte;
  while (position < task.endByte) {
    const length = Math.min(buffer.length, task.endByte - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) {
      throw fixedFailure("local_analysis_source_changed");
    }
    const newline = buffer.indexOf(0x0a, 0);
    if (newline !== -1 && newline < bytesRead) {
      return position + newline + 1;
    }
    position += bytesRead;
  }
  return task.endByte;
}

async function scanTask(task, prepared, diagnostics) {
  let handle;
  try {
    handle = await open(
      task.path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = await handle.stat();
    assertSafeStats(before, task);
    let position = await alignedStart(handle, task);
    if (position >= task.endByte) return;
    let lineStart = position;
    let carry = [];
    let carryBytes = 0;
    let oversized = false;
    let classificationPrefix = Buffer.alloc(0);
    // Evidence about every segment held across a read, so a line rebuilt from
    // stale bytes is caught instead of quietly dropping the record inside it.
    let witnesses = [];

    function append(segment) {
      if (segment.length === 0) return;
      if (classificationPrefix.length < OVERSIZED_CLASSIFICATION_BYTES) {
        const remaining = OVERSIZED_CLASSIFICATION_BYTES
          - classificationPrefix.length;
        classificationPrefix = Buffer.concat([
          classificationPrefix,
          segment.subarray(0, remaining),
        ]);
      }
      carryBytes += segment.length;
      if (oversized) return;
      if (carryBytes > MAXIMUM_LINE_BYTES) {
        oversized = true;
        carry = [];
        return;
      }
      carry.push(segment);
    }

    function complete(endExclusive) {
      if (oversized) {
        if (oversizedRecordRelevant(classificationPrefix)) {
          throw fixedFailure("local_analysis_line_bytes_limit_exceeded");
        }
        addDiagnostic(
          diagnostics,
          task.sourceKey,
          "oversizedIrrelevantLines",
        );
      } else {
        const line = carry.length === 1
          ? carry[0]
          : Buffer.concat(carry, carryBytes);
        // Only a line held across a read can have been rebuilt wrongly; a line
        // read whole has no witnesses and costs nothing here.
        if (witnesses.some((witness) => !witnessHolds(line, witness))) {
          // The rebuilt line is not the bytes that were read, so whatever
          // record it held is lost. Nothing downstream can notice that on its
          // own: the line simply stops looking relevant and disappears.
          addDiagnostic(
            diagnostics,
            task.sourceKey,
            "reassembledLineMismatches",
          );
        }
        if (relevantLine(line)) {
          processRecord(line, lineStart, task, prepared, diagnostics);
        }
      }
      carry = [];
      carryBytes = 0;
      oversized = false;
      classificationPrefix = Buffer.alloc(0);
      witnesses = [];
      lineStart = endExclusive;
    }

    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let finishedBoundaryLine = false;
    while (!finishedBoundaryLine) {
      const remainingToBoundary = task.endByte - position;
      const readLimit = Math.min(buffer.length, Math.max(
        1,
        remainingToBoundary > 0
          ? remainingToBoundary
          : before.size - position,
      ));
      const { bytesRead } = await handle.read(buffer, 0, readLimit, position);
      if (bytesRead === 0) break;
      let cursor = 0;
      let newline = buffer.indexOf(0x0a, cursor);
      while (newline !== -1 && newline < bytesRead) {
        // This segment is consumed by complete() before the next read, so it
        // needs neither a copy nor a witness.
        append(buffer.subarray(cursor, newline));
        const endExclusive = position + newline + 1;
        complete(endExclusive);
        cursor = newline + 1;
        if (lineStart >= task.endByte) {
          finishedBoundaryLine = true;
          break;
        }
        newline = buffer.indexOf(0x0a, cursor);
      }
      if (!finishedBoundaryLine) {
        const tail = buffer.subarray(cursor, bytesRead);
        // An oversized line is never rebuilt, so there is nothing to witness.
        if (tail.length > 0 && !oversized) {
          witnesses.push(segmentWitness(carryBytes, tail));
        }
        // COPY, DO NOT "OPTIMISE" BACK TO THE VIEW. This tail is a partial
        // line: it stays in `carry` until a later read supplies the rest of
        // it, and that read refills this very buffer. A view would then hold
        // the later read's bytes, `complete()` would join a corrupt line, and
        // the record in it would silently disappear from the index.
        append(Buffer.from(tail));
      }
      position += bytesRead;
      if (!finishedBoundaryLine
          && position >= task.endByte
          && oversized) {
        complete(position);
        return;
      }
      if (position >= before.size) break;
    }
    if (!finishedBoundaryLine && carryBytes > 0 && lineStart < task.endByte) {
      complete(position);
    }
    const after = await handle.stat();
    if (!sameIdentity(after, task)
        || after.size < task.endByte
        || after.size < before.size) {
      throw fixedFailure("local_analysis_source_changed");
    }
  } catch (error) {
    if (typeof error?.code === "string"
        && error.code.startsWith("local_analysis_")) throw error;
    throw fixedFailure("local_analysis_source_unavailable");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function main() {
  const { shardFile, tasks } = workerData ?? {};
  if (typeof shardFile !== "string"
      || !Array.isArray(tasks)
      || tasks.some((task) => (
        !task
        || typeof task.path !== "string"
        || typeof task.sourceKey !== "string"
        || !Number.isSafeInteger(task.startByte)
        || !Number.isSafeInteger(task.endByte)
        || task.startByte < 0
        || task.endByte < task.startByte
      ))) {
    throw fixedFailure("local_analysis_worker_input_invalid");
  }
  const database = new DatabaseSync(shardFile, {
    readOnly: false,
    timeout: 5_000,
  });
  try {
    configureShard(database);
    const prepared = statements(database);
    const diagnostics = new Map();
    let bytesScheduled = 0;
    for (const task of tasks) {
      database.exec("BEGIN IMMEDIATE");
      try {
        await scanTask(task, prepared, diagnostics);
        database.exec("COMMIT");
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
      bytesScheduled += task.endByte - task.startByte;
    }
    database.close();
    await chmod(shardFile, 0o600);
    return {
      bytesScheduled,
      tasks: tasks.length,
      diagnostics: [...diagnostics.entries()]
        .map(([key, count]) => {
          const separator = key.indexOf("\0");
          return {
            sourceKey: key.slice(0, separator),
            code: key.slice(separator + 1),
            count,
          };
        })
        .sort((left, right) => (
          left.sourceKey.localeCompare(right.sourceKey)
          || left.code.localeCompare(right.code)
        )),
    };
  } finally {
    if (database.isOpen) database.close();
  }
}

main().then(
  (result) => parentPort.postMessage({ ok: true, result }),
  (error) => parentPort.postMessage({
    ok: false,
    code: typeof error?.code === "string"
        && error.code.startsWith("local_analysis_")
      ? error.code
      : "local_analysis_worker_failed",
  }),
);
