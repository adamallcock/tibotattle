import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

/**
 * Synthetic-only object transfer contract rehearsal. It qualifies bounded,
 * resumable R2-like source to GCS-like destination behavior without importing
 * cloud SDKs, reading credentials, or issuing provider requests.
 *
 * A real adapter must provide a stable source version token, stream object
 * bodies in bounded chunks, abort an atomic create-only write when its input
 * stream rejects, and pin reference reads to the returned immutable GCS
 * generation.
 */

export const OBJECT_TRANSFER_REHEARSAL_SCHEMA = "object-transfer-rehearsal-v1";
export const OBJECT_TRANSFER_DEFAULT_PAGE_SIZE = 100;
export const OBJECT_TRANSFER_MAX_PAGE_SIZE = 500;
export const OBJECT_TRANSFER_MAX_OBJECTS = 100_000;
export const OBJECT_TRANSFER_MAX_TOTAL_BYTES = 1_099_511_627_776;
export const OBJECT_TRANSFER_MAX_STREAM_CHUNK_BYTES = 256 * 1024;
export const OBJECT_TRANSFER_DEFAULT_ATTEMPTS = 3;
export const OBJECT_TRANSFER_MAX_ATTEMPTS = 5;
const MAX_KEY_BYTES = 1_024;
const MAX_VERSION_BYTES = 1_024;
const MAX_METADATA_BYTES = 16 * 1_024;
const SHA256 = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();

export class ObjectTransferRehearsalError extends Error {
  constructor(code) {
    super(code);
    this.name = "ObjectTransferRehearsalError";
    this.code = code;
  }
}

/** Adapters may mark transport failures retryable after aborting partial writes. */
export class ObjectTransferRetryableError extends Error {
  constructor() {
    super("OBJECT_TRANSFER_RETRYABLE");
    this.name = "ObjectTransferRetryableError";
  }
}

/** A create-only destination write lost a race to an existing generation. */
export class ObjectTransferTargetExistsError extends Error {
  constructor() {
    super("OBJECT_TRANSFER_TARGET_EXISTS");
    this.name = "ObjectTransferTargetExistsError";
  }
}

function fail(code) {
  throw new ObjectTransferRehearsalError(code);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256() {
  return createHash("sha256");
}

function hashText(value) {
  return sha256().update(value).digest("hex");
}

function canonicalMetadata(value) {
  if (value === undefined || value === null) value = {};
  if (!isRecord(value)) fail("OBJECT_TRANSFER_METADATA_INVALID");
  const allowed = new Set(["contentType", "customMetadata"]);
  if (Object.keys(value).some(key => !allowed.has(key))) fail("OBJECT_TRANSFER_METADATA_INVALID");
  const contentType = value.contentType ?? "application/octet-stream";
  if (typeof contentType !== "string" || contentType.length === 0
      || encoder.encode(contentType).byteLength > 1_024
      || /[\u0000-\u001f\u007f]/u.test(contentType)) {
    fail("OBJECT_TRANSFER_METADATA_INVALID");
  }
  const rawCustom = value.customMetadata ?? {};
  if (!isRecord(rawCustom)) fail("OBJECT_TRANSFER_METADATA_INVALID");
  // A normal object treats `__proto__` as a setter. Metadata names are user
  // supplied, so keep them as literal own-properties instead of allowing
  // assignment to silently change the prototype and drop a value.
  const customMetadata = Object.create(null);
  let customBytes = 0;
  for (const key of Object.keys(rawCustom).sort()) {
    const item = rawCustom[key];
    if (key.length === 0 || encoder.encode(key).byteLength > 1_024
        || /[\u0000-\u001f\u007f]/u.test(key)
        || typeof item !== "string" || encoder.encode(item).byteLength > 1_024
        || /[\u0000-\u001f\u007f]/u.test(item)) {
      fail("OBJECT_TRANSFER_METADATA_INVALID");
    }
    customMetadata[key] = item;
    customBytes += encoder.encode(key).byteLength + encoder.encode(item).byteLength;
  }
  const result = Object.freeze({
    contentType,
    customMetadata: Object.freeze(customMetadata),
  });
  if (encoder.encode(metadataCanonicalJson(result)).byteLength + customBytes > MAX_METADATA_BYTES) {
    fail("OBJECT_TRANSFER_METADATA_LIMIT");
  }
  return result;
}

function metadataCanonicalJson(value) {
  const metadata = value.customMetadata ?? {};
  return JSON.stringify([value.contentType, Object.keys(metadata).sort().map(key => [key, metadata[key]])]);
}

function metadataDigest(value) {
  return hashText(metadataCanonicalJson(value));
}

function validKey(value, prefix) {
  if (typeof value !== "string" || value.length === 0 || encoder.encode(value).byteLength > MAX_KEY_BYTES
      || /[\u0000-\u001f\u007f]/u.test(value) || !value.startsWith(prefix)) {
    fail("OBJECT_TRANSFER_KEY_INVALID");
  }
  return value;
}

function validVersion(value) {
  if (typeof value !== "string" || value.length === 0 || encoder.encode(value).byteLength > MAX_VERSION_BYTES
      || /[\u0000-\u001f\u007f]/u.test(value)) fail("OBJECT_TRANSFER_SOURCE_VERSION_INVALID");
  return value;
}

function safeSize(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > OBJECT_TRANSFER_MAX_TOTAL_BYTES) {
    fail("OBJECT_TRANSFER_SIZE_INVALID");
  }
  return value;
}

