export const LOCAL_R2_SOURCE_PREFIX = "/__local_r2_source/v1";
export const LOCAL_R2_SOURCE_MAX_PAGE_SIZE = 500;
export const LOCAL_R2_SOURCE_MAX_KEY_BYTES = 1_024;
export const LOCAL_R2_SOURCE_MAX_CURSOR_BYTES = 4_096;
export const LOCAL_R2_SOURCE_MAX_VERSION_BYTES = 4_096;
export const LOCAL_R2_SOURCE_MAX_METADATA_BYTES = 8 * 1_024;
export const LOCAL_R2_SOURCE_MAX_REQUEST_BYTES = 8 * 1_024;
export const LOCAL_R2_SOURCE_MAX_PAGE_BYTES = 8 * 1_024 * 1_024;
export const LOCAL_R2_SOURCE_MAX_OBJECT_BYTES = 1_073_741_824;
export const LOCAL_R2_SOURCE_MAX_STREAM_CHUNK_BYTES = 256 * 1_024;

const encoder = new TextEncoder();

export class LocalR2SourceProtocolError extends Error {
  constructor(code) {
    super(code);
    this.name = "LocalR2SourceProtocolError";
    this.code = code;
  }
}

export function protocolFail(code) {
  throw new LocalR2SourceProtocolError(code);
}

export function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeText(value, maxBytes, code, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)
      || encoder.encode(value).byteLength > maxBytes
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    protocolFail(code);
  }
  return value;
}

export function validateBucketName(value) {
  safeText(value, 222, "LOCAL_R2_BUCKET_INVALID");
  if (value.length < 3 || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(value)) {
    protocolFail("LOCAL_R2_BUCKET_INVALID");
  }
  return value;
}

export function validateKey(value) {
  return safeText(value, LOCAL_R2_SOURCE_MAX_KEY_BYTES, "OBJECT_TRANSFER_KEY_INVALID");
}

export function validatePrefix(value) {
  safeText(value, LOCAL_R2_SOURCE_MAX_KEY_BYTES, "OBJECT_TRANSFER_PREFIX_INVALID");
  if (!value.endsWith("/")) protocolFail("OBJECT_TRANSFER_PREFIX_INVALID");
  return value;
}

export function validateCursor(value) {
  if (value !== null) {
    safeText(value, LOCAL_R2_SOURCE_MAX_CURSOR_BYTES, "OBJECT_TRANSFER_CURSOR_INVALID");
  }
  return value;
}

export function validatePageSize(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > LOCAL_R2_SOURCE_MAX_PAGE_SIZE) {
    protocolFail("OBJECT_TRANSFER_PAGE_SIZE_INVALID");
  }
  return value;
}

export function validateListRequest(value) {
  if (!isPlainRecord(value)
      || Object.keys(value).some(key => !["prefix", "cursor", "limit"].includes(key))
      || Object.keys(value).length !== 3) {
    protocolFail("LOCAL_R2_REQUEST_INVALID");
  }
  return Object.freeze({
    prefix: validatePrefix(value.prefix),
    cursor: validateCursor(value.cursor),
    limit: validatePageSize(value.limit),
  });
}

export function validateReadRequest(value) {
  if (!isPlainRecord(value)
      || Object.keys(value).some(key => !["key", "ifVersion"].includes(key))
      || Object.keys(value).length !== 2) {
    protocolFail("LOCAL_R2_REQUEST_INVALID");
  }
  return Object.freeze({
    key: validateKey(value.key),
    ifVersion: safeText(value.ifVersion, LOCAL_R2_SOURCE_MAX_VERSION_BYTES,
      "OBJECT_TRANSFER_SOURCE_VERSION_INVALID"),
  });
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function base64UrlDecode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    protocolFail("OBJECT_TRANSFER_SOURCE_VERSION_INVALID");
  }
  const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/");
  try {
    const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    protocolFail("OBJECT_TRANSFER_SOURCE_VERSION_INVALID");
  }
}

export function createVersionToken(version, etag) {
  safeText(version, 512, "OBJECT_TRANSFER_SOURCE_VERSION_INVALID");
  safeText(etag, 512, "OBJECT_TRANSFER_SOURCE_VERSION_INVALID");
  const token = `r2v1.${base64UrlEncode(encoder.encode(JSON.stringify([version, etag])))}`;
  return safeText(token, LOCAL_R2_SOURCE_MAX_VERSION_BYTES, "OBJECT_TRANSFER_SOURCE_VERSION_INVALID");
}

export function parseVersionToken(value) {
  safeText(value, LOCAL_R2_SOURCE_MAX_VERSION_BYTES, "OBJECT_TRANSFER_SOURCE_VERSION_INVALID");
  if (!value.startsWith("r2v1.")) protocolFail("OBJECT_TRANSFER_SOURCE_VERSION_INVALID");
  const encoded = value.slice(5);
  const bytes = base64UrlDecode(encoded);
  let decoded;
  try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch {
    protocolFail("OBJECT_TRANSFER_SOURCE_VERSION_INVALID");
  }
  if (!Array.isArray(decoded) || decoded.length !== 2
      || createVersionToken(decoded[0], decoded[1]).slice(5) !== encoded) {
    protocolFail("OBJECT_TRANSFER_SOURCE_VERSION_INVALID");
  }
  return Object.freeze({
    version: safeText(decoded[0], 512, "OBJECT_TRANSFER_SOURCE_VERSION_INVALID"),
    etag: safeText(decoded[1], 512, "OBJECT_TRANSFER_SOURCE_VERSION_INVALID"),
  });
}

