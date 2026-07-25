import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  assertValidExportWorkspaceDiscardCommitMarker,
  assertValidExportWorkspaceDiscardJournal,
  assertValidExportWorkspaceDiscardReceipt,
  EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_VERSION,
  EXPORT_WORKSPACE_DISCARD_CONFIRMATION_TOKEN_PATTERN,
  EXPORT_WORKSPACE_DISCARD_ORDER_VERSION,
  EXPORT_WORKSPACE_DISCARD_PLAN_VERSION,
  EXPORT_WORKSPACE_DISCARD_RECEIPT_VERSION,
  EXPORT_WORKSPACE_DISCARD_ROLES,
} from "./export-workspace-discard-schema.js";
import {
  buildLocalExportWorkspaceDiscardPlan,
  EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_BASENAME,
  EXPORT_WORKSPACE_DISCARD_JOURNAL_BASENAME,
  EXPORT_WORKSPACE_DISCARD_QUARANTINE_PREFIX,
  EXPORT_WORKSPACE_DISCARD_RECEIPT_BASENAME,
  planLocalExportWorkspaceDiscard,
  workspaceDiscardDirectoryIdentityToken,
  workspaceDiscardEvidenceToken,
} from "./export-workspace-discard.js";
import { EXPORT_WORKSPACE_DATABASE_BASENAME } from "./export-workspace.js";
import { withExistingExportWorkspaceLease } from "./export-workspace-lock.js";
import {
  stableJson,
  syncDirectory,
  unlinkDurably,
  writeOwnerOnlyNoClobberDurable,
} from "./storage.js";

const MAX_CONTROL_BYTES = 1024 * 1024;
const WORKSPACE_LOCK_BASENAME = ".app-usagemonitor-export-workspace.lock";
const TRANSACTION_BASENAME = ".app-usagemonitor-export-transactions";
const JOURNAL_QUARANTINE = `${EXPORT_WORKSPACE_DISCARD_QUARANTINE_PREFIX}journal`;
const MARKER_QUARANTINE = `${EXPORT_WORKSPACE_DISCARD_QUARANTINE_PREFIX}commit`;
const SAFE_CODES = new Set([
  "confirmation", "journal_missing", "journal_pair", "journal_invalid", "commit_invalid",
  "replacement", "receipt_invalid", "workspace_state", "path_derivation", "foreign_transaction",
]);
const INTENTIONAL_FAILPOINT_ERRORS = new WeakSet();

export class ExportWorkspaceDiscardExecutionError extends Error {
  constructor(code) {
    if (!SAFE_CODES.has(code)) throw new TypeError("Unknown workspace-discard execution code");
    super(`Local export workspace discard failed (${code})`);
    this.name = "ExportWorkspaceDiscardExecutionError";
    this.code = `export_workspace_discard_execute_${code}`;
  }
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
    if (error instanceof ExportWorkspaceDiscardExecutionError) throw error;
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
    if (error instanceof ExportWorkspaceDiscardExecutionError) throw error;
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
    case EXPORT_WORKSPACE_DISCARD_ROLES.sqliteJournal: return join(directory, `${EXPORT_WORKSPACE_DATABASE_BASENAME}-journal`);
    case EXPORT_WORKSPACE_DISCARD_ROLES.sqliteWal: return join(directory, `${EXPORT_WORKSPACE_DATABASE_BASENAME}-wal`);
    case EXPORT_WORKSPACE_DISCARD_ROLES.sqliteShm: return join(directory, `${EXPORT_WORKSPACE_DATABASE_BASENAME}-shm`);
    case EXPORT_WORKSPACE_DISCARD_ROLES.database: return join(directory, EXPORT_WORKSPACE_DATABASE_BASENAME);
    default: fail("path_derivation");
  }
}

function quarantineForRole(directory, ordinal) {
  return join(directory, `${EXPORT_WORKSPACE_DISCARD_QUARANTINE_PREFIX}${String(ordinal).padStart(2, "0")}`);
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
    if (error instanceof ExportWorkspaceDiscardExecutionError) throw error;
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
    if (error instanceof ExportWorkspaceDiscardExecutionError) throw error;
    fail("replacement");
  }
}

function receiptFor(journal) {
  return {
    schemaVersion: EXPORT_WORKSPACE_DISCARD_RECEIPT_VERSION,
    planVersion: EXPORT_WORKSPACE_DISCARD_PLAN_VERSION,
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
  const path = join(directory, EXPORT_WORKSPACE_DISCARD_RECEIPT_BASENAME);
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
    join(directory, EXPORT_WORKSPACE_DISCARD_JOURNAL_BASENAME),
    join(directory, JOURNAL_QUARANTINE),
    journal.__artifact,
    { linkFile, failpoint, stage: "after_journal_quarantine", detail: { control: "journal" } },
  );
  await callFailpoint(failpoint, "after_journal_unlink", null);
  await assertDirectoryIdentityToken(directory, journal.planToken, journal.directoryIdentityToken);
  await deleteControl(
    join(directory, EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_BASENAME),
    join(directory, MARKER_QUARANTINE),
    marker,
    { linkFile, failpoint, stage: "after_commit_marker_quarantine", detail: { control: "commit_marker" } },
  );
  await callFailpoint(failpoint, "after_commit_marker_unlink", null);
  return receipt;
}