function normalizeEntry(value, { prefix, source }) {
  if (!isRecord(value)) fail("OBJECT_TRANSFER_INVENTORY_INVALID");
  const key = validKey(value.key, prefix);
  const size = safeSize(value.size);
  const metadata = canonicalMetadata(value.metadata);
  return Object.freeze({
    key,
    size,
    metadata,
    version: source ? validVersion(value.version) : null,
  });
}

function normalizeOptions(value) {
  if (!isRecord(value)) fail("OBJECT_TRANSFER_OPTIONS_INVALID");
  const prefix = value.prefix;
  if (typeof prefix !== "string" || prefix.length === 0 || !prefix.endsWith("/")
      || encoder.encode(prefix).byteLength > MAX_KEY_BYTES || /[\u0000-\u001f\u007f]/u.test(prefix)) {
    fail("OBJECT_TRANSFER_PREFIX_INVALID");
  }
  const pageSize = value.pageSize ?? OBJECT_TRANSFER_DEFAULT_PAGE_SIZE;
  const maxObjects = value.maxObjects ?? OBJECT_TRANSFER_MAX_OBJECTS;
  const maxTotalBytes = value.maxTotalBytes ?? OBJECT_TRANSFER_MAX_TOTAL_BYTES;
  const maxAttempts = value.maxAttempts ?? OBJECT_TRANSFER_DEFAULT_ATTEMPTS;
  const maxObjectsThisRun = value.maxObjectsThisRun ?? maxObjects;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > OBJECT_TRANSFER_MAX_PAGE_SIZE
      || !Number.isSafeInteger(maxObjects) || maxObjects < 1 || maxObjects > OBJECT_TRANSFER_MAX_OBJECTS
      || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 0 || maxTotalBytes > OBJECT_TRANSFER_MAX_TOTAL_BYTES
      || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > OBJECT_TRANSFER_MAX_ATTEMPTS
      || !Number.isSafeInteger(maxObjectsThisRun) || maxObjectsThisRun < 1 || maxObjectsThisRun > maxObjects) {
    fail("OBJECT_TRANSFER_LIMIT_INVALID");
  }
  return Object.freeze({ prefix, pageSize, maxObjects, maxTotalBytes, maxAttempts, maxObjectsThisRun });
}

