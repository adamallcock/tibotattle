import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { inspectClaudeDesktopShadowReadiness } from "./claude-desktop-shadow-readiness.js";
import { runClaudeDesktopShadowRefresh } from "./claude-desktop-shadow-refresh.js";
import { openClaudeDesktopShadowStore } from "./claude-desktop-shadow-store.js";
import { openClaudeDesktopLedgerPrototype } from "./claude-desktop-ledger-prototype.js";
import { localCompanionStatePaths } from "./local-installation-diagnostics.js";

export const CLAUDE_DESKTOP_SHADOW_CONTROLLER_VERSION =
  "claude-desktop-shadow-controller-v0.1";

const PROVIDER = "anthropic_claude_code";
const SECRET_BYTES = 32;
const DAY_MS = 24 * 60 * 60 * 1_000;
const STATUS_VALUES = new Set([
  "idle",
  "disabled",
  "blocked",
  "partial",
  "completed",
  "deferred",
  "aborted",
  "timed_out",
  "failed",
  "busy",
  "purged",
]);

export class ClaudeDesktopShadowControllerError extends Error {
  constructor(code) {
    super(`Claude Desktop shadow controller failed (${code})`);
    this.name = "ClaudeDesktopShadowControllerError";
    this.code = `claude_desktop_shadow_controller_${code}`;
  }
}

function fail(code) {
  throw new ClaudeDesktopShadowControllerError(code);
}

function safeAbsolutePath(value, code = "configuration") {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
      || !isAbsolute(value) || resolve(value) !== value) fail(code);
  return value;
}

