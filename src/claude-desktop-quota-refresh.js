import { createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";
import {
  CLAUDE_DESKTOP_QUOTA_AUTHORITY,
  CLAUDE_DESKTOP_QUOTA_PROVIDER,
  openClaudeDesktopQuotaState,
} from "./claude-desktop-quota-state.js";
import { isWindowsProtectedStateStore } from "./platform/index.js";
import {
  readClaudeDesktopPlanHistory,
} from "./claude-desktop-plan-history.js";

export const CLAUDE_DESKTOP_QUOTA_REFRESH_VERSION =
  "claude-desktop-quota-refresh-v0.1";
export const CLAUDE_DESKTOP_PLAN_HISTORY_BASENAME = "plan-usage-history.json";
export const CLAUDE_DESKTOP_PLAN_HISTORY_SOURCE_ID =
  "macos/application-support/Claude/plan-usage-history.json";

const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;
const SECRET_BYTES = 32;
export const CLAUDE_DESKTOP_QUOTA_SECRET_BASENAME =
  "claude-desktop-quota-state-v1-secret";

export class ClaudeDesktopQuotaRefreshError extends Error {
  constructor(code) {
    super(`Claude Desktop quota refresh failed (${code})`);
    this.name = "ClaudeDesktopQuotaRefreshError";
    this.code = `claude_desktop_quota_refresh_${code}`;
  }
}

function fail(code) {
  throw new ClaudeDesktopQuotaRefreshError(code);
}

function secretBuffer(secret) {
  if (!(secret instanceof Uint8Array) || secret.byteLength !== 32) fail("configuration");
  return Buffer.from(secret);
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("timestamp");
  return value;
}

function checkSignal(signal) {
  if (signal === null || signal === undefined) return;
  if (typeof signal !== "object" || typeof signal.aborted !== "boolean"
      || typeof signal.addEventListener !== "function") fail("configuration");
  if (signal.aborted) fail("aborted");
}

function safeStatePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    fail("configuration");
  }
  const selected = resolve(path);
  if (selected !== path) fail("configuration");
  return selected;
}

function safeWindowsSecretPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    fail("configuration");
  }
  let selected;
  try {
    selected = win32.normalize(path.replaceAll("/", "\\"));
  } catch {
    fail("configuration");
  }
  if (!win32.isAbsolute(selected) || selected.endsWith("\\")) fail("configuration");
  return selected;
}

function normalizedPlatform(platform) {
  if (typeof platform !== "string" || platform.length === 0) fail("configuration");
  // Do not allow a Windows process to opt into the ordinary Node filesystem
  // implementation by passing a downgraded platform label.
  if (process.platform === "win32" && platform !== "win32") {
    fail("windows_secret_unqualified");
  }
  return platform;
}

function qualifiedWindowsProtectedStateStore(store) {
  let valid = false;
  try {
    valid = isWindowsProtectedStateStore(store)
      && store.contractVersion === "windows-protected-state-store-v1"
      && store.productionSafe === true
      && store.rootBindingSafe === true
      && store.nativeReadBounded === true
      && typeof store.ensureProtectedDirectory === "function"
      && typeof store.read === "function"
      && typeof store.create === "function";
  } catch {
    valid = false;
  }
  if (!valid) fail("windows_secret_unqualified");
  return store;
}

function windowsSecretName(store, secretFile) {
  const selected = safeWindowsSecretPath(secretFile);
  let root;
  try {
    root = win32.normalize(store.rootPath.replaceAll("/", "\\"));
  } catch {
    fail("configuration");
  }
  const prefix = root.endsWith("\\") ? root : `${root}\\`;
  if (!win32.isAbsolute(root)
      || !selected.toLowerCase().startsWith(prefix.toLowerCase())) {
    fail("configuration");
  }
  const relative = selected.slice(prefix.length);
  // Keep the quota secret directly below the protected state root. This
  // avoids silently changing a caller's intended boundary or traversing into
  // another provider's state namespace.
  if (relative.length === 0 || relative.includes("\\") || relative.includes("/")) {
    fail("configuration");
  }
  return relative;
}

function protectedStoreErrorCode(error) {
  return typeof error?.code === "string" ? error.code : "";
}

function secretFromProtectedResult(result) {
  if (!result || (!Buffer.isBuffer(result.data) && !(result.data instanceof Uint8Array))
      || result.data.byteLength !== SECRET_BYTES) {
    fail("secret_unsafe");
  }
  return Buffer.from(result.data);
}

function ownerOnlyRegularFile(stats, expectedBytes = null) {
  return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1
    && (typeof process.getuid !== "function" || stats.uid === process.getuid())
    && (process.platform === "win32" || (stats.mode & 0o077) === 0)
    && (expectedBytes === null || stats.size === expectedBytes);
}

async function assertOwnerOnlyDirectory(path) {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    fail("secret_unavailable");
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    fail("secret_unsafe");
  }
}

/**
 * Load the stable, quota-only HMAC key used for account/source pseudonyms.
 * It is deliberately separate from Codex and contribution identities, and
 * the existing file is never silently chmod-repaired or rotated.
 */
