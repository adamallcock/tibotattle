/**
 * The object store used for contribution quarantine.
 *
 * This is deliberately smaller than a provider bucket API.  The D1 journals
 * are the source of truth for the object keys, so quarantine does not need a
 * list operation.  A provider adapter must preserve the failure semantics of
 * these operations: a rejected write or delete leaves the caller's journal or
 * row eligible for a later, idempotent retry.
 */
export interface QuarantineObjectPutOptions {
  /** MIME type attached to the stored object, when one is known. */
  contentType?: string;
  /** Content-free object metadata used by operational inspection. */
  customMetadata?: Readonly<Record<string, string>>;
}

/**
 * Metadata observed by a head operation.
 *
 * These values are intentionally opaque to lifecycle code.  `version` is the
 * provider's object version/etag and is not used as a deletion precondition;
 * alternative providers must establish their own version-history/erasure
 * guarantees before claiming an owner deletion has completed. `null` is valid
 * only when the provider can establish that no retained object/version remains
 * for the key; a live-object 404 that hides soft-deleted or historical
 * versions is not sufficient.
 */
export interface QuarantineObjectHead {
  version: string;
  size: number;
}

/**
 * Provider failures are deliberately content-free at the adapter boundary.
 * Callers can classify the failure without exposing bucket names, keys, or
 * provider diagnostics in a response or audit record.
 */
export class QuarantineObjectStorageUnavailableError extends Error {
  constructor() {
    super("QUARANTINE_OBJECT_STORAGE_UNAVAILABLE");
    this.name = "QuarantineObjectStorageUnavailableError";
  }
}

export interface QuarantineObjectStore {
  put(
    key: string,
    value: string | Uint8Array,
    options?: QuarantineObjectPutOptions,
  ): Promise<void>;
  head(key: string): Promise<QuarantineObjectHead | null>;
  /**
   * A successful single delete carries the same retained-data guarantee as a
   * batch delete; deleting only the current live version is insufficient.
   */
  delete(key: string): Promise<void>;
  /**
   * Delete one bounded batch.  Callers retain their durable D1 state until
   * this resolves; a rejection therefore leaves the batch retryable.
   *
   * A successful delete must satisfy the product's retained-data erasure
   * guarantee for this bucket, including provider version/history behavior;
   * removing only the current live version is insufficient.
   */
  deleteMany(keys: readonly string[]): Promise<void>;
}

/**
 * Existing lifecycle callers deliberately stay below this bound.  Keeping it
 * in the domain contract prevents a future adapter from silently turning one
 * bounded maintenance phase into an unbounded provider request.
 */
export const QUARANTINE_OBJECT_DELETE_BATCH_LIMIT = 202;

export function assertQuarantineObjectKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("invalid quarantine object key");
  }
}

export function assertQuarantineObjectDeleteBatch(
  keys: readonly string[],
): void {
  if (!Array.isArray(keys)
      || keys.length > QUARANTINE_OBJECT_DELETE_BATCH_LIMIT) {
    throw new TypeError("invalid quarantine object delete batch");
  }
  for (const key of keys) assertQuarantineObjectKey(key);
}
