import {
  CODEX_LOG_RELEVANT_LINE_NEEDLES,
  throwIfAborted,
  validAbortSignal,
} from "./log-normalization.js";
import { classifySessionSurface } from "./surface-classification.js";

const MAXIMUM_ACTIVE_APPEND_PROOF_BYTES = 8 * 1024 * 1024;

export class CodexLogSourceChangedError extends Error {
  constructor() {
    super("Codex log source changed during scan; retry");
    this.name = "CodexLogSourceChangedError";
    this.code = "codex_log_source_changed";
    this.retryable = true;
  }
}

function sourceChanged() {
  throw new CodexLogSourceChangedError();
}

export function rethrowScannerControlError(error) {
  if (error?.name === "AbortError"
      || (typeof error?.code === "string" && error.code.startsWith("export_resource_"))) throw error;
}

function sameSourceIdentity(stats, expected) {
  if (Number.isSafeInteger(expected?.dev) && stats.dev !== expected.dev) return false;
  if (Number.isSafeInteger(expected?.ino) && stats.ino !== expected.ino) return false;
  if (Number.isFinite(expected?.birthtimeMs)
      && Math.trunc(stats.birthtimeMs) !== Math.trunc(expected.birthtimeMs)) return false;
  return true;
}

function sameSourceState(left, right) {
  return sameSourceIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

export function createCodexLogSources({ filesystem, lineReader }) {
  function boundedScannerLines(
    source,
    resourceGuard,
    maximumTotalBytes = Number.POSITIVE_INFINITY,
    signal = null,
  ) {
    return lineReader.readBoundedUtf8Lines(source, {
      maximumLineBytes: resourceGuard?.limits.maximumLineBytes,
      resourceGuard,
      oversizedIrrelevantNeedles: CODEX_LOG_RELEVANT_LINE_NEEDLES,
      maximumTotalBytes,
      signal,
    });
  }

  function assertActiveSourceStats(stats, expected = null) {
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) sourceChanged();
    const currentUid = filesystem.currentUid();
    if (currentUid !== null && stats.uid !== currentUid) sourceChanged();
    if (expected && !sameSourceIdentity(stats, expected)) sourceChanged();
  }

  async function statActiveSourcePath(path, expected) {
    let stats;
    try {
      stats = await filesystem.lstatPath(path);
    } catch {
      sourceChanged();
    }
    assertActiveSourceStats(stats, expected);
    return stats;
  }

  async function hashActiveSourcePrefix(handle, prefixBytes, resourceGuard = null) {
    if (!Number.isSafeInteger(prefixBytes) || prefixBytes < 0) sourceChanged();
    const digest = filesystem.createSha256();
    const buffer = new Uint8Array(256 * 1024);
    let offset = 0;
    while (offset < prefixBytes) {
      resourceGuard?.checkRuntime();
      const length = Math.min(buffer.length, prefixBytes - offset);
      let result;
      try {
        result = await handle.read(buffer, 0, length, offset);
      } catch {
        sourceChanged();
      }
      if (result.bytesRead !== length) sourceChanged();
      digest.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    return digest.digest("hex");
  }

  async function assertAppendedRecordsAfterEnd(
    handle,
    prefixBytes,
    currentSize,
    endMs,
    resourceGuard = null,
  ) {
    if (currentSize === prefixBytes) return;
    if (!Number.isSafeInteger(currentSize) || currentSize < prefixBytes
        || currentSize - prefixBytes > MAXIMUM_ACTIVE_APPEND_PROOF_BYTES) sourceChanged();
    if (prefixBytes > 0) {
      const boundary = new Uint8Array(1);
      let result;
      try {
        result = await handle.read(boundary, 0, 1, prefixBytes - 1);
      } catch {
        sourceChanged();
      }
      if (result.bytesRead !== 1 || boundary[0] !== 0x0a) sourceChanged();
    }
    const maximumLineBytes = Math.min(
      resourceGuard?.limits.maximumLineBytes ?? MAXIMUM_ACTIVE_APPEND_PROOF_BYTES,
      MAXIMUM_ACTIVE_APPEND_PROOF_BYTES,
    );
    try {
      for await (const line of lineReader.readBoundedUtf8Lines(handle, {
        maximumLineBytes,
        maximumTotalBytes: currentSize,
        startByte: prefixBytes,
      })) {
        resourceGuard?.checkRuntime();
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          sourceChanged();
        }
        const timestampMs = Date.parse(record?.timestamp);
        if (!Number.isFinite(timestampMs) || timestampMs <= endMs) sourceChanged();
      }
    } catch (error) {
      if (error instanceof CodexLogSourceChangedError) throw error;
      rethrowScannerControlError(error);
      sourceChanged();
    }
  }

  async function openActiveRolloutSnapshot(info, endMs, resourceGuard = null) {
    let handle;
    try {
      handle = await filesystem.openReadOnlyNoFollow(info.path);
      const stats = await handle.stat();
      assertActiveSourceStats(stats, info);
      await statActiveSourcePath(info.path, stats);
      if (stats.size < info.size) sourceChanged();
      if (stats.size === info.size
          && (stats.mtimeMs !== info.mtimeMs || stats.ctimeMs !== info.ctimeMs)) sourceChanged();
      await assertAppendedRecordsAfterEnd(handle, info.size, stats.size, endMs, resourceGuard);
      const prefixSha256 = await hashActiveSourcePrefix(handle, info.size, resourceGuard);
      const afterSnapshot = await handle.stat();
      assertActiveSourceStats(afterSnapshot, stats);
      await statActiveSourcePath(info.path, afterSnapshot);
      if (afterSnapshot.size < info.size) sourceChanged();
      await assertAppendedRecordsAfterEnd(handle, info.size, afterSnapshot.size, endMs, resourceGuard);
      return { handle, prefixSha256 };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error instanceof CodexLogSourceChangedError) throw error;
      rethrowScannerControlError(error);
      sourceChanged();
    }
  }

  async function verifyActiveRolloutSnapshot(info, snapshot, endMs, resourceGuard = null) {
    const { handle, prefixSha256 } = snapshot;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let before;
      try {
        before = await handle.stat();
      } catch {
        sourceChanged();
      }
      assertActiveSourceStats(before, info);
      if (before.size < info.size) sourceChanged();
      await assertAppendedRecordsAfterEnd(handle, info.size, before.size, endMs, resourceGuard);
      if (await hashActiveSourcePrefix(handle, info.size, resourceGuard) !== prefixSha256) sourceChanged();
      let after;
      try {
        after = await handle.stat();
      } catch {
        sourceChanged();
      }
      const pathStats = await statActiveSourcePath(info.path, after);
      if (sameSourceState(before, after) && sameSourceState(after, pathStats)) return;
      const appendOnlyGrowth = sameSourceIdentity(after, before)
        && after.size >= before.size
        && sameSourceIdentity(pathStats, after)
        && pathStats.size >= after.size
        && pathStats.size > before.size;
      if (!appendOnlyGrowth) sourceChanged();
    }
    sourceChanged();
  }

  async function collectJsonlFileInfos(root, resourceGuard = null, signal = null) {
    const files = [];
    async function walk(directory) {
      throwIfAborted(signal);
      let entries;
      try {
        entries = await filesystem.openDirectory(directory);
      } catch {
        return;
      }
      for await (const entry of entries) {
        throwIfAborted(signal);
        resourceGuard?.observeDirectoryEntry();
        const path = filesystem.joinPath(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          throwIfAborted(signal);
          const metadata = await filesystem.statPath(path);
          // Discovery walks bounded history to resolve ancestry, but charges
          // selected sources once before parsing.
          resourceGuard?.checkRuntime();
          files.push({
            path,
            dev: metadata.dev,
            mtimeMs: metadata.mtimeMs,
            ctimeMs: metadata.ctimeMs,
            size: metadata.size,
            ino: metadata.ino,
            birthtimeMs: metadata.birthtimeMs,
          });
        }
      }
    }
    await walk(root);
    return files;
  }

  async function readRolloutLineage(path, {
    resourceGuard = null,
    maximumTotalBytes = Number.POSITIVE_INFINITY,
    signal = null,
  } = {}) {
    if (!validAbortSignal(signal)) throw new TypeError("signal must be an AbortSignal or null");
    throwIfAborted(signal);
    for await (const line of boundedScannerLines(
      path,
      resourceGuard,
      maximumTotalBytes,
      signal,
    )) {
      throwIfAborted(signal);
      if (line === null) continue;
      if (!line.includes('"session_meta"')) continue;
      try {
        const record = JSON.parse(line);
        if (record.type !== "session_meta" || !record.payload) continue;
        const sessionId = typeof record.payload.id === "string"
          ? record.payload.id
          : (typeof record.payload.session_id === "string" ? record.payload.session_id : null);
        const parentId = typeof record.payload.forked_from_id === "string"
          ? record.payload.forked_from_id
          : (typeof record.payload.parent_thread_id === "string" ? record.payload.parent_thread_id : null);
        const surfaceClassification = classifySessionSurface(record.payload);
        return { sessionId, parentId, isFork: parentId !== null, surfaceClassification };
      } catch {
        // A malformed metadata line is handled by the main parser diagnostics.
      }
    }
    return {
      sessionId: null,
      parentId: null,
      isFork: false,
      surfaceClassification: classifySessionSurface(null),
    };
  }

  async function hasForkReplayPrefix(path) {
    return (await readRolloutLineage(path)).isFork;
  }

  function rolloutKey(path) {
    return path.slice(path.lastIndexOf("rollout-"));
  }

  async function mapWithConcurrency(values, concurrency, callback) {
    const result = new Array(values.length);
    let cursor = 0;
    async function worker() {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        result[index] = await callback(values[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
    return result;
  }

  async function discoverCodexRolloutInfos({
    codexHome = filesystem.defaultCodexHome(),
    startAt,
    endAt = null,
    resourceGuard = null,
    signal = null,
  }) {
    if (!validAbortSignal(signal)) throw new TypeError("signal must be an AbortSignal or null");
    throwIfAborted(signal);
    const cutoffMs = new Date(startAt).getTime();
    const endMs = endAt === null ? Number.POSITIVE_INFINITY : new Date(endAt).getTime();
    const [active, archived] = await Promise.all([
      collectJsonlFileInfos(filesystem.joinPath(codexHome, "sessions"), resourceGuard, signal),
      collectJsonlFileInfos(filesystem.joinPath(codexHome, "archived_sessions"), resourceGuard, signal),
    ]);
    throwIfAborted(signal);
    const byName = new Map();
    for (const info of archived) byName.set(rolloutKey(info.path), { ...info, location: "archive" });
    for (const info of active) byName.set(rolloutKey(info.path), { ...info, location: "active" });
    const all = await mapWithConcurrency([...byName.entries()], 16, async ([key, info]) => {
      throwIfAborted(signal);
      return {
        ...info,
        rolloutKey: key,
        lineage: await readRolloutLineage(info.path, { resourceGuard, signal }),
      };
    });
    throwIfAborted(signal);
    const bySessionId = new Map();
    for (const info of all) {
      if (!info.lineage.sessionId) continue;
      const existing = bySessionId.get(info.lineage.sessionId);
      if (existing && existing.rolloutKey !== info.rolloutKey) {
        throw new Error("Ambiguous duplicate Codex session identity across distinct rollout files");
      }
      bySessionId.set(info.lineage.sessionId, info);
    }

    const selected = new Set(all.filter((info) => {
      const sourceStartMs = rolloutStartMs(info.rolloutKey);
      return info.mtimeMs >= cutoffMs && (!Number.isFinite(sourceStartMs) || sourceStartMs <= endMs);
    }));
    function includeAncestors(info, visiting = new Set()) {
      const parentId = info.lineage.parentId;
      if (!parentId || visiting.has(parentId)) return;
      const parent = bySessionId.get(parentId);
      if (!parent) return;
      selected.add(parent);
      visiting.add(parentId);
      includeAncestors(parent, visiting);
    }
    for (const info of [...selected]) includeAncestors(info);

    const depthMemo = new Map();
    function lineageDepth(info, visiting = new Set()) {
      if (depthMemo.has(info)) return depthMemo.get(info);
      const parentId = info.lineage.parentId;
      if (!parentId || visiting.has(parentId)) return 0;
      const parent = bySessionId.get(parentId);
      if (!parent || !selected.has(parent)) return 0;
      visiting.add(parentId);
      const depth = 1 + lineageDepth(parent, visiting);
      depthMemo.set(info, depth);
      return depth;
    }

    return [...selected].sort((left, right) => {
      const depthDifference = lineageDepth(left) - lineageDepth(right);
      return depthDifference || left.rolloutKey.localeCompare(right.rolloutKey);
    });
  }

  async function discoverCodexRollouts(options) {
    return (await discoverCodexRolloutInfos(options)).map((info) => info.path);
  }

  function rolloutStartMs(key) {
    const match = /rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/.exec(key);
    return match ? Date.parse(`${match[1].replaceAll("-", (value, offset) => offset > 9 ? ":" : value)}Z`) : Number.NaN;
  }

  function hashString(value) {
    return filesystem.createSha256().update(value).digest("hex");
  }

  function summarizeCodexRolloutSources(rolloutInfos, { endAt = null } = {}) {
    const endMs = endAt ? Date.parse(endAt) : Number.POSITIVE_INFINITY;
    const relevantInfos = rolloutInfos.filter((info) => {
      const startMs = rolloutStartMs(info.rolloutKey);
      return !Number.isFinite(startMs) || startMs <= endMs;
    });
    const rows = relevantInfos.map((info) => ({
      keyHash: hashString(info.rolloutKey),
      size: info.size,
      mtimeMs: Math.trunc(info.mtimeMs),
      ino: info.ino,
      birthtimeMs: Math.trunc(info.birthtimeMs),
    }));
    return {
      schemaVersion: "codex-rollout-source-fingerprint-v1",
      fileCount: rows.length,
      totalSizeBytes: rows.reduce((sum, row) => sum + row.size, 0),
      maxMtimeMs: rows.reduce((maximum, row) => Math.max(maximum, row.mtimeMs), 0),
      fingerprint: hashString(JSON.stringify(rows)),
      files: rows,
    };
  }

  async function codexLogSourceFingerprint({ codexHome, startAt, endAt, includeSourcePaths = false }) {
    const rolloutInfos = await discoverCodexRolloutInfos({ codexHome, startAt });
    const summary = summarizeCodexRolloutSources(rolloutInfos, { endAt });
    if (includeSourcePaths) {
      const endMs = Date.parse(endAt);
      summary.sourcePathByKeyHash = Object.fromEntries(rolloutInfos
        .filter((info) => {
          const startMs = rolloutStartMs(info.rolloutKey);
          return !Number.isFinite(startMs) || startMs <= endMs;
        })
        .map((info) => [hashString(info.rolloutKey), info.path]));
    }
    return summary;
  }

  async function appendedRolloutSourcesAreAfterEnd({ cachedProvenance, currentProvenance, endAt }) {
    const endMs = Date.parse(endAt);
    if (!Number.isFinite(endMs)) return false;
    const cachedFiles = new Map((cachedProvenance?.files ?? []).map((file) => [file.keyHash, file]));
    const currentFiles = new Map((currentProvenance?.files ?? []).map((file) => [file.keyHash, file]));
    const sourcePaths = currentProvenance?.sourcePathByKeyHash ?? {};
    if (cachedFiles.size !== currentFiles.size) return false;
    for (const [key, prior] of cachedFiles) {
      const next = currentFiles.get(key);
      if (!next || next.ino !== prior.ino || Math.trunc(next.birthtimeMs) !== Math.trunc(prior.birthtimeMs) || next.size < prior.size) return false;
      if (next.size === prior.size) {
        if (Math.trunc(next.mtimeMs) !== Math.trunc(prior.mtimeMs)) return false;
        continue;
      }
      const path = sourcePaths[key];
      if (typeof path !== "string") return false;
      if (prior.size > 0) {
        let lastCharacter = "";
        for await (const chunk of filesystem.readUtf8Range(path, {
          start: prior.size - 1,
          end: prior.size - 1,
        })) lastCharacter += chunk;
        if (lastCharacter !== "\n") return false;
      }
      for await (const line of filesystem.readUtf8LinesRange(path, {
        start: prior.size,
        end: next.size - 1,
      })) {
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          return false;
        }
        const timestampMs = Date.parse(record?.timestamp);
        if (!Number.isFinite(timestampMs) || timestampMs <= endMs) return false;
      }
    }
    return true;
  }

  return {
    readRolloutLineage,
    hasForkReplayPrefix,
    discoverCodexRolloutInfos,
    discoverCodexRollouts,
    summarizeCodexRolloutSources,
    codexLogSourceFingerprint,
    appendedRolloutSourcesAreAfterEnd,
    openActiveRolloutSnapshot,
    verifyActiveRolloutSnapshot,
  };
}
