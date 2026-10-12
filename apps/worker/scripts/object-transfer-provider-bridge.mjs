import {
  ObjectTransferRetryableError,
  ObjectTransferTargetExistsError,
} from "./postgres-object-transfer-rehearsal.mjs";

/**
 * Injectable R2 Workers-binding -> GCS JSON API adapters for the transfer
 * rehearsal contract. This module performs no credential discovery and has no
 * command-line entrypoint: callers supply the bucket binding, access-token
 * provider, and fetch implementation.
 */
export const OBJECT_TRANSFER_PROVIDER_PAGE_MAX = 500;
export const OBJECT_TRANSFER_PROVIDER_STREAM_CHUNK_MAX = 256 * 1024;
/** Google recommends at least 8 MiB for resumable upload chunks. */
export const OBJECT_TRANSFER_PROVIDER_UPLOAD_BLOCK_MAX = 8 * 1024 * 1024;
const GCS_ORIGIN = "https://storage.googleapis.com";
const MAX_BUCKET_BYTES = 222;
const MAX_KEY_BYTES = 1_024;
const MAX_TOKEN_BYTES = 4_096;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_CUSTOM_METADATA_BYTES = 8 * 1024;
const MAX_GENERATION = 9_223_372_036_854_775_807n;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_UPLOAD_CHUNK_REQUESTS = 8;
const encoder = new TextEncoder();

export class ObjectTransferProviderError extends Error {
  constructor(code) {
    super(code);
    this.name = "ObjectTransferProviderError";
    this.code = code;
  }
}

function fail(code) {
  throw new ObjectTransferProviderError(code);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value, maxBytes, code) {
  if (typeof value !== "string" || value.length === 0
      || encoder.encode(value).byteLength > maxBytes
      || /[\u0000-\u001f\u007f]/u.test(value)) fail(code);
  return value;
}

function bucketName(value) {
  safeText(value, MAX_BUCKET_BYTES, "OBJECT_TRANSFER_BUCKET_INVALID");
  if (value.length < 3 || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(value)) {
    fail("OBJECT_TRANSFER_BUCKET_INVALID");
  }
  return value;
}

function objectKey(value) {
  return safeText(value, MAX_KEY_BYTES, "OBJECT_TRANSFER_KEY_INVALID");
}

function objectSize(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("OBJECT_TRANSFER_SIZE_INVALID");
  return value;
}

function generation(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/u.test(value)) {
    fail("OBJECT_TRANSFER_GENERATION_INVALID");
  }
  let parsed;
  try { parsed = BigInt(value); } catch { fail("OBJECT_TRANSFER_GENERATION_INVALID"); }
  if (parsed < 1n || parsed > MAX_GENERATION) fail("OBJECT_TRANSFER_GENERATION_INVALID");
  return value;
}

function safeMetadata(value) {
  if (value === undefined || value === null) value = {};
  if (!isRecord(value)) fail("OBJECT_TRANSFER_METADATA_INVALID");
  const contentType = value.contentType ?? "application/octet-stream";
  safeText(contentType, 1_024, "OBJECT_TRANSFER_METADATA_INVALID");
  const custom = value.customMetadata ?? {};
  if (!isRecord(custom)) fail("OBJECT_TRANSFER_METADATA_INVALID");
  const customMetadata = Object.create(null);
  let customMetadataByteLength = 0;
  for (const key of Object.keys(custom).sort()) {
    const item = custom[key];
    safeText(key, 1_024, "OBJECT_TRANSFER_METADATA_INVALID");
    safeText(item, 1_024, "OBJECT_TRANSFER_METADATA_INVALID");
    customMetadata[key] = item;
    customMetadataByteLength += encoder.encode(key).byteLength + encoder.encode(item).byteLength;
  }
  if (customMetadataByteLength > MAX_CUSTOM_METADATA_BYTES) fail("OBJECT_TRANSFER_METADATA_LIMIT");
  return Object.freeze({ contentType, customMetadata: Object.freeze(customMetadata) });
}

function r2VersionToken(version, etag) {
  safeText(version, 512, "OBJECT_TRANSFER_SOURCE_VERSION_INVALID");
  safeText(etag, 512, "OBJECT_TRANSFER_SOURCE_VERSION_INVALID");
  const token = `r2v1.${Buffer.from(JSON.stringify([version, etag]), "utf8").toString("base64url")}`;
  return safeText(token, MAX_TOKEN_BYTES, "OBJECT_TRANSFER_SOURCE_VERSION_INVALID");
}

