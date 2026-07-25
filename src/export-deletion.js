import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
import {
  assertValidExportDeletionJournal,
  assertValidExportDeletionPreflight,
  EXPORT_DELETION_INVENTORY_ROLES,
  EXPORT_DELETION_JOURNAL_VERSION,
  EXPORT_DELETION_ORDER_VERSION,
  EXPORT_DELETION_PLAN_VERSION,
  EXPORT_DELETION_PREFLIGHT_VERSION,
} from "./export-deletion-schema.js";
import { DEFAULT_EXPORT_RESOURCE_LIMITS } from "./export-resource-policy.js";
import {
  EXPORT_SET_MANIFEST_BASENAME,
  EXPORT_SET_MANIFEST_RECEIPT_BASENAME,
} from "./export-set-materializer.js";
import { assertValidExportSetManifest, exportSetChunkBasenames } from "./export-set-schema.js";
import { verifyLocalExportSet } from "./export-set-verifier.js";
import {
  EXPORT_WORKSPACE_DATABASE_BASENAME,
  openExportWorkspace,
} from "./export-workspace.js";
import { stableJson } from "./storage.js";

export const EXPORT_DELETION_JOURNAL_BASENAME = ".app-usagemonitor-deletion-journal.json";
export const EXPORT_DELETION_COMMIT_MARKER_BASENAME = ".app-usagemonitor-deletion-commit.json";
export const EXPORT_DELETION_RECEIPT_BASENAME = "local-export-deletion-receipt.json";

const WORKSPACE_LOCK_BASENAME = ".app-usagemonitor-export-workspace.lock";
const DESTINATION_LOCK_BASENAME = ".app-usagemonitor-export.lock";
const DESTINATION_TRANSACTION_BASENAME = ".app-usagemonitor-export-transactions";
const DELETION_QUARANTINE_PREFIX = ".app-usagemonitor-deletion-quarantine-";
const WORKSPACE_SIDECARS = Object.freeze([
  [`${EXPORT_WORKSPACE_DATABASE_BASENAME}-journal`, EXPORT_DELETION_INVENTORY_ROLES.workspaceSqliteJournal],
  [`${EXPORT_WORKSPACE_DATABASE_BASENAME}-wal`, EXPORT_DELETION_INVENTORY_ROLES.workspaceSqliteWal],
  [`${EXPORT_WORKSPACE_DATABASE_BASENAME}-shm`, EXPORT_DELETION_INVENTORY_ROLES.workspaceSqliteShm],
]);
const SAFE_CODES = new Set([
  "paths_required", "directory", "directory_relation", "directory_changed", "active_control",
  "workspace_entries", "workspace_state", "set_state", "binding", "artifact_missing",
  "artifact_type", "artifact_owner", "artifact_permissions", "artifact_links", "artifact_size",
  "artifact_changed", "artifact_read",
]);

export class ExportDeletionError extends Error {
  constructor(code) {
    if (!SAFE_CODES.has(code)) throw new TypeError("Unknown export-deletion code");
    super(`Local export deletion preflight failed (${code})`);
    this.name = "ExportDeletionError";
    this.code = `export_deletion_${code}`;
  }
}

function fail(code) {
  throw new ExportDeletionError(code);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameStats(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.nlink === right.nlink;
}

function assertOwnerDirectory(stats) {
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail("directory");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) fail("directory");
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) fail("directory");
}

async function inspectDirectory(path) {
  const requested = resolve(path);
  if (requested === parse(requested).root) fail("directory");
  let stats;
  let canonical;
  try {
    stats = await lstat(requested);
    assertOwnerDirectory(stats);
    canonical = await realpath(requested);
  } catch (error) {
    if (error instanceof ExportDeletionError) throw error;
    fail("directory");
  }
  const parentPath = dirname(canonical);
  let parentStats;
  try {
    parentStats = await lstat(parentPath);
    assertOwnerDirectory(parentStats);
  } catch (error) {
    if (error instanceof ExportDeletionError) throw error;
    fail("directory");
  }
  return {
    path: canonical,
    stats,
    parent: { path: parentPath, stats: parentStats },
    entries: (await readdir(canonical)).sort(),
  };
}

function assertSeparateDirectories(workspace, output) {
  if (workspace.path === output.path
      || workspace.path.startsWith(`${output.path}${sep}`)
      || output.path.startsWith(`${workspace.path}${sep}`)) fail("directory_relation");
}

