import { lstat, mkdir, statfs } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  inspectLocalAnalysisIndex,
  markLocalAnalysisIndexCoveragePartial,
  refreshLocalAnalysisIndex,
} from "./local-analysis-index.js";
import { validAbortSignal } from "./valid-abort-signal.js";

// This archive index is deliberately separate from the foreground collector.
// The collector's SQLite state is optimized for a responsive recent-window
// dashboard; this SQLite index is the durable, privacy-scoped path for a much
// larger historical source set.
export const LOCAL_ARCHIVE_ACCOUNTING_INDEX_VERSION =
  "local-archive-accounting-index-v1";
export const ARCHIVE_INDEX_INITIAL_READ_BUDGET_BYTES =
  128 * 1024 * 1024;
export const ARCHIVE_INDEX_DEEP_READ_BUDGET_BYTES =
  Math.floor(1.5 * 1024 * 1024 * 1024);
export const ARCHIVE_INDEX_MAX_DIRECTORY_ENTRIES = 500_000;
export const ARCHIVE_INDEX_MAX_ROLLOUT_FILES = 125_000;
export const ARCHIVE_INDEX_PASS_TIMEOUT_MS = 5 * 60_000;
export const ARCHIVE_INDEX_COMMIT_CHUNK_BYTES = 4 * 1024 * 1024;
// A refresh stages a complete next SQLite generation before publication. The
// free-space check reserves room for that copy, this pass's read envelope,
// and a small filesystem safety margin before any stage file is created.
export const ARCHIVE_INDEX_STORAGE_RESERVE_BYTES = 128 * 1024 * 1024;

const ARCHIVE_START_AT = "1970-01-01T00:00:00.000Z";
const ARCHIVE_STATES = new Set(["complete", "partial"]);

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function safeArchiveByteSum(...values) {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0
        || total > Number.MAX_SAFE_INTEGER - value) return null;
    total += value;
  }
  return total;
}

async function ensureArchiveIndexDiskHeadroom({
  indexFile,
  budgetBytes,
  filesystemStats = statfs,
  indexStat = lstat,
  ensureDirectory = mkdir,
} = {}) {
  if (typeof filesystemStats !== "function"
      || typeof indexStat !== "function"
      || typeof ensureDirectory !== "function") {
    throw new TypeError("Archive storage guard options are invalid");
  }
  const indexDirectory = dirname(indexFile);
  try {
    await ensureDirectory(indexDirectory, { recursive: true, mode: 0o700 });
  } catch {
    throw fixedError("local_archive_index_storage_unavailable");
  }
  let existingBytes = 0;
  try {
    const metadata = await indexStat(indexFile);
    if (!metadata?.isFile?.() || metadata.isSymbolicLink()
        || !Number.isSafeInteger(metadata.size) || metadata.size < 0) {
      throw fixedError("local_archive_index_storage_unavailable");
    }
    existingBytes = metadata.size;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (error?.code?.startsWith("local_archive_index_")) throw error;
      throw fixedError("local_archive_index_storage_unavailable");
    }
  }
  let filesystem;
  try {
    filesystem = await filesystemStats(indexDirectory);
  } catch {
    throw fixedError("local_archive_index_storage_unavailable");
  }
  const blockBytes = Number(filesystem?.bsize);
  const availableBlocks = Number(filesystem?.bavail);
  if (!Number.isSafeInteger(blockBytes) || blockBytes < 1
      || !Number.isSafeInteger(availableBlocks) || availableBlocks < 0
      || availableBlocks > Math.floor(Number.MAX_SAFE_INTEGER / blockBytes)) {
    throw fixedError("local_archive_index_storage_unavailable");
  }
  const availableBytes = availableBlocks * blockBytes;
  const requiredBytes = safeArchiveByteSum(
    existingBytes,
    budgetBytes,
    ARCHIVE_INDEX_STORAGE_RESERVE_BYTES,
  );
  if (requiredBytes === null) {
    throw fixedError("local_archive_index_storage_unavailable");
  }
  if (availableBytes < requiredBytes) {
    throw fixedError("local_archive_index_disk_space");
  }
  return { availableBytes, requiredBytes, existingBytes };
}

