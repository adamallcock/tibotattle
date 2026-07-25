import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  assertValidExportDeletionCommitMarker,
  assertValidExportDeletionJournal,
  assertValidExportDeletionReceipt,
  EXPORT_DELETION_COMMIT_MARKER_VERSION,
  EXPORT_DELETION_CONFIRMATION_TOKEN_PATTERN,
  EXPORT_DELETION_INVENTORY_ROLES,
  EXPORT_DELETION_PLAN_VERSION,
  EXPORT_DELETION_RECEIPT_VERSION,
} from "./export-deletion-schema.js";
import {
  buildLocalExportDeletionPlan,
  EXPORT_DELETION_COMMIT_MARKER_BASENAME,
  EXPORT_DELETION_JOURNAL_BASENAME,
  EXPORT_DELETION_RECEIPT_BASENAME,
  planLocalExportDeletion,
} from "./export-deletion.js";
import {
  EXPORT_SET_MANIFEST_BASENAME,
  EXPORT_SET_MANIFEST_RECEIPT_BASENAME,
} from "./export-set-materializer.js";
import { exportSetChunkBasenames } from "./export-set-schema.js";
import { EXPORT_WORKSPACE_DATABASE_BASENAME } from "./export-workspace.js";
import { withExistingExportWorkspaceLease } from "./export-workspace-lock.js";
import {
  recoverOwnerOnlyPairTransactionsUnderLease,
  stableJson,
  syncDirectory,
  unlinkDurably,
  withExportDestinationLease,
  writeOwnerOnlyNoClobberDurable,
  writeOwnerOnlyPairNoClobberUnderLease,
} from "./storage.js";

const MAX_CONTROL_BYTES = 1024 * 1024;
const DELETION_QUARANTINE_PREFIX = ".app-usagemonitor-deletion-quarantine-";
const JOURNAL_QUARANTINE_BASENAME = `${DELETION_QUARANTINE_PREFIX}journal`;
const MARKER_QUARANTINE_BASENAME = `${DELETION_QUARANTINE_PREFIX}commit`;
const WORKSPACE_LOCK_BASENAME = ".app-usagemonitor-export-workspace.lock";
const DESTINATION_LOCK_BASENAME = ".app-usagemonitor-export.lock";
const DESTINATION_TRANSACTION_BASENAME = ".app-usagemonitor-export-transactions";
const SAFE_CODES = new Set([
  "confirmation", "journal_missing", "journal_pair", "journal_invalid", "commit_invalid",
  "replacement", "receipt_invalid", "path_derivation",
]);

export class ExportDeletionExecutionError extends Error {
  constructor(code) {
    if (!SAFE_CODES.has(code)) throw new TypeError("Unknown export-deletion execution code");
    super(`Local export deletion failed (${code})`);
    this.name = "ExportDeletionExecutionError";
    this.code = `export_deletion_execute_${code}`;
  }
}

function fail(code) {
  throw new ExportDeletionExecutionError(code);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function assertOwnerFile(stats, maximumBytes = Number.MAX_SAFE_INTEGER) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
      || !Number.isSafeInteger(stats.size) || stats.size < 1 || stats.size > maximumBytes
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) fail("replacement");
}

async function readExactFile(path, maximumBytes = Number.MAX_SAFE_INTEGER) {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    fail("replacement");
  }
  assertOwnerFile(before, maximumBytes);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    assertOwnerFile(opened, maximumBytes);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail("replacement");
    const digest = createHash("sha256");
    const chunks = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - position), position);
      if (bytesRead < 1) fail("replacement");
      digest.update(buffer.subarray(0, bytesRead));
      if (opened.size <= MAX_CONTROL_BYTES) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
        || after.mtimeMs !== opened.mtimeMs || after.nlink !== opened.nlink) fail("replacement");
    return {
      stats: after,
      sha256: digest.digest("hex"),
      bytes: opened.size <= MAX_CONTROL_BYTES ? Buffer.concat(chunks) : null,
    };
  } catch (error) {
    if (error instanceof ExportDeletionExecutionError) throw error;
    fail("replacement");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readCanonicalControl(path, label) {
  const artifact = await readExactFile(path, MAX_CONTROL_BYTES);
  if (!artifact) return null;
  try {
    const text = artifact.bytes.toString("utf8");
    const value = JSON.parse(text);
    if (stableJson(value) !== text) fail(label);
    return { ...artifact, text, value };
  } catch (error) {
    if (error instanceof ExportDeletionExecutionError) throw error;
    fail(label);
  }
}

async function readCanonicalControlEither(canonicalPath, quarantinePath, label) {
  const canonical = await readCanonicalControl(canonicalPath, label);
  const quarantined = await readCanonicalControl(quarantinePath, label);
  if (canonical && quarantined) fail(label);
  const artifact = canonical ?? quarantined;
  return artifact ? { ...artifact, path: canonical ? canonicalPath : quarantinePath } : null;
}

function directoryIdentity(stats) {
  return { device: Number(stats.dev), inode: Number(stats.ino) };
}

async function assertDirectoryIdentity(path, expected) {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    fail("replacement");
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()
      || Number(stats.dev) !== expected.device || Number(stats.ino) !== expected.inode
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) fail("replacement");
}