function assertArtifactStats(stats, maximumBytes) {
  if (!stats.isFile() || stats.isSymbolicLink()) fail("artifact_type");
  if (stats.nlink !== 1) fail("artifact_links");
  if (!Number.isSafeInteger(stats.size) || stats.size < 1 || stats.size > maximumBytes) fail("artifact_size");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) fail("artifact_owner");
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) fail("artifact_permissions");
}

async function hashOwnerOnlyFile(path, maximumBytes) {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") fail("artifact_missing");
    fail("artifact_read");
  }
  assertArtifactStats(before, maximumBytes);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    assertArtifactStats(opened, maximumBytes);
    if (!sameStats(before, opened)) fail("artifact_changed");
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
    if (!sameStats(opened, after)) fail("artifact_changed");
    return {
      device: Number(after.dev),
      inode: Number(after.ino),
      fileType: "regular_file",
      linkCount: 1,
      byteSize: Number(after.size),
      sha256: digest.digest("hex"),
    };
  } catch (error) {
    if (error instanceof ExportDeletionError) throw error;
    fail("artifact_read");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readCanonicalManifest(path) {
  const evidence = await hashOwnerOnlyFile(path, DEFAULT_EXPORT_RESOURCE_LIMITS.maximumManifestBytes);
  let bytes;
  try {
    bytes = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const text = await bytes.readFile("utf8");
    const manifest = JSON.parse(text);
    if (stableJson(manifest) !== text) fail("set_state");
    assertValidExportSetManifest(manifest);
    if (sha256(text) !== evidence.sha256 || Buffer.byteLength(text) !== evidence.byteSize) fail("artifact_changed");
    return { manifest, text, evidence };
  } catch (error) {
    if (error instanceof ExportDeletionError) throw error;
    fail("set_state");
  } finally {
    await bytes?.close().catch(() => {});
  }
}

function expectedChunkMetadata(manifest, entry) {
  return {
    index: entry.index,
    bundleId: entry.bundleId,
    participantId: manifest.participantId,
    createdAt: manifest.createdAt,
    coveredAt: manifest.coveredAt,
    bundleSha256: entry.bundleSha256,
    bundleBytes: entry.bundleBytes,
    ...(manifest.schemaVersion.endsWith("v0.2") ? {
      contentEncoding: entry.contentEncoding,
      compressionProfile: entry.compressionProfile,
      artifactSha256: entry.artifactSha256,
      artifactBytes: entry.artifactBytes,
    } : {}),
    receiptSha256: entry.receiptSha256,
    receiptBytes: entry.receiptBytes,
    recordStart: entry.recordStart,
    recordEndExclusive: entry.recordEndExclusive,
    recordCounts: entry.recordCounts,
  };
}

function assertWorkspaceBinding(descriptor, chunks, manifestState, manifest, manifestText) {
  const descriptorView = {
    compatibility: descriptor.compatibility,
    participantId: descriptor.participantId,
    createdAt: descriptor.createdAt,
    coveredAt: descriptor.coveredAt,
    sourceProviders: descriptor.sourceProviders,
    clientPlatform: descriptor.clientPlatform,
    sourcePlan: {
      sha256: descriptor.sourcePlan.sourcePlanSha256,
      sourceFiles: descriptor.sourcePlan.sourceFiles,
      sourceBytes: descriptor.sourcePlan.sourceBytes,
    },
  };
  const manifestView = {
    compatibility: manifest.compatibility,
    participantId: manifest.participantId,
    createdAt: manifest.createdAt,
    coveredAt: manifest.coveredAt,
    sourceProviders: manifest.sourceProviders,
    clientPlatform: manifest.clientPlatform,
    sourcePlan: manifest.sourcePlan,
  };
  if (stableJson(descriptorView) !== stableJson(manifestView)) fail("binding");
  const expectedManifestState = {
    exportSetId: manifest.exportSetId,
    manifestSha256: sha256(manifestText),
    manifestBytes: Buffer.byteLength(manifestText),
    chunkCount: manifest.chunks.length,
  };
  if (stableJson(manifestState) !== stableJson(expectedManifestState)
      || chunks.length !== manifest.chunks.length) fail("binding");
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.index !== index || chunk.status !== "verified"
        || stableJson(chunk.metadata) !== stableJson(expectedChunkMetadata(manifest, manifest.chunks[index]))) {
      fail("binding");
    }
  }
}

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

function confirmationToken(planSha256) {
  return base32(createHash("sha256")
    .update("app-usagemonitor/export-deletion-confirmation/v1\0")
    .update(planSha256)
    .digest().subarray(0, 10));
}

