import { createHash, createHmac } from "node:crypto";
import { chmodSync, constants, existsSync, lstatSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { platform } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { minimizeClaudeTranscriptCanonicalOccurrence } from "./claude-transcript-export-source.js";
import { readBoundedUtf8LineEntries } from "./bounded-jsonl.js";

export const CLAUDE_DESKTOP_INCREMENTAL_CANONICALIZER_VERSION =
  "claude-desktop-incremental-canonicalizer-v0.2";

const MAXIMUM_LINE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_SOURCE_BYTES = 32 * 1024 * 1024 * 1024;
const MAXIMUM_SOURCE_FILES = 25_000;
const MAXIMUM_CANONICAL_RECORDS = 2_000_000;
const TOOL_KEYS = Object.freeze([
  "web_search", "file_search", "code_interpreter", "hosted_shell", "computer_use", "mcp",
  "apply_patch", "local_shell", "subagent", "tool_gateway", "other", "unknown",
]);

export class ClaudeDesktopIncrementalCanonicalizerError extends Error {
  constructor(code) {
    super(`Claude Desktop incremental canonicalizer failed (${code})`);
    this.name = "ClaudeDesktopIncrementalCanonicalizerError";
    this.code = `claude_desktop_incremental_${code}`;
  }
}

function fail(code) {
  throw new ClaudeDesktopIncrementalCanonicalizerError(code);
}

function safeSignal(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object"
      || typeof value.aborted !== "boolean"
      || typeof value.addEventListener !== "function") fail("configuration");
  return value;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  throw error;
}

function safeKey(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail("key");
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeSecret(secret) {
  if (!(secret instanceof Uint8Array) || secret.byteLength !== 32) fail("configuration");
  return Buffer.from(secret);
}

function sourceKey(secret, path, stats) {
  return createHmac("sha256", secret)
    .update("app-usagemonitor/claude-transcript-source/v1\0", "utf8")
    .update(stableJson({
      path,
      device: stats.dev,
      inode: stats.ino,
      birthtimeMs: Math.trunc(stats.birthtimeMs),
    }))
    .digest("hex");
}

function assertSafeFile(stats) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
      || (uid !== null && stats.uid !== uid)
      || (platform() !== "win32" && (stats.mode & 0o022) !== 0)
      || stats.size > MAXIMUM_SOURCE_BYTES) fail("source_unsafe");
}

function sameFile(stats, expected) {
  return stats.dev === expected.dev && stats.ino === expected.ino
    && Math.trunc(stats.birthtimeMs) === Math.trunc(expected.birthtimeMs);
}