function safeTimestamp(value, code = "configuration") {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function ownerOnlyDirectory(stats) {
  return stats.isDirectory() && !stats.isSymbolicLink()
    && (typeof process.getuid !== "function" || stats.uid === process.getuid())
    && (process.platform === "win32" || (stats.mode & 0o077) === 0);
}

function ownerOnlySecret(stats) {
  return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1
    && stats.size === SECRET_BYTES
    && (typeof process.getuid !== "function" || stats.uid === process.getuid())
    && (process.platform === "win32" || (stats.mode & 0o077) === 0);
}

function ownerOnlyRegularFile(stats) {
  return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1
    && (typeof process.getuid !== "function" || stats.uid === process.getuid())
    && (process.platform === "win32" || (stats.mode & 0o077) === 0);
}

function abortError() {
  const error = new Error("Claude Desktop shadow operation aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortError();
}

async function readOrCreateShadowSecret(secretFile, { signal = null } = {}) {
  throwIfAborted(signal);
  const selected = safeAbsolutePath(secretFile, "secret_configuration");
  const parent = dirname(selected);
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if (!ownerOnlyDirectory(await lstat(parent))) fail("secret_unsafe");
    throwIfAborted(signal);
  } catch (error) {
    if (error instanceof ClaudeDesktopShadowControllerError) throw error;
    if (error?.name === "AbortError") throw error;
    fail("secret_unavailable");
  }
  let writer;
  try {
    throwIfAborted(signal);
    writer = await open(
      selected,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    throwIfAborted(signal);
    const secret = randomBytes(SECRET_BYTES);
    await writer.writeFile(secret);
    throwIfAborted(signal);
    await writer.sync();
    throwIfAborted(signal);
    return secret;
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    if (error?.code !== "EEXIST") fail("secret_unavailable");
  } finally {
    await writer?.close().catch(() => {});
  }
  let reader;
  try {
    throwIfAborted(signal);
    reader = await open(selected, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stats = await reader.stat();
    throwIfAborted(signal);
    if (!ownerOnlySecret(stats)) fail("secret_unsafe");
    const secret = Buffer.alloc(SECRET_BYTES);
    const { bytesRead } = await reader.read(secret, 0, SECRET_BYTES, 0);
    throwIfAborted(signal);
    if (bytesRead !== SECRET_BYTES) {
      secret.fill(0);
      fail("secret_unavailable");
    }
    return secret;
  } catch (error) {
    if (error instanceof ClaudeDesktopShadowControllerError) throw error;
    if (error?.name === "AbortError") throw error;
    fail("secret_unavailable");
  } finally {
    await reader?.close().catch(() => {});
  }
}

function baseResult(status, extra = {}) {
  if (!STATUS_VALUES.has(status)) fail("result");
  return {
    schemaVersion: CLAUDE_DESKTOP_SHADOW_CONTROLLER_VERSION,
    provider: PROVIDER,
    status,
    localOnly: true,
    uiEnabled: false,
    uploadEnabled: false,
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    ...extra,
  };
}

function fixedFailure(status, reasonCode, retryAtMs = null) {
  return baseResult(status, {
    reasonCode,
    retryAtMs: Number.isSafeInteger(retryAtMs) ? retryAtMs : null,
  });
}

function projectReadiness(value) {
  return {
    status: value.status,
    usageSources: {
      metadata: value.usageSources.metadata.status,
      projects: value.usageSources.projects.status,
    },
    quotaSource: value.quotaSource.status,
    retention: {
      status: value.retention.status,
      effectiveDays: value.retention.effectiveDays,
      effectiveScope: value.retention.effectiveScope,
    },
  };
}

function projectRefresh(result, readiness) {
  const shadow = result?.shadow ?? {};
  const pricing = result?.pricingSummary ?? {};
  const publication = result?.pricingCachePublication ?? {};
  return baseResult(result?.status === "completed" ? "completed" : "partial", {
    readiness: projectReadiness(readiness),
    refresh: {
      elapsedMs: Number.isFinite(result?.elapsedMs) ? result.elapsedMs : null,
      sourceCount: safeCount(result?.canonical?.sourceCount),
      unchangedSources: safeCount(result?.canonical?.unchangedSources),
      appendedSources: safeCount(result?.canonical?.appendedSources),
      rebuiltSources: safeCount(result?.canonical?.rebuiltSources),
      missingSources: safeCount(result?.canonical?.missingSources),
      parsedBytes: safeCount(result?.canonical?.parsedBytes),
      parsedLines: safeCount(result?.canonical?.parsedLines),
      candidates: safeCount(result?.canonical?.candidateCount),
      inserted: safeCount(result?.merge?.inserted),
      superseded: safeCount(result?.merge?.superseded),
      tombstoned: safeCount(result?.merge?.tombstoned),
      pricingEvents: safeCount(pricing.eventCount),
      pricingCoverage: typeof pricing.coverageStatus === "string"
        ? pricing.coverageStatus : "unpriced",
      pricingCacheStatus: publication.status === "reused"
        ? "reused"
        : publication.status === "published" ? "published" : "unavailable",
      shadowRecordsInserted: safeCount(shadow.records?.inserted),
      shadowRecordsTombstoned: safeCount(shadow.records?.tombstoned),
      shadowArtifactsInserted: safeCount(shadow.artifacts?.inserted),
    },
  });
}

function combinedSignal(callerSignal, deadlineSignal) {
  if (callerSignal === null) return deadlineSignal;
  return AbortSignal.any([callerSignal, deadlineSignal]);
}

function isAbortSignal(value) {
  return value !== null && typeof value === "object"
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function"
    && typeof value.removeEventListener === "function";
}

async function awaitAbortable(promise, signal) {
  throwIfAborted(signal);
  let abort;
  const aborted = new Promise((resolve, reject) => {
    abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function pathWithin(root, path) {
  const result = relative(root, path);
  return result !== "" && result !== ".." && !result.startsWith(`..${sep}`)
    && !isAbsolute(result);
}

async function validatePurgeArtifacts(root, artifacts) {
  const rootPath = safeAbsolutePath(root, "artifact_root");
  let rootRealPath;
  try {
    rootRealPath = await realpath(rootPath);
  } catch {
    fail("state_unsafe");
  }
  const seen = new Set();
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== "object"
        || typeof artifact.path !== "string") {
      fail("purge_artifact_unsafe");
    }
    const artifactPath = safeAbsolutePath(artifact.path, "artifact_path");
    if (seen.has(artifactPath) || !pathWithin(rootPath, artifactPath)) {
      fail("purge_artifact_unsafe");
    }
    seen.add(artifactPath);
    let parentRealPath;
    try {
      parentRealPath = await realpath(dirname(artifactPath));
      if (!pathWithin(rootRealPath, parentRealPath)
          && parentRealPath !== rootRealPath) {
        fail("purge_artifact_unsafe");
      }
      if (!ownerOnlyDirectory(await lstat(parentRealPath))) {
        fail("purge_artifact_unsafe");
      }
    } catch (error) {
      if (error instanceof ClaudeDesktopShadowControllerError) throw error;
      fail("purge_artifact_unsafe");
    }
    let stats;
    try {
      stats = await lstat(artifactPath);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue;
      fail("purge_artifact_unsafe");
    }
    if (!ownerOnlyRegularFile(stats)) fail("purge_artifact_unsafe");
  }
}

function physicalPurgeInventory(paths) {
  return [
    { kind: "canonical", path: paths.claudeDesktopShadowCanonicalFile },
    { kind: "wal", path: `${paths.claudeDesktopShadowCanonicalFile}-wal` },
    { kind: "shm", path: `${paths.claudeDesktopShadowCanonicalFile}-shm` },
    { kind: "journal", path: `${paths.claudeDesktopShadowCanonicalFile}-journal` },
    { kind: "cache", path: paths.claudeDesktopPricingCacheFile },
    { kind: "wal", path: `${paths.claudeDesktopPricingCacheFile}-wal` },
    { kind: "shm", path: `${paths.claudeDesktopPricingCacheFile}-shm` },
    { kind: "journal", path: `${paths.claudeDesktopPricingCacheFile}-journal` },
  ];
}

export function createClaudeDesktopShadowController({
  enabled = false,
  stateRoot = null,
  homeDirectory = homedir(),
  projectDirectory = homeDirectory,
  claudeConfigDirectory = undefined,
  platform = process.platform,
  captureWindowDays = 30,
  timeoutMs = 60_000,
  initialBackoffMs = 60_000,
  maximumBackoffMs = 60 * 60_000,
  clock = () => Date.now(),
  inspectReadiness = inspectClaudeDesktopShadowReadiness,
  refreshShadow = runClaudeDesktopShadowRefresh,
} = {}) {
  if (typeof enabled !== "boolean" || typeof clock !== "function"
      || typeof inspectReadiness !== "function" || typeof refreshShadow !== "function"
      || !Number.isSafeInteger(captureWindowDays) || captureWindowDays < 1
      || captureWindowDays > 90
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 5 * 60_000
      || !Number.isSafeInteger(initialBackoffMs) || initialBackoffMs < 1_000
      || !Number.isSafeInteger(maximumBackoffMs) || maximumBackoffMs < initialBackoffMs) {
    fail("configuration");
  }

  let selectedStateRoot = null;
  let paths = null;
  let selectedHome = null;
  let selectedProject = null;
  let selectedConfig = claudeConfigDirectory;
  if (enabled) {
    selectedStateRoot = safeAbsolutePath(stateRoot);
    selectedHome = safeAbsolutePath(homeDirectory);
    selectedProject = safeAbsolutePath(projectDirectory);
    if (selectedConfig !== undefined) selectedConfig = safeAbsolutePath(selectedConfig);
    paths = localCompanionStatePaths(selectedStateRoot);
  }

  let activeOperation = null;
  let consecutiveFailures = 0;
  let retryAtMs = 0;

  function disabled() {
    return baseResult("disabled", { reasonCode: "shadow_disabled", retryAtMs: null });
  }

  function recordFailure(now, status, reasonCode) {
    consecutiveFailures += 1;
    const delay = Math.min(
      maximumBackoffMs,
      initialBackoffMs * (2 ** Math.min(consecutiveFailures - 1, 20)),
    );
    retryAtMs = now + delay;
    return fixedFailure(status, reasonCode, retryAtMs);
  }

  async function refresh({ signal = null } = {}) {
    if (!enabled) return disabled();
    if (signal !== null && !isAbortSignal(signal)) fail("signal");
    if (activeOperation !== null) return fixedFailure("busy", "shadow_operation_active");
    const now = safeTimestamp(clock());
    if (signal?.aborted) return fixedFailure("aborted", "shadow_aborted");
    if (now < retryAtMs) return fixedFailure("deferred", "shadow_backoff", retryAtMs);
    activeOperation = "refresh";
    let secret = null;
    const timeoutController = new AbortController();
    const signalValue = combinedSignal(signal, timeoutController.signal);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, timeoutMs);
    timer.unref?.();
    try {
      // Readiness is read-only, so it is safe to stop awaiting a broken or
      // non-cooperative injected probe when the deadline fires. The probe
      // still receives the signal so the production implementation can stop
      // its own work cooperatively as cancellation support expands.
      const readiness = await awaitAbortable(inspectReadiness({
        homeDirectory: selectedHome,
        projectDirectory: selectedProject,
        claudeConfigDirectory: selectedConfig,
        platform,
        shadowEnabled: true,
        signal: signalValue,
      }), signalValue);
      if (signalValue.aborted) {
        return recordFailure(
          safeTimestamp(clock()),
          timedOut ? "timed_out" : "aborted",
          timedOut ? "shadow_timeout" : "shadow_aborted",
        );
      }
      const usageReady = readiness?.usageSources?.metadata?.status === "available"
        && readiness?.usageSources?.projects?.status === "available";
      if (!usageReady) {
        consecutiveFailures = 0;
        retryAtMs = 0;
        return baseResult("blocked", {
          reasonCode: "shadow_sources_blocked",
          retryAtMs: null,
          readiness: projectReadiness(readiness),
        });
      }
      secret = await readOrCreateShadowSecret(paths.claudeDesktopShadowSecretFile, {
        signal: signalValue,
      });
      if (signalValue.aborted) {
        return recordFailure(
          safeTimestamp(clock()),
          timedOut ? "timed_out" : "aborted",
          timedOut ? "shadow_timeout" : "shadow_aborted",
        );
      }
      const endAtMs = safeTimestamp(clock());
      const startAtMs = Math.max(0, endAtMs - captureWindowDays * DAY_MS);
      const result = await refreshShadow({
        enabled: true,
        shadowStatePath: paths.claudeDesktopShadowStateFile,
        acceptedAtMs: endAtMs,
        refreshOptions: {
          metadataDirectory: join(
            selectedHome,
            "Library",
            "Application Support",
            "Claude",
            "claude-code-sessions",
          ),
          projectsDirectory: join(selectedConfig ?? join(selectedHome, ".claude"), "projects"),
          cleanupMarkerPath: join(selectedConfig ?? join(selectedHome, ".claude"), ".last-cleanup"),
          quotaHistoryPath: join(
            selectedHome,
            "Library",
            "Application Support",
            "Claude",
            "plan-usage-history.json",
          ),
          canonicalPath: paths.claudeDesktopShadowCanonicalFile,
          ledgerPath: paths.claudeDesktopShadowLedgerFile,
          pricingCachePath: paths.claudeDesktopPricingCacheFile,
          startAt: new Date(startAtMs).toISOString(),
          endAt: new Date(endAtMs).toISOString(),
          secret,
          signal: signalValue,
          includeQuota: false,
        },
      });
      if (signalValue.aborted) {
        return recordFailure(
          endAtMs,
          timedOut ? "timed_out" : "aborted",
          timedOut ? "shadow_timeout" : "shadow_aborted",
        );
      }
      consecutiveFailures = 0;
      retryAtMs = 0;
      return projectRefresh(result, readiness);
    } catch {
      const failedAt = safeTimestamp(clock());
      if (timedOut) return recordFailure(failedAt, "timed_out", "shadow_timeout");
      if (signal?.aborted) return recordFailure(failedAt, "aborted", "shadow_aborted");
      return recordFailure(failedAt, "failed", "shadow_refresh_failed");
    } finally {
      clearTimeout(timer);
      secret?.fill(0);
      activeOperation = null;
    }
  }

  async function purge({
    startAtMs = 0,
    endAtMs = Number.MAX_SAFE_INTEGER,
    createdAtMs = clock(),
  } = {}) {
    if (!enabled) return disabled();
    if (activeOperation !== null) return fixedFailure("busy", "shadow_operation_active");
    const start = safeTimestamp(startAtMs, "purge");
    const end = safeTimestamp(endAtMs, "purge");
    const created = safeTimestamp(createdAtMs, "purge");
    if (end < start) fail("purge");
    activeOperation = "purge";
    let ledger;
    let store;
    try {
      await mkdir(selectedStateRoot, { recursive: true, mode: 0o700 });
      if (!ownerOnlyDirectory(await lstat(selectedStateRoot))) fail("state_unsafe");
      const artifacts = physicalPurgeInventory(paths);
      // Open and validate the complete shadow side of the purge first. This
      // leaves the durable ledger untouched when the shadow DB or any known
      // rebuildable artifact is unsafe/unavailable. The store purge repeats
      // its own validation immediately before physical deletion.
      store = openClaudeDesktopShadowStore({
        statePath: paths.claudeDesktopShadowStateFile,
        enabled: true,
      });
      await validatePurgeArtifacts(selectedStateRoot, artifacts);
      // The durable ledger tombstone is retained. Deleting the ledger itself
      // would permit raw Claude files to resurrect the purged interval.
      ledger = openClaudeDesktopLedgerPrototype(paths.claudeDesktopShadowLedgerFile);
      const ledgerReceipt = ledger.purge(PROVIDER, {
        startAtMs: start,
        endAtMs: end,
        createdAtMs: created,
      });
      ledger.close();
      ledger = null;
      const shadowReceipt = store.purge({
        startAtMs: start,
        endAtMs: end,
        createdAtMs: created,
        artifactRoot: selectedStateRoot,
        artifacts,
      });
      consecutiveFailures = 0;
      retryAtMs = 0;
      return baseResult("purged", {
        purge: {
          startAtMs: start,
          endAtMs: end,
          ledgerUsageDeleted: safeCount(ledgerReceipt.usageDeleted),
          shadowRecordsDeleted: safeCount(shadowReceipt.logicalRecordsDeleted),
          shadowArtifactsDeleted: safeCount(shadowReceipt.logicalArtifactsDeleted),
          physicalRemoved: safeCount(shadowReceipt.physicalRemoved),
          physicalMissing: safeCount(shadowReceipt.physicalMissing),
          physicalFailed: safeCount(shadowReceipt.physicalFailed),
          status: shadowReceipt.status,
        },
      });
    } finally {
      ledger?.close();
      store?.close();
      activeOperation = null;
    }
  }

  return Object.freeze({
    status() {
      if (!enabled) return disabled();
      const now = safeTimestamp(clock());
      return baseResult(now < retryAtMs ? "deferred" : "idle", {
        reasonCode: now < retryAtMs ? "shadow_backoff" : "shadow_idle",
        retryAtMs: now < retryAtMs ? retryAtMs : null,
        activeOperation,
      });
    },
    refresh,
    purge,
  });
}
