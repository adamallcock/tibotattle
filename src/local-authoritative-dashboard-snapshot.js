import { createHash, randomUUID } from "node:crypto";
import {
  constants,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  resolve,
} from "node:path";

export const AUTHORITATIVE_DASHBOARD_SNAPSHOT_SCHEMA_VERSION =
  "local-authoritative-dashboard-snapshot-v1";
export const MAXIMUM_AUTHORITATIVE_DASHBOARD_SNAPSHOT_BYTES =
  16 * 1024 * 1024;

const STALE_SNAPSHOT_TEMP_AGE_MS = 24 * 60 * 60 * 1_000;
const MAXIMUM_TEMP_DIRECTORY_ENTRIES_INSPECTED = 64;
const MAXIMUM_STALE_TEMPS_REMOVED_PER_WRITE = 2;

const COMPANION_SCHEMA_VERSION = "local-companion-v0.1";
const EXPECTED_SNAPSHOT_KEYS = Object.freeze([
  "schemaVersion",
  "mode",
  "generatedAt",
  "overview",
  "gradient",
  "weekly",
  "quality",
  "reports",
]);
const TYPED_TOOL_HISTORY_WARNING =
  "Usage accounting is complete, but typed tool history is partial. Tool totals are withheld rather than reported as zero.";
const TOOL_CLASS_KEYS = Object.freeze([
  "apply_patch",
  "local_shell",
  "other",
  "subagent",
  "tool_gateway",
]);

function validSnapshotFile(value) {
  if (typeof value !== "string"
      || value.length < 1
      || value.length > 4_096
      || value.includes("\0")
      || !isAbsolute(value)) return null;
  const selected = resolve(value);
  return selected === parse(selected).root ? null : selected;
}

function canonicalInstant(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return new Date(value).toISOString() === value ? value : null;
}