function emptyCoverage(phase, errorCode = null) {
  return {
    status: "partial",
    phase,
    errorCode,
    generatedAt: null,
    coveredAt: { startAt: null, endAt: null },
    sourceCount: 0,
    indexedSourceCount: 0,
    pendingSourceCount: 0,
    sourceBytes: 0,
    indexedBytes: 0,
  };
}

function projectCoverage(inspection, phase = "idle") {
  const coverage = inspection?.coverage;
  if (!coverage || !ARCHIVE_STATES.has(coverage.status)) {
    return emptyCoverage("invalid");
  }
  return {
    status: coverage.status,
    phase,
    errorCode: coverage.blockReason === undefined
      ? null
      : `archive_${coverage.blockReason}`,
    generatedAt: inspection.generatedAt,
    coveredAt: {
      startAt: inspection.coveredAt?.startAt ?? null,
      endAt: inspection.coveredAt?.endAt ?? null,
    },
    sourceCount: coverage.sourceCount,
    indexedSourceCount: coverage.indexedSourceCount,
    pendingSourceCount: coverage.pendingSourceCount,
    sourceBytes: coverage.sourceBytes,
    indexedBytes: coverage.indexedBytes,
  };
}

function timeoutSignal(signal, timeoutMs) {
  const controller = new AbortController();
  let expired = false;
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  timeout.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => expired,
    dispose() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    },
  };
}

function archiveBlockReason(error, timedOut) {
  if (timedOut) return "timeout";
  switch (error?.code) {
    case "codex_log_discovery_directory_entries":
      return "directory_entries";
    case "codex_log_discovery_rollout_files":
      return "rollout_files";
    case "local_archive_index_disk_space":
      return "disk_space";
    case "local_archive_index_storage_unavailable":
      return "storage_unavailable";
    default:
      return error?.name === "AbortError"
        || error?.code === "local_analysis_index_aborted"
        ? "interrupted"
        : null;
  }
}

export function defaultLocalArchiveAccountingIndexPath(root = process.cwd()) {
  return resolve(
    root,
    ".usage-monitor",
    `${LOCAL_ARCHIVE_ACCOUNTING_INDEX_VERSION}.sqlite`,
  );
}

export function defaultLocalArchiveAccountingIndexSecretPath(indexFile) {
  if (typeof indexFile !== "string" || indexFile.length < 1) {
    throw new TypeError("Archive index file must be a non-empty string");
  }
  return resolve(
    dirname(indexFile),
    `${LOCAL_ARCHIVE_ACCOUNTING_INDEX_VERSION}-secret`,
  );
}

export async function inspectLocalArchiveAccountingIndex({
  indexFile = defaultLocalArchiveAccountingIndexPath(),
} = {}) {
  if (typeof indexFile !== "string" || indexFile.length < 1) {
    throw new TypeError("Archive index file must be a non-empty string");
  }
  try {
    return projectCoverage(await inspectLocalAnalysisIndex({ indexFile }));
  } catch {
    // A missing, incompatible, or unreadable archive must never be mistaken
    // for completed historical coverage. The fixed state is intentionally
    // content-free and contains no filesystem detail.
    return emptyCoverage("not_started", "archive_index_unavailable");
  }
}

