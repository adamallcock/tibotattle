import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, join, parse, relative, resolve, sep } from "node:path";
import {
  assertOwnerControlledDirectory,
  syncDirectory,
} from "./platform/owner-only-filesystem.js";

const MAX_MIGRATABLE_REPORT_BYTES = 16 * 1024 * 1024;
const LOCAL_STATE_DIRECTORY = ".usage-monitor";
const LOCAL_LEGACY_REPORT_DIRECTORY_NAME = "legacy-reports";
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;

export const LOCAL_LEGACY_REPORT_FILENAMES = Object.freeze([
  "2026-07-23-codex-weekly-limit-history-report.html",
  "2026-07-24-codex-work-account-usage-report.html",
  "2026-07-24-monitoring-quality-artifact.json",
  "2026-07-24-monitoring-quality-report.html",
  "2026-07-24-simple-quota-gradient-artifact.json",
  "2026-07-24-simple-quota-gradient-report.html",
  "2026-07-24-weekly-7-day-calibration-artifact.json",
  "2026-07-24-weekly-7-day-calibration-report.html",
  "artifact.json",
]);

const KNOWN_FILENAMES = new Set(LOCAL_LEGACY_REPORT_FILENAMES);

function ownError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertKnownFilename(filename) {
  if (!KNOWN_FILENAMES.has(filename)) {
    throw ownError("unknown_legacy_report", "Legacy report filename is not recognized.");
  }
}

function canonicalRoot(root) {
  return resolve(root);
}

/**
 * Inspects every existing component without following symbolic links.  A
 * lexical path check is not enough here: an attacker can replace either the
 * final report or one of the private-directory ancestors with a link to a
 * different owner-controlled (or foreign) tree.  Missing components are
 * reported separately so callers may create the canonical tree safely.
 */
async function inspectPathComponents(path, { anchor = null } = {}) {
  const absolutePath = resolve(path);
  const anchorPath = anchor === null ? parse(absolutePath).root : resolve(anchor);
  const relativePath = relative(anchorPath, absolutePath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || relativePath.startsWith(sep)) {
    return { status: "unsafe", path: absolutePath };
  }
  let current = anchorPath;
  let metadata;
  try {
    metadata = await lstat(current);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", path: current };
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    return { metadata, path: current, status: "unsafe" };
  }
  if (!metadata.isDirectory() && current !== absolutePath) {
    return { metadata, path: current, status: "unsafe" };
  }
  if (current === absolutePath) return { metadata, path: current, status: "present" };

  const components = relativePath.split(sep).filter(Boolean);
  for (const component of components) {
    current = join(current, component);
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return { status: "missing", path: current };
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      return { metadata, path: current, status: "unsafe" };
    }
    const isFinal = current === absolutePath;
    if (!isFinal && !metadata.isDirectory()) {
      return { metadata, path: current, status: "unsafe" };
    }
    if (isFinal) return { metadata, path: current, status: "present" };
  }
  return { status: "missing", path: absolutePath };
}

function unsafePathError(label) {
  return ownError("unsafe_report_path", `${label} must not contain symbolic links.`);
}

async function assertSafePathComponents(path, label, options = {}) {
  const inspected = await inspectPathComponents(path, options);
  if (inspected.status === "unsafe") throw unsafePathError(label);
  return inspected;
}

