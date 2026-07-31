import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isProxy } from "node:util/types";
import { assertOwnerControlledDirectory, syncDirectory } from "./owner-only-filesystem.js";

function invalid() { throw new TypeError("Owner-only workspace discard storage configuration is invalid"); }
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
  if (depth > 16) invalid();
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object" || isProxy(value)) invalid();
  if (Array.isArray(value)) return dataArray(value, depth);
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null)
      || Object.getOwnPropertySymbols(value).length > 0) invalid();
  const snapshot = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    Object.defineProperty(snapshot, key, {
      value: data(own(value, key), depth + 1), enumerable: true, writable: true, configurable: true,
    });
  }
  return Object.freeze(snapshot);
}
function functionOption(value) { return callable(value); }
function safeDiscardOptions(value, recovery = false, defaults = {}) {
  const allowed = recovery ? ["workspaceDirectory", "failpoint", "linkFile", "withLease"]
    : ["workspaceDirectory", "confirmationToken", "failpoint", "linkFile", "withLease"];
  const options = exactOptions(value, allowed);
  if (typeof options.workspaceDirectory !== "string" || options.workspaceDirectory.length < 1) invalid();
  if (!recovery && typeof options.confirmationToken !== "string") invalid();
  const fallbackFailpoint = async () => {};
  return Object.freeze({
    workspaceDirectory: options.workspaceDirectory,
    ...(recovery ? {} : { confirmationToken: options.confirmationToken }),
    failpoint: options.failpoint === undefined ? fallbackFailpoint : functionOption(options.failpoint),
    linkFile: options.linkFile === undefined ? callable(defaults.linkFile) : functionOption(options.linkFile),
    withLease: options.withLease === undefined ? callable(defaults.withLease) : functionOption(options.withLease),
  });
}
function safePreview(value, assertValidExportWorkspaceDiscardPreflight) {
  const snapshot = data(value);
  if (typeof snapshot.confirmationToken !== "string") invalid();
  assertValidExportWorkspaceDiscardPreflight(snapshot);
  return snapshot;
}
function safeBuild(value, assertValidExportWorkspaceDiscardPreflight, assertValidExportWorkspaceDiscardJournal) {
  plain(value);
  const snapshot = Object.freeze({
    summary: data(own(value, "summary")),
    journal: data(own(value, "journal")),
  });
  if (!snapshot.summary || !snapshot.journal || typeof snapshot.summary.confirmationToken !== "string") invalid();
  assertValidExportWorkspaceDiscardPreflight(snapshot.summary);
  assertValidExportWorkspaceDiscardJournal(snapshot.journal);
  return snapshot;
}