export async function readOrCreateClaudeDesktopQuotaSecret(
  secretFile,
  {
    platform = process.platform,
    windowsProtectedStateStore = null,
  } = {},
) {
  platform = normalizedPlatform(platform);
  if (platform === "win32") {
    // Windows production must use the branded, future-qualified protected
    // store. Do not silently fall back to mkdir/open/readFile or accept a
    // copied object that merely resembles the store contract.
    const store = qualifiedWindowsProtectedStateStore(windowsProtectedStateStore);
    const name = windowsSecretName(store, secretFile);
    try {
      store.ensureProtectedDirectory();
      try {
        return secretFromProtectedResult(store.read(name));
      } catch (error) {
        if (protectedStoreErrorCode(error)
            !== "windows_protected_state_store_missing") {
          throw error;
        }
      }
      const candidate = randomBytes(SECRET_BYTES);
      try {
        try {
          store.create(name, candidate);
        } catch (error) {
          // Another qualified writer may have won the create race. Read that
          // exact protected child rather than using a filesystem fallback.
          if (protectedStoreErrorCode(error)
              !== "windows_protected_state_store_already_exists") {
            throw error;
          }
          return secretFromProtectedResult(store.read(name));
        }
        return Buffer.from(candidate);
      } finally {
        candidate.fill(0);
      }
    } catch (error) {
      if (error?.code === "claude_desktop_quota_refresh_secret_unsafe") throw error;
      fail("secret_unavailable");
    }
  }
  if (windowsProtectedStateStore !== null) fail("configuration");
  const selected = safeStatePath(secretFile);
  const parent = dirname(selected);
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
  } catch {
    fail("secret_unavailable");
  }
  await assertOwnerOnlyDirectory(parent);
  let writeHandle;
  try {
    writeHandle = await open(
      selected,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const secret = randomBytes(SECRET_BYTES);
    await writeHandle.writeFile(secret);
    await writeHandle.sync();
    return secret;
  } catch (error) {
    if (error?.code !== "EEXIST") fail("secret_unavailable");
  } finally {
    await writeHandle?.close().catch(() => {});
  }
  let readHandle;
  try {
    readHandle = await open(
      selected,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stats = await readHandle.stat();
    if (!ownerOnlyRegularFile(stats, SECRET_BYTES)) fail("secret_unsafe");
    const secret = Buffer.alloc(SECRET_BYTES);
    const { bytesRead } = await readHandle.read(secret, 0, SECRET_BYTES, 0);
    if (bytesRead !== SECRET_BYTES) {
      secret.fill(0);
      fail("secret_unavailable");
    }
    return secret;
  } catch (error) {
    if (error instanceof ClaudeDesktopQuotaRefreshError) throw error;
    fail("secret_unavailable");
  } finally {
    await readHandle?.close().catch(() => {});
  }
}

function assertOwnerOnlyDirectoryStats(stats) {
  if (!stats.isDirectory() || stats.isSymbolicLink()
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    fail("source_unsafe");
  }
}

function assertOwnerOnlyFileStats(stats) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    fail("source_unsafe");
  }
}

function applicationSupportDirectory({ homeDirectory = null, applicationSupportDirectory = null } = {}) {
  if (homeDirectory !== null && applicationSupportDirectory !== null) fail("configuration");
  if (applicationSupportDirectory !== null && (
    typeof applicationSupportDirectory !== "string" || applicationSupportDirectory.length === 0
      || resolve(applicationSupportDirectory) !== applicationSupportDirectory
  )) fail("configuration");
  if (homeDirectory !== null && (
    typeof homeDirectory !== "string" || homeDirectory.length === 0
      || resolve(homeDirectory) !== homeDirectory
  )) fail("configuration");
  const selected = applicationSupportDirectory === null
    ? join(resolve(homeDirectory ?? homedir()), "Library", "Application Support", "Claude")
    : resolve(applicationSupportDirectory);
  if (basename(selected) !== "Claude") fail("configuration");
  return selected;
}

/**
 * Return the one native Claude Desktop plan-history path that this lane is
 * allowed to read. Callers provide only the application-support anchor; they
 * cannot redirect the reader to an arbitrary file.
 */
export function claudeDesktopPlanHistoryPath(options = {}) {
  return join(applicationSupportDirectory(options), CLAUDE_DESKTOP_PLAN_HISTORY_BASENAME);
}

export function defaultClaudeDesktopApplicationSupportDirectory(homeDirectory = homedir()) {
  return applicationSupportDirectory({ homeDirectory });
}

export function claudeDesktopQuotaSourceKey({ secret } = {}) {
  const key = secretBuffer(secret);
  try {
    return createHmac("sha256", key)
      .update("app-usagemonitor/claude-desktop-quota-source/v1\0", "utf8")
      .update(CLAUDE_DESKTOP_PLAN_HISTORY_SOURCE_ID, "utf8")
      .digest("hex");
  } finally {
    key.fill(0);
  }
}

