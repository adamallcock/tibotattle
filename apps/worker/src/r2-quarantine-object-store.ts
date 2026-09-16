import {
  assertQuarantineObjectDeleteBatch,
  assertQuarantineObjectKey,
  QuarantineObjectStorageUnavailableError,
  type QuarantineObjectHead,
  type QuarantineObjectPutOptions,
  type QuarantineObjectStore,
} from "./quarantine-object-store";

type R2QuarantineBucket = Pick<R2Bucket, "put" | "head" | "delete">;

function assertR2QuarantineBucket(value: unknown): asserts value is R2QuarantineBucket {
  try {
    if (value === null
        || (typeof value !== "object" && typeof value !== "function")
        || typeof Reflect.get(value, "put") !== "function"
        || typeof Reflect.get(value, "head") !== "function"
        || typeof Reflect.get(value, "delete") !== "function") {
      throw new QuarantineObjectStorageUnavailableError();
    }
  } catch (error) {
    if (error instanceof QuarantineObjectStorageUnavailableError) throw error;
    throw new QuarantineObjectStorageUnavailableError();
  }
}

function r2PutOptions(
  options: QuarantineObjectPutOptions | undefined,
): R2PutOptions | undefined {
  if (options === undefined) return undefined;
  return {
    httpMetadata: options.contentType === undefined
      ? undefined
      : { contentType: options.contentType },
    customMetadata: options.customMetadata === undefined
      ? undefined
      : { ...options.customMetadata },
  };
}

/**
 * Cloudflare composition adapter for the neutral quarantine port.
 *
 * The adapter intentionally performs no retries.  Ingest and lifecycle code
 * use the D1 pending/object rows as their retry journal, and a provider error
 * must remain visible to those state machines.
 */
export function createR2QuarantineObjectStore(
  bucket: R2QuarantineBucket,
): QuarantineObjectStore {
  // Env bindings are structurally typed at compile time, but deployment and
  // test composition can still supply malformed runtime values. Validate all
  // operations once so readiness cannot pass with a head-only bucket.
  assertR2QuarantineBucket(bucket);
  return {
    async put(key, value, options): Promise<void> {
      assertQuarantineObjectKey(key);
      try {
        const object = await bucket.put(key, value, r2PutOptions(options));
        if (object === null) throw new QuarantineObjectStorageUnavailableError();
      } catch (error) {
        if (error instanceof QuarantineObjectStorageUnavailableError) throw error;
        throw new QuarantineObjectStorageUnavailableError();
      }
    },

    async head(key): Promise<QuarantineObjectHead | null> {
      assertQuarantineObjectKey(key);
      try {
        const object = await bucket.head(key);
        if (object === null) return null;
        return { version: object.etag, size: object.size };
      } catch {
        throw new QuarantineObjectStorageUnavailableError();
      }
    },

    async delete(key): Promise<void> {
      assertQuarantineObjectKey(key);
      try {
        await bucket.delete(key);
      } catch {
        throw new QuarantineObjectStorageUnavailableError();
      }
    },

    async deleteMany(keys): Promise<void> {
      assertQuarantineObjectDeleteBatch(keys);
      if (keys.length === 0) return;
      // Keep this as one provider call.  A provider error is allowed to
      // reject the batch so the D1 caller does not mark partial cleanup as
      // complete; no implicit retry or chunking is safe here.
      try {
        await bucket.delete([...keys]);
      } catch {
        throw new QuarantineObjectStorageUnavailableError();
      }
    },
  };
}
