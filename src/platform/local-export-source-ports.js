import { Buffer } from "node:buffer";
import { createHash, createHmac } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { isProxy } from "node:util/types";

import { readBoundedUtf8LineEntries } from "./bounded-jsonl-reader.js";
import { createLocalCodexLogPorts } from "./local-codex-log-ports.js";
import {
  deriveAccountScopeId,
  deriveEventOccurrenceId,
  deriveMarkerOccurrenceId,
  deriveModelFingerprint,
  deriveParticipantId,
  deriveQuotaStateId,
  deriveSessionScopeId,
  deriveSnapshotObservationId,
} from "./participant-identity.js";

const DEFAULT_CLAUDE_STATUS_MAX_RECORDS = 20_000;
const DEFAULT_CLAUDE_STATUS_MAX_LEDGER_BYTES = 32 * 1024 * 1024;
const MAX_CLAUDE_STATUS_RECORD_BYTES = 4096;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const CLAUDE_STATE_ENVIRONMENT_KEYS = Object.freeze(["LOCALAPPDATA", "XDG_STATE_HOME"]);
const CODEX_ENVIRONMENT_KEYS = Object.freeze(["CODEX_HOME"]);

export function localPlatformName() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "windows";
  return "other";
}

export const localIsProxy = isProxy;

function invalid() {
  throw new TypeError("local export-source platform configuration is invalid");
}

class LocalExportSourcePortError extends Error {
  constructor(code) {
    super(`Local export-source platform failed (${code})`);
    this.name = "LocalExportSourcePortError";
    this.code = `local_export_source_port_${code}`;
  }
}

function ownData(configuration, key, fallback) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(configuration, key);
    if (descriptor === undefined) return fallback;
    if (!Object.hasOwn(descriptor, "value")) invalid();
    return descriptor.value === undefined ? fallback : descriptor.value;
  } catch {
    invalid();
  }
}

function snapshotEnvironment(environment, keys) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)
      || isProxy(environment)) invalid();
  const snapshot = {};
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(environment, key);
      if (descriptor === undefined) continue;
      if (!Object.hasOwn(descriptor, "value")
          || (descriptor.value !== undefined && typeof descriptor.value !== "string")) invalid();
      if (descriptor.value !== undefined) snapshot[key] = descriptor.value;
    }
  } catch {
    invalid();
  }
  return Object.freeze(snapshot);
}

function directoryChain(target) {
  const root = parse(target).root;
  const suffix = relative(root, target);
  const parts = suffix === "" ? [] : suffix.split(sep).filter(Boolean);
  const chain = [root];
  for (const part of parts) chain.push(join(chain[chain.length - 1], part));
  return chain;
}

function exportDirectoryIdentity(stats) {
  return Object.freeze({
    device: stats.dev,
    inode: stats.ino,
    birthtimeMs: Math.trunc(stats.birthtimeMs),
  });
}

function matchesExportDirectoryIdentity(stats, expected) {
  return stats.dev === expected?.device
    && stats.ino === expected?.inode
    && Math.trunc(stats.birthtimeMs) === expected?.birthtimeMs;
}