function parseR2VersionToken(value) {
  safeText(value, MAX_TOKEN_BYTES, "OBJECT_TRANSFER_SOURCE_VERSION_INVALID");
  if (!value.startsWith("r2v1.")) fail("OBJECT_TRANSFER_SOURCE_VERSION_INVALID");
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(5), "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) fail("OBJECT_TRANSFER_SOURCE_VERSION_INVALID");
    return {
      version: safeText(parsed[0], 512, "OBJECT_TRANSFER_SOURCE_VERSION_INVALID"),
      etag: safeText(parsed[1], 512, "OBJECT_TRANSFER_SOURCE_VERSION_INVALID"),
    };
  } catch {
    fail("OBJECT_TRANSFER_SOURCE_VERSION_INVALID");
  }
}

function r2TransferMetadata(value) {
  const http = value.httpMetadata ?? {};
  if (!isRecord(http)) fail("OBJECT_TRANSFER_METADATA_INVALID");
  if (Object.keys(http).some(name => name !== "contentType" && http[name] !== undefined && http[name] !== null)) {
    // The rehearsal contract currently carries only contentType and custom
    // metadata. Refuse other R2 HTTP metadata instead of silently dropping it.
    fail("OBJECT_TRANSFER_METADATA_UNSUPPORTED");
  }
  if (value.storageClass !== undefined && value.storageClass !== "Standard") {
    fail("OBJECT_TRANSFER_STORAGE_CLASS_UNSUPPORTED");
  }
  if (value.ssecKeyMd5 !== undefined) fail("OBJECT_TRANSFER_SOURCE_ENCRYPTION_UNSUPPORTED");
  return safeMetadata({ contentType: http.contentType, customMetadata: value.customMetadata });
}

function mapR2Object(value, prefix) {
  if (!isRecord(value)) fail("OBJECT_TRANSFER_INVENTORY_INVALID");
  const key = objectKey(value.key);
  if (!key.startsWith(prefix)) fail("OBJECT_TRANSFER_KEY_INVALID");
  const size = objectSize(value.size);
  const metadata = r2TransferMetadata(value);
  return Object.freeze({
    key,
    size,
    metadata,
    version: r2VersionToken(value.version, value.etag),
  });
}

async function* streamAsAsyncIterable(body) {
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    for await (const value of body) {
      if (!(value instanceof Uint8Array) || value.byteLength === 0) {
        fail("OBJECT_TRANSFER_STREAM_CHUNK_INVALID");
      }
      for (let offset = 0; offset < value.byteLength; offset += OBJECT_TRANSFER_PROVIDER_STREAM_CHUNK_MAX) {
        yield value.subarray(offset, Math.min(value.byteLength, offset + OBJECT_TRANSFER_PROVIDER_STREAM_CHUNK_MAX));
      }
    }
    return;
  }
  if (!body || typeof body.getReader !== "function") fail("OBJECT_TRANSFER_STREAM_INVALID");
  const reader = body.getReader();
  let finished = false;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        finished = true;
        return;
      }
      const value = result.value;
      if (!(value instanceof Uint8Array) || value.byteLength === 0) {
        fail("OBJECT_TRANSFER_STREAM_CHUNK_INVALID");
      }
      for (let offset = 0; offset < value.byteLength; offset += OBJECT_TRANSFER_PROVIDER_STREAM_CHUNK_MAX) {
        yield value.subarray(offset, Math.min(value.byteLength, offset + OBJECT_TRANSFER_PROVIDER_STREAM_CHUNK_MAX));
      }
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* The source already released it. */ }
  }
}

