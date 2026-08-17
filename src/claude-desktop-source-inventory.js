import { createHash, createHmac } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

export const CLAUDE_DESKTOP_SOURCE_INVENTORY_VERSION =
  "claude-desktop-source-inventory-v0.1";

const MAXIMUM_METADATA_BYTES = 2 * 1024 * 1024;
const MAXIMUM_MARKER_BYTES = 4 * 1024;

export class ClaudeDesktopSourceInventoryError extends Error {
  constructor(code) {
    super(`Claude Desktop source inventory failed (${code})`);
    this.name = "ClaudeDesktopSourceInventoryError";
    this.code = `claude_desktop_source_inventory_${code}`;
  }
}

function fail(code) {
  throw new ClaudeDesktopSourceInventoryError(code);
}

function safeSignal(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object"
      || typeof value.aborted !== "boolean"
      || typeof value.addEventListener !== "function") fail("configuration");
  return value;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  throw error;
}

function secretBuffer(secret) {
  if (!(secret instanceof Uint8Array) || secret.byteLength !== 32) fail("configuration");
  return Buffer.from(secret);
}

function privateKey(secret, domain, value) {
  return createHmac("sha256", secret)
    .update(`app-usagemonitor/${domain}/v1\0`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function safeLimit(value, fallback, maximum) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    fail("configuration");
  }
  return selected;
}

async function boundedFile(path, maximumBytes, signal = null) {
  let handle;
  try {
    throwIfAborted(signal);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
        || before.size > maximumBytes) fail("source_unsafe");
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) {
      fail("source_changed");
    }
    const value = await handle.readFile();
    throwIfAborted(signal);
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) fail("source_changed");
    return value;
  } catch (error) {
    if (error instanceof ClaudeDesktopSourceInventoryError) throw error;
    if (error?.name === "AbortError") throw error;
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") fail("source_missing");
    fail("source_unavailable");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function markerState(path, signal = null) {
  if (!path) return { present: false, accessible: true, sha256: null };
  try {
    const value = await boundedFile(path, MAXIMUM_MARKER_BYTES, signal);
    return {
      present: true,
      accessible: true,
      sha256: createHash("sha256").update(value).digest("hex"),
    };
  } catch (error) {
    if (error?.code === "claude_desktop_source_inventory_source_missing") {
      return { present: false, accessible: true, sha256: null };
    }
    if (error?.code === "claude_desktop_source_inventory_source_unavailable") {
      return { present: false, accessible: false, sha256: null };
    }
    throw error;
  }
}

async function enumerateFiles(root, {
  maximumFiles,
  maximumEntries,
  maximumDepth,
  include,
  signal,
}) {
  const files = [];
  let complete = true;
  let inaccessibleEntries = 0;
  let observedEntries = 0;

  async function walk(directory, depth) {
    throwIfAborted(signal);
    if (depth > maximumDepth) {
      complete = false;
      return;
    }
    let stream;
    try {
      const stats = await lstat(directory);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        complete = false;
        inaccessibleEntries += 1;
        return;
      }
      stream = await opendir(directory);
      const entries = [];
      for await (const entry of stream) entries.push(entry);
      entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
      for (const entry of entries) {
        throwIfAborted(signal);
        observedEntries += 1;
        if (observedEntries > maximumEntries) fail("entry_limit");
        if (files.length >= maximumFiles) fail("file_limit");
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          complete = false;
          inaccessibleEntries += 1;
        } else if (entry.isDirectory()) {
          await walk(path, depth + 1);
        } else if (entry.isFile() && include(entry.name)) {
          files.push(path);
        }
      }
    } catch (error) {
      if (error instanceof ClaudeDesktopSourceInventoryError) throw error;
      if (error?.name === "AbortError") throw error;
      complete = false;
      inaccessibleEntries += 1;
    } finally {
      await stream?.close().catch(() => {});
    }
  }

  await walk(resolve(root), 0);
  return { files, complete, inaccessibleEntries, observedEntries };
}