/** Durable owner-only discard execution with all protocol dependencies injected. */
export function createOwnerOnlyExportWorkspaceDiscardStorage(configuration = {}) {
  const buildLocalExportWorkspaceDiscardPlan = callable(own(configuration, "buildLocalExportWorkspaceDiscardPlan"));
  const planLocalExportWorkspaceDiscard = callable(own(configuration, "planLocalExportWorkspaceDiscard"));
  const workspaceDiscardDirectoryIdentityToken = callable(own(configuration, "workspaceDiscardDirectoryIdentityToken"));
  const workspaceDiscardEvidenceToken = callable(own(configuration, "workspaceDiscardEvidenceToken"));
  const stableJson = callable(own(configuration, "stableJson"));
  const readBoundedDirectoryEntries = callable(own(configuration, "readBoundedDirectoryEntries"));
  const withExistingExportWorkspaceLease = callable(own(configuration, "withExistingExportWorkspaceLease"));
  const assertValidExportWorkspaceDiscardCommitMarker = callable(own(configuration, "assertValidExportWorkspaceDiscardCommitMarker"));
  const assertValidExportWorkspaceDiscardJournal = callable(own(configuration, "assertValidExportWorkspaceDiscardJournal"));
  const assertValidExportWorkspaceDiscardPreflight = callable(own(configuration, "assertValidExportWorkspaceDiscardPreflight"));
  const assertValidExportWorkspaceDiscardReceipt = callable(own(configuration, "assertValidExportWorkspaceDiscardReceipt"));
  const commitMarkerVersion = own(configuration, "commitMarkerVersion");
  const confirmationTokenPattern = own(configuration, "confirmationTokenPattern");
  const orderVersion = own(configuration, "orderVersion");
  const planVersion = own(configuration, "planVersion");
  const receiptVersion = own(configuration, "receiptVersion");
  const roles = own(configuration, "roles");
  const workspaceDatabaseBasename = own(configuration, "workspaceDatabaseBasename");
  const journalBasename = own(configuration, "journalBasename");
  const markerBasename = own(configuration, "markerBasename");
  const receiptBasename = own(configuration, "receiptBasename");
  const quarantinePrefix = own(configuration, "quarantinePrefix");
  const workspaceLockBasename = own(configuration, "workspaceLockBasename");
  const transactionBasename = own(configuration, "transactionBasename");
  if (!roles || typeof roles !== "object" || isProxy(roles)
      || typeof workspaceDatabaseBasename !== "string" || workspaceDatabaseBasename.length < 1) invalid();
  for (const value of [commitMarkerVersion, confirmationTokenPattern, orderVersion, planVersion, receiptVersion,
    journalBasename, markerBasename, receiptBasename, quarantinePrefix, workspaceLockBasename, transactionBasename]) {
    if (typeof value !== "string" || value.length < 1 || value.length > 256) invalid();
  }
  try { new RegExp(confirmationTokenPattern); } catch { invalid(); }
  const EXPORT_WORKSPACE_DISCARD_ROLES = Object.freeze({
    sqliteJournal: own(roles, "sqliteJournal"), sqliteWal: own(roles, "sqliteWal"),
    sqliteShm: own(roles, "sqliteShm"), database: own(roles, "database"),
  });
const MAX_CONTROL_BYTES = 1024 * 1024;
const WORKSPACE_LOCK_BASENAME = workspaceLockBasename;
const TRANSACTION_BASENAME = transactionBasename;
const JOURNAL_QUARANTINE = `${quarantinePrefix}journal`;
const MARKER_QUARANTINE = `${quarantinePrefix}commit`;
const SAFE_CODES = new Set([
  "confirmation", "journal_missing", "journal_pair", "journal_invalid", "commit_invalid",
  "replacement", "receipt_invalid", "workspace_state", "path_derivation", "foreign_transaction",
]);
const INTENTIONAL_FAILPOINT_ERRORS = new WeakSet();

const trustedExecutionErrors = new WeakSet();
class ExportWorkspaceDiscardExecutionError extends Error {
  constructor(code) {
    if (!SAFE_CODES.has(code)) throw new TypeError("Unknown workspace-discard execution code");
    super(`Local export workspace discard failed (${code})`);
    this.name = "ExportWorkspaceDiscardExecutionError";
    this.code = `export_workspace_discard_execute_${code}`;
    if (new.target === ExportWorkspaceDiscardExecutionError) trustedExecutionErrors.add(this);
  }
}

function isTrustedExecutionError(error) {
  return Boolean(error && trustedExecutionErrors.has(error)
    && Object.getPrototypeOf(error) === ExportWorkspaceDiscardExecutionError.prototype);
}
function fail(code) { throw new ExportWorkspaceDiscardExecutionError(code); }

async function callFailpoint(failpoint, stage, detail) {
  try {
    await failpoint(stage, detail);
  } catch (error) {
    if (error && (typeof error === "object" || typeof error === "function")) {
      INTENTIONAL_FAILPOINT_ERRORS.add(error);
    }
    throw error;
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

function controlToken(domain, text) {
  return base32(createHash("sha256").update(domain).update("\0").update(text).digest());
}

async function unlinkDurably(path) {
  await unlink(path);
  await syncDirectory(dirname(path));
}

async function writeOwnerOnlyNoClobberDurable(path, content) {
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_CONTROL_BYTES) {
    throw new TypeError("Owner-only discard control is invalid");
  }
  const requested = resolve(path);
  const parent = dirname(requested);
  await assertOwnerControlledDirectory(parent);
  const canonicalParent = await realpath(parent);
  const target = join(canonicalParent, basename(requested));
  let handle;
  let identity;
  let durable = false;
  try {
    handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    const opened = await handle.stat();
    identity = { dev: opened.dev, ino: opened.ino };
    await handle.chmod(0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    const written = await handle.stat();
    if (!written.isFile() || written.nlink !== 1 || written.size !== Buffer.byteLength(content, "utf8")
        || (typeof process.getuid === "function" && written.uid !== process.getuid())
        || (process.platform !== "win32" && (written.mode & 0o077) !== 0)) throw new Error("invalid control");
    await handle.close(); handle = null;
    await syncDirectory(canonicalParent);
    durable = true;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (!durable && identity) {
      const current = await lstat(target).catch(() => null);
      if (current?.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) {
        await unlink(target).catch(() => {});
        await syncDirectory(canonicalParent).catch(() => {});
      }
    }
    throw error;
  }
}

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function assertOwnerFile(stats, maximumBytes = Number.MAX_SAFE_INTEGER, allowedLinkCounts = [1]) {
  if (!stats.isFile() || stats.isSymbolicLink() || !allowedLinkCounts.includes(Number(stats.nlink))
      || !Number.isSafeInteger(stats.size) || stats.size < 1 || stats.size > maximumBytes
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) fail("replacement");
}

async function readExactFile(path, maximumBytes = Number.MAX_SAFE_INTEGER, {
  allowedLinkCounts = [1],
  logicalLinkCount = null,
} = {}) {
  let before;
  try { before = await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return null; fail("replacement"); }
  assertOwnerFile(before, maximumBytes, allowedLinkCounts);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    assertOwnerFile(opened, maximumBytes, allowedLinkCounts);
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
      logicalLinkCount,
      byteSize: Number(after.size),
      digest: digest.digest("hex"),
      bytes: opened.size <= MAX_CONTROL_BYTES ? Buffer.concat(chunks) : null,
    };
  } catch (error) {
    if (isTrustedExecutionError(error)) throw error;
    fail("replacement");
  } finally { await handle?.close().catch(() => {}); }
}

function artifactEvidence(artifact) {
  return {
    device: Number(artifact.stats.dev),
    inode: Number(artifact.stats.ino),
    linkCount: Number(artifact.logicalLinkCount ?? artifact.stats.nlink),
    byteSize: Number(artifact.stats.size),
    modifiedMs: Math.trunc(artifact.stats.mtimeMs),
    digest: artifact.digest,
  };
}

function matchesEvidence(artifact, expected) {
  if (typeof expected.evidenceToken === "string"
      && typeof expected.planToken === "string"
      && typeof expected.role === "string") {
    return artifact.byteSize === expected.byteSize
      && workspaceDiscardEvidenceToken(expected.planToken, expected.role, artifactEvidence(artifact))
        === expected.evidenceToken;
  }
  const evidence = expected.evidence;
  if (!evidence) return false;
  return Number(artifact.stats.dev) === evidence.device
    && Number(artifact.stats.ino) === evidence.inode
    && Number(artifact.logicalLinkCount ?? artifact.stats.nlink) === evidence.linkCount
    && Number(artifact.stats.size) === evidence.byteSize
    && Math.trunc(artifact.stats.mtimeMs) === evidence.modifiedMs
    && artifact.digest === evidence.digest;
}

async function readControl(path, label, readOptions = {}) {
  const artifact = await readExactFile(path, MAX_CONTROL_BYTES, readOptions);
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

async function readControlEither(canonical, quarantined, label) {
  const canonicalPresent = await exists(canonical);
  const quarantinePresent = await exists(quarantined);
  if (canonicalPresent && quarantinePresent) {
    const options = { allowedLinkCounts: [2], logicalLinkCount: 1 };
    const left = await readControl(canonical, label, options);
    const right = await readControl(quarantined, label, options);
    if (!left || !right || Number(left.stats.dev) !== Number(right.stats.dev)
        || Number(left.stats.ino) !== Number(right.stats.ino) || left.text !== right.text) fail(label);
    return { ...left, path: canonical };
  }
  const left = canonicalPresent ? await readControl(canonical, label) : null;
  const right = quarantinePresent ? await readControl(quarantined, label) : null;
  return left ? { ...left, path: canonical } : right ? { ...right, path: quarantined } : null;
}

function pathForRole(directory, role) {
  switch (role) {
    case EXPORT_WORKSPACE_DISCARD_ROLES.sqliteJournal: return join(directory, `${workspaceDatabaseBasename}-journal`);
    case EXPORT_WORKSPACE_DISCARD_ROLES.sqliteWal: return join(directory, `${workspaceDatabaseBasename}-wal`);
    case EXPORT_WORKSPACE_DISCARD_ROLES.sqliteShm: return join(directory, `${workspaceDatabaseBasename}-shm`);
    case EXPORT_WORKSPACE_DISCARD_ROLES.database: return join(directory, workspaceDatabaseBasename);
    default: fail("path_derivation");
  }
}

function quarantineForRole(directory, ordinal) {
  return join(directory, `${quarantinePrefix}${String(ordinal).padStart(2, "0")}`);
}

async function quarantineThenUnlink(path, quarantinePath, expected, {
  linkFile = link,
  failpoint = async () => {},
  stage = null,
  detail = null,
} = {}) {
  const currentPresent = await exists(path);
  const quarantinePresent = await exists(quarantinePath);
  if (!currentPresent && !quarantinePresent) return false;
  if (!currentPresent && quarantinePresent) {
    const quarantined = await readExactFile(quarantinePath);
    if (!matchesEvidence(quarantined, expected)) fail("replacement");
    try { await unlinkDurably(quarantinePath); } catch { fail("replacement"); }
    return true;
  }
  if (currentPresent && quarantinePresent) {
    const linkedCurrent = await readExactFile(path, Number.MAX_SAFE_INTEGER, {
      allowedLinkCounts: [2], logicalLinkCount: 1,
    });
    const linkedQuarantine = await readExactFile(quarantinePath, Number.MAX_SAFE_INTEGER, {
      allowedLinkCounts: [2], logicalLinkCount: 1,
    });
    if (!linkedCurrent || !linkedQuarantine
        || Number(linkedCurrent.stats.dev) !== Number(linkedQuarantine.stats.dev)
        || Number(linkedCurrent.stats.ino) !== Number(linkedQuarantine.stats.ino)
        || !matchesEvidence(linkedCurrent, expected)
        || !matchesEvidence(linkedQuarantine, expected)) fail("replacement");
    try { await unlinkDurably(path); } catch { fail("replacement"); }
    const soleQuarantine = await readExactFile(quarantinePath);
    if (!soleQuarantine || !matchesEvidence(soleQuarantine, expected)) fail("replacement");
    if (stage) await callFailpoint(failpoint, stage, detail);
    try { await unlinkDurably(quarantinePath); } catch { fail("replacement"); }
    return true;
  }
  const current = await readExactFile(path);
  if (!current) fail("replacement");
  if (!matchesEvidence(current, expected)) fail("replacement");
  try {
    await linkFile(path, quarantinePath);
    await syncDirectory(dirname(path));
  } catch (error) {
    if (isTrustedExecutionError(error)) throw error;
    fail("replacement");
  }
  const linkedCurrent = await readExactFile(path, Number.MAX_SAFE_INTEGER, {
    allowedLinkCounts: [2], logicalLinkCount: 1,
  });
  const linkedQuarantine = await readExactFile(quarantinePath, Number.MAX_SAFE_INTEGER, {
    allowedLinkCounts: [2], logicalLinkCount: 1,
  });
  if (!linkedCurrent || !linkedQuarantine
      || Number(linkedCurrent.stats.dev) !== Number(linkedQuarantine.stats.dev)
      || Number(linkedCurrent.stats.ino) !== Number(linkedQuarantine.stats.ino)
      || !matchesEvidence(linkedCurrent, expected)
      || !matchesEvidence(linkedQuarantine, expected)) fail("replacement");
  await callFailpoint(failpoint, "after_quarantine_link", detail);
  try { await unlinkDurably(path); } catch { fail("replacement"); }
  const moved = await readExactFile(quarantinePath);
  if (!moved || !matchesEvidence(moved, expected)) fail("replacement");
  if (stage) await callFailpoint(failpoint, stage, detail);
  try { await unlinkDurably(quarantinePath); } catch { fail("replacement"); }
  return true;
}

function assertOwnerDirectory(stats) {
  if (!stats.isDirectory() || stats.isSymbolicLink()
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) fail("replacement");
}

async function assertDirectoryIdentityToken(directory, planToken, expectedToken) {
  try {
    const stats = await lstat(directory);
    const parentPath = dirname(directory);
    const parentStats = await lstat(parentPath);
    assertOwnerDirectory(stats);
    assertOwnerDirectory(parentStats);
    const actual = workspaceDiscardDirectoryIdentityToken(planToken, {
      stats,
      parent: { stats: parentStats },
    });
    if (actual !== expectedToken) fail("replacement");
  } catch (error) {
    if (isTrustedExecutionError(error)) throw error;
    fail("replacement");
  }
}

function receiptFor(journal) {
  return {
    schemaVersion: receiptVersion,
    planVersion,
    artifactClass: "incomplete_or_poisoned_export_workspace",
    state: "complete",
    logicalRemovalConfirmed: true,
    deletedFileCount: journal.inventoryCounts.totalFiles,
    deletedBytes: journal.inventoryCounts.totalBytes,
    sourceLogsPreserved: true,
    identityStatePreserved: true,
    independentOutputPreserved: true,
    workspaceDirectoryRetained: true,
    networkActivity: "absent",
    secureErasureClaimed: false,
    transportReady: false,
  };
}

async function publishReceipt(directory, journal) {
  const value = receiptFor(journal);
  assertValidExportWorkspaceDiscardReceipt(value);
  const text = stableJson(value);
  const path = join(directory, receiptBasename);
  const existing = await readControl(path, "receipt_invalid");
  if (existing) {
    try { assertValidExportWorkspaceDiscardReceipt(existing.value); } catch { fail("receipt_invalid"); }
    if (existing.text !== text) fail("receipt_invalid");
    return value;
  }
  await writeOwnerOnlyNoClobberDurable(path, text);
  return value;
}

async function deleteControl(path, quarantine, expected, options = {}) {
  const removed = await quarantineThenUnlink(path, quarantine, {
    byteSize: expected.byteSize,
    evidence: {
      device: Number(expected.stats.dev), inode: Number(expected.stats.ino),
      linkCount: Number(expected.logicalLinkCount ?? expected.stats.nlink), byteSize: expected.byteSize,
      modifiedMs: Math.trunc(expected.stats.mtimeMs), digest: expected.digest,
    },
  }, options);
  if (!removed) fail("replacement");
}

async function executeCommitted({ directory, journal, marker, failpoint, linkFile }) {
  for (const row of journal.inventory) {
    await assertDirectoryIdentityToken(directory, journal.planToken, journal.directoryIdentityToken);
    const path = pathForRole(directory, row.role);
    const quarantine = quarantineForRole(directory, row.ordinal);
    const removed = await quarantineThenUnlink(path, quarantine, {
      ...row,
      planToken: journal.planToken,
    }, {
      linkFile,
      failpoint,
      stage: "after_inventory_quarantine",
      detail: { ordinal: row.ordinal, role: row.role },
    });
    if (removed) await callFailpoint(failpoint, "after_inventory_unlink", { ordinal: row.ordinal, role: row.role });
  }
  await assertDirectoryIdentityToken(directory, journal.planToken, journal.directoryIdentityToken);
  const receipt = await publishReceipt(directory, journal);
  await callFailpoint(failpoint, "after_receipt_publish", null);
  await assertDirectoryIdentityToken(directory, journal.planToken, journal.directoryIdentityToken);
  await deleteControl(
    join(directory, journalBasename),
    join(directory, JOURNAL_QUARANTINE),
    journal.__artifact,
    { linkFile, failpoint, stage: "after_journal_quarantine", detail: { control: "journal" } },
  );
  await callFailpoint(failpoint, "after_journal_unlink", null);
  await assertDirectoryIdentityToken(directory, journal.planToken, journal.directoryIdentityToken);
  await deleteControl(
    join(directory, markerBasename),
    join(directory, MARKER_QUARANTINE),
    marker,
    { linkFile, failpoint, stage: "after_commit_marker_quarantine", detail: { control: "commit_marker" } },
  );
  await callFailpoint(failpoint, "after_commit_marker_unlink", null);
  return receipt;
}

async function loadControls(directory) {
  const journalArtifact = await readControlEither(
    join(directory, journalBasename),
    join(directory, JOURNAL_QUARANTINE),
    "journal_invalid",
  );
  const markerArtifact = await readControlEither(
    join(directory, markerBasename),
    join(directory, MARKER_QUARANTINE),
    "commit_invalid",
  );
  if (!journalArtifact && !markerArtifact) return null;
  if (!journalArtifact || !markerArtifact) fail("journal_pair");
  try {
    assertValidExportWorkspaceDiscardJournal(journalArtifact.value);
    assertValidExportWorkspaceDiscardCommitMarker(markerArtifact.value);
  } catch { fail("journal_invalid"); }
  const journalToken = controlToken("app-usagemonitor/export-workspace-discard-journal/v1", journalArtifact.text);
  if (markerArtifact.value.planToken !== journalArtifact.value.planToken
      || markerArtifact.value.directoryIdentityToken !== journalArtifact.value.directoryIdentityToken
      || markerArtifact.value.journalToken !== journalToken) fail("commit_invalid");
  return { journal: { ...journalArtifact.value, __artifact: journalArtifact }, marker: markerArtifact };
}

async function assertReceiptOnlyState(directory) {
  const allowed = new Set([WORKSPACE_LOCK_BASENAME, receiptBasename]);
  const entries = await readBoundedDirectoryEntries(directory);
  if (entries.some((name) => !allowed.has(name))
      || entries.includes(workspaceDatabaseBasename)
      || entries.includes(TRANSACTION_BASENAME)) fail("receipt_invalid");
}

async function assertCommittedDirectoryState(directory, journal) {
  const allowed = new Set([
    WORKSPACE_LOCK_BASENAME,
    journalBasename,
    JOURNAL_QUARANTINE,
    markerBasename,
    MARKER_QUARANTINE,
    receiptBasename,
  ]);
  for (const row of journal.inventory) {
    allowed.add(basename(pathForRole(directory, row.role)));
    allowed.add(basename(quarantineForRole(directory, row.ordinal)));
  }
  const entries = await readBoundedDirectoryEntries(directory);
  if (entries.some((name) => !allowed.has(name)) || entries.includes(TRANSACTION_BASENAME)) {
    fail("receipt_invalid");
  }
  const receiptPresent = entries.includes(receiptBasename);
  for (const row of journal.inventory) {
    const canonicalPath = pathForRole(directory, row.role);
    const quarantinePath = quarantineForRole(directory, row.ordinal);
    const canonicalPresent = entries.includes(basename(canonicalPath));
    const quarantinePresent = entries.includes(basename(quarantinePath));
    if (receiptPresent && (canonicalPresent || quarantinePresent)) {
      fail("receipt_invalid");
    }
    if (canonicalPresent && quarantinePresent) {
      const canonical = await readExactFile(canonicalPath, Number.MAX_SAFE_INTEGER, {
        allowedLinkCounts: [2], logicalLinkCount: 1,
      });
      const quarantine = await readExactFile(quarantinePath, Number.MAX_SAFE_INTEGER, {
        allowedLinkCounts: [2], logicalLinkCount: 1,
      });
      const expected = { ...row, planToken: journal.planToken };
      if (!canonical || !quarantine
          || Number(canonical.stats.dev) !== Number(quarantine.stats.dev)
          || Number(canonical.stats.ino) !== Number(quarantine.stats.ino)
          || !matchesEvidence(canonical, expected) || !matchesEvidence(quarantine, expected)) {
        fail("receipt_invalid");
      }
    }
  }
}

async function assertMarkerReceiptTerminalState(directory, markerPath) {
  const allowed = new Set([
    WORKSPACE_LOCK_BASENAME,
    receiptBasename,
    markerBasename,
    MARKER_QUARANTINE,
  ]);
  const entries = await readBoundedDirectoryEntries(directory);
  const markerNames = [markerBasename, MARKER_QUARANTINE]
    .filter((name) => entries.includes(name));
  if (!entries.includes(receiptBasename)
      || markerNames.length < 1
      || !markerNames.includes(basename(markerPath))
      || entries.some((name) => !allowed.has(name))) fail("receipt_invalid");
}

async function assertPreparedJournalState(directory, journal) {
  const allowed = new Set([
    WORKSPACE_LOCK_BASENAME,
    journalBasename,
    JOURNAL_QUARANTINE,
  ]);
  for (const row of journal.inventory) allowed.add(basename(pathForRole(directory, row.role)));
  const entries = await readBoundedDirectoryEntries(directory);
  if (entries.some((name) => !allowed.has(name))) fail("journal_invalid");
  await assertDirectoryIdentityToken(directory, journal.planToken, journal.directoryIdentityToken);
  for (const row of journal.inventory) {
    const artifact = await readExactFile(pathForRole(directory, row.role));
    if (!artifact || !matchesEvidence(artifact, { ...row, planToken: journal.planToken })) fail("replacement");
  }
}

async function assertNoTransactionRoot(directory) {
  try {
    if (await exists(join(directory, TRANSACTION_BASENAME))) fail("foreign_transaction");
  } catch (error) {
    if (isTrustedExecutionError(error)) throw error;
    fail("foreign_transaction");
  }
}

async function recoverUnderLease({ directory, failpoint, linkFile }) {
  await assertNoTransactionRoot(directory);
  const preparedJournal = await readControlEither(
    join(directory, journalBasename),
    join(directory, JOURNAL_QUARANTINE),
    "journal_invalid",
  );
  const anyMarker = await readControlEither(
    join(directory, markerBasename),
    join(directory, MARKER_QUARANTINE),
    "commit_invalid",
  );
  if (preparedJournal && !anyMarker) {
    try { assertValidExportWorkspaceDiscardJournal(preparedJournal.value); } catch { fail("journal_invalid"); }
    await assertPreparedJournalState(directory, preparedJournal.value);
    await deleteControl(
      join(directory, journalBasename),
      join(directory, JOURNAL_QUARANTINE),
      preparedJournal,
      { linkFile },
    );
    fail("journal_missing");
  }
  let controls;
  try { controls = await loadControls(directory); }
  catch (error) {
    const journalPresent = await exists(join(directory, journalBasename))
      || await exists(join(directory, JOURNAL_QUARANTINE));
    const marker = await readControlEither(
      join(directory, markerBasename),
      join(directory, MARKER_QUARANTINE),
      "commit_invalid",
    );
    const receipt = await readControl(join(directory, receiptBasename), "receipt_invalid");
    if (journalPresent || !marker || !receipt) throw error;
    try {
      assertValidExportWorkspaceDiscardCommitMarker(marker.value);
      assertValidExportWorkspaceDiscardReceipt(receipt.value);
    } catch { fail("receipt_invalid"); }
    await assertDirectoryIdentityToken(directory, marker.value.planToken, marker.value.directoryIdentityToken);
    await assertMarkerReceiptTerminalState(directory, marker.path);
    await deleteControl(
      join(directory, markerBasename),
      join(directory, MARKER_QUARANTINE),
      marker,
      { linkFile, failpoint, stage: "after_commit_marker_quarantine", detail: { control: "commit_marker" } },
    );
    return receipt.value;
  }
  if (!controls) {
    const receipt = await readControl(join(directory, receiptBasename), "receipt_invalid");
    if (!receipt) fail("journal_missing");
    try { assertValidExportWorkspaceDiscardReceipt(receipt.value); } catch { fail("receipt_invalid"); }
    await assertReceiptOnlyState(directory);
    return receipt.value;
  }
  await assertCommittedDirectoryState(directory, controls.journal);
  const receiptPresent = await exists(join(directory, receiptBasename));
  const pristineInventory = !receiptPresent && await Promise.all(controls.journal.inventory.map(async (row) =>
    await exists(pathForRole(directory, row.role)) && !await exists(quarantineForRole(directory, row.ordinal))))
    .then((values) => values.every(Boolean));
  if (pristineInventory) {
    let current;
    try {
      current = safeBuild(await buildLocalExportWorkspaceDiscardPlan({
        workspaceDirectory: directory,
        allowLeaseControls: true,
        allowCommittedControls: true,
      }), assertValidExportWorkspaceDiscardPreflight, assertValidExportWorkspaceDiscardJournal);
    } catch { fail("replacement"); }
    if (current.journal.planToken !== controls.journal.planToken) fail("replacement");
  }
  await assertDirectoryIdentityToken(
    directory,
    controls.journal.planToken,
    controls.journal.directoryIdentityToken,
  );
  return executeCommitted({ directory, journal: controls.journal, marker: controls.marker, failpoint, linkFile });
}

async function discardLocalExportWorkspace(options = undefined) {
  try {
    let safe;
    try { safe = safeDiscardOptions(options, false, { linkFile: link, withLease: withExistingExportWorkspaceLease }); } catch { fail("replacement"); }
    const { workspaceDirectory, confirmationToken, failpoint, linkFile, withLease } = safe;
    if (typeof confirmationToken !== "string"
      || !(new RegExp(confirmationTokenPattern)).test(confirmationToken)) fail("confirmation");
    if (typeof failpoint !== "function" || typeof linkFile !== "function" || typeof withLease !== "function") {
      fail("replacement");
    }
    const preview = safePreview(
      await planLocalExportWorkspaceDiscard(Object.freeze({ workspaceDirectory })),
      assertValidExportWorkspaceDiscardPreflight,
    );
    if (preview.confirmationToken !== confirmationToken) fail("confirmation");
    return await withLease(resolve(workspaceDirectory), async (directory) => {
    if (typeof directory !== "string" || directory.length < 1) fail("replacement");
    await assertNoTransactionRoot(directory);
    if (await loadControls(directory)) fail("journal_pair");
    const plan = safeBuild(
      await buildLocalExportWorkspaceDiscardPlan(Object.freeze({ workspaceDirectory: directory, allowLeaseControls: true })),
      assertValidExportWorkspaceDiscardPreflight,
      assertValidExportWorkspaceDiscardJournal,
    );
    if (plan.summary.confirmationToken !== confirmationToken) fail("confirmation");
    const journalText = stableJson(plan.journal);
    const marker = {
      schemaVersion: commitMarkerVersion,
      planVersion,
      discardOrderVersion: orderVersion,
      state: "committed",
      planToken: plan.journal.planToken,
      directoryIdentityToken: plan.journal.directoryIdentityToken,
      journalToken: controlToken("app-usagemonitor/export-workspace-discard-journal/v1", journalText),
      transportReady: false,
    };
    assertValidExportWorkspaceDiscardCommitMarker(marker);
    try {
      await writeOwnerOnlyNoClobberDurable(
        join(directory, journalBasename),
        journalText,
      );
      await callFailpoint(failpoint, "after_journal_prepare", null);
      await writeOwnerOnlyNoClobberDurable(
        join(directory, markerBasename),
        stableJson(marker),
      );
    } catch (error) {
      if (isTrustedExecutionError(error) || INTENTIONAL_FAILPOINT_ERRORS.has(error)) throw error;
      fail("journal_invalid");
    }
    await callFailpoint(failpoint, "after_journal_commit", null);
    const controls = await loadControls(directory);
    if (!controls) fail("journal_pair");
    await assertCommittedDirectoryState(directory, controls.journal);
    return executeCommitted({ directory, journal: controls.journal, marker: controls.marker, failpoint, linkFile });
    });
  } catch (error) {
    if (isTrustedExecutionError(error) || INTENTIONAL_FAILPOINT_ERRORS.has(error)) throw error;
    fail("replacement");
  }
}

async function recoverLocalExportWorkspaceDiscard(options = undefined) {
  try {
    let safe;
    try { safe = safeDiscardOptions(options, true, { linkFile: link, withLease: withExistingExportWorkspaceLease }); } catch { fail("journal_missing"); }
    const { workspaceDirectory, failpoint, linkFile, withLease } = safe;
    return await withLease(resolve(workspaceDirectory), (directory) =>
      typeof directory === "string" && directory.length > 0
        ? recoverUnderLease({ directory, failpoint, linkFile }) : Promise.reject(new ExportWorkspaceDiscardExecutionError("replacement")));
  } catch (error) {
    if (isTrustedExecutionError(error) || INTENTIONAL_FAILPOINT_ERRORS.has(error)) throw error;
    fail("replacement");
  }
}

  return Object.freeze({
    ExportWorkspaceDiscardExecutionError,
    isTrustedExecutionError,
    discardLocalExportWorkspace,
    recoverLocalExportWorkspaceDiscard,
  });
}
