import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isProxy } from "node:util/types";

import {
  assertOwnerControlledDirectory,
  syncDirectory,
} from "./owner-only-filesystem.js";
import { createOwnerOnlyExportArtifactStorageContext } from "./owner-only-export-artifact-storage.js";
import { readBoundedDirectoryEntries as readBoundedDirectoryEntriesImpl } from "./bounded-directory-reader.js";

function invalidConfiguration() {
  throw new TypeError("Owner-only export deletion configuration is invalid");
}
function ownFunction(value) {
  if (typeof value !== "function" || isProxy(value)) invalidConfiguration();
  return value;
}
function ownValue(object, key) {
  if (!object || typeof object !== "object" || Array.isArray(object) || isProxy(object)) invalidConfiguration();
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch {
    invalidConfiguration();
  }
  if (!descriptor || !Object.hasOwn(descriptor, "value") || isProxy(descriptor.value)) invalidConfiguration();
  return descriptor.value;
}

function snapshotRecord(object, keys, validate) {
  if (!object || typeof object !== "object" || Array.isArray(object) || isProxy(object)) invalidConfiguration();
  const result = {};
  for (const key of keys) {
    const value = ownValue(object, key);
    if (!validate(value, key)) invalidConfiguration();
    result[key] = value;
  }
  return Object.freeze(result);
}

function snapshotMethodPort(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) invalidConfiguration();
  const methods = {};
  for (const key of keys) methods[key] = ownFunction(ownValue(value, key));
  return Object.freeze({ receiver: value, methods: Object.freeze(methods) });
}

function snapshotOptions(value, keys, reject) {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) reject();
  const result = {};
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      if (!Object.hasOwn(descriptor, "value")) reject();
      result[key] = descriptor.value;
    }
  } catch {
    reject();
  }
  return Object.freeze(result);
}

function invalidPortResult() {
  throw new TypeError("Owner-only export deletion port result is invalid");
}

function snapshotJsonData(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || isProxy(value) || seen.has(value)) invalidPortResult();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) invalidPortResult();
  if (Object.getOwnPropertySymbols(value).length > 0) invalidPortResult();
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0) invalidPortResult();
      const result = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, "value")) invalidPortResult();
        result.push(snapshotJsonData(descriptor.value, seen));
      }
      return Object.freeze(result);
    }
    const result = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) continue;
      if (!Object.hasOwn(descriptor, "value")) invalidPortResult();
      result[key] = snapshotJsonData(descriptor.value, seen);
    }
    return Object.freeze(result);
  } finally {
    seen.delete(value);
  }
}


/**
 * Durable, owner-only deletion mechanics. The application injects the
 * target-specific preflight builder so this platform owner never imports an
 * application or legacy compatibility module.
 */