function compareKeys(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function appendInventoryHash(hash, entry, { source }) {
  const custom = entry.metadata.customMetadata;
  const portable = [entry.key, entry.size, entry.metadata.contentType,
    Object.keys(custom).sort().map(key => [key, custom[key]])];
  hash.portable.update(`${JSON.stringify(portable)}\n`);
  if (source) hash.pinned.update(`${JSON.stringify([...portable, entry.version])}\n`);
}

async function scanInventory(store, { prefix, pageSize, maxObjects, maxTotalBytes }, { source }) {
  const hash = { portable: sha256(), pinned: sha256() };
  const seenCursors = new Set();
  let cursor = null;
  let previousKey = null;
  let objects = 0;
  let totalBytes = 0;
  for (;;) {
    let page;
    try {
      page = await store.listPage({ prefix, cursor, limit: pageSize });
    } catch (error) {
      if (error instanceof ObjectTransferRehearsalError) throw error;
      fail(source ? "OBJECT_TRANSFER_SOURCE_INVENTORY_UNAVAILABLE" : "OBJECT_TRANSFER_TARGET_INVENTORY_UNAVAILABLE");
    }
    if (!isRecord(page) || !Array.isArray(page.objects) || page.objects.length > pageSize) {
      fail("OBJECT_TRANSFER_INVENTORY_INVALID");
    }
    for (const raw of page.objects) {
      const entry = normalizeEntry(raw, { prefix, source });
      if (previousKey !== null && compareKeys(previousKey, entry.key) >= 0) {
        fail("OBJECT_TRANSFER_INVENTORY_ORDER_INVALID");
      }
      previousKey = entry.key;
      objects += 1;
      totalBytes += entry.size;
      if (!Number.isSafeInteger(totalBytes) || objects > maxObjects || totalBytes > maxTotalBytes) {
        fail("OBJECT_TRANSFER_INVENTORY_LIMIT");
      }
      appendInventoryHash(hash, entry, { source });
    }
    const next = page.nextCursor;
    if (next === null) break;
    if (typeof next !== "string" || next.length === 0 || encoder.encode(next).byteLength > MAX_VERSION_BYTES
        || page.objects.length === 0 || seenCursors.has(next)) {
      fail("OBJECT_TRANSFER_CURSOR_INVALID");
    }
    seenCursors.add(next);
    cursor = next;
  }
  return Object.freeze({
    objects,
    totalBytes,
    portableInventorySha256: hash.portable.digest("hex"),
    ...(source ? { sourceManifestSha256: hash.pinned.digest("hex") } : {}),
  });
}

function assertStoreInterfaces(source, target, checkpoints) {
  if (!source || typeof source.listPage !== "function" || typeof source.openRead !== "function"
      || !target || typeof target.listPage !== "function" || typeof target.head !== "function"
      || typeof target.openRead !== "function" || typeof target.putIfAbsent !== "function"
      || !checkpoints || typeof checkpoints.get !== "function" || typeof checkpoints.put !== "function") {
    fail("OBJECT_TRANSFER_ADAPTER_INVALID");
  }
}

async function readStreamHash(opened, expectedVersion, kind) {
  if (!isRecord(opened) || !(Symbol.asyncIterator in Object(opened.body))) {
    fail("OBJECT_TRANSFER_STREAM_INVALID");
  }
  if (kind === "source" && opened.version !== expectedVersion) fail("OBJECT_TRANSFER_SOURCE_CHANGED");
  if (kind === "target" && opened.generation !== expectedVersion) fail("OBJECT_TRANSFER_TARGET_CHANGED");
  const digest = sha256();
  let bytes = 0;
  let maxChunkBytes = 0;
  try {
    for await (const chunk of opened.body) {
      if (!(chunk instanceof Uint8Array) || chunk.byteLength < 1
          || chunk.byteLength > OBJECT_TRANSFER_MAX_STREAM_CHUNK_BYTES) {
        fail("OBJECT_TRANSFER_STREAM_CHUNK_INVALID");
      }
      bytes += chunk.byteLength;
      if (!Number.isSafeInteger(bytes) || bytes > OBJECT_TRANSFER_MAX_TOTAL_BYTES) {
        fail("OBJECT_TRANSFER_STREAM_LIMIT");
      }
      maxChunkBytes = Math.max(maxChunkBytes, chunk.byteLength);
      digest.update(chunk);
    }
  } catch (error) {
    if (error instanceof ObjectTransferRehearsalError || error instanceof ObjectTransferRetryableError) throw error;
    fail(kind === "source" ? "OBJECT_TRANSFER_SOURCE_READ_FAILED" : "OBJECT_TRANSFER_TARGET_READ_FAILED");
  }
  return { bytes, sha256: digest.digest("hex"), maxChunkBytes };
}

async function sourceReadSummary(source, entry) {
  let opened;
  try {
    opened = await source.openRead({ key: entry.key, ifVersion: entry.version });
  } catch (error) {
    if (error instanceof ObjectTransferRetryableError || error instanceof ObjectTransferRehearsalError) throw error;
    fail("OBJECT_TRANSFER_SOURCE_READ_FAILED");
  }
  return readStreamHash(opened, entry.version, "source");
}

async function targetReadSummary(target, key, generation) {
  let opened;
  try {
    opened = await target.openRead({ key, ifGeneration: generation });
  } catch (error) {
    if (error instanceof ObjectTransferRetryableError || error instanceof ObjectTransferRehearsalError) throw error;
    fail("OBJECT_TRANSFER_TARGET_READ_FAILED");
  }
  return readStreamHash(opened, generation, "target");
}

function normalizeHead(value, key, prefix) {
  if (value === null) return null;
  if (!isRecord(value)) fail("OBJECT_TRANSFER_TARGET_READBACK_INVALID");
  const entry = normalizeEntry({ key, size: value.size, metadata: value.metadata }, { prefix, source: false });
  if (typeof value.generation !== "string" || value.generation.length === 0
      || encoder.encode(value.generation).byteLength > MAX_VERSION_BYTES
      || /[\u0000-\u001f\u007f]/u.test(value.generation)) {
    fail("OBJECT_TRANSFER_TARGET_READBACK_INVALID");
  }
  return Object.freeze({ ...entry, generation: value.generation });
}

function exactMetadata(left, right) {
  return metadataDigest(left) === metadataDigest(right);
}

async function verifyTargetBytes(target, head, expected, metrics) {
  if (head.size !== expected.size || !exactMetadata(head.metadata, expected.metadata)) {
    fail("OBJECT_TRANSFER_TARGET_MISMATCH");
  }
  const result = await targetReadSummary(target, expected.key, head.generation);
  metrics.maxStreamChunkBytes = Math.max(metrics.maxStreamChunkBytes, result.maxChunkBytes);
  if (result.bytes !== expected.size || result.sha256 !== expected.contentSha256) {
    fail("OBJECT_TRANSFER_TARGET_MISMATCH");
  }
  return result;
}

function validCheckpoint(value, manifestSha256, entry) {
  if (!isRecord(value)
      || value.schemaVersion !== OBJECT_TRANSFER_REHEARSAL_SCHEMA
      || value.sourceManifestSha256 !== manifestSha256
      || value.key !== entry.key || value.sourceVersion !== entry.version
      || value.size !== entry.size || value.metadataSha256 !== metadataDigest(entry.metadata)
      || !SHA256.test(value.contentSha256)
      || typeof value.targetGeneration !== "string" || value.targetGeneration.length === 0
      || encoder.encode(value.targetGeneration).byteLength > MAX_VERSION_BYTES) {
    fail("OBJECT_TRANSFER_CHECKPOINT_MISMATCH");
  }
  return value;
}

async function saveCheckpoint(checkpoints, checkpoint) {
  try {
    await checkpoints.put(checkpoint);
  } catch {
    fail("OBJECT_TRANSFER_CHECKPOINT_UNAVAILABLE");
  }
}

async function loadCheckpoint(checkpoints, manifestSha256, entry) {
  let value;
  try {
    value = await checkpoints.get({ sourceManifestSha256: manifestSha256, key: entry.key });
  } catch {
    fail("OBJECT_TRANSFER_CHECKPOINT_UNAVAILABLE");
  }
  return value === null || value === undefined ? null : validCheckpoint(value, manifestSha256, entry);
}

async function verifyCheckpoint(target, checkpoints, manifestSha256, entry, metrics) {
  const checkpoint = await loadCheckpoint(checkpoints, manifestSha256, entry);
  if (!checkpoint) return null;
  let rawHead;
  try { rawHead = await target.head(entry.key); } catch (error) {
    if (error instanceof ObjectTransferRetryableError) throw error;
    fail("OBJECT_TRANSFER_TARGET_READBACK_UNAVAILABLE");
  }
  const head = normalizeHead(rawHead, entry.key, entry.key.slice(0, entry.key.lastIndexOf("/") + 1) || "");
  if (!head || head.generation !== checkpoint.targetGeneration) fail("OBJECT_TRANSFER_CHECKPOINT_TARGET_MISMATCH");
  // GCS generations identify immutable object data. The checkpoint was saved
  // only after hashing a read pinned to this exact generation, so re-reading
  // every byte on every resume adds O(total copied bytes × resume count)
  // without increasing the proof. `head` still checks the generation, size,
  // and metadata; a replacement has a different generation and fails closed.
  if (head.size !== entry.size || !exactMetadata(head.metadata, entry.metadata)) {
    fail("OBJECT_TRANSFER_TARGET_MISMATCH");
  }
  return checkpoint;
}

async function hashExistingAgainstSource(source, target, entry, prefix, metrics) {
  const sourceSummary = await sourceReadSummary(source, entry);
  if (sourceSummary.bytes !== entry.size) fail("OBJECT_TRANSFER_SOURCE_SIZE_MISMATCH");
  let rawHead;
  try { rawHead = await target.head(entry.key); } catch (error) {
    if (error instanceof ObjectTransferRetryableError) throw error;
    fail("OBJECT_TRANSFER_TARGET_READBACK_UNAVAILABLE");
  }
  const head = normalizeHead(rawHead, entry.key, prefix);
  if (!head) fail("OBJECT_TRANSFER_TARGET_MISSING");
  await verifyTargetBytes(target, head, {
    key: entry.key,
    size: entry.size,
    metadata: entry.metadata,
    contentSha256: sourceSummary.sha256,
  }, metrics);
  return { sourceSummary, head };
}

async function* sourceChunks(source, entry, state) {
  let opened;
  try { opened = await source.openRead({ key: entry.key, ifVersion: entry.version }); } catch (error) {
    if (error instanceof ObjectTransferRetryableError || error instanceof ObjectTransferRehearsalError) throw error;
    fail("OBJECT_TRANSFER_SOURCE_READ_FAILED");
  }
  if (!isRecord(opened) || opened.version !== entry.version || !(Symbol.asyncIterator in Object(opened.body))) {
    fail("OBJECT_TRANSFER_SOURCE_CHANGED");
  }
  try {
    for await (const chunk of opened.body) {
      if (!(chunk instanceof Uint8Array) || chunk.byteLength < 1
          || chunk.byteLength > OBJECT_TRANSFER_MAX_STREAM_CHUNK_BYTES) {
        fail("OBJECT_TRANSFER_STREAM_CHUNK_INVALID");
      }
      state.bytes += chunk.byteLength;
      if (!Number.isSafeInteger(state.bytes) || state.bytes > entry.size) fail("OBJECT_TRANSFER_SOURCE_SIZE_MISMATCH");
      state.digest.update(chunk);
      state.maxChunkBytes = Math.max(state.maxChunkBytes, chunk.byteLength);
      yield chunk;
    }
  } catch (error) {
    if (error instanceof ObjectTransferRehearsalError || error instanceof ObjectTransferRetryableError) throw error;
    fail("OBJECT_TRANSFER_SOURCE_READ_FAILED");
  }
  // Raise while the destination is still consuming its staging stream. A
  // create-only adapter must abort the atomic write when its body rejects;
  // checking after putIfAbsent returns would leave a short object committed.
  if (state.bytes !== entry.size) fail("OBJECT_TRANSFER_SOURCE_SIZE_MISMATCH");
  state.done = true;
}

async function transferEntry(source, target, checkpoints, entry, manifestSha256, options, metrics) {
  const saved = await verifyCheckpoint(target, checkpoints, manifestSha256, entry, metrics);
  if (saved) {
    metrics.resumed += 1;
    return;
  }
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      let rawHead;
      try { rawHead = await target.head(entry.key); } catch (error) {
        if (error instanceof ObjectTransferRetryableError) throw error;
        fail("OBJECT_TRANSFER_TARGET_READBACK_UNAVAILABLE");
      }
      const existing = normalizeHead(rawHead, entry.key, options.prefix);
      if (existing) {
        const matched = await hashExistingAgainstSource(source, target, entry, options.prefix, metrics);
        const checkpoint = Object.freeze({
          schemaVersion: OBJECT_TRANSFER_REHEARSAL_SCHEMA,
          sourceManifestSha256: manifestSha256,
          key: entry.key,
          sourceVersion: entry.version,
          size: entry.size,
          contentSha256: matched.sourceSummary.sha256,
          metadataSha256: metadataDigest(entry.metadata),
          targetGeneration: matched.head.generation,
        });
        await saveCheckpoint(checkpoints, checkpoint);
        metrics.adopted += 1;
        return;
      }

      const state = { bytes: 0, digest: sha256(), maxChunkBytes: 0, done: false };
      let generation;
      try {
        generation = await target.putIfAbsent({
          key: entry.key,
          metadata: entry.metadata,
          ifGenerationMatch: "0",
          body: sourceChunks(source, entry, state),
        });
      } catch (error) {
        if (error instanceof ObjectTransferTargetExistsError) {
          const matched = await hashExistingAgainstSource(source, target, entry, options.prefix, metrics);
          const checkpoint = Object.freeze({
            schemaVersion: OBJECT_TRANSFER_REHEARSAL_SCHEMA,
            sourceManifestSha256: manifestSha256,
            key: entry.key,
            sourceVersion: entry.version,
            size: entry.size,
            contentSha256: matched.sourceSummary.sha256,
            metadataSha256: metadataDigest(entry.metadata),
            targetGeneration: matched.head.generation,
          });
          await saveCheckpoint(checkpoints, checkpoint);
          metrics.adopted += 1;
          return;
        }
        throw error;
      }
      if (!state.done || state.bytes !== entry.size) fail("OBJECT_TRANSFER_SOURCE_SIZE_MISMATCH");
      if (typeof generation !== "string" || generation.length === 0
          || encoder.encode(generation).byteLength > MAX_VERSION_BYTES) {
        fail("OBJECT_TRANSFER_TARGET_GENERATION_INVALID");
      }
      metrics.maxStreamChunkBytes = Math.max(metrics.maxStreamChunkBytes, state.maxChunkBytes);
      metrics.transferredBytes += state.bytes;
      const sourceSha256 = state.digest.digest("hex");
      let committedHead;
      try { committedHead = await target.head(entry.key); } catch (error) {
        if (error instanceof ObjectTransferRetryableError) throw error;
        fail("OBJECT_TRANSFER_TARGET_READBACK_UNAVAILABLE");
      }
      const head = normalizeHead(committedHead, entry.key, options.prefix);
      if (!head || head.generation !== generation) fail("OBJECT_TRANSFER_TARGET_GENERATION_MISMATCH");
      await verifyTargetBytes(target, head, {
        key: entry.key,
        size: entry.size,
        metadata: entry.metadata,
        contentSha256: sourceSha256,
      }, metrics);
      await saveCheckpoint(checkpoints, Object.freeze({
        schemaVersion: OBJECT_TRANSFER_REHEARSAL_SCHEMA,
        sourceManifestSha256: manifestSha256,
        key: entry.key,
        sourceVersion: entry.version,
        size: entry.size,
        contentSha256: sourceSha256,
        metadataSha256: metadataDigest(entry.metadata),
        targetGeneration: generation,
      }));
      metrics.copied += 1;
      return;
    } catch (error) {
      if (error instanceof ObjectTransferRehearsalError) throw error;
      if (!(error instanceof ObjectTransferRetryableError)) fail("OBJECT_TRANSFER_OBJECT_FAILED");
      metrics.retries += 1;
      if (attempt === options.maxAttempts) fail("OBJECT_TRANSFER_RETRY_EXHAUSTED");
    }
  }
}