async function completePrefixBytes(handle, size) {
  if (size === 0) return 0;
  let scanned = 0;
  for (let end = size; end > 0;) {
    const remaining = MAXIMUM_LINE_BYTES + 1 - scanned;
    if (remaining <= 0) fail("line_bytes");
    const start = Math.max(0, end - Math.min(256 * 1024, remaining));
    const buffer = Buffer.allocUnsafe(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    if (bytesRead !== buffer.length) fail("source_changed");
    scanned += bytesRead;
    const newline = buffer.lastIndexOf(0x0a);
    if (newline !== -1) return start + newline + 1;
    end = start;
  }
  return 0;
}

async function hashPrefix(handle, bytes) {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(256 * 1024);
  for (let offset = 0; offset < bytes;) {
    const length = Math.min(buffer.length, bytes - offset);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead !== length) fail("source_changed");
    digest.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return digest.digest("hex");
}

function selectedAfter(left, right) {
  if (left.hasIterationBreakdown !== Boolean(right.selected_has_iteration)) {
    return left.hasIterationBreakdown;
  }
  if (left.costEventOutputTokens !== right.selected_cost_output_tokens) {
    return left.costEventOutputTokens > right.selected_cost_output_tokens;
  }
  if (left.timestamp !== right.selected_timestamp) return left.timestamp > right.selected_timestamp;
  if (left.sourceKey !== right.selected_source_key) return left.sourceKey > right.selected_source_key;
  return left.lineOrdinal > right.selected_line_ordinal;
}

function configure(database) {
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS canonical_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS canonical_source (
      source_key TEXT PRIMARY KEY,
      device INTEGER NOT NULL,
      inode INTEGER NOT NULL,
      birthtime_ms INTEGER NOT NULL,
      prefix_bytes INTEGER NOT NULL CHECK(prefix_bytes >= 0),
      prefix_sha256 TEXT NOT NULL,
      prefix_lines INTEGER NOT NULL CHECK(prefix_lines >= 0),
      mtime_ms INTEGER NOT NULL CHECK(mtime_ms >= 0),
      generation INTEGER NOT NULL CHECK(generation >= 1),
      status TEXT NOT NULL CHECK(status IN ('present', 'missing_suspected')),
      updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS canonical_group (
      message_key TEXT PRIMARY KEY,
      invariant_sha256 TEXT NOT NULL,
      top_level_invariant_sha256 TEXT,
      iteration_invariant_sha256 TEXT,
      selected_timestamp TEXT NOT NULL,
      selected_output_tokens INTEGER NOT NULL CHECK(selected_output_tokens >= 0),
      selected_cost_output_tokens INTEGER NOT NULL CHECK(selected_cost_output_tokens >= 0),
      selected_has_iteration INTEGER NOT NULL CHECK(selected_has_iteration IN (0, 1)),
      selected_source_key TEXT NOT NULL,
      selected_source_generation INTEGER NOT NULL CHECK(selected_source_generation >= 1),
      selected_line_ordinal INTEGER NOT NULL CHECK(selected_line_ordinal >= 1),
      selected_cost_event_count INTEGER NOT NULL CHECK(selected_cost_event_count >= 1),
      selected_cost_structure_sha256 TEXT NOT NULL,
      selected_candidates_json TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS canonical_tool (
      message_key TEXT NOT NULL,
      tool_key TEXT NOT NULL,
      category TEXT NOT NULL,
      PRIMARY KEY(message_key, tool_key),
      FOREIGN KEY(message_key) REFERENCES canonical_group(message_key)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS dirty_group (
      message_key TEXT PRIMARY KEY,
      FOREIGN KEY(message_key) REFERENCES canonical_group(message_key)
    ) STRICT, WITHOUT ROWID;
  `);
  const groupColumns = new Set(database.prepare("PRAGMA table_info(canonical_group)")
    .all().map((row) => row.name));
  if (!groupColumns.has("selected_source_generation")) {
    database.exec(`
      ALTER TABLE canonical_group ADD COLUMN selected_source_generation INTEGER
        NOT NULL DEFAULT 1 CHECK(selected_source_generation >= 1)
    `);
  }
  database.prepare("INSERT OR REPLACE INTO canonical_meta(key, value) VALUES ('schema_version', ?)")
    .run(CLAUDE_DESKTOP_INCREMENTAL_CANONICALIZER_VERSION);
}

function secretVerifier(secret) {
  return createHmac("sha256", secret)
    .update("app-usagemonitor/claude-desktop-canonicalizer-secret/v1", "utf8")
    .digest("hex");
}

function emptyToolCounts() {
  return Object.fromEntries(TOOL_KEYS.map((key) => [key, 0]));
}

export function openClaudeDesktopIncrementalCanonicalizer(path, { secret } = {}) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) fail("configuration");
  const key = normalizeSecret(secret);
  const database = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    configure(database);
    for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
      if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
    }
    const verifier = secretVerifier(key);
    const storedVerifier = database.prepare(
      "SELECT value FROM canonical_meta WHERE key = 'secret_verifier'",
    ).get();
    if (storedVerifier && storedVerifier.value !== verifier) fail("secret_mismatch");
    database.prepare("INSERT OR IGNORE INTO canonical_meta(key, value) VALUES ('secret_verifier', ?)")
      .run(verifier);
  } catch (error) {
    database.close();
    key.fill(0);
    throw error;
  }

  const getGroup = database.prepare("SELECT * FROM canonical_group WHERE message_key = ?");
  const insertGroup = database.prepare(`
    INSERT INTO canonical_group(
      message_key, invariant_sha256, top_level_invariant_sha256, iteration_invariant_sha256,
      selected_timestamp, selected_output_tokens, selected_cost_output_tokens,
      selected_has_iteration, selected_source_key, selected_source_generation, selected_line_ordinal,
      selected_cost_event_count, selected_cost_structure_sha256, selected_candidates_json, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  const updateGroup = database.prepare(`
    UPDATE canonical_group SET
      top_level_invariant_sha256 = ?, iteration_invariant_sha256 = ?,
      selected_timestamp = ?, selected_output_tokens = ?, selected_cost_output_tokens = ?,
      selected_has_iteration = ?, selected_source_key = ?, selected_line_ordinal = ?,
      selected_source_generation = ?,
      selected_cost_event_count = ?, selected_cost_structure_sha256 = ?,
      selected_candidates_json = ?, revision = revision + 1
    WHERE message_key = ?
  `);
  const getTool = database.prepare(
    "SELECT category FROM canonical_tool WHERE message_key = ? AND tool_key = ?",
  );
  const insertTool = database.prepare(
    "INSERT INTO canonical_tool(message_key, tool_key, category) VALUES (?, ?, ?)",
  );
  const markDirty = database.prepare("INSERT OR IGNORE INTO dirty_group(message_key) VALUES (?)");
  let canonicalGroupCount = Number(database.prepare(
    "SELECT COUNT(*) AS count FROM canonical_group",
  ).get().count);
  let canonicalToolCount = Number(database.prepare(
    "SELECT COUNT(*) AS count FROM canonical_tool",
  ).get().count);

  function mergeOccurrence(occurrence, generation) {
    const existing = getGroup.get(occurrence.messageKey);
    let changed = false;
    if (!existing) {
      insertGroup.run(
        occurrence.messageKey,
        occurrence.invariant,
        occurrence.topLevelInvariant,
        occurrence.iterationInvariant,
        occurrence.selected.timestamp,
        occurrence.selected.outputCombinedTokens,
        occurrence.selected.costEventOutputTokens,
        occurrence.selected.hasIterationBreakdown ? 1 : 0,
        occurrence.selected.sourceKey,
        generation,
        occurrence.selected.lineOrdinal,
        occurrence.selected.costEventCount,
        occurrence.selected.costStructureSha256,
        stableJson(occurrence.candidates),
      );
      canonicalGroupCount += 1;
      if (canonicalGroupCount > MAXIMUM_CANONICAL_RECORDS) fail("output_records");
      changed = true;
    } else {
      if (existing.invariant_sha256 !== occurrence.invariant) fail("invariant_conflict");
      const top = occurrence.topLevelInvariant ?? existing.top_level_invariant_sha256;
      const iteration = occurrence.iterationInvariant ?? existing.iteration_invariant_sha256;
      if (existing.top_level_invariant_sha256 !== null && occurrence.topLevelInvariant !== null
          && existing.top_level_invariant_sha256 !== occurrence.topLevelInvariant) fail("invariant_conflict");
      if (existing.iteration_invariant_sha256 !== null && occurrence.iterationInvariant !== null
          && existing.iteration_invariant_sha256 !== occurrence.iterationInvariant) fail("invariant_conflict");
      if (selectedAfter(occurrence.selected, existing)) {
        updateGroup.run(
          top,
          iteration,
          occurrence.selected.timestamp,
          occurrence.selected.outputCombinedTokens,
          occurrence.selected.costEventOutputTokens,
          occurrence.selected.hasIterationBreakdown ? 1 : 0,
          occurrence.selected.sourceKey,
          occurrence.selected.lineOrdinal,
          generation,
          occurrence.selected.costEventCount,
          occurrence.selected.costStructureSha256,
          stableJson(occurrence.candidates),
          occurrence.messageKey,
        );
        changed = true;
      } else if (top !== existing.top_level_invariant_sha256
          || iteration !== existing.iteration_invariant_sha256) {
        database.prepare(`
          UPDATE canonical_group SET top_level_invariant_sha256 = ?, iteration_invariant_sha256 = ?
          WHERE message_key = ?
        `).run(top, iteration, occurrence.messageKey);
      }
    }
    for (const tool of occurrence.tools) {
      const prior = getTool.get(occurrence.messageKey, tool.toolKey);
      if (prior && prior.category !== tool.category) fail("tool_conflict");
      if (!prior) {
        insertTool.run(occurrence.messageKey, tool.toolKey, tool.category);
        canonicalToolCount += 1;
        if (canonicalToolCount > MAXIMUM_CANONICAL_RECORDS) fail("output_records");
        changed = true;
      }
    }
    if (changed) markDirty.run(occurrence.messageKey);
  }

  async function refresh({
    sourcePaths,
    startAt,
    endAt,
    observedAtMs = Date.now(),
    signal = null,
  } = {}) {
    if (!Array.isArray(sourcePaths) || sourcePaths.length > MAXIMUM_SOURCE_FILES
        || sourcePaths.some((value) => typeof value !== "string" || value.length === 0)
        || !Number.isSafeInteger(observedAtMs) || observedAtMs < 0) fail("configuration");
    const selectedSignal = safeSignal(signal);
    throwIfAborted(selectedSignal);
    const startMs = Date.parse(startAt);
    const endMs = Date.parse(endAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) fail("configuration");
    const normalizedBounds = {
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
    };
    const bounds = stableJson(normalizedBounds);
    const storedBounds = database.prepare(
      "SELECT value FROM canonical_meta WHERE key = 'projection_bounds'",
    ).get();
    if (storedBounds) {
      const priorBounds = JSON.parse(storedBounds.value);
      const priorStartMs = Date.parse(priorBounds.startAt);
      const priorEndMs = Date.parse(priorBounds.endAt);
      if (endMs < priorEndMs) fail("bounds_regression");
      if (startMs < priorStartMs || endMs > priorEndMs) {
        database.prepare(`
          INSERT OR IGNORE INTO dirty_group(message_key)
          SELECT message_key FROM canonical_group
          WHERE selected_timestamp >= ? AND selected_timestamp <= ?
            AND NOT (selected_timestamp >= ? AND selected_timestamp <= ?)
        `).run(
          normalizedBounds.startAt,
          normalizedBounds.endAt,
          priorBounds.startAt,
          priorBounds.endAt,
        );
      }
      database.prepare("UPDATE canonical_meta SET value = ? WHERE key = 'projection_bounds'")
        .run(bounds);
    } else {
      database.prepare("INSERT INTO canonical_meta(key, value) VALUES ('projection_bounds', ?)")
        .run(bounds);
    }
    const paths = sourcePaths.map((value) => {
      const requested = resolve(value);
      const requestedStats = lstatSync(requested, { bigint: false });
      if (requestedStats.isSymbolicLink()) fail("source_unsafe");
      return realpathSync(requested);
    });
    if (new Set(paths).size !== paths.length) fail("configuration");
    const observedKeys = new Set();
    let parsedBytes = 0;
    let parsedLines = 0;
    let assistantOccurrences = 0;
    let observedSourceBytes = 0;
    let appendedSources = 0;
    let rebuiltSources = 0;
    let unchangedSources = 0;
    const presentSources = [];

    for (const pathValue of paths) {
      throwIfAborted(selectedSignal);
      const before = lstatSync(pathValue, { bigint: false });
      assertSafeFile(before);
      observedSourceBytes += before.size;
      if (observedSourceBytes > MAXIMUM_SOURCE_BYTES) fail("source_bytes");
      const keyValue = sourceKey(key, pathValue, before);
      observedKeys.add(keyValue);
      const prior = database.prepare(
        "SELECT * FROM canonical_source WHERE source_key = ?",
      ).get(keyValue);
      const handle = await open(pathValue, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        assertSafeFile(opened);
        if (!sameFile(opened, before)) fail("source_changed");
        const prefixBytes = await completePrefixBytes(handle, opened.size);
        const sameMetadata = prior && prior.prefix_bytes === prefixBytes
          && prior.mtime_ms === Math.trunc(opened.mtimeMs);
        if (sameMetadata) {
          presentSources.push({ sourceKey: keyValue, sourceGeneration: Number(prior.generation) });
          const after = await handle.stat();
          if (!sameFile(after, opened) || after.size !== opened.size
              || after.mtimeMs !== opened.mtimeMs) fail("source_changed");
          unchangedSources += 1;
          database.prepare(`
            UPDATE canonical_source SET status = 'present', updated_at_ms = ? WHERE source_key = ?
          `).run(observedAtMs, keyValue);
          continue;
        }

        let startByte = 0;
        let startLineOrdinal = 1;
        let generation = Number(prior?.generation ?? 0) + 1;
        if (prior && prefixBytes >= prior.prefix_bytes
            && await hashPrefix(handle, prior.prefix_bytes) === prior.prefix_sha256) {
          startByte = prior.prefix_bytes;
          startLineOrdinal = prior.prefix_lines + 1;
          generation = prior.generation;
          appendedSources += 1;
        } else {
          rebuiltSources += 1;
        }

        database.exec("BEGIN IMMEDIATE");
        const groupCountBefore = canonicalGroupCount;
        const toolCountBefore = canonicalToolCount;
        try {
          let lastLine = startLineOrdinal - 1;
          for await (const entry of readBoundedUtf8LineEntries(handle, {
            maximumLineBytes: MAXIMUM_LINE_BYTES,
            maximumTotalBytes: prefixBytes,
            startByte,
            startLineOrdinal,
            oversizedIrrelevantNeedles: ["{"],
          })) {
            if ((entry.lineOrdinal & 255) === 0) throwIfAborted(selectedSignal);
            lastLine = entry.lineOrdinal;
            parsedBytes += entry.endByteExclusive - entry.startByte;
            parsedLines += 1;
            if (entry.line === null || entry.line.trim() === "") continue;
            const occurrence = minimizeClaudeTranscriptCanonicalOccurrence(
              entry.line, keyValue, entry.lineOrdinal, { secret: key },
            );
            if (occurrence) {
              assistantOccurrences += 1;
              mergeOccurrence(occurrence, generation);
            }
          }
          const prefixSha256 = await hashPrefix(handle, prefixBytes);
          const after = await handle.stat();
          if (!sameFile(after, opened) || after.size !== opened.size
              || after.mtimeMs !== opened.mtimeMs) fail("source_changed");
          database.prepare(`
            INSERT INTO canonical_source(
              source_key, device, inode, birthtime_ms, prefix_bytes, prefix_sha256,
              prefix_lines, mtime_ms, generation, status, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'present', ?)
            ON CONFLICT(source_key) DO UPDATE SET
              prefix_bytes = excluded.prefix_bytes,
              prefix_sha256 = excluded.prefix_sha256,
              prefix_lines = excluded.prefix_lines,
              mtime_ms = excluded.mtime_ms,
              generation = excluded.generation,
              status = 'present',
              updated_at_ms = excluded.updated_at_ms
          `).run(
            keyValue,
            opened.dev,
            opened.ino,
            Math.trunc(opened.birthtimeMs),
            prefixBytes,
            prefixSha256,
            lastLine,
            Math.trunc(opened.mtimeMs),
            generation,
            observedAtMs,
          );
          database.exec("COMMIT");
          presentSources.push({ sourceKey: keyValue, sourceGeneration: generation });
        } catch (error) {
          database.exec("ROLLBACK");
          canonicalGroupCount = groupCountBefore;
          canonicalToolCount = toolCountBefore;
          throw error;
        }
      } finally {
        await handle.close().catch(() => {});
      }
    }

    const allSources = database.prepare("SELECT source_key FROM canonical_source").all();
    const missing = allSources.filter((row) => !observedKeys.has(row.source_key));
    const markMissing = database.prepare(
      "UPDATE canonical_source SET status = 'missing_suspected', updated_at_ms = ? WHERE source_key = ?",
    );
    for (const row of missing) {
      throwIfAborted(selectedSignal);
      markMissing.run(observedAtMs, row.source_key);
    }

    const dirtyRows = database.prepare(`
      SELECT g.* FROM dirty_group d JOIN canonical_group g ON g.message_key = d.message_key
      ORDER BY g.message_key
    `).all();
    const toolRows = database.prepare(`
      SELECT category, COUNT(*) AS count FROM canonical_tool
      WHERE message_key = ? GROUP BY category
    `);
    const candidates = [];
    const dirtyKeys = [];
    for (const row of dirtyRows) {
      if ((dirtyKeys.length & 255) === 0) throwIfAborted(selectedSignal);
      dirtyKeys.push(row.message_key);
      const timestamp = Date.parse(row.selected_timestamp);
      if (timestamp < startMs || timestamp > endMs) continue;
      const counts = emptyToolCounts();
      for (const tool of toolRows.all(row.message_key)) {
        if (!Object.hasOwn(counts, tool.category)) fail("tool_category");
        counts[tool.category] = Number(tool.count);
      }
      const selectedCandidates = JSON.parse(row.selected_candidates_json);
      if (!Array.isArray(selectedCandidates) || selectedCandidates.length < 1) fail("candidate_state");
      selectedCandidates[selectedCandidates.length - 1].toolClassCounts = counts;
      for (const candidate of selectedCandidates) {
        candidates.push({
          sourceKey: row.selected_source_key,
          sourceGeneration: row.selected_source_generation,
          candidate,
        });
      }
    }
    return {
      sourceCount: paths.length,
      unchangedSources,
      appendedSources,
      rebuiltSources,
      missingSources: missing.length,
      parsedBytes,
      observedSourceBytes,
      parsedLines,
      assistantOccurrences,
      dirtyGroupCount: dirtyKeys.length,
      candidates,
      dirtyKeys,
      // Private keyed lifecycle handoff for the provider ledger. Callers must
      // project only counts across UI/upload boundaries.
      presentSources,
      missingSourceKeys: missing.map((row) => row.source_key),
    };
  }

  function acknowledgeDirty(messageKeys) {
    if (!Array.isArray(messageKeys)) fail("configuration");
    const remove = database.prepare("DELETE FROM dirty_group WHERE message_key = ?");
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const messageKey of messageKeys.map(safeKey)) remove.run(messageKey);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  function snapshot() {
    const counts = Object.fromEntries([
      ["sources", "canonical_source"],
      ["groups", "canonical_group"],
      ["tools", "canonical_tool"],
      ["dirtyGroups", "dirty_group"],
    ].map(([keyName, table]) => [keyName, Number(database.prepare(
      `SELECT COUNT(*) AS count FROM ${table}`,
    ).get().count)]));
    return counts;
  }

  return {
    refresh,
    acknowledgeDirty,
    snapshot,
    close() {
      database.close();
      key.fill(0);
    },
  };
}