async function assertBoundDirectories(workspaceDirectory, outputDirectory, identities) {
  await assertDirectoryIdentity(workspaceDirectory, identities.workspace);
  await assertDirectoryIdentity(outputDirectory, identities.output);
}

async function assertReceiptOnlyCompletionState(workspaceDirectory, outputDirectory) {
  const workspaceEntries = await readdir(workspaceDirectory);
  if (workspaceEntries.some((name) => name !== WORKSPACE_LOCK_BASENAME)) fail("receipt_invalid");
  const outputEntries = await readdir(outputDirectory);
  const fixedExportArtifact = /^(?:export-set-manifest(?:\.privacy-receipt)?\.json|chunk-\d{6}\.(?:bundle\.json(?:\.gz)?|receipt\.json))$/;
  if (outputEntries.some((name) => fixedExportArtifact.test(name)
      || name === EXPORT_DELETION_JOURNAL_BASENAME
      || name === EXPORT_DELETION_COMMIT_MARKER_BASENAME
      || name === DESTINATION_TRANSACTION_BASENAME
      || name.startsWith(DELETION_QUARANTINE_PREFIX)
      || (name.startsWith(DESTINATION_LOCK_BASENAME) && name !== DESTINATION_LOCK_BASENAME))) {
    fail("receipt_invalid");
  }
}

function evidenceMatches(artifact, expected) {
  const stats = expected.stats ?? expected;
  return Number(artifact.stats.dev) === Number(stats.dev ?? expected.device)
    && Number(artifact.stats.ino) === Number(stats.ino ?? expected.inode)
    && artifact.stats.nlink === Number(stats.nlink ?? expected.linkCount)
    && artifact.stats.size === Number(stats.size ?? expected.byteSize)
    && artifact.sha256 === expected.sha256;
}

function inventoryQuarantinePath(path, row, journal) {
  const token = createHash("sha256")
    .update("app-usagemonitor/export-deletion-quarantine/v1\0")
    .update(journal.planSha256)
    .update("\0")
    .update(String(row.ordinal))
    .digest("hex")
    .slice(0, 24);
  return join(dirname(path), `${DELETION_QUARANTINE_PREFIX}${String(row.ordinal).padStart(4, "0")}-${token}`);
}

async function quarantineThenUnlink(path, expected, quarantinePath, {
  moveFile = rename,
  failpoint = async () => {},
  quarantineStage,
  detail,
} = {}) {
  const quarantined = await readExactFile(quarantinePath);
  if (quarantined) {
    if (!evidenceMatches(quarantined, expected)) fail("replacement");
    await unlinkDurably(quarantinePath);
    return true;
  }
  const current = await readExactFile(path);
  if (!current) return false;
  if (!evidenceMatches(current, expected)) fail("replacement");
  if (await exists(quarantinePath)) fail("replacement");
  try {
    await moveFile(path, quarantinePath);
    await syncDirectory(dirname(path));
  } catch (error) {
    if (error instanceof ExportDeletionExecutionError) throw error;
    fail("replacement");
  }
  const moved = await readExactFile(quarantinePath);
  if (!moved || !evidenceMatches(moved, expected)) fail("replacement");
  if (quarantineStage) await failpoint(quarantineStage, detail);
  await unlinkDurably(quarantinePath);
  return true;
}

