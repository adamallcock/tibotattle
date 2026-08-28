import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { rebuildLocalUnifiedIndex } from "../src/local-unified-index-build.js";
import {
  assertSafeLocalUnifiedIndexParentPath,
  assertSafeLocalUnifiedIndexTarget,
  defaultLocalUnifiedIndexRecoveryLockPath,
  LOCAL_UNIFIED_INDEX_MINIMUM_READER_USER_VERSION,
  LOCAL_UNIFIED_INDEX_MINIMUM_WRITER_USER_VERSION,
  LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
  LOCAL_UNIFIED_INDEX_USER_VERSION,
  openLocalUnifiedIndex,
  readExistingDeviceSalt,
  readLocalUnifiedIndexCompatibility,
  readUnifiedIndexGenerationDescriptor,
} from "../src/local-unified-index.js";

export const LOCAL_UNIFIED_INDEX_RECOVERY_RECEIPT_VERSION =
  "local-unified-index-recovery-v3";

const RECOVERY_CANDIDATE_NAME = "candidate.sqlite";
const RECOVERY_BACKUP_NAME = "source-backup.sqlite";
const RECOVERY_RECEIPT_NAME = "receipt.json";
const RECOVERY_PRE_PUBLISH_ROLLBACK_NAME = "pre-publish-live.sqlite";
const RECOVERY_SECRET_COPY_NAME = "device-salt.copy";
const RECOVERY_LOCK_SCHEMA_VERSION = "local-unified-index-recovery-lock-v1";
const MAX_RECOVERY_LOCK_BYTES = 4 * 1024;
const SQLITE_HEADER_BYTES = 100;
const SQLITE_HEADER_MAGIC = Buffer.from("SQLite format 3\0", "utf8");
const SQLITE_LIVE_SIDECAR_SUFFIXES = Object.freeze([
  "-wal",
  "-shm",
  "-journal",
]);

const ACCEPTED_PARTIAL_GENERATION_REASONS = new Set([
  "codex_rollout_sources_quarantined",
  "tool_provenance_incomplete",
]);

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function assertPathAbsent(path) {
  if (await pathExists(path)) {
    throw fixedError("local_unified_index_recovery_target_exists");
  }
}

function ownerOnlyDirectory(metadata) {
  return metadata.isDirectory()
    && !metadata.isSymbolicLink()
    && (typeof process.getuid !== "function" || metadata.uid === process.getuid())
    && (process.platform === "win32" || (metadata.mode & 0o077) === 0);
}

async function validateRecoveryDirectory(recoveryDir) {
  const parentIdentity = assertSafeLocalUnifiedIndexParentPath(recoveryDir);
  let metadata;
  try {
    metadata = await lstat(recoveryDir);
  } catch {
    throw fixedError("local_unified_index_recovery_directory_invalid");
  }
  if (!ownerOnlyDirectory(metadata)) {
    throw fixedError("local_unified_index_recovery_directory_invalid");
  }
  assertSafeLocalUnifiedIndexParentPath(recoveryDir, parentIdentity);
  let finalMetadata;
  try {
    finalMetadata = await lstat(recoveryDir);
  } catch {
    throw fixedError("local_unified_index_recovery_directory_invalid");
  }
  if (!ownerOnlyDirectory(finalMetadata)
      || finalMetadata.dev !== metadata.dev
      || finalMetadata.ino !== metadata.ino) {
    throw fixedError("local_unified_index_recovery_directory_invalid");
  }
  return finalMetadata;
}

async function reserveRecoveryDirectory(recoveryDir) {
  const parentIdentity = assertSafeLocalUnifiedIndexParentPath(recoveryDir);
  try {
    await mkdir(recoveryDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw fixedError("local_unified_index_recovery_target_exists");
    }
    throw fixedError("local_unified_index_recovery_directory_unavailable");
  }
  assertSafeLocalUnifiedIndexParentPath(recoveryDir, parentIdentity);
  return validateRecoveryDirectory(recoveryDir);
}

function ownerOnlyRegularFile(metadata) {
  return metadata.isFile()
    && !metadata.isSymbolicLink()
    && metadata.nlink === 1
    && (typeof process.getuid !== "function" || metadata.uid === process.getuid())
    && (process.platform === "win32" || (metadata.mode & 0o077) === 0);
}

function sameLockIdentity(left, right) {
  return ownerOnlyRegularFile(left)
    && ownerOnlyRegularFile(right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function recoveryLockError(code, { pid = null } = {}) {
  const error = fixedError(code);
  if (Number.isSafeInteger(pid)) error.lockOwnerPid = pid;
  return error;
}

function validRecoveryLockRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return false;
  }
  const keys = Object.keys(record).toSorted();
  return keys.length === 3
    && keys[0] === "acquiredAt"
    && keys[1] === "pid"
    && keys[2] === "schemaVersion"
    && record.schemaVersion === RECOVERY_LOCK_SCHEMA_VERSION
    && Number.isSafeInteger(record.pid)
    && record.pid > 0
    && typeof record.acquiredAt === "string"
    && record.acquiredAt.length <= 64
    && Number.isFinite(Date.parse(record.acquiredAt));
}