/** Adapt the Cloudflare R2 Workers binding to the rehearsal's source contract. */
export function createR2BindingObjectTransferSource(bucket) {
  if (!bucket || typeof bucket.list !== "function" || typeof bucket.get !== "function") {
    fail("OBJECT_TRANSFER_R2_ADAPTER_INVALID");
  }
  return Object.freeze({
    async listPage({ prefix, cursor, limit }) {
      safeText(prefix, MAX_KEY_BYTES, "OBJECT_TRANSFER_PREFIX_INVALID");
      if (!prefix.endsWith("/")) fail("OBJECT_TRANSFER_PREFIX_INVALID");
      if (cursor !== null) safeText(cursor, MAX_TOKEN_BYTES, "OBJECT_TRANSFER_CURSOR_INVALID");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > OBJECT_TRANSFER_PROVIDER_PAGE_MAX) {
        fail("OBJECT_TRANSFER_PAGE_LIMIT_INVALID");
      }
      let page;
      try {
        page = await bucket.list({
          prefix,
          ...(cursor === null ? {} : { cursor }),
          limit,
          include: ["httpMetadata", "customMetadata"],
        });
      } catch {
        throw new ObjectTransferRetryableError();
      }
      if (!isRecord(page) || !Array.isArray(page.objects) || page.objects.length > limit
          || typeof page.truncated !== "boolean") fail("OBJECT_TRANSFER_INVENTORY_INVALID");
      const nextCursor = page.truncated
        ? safeText(page.cursor, MAX_TOKEN_BYTES, "OBJECT_TRANSFER_CURSOR_INVALID")
        : null;
      return { objects: page.objects.map(value => mapR2Object(value, prefix)), nextCursor };
    },
    async openRead({ key, ifVersion }) {
      objectKey(key);
      const pinned = parseR2VersionToken(ifVersion);
      let object;
      try {
        object = await bucket.get(key, { onlyIf: { etagMatches: pinned.etag } });
      } catch {
        throw new ObjectTransferRetryableError();
      }
      if (!object || object.key !== key || object.version !== pinned.version || object.etag !== pinned.etag
          || !object.body) fail("OBJECT_TRANSFER_SOURCE_CHANGED");
      return {
        version: r2VersionToken(object.version, object.etag),
        body: streamAsAsyncIterable(object.body),
      };
    },
  });
}

function fixedGcsUrl(path, query) {
  const url = new URL(path, GCS_ORIGIN);
  if (url.origin !== GCS_ORIGIN) fail("OBJECT_TRANSFER_GCS_URL_INVALID");
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
  }
  return url;
}

/** Resettable deadline used as a request limit and as an idle limit for streams. */
function requestContext(timeoutMilliseconds) {
  const controller = new AbortController();
  const context = {
    controller,
    timer: null,
    touch() {
      if (context.timer !== null) clearTimeout(context.timer);
      context.timer = setTimeout(() => controller.abort(), timeoutMilliseconds);
    },
  };
  context.touch();
  return context;
}

function closeContext(context, abort = false) {
  if (abort) context.controller.abort();
  if (context.timer !== null) clearTimeout(context.timer);
  context.timer = null;
}

async function readBoundedJson(response, context) {
  if (context?.controller.signal.aborted) throw new ObjectTransferRetryableError();
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (context?.controller.signal.aborted) throw new ObjectTransferRetryableError();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail("OBJECT_TRANSFER_GCS_RESPONSE_INVALID");
      if (value.byteLength > 0) context?.touch();
      total += value.byteLength;
      if (!Number.isSafeInteger(total) || total > MAX_JSON_BYTES) {
        await reader.cancel().catch(() => undefined);
        fail("OBJECT_TRANSFER_PROVIDER_RESPONSE_LIMIT");
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* Ignore an already released reader. */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch {
    fail("OBJECT_TRANSFER_PROVIDER_RESPONSE_INVALID");
  }
}

function statusError(status) {
  if (status === 412) throw new ObjectTransferTargetExistsError();
  if (status === 408 || status === 429 || status >= 500) throw new ObjectTransferRetryableError();
  fail("OBJECT_TRANSFER_GCS_REQUEST_REJECTED");
}

function responseDiscard(response, context) {
  closeContext(context, true);
  void response.body?.cancel().catch(() => undefined);
}

async function* responseStream(response, context) {
  if (!response.body) {
    closeContext(context);
    return;
  }
  const reader = response.body.getReader();
  let finished = false;
  try {
    for (;;) {
      let result;
      try { result = await reader.read(); } catch {
        throw new ObjectTransferRetryableError();
      }
      if (context.controller.signal.aborted) throw new ObjectTransferRetryableError();
      if (result.done) {
        finished = true;
        closeContext(context);
        return;
      }
      const value = result.value;
      if (!(value instanceof Uint8Array)) fail("OBJECT_TRANSFER_GCS_RESPONSE_INVALID");
      if (value.byteLength > 0) context.touch();
      for (let offset = 0; offset < value.byteLength; offset += OBJECT_TRANSFER_PROVIDER_STREAM_CHUNK_MAX) {
        yield value.subarray(offset, Math.min(value.byteLength, offset + OBJECT_TRANSFER_PROVIDER_STREAM_CHUNK_MAX));
      }
    }
  } finally {
    if (!finished) {
      closeContext(context, true);
      await reader.cancel().catch(() => undefined);
    }
    try { reader.releaseLock(); } catch { /* Ignore an already released reader. */ }
  }
}

function objectFromGcs(value, expectedKey) {
  if (!isRecord(value) || value.name !== expectedKey) fail("OBJECT_TRANSFER_GCS_OBJECT_INVALID");
  const size = typeof value.size === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value.size)
    ? Number(value.size)
    : NaN;
  if (!Number.isSafeInteger(size) || size < 0) fail("OBJECT_TRANSFER_GCS_OBJECT_INVALID");
  const metadata = safeMetadata({ contentType: value.contentType, customMetadata: value.metadata });
  return Object.freeze({ key: expectedKey, size, metadata, generation: generation(value.generation) });
}