/**
 * Transfer a prefix through bounded pages, one streamed object at a time.
 * Checkpoints are saved only after generation-pinned reference read-back.
 * A caller-owned checkpoint store must implement atomic put semantics.
 */
export async function runPostgresObjectTransferRehearsal({ source, target, checkpoints, options: rawOptions }) {
  assertStoreInterfaces(source, target, checkpoints);
  const options = normalizeOptions(rawOptions);
  const sourceInventory = await scanInventory(source, options, { source: true });
  const metrics = {
    copied: 0,
    adopted: 0,
    resumed: 0,
    retries: 0,
    transferredBytes: 0,
    maxStreamChunkBytes: 0,
    maxConcurrentObjectStreams: 1,
  };
  let cursor = null;
  let previousKey = null;
  let visited = 0;
  let transferBytes = 0;
  const transferCursors = new Set();
  const transferHash = { portable: sha256(), pinned: sha256() };
  let runLimitReached = false;
  let deferredEntries = false;
  for (;;) {
    let page;
    try { page = await source.listPage({ prefix: options.prefix, cursor, limit: options.pageSize }); } catch {
      fail("OBJECT_TRANSFER_SOURCE_INVENTORY_UNAVAILABLE");
    }
    if (!isRecord(page) || !Array.isArray(page.objects) || page.objects.length > options.pageSize) {
      fail("OBJECT_TRANSFER_INVENTORY_INVALID");
    }
    const entries = page.objects.map(raw => normalizeEntry(raw, { prefix: options.prefix, source: true }));
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (previousKey !== null && compareKeys(previousKey, entry.key) >= 0) fail("OBJECT_TRANSFER_INVENTORY_ORDER_INVALID");
      previousKey = entry.key;
      visited += 1;
      transferBytes += entry.size;
      if (visited > sourceInventory.objects || visited > options.maxObjects
          || !Number.isSafeInteger(transferBytes) || transferBytes > sourceInventory.totalBytes
          || transferBytes > options.maxTotalBytes) {
        fail("OBJECT_TRANSFER_SOURCE_INVENTORY_CHANGED");
      }
      appendInventoryHash(transferHash, entry, { source: true });
      if (!runLimitReached) {
        await transferEntry(source, target, checkpoints, entry, sourceInventory.sourceManifestSha256, options, metrics);
        if (metrics.copied + metrics.adopted >= options.maxObjectsThisRun) runLimitReached = true;
      } else {
        deferredEntries = true;
      }
    }
    const next = page.nextCursor;
    if (next === null) break;
    if (typeof next !== "string" || next.length === 0 || entries.length === 0
        || transferCursors.has(next) || visited > sourceInventory.objects) {
      fail("OBJECT_TRANSFER_CURSOR_INVALID");
    }
    if (runLimitReached) deferredEntries = true;
    transferCursors.add(next);
    cursor = next;
  }
  const transferSourceManifest = transferHash.pinned.digest("hex");
  const transferPortableDigest = transferHash.portable.digest("hex");
  if (transferSourceManifest !== sourceInventory.sourceManifestSha256
      || transferPortableDigest !== sourceInventory.portableInventorySha256) {
    fail("OBJECT_TRANSFER_SOURCE_INVENTORY_CHANGED");
  }
  if (deferredEntries) {
    return Object.freeze({
      schemaVersion: OBJECT_TRANSFER_REHEARSAL_SCHEMA,
      status: "checkpointed",
      sourceObjects: sourceInventory.objects,
      sourceBytes: sourceInventory.totalBytes,
      sourceManifestSha256: sourceInventory.sourceManifestSha256,
      sourceInventorySha256: sourceInventory.portableInventorySha256,
      targetInventorySha256: null,
      metrics: Object.freeze(metrics),
    });
  }
  const targetInventory = await scanInventory(target, options, { source: false });
  if (targetInventory.objects !== sourceInventory.objects
      || targetInventory.totalBytes !== sourceInventory.totalBytes
      || targetInventory.portableInventorySha256 !== sourceInventory.portableInventorySha256) {
    fail("OBJECT_TRANSFER_INVENTORY_MISMATCH");
  }
  return Object.freeze({
    schemaVersion: OBJECT_TRANSFER_REHEARSAL_SCHEMA,
    status: "complete",
    sourceObjects: sourceInventory.objects,
    sourceBytes: sourceInventory.totalBytes,
    sourceManifestSha256: sourceInventory.sourceManifestSha256,
    sourceInventorySha256: sourceInventory.portableInventorySha256,
    targetInventorySha256: targetInventory.portableInventorySha256,
    metrics: Object.freeze(metrics),
  });
}

