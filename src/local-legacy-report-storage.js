import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertOwnerControlledDirectory,
  lstatIfExists,
  syncDirectory,
} from "./platform/index.js";

const MAX_MIGRATABLE_REPORT_BYTES = 16 * 1024 * 1024;
const LOCAL_STATE_DIRECTORY = ".usage-monitor";
const LOCAL_LEGACY_REPORT_DIRECTORY_NAME = "legacy-reports";

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
  const canonicalPath = localLegacyReportPath(root, filename);
  if (await lstatIfExists(canonicalPath) !== null) return canonicalPath;
  return legacyRootReportPath(root, filename);
}

async function ensureOwnerOnlyDirectory(path) {
  await mkdir(path, { mode: 0o700, recursive: true });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw ownError("unsafe_directory", "Legacy report directory must be a real directory.");
  }
  if (!isOwner(metadata)) {
    throw ownError("foreign_owner", "Legacy report directory must be owned by the current user.");
  }
  await chmod(path, 0o700);
  await assertOwnerControlledDirectory(path);
}

export async function ensureLocalLegacyReportDirectory(root = process.cwd()) {
  const stateDirectory = join(canonicalRoot(root), LOCAL_STATE_DIRECTORY);
  await ensureOwnerOnlyDirectory(stateDirectory);
  const reportDirectory = localLegacyReportDirectory(root);
  await ensureOwnerOnlyDirectory(reportDirectory);
  return reportDirectory;
}

async function inspectOne(root, file) {
  const sourcePath = legacyRootReportPath(root, file);
  const destinationPath = localLegacyReportPath(root, file);
  const [sourceMetadata, destinationMetadata] = await Promise.all([
    lstatIfExists(sourcePath),
    lstatIfExists(destinationPath),
  ]);

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
  const bytes = await readFile(sourcePath);
  const afterMetadata = await lstat(sourcePath);
  const after = metadataFingerprint(afterMetadata);
  if (!sameMetadata(before, after)) return safeEntry(file, "source_changed");
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
      await chmod(destinationPath, 0o600);
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