function digest(payload) {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function sameFile(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function ownerOnlyFile(metadata) {
  return metadata?.isFile?.() === true
    && metadata.isSymbolicLink() === false
    && (typeof process.getuid !== "function"
      || (typeof metadata.uid === "number"
        && metadata.uid === process.getuid()))
    && (process.platform === "win32" || (metadata.mode & 0o077) === 0);
}

function ownerOnlyDirectory(metadata) {
  return metadata?.isDirectory?.() === true
    && metadata.isSymbolicLink() === false
    && (typeof process.getuid !== "function"
      || (typeof metadata.uid === "number"
        && metadata.uid === process.getuid()))
    && (process.platform === "win32" || (metadata.mode & 0o077) === 0);
}

function regexLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function snapshotTemporaryNamePattern(snapshotFile) {
  return new RegExp(
    `^${regexLiteral(basename(snapshotFile))}`
      + String.raw`\.([1-9]\d{0,9})\.`
      + String.raw`[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-`
      + String.raw`[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$`,
    "u",
  );
}

function staleOwnedSnapshotTemporary(metadata, cutoffMs) {
  return ownerOnlyFile(metadata)
    && metadata.nlink === 1
    && Number.isSafeInteger(metadata.size)
    && metadata.size >= 0
    && metadata.size <= MAXIMUM_AUTHORITATIVE_DASHBOARD_SNAPSHOT_BYTES
    && Number.isFinite(metadata.mtimeMs)
    && Number.isFinite(metadata.ctimeMs)
    && Math.max(metadata.mtimeMs, metadata.ctimeMs) <= cutoffMs
    && (process.platform === "win32"
      || (metadata.mode & 0o777) === 0o600);
}

async function removeStaleSnapshotTemporary(path, cutoffMs) {
  let before;
  try {
    before = await lstat(path);
  } catch {
    return false;
  }
  if (!staleOwnedSnapshotTemporary(before, cutoffMs)) return false;
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat();
    if (!sameFile(before, opened)
        || !staleOwnedSnapshotTemporary(opened, cutoffMs)) return false;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
  try {
    const current = await lstat(path);
    if (!sameFile(before, current)
        || !staleOwnedSnapshotTemporary(current, cutoffMs)) return false;
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

async function cleanupStaleSnapshotTemporaries({
  snapshotFile,
  directory,
  nowMs,
}) {
  const cutoffMs = nowMs - STALE_SNAPSHOT_TEMP_AGE_MS;
  if (!Number.isFinite(cutoffMs)) return;
  const pattern = snapshotTemporaryNamePattern(snapshotFile);
  let directoryHandle;
  let inspected = 0;
  let removed = 0;
  try {
    directoryHandle = await opendir(directory);
    for await (const entry of directoryHandle) {
      if (inspected >= MAXIMUM_TEMP_DIRECTORY_ENTRIES_INSPECTED
          || removed >= MAXIMUM_STALE_TEMPS_REMOVED_PER_WRITE) break;
      inspected += 1;
      if (entry.isFile() !== true || !pattern.test(entry.name)) continue;
      if (await removeStaleSnapshotTemporary(
        join(directory, entry.name),
        cutoffMs,
      )) removed += 1;
    }
  } catch {
    // Cleanup is deliberately best-effort. An ambiguous entry or directory
    // read failure must not turn durable snapshot publication into a failure.
  } finally {
    await directoryHandle?.close().catch(() => {});
  }
}

function exactToolValues(value, expected) {
  const counts = value?.counts;
  return value?.total === expected
    && counts && typeof counts === "object" && !Array.isArray(counts)
    && TOOL_CLASS_KEYS.every((key) => counts[key] === expected)
    && Object.keys(counts).every((key) => TOOL_CLASS_KEYS.includes(key));
}

function typedToolGap(snapshot) {
  const overview = snapshot?.overview;
  const accounting = overview?.accounting;
  const history = overview?.timeline?.history;
  const declared = history?.status === "partial"
    && [undefined, "typed_tool_history_partial"].includes(history.reason)
    && Array.isArray(overview?.warnings)
    && overview.warnings.includes(TYPED_TOOL_HISTORY_WARNING);
  if (!declared) return null;
  const safelyWithheld = overview?.activity?.toolEvents === null
    && overview?.tools?.status === "unavailable"
    && overview.tools.reason === "typed_tool_history_partial"
    && exactToolValues(overview.tools, null)
    && accounting?.toolClasses?.status === "unavailable"
    && accounting.toolClasses.reason === "typed_tool_history_partial"
    && exactToolValues(accounting.toolClasses, null);
  // v0.1.16 used numeric zero placeholders beside the explicit withholding
  // warning. Accept that trusted in-process shape only so it can be
  // canonicalized before persistence; a retained receipt never contains or
  // re-publishes those zeroes.
  const legacyZeroPlaceholders = overview?.activity?.toolEvents === 0
    && [undefined, "unavailable"].includes(overview?.tools?.status)
    && [undefined, "typed_tool_history_partial"].includes(
      overview?.tools?.reason,
    )
    && exactToolValues(overview?.tools, 0)
    && [undefined, "unavailable"].includes(accounting?.toolClasses?.status)
    && [undefined, "typed_tool_history_partial"].includes(
      accounting?.toolClasses?.reason,
    )
    && exactToolValues(accounting?.toolClasses, 0);
  return safelyWithheld || legacyZeroPlaceholders
    ? { safelyWithheld, legacyZeroPlaceholders }
    : null;
}

function snapshotForPersistence(snapshot) {
  const gap = typedToolGap(snapshot);
  if (gap?.legacyZeroPlaceholders !== true) return snapshot;
  const canonical = structuredClone(snapshot);
  const withheld = {
    status: "unavailable",
    reason: "typed_tool_history_partial",
    total: null,
    counts: Object.fromEntries(TOOL_CLASS_KEYS.map((key) => [key, null])),
  };
  canonical.overview.timeline.history.reason = "typed_tool_history_partial";
  canonical.overview.activity.toolEvents = null;
  canonical.overview.tools = structuredClone(withheld);
  canonical.overview.accounting.toolClasses = structuredClone(withheld);
  return canonical;
}

/**
 * The only snapshots eligible for persistence. A complete, generation-bound
 * unified publication may legitimately contain zero usage; the attestation
 * fields distinguish that true empty state from the zero placeholders a
 * failed/partial projection produces.
 */
export function isAuthoritativeDashboardSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return false;
  }
  if (Object.keys(snapshot).sort().join("\0")
      !== [...EXPECTED_SNAPSHOT_KEYS].sort().join("\0")
      || snapshot.schemaVersion !== COMPANION_SCHEMA_VERSION
      || snapshot.mode !== "real_local_evidence"
      || canonicalInstant(snapshot.generatedAt) === null) {
    return false;
  }
  const overview = snapshot.overview;
  const accounting = overview?.accounting;
  const projection = accounting?.projection;
  const history = overview?.timeline?.history;
  const historyCoverage = accounting?.historyCoverage;
  const generation = accounting?.generation;
  const fingerprint = accounting?.generationFingerprint;
  const generationPresent = (
    (Number.isSafeInteger(generation) && generation >= 1)
    || (typeof generation === "string" && generation.length > 0)
  );
  const toolGap = typedToolGap(snapshot);
  const timelineAuthoritative = history?.status === "complete"
    || (history?.status === "partial"
      && toolGap !== null);
  return overview && typeof overview === "object" && !Array.isArray(overview)
    && accounting && typeof accounting === "object"
    && projection?.status === "available"
    && projection.reason === null
    && projection.terminal === false
    && accounting.sourceMode === "unified"
    && accounting.generationMatched === true
    && generationPresent
    && typeof fingerprint === "string"
    && fingerprint.length > 0
    && accounting.sourceCoverageStatus === "complete"
    && accounting.accountingCacheStatus === "available"
    && timelineAuthoritative
    && historyCoverage?.status === "complete"
    && historyCoverage.phase === "complete";
}

function encode(snapshot, savedAt) {
  let snapshotPayload;
  try {
    snapshotPayload = JSON.stringify(snapshot);
  } catch {
    return null;
  }
  if (typeof snapshotPayload !== "string") return null;
  const envelopeMetadata = JSON.stringify({
    schemaVersion: AUTHORITATIVE_DASHBOARD_SNAPSHOT_SCHEMA_VERSION,
    savedAt,
    digest: digest(snapshotPayload),
  });
  // `snapshotPayload` is already the canonical JSON protected by the digest.
  // Splicing it into the small metadata object preserves JSON.stringify's
  // exact property order and bytes without synchronously traversing an 8 MB
  // snapshot a second time.
  const envelope = `${envelopeMetadata.slice(0, -1)},"snapshot":${snapshotPayload}}`;
  return Buffer.byteLength(envelope, "utf8")
      <= MAXIMUM_AUTHORITATIVE_DASHBOARD_SNAPSHOT_BYTES
    ? envelope
    : null;
}

function decode(payload) {
  let envelope;
  try {
    envelope = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
      || Object.keys(envelope).sort().join("\0")
        !== ["schemaVersion", "savedAt", "digest", "snapshot"]
          .sort().join("\0")
      || envelope.schemaVersion
        !== AUTHORITATIVE_DASHBOARD_SNAPSHOT_SCHEMA_VERSION
      || canonicalInstant(envelope.savedAt) === null
      || typeof envelope.digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(envelope.digest)
      || !isAuthoritativeDashboardSnapshot(envelope.snapshot)) {
    return null;
  }
  const snapshotPayload = JSON.stringify(envelope.snapshot);
  if (digest(snapshotPayload) !== envelope.digest) return null;
  return {
    savedAt: envelope.savedAt,
    snapshot: envelope.snapshot,
  };
}

/**
 * Read a previously persisted projection. Any missing, oversized, open-mode,
 * raced, malformed, or non-authoritative file is treated as absent.
 */
export async function readAuthoritativeDashboardSnapshot({ snapshotFile } = {}) {
  const selected = validSnapshotFile(snapshotFile);
  if (selected === null) return null;
  let metadata;
  try {
    metadata = await lstat(selected);
  } catch {
    return null;
  }
  if (!ownerOnlyFile(metadata)
      || metadata.size < 2
      || metadata.size > MAXIMUM_AUTHORITATIVE_DASHBOARD_SNAPSHOT_BYTES) {
    return null;
  }
  let handle;
  try {
    handle = await open(selected, constants.O_RDONLY);
    const opened = await handle.stat();
    if (!ownerOnlyFile(opened)
        || !sameFile(metadata, opened)
        || opened.size > MAXIMUM_AUTHORITATIVE_DASHBOARD_SNAPSHOT_BYTES) {
      return null;
    }
    const payload = await handle.readFile({ encoding: "utf8" });
    return decode(payload);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Atomically replace the retained projection beside the app's other
 * owner-only state. Non-authoritative candidates are ignored and never
 * overwrite the last good receipt.
 */
export async function writeAuthoritativeDashboardSnapshot({
  snapshotFile,
  snapshot,
  now = () => Date.now(),
} = {}) {
  const selected = validSnapshotFile(snapshotFile);
  if (selected === null || typeof now !== "function"
      || !isAuthoritativeDashboardSnapshot(snapshot)) return false;
  let nowMs;
  try {
    nowMs = now();
  } catch {
    return false;
  }
  if (!Number.isFinite(nowMs)) return false;
  let savedAt;
  try {
    savedAt = new Date(nowMs).toISOString();
  } catch {
    return false;
  }
  const payload = encode(snapshotForPersistence(snapshot), savedAt);
  if (payload === null) return false;
  const directory = dirname(selected);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryMetadata = await lstat(directory);
    if (!ownerOnlyDirectory(directoryMetadata)) return false;
  } catch {
    return false;
  }
  await cleanupStaleSnapshotTemporaries({
    snapshotFile: selected,
    directory,
    nowMs,
  });
  const temporary = `${selected}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(payload, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, selected);
    // Best-effort directory sync makes the rename durable on filesystems that
    // support opening directories. Failure here does not invalidate the
    // already atomic replacement.
    try {
      const directoryHandle = await open(directory, constants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      // Unsupported on some platforms.
    }
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}