export function createOwnerOnlyExportDeletionStorage(configuration = {}) {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)
      || isProxy(configuration)) invalidConfiguration();
  const planDescriptor = Object.getOwnPropertyDescriptor(configuration, "buildLocalExportDeletionPlan");
  const previewDescriptor = Object.getOwnPropertyDescriptor(configuration, "planLocalExportDeletion");
  if (!planDescriptor || !Object.hasOwn(planDescriptor, "value")
      || !previewDescriptor || !Object.hasOwn(previewDescriptor, "value")) invalidConfiguration();
  const buildLocalExportDeletionPlan = ownFunction(planDescriptor.value);
  const planLocalExportDeletion = ownFunction(previewDescriptor.value);
  const semantics = ownValue(configuration, "semantics");
  const stableJson = ownFunction(ownValue(semantics, "stableJson"));
  const assertValidExportDeletionCommitMarker = ownFunction(ownValue(semantics, "assertValidExportDeletionCommitMarker"));
  const assertValidExportDeletionJournal = ownFunction(ownValue(semantics, "assertValidExportDeletionJournal"));
  const assertValidExportDeletionReceipt = ownFunction(ownValue(semantics, "assertValidExportDeletionReceipt"));
  const ExportResourceLimitError = ownFunction(ownValue(semantics, "ExportResourceLimitError"));
  const exportSetChunkBasenames = ownFunction(ownValue(semantics, "exportSetChunkBasenames"));
  const DEFAULT_EXPORT_RESOURCE_LIMITS = snapshotRecord(
    ownValue(semantics, "DEFAULT_EXPORT_RESOURCE_LIMITS"),
    ["maximumCanonicalBundleBytes", "maximumEncodedArtifactBytes", "maximumDirectoryEntries"],
    (value) => Number.isSafeInteger(value) && value > 0,
  );
  const EXPORT_DELETION_COMMIT_MARKER_VERSION = ownValue(semantics, "EXPORT_DELETION_COMMIT_MARKER_VERSION");
  const EXPORT_DELETION_CONFIRMATION_TOKEN_PATTERN = ownValue(semantics, "EXPORT_DELETION_CONFIRMATION_TOKEN_PATTERN");
  const EXPORT_DELETION_INVENTORY_ROLES = snapshotRecord(
    ownValue(semantics, "EXPORT_DELETION_INVENTORY_ROLES"),
    [
      "setManifest", "chunkArtifact", "workspaceSqliteJournal", "workspaceSqliteWal",
      "workspaceSqliteShm", "workspaceDatabase", "chunkReceipt", "setManifestReceipt",
    ],
    (value) => typeof value === "string" && value.length > 0 && value.length <= 64,
  );
  const EXPORT_DELETION_PLAN_VERSION = ownValue(semantics, "EXPORT_DELETION_PLAN_VERSION");
  const EXPORT_DELETION_RECEIPT_VERSION = ownValue(semantics, "EXPORT_DELETION_RECEIPT_VERSION");
  const EXPORT_SET_MANIFEST_BASENAME = ownValue(semantics, "EXPORT_SET_MANIFEST_BASENAME");
  const EXPORT_SET_MANIFEST_RECEIPT_BASENAME = ownValue(semantics, "EXPORT_SET_MANIFEST_RECEIPT_BASENAME");
  const EXPORT_DELETION_COMMIT_MARKER_BASENAME = ownValue(semantics, "EXPORT_DELETION_COMMIT_MARKER_BASENAME");
  const DESTINATION_LOCK_BASENAME = ownValue(semantics, "EXPORT_DELETION_DESTINATION_LOCK_BASENAME");
  const DESTINATION_TRANSACTION_BASENAME = ownValue(semantics, "EXPORT_DELETION_DESTINATION_TRANSACTION_BASENAME");
  const EXPORT_DELETION_JOURNAL_BASENAME = ownValue(semantics, "EXPORT_DELETION_JOURNAL_BASENAME");
  const DELETION_QUARANTINE_PREFIX = ownValue(semantics, "EXPORT_DELETION_QUARANTINE_PREFIX");
  const EXPORT_DELETION_RECEIPT_BASENAME = ownValue(semantics, "EXPORT_DELETION_RECEIPT_BASENAME");
  const WORKSPACE_LOCK_BASENAME = ownValue(semantics, "EXPORT_DELETION_WORKSPACE_LOCK_BASENAME");
  for (const value of [
    EXPORT_DELETION_COMMIT_MARKER_VERSION,
    EXPORT_DELETION_CONFIRMATION_TOKEN_PATTERN,
    EXPORT_DELETION_PLAN_VERSION,
    EXPORT_DELETION_RECEIPT_VERSION,
    EXPORT_SET_MANIFEST_BASENAME,
    EXPORT_SET_MANIFEST_RECEIPT_BASENAME,
    EXPORT_DELETION_COMMIT_MARKER_BASENAME,
    DESTINATION_LOCK_BASENAME,
    DESTINATION_TRANSACTION_BASENAME,
    EXPORT_DELETION_JOURNAL_BASENAME,
    DELETION_QUARANTINE_PREFIX,
    EXPORT_DELETION_RECEIPT_BASENAME,
    WORKSPACE_LOCK_BASENAME,
  ]) {
    if (typeof value !== "string" || value.length < 1 || value.length > 256) invalidConfiguration();
  }
  try {
    new RegExp(EXPORT_DELETION_CONFIRMATION_TOKEN_PATTERN);
  } catch {
    invalidConfiguration();
  }
  const leaseDescriptor = Object.getOwnPropertyDescriptor(configuration, "withExistingExportWorkspaceLease");
  const basenameDescriptor = Object.getOwnPropertyDescriptor(configuration, "workspaceDatabaseBasename");
  if (!leaseDescriptor || !Object.hasOwn(leaseDescriptor, "value")
      || !basenameDescriptor || !Object.hasOwn(basenameDescriptor, "value")
      || typeof basenameDescriptor.value !== "string" || basenameDescriptor.value.length === 0) {
    invalidConfiguration();
  }
  const withExistingExportWorkspaceLease = ownFunction(leaseDescriptor.value);
  const isTrustedDeletionError = ownFunction(ownValue(configuration, "isTrustedDeletionError"));
  const isTrustedExportWorkspaceLockError = ownFunction(ownValue(configuration, "isTrustedExportWorkspaceLockError"));
  const EXPORT_WORKSPACE_DATABASE_BASENAME = basenameDescriptor.value;
  function readBoundedDirectoryEntries(directory, options = {}) {
    return readBoundedDirectoryEntriesImpl(directory, {
      maximumEntries: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumDirectoryEntries,
      ...options,
    });
  }
  let artifactStoragePort;
  try {
    const artifactStorage = createOwnerOnlyExportArtifactStorageContext(Object.freeze({
      stableJson,
      maximumCanonicalBundleBytes: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumCanonicalBundleBytes,
      maximumEncodedArtifactBytes: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumEncodedArtifactBytes,
      maximumDirectoryEntries: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumDirectoryEntries,
      createResourceLimitError: (code) => new ExportResourceLimitError(code),
    }));
    artifactStoragePort = snapshotMethodPort(artifactStorage, [
      "recoverOwnerOnlyPairTransactionsUnderLease",
      "withExportDestinationLease",
      "writeOwnerOnlyPairNoClobberUnderLease",
    ]);
  } catch {
    invalidConfiguration();
  }
  const recoverOwnerOnlyPairTransactionsUnderLease = (...args) => Reflect.apply(
    artifactStoragePort.methods.recoverOwnerOnlyPairTransactionsUnderLease,
    artifactStoragePort.receiver,
    args,
  );
  const withExportDestinationLease = (...args) => Reflect.apply(
    artifactStoragePort.methods.withExportDestinationLease,
    artifactStoragePort.receiver,
    args,
  );
  const writeOwnerOnlyPairNoClobberUnderLease = (...args) => Reflect.apply(
    artifactStoragePort.methods.writeOwnerOnlyPairNoClobberUnderLease,
    artifactStoragePort.receiver,
    args,
  );

  async function unlinkDurably(path) {
    await unlink(path);
    await syncDirectory(dirname(path));
  }

  async function writeOwnerOnlyNoClobberDurable(path, content) {
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > 1024 * 1024) {
      throw new TypeError("Owner-only deletion control content is invalid");
    }
    const directory = dirname(resolve(path));
    await assertOwnerControlledDirectory(directory);
    let handle;
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      const stats = await handle.stat();
      if (!stats.isFile() || stats.nlink !== 1 || stats.size !== Buffer.byteLength(content, "utf8")
          || (typeof process.getuid === "function" && stats.uid !== process.getuid())
          || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
        throw new Error("Owner-only deletion control validation failed");
      }
      await handle.close();
      handle = null;
      await syncDirectory(directory);
    } catch (error) {
      await handle?.close().catch(() => {});
      throw error;
    }
  }