function identityFingerprint(metadata) {
  return Object.freeze({
    dev: String(metadata.dev),
    ino: String(metadata.ino),
  });
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function reportContentBytes(content) {
  if (typeof content === "string") return Buffer.from(content, "utf8");
  if (Buffer.isBuffer(content) || content instanceof Uint8Array) return Buffer.from(content);
  throw new TypeError("Legacy report content must be a string, Buffer, or Uint8Array");
}

function reportPathAnchor(path, anchor) {
  return anchor === null ? parse(resolve(path)).root : resolve(anchor);
}

async function assertReportDirectory(path, anchor, expectedIdentity = null) {
  const inspected = await assertSafePathComponents(path, "Legacy report directory", { anchor });
  if (inspected.status !== "present"
      || !inspected.metadata.isDirectory()
      || inspected.metadata.isSymbolicLink()
      || !isOwner(inspected.metadata)
      || (process.platform !== "win32" && (inspected.metadata.mode & 0o077) !== 0)) {
    throw ownError("unsafe_directory", "Legacy report directory must be a private owner directory.");
  }
  const identity = identityFingerprint(inspected.metadata);
  if (expectedIdentity !== null && !sameIdentity(identity, expectedIdentity)) {
    throw ownError("unsafe_directory", "Legacy report directory changed during report publication.");
  }
  return { identity, metadata: inspected.metadata };
}

async function syncLegacyReportDirectory(path, anchor, expectedIdentity) {
  await assertReportDirectory(path, anchor, expectedIdentity);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.isSymbolicLink() || !isOwner(opened)
        || !sameIdentity(identityFingerprint(opened), expectedIdentity)) {
      throw ownError("unsafe_directory", "Legacy report directory changed during durability sync.");
    }
    await handle.sync();
    const after = await handle.stat();
    if (!after.isDirectory() || after.isSymbolicLink() || !isOwner(after)
        || !sameIdentity(identityFingerprint(after), expectedIdentity)) {
      throw ownError("unsafe_directory", "Legacy report directory changed during durability sync.");
    }
    await assertReportDirectory(path, anchor, expectedIdentity);
  } catch (error) {
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR" || error?.code === "ENOENT") {
      throw ownError("unsafe_directory", "Legacy report directory path is unsafe.");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function inspectReportDestination(path, anchor, label) {
  const inspected = await assertSafePathComponents(path, label, { anchor });
  if (inspected.status === "missing") return null;
  if (!inspected.metadata.isFile() || inspected.metadata.isSymbolicLink()
      || !isOwner(inspected.metadata) || inspected.metadata.nlink !== 1) {
    throw ownError("unsafe_report_path", "Canonical legacy report must be an owner-only regular file.");
  }
  return identityFingerprint(inspected.metadata);
}

async function assertStagedReport(path, anchor, expectedIdentity, expectedBytes) {
  const inspected = await assertSafePathComponents(path, "Staged legacy report path", { anchor });
  if (inspected.status !== "present"
      || !inspected.metadata.isFile()
      || inspected.metadata.isSymbolicLink()
      || !isOwner(inspected.metadata)
      || inspected.metadata.nlink !== 1
      || inspected.metadata.size !== expectedBytes
      || !sameIdentity(identityFingerprint(inspected.metadata), expectedIdentity)) {
    throw ownError("unsafe_destination", "Staged legacy report path changed during publication.");
  }
  return inspected.metadata;
}

async function unlinkExactStagedReport(path, expectedIdentity, directory, anchor, expectedDirectoryIdentity) {
  if (expectedIdentity === null) return;
  try {
    await assertReportDirectory(directory, anchor, expectedDirectoryIdentity);
    const stagedPath = await assertSafePathComponents(path, "Staged legacy report path", { anchor });
    if (stagedPath.status !== "present") return;
    const current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
        || !isOwner(current) || !sameIdentity(identityFingerprint(current), expectedIdentity)) return;
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") return;
  }
}

/**
 * Writes one owner-only report through a private same-directory staging file.
 * The pathname checks and final revalidation intentionally remain in addition
 * to O_NOFOLLOW: Node does not expose renameat/openat, so a hostile same-UID
 * process can still rename an ancestor between the last check and rename.
 */
