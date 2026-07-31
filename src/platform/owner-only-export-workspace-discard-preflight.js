import { createHash, createHmac } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { isProxy } from "node:util/types";

function invalid() { throw new TypeError("Owner-only workspace discard preflight configuration is invalid"); }
function own(object, key) {
  if (!object || typeof object !== "object" || Array.isArray(object) || isProxy(object)) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
  return descriptor.value;
}
function callable(value) { if (typeof value !== "function" || isProxy(value)) invalid(); return value; }
function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) invalid();
  return value;
}
function optionalOwn(object, key, fallback) {
  plain(object);
  return Object.hasOwn(object, key) ? own(object, key) : fallback;
}
function exactOptions(value, keys) {
  if (value === undefined) return Object.freeze({});
  plain(value);
  for (const key of Object.getOwnPropertyNames(value)) if (!keys.includes(key)) invalid();
  const snapshot = {};
  for (const key of keys) if (Object.hasOwn(value, key)) snapshot[key] = own(value, key);
  return Object.freeze(snapshot);
}
function dataArray(value, depth) {
  if (isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
      || Object.getOwnPropertySymbols(value).length > 0) invalid();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value")
      || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) invalid();
  const length = lengthDescriptor.value;
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== length + 1 || !names.includes("length")) invalid();
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
    Object.defineProperty(result, key, {
      value: data(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true,
    });
  }
  return Object.freeze(result);
}
function data(value, depth = 0) {
  if (depth > 12) invalid();
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object" || isProxy(value)) invalid();
  if (Array.isArray(value)) return dataArray(value, depth);
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null)
      || Object.getOwnPropertySymbols(value).length > 0) invalid();
  const result = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    Object.defineProperty(result, key, {
      value: data(own(value, key), depth + 1), enumerable: true, writable: true, configurable: true,
    });
  }
  return Object.freeze(result);
}
function numberOwn(object, key) {
  const value = own(object, key);
  if (!Number.isFinite(value)) invalid();
  return Number(value);
}

/**
 * Owner-only workspace discard inspection. All protocol semantics are
 * descriptor-snapshotted at composition time; this platform owner imports no
 * application, export, or transitional-flat module.
 */