const MAX_CONTROL_BYTES = 1024 * 1024;
const JOURNAL_QUARANTINE_BASENAME = `${DELETION_QUARANTINE_PREFIX}journal`;
const MARKER_QUARANTINE_BASENAME = `${DELETION_QUARANTINE_PREFIX}commit`;
const SAFE_CODES = new Set([
  "confirmation", "journal_missing", "journal_pair", "journal_invalid", "commit_invalid",
  "replacement", "receipt_invalid", "path_derivation",
]);

const trustedExecutionErrors = new WeakSet();

class ExportDeletionExecutionError extends Error {
  constructor(code) {
    if (!SAFE_CODES.has(code)) throw new TypeError("Unknown export-deletion execution code");
    super(`Local export deletion failed (${code})`);
    this.name = "ExportDeletionExecutionError";
    this.code = `export_deletion_execute_${code}`;
    trustedExecutionErrors.add(this);
  }
}

function isTrustedExecutionError(error) {
  return Boolean(error && trustedExecutionErrors.has(error)
    && Object.getPrototypeOf(error) === ExportDeletionExecutionError.prototype);
}

function isTrustedBoundaryError(error) {
  if (isTrustedExecutionError(error)) return true;
  try {
    return Reflect.apply(isTrustedDeletionError, undefined, [error]) === true
      || Reflect.apply(isTrustedExportWorkspaceLockError, undefined, [error]) === true;
  } catch {
    return false;
  }
}

