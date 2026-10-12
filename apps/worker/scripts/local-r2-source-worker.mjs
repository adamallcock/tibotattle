import {
  LOCAL_R2_SOURCE_MAX_PAGE_BYTES,
  LOCAL_R2_SOURCE_MAX_OBJECT_BYTES,
  LOCAL_R2_SOURCE_MAX_REQUEST_BYTES,
  LOCAL_R2_SOURCE_PREFIX,
  LocalR2SourceProtocolError,
  isPlainRecord,
  normalizeR2Object,
  parseVersionToken,
  protocolFail,
  responseError,
  validateListRequest,
  validateReadRequest,
} from "./local-r2-source-protocol.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const AUTH_HEADER_PREFIX = "Bearer ";

function constantTimeTokenMatch(header, token) {
  if (typeof token !== "string" || token.length < 32 || token.length > 128
      || typeof header !== "string" || header.length !== AUTH_HEADER_PREFIX.length + token.length
      || !header.startsWith(AUTH_HEADER_PREFIX)) {
    return false;
  }
  const expected = encoder.encode(token);
  const provided = encoder.encode(header.slice(AUTH_HEADER_PREFIX.length));
  if (expected.length !== provided.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected[index] ^ provided[index];
  return difference === 0;
}

async function requestJson(request) {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    protocolFail("LOCAL_R2_REQUEST_INVALID");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)
      || Number(declaredLength) > LOCAL_R2_SOURCE_MAX_REQUEST_BYTES)) {
    protocolFail("LOCAL_R2_REQUEST_LIMIT");
  }
  if (!request.body) protocolFail("LOCAL_R2_REQUEST_INVALID");
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  let completed = false;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        completed = true;
        break;
      }
      if (!(result.value instanceof Uint8Array)) protocolFail("LOCAL_R2_REQUEST_INVALID");
      total += result.value.byteLength;
      if (!Number.isSafeInteger(total) || total > LOCAL_R2_SOURCE_MAX_REQUEST_BYTES) {
        protocolFail("LOCAL_R2_REQUEST_LIMIT");
      }
      chunks.push(result.value);
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* Ignore an already released stream. */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value;
  try { value = JSON.parse(decoder.decode(bytes)); } catch {
    protocolFail("LOCAL_R2_REQUEST_INVALID");
  }
  if (!isPlainRecord(value)) protocolFail("LOCAL_R2_REQUEST_INVALID");
  return value;
}

function loopbackRequest(request) {
  const url = new URL(request.url);
  return url.hostname === "127.0.0.1" && url.username === "" && url.password === "";
}

function jsonResponse(value) {
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.byteLength > LOCAL_R2_SOURCE_MAX_PAGE_BYTES) {
    return responseError(413, "LOCAL_R2_PAGE_LIMIT");
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

async function listPage(bucket, input) {
  const { prefix, cursor, limit } = validateListRequest(input);
  let page;
  try {
    page = await bucket.list({
      prefix,
      ...(cursor === null ? {} : { cursor }),
      limit,
      include: ["httpMetadata", "customMetadata"],
    });
  } catch {
    return responseError(503, "LOCAL_R2_SOURCE_UNAVAILABLE");
  }
  if (!isPlainRecord(page) || !Array.isArray(page.objects) || page.objects.length > limit
      || typeof page.truncated !== "boolean"
      || (page.truncated && typeof page.cursor !== "string")) {
    return responseError(502, "LOCAL_R2_SOURCE_RESPONSE_INVALID");
  }
  try {
    const objects = page.objects.map(object => normalizeR2Object(object, prefix));
    const nextCursor = page.truncated ? page.cursor : null;
    if (nextCursor !== null && (typeof nextCursor !== "string" || nextCursor.length === 0)) {
      protocolFail("OBJECT_TRANSFER_CURSOR_INVALID");
    }
    return jsonResponse({ objects, nextCursor });
  } catch (error) {
    if (error instanceof LocalR2SourceProtocolError) {
      return responseError(502, "LOCAL_R2_SOURCE_RESPONSE_INVALID");
    }
    return responseError(502, "LOCAL_R2_SOURCE_RESPONSE_INVALID");
  }
}

async function openRead(bucket, input) {
  const { key, ifVersion } = validateReadRequest(input);
  const pinned = parseVersionToken(ifVersion);
  let object;
  try {
    object = await bucket.get(key, { onlyIf: { etagMatches: pinned.etag } });
  } catch {
    return responseError(503, "LOCAL_R2_SOURCE_UNAVAILABLE");
  }
  if (!object || object.key !== key || object.etag !== pinned.etag
      || object.version !== pinned.version || !object.body) {
    return responseError(409, "LOCAL_R2_SOURCE_CHANGED");
  }
  if (!Number.isSafeInteger(object.size) || object.size < 0) {
    return responseError(502, "LOCAL_R2_SOURCE_RESPONSE_INVALID");
  }
  if (object.size > LOCAL_R2_SOURCE_MAX_OBJECT_BYTES) return responseError(413, "LOCAL_R2_OBJECT_LIMIT");
  let version;
  try { version = normalizeR2Object(object, key.slice(0, key.lastIndexOf("/") + 1)).version; } catch {
    return responseError(502, "LOCAL_R2_SOURCE_RESPONSE_INVALID");
  }
  if (version !== ifVersion) return responseError(409, "LOCAL_R2_SOURCE_CHANGED");
  return new Response(object.body, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-length": String(object.size),
      "content-type": "application/octet-stream",
      "x-content-type-options": "nosniff",
      "x-local-r2-source-version": version,
    },
  });
}

function requestFailure(error) {
  if (error instanceof LocalR2SourceProtocolError && error.code === "LOCAL_R2_REQUEST_LIMIT") {
    return responseError(413, "LOCAL_R2_REQUEST_LIMIT");
  }
  return responseError(400, "LOCAL_R2_REQUEST_INVALID");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!loopbackRequest(request) || !constantTimeTokenMatch(
      request.headers.get("authorization"), env?.LOCAL_R2_SOURCE_TOKEN,
    )) {
      return responseError(404, "NOT_FOUND");
    }
    if (url.pathname === `${LOCAL_R2_SOURCE_PREFIX}/health` && request.method === "GET") {
      return new Response(null, {
        status: 204,
        headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
      });
    }
    if (url.pathname === `${LOCAL_R2_SOURCE_PREFIX}/list` && request.method === "POST") {
      if (!env?.TRANSFER_SOURCE_BUCKET
          || typeof env.TRANSFER_SOURCE_BUCKET.list !== "function") {
        return responseError(503, "LOCAL_R2_SOURCE_UNAVAILABLE");
      }
      try { return await listPage(env.TRANSFER_SOURCE_BUCKET, await requestJson(request)); } catch (error) {
        return requestFailure(error);
      }
    }
    if (url.pathname === `${LOCAL_R2_SOURCE_PREFIX}/read` && request.method === "POST") {
      if (!env?.TRANSFER_SOURCE_BUCKET
          || typeof env.TRANSFER_SOURCE_BUCKET.get !== "function") {
        return responseError(503, "LOCAL_R2_SOURCE_UNAVAILABLE");
      }
      try { return await openRead(env.TRANSFER_SOURCE_BUCKET, await requestJson(request)); } catch (error) {
        return requestFailure(error);
      }
    }
    return responseError(404, "NOT_FOUND");
  },
};
