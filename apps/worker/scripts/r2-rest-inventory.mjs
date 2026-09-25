import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

// This API exposes metadata, not the R2 object version needed by the
// version-pinned copy adapter. Its receipt is an inventory observation only.
export const R2_REST_INVENTORY_SCHEMA = "r2-rest-inventory-v1";
const API_ORIGIN = "https://api.cloudflare.com";
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const MAX_OBJECTS = 100_000;
const MAX_TOTAL_BYTES = 1_099_511_627_776;
const MAX_PAGES = 1_000;
const MAX_CURSOR_BYTES = 4_096;
const MAX_KEY_BYTES = 1_024;
const REQUEST_TIMEOUT_MS = 30_000;
const encoder = new TextEncoder();

export class R2RestInventoryError extends Error {
  constructor(code) {
    super(code);
    this.name = "R2RestInventoryError";
    this.code = code;
  }
}

function fail(code) {
  throw new R2RestInventoryError(code);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fixedText(value, maximum, code) {
  if (typeof value !== "string" || value.length === 0
      || encoder.encode(value).byteLength > maximum
      || /[\u0000-\u001f\u007f]/u.test(value)) fail(code);
  return value;
}

function options(input) {
  if (!record(input)) fail("R2_INVENTORY_OPTIONS_INVALID");
  const accountId = fixedText(input.accountId, 32, "R2_INVENTORY_ACCOUNT_INVALID");
  if (!/^[0-9a-f]{32}$/u.test(accountId)) fail("R2_INVENTORY_ACCOUNT_INVALID");
  const bucketName = fixedText(input.bucketName, 64, "R2_INVENTORY_BUCKET_INVALID");
  if (bucketName.length < 3 || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(bucketName)) {
    fail("R2_INVENTORY_BUCKET_INVALID");
  }
  const token = fixedText(input.token, 4_096, "R2_INVENTORY_TOKEN_INVALID");
  const pageSize = input.pageSize ?? 500;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    fail("R2_INVENTORY_PAGE_SIZE_INVALID");
  }
  if (typeof input.fetchImpl !== "function") fail("R2_INVENTORY_FETCH_INVALID");
  return { accountId, bucketName, token, pageSize, fetchImpl: input.fetchImpl };
}

async function boundedJson(response) {
  if (!response.body) fail("R2_INVENTORY_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let completed = false;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) {
        completed = true;
        break;
      }
      if (!(item.value instanceof Uint8Array)) fail("R2_INVENTORY_RESPONSE_INVALID");
      total += item.value.byteLength;
      if (total > MAX_PAGE_BYTES) fail("R2_INVENTORY_PAGE_LIMIT");
      chunks.push(item.value);
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* Already released. */ }
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)));
  } catch {
    fail("R2_INVENTORY_RESPONSE_INVALID");
  }
}

function inventoryObject(value) {
  if (!record(value)) fail("R2_INVENTORY_OBJECT_INVALID");
  const key = fixedText(value.key, MAX_KEY_BYTES, "R2_INVENTORY_OBJECT_INVALID");
  if (!Number.isSafeInteger(value.size) || value.size < 0) {
    fail("R2_INVENTORY_OBJECT_INVALID");
  }
  const etag = value.etag === undefined ? null
    : fixedText(value.etag, 512, "R2_INVENTORY_OBJECT_INVALID");
  const storageClass = value.storage_class === undefined ? null
    : fixedText(value.storage_class, 64, "R2_INVENTORY_OBJECT_INVALID");
  const metadata = value.http_metadata;
  if (metadata !== undefined && !record(metadata)) fail("R2_INVENTORY_OBJECT_INVALID");
  const contentType = metadata?.contentType === undefined ? null
    : fixedText(metadata.contentType, 1_024, "R2_INVENTORY_OBJECT_INVALID");
  const unsupportedHttpMetadata = Object.entries(metadata ?? {}).some(
    ([name, item]) => name !== "contentType" && item !== null && item !== undefined,
  );
  const custom = value.custom_metadata ?? {};
  if (!record(custom)) fail("R2_INVENTORY_OBJECT_INVALID");
  const customEntries = Object.keys(custom).sort().map(name => [
    fixedText(name, 1_024, "R2_INVENTORY_OBJECT_INVALID"),
    fixedText(custom[name], 1_024, "R2_INVENTORY_OBJECT_INVALID"),
  ]);
  if (encoder.encode(JSON.stringify(customEntries)).byteLength > 8 * 1_024) {
    fail("R2_INVENTORY_OBJECT_INVALID");
  }
  return { key, size: value.size, etag, storageClass, contentType,
    customEntries, unsupportedHttpMetadata };
}