export function createOwnerOnlyExportWorkspaceDiscardPreflight(configuration = {}) {
  const workspaceDatabaseBasename = own(configuration, "workspaceDatabaseBasename");
  const maximumWorkspaceBytes = own(configuration, "maximumWorkspaceBytes");
  const readBoundedDirectoryEntries = callable(own(configuration, "readBoundedDirectoryEntries"));
  const isTrustedResourceLimitError = callable(own(configuration, "isTrustedResourceLimitError"));
  const inspectExportWorkspaceDiscardState = callable(own(configuration, "inspectExportWorkspaceDiscardState"));
  const stableJson = callable(own(configuration, "stableJson"));
  const assertValidExportWorkspaceDiscardJournal = callable(own(configuration, "assertValidExportWorkspaceDiscardJournal"));
  const assertValidExportWorkspaceDiscardPreflight = callable(own(configuration, "assertValidExportWorkspaceDiscardPreflight"));
  const journalVersion = own(configuration, "journalVersion");
  const orderVersion = own(configuration, "orderVersion");
  const planVersion = own(configuration, "planVersion");
  const preflightVersion = own(configuration, "preflightVersion");
  const roles = own(configuration, "roles");
  const journalBasename = own(configuration, "journalBasename");
  const markerBasename = own(configuration, "markerBasename");
  const receiptBasename = own(configuration, "receiptBasename");
  const quarantinePrefix = own(configuration, "quarantinePrefix");
  const workspaceLockBasename = own(configuration, "workspaceLockBasename");
  const transactionBasename = own(configuration, "transactionBasename");
  if (typeof workspaceDatabaseBasename !== "string" || workspaceDatabaseBasename.length < 1
      || !Number.isSafeInteger(maximumWorkspaceBytes) || maximumWorkspaceBytes < 1
      || !roles || typeof roles !== "object" || isProxy(roles)) invalid();
  for (const value of [journalVersion, orderVersion, planVersion, preflightVersion, journalBasename,
    markerBasename, receiptBasename, quarantinePrefix, workspaceLockBasename, transactionBasename]) {
    if (typeof value !== "string" || value.length < 1 || value.length > 256) invalid();
  }
  const EXPORT_WORKSPACE_DISCARD_ROLES = Object.freeze({
    sqliteJournal: own(roles, "sqliteJournal"), sqliteWal: own(roles, "sqliteWal"),
    sqliteShm: own(roles, "sqliteShm"), database: own(roles, "database"),
  });
  if (Object.values(EXPORT_WORKSPACE_DISCARD_ROLES).some((value) => typeof value !== "string" || value.length < 1)) invalid();

const WORKSPACE_LOCK_BASENAME = workspaceLockBasename;
const TRANSACTION_BASENAME = transactionBasename;
const SIDECARS = Object.freeze([
  [`${workspaceDatabaseBasename}-journal`, EXPORT_WORKSPACE_DISCARD_ROLES.sqliteJournal],
  [`${workspaceDatabaseBasename}-wal`, EXPORT_WORKSPACE_DISCARD_ROLES.sqliteWal],
  [`${workspaceDatabaseBasename}-shm`, EXPORT_WORKSPACE_DISCARD_ROLES.sqliteShm],
]);
const SAFE_CODES = new Set([
  "workspace_required", "directory", "directory_changed", "workspace_entries", "active_control",
  "workspace_state", "manifest_state", "chunks_present", "artifact_missing", "artifact_type",
  "artifact_owner", "artifact_permissions", "artifact_links", "artifact_size", "artifact_changed",
  "artifact_read",
]);

const trustedErrors = new WeakSet();
class ExportWorkspaceDiscardError extends Error {
  constructor(code) {
    if (!SAFE_CODES.has(code)) throw new TypeError("Unknown workspace-discard code");
    super(`Local export workspace discard preflight failed (${code})`);
    this.name = "ExportWorkspaceDiscardError";
    this.code = `export_workspace_discard_${code}`;
    if (new.target === ExportWorkspaceDiscardError) trustedErrors.add(this);
  }
}

function isTrustedDiscardError(error) {
  return Boolean(error && trustedErrors.has(error)
    && Object.getPrototypeOf(error) === ExportWorkspaceDiscardError.prototype);
}
function isTrustedResourceLimit(error) {
  try { return Boolean(isTrustedResourceLimitError(error)); } catch { return false; }
}
function fail(code) { throw new ExportWorkspaceDiscardError(code); }

function base32(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function token(domain, subject, bytes) {
  return base32(createHash("sha256").update(domain).update("\0").update(subject).digest().subarray(0, bytes));
}

function commitmentToken(domain, planToken, subject) {
  return base32(createHmac("sha256", planToken)
    .update(domain).update("\0").update(stableJson(subject)).digest());
}

function workspaceDiscardEvidenceToken(planToken, role, evidence) {
  if (typeof planToken !== "string" || typeof role !== "string") invalid();
  const safe = data(evidence);
  return commitmentToken("app-usagemonitor/export-workspace-discard-artifact-evidence/v1", planToken, {
    role,
    device: safe.device,
    inode: safe.inode,
    linkCount: safe.linkCount,
    byteSize: safe.byteSize,
    digest: safe.digest,
  });
}

function workspaceDiscardDirectoryIdentityToken(planToken, directory) {
  if (typeof planToken !== "string") invalid();
  plain(directory);
  const stats = plain(own(directory, "stats"));
  const parent = plain(own(directory, "parent"));
  const parentStats = plain(own(parent, "stats"));
  return commitmentToken("app-usagemonitor/export-workspace-discard-directory-identity/v1", planToken, {
    device: numberOwn(stats, "dev"),
    inode: numberOwn(stats, "ino"),
    parentDevice: numberOwn(parentStats, "dev"),
    parentInode: numberOwn(parentStats, "ino"),
  });
}

function workspaceDiscardConfirmationToken(planToken) {
  if (typeof planToken !== "string") invalid();
  return token("app-usagemonitor/export-workspace-discard-confirmation/v1", planToken, 10).slice(0, 16);
}

function assertOwnerDirectory(stats) {
  if (!stats.isDirectory() || stats.isSymbolicLink()
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) fail("directory");
}

async function inspectDirectory(path) {
  const requested = resolve(path);
  if (requested === parse(requested).root) fail("directory");
  try {
    const stats = await lstat(requested);
    assertOwnerDirectory(stats);
    const canonical = await realpath(requested);
    const parentPath = dirname(canonical);
    const parentStats = await lstat(parentPath);
    assertOwnerDirectory(parentStats);
    return {
      path: canonical,
      stats,
      parent: { path: parentPath, stats: parentStats },
      entries: await readBoundedDirectoryEntries(canonical, { sort: true }),
    };
  } catch (error) {
    if (isTrustedDiscardError(error)) throw error;
    if (isTrustedResourceLimit(error)) throw error;
    fail("directory");
  }
}

function assertOwnerFile(stats, maximumBytes) {
  if (!stats.isFile() || stats.isSymbolicLink()) fail("artifact_type");
  if (stats.nlink !== 1) fail("artifact_links");
  if (!Number.isSafeInteger(stats.size) || stats.size < 1 || stats.size > maximumBytes) fail("artifact_size");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) fail("artifact_owner");
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) fail("artifact_permissions");
}