function objectPath(bucket, key) {
  return `/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`;
}

function persistedOffset(range, chunk) {
  let nextOffset = 0;
  if (range !== null) {
    const match = /^bytes=0-(0|[1-9][0-9]*)$/u.exec(range);
    if (!match) throw new ObjectTransferRetryableError();
    const lastByte = Number(match[1]);
    if (!Number.isSafeInteger(lastByte) || lastByte < 0) throw new ObjectTransferRetryableError();
    nextOffset = lastByte + 1;
  }
  // Earlier acknowledged chunks cannot disappear, and a server cannot have
  // persisted bytes beyond the chunk whose response is being reconciled.
  if (nextOffset < chunk.start || nextOffset > chunk.end + 1) {
    throw new ObjectTransferRetryableError();
  }
  return nextOffset;
}

function finalizedGeneration(value, key, expectedSize) {
  const result = objectFromGcs(value, key);
  if (result.size !== expectedSize) fail("OBJECT_TRANSFER_GCS_OBJECT_INVALID");
  return result.generation;
}

async function* gcsUploadChunks(body) {
  if (!body || typeof body[Symbol.asyncIterator] !== "function") fail("OBJECT_TRANSFER_STREAM_INVALID");
  const iterator = body[Symbol.asyncIterator]();
  let pending = null;
  let pendingOffset = 0;
  let ended = false;
  let start = 0;
  try {
    for (;;) {
      const block = new Uint8Array(OBJECT_TRANSFER_PROVIDER_UPLOAD_BLOCK_MAX);
      let length = 0;
      while (length < block.byteLength && !ended) {
        if (pending === null || pendingOffset >= pending.byteLength) {
          let next;
          try { next = await iterator.next(); } catch (error) { throw error; }
          if (next.done) {
            ended = true;
            break;
          }
          if (!(next.value instanceof Uint8Array) || next.value.byteLength < 1
              || next.value.byteLength > OBJECT_TRANSFER_PROVIDER_STREAM_CHUNK_MAX) {
            fail("OBJECT_TRANSFER_STREAM_CHUNK_INVALID");
          }
          pending = next.value;
          pendingOffset = 0;
        }
        const copied = Math.min(block.byteLength - length, pending.byteLength - pendingOffset);
        block.set(pending.subarray(pendingOffset, pendingOffset + copied), length);
        length += copied;
        pendingOffset += copied;
      }

      if (length === 0 && ended) {
        if (start === 0) yield Object.freeze({ bytes: new Uint8Array(0), start: 0, end: -1, total: 0 });
        return;
      }

      if (length < block.byteLength) {
        yield Object.freeze({ bytes: block.slice(0, length), start, end: start + length - 1, total: start + length });
        return;
      }

      // Keep one bounded source chunk in hand to decide whether this full
      // block is final. GCS requires a known total on the final resumable PUT.
      if (pending === null || pendingOffset >= pending.byteLength) {
        let next;
        try { next = await iterator.next(); } catch (error) { throw error; }
        if (next.done) {
          yield Object.freeze({ bytes: block, start, end: start + length - 1, total: start + length });
          return;
        }
        if (!(next.value instanceof Uint8Array) || next.value.byteLength < 1
            || next.value.byteLength > OBJECT_TRANSFER_PROVIDER_STREAM_CHUNK_MAX) {
          fail("OBJECT_TRANSFER_STREAM_CHUNK_INVALID");
        }
        pending = next.value;
        pendingOffset = 0;
      }
      yield Object.freeze({ bytes: block, start, end: start + length - 1, total: null });
      start += length;
    }
  } finally {
    if (typeof iterator.return === "function") {
      try { await iterator.return(); } catch { /* Preserve the original stream result. */ }
    }
  }
}