async function assertDirectoryStable(directory) {
  const after = await lstat(directory.path);
  assertOwnerDirectory(after);
  if (after.dev !== directory.stats.dev || after.ino !== directory.stats.ino) fail("directory_changed");
  const parentAfter = await lstat(directory.parent.path);
  assertOwnerDirectory(parentAfter);
  if (parentAfter.dev !== directory.parent.stats.dev || parentAfter.ino !== directory.parent.stats.ino) {
    fail("directory_changed");
  }
  const entries = (await readdir(directory.path)).sort();
  if (stableJson(entries) !== stableJson(directory.entries)) fail("directory_changed");
}

export async function buildLocalExportDeletionPlan({
  workspaceDirectory,
  outputDirectory,
  allowLeaseControls = false,
} = {}) {
  if (!workspaceDirectory || !outputDirectory) fail("paths_required");
  const workspaceDirectoryInfo = await inspectDirectory(workspaceDirectory);
  const outputDirectoryInfo = await inspectDirectory(outputDirectory);
  assertSeparateDirectories(workspaceDirectoryInfo, outputDirectoryInfo);

  const forbiddenOutputControls = [
    DESTINATION_TRANSACTION_BASENAME,
    EXPORT_DELETION_JOURNAL_BASENAME,
    EXPORT_DELETION_COMMIT_MARKER_BASENAME,
    EXPORT_DELETION_RECEIPT_BASENAME,
    ...(!allowLeaseControls ? [DESTINATION_LOCK_BASENAME] : []),
  ];
  if (forbiddenOutputControls.some((name) => outputDirectoryInfo.entries.includes(name))
      || outputDirectoryInfo.entries.some((name) => name.startsWith(DELETION_QUARANTINE_PREFIX))) {
    fail("active_control");
  }

  const allowedWorkspace = new Set([
    EXPORT_WORKSPACE_DATABASE_BASENAME,
    ...WORKSPACE_SIDECARS.map(([name]) => name),
    ...(allowLeaseControls ? [WORKSPACE_LOCK_BASENAME] : []),
  ]);
  if (workspaceDirectoryInfo.entries.some((name) => !allowedWorkspace.has(name))
      || !workspaceDirectoryInfo.entries.includes(EXPORT_WORKSPACE_DATABASE_BASENAME)
      || (!allowLeaseControls && workspaceDirectoryInfo.entries.includes(WORKSPACE_LOCK_BASENAME))) {
    fail("workspace_entries");
  }

  await verifyLocalExportSet({ directory: outputDirectoryInfo.path });
  const manifestPath = join(outputDirectoryInfo.path, EXPORT_SET_MANIFEST_BASENAME);
  const { manifest, text: manifestText, evidence: manifestEvidence } = await readCanonicalManifest(manifestPath);

  let workspace;
  let descriptor;
  let chunks;
  let manifestState;
  try {
    workspace = await openExportWorkspace({ directory: workspaceDirectoryInfo.path });
    if (!workspace.isScanComplete() || workspace.isPoisoned()) fail("workspace_state");
    descriptor = workspace.getDescriptor();
    chunks = workspace.chunks();
    manifestState = workspace.manifestState();
  } finally {
    workspace?.close();
  }
  assertWorkspaceBinding(descriptor, chunks, manifestState, manifest, manifestText);

  const inventoryDefinitions = [
    {
      role: EXPORT_DELETION_INVENTORY_ROLES.setManifest,
      chunkIndex: null,
      path: manifestPath,
      maximumBytes: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumManifestBytes,
      evidence: manifestEvidence,
      scope: "output",
    },
    ...manifest.chunks.map((entry) => {
      const names = exportSetChunkBasenames(entry.index, manifest.schemaVersion);
      return {
        role: EXPORT_DELETION_INVENTORY_ROLES.chunkArtifact,
        chunkIndex: entry.index,
        path: join(outputDirectoryInfo.path, names.bundle),
        maximumBytes: manifest.schemaVersion.endsWith("v0.2") ? entry.artifactBytes : entry.bundleBytes,
        scope: "output",
      };
    }),
    ...WORKSPACE_SIDECARS
      .filter(([name]) => workspaceDirectoryInfo.entries.includes(name))
      .map(([name, role]) => ({
        role,
        chunkIndex: null,
        path: join(workspaceDirectoryInfo.path, name),
        maximumBytes: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumWorkspaceBytes,
        scope: "workspace",
      })),
    {
      role: EXPORT_DELETION_INVENTORY_ROLES.workspaceDatabase,
      chunkIndex: null,
      path: join(workspaceDirectoryInfo.path, EXPORT_WORKSPACE_DATABASE_BASENAME),
      maximumBytes: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumWorkspaceBytes,
      scope: "workspace",
    },
    ...manifest.chunks.map((entry) => {
      const names = exportSetChunkBasenames(entry.index, manifest.schemaVersion);
      return {
        role: EXPORT_DELETION_INVENTORY_ROLES.chunkReceipt,
        chunkIndex: entry.index,
        path: join(outputDirectoryInfo.path, names.receipt),
        maximumBytes: 1024 * 1024,
        scope: "output",
      };
    }),
    {
      role: EXPORT_DELETION_INVENTORY_ROLES.setManifestReceipt,
      chunkIndex: null,
      path: join(outputDirectoryInfo.path, EXPORT_SET_MANIFEST_RECEIPT_BASENAME),
      maximumBytes: 1024 * 1024,
      scope: "output",
    },
  ];

  const inventory = [];
  const paths = [];
  for (const [ordinal, definition] of inventoryDefinitions.entries()) {
    const evidence = definition.evidence ?? await hashOwnerOnlyFile(definition.path, definition.maximumBytes);
    inventory.push({
      ordinal,
      role: definition.role,
      chunkIndex: definition.chunkIndex,
      ...evidence,
    });
    paths.push({ path: definition.path, scope: definition.scope });
  }

  const exportSetBytes = inventoryDefinitions.reduce((sum, definition, index) =>
    sum + (definition.scope === "output" ? inventory[index].byteSize : 0), 0);
  const workspaceBytes = inventoryDefinitions.reduce((sum, definition, index) =>
    sum + (definition.scope === "workspace" ? inventory[index].byteSize : 0), 0);
  const chunkCount = manifest.chunks.length;
  const journalCore = {
    schemaVersion: EXPORT_DELETION_JOURNAL_VERSION,
    planVersion: EXPORT_DELETION_PLAN_VERSION,
    deletionOrderVersion: EXPORT_DELETION_ORDER_VERSION,
    exportSetManifestVersion: manifest.schemaVersion,
    directoryIdentities: {
      workspace: {
        device: Number(workspaceDirectoryInfo.stats.dev),
        inode: Number(workspaceDirectoryInfo.stats.ino),
      },
      output: {
        device: Number(outputDirectoryInfo.stats.dev),
        inode: Number(outputDirectoryInfo.stats.ino),
      },
    },
    state: "prepared",
    inventoryCounts: {
      chunkArtifacts: chunkCount,
      chunkReceipts: chunkCount,
      controlFiles: 2,
      workspaceFiles: inventory.filter((row) => row.role.startsWith("workspace_")).length,
      totalFiles: inventory.length,
      totalBytes: exportSetBytes + workspaceBytes,
    },
    inventory,
    transportReady: false,
  };
  const planSha256 = sha256(stableJson({
    domain: "app-usagemonitor/export-deletion-plan/v1",
    journal: journalCore,
  }));
  const journal = { ...journalCore, planSha256 };
  assertValidExportDeletionJournal(journal);
  const summary = {
    schemaVersion: EXPORT_DELETION_PREFLIGHT_VERSION,
    planVersion: EXPORT_DELETION_PLAN_VERSION,
    artifactClass: "complete_local_export_set",
    readiness: "ready",
    fileCounts: {
      chunkArtifacts: chunkCount,
      chunkReceipts: chunkCount,
      controlFiles: 2,
      workspaceFiles: journal.inventoryCounts.workspaceFiles,
      totalFiles: inventory.length,
    },
    byteCounts: { exportSetBytes, workspaceBytes, totalBytes: exportSetBytes + workspaceBytes },
    confirmationRequired: true,
    confirmationToken: confirmationToken(planSha256),
    networkActivity: "absent",
    secureErasureClaimed: false,
    transportReady: false,
  };
  assertValidExportDeletionPreflight(summary);
  await assertDirectoryStable(workspaceDirectoryInfo);
  await assertDirectoryStable(outputDirectoryInfo);
  return {
    summary,
    journal,
    paths,
    directories: {
      workspace: workspaceDirectoryInfo.path,
      output: outputDirectoryInfo.path,
    },
  };
}

export async function planLocalExportDeletion(options = {}) {
  return (await buildLocalExportDeletionPlan(options)).summary;
}