function surfaceForMetadataFilename(filename) {
  if (filename.startsWith("local_")) return "local";
  if (filename.startsWith("ssh_")) return "ssh";
  if (filename.startsWith("remote_")) return "remote";
  return "unknown";
}

async function readMetadata(path, signal = null) {
  try {
    const raw = await boundedFile(path, MAXIMUM_METADATA_BYTES, signal);
    const value = JSON.parse(raw.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function relativeParts(root, path) {
  const value = relative(resolve(root), resolve(path));
  if (!value || value === ".." || value.startsWith(`..${sep}`)) fail("source_unsafe");
  return value.split(sep);
}

function isWithin(path, root) {
  const value = relative(resolve(root), resolve(path));
  return value === "" || (!value.startsWith("..") && !value.startsWith(sep));
}

export async function inventoryClaudeDesktopSources({
  metadataDirectory,
  projectsDirectory,
  cleanupMarkerPath = null,
  secret,
  maximumMetadataFiles,
  maximumTranscriptFiles,
  maximumDepth,
  includePrivatePlan = false,
  afterEnumeration = async () => {},
  signal = null,
} = {}) {
  if (typeof metadataDirectory !== "string" || typeof projectsDirectory !== "string"
      || metadataDirectory.length === 0 || projectsDirectory.length === 0
      || typeof includePrivatePlan !== "boolean" || typeof afterEnumeration !== "function") {
    fail("configuration");
  }
  const key = secretBuffer(secret);
  const selectedSignal = safeSignal(signal);
  throwIfAborted(selectedSignal);
  const metadataLimit = safeLimit(maximumMetadataFiles, 4_096, 100_000);
  const transcriptLimit = safeLimit(maximumTranscriptFiles, 25_000, 250_000);
  const depthLimit = safeLimit(maximumDepth, 12, 64);

  try {
  const markerBefore = await markerState(cleanupMarkerPath, selectedSignal);
  const metadataEnumeration = await enumerateFiles(metadataDirectory, {
    maximumFiles: metadataLimit,
    maximumEntries: Math.min(400_000, metadataLimit * 4),
    maximumDepth: depthLimit,
    include: (name) => extname(name) === ".json",
    signal: selectedSignal,
  });
  const transcriptEnumeration = await enumerateFiles(projectsDirectory, {
    maximumFiles: transcriptLimit,
    maximumEntries: Math.min(1_000_000, transcriptLimit * 4),
    maximumDepth: depthLimit,
    include: (name) => extname(name) === ".jsonl",
    signal: selectedSignal,
  });
  await afterEnumeration();
  throwIfAborted(selectedSignal);

  const topLevelById = new Map();
  const topLevelPaths = new Set();
  const nestedPaths = [];
  for (const path of transcriptEnumeration.files) {
    throwIfAborted(selectedSignal);
    const parts = relativeParts(projectsDirectory, path);
    if (parts.length === 2) {
      const id = basename(path, ".jsonl");
      const candidates = topLevelById.get(id) ?? [];
      candidates.push(path);
      topLevelById.set(id, candidates);
      topLevelPaths.add(path);
    } else {
      nestedPaths.push(path);
    }
  }

  const entries = [];
  const selectedParentPaths = new Set();
  const authorizedChildPaths = new Set();
  let malformedMetadata = 0;
  for (const path of metadataEnumeration.files) {
    throwIfAborted(selectedSignal);
    const value = await readMetadata(path, selectedSignal);
    if (!value) {
      malformedMetadata += 1;
      continue;
    }
    const surface = surfaceForMetadataFilename(basename(path));
    const rawSessionId = typeof value.sessionId === "string" ? value.sessionId : "";
    const rawCliSessionId = typeof value.cliSessionId === "string" ? value.cliSessionId : "";
    if (!rawSessionId && !rawCliSessionId) continue;
    const metadataKey = privateKey(key, "claude-desktop-metadata", rawSessionId || rawCliSessionId);
    if (surface !== "local") {
      entries.push({ metadataKey, surface, status: "unsupported_surface", childTranscriptCount: 0 });
      continue;
    }
    if (!rawCliSessionId || Buffer.byteLength(rawCliSessionId, "utf8") > 4_096) {
      entries.push({ metadataKey, surface, status: "identifier_unavailable", childTranscriptCount: 0 });
      continue;
    }
    const parents = topLevelById.get(rawCliSessionId) ?? [];
    if (parents.length !== 1) {
      entries.push({
        metadataKey,
        surface,
        status: parents.length === 0 ? "parent_missing" : "parent_ambiguous",
        childTranscriptCount: 0,
      });
      continue;
    }
    const parentPath = parents[0];
    selectedParentPaths.add(parentPath);
    const childRoot = join(dirname(parentPath), rawCliSessionId);
    let childTranscriptCount = 0;
    for (const nestedPath of nestedPaths) {
      if (isWithin(nestedPath, childRoot)) {
        authorizedChildPaths.add(nestedPath);
        childTranscriptCount += 1;
      }
    }
    entries.push({
      metadataKey,
      surface,
      status: "selected",
      parentSourceKey: privateKey(key, "claude-desktop-parent-source", parentPath),
      childTranscriptCount,
    });
  }

  let orphanTranscriptCount = 0;
  let unselectedChildTranscriptCount = 0;
  for (const path of nestedPaths) {
    if (authorizedChildPaths.has(path)) continue;
    const parts = relativeParts(projectsDirectory, path);
    const siblingParent = parts.length >= 2
      ? join(resolve(projectsDirectory), parts[0], `${parts[1]}.jsonl`)
      : null;
    if (siblingParent && topLevelPaths.has(siblingParent)) unselectedChildTranscriptCount += 1;
    else orphanTranscriptCount += 1;
  }

  const markerAfter = await markerState(cleanupMarkerPath, selectedSignal);
  const cleanupRaced = markerBefore.present !== markerAfter.present
    || markerBefore.sha256 !== markerAfter.sha256;
  const cleanupMarkerAccessible = markerBefore.accessible && markerAfter.accessible;
  const enumerationComplete = metadataEnumeration.complete && transcriptEnumeration.complete;
  const status = cleanupRaced || !cleanupMarkerAccessible || !enumerationComplete
    ? "partial" : "complete";
  entries.sort((left, right) => left.metadataKey.localeCompare(right.metadataKey, "en"));

  const statusCounts = {};
  for (const entry of entries) statusCounts[entry.status] = (statusCounts[entry.status] ?? 0) + 1;
  const result = {
    schemaVersion: CLAUDE_DESKTOP_SOURCE_INVENTORY_VERSION,
    status,
    cleanupRaced,
    cleanupMarkerAccessible,
    enumerationComplete,
    metadataFileCount: metadataEnumeration.files.length,
    malformedMetadata,
    transcriptFileCount: transcriptEnumeration.files.length,
    topLevelTranscriptCount: topLevelPaths.size,
    nestedTranscriptCount: nestedPaths.length,
    selectedChildTranscriptCount: authorizedChildPaths.size,
    unselectedChildTranscriptCount,
    orphanTranscriptCount,
    inaccessibleEntryCount:
      metadataEnumeration.inaccessibleEntries + transcriptEnumeration.inaccessibleEntries,
    observedEntryCount:
      metadataEnumeration.observedEntries + transcriptEnumeration.observedEntries,
    statusCounts,
    entries,
  };
  if (includePrivatePlan) {
    result.privatePlan = {
      // This is intentionally opt-in and must remain in process memory. The
      // ordinary inventory projection above contains no raw path or identifier.
      sourcePaths: [...selectedParentPaths, ...authorizedChildPaths]
        .sort((left, right) => left.localeCompare(right, "en")),
    };
  }
  return result;
  } finally {
    key.fill(0);
  }
}