async function loadControls(directory) {
  const journalArtifact = await readControlEither(
    join(directory, EXPORT_WORKSPACE_DISCARD_JOURNAL_BASENAME),
    join(directory, JOURNAL_QUARANTINE),
    "journal_invalid",
  );
  const markerArtifact = await readControlEither(
    join(directory, EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_BASENAME),
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
  const allowed = new Set([WORKSPACE_LOCK_BASENAME, EXPORT_WORKSPACE_DISCARD_RECEIPT_BASENAME]);
  const entries = await readdir(directory);
  if (entries.some((name) => !allowed.has(name))
      || entries.includes(EXPORT_WORKSPACE_DATABASE_BASENAME)
      || entries.includes(TRANSACTION_BASENAME)) fail("receipt_invalid");
}

async function assertCommittedDirectoryState(directory, journal) {
  const allowed = new Set([
    WORKSPACE_LOCK_BASENAME,
    EXPORT_WORKSPACE_DISCARD_JOURNAL_BASENAME,
    JOURNAL_QUARANTINE,
    EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_BASENAME,
    MARKER_QUARANTINE,
    EXPORT_WORKSPACE_DISCARD_RECEIPT_BASENAME,
  ]);
  for (const row of journal.inventory) {
    allowed.add(basename(pathForRole(directory, row.role)));
    allowed.add(basename(quarantineForRole(directory, row.ordinal)));
  }
  const entries = await readdir(directory);
  if (entries.some((name) => !allowed.has(name)) || entries.includes(TRANSACTION_BASENAME)) {
    fail("receipt_invalid");
  }
  const receiptPresent = entries.includes(EXPORT_WORKSPACE_DISCARD_RECEIPT_BASENAME);
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
    EXPORT_WORKSPACE_DISCARD_RECEIPT_BASENAME,
    EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_BASENAME,
    MARKER_QUARANTINE,
  ]);
  const entries = await readdir(directory);
  const markerNames = [EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_BASENAME, MARKER_QUARANTINE]
    .filter((name) => entries.includes(name));
  if (!entries.includes(EXPORT_WORKSPACE_DISCARD_RECEIPT_BASENAME)
      || markerNames.length < 1
      || !markerNames.includes(basename(markerPath))
      || entries.some((name) => !allowed.has(name))) fail("receipt_invalid");
}

async function assertPreparedJournalState(directory, journal) {
  const allowed = new Set([
    WORKSPACE_LOCK_BASENAME,
    EXPORT_WORKSPACE_DISCARD_JOURNAL_BASENAME,
    JOURNAL_QUARANTINE,
  ]);
  for (const row of journal.inventory) allowed.add(basename(pathForRole(directory, row.role)));
  const entries = await readdir(directory);
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
    if (error instanceof ExportWorkspaceDiscardExecutionError) throw error;
    fail("foreign_transaction");
  }
}