function fail(code) {
  throw new ExportDeletionExecutionError(code);
}

async function callPlanPort(port, options, failureCode) {
  try {
    return snapshotJsonData(await Reflect.apply(port, undefined, [options]));
  } catch (error) {
    if (isTrustedBoundaryError(error)) throw error;
    fail(failureCode);
  }
}

function runtimeOwnValue(object, key) {
  if (!object || typeof object !== "object" || Array.isArray(object) || isProxy(object)) fail("replacement");
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch {
    fail("replacement");
  }
  if (!descriptor || !Object.hasOwn(descriptor, "value") || isProxy(descriptor.value)) fail("replacement");
  return descriptor.value;
}

function normalizeLeaseIdentity(stats) {
  const device = Number(runtimeOwnValue(stats, "dev"));
  const inode = Number(runtimeOwnValue(stats, "ino"));
  if (!Number.isSafeInteger(device) || device < 0 || !Number.isSafeInteger(inode) || inode < 0) fail("replacement");
  return Object.freeze({ device, inode });
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
    if (isTrustedExecutionError(error)) throw error;
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
    if (isTrustedExecutionError(error)) throw error;
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
  const workspaceEntries = await readBoundedDirectoryEntries(workspaceDirectory);
  if (workspaceEntries.some((name) => name !== WORKSPACE_LOCK_BASENAME)) fail("receipt_invalid");
  const outputEntries = await readBoundedDirectoryEntries(outputDirectory);
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
    if (isTrustedExecutionError(error)) throw error;
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
  const callbackFailures = new WeakSet();
  const guardedCallback = async (value) => {
    try {
      return await callback(value);
    } catch (error) {
      if (error && (typeof error === "object" || typeof error === "function")) callbackFailures.add(error);
      throw error;
    }
  };
  try {
    return await Reflect.apply(withExistingExportWorkspaceLease, undefined, [
      workspaceDirectory,
      (workspacePathValue, workspaceStats) => {
        if (typeof workspacePathValue !== "string" || workspacePathValue.length === 0) fail("replacement");
        const workspaceIdentity = normalizeLeaseIdentity(workspaceStats);
        return withExportDestinationLease(outputDirectory, (outputPathValue, outputStats) => {
          if (typeof outputPathValue !== "string" || outputPathValue.length === 0) fail("replacement");
          return guardedCallback(Object.freeze({
            workspacePath: workspacePathValue,
            outputPath: outputPathValue,
            directoryIdentities: Object.freeze({
              workspace: workspaceIdentity,
              output: normalizeLeaseIdentity(outputStats),
            }),
          }));
        });
      },
    ]);
  } catch (error) {
    if ((error && (typeof error === "object" || typeof error === "function") && callbackFailures.has(error))
        || isTrustedBoundaryError(error)) throw error;
    fail("replacement");
  }
}

