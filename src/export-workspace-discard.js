import { createHash, createHmac } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { DEFAULT_EXPORT_RESOURCE_LIMITS } from "./export-resource-policy.js";
import {
  EXPORT_WORKSPACE_DATABASE_BASENAME,
  inspectExportWorkspaceDiscardState,
} from "./export-workspace.js";
import {
  assertValidExportWorkspaceDiscardJournal,
  assertValidExportWorkspaceDiscardPreflight,
  EXPORT_WORKSPACE_DISCARD_JOURNAL_VERSION,
  EXPORT_WORKSPACE_DISCARD_ORDER_VERSION,
  EXPORT_WORKSPACE_DISCARD_PLAN_VERSION,
  EXPORT_WORKSPACE_DISCARD_PREFLIGHT_VERSION,
  EXPORT_WORKSPACE_DISCARD_ROLES,
} from "./export-workspace-discard-schema.js";
import { stableJson } from "./storage.js";

export const EXPORT_WORKSPACE_DISCARD_JOURNAL_BASENAME = ".app-usagemonitor-workspace-discard-journal.json";
export const EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_BASENAME = ".app-usagemonitor-workspace-discard-commit.json";
export const EXPORT_WORKSPACE_DISCARD_RECEIPT_BASENAME = "workspace-discard-receipt.json";
export const EXPORT_WORKSPACE_DISCARD_QUARANTINE_PREFIX = ".app-usagemonitor-workspace-discard-quarantine-";

const WORKSPACE_LOCK_BASENAME = ".app-usagemonitor-export-workspace.lock";
const TRANSACTION_BASENAME = ".app-usagemonitor-export-transactions";
const SIDECARS = Object.freeze([
  [`${EXPORT_WORKSPACE_DATABASE_BASENAME}-journal`, EXPORT_WORKSPACE_DISCARD_ROLES.sqliteJournal],
  [`${EXPORT_WORKSPACE_DATABASE_BASENAME}-wal`, EXPORT_WORKSPACE_DISCARD_ROLES.sqliteWal],
  [`${EXPORT_WORKSPACE_DATABASE_BASENAME}-shm`, EXPORT_WORKSPACE_DISCARD_ROLES.sqliteShm],
]);
const SAFE_CODES = new Set([
  "workspace_required", "directory", "directory_changed", "workspace_entries", "active_control",
  "workspace_state", "manifest_state", "chunks_present", "artifact_missing", "artifact_type",
  "artifact_owner", "artifact_permissions", "artifact_links", "artifact_size", "artifact_changed",
  "artifact_read",
]);

export class ExportWorkspaceDiscardError extends Error {
  constructor(code) {
    if (!SAFE_CODES.has(code)) throw new TypeError("Unknown workspace-discard code");
    super(`Local export workspace discard preflight failed (${code})`);
    this.name = "ExportWorkspaceDiscardError";
    this.code = `export_workspace_discard_${code}`;
  }
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

export function workspaceDiscardEvidenceToken(planToken, role, evidence) {
  return commitmentToken("app-usagemonitor/export-workspace-discard-artifact-evidence/v1", planToken, {
    role,
    device: Number(evidence.device),
    inode: Number(evidence.inode),
    linkCount: Number(evidence.linkCount),
    byteSize: Number(evidence.byteSize),
    digest: evidence.digest,
  });
}

export function workspaceDiscardDirectoryIdentityToken(planToken, directory) {
  return commitmentToken("app-usagemonitor/export-workspace-discard-directory-identity/v1", planToken, {
    device: Number(directory.stats.dev),
    inode: Number(directory.stats.ino),
    parentDevice: Number(directory.parent.stats.dev),
    parentInode: Number(directory.parent.stats.ino),
  });
}

export function workspaceDiscardConfirmationToken(planToken) {
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
    return { path: canonical, stats, parent: { path: parentPath, stats: parentStats }, entries: (await readdir(canonical)).sort() };
  } catch (error) {
    if (error instanceof ExportWorkspaceDiscardError) throw error;
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
    if (error instanceof ExportWorkspaceDiscardError) throw error;
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
        || stableJson((await readdir(directory.path)).sort()) !== stableJson(directory.entries)) fail("directory_changed");
  } catch (error) {
    if (error instanceof ExportWorkspaceDiscardError) throw error;
    fail("directory_changed");
  }
}

