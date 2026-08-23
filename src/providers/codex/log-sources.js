import {
  CODEX_LOG_RELEVANT_LINE_NEEDLES,
  throwIfAborted,
  validAbortSignal,
} from "./log-normalization.js";
import { classifySessionSurface } from "./surface-classification.js";

const MAXIMUM_ACTIVE_APPEND_PROOF_BYTES = 8 * 1024 * 1024;

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

function isDiscoveryLimitError(error) {
  return error?.name === "CodexLogDiscoveryLimitError"
    || (typeof error?.code === "string"
      && error.code.startsWith("codex_log_discovery_"));
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

function rethrowDiscoveryControlError(error) {
  rethrowScannerControlError(error);
  if (error?.name === "CodexLogDiscoveryLimitError"
      || (typeof error?.code === "string"
        && error.code.startsWith("codex_log_discovery_"))) throw error;
}

export function createCodexLogSources({ filesystem, lineReader }) {
  function ambiguousRolloutIdentity() {
    const error = new Error("Ambiguous duplicate Codex rollout identity across roots");
    error.code = "codex_rollout_identity_ambiguous";
    return error;
  }

  function opaqueRootOwnerKey(value) {
    return filesystem.createSha256()
      .update("app-usagemonitor/codex-root-owner/v1\0")
      .update(value)
      .digest("hex");
  }

  function normalizeCodexHomes(codexHome, codexHomes) {
    if (codexHome !== null && codexHome !== undefined
        && codexHomes !== null && codexHomes !== undefined) {
      throw new TypeError("codexHome and codexHomes are mutually exclusive");
    }
    const values = codexHomes === null || codexHomes === undefined
      ? [codexHome ?? filesystem.defaultCodexHome()]
      : codexHomes;
    if (!Array.isArray(values) || values.length < 1 || values.length > 8) {
      throw new TypeError("codexHomes must contain between 1 and 8 roots");
    }
    const roots = values.map((value) => {
      const descriptor = typeof value === "string"
        ? { path: value, id: value }
        : value;
      if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)
          || typeof descriptor.path !== "string" || descriptor.path.length < 1) {
        throw new TypeError("each Codex home must be a path or root descriptor");
      }
      const identity = descriptor.id ?? descriptor.rootId ?? descriptor.path;
      if (typeof identity !== "string" || identity.length < 1) {
        throw new TypeError("Codex root descriptor identity must be a non-empty string");
      }
      return Object.freeze({
        path: descriptor.path,
        rootOwnerKey: opaqueRootOwnerKey(identity),
      });
    });
    const byOwner = new Map();
    const byPath = new Map();
    for (const root of roots) {
      const owner = byOwner.get(root.rootOwnerKey);
      if (owner !== undefined) {
        throw new TypeError("Codex root descriptor identities must be unique");
      }
      const pathOwner = byPath.get(root.path);
      if (pathOwner !== undefined) {
        throw new TypeError("Codex home paths must be unique");
      }
      byOwner.set(root.rootOwnerKey, root);
      byPath.set(root.path, root.rootOwnerKey);
    }
    return [...byOwner.values()].sort((left, right) => (
      left.rootOwnerKey.localeCompare(right.rootOwnerKey)
    ));
  }

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

  async function collectJsonlFileInfos(
    root,
    resourceGuard = null,
    signal = null,
    discoveryLimiter = null,
  ) {
    const files = [];
    let rootOpened = false;
    let unsafeFailure = false;
    let discoveryFailureCode = null;
    async function walk(directory, depth = 0) {
      throwIfAborted(signal);
      let entries;
      try {
        entries = await filesystem.openDirectory(directory);
      } catch (error) {
        rethrowDiscoveryControlError(error);
        // A Codex home need not have both top-level source directories. A
        // missing top-level directory is therefore not degraded coverage, but
        // an unreadable top-level directory or any mid-tree failure is: using
        // the files seen before that failure would be a truncated snapshot.
        if (depth > 0 || error?.code !== "ENOENT") unsafeFailure = true;
        return;
      }
      if (depth === 0) rootOpened = true;
      try {
        for await (const entry of entries) {
          throwIfAborted(signal);
          discoveryLimiter?.observeDirectoryEntry();
          resourceGuard?.observeDirectoryEntry();
          const path = filesystem.joinPath(directory, entry.name);
          if (entry.isDirectory()) {
            await walk(path, depth + 1);
          } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            throwIfAborted(signal);
            discoveryLimiter?.observeRolloutFile();
            let metadata;
            try {
              metadata = await filesystem.statPath(path);
            } catch (error) {
              rethrowDiscoveryControlError(error);
              unsafeFailure = true;
              continue;
            }
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
      } catch (error) {
        if (isDiscoveryLimitError(error)) {
          // The limit is root-local. Discard this root's entire inventory and
          // let other fully scanned roots advance; incremental ingestion will
          // retain this owner's accepted last-known-good facts.
          unsafeFailure = true;
          discoveryFailureCode = error.code;
        } else {
          rethrowDiscoveryControlError(error);
          unsafeFailure = true;
        }
      }
    }
    await walk(root);
    return { files, rootOpened, unsafeFailure, discoveryFailureCode };
  }

  async function hashRolloutPrefix(info, prefixBytes, resourceGuard, signal) {
    if (!Number.isSafeInteger(prefixBytes) || prefixBytes < 0) {
      throw ambiguousRolloutIdentity();
    }
    let handle;
    try {
      handle = await filesystem.openReadOnlyNoFollow(info.path);
      const before = await handle.stat();
      assertActiveSourceStats(before, info);
      if (!sameSourceState(before, info)) sourceChanged();
      const digest = await hashActiveSourcePrefix(
        handle,
        prefixBytes,
        resourceGuard,
        signal,
      );
      const after = await handle.stat();
      assertActiveSourceStats(after, before);
      const pathStats = await statActiveSourcePath(info.path, after);
      if (!sameSourceState(before, after) || !sameSourceState(after, pathStats)) {
        sourceChanged();
      }
      return digest;
    } catch (error) {
      rethrowDiscoveryControlError(error);
      throw ambiguousRolloutIdentity();
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function assertReplicaPrefixCompatibility(group, resourceGuard, signal) {
    if (group.length < 2) return;
    const longest = group[0];
    const longestPrefixBySize = new Map();
    for (const candidate of group.slice(1)) {
      const prefixBytes = Number(candidate.size);
      let longestPrefix = longestPrefixBySize.get(prefixBytes);
      if (longestPrefix === undefined) {
        longestPrefix = await hashRolloutPrefix(
          longest,
          prefixBytes,
          resourceGuard,
          signal,
        );
        longestPrefixBySize.set(prefixBytes, longestPrefix);
      }
      const candidateDigest = await hashRolloutPrefix(
        candidate,
        prefixBytes,
        resourceGuard,
        signal,
      );
      if (candidateDigest !== longestPrefix) {
        throw ambiguousRolloutIdentity();
      }
    }
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
    codexHome = null,
    codexHomes = null,
    startAt,
    endAt = null,
    resourceGuard = null,
    signal = null,
    discoveryLimits = null,
  }) {
    if (!validAbortSignal(signal)) throw new TypeError("signal must be an AbortSignal or null");
    throwIfAborted(signal);
    const roots = normalizeCodexHomes(codexHome, codexHomes);
    const cutoffMs = new Date(startAt).getTime();
    const endMs = endAt === null ? Number.POSITIVE_INFINITY : new Date(endAt).getTime();
    const rootResults = await Promise.all(roots.map(async (root) => {
      // Active and archived trees share one ceiling within a root, while
      // independent roots cannot consume or abort each other's allowance.
      const discoveryLimiter = createDiscoveryLimiter(discoveryLimits);
      const [active, archived] = await Promise.all([
        collectJsonlFileInfos(
          filesystem.joinPath(root.path, "sessions"),
          resourceGuard,
          signal,
          discoveryLimiter,
        ),
        collectJsonlFileInfos(
          filesystem.joinPath(root.path, "archived_sessions"),
          resourceGuard,
          signal,
          discoveryLimiter,
        ),
      ]);
      let unsafeFailure = active.unsafeFailure || archived.unsafeFailure;
      let emptyHomePresent = false;
      if (!active.rootOpened && !archived.rootOpened && !unsafeFailure) {
        try {
          const homeStats = await filesystem.statPath(root.path);
          emptyHomePresent = homeStats?.isDirectory?.() === true;
          if (!emptyHomePresent) unsafeFailure = true;
        } catch (error) {
          rethrowDiscoveryControlError(error);
          if (error?.code !== "ENOENT") unsafeFailure = true;
        }
      }
      const discoveryFailureCode = active.discoveryFailureCode
        ?? archived.discoveryFailureCode;
      if (unsafeFailure) {
        // Do not duplicate a partial inventory in a map that can never be
        // admitted. The arrays are released with this root result, while the
        // fixed failure code remains available to legacy single-root callers.
        return {
          candidates: [],
          available: active.rootOpened || archived.rootOpened || emptyHomePresent,
          empty: false,
          partial: active.rootOpened || archived.rootOpened || emptyHomePresent,
          rootOwnerKey: root.rootOwnerKey,
          discoveryFailureCode,
        };
      }
      const byName = new Map();
      for (const info of archived.files) {
        byName.set(rolloutKey(info.path), {
          ...info,
          location: "archive",
          rootOwnerKey: root.rootOwnerKey,
        });
      }
      for (const info of active.files) {
        byName.set(rolloutKey(info.path), {
          ...info,
          location: "active",
          rootOwnerKey: root.rootOwnerKey,
        });
      }
      return {
        // Never admit a subset from a root whose traversal became unsafe.
        // Incremental ingestion can retain the last-known-good generation.
        candidates: [...byName.entries()],
        available: active.rootOpened || archived.rootOpened || emptyHomePresent,
        empty: (active.rootOpened || archived.rootOpened || emptyHomePresent)
          && byName.size === 0,
        partial: false,
        rootOwnerKey: root.rootOwnerKey,
        discoveryFailureCode: null,
      };
    }));
    throwIfAborted(signal);
    const availableRoots = rootResults.filter((result) => result.available).length;
    const unavailableRoots = roots.length - availableRoots;
    const baseRootCoverage = {
      status: availableRoots === 0
        ? "unavailable"
        : unavailableRoots > 0 || rootResults.some((result) => result.partial)
          ? "partial"
          : "ready",
      configuredRoots: roots.length,
      availableRoots,
      emptyRoots: rootResults.filter((result) => result.empty).length,
      unavailableRoots,
      retainedHistory: false,
      unavailableOwnerSources: 0,
      ambiguousSources: 0,
    };
    const candidates = await mapWithConcurrency(
      rootResults.flatMap((result) => result.candidates),
      16,
      async ([key, info]) => {
        throwIfAborted(signal);
        return {
          ...info,
          rolloutKey: key,
          lineage: await readRolloutLineage(info.path, { resourceGuard, signal }),
        };
      },
    );
    throwIfAborted(signal);
    const candidatesByKey = new Map();
    for (const info of candidates) {
      const group = candidatesByKey.get(info.rolloutKey);
      if (group === undefined) candidatesByKey.set(info.rolloutKey, [info]);
      else group.push(info);
    }
    const all = [];
    let ambiguousSources = 0;
    const ambiguousRolloutKeys = [];
    for (const [key, unsorted] of candidatesByKey) {
      const group = unsorted.sort((left, right) => (
        right.size - left.size
        || (left.location === right.location ? 0 : left.location === "active" ? -1 : 1)
        || left.rootOwnerKey.localeCompare(right.rootOwnerKey)
      ));
      const declared = new Set(group.map((info) => info.lineage.sessionId));
      if (group.length > 1 && (declared.size !== 1 || declared.has(null))) {
        ambiguousSources += 1;
        ambiguousRolloutKeys.push(key);
        continue;
      }
      try {
        await assertReplicaPrefixCompatibility(group, resourceGuard, signal);
      } catch (error) {
        if (error?.code !== "codex_rollout_identity_ambiguous") throw error;
        ambiguousSources += 1;
        ambiguousRolloutKeys.push(key);
        continue;
      }
      all.push({
        ...group[0],
        rolloutKey: key,
        physicalCandidates: Object.freeze(group),
      });
    }
    const rootCoverage = Object.freeze({
      ...baseRootCoverage,
      status: ambiguousSources > 0 && baseRootCoverage.status === "ready"
        ? "partial"
        : baseRootCoverage.status,
      ambiguousSources,
    });
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

    const result = [...selected].sort((left, right) => {
      const depthDifference = lineageDepth(left) - lineageDepth(right);
      return depthDifference || left.rolloutKey.localeCompare(right.rolloutKey);
    });
    Object.defineProperty(result, "rootCoverage", {
      value: rootCoverage,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    Object.defineProperty(result, "configuredRootOwnerKeys", {
      value: Object.freeze(roots.map((root) => root.rootOwnerKey)),
      enumerable: false,
      configurable: false,
      writable: false,
    });
    Object.defineProperty(result, "availableRootOwnerKeys", {
      value: Object.freeze(rootResults
        .filter((root) => root.available && !root.partial)
        .map((root) => root.rootOwnerKey)),
      enumerable: false,
      configurable: false,
      writable: false,
    });
    Object.defineProperty(result, "unavailableRootOwnerKeys", {
      value: Object.freeze(rootResults
        .filter((root) => !root.available || root.partial)
        .map((root) => root.rootOwnerKey)),
      enumerable: false,
      configurable: false,
      writable: false,
    });
    Object.defineProperty(result, "ambiguousRolloutKeys", {
      // Kept local and non-enumerable: the public receipt exposes only the
      // bounded count, while ingestion can retain the exact prior cursor.
      value: Object.freeze(ambiguousRolloutKeys),
      enumerable: false,
      configurable: false,
      writable: false,
    });
    Object.defineProperty(result, "discoveryFailureCodes", {
      // Fixed internal codes let legacy archive orchestration retain its
      // durable partial marker without exposing paths or partial inventories.
      value: Object.freeze(rootResults
        .map((root) => root.discoveryFailureCode)
        .filter((code) => typeof code === "string")),
      enumerable: false,
      configurable: false,
      writable: false,
    });
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

  async function codexLogSourceFingerprint({
    codexHome,
    codexHomes = null,
    startAt,
    endAt,
    includeSourcePaths = false,
  }) {
    const rolloutInfos = await discoverCodexRolloutInfos({
      codexHome,
      codexHomes,
      startAt,
    });
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