function pathForInventoryRow(row, journal, workspaceDirectory, outputDirectory) {
  switch (row.role) {
    case EXPORT_DELETION_INVENTORY_ROLES.setManifest:
      return join(outputDirectory, EXPORT_SET_MANIFEST_BASENAME);
    case EXPORT_DELETION_INVENTORY_ROLES.chunkArtifact:
      return join(outputDirectory, exportSetChunkBasenames(row.chunkIndex, journal.exportSetManifestVersion).bundle);
    case EXPORT_DELETION_INVENTORY_ROLES.workspaceSqliteJournal:
      return join(workspaceDirectory, `${EXPORT_WORKSPACE_DATABASE_BASENAME}-journal`);
    case EXPORT_DELETION_INVENTORY_ROLES.workspaceSqliteWal:
      return join(workspaceDirectory, `${EXPORT_WORKSPACE_DATABASE_BASENAME}-wal`);
    case EXPORT_DELETION_INVENTORY_ROLES.workspaceSqliteShm:
      return join(workspaceDirectory, `${EXPORT_WORKSPACE_DATABASE_BASENAME}-shm`);
    case EXPORT_DELETION_INVENTORY_ROLES.workspaceDatabase:
      return join(workspaceDirectory, EXPORT_WORKSPACE_DATABASE_BASENAME);
    case EXPORT_DELETION_INVENTORY_ROLES.chunkReceipt:
      return join(outputDirectory, exportSetChunkBasenames(row.chunkIndex, journal.exportSetManifestVersion).receipt);
    case EXPORT_DELETION_INVENTORY_ROLES.setManifestReceipt:
      return join(outputDirectory, EXPORT_SET_MANIFEST_RECEIPT_BASENAME);
    default:
      fail("path_derivation");
  }
}

async function unlinkInventoryRow(path, row, journal, options) {
  return quarantineThenUnlink(path, row, inventoryQuarantinePath(path, row, journal), {
    ...options,
    quarantineStage: "after_inventory_quarantine",
    detail: { ordinal: row.ordinal, role: row.role, chunkIndex: row.chunkIndex },
  });
}

function deletionReceipt(journal) {
  return {
    schemaVersion: EXPORT_DELETION_RECEIPT_VERSION,
    planVersion: EXPORT_DELETION_PLAN_VERSION,
    artifactClass: "complete_local_export_set",
    state: "complete",
    logicalRemovalConfirmed: true,
    deletedFileCount: journal.inventoryCounts.totalFiles,
    deletedBytes: journal.inventoryCounts.totalBytes,
    sourceLogsPreserved: true,
    identityStatePreserved: true,
    directoriesRetained: true,
    networkActivity: "absent",
    secureErasureClaimed: false,
    transportReady: false,
  };
}

async function publishOrValidateReceipt(outputDirectory, journal) {
  const path = join(outputDirectory, EXPORT_DELETION_RECEIPT_BASENAME);
  const receipt = deletionReceipt(journal);
  assertValidExportDeletionReceipt(receipt);
  const text = stableJson(receipt);
  const existing = await readCanonicalControl(path, "receipt_invalid");
  if (existing) {
    try {
      assertValidExportDeletionReceipt(existing.value);
    } catch {
      fail("receipt_invalid");
    }
    if (existing.text !== text) fail("receipt_invalid");
    return receipt;
  }
  await writeOwnerOnlyNoClobberDurable(path, text);
  return receipt;
}

async function deleteExactControl(path, quarantinePath, expected, options = {}) {
  const removed = await quarantineThenUnlink(path, expected, quarantinePath, options);
  if (!removed) fail("replacement");
}

async function executeCommittedDeletion({ workspaceDirectory, outputDirectory, journal, marker, failpoint, moveFile }) {
  for (const row of journal.inventory) {
    await assertBoundDirectories(workspaceDirectory, outputDirectory, journal.directoryIdentities);
    const path = pathForInventoryRow(row, journal, workspaceDirectory, outputDirectory);
    const removed = await unlinkInventoryRow(path, row, journal, { moveFile, failpoint });
    if (removed) await failpoint("after_inventory_unlink", { ordinal: row.ordinal, role: row.role, chunkIndex: row.chunkIndex });
  }
  await assertBoundDirectories(workspaceDirectory, outputDirectory, journal.directoryIdentities);
  const receipt = await publishOrValidateReceipt(outputDirectory, journal);
  await failpoint("after_receipt_publish", null);

  const markerPath = join(outputDirectory, EXPORT_DELETION_COMMIT_MARKER_BASENAME);
  const journalPath = join(outputDirectory, EXPORT_DELETION_JOURNAL_BASENAME);
  await deleteExactControl(journalPath, join(outputDirectory, JOURNAL_QUARANTINE_BASENAME), journal.__artifact, {
    moveFile,
    failpoint,
    quarantineStage: "after_journal_quarantine",
  });
  await failpoint("after_journal_unlink", null);
  await assertDirectoryIdentity(outputDirectory, journal.directoryIdentities.output);
  await deleteExactControl(markerPath, join(outputDirectory, MARKER_QUARANTINE_BASENAME), marker, {
    moveFile,
    failpoint,
    quarantineStage: "after_commit_marker_quarantine",
  });
  await failpoint("after_commit_marker_unlink", null);
  return receipt;
}