async function deleteLocalExport(options) {
  const selected = snapshotOptions(
    options,
    ["workspaceDirectory", "outputDirectory", "confirmationToken", "failpoint", "moveFile"],
    () => fail("confirmation"),
  );
  const {
    workspaceDirectory,
    outputDirectory,
    confirmationToken,
    failpoint = async () => {},
    moveFile = rename,
  } = selected;
  if (typeof confirmationToken !== "string"
      || confirmationToken.length > 64
      || !(new RegExp(EXPORT_DELETION_CONFIRMATION_TOKEN_PATTERN)).test(confirmationToken)) fail("confirmation");
  if (typeof workspaceDirectory !== "string" || typeof outputDirectory !== "string") fail("confirmation");
  if (typeof failpoint !== "function" || isProxy(failpoint)) throw new TypeError("Deletion failpoint must be a function");
  if (typeof moveFile !== "function" || isProxy(moveFile)) throw new TypeError("Deletion move function must be a function");
  const preview = await callPlanPort(
    planLocalExportDeletion,
    Object.freeze({ workspaceDirectory, outputDirectory }),
    "confirmation",
  );
  if (preview.confirmationToken !== confirmationToken) fail("confirmation");
  const workspace = resolve(workspaceDirectory);
  const output = resolve(outputDirectory);
  const result = await withDeletionLeases(workspace, output, async ({ workspacePath, outputPath, directoryIdentities }) => {
    await recoverOwnerOnlyPairTransactionsUnderLease({ directory: outputPath });
    const existing = await loadCommittedControls(outputPath);
    if (existing) fail("journal_pair");
    const plan = await callPlanPort(buildLocalExportDeletionPlan, Object.freeze({
        workspaceDirectory: workspacePath,
        outputDirectory: outputPath,
        allowLeaseControls: true,
      }), "replacement");
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
  try {
    return snapshotJsonData(result);
  } catch (error) {
    if (isTrustedBoundaryError(error)) throw error;
    fail("receipt_invalid");
  }
}

async function recoverLocalExportDeletion(options) {
  const selected = snapshotOptions(
    options,
    ["workspaceDirectory", "outputDirectory", "failpoint", "moveFile"],
    () => fail("journal_missing"),
  );
  const {
    workspaceDirectory,
    outputDirectory,
    failpoint = async () => {},
    moveFile = rename,
  } = selected;
  if (!workspaceDirectory || !outputDirectory) fail("journal_missing");
  if (typeof workspaceDirectory !== "string" || typeof outputDirectory !== "string") fail("journal_missing");
  if (typeof failpoint !== "function" || isProxy(failpoint)) throw new TypeError("Deletion failpoint must be a function");
  if (typeof moveFile !== "function" || isProxy(moveFile)) throw new TypeError("Deletion move function must be a function");
  const workspace = resolve(workspaceDirectory);
  const output = resolve(outputDirectory);
  const result = await withDeletionLeases(workspace, output, ({ workspacePath, outputPath }) => runRecoveryUnderLeases({
    workspaceDirectory: workspacePath,
    outputDirectory: outputPath,
    failpoint,
    moveFile,
  }));
  try {
    return snapshotJsonData(result);
  } catch (error) {
    if (isTrustedBoundaryError(error)) throw error;
    fail("receipt_invalid");
  }
}

  return Object.freeze({
    ExportDeletionExecutionError,
    deleteLocalExport,
    recoverLocalExportDeletion,
  });
}