async function recoverUnderLease({ directory, failpoint, linkFile }) {
  await assertNoTransactionRoot(directory);
  const preparedJournal = await readControlEither(
    join(directory, EXPORT_WORKSPACE_DISCARD_JOURNAL_BASENAME),
    join(directory, JOURNAL_QUARANTINE),
    "journal_invalid",
  );
  const anyMarker = await readControlEither(
    join(directory, EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_BASENAME),
    join(directory, MARKER_QUARANTINE),
    "commit_invalid",
  );
  if (preparedJournal && !anyMarker) {
    try { assertValidExportWorkspaceDiscardJournal(preparedJournal.value); } catch { fail("journal_invalid"); }
    await assertPreparedJournalState(directory, preparedJournal.value);
    await deleteControl(
      join(directory, EXPORT_WORKSPACE_DISCARD_JOURNAL_BASENAME),
      join(directory, JOURNAL_QUARANTINE),
      preparedJournal,
      { linkFile },
    );
    fail("journal_missing");
  }
  let controls;
  try { controls = await loadControls(directory); }
  catch (error) {
    const journalPresent = await exists(join(directory, EXPORT_WORKSPACE_DISCARD_JOURNAL_BASENAME))
      || await exists(join(directory, JOURNAL_QUARANTINE));
    const marker = await readControlEither(
      join(directory, EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_BASENAME),
      join(directory, MARKER_QUARANTINE),
      "commit_invalid",
    );
    const receipt = await readControl(join(directory, EXPORT_WORKSPACE_DISCARD_RECEIPT_BASENAME), "receipt_invalid");
    if (journalPresent || !marker || !receipt) throw error;
    try {
      assertValidExportWorkspaceDiscardCommitMarker(marker.value);
      assertValidExportWorkspaceDiscardReceipt(receipt.value);
    } catch { fail("receipt_invalid"); }
    await assertDirectoryIdentityToken(directory, marker.value.planToken, marker.value.directoryIdentityToken);
    await assertMarkerReceiptTerminalState(directory, marker.path);
    await deleteControl(
      join(directory, EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_BASENAME),
      join(directory, MARKER_QUARANTINE),
      marker,
      { linkFile, failpoint, stage: "after_commit_marker_quarantine", detail: { control: "commit_marker" } },
    );
    return receipt.value;
  }
  if (!controls) {
    const receipt = await readControl(join(directory, EXPORT_WORKSPACE_DISCARD_RECEIPT_BASENAME), "receipt_invalid");
    if (!receipt) fail("journal_missing");
    try { assertValidExportWorkspaceDiscardReceipt(receipt.value); } catch { fail("receipt_invalid"); }
    await assertReceiptOnlyState(directory);
    return receipt.value;
  }
  await assertCommittedDirectoryState(directory, controls.journal);
  const receiptPresent = await exists(join(directory, EXPORT_WORKSPACE_DISCARD_RECEIPT_BASENAME));
  const pristineInventory = !receiptPresent && await Promise.all(controls.journal.inventory.map(async (row) =>
    await exists(pathForRole(directory, row.role)) && !await exists(quarantineForRole(directory, row.ordinal))))
    .then((values) => values.every(Boolean));
  if (pristineInventory) {
    let current;
    try {
      current = await buildLocalExportWorkspaceDiscardPlan({
        workspaceDirectory: directory,
        allowLeaseControls: true,
        allowCommittedControls: true,
      });
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

export async function discardLocalExportWorkspace({
  workspaceDirectory,
  confirmationToken,
  failpoint = async () => {},
  linkFile = link,
  withLease = withExistingExportWorkspaceLease,
} = {}) {
  try {
    if (typeof confirmationToken !== "string"
      || !(new RegExp(EXPORT_WORKSPACE_DISCARD_CONFIRMATION_TOKEN_PATTERN)).test(confirmationToken)) fail("confirmation");
    if (typeof failpoint !== "function" || typeof linkFile !== "function" || typeof withLease !== "function") {
      fail("replacement");
    }
    const preview = await planLocalExportWorkspaceDiscard({ workspaceDirectory });
    if (preview.confirmationToken !== confirmationToken) fail("confirmation");
    return await withLease(resolve(workspaceDirectory), async (directory) => {
    await assertNoTransactionRoot(directory);
    if (await loadControls(directory)) fail("journal_pair");
    const plan = await buildLocalExportWorkspaceDiscardPlan({ workspaceDirectory: directory, allowLeaseControls: true });
    if (plan.summary.confirmationToken !== confirmationToken) fail("confirmation");
    const journalText = stableJson(plan.journal);
    const marker = {
      schemaVersion: EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_VERSION,
      planVersion: EXPORT_WORKSPACE_DISCARD_PLAN_VERSION,
      discardOrderVersion: EXPORT_WORKSPACE_DISCARD_ORDER_VERSION,
      state: "committed",
      planToken: plan.journal.planToken,
      directoryIdentityToken: plan.journal.directoryIdentityToken,
      journalToken: controlToken("app-usagemonitor/export-workspace-discard-journal/v1", journalText),
      transportReady: false,
    };
    assertValidExportWorkspaceDiscardCommitMarker(marker);
    try {
      await writeOwnerOnlyNoClobberDurable(
        join(directory, EXPORT_WORKSPACE_DISCARD_JOURNAL_BASENAME),
        journalText,
      );
      await callFailpoint(failpoint, "after_journal_prepare", null);
      await writeOwnerOnlyNoClobberDurable(
        join(directory, EXPORT_WORKSPACE_DISCARD_COMMIT_MARKER_BASENAME),
        stableJson(marker),
      );
    } catch (error) {
      if (error instanceof ExportWorkspaceDiscardExecutionError || INTENTIONAL_FAILPOINT_ERRORS.has(error)) throw error;
      fail("journal_invalid");
    }
    await callFailpoint(failpoint, "after_journal_commit", null);
    const controls = await loadControls(directory);
    if (!controls) fail("journal_pair");
    await assertCommittedDirectoryState(directory, controls.journal);
    return executeCommitted({ directory, journal: controls.journal, marker: controls.marker, failpoint, linkFile });
    });
  } catch (error) {
    if (error instanceof ExportWorkspaceDiscardExecutionError || INTENTIONAL_FAILPOINT_ERRORS.has(error)) throw error;
    fail("replacement");
  }
}

export async function recoverLocalExportWorkspaceDiscard({
  workspaceDirectory,
  failpoint = async () => {},
  linkFile = link,
  withLease = withExistingExportWorkspaceLease,
} = {}) {
  try {
    if (!workspaceDirectory) fail("journal_missing");
    if (typeof failpoint !== "function" || typeof linkFile !== "function" || typeof withLease !== "function") {
      fail("replacement");
    }
    return await withLease(resolve(workspaceDirectory), (directory) =>
      recoverUnderLease({ directory, failpoint, linkFile }));
  } catch (error) {
    if (error instanceof ExportWorkspaceDiscardExecutionError || INTENTIONAL_FAILPOINT_ERRORS.has(error)) throw error;
    fail("replacement");
  }
}