async function loadCommittedControls(outputDirectory) {
  const journalPath = join(outputDirectory, EXPORT_DELETION_JOURNAL_BASENAME);
  const markerPath = join(outputDirectory, EXPORT_DELETION_COMMIT_MARKER_BASENAME);
  const journalArtifact = await readCanonicalControlEither(
    journalPath,
    join(outputDirectory, JOURNAL_QUARANTINE_BASENAME),
    "journal_invalid",
  );
  const markerArtifact = await readCanonicalControlEither(
    markerPath,
    join(outputDirectory, MARKER_QUARANTINE_BASENAME),
    "commit_invalid",
  );
  if (!journalArtifact && !markerArtifact) return null;
  if (!journalArtifact || !markerArtifact) fail("journal_pair");
  try {
    assertValidExportDeletionJournal(journalArtifact.value);
    assertValidExportDeletionCommitMarker(markerArtifact.value);
  } catch {
    fail("journal_invalid");
  }
  if (markerArtifact.value.planSha256 !== journalArtifact.value.planSha256
      || markerArtifact.value.journalSha256 !== sha256(journalArtifact.text)
      || stableJson(markerArtifact.value.directoryIdentities)
        !== stableJson(journalArtifact.value.directoryIdentities)) fail("commit_invalid");
  return {
    journal: { ...journalArtifact.value, __artifact: journalArtifact },
    marker: markerArtifact,
  };
}

async function runRecoveryUnderLeases({ workspaceDirectory, outputDirectory, failpoint, moveFile }) {
  await recoverOwnerOnlyPairTransactionsUnderLease({ directory: outputDirectory });
  let controls;
  try {
    controls = await loadCommittedControls(outputDirectory);
  } catch (error) {
    const journalPresent = await exists(join(outputDirectory, EXPORT_DELETION_JOURNAL_BASENAME))
      || await exists(join(outputDirectory, JOURNAL_QUARANTINE_BASENAME));
    const markerPath = join(outputDirectory, EXPORT_DELETION_COMMIT_MARKER_BASENAME);
    const markerArtifact = await readCanonicalControlEither(
      markerPath,
      join(outputDirectory, MARKER_QUARANTINE_BASENAME),
      "commit_invalid",
    );
    const receiptArtifact = await readCanonicalControl(join(outputDirectory, EXPORT_DELETION_RECEIPT_BASENAME), "receipt_invalid");
    if (journalPresent || !markerArtifact || !receiptArtifact) throw error;
    try {
      assertValidExportDeletionCommitMarker(markerArtifact.value);
      assertValidExportDeletionReceipt(receiptArtifact.value);
    } catch {
      fail("receipt_invalid");
    }
    await assertBoundDirectories(workspaceDirectory, outputDirectory, markerArtifact.value.directoryIdentities);
    await deleteExactControl(
      markerPath,
      join(outputDirectory, MARKER_QUARANTINE_BASENAME),
      markerArtifact,
      { moveFile, failpoint, quarantineStage: "after_commit_marker_quarantine" },
    );
    await failpoint("after_commit_marker_unlink", null);
    return receiptArtifact.value;
  }
  if (!controls) {
    const receipt = await readCanonicalControl(join(outputDirectory, EXPORT_DELETION_RECEIPT_BASENAME), "receipt_invalid");
    if (!receipt) fail("journal_missing");
    try {
      assertValidExportDeletionReceipt(receipt.value);
    } catch {
      fail("receipt_invalid");
    }
    await assertReceiptOnlyCompletionState(workspaceDirectory, outputDirectory);
    return receipt.value;
  }
  await assertBoundDirectories(workspaceDirectory, outputDirectory, controls.journal.directoryIdentities);
  return executeCommittedDeletion({
    workspaceDirectory,
    outputDirectory,
    journal: controls.journal,
    marker: controls.marker,
    failpoint,
    moveFile,
  });
}

