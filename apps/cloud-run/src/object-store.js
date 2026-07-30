import { createHash, randomBytes } from "node:crypto";
import { GoogleAuth } from "google-auth-library";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_PREFIX = /^[a-z0-9][a-z0-9/_-]{0,127}$/u;
const MAX_OBJECT_BYTES = 2 * 1024 * 1024;
const MAX_LIST_ITEMS = 100;
const OPERATION_TIMEOUT_MILLISECONDS = 15_000;
const READINESS_TIMEOUT_MILLISECONDS = 750;

export class ObjectStoreError extends Error {
  constructor(code, { retryable = false } = {}) {
    super("Object storage operation failed");
    this.name = "ObjectStoreError";
    this.code = code;
    this.retryable = retryable;
  }
}

function fail(code, options) {
  throw new ObjectStoreError(code, options);
}

function boundedBytes(value) {
  if (!(value instanceof Uint8Array)
      || value.byteLength < 1
      || value.byteLength > MAX_OBJECT_BYTES) {
    fail("object_invalid");
  }
  return Buffer.from(value);
}

function digestOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validDigest(value) {
  return typeof value === "string" && SHA256.test(value);
}

function normalizePrefix(value) {
  if (typeof value !== "string"
      || !SAFE_PREFIX.test(value)
      || value.startsWith("/")
      || value.endsWith("/")
      || value.includes("//")
      || value.includes("..")) {
    fail("configuration_invalid");
  }
  return value;
}

export function objectKeyForDigest(prefix, digest) {
  const safePrefix = normalizePrefix(prefix);
  if (!validDigest(digest)) fail("object_invalid");
  return `${safePrefix}/${digest.slice(0, 2)}/${digest}.json`;
}

function projectedMetadata(key, metadata) {
  const generation = String(metadata?.generation ?? "");
  const size = Number(metadata?.size);
  const digest = metadata?.metadata?.payloadSha256;
  if (!/^[1-9][0-9]*$/u.test(generation)
      || !Number.isSafeInteger(size)
      || size < 1
      || size > MAX_OBJECT_BYTES
      || !validDigest(digest)) {
    fail("metadata_invalid");
  }
  return Object.freeze({ key, generation, size, digest });
}

function statusCode(error) {
  return Number(
    error?.status
      ?? error?.code
      ?? error?.response?.status
      ?? error?.response?.statusCode,
  );
}