export async function buildLocalExportWorkspaceDiscardPlan({
  workspaceDirectory,
  allowLeaseControls = false,
  allowCommittedControls = false,
} = {}) {
  if (!workspaceDirectory) fail("workspace_required");
  const directory = await inspectDirectory(workspaceDirectory);
  const activeControls = [
    EXPORT_WORKSPACE_DISCARD_JOURNAL_BASENAME,
    EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_BASENAME,
    EXPORT_WORKSPACE_DISCARD_RECEIPT_BASENAME,
    TRANSACTION_BASENAME,
  ];
  const forbiddenControls = allowCommittedControls
    ? activeControls.filter((name) => ![
        EXPORT_WORKSPACE_DISCARD_JOURNAL_BASENAME,
        EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_BASENAME,
      ].includes(name))
    : activeControls;
  if (forbiddenControls.some((name) => directory.entries.includes(name))
      || directory.entries.some((name) => name.startsWith(EXPORT_WORKSPACE_DISCARD_QUARANTINE_PREFIX))) fail("active_control");
  const allowed = new Set([
    EXPORT_WORKSPACE_DATABASE_BASENAME,
    ...SIDECARS.map(([name]) => name),
    ...(allowLeaseControls ? [WORKSPACE_LOCK_BASENAME] : []),
    ...(allowCommittedControls ? [
      EXPORT_WORKSPACE_DISCARD_JOURNAL_BASENAME,
      EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_BASENAME,
    ] : []),
  ]);
  if (!directory.entries.includes(EXPORT_WORKSPACE_DATABASE_BASENAME)
      || directory.entries.some((name) => !allowed.has(name))) fail("workspace_entries");

  let databaseStats;
  try { databaseStats = await lstat(join(directory.path, EXPORT_WORKSPACE_DATABASE_BASENAME)); }
  catch { fail("artifact_missing"); }
  assertOwnerFile(databaseStats, DEFAULT_EXPORT_RESOURCE_LIMITS.maximumWorkspaceBytes);
  let state;
  try { state = await inspectExportWorkspaceDiscardState({ directory: directory.path }); }
  catch { fail("workspace_state"); }
  if (state.hasManifestState) fail("manifest_state");
  if (state.chunkCount !== 0) fail("chunks_present");
  if (!state.poisoned && state.scanComplete) fail("workspace_state");
  const eligibility = state.poisoned ? "poisoned" : "scan_incomplete";
  const definitions = [
    ...SIDECARS.filter(([name]) => directory.entries.includes(name)),
    [EXPORT_WORKSPACE_DATABASE_BASENAME, EXPORT_WORKSPACE_DISCARD_ROLES.database],
  ];
  const internalInventory = [];
  for (const [ordinal, [name, role]] of definitions.entries()) {
    const evidence = await inspectFile(join(directory.path, name), DEFAULT_EXPORT_RESOURCE_LIMITS.maximumWorkspaceBytes);
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
    schemaVersion: EXPORT_WORKSPACE_DISCARD_JOURNAL_VERSION,
    planVersion: EXPORT_WORKSPACE_DISCARD_PLAN_VERSION,
    discardOrderVersion: EXPORT_WORKSPACE_DISCARD_ORDER_VERSION,
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
    schemaVersion: EXPORT_WORKSPACE_DISCARD_PREFLIGHT_VERSION,
    planVersion: EXPORT_WORKSPACE_DISCARD_PLAN_VERSION,
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

export async function planLocalExportWorkspaceDiscard(options = {}) {
  return (await buildLocalExportWorkspaceDiscardPlan(options)).summary;
}