/** Adapt GCS JSON API object calls to the rehearsal target contract. */
export function createGcsJsonApiObjectTransferTarget({
  bucket: rawBucket,
  accessToken,
  fetchImpl = (input, init) => fetch(input, init),
  timeoutMilliseconds = DEFAULT_TIMEOUT_MS,
} = {}) {
  const bucket = bucketName(rawBucket);
  if (typeof accessToken !== "function" || typeof fetchImpl !== "function"
      || !Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1
      || timeoutMilliseconds > MAX_TIMEOUT_MS) fail("OBJECT_TRANSFER_GCS_ADAPTER_INVALID");

  async function authorizedFetch(url, init = {}) {
    let token;
    try { token = await accessToken(); } catch { throw new ObjectTransferRetryableError(); }
    safeText(token, MAX_TOKEN_BYTES, "OBJECT_TRANSFER_GCS_AUTH_INVALID");
    const context = requestContext(timeoutMilliseconds);
    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
        redirect: "error",
        signal: context.controller.signal,
      });
    } catch {
      closeContext(context, true);
      throw new ObjectTransferRetryableError();
    }
    if (context.controller.signal.aborted) {
      responseDiscard(response, context);
      throw new ObjectTransferRetryableError();
    }
    return { response, context };
  }

  async function jsonRequest(url, init = {}, { allowNotFound = false } = {}) {
    const { response, context } = await authorizedFetch(url, init);
    if (allowNotFound && response.status === 404) {
      responseDiscard(response, context);
      return null;
    }
    if (!response.ok) {
      const status = response.status;
      responseDiscard(response, context);
      statusError(status);
    }
    try { return await readBoundedJson(response, context); } catch (error) {
      if (error instanceof ObjectTransferProviderError) throw error;
      throw new ObjectTransferRetryableError();
    } finally {
      closeContext(context);
    }
  }

  async function cancelSession(sessionUrl) {
    const context = requestContext(timeoutMilliseconds);
    try {
      const response = await fetchImpl(sessionUrl, {
        method: "DELETE",
        headers: { "content-length": "0" },
        redirect: "error",
        signal: context.controller.signal,
      });
      responseDiscard(response, context);
    } catch {
      // The session URI is a short-lived bearer capability. Do not expose it
      // in diagnostics; GCS expires incomplete sessions if cancellation fails.
    } finally {
      closeContext(context, true);
    }
  }

  async function sessionRequest(sessionUrl, init) {
    const context = requestContext(timeoutMilliseconds);
    let response;
    try {
      response = await fetchImpl(sessionUrl, {
        ...init,
        // GCS uses HTTP 308 as its resumable-upload acknowledgement. Fetch
        // treats 308 as a redirect unless redirect handling is manual.
        redirect: "manual",
        signal: context.controller.signal,
      });
    } catch {
      closeContext(context, true);
      return null;
    }
    if (context.controller.signal.aborted) {
      responseDiscard(response, context);
      return null;
    }
    return { response, context };
  }

  async function queryUploadStatus(sessionUrl, chunk, key) {
    const request = await sessionRequest(sessionUrl, {
      method: "PUT",
      headers: {
        "content-length": "0",
        "content-range": `bytes */${chunk.total === null ? "*" : chunk.total}`,
      },
      body: new Uint8Array(0),
    });
    if (request === null) throw new ObjectTransferRetryableError();
    const { response, context } = request;
    if (response.status === 200 || response.status === 201) {
      if (chunk.total === null) {
        responseDiscard(response, context);
        fail("OBJECT_TRANSFER_GCS_RESPONSE_INVALID");
      }
      try {
        return {
          generation: finalizedGeneration(await readBoundedJson(response, context), key, chunk.total),
          nextOffset: null,
        };
      } finally {
        closeContext(context);
      }
    }
    if (response.status === 308) {
      const range = response.headers.get("range");
      responseDiscard(response, context);
      return { generation: null, nextOffset: persistedOffset(range, chunk) };
    }
    const status = response.status;
    responseDiscard(response, context);
    if (status === 404 || status === 410 || status === 408 || status === 429 || status >= 500) {
      throw new ObjectTransferRetryableError();
    }
    statusError(status);
  }

  async function uploadChunk(sessionUrl, chunk, key) {
    let nextOffset = chunk.start;
    let requestCount = 0;
    const empty = chunk.bytes.byteLength === 0;
    while (nextOffset <= chunk.end || empty) {
      requestCount += 1;
      if (requestCount > MAX_UPLOAD_CHUNK_REQUESTS) throw new ObjectTransferRetryableError();
      const relativeOffset = empty ? 0 : nextOffset - chunk.start;
      const bytes = chunk.bytes.subarray(relativeOffset);
      const headers = {
        "content-length": String(bytes.byteLength),
        "content-type": "application/octet-stream",
        ...(chunk.total === null
          ? { "content-range": `bytes ${nextOffset}-${chunk.end}/*` }
          : nextOffset > 0 || requestCount > 1
            ? { "content-range": `bytes ${nextOffset}-${chunk.end}/${chunk.total}` }
            : {}),
      };
      const request = await sessionRequest(sessionUrl, {
        method: "PUT",
        headers,
        body: bytes,
      });

      let next;
      if (request === null) {
        next = await queryUploadStatus(sessionUrl, chunk, key);
      } else {
        const { response, context } = request;
        if (response.status === 308) {
          const range = response.headers.get("range");
          responseDiscard(response, context);
          next = { generation: null, nextOffset: persistedOffset(range, chunk) };
        } else if (response.status === 200 || response.status === 201) {
          if (chunk.total === null) {
            responseDiscard(response, context);
            fail("OBJECT_TRANSFER_GCS_RESPONSE_INVALID");
          }
          try {
            const value = await readBoundedJson(response, context);
            return finalizedGeneration(value, key, chunk.total);
          } finally {
            closeContext(context);
          }
        } else {
          const status = response.status;
          responseDiscard(response, context);
          if (status === 412) throw new ObjectTransferTargetExistsError();
          if (status === 404 || status === 410 || status === 408 || status === 429 || status >= 500) {
            if (status === 404 || status === 410) throw new ObjectTransferRetryableError();
            next = await queryUploadStatus(sessionUrl, chunk, key);
          } else {
            statusError(status);
          }
        }
      }

      if (next.generation !== null) return next.generation;
      nextOffset = next.nextOffset;
      if (!empty && nextOffset === chunk.end + 1) {
        if (chunk.total !== null) throw new ObjectTransferRetryableError();
        return null;
      }
      if (empty && nextOffset === 0) continue;
    }
    return null;
  }

  return Object.freeze({
    async listPage({ prefix, cursor, limit }) {
      safeText(prefix, MAX_KEY_BYTES, "OBJECT_TRANSFER_PREFIX_INVALID");
      if (!prefix.endsWith("/")) fail("OBJECT_TRANSFER_PREFIX_INVALID");
      if (cursor !== null) safeText(cursor, MAX_TOKEN_BYTES, "OBJECT_TRANSFER_CURSOR_INVALID");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > OBJECT_TRANSFER_PROVIDER_PAGE_MAX) {
        fail("OBJECT_TRANSFER_PAGE_LIMIT_INVALID");
      }
      const url = fixedGcsUrl(`/storage/v1/b/${encodeURIComponent(bucket)}/o`, {
        prefix,
        maxResults: limit,
        pageToken: cursor,
        fields: "items(name,size,generation,contentType,metadata),nextPageToken",
      });
      const value = await jsonRequest(url);
      if (!isRecord(value)) fail("OBJECT_TRANSFER_GCS_LIST_INVALID");
      const items = value.items ?? [];
      if (!Array.isArray(items) || items.length > limit) fail("OBJECT_TRANSFER_GCS_LIST_INVALID");
      const objects = items.map(item => {
        if (!isRecord(item) || typeof item.name !== "string" || !item.name.startsWith(prefix)) {
          fail("OBJECT_TRANSFER_GCS_LIST_INVALID");
        }
        return objectFromGcs(item, item.name);
      });
      const nextCursor = value.nextPageToken === undefined ? null
        : safeText(value.nextPageToken, MAX_TOKEN_BYTES, "OBJECT_TRANSFER_CURSOR_INVALID");
      return { objects, nextCursor };
    },

    async head(key) {
      objectKey(key);
      const value = await jsonRequest(fixedGcsUrl(objectPath(bucket, key), {
        fields: "name,size,generation,contentType,metadata",
      }), {}, { allowNotFound: true });
      return value === null ? null : objectFromGcs(value, key);
    },

    async openRead({ key, ifGeneration }) {
      objectKey(key);
      const pinned = generation(ifGeneration);
      let token;
      try { token = await accessToken(); } catch { throw new ObjectTransferRetryableError(); }
      safeText(token, MAX_TOKEN_BYTES, "OBJECT_TRANSFER_GCS_AUTH_INVALID");
      const mediaPath = objectPath(bucket, key).replace("/storage/v1/", "/download/storage/v1/");
      const url = fixedGcsUrl(mediaPath, {
        alt: "media",
        generation: pinned,
        ifGenerationMatch: pinned,
      });
      const context = requestContext(timeoutMilliseconds);
      let response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: { authorization: `Bearer ${token}` },
          redirect: "error",
          signal: context.controller.signal,
        });
      } catch {
        closeContext(context, true);
        throw new ObjectTransferRetryableError();
      }
      if (!response.ok) {
        const status = response.status;
        responseDiscard(response, context);
        statusError(status);
      }
      return { generation: pinned, body: responseStream(response, context) };
    },

    async putIfAbsent({ key, metadata: rawMetadata, ifGenerationMatch, body }) {
      objectKey(key);
      if (ifGenerationMatch !== "0") fail("OBJECT_TRANSFER_CREATE_ONLY_REQUIRED");
      if (!body || typeof body[Symbol.asyncIterator] !== "function") fail("OBJECT_TRANSFER_STREAM_INVALID");
      const metadata = safeMetadata(rawMetadata);
      const query = {
        uploadType: "resumable",
        ifGenerationMatch: "0",
        name: key,
      };
      const initiated = await authorizedFetch(fixedGcsUrl(
        `/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`, query,
      ), {
        method: "POST",
        headers: { "content-type": "application/json; charset=UTF-8" },
        body: JSON.stringify({
          name: key,
          contentType: metadata.contentType,
          metadata: { ...metadata.customMetadata },
        }),
      });
      if (initiated.response.status === 412) {
        responseDiscard(initiated.response, initiated.context);
        throw new ObjectTransferTargetExistsError();
      }
      if (initiated.response.status !== 200 && initiated.response.status !== 201) {
        const status = initiated.response.status;
        responseDiscard(initiated.response, initiated.context);
        statusError(status);
      }
      const session = initiated.response.headers.get("location");
      responseDiscard(initiated.response, initiated.context);
      if (typeof session !== "string" || session.length === 0 || encoder.encode(session).byteLength > 8_192) {
        fail("OBJECT_TRANSFER_GCS_SESSION_INVALID");
      }
      let sessionUrl;
      try { sessionUrl = new URL(session); } catch { fail("OBJECT_TRANSFER_GCS_SESSION_INVALID"); }
      if (sessionUrl.protocol !== "https:" || sessionUrl.origin !== GCS_ORIGIN
          || sessionUrl.username !== "" || sessionUrl.password !== ""
          || !sessionUrl.pathname.startsWith("/upload/storage/v1/") || sessionUrl.hash !== "") {
        fail("OBJECT_TRANSFER_GCS_SESSION_INVALID");
      }

      let completed = false;
      try {
        for await (const chunk of gcsUploadChunks(body)) {
          const uploadedGeneration = await uploadChunk(sessionUrl, chunk, key);
          if (uploadedGeneration !== null) {
            completed = true;
            return uploadedGeneration;
          }
        }
        fail("OBJECT_TRANSFER_GCS_UPLOAD_INCOMPLETE");
      } catch (error) {
        if (!completed) await cancelSession(sessionUrl);
        if (error instanceof ObjectTransferProviderError
            || error instanceof ObjectTransferRetryableError
            || error instanceof ObjectTransferTargetExistsError) throw error;
        // The outer rehearsal retries retryable failures by reopening the
        // version-pinned source and starting a new session from byte zero.
        // The wrapped source may instead fail with a rehearsal error; preserve
        // only its type/code and never stringify provider or stream payloads.
        if (error instanceof Error && typeof error.code === "string") throw error;
        throw new ObjectTransferRetryableError();
      }
      fail("OBJECT_TRANSFER_GCS_UPLOAD_INCOMPLETE");
    },
  });
}