function syntheticPayloadBlock(key, offset, length) {
  const block = new Uint8Array(length);
  const pattern = sha256().update(`synthetic-content-free-fixture:${key}:${offset}`).digest();
  for (let index = 0; index < length; index += 1) block[index] = pattern[index % pattern.length];
  return block;
}

function syntheticVersion(entry) {
  return hashText(`${entry.key}\n${entry.size}\n${metadataCanonicalJson(entry.metadata)}`);
}

/** Build in-memory R2/GCS-like adapters for tests and the no-cloud CLI mode. */
export function createSyntheticR2GcsTransferFixture({
  objectCount = 7,
  bytesPerObject = 128 * 1024,
  streamChunkBytes = 64 * 1024,
  pageSize = 2,
  failBeforeCommitOnceFor = null,
  commitThenFailOnceFor = null,
} = {}) {
  if (!Number.isSafeInteger(objectCount) || objectCount < 0 || objectCount > 100
      || !Number.isSafeInteger(bytesPerObject) || bytesPerObject < 0 || bytesPerObject > 8 * 1024 * 1024
      || !Number.isSafeInteger(streamChunkBytes) || streamChunkBytes < 1
      || streamChunkBytes > OBJECT_TRANSFER_MAX_STREAM_CHUNK_BYTES
      || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > OBJECT_TRANSFER_MAX_PAGE_SIZE) {
    fail("OBJECT_TRANSFER_SYNTHETIC_FIXTURE_INVALID");
  }
  const prefix = "synthetic-quarantine/";
  const definitions = Array.from({ length: objectCount }, (_, index) => {
    const key = `${prefix}object-${String(index).padStart(4, "0")}.bin`;
    const metadata = canonicalMetadata({
      contentType: index % 2 === 0 ? "application/octet-stream" : "application/json",
      customMetadata: { fixture: "content-free", ordinal: String(index) },
    });
    const entry = { key, size: bytesPerObject + index, metadata };
    return Object.freeze({ ...entry, version: syntheticVersion(entry) });
  });
  const targetObjects = new Map();
  const attempts = new Map();
  const checkpointRows = new Map();
  const state = {
    failBeforeCommitOnceFor,
    commitThenFailOnceFor,
    maxObservedSourceChunkBytes: 0,
    maxObservedTargetChunkBytes: 0,
    activeWrites: 0,
    maxActiveWrites: 0,
    sourceReads: 0,
    targetReadbacks: 0,
    targetWrites: 0,
  };

  const page = (entries, cursor, limit) => {
    const offset = cursor === null ? 0 : Number.parseInt(cursor, 10);
    if (!Number.isSafeInteger(offset) || offset < 0 || String(offset) !== String(cursor ?? "0")) {
      fail("OBJECT_TRANSFER_SYNTHETIC_CURSOR_INVALID");
    }
    const objects = entries.slice(offset, offset + limit);
    const nextOffset = offset + objects.length;
    return { objects, nextCursor: nextOffset < entries.length ? String(nextOffset) : null };
  };
  const source = Object.freeze({
    async listPage({ prefix: requested, cursor, limit }) {
      return page(definitions.filter(item => item.key.startsWith(requested)), cursor, Math.min(limit, pageSize));
    },
    async openRead({ key, ifVersion }) {
      const entry = definitions.find(item => item.key === key);
      if (!entry || entry.version !== ifVersion) fail("OBJECT_TRANSFER_SOURCE_CHANGED");
      state.sourceReads += 1;
      const body = (async function* () {
        for (let offset = 0; offset < entry.size; offset += streamChunkBytes) {
          const chunk = syntheticPayloadBlock(key, offset, Math.min(streamChunkBytes, entry.size - offset));
          state.maxObservedSourceChunkBytes = Math.max(state.maxObservedSourceChunkBytes, chunk.byteLength);
          yield chunk;
        }
      }());
      return { version: entry.version, body };
    },
  });
  const target = Object.freeze({
    async listPage({ prefix: requested, cursor, limit }) {
      const entries = [...targetObjects.entries()]
        .filter(([key]) => key.startsWith(requested))
        .sort(([left], [right]) => compareKeys(left, right))
        .map(([key, value]) => ({ key, size: value.size, metadata: value.metadata, generation: value.generation }));
      return page(entries, cursor, Math.min(limit, pageSize));
    },
    async head(key) {
      const value = targetObjects.get(key);
      return value ? { size: value.size, metadata: value.metadata, generation: value.generation } : null;
    },
    async openRead({ key, ifGeneration }) {
      const value = targetObjects.get(key);
      if (!value || value.generation !== ifGeneration) fail("OBJECT_TRANSFER_TARGET_CHANGED");
      state.targetReadbacks += 1;
      return { generation: value.generation, body: (async function* () {
        for (const chunk of value.chunks) yield chunk.slice();
      }()) };
    },
    async putIfAbsent({ key, metadata, ifGenerationMatch, body }) {
      if (ifGenerationMatch !== "0") fail("OBJECT_TRANSFER_CREATE_ONLY_REQUIRED");
      if (targetObjects.has(key)) throw new ObjectTransferTargetExistsError();
      state.targetWrites += 1;
      state.activeWrites += 1;
      state.maxActiveWrites = Math.max(state.maxActiveWrites, state.activeWrites);
      const chunks = [];
      let size = 0;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      try {
        for await (const chunk of body) {
          state.maxObservedTargetChunkBytes = Math.max(state.maxObservedTargetChunkBytes, chunk.byteLength);
          chunks.push(chunk.slice());
          size += chunk.byteLength;
          if (key === state.failBeforeCommitOnceFor && attempt === 1) {
            throw new ObjectTransferRetryableError();
          }
        }
      } finally {
        state.activeWrites -= 1;
      }
      const generation = String(targetObjects.size + 1);
      targetObjects.set(key, { size, metadata: canonicalMetadata(metadata), generation, chunks });
      if (key === state.commitThenFailOnceFor && attempt === 1) throw new ObjectTransferRetryableError();
      return generation;
    },
  });
  const checkpoints = Object.freeze({
    async get({ sourceManifestSha256, key }) {
      return checkpointRows.get(`${sourceManifestSha256}\n${key}`) ?? null;
    },
    async put(checkpoint) {
      checkpointRows.set(`${checkpoint.sourceManifestSha256}\n${checkpoint.key}`, Object.freeze({ ...checkpoint }));
    },
  });
  return Object.freeze({
    source,
    target,
    checkpoints,
    state,
    prefix,
    objects: Object.freeze(definitions.map(({ key, size, metadata, version }) => ({ key, size, metadata, version }))),
    checkpointCount: () => checkpointRows.size,
    targetObjectCount: () => targetObjects.size,
    targetObjects,
  });
}