function keyClass(key) {
  if (key.startsWith("telemetry/")) return "telemetry";
  if (key.startsWith("synthetic/")) return "synthetic";
  return "other";
}

/**
 * Read-only, bounded metadata sweep of one R2 bucket. The result contains no
 * keys, custom metadata or token. A moving bucket can change between pages;
 * even matching repeated sweeps are not an atomic source snapshot.
 */
export async function scanR2RestInventory(input) {
  const { accountId, bucketName, token, pageSize, fetchImpl } = options(input);
  const digest = createHash("sha256");
  const classes = {
    telemetry: { objects: 0, bytes: 0 },
    synthetic: { objects: 0, bytes: 0 },
    other: { objects: 0, bytes: 0 },
  };
  const seenKeys = new Set();
  const seenCursors = new Set();
  let cursor = null;
  let objects = 0;
  let bytes = 0;
  let pages = 0;
  let missingEtag = 0;
  let unsupportedStorageClass = 0;
  let unsupportedHttpMetadata = 0;
  for (;;) {
    if (++pages > MAX_PAGES) fail("R2_INVENTORY_PAGE_LIMIT");
    const url = new URL(`/client/v4/accounts/${accountId}/r2/buckets/${bucketName}/objects`, API_ORIGIN);
    url.searchParams.set("per_page", String(pageSize));
    if (cursor !== null) url.searchParams.set("cursor", cursor);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    let page;
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, "cache-control": "no-store" },
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response?.ok) {
        await response?.body?.cancel().catch(() => undefined);
        fail("R2_INVENTORY_REQUEST_FAILED");
      }
      page = await boundedJson(response);
    } catch (error) {
      if (error instanceof R2RestInventoryError) throw error;
      fail("R2_INVENTORY_REQUEST_FAILED");
    } finally {
      clearTimeout(timer);
    }
    if (!record(page) || page.success !== true || !Array.isArray(page.result)
        || page.result.length > pageSize || !record(page.result_info)
        || typeof page.result_info.is_truncated !== "boolean") {
      fail("R2_INVENTORY_RESPONSE_INVALID");
    }
    for (const raw of page.result) {
      const object = inventoryObject(raw);
      if (seenKeys.has(object.key)) fail("R2_INVENTORY_DUPLICATE_KEY");
      seenKeys.add(object.key);
      objects += 1;
      bytes += object.size;
      if (objects > MAX_OBJECTS || !Number.isSafeInteger(bytes) || bytes > MAX_TOTAL_BYTES) {
        fail("R2_INVENTORY_OBJECT_LIMIT");
      }
      if (object.etag === null) missingEtag += 1;
      if (object.storageClass !== null && object.storageClass !== "Standard") {
        unsupportedStorageClass += 1;
      }
      if (object.unsupportedHttpMetadata) unsupportedHttpMetadata += 1;
      const group = classes[keyClass(object.key)];
      group.objects += 1;
      group.bytes += object.size;
      digest.update(`${JSON.stringify([
        object.key, object.size, object.etag, object.storageClass, object.contentType,
        object.customEntries, object.unsupportedHttpMetadata,
      ])}\n`);
    }
    if (!page.result_info.is_truncated) break;
    const next = fixedText(page.result_info.cursor, MAX_CURSOR_BYTES, "R2_INVENTORY_CURSOR_INVALID");
    if (page.result.length === 0 || seenCursors.has(next)) fail("R2_INVENTORY_CURSOR_INVALID");
    seenCursors.add(next);
    cursor = next;
  }
  return Object.freeze({
    schema: R2_REST_INVENTORY_SCHEMA,
    objects,
    bytes,
    pages,
    classes,
    missingEtag,
    unsupportedStorageClass,
    unsupportedHttpMetadata,
    inventorySha256: digest.digest("hex"),
    sourceVersionQualified: false,
    snapshotQualified: false,
  });
}

async function main() {
  try {
    const result = await scanR2RestInventory({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      bucketName: process.env.CLOUDFLARE_R2_INVENTORY_BUCKET,
      token: process.env.CLOUDFLARE_API_TOKEN,
      fetchImpl: globalThis.fetch,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    // Provider errors can carry tokens, keys or metadata. Emit only our code.
    process.stderr.write(`${error instanceof R2RestInventoryError ? error.code : "R2_INVENTORY_FAILED"}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