export function createLocalExportSourcePorts(configuration = {}) {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)
      || isProxy(configuration)) invalid();
  const configuredEnvironment = ownData(configuration, "environment", process.env);
  const homeDirectory = ownData(configuration, "homeDirectory", homedir());
  const platform = ownData(configuration, "platform", process.platform);
  if (typeof homeDirectory !== "string" || typeof platform !== "string") invalid();
  const environment = snapshotEnvironment(configuredEnvironment, CLAUDE_STATE_ENVIRONMENT_KEYS);
  const codexEnvironment = snapshotEnvironment(configuredEnvironment, CODEX_ENVIRONMENT_KEYS);

  function statusFail(code) {
    throw new LocalExportSourcePortError(code);
  }

  function currentUid() {
    return typeof process.getuid === "function" ? process.getuid() : null;
  }

  function assertOwnerDirectory(stats) {
    if (!stats.isDirectory() || stats.isSymbolicLink()) statusFail("state_directory_type");
    const uid = currentUid();
    if (uid !== null && stats.uid !== uid) statusFail("state_directory_owner");
    if (platform !== "win32" && (stats.mode & 0o777) !== 0o700) statusFail("state_directory_mode");
  }

  function assertSafeDirectoryComponent(stats, ownerOnly) {
    if (!stats.isDirectory() || stats.isSymbolicLink()) statusFail("state_parent_type");
    const uid = currentUid();
    if (uid !== null) {
      if (ownerOnly ? stats.uid !== uid : stats.uid !== uid && stats.uid !== 0) {
        statusFail("state_parent_owner");
      }
    }
    if (platform === "win32") return;
    const mode = stats.mode & 0o7777;
    if (ownerOnly) {
      if ((mode & 0o077) !== 0 || (mode & 0o100) === 0) statusFail("state_parent_mode");
    } else if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) {
      statusFail("state_parent_mode");
    }
  }

  async function safeLstat(path, code = "state_directory_missing") {
    try {
      return await lstat(path);
    } catch {
      statusFail(code);
    }
  }

  async function validateExistingDirectoryChain(target) {
    const targetParent = join(target, "..");
    for (const component of directoryChain(target)) {
      const stats = await safeLstat(component);
      if (component === target) assertOwnerDirectory(stats);
      else assertSafeDirectoryComponent(stats, component === resolve(targetParent));
    }
    let canonical;
    try {
      canonical = await realpath(target);
    } catch {
      statusFail("state_directory_missing");
    }
    if (canonical !== target) statusFail("state_parent_alias");
  }

  async function openVerifiedOwnerDirectory(path) {
    const before = await safeLstat(path);
    assertOwnerDirectory(before);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | NOFOLLOW);
      const opened = await handle.stat();
      assertOwnerDirectory(opened);
      if (opened.dev !== before.dev || opened.ino !== before.ino
          || Math.trunc(opened.birthtimeMs) !== Math.trunc(before.birthtimeMs)) {
        statusFail("state_directory_replaced");
      }
      return { handle, stats: opened };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error instanceof LocalExportSourcePortError) throw error;
      statusFail("state_directory_replaced");
    }
  }

  function resolveStateDirectory(value) {
    if (typeof value !== "string" || !isAbsolute(value) || value.length > 4096) statusFail("state_path");
    return resolve(value);
  }

  async function inspectClaudeStatusLedgerDirectoriesForExport(stateDirectory) {
    const root = resolveStateDirectory(stateDirectory);
    await validateExistingDirectoryChain(root);
    const recordsDirectory = join(root, "records");
    await validateExistingDirectoryChain(recordsDirectory);
    const rootOpened = await openVerifiedOwnerDirectory(root);
    const recordsOpened = await openVerifiedOwnerDirectory(recordsDirectory);
    try {
      const rootStats = await rootOpened.handle.stat();
      const recordsStats = await recordsOpened.handle.stat();
      assertOwnerDirectory(rootStats);
      assertOwnerDirectory(recordsStats);
      const rootPathStats = await safeLstat(root);
      const recordsPathStats = await safeLstat(recordsDirectory);
      if (rootStats.dev !== rootPathStats.dev || rootStats.ino !== rootPathStats.ino
          || recordsStats.dev !== recordsPathStats.dev || recordsStats.ino !== recordsPathStats.ino) {
        statusFail("state_directory_replaced");
      }
      return Object.freeze({
        root,
        recordsDirectory,
        rootIdentity: exportDirectoryIdentity(rootStats),
        recordsIdentity: exportDirectoryIdentity(recordsStats),
      });
    } finally {
      await recordsOpened.handle.close().catch(() => {});
      await rootOpened.handle.close().catch(() => {});
    }
  }

  async function revalidateClaudeStatusLedgerDirectoriesForExport(boundary) {
    const current = await inspectClaudeStatusLedgerDirectoriesForExport(boundary?.root);
    if (current.recordsDirectory !== boundary?.recordsDirectory
        || !matchesExportDirectoryIdentity({
          dev: current.rootIdentity.device,
          ino: current.rootIdentity.inode,
          birthtimeMs: current.rootIdentity.birthtimeMs,
        }, boundary?.rootIdentity)
        || !matchesExportDirectoryIdentity({
          dev: current.recordsIdentity.device,
          ino: current.recordsIdentity.inode,
          birthtimeMs: current.recordsIdentity.birthtimeMs,
        }, boundary?.recordsIdentity)) statusFail("state_directory_replaced");
    return current;
  }

  function defaultClaudeStatusStateDirectory(options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options) || isProxy(options)) invalid();
    const configuredPlatform = ownData(options, "platform", platform);
    const env = snapshotEnvironment(
      ownData(options, "env", environment),
      CLAUDE_STATE_ENVIRONMENT_KEYS,
    );
    const configuredHome = ownData(options, "homeDirectory", homeDirectory);
    if (typeof configuredHome !== "string" || !isAbsolute(configuredHome)) statusFail("state_home");
    let base;
    if (configuredPlatform === "darwin") {
      base = join(configuredHome, "Library", "Application Support");
    } else if (configuredPlatform === "win32") {
      base = env.LOCALAPPDATA;
      if (typeof base !== "string" || !isAbsolute(base)) base = join(configuredHome, "AppData", "Local");
    } else {
      base = env.XDG_STATE_HOME;
      if (base !== undefined && (typeof base !== "string" || !isAbsolute(base))) statusFail("state_root");
      if (base === undefined) base = join(configuredHome, ".local", "state");
    }
    return join(base, "app-usagemonitor", "claude-statusline-v0.2");
  }

  const codexLogPorts = createLocalCodexLogPorts({ environment: codexEnvironment, homeDirectory });
  return Object.freeze({
    allocUnsafe: Buffer.allocUnsafe.bind(Buffer),
    bufferByteLength: Buffer.byteLength.bind(Buffer),
    bufferFrom: Buffer.from.bind(Buffer),
    bufferIsBuffer: Buffer.isBuffer.bind(Buffer),
    clock: () => Date.now(),
    codexLogPorts,
    createHash,
    createHmac,
    currentUid,
    defaultClaudeStatusStateDirectory,
    defaultHomeDirectory: homeDirectory,
    deriveAccountScopeId,
    deriveEventOccurrenceId,
    deriveMarkerOccurrenceId,
    deriveModelFingerprint,
    deriveParticipantId,
    deriveQuotaStateId,
    deriveSessionScopeId,
    deriveSnapshotObservationId,
    fsConstants: Object.freeze({
      O_NOFOLLOW: constants.O_NOFOLLOW,
      O_RDONLY: constants.O_RDONLY,
    }),
    inspectClaudeStatusLedgerDirectoriesForExport,
    joinPath: join,
    lstat,
    open,
    openDirectory: opendir,
    platform,
    readBoundedUtf8LineEntries,
    realpath,
    revalidateClaudeStatusLedgerDirectoriesForExport,
    resolvePath: resolve,
    resolveRealpath: realpath,
    rss: () => process.memoryUsage().rss,
    DEFAULT_CLAUDE_STATUS_MAX_LEDGER_BYTES,
    DEFAULT_CLAUDE_STATUS_MAX_RECORDS,
    MAX_CLAUDE_STATUS_RECORD_BYTES,
  });
}
