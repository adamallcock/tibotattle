import {
  CODEX_LOG_RELEVANT_LINE_NEEDLES,
  throwIfAborted,
  validAbortSignal,
} from "./log-normalization.js";
import { classifySessionSurface } from "./surface-classification.js";

const MAXIMUM_ACTIVE_APPEND_PROOF_BYTES = 8 * 1024 * 1024;
const MAXIMUM_ROLLOUT_LINEAGE_BYTES = 1024 * 1024;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_VALUE = new RegExp(`^${UUID}$`, "iu");
const CANONICAL_ROLLOUT_NAME = new RegExp(
  `^rollout-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2})-(${UUID})(?:_(${UUID}))?\\.jsonl(\\.zst)?$`,
  "iu",
);
const DISCOVERY_RECEIPTS = new WeakMap();
const DISCOVERY_REASON_CODES = new Set([
  "codex_rollout_compression_unsupported",
  "codex_rollout_filename_identity_mismatch",
  "codex_rollout_generation_ambiguous",
  "codex_rollout_lineage_invalid",
]);

function sourceName(path) {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(slash + 1);
}

function normalizeCodexIdentity(value) {
  return typeof value === "string" && UUID_VALUE.test(value)
    ? value.toLowerCase()
    : value;
}

/**
 * Parse the two identities Codex encodes in canonical rollout basenames.
 * The first UUID is the stable thread. The optional UUID after `_` is the
 * immutable replacement rollout; an ordinary file uses the thread UUID as
 * its rollout UUID. Compressed siblings are recognized so they can terminate
 * once with an explicit bounded diagnostic instead of disappearing from
 * discovery or being handed to the JSONL reader.
 */
export function parseCodexRolloutFilename(path) {
  if (typeof path !== "string") return null;
  const match = CANONICAL_ROLLOUT_NAME.exec(sourceName(path));
  if (match === null) return null;
  const threadId = match[2].toLowerCase();
  return Object.freeze({
    threadId,
    rolloutId: (match[3] ?? threadId).toLowerCase(),
    replacement: match[3] !== undefined,
    compressed: match[4] !== undefined,
  });
}

/**
 * Internal, content-free discovery receipt. `quarantined` contains source
 * handles for the local index writer; callers that cross a public boundary
 * must project only the fixed codes and counts beside it.
 */
export function codexRolloutDiscoveryReceipt(infos) {
  return DISCOVERY_RECEIPTS.get(infos) ?? Object.freeze({
    schemaVersion: "codex-rollout-discovery-v2",
    status: "complete",
    discoveredSourceCount: Array.isArray(infos) ? infos.length : 0,
    discoveredSourceBytes: Array.isArray(infos)
      ? infos.reduce((sum, info) => sum + Number(info?.size ?? 0), 0)
      : 0,
    acceptedSourceCount: Array.isArray(infos) ? infos.length : 0,
    acceptedSourceBytes: Array.isArray(infos)
      ? infos.reduce((sum, info) => sum + Number(info?.size ?? 0), 0)
      : 0,
    skippedSourceCount: 0,
    skippedSourceBytes: 0,
    skippedThreadCount: 0,
    reasonCounts: Object.freeze({}),
    quarantined: Object.freeze([]),
    fingerprint: null,
    quarantineFingerprint: null,
  });
}

function discoveryLimitError(dimension, limit, observed, progress) {
  const error = new Error("Codex log discovery stopped at a resource limit");
  error.name = "CodexLogDiscoveryLimitError";
  error.code = `codex_log_discovery_${dimension}`;
  error.resourceLimit = Object.freeze({ dimension, limit, observed });
  error.discoveryProgress = Object.freeze({ ...progress });
  return error;
}