export async function refreshLocalArchiveAccountingIndex({
  indexFile = defaultLocalArchiveAccountingIndexPath(),
  secretFile = defaultLocalArchiveAccountingIndexSecretPath(indexFile),
  codexHome,
  signal = null,
  now = () => Date.now(),
  initialReadBudgetBytes = ARCHIVE_INDEX_INITIAL_READ_BUDGET_BYTES,
  deepReadBudgetBytes = ARCHIVE_INDEX_DEEP_READ_BUDGET_BYTES,
  maximumDirectoryEntries = ARCHIVE_INDEX_MAX_DIRECTORY_ENTRIES,
  maximumRolloutFiles = ARCHIVE_INDEX_MAX_ROLLOUT_FILES,
  passTimeoutMs = ARCHIVE_INDEX_PASS_TIMEOUT_MS,
  workerCount,
  chunkBytes = ARCHIVE_INDEX_COMMIT_CHUNK_BYTES,
  commitSliceBytes = ARCHIVE_INDEX_INITIAL_READ_BUDGET_BYTES,
  filesystemStats = statfs,
  indexStat = lstat,
  ensureIndexDirectory = mkdir,
} = {}) {
  if (typeof indexFile !== "string"
      || indexFile.length < 1
      || typeof secretFile !== "string"
      || secretFile.length < 1
      || typeof codexHome !== "string"
      || codexHome.length < 1
      || !validAbortSignal(signal)
      || typeof now !== "function"
      || !positiveSafeInteger(initialReadBudgetBytes)
      || !positiveSafeInteger(deepReadBudgetBytes)
      || !positiveSafeInteger(maximumDirectoryEntries)
      || !positiveSafeInteger(maximumRolloutFiles)
      || !positiveSafeInteger(passTimeoutMs)
      || !positiveSafeInteger(chunkBytes)
      || !positiveSafeInteger(commitSliceBytes)
      || typeof filesystemStats !== "function"
      || typeof indexStat !== "function"
      || typeof ensureIndexDirectory !== "function") {
    throw new TypeError("Local archive accounting index options are invalid");
  }
  const nowMs = now();
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("now must return a finite epoch timestamp");
  }
  const before = await inspectLocalArchiveAccountingIndex({ indexFile });
  const firstPass = before.phase === "not_started";
  const budgetBytes = firstPass
    ? initialReadBudgetBytes
    : deepReadBudgetBytes;
  const timed = timeoutSignal(signal, passTimeoutMs);
  try {
    const refreshed = await refreshLocalAnalysisIndex({
      indexFile,
      secretFile,
      codexHome,
      startAt: ARCHIVE_START_AT,
      endAt: new Date(nowMs).toISOString(),
      signal: timed.signal,
      ...(workerCount === undefined ? {} : { workerCount }),
      chunkBytes,
      maximumSourcesPerRefresh: maximumRolloutFiles,
      maximumScanBytesPerRefresh: budgetBytes,
      maximumCommitBytes: commitSliceBytes,
      discoveryLimits: {
        maximumDirectoryEntries,
        maximumRolloutFiles,
      },
      beforeStage: () => ensureArchiveIndexDiskHeadroom({
        indexFile,
        budgetBytes,
        filesystemStats,
        indexStat,
        ensureDirectory: ensureIndexDirectory,
      }),
    });
    const coverage = projectCoverage({
      generatedAt: new Date(nowMs).toISOString(),
      coveredAt: {
        startAt: ARCHIVE_START_AT,
        endAt: new Date(nowMs).toISOString(),
      },
      coverage: refreshed.coverage,
    }, refreshed.coverage.status === "complete" ? "complete" : "awaiting_resume");
    return {
      ...coverage,
      readBudgetBytes: budgetBytes,
      scanBytes: refreshed.scanBytes,
      refreshStatus: refreshed.status,
    };
  } catch (error) {
    const reason = archiveBlockReason(error, timed.timedOut());
    if (reason !== null) {
      let partial = null;
      try {
        await markLocalAnalysisIndexCoveragePartial({
          indexFile,
          reason,
          observedAt: new Date(nowMs).toISOString(),
        });
        partial = await inspectLocalArchiveAccountingIndex({ indexFile });
      } catch (markerError) {
        // Disk exhaustion can prevent even the tiny durable partial marker
        // from being written. Still return an honest, content-free partial
        // result for this refresh rather than presenting the failed pass as a
        // completed historical total.
        if (!["disk_space", "storage_unavailable"].includes(reason)) {
          throw markerError;
        }
        partial = {
          ...emptyCoverage("awaiting_resume", `archive_${reason}`),
          generatedAt: new Date(nowMs).toISOString(),
          coveredAt: {
            startAt: ARCHIVE_START_AT,
            endAt: new Date(nowMs).toISOString(),
          },
        };
      }
      // A discovery ceiling or this archive pass's own deadline is an
      // expected, durable coverage result, not a failed dashboard refresh.
      // The caller can immediately render "partial" and a later explicit
      // refresh will resume the committed source offsets. An external abort
      // remains a cancellation so the refresh controller retains its normal
      // cancellation semantics.
      if (reason !== "interrupted") {
        return {
          ...partial,
          phase: "awaiting_resume",
          readBudgetBytes: budgetBytes,
          // A failed stage has no newly published parser byte count. Keeping
          // this at zero avoids presenting an uncommitted estimate as work
          // that can safely be resumed.
          scanBytes: 0,
          refreshStatus: "paused",
        };
      }
    }
    throw error;
  } finally {
    timed.dispose();
  }
}