/** A content-free CLI smoke that always uses in-memory adapters only. */
export async function runSyntheticPostgresObjectTransferRehearsal() {
  const fixture = createSyntheticR2GcsTransferFixture({
    objectCount: 7,
    bytesPerObject: 128 * 1024,
    pageSize: 2,
    streamChunkBytes: 32 * 1024,
    failBeforeCommitOnceFor: "synthetic-quarantine/object-0002.bin",
    commitThenFailOnceFor: "synthetic-quarantine/object-0004.bin",
  });
  const options = {
    prefix: fixture.prefix,
    pageSize: 2,
    maxObjects: 100,
    maxTotalBytes: 16 * 1024 * 1024,
    maxAttempts: 3,
    maxObjectsThisRun: 3,
  };
  let result = await runPostgresObjectTransferRehearsal({ ...fixture, options });
  const runs = [result];
  while (result.status !== "complete") {
    result = await runPostgresObjectTransferRehearsal({ ...fixture, options });
    runs.push(result);
  }
  return Object.freeze({
    schemaVersion: OBJECT_TRANSFER_REHEARSAL_SCHEMA,
    synthetic: true,
    externalCalls: 0,
    cloudWrites: 0,
    runs: Object.freeze(runs),
    final: result,
    checkpointCount: fixture.checkpointCount(),
    targetObjectCount: fixture.targetObjectCount(),
    maxObservedSourceChunkBytes: fixture.state.maxObservedSourceChunkBytes,
    maxObservedTargetChunkBytes: fixture.state.maxObservedTargetChunkBytes,
    maxConcurrentWrites: fixture.state.maxActiveWrites,
    targetReadbacks: fixture.state.targetReadbacks,
  });
}

async function main() {
  try {
    const receipt = await runSyntheticPostgresObjectTransferRehearsal();
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch {
    process.stderr.write("POSTGRES_OBJECT_TRANSFER_REHEARSAL_FAILED\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