function sourceErrorCode(error) {
  const code = typeof error?.code === "string" ? error.code : "source_unavailable";
  const prefix = "claude_desktop_plan_history_";
  if (code.startsWith(prefix)) return code.slice(prefix.length);
  const refreshPrefix = "claude_desktop_quota_refresh_";
  return code.startsWith(refreshPrefix) ? code.slice(refreshPrefix.length) : code;
}

function statusForSourceError(error) {
  const code = sourceErrorCode(error);
  if (code === "source_missing") return "missing_suspected";
  if (code === "source_unsafe" || code === "source_unavailable") return "inaccessible";
  return "partial";
}

async function sourceStats(path) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") fail("source_missing");
    fail("source_unavailable");
  }
  assertOwnerOnlyFileStats(stats);
  return {
    dev: Number(stats.dev),
    ino: Number(stats.ino),
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs),
  };
}

/**
 * Read only the native quota file. This function intentionally accepts no
 * transcript directories, project roots, or caller-selected file path.
 */
export async function readClaudeDesktopQuotaSource(options = {}) {
  checkSignal(options.signal);
  const supportDirectory = applicationSupportDirectory(options);
  let directoryStats;
  try {
    directoryStats = await lstat(supportDirectory);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") fail("source_missing");
    fail("source_unavailable");
  }
  assertOwnerOnlyDirectoryStats(directoryStats);
  checkSignal(options.signal);
  const path = claudeDesktopPlanHistoryPath({ applicationSupportDirectory: supportDirectory });
  const before = await sourceStats(path);
  let history;
  try {
    history = await readClaudeDesktopPlanHistory(path, {
      secret: options.secret,
      signal: options.signal,
    });
  } catch (error) {
    throw error;
  }
  const after = await sourceStats(path);
  if (before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    fail("source_changed");
  }
  checkSignal(options.signal);
  return { history, metadata: after };
}

function projectionResult(state, nowAtMs, staleAfterMs) {
  return state.readProjection({ nowAtMs, staleAfterMs });
}

/**
 * Refresh the production-owned native quota ledger. A source read failure only
 * changes source lifecycle/coverage state; accepted quota revisions remain in
 * SQLite and continue to appear in the privacy-safe projection.
 */
export async function refreshClaudeDesktopQuota({
  statePath,
  homeDirectory = null,
  applicationSupportDirectory = null,
  secret,
  platform = process.platform,
  windowsSqliteStateSession = null,
  observedAtMs = Date.now(),
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  signal = null,
} = {}) {
  platform = normalizedPlatform(platform);
  const selectedStatePath = platform === "win32"
    ? safeWindowsSecretPath(statePath)
    : safeStatePath(statePath);
  const timestamp = safeTimestamp(observedAtMs);
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 0) fail("stale_after");
  checkSignal(signal);
  const sourceKey = claudeDesktopQuotaSourceKey({ secret });
  let source = null;
  let sourceFailure = null;
  try {
    source = await readClaudeDesktopQuotaSource({
      homeDirectory,
      applicationSupportDirectory,
      secret,
      signal,
    });
  } catch (error) {
    if (sourceErrorCode(error) === "configuration") throw error;
    if (sourceErrorCode(error) === "aborted") throw error;
    sourceFailure = error;
  }
  checkSignal(signal);
  const state = openClaudeDesktopQuotaState(selectedStatePath, {
    platform,
    windowsSqliteStateSession,
  });
  try {
    if (sourceFailure !== null) {
      const error = sourceFailure;
      const status = statusForSourceError(error);
      const sourceState = state.markSourceStatus({
        sourceKey,
        status,
        observedAtMs: timestamp,
        errorCode: sourceErrorCode(error),
      });
      return {
        schemaVersion: CLAUDE_DESKTOP_QUOTA_REFRESH_VERSION,
        provider: CLAUDE_DESKTOP_QUOTA_PROVIDER,
        authority: CLAUDE_DESKTOP_QUOTA_AUTHORITY,
        sourceKey,
        sourceStatus: status,
        sourceGeneration: sourceState.sourceGeneration,
        imported: { inserted: 0, duplicates: 0, revisions: 0 },
        sourceErrorCode: sourceErrorCode(error),
        projection: projectionResult(state, timestamp, staleAfterMs),
      };
    }
    const merged = state.mergeQuotaObservations(source.history.observations, {
      sourceKey,
      acceptedAtMs: timestamp,
      sourceMetadata: source.metadata,
    });
    return {
      schemaVersion: CLAUDE_DESKTOP_QUOTA_REFRESH_VERSION,
      provider: CLAUDE_DESKTOP_QUOTA_PROVIDER,
      authority: CLAUDE_DESKTOP_QUOTA_AUTHORITY,
      sourceKey,
      sourceStatus: merged.sourceStatus,
      sourceGeneration: merged.sourceGeneration,
      imported: {
        inserted: merged.inserted,
        duplicates: merged.duplicates,
        revisions: merged.revisions,
      },
      sampleCount: source.history.sampleCount,
      observationCount: source.history.observationCount,
      projection: projectionResult(state, timestamp, staleAfterMs),
    };
  } finally {
    state.close();
  }
}