async function inspectRecoveryLock(lockFile) {
  let pathMetadata;
  try {
    pathMetadata = await lstat(lockFile);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw fixedError("local_unified_index_recovery_lock_invalid");
  }
  if (!ownerOnlyRegularFile(pathMetadata)
      || pathMetadata.size < 2
      || pathMetadata.size > MAX_RECOVERY_LOCK_BYTES) {
    throw fixedError("local_unified_index_recovery_lock_invalid");
  }
  let handle;
  try {
    handle = await open(
      lockFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const openedMetadata = await handle.stat();
    if (!sameLockIdentity(pathMetadata, openedMetadata)) {
      throw fixedError("local_unified_index_recovery_lock_invalid");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_RECOVERY_LOCK_BYTES) {
      throw fixedError("local_unified_index_recovery_lock_invalid");
    }
    let record;
    try {
      record = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw fixedError("local_unified_index_recovery_lock_invalid");
    }
    if (!validRecoveryLockRecord(record)) {
      throw fixedError("local_unified_index_recovery_lock_invalid");
    }
    const finalMetadata = await lstat(lockFile);
    if (!sameLockIdentity(openedMetadata, finalMetadata)) {
      throw fixedError("local_unified_index_recovery_lock_changed");
    }
    return { record, metadata: finalMetadata };
  } catch (error) {
    if (error?.code?.startsWith("local_unified_index_")) throw error;
    throw fixedError("local_unified_index_recovery_lock_invalid");
  } finally {
    await handle?.close();
  }
}

async function releaseOwnedRecoveryLock({ handle, lockFile, metadata }) {
  let pathMetadata;
  try {
    pathMetadata = await lstat(lockFile);
  } catch {
    await handle.close();
    throw fixedError("local_unified_index_recovery_lock_changed");
  }
  if (!sameLockIdentity(pathMetadata, metadata)) {
    await handle.close();
    throw fixedError("local_unified_index_recovery_lock_changed");
  }
  await handle.close();
  try {
    await unlink(lockFile);
  } catch {
    throw fixedError("local_unified_index_recovery_lock_changed");
  }
}

async function createRecoveryLock(lockFile) {
  const handle = await open(
    lockFile,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let metadata;
  try {
    await handle.writeFile(`${JSON.stringify({
      schemaVersion: RECOVERY_LOCK_SCHEMA_VERSION,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    })}\n`, "utf8");
    await handle.sync();
    metadata = await handle.stat();
    if (!ownerOnlyRegularFile(metadata)) {
      throw fixedError("local_unified_index_recovery_lock_invalid");
    }
  } catch (error) {
    try {
      if (metadata === undefined) metadata = await handle.stat();
      await releaseOwnedRecoveryLock({ handle, lockFile, metadata });
    } catch (cleanupError) {
      error.recoveryLockCleanupError = cleanupError?.code ?? "unknown";
    }
    throw error;
  }
  let released = false;
  return {
    lockFile,
    async release() {
      if (released) return;
      released = true;
      await releaseOwnedRecoveryLock({ handle, lockFile, metadata });
    },
  };
}

/**
 * Lock acquisition is O_EXCL and never deletes a pre-existing lock. Node does
 * not expose an atomic compare-and-unlink primitive, so even a valid record
 * with an apparently dead PID remains for explicit operator inspection. This
 * prevents one recovery contender from deleting a replacement lock belonging
 * to another. Normal app opens likewise never reclaim a lock.
 */
async function acquireRecoveryLock(indexFile) {
  const lockFile = defaultLocalUnifiedIndexRecoveryLockPath(indexFile);
  try {
    return await createRecoveryLock(lockFile);
  } catch (error) {
    if (error?.code === "EEXIST") {
      const inspected = await inspectRecoveryLock(lockFile);
      throw recoveryLockError("local_unified_index_recovery_locked", {
        pid: inspected?.record?.pid ?? null,
      });
    }
    if (error?.code?.startsWith("local_unified_index_")) throw error;
    throw fixedError("local_unified_index_recovery_lock_unavailable");
  }
}

async function assertNoLiveSqliteSidecars(databaseFile) {
  for (const suffix of SQLITE_LIVE_SIDECAR_SUFFIXES) {
    try {
      await lstat(`${databaseFile}${suffix}`);
      throw fixedError("local_unified_index_recovery_live_sidecar_present");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (error?.code?.startsWith("local_unified_index_")) throw error;
      throw fixedError("local_unified_index_recovery_journal_state_invalid");
    }
  }
}

function assertNoLiveSqliteSidecarsSync(databaseFile) {
  for (const suffix of SQLITE_LIVE_SIDECAR_SUFFIXES) {
    try {
      lstatSync(`${databaseFile}${suffix}`);
      throw fixedError("local_unified_index_recovery_live_sidecar_present");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (error?.code?.startsWith("local_unified_index_")) throw error;
      throw fixedError("local_unified_index_recovery_journal_state_invalid");
    }
  }
}

function assertRollbackJournalHeader(header) {
  if (header.byteLength !== SQLITE_HEADER_BYTES
      || !header.subarray(0, SQLITE_HEADER_MAGIC.byteLength)
        .equals(SQLITE_HEADER_MAGIC)) {
    throw fixedError("local_unified_index_recovery_journal_state_invalid");
  }
  // SQLite header bytes 18 and 19 are the file write/read versions: 1 is
  // rollback journaling, 2 is WAL. Recovery only publishes mode-1 files.
  if (header[18] === 2 || header[19] === 2) {
    throw fixedError("local_unified_index_recovery_wal_unsupported");
  }
  if (header[18] !== 1 || header[19] !== 1) {
    throw fixedError("local_unified_index_recovery_journal_state_invalid");
  }
}

/**
 * Inspect SQLite's persistent journal-mode header without opening SQLite.
 * Opening a WAL database can itself create or attach `-wal`/`-shm`, so this
 * gate deliberately uses only an O_NOFOLLOW file descriptor and lstat.
 */
async function assertRollbackJournalDatabase(databaseFile) {
  const pathMetadata = await assertSafeLocalUnifiedIndexTarget(databaseFile, {
    allowMissing: false,
  });
  let handle;
  try {
    handle = await open(
      databaseFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const openedMetadata = await handle.stat();
    if (!sameLockIdentity(pathMetadata, openedMetadata)) {
      throw fixedError("local_unified_index_recovery_journal_state_changed");
    }
    const header = Buffer.alloc(SQLITE_HEADER_BYTES);
    const { bytesRead } = await handle.read(
      header,
      0,
      SQLITE_HEADER_BYTES,
      0,
    );
    if (bytesRead !== SQLITE_HEADER_BYTES) {
      throw fixedError("local_unified_index_recovery_journal_state_invalid");
    }
    assertRollbackJournalHeader(header);
    await assertNoLiveSqliteSidecars(databaseFile);
    const finalMetadata = await lstat(databaseFile);
    if (!sameLockIdentity(openedMetadata, finalMetadata)) {
      throw fixedError("local_unified_index_recovery_journal_state_changed");
    }
  } catch (error) {
    if (error?.code?.startsWith("local_unified_index_")) throw error;
    throw fixedError("local_unified_index_recovery_journal_state_invalid");
  } finally {
    await handle?.close();
  }
}

function assertRollbackJournalDatabaseSync(databaseFile) {
  let pathMetadata;
  let descriptor;
  try {
    pathMetadata = lstatSync(databaseFile);
    if (!ownerOnlyRegularFile(pathMetadata)) {
      throw fixedError("local_unified_index_recovery_journal_state_invalid");
    }
    descriptor = openSync(
      databaseFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const openedMetadata = fstatSync(descriptor);
    if (!sameLockIdentity(pathMetadata, openedMetadata)) {
      throw fixedError("local_unified_index_recovery_journal_state_changed");
    }
    const header = Buffer.alloc(SQLITE_HEADER_BYTES);
    if (readSync(
      descriptor,
      header,
      0,
      SQLITE_HEADER_BYTES,
      0,
    ) !== SQLITE_HEADER_BYTES) {
      throw fixedError("local_unified_index_recovery_journal_state_invalid");
    }
    assertRollbackJournalHeader(header);
    assertNoLiveSqliteSidecarsSync(databaseFile);
    const finalMetadata = lstatSync(databaseFile);
    if (!sameLockIdentity(openedMetadata, finalMetadata)) {
      throw fixedError("local_unified_index_recovery_journal_state_changed");
    }
    return finalMetadata;
  } catch (error) {
    if (error?.code?.startsWith("local_unified_index_")) throw error;
    throw fixedError("local_unified_index_recovery_journal_state_invalid");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function syncPathSync(path) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function recoveryFileIdentitySync(path) {
  const pathMetadata = lstatSync(path);
  if (!ownerOnlyRegularFile(pathMetadata)) {
    throw fixedError("local_unified_index_recovery_journal_state_invalid");
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const openedMetadata = fstatSync(descriptor);
    if (!sameLockIdentity(pathMetadata, openedMetadata)) {
      throw fixedError("local_unified_index_recovery_journal_state_changed");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      digest.update(buffer.subarray(0, bytesRead));
    }
    const finalMetadata = lstatSync(path);
    if (!sameLockIdentity(openedMetadata, finalMetadata)
        || bytes !== Number(openedMetadata.size)) {
      throw fixedError("local_unified_index_recovery_journal_state_changed");
    }
    return Object.freeze({
      identity: Object.freeze({
        bytes,
        sha256: digest.digest("hex"),
      }),
      metadata: finalMetadata,
    });
  } finally {
    closeSync(descriptor);
  }
}

function trustedPublishRecoveryCandidateSync(
  candidateFile,
  indexFile,
  { expectedSourceIdentity, expectedCandidateIdentity },
) {
  let published = false;
  try {
    chmodSync(candidateFile, 0o600);
    assertRollbackJournalDatabaseSync(indexFile);
    assertRollbackJournalDatabaseSync(candidateFile);
    const sourceProof = recoveryFileIdentitySync(indexFile);
    const candidateProof = recoveryFileIdentitySync(candidateFile);
    if (!sameFileIdentity(sourceProof.identity, expectedSourceIdentity)) {
      throw fixedError("local_unified_index_recovery_source_changed");
    }
    if (!sameFileIdentity(candidateProof.identity, expectedCandidateIdentity)) {
      throw fixedError("local_unified_index_recovery_candidate_changed");
    }
    syncPathSync(candidateFile);
    // No injected callback or JavaScript yield is permitted between this last
    // namespace/header check and rename. A separate same-UID process can still
    // be scheduled between syscalls; the immediate post-rename check below
    // classifies that unavoidable case as published-but-uncertain.
    assertRollbackJournalDatabaseSync(indexFile);
    assertRollbackJournalDatabaseSync(candidateFile);
    if (!sameLockIdentity(sourceProof.metadata, lstatSync(indexFile))) {
      throw fixedError("local_unified_index_recovery_source_changed");
    }
    if (!sameLockIdentity(candidateProof.metadata, lstatSync(candidateFile))) {
      throw fixedError("local_unified_index_recovery_candidate_changed");
    }
    renameSync(candidateFile, indexFile);
    published = true;
    assertRollbackJournalDatabaseSync(indexFile);
    if (!sameFileIdentity(
      recoveryFileIdentitySync(indexFile).identity,
      expectedCandidateIdentity,
    )) {
      throw fixedError("local_unified_index_recovery_publication_changed");
    }
    syncPathSync(indexFile);
    syncPathSync(dirname(resolve(indexFile)));
  } catch (error) {
    if (published) error.published = true;
    if (error?.code?.startsWith("local_unified_index_")) throw error;
    const bounded = fixedError(published
      ? "local_unified_index_recovery_publication_state_uncertain"
      : "local_unified_index_recovery_publication_failed");
    if (published) bounded.published = true;
    throw bounded;
  }
}

function publicationStateUncertain(error, paths) {
  const uncertain = fixedError(
    "local_unified_index_recovery_publication_state_uncertain",
  );
  uncertain.published = true;
  uncertain.candidateConsumed = true;
  uncertain.causeCode = error?.code ?? "unknown";
  uncertain.cause = error;
  uncertain.prePublishRollbackFile = paths.prePublishRollbackFile;
  uncertain.recoveryDirectory = paths.recoveryDir;
  return uncertain;
}

async function acquireSqliteWriterExclusion(databaseFile, busyCode) {
  await assertRollbackJournalDatabase(databaseFile);
  let database;
  let transactionOpen = false;
  try {
    database = new DatabaseSync(databaseFile, { timeout: 0 });
    // BEGIN IMMEDIATE obtains SQLite's reserved writer lock without changing
    // database rows. query_only is enabled only after the lock is held so this
    // recovery connection cannot accidentally perform a write itself.
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    database.exec("PRAGMA query_only=ON");
    await assertRollbackJournalDatabase(databaseFile);
  } catch (error) {
    try {
      if (transactionOpen) database?.exec("ROLLBACK");
    } catch {
      // Preserve the bounded lock-acquisition failure below.
    }
    try {
      database?.close();
    } catch {
      // Preserve the bounded lock-acquisition failure below.
    }
    if (error?.code?.startsWith("local_unified_index_")) throw error;
    throw fixedError(busyCode);
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        database.exec("ROLLBACK");
      } finally {
        database.close();
      }
    },
  };
}

async function acquirePublicationWriterExclusions({ sourceFile, candidateFile }) {
  const source = await acquireSqliteWriterExclusion(
    sourceFile,
    "local_unified_index_recovery_source_busy",
  );
  try {
    const candidate = await acquireSqliteWriterExclusion(
      candidateFile,
      "local_unified_index_recovery_candidate_busy",
    );
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        let candidateError = null;
        try {
          candidate.release();
        } catch (error) {
          candidateError = error;
        }
        try {
          source.release();
        } catch (error) {
          if (candidateError === null) throw error;
          candidateError.sourceWriterLockReleaseError =
            error?.code ?? "unknown";
        }
        if (candidateError !== null) throw candidateError;
      },
    };
  } catch (error) {
    try {
      source.release();
    } catch (releaseError) {
      error.sourceWriterLockReleaseError = releaseError?.code ?? "unknown";
    }
    throw error;
  }
}

function receiptDigest(receipt) {
  return createHash("sha256").update(JSON.stringify(receipt), "utf8").digest("hex");
}

function sealReceipt(receipt) {
  return { ...receipt, receiptSha256: receiptDigest(receipt) };
}

async function syncOwnerOnlyFile(path, mode = 0o600) {
  await chmod(path, mode);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function recoveryFileIdentity(path) {
  const metadata = await assertSafeLocalUnifiedIndexTarget(path, {
    allowMissing: false,
  });
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return Object.freeze({
    bytes: Number(metadata.size),
    sha256: digest.digest("hex"),
  });
}

function sameFileIdentity(left, right) {
  return left?.bytes === right?.bytes && left?.sha256 === right?.sha256;
}

function bufferIdentity(bytes) {
  return Object.freeze({
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

async function readRecoverySecretSource(secretFile, {
  missingCode = "local_unified_index_recovery_secret_missing",
  invalidCode = "local_unified_index_recovery_secret_invalid",
} = {}) {
  if (typeof secretFile !== "string" || secretFile.length < 1) {
    throw fixedError(invalidCode);
  }
  const resolvedSecretFile = resolve(secretFile);
  try {
    await lstat(resolvedSecretFile);
  } catch (error) {
    if (error?.code === "ENOENT") throw fixedError(missingCode);
    throw fixedError(invalidCode);
  }
  try {
    const bytes = await readExistingDeviceSalt(resolvedSecretFile);
    return Object.freeze({
      path: resolvedSecretFile,
      bytes,
      identity: bufferIdentity(bytes),
    });
  } catch (error) {
    if (error?.code === "ENOENT") throw fixedError(missingCode);
    throw fixedError(invalidCode);
  }
}

async function writeOwnerOnlyBytesExclusive(path, bytes) {
  await assertPathAbsent(path);
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (error?.code?.startsWith("local_unified_index_")) throw error;
    throw fixedError("local_unified_index_recovery_secret_copy_failed");
  } finally {
    await handle?.close();
  }
  return recoveryFileIdentity(path);
}

function tableExists(database, tableName) {
  return database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(tableName)?.present === 1;
}

function rowCount(database, tableName, generationId = null) {
  if (!tableExists(database, tableName)) return null;
  if (generationId === null) {
    return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
      .get().count);
  }
  return Number(database.prepare(
    `SELECT COUNT(*) AS count FROM ${tableName} WHERE generation_id = ?`,
  ).get(generationId).count);
}

function schemaVersion(database) {
  if (!tableExists(database, "meta")) return null;
  return database.prepare(
    "SELECT value FROM meta WHERE key = 'schema_version'",
  ).get()?.value ?? null;
}

/**
 * Validate a copy of any TiboTattle index without migrating it. This is used
 * for the rollback backup, which may intentionally be N-1 state.
 */
export async function validateLocalUnifiedIndexRecoveryBackup({ backupFile }) {
  await assertSafeLocalUnifiedIndexTarget(backupFile, { allowMissing: false });
  let database;
  try {
    database = new DatabaseSync(backupFile, { readOnly: true, timeout: 5_000 });
    const quickCheck = database.prepare("PRAGMA quick_check").get()?.quick_check;
    if (quickCheck !== "ok") {
      throw fixedError("local_unified_index_recovery_backup_integrity_failed");
    }
    const backupSchemaVersion = schemaVersion(database);
    const usageEvents = rowCount(database, "usage_event");
    if (!["local-unified-index-v1", LOCAL_UNIFIED_INDEX_SCHEMA_VERSION]
      .includes(backupSchemaVersion) || usageEvents === null) {
      throw fixedError("local_unified_index_recovery_backup_schema_invalid");
    }
    return Object.freeze({
      quickCheck,
      applicationId: Number(
        database.prepare("PRAGMA application_id").get()?.application_id,
      ),
      userVersion: Number(
        database.prepare("PRAGMA user_version").get()?.user_version,
      ),
      schemaVersion: backupSchemaVersion,
      counts: Object.freeze({
        usageEvents,
        quotaOccurrences: rowCount(database, "quota_occurrence"),
        toolFacts: rowCount(database, "tool_class_fact"),
      }),
    });
  } catch (error) {
    if (error?.code?.startsWith("local_unified_index_")) throw error;
    throw fixedError("local_unified_index_recovery_backup_unavailable");
  } finally {
    database?.close();
  }
}

function generationEligibleForApply(generation) {
  if (generation === null
      || generation.discoveryComplete !== true
      || generation.diagnosticsComplete !== true
      || generation.usageProvenanceComplete !== true
      || generation.sourceOrderComplete !== true
      || generation.quotaProvenanceComplete !== true) return false;
  if (generation.status === "complete") {
    return generation.toolProvenanceComplete === true;
  }
  if (generation.status !== "partial"
      || !ACCEPTED_PARTIAL_GENERATION_REASONS.has(generation.blockReason)) {
    return false;
  }
  if (generation.blockReason === "tool_provenance_incomplete") {
    return generation.toolProvenanceComplete === false;
  }
  return generation.skippedSourceCount > 0
    && generation.skippedThreadCount > 0;
}

/**
 * Validate the rebuilt candidate as current-schema, internally consistent,
 * generation-bound authority. No path is published by this operation.
 */
export async function validateLocalUnifiedIndexRecoveryCandidate({
  candidateFile,
  allowRecoveryLock = false,
}) {
  const metadata = await assertSafeLocalUnifiedIndexTarget(candidateFile, {
    allowMissing: false,
  });
  let database;
  try {
    database = openLocalUnifiedIndex(candidateFile, {
      readOnly: true,
      allowRecoveryLock,
    });
    const quickCheck = database.prepare("PRAGMA quick_check").get()?.quick_check;
    if (quickCheck !== "ok") {
      throw fixedError("local_unified_index_recovery_candidate_integrity_failed");
    }
    const foreignKeyViolation = database.prepare("PRAGMA foreign_key_check").get();
    if (foreignKeyViolation !== undefined) {
      throw fixedError("local_unified_index_recovery_candidate_foreign_key_failed");
    }
    const compatibility = readLocalUnifiedIndexCompatibility(database);
    if (!compatibility.metadataPresent
        || compatibility.metadataPartial
        || compatibility.metadataMalformed
        || compatibility.userVersion !== LOCAL_UNIFIED_INDEX_USER_VERSION
        || compatibility.formatUserVersion !== LOCAL_UNIFIED_INDEX_USER_VERSION
        || compatibility.minimumReaderUserVersion
          !== LOCAL_UNIFIED_INDEX_MINIMUM_READER_USER_VERSION
        || compatibility.minimumWriterUserVersion
          !== LOCAL_UNIFIED_INDEX_MINIMUM_WRITER_USER_VERSION) {
      throw fixedError("local_unified_index_recovery_candidate_compatibility_invalid");
    }
    const generation = readUnifiedIndexGenerationDescriptor(database);
    if (!generationEligibleForApply(generation)) {
      throw fixedError("local_unified_index_recovery_candidate_generation_invalid");
    }
    const actual = Object.freeze({
      usageEvents: rowCount(database, "usage_event", generation.id),
      quotaOccurrences: rowCount(database, "quota_occurrence", generation.id),
      toolFacts: rowCount(database, "tool_class_fact", generation.id),
      indexedSources: Number(database.prepare(`
        SELECT COUNT(*) AS count FROM generation_source
        WHERE generation_id = ? AND status <> 'failed'
      `).get(generation.id).count),
      indexedSourceBytes: Number(database.prepare(`
        SELECT COALESCE(SUM(discovered_size_bytes), 0) AS bytes
        FROM generation_source
        WHERE generation_id = ? AND status <> 'failed'
      `).get(generation.id).bytes),
    });
    const declared = Object.freeze({
      usageEvents: generation.usageEvents,
      quotaOccurrences: generation.quotaOccurrences,
      toolFacts: generation.toolFacts,
      indexedSources: generation.indexedSourceCount,
      indexedSourceBytes: generation.indexedSourceBytes,
    });
    if (Object.keys(actual).some((key) => actual[key] !== declared[key])) {
      throw fixedError("local_unified_index_recovery_candidate_counts_mismatch");
    }
    return Object.freeze({
      quickCheck,
      foreignKeyViolations: 0,
      schemaVersion: LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
      userVersion: compatibility.userVersion,
      compatibility,
      generation: Object.freeze({
        id: generation.id,
        fingerprint: generation.fingerprint,
        status: generation.status,
        blockReason: generation.blockReason,
      }),
      counts: actual,
      indexBytes: Number(metadata.size),
      eligibleForApply: true,
    });
  } catch (error) {
    if (error?.code?.startsWith("local_unified_index_")) throw error;
    throw fixedError("local_unified_index_recovery_candidate_unavailable");
  } finally {
    database?.close();
  }
}

async function createConsistentBackup(sourceFile, backupFile) {
  await assertSafeLocalUnifiedIndexTarget(sourceFile, { allowMissing: false });
  await assertPathAbsent(backupFile);
  let source;
  try {
    source = new DatabaseSync(sourceFile, { readOnly: true, timeout: 5_000 });
    await backup(source, backupFile);
    await syncOwnerOnlyFile(backupFile);
  } catch (error) {
    if (error?.code?.startsWith("local_unified_index_")) throw error;
    throw fixedError("local_unified_index_recovery_backup_failed");
  } finally {
    source?.close();
  }
}

async function createExactPrePublishRollback(sourceFile, rollbackFile) {
  await assertSafeLocalUnifiedIndexTarget(sourceFile, { allowMissing: false });
  await assertPathAbsent(rollbackFile);
  try {
    await copyFile(sourceFile, rollbackFile, constants.COPYFILE_EXCL);
    await syncOwnerOnlyFile(rollbackFile, 0o400);
    return recoveryFileIdentity(rollbackFile);
  } catch (error) {
    if (error?.code?.startsWith("local_unified_index_")) throw error;
    throw fixedError("local_unified_index_recovery_pre_publish_copy_failed");
  }
}

async function writeReceiptExclusive(receiptFile, receipt) {
  await assertPathAbsent(receiptFile);
  const handle = await open(
    receiptFile,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncOwnerOnlyFile(receiptFile, 0o400);
}

export function localUnifiedIndexRecoveryPaths(indexFile, recoveryDir) {
  const resolvedDirectory = resolve(recoveryDir);
  return Object.freeze({
    indexFile: resolve(indexFile),
    recoveryDir: resolvedDirectory,
    candidateFile: join(resolvedDirectory, RECOVERY_CANDIDATE_NAME),
    backupFile: join(resolvedDirectory, RECOVERY_BACKUP_NAME),
    receiptFile: join(resolvedDirectory, RECOVERY_RECEIPT_NAME),
    prePublishRollbackFile: join(
      resolvedDirectory,
      RECOVERY_PRE_PUBLISH_ROLLBACK_NAME,
    ),
    recoverySecretFile: join(resolvedDirectory, RECOVERY_SECRET_COPY_NAME),
  });
}

export function validateLocalUnifiedIndexRecoveryPaths({
  indexFile,
  candidateFile,
  backupFile,
  receiptFile,
}) {
  const resolved = [indexFile, candidateFile, backupFile, receiptFile]
    .map((path) => resolve(path));
  const recoveryDir = dirname(resolved[1]);
  const prePublishRollbackFile = join(
    recoveryDir,
    RECOVERY_PRE_PUBLISH_ROLLBACK_NAME,
  );
  const recoverySecretFile = join(recoveryDir, RECOVERY_SECRET_COPY_NAME);
  if (new Set([...resolved, prePublishRollbackFile, recoverySecretFile]).size
        !== resolved.length + 2
      || resolved.slice(2).some((path) => dirname(path) !== recoveryDir)
      || recoveryDir === dirname(resolved[0])
      || dirname(recoveryDir) !== dirname(resolved[0])) {
    throw fixedError("local_unified_index_recovery_paths_invalid");
  }
  return Object.freeze({
    indexFile: resolved[0],
    recoveryDir,
    candidateFile: resolved[1],
    backupFile: resolved[2],
    receiptFile: resolved[3],
    prePublishRollbackFile,
    recoverySecretFile,
  });
}

/**
 * Phase one: make a consistent rollback copy before rebuilding; build at a
 * separate path; then validate and record all identities. The live path is
 * never renamed or opened writable here.
 */
export async function prepareLocalUnifiedIndexRecovery({
  codexHome,
  indexFile,
  candidateFile,
  backupFile,
  receiptFile,
  secretFile,
  contractVersion,
  workerCount = 1,
  onProgress = null,
  dependencies = {},
}) {
  const paths = validateLocalUnifiedIndexRecoveryPaths({
    indexFile,
    candidateFile,
    backupFile,
    receiptFile,
  });
  // Reject WAL mode and any live SQLite journal before reading or creating
  // recovery state. A main-file copy or rename is not a complete database
  // operation while a live sidecar can carry committed pages.
  await assertRollbackJournalDatabase(paths.indexFile);
  // Validate and read the live identity before creating even the private
  // recovery directory. A missing, symlinked, shared or malformed live salt
  // is a terminal preflight failure and is never created/chmodded/repaired.
  const secretBefore = await readRecoverySecretSource(secretFile);
  await reserveRecoveryDirectory(paths.recoveryDir);
  const identify = dependencies.identify ?? recoveryFileIdentity;
  const createBackup = dependencies.createBackup ?? createConsistentBackup;
  const rebuild = dependencies.rebuild ?? rebuildLocalUnifiedIndex;
  const recoverySecretIdentity = await writeOwnerOnlyBytesExclusive(
    paths.recoverySecretFile,
    secretBefore.bytes,
  );
  if (!sameFileIdentity(recoverySecretIdentity, secretBefore.identity)) {
    throw fixedError("local_unified_index_recovery_secret_copy_failed");
  }
  const sourceIdentityBefore = await identify(paths.indexFile);
  await createBackup(paths.indexFile, paths.backupFile);
  await dependencies.afterBackup?.({ ...paths });
  await assertRollbackJournalDatabase(paths.indexFile);
  await assertRollbackJournalDatabase(paths.backupFile);
  const sourceIdentityAfter = await identify(paths.indexFile);
  if (!sameFileIdentity(sourceIdentityBefore, sourceIdentityAfter)) {
    throw fixedError("local_unified_index_recovery_source_changed_during_backup");
  }
  const backupValidation = await validateLocalUnifiedIndexRecoveryBackup({
    backupFile: paths.backupFile,
  });
  const backupIdentity = await identify(paths.backupFile);
  const rebuildResult = await rebuild({
    codexHome,
    indexFile: paths.candidateFile,
    secretFile: paths.recoverySecretFile,
    contractVersion,
    workerCount,
    onProgress,
  });
  await assertRollbackJournalDatabase(paths.candidateFile);
  const candidateValidation = await validateLocalUnifiedIndexRecoveryCandidate({
    candidateFile: paths.candidateFile,
  });
  await assertRollbackJournalDatabase(paths.candidateFile);
  const candidateIdentity = await identify(paths.candidateFile);
  const secretAfter = await readRecoverySecretSource(secretBefore.path, {
    missingCode: "local_unified_index_recovery_secret_changed",
    invalidCode: "local_unified_index_recovery_secret_changed",
  });
  if (!sameFileIdentity(secretBefore.identity, secretAfter.identity)) {
    throw fixedError("local_unified_index_recovery_secret_changed");
  }
  const receipt = sealReceipt({
    schemaVersion: LOCAL_UNIFIED_INDEX_RECOVERY_RECEIPT_VERSION,
    createdAt: new Date().toISOString(),
    recoveryDirectory: paths.recoveryDir,
    source: { path: paths.indexFile, identity: sourceIdentityAfter },
    secret: {
      sourcePath: secretAfter.path,
      sourceIdentity: secretAfter.identity,
      recoveryCopyPath: paths.recoverySecretFile,
      recoveryCopyIdentity: recoverySecretIdentity,
    },
    backup: {
      path: paths.backupFile,
      identity: backupIdentity,
      validation: backupValidation,
    },
    candidate: {
      path: paths.candidateFile,
      identity: candidateIdentity,
      validation: candidateValidation,
    },
    prePublishRollback: {
      path: paths.prePublishRollbackFile,
      status: "planned",
    },
    rebuild: {
      status: rebuildResult.status,
      sources: rebuildResult.sources,
      sourceBytes: rebuildResult.sourceBytes,
      workerCount: rebuildResult.workerCount,
      wallMs: rebuildResult.wallMs,
    },
  });
  await writeReceiptExclusive(paths.receiptFile, receipt);
  return Object.freeze({ ...receipt, receiptFile: paths.receiptFile });
}

function assertReceiptShape(receipt) {
  const { receiptSha256, ...body } = receipt ?? {};
  if (receipt?.schemaVersion !== LOCAL_UNIFIED_INDEX_RECOVERY_RECEIPT_VERSION
      || typeof receipt?.recoveryDirectory !== "string"
      || typeof receipt?.source?.path !== "string"
      || typeof receipt?.secret?.sourcePath !== "string"
      || typeof receipt?.secret?.sourceIdentity?.sha256 !== "string"
      || typeof receipt?.secret?.recoveryCopyPath !== "string"
      || typeof receipt?.secret?.recoveryCopyIdentity?.sha256 !== "string"
      || typeof receipt?.backup?.path !== "string"
      || typeof receipt?.candidate?.path !== "string"
      || typeof receipt?.prePublishRollback?.path !== "string"
      || receipt?.prePublishRollback?.status !== "planned"
      || typeof receiptSha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(receiptSha256)
      || receiptDigest(body) !== receiptSha256) {
    throw fixedError("local_unified_index_recovery_receipt_invalid");
  }
}

/**
 * Phase two: revalidate the immutable receipt, rollback copy, source and
 * candidate, then atomically publish. Both confirmation flags are mandatory;
 * callers must stop TiboTattle first so no process retains the replaced inode.
 */
export async function applyLocalUnifiedIndexRecovery({
  indexFile,
  candidateFile,
  receiptFile,
  confirmIndex,
  confirmAppStopped = false,
  dependencies = {},
}) {
  if (!confirmAppStopped) {
    throw fixedError("local_unified_index_recovery_app_stop_unconfirmed");
  }
  if (typeof confirmIndex !== "string" || confirmIndex.length < 1) {
    throw fixedError("local_unified_index_recovery_confirmation_mismatch");
  }
  const resolvedIndex = resolve(indexFile);
  const resolvedCandidate = resolve(candidateFile);
  if (resolve(confirmIndex) !== resolvedIndex) {
    throw fixedError("local_unified_index_recovery_confirmation_mismatch");
  }
  if (Object.hasOwn(dependencies, "publish")
      || Object.hasOwn(dependencies, "afterFinalRecheck")) {
    // Publication is a trusted, non-injectable boundary. Test-only behavior
    // may observe immediately before/after it through the narrow hooks below,
    // but may never replace the rename implementation itself.
    throw fixedError("local_unified_index_recovery_publish_override_forbidden");
  }
  let receipt;
  try {
    await assertSafeLocalUnifiedIndexTarget(receiptFile, { allowMissing: false });
    receipt = JSON.parse(await readFile(receiptFile, "utf8"));
  } catch {
    throw fixedError("local_unified_index_recovery_receipt_invalid");
  }
  assertReceiptShape(receipt);
  const paths = validateLocalUnifiedIndexRecoveryPaths({
    indexFile: receipt.source.path,
    candidateFile: receipt.candidate.path,
    backupFile: receipt.backup.path,
    receiptFile,
  });
  if (paths.indexFile !== resolvedIndex
      || paths.candidateFile !== resolvedCandidate
      || resolve(receipt.recoveryDirectory) !== paths.recoveryDir
      || resolve(receipt.secret.recoveryCopyPath) !== paths.recoverySecretFile
      || resolve(receipt.prePublishRollback.path)
        !== paths.prePublishRollbackFile) {
    throw fixedError("local_unified_index_recovery_receipt_mismatch");
  }
  await validateRecoveryDirectory(paths.recoveryDir);
  // This check precedes even the cooperating-process sidecar lock, so a WAL
  // source/candidate is rejected without adding or removing recovery state.
  await assertRollbackJournalDatabase(resolvedIndex);
  await assertRollbackJournalDatabase(resolvedCandidate);
  await assertRollbackJournalDatabase(paths.backupFile);
  const identify = dependencies.identify ?? recoveryFileIdentity;
  const copyPrePublish = dependencies.copyPrePublish
    ?? createExactPrePublishRollback;
  const lock = await acquireRecoveryLock(resolvedIndex);
  let writerExclusions = null;
  let publicationCompleted = false;
  let operationError = null;
  try {
    await dependencies.onLocked?.({ ...paths, lockFile: lock.lockFile });
    // Recheck after the testable/cooperative-lock boundary. This closes the
    // exact case where a non-cooperating process switches the source to WAL
    // or commits into an already-open WAL before receipt validation.
    await assertRollbackJournalDatabase(resolvedIndex);
    await assertRollbackJournalDatabase(resolvedCandidate);
    await assertRollbackJournalDatabase(paths.backupFile);
    const secretSource = await readRecoverySecretSource(
      receipt.secret.sourcePath,
      {
        missingCode: "local_unified_index_recovery_secret_changed",
        invalidCode: "local_unified_index_recovery_secret_changed",
      },
    );
    const [sourceIdentity, backupIdentity, candidateIdentity,
      recoverySecretIdentity] = await Promise.all([
        identify(resolvedIndex),
        identify(paths.backupFile),
        identify(resolvedCandidate),
        identify(paths.recoverySecretFile),
      ]);
    if (!sameFileIdentity(sourceIdentity, receipt.source.identity)) {
      throw fixedError("local_unified_index_recovery_source_changed");
    }
    if (!sameFileIdentity(backupIdentity, receipt.backup.identity)) {
      throw fixedError("local_unified_index_recovery_backup_changed");
    }
    if (!sameFileIdentity(candidateIdentity, receipt.candidate.identity)) {
      throw fixedError("local_unified_index_recovery_candidate_changed");
    }
    if (!sameFileIdentity(secretSource.identity, receipt.secret.sourceIdentity)
        || !sameFileIdentity(
          recoverySecretIdentity,
          receipt.secret.recoveryCopyIdentity,
        )
        || !sameFileIdentity(secretSource.identity, recoverySecretIdentity)) {
      throw fixedError("local_unified_index_recovery_secret_changed");
    }
    await validateLocalUnifiedIndexRecoveryBackup({
      backupFile: paths.backupFile,
    });
    const validation = await validateLocalUnifiedIndexRecoveryCandidate({
      candidateFile: resolvedCandidate,
    });
    if (validation.generation.fingerprint
        !== receipt.candidate.validation?.generation?.fingerprint
        || JSON.stringify(validation.counts)
          !== JSON.stringify(receipt.candidate.validation?.counts)) {
      throw fixedError("local_unified_index_recovery_candidate_changed");
    }
    await assertRollbackJournalDatabase(resolvedIndex);
    await assertRollbackJournalDatabase(resolvedCandidate);
    await assertRollbackJournalDatabase(paths.backupFile);

    // The sidecar lock excludes cooperating TiboTattle opens, but cannot stop
    // a direct SQLite connection. Hold writer transactions on both the live
    // and candidate inodes from the exact rollback copy through rename and
    // post-publication validation. This excludes commits during that window;
    // the stopped-app attestation remains mandatory because SQLite cannot
    // revoke a non-cooperating process that retained the replaced old inode.
    writerExclusions = await acquirePublicationWriterExclusions({
      sourceFile: resolvedIndex,
      candidateFile: resolvedCandidate,
    });
    await assertRollbackJournalDatabase(resolvedIndex);
    await assertRollbackJournalDatabase(resolvedCandidate);

    // Preserve the exact reviewed live bytes immediately before replacement.
    // This is intentionally additional to the online SQLite backup: even a
    // durability-uncertain rename can never erase the pre-publish file.
    const rollbackIdentity = await copyPrePublish(
      resolvedIndex,
      paths.prePublishRollbackFile,
    );
    await assertRollbackJournalDatabase(paths.prePublishRollbackFile);
    await validateLocalUnifiedIndexRecoveryBackup({
      backupFile: paths.prePublishRollbackFile,
    });
    if (!sameFileIdentity(rollbackIdentity, receipt.source.identity)) {
      throw fixedError("local_unified_index_recovery_source_changed");
    }

    await dependencies.beforeFinalRecheck?.({ ...paths, lockFile: lock.lockFile });
    await assertRollbackJournalDatabase(resolvedIndex);
    await assertRollbackJournalDatabase(resolvedCandidate);
    await assertRollbackJournalDatabase(paths.backupFile);
    await assertRollbackJournalDatabase(paths.prePublishRollbackFile);
    // These hashes are deliberately the final operation before rename. The
    // sidecar blocks cooperating app opens/publications, while the live and
    // candidate SQLite transactions exclude direct commits to either inode.
    const secretSourceFinal = await readRecoverySecretSource(
      receipt.secret.sourcePath,
      {
        missingCode: "local_unified_index_recovery_secret_changed",
        invalidCode: "local_unified_index_recovery_secret_changed",
      },
    );
    const [sourceFinal, backupFinal, candidateFinal, rollbackFinal,
      recoverySecretFinal] = await Promise.all([
        identify(resolvedIndex),
        identify(paths.backupFile),
        identify(resolvedCandidate),
        identify(paths.prePublishRollbackFile),
        identify(paths.recoverySecretFile),
      ]);
    if (!sameFileIdentity(sourceFinal, receipt.source.identity)
        || !sameFileIdentity(rollbackFinal, receipt.source.identity)) {
      throw fixedError("local_unified_index_recovery_source_changed");
    }
    if (!sameFileIdentity(backupFinal, receipt.backup.identity)) {
      throw fixedError("local_unified_index_recovery_backup_changed");
    }
    if (!sameFileIdentity(candidateFinal, receipt.candidate.identity)) {
      throw fixedError("local_unified_index_recovery_candidate_changed");
    }
    if (!sameFileIdentity(
      secretSourceFinal.identity,
      receipt.secret.sourceIdentity,
    ) || !sameFileIdentity(
      recoverySecretFinal,
      receipt.secret.recoveryCopyIdentity,
    ) || !sameFileIdentity(secretSourceFinal.identity, recoverySecretFinal)) {
      throw fixedError("local_unified_index_recovery_secret_changed");
    }
    await assertRollbackJournalDatabase(resolvedIndex);
    await assertRollbackJournalDatabase(resolvedCandidate);
    await assertRollbackJournalDatabase(paths.backupFile);
    await assertRollbackJournalDatabase(paths.prePublishRollbackFile);
    let published = false;
    let publishedValidation;
    try {
      trustedPublishRecoveryCandidateSync(
        resolvedCandidate,
        resolvedIndex,
        {
          expectedSourceIdentity: receipt.source.identity,
          expectedCandidateIdentity: receipt.candidate.identity,
        },
      );
      published = true;
      publicationCompleted = true;
      await dependencies.afterPublication?.({
        ...paths,
        lockFile: lock.lockFile,
      });
      await assertRollbackJournalDatabase(resolvedIndex);
      publishedValidation = await validateLocalUnifiedIndexRecoveryCandidate({
        candidateFile: resolvedIndex,
        allowRecoveryLock: true,
      });
      await assertRollbackJournalDatabase(resolvedIndex);
      const publishedIdentity = await identify(resolvedIndex);
      if (!sameFileIdentity(publishedIdentity, receipt.candidate.identity)) {
        throw fixedError("local_unified_index_recovery_publication_changed");
      }
    } catch (error) {
      if (published || error?.published === true) {
        throw publicationStateUncertain(error, paths);
      }
      throw error;
    }
    return Object.freeze({
      status: "applied",
      indexFile: resolvedIndex,
      backupFile: paths.backupFile,
      prePublishRollbackFile: paths.prePublishRollbackFile,
      prePublishRollbackIdentity: rollbackIdentity,
      receiptFile: resolve(receiptFile),
      validation: publishedValidation,
    });
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let releaseFailure = null;
    if (writerExclusions !== null) {
      try {
        writerExclusions.release();
      } catch (releaseError) {
        if (operationError !== null) {
          operationError.sqliteWriterLockReleaseError =
            releaseError?.code ?? "unknown";
        } else {
          releaseFailure = releaseError;
        }
      }
    }
    try {
      await lock.release();
    } catch (releaseError) {
      if (operationError !== null) {
        operationError.recoveryLockReleaseError = releaseError?.code ?? "unknown";
      } else if (releaseFailure !== null) {
        releaseFailure.recoveryLockReleaseError =
          releaseError?.code ?? "unknown";
      } else {
        releaseFailure = releaseError;
      }
    }
    if (operationError === null && releaseFailure !== null) {
      if (publicationCompleted) {
        throw publicationStateUncertain(releaseFailure, paths);
      }
      throw releaseFailure;
    }
  }
}
