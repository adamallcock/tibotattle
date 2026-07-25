import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { homedir } from "node:os";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  unlink,
  chmod,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { ClaudeStatuslineError, validateClaudeStatusSnapshot } from "./claude-statusline.js";

export const DEFAULT_CLAUDE_STATUS_MAX_RECORDS = 20_000;
export const DEFAULT_CLAUDE_STATUS_MAX_LEDGER_BYTES = 32 * 1024 * 1024;
export const MAX_CLAUDE_STATUS_RECORD_BYTES = 4096;
const RECORD_NAME = /^\d{8}T\d{9}Z-[0-9a-f]{8}-[0-9a-f-]{27}\.json$/;
const PENDING_NAME = /^\.pending-[0-9a-f-]{36}$/;
const LOCK_NAME = ".writer.lock";
const LOCK_MAX_AGE_MILLISECONDS = 5 * 60 * 1000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function fail(code) {
  throw new ClaudeStatuslineError(code);
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function assertOwner(stats, typeCode, mode) {
  if (typeCode === "directory" ? !stats.isDirectory() : !stats.isFile()) fail(`state_${typeCode}_type`);
  const uid = currentUid();
  if (uid !== null && stats.uid !== uid) fail(`state_${typeCode}_owner`);
  if (process.platform !== "win32" && (stats.mode & 0o777) !== mode) fail(`state_${typeCode}_mode`);
  if (typeCode === "file" && stats.nlink !== 1) fail("state_file_links");
}

async function safeLstat(path, missingCode = null) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT" && missingCode === null) return null;
    fail(missingCode ?? "state_io");
  }
}

function assertSafeDirectoryComponent(stats, { ownerOnly = false } = {}) {
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail("state_parent_type");
  const uid = currentUid();
  if (uid !== null) {
    if (ownerOnly && stats.uid !== uid) fail("state_parent_owner");
    if (!ownerOnly && stats.uid !== uid && stats.uid !== 0) fail("state_parent_owner");
  }
  if (process.platform === "win32") return;
  const mode = stats.mode & 0o7777;
  if (ownerOnly) {
    if ((mode & 0o077) !== 0 || (mode & 0o100) === 0) fail("state_parent_mode");
    return;
  }
  // Root-owned sticky temporary roots are safe traversal anchors; ordinary
  // group/world-writable ancestors are not.
  if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) fail("state_parent_mode");
}

function directoryChain(target) {
  const root = parse(target).root;
  const suffix = relative(root, target);
  const parts = suffix === "" ? [] : suffix.split(sep).filter(Boolean);
  const chain = [root];
  for (const part of parts) chain.push(join(chain[chain.length - 1], part));
  return chain;
}

async function ensureDirectory(path) {
  const target = resolveStateDirectory(path);
  const targetParent = dirname(target);
  const chain = directoryChain(target);
  for (const component of chain) {
    let stats = await safeLstat(component);
    if (!stats) {
      let created = false;
      try {
        await mkdir(component, { mode: 0o700 });
        created = true;
      } catch (error) {
        if (error?.code !== "EEXIST") fail("state_directory_create");
      }
      if (created) await chmod(component, 0o700).catch(() => fail("state_directory_create"));
      stats = await safeLstat(component, "state_directory_missing");
    }
    if (component === target) assertOwner(stats, "directory", 0o700);
    else assertSafeDirectoryComponent(stats, { ownerOnly: component === targetParent });
  }
  await validateExistingDirectoryChain(target);
}

async function validateExistingDirectoryChain(target) {
  const targetParent = dirname(target);
  const chain = directoryChain(target);
  // A second component walk plus canonical equality catches aliases or a
  // parent changed during creation. Node does not expose portable openat-style
  // directory-relative operations, so transient same-UID swaps remain outside
  // this local POC trust boundary.
  for (const component of chain) {
    const stats = await safeLstat(component, "state_directory_missing");
    if (component === target) assertOwner(stats, "directory", 0o700);
    else assertSafeDirectoryComponent(stats, { ownerOnly: component === targetParent });
  }
  let canonical;
  try {
    canonical = await realpath(target);
  } catch {
    fail("state_directory_missing");
  }
  if (canonical !== target) fail("state_parent_alias");
}

function sameIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

async function snapshotOwnerDirectory(path) {
  const stats = await safeLstat(path, "state_directory_missing");
  assertOwner(stats, "directory", 0o700);
  return { dev: stats.dev, ino: stats.ino };
}