function createDiscoveryLimiter(limits) {
  if (limits === null || limits === undefined) return null;
  if (!limits || typeof limits !== "object" || Array.isArray(limits)
      || Object.keys(limits).length !== 2
      || !Object.hasOwn(limits, "maximumDirectoryEntries")
      || !Object.hasOwn(limits, "maximumRolloutFiles")
      || !Number.isSafeInteger(limits.maximumDirectoryEntries)
      || limits.maximumDirectoryEntries < 1
      || !Number.isSafeInteger(limits.maximumRolloutFiles)
      || limits.maximumRolloutFiles < 1) {
    throw new TypeError("Codex log discovery limits are invalid");
  }
  const progress = {
    directoryEntries: 0,
    rolloutFiles: 0,
  };
  return {
    observeDirectoryEntry() {
      progress.directoryEntries += 1;
      if (progress.directoryEntries > limits.maximumDirectoryEntries) {
        throw discoveryLimitError(
          "directory_entries",
          limits.maximumDirectoryEntries,
          progress.directoryEntries,
          progress,
        );
      }
    },
    observeRolloutFile() {
      progress.rolloutFiles += 1;
      if (progress.rolloutFiles > limits.maximumRolloutFiles) {
        throw discoveryLimitError(
          "rollout_files",
          limits.maximumRolloutFiles,
          progress.rolloutFiles,
          progress,
        );
      }
    },
  };
}

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

  async function hashActiveSourcePrefix(
    handle,
    prefixBytes,
    resourceGuard = null,
    signal = null,
  ) {
    if (!Number.isSafeInteger(prefixBytes) || prefixBytes < 0) sourceChanged();
    const digest = filesystem.createSha256();
    const buffer = new Uint8Array(256 * 1024);
    let offset = 0;
    while (offset < prefixBytes) {
      throwIfAborted(signal);
      resourceGuard?.checkRuntime();
      const length = Math.min(buffer.length, prefixBytes - offset);
      let result;
      try {
        result = await handle.read(buffer, 0, length, offset);
      } catch (error) {
        rethrowScannerControlError(error);
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
    signal = null,
  ) {
    if (currentSize === prefixBytes) return;
    if (!Number.isSafeInteger(currentSize) || currentSize < prefixBytes
        || currentSize - prefixBytes > MAXIMUM_ACTIVE_APPEND_PROOF_BYTES) sourceChanged();
    if (prefixBytes > 0) {
      const boundary = new Uint8Array(1);
      let result;
      try {
        result = await handle.read(boundary, 0, 1, prefixBytes - 1);
      } catch (error) {
        rethrowScannerControlError(error);
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
        signal,
      })) {
        throwIfAborted(signal);
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

  async function openActiveRolloutSnapshot(
    info,
    endMs,
    resourceGuard = null,
    signal = null,
  ) {
    let handle;
    try {
      handle = await filesystem.openReadOnlyNoFollow(info.path);
      const stats = await handle.stat();
      assertActiveSourceStats(stats, info);
      await statActiveSourcePath(info.path, stats);
      if (stats.size < info.size) sourceChanged();
      if (stats.size === info.size
          && (stats.mtimeMs !== info.mtimeMs || stats.ctimeMs !== info.ctimeMs)) sourceChanged();
      await assertAppendedRecordsAfterEnd(
        handle,
        info.size,
        stats.size,
        endMs,
        resourceGuard,
        signal,
      );
      const prefixSha256 = await hashActiveSourcePrefix(
        handle,
        info.size,
        resourceGuard,
        signal,
      );
      const afterSnapshot = await handle.stat();
      assertActiveSourceStats(afterSnapshot, stats);
      await statActiveSourcePath(info.path, afterSnapshot);
      if (afterSnapshot.size < info.size) sourceChanged();
      await assertAppendedRecordsAfterEnd(
        handle,
        info.size,
        afterSnapshot.size,
        endMs,
        resourceGuard,
        signal,
      );
      return { handle, prefixSha256 };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error instanceof CodexLogSourceChangedError) throw error;
      rethrowScannerControlError(error);
      sourceChanged();
    }
  }

  async function verifyActiveRolloutSnapshot(
    info,
    snapshot,
    endMs,
    resourceGuard = null,
    signal = null,
  ) {
    const { handle, prefixSha256 } = snapshot;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      throwIfAborted(signal);
      let before;
      try {
        before = await handle.stat();
      } catch {
        sourceChanged();
      }
      assertActiveSourceStats(before, info);
      if (before.size < info.size) sourceChanged();
      await assertAppendedRecordsAfterEnd(
        handle,
        info.size,
        before.size,
        endMs,
        resourceGuard,
        signal,
      );
      if (await hashActiveSourcePrefix(
        handle,
        info.size,
        resourceGuard,
        signal,
      ) !== prefixSha256) sourceChanged();
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

  async function assertCompleteRolloutTail(info, signal = null) {
    throwIfAborted(signal);
    if (Number(info?.size ?? 0) === 0) return;
    let handle;
    try {
      handle = await filesystem.openReadOnlyNoFollow(info.path);
      const stats = await handle.stat();
      assertActiveSourceStats(stats, info);
      if (stats.size < info.size) sourceChanged();
      const byte = new Uint8Array(1);
      const result = await handle.read(byte, 0, 1, info.size - 1);
      if (result.bytesRead !== 1) sourceChanged();
      if (byte[0] !== 0x0a) {
        const error = new Error(
          "Codex rollout has an unfinished final JSONL record",
        );
        error.name = "CodexRolloutCoverageError";
        error.code = "codex_rollout_tail_incomplete";
        throw error;
      }
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function collectJsonlFileInfos(
    root,
    resourceGuard = null,
    signal = null,
    discoveryLimiter = null,
  ) {
    const files = [];
    async function walk(directory) {
      throwIfAborted(signal);
      let entries;
      try {
        entries = await filesystem.openDirectory(directory);
      } catch (error) {
        // Both Codex roots are optional on a fresh install. Absence is an empty
        // source set; every other filesystem failure means coverage is unknown
        // and must stop the pass rather than masquerading as an empty corpus.
        if (error?.code === "ENOENT") return;
        throw error;
      }
      for await (const entry of entries) {
        throwIfAborted(signal);
        discoveryLimiter?.observeDirectoryEntry();
        resourceGuard?.observeDirectoryEntry();
        const path = filesystem.joinPath(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
        } else if (entry.isFile()
            && (entry.name.endsWith(".jsonl")
              || entry.name.endsWith(".jsonl.zst"))) {
          throwIfAborted(signal);
          discoveryLimiter?.observeRolloutFile();
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
    maximumTotalBytes = MAXIMUM_ROLLOUT_LINEAGE_BYTES,
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
        const rawSessionId = typeof record.payload.id === "string"
          ? record.payload.id
          : (typeof record.payload.session_id === "string" ? record.payload.session_id : null);
        const rawParentId = typeof record.payload.forked_from_id === "string"
          ? record.payload.forked_from_id
          : (typeof record.payload.parent_thread_id === "string" ? record.payload.parent_thread_id : null);
        const sessionId = normalizeCodexIdentity(rawSessionId);
        const parentId = normalizeCodexIdentity(rawParentId);
        const surfaceClassification = classifySessionSurface(record.payload);
        const historyMode = record.payload.history_mode === "paginated"
          ? "paginated"
          : "legacy";
        const rawBase = record.payload.history_base;
        const historyBase = rawBase && typeof rawBase === "object"
          && !Array.isArray(rawBase)
          ? {
            rolloutId: typeof rawBase.thread_id === "string"
              ? normalizeCodexIdentity(rawBase.thread_id)
              : null,
            endOrdinalExclusive: rawBase.end_ordinal_exclusive,
            endByteOffset: rawBase.end_byte_offset,
          }
          : null;
        return {
          sessionId,
          parentId,
          isFork: parentId !== null,
          isInlineFork: parentId !== null && historyMode !== "paginated",
          historyMode,
          historyBase,
          startOrdinal: Number.isSafeInteger(record.ordinal)
              && record.ordinal >= 0
            ? record.ordinal
            : 0,
          surfaceClassification,
        };
      } catch {
        // A malformed metadata line is handled by the main parser diagnostics.
      }
    }
    return {
      sessionId: null,
      parentId: null,
      isFork: false,
      isInlineFork: false,
      historyMode: "legacy",
      historyBase: null,
      startOrdinal: 0,
      surfaceClassification: classifySessionSurface(null),
    };
  }

  async function hasForkReplayPrefix(path) {
    return (await readRolloutLineage(path)).isInlineFork;
  }

  function rolloutKey(path) {
    return sourceName(path);
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
    discoveryLimits = null,
    selectedRolloutNames = undefined,
  }) {
    if (!validAbortSignal(signal)) throw new TypeError("signal must be an AbortSignal or null");
    throwIfAborted(signal);
    if (selectedRolloutNames === undefined) {
      selectedRolloutNames = await filesystem.readSelectedRolloutNames(codexHome);
    }
    if (selectedRolloutNames !== null && !(selectedRolloutNames instanceof Map)) {
      throw new TypeError("selectedRolloutNames must be a Map or null");
    }
    throwIfAborted(signal);
    const discoveryLimiter = createDiscoveryLimiter(discoveryLimits);
    const cutoffMs = new Date(startAt).getTime();
    const endMs = endAt === null ? Number.POSITIVE_INFINITY : new Date(endAt).getTime();
    const [active, archived] = await Promise.all([
      collectJsonlFileInfos(
        filesystem.joinPath(codexHome, "sessions"),
        resourceGuard,
        signal,
        discoveryLimiter,
      ),
      collectJsonlFileInfos(
        filesystem.joinPath(codexHome, "archived_sessions"),
        resourceGuard,
        signal,
        discoveryLimiter,
      ),
    ]);
    throwIfAborted(signal);
    // Preserve every representation until its identity and content have been
    // compared. Selecting the active path by basename here used to hide a
    // divergent archived sibling before the integrity checks could see it.
    const representations = [
      ...archived.map((info) => [rolloutKey(info.path), { ...info, location: "archive" }]),
      ...active.map((info) => [rolloutKey(info.path), { ...info, location: "active" }]),
    ];
    const all = await mapWithConcurrency(representations, 16, async ([key, info]) => {
      throwIfAborted(signal);
      const filename = parseCodexRolloutFilename(info.path);
      const lineage = filename?.compressed === true
        ? {
          sessionId: filename.threadId,
          parentId: null,
          isFork: false,
          isInlineFork: false,
          historyMode: "legacy",
          historyBase: null,
          startOrdinal: 0,
          surfaceClassification: classifySessionSurface(null),
        }
        : await readRolloutLineage(info.path, {
          resourceGuard,
          // Session metadata is the first Codex rollout record. Bound damaged
          // files that never provide it to a generous metadata-only ceiling,
          // so discovery can quarantine the source without streaming an
          // arbitrarily large file first.
          // The total metadata search bound and the caller's per-line bound
          // are independent controls. Capping the whole search at
          // `maximumLineBytes` turns an intentional line-limit failure into a
          // misleading missing-lineage quarantine before the reader can emit
          // its fixed `line_bytes` error.
          maximumTotalBytes: MAXIMUM_ROLLOUT_LINEAGE_BYTES,
          signal,
        });
      return {
        ...info,
        rolloutKey: key,
        canonicalFilename: filename !== null,
        compressed: filename?.compressed === true,
        threadId: filename?.threadId ?? lineage.sessionId ?? null,
        rolloutId: filename?.rolloutId ?? null,
        sourceIdentity: filename?.rolloutId ?? key,
        replacement: filename?.replacement === true,
        selectedHead: filename !== null
          && selectedRolloutNames?.get(filename.threadId)
            === sourceName(info.path),
        lineage,
      };
    });
    throwIfAborted(signal);

    // Validate the physical and logical graphs before selecting a time
    // window. Invalid old groups are remembered locally but do not poison an
    // unrelated recent request: only selected groups enter the receipt below.
    const invalidGroupReason = new Map();
    const groupKeyFor = (info) => info.threadId
      ?? info.lineage?.sessionId
      ?? `source:${info.rolloutKey}`;
    const groups = new Map();
    for (const info of all) {
      const groupKey = groupKeyFor(info);
      const group = groups.get(groupKey) ?? [];
      group.push(info);
      groups.set(groupKey, group);
      if (info.compressed) {
        invalidGroupReason.set(
          groupKey,
          "codex_rollout_compression_unsupported",
        );
      } else if (info.canonicalFilename
          && info.lineage?.sessionId !== info.threadId) {
        invalidGroupReason.set(
          groupKey,
          "codex_rollout_filename_identity_mismatch",
        );
      } else if (typeof info.lineage?.sessionId !== "string"
          || info.lineage.sessionId.length === 0) {
        invalidGroupReason.set(
          groupKey,
          "codex_rollout_lineage_invalid",
        );
      }
    }
    // Canonical filename mismatches are grouped by the filename's thread id so
    // that identity conflict is quarantined deterministically. Keep a second,
    // read-only lookup by the metadata-claimed session id for dependency
    // propagation: an inline child that names that damaged parent must not
    // mistake it for an absent legacy parent and escape quarantine.
    const byClaimedSessionId = new Map();
    for (const info of all) {
      const claimed = info.lineage?.sessionId;
      if (typeof claimed !== "string" || claimed.length === 0) continue;
      const members = byClaimedSessionId.get(claimed) ?? [];
      members.push(info);
      byClaimedSessionId.set(claimed, members);
    }
    const logicalParentMemberCache = new Map();
    function logicalParentMembers(parentId) {
      if (typeof parentId !== "string" || parentId.length === 0) return [];
      if (logicalParentMemberCache.has(parentId)) {
        return logicalParentMemberCache.get(parentId);
      }
      const members = [...new Set([
        ...(groups.get(parentId) ?? []),
        ...(byClaimedSessionId.get(parentId) ?? []),
      ])];
      logicalParentMemberCache.set(parentId, members);
      return members;
    }

    const duplicateRepresentations = new Set();
    async function digestSource(info) {
      let handle;
      try {
        handle = await filesystem.openReadOnlyNoFollow(info.path);
        const stats = await handle.stat();
        assertActiveSourceStats(stats, info);
        if (stats.size !== info.size) sourceChanged();
        return await hashActiveSourcePrefix(
          handle,
          info.size,
          resourceGuard,
          signal,
        );
      } finally {
        await handle?.close().catch(() => {});
      }
    }

    // Collapse only byte-identical representations of the same physical
    // source. A legacy/noncanonical file still works when it is the sole
    // source for a thread, but two distinct noncanonical sources have no
    // immutable rollout identity with which to prove ordering or uniqueness.
    for (const [groupKey, group] of groups) {
      const bySourceIdentity = new Map();
      for (const info of group) {
        const sameSource = bySourceIdentity.get(info.sourceIdentity) ?? [];
        sameSource.push(info);
        bySourceIdentity.set(info.sourceIdentity, sameSource);
      }
      for (const sameSource of bySourceIdentity.values()) {
        if (sameSource.length < 2) continue;
        let digests;
        try {
          // Keep file-descriptor and hash-buffer pressure constant even if a
          // damaged directory contains thousands of copies of one rollout.
          digests = [];
          for (const representation of sameSource) {
            digests.push(await digestSource(representation));
          }
        } catch (error) {
          rethrowScannerControlError(error);
          invalidGroupReason.set(
            groupKey,
            "codex_rollout_generation_ambiguous",
          );
          break;
        }
        if (new Set(digests).size !== 1) {
          invalidGroupReason.set(
            groupKey,
            "codex_rollout_generation_ambiguous",
          );
          break;
        }
        const ordered = sameSource.toSorted((left, right) => (
          (left.location === "active" ? 0 : 1)
            - (right.location === "active" ? 0 : 1)
          || left.rolloutKey.localeCompare(right.rolloutKey)
          || left.path.localeCompare(right.path)
        ));
        for (const duplicate of ordered.slice(1)) {
          duplicateRepresentations.add(duplicate);
        }
      }
      const distinctSources = group.filter((info) => (
        !duplicateRepresentations.has(info)
      ));
      if (distinctSources.length > 1
          && distinctSources.some((info) => !info.canonicalFilename)) {
        invalidGroupReason.set(
          groupKey,
          "codex_rollout_generation_ambiguous",
        );
      }
    }
    const physical = all.filter((info) => !duplicateRepresentations.has(info));

    // Immutable rollout identities are global, not merely unique within one
    // logical thread. Accepting the same identity under two threads would
    // make both sources derive the same source-local key and collide in every
    // cursor and fact table. Quarantine every owner instead of allowing the
    // last Map insertion to select one silently.
    const bySourceIdentity = new Map();
    for (const info of physical) {
      const owners = bySourceIdentity.get(info.sourceIdentity) ?? [];
      owners.push(info);
      bySourceIdentity.set(info.sourceIdentity, owners);
    }
    for (const owners of bySourceIdentity.values()) {
      if (new Set(owners.map(groupKeyFor)).size < 2) continue;
      for (const owner of owners) {
        if (!invalidGroupReason.has(groupKeyFor(owner))) {
          invalidGroupReason.set(
            groupKeyFor(owner),
            "codex_rollout_generation_ambiguous",
          );
        }
      }
    }
    const byRolloutId = new Map();
    for (const owners of bySourceIdentity.values()) {
      if (owners.length === 1 && owners[0].rolloutId !== null) {
        byRolloutId.set(owners[0].rolloutId, owners[0]);
      }
    }

    // Resolve one logical head without turning it into an accounting filter.
    // A valid SQLite hint wins when it names the unique metadata leaf. A stale
    // or unavailable hint falls back to that leaf; multiple unexplained leaves
    // remain unresolved and are quarantined only if another source needs the
    // thread as an inline-history parent.
    for (const group of groups.values()) {
      const members = group.filter((info) => !duplicateRepresentations.has(info));
      const referencedInGroup = new Set(members.map((info) => (
        info.lineage?.historyBase?.rolloutId ?? null
      )).filter(Boolean));
      const leaves = members.filter((info) => (
        info.rolloutId !== null && !referencedInGroup.has(info.rolloutId)
      ));
      const selected = members.filter((info) => info.selectedHead === true);
      const selectedLeaf = selected.length === 1 && leaves.includes(selected[0])
        ? selected[0]
        : null;
      const resolved = selectedLeaf ?? (leaves.length === 1 ? leaves[0] : null);
      for (const info of members) info.resolvedHead = info === resolved;
    }
    for (const info of physical) {
      if (info.lineage?.isInlineFork !== true) continue;
      const parents = logicalParentMembers(info.lineage.parentId);
      if (parents.length > 1
          && !parents.some((parent) => parent.resolvedHead === true)) {
        invalidGroupReason.set(
          groupKeyFor(info),
          "codex_rollout_lineage_invalid",
        );
      }
    }

    // Cutoff verification reads the referenced prefix. Restrict that I/O to
    // sources in the requested window and their physical/logical ancestors;
    // an unrelated old paginated thread must not make a recent scan reread a
    // potentially huge history range merely to learn that the old group is
    // outside this receipt.
    const validationCandidates = new Set();
    function includeValidationDependencies(info) {
      const pending = [info];
      while (pending.length > 0) {
        const current = pending.pop();
        if (validationCandidates.has(current)) continue;
        validationCandidates.add(current);
        const baseId = current.lineage?.historyBase?.rolloutId ?? null;
        const base = baseId === null ? null : byRolloutId.get(baseId);
        if (base !== null && base !== undefined) pending.push(base);
        const parentId = current.lineage?.parentId ?? null;
        for (const parent of logicalParentMembers(parentId)) {
          if (!duplicateRepresentations.has(parent)) pending.push(parent);
        }
      }
    }
    for (const info of physical) {
      const sourceStartMs = rolloutStartMs(info.rolloutKey);
      if (info.mtimeMs >= cutoffMs
          && (!Number.isFinite(sourceStartMs) || sourceStartMs <= endMs)) {
        includeValidationDependencies(info);
      }
    }

    function invalidBaseShape(base) {
      return base === null
        || typeof base.rolloutId !== "string"
        || !Number.isSafeInteger(base.endOrdinalExclusive)
        || base.endOrdinalExclusive < 0
        || !Number.isSafeInteger(base.endByteOffset)
        || base.endByteOffset < 0;
    }
    const cutoffValidity = new Map();
    async function historyCutoffValid(parent, base) {
      const key = `${parent.rolloutKey}\0${base.endByteOffset}\0${base.endOrdinalExclusive}`;
      if (cutoffValidity.has(key)) return cutoffValidity.get(key);
      let handle;
      let valid = false;
      try {
        handle = await filesystem.openReadOnlyNoFollow(parent.path);
        const stats = await handle.stat();
        assertActiveSourceStats(stats, parent);
        if (stats.size !== parent.size || base.endByteOffset > stats.size) {
          return false;
        }
        const buffer = Buffer.allocUnsafe(256 * 1024);
        let offset = 0;
        let lines = 0;
        let lastByte = null;
        while (offset < base.endByteOffset) {
          throwIfAborted(signal);
          resourceGuard?.checkRuntime();
          const length = Math.min(buffer.length, base.endByteOffset - offset);
          const read = await handle.read(buffer, 0, length, offset);
          if (read.bytesRead !== length) return false;
          let from = 0;
          for (;;) {
            const newline = buffer.indexOf(0x0a, from);
            if (newline < 0 || newline >= read.bytesRead) break;
            lines += 1;
            from = newline + 1;
          }
          lastByte = buffer[read.bytesRead - 1];
          offset += read.bytesRead;
        }
        const startOrdinal = Number(parent.lineage?.startOrdinal ?? 0);
        valid = Number.isSafeInteger(startOrdinal)
          && base.endOrdinalExclusive > startOrdinal
          && lines === base.endOrdinalExclusive - startOrdinal
          && (base.endByteOffset === 0 || lastByte === 0x0a);
      } catch (error) {
        rethrowScannerControlError(error);
        valid = false;
      } finally {
        await handle?.close().catch(() => {});
        cutoffValidity.set(key, valid);
      }
      return valid;
    }
    for (const info of physical) {
      if (!validationCandidates.has(info)) continue;
      const groupKey = groupKeyFor(info);
      if (invalidGroupReason.has(groupKey)) continue;
      const base = info.lineage?.historyBase ?? null;
      if (info.replacement
          && (info.lineage?.historyMode !== "paginated"
            || invalidBaseShape(base))) {
        invalidGroupReason.set(groupKey, "codex_rollout_lineage_invalid");
        continue;
      }
      if (base === null) continue;
      if (invalidBaseShape(base)) {
        invalidGroupReason.set(groupKey, "codex_rollout_lineage_invalid");
        continue;
      }
      const parent = byRolloutId.get(base.rolloutId);
      if (parent === undefined
          || base.endByteOffset > Number(parent.size ?? 0)
          || !await historyCutoffValid(parent, base)) {
        invalidGroupReason.set(groupKey, "codex_rollout_lineage_invalid");
      }
    }

    // Physical-history cycles can cross logical thread groups (a paginated
    // fork may reference another thread's rollout), so mark every group on a
    // detected cycle rather than guessing a break point.
    const visited = new Set();
    for (const start of physical) {
      if (visited.has(start)) continue;
      const chain = [];
      const position = new Map();
      let current = start;
      while (current !== null && current !== undefined
          && !visited.has(current) && !position.has(current)) {
        position.set(current, chain.length);
        chain.push(current);
        const baseId = current.lineage?.historyBase?.rolloutId ?? null;
        current = baseId === null ? null : byRolloutId.get(baseId);
      }
      if (current !== null && current !== undefined && position.has(current)) {
        for (const member of chain.slice(position.get(current))) {
          invalidGroupReason.set(
            groupKeyFor(member),
            "codex_rollout_lineage_invalid",
          );
        }
      }
      for (const member of chain) visited.add(member);
    }

    // Logical parent metadata can form a cycle even when no paginated
    // history-base edge does. Peel the acyclic groups iteratively; every group
    // left over is on, or depends on, a parent cycle and therefore has no
    // defensible parent-first accounting order.
    const logicalDependencies = new Map(
      [...groups.keys()].map((groupKey) => [groupKey, new Set()]),
    );
    const logicalDependents = new Map(
      [...groups.keys()].map((groupKey) => [groupKey, new Set()]),
    );
    for (const info of physical) {
      const groupKey = groupKeyFor(info);
      const parentKey = info.lineage?.parentId ?? null;
      for (const parent of logicalParentMembers(parentKey)) {
        const parentGroupKey = groupKeyFor(parent);
        if (parentGroupKey === groupKey) continue;
        logicalDependencies.get(groupKey).add(parentGroupKey);
        logicalDependents.get(parentGroupKey).add(groupKey);
      }
    }
    const pendingLogicalDependencies = new Map(
      [...logicalDependencies].map(([groupKey, dependencies]) => (
        [groupKey, dependencies.size]
      )),
    );
    const logicalQueue = [...pendingLogicalDependencies]
      .filter(([, count]) => count === 0)
      .map(([groupKey]) => groupKey);
    for (let index = 0; index < logicalQueue.length; index += 1) {
      const resolved = logicalQueue[index];
      for (const dependent of logicalDependents.get(resolved)) {
        const remaining = pendingLogicalDependencies.get(dependent) - 1;
        pendingLogicalDependencies.set(dependent, remaining);
        if (remaining === 0) logicalQueue.push(dependent);
      }
    }
    for (const [groupKey, remaining] of pendingLogicalDependencies) {
      if (remaining > 0 && !invalidGroupReason.has(groupKey)) {
        invalidGroupReason.set(groupKey, "codex_rollout_lineage_invalid");
      }
    }

    // A source whose required history dependency is already quarantined is
    // not independently account-safe. Propagate the fixed lineage failure to
    // the dependent logical group before time-window selection so the index
    // never receives an accepted child with an unavailable physical base.
    // Do the same for an inline fork whose present parent group is invalid:
    // its replay cannot be suppressed reliably once the parent's facts are
    // withheld. Missing legacy parents remain supported by the extractor's
    // bounded leading-replay heuristic; only a parent that is present and
    // known-invalid triggers propagation here.
    const lineageDependents = new Map(
      [...groups.keys()].map((groupKey) => [groupKey, new Set()]),
    );
    function addLineageDependent(dependencyKey, dependentKey) {
      if (dependencyKey === dependentKey) return;
      const dependents = lineageDependents.get(dependencyKey);
      if (dependents !== undefined) dependents.add(dependentKey);
    }
    for (const info of physical) {
      const groupKey = groupKeyFor(info);
      const baseId = info.lineage?.historyBase?.rolloutId ?? null;
      const base = baseId === null ? null : byRolloutId.get(baseId);
      if (base !== null && base !== undefined) {
        addLineageDependent(groupKeyFor(base), groupKey);
      }
      if (info.lineage?.isInlineFork === true) {
        const parentId = info.lineage?.parentId ?? null;
        for (const parent of logicalParentMembers(parentId)) {
          addLineageDependent(groupKeyFor(parent), groupKey);
        }
      }
    }
    const invalidLineageQueue = [...invalidGroupReason.keys()];
    for (let index = 0; index < invalidLineageQueue.length; index += 1) {
      const invalidGroup = invalidLineageQueue[index];
      for (const dependent of lineageDependents.get(invalidGroup) ?? []) {
        if (invalidGroupReason.has(dependent)) continue;
        invalidGroupReason.set(dependent, "codex_rollout_lineage_invalid");
        invalidLineageQueue.push(dependent);
      }
    }

    const initiallySelected = physical.filter((info) => {
      const sourceStartMs = rolloutStartMs(info.rolloutKey);
      return info.mtimeMs >= cutoffMs && (!Number.isFinite(sourceStartMs) || sourceStartMs <= endMs);
    });
    const selected = new Set();
    function includeDependencies(info) {
      const pending = [info];
      const seen = new Set();
      while (pending.length > 0) {
        const current = pending.pop();
        if (selected.has(current) || seen.has(current)) continue;
        seen.add(current);
        selected.add(current);
        const group = groups.get(groupKeyFor(current)) ?? [];
        if (invalidGroupReason.has(groupKeyFor(current))) {
          for (const member of group) {
            if (!duplicateRepresentations.has(member)) selected.add(member);
          }
          continue;
        }
        const baseId = current.lineage?.historyBase?.rolloutId ?? null;
        const base = baseId === null ? null : byRolloutId.get(baseId);
        if (base !== null && base !== undefined) pending.push(base);
        const parentId = current.lineage?.parentId ?? null;
        for (const parent of logicalParentMembers(parentId)) {
          if (!duplicateRepresentations.has(parent)) pending.push(parent);
        }
      }
    }
    for (const info of initiallySelected) includeDependencies(info);

    const quarantined = [...selected].filter((info) => (
      invalidGroupReason.has(groupKeyFor(info))
    ));
    const accepted = [...selected].filter((info) => (
      !invalidGroupReason.has(groupKeyFor(info))
    ));

    const dependencyMemo = new Map();
    function lineageDependencies(info) {
      if (dependencyMemo.has(info)) return dependencyMemo.get(info);
      const dependencies = [];
      const baseId = info.lineage?.historyBase?.rolloutId ?? null;
      const base = baseId === null ? null : byRolloutId.get(baseId);
      if (base !== null && base !== undefined && selected.has(base)) {
        dependencies.push(base);
      }
      const parentId = info.lineage?.parentId ?? null;
      for (const parent of logicalParentMembers(parentId)) {
        if (selected.has(parent)) dependencies.push(parent);
      }
      dependencyMemo.set(info, dependencies);
      return dependencies;
    }

    // Explicit post-order traversal keeps discovery bounded by the configured
    // source limits rather than the JavaScript call stack. Cycles are already
    // quarantined above; the active-set guard is a final deterministic shield
    // for malformed logical parent graphs that do not carry physical history.
    const depthMemo = new Map();
    function lineageDepth(start) {
      if (depthMemo.has(start)) return depthMemo.get(start);
      const active = new Set();
      const stack = [{ info: start, expanded: false }];
      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (depthMemo.has(frame.info)) {
          active.delete(frame.info);
          stack.pop();
          continue;
        }
        if (!frame.expanded) {
          frame.expanded = true;
          active.add(frame.info);
          for (const dependency of lineageDependencies(frame.info)) {
            if (!depthMemo.has(dependency) && !active.has(dependency)) {
              stack.push({ info: dependency, expanded: false });
            }
          }
          continue;
        }
        let maximumDependencyDepth = -1;
        for (const dependency of lineageDependencies(frame.info)) {
          maximumDependencyDepth = Math.max(
            maximumDependencyDepth,
            depthMemo.get(dependency) ?? 0,
          );
        }
        depthMemo.set(frame.info, maximumDependencyDepth + 1);
        active.delete(frame.info);
        stack.pop();
      }
      return depthMemo.get(start) ?? 0;
    }

    const result = accepted.sort((left, right) => {
      const depthDifference = lineageDepth(left) - lineageDepth(right);
      return depthDifference
        || Number(left.resolvedHead) - Number(right.resolvedHead)
        || left.rolloutKey.localeCompare(right.rolloutKey);
    });
    const quarantinedByGroup = new Map();
    for (const info of quarantined) {
      const groupKey = groupKeyFor(info);
      const members = quarantinedByGroup.get(groupKey) ?? [];
      members.push(info);
      quarantinedByGroup.set(groupKey, members);
    }
    const reasonCounts = {};
    const diagnosticGroups = [];
    for (const [groupKey, members] of quarantinedByGroup) {
      const reason = invalidGroupReason.get(groupKey);
      if (!DISCOVERY_REASON_CODES.has(reason)) continue;
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
      diagnosticGroups.push(Object.freeze({
        groupLocal: hashString(groupKey),
        reason,
        sourceCount: members.length,
        sourceBytes: members.reduce(
          (sum, info) => sum + Number(info.size ?? 0),
          0,
        ),
      }));
    }
    const acceptedBytes = result.reduce(
      (sum, info) => sum + Number(info.size ?? 0),
      0,
    );
    const skippedBytes = quarantined.reduce(
      (sum, info) => sum + Number(info.size ?? 0),
      0,
    );
    const receiptMaterial = [...result, ...quarantined]
      .toSorted((left, right) => left.rolloutKey.localeCompare(right.rolloutKey))
      .map((info) => [
        hashString(info.rolloutKey),
        Number(info.size ?? 0),
        Math.floor(Number(info.mtimeMs ?? 0)),
        invalidGroupReason.get(groupKeyFor(info)) ?? "accepted",
      ]);
    const quarantineMaterial = quarantined
      .toSorted((left, right) => left.rolloutKey.localeCompare(right.rolloutKey))
      .map((info) => [
        hashString(info.rolloutKey),
        Number(info.size ?? 0),
        Math.floor(Number(info.mtimeMs ?? 0)),
        invalidGroupReason.get(groupKeyFor(info)),
      ]);
    const quarantinedSources = quarantined.map((info) => Object.freeze({
      ...info,
      quarantineReason: invalidGroupReason.get(groupKeyFor(info)),
    }));
    const receipt = Object.freeze({
      schemaVersion: "codex-rollout-discovery-v2",
      status: quarantined.length === 0 ? "complete" : "partial",
      discoveredSourceCount: result.length + quarantined.length,
      discoveredSourceBytes: acceptedBytes + skippedBytes,
      acceptedSourceCount: result.length,
      acceptedSourceBytes: acceptedBytes,
      skippedSourceCount: quarantined.length,
      skippedSourceBytes: skippedBytes,
      skippedThreadCount: quarantinedByGroup.size,
      duplicateRepresentationCount: duplicateRepresentations.size,
      reasonCounts: Object.freeze(reasonCounts),
      diagnosticGroups: Object.freeze(diagnosticGroups),
      quarantined: Object.freeze(quarantinedSources),
      fingerprint: hashString(JSON.stringify(receiptMaterial)),
      quarantineFingerprint: hashString(JSON.stringify(quarantineMaterial)),
    });
    DISCOVERY_RECEIPTS.set(result, receipt);
    return result;
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
    codexRolloutDiscoveryReceipt,
    discoverCodexRollouts,
    summarizeCodexRolloutSources,
    codexLogSourceFingerprint,
    appendedRolloutSourcesAreAfterEnd,
    openActiveRolloutSnapshot,
    verifyActiveRolloutSnapshot,
    assertCompleteRolloutTail,
  };
}