async function inspectFile(path, maximumBytes) {
  let before;
  try { before = await lstat(path); } catch { fail("artifact_missing"); }
  assertOwnerFile(before, maximumBytes);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    assertOwnerFile(opened, maximumBytes);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail("artifact_changed");
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - position), position);
      if (bytesRead < 1) fail("artifact_changed");
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
        || after.mtimeMs !== opened.mtimeMs || after.nlink !== opened.nlink) fail("artifact_changed");
    return {
      device: Number(after.dev), inode: Number(after.ino), linkCount: Number(after.nlink), byteSize: Number(after.size),
      modifiedMs: Math.trunc(after.mtimeMs), digest: digest.digest("hex"),
    };
  } catch (error) {
    if (isTrustedDiscardError(error)) throw error;
    fail("artifact_read");
  } finally { await handle?.close().catch(() => {}); }
}

function evidenceSubject(directory, eligibility, inventory) {
  return stableJson({
    directory: {
      device: Number(directory.stats.dev), inode: Number(directory.stats.ino),
      parentDevice: Number(directory.parent.stats.dev), parentInode: Number(directory.parent.stats.ino),
    },
    eligibility,
    inventory: inventory.map((row) => ({
      role: row.role,
      device: row.evidence.device,
      inode: row.evidence.inode,
      linkCount: row.evidence.linkCount,
      byteSize: row.evidence.byteSize,
      digest: row.evidence.digest,
    })),
  });
}

async function assertStable(directory) {
  try {
    const current = await lstat(directory.path);
    const parent = await lstat(directory.parent.path);
    assertOwnerDirectory(current);
    assertOwnerDirectory(parent);
    if (current.dev !== directory.stats.dev || current.ino !== directory.stats.ino
        || parent.dev !== directory.parent.stats.dev || parent.ino !== directory.parent.stats.ino
        || stableJson(await readBoundedDirectoryEntries(directory.path, { sort: true }))
          !== stableJson(directory.entries)) fail("directory_changed");
  } catch (error) {
    if (isTrustedDiscardError(error)) throw error;
    if (isTrustedResourceLimit(error)) throw error;
    fail("directory_changed");
  }
}