async function assertDirectoryIdentity(path, expected) {
  const stats = await safeLstat(path, "state_directory_missing");
  assertOwner(stats, "directory", 0o700);
  if (!sameIdentity(stats, expected)) fail("state_directory_replaced");
  return stats;
}

async function unlinkExactOwnerFile(path, expected) {
  const current = await safeLstat(path);
  if (!current || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || !sameIdentity(current, expected)) return;
  const uid = currentUid();
  if (uid !== null && current.uid !== uid) return;
  try {
    await unlink(path);
  } catch {
    // Cleanup is best-effort; the primary fail-closed error remains authoritative.
  }
}

async function invokeFailpoint(failpoint, point, detail = null) {
  try {
    await failpoint(point, detail);
  } catch {
    fail("injected_failure");
  }
}

async function readHandleBounded(handle, maximumBytes, code) {
  const bytes = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  while (offset <= maximumBytes) {
    let result;
    try {
      result = await handle.read(bytes, offset, bytes.byteLength - offset, null);
    } catch {
      fail(code);
    }
    if (result.bytesRead === 0) return bytes.subarray(0, offset);
    offset += result.bytesRead;
    if (offset > maximumBytes) fail(code);
  }
  fail(code);
}

async function syncDirectory(path, expectedIdentity = null) {
  if (process.platform === "win32") return;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const opened = await handle.stat();
    assertOwner(opened, "directory", 0o700);
    if (expectedIdentity && !sameIdentity(opened, expectedIdentity)) fail("state_directory_replaced");
    await handle.sync();
    if (expectedIdentity) await assertDirectoryIdentity(path, expectedIdentity);
  } catch {
    fail("state_sync");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function assertBounds(maxRecords, maxLedgerBytes) {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 1_000_000) fail("ledger_bound");
  if (!Number.isSafeInteger(maxLedgerBytes)
      || maxLedgerBytes < MAX_CLAUDE_STATUS_RECORD_BYTES
      || maxLedgerBytes > 1024 * 1024 * 1024) fail("ledger_bound");
}

export function defaultClaudeStatusStateDirectory({
  platform = process.platform,
  env = process.env,
  homeDirectory = homedir(),
} = {}) {
  if (typeof homeDirectory !== "string" || !isAbsolute(homeDirectory)) fail("state_home");
  let base;
  if (platform === "darwin") {
    base = join(homeDirectory, "Library", "Application Support");
  } else if (platform === "win32") {
    base = env.LOCALAPPDATA;
    if (typeof base !== "string" || !isAbsolute(base)) base = join(homeDirectory, "AppData", "Local");
  } else {
    base = env.XDG_STATE_HOME;
    if (base !== undefined && (typeof base !== "string" || !isAbsolute(base))) fail("state_root");
    if (base === undefined) base = join(homeDirectory, ".local", "state");
  }
  return join(base, "app-usagemonitor", "claude-statusline-v0.2");
}

function resolveStateDirectory(value) {
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 4096) fail("state_path");
  return resolve(value);
}

async function createLock(stateDirectory, stateIdentity, retryMilliseconds = 2000, failpoint = async () => {}) {
  const lockPath = join(stateDirectory, LOCK_NAME);
  const deadline = Date.now() + retryMilliseconds;
  while (true) {
    let handle;
    let createdIdentity = null;
    try {
      await assertDirectoryIdentity(stateDirectory, stateIdentity);
      await invokeFailpoint(failpoint, "before_lock_open");
      handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      await handle.chmod(0o600);
      const created = await handle.stat();
      createdIdentity = { dev: created.dev, ino: created.ino };
      await assertDirectoryIdentity(stateDirectory, stateIdentity);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.sync();
      const stats = await handle.stat();
      assertOwner(stats, "file", 0o600);
      await assertDirectoryIdentity(stateDirectory, stateIdentity);
      return { path: lockPath, handle, dev: stats.dev, ino: stats.ino, stateDirectory, stateIdentity };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (createdIdentity) await unlinkExactOwnerFile(lockPath, createdIdentity);
      if (error instanceof ClaudeStatuslineError) throw error;
      if (error?.code !== "EEXIST") fail("state_lock");
      await assertDirectoryIdentity(stateDirectory, stateIdentity);
      const stats = await safeLstat(lockPath);
      if (!stats) continue;
      // A releasing writer can unlink after path resolution but before lstat
      // returns its snapshot. On macOS that transient inode may report zero
      // links. It is no longer reachable and is a retry, not a hostile
      // hard-link substitution. Counts above one still fail closed below.
      if (stats.nlink === 0) continue;
      assertOwner(stats, "file", 0o600);
      if (await reapDeadLock(lockPath, stats, stateIdentity)) continue;
      if (Date.now() >= deadline) fail("state_busy");
      await new Promise((done) => setTimeout(done, 10));
    }
  }
}

