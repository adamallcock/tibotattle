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

const DEFAULT_MAXIMUM_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const STALE_SNAPSHOT_TEMP_AGE_MS = 24 * 60 * 60 * 1_000;
const MAXIMUM_TEMP_DIRECTORY_ENTRIES_INSPECTED = 64;
const MAXIMUM_STALE_TEMPS_REMOVED_PER_WRITE = 2;

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

function staleOwnedSnapshotTemporary(metadata, cutoffMs, maximumBytes) {
  return ownerOnlyFile(metadata)
    && metadata.nlink === 1
    && Number.isSafeInteger(metadata.size)
    && metadata.size >= 0
    && metadata.size <= maximumBytes
    && Number.isFinite(metadata.mtimeMs)
    && Number.isFinite(metadata.ctimeMs)
    && Math.max(metadata.mtimeMs, metadata.ctimeMs) <= cutoffMs
    && (process.platform === "win32"
      || (metadata.mode & 0o777) === 0o600);
}

async function removeStaleSnapshotTemporary(path, cutoffMs, maximumBytes) {
  let before;
  try {
    before = await lstat(path);
  } catch {
    return false;
  }
  if (!staleOwnedSnapshotTemporary(before, cutoffMs, maximumBytes)) return false;
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat();
    if (!sameFile(before, opened)
        || !staleOwnedSnapshotTemporary(opened, cutoffMs, maximumBytes)) return false;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
  try {
    const current = await lstat(path);
    if (!sameFile(before, current)
        || !staleOwnedSnapshotTemporary(current, cutoffMs, maximumBytes)) return false;
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
  maximumBytes,
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
        maximumBytes,
      )) removed += 1;
    }
  } catch {
    // Cleanup is deliberately best-effort. An ambiguous entry or directory
    // read failure must not turn durable snapshot publication into a failure.
  } finally {
    await directoryHandle?.close().catch(() => {});
  }
}

function validSnapshot(snapshot, validate) {
  try {
    return validate(snapshot) === true;
  } catch {
    return false;
  }
}

function encode(snapshot, savedAt, schemaVersion, maximumBytes) {
  let snapshotPayload;
  try {
    snapshotPayload = JSON.stringify(snapshot);
  } catch {
    return null;
  }
  if (typeof snapshotPayload !== "string") return null;
  const envelopeMetadata = JSON.stringify({
    schemaVersion,
    savedAt,
    digest: digest(snapshotPayload),
  });
  // `snapshotPayload` is already the canonical JSON protected by the digest.
  // Splicing it into the small metadata object preserves JSON.stringify's
  // exact property order and bytes without synchronously traversing an 8 MB
  // snapshot a second time.
  const envelope = `${envelopeMetadata.slice(0, -1)},"snapshot":${snapshotPayload}}`;
  return Buffer.byteLength(envelope, "utf8")
      <= maximumBytes
    ? envelope
    : null;
}

function decode(payload, schemaVersion, validate) {
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
      || envelope.schemaVersion !== schemaVersion
      || canonicalInstant(envelope.savedAt) === null
      || typeof envelope.digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(envelope.digest)
      || !validSnapshot(envelope.snapshot, validate)) {
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
 * Shared owner-only transport for validated, content-free local projections.
 * Surface adapters supply their own closed schema and completeness validator.
 * Missing or invalid receipts are absent; failed writes preserve the last good
 * receipt. The envelope is compatible with the authoritative dashboard cache.
 */
export function createValidatedSnapshotStore({
  snapshotFile,
  schemaVersion,
  validate,
  maximumBytes = DEFAULT_MAXIMUM_SNAPSHOT_BYTES,
  now = () => Date.now(),
} = {}) {
  const selected = validSnapshotFile(snapshotFile);
  const configured = selected !== null
    && typeof schemaVersion === "string"
    && schemaVersion.length > 0 && schemaVersion.length <= 200
    && typeof validate === "function"
    && Number.isSafeInteger(maximumBytes) && maximumBytes >= 2;

  async function read() {
    if (!configured) return null;
    let metadata;
    try {
      metadata = await lstat(selected);
    } catch {
      return null;
    }
    if (!ownerOnlyFile(metadata)
        || !Number.isSafeInteger(metadata.size)
        || metadata.size < 2
        || metadata.size > maximumBytes) return null;
    let handle;
    try {
      handle = await open(
        selected,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const opened = await handle.stat();
      if (!ownerOnlyFile(opened)
          || !sameFile(metadata, opened)
          || !Number.isSafeInteger(opened.size)
          || opened.size < 2
          || opened.size > maximumBytes) return null;
      // The extra byte detects growth after stat without allowing readFile to
      // allocate beyond the checked bound if another writer appends in place.
      const buffer = Buffer.alloc(opened.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer, offset, buffer.length - offset, offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset !== opened.size) return null;
      return decode(buffer.subarray(0, offset).toString("utf8"), schemaVersion, validate);
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function write(snapshot) {
    if (!configured || typeof now !== "function"
        || !validSnapshot(snapshot, validate)) return false;
    let nowMs;
    let savedAt;
    try {
      nowMs = now();
      if (!Number.isFinite(nowMs)) return false;
      savedAt = new Date(nowMs).toISOString();
    } catch {
      return false;
    }
    const payload = encode(snapshot, savedAt, schemaVersion, maximumBytes);
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
      maximumBytes,
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
      // Best-effort directory sync makes the rename durable on filesystems
      // that support it; unsupported sync does not invalidate replacement.
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

  return Object.freeze({ read, write });
}