export function normalizeR2Metadata(value) {
  if (!isPlainRecord(value)) protocolFail("OBJECT_TRANSFER_METADATA_INVALID");
  const httpMetadata = value.httpMetadata ?? {};
  if (!isPlainRecord(httpMetadata)
      || Object.keys(httpMetadata).some(name => name !== "contentType"
        && httpMetadata[name] !== undefined && httpMetadata[name] !== null)) {
    protocolFail("OBJECT_TRANSFER_METADATA_UNSUPPORTED");
  }
  if (value.storageClass !== undefined && value.storageClass !== "Standard") {
    protocolFail("OBJECT_TRANSFER_STORAGE_CLASS_UNSUPPORTED");
  }
  if (value.ssecKeyMd5 !== undefined) protocolFail("OBJECT_TRANSFER_SOURCE_ENCRYPTION_UNSUPPORTED");
  const contentType = httpMetadata.contentType ?? "application/octet-stream";
  safeText(contentType, 1_024, "OBJECT_TRANSFER_METADATA_INVALID");
  const custom = value.customMetadata ?? {};
  if (!isPlainRecord(custom)) protocolFail("OBJECT_TRANSFER_METADATA_INVALID");
  const customMetadata = Object.create(null);
  let bytes = 0;
  for (const key of Object.keys(custom).sort()) {
    const item = custom[key];
    safeText(key, 1_024, "OBJECT_TRANSFER_METADATA_INVALID");
    safeText(item, 1_024, "OBJECT_TRANSFER_METADATA_INVALID");
    customMetadata[key] = item;
    bytes += encoder.encode(key).byteLength + encoder.encode(item).byteLength;
  }
  if (bytes > LOCAL_R2_SOURCE_MAX_METADATA_BYTES) protocolFail("OBJECT_TRANSFER_METADATA_LIMIT");
  return Object.freeze({ contentType, customMetadata: Object.freeze(customMetadata) });
}

export function normalizeR2Object(value, prefix) {
  if (!isPlainRecord(value)) protocolFail("OBJECT_TRANSFER_INVENTORY_INVALID");
  const key = validateKey(value.key);
  if (!key.startsWith(prefix)) protocolFail("OBJECT_TRANSFER_KEY_INVALID");
  if (!Number.isSafeInteger(value.size) || value.size < 0) protocolFail("OBJECT_TRANSFER_SIZE_INVALID");
  if (value.size > LOCAL_R2_SOURCE_MAX_OBJECT_BYTES) protocolFail("OBJECT_TRANSFER_STREAM_LIMIT");
  return Object.freeze({
    key,
    size: value.size,
    metadata: normalizeR2Metadata(value),
    version: createVersionToken(value.version, value.etag),
  });
}

export function validateListPage(value, { prefix, limit }) {
  if (!isPlainRecord(value)
      || Object.keys(value).some(key => !["objects", "nextCursor"].includes(key))
      || Object.keys(value).length !== 2 || !Array.isArray(value.objects)
      || value.objects.length > limit) {
    protocolFail("OBJECT_TRANSFER_INVENTORY_INVALID");
  }
  const objects = value.objects.map(entry => {
    if (!isPlainRecord(entry)
        || Object.keys(entry).some(key => !["key", "size", "metadata", "version"].includes(key))
        || Object.keys(entry).length !== 4) {
      protocolFail("OBJECT_TRANSFER_INVENTORY_INVALID");
    }
    const key = validateKey(entry.key);
    if (!key.startsWith(prefix)) protocolFail("OBJECT_TRANSFER_KEY_INVALID");
    if (!Number.isSafeInteger(entry.size) || entry.size < 0
        || entry.size > LOCAL_R2_SOURCE_MAX_OBJECT_BYTES) {
      protocolFail("OBJECT_TRANSFER_SIZE_INVALID");
    }
    const metadata = entry.metadata;
    if (!isPlainRecord(metadata)
        || Object.keys(metadata).some(name => name !== "contentType" && name !== "customMetadata")
        || Object.keys(metadata).length !== 2) {
      protocolFail("OBJECT_TRANSFER_METADATA_INVALID");
    }
    const normalizedMetadata = normalizeR2Metadata({
      httpMetadata: { contentType: metadata.contentType },
      customMetadata: metadata.customMetadata,
    });
    const version = safeText(entry.version, LOCAL_R2_SOURCE_MAX_VERSION_BYTES,
      "OBJECT_TRANSFER_SOURCE_VERSION_INVALID");
    parseVersionToken(version);
    return Object.freeze({ key, size: entry.size, metadata: normalizedMetadata, version });
  });
  return Object.freeze({ objects: Object.freeze(objects), nextCursor: validateCursor(value.nextCursor) });
}

export function responseError(status, code) {
  const body = JSON.stringify({ code });
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