async function reapDeadLock(lockPath, expectedStats, directoryIdentity) {
  let handle;
  try {
    await assertDirectoryIdentity(dirname(lockPath), directoryIdentity);
    handle = await open(lockPath, constants.O_RDONLY | NOFOLLOW);
    const opened = await handle.stat();
    // The previous writer may have released this inode between our lstat and
    // open. Treat an unlinked/replaced handle as a retry, not as corruption.
    if (opened.dev !== expectedStats.dev || opened.ino !== expectedStats.ino || opened.nlink === 0) return false;
    assertOwner(opened, "file", 0o600);
    if (opened.size > 32) return false;
    const text = (await readHandleBounded(handle, 32, "state_lock")).toString("utf8");
    const afterRead = await handle.stat();
    if (!sameIdentity(afterRead, opened) || afterRead.size !== opened.size || afterRead.nlink !== 1) return false;
    await assertDirectoryIdentity(dirname(lockPath), directoryIdentity);
    const validOwner = /^[1-9]\d{0,9}\n$/.test(text);
    const oldEnoughToBeAbandoned = Date.now() - opened.mtimeMs > LOCK_MAX_AGE_MILLISECONDS;
    if (!validOwner && !oldEnoughToBeAbandoned) return false;
    let alive = false;
    if (validOwner) {
      alive = true;
      try {
        process.kill(Number.parseInt(text, 10), 0);
      } catch (error) {
        if (error?.code === "ESRCH") alive = false;
      }
    }
    // A syntactically valid lock belongs to its PID until the OS confirms that
    // PID does not exist. Age is only a recovery signal for malformed locks.
    if (validOwner && alive) return false;
    const current = await safeLstat(lockPath);
    if (!current || current.dev !== opened.dev || current.ino !== opened.ino || current.nlink !== 1) return false;
    await unlink(lockPath);
    await syncDirectory(dirname(lockPath), directoryIdentity);
    return true;
  } catch (error) {
    if (error instanceof ClaudeStatuslineError) throw error;
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function releaseLock(lock) {
  await lock.handle.close().catch(() => {});
  await assertDirectoryIdentity(lock.stateDirectory, lock.stateIdentity);
  const stats = await safeLstat(lock.path);
  if (!stats) return;
  if (stats.dev !== lock.dev || stats.ino !== lock.ino || !stats.isFile() || stats.nlink !== 1) fail("state_lock_replaced");
  try {
    await unlink(lock.path);
  } catch {
    fail("state_lock_release");
  }
  await syncDirectory(lock.stateDirectory, lock.stateIdentity);
}

function recordFileName(capturedAt, uuid) {
  return `${capturedAt.replaceAll("-", "").replaceAll(":", "").replace(".", "")}-${uuid.slice(0, 8)}-${uuid.slice(9)}.json`;
}

async function listLedger(recordsDirectory, {
  cleanPending = false,
  directoryIdentity = null,
  maximumEntries = DEFAULT_CLAUDE_STATUS_MAX_RECORDS + 64,
} = {}) {
  if (directoryIdentity) await assertDirectoryIdentity(recordsDirectory, directoryIdentity);
  const names = [];
  try {
    const directory = await opendir(recordsDirectory);
    for await (const entry of directory) {
      names.push(entry.name);
      if (names.length > maximumEntries) fail("ledger_bound_exceeded");
    }
  } catch (error) {
    if (error instanceof ClaudeStatuslineError) throw error;
    fail("ledger_read");
  }
  const records = [];
  for (const name of names.sort()) {
    const path = join(recordsDirectory, name);
    if (PENDING_NAME.test(name)) {
      const stats = await safeLstat(path, "pending_missing");
      assertOwner(stats, "file", 0o600);
      if (cleanPending) {
        if (directoryIdentity) await assertDirectoryIdentity(recordsDirectory, directoryIdentity);
        const current = await safeLstat(path, "pending_missing");
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || !sameIdentity(current, stats)) {
          fail("pending_replaced");
        }
        try {
          await unlink(path);
        } catch {
          fail("pending_cleanup");
        }
        if (directoryIdentity) await assertDirectoryIdentity(recordsDirectory, directoryIdentity);
      }
      continue;
    }
    if (!RECORD_NAME.test(name)) fail("ledger_entry");
    const stats = await safeLstat(path, "record_missing");
    assertOwner(stats, "file", 0o600);
    if (stats.size < 2 || stats.size > MAX_CLAUDE_STATUS_RECORD_BYTES) fail("record_size");
    records.push({ name, path, size: stats.size, dev: stats.dev, ino: stats.ino });
  }
  if (directoryIdentity) await assertDirectoryIdentity(recordsDirectory, directoryIdentity);
  return records;
}

async function pruneLedger(recordsDirectory, directoryIdentity, records, maxRecords, maxLedgerBytes) {
  let totalBytes = records.reduce((sum, record) => sum + record.size, 0);
  while (records.length > maxRecords || totalBytes > maxLedgerBytes) {
    const oldest = records.shift();
    await assertDirectoryIdentity(recordsDirectory, directoryIdentity);
    const current = await safeLstat(oldest.path, "record_missing");
    if (!current.isFile() || current.nlink !== 1 || current.dev !== oldest.dev || current.ino !== oldest.ino) fail("record_replaced");
    try {
      await unlink(oldest.path);
    } catch {
      fail("record_prune");
    }
    await assertDirectoryIdentity(recordsDirectory, directoryIdentity);
    totalBytes -= oldest.size;
  }
  await syncDirectory(recordsDirectory, directoryIdentity);
}

export async function writeClaudeStatusSnapshot(snapshot, {
  stateDirectory = defaultClaudeStatusStateDirectory(),
  maxRecords = DEFAULT_CLAUDE_STATUS_MAX_RECORDS,
  maxLedgerBytes = DEFAULT_CLAUDE_STATUS_MAX_LEDGER_BYTES,
  uuid = randomUUID(),
  lockRetryMilliseconds = 2000,
  failpoint = async () => {},
} = {}) {
  const normalizedSnapshot = validateClaudeStatusSnapshot(snapshot);
  assertBounds(maxRecords, maxLedgerBytes);
  if (typeof uuid !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) fail("record_id");
  if (!Number.isSafeInteger(lockRetryMilliseconds) || lockRetryMilliseconds < 0 || lockRetryMilliseconds > 10_000) fail("state_lock_bound");
  if (typeof failpoint !== "function") fail("failpoint_type");
  const normalizedUuid = uuid.toLowerCase();
  const root = resolveStateDirectory(stateDirectory);
  await ensureDirectory(root);
  const recordsDirectory = join(root, "records");
  await ensureDirectory(recordsDirectory);
  const rootIdentity = await snapshotOwnerDirectory(root);
  const recordsIdentity = await snapshotOwnerDirectory(recordsDirectory);
  const lock = await createLock(root, rootIdentity, lockRetryMilliseconds, failpoint);
  let primaryError = null;
  try {
    await assertDirectoryIdentity(root, rootIdentity);
    await listLedger(recordsDirectory, {
      cleanPending: true,
      directoryIdentity: recordsIdentity,
      maximumEntries: maxRecords + 64,
    });
    const bytes = Buffer.from(`${JSON.stringify(normalizedSnapshot)}\n`, "utf8");
    if (bytes.byteLength > MAX_CLAUDE_STATUS_RECORD_BYTES || bytes.byteLength > maxLedgerBytes) fail("record_size");
    const records = await listLedger(recordsDirectory, {
      directoryIdentity: recordsIdentity,
      maximumEntries: maxRecords + 64,
    });
    await pruneLedger(recordsDirectory, recordsIdentity, records, maxRecords - 1, maxLedgerBytes - bytes.byteLength);
    const pendingPath = join(recordsDirectory, `.pending-${normalizedUuid}`);
    const finalPath = join(recordsDirectory, recordFileName(normalizedSnapshot.capturedAt, normalizedUuid));
    if (await safeLstat(finalPath)) fail("record_exists");
    let handle;
    let createdIdentity = null;
    try {
      await assertDirectoryIdentity(recordsDirectory, recordsIdentity);
      await invokeFailpoint(failpoint, "before_pending_open");
      handle = await open(pendingPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      await handle.chmod(0o600);
      const created = await handle.stat();
      createdIdentity = { dev: created.dev, ino: created.ino };
      await assertDirectoryIdentity(recordsDirectory, recordsIdentity);
      await handle.writeFile(bytes);
      await handle.sync();
      const stats = await handle.stat();
      assertOwner(stats, "file", 0o600);
      if (stats.size !== bytes.byteLength) fail("record_write");
      await assertDirectoryIdentity(recordsDirectory, recordsIdentity);
    } catch (error) {
      await handle?.close().catch(() => {});
      handle = null;
      if (createdIdentity) await unlinkExactOwnerFile(pendingPath, createdIdentity);
      if (error instanceof ClaudeStatuslineError) throw error;
      fail("record_write");
    } finally {
      await handle?.close().catch(() => {});
    }
    await assertDirectoryIdentity(recordsDirectory, recordsIdentity);
    const pending = await safeLstat(pendingPath, "pending_missing");
    assertOwner(pending, "file", 0o600);
    if (!createdIdentity || !sameIdentity(pending, createdIdentity) || pending.size !== bytes.byteLength) fail("pending_replaced");
    await invokeFailpoint(failpoint, "before_record_publish");
    try {
      await rename(pendingPath, finalPath);
    } catch {
      fail("record_publish");
    }
    const published = await safeLstat(finalPath, "record_missing");
    assertOwner(published, "file", 0o600);
    if (!sameIdentity(published, createdIdentity) || published.size !== bytes.byteLength) fail("record_publish");
    await assertDirectoryIdentity(recordsDirectory, recordsIdentity);
    await syncDirectory(recordsDirectory, recordsIdentity);
    await assertDirectoryIdentity(root, rootIdentity);
    return { stateDirectory: root, recordsDirectory, recordFile: finalPath };
  } catch (error) {
    primaryError = error instanceof ClaudeStatuslineError ? error : new ClaudeStatuslineError("state_io");
    throw primaryError;
  } finally {
    try {
      await releaseLock(lock);
    } catch (releaseError) {
      if (!primaryError) throw releaseError;
    }
  }
}

export async function readClaudeStatusSnapshots({
  stateDirectory = defaultClaudeStatusStateDirectory(),
  maxRecords = DEFAULT_CLAUDE_STATUS_MAX_RECORDS,
  maxLedgerBytes = DEFAULT_CLAUDE_STATUS_MAX_LEDGER_BYTES,
  failpoint = async () => {},
} = {}) {
  assertBounds(maxRecords, maxLedgerBytes);
  if (typeof failpoint !== "function") fail("failpoint_type");
  const root = resolveStateDirectory(stateDirectory);
  await validateExistingDirectoryChain(root);
  const rootStats = await safeLstat(root, "state_directory_missing");
  assertOwner(rootStats, "directory", 0o700);
  const rootIdentity = { dev: rootStats.dev, ino: rootStats.ino };
  const recordsDirectory = join(root, "records");
  const recordsStats = await safeLstat(recordsDirectory, "state_directory_missing");
  assertOwner(recordsStats, "directory", 0o700);
  const recordsIdentity = { dev: recordsStats.dev, ino: recordsStats.ino };
  const records = await listLedger(recordsDirectory, {
    directoryIdentity: recordsIdentity,
    maximumEntries: maxRecords + 64,
  });
  if (records.length > maxRecords || records.reduce((sum, record) => sum + record.size, 0) > maxLedgerBytes) fail("ledger_bound_exceeded");
  const snapshots = [];
  for (const record of records) {
    await assertDirectoryIdentity(recordsDirectory, recordsIdentity);
    await invokeFailpoint(failpoint, "before_record_open", record.name);
    let handle;
    let bytes;
    try {
      handle = await open(record.path, constants.O_RDONLY | NOFOLLOW);
      const opened = await handle.stat();
      assertOwner(opened, "file", 0o600);
      if (!sameIdentity(opened, record) || opened.size !== record.size) fail("record_replaced");
      bytes = await readHandleBounded(handle, MAX_CLAUDE_STATUS_RECORD_BYTES, "record_size");
      const afterRead = await handle.stat();
      assertOwner(afterRead, "file", 0o600);
      if (!sameIdentity(afterRead, opened) || afterRead.size !== opened.size || bytes.byteLength !== opened.size) fail("record_replaced");
    } catch (error) {
      if (error instanceof ClaudeStatuslineError) throw error;
      fail("record_read");
    } finally {
      await handle?.close().catch(() => {});
    }
    await assertDirectoryIdentity(recordsDirectory, recordsIdentity);
    if (bytes.byteLength !== record.size || bytes[bytes.length - 1] !== 0x0a) fail("record_torn");
    let snapshot;
    try {
      snapshot = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("record_json");
    }
    validateClaudeStatusSnapshot(snapshot);
    snapshots.push(snapshot);
  }
  await assertDirectoryIdentity(recordsDirectory, recordsIdentity);
  await assertDirectoryIdentity(root, rootIdentity);
  return snapshots;
}