async function writeSafeLegacyReportPath(path, content, {
  anchor = null,
  label = "Legacy report path",
  ensureDirectory = false,
} = {}) {
  const absolutePath = resolve(path);
  const pathAnchor = reportPathAnchor(absolutePath, anchor);
  const directory = parse(absolutePath).dir;
  const bytes = reportContentBytes(content);

  if (NOFOLLOW === 0) {
    throw ownError("unsafe_destination", "Legacy report publication requires no-follow filesystem support.");
  }
  if (ensureDirectory) await ensureLocalLegacyReportDirectory(pathAnchor);

  const directoryState = await assertReportDirectory(directory, pathAnchor);
  await inspectReportDestination(absolutePath, pathAnchor, label);

  const stagedPath = join(
    directory,
    `.${basename(absolutePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  let stagedIdentity = null;
  let published = false;
  try {
    const stagedBeforeOpen = await assertSafePathComponents(
      stagedPath,
      "Staged legacy report path",
      { anchor: pathAnchor },
    );
    if (stagedBeforeOpen.status !== "missing") {
      throw ownError("unsafe_destination", "Staged legacy report path already exists.");
    }
    handle = await open(stagedPath, WRITE_FLAGS, 0o600);
    const created = await handle.stat();
    stagedIdentity = identityFingerprint(created);
    if (!created.isFile() || created.isSymbolicLink() || !isOwner(created) || created.nlink !== 1) {
      throw ownError("unsafe_destination", "Staged legacy report is not an owner-only regular file.");
    }
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const written = await handle.stat();
    if (!written.isFile() || written.isSymbolicLink() || !isOwner(written)
        || written.nlink !== 1 || written.size !== bytes.byteLength
        || (process.platform !== "win32" && (written.mode & 0o077) !== 0)
        || !sameIdentity(identityFingerprint(written), stagedIdentity)) {
      throw ownError("unsafe_destination", "Staged legacy report failed validation.");
    }
    await assertStagedReport(stagedPath, pathAnchor, stagedIdentity, bytes.byteLength);
    await assertReportDirectory(directory, pathAnchor, directoryState.identity);
    await inspectReportDestination(absolutePath, pathAnchor, label);
    await handle.close();
    handle = null;
    // Re-check the staged pathname after closing the descriptor and immediately
    // before rename; no-follow on the initial open cannot protect a later
    // pathname replacement by another same-UID process.
    await assertStagedReport(stagedPath, pathAnchor, stagedIdentity, bytes.byteLength);
    await assertReportDirectory(directory, pathAnchor, directoryState.identity);
    await inspectReportDestination(absolutePath, pathAnchor, label);

    try {
      await rename(stagedPath, absolutePath);
    } catch (error) {
      if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
        throw ownError("unsafe_report_path", "Legacy report destination path is unsafe.");
      }
      throw error;
    }
    published = true;
    const publishedMetadata = await assertSafePathComponents(
      absolutePath,
      label,
      { anchor: pathAnchor },
    );
    if (publishedMetadata.status !== "present"
        || !publishedMetadata.metadata.isFile()
        || publishedMetadata.metadata.isSymbolicLink()
        || !isOwner(publishedMetadata.metadata)
        || publishedMetadata.metadata.nlink !== 1
        || publishedMetadata.metadata.size !== bytes.byteLength
        || (process.platform !== "win32" && (publishedMetadata.metadata.mode & 0o077) !== 0)
        || !sameIdentity(identityFingerprint(publishedMetadata.metadata), stagedIdentity)) {
      throw ownError("unsafe_report_path", "Published legacy report failed validation.");
    }
    await syncLegacyReportDirectory(directory, pathAnchor, directoryState.identity);
    return absolutePath;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (!published) {
      await unlinkExactStagedReport(
        stagedPath,
        stagedIdentity,
        directory,
        pathAnchor,
        directoryState.identity,
      );
    }
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
      throw ownError("unsafe_report_path", "Legacy report destination path is unsafe.");
    }
    throw error;
  }
}

async function readSafeLegacyReportPath(path, {
  anchor = null,
  label = "Legacy report path",
} = {}) {
  if (NOFOLLOW === 0) {
    throw ownError("unsafe_report_path", "Legacy report reads require no-follow filesystem support.");
  }
  const absolutePath = resolve(path);
  const pathAnchor = reportPathAnchor(absolutePath, anchor);
  const inspected = await assertSafePathComponents(absolutePath, label, { anchor: pathAnchor });
  if (inspected.status !== "present") {
    const error = ownError("report_not_found", "Legacy report does not exist.");
    error.path = absolutePath;
    throw error;
  }
  if (!inspected.metadata.isFile() || inspected.metadata.isSymbolicLink()) {
    throw ownError("unsafe_report_path", "Legacy report must be a regular file.");
  }
  let handle;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.isSymbolicLink()) {
      throw ownError("unsafe_report_path", "Legacy report must be a regular file.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameIdentity(identityFingerprint(after), identityFingerprint(opened))
        || after.size !== opened.size) {
      throw ownError("unsafe_report_path", "Legacy report changed during read.");
    }
    const pathAfterRead = await assertSafePathComponents(absolutePath, label, { anchor: pathAnchor });
    if (pathAfterRead.status !== "present"
        || !pathAfterRead.metadata.isFile()
        || pathAfterRead.metadata.isSymbolicLink()
        || !sameIdentity(identityFingerprint(pathAfterRead.metadata), identityFingerprint(opened))) {
      throw ownError("unsafe_report_path", "Legacy report path changed during read.");
    }
    return bytes.toString("utf8");
  } catch (error) {
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
      throw ownError("unsafe_report_path", "Legacy report path is unsafe.");
    }
    if (error?.code === "ENOENT") {
      const notFound = ownError("report_not_found", "Legacy report does not exist.");
      notFound.path = absolutePath;
      throw notFound;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function chmodOwnerOnlyDirectory(path, anchor) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
    const before = await handle.stat();
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw ownError("unsafe_directory", "Legacy report directory must be a real directory.");
    }
    const identity = metadataFingerprint(before);
    await handle.chmod(0o700);
    const after = await handle.stat();
    if (!sameMetadata(metadataFingerprint(after), identity)) {
      throw ownError("unsafe_directory", "Legacy report directory changed during validation.");
    }
    const pathAfter = await inspectPathComponents(path, { anchor });
    if (pathAfter.status !== "present"
        || !pathAfter.metadata.isDirectory()
        || !sameMetadata(metadataFingerprint(pathAfter.metadata), identity)) {
      throw ownError("unsafe_directory", "Legacy report directory path changed during validation.");
    }
  } catch (error) {
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR" || error?.code === "ENOENT") {
      throw ownError("unsafe_directory", "Legacy report directory path is unsafe.");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function metadataFingerprint(metadata) {
  return Object.freeze({
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    mtimeMs: metadata.mtimeMs,
    nlink: metadata.nlink,
    size: metadata.size,
  });
}

function sameMetadata(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs
    && left.nlink === right.nlink
    && left.size === right.size;
}

function isOwner(metadata) {
  return typeof process.getuid !== "function" || metadata.uid === process.getuid();
}

function safeEntry(file, state, details = {}) {
  return Object.freeze({
    destination: localLegacyReportRelativePath(file),
    file,
    state,
    ...details,
  });
}

function safeMigrationResult({ apply, entries, status }) {
  return Object.freeze({
    apply,
    entries: Object.freeze(entries),
    schemaVersion: "local-legacy-report-migration-v0.1",
    status,
  });
}

/**
 * The owner-only location for dated report artifacts that used to accumulate
 * in the repository root. It remains ignored and never becomes a release
 * input or a public web asset.
 */
export function localLegacyReportDirectory(root = process.cwd()) {
  return join(canonicalRoot(root), LOCAL_STATE_DIRECTORY, LOCAL_LEGACY_REPORT_DIRECTORY_NAME);
}

export function localLegacyReportRelativePath(filename) {
  assertKnownFilename(filename);
  return `${LOCAL_STATE_DIRECTORY}/${LOCAL_LEGACY_REPORT_DIRECTORY_NAME}/${filename}`;
}

export function localLegacyReportPath(root, filename) {
  assertKnownFilename(filename);
  return join(localLegacyReportDirectory(root), filename);
}

/**
 * Publishes a canonical legacy report atomically into the owner-only report
 * directory. Every canonical report builder uses this entry point rather than
 * writing the destination pathname directly.
 */
export async function writeLocalLegacyReport(root, filename, content) {
  assertKnownFilename(filename);
  const ownerRoot = canonicalRoot(root);
  return writeSafeLegacyReportPath(localLegacyReportPath(root, filename), content, {
    anchor: ownerRoot,
    label: "Canonical legacy report path",
    ensureDirectory: true,
  });
}

/**
 * Safely rewrites an explicitly supplied report path. The parent must already
 * be a private owner directory; callers cannot accidentally turn a symlink
 * into a followed write.
 */
export async function writeLegacyReportPath(path, content, options = {}) {
  return writeSafeLegacyReportPath(path, content, options);
}

export async function readLegacyReportPath(path, options = {}) {
  return readSafeLegacyReportPath(path, options);
}

export async function readLocalLegacyReport(root, filename) {
  assertKnownFilename(filename);
  const ownerRoot = canonicalRoot(root);
  const sourcePath = await resolveLocalLegacyReportReadPath(root, filename);
  return readSafeLegacyReportPath(sourcePath, {
    anchor: ownerRoot,
    label: sourcePath === localLegacyReportPath(root, filename)
      ? "Canonical legacy report path"
      : "Legacy report path",
  });
}

export function legacyRootReportPath(root, filename) {
  assertKnownFilename(filename);
  return join(canonicalRoot(root), filename);
}

/**
 * Selects the private canonical copy when it exists. The root fallback is
 * deliberately read-only compatibility for installations upgraded from the
 * former layout; writers always use the canonical location.
 */
export async function resolveLocalLegacyReportReadPath(root, filename) {
  const ownerRoot = canonicalRoot(root);
  const canonicalPath = localLegacyReportPath(root, filename);
  const canonical = await assertSafePathComponents(canonicalPath, "Canonical legacy report path", { anchor: ownerRoot });
  if (canonical.status === "present") {
    if (!canonical.metadata.isFile() || canonical.metadata.isSymbolicLink()) {
      throw ownError("unsafe_report_path", "Canonical legacy report must be a regular file.");
    }
    return canonicalPath;
  }

  const legacyPath = legacyRootReportPath(root, filename);
  const legacy = await assertSafePathComponents(legacyPath, "Legacy report path", { anchor: ownerRoot });
  if (legacy.status === "present"
      && (!legacy.metadata.isFile() || legacy.metadata.isSymbolicLink())) {
    throw ownError("unsafe_report_path", "Legacy report must be a regular file.");
  }
  return legacyPath;
}

async function ensureOwnerOnlyDirectory(path, anchor) {
  await assertSafePathComponents(path, "Legacy report directory", { anchor });
  await mkdir(path, { mode: 0o700, recursive: true });
  const inspected = await assertSafePathComponents(path, "Legacy report directory", { anchor });
  if (inspected.status !== "present") {
    throw ownError("unsafe_directory", "Legacy report directory could not be created safely.");
  }
  const metadata = inspected.metadata;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw ownError("unsafe_directory", "Legacy report directory must be a real directory.");
  }
  if (!isOwner(metadata)) {
    throw ownError("foreign_owner", "Legacy report directory must be owned by the current user.");
  }
  // chmodOwnerOnlyDirectory re-opens the final directory with O_NOFOLLOW;
  // passing the repository root keeps the ancestor check scoped to this tree.
  await chmodOwnerOnlyDirectory(path, anchor);
  await assertOwnerControlledDirectory(path);
}

export async function ensureLocalLegacyReportDirectory(root = process.cwd()) {
  const ownerRoot = canonicalRoot(root);
  const stateDirectory = join(ownerRoot, LOCAL_STATE_DIRECTORY);
  await ensureOwnerOnlyDirectory(stateDirectory, ownerRoot);
  const reportDirectory = localLegacyReportDirectory(root);
  await ensureOwnerOnlyDirectory(reportDirectory, ownerRoot);
  for (const file of LOCAL_LEGACY_REPORT_FILENAMES) {
    const destination = await assertSafePathComponents(
      localLegacyReportPath(root, file),
      "Canonical legacy report path",
      { anchor: ownerRoot },
    );
    if (destination.status === "present"
        && !destination.metadata.isFile()) {
      throw ownError("unsafe_report_path", "Canonical legacy report must be a regular file.");
    }
  }
  return reportDirectory;
}

/**
 * Reads a legacy source through one descriptor and a bounded byte window.
 * Reading by pathname and checking lstat afterwards is insufficient: a
 * same-owner append can make readFile allocate past the validated limit, and
 * pathname replacement can redirect the read before the post-read check.
 */
async function readStableMigrationSource(path, expected, anchor) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const opened = await handle.stat();
    const openedFingerprint = metadataFingerprint(opened);
    if (!opened.isFile() || opened.isSymbolicLink() || !isOwner(opened) || opened.nlink !== 1) {
      throw ownError("unsafe_source", "Legacy report source must be an owner-only regular file.");
    }
    if (!sameMetadata(openedFingerprint, expected)) {
      throw ownError("source_changed", "A legacy report changed during migration.");
    }
    if (opened.size > MAX_MIGRATABLE_REPORT_BYTES) {
      const error = ownError("source_too_large", "Legacy report source exceeds the migration byte limit.");
      error.bytes = opened.size;
      throw error;
    }

    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 1 || bytesRead > bytes.length - offset) {
        throw ownError("source_changed", "A legacy report changed during migration.");
      }
      offset += bytesRead;
    }

    // Probe one byte beyond the validated size.  This makes an append during
    // the read fail closed rather than silently migrating an unbounded file.
    const overflow = Buffer.allocUnsafe(1);
    const { bytesRead: overflowBytes } = await handle.read(
      overflow,
      0,
      overflow.length,
      opened.size,
    );
    if (overflowBytes !== 0) {
      throw ownError("source_changed", "A legacy report grew during migration.");
    }

    const after = await handle.stat();
    if (!sameMetadata(metadataFingerprint(after), expected)) {
      throw ownError("source_changed", "A legacy report changed during migration.");
    }
    const pathAfterRead = await inspectPathComponents(path, { anchor });
    if (pathAfterRead.status === "unsafe") throw ownError("unsafe_source", "Legacy report source path is unsafe.");
    if (pathAfterRead.status !== "present"
        || !pathAfterRead.metadata.isFile()
        || !sameMetadata(metadataFingerprint(pathAfterRead.metadata), expected)) {
      throw ownError("source_changed", "A legacy report changed during migration.");
    }
    return bytes;
  } catch (error) {
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
      throw ownError("unsafe_source", "Legacy report source path is unsafe.");
    }
    if (error?.code === "ENOENT") {
      throw ownError("source_changed", "A legacy report changed during migration.");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function chmodStagedReport(path, anchor) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink()) {
      throw ownError("unsafe_destination", "Staged legacy report must be a regular file.");
    }
    const identity = metadataFingerprint(before);
    await handle.chmod(0o600);
    const after = await handle.stat();
    if (!sameMetadata(metadataFingerprint(after), identity)) {
      throw ownError("unsafe_destination", "Staged legacy report changed during migration.");
    }
    const pathAfter = await inspectPathComponents(path, { anchor });
    if (pathAfter.status !== "present"
        || !pathAfter.metadata.isFile()
        || !sameMetadata(metadataFingerprint(pathAfter.metadata), identity)) {
      throw ownError("unsafe_destination", "Staged legacy report path changed during migration.");
    }
  } catch (error) {
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR" || error?.code === "ENOENT") {
      throw ownError("unsafe_destination", "Staged legacy report path is unsafe.");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function inspectOne(root, file) {
  const ownerRoot = canonicalRoot(root);
  const sourcePath = legacyRootReportPath(root, file);
  const destinationPath = localLegacyReportPath(root, file);
  const [source, destination] = await Promise.all([
    inspectPathComponents(sourcePath, { anchor: ownerRoot }),
    inspectPathComponents(destinationPath, { anchor: ownerRoot }),
  ]);

  if (destination.status === "unsafe") return safeEntry(file, "destination_invalid");
  if (source.status === "unsafe") return safeEntry(file, "unsafe_source");

  const sourceMetadata = source.status === "present" ? source.metadata : null;
  const destinationMetadata = destination.status === "present" ? destination.metadata : null;

  if (destinationMetadata !== null) {
    if (!destinationMetadata.isFile() || destinationMetadata.isSymbolicLink()) {
      return safeEntry(file, "destination_invalid");
    }
    if (sourceMetadata === null) return safeEntry(file, "already_migrated");
    return safeEntry(file, "destination_conflict");
  }
  if (sourceMetadata === null) return safeEntry(file, "absent");
  if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
    return safeEntry(file, "unsafe_source");
  }
  if (!isOwner(sourceMetadata)) return safeEntry(file, "foreign_owner");
  if (sourceMetadata.nlink !== 1) return safeEntry(file, "multiple_hard_links");
  if (sourceMetadata.size > MAX_MIGRATABLE_REPORT_BYTES) {
    return safeEntry(file, "source_too_large", { bytes: sourceMetadata.size });
  }

  const before = metadataFingerprint(sourceMetadata);
  let bytes;
  try {
    bytes = await readStableMigrationSource(sourcePath, before, ownerRoot);
  } catch (error) {
    if (error?.code === "source_too_large") {
      return safeEntry(file, "source_too_large", { bytes: error.bytes });
    }
    if (error?.code === "unsafe_source") return safeEntry(file, "unsafe_source");
    if (error?.code === "source_changed") return safeEntry(file, "source_changed");
    throw error;
  }
  return safeEntry(file, "migratable", {
    bytes: before.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

export async function inspectLocalLegacyReportMigration({
  files = LOCAL_LEGACY_REPORT_FILENAMES,
  root = process.cwd(),
} = {}) {
  const selected = [...new Set(files)];
  for (const file of selected) assertKnownFilename(file);
  const entries = await Promise.all(selected.map((file) => inspectOne(root, file)));
  return safeMigrationResult({
    apply: false,
    entries,
    status: entries.some(({ state }) => state === "migratable") ? "ready" : "nothing_to_migrate",
  });
}

function migrationBlocker(entry) {
  return !["absent", "already_migrated", "migratable"].includes(entry.state);
}

async function removeStagedLinks(staged) {
  await Promise.all(staged.map(async ({ destinationPath }) => {
    await unlink(destinationPath).catch(() => {});
  }));
}

/**
 * Moves known legacy report files without overwrite risk. Files are first
 * linked into the private directory and only then unlinked from the root, so
 * a failure leaves at least one intact copy. A dry run is the default.
 */
export async function migrateLocalLegacyReports({
  apply = false,
  files = LOCAL_LEGACY_REPORT_FILENAMES,
  root = process.cwd(),
} = {}) {
  const inspection = await inspectLocalLegacyReportMigration({ files, root });
  if (!apply) return inspection;
  const blockers = inspection.entries.filter(migrationBlocker);
  if (blockers.length > 0) {
    return safeMigrationResult({
      apply: true,
      entries: inspection.entries,
      status: "blocked",
    });
  }

  const migratable = inspection.entries.filter(({ state }) => state === "migratable");
  if (migratable.length === 0) {
    return safeMigrationResult({
      apply: true,
      entries: inspection.entries,
      status: "nothing_to_migrate",
    });
  }

  const destinationDirectory = await ensureLocalLegacyReportDirectory(root);
  const staged = [];
  try {
    for (const entry of migratable) {
      const refreshed = await inspectOne(root, entry.file);
      if (refreshed.state !== "migratable" || refreshed.sha256 !== entry.sha256) {
        throw ownError("source_changed", "A legacy report changed during migration.");
      }
      const sourcePath = legacyRootReportPath(root, entry.file);
      const destinationPath = localLegacyReportPath(root, entry.file);
      await link(sourcePath, destinationPath);
      await chmodStagedReport(destinationPath, canonicalRoot(root));
      staged.push({ destinationPath, entry, sourcePath });
    }
    await syncDirectory(destinationDirectory);
  } catch (error) {
    await removeStagedLinks(staged);
    return safeMigrationResult({
      apply: true,
      entries: inspection.entries,
      status: error?.code === "source_changed" ? "source_changed" : "failed_without_move",
    });
  }

  const retainedSources = [];
  const moved = [];
  for (const stagedEntry of staged) {
    try {
      await unlink(stagedEntry.sourcePath);
      moved.push(stagedEntry.entry.file);
    } catch {
      retainedSources.push(stagedEntry.entry.file);
    }
  }
  await syncDirectory(canonicalRoot(root)).catch(() => {});
  const entries = inspection.entries.map((entry) => {
    if (moved.includes(entry.file)) return safeEntry(entry.file, "migrated", {
      bytes: entry.bytes,
      sha256: entry.sha256,
    });
    if (retainedSources.includes(entry.file)) return safeEntry(entry.file, "linked_source_retained", {
      bytes: entry.bytes,
      sha256: entry.sha256,
    });
    return entry;
  });
  return safeMigrationResult({
    apply: true,
    entries,
    status: retainedSources.length === 0 ? "migrated" : "recovery_required",
  });
}