async function buildUnsafe({ workspaceDirectory, allowLeaseControls = false, allowCommittedControls = false }) {
  if (!workspaceDirectory) fail("workspace_required");
  const directory = await inspectDirectory(workspaceDirectory);
  const activeControls = [
    journalBasename,
    markerBasename,
    receiptBasename,
    TRANSACTION_BASENAME,
  ];
  const forbiddenControls = allowCommittedControls
    ? activeControls.filter((name) => ![
        journalBasename,
        markerBasename,
      ].includes(name))
    : activeControls;
  if (forbiddenControls.some((name) => directory.entries.includes(name))
      || directory.entries.some((name) => name.startsWith(quarantinePrefix))) fail("active_control");
  const allowed = new Set([
    workspaceDatabaseBasename,
    ...SIDECARS.map(([name]) => name),
    ...(allowLeaseControls ? [WORKSPACE_LOCK_BASENAME] : []),
    ...(allowCommittedControls ? [
      journalBasename,
      markerBasename,
    ] : []),
  ]);
  if (!directory.entries.includes(workspaceDatabaseBasename)
      || directory.entries.some((name) => !allowed.has(name))) fail("workspace_entries");

  let databaseStats;
  try { databaseStats = await lstat(join(directory.path, workspaceDatabaseBasename)); }
  catch { fail("artifact_missing"); }
  assertOwnerFile(databaseStats, maximumWorkspaceBytes);
  let state;
  try {
    state = data(await inspectExportWorkspaceDiscardState(Object.freeze({ directory: directory.path })));
    if (typeof state.hasManifestState !== "boolean" || typeof state.poisoned !== "boolean"
        || typeof state.scanComplete !== "boolean" || !Number.isSafeInteger(state.chunkCount)
        || state.chunkCount < 0) invalid();
  }
  catch { fail("workspace_state"); }
  if (state.hasManifestState) fail("manifest_state");
  if (state.chunkCount !== 0) fail("chunks_present");
  if (!state.poisoned && state.scanComplete) fail("workspace_state");
  const eligibility = state.poisoned ? "poisoned" : "scan_incomplete";
  const definitions = [
    ...SIDECARS.filter(([name]) => directory.entries.includes(name)),
    [workspaceDatabaseBasename, EXPORT_WORKSPACE_DISCARD_ROLES.database],
  ];
  const internalInventory = [];
  for (const [ordinal, [name, role]] of definitions.entries()) {
    const evidence = await inspectFile(join(directory.path, name), maximumWorkspaceBytes);
    internalInventory.push({ ordinal, role, byteSize: evidence.byteSize, evidence });
  }
  const totalBytes = internalInventory.reduce((sum, row) => sum + row.byteSize, 0);
  const planToken = token(
    "app-usagemonitor/export-workspace-discard-plan/v1",
    evidenceSubject(directory, eligibility, internalInventory),
    13,
  ).slice(0, 20);
  const inventory = internalInventory.map(({ ordinal, role, byteSize, evidence }) => ({
    ordinal,
    role,
    byteSize,
    evidenceToken: workspaceDiscardEvidenceToken(planToken, role, evidence),
  }));
  const journal = {
    schemaVersion: journalVersion,
    planVersion,
    discardOrderVersion: orderVersion,
    artifactClass: "incomplete_or_poisoned_export_workspace",
    state: "prepared",
    planToken,
    directoryIdentityToken: workspaceDiscardDirectoryIdentityToken(planToken, directory),
    eligibility,
    inventoryCounts: {
      sqliteSidecars: inventory.length - 1,
      workspaceDatabase: 1,
      totalFiles: inventory.length,
      totalBytes,
    },
    inventory,
    transportReady: false,
  };
  assertValidExportWorkspaceDiscardJournal(journal);
  const summary = {
    schemaVersion: preflightVersion,
    planVersion,
    artifactClass: "incomplete_or_poisoned_export_workspace",
    readiness: "ready",
    eligibility,
    fileCounts: {
      sqliteSidecars: inventory.length - 1,
      workspaceDatabase: 1,
      totalFiles: inventory.length,
    },
    byteCounts: { workspaceBytes: totalBytes, totalBytes },
    confirmationRequired: true,
    confirmationToken: workspaceDiscardConfirmationToken(planToken),
    sourceLogsPreserved: true,
    independentOutputPreserved: true,
    networkActivity: "absent",
    secureErasureClaimed: false,
    transportReady: false,
  };
  assertValidExportWorkspaceDiscardPreflight(summary);
  await assertStable(directory);
  return { summary, journal, internalInventory, directory };
}

async function buildLocalExportWorkspaceDiscardPlan(options = undefined) {
  let safe;
  try {
    safe = exactOptions(options, ["workspaceDirectory", "allowLeaseControls", "allowCommittedControls"]);
    if (typeof safe.workspaceDirectory !== "string" || safe.workspaceDirectory.length < 1
        || (safe.allowLeaseControls !== undefined && typeof safe.allowLeaseControls !== "boolean")
        || (safe.allowCommittedControls !== undefined && typeof safe.allowCommittedControls !== "boolean")) invalid();
  } catch { fail("workspace_required"); }
  try { return await buildUnsafe(safe); }
  catch (error) {
    if (isTrustedDiscardError(error) || isTrustedResourceLimit(error)) throw error;
    fail("workspace_state");
  }
}

async function planLocalExportWorkspaceDiscard(options = undefined) {
  const built = await buildLocalExportWorkspaceDiscardPlan(options);
  return data(built.summary);
}

  return Object.freeze({
    ExportWorkspaceDiscardError,
    isTrustedDiscardError,
    buildLocalExportWorkspaceDiscardPlan,
    planLocalExportWorkspaceDiscard,
    workspaceDiscardEvidenceToken,
    workspaceDiscardDirectoryIdentityToken,
    workspaceDiscardConfirmationToken,
  });
}