export function createGcsObjectStore({
  bucketName,
  prefix = "quarantine/v1",
  readinessObject = "operations/readiness-v1",
  request = null,
} = {}) {
  if (typeof bucketName !== "string"
      || bucketName.length < 3
      || bucketName.length > 222
      || typeof readinessObject !== "string"
      || readinessObject.length < 1
      || readinessObject.length > 256
      || readinessObject.startsWith("/")
      || readinessObject.includes("..")) {
    fail("configuration_invalid");
  }
  const safePrefix = normalizePrefix(prefix);
  const bucketPath = encodeURIComponent(bucketName);
  const auth = request === null
    ? new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/devstorage.read_write"],
    })
    : null;
  const authorizedRequest = request ?? (async (options) => {
    const client = await auth.getClient();
    return client.request(options);
  });
  async function boundedRequest(
    options,
    timeoutMilliseconds = OPERATION_TIMEOUT_MILLISECONDS,
  ) {
    const controller = new AbortController();
    let timeout;
    const deadline = new Promise((resolveDeadline, rejectDeadline) => {
      timeout = setTimeout(() => {
        controller.abort();
        const error = new Error("Object storage request timed out");
        error.status = 504;
        rejectDeadline(error);
      }, timeoutMilliseconds);
      timeout.unref?.();
    });
    try {
      return await Promise.race([
        authorizedRequest({
          ...options,
          signal: controller.signal,
          timeout: timeoutMilliseconds,
        }),
        deadline,
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
  const metadataUrl = (key) =>
    `https://storage.googleapis.com/storage/v1/b/${bucketPath}/o/${encodeURIComponent(key)}`;

  async function readMetadata(
    key,
    timeoutMilliseconds = OPERATION_TIMEOUT_MILLISECONDS,
  ) {
    const response = await boundedRequest({
      url: metadataUrl(key),
      method: "GET",
      responseType: "json",
    }, timeoutMilliseconds);
    return response.data;
  }

  return Object.freeze({
    provider: "google_cloud_storage",

    async putIfAbsent({ body, digest }) {
      const bytes = boundedBytes(body);
      if (!validDigest(digest) || digestOf(bytes) !== digest) {
        fail("object_invalid");
      }
      const key = objectKeyForDigest(safePrefix, digest);
      let metadata;
      for (let attempt = 0; attempt < 2 && metadata === undefined; attempt += 1) {
        try {
          const boundary =
            `usage-monitor-${randomBytes(16).toString("hex")}`;
          const objectMetadata = JSON.stringify({
            name: key,
            contentType: "application/json",
            cacheControl: "no-store",
            metadata: {
              payloadSha256: digest,
              contract: "encrypted-quarantine-v1",
            },
          });
          const multipart = Buffer.concat([
            Buffer.from(
              `--${boundary}\r\n`
              + "Content-Type: application/json; charset=UTF-8\r\n\r\n"
              + `${objectMetadata}\r\n`
              + `--${boundary}\r\n`
              + "Content-Type: application/json\r\n\r\n",
            ),
            bytes,
            Buffer.from(`\r\n--${boundary}--\r\n`),
          ]);
          const response = await boundedRequest({
            url: `https://storage.googleapis.com/upload/storage/v1/b/${bucketPath}/o`,
            method: "POST",
            params: {
              uploadType: "multipart",
              ifGenerationMatch: 0,
            },
            headers: {
              "Content-Type": `multipart/related; boundary=${boundary}`,
            },
            data: multipart,
            responseType: "json",
          });
          metadata = response.data;
        } catch (error) {
          if (statusCode(error) !== 412) {
            fail("put_failed", { retryable: statusCode(error) >= 500 });
          }
          try {
            metadata = await readMetadata(key);
          } catch (metadataError) {
            if (statusCode(metadataError) === 404 && attempt === 0) {
              continue;
            }
            fail("metadata_failed", {
              retryable: statusCode(metadataError) === 404
                || statusCode(metadataError) >= 500,
            });
          }
        }
      }
      const projected = projectedMetadata(key, metadata);
      if (projected.digest !== digest || projected.size !== bytes.byteLength) {
        fail("object_conflict");
      }
      return projected;
    },

    async metadata(key) {
      if (typeof key !== "string"
          || !key.startsWith(`${safePrefix}/`)
          || key.length > 256) {
        fail("object_invalid");
      }
      try {
        return projectedMetadata(key, await readMetadata(key));
      } catch (error) {
        if (statusCode(error) === 404) return null;
        fail("metadata_failed", { retryable: statusCode(error) >= 500 });
      }
    },

    async delete({ key, generation }) {
      if (typeof key !== "string"
          || !key.startsWith(`${safePrefix}/`)
          || !/^[1-9][0-9]*$/u.test(String(generation))) {
        fail("object_invalid");
      }
      try {
        await boundedRequest({
          url: metadataUrl(key),
          method: "DELETE",
          params: { ifGenerationMatch: generation },
        });
        return true;
      } catch (error) {
        if (statusCode(error) === 404) return true;
        if (statusCode(error) === 412) return false;
        fail("delete_failed", { retryable: statusCode(error) >= 500 });
      }
    },

    async list({ cursor = null, limit = MAX_LIST_ITEMS } = {}) {
      if (cursor !== null && (typeof cursor !== "string" || cursor.length > 2_048)) {
        fail("object_invalid");
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_ITEMS) {
        fail("object_invalid");
      }
      try {
        const response = await boundedRequest({
          url: `https://storage.googleapis.com/storage/v1/b/${bucketPath}/o`,
          method: "GET",
          params: {
            prefix: `${safePrefix}/`,
            maxResults: limit,
            ...(cursor === null ? {} : { pageToken: cursor }),
          },
          responseType: "json",
        });
        const files = Array.isArray(response.data?.items)
          ? response.data.items
          : [];
        return Object.freeze({
          items: Object.freeze(
            files.map((file) => file?.name).filter((key) =>
              typeof key === "string"
              && key.startsWith(`${safePrefix}/`)
              && key.length <= 256
            ).slice(0, limit),
          ),
          cursor: typeof response.data?.nextPageToken === "string"
            && response.data.nextPageToken.length <= 2_048
            ? response.data.nextPageToken
            : null,
        });
      } catch (error) {
        fail("list_failed", { retryable: statusCode(error) >= 500 });
      }
    },

    async probe() {
      try {
        await readMetadata(readinessObject, READINESS_TIMEOUT_MILLISECONDS);
        return true;
      } catch (error) {
        if (statusCode(error) === 404) return false;
        return false;
      }
    },
  });
}

export function createMemoryObjectStore({
  readiness = true,
  prefix = "quarantine/v1",
} = {}) {
  const safePrefix = normalizePrefix(prefix);
  const objects = new Map();
  let generation = 0;
  return Object.freeze({
    provider: "memory_test_only",
    async putIfAbsent({ body, digest }) {
      const bytes = boundedBytes(body);
      if (!validDigest(digest) || digestOf(bytes) !== digest) fail("object_invalid");
      const key = objectKeyForDigest(safePrefix, digest);
      if (!objects.has(key)) {
        generation += 1;
        objects.set(key, {
          body: Buffer.from(bytes),
          generation: String(generation),
          digest,
        });
      }
      const object = objects.get(key);
      if (object.digest !== digest
          || !object.body.equals(bytes)) {
        fail("object_conflict");
      }
      return Object.freeze({
        key,
        generation: object.generation,
        size: object.body.byteLength,
        digest,
      });
    },
    async metadata(key) {
      const object = objects.get(key);
      return object
        ? Object.freeze({
          key,
          generation: object.generation,
          size: object.body.byteLength,
          digest: object.digest,
        })
        : null;
    },
    async delete({ key, generation: selectedGeneration }) {
      const object = objects.get(key);
      if (!object) return true;
      if (object.generation !== String(selectedGeneration)) return false;
      objects.delete(key);
      return true;
    },
    async list({ cursor = null, limit = MAX_LIST_ITEMS } = {}) {
      if (cursor !== null || !Number.isSafeInteger(limit)
          || limit < 1 || limit > MAX_LIST_ITEMS) fail("object_invalid");
      return Object.freeze({
        items: Object.freeze([...objects.keys()].sort().slice(0, limit)),
        cursor: null,
      });
    },
    async probe() {
      return readiness === true;
    },
  });
}

export const OBJECT_STORE_LIMITS = Object.freeze({
  maximumObjectBytes: MAX_OBJECT_BYTES,
  maximumListItems: MAX_LIST_ITEMS,
  operationTimeoutMilliseconds: OPERATION_TIMEOUT_MILLISECONDS,
  readinessTimeoutMilliseconds: READINESS_TIMEOUT_MILLISECONDS,
});