async function withDeletionLeases(workspaceDirectory, outputDirectory, callback) {
  return withExistingExportWorkspaceLease(workspaceDirectory, (workspacePath, workspaceStats) =>
    withExportDestinationLease(outputDirectory, (outputPath, outputStats) => callback({
      workspacePath,
      outputPath,
      directoryIdentities: {
        workspace: directoryIdentity(workspaceStats),
        output: directoryIdentity(outputStats),
      },
    })));
}

export async function deleteLocalExport({
  workspaceDirectory,
  outputDirectory,
  confirmationToken,
  failpoint = async () => {},
  moveFile = rename,
} = {}) {
  if (typeof confirmationToken !== "string"
      || !(new RegExp(EXPORT_DELETION_CONFIRMATION_TOKEN_PATTERN)).test(confirmationToken)) fail("confirmation");
  if (typeof failpoint !== "function") throw new TypeError("Deletion failpoint must be a function");
  if (typeof moveFile !== "function") throw new TypeError("Deletion move function must be a function");
  const preview = await planLocalExportDeletion({ workspaceDirectory, outputDirectory });
  if (preview.confirmationToken !== confirmationToken) fail("confirmation");
  const workspace = resolve(workspaceDirectory);
  const output = resolve(outputDirectory);
  return withDeletionLeases(workspace, output, async ({ workspacePath, outputPath, directoryIdentities }) => {
    await recoverOwnerOnlyPairTransactionsUnderLease({ directory: outputPath });
    const existing = await loadCommittedControls(outputPath);
    if (existing) fail("journal_pair");
    const plan = await buildLocalExportDeletionPlan({
      workspaceDirectory: workspacePath,
      outputDirectory: outputPath,
      allowLeaseControls: true,
    });
    if (plan.summary.confirmationToken !== confirmationToken) fail("confirmation");
    if (stableJson(plan.journal.directoryIdentities) !== stableJson(directoryIdentities)) fail("replacement");
    const journalText = stableJson(plan.journal);
    const markerValue = {
      schemaVersion: EXPORT_DELETION_COMMIT_MARKER_VERSION,
      planVersion: EXPORT_DELETION_PLAN_VERSION,
      deletionOrderVersion: plan.journal.deletionOrderVersion,
      state: "committed",
      directoryIdentities: plan.journal.directoryIdentities,
      planSha256: plan.journal.planSha256,
      journalSha256: sha256(journalText),
      transportReady: false,
    };
    assertValidExportDeletionCommitMarker(markerValue);
    await writeOwnerOnlyPairNoClobberUnderLease({
      // The pair primitive publishes second first: journal before marker.
      firstPath: join(outputPath, EXPORT_DELETION_COMMIT_MARKER_BASENAME),
      firstContent: stableJson(markerValue),
      secondPath: join(outputPath, EXPORT_DELETION_JOURNAL_BASENAME),
      secondContent: journalText,
    });
    await failpoint("after_journal_commit", null);
    const controls = await loadCommittedControls(outputPath);
    if (!controls) fail("journal_pair");
    return executeCommittedDeletion({
      workspaceDirectory: workspacePath,
      outputDirectory: outputPath,
      journal: controls.journal,
      marker: controls.marker,
      failpoint,
      moveFile,
    });
  });
}

export async function recoverLocalExportDeletion({
  workspaceDirectory,
  outputDirectory,
  failpoint = async () => {},
  moveFile = rename,
} = {}) {
  if (!workspaceDirectory || !outputDirectory) fail("journal_missing");
  if (typeof failpoint !== "function") throw new TypeError("Deletion failpoint must be a function");
  if (typeof moveFile !== "function") throw new TypeError("Deletion move function must be a function");
  const workspace = resolve(workspaceDirectory);
  const output = resolve(outputDirectory);
  return withDeletionLeases(workspace, output, ({ workspacePath, outputPath }) => runRecoveryUnderLeases({
    workspaceDirectory: workspacePath,
    outputDirectory: outputPath,
    failpoint,
    moveFile,
  }));
}
